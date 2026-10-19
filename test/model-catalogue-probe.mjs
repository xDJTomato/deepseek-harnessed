/**
 * 原生模型目录 + 模型策略自检(**离线**:不需要真的装上 DSH)。
 *
 * 覆盖的是本轮"模型归属"重构的四个面:
 *   1. 叶子插件 `profile/subagent-models.js` 的枚举契约 —— 用假 ctx 直接调 `collect`,
 *      含"单个 provider 的 catalog 取不到必须如实记录,不能静默成空清单";
 *   2. 桥接层把探针结果规范化 + 缓存 + 降级 —— 用假探针脚本顶掉 DSH,断言
 *      `dsh_health.models.source` 依次是 native / cache / yaml;
 *   3. 策略文件里的 `默认模型:` 真的落到运行参数上(`resolveDefaultSelection`);
 *   4. 部署接线:新插件文件必须在 install.mjs 的同步清单与 cordis.patch.yml 里,
 *      否则装了也不生效(这类"声明了但没接线"是自检最容易漏的洞)。
 *
 * 真机链路(`dsh --profile subagent --print-model-catalogue` 起真 DSH)不在本文件里:
 * 它要一个装好的 DSH,由 test/selftest.mjs 在真机上跑同一套 services。
 */
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const BRIDGE_ROOT = resolve(import.meta.dirname, '..');
const MCP_ENTRY = join(BRIDGE_ROOT, 'bin', 'dsh-subagent-mcp.mjs');

const results = [];
function check(name, ok, detail = '') {
	results.push({ name, ok, detail });
	process.stdout.write(`${ok ? '✅' : '❌'} ${name}${detail === '' ? '' : ` — ${detail}`}\n`);
}

/** 一个极简 MCP stdio 客户端(与 test/selftest.mjs 同款,只保留本文件要用的部分)。 */
class Client {
	constructor(command, args, extraEnv = {}) {
		this.child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, ...extraEnv } });
		this.buffer = '';
		this.pending = new Map();
		this.nextId = 1;
		this.child.stdout.setEncoding('utf8');
		this.child.stdout.on('data', (chunk) => this.onData(chunk));
		this.child.stderr.setEncoding('utf8');
		this.child.stderr.on('data', (chunk) => process.stderr.write(`[server] ${chunk}`));
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
			if (frame.id !== undefined) {
				this.write({ jsonrpc: '2.0', id: frame.id, result: { roots: [] } });
			}
		}
	}
	write(message) {
		this.child.stdin.write(`${JSON.stringify(message)}\n`);
	}
	request(method, params) {
		const id = this.nextId++;
		return new Promise((resolveRequest, reject) => {
			this.pending.set(id, { resolve: resolveRequest, reject });
			this.write({ jsonrpc: '2.0', id, method, params });
			setTimeout(() => {
				if (this.pending.delete(id)) reject(new Error(`${method} 超时`));
			}, 60000).unref?.();
		});
	}
	notify(method, params) {
		this.write({ jsonrpc: '2.0', method, params });
	}
	async close() {
		this.child.stdin.end();
		await new Promise((done) => {
			this.child.once('exit', done);
			setTimeout(() => {
				this.child.kill();
				done();
			}, 3000).unref?.();
		});
	}
}

function textOf(result) {
	return (result?.content ?? []).map((item) => item.text ?? '').join('\n');
}

function payloadOf(text) {
	const match = /```json\n([\s\S]*?)\n```/.exec(text);
	return match === null ? null : JSON.parse(match[1]);
}

/** 起一个客户端、握手、取 dsh_health 的 payload。 */
async function healthPayload(env) {
	const client = new Client(process.execPath, [MCP_ENTRY], { DSH_SUBAGENT_AUTOSTART_MONITOR: 'off', ...env });
	try {
		await client.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'dsh-subagent-catalogue-probe', version: '0.0.1' } });
		client.notify('notifications/initialized', {});
		return payloadOf(textOf(await client.request('tools/call', { name: 'dsh_health', arguments: {} })));
	} finally {
		await client.close();
	}
}

async function main() {
	const scratch = mkdtempSync(join(tmpdir(), 'dsh-subagent-catalogue-'));
	try {
		await checkLeafPlugin(scratch);
		await checkBridgeCatalogue(scratch);
		await checkPolicyDefault();
		checkWiring();
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}

	const failed = results.filter((entry) => !entry.ok);
	process.stdout.write(`\n${results.length - failed.length}/${results.length} 项通过\n`);
	if (failed.length > 0) process.exitCode = 1;
}

/**
 * 1. 叶子插件:直接调 collect / apply(把 `@deepseek-ai/schemastery` 换成假包,
 *    这样桥接层仓库不必装 DSH 运行时也能真跑这段逻辑)。
 */
async function checkLeafPlugin(scratch) {
	const dir = join(scratch, 'leaf');
	mkdirSync(join(dir, 'node_modules', '@deepseek-ai', 'schemastery'), { recursive: true });
	writeFileSync(join(dir, 'node_modules', '@deepseek-ai', 'schemastery', 'package.json'),
		JSON.stringify({ name: '@deepseek-ai/schemastery', version: '0.0.0', type: 'module', main: 'index.js' }), 'utf8');
	writeFileSync(join(dir, 'node_modules', '@deepseek-ai', 'schemastery', 'index.js'),
		'export default { object: () => ({}), boolean: () => ({}) };\n', 'utf8');
	copyFileSync(join(BRIDGE_ROOT, 'profile', 'subagent-models.js'), join(dir, 'subagent-models.js'));
	const plugin = await import(pathToFileURL(join(dir, 'subagent-models.js')).href);

	const llm = {
		listProviders: () => [{ id: 'alpha', name: 'Alpha' }, { id: 'beta' }, { id: 'gamma' }],
		listModels: async (id) => {
			if (id === 'beta') throw new Error('adapter 挂了');
			if (id === 'gamma') return [];
			return [{ id: 'm-one' }, { id: 'm-two' }];
		},
	};
	const agentDefaultModel = { currentSelection: () => ({ provider: 'alpha', model: 'm-one', reasoningEffort: 'high' }) };
	const ctx = { get: (name) => ({ llm, agentDefaultModel, appExit: () => {} })[name] };

	const catalogue = await plugin.collect(ctx);
	check('叶子插件列出全部 provider', JSON.stringify(catalogue.providers) === JSON.stringify([{ id: 'alpha', name: 'Alpha' }, { id: 'beta', name: 'beta' }, { id: 'gamma', name: 'gamma' }]),
		JSON.stringify(catalogue.providers));
	check('叶子插件按 provider 归集 catalog', JSON.stringify(catalogue.models.alpha) === JSON.stringify(['m-one', 'm-two']), JSON.stringify(catalogue.models));
	check('取不到的 catalog 如实记录(不是静默空清单)',
		catalogue.modelErrors.beta === 'adapter 挂了' && String(catalogue.modelErrors.gamma ?? '').includes('空'),
		JSON.stringify(catalogue.modelErrors));
	check('默认模型来自原生 currentSelection',
		JSON.stringify(catalogue.defaultSelection) === JSON.stringify({ provider: 'alpha', model: 'm-one', reasoningEffort: 'high' }),
		JSON.stringify(catalogue.defaultSelection));

	// apply 的闸门:没开开关时一个字都不许输出(否则 dsh_health 的 stdout 会被污染)
	let out = '';
	const exits = [];
	plugin.internals.stdout = { write: (text) => { out += text; } };
	plugin.internals.stderr = { write: () => {} };
	const probeCtx = { get: (name) => ({ llm, agentDefaultModel, appExit: (code) => exits.push(code) })[name] };
	plugin.apply(probeCtx, { printCatalogue: false });
	await new Promise((done) => setTimeout(done, 30));
	check('未开 --print-model-catalogue 时静默', out === '' && exits.length === 0, `out=${JSON.stringify(out.slice(0, 40))} exits=${exits.length}`);

	plugin.apply(probeCtx, { printCatalogue: true });
	await new Promise((done) => setTimeout(done, 30));
	const printed = out.trim();
	let parsed = null;
	try {
		parsed = JSON.parse(printed);
	} catch {
		parsed = null;
	}
	check('开启后 stdout 只输出一行合法 JSON 并 exit(0)',
		parsed !== null && out.endsWith('\n') && printed.split('\n').length === 1 && JSON.stringify(exits) === '[0]',
		`exits=${JSON.stringify(exits)} 首行=${printed.slice(0, 60)}`);
	check('导出的 JSON 带 schema 版本', parsed?.schema === 1, String(parsed?.schema));

	let threw = '';
	try {
		plugin.apply({ get: () => undefined }, { printCatalogue: true });
	} catch (error) {
		threw = String(error.message);
	}
	check('没有 appExit 时响亮失败(不静默挂住)', threw.includes('appExit'), threw);
}

/** 2. 桥接层:假探针 → native;探针失败 + 缓存 → cache;探针失败 + 无缓存 → yaml。 */
async function checkBridgeCatalogue(scratch) {
	const okScript = join(scratch, 'probe-ok.mjs');
	const failScript = join(scratch, 'probe-fail.mjs');
	writeFileSync(okScript, [
		'process.stdout.write(JSON.stringify({',
		"  schema: 1,",
		"  providers: [{ id: 'alpha', name: 'Alpha' }, { id: 'beta', name: 'Beta' }],",
		"  models: { alpha: ['m-one', 'm-two'], beta: [] },",
		"  modelErrors: { beta: 'catalog 为空' },",
		"  defaultSelection: { provider: 'alpha', model: 'm-one' },",
		'}) + "\\n");',
	].join('\n'), 'utf8');
	writeFileSync(failScript, 'process.stderr.write("探针炸了\\n"); process.exit(3);\n', 'utf8');

	const home = join(scratch, 'home-native');
	const live = await healthPayload({ DSH_HOME: home, DSH_SUBAGENT_CATALOGUE_CMD: okScript, DSH_SUBAGENT_POLICY: join(home, 'no-policy.md') });
	check('dsh_health 的模型清单来自原生探针(source=native)', live?.models?.source === 'native', JSON.stringify(live?.models?.source));
	check('原生探针的 providers 按 provider 分组透传',
		JSON.stringify(live?.models?.providers) === JSON.stringify({ alpha: ['m-one', 'm-two'] }), JSON.stringify(live?.models?.providers));
	check('原生探针的 defaultModel 用 currentSelection(不再靠 YAML 嗅探)',
		live?.models?.defaultModel === 'alpha/m-one' && live?.defaultModel === 'alpha/m-one', String(live?.defaultModel));
	check('探针失败字段在有结果时不出现', live?.modelCatalogueError === undefined, JSON.stringify(live?.modelCatalogueError));
	check('取不到 catalog 的 provider 记进 modelErrors', live?.models?.modelErrors?.beta === 'catalog 为空', JSON.stringify(live?.models?.modelErrors));
	check('探针结果落了磁盘缓存', existsSync(join(home, 'subagent', 'state', 'model-catalogue.json')), join(home, 'subagent', 'state', 'model-catalogue.json'));

	// 同一份 home:探针换成会失败的脚本 → 用缓存(而不是退回猜测)
	const cached = await healthPayload({ DSH_HOME: home, DSH_SUBAGENT_CATALOGUE_CMD: failScript, DSH_SUBAGENT_POLICY: join(home, 'no-policy.md') });
	check('探针失败但缓存新鲜 → source=cache 且不标 stale',
		cached?.models?.source === 'cache' && cached?.models?.stale === false, `${cached?.models?.source} stale=${cached?.models?.stale}`);
	check('缓存路径仍然给出正确的模型清单', cached?.models?.defaultModel === 'alpha/m-one', String(cached?.models?.defaultModel));
	check('探针失败原因单列在 modelCatalogueError 里', typeof cached?.modelCatalogueError === 'string' && cached.modelCatalogueError.includes('退出码 3'),
		String(cached?.modelCatalogueError));

	// 新 home、无缓存、探针失败 → 退回 YAML 兜底,并且如实报错(不假装是原生)
	const emptyHome = join(scratch, 'home-fallback');
	const fallback = await healthPayload({ DSH_HOME: emptyHome, DSH_SUBAGENT_CATALOGUE_CMD: failScript, DSH_SUBAGENT_POLICY: join(emptyHome, 'no-policy.md') });
	check('探针不可用且无缓存 → 退回 YAML 兜底(source=yaml)', fallback?.models?.source === 'yaml', String(fallback?.models?.source));
	check('兜底时明确报"枚举不到"而不是静默成功', typeof fallback?.models?.error === 'string' && fallback.models.error !== '', String(fallback?.models?.error).slice(0, 80));

	// 显式关掉探针(自检夹具的口径)→ 直接走兜底,连进程都不起
	const disabled = await healthPayload({ DSH_HOME: emptyHome, DSH_SUBAGENT_CATALOGUE: 'off', DSH_SUBAGENT_CATALOGUE_CMD: okScript, DSH_SUBAGENT_POLICY: join(emptyHome, 'no-policy.md') });
	check('DSH_SUBAGENT_CATALOGUE=off 时不跑探针(夹具确定性靠它)',
		disabled?.models?.source === 'yaml' && disabled?.modelCatalogueError === undefined, `${disabled?.models?.source} err=${String(disabled?.modelCatalogueError)}`);
}

/** 3. 策略文件 `默认模型:` 落成运行参数。 */
async function checkPolicyDefault() {
	const { readModelPolicy, resolveDefaultSelection } = await import('../lib/model-catalogue.mjs');
	const scratch = mkdtempSync(join(tmpdir(), 'dsh-subagent-policyd-'));
	const policyPath = join(scratch, 'model-policy.md');
	writeFileSync(policyPath, '# 口径\n\n默认模型: m-two\n默认推理强度: max\n\n## 预设方案\n\n### 本项目方案\n预设默认模型: m-one\n', 'utf8');
	process.env.DSH_SUBAGENT_POLICY = policyPath;
	try {
		const policy = readModelPolicy();
		check('策略文件读到默认模型、默认推理强度与预设',
			policy.defaultModel === 'm-two' && policy.defaultReasoningEffort === 'max'
			&& policy.presets.includes('本项目方案') && policy.presetModels['本项目方案'] === 'm-one',
			`default=${policy.defaultModel} effort=${policy.defaultReasoningEffort} presets=${policy.presets.join(',')}`);
		const catalogue = { providers: { alpha: ['m-one', 'm-two'] } };
		const caller = resolveDefaultSelection({ model: 'm-one' }, catalogue);
		check('调用方指定了模型 → 策略文件不参与(连默认推理强度也不掺和)',
			caller.from === 'caller' && caller.selection.model === 'm-one' && caller.selection.reasoningEffort === undefined,
			`${caller.from} ${caller.selection.model} effort=${String(caller.selection.reasoningEffort)}`);
		const policy2 = resolveDefaultSelection({}, catalogue);
		check('调用方没指定 → 用策略文件的默认模型 + 默认推理强度,但**不钉 provider**(裸 id 由叶子按档位选路)',
			policy2.from === 'policy' && policy2.selection.model === 'm-two'
			&& policy2.selection.reasoningEffort === 'max' && policy2.selection.provider === undefined,
			`${policy2.from} ${String(policy2.selection.provider)}/${policy2.selection.model} effort=${String(policy2.selection.reasoningEffort)}`);
		writeFileSync(policyPath, '默认模型: alpha/m-two\n', 'utf8');
		const qualified = resolveDefaultSelection({}, catalogue);
		check('策略文件写 provider/model → provider 被钉死',
			qualified.from === 'policy' && qualified.selection.provider === 'alpha' && qualified.selection.model === 'm-two',
			`${qualified.from} ${String(qualified.selection.provider)}/${String(qualified.selection.model)}`);
		writeFileSync(policyPath, '默认模型: m-two\n默认推理强度: (未指定)\n', 'utf8');
		const noEffort = resolveDefaultSelection({}, catalogue);
		check('默认推理强度写 (未指定) → 不带档位,交回 DSH 设置',
			noEffort.from === 'policy' && noEffort.selection.model === 'm-two' && noEffort.selection.reasoningEffort === undefined,
			`effort=${String(noEffort.selection.reasoningEffort)}`);
		const unmatched = resolveDefaultSelection({}, { providers: { alpha: ['m-one'] } });
		check('策略文件的模型不在已接入清单里 → 不硬塞,标记 policy-unmatched', unmatched.from === 'policy-unmatched' && unmatched.selection.model === undefined, unmatched.from);
		writeFileSync(policyPath, '默认模型: (未指定)\n', 'utf8');
		const unset = resolveDefaultSelection({}, catalogue);
		check('策略文件没写默认模型 → 交回 DSH 原生默认', unset.from === 'policy-unset' && unset.selection.model === undefined, unset.from);
	} finally {
		delete process.env.DSH_SUBAGENT_POLICY;
		rmSync(scratch, { recursive: true, force: true });
	}
}

/** 4. 部署接线:新插件必须真的会被装上、被加载。 */
function checkWiring() {
	const patch = readFileSync(join(BRIDGE_ROOT, 'profile', 'cordis.patch.yml'), 'utf8');
	check('cordis.patch.yml 挂上了 subagent-models 并传 printCatalogue',
		patch.includes("./subagent-models.js") && /subagent-models[\s\S]{0,200}printCatalogue/.test(patch),
		'subagent-models row');
	check('runner 在 --print-model-catalogue 时不抢跑',
		readFileSync(join(BRIDGE_ROOT, 'profile', 'subagent-runner.js'), 'utf8').includes('config.printCatalogue === true'),
		'runner gate');
	const install = readFileSync(join(BRIDGE_ROOT, 'install.mjs'), 'utf8');
	check('install.mjs 会把 subagent-models.js 同步进叶子 profile', install.includes("'subagent-models.js'"), 'install sync list');
	check('叶子启动器暴露 --print-model-catalogue',
		readFileSync(join(BRIDGE_ROOT, 'profile', 'subagent-startup.js'), 'utf8').includes('--print-model-catalogue'),
		'startup option');
	// 发布默认值:工作区读写 + PTC 呈现 + 重新启用 credentials(0.2.1 的 apiKeyEnv 走凭据服务)
	check('发布默认权限是 workspace-write(沙箱模式与权限预设同步)',
		/DSH_SUBAGENT_PERMISSION \?\? process\.env\.DSH_PERMISSION_MODE \?\? 'workspace-write'/.test(patch)
		&& /defaultPreset: !!js process\.env\.DSH_SUBAGENT_PERMISSION \?\? 'workspace-write'/.test(patch),
		'sandbox/permission defaults');
	check('叶子进程默认以 PTC 形态呈现工具(起进程时设 DSH_TOOLS_MODE=ptc)',
		/DSH_TOOLS_MODE: process\.env\.DSH_SUBAGENT_TOOLS_MODE \?\? 'ptc'/.test(readFileSync(join(BRIDGE_ROOT, 'lib', 'tasks.mjs'), 'utf8')),
		'tasks.mjs spawn env');
	check('叶子 profile 重新启用 credentials 行(0.2.1 从凭据服务解析 apiKeyEnv)',
		/id: credentials\s+disabled: false/.test(patch), 'credentials row');
}

await main();
