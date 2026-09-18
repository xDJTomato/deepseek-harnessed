#!/usr/bin/env node
/**
 * dsh-subagent 自检:真的拉起 MCP server,按 MCP 协议走一遍
 * initialize → tools/list → tools/call(dsh_health) → tools/call(dsh_task),
 * 并核对 DSH 是否真的在目标工作空间里干完了活。
 *
 *   node test/selftest.mjs [工作空间]
 *
 * 退出码 0 = 全绿。
 *
 * @module dsh-subagent/test/selftest
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { BRIDGE_ROOT } from '../lib/util.mjs';

const MCP_ENTRY = join(BRIDGE_ROOT, 'bin', 'dsh-subagent-mcp.mjs');
/** package.json 里的版本 —— server 应该报这个,而不是自己硬编码一个。 */
const manifestVersion = JSON.parse(readFileSync(join(BRIDGE_ROOT, 'package.json'), 'utf8')).version;
const workspace = process.argv[2] ?? join(BRIDGE_ROOT, 'state', 'selftest-workspace');
const results = [];

/** 断言并记录。 */
function check(name, ok, detail = '') {
	results.push({ name, ok, detail });
	process.stdout.write(`${ok ? '✅' : '❌'} ${name}${detail === '' ? '' : ` — ${detail}`}\n`);
}

/** 一个极简 MCP stdio 客户端。 */
class Client {
	constructor(command, args, extraEnv = {}) {
		this.child = spawn(command, args, {
			stdio: ['pipe', 'pipe', 'pipe'],
			windowsHide: true,
			env: { ...process.env, ...extraEnv },
		});
		this.buffer = '';
		this.pending = new Map();
		this.notifications = [];
		this.nextId = 1;
		/** server 写过的 stderr:用来验证"正常启动一个字都不写"。 */
		this.stderrText = '';
		this.child.stdout.setEncoding('utf8');
		this.child.stdout.on('data', (chunk) => this.onData(chunk));
		this.child.stderr.setEncoding('utf8');
		this.child.stderr.on('data', (chunk) => {
			this.stderrText += chunk;
			process.stderr.write(`[server] ${chunk}`);
		});
	}
	onData(chunk) {
		this.buffer += chunk;
		for (;;) {
			const newline = this.buffer.indexOf('\n');
			if (newline < 0) break;
			const line = this.buffer.slice(0, newline).trim();
			this.buffer = this.buffer.slice(newline + 1);
			if (line === '') continue;
			const frame = JSON.parse(line);
			if (frame.id !== undefined && frame.method === undefined) {
				const waiter = this.pending.get(frame.id);
				if (waiter === undefined) continue;
				this.pending.delete(frame.id);
				if (frame.error) waiter.reject(new Error(frame.error.message));
				else waiter.resolve(frame.result);
				continue;
			}
			if (frame.id !== undefined && frame.method !== undefined) {
				// server → client 请求(roots/list)
				this.write({ jsonrpc: '2.0', id: frame.id, result: { roots: [{ uri: `file:///${workspace.replace(/\\/g, '/')}`, name: 'selftest' }] } });
				continue;
			}
			this.notifications.push(frame);
		}
	}
	write(message) {
		this.child.stdin.write(`${JSON.stringify(message)}\n`);
	}
	request(method, params) {
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			this.write({ jsonrpc: '2.0', id, method, params });
			setTimeout(() => {
				if (this.pending.delete(id)) reject(new Error(`${method} 超时`));
			}, 600000).unref?.();
		});
	}
	notify(method, params) {
		this.write({ jsonrpc: '2.0', method, params });
	}
	close() {
		this.child.stdin.end();
		this.child.kill();
	}
}

/** 取工具结果里的文本。 */
function textOf(result) {
	return (result?.content ?? []).filter((part) => part.type === 'text').map((part) => part.text).join('\n');
}

async function main() {
	process.stdout.write(`自检工作空间: ${workspace}\n\n`);
	rmSync(workspace, { recursive: true, force: true });
	mkdirSync(workspace, { recursive: true });

	// 自检**绝不能**真的拉起 GUI:自动拉起的三种行为由 test/monitor-autostart-probe.mjs 用假 exe 覆盖,
	// 这里只验证"接线"(字段有没有出现在结果里),所以显式关掉总开关。
	const client = new Client(process.execPath, [MCP_ENTRY], { DSH_SUBAGENT_AUTOSTART_MONITOR: 'off' });

	// 1. 握手
	const init = await client.request('initialize', {
		protocolVersion: '2025-06-18',
		capabilities: { roots: { listChanged: true } },
		clientInfo: { name: 'dsh-subagent-selftest', version: '0.0.1' },
	});
	check('MCP initialize', init?.serverInfo?.name === 'dsh-subagent', `protocolVersion=${init?.protocolVersion}`);
	// 1a2. 版本号只有 package.json 一个来源(曾经硬编码 0.2.0,与仓库 0.1.1 打架)
	check('serverInfo.version 与 package.json 一致', init?.serverInfo?.version === manifestVersion,
		`server=${init?.serverInfo?.version} package.json=${manifestVersion}`);
	// 1a3. 正常启动**不许写 stderr**:Cursor 会把 MCP 子进程的 stderr 渲染成 warning
	//      (实测 `mcpprocess.log`: `[warning] [McpProcess stderr]   ERR dsh-subagent: MCP stdio server ready …`)
	check('正常启动不往 stderr 写任何东西(不触发 harness 的 warning)', client.stderrText === '',
		JSON.stringify(client.stderrText.slice(0, 120)));
	// 1b. initialize.instructions:harness 会把它当系统提示,委派操作手册必须能到模型手里
	const instructions = String(init?.instructions ?? '');
	check('initialize 带委派操作手册 instructions', instructions.length > 400 && instructions.includes('expected_seconds'),
		`${instructions.length} 字符`);
	check('instructions 覆盖 估时/验收/轮询/止损', ['acceptance', '短超时', 'dsh_task_kill', 'stalled'].every((key) => instructions.includes(key)),
		['acceptance', '短超时', 'dsh_task_kill', 'stalled'].filter((key) => instructions.includes(key)).join(','));
	check('instructions 不超长(≤1500)', instructions.length <= 1500, `${instructions.length} 字符`);
	client.notify('notifications/initialized', {});

	// 2. 工具清单
	const tools = await client.request('tools/list', {});
	const names = (tools?.tools ?? []).map((tool) => tool.name);
	check('tools/list 暴露 5 个工具', ['dsh_task', 'dsh_task_status', 'dsh_task_cancel', 'dsh_task_kill', 'dsh_health'].every((name) => names.includes(name)), names.join(', '));
	const taskTool = (tools?.tools ?? []).find((tool) => tool.name === 'dsh_task');
	check('dsh_task 要求必填 expected_seconds', (taskTool?.inputSchema?.required ?? []).includes('expected_seconds'), JSON.stringify(taskTool?.inputSchema?.required ?? []));
	// 2b. 委派建议必须写进工具定义本身(而不是只在 README 里)
	const taskDesc = String(taskTool?.description ?? '');
	const descNeedles = ['硬承诺', '单文件小改 60~180', '可机检', '短超时', 'stalled', 'recent_activity', '20 分钟', 'pwsh'];
	check('dsh_task 描述含完整委派约定', descNeedles.every((needle) => taskDesc.includes(needle)),
		descNeedles.filter((needle) => !taskDesc.includes(needle)).join(',') || `${taskDesc.length} 字符`);
	const fieldOf = (name) => String(taskTool?.inputSchema?.properties?.[name]?.description ?? '');
	check('expected_seconds 字段写明硬截止与经验值', fieldOf('expected_seconds').includes('deadlineAt') && fieldOf('expected_seconds').includes('300~900'), fieldOf('expected_seconds').slice(0, 60));
	check('acceptance 字段写明可机检', fieldOf('acceptance').includes('可判定真伪'), fieldOf('acceptance').slice(0, 50));
	// 新契约:默认就等(短超时),只有到点没结束才轮询;并明确劝退 wait_seconds=0 与 >60
	check('wait_seconds 字段写明"先等、超时才轮询"', /dsh_task_status/.test(fieldOf('wait_seconds')) && /短超时/.test(fieldOf('wait_seconds')) && /不要传 0/.test(fieldOf('wait_seconds')), fieldOf('wait_seconds').slice(0, 60));
	check('permission 字段写明请用文件工具', fieldOf('permission').includes('write/edit'), fieldOf('permission').slice(0, 50));
	const healthTool = (tools?.tools ?? []).find((tool) => tool.name === 'dsh_health');
	check('dsh_health 描述写明 monitorHost 与 liveTasks', /monitorHost/.test(String(healthTool?.description ?? '')) && /liveTasks/.test(String(healthTool?.description ?? '')));
	const killTool = (tools?.tools ?? []).find((tool) => tool.name === 'dsh_task_kill');
	check('dsh_task_kill 描述写明两种模式与止损时机', /caller/.test(String(killTool?.description ?? '')) && /止损/.test(String(killTool?.description ?? '')));

	// 3. 探活
	const health = textOf(await client.request('tools/call', { name: 'dsh_health', arguments: {} }));
	check('dsh_health 报告可用', health.includes('已就绪'), health.split('\n')[0]);
	check('dsh_health 回报本连接 caller', health.includes('"thisCaller": "dsh-subagent-selftest"'), '"thisCaller" 已出现');
	check('dsh_health 含按 caller 的并发分组', /activeByCaller/.test(health) && /liveTasks/.test(health));
	// 3c. 监控宿主状态必须能查到(自动拉起的三种行为在 monitor-autostart-probe.mjs 里覆盖)
	check('dsh_health 回报 monitorHost 状态', /"monitorHost"/.test(health) && /"autostart": false/.test(health) && /"running":/.test(health),
		/"monitorHost"[\s\S]{0,160}/.exec(health)?.[0].replace(/\s+/g, ' ').slice(0, 120) ?? '');
	check('dsh_health 回报心跳判活窗口', /"heartbeatStaleMs": 20000/.test(health) || /"heartbeatStaleMs": \d+/.test(health),
		/"heartbeatStaleMs"[^,]*/.exec(health)?.[0] ?? '');
	// 3d. 等待口径是本仓库的**策略**:两个默认值必须落在 harness 单次工具超时(Codex 默认 60s)之内,
	//     否则调用方会先掐断这次调用,甚至把还在跑的任务当成"停这一轮"给停掉。
	const expectedTaskWait = Number(process.env.DSH_SUBAGENT_WAIT_SECONDS ?? 45);
	const expectedStatusWait = Number(process.env.DSH_SUBAGENT_STATUS_WAIT_SECONDS ?? 30);
	check('默认等待口径 = 短超时 + 轮询等待,且都 < 60s',
		health.includes(`"defaultWaitSeconds": ${expectedTaskWait}`)
		&& health.includes(`"statusWaitSeconds": ${expectedStatusWait}`)
		&& expectedTaskWait < 60 && expectedStatusWait < 60,
		`default=${expectedTaskWait}s status=${expectedStatusWait}s`);

	// 3b. 委派契约:少了 expected_seconds 必须被明确拒绝(isError:true,而不是"看起来正常"的说明文本)
	const missing = await client.request('tools/call', { name: 'dsh_task', arguments: { prompt: 'x', workspace, raw_prompt: true } });
	const missingText = textOf(missing);
	check('缺 expected_seconds 被拒绝', /expected_seconds/.test(missingText) && !/status: (ok|running)/.test(missingText), missingText.slice(0, 80));
	check('缺 expected_seconds 返回 isError:true', missing?.isError === true, `isError=${JSON.stringify(missing?.isError)}`);
	const badExpected = await client.request('tools/call', { name: 'dsh_task', arguments: { prompt: 'x', workspace, expected_seconds: 0, raw_prompt: true } });
	check('expected_seconds=0 被拒绝', /必须是正整数/.test(textOf(badExpected)), textOf(badExpected).slice(0, 80));
	check('expected_seconds=0 返回 isError:true', badExpected?.isError === true, `isError=${JSON.stringify(badExpected?.isError)}`);
	const longAcceptance = await client.request('tools/call', { name: 'dsh_task', arguments: { prompt: 'x', workspace, expected_seconds: 60, acceptance: 'x'.repeat(2001), raw_prompt: true } });
	check('acceptance 过长被拒绝', /acceptance 过长/.test(textOf(longAcceptance)), textOf(longAcceptance).slice(0, 60));
	check('acceptance 过长返回 isError:true', longAcceptance?.isError === true, `isError=${JSON.stringify(longAcceptance?.isError)}`);

	// 4. 真跑一轮任务:让 DSH 在工作空间里创建文件并执行命令
	const marker = `SELFTEST-${Date.now()}`;
	const acceptance = `selftest.txt 内容含 ${marker} 且有 version= 行`;
	const task = [
		`在 ${workspace} 里做两件事:`,
		`1. 新建文件 selftest.txt,内容为 ${marker};`,
		'2. 运行命令 `node --version`,把得到的版本号追加到 selftest.txt 的第二行(格式 version=<版本>)。',
		'完成后回答一行:OK <selftest.txt 的两行内容>',
	].join('\n');
	const started = Date.now();
	const call = await client.request('tools/call', {
		name: 'dsh_task',
		arguments: { prompt: task, workspace, wait_seconds: 240, raw_prompt: true, expected_seconds: 300, acceptance, label: 'selftest-main' },
	});
	const taskText = textOf(call);
	const elapsed = ((Date.now() - started) / 1000).toFixed(1);
	check('dsh_task 返回完成状态', /status: ok/.test(taskText), `${elapsed}s`);
	check('结果回传 caller=selftest', /caller: dsh-subagent-selftest/.test(taskText));
	check('结果回显 expected_seconds 与硬截止', /expected_seconds: 300/.test(taskText) && /deadline: /.test(taskText), taskText.split('\n').slice(4, 7).join(' | '));
	check('结果回显 acceptance', taskText.includes(acceptance));
	// 4d. dsh_task 结果必须带上"监控窗口这次是什么动作"
	check('dsh_task 结果带 monitor_host 动作', /monitor_host: (already-running|launched|skipped|unavailable)/.test(taskText),
		/monitor_host: [^\n]*/.exec(taskText)?.[0] ?? '未出现');
	check('DSH 真的写了文件', existsSync(join(workspace, 'selftest.txt')), join(workspace, 'selftest.txt'));
	const content = existsSync(join(workspace, 'selftest.txt')) ? readFileSync(join(workspace, 'selftest.txt'), 'utf8') : '';
	check('文件内容包含标记', content.includes(marker), JSON.stringify(content.split(/\r?\n/).slice(0, 3)));
	check('文件包含命令输出', /version=/.test(content));
	check('结果文本回传了 DSH 答复', taskText.includes('DSH 子代理的最终答复'), taskText.split('\n').slice(0, 3).join(' | '));
	check('含 dsh_session', /dsh_session: session-/.test(taskText));

	// 4b. 任务记录必须一开始就带 caller / expectedSeconds / deadlineAt(GUI 靠它按 caller 分组)
	const mainJob = /job_id: (\S+)/.exec(taskText)?.[1] ?? '';
	const recordPath = join(BRIDGE_ROOT, 'state', 'tasks', mainJob, 'task.json');
	const record = existsSync(recordPath) ? JSON.parse(readFileSync(recordPath, 'utf8')) : {};
	check('task.json 含 caller/callerVersion', record.caller === 'dsh-subagent-selftest' && record.callerVersion === '0.0.1', `caller=${record.caller} v=${record.callerVersion}`);
	check('task.json 含 expectedSeconds/deadlineAt', record.expectedSeconds === 300 && typeof record.deadlineAt === 'string', `expected=${record.expectedSeconds} deadline=${record.deadlineAt}`);
	check('task.json 含验收标准与进度取证', record.acceptance === acceptance && typeof record.lastProgressAt === 'string', `acceptance=${JSON.stringify(record.acceptance)}`);

	// 4c. 停滞判定必须是"多信号":只看日志字节数会误杀静默但真在干活的任务
	check('dsh_health 回报看门狗的多信号阈值', /"watchdogCpuThresholdMs": 200/.test(health) && /"watchdogStallMinSeconds": 180/.test(health), /watchdog[^\n]*/.exec(health)?.[0] ?? '');
	check('dsh_health 回报 CPU 干活强度下限', /"watchdogCpuWorkFloorMs": 1500/.test(health), /watchdogCpuWorkFloorMs[^\n]*/.exec(health)?.[0] ?? '');
	check('task.json 留有逐信号取证 signalState', record.signalState === null || record.signalState === undefined || typeof record.signalState.treeCpuMs === 'number', JSON.stringify(record.signalState ?? null).slice(0, 120));

	// 5. 失败路径:不存在的工作空间必须报错而不是静默成功
	const bad = await client.request('tools/call', { name: 'dsh_task', arguments: { prompt: 'x', workspace: join(workspace, 'no-such-dir'), expected_seconds: 60 } });
	check('非法工作空间被拒绝', bad?.isError === true || /失败|不存在/.test(textOf(bad)), textOf(bad).slice(0, 120));

	// 6. 异步 + 轮询路径(顺带验证 recent_activity 与按 caller 强杀)
	const asyncCall = await client.request('tools/call', {
		name: 'dsh_task',
		arguments: { prompt: '回答两个字:收到', workspace, wait_seconds: 0, raw_prompt: true, expected_seconds: 300, label: 'selftest-async' },
	});
	const asyncText = textOf(asyncCall);
	const jobId = /job_id: (\S+)/.exec(asyncText)?.[1] ?? '';
	check('wait_seconds=0 立即返回 job_id', /status: running/.test(asyncText) && jobId !== '', jobId);
	check('运行中结果带 recent_activity 与剩余时间', /recent_activity/.test(asyncText) && /剩余 \d+s/.test(asyncText), asyncText.split('\n').filter((line) => /recent_activity|deadline|activity_bytes/.test(line)).join(' | '));
	if (jobId !== '') {
		const polled = textOf(await client.request('tools/call', { name: 'dsh_task_status', arguments: { job_id: jobId, wait_seconds: 180 } }));
		check('dsh_task_status 轮询到完成', /status: ok/.test(polled), polled.split('\n').slice(0, 2).join(' | '));
	}

	// 6b. 按 caller 强杀:起两个长任务,再用 caller 模式一次性停掉
	const victims = [];
	for (let index = 0; index < 2; index += 1) {
		const victim = await client.request('tools/call', {
			name: 'dsh_task',
			arguments: {
				prompt: `运行命令 \`node -e "setTimeout(()=>{},300000)"\`,命令返回后每隔 30 秒运行一次 \`node -v\`,直到累计运行 20 次,最后回答一行 DONE VICTIM${index + 1}。`,
				workspace,
				wait_seconds: 0,
				raw_prompt: true,
				expected_seconds: 900,
				label: `selftest-kill-${index + 1}`,
			},
		});
		const victimId = /job_id: (\S+)/.exec(textOf(victim))?.[1] ?? '';
		if (victimId !== '') victims.push(victimId);
	}
	const killCall = await client.request('tools/call', {
		name: 'dsh_task_kill',
		arguments: { caller: 'dsh-subagent-selftest', reason: 'selftest 收尾清理' },
	});
	const killText = textOf(killCall);
	check('dsh_task_kill 按 caller 强杀', /"killed": \[/.test(killText) && killText.includes('"caller": "dsh-subagent-selftest"'), killText.split('\n').slice(0, 2).join(' | '));
	check('被强杀的任务数 ≥ 1', /已强杀 caller="dsh-subagent-selftest" 的 [1-9]\d* 个运行中任务/.test(killText), /已强杀[^\n]*/.exec(killText)?.[0] ?? killText.slice(0, 120));
	// 幽灵记录必须被单独回报(别让调用方以为"已强杀"就等于都清了)
	check('dsh_task_kill 回报幽灵记录 stale 数组', /"stale": \[/.test(killText), /"stale": \[[^\]]*\]/.exec(killText)?.[0]?.slice(0, 60) ?? '未出现');
	let killedOk = victims.length > 0;
	for (const victimId of victims) {
		const state = textOf(await client.request('tools/call', { name: 'dsh_task_status', arguments: { job_id: victimId } }));
		const victimStatus = /status: (\S+)/.exec(state)?.[1] ?? '';
		if (victimStatus !== 'killed' && victimStatus !== 'cancelled' && victimStatus !== 'error') killedOk = false;
	}
	check('被强杀任务收敛到终态', killedOk, victims.join(', '));
	const killNoArgs = await client.request('tools/call', { name: 'dsh_task_kill', arguments: {} });
	check('dsh_task_kill 无参给出可操作提示', /需要 job_id 或 caller/.test(textOf(killNoArgs)), textOf(killNoArgs).slice(0, 80));
	check('dsh_task_kill 无参返回 isError:true', killNoArgs?.isError === true, `isError=${JSON.stringify(killNoArgs?.isError)}`);

	client.close();

	// 6b. 排查开关:设了 DSH_SUBAGENT_DEBUG 才应该有启动横幅
	const debugClient = new Client(process.execPath, [MCP_ENTRY], { DSH_SUBAGENT_DEBUG: '1', DSH_SUBAGENT_AUTOSTART_MONITOR: 'off' });
	await debugClient.request('initialize', {
		protocolVersion: '2025-06-18',
		capabilities: { roots: { listChanged: true } },
		clientInfo: { name: 'dsh-subagent-selftest-debug', version: '0.0.1' },
	});
	check('DSH_SUBAGENT_DEBUG=1 时才有启动横幅(且带正确版本)',
		debugClient.stderrText.includes('MCP stdio server ready') && debugClient.stderrText.includes(manifestVersion),
		JSON.stringify(debugClient.stderrText.trim().slice(0, 120)));
	debugClient.close();

	// 7. 落盘审计
	const report = { workspace, at: new Date().toISOString(), results };
	writeFileSync(join(BRIDGE_ROOT, 'state', 'selftest-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');

	const failed = results.filter((entry) => !entry.ok);
	process.stdout.write(`\n${results.length - failed.length}/${results.length} 项通过${failed.length === 0 ? ',全绿 ✅' : ',存在失败 ❌'}\n`);
	return failed.length === 0 ? 0 : 1;
}

main().then((code) => {
	process.exitCode = code;
}, (error) => {
	// 自检本身崩了(不是"某项没通过"):原因必须留下来。
	// 踩过:调用方把 stdout 接进管道(`| Select-Object -Last 1`)、stderr 丢弃时,
	// 崩溃原因一起消失,只剩一个"exit 1 + 空输出",完全无法复盘。
	const detail = `${new Date().toISOString()} 自检异常(已跑到第 ${results.length} 项): ${error?.stack ?? error}\n`;
	try {
		writeFileSync(join(BRIDGE_ROOT, 'state', 'selftest-crash.log'), detail, 'utf8');
	} catch {
		/* 落盘失败也不能再抛 */
	}
	// **stdout 也要写一行**:这样即使 stderr 被丢掉、stdout 被管道截断,也看得见"为什么崩"。
	process.stdout.write(`\n自检异常(不是用例失败)❌ 已跑到第 ${results.length} 项,详情见 state/selftest-crash.log: ${error?.message ?? error}\n`);
	process.stderr.write(`自检异常: ${detail}`);
	process.exitCode = 1;
});
