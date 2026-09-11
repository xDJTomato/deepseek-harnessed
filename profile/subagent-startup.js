/**
 * dsh-subagent 的启动插件:解析一次性任务与本次调用的元信息。
 *
 * 任务来源优先级:--prompt(argv) > --prompt-stdin(标准输入) > --prompt-file > 位置参数。
 *
 * 为什么默认走 stdin:提示词走管道,两侧都不落盘 —— 既不依赖"临时文件能被另一个进程
 * 原样读到"这个假设,也不受命令行长度上限约束。
 * (`--prompt-file` 只是给人工排查用的兜底入口。)
 *
 * @module dsh-subagent/profile/subagent-startup
 */
import { readFileSync } from 'node:fs';
import { Command } from 'commander';
import { parseCmdline } from '@deepseek-ai/dsh-cmdline';

/** 稳定的 Cordis 插件名。 */
export const name = 'subagent-startup';

/** 任务解析前必须先就绪的服务:启动器交下来的不可变命令行快照。 */
export const inject = ['cmdlineArgs'];

/** 本插件发布的服务名,runner 通过它读取配置。 */
export const SUBAGENT_STARTUP_SERVICE = 'subagentStartup';

/** stdin 读取上限,防止异常输入把内存吃满(默认 16MB)。 */
const STDIN_LIMIT = Number(process.env.DSH_SUBAGENT_STDIN_LIMIT ?? 16 * 1024 * 1024);

/**
 * 本 app 自己的命令定义。
 * @returns 每次调用都新建的 program(便于同一进程内重复解析)。
 */
function subagentCommand() {
	return new Command()
		.name('dsh --profile subagent')
		.description('在指定工作空间(cwd)里执行一轮任务,把最终答复写到 stdout 与 --result-file 后退出。')
		.helpOption('-h, --help', '显示本帮助')
		.option('--prompt <text>', '任务提示词(适合短任务)')
		.option('--prompt-stdin', '从标准输入读取任务提示词(推荐:不受长度限制,也不落盘)')
		.option('--prompt-file <path>', '从 UTF-8 文件读取任务提示词(人工排查用;正常调用请走 stdin/argv)')
		.option('--result-file <path>', '把最终答复同时写入该文件(便于调用方精确取回)')
		.option('--metadata-file <path>', '把 sessionId / 模型 / 停止原因 / 耗时写成 JSON')
		.option('--provider <id>', '本次调用使用的模型提供方(默认沿用 DSH 设置)')
		.option('--model <id>', '本次调用使用的模型(默认沿用 DSH 设置)')
		.option('--reasoning-effort <id>', '本次调用的推理强度')
		.argument('[task...]', '任务提示词;多个词以空格拼接(等价于 --prompt)')
		.addHelpText('after', `
Examples:
  dsh --profile subagent --prompt-file C:\\path\\task.md --result-file C:\\path\\result.txt
  type task.md | dsh --profile subagent --prompt-stdin
  dsh --profile subagent --prompt "run the tests" --model deepseek-v4-pro
`);
}

/**
 * 异步读完 stdin(UTF-8)。
 * @returns 输入全文;超过上限或被中断时抛出。
 */
function readStdin() {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		process.stdin.on('data', (chunk) => {
			size += chunk.length;
			if (size > STDIN_LIMIT) {
				reject(new Error(`stdin 超过 ${STDIN_LIMIT} 字节上限`));
				process.stdin.destroy();
				return;
			}
			chunks.push(chunk);
		});
		process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
		process.stdin.on('error', (error) => reject(error));
		process.stdin.resume();
	});
}

/**
 * 解析任务并把 `subagentStartup` 服务发布出去。
 * 需要读 stdin 时,服务在读完 EOF 之后才发布 —— runner 通过惰性配置等待它,
 * 因此不会抢跑。空白任务属于用法错误。
 * @param ctx - 携带命令行快照的插件上下文。
 */
export function apply(ctx) {
	const program = subagentCommand();
	program.action(() => {
		const options = program.opts();
		const publish = (task) => {
			if (typeof task !== 'string' || task.trim() === '') {
				program.error('error: 需要一个任务提示词:--prompt / --prompt-stdin / --prompt-file / 位置参数');
				return;
			}
			ctx.provide(SUBAGENT_STARTUP_SERVICE, {
				task,
				resultFile: typeof options.resultFile === 'string' ? options.resultFile : '',
				metadataFile: typeof options.metadataFile === 'string' ? options.metadataFile : '',
				provider: typeof options.provider === 'string' ? options.provider : '',
				model: typeof options.model === 'string' ? options.model : '',
				reasoningEffort: typeof options.reasoningEffort === 'string' ? options.reasoningEffort : '',
			});
		};

		if (typeof options.prompt === 'string' && options.prompt.trim() !== '') {
			publish(options.prompt);
			return;
		}
		if (options.promptStdin === true) {
			readStdin().then(publish, (error) => {
				process.stderr.write(`dsh: 读取 stdin 失败: ${error instanceof Error ? error.message : String(error)}\n`);
				process.exit(1);
			});
			return;
		}
		if (typeof options.promptFile === 'string' && options.promptFile.trim() !== '') {
			try {
				publish(readFileSync(options.promptFile, 'utf8'));
			} catch (error) {
				program.error(`error: 无法读取 --prompt-file ${JSON.stringify(options.promptFile)}: ${error instanceof Error ? error.message : String(error)}`);
			}
			return;
		}
		publish(program.args.join(' '));
	});
	parseCmdline(ctx, program);
}
