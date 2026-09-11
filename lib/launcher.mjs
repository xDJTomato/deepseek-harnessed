/**
 * 定位本机的 `dsh` 启动器。
 *
 * 本机(DSH Desktop)的 `dsh` 是一个 cmd 垫片:
 *   set "ELECTRON_RUN_AS_NODE=1"
 *   set "DSH_HOME=C:\\Users\\<you>\\.dsh"
 *   "C:\\Program Files\\DSH Desktop\\DSH Desktop.exe" --expose-internals "<...>\\app.asar\\lib\\desktop-cli.js" %*
 *
 * 直接解析这个垫片、再以 `exe + 参数数组` 方式 spawn,可以避免走 cmd.exe
 * 带来的引号/特殊字符转义问题,同时保持与 `dsh` 命令完全一致的行为。
 *
 * @module dsh-subagent/lib/launcher
 */
import { existsSync, readFileSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';

/** 解析 cmd 垫片里的 `set "K=V"` 赋值。 */
const SET_RE = /^\s*set\s+"?([^"=]+)=([^"]*)"?\s*$/i;

/** 把一行命令行拆成 token(支持双引号包裹)。 */
function tokenize(line) {
	const tokens = [];
	const re = /"([^"]*)"|(\S+)/g;
	let match;
	while ((match = re.exec(line)) !== null) tokens.push(match[1] !== undefined ? match[1] : match[2]);
	return tokens;
}

/** 候选垫片路径(按优先级)。 */
function shimCandidates() {
	const list = [];
	const explicit = process.env.DSH_SUBAGENT_DSH_SHIM;
	if (typeof explicit === 'string' && explicit.trim() !== '') list.push(resolve(explicit.trim()));
	const appData = process.env.APPDATA;
	if (typeof appData === 'string' && appData !== '') {
		list.push(join(appData, 'DSH Desktop', 'host-commands', 'desktop', 'bin', 'dsh.cmd'));
	}
	for (const entry of (process.env.PATH ?? '').split(delimiter)) {
		if (entry === '') continue;
		list.push(join(entry, 'dsh.cmd'));
		list.push(join(entry, 'dsh.exe'));
	}
	return list;
}

/** 解析一个 cmd 垫片,得到可直接 spawn 的命令与固定参数。 */
function parseShim(path) {
	const content = readFileSync(path, 'utf8');
	const env = {};
	let command = '';
	let fixedArgs = [];
	for (const rawLine of content.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (line === '' || line.startsWith('@') || line.startsWith('::') || line.startsWith('rem ')) continue;
		const setMatch = SET_RE.exec(line);
		if (setMatch !== null) {
			env[setMatch[1].trim()] = setMatch[2];
			continue;
		}
		if (!line.includes('%*')) continue;
		const tokens = tokenize(line.replace(/%\*/g, ' ').trim());
		if (tokens.length === 0) continue;
		command = tokens[0];
		fixedArgs = tokens.slice(1);
	}
	if (command === '') throw new Error(`无法从 ${path} 解析出 dsh 启动命令`);
	return { command, fixedArgs, env };
}

/**
 * 解析出一次 dsh 调用所需的命令、固定参数与环境变量。
 * @returns {{command:string,args:string[],env:Record<string,string>,shim:string,describe:string}}
 */
export function resolveLauncher() {
	const candidates = shimCandidates();
	for (const candidate of candidates) {
		if (!existsSync(candidate)) continue;
		if (candidate.toLowerCase().endsWith('.exe')) {
			return {
				command: candidate,
				args: [],
				env: {},
				shim: candidate,
				describe: `${candidate} (直接可执行文件)`,
			};
		}
		try {
			const { command, fixedArgs, env } = parseShim(candidate);
			return {
				command,
				args: fixedArgs,
				env,
				shim: candidate,
				describe: `${candidate} → ${command} ${fixedArgs.join(' ')}`,
			};
		} catch (error) {
			// 换下一个候选;全都失败时在下面统一报错
			void error;
		}
	}
	throw new Error(
		'找不到 dsh 启动器。请确认 DSH Desktop 已安装,或设置环境变量 DSH_SUBAGENT_DSH_SHIM 指向 dsh.cmd。'
		+ `已尝试: ${candidates.slice(0, 6).join(' | ')}`,
	);
}

/**
 * 组装子进程环境:垫片里的赋值(ELECTRON_RUN_AS_NODE / DSH_HOME …)+ 本次调用的覆盖。
 * @param launcher - resolveLauncher() 的结果。
 * @param overrides - 需要覆盖的环境变量。
 */
export function childEnv(launcher, overrides = {}) {
	const env = { ...process.env, ...launcher.env };
	// DSH_HOME:本次进程显式设置优先,其次垫片里的值。
	if (typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim() !== '') env.DSH_HOME = process.env.DSH_HOME;
	for (const [key, value] of Object.entries(overrides)) {
		if (value === undefined || value === null || value === '') delete env[key];
		else env[key] = String(value);
	}
	return env;
}
