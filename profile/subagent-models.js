/**
 * 叶子 profile 的**只枚举**模式:把 DSH 原生模型登记表打印成 JSON 后退场。
 *
 *   dsh --profile subagent --print-model-catalogue
 *
 * 为什么由叶子来答:`llm.listProviders()` / `llm.listModels()` 是 DSH 自己的服务(0.2.0-rc.2),
 * 只有跑在 DSH 内部的插件能读到"这一刻真的注册了哪些 provider、每个 provider 的 catalog 是什么"。
 * 桥接层(MCP/CLI)在 DSH 外面,以前只能手写解析 profile patch 与 settings.yaml 去猜。
 *
 * 三条硬约束:
 *   - **一次模型调用都不发**:只读登记表;探针因此可以随便跑,不烧 token、不建会话;
 *   - stdout 只输出那行 JSON(其余日志走 stderr),调用方不必猜格式;
 *   - 单个 provider 的 catalog 取不到时**如实记进 modelErrors**,不把它当成"这个 provider 没模型"。
 *
 * @module dsh-subagent/profile/subagent-models
 */
import process from 'node:process';
import z from '@deepseek-ai/schemastery';

/** 稳定的 Cordis 插件名。 */
export const name = 'subagent-models';

/** 枚举前必须就绪的服务:启动参数、LLM 登记表、默认模型。 */
export const inject = ['subagentStartup', 'llm', 'agentDefaultModel'];

/** 本 row 的配置(只有 printCatalogue 一个开关)。 */
export const Config = z.object({
	printCatalogue: z.boolean(),
});

/** 探针写入的进程流;测试可替换。 */
export const internals = {
	stdout: process.stdout,
	stderr: process.stderr,
};

/** 错误消息归一成一行(JSON 里不放栈)。 */
function messageOf(error) {
	return error instanceof Error ? error.message : String(error);
}

/**
 * 枚举原生登记表并打印 JSON。
 * @param ctx - 携带 llm / agentDefaultModel / appExit 的插件上下文。
 * @returns 目录对象。
 */
export async function collect(ctx) {
	// 先等整棵树挂载完再问登记表:0.2.1-rc.2 起 provider 的注册/替换发生在各插件自己的
	// apply 与 `loader/volatile update` 里,apply 顺序不保证(实测:不等时只看到 deepseek-*,
	// llm-pi-ai 的各路由还没注册,报出"该 provider 的 catalog 为空"的假象)。
	await ctx.get('loader')?.await();
	const llm = ctx.get('llm');
	if (llm === undefined) throw new Error('subagent-models: llm 服务未就绪,无法枚举模型目录');
	const providers = [];
	const models = {};
	const modelErrors = {};
	for (const provider of llm.listProviders()) {
		const id = typeof provider?.id === 'string' ? provider.id : '';
		if (id === '') continue;
		providers.push({ id, name: typeof provider?.name === 'string' ? provider.name : id });
		try {
			const listed = await llm.listModels(id);
			models[id] = listed.filter((model) => typeof model?.id === 'string' && model.id !== '').map((model) => model.id);
			if (models[id].length === 0) modelErrors[id] = '该 provider 的 catalog 为空(适配器没有声明模型)';
		} catch (error) {
			// 取不到 catalog 不等于"没有模型":必须留给调用方判断,不能静默成空清单。
			models[id] = [];
			modelErrors[id] = messageOf(error);
		}
	}
	let defaultSelection = null;
	try {
		const direct = ctx.get('agentDefaultModel')?.currentSelection();
		if (direct !== null && typeof direct === 'object' && typeof direct.provider === 'string' && typeof direct.model === 'string') {
			defaultSelection = {
				provider: direct.provider,
				model: direct.model,
				...(typeof direct.reasoningEffort === 'string' && direct.reasoningEffort !== '' ? { reasoningEffort: direct.reasoningEffort } : {}),
			};
		}
	} catch (error) {
		modelErrors.defaultSelection = messageOf(error);
	}
	return { schema: 1, providers, models, modelErrors, defaultSelection };
}

/**
 * 挂载本插件:只在 `--print-model-catalogue` 这一种调用下做事。
 * @param ctx - 插件上下文。
 * @param config - 已校验的 row 配置。
 */
export function apply(ctx, config) {
	if (config.printCatalogue !== true) return;
	const exit = ctx.get('appExit');
	if (exit === undefined) throw new Error('subagent-models: 启动器必须在树挂载前提供 ctx.appExit');
	collect(ctx).then((catalogue) => {
		internals.stdout.write(`${JSON.stringify(catalogue)}\n`);
		exit(0);
	}, (error) => {
		internals.stderr.write(`dsh-subagent-models: ${messageOf(error)}\n`);
		exit(1);
	});
}
