#!/usr/bin/env node
/**
 * dsh-subagent —— 命令行入口:把整个 DSH 实例当成一个 subagent 调用。
 *
 *   dsh-subagent --workspace D:\repo "把 backend 的单测跑通并汇报失败项"
 *   dsh-subagent --workspace D:\repo --expected-seconds 300 --acceptance "全部用例通过" "跑一遍单测"
 *   dsh-subagent --workspace D:\repo --prompt-file task.md --json
 *   echo "总结一下这个仓库" | dsh-subagent --workspace .
 *
 * 不带 --json 时:stdout 只输出 DSH 的最终答复,退出码 0/1 与 DSH 一致,
 * 适合任何 harness 直接 shell 调用。
 *
 * @module dsh-subagent/bin/dsh-subagent
 */
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { startTask, resolveWorkspace, listTasks, PERMISSIONS, DEFAULT_TIMEOUT_SECONDS, DEADLINE_GRACE } from '../lib/tasks.mjs';
import { resolveLauncher } from '../lib/launcher.mjs';
import { dshHome } from '../lib/util.mjs';

/** CLI 未显式给 --expected-seconds 时的默认预估:取外层上限的一半。 */
const CLI_DEFAULT_EXPECTED_SECONDS = Math.max(1, Math.floor(DEFAULT_TIMEOUT_SECONDS / 2));

const USAGE = `dsh-subagent —— 在指定工作空间里跑一轮 DSH 任务并回传结果

用法:
  dsh-subagent [选项] [任务提示词...]

选项:
  -w, --workspace <dir>        目标工作空间(默认当前目录)
  -f, --prompt-file <path>     从文件读取提示词(推荐,不受命令行长度限制)
  -m, --model <id>             本次调用的模型(默认沿用 DSH 设置)
  -p, --provider <id>          模型提供方(默认沿用 DSH 设置)
      --permission <mode>      ${PERMISSIONS.join(' | ')}(默认 danger-full-access)
  -e, --expected-seconds <n>   预估耗时(正整数,默认 ${CLI_DEFAULT_EXPECTED_SECONDS});超时 ×${DEADLINE_GRACE} 即硬截止
      --acceptance <text>      验收标准(一句可判定的话,随任务落盘并回显)
      --caller <name>          记录调用方身份(默认 cli)
  -t, --timeout <seconds>      外层墙钟上限(默认 ${DEFAULT_TIMEOUT_SECONDS},比硬截止更宽松)
      --label <text>           任务标签,便于审计
      --json                   输出 JSON 信封(含 sessionId / job_id / caller / 硬截止)
      --raw                    不加「委托说明」前言,原样把提示词交给 DSH
      --list                   列出最近任务后退出
      --where                  打印解析到的 dsh 启动器与 DSH_HOME 后退出
  -h, --help                   显示本帮助

示例:
  dsh-subagent -w D:\\repo -e 300 "运行后端测试,汇总失败用例"
  dsh-subagent -w D:\\repo -f task.md --json
`;

/** 极简参数解析。 */
function parseArgs(argv) {
	const options = { positional: [], json: false, raw: false };
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		const next = () => {
			index += 1;
			if (index >= argv.length) throw new Error(`${arg} 缺少取值`);
			return argv[index];
		};
		switch (arg) {
			case '-h': case '--help': options.help = true; break;
			case '-w': case '--workspace': options.workspace = next(); break;
			case '-f': case '--prompt-file': options.promptFile = next(); break;
			case '-m': case '--model': options.model = next(); break;
			case '-p': case '--provider': options.provider = next(); break;
			case '--permission': options.permission = next(); break;
			case '-e': case '--expected-seconds': options.expectedSeconds = Number(next()); break;
			case '--acceptance': options.acceptance = next(); break;
			case '--caller': options.caller = next(); break;
			case '-t': case '--timeout': options.timeout = Number(next()); break;
			case '--label': options.label = next(); break;
			case '--json': options.json = true; break;
			case '--raw': options.raw = true; break;
			case '--list': options.list = true; break;
			case '--where': options.where = true; break;
			default:
				if (arg.startsWith('--')) throw new Error(`未知选项: ${arg}`);
				options.positional.push(arg);
		}
	}
	return options;
}

/** 读 stdin(用于管道调用)。 */
async function readStdin() {
	if (process.stdin.isTTY) return '';
	const chunks = [];
	for await (const chunk of process.stdin) chunks.push(chunk);
	return Buffer.concat(chunks.map((chunk) => (Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))).toString('utf8');
}

/** 给 DSH 的一次性委托前言(与 MCP 侧一致)。 */
function preamble(workspace) {
	return [
		'# 委托说明',
		'- 你正被外部 harness(命令行 dsh-subagent)通过 DSH subagent 桥接调用,工作目录:' + workspace,
		'- 这是一次性会话:没有任何人会再回答你的追问,不要提问、不要等待确认,直接完成任务。',
		'- 结束时用中文简要汇报:做了什么、改了哪些文件(绝对路径)、命令与结果、结论;若未完成必须说明阻塞原因。',
		'',
		'# 任务内容',
		'',
	].join('\n');
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	if (options.help) {
		process.stdout.write(USAGE);
		return 0;
	}
	if (options.where) {
		const launcher = resolveLauncher();
		process.stdout.write(`DSH_HOME    : ${dshHome()}\n启动器      : ${launcher.describe}\n垫片        : ${launcher.shim}\n`);
		return 0;
	}
	if (options.list) {
		process.stdout.write(`${JSON.stringify(listTasks(20), null, 2)}\n`);
		return 0;
	}

	let prompt = options.positional.join(' ').trim();
	if (options.promptFile !== undefined) {
		prompt = readFileSync(options.promptFile, 'utf8');
	} else if (prompt === '') {
		prompt = (await readStdin()).trim();
	}
	if (prompt === '') {
		process.stderr.write(`错误: 需要任务提示词(位置参数 / --prompt-file / stdin)。\n\n${USAGE}`);
		return 2;
	}

	const workspace = resolveWorkspace(options.workspace);
	// 预估耗时:CLI 有默认值(外层上限的一半),MCP 侧则是必填参数。
	const expectedSeconds = Number.isInteger(options.expectedSeconds) && options.expectedSeconds > 0
		? options.expectedSeconds
		: CLI_DEFAULT_EXPECTED_SECONDS;
	const started = await startTask({
		prompt: options.raw ? prompt : `${preamble(workspace)}${prompt}`,
		workspace,
		permission: options.permission,
		model: options.model,
		provider: options.provider,
		timeoutSeconds: options.timeout,
		expectedSeconds,
		acceptance: options.acceptance,
		caller: options.caller ?? 'cli',
		label: options.label,
	});
	process.stderr.write(`dsh-subagent: job ${started.id} → workspace ${workspace}(实时目录 ${started.dir})\n`);
	process.stderr.write(`dsh-subagent: caller=${started.record.caller} expected_seconds=${expectedSeconds} deadline=${started.record.deadlineAt}\n`);

	const state = await started.done;
	if (options.json) {
		process.stdout.write(`${JSON.stringify({
			job_id: state.id,
			status: state.status,
			ok: state.status === 'ok',
			caller: state.caller ?? 'unknown',
			caller_version: state.callerVersion ?? null,
			workspace: state.workspace,
			expected_seconds: state.expectedSeconds ?? expectedSeconds,
			acceptance: state.acceptance ?? null,
			deadline_at: state.deadlineAt ?? null,
			session_id: state.sessionId,
			model: state.modelUsed,
			permission: state.permission,
			duration_ms: state.durationMs,
			exit_code: state.exitCode,
			error: state.error,
			result: state.result ?? '',
			result_file: state.paths?.resultFile,
			stderr_log: state.paths?.stderrPath,
			task_dir: state.taskDir ?? started.dir,
		}, null, 2)}\n`);
	} else if (state.status === 'ok') {
		process.stdout.write(`${state.result ?? ''}\n`);
	} else {
		process.stderr.write(`dsh-subagent: 任务未成功(${state.status}): ${state.error ?? '未知原因'}\n`);
		process.stderr.write(`dsh-subagent: 详见 ${state.taskDir}\n`);
	}
	return state.status === 'ok' ? 0 : 1;
}

main().then((code) => {
	process.exitCode = code;
}, (error) => {
	process.stderr.write(`dsh-subagent: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
	process.exitCode = 1;
});
