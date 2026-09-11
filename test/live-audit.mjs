/**
 * 「现在到底有几个活跃?」——一份把三个视图对到一起的审计。
 *
 * 三个视图经常对不上,原因各不相同:
 *   1. **任务台账**(桥接写的 `state/tasks/<job>/task.json`):状态可能是 running,
 *      但进程早就没了(桥接被杀、任务现场被清)。**判活跃必须以 pid 存活为准。**
 *   2. **本机 DSH 子代理**(宿主进程内的 subagent):台账里完全没有,只有 GUI 的
 *      `subagentsByParent` 目录知道;悬浮卡片负责显示。
 *   3. **调用方的等待**:harness 侧可能还在轮询一个其实已经结束的 job。
 *
 * 用法:
 *   node test/live-audit.mjs           # 人读的报告
 *   node test/live-audit.mjs --json    # 机器读
 */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { execFileSync } from 'node:child_process';

const HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh');
const TASKS = join(HOME, 'subagent', 'state', 'tasks');
const HEARTBEAT = join(HOME, 'subagent', 'state', 'observer-heartbeat.json');
const OBSERVER_LOG = join(HOME, 'subagent', 'state', 'observer.log');
const LIVE_STATUS = new Set(['running', 'starting', 'pending']);

/** 与 observer 一致:EPERM 也算活着(进程存在但没权限发信号)。 */
function processAlive(pid) {
	if (!Number.isInteger(pid) || pid <= 0) return undefined;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error?.code === 'EPERM' ? true : false;
	}
}

function readJson(file) {
	try {
		return JSON.parse(readFileSync(file, 'utf8'));
	} catch {
		return null;
	}
}

function fmtDuration(ms) {
	if (!Number.isFinite(ms) || ms < 0) return '--';
	const total = Math.floor(ms / 1000);
	if (total < 60) return total + 's';
	const minutes = Math.floor(total / 60);
	if (minutes < 60) return minutes + 'm' + String(total % 60).padStart(2, '0') + 's';
	return Math.floor(minutes / 60) + 'h' + String(minutes % 60).padStart(2, '0') + 'm';
}

function scan() {
	if (!existsSync(TASKS)) return [];
	const out = [];
	for (const job of readdirSync(TASKS)) {
		const dir = join(TASKS, job);
		const task = readJson(join(dir, 'task.json'));
		if (task === null) continue;
		const meta = readJson(join(dir, 'meta.json')) ?? {};
		const pid = Number.isInteger(meta.pid) ? meta.pid : null;
		const alive = processAlive(pid);
		let bytes = 0;
		try {
			bytes = readFileSync(join(dir, 'stderr.log')).length;
		} catch {
			bytes = 0;
		}
		const status = typeof task.status === 'string' ? task.status : '?';
		out.push({
			job,
			status,
			caller: typeof task.caller === 'string' ? task.caller : '?',
			workspace: typeof task.workspace === 'string' ? task.workspace : '',
			label: typeof task.label === 'string' ? task.label : '',
			pid,
			pidAlive: alive,
			startedAt: typeof task.startedAt === 'string' ? task.startedAt : null,
			finishedAt: typeof task.finishedAt === 'string' ? task.finishedAt : null,
			deadlineAt: typeof task.deadlineAt === 'string' ? task.deadlineAt : null,
			expectedSeconds: Number.isInteger(task.expectedSeconds) ? task.expectedSeconds : null,
			sessionId: typeof meta.sessionId === 'string' ? meta.sessionId : null,
			logBytes: bytes,
			// "记录说在跑" vs "真的在跑"
			claimsLive: LIVE_STATUS.has(status),
			reallyLive: LIVE_STATUS.has(status) && alive === true,
			ghost: LIVE_STATUS.has(status) && alive === false,
		});
	}
	out.sort((a, b) => String(b.startedAt ?? '').localeCompare(String(a.startedAt ?? '')));
	return out;
}

const tasks = scan();
const ghosts = tasks.filter((item) => item.ghost);
const live = tasks.filter((item) => item.reallyLive);
const claimed = tasks.filter((item) => item.claimsLive);
// 第三类:记录说在跑、但**连 pid 都没记**(meta.json 没写出来 / 记录被截断)。
// 这类最阴:判活返回"未知",观察器与其它视图的默认推断都是"还在跑",于是永远显示活跃。
const unknownPid = claimed.filter((item) => item.pidAlive === undefined);
const heartbeat = readJson(HEARTBEAT);
const heartbeatAgeMs = heartbeat?.epochMs === undefined ? null : Date.now() - heartbeat.epochMs;
const heartbeatFresh = heartbeatAgeMs !== null && heartbeatAgeMs < 20000;
const hostAlive = processAlive(Number.isInteger(heartbeat?.pid) ? heartbeat.pid : null);
let observerLogAgeMs = null;
try {
	observerLogAgeMs = Date.now() - statSync(OBSERVER_LOG).mtimeMs;
} catch {
	observerLogAgeMs = null;
}

/**
 * DSH Desktop 的进程分三类:`--type=` 是 Chromium 子进程,`--expose-internals` 是 CLI 方式
 * 跑的 dsh(我们的子代理任务、dump-config 都是这种),剩下的才是**真正的 GUI 宿主**。
 */
function listDshProcesses() {
	try {
		const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
			'Get-CimInstance Win32_Process -Filter "Name=\'DSH Desktop.exe\'" | ForEach-Object { "$($_.ProcessId)|$($_.CommandLine)" }',
		], { encoding: 'utf8', timeout: 60000 });
		return out.split(/\r?\n/).filter((line) => line.trim() !== '').map((line) => {
			const cut = line.indexOf('|');
			const pid = Number.parseInt(line.slice(0, cut), 10);
			const command = line.slice(cut + 1);
			const kind = command.includes('--type=') ? 'chromium-child'
				: command.includes('--expose-internals') ? 'dsh-cli' : 'gui-host';
			return { pid, kind };
		});
	} catch {
		return null;
	}
}

const processes = listDshProcesses();
const hosts = processes === null ? null : processes.filter((item) => item.kind === 'gui-host');
const cliTasks = processes === null ? null : processes.filter((item) => item.kind === 'dsh-cli');
const hostState = heartbeatFresh && hostAlive === true
	? 'host-with-heartbeat'
	: (hosts !== null && hosts.length > 0) || (observerLogAgeMs !== null && observerLogAgeMs < 120000)
		? 'host-older-observer'
		: 'no-host';

const report = {
	now: new Date().toISOString(),
	bridgeTasks: {
		total: tasks.length,
		claimedLive: claimed.length,
		reallyLive: live.length,
		ghosts: ghosts.length,
		unknownPid: unknownPid.length,
		unknownPidList: unknownPid.map((item) => ({
			job: item.job,
			caller: item.caller,
			status: item.status,
			startedAt: item.startedAt,
			ageSeconds: item.startedAt === null ? null : Math.round((Date.now() - Date.parse(item.startedAt)) / 1000),
		})),
		live: live.map((item) => ({
			job: item.job,
			caller: item.caller,
			pid: item.pid,
			elapsedMs: item.startedAt === null ? null : Date.now() - Date.parse(item.startedAt),
			deadlineAt: item.deadlineAt,
			label: item.label,
			sessionId: item.sessionId,
			logBytes: item.logBytes,
		})),
		ghostList: ghosts.map((item) => ({ job: item.job, caller: item.caller, status: item.status, pid: item.pid })),
	},
	monitorHost: {
		state: hostState,
		heartbeatFresh,
		heartbeatAgeMs,
		pid: heartbeat?.pid ?? null,
		pidAlive: hostAlive,
		engine: heartbeat?.engine ?? null,
		activeTasksPerHost: heartbeat?.activeTasks ?? null,
		observerLogAgeMs,
		guiHosts: hosts === null ? null : hosts.map((item) => item.pid),
		cliProcesses: cliTasks === null ? null : cliTasks.map((item) => item.pid),
	},
	note: '本机 DSH 子代理(宿主进程内的 subagent)不在这份台账里,只有 GUI 的 subagentsByParent 目录能列出;悬浮卡片会显示成「本机 DSH 子代理」组。',
};

if (process.argv.includes('--json')) {
	console.log(JSON.stringify(report, null, 2));
} else if (process.argv.includes('--fix')) {
	// 把假活跃记录订正掉:
	//   ① 有 pid 但进程已消失的幽灵;
	//   ② 没 pid 且早就超期的半成品记录(判活"未知",所有视图都默认它还在跑)。
	// ②只处理明显超期的(>10 分钟),免得碰到刚起、pid 还没写进 meta.json 的真任务。
	const GRACE_MS = 10 * 60 * 1000;
	const halfBaked = unknownPid.filter((item) => item.startedAt === null
		|| Date.now() - Date.parse(item.startedAt) > GRACE_MS);
	let fixed = 0;
	const correct = (item, note) => {
		const file = join(TASKS, item.job, 'task.json');
		const record = readJson(file);
		if (record === null) return;
		record.status = 'lost';
		record.statusFixedAt = new Date().toISOString();
		record.statusFixNote = note;
		try {
			writeFileSync(file, JSON.stringify(record, null, 2) + '\n', 'utf8');
			fixed += 1;
			console.log(`  ✔ 已纠正 ${item.job} → lost(${note})`);
		} catch (error) {
			console.log(`  ❌ 纠正失败 ${item.job}: ${error.message}`);
		}
	};
	for (const item of ghosts) correct(item, `进程已消失 pid=${item.pid}`);
	for (const item of halfBaked) correct(item, '记录说在跑但从未写出 pid,已超期');
	console.log(`\n共纠正 ${fixed} 条假活跃记录(活跃只以 pid 存活为准;${unknownPid.length - halfBaked.length} 条没记 pid 但仍在宽限期内,没动)`);
} else {
	console.log('活跃审计  ' + report.now);
	console.log('');
	console.log('== 外部 dsh_task 任务(桥接台账)==');
	console.log(`  记录总数 ${tasks.length} · 记录说在跑 ${claimed.length} · **真的在跑 ${live.length}** · 幽灵记录 ${ghosts.length}`
		+ (unknownPid.length === 0 ? '' : ` · 没记 pid ${unknownPid.length}`));
	if (live.length === 0) console.log('  (没有真正在跑的外部任务)');
	for (const item of live) {
		const elapsed = item.startedAt === null ? '?' : fmtDuration(Date.now() - Date.parse(item.startedAt));
		console.log(`  ▶ ${item.job}  调用方=${item.caller}  pid=${item.pid}  已跑 ${elapsed}`
			+ (item.label === '' ? '' : `  标签=${item.label}`) + (item.logBytes > 0 ? `  日志 ${item.logBytes}B` : ''));
	}
	for (const item of ghosts) {
		console.log(`  ⚠ 幽灵:${item.job}  调用方=${item.caller}  status=${item.status} 但 pid=${item.pid} 已消失`);
	}
	for (const item of unknownPid) {
		const age = item.startedAt === null ? '?' : fmtDuration(Date.now() - Date.parse(item.startedAt));
		console.log(`  ⚠ 没记 pid:${item.job}  调用方=${item.caller}  status=${item.status}  开始于 ${age}前`
			+ '(判活返回"未知",多数视图会默认当作还在跑 → 需要按时间兜底判死)');
	}
	console.log('');
	console.log('== 最近的 10 个外部任务(看"它们真的在动吗")==');
	console.log('  job                       调用方              状态      跑多久   结束时间');
	for (const item of tasks.slice(0, 10)) {
		const began = item.startedAt === null ? NaN : Date.parse(item.startedAt);
		const ended = item.finishedAt === null ? NaN : Date.parse(item.finishedAt);
		const span = Number.isFinite(began) ? fmtDuration((Number.isFinite(ended) ? ended : Date.now()) - began) : '?';
		const endLabel = Number.isFinite(ended) ? new Date(ended).toISOString().slice(11, 19) : (item.reallyLive ? '(还在跑)' : '(无结束时间)');
		console.log('  ' + item.job.padEnd(25) + ' ' + String(item.caller).padEnd(18) + ' '
			+ String(item.status).padEnd(9) + ' ' + span.padEnd(8) + ' ' + endLabel);
	}
	console.log('');
	console.log('== 监控宿主 ==');
	console.log(`  状态:${hostState}`);
	console.log(`  GUI 宿主进程:${hosts === null ? '查不到进程表' : hosts.length === 0 ? '无' : hosts.map((item) => 'pid ' + item.pid).join(', ')}`
		+ `  ·  以 CLI 方式跑的 dsh:${cliTasks === null ? '?' : cliTasks.length} 个`
		+ (cliTasks === null || cliTasks.length === 0 ? '' : '(' + cliTasks.map((item) => item.pid).join(', ') + ')'));
	if (heartbeat === null) {
		console.log('  ❌ 没有心跳文件(新版观察器才会写;还没重启过 DSH Desktop 就是这个状态)');
	} else {
		console.log(`  ${heartbeatFresh ? '✅' : '❌'} 心跳 ${heartbeatAgeMs === null ? '?' : fmtDuration(heartbeatAgeMs) + '前'}`
			+ `  pid=${heartbeat.pid}(${hostAlive === true ? '活着' : hostAlive === false ? '已消失' : '未知'})`
			+ `  engine=${heartbeat.engine}  宿主自报活跃任务=${heartbeat.activeTasks}`);
		if (!heartbeatFresh && hostAlive === false) {
			console.log('     ↳ 这个心跳的进程已经没了:大概率是**自检留下的残留文件**,不是活宿主');
		}
	}
	console.log(`  observer.log ${observerLogAgeMs === null ? '(不存在)' : fmtDuration(observerLogAgeMs) + '前更新'}`
		+ '(旧版观察器只在有任务在飞时才写日志,所以"日志新鲜"也能说明宿主活着)');
	console.log('');
	console.log('== 本机 DSH 子代理 ==');
	console.log('  ' + report.note);
}
process.exitCode = ghosts.length === 0 && unknownPid.length === 0 ? 0 : 2;
