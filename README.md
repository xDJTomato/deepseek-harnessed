# deepseek-harnessed

把整个 **DeepSeek Harness(DSH)** 实例变成一个可被 **Cursor / Claude Code / Codex /
Gemini CLI / Antigravity / Kiro / Qoder / VS Code(Copilot)/ opencode** 调用的
**subagent**,并给 DSH Desktop 加一块**实时监控悬浮卡片**。

> 仓库名的一句话解释:harness **反过来被 harnessed** —— 让这些 harness 把子任务交给一台
> **真正的 DSH 实例**去干,而不是在自己进程里开一个函数式子代理。

它由三部分组成:

| 部分 | 位置 | 作用 |
| --- | --- | --- |
| **MCP 桥接层** | `bin/` + `lib/` | 一个 stdio MCP server,暴露 `dsh_task` 等五个工具;每个任务拉起一个独立的 DSH 进程 |
| **DSH `subagent` profile** | `profile/` | 让这个 DSH 进程成为"一次会话、无人值守、只做叶子"的执行体 |
| **GUI 宿主插件** | `monitor/` + `gui/` | 观察器把外部任务的实时状态灌进会话投影;悬浮卡片按调用方分组显示 |

## 先看这三页

| 文档 | 内容 |
| --- | --- |
| **[docs/install.md](docs/install.md)** | 前置条件、一键安装、五分钟验证、卸载、常见坑 |
| **[docs/configuration.md](docs/configuration.md)** | 全部环境变量(逐条来自源码)、profile 逐行解释、权限与叶子闸门、卡片偏好 |
| **[docs/clients.md](docs/clients.md)** | 每个客户端的注册位置与 JSON 形状、手工接入、让内置 subagent 转调 DSH |

本文件往下是**完整设计与实测记录**(§1~§10),含每一条踩过的坑与真实测量数据。

---

## 支持矩阵

| 客户端 | 注册方式 | 一键 |
| --- | --- | --- |
| Cursor(IDE + `cursor-agent`) | `~/.cursor/mcp.json` → `mcpServers.dsh` | ✅ |
| Claude Code | `~/.claude.json` → `mcpServers.dsh` | ✅ |
| Claude Desktop | `%APPDATA%\Claude\claude_desktop_config.json` | ✅ |
| Codex CLI / Desktop | `~/.codex/config.toml` → `[mcp_servers.dsh]` | ✅ |
| Gemini CLI | `~/.gemini/settings.json` | ✅ |
| Antigravity | `~/.gemini/antigravity/mcp_config.json` | ✅ |
| Kiro | `~/.kiro/settings/mcp.json` | ✅ |
| Qoder | `~/.qoder/mcp.json` | ✅ |
| VS Code / Copilot | `%APPDATA%\Code\User\mcp.json` → `servers.dsh` | ✅ |
| opencode | `~/.config/opencode/opencode.json` → `mcp.dsh` | ✅ |
| Claude Code / Codex / Cursor 的**内置 subagent** | 写全局指令,让子代理委派**转调 DSH** | ✅ |

---

## DSH 版本兼容性

桥接层跑在 DSH **内部**(一个 profile + 两个宿主插件),所以 DSH 升级会直接打到我们身上。
下面这张表是**实测**结果,不是推测:宿主插件目录里的 `app.asar.unpacked/` 会留下旧版同名包,
照它读会得出错误结论,正确做法是从 `app.asar` 里读运行时真正加载的那份源码。

| DSH 版本 | 状态 | 说明 |
| --- | --- | --- |
| **0.1.5-rc.1** | ✅ 已适配并全量实测 | 破坏性 API 变化 3 处,见下 |
| 0.1.4 及更早 | ✅ 仍兼容 | 三处变化都做了向前兼容(见下) |

### 0.1.5-rc.1 的三处破坏性变化(以及我们怎么处理)

| 变化 | 症状 | 处理 |
| --- | --- | --- |
| `@deepseek-ai/dsh-llm` **不再导出 `assertNever`**(搬到了 `dsh-util-values`) | **最凶的一个**:profile 在插件树加载阶段就 `SyntaxError`,`dsh_task` 1.5 秒即失败、不写文件、答复为空 —— 看起来像"任务跑完了但什么都没发生" | 去掉该 import,改成 runner 内的 `warnUnknownChunk()`:未知 chunk **告警并忽略**,不再让一个未知事件类型打断整轮 |
| `permissionPresets.current()` 改收 **Session 对象**(原先收事件数组) | 传错形状不报"参数不对",而是从 DSH 内部炸出 `Cannot read properties of undefined (reading 'header')`,栈里全是 DSH 内部帧,极难定位 | 新增 `currentPreset()`:先按新版调(session),失败再按旧版调(events),两条路都不通才抛原错 |
| `session.events` → **`session.log`** | 同上,取事件流会拿到 `undefined` | 新增 `eventsOf(session)`,兼容两个名字 |

同时 `fail()` 现在会打印**完整栈**(以前只打 `error.message`)。正是因为只打 message,
上面第 2 条最初只表现为一句没头没尾的报错;栈一出来立刻定位到是 `presets.current()` 的形状变了。

### 上游自身的问题(与本插件无关,但会影响你)

0.1.5-rc.1 里随版本发布的 `lsp-stdio` / `tool-lsp` 两个插件**没有跟上** `assertNever` 的迁移,
import 时直接抛 `does not provide an export named 'assertNever'`。插件树是**整体加载**语义,
所以:

- `dsh --profile web` **完全起不来**(实测,与是否装了本插件无关)。
- **桌面宿主不受影响**:`desktop` profile 的插件树里根本没有这两行(实测 `--dump-config`,
  宿主日志里也没有 `assertNever`)。
- 万一你需要 `web` profile,临时绕开办法就是关掉这两行:

  ```yaml
  - id: lsp-stdio
    disabled: true
  - id: tool-lsp
    disabled: true
  ```

  (`--patch` 传一个只含这两行的 overlay 即可,已验证能起来。)

### 升级后怎么快速自证没坏

```bash
dsh --version                                  # 先看版本
node test/selftest.mjs                         # 协议级端到端:真拉 MCP + 真跑一轮(最能说明问题)
node test/leaf-only-probe.mjs                  # row id 有没有被改名/删掉
node test/monitor-live-probe.mjs               # 观察器 + 宿主判活
```

升版本必看的两类东西:**row id**(我们 patch 了 15 行,改名就静默失配)与**服务方法签名**。
`test/leaf-only-probe.mjs` 覆盖前者(它自己就抓到过一次:0.1.5 起 `tool-subagent-report`
不再是 loader 行,`subagent-report` 变成了协议里的消息 kind)。

---

## 安全与隐私(请先读)

- **桥接层不访问互联网**,它只做两件事:拉起本机 `dsh` 子进程、读写 `$DSH_HOME` 与本机
  各 harness 的配置文件。
- **默认权限是 `danger-full-access`**(无审批、全盘读写)。这是刻意的:调用方本来就是有写权限的
  harness,子代理要在你的工作空间里真干活。要收紧就用 `permission: "workspace-write"` /
  `"read-only"`,或用 `DSH_SUBAGENT_PERMISSION` 改默认档。
- **`state/` 是私有运行期数据,已在 `.gitignore` 中排除**:观察器日志、心跳、任务记录
  (`task.json` / `meta.json` / `stderr.log`)含本机绝对路径、工作区名、提示词与子代理输出。
  仓库里**不含**任何真实任务现场。
- 安装器对每个被改的配置文件都会**先备份**(`.bak-dshsubagent-<时间戳>`),并且**永不覆盖**
  解析不了的 JSON 配置。
- 平台:**Windows**。进程判活/强杀依赖 `taskkill` 与 PowerShell 进程快照,别的平台未验证。

---

## 它是怎么工作的

本目录是桥接层:本机(Cursor、Claude Code、Codex、Gemini CLI、Antigravity、Kiro、
Qoder、VS Code/Copilot、opencode)都可以把一项任务**委托给一个真正的 DeepSeek
Harness 实例**执行,并把它在指定工作空间里的最终答复取回来。

```
Cursor / Claude Code / Codex / … 的对话
        │  ① 调用 MCP 工具 dsh_task(prompt, workspace, expected_seconds)
        ▼
dsh-subagent-mcp.mjs   (MCP stdio server,本目录 bin/)
        │  ② 分配 job id,把提示词从 stdin 交给子进程
        ▼
"DSH Desktop.exe" --profile subagent   ← 一台完整的 DSH 实例,一轮会话
        │  ③ 在 workspace 里真干活:读写文件、跑命令、跑测试、联网检索
        ▼
$DSH_HOME/sessions/<workspace>/session-<uuid>/   (会话落盘,可在 DSH GUI 里复查)
        │  ④ 最终答复 → result.txt / stdout
        ▼
dsh_task 返回 "status: ok" + DSH 的原文
```

与内置 subagent 的关键区别:**它是一个独立的 DSH 进程**,有自己的上下文窗口、
自己的模型、自己的工具链和落盘的会话记录,而不是宿主 harness 里的一个函数调用。


---

## 1. 一分钟自检

```powershell
# 桥接是否可用(等价于 harness 里的 dsh_health 工具)
dsh-subagent --where

# 真跑一轮:在指定工作空间里让 DSH 干一件可验证的事
dsh-subagent -w D:\some\repo "列出后端路由文件,汇总最近改动"

# 协议级自检(会真的拉起 MCP server 并跑一轮任务)
node $env:USERPROFILE\.dsh\subagent\test\selftest.mjs

# 监控窗口自动拉起(假 exe + 临时 DSH_HOME,**不会真的启动 GUI**)
node $env:USERPROFILE\.dsh\subagent\test\monitor-autostart-probe.mjs

# 台账幽灵记录(记录说在跑、pid 早没了)→ 必须按 pid 判活
node $env:USERPROFILE\.dsh\subagent\test\ledger-liveness-probe.mjs

# 叶子闸门:外部任务不能再生子代理(配置级 + 解出会话日志看真实工具表)
node $env:USERPROFILE\.dsh\subagent\test\leaf-only-probe.mjs <sessionId片段>

# 卡片底部状态条的数字:真实任务日志 → token 用量(逐帧解 zstd,只读)
node $env:USERPROFILE\.dsh\subagent\test\usage-fold-probe.mjs --all
```

---

## 2. 对外暴露的五个 MCP 工具

服务器名统一叫 **`dsh`**,因此在各 harness 里工具名形如
`mcp__dsh__dsh_task`(Claude Code)或 `dsh.dsh_task`(Codex/Cursor)。

| 工具 | 作用 |
| --- | --- |
| `dsh_task` | 委托一项自包含任务。**必须**给 `expected_seconds`(见下);默认阻塞等待 `wait_seconds`(**30s**);超时则返回 `status: running` 和 `job_id`,由调用方继续轮询 |
| `dsh_task_status` | 查询/继续等待某个 job;带上 `expected_seconds` / `deadlineAt` / `remainingSeconds`、**`process_tree`**(实时后代进程数 + 整树 CPU)与 **`recent_activity`**(子代理此刻在干什么);`ok` 时一并返回 DSH 的最终答复全文 |
| `dsh_task_cancel` | **优雅取消**:标记取消并请求停下,让任务自己收尾 |
| `dsh_task_kill` | **强制终止**:按 `job_id` 或按 `caller`(停掉"我起的全部任务")立刻杀掉整个 DSH 进程树;**杀掉是验证过的**(不属于本进程的任务走 `taskkill` 并检查退出码,失败如实报 `killed:false` 而不是谎报成功);回报杀了哪些、哪些已经结束 |
| `dsh_health` | 探活:回报解析到的 dsh 启动器、DSH_HOME、默认工作空间、默认模型、**每个调用方的并发数**、**每个实时任务的截止/进度**、最近任务 |

`dsh_task` 的参数:

| 参数 | 说明 |
| --- | --- |
| `prompt`(必填) | **必须自包含**:DSH 看不到宿主会话历史、看不到宿主打开的文件,也不会追问 |
| `expected_seconds`(必填) | 调用方**自己预估**这次委派要多少秒(正整数)。缺失/非正数会被**直接拒绝**(不做默认值兜底),而且是以 **`isError: true`** 的工具结果返回——调用方必须把它当成"这次调用不成立",不能当成正常结果继续往下走。它同时是硬截止:`deadlineAt = startedAt + expected_seconds × DSH_SUBAGENT_DEADLINE_GRACE`(默认 ×2),到点杀进程树并记 `status: "deadline"` |
| `acceptance` | 可选的一句验收标准("做完 = ……"),落进 `task.json` 并在结果里回显,把验收契约写明确;超过 2000 字符同样以 `isError: true` 拒绝 |
| `workspace` | 目标工作空间绝对路径;缺省取调用方工作空间(MCP roots),再缺省取 server cwd |
| `wait_seconds` | 本次阻塞等待秒数,默认 **30**;`0` = 立刻返回 job_id |
| `timeout_seconds` | **外层**绝对墙钟上限,默认 1800;比 `expected_seconds` 的硬截止更宽松,两道闸门都生效 |
| `model` / `provider` | 单次调用换模型(如 `deepseek-v4-pro`),默认沿用 DSH 设置里的模型 |
| `permission` | `read-only` / `workspace-write` / `danger-full-access`,默认 `danger-full-access` |
| `raw_prompt` | `true` 时不加「委托说明」前言,原样传递 |

> **调用方身份**:每个 MCP 连接在 `initialize` 里带的 `clientInfo.name` 会被记到该连接发起的
> 每个任务上(`task.json` 的 `caller` / `callerVersion`,以及工具结果里的 `caller:` 行)。
> 缺省为 `"unknown"`;命令行入口记 `"cli"`。GUI 与 `dsh_health` 都按它分组。

> **轮询节奏**:拿到 `status: running` 后,请在**同一轮**里每 **20~30s** 调一次
> `dsh_task_status(job_id, wait_seconds=25)`,直到 `ok` / `error` / `deadline` / `stalled` /
> `cancelled` / `killed`。不要停在一个 `running` 上不动。

> 桥接层默认在提示词前加一段简短的「委托说明」:一次性会话、没人会回答追问、
> 结束时汇报做了什么/改了哪些文件/结论。这样 DSH 不会提问后卡死。

### 2.1 「工具调用建议」已经写进工具定义本身

以前这些约定只活在 README 里,harness 的模型看不到。现在它们**搬进了 MCP 层的工具定义**,
任何 harness 的模型只读 schema 就知道怎么用:

| 位置 | 内容 |
| --- | --- |
| `initialize.instructions` | 委派操作手册浓缩版(1258 字符 ≤ 1500):先估时长 → 写可机检验收 → 短轮询 → 状态语义 → 如何止损 → 失败排查 → 禁止项(MCP 规范支持,harness 会把它当系统提示) |
| `dsh_task.description` | 完整手册(约 1800 字符):硬承诺与经验值区间(单文件小改 60~180s / 多文件小特性 300~900s / 大重构 900~1800s 且应拆分)、`deadlineAt = 开始时刻 + expected_seconds × grace`、**七种状态各自的语义与补救动作**、失败时按 `recent_activity` → `progress_bytes`/`last_progress_at` → 任务现场三处排查、以及两条禁止项(>20 分钟的任务必须拆、`permission` 收窄时不要让子代理用 pwsh 写文件) |
| 各字段 `description` | `expected_seconds` 写明"硬承诺 + 到点杀进程树 + 经验值区间";`acceptance` 写明"一句话、可判定真伪"并给出正例;`wait_seconds` 写明"默认 30、建议 0 或 ≤30、之后每 20~30 秒轮询";`permission` 写明受限档位下请用 write/edit 文件工具;`timeout_seconds`/`model`/`provider`/`raw_prompt`/`label` 各自说明取舍 |
| `dsh_task_status.description` | 逐字段解释 `progress_bytes` / `last_progress` / `recent_activity` / `process_tree` / `silent_seconds`,并说明"静默但在干活不算停滞" |
| `dsh_task_kill` / `dsh_task_cancel.description` | 两种模式(按 `job_id` / 按 `caller`)与"什么时候该止损(任务跑偏、deadline 将近仍无进展)" |
| `dsh_health.description` | `liveTasks` / `activeByCaller` / 看门狗阈值 / `monitorHost` 各字段含义与三种使用场景 |

自检会核对这套文案真的出现在 schema 里(见 §10 的 `initialize 带委派操作手册`、
`dsh_task 描述含完整委派约定` 等条目),避免以后被人无声改掉。

---

## 3. 本机已写入的配置

| Harness | 配置文件 | 写入内容 |
| --- | --- | --- |
| Cursor(IDE + cursor-agent CLI) | `~/.cursor/mcp.json` | `mcpServers.dsh` |
| Cursor 用户级规则(尽力而为) | `~/.cursor/rules/dsh-subagent.mdc` | 「委派子任务优先用 DSH」 |
| Claude Code | `~/.claude.json` | 用户级 `mcpServers.dsh` |
| Claude Code 子代理 | `~/.claude/agents/dsh.md` | `Task(subagent_type: "dsh")` = 转发给 DSH |
| Claude Code 全局记忆 | `~/.claude/CLAUDE.md` | 「子代理委派:统一走 DSH」 |
| Claude Code 权限 | `~/.claude/settings.json` | `permissions.allow += mcp__dsh` |
| Claude Desktop(若安装) | `%APPDATA%\Claude\claude_desktop_config.json` | `mcpServers.dsh` |
| Codex CLI / Desktop | `~/.codex/config.toml` | `[mcp_servers.dsh]` |
| Codex 全局记忆 | `~/.codex/AGENTS.md` | 「子代理委派:统一走 DSH」 |
| Gemini CLI | `~/.gemini/settings.json` | `mcpServers.dsh` |
| Antigravity | `~/.gemini/antigravity/mcp_config.json` | `mcpServers.dsh` |
| Kiro | `~/.kiro/settings/mcp.json` | `mcpServers.dsh` |
| Qoder | `~/.qoder/mcp.json` | `mcpServers.dsh` |
| VS Code / Copilot | `%APPDATA%\Code\User\mcp.json` | `servers.dsh` |
| Copilot CLI 回退路径 | `~/.vscode/mcp.json` | `servers.dsh` |
| opencode | `~/.config/opencode/opencode.json` | `mcp.dsh` |
| 所有 harness 的 shell 路径 | `~/.local/bin/dsh-subagent.cmd`、`dsh-subagent-mcp.cmd` | 命令行入口 |
| DSH 本体 | `$DSH_HOME/profiles/subagent/` | 一次性 subagent profile |
| **DSH Desktop(GUI 宿主)** | `$DSH_HOME/profiles/desktop/cordis.patch.yml` | 两块受管 insert:`>>> dsh-subagent-observer >>>`(会话列表实时监控)与 `>>> dsh-subagent-panel >>>`(右上角悬浮卡片) |
| **DSH Desktop(GUI 宿主)** | `$DSH_HOME/subagent/monitor/observer.mjs`、`$DSH_HOME/subagent/gui/**` | 上面两块 insert 指向的插件本体(§6.4 / §6.5) |

所有写入都是**幂等**的,并且会先备份为 `<原文件>.bak-dshsubagent-<时间戳>`;
JSON 配置若解析失败则**跳过不写**,绝不覆盖用户配置。

重新装配 / 全部撤回:

```powershell
node $env:USERPROFILE\.dsh\subagent\install.mjs              # 幂等重装(推荐)
node $env:USERPROFILE\.dsh\subagent\install.mjs --dry-run    # 只看会改什么
node $env:USERPROFILE\.dsh\subagent\uninstall.mjs            # 摘掉所有 MCP 注册
```

---

## 4. DSH 侧:`subagent` profile

`$DSH_HOME/profiles/subagent/`(源文件在 `profile/`,由 install.mjs 同步):

```
package.json          bundles = dsh-base + dsh-headless,patchReload = startup
cordis.patch.yml      在 headless 基线上做的 7 处改动(逐条有注释)
subagent-startup.js   任务解析:--prompt / --prompt-stdin / --prompt-file / 位置参数
subagent-runner.js    一次性 runner:跑一轮 → 写 result.txt / meta.json → 退出
```

相对官方 headless 的差异:

1. **换掉只认 argv 的启动器**,支持 `--prompt-stdin`(无长度上限)与 `--result-file` /
   `--metadata-file` / `--model`;
2. **换掉 runner**:能写出最终答复文件与 `{sessionId, model, stopReason, durationMs}`
   元数据,能在单次调用里换模型;
3. 关掉 LLM 起标题(省一次模型调用);
4. 审批策略固定 `never` —— 子代理是非交互进程,没有人能点「同意」;
5. 沙箱模式由 `DSH_SUBAGENT_PERMISSION` 控制,默认 `danger-full-access`;
6. 显式声明「无人值守」权限预设表(否则 `--permission workspace-write` 会崩,见 §5);
7. **叶子闸门:外部任务不允许再分叉**(见下)。

### 4.1 叶子闸门(外部任务不许派子代理)

策略:**由其它来源(Cursor / Claude Code / Codex …)经 `dsh_task` 调进来的任务,不能再造出更多 agent;
DSH 自己内部派活走的原生 `subagent` 不受影响。** 实现方式是在 `subagent` profile 里关掉那几行
"能造 agent"的插件(只关工具,不关服务 —— 关服务会让 inject 它们的插件加载失败):

| 关掉的行 | 拿掉的工具 |
| --- | --- |
| `tool-subagent` | `subagent` |
| `tool-subagent-fork` | `subagent_fork` |
| `tool-workflow` + `workflow-worker-thread` | `workflow`(脚本里 `agent()` 扇出) |
| `tool-ralph` | `ralph`(每轮开一个新子代理) |
| `tool-subagent-control` + `tool-subagent-list-agents` | `list_agents` / `send_message` / `interrupt_agent` |

实测前后对比(解出子代理会话的 `jsonl.zstd`,看**下发给模型的工具表**):

| | 工具数 | 分叉工具 |
| --- | --- | --- |
| 闸门前 | 25 | `subagent`, `subagent_fork`, `workflow`, `ralph`, `list_agents`, `send_message`, `interrupt_agent` |
| 闸门后 | 18 | 上面 7 个全部消失;`pwsh` / `read` / `write` / `edit` / `grep` / `web_search` / `todo_write` 等干活能力保留 |

自检(配置级 + 会话级两路证据):

```powershell
node $env:USERPROFILE\.dsh\subagent\test\leaf-only-probe.mjs <sessionId片段>
```

`install.mjs` 每次装 profile 时也会跑一遍配置级检查,没关上会直接报 ❌(实测踩过:patch 只改了
仓库里的副本、没同步到 `$DSH_HOME/profiles/`,`--dump-config` 里仍是启用 —— 所以必须问生效值)。

> 边界说明:这条闸门管的是**进程内**的分叉通道。任何有 shell 的 agent 都能自己起一个 `dsh` 进程,
> 那属于"本来就有终端权限"的范畴,不作为可执行边界承诺。想恢复分叉:删掉 `profile/cordis.patch.yml`
> 里的第 7 条,再 `node install.mjs --only profile`(无需重启,subagent profile 每次任务都是新进程)。

直接手工使用(不经过任何 harness):

```powershell
cd D:\some\repo
dsh --profile subagent --prompt "跑一遍单测并汇总失败项"
# 长提示词走管道,不受命令行长度限制:
type task.md | dsh --profile subagent --prompt-stdin
```

---

## 5. 权限与安全

| 关注点 | 现状 |
| --- | --- |
| 默认权限 | `danger-full-access`(与宿主 harness 本身的权限一致,且 DSH 自身会话也是这个档位) |
| 收紧方式 | 工具参数 `permission: "workspace-write"` / `"read-only"`,或环境变量 `DSH_SUBAGENT_PERMISSION` |
| 审批 | 子代理进程内一律 `never`:没有人类可点确认,越权由**沙箱直接拒绝**(而不是挂起等审批) |
| 并发 | 每个 MCP server 进程默认最多 4 个并行 DSH 实例;超出者排队。详见 §6.1 |
| 审计 | 每次委托落盘:`$DSH_HOME/subagent/state/tasks/<job-id>/{prompt.md,result.txt,meta.json,stderr.log,task.json}`;会话本身也按 DSH 常规落盘,可在 DSH GUI 对应工作空间下复查 |
| 遥测 | 沿用 DSH 自身设置;如需关闭,给调用方环境加 `DSH_TELEMETRY_DISABLED=1` |

**权限档位怎么"真的生效"**(这一块踩过两个坑,2026-09-11 修复,见 §8 第 1、2 条):

1. profile 里显式声明了一张"无人值守"预设表(三种沙箱模式 × `approval: never`)。DSH 自带的
   表把 `workspace-write` / `read-only` 配成 `approval: ask`,与无人值守的 `never` 组合不出任何
   表项,`dsh-permission-presets` 会在**构造期**抛
   `composed sandbox and approval defaults match no preset` —— 整棵插件树加载失败,子进程在
   agent 起来之前就以退出码 1 结束(2.4 秒,什么都没干)。
2. 光有表还不够:权限预设值还存在**全局** `$DSH_HOME/settings.yaml` 的
   `permission.defaultPreset`(就是 GUI 里选的档位),子进程读同一个文件,会盖掉 profile 的
   `config.defaultPreset`。所以 profile 自带的 runner 会在发提示词之前,用
   `permissionPresets.set()` 把调用方要求的档位**写进本次会话的事件流** —— 文件/命令工具是
   **每次按会话事件**解析沙箱策略的(`ctx.sandboxPolicy.resolve({session})`),这也是 GUI 里手动
   切档位走的同一条路径。锁定失败(要求收窄却锁不住)时 runner **直接失败退出**,绝不悄悄用
   更宽的权限跑。

**已知边界**(实测,不是推测):`workspace-write` / `read-only` 下,Windows 上的 `pwsh` 工具会
**完全不可用** —— 受限令牌 runner 起不来交互式 shell,工具返回**全空**(没有输出、没有
`[exit code: N]`、也没有 `[sandbox: …]` 标记),连把输出重定向到文件也不生效(文件不会出现)。
所以这类档位下,写文件要让子代理用 `write` / `edit` 文件工具(它们会返回结构化的
`[sandbox: file access denied under … mode]`),脚本类工作则用 `danger-full-access`。

---

### 5.1 ⚠️ 沙箱档下 shell 会"空转成功"(命令没跑,工具却报成功)

**现象**:权限档设成 `workspace-write` 或 `read-only` 时,DSH 的 shell 工具对**任何**命令都
返回空 —— 没有 stdout、没有 `[exit code: N]`、没有任何副作用,而且 `isError: false`。

同一条 `Write-Output SPAWN-PING`,只换权限档:

| 权限档 | shell 工具实际返回 |
| --- | --- |
| `danger-full-access` | `SPAWN-PING\r\nELAPSED_MS=59\r\n` ✅ 真的执行了 |
| `workspace-write` / `read-only` | `"\r\n"`,`isError: false` ✗ 进程从未启动 |

**排查用的对照实验**(这些排除了"只是输出丢失"这类解释):`exit 3` 不返回 `[exit code: 3]`;
`Start-Sleep -Seconds 5` 根本不睡;`Set-Content` / `cmd /c echo > file` 不生成文件;而同一会话里
的文件读写工具一切正常 ⇒ 故障点在**创建进程**那一层:沙箱把 spawn 吞掉了。

**不是版本问题**:升级前后的真实会话日志各取一份,`tool/result` 里都是同样的
`"\r\n"` + `isError: false`(见 §10 验收记录)。**也不是本插件配置问题**:`subagent` 与
`desktop` 两个 profile 的沙箱相关行集合一致(`sandbox-local` / `sandbox-policy` /
`pwsh-sandbox` / `fs-sandbox`,`pwsh-sandbox` 两边都没有额外配置)。

**桥接层会替你说出来**:任务收尾时桥接层解会话日志,把"空内容 + `isError:false`"的 shell
调用数出来,在答复末尾附一段告警(调用次数、命令样例、当前权限档、出路),并落进任务记录的
`shellHollowCalls` / `shellHollowSamples` —— 不会再把"完成但什么都没做"的结果悄悄交给调用方。

**怎么办**:要跑命令(构建 / 测试 / CLI 调用)就显式给 `permission: "danger-full-access"`;
只做文件读写的任务不受影响,照常派即可。**验证办法**:派一条 `dsh_task` 让它 `echo` 一个标记,
看答复末尾有没有那段告警(有 ⇒ 执行面是空的)。

---

## 6. 并发(多开)与在 GUI 里查看

### 6.1 能不能多开

能。同一时刻可以有多个 DSH 实例在跑,机制是:

| 维度 | 行为 |
| --- | --- |
| 一次 harness 回合里多次调用 | **可以并行**。MCP 层对每个请求异步处理(`lib/mcp.mjs` 的 `onFrame`),一个 `dsh_task` 没返回也不会挡住下一个;同一轮里连发 3 个 `dsh_task`,3 个 DSH 实例同时开跑 |
| 单个 MCP server 进程的并发上限 | **默认 4**(`DSH_SUBAGENT_MAX_CONCURRENCY`)。第 5 个不会报错,而是**排队**等名额,拿到名额才启动 |
| 跨 harness | 每个 harness(Cursor / Claude / Codex / …)各有一个独立的 MCP server 进程,各自 4 个名额;CLI(`dsh-subagent`)同样自带一份 |
| 怎么放大 | 在对应 harness 的 MCP 配置里给 `env` 加 `"DSH_SUBAGENT_MAX_CONCURRENCY": "8"`,或给 `dsh-subagent-mcp.cmd` 设环境变量;改完重启该 harness |
| 查当前状态 | `dsh_health` 会回报 `maxConcurrency`、`activeTasks`、**`activeByCaller`**(如 `cursor-vscode: 2 running`)、**`liveTasks`**(每个实时任务的 `job_id/caller/workspace/status/pid/deadlineAt/remainingSeconds/lastProgressAt/progressBytes/queuedSeconds`)和最近 5 个任务 |
| 代价 | 每个实例都是一次独立的模型调用(自己的上下文与 token),并且都打同一个网关;开到 8~16 以上时瓶颈通常变成 API 吞吐/限流,而不是本机 CPU |

实测(`node test/concurrency-probe.mjs <工作空间> 3`):3 路同时发起,总墙钟 9.2s,三个任务各自 ~8-9s 全部成功——是并行而非串行(串行应≈25s+)。

**推荐的用法**:不需要立刻要答案的任务,用 `wait_seconds: 0` 拿到 `job_id` 就放手,后面用
`dsh_task_status` 轮询(每 20~30s 一次)。

**停止**:
- `dsh_task_cancel` = **优雅取消**:对"正在跑"和"还在排队等名额"的任务都有效(排队中的直接标记
  `cancelled` 且不会再启动),由任务的退出路径收尾。
- `dsh_task_kill` = **强制终止**:`job_id` 杀一个;`caller` 一次停掉该调用方**本进程内**起的全部
  运行中任务("停掉我起的全部东西")。排队中的任务会被立即落终态,跑着的直接杀整个进程树。
  注意 `caller` 模式的作用域是**当前 MCP server 进程**——每个 harness 一个进程,跨进程请分别调用。

### 6.2 硬截止与停滞看门狗(防止无限挂住)

| 机制 | 触发条件 | 结果 |
| --- | --- | --- |
| 外层上限 | `timeout_seconds`(默认 1800) | `status: "timeout"` |
| 硬截止 | `startedAt + expected_seconds × grace`(grace 默认 2) | `status: "deadline"`,`error: 超出预估时间 Ns × grace G 仍未完成,已终止` |
| 停滞看门狗 | 每 `DSH_SUBAGENT_WATCHDOG_INTERVAL`(默认 **30s**)采一轮**多信号**快照(见下),**所有**信号零变化 + 静默已达 `DSH_SUBAGENT_STALL_MIN_SECONDS`(默认 **180s**)+ 窗口内连续 `DSH_SUBAGENT_STALL_PROBES`(默认 2)次零变化 | 杀进程树,`status: "stalled"`,并落 `signalState` / `treePids` / `treeCpuMs` / `cpuDeltaMs` / `silenceSeconds` 取证 |

#### 停滞判定的信号模型(任一信号推进即算"有进展")

只看日志字节数是**不够的**,而且会误杀正常任务。本机实测反例:一个任务在 6 分钟里
`stderr.log`(18474B)与 `session.jsonl.zstd`(191279B)字节数**一个字节都没变**,但它当时正在
跑一个 133 步的循环脚本——后代进程 `powershell.exe → bash.exe → bash.exe` 都活着,
根进程 CPU 从 8.42s 涨到 8.50s。长工具调用期间 DSH 不写任何输出是**设计使然**。

因此每轮探测采集下列信号,**任一推进即算有进展**:

| 类别 | 信号 | 说明 |
| --- | --- | --- |
| 日志 | `stderr.log` / `stdout.log` / `result.txt` / 会话日志 `session.jsonl.zstd` 的**字节数** | 只用字节数,**绝不使用 mtime** —— mtime 在部分环境里不可靠(安全软件的文件过滤会让它停在创建时刻,实测 18KB 的 stderr.log mtime 没变过),而字节数变化是可靠的 |
| 进程树 | ① 根进程是否存活 ② 后代进程 **pid 集合**变化 ③ 整棵树累计 CPU(`KernelModeTime + UserModeTime`)增长 ≥ `DSH_SUBAGENT_STALL_CPU_MS`(默认 **200ms**) | 每轮**只跑一次** `Get-CimInstance Win32_Process` 取全表,在内存里做父子遍历;绝不"每个 pid 起一次进程"。未达阈值的小增量会**累加**,累计越阈值同样算进展(慢活每轮只烧几十毫秒也认得出来) |
| 调用方 | 轮询时看到的新增 `progressBytes` | 调用方每次 `dsh_task_status` 都是一次真实观测 |

**快照取不到时按"未知"处理**:进程树类信号一律不参与判定,由日志信号 + 静默窗口兜底。
测不到 ≠ 没有进展,**绝不允许探测失败或测量缺口导致误杀**。同理,快照里查不到某个 pid 时,
CPU 相对增量被钉在 0 以下不取(避免出现负增量这种噪声)。

护栏与取舍:

- **排队中的任务不判停滞**(它连子进程都还没起来),改用 `status` 输出里的 `queuedSeconds` 观察。
- 第一个探测窗口没走完之前**绝不下手**;已经结束/被取消的任务不会被看门狗碰。
- 指纹只看**字节数增长**,纯时间戳变化不算进展——所以"安静但仍在输出"的长任务不会被误杀。
- **静默的长工具调用被当作进展**(只要进程树里还有后代进程、或树 CPU 在涨)。看门狗的判定是
  "整棵树完全静止",而不是"没有日志"。**要限制一个本来就很久的任务,请用 `expected_seconds`
  声明预估时间**(它形成硬截止),而不是指望看门狗替你掐掉正常的长任务。
- **两道门槛同时满足才杀**:① 静默时长 ≥ `DSH_SUBAGENT_STALL_MIN_SECONDS`(默认 180s);
  ② 静默窗口内**连续** `DSH_SUBAGENT_STALL_PROBES` 次探测所有信号零变化(中间只要有一次
  "有进展",计数立刻归零)。最小静默窗口是必需的:一次慢模型响应既不写日志也不产生后代进程。
- **第四道门槛:CPU 干活强度下限 `DSH_SUBAGENT_STALL_CPU_WORK_FLOOR_MS`(默认 1500ms)。**
  这条是本机实测逼出来的:一个六进程树(`powershell → bash → bash → node hang.mjs → node(600s sleep)`)
  整棵树都阻塞在等一个 600s 子进程、日志 **394 秒零增长**,树 CPU 仍然以约 **15~220ms / 每 10 秒**
  的速度在涨——那是 IO 完成端口/定时器/调度开销,不是产出。若"CPU 涨了就算有进展"一视同仁,
  这类真挂起会**永远攒不满静默窗口**,看门狗形同失效。所以静默窗口内树 CPU 的累计增长低于下限时
  不算"在干活";而真正在干活的任务(实测:122 秒烧 2750ms)远超下限,照样不会被误杀。
- **对照实验(把下限关掉的那次运行,可复现)**:同一棵树,`stderr` 从 **+24s 起冻在 1439 字节、
  连续约 590 秒零增长**(整轮 612 秒),但每次采样的 `cpuDeltaMs` 是 **0~188ms**(整轮累计 3391ms),
  于是"树 CPU 累计 +2xx ms"每隔 3 次采样就把 `progressed` 翻成 true、计数**反复归零**
  (`stalledProbes` 轨迹在 0,1,2,0,1,2,3,4,0,… 之间打转,一次都没到阈值),最终任务被判成
  **`status:"ok"`** —— 真挂起被漏判(探针因此退出码 1)。
  命令:`DSH_SUBAGENT_WATCHDOG_INTERVAL=10 DSH_SUBAGENT_STALL_PROBES=2 DSH_SUBAGENT_STALL_MIN_SECONDS=60
  DSH_SUBAGENT_STALL_CPU_MS=200`(且**不设** `..._CPU_WORK_FLOOR_MS`)跑同一个探针;
  加上下限(默认 1500)后同一条路径判 `stalled`(见 §10)。
- 要更快发现挂死:`DSH_SUBAGENT_WATCHDOG_INTERVAL=5` + `DSH_SUBAGENT_STALL_MIN_SECONDS=10`;
  `DSH_SUBAGENT_WATCHDOG=off` 可整体关掉看门狗。
- 仍存在的误杀风险:一个**整棵树真静止**超过窗口的任务(例如子代理卡在一个 CPU 睡眠、
  又没有后代进程的动作上)会被判 `stalled`。这正是需求要的行为,但请按上面的方式用
  `expected_seconds` 兜住正常的长任务。

### 6.3 会话在 DSH GUI(本窗口)里看得见吗

**看得见,但不是"实时看板"那种看得见。** 事实依据:

- 子代理的会话是**标准 DSH 会话**,落盘在 `$DSH_HOME/sessions/<工作空间key>/session-<uuid>/`,
  和 GUI 自己在同一工作空间下创建的会话**同一个目录、同一份列表**。例如工作空间
  `D:\work\demo` 对应的目录是 `$DSH_HOME\sessions\--D-work-demo--\`
  (Windows 路径会被转义成 `-` 开头的 key,中文字符再编码成 `~XXXX~` 形式)。
- 会话文件在**执行过程中就在增长**(实测:探针任务运行中该会话文件 25 秒内从 38KB 涨到 89KB),
  所以你在列表里点开就能看到已经发生的对话与工具调用。
- **但不会有"执行中"的跑马灯/徽标**:GUI 的 `running` 状态取自它自己进程内的 agent 注册表
  (`dsh-api-session-controller` 的 `summaryFor`: `running: this.ctx.agents.get(session.id)?.status === "running"`);
  子代理是**另一个进程**,GUI 不知道它活着,所以这类会话在列表里是普通(冷)会话。
- 列表按最近活动排序,新会话会在**重新进入该工作空间 / 刷新列表**后出现(外部进程写入不会给
  GUI 发通知)。

想**实时**看进度,直接盯任务现场(写入是即时的):

```powershell
# 推理流(实时增长)
Get-Content -Wait $env:USERPROFILE\.dsh\subagent\state\tasks\<job-id>\stderr.log
# 当前状态 / 工作空间 / 产物
Get-Content $env:USERPROFILE\.dsh\subagent\state\tasks\<job-id>\task.json
```

`job_id` 由 `dsh_task` / `dsh_task_status` / `dsh_health` 给出。任务结束后,`result.txt` 就是
最终答复,`meta.json` 里有 `sessionId`,拿它就能在 GUI 里精确打开那次会话。

> ⚠️ **只对"已经结束"的会话点开。** 在 GUI 里打开一个**仍在运行**的外部会话不是只读操作:
> 宿主会 resume 它、接管写权,并把合成的收尾事件写进子进程正在写的日志(实测已把 5 个会话
> 写坏,出现重复 seq)。详见 §6.6;悬浮卡片(§6.5)已经按这个结论做了防护。

### 6.4 GUI 实时监控(observer 插件,已装好)

上面 7.2 说的"没有跑马灯、要刷新才出现"已经解决:本机在 **GUI 宿主进程**里装了一个
观察器插件 `~/.dsh/subagent/monitor/observer.mjs`,它把外部 subagent 任务投射成 GUI
认得的远程事件,于是:

| 时机 | 你在 GUI 里看到 |
| --- | --- |
| 任务开始 ~2 秒内 | 该会话**自动出现在侧边栏**(归到它的工作空间那一组),**带"运行中"标记** |
| 运行中 | 会话被持续顶到列表最前;标题是 `⚡ <调用方> · <标题> ⚠运行中·勿点开`(最后一句是**刻意的护栏**,原因见 §6.6),并带上调用方/任务号/截止时间等投影(§6.5 的卡片就用这些) |
| 任务结束 | 运行中标记自动消失,会话留在列表里,**这时点开**内容完整可复查 |

> 观察器本身是安全的:标 `running` 与 `activity` 都只影响客户端列表(`running` 不会让宿主
> attach,`activity` 只重排列表),不读也不写会话文件。**危险的是"点开"**(§6.6)。

**原理**(都是宿主插件,不改前端、不改 DSH 源码):

1. 桥接层在任务一开始就把 `sessionId` 写进任务现场的 `meta.json`(runner 一建立会话就写,
   不等这一轮结束),`task.json` 里有 `pid` / `status` / `workspace`;
2. 观察器每 2 秒扫一遍 `$DSH_HOME/subagent/state/tasks/*/`,用 `pid` 存活性确认"真在跑"
   (避免留下永远"执行中"的僵尸会话),然后发三个官方声明转发的远程事件:
   `api-session/added`(入列)/ `api-session/status`(运行中徽标)/ `api-session/activity`(活动时间);
3. 客户端侧(`dsh-api-session-controller` 的 client 层)对这些事件的处理就是
   `mergeSummary` / `session.handleRunning(running)`,所以侧边栏立刻生效;
4. `api-session/added` 里带 `projections.values['dsh-subagent']`(调用方、任务号、工作区、
   状态、截止时间、进度字节、最近输出行…),客户端每次列表快照都会把它带给 UI;
   任务运行中每 **20 秒**(或进度字节变化、或 token 用量增长后 ≥5 秒)重播一次,这样**刷新页面后卡片也不会空**
   (客户端重建列表时投影会丢,重播把它灌回去);用量也走这个提前重播,所以底部状态条最多滞后约 5 秒,
   不必等满 20 秒的常规节奏。

**装了哪些文件**:

- `~/.dsh/subagent/monitor/observer.mjs` —— 插件本体(纯 `node:fs` + `ctx.emit`);
- `~/.dsh/profiles/desktop/cordis.patch.yml` —— 被 `>>> dsh-subagent-observer >>>` 标记包住的
  insert 条目(由 `install.mjs` 托管,删掉该块即关闭监控;`uninstall.mjs` 会自动摘掉它);
- 日志:`~/.dsh/subagent/state/observer.log`(每 2 秒一轮只记"有变化"的事;
  想看每轮心跳就设 `DSH_SUBAGENT_OBSERVER_DEBUG=1`)。

**生效条件**:`desktop` profile 声明的是 `patchReload: live`,但**打包版实测不会热应用
patch 文件**(宿主的 patch 监视在启动那一刻没建立起来,静默退化),所以**首次装好后要重启
一次 DSH Desktop**(设置面板里的「重启」按钮即可)。重启后永久生效 —— 之后任何 Cursor /
Claude Code / Codex 拉起的 `dsh_task`,都在这个窗口里实时可见。

**心跳(给桥接层用的信号)**:观察器每 ~5 秒写一次
`$DSH_HOME/subagent/state/observer-heartbeat.json`:

```json
{ "at": "2026-09-11T10:31:02.123Z", "epochMs": 1762331462123, "pid": 12345,
  "engine": "dsh-desktop-observer", "profile": "desktop", "pollMs": 2000,
  "trackedTasks": 3, "activeTasks": 1 }
```

**自动拉起监控窗口(桥接层 `lib/monitor-host.mjs`)**:任何 harness 调 `dsh_task` 时,桥接层
会顺手确认"有没有带监控的宿主在跑",没有就 best-effort 把 GUI 拉起来 —— 于是"用 Cursor /
Claude Code / Codex 派活"这件事本身就能激活监控窗口,**哪怕你压根没开 DSH UI**。

判活协议与决策顺序(`dsh_task` 里**非阻塞**完成,失败绝不影响任务)。**判活绝不只看心跳** ——
心跳文件只有在 DSH Desktop 重启后才会被写(观察器是宿主进程内的插件,内存里跑的是启动时加载的那份
代码),而且它会被自检写成"pid 早已死掉"的残留文件。只看心跳就会拉起第二个宿主,踩中 §6.6:

| 顺序 | 条件 | 动作 |
| --- | --- | --- |
| 1 | **心跳新鲜(`Date.now() - epochMs < 20000`)** **且心跳里的 pid 还活着** | `already-running`:**什么都不做** |
| 2 | 心跳存在但 **pid 已消失 / 时间过期** | 判为**残留文件**:既不当作"宿主在",也不当作"没宿主",**继续往下判** |
| 3 | 总开关 `DSH_SUBAGENT_AUTOSTART_MONITOR=off` | `skipped` |
| 4 | 非 Windows 平台 | `skipped` |
| 5 | 枚举 `DSH Desktop.exe` 并**按命令行分类**后有"真正的 GUI 宿主" | `gui-open-old-observer`:**绝不拉起第二个**(GUI 开着,只是它跑的是旧观察器、写不出心跳) |
| 6 | 进程表查不到(探测失败两次) | `probe-failed`:**未知 ≠ 没有宿主,不启动**,下次调用再试 |
| 7 | 距上次尝试 < `DSH_SUBAGENT_MONITOR_COOLDOWN_MS`(默认 60000) | `skipped`(冷却防抖) |
| 8 | 以上都不成立 | `launched`:`spawn(exe, args, {detached:true, stdio:'ignore', windowsHide:false}).unref()`,**不 await** GUI 起来 |
| — | 找不到可执行文件 | `unavailable` |
| — | 本进程还没做过判断 | `unknown`(只可能出现在 `dsh_task_status`:那个接口**只读**) |

第 5 步的**命令行分类**(与 `test/live-audit.mjs` 同一口径):

| 命令行含 | 判定 | 要不要阻止拉起 |
| --- | --- | --- |
| `--type=` | Chromium 渲染/GPU 子进程 | 不阻止(噪声) |
| `--expose-internals` | 以 CLI 方式跑的 dsh —— **我们自己的子代理任务** | 不阻止 |
| 两者都没有 | **真正的 GUI 宿主**(有窗口) | **阻止**(`gui-open-old-observer`) |

> 命令行是用 **base64** 从 PowerShell 传回来的:命令行里可能有换行(本机实测有多行
> `node -e "…"` 脚本),直接 `"$pid|$cmdline"` 会被换行切成多行、解析出 `pid=NaN` 的假条目。

- **为什么要"心跳 + pid"两道一起看**:踩过两次——① 观察器自检把心跳写进了真 `$DSH_HOME`,文件在、
  pid 早死了;② 当前宿主 17:44 启动,内存里是旧版观察器,**根本没有心跳文件**。只信心跳 = 每次都
  再开一个 GUI。想强制拉起:`DSH_SUBAGENT_MONITOR_FORCE=1`;想彻底关掉第 5 步的闸门(即回到
  只信心跳):`DSH_SUBAGENT_MONITOR_HOST_CHECK=off`(它同时也是自检用来验证"该拉起时真的会拉起"的开关)。
- exe 定位顺序:`DSH_SUBAGENT_MONITOR_CMD`(可自定义,支持带参数,另加 `DSH_SUBAGENT_MONITOR_ARGS` 追加)→
  `C:\Program Files\DSH Desktop\DSH Desktop.exe` → `%LOCALAPPDATA%\Programs\DSH Desktop\DSH Desktop.exe`。
- **日志**:`$DSH_HOME/subagent/state/monitor-host.log`(每次"拉起/跳过"都写一行,含原因、
  心跳时间与 pid 是否存活、命中的 exe / GUI 宿主 pid、探测失败原因)。
- **在哪儿能看到**:`dsh_health` 的 `monitorHost`(`running` / `state`(与活跃审计同口径的三态:
  `host-with-heartbeat` / `host-older-observer` / `no-host`)/ `guiOpen` / `guiHostPids` /
  `cliProcessPids` / `heartbeatAt` / `heartbeatAgeMs` / `heartbeatPidAlive` / `heartbeatResidue` /
  `processProbeFailed` / `autostart` / `lastLaunch`),以及每次 `dsh_task` / `dsh_task_status`
  结果里的 `monitor_host: <action>(<reason>)` 一行。`dsh_task_status` **只读**、绝不触发拉起
  (不能"看一眼状态就冒出个 GUI")。
- 成本:第 5 步要跑一次 `Get-CimInstance Win32_Process`(约 1.3~1.8 秒,只在"没有可信心跳"这条路上
  才会走),结果按冷却窗口缓存;**心跳新鲜时完全不跑任何子进程**。

自检(用假 exe + 临时 `DSH_HOME`,**不会真的启动 GUI**):

```powershell
node $env:USERPROFILE\.dsh\subagent\test\monitor-autostart-probe.mjs   # 26 项:三步判活逐条 + 命令行分类
```

**可调**:`DSH_SUBAGENT_OBSERVER_INTERVAL`(轮询毫秒,默认 2000)、
`DSH_SUBAGENT_OBSERVER_ANNOUNCE_AGE_MS`(只推送"正在跑或刚结束"的窗口,默认 10 分钟,
更早的历史任务不重播,免得把你在 GUI 里删掉的会话又拽回来)、
`DSH_SUBAGENT_OBSERVER_REANNOUNCE_MS`(运行中会话的重播间隔,默认 20000)、
`DSH_SUBAGENT_OBSERVER_MAX_AGE_MS`(任务现场的最大回溯窗口,默认 12 小时)、
`DSH_SUBAGENT_OBSERVER_DEBUG=1`(每轮都写日志)。

**已知边界**:GUI 显示的是"会话 + 运行状态"。远程事件里没有逐字增量,所以**不打开会话时
不会实时滚字**;而且**运行中的外部会话不应该打开**(§6.6)。要看实时的推理流,用悬浮卡片
的实时详情页(§6.5,它读任务现场的 `stderr.log`),或者 `Get-Content -Wait …\stderr.log`。

自检:

```powershell
node $env:USERPROFILE\.dsh\subagent\test\observer-selftest.mjs   # 34 项,含投影、僵尸/半成品判活、心跳+口径版本、token 折叠、吞吐窗口
node $env:USERPROFILE\.dsh\subagent\test\live-audit.mjs          # 现场审计:真的在跑几个 / 幽灵几个 / 宿主状态
```

### 6.5 悬浮卡片 Subagent(独立的实时视图,已装好)

侧边栏里外部任务和普通会话混在一起,不适合当"看板"。所以另装了一个**独立的客户端插件**
`dsh-subagent-panel`,在窗口右上角渲染一张**悬浮卡片**,和其他会话在观感上分开:

| 能力 | 说明 |
| --- | --- |
| 按调用方分组 | **Cursor / Claude Code / Codex / 命令行 / 自检 / 未知来源**各成一组,组标是该调用方的字形(⌖ ✳ ⬢ >_ ◎ ◈) |
| **本机 DSH 子代理也在里面** | DSH **自己**的 `subagent`(同进程子代理,`subagentsByParent` 目录)自成一格「本机 DSH 子代理 ✦」,与外部 `dsh_task` 任务并列:层级徽标 `L1 ⊞`(⊞ = 它自己也叫了子代理)、运行/结束状态、所属父会话、多久前有动作;点开与宿主自己的子代理入口完全一致 |
| 手机式展开 | 点组标题像点手机上的应用文件夹一样展开成磁贴网格;有活跃任务的组默认就是展开的 |
| 默认只看活跃 | 卡片头部默认只显示**正在跑**的会话(外部 `dsh_task` + 本机子代理);点「全部」才连最近结束的一起显示 |
| 看得清 | 自带配色(不依赖宿主 token):浅色/深色都按 AA 以上对比度取值,跟随宿主的 `body[data-ds-dark-theme]` 切换 |
| 可缩放(字号) | 头部 `−` / `120%` / `+`,范围 **60%~200%**,按钮步进 10%,点百分比复位 100%,选择记在 `localStorage` |
| **自由改尺寸(像真窗口)** | 三个把手:右边 = 只改**宽**、下边 = 只改**高**、右下角 = 宽高一起改(位移除以 `zoom`,放大到 150% 时不会一格跑两格);尺寸单独记在 `localStorage`,双击任意把手复位默认;宽高**不是等比例**——拉宽只加列,不动字号 |
| **拉宽就多放几列** | 网格是 `repeat(auto-fill, minmax(132px, 1fr))`,列数跟着卡片**实际宽度**走:默认 300px 是 2 列,拉到 700px 就是 4~5 列(实测列数按 132px 最小宽自动排);拉高后内容区滚动、头部与底部状态条固定 |
| **底部状态条** | `250 tok/s \| 缓存命中 99% \| 输入 111M tok · 输出 636K tok`:当前显示的会话**合计**用量,`tok/s` 是**在跑**会话的吞吐之和(待机显示 `—`);鼠标悬停看 prompt 侧总量、缓存读,以及"这个速率是观察器按真实采样时间窗算的" |
| 空态 | 无活跃子代理时居中显示雷达图 + 一行「无活跃子代理」 |
| 一眼看出区别 | HUD 四角、扫描线、脉动的运行指示灯、运行中磁贴的流光与进度条、等宽字体的倒计时;磁贴第二行还带 `↑输入 ↓输出` 与 `N tok/s` |
| 运行中 → 实时详情 | 点运行中的磁贴进**只读详情页**:调用方 / 任务号 / 工作区 / 已耗时 / 预计剩余 / 输出字节与"上次增长多久前" / 验收条件 / **tokens 明细(输入·输出·缓存命中,以及这份数字的来源)** / **子代理最近几行推理输出**(来自任务现场的 `stderr.log`);过期或久未增长的整行会标红标橙 |
| 已结束 → 普通打开 | 点已结束的磁贴 = `ctx.sessions.open(id)`,和点侧边栏里的会话**完全一样** |
| 可拖可收 | 头部可拖动(位置记在 `localStorage`),「收起」后缩成一条状态条 |

> **头部为什么允许换行**:卡片默认 300px,而头部有标题、活跃计数、`全部`、`− 120% +`、`收起`
> 六个控件 —— 挤不下时**换行**(`flex-wrap: wrap`),而不是把 `Subagent` 裁成 `SUBAGENT…`。
> 踩过两次:只写 `flex: none` 而卡片宽度固定时,标题只是从"省略号"变成了"被卡片裁掉",都没修好;
> 真正的修法是**让它换行**,再把卡片做成可拉宽(拉宽后一行放得下)。

#### 7.5.1 底部状态条的 token 数字是从哪来的

和宿主自己的对话统计**同口径**,但两条数据源:

| 会话类型 | 数据源 | 为什么 |
| --- | --- | --- |
| 本机子代理 / 宿主自己的会话 | 宿主的 `projectionValues.tokenUsage` 投影 | token-meter 是按会话投影的,这就是宿主 UI 里那份数 |
| **外部 `dsh_task` 任务** | **观察器**自己折叠子代理的会话日志 | 那些会话宿主**从没加载过** ⇒ 标准投影不存在,只能自己算 |

观察器的折叠口径抄宿主 token-meter:同一 `(turn, step)` 的 usage 样本**替换**而不是累加
(实测一条日志里 `assistant/chunk(chunk.type=usage)` 与 `assistant/message(data.usage)` **各 36 次** ——
不替换就会翻倍),`llm/retry-started` 会关掉替换槽。缓存命中率 = `缓存读 / prompt 侧总量`,
部分命中**绝不显示成 100%**(四舍五入撞到 100 就退一位小数,还是 100 就写 99.9)。

> ⚠️ **必须逐帧解 zstd**。踩过:`zstdDecompressSync(整个文件)` **只解第一帧就返回,而且不报错** ——
> 699K / 1282 帧的真实日志整块解只出 151 个字符。用它算用量会得到一份"看着正常、其实几乎没有"
> 的假数字。逐帧解同一份是 1.5M 字符 / 33ms,所以折叠结果按 `(size, mtime)` 缓存 + 每会话 5 秒节流。

#### 7.5.2 吞吐(tok/s)的窗口口径:为什么客户端不再自己算

第一版把 `tok/s` 放在**客户端**算:每次重绘采一次 `Δ输出/Δt`。用户实测反馈是
**"每秒几千 token,显然是错的"** —— 这个数是错的,而且是算法错的,不是数据错的:

- 外部任务的用量是**成块**到达的:观察器折叠节流 5 秒,投影重播最快也要 20 秒(现在改成用量涨了
  就按 `ACTIVITY_MS` 提前推);
- 客户端每秒采样一次,于是"2 秒里输出跳了 6000 token"被算成 **3000 tok/s**;
- 同一份数据按真实跨度算:50207 输出 token 摊在任务时长上是 **~250 tok/s** 一档
  (和 DSH 自己界面上那个样例数字同量级)。

现在**只在观察器里算**(`rateOf`):`Δ输出 / Δ真实采样时间`,跨度 **< 3 秒不算**,
再取最近 **4 次**采样的平均(≈20~40 秒窗口);客户端只负责显示,自己**一个采样窗口都不留**。
自检把用户那个场景钉住了:`2 秒里跳 6000 token` 必须**不给速率**(而不是给 3000 tok/s),
`跨 29 秒的 6000 token` 才给 ~207 tok/s。

**实测**(`node test/observer-selftest.mjs`):日志在长 → 投影里真的带出 `tokensPerSecond`,
且落在"几百 tok/s"一档(`< 2000` 断言);只有**在跑**的会话才显示速率,跑完就回到 `—`。

**实测**(`node test/usage-fold-probe.mjs --all`,真实任务日志):

```
1282 帧 / 1727 行 / 699.4K   输入 92103 · 输出 50207 · 缓存读 1949440 · 36 次调用 → 命中率 95.5%
1053 帧 / 1465 行 / 594.6K   输入 75871 · 输出 44498 · 缓存读 2522880 · 38 次调用 → 命中率 97.1%
```

**生效条件**:状态条里的**宿主侧数字**(本机子代理)刷新页面就能看到;外部任务的 token 数与
吞吐(`tokensPerSecond`)需要**观察器重新加载**。实测:`file:` 插件在这个桌面宿主里
**不会热重载** —— 改完 `monitor/observer.mjs` 必须**重启一次 DSH Desktop**(判定办法见下)。

> 怎么当场判断宿主里跑的是哪一版观察器:看 `$DSH_HOME/subagent/state/observer-heartbeat.json`。
> 新版心跳带 `usageRate: { minSpanMs, samples, foldThrottleMs }` 字段;
> 实测宿主在 20:00 启动、代码 20:06 改完,心跳一直更新却**始终没有这个字段**
> ⇒ 跑的是旧代码 ⇒ 必须重启。自检里也钉了这条断言。

**客户端侧(卡片本身)改完只要刷新页面**。实测 bundle 的响应头是
`cache-control: public, max-age=31536000, immutable`,而 URL 带的是**内容哈希**
(`.../client.js&rev=c06568fbaf88308f-47`,组合 URL 上是 `rev=da77570553a2`)——
内容一变 URL 就变,浏览器自然会重新取。但宿主启动**之后**再改客户端代码时,
URL 里的 rev 可能还是旧的 ⇒ 浏览器**不会回源**,这时按一次 **Ctrl+F5** 强刷即可。


**为什么自带配色**(踩过的坑):宿主 token 有两处不适合做这张卡片 —— 浅色主题下
`--dsw-alias-border-inverted` 是 `#0000`(全透明,卡片干脆没有边框),而
`--dsw-alias-state-warn-primary` 在**深浅两套主题里都是** amber-500 `#f59e0b`
(白底对比度实测 **2.15:1**,「橙色告警几乎看不见」就是这么来的)。所以卡片改用自己的色板,
数值都是实测计算的 WCAG 对比度:

| | 浅色(白底) | 深色(卡片 `#14171d`) |
| --- | --- | --- |
| 正文 / 次要 / 第三 | 18.5 / 9.7 / 6.4 : 1 | 16.6 / 11.9 / 8.2 : 1 |
| 强调 / 成功 | 6.6 / 7.6 : 1 | 8.9 / 10.4 : 1 |
| **告警**(还是橙的) | **7.0 : 1** | **11.7 : 1** |
| 错误 | 7.8 : 1 | 9.0 : 1 |

告警也不再只靠颜色:提示条带底色 + 左边条,详情页里超时/久未增长的整行会整行染色
(`data-tone="err"/"warn"`)。

> ⚠️ **附带的一处全局副作用**(不想要可以删):同一个 `state-warn-primary` 也是宿主自己
> 所有"橙色告警文字/圆点"用色,所以卡片在**浅色主题**下顺手把这个 token 压深成 `#8a4700`
> (`body:not([data-ds-dark-theme]) { --dsw-alias-state-warn-primary: #8a4700 }`),
> 让整个 GUI 的橙色告警文字都达到 7.0:1。它只改 `-primary`(文字与圆点),
> 卡片边框用的 `-secondary`、条底色用的 `-tertiary` 都没动;深色主题完全不受影响。
> 删掉 `gui/lib/client.js` 里那一条规则即可恢复原样。

**缩放为什么用 `zoom` 而不是 `transform: scale()`**:`transform` 只改视觉、不改布局,放大后会留下一个
透明的空盒子挡住下面的点击;`zoom` 让整块布局一起缩放,`−`/`+` 之外不会多出任何可点区域。
缩放只作用于卡片内容(外层 `.sap-zoom`),所以拖动坐标、点击命中都不受缩放影响。

**标题为什么不会被截断**:头部一排控件挤在一起时,`flex` 收缩会让 `SUBAGENT` 变成 `SUBAGENT…`。
现在标题 `flex: none`(永不收缩、`white-space: nowrap`)并且**头部允许换行**(`flex-wrap: wrap`)——
挤不下时控件换行,而不是把标题裁掉。踩过两次:第一次只加 `flex: none`,而卡片宽度是写死的 300px,
标题**仍然显示不全**(从"省略号"变成"被卡片裁掉");第二次才定位到根因是头部根本放不下,
于是既让它换行、又把卡片做成可拉宽(拉宽后这一行自然放得下)。

**改尺寸为什么不是 `zoom`**:字号缩放(`−`/`+`,60%~200%)和窗口尺寸是两件事,分开记。
窗口尺寸直接写 CSS 变量(`width: var(--sap-w, 300px)` / `height: var(--sap-h, auto)`),
拖动位移除以当前 `zoom` 换成 CSS 像素;网格用 `auto-fill` 跟着宽度重新排列 ——
这才是"拉宽时每行多几个卡片",等比例缩放做不到这件事。

**原理**:卡片不在侧边栏里塞东西,而是注册进 `shell.overlay` —— ui-layout 声明的**帧级悬浮层**
(可叠加、默认点击穿透、子元素自动接管指针事件)。数据不额外开后门:观察器把每个任务的
元数据写进会话的**投影值** `projectionValues['dsh-subagent']`,客户端列表快照本来就带投影,
卡片读它即可(所以卡片和侧边栏永远一致,不需要第二条通道)。

**装了哪些文件**:

- `~/.dsh/subagent/gui/package.json` + `gui/lib/index.js`(宿主半边,空实现)+
  `gui/lib/client.js`(预构建的浏览器 bundle,`window.__ModuleLoader__.load` 形态);
- `~/.dsh/profiles/desktop/cordis.patch.yml` 里被 `>>> dsh-subagent-panel >>>` 包住的 insert 条目
  (`file://` 指向 `gui/lib/index.js`;Loader 会走到最近的 `package.json` 读出 `dsh.client`,再把
  `exports["./client"]` 作为浏览器 bundle 投送)。

**生效条件**:新增 Loader 条目这一侧,浏览器要**刷新一次页面**才会拿到重组的启动图
(`__DSH_BOOT__` 是页面加载时注入的);打包版的 patch 热应用不生效,所以**首次仍需重启一次
DSH Desktop**。两者都做过之后,以后任何调用方拉起的任务都会自动出现在卡片里。

**自检**:

```powershell
# 卡片逻辑(离线:假 window/__ModuleLoader__ + 迷你 React,真跑组件函数)
node $env:USERPROFILE\.dsh\subagent\test\panel-selftest.mjs            # 117 项

# 真实任务日志 → token 用量折叠(逐帧解 zstd;只读)
node $env:USERPROFILE\.dsh\subagent\test\usage-fold-probe.mjs --all

# 启动图(起一个一次性 web 实例,确认插件真的进了 __DSH_BOOT__ 且 bundle 能取到)
dsh --patch $env:USERPROFILE\.dsh\subagent\gui\test-overlay.yml --profile web --no-open --port 34199
node $env:USERPROFILE\.dsh\subagent\test\gui-graph-probe.mjs "http://127.0.0.1:34199/?token=<上面打印的 token>"
```

### 6.6 ⚠️ 为什么"运行中的外部会话"不能直接打开

这是本机实测出来的**破坏性**行为,不是猜测。

宿主把"打开会话"实现成了"**恢复该会话并取得它的写权**":客户端只在当前选中会话上开流
(`sessions.follow`),而 `follow` 对非 live 会话**必然** `promote()` → `agents.resume()` →
`persistence.prepare()`。当这个会话是外部进程(桥接拉起的 DSH 子代理)正在写的文件时:

1. `prepareCore` 会为"尾部未闭合的 turn"合成收尾事件(带
   `interrupted-tool-result-*`、`turn/end{reason:"interrupted"}`),`commitRepair` 用
   **truncate + append** 把它们**落盘**;
2. 发布时又会追加 `session/end-seed`,并把"未发布后缀"写进同一个文件;
3. 子进程完全不知道,继续用**同一个 seq 段** append ⇒ 日志里出现**重复 seq / seq 回跳**,
   活着的 turn 中间插进假的 `turn/end{interrupted}`。

取证:本机 106 个会话日志里 **5 个**带这种注入指纹(全部是外部 harness 拉起的会话),
其中 `session-5e4c139b…` 的 seq 5185–5188 各出现两次。这些日志随后对任何读者都是语义损坏。

顺带解释另外两个现象:

- **"打开了也一直不动"**:`follow` 的尾随循环只消费**本进程**的 `session/event`
  (`dsh-api-session-controller`),没有任何"按字节 tail 文件"的通道 —— 子进程后续写的内容
  永远不会进入宿主的 live 会话,所以转录在打开那一刻就冻结了。这是设计使然。
- **"一观测就卡"**:读路径对**持续变化的文件**是"等稳定 + 无限重试"设计,每轮都要整文件
  `readFile` + 全量 zstd 解码 + 重建会话 + 折叠投影(解码每 500ms 才让出一次事件循环),
  而宿主进程同时提供 Web 服务 ⇒ 点击瞬间的卡顿。
- **反向澄清**:"GUI 把子任务卡死"在代码上不成立(没有锁、没有独占句柄、没有 owner 标记);
  日志静默期基本都是子代理在等自己的长工具调用(官方也注释了 *continuous external writers
  may delay completion*)。

**所以本仓库的处理**:

| 场景 | 行为 |
| --- | --- |
| 任务**已结束** | 悬浮卡片点击 = 普通打开,**完全一致**(此时没有并发写者,resume 是正常路径) |
| 任务**运行中** | 默认**不打开**,进只读详情页;详情页里的「打开会话」是禁用状态,旁边留了一个需要**二次确认**的「仍要打开」(标红,写明有损) |
| 想实时看内容 | 走详情页的实时输出行(读 `stderr.log` 尾部),**不碰**会话日志 |
| 想彻底消除风险 | 在宿主侧把 `follow` 的 promote 改成"冷会话只读跟随"(需要改 DSH 核心:`SessionHistoryController.follow` + jsonl 后端的按偏移读取) —— 属于上游改动,本仓库不做 |

---

### 6.7 本机 `subagent` 与外部 `dsh_task` 是两扇门(为什么两个都要)

经常会被问:"DSH 自己就有 subagent,为什么还搞一个 `dsh_task`?" —— 因为调用方在**两个不同的世界**里:

| | 本机 `subagent` 工具 | 外部 `dsh_task`(MCP) |
| --- | --- | --- |
| 谁能调 | **只有 DSH 内部的模型**(工具表里的一个工具) | **任何 MCP 客户端**:Cursor / Claude Code / Codex / 其它 harness |
| 子代理在哪 | **同一个宿主进程内**(`dsh-subagent-spawn-in-process` 驱动的子会话) | **独立进程** `dsh --profile subagent`(独立权限档、独立日志、崩了不牵连宿主) |
| 递归上限 | `tool-subagent.maxDepth`,默认 **3 层** | 无(由调用方自己决定要不要再派) |
| 控制通道 | `list_agents` / `send_message` / `interrupt_agent`(DSH 原生) | `dsh_task_status` / `dsh_health` / `dsh_task_kill` |
| 在卡片里 | 「本机 DSH 子代理 ✦」组(L1/L2/L3 + ⊞) | 按调用方分组的那些格 |

关键点:**进程外的东西不可能调用 DSH 进程内的工具** —— Cursor 的进程里没有 DSH 的工具表,
它唯一能用的门就是 MCP。所以 `dsh_task` 不是"另起炉灶",而是**给外部调用方开的那扇门**;
DSH 自己内部派活时用的仍然是它自己的 `subagent`(这也是为什么你在 GUI 里能看到
"我的子代理又有子代理"的嵌套)。

**两扇门都要能看见**。过去卡片只认 `dsh_task`,于是"我自己的子代理还在跑"这件事落在视野外;
现在卡片把宿主的子代理目录(`subagentsByParent`)也读进来,按 `activity` 标运行中、
按父会话关系算出 `L1/L2/L3`、`⊞` 表示"它自己也叫了子代理",点开就进那个会话。
另外卡片对"报告还有下一层"的子代理会**主动拉一次目录**(`ctx.sessions.refreshSubagents`),
所以递归链不用你先点开宿主的子代理面板才会显形。

> 注意:本机子代理是**同进程**的,宿主自己的入口就是直接打开,所以卡片对它们**不做**§6.6 的
> 「运行中勿点开」限制 —— 那条限制只针对进程外的 `dsh_task` 会话。

### 6.8 台账里的"幽灵记录":状态一律按 pid 判活

`state/tasks` 是**跨桥接进程共享**的目录,而"写终态"这件事只有**起它的那个桥接进程**会做。
桥接进程被杀 / 退出时,它正在跑的任务**永远不会有人去改 `status`** —— 于是台账里留下
`status:"running"` 但 pid 早已消失的**幽灵记录**。实测踩到:108 条记录里 7 条号称在跑,
其中 4 条是探针留下的幽灵。

以前的坑:`taskState()` 只在**单个任务查询**时用 pid 兜底,而 `listTasks()` 直接返回 task.json 的
原始 status —— `CLI --list` 和 `dsh_task_kill {caller}` 都吃它,于是:

- `--list` 把幽灵报成"在跑";
- `dsh_task_kill {caller}` 以为自己杀了 N 个,其实里面混着幽灵,而调用方看到"已强杀"以为都清了。

现在**三条路径统一口径**(`taskState` / `listTasks` / `killByCaller`),判定顺序:

1. 本进程内还有句柄 → 一定在跑;
2. `meta.json` 已写明 `stopReason` → 按它推导成终态(`ok`/`error`),不算幽灵;
3. 否则看 pid 存活:活着 → `running`;死了或**根本没记 pid** → `lost`。

并且 `listTasks()` 的每条记录都会带上:

| 字段 | 含义 |
| --- | --- |
| `status` | **已判活之后**的状态(幽灵是 `lost`,不再是 `running`) |
| `stale` | `true` = 记录说在跑但进程已不在(幽灵);`false` = 可信 |
| `pidAlive` | `true` 活着 / `false` 已消失 / `null` 不适用(终态记录) |
| `derived` | 状态是从 `meta.json`/pid 推导出来的,不是 task.json 里原有的 |

`dsh_task_kill {caller}` 只杀 `pidAlive === true` 的,并把幽灵放进返回值的 `stale` 数组,
同时输出一行 `另清理了 N 条**幽灵记录**…`,避免调用方以为自己还挂着一堆任务。

**强杀必须"验证过才报成功"**(本轮修的一个真问题):不属于本进程的任务只能按 pid 杀,
而旧实现用 `spawn('taskkill', …)` **发完就不管、也不看结果** —— 强杀失败(权限不足 / pid 已变 /
taskkill 起不来)照样回报 `killed: true`,调用方以为卡死的任务停了,进程树还在后台烧 CPU。
现在这条路改走 `execFileSync`(`killTreeSync`):taskkill **只在确实终止了进程时才返回 0**,
所以"报成功"本身是被验证过的;验证不了就如实回报
`killed: false, note: "强杀失败:taskkill 未确认终止(退出码 128);进程可能仍在运行,记录保持 running"`。
本进程自己拉起的任务仍走原来的 `killTree`(它们的终态由运行器自己落盘,不需要在这里验证)。

自检(临时 `DSH_HOME` 造假台账,不碰真 `%USERPROFILE%\.dsh`):

```powershell
node $env:USERPROFILE\.dsh\subagent\test\ledger-liveness-probe.mjs   # 20 项:幽灵/在跑/meta 推导/真的杀掉/强杀失败如实回报
```

> 判活那条断言**必须轮询**:taskkill 是"请求终止"、进程退出是异步的,固定等 1.2 秒在机器忙时会假红
> (实测同一条断言 3 次里红 1 次,而被杀的进程其实已经没了)。现在是 200→2000ms 递进轮询。

---

## 7. 环境变量一览

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `DSH_SUBAGENT_WAIT_SECONDS` | `30` | `dsh_task` 的默认阻塞窗口(原来 120) |
| `DSH_SUBAGENT_DEADLINE_GRACE` | `2` | 硬截止宽限系数:`deadlineAt = startedAt + expected_seconds × grace` |
| `DSH_SUBAGENT_TIMEOUT_SECONDS`(或别名 `DSH_SUBAGENT_TASK_TIMEOUT`) | `1800` | 外层绝对墙钟上限(比硬截止更宽松) |
| `DSH_SUBAGENT_WATCHDOG_INTERVAL` | `30` | 停滞探测间隔(秒);每轮采一次多信号快照 |
| `DSH_SUBAGENT_STALL_PROBES` | `2` | 静默窗口内**连续**多少次"所有信号零变化"才判停滞 |
| `DSH_SUBAGENT_STALL_MIN_SECONDS` | `180` | 判定停滞前的最小静默秒数(防"慢模型响应"被误杀) |
| `DSH_SUBAGENT_STALL_CPU_MS` | `200` | 树累计 CPU 增长多少毫秒才算"有进展"(小增量会累加) |
| `DSH_SUBAGENT_STALL_CPU_WORK_FLOOR_MS` | `1500` | 窗口内树 CPU 累计增长低于此值时**不算"在干活"**:把 IO/定时器空转噪声与真正的工作区分开(见 §6.2) |
| `DSH_SUBAGENT_WATCHDOG` | 未设置 | 设为 `off` 可整体关闭停滞看门狗 |
| `DSH_SUBAGENT_TREE_PROBE_TIMEOUT_MS` | `15000` | 单次进程快照的 `Get-CimInstance` 超时 |
| `DSH_SUBAGENT_PS` | 系统 PowerShell | 覆盖进程快照所用的 powershell.exe 路径 |
| `DSH_SUBAGENT_MAX_CONCURRENCY` | `4` | 单个 MCP server 进程的并发上限 |
| `DSH_SUBAGENT_AUTOSTART_MONITOR` | 未设置(开) | 设为 `off`/`0`/`false` 关闭"调 `dsh_task` 时自动拉起监控窗口"(见 §6.4) |
| `DSH_SUBAGENT_MONITOR_COOLDOWN_MS` | `60000` | 两次自动拉起之间的最小间隔,防抖(也用作进程表探测的缓存窗口) |
| `DSH_SUBAGENT_MONITOR_HEARTBEAT_MS` | `20000` | 心跳多旧算"没有宿主在跑" |
| `DSH_SUBAGENT_MONITOR_HOST_CHECK` | 未设置(开) | 设为 `off` 关掉"已有 GUI 宿主进程就跳过"的闸门(**测试逃生门**) |
| `DSH_SUBAGENT_MONITOR_HOST_PROCESS` | `DSH Desktop.exe` | 枚举/分类时要看的进程映像名 |
| `DSH_SUBAGENT_MONITOR_FORCE` | 未设置 | 设 `1` 强制忽略宿主闸门(手动逃生门) |
| `DSH_SUBAGENT_MONITOR_CMD` | 未设置 | 覆盖要拉起的可执行文件(可带参数;测试用假 exe 就靠它) |
| `DSH_SUBAGENT_MONITOR_ARGS` | 未设置 | 追加参数(JSON 数组,或按空格拆分的字符串) |
| `DSH_SUBAGENT_HOST_PROBE_TIMEOUT_MS` | `15000` | 宿主进程枚举(`Get-CimInstance`)单次超时;失败会自动重试一次(实测单次 1.3~1.8 秒) |
| `DSH_SUBAGENT_PERMISSION` | `danger-full-access` | 子代理默认权限档 |
| `DSH_SUBAGENT_RESULT_CLIP` | `60000` | 回传给 harness 的答复字数上限 |
| `DSH_SUBAGENT_ACTIVITY_CLIP` | `1800` | 活动流(`recent_activity`)回传上限 |
| `DSH_SUBAGENT_OBSERVER_USAGE_REFRESH_MS` | `5000` | 同一会话的日志最多多久重新折叠一次(折叠一次 ~33ms) |
| `DSH_SUBAGENT_OBSERVER_ACTIVITY_MS` | `5000` | 进度字节/用量变化触发提前重播的最小间隔 |
| `DSH_SUBAGENT_OBSERVER_RATE_MIN_MS` | `3000` | 算吞吐(`tok/s`)的最小采样跨度;**低于它的窗口不算**(见 §6.5.2) |
| `DSH_SUBAGENT_OBSERVER_RATE_SAMPLES` | `4` | 吞吐取最近几次采样的平均(≈20~40 秒窗口) |

CLI 另有两个参数:`--expected-seconds <n>`(默认取外层上限的一半)、`--acceptance <text>`、
`--caller <name>`(默认 `cli`)。

---

## 8. 常见问题

**Q:传了 `permission: "workspace-write"`,任务 2 秒就失败(退出码 1),堆栈里是
`permission: composed sandbox and approval defaults match no preset`?**
已经修好了(2026-09-11),原因与修法见 §5 第 1 条。要点:DSH 自带预设表把
`workspace-write`/`read-only` 配成 `approval: ask`,而无人值守的子代理固定 `never`,
组合不出表项 → 预设服务在**构造期**抛错 → 插件树加载失败 → agent 还没起就退出。
现在 profile 显式声明了"三种模式 × never"的表,三个档位都能跑。
(注意:修复前 `read-only` 同样是坏的,只是没人试过。)

**Q:`--permission workspace-write` 能跑,但子代理照样写到了工作区外面?**
也是已修的坑(§5 第 2 条):权限预设值存在**全局** `$DSH_HOME/settings.yaml`(GUI 里选的
档位),会盖掉 profile 的 `config.defaultPreset`;而工具层是**按会话事件**解析沙箱策略的。
现在 runner 会在发提示词前把档位写进本次会话事件,并用
`node test/session-perm-probe.mjs <sessionId>` 可以验证会话里到底落的是哪一档。

**Q:harness 里看不到 dsh 工具?**
重启该 harness(Cursor/Claude Code/Codex 只在启动时读 MCP 配置)。Claude Code 可用
`claude mcp list` 自检,应出现 `dsh: … √ Connected`;Codex 用 `codex mcp list`。

**Q:`dsh_task` 返回 `status: running`,然后呢?**
在同一轮里继续调用 `dsh_task_status(job_id, wait_seconds=25)`,大约每 20~30s 一次,直到
`ok`/`error`/`deadline`/`stalled`/`cancelled`/`killed`。状态里会带 `recent_activity`(子代理此刻
在干什么)与 `progress_bytes`;任务的 `prompt.md`、`stderr.log` 也实时落盘,想看原始进度直接看文件。

**Q:Cursor / Claude Code 里这个 MCP server 显示一个 warning?**

harness 会把 MCP **子进程的 stderr 一律渲染成 warning/error**,所以哪怕我们只打一行
"启动成功"的信息,你在 Cursor 里也会看到告警。实测 Cursor 的 `mcpprocess.log`:

```
[warning] [McpProcess stderr]   ERR dsh-subagent: MCP stdio server ready (bridge v…)
```

因此现在的约定是:**正常路径下 stderr 一个字都不写**,stderr 只留给"真的出问题"
(例如进程树探测不可用的降级告警)。要排查就把 `DSH_SUBAGENT_DEBUG` 设成 `1`,
启动横幅与调试行会重新出现。自检里钉了这条(`正常启动不往 stderr 写任何东西`),
以后不会退化。

**Q:结果为空?**
看 `meta.json` 的 `stopReason` 与 `error`,以及 `stderr.log` 末尾。`DSH 进程退出码 N`
一般是模型/凭据问题。

**Q:子代理说"命令执行了"但没有任何输出/副作用?**

先看任务答复末尾有没有 `⚠️ 执行面告警`。有 ⇒ 是沙箱档把 shell 吞了(见 §5.1),让调用方改用
`permission: "danger-full-access"` 再派一次。没有那段告警但确实没输出 ⇒ 才是命令本身或模型的问题。

**Q:子代理回答"文件是二进制/乱码"?**
先确认那个文件是谁写的、能不能被别的进程按原文读到(node/npm 现场生成的中间文件在某些
安全软件环境下可能被改写),再怀疑模型。别把这类现象当成模型幻觉。

**Q:任务太长被掐断?**
先看是哪种掐断:`status: deadline` 说明 `expected_seconds` 估小了(或宽限系数太小),
估准了重派、或把任务拆小;`status: timeout` 才是外层 `timeout_seconds`(默认 1800)到了;
`status: stalled` 是看门狗判定"连续无产出",见 §6.2。宿主 harness 自己的 MCP 工具超时
(Claude Code 的 `MCP_TOOL_TIMEOUT` 等)也要相应放大。

**Q:怎么换模型?**
按次:`dsh_task(model: "deepseek-v4-pro")` 或 `dsh-subagent -m deepseek-v4-pro`;
全局:改 DSH 设置里的默认模型(设置 → 模型),子代理默认跟随。

**Q:外部任务能不能自己再派子代理?**
不能(叶子闸门,§4.1)。由其它 harness 经 `dsh_task` 调进来的 DSH 实例,工具表里没有
`subagent` / `subagent_fork` / `workflow` / `ralph` / 子代理控制通道;DSH **自己**内部派活走的原生
`subagent` 不受影响(默认 3 层)。想恢复:删 `profile/cordis.patch.yml` 第 7 条并重跑
`node install.mjs --only profile`。

**Q:我的子代理还没跑完,但这一轮已经答完了,它们去哪了?**
DSH 父会话回答完**不会**杀掉子代理(杀了等于丢工作),它们会继续跑完并写回结果。所以看的地方是
悬浮卡片(§6.5):「本机 DSH 子代理 ✦」那一组按 `L1/L2/L3` 列出宿主自己的子代理树,
`⊞` 表示"它自己也叫了子代理",运行中的会亮着 —— 不用再靠"翻侧边栏找会话"。

---

## 9. 目录速查

```
~/.dsh/subagent/
├── README.md                 本文档
├── install.mjs               幂等装配器(--dry-run / --only=…)
├── uninstall.mjs             摘除所有 harness 里的 dsh 注册
├── profile/                  DSH profile 源文件(install 会同步到 $DSH_HOME/profiles/subagent)
├── lib/
│   ├── launcher.mjs          定位并解析本机 dsh 启动器(直接 spawn exe,绕开 cmd 转义)
│   ├── tasks.mjs             任务生命周期:启动 / 等待 / 查询 / 取消 / 强杀 / 硬截止 / 停滞看门狗 / 并发闸门
│   ├── mcp.mjs               MCP stdio server 与五个工具的实现在此(工具定义里的委派手册也在这)
│   ├── monitor-host.mjs      监控窗口自动拉起(三步判活:心跳+pid 存活 / 残留不采信 / 命令行分类拦第二个 GUI)
│   └── util.mjs              路径、JSON、裁剪、进程存活等小工具
├── bin/
│   ├── dsh-subagent.mjs      CLI:任何 harness 都能 shell 调用
│   └── dsh-subagent-mcp.mjs  MCP server 入口
├── test/
│   ├── selftest.mjs          协议级端到端自检(54 项)
│   ├── monitor-autostart-probe.mjs 监控窗口自动拉起自检(27 项,假 exe + 临时 DSH_HOME)
│   ├── ledger-liveness-probe.mjs   台账幽灵记录自检(21 项,临时 DSH_HOME 造假台账)
│   ├── e2e-harness.mjs       验收脚本:让每个 harness 自己委托一次并核对产物
│   ├── concurrency-probe.mjs 并发(N 路同时委托)+ 取消验证
│   ├── tasks-probe.mjs       只验任务层的小烟测
│   ├── session-perm-probe.mjs 解开某个会话日志,打印它**实际生效**的权限事实
│   ├── panel-selftest.mjs    悬浮卡片逻辑自检(离线 117 项)
│   ├── observer-selftest.mjs GUI 观察器自检(35 项,含心跳+口径版本、幽灵收尾、pid 宽限期、token 折叠、吞吐窗口、0.1.5 新日志名)
│   ├── exec-surface-probe.mjs 执行面探针(11 项:会话日志改名兼容 + 沙箱"空转成功"的判定与零误报)
│   ├── live-audit.mjs        活跃审计:真在跑/幽灵/没记 pid/宿主状态/最近任务耗时(--fix 订正幽灵)
│   ├── monitor-live-probe.mjs 真心跳 + 真 dsh_task:验 already-running 分支,并确认不重复拉起 GUI
│   ├── usage-fold-probe.mjs  真实任务日志 → token 用量折叠(逐帧解 zstd,验底部状态条的数据源)
│   ├── leaf-only-probe.mjs   叶子闸门探针(14 项:配置级 7 条闸门 + 会话日志里的真实工具表)
│   ├── gui-graph-probe.mjs   客户端插件启动图探针(真起一个 web 实例)
│   ├── live-probe.mjs        两采样进度探针(判断任务是否真的在动)
│   └── dump-session.mjs      解压查看某个 DSH 会话事件时间线
└── state/
    ├── tasks/<job-id>/       每次委托的完整现场
    └── selftest-report.json  最近一次自检报告
```

---

## 10. 验收记录(本机实测)

一键复跑: `node test/e2e-harness.mjs <工作空间>`(会依次驱动 Claude Code / Codex /
Cursor 各委托一次,并核对 DSH 是否真的按内容要求写出了文件)。

已完成的实测(工作空间 `D:\dsh-subagent-selftest`):

| 链路 | 调用方式 | 结果 |
| --- | --- | --- |
| Claude Code → `mcp__dsh__dsh_task` | `claude -p … --allowedTools mcp__dsh…` | ✅ 6.1s,产物 `e2e-claude-*.txt` |
| Claude Code 子代理 → DSH | `Task(subagent_type: "dsh")` | ✅ 产物 `subagent-claude-*.txt` |
| Codex → `mcp__dsh__dsh_task` | `codex exec …` | ✅ 12.5s,产物 `e2e-codex-*.txt` |
| Cursor → `mcp__dsh__dsh_task` | `cursor-agent -p --force --approve-mcps` | ✅ 6.0s,产物 `e2e-cursor-*.txt` |
| 命令行 | `dsh-subagent -w <dir> "…"` / `--json` | ✅ 5.5s,stdout 就是 DSH 答复 |
| 直接调用 DSH profile | `dsh --profile subagent --prompt-stdin` | ✅ 1.2s,退出码 0 |
| 协议级自检 | `node test/selftest.mjs` | ✅ 54/54(含 caller / `expected_seconds` 必填且 `isError:true` / 强杀 / 幽灵 `stale` 回报 / `initialize.instructions` / 工具定义文案 / `monitor_host` 接线 / **stderr 必须安静** / 版本号与 package.json 一致 / `DSH_SUBAGENT_DEBUG` 才出横幅) |
| 并发 | `node test/concurrency-probe.mjs <ws> 3` | ✅ 3 路并行 14.6s 全成功;取消 ✅ |
| 硬截止 | `expected_seconds=10`,任务是静默 300s | ✅ `status: "deadline"`,`error: 超出预估时间 10s × grace 1.5 仍未完成,已终止`,pid 已消失 |
| 停滞看门狗(真挂起) | 进程树**完全静止**(根进程阻塞在 `waitpid`):外部单独杀掉 sleep 子进程 → 字节不涨、后代不变、树 CPU 不涨 | ✅ 判 `status: "stalled"`,落 `treePids` / `treeCpuMs` / `signalState` 取证 |
| 停滞看门狗(真挂起·六进程树) | `powershell → bash → bash → node hang.mjs → node(600s sleep)`,日志 4823B **冻结 122 秒**、树 CPU 每轮仍有 15~220ms 空转噪声 | ✅ 判 `status: "stalled"`(`silentProbes: 2`、`silenceSeconds: 73`、`treeCpuMs: 1078`),靠"窗口内 CPU 强度下限"把空转噪声与真干活区分开 |
| 停滞看门狗(对照:关掉 CPU 强度下限) | 同一棵树,`stderr` 自 +24s 起冻在 1439B **连续约 590 秒零增长**(整轮 612s),`cpuDeltaMs` 每轮 0~188ms | ❌ **漏判** —— `progressed` 每 3 轮被"树 CPU 累计 +2xx ms"翻成 true、`stalledProbes` 在 0~4 之间反复归零(一次都没到阈值),最终 `status:"ok"`(退出码 1)。这就是加上下限的原因;详见 §6.2 |
| 停滞看门狗(反例不误杀) | 长时间不出字但**在真干活**(连续 30 次 `Start-Sleep 2`,后代进程活着、树 CPU 持续增长),间隔 10s / 2 次 | ✅ 未被杀,`stalledProbes` 反复归零,最终 `status: ok`,CPU 信号是保住它的原因 |
| 监控窗口自动拉起 | `node test/monitor-autostart-probe.mjs` | ✅ 27/27:心跳新鲜**且 pid 存活**→`already-running` 不 spawn;心跳新鲜**但 pid 已死**(残留)→不判已有宿主、继续判并拉起;心跳缺失→`launched` 且标记文件出现;总开关 off→`skipped`;**"GUI 宿主进程在但跑旧观察器"→`gui-open-old-observer` 不 spawn**;真实 `--expose-internals` 进程→分类 `dsh-cli` 不算宿主;`FORCE=1`→`launched`;分类规则 4 条纯函数单测 |
| 监控窗口自动拉起(全链路) | 真 MCP server + 真 `dsh_task`(假 exe + `HOST_CHECK=off`) | ✅ 结果里 `monitor_host: launched(心跳缺失/过期)`、标记文件出现、`monitor-host.log` 记 `reason=dsh_task <job_id>`、任务本身 `status: ok` |
| 监控窗口自动拉起(本机真实环境) | 真 `DSH_HOME` + 默认开关 | ✅ 心跳文件不存在(宿主加载的还是旧版观察器),命令行分类得到 `guiHosts=[45148]`(单个真 GUI 宿主,Chromium 子进程被忽略),`state=host-older-observer` → `gui-open-old-observer`,**没有**拉起第二个 GUI |
| 台账幽灵记录 | `node test/ledger-liveness-probe.mjs` | ✅ 21/21:幽灵(pid 已死 / 没记 pid)→`status:lost` + `stale:true`;真在跑的 → `running` + `pidAlive:true`;meta 已写明结束 → 推导成 `ok` 且不算幽灵;`killByCaller` 只杀真的活着那个(实测进程确实消失)、幽灵进 `stale` 数组、再杀一次 `notFound:true` 但仍回报幽灵;**`killTreeSync` 对已死/无效 pid 如实报失败**(不谎报"已强杀") |
| 卡片底部 token 状态条 | `node test/panel-selftest.mjs`(117 项) | ✅ 紧凑口径 `517/12.2K/517K/1.2M`;**部分命中绝不显示 100%**(99.7% 不四舍五入成 100);两条数据源都能算(宿主 `tokenUsage` 投影 + 观察器 `meta.usage`);**吞吐只认观察器给的 `tokensPerSecond`**(客户端不再自己采样,没有该字段就报 `—`);跑完的会话不显示速率;合计只累计"在跑且真有速率"的会话;底部按 `tok/s \| 缓存命中 % \| 输入 N tok · 输出 M tok` 渲染 |
| token 折叠(真实日志) | `node test/usage-fold-probe.mjs --all` | ✅ 真实多帧 zstd 日志(1282 帧 / 1727 行):`chunk.type=usage` 与 `data.usage` 各 36 次 ⇒ 同轮替换必须生效(不替换就翻倍);折出 输入 92103 · 输出 50207 · 缓存读 1949440 · 命中率 95.5% |
| **吞吐口径(用户报的"每秒几千 token")** | `node test/observer-selftest.mjs`(34 项) | ✅ `2 秒里跳 6000 token` **不给速率**(旧算法会算成 3000 tok/s);`跨 29 秒的 6000 token` → ~207 tok/s;输出没长不给速率;最近 4 次采样取平均;真实日志在长 → 投影带出 `tokensPerSecond` 且 `< 2000`;心跳带 `usageRate` 口径版本(用来分辨宿主里跑的是哪一版观察器) |
| **自由改尺寸 / 拉宽多列 / 标题完整 / 空态居中** | `node test/panel-selftest.mjs` | ✅ 三个把手 `data-axis=x,y,xy`(右=宽、下=高、右下角=宽高);`cursor: ew-resize/ns-resize`;卡片 `width: var(--sap-w, 300px)` + `height: var(--sap-h, auto)`;网格 `repeat(auto-fill, minmax(132px, 1fr))`(拉宽自动多列);`.sap-root[data-sized="true"] .sap-body { max-height: none }`(拉高后内容滚动、头尾固定);头部 `flex-wrap: wrap` + 标题 `flex: none`;空态 `justify-content: center` 且文案就是「无活跃子代理」 |
| 启动图与 bundle 缓存 | `node test/gui-graph-probe.mjs <临时实例 URL>` | ✅ 10/10(插件进了 `__DSH_BOOT__`、组合 URL 200、bundle 37.4MB 含新代码:`sap-grip` / `auto-fill` / `flex-wrap` / `自由缩放` / `无活跃子代理` 全为 true,旧文案 `雷达静默` 与旧算法 `throughputOf` 均为 false);响应头实测 `cache-control: public, max-age=31536000, immutable` |
| 台账幽灵记录(本机真实数据) | `dsh-subagent --list` | ✅ 134 条记录:`--list` 每条都带 `stale`/`pidAlive`/`derived`,不再有"号称在跑"的幽灵(对方已用 `live-audit --fix` 把 5 条纠正为 `lost`) |
| 强制终止 | `dsh_task_kill {caller}` | ✅ 一次杀掉该 caller 的 2 个运行中任务;已结束的重杀报"无需终止" |
| 注册可见性 | `claude mcp list` / `codex mcp list` | ✅ `dsh` 均显示 Connected / enabled |
| GUI 可见性 | 会话落在一个按工作区路径编码出来的目录里(如 §6.3 那种 `--D-work-demo--`) | ✅ 执行中文件持续增长(38KB→89KB/25s);GUI 列表可见,但无「执行中」徽标 |
| **DSH 升级到 0.1.5-rc.1 后回归** | 全套 7 个探针 | ⚠️ 升级当场打坏:`selftest` **43/51**、`leaf-only-probe` 14/15、`monitor-live-probe` 7/8(详见「DSH 版本兼容性」) |
| 同上,修复后 | 全套 8 个探针 | ✅ **287/287**:panel 117、selftest 54、observer 35、autostart 27、ledger 21、leaf 14、exec-surface 11、monitor-live 8 |
| 沙箱档下 shell 空转(§5.1) | 三种权限档各派一条真任务 + 读真实会话日志的 `tool/result` | ✅ 复现:`danger-full-access` 返回 `SPAWN-PING\r\nELAPSED_MS=59\r\n`;`workspace-write` / `read-only` 返回 `"\r\n"` 且 `isError:false`(命令从未启动)。升级前后各取一份日志,行为一致 ⇒ 与 DSH 版本无关 |
| 空转检测的准确率 | 真实会话日志跑 `detectHollowShellCalls` | ✅ 沙箱那次数出 **11** 次空转调用(带命令原文),`danger-full-access` 那次 **0** 次 ⇒ 零误报 |
| 会话日志改名兼容 | `node test/exec-surface-probe.mjs` + `observer-selftest` | ✅ 按 `session*.jsonl.zstd` 找、取最大;新旧同名时选中新格式;观察器能从 `session.v3.jsonl.zstd` 折出用量(改名前这条会失败) |
| 新版真跑一轮(MCP 桥接层) | `node test/monitor-live-probe.mjs` 内的真 `dsh_task` | ✅ `status=ok` 4.9s,产物落盘,观察器记到 `running=true job=20260911-124736-5c6cbc3c` |
| 新版直接调 profile | `dsh --profile subagent --prompt "…"` | ✅ `stopReason: completed`,答复「好的」,1.2s |
| 新版 row id 兼容审计 | 对 `app.asar` 逐个查 12 个被 patch 的行 id | ✅ 12/12 仍存在;新发现 `tool-subagent-report` 不再是 loader 行(变成协议消息 kind),探针已同步 |
| 新版客户端接入点审计 | 临时 web 实例上取组合 bundle(11.2MB) | ✅ 6/6 仍在:`shell.overlay` / `subagentsByParent` / `projectionValues` / `sessions.open` / `useSessions` / `__ModuleLoader__`;启动图 10/10,卡片 rev `36bac599d008e66e-45` |
| 上游 lsp 缺陷影响面 | `desktop` profile `--dump-config` + 宿主日志 | ✅ 桌面宿主**不受影响**(没有 `lsp-stdio`/`tool-lsp` 这两行,日志无 `assertNever`);只有 `web` 这类 profile 起不来,已给出两行 overlay 的绕开办法 |
| MCP 连接不再产生 warning | 手工握手 + 读 Cursor `mcpprocess.log` | ✅ server 正常启动 **stderr 0 字节**;原先 `[warning] [McpProcess stderr] ERR dsh-subagent: MCP stdio server ready …` 不再出现;`DSH_SUBAGENT_DEBUG=1` 时横幅与正确版本号(来自 `package.json`)才出现 |

