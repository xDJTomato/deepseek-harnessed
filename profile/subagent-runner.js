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
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';

/** 稳定的 Cordis 插件名。 */
export const name = 'subagent-runner';

/**
 * 未知 chunk 类型的兜底(原先是 `dsh-llm` 的 `assertNever`)。
 *
 * **为什么自己写一个**:DSH 0.1.5-rc.1 起 `@deepseek-ai/dsh-llm` 不再导出 `assertNever`,
 * 而 runner 的 import 列表里带着它 ⇒ 整个 subagent profile 在插件树加载阶段就
 * `SyntaxError: does not provide an export named 'assertNever'`,`dsh_task` 1.5 秒即失败、
 * 文件写不出来、答复为空(实测)。
 *
 * 语义也顺势调整:原来会**抛异常**,意味着新版一旦给推理流加一种 chunk 类型就会整轮崩掉。
 * 现在是"告警 + 忽略"—— 只影响流式展示,不影响任务本身的成败,这正是穷尽性检查该有的降级方式。
 *
 * @param value - 未识别的 chunk。
 * @param context - 用在哪条流上(只用于日志)。
 */
function warnUnknownChunk(value, context) {
	try {
		const text = JSON.stringify(value);
		internals.stderr.write(`[subagent] 忽略未知的${context} chunk: ${text === undefined ? String(value) : text.slice(0, 200)}\n`);
	} catch {
		internals.stderr.write(`[subagent] 忽略未知的${context} chunk\n`);
	}
}

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
	printCatalogue: z.boolean(),
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
				// 未知 chunk:只告警,不打断这一轮(见 warnUnknownChunk 的说明)。
				return warnUnknownChunk(chunk, 'subagent reasoning stream');
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

/**
 * 报错并请求失败退出。
 *
 * 打印**完整栈**:只打 `error.message` 时,DSH 升级导致的 API 形状变化会表现为
 * 一句没头没尾的 `dsh: Cannot read properties of undefined (reading 'header')`
 * (实测 0.1.5-rc.1),根本定位不到是哪一步调用。栈里带着 DSH 内部帧,能直接读出
 * 是哪个插件/哪一行变了。
 *
 * @param io - 进程副作用。
 * @param error - 捕获到的异常。
 */
function fail(io, error) {
	const message = error instanceof Error ? error.message : String(error);
	io.stderr.write(`dsh: ${message}\n`);
	if (error instanceof Error && typeof error.stack === 'string') {
		io.stderr.write(`${error.stack}\n`);
	}
	if (error instanceof AggregateError) {
		for (const inner of error.errors ?? []) {
			io.stderr.write(`  ↳ ${inner instanceof Error ? inner.stack ?? inner.message : String(inner)}\n`);
		}
	}
	io.exit(1);
}

/**
 * 调用方要求的权限档位(与 permission-presets 的表项同名)。
 * 桥接层用 `DSH_SUBAGENT_PERMISSION` 传进来。
 */
const REQUESTED_PERMISSION = process.env.DSH_SUBAGENT_PERMISSION ?? process.env.DSH_PERMISSION_MODE ?? 'workspace-write';

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
	const before = currentPreset(presets, agent.session);
	if (before === requested) return null;
	presets.set(agent.session, requested);
	const after = currentPreset(presets, agent.session);
	if (after !== requested) {
		throw new Error(`subagent-runner: 权限锁定失败(${before} → ${after},目标 ${requested})`);
	}
	return `dsh: 权限 ${before} → ${requested}(已写入本会话事件,工具层按会话解析)`;
}

/**
 * 读当前权限档位。
 *
 * **跨版本**:DSH 0.1.5-rc.1 起 `permissionPresets.current()` 收的是 **Session 对象**
 * (`permissionState(session)` → 走 session 投影读 knobs);0.1.4 及更早收的是**事件数组**
 * (`derive(foldKnobs(events))`)。传错形状不会报"参数不对",而是从 DSH 内部炸出一句
 * `Cannot read properties of undefined (reading 'header')`(实测),极难定位 ——
 * 所以这里先按新版调,失败再按旧版调,两条路都不通才把原始错误抛出去。
 *
 * @param presets - `permissionPresets` 服务。
 * @param session - 目标 Session。
 * @returns 当前生效的档位名。
 */
function currentPreset(presets, session) {
	try {
		return presets.current(session);
	} catch (error) {
		const events = session.log ?? session.events;
		if (Array.isArray(events)) return presets.current(events);
		throw error;
	}
}

/**
 * 取一个 Session 的事件流(新版叫 `log`,旧版叫 `events`)。
 * @param session - 目标 Session。
 * @returns 事件数组(取不到时为空数组)。
 */
function eventsOf(session) {
	const events = session.log ?? session.events;
	return Array.isArray(events) ? events : [];
}

/**
 * 排出**候选路由**:同一个模型 id 可能在多条 provider 下登记,但各自声明的
 * `reasoningEfforts` 与可用状态不同 —— 实测 0.2.1 的本机:同一个模型 id 在一条聚合路由下声明了
 * `max`,在另外两条下只到 `high`;而官方路由也声明 `max` 却没有余额。
 *
 * 所以分两段:先列**声明了该档位**的 provider(用原生元数据 `resolveModelInfo` 的
 * `reasoning.efforts` 核),再补上其余登记了该模型、但没声明该档位的 provider ——
 * 后者只在前面全部路由级失败时才会被尝试(见 shouldTryNext)。
 * 优先沿用 DSH 当前默认选择里的 provider(用户自己在 GUI 里选的那条),再按注册顺序。
 *
 * @param ctx - 携带 llm 服务的插件上下文。
 * @param model - 要用的模型 id。
 * @param effort - 要求的推理档位(可为 null:不校验档位)。
 * @param preferred - DSH 默认选择里的 provider(可为 undefined)。
 * @returns 有序的 provider id 列表(可能为空:那就交回 DSH 默认 provider)。
 */
async function providerCandidates(ctx, model, effort, preferred) {
	const llm = ctx.get('llm');
	if (llm === undefined) return [];
	const supported = [];
	const rest = [];
	for (const provider of llm.listProviders()) {
		const id = typeof provider?.id === 'string' ? provider.id : '';
		if (id === '') continue;
		try {
			const models = await llm.listModels(id);
			if (!Array.isArray(models) || !models.some((entry) => entry?.id === model)) continue;
		} catch {
			// 该 provider 的 catalog 取不到 ≠ 没有这个模型:跳过,但不算命中。
			continue;
		}
		let declares = false;
		if (effort !== null) {
			try {
				const info = await llm.resolveModelInfo(id, model);
				const efforts = info?.reasoning?.efforts;
				declares = Array.isArray(efforts) && efforts.some((entry) => entry?.id === effort);
			} catch {
				// 元数据解析失败:当作"没声明",排到备用段。
			}
		}
		(effort === null || declares ? supported : rest).push(id);
	}
	const order = (ids) => (typeof preferred === 'string' && ids.includes(preferred)
		? [preferred, ...ids.filter((id) => id !== preferred)]
		: ids);
	return [...order(supported), ...order(rest)];
}

/**
 * 把候选路由摊成"每次尝试用的模型选择"。
 * 调用方点名了 provider → 只试那一条;点名了模型 → 按候选顺序;什么都没点 → DSH 默认。
 * @param base - DSH 当前默认选择。
 * @param model - 调用方点名的模型(可为 null)。
 * @param provider - 调用方点名的 provider(可为 null)。
 * @param effort - 推理档位(可为 null)。
 * @param candidates - providerCandidates 的结果。
 * @returns 有序的选择列表(至少一条)。
 */
function planAttempts(base, model, provider, effort, candidates) {
	const selectedModel = model ?? base.model;
	const selectionFor = (route) => ({
		provider: route,
		model: selectedModel,
		...(effort === null ? {} : { reasoningEffort: effort }),
	});
	if (provider !== null) return [selectionFor(provider)];
	if (model === null || candidates.length === 0) return [selectionFor(base.provider)];
	return candidates.map(selectionFor);
}

/** 可以换路由重试的错误码:它们都发生在第一个模型请求上,还没有任何工具执行。 */
const ROUTE_LEVEL_ERRORS = new Set([
	'QUOTA',
	'ACCOUNT_QUOTA_EXCEEDED',
	'MISSING_CREDENTIAL',
	'INVALID_CREDENTIAL',
	'UNSUPPORTED_REASONING_EFFORT',
	'UNKNOWN_MODEL',
]);

/**
 * 这条路失败后还要不要试下一条。
 *
 * 只换**路由级**失败:余额、凭据、档位、未知模型。这类错误发生在第一个模型请求上
 * (还没有任何工具执行),换一条路由重跑没有副作用;工具/沙箱类失败、模型真正开跑后
 * 的失败一律不重试,避免把"任务做坏了"伪装成"换个路由就好了"。
 * @param attempt - runAttempt 的结果。
 * @returns 是否换下一条。
 */
function shouldTryNext(attempt) {
	const code = attempt.reason === null ? null : attempt.reason.error?.code ?? null;
	if (code === null || !ROUTE_LEVEL_ERRORS.has(code)) return false;
	return attempt.outcome.text === '';
}

/**
 * 用一份模型选择跑一轮(全新会话),不写结果文件、不退出 —— 收尾交给调用方,
 * 这样"换下一条路由"时不会把中间那条的失败当成最终结果落盘。
 * @param ctx - 插件上下文。
 * @param config - 已校验的 row 配置。
 * @param io - 进程副作用。
 * @param selection - 本次尝试的 provider/model/reasoningEffort。
 * @returns {{selection:object,sessionId:string,outcome:object,reason:object|null,startedAt:number}}
 */
async function runAttempt(ctx, config, io, selection) {
	const agents = ctx.get('agents');
	const sessions = ctx.get('sessions');
	if (agents === undefined || sessions === undefined) {
		throw new Error('subagent-runner: agents / sessions 未就绪');
	}
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
	const outcome = summarize(eventsOf(agent.session), firstSeq);
	return {
		selection,
		sessionId: String(agent.session.id),
		outcome,
		reason: describeReason(outcome.reason),
		startedAt,
	};
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
	const configuredModel = typeof config.model === 'string' && config.model !== '' ? config.model : null;
	const configuredProvider = typeof config.provider === 'string' && config.provider !== '' ? config.provider : null;
	const configuredEffort = typeof config.reasoningEffort === 'string' && config.reasoningEffort !== '' ? config.reasoningEffort : null;
	const reasoningEffort = configuredEffort ?? (base.reasoningEffort === undefined ? null : String(base.reasoningEffort));
	// 只点了模型、没点 provider:按"谁真的支持这个推理档位"排出候选路由(见 providerCandidates)。
	// 排在最前面的优先试;路由级失败(余额/凭据/档位)才换下一条,见 shouldTryNext。
	const candidates = configuredProvider !== null || configuredModel === null
		? []
		: await providerCandidates(ctx, configuredModel, reasoningEffort, base.provider);
	const attempts = planAttempts(base, configuredModel, configuredProvider, reasoningEffort, candidates);

	// 逐条路由试:每条都是**全新的 Agent 会话**,互不影响。只有"这条路由本身不可用"才换下一条
	// (余额/凭据/档位/未知模型),这些失败都发生在第一个模型请求上,还没执行任何工具。
	let attempt = null;
	for (let index = 0; index < attempts.length; index += 1) {
		attempt = await runAttempt(ctx, config, io, attempts[index]);
		if (attempt.reason === null || !shouldTryNext(attempt) || index === attempts.length - 1) break;
		io.stderr.write(`dsh: ${attempt.reason.error.code}: ${attempt.reason.error.message} —— 换下一条路由(${attempts[index + 1].provider})重试\n`);
	}
	const { selection, outcome } = attempt;
	const reason = attempt.reason;
	const metadata = {
		sessionId: attempt.sessionId,
		workspace: process.cwd(),
		provider: selection.provider,
		model: selection.model,
		permission: REQUESTED_PERMISSION,
		...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: String(selection.reasoningEffort) }),
		stopReason: reason === null ? null : reason.kind,
		error: reason === null ? null : reason.error ?? null,
		resultChars: outcome.text.length,
		durationMs: Date.now() - attempt.startedAt,
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
	// `--print-model-catalogue` 是"只问登记表"的模式:由 subagent-models 回答就够,
	// runner 在同一个进程里也挂着,必须让位 —— 否则它会拿空任务去起一轮真会话。
	if (config.printCatalogue === true) return;
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
