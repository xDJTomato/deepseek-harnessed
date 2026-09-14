/**
 * DSH 子代理任务的启动、等待、查询与取消。
 *
 * 每个任务一个目录(<DSH_HOME>/subagent/state/tasks/<id>/),里面落盘:
 *   prompt.md   本次交给 DSH 的提示词(审计用)
 *   stdout.log  DSH 进程的 stdout(最终答复;另有 result.txt)
 *   stderr.log  推理过程与告警
 *   result.txt  runner 写出的最终答复(优先取这个)
 *   meta.json   runner 写出的 sessionId / 模型 / 停止原因 / 耗时
 *   task.json   桥接层自己的任务状态(pid、状态、退出码、工作空间、调用方、预估与截止时间…)
 *
 * 因为状态全在磁盘上,即使 MCP server 重启,任务结果依然可查。
 *
 * task.json 里的关键字段语义:
 *   caller / callerVersion     发起方的 MCP clientInfo(CLI 为 "cli",无连接为 "unknown")
 *   expectedSeconds            调用方声明的预估耗时(秒,必填)
 *   acceptance                 调用方声明的验收标准(可空)
 *   deadlineAt                 硬截止 = startedAt + expectedSeconds × 宽限系数
 *   lastProgressAt/progressBytes/stalledProbes  停滞看门狗的取证字段
 *
 * @module dsh-subagent/lib/tasks
 */
import { spawn, execFileSync } from 'node:child_process';
import { closeSync, openSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { resolveLauncher, childEnv } from './launcher.mjs';
import {
	detectHollowShellCalls, decodeSessionLog, findSessionLog, hollowShellWarning, parseSessionLog,
} from './session-log.mjs';
import {
	Gate, clip, dshHome, ensureDir, listDir, newTaskId, processAlive, readJson, readText,
	taskDir, tasksRoot, writeJson, writeText,
} from './util.mjs';

/** 权限模式取值(与 DSH 的 permission-presets 对齐)。 */
export const PERMISSIONS = ['read-only', 'workspace-write', 'danger-full-access'];

/** 默认权限:调用方(harness)本身就有写权限,子代理默认全权,可由参数收紧。 */
export const DEFAULT_PERMISSION = process.env.DSH_SUBAGENT_PERMISSION ?? 'danger-full-access';

/** 默认单任务墙钟上限(秒):这是最外层的绝对兜底,比调用方声明的 deadline 更宽松。 */
export const DEFAULT_TIMEOUT_SECONDS = (() => {
	// 老名字 DSH_SUBAGENT_TIMEOUT_SECONDS 优先;DSH_SUBAGENT_TASK_TIMEOUT 是等价别名。
	const raw = process.env.DSH_SUBAGENT_TIMEOUT_SECONDS ?? process.env.DSH_SUBAGENT_TASK_TIMEOUT ?? 1800;
	const value = Number(raw);
	return Number.isFinite(value) && value > 0 ? value : 1800;
})();

/** 硬截止的宽限系数:deadline = startedAt + expectedSeconds × grace。 */
export const DEADLINE_GRACE = (() => {
	const value = Number(process.env.DSH_SUBAGENT_DEADLINE_GRACE ?? 2);
	return Number.isFinite(value) && value > 0 ? value : 2;
})();

/**
 * 停滞探测间隔(秒)。
 *
 * 默认 30 而不是更小的值,是一个刻意的取舍:一次探测 "无进展" 本身可能只是
 * "子代理正在跑一条很久不吭声的命令"(例如长构建、长 sleep、长网络调用),
 * 而桥接层从外面看不出"在等命令"和"真卡死"的区别。间隔 × 次数(30 × 2)就是
 * "静默多少秒才算停滞"的容忍度,取 60s 能覆盖绝大多数正常的长命令,
 * 又远小于外层 timeout(1800s)。急用时把 DSH_SUBAGENT_WATCHDOG_INTERVAL 调到 5。
 */
export const DEFAULT_WATCHDOG_INTERVAL_SECONDS = (() => {
	const value = Number(process.env.DSH_SUBAGENT_WATCHDOG_INTERVAL ?? 30);
	return Number.isFinite(value) && value > 0 ? value : 30;
})();

/** 连续多少次探测无进展就判定停滞。 */
export const STALL_PROBES = (() => {
	const value = Number(process.env.DSH_SUBAGENT_STALL_PROBES ?? 2);
	return Number.isInteger(value) && value > 0 ? value : 2;
})();

/**
 * 判定停滞前的最小静默秒数(**防误杀的硬性护栏**)。
 *
 * 一次"慢模型响应"既不会让日志增长,也不会产生后代进程——只看"静止"会把这种
 * 完全正常的等待当成卡死。所以再叠加一道"静默时长"闸门:静默不到这个秒数,
 * 无论连续多少次探测静止都不杀。
 */
export const STALL_MIN_SECONDS = (() => {
	const value = Number(process.env.DSH_SUBAGENT_STALL_MIN_SECONDS ?? 180);
	return Number.isFinite(value) && value > 0 ? value : 180;
})();

/**
 * 进程树 CPU 增长到多少毫秒才算"有进展"(避免采样噪声被当成进展)。
 * 未达阈值的小增量会累加,累计越阈值同样算进展。
 */
export const STALL_CPU_MS = (() => {
	const value = Number(process.env.DSH_SUBAGENT_STALL_CPU_MS ?? 200);
	return Number.isFinite(value) && value >= 0 ? value : 200;
})();

/**
 * "确实在干活"的 CPU 强度下限(毫秒)。防的是**"空转噪声"把静默时间无限重置**:
 *
 * 实测(本机,一个 `powershell → bash → bash → node(hang.mjs) → node(600s sleep)` 的六进程树,
 * 整棵树都阻塞在等一个 600s 的子进程上、日志 394 秒零增长)仍然以 **约 15~220ms / 每 10 秒**
 * 的速度烧 CPU —— 那是 IO 完成端口/定时器/调度开销,不是产出。如果"CPU 涨了就算有进展"
 * 一视同仁,这类**真挂起永远攒不满静默窗口**,看门狗就形同失效。
 *
 * 因此:树 CPU 在静默窗口内的累计增长低于这个下限时,CPU 信号**不算"在干活"**,
 * 允许静默窗口继续累积;超过下限则视为真在用 CPU 干活(即便没有日志)。
 * 量级参考:Proof B 那个静默但真干活的 30×Start-Sleep 任务,122 秒里树 CPU 涨了 2750ms ⇒ 180 秒
 * 远高于此下限,不会被误判。
 */
export const STALL_CPU_WORK_FLOOR_MS = (() => {
	const value = Number(process.env.DSH_SUBAGENT_STALL_CPU_WORK_FLOOR_MS ?? 1500);
	return Number.isFinite(value) && value >= 0 ? value : 1500;
})();

/** 并发闸门:同一时刻最多几个 DSH 实例。 */
const gate = new Gate(Number(process.env.DSH_SUBAGENT_MAX_CONCURRENCY ?? 4));

/** 进程内活跃任务的句柄:id → { child, done, cancelled, id, startedMs, … }。 */
const live = new Map();

/** 停滞看门狗持有的每任务取证:lastProgressAt / progressBytes / stalledProbes / 日志指纹 / 进程树。 */
const progress = new Map();

/** 看门狗定时器(懒启动,unref 后不阻止进程退出)。 */
let watchdogTimer = null;

/** 校验并规范化工作空间路径。 */
export function resolveWorkspace(input) {
	const path = resolve(input !== undefined && input !== null && String(input).trim() !== '' ? String(input) : process.cwd());
	let stat;
	try {
		stat = statSync(path);
	} catch {
		throw new Error(`工作空间不存在: ${path}`);
	}
	if (!stat.isDirectory()) throw new Error(`工作空间不是目录: ${path}`);
	return path;
}

/** 结束整个进程树(DSH 会 spawn pwsh 等子进程)。**发完就不管**,用于本进程自己
 * 拉起的任务(那些任务的终态由运行器自己落盘)。 */
export function killTree(pid) {
	if (!Number.isInteger(pid) || pid <= 0) return;
	try {
		const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
		killer.on('error', () => {});
	} catch {
		/* 进程可能已经退出 */
	}
}

/**
 * 强杀整个进程树并**等它真的结束**(给不属于本进程的任务用)。
 *
 * 为什么不能用上面那个:`spawn` 版发完就返回、也不看 taskkill 的结果,于是"强杀失败"
 * (权限不足 / pid 已变 / taskkill 起不来)也会被当成成功报给调用方 —— 调用方以为
 * 卡死的任务已经停了,进程树还在后台烧 CPU。`execFileSync` 会等 taskkill 退出,
 * 而 taskkill **只在确实终止了进程时才返回 0**,所以"报成功"这件事本身是被验证过的。
 *
 * @param pid - 目标进程 pid。
 * @returns {{ok:boolean, note:string}} 是否确认终止。
 */
export function killTreeSync(pid) {
	if (!Number.isInteger(pid) || pid <= 0) return { ok: false, note: 'pid 无效或缺失' };
	try {
		execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
		return { ok: true, note: '进程树已终止' };
	} catch (error) {
		return { ok: false, note: `taskkill 未确认终止(退出码 ${error?.status ?? '?'})` };
	}
}

/** 文件字节数;不存在或不可读时返回 0。比读文本便宜,适合高频探测。 */
function fileBytes(path) {
	try {
		return statSync(path).size;
	} catch {
		return 0;
	}
}

/**
 * 把工作空间路径编码成 DSH 会话目录名(与 DSH 的落盘规则一致):
 * 非 ASCII 字符写成 ~XXXX(码位大写十六进制),其余非字母数字字符折叠成 '-'。
 * @param path - 绝对路径。
 * @returns 会话目录名。
 */
export function workspaceKey(path) {
	const text = resolve(path);
	let out = '';
	for (let index = 0; index < text.length; index += 1) {
		const char = text[index];
		if (/[A-Za-z0-9]/.test(char)) {
			out += char;
			continue;
		}
		if (char.charCodeAt(0) > 0x7f) {
			out += `~${char.codePointAt(0).toString(16).toUpperCase()}`;
			continue;
		}
		if (!out.endsWith('-')) out += '-';
	}
	return out;
}

/**
 * 定位子进程会话日志。stderr.log 自带推理流,会话日志是"真的写进了事件流"的第二重证据。
 * 文件名随 DSH 版本变过(0.1.5 起是 `session.v3.jsonl.zstd`),这里交给 session-log 模块
 * 按 `session*.jsonl.zstd` 统一找 —— 原先硬编码旧名,升级后所有新会话都静默找不到。
 * @param record - 任务记录(需要 sessionId)。
 * @returns 日志文件绝对路径,或 null。
 */
function sessionLogPath(record) {
	const sessionId = typeof record.sessionId === 'string' && record.sessionId !== '' ? record.sessionId : '';
	if (sessionId === '') return null;
	return findSessionLog(sessionId);
}

/**
 * 体检:这次会话里有多少次 shell 调用是"空转成功"的。
 *
 * 只看会话日志(最硬的证据),读不到就当作 0 —— 体检失败不能影响任务本身的结论。
 * @param record - 终态任务记录(需要 sessionId)。
 * @returns {{count:number, samples:Array<{name:string,command:string}>}}
 */
function hollowShellCalls(record) {
	const file = sessionLogPath(record);
	if (file === null) return { count: 0, samples: [] };
	try {
		const text = decodeSessionLog(file);
		if (text === '') return { count: 0, samples: [] };
		return detectHollowShellCalls(parseSessionLog(text));
	} catch {
		return { count: 0, samples: [] };
	}
}

/**
 * 进度指纹:只有"真的在干活"才会变。时间戳类变化一律不计入。
 *
 * 注意:**mtime 不可信**(部分环境里,安全软件的文件过滤会让写出的文件 mtime 停在
 * 创建时刻 —— 实测某个 stderr.log 涨到 18KB 而 mtime 一直没变),所以这里只看字节数,
 * 绝不看 mtime。
 * @param record - 任务记录。
 * @returns {{fingerprint:string, bytes:number, parts:object}}
 */
function fingerprintOf(record) {
	const dir = taskDir(record.id);
	const stderrBytes = fileBytes(join(dir, 'stderr.log'));
	const stdoutBytes = fileBytes(join(dir, 'stdout.log'));
	const resultBytes = fileBytes(join(dir, 'result.txt'));
	const logPath = sessionLogPath(record);
	const sessionBytes = logPath === null ? 0 : fileBytes(logPath);
	const status = String(record.status ?? '');
	const parts = { stderrBytes, stdoutBytes, resultBytes, sessionBytes, status };
	return {
		fingerprint: [status, stderrBytes, stdoutBytes, resultBytes, sessionBytes].join(':'),
		bytes: stderrBytes + stdoutBytes + resultBytes + sessionBytes,
		parts: { ...parts, sessionLog: logPath },
	};
}

/** 把进度取证写回 task.json(保留磁盘上的最新状态)。 */
function persistProgress(id, extra) {
	const dir = taskDir(id);
	const record = readJson(join(dir, 'task.json'));
	if (record === undefined) return;
	writeJson(join(dir, 'task.json'), { ...record, ...extra });
}

/* ------------------------------------------------------------------ *
 * 进程树活动探测
 *
 * 为什么必须看进程树:实测(job 20260911-090547-5330370a)有一类完全正常的任务
 * 会让 stderr.log 与会话日志 6 分钟一个字节都不涨——子代理正卡在**一个长时间静默
 * 的工具调用**里(powershell.exe → bash.exe → 嵌套 bash.exe,新的后代进程隔几分钟
 * 冒一个出来,根进程 CPU 时间一直在涨)。只看日志字节数会把这种任务误判为卡死。
 *
 * 采样策略:每个探测周期**只跑一次**快照(所有任务共用,见 treeSnapshot()),
 * 用 Get-CimInstance 一次性拿到全部进程的 ParentProcessId + 内核/用户态 CPU 时间,
 * 再在内存里从任务 pid 往下走后代。绝不"每个后代起一个进程"。
 * wmic 在本机不存在(实测 ENOENT),所以只走 PowerShell 这条路。
 * ------------------------------------------------------------------ */

/** CPU 时间单位:Win32_Process 的 Kernel/UserModeTime 是 100ns。 */
const CPU_TICK_MS = 0.0001;

/** 快照缓存时长(毫秒):同一探测周期内多个任务共用一次采样。 */
const TREE_SNAPSHOT_TTL_MS = 8000;

/** 进程树快照:{ at, rows: Map<pid,{ppid,kernel,user}> } | { at, error } */
let treeSnapshotCache = null;

/** 只告警一次,避免刷屏。 */
let treeProbeWarned = false;

/** 每个任务第一次探测时的树基线(pid → 当时的 CPU ticket 总和)。 */
const treeBaselines = new Map();

/**
 * 取一次全机进程快照(带缓存)。失败时返回 { error } 且**绝不抛异常**:
 * 测不到 CPU 就只能退回"只看日志字节数 + 最小静默窗口",不能因为量不到就杀任务。
 *
 * 以 `treeSnapshot`/`probeTree` 形式导出只是为了让测试能直接验证这两个信号,
 * 正常调用路径仍然只通过 evaluateWatchdog 使用。
 * @returns {{at:number, rows?:Map<number,object>, error?:string}}
 */
export function treeSnapshot() {
	const now = Date.now();
	if (treeSnapshotCache !== null && now - treeSnapshotCache.at < TREE_SNAPSHOT_TTL_MS) return treeSnapshotCache;

	const shell = process.env.DSH_SUBAGENT_PS ?? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
	const script = [
		'$ErrorActionPreference = "Stop"',
		'Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,KernelModeTime,UserModeTime -ErrorAction Stop |',
		'  ForEach-Object { "{0},{1},{2},{3}" -f $_.ProcessId, $_.ParentProcessId, [uint64]$_.KernelModeTime, [uint64]$_.UserModeTime }',
	].join('\n');
	try {
		const stdout = execFileSync(shell, ['-NoProfile', '-NonInteractive', '-Command', script], {
			encoding: 'utf8',
			timeout: Number(process.env.DSH_SUBAGENT_TREE_PROBE_TIMEOUT_MS ?? 15000),
			windowsHide: true,
			maxBuffer: 64 * 1024 * 1024,
		});
		const rows = new Map();
		for (const line of stdout.split(/\r?\n/)) {
			const parts = line.trim().split(',');
			if (parts.length !== 4) continue;
			const pid = Number(parts[0]);
			const ppid = Number(parts[1]);
			const kernel = Number(parts[2]);
			const user = Number(parts[3]);
			if (!Number.isFinite(pid) || pid <= 0) continue;
			rows.set(pid, {
				ppid: Number.isFinite(ppid) ? ppid : 0,
				kernel: Number.isFinite(kernel) ? kernel : 0,
				user: Number.isFinite(user) ? user : 0,
			});
		}
		treeSnapshotCache = rows.size > 1 ? { at: now, rows } : { at: now, error: '进程快照为空' };
	} catch (error) {
		treeSnapshotCache = { at: now, error: error instanceof Error ? error.message : String(error) };
	}
	if (treeSnapshotCache.error !== undefined && !treeProbeWarned) {
		treeProbeWarned = true;
		process.stderr.write(`dsh-subagent: 进程树探测不可用(${treeSnapshotCache.error});停滞判定退化为"日志字节数 + 最小静默窗口"模式\n`);
	}
	return treeSnapshotCache;
}

/**
 * 从任务 pid 出发走一遍后代,得出"这棵树还在动吗"。
 * @param pid - 子进程根 pid。
 * @param previous - 上一次的探测结果(用于比较 CPU 与后代集合)。
 * @returns {{available:boolean,error?:string,cpuTickets:number,cpuTimeMs:number,deltaCpuMs:number,descendants:number[],newDescendants:boolean,alive:boolean}}
 */
export function probeTree(pid, previous) {
	const snapshot = treeSnapshot();
	if (snapshot.rows === undefined) {
		return {
			available: false,
			error: snapshot.error ?? 'unknown',
			cpuTickets: previous?.cpuTickets ?? 0,
			cpuTimeMs: previous?.cpuTimeMs ?? 0,
			deltaCpuMs: 0,
			descendants: previous?.descendants ?? [],
			newDescendants: false,
			alive: processAlive(pid),
		};
	}
	const childrenOf = new Map();
	for (const [childPid, row] of snapshot.rows) {
		const list = childrenOf.get(row.ppid);
		if (list === undefined) childrenOf.set(row.ppid, [childPid]);
		else list.push(childPid);
	}
	// 广度优先走子树(深度上限只是防御性的:进程树不会深到那种程度)。
	const descendants = [];
	const queue = [pid];
	for (let depth = 0; queue.length > 0 && depth < 24; depth += 1) {
		const next = [];
		for (const current of queue) {
			for (const child of childrenOf.get(current) ?? []) {
				descendants.push(child);
				next.push(child);
			}
		}
		queue.length = 0;
		queue.push(...next);
	}
	const sumCpu = (list) => list.reduce((total, target) => {
		const row = snapshot.rows.get(target);
		return total + (row === undefined ? 0 : row.kernel + row.user);
	}, 0);
	// 快照里查不到根进程时,CPU 求和会凭空"变小"(例如快照漏了某个新起的进程、
	// 或进程刚退出还没被回收)。**绝不能把这种测量缺口当成"有进展"**:把相对增量的
	// 下限钉在 0,作为进展信号它无害(增量要 >0 才算进展),但不会再出现负数。
	const measuredCpuTickets = sumCpu([pid]) + sumCpu(descendants);
	const cpuTickets = previous === undefined ? measuredCpuTickets : Math.max(previous.cpuTickets, measuredCpuTickets);
	const known = previous?.descendants;
	const newDescendants = known !== undefined
		&& known.length > 0
		&& descendants.some((child) => !known.includes(child));
	return {
		available: true,
		cpuTickets,
		cpuTimeMs: Math.round(cpuTickets * CPU_TICK_MS),
		deltaCpuMs: previous === undefined ? 0 : Math.max(0, Math.round((cpuTickets - previous.cpuTickets) * CPU_TICK_MS)),
		descendants,
		newDescendants,
		// 快照里没有 + 也没有后代,但进程其实还活着(pid 仍可寻址):仍算活着,
		// 这种"测不到"的情形应当由静默窗口兜底,而不是被误当成"进程已死"。
		alive: snapshot.rows.has(pid) || descendants.length > 0 || processAlive(pid),
	};
}

/** 把进程树的测量结果落盘,让 GUI/调用方看得见"树在不在动"。 */
function persistTree(id, probe) {
	persistProgress(id, {
		descendants: probe.available ? probe.descendants.length : null,
		descendantPids: probe.available ? probe.descendants.slice(0, 20) : null,
		treePids: probe.available ? probe.descendants.slice().sort((a, b) => a - b) : null,
		cpuTimeMs: probe.available ? probe.cpuTimeMs : null,
		treeCpuMs: probe.available ? probe.cpuTimeMs : null,
		treeProbeError: probe.available ? null : probe.error ?? 'unknown',
		signalState: probe.signalState ?? null,
		lastProgressAt: progress.get(id)?.lastProgressAt ?? null,
		progressBytes: progress.get(id)?.bytes ?? null,
		stalledProbes: progress.get(id)?.stalled ?? 0,
	});
}

/**
 * 调用方轮询时的进度观测:把现场字节数刷进 lastProgressAt / progressBytes。
 *
 * 只动"取证"字段,绝不碰 stalledProbes:轮询本身不是产出,
 * 不能因为有人看了一眼就把"停滞计数"清零。
 * @param id - 任务 id。
 * @param bytes - 现场累计产出字节数(stderr+stdout+result)。
 * @returns {{lastProgressAt:string|null, progressBytes:number}}
 */
export function observeProgress(id, bytes) {
	const record = readJson(join(taskDir(id), 'task.json'));
	if (record === undefined) return { lastProgressAt: null, progressBytes: bytes };
	const previous = Number.isFinite(Number(record.progressBytes)) ? Number(record.progressBytes) : 0;
	const lastProgressAt = bytes > previous ? new Date().toISOString() : (record.lastProgressAt ?? null);
	if (bytes > previous) {
		writeJson(join(taskDir(id), 'task.json'), { ...record, progressBytes: bytes, lastProgressAt });
		// 调用方看到的新增产出也是产出:把看门狗的静默时钟一起往后推,
		// 否则"没人轮询"的任务会被自己的静默计时误判。
		const facts = progress.get(id);
		if (facts !== undefined) progress.set(id, { ...facts, lastProgressMs: Date.now(), lastProgressAt });
	}
	return { lastProgressAt, progressBytes: Math.max(previous, bytes) };
}

/**
 * 从 runner 写出的 meta.json 推导状态。
 */
function statusFromMeta(meta) {
	if (meta === undefined || meta === null) return null;
	return meta.stopReason === 'completed' ? 'ok' : 'error';
}

/**
 * 读取任务当前状态:优先磁盘记录,必要时用 meta.json 或 pid 存活性兜底。
 * @param id - 任务 id。
 * @returns 任务记录(含 result 文本)。
 */
export function taskState(id) {
	const dir = taskDir(id);
	const record = readJson(join(dir, 'task.json'));
	if (record === undefined) throw new Error(`任务不存在: ${id}`);
	const meta = readJson(join(dir, 'meta.json'));
	if (record.status === 'running' && !live.has(id)) {
		const derived = statusFromMeta(meta);
		if (derived !== null) {
			record.status = derived;
			record.derived = true;
		} else if (!processAlive(record.pid)) {
			record.status = 'lost';
		}
	}
	const result = readText(join(dir, 'result.txt')) || readText(join(dir, 'stdout.log'));
	const deadlineMs = Date.parse(String(record.deadlineAt ?? ''));
	const remainingSeconds = Number.isFinite(deadlineMs)
		? Math.max(0, Math.round((deadlineMs - Date.now()) / 1000))
		: null;
	// 进程树摘要:让调用方一眼看清"静默的任务其实在干活"。
	const liveFacts = live.has(id) ? progress.get(id) : undefined;
	const treeLine = liveFacts?.tree?.available === true
		? `后代 ${liveFacts.tree.descendants.length} 个 / 树 CPU ${liveFacts.tree.cpuTimeMs}ms / 根进程存活 ${liveFacts.tree.alive ? '是' : '否'}`
		: null;
	return {
		...record,
		result,
		resultChars: result.length,
		sessionId: record.sessionId ?? meta?.sessionId ?? null,
		stopReason: meta?.stopReason ?? null,
		modelUsed: meta?.model ?? null,
		caller: typeof record.caller === 'string' && record.caller !== '' ? record.caller : 'unknown',
		callerVersion: record.callerVersion ?? null,
		expectedSeconds: Number.isFinite(Number(record.expectedSeconds)) ? Number(record.expectedSeconds) : null,
		remainingSeconds: record.status === 'running' ? remainingSeconds : null,
		queuedSeconds: queuedSecondsOf(record),
		silenceSeconds: liveFacts === undefined ? (record.silenceSeconds ?? null) : Math.round((Date.now() - liveFacts.lastProgressMs) / 1000),
		treeSummary: treeLine,
		signalState: liveFacts?.signalState ?? record.signalState ?? null,
		taskDir: dir,
	};
}

/** 任务是否还在排队(已登记、但还没拿到并发名额)。 */
function queuedSecondsOf(record) {
	if (record.status !== 'running') return null;
	const handle = live.get(record.id);
	if (handle === undefined || handle.child !== null) return null;
	const startMs = typeof handle.startedMs === 'number' ? handle.startedMs : Date.parse(String(record.startedAt ?? ''));
	if (!Number.isFinite(startMs)) return null;
	return Math.max(0, Math.round((Date.now() - startMs) / 1000));
}

/** 等待任务结束,或等到 waitMs 毫秒超时。 */
export async function waitForTask(id, waitMs) {
	const handle = live.get(id);
	if (process.env.DSH_SUBAGENT_DEBUG !== undefined) {
		process.stderr.write(`[debug] waitForTask id=${id} hasHandle=${handle !== undefined} waitMs=${waitMs} liveIds=${[...live.keys()].join(',')}\n`);
	}
	if (handle === undefined || waitMs <= 0) return taskState(id);
	await Promise.race([handle.done, new Promise((done) => setTimeout(done, waitMs))]);
	return taskState(id);
}

/** 取消任务:结束进程树并标记状态;还在排队(未 spawn)的任务直接标记为已取消。 */
export function cancelTask(id) {
	const dir = taskDir(id);
	const record = readJson(join(dir, 'task.json'));
	if (record === undefined) throw new Error(`任务不存在: ${id}`);
	const handle = live.get(id);
	if (handle === undefined || record.status !== 'running') {
		return { id, cancelled: false, note: '任务不在本进程内运行(已结束或由其他进程启动),无法取消' };
	}
	handle.cancelled = true;
	if (handle.child !== null) {
		killTree(handle.child.pid);
		return { id, cancelled: true, note: '已请求终止(进程树)' };
	}
	// 还没拿到并发名额:立刻落终态,排到队时不会再启动。
	const cancelled = {
		...record,
		status: 'cancelled',
		finishedAt: new Date().toISOString(),
		error: '任务在排队等待并发名额时被取消',
	};
	writeJson(join(dir, 'task.json'), cancelled);
	return { id, cancelled: true, note: '任务在排队等待并发名额,已标记取消(不会启动)' };
}

/**
 * 强杀任务:kill 掉整个进程树并落终态 status="killed"。
 * 与 cancelTask 的区别:cancel 是"礼貌请求"(先标记,由退出路径收尾),
 * kill 是"立刻按住"(立即杀进程树),给调用方一个确定可控的停止手段。
 * @param id - 任务 id。
 * @param reason - 落盘/回传的原因文本。
 * @returns 该任务的处理结论。
 */
export function killTask(id, reason = '调用方要求强制终止') {
	const dir = taskDir(id);
	const record = readJson(join(dir, 'task.json'));
	if (record === undefined) throw new Error(`任务不存在: ${id}`);
	const status = String(record.status ?? '');
	if (status !== 'running') {
		return { job_id: id, killed: false, caller: record.caller ?? 'unknown', status, note: `任务已结束(status=${status}),无需终止` };
	}
	const handle = live.get(id);
	// 记录说在跑,但要确认它真的还活着:桥接重启会留下僵尸记录。
	if (handle === undefined && !processAlive(record.pid)) {
		return { job_id: id, killed: false, caller: record.caller ?? 'unknown', status: 'lost', note: '进程已不存在(疑似桥接重启),记录收敛为 lost' };
	}
	if (handle !== undefined) {
		handle.cancelled = true;
		handle.finishMode = 'killed';
		handle.finishError = reason;
		if (handle.child !== null) killTree(handle.child.pid);
		if (typeof handle.trigger === 'function') handle.trigger('killed', reason);
	} else {
		// 不是本进程启动的(例如桥接重启前留下的任务):只能按 pid 杀进程树。
		// 这一步**要验证**:验证不了就如实回报失败,而不是把"已强杀"写在一条还活着的进程上。
		const outcome = killTreeSync(record.pid);
		if (!outcome.ok) {
			return {
				job_id: id,
				killed: false,
				caller: record.caller ?? 'unknown',
				status: record.status,
				pid: record.pid ?? null,
				note: `强杀失败:${outcome.note};进程可能仍在运行,记录保持 ${record.status}`,
			};
		}
	}
	if (record.status === 'running' && (handle === undefined || handle.child === null)) {
		// 排队中或本进程外:直接落终态,避免留下永远 running 的记录。
		const finished = {
			...record,
			status: 'killed',
			finishedAt: new Date().toISOString(),
			error: reason,
		};
		writeJson(join(dir, 'task.json'), finished);
	}
	return {
		job_id: id,
		killed: true,
		caller: record.caller ?? 'unknown',
		status: 'killed',
		pid: record.pid ?? null,
		note: handle === undefined
			? '非本进程启动:已按 pid 强杀进程树(taskkill 已确认终止)并落终态'
			: '已强杀进程树',
	};
}

/**
 * 按调用方强杀:停掉某个 caller 发起的所有任务("停掉我起的所有东西")。
 *
 * **只杀真的在跑的**:台账里的 status 不可信(桥接被杀会留下幽灵记录),这里按 pid 判活,
 * 幽灵记录会被标成 `lost` 并放进 `stale` 数组回报,让调用方知道"这些早就没了,别以为自己还挂着"。
 *
 * @param caller - 调用方名字(task.json 的 caller)。
 * @param reason - 原因文本。
 * @returns {{caller:string,killed:object[],alreadyFinished:object[],stale:object[],notFound:boolean}}
 */
export function killByCaller(caller, reason = '调用方要求停掉自己起的全部任务') {
	const wanted = String(caller ?? '').trim();
	if (wanted === '') throw new Error('caller 不能为空');
	// 先把现场读全:强杀会立刻改写 task.json,不先过滤会漏掉后面的任务。
	const own = listTasks(500).filter((task) => (task.caller ?? 'unknown') === wanted);
	const running = own.filter((task) => task.status === 'running' && task.pidAlive === true);
	// 幽灵(记录说在跑、进程已消失):不杀,但必须回报,否则调用方以为自己还有一堆任务挂着。
	const stale = own.filter((task) => task.stale === true)
		.map((task) => ({ job_id: task.id, caller: task.caller, pid: task.pid ?? null, status: 'lost', startedAt: task.startedAt ?? null }));
	if (running.length === 0) {
		// notFound 的语义保持原样:"没有找到在跑的任务"。幽灵单独放在 stale 里回报,
		// 这样调用方看到的是"没在跑 + 这几条是幽灵",而不是"已强杀 0 个"。
		return { caller: wanted, killed: [], alreadyFinished: [], stale, notFound: true };
	}
	const killed = [];
	for (const task of running) killed.push(killTask(task.id, reason));
	return { caller: wanted, killed, alreadyFinished: [], stale, notFound: false };
}

/**
 * 台账里的记录是否**真的**还在跑:以 pid 存活为准,而不是信 task.json 里的 status。
 *
 * 为什么必须这样:`state/tasks` 是跨桥接进程共享的,**桥接被杀/退出的任务永远不会有人去改
 * 它的 status**,于是留下 status="running" 但 pid 早已消失的"幽灵记录"。实测踩过:
 * 108 条记录里 7 条号称在跑,其中 4 条是探针留下的幽灵 —— `--list` 和"按 caller 强杀"
 * 都照着 status 过滤,调用方会以为自己还挂着 4 个任务。
 *
 * @param record - task.json 内容。
 * @returns {{status:string, stale:boolean, pidAlive:boolean|null, derived:boolean}} 判定结果。
 */
function livenessOf(record) {
	const id = String(record.id ?? '');
	const claimedLive = record.status === 'running' || record.status === 'queued';
	if (!claimedLive) return { status: record.status, stale: false, pidAlive: null, derived: false };
	// 本进程内还有句柄 = 一定在跑,不必查 pid。
	if (live.has(id)) return { status: record.status, stale: false, pidAlive: true, derived: false };
	const meta = readJson(join(taskDir(id), 'meta.json'));
	const derivedStatus = statusFromMeta(meta);
	if (derivedStatus !== null) return { status: derivedStatus, stale: false, pidAlive: null, derived: true };
	const alive = processAlive(record.pid);
	if (alive) return { status: record.status, stale: false, pidAlive: true, derived: false };
	return { status: 'lost', stale: true, pidAlive: false, derived: true };
}

/** 列出最近任务。**状态按 pid 判活**(幽灵记录标成 lost 并带 stale:true)。 */
export function listTasks(limit = 20) {
	const entries = listDir(tasksRoot())
		.map((entry) => readJson(join(entry.path, 'task.json')))
		.filter((record) => record !== undefined)
		.map((record) => {
			const alive = livenessOf(record);
			return {
				...record,
				status: alive.status,
				// 给调用方的"别信 status,信我"标记:true = 这条记录不是本进程在跑且进程已不在。
				stale: alive.stale,
				pidAlive: alive.pidAlive,
				derived: alive.derived || record.derived === true,
				caller: typeof record.caller === 'string' && record.caller !== '' ? record.caller : 'unknown',
			};
		});
	entries.sort((a, b) => String(b.startedAt ?? '').localeCompare(String(a.startedAt ?? '')));
	return entries.slice(0, limit);
}

/**
 * 本进程内还在跑的每个任务一行摘要(给 dsh_health 用,含排队与进度取证)。
 * @returns 任务实时信息数组。
 */
export function liveTaskInfos() {
	const infos = [];
	for (const [id, handle] of live) {
		const record = readJson(join(taskDir(id), 'task.json'));
		if (record === undefined) continue;
		const facts = progress.get(id);
		const deadlineMs = Date.parse(String(record.deadlineAt ?? ''));
		infos.push({
			job_id: id,
			caller: record.caller ?? 'unknown',
			callerVersion: record.callerVersion ?? null,
			workspace: record.workspace ?? null,
			status: record.status ?? null,
			pid: record.pid ?? null,
			spawned: handle.child !== null,
			startedAt: record.startedAt ?? null,
			deadlineAt: record.deadlineAt ?? null,
			remainingSeconds: Number.isFinite(deadlineMs) ? Math.max(0, Math.round((deadlineMs - Date.now()) / 1000)) : null,
			expectedSeconds: Number.isFinite(Number(record.expectedSeconds)) ? Number(record.expectedSeconds) : null,
			lastProgressAt: facts?.lastProgressAt ?? record.startedAt ?? null,
			progressBytes: facts?.bytes ?? null,
			stalledProbes: facts?.stalled ?? 0,
			silenceSeconds: facts === undefined ? null : Math.round((Date.now() - facts.lastProgressMs) / 1000),
			// 进程树活动:静默的日志 + 还在动的树 = 正常工作,不是卡死。
			cpuTimeMs: facts?.tree?.available === true ? facts.tree.cpuTimeMs : null,
			descendants: facts?.tree?.available === true ? facts.tree.descendants.length : null,
			treeProbeError: facts?.tree !== undefined && facts.tree.available === false ? facts.tree.error ?? 'unknown' : null,
			queuedSeconds: queuedSecondsOf(record),
			label: record.label ?? null,
		});
	}
	infos.sort((a, b) => String(a.startedAt ?? '').localeCompare(String(b.startedAt ?? '')));
	return infos;
}

/**
 * 每个调用方当前有几个任务在跑(给 dsh_health 的分组统计)。
 * @returns [{caller, running, queued, jobIds}] 按 running 降序。
 */
export function callerStats() {
	const byCaller = new Map();
	for (const info of liveTaskInfos()) {
		const key = info.caller ?? 'unknown';
		const entry = byCaller.get(key) ?? { caller: key, running: 0, queued: 0, jobIds: [] };
		entry.running += 1;
		if (info.queuedSeconds !== null) entry.queued += 1;
		entry.jobIds.push(info.job_id);
		byCaller.set(key, entry);
	}
	return [...byCaller.values()].sort((a, b) => b.running - a.running || a.caller.localeCompare(b.caller));
}

/**
 * 单个任务的停滞判定 —— **任一信号推进即算有进展**。
 *
 * 信号清单(每次探测采一遍,结果记进 signalState 便于复盘):
 *   日志类(只看字节数,不用 mtime —— 见 fingerprintOf 的说明):
 *     stderrBytes / stdoutBytes / resultBytes / sessionBytes;
 *   进程树类(**一次** Get-CimInstance 快照,内存里做父子遍历):
 *     根进程是否存活、后代 pid 集合、整棵树累计 CPU(Kernel+User,毫秒)。
 *
 * 有进展 = 任一字节数变化 ∨ 后代集合变化 ∨ 树 CPU 累计增长 ≥ STALL_CPU_MS
 *          ∨ 调用方轮询看到的新增产出。
 * 只有**全部**信号零变化、且静默已达最小窗口、且窗口内连续 STALL_PROBES 次探测
 * 都零变化,才会杀树。
 *
 * 快照取不到时按"未知"处理:进程树类信号一律不参与判定,靠日志信号 + 静默窗口
 * 兜底(测不到 ≠ 没有进展,绝不允许探测失败导致误杀)。
 */
function evaluateWatchdog(id, handle, record) {
	const facts = progress.get(id);
	if (facts === undefined) return;
	const waitMs = DEFAULT_WATCHDOG_INTERVAL_SECONDS * 1000;
	// 首个探测窗口没走完之前绝不下手:刚起来的任务本来就还没有输出。
	if (!Number.isFinite(facts.lastProgressMs) || Date.now() - facts.lastProgressMs < waitMs) return;

	const nowMs = Date.now();
	const { fingerprint, parts } = fingerprintOf(record);
	const bytes = parts.stderrBytes + parts.stdoutBytes + parts.resultBytes + parts.sessionBytes;
	// 第一次采样时把当时已烧掉的 CPU 当作基线;之后所有比较都是"相对基线"的增量。
	if (!treeBaselines.has(id)) treeBaselines.set(id, probeTree(handle.child.pid, undefined).cpuTickets);
	const rootTickets = treeBaselines.get(id);
	const previous = facts.tree;
	const probe = probeTree(handle.child.pid, previous);
	const relativeCpuTickets = probe.cpuTickets - rootTickets;
	const cpuTimeMs = Math.max(0, Math.round(relativeCpuTickets * CPU_TICK_MS));
	const previousSilence = facts.sample;

	// —— 逐信号比对 ——
	const priorBytes = previousSilence?.bytes;
	const logChanged = priorBytes === undefined || previousSilence.fingerprintMissing === true
		? true
		: bytes !== priorBytes;
	const sessionChanged = previousSilence?.sessionBytes === undefined ? true : parts.sessionBytes !== previousSilence.sessionBytes;
	const priorCpuMs = previousSilence?.cpuMs;
	const cpuDeltaMs = priorCpuMs === undefined ? 0 : Math.max(0, cpuTimeMs - priorCpuMs);
	// 累计未达阈值的小增量(纯诊断值:分析"这棵树到底有没有在动")。
	const cpuAccumMs = (priorCpuMs === undefined ? 0 : (previousSilence.cpuAccumMs ?? 0)) + cpuDeltaMs;
	// 单轮 CPU 突增(≥ STALL_CPU_MS)算一次明确的进展信号。
	const cpuSpike = probe.available && cpuDeltaMs >= STALL_CPU_MS;
	const priorPids = previousSilence === undefined ? undefined : (previousSilence.treePids ?? []);
	const treePids = probe.available ? probe.descendants.slice().sort((a, b) => a - b) : null;
	const descendantsChanged = treePids !== null && priorPids !== undefined
		&& (treePids.length !== priorPids.length || treePids.some((pid, index) => pid !== priorPids[index]));
	// 调用方轮询也会把 progressBytes 往前推:那份"产出"同样是产出,不能被无视。
	const externalProgress = Number.isFinite(Number(record.progressBytes)) && Number(record.progressBytes) > bytes;

	// —— 进程树 CPU 必须按"窗口内的速率"来判断,不能按单轮增量 ——
	// 实测教训:一个六进程树整棵树阻塞在等 600s 子进程上时,单轮仍会偶发 200ms+ 的尖峰
	// (IO 完成端口/定时器开销),按单轮阈值判定就会被这种尖峰反复重置静默窗口,
	// 结果真挂起永远攒不满窗口。所以只承认"静默窗口内累计增长 ≥ 下限"的 CPU 强度。
	const cpuHistory = [...(facts.cpuHistory ?? []), { at: nowMs, ms: cpuTimeMs }]
		.filter((point) => nowMs - point.at <= STALL_MIN_SECONDS * 1000 || point.ms === cpuTimeMs);
	const windowAnchor = cpuHistory.find((point) => nowMs - point.at <= STALL_MIN_SECONDS * 1000) ?? { ms: cpuTimeMs };
	// 窗口内树 CPU 的累计增长:低于下限 ⇒ 只是在空转(不算干活);达到下限 ⇒ 真在用 CPU。
	const windowCpuMs = probe.available ? Math.max(0, cpuTimeMs - windowAnchor.ms) : 0;
	const cpuWorking = probe.available && windowCpuMs >= STALL_CPU_WORK_FLOOR_MS;
	// 进程树信号 = 单轮 CPU 突增 ∨ 窗口内 CPU 强度达标 ∨ 后代进程集合变化。
	// 快照不可用时按"未知"处理:进程树信号一律不参与判定,由静默窗口兜底。
	const treeProgress = probe.available && (cpuSpike || cpuWorking || descendantsChanged);
	const progressed = logChanged || sessionChanged || treeProgress || externalProgress;

	/** 本轮各信号的值:进了终态就能复盘"为什么判它没进展"。 */
	const signalState = {
		at: new Date(nowMs).toISOString(),
		logBytes: bytes,
		stderrBytes: parts.stderrBytes,
		stdoutBytes: parts.stdoutBytes,
		resultBytes: parts.resultBytes,
		sessionBytes: parts.sessionBytes,
		logChanged,
		sessionChanged,
		treeAvailable: probe.available,
		treeError: probe.available ? null : probe.error ?? 'unknown',
		rootAlive: probe.alive,
		treePids,
		treeCpuMs: cpuTimeMs,
		cpuDeltaMs,
		cpuAccumMs,
		cpuThresholdMs: STALL_CPU_MS,
		cpuSpike,
		// 窗口内的 CPU 强度才是"在不在干活"的主判据(单轮尖峰会被 IO/定时器噪声制造出来)。
		windowCpuMs,
		cpuWorkFloorMs: STALL_CPU_WORK_FLOOR_MS,
		cpuWorking,
		descendantsChanged,
		externalProgress,
		progressed,
		progressReason: progressed
			? [logChanged ? '日志字节增长' : null, sessionChanged ? '会话日志字节增长' : null,
				probe.available && cpuWorking ? `树 CPU 窗口内 +${windowCpuMs}ms(≥ ${STALL_CPU_WORK_FLOOR_MS}ms 下限)` : null,
				probe.available && cpuSpike ? `树 CPU 单轮 +${cpuDeltaMs}ms(≥ ${STALL_CPU_MS}ms 阈值)` : null,
				probe.available && descendantsChanged ? '后代进程集合变化' : null,
				externalProgress ? '调用方轮询到新产出' : null].filter(Boolean).join(' / ')
			: '全部信号零变化',
	};
	const tree = { ...probe, cpuTickets: relativeCpuTickets, cpuTimeMs, treePids };
	const sample = {
		bytes,
		sessionBytes: parts.sessionBytes,
		cpuMs: cpuTimeMs,
		treePids: treePids ?? [],
		cpuAccumMs,
		fingerprintMissing: false,
	};

	if (progressed) {
		// 静默窗口从"最后一次真的动过"起算:每次进展都同时刷新基线并把计数清零。
		progress.set(id, {
			...facts,
			fingerprint,
			bytes,
			tree,
			sample,
			signalState,
			cpuHistory,
			lastProgressAt: new Date(nowMs).toISOString(),
			lastProgressMs: nowMs,
			silentWindowMs: null,
			stalled: 0,
			silentProbes: 0,
		});
		persistTree(id, { ...probe, cpuTimeMs, signalState });
		return;
	}

	// 探测到"静止"。**连续沉默计数**独立记录:只要中间出现任何一次"有进展",
	// 它就清零——这样才能表达"连续多次探测都静止",而不是"断断续续地静过几次"。
	const stalled = facts.stalled + 1;
	const silenceMs = nowMs - facts.lastProgressMs;
	const silenceSeconds = Math.round(silenceMs / 1000);
	// 只有"静默已越过最小窗口"之后发生的探测才计入连续静止计数;窗口之前的静默
	// 不计数(它本来就不该被判停滞)。任何一次"有进展"都会把它清零。
	const silentWindowMs = silenceMs >= STALL_MIN_SECONDS * 1000 ? (facts.silentWindowMs ?? nowMs) : null;
	const silentProbes = silentWindowMs === null ? 0 : (facts.silentProbes ?? 0) + 1;
	progress.set(id, { ...facts, fingerprint, bytes, tree, sample, signalState, cpuHistory, stalled, silentProbes, silentWindowMs });
	persistProgress(id, {
		lastProgressAt: facts.lastProgressAt,
		progressBytes: bytes,
		stalledProbes: stalled,
		silenceSeconds,
		silentProbes,
		cpuTimeMs,
		treeCpuMs: cpuTimeMs,
		treePids,
		descendants: treePids === null ? null : treePids.length,
		descendantPids: treePids === null ? null : treePids.slice(0, 20),
		treeProbeError: probe.available ? null : probe.error ?? 'unknown',
		signalState,
	});
	// 三道闸门同时满足才杀:静默已越过最小窗口、窗口内连续静止探测次数达标、当次探测真的测到了树。
	if (silentProbes < STALL_PROBES) return;

	const error = `进程树完全静止(最后一次观测到的动静: ${facts.lastProgressAt},已静默 ${silenceSeconds}s,`
		+ `窗口内连续 ${silentProbes} 次探测全部信号零变化;树 CPU ${cpuTimeMs}ms(+${cpuDeltaMs}ms/轮,阈值 ${STALL_CPU_MS}ms)、`
		+ `后代进程 ${treePids === null ? '未知' : `${treePids.length} 个`}、日志 ${bytes} 字节均无变化),已终止 dsh 进程`;
	persistProgress(id, {
		status: 'stalled',
		stalledProbes: stalled,
		silentProbes,
		silenceSeconds,
		lastProgressAt: facts.lastProgressAt,
		progressBytes: bytes,
		cpuTimeMs,
		cpuDeltaMs,
		treeCpuMs: cpuTimeMs,
		treePids,
		descendants: treePids === null ? null : treePids.length,
		descendantPids: treePids === null ? null : treePids.slice(0, 20),
		treeProbeError: probe.available ? null : probe.error ?? 'unknown',
		signalState,
		error,
	});
	if (typeof handle.trigger === 'function') handle.trigger('stalled', error);
	else {
		handle.cancelled = true;
		killTree(handle.child.pid);
	}
}

/** 看门狗 tick:只处理"本进程内、已经 spawn、还没被取消"的运行中任务。 */
function watchdogTick() {
	for (const [id, handle] of live) {
		if (handle.cancelled) continue;
		// 排队中的任务没有子进程也没有输出:不算停滞,调用方可以用 queuedSeconds 观察。
		if (handle.child === null) continue;
		const record = readJson(join(taskDir(id), 'task.json'));
		if (record === undefined || record.status !== 'running') continue;
		try {
			evaluateWatchdog(id, handle, record);
		} catch (error) {
			// 探测本身出错绝不允许升级为"杀掉任务":只记日志,下一次再来。
			if (process.env.DSH_SUBAGENT_DEBUG !== undefined) {
				process.stderr.write(`[debug] watchdog ${id} 探测失败: ${error instanceof Error ? error.message : String(error)}\n`);
			}
		}
	}
}

/** 懒启动看门狗。 */
function ensureWatchdog() {
	if (watchdogTimer !== null) return;
	if (process.env.DSH_SUBAGENT_WATCHDOG === 'off') return;
	watchdogTimer = setInterval(watchdogTick, DEFAULT_WATCHDOG_INTERVAL_SECONDS * 1000);
	watchdogTimer.unref?.();
}

/**
 * 启动一次 DSH 子代理会话。
 * @param options - prompt 必填;workspace / permission / model / provider /
 * reasoningEffort / timeoutSeconds / expectedSeconds / caller / callerVersion /
 * acceptance / label 可选。
 * @returns {{id:string,dir:string,record:object,done:Promise<object>}}
 */
export async function startTask(options) {
	const prompt = typeof options.prompt === 'string' ? options.prompt : '';
	if (prompt.trim() === '') throw new Error('prompt 不能为空');
	const workspace = resolveWorkspace(options.workspace);
	// 调用方必须自己预估耗时:这既是"想清楚要花多久"的强制动作,
	// 也是硬截止(deadline)的唯一来源,缺失时不做任何默认值兜底。
	const expectedSeconds = Number(options.expectedSeconds);
	if (!Number.isInteger(expectedSeconds) || expectedSeconds <= 0) {
		throw new Error('expectedSeconds 必须是正整数(调用方预估的秒数),用于计算硬截止时间');
	}
	const acceptance = typeof options.acceptance === 'string' && options.acceptance.trim() !== ''
		? clip(options.acceptance.trim().replace(/\s+/g, ' '), 600)
		: null;
	const caller = typeof options.caller === 'string' && options.caller.trim() !== '' ? options.caller.trim() : 'unknown';
	const callerVersion = typeof options.callerVersion === 'string' && options.callerVersion.trim() !== ''
		? options.callerVersion.trim()
		: null;
	const permission = options.permission && PERMISSIONS.includes(options.permission)
		? options.permission
		: DEFAULT_PERMISSION;
	const timeoutSeconds = Number.isFinite(Number(options.timeoutSeconds)) && Number(options.timeoutSeconds) > 0
		? Number(options.timeoutSeconds)
		: DEFAULT_TIMEOUT_SECONDS;

	const id = newTaskId();
	const dir = ensureDir(taskDir(id));
	const promptPath = join(dir, 'prompt.md');
	const resultPath = join(dir, 'result.txt');
	const metaPath = join(dir, 'meta.json');
	const stdoutPath = join(dir, 'stdout.log');
	const stderrPath = join(dir, 'stderr.log');
	const taskPath = join(dir, 'task.json');

	writeText(promptPath, prompt);

	const startedMs = Date.now();
	const startedAt = new Date(startedMs).toISOString();
	const deadlineAt = new Date(startedMs + expectedSeconds * DEADLINE_GRACE * 1000).toISOString();

	const record = {
		id,
		status: 'running',
		pid: null,
		workspace,
		// 调用方身份:task 一落盘就带上,GUI/观察器可以立刻按 caller 分组。
		caller,
		callerVersion,
		promptChars: prompt.length,
		promptPreview: clip(prompt.replace(/\s+/g, ' ').trim(), 240),
		permission,
		model: options.model ?? null,
		provider: options.provider ?? null,
		reasoningEffort: options.reasoningEffort ?? null,
		label: options.label ?? null,
		expectedSeconds,
		acceptance,
		deadlineGrace: DEADLINE_GRACE,
		startedAt,
		deadlineAt,
		lastProgressAt: startedAt,
		progressBytes: 0,
		stalledProbes: 0,
		dshHome: dshHome(),
		finishedAt: null,
		durationMs: null,
		exitCode: null,
		sessionId: null,
		stopReason: null,
		error: null,
		paths: { promptPath, resultPath, metaPath, stdoutPath, stderrPath, taskDir: dir },
	};
	writeJson(taskPath, record);

	const launcher = resolveLauncher();
	// 提示词走 stdin 而不是文件:不依赖"临时文件能被另一个进程原样读到"这个假设,
	// 也没有命令行长度上限。
	const args = [
		...launcher.args,
		'--profile', 'subagent',
		'--prompt-stdin',
		'--result-file', resultPath,
		'--metadata-file', metaPath,
	];
	if (typeof options.model === 'string' && options.model !== '') args.push('--model', options.model);
	if (typeof options.provider === 'string' && options.provider !== '') args.push('--provider', options.provider);
	if (typeof options.reasoningEffort === 'string' && options.reasoningEffort !== '') args.push('--reasoning-effort', options.reasoningEffort);

	const env = childEnv(launcher, { DSH_SUBAGENT_PERMISSION: permission });

	// 先登记句柄再排队:这样"还在等并发名额"的任务也看得见、也能被取消。
	const handle = { child: null, cancelled: false, id, startedMs, deadlineMs: Date.parse(deadlineAt), finished: false };
	live.set(id, handle);
	progress.set(id, {
		fingerprint: null,
		bytes: 0,
		lastProgressAt: startedAt,
		lastProgressMs: startedMs,
		stalled: 0,
		silentProbes: 0,
		silentWindowMs: null,
		cpuAtLastProgress: 0,
		tree: undefined,
	});
	ensureWatchdog();

	// 收尾入口:所有终态(正常结束 / 超时 / 硬截止 / 停滞 / 强杀)都从这里出去。
	let finish = (status, extra) => {
		// 还没拿到并发名额就出了终态:先落盘,排到队时由排队分支收尾。
		const terminalExtra = extra === undefined || extra.error === undefined
			? { ...(extra ?? {}), ...(handle.finishError === undefined ? {} : { error: handle.finishError }) }
			: extra;
		handle.cancelled = true;
		handle.pending = { status, extra: terminalExtra };
		finishError ??= handle.finishError;
		writeJson(taskPath, {
			...record,
			...terminalExtra,
			status,
			finishedAt: new Date().toISOString(),
			durationMs: Date.now() - startedMs,
		});
	};
	handle.trigger = (status, error) => {
		handle.cancelled = true;
		handle.finishMode = status;
		handle.finishError = error;
		const child = handle.child;
		if (child !== null) killTree(child.pid);
		finish(status, error === undefined ? undefined : { error });
	};

	const durationMs = () => Date.now() - startedMs;
	let finishError;

	// 名额在整轮任务期间持有,避免瞬间拉起过多 DSH 实例。
	const release = await gate.acquire();
	if (handle.cancelled) {
		// 排队期间被取消/被硬截止/被强杀:不启动子进程,直接落终态。
		live.delete(id);
		progress.delete(id);
		treeBaselines.delete(id);
		release();
		const pending = handle.pending ?? { status: 'cancelled', extra: { error: '任务在排队等待并发名额时被取消' } };
		const terminal = {
			...record,
			...pending.extra,
			status: pending.status,
			finishedAt: new Date().toISOString(),
			durationMs: durationMs(),
			...(finishError === undefined ? {} : { error: finishError }),
		};
		writeJson(taskPath, terminal);
		return { id, dir, record: terminal, done: Promise.resolve({ ...terminal, result: '', resultChars: 0, taskDir: dir }) };
	}
	const outFd = openSync(stdoutPath, 'a');
	const errFd = openSync(stderrPath, 'a');
	let child;
	try {
		child = spawn(launcher.command, args, {
			cwd: workspace,
			env,
			stdio: ['pipe', outFd, errFd],
			windowsHide: true,
		});
	} finally {
		closeSync(outFd);
		closeSync(errFd);
	}

	// 把提示词喂进子进程 stdin 并关闭,DSH 读完 EOF 后开始跑这一轮。
	child.stdin.on('error', () => {
		/* 子进程提前退出时忽略 EPIPE */
	});
	child.stdin.end(prompt, 'utf8');

	handle.child = child;
	record.pid = child.pid ?? null;
	writeJson(taskPath, record);

	let timeoutTimer;
	let deadlineTimer;
	const done = new Promise((settle) => {
		let finished = false;
		handle.finish = (status, extra = {}) => {
			if (finished) return;
			finished = true;
			handle.finished = true;
			clearTimeout(timeoutTimer);
			clearTimeout(deadlineTimer);
			release();
			live.delete(id);
			const meta = readJson(metaPath);
			// 先取看门狗取证,再删:终态里要留下"最后一次进展"的证据。
			// 看门狗每次探测都会把取证写进 task.json,所以以磁盘上的为准,
			// 否则这里的 record 快照(启动那一刻)会把取证覆盖回 0。
			const facts = progress.get(id);
			progress.delete(id);
			treeBaselines.delete(id);
			const measured = readJson(taskPath) ?? {};
			// 探测窗口之后才结束的短任务,看门狗可能一次都没跑过:
			// 这里再按现场字节数兜一次,保证终态记录里的产出量是真实的。
			const finalBytes = Math.max(
				facts?.bytes ?? 0,
				measured.progressBytes ?? 0,
				fileBytes(join(dir, 'stderr.log')) + fileBytes(join(dir, 'stdout.log')) + fileBytes(resultPath),
			);
			const finalProgressAt = facts?.lastProgressAt ?? measured.lastProgressAt ?? record.lastProgressAt ?? null;
			const next = {
				...record,
				...extra,
				status,
				finishedAt: new Date().toISOString(),
				durationMs: durationMs(),
				sessionId: meta?.sessionId ?? null,
				stopReason: meta?.stopReason ?? null,
				modelUsed: meta?.model ?? null,
				lastProgressAt: finalProgressAt,
				progressBytes: finalBytes,
				stalledProbes: facts?.stalled ?? measured.stalledProbes ?? 0,
				// 进程树取证也必须留在终态里:启动快照(record)里没有这些字段,
				// 不显式带过来就会被这份 record 覆盖掉,调用方就看不到"为什么判停滞"。
				silenceSeconds: extra.silenceSeconds ?? facts?.silenceSeconds ?? measured.silenceSeconds ?? null,
				silentProbes: extra.silentProbes ?? facts?.silentProbes ?? measured.silentProbes ?? null,
				cpuTimeMs: extra.cpuTimeMs ?? facts?.tree?.cpuTimeMs ?? measured.cpuTimeMs ?? null,
				treeCpuMs: extra.treeCpuMs ?? extra.cpuTimeMs ?? facts?.tree?.cpuTimeMs ?? measured.treeCpuMs ?? null,
				cpuDeltaMs: extra.cpuDeltaMs ?? measured.cpuDeltaMs ?? null,
				descendants: facts?.tree?.available === true ? facts.tree.descendants.length : (measured.descendants ?? null),
				treePids: extra.treePids ?? extra.descendantPids ?? (facts?.tree?.available === true ? facts.tree.descendants.slice().sort((a, b) => a - b) : (measured.treePids ?? null)),
				descendantPids: extra.descendantPids ?? extra.treePids ?? (facts?.tree?.available === true ? facts.tree.descendants.slice(0, 20) : (measured.descendantPids ?? null)),
				treeProbeError: extra.treeProbeError ?? measured.treeProbeError ?? null,
				signalState: extra.signalState ?? facts?.signalState ?? measured.signalState ?? null,
			};
			writeJson(taskPath, next);
			// 与 taskState() 保持同一形状:把最终答复一并交给调用方。
			let result = readText(resultPath) || readText(stdoutPath);
			// 执行面体检:沙箱档下 shell 工具会"空转成功"(命令没跑,却 isError=false)。
			// 这会让调用方以为模型没干活,所以必须由桥接层替它说出来。
			const hollow = hollowShellCalls(next);
			if (hollow.count > 0) {
				next.shellHollowCalls = hollow.count;
				next.shellHollowSamples = hollow.samples;
				writeJson(taskPath, next);
				result += hollowShellWarning(hollow.count, hollow.samples, record.permission);
			}
			settle({ ...next, result, resultChars: result.length, taskDir: dir });
		};
		finish = handle.finish;

		// 外层绝对上限:比调用方声明的 deadline 更宽松,只在极端情况下兜底。
		timeoutTimer = setTimeout(() => {
			handle.trigger('timeout', `超过 ${timeoutSeconds}s 上限,已终止`);
		}, timeoutSeconds * 1000);
		timeoutTimer.unref?.();

		// 硬截止:调用方声明 expectedSeconds × 宽限系数。比外层上限更紧,优先触发。
		deadlineTimer = setTimeout(() => {
			handle.trigger('deadline', `超出预估时间 ${expectedSeconds}s × grace ${DEADLINE_GRACE} 仍未完成,已终止`);
		}, Math.max(1000, expectedSeconds * DEADLINE_GRACE * 1000));
		deadlineTimer.unref?.();

		child.once('error', (error) => {
			handle.finish('error', { error: `无法启动 DSH 进程: ${error.message}` });
		});
		child.once('exit', (code) => {
			if (handle.cancelled) {
				// 已经由触发者落过终态(硬截止/停滞/强杀/取消):保留那个状态,只补退出码。
				const mode = handle.finishMode ?? 'cancelled';
				handle.finish(mode, {
					exitCode: code,
					error: handle.finishError ?? '已被调用方取消、超时或判定停滞',
				});
				return;
			}
			const meta = readJson(metaPath);
			if (code === 0) handle.finish('ok', { exitCode: code });
			else handle.finish('error', {
				exitCode: code,
				error: meta?.error?.message ?? `DSH 进程退出码 ${code}(详见 stderr.log)`,
			});
		});
	});

	// 关键:把完成 Promise 挂到句柄上,waitForTask 才能真的等待它。
	handle.done = done;

	return { id, dir, record, done };
}
