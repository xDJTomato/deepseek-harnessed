/**
 * 执行面探针(离线):锁死两件已经踩过的事 ——
 *
 *   1. **会话日志改名**。DSH 0.1.5 起从 `session.jsonl.zstd` 变成 `session.v3.jsonl.zstd`。
 *      原先各处硬编码旧名、找不到就安静返回 null ⇒ 监控卡片的用量对新会话全空(静默回归)。
 *      这里在临时 DSH_HOME 里放两种文件名,断言按 `session*.jsonl.zstd` 能找到、且取最大的。
 *
 *   2. **沙箱档下 shell 空转**:命令没执行,工具却返回空内容 + `isError:false`。
 *      桥接层据此给调用方加告警(否则调用方会以为模型偷懒)。这里用合成日志验证判定规则:
 *      空 + isError:false ⇒ 命中;有输出 ⇒ 不命中;空 + isError:true ⇒ 不命中(报错是诚实的)。
 *
 * 用法:
 *   node test/exec-surface-probe.mjs
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';

let total = 0;
let passed = 0;
function check(name, ok, detail = '') {
	total += 1;
	if (ok) passed += 1;
	console.log(`${ok ? '✅' : '❌'} ${name}${detail === '' ? '' : `  (${detail})`}`);
}

// ── 准备一个临时 DSH_HOME,免得碰真实会话目录 ─────────────────────────────
const fakeHome = mkdtempSync(join(tmpdir(), 'dsh-exec-probe-'));
process.env.DSH_HOME = fakeHome;

const bucket = join(fakeHome, 'sessions', '--D-work-demo--');
const sessionA = 'session-aaaaaaaa-1111-2222-3333-444444444444';
const sessionB = 'session-bbbbbbbb-1111-2222-3333-444444444444';
mkdirSync(join(bucket, sessionA), { recursive: true });
mkdirSync(join(bucket, sessionB), { recursive: true });

/** 造一份"多帧 zstd"的会话日志(DSH 是追加写,一个文件里有多帧)。 */
function writeLog(sessionId, fileName, texts) {
	const buffer = Buffer.concat(texts.map((text) => zstdCompressSync(Buffer.from(text, 'utf8'))));
	writeFileSync(join(bucket, sessionId, fileName), buffer);
}

// A:只有新名字(0.1.5 的真实情况),内容更大
writeLog(sessionA, 'session.v3.jsonl.zstd', [
	`${JSON.stringify({ type: 'session', version: 3, id: sessionA })}\n`,
	`${JSON.stringify({ type: 'tool/call', data: { callId: 'c1', name: 'pwsh', arguments: '{"command":"echo hi"}' } })}\n`,
	`${JSON.stringify({ type: 'tool/result', data: { message: { source: { callId: 'c1' }, content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: '\r\n' }], isError: false }] } } })}\n`,
	`${JSON.stringify({ type: 'tool/call', data: { callId: 'c2', name: 'pwsh', arguments: '{"command":"echo ok"}' } })}\n`,
	`${JSON.stringify({ type: 'tool/result', data: { message: { source: { callId: 'c2' }, content: [{ type: 'tool-result', toolCallId: 'c2', content: [{ type: 'text', text: 'ok\r\n' }], isError: false }] } } })}\n`,
	`${JSON.stringify({ type: 'tool/call', data: { callId: 'c3', name: 'pwsh', arguments: '{"command":"boom"}' } })}\n`,
	`${JSON.stringify({ type: 'tool/result', data: { message: { source: { callId: 'c3' }, content: [{ type: 'tool-result', toolCallId: 'c3', content: [{ type: 'text', text: '' }], isError: true }] } } })}\n`,
]);
// B:只有旧名字,内容更小
writeLog(sessionB, 'session.jsonl.zstd', [`${JSON.stringify({ type: 'session', version: 1, id: sessionB })}\n`]);

// 老名字 + 新名字同时存在(真实升级现场会这样),新名字更大 ⇒ 必须选新名字
mkdirSync(join(bucket, sessionB), { recursive: true });
writeFileSync(join(bucket, sessionB, 'session.v3.jsonl.zstd'), zstdCompressSync(Buffer.from(
	`${JSON.stringify({ type: 'session', version: 3, id: sessionB })}\n${JSON.stringify({ type: 'x', data: { pad: 'y'.repeat(400) } })}\n`,
	'utf8',
)));

const { findSessionLog, decodeSessionLog, parseSessionLog, detectHollowShellCalls } = await import('../lib/session-log.mjs');

// ── 1. 文件名兼容 ─────────────────────────────────────────────────────────
const logA = findSessionLog(sessionA);
check('找到 0.1.5 的新文件名(session.v3.jsonl.zstd)', logA !== null && logA.endsWith('session.v3.jsonl.zstd'), String(logA));

const logB = findSessionLog(sessionB);
check('新旧名字同时存在时取更大的那个(即新格式)', logB !== null && logB.endsWith('session.v3.jsonl.zstd'), String(logB));

check('找不到的会话返回 null', findSessionLog('session-ffffffff-0000-0000-0000-000000000000') === null);

// ── 2. 多帧解码 + 空心成功判定 ────────────────────────────────────────────
const text = decodeSessionLog(logA);
check('多帧 zstd 全部解出(不是只解第一帧)', text.includes('c1') && text.includes('c2') && text.includes('c3'), `${text.length} 字符`);

const verdict = detectHollowShellCalls(parseSessionLog(text));
check('空心成功被判定出来(空内容 + isError:false)', verdict.count === 1, `count=${verdict.count}`);
check('有真实输出的调用不算空心', verdict.samples.every((sample) => sample.command !== 'echo ok'));
check('报错的调用不算空心(isError:true 是诚实的)', verdict.samples.every((sample) => sample.command !== 'boom'));
check('样例带上了命令原文', verdict.samples[0]?.command === 'echo hi', JSON.stringify(verdict.samples[0] ?? {}));

// ── 3. 干净日志不能误报 ──────────────────────────────────────────────────
const healthy = parseSessionLog(`${JSON.stringify({ type: 'tool/call', data: { callId: 'h1', name: 'pwsh', arguments: '{"command":"echo ok"}' } })}\n${JSON.stringify({ type: 'tool/result', data: { message: { source: { callId: 'h1' }, content: [{ type: 'tool-result', toolCallId: 'h1', content: [{ type: 'text', text: 'ok\r\n' }], isError: false }] } } })}\n`);
check('正常会话零误报', detectHollowShellCalls(healthy).count === 0);

// ── 4. 告警文案(调用方看到的那段)──────────────────────────────────────
const { hollowShellWarning } = await import('../lib/session-log.mjs');
const warning = hollowShellWarning(3, [{ name: 'pwsh', command: 'echo hi' }], 'workspace-write');
check('告警里说清"没真正执行"', warning.includes('没有真正执行'), warning.split('\n')[2] ?? '');
check('告警里给出可操作的出路(danger-full-access)', warning.includes('danger-full-access'));

rmSync(fakeHome, { recursive: true, force: true });
console.log(`\n${passed}/${total} 通过`);
process.exit(passed === total ? 0 : 1);
