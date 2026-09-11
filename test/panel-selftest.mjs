/**
 * dsh-subagent-panel 客户端插件的离线自检。
 *
 * 没有浏览器可用,所以这里搭了一个最小运行时:
 *   - 假 window.__ModuleLoader__ 捕获 bundle 的注册;
 *   - 假 document 捕获 CSS 注入;
 *   - 假 require 提供平台种子;
 *   - 迷你 React(useState/useMemo/useCallback/useRef/useEffect)让组件函数可以被真正调用,
 *     再把返回的元素树展开,从而断言「分组 / 只显示活跃 / 点击打开会话」的行为。
 *
 * 运行:node test/panel-selftest.mjs
 */
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const bundlePath = path.join(here, "..", "gui", "lib", "client.js");
const code = readFileSync(bundlePath, "utf8");

// ------------------------------------------------------------------ 迷你 React

const hookSlots = new Map();
let hookIndex = 0;
let currentComponent = null;

function slotsOf(component) {
	let slots = hookSlots.get(component);
	if (slots === undefined) {
		slots = [];
		hookSlots.set(component, slots);
	}
	return slots;
}

function sameDeps(a, b) {
	if (a === undefined || b === undefined || a.length !== b.length) return false;
	for (let i = 0; i < a.length; i += 1) if (!Object.is(a[i], b[i])) return false;
	return true;
}

const React = {
	useState(init) {
		const slots = slotsOf(currentComponent);
		const index = hookIndex;
		hookIndex += 1;
		if (!(index in slots)) slots[index] = typeof init === "function" ? init() : init;
		return [slots[index], (value) => {
			slots[index] = typeof value === "function" ? value(slots[index]) : value;
		}];
	},
	useMemo(fn, deps) {
		const slots = slotsOf(currentComponent);
		const index = hookIndex;
		hookIndex += 1;
		const cell = slots[index];
		if (cell === undefined || !sameDeps(cell.deps, deps)) slots[index] = { deps, value: fn() };
		return slots[index].value;
	},
	useCallback(fn, deps) {
		return React.useMemo(() => fn, deps);
	},
	useRef(init) {
		const slots = slotsOf(currentComponent);
		const index = hookIndex;
		hookIndex += 1;
		if (!(index in slots)) slots[index] = { current: init };
		return slots[index];
	},
	useEffect() {
		hookIndex += 1;
	},
};

const FRAGMENT = Symbol("Fragment");
const jsx = (type, props, key) => ({ type, props: props ?? {}, key });
const jsxs = jsx;

// ------------------------------------------------------------------ 假浏览器

const injectedStyles = [];
const store = new Map();

globalThis.Element = class Element {};
globalThis.document = {
	head: { appendChild: (tag) => injectedStyles.push(tag) },
	createElement: () => ({ dataset: {}, textContent: "" }),
	querySelector: () => null,
};
globalThis.window = {
	__ModuleLoader__: { load: (registration) => { globalThis.__registered = registration; } },
	innerWidth: 1440,
	innerHeight: 900,
	addEventListener: () => {},
	removeEventListener: () => {},
	setInterval: () => 0,
	clearInterval: () => {},
	localStorage: {
		getItem: (key) => (store.has(key) ? store.get(key) : null),
		setItem: (key, value) => { store.set(key, value); },
	},
};

await import(pathToFileURL(bundlePath).href);

const registration = globalThis.__registered;
const requireStub = (spec) => {
	if (spec === "react") return React;
	if (spec === "react/jsx-runtime") return { jsx, jsxs, Fragment: FRAGMENT };
	throw new Error("bundle require 了未声明的模块: " + spec);
};

// ------------------------------------------------------------------ 渲染工具

function render(node) {
	if (node === null || node === undefined || typeof node === "boolean") return null;
	if (Array.isArray(node)) return node.map((child) => render(child));
	if (typeof node !== "object") return node;
	const { type, props } = node;
	if (type === FRAGMENT) return render(props.children);
	if (typeof type === "function") {
		const outerComponent = currentComponent;
		const outerIndex = hookIndex;
		currentComponent = type;
		hookIndex = 0;
		const output = type(props ?? {});
		currentComponent = outerComponent;
		hookIndex = outerIndex;
		return render(output);
	}
	return { type, props: { ...props, children: render(props.children) } };
}

function walk(node, visit) {
	if (node === null || node === undefined || typeof node === "boolean") return;
	if (Array.isArray(node)) {
		for (const child of node) walk(child, visit);
		return;
	}
	if (typeof node !== "object") return;
	visit(node);
	walk(node.props?.children, visit);
}

function findAll(tree, predicate) {
	const found = [];
	walk(tree, (node) => {
		if (predicate(node)) found.push(node);
	});
	return found;
}

const byClass = (tree, className) => findAll(tree, (node) => node.props?.className === className);

// ------------------------------------------------------------------ 结论收集

const results = [];
function check(name, ok, detail) {
	results.push({ name, ok: ok === true, detail });
}

// ------------------------------------------------------------------ 1. 注册契约

check("bundle 注册了正确的插件 id", registration?.id === "dsh-subagent-panel",
	"id=" + String(registration?.id));
check("注册的是一个 factory", typeof registration?.factory === "function");

const plugin = registration.factory(requireStub);
check("factory 返回 apply/inject", typeof plugin.apply === "function" && Array.isArray(plugin.inject),
	"inject=" + JSON.stringify(plugin.inject));
check("声明了 slots 与 sessions 两个客户端服务",
	plugin.inject.includes("slots") && plugin.inject.includes("sessions"));
check("CSS 在 factory 内注入了一次", injectedStyles.length === 1 && injectedStyles[0].textContent.includes(".sap-card"));
check("CSS 挂上 data-plugin(HMR 才能回收)", injectedStyles[0].dataset.plugin === "dsh-subagent-panel");
check("CSS 没有残留未替换的模板占位", !injectedStyles[0].textContent.includes("${"));
check("CSS:自带两套主题色板(浅色默认 + data-ds-dark-theme 覆盖)",
	injectedStyles[0].textContent.includes("body[data-ds-dark-theme] .sap-root")
	&& injectedStyles[0].textContent.includes("--sap-fg: #10141a"));
check("CSS:浅色下把宿主的告警主色压深(全 GUI 橙色告警文字原来只有 2.15:1)",
	injectedStyles[0].textContent.includes("body:not([data-ds-dark-theme]) { --dsw-alias-state-warn-primary: #8a4700; }"));
check("CSS:缩放用 zoom(不留透明挡点击的空盒子)",
	injectedStyles[0].textContent.includes(".sap-zoom { zoom: var(--sap-zoom, 1); }"));
check("CSS:告警条带底色 + 左边条,不只靠颜色",
	/\.sap-note \{[^}]*background: var\(--sap-warn-bg\)[^}]*border-left-width: 3px/.test(injectedStyles[0].textContent));

// ------------------------------------------------------------------ 2. 席位注册

let registered = null;
let injectedKey = null;
const opened = [];
const ctx = {
	sessions: { open: (id) => { opened.push(id); } },
	slots: {
		inject: (key, callback) => {
			injectedKey = key;
			callback();
		},
		register: (options, component) => {
			registered = { options, component };
		},
	},
};
plugin.apply(ctx);

check("注册进 shell.overlay(帧级悬浮层)", injectedKey === "shell.overlay" && registered?.options?.name === "shell.overlay",
	"key=" + String(injectedKey));
check("列表席位带 id", registered?.options?.id === "dsh-subagent-panel");
check("排序值让卡片叠在宿主条目之后", registered?.options?.order === 1000);
check("注册了一个组件函数", typeof registered?.component === "function");
const api = registered.options.inject();
check("inject() 暴露 api.open", typeof api.api?.open === "function");

// ------------------------------------------------------------------ 3. 数据整形(纯逻辑)

const logic = plugin.logic;
const t0 = Date.parse("2026-09-11T10:00:00.000Z");
const now = t0 + 125000;

check("fmtDuration 输出 2m05s", logic.fmtDuration(125000) === "2m05s", logic.fmtDuration(125000));
check("fmtRemain 显示剩余", logic.fmtRemain(t0 + 300000, now) === "剩 2m55s", logic.fmtRemain(t0 + 300000, now));
check("fmtRemain 显示超时", logic.fmtRemain(t0 - 5000, now) === "超时 2m10s", logic.fmtRemain(t0 - 5000, now));
check("fmtBytes 人类可读", logic.fmtBytes(2048) === "2.0K" && logic.fmtBytes(512) === "512B",
	logic.fmtBytes(2048) + "/" + logic.fmtBytes(512));
check("basenameOf 取工作区名", logic.basenameOf("D:\\work\\demo") === "demo", logic.basenameOf("D:\\work\\demo"));

const runningRecord = {
	id: "session-a",
	running: true,
	title: "⚡ Cursor · 修复分页",
	projectionValues: {
		"dsh-subagent": {
			jobId: "20260911-100000-aaaa",
			caller: "cursor-vscode",
			callerLabel: "Cursor",
			title: "修复分页",
			status: "running",
			running: true,
			workspace: "D:\\work\\demo",
			startedAt: "2026-09-11T10:00:00.000Z",
			expectedSeconds: 300,
			deadlineAt: "2026-09-11T10:05:00.000Z",
			progressBytes: 18474,
			acceptance: "只输出一行 FREEZE-DONE",
			recentLines: ["正在追加第 131 段", "打开 _lark_build/s_append2.sh"],
		},
	},
};
const entry = logic.entryOf(runningRecord, now);
check("entryOf 读到调用方分组键", entry?.caller === "cursor-vscode" && entry.glyph === "⌖");
check("entryOf 计算 tone=running", entry?.tone === "run");
check("entryOf 计算进度比", Math.abs(entry.progressRatio - 125 / 300) < 0.001, String(entry.progressRatio));
check("entryOf 把 ISO 时间转成毫秒", entry?.startedAt === t0 && entry?.deadlineAt === t0 + 300000);
check("entryOf 忽略非子代理会话", logic.entryOf({ id: "session-x", running: true }, now) === null);
check("投影缺失时用标题前缀兜底",
	logic.entryOf({ id: "session-y", title: "⚡ Codex · 老任务" }, now)?.caller === "unknown");
check("调用方标签映射", logic.callerLabelOf("codex-mcp-client") === "Codex"
	&& logic.callerLabelOf("weird-client") === "weird-client");

const groups = logic.groupByCaller([
	entry,
	{ ...entry, id: "session-b", caller: "claude-code", callerLabel: "Claude Code", glyph: "✳" },
	{ ...entry, id: "session-c", caller: "cursor-vscode", running: false, tone: "ok" },
]);
check("分组按活跃数排序", groups.length === 2 && groups[0].key === "cursor-vscode" && groups[0].active === 1 && groups[0].total === 2,
	groups.map((g) => g.key + ":" + g.active + "/" + g.total).join(","));
check("组内运行中的排前面", groups[0].entries[0].id === "session-a");

// ------------------------------------------------- token 用量(卡片底部状态条)
check("fmtTokens 紧凑口径与宿主一致(517 / 12.2K / 517K / 1.2M)",
	logic.fmtTokens(517) === "517" && logic.fmtTokens(12200) === "12.2K"
	&& logic.fmtTokens(517000) === "517K" && logic.fmtTokens(1200000) === "1.2M",
	[logic.fmtTokens(517), logic.fmtTokens(12200), logic.fmtTokens(517000), logic.fmtTokens(1200000)].join(" / "));

// 外部任务:宿主没加载过它们的会话,用量来自观察器折叠会话日志后写进投影的那份
const usageRecord = {
	id: "session-u",
	running: true,
	projectionValues: {
		"dsh-subagent": {
			caller: "codex-mcp-client",
			callerLabel: "Codex",
			title: "长任务",
			status: "running",
			running: true,
			startedAt: new Date(now - 60000).toISOString(),
			usage: {
				uncachedInputTokens: 1000, outputTokens: 636000,
				cacheReadTokens: 109000000, cacheWriteTokens: 0,
				promptTokens: 109001000, totalTokens: 109637000,
			},
		},
	},
};
const usageEntry = logic.entryOf(usageRecord, now);
check("外部任务的用量取自观察器投影(meta.usage)",
	usageEntry?.usage !== null && usageEntry.usage.output === 636000 && usageEntry.usage.fromHost === false,
	JSON.stringify(usageEntry?.usage));
check("缓存命中率用宿主同一个分母(缓存读 / prompt 侧)",
	usageEntry?.usage !== null && usageEntry.usage.cacheRead > usageEntry.usage.input
	&& logic.cacheHitPercent(usageEntry.usage) === "99.9",
	String(logic.cacheHitPercent(usageEntry?.usage)));
check("部分命中绝不显示成 100%(和宿主一样诚实)",
	logic.cacheHitPercent({ prompt: 1000, cacheRead: 997 }) === "99.7"
	&& logic.cacheHitPercent({ prompt: 100000, cacheRead: 99999 }) === "99.9"
	&& logic.cacheHitPercent({ prompt: 1000, cacheRead: 1000 }) === "100",
	[logic.cacheHitPercent({ prompt: 1000, cacheRead: 997 }), logic.cacheHitPercent({ prompt: 100000, cacheRead: 99999 })].join(" / "));
check("没缓存的会话不报命中率", logic.cacheHitPercent({ prompt: 0, cacheRead: 0 }) === null);
check("没有用量的会话 usage 为 null", logic.entryOf(runningRecord, now)?.usage === null);

// 本机子代理:直接读宿主自己的 tokenUsage 投影(和宿主子代理面板同一个数)
const hostUsageRecord = {
	id: "session-native",
	projectionValues: {
		"dsh-subagent": { caller: "unknown", title: "本机", startedAt: new Date(now).toISOString() },
		tokenUsage: { uncachedInputTokens: 12000, outputTokens: 451, cacheReadTokens: 88000, cacheWriteTokens: 0 },
	},
};
const hostUsageEntry = logic.entryOf(hostUsageRecord, now);
check("宿主会话优先读标准 tokenUsage 投影且能算出 prompt 侧",
	hostUsageEntry?.usage?.fromHost === true && hostUsageEntry.usage.prompt === 100000
	&& hostUsageEntry.usage.total === 100451,
	JSON.stringify(hostUsageEntry?.usage));

const usageSum = logic.sumUsage([usageEntry, hostUsageEntry, entry]);
check("底部状态条把多个会话合计(并且跳过没有用量的)",
	usageSum?.input === 13000 && usageSum?.output === 636451 && usageSum?.count === 2,
	JSON.stringify(usageSum));
check("合计后仍能算缓存命中率",
	logic.cacheHitPercent(usageSum) === "100" || logic.cacheHitPercent(usageSum) === "99.9",
	String(logic.cacheHitPercent(usageSum)));

// 吞吐:**只认观察器按真实时间窗算出来的数**,客户端不再自己每秒采样 Δ输出/Δt。
// 踩过:客户端每秒采一次 + 用量成块更新 ⇒ "2 秒里跳 6000 token"被算成 3000 tok/s。
check("没有 tokensPerSecond 的用量一律不报速率(客户端不再自己猜)",
	logic.entryOf(usageRecord, now)?.usage?.tps === 0
	&& logic.collect(["session-u"], { "session-u": usageRecord }, null, now)[0]?.tps === 0);
const rateRecord = {
	...usageRecord,
	projectionValues: {
		"dsh-subagent": {
			...usageRecord.projectionValues["dsh-subagent"],
			usage: { ...usageRecord.projectionValues["dsh-subagent"].usage, tokensPerSecond: 168.5, rateWindowMs: 12000 },
		},
	},
};
const rateEntry = logic.entryOf(rateRecord, now);
check("观察器给了速率就原样用(不放大也不缩小)",
	rateEntry?.usage?.tps === 168.5 && rateEntry.tps === 0, String(rateEntry?.usage?.tps));
const rateCollected = logic.collect(["session-r"], { "session-r": rateRecord }, null, now)[0];
check("运行中 + 观察器给了速率 → 磁贴/状态条才有 tok/s", rateCollected?.tps === 168.5, String(rateCollected?.tps));
const idleRate = logic.collect(["session-r"], {
	"session-r": {
		...rateRecord,
		running: false,
		projectionValues: {
			"dsh-subagent": { ...rateRecord.projectionValues["dsh-subagent"], running: false, status: "ok" },
		},
	},
}, null, now)[0];
check("已经跑完的会话不再显示 tok/s(速率只在跑动时有意义)", idleRate?.tps === 0, String(idleRate?.tps));
check("合计只累计在跑且真有速率的会话",
	logic.sumUsage([rateCollected, hostUsageEntry])?.tps === 168.5
	&& logic.sumUsage([rateCollected, hostUsageEntry])?.live === 1,
	String(logic.sumUsage([rateCollected, hostUsageEntry])?.tps));

// ------------------------------------------------------------------ 4. 渲染行为

const sessionsState = {
	ids: ["session-a", "session-b", "session-c"],
	byId: {
		"session-a": runningRecord,
		"session-b": {
			id: "session-b",
			running: true,
			projectionValues: {
				"dsh-subagent": {
					jobId: "20260911-100100-bbbb",
					caller: "claude-code",
					callerLabel: "Claude Code",
					title: "重构导入流程",
					status: "running",
					running: true,
					startedAt: "2026-09-11T10:01:00.000Z",
					expectedSeconds: 600,
					deadlineAt: "2026-09-11T10:11:00.000Z",
					progressBytes: 4096,
				},
			},
		},
		"session-c": {
			id: "session-c",
			running: false,
			projectionValues: {
				"dsh-subagent": {
					jobId: "20260911-095900-cccc",
					caller: "cursor-vscode",
					callerLabel: "Cursor",
					title: "已完成的旧任务",
					status: "ok",
					running: false,
					startedAt: "2026-09-11T09:59:00.000Z",
					finishedAt: "2026-09-11T10:00:00.000Z",
				},
			},
		},
		"session-plain": { id: "session-plain", running: false, displayTitle: "普通对话" },
	},
	current: "session-b",
};

// 底部状态条:两个运行中的任务各带用量,验它真的按
// `tok/s | 缓存命中 % | 输入 N tok · 输出 M tok` 渲染出来(用户点名的格式)。
const usageStatsProps = {
	api: api.api,
	useSessions: (selector) => selector({
		...sessionsState,
		byId: {
			...sessionsState.byId,
			"session-a": {
				...runningRecord,
				projectionValues: {
					...runningRecord.projectionValues,
					"dsh-subagent": {
						...runningRecord.projectionValues["dsh-subagent"],
						usage: { uncachedInputTokens: 1000, outputTokens: 636000, cacheReadTokens: 108999000, cacheWriteTokens: 0, promptTokens: 109000000, totalTokens: 109635000 },
					},
				},
			},
			"session-b": {
				...sessionsState.byId["session-b"],
				projectionValues: {
					"dsh-subagent": sessionsState.byId["session-b"].projectionValues["dsh-subagent"],
					tokenUsage: { uncachedInputTokens: 4000, outputTokens: 12000, cacheReadTokens: 996000, cacheWriteTokens: 0 },
				},
			},
		},
	}),
	useWorkspaces: () => [],
	useSessionPendingInteraction: () => undefined,
};
const treeStats = render(jsx(registered.component, usageStatsProps));
const statsNode = byClass(treeStats, "sap-stats")[0];
const statsText = JSON.stringify(statsNode?.props.children ?? []);
check("底部有状态条(sap-stats)", statsNode !== undefined);
check("状态条有『输入 … tok · 输出 … tok』",
	statsText.includes("输入 5K tok · 输出 648K tok"), statsText.slice(0, 400));
check("状态条有缓存命中率", statsText.includes("缓存命中 99.9%"), statsText.slice(0, 200));
check("状态条有 tok/s(待机时显示 —)", statsText.includes("tok/s"), statsText.slice(0, 200));
check("状态条用 | 分隔(和用户给的格式一致)",
	JSON.stringify(statsNode?.props.children).includes("|"));
check("合计把两条数据源都算进去(观察器投影 + 宿主 tokenUsage)",
	typeof statsNode?.props.title === "string" && statsNode.props.title.includes("累计 2 个会话"),
	statsNode?.props.title);

const panelProps = {
	api: api.api,
	useSessions: (selector) => selector(sessionsState),
	useWorkspaces: () => [],
	useSessionPendingInteraction: () => undefined,
};
const tree = render(jsx(registered.component, panelProps));

check("卡片渲染出来", byClass(tree, "sap-card").length === 1);
check("默认只显示活跃任务:2 个分组", byClass(tree, "sap-folder").length === 2,
	"folders=" + byClass(tree, "sap-folder").length);
const activeTiles = byClass(tree, "sap-tile");
check("默认只显示活跃会话:2 个磁贴", activeTiles.length === 2, "tiles=" + activeTiles.length);
check("活跃分组默认展开", byClass(tree, "sap-grid").length === 2);
check("活跃数显示在头部", byClass(tree, "sap-live")[0]?.props.children?.[1] === "2 活跃",
	String(byClass(tree, "sap-live")[0]?.props.children?.[1]));
check("运行中的磁贴带扫描动效标记", activeTiles.every((tile) => tile.props["data-tone"] === "run"));
check("当前会话磁贴被标记", activeTiles.some((tile) => tile.props["data-current"] === "true"));
const tileOfA = activeTiles.find((tile) => String(tile.props.title).includes("20260911-100000-aaaa"));
check("磁贴带悬停详情(job 号 / 工作区)",
	tileOfA !== undefined && String(tileOfA.props.title).includes("D:\\work\\demo"),
	tileOfA === undefined ? "未找到 session-a 的磁贴" : String(tileOfA.props.title).split("\n")[1]);
check("运行中磁贴的提示写明不直接打开", tileOfA !== undefined
	&& String(tileOfA.props.title).includes("运行中的外部会话不直接打开"));

// 点击**运行中**的任务:不能走 sessions.open(宿主打开=接管写权,会写坏外部会话日志)
tileOfA.props.onClick();
check("运行中的任务不被 sessions.open", opened.length === 0, JSON.stringify(opened));
const treeDetail = render(jsx(registered.component, panelProps));
check("运行中的任务打开只读详情页", byClass(treeDetail, "sap-drawer").length === 1);
check("详情页有返回按钮", byClass(treeDetail, "sap-drawer-head").length === 1);
check("详情页主打开按钮在运行中禁用",
	byClass(treeDetail, "sap-btn").some((button) => button.props.disabled === true
		&& String(button.props.children).includes("运行中不可用")));
check("详情页显示实时输出行(子代理正在干什么)",
	byClass(treeDetail, "sap-log").length >= 1
	&& JSON.stringify(byClass(treeDetail, "sap-log")[0].props.children).includes("正在追加第 131 段"));
check("详情页显示任务号与工作区",
	byClass(treeDetail, "sap-kv").length === 1
	&& JSON.stringify(byClass(treeDetail, "sap-kv")[0].props.children).includes("20260911-100000-aaaa"));
check("详情页提示会话转录不随外部进程增长",
	byClass(treeDetail, "sap-note").some((note) => JSON.stringify(note.props.children).includes("不会随外部进程增长")));

// 详情页里的"仍要打开"需要二次确认
const forceButton = byClass(treeDetail, "sap-btn").find((button) => String(button.props.children).includes("仍要打开"));
check("有损打开按钮存在且标红", forceButton !== undefined && forceButton.props["data-danger"] === "true");
forceButton.props.onClick();
check("第一次点击只是进入确认态,不打开", opened.length === 0, JSON.stringify(opened));
const treeArmed = render(jsx(registered.component, panelProps));
const armedButton = byClass(treeArmed, "sap-btn").find((button) => String(button.props.children).includes("确认有损打开"));
check("确认态按钮文案变化", armedButton !== undefined);
armedButton.props.onClick();
check("二次确认后才真正打开", opened.length === 1 && opened[0] === "session-a", JSON.stringify(opened));
opened.length = 0;

// 返回分组视图
const backButton = byClass(treeArmed, "sap-btn").find((button) => String(button.props.children).includes("返回"));
backButton.props.onClick();
const treeBack = render(jsx(registered.component, panelProps));
check("返回后回到分组视图", byClass(treeBack, "sap-drawer").length === 0 && byClass(treeBack, "sap-folder").length === 2);

// 切到「全部」→ 已完成任务出现
const historyButton = byClass(tree, "sap-btn").find((button) => button.props.title === "显示已结束");
check("找到历史开关按钮", historyButton !== undefined);
historyButton.props.onClick();
const tree2 = render(jsx(registered.component, panelProps));
check("切到全部后显示 3 个磁贴", byClass(tree2, "sap-tile").length === 3,
	"tiles=" + byClass(tree2, "sap-tile").length);
check("已完成会话 tone=ok", byClass(tree2, "sap-tile").some((tile) => tile.props["data-tone"] === "ok"));
check("头部显示 2/3", byClass(tree2, "sap-live")[0]?.props.children?.[1] === "2/3 活跃",
	String(byClass(tree2, "sap-live")[0]?.props.children?.[1]));
check("只有活跃组默认展开", byClass(tree2, "sap-grid").length === 2,
	"grids=" + byClass(tree2, "sap-grid").length);

// 点击**已结束**的任务:与普通会话完全一致
const doneTile = byClass(tree2, "sap-tile").find((tile) => tile.props["data-tone"] === "ok");
check("已结束磁贴的提示写明与普通会话一致",
	doneTile !== undefined && String(doneTile.props.title).includes("与普通会话完全一致"));
doneTile.props.onClick();
check("点击已结束任务直接 sessions.open", opened.length === 1 && opened[0] === "session-c",
	JSON.stringify(opened));

// 折叠
const collapseButton = byClass(tree2, "sap-btn").find((button) => button.props.title === "收起");
collapseButton.props.onClick();
const tree3 = render(jsx(registered.component, panelProps));
check("折叠后只留头部", byClass(tree3, "sap-body").length === 0 && byClass(tree3, "sap-head").length === 1);

// 缩放:−/+ 步进、百分比可点、上下限夹紧
hookSlots.clear();
const treeZoom0 = render(jsx(registered.component, panelProps));
const zoomOf = (tree) => {
	const root = byClass(tree, "sap-root")[0];
	return root?.props?.style?.["--sap-zoom"];
};
check("默认 100%", zoomOf(treeZoom0) === "1", String(zoomOf(treeZoom0)));
check("百分比按钮显示 100%", byClass(treeZoom0, "sap-zoomval")[0]?.props.children === "100%",
	String(byClass(treeZoom0, "sap-zoomval")[0]?.props.children));
check("缩放外壳存在(zoom 只作用于内容,不挡点击)",
	byClass(treeZoom0, "sap-zoom").length === 1);
const zoomIn = byClass(treeZoom0, "sap-btn").find((button) => button.props.title.startsWith("放大"));
const zoomOut = byClass(treeZoom0, "sap-btn").find((button) => button.props.title.startsWith("缩小"));
check("找到放大/缩小按钮", zoomIn !== undefined && zoomOut !== undefined);
zoomIn.props.onClick();
zoomIn.props.onClick();
const treeZoom2 = render(jsx(registered.component, panelProps));
check("放大两步到 120%", zoomOf(treeZoom2) === "1.2", String(zoomOf(treeZoom2)));
// 连点到上限:1.2 → 1.6 之后不再涨
for (let index = 0; index < 8; index += 1) {
	byClass(treeZoom2, "sap-btn").find((button) => button.props.title.startsWith("放大")).props.onClick();
}
const treeZoomMax = render(jsx(registered.component, panelProps));
check("放大夹紧在 200%(上限放开了,方便把卡片当主监视窗)", zoomOf(treeZoomMax) === "2", String(zoomOf(treeZoomMax)));
byClass(treeZoomMax, "sap-btn").find((button) => button.props.title.startsWith("缩小")).props.onClick();
for (let index = 0; index < 30; index += 1) {
	byClass(treeZoomMax, "sap-btn").find((button) => button.props.title.startsWith("缩小")).props.onClick();
}
const treeZoomMin = render(jsx(registered.component, panelProps));
check("缩小夹紧在 60%(最小)", zoomOf(treeZoomMin) === "0.6", String(zoomOf(treeZoomMin)));
const persisted = JSON.parse(store.get("dsh.subagent.panel.v1") ?? "{}");
check("缩放写进了 localStorage", persisted.zoom === 0.6, JSON.stringify(persisted));
byClass(treeZoomMin, "sap-zoomval")[0].props.onClick();
const treeZoomReset = render(jsx(registered.component, panelProps));
check("点百分比复位 100%", zoomOf(treeZoomReset) === "1", String(zoomOf(treeZoomReset)));

// 自由改尺寸:三个把手(右=宽、下=高、右下角=宽高一起),标题不再被挤掉
const grips = byClass(treeZoomReset, "sap-grip");
check("有改尺寸的把手(右/下/右下角 = 像真窗口那样拉)",
	grips.length === 3 && grips.map((grip) => grip.props["data-axis"]).sort().join(",") === "x,xy,y",
	JSON.stringify(grips.map((grip) => grip.props["data-axis"])));
const cornerGrip = grips.find((grip) => grip.props["data-axis"] === "xy");
check("右下角把手说明是**自由缩放**且双击恢复默认",
	typeof cornerGrip?.props.title === "string" && cornerGrip.props.title.includes("自由缩放")
	&& cornerGrip.props.title.includes("双击"),
	cornerGrip?.props.title);
const widthGrip = grips.find((grip) => grip.props["data-axis"] === "x");
check("右边把手说明拉宽后每行能多放磁贴(这正是用户要的)",
	typeof widthGrip?.props.title === "string" && widthGrip.props.title.includes("宽度")
	&& widthGrip.props.title.includes("多放"),
	widthGrip?.props.title);
check("拉宽光标是 ew-resize / 拉高是 ns-resize(CSS)",
	injectedStyles[0].textContent.includes("cursor: ew-resize")
	&& injectedStyles[0].textContent.includes("cursor: ns-resize"));
check("列数跟着卡片宽度走(auto-fill,拉宽自动多排)",
	injectedStyles[0].textContent.includes("repeat(auto-fill, minmax(132px, 1fr))"));
check("卡片尺寸走 CSS 变量(宽/高分开,不是等比例)",
	injectedStyles[0].textContent.includes("width: var(--sap-w, 300px)")
	&& injectedStyles[0].textContent.includes("height: var(--sap-h, auto)"));
check("拉过高之后内容区滚动、头尾固定",
	injectedStyles[0].textContent.includes('.sap-root[data-sized="true"] .sap-body { max-height: none; }')
	&& injectedStyles[0].textContent.includes("flex: 1 1 auto"));
check("头部允许换行(挤不下时控件换行,而不是把标题裁掉)",
	injectedStyles[0].textContent.includes("flex-wrap: wrap"));
check("标题仍然不参与收缩且完整",
	injectedStyles[0].textContent.includes("flex: none") && byClass(treeZoomReset, "sap-brand")[0]?.props.children === "Subagent",
	String(byClass(treeZoomReset, "sap-brand")[0]?.props.children));

// 详情页里"告警"必须看得出来:文字行带 data-tone,提示条自带 warn/err 底色
// (fixture 里的 current 是 session-b,所以改它 —— data-current 的磁贴就是它)
hookSlots.clear();
const overdueState = {
	...sessionsState,
	byId: {
		...sessionsState.byId,
		"session-b": {
			...sessionsState.byId["session-b"],
			projectionValues: {
				"dsh-subagent": {
					...sessionsState.byId["session-b"].projectionValues["dsh-subagent"],
					expectedSeconds: 60,
					startedAt: new Date(Date.now() - 5 * 60000).toISOString(),
					deadlineAt: new Date(Date.now() - 4 * 60000).toISOString(),
					lastProgressAt: new Date(Date.now() - 3 * 60000).toISOString(),
					error: "子进程已消失",
				},
			},
		},
	},
};
const overdueProps = { ...panelProps, useSessions: (selector) => selector(overdueState) };
const treeOverdueList = render(jsx(registered.component, overdueProps));
const overdueTile = byClass(treeOverdueList, "sap-tile").find((tile) => tile.props["data-current"] === "true");
check("超时的运行中任务仍可点进详情", overdueTile !== undefined);
overdueTile.props.onClick();
const treeOverdue = render(jsx(registered.component, overdueProps));
const kvTones = (byClass(treeOverdue, "sap-kv")[0]?.props.children ?? [])
	.map((child) => child?.props?.["data-tone"]).filter(Boolean);
check("超时行标 err、久未增长行标 warn", kvTones.includes("err") && kvTones.includes("warn"),
	JSON.stringify(kvTones));
check("错误提示条带 err 色调",
	byClass(treeOverdue, "sap-note").some((note) => note.props["data-tone"] === "err"));

// 本机 DSH 子代理(同进程):和外部 dsh_task 并列显示,递归层级可见
const nativeCatalogs = {
	"session-b": {
		state: "ready",
		entries: [
			{ kind: "child", id: "session-native-1", activity: "running", hasChildren: true, label: "Harden bridge", mode: "continuable" },
			{ kind: "child", id: "session-native-2", activity: "inactive", hasChildren: false, mode: "one-shot" },
			{ kind: "diagnostic", id: "session-native-broken", reason: "corrupt" },
		],
	},
	"session-native-1": {
		state: "ready",
		entries: [
			{ kind: "child", id: "session-native-1a", activity: "running", hasChildren: false, label: "Recon subagent UI", mode: "one-shot" },
		],
	},
};
const nativeState = {
	...sessionsState,
	byId: {
		...sessionsState.byId,
		"session-native-2": { id: "session-native-2", running: false, displayTitle: "没写 label 的那种" },
	},
	subagentsByParent: nativeCatalogs,
};
const nativeProps = { ...panelProps, useSessions: (selector) => selector(nativeState) };
const nativeLogic = logic.nativeEntriesOf(nativeCatalogs, nativeState.byId, Date.now());
check("本机子代理被读出来(诊断条目被跳过)", nativeLogic.length === 3,
	"n=" + nativeLogic.length + " " + nativeLogic.map((entry) => entry.id).join(","));
check("本机子代理归到「本机 DSH 子代理」分组",
	nativeLogic.every((entry) => entry.caller === logic.NATIVE_CALLER && entry.callerLabel === "本机 DSH 子代理"
		&& entry.glyph === "✦"));
check("递归层级能算出来:L1 → L2", nativeLogic.find((entry) => entry.id === "session-native-1")?.depth === 1
	&& nativeLogic.find((entry) => entry.id === "session-native-1a")?.depth === 2,
	nativeLogic.map((entry) => entry.id + ":L" + entry.depth).join(" "));
check("还有下一层的子代理被标记", nativeLogic.find((entry) => entry.id === "session-native-1")?.hasChildren === true);
check("运行状态取自目录 activity", nativeLogic.find((entry) => entry.id === "session-native-1")?.running === true
	&& nativeLogic.find((entry) => entry.id === "session-native-2")?.running === false);
check("没有 label 时退回会话显示名",
	nativeLogic.find((entry) => entry.id === "session-native-2")?.title === "没写 label 的那种");

hookSlots.clear();
const treeNativeList = render(jsx(registered.component, nativeProps));
const groupNames = byClass(treeNativeList, "sap-folder-name").map((name) => name.props.children);
check("卡片里出现「本机 DSH 子代理」分组", groupNames.includes("本机 DSH 子代理"), JSON.stringify(groupNames));
// 默认只显示活跃:不活跃的那个本机子代理不该出现
const nativeTiles = byClass(treeNativeList, "sap-tile").filter((tile) => tile.props["data-native"] === "true");
check("默认只显示活跃的本机子代理(2 个在跑)", nativeTiles.length === 2, "tiles=" + nativeTiles.length);
const chipTexts = byClass(treeNativeList, "sap-chip").map((chip) => chip.props.children).join("|");
check("磁贴带层级徽标 L1/L2 与「还有下一层」标记",
	chipTexts.includes("L1 ⊞") && chipTexts.includes("L2"), chipTexts);
check("本机子代理的提示写明是第几层、归属谁",
	String(nativeTiles[0]?.props.title ?? "").includes("第 1 层")
	&& String(nativeTiles[0]?.props.title ?? "").includes("所属"));
check("卡片底部标注外部任务与本机子代理数量",
	byClass(treeNativeList, "sap-foot")[0] !== undefined
	&& JSON.stringify(byClass(treeNativeList, "sap-foot")[0].props.children).includes("本机子代理"));
// 本机子代理同进程:点它就是普通打开(不像外部运行中任务那样拦)
const openedBefore = opened.length;
const runningNativeTile = nativeTiles.find((tile) => tile.props["data-tone"] === "run");
runningNativeTile.props.onClick();
check("点运行中的本机子代理 = 直接打开会话(同进程,宿主自己也这么做)",
	opened.length === openedBefore + 1 && opened.at(-1) === "session-native-1",
	JSON.stringify(opened));
check("api 暴露了拉取子代理目录的通道",
	typeof api.api.refreshSubagents === "function");

// 空态(先清掉上面几次交互留下的组件状态,模拟页面刚刷新)
hookSlots.clear();
const emptyProps = {
	...panelProps,
	useSessions: (selector) => selector({ ids: ["session-plain"], byId: sessionsState.byId, current: undefined }),
};
const tree4 = render(jsx(registered.component, emptyProps));
check("无子代理任务时显示雷达空态", byClass(tree4, "sap-radar").length === 1
	&& byClass(tree4, "sap-empty").length === 1);
check("空态文案就是一句「无活跃子代理」(不再缀「雷达静默」)",
	byClass(tree4, "sap-empty-text")[0]?.props.children === "无活跃子代理",
	String(byClass(tree4, "sap-empty-text")[0]?.props.children));
check("空态在内容区里真正居中(水平 + 垂直,窗口拉高也不贴顶)",
	injectedStyles[0].textContent.includes("align-items: center; justify-content: center")
	&& injectedStyles[0].textContent.includes("flex: 1 1 auto; min-height: 104px"),
	injectedStyles[0].textContent.includes("justify-content: center") ? "ok" : "缺 justify-content");

// 宿主没提供 useSessions 时:退化成空态,绝不抛异常(否则会把宿主界面弄坏)
hookSlots.clear();
const noHookProps = { api: api.api };
let degraded = null;
let threw = false;
try {
	degraded = render(jsx(registered.component, noHookProps));
} catch (error) {
	threw = true;
	console.error(error);
}
check("缺少标准钩子时不抛异常且退化成空态",
	threw === false && degraded !== null && byClass(degraded, "sap-empty").length === 1);

// ------------------------------------------------------------------ 输出

let failed = 0;
for (const item of results) {
	if (!item.ok) failed += 1;
	const detail = item.detail === undefined ? "" : "  (" + item.detail + ")";
	console.log((item.ok ? "✅ " : "❌ ") + item.name + detail);
}
console.log("\n" + (results.length - failed) + "/" + results.length + " 通过");
process.exit(failed === 0 ? 0 : 1);
