/**
 * 监控宿主的自动拉起:其它 harness 用 dsh_task 时,如果**没有任何带监控的 GUI 宿主在跑**,
 * best-effort 拉起一个 DSH Desktop,让"其它 harness 调 dsh_task"这件事本身能激活监控窗口
 * —— 哪怕用户压根没开 DSH UI。
 *
 * 判活协议(信号源在 `monitor/observer.mjs`,由宿主每 ~5 秒写一次):
 *   `$DSH_HOME/subagent/state/observer-heartbeat.json`
 *   `{"at":"…","epochMs":…,"pid":…,"engine":"dsh-desktop-observer","profile":"desktop",
 *     "pollMs":2000,"trackedTasks":N,"activeTasks":M}`
 *   心跳新鲜(`Date.now() - epochMs < 20000`,容忍漏 3~4 拍)⇒ 视为"有宿主",**什么都不做**。
 *
 * 为什么"有宿主就绝不重复启动":两个 GUI 宿主会同时写同一批会话日志,是 README §7.6 记的
 * 数据损坏风险。所以这里宁可少启动,也绝不多启动。
 *
 * 设计约束:
 *   - 只在 Windows 上做(其它平台直接跳过并记一行日志);
 *   - 一次性、best-effort:失败只写日志,**绝不让任务失败**;
 *   - 启动是 detached + unref 的**非阻塞** spawn,不会 await GUI 起来;
 *   - 冷却 `DSH_SUBAGENT_MONITOR_COOLDOWN_MS`(默认 60s)防抖,避免风暴式重复启动;
 *   - 总开关 `DSH_SUBAGENT_AUTOSTART_MONITOR`(默认开,`off`/`0`/`false` 关);
 *   - 判活**绝不只看心跳**(见下面 `ensureMonitorHost` 的三步规则):心跳会被自检写成残留文件,
 *     而"GUI 开着但跑旧版观察器"根本写不出心跳 —— 只看心跳就会拉起第二个宿主。
 *     测试逃生门 `DSH_SUBAGENT_MONITOR_HOST_CHECK=off` / `DSH_SUBAGENT_MONITOR_FORCE=1`。
 *
 * @module dsh-subagent/lib/monitor-host
 */
import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { dshHome, processAlive, readJson } from './util.mjs';

/** 心跳新鲜度阈值(毫秒):超过它视为"没有宿主在跑"。 */
export const HEARTBEAT_STALE_MS = (() => {
	const value = Number(process.env.DSH_SUBAGENT_MONITOR_HEARTBEAT_MS ?? 20000);
	return Number.isFinite(value) && value > 0 ? value : 20000;
})();

/** 两次自动拉起之间的最小间隔(毫秒)。 */
export const COOLDOWN_MS = (() => {
	const value = Number(process.env.DSH_SUBAGENT_MONITOR_COOLDOWN_MS ?? 60000);
	return Number.isFinite(value) && value >= 0 ? value : 60000;
})();

/** 总开关:默认开启;显式写 off/0/false 关闭。 */
export function autostartEnabled() {
	const raw = process.env.DSH_SUBAGENT_AUTOSTART_MONITOR;
	if (raw === undefined || String(raw).trim() === '') return true;
	const value = String(raw).trim().toLowerCase();
	return !['off', '0', 'false', 'no'].includes(value);
}

/**
 * 是否启用"已有 GUI 宿主进程就别再启动"的闸门(默认开)。
 *
 * 这是**测试逃生门**:默认行为就是"绝不重复启动";只有显式设
 * `DSH_SUBAGENT_MONITOR_HOST_CHECK=off` 或 `DSH_SUBAGENT_MONITOR_FORCE=1` 才会绕过,
 * 好让自检能确定性地验证"该拉起时真的会拉起"。
 */
function hostGuardEnabled() {
	const force = process.env.DSH_SUBAGENT_MONITOR_FORCE;
	if (force !== undefined && !['off', '0', 'false', 'no'].includes(String(force).trim().toLowerCase())) return false;
	const raw = process.env.DSH_SUBAGENT_MONITOR_HOST_CHECK;
	if (raw === undefined || String(raw).trim() === '') return true;
	return !['off', '0', 'false', 'no'].includes(String(raw).trim().toLowerCase());
}

/** 宿主进程映像名(默认 DSH Desktop;可覆盖,便于用别的进程做确定性测试)。 */
function hostProcessName() {
	const raw = process.env.DSH_SUBAGENT_MONITOR_HOST_PROCESS;
	return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : 'DSH Desktop.exe';
}

/** 心跳文件路径。**必须每次现算**:测试会用临时 DSH_HOME。 */
export function heartbeatPath() {
	return join(dshHome(), 'subagent', 'state', 'observer-heartbeat.json');
}

/** 拉起日志路径。 */
export function monitorHostLogPath() {
	return join(dshHome(), 'subagent', 'state', 'monitor-host.log');
}

/** 最近一次"拉起/跳过"的结果(进程内记忆;durable 记录在 monitor-host.log)。 */
let lastLaunch = null;

/** 上一次拉起尝试的时间戳(冷却用)。 */
let lastAttemptMs = 0;

/** 最近一次宿主进程探测结果(冷却期内复用,避免每个任务都跑一次 CIM 查询)。 */
let processCache = null;

/** 追加一行日志(best-effort,绝不抛)。 */
function logLine(line, extra) {
	const text = `${new Date().toISOString()} ${line}${extra === undefined ? '' : ` ${extra}`}\n`;
	try {
		mkdirSync(join(dshHome(), 'subagent', 'state'), { recursive: true });
		appendFileSync(monitorHostLogPath(), text, 'utf8');
	} catch {
		/* 日志失败不影响任务 */
	}
	if (process.env.DSH_SUBAGENT_DEBUG !== undefined) process.stderr.write(`[monitor-host] ${line}\n`);
}

/** 读心跳并判断新鲜度。 */
export function readHeartbeat() {
	const path = heartbeatPath();
	const raw = readJson(path, undefined);
	const now = Date.now();
	if (raw === undefined || raw === null || typeof raw !== 'object') {
		return { present: false, fresh: false, path, at: null, epochMs: null, pid: null, activeTasks: null, trackedTasks: null, engine: null, ageMs: null };
	}
	const epochMs = Number.isFinite(Number(raw.epochMs)) ? Number(raw.epochMs) : Date.parse(String(raw.at ?? ''));
	const ageMs = Number.isFinite(epochMs) ? now - epochMs : null;
	return {
		present: true,
		// 只判"上界":ageMs 为负(宿主时钟比我们快一点)也算新鲜 —— 宁可少启动一次,
		// 也绝不在有宿主的时候再拉一个(重复宿主写同一批会话日志 = §7.6 的损坏路径)。
		fresh: ageMs !== null && ageMs < HEARTBEAT_STALE_MS,
		path,
		at: typeof raw.at === 'string' ? raw.at : (Number.isFinite(epochMs) ? new Date(epochMs).toISOString() : null),
		epochMs: Number.isFinite(epochMs) ? epochMs : null,
		pid: Number.isFinite(Number(raw.pid)) ? Number(raw.pid) : null,
		activeTasks: Number.isFinite(Number(raw.activeTasks)) ? Number(raw.activeTasks) : null,
		trackedTasks: Number.isFinite(Number(raw.trackedTasks)) ? Number(raw.trackedTasks) : null,
		engine: typeof raw.engine === 'string' ? raw.engine : null,
		ageMs,
	};
}

/**
 * 按命令行判定一个 DSH Desktop 进程属于哪一类(与 `test/live-audit.mjs` 同一口径):
 *   `--type=` → Chromium 子进程;`--expose-internals` → CLI 方式跑的 dsh(**我们自己的子任务**);
 *   都不含 → 真正的 GUI 宿主。
 * @param {string} command - 进程命令行。
 * @returns {'chromium-child'|'dsh-cli'|'gui-host'} 分类。
 */
export function classifyCommandLine(command) {
	const text = typeof command === 'string' ? command : '';
	if (text.includes('--type=')) return 'chromium-child';
	if (text.includes('--expose-internals')) return 'dsh-cli';
	return 'gui-host';
}

/**
 * 枚举同名进程并**按命令行分类**。
 *
 * 为什么不能用只看进程名的 `tasklist`:进程名会把 Chromium 子进程和 CLI 子任务全算进去,
 * 而我们要回答的是"有没有一个**带着窗口**的宿主"。结果按冷却窗口缓存,最多每 COOLDOWN_MS 跑一次
 * (一次 `Get-CimInstance Win32_Process` 约 1.3 秒,只在"没有可信心跳"这条路上才会走)。
 *
 * @returns {Array<{pid:number,kind:'chromium-child'|'dsh-cli'|'gui-host'}>|null} 探测失败返回 null(未知)。
 */
function listClassifiedProcesses() {
	const now = Date.now();
	if (processCache !== null && now - processCache.at < COOLDOWN_MS) return processCache.items;
	const name = hostProcessName();
	const shell = process.env.DSH_SUBAGENT_PS ?? 'powershell';
	const filter = `Name='${name.replace(/'/g, "''")}'`;
	// 命令行用 **base64** 传回来:命令行里可能有换行(多行 `node -e "…"` 脚本,本机实测有),
	// 直接 `"$pid|$cmdline"` 会被换行切成多行,解析出 pid=NaN 的假条目。
	const script = `Get-CimInstance Win32_Process -Filter "${filter}" | ForEach-Object { "$($_.ProcessId)|" + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$_.CommandLine)) }`;
	const timeout = Number(process.env.DSH_SUBAGENT_HOST_PROBE_TIMEOUT_MS ?? 15000);
	let items = null;
	let lastError = null;
	// **重试一次**:首次调用要冷启动一个 powershell 进程 + 让 AMSI/杀软扫它,实测偶发超时。
	// 一次偶发失败就判"不知道"会让自动拉起长期不工作,所以给它第二次机会。
	for (let attempt = 0; attempt < 2 && items === null; attempt += 1) {
		try {
			const out = execFileSync(shell, ['-NoProfile', '-NonInteractive', '-Command', script], {
				encoding: 'utf8',
				timeout: Number.isFinite(timeout) && timeout > 0 ? timeout : 15000,
				windowsHide: true,
				maxBuffer: 8 * 1024 * 1024,
			});
			items = String(out ?? '').split(/\r?\n/)
				.map((line) => /^(\d+)\|([A-Za-z0-9+/=]*)$/.exec(line.trim()))
				.filter((match) => match !== null)
				.map((match) => ({
					pid: Number.parseInt(match[1], 10),
					kind: classifyCommandLine(Buffer.from(match[2], 'base64').toString('utf8')),
				}));
		} catch (error) {
			lastError = error;
		}
	}
	if (items === null) {
		logLine('宿主进程探测失败两次(按未知处理:不启动,避免第二个宿主)',
			lastError instanceof Error ? lastError.message : String(lastError));
	}
	processCache = { at: now, items };
	return items;
}

/** 定位要拉起的可执行文件 + 参数。 */
export function resolveMonitorCommand() {
	const custom = process.env.DSH_SUBAGENT_MONITOR_CMD;
	if (typeof custom === 'string' && custom.trim() !== '') {
		const parts = splitCommandLine(custom.trim());
		const exe = parts[0] ?? '';
		let args = parts.slice(1);
		const extra = process.env.DSH_SUBAGENT_MONITOR_ARGS;
		if (typeof extra === 'string' && extra.trim() !== '') {
			try {
				const parsed = JSON.parse(extra);
				if (Array.isArray(parsed)) args = parsed.map((item) => String(item));
			} catch {
				args = [...args, ...splitCommandLine(extra.trim())];
			}
		}
		return { exe, args, source: 'DSH_SUBAGENT_MONITOR_CMD' };
	}
	const candidates = [
		join(process.env.ProgramFiles ?? 'C:\\Program Files', 'DSH Desktop', 'DSH Desktop.exe'),
		join(process.env.LOCALAPPDATA ?? join(process.env.USERPROFILE ?? '', 'AppData', 'Local'), 'Programs', 'DSH Desktop', 'DSH Desktop.exe'),
	];
	for (const candidate of candidates) {
		if (existsSync(candidate)) return { exe: candidate, args: [], source: 'default-path' };
	}
	return { exe: null, args: [], source: 'not-found', tried: candidates };
}

/**
 * 拆一条 Windows 命令行(尊重双引号,支持 `\"` 转义)。
 * @param {string} text - 命令行。
 * @returns {string[]} exe + args。
 */
export function splitCommandLine(text) {
	const parts = [];
	let current = '';
	let quoted = false;
	for (let index = 0; index < text.length; index += 1) {
		const char = text[index];
		if (char === '\\' && text[index + 1] === '"') {
			current += '"';
			index += 1;
			continue;
		}
		if (char === '"') {
			quoted = !quoted;
			continue;
		}
		if (!quoted && (char === ' ' || char === '\t')) {
			if (current !== '') parts.push(current);
			current = '';
			continue;
		}
		current += char;
	}
	if (current !== '') parts.push(current);
	return parts;
}

/**
 * 判活规则(顺序不能变,2026-09-11 按"活跃审计"的实测收紧):
 *
 * 1. **心跳新鲜且它的 pid 还活着** → 有带监控的宿主在线 → 什么都不做(`already-running`)。
 * 2. **心跳存在但 pid 已消失 / 时间过期** → 判为**残留文件,不是宿主**。继续往下判:
 *    既不据此认为"宿主活着",也不据此认为"没宿主"。
 *    (踩过:观察器自检把心跳写进了真 `$DSH_HOME`,文件里的 pid 早就死了。)
 * 3. **枚举同名进程并看命令行分类**:
 *    - 含 `--type=` → Chromium 子进程,忽略;
 *    - 含 `--expose-internals` → 以 CLI 方式跑的 dsh(**我们自己的子代理任务**),不是宿主;
 *    - 都不含 → **真正的 GUI 宿主**:有窗口在(哪怕它跑的是旧版观察器、写不出心跳)
 *      → **绝不拉起第二个**,`action = "gui-open-old-observer"`。
 *    - 查不到进程表 → `probe-failed`(未知 ≠ 没有宿主,**不启动**;下次调用再试)。
 *
 * 只有"没有新鲜心跳 **且** 没有 GUI 宿主进程"时,才按 `DSH_SUBAGENT_AUTOSTART_MONITOR` 去 spawn。
 * 命令行分类的实现与 `test/live-audit.mjs` 的 `listDshProcesses()` 保持一致(它是审计口径的出处)。
 *
 * @param {{reason?:string}} [options] - 触发原因(写进日志)。
 * @returns {{action:'already-running'|'gui-open-old-observer'|'launched'|'skipped'|'unavailable'|'probe-failed',
 *   reason:string, heartbeatAt:string|null, heartbeatAgeMs:number|null, heartbeatPidAlive:boolean|null,
 *   heartbeatResidue:boolean, pid:number|null, exe:string|null, ok:boolean, at:string}}
 */
export function ensureMonitorHost(options = {}) {
	const at = new Date().toISOString();
	const reason = typeof options.reason === 'string' ? options.reason : '';
	const heartbeat = readHeartbeat();
	// 没有心跳文件时 pid 不存在 ⇒ "未知(null)",而不是"已死(false)":
	// 前者是"根本没写心跳",后者是"心跳是残留",两者的处置不同(见下面注释)。
	const heartbeatPidAlive = Number.isInteger(heartbeat.pid) && heartbeat.pid > 0 ? processAlive(heartbeat.pid) : null;

	// 1) 心跳新鲜 **且** 心跳里的 pid 还活着:有带监控的宿主在跑,绝不重复启动。
	if (heartbeat.fresh && heartbeatPidAlive === true) {
		lastLaunch = { action: 'already-running', at, exe: null, ok: true, reason: '心跳新鲜且宿主 pid 存活' };
		return { action: 'already-running', reason: '心跳新鲜且宿主 pid 存活', heartbeatAt: heartbeat.at, heartbeatAgeMs: heartbeat.ageMs, heartbeatPidAlive: true, heartbeatResidue: false, pid: heartbeat.pid, exe: null, ok: true, at };
	}
	// 2) 残留心跳(新鲜但 pid 已死 / 已过期):只当"没有可信的宿主信号",往下继续判。
	const residue = heartbeat.present;
	if (residue) {
		logLine('心跳不可信,按残留处理(不作为宿主依据,也不作为"没宿主"依据)',
			`at=${heartbeat.at} pid=${heartbeat.pid} pidAlive=${String(heartbeatPidAlive)} ageMs=${heartbeat.ageMs} reason=${reason}`);
	}
	if (!autostartEnabled()) {
		lastLaunch = { action: 'skipped', at, exe: null, ok: true, reason: 'DSH_SUBAGENT_AUTOSTART_MONITOR=off' };
		logLine('跳过自动拉起:总开关已关闭', `reason=${reason}`);
		return { action: 'skipped', reason: '总开关已关闭', heartbeatAt: heartbeat.at, heartbeatAgeMs: heartbeat.ageMs, heartbeatPidAlive, heartbeatResidue: residue, pid: null, exe: null, ok: true, at };
	}
	if (process.platform !== 'win32') {
		lastLaunch = { action: 'skipped', at, exe: null, ok: true, reason: '非 Windows 平台' };
		logLine('跳过自动拉起:非 Windows 平台', `platform=${process.platform}`);
		return { action: 'skipped', reason: '非 Windows 平台', heartbeatAt: heartbeat.at, heartbeatAgeMs: heartbeat.ageMs, heartbeatPidAlive, heartbeatResidue: residue, pid: null, exe: null, ok: true, at };
	}

	// 3) 没有新鲜心跳 → 看有没有**真正的 GUI 宿主进程**(命令行分类,不能只看进程名)。
	const processes = listClassifiedProcesses();
	if (processes === null && hostGuardEnabled()) {
		// **不知道**有没有宿主:宁可这次不拉起(下一次调用还会再试),也绝不冒险开第二个宿主。
		lastLaunch = { action: 'probe-failed', at, exe: null, ok: false, reason: '查不到进程表,无法确认有没有宿主' };
		logLine('不启动:宿主进程探测失败(未知 ≠ 没有宿主)', `reason=${reason}`);
		return { action: 'probe-failed', reason: '进程探测失败,无法确认有没有宿主', heartbeatAt: heartbeat.at, heartbeatAgeMs: heartbeat.ageMs, heartbeatPidAlive, heartbeatResidue: residue, pid: null, exe: null, ok: false, at };
	}
	const guiHosts = processes === null ? [] : processes.filter((item) => item.kind === 'gui-host');
	const cliTasks = processes === null ? [] : processes.filter((item) => item.kind === 'dsh-cli');
	if (processes !== null && guiHosts.length > 0 && hostGuardEnabled()) {
		lastLaunch = { action: 'gui-open-old-observer', at, exe: null, ok: true, reason: 'GUI 宿主进程在,GUI 窗口开着但它的观察器没写心跳' };
		logLine('跳过自动拉起:已有 GUI 宿主进程(它跑的是旧版观察器,写不出心跳,重启 DSH Desktop 即可)',
			`guiHosts=${guiHosts.map((item) => item.pid).join(',')} cliDsh=${cliTasks.length} heartbeat=${heartbeat.present ? heartbeat.at : 'missing'} reason=${reason}`);
		return {
			action: 'gui-open-old-observer', reason: 'GUI 宿主进程在,旧观察器没写心跳',
			heartbeatAt: heartbeat.at, heartbeatAgeMs: heartbeat.ageMs, heartbeatPidAlive, heartbeatResidue: residue,
			pid: guiHosts[0]?.pid ?? null, exe: null, ok: true, at, guiHostPids: guiHosts.map((item) => item.pid), cliProcessPids: cliTasks.map((item) => item.pid),
		};
	}

	// 4) 冷却:避免风暴式重复启动。
	const now = Date.now();
	if (lastAttemptMs !== 0 && now - lastAttemptMs < COOLDOWN_MS) {
		lastLaunch = { action: 'skipped', at, exe: null, ok: true, reason: '冷却中' };
		logLine('跳过自动拉起:还在冷却期', `sinceMs=${now - lastAttemptMs} cooldownMs=${COOLDOWN_MS} reason=${reason}`);
		return { action: 'skipped', reason: '冷却中', heartbeatAt: heartbeat.at, heartbeatAgeMs: heartbeat.ageMs, heartbeatPidAlive, heartbeatResidue: residue, pid: null, exe: null, ok: true, at };
	}

	// 5) 既没有可信心跳,也没有 GUI 宿主进程 → 定位 exe 并拉起(非阻塞)。
	const command = resolveMonitorCommand();
	if (command.exe === null) {
		lastLaunch = { action: 'unavailable', at, exe: null, ok: false, reason: '找不到 DSH Desktop 可执行文件' };
		logLine('无法自动拉起:找不到可执行文件', `tried=${JSON.stringify(command.tried ?? [])} reason=${reason}`);
		return { action: 'unavailable', reason: '找不到可执行文件', heartbeatAt: heartbeat.at, heartbeatAgeMs: heartbeat.ageMs, heartbeatPidAlive, heartbeatResidue: residue, pid: null, exe: null, ok: false, at };
	}
	lastAttemptMs = now;
	try {
		const child = spawn(command.exe, command.args, { detached: true, stdio: 'ignore', windowsHide: false });
		child.on('error', (error) => {
			logLine('自动拉起失败', `exe=${command.exe} error=${error instanceof Error ? error.message : String(error)}`);
		});
		child.unref();
		lastLaunch = { action: 'launched', at, exe: command.exe, ok: true, pid: child.pid ?? null, reason: '没有可信心跳,也没有 GUI 宿主进程' };
		logLine('已自动拉起监控宿主', `exe=${command.exe} args=${JSON.stringify(command.args)} pid=${child.pid ?? '-'} source=${command.source} heartbeat=${heartbeat.present ? heartbeat.at : 'missing'} reason=${reason}`);
		return { action: 'launched', reason: '没有可信心跳,也没有 GUI 宿主进程', heartbeatAt: heartbeat.at, heartbeatAgeMs: heartbeat.ageMs, heartbeatPidAlive, heartbeatResidue: residue, pid: child.pid ?? null, exe: command.exe, ok: true, at };
	} catch (error) {
		lastLaunch = { action: 'unavailable', at, exe: command.exe, ok: false, reason: 'spawn 抛错' };
		logLine('自动拉起抛错(已忽略)', `exe=${command.exe} error=${error instanceof Error ? error.message : String(error)}`);
		return { action: 'unavailable', reason: 'spawn 抛错', heartbeatAt: heartbeat.at, heartbeatAgeMs: heartbeat.ageMs, heartbeatPidAlive, heartbeatResidue: residue, pid: null, exe: command.exe, ok: false, at };
	}
}

/**
 * 只读地看一眼监控宿主状态(不发任何启动动作)。
 *
 * `state` 用与 `test/live-audit.mjs` **完全相同的三态口径**,便于两个视图对账:
 * `host-with-heartbeat`(新鲜心跳 + pid 存活)/ `host-older-observer`(GUI 进程在但没心跳)
 * / `no-host`(既没可信心跳,也没 GUI 宿主进程)。
 *
 * @returns {{running:boolean, state:string, guiOpen:boolean, heartbeatAt:string|null,
 *   heartbeatAgeMs:number|null, heartbeatPidAlive:boolean|null, heartbeatResidue:boolean,
 *   pid:number|null, activeTasks:number|null, trackedTasks:number|null, engine:string|null,
 *   autostart:boolean, platform:string, cooldownMs:number, heartbeatStaleMs:number,
 *   guiHostPids:number[], cliProcessPids:number[], processProbeFailed:boolean,
 *   lastLaunch:{action:string,at:string,exe:string|null,ok:boolean}|null}}
 */
export function monitorHostStatus() {
	const heartbeat = readHeartbeat();
	// 与 ensureMonitorHost 同一口径:没写心跳 ⇒ 未知(null),而不是"已死(false)"。
	const heartbeatPidAlive = Number.isInteger(heartbeat.pid) && heartbeat.pid > 0 ? processAlive(heartbeat.pid) : null;
	const processes = listClassifiedProcesses();
	const guiHostPids = processes === null ? [] : processes.filter((item) => item.kind === 'gui-host').map((item) => item.pid);
	const cliProcessPids = processes === null ? [] : processes.filter((item) => item.kind === 'dsh-cli').map((item) => item.pid);
	const hostWithHeartbeat = heartbeat.fresh && heartbeatPidAlive === true;
	const state = hostWithHeartbeat ? 'host-with-heartbeat'
		: (processes !== null && guiHostPids.length > 0) ? 'host-older-observer' : 'no-host';
	const running = hostWithHeartbeat;
	return {
		running,
		state,
		guiOpen: guiHostPids.length > 0,
		heartbeatAt: heartbeat.at,
		heartbeatAgeMs: heartbeat.ageMs,
		heartbeatPidAlive,
		heartbeatResidue: heartbeat.present && !hostWithHeartbeat,
		pid: hostWithHeartbeat ? heartbeat.pid : (guiHostPids[0] ?? null),
		activeTasks: heartbeat.activeTasks,
		trackedTasks: heartbeat.trackedTasks,
		engine: heartbeat.engine,
		autostart: autostartEnabled(),
		platform: process.platform,
		cooldownMs: COOLDOWN_MS,
		heartbeatStaleMs: HEARTBEAT_STALE_MS,
		guiHostPids,
		cliProcessPids,
		processProbeFailed: processes === null,
		lastLaunch: lastLaunch === null ? null : { action: lastLaunch.action, at: lastLaunch.at, exe: lastLaunch.exe, ok: lastLaunch.ok },
	};
}

/**
 * 给 `dsh_task_status` 用的**无副作用**动作名:不启动任何东西。
 * @returns {string} `already-running` / `gui-open-old-observer` / 上次的 `launched|skipped|unavailable` / `unknown`。
 */
export function peekMonitorHostAction() {
	const heartbeat = readHeartbeat();
	if (heartbeat.fresh && processAlive(heartbeat.pid) === true) return 'already-running';
	return lastLaunch?.action ?? 'unknown';
}
