/**
 * 叶子闸门探针:证明"由外部经 dsh_task 调进来的任务不允许再分叉"。
 *
 * 两路证据:
 *   1. 配置级:`dsh --profile subagent --dump-config` 里那些"能造出更多 agent"的行必须是
 *      disabled(subagent / subagent_fork / workflow / ralph / 子代理控制通道)。
 *   2. 会话级:解出某个子代理会话的 jsonl.zstd,看它**实际拿到的工具表**里有没有 subagent /
 *      subagent_fork / workflow / ralph —— 配置关掉了 ≠ 工具真的不在,这一步是现场验证。
 *
 * 用法:
 *   node test/leaf-only-probe.mjs                    # 只跑配置级检查
 *   node test/leaf-only-probe.mjs <sessionId片段>     # 配置级 + 该会话的工具表
 *   node test/leaf-only-probe.mjs --newest           # 配置级 + 最近一个有 task 记录的会话
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import zlib from 'node:zlib';

const HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh');

/** 闸门:这些行必须 disabled。 */
const GATE_ROWS = [
	'tool-subagent',
	'tool-subagent-fork',
	'tool-workflow',
	'workflow-worker-thread',
	'tool-ralph',
	'tool-subagent-control',
	'tool-subagent-list-agents',
];
/**
 * 这些行**不能**被误关(关掉会把正常干活的能力也砍了)。
 *
 * 版本注记:0.1.4 及更早这里还有 `tool-subagent-report`;0.1.5-rc.1 起它不再是 loader 行
 * (`--dump-config` 里查不到),`subagent-report` 变成了会话协议里的一个消息 kind
 * (`case "coordinator": case "subagent-report"`)。行没了却继续断言它"没被误关",
 * 会以 `undefined` 形式误报失败 —— 这正是 DSH 升级后本探针唯一的失败项。
 */
const KEEP_ROWS = ['tool-fs', 'tool-pwsh', 'tool-bash', 'tool-goal', 'tool-todo', 'tool-web'];
/** 工具表里不该出现的名字(分叉通道)。 */
const FORK_TOOLS = ['subagent', 'subagent_fork', 'workflow', 'ralph', 'list_agents', 'send_message', 'interrupt_agent'];

const checks = [];
const check = (name, ok, detail) => checks.push([name, ok, detail]);

// ------------------------------------------------------------------ 1. 配置级

function dumpConfig() {
	const out = execFileSync('dsh', ['--profile', 'subagent', '--dump-config'], {
		encoding: 'utf8',
		shell: true,
		maxBuffer: 64 * 1024 * 1024,
	});
	return out;
}

function rowsOf(dump) {
	const rows = new Map();
	const lines = dump.split(/\r?\n/);
	for (let index = 0; index < lines.length; index += 1) {
		const match = /^-\s+id:\s*(\S+)\s*$/.exec(lines[index]);
		if (match === null) continue;
		let block = '';
		for (let cursor = index; cursor < Math.min(index + 14, lines.length); cursor += 1) {
			if (cursor > index && /^-\s+id:/.test(lines[cursor])) break;
			block += lines[cursor] + '\n';
		}
		rows.set(match[1], !/disabled:\s*true/.test(block));
	}
	return rows;
}

const dump = dumpConfig();
const rows = rowsOf(dump);
check('读到 subagent profile 的行表', rows.size > 50, 'rows=' + rows.size);
for (const id of GATE_ROWS) {
	check('闸门行已关闭: ' + id, rows.get(id) === false, rows.get(id) === undefined ? '行不存在' : String(rows.get(id)));
}
for (const id of KEEP_ROWS) {
	check('没有被误关: ' + id, rows.get(id) === true, String(rows.get(id)));
}

// ------------------------------------------------------------------ 2. 会话级:工具表

function sessionDirs() {
	const root = join(HOME, 'sessions');
	if (!existsSync(root)) return [];
	const out = [];
	for (const bucket of readdirSync(root)) {
		const bucketDir = join(root, bucket);
		let entries = [];
		try {
			entries = readdirSync(bucketDir);
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (!entry.startsWith('session-')) continue;
			// 文件名随 DSH 版本变过(0.1.5 起是 session.v3.jsonl.zstd):
			// 只认旧名会让这个探针在升级后**静默空转**,所以按 session*.jsonl.zstd 找、
			// 取最大的那个,并在下面显式断言"确实找到了日志"。
			let best = null;
			let inside = [];
			try {
				inside = readdirSync(join(bucketDir, entry));
			} catch {
				continue;
			}
			for (const name of inside) {
				if (!/^session.*\.jsonl\.zstd$/i.test(name)) continue;
				const candidate = join(bucketDir, entry, name);
				try {
					const size = statSync(candidate).size;
					if (size > 0 && (best === null || size > best.size)) best = { file: candidate, size };
				} catch {
					/* 读不到就当没有 */
				}
			}
			if (best !== null) out.push({ id: entry, file: best.file });
		}
	}
	return out;
}

/** 多帧 zstd:逐个 magic 起点解,拼成一份 JSONL 文本。 */
function decodeSession(file) {
	const buffer = readFileSync(file);
	const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
	const starts = [];
	for (let index = 0; index + 4 <= buffer.length; index += 1) {
		if (buffer.compare(magic, 0, 4, index, index + 4) === 0) starts.push(index);
	}
	let text = '';
	for (let index = 0; index < starts.length; index += 1) {
		const from = starts[index];
		const to = index + 1 < starts.length ? starts[index + 1] : buffer.length;
		try {
			text += Buffer.from(zlib.zstdDecompressSync(buffer.subarray(from, to))).toString('utf8');
		} catch {
			// 帧尾截断(会话正在写)时忽略这一帧
		}
	}
	return text;
}

/** 找出工具表里出现的名字:agent-loop 把工具以 {"name":"..."} 形式发出去。 */
function toolNamesOf(text) {
	const names = new Set();
	for (const match of text.matchAll(/"name"\s*:\s*"([a-z0-9_]+)"/g)) names.add(match[1]);
	return names;
}

/** 日志是 JSONL:按 type 归类,便于看清"工具表"到底记在哪种事件里。 */
function eventTypesOf(text) {
	const counts = new Map();
	for (const line of text.split(/\r?\n/)) {
		if (line.trim() === '') continue;
		let parsed;
		try {
			parsed = JSON.parse(line);
		} catch {
			continue;
		}
		const type = typeof parsed?.type === 'string' ? parsed.type : '(无 type)';
		counts.set(type, (counts.get(type) ?? 0) + 1);
	}
	return counts;
}

/** 在解出的文本里找 `"tools"` 数组,抽出里面的工具名(请求体里的工具表)。 */
function declaredToolsOf(text) {
	const names = new Set();
	for (const match of text.matchAll(/"tools"\s*:\s*\[/g)) {
		const from = match.index + match[0].length;
		// 括号配平截出这一段数组(够用即可:工具表本身没有嵌套数组)
		let depth = 1;
		let cursor = from;
		while (cursor < text.length && depth > 0) {
			const char = text[cursor];
			if (char === '[') depth += 1;
			else if (char === ']') depth -= 1;
			cursor += 1;
		}
		const slice = text.slice(from, cursor);
		for (const name of slice.matchAll(/"name"\s*:\s*"([A-Za-z0-9_]+)"/g)) names.add(name[1]);
	}
	return names;
}

/** 读一个 JSON 文件,坏了就返回 undefined。 */
function readJsonFile(file) {
	try {
		return JSON.parse(readFileSync(file, 'utf8'));
	} catch {
		return undefined;
	}
}

/**
 * `--newest`:从**任务台账**里挑最近一个真正由外部任务跑出来的会话。
 *
 * 不能直接扫会话目录挑最新的 —— 那样会挑到宿主自己的桌面会话(它本来就有
 * `subagent`/`workflow` 这些工具),于是闸门断言会假红。台账里的任务一定跑在
 * subagent profile 上,这才是这条探针要看的对象。
 */
function newestTaskSession() {
	const dir = join(HOME, 'subagent', 'state', 'tasks');
	let best = null;
	let names = [];
	try {
		names = readdirSync(dir);
	} catch {
		return null;
	}
	for (const name of names) {
		const task = readJsonFile(join(dir, name, 'task.json'));
		const meta = readJsonFile(join(dir, name, 'meta.json'));
		const sessionId = typeof task?.sessionId === 'string' && task.sessionId !== ''
			? task.sessionId
			: typeof meta?.sessionId === 'string' ? meta.sessionId : '';
		if (sessionId === '') continue;
		const startedAt = Date.parse(String(task?.startedAt ?? ''));
		if (!Number.isFinite(startedAt)) continue;
		if (best === null || startedAt > best.startedAt) best = { sessionId, startedAt, job: name };
	}
	if (best === null) return null;
	const item = sessionDirs().find((entry) => entry.id.includes(best.sessionId));
	return item === undefined ? null : { ...item, job: best.job };
}

/** 桌面会话带着宿主自己的工具(ask_user_question / delivery_check 等),用来识别"挑错了对象"。 */
const HOST_ONLY_TOOLS = ['ask_user_question', 'delivery_check', 'phase_begin', 'tools_catalog'];

const wanted = process.argv[2];
if (wanted !== undefined && wanted !== '') {
	let target = null;
	const all = sessionDirs();
	if (wanted === '--newest') {
		target = newestTaskSession();
	} else {
		target = all.find((item) => item.id.includes(wanted)) ?? null;
	}
	check('找到目标会话日志', target !== null, wanted);
	if (target !== null) {
		const text = decodeSession(target.file);
		check('会话日志解出内容', text.length > 1000, 'bytes=' + text.length);
		const declared = declaredToolsOf(text);
		const isHostSession = HOST_ONLY_TOOLS.some((name) => declared.has(name));
		if (isHostSession) {
			console.log('  ⚠ 这个会话是**宿主自己的桌面会话**,不是外部任务(工具表里有 ' 
				+ HOST_ONLY_TOOLS.filter((name) => declared.has(name)).join('/') + ')');
			console.log('    闸门断言对它没有意义,已跳过;请用 --newest(按任务台账挑)或直接给任务会话 id。');
		}
		const names = toolNamesOf(text);
		if (!isHostSession) {
			check('会话里没有**调用**过分叉工具(' + FORK_TOOLS.join('/') + ')',
				FORK_TOOLS.every((name) => !names.has(name)),
				'命中=' + FORK_TOOLS.filter((name) => names.has(name)).join(','));
		}
		// 更硬的一条:请求体里真的发给模型的工具表。配置关掉了 ≠ 工具真的不在,
		// 这一条直接看现场下发的清单。
		if (!isHostSession) {
			check('请求体的工具表里没有分叉工具',
				declared.size > 0 && FORK_TOOLS.every((name) => !declared.has(name)),
				declared.size === 0
					? '没在日志里找到 "tools" 数组(该会话可能没记录请求体)'
					: '工具数=' + declared.size + ' 命中=' + FORK_TOOLS.filter((name) => declared.has(name)).join(','));
		}
		console.log('  · 下发给模型的工具表:' + ([...declared].sort().join(', ') || '(未记录)'));
		const types = eventTypesOf(text);
		const sample = [...names].filter((name) => /^(fs|pwsh|bash|todo|web|goal|jobs|skill|subagent|workflow|ralph)/.test(name)).sort();
		console.log('  · 这次会话里出现过的工具名(抽样):' + (sample.join(', ') || '(没抽到)'));
		if (process.env.DSH_LEAF_PROBE_TYPES === '1') {
			console.log('  · 事件类型:' + [...types].map(([type, count]) => type + '×' + count).join(', '));
		}
	}
}

// ------------------------------------------------------------------ 汇总

let failed = 0;
for (const [name, ok, detail] of checks) {
	if (!ok) failed += 1;
	console.log(`${ok ? '✅' : '❌'} ${name}${detail === undefined ? '' : '  (' + detail + ')'}`);
}
console.log(`\n${checks.length - failed}/${checks.length} 通过`);
process.exitCode = failed === 0 ? 0 : 1;
