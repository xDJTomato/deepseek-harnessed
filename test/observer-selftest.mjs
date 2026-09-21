/**
 * 观察器插件的隔离自检:用假的 ctx 跑一遍 apply,验证事件与日志本身没问题。
 *
 * ⚠️ 必须用**隔离的 DSH_HOME**:观察器会写 `state/observer.log` 与心跳文件
 * `state/observer-heartbeat.json`,而心跳是"有没有带监控的宿主在跑"的判活信号 ——
 * 自检写进真 DSH_HOME 会留下一个"看起来像宿主"的假心跳(踩过:桥接层差点据此
 * 判定没有宿主、又去拉起一个 DSH Desktop)。所以这里自己造一个临时 HOME,
 * **必须在 import 观察器之前**设置好。
 *
 * 用法: node test/observer-selftest.mjs
 */
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { zstdCompressSync } from 'node:zlib';

const isolatedHome = mkdtempSync(join(tmpdir(), 'dsh-observer-selftest-'));
process.env.DSH_HOME = isolatedHome;
// 用量/速率的节流在自检里调小,否则要等 5~20 秒才采得到第二个样本。
process.env.DSH_SUBAGENT_OBSERVER_USAGE_REFRESH_MS = '150';
process.env.DSH_SUBAGENT_OBSERVER_RATE_MIN_MS = '150';
process.env.DSH_SUBAGENT_OBSERVER_ACTIVITY_MS = '100';
const { apply, foldTranscript, inject, name, rateOf } = await import('../monitor/observer.mjs');

const home = isolatedHome;
const logPath = join(home, 'subagent', 'state', 'observer.log');
if (existsSync(logPath)) rmSync(logPath, { force: true });

const emitted = [];
const ctx = {
	emit: (event, ...args) => emitted.push({ event, args }),
	setInterval: (fn, ms) => {
		const timer = setInterval(fn, ms);
		timer.unref?.();
		return timer;
	},
	on: () => {},
};

console.log('plugin name =', name, ' inject =', JSON.stringify(inject));
if (typeof apply !== 'function') throw new Error('apply 不是函数');
apply(ctx);

// 制造一个假的"正在跑"的任务现场:会话 id 由 meta.json 提供(模拟 runner 提前写)。
const tasksRoot = join(home, 'subagent', 'state', 'tasks');
const probeId = 'observertest-000000-00000000';
const probeDir = join(tasksRoot, probeId);
mkdirSync(probeDir, { recursive: true });
const sessionId = 'session-observer-selftest-0000-0000-000000000000';
writeFileSync(join(probeDir, 'task.json'), JSON.stringify({
	id: probeId,
	status: 'running',
	workspace: 'D:\\observer-selftest',
	startedAt: new Date().toISOString(),
}, null, 2));
writeFileSync(join(probeDir, 'meta.json'), JSON.stringify({
	sessionId, phase: 'running', provider: 'demo-gateway', model: 'deepseek-v4.1-flash', reasoningEffort: 'high',
}, null, 2));

// 手动再跑一轮 tick(插件每秒自己也会跑,这里直接等)
await new Promise((done) => setTimeout(done, 300));
await new Promise((done) => setTimeout(done, Number(process.env.DSH_SUBAGENT_OBSERVER_INTERVAL ?? 2000) + 200));

const added = emitted.find((item) => item.event === 'api-session/added'
	&& item.args[0]?.sessionId === sessionId);
const status = emitted.find((item) => item.event === 'api-session/status'
	&& item.args[0] === sessionId);
const checks = [
	['捕获到 api-session/added', added !== undefined],
	['added 的 sessionId 正确', added?.args[0]?.sessionId === sessionId],
	['added 带上了 cwd', added?.args[0]?.cwd === 'D:\\observer-selftest'],
	['added 带上了调用方投影(悬浮卡片据此分组)', added?.args[0]?.projections?.values?.['dsh-subagent'] !== undefined],
	['投影水位是小自增计数(不会挡住宿主真实投影)', Number.isInteger(added?.args[0]?.projections?.asOfSeq)
		&& added.args[0].projections.asOfSeq < 1000],
	['标题带调用方前缀', String(added?.args[0]?.projections?.values?.title ?? '').startsWith('⚡ ')],
	['运行中标题带「勿点开」提示(打开会写坏外部会话日志)',
		String(added?.args[0]?.projections?.values?.title ?? '').includes('勿点开')],
	['捕获到 api-session/status(running=true)', status?.args[0] === sessionId && status?.args[1] === true],
	['写了 observer.log', existsSync(logPath)],
];

// 悬浮卡片要显示"这次 dsh_task 调用实际用的模型":值取自任务现场的 meta.json
// (runner 建会话时就写好了 —— 调用方省略 model/provider 时它也已经解析成真实值)。
const modelMeta = added?.args[0]?.projections?.values?.['dsh-subagent'];
checks.push(['投影带出实际生效的模型/服务商/推理档(meta.json 优先)',
	modelMeta?.model === 'deepseek-v4.1-flash' && modelMeta?.provider === 'demo-gateway'
	&& modelMeta?.reasoningEffort === 'high',
	JSON.stringify({ model: modelMeta?.model, provider: modelMeta?.provider, effort: modelMeta?.reasoningEffort })]);

// 心跳:桥接层用它判断"有没有带监控的 GUI 宿主在跑",从而决定要不要拉起 DSH Desktop。
const heartbeatPath = join(home, 'subagent', 'state', 'observer-heartbeat.json');
let heartbeat = null;
try {
	heartbeat = JSON.parse(readFileSync(heartbeatPath, 'utf8'));
} catch {
	heartbeat = null;
}
checks.push(['写了心跳文件(observer-heartbeat.json)', heartbeat !== null]);
checks.push(['心跳带引擎标识与 pid', heartbeat?.engine === 'dsh-desktop-observer'
	&& Number.isInteger(heartbeat?.pid)]);
checks.push(['心跳时间是新鲜的(桥接层据此判定宿主活着)',
	typeof heartbeat?.epochMs === 'number' && Math.abs(Date.now() - heartbeat.epochMs) < 30000,
	String(heartbeat?.at)]);

// 僵尸记录:status=running 但进程早没了,不应该被标成"正在执行"。
const ghostId = 'observertest-000000-11111111';
const ghostDir = join(tasksRoot, ghostId);
const ghostSession = 'session-observer-selftest-1111-1111-111111111111';
mkdirSync(ghostDir, { recursive: true });
writeFileSync(join(ghostDir, 'task.json'), JSON.stringify({
	id: ghostId,
	status: 'running',
	workspace: 'D:\\observer-selftest',
	startedAt: new Date().toISOString(),
}, null, 2));
writeFileSync(join(ghostDir, 'meta.json'), JSON.stringify({ sessionId: ghostSession, pid: 999999 }, null, 2));
await new Promise((done) => setTimeout(done, Number(process.env.DSH_SUBAGENT_OBSERVER_INTERVAL ?? 2000) + 400));
const ghostAdded = emitted.find((item) => item.event === 'api-session/added'
	&& item.args[0]?.sessionId === ghostSession);
checks.push(['僵尸任务(进程已死)不被标为运行中', ghostAdded !== undefined && ghostAdded.args[0].running === false]);
checks.push(['僵尸任务没发出 running=true', !emitted.some((item) => item.event === 'api-session/status'
	&& item.args[0] === ghostSession && item.args[1] === true)]);
// 两个文件都没有模型信息:必须如实是 null(不是 undefined,也不要瞎猜一个)
const ghostMeta = ghostAdded?.args[0]?.projections?.values?.['dsh-subagent'];
checks.push(['两个文件都没写模型时投影是 null(卡片据此显示「默认」)',
	ghostMeta?.model === null && ghostMeta?.provider === null && ghostMeta?.reasoningEffort === null,
	JSON.stringify({ model: ghostMeta?.model, provider: ghostMeta?.provider, effort: ghostMeta?.reasoningEffort })]);
rmSync(ghostDir, { recursive: true, force: true });

// 模拟任务结束:改成 ok,应当发出 running=false
writeFileSync(join(probeDir, 'task.json'), JSON.stringify({
	id: probeId,
	status: 'ok',
	workspace: 'D:\\observer-selftest',
	startedAt: new Date().toISOString(),
}, null, 2));
await new Promise((done) => setTimeout(done, Number(process.env.DSH_SUBAGENT_OBSERVER_INTERVAL ?? 2000) + 400));
const stop = emitted.filter((item) => item.event === 'api-session/status').at(-1);
checks.push(['任务结束后发出 running=false', stop?.args[0] === sessionId && stop?.args[1] === false]);

rmSync(probeDir, { recursive: true, force: true });

const defaultHome = join(process.env.USERPROFILE ?? 'C:\\', '.dsh');
// 关键回归:任务**曾经**被投影成 running,之后变成幽灵(status 还写 running、进程已消失)
// 且已经超出重播窗口 —— 必须仍然推一次 running=false 的投影,否则卡片里会永远挂着
// 一个"活跃"的幽灵任务(实测就是"4 个活跃"里那几个)。
const stuckSession = 'session-observer-selftest-2222-2222-222222222222';
const stuckId = 'observertest-000000-22222222';
const stuckDir = join(tasksRoot, stuckId);
mkdirSync(stuckDir, { recursive: true });
writeFileSync(join(stuckDir, 'task.json'), JSON.stringify({
	id: stuckId,
	status: 'running',
	workspace: 'D:\\observer-selftest',
	startedAt: new Date().toISOString(),
}, null, 2));
// 用自检进程自己的 pid:一定活着 → 应当被投影成 running=true
writeFileSync(join(stuckDir, 'meta.json'), JSON.stringify({ sessionId: stuckSession, pid: process.pid }, null, 2));
await new Promise((done) => setTimeout(done, Number(process.env.DSH_SUBAGENT_OBSERVER_INTERVAL ?? 2000) + 400));
const stuckFirst = emitted.filter((item) => item.event === 'api-session/added'
	&& item.args[0]?.sessionId === stuckSession).at(-1);
checks.push(['曾经在跑的任务先被投影成 running=true',
	stuckFirst?.args[0]?.projections?.values?.['dsh-subagent']?.running === true]);

// 变成幽灵 + 把 startedAt 拨到重播窗口之外(模拟"早就死了、已经不再重播")
const old = new Date(Date.now() - 30 * 60 * 1000).toISOString();
writeFileSync(join(stuckDir, 'task.json'), JSON.stringify({
	id: stuckId,
	status: 'running',
	workspace: 'D:\\observer-selftest',
	startedAt: old,
}, null, 2));
writeFileSync(join(stuckDir, 'meta.json'), JSON.stringify({ sessionId: stuckSession, pid: 999999 }, null, 2));
await new Promise((done) => setTimeout(done, Number(process.env.DSH_SUBAGENT_OBSERVER_INTERVAL ?? 2000) + 600));
const stuckLast = emitted.filter((item) => item.event === 'api-session/added'
	&& item.args[0]?.sessionId === stuckSession).at(-1);
checks.push(['幽灵任务即使出了重播窗口也会被推一次 running=false(否则卡片永远显示活跃)',
	stuckLast?.args[0]?.projections?.values?.['dsh-subagent']?.running === false]);
checks.push(['幽灵任务的标题不再带「勿点开」',
	!String(stuckLast?.args[0]?.projections?.values?.title ?? '').includes('勿点开')]);
checks.push(['幽灵任务发出了 running=false 状态事件',
	emitted.some((item) => item.event === 'api-session/status'
		&& item.args[0] === stuckSession && item.args[1] === false)]);
rmSync(stuckDir, { recursive: true, force: true });

// 「记录说在跑、但 pid 一直没写出来」的完整路径:
//   ① 刚起 → 在宽限期内,先被投影成 running=true(和真实任务一样);
//   ② 两小时后 pid 还是没出现 → 判定为半成品记录,不再算在跑,
//      并且**必须推一次收尾投影**把客户端的"运行中"抹掉(否则永远显示活跃)。
// 实测就是这条:一条 2 小时前、连 caller 都缺的记录一直挂在"活跃"里。
const nopidFresh = 'session-observer-selftest-3333-3333-333333333333';
const nopidFreshDir = join(tasksRoot, 'observertest-000000-33333333');
mkdirSync(nopidFreshDir, { recursive: true });
const nopidTask = (startedAt) => JSON.stringify({
	id: 'observertest-000000-33333333',
	status: 'running',
	workspace: 'D:\\observer-selftest',
	// meta.json 里没有模型信息 → 只能退回 task.json 的"请求值"(调用方自己指定时才有)
	provider: 'caller-asked-provider',
	model: 'caller-asked-model',
	reasoningEffort: 'low',
	startedAt,
}, null, 2);
writeFileSync(join(nopidFreshDir, 'task.json'), nopidTask(new Date().toISOString()));
writeFileSync(join(nopidFreshDir, 'meta.json'), JSON.stringify({ sessionId: nopidFresh }, null, 2));
const tickMs = Number(process.env.DSH_SUBAGENT_OBSERVER_INTERVAL ?? 2000) + 600;
await new Promise((done) => setTimeout(done, tickMs));
const freshProjection = emitted.filter((item) => item.event === 'api-session/added'
	&& item.args[0]?.sessionId === nopidFresh).at(-1);
checks.push(['刚起、还没写 pid 的任务仍算在跑(起进程的窗口要信)',
	freshProjection?.args[0]?.projections?.values?.['dsh-subagent']?.running === true]);
// meta.json 里没有模型信息时的退路:用 task.json 记的"请求值"(桥接层写的)
const fallbackMeta = freshProjection?.args[0]?.projections?.values?.['dsh-subagent'];
checks.push(['meta.json 没写模型时退回 task.json 的请求值',
	fallbackMeta?.model === 'caller-asked-model' && fallbackMeta?.provider === 'caller-asked-provider'
	&& fallbackMeta?.reasoningEffort === 'low',
	JSON.stringify({ model: fallbackMeta?.model, provider: fallbackMeta?.provider, effort: fallbackMeta?.reasoningEffort })]);

writeFileSync(join(nopidFreshDir, 'task.json'), nopidTask(new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()));
await new Promise((done) => setTimeout(done, tickMs));
const staleProjection = emitted.filter((item) => item.event === 'api-session/added'
	&& item.args[0]?.sessionId === nopidFresh).at(-1);
checks.push(['没 pid 且早已超期的半成品记录不再算在跑,且会推一次收尾投影(否则永远显示活跃)',
	staleProjection?.args[0]?.projections?.values?.['dsh-subagent']?.running === false]);
const nopidStatuses = emitted.filter((item) => item.event === 'api-session/status' && item.args[0] === nopidFresh);
checks.push(['半成品记录最后停在 running=false(① 期间发过 true,② 之后必须收回来)',
	nopidStatuses.at(-1)?.args[1] === false]);
rmSync(nopidFreshDir, { recursive: true, force: true });

// 卡片底部状态条的数据源:从子代理会话日志里折叠 token 用量。
// 用一个**多帧 zstd** 的合成日志(真日志就是追加写的多帧),并专门验宿主
// token-meter 的"替换语义":同一 (turn, step) 的 usage 样本只能有一次生效
// (usage chunk 是早到的样本,assistant/message 是同轮的最终样本),
// 否则输出 token 会被数成两倍。
const usageSession = 'session-observer-selftest-5555-5555-555555555555';
const usageBucket = join(home, 'sessions', '--C-usage-probe--', usageSession);
mkdirSync(usageBucket, { recursive: true });
const usageEvents = [
	{ type: 'assistant/chunk', data: { turn: 1, step: 1, chunk: { type: 'usage', usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 900, cacheWriteTokens: 0 } } } },
	{ type: 'assistant/message', data: { turn: 1, step: 1, usage: { inputTokens: 100, outputTokens: 12, cacheReadTokens: 900, cacheWriteTokens: 0 } } },
	{ type: 'assistant/message', data: { turn: 2, step: 1, usage: { inputTokens: 50, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 10 } } },
];
writeFileSync(join(usageBucket, 'session.jsonl.zstd'), Buffer.concat([
	zstdCompressSync(Buffer.from(JSON.stringify(usageEvents[0]) + '\n', 'utf8')),
	zstdCompressSync(Buffer.from(usageEvents.slice(1).map((event) => JSON.stringify(event)).join('\n') + '\n', 'utf8')),
]));

const usageTaskId = 'observertest-000000-55555555';
const usageTaskDir = join(tasksRoot, usageTaskId);
mkdirSync(usageTaskDir, { recursive: true });
writeFileSync(join(usageTaskDir, 'task.json'), JSON.stringify({
	id: usageTaskId,
	status: 'running',
	workspace: 'D:\\usage-probe',
	startedAt: new Date().toISOString(),
	caller: 'usage-probe',
}, null, 2));
writeFileSync(join(usageTaskDir, 'meta.json'), JSON.stringify({ sessionId: usageSession, pid: process.pid }, null, 2));
await new Promise((done) => setTimeout(done, Number(process.env.DSH_SUBAGENT_OBSERVER_INTERVAL ?? 2000) + 600));
const usageProjection = emitted.filter((item) => item.event === 'api-session/added'
	&& item.args[0]?.sessionId === usageSession).at(-1)?.args[0]?.projections?.values?.['dsh-subagent']?.usage;
checks.push(['多帧日志能解出 token 用量', usageProjection !== undefined && usageProjection !== null]);
checks.push(['同轮 usage 样本是替换而不是累加(输出 17 而不是 22)',
	usageProjection?.outputTokens === 17, 'output=' + usageProjection?.outputTokens]);
checks.push(['缓存读数与未缓存输入分开统计',
	usageProjection?.cacheReadTokens === 900 && usageProjection?.uncachedInputTokens === 150
	&& usageProjection?.cacheWriteTokens === 10,
	'cacheRead=' + usageProjection?.cacheReadTokens + ' input=' + usageProjection?.uncachedInputTokens]);
checks.push(['算出了 prompt 侧总量(缓存命中率的分母)',
	usageProjection?.promptTokens === 1060 && usageProjection?.totalTokens === 1077,
	'prompt=' + usageProjection?.promptTokens + ' total=' + usageProjection?.totalTokens]);
rmSync(usageTaskDir, { recursive: true, force: true });
rmSync(join(home, 'sessions', '--C-usage-probe--'), { recursive: true, force: true });

// 吞吐口径:必须按**真实的采样时间跨度**算,短窗口会把一整块输出算成"一秒几千"。
// 用户实测反馈就是这个症状(客户端每秒采一次 Δ输出/Δt)。
const spikeRate = rateOf({ at: 1000, output: 0 }, { outputTokens: 6000 }, 3000, [], 3000);
checks.push(['2 秒里跳 6000 token 不算速率(短窗口会得出 3000 tok/s 的疯数)', spikeRate === null,
	'rate=' + String(spikeRate)]);
const spannedRate = rateOf({ at: 1000, output: 0 }, { outputTokens: 6000 }, 30000, [], 3000);
checks.push(['跨 29 秒的 6000 token → 约 207 tok/s(这才是人话)',
	spannedRate !== null && Math.abs(spannedRate - 206.9) < 0.5, 'rate=' + String(spannedRate)]);
checks.push(['输出没长(卡住)时不给速率',
	rateOf({ at: 1000, output: 500 }, { outputTokens: 500 }, 30000, [], 3000) === null]);
const smoothed = [];
rateOf({ at: 0, output: 0 }, { outputTokens: 3000 }, 10000, smoothed, 3000);
rateOf({ at: 10000, output: 3000 }, { outputTokens: 30000 }, 20000, smoothed, 3000);
checks.push(['吞吐取最近几次采样的平均(单窗口抖动不会直接抖到界面上)', smoothed.length === 2,
	JSON.stringify(smoothed)]);

// 集成:日志在长 → 投影里真的带出 tokensPerSecond
const rateSession = 'session-observer-selftest-6666-6666-666666666666';
const rateBucket = join(home, 'sessions', '--C-rate-probe--', rateSession);
mkdirSync(rateBucket, { recursive: true });
const rateFile = join(rateBucket, 'session.jsonl.zstd');
const rateTaskId = 'observertest-000000-66666666';
const rateTaskDir = join(tasksRoot, rateTaskId);
mkdirSync(rateTaskDir, { recursive: true });
writeFileSync(join(rateTaskDir, 'task.json'), JSON.stringify({
	id: rateTaskId, status: 'running', workspace: 'D:\\rate-probe',
	startedAt: new Date().toISOString(), caller: 'rate-probe',
}, null, 2));
writeFileSync(join(rateTaskDir, 'meta.json'), JSON.stringify({ sessionId: rateSession, pid: process.pid }, null, 2));
const usageLine = (turn, output) => JSON.stringify({
	type: 'assistant/message',
	data: { turn, step: 1, usage: { inputTokens: 10, outputTokens: output, cacheReadTokens: 0, cacheWriteTokens: 0 } },
}) + '\n';
writeFileSync(rateFile, zstdCompressSync(Buffer.from(usageLine(1, 1000), 'utf8')));
const tick = Number(process.env.DSH_SUBAGENT_OBSERVER_INTERVAL ?? 2000) + 600;
await new Promise((done) => setTimeout(done, tick));
// 第二个样本:输出再涨 2000,时间跨了 ~2 秒 → 速率应当是"几百 tok/s"这一档
appendFileSync(rateFile, zstdCompressSync(Buffer.from(usageLine(2, 3000), 'utf8')));
await new Promise((done) => setTimeout(done, tick));
const rateProjection = emitted.filter((item) => item.event === 'api-session/added'
	&& item.args[0]?.sessionId === rateSession).at(-1)?.args[0]?.projections?.values?.['dsh-subagent']?.usage;
checks.push(['投影里带出了 tokensPerSecond(客户端只负责显示)',
	typeof rateProjection?.tokensPerSecond === 'number' && rateProjection.tokensPerSecond > 0,
	'tps=' + String(rateProjection?.tokensPerSecond) + ' output=' + String(rateProjection?.outputTokens)]);
checks.push(['速率在合理量级(几百 tok/s 一档,不是几千)',
	typeof rateProjection?.tokensPerSecond === 'number' && rateProjection.tokensPerSecond < 2000,
	'tps=' + String(rateProjection?.tokensPerSecond)]);
rmSync(rateTaskDir, { recursive: true, force: true });
rmSync(join(home, 'sessions', '--C-rate-probe--'), { recursive: true, force: true });

// DSH 0.1.5 起会话日志改名成 session.v3.jsonl.zstd(实测改名时刻与本机升级时刻一致)。
// 只认旧名会让观察器**找不到日志却不报错**,卡片上的用量对新会话静默变空 —— 这条锁死它。
const v3Session = 'session-observer-selftest-7777-7777-777777777777';
const v3Bucket = join(home, 'sessions', '--C-v3-probe--', v3Session);
mkdirSync(v3Bucket, { recursive: true });
writeFileSync(join(v3Bucket, 'session.v3.jsonl.zstd'), zstdCompressSync(Buffer.from(usageLine(1, 4321), 'utf8')));
const v3TaskId = 'observertest-000000-77777777';
const v3TaskDir = join(tasksRoot, v3TaskId);
mkdirSync(v3TaskDir, { recursive: true });
writeFileSync(join(v3TaskDir, 'task.json'), JSON.stringify({
	id: v3TaskId,
	status: 'running',
	workspace: 'D:\\v3-probe',
	startedAt: new Date().toISOString(),
	caller: 'v3-probe',
}, null, 2));
writeFileSync(join(v3TaskDir, 'meta.json'), JSON.stringify({ sessionId: v3Session, pid: process.pid }, null, 2));
await new Promise((done) => setTimeout(done, tick));
const v3Projection = emitted.filter((item) => item.event === 'api-session/added'
	&& item.args[0]?.sessionId === v3Session).at(-1)?.args[0]?.projections?.values?.['dsh-subagent']?.usage;
checks.push(['新日志名(session.v3.jsonl.zstd)也能折叠出用量(否则卡片用量静默变空)',
	v3Projection?.outputTokens === 4321, 'output=' + String(v3Projection?.outputTokens)]);
rmSync(v3TaskDir, { recursive: true, force: true });
rmSync(join(home, 'sessions', '--C-v3-probe--'), { recursive: true, force: true });

// 只读预览的会话转录:卡片要能看见"它在对话里说了什么",而运行中的外部会话不能点开
// (点开 = 宿主接管写权、写坏子进程正在写的日志)。这里锁死折叠口径与封顶。
const transcriptEvents = [
	{ type: 'user/message', data: { content: [{ type: 'text', text: '把分页修好' }] } },
	{
		type: 'assistant/message',
		data: {
			turn: 1,
			step: 1,
			message: {
				role: 'assistant',
				content: [{ type: 'reasoning', text: '内部推理不该出现在预览里' }, { type: 'text', text: '先看代码' }],
			},
		},
	},
	{ type: 'tool/call', data: { callId: 'c1', name: 'bash', arguments: JSON.stringify({ command: 'npm test', description: '跑测试' }) } },
	{
		type: 'tool/result',
		data: {
			message: {
				content: [{
					type: 'tool-result', toolCallId: 'c1', isError: false,
					content: [{ type: 'text', text: '通过\n2 个用例' }],
				}],
			},
		},
	},
	// 空返回:沙箱把命令吞掉时就是这样(命令从未执行却报成功),预览里必须看得见。
	{ type: 'tool/result', data: { message: { content: [{ type: 'tool-result', toolCallId: 'c2', isError: false, content: [] }] } } },
	{
		type: 'tool/result',
		data: {
			message: {
				content: [{
					type: 'tool-result', toolCallId: 'c3', isError: true,
					content: [{ type: 'text', text: '权限不足' }],
				}],
			},
		},
	},
];
const folded = foldTranscript(`${transcriptEvents.map((event) => JSON.stringify(event)).join('\n')}\n`);
checks.push(['转录按"用户 / 助手 / 调用 / 返回"顺序折叠',
	folded.map((entry) => entry.role).join(',') === 'user,assistant,call,result,result,result',
	folded.map((entry) => entry.role).join(',')]);
checks.push(['推理块(reasoning)不进预览(长且刷屏)',
	folded.every((entry) => !entry.text.includes('内部推理')),
	JSON.stringify(folded.map((entry) => entry.text))]);
checks.push(['工具调用显示成 名字(命令),不是一坨 JSON',
	folded[2]?.text === 'bash(npm test)', String(folded[2]?.text)]);
checks.push(['工具返回折成单行', folded[3]?.text === '通过 2 个用例', String(folded[3]?.text)]);
checks.push(['空返回标成 (空返回)(沙箱吞命令的现场)',
	folded[4]?.text === '(空返回)', String(folded[4]?.text)]);
checks.push(['失败的返回带 [错误] 前缀', folded[5]?.text === '[错误] 权限不足', String(folded[5]?.text)]);

// 封顶:投影每 2~20 秒重发一整份快照,转录不封顶就是拿十几 MB 的日志刷 GUI。
const manyShort = [];
for (let i = 0; i < 100; i += 1) {
	manyShort.push({ type: 'user/message', data: { content: [{ type: 'text', text: `短${i}` }] } });
}
const byEntries = foldTranscript(manyShort.map((event) => JSON.stringify(event)).join('\n'));
checks.push(['转录按条数封顶(最多 60 条)',
	byEntries.length === 60 && byEntries.at(-1).text === '短99',
	`${byEntries.length} 条,末条 ${String(byEntries.at(-1)?.text)}`]);

const manyLong = [];
for (let i = 0; i < 200; i += 1) {
	manyLong.push({ type: 'user/message', data: { content: [{ type: 'text', text: `第${i}条 ` + 'x'.repeat(1000) }] } });
}
const byChars = foldTranscript(manyLong.map((event) => JSON.stringify(event)).join('\n'));
const byCharsTotal = byChars.reduce((sum, entry) => sum + entry.text.length, 0);
checks.push(['转录按总字数封顶(丢的是最老的,留下的是最新的)',
	byCharsTotal <= 6000 && byChars.at(-1)?.text.startsWith('第199条'),
	`${byChars.length} 条 / ${byCharsTotal} 字,末条 ${String(byChars.at(-1)?.text).slice(0, 12)}`]);

// 集成:转录真的进了投影(客户端只负责渲染 role + text)。
const textSession = 'session-observer-selftest-8888-8888-888888888888';
const textBucket = join(home, 'sessions', '--C-text-probe--', textSession);
mkdirSync(textBucket, { recursive: true });
writeFileSync(join(textBucket, 'session.jsonl.zstd'),
	zstdCompressSync(Buffer.from(`${transcriptEvents.map((event) => JSON.stringify(event)).join('\n')}\n`, 'utf8')));
const textTaskId = 'observertest-000000-88888888';
const textTaskDir = join(tasksRoot, textTaskId);
mkdirSync(textTaskDir, { recursive: true });
writeFileSync(join(textTaskDir, 'task.json'), JSON.stringify({
	id: textTaskId,
	status: 'running',
	workspace: 'D:\\text-probe',
	startedAt: new Date().toISOString(),
	caller: 'text-probe',
}, null, 2));
writeFileSync(join(textTaskDir, 'meta.json'), JSON.stringify({ sessionId: textSession, pid: process.pid }, null, 2));
await new Promise((done) => setTimeout(done, tick));
const textProjection = emitted.filter((item) => item.event === 'api-session/added'
	&& item.args[0]?.sessionId === textSession).at(-1)?.args[0]?.projections?.values?.['dsh-subagent']?.transcript;
checks.push(['投影里带出了只读转录(预览窗据此渲染)',
	Array.isArray(textProjection) && textProjection.length === 6 && textProjection[0]?.role === 'user',
	`${Array.isArray(textProjection) ? textProjection.length : 'X'} 条`]);
checks.push(['转录条目只有 role/text 两个字段(外部数据不进 DOM)',
	(Array.isArray(textProjection) ? textProjection : []).every((entry) => Object.keys(entry).length === 2),
	JSON.stringify((Array.isArray(textProjection) ? textProjection : []).map((entry) => Object.keys(entry)))]);
rmSync(textTaskDir, { recursive: true, force: true });
rmSync(join(home, 'sessions', '--C-text-probe--'), { recursive: true, force: true });

checks.push(['自检跑在隔离的 DSH_HOME 里(绝不往真 HOME 写心跳)',
	isolatedHome.includes('dsh-observer-selftest-')
	&& heartbeatPath.startsWith(isolatedHome)
	&& !heartbeatPath.startsWith(defaultHome)]);

// 心跳里带**口径版本**:靠它当场分辨宿主里跑的是哪一版观察器
// (实测:file: 插件在这个桌面宿主里不会热重载,改完必须重启才生效 —— 看这个字段就知道)。
const heartbeatPayload = JSON.parse(readFileSync(heartbeatPath, 'utf8'));
checks.push(['心跳带 usageRate 口径版本(用于分辨宿主里跑的是哪一版)',
	heartbeatPayload.usageRate?.minSpanMs === 150 && heartbeatPayload.usageRate?.foldThrottleMs === 150,
	JSON.stringify(heartbeatPayload.usageRate)]);
// 预览窗口的转录也靠心跳认版本:**没有 transcriptCaps = 宿主里那版观察器还没有转录**,
// 刷新页面也没用(得重启宿主)。这条断言保证这个标记真的会被写出来。
checks.push(['心跳带 transcriptCaps(没有它 = 跑着的观察器还没有只读转录)',
	heartbeatPayload.transcriptCaps?.entries === 60 && heartbeatPayload.transcriptCaps?.chars === 6000
	&& heartbeatPayload.transcriptCaps?.entryChars === 600,
	JSON.stringify(heartbeatPayload.transcriptCaps)]);

let failed = 0;
for (const [label, ok] of checks) {
	if (!ok) failed += 1;
	console.log(`${ok ? '✅' : '❌'} ${label}`);
}
console.log(`\n事件总数 ${emitted.length}:${[...new Set(emitted.map((item) => item.event))].join(', ')}`);
if (existsSync(logPath)) console.log('observer.log:\n' + readFileSync(logPath, 'utf8').trim());
rmSync(isolatedHome, { recursive: true, force: true });
process.exit(failed === 0 ? 0 : 1);
void utimesSync;
