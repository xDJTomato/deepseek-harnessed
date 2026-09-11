/**
 * 任务现场实时探针:判断"外部 subagent 任务到底是在推进,还是真的卡住了"。
 *
 * 为什么需要它:**文件的 mtime 不可靠**(部分环境里安全软件的文件过滤会让它停在创建
 * 那一刻 —— 实测某个 stderr.log 一路涨到 18KB 而 mtime 没变),所以判断"有没有进展"
 * 只能看**字节数变化**。
 *
 * 用法:
 *   node test/live-probe.mjs                # 探最新一个任务
 *   node test/live-probe.mjs <job-id>       # 探指定任务
 *   node test/live-probe.mjs <job-id> 30    # 采样间隔 30 秒(默认 15)
 *
 * 输出:任务记录关键字段 + 进程存活性 + stderr/会话日志的两次字节采样与"是否在长"。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

const HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh');
const TASKS = join(HOME, 'subagent', 'state', 'tasks');
const SESSIONS = join(HOME, 'sessions');

/** projectKey 规则与 DSH 一致:[/\\:] 连续段变 '-'、非 ASCII 变 ~XXXX(大写十六进制)。 */
function projectKey(cwd) {
	const replaced = cwd.replace(/[/\\:]+/gu, '-');
	let out = '';
	for (const ch of replaced) {
		const code = ch.codePointAt(0);
		out += code > 127 ? `~${code.toString(16).toUpperCase()}` : ch;
	}
	return `--${out}--`;
}

function readJson(path) {
	try {
		return JSON.parse(readFileSync(path, 'utf8'));
	} catch {
		return undefined;
	}
}

function sizeOf(path) {
	try {
		return statSync(path).size;
	} catch {
		return -1;
	}
}

function alive(pid) {
	if (!Number.isInteger(pid) || pid <= 0) return 'unknown';
	try {
		process.kill(pid, 0);
		return 'alive';
	} catch (error) {
		return error?.code === 'EPERM' ? 'alive(EPERM)' : 'dead';
	}
}

const argv = process.argv.slice(2);
const explicit = argv.find((arg) => /^\d{8}-\d{6}-[0-9a-f]{8}$/u.test(arg));
const interval = Number(argv.find((arg) => /^\d+$/u.test(arg)) ?? 15) * 1000;
const jobId = explicit ?? readdirSync(TASKS)
	.filter((name) => /^\d{8}-\d{6}-[0-9a-f]{8}$/u.test(name))
	.sort()
	.at(-1);
if (jobId === undefined) {
	process.stdout.write('没有找到任何任务\n');
	process.exit(1);
}

const dir = join(TASKS, jobId);
const task = readJson(join(dir, 'task.json')) ?? {};
const meta = readJson(join(dir, 'meta.json')) ?? {};
const sessionId = (typeof task.sessionId === 'string' && task.sessionId !== '' ? task.sessionId : undefined)
	?? (typeof meta.sessionId === 'string' ? meta.sessionId : undefined);
const sessionLog = sessionId === undefined ? undefined
	: join(SESSIONS, projectKey(String(task.workspace ?? process.cwd())), sessionId, 'session.jsonl.zstd');

process.stdout.write(`任务 ${jobId}\n`);
process.stdout.write(`  status=${String(task.status)} caller=${String(task.caller ?? '-')} label=${String(task.label ?? '-')}\n`);
process.stdout.write(`  workspace=${String(task.workspace ?? '-')}\n`);
process.stdout.write(`  startedAt=${String(task.startedAt ?? '-')} finishedAt=${String(task.finishedAt ?? '-')} durationMs=${String(task.durationMs ?? '-')}\n`);
process.stdout.write(`  expectedSeconds=${String(task.expectedSeconds ?? '-')} deadlineAt=${String(task.deadlineAt ?? '-')}\n`);
process.stdout.write(`  pid=${String(task.pid ?? meta.pid ?? '-')} (${alive(Number(task.pid ?? meta.pid))}) sessionId=${String(sessionId ?? '-')}\n`);
if (sessionLog !== undefined) {
	process.stdout.write(`  会话日志=${sessionLog}\n`);
	process.stdout.write(`  会话目录存在=${existsSync(join(SESSIONS, projectKey(String(task.workspace ?? process.cwd())), sessionId)) ? '是' : '否'}\n`);
}

const targets = [
	['stderr.log', join(dir, 'stderr.log')],
	['stdout.log', join(dir, 'stdout.log')],
	['result.txt', join(dir, 'result.txt')],
	...(sessionLog === undefined ? [] : [['session.jsonl.zstd', sessionLog]]),
];
const first = targets.map(([name, path]) => [name, sizeOf(path)]);
process.stdout.write(`\n第 1 次采样 ${new Date().toISOString()}\n`);
for (const [name, size] of first) process.stdout.write(`  ${name.padEnd(20)} ${size} B\n`);

process.stdout.write(`\n等 ${interval / 1000}s 后再采样一次 …\n`);
await new Promise((done) => setTimeout(done, interval));

process.stdout.write(`第 2 次采样 ${new Date().toISOString()}\n`);
let growing = 0;
for (const [name, path] of targets) {
	const before = first.find(([n]) => n === name)[1];
	const after = sizeOf(path);
	const delta = after - before;
	if (delta > 0) growing += 1;
	process.stdout.write(`  ${name.padEnd(20)} ${after} B  (Δ ${delta > 0 ? '+' : ''}${delta})\n`);
}
process.stdout.write(`\n结论:${growing > 0 ? `✅ 有 ${growing} 个文件在增长 —— 任务仍在推进` : '❌ 全部无变化 —— 任务疑似卡死(没有任何输出增长)'}\n`);
