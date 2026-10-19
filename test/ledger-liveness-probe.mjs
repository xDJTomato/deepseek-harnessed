/**
 * 台账"幽灵记录"自检:记录说在跑、进程早没了的时候,`listTasks()` / `killByCaller()` 必须按 pid 判活。
 *
 * 背景(实测踩到):`state/tasks` 是**跨桥接进程共享**的目录,桥接进程被杀/退出时,
 * 它正在跑的任务**永远不会有人去改 status** —— 于是留下 `status:"running"` 但 pid 早已消失的
 * 幽灵记录。`CLI --list` 和 `dsh_task_kill {caller}` 过去直接照 status 过滤,调用方会以为
 * 自己还挂着好几个任务(实测 7 条"在跑"里 4 条是幽灵)。
 *
 * ⚠️ 全程在**临时 DSH_HOME** 里造假台账,绝不碰真 `%USERPROFILE%\.dsh`。
 *
 * 用法: node test/ledger-liveness-probe.mjs
 */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

const results = [];
function check(name, ok, detail = '') {
	results.push({ name, ok, detail });
	process.stdout.write(`${ok ? '✅' : '❌'} ${name}${detail === '' ? '' : ` — ${detail}`}\n`);
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const home = mkdtempSync(join(tmpdir(), 'dsh-ledger-probe-'));
process.env.DSH_HOME = home;
const children = [];
try {
const { killByCaller, killTreeSync, listTasks, liveTaskInfos, taskState } = await import('../lib/tasks.mjs');

const tasksRoot = join(home, 'subagent', 'state', 'tasks');
mkdirSync(tasksRoot, { recursive: true });

/** 造一条任务记录。 */
function makeTask(id, { caller, pid, status = 'running', withMeta = false }) {
	const dir = join(tasksRoot, id);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, 'task.json'), `${JSON.stringify({
		id,
		status,
		caller,
		workspace: home,
		pid,
		startedAt: new Date(Date.now() - 60000).toISOString(),
		expectedSeconds: 300,
		deadlineAt: new Date(Date.now() + 240000).toISOString(),
	}, null, 2)}\n`, 'utf8');
	if (withMeta) writeFileSync(join(dir, 'meta.json'), `${JSON.stringify({ phase: 'running', sessionId: 'probe-session' })}\n`, 'utf8');
	return dir;
}

/** 一个确定已经死掉的 pid。 */
async function deadPid() {
	const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore', windowsHide: true });
	children.push(child);
	const pid = child.pid;
	await once(child, 'exit');
	await sleep(300);
	return pid;
}

const CALLER = 'probe-ghost-caller';
const dead = await deadPid();
// 真在跑的:用一个长期活着的 node 进程当任务根进程。
const aliveChild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 3600000)'], { stdio: 'ignore', windowsHide: true });
children.push(aliveChild);
await once(aliveChild, 'spawn');
await sleep(600);

const ghostDir = makeTask('ledgergost-000000-00000001', { caller: CALLER, pid: dead, withMeta: true });
const liveDir = makeTask('ledgerlive-000000-00000002', { caller: CALLER, pid: aliveChild.pid, withMeta: true });
const noPidDir = makeTask('ledgernopid-000000-00000003', { caller: CALLER, pid: null });
// 另一条"记录说在跑、但 meta.json 已写明结束原因"的:应按 meta 推导成终态(不是幽灵)。
const derivedDir = makeTask('ledgerdrvd-000000-00000004', { caller: CALLER, pid: dead, withMeta: false });
writeFileSync(join(derivedDir, 'meta.json'), `${JSON.stringify({ phase: 'done', stopReason: 'completed' })}\n`, 'utf8');

// 只落盘,不调用启动入口:这些任务不属于本进程的 live map。
check('跨进程夹具不在本进程 live map', liveTaskInfos().length === 0);
const metaCases = [];
for (const [name, text] of [
	['empty-object', '{}'],
	['empty-file', ''],
	['broken-json', '{broken'],
	['missing-stopReason', JSON.stringify({ phase: 'done', sessionId: 'probe-session' })],
	['null-meta', 'null'],
	['null-stopReason', JSON.stringify({ stopReason: null })],
	['empty-stopReason', JSON.stringify({ stopReason: '' })],
	['whitespace-stopReason', JSON.stringify({ stopReason: '   ' })],
	['invalid-stopReason', JSON.stringify({ stopReason: 123 })],
]) {
	for (const [label, pid, status, stale] of [
		['alive', aliveChild.pid, 'running', false],
		['dead', dead, 'lost', true],
	]) {
		const id = `meta-${name}-${label}`;
		const dir = makeTask(id, { caller: 'probe-meta-caller', pid });
		writeFileSync(join(dir, 'meta.json'), text, 'utf8');
		metaCases.push({ id, status, stale, pidAlive: !stale, derived: stale });
	}
}
for (const stopReason of ['completed', 'error', 'aborted']) {
	for (const [label, pid] of [['alive', aliveChild.pid], ['dead', dead]]) {
		const id = `meta-terminal-${stopReason}-${label}`;
		const dir = makeTask(id, { caller: 'probe-meta-caller', pid });
		writeFileSync(join(dir, 'meta.json'), JSON.stringify({ stopReason }), 'utf8');
		metaCases.push({ id, status: stopReason === 'completed' ? 'ok' : 'error', stale: false, pidAlive: null, derived: true });
	}
}
for (const status of ['cancelled', 'deadline', 'killed']) {
	for (const stopReason of ['completed', 'error']) {
		const id = `meta-preserve-${status}-${stopReason}`;
		const dir = makeTask(id, { caller: 'probe-meta-caller', pid: aliveChild.pid, status });
		writeFileSync(join(dir, 'meta.json'), JSON.stringify({ stopReason }), 'utf8');
		metaCases.push({ id, status, stale: false, pidAlive: null, derived: false });
	}
}

const all = listTasks(500);
const byId = new Map(all.map((task) => [task.id, task]));
for (const expected of metaCases) {
	const listed = byId.get(expected.id);
	check(`listTasks ${expected.id}`,
		listed?.status === expected.status && listed?.stale === expected.stale
		&& listed?.pidAlive === expected.pidAlive && listed?.derived === expected.derived,
		JSON.stringify({ status: listed?.status, stale: listed?.stale, pidAlive: listed?.pidAlive, derived: listed?.derived }));
	const state = taskState(expected.id);
	check(`taskState ${expected.id}`, state.status === expected.status, `status=${state.status}`);
}

/* ---------------------------------------------------------------- *
 * 1. listTasks 必须按 pid 判活
 * ---------------------------------------------------------------- */
const ghost = byId.get('ledgergost-000000-00000001');
check('幽灵记录 → status 变成 lost', ghost?.status === 'lost', `status=${ghost?.status}`);
check('幽灵记录 → 带 stale:true', ghost?.stale === true, `stale=${ghost?.stale} pidAlive=${ghost?.pidAlive}`);
const live = byId.get('ledgerlive-000000-00000002');
check('真在跑的记录 → status 仍是 running', live?.status === 'running', `status=${live?.status}`);
check('真在跑的记录 → stale:false 且 pidAlive:true', live?.stale === false && live?.pidAlive === true, `stale=${live?.stale} pidAlive=${live?.pidAlive}`);
const noPid = byId.get('ledgernopid-000000-00000003');
check('没记 pid 的记录 → 不当作在跑(标 stale)', noPid?.stale === true && noPid?.status === 'lost', `status=${noPid?.status} stale=${noPid?.stale}`);
const derived = byId.get('ledgerdrvd-000000-00000004');
check('meta 已写明结束 → 按 meta 推导成终态(不是幽灵)', derived?.status === 'ok' && derived?.stale === false, `status=${derived?.status} stale=${derived?.stale}`);
check('listTasks 不再把幽灵报成在跑', all.filter((task) => task.caller === CALLER && task.status === 'running').length === 1,
	`号称在跑 ${all.filter((task) => task.caller === CALLER && task.status === 'running').length} 条(应为 1:只有真活着那条)`);

/* ---------------------------------------------------------------- *
 * 2. taskState 与 listTasks 口径一致
 * ---------------------------------------------------------------- */
const ghostState = taskState('ledgergost-000000-00000001');
check('taskState 对死 PID + running meta 给 lost,绝不 error', ghostState.status === 'lost', `status=${ghostState.status}`);
const liveState = taskState('ledgerlive-000000-00000002');
check('taskState 对活 PID + running meta 保持 running', liveState.status === 'running', `status=${liveState.status}`);

/* ---------------------------------------------------------------- *
 * 3. killByCaller 只杀真的在跑的,并把幽灵回报进 stale
 * ---------------------------------------------------------------- */
const outcome = killByCaller(CALLER, '自检:按 caller 强杀');
check('killByCaller → 只杀 1 个(真的在跑的那个)', outcome.killed.length === 1, `killed=${outcome.killed.length}`);
check('killByCaller → killed 就是活着的那个', outcome.killed[0]?.job_id === 'ledgerlive-000000-00000002', JSON.stringify(outcome.killed.map((item) => item.job_id)));
check('killByCaller → 幽灵进 stale 数组', outcome.stale.some((item) => item.job_id === 'ledgergost-000000-00000001'), JSON.stringify(outcome.stale.map((item) => item.job_id)));
check('killByCaller → stale 里标 status=lost', outcome.stale.every((item) => item.status === 'lost'), JSON.stringify(outcome.stale));
check('killByCaller → 幽灵不会被算成"已强杀"', outcome.killed.length === 1 && !outcome.killed.some((item) => item.job_id.startsWith('ledgergost')), `killed=${JSON.stringify(outcome.killed.map((item) => item.job_id))}`);
check('killByCaller → 按 meta 推导成终态的那条不进 stale', !outcome.stale.some((item) => item.job_id === 'ledgerdrvd-000000-00000004'), JSON.stringify(outcome.stale.map((item) => item.job_id)));

/* ---------------------------------------------------------------- *
 * 4. 真在跑的那个确实被杀掉了(不是只改台账)
 * ---------------------------------------------------------------- */
// taskkill 是"请求终止",进程退出是异步的。**必须轮询**:固定等 1.2 秒在机器忙的
// 时候会假红(实测同一条断言 3 次里红 1 次),而被杀的进程其实已经没了。
let alive = true;
let waitedMs = 0;
for (const step of [200, 300, 500, 800, 1200, 2000]) {
	await sleep(step);
	waitedMs += step;
	try {
		process.kill(aliveChild.pid, 0);
	} catch {
		alive = false;
		break;
	}
}
check('killByCaller → 真的杀掉了进程', !alive, `pid ${aliveChild.pid} alive=${alive}(等了 ${waitedMs}ms)`);
const afterKill = listTasks(500).find((task) => task.id === 'ledgerlive-000000-00000002');
check('killByCaller → 被杀的记录收敛成终态', afterKill?.status === 'killed', `status=${afterKill?.status}`);

/* ---------------------------------------------------------------- *
 * 5. 再杀一次:没有活的就该 notFound(但仍回报幽灵)
 * ---------------------------------------------------------------- */
const second = killByCaller(CALLER, '自检:再杀一次');
check('再杀一次 → killed 为空且 notFound', second.killed.length === 0 && second.notFound === true, `killed=${second.killed.length} notFound=${second.notFound} stale=${second.stale.length}`);
check('再杀一次 → 仍然回报幽灵(别让调用方以为还有任务)', second.stale.length === 2, `stale=${JSON.stringify(second.stale.map((item) => item.job_id))}`);

/* ---------------------------------------------------------------- *
 * 6. 强杀必须"验证过才报成功"
 *
 * 踩过:killTreeSync 之前是 spawn 版 taskkill,发完就返回、不看结果 —— 强杀失败
 * (权限不足 / pid 已变 / taskkill 起不来)也会报 killed:true,调用方以为卡死的
 * 任务停了,进程树还在后台跑。现在用 execFileSync:taskkill 只在确实终止进程时返回 0。
 * ---------------------------------------------------------------- */
const syncDead = killTreeSync(dead);
check('killTreeSync 杀一个早已死掉的 pid → 如实报失败(不谎报已强杀)',
	syncDead.ok === false && syncDead.note.includes('未确认终止'), JSON.stringify(syncDead));
const syncBad = killTreeSync(null);
check('killTreeSync 收到无效 pid → 也是失败', syncBad.ok === false && syncBad.note.includes('pid 无效'), JSON.stringify(syncBad));

} finally {
	// 只清理本探针创建的 ChildProcess 和 mkdtemp 目录,不按台账扫描清理。
	try {
		for (const child of children) {
			if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
				const exited = once(child, 'exit');
				child.kill();
				await exited;
			}
		}
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
}

const failed = results.filter((entry) => !entry.ok);
process.stdout.write(`\n${results.length - failed.length}/${results.length} 项通过${failed.length === 0 ? ',全绿 ✅' : ',存在失败 ❌'}\n`);
process.exitCode = failed.length === 0 ? 0 : 1;
