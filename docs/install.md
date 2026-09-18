# 安装与卸载

> 目标读者:想在自己机器上把 **DSH(DeepSeek Harness)** 接成一个可被 Cursor / Claude Code /
> Codex 等 harness 调用的 subagent 的人。
>
> 全程只需要 **Node.js ≥ 24** 和 **一个装好的 DSH Desktop**。安装器是幂等的、会先备份。

---

## 0. 前置条件

| 项目 | 要求 | 怎么确认 |
| --- | --- | --- |
| DSH Desktop | 已安装并能启动 GUI(桥接层最终调用的就是它的 `dsh` 启动器) | `dsh --version` 能打印版本 |
| DSH 版本 | **0.1.5-rc.1 已适配并全量实测**;0.1.4 及更早同样兼容(三处 API 变化都做了向前兼容) | `dsh --version` |
| `dsh` 在 PATH 上 | 安装器会用 `lib/launcher.mjs` 解析启动器;解析不到会明确报错 | `dsh --where` 或 `where dsh` |
| Node.js ≥ 24 | 观察器与测试用到 `node:zlib` 的 zstd、`fs` 的新行为 | `node -v` |
| 操作系统 | **Windows**(进程判活/强杀走 `taskkill` 与 PowerShell 进程快照) | — |
| `DSH_HOME` | 默认 `~/.dsh`;桥接层所有落盘都在它下面 | `echo $env:DSH_HOME` |

> 为什么要 Node ≥ 24:主机运行时是 Electron 43 / Node 24.18,`zstdDecompressSync` 与
> `zstdCompressSync` 是解子代理会话日志(`session.jsonl.zstd`)的前提,自检也依赖它。

---

## 1. 一键安装

```powershell
git clone https://github.com/<owner>/deepseek-harnessed.git $env:USERPROFILE\.dsh\subagent
cd $env:USERPROFILE\.dsh\subagent
node install.mjs --dry-run     # 先干跑,看清它会动哪些文件
node install.mjs               # 真正执行
```

**为什么装在 `~/.dsh/subagent`**:这是桥接层的默认根目录(`lib/util.mjs` 里的 `BRIDGE_ROOT`)。
装到别处也能跑(启动器会按自己的位置推断根目录),但文档、GUI 插件与观察器注册的路径
都按这个位置写。想换位置就把整个目录搬走,再重跑一次 `node install.mjs` 重新写一遍路径。

### 安装器做的四件事

| # | 动作 | 落点 |
| --- | --- | --- |
| 1 | 把 `profile/` 同步成 DSH 的 **`subagent` profile** | `$DSH_HOME/profiles/subagent/` |
| 2 | 在 PATH 上放两个包装脚本 | `~/.local/bin/dsh-subagent`、`dsh-subagent-mcp` |
| 3 | 把 MCP server 注册进**本机所有已安装的 harness** | 见 [clients.md](./clients.md) |
| 4 | 写入「委托优先走 DSH」的全局指令与 Claude Code 子代理定义 | `~/.dsh/AGENTS.md` 等 |

所有写入都是**幂等**的:重复执行只是把同一段内容覆盖成一样的;每次改动前会备份成
`<文件>.bak-dshsubagent-<时间戳>`。

### 只装一部分

```powershell
node install.mjs --only profile            # 只装 DSH 侧 profile
node install.mjs --only observer           # 只装 GUI 观察器插件
node install.mjs --only panel              # 只装悬浮卡片插件
node install.mjs --only cursor,claude,codex  # 只注册这几个 harness
node install.mjs --only=claude             # --only=xxx 写法等价
```

可用的名字:`profile` / `observer` / `panel` / `cursor` / `claude` / `claude-desktop` /
`codex` / `gemini` / `antigravity` / `kiro` / `qoder` / `vscode` / `copilot-cli` / `opencode`。

---

## 2. 五分钟验证

```powershell
# ① 桥接层自己是否就绪(等价于 harness 里的 dsh_health)
dsh-subagent --where

# ② 真跑一轮:在指定工作空间里让 DSH 干一件可验证的事
dsh-subagent -w D:\some\repo "列出后端路由文件,汇总最近改动"

# ③ 协议级自检:真的拉起 MCP server 并跑一轮任务
node test\selftest.mjs
```

②的输出就是 DSH 的最终答复,退出码 `0` 表示正常完成。③要全绿才算装好。

### 完整自检套件(改过代码后再跑)

```powershell
npm run test:all                      # 上面 9 个探针一次跑完(296 项)
```

或逐个跑:

```powershell
node test\panel-selftest.mjs         # 悬浮卡片逻辑
node test\selftest.mjs               # 协议级端到端:真拉 MCP server + 真跑一轮任务
node test\wait-policy-probe.mjs      # 等待口径:默认短超时自己等、只有 running 才轮询
node test\observer-selftest.mjs      # GUI 观察器(投影 / 判活 / token 折叠 / 吞吐口径)
node test\ledger-liveness-probe.mjs  # 台账幽灵记录(按 pid 判活)
node test\monitor-autostart-probe.mjs# 监控窗口自动拉起(假 exe,**不会真启动 GUI**)
node test\leaf-only-probe.mjs        # 叶子闸门:外部任务不许再分派子代理
node test\exec-surface-probe.mjs     # 执行面体检(空转检测 + 会话日志改名兼容)
node test\monitor-live-probe.mjs     # 真心跳 + 真 dsh_task:验 already-running 分支
node test\usage-fold-probe.mjs --all # 真实任务日志 → token 用量(只读)
node test\live-audit.mjs             # 现场审计:真的在跑几个 / 幽灵几个 / 宿主状态
```

> **升级 DSH 之后先跑这三个**:`selftest`(最灵敏,升级打坏桥接层时它第一个红)、
> `leaf-only-probe`(row id 有没有被改名/删掉)、`monitor-live-probe`(观察器与宿主判活)。
> 版本兼容性细节见 README 的「DSH 版本兼容性」章节。

---

## 3. 让 GUI 真正看到实时数据(**必读**)

桥接层由两块**宿主插件**组成,它们的安装位置与生效条件不一样:

| 插件 | 文件 | 生效条件 |
| --- | --- | --- |
| 观察器 | `monitor/observer.mjs` | 写进 `desktop` profile 的受管区块。**改完必须重启 DSH Desktop** |
| 悬浮卡片 | `gui/lib/client.js`(客户端 bundle) | 由启动图带进浏览器。**改完刷新页面**(必要时 `Ctrl+F5`) |

> ⚠️ **实测踩坑:`file:` 插件不会热重载。** 我们在心跳文件里加了口径版本字段来验证这一点 ——
> 宿主启动之后改的观察器代码,心跳一直更新却始终没有新字段,说明跑的还是旧代码。
> 判断当前宿主里跑的是哪一版:
>
> ```powershell
> Get-Content $env:USERPROFILE\.dsh\subagent\state\observer-heartbeat.json
> ```
>
> 新版心跳里有 `usageRate` 字段(`{ minSpanMs, samples, foldThrottleMs }`),旧版没有。

卡片的 bundle URL 带**内容哈希**(`?…&rev=<hash>`),响应头是
`cache-control: public, max-age=31536000, immutable`。内容一变 URL 就变,所以通常**普通刷新**
即可;若 rev 没变(宿主启动后才改的客户端代码),按一次 **`Ctrl+F5`** 强刷。

---

## 4. 卸载

```powershell
node uninstall.mjs            # 摘掉受管区块与包装脚本,并备份被改过的配置
node uninstall.mjs --dry-run  # 先看会动什么
```

卸载器只摘除**由安装器写入的受管区块**(用 `>>> dsh-subagent-… >>>` 标记包住),
不会碰你在这些配置文件里的其它内容。

---

## 5. 常见坑

| 现象 | 原因 / 处理 |
| --- | --- |
| `dsh_health` 报找不到启动器 | `dsh` 不在 PATH。装好 DSH Desktop 后重开一个终端;或用 `DSH_SUBAGENT_DSH_SHIM` 显式指向 `dsh.cmd` |
| 子代理起来就退出码 1,日志里有 `composed sandbox and approval defaults match no preset` | 你改了 profile 的沙箱/审批组合却没有同步预设表。见 [configuration.md](./configuration.md#权限预设为什么必须逐字对齐) |
| 卡片一直是空的 | 观察器没生效(没重启),或页面命中了旧 bundle(强刷一次) |
| 会话日志读出来是乱码 | 某些安全软件的文件过滤会让"一个进程写、另一个进程读"的文件变成非原文。用 `dsh-subagent --list` 与卡片读(它们都经由 node),必要时把文件复制出来再解析 |
| PowerShell 写出来的文件变成 UTF-16 | PowerShell 的 `>` 默认 UTF-16LE。用 `Set-Content -Encoding utf8` 或直接用文件工具写 |
