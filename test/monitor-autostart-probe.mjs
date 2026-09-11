/**
 * 监控宿主自动拉起的隔离自检:按"活跃审计"收紧后的三步判活规则逐条验。
 *
 * ⚠️ 必须用**临时 DSH_HOME**:心跳文件就是判活信号,写进真 `%USERPROFILE%\.dsh`
 * 会留下一个"看起来像宿主"的假心跳(现实中已经踩过一次)。
 * 所有用例都在临时 HOME 里跑,`DSH_SUBAGENT_MONITOR_CMD` 指向一个只写标记文件的小脚本,
 * **绝不会真的启动 DSH Desktop**。
 *
 * 用例(判活顺序不能变):
 *   1. 心跳新鲜 **且 pid 存活**   → already-running,**不** spawn;
 *   2. 心跳新鲜 **但 pid 已消失**(残留)→ **不**判 already-running,继续往下判 → 无 GUI 宿主 → launched;
 *   3. 心跳不存在                → launched,发生一次 spawn(标记文件被写出来);
 *   4. 总开关 off                → skipped,**不** spawn;
 *   5. 心跳过期 + **GUI 宿主进程在**(跑旧观察器)→ gui-open-old-observer,**不** spawn;
 *   6. 真实 `--expose-internals` 进程 → 分类为 `dsh-cli`(**我们自己的子任务**),不算宿主;
 *   7. FORCE=1 逃生门            → 绕过 GUI 宿主闸门,launched;
 *   8. 命令行分类规则纯函数单测(Chromium 子进程 / CLI dsh / GUI 宿主)。
 *
 * 用法: node test/monitor-autostart-probe.mjs
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { classifyCommandLine } from '../lib/monitor-host.mjs';

const results = [];
function check(name, ok, detail = '') {
	results.push({ name, ok, detail });
	process.stdout.write(`${ok ? '✅' : '❌'} ${name}${detail === '' ? '' : ` — ${detail}`}\n`);
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
/** 一个**不存在**的映像名:让"进程枚举"这条路查不到任何宿主,从而能单独验心跳那几条规则。 */
const NO_HOST_IMAGE = 'NoSuchHostProbe.exe';

function makeHome(label) {
	const home = mkdtempSync(join(tmpdir(), `dsh-monitor-probe-${label}-`));
	mkdirSync(join(home, 'subagent', 'state'), { recursive: true });
	return home;
}

/** 标记脚本:证明 spawn 真的发生了(而不是只看返回值)。 */
function markerCommand(markerPath) {
	const script = `require('fs').writeFileSync(${JSON.stringify(markerPath)}, 'launched')`;
	return `"${process.execPath}" -e "${script.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function writeHeartbeat(home, epochMs, pid) {
	writeFileSync(join(home, 'subagent', 'state', 'observer-heartbeat.json'), `${JSON.stringify({
		at: new Date(epochMs).toISOString(),
		epochMs,
		pid,
		engine: 'dsh-desktop-observer',
		profile: 'desktop',
		pollMs: 2000,
		trackedTasks: 3,
		activeTasks: 1,
	}, null, 2)}\n`, 'utf8');
}

/**
 * 每个用例都在独立进程里跑(模块级冷却/缓存互不干扰)。
 * @param env - 子进程环境变量。
 * @param options.heartbeat - `live`(自己的 pid)/ `dead`(已消失的 pid)/ `stale` / `none`。
 */
function runCase(env, options = {}) {
	const runner = join(tmpdir(), `dsh-monitor-case-${process.pid}-${Math.random().toString(16).slice(2)}.mjs`);
	writeFileSync(runner, `
		import { writeFileSync, mkdirSync } from 'node:fs';
		import { dirname } from 'node:path';
		const { ensureMonitorHost, monitorHostStatus } = await import(${JSON.stringify(new URL('../lib/monitor-host.mjs', import.meta.url).href)});
		const mode = process.env.PROBE_HEARTBEAT_MODE;
		const file = process.env.PROBE_HEARTBEAT_FILE;
		if (mode === 'live' || mode === 'dead' || mode === 'stale') {
			mkdirSync(dirname(file), { recursive: true });
			const now = Date.now();
			const epochMs = mode === 'stale' ? now - 600000 : now;
			const pid = mode === 'live' ? process.pid : Number(process.env.PROBE_HEARTBEAT_PID);
			writeFileSync(file, JSON.stringify({ at: new Date(epochMs).toISOString(), epochMs, pid, engine: 'dsh-desktop-observer', profile: 'desktop', trackedTasks: 1, activeTasks: 0 }) + '\\n', 'utf8');
		}
		const outcome = ensureMonitorHost({ reason: 'probe' });
		const status = monitorHostStatus();
		process.stdout.write('RESULT ' + JSON.stringify({ outcome, status }) + '\\n');
	`, 'utf8');
	try {
		const out = execFileSync(process.execPath, [runner], { encoding: 'utf8', env: { ...process.env, ...env }, timeout: 120000, windowsHide: true });
		const line = out.split(/\r?\n/).find((item) => item.startsWith('RESULT '));
		if (line === undefined) throw new Error(`没有拿到结果: ${out.slice(0, 400)}`);
		return JSON.parse(line.slice('RESULT '.length));
	} finally {
		rmSync(runner, { force: true });
	}
}

/** 造一个"已经死掉"的 pid(启动一个短命 node,等它退出)。 */
async function makeDeadPid() {
	const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore', windowsHide: true });
	const pid = child.pid;
	await new Promise((done) => child.on('exit', done));
	await sleep(300);
	return pid;
}

/* ---------------------------------------------------------------- *
 * 用例 1:心跳新鲜 + pid 存活 → already-running,不 spawn
 * ---------------------------------------------------------------- */
{
	const home = makeHome('fresh-live');
	const marker = join(home, 'spawned.marker');
	const result = runCase({
		DSH_HOME: home,
		DSH_SUBAGENT_MONITOR_CMD: markerCommand(marker),
		DSH_SUBAGENT_MONITOR_HOST_PROCESS: NO_HOST_IMAGE,
		PROBE_HEARTBEAT_MODE: 'live',
		PROBE_HEARTBEAT_FILE: join(home, 'subagent', 'state', 'observer-heartbeat.json'),
	});
	await sleep(900);
	check('心跳新鲜且 pid 存活 → action=already-running', result.outcome.action === 'already-running', `action=${result.outcome.action} pidAlive=${result.outcome.heartbeatPidAlive}`);
	check('心跳新鲜且 pid 存活 → 没有发生 spawn', !existsSync(marker), existsSync(marker) ? '标记文件意外存在' : '标记文件不存在');
	check('心跳新鲜且 pid 存活 → status.running=true', result.status.running === true, `running=${result.status.running} state=${result.status.state}`);
	check('心跳新鲜且 pid 存活 → 读出心跳元数据', result.status.engine === 'dsh-desktop-observer' && result.status.heartbeatPidAlive === true, `pid=${result.status.pid} engine=${result.status.engine} pidAlive=${result.status.heartbeatPidAlive}`);
	rmSync(home, { recursive: true, force: true });
}

/* ---------------------------------------------------------------- *
 * 用例 2:心跳新鲜但 pid 已消失(残留)→ 绝不能据此认为"有宿主"
 * ---------------------------------------------------------------- */
{
	const home = makeHome('residue');
	const marker = join(home, 'spawned.marker');
	const deadPid = await makeDeadPid();
	const result = runCase({
		DSH_HOME: home,
		DSH_SUBAGENT_MONITOR_CMD: markerCommand(marker),
		DSH_SUBAGENT_MONITOR_HOST_PROCESS: NO_HOST_IMAGE,
		PROBE_HEARTBEAT_MODE: 'dead',
		PROBE_HEARTBEAT_PID: String(deadPid),
		PROBE_HEARTBEAT_FILE: join(home, 'subagent', 'state', 'observer-heartbeat.json'),
	});
	for (let index = 0; index < 30 && !existsSync(marker); index += 1) await sleep(200);
	check('心跳新鲜但 pid 已消失 → **不**判 already-running', result.outcome.action !== 'already-running', `action=${result.outcome.action} pidAlive=${result.outcome.heartbeatPidAlive}`);
	check('心跳新鲜但 pid 已消失 → 判为残留(heartbeatResidue=true)', result.outcome.heartbeatResidue === true, `residue=${result.outcome.heartbeatResidue} pidAlive=${result.status.heartbeatPidAlive}`);
	check('心跳新鲜但 pid 已消失 → 继续往下判并真的拉起', result.outcome.action === 'launched' && existsSync(marker), `action=${result.outcome.action} marker=${existsSync(marker)}`);
	rmSync(home, { recursive: true, force: true });
}

/* ---------------------------------------------------------------- *
 * 用例 3:心跳不存在 → launched,发生一次 spawn
 * ---------------------------------------------------------------- */
{
	const home = makeHome('missing');
	const marker = join(home, 'spawned.marker');
	const result = runCase({
		DSH_HOME: home,
		DSH_SUBAGENT_MONITOR_CMD: markerCommand(marker),
		DSH_SUBAGENT_MONITOR_HOST_PROCESS: NO_HOST_IMAGE,
		PROBE_HEARTBEAT_MODE: 'none',
	});
	for (let index = 0; index < 30 && !existsSync(marker); index += 1) await sleep(200);
	check('心跳缺失 → action=launched', result.outcome.action === 'launched', `action=${result.outcome.action} exe=${result.outcome.exe}`);
	check('心跳缺失 → 真的 spawn 了(标记文件出现)', existsSync(marker), existsSync(marker) ? `marker=${readFileSync(marker, 'utf8')}` : '标记文件没出现');
	check('心跳缺失 → 写了拉起日志', existsSync(join(home, 'subagent', 'state', 'monitor-host.log')), 'monitor-host.log');
	check('心跳缺失 → lastLaunch 记录 launched', result.status.lastLaunch?.action === 'launched', JSON.stringify(result.status.lastLaunch));
	rmSync(home, { recursive: true, force: true });
}

/* ---------------------------------------------------------------- *
 * 用例 4:总开关 off → skipped,不 spawn
 * ---------------------------------------------------------------- */
{
	const home = makeHome('off');
	const marker = join(home, 'spawned.marker');
	const result = runCase({
		DSH_HOME: home,
		DSH_SUBAGENT_MONITOR_CMD: markerCommand(marker),
		DSH_SUBAGENT_MONITOR_HOST_PROCESS: NO_HOST_IMAGE,
		DSH_SUBAGENT_AUTOSTART_MONITOR: 'off',
		PROBE_HEARTBEAT_MODE: 'none',
	});
	await sleep(900);
	check('总开关 off → action=skipped', result.outcome.action === 'skipped', `action=${result.outcome.action} reason=${result.outcome.reason}`);
	check('总开关 off → 没有发生 spawn', !existsSync(marker), existsSync(marker) ? '标记文件意外存在' : '标记文件不存在');
	check('总开关 off → status.autostart=false', result.status.autostart === false, `autostart=${result.status.autostart}`);
	rmSync(home, { recursive: true, force: true });
}

/* ---------------------------------------------------------------- *
 * 用例 5:心跳过期 + GUI 宿主进程在(跑旧观察器)→ gui-open-old-observer,不 spawn
 * 用 DSH_SUBAGENT_MONITOR_HOST_PROCESS=node.exe 造确定性条件:本用例自己就跑在 node.exe 上,
 * 命令行既没有 --type= 也没有 --expose-internals,所以按规则就是"真正的 GUI 宿主"。
 * ---------------------------------------------------------------- */
{
	const home = makeHome('guihost');
	const marker = join(home, 'spawned.marker');
	const result = runCase({
		DSH_HOME: home,
		DSH_SUBAGENT_MONITOR_CMD: markerCommand(marker),
		DSH_SUBAGENT_MONITOR_HOST_PROCESS: 'node.exe',
		DSH_SUBAGENT_MONITOR_COOLDOWN_MS: '0',
		PROBE_HEARTBEAT_MODE: 'stale',
		PROBE_HEARTBEAT_FILE: join(home, 'subagent', 'state', 'observer-heartbeat.json'),
	});
	await sleep(900);
	check('心跳过期+GUI 宿主在 → action=gui-open-old-observer', result.outcome.action === 'gui-open-old-observer', `action=${result.outcome.action} reason=${result.outcome.reason}`);
	check('心跳过期+GUI 宿主在 → 没有发生 spawn', !existsSync(marker), existsSync(marker) ? '标记文件意外存在' : '标记文件不存在');
	check('心跳过期+GUI 宿主在 → 报出 GUI 宿主 pid', Array.isArray(result.outcome.guiHostPids) && result.outcome.guiHostPids.length > 0, `guiHosts=${JSON.stringify(result.outcome.guiHostPids ?? null)}`);
	check('心跳过期+GUI 宿主在 → status.state=host-older-observer', result.status.state === 'host-older-observer', `state=${result.status.state} running=${result.status.running}`);
	rmSync(home, { recursive: true, force: true });
}

/* ---------------------------------------------------------------- *
 * 用例 6:真实的 `--expose-internals` 进程必须分类成 dsh-cli(我们自己的子任务),不是宿主
 * ---------------------------------------------------------------- */
{
	const home = makeHome('clidsh');
	const marker = join(home, 'spawned.marker');
	const cli = spawn(process.execPath, ['--expose-internals', '-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore', windowsHide: true });
	try {
		await sleep(1200);
		const result = runCase({
			DSH_HOME: home,
			DSH_SUBAGENT_MONITOR_CMD: markerCommand(marker),
			DSH_SUBAGENT_MONITOR_HOST_PROCESS: 'node.exe',
			DSH_SUBAGENT_MONITOR_COOLDOWN_MS: '0',
			PROBE_HEARTBEAT_MODE: 'none',
		});
		const cliPids = result.status.cliProcessPids ?? [];
		const guiPids = result.status.guiHostPids ?? [];
		check('真实 --expose-internals 进程 → 分类为 dsh-cli', cliPids.includes(cli.pid), `cli.pid=${cli.pid} cliProcessPids=${JSON.stringify(cliPids)}`);
		check('真实 --expose-internals 进程 → **不**被当成 GUI 宿主', !guiPids.includes(cli.pid), `guiHostPids=${JSON.stringify(guiPids)}`);
	} finally {
		cli.kill();
		rmSync(home, { recursive: true, force: true });
	}
}

/* ---------------------------------------------------------------- *
 * 用例 7:FORCE=1 绕过 GUI 宿主闸门(手动逃生门)
 * 条件与用例 5 相同,只是多了 FORCE —— 结果必须从 gui-open-old-observer 变成 launched。
 * ---------------------------------------------------------------- */
{
	const home = makeHome('force');
	const marker = join(home, 'spawned.marker');
	const result = runCase({
		DSH_HOME: home,
		DSH_SUBAGENT_MONITOR_CMD: markerCommand(marker),
		DSH_SUBAGENT_MONITOR_HOST_PROCESS: 'node.exe',
		DSH_SUBAGENT_MONITOR_FORCE: '1',
		PROBE_HEARTBEAT_MODE: 'none',
	});
	for (let index = 0; index < 30 && !existsSync(marker); index += 1) await sleep(200);
	check('FORCE=1 绕过 GUI 宿主闸门 → action=launched', result.outcome.action === 'launched', `action=${result.outcome.action} reason=${result.outcome.reason}`);
	check('FORCE=1 绕过 GUI 宿主闸门 → 真的 spawn 了', existsSync(marker), existsSync(marker) ? `marker=${readFileSync(marker, 'utf8')}` : '标记文件没出现');
	rmSync(home, { recursive: true, force: true });
}

/* ---------------------------------------------------------------- *
 * 用例 8:命令行分类规则(纯函数)
 * ---------------------------------------------------------------- */
{
	const chromium = classifyCommandLine('"C:\\Program Files\\DSH Desktop\\DSH Desktop.exe" --type=renderer --user-data-dir=C:\\x');
	const cli = classifyCommandLine('"C:\\Program Files\\DSH Desktop\\DSH Desktop.exe" --expose-internals C:\\dsh\\cli.mjs --prompt-stdin');
	const gui = classifyCommandLine('"C:\\Program Files\\DSH Desktop\\DSH Desktop.exe"');
	const empty = classifyCommandLine('');
	check('分类规则:--type= → chromium-child', chromium === 'chromium-child', chromium);
	check('分类规则:--expose-internals → dsh-cli', cli === 'dsh-cli', cli);
	check('分类规则:都没有 → gui-host', gui === 'gui-host', gui);
	check('分类规则:空命令行 → gui-host', empty === 'gui-host', empty);
}

const failed = results.filter((entry) => !entry.ok);
process.stdout.write(`\n${results.length - failed.length}/${results.length} 项通过${failed.length === 0 ? ',全绿 ✅' : ',存在失败 ❌'}\n`);
process.exitCode = failed.length === 0 ? 0 : 1;
