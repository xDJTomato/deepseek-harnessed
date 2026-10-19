/**
 * 模型目录与模型策略的**唯一归属地**:原生登记表在前,用户策略文件在后。
 *
 * 背景(0.2.0-rc.2):DSH 原生就能回答"这个实例有哪些模型" ——
 *   - `llm` 服务公开 `listProviders()` / `listModels(provider)`(适配器登记的 provider 与 catalog);
 *   - `agentDefaultModel` 服务公开 `currentSelection()`(生效中的 provider/model/reasoningEffort)。
 * 而子代理模型选择的原生化落在 `dsh-tool-subagent`(每个工具实例的 agentOptions + allowedModels),
 * 那是**进程内**子代理的通道;桥接层走的是 headless 叶子进程,官方 headless 只读
 * `agentDefaultModel.currentSelection()`,所以叶子仍需自己的 `--provider/--model/--reasoning-effort`
 * 透传(见 `profile/subagent-runner.js`)。
 *
 * 桥接层真正能借到的原生能力就是**登记表**:以前它靠自己手写解析
 * `profiles/subagent/cordis.patch.yml → cordis.patch.yml → settings.yaml.imported → settings.yaml`
 * 两份 YAML 方言去猜,插件注册了 provider、适配器改了 catalog、旧迁移副本还在 —— 它都会答错。
 *
 * 现在的顺序:
 *   1. `nativeCatalogue()`:让叶子 profile 的 `--print-model-catalogue` 用原生服务打印 JSON,
 *      带进程内 memo + 磁盘缓存,探针失败时退回上一次成功的缓存并标 stale;
 *   2. 探针不可用 → 返回 null,调用方退回既有的 YAML 兜底(**绝不假装拿到了登记表**);
 *   3. 用户策略文件(`config/model-policy.md`)只表达**意图**(默认模型 + 预设),不参与枚举。
 *
 * @module dsh-subagent/lib/model-catalogue
 */
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { childEnv, resolveLauncher } from './launcher.mjs';
import { BRIDGE_ROOT, dshHome, readJson, readText, writeJson } from './util.mjs';

/**
 * 目录的复用窗口(毫秒)。
 *
 * 为什么要有缓存:每次枚举都要起一个 DSH 进程(约 1~3 秒),而 `dsh_health` 是调用方最常打的探针。
 * 轮次内模型不会变,缓存 60 秒足够,也让 `dsh_setup` 的校验不会各起一个进程。
 */
const TTL_MS = (() => {
	const value = Number(process.env.DSH_SUBAGENT_CATALOGUE_TTL_MS ?? 60000);
	return Number.isFinite(value) && value >= 0 ? value : 60000;
})();

/** 单次探针的等待上限(毫秒)。起进程 + 读配置,冷启动留足余量。 */
const TIMEOUT_MS = (() => {
	const value = Number(process.env.DSH_SUBAGENT_CATALOGUE_TIMEOUT_MS ?? 90000);
	return Number.isFinite(value) && value > 0 ? value : 90000;
})();

/** 磁盘缓存路径(跨桥接进程共享,所以连原始探针输出一起存)。 */
export function catalogueCachePath() {
	return join(dshHome(), 'subagent', 'state', 'model-catalogue.json');
}

/** 探针是否被显式关闭(`off` / `0` / `false` / `no`)—— 自检夹具靠它走 YAML 兜底。 */
export function catalogueEnabled() {
	const raw = process.env.DSH_SUBAGENT_CATALOGUE;
	if (raw === undefined || String(raw).trim() === '') return true;
	return !['off', '0', 'false', 'no'].includes(String(raw).trim().toLowerCase());
}

/** 进程内 memo:`{atMs, value}`;值是**已经规范化**的目录对象。 */
let memo = null;

/** 最近一次探针失败的原因(给 dsh_health 做诊断,不参与判定)。 */
let lastProbeError = null;

/** 最近一次探针失败的原因(没有失败时返回 null)。 */
export function catalogueProbeError() {
	return lastProbeError;
}

/**
 * 把探针输出的 JSON 规范化成桥接层一直对外承诺的形状。
 *
 * 对外形状必须保持不变(`providers` 按 provider 分组、`all` 是去重后的扁平清单、
 * `defaultModel` 是 `provider/model`),否则 `dsh_health` / `dsh_task` / `dsh_setup` 的
 * 调用方(以及既有自检)会一起被改坏。
 * @param raw - 叶子 `--print-model-catalogue` 打印的 JSON。
 * @returns 规范化目录。
 */
function normalize(raw) {
	const providers = {};
	const all = [];
	const seen = new Set();
	const models = raw !== null && typeof raw === 'object' && raw.models !== null && typeof raw.models === 'object' ? raw.models : {};
	for (const entry of Array.isArray(raw?.providers) ? raw.providers : []) {
		const id = typeof entry?.id === 'string' ? entry.id.trim() : '';
		if (id === '') continue;
		const ids = Array.isArray(models[id]) ? models[id].filter((model) => typeof model === 'string' && model !== '') : [];
		if (ids.length === 0) continue;
		providers[id] = ids;
		for (const model of ids) {
			if (seen.has(model)) continue;
			seen.add(model);
			all.push(model);
		}
	}
	const selection = raw?.defaultSelection !== null && typeof raw?.defaultSelection === 'object' ? raw.defaultSelection : null;
	const provider = typeof selection?.provider === 'string' ? selection.provider : '';
	const model = typeof selection?.model === 'string' ? selection.model : '';
	return {
		providers,
		all,
		defaultModel: provider !== '' && model !== '' ? `${provider}/${model}` : null,
		defaultSelection: selection === null ? null : {
			provider,
			model,
			...(typeof selection.reasoningEffort === 'string' && selection.reasoningEffort !== '' ? { reasoningEffort: selection.reasoningEffort } : {}),
		},
		// 取不到 catalog 的 provider:如实带上原因,别让它看起来像"这个 provider 没模型"。
		modelErrors: raw?.modelErrors !== null && typeof raw?.modelErrors === 'object' ? raw.modelErrors : {},
	};
}

/** 探针命令:显式 env(自检夹具)→ 官方启动器 + 叶子 profile。 */
function probeCommand() {
	const stub = process.env.DSH_SUBAGENT_CATALOGUE_CMD;
	if (typeof stub === 'string' && stub.trim() !== '') {
		return { command: process.execPath, args: [stub.trim()], launcher: { env: {} }, describe: `stub ${stub.trim()}` };
	}
	const launcher = resolveLauncher();
	return {
		command: launcher.command,
		args: [...launcher.args, '--profile', 'subagent', '--print-model-catalogue'],
		launcher,
		describe: launcher.describe,
	};
}

/** 跑一次探针,拿到原始 JSON(失败返回 `{error}`)。 */
function runProbe() {
	let probe;
	try {
		probe = probeCommand();
	} catch (error) {
		return { error: `解析不到 dsh 启动器: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}` };
	}
	const result = spawnSync(probe.command, probe.args, {
		encoding: 'utf8',
		env: childEnv(probe.launcher, { DSH_SUBAGENT_MODELS_PROBE: '1' }),
		timeout: TIMEOUT_MS,
		maxBuffer: 16 * 1024 * 1024,
		windowsHide: true,
	});
	if (result.error !== undefined && result.error !== null) {
		return { error: `探针无法执行(${probe.describe}): ${result.error.message}` };
	}
	if (result.status !== 0) {
		const tail = String(result.stderr ?? '').trim().split('\n').filter((line) => line.trim() !== '').slice(-3).join(' | ');
		return { error: `探针退出码 ${String(result.status)}(${probe.describe})${tail === '' ? '' : `: ${tail}`}` };
	}
	const text = String(result.stdout ?? '').trim();
	const start = text.indexOf('{');
	const stop = text.lastIndexOf('}');
	if (start < 0 || stop <= start) return { error: `探针没有输出模型目录 JSON(${probe.describe})` };
	try {
		return { raw: JSON.parse(text.slice(start, stop + 1)), from: probe.describe };
	} catch (error) {
		return { error: `探针输出不是合法 JSON: ${error instanceof Error ? error.message : String(error)}` };
	}
}

/**
 * 取回**原生**模型目录。
 * @param options.force - true 时忽略 TTL 与 memo,强制重跑探针。
 * @returns 规范化目录;不可用时返回 null(调用方退回 YAML 兜底)。
 */
export function nativeCatalogue({ force = false } = {}) {
	if (!catalogueEnabled()) return null;
	const now = Date.now();
	if (!force && memo !== null && now - memo.atMs < TTL_MS) return memo.value;

	const cached = readJson(catalogueCachePath());
	const cacheFresh = cached !== null && typeof cached === 'object'
		&& Number.isFinite(Number(cached.atMs)) && now - Number(cached.atMs) < TTL_MS;

	const probed = runProbe();
	if (probed.error === undefined) {
		lastProbeError = null;
		const value = { ...normalize(probed.raw), source: 'native', atMs: now, stale: false, from: probed.from, error: null };
		memo = { atMs: now, value };
		// 缓存只是加速手段:写不进去(只读盘 / ACL)不该让这次成功的探针变成失败。
		try {
			writeJson(catalogueCachePath(), { atMs: now, raw: probed.raw });
		} catch {
			/* 下一次仍会重跑探针 */
		}
		return value;
	}

	// 探针失败:能拿到上一次成功的缓存就用它(标 stale),否则交回 YAML 兜底。
	if (cached !== null && typeof cached === 'object' && cached.raw !== null && typeof cached.raw === 'object') {
		lastProbeError = probed.error;
		const value = {
			...normalize(cached.raw),
			source: 'cache',
			atMs: Number(cached.atMs),
			stale: !cacheFresh,
			from: null,
			error: null,
		};
		memo = { atMs: now, value };
		return value;
	}

	lastProbeError = probed.error;
	return null;
}

/**
 * 策略文件的路径:环境变量 `DSH_SUBAGENT_POLICY` 优先,否则 `<桥接层根>/config/model-policy.md`。
 * 环境变量是给自检/多实例隔离用的(自检绝不改仓库里那份发布物)。
 */
export function modelPolicyPath() {
	const explicit = process.env.DSH_SUBAGENT_POLICY;
	if (typeof explicit === 'string' && explicit.trim() !== '') return resolve(explicit.trim());
	return join(BRIDGE_ROOT, 'config', 'model-policy.md');
}

/** 策略文件里"默认模型"的取值 → 模型 id;`(未指定)`/空白都表示还没指定(null)。 */
export function policyModelValue(raw) {
	if (typeof raw !== 'string') return null;
	const value = raw.trim().replace(/^[`'"]+|[`'"]+$/g, '').trim();
	if (value === '' || value === '(未指定)' || value === '(未设置)' || value === 'null') return null;
	return value;
}

/** 策略文件里"默认推理强度"的取值 → 档位名;`(未指定)`/空白都表示交回 DSH 设置(null)。 */
export function policyEffortValue(raw) {
	return policyModelValue(raw);
}

/**
 * 从策略文件的「## 预设方案」段解出预设名,以及每个预设声明的模型。
 * 每个 `### <名字>` 小节里的第一条 `预设默认模型: <模型 id>` 就是它落盘的模型。
 */
export function readPresets(text) {
	const presets = [];
	const presetModels = {};
	const heading = /^##[ \t]*预设方案[ \t]*$/m.exec(text);
	if (heading === null) return { presets, presetModels };
	const rest = text.slice(heading.index + heading[0].length);
	const nextSection = /^##(?!#)/m.exec(rest);
	const body = nextSection === null ? rest : rest.slice(0, nextSection.index);
	for (const chunk of body.split(/^###[ \t]*/m).slice(1)) {
		const newline = chunk.indexOf('\n');
		const presetName = (newline < 0 ? chunk : chunk.slice(0, newline)).trim();
		if (presetName === '') continue;
		presets.push(presetName);
		const declared = /^预设默认模型:[ \t]*(.*)$/m.exec(chunk);
		presetModels[presetName] = declared === null ? null : policyModelValue(declared[1]);
	}
	return { presets, presetModels };
}

/**
 * 读**用户可编辑的模型策略文件** —— 也就是"选择模型的系统提示词"。
 *
 * 机器只读三处:文件里第一条 `默认模型:` 行、第一条 `默认推理强度:` 行,以及每个 `### 预设` 小节里的
 * `预设默认模型:` 行;其余正文只给人看(用户随便改)。文件每次调用都重新读,所以改完立刻生效、不用重启。
 *
 * @returns {{path:string,fileUrl:string,text:string,defaultModel:string|null,defaultReasoningEffort:string|null,raw:string|null,presets:string[],presetModels:Record<string,string|null>}}
 */
export function readModelPolicy() {
	const path = modelPolicyPath();
	const text = readText(path);
	const declared = /^默认模型:[ \t]*(.*)$/m.exec(text);
	const declaredEffort = /^默认推理强度:[ \t]*(.*)$/m.exec(text);
	const raw = declared === null ? null : declared[1].trim();
	return {
		path,
		fileUrl: pathToFileURL(path).href,
		text,
		defaultModel: policyModelValue(raw),
		defaultReasoningEffort: declaredEffort === null ? null : policyEffortValue(declaredEffort[1]),
		raw,
		...readPresets(text),
	};
}

/** 策略文件的一行引用(绝对路径 + 可点开的 file:/// 链接)—— 描述与引导块共用,别各写一份。 */
export function policyRef(policy) {
	return `${policy.path}(${policy.fileUrl})`;
}

/**
 * 把调用方给的模型标识匹配到已接入的模型:裸 model id 与 `provider/model` 两种写法都认。
 * 有些模型 id 本身就带斜杠(如 `qwen/qwen3.6-max-preview`),所以先按 `provider/model` 拆一次,
 * 拆不中再按裸 id 找。
 * @returns {{route:string,model:string}|null} 没匹配上返回 null。
 */
export function matchInstalledModel(models, value) {
	const slash = value.indexOf('/');
	if (slash > 0) {
		const route = value.slice(0, slash);
		const model = value.slice(slash + 1);
		if ((models.providers[route] ?? []).includes(model)) return { route, model };
	}
	for (const [route, ids] of Object.entries(models.providers)) {
		if (ids.includes(value)) return { route, model: value };
	}
	return null;
}

/** 未接入模型的拒绝话术:**必须把可用清单打出来**,调用方才能据此重新问用户。 */
export function unknownModelMessage(models, value) {
	const available = Object.entries(models.providers)
		.map(([route, ids]) => `  ${route}: ${ids.join(', ')}`)
		.join('\n');
	return `模型 "${value}" 不在这个 DSH 实例已接入的模型里(清单来自 DSH 的模型登记表 llm.listProviders/listModels;探针不可用时是同口径的兜底解析,见 dsh_health 的 models.source 与 models.providers)。可用模型清单(provider: id …):\n${available}\n请从中挑一个再用 dsh_setup(default_model: "<id>") 落盘;要指定 provider 也可以传 "provider/id"。`;
}

/**
 * 把用户策略文件里的 `默认模型:` 落成**实际操作参数**。
 *
 * 为什么需要这一步:runner 用的是 DSH 原生 `agentDefaultModel.currentSelection()`,
 * 策略文件那一行如果没人读,就只是文档里的摆设 —— 用户在文件里写"默认用 X"，
 * 实际跑的却是设置里的 Y。这里让策略文件成为**默认值的唯一表达**:
 *   - 调用方显式给了 model(或 provider+model)→ 原样透传,策略文件不参与;
 *   - 调用方没给 → 用策略文件的 `默认模型:`(能在已接入清单里匹配到才用),并带上
 *     同一份文件的 `默认推理强度:`(写 `(未指定)` 就不带,交回 DSH 设置);
 *   - 策略文件也没指定 → 什么都不填,交回 DSH 原生默认(`agentDefaultModel`)。
 *
 * @param {{model?:string,provider?:string,reasoningEffort?:string}} selection - 调用方给的覆盖项。
 * @param {{providers:Record<string,string[]>}|null} models - 已接入模型清单(取不到可传 null)。
 * @returns {{selection:{model?:string,provider?:string,reasoningEffort?:string},from:'caller'|'policy'|'policy-unmatched'|'policy-unset'|'native'}}
 */
export function resolveDefaultSelection(selection, models) {
	const given = {
		...(typeof selection.model === 'string' && selection.model !== '' ? { model: selection.model } : {}),
		...(typeof selection.provider === 'string' && selection.provider !== '' ? { provider: selection.provider } : {}),
		...(typeof selection.reasoningEffort === 'string' && selection.reasoningEffort !== '' ? { reasoningEffort: selection.reasoningEffort } : {}),
	};
	if (given.model !== undefined) return { selection: given, from: 'caller' };

	const policy = readModelPolicy();
	if (policy.defaultModel === null) return { selection: given, from: 'policy-unset' };
	if (models === null || models === undefined) return { selection: given, from: 'native' };
	const matched = matchInstalledModel(models, policy.defaultModel);
	if (matched === null) return { selection: given, from: 'policy-unmatched' };
	return {
		selection: {
			...given,
			// 策略文件写的是裸模型 id 时不钉 provider:同一个 id 可能在多条路由下登记,
			// 而"哪条真的支持这个推理档位"只有叶子进程能问原生元数据 —— 交给
			// `subagent-runner` 的 pickProvider 在叶子内解析(见该函数说明)。
			// 写成 `provider/model` 时才把 provider 钉死。
			...(policy.defaultModel.includes('/') ? { provider: given.provider ?? matched.route } : {}),
			model: matched.model,
			// 推理档位只跟"策略文件的默认模型"一起生效:调用方自己点了模型就交回 DSH 的档位,
			// 免得把只对某个模型声明过的 max 硬套到别的模型上(DSH 会 UNSUPPORTED_REASONING_EFFORT 快失败)。
			...(given.reasoningEffort === undefined && policy.defaultReasoningEffort !== null
				? { reasoningEffort: policy.defaultReasoningEffort }
				: {}),
		},
		from: 'policy',
	};
}
