/**
 * 解压并查看某个 DSH session 的事件时间线(排查子代理为什么慢)。
 * node test/dump-session.mjs <session.jsonl.zstd>
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';

const target = process.argv[2];
const file = target ?? (() => {
	const base = join(process.env.USERPROFILE, '.dsh', 'sessions', '--D-dsh-subagent-selftest--');
	const dirs = readdirSync(base)
		.map((name) => ({ name, path: join(base, name), mtime: statSync(join(base, name)).mtimeMs }))
		.sort((a, b) => b.mtime - a.mtime);
	return join(dirs[0].path, 'session.jsonl.zstd');
})();

console.log('file:', file);
const raw = zstdDecompressSync(readFileSync(file)).toString('utf8');
const lines = raw.split('\n').filter((line) => line.trim() !== '');
console.log('events:', lines.length);
let first = null;
let last = null;
const counts = new Map();
for (const line of lines) {
	let event;
	try {
		event = JSON.parse(line);
	} catch {
		continue;
	}
	const type = event.type ?? event.event?.type ?? 'unknown';
	counts.set(type, (counts.get(type) ?? 0) + 1);
	const at = event.at ?? event.time ?? event.timestamp ?? event.event?.at;
	if (at !== undefined) {
		if (first === null) first = at;
		last = at;
	}
}
console.log('first:', first, 'last:', last);
console.log('counts:');
for (const [type, count] of [...counts.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${type}: ${count}`);

// 打印带时间戳的关键事件,找出耗时集中在哪
console.log('\n--- timeline (turn/assistant/tool) ---');
for (const line of lines) {
	let event;
	try {
		event = JSON.parse(line);
	} catch {
		continue;
	}
	const type = event.type ?? event.event?.type ?? '';
	if (!/turn\/|assistant\/(message|chunk)|tool\//.test(type)) continue;
	if (/assistant\/chunk/.test(type)) continue;
	const at = event.at ?? event.time ?? event.timestamp ?? event.event?.at ?? '';
	const extra = type === 'turn/end' ? JSON.stringify(event.data?.reason ?? event.event?.data?.reason ?? '') : '';
	console.log(`${at} ${type} ${extra}`);
}
