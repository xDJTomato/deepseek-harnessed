/**
 * MCP(Model Context Protocol)stdio server:把 DSH 实例暴露成一个 subagent 工具。
 *
 * 传输层是换行分隔的 JSON-RPC 2.0(与 DSH 自己的 dsh-sdk-protocol 同一套约定):
 * stdout 只允许出现协议帧,所有日志一律走 stderr。
 *
 * 暴露的工具:
 *   dsh_health      探活:确认桥接可用,回报默认工作空间、实时任务与按 caller 的并发分布、
 *                   **这个实例已接入的模型**与**模型策略文件**(未指定默认模型时附带首次接入引导)
 *   dsh_setup       首次接入:把用户选定的默认模型落盘到用户可编辑的策略文件(config/model-policy.md)
 *   dsh_task        把任务委托给 DSH(必须声明 expected_seconds;短任务直接返回结果,长任务返回 job_id)
 *   dsh_task_status 轮询/等待某个 DSH 任务(只在 dsh_task 短超时到点后才需要;含 recent_activity 活动流)
 *   dsh_task_cancel 优雅取消:请求终止并让任务自己收尾
 *   dsh_task_kill   强制终止:按 job_id 或按 caller 立刻杀掉进程树
 *
 * @module dsh-subagent/lib/mcp
 */
import { appendFileSync, closeSync, fstatSync, openSync, readFileSync, readSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveLauncher } from './launcher.mjs';
import { ensureMonitorHost, monitorHostStatus, peekMonitorHostAction } from './monitor-host.mjs';
import {
	DEADLINE_GRACE, DEFAULT_PERMISSION, DEFAULT_TIMEOUT_SECONDS, DEFAULT_WATCHDOG_INTERVAL_SECONDS,
	STALL_PROBES, STALL_MIN_SECONDS, STALL_CPU_MS, STALL_CPU_WORK_FLOOR_MS, callerStats, cancelTask, killByCaller, killTask, listTasks, liveTaskInfos,
	observeProgress, resolveWorkspace, startTask, waitForTask,
} from './tasks.mjs';
import { BRIDGE_ROOT, clip, dshHome, ensureDir, readText, writeText } from './util.mjs';

/**
 * 本 server 声明的版本 —— **从 package.json 读**,不写第二份。
 *
 * 曾经的坑:这里硬编码 `0.2.0`,而 package.json 是 `0.1.1`。两个版本号各自漂移,
 * 用户在 Cursor 日志里看到的横幅版本与仓库对不上,排查时先被误导一轮。
 *
 * @type {string}
 */
export const SERVER_VERSION = (() => {
	try {
		const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
		return typeof manifest.version === 'string' ? manifest.version : '0.0.0';
	} catch {
		return '0.0.0';
	}
})();

/** 支持的 MCP 协议版本(按新→旧)。 */
const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05', '2024-10-07'];

/** 回传给 harness 的最终答复上限(字符);超长会掐头去尾并提示落盘位置。 */
const RESULT_CLIP = Number(process.env.DSH_SUBAGENT_RESULT_CLIP ?? 60000);

/**
 * dsh_task 的默认**短超时**等待秒数 —— 评估后的取值,不是随手写的。
 *
 * 语义:这次调用自己先等一小段。任务在这段里结束,结果就**由这次调用直接带回**,调用方
 * 一次都不用轮询;只有等到它还没结束(返回 status="running")才转成轮询。
 *
 * 为什么是 45s:
 *   - 调用方的单次工具超时是硬约束。Codex 的 `mcp_servers.<id>.tool_timeout_sec` 默认 60s;
 *     Claude Code 的 stdio 空闲窗默认 30 分钟、单次墙钟上限约 28 小时(超 2 分钟还会转后台);
 *     Cursor 未公开。按最紧的 60s 留 25% 余量 ⇒ 45s。
 *   - 不要再往上加:一旦超过调用方的工具超时,harness 会先掐断这次调用,而掐断时它可能发
 *     notifications/cancelled —— 那会被本 server 当成"调用方停了这一轮"而**杀掉任务**。
 *     想让长任务一次返回,先把调用方的工具超时调大(Codex: tool_timeout_sec = 600),
 *     再用 DSH_SUBAGENT_WAIT_SECONDS 同步把这里调大。
 */
const DEFAULT_WAIT_SECONDS = Number(process.env.DSH_SUBAGENT_WAIT_SECONDS ?? 45);

/**
 * dsh_task_status 的默认等待秒数(只在 dsh_task 的短超时到点、任务确实还没跑完时才用到)。
 * 同样压在 45s 以下(默认 30s),保证永远打不到调用方的工具超时。
 */
const DEFAULT_STATUS_WAIT_SECONDS = Number(process.env.DSH_SUBAGENT_STATUS_WAIT_SECONDS ?? 30);

/** 活动流(最近干什么)的回传上限与取样窗口。 */
const ACTIVITY_CLIP = Number(process.env.DSH_SUBAGENT_ACTIVITY_CLIP ?? 1800);
const ACTIVITY_TAIL_CHARS = 20000;
const ACTIVITY_LINES = 10;

/** 一次性委托时给 DSH 的前言,让它像 subagent 而不是像在跟人聊天。 */
function delegationPreamble({ client, workspace, raw }) {
	if (raw) return '';
	return [
		'# 委托说明',
		`- 你正被外部 harness(${client || '未知 harness'})通过 DSH subagent 桥接调用,工作目录:${workspace}`,
		'- 这是一次性会话:没有任何人会再回答你的追问,不要提问、不要等待确认,直接完成任务。',
		'- 需要权限或取舍时自行判断并继续;有副作用但属于完成任务的必要动作,可以做。',
		'- 结束时用中文简要汇报:做了什么、改了哪些文件(绝对路径)、命令与结果、结论;若未完成必须说明阻塞原因。',
		'',
		'# 任务内容',
		'',
	].join('\n');
}

/** 让 CLI 参数可以覆盖工作空间默认值。 */
function defaultWorkspace() {
	const explicit = process.env.DSH_SUBAGENT_WORKSPACE;
	if (typeof explicit === 'string' && explicit.trim() !== '') return explicit.trim();
	return process.cwd();
}

/**
 * 三个"可选覆盖"参数(model / provider / reasoning_effort)的**共享**校验。
 *
 * 旧行为是"类型不对就静默忽略"(传 `reasoning_effort: 3` 等于没传),与本仓库
 * "响亮失败、不静默降级"的口径不符:调用方会以为自己的指定生效了。
 * 现在:值存在且不是字符串 ⇒ 拒收;空串/纯空白 ⇒ 视为未提供(沿用 DSH 默认)。
 * @param args - 工具参数。
 * @param names - 要校验的参数名。
 * @returns 校验通过时给 `{values}`(值为 trim 后的字符串或 undefined),否则 `{error}`。
 */
function optionalOverrides(args, names) {
	const values = {};
	for (const name of names) {
		const raw = args[name];
		if (raw === undefined || raw === null) {
			values[name] = undefined;
			continue;
		}
		if (typeof raw !== 'string') {
			return { error: `${name} 必须是字符串(收到 ${JSON.stringify(raw)}):它只在有值时覆盖 DSH 默认配置,类型不对会被直接拒收,而不是静默忽略。` };
		}
		values[name] = raw.trim() === '' ? undefined : raw.trim();
	}
	return { values };
}

/** 读取 DSH 设置里的默认模型(极小的 YAML 嗅探,失败就返回 null)。 */
function readDefaultModel() {
	const text = readText(join(dshHome(), 'settings.yaml'));
	const block = /agent-default-model:\s*\n((?:[ \t]+.*\n?)+)/.exec(text);
	if (block === null) return null;
	const provider = /provider:\s*(\S+)/.exec(block[1]);
	const model = /model:\s*(\S+)/.exec(block[1]);
	if (provider === null || model === null) return null;
	return `${provider[1]}/${model[1]}`;
}

/**
 * 策略文件的路径:环境变量 `DSH_SUBAGENT_POLICY` 优先,否则 `<桥接层根>/config/model-policy.md`。
 * 环境变量是给自检/多实例隔离用的(自检绝不改仓库里那份发布物)。
 */
function modelPolicyPath() {
	const explicit = process.env.DSH_SUBAGENT_POLICY;
	if (typeof explicit === 'string' && explicit.trim() !== '') return resolve(explicit.trim());
	return join(BRIDGE_ROOT, 'config', 'model-policy.md');
}

/** 策略文件里"默认模型"的取值 → 模型 id;`(未指定)`/空白都表示还没指定(null)。 */
function policyModelValue(raw) {
	if (typeof raw !== 'string') return null;
	const value = raw.trim().replace(/^[`'"]+|[`'"]+$/g, '').trim();
	if (value === '' || value === '(未指定)' || value === '(未设置)' || value === 'null') return null;
	return value;
}

/** 取 `[` 起配对的方括号正文(按括号深度配对;找不到配对的 `]` 返回 null)。 */
function bracketBody(text, openIndex) {
	let depth = 0;
	for (let index = openIndex; index < text.length; index += 1) {
		if (text[index] === '[') depth += 1;
		else if (text[index] === ']') {
			depth -= 1;
			if (depth === 0) return text.slice(openIndex + 1, index);
		}
	}
	return null;
}

/**
 * 某个位置往左、包着它的那个 `{` 前面的键名 —— 也就是"这个块属于谁"。
 *
 * settings.yaml 是 flow 风格(`route:\n  { … }`),route 名不在 `models:` 同一行上,
 * 只能靠花括号层级往回找。**不要**用"最近一个 `key: {`"糊弄:上一个 route 里的
 * `reasoningEfforts: {…}` 也在前面,多 route 时会认错。
 */
function enclosingBlockName(text, index) {
	let depth = 0;
	for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
		if (text[cursor] === '}') depth += 1;
		else if (text[cursor] === '{') {
			if (depth === 0) {
				const before = text.slice(Math.max(0, cursor - 160), cursor);
				return [...before.matchAll(/([A-Za-z0-9_.-]+)\s*:\s*$/g)].pop()?.[1] ?? '';
			}
			depth -= 1;
		}
	}
	return '';
}

/**
 * 嗅探 `$DSH_HOME/settings.yaml`,把这个 DSH 实例**已接入**的模型列出来。
 *
 * 只认两处方括号数组:`llm-pi-ai.providers.<route>.models`(route 名就是 provider)与
 * `llm-deepseek.models`。**绝不能**全文件扫 `id:` —— settings.yaml 里别处也会出现 `id:`
 * 之类的键,扫全文件会把它们当成模型(自检里有一条 decoy 断言钉住这点)。
 *
 * 容错:文件缺失/形状不认识时**不抛异常**,返回空 providers + error 说明原因 ——
 * 调用方据此能分清"枚举不到"与"这个实例真没有模型"。去重,并保持文件里的出现顺序。
 *
 * @returns {{providers:Record<string,string[]>,all:string[],defaultModel:string|null,error:string|null}}
 */
function readModels() {
	const path = join(dshHome(), 'settings.yaml');
	const text = readText(path);
	const defaultModel = readDefaultModel();
	if (text.trim() === '') {
		return {
			providers: {},
			all: [],
			defaultModel: null,
			error: `读不到 ${path}(文件不存在、为空或不可读),枚举不到这个 DSH 实例已接入的模型`,
		};
	}
	const providers = {};
	const seen = new Set();
	for (const match of text.matchAll(/\bmodels\s*:\s*\[/g)) {
		const head = text.slice(0, match.index);
		const owner = [...head.matchAll(/^([A-Za-z0-9_.-]+):/gm)].pop()?.[1] ?? '';
		const route = owner === 'llm-pi-ai'
			? enclosingBlockName(text, match.index)
			: owner === 'llm-deepseek' ? 'llm-deepseek' : '';
		// 顶层小节之外、或没认出 route 的 models 数组一律不认(宁可少列,不可乱列)
		if (route === '' || route === 'providers') continue;
		const body = bracketBody(text, match.index + match[0].length - 1);
		if (body === null) continue;
		const list = providers[route] ?? [];
		for (const idMatch of body.matchAll(/\bid\s*:\s*([^\s,}\]]+)/g)) {
			const id = idMatch[1].trim();
			if (id === '' || seen.has(id)) continue;
			seen.add(id);
			list.push(id);
		}
		if (list.length > 0) providers[route] = list;
	}
	if (seen.size === 0) {
		return {
			providers,
			all: [],
			defaultModel,
			error: `在 ${path} 里没认出任何模型清单(只认 llm-pi-ai.providers.<route>.models 与 llm-deepseek.models 的方括号数组)`,
		};
	}
	return { providers, all: [...seen], defaultModel, error: null };
}

/**
 * 从策略文件的「## 预设方案」段解出预设名,以及每个预设声明的模型。
 * 每个 `### <名字>` 小节里的第一条 `预设默认模型: <模型 id>` 就是它落盘的模型。
 */
function readPresets(text) {
	const presets = [];
	const presetModels = {};
	const heading = /^##[ \t]*预设方案[ \t]*$/m.exec(text);
	if (heading === null) return { presets, presetModels };
	const rest = text.slice(heading.index + heading[0].length);
	const nextSection = /^##(?!#)/m.exec(rest);
	const body = nextSection === null ? rest : rest.slice(0, nextSection.index);
	for (const chunk of body.split(/^###[ \t]*/m).slice(1)) {
		const newline = chunk.indexOf('\n');
		const name = (newline < 0 ? chunk : chunk.slice(0, newline)).trim();
		if (name === '') continue;
		presets.push(name);
		const declared = /^预设默认模型:[ \t]*(.*)$/m.exec(chunk);
		presetModels[name] = declared === null ? null : policyModelValue(declared[1]);
	}
	return { presets, presetModels };
}

/**
 * 读**用户可编辑的模型策略文件** —— 也就是"选择模型的系统提示词"。
 *
 * 机器只读两处:文件里第一条 `默认模型:` 行,以及每个 `### 预设` 小节里的 `预设默认模型:` 行;
 * 其余正文只给人看(用户随便改)。文件每次调用都重新读,所以改完立刻生效、不用重启。
 *
 * @returns {{path:string,fileUrl:string,text:string,defaultModel:string|null,raw:string|null,presets:string[],presetModels:Record<string,string|null>}}
 */
function readModelPolicy() {
	const path = modelPolicyPath();
	const text = readText(path);
	const declared = /^默认模型:[ \t]*(.*)$/m.exec(text);
	const raw = declared === null ? null : declared[1].trim();
	return {
		path,
		fileUrl: pathToFileURL(path).href,
		text,
		defaultModel: policyModelValue(raw),
		raw,
		...readPresets(text),
	};
}

/** 策略文件的一行引用(绝对路径 + 可点开的 file:/// 链接)—— 描述与引导块共用,别各写一份。 */
function policyRef(policy) {
	return `${policy.path}(${policy.fileUrl})`;
}

/**
 * 把调用方给的模型标识匹配到已接入的模型:裸 model id 与 `provider/model` 两种写法都认。
 * 有些模型 id 本身就带斜杠(如 `qwen/qwen3.6-max-preview`),所以先按 `provider/model` 拆一次,
 * 拆不中再按裸 id 找。
 * @returns {{route:string,model:string}|null} 没匹配上返回 null。
 */
function matchInstalledModel(models, value) {
	const slash = value.indexOf('/');
	if (slash > 0) {
		const route = value.slice(0, slash);
		const model = value.slice(slash + 1);
		if ((models.providers[route] ?? []).includes(model)) return { route, model };
	}
	for (const [route, ids] of Object.entries(models.providers)) {
		if (ids.includes(value)) return { route, model: value };
	}
	return null;
}

/** 未接入模型的拒绝话术:**必须把可用清单打出来**,调用方才能据此重新问用户。 */
function unknownModelMessage(models, value) {
	const available = Object.entries(models.providers)
		.map(([route, ids]) => `  ${route}: ${ids.join(', ')}`)
		.join('\n');
	return `模型 "${value}" 不在这个 DSH 实例已接入的模型里(只认 $DSH_HOME/settings.yaml 的 models 数组里声明的 id)。可用模型清单(provider: id …):\n${available}\n请从中挑一个再用 dsh_setup(default_model: "<id>") 落盘;要指定 provider 也可以传 "provider/id"。`;
}

/**
 * 首次接入引导块 —— MCP server **不能直接跟用户对话**,所以只能请调用方 agent 转达:
 * 先看清这个实例接入了哪些模型,再问用户要一个默认模型,然后用 dsh_setup 落盘,
 * 最后把策略文件链接给用户(里面的口径用户可以自己改)。
 *
 * 只在策略文件还没指定默认模型时出现;指定过就不再出现 —— 策略文件是全局的,
 * 不必按 caller 记状态(简单、无状态)。
 * @param policy - readModelPolicy() 的结果。
 * @returns {string|null} 紧凑引导块(≤10 行);已指定默认模型时返回 null。
 */
function setupBlock(policy) {
	if (policy.defaultModel !== null) return null;
	const preset = policy.presets[0] ?? '本项目方案';
	return [
		'[首次接入:请先指定默认模型]',
		'1) 先用 dsh_health 的 models.providers 看清这个 DSH 实例里已接入模型有哪些(不要猜 id)。',
		'2) 请用户指定一个默认模型:把挑中的 model id 原样回填(用户没定之前先别派任务)。',
		`3) 落盘:dsh_setup(default_model: "<model id>") 或 dsh_setup(preset: "${preset}")。`,
		`4) 策略文件链接(选择模型的口径写在这里,用户可以自己改):${policy.fileUrl}`,
		`   文件:${policy.path}(路径可用 DSH_SUBAGENT_POLICY 覆写)。`,
	].join('\n');
}

/** 去掉 ANSI 转义(Cursor / Claude Code 的日志里常有颜色码)。 */
function stripAnsi(text) {
	// eslint-disable-next-line no-control-regex
	return text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '').replace(/\r/g, '');
}

/** 一行是否有信息量:太短、纯符号、纯数字的都算噪声。 */
function meaningful(line) {
	if (line.length < 4) return false;
	if (/^[-=_*#~`.\s|]+$/.test(line)) return false;
	return /[\p{L}\p{N}]/u.test(line);
}

/**
 * 取文件尾部文本(按字节读,避免把几十 MB 的日志整个读进内存)。
 * @param path - 目标文件。
 * @param maxBytes - 最多读多少字节。
 * @returns 文本(读不到就是空串)。
 */
function tailText(path, maxBytes) {
	try {
		const fd = openSync(path, 'r');
		try {
			const size = fstatSync(fd).size;
			const start = Math.max(0, size - maxBytes);
			const length = size - start;
			if (length <= 0) return '';
			const buffer = Buffer.alloc(length);
			readSync(fd, buffer, 0, length, start);
			return buffer.toString('utf8');
		} finally {
			closeSync(fd);
		}
	} catch {
		return '';
	}
}

/**
 * 最近活动流:子进程 stderr 的尾部有意义行 + stdout 尾部。
 * 目的是让调用方看得见"DSH 现在在干什么",而不是只有一个 running。
 * @param taskDir - 任务目录。
 * @returns {{stderr_lines:string[],stdout_tail:string,stderr_bytes:number,note:string|null}}
 */
function recentActivity(taskDir) {
	const stderrText = stripAnsi(tailText(join(taskDir, 'stderr.log'), ACTIVITY_TAIL_CHARS));
	const stdoutText = stripAnsi(tailText(join(taskDir, 'stdout.log'), 4000));
	const resultText = tailText(join(taskDir, 'result.txt'), 200);
	const all = stderrText.split('\n').map((line) => line.trimEnd());
	const meaningfulLines = all.filter(meaningful);
	const chosen = (meaningfulLines.length > 0 ? meaningfulLines : all.filter((line) => line.trim() !== ''))
		.slice(-ACTIVITY_LINES)
		.map((line) => line.slice(0, 300));
	const progressBytes = Buffer.byteLength(stderrText, 'utf8')
		+ Buffer.byteLength(stdoutText, 'utf8')
		+ Buffer.byteLength(resultText, 'utf8');
	return {
		stderr_lines: chosen,
		stdout_tail: stdoutText.trim().slice(-800),
		stderr_bytes: progressBytes,
		progress_bytes: progressBytes,
		note: chosen.length === 0 ? '子进程还没有任何输出(可能仍在启动或模型思考中)' : null,
	};
}

/** 工具清单。 */
/** 任务终态语义与补救动作。每种状态都写清"后果"和"下一步该干什么"。 */
const STATUS_SEMANTICS = [
	'状态语义与后果(拿到结果先看 status):',
	'- ok:干完了,result.txt 里是它的最终答复。仍需你自己按 acceptance 复核,别直接当真。',
	'- error:子代理自己报错/退出码非 0。看 stderr.log 最后几十行与 result.txt,修正 prompt 后小步重试。',
	'- deadline:你给的 expected_seconds 不够用,进程树已被杀(不是它的错,是你估小了)。补救:拆小任务,或按实际耗时把 expected_seconds 提到 1.5~2 倍再派。',
	'- stalled:看门狗判定"日志零增长且进程树完全静止"并已杀进程。补救:先看 recent_activity / progress_bytes / last_progress_at 与现场 stderr.log,确认它卡在哪(常见:等一个交互式输入、等网络、等不存在的文件),把卡点写进 prompt 再重派。',
	'- killed:被 dsh_task_kill / dsh_task_cancel 停掉。',
	'- timeout:外层 timeout_seconds 到顶(比 deadline 更松的兜底)。',
].join('\n');

/** 失败时先看什么:统一指向可机读的字段与任务现场。 */
const FAILURE_TRIAGE = [
	'失败先看哪里(顺序):① 本次返回里的 recent_activity(它最近真实输出的几行,含工具调用错误);',
	'② progress_bytes 与 last_progress_at(有没有新产出、最后一次产出是什么时候);',
	`③ 任务现场:${'`'}$DSH_HOME/subagent/state/tasks/<job_id>/${'`'}(result.txt 最终答复、meta.json 会话与相位、stderr.log 实时日志、stdout.log、prompt.md、task.json 完整取证)。`,
].join('');

/**
 * `initialize` 返回的 instructions:harness 会把它当系统提示。
 * 这是上面的"委派操作手册"的浓缩版(≤1500 字),保证模型即使不看单个 schema 也知道怎么用。
 */
export const DELEGATION_INSTRUCTIONS = [
	'DeepSeek Harness(DSH)可作为子代理调用:用 dsh_task 把**自包含**的任务派给一个独立 DSH 代理进程(独立上下文/工具/模型,真的会改文件、跑构建与测试)。它看不到本对话,所以 prompt 里要写全目标、绝对路径、约束、期望产出。',
	'',
	'委派操作手册(必须遵守):',
	'1) 先估时长再派活:expected_seconds 必填,是硬承诺 —— deadlineAt = 开始时刻 + expected_seconds × ' + DEADLINE_GRACE + ',到点杀进程树并记 status="deadline"。经验值:单文件小改 60~180s;多文件小特性 300~900s;大重构 900~1800s 且应拆分。估不准就拆小,别赌一把。',
	'2) 写可机检的验收:acceptance 一句话、可判定真伪(例:"`npm test` 全绿且 src/x.ts 存在 `export function y`"),不写"做好一点"。',
	'3) 先让它自己等,再决定要不要轮询:dsh_task 默认会阻塞 ' + DEFAULT_WAIT_SECONDS + 's(短超时)。任务在这个窗口里结束,结果**由这次调用直接带回** —— 不用轮询;只有返回 status="running"(45s 到点还没完)才转成轮询,用 dsh_task_status(job_id=..., wait_seconds=' + DEFAULT_STATUS_WAIT_SECONDS + ') 每次等 ' + DEFAULT_STATUS_WAIT_SECONDS + 's,一轮一轮推到终态。**不要传 wait_seconds=0**:那会立刻返回 running,把一次调用拆成十几次轮询,每一轮都是你的完整一轮推理,又慢又贵。也不要把 wait_seconds 调过 60s:多数 harness 的单次工具超时就是 60s(Codex tool_timeout_sec 默认 60),超了会被先掐断。',
	'4) 状态语义:ok 完成(仍需按 acceptance 复核);error 它报错(看 stderr.log 尾部,修 prompt 小步重试);deadline 你估小了(拆小或把秒数提到 1.5~2 倍);stalled 日志零增长且进程树全静止、已被杀(看 recent_activity 找卡点再重派);killed 被 dsh_task_kill 停;timeout 外层兜底到顶。',
	'5) 止损:dsh_task_cancel 优雅停,dsh_task_kill 强杀整棵进程树(按 job_id 或按 caller 停掉自己起的全部任务);跑偏了、久无进展就停,别耗着。',
	'6) 排查:dsh_task_status 的 recent_activity / progress_bytes / last_progress_at,以及现场 $DSH_HOME/subagent/state/tasks/<job_id>/{result.txt,meta.json,stderr.log}。',
	'7) 禁止:不要把超过 20 分钟的任务塞进单次 dsh_task;permission 收窄时不要要求子代理用 pwsh 写文件(受限档位下 pwsh 在 Windows 返回全空),写文件用 write/edit 工具。',
	'',
	'监控:dsh_task 起任务时会自动确保有一个监控窗口在跑(心跳判活,已有宿主绝不重复启动;dsh_health 的 monitorHost 可查),返回值里的 monitor_host 字段会告诉你这次是 already-running / launched / skipped / unavailable。',
].join('\n');

function toolDefinitions() {
	// 模型口径写在策略文件里,这里只把"去哪儿看、怎么落盘"讲清楚(不写死任何模型 id)。
	const policy = readModelPolicy();
	return [
		{
			name: 'dsh_task',
			description: [
				'把一个自包含的任务委派给 DeepSeek Harness(DSH)编码代理,并拿回它的最终报告。',
				'DSH 会在你指定的工作空间里以**独立代理进程**运行:独立上下文窗口、独立工具(文件读写/编辑、shell、联网搜索、子代理)和独立模型(默认模型见下面的【模型选择】)。它真的会动手干活:改文件、跑构建、跑测试。',
				'需要外包子任务、并行调研、或想把中间过程挡在自己上下文之外时,优先用它。',
				'【模型选择:以策略文件为准】可用模型**不写死在这个描述里** —— 先看 dsh_health 的 `models.providers`(这个 DSH 实例已接入的模型,按 provider 分组);"什么时候用哪个模型"的口径写在**用户可编辑的策略文件**里:' + policyRef(policy) + ',里面有「预设方案」(当前:' + (policy.presets.join(' / ') || '(策略文件里还没有预设)') + ')与「模型选择规则」。**首次接入**(策略文件里 `默认模型:` 还是"未指定")按四步走:① 先用 dsh_health 的 models 看清这个实例的已接入模型有哪些;② **请用户指定一个默认模型**(MCP server 不能直接跟用户对话,得由你转达);③ 用 `dsh_setup(default_model: "<model id>")` 或 `dsh_setup(preset: "本项目方案")` 落盘;④ 把策略文件的 `fileUrl` 链接给用户,说明里面的模型选择规则**用户可以自己改**。未指定时,dsh_task / dsh_health 的返回值里会带同一段引导;指定过就不再出现。',
				'⚠️ DSH 只看得见你传的 `prompt`:看不到这段对话、看不到你打开的文件、也看不到之前任何一次 dsh_task。prompt 必须自包含(目标、绝对路径、约束、期望产出);要共享的上下文就在 prompt 里重述一遍。',
				'',
				'【先估时间,再派活】`expected_seconds` 是必填的**硬承诺**,不是"希望的超时":deadlineAt = 本次开始时刻 + expected_seconds × 宽限系数(默认 ' + DEADLINE_GRACE + '),到点直接**杀进程树**,任务以 status="deadline" 结束。经验区间:单文件小改 60~180s;多文件小特性 300~900s;大重构 900~1800s 且**应当拆成多次派**。估不准就拆小,不要拿 1800 赌一把。',
				'【验收条件要可机检】`acceptance` 写"一句话、可判定真伪",例如"`npm test` 全绿且 src/x.ts 里存在 `export function y`"。不要写"做好一点""尽量优化"这种没法判定的话。它会记进 task.json 并原样回显,作为你验收的依据。',
				'【默认就等,超时才轮询】`wait_seconds` 默认 ' + DEFAULT_WAIT_SECONDS + 's(短超时):任务在这段内结束,结果直接返回,你**不需要轮询**。只有返回 status="running"(到点没完)才继续用 dsh_task_status(job_id=..., wait_seconds=' + DEFAULT_STATUS_WAIT_SECONDS + ') 轮询到终态。别传 wait_seconds=0 —— 那是"立刻拿到 job_id 然后自己轮询十几次",每一轮都要你重推一遍上下文;也别把等待调到 60s 以上(多数 harness 的单次工具超时就 60s,会被先掐断)。',
				STATUS_SEMANTICS,
				FAILURE_TRIAGE,
				'【一句话禁止项】① 不要把超过 20 分钟的任务塞进单次 dsh_task —— 拆开派;② permission 收窄成 read-only/workspace-write 时,不要要求子代理用 pwsh 写文件(受限档位下 pwsh 在 Windows 上返回全空),要它写文件就用 write/edit 文件工具。',
			].join('\n'),
			inputSchema: {
				type: 'object',
				properties: {
					prompt: {
						type: 'string',
						description: '给 DSH 代理的自包含任务描述(目标、绝对路径、约束、期望产出、验收方式)。它看不到本次对话与任何历史,缺什么就在 prompt 里补什么。',
					},
					expected_seconds: {
						type: 'integer',
						minimum: 1,
						description: '【必填】你预估这次要花多少秒的正整数。硬承诺:deadlineAt = 开始时刻 + expected_seconds × 宽限系数 ' + DEADLINE_GRACE + ',到点杀进程树并记 status="deadline"。经验值:单文件小改 60~180;多文件小特性 300~900;大重构 900~1800 且应当拆分。缺失/0/小数/字符串会被直接拒收(isError:true)。估不准就拆小,别赌一把。',
					},
					acceptance: {
						type: 'string',
						description: '一句话、可判定真伪的验收标准(≤2000 字符),例如"`npm test` 全绿且 src/x.ts 存在 `export function y`"。会记进 task.json 并原样回显,是验收依据。禁止"做好一点"这类无法判定的表述;超长会被拒收(isError:true)。',
					},
					workspace: {
						type: 'string',
						description: 'DSH 干活的工作空间绝对路径。默认取调用方工作区根(MCP roots)或 server 工作目录。路径不存在会被拒收。',
					},
					wait_seconds: {
						type: 'number',
						description: `本次调用最多阻塞多久等结果。默认 ${DEFAULT_WAIT_SECONDS}(短超时,推荐直接省略):任务在窗口内结束就把结果直接返回给你;到点没结束才返回 status="running" 与 job_id,那时再用 dsh_task_status 轮询。不要传 0(等于放弃等待、把一次调用拆成多次轮询),也不要传 >60(多数 harness 的单次工具超时是 60s,会被先掐断)。`,
					},
					timeout_seconds: {
						type: 'number',
						description: `外层兜底墙钟上限(比 expected_seconds 的硬截止更松,单独计算),默认 ${DEFAULT_TIMEOUT_SECONDS}。只用于"连兜底都失控"的场景;平时用 expected_seconds 表达预估。`,
					},
					model: {
						type: 'string',
						description: '本次运行使用的 DSH 模型 id。**取值以策略文件为准,不在这里写死**:先 dsh_health 的 models.providers 看这个实例已接入哪些模型,再按策略文件里的口径挑(见 ' + policyRef(policy) + ';首次接入选完模型还要用 dsh_setup 落盘默认模型)。省略即沿用 DSH 配置的默认模型。传一个本机没配置的 id **不会回退到默认模型**:DSH 在请求发出前就直接失败(UNKNOWN_MODEL)。',
					},
					provider: {
						type: 'string',
						description: '本次运行使用的模型服务商 id —— 取值必须是你本机 DSH 里**已注册**的 provider(可用 dsh_health 的 models.providers 查)。一般省略,交给 DSH 默认配置。写错的 id **不会回退**:DSH 直接失败(NO_ADAPTER)。',
					},
					reasoning_effort: {
						type: 'string',
						description: '本次运行的推理强度档位,取值以该 provider/model 在 DSH 里**声明的档位**为准(settings.yaml 的 llm-pi-ai.providers.<provider>.models[].reasoningEfforts,常见档位示例:off / minimal / low / medium / high / xhigh / max)。传一个该模型没声明的档位**不会静默降级**:DSH 以 UNSUPPORTED_REASONING_EFFORT 快速失败(约 0.5 秒、不会真的调模型)。一般省略,沿用 DSH 设置里的默认档位。',
					},
					permission: {
						type: 'string',
						enum: ['read-only', 'workspace-write', 'danger-full-access'],
						description: `子代理的文件/命令权限档,默认 "${DEFAULT_PERMISSION}"。要它改文件就必须给 workspace-write 或更高;read-only/workspace-write 档下**不要**让它用 pwsh 写文件(受限档位下 pwsh 在 Windows 上返回全空),写文件请用 write/edit 文件工具。`,
					},
					raw_prompt: {
						type: 'boolean',
						description: 'true 时原样发送 prompt,不加"子代理委派前言"。默认 false(加前言,里面会带上调用方身份与工作空间路径)。',
					},
					label: {
						type: 'string',
						description: '给这次任务起的短标签,只用于任务日志/审计,不影响行为。',
					},
				},
				required: ['prompt', 'expected_seconds'],
			},
		},
		{
			name: 'dsh_task_status',
			description: [
				'查看(并可选等待)某个 dsh_task 任务的状态。**只在 dsh_task 返回 status="running" 之后才需要它**:那时用默认等待(' + DEFAULT_STATUS_WAIT_SECONDS + 's)一轮一轮推到终态即可 —— dsh_task 的短超时窗口内就结束的任务,结果已经直接返回给你了。',
				'返回字段:`status`(ok|running|error|timeout|deadline|stalled|cancelled|killed)、`job_id`、`caller`、`workspace`、`elapsed`、`expected_seconds` 与 `deadline`(剩余秒数)、`acceptance`、`progress_bytes`(stderr+stdout+result 字节数,不动=没有新产出)、`last_progress`(最后一次有新产出的时刻)、`recent_activity`(它最近真实输出的几行 + 工具调用错误)、`process_tree`(存活的后代进程数与整棵树 CPU 时间)、`silent_seconds`、`monitor_host`。',
				'"静默但在干活"不算停滞:长工具调用期间 descendant 进程还在、树 CPU 还在涨,看门狗不会杀它;只有"日志零增长 + 整棵树完全静止"才判 stalled。要给真正耗时的活留余地,请把 expected_seconds 估准,而不是靠等待。',
				'⚠️ 不要拿着 status="running" 发呆:看到 running 就再轮询一次,不要结束回答、不要臆测结果。若发现跑偏了,用 dsh_task_kill 止损。',
				'⚠️ 取消语义:调用方停这一轮(harness 发 notifications/cancelled)会**停掉这次请求对应的任务**。只想看一眼状态、不希望影响任务时,用 wait_seconds=0。',
			].join('\n'),
			inputSchema: {
				type: 'object',
				properties: {
					job_id: { type: 'string', description: 'dsh_task 返回的 job_id。' },
					wait_seconds: { type: 'number', description: `本次最多阻塞多久等它变终态。默认 ${DEFAULT_STATUS_WAIT_SECONDS}(推荐直接省略);传 0 表示只看一眼现状、不等待。` },
				},
				required: ['job_id'],
			},
		},
		{
			name: 'dsh_task_cancel',
			description: '**优雅**停止一个 DSH 任务(按 job_id):标记 cancelled 并请它的进程树自己收尾,留给它写日志/清理的机会。需要进程立刻死、或要一次停掉某个调用方起的全部任务时,用 dsh_task_kill。返回值里有收敛后的终态记录。',
			inputSchema: {
				type: 'object',
				properties: { job_id: { type: 'string', description: 'dsh_task 返回的 job_id。' } },
				required: ['job_id'],
			},
		},
		{
			name: 'dsh_task_kill',
			description: [
				'**强杀** DSH 任务及其整棵进程树(Windows 上用 taskkill /T,不是只杀父进程)。两种模式,二选一:',
				'- `job_id`:停掉这一个任务;',
				'- `caller`:停掉该调用方起的全部运行中任务("把我起的都停掉";caller 名来自本 MCP 连接的 clientInfo,可用 dsh_health 的 thisCaller 确认)。',
				'返回值列出真的杀了哪些、哪些已经结束。这是硬止损手段;dsh_task_cancel 才是优雅请求。什么时候用:任务明显跑偏(反复改错文件)、deadline 快到了但没进展、或你判断"再等也没意义"。',
			].join('\n'),
			inputSchema: {
				type: 'object',
				properties: {
					job_id: { type: 'string', description: 'dsh_task 返回的 job_id。与 caller 二选一。' },
					caller: { type: 'string', description: '调用方名(如 "cursor-vscode"、"claude-code"),杀掉该 caller 的全部运行中任务。与 job_id 二选一。' },
					reason: { type: 'string', description: '可选的短原因,会记在被杀任务上,便于事后复盘。' },
				},
			},
		},
		{
			name: 'dsh_setup',
			description: [
				'首次接入用:把用户选定的**默认模型**落盘到桥接层自带的策略文件(选择模型的口径也写在那个文件里,用户可随时手改、桥接层每次调用都重读)。',
				'**只改**策略文件里 `默认模型:` 那一行 —— 文件其余内容与用户自己的改动**一律保留**;只有 `policy_markdown` 才整体替换正文。',
				'三种用法:① `default_model: "<模型 id>"`(必须是这个 DSH 实例已接入的模型,裸 id 或 "provider/id" 都行,取值见 dsh_health 的 models.providers;写错会被拒绝并列出可用清单);② `preset: "本项目方案"`(用策略文件里某个预设声明的默认模型);③ `policy_markdown: "…"`(整体替换策略文件正文,里面必须保留一行 `默认模型:`)。',
				`返回值里有落盘后的 policy.path / policy.fileUrl / policy.defaultModel —— **把 fileUrl 给用户**,说明里面的模型选择规则用户可以自己改。策略文件默认位置:${policyRef(policy)}。`,
				'MCP server 不能直接跟用户对话:先按 dsh_task / dsh_health 返回值里的「首次接入」引导去问用户,再用本工具落盘。',
			].join('\n'),
			inputSchema: {
				type: 'object',
				properties: {
					default_model: { type: 'string', description: '要落盘的默认模型:必须是 dsh_health 的 models.providers 里**已接入**的模型,裸 id(如 "deepseek-v4.1-flash")或 "provider/id" 都行。传一个没接入的 id 会被拒绝(isError:true)并列出可用模型清单,调用方据此重新问用户。' },
					preset: { type: 'string', description: '策略文件「## 预设方案」里的预设名(如 "本项目方案"):用该小节里 `预设默认模型:` 声明的模型落盘。名字不存在会被拒绝并列出可用预设。' },
					policy_markdown: { type: 'string', description: '**整体替换策略文件正文**(谨慎:用户自己的改动会被覆盖)。必须保留一行机器可读的 `默认模型: <模型 id>`,否则拒收。' },
				},
			},
		},
		{
			name: 'dsh_health',
			description: [
				'检查 DSH 子代理桥接是否装好、能不能用。返回:`launcher`(解析到的 dsh 启动方式)、`dshHome`、默认工作空间/模型、默认等待口径(`defaultWaitSeconds`/`statusWaitSeconds`/`waitModel`)、按调用方的并发分组(`activeByCaller`,如 "cursor-vscode: 2 running")、`thisCaller`(本连接的身份)、`liveTasks`(每个运行中任务的 job_id/caller/workspace/status/expectedSeconds/deadlineAt/剩余秒数/progressBytes/lastProgressAt/stalledProbes/silenceSeconds/cpuTimeMs/descendants/callerVersion)、`recentTasks`(最近几笔,含终态)、看门狗阈值(`watchdogIntervalSeconds`/`watchdogStallProbes`/`watchdogStallMinSeconds`/`watchdogCpuThresholdMs`/`watchdogCpuWorkFloorMs`)、以及 `monitorHost`。',
				'`monitorHost` = 监控窗口自动拉起的状态:{ running(有没有带监控的宿主在跑,由心跳文件判活)、heartbeatAt、pid、activeTasks、autostart(总开关)、lastLaunch:{action,at,exe,ok} }。action 取值 already-running(已有宿主,绝不会再拉一个)/ launched(心跳缺失或过期,已 best-effort 拉起 GUI)/ skipped(冷却中、总开关关闭,或已有宿主进程只是没写心跳)/ unavailable(找不到 DSH Desktop 可执行文件)/ unknown(本进程还没做过拉起判断,例如你只调过 dsh_task_status —— 那个接口是只读的,不会触发拉起)。',
				'模型相关两段:`models` = 这个 DSH 实例**已接入**的模型(取自 $DSH_HOME/settings.yaml 的 models 数组,按 provider 分组;含 `defaultModel` 与枚举失败时的 `error`)、`modelPolicy` = 用户可编辑的**模型策略文件**(`path` / `fileUrl` 链接 / `defaultModel` / `presets`)。策略文件里还没指定默认模型时,输出末尾会带一段紧凑的「首次接入」引导(先看清已接入模型 → 请用户指定一个默认模型 → 用 `dsh_setup` 落盘 → 把策略文件链接给用户)。',
				'什么时候用:① 开局自检("这个 harness 到底连上没有");② 派活前先看 `models` 挑模型;③ 任务好像没动,先看 liveTasks 的 progressBytes/silenceSeconds;④ 想确认自己起的任务有哪些,再决定 kill 谁。',
			].join('\n'),
			inputSchema: { type: 'object', properties: {} },
		},
	];
}

/** 一次 MCP 会话的服务器实现。 */
export class McpServer {
	constructor({ input, output, clientInfo }) {
		this.input = input;
		this.output = output;
		this.clientInfo = clientInfo ?? {};
		this.buffer = '';
		this.pending = new Map();
		this.nextId = 0;
		this.roots = [];
		this.initialized = false;
		// 本连接"关心"过的任务:requestId → job_id,以及本连接发起/观察过的全部 job_id。
		// 用途只有一个 —— 调用方停了这一轮(取消通知 / 连接断开 / 进程被杀)时,把**它自己的**
		// 那些 DSH 子进程一起停掉,别让它们在后台继续烧 token。
		this.ties = new Map();
		this.jobs = new Set();
	}

	/** 记下"这次请求正在等哪个任务",取消通知到来时才能准确停到它。 */
	tieJob(requestId, jobId) {
		if (typeof jobId !== 'string' || jobId === '') return;
		this.jobs.add(jobId);
		if (requestId !== undefined && requestId !== null) this.ties.set(String(requestId), jobId);
	}

	/** 请求结束:解除绑定(任务本身继续跑)。 */
	untieRequest(requestId) {
		if (requestId === undefined || requestId === null) return;
		this.ties.delete(String(requestId));
	}

	/** 本连接发起/观察过、此刻仍在运行的任务。 */
	liveOwnedJobs() {
		let live;
		try {
			live = new Set(liveTaskInfos().map((task) => task.id));
		} catch {
			return [];
		}
		return [...this.jobs].filter((id) => live.has(id));
	}

	/** 停掉本连接名下的运行中任务;返回真的停掉的那些。 */
	cancelOwnedJobs(why) {
		const stopped = [];
		for (const id of this.liveOwnedJobs()) {
			try {
				cancelTask(id);
				stopped.push(id);
			} catch {
				/* 单个取消失败不影响其它 */
			}
		}
		if (stopped.length > 0) debugNote(`已停止本连接名下 ${stopped.length} 个任务(${why}): ${stopped.join(', ')}`);
		return stopped;
	}

	/** 启动:绑定 stdin 读取与进程退出。 */
	start() {
		this.input.setEncoding('utf8');
		this.input.on('data', (chunk) => this.onData(chunk));
		this.input.on('end', () => this.shutdown('客户端关闭了输入流'));
		this.input.on('error', () => this.shutdown('客户端连接出错'));
		// close 兜底:部分 host 用 destroy 收连接,只会触发 close 不会触发 end。
		this.input.on('close', () => this.shutdown('客户端连接已关闭'));
	}

	/**
	 * 连接结束。**先把本连接名下的 DSH 子进程停掉再退出** ——
	 * 否则 harness 关掉 MCP 连接(或杀掉本进程)之后,那些 dsh 实例会变成孤儿继续跑。
	 * @param why - 结束原因(只进调试日志)。
	 */
	shutdown(why = '连接结束') {
		if (this.shuttingDown === true) return;
		this.shuttingDown = true;
		let stopped = [];
		try {
			stopped = this.cancelOwnedJobs(why);
		} catch {
			/* 收尾阶段不允许再抛 */
		}
		lifecycleNote(`shutdown: ${why}${stopped.length === 0 ? '' : `(已停 ${stopped.length} 个运行中任务)`}`);
		for (const { reject } of this.pending.values()) reject(new Error('client disconnected'));
		this.pending.clear();
		process.exitCode = 0;
		setTimeout(() => process.exit(0), 20).unref?.();
	}

	/** 写一个协议帧。 */
	write(message) {
		this.output.write(`${JSON.stringify(message)}\n`);
	}

	/** 回一个成功响应。 */
	respond(id, result) {
		this.write({ jsonrpc: '2.0', id, result });
	}

	/** 回一个错误响应。 */
	respondError(id, code, message) {
		this.write({ jsonrpc: '2.0', id, error: { code, message } });
	}

	/** 发一个通知。 */
	notify(method, params) {
		this.write(params === undefined ? { jsonrpc: '2.0', method } : { jsonrpc: '2.0', method, params });
	}

	/** 向客户端发请求(目前只用于 roots/list)。 */
	request(method, params, timeoutMs = 3000) {
		const id = `srv_${this.nextId++}`;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`${method} 超时`));
			}, timeoutMs);
			timer.unref?.();
			this.pending.set(id, {
				resolve: (value) => {
					clearTimeout(timer);
					resolve(value);
				},
				reject: (error) => {
					clearTimeout(timer);
					reject(error);
				},
			});
			this.write({ jsonrpc: '2.0', id, method, params });
		});
	}

	onData(chunk) {
		this.buffer += chunk;
		for (;;) {
			const newline = this.buffer.indexOf('\n');
			if (newline < 0) break;
			const line = this.buffer.slice(0, newline).trim();
			this.buffer = this.buffer.slice(newline + 1);
			if (line === '') continue;
			let frame;
			try {
				frame = JSON.parse(line);
			} catch {
				continue;
			}
			this.onFrame(frame);
		}
	}

	onFrame(frame) {
		if (frame === null || typeof frame !== 'object') return;
		const { id, method, params, result, error } = frame;
		if (typeof method === 'string' && (typeof id === 'string' || typeof id === 'number')) {
			// 请求:异步处理,避免长任务阻塞后续帧(如取消通知)。
			this.handleRequest(id, method, params ?? {}).catch((failure) => {
				this.respondError(id, -32603, failure instanceof Error ? failure.message : String(failure));
			});
			return;
		}
		if (typeof method === 'string') {
			this.handleNotification(method, params ?? {});
			return;
		}
		if (typeof id === 'string' || typeof id === 'number') {
			const waiter = this.pending.get(id);
			if (waiter === undefined) return;
			this.pending.delete(id);
			if (error !== undefined && error !== null) waiter.reject(new Error(String(error?.message ?? 'error')));
			else waiter.resolve(result);
		}
	}

	handleNotification(method, params) {
		if (method === 'notifications/initialized') {
			this.initialized = true;
			this.refreshRoots().catch(() => {});
			return;
		}
		if (method === 'notifications/cancelled') {
			// 调用方取消了某次工具调用 —— 在 harness 里按"停止本轮"就是这个通知。
			// 旧行为是**直接忽略**(注释写着"留给任务自己按 timeout 收尾"):后果是调用方那边
			// 已经停了,我们这边的 dsh 实例还在后台继续跑、继续烧 token,而且它写出的文件
			// 会突然出现在工作区里,看起来像"幽灵改动"。所以必须真的停:
			//   ① 能对应到具体请求 ⇒ 停那个任务(精确,不误伤别的任务);
			//   ② 对不上(取消晚到了、请求已返回)⇒ 只在本连接**恰好一个**在跑的任务时停它。
			//      本连接 ≈ 这个 harness 窗口,别的窗口/别的会话是别的连接,不会被牵连。
			const requestId = params?.requestId;
			const tied = requestId === undefined || requestId === null ? undefined : this.ties.get(String(requestId));
			this.untieRequest(requestId);
			if (typeof tied === 'string') {
				try {
					cancelTask(tied);
					debugNote(`调用方取消请求 ${String(requestId)}:已停止 job ${tied}`);
				} catch {
					/* 已经结束就什么都不用做 */
				}
				return;
			}
			const owned = this.liveOwnedJobs();
			if (owned.length === 1) this.cancelOwnedJobs('调用方取消了请求,本连接只有一个在跑的任务');
		}
	}

	/**
	 * 本次连接的调用方身份(来自 initialize 的 clientInfo)。
	 * 缺失时用 "unknown"(显式区分于 CLI 的 "cli")。
	 * @returns {{caller:string, callerVersion:string|null}}
	 */
	callerIdentity() {
		const info = this.clientInfo?.clientInfo;
		const rawName = typeof info?.name === 'string' ? info.name.trim() : '';
		const rawVersion = typeof info?.version === 'string' ? info.version.trim() : '';
		return {
			caller: rawName === '' ? 'unknown' : rawName,
			callerVersion: rawVersion === '' ? null : rawVersion,
		};
	}

	/** 拉取客户端工作空间根(MCP roots),失败则退回进程 cwd。 */
	async refreshRoots() {
		const capabilities = this.clientInfo.capabilities ?? {};
		if (capabilities.roots === undefined) return;
		try {
			const result = await this.request('roots/list', {}, 3000);
			const roots = Array.isArray(result?.roots) ? result.roots : [];
			this.roots = roots
				.map((root) => (typeof root?.uri === 'string' ? root.uri : ''))
				.filter((uri) => uri.startsWith('file://'))
				.map((uri) => {
					try {
						return decodeURIComponent(new URL(uri).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
					} catch {
						return '';
					}
				})
				.filter((path) => path !== '');
		} catch {
			/* 客户端不支持或不响应 roots/list:忽略 */
		}
	}

	/** 该用哪个工作空间:工具参数 > 客户端 roots > 环境变量/cwd。 */
	chooseWorkspace(explicit) {
		if (typeof explicit === 'string' && explicit.trim() !== '') return explicit.trim();
		if (this.roots.length > 0) return this.roots[0];
		return defaultWorkspace();
	}

	async handleRequest(id, method, params) {
		switch (method) {
			case 'initialize': {
				const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
				const protocolVersion = SUPPORTED_PROTOCOLS.includes(requested) ? requested : SUPPORTED_PROTOCOLS[0];
				this.clientInfo = params;
				this.respond(id, {
					protocolVersion,
					capabilities: { tools: { listChanged: false } },
					serverInfo: { name: 'dsh-subagent', version: SERVER_VERSION, title: 'DeepSeek Harness subagent bridge' },
					instructions: DELEGATION_INSTRUCTIONS,
				});
				return;
			}
			case 'ping':
				this.respond(id, {});
				return;
			case 'tools/list':
				this.respond(id, { tools: toolDefinitions() });
				return;
			case 'resources/list':
				this.respond(id, { resources: [] });
				return;
			case 'resources/templates/list':
				this.respond(id, { resourceTemplates: [] });
				return;
			case 'prompts/list':
				this.respond(id, { prompts: [] });
				return;
			case 'logging/setLevel':
				this.respond(id, {});
				return;
			case 'tools/call': {
				const name = typeof params.name === 'string' ? params.name : '';
				const args = params.arguments !== null && typeof params.arguments === 'object' ? params.arguments : {};
				// 把请求 id 一路带进工具实现:只有它能把"调用方取消的请求"对应到具体任务上。
				try {
					const result = await this.callTool(name, args, id);
					this.respond(id, result);
				} finally {
					this.untieRequest(id);
				}
				return;
			}
			default:
				this.respondError(id, -32601, `method not found: ${method}`);
		}
	}

	/** 渲染一个工具结果。 */
	text(value, isError = false) {
		return { content: [{ type: 'text', text: value }], isError };
	}

	/** 参数校验失败的统一出口:必须是 isError:true,调用方才会当成"这次调用不成立"。 */
	fail(message) {
		return this.text(message, true);
	}

	/**
	 * 工具方法的返回值既可能是纯文本,也可能已经是完整工具结果(例如 `fail()` 造的 isError:true)。
	 * 已经是完整结果时**必须原样返回**:再包一层会把 isError 吃掉(踩过:拒绝信息变成
	 * `[object Object]` 且 isError=false,强制校验形同虚设)。
	 */
	wrap(value) {
		if (value !== null && typeof value === 'object' && Array.isArray(value.content)) return value;
		return this.text(value);
	}

	/** 执行工具调用。 */
	async callTool(name, args, requestId) {
		try {
			switch (name) {
				case 'dsh_health':
					return this.wrap(this.healthText());
				case 'dsh_setup':
					return this.wrap(this.setupText(args));
				case 'dsh_task':
					return this.wrap(await this.runTask(args, requestId));
				case 'dsh_task_status':
					return this.wrap(await this.statusText(args, requestId));
				case 'dsh_task_cancel':
					return this.wrap(JSON.stringify(cancelTask(String(args.job_id ?? '')), null, 2));
				case 'dsh_task_kill':
					return this.wrap(await this.killText(args));
				default:
					return this.text(`未知工具: ${name}`, true);
			}
		} catch (error) {
			return this.text(`DSH 桥接调用失败: ${error instanceof Error ? error.message : String(error)}`, true);
		}
	}

	/** dsh_health 的文本。 */
	healthText() {
		let launcher;
		let launcherError = null;
		try {
			launcher = resolveLauncher();
		} catch (error) {
			launcherError = error instanceof Error ? error.message : String(error);
		}
		const identity = this.callerIdentity();
		const policy = readModelPolicy();
		const recent = listTasks(5).map((task) => ({
			job_id: task.id,
			caller: task.caller ?? 'unknown',
			status: task.status,
			workspace: task.workspace,
			startedAt: task.startedAt,
			durationMs: task.durationMs,
			sessionId: task.sessionId,
			model: task.modelUsed ?? task.model,
		}));
		// 实时任务:调用方要能一眼看清"谁在跑、跑到哪、还有多久、卡没卡"。
		const live = liveTaskInfos();
		const byCaller = callerStats();
		const maxConcurrency = Number(process.env.DSH_SUBAGENT_MAX_CONCURRENCY ?? 4);
		const payload = {
			ok: launcherError === null,
			bridgeVersion: SERVER_VERSION,
			bridgeRoot: BRIDGE_ROOT,
			dshHome: dshHome(),
			launcher: launcherError ?? launcher.describe,
			shim: launcher?.shim ?? null,
			defaultWorkspace: this.chooseWorkspace(undefined),
			clientRoots: this.roots,
			defaultModel: readDefaultModel(),
			// 这个实例**已接入**的模型(枚举失败时 error 里说明原因,不是崩)与用户可编辑的模型策略文件
			models: readModels(),
			modelPolicy: {
				path: policy.path,
				fileUrl: policy.fileUrl,
				defaultModel: policy.defaultModel,
				presets: policy.presets,
			},
			defaultPermission: DEFAULT_PERMISSION,
			defaultTimeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
			defaultWaitSeconds: DEFAULT_WAIT_SECONDS,
			statusWaitSeconds: DEFAULT_STATUS_WAIT_SECONDS,
			waitModel: 'dsh_task 先自己等 ' + DEFAULT_WAIT_SECONDS + 's(短超时),窗口内结束就直接返回结果;到点没结束才返回 status="running",那时用 dsh_task_status 每次等 ' + DEFAULT_STATUS_WAIT_SECONDS + 's 轮询到终态(两个值都可经 DSH_SUBAGENT_WAIT_SECONDS / DSH_SUBAGENT_STATUS_WAIT_SECONDS 调整,但不要超过调用方 harness 的单次工具超时)',
			deadlineGrace: DEADLINE_GRACE,
			watchdogIntervalSeconds: DEFAULT_WATCHDOG_INTERVAL_SECONDS,
			watchdogStallProbes: STALL_PROBES,
			watchdogStallMinSeconds: STALL_MIN_SECONDS,
			watchdogCpuThresholdMs: STALL_CPU_MS,
			watchdogCpuWorkFloorMs: STALL_CPU_WORK_FLOOR_MS,
			// 监控宿主:心跳来自 monitor/observer.mjs;"有没有宿主在跑"由心跳 + 宿主进程共同判断。
			monitorHost: monitorHostStatus(),
			thisCaller: identity.caller,
			thisCallerVersion: identity.callerVersion,
			maxConcurrency,
			activeTasks: live.length,
			activeByCaller: byCaller.map((entry) => `${entry.caller}: ${entry.running} running`),
			callers: byCaller,
			liveTasks: live,
			recentTasks: recent,
			taskStateDir: join(dshHome(), 'subagent', 'state', 'tasks'),
		};
		return [
			payload.ok ? 'DSH subagent 桥接已就绪。' : 'DSH subagent 桥接不可用。',
			'```json',
			JSON.stringify(payload, null, 2),
			'```',
			// 策略文件里还没指定默认模型时,把"请用户指定 + 怎么落盘 + 口径文件在哪"讲给调用方:
			// MCP server 自己不能跟用户对话,只能靠调用方 agent 转达。
			setupBlock(policy),
		].filter((line) => line !== null).join('\n');
	}

	/**
	 * dsh_setup:把调用方转达的用户选择落盘到**用户可编辑的模型策略文件**。
	 *
	 * 落盘 = 只改写 `默认模型:` 那一行,文件其余内容与用户自己的改动一律保留
	 * (整体替换正文是另一条路径:`policy_markdown`,所以那边必须保留那行机器可读的声明)。
	 * 三种用法都要求模型**确实已接入**(取值见 dsh_health 的 models),写错就响亮拒绝并列出可用清单。
	 */
	setupText(args) {
		// 类型不对就点名参数(照 optionalOverrides 的既有做法:响亮失败,不静默忽略)
		for (const name of ['default_model', 'preset', 'policy_markdown']) {
			const raw = args[name];
			if (raw === undefined || raw === null) continue;
			if (typeof raw !== 'string') {
				return this.fail(`${name} 必须是字符串(收到 ${JSON.stringify(raw)}):它只在有值时覆盖策略文件,类型不对会被直接拒收,而不是静默忽略。`);
			}
		}
		const models = readModels();
		if (models.error !== null) {
			return this.fail(`枚举不到这个 DSH 实例已接入的模型,无法校验与落盘默认模型:${models.error}。请先修好 $DSH_HOME/settings.yaml,或直接手改策略文件里的 \`默认模型:\` 那一行。`);
		}
		let policy = readModelPolicy();
		const wantedModel = typeof args.default_model === 'string' ? args.default_model.trim() : '';
		const wantedPreset = typeof args.preset === 'string' ? args.preset.trim() : '';
		const markdown = typeof args.policy_markdown === 'string' ? args.policy_markdown : '';
		if (wantedModel === '' && wantedPreset === '' && markdown.trim() === '') {
			return this.fail(`dsh_setup 需要三个参数之一:default_model(已接入的模型,裸 id 或 "provider/id")、preset(策略文件里已有的预设名,如 "${policy.presets[0] ?? '本项目方案'}")、policy_markdown(整体替换策略文件正文)。可用模型见 dsh_health 的 models.providers;策略文件:${policyRef(policy)}`);
		}
		// ① policy_markdown:整体替换正文(谨慎路径)—— 替换后仍要能读出 `默认模型:` 行
		if (markdown.trim() !== '') {
			const declared = /^默认模型:[ \t]*(.*)$/m.exec(markdown);
			if (declared === null) {
				return this.fail('policy_markdown 必须保留一行机器可读的 `默认模型: <模型 id>` —— 桥接层按行读取它,整体替换正文时别忘了这一行。');
			}
			const value = policyModelValue(declared[1]);
			if (value !== null && matchInstalledModel(models, value) === null) return this.fail(unknownModelMessage(models, value));
			writeText(policy.path, markdown.endsWith('\n') ? markdown : `${markdown}\n`);
			policy = readModelPolicy();
		}
		// ② 选模型:default_model 优先,否则用 preset 里声明的 `预设默认模型:`
		let model = null;
		if (wantedModel !== '') {
			const matched = matchInstalledModel(models, wantedModel);
			if (matched === null) return this.fail(unknownModelMessage(models, wantedModel));
			model = matched.model;
		} else if (wantedPreset !== '') {
			if (!policy.presets.includes(wantedPreset)) {
				const known = policy.presets.length === 0 ? '(策略文件里一个预设都没有)' : policy.presets.join(' / ');
				return this.fail(`preset "${wantedPreset}" 不在策略文件里。可用预设:${known} —— 在 ${policyRef(policy)} 的「## 预设方案」下用 \`### <名字>\` 加一个,并在小节里写一行 \`预设默认模型: <模型 id>\`。`);
			}
			const presetModel = policy.presetModels[wantedPreset] ?? null;
			if (presetModel === null) {
				return this.fail(`预设「${wantedPreset}」里没写 \`预设默认模型: <模型 id>\`,没法落盘 —— 补上那一行再试(见 ${policyRef(policy)})。`);
			}
			const matched = matchInstalledModel(models, presetModel);
			if (matched === null) {
				return this.fail(`预设「${wantedPreset}」声明的是 "${presetModel}",但它不在这个实例已接入的模型里。${unknownModelMessage(models, presetModel)}`);
			}
			model = matched.model;
		}
		// ③ 落盘:只换 `默认模型:` 那一行;用户手写的其它内容(含正文改动)保持原样
		if (model !== null) {
			const line = `默认模型: ${model}`;
			const text = policy.text;
			const next = /^默认模型:.*$/m.test(text) ? text.replace(/^默认模型:.*$/m, line) : `${line}\n\n${text}`;
			if (next !== text) writeText(policy.path, next);
			policy = readModelPolicy();
		}
		return JSON.stringify({
			ok: true,
			policy: { path: policy.path, fileUrl: policy.fileUrl, defaultModel: policy.defaultModel },
			models,
			hint: '默认模型已落盘到策略文件。后续派活按文件里的口径挑模型;请把 fileUrl 给用户 —— 里面的模型选择规则用户可以自己改(桥接层每次调用都重读)。',
		}, null, 2);
	}

	/** 组装 dsh_task 的返回值。 */
	async runTask(args, requestId) {
		const prompt = typeof args.prompt === 'string' ? args.prompt : '';
		// 下面这些"拒绝"必须用 isError:true 的**工具结果**返回,而不是 isError:false 的说明文本:
		// isError:false 会被调用方当成正常结果继续走下去,就起不到"强制先预估、先定验收"的作用。
		if (prompt.trim() === '') return this.fail('prompt 不能为空。');
		// expected_seconds 必填:逼调用方先想清楚"这件事要多久",并据此形成硬截止。
		const expectedSeconds = Number(args.expected_seconds);
		if (args.expected_seconds === undefined || args.expected_seconds === null || args.expected_seconds === '') {
			return this.fail('缺少必填参数 expected_seconds:请先预估这次委派需要多少秒(正整数),例如 expected_seconds=180。它会被用作硬截止时间(秒数 × 宽限系数 ' + DEADLINE_GRACE + '),超时即杀进程树并记为 status="deadline"。');
		}
		if (!Number.isInteger(expectedSeconds) || expectedSeconds <= 0) {
			return this.fail(`expected_seconds 必须是正整数(收到 ${JSON.stringify(args.expected_seconds)}):请填入你预估的秒数,例如 180。不接受 0、小数、字符串或负数。`);
		}
		if (typeof args.acceptance === 'string' && args.acceptance.length > 2000) {
			return this.fail('acceptance 过长(上限 2000 字符):请压缩成一句可判定的验收标准。');
		}
		// 可选覆盖参数(model / provider / reasoning_effort):类型不对就响亮拒绝(旧行为是静默忽略),
		// 空串/纯空白视为未提供。取值来源与失败语义写在各字段描述里。
		const overrides = optionalOverrides(args, ['model', 'provider', 'reasoning_effort']);
		if (overrides.error !== undefined) return this.fail(overrides.error);
		const model = overrides.values.model;
		const provider = overrides.values.provider;
		const reasoningEffort = overrides.values.reasoning_effort;
		const workspace = resolveWorkspace(this.chooseWorkspace(args.workspace));
		const waitSeconds = Number.isFinite(Number(args.wait_seconds)) ? Number(args.wait_seconds) : DEFAULT_WAIT_SECONDS;
		const identity = this.callerIdentity();
		const preamble = delegationPreamble({ client: identity.caller === 'unknown' ? '' : identity.caller, workspace, raw: args.raw_prompt === true });
		const effectivePrompt = preamble === '' ? prompt : `${preamble}${prompt}`;

		const started = await startTask({
			prompt: effectivePrompt,
			workspace,
			permission: args.permission,
			model,
			provider,
			reasoningEffort,
			timeoutSeconds: args.timeout_seconds,
			expectedSeconds,
			acceptance: args.acceptance,
			caller: identity.caller,
			callerVersion: identity.callerVersion,
			label: args.label,
		});

		// 子进程已经 spawn 了:顺手确认"有没有带监控的宿主在跑",没有就 best-effort 拉起一个,
		// 让"其它 harness 调 dsh_task"本身就能激活监控窗口(即使 DSH UI 压根没开)。
		// 这是**非阻塞**动作:不 await GUI 起来、失败也不影响任务,只把结果写进日志与返回值。
		const monitor = ensureMonitorHost({ reason: `dsh_task ${started.id}` });

		// 绑定"这次请求 ↔ 这个任务":调用方中途取消这一轮时,才能准确停到它(见 handleNotification)。
		this.tieJob(requestId, started.id);
		const state = await waitForTask(started.id, Math.max(0, waitSeconds) * 1000);
		return this.renderTask(state, { waitedSeconds: Math.max(0, waitSeconds), kind: 'dsh_task', monitorHost: monitor });
	}

	/** 组装 dsh_task_status 的返回值。 */
	async statusText(args, requestId) {
		const id = String(args.job_id ?? '');
		if (id === '') return this.fail('job_id 不能为空。');
		const waitSeconds = Number.isFinite(Number(args.wait_seconds)) ? Number(args.wait_seconds) : DEFAULT_STATUS_WAIT_SECONDS;
		// 轮询请求也要绑定:调用方按"停止"时,正在等的往往正是这类请求。
		this.tieJob(requestId, id);
		const state = await waitForTask(id, Math.max(0, waitSeconds) * 1000);
		// 轮询**不**触发拉起(避免看一眼状态就冒出个 GUI);只回报现状。
		return this.renderTask(state, {
			waitedSeconds: Math.max(0, waitSeconds),
			kind: 'dsh_task_status',
			monitorHost: { action: peekMonitorHostAction(), reason: '只读检查' },
		});
	}

	/** 组装 dsh_task_kill 的返回值:按 job_id 或按 caller 强杀。 */
	async killText(args) {
		const jobId = typeof args.job_id === 'string' ? args.job_id.trim() : '';
		const caller = typeof args.caller === 'string' ? args.caller.trim() : '';
		const mine = this.callerIdentity().caller;
		if (jobId === '' && caller === '') {
			return this.fail(`dsh_task_kill 需要 job_id 或 caller(本连接的 caller 是 "${mine}")。job_id 杀单个任务;caller 停掉该调用方发起的全部运行中任务。`);
		}
		if (jobId !== '' && caller !== '') {
			return this.fail('dsh_task_kill 一次只接受一种模式:要么 job_id,要么 caller(不要同时传)。');
		}
		const reason = typeof args.reason === 'string' && args.reason.trim() !== '' ? args.reason.trim() : '调用方要求强制终止';
		if (jobId !== '') return JSON.stringify(killTask(jobId, reason), null, 2);
		const outcome = killByCaller(caller, reason);
		const staleNote = outcome.stale.length === 0
			? ''
			: `另清理了 ${outcome.stale.length} 条**幽灵记录**(台账写着在跑、pid 早已消失,已判为 lost,不会计入"你还挂着几个任务"):${outcome.stale.map((item) => item.job_id).join(', ')}。`;
		const summary = outcome.notFound
			? `没有找到 caller="${caller}" 的运行中任务(可能已结束,或该 caller 从未发起过任务)。`
			: `已强杀 caller="${caller}" 的 ${outcome.killed.length} 个运行中任务。`;
		return `${summary}${staleNote === '' ? '' : `\n${staleNote}`}\n${JSON.stringify({ ...outcome, this_caller: mine, hint: '若只想停掉自己起的任务,caller 传本连接的 caller 名;stale 数组里的记录进程早已不存在,无需再管。' }, null, 2)}`;
	}

	/**
	 * 把任务状态渲染成给模型看的文本。
	 *
	 * 首次派活(`dsh_task`)的返回值末尾会挂「首次接入」引导块(策略文件还没指定默认模型时);
	 * 轮询(`dsh_task_status`)不重复刷屏 —— 调用方第一次派活时已经看到过了。
	 */
	renderTask(state, options) {
		const body = this.renderTaskBody(state, options);
		if (options.kind !== 'dsh_task') return body;
		const setup = setupBlock(readModelPolicy());
		return setup === null ? body : `${body}\n\n${setup}`;
	}

	/** 渲染任务状态正文(不含首次接入引导)。 */
	renderTaskBody(state, { waitedSeconds, kind, monitorHost }) {
		const deadlineLine = state.deadlineAt === null || state.deadlineAt === undefined
			? null
			: `deadline: ${state.deadlineAt}${state.remainingSeconds === null || state.remainingSeconds === undefined ? '' : `(剩余 ${state.remainingSeconds}s)`}`;
		const monitorLine = monitorHost === undefined || monitorHost === null
			? null
			: `monitor_host: ${monitorHost.action}${monitorHost.reason === undefined || monitorHost.reason === '' ? '' : `(${monitorHost.reason})`}`;
		const header = [
			`status: ${state.status}`,
			`job_id: ${state.id}`,
			`caller: ${state.caller ?? 'unknown'}${state.callerVersion === null || state.callerVersion === undefined ? '' : ` (${state.callerVersion})`}`,
			`workspace: ${state.workspace}`,
			`elapsed: ${(((state.durationMs ?? 0) / 1000) || 0).toFixed(1)}s`,
			state.expectedSeconds === null || state.expectedSeconds === undefined ? null : `expected_seconds: ${state.expectedSeconds}(硬截止 = 预估 × grace ${state.deadlineGrace ?? DEADLINE_GRACE})`,
			deadlineLine,
			state.acceptance === null || state.acceptance === undefined ? null : `acceptance: ${state.acceptance}`,
			state.sessionId === null || state.sessionId === undefined ? null : `dsh_session: ${state.sessionId}`,
			state.modelUsed === null || state.modelUsed === undefined ? null : `model: ${state.modelUsed}`,
			state.reasoningEffort === null || state.reasoningEffort === undefined ? null : `reasoning_effort: ${state.reasoningEffort}`,
			state.permission === null || state.permission === undefined ? null : `permission: ${state.permission}`,
			state.exitCode === null || state.exitCode === undefined ? null : `exit_code: ${state.exitCode}`,
			monitorLine,
		].filter((line) => line !== null).join('\n');

		if (state.status === 'running') {
			const activity = recentActivity(state.taskDir);
			// 调用方每次轮询都是一次真实观测:用现场字节数刷新 last_progress,
			// 免得刚起步、看门狗还没探测的任务一直显示 0 字节。
			const observed = observeProgress(state.taskDir, activity.progress_bytes);
			const feed = activity.stderr_lines.length === 0
				? [`(还没有输出: ${activity.note ?? '等待子进程产生日志'})`]
				: activity.stderr_lines.map((line) => `  ${line}`);
			return [
				`[DSH 任务运行中] ${kind}`,
				header,
				`progress_bytes: ${observed.progressBytes}(stderr+stdout+result 字节数;不动 = 没有新产出)`,
				observed.lastProgressAt === null ? null : `last_progress: ${observed.lastProgressAt}(最后有新增产出的时刻)`,
				// 静默的长工具调用属于**正常**情况:看门狗同时看进程树,不做误杀。
				state.treeSummary === null || state.treeSummary === undefined ? null : `process_tree: ${state.treeSummary}`,
				state.silenceSeconds === null || state.silenceSeconds === undefined ? null : `silent_seconds: ${state.silenceSeconds}(静默不等于卡死:只要进程树里还有后代进程或 CPU 在涨,看门狗就认为它在干活)`,
				'',
				'--- recent_activity(stderr 末尾 / 实时) ---',
				...feed,
				activity.stdout_tail === '' ? null : '--- stdout 末尾 ---',
				activity.stdout_tail === '' ? null : activity.stdout_tail,
				'',
				`提示词已交给 DSH 子代理执行,但这次调用已经等满 ${waitedSeconds}s(短超时),任务还没结束。`,
				`从现在起才需要轮询:dsh_task_status(job_id="${state.id}", wait_seconds=${DEFAULT_STATUS_WAIT_SECONDS}) 每次等 ${DEFAULT_STATUS_WAIT_SECONDS}s,一轮一轮推到终态(ok / error / deadline / stalled / cancelled / killed)。不要在此刻结束回答,也不要臆测结果。`,
				state.remainingSeconds === null || state.remainingSeconds === undefined ? null : `距离硬截止还有 ${state.remainingSeconds}s;若任务明显做不完,可以提前 dsh_task_kill(job_id="${state.id}") 换一个更小的任务。`,
				'',
				`(任务目录: ${state.taskDir} —— prompt.md / result.txt / stderr.log 实时落盘)`,
			].filter((line) => line !== null).join('\n');
		}

		if (state.status === 'ok') {
			const body = clip(state.result ?? '', RESULT_CLIP);
			return [
				'[DSH 任务完成]',
				header,
				'',
				'--- DSH 子代理的最终答复 ---',
				body === '' ? '(DSH 没有返回文本)' : body,
				'--- 答复结束 ---',
				state.resultChars > RESULT_CLIP ? `(答复过长已截断,全文见 ${join(state.taskDir, 'result.txt')})` : null,
			].filter((line) => line !== null).join('\n');
		}

		const stderrTail = clip(stripAnsi(readText(join(state.taskDir, 'stderr.log')).slice(-4000)), 2000);
		const outcomeHint = state.status === 'deadline'
			? `提示:${state.expectedSeconds}s 的预估不够用。请把任务拆小,或用更贴合实际的 expected_seconds 重新委派。`
			: state.status === 'stalled'
				? `提示:子代理的进程树完全静止(日志不涨、后代进程不变、树 CPU 不涨)才判停滞。若这类任务本来就长,请把 expected_seconds 估大一些,并让子代理在关键步骤打点输出。`
				: null;
		// 停滞终态的取证:把"为什么判它停滞"逐信号摊开,便于复盘。
		const stallEvidence = state.status === 'stalled' && state.signalState !== null && state.signalState !== undefined
			? [
				'--- 停滞取证(进程树信号) ---',
				`tree_pids: ${JSON.stringify(state.signalState.treePids ?? null)}`,
				`tree_cpu_ms: ${state.signalState.treeCpuMs ?? null}(本轮 +${state.signalState.cpuDeltaMs ?? 0}ms / 阈值 ${state.signalState.cpuThresholdMs ?? null}ms)`,
				`log_bytes: ${state.signalState.logBytes ?? null}(stderr ${state.signalState.stderrBytes ?? null} / stdout ${state.signalState.stdoutBytes ?? null} / result ${state.signalState.resultBytes ?? null} / session ${state.signalState.sessionBytes ?? null})`,
				`signal_state: ${JSON.stringify({ logChanged: state.signalState.logChanged, sessionChanged: state.signalState.sessionChanged, treeAvailable: state.signalState.treeAvailable, descendantsChanged: state.signalState.descendantsChanged, progressed: state.signalState.progressed, progressReason: state.signalState.progressReason })}`,
			].filter((line) => line !== null)
			: [];
		return [
			`[DSH 任务未成功] status=${state.status}`,
			header,
			'',
			`error: ${state.error ?? '(未知)'}`,
			outcomeHint,
			...stallEvidence,
			state.result === '' ? null : '--- 部分输出 ---',
			state.result === '' ? null : clip(state.result, 4000),
			stderrTail === '' ? null : '--- stderr 末尾 ---',
			stderrTail === '' ? null : stderrTail,
			'',
			`(任务目录: ${state.taskDir})`,
		].filter((line) => line !== null).join('\n');
	}
}

/** 直接跑一个 stdio MCP server。 */
/**
 * 排查用的调试输出。stderr 默认**保持静默** —— harness 会把 MCP 子进程的 stderr
 * 一律渲染成 warning(Cursor 的 mcpprocess.log 实测),纯信息不该走 stderr。
 */
function debugNote(line) {
	if (process.env.DSH_SUBAGENT_DEBUG === undefined) return;
	process.stderr.write(`dsh-subagent: ${line}\n`);
}

/**
 * 生命周期留痕(`state/mcp-lifecycle.log`)。
 *
 * stdio 服务一消失,调用方那边只剩一句 "Transport closed"(Codex 实测原话)—— 但
 * 「客户端关掉了管道」和「本进程崩了」在调用方看来完全一样。不留痕就永远分不清,
 * 2026-09-22 那次就是这样:Codex 里的桥接进程没了,只能靠数 node.exe 个数才确认。
 * 所以这几行**不看 DSH_SUBAGENT_DEBUG、也不走 stderr**(harness 会把 MCP 子进程的
 * stderr 渲染成 warning);正常一天只多两条(启动、退出)。
 */
function lifecyclePath() {
	return join(dshHome(), 'subagent', 'state', 'mcp-lifecycle.log');
}

function lifecycleNote(line) {
	try {
		ensureDir(join(dshHome(), 'subagent', 'state'));
		appendFileSync(lifecyclePath(), `${new Date().toISOString()} pid=${process.pid} ${line}\n`);
	} catch {
		/* 留痕失败不能反过来把服务弄死 */
	}
}

export function serve({ input = process.stdin, output = process.stdout } = {}) {
	const server = new McpServer({ input, output });
	server.start();
	// 被 host 杀掉(SIGTERM/SIGINT)时,本进程名下的 DSH 子进程必须一起带走:
	// 否则它们会变成孤儿,继续在后台跑、继续烧 token —— 调用方那边早已停止。
	const stopEverything = (signal) => {
		try {
			for (const task of liveTaskInfos()) {
				try {
					cancelTask(task.id);
				} catch {
					/* 单个失败不影响其它 */
				}
			}
		} catch {
			/* 收尾阶段不抛 */
		}
		debugNote(`收到 ${signal}:已停掉本进程名下的全部运行中任务`);
		server.shutdown(`${signal} 信号`);
	};
	process.on('SIGINT', () => stopEverything('SIGINT'));
	process.on('SIGTERM', () => stopEverything('SIGTERM'));
	// 未处理异常/未处理拒绝必须留痕,而且**不带走整条通道**:
	// Node 24 默认把未处理的 Promise 拒绝当异常抛出,一个没包住的 await 就能让整个 stdio 服务退出。
	// 退出之后调用方那边每次调用都是 "Transport closed",直到它自己重启 —— 一个坏调用换来整条
	// 通道报废,代价太大。所以记一行,继续服务下一个请求。
	process.on('uncaughtException', (error) => {
		lifecycleNote(`uncaughtException: ${error?.stack ?? error}`);
	});
	process.on('unhandledRejection', (reason) => {
		lifecycleNote(`unhandledRejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`);
	});
	process.on('exit', (code) => lifecycleNote(`exit code=${code}`));
	lifecycleNote(`start bridge v${SERVER_VERSION} node=${process.version} pid=${process.pid}`);
	// 启动横幅**默认不打**:harness 会把 MCP 子进程的 stderr 一律渲染成 warning/error。
	// 实测 Cursor 的 `mcpprocess.log` 里,原先这行纯信息会变成
	//   [warning] [McpProcess stderr]   ERR dsh-subagent: MCP stdio server ready …
	// 用户看到的就是"MCP 连接有个 warning"。stderr 只留给**真的出问题**时用
	// (例如 tasks.mjs 里进程树探测不可用的降级告警);要排查就设 DSH_SUBAGENT_DEBUG。
	if (process.env.DSH_SUBAGENT_DEBUG !== undefined) {
		process.stderr.write(`dsh-subagent: MCP stdio server ready (bridge v${SERVER_VERSION})\n`);
	}
	return server;
}
