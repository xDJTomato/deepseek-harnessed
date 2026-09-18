/**
 * 等待口径探针:dsh_task 先自己等一小段(短超时),只有到点没结束才转成轮询。
 *
 * 背景(真实抱怨):调用方被告知"wait_seconds 默认 30,建议传 0",于是每次委派都变成
 * "立刻拿到 job_id + 每 20~30 秒轮询一次"。长任务于是被拆成十几次调用,而每一轮都是
 * 调用方一次完整的推理 —— 又慢又贵。改成"默认就等"之后,短任务一次调用就能拿到终态。
 *
 * 这个探针真的起 MCP server、真的派任务,断言四件事:
 *   ① dsh_health 回报的等待口径就是策略本身(45s / 30s,两者都 < harness 的 60s 工具超时);
 *   ② 不传 wait_seconds 时,dsh_task 会一直等到任务结束,并在**同一次调用**里返回终态 ok;
 *   ③ 到点还没结束时(用 DSH_SUBAGENT_WAIT_SECONDS=5 模拟短超时),同一次调用返回 running,
 *      并且明确告诉调用方改用 dsh_task_status(wait_seconds=30) 继续轮询;
 *   ④ dsh_task_status 不传 wait_seconds 时自己会等(30s),而不是立刻返回现状。
 *
 * 用法:
 *   node test/wait-policy-probe.mjs
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const workspace = mkdtempSync(join(tmpdir(), 'dsh-wait-probe-'));

let total = 0;
let passed = 0;
function check(name, ok, detail = '') {
	total += 1;
	if (ok) passed += 1;
	console.log(`${ok ? '✅' : '❌'} ${name}${detail === '' ? '' : `  (${detail})`}`);
}

/** 极简 MCP stdio 客户端。 */
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

	request(method, params, timeoutMs = 120000) {
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

	notify(method, params) {
		this.send({ jsonrpc: '2.0', method, params });
	}

	send(frame) {
		this.child.stdin.write(`${JSON.stringify(frame)}\n`);
	}

	static textOf(frame) {
		return frame?.result?.content?.[0]?.text ?? '';
	}

	static field(frame, key) {
		const match = new RegExp(`^${key}:\\s*(.+)$`, 'm').exec(Client.textOf(frame));
		return match === null ? null : match[1].trim();
	}
}

/** 起一个 MCP server 并完成 initialize,返回 { child, client }。 */
async function connect(env, callerName) {
	const child = spawn(process.execPath, [join(root, 'bin', 'dsh-subagent-mcp.mjs')], {
		cwd: root,
		env: { ...process.env, DSH_SUBAGENT_WORKSPACE: workspace, DSH_SUBAGENT_AUTOSTART_MONITOR: '0', ...env },
		stdio: ['pipe', 'pipe', 'ignore'],
		windowsHide: true,
	});
	const client = new Client(child);
	await client.request('initialize', {
		protocolVersion: '2024-11-05',
		capabilities: {},
		clientInfo: { name: callerName, version: '1.0.0' },
	});
	client.notify('notifications/initialized', {});
	return { child, client };
}

const children = [];
const jobIds = [];
try {
	// ① 默认口径(client A:不设任何覆盖)
	const a = await connect({}, 'wait-policy-probe');
	children.push(a.child);
	const health = Client.textOf(await a.client.request('tools/call', { name: 'dsh_health', arguments: {} }));
	check('dsh_health 回报 defaultWaitSeconds=45', health.includes('"defaultWaitSeconds": 45'),
		/"defaultWaitSeconds":[^,]*/.exec(health)?.[0] ?? '未出现');
	check('dsh_health 回报 statusWaitSeconds=30', health.includes('"statusWaitSeconds": 30'),
		/"statusWaitSeconds":[^,]*/.exec(health)?.[0] ?? '未出现');
	check('dsh_health 写明等待口径(短超时 + 轮询)', /短超时/.test(health) && /"waitModel"/.test(health));

	// ② 不传 wait_seconds:短任务应当由**这一次调用**带回终态,不需要轮询
	const fastStarted = Date.now();
	const fast = await a.client.request('tools/call', {
		name: 'dsh_task',
		arguments: {
			prompt: '只回答两个字:收到',
			workspace,
			raw_prompt: true,
			expected_seconds: 300,
			acceptance: '最终答复恰为"收到"',
			label: 'wait-probe-fast',
		},
	});
	const fastMs = Date.now() - fastStarted;
	const fastStatus = Client.field(fast, 'status');
	const fastJob = Client.field(fast, 'job_id');
	if (typeof fastJob === 'string') jobIds.push(fastJob);
	check('不传 wait_seconds 时,一次调用就拿到终态(不再需要轮询)',
		fastStatus === 'ok', `status=${String(fastStatus)} 用时 ${(fastMs / 1000).toFixed(1)}s`);
	check('短任务没有被"等满 45s"才返回(任务结束即返回)',
		fastMs < 45000, `${(fastMs / 1000).toFixed(1)}s`);
	check('这一路没有让调用方去轮询', !/请.*轮询|继续轮询/.test(Client.textOf(fast)));

	// ③ 到点没结束:同一次调用返回 running,并把"改用哪个等待值轮询"写清楚
	const b = await connect({ DSH_SUBAGENT_WAIT_SECONDS: '5' }, 'wait-policy-probe-short');
	children.push(b.child);
	const slowStarted = Date.now();
	const slow = await b.client.request('tools/call', {
		name: 'dsh_task',
		arguments: {
			prompt: '先用 shell 执行 `Start-Sleep -Seconds 20`(命令必须真的跑完),然后回答一行 SLEPT。',
			workspace,
			raw_prompt: true,
			expected_seconds: 300,
			label: 'wait-probe-slow',
		},
	});
	const slowMs = Date.now() - slowStarted;
	const slowStatus = Client.field(slow, 'status');
	const slowJob = Client.field(slow, 'job_id');
	if (typeof slowJob === 'string') jobIds.push(slowJob);
	check('短超时(5s,经环境变量覆盖)到点后返回 running',
		slowStatus === 'running', `status=${String(slowStatus)} 用时 ${(slowMs / 1000).toFixed(1)}s`);
	check('返回 running 时写明"这次等满了短超时"', /等满 5s|短超时/.test(Client.textOf(slow)));
	check('返回 running 时给出轮询命令与 status 默认等待值',
		new RegExp(`dsh_task_status\\(job_id="${slowJob}", wait_seconds=30\\)`).test(Client.textOf(slow)),
		/dsh_task_status\([^)]*\)/.exec(Client.textOf(slow))?.[0] ?? '未出现');

	// ④ dsh_task_status 不传 wait_seconds 时自己会等(默认 30s),而不是立刻返回现状
	const pollStarted = Date.now();
	const polled = await b.client.request('tools/call', {
		name: 'dsh_task_status',
		arguments: { job_id: slowJob },
	}, 120000);
	const pollMs = Date.now() - pollStarted;
	check('dsh_task_status 默认自己等待,并等到终态',
		Client.field(polled, 'status') === 'ok', `status=${String(Client.field(polled, 'status'))} 用时 ${(pollMs / 1000).toFixed(1)}s`);
	check('这次轮询没有超过 status 默认等待值(30s)', pollMs < 32000, `${(pollMs / 1000).toFixed(1)}s`);
} finally {
	try {
		const { cancelTask } = await import('../lib/tasks.mjs');
		for (const jobId of jobIds) {
			try {
				cancelTask(jobId);
			} catch {
				/* 已经结束 */
			}
		}
	} catch {
		/* 库加载失败也不该掩盖断言结果 */
	}
	for (const child of children) {
		try {
			child.stdin.end();
			child.kill();
		} catch {
			/* 已经退出 */
		}
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
