/**
 * 浏览器半边:dsh-subagent-panel —— 悬浮式「子代理星图」卡片。
 *
 * 形态约束(由 dsh-client-modules 决定,不可更改):
 *   - 必须是预构建的纯 JS IIFE,通过 window.__ModuleLoader__.load({ id, factory }) 注册;
 *   - id 必须与 package.json 的 name 完全一致;
 *   - factory(require) 只能 require 平台种子词(react / react/jsx-runtime / ...);
 *   - 所有副作用(含 CSS 注入)必须写在 factory 内部(模块化时才执行)。
 *
 * 数据来源:宿主侧 observer 插件把每个 dsh_task 任务投影成
 *   record.projectionValues['dsh-subagent'] = { jobId, caller, callerLabel, title,
 *     status, running, workspace, startedAt, finishedAt, expectedSeconds, deadlineAt,
 *     lastProgressAt, progressBytes, acceptance, exitCode, error }
 * 并给会话标题打上 "⚡ <调用方> · <标题>" 前缀。卡片优先读投影,投影缺失时
 * 回退到标题前缀(浏览器刷新后投影被基线清空的那一小段时间)。
 */
(() => {
	const PLUGIN_ID = "dsh-subagent-panel";
	const ACCENT = "var(--dsw-static-deepseek-500, #4176e6)";

	// 配色是**自带**的,只借用宿主的字体与阴影 —— 实测宿主 token 不适合做这张卡片:
	//   --dsw-alias-border-inverted 在浅色主题下是 #0000(全透明)⇒ 卡片没有边框;
	//   --dsw-alias-state-warn-primary 在深浅两套主题里都是 amber-500 #f59e0b
	//     (白底对比度约 2.1:1)⇒ "橙色告警几乎看不见"就是这么来的。
	// 这里定义自己的色板,浅色/深色都按 AA 以上对比度取值,跟随宿主 body[data-ds-dark-theme]。
	const CSS = `
.sap-root {
  position: fixed; top: 64px; right: 18px; z-index: 1100;
  width: max-content; max-width: calc(100vw - 36px);
  box-sizing: border-box;
  color: var(--sap-fg);
  font: var(--dsw-font-xs-13, 13px/20px sans-serif);
  /* ——— 浅色(默认);括号里是与白底 #fff 的 WCAG 对比度(实测计算,非估计) ——— */
  --sap-fg: #10141a;          /* 18.5:1 */
  --sap-fg-2: #3c4553;        /* 9.7:1 */
  --sap-fg-3: #566070;        /* 6.4:1 */
  --sap-bg: rgba(255, 255, 255, .97);
  --sap-sunken: #f1f4f9;
  --sap-fill-1: rgba(22, 32, 60, .05);
  --sap-fill-hover: rgba(44, 91, 196, .13);
  --sap-line: rgba(16, 22, 34, .28);
  --sap-line-soft: rgba(16, 22, 34, .15);
  --sap-accent: #2b57bb;      /* 6.6:1 */
  --sap-run: #1959c4;         /* 6.6:1 */
  --sap-ok: #11603a;          /* 7.6:1 */
  --sap-warn: #8a4700;        /* 7.0:1 —— 还是橙的,但白底读得清(旧 token 只有 2.15:1) */
  --sap-warn-bg: #fdf0d9;
  --sap-err: #a5121d;         /* 7.8:1 */
  --sap-err-bg: #fdebeb;
  --sap-tint: rgba(44, 91, 196, .10);
  --sap-grid-line: rgba(44, 91, 196, .13);
  --sap-scan: rgba(44, 91, 196, .07);
  --sap-glow: rgba(44, 91, 196, .12);
  --sap-shadow: 0 14px 34px rgba(15, 23, 42, .22), 0 2px 6px rgba(15, 23, 42, .14);
  --sap-zoom: 1;
}
body[data-ds-dark-theme] .sap-root, [data-ds-dark-theme] .sap-root {
  /* 括号里是与卡片底色 #14171d 的对比度 */
  --sap-fg: #f3f6fb;          /* 16.6:1 */
  --sap-fg-2: #cbd3de;        /* 11.9:1 */
  --sap-fg-3: #a6b0be;        /* 8.2:1 */
  --sap-bg: rgba(20, 23, 29, .97);
  --sap-sunken: #0f1216;
  --sap-fill-1: rgba(255, 255, 255, .07);
  --sap-fill-hover: rgba(122, 168, 255, .18);
  --sap-line: rgba(255, 255, 255, .28);
  --sap-line-soft: rgba(255, 255, 255, .15);
  --sap-accent: #93b7ff;      /* 8.9:1 */
  --sap-run: #78abff;         /* 8.2:1 */
  --sap-ok: #71da95;          /* 10.4:1 */
  --sap-warn: #ffc76f;        /* 11.7:1 */
  --sap-warn-bg: rgba(255, 178, 64, .17);
  --sap-err: #ff9d9d;         /* 9.0:1 */
  --sap-err-bg: rgba(255, 92, 92, .19);
  --sap-tint: rgba(122, 168, 255, .11);
  --sap-grid-line: rgba(150, 190, 255, .11);
  --sap-scan: rgba(150, 190, 255, .09);
  --sap-glow: rgba(122, 168, 255, .16);
  --sap-shadow: 0 16px 40px rgba(0, 0, 0, .58), 0 2px 8px rgba(0, 0, 0, .42);
}
/* 缩放走 zoom:整块布局一起放大缩小(比 transform 好 —— 不留下透明的空盒子挡住点击)。 */
.sap-zoom { zoom: var(--sap-zoom, 1); }
.sap-card {
  position: relative; box-sizing: border-box;
  width: var(--sap-w, 300px); height: var(--sap-h, auto);
  display: flex; flex-direction: column;
  border: 1px solid var(--sap-line);
  border-radius: 12px;
  background:
    radial-gradient(120% 90% at 100% 0%, var(--sap-glow) 0%, rgba(0, 0, 0, 0) 62%),
    var(--sap-bg);
  box-shadow: var(--sap-shadow);
  overflow: hidden;
  isolation: isolate;
  transition: opacity .2s var(--ds-ease-in-out, ease), transform .2s var(--ds-ease-in-out, ease);
}
.sap-card::before {
  content: ""; position: absolute; inset: 0; z-index: 0; pointer-events: none;
  background-image:
    linear-gradient(var(--sap-grid-line) 1px, transparent 1px),
    linear-gradient(90deg, var(--sap-grid-line) 1px, transparent 1px);
  background-size: 22px 22px;
  mask-image: radial-gradient(120% 100% at 0% 0%, #000 30%, transparent 78%);
  -webkit-mask-image: radial-gradient(120% 100% at 0% 0%, #000 30%, transparent 78%);
}
.sap-card::after {
  content: ""; position: absolute; left: 0; right: 0; top: 0; height: 42%; z-index: 0; pointer-events: none;
  background: linear-gradient(180deg, var(--sap-scan) 0%, rgba(0, 0, 0, 0) 100%);
  transform: translateY(-120%);
  animation: sap-scan 5.6s var(--ds-ease-in-out, ease) infinite;
}
@keyframes sap-scan {
  0% { transform: translateY(-120%); opacity: 0; }
  22% { opacity: .75; }
  100% { transform: translateY(260%); opacity: 0; }
}
.sap-corner {
  position: absolute; width: 9px; height: 9px; z-index: 2; pointer-events: none;
  border: 1px solid var(--sap-accent); opacity: .8;
}
.sap-corner[data-at="tl"] { top: 4px; left: 4px; border-right: 0; border-bottom: 0; }
.sap-corner[data-at="tr"] { top: 4px; right: 4px; border-left: 0; border-bottom: 0; }
.sap-corner[data-at="bl"] { bottom: 4px; left: 4px; border-right: 0; border-top: 0; }
.sap-corner[data-at="br"] { bottom: 4px; right: 4px; border-left: 0; border-top: 0; }

/* 改尺寸的三个把手:右边改宽、下边改高、右下角两个方向一起改(自由缩放,不是等比例)。 */
.sap-grip {
  position: absolute; z-index: 3; opacity: .7;
}
.sap-grip[data-axis="x"] { top: 26px; bottom: 22px; right: 0; width: 6px; cursor: ew-resize;
  background: linear-gradient(90deg, transparent, var(--sap-line-soft)); }
.sap-grip[data-axis="y"] { left: 22px; right: 20px; bottom: 0; height: 6px; cursor: ns-resize;
  background: linear-gradient(180deg, transparent, var(--sap-line-soft)); }
.sap-grip[data-axis="xy"] {
  right: 1px; bottom: 1px; width: 15px; height: 15px; cursor: nwse-resize;
  background:
    linear-gradient(135deg, transparent 46%, var(--sap-line) 46%, var(--sap-line) 54%, transparent 54%),
    linear-gradient(135deg, transparent 66%, var(--sap-line-soft) 66%, var(--sap-line-soft) 74%, transparent 74%);
}
.sap-grip:hover { opacity: 1; }
.sap-grip[data-axis="x"]:hover { background: linear-gradient(90deg, transparent, var(--sap-accent)); }
.sap-grip[data-axis="y"]:hover { background: linear-gradient(180deg, transparent, var(--sap-accent)); }
.sap-grip[data-axis="xy"]:hover { background-image:
    linear-gradient(135deg, transparent 46%, var(--sap-accent) 46%, var(--sap-accent) 54%, transparent 54%),
    linear-gradient(135deg, transparent 66%, var(--sap-accent) 66%, var(--sap-accent) 74%, transparent 74%); }

.sap-head {
  position: relative; z-index: 1;
  display: flex; align-items: center; gap: 5px; row-gap: 4px; flex-wrap: wrap;
  padding: 9px 10px 8px;
  border-bottom: 1px solid var(--sap-line-soft);
  background: linear-gradient(180deg, var(--sap-fill-1), rgba(0, 0, 0, 0));
  cursor: grab; user-select: none;
}
.sap-root[data-collapsed="true"] .sap-head { border-bottom: 0; }
.sap-head:active { cursor: grabbing; }
.sap-sigil {
  flex: none; width: 18px; height: 18px; display: grid; place-items: center;
  font-size: 12px; line-height: 1; color: var(--sap-accent);
  border: 1px solid var(--sap-accent); border-radius: 5px;
  box-shadow: inset 0 0 0 1px var(--sap-tint);
}
.sap-brand {
  flex: none; white-space: nowrap;
  font-family: var(--ds-font-family-code, monospace);
  font-size: 11px; letter-spacing: .1em; text-transform: uppercase;
  color: var(--sap-fg-2); font-weight: 600;
}
.sap-live {
  margin-left: auto; display: inline-flex; align-items: center; gap: 5px;
  flex: 0 1 auto; min-width: 0; overflow: hidden; white-space: nowrap;
  font-family: var(--ds-font-family-code, monospace); font-size: 11px; font-weight: 500;
  color: var(--sap-fg-3);
}
.sap-live[data-active="true"] { color: var(--sap-run); font-weight: 600; }
.sap-pulse {
  position: relative; flex: none; width: 7px; height: 7px; border-radius: 50%;
  background: currentColor; color: var(--sap-fg-3);
}
.sap-live[data-active="true"] .sap-pulse { color: var(--sap-run); }
.sap-pulse::before {
  content: ""; position: absolute; inset: 0; border-radius: 50%;
  background: currentColor; opacity: .28;
  animation: sap-halo 2.1s var(--ds-ease-in-out, ease) infinite;
}
@keyframes sap-halo {
  0% { transform: scale(1); opacity: .35; }
  70% { transform: scale(2.9); opacity: 0; }
  100% { transform: scale(2.9); opacity: 0; }
}
.sap-btn {
  flex: none; min-height: 20px; padding: 1px 6px; cursor: pointer;
  color: var(--sap-fg-2);
  background: var(--sap-fill-1); border: 1px solid var(--sap-line-soft);
  border-radius: 5px; font: inherit; font-size: 11px; line-height: 16px; font-weight: 500;
  transition: color .12s var(--ds-ease-in-out, ease), background .12s var(--ds-ease-in-out, ease);
}
.sap-btn:hover, .sap-btn:focus-visible {
  color: var(--sap-fg);
  background: var(--sap-fill-hover);
  border-color: var(--sap-accent);
}
.sap-btn[data-zoom="true"] {
  min-width: 18px; padding: 1px 3px; text-align: center;
  font-family: var(--ds-font-family-code, monospace); font-weight: 600;
}
.sap-zoomval {
  flex: none; min-width: 30px; text-align: center; cursor: pointer;
  font-family: var(--ds-font-family-code, monospace); font-size: 10px; font-weight: 600;
  color: var(--sap-fg-2); background: transparent; border: 0; padding: 0;
}
.sap-zoomval:hover { color: var(--sap-accent); }
.sap-body { position: relative; z-index: 1; padding: 8px; display: flex; flex-direction: column; gap: 6px; flex: 1 1 auto; min-height: 0; max-height: min(62vh, 560px); overflow: auto; }
/* 用户拉过高度之后:内容区吃满卡片剩余高度并滚动,头部/底部状态条固定 —— 像真窗口。 */
.sap-root[data-sized="true"] .sap-body { max-height: none; }

.sap-group { display: flex; flex-direction: column; gap: 6px; }
.sap-folder {
  display: flex; align-items: center; gap: 8px; width: 100%;
  padding: 6px 7px; cursor: pointer; text-align: left;
  color: inherit; background: var(--sap-tint);
  border: 1px solid var(--sap-line-soft); border-radius: 9px;
  font: inherit;
  transition: background .12s var(--ds-ease-in-out, ease), border-color .12s var(--ds-ease-in-out, ease);
}
.sap-folder:hover { background: var(--sap-fill-hover); border-color: var(--sap-accent); }
.sap-folder-icon {
  flex: none; width: 22px; height: 22px; display: grid; place-items: center;
  font-family: var(--ds-font-family-code, monospace); font-size: 12px; font-weight: 600;
  color: var(--sap-fg-2);
  border: 1px solid var(--sap-line-soft); border-radius: 7px;
  background: var(--sap-bg);
}
.sap-folder-icon[data-running="true"] {
  color: var(--sap-run); border-color: var(--sap-run);
  box-shadow: inset 0 0 0 1px var(--sap-glow);
}
.sap-folder-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; font-size: 12px; }
.sap-folder-count {
  flex: none; font-family: var(--ds-font-family-code, monospace); font-size: 11px; font-weight: 600;
  color: var(--sap-fg-3);
}
.sap-folder-count[data-active="true"] { color: var(--sap-run); }
.sap-caret { flex: none; font-size: 10px; color: var(--sap-fg-3); transition: transform .18s var(--ds-ease-in-out, ease); }
.sap-folder[data-open="true"] .sap-caret { transform: rotate(90deg); }

/* 列数跟着**卡片实际宽度**走:拉宽了就自动多排几列,所以窗口能当"任务墙"用。 */
.sap-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(132px, 1fr)); gap: 6px; animation: sap-in .22s var(--ds-ease-in-out, ease) both; }
@keyframes sap-in {
  from { opacity: 0; transform: translateY(-4px) scale(.985); }
  to { opacity: 1; transform: none; }
}
.sap-tile {
  position: relative; display: flex; flex-direction: column; gap: 4px;
  padding: 7px 8px 8px; cursor: pointer; text-align: left; overflow: hidden;
  color: inherit; background: var(--sap-fill-1);
  border: 1px solid var(--sap-line-soft); border-radius: 10px;
  font: inherit;
  transition: background .12s var(--ds-ease-in-out, ease), border-color .12s var(--ds-ease-in-out, ease);
}
.sap-tile:hover {
  background: var(--sap-fill-hover);
  border-color: var(--sap-accent);
}
.sap-tile[data-tone="run"] { border-color: var(--sap-run); }
/* 本机 DSH 子代理:虚线边 + 层级徽标,和"外部 dsh_task 任务"一眼分得开。 */
.sap-tile[data-native="true"] { border-style: dashed; }
.sap-chip {
  flex: none; padding: 0 4px; border-radius: 4px;
  font-family: var(--ds-font-family-code, monospace); font-size: 10px; line-height: 14px; font-weight: 600;
  color: var(--sap-fg-3); border: 1px solid var(--sap-line-soft); background: var(--sap-fill-1);
}
.sap-tile[data-native="true"][data-tone="run"] .sap-chip { color: var(--sap-run); border-color: var(--sap-run); }
.sap-tile[data-current="true"] {
  background: var(--sap-fill-hover);
  box-shadow: inset 0 0 0 1px var(--sap-accent);
}
.sap-tile[data-tone="run"]::after {
  content: ""; position: absolute; top: 0; left: -60%; width: 55%; height: 100%;
  background: linear-gradient(90deg, rgba(0, 0, 0, 0) 0%, var(--sap-glow) 50%, rgba(0, 0, 0, 0) 100%);
  animation: sap-sweep 2.6s linear infinite;
}
@keyframes sap-sweep { 0% { left: -60%; } 100% { left: 110%; } }
.sap-tile-top { display: flex; align-items: center; gap: 6px; min-width: 0; }
.sap-dot { position: relative; flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--sap-fg-3); color: var(--sap-fg-3); }
.sap-tile[data-tone="run"] .sap-dot { background: var(--sap-run); color: var(--sap-run); }
.sap-tile[data-tone="ok"] .sap-dot { background: var(--sap-ok); color: var(--sap-ok); }
.sap-tile[data-tone="warn"] .sap-dot { background: var(--sap-warn); color: var(--sap-warn); }
.sap-tile[data-tone="err"] .sap-dot { background: var(--sap-err); color: var(--sap-err); }
.sap-tile[data-tone="run"] .sap-dot::before,
.sap-tile[data-tone="err"] .sap-dot::before {
  content: ""; position: absolute; inset: 0; border-radius: 50%; background: currentColor; opacity: .3;
  animation: sap-halo 2.1s var(--ds-ease-in-out, ease) infinite;
}
.sap-tile-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; font-weight: 500; }
.sap-tile-meta {
  display: flex; align-items: center; gap: 5px;
  font-family: var(--ds-font-family-code, monospace); font-size: 11px; line-height: 15px;
  color: var(--sap-fg-3);
}
.sap-tile-meta b { font-weight: 600; color: var(--sap-fg-2); }
.sap-bar { position: relative; height: 3px; border-radius: 3px; background: var(--sap-line-soft); overflow: hidden; }
.sap-bar > i {
  display: block; height: 100%; border-radius: 3px;
  background: linear-gradient(90deg, var(--sap-run), var(--sap-accent));
  transition: width .4s linear;
}
.sap-tile[data-tone="warn"] .sap-bar > i { background: linear-gradient(90deg, var(--sap-warn), var(--sap-err)); }
.sap-tile[data-tone="err"] .sap-bar > i { background: var(--sap-err); }
.sap-tile[data-tone="ok"] .sap-bar > i { background: var(--sap-ok); }

/* 空态:雷达图在**内容区里真正居中**(水平 + 垂直),窗口拉高时不会贴在顶上。 */
.sap-empty {
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  flex: 1 1 auto; min-height: 104px;
  padding: 16px 8px 14px; text-align: center; color: var(--sap-fg-3);
}
.sap-radar {
  position: relative; margin: 0 auto 8px; width: 44px; height: 44px; border-radius: 50%;
  border: 1px solid var(--sap-accent);
  box-shadow: inset 0 0 12px var(--sap-glow);
}
.sap-radar::before {
  content: ""; position: absolute; inset: 0; border-radius: 50%;
  background: conic-gradient(from 0deg, var(--sap-glow) 0deg, rgba(0, 0, 0, 0) 68deg, rgba(0, 0, 0, 0) 360deg);
  animation: sap-radar 2.8s linear infinite;
}
@keyframes sap-radar { to { transform: rotate(360deg); } }
.sap-empty-text { font-size: 12px; line-height: 17px; }

.sap-drawer {
  display: flex; flex-direction: column; gap: 7px; padding: 8px;
  border: 1px solid var(--sap-line-soft); border-radius: 10px;
  background: var(--sap-sunken);
  animation: sap-in .22s var(--ds-ease-in-out, ease) both;
}
.sap-drawer-head { display: flex; align-items: center; gap: 6px; }
.sap-drawer-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; font-weight: 600; }
.sap-kv {
  display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 3px 8px;
  font-family: var(--ds-font-family-code, monospace); font-size: 11px; line-height: 16px;
  color: var(--sap-fg-2);
}
.sap-kv b { font-weight: 600; color: var(--sap-fg-3); }
.sap-kv span { min-width: 0; overflow-wrap: anywhere; }
.sap-kv span[data-tone="warn"] { color: var(--sap-warn); font-weight: 600; }
.sap-kv span[data-tone="err"] { color: var(--sap-err); font-weight: 600; }
.sap-kv span[data-tone="run"] { color: var(--sap-run); font-weight: 600; }
.sap-log {
  max-height: 150px; overflow: auto; padding: 6px 7px;
  border: 1px solid var(--sap-line-soft); border-radius: 7px; background: var(--sap-bg);
  font-family: var(--ds-font-family-code, monospace); font-size: 11px; line-height: 16px;
  color: var(--sap-fg-2); white-space: pre-wrap; overflow-wrap: anywhere;
  --dsh-scrollbar-thumb: var(--sap-fg-3);
  --dsh-scrollbar-thumb-hover: var(--sap-fg-2);
}
.sap-log-line { display: block; }
.sap-log-line::before { content: "› "; color: var(--sap-accent); font-weight: 700; }
/* 告警文字:给底色 + 左边条,不再只靠颜色区分 —— 浅色主题下尤其要看得见。 */
.sap-note {
  display: flex; gap: 6px; align-items: flex-start;
  font-size: 11px; line-height: 16px; font-weight: 600;
  color: var(--sap-warn); background: var(--sap-warn-bg);
  border: 1px solid var(--sap-warn); border-left-width: 3px;
  border-radius: 6px; padding: 5px 7px;
}
.sap-note[data-tone="err"] { color: var(--sap-err); background: var(--sap-err-bg); border-color: var(--sap-err); }
.sap-actions { display: flex; gap: 6px; flex-wrap: wrap; }
.sap-btn[disabled] { opacity: .55; cursor: not-allowed; }
.sap-btn[data-danger="true"] { color: var(--sap-err); border-color: var(--sap-err); background: var(--sap-err-bg); }
.sap-btn[data-danger="true"]:hover { color: var(--sap-bg); background: var(--sap-err); }
.sap-foot {
  position: relative; z-index: 1; padding: 5px 10px 7px;
  border-top: 1px solid var(--sap-line-soft);
  font-family: var(--ds-font-family-code, monospace); font-size: 10px; line-height: 15px; font-weight: 500;
  color: var(--sap-fg-3); display: flex; flex-direction: column; gap: 2px;
}
.sap-foot-line { display: flex; gap: 6px; align-items: center; }
.sap-foot span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* 底部状态条:tok/s | 缓存命中 | 输入 · 输出。数字用等宽 + 高对比,别和说明文字一个灰。 */
.sap-stats {
  display: flex; align-items: center; gap: 5px; flex-wrap: wrap;
  color: var(--sap-fg-2); font-variant-numeric: tabular-nums;
}
.sap-stat { overflow: visible; text-overflow: clip; }
.sap-stat[data-live="true"] { color: var(--sap-run); font-weight: 600; }
.sap-stat-sep { color: var(--sap-line); font-style: normal; }
@media (prefers-reduced-motion: reduce) {
  .sap-card::after, .sap-pulse::before, .sap-radar::before, .sap-tile[data-tone="run"]::after,
  .sap-tile[data-tone="run"] .sap-dot::before, .sap-tile[data-tone="err"] .sap-dot::before { animation: none !important; }
  .sap-grid { animation: none !important; }
}
/* 顺带修宿主自己的一个对比度问题(只影响浅色主题):
   --dsw-alias-state-warn-primary 在浅色主题下等于 amber-500 #f59e0b,白底只有 2.15:1,
   于是整个 GUI 里"橙色告警文字"都读不清。该 token 只用于**文字与圆点**
   (卡片边框用 -secondary、条底色用 -tertiary,都不动),所以只把它在浅色下压深到 7.0:1。
   不想要这个全局效果:删掉下面这一条规则即可(它也只在浅色主题生效)。 */
body:not([data-ds-dark-theme]) { --dsw-alias-state-warn-primary: #8a4700; }
`;

	// ---------------------------------------------------------------- 纯逻辑(可在 node 里直接单测)

	const CALLER_LABELS = {
		"cursor-vscode": "Cursor",
		"claude-code": "Claude Code",
		"codex-mcp-client": "Codex",
		cli: "命令行",
		"dsh-subagent-selftest": "自检",
		unknown: "未知来源",
	};
	const CALLER_GLYPHS = {
		"cursor-vscode": "⌖",
		"claude-code": "✳",
		"codex-mcp-client": "⬢",
		cli: ">_",
		"dsh-subagent-selftest": "◎",
		unknown: "◈",
	};
	/** DSH **自己**的 subagent(同进程子代理)在卡片里也自成一格:
	    它们不是外部 dsh_task,而是宿主里 subagent 工具叫出来的子会话,
	    一样递归、一样会在我这一轮结束后继续跑,所以必须看得见。 */
	const NATIVE_CALLER = "dsh-native";
	CALLER_LABELS[NATIVE_CALLER] = "本机 DSH 子代理";
	CALLER_GLYPHS[NATIVE_CALLER] = "✦";
	const TONE_BY_STATUS = {
		running: "run",
		ok: "ok",
		done: "ok",
		error: "err",
		failed: "err",
		timeout: "warn",
		deadline: "warn",
		stalled: "warn",
		cancelled: "dim",
		canceled: "dim",
	};

	/** 取 observer 写入的自定义投影(卡片的数据源)。 */
	function metaOf(record) {
		if (record === null || typeof record !== "object") return undefined;
		const values = record.projectionValues;
		if (values === null || typeof values !== "object") return undefined;
		const meta = values["dsh-subagent"];
		return meta !== null && typeof meta === "object" ? meta : undefined;
	}

	/** 标题前缀兜底:投影还没到达时仍然能认出这是子代理会话。 */
	function titleHasTag(record) {
		const title = record?.title;
		return typeof title === "string" && title.startsWith("⚡");
	}

	function callerLabelOf(caller) {
		if (typeof caller !== "string" || caller === "") return CALLER_LABELS.unknown;
		return CALLER_LABELS[caller] ?? caller;
	}

	function glyphOf(caller) {
		return CALLER_GLYPHS[caller] ?? CALLER_GLYPHS.unknown;
	}

	function pad2(n) {
		return n < 10 ? "0" + n : String(n);
	}

	function fmtDuration(ms) {
		if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return "--";
		const total = Math.floor(ms / 1000);
		if (total < 60) return total + "s";
		const minutes = Math.floor(total / 60);
		if (minutes < 60) return minutes + "m" + pad2(total % 60) + "s";
		const hours = Math.floor(minutes / 60);
		return hours + "h" + pad2(minutes % 60) + "m";
	}

	function fmtRemain(deadlineAt, now) {
		if (typeof deadlineAt !== "number" || deadlineAt <= 0) return "";
		const delta = deadlineAt - now;
		return delta >= 0 ? "剩 " + fmtDuration(delta) : "超时 " + fmtDuration(-delta);
	}

	function fmtElapsed(startedAt, now) {
		if (typeof startedAt !== "number" || startedAt <= 0) return "";
		return fmtDuration(Math.max(0, now - startedAt));
	}

	function fmtAgo(stamp, now) {
		if (typeof stamp !== "number" || stamp <= 0) return "";
		const delta = now - stamp;
		if (delta < 0) return "刚刚";
		if (delta < 2500) return "刚刚";
		return fmtDuration(delta) + "前";
	}

	function fmtBytes(bytes) {
		if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) return "";
		if (bytes < 1024) return bytes + "B";
		if (bytes < 1048576) return (bytes / 1024).toFixed(1) + "K";
		return (bytes / 1048576).toFixed(1) + "M";
	}

	function msOf(value) {
		if (typeof value === "number" && Number.isFinite(value)) return value;
		if (typeof value === "string" && value !== "") {
			const parsed = Date.parse(value);
			if (Number.isFinite(parsed)) return parsed;
		}
		return 0;
	}

			/**
			 * token 用量:两个来源,优先宿主自己算的那份。
			 *
			 * - **宿主会话**(本机子代理):DSH 的 token-meter 把 `tokenUsage` 按会话投影出来,
			 *   直接读 `projectionValues.tokenUsage` 就是它 UI 里用的同一个数;
			 * - **外部任务**:宿主从没加载过那些会话,标准投影不存在 —— 观察器自己折叠
			 *   子代理的会话日志,塞在我们的 `dsh-subagent` 投影里(`meta.usage`)。
			 *
			 * 形状统一成 `{ input, output, cacheRead, cacheWrite, prompt, total, tps }`。
			 */
			function usageOf(record, meta) {
				const host = record?.projectionValues?.tokenUsage;
				const fromHost = host !== null && typeof host === "object" ? host : null;
				const observed = meta !== undefined && meta !== null && typeof meta.usage === "object" ? meta.usage : null;
				const raw = fromHost ?? (observed !== null && observed !== undefined ? observed : null);
				if (raw === null) return null;
				const num = (value) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0);
				const input = num(raw.uncachedInputTokens ?? raw.inputTokens);
				const output = num(raw.outputTokens);
				const cacheRead = num(raw.cacheReadTokens);
				const cacheWrite = num(raw.cacheWriteTokens);
				const prompt = typeof raw.promptTokens === "number" ? num(raw.promptTokens) : input + cacheRead + cacheWrite;
				const total = typeof raw.totalTokens === "number" ? num(raw.totalTokens) : prompt + output;
				if (total <= 0 && prompt <= 0) return null;
				// 吞吐**只认观察器按真实时间窗算出来的那个数**(见 observer.mjs 的 rateOf)。
				// 客户端以前自己每秒采一次 Δ输出/Δt,而用量是成块更新的 ⇒ 2 秒里跳 6000 token
				// 被算成 3000 tok/s。窗口太短是算法问题,不是数据问题,所以这个算法已经删掉。
				const tps = typeof raw.tokensPerSecond === "number" && raw.tokensPerSecond > 0 ? raw.tokensPerSecond : 0;
				return { input, output, cacheRead, cacheWrite, prompt, total, tps, fromHost: fromHost !== null };
			}

			/** 紧凑 token 数:517 / 12.2K / 517K / 1.2M(与宿主 UI 同口径)。 */
			function fmtTokens(value) {
				if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return "";
				const scaled = (candidate) => (candidate >= 100 ? String(Math.round(candidate)) : String(Math.round(candidate * 10) / 10));
				if (value < 1000) return String(Math.round(value));
				if (value < 1000000) return scaled(value / 1000) + "K";
				if (value < 1000000000) return scaled(value / 1000000) + "M";
				return scaled(value / 1000000000) + "B";
			}

			/**
			 * 缓存命中率:`缓存读 / prompt 侧总量`,与宿主同一个分母。
			 *
			 * 宿主的规矩很讲究:部分命中**绝不允许显示成 100%** —— 四舍五入撞到 100 时自动
			 * 加一位精度(99.9%),只有真的全命中才显示 100。这里照抄这个诚实口径。
			 */
			function cacheHitPercent(usage) {
				if (usage === null || usage.prompt <= 0) return null;
				if (usage.cacheRead >= usage.prompt) return "100";
				const exact = (usage.cacheRead / usage.prompt) * 100;
				const whole = Math.round(exact);
				// 整数位一旦四舍五入撞到 100,就退到一位小数;一位小数还是 100 就写 99.9。
				// (踩过:99.7% 直接 Math.round 成"100%",把"几乎全命中"说成了"全命中"。)
				if (whole >= 100) {
					const oneDecimal = Math.round(exact * 10) / 10;
					return oneDecimal >= 100 ? "99.9" : String(oneDecimal);
				}
				return String(whole);
			}

			/** 多个条目的用量合计(卡片底部状态条用)。`tps` 只累计**在跑**且观察器真给了速率的会话。 */
			function sumUsage(entries) {
				const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, prompt: 0, total: 0, tps: 0, live: 0, count: 0 };
				for (const entry of entries) {
					if (entry.usage === null) continue;
					total.input += entry.usage.input;
					total.output += entry.usage.output;
					total.cacheRead += entry.usage.cacheRead;
					total.cacheWrite += entry.usage.cacheWrite;
					total.prompt += entry.usage.prompt;
					total.total += entry.usage.total;
					total.count += 1;
					if (entry.running && entry.usage.tps > 0) {
						total.tps += entry.usage.tps;
						total.live += 1;
					}
				}
				return total.count === 0 ? null : total;
			}

	/** 单条会话 → 卡片条目;不是子代理会话时返回 null。 */
	function entryOf(record, now) {
		if (record === null || typeof record !== "object") return null;
		const id = record.id;
		if (typeof id !== "string" || id === "") return null;
		const meta = metaOf(record);
		if (meta === undefined && !titleHasTag(record)) return null;
		const rawCaller = typeof meta?.caller === "string" && meta.caller !== "" ? meta.caller : "unknown";
		const status = typeof meta?.status === "string" && meta.status !== "" ? meta.status : "";
		const running = typeof meta?.running === "boolean" ? meta.running : record.running === true;
		const startedAt = msOf(meta?.startedAt);
		const deadlineAt = msOf(meta?.deadlineAt);
		const expectedSeconds = typeof meta?.expectedSeconds === "number" && meta.expectedSeconds > 0
			? meta.expectedSeconds
			: 0;
		const fallbackTitle = typeof record.displayTitle === "string" && record.displayTitle !== ""
			? record.displayTitle
			: typeof record.title === "string" && record.title !== "" ? record.title : id;
		const title = typeof meta?.title === "string" && meta.title !== "" ? meta.title : fallbackTitle;
		const elapsed = startedAt > 0 ? Math.max(0, now - startedAt) : 0;
		const span = expectedSeconds > 0 ? expectedSeconds * 1000 : 0;
		return {
			id,
			caller: rawCaller,
			callerLabel: typeof meta?.callerLabel === "string" && meta.callerLabel !== ""
				? meta.callerLabel
				: callerLabelOf(rawCaller),
			glyph: glyphOf(rawCaller),
			title,
			status,
			running,
			tone: running ? "run" : TONE_BY_STATUS[status] ?? "dim",
			jobId: typeof meta?.jobId === "string" ? meta.jobId : "",
			workspace: typeof meta?.workspace === "string" ? meta.workspace : typeof record.cwd === "string" ? record.cwd : "",
			startedAt,
			finishedAt: msOf(meta?.finishedAt),
			deadlineAt,
			lastProgressAt: msOf(meta?.lastProgressAt),
			progressBytes: typeof meta?.progressBytes === "number" ? meta.progressBytes : 0,
			error: typeof meta?.error === "string" ? meta.error : "",
			acceptance: typeof meta?.acceptance === "string" ? meta.acceptance : "",
			exitCode: typeof meta?.exitCode === "number" ? meta.exitCode : null,
			recentLines: Array.isArray(meta?.recentLines)
				? meta.recentLines.filter((line) => typeof line === "string").slice(-6)
				: [],
			resultPreview: typeof meta?.resultPreview === "string" ? meta.resultPreview : "",
			updatedAt: typeof record.updatedAt === "number" ? record.updatedAt : 0,
			activity: elapsed,
			progressRatio: span > 0 ? Math.max(0, Math.min(1, elapsed / span)) : 0,
			hasBar: span > 0,
			// token 用量(含观察器按真实时间窗算出的吞吐)
			usage: usageOf(record, meta),
			tps: 0,
			// 告警信号:过期 / 接近预计时间 / 终态不是正常完成。详情页据此把那一行标红标橙,
			// 而不是只靠一个不起眼的小圆点。
			overdue: running && deadlineAt > 0 && now > deadlineAt,
			late: running && span > 0 && elapsed > span * 0.85,
			stuck: status === "stalled" || status === "deadline" || status === "timeout" || status === "killed",
			isCurrent: false,
		};
	}

	/** 列表快照 → 条目数组(运行中优先,其次最近开始)。 */
	function collect(ids, byId, current, now) {
		const list = Array.isArray(ids) ? ids : [];
		const map = byId !== null && typeof byId === "object" ? byId : {};
		const out = [];
		for (const id of list) {
			const entry = entryOf(map[id], now);
			if (entry === null) continue;
			entry.isCurrent = id === current;
			entry.tps = entry.running ? entry.usage?.tps ?? 0 : 0;
			out.push(entry);
		}
		out.sort((a, b) => {
			if (a.running !== b.running) return a.running ? -1 : 1;
			if (a.startedAt !== b.startedAt) return b.startedAt - a.startedAt;
			return b.updatedAt - a.updatedAt;
		});
		return out;
	}

	/** 会话记录 → 显示名(只用于给"父会话"起名)。 */
	function titleOfRecord(record, fallback) {
		if (record === null || typeof record !== "object") return fallback;
		const meta = metaOf(record);
		if (typeof meta?.title === "string" && meta.title !== "") return meta.title;
		if (typeof record.displayTitle === "string" && record.displayTitle !== "") return record.displayTitle;
		if (typeof record.title === "string" && record.title !== "") return record.title;
		return fallback;
	}

	/**
	 * 宿主自己的 subagent 目录 → 卡片条目。
	 *
	 * 数据源是 `useSessions(state => state.subagentsByParent)`:键是父会话,值是该父会话的
	 * 直接子代理目录 `{ state, entries: [{ kind: 'child'|'diagnostic', id, activity, hasChildren,
	 * label, mode }] }`(宿主自己也是这么渲染"子代理"入口的)。于是:
	 * - `activity === 'running'` 就是"这个子代理现在还在跑" —— 哪怕我这一轮早就答完了;
	 * - `hasChildren` + 多层目录能算出层级,递归派活的链子(L1 → L2 → L3)一眼可见;
	 * - `kind: 'diagnostic'`(损坏/不可用)直接跳过,不假装它是个能点开的会话。
	 */
	function nativeEntriesOf(catalogs, byId, now) {
		const map = catalogs !== null && typeof catalogs === "object" ? catalogs : {};
		const records = byId !== null && typeof byId === "object" ? byId : {};
		const parentOf = new Map();
		const rows = [];
		for (const parentId of Object.keys(map)) {
			const catalog = map[parentId];
			if (catalog === null || typeof catalog !== "object") continue;
			const list = Array.isArray(catalog.entries) ? catalog.entries : [];
			for (const child of list) {
				if (child === null || typeof child !== "object") continue;
				if (child.kind !== "child") continue;
				const id = child.id;
				if (typeof id !== "string" || id === "" || parentOf.has(id)) continue;
				parentOf.set(id, parentId);
				rows.push({ child, id, parentId });
			}
		}
		const depthOf = (id) => {
			let depth = 1;
			let cursor = parentOf.get(id);
			const guard = new Set([id]);
			// 只有"本身就是子代理"的祖先才算一层;父会话(index 里的目录键)不算。
			while (cursor !== undefined && !guard.has(cursor) && depth < 9) {
				if (!parentOf.has(cursor)) break;
				guard.add(cursor);
				cursor = parentOf.get(cursor);
				depth += 1;
			}
			return depth;
		};
		return rows.map(({ child, id, parentId }) => {
			const record = records[id];
			const running = child.activity === "running" || record?.running === true;
			return {
				id,
				caller: NATIVE_CALLER,
				callerLabel: CALLER_LABELS[NATIVE_CALLER],
				glyph: CALLER_GLYPHS[NATIVE_CALLER],
				title: typeof child.label === "string" && child.label !== ""
					? child.label
					: titleOfRecord(record, id),
				status: running ? "running" : "ok",
				running,
				tone: running ? "run" : "dim",
				jobId: "",
				workspace: typeof record?.cwd === "string" ? record.cwd : "",
				startedAt: 0,
				finishedAt: 0,
				deadlineAt: 0,
				lastProgressAt: typeof record?.updatedAt === "number" ? record.updatedAt : 0,
				progressBytes: 0,
				error: "",
				acceptance: "",
				exitCode: null,
				recentLines: [],
				resultPreview: "",
				updatedAt: typeof record?.updatedAt === "number" ? record.updatedAt : 0,
				activity: 0,
				progressRatio: 0,
				hasBar: false,
				// 本机子代理的用量直接读宿主的 `tokenUsage` 投影(和宿主自己的子代理面板同一个数)
				usage: usageOf(record, undefined),
				tps: 0,
				overdue: false,
				late: false,
				stuck: false,
				isCurrent: false,
				// 本机子代理专属字段
				native: true,
				depth: depthOf(id),
				hasChildren: child.hasChildren === true,
				mode: typeof child.mode === "string" ? child.mode : "",
				parentId,
				parentTitle: titleOfRecord(records[parentId], parentId),
			};
		});
	}

	/** 条目 → 按调用方分组(活跃多的在前)。 */
	function groupByCaller(entries) {
		const buckets = new Map();
		for (const entry of entries) {
			let bucket = buckets.get(entry.caller);
			if (bucket === undefined) {
				bucket = { key: entry.caller, label: entry.callerLabel, glyph: entry.glyph, active: 0, total: 0, entries: [] };
				buckets.set(entry.caller, bucket);
			}
			bucket.total += 1;
			if (entry.running) bucket.active += 1;
			bucket.entries.push(entry);
		}
		const groups = [...buckets.values()];
		groups.sort((a, b) => {
			if (a.active !== b.active) return b.active - a.active;
			if (a.total !== b.total) return b.total - a.total;
			return a.label.localeCompare(b.label, "zh-Hans-CN");
		});
		for (const group of groups) {
			group.entries.sort((a, b) => (a.running !== b.running ? (a.running ? -1 : 1) : b.startedAt - a.startedAt));
		}
		return groups;
	}

	function basenameOf(path) {
		if (typeof path !== "string" || path === "") return "";
		const parts = path.replace(/[\\/]+$/, "").split(/[\\/]/);
		return parts[parts.length - 1] ?? "";
	}

	const logic = {
		metaOf,
		titleHasTag,
		callerLabelOf,
		glyphOf,
		fmtDuration,
		fmtRemain,
		fmtElapsed,
		fmtAgo,
		fmtBytes,
		usageOf,
		fmtTokens,
		cacheHitPercent,
		sumUsage,
		entryOf,
		collect,
		nativeEntriesOf,
		groupByCaller,
		basenameOf,
		CALLER_LABELS,
		CALLER_GLYPHS,
		NATIVE_CALLER,
	};

	// ---------------------------------------------------------------- 视图

	window.__ModuleLoader__.load({
		id: PLUGIN_ID,
		factory: (require) => {
			const React = require("react");
			const runtime = require("react/jsx-runtime");
			const jsx = runtime.jsx;
			const jsxs = runtime.jsxs;
			const Fragment = runtime.Fragment;

			// CSS 必须在 factory 内注入:执行 bundle 只是注册工厂,模块化时才产生副作用。
			if (typeof document !== "undefined") {
				const tagId = PLUGIN_ID + "/lib/client.js";
				if (document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
					const tag = document.createElement("style");
					tag.dataset.plugin = PLUGIN_ID;
					tag.dataset.pluginCss = tagId;
					tag.textContent = CSS;
					document.head.appendChild(tag);
				}
			}

			const STORE_KEY = "dsh.subagent.panel.v1";
			/**
			 * 缩放范围:小到能当"角落状态灯",大到能当主监视窗。上限放到 200% 是给
			 * "开着卡片盯一个长任务"用的 —— 窗口可以拖到任何地方,所以放大不会挡住路。
			 */
			const ZOOM_MIN = 0.6;
			const ZOOM_MAX = 2;
			const ZOOM_STEP = 0.1;
			/** 拖拽缩放用的细步进:按钮走 10%,拖角走 5%,手感更连续。 */
			const ZOOM_DRAG_STEP = 0.05;
			/** 窗口最小/默认尺寸(px,CSS 像素;屏幕太大的时候用视口封顶)。 */
			const WIDTH_MIN = 220;
			const WIDTH_DEFAULT = 300;
			const HEIGHT_MIN = 120;

			function clampWidth(value) {
				const max = Math.max(WIDTH_MIN, window.innerWidth - 44);
				const number = typeof value === "number" && Number.isFinite(value) ? value : WIDTH_DEFAULT;
				return Math.round(Math.min(max, Math.max(WIDTH_MIN, number)));
			}

			function clampHeight(value) {
				const max = Math.max(HEIGHT_MIN, window.innerHeight - 96);
				const number = typeof value === "number" && Number.isFinite(value) ? value : HEIGHT_MIN;
				return Math.round(Math.min(max, Math.max(HEIGHT_MIN, number)));
			}

			function clampZoom(value, step = ZOOM_STEP) {
				const number = typeof value === "number" && Number.isFinite(value) ? value : 1;
				const snapped = Math.round(number / step) * step;
				const rounded = Math.round(snapped * 100) / 100;
				return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, rounded));
			}

			/** 读取持久化的小状态(位置 / 折叠 / 是否显示历史),失败一律回退默认。 */
			function readStored() {
				try {
					const raw = window.localStorage.getItem(STORE_KEY);
					if (raw === null) return {};
					const parsed = JSON.parse(raw);
					return parsed !== null && typeof parsed === "object" ? parsed : {};
				} catch {
					return {};
				}
			}

			function writeStored(patch) {
				try {
					window.localStorage.setItem(STORE_KEY, JSON.stringify({ ...readStored(), ...patch }));
				} catch {
					/* 隐私模式等场景直接忽略 */
				}
			}

			const initial = readStored();

			function useNow(intervalMs) {
				const [now, setNow] = React.useState(() => Date.now());
				React.useEffect(() => {
					const timer = window.setInterval(() => {
						setNow(Date.now());
					}, intervalMs);
					return () => {
						window.clearInterval(timer);
					};
				}, [intervalMs]);
				return now;
			}

			function useDrag() {
				const [pos, setPos] = React.useState(() => {
					const stored = initial.pos;
					return stored !== null && typeof stored === "object"
						&& typeof stored.left === "number" && typeof stored.top === "number"
						? stored
						: null;
				});
				const origin = React.useRef(null);
				const onMouseDown = React.useCallback((event) => {
					if (event.button !== 0) return;
					const target = event.currentTarget.closest(".sap-card");
					if (target === null) return;
					if (event.target instanceof Element && event.target.closest("button") !== null) return;
					const rect = target.getBoundingClientRect();
					origin.current = { dx: event.clientX - rect.left, dy: event.clientY - rect.top };
					event.preventDefault();
				}, []);
				React.useEffect(() => {
					const onMove = (event) => {
						const current = origin.current;
						if (current === null) return;
						const left = Math.max(6, Math.min(window.innerWidth - 80, event.clientX - current.dx));
						const top = Math.max(6, Math.min(window.innerHeight - 32, event.clientY - current.dy));
						setPos({ left, top });
					};
					const onUp = () => {
						if (origin.current === null) return;
						origin.current = null;
						setPos((value) => {
							if (value !== null) writeStored({ pos: value });
							return value;
						});
					};
					window.addEventListener("mousemove", onMove);
					window.addEventListener("mouseup", onUp);
					return () => {
						window.removeEventListener("mousemove", onMove);
						window.removeEventListener("mouseup", onUp);
					};
				}, []);
				const style = pos === null ? undefined : { left: pos.left + "px", top: pos.top + "px", right: "auto" };
				return [style, onMouseDown];
			}

			/**
			 * 右下角/右边缘/下边缘拖拽缩放:像真窗口一样**自由改宽高**,不是等比例缩放。
			 *
			 * 宽高直接写进 CSS 变量(`--sap-w` / `--sap-h`),所以拉宽时网格会重新排 ——
			 * `.sap-grid` 是 `auto-fill`,卡片一变宽每行就多放几个磁贴。拉高时窗口内的
			 * 内容区滚动,头部与底部状态条固定。
			 *
			 * 拖动位移要**除以 zoom**:卡片在 `.sap-zoom` 里,屏幕位移 ≠ CSS 像素位移,
			 * 不除的话放大到 150% 时拉一格会跑两格。
			 */
			function useResize(size, setSize, zoom) {
				const origin = React.useRef(null);
				const zoomRef = React.useRef(zoom);
				zoomRef.current = zoom;
				const onMouseDown = React.useCallback((event) => {
					if (event.button !== 0) return;
					event.preventDefault();
					event.stopPropagation();
					const card = event.currentTarget.closest(".sap-card");
					if (card === null) return;
					const rect = card.getBoundingClientRect();
					const factor = zoomRef.current > 0 ? zoomRef.current : 1;
					origin.current = {
						axis: event.currentTarget.dataset.axis ?? "xy",
						x: event.clientX,
						y: event.clientY,
						w: rect.width / factor,
						h: rect.height / factor,
					};
				}, []);
				React.useEffect(() => {
					const onMove = (event) => {
						const start = origin.current;
						if (start === null) return;
						const factor = zoomRef.current > 0 ? zoomRef.current : 1;
						const next = {};
						if (start.axis.includes("x")) next.w = clampWidth(start.w + (event.clientX - start.x) / factor);
						if (start.axis.includes("y")) next.h = clampHeight(start.h + (event.clientY - start.y) / factor);
						setSize((value) => ({ ...value, ...next }));
					};
					const onUp = () => {
						if (origin.current === null) return;
						origin.current = null;
						setSize((value) => {
							writeStored({ size: value });
							return value;
						});
					};
					window.addEventListener("mousemove", onMove);
					window.addEventListener("mouseup", onUp);
					return () => {
						window.removeEventListener("mousemove", onMove);
						window.removeEventListener("mouseup", onUp);
					};
				}, [setSize]);
				return onMouseDown;
			}

			function Tile(props) {
				const entry = props.entry;
				const now = props.now;
				const parts = [];
				if (entry.native === true) {
					// 本机子代理没有 job 现场,只报"跑没跑"和所属父会话。
					parts.push(entry.running ? "运行中" : "已结束");
				} else if (entry.running) {
					const remain = fmtRemain(entry.deadlineAt, now);
					parts.push(remain !== "" ? remain : fmtElapsed(entry.startedAt, now));
				} else if (entry.status !== "" && entry.status !== "ok") {
					parts.push(entry.status);
				} else {
					parts.push("已完成");
				}
				const bytes = fmtBytes(entry.progressBytes);
				if (bytes !== "") parts.push(bytes);
				// 磁贴上直接带一眼用量:`↑12.3K ↓451`,运行中的还能看到实时 tok/s。
				if (entry.usage !== null) {
					parts.push("↑" + fmtTokens(entry.usage.input) + " ↓" + fmtTokens(entry.usage.output));
				}
				if (entry.tps > 0) parts.push(Math.round(entry.tps) + " tok/s");
				if (entry.native === true && entry.lastProgressAt > 0) {
					const ago = fmtAgo(entry.lastProgressAt, now);
					if (ago !== "") parts.push(ago);
				}
				// 运行中的**外部**会话不能直接打开:宿主打开会话 = 接管该会话写权
				// (resume + 合成收尾事件 + session/end-seed 落盘),会把子进程正在写的
				// 日志写出重复 seq。所以运行中的磁贴进只读详情页,结束后的磁贴才是普通打开。
				// 本机子代理是同进程的,宿主自己的入口就是直接打开,不受这条限制。
				const hint = entry.native === true
					? "点击打开这个本机 DSH 子代理会话(与宿主自己的子代理入口一致)"
					: entry.running
						? "点击查看实时详情(运行中的外部会话不直接打开:宿主会接管写权并写坏它的日志)"
						: "点击打开会话(与普通会话完全一致)";
				const titleParts = [entry.title, hint];
				if (entry.native === true) {
					titleParts.push("第 " + entry.depth + " 层 · 所属 " + entry.parentTitle);
					if (entry.hasChildren) titleParts.push("它自己还叫了子代理");
					if (entry.mode !== "") titleParts.push(entry.mode);
				} else {
					titleParts.push(entry.jobId, entry.workspace, entry.error);
				}
				return jsxs("button", {
					type: "button",
					className: "sap-tile",
					"data-tone": entry.tone,
					"data-current": String(entry.isCurrent),
					"data-native": entry.native === true ? "true" : undefined,
					title: titleParts.filter(Boolean).join("\n"),
					onClick: () => {
						props.onSelect(entry);
					},
					children: [
						jsxs("span", {
							className: "sap-tile-top",
							children: [
								jsx("i", { className: "sap-dot" }),
								jsx("span", { className: "sap-tile-name", children: entry.title }),
							],
						}),
						jsxs("span", {
							className: "sap-tile-meta",
							children: [
								entry.native === true
									? jsx("span", {
										className: "sap-chip",
										"data-depth": String(entry.depth),
										children: "L" + entry.depth + (entry.hasChildren ? " ⊞" : ""),
									})
									: null,
								jsx("b", { children: parts.join(" · ") }),
							],
						}),
						entry.hasBar && entry.running
							? jsx("span", {
								className: "sap-bar",
								children: jsx("i", { style: { width: Math.round(entry.progressRatio * 100) + "%" } }),
							})
							: null,
					],
				}, entry.id);
			}

			function Group(props) {
				const group = props.group;
				const isOpen = props.open;
				return jsxs("section", {
					className: "sap-group",
					children: [
						jsxs("button", {
							type: "button",
							className: "sap-folder",
							"data-open": String(isOpen),
							onClick: () => {
								props.onToggle(group.key);
							},
							children: [
								jsx("span", {
									className: "sap-folder-icon",
									"data-running": String(group.active > 0),
									children: group.glyph,
								}),
								jsx("span", { className: "sap-folder-name", children: group.label }),
								jsx("span", {
									className: "sap-folder-count",
									"data-active": String(group.active > 0),
									children: group.active + "/" + group.total,
								}),
								jsx("span", { className: "sap-caret", children: "▶" }),
							],
						}),
						isOpen
							? jsx("div", {
								className: "sap-grid",
								children: group.entries.map((entry) => jsx(Tile, {
									entry,
									now: props.now,
									onSelect: props.onSelect,
								}, entry.id)),
							})
							: null,
					],
				}, group.key);
			}

			/** 运行中任务的只读实时详情:这是唯一能看到外部任务正在干什么的正规通道。 */
			function Drawer(props) {
				const entry = props.entry;
				const now = props.now;
				const [armed, setArmed] = React.useState(false);
				const rows = [
					["调用方", entry.callerLabel + (entry.caller === "" || entry.caller === entry.callerLabel ? "" : " (" + entry.caller + ")"), ""],
					["任务号", entry.jobId === "" ? "-" : entry.jobId, ""],
				];
				if (entry.workspace !== "") rows.push(["工作区", entry.workspace, ""]);
				rows.push([
					"状态",
					entry.running ? "运行中" + (entry.status === "running" ? "" : " · " + entry.status) : entry.status === "" ? "未知" : entry.status,
					entry.running ? "run" : entry.stuck ? "err" : entry.tone === "ok" ? "ok" : "",
				]);
				rows.push(["已耗时", fmtElapsed(entry.startedAt, now) === "" ? "-" : fmtElapsed(entry.startedAt, now), ""]);
				if (entry.running && entry.deadlineAt > 0) {
					rows.push(["预计", fmtRemain(entry.deadlineAt, now), entry.overdue ? "err" : entry.late ? "warn" : ""]);
				}
				const bytes = fmtBytes(entry.progressBytes);
				if (bytes !== "") {
					const ago = fmtAgo(entry.lastProgressAt, now);
					// 运行中且"上次增长"已经很久:橙色提醒(看门狗就是按这个判停滞的)。
					const stale = entry.running && entry.lastProgressAt > 0 && now - entry.lastProgressAt > 60000;
					rows.push(["输出", bytes + (ago === "" ? "" : " · 上次增长 " + ago), stale ? "warn" : ""]);
				}
				if (entry.acceptance !== "") rows.push(["验收", entry.acceptance, ""]);
				// token 用量:和宿主 UI 同一个口径(输入/输出/缓存命中/实时吞吐)。
				if (entry.usage !== null) {
					const hit = cacheHitPercent(entry.usage);
					rows.push([
						"tokens",
						"输入 " + fmtTokens(entry.usage.input) + " tok · 输出 " + fmtTokens(entry.usage.output) + " tok"
							+ (hit === null ? "" : " · 缓存命中 " + hit + "%"),
						"",
					]);
					rows.push([
						"来源",
						entry.usage.fromHost ? "宿主 tokenUsage 投影" : "观察器折叠会话日志"
							+ (entry.usage.cacheRead > 0 ? "(缓存读 " + fmtTokens(entry.usage.cacheRead) + ")" : ""),
						"",
					]);
				}
				if (entry.tps > 0) rows.push(["吞吐", Math.round(entry.tps) + " tok/s", "ok"]);
				if (entry.exitCode !== null) rows.push(["退出码", String(entry.exitCode), entry.exitCode === 0 ? "ok" : "err"]);
				const children = [
					jsxs("div", {
						className: "sap-drawer-head",
						children: [
							jsx("button", {
								type: "button",
								className: "sap-btn",
								onClick: () => {
									props.onBack();
								},
								children: "‹ 返回",
							}),
							jsx("span", { className: "sap-drawer-title", children: entry.title }),
							jsx("i", { className: "sap-dot", style: { background: "var(--sap-" + (entry.running ? "run" : entry.tone === "ok" ? "ok" : "dim") + ")" } }),
						],
					}),
					jsx("div", {
						className: "sap-kv",
						children: rows.flatMap(([key, value, tone]) => [
							jsx("b", { children: key }, key + "-k"),
							jsx("span", { children: value, "data-tone": tone === "" ? undefined : tone }, key + "-v"),
						]),
					}),
					entry.error !== ""
						? jsxs("div", { className: "sap-note", "data-tone": "err", children: [jsx("span", { children: "⚠" }), jsx("span", { children: entry.error })] })
						: null,
					entry.recentLines.length > 0
						? jsx("div", {
							className: "sap-log",
							children: entry.recentLines.map((line, index) => jsx("span", { className: "sap-log-line", children: line }, index)),
						})
						: null,
					!entry.running && entry.resultPreview !== ""
						? jsx("div", { className: "sap-log", children: entry.resultPreview })
						: null,
					jsxs("div", {
						className: "sap-actions",
						children: entry.running
							? [
								jsx("button", {
									type: "button",
									className: "sap-btn",
									disabled: true,
									title: "运行中的外部会话不能按普通方式打开:宿主打开 = 接管写权(resume + 合成收尾事件 + session/end-seed),会给子进程正在写的会话日志制造重复 seq",
									children: "打开会话(运行中不可用)",
								}, "disabled-open"),
								jsx("button", {
									type: "button",
									className: "sap-btn",
									"data-danger": "true",
									title: "有损:会在该会话日志里写入合成收尾事件与 session/end-seed,可能造成永久损坏",
									onClick: () => {
										if (!armed) {
											setArmed(true);
											return;
										}
										setArmed(false);
										props.onForceOpen(entry.id);
									},
									children: armed ? "确认有损打开" : "仍要打开",
								}, "force-open"),
							]
							: [
								jsx("button", {
									type: "button",
									className: "sap-btn",
									onClick: () => {
										props.onForceOpen(entry.id);
									},
									children: "打开会话",
								}, "open"),
							],
					}),
					entry.running
						? jsxs("div", {
							className: "sap-note",
							children: [
								jsx("span", { children: "◈" }),
								jsx("span", { children: "任务由独立进程持有,此处显示它的实时输出;会话转录不会随外部进程增长。" }),
							],
						})
						: null,
				];
				return jsx("div", { className: "sap-drawer", children }, "drawer");
			}

			function Panel(props) {
				const now = useNow(1000);
				// shell.overlay 的 root 标准钩子由 ui-session 提供;万一某个部署里没提供,
				// 卡片应该退化成空态,而不是抛异常把宿主界面弄坏。
				const useSessions = typeof props.useSessions === "function"
					? props.useSessions
					: () => undefined;
				const ids = useSessions((state) => state.ids) ?? [];
				const byId = useSessions((state) => state.byId) ?? {};
				const current = useSessions((state) => state.current);
				// 宿主自己的 subagent 目录(同进程子代理),和外部 dsh_task 并列显示:
				// 否则"我的代理又叫了代理、而且它们在我答完之后还在跑"这件事是看不见的。
				const subagentsByParent = useSessions((state) => state.subagentsByParent) ?? {};
				const external = React.useMemo(() => collect(ids, byId, current, now), [ids, byId, current, now]);
				const natives = React.useMemo(
					() => nativeEntriesOf(subagentsByParent, byId, now),
					[subagentsByParent, byId, now],
				);
				const entries = React.useMemo(() => {
					if (natives.length === 0) return external;
					return [...external, ...natives].sort((a, b) => {
						if (a.running !== b.running) return a.running ? -1 : 1;
						if (a.startedAt !== b.startedAt) return b.startedAt - a.startedAt;
						return b.updatedAt - a.updatedAt;
					});
				}, [external, natives]);
				const active = React.useMemo(() => entries.filter((entry) => entry.running), [entries]);
				const nativeCount = natives.length;
				const [showHistory, setShowHistory] = React.useState(initial.history === true);
				const [collapsed, setCollapsed] = React.useState(initial.collapsed === true);
				const [zoom, setZoom] = React.useState(() => clampZoom(initial.zoom));
				// 窗口尺寸:用户拉过就用用户的,没拉过就是默认宽度 + 自动高度。
				const [size, setSize] = React.useState(() => {
					const stored = initial.size;
					if (stored === null || typeof stored !== "object") return { w: WIDTH_DEFAULT, h: 0, user: false };
					return {
						w: clampWidth(typeof stored.w === "number" ? stored.w : WIDTH_DEFAULT),
						h: typeof stored.h === "number" && stored.h > 0 ? clampHeight(stored.h) : 0,
						user: true,
					};
				});
				const sized = size.user;
				const sizeStyle = {
					"--sap-w": size.w + "px",
					...(size.h > 0 ? { "--sap-h": size.h + "px" } : {}),
				};
				const resetSize = React.useCallback(() => {
					setSize({ w: WIDTH_DEFAULT, h: 0, user: false });
					writeStored({ size: null });
				}, []);
				const [overrides, setOverrides] = React.useState({});
				const [detailId, setDetailId] = React.useState(null);
				const [style, onMouseDown] = useDrag();
				const onResize = useResize(size, setSize, zoom);
				// 只对"报告还有下一层"的子代理各请求一次目录,避免每帧都打宿主。
				const deepened = React.useRef(null);
				if (deepened.current === null) deepened.current = new Set();

				React.useEffect(() => {
					if (collapsed || typeof props.api.refreshSubagents !== "function") return;
					const pending = natives
						.filter((entry) => entry.hasChildren
							&& subagentsByParent[entry.id] === undefined
							&& !deepened.current.has(entry.id))
						.slice(0, 6);
					for (const entry of pending) {
						deepened.current.add(entry.id);
						props.api.refreshSubagents(entry.id);
					}
				}, [collapsed, natives, subagentsByParent, props.api]);

				/** 缩放:0.8~1.6,步进 0.1,点百分比复位到 100%。 */
				const bumpZoom = React.useCallback((delta) => {
					setZoom((value) => {
						const next = clampZoom(delta === 0 ? 1 : value + delta);
						writeStored({ zoom: next });
						return next;
					});
				}, []);

				const visible = showHistory ? entries : active;
				const groups = React.useMemo(() => groupByCaller(visible), [visible]);
				const activeCount = active.length;
				const totalCount = entries.length;
				const detail = detailId === null ? undefined : entries.find((entry) => entry.id === detailId);

				/** 结束的任务按普通会话打开;运行中的外部任务只进只读详情(打开会写坏它的日志)。
				    本机 DSH 子代理是同进程的,宿主自己的入口就是直接打开,所以这里也直接打开。 */
				const onSelect = React.useCallback((entry) => {
					if (entry.native === true) {
						props.api.open(entry.id);
						return;
					}
					if (entry.running) {
						setDetailId(entry.id);
						return;
					}
					props.api.open(entry.id);
				}, [props.api]);

				const toggleGroup = React.useCallback((key) => {
					setOverrides((state) => ({ ...state, [key]: !(state[key] ?? false) }));
				}, []);

				const isOpenOf = (group) => {
					const override = overrides[group.key];
					if (typeof override === "boolean") return override;
					return group.active > 0;
				};

				const head = jsxs("div", {
					className: "sap-head",
					onMouseDown,
					children: [
						jsx("span", { className: "sap-sigil", children: "⚡" }),
						jsx("span", { className: "sap-brand", children: "Subagent" }),
						jsxs("span", {
							className: "sap-live",
							"data-active": String(activeCount > 0),
							children: [
								jsx("i", { className: "sap-pulse" }),
								activeCount + (showHistory ? "/" + totalCount : "") + " 活跃",
							],
						}),
						jsx("button", {
							type: "button",
							className: "sap-btn",
							title: showHistory ? "只看活跃" : "显示已结束",
							onClick: () => {
								setShowHistory((value) => {
									writeStored({ history: !value });
									return !value;
								});
							},
							children: showHistory ? "活跃" : "全部",
						}),
						jsx("button", {
							type: "button",
							className: "sap-btn",
							"data-zoom": "true",
							title: "缩小(最小 " + Math.round(ZOOM_MIN * 100) + "%)",
							onClick: () => {
								bumpZoom(-ZOOM_STEP);
							},
							children: "−",
						}, "zoom-out"),
						jsx("button", {
							type: "button",
							className: "sap-zoomval",
							title: "点击恢复 100%" + "(范围 " + Math.round(ZOOM_MIN * 100) + "%~" + Math.round(ZOOM_MAX * 100) + "%)",
							onClick: () => {
								bumpZoom(0);
							},
							children: Math.round(zoom * 100) + "%",
						}, "zoom-val"),
						jsx("button", {
							type: "button",
							className: "sap-btn",
							"data-zoom": "true",
							title: "放大(最大 " + Math.round(ZOOM_MAX * 100) + "%)",
							onClick: () => {
								bumpZoom(ZOOM_STEP);
							},
							children: "+",
						}, "zoom-in"),
						jsx("button", {
							type: "button",
							className: "sap-btn",
							title: collapsed ? "展开" : "收起",
							onClick: () => {
								setCollapsed((value) => {
									writeStored({ collapsed: !value });
									return !value;
								});
							},
							children: collapsed ? "展开" : "收起",
						}, "collapse"),
					],
				});

				const body = collapsed
					? null
					: jsx("div", {
						className: "sap-body",
						children: detail !== undefined
							? jsx(Drawer, {
								entry: detail,
								now,
								onBack: () => {
									setDetailId(null);
								},
								onForceOpen: props.api.open,
							}, "drawer")
							: groups.length === 0
								? jsxs("div", {
									className: "sap-empty",
									children: [
										jsx("div", { className: "sap-radar" }),
										jsx("div", {
											className: "sap-empty-text",
											children: showHistory ? "暂无 dsh_task 记录" : "无活跃子代理",
										}),
									],
								})
								: groups.map((group) => jsx(Group, {
									group,
									open: isOpenOf(group),
									now,
									onToggle: toggleGroup,
									onSelect,
								}, group.key)),
					});

				// 底部状态条:token 用量累计(输入/输出/缓存命中)+ 运行中任务的吞吐。
				// 口径与宿主自己的对话统计一致 —— 缓存命中率是`缓存读 / prompt 侧总量`,
				// 部分命中绝不显示成 100%;吞吐是观察器按**真实采样时间跨度**算出来的
				// (客户端不再自己每秒采样,那种短窗口会把一整块输出算成"一秒几千 token")。
				const usageTotal = sumUsage(visible);
				const hitPercent = usageTotal === null ? null : cacheHitPercent(usageTotal);
				const statItems = [];
				if (usageTotal !== null) {
					statItems.push(usageTotal.tps > 0
						? (usageTotal.live > 1 ? "Σ " + Math.round(usageTotal.tps) : String(Math.round(usageTotal.tps))) + " tok/s"
						: "— tok/s");
					if (hitPercent !== null) statItems.push("缓存命中 " + hitPercent + "%");
					statItems.push("输入 " + fmtTokens(usageTotal.input) + " tok · 输出 " + fmtTokens(usageTotal.output) + " tok");
				}
				const foot = collapsed || groups.length === 0
					? null
					: jsxs("div", {
						className: "sap-foot",
						children: [
							jsxs("div", {
								className: "sap-foot-line",
								children: [
									jsx("span", {
										children: nativeCount > 0
											? "外部任务 + " + nativeCount + " 个本机子代理"
											: "点击即打开,与普通会话一致",
									}),
									jsx("span", {
										style: { marginLeft: "auto", color: "var(--sap-accent)" },
										children: activeCount > 0 ? "◉ 实时" : "◌ 待机",
									}),
								],
							}),
							usageTotal === null
								? null
								: jsx("div", {
									className: "sap-stats",
									title: "累计 " + usageTotal.count + " 个会话 · prompt 侧 " + fmtTokens(usageTotal.prompt)
										+ " tok(缓存读 " + fmtTokens(usageTotal.cacheRead) + ")"
										+ (usageTotal.tps > 0
											? " · 吞吐是观察器按真实采样时间窗算的" + (usageTotal.live > 1 ? "," + usageTotal.live + " 个在跑的会话合计" : "")
											: ""),
									children: statItems.flatMap((item, index) => (index === 0
										? [jsx("span", { className: "sap-stat", "data-live": String(usageTotal.tps > 0), children: item }, "stat-" + index)]
										: [
											jsx("i", { className: "sap-stat-sep", children: "|" }, "sep-" + index),
											jsx("span", { className: "sap-stat", children: item }, "stat-" + index),
										])),
								}),
						],
					});

				return jsxs("div", {
					className: "sap-root",
					"data-collapsed": String(collapsed),
					"data-sized": String(sized),
					style: { ...style, "--sap-zoom": String(zoom), ...sizeStyle },
					children: jsx("div", {
						className: "sap-zoom",
						children: jsxs("div", {
							className: "sap-card",
							children: [
								jsx("i", { className: "sap-corner", "data-at": "tl" }),
								jsx("i", { className: "sap-corner", "data-at": "tr" }),
								jsx("i", { className: "sap-corner", "data-at": "bl" }),
								jsx("i", { className: "sap-corner", "data-at": "br" }),
								head,
								body,
								foot,
								// 像真窗口一样随便拉:右边拉宽(每行多放几个磁贴)、下边拉高(内容滚动)、
								// 右下角两个方向一起拉。双击任意把手 = 恢复默认尺寸。
								jsx("i", {
									className: "sap-grip",
									"data-axis": "x",
									title: "拖动改宽度(拉宽后每行能多放几个磁贴)· 双击恢复默认",
									onMouseDown: onResize,
									onDoubleClick: resetSize,
								}),
								jsx("i", {
									className: "sap-grip",
									"data-axis": "y",
									title: "拖动改高度 · 双击恢复默认",
									onMouseDown: onResize,
									onDoubleClick: resetSize,
								}),
								jsx("i", {
									className: "sap-grip",
									"data-axis": "xy",
									title: "拖动改宽高(自由缩放,不是等比例)· 双击恢复默认",
									onMouseDown: onResize,
									onDoubleClick: resetSize,
								}),
							],
						}),
					}),
				});
			}

			/** 需要注入的客户端服务:slots 注册席位,sessions 打开会话。 */
			const inject = ["slots", "sessions"];

			function apply(ctx) {
				const api = {
					open: (sessionId) => {
						try {
							ctx.sessions.open(sessionId);
						} catch (error) {
							console.error("[dsh-subagent-panel] 打开会话失败", sessionId, error);
						}
					},
					// 本机子代理的目录是按需拉的:卡片只对"报告还有下一层"的子代理请求一次,
					// 这样递归链(L1 → L2 → L3)能自己展开,不用先点开宿主的子代理面板。
					refreshSubagents: (parentSessionId) => {
						try {
							ctx.sessions.refreshSubagents(parentSessionId);
						} catch (error) {
							console.error("[dsh-subagent-panel] 拉取子代理目录失败", parentSessionId, error);
						}
					},
				};
				// 任何意外都只记日志:客户端 Loader 里一个条目抛错会让整个启动图断言失败,
				// 那等于把 GUI 弄坏 —— 卡片坏了也不能拖垮宿主。
				try {
					// shell.overlay 是 ui-layout 声明的帧级悬浮层(可叠加、点击穿透、子元素自动接管指针事件)。
					ctx.slots.inject("shell.overlay", () => ctx.slots.register({
						name: "shell.overlay",
						id: "dsh-subagent-panel",
						order: 1000,
						inject: () => ({ api }),
					}, Panel));
				} catch (error) {
					console.error("[dsh-subagent-panel] 注册悬浮卡片失败(宿主不受影响)", error);
				}
			}

			return { apply, inject, logic };
		},
	});
})();
