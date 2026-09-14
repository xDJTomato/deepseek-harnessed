/**
 * 会话日志读写助手(DSH 各版本的文件名不一样,这里统一).
 *
 * 背景:DSH 0.1.5 起会话日志从 `session.jsonl.zstd` 改名为 `session.v3.jsonl.zstd`
 * (实测改名时刻与本机升级时刻一致)。原先各处硬编码旧名,**找不到文件时安静返回 null**,
 * 于是监控卡片的 token 用量对新会话全成了空 —— 一个不报错的静默回归。
 * 这里统一按 `session*.jsonl.zstd` 去找,并优先取**最大**的那个(真正的日志最大,
 * 不依赖 mtime:本机 mtime 不可靠)。
 *
 * 另外提供"空心成功"检测:DSH 的 Windows 沙箱档下,shell 工具的返回体是
 * `"\r\n"` 且 `isError:false` —— 命令从未执行,工具却报成功。桥接层据此给调用方加告警。
 *
 * @module dsh-subagent/lib/session-log
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';
import { dshHome } from './util.mjs';

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const LOG_NAME = /^session.*\.jsonl\.zstd$/i;

/** 某个会话目录里所有候选日志,按字节数从大到小。 */
function logsIn(sessionDir) {
	if (!existsSync(sessionDir)) return [];
	const out = [];
	let entries;
	try {
		entries = readdirSync(sessionDir);
	} catch {
		return [];
	}
	for (const name of entries) {
		if (!LOG_NAME.test(name)) continue;
		const path = join(sessionDir, name);
		try {
			const stat = statSync(path);
			if (stat.isFile() && stat.size > 0) out.push({ path, size: stat.size });
		} catch {
			/* 读不到就当没有 */
		}
	}
	return out.sort((a, b) => b.size - a.size);
}

/**
 * 找某个会话的日志文件。
 * 直接扫所有工作区桶(几十个 readdir,开销可忽略),避免依赖本模块之外的路径编码逻辑。
 * @param sessionId - 会话 id(`session-…`)。
 * @returns 日志文件绝对路径,或 null(找不到/为空)。
 */
export function findSessionLog(sessionId) {
	if (typeof sessionId !== 'string' || sessionId === '') return null;
	const root = join(dshHome(), 'sessions');
	let buckets;
	try {
		buckets = readdirSync(root);
	} catch {
		return null;
	}
	for (const bucket of buckets) {
		const hits = logsIn(join(root, bucket, sessionId));
		if (hits.length > 0) return hits[0].path;
	}
	return null;
}

/**
 * 解码会话日志。DSH 是追加写,一个文件里有**多帧** zstd:
 * ⚠️ 必须逐帧解 —— `zstdDecompressSync(整个文件)` 只解第一帧就返回,而且不报错。
 * @param file - 日志文件路径。
 * @returns 解出的 JSONL 文本(失败返回空串)。
 */
export function decodeSessionLog(file) {
	let raw;
	try {
		raw = readFileSync(file);
	} catch {
		return '';
	}
	const starts = [];
	let index = raw.indexOf(ZSTD_MAGIC, 0);
	while (index >= 0) {
		starts.push(index);
		index = raw.indexOf(ZSTD_MAGIC, index + 4);
	}
	const parts = [];
	for (let cursor = 0; cursor < starts.length; cursor += 1) {
		const from = starts[cursor];
		const to = cursor + 1 < starts.length ? starts[cursor + 1] : raw.length;
		try {
			parts.push(zstdDecompressSync(raw.subarray(from, to)).toString('utf8'));
		} catch {
			/* 半截帧(正在写)忽略 */
		}
	}
	if (parts.length === 0 && raw.length > 0) {
		try {
			parts.push(zstdDecompressSync(raw).toString('utf8'));
		} catch {
			return '';
		}
	}
	return parts.join('');
}

/** 把 JSONL 文本解析成事件数组(坏行忽略)。 */
export function parseSessionLog(text) {
	const events = [];
	for (const line of text.split('\n')) {
		if (line.trim() === '') continue;
		try {
			events.push(JSON.parse(line));
		} catch {
			/* 坏行忽略 */
		}
	}
	return events;
}

/** 工具返回体里的文本(空/纯空白都算"没有输出")。 */
function resultText(event) {
	const message = event?.data?.message ?? {};
	const block = message.content?.[0] ?? {};
	if (block.type !== 'tool-result') return null;
	const text = (block.content ?? []).map((part) => (typeof part.text === 'string' ? part.text : '')).join('');
	return { text, isError: block.isError === true, callId: block.toolCallId ?? message.source?.callId ?? null };
}

/**
 * 找出"被沙箱吞掉的 shell 调用":命令类工具的返回是**空的且 isError:false**。
 *
 * 这是 DSH 在 Windows 沙箱档(workspace-write / read-only)下的真实行为(本机必现,
 * 升级前后一致):命令根本没被拉起来,却报告成功。调用方拿到的是"完成但什么都没做",
 * 极易被当成模型偷懒 —— 桥接层必须把这件事说出来。
 * @param events - parseSessionLog() 的结果。
 * @returns {{count:number, samples:Array<{name:string,command:string}>}}
 */
export function detectHollowShellCalls(events) {
	const names = new Map();
	for (const event of events) {
		if (event?.type !== 'tool/call') continue;
		const data = event.data ?? {};
		if (typeof data.callId === 'string') names.set(data.callId, { name: String(data.name ?? ''), args: String(data.arguments ?? '') });
	}
	const samples = [];
	let count = 0;
	for (const event of events) {
		if (event?.type !== 'tool/result') continue;
		const result = resultText(event);
		if (result === null || result.isError) continue;
		if (result.text.trim() !== '') continue;
		const call = names.get(result.callId) ?? { name: '', args: '' };
		if (!/pwsh|bash|shell/i.test(call.name)) continue;
		count += 1;
		if (samples.length < 3) {
			let command = '';
			try {
				command = String(JSON.parse(call.args).command ?? '');
			} catch {
				command = call.args.slice(0, 120);
			}
			samples.push({ name: call.name, command: command.slice(0, 160) });
		}
	}
	return { count, samples };
}

/** 给调用方看的那段告警(附在任务答复末尾)。 */
export function hollowShellWarning(count, samples, permission) {
	const lines = [
		'',
		'---',
		`⚠️ 执行面告警:本次会话有 ${count} 次 shell 调用**没有真正执行**。`,
		`   证据:这些调用返回的是空内容且 isError=false(沙箱档把命令吞掉了,进程从未启动)。`,
		`   当前权限档:${permission || '未知'};本机实测 danger-full-access 下 shell 正常,`,
		'   workspace-write / read-only 下必然空转(DSH 侧问题,升级前后一致)。',
	];
	if (samples.length > 0) {
		lines.push('   样例:');
		for (const sample of samples) lines.push(`     · [${sample.name}] ${sample.command}`);
	}
	lines.push('   要跑命令请让调用方改用 permission="danger-full-access";只做文件读写的任务不受影响。');
	return lines.join('\n');
}
