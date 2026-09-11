/**
 * 真实任务日志 → token 用量折叠探针。
 *
 * 卡片底部状态条要显示 `tok/s | 缓存命中 % | 输入 N tok · 输出 M tok`。外部任务的
 * 会话宿主从没加载过,标准 `tokenUsage` 投影不存在,所以是**观察器**自己解会话日志
 * (复合帧 zstd)折叠出来的。这个探针拿**真实**的任务会话日志跑一遍,验证:
 *
 *   1. 真日志确实是多帧 zstd,`decodeLogFile` 能解全;
 *   2. usage 事件的形状真的是 `assistant/chunk(chunk.type=usage)` /
 *      `assistant/message(data.usage)` —— 合成用例里我假设的形状对不对;
 *   3. 折出来的数(输入/输出/缓存读/命中率)是不是人话。
 *
 * 只读,不写任何东西;不加载宿主。
 *
 * 用法:
 *   node test/usage-fold-probe.mjs            # 最近一个有会话日志的任务
 *   node test/usage-fold-probe.mjs <jobId>    # 指定任务
 *   node test/usage-fold-probe.mjs --all      # 最近 10 个任务都给一行
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { decodeLogFile, foldUsage } from '../monitor/observer.mjs';

const home = process.env.DSH_HOME ?? join(homedir(), '.dsh');
const tasksRoot = join(home, 'subagent', 'state', 'tasks');
const sessionsRoot = join(home, 'sessions');

const arg = process.argv[2] ?? '';
const all = arg === '--all';

/** 任务目录 → { jobId, sessionId }。 */
function readTask(jobId) {
	const dir = join(tasksRoot, jobId);
	const metaPath = join(dir, 'meta.json');
	const taskPath = join(dir, 'task.json');
	const read = (path) => {
		try {
			return JSON.parse(readFileSync(path, 'utf8'));
		} catch {
			return null;
		}
	};
	const meta = read(metaPath);
	const task = read(taskPath);
	const sessionId = typeof meta?.sessionId === 'string' ? meta.sessionId : null;
	if (sessionId === null) return null;
	return { jobId, sessionId, task };
}

/** sessionId → 会话日志路径(与观察器同一条规则)。 */
function logPathOf(sessionId) {
	try {
		for (const bucket of readdirSync(sessionsRoot)) {
			const candidate = join(sessionsRoot, bucket, sessionId, 'session.jsonl.zstd');
			if (existsSync(candidate)) return candidate;
		}
	} catch {
		/* 会话仓库不存在 */
	}
	return null;
}

/** 数一数日志里带 usage 的事件类型(形状证据)。 */
function surveyUsageEvents(text) {
	const shapes = new Map();
	const frameCount = { value: 0 };
	for (const line of text.split('\n')) {
		if (line === '') continue;
		let event;
		try {
			event = JSON.parse(line);
		} catch {
			continue;
		}
		const type = event?.type;
		if (type === 'assistant/chunk' && event.data?.chunk?.type === 'usage') {
			shapes.set('assistant/chunk(chunk.type=usage)', (shapes.get('assistant/chunk(chunk.type=usage)') ?? 0) + 1);
		} else if (type === 'assistant/message' && event.data?.usage !== undefined) {
			shapes.set('assistant/message(data.usage)', (shapes.get('assistant/message(data.usage)') ?? 0) + 1);
		} else if (type === 'llm/retry-started') {
			shapes.set('llm/retry-started', (shapes.get('llm/retry-started') ?? 0) + 1);
		}
	}
	frameCount.value = 0;
	return shapes;
}

/** 复合帧计数:真实日志是多帧的,顺便确认 decode 是真的在逐帧解。 */
function countFrames(file) {
	const raw = readFileSync(file);
	const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
	let count = 0;
	let index = raw.indexOf(magic, 0);
	while (index >= 0) {
		count += 1;
		index = raw.indexOf(magic, index + 4);
	}
	return count;
}

const jobIds = all
	? readdirSync(tasksRoot)
		.map((jobId) => ({ jobId, at: statSync(join(tasksRoot, jobId)).mtimeMs }))
		.sort((a, b) => b.at - a.at)
		.slice(0, 10)
		.map((item) => item.jobId)
	: [arg !== '' ? arg : readdirSync(tasksRoot)
		.map((jobId) => ({ jobId, at: statSync(join(tasksRoot, jobId)).mtimeMs }))
		.sort((a, b) => b.at - a.at)
		.map((item) => item.jobId)
		.find((jobId) => readTask(jobId) !== null)];

let failures = 0;
let skipped = 0;
for (const jobId of jobIds) {
	const info = readTask(jobId);
	if (info === null) {
		// 没有 meta.json/sessionId 的任务记录(幽灵/半成品)不算折叠失败 ——
		// 观察器自己也不认它们(见 live-audit 的分类)。
		console.log(`— ${jobId}:没有 meta.json / sessionId(跳过)`);
		skipped += 1;
		continue;
	}
	const file = logPathOf(info.sessionId);
	if (file === null) {
		console.log(`✗ ${jobId}:找不到会话日志 ${info.sessionId}`);
		failures += 1;
		continue;
	}
	const frames = countFrames(file);
	const text = decodeLogFile(file);
	const usage = foldUsage(text);
	const shapes = [...surveyUsageEvents(text)].map(([key, value]) => key + '×' + value).join(' · ') || '(没有 usage 事件)';
	const lines = text.split('\n').filter((line) => line !== '').length;
	const ratio = usage === null ? null : usage.promptTokens > 0
		? Math.round((usage.cacheReadTokens / usage.promptTokens) * 1000) / 10
		: null;
	console.log('');
	console.log(`${jobId}  (${info.sessionId})`);
	console.log(`  日志 ${file.replace(home + '\\', '')}`);
	console.log(`  ${frames} 帧 zstd / 解出 ${lines} 行 / ${(statSync(file).size / 1024).toFixed(1)}K`);
	console.log(`  事件形状:${shapes}`);
	console.log(usage === null
		? '  用量:(还没有 usage 事件)'
		: `  用量:输入 ${usage.uncachedInputTokens} · 输出 ${usage.outputTokens} · 缓存读 ${usage.cacheReadTokens}`
			+ ` · 缓存写 ${usage.cacheWriteTokens} · 共 ${usage.calls} 次调用`
			+ ` · prompt ${usage.promptTokens} → 命中率 ${ratio}%`);
}

console.log('');
console.log(failures === 0
	? `✅ 折叠口径在真实日志上成立${skipped > 0 ? `(${skipped} 条没有会话的任务记录已跳过)` : ''}`
	: `❌ ${failures} 个任务读不出用量`);
process.exitCode = failures === 0 ? 0 : 1;
