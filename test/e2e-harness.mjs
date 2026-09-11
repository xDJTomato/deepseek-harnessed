#!/usr/bin/env node
/**
 * 验收脚本:让本机每个已安装的 harness 自己把任务委托给 DSH,再核对 DSH 真的把文件写出来了。
 *
 * 这是"把 DSH 当成 harness 的 subagent"这件事的端到端证据:harness 只负责转发,
 * 真正干活的是独立起来的 DSH 实例。
 *
 * 用法:
 *   node test/e2e-harness.mjs [工作空间] [--only=claude,codex,cursor]
 *
 * 退出码:全部通过 0;有失败 1。
 *
 * @module dsh-subagent/test/e2e-harness
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import process from 'node:process';

const argv = process.argv.slice(2);
const onlyArg = argv.find((arg) => arg.startsWith('--only'));
const only = onlyArg === undefined
	? null
	: new Set((onlyArg.includes('=') ? onlyArg.split('=')[1] : argv[argv.indexOf('--only') + 1] ?? '').split(',').map((s) => s.trim()).filter(Boolean));
const workspace = resolve(argv.find((arg) => !arg.startsWith('--') && arg !== onlyArg) ?? process.cwd());

const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);

/** 组装"把这件事委托给 DSH"的提示词;提示词一律走 argv,不落盘(结果最干净)。 */
function promptFor(harness, marker) {
	return `使用 dsh 这个 MCP server 的 dsh_task 工具把下面任务委托给 DSH 子代理执行(workspace 参数用 ${workspace},`
		+ `expected_seconds 填 300,acceptance 填 "e2e-${harness}-${stamp}.txt 内容恰为 ${marker}"),`
		+ '拿到结果后把 DSH 的原文贴出来。任务:'
		+ `在 ${workspace} 新建文件 e2e-${harness}-${stamp}.txt,内容写 ${marker},然后回答一行 DONE ${marker}。`;
}

/** 各 harness 的非交互调用方式(均为本机实测可用)。 */
const HARNESSES = [
	{
		name: 'claude',
		label: 'Claude Code (claude -p)',
		args: (prompt) => ['-p', prompt, '--allowedTools', 'mcp__dsh__dsh_task mcp__dsh__dsh_task_status mcp__dsh__dsh_health'],
		command: 'claude',
	},
	{
		name: 'codex',
		label: 'Codex CLI (codex exec)',
		args: (prompt) => ['exec', '--cd', workspace, '--skip-git-repo-check', '-c', 'approval_policy=never', '-c', 'sandbox_mode=danger-full-access', prompt],
		command: 'codex',
	},
	{
		name: 'cursor',
		label: 'Cursor Agent (cursor-agent -p)',
		args: (prompt) => ['-p', '--force', '--approve-mcps', '--trust', '--workspace', workspace, prompt],
		command: 'cursor-agent',
	},
];

/** 按 Windows 命令行规则拼一个参数(给 cmd.exe /c 用)。 */
function quoteArg(arg) {
	const text = String(arg).replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1');
	return `"${text.replace(/%/g, '%%')}"`;
}

/** 定位 harness 可执行文件:优先 .exe(可直接 spawn,参数不会被 shell 二次切词)。 */
function resolveCommand(name) {
	const hits = (() => {
		try {
			return execFileSync('where.exe', [name], { encoding: 'utf8' }).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
		} catch {
			return [];
		}
	})();
	const exe = hits.find((hit) => hit.toLowerCase().endsWith('.exe'));
	if (exe !== undefined) return { command: exe, prefix: [] };
	// .ps1 交给 powershell -File:参数按 PowerShell 规则绑定,不经过 cmd 的二次切词。
	const ps1 = hits.find((hit) => hit.toLowerCase().endsWith('.ps1'));
	if (ps1 !== undefined) {
		return {
			command: join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
			prefix: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1],
		};
	}
	// .cmd/.bat 只能由 cmd.exe 执行,整条命令行手工拼好并以 verbatim 方式交给它。
	const cmdShim = hits.find((hit) => /\.(cmd|bat)$/i.test(hit));
	if (cmdShim !== undefined) return { command: process.env.COMSPEC ?? 'cmd.exe', verbatim: true, prefix: ['/d', '/s', '/c'], shim: cmdShim };
	return { command: name, prefix: [] };
}

/** 跑一条命令,继承 stdio(便于看进度),返回退出码。 */
function run(name, args) {
	return new Promise((settle) => {
		const target = resolveCommand(name);
		const verbatim = target.shim !== undefined;
		const argv = verbatim
			// cmd /s 规则:整条命令行额外加一层引号,cmd 会剥掉它并原样执行。
			? [...target.prefix, `"${[target.shim, ...args].map(quoteArg).join(' ')}"`]
			: [...target.prefix, ...args];
		const child = spawn(target.command, argv, { stdio: 'inherit', windowsHide: true, windowsVerbatimArguments: verbatim });
		child.once('error', () => settle({ code: -1, error: 'not-found' }));
		child.once('exit', (code) => settle({ code, error: null }));
	});
}

const results = [];
process.stdout.write(`验收工作空间: ${workspace}\n时间戳标记: ${stamp}\n\n`);

for (const harness of HARNESSES) {
	if (only !== null && !only.has(harness.name)) continue;
	const marker = `${harness.name.toUpperCase()}-E2E-${stamp}`;
	const file = join(workspace, `e2e-${harness.name}-${stamp}.txt`);
	process.stdout.write(`=== ${harness.label} ===\n`);
	const started = Date.now();
	const { code, error } = await run(harness.command, harness.args(promptFor(harness.name, marker)));
	const elapsed = ((Date.now() - started) / 1000).toFixed(1);
	let content = null;
	try {
		content = existsSync(file) ? readFileSync(file, 'utf8').trim() : null;
	} catch {
		content = null;
	}
	const ok = content === marker;
	results.push({ name: harness.name, ok, elapsed, exitCode: code, error, file, content, marker });
	process.stdout.write(`→ ${ok ? '✅ 通过' : '❌ 失败'}:exit=${code} 用时=${elapsed}s 文件=${file} 内容=${JSON.stringify(content)}\n\n`);
}

process.stdout.write('=== 汇总 ===\n');
for (const item of results) {
	process.stdout.write(`${item.ok ? '✅' : '❌'} ${item.name}:委托成功=${item.ok} 用时=${item.elapsed}s${item.error ? ` (${item.error})` : ''}\n`);
}
const failed = results.filter((item) => !item.ok);
process.stdout.write(failed.length === 0 ? '\n全部 harness 委托链路通过 ✅\n' : `\n有 ${failed.length} 个 harness 未通过 ❌\n`);
process.exitCode = failed.length === 0 ? 0 : 1;
