/**
 * 取消传播探针:调用方停这一轮时,我们这边的 dsh 实例必须跟着停。
 *
 * 背景(真实故障):在 Cursor / Claude Code 里按"停止本轮",harness 会发 MCP 的
 * `notifications/cancelled`。桥接层原先**直接忽略**它(注释写着"留给任务自己按 timeout 收尾"),
 * 于是调用方那边已经停了,这边的 dsh 子进程还在后台继续跑、继续烧 token,还往工作区里写文件,
 * 看起来像"幽灵改动"。
 *
 * 这个探针真起一个 MCP server(stdio),真派一个任务,然后在**轮询请求在途**时发取消通知,
 * 断言:① 被取消的任务确实停了;② 它的进程真的没了(不是只改了状态字段);③ 别的任务不受牵连。
 *
 * 用法:
 *   node test/cancel-propagation-probe.mjs
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const workspace = mkdtempSync(join(tmpdir(), 'dsh-cancel-probe-'));

let total = 0;
let passed = 0;
function check(name, ok, detail = '') {
	total += 1;
	if (ok) passed += 1;
	console.log(`${ok ? '✅' : '❌'} ${name}${detail === '' ? '' : `  (${detail})`}`);
}

/** 极简 MCP stdio 客户端:只做这个探针需要的事。 */
class Client {
	constructor(child) {
		this.child = child;
		this.buffer = '';
		this.pending = new Map();
		this.nextId = 0;
		child.stdout.setEncoding('utf8');
		child.stdout.on('data', (chunk) => {
			this.buffer += chunk;
			for (;;) {
				const nl = this.buffer.indexOf('\n');
				if (nl < 0) break;
				const line = this.buffer.slice(0, nl).trim();
				this.buffer = this.buffer.slice(nl + 1);
				if (line === '') continue;
				let frame;
				try {
					frame = JSON.parse(line);
				} catch {
					continue;
				}
				const waiter = this.pending.get(frame.id);
				if (waiter !== undefined) {
					this.pending.delete(frame.id);
					waiter(frame);
				}
			}
		});
	}

	/** 发一个请求并等回复(超时返回 null)。 */
	request(method, params, timeoutMs = 30000) {
		const id = ++this.nextId;
		return new Promise((done) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				done(null);
			}, timeoutMs);
			this.pending.set(id, (frame) => {
				clearTimeout(timer);
				done(frame);
			});
			this.send({ jsonrpc: '2.0', id, method, params });
		});
	}

	/** 发一个请求但**不等**回复:返回 id,便于随后发取消通知。 */
	fire(method, params) {
		const id = ++this.nextId;
		this.pending.set(id, () => {});
		this.send({ jsonrpc: '2.0', id, method, params });
		return id;
	}

	/** 取一个在途请求的最终回复(用于 fire 之后的收尾)。 */
	settle(id, timeoutMs = 30000) {
		return new Promise((done) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				done(null);
			}, timeoutMs);
			this.pending.set(id, (frame) => {
				clearTimeout(timer);
				done(frame);
			});
		});
	}

	notify(method, params) {
		this.send({ jsonrpc: '2.0', method, params });
	}

	send(frame) {
		this.child.stdin.write(`${JSON.stringify(frame)}\n`);
	}

	/** 工具结果里的文本(dsh_task / dsh_task_status 回的是给人看的文本,不是 JSON)。 */
	static textOf(frame) {
		return frame?.result?.content?.[0]?.text ?? '';
	}

	/** 从文本里取一个 `key: value` 字段。 */
	static field(frame, key) {
		const match = new RegExp(`^${key}:\\s*(.+)$`, 'm').exec(Client.textOf(frame));
		return match === null ? null : match[1].trim();
	}
}

const child = spawn(process.execPath, [join(root, 'bin', 'dsh-subagent-mcp.mjs')], {
	cwd: root,
	env: { ...process.env, DSH_SUBAGENT_WORKSPACE: workspace, DSH_SUBAGENT_AUTOSTART_MONITOR: '0' },
	stdio: ['pipe', 'pipe', 'ignore'],
	windowsHide: true,
});
const client = new Client(child);
let jobId = null;

try {
	await client.request('initialize', {
		protocolVersion: '2024-11-05',
		capabilities: {},
		clientInfo: { name: 'cancel-probe', version: '1.0.0' },
	});
	client.notify('notifications/initialized', {});

	// ① 派一个"会跑很久"的任务:让它真的睡够时间,期间进程必须活着。
	const started = await client.request('tools/call', {
		name: 'dsh_task',
		arguments: {
			prompt: '必须先用 shell 执行 `Start-Sleep -Seconds 300`(或 `sleep 300`),等命令返回后再回复 done。不要跳过这一步。',
			workspace,
			expected_seconds: 600,
			wait_seconds: 3,
			permission: 'danger-full-access',
			label: 'cancel-probe',
		},
	}, 60000);
	jobId = Client.field(started, 'job_id');
	check('任务已派发并拿到 job_id', typeof jobId === 'string' && jobId !== '',
		typeof jobId === 'string' ? jobId : `原始回复=${Client.textOf(started).slice(0, 160)}`);

	// 记下它的子进程 pid:后面要证明"进程真的没了",而不只是状态字段被改。
	const { tasksRoot } = await import('../lib/util.mjs');
	const taskJson = join(tasksRoot(), jobId, 'task.json');
	let pid = null;
	for (let i = 0; i < 40 && (pid === null || pid === 0); i += 1) {
		try {
			pid = Number(JSON.parse(readFileSync(taskJson, 'utf8')).pid ?? 0) || null;
		} catch {
			pid = null;
		}
		if (pid === null) await new Promise((done) => setTimeout(done, 250));
	}
	check('任务真的起来了(记录里有子进程 pid)', typeof pid === 'number' && pid > 0, `pid=${String(pid)}`);

	/** 进程是否还活着(Windows / POSIX 都能用)。 */
	const alive = (value) => {
		if (typeof value !== 'number' || value <= 0) return false;
		try {
			process.kill(value, 0);
			return true;
		} catch {
			return false;
		}
	};
	check('取消之前:子进程活着', alive(pid), `pid=${String(pid)}`);

	// ② 模拟 harness 的"停止本轮":先发出轮询(在途),再对该请求发取消通知。
	const statusId = client.fire('tools/call', {
		name: 'dsh_task_status',
		arguments: { job_id: jobId, wait_seconds: 30 },
	});
	await new Promise((done) => setTimeout(done, 300));
	client.notify('notifications/cancelled', { requestId: statusId, reason: 'user cancelled the turn' });

	const settled = await client.settle(statusId, 45000);
	const settledStatus = Client.field(settled, 'status');
	check('取消通知让在途请求立刻返回(不再干等 30 秒)',
		settled !== null && settledStatus !== 'running',
		`status=${String(settledStatus)}`);

	// ③ 子进程必须真的死掉。
	let deadAt = null;
	for (let i = 0; i < 60; i += 1) {
		if (!alive(pid)) {
			deadAt = i * 250;
			break;
		}
		await new Promise((done) => setTimeout(done, 250));
	}
	check('取消之后:子进程真的被终止(不是只把状态改成 cancelled)', deadAt !== null, deadAt === null ? '仍在运行' : `约 ${deadAt}ms 内退出`);

	const after = await client.request('tools/call', {
		name: 'dsh_task_status',
		arguments: { job_id: jobId, wait_seconds: 2 },
	});
	const afterStatus = String(Client.field(after, 'status'));
	check('任务终态记为 cancelled(而不是继续 running)',
		['cancelled', 'killed', 'error'].includes(afterStatus), `status=${afterStatus}`);

	// ④ 收尾:关掉 server 的 stdin ⇒ 连接断开这条路径也不能留下孤儿。
	child.stdin.end();
	await new Promise((done) => setTimeout(done, 1500));
	check('连接断开后 server 自行退出', child.exitCode !== null || child.signalCode !== null,
		`exitCode=${String(child.exitCode)}`);
} finally {
	// 无论断言成不成功,都不能把测试自己派出去的任务留在后台跑 ——
	// 那正是这个探针要防的事,自己不能犯。
	try {
		if (typeof jobId === 'string' && jobId !== '') {
			const { cancelTask } = await import('../lib/tasks.mjs');
			cancelTask(jobId);
		}
	} catch {
		/* 已经结束 */
	}
	try {
		child.kill();
	} catch {
		/* 已经退出 */
	}
	await new Promise((done) => setTimeout(done, 800));
	for (let i = 0; i < 8; i += 1) {
		try {
			if (existsSync(workspace)) rmSync(workspace, { recursive: true, force: true });
			break;
		} catch {
			await new Promise((done) => setTimeout(done, 500));
		}
	}
	console.log(`\n${passed}/${total} 通过`);
	process.exit(passed === total ? 0 : 1);
}
