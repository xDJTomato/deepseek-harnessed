#!/usr/bin/env node
/**
 * dsh-subagent 安装器:一条命令完成本机全部装配,可重复执行。
 *
 *   1. 把 profile/ 同步到 <DSH_HOME>/profiles/subagent;
 *   2. 在 PATH 上放 dsh-subagent / dsh-subagent-mcp 包装脚本;
 *   3. 把 MCP server 注册进本机所有已安装 harness 的配置(Cursor /
 *      Claude Code / Claude Desktop / Codex / Gemini CLI / Antigravity /
 *      Kiro / Qoder / VS Code(Copilot)/ opencode);
 *   4. 写入「委托优先走 DSH」的全局指令与 Claude Code 子代理定义,
 *      让这些 harness 的内置 subagent 实际转调 DSH 实例。
 *
 * 所有写入都是幂等 + 先备份(.bak-dshsubagent-<时间戳>)。
 *
 * 用法:
 *   node install.mjs [--dry-run] [--only cursor,claude,codex]
 *
 * @module dsh-subagent/install
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { BRIDGE_ROOT, dshHome, ensureDir } from './lib/util.mjs';
import { childEnv, resolveLauncher } from './lib/launcher.mjs';

const NODE = process.execPath;
const MCP_ENTRY = join(BRIDGE_ROOT, 'bin', 'dsh-subagent-mcp.mjs');
const CLI_ENTRY = join(BRIDGE_ROOT, 'bin', 'dsh-subagent.mjs');
const HOME = homedir();
const APPDATA = process.env.APPDATA ?? join(HOME, 'AppData', 'Roaming');
const LOCALAPPDATA = process.env.LOCALAPPDATA ?? join(HOME, 'AppData', 'Local');
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');

const dryRun = process.argv.includes('--dry-run');
/** --only=a,b 与 --only a,b 两种写法都支持。 */
function parseOnly(argv) {
	const inline = argv.find((arg) => arg.startsWith('--only='));
	if (inline !== undefined) return inline.split('=')[1];
	const index = argv.indexOf('--only');
	return index >= 0 ? argv[index + 1] : undefined;
}
const onlyList = parseOnly(process.argv);
const only = onlyList === undefined
	? null
	: new Set(onlyList.split(',').map((item) => item.trim()).filter(Boolean));

const actions = [];

/** 记录一条动作(并真正写盘,除非 --dry-run)。 */
function act(kind, target, detail) {
	actions.push({ kind, target, detail });
	if (dryRun) return;
	process.stdout.write(`  ✓ ${kind}: ${target}${detail === undefined ? '' : ` — ${detail}`}\n`);
}

/** 备份已有文件(同名只备份一次)。 */
function backup(path) {
	if (!existsSync(path)) return;
	const bak = `${path}.bak-dshsubagent-${STAMP}`;
	if (dryRun) return;
	copyFileSync(path, bak);
}

/** 读 JSON(容错;失败返回 fallback)。 */
function readJson(path, fallback) {
	try {
		return JSON.parse(readFileSync(path, 'utf8'));
	} catch {
		return fallback;
	}
}

/** 写 JSON。 */
function writeJsonFile(path, value) {
	ensureDir(dirname(path));
	backup(path);
	if (dryRun) return;
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/**
 * 标记块之间是否混进了**不属于本块**的条目。
 *
 * DSH 自己改写 profile patch(改设置、0.1.7 的 settings.yaml 导入)时是把整个文件重新
 * 序列化:文件末尾那行 `# <<< ... <<<` 结束标记会被重新挂到**文件最后**,于是漂到
 * 文件尾、把你自己的 profile 条目(desktop-shell / llm-pi-ai / ui-settings-general …)
 * 圈进受管块里。此时若照常 `slice(start, stop)` 重写,这些条目会被整段删掉。
 * 2026-09-29 实测过一次;这里的守卫把"静默删配置"变成一条可见的 skip。
 */
function hasForeignEntry(interior) {
	return interior
		.split('\n')
		.some((line) => line.startsWith('- ') && !line.startsWith('- insert:'));
}

/**
 * 只有 YAML 片段(`- insert:` 那种 profile patch 块)才做漂移检查:
 * CLAUDE.md / AGENTS.md 的块是 markdown,正文里本来就有 `- ` 开头的列表项,
 * 用同一套判据会误报(2026-09-29 实测过一次)。
 */
function isYamlBlock(body) {
	return body.includes('- insert:');
}

/** 幂等地把一段带标记文本写进文件(保留原有内容)。 */
function upsertMarkedBlock(path, begin, end, body) {
	const existing = existsSync(path) ? readFileSync(path, 'utf8') : '';
	const start = existing.indexOf(begin);
	const block = `${begin}\n${body.trim()}\n${end}\n`;
	let next;
	if (start >= 0) {
		const stop = existing.indexOf(end, start);
		if (stop < 0) next = `${existing.trimEnd()}\n\n${block}`;
		else if (isYamlBlock(body) && hasForeignEntry(existing.slice(start + begin.length, stop))) {
			act('skip', path, `${end} 已漂移(块内混入其它条目),拒绝重写以免删掉你的配置;请把该结束标记移回块尾`);
			return false;
		} else next = `${existing.slice(0, start)}${block}${existing.slice(stop + end.length + 1)}`;
	} else {
		next = existing.trim() === '' ? block : `${existing.trimEnd()}\n\n${block}`;
	}
	if (next === existing) return false;
	ensureDir(dirname(path));
	backup(path);
	if (!dryRun) writeFileSync(path, next, 'utf8');
	return true;
}

/** 统一的 stdio 服务器描述(按各客户端方言生成)。 */
function serverEntry(style) {
	if (style === 'vscode') return { type: 'stdio', command: NODE, args: [MCP_ENTRY], env: {} };
	if (style === 'opencode') return { type: 'local', command: [NODE, MCP_ENTRY], enabled: true };
	if (style === 'codex') return null; // TOML,单独处理
	return { command: NODE, args: [MCP_ENTRY], env: {} };
}

/** 注册到 `{"<key>": {"mcpServers"|"servers": {...}}}` 形式的 JSON 配置。 */
function registerJsonClient({ name, path, key, style = 'default', create = true }) {
	if (only !== null && !only.has(name)) return;
	if (!existsSync(path)) {
		if (!create) {
			actions.push({ kind: 'skip', target: path, detail: `${name}: 未安装,跳过` });
			return;
		}
		writeJsonFile(path, { [key]: { dsh: serverEntry(style) } });
		act('register', `${name} → ${path}`, `${key}.dsh(新建)`);
		return;
	}
	// 安全闸:已有文件但解析失败时绝不覆盖用户配置。
	const raw = readFileSync(path, 'utf8');
	let file;
	try {
		file = JSON.parse(raw);
	} catch (error) {
		actions.push({ kind: 'fail', target: path, detail: `${name}: 现有 JSON 无法解析(${error.message}),已跳过,未改动` });
		process.stdout.write(`  ⚠ 跳过 ${path}:现有 JSON 无法解析,未做任何改动\n`);
		return;
	}
	if (file === null || typeof file !== 'object' || Array.isArray(file)) {
		actions.push({ kind: 'fail', target: path, detail: `${name}: 顶层不是对象,已跳过` });
		return;
	}
	const container = file[key] !== null && typeof file[key] === 'object' ? file[key] : {};
	container.dsh = serverEntry(style);
	file[key] = container;
	writeJsonFile(path, file);
	act('register', `${name} → ${path}`, `${key}.dsh`);
}

/** 注册 Codex 的 config.toml(TOML 段落级 upsert)。 */
function registerCodex() {
	const path = join(HOME, '.codex', 'config.toml');
	if (only !== null && !only.has('codex')) return;
	if (!existsSync(path)) {
		actions.push({ kind: 'skip', target: path, detail: 'codex: 未安装,跳过' });
		return;
	}
	const section = [
		'[mcp_servers.dsh]',
		`command = ${JSON.stringify(NODE)}`,
		`args = [${JSON.stringify(MCP_ENTRY)}]`,
		'startup_timeout_sec = 60',
		// Codex 的单次工具调用默认超时是 60s,而委派动辄几分钟:到点会被先掐断,掐断时发的
		// notifications/cancelled 还会被桥接层当成"调用方停了这一轮"而杀掉正在跑的任务。
		// 这一行必须与 README §2 的推荐值一致 —— 以前安装器不写它,用户手写的那行会在
		// 下一次重跑时被整块覆盖掉,坑原样复发。
		'tool_timeout_sec = 600',
	].join('\n');
	const text = readFileSync(path, 'utf8');
	const lines = text.split(/\r?\n/);
	const start = lines.findIndex((line) => line.trim() === '[mcp_servers.dsh]');
	let next;
	if (start < 0) {
		next = `${text.trimEnd()}\n\n${section}\n`;
	} else {
		let stop = start + 1;
		while (stop < lines.length && !/^\s*\[/.test(lines[stop])) stop += 1;
		// 现有的块已经写全了要求的那几行(允许夹注释、顺序不同)⇒ 一个字都不动:
		// 否则重跑会把手写的说明注释一起吞掉,还可能覆盖掉用户自己调过的值。
		const present = lines.slice(start, stop).map((line) => line.trim());
		next = section.split('\n').map((line) => line.trim()).every((line) => present.includes(line))
			? text
			: [...lines.slice(0, start), ...section.split('\n'), '', ...lines.slice(stop)].join('\n');
	}
	if (next === text) {
		actions.push({ kind: 'ok', target: path, detail: 'mcp_servers.dsh 已存在' });
		return;
	}
	backup(path);
	if (!dryRun) writeFileSync(path, next, 'utf8');
	act('register', `codex → ${path}`, 'mcp_servers.dsh');
}

// 标记必须**原样只出现在块的首尾**:注释里若把这一串复述一遍,indexOf 会先撞上注释那份,
// 于是从注释中间开始切片、把模板正文截断(2026-10-08 实测踩过)。所以按整行匹配。
const PROVIDERS_BEGIN = '# >>> dsh-subagent-llm-providers >>>';
const PROVIDERS_END = '# <<< dsh-subagent-llm-providers <<<';
// 叶子 profile 必须自带这两条:服务商,以及默认模型(不指定模型的 dsh_task 靠它)。
const ENTRY_IDS = ['llm-pi-ai', 'agent-default-model'];

/**
 * 从一份 profile patch 里抽出 `- id: <id>` 那个条目的所有行(含它的缩进子块),
 * 并把缩调整平成"放进 `- insert:` 下再缩进 4 格"的形状 —— 也就是仓库模板里它原来的位置。
 * 抽不到返回 null(此时不猜、不兜底,由调用方明确报出来)。
 */
function extractEntry(text, id) {
	const lines = text.split(/\r?\n/);
	const isEntry = (line) => {
		const trimmed = line.trim();
		return trimmed.startsWith('- id:') && trimmed.slice(5).trim() === id;
	};
	const start = lines.findIndex(isEntry);
	if (start < 0) return null;
	const indentOf = (line) => line.length - line.trimStart().length;
	const base = indentOf(lines[start]);
	const out = [];
	for (let index = start; index < lines.length; index += 1) {
		const line = lines[index];
		// 下一条同级条目(或缩进更浅的任何行)就是这一条的边界
		if (index > start && line.trim() !== '' && indentOf(line) <= base) break;
		out.push(line.trim() === '' ? '' : `    ${line.slice(base)}`);
	}
	return `${out.join('\n').replace(/\s+$/, '')}\n`;
}

/**
 * 叶子 profile 需要的本机模型配置从哪来:`llm-pi-ai`(服务商)与 `agent-default-model`(默认模型)。
 *
 * 0.1.7-rc.2 起设置由插件 Config schema 派生、配置变成 **per-profile**:旧的 `$DSH_HOME/settings.yaml`
 * 被一次性导入后改名 `settings.yaml.imported`,desktop profile 拿到了这两个条目,而**叶子 profile
 * (`dsh --profile subagent`)没有** —— 子进程于是既解析不到服务商、也拿不到默认模型,dsh_task 一起来
 * 就报 `no adapter registered for provider …`,不指定模型时还会 `DeepSeek request extension preparation
 * failed`(2026-10-08 实测)。这两段配置带着内网网关地址与密钥环境变量名,是**机器本地**信息,不能进
 * 公开仓库,所以仓库里只留说明、安装时从本机自己的配置里抽出来,写进
 * `$DSH_HOME/profiles/subagent/cordis.patch.yml`(仓库之外)的标记块。
 *
 * 取用顺序:显式指定的片段(整份当这段用)→ `$DSH_HOME/llm-providers.patch.yml`(自己放的)→
 * 逐条目从本机已有配置里抽:desktop profile 的 patch → home 层 → settings.yaml.imported →
 * settings.yaml(0.1.7 之前的位置)。一个条目都抽不到时 body=null,调用方给可见告警,不静默。
 */
function leafModelConfigSource() {
	const explicit = process.env.DSH_SUBAGENT_PROVIDERS_FILE;
	if (typeof explicit === 'string' && explicit.trim() !== '') {
		const path = resolve(explicit.trim());
		const text = existsSync(path) ? readFileSync(path, 'utf8') : '';
		return text.trim() === ''
			? { body: null, from: [], missing: ENTRY_IDS, why: `DSH_SUBAGENT_PROVIDERS_FILE 指向的 ${path} 不存在或为空` }
			: { body: text.trim(), from: [path], missing: [] };
	}
	const local = join(dshHome(), 'llm-providers.patch.yml');
	if (existsSync(local)) {
		const text = readFileSync(local, 'utf8');
		if (text.trim() !== '') return { body: text.trim(), from: [local], missing: [] };
	}
	const sources = [
		join(dshHome(), 'profiles', 'desktop', 'cordis.patch.yml'),
		join(dshHome(), 'cordis.patch.yml'),
		join(dshHome(), 'settings.yaml.imported'),
		join(dshHome(), 'settings.yaml'),
	];
	const blocks = [];
	const from = [];
	const missing = [];
	for (const id of ENTRY_IDS) {
		let found = false;
		for (const path of sources) {
			if (!existsSync(path)) continue;
			const entry = extractEntry(readFileSync(path, 'utf8'), id);
			if (entry === null) continue;
			blocks.push(`- insert:\n${entry}`);
			from.push(`${id} ← ${path}`);
			found = true;
			break;
		}
		if (!found) missing.push(id);
	}
	if (blocks.length === 0) {
		return { body: null, from, missing, why: `这几处都没有 ${ENTRY_IDS.join(' / ')} 条目: ${sources.join(' / ')}` };
	}
	return { body: blocks.join('\n'), from, missing };
}

/** 摘掉本机注入的 provider 块后剩下的 patch 正文(用来判断模板是否真需要同步)。 */
function stripProviderBlock(text) {
	const lines = text.split('\n');
	const start = lines.findIndex((line) => line.trim() === PROVIDERS_BEGIN);
	if (start < 0) return text.trim();
	const stop = lines.findIndex((line, index) => index > start && line.trim() === PROVIDERS_END);
	const kept = stop < 0 ? lines.slice(0, start) : [...lines.slice(0, start), ...lines.slice(stop + 1)];
	return kept.join('\n').trim();
}

/** 把本机模型配置(服务商 + 默认模型)注入 subagent profile 的标记块(取值只落在本机文件)。 */
function installProviders(patchPath) {
	const source = leafModelConfigSource();
	if (source.body === null) {
		process.stdout.write(`  ⚠ 叶子模型配置没注入:${source.why}\n`
			+ '     (dsh_task 会报 no adapter registered for provider … 或 DeepSeek request extension preparation failed;'
			+ `把自己的 patch 片段放到 ${join(dshHome(), 'llm-providers.patch.yml')}`
			+ ' 或用 DSH_SUBAGENT_PROVIDERS_FILE 指定,然后重跑 install)\n');
		return;
	}
	if (upsertMarkedBlock(patchPath, PROVIDERS_BEGIN, PROVIDERS_END, source.body)) {
		act('providers', patchPath, `${source.from.join(' / ')}(本机配置,不入仓库)`);
	}
	if (source.missing.length > 0) {
		process.stdout.write(`  ⚠ 本机配置里没有 ${source.missing.join(' / ')} —— 叶子会缺这一段`
			+ '(缺 agent-default-model 时,不指定模型的 dsh_task 会直接失败)\n');
	}
}

/** 1. 同步 DSH profile。 */
function installProfile() {
	const source = join(BRIDGE_ROOT, 'profile');
	const target = join(dshHome(), 'profiles', 'subagent');
	if (only !== null && !only.has('profile')) return;
	ensureDir(target);
	for (const file of ['package.json', 'cordis.patch.yml', 'subagent-startup.js', 'subagent-runner.js', 'subagent-models.js']) {
		const from = join(source, file);
		const to = join(target, file);
		// cordis.patch.yml 的比对要先摘掉本机注入的 provider 块:否则每次 install 都
		// "先删再写",白报一次同步,还留一个 provider 短暂缺失的窗口。
		const changed = !existsSync(to) || (file === 'cordis.patch.yml'
			? stripProviderBlock(readFileSync(to, 'utf8')) !== readFileSync(from, 'utf8').trim()
			: readFileSync(from, 'utf8') !== readFileSync(to, 'utf8'));
		if (!changed) continue;
		if (!dryRun) copyFileSync(from, to);
		act('profile', to, '已同步');
	}
	// provider 配置(含内网地址与密钥名)不进仓库,装的时候从本机自己的配置里取出来注入。
	installProviders(join(target, 'cordis.patch.yml'));
	if (!dryRun && existsSync(target)) process.stdout.write(`  ✓ profile: ${target}\n`);
	if (!dryRun) verifyLeafGate();
}

/**
 * 叶子闸门自检:外部经 dsh_task 调进来的任务**不允许再分叉**,靠被禁用的那几行实现。
 * 配置写对了不等于生效(实测踩过:patch 只改了仓库里的副本没同步 → dump 里还是启用),
 * 所以这里直接问 `dsh --profile subagent --dump-config` 要最终生效值。
 * 同一份 dump 里顺带验 provider 有没有解析到(installProviders 注入的是本机私有配置,
 * 注入失败时叶子一起来就报 no adapter registered for provider …,必须当场看得见)。
 */
function verifyLeafGate() {
	const gate = [
		'tool-subagent',
		'tool-subagent-fork',
		'tool-workflow',
		'workflow-worker-thread',
		'tool-ralph',
		'tool-subagent-control',
		'tool-subagent-list-agents',
	];
	let dump = '';
	try {
		const launcher = resolveLauncher();
		const result = spawnSync(launcher.command, [...launcher.args, '--profile', 'subagent', '--dump-config'], {
			encoding: 'utf8',
			env: childEnv(launcher),
			maxBuffer: 64 * 1024 * 1024,
			timeout: 120000,
		});
		dump = result.stdout ?? '';
	} catch (error) {
		process.stdout.write(`  ⚠ 叶子闸门自检跳过(拿不到生效配置): ${error.message}\n`);
		return;
	}
	if (dump.trim() === '') {
		process.stdout.write('  ⚠ 叶子闸门自检跳过(dump-config 无输出)\n');
		return;
	}
	const lines = dump.split(/\r?\n/);
	const rows = new Map();
	for (let index = 0; index < lines.length; index += 1) {
		const match = /^-\s+id:\s*(\S+)\s*$/.exec(lines[index]);
		if (match === null) continue;
		let block = '';
		for (let cursor = index; cursor < Math.min(index + 14, lines.length); cursor += 1) {
			if (cursor > index && /^-\s+id:/.test(lines[cursor])) break;
			block += lines[cursor] + '\n';
		}
		rows.set(match[1], !/disabled:\s*true/.test(block));
	}
	// 只有"在配置树里存在且没被 disabled"才算漏。条目根本不存在 = 没挂载 = 无从分叉 ——
	// DSH 2.0.15 的树里已经没有 workflow-worker-thread 了,按旧判据会永远误报一条 ❌。
	const leaked = gate.filter((id) => rows.get(id) === true);
	const absent = gate.filter((id) => rows.get(id) === undefined);
	if (leaked.length === 0) {
		process.stdout.write(`  ✓ 叶子闸门:${gate.length} 条分叉通道已在 subagent profile 上关闭`
			+ (absent.length > 0 ? `(${absent.join(', ')} 不在当前 DSH 的配置树里,本来就没挂载)` : '')
			+ '(外部 dsh_task 不能再生子代理;DSH 自己内部的原生 subagent 不受影响)\n');
	} else {
		process.stdout.write(`  ❌ 叶子闸门没生效,仍然启用: ${leaked.join(', ')}\n`
			+ '     (外部任务将能继续分叉。检查 $DSH_HOME/profiles/subagent/cordis.patch.yml 是否为本仓库的最新副本)\n');
	}
	// provider 与默认模型也拿同一份 dump 验:本机私有配置注入到位了没有,只有生效值说了算(取值不打印)。
	const hasProviders = /^[ \t]+providers:\s*$/m.test(dump) && /\bid:\s*llm-pi-ai\b/.test(dump);
	const hasDefault = /\bid:\s*agent-default-model\b/.test(dump);
	if (hasProviders && hasDefault) {
		process.stdout.write('  ✓ 叶子模型配置:subagent profile 已解析到 llm-pi-ai 的 providers 与 agent-default-model'
			+ '(本机私有配置,取值不打印、不入仓库)\n');
	} else {
		process.stdout.write(`  ❌ 叶子模型配置不全(${hasProviders ? '' : 'providers '}${hasDefault ? '' : 'agent-default-model '}缺)—— `
			+ '外部任务会报 no adapter registered for provider … 或 DeepSeek request extension preparation failed\n'
			+ '     (重跑 node install.mjs 从本机 desktop profile 的 patch 注入)\n');
	}
}

/**
 * 1b. GUI 观察器:让 DSH Desktop 的会话列表实时显示"被外部 harness 激活的 subagent 任务"。
 *
 * 做法是把 monitor/observer.mjs 同步到 $DSH_HOME/subagent/monitor/,并在 desktop profile 的
 * patch 层里插入一条被标记包住的 insert 条目(标记之间的内容由本脚本托管,可重复执行)。
 * 该 profile 是 patchReload: live,但实测打包版不会热应用 patch 文件,所以首次安装后需要
 * 重启一次 DSH Desktop;之后自动生效。
 */
function installObserver() {
	if (only !== null && !only.has('observer')) return;
	const source = join(BRIDGE_ROOT, 'monitor', 'observer.mjs');
	if (!existsSync(source)) return;
	const target = join(dshHome(), 'subagent', 'monitor', 'observer.mjs');
	if (!existsSync(target) || readFileSync(source, 'utf8') !== readFileSync(target, 'utf8')) {
		if (!dryRun) {
			ensureDir(dirname(target));
			copyFileSync(source, target);
		}
		act('observer', target, '已同步');
	}
	const patchPath = join(dshHome(), 'profiles', 'desktop', 'cordis.patch.yml');
	if (!existsSync(patchPath)) {
		act('observer', patchPath, '跳过:desktop profile 还没生成(先启动一次 DSH Desktop 再重跑本步)');
		return;
	}
	const begin = '# >>> dsh-subagent-observer >>>';
	const end = '# <<< dsh-subagent-observer <<<';
	const block = [
		begin,
		'# 由 dsh-subagent 的 install.mjs 托管;删除本块即可关掉 GUI 实时监控。',
		'- insert:',
		'    - id: dsh-subagent-observer',
		`      name: ${pathToFileURL(target).href}`,
		end,
	].join('\n');
	const text = readFileSync(patchPath, 'utf8');
	let next;
	const start = text.indexOf(begin);
	const stop = start < 0 ? -1 : text.indexOf(end, start);
	if (start >= 0 && stop >= 0) {
		// 用 begin 之后的**第一个** end(与 upsertMarkedBlock 一致):原来的 lastIndexOf
		// 在出现第二个 end 标记时会连着后面的配置一起吞掉;漂移时直接拒写。
		if (hasForeignEntry(text.slice(start + begin.length, stop))) {
			act('skip', patchPath, `${end} 已漂移(块内混入其它条目),拒绝重写以免删掉你的配置;请把该结束标记移回块尾`);
			return;
		}
		next = `${text.slice(0, start)}${block}${text.slice(stop + end.length)}`;
	} else {
		next = `${text.replace(/\s+$/, '')}\n\n${block}\n`;
	}
	if (next === text) return;
	backup(patchPath);
	if (!dryRun) writeFileSync(patchPath, next, 'utf8');
	act('observer', patchPath, '已写入 GUI 观察器(重启一次 DSH Desktop 后生效)');
}

/**
 * 1c. GUI 悬浮卡片:dsh-subagent-panel —— 在 DSH Desktop 右上角显示按调用方
 * (Cursor / Claude Code / Codex …)分组的实时子代理看板。
 *
 * 客户端插件必须是「预构建的纯 JS bundle + package.json 里的 dsh.client 声明」,
 * 并且在 desktop profile 的 patch 层里有一行 Loader 条目;这里同样用受管标记块托管。
 * 浏览器侧的启动图在**页面刷新**时才重组,所以写入后需要刷新页面;首次安装仍需
 * 重启一次 DSH Desktop(打包版的 patch 文件热应用不生效)。
 */
function installPanel() {
	if (only !== null && !only.has('panel')) return;
	const sourceDir = join(BRIDGE_ROOT, 'gui');
	if (!existsSync(sourceDir)) return;
	const targetDir = join(dshHome(), 'subagent', 'gui');
	for (const file of ['package.json', join('lib', 'index.js'), join('lib', 'client.js')]) {
		const from = join(sourceDir, file);
		const to = join(targetDir, file);
		if (!existsSync(from)) continue;
		if (existsSync(to) && readFileSync(from, 'utf8') === readFileSync(to, 'utf8')) continue;
		if (!dryRun) {
			ensureDir(dirname(to));
			copyFileSync(from, to);
		}
		act('panel', to, '已同步');
	}
	const patchPath = join(dshHome(), 'profiles', 'desktop', 'cordis.patch.yml');
	if (!existsSync(patchPath)) {
		act('panel', patchPath, '跳过:desktop profile 还没生成(先启动一次 DSH Desktop 再重跑本步)');
		return;
	}
	const begin = '# >>> dsh-subagent-panel >>>';
	const end = '# <<< dsh-subagent-panel <<<';
	const body = [
		'# 由 dsh-subagent 的 install.mjs 托管;删除本块即可关掉悬浮卡片。',
		'- insert:',
		'    - id: dsh-subagent-panel',
		`      name: ${pathToFileURL(join(targetDir, 'lib', 'index.js')).href}`,
	].join('\n');
	if (upsertMarkedBlock(patchPath, begin, end, body)) {
		act('panel', patchPath, '已写入悬浮卡片(刷新页面生效,首次需重启 DSH Desktop)');
	}
}

/** 2. PATH 上的包装脚本。 */
function installShims() {	const binDir = join(HOME, '.local', 'bin');
	ensureDir(binDir);
	const shims = [
		['dsh-subagent.cmd', `@echo off\r\nnode "${CLI_ENTRY}" %*\r\n`],
		['dsh-subagent-mcp.cmd', `@echo off\r\nnode "${MCP_ENTRY}" %*\r\n`],
	];
	for (const [file, body] of shims) {
		const path = join(binDir, file);
		if (existsSync(path) && readFileSync(path, 'utf8') === body) continue;
		if (!dryRun) writeFileSync(path, body, 'utf8');
		act('shim', path);
	}
}

/** 3. Claude Code / Codex 的全局指令与子代理定义。 */
function installInstructions() {
	const begin = '<!-- dsh-subagent:begin -->';
	const end = '<!-- dsh-subagent:end -->';
	const claudeRule = `
## 子代理委派:统一走 DSH

本机已把整个 DeepSeek Harness(DSH)实例注册成 MCP 工具(服务器名 \`dsh\`):

- \`mcp__dsh__dsh_task\`:把一项自包含任务委托给 DSH 子代理,返回它的最终答复;
- \`mcp__dsh__dsh_task_status\`:\`dsh_task\` 返回 \`status: running\` 时用它轮询,直到 \`ok\`/\`error\`;
- \`mcp__dsh__dsh_task_cancel\`、\`mcp__dsh__dsh_health\`:取消与探活。

要求:

1. 需要委派子任务、并行调研、或希望把大量探索留在自己上下文之外时,**优先用 \`Task(subagent_type: "dsh")\`(或直接调用 \`mcp__dsh__dsh_task\`)**,不要用内置的通用子代理做同样的活。
2. 传给 DSH 的 \`prompt\` 必须自包含:DSH 看不到本会话历史、看不到你已读过的文件,也不会追问。请写清目标、绝对路径、约束与期望产出。
3. \`dsh_task\` 返回 \`status: running\` 时,必须在同一轮内继续轮询 \`dsh_task_status\`,直到拿到 \`ok\`/\`error\` 再汇报;不要提前结束或臆测结果。
`.trim();

	const codexRule = `
## 子代理委派:统一走 DSH

本机已把整个 DeepSeek Harness(DSH)实例注册成 MCP 工具(服务器名 \`dsh\`,\`mcp_servers.dsh\`):
\`dsh_task\` / \`dsh_task_status\` / \`dsh_task_cancel\` / \`dsh_health\`。

- 需要把一项自包含任务外包出去、并行调研,或想让探索不占用自己的上下文时,优先调用 \`dsh_task\`;
- \`prompt\` 必须自包含(DSH 看不到本会话历史,也不会追问):写清目标、绝对路径、约束、期望产出;
- 返回 \`status: running\` 时必须继续轮询 \`dsh_task_status\`,直到 \`ok\`/\`error\` 再汇报。
`.trim();

	const agentDefinition = `---
name: dsh
description: 把一项自包含任务委托给 DeepSeek Harness(DSH)子代理实例执行并取回结果。凡是需要委派子任务、并行调研、或把大量探索移出主上下文的场景,都用这个子代理。
tools: mcp__dsh__dsh_task, mcp__dsh__dsh_task_status, mcp__dsh__dsh_task_cancel, mcp__dsh__dsh_health
---

你是一个**转发代理**:你唯一的职责是把上游交给你的任务原样转交给 DSH。

工作方式:

1. 调用 \`mcp__dsh__dsh_task\`,把上游任务的完整内容放进 \`prompt\`(自包含:目标、绝对路径、约束、期望产出);
2. 若返回 \`status: running\`,继续用 \`mcp__dsh__dsh_task_status(job_id, wait_seconds: 120)\` 轮询,直到 \`ok\`/\`error\`/\`cancelled\`;不要中途放弃;
3. 把 DSH 的最终答复**原样**返回给上游(不要二次总结、不要粉饰失败)。失败时把 \`error\`、\`exit_code\` 与结果目录一并返回;
4. 不要自己动手改文件、不要自己跑命令——那是 DSH 的活。

\`workspace\` 参数留空即可(默认取调用方工作空间);只有上游明确指定了别的目录时才传。
`;

	const claudeMd = join(HOME, '.claude', 'CLAUDE.md');
	if (only === null || only.has('claude')) {
		if (upsertMarkedBlock(claudeMd, begin, end, claudeRule)) act('instructions', claudeMd, '追加「子代理委派:统一走 DSH」');
		else actions.push({ kind: 'ok', target: claudeMd, detail: '已是最新' });

		const agentPath = join(HOME, '.claude', 'agents', 'dsh.md');
		ensureDir(dirname(agentPath));
		if (!existsSync(agentPath) || readFileSync(agentPath, 'utf8') !== agentDefinition) {
			backup(agentPath);
			if (!dryRun) writeFileSync(agentPath, agentDefinition, 'utf8');
			act('subagent', agentPath, 'Claude Code 子代理 dsh → DSH 实例');
		}
	}

	if (only === null || only.has('codex')) {
		const codexAgents = join(HOME, '.codex', 'AGENTS.md');
		if (upsertMarkedBlock(codexAgents, begin, end, codexRule)) act('instructions', codexAgents, '追加「子代理委派:统一走 DSH」');
		else actions.push({ kind: 'ok', target: codexAgents, detail: '已是最新' });
	}
}

/** 4. Claude Code 权限放行(避免每次调用都弹确认)。 */
function installClaudePermissions() {
	const settings = join(HOME, '.claude', 'settings.json');
	if (only !== null && !only.has('claude')) return;
	if (!existsSync(settings)) return;
	const file = readJson(settings, null);
	if (file === null) return;
	const permissions = file.permissions !== null && typeof file.permissions === 'object' ? file.permissions : {};
	const allow = Array.isArray(permissions.allow) ? permissions.allow : [];
	if (!allow.includes('mcp__dsh')) {
		permissions.allow = [...allow, 'mcp__dsh'];
		file.permissions = permissions;
		writeJsonFile(settings, file);
		act('permission', settings, 'permissions.allow += mcp__dsh');
	}
}

/** 5. Cursor 用户级规则(尽力而为:Cursor 各版本对 ~/.cursor/rules 支持不一)。 */
function installCursorRules() {
	const path = join(HOME, '.cursor', 'rules', 'dsh-subagent.mdc');
	if (only !== null && !only.has('cursor')) return;
	const body = `---
description: 委派子任务时优先使用 DSH subagent(MCP 服务器 dsh)
alwaysApply: true
---

# 委派子任务 → 优先 DSH

本机把整个 DeepSeek Harness(DSH)实例注册成了 MCP 工具(服务器 \`dsh\`):
\`dsh_task\`、\`dsh_task_status\`、\`dsh_task_cancel\`、\`dsh_health\`。

- 需要委派子任务、并行调研、或要把大量探索移出主上下文时,优先调用 \`dsh_task\`,而不是内置的 Task/subagent;
- \`prompt\` 必须自包含:DSH 看不到本会话历史,也不会追问。写清目标、绝对路径、约束、期望产出;
- 返回 \`status: running\` 时必须继续轮询 \`dsh_task_status\`,直到 \`ok\`/\`error\` 再汇报。
`;
	if (!existsSync(path) || readFileSync(path, 'utf8') !== body) {
		backup(path);
		ensureDir(dirname(path));
		if (!dryRun) writeFileSync(path, body, 'utf8');
		act('rules', path, 'Cursor 用户级规则(尽力而为)');
	}
}

/** 6. MCP 客户端注册表。 */
function installMcpClients() {
	registerJsonClient({ name: 'cursor', path: join(HOME, '.cursor', 'mcp.json'), key: 'mcpServers' });
	registerJsonClient({ name: 'claude', path: join(HOME, '.claude.json'), key: 'mcpServers' });
	registerJsonClient({ name: 'claude-desktop', path: join(APPDATA, 'Claude', 'claude_desktop_config.json'), key: 'mcpServers', create: false });
	registerJsonClient({ name: 'gemini', path: join(HOME, '.gemini', 'settings.json'), key: 'mcpServers' });
	registerJsonClient({ name: 'antigravity', path: join(HOME, '.gemini', 'antigravity', 'mcp_config.json'), key: 'mcpServers' });
	registerJsonClient({ name: 'kiro', path: join(HOME, '.kiro', 'settings', 'mcp.json'), key: 'mcpServers' });
	registerJsonClient({ name: 'qoder', path: join(HOME, '.qoder', 'mcp.json'), key: 'mcpServers' });
	registerJsonClient({ name: 'vscode', path: join(APPDATA, 'Code', 'User', 'mcp.json'), key: 'servers', style: 'vscode' });
	registerJsonClient({ name: 'copilot-cli', path: join(HOME, '.vscode', 'mcp.json'), key: 'servers', style: 'vscode' });
	registerJsonClient({ name: 'opencode', path: join(HOME, '.config', 'opencode', 'opencode.json'), key: 'mcp', style: 'opencode' });
	registerCodex();
}

/** 主流程。 */
function main() {
	process.stdout.write(`dsh-subagent 安装器${dryRun ? '(dry-run)' : ''}\n`);
	process.stdout.write(`  桥接目录: ${BRIDGE_ROOT}\n  node    : ${NODE}\n  DSH_HOME: ${dshHome()}\n\n`);

	try {
		const launcher = resolveLauncher();
		process.stdout.write(`  dsh 启动器: ${launcher.describe}\n\n`);
	} catch (error) {
		process.stdout.write(`  ⚠ 未找到 dsh 启动器: ${error.message}\n(安装会继续,但运行任务前必须先修好它)\n\n`);
	}

	process.stdout.write('1/8 DSH profile\n');
	installProfile();
	process.stdout.write('\n2/8 GUI 观察器(会话列表实时显示外部 subagent 任务)\n');
	installObserver();
	process.stdout.write('\n3/8 GUI 悬浮卡片(按调用方分组实时监控)\n');
	installPanel();
	process.stdout.write('\n4/8 PATH 包装脚本\n');
	installShims();
	process.stdout.write('\n5/8 MCP 客户端注册\n');
	installMcpClients();
	process.stdout.write('\n6/8 全局指令与子代理定义\n');
	installInstructions();
	process.stdout.write('\n7/8 Claude Code 权限\n');
	installClaudePermissions();
	process.stdout.write('\n8/8 Cursor 用户规则\n');
	installCursorRules();

	process.stdout.write(`\n完成:共 ${actions.length} 条动作。\n`);
	if (dryRun) {
		// --dry-run 要说清"会改什么"(README/docs 都是这么承诺的),所以逐条列出来;
		// 其中 kind=ok 的就是"已经是目标状态、一个字都没动"。
		process.stdout.write('(dry-run:没有真正写入;将要执行的动作如下)\n');
		for (const action of actions) {
			process.stdout.write(`  · ${action.kind}: ${action.target}${action.detail === undefined ? '' : ` — ${action.detail}`}\n`);
		}
	} else {
		process.stdout.write('\n下一步:\n');
		process.stdout.write(`  1) 自检: node "${CLI_ENTRY}" --where\n`);
		process.stdout.write(`  2) 试跑: node "${CLI_ENTRY}" --workspace . "列出当前目录并总结这个仓库做什么"\n`);
		process.stdout.write('  3) 重启 Cursor / Claude Code / Codex,在对话里让它调用 dsh_task 或 dsh_health。\n');
		process.stdout.write('  4) 重启一次 DSH Desktop:之后外部 subagent 任务会实时出现在会话列表并带「运行中」标记,同时右上角出现按调用方分组的悬浮卡片 Subagent。\n');
		process.stdout.write('  5) 卡片首次出现需要刷新一次页面(浏览器启动图在刷新时才重组)。\n');
	}
}

main();
