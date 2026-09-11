#!/usr/bin/env node
/**
 * 并发验证:同一个 MCP server 进程里同时发起多个 dsh_task,确认它们真的并行执行。
 *
 * 用法: node test/concurrency-probe.mjs [工作空间] [并发数]
 * 退出码: 全部成功 0;否则 1。
 *
 * @module dsh-subagent/test/concurrency-probe
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import process from 'node:process';

const MCP_ENTRY = resolve(import.meta.dirname, '..', 'bin', 'dsh-subagent-mcp.mjs');
const workspace = resolve(process.argv[2] ?? 'D:\\dsh-subagent-selftest');
const fanout = Number(process.argv[3] ?? 3);
const stamp = Date.now();

/** 极简 MCP 客户端:换行分隔 JSON-RPC,够用即可。 */
class Client {
	constructor(command, args) {
		this.child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
		this.buffer = '';
		this.pending = new Map();
		this.seq = 0;
		this.child.stdout.on('data', (chunk) => this.onData(chunk));
		this.child.stderr.on('data', () => {});
	}
	onData(chunk) {
		this.buffer += chunk.toString('utf8');
		for (;;) {
			const newline = this.buffer.indexOf('\n');
			if (newline < 0) break;
			const line = this.buffer.slice(0, newline).trim();
			this.buffer = this.buffer.slice(newline + 1);
			if (line === '') continue;
			let frame;
			try {
				frame = JSON.parse(line);
			} catch {
				continue;
			}
			const waiter = this.pending.get(frame.id);
			if (waiter === undefined) continue;
			this.pending.delete(frame.id);
			if (frame.error !== undefined) waiter.reject(new Error(JSON.stringify(frame.error)));
			else waiter.resolve(frame.result);
		}
	}
	send(frame) {
		this.child.stdin.write(`${JSON.stringify(frame)}\n`);
	}
	request(method, params = {}) {
		const id = ++this.seq;
		const promise = new Promise((resolve_, reject) => this.pending.set(id, { resolve: resolve_, reject }));
		this.send({ jsonrpc: '2.0', id, method, params });
		return promise;
	}
	notify(method, params = {}) {
		this.send({ jsonrpc: '2.0', method, params });
	}
	close() {
		this.child.kill();
	}
}

const client = new Client(process.execPath, [MCP_ENTRY]);
await client.request('initialize', {
	protocolVersion: '2025-06-18',
	capabilities: {},
	clientInfo: { name: 'concurrency-probe', version: '0.1.0' },
});
client.notify('notifications/initialized');

process.stdout.write(`并发数=${fanout} 工作空间=${workspace}\n`);
const started = Date.now();
const calls = Array.from({ length: fanout }, (_, index) => {
	const marker = `PAR${index + 1}-${stamp}`;
	const prompt = `先运行 \`node -v\` 看版本,再在当前目录新建文件 par${index + 1}.txt(内容写 ${marker}),`
		+ `然后用 read 回读确认,最后回答一行 DONE ${marker}。`;
	return {
		index,
		marker,
		file: join(workspace, `par${index + 1}.txt`),
		at: Date.now() - started,
		call: client.request('tools/call', { name: 'dsh_task', arguments: { prompt, workspace, wait_seconds: 180, expected_seconds: 600, acceptance: `par${index + 1}.txt 内容恰为 ${marker}`, label: `concurrency-${index + 1}` } }),
	};
});

const results = await Promise.all(calls.map((item) => item.call.then(
	(result) => ({ ...item, ok: result?.isError !== true, text: JSON.stringify(result).slice(0, 200), doneAt: Date.now() - started }),
	(error) => ({ ...item, ok: false, text: String(error.message).slice(0, 200), doneAt: Date.now() - started }),
)));

let failures = 0;
for (const item of results) {
	const content = existsSync(item.file) ? readFileSync(item.file, 'utf8').trim() : null;
	const ok = item.ok && content === item.marker;
	if (!ok) failures += 1;
	process.stdout.write(`${ok ? '✅' : '❌'} 任务${item.index + 1}: 发起于 +${(item.at / 1000).toFixed(1)}s,返回于 +${(item.doneAt / 1000).toFixed(1)}s,文件内容=${JSON.stringify(content)}\n`);
}
process.stdout.write(`\n总墙钟 ${((Date.now() - started) / 1000).toFixed(1)}s;${failures === 0 ? ` ${fanout} 路并发全部成功 ✅(若串行执行,总时长应约为各任务之和)` : ` 有 ${failures} 路失败 ❌`}\n`);

// 顺带验证取消:起一个长任务,立刻 dsh_task_cancel,确认状态收敛到 cancelled。
const slow = await client.request('tools/call', {
	name: 'dsh_task',
	arguments: {
		prompt: '运行 `powershell -NoProfile -Command "Start-Sleep -Seconds 120"`,命令结束后回答一行 DONE SLOW。',
		workspace,
		wait_seconds: 0,
		expected_seconds: 900,
		label: 'cancel-probe',
	},
});
const jobId = /job_id:\s*([0-9]{8}-[0-9]{6}-[0-9a-f]{8})/.exec(JSON.stringify(slow))?.[1] ?? '';
process.stdout.write(`\n取消验证:保留任务 ${jobId},等待 6s 后取消…\n`);
await new Promise((done) => setTimeout(done, 6000));
const cancelResult = jobId === '' ? null : await client.request('tools/call', { name: 'dsh_task_cancel', arguments: { job_id: jobId } });
process.stdout.write(`取消返回: ${JSON.stringify(cancelResult).slice(0, 160)}\n`);
let status = '';
for (let round = 0; round < 10; round += 1) {
	await new Promise((done) => setTimeout(done, 2000));
	const state = await client.request('tools/call', { name: 'dsh_task_status', arguments: { job_id: jobId, wait_seconds: 5 } });
	status = /status:\s*([a-z]+)/.exec(JSON.stringify(state))?.[1] ?? '';
	if (status !== '' && status !== 'running') break;
}
const cancelOk = status === 'cancelled';
if (!cancelOk) failures += 1;
process.stdout.write(`${cancelOk ? '✅' : '❌'} 取消后状态 = ${status || '(未知)'}\n`);
client.close();
process.exitCode = failures === 0 ? 0 : 1;
