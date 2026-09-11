/**
 * 启动图探针:验证客户端插件真的进入了浏览器 __DSH_BOOT__ 图,并且 bundle 能被取到。
 *
 * 用法:node test/gui-graph-probe.mjs <baseUrl> [期望的插件 id]
 *   baseUrl 例:http://127.0.0.1:34199/?token=xxxx
 *
 * 它做四件事:
 *   1. 用一次性 token 换签名 cookie(浏览器会自动带,node fetch 不会,所以要手工搬运);
 *   2. 取首页 HTML,抠出 globalThis["__DSH_BOOT__"] 的完整字面量并解析;
 *   3. 打印图里的客户端插件清单,检查目标插件是否在列;
 *   4. 取该插件的 /plugins 组合 URL,确认 200 且内容里带着插件自己的标记字符串。
 */
const base = process.argv[2];
const wanted = process.argv[3] ?? "dsh-subagent-panel";
const marker = process.argv[4] ?? "window.__ModuleLoader__.load";

if (base === undefined) {
	console.error("用法: node test/gui-graph-probe.mjs <baseUrl> [插件id] [标记字符串]");
	process.exit(2);
}

const origin = new URL(base).origin;
const results = [];
const check = (name, ok, detail) => {
	results.push({ name, ok: ok === true });
	console.log((ok ? "[OK] " : "[NG] ") + name + (detail === undefined ? "" : "  (" + detail + ")"));
};

/** dsh web 的鉴权是「一次性 token 换签名 cookie」:带 ?token= 的 GET / 会 303 + Set-Cookie。 */
async function openWithCookie(url) {
	const first = await fetch(url, { redirect: "manual" });
	const raw = typeof first.headers.getSetCookie === "function"
		? first.headers.getSetCookie()
		: [first.headers.get("set-cookie")].filter((value) => typeof value === "string");
	const cookie = raw.map((value) => String(value).split(";")[0]).join("; ");
	if (cookie === "") return { response: first, cookie: "" };
	const response = await fetch(origin + "/", { headers: { cookie } });
	return { response, cookie };
}

/** 从 HTML 里按花括号配对抠出注入的启动图对象字面量(正则遇嵌套 JSON 会提前截断)。 */
function extractBootLiteral(text) {
	const anchor = text.indexOf('globalThis["__DSH_BOOT__"]');
	if (anchor < 0) return null;
	const start = text.indexOf("{", anchor);
	if (start < 0) return null;
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = start; i < text.length; i += 1) {
		const ch = text[i];
		if (inString) {
			if (escaped) escaped = false;
			else if (ch === "\\") escaped = true;
			else if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') {
			inString = true;
			continue;
		}
		if (ch === "{") depth += 1;
		else if (ch === "}") {
			depth -= 1;
			if (depth === 0) return text.slice(start, i + 1);
		}
	}
	return null;
}

const { response: indexResponse, cookie } = await openWithCookie(base);
check("首页可访问(换到了签名 cookie)", indexResponse.status === 200,
	"status=" + indexResponse.status + " cookie=" + (cookie === "" ? "无" : "有"));
const html = await indexResponse.text();
check("取到首页 HTML", html.length > 0, html.length + " 字节");
check("首页包含启动图注入", html.includes("__DSH_BOOT__"));

const literal = extractBootLiteral(html);
check("能抠出 __DSH_BOOT__ 字面量", literal !== null);
if (literal === null) {
	console.log("\n结果: 失败(无法解析启动图)");
	process.exitCode = 1;
} else {
	const graph = JSON.parse(literal);
	console.log("   启动图顶层字段: " + Object.keys(graph).join(", "));
	const rows = (graph.entries ?? graph.plugins ?? graph.manifest?.plugins ?? [])
		.map((row) => (typeof row === "string" ? { id: row } : row));
	check("图里有客户端插件清单", rows.length > 0, rows.length + " 个");

	const target = rows.find((row) => row.id === wanted);
	check("目标插件已进入启动图: " + wanted, target !== undefined);
	if (target === undefined) {
		console.log("\n当前清单:\n  " + rows.map((row) => row.id).join("\n  "));
		process.exitCode = 1;
	} else {
		console.log("   目标行: " + JSON.stringify(target));

		const batches = graph.batches ?? [];
		const combo = batches
			.map((batch) => batch.url)
			.find((url) => typeof url === "string" && url.includes(wanted));
		check("该插件的 bundle 被编进了某个 /plugins 组合 URL", combo !== undefined, String(combo));
		if (combo !== undefined) {
			const url = combo.startsWith("http") ? combo : origin + combo;
			const response = await fetch(url, { headers: cookie === "" ? undefined : { cookie } });
			const body = await response.text();
			check("组合 URL 可取 (200)", response.status === 200, "status=" + response.status);
			check("bundle 内容含插件注册标记", body.includes(marker), body.length + " 字节");
			check("bundle 里带着本插件自己的代码", body.includes(wanted));
		}

		const failed = results.filter((item) => item.ok !== true).length;
		console.log("\n" + (results.length - failed) + "/" + results.length + " 通过");
		process.exitCode = failed === 0 ? 0 : 1;
	}
}
