# 安装与卸载指南

本文档介绍如何在本地将 **DSH(DeepSeek Harness)** 接入 Cursor、Claude Code、Codex 等外部工具，作为独立子代理（subagent）运行。

运行环境要求：**Node.js ≥ 24** 以及已安装的 **DSH Desktop**。安装过程执行幂等写入，修改配置前会自动创建备份。

---

## 0. 前置条件

| 检查项 | 要求 | 验证命令 |
| --- | --- | --- |
| DSH Desktop | 已完成安装且图形界面可正常启动（桥接层直接调用其附带的 `dsh` 启动器） | 执行 `dsh --version` 输出版本号 |
| DSH 版本 | **0.1.5-rc.1 已适配并完成全量验证**；同时兼容 0.1.4 及更早版本（三处接口变更均包含向前兼容逻辑） | 执行 `dsh --version` |
| `dsh` 命令在系统 PATH 中 | 安装脚本使用 `lib/launcher.mjs` 解析启动器：启动入口脚本失效时**自动修正指向**；若无法修正，则**回退至下一个候选路径**；全部候选失效时直接报错 | 执行 `dsh --where` 或 `where dsh` |
| Node.js ≥ 24 | 状态监控组件与测试套件依赖 `node:zlib` 的 zstd 接口以及 `fs` 模块新特性 | 执行 `node -v` |
| 操作系统 | **Windows**（进程存活检查与强制终止依赖 `taskkill` 和 PowerShell 进程快照） | — |
| `DSH_HOME` | 默认路径为 `~/.dsh`；桥接层所有运行数据均落在此目录下 | 执行 `echo $env:DSH_HOME` |

Node.js ≥ 24 的技术原因：宿主运行时基于 Electron 43 / Node 24.18，`zstdDecompressSync` 与 `zstdCompressSync` 是解析子代理会话日志文件（`session.jsonl.zstd`）的必要依赖，自检套件同样依赖该接口。

---

## 1. 完整安装步骤

执行以下命令克隆仓库并运行安装脚本：

```powershell
git clone https://github.com/<owner>/deepseek-harnessed.git $env:USERPROFILE\.dsh\subagent
cd $env:USERPROFILE\.dsh\subagent
node install.mjs --dry-run     # 先干跑,看清它会动哪些文件
node install.mjs               # 真正执行
```

安装根目录选择 `~/.dsh/subagent` 的原因：该路径为桥接层的默认根目录（即 `lib/util.mjs` 中的 `BRIDGE_ROOT`）。若安装在其他目录，启动器仍可基于自身位置推导根目录，但默认文档说明、图形插件与监控脚本注册路径均以此目录为准。迁移目录后需重新运行 `node install.mjs` 更新配置。

### 安装操作清单

| 序号 | 执行操作 | 目标文件与路径 |
| --- | --- | --- |
| 1 | 将 `profile/` 目录同步为 DSH 的 **`subagent` profile** | `$DSH_HOME/profiles/subagent/` |
| 2 | 向用户 PATH 目录写入两个可执行包装脚本 | `~/.local/bin/dsh-subagent`、`dsh-subagent-mcp` |
| 3 | 将 MCP 服务器注册至**本机已检测到的外部工具**中 | 详细说明见 [客户端接入文档](./clients.md) |
| 4 | 写入任务分派优先使用 DSH 的全局规则与 Claude Code 子代理定义 | `~/.dsh/AGENTS.md` 等配置文件 |

所有写入均为**幂等操作**：重复执行将生成相同配置。修改已有文件前，安装程序会自动生成格式为 `<文件>.bak-dshsubagent-<时间戳>` 的备份副本。

### 按需安装指定组件

支持通过 `--only` 参数指定安装目标：

```powershell
node install.mjs --only profile            # 只装 DSH 侧 profile
node install.mjs --only observer           # 只装 GUI 观察器插件
node install.mjs --only panel              # 只装悬浮卡片插件
node install.mjs --only cursor,claude,codex  # 只注册这几个 harness
node install.mjs --only=claude             # --only=xxx 写法等价
```

可用组件名称包括：`profile`、`observer`、`panel`、`cursor`、`claude`、`claude-desktop`、`codex`、`gemini`、`antigravity`、`kiro`、`qoder`、`vscode`、`copilot-cli`、`opencode`。

---

## 2. 基础功能验证

安装完成后，依次执行以下三项检查验证桥接状态：

```powershell
# ① 桥接层自己是否就绪(等价于 harness 里的 dsh_health)
dsh-subagent --where

# ② 真跑一轮:在指定工作空间里让 DSH 干一件可验证的事
dsh-subagent -w D:\some\repo "列出后端路由文件,汇总最近改动"

# ③ 协议级自检:真的拉起 MCP server 并跑一轮任务
node test\selftest.mjs
```

命令 ② 的标准输出即为 DSH 的执行答复，进程退出码为 `0` 表示执行成功。命令 ③ 全部测试项通过表示 MCP 协议通信正常。

### 完整测试套件执行命令

修改代码后可执行全部自检脚本：

```powershell
npm run test:all                      # 上面 10 个自检脚本一次跑完(309 项)
```

也可以按模块单独运行对应的自检脚本：

```powershell
node test\launcher-heal-probe.mjs    # 入口失效时自愈 / 回退到下一个候选 / 全失效时聚合报错
node test\panel-selftest.mjs         # 悬浮卡片逻辑
node test\selftest.mjs               # 协议级端到端:真拉 MCP server + 真跑一轮任务
node test\wait-policy-probe.mjs      # 等待规则:默认短超时自己等、只有 running 才轮询
node test\observer-selftest.mjs      # GUI 观察器(投影 / 判活 / token 折叠 / 吞吐规则)
node test\ledger-liveness-probe.mjs  # 台账残留记录(按 pid 判活)
node test\monitor-autostart-probe.mjs# 监控窗口自动拉起(假 exe,**不会真启动 GUI**)
node test\leaf-only-probe.mjs        # 叶子检查:外部任务不许再分派子代理
node test\exec-surface-probe.mjs     # 执行面体检(空转检测 + 会话日志改名兼容)
node test\monitor-live-probe.mjs     # 真心跳 + 真 dsh_task:验 already-running 分支
node test\usage-fold-probe.mjs --all # 真实任务日志 → token 用量(只读)
node test\live-audit.mjs             # 现场审计:真的在跑几个 / 残留记录几个 / 宿主状态
```

> **DSH 升级后的验证顺序**：优先运行 `selftest`（覆盖端到端协议调用）、`leaf-only-probe`（检查配置行 ID 兼容性）与 `monitor-live-probe`（检查状态监控与宿主存活判断）。版本兼容性技术细节参见主文档中的版本兼容说明。

---

## 3. 图形监控插件生效说明

桥接层包含两个**宿主插件**，生效机制与更新方式如下：

| 插件名称 | 文件路径 | 生效方式 |
| --- | --- | --- |
| 会话监控脚本 | `monitor/observer.mjs` | 写入 `desktop` profile 的受管配置块。**修改后必须重启 DSH Desktop 宿主进程** |
| 悬浮状态面板 | `gui/lib/client.js`（浏览器客户端脚本包） | 由宿主启动图注入浏览器界面。**修改后刷新页面即可生效**（必要时使用 `Ctrl+F5`） |

> 说明：DSH Desktop 宿主对 `file:` 协议引用的插件不执行动态热重载。观察器在心跳文件中记录了版本字段：
>
> ```powershell
> Get-Content $env:USERPROFILE\.dsh\subagent\state\observer-heartbeat.json
> ```
>
> 当前版本心跳文件中包含 `usageRate` 字段（结构为 `{ minSpanMs, samples, foldThrottleMs }`）。若心跳文件缺少该字段，说明宿主进程仍运行旧版观察器。

面板脚本 URL 携带内容哈希（形如 `?…&rev=<hash>`），响应头包含 `cache-control: public, max-age=31536000, immutable`。文件内容变动后 URL 会自动更新，通常直接刷新即可。若宿主进程启动后修改客户端代码导致哈希未变，使用 `Ctrl+F5` 强制刷新浏览器缓存。

---

## 4. 卸载操作

执行卸载脚本移除配置：

```powershell
node uninstall.mjs            # 摘掉受管区块与包装脚本,并备份被改过的配置
node uninstall.mjs --dry-run  # 先看会动什么
```

卸载程序仅移除安装时写入的受管标记区块（由 `>>> dsh-subagent-… >>>` 标识包围），不会修改配置文件中的其他用户自定义内容。

---

## 5. 常见故障排查

| 故障现象 | 排查原因与处理方法 |
| --- | --- |
| `dsh_health` 报错提示找不到启动器 | 系统 PATH 中未包含 `dsh` 命令。重新打开终端加载环境变量，或设置环境变量 `DSH_SUBAGENT_DSH_SHIM` 显式指向 `dsh.cmd` 路径 |
| 调用 `dsh` 立即失败，错误日志包含 `Cannot find module '…\resources\app.asar\lib\desktop-cli.js'` | **DSH Desktop 升级后入口脚本路径失效**（新版本将启动文件由 `resources\app.asar\lib\` 调整至 `resources\app\lib\`，已有的 `dsh.cmd` 不会自动同步更新）。0.1.6 及以上版本会自动检测并修正至有效入口；单个候选路径无法修正时将**尝试下一候选路径**；**全部候选路径均失效**时输出汇总错误信息并列出各路径缺失项。处理方式：手动修改入口脚本指向有效文件、删除失效脚本使 Desktop 重新生成，或使用 `DSH_SUBAGENT_DSH_SHIM` 显式指定可用启动脚本 |
| 子代理进程启动后以退出码 1 异常退出，日志提示 `composed sandbox and approval defaults match no preset` | 修改了 profile 的沙箱模式或审批模式，但未同步更新预设映射表。技术原因与修复方式参见 [配置参考文档](./configuration.md#权限预设为什么必须逐字对齐) |
| 悬浮监控面板内容为空 | 监控插件未加载（需重启 DSH Desktop），或浏览器命中了旧版缓存（执行 `Ctrl+F5` 强制刷新） |
| 会话日志解析出现乱码 | 运行环境中的文件过滤策略可能影响多进程并发读写的一致性。使用 `dsh-subagent --list` 或悬浮面板读取会话数据，必要时将日志文件复制至临时目录后解析 |
| PowerShell 重定向输出生成 UTF-16 编码文件 | PowerShell 默认重定向操作符 `>` 采用 UTF-16LE 编码。建议改用 `Set-Content -Encoding utf8` 或调用内置文件编辑工具写入 |
