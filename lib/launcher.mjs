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
import { basename, delimiter, dirname, join, resolve } from 'node:path';

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

/** 参数里形如 `*.js` / `*.mjs` 的启动入口。 */
const ENTRY_RE = /\.m?js$/i;

/**
 * 校验垫片里的入口文件是否还在;不在就按候选清单自愈改指,全都不是则抛出这个候选的失败原因。
 *
 * 为什么需要:**垫片是一次性产物,DSH Desktop 更新不会重写它**。实测(2026-09-18)Desktop
 * 换过打包形态,入口从 `resources\app.asar\lib\desktop-cli.js` 变成 `resources\app\lib\desktop-cli.js`,
 * 垫片仍指旧路径 ⇒ 每次经垫片调 dsh 都在 0.8 秒内 `Cannot find module` + exit 1,
 * 表现为"派活静默失败"。旧代码不校验入口存在性,故障就以底层 MODULE_NOT_FOUND 冒出来,
 * 这里把它收敛成一处:能自愈就自愈;不能自愈就把原因交回调用方 —— 由它继续试下一个候选,
 * 全都失败时再聚合上报(一个残留的陈旧垫片不该埋掉本机其它可用的 dsh)。
 *
 * @param shim - 垫片路径(报错里要写明)。
 * @param command - 垫片里的可执行文件;`dirname` 即安装根。
 * @param args - 垫片里的固定参数。
 * @returns 入口修好后的参数数组(顺序不变);无从自愈时抛错。
 */
function repairEntryPoint(shim, command, args) {
	const index = args.findIndex((arg) => ENTRY_RE.test(arg));
	if (index < 0) return args; // 垫片里没有入口参数,不掺和
	const entry = args[index];
	if (existsSync(entry)) return args;
	const root = dirname(command);
	const base = basename(entry);
	const candidates = [
		join(root, 'resources', 'app', 'lib', base),
		join(root, 'resources', 'app.asar', 'lib', base),
		join(root, 'resources', 'app.asar.unpacked', 'lib', base),
	];
	// 缺失路径上把 app.asar ↔ app 互换(比上面三条更贴近垫片原本写的结构:exe 不在安装根时靠它命中)
	if (entry.includes('app.asar')) candidates.push(entry.replace(/app\.asar(?!\.unpacked)/g, 'app'));
	if (/[\\/]app[\\/]/.test(entry)) candidates.push(entry.replace(/([\\/])app([\\/])/g, '$1app.asar$2'));
	const tried = [...new Set(candidates)];
	const healed = tried.find((candidate) => existsSync(candidate));
	if (healed !== undefined) {
		const fixed = [...args];
		fixed[index] = healed;
		return fixed;
	}
	throw new Error(
		`垫片 ${shim} 里的入口文件不存在: ${entry}\n`
		+ `    已尝试的候选(都不存在): ${tried.join(' | ')}`,
	);
}

/**
 * 解析出一次 dsh 调用所需的命令、固定参数与环境变量。
 * @returns {{command:string,args:string[],env:Record<string,string>,shim:string,describe:string}}
 */
export function resolveLauncher() {
	const candidates = shimCandidates();
	/** 入口失效且无从自愈的垫片:先记下来,继续试后面的候选;一个都用不上时再聚合报错。 */
	const broken = [];
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
		let parsed;
		try {
			parsed = parseShim(candidate);
		} catch (error) {
			// 换下一个候选;全都失败时在下面统一报错
			void error;
			continue;
		}
		let args;
		try {
			args = repairEntryPoint(candidate, parsed.command, parsed.fixedArgs);
		} catch (error) {
			// 这个候选的入口失效了:记下原因,接着试下一个(候选里能自愈一个就算成功)
			broken.push(error.message);
			continue;
		}
		return {
			command: parsed.command,
			args,
			env: parsed.env,
			shim: candidate,
			describe: `${candidate} → ${parsed.command} ${args.join(' ')}`,
		};
	}
	if (broken.length > 0) throw new Error(aggregateError(broken, candidates));
	throw new Error(
		'找不到 dsh 启动器。请确认 DSH Desktop 已安装,或设置环境变量 DSH_SUBAGENT_DSH_SHIM 指向 dsh.cmd。'
		+ `已尝试: ${candidates.slice(0, 6).join(' | ')}`,
	);
}

/** 所有候选都不行时的那一条聚合错误:结论 + 逐条原因 + 处置办法。 */
function aggregateError(broken, candidates) {
	return `dsh 启动器不可用:找到的 ${broken.length} 个垫片,入口文件都已失效,且附近都没有可替代的位置。\n`
		+ broken.map((message, index) => `  [${index + 1}] ${message.replace(/\n/g, '\n      ')}`).join('\n')
		+ '\n  原因: 这类垫片是安装时生成的,DSH Desktop 更新后不会自动重写(打包入口在 resources\\app.asar 与 resources\\app 之间换过位置)。\n'
		+ '  处置: 修垫片里的入口 / 删掉失效垫片让 DSH Desktop 重建 / 用 DSH_SUBAGENT_DSH_SHIM 显式指向可用的 dsh.cmd。\n'
		+ `  已尝试的垫片: ${candidates.slice(0, 6).join(' | ')}`;
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
