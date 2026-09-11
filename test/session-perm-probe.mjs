/**
 * 会话权限探针:解开某个 DSH 会话日志,打印它实际生效的权限事实。
 *
 * 会话日志是 zstd 多帧 JSONL(`session.jsonl.zstd`)。权限相关的落盘事件是
 * `permission/preset` / `sandbox/mode` / `approval/policy` —— 这三个才是"真正生效"的
 * 事实来源(向导/配置里的字面量不算)。
 *
 * 用法:
 *   node test/session-perm-probe.mjs <sessionId 或 日志路径>
 *   node test/session-perm-probe.mjs --list [工作空间 key 关键字]
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import zlib from 'node:zlib';

const HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh');
const SESSIONS = join(HOME, 'sessions');
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** 把一个 zstd 多帧文件解码成完整文本。 */
function decodeFrames(path) {
	const buffer = readFileSync(path);
	const chunks = [];
	let offset = 0;
	while (offset < buffer.length) {
		const next = buffer.indexOf(MAGIC, offset + 4);
		const end = next < 0 ? buffer.length : next;
		const frame = buffer.subarray(offset, end);
		try {
			chunks.push(zlib.zstdDecompressSync(frame));
		} catch {
			// 尾部可能是撕裂的半帧,忽略。
		}
		offset = end;
	}
	return Buffer.concat(chunks).toString('utf8');
}

/** 找一个会话日志:既接受 sessionId,也接受直接给出的路径。 */
function resolveLog(target, filter) {
	if (target !== undefined && !target.startsWith('--') && target.includes('session.jsonl')) return target;
	const keys = readdirSync(SESSIONS);
	const found = [];
	for (const key of keys) {
		if (filter !== undefined && !key.includes(filter)) continue;
		const dir = join(SESSIONS, key);
		let entries = [];
		try {
			entries = readdirSync(dir);
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (target !== undefined && !entry.includes(target)) continue;
			const log = join(dir, entry, 'session.jsonl.zstd');
			try {
				found.push({ key, id: entry, log, size: statSync(log).size, at: statSync(log).mtimeMs });
			} catch {
				/* 没有日志 */
			}
		}
	}
	found.sort((a, b) => b.at - a.at);
	return found;
}

const arg = process.argv[2];
if (arg === '--list' || arg === undefined) {
	const filter = process.argv[3];
	const rows = resolveLog(undefined, filter).slice(0, 15);
	for (const row of rows) console.log(`${row.id}  ${Math.round(row.size / 1024)}KB  ${row.key}`);
	process.exit(0);
}

const target = resolveLog(arg);
if (!Array.isArray(target) || target.length === 0) {
	console.error(`找不到会话日志: ${arg}`);
	process.exit(1);
}
const picked = target[0];
const text = decodeFrames(picked.log);
const lines = text.split('\n').filter((line) => line.trim() !== '');
const events = [];
for (const line of lines) {
	try {
		events.push(JSON.parse(line));
	} catch {
		/* 跳过坏行 */
	}
}

const knobs = events.filter((event) => ['permission/preset', 'sandbox/mode', 'approval/policy', 'session/end-seed'].includes(event.type));
console.log(`会话 ${picked.id}`);
console.log(`  日志: ${picked.log}`);
console.log(`  事件总数: ${events.length}`);
console.log('  权限事实(按落盘顺序):');
for (const event of knobs) {
	const data = event.data === undefined ? '' : JSON.stringify(event.data);
	console.log(`    seq=${event.seq} ${event.type} ${data}`);
}
if (knobs.length === 0) console.log('    (没有任何权限事件 —— 说明权限从未落到这个会话上)');
const first = events[0];
console.log(`  头部 cwd: ${first?.data?.cwd ?? first?.cwd ?? '-'}`);
