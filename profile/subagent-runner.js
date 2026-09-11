/**
 * dsh-subagent 的 runner:跑完一轮任务后,把结果交给外部调用方。
 *
 * 源自 `@deepseek-ai/dsh-headless` 的一次性驱动逻辑(同版本同 API),额外加:
 *   - `--provider / --model / --reasoning-effort`:单次调用就能换模型,不必改 DSH 设置;
 *   - `--result-file`:把最终答复写到文件,调用方无需解析 stdout;
 *   - `--metadata-file`:把 sessionId、模型、停止原因、耗时等写成 JSON;
 *   - stderr 末尾追加一行 `dsh-subagent-meta: {…}`,便于人肉排查。
 *
 * stdout 仍然只输出最终答复文本(供直接命令行使用),推理过程仍然走 stderr。
 *
 * @module dsh-subagent/profile/subagent-runner
 */
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import process from 'node:process';
import z from '@deepseek-ai/schemastery';
import { installModelSelection } from '@deepseek-ai/dsh-agent';
import { assertNever, createUserMessage } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';

/** 稳定的 Cordis 插件名。 */
export const name = 'subagent-runner';

/** 一轮任务开始前必须就绪的核心服务。 */
export const inject = ['agentDefaultModel', 'agents', 'sessions'];

/** 本 row 的配置(全部来自 subagent-startup 解析出的命令行值)。 */
export const Config = z.object({
	task: z.string().required(),
	resultFile: z.string(),
	metadataFile: z.string(),
	provider: z.string(),
	model: z.string(),
	reasoningEffort: z.string(),
});

/** runner 写入的进程流;测试可替换。 */
export const internals = {
	stdout: process.stdout,
	stderr: process.stderr,
};

/**
 * 汇总最后一条助手文本与本轮结束原因。
 * @param events - 该 Session 的持久事件流。
 * @param firstSeq - 本轮开始前的 seq 水位。
 * @returns 最终答复文本与 turn/end 原因。
 */
function summarize(events, firstSeq) {
	let started = false;
	let text = '';
	let reason;
	for (const event of events) {
		if (event.seq < firstSeq) continue;
		if (event.type === 'turn/start') {
			started = true;
			continue;
		}
		if (!started) continue;
		if (event.type === 'assistant/message') {
			const joined = event.data.message.content
				.filter((block) => block.type === 'text')
				.map((block) => block.text)
				.join('');
			if (joined !== '') text = joined;
		}
		if (event.type === 'turn/end') reason = event.data.reason;
	}
	return { text, reason };
}

/**
 * 把 provider 上报的推理增量实时打到 stderr(与 headless 行为一致)。
 * @param ctx - 携带 Session 事件流的插件上下文。
 * @param agent - 本次调用唯一对应的 Agent。
 * @param stderr - 进度输出目标。
 * @returns 解除订阅并收尾未结束行的 disposer。
 */
function streamReasoning(ctx, agent, stderr) {
	let started = false;
	let open = false;
	let endsWithNewline = true;
	const close = () => {
		if (!open) return;
		if (!endsWithNewline) stderr.write('\n');
		open = false;
		endsWithNewline = true;
	};
	const dispose = ctx.on('session/event', (session, event) => {
		if (session !== agent.session) return;
		if (event.type === 'turn/start') {
			close();
			started = true;
			return;
		}
		if (!started || event.type !== 'assistant/chunk') return;
		const chunk = event.data.chunk;
		switch (chunk.type) {
			case 'reasoning-delta':
				if (chunk.text === '') return;
				if (!open) {
					stderr.write('dsh: reasoning:\n');
					open = true;
				}
				stderr.write(chunk.text);
				endsWithNewline = chunk.text.endsWith('\n');
				return;
			case 'block-start':
				if (chunk.blockType !== 'reasoning') close();
				return;
			case 'block-end':
				if (chunk.block.type !== 'reasoning') close();
				return;
			case 'usage':
				return;
			case 'text-delta':
			case 'tool-call-delta':
			case 'finish':
				close();
				return;
			default:
				return assertNever(chunk, 'subagent reasoning stream');
		}
	});
	return () => {
		dispose();
		close();
	};
}

/**
 * 把内容写进文件,失败只告警不打断本轮。
 * @param path - 目标文件;为空表示不写。
 * @param content - 写入内容(UTF-8)。
 * @param stderr - 告警输出。
 */
function writeSafely(path, content, stderr) {
	if (typeof path !== 'string' || path === '') return;
	try {
		writeFileSync(path, content, 'utf8');
	} catch (error) {
		stderr.write(`dsh: 无法写入 ${path}: ${error instanceof Error ? error.message : String(error)}\n`);
	}
}

/** 把停止原因压成可 JSON 序列化的形状。 */
function describeReason(reason) {
	if (reason === undefined || reason === null) return null;
	if (typeof reason !== 'object') return { kind: String(reason) };
	const { kind, error } = reason;
	return {
		kind: kind === undefined ? null : String(kind),
		...(error === undefined ? {} : {
			error: {
				code: error?.code === undefined ? null : String(error.code),
				message: error?.message === undefined ? String(error) : String(error.message),
			},
		}),
	};
}

/** 报错并请求失败退出。 */
function fail(io, error) {
	io.stderr.write(`dsh: ${error instanceof Error ? error.message : String(error)}\n`);
	io.exit(1);
}

/**
 * 调用方要求的权限档位(与 permission-presets 的表项同名)。
 * 桥接层用 `DSH_SUBAGENT_PERMISSION` 传进来。
 */
const REQUESTED_PERMISSION = process.env.DSH_SUBAGENT_PERMISSION ?? process.env.DSH_PERMISSION_MODE ?? 'danger-full-access';

/**
 * 把调用方要求的权限档位**钉进这一次会话**。
 *
 * 为什么不能只靠 profile 里 `permission` 插件的 `defaultPreset`:
 * 权限预设值存在 `$DSH_HOME/settings.yaml` 的 `permission.defaultPreset` 里,是**全局**的
 * (就是 GUI 里选的档位)。子进程读同一个文件,settings provider 的值会盖掉 profile 的
 * `config.defaultPreset`。于是 `--permission workspace-write` 只改了沙箱服务的默认值,
 * 会话自己的权限事实仍然是 `danger-full-access` —— 而文件/命令工具是**每次按会话事件**
 * 解析策略的(`ctx.sandboxPolicy.resolve({ session })` → `effectiveSandboxMode(session.events)`),
 * 所以那道限制等于没生效(实测:越界写入照样成功)。
 *
 * 正确做法:用 `permissionPresets` 服务的公开 `set()` 把档位写进本会话的事件流 —— 与
 * GUI 里手动切档位走的是同一条路径,会追加 `permission/preset` / `sandbox/mode` /
 * `approval/policy`,且只影响这一次调用,不动用户的全局设置。
 *
 * @param ctx - 插件上下文(需能取到 permissionPresets)。
 * @param agent - 本次调用唯一对应的 Agent。
 * @returns 一句给 stderr 的说明;无话可说时返回 null。
 * @throws 当要求了收窄权限、却无法真正锁定时 —— 宁可失败,也不能悄悄用更宽的权限跑。
 */
function pinPermission(ctx, agent) {
	const requested = REQUESTED_PERMISSION;
	const presets = ctx.get('permissionPresets');
	if (presets === undefined) {
		if (requested === 'danger-full-access') return 'dsh: 本部署未挂载 permissionPresets,沿用部署默认权限';
		throw new Error(`subagent-runner: 调用方要求 --permission ${requested},但本部署没有 permissionPresets,无法锁定权限;拒绝以更宽的权限运行`);
	}
	if (!presets.names.includes(requested)) {
		throw new Error(`subagent-runner: 未知权限档位 "${requested}"(可用: ${presets.names.join(', ')})`);
	}
	const before = presets.current(agent.session.events);
	if (before === requested) return null;
	presets.set(agent.session, requested);
	const after = presets.current(agent.session.events);
	if (after !== requested) {
		throw new Error(`subagent-runner: 权限锁定失败(${before} → ${after},目标 ${requested})`);
	}
	return `dsh: 权限 ${before} → ${requested}(已写入本会话事件,工具层按会话解析)`;
}

/**
 * 用全新 Agent 跑一轮任务并把结果交付给调用方。
 * @param ctx - 携带 agents / agentDefaultModel / sessions 的插件上下文。
 * @param config - 已校验的 row 配置。
 * @param io - 面向进程的副作用。
 */
async function run(ctx, config, io) {
	await ctx.get('loader')?.await();
	const agents = ctx.get('agents');
	const defaultModel = ctx.get('agentDefaultModel');
	const sessions = ctx.get('sessions');
	if (agents === undefined || defaultModel === undefined || sessions === undefined) {
		throw new Error('subagent-runner: agents / agentDefaultModel / sessions 未就绪');
	}

	const base = defaultModel.currentSelection();
	const selection = {
		provider: typeof config.provider === 'string' && config.provider !== '' ? config.provider : base.provider,
		model: typeof config.model === 'string' && config.model !== '' ? config.model : base.model,
		...(typeof config.reasoningEffort === 'string' && config.reasoningEffort !== ''
			? { reasoningEffort: config.reasoningEffort }
			: base.reasoningEffort === undefined ? {} : { reasoningEffort: base.reasoningEffort }),
	};

	const startedAt = Date.now();
	const { agent } = await agents.create({
		sessionId: SessionId(`session-${randomUUID()}`),
		meta: { cwd: process.cwd() },
		agentOptions: {
			provider: selection.provider,
			model: selection.model,
			...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
		},
		setup: (agentCtx) => {
			installModelSelection(agentCtx, { current: selection, assembled: undefined });
		},
	});

	await agent.whenIdle();
	// 权限必须先钉住再发提示词:工具的沙箱策略是按会话事件解析的,系统提示词里的
	// "本会话文件策略" 也是这一轮开始时读的。
	const permissionNote = pinPermission(ctx, agent);
	if (permissionNote !== null) io.stderr.write(`${permissionNote}\n`);
	// 会话一建立就先把 sessionId 交出去:外部监控(DSH GUI 的 subagent 观察器)靠它
	// 把"正在跑的任务"和 GUI 里的会话对上号,不必等这一轮结束。
	writeSafely(config.metadataFile, `${JSON.stringify({
		sessionId: String(agent.session.id),
		workspace: process.cwd(),
		provider: selection.provider,
		model: selection.model,
		permission: REQUESTED_PERMISSION,
		pid: process.pid,
		phase: 'running',
		startedAt: new Date(startedAt).toISOString(),
	}, null, 2)}\n`, io.stderr);
	const firstSeq = agent.session.seq;
	const stopReasoning = streamReasoning(ctx, agent, io.stderr);
	try {
		agent.followup(createUserMessage({
			content: [{ type: 'text', text: config.task }],
			source: { kind: 'user' },
		}));
		await agent.whenIdle();
	} finally {
		stopReasoning();
	}

	await sessions.flush(agent.session);
	const outcome = summarize(agent.session.events, firstSeq);
	const reason = describeReason(outcome.reason);
	const metadata = {
		sessionId: String(agent.session.id),
		workspace: process.cwd(),
		provider: selection.provider,
		model: selection.model,
		permission: REQUESTED_PERMISSION,
		...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: String(selection.reasoningEffort) }),
		stopReason: reason === null ? null : reason.kind,
		error: reason === null ? null : reason.error ?? null,
		resultChars: outcome.text.length,
		durationMs: Date.now() - startedAt,
		finishedAt: new Date().toISOString(),
	};

	writeSafely(config.resultFile, outcome.text, io.stderr);
	writeSafely(config.metadataFile, `${JSON.stringify(metadata, null, 2)}\n`, io.stderr);
	io.stderr.write(`dsh-subagent-meta: ${JSON.stringify(metadata)}\n`);
	io.stdout.write(`${outcome.text}\n`);
	if (metadata.error !== null) io.stderr.write(`dsh: ${metadata.error.code}: ${metadata.error.message}\n`);
	io.exit(metadata.stopReason === 'completed' ? 0 : 1);
}

/**
 * 挂载一次性 subagent runner。
 * @param ctx - 携带核心服务与启动器退出请求的插件上下文。
 * @param config - 已校验的配置。
 */
export function apply(ctx, config) {
	const exit = ctx.get('appExit');
	if (exit === undefined) throw new Error('subagent-runner: 启动器必须在树挂载前提供 ctx.appExit');
	const io = {
		stdout: internals.stdout,
		stderr: internals.stderr,
		exit,
	};
	run(ctx, config, io).catch((error) => {
		fail(io, error);
	});
}
