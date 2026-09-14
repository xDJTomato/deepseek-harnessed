/**
 * dsh-subagent-observer —— 让 DSH Desktop 的 Web GUI 直接监控"被外部 harness 激活的
 * subagent 任务"。
 *
 * 背景:Cursor / Claude Code / Codex 通过 MCP 桥接拉起的,是一个**独立进程**里的
 * DSH 实例(profile `subagent`)。它的会话是真会话、也按常规落盘在
 * `$DSH_HOME/sessions/<工作空间key>/session-<uuid>/`,但 GUI 宿主的会话列表只在
 * 连接时刷新一次,并且"是否在跑"取自宿主进程内的 agent 注册表 —— 于是外部任务
 * 在侧边栏里既不会及时出现,也没有运行中标记。
 *
 * 这个插件挂在 **GUI 宿主**(desktop profile)上,轮询桥接层的任务现场
 * (`$DSH_HOME/subagent/state/tasks/<job-id>/`),把外部任务投射成 GUI 认得的
 * 远程事件:
 *
 *   api-session/added     任务一出现,会话立刻进入侧边栏(带 cwd,归到对应工作空间)
 *   api-session/status    运行中 → 会话显示为"正在执行";任务结束 → 取消标记
 *   api-session/activity  持续刷新活动时间,把正在跑的会话顶在列表最前
 *
 * 这三个事件都是 `@deepseek-ai/dsh-api-remotes` 声明转发的事件名,GUI 客户端
 * (`dsh-api-session-controller` 的 client 层)直接消费,因此不需要改前端、不需要重启。
 *
 * 由 `$DSH_HOME/profiles/desktop/cordis.patch.yml` 的 insert 条目加载;
 * desktop profile 是 `patchReload: live`,所以改完即时生效。
 *
 * @module dsh-subagent/monitor/observer
 */
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { zstdDecompressSync } from 'node:zlib';

/** 稳定的 Cordis 插件名。 */
export const name = 'dsh-subagent-observer';

/** 不需要任何服务:只用 ctx.emit 与文件系统,避免影响宿主启动顺序。 */
export const inject = [];

/** 轮询间隔(毫秒)。 */
const POLL_MS = Number(process.env.DSH_SUBAGENT_OBSERVER_INTERVAL ?? 2000);

/** 只关心最近这段时间内启动的任务,避免把历史任务全部重播。 */
const MAX_AGE_MS = Number(process.env.DSH_SUBAGENT_OBSERVER_MAX_AGE_MS ?? 12 * 60 * 60 * 1000);

/** 只有"正在跑"或"刚结束"的任务才值得推给 GUI 列表:早于这个窗口的历史任务本来就在列表里。 */
const ANNOUNCE_AGE_MS = Number(process.env.DSH_SUBAGENT_OBSERVER_ANNOUNCE_AGE_MS ?? 10 * 60 * 1000);

/** 活动事件的最小间隔,避免每 2 秒无谓地刷客户端。用量变化也走这个节流。 */
const ACTIVITY_MS = Number(process.env.DSH_SUBAGENT_OBSERVER_ACTIVITY_MS ?? 5000);

/**
 * 重播 `api-session/added` 的间隔:客户端刷新页面后本地列表会重建,
 * 自带的投影(调用方等)必须能再灌回去,否则悬浮卡片会空掉。
 */
const REANNOUNCE_RUNNING_MS = Number(process.env.DSH_SUBAGENT_OBSERVER_REANNOUNCE_MS ?? 20000);

/** 已结束会话的重播间隔更慢一些。 */
const REANNOUNCE_IDLE_MS = 60000;

/**
 * 「记录说在跑、但连 pid 都没记」的信任期。
 *
 * 任务刚起时 status 已经是 running,prompt 还没写进 meta.json,pid 自然拿不到 ——
 * 这段窗口必须相信它,否则刚起的任务会被当成死的。
 * 但只信一小会儿:超过这个时间还拿不到 pid,就是**半成品记录**(实测有一条 2 小时前、
 * 连 caller 都缺的记录,判活返回"未知",于是所有视图都默认它还在跑 → 永远显示活跃)。
 */
const UNKNOWN_PID_GRACE_MS = Number(process.env.DSH_SUBAGENT_OBSERVER_PID_GRACE_MS ?? 120000);

/**
 * 吞吐(tok/s)的采样口径。
 *
 * 踩过:客户端自己每秒采一次 Δ输出/Δt,但外部任务的用量是**成块**更新的(折叠节流 5 秒、
 * 投影重播 20 秒),于是"2 秒里跳了 6000 token"被算成 3000 tok/s —— 数字疯掉不是数据错,
 * 是窗口太短。改成**在这里算**:按真实的采样时间跨度求 Δ输出/Δt,跨度不足 3 秒不算,
 * 再取最近 4 次采样的平均(≈20~40 秒窗口),客户端只负责显示。
 */
const RATE_MIN_SPAN_MS = Number(process.env.DSH_SUBAGENT_OBSERVER_RATE_MIN_MS ?? 3000);
const RATE_SAMPLES = Number(process.env.DSH_SUBAGENT_OBSERVER_RATE_SAMPLES ?? 4);

/** 诊断开关:DSH_SUBAGENT_OBSERVER_DEBUG=1 时每轮都写日志。 */
const DEBUG = process.env.DSH_SUBAGENT_OBSERVER_DEBUG === '1';

/** 调用方(clientInfo.name)→ 界面上显示的名字。 */
const CALLER_LABELS = {
	'claude-code': 'Claude Code',
	'claude': 'Claude Code',
	'codex-mcp-client': 'Codex',
	'codex': 'Codex',
	'cursor-vscode': 'Cursor',
	'cursor-agent': 'Cursor',
	'cursor': 'Cursor',
	'gemini-cli': 'Gemini CLI',
	'kiro': 'Kiro',
	'qoder': 'Qoder',
	'antigravity': 'Antigravity',
	'cli': '命令行',
	'dsh-subagent-selftest': '自检',
};

/**
 * 把原始调用方名字变成界面友好的标签。
 * 老任务没有 caller 字段,就从注入的委托说明里兜底解析。
 * @param caller - task.json 里的 caller。
 * @param promptPreview - 任务提示词预览(含 "外部 harness(<名字>)" 前言)。
 * @returns 展示用标签。
 */
function callerLabelOf(caller, promptPreview) {
	const raw = typeof caller === 'string' && caller !== '' ? caller : '';
	if (raw !== '') return CALLER_LABELS[raw.toLowerCase()] ?? raw;
	const matched = /外部 harness\(([^)]+)\)/u.exec(typeof promptPreview === 'string' ? promptPreview : '');
	if (matched !== null) return CALLER_LABELS[matched[1].toLowerCase()] ?? matched[1];
	return '未知来源';
}

/**
 * 从任务里挑一个能当标题的短句:优先 label,其次提示词正文的第一行。
 * @param task - 任务记录。
 * @returns 单行标题。
 */
function titleOf(task) {
	if (typeof task.label === 'string' && task.label.trim() !== '') return task.label.trim();
	const preview = typeof task.promptPreview === 'string' ? task.promptPreview : '';
	const lines = preview.split(/\r?\n/u).map((line) => line.trim()).filter((line) => line !== '' && !line.startsWith('#') && !line.startsWith('-'));
	const first = lines[0] ?? '';
	return first.length > 60 ? `${first.slice(0, 60)}…` : first;
}

/** 安全读 JSON。 */
function readJson(path) {
	try {
		return JSON.parse(readFileSync(path, 'utf8'));
	} catch {
		return undefined;
	}
}

/**
 * 只读文件尾部若干字节(不整文件读)。
 *
 * 为什么不用 mtime 判进度:mtime 在部分环境里不可靠(安全软件的文件过滤会让它停在创建
 * 时刻),只有字节数会变。所以卡片上的"活着"信号一律走字节数与这截尾部文本。
 *
 * @param path - 文件路径。
 * @param maxBytes - 最多读多少字节。
 * @returns 文本(失败返回空串)。
 */
function tailText(path, maxBytes) {
	try {
		const size = statSync(path).size;
		if (size <= 0) return '';
		const start = Math.max(0, size - maxBytes);
		const length = size - start;
		const buffer = Buffer.alloc(length);
		const fd = openSync(path, 'r');
		try {
			readSync(fd, buffer, 0, length, start);
		} finally {
			closeSync(fd);
		}
		return buffer.toString('utf8');
	} catch {
		return '';
	}
}

/**
 * 取任务现场里最后几行有信息量的输出,供悬浮卡片显示"它现在在干什么"。
 *
 * 这是**唯一**能看到外部任务实时内容的正规途径:外部任务的会话日志属于别的进程,
 * 在 GUI 里打开那个会话会让宿主接管写权并破坏它的日志(见 README §7.5)。
 *
 * @param dir - 任务目录。
 * @returns 最多 6 行、每行最多 160 字符的文本行。
 */
function recentLinesOf(dir) {
	const text = tailText(join(dir, 'stderr.log'), 8192);
	if (text === '') return [];
	const lines = text
		.split(/\r?\n/u)
		.map((line) => line.replace(/\u001b\[[0-9;]*m/gu, '').trim())
		.filter((line) => line !== '')
		.slice(-6)
		.map((line) => (line.length > 160 ? `${line.slice(0, 160)}…` : line));
	return lines;
}

/**
 * 任务结束后的结果预览(前 240 字)。
 * @param dir - 任务目录。
 * @returns 单行预览,没有结果时为空串。
 */
function resultPreviewOf(dir) {
	const text = readFileSyncSafe(join(dir, 'result.txt'));
	if (text === '') return '';
	const oneLine = text.replace(/\s+/gu, ' ').trim();
	return oneLine.length > 240 ? `${oneLine.slice(0, 240)}…` : oneLine;
}

/**
 * 读小文件(读不到就返回空串)。
 * @param path - 文件路径。
 * @returns 文本内容。
 */
function readFileSyncSafe(path) {
	try {
		return readFileSync(path, 'utf8');
	} catch {
		return '';
	}
}

/**
 * 判断进程是否还活着。桥接层崩掉时,任务记录会永远停在 running,
 * 靠 pid 存活性兜底,免得 GUI 里留下一个永远"正在执行"的幽灵会话。
 * @param pid - 进程号;非正整数表示没有可用信息。
 * @returns true 活着,false 已消失,undefined 无从判断。
 */
function processAlive(pid) {
	if (!Number.isInteger(pid) || pid <= 0) return undefined;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error?.code === 'EPERM' ? true : false;
	}
}

/** 日志文件路径(模块级,便于兜底日志也能用)。 */
const LOG_PATH = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'subagent', 'state', 'observer.log');
/** 会话仓库根:外部任务的会话日志也在这里,折叠 token 用量时要用。 */
const SESSIONS_ROOT = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'sessions');

// ---------------------------------------------------------------- token 用量
//
// 卡片底部要显示 `tok/s | 缓存命中 99% | 输入 111M tok · 输出 636K tok` 这类状态。
// 宿主自己的会话有 `tokenUsage` 投影可用,但**外部任务的会话宿主没加载过**,
// 那份投影不存在 —— 所以这里自己从子代理的会话日志里折叠出来,塞进我们自己的
// `dsh-subagent` 投影(用自己的 key,不动宿主的标准 key,免得和它的水位打架)。
//
// 折叠口径抄宿主的 token-meter:同一 (turn, step) 的 usage 样本**替换**而不是累加
// (usage chunk 是早到的样本,assistant/message 是同一轮的最终样本),`llm/retry-started`
// 关掉替换槽,这样重试的那次会重新累加。抄口径是为了让卡片和宿主 UI 的数目对得上。

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
/** 折叠结果缓存:sessionId → { path, size, mtimeMs, usage, at, tokensPerSecond }。 */
const usageCache = new Map();
/** 同一个会话最多多久重折一次(日志一直在长,折叠本身要 ~33ms/700K)。 */
const USAGE_REFRESH_MS = Number(process.env.DSH_SUBAGENT_OBSERVER_USAGE_REFRESH_MS ?? 5000);
/** 会话目录索引缓存:bucket 扫描比较贵,记住 sessionId → 文件路径。 */
const sessionPathCache = new Map();

/**
 * 复合帧 zstd:逐帧解再拼起来(DSH 是追加写,一个文件里有多帧)。
 *
 * ⚠️ 必须逐帧。踩过:`zstdDecompressSync(整个文件)` **只解第一帧就返回**(实测 699K /
 * 1282 帧的日志,整块解只出 151 个字符,而且不报错)—— 用它算用量会得到一份
 * "看起来很正常、其实几乎没有"的假数字。真实的 1282 帧日志逐帧解出 1.5M 字符,33ms。
 */
export function decodeLogFile(file) {
	const raw = readFileSync(file);
	const starts = [];
	let index = raw.indexOf(ZSTD_MAGIC, 0);
	while (index >= 0) {
		starts.push(index);
		index = raw.indexOf(ZSTD_MAGIC, index + 4);
	}
	const parts = [];
	for (let cursor = 0; cursor < starts.length; cursor += 1) {
		const from = starts[cursor];
		const to = cursor + 1 < starts.length ? starts[cursor + 1] : raw.length;
		try {
			parts.push(zstdDecompressSync(raw.subarray(from, to)).toString('utf8'));
		} catch {
			/* 半截帧(正在写)忽略 */
		}
	}
	if (parts.length === 0 && raw.length > 0) {
		try {
			parts.push(zstdDecompressSync(raw).toString('utf8'));
		} catch {
			return '';
		}
	}
	return parts.join('');
}

/**
 * 找某个会话的日志文件(sessionId → $DSH_HOME/sessions/<bucket>/<id>/session*.jsonl.zstd)。
 *
 * ⚠️ 文件名随 DSH 版本变过:0.1.5 起是 `session.v3.jsonl.zstd`。原先硬编码
 * `session.jsonl.zstd`,升级后**找不到就安静返回 null**,卡片上的 token 用量对新会话
 * 全成了空 —— 一个不报错的静默回归(实测改名时刻与本机升级时刻一致)。
 * 这里按 `session*.jsonl.zstd` 找,并取**最大**的那个:真正的日志最大,不依赖 mtime(本机不可靠)。
 */
function sessionLogPath(sessionId) {
	const cached = sessionPathCache.get(sessionId);
	if (cached !== undefined) {
		if (cached.path === null || existsSync(cached.path)) {
			cached.at = Date.now();
			return cached.path;
		}
	}
	let found = null;
	try {
		for (const bucket of readdirSync(SESSIONS_ROOT)) {
			const dir = join(SESSIONS_ROOT, bucket, sessionId);
			let names;
			try {
				names = readdirSync(dir);
			} catch {
				continue;
			}
			let best = null;
			for (const name of names) {
				if (!/^session.*\.jsonl\.zstd$/i.test(name)) continue;
				const candidate = join(dir, name);
				try {
					const size = statSync(candidate).size;
					if (size > 0 && (best === null || size > best.size)) best = { path: candidate, size };
				} catch {
					/* 读不到就当没有 */
				}
			}
			if (best !== null) {
				found = best.path;
				break;
			}
		}
	} catch {
		found = null;
	}
	sessionPathCache.set(sessionId, { path: found, at: Date.now() });
	pruneCaches();
	return found;
}

/** 两个缓存都跟着宿主活很久:超过上限时按最后访问时间清一批,别无限长。 */
function pruneCaches() {
	const cutoff = Date.now() - 6 * 60 * 60 * 1000;
	for (const cache of [usageCache, sessionPathCache]) {
		if (cache.size <= 200) continue;
		for (const [key, value] of cache) {
			if ((value?.at ?? 0) < cutoff) cache.delete(key);
		}
	}
}

/** 把 usage 事件折叠成总量(替换语义,见上面的口径说明)。 */
export function foldUsage(text) {
	const totals = { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
	let last = null;
	let turns = 0;
	for (const line of text.split('\n')) {
		if (line === '') continue;
		let event;
		try {
			event = JSON.parse(line);
		} catch {
			continue;
		}
		const type = event?.type;
		if (type === 'llm/retry-started') {
			if (last !== null && last.turn === event.data?.turn && last.step === event.data?.step) last = null;
			continue;
		}
		let turn;
		let step;
		let usage;
		if (type === 'assistant/chunk' && event.data?.chunk?.type === 'usage') {
			turn = event.data.turn;
			step = event.data.step;
			usage = event.data.chunk.usage;
		} else if (type === 'assistant/message' && event.data?.usage !== undefined) {
			turn = event.data.turn;
			step = event.data.step;
			usage = event.data.usage;
		} else {
			continue;
		}
		if (usage === undefined || usage === null) continue;
		const buckets = {
			uncachedInputTokens: Number(usage.inputTokens) || 0,
			outputTokens: Number(usage.outputTokens) || 0,
			cacheReadTokens: Number(usage.cacheReadTokens) || 0,
			cacheWriteTokens: Number(usage.cacheWriteTokens) || 0,
		};
		const previous = last !== null && last.turn === turn && last.step === step ? last.buckets : null;
		if (previous !== null
			&& previous.uncachedInputTokens === buckets.uncachedInputTokens
			&& previous.outputTokens === buckets.outputTokens
			&& previous.cacheReadTokens === buckets.cacheReadTokens
			&& previous.cacheWriteTokens === buckets.cacheWriteTokens) {
			continue;
		}
		totals.uncachedInputTokens += buckets.uncachedInputTokens - (previous?.uncachedInputTokens ?? 0);
		totals.outputTokens += buckets.outputTokens - (previous?.outputTokens ?? 0);
		totals.cacheReadTokens += buckets.cacheReadTokens - (previous?.cacheReadTokens ?? 0);
		totals.cacheWriteTokens += buckets.cacheWriteTokens - (previous?.cacheWriteTokens ?? 0);
		last = { turn, step, buckets };
		turns += previous === null ? 1 : 0;
	}
	if (turns === 0 && totals.outputTokens === 0) return null;
	const promptTokens = totals.uncachedInputTokens + totals.cacheReadTokens + totals.cacheWriteTokens;
	return {
		...totals,
		promptTokens,
		totalTokens: promptTokens + totals.outputTokens,
		calls: turns,
	};
}

/**
 * 按真实采样时间跨度算吞吐:Δ输出 / Δ时间,跨度不足 3 秒不算,最近 4 次取平均。
 *
 * 只认"输出确实增长"的窗口;用量是成块更新的(折叠节流 + 投影重播),所以
 * **窗口必须够长**,否则会把一整块算成"一秒几千 token"。
 *
 * @param previous - 上一次采样 { at, output }。
 * @param usage - 本次折叠结果。
 * @param now - 本次采样时刻。
 * @param rates - 已有的速率样本(会被就地更新)。
 * @param minSpanMs - 最小采样跨度(默认取常量;自检会显式传值)。
 * @returns 吞吐 tok/s 或 null。
 */
export function rateOf(previous, usage, now, rates, minSpanMs = RATE_MIN_SPAN_MS) {
	if (previous === undefined || usage === null) return null;
	const span = now - previous.at;
	if (span < minSpanMs) return null;
	const delta = usage.outputTokens - previous.output;
	if (delta <= 0) return null;
	const instant = (delta / span) * 1000;
	rates.push(instant);
	while (rates.length > RATE_SAMPLES) rates.shift();
	const average = rates.reduce((sum, value) => sum + value, 0) / rates.length;
	return Math.round(average * 10) / 10;
}

/**
 * 某个外部任务的 token 用量(带 (size, mtime) 缓存,别每 2 秒重解一遍日志)。
 * @returns 用量对象(含 tokensPerSecond)或 null(还没写出 usage / 解不了)。
 */
function usageOfSession(sessionId) {
	const now = Date.now();
	const file = sessionLogPath(sessionId);
	if (file === null) return null;
	let stat;
	try {
		stat = statSync(file);
	} catch {
		return null;
	}
	const cached = usageCache.get(sessionId);
	if (cached !== undefined && cached.path === file) {
		// 节流:一个 700K 的日志折叠一次约 33ms,而日志每个 tick 都在长 ——
		// 同一个会话 5 秒内只重算一次,数字够新,宿主也不会被拖。
		if (now - cached.at < USAGE_REFRESH_MS) return cached.usage;
		if (cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
			cached.at = now;
			return cached.usage;
		}
	}
	let usage = null;
	try {
		usage = foldUsage(decodeLogFile(file));
	} catch {
		usage = null;
	}
	const rates = cached?.rates ?? [];
	const previous = cached?.usage === null || cached?.usage === undefined
		? undefined
		: { at: cached.at, output: cached.usage.outputTokens };
	const tokensPerSecond = rateOf(previous, usage, now, rates);
	const enriched = usage === null ? null : {
		...usage,
		...(tokensPerSecond === null ? {} : { tokensPerSecond }),
		...(previous === undefined ? {} : { rateWindowMs: now - previous.at }),
	};
	usageCache.set(sessionId, { path: file, size: stat.size, mtimeMs: stat.mtimeMs, usage: enriched, at: now, rates });
	return enriched;
}

/** 写一行观察器日志;日志失败绝不影响宿主。 */
function safeLog(line) {
	try {
		appendFileSync(LOG_PATH, `${new Date().toISOString()} ${line}\n`, 'utf8');
	} catch {
		/* 忽略 */
	}
}

/**
 * 挂载观察器。
 *
 * 注意:本插件跑在 **GUI 宿主进程**里,apply 抛异常会让整棵插件树加载失败、
 * 应用起不来。所以这里只用 Context 的核心能力(ctx.emit / ctx.effect),
 * 不碰需要 inject 的服务(例如 ctx.setInterval 会直接抛错),
 * 并且整段逻辑包在 try/catch 里:任何意外都只记日志,不影响宿主启动。
 *
 * @param ctx - GUI 宿主的插件上下文(用于 ctx.emit 与生命周期)。
 */
export function apply(ctx) {
	try {
		start(ctx);
	} catch (error) {
		safeLog(`observer 挂载失败(宿主不受影响): ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
	}
}

/**
 * 真正的挂载逻辑。
 * @param ctx - GUI 宿主的插件上下文。
 */
function start(ctx) {
	const home = process.env.DSH_HOME ?? join(homedir(), '.dsh');
	const tasksRoot = join(home, 'subagent', 'state', 'tasks');
	const stateRoot = join(home, 'subagent', 'state');

	const log = safeLog;

	/** sessionId -> { announced: true, running: boolean, lastActivity: number } */
	const tracked = new Map();

	/** 已跑过的轮数,仅用于诊断日志。 */
	let rounds = 0;

	/**
	 * 找出本轮所有外部任务对应的会话。
	 * sessionId 来自任务现场的 task.json(结束时写)或 meta.json(runner 一建立会话就写)。
	 * @returns sessionId → { running, cwd, jobId, status, at, stale }
	 */
	function collect() {
		/** @type {Map<string, {running:boolean,cwd:string,jobId:string,status:string,at:number,stale:boolean}>} */
		const found = new Map();
		let names = [];
		try {
			names = readdirSync(tasksRoot);
		} catch {
			return found;
		}
		const cutoff = Date.now() - MAX_AGE_MS;
		for (const entry of names) {
			const dir = join(tasksRoot, entry);
			try {
				if (!statSync(dir).isDirectory()) continue;
			} catch {
				continue;
			}
			const task = readJson(join(dir, 'task.json'));
			if (task === undefined) continue;
			const startedAt = Date.parse(String(task.startedAt ?? ''));
			if (Number.isFinite(startedAt) && startedAt < cutoff) continue;
			const meta = readJson(join(dir, 'meta.json'));
			const sessionId = typeof task.sessionId === 'string' && task.sessionId !== ''
				? task.sessionId
				: typeof meta?.sessionId === 'string' ? meta.sessionId : '';
			if (sessionId === '') continue;
			// 记录说在跑,还得进程真的还在:桥接层异常退出会留下 status=running 的僵尸记录。
			const claimsRunning = task.status === 'running';
			const pidKnown = Number.isInteger(meta?.pid) ? meta.pid : Number.isInteger(task.pid) ? task.pid : 0;
			const alive = processAlive(pidKnown);
			const ageMs = Number.isFinite(startedAt) ? Date.now() - startedAt : 0;
			// 没记 pid 时判活是"未知":刚起的任务要信,超期的半成品记录不能信(见 UNKNOWN_PID_GRACE_MS)。
			const trustedUnknown = alive === undefined && ageMs <= UNKNOWN_PID_GRACE_MS;
			const stillRunning = claimsRunning && (alive === true || trustedUnknown);
			found.set(sessionId, {
				running: stillRunning,
				cwd: typeof task.workspace === 'string' ? task.workspace : '',
				jobId: entry,
				status: String(task.status ?? ''),
				at: Number.isFinite(startedAt) ? startedAt : Date.now(),
				stale: claimsRunning && !stillRunning,
				caller: typeof task.caller === 'string' ? task.caller : '',
				callerLabel: callerLabelOf(task.caller, task.promptPreview),
				title: titleOf(task),
				label: typeof task.label === 'string' ? task.label : '',
				startedAt: typeof task.startedAt === 'string' ? task.startedAt : null,
				finishedAt: typeof task.finishedAt === 'string' ? task.finishedAt : null,
				expectedSeconds: Number.isInteger(task.expectedSeconds) ? task.expectedSeconds : null,
				deadlineAt: typeof task.deadlineAt === 'string' ? task.deadlineAt : null,
				lastProgressAt: typeof task.lastProgressAt === 'string' ? task.lastProgressAt : null,
				progressBytes: Number.isFinite(task.progressBytes) ? task.progressBytes : null,
				acceptance: typeof task.acceptance === 'string' ? task.acceptance : null,
				exitCode: Number.isInteger(task.exitCode) ? task.exitCode : null,
				error: typeof task.error === 'string' ? task.error : null,
				recentLines: recentLinesOf(dir),
				resultPreview: resultPreviewOf(dir),
			});
		}
		return found;
	}

	// 心跳文件:桥接层靠它判断"现在有没有一个带监控的 GUI 宿主在跑"。
	// 没有 → 拉起 DSH Desktop;有 → 绝不重复启动(两个 GUI 会同时写同一批会话日志)。
	// 只写这一个文件,内容极小,失败只记日志(不能因为监控影响宿主)。
	const heartbeatPath = join(stateRoot, 'observer-heartbeat.json');
	let heartbeatWrittenAt = 0;
	const HEARTBEAT_MS = 5000;
	function writeHeartbeat(found) {
		const now = Date.now();
		if (now - heartbeatWrittenAt < HEARTBEAT_MS) return;
		heartbeatWrittenAt = now;
		try {
			mkdirSync(stateRoot, { recursive: true });
			let active = 0;
			if (found instanceof Map) for (const info of found.values()) if (info.running) active += 1;
			writeFileSync(heartbeatPath, `${JSON.stringify({
				at: new Date(now).toISOString(),
				epochMs: now,
				pid: process.pid,
				engine: 'dsh-desktop-observer',
				profile: process.env.DSH_PROFILE ?? 'desktop',
				pollMs: POLL_MS,
				trackedTasks: tracked.size,
				activeTasks: active,
				// 口径版本:心跳里带上它,就能**当场**分辨宿主里跑的是哪一版观察器
				// (file: 插件是否热重载不必靠猜 —— 看这个字段有没有出现即可)。
				usageRate: { minSpanMs: RATE_MIN_SPAN_MS, samples: RATE_SAMPLES, foldThrottleMs: USAGE_REFRESH_MS },
			}, null, 2)}\n`, 'utf8');
		} catch (error) {
			log(`心跳写入失败(已忽略): ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	/** 投射一次:新增会话 → 标记运行中 → 刷新活动时间 → 结束则取消标记。 */
	function tick() {
		let found = null;
		try {
			found = project();
		} catch (error) {
			log(`tick 失败(已忽略): ${error instanceof Error ? error.message : String(error)}`);
		}
		writeHeartbeat(found);
	}

	/** 一轮实际投射。返回本轮的任务表(Map),供心跳统计;失败返回 null。 */
	function project() {
		let found;
		try {
			found = collect();
		} catch (error) {
			log(`collect 失败: ${error instanceof Error ? error.message : String(error)}`);
			return null;
		}
		rounds += 1;
		if (DEBUG) {
			log(`tick #${rounds}: 任务数 ${found.size},跟踪中 ${tracked.size}`);
		}
		const now = Date.now();
		for (const [sessionId, info] of found) {
			let state = tracked.get(sessionId);
			const isNew = state === undefined;
			if (isNew) {
				state = { announced: true, running: false, announcedAt: 0, cleanedAt: 0, projectedRunning: false };
				tracked.set(sessionId, state);
			}
			// 只推"正在跑"或"刚结束"的:更早的历史会话本来就在客户端列表里,
			// 重复 added 只会把用户主动删掉的会话又拽回来。
			const inWindow = info.running || now - info.at <= ANNOUNCE_AGE_MS;
			// 进度字节变了就提前重播一次(阈值 ACTIVITY_MS),让悬浮卡片上的进度条/日志尾部
			// 接近实时,而不必等满 20 秒的常规节奏。
			const progressMoved = state.progressBytes !== undefined
				&& info.progressBytes !== null
				&& info.progressBytes !== state.progressBytes;
			state.progressBytes = info.progressBytes;
			const cadence = info.running ? REANNOUNCE_RUNNING_MS : REANNOUNCE_IDLE_MS;
			const progressDue = info.running && progressMoved && now - state.announcedAt >= ACTIVITY_MS;
			// 用量涨了也算"有进展":底部状态条的数字和吞吐必须跟着动,不能等满 20 秒的常规节奏
			// (踩过:用量只在常规重播时推出,状态条最多滞后 20 秒)。同样受 ACTIVITY_MS 节流。
			// 用量在**判断之前**取(缓存按 size/mtime + 5 秒节流,取一次很便宜),
			// 因为"用量涨了"本身就是一次重播的理由。
			const usage = info.running ? usageOfSession(sessionId) : null;
			const usageOutput = usage === null ? null : usage.outputTokens;
			const usageMoved = usageOutput !== null && state.usageOutput !== undefined
				&& state.usageOutput !== null && usageOutput !== state.usageOutput;
			const usageDue = usageMoved && now - state.announcedAt >= ACTIVITY_MS;
			// **投影里"运行中"的收尾一定要推一次**,哪怕它已经出了重播窗口。
			// 踩过:任务记录变成幽灵(status 还写着 running、进程早没了)之后,它超过
			// ANNOUNCE_AGE_MS 就不再重播,而客户端看到的 `running` 来自**投影**(不是状态事件),
			// 于是卡片里会永远挂着一个"活跃"的幽灵任务(实测数到 4 个)。
			// 所以一旦投影过 running=true、现在又不是 running 了,就绕过窗口强制推一次。
			const needsCleanupPush = info.running === false && state.projectedRunning === true
				&& now - state.cleanedAt >= REANNOUNCE_IDLE_MS;
			if (needsCleanupPush) state.cleanedAt = now;
			if ((inWindow && (isNew || progressDue || usageDue || now - state.announcedAt >= cadence)) || needsCleanupPush) {
				state.announcedAt = now;
				state.usageOutput = usageOutput;
				// 投影水位用**小的自增计数**,不要用 Date.now():客户端的投影存储是
				// "seq 大者胜",用一个巨大的水位会把宿主之后真正算出来的 title 等投影
				// 永久挡掉;小计数既能让自己的重播生效,又会被宿主的真实帧覆盖。
				state.projectionSeq = (state.projectionSeq ?? 0) + 1;
				state.projectedRunning = info.running;
				// 会话入列 + 把"这是外部调用方的任务"写进投影:
				// 客户端每次列表快照都会带出 projectionValues,悬浮卡片据此分组。
				ctx.emit('api-session/added', {
					sessionId,
					updatedAt: now,
					running: info.running,
					blank: false,
					...(info.cwd === '' ? {} : { cwd: info.cwd }),
					projections: {
						asOfSeq: state.projectionSeq,
						values: {
							// 列表里的标题:一眼看出是哪个调用方的 subagent 任务。
							// 运行中额外挂一句"勿点开":在 GUI 里打开一个正在被外部进程写的
							// 会话会让宿主接管写权并写坏它的日志(见 README §7.6)。
							title: `⚡ ${info.callerLabel} · ${info.title === '' ? 'subagent 任务' : info.title}`
								+ (info.running ? ' ⚠运行中·勿点开' : ''),
							'dsh-subagent': {
								jobId: info.jobId,
								caller: info.caller,
								callerLabel: info.callerLabel,
								workspace: info.cwd,
								status: info.status,
								running: info.running,
								label: info.label,
								title: info.title,
								startedAt: info.startedAt,
								finishedAt: info.finishedAt,
								expectedSeconds: info.expectedSeconds,
								deadlineAt: info.deadlineAt,
								lastProgressAt: info.lastProgressAt,
								progressBytes: info.progressBytes,
								acceptance: info.acceptance,
								exitCode: info.exitCode,
								error: info.error,
								recentLines: info.recentLines,
								resultPreview: info.resultPreview,
								// 卡片底部状态条要用:`输入/输出/缓存命中/tok-s`
								usage: usage ?? null,
							},
						},
					},
				});
				log(`${isNew ? 'added' : 're-announce'} ${sessionId} job=${info.jobId} caller=${info.callerLabel} cwd=${info.cwd} running=${info.running}`);
			} else if (isNew) {
				log(`skip ${sessionId} job=${info.jobId}(历史任务,不重播)`);
			}
			if (info.stale && state.staleLogged !== true) {
				state.staleLogged = true;
				log(`stale ${sessionId} job=${info.jobId}(记录说在跑,进程已消失)`);
			}
			if (info.running) {
				if (!state.running) {
					state.running = true;
					ctx.emit('api-session/status', sessionId, true);
					ctx.emit('api-session/activity', sessionId, now);
					log(`status ${sessionId} running=true job=${info.jobId}`);
				}
				// 注意:这里**不做**周期性 activity 心跳。客户端收到 activity 会记一次变更,
				// 高频心跳会让它反复重建列表/重读会话,实测会把 GUI 拖卡。
				continue;
			}
			if (state.running) {
				state.running = false;
				ctx.emit('api-session/status', sessionId, false);
				ctx.emit('api-session/activity', sessionId, now);
				log(`status ${sessionId} running=false job=${info.jobId} status=${info.status}`);
			}
		}
		// 跟踪表回收:超过窗口又不在跟踪窗口内的会话不再重播,避免长期运行后无限增长。
		for (const [sessionId, state] of tracked) {
			if (found.has(sessionId)) continue;
			// 任务现场被清理掉时兜底:别让会话永远停在"运行中"。
			if (state.running) {
				state.running = false;
				ctx.emit('api-session/status', sessionId, false);
			}
			if (state.running === false && now - state.announcedAt > 30 * 60 * 1000) tracked.delete(sessionId);
		}
		return found;
	}

	// 用全局 setInterval,不用 ctx.setInterval:后者属于 timer 服务,
	// 未 inject 就访问会抛 "cannot get property without inject"。
	const timer = setInterval(tick, POLL_MS);
	timer.unref?.();
	try {
		ctx.effect(() => () => clearInterval(timer), 'dsh-subagent-observer');
	} catch {
		// 没有 effect 的极旧内核:靠进程生命周期兜底。
	}
	log(`observer 已挂载,间隔 ${POLL_MS}ms,任务目录 ${tasksRoot}`);
	tick();
}
