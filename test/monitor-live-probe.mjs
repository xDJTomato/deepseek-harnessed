/**
 * 「真心跳 + 真 `dsh_task`」现场探针:验证**重启之后**才可能成立的那条路径。
 *
 * 背景:自动拉起监控窗口的四步判活里,第 1 步是
 *   「心跳新鲜且心跳里的 pid 还活着 → already-running,什么都不做」。
 * 这条分支在重启前**只能拿合成心跳验证** —— 因为当时宿主里加载的是没有心跳代码的旧版
 * 观察器,真心跳文件根本不存在,真实环境每次都会走到第 4 步(gui-open-old-observer)。
 * 重启之后真心跳有了,这里就用**真实环境、不覆盖任何开关**跑一次真 `dsh_task`,
 * 看它到底报哪一步,并确认它**没有**再拉起第二个 GUI。
 *
 * 用法:
 *   node test/monitor-live-probe.mjs
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

const BRIDGE_ROOT = join(process.env.USERPROFILE ?? process.cwd(), '.dsh', 'subagent');
const HOME = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? process.cwd(), '.dsh');
const MAX_HOSTS_BEFORE = 1;

const checks = [];
const check = (name, ok, detail = '') => {
	checks.push([name, ok, detail]);
	process.stdout.write(`${ok ? '✅' : '❌'} ${name}${detail === '' ? '' : ' — ' + detail}\n`);
};

/** 极简 MCP stdio 客户端(与 selftest 同口径)。 */
class Client {
	constructor() {
		this.child = spawn(process.execPath, [join(BRIDGE_ROOT, 'bin', 'dsh-subagent-mcp.mjs')], {
			stdio: ['pipe', 'pipe', 'pipe'],
			windowsHide: true,
			env: { ...process.env },
		});
		this.buffer = '';
		this.pending = new Map();
		this.nextId = 1;
		this.child.stdout.setEncoding('utf8');
		this.child.stdout.on('data', (chunk) => this.onData(chunk));
		this.child.stderr.setEncoding('utf8');
		this.child.stderr.on('data', () => {});
	}
	onData(chunk) {
		this.buffer += chunk;
		for (;;) {
			const newline = this.buffer.indexOf('\n');
			if (newline < 0) return;
			const line = this.buffer.slice(0, newline).trim();
			this.buffer = this.buffer.slice(newline + 1);
			if (line === '') continue;
			let frame;
			try {
				frame = JSON.parse(line);
			} catch {
				continue;
			}
			if (frame.id !== undefined && frame.method === undefined) {
				const waiter = this.pending.get(frame.id);
				if (waiter === undefined) continue;
				this.pending.delete(frame.id);
				if (frame.error) waiter.reject(new Error(frame.error.message));
				else waiter.resolve(frame.result);
			} else if (frame.id !== undefined) {
				this.write({ jsonrpc: '2.0', id: frame.id, result: { roots: [] } });
			}
		}
	}
	write(message) {
		this.child.stdin.write(`${JSON.stringify(message)}\n`);
	}
	request(method, params) {
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			this.write({ jsonrpc: '2.0', id, method, params });
			setTimeout(() => {
				if (this.pending.delete(id)) reject(new Error(method + ' 超时'));
			}, 600000).unref?.();
		});
	}
	close() {
		this.child.stdin.end();
		this.child.kill();
	}
}

const textOf = (result) => (result?.content ?? []).filter((part) => part.type === 'text').map((part) => part.text).join('\n');

/**
 * 只看真正的 GUI 宿主。
 *
 * 为什么不能只做**排除法**(排掉 `--type=` 与 `--expose-internals`):实测 0.1.5-rc.1 上
 * 这里会误判 —— 宿主派生的瞬时进程(无 `--type=`、无 `--expose-internals`)会被当成
 * 第二个 GUI 宿主,于是"没有重复宿主"这条断言随机失败(本次实测差点误报)。
 *
 * 改成**正面识别**:Electron 主进程一定带着 `--type=renderer` 的子进程(有窗口才有渲染器),
 * 而 CLI/派生进程不会有。先排掉子进程与 CLI,再要求该 pid 至少有一个 `--type=` 子进程。
 *
 * @returns GUI 主进程 pid 数组;查不到进程表时返回 null。
 */
function guiHostPids() {
	return new Promise((resolve) => {
		const ps = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command',
			'Get-CimInstance Win32_Process -Filter "Name=\'DSH Desktop.exe\'" | ForEach-Object { "$($_.ProcessId)|$($_.ParentProcessId)|$($_.CommandLine)" }',
		], { windowsHide: true });
		let out = '';
		ps.stdout.setEncoding('utf8');
		ps.stdout.on('data', (chunk) => { out += chunk; });
		ps.on('close', () => {
			const rows = [];
			for (const line of out.split(/\r?\n/)) {
				if (line.trim() === '') continue;
				const [pidText, parentText, ...rest] = line.split('|');
				const pid = Number.parseInt(pidText, 10);
				if (!Number.isInteger(pid)) continue;
				rows.push({ pid, parent: Number.parseInt(parentText, 10), command: rest.join('|') });
			}
			const parents = new Set(rows.filter((row) => row.command.includes('--type=')).map((row) => row.parent));
			const hosts = rows
				.filter((row) => !row.command.includes('--type=') && !row.command.includes('--expose-internals'))
				.filter((row) => parents.has(row.pid))
				.map((row) => row.pid);
			resolve(hosts);
		});
		ps.on('error', () => resolve(null));
	});
}

const logPath = join(HOME, 'subagent', 'state', 'monitor-host.log');
const readLog = () => (existsSync(logPath) ? readFileSync(logPath, 'utf8').trim().split(/\r?\n/) : []);

const heartbeatPath = join(HOME, 'subagent', 'state', 'observer-heartbeat.json');
const heartbeat = existsSync(heartbeatPath) ? JSON.parse(readFileSync(heartbeatPath, 'utf8')) : null;
check('心跳文件存在(重启后新版观察器会写)', heartbeat !== null,
	heartbeat === null ? '没有心跳:说明宿主里还是旧版观察器' : 'pid=' + heartbeat.pid);
if (heartbeat !== null) {
	check('心跳是新鲜的(<20s)', Date.now() - heartbeat.epochMs < 20000,
		((Date.now() - heartbeat.epochMs) / 1000).toFixed(1) + 's 前');
}

const hostsBefore = await guiHostPids();
check('跑之前只有一个 GUI 宿主(没有重复宿主)', hostsBefore !== null && hostsBefore.length === MAX_HOSTS_BEFORE,
	hostsBefore === null ? '查不到进程表' : 'pids=' + hostsBefore.join(','));

const logLinesBefore = readLog().length;
const workspace = mkdtempSync(join(tmpdir(), 'dsh-monitor-live-'));
writeFileSync(join(workspace, 'README.md'), '# monitor live probe\n', 'utf8');

const client = new Client();
try {
	await client.request('initialize', {
		protocolVersion: '2024-11-05',
		capabilities: {},
		clientInfo: { name: 'monitor-live-probe', version: '0.0.1' },
	});
	const started = Date.now();
	const call = await client.request('tools/call', {
		name: 'dsh_task',
		arguments: {
			prompt: '只做一件事:用 pwsh 运行 `node -v`,然后只回答版本号。不要做别的。',
			workspace,
			expected_seconds: 120,
			acceptance: '回答里有一个形如 v24.x 的 node 版本号',
			wait_seconds: 30,
		},
	});
	const text = textOf(call);
	const monitorLine = (text.split(/\r?\n/).find((line) => line.includes('monitor_host')) ?? '(结果里没有 monitor_host 行)').trim();
	const jobId = (/job_id:\s*(\S+)/.exec(text) ?? [])[1] ?? null;
	const status = (/status:\s*(\S+)/.exec(text) ?? [])[1] ?? null;
	check('真 dsh_task 跑通', call?.isError !== true && jobId !== null, 'job_id=' + jobId + ' status=' + status
		+ ' 用时 ' + ((Date.now() - started) / 1000).toFixed(1) + 's');
	console.log('  · ' + monitorLine);
	// 有真心跳时,判活第 1 步就该命中,而不是去探进程表。
	check('走了「already-running(心跳新鲜)」这条真心跳分支', /already-running/.test(monitorLine), monitorLine);
	const logLinesAfter = readLog();
	const newLines = logLinesAfter.slice(logLinesBefore);
	check('没有真的拉起第二个 GUI(monitor-host.log 无新的"已自动拉起")',
		!newLines.some((line) => line.includes('已自动拉起')), newLines.length === 0 ? '(本次没有新增日志)' : newLines.join(' | '));
	const hostsAfter = await guiHostPids();
	check('跑完 GUI 宿主数量没变', hostsAfter !== null && hostsAfter.length === hostsBefore.length,
		'before=' + hostsBefore.join(',') + ' after=' + (hostsAfter === null ? '?' : hostsAfter.join(',')));
} finally {
	client.close();
	rmSync(workspace, { recursive: true, force: true });
}

// 新版观察器应当把这个真实会话投影出来(先 running=true,再 running=false)。
const observerLog = existsSync(join(HOME, 'subagent', 'state', 'observer.log'))
	? readFileSync(join(HOME, 'subagent', 'state', 'observer.log'), 'utf8').trim().split(/\r?\n/)
	: [];
const recent = observerLog.slice(-40);
check('新版观察器记到了这次任务(added/status 行)', recent.some((line) => /added|status/.test(line)),
	recent.length === 0 ? '(observer.log 空)' : recent.at(-1));

const failed = checks.filter(([, ok]) => !ok).length;
process.stdout.write(`\n${checks.length - failed}/${checks.length} 通过\n`);
process.exit(failed === 0 ? 0 : 1);
