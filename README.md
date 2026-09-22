# deepseek-harnessed

将整个 **DeepSeek Harness (DSH)** 运行实例包装为可供 **Cursor / Claude Code / Codex / Gemini CLI / Antigravity / Kiro / Qoder / VS Code (Copilot) / opencode** 等调用方工具调用的子代理（**subagent**），并为 DSH Desktop 宿主界面提供**实时状态监控悬浮卡片**。

> 架构设计说明：使各类外部 Agent 工具能够将子任务分派给**独立的本地 DSH 实例**执行，而非仅在自身进程内运行轻量级函数调用。

系统由以下三部分组成：

| 模块 | 目录位置 | 技术说明 |
| --- | --- | --- |
| **MCP 桥接层** | `bin/` + `lib/` | 标准 Stdio MCP 服务器，对外暴露 `dsh_task` 等六个工具；每次分派拉起独立的 DSH 进程 |
| **DSH `subagent` profile** | `profile/` | 配置 DSH 进程以单次会话、无人值守、只做叶子节点模式运行 |
| **GUI 宿主插件** | `monitor/` + `gui/` | 观察器把外部任务的实时状态灌进会话投影；悬浮卡片按调用方分组显示 |

## 快速导航文档

| 文档路径 | 涵盖内容 |
| --- | --- |
| **[docs/install.md](docs/install.md)** | 前置依赖、一键安装、五分钟验证、卸载、常见故障排查 |
| **[docs/configuration.md](docs/configuration.md)** | 全部环境变量定义（`全部` 配置逐条来自源码）、profile 逐行说明、权限与叶子限制条件、卡片偏好设置 |
| **[docs/clients.md](docs/clients.md)** | 各客户端接入配置路径与 JSON 结构、手动接入方法、内置子代理路由规则 |

下文为系统架构设计、机制解析与实测记录（§1~§10）。

---

## 支持矩阵

| 客户端工具 | 自动注册路径与键名 | 一键安装支持 |
| --- | --- | --- |
| Cursor（IDE + `cursor-agent` CLI） | `~/.cursor/mcp.json` → `mcpServers.dsh` | ✅ |
| Claude Code | `~/.claude.json` → `mcpServers.dsh` | ✅ |
| Claude Desktop | `%APPDATA%\Claude\claude_desktop_config.json` | ✅ |
| Codex CLI / Desktop | `~/.codex/config.toml` → `[mcp_servers.dsh]` | ✅ |
| Gemini CLI | `~/.gemini/settings.json` | ✅ |
| Antigravity | `~/.gemini/antigravity/mcp_config.json` | ✅ |
| Kiro | `~/.kiro/settings/mcp.json` | ✅ |
| Qoder | `~/.qoder/mcp.json` | ✅ |
| VS Code / Copilot | `%APPDATA%\Code\User\mcp.json` → `servers.dsh` | ✅ |
| opencode | `~/.config/opencode/opencode.json` → `mcp.dsh` | ✅ |
| Claude Code / Codex / Cursor 的**内置 subagent** | 写入全局指令使子代理任务转调 DSH | ✅ |

---

## DSH 版本兼容性

桥接层运行于 DSH 内部环境（包含一个 Profile 与两个宿主插件），上游接口变动将直接影响插件行为。以下为实测适配数据（基于从 `app.asar` 提取的实际运行源码验证，避免 `app.asar.unpacked/` 中陈旧文件干扰）：

| DSH 版本 | 兼容状态 | 说明 |
| --- | --- | --- |
| **0.1.5-rc.1** | ✅ 已完成全量适配与验证 | 处理了 3 处破坏性接口变更（见下表） |
| 0.1.4 及更早版本 | ✅ 保持兼容 | 三处接口变更均包含向前兼容逻辑（见下） |

### 0.1.5-rc.1 的三处破坏性变化与处理方案

| 变更项 | 影响表现 | 适配方案 |
| --- | --- | --- |
| `@deepseek-ai/dsh-llm` 不再导出 `assertNever`（移至 `dsh-util-values`） | Profile 在插件树加载阶段抛出 `SyntaxError`，`dsh_task` 在 1.5 秒内失败且未生成结果文件、答复为空 | 移除该引用，在 runner 内实现 `warnUnknownChunk()` 对未知事件块记录告警并忽略，避免异常中断流程 |
| `permissionPresets.current()` 参数由事件数组变更为 **Session 对象** | 传入数组导致底层报 `Cannot read properties of undefined (reading 'header')` 且栈内全为内部调用帧 | 新增 `currentPreset()` 函数：优先按 Session 对象调用，失败时回退至事件数组模式，均失败才抛出原始异常 |
| `session.events` 属性重命名为 **`session.log`** | 直接读取事件流返回 `undefined` | 新增 `eventsOf(session)` 兼容函数支持两种属性名 |

异常处理函数 `fail()` 现输出完整错误调用栈（此前仅输出 `error.message`），以便快速定位类似 `presets.current()` 参数签名变更的内部异常。

### 上游版本已知问题与规避措施

0.1.5-rc.1 发行版中附带的 `lsp-stdio` 与 `tool-lsp` 插件未同步更新 `assertNever` 引用路径，加载时抛出 `does not provide an export named 'assertNever'` 异常。由于插件树采用全量加载机制：

- `dsh --profile web` 启动失败。
- **桌面宿主不受影响**：`desktop` profile 默认未包含上述两项插件（经 `--dump-config` 确认日志中无 `assertNever` 报错）。
- 若需运行 `web` profile，可在配置中禁用对应插件：

  ```yaml
  - id: lsp-stdio
    disabled: true
  - id: tool-lsp
    disabled: true
  ```

  使用 `--patch` 传入包含上述两行 overlay 的配置即可正常启动。

### 升级后快速自检步骤

```bash
dsh --version                                  # 先看版本
node test/selftest.mjs                         # 协议级端到端:真拉 MCP + 真跑一轮(最能说明问题)
node test/launcher-heal-probe.mjs              # dsh 入口脚本指向的入口文件还在不在(Desktop 换打包形态时第一个红)
node test/leaf-only-probe.mjs                  # row id 有没有被改名/删掉
node test/monitor-live-probe.mjs               # 观察器 + 宿主判活
```

版本升级需重点验证两类项目：**配置行 ID（row id）**（共有 15 处 Patch 配置，变更会导致规则失配）与**服务方法签名**。测试脚本 `test/leaf-only-probe.mjs` 覆盖前者检查（已适配 0.1.5 起 `tool-subagent-report`（`subagent-report`）由加载行变更为协议内部消息 kind 的调整）。

---

## 安全与运行边界

- **网络边界**：桥接层自身不发起外部网络连接，仅负责启动本地 `dsh` 子进程，并读写 `$DSH_HOME` 与本地工具配置文件。
- **默认权限**：默认执行权限为 `danger-full-access`（允许无审批读写操作，与外部调用方工具权限一致）。如需收紧权限，可在调用时传入 `permission: "workspace-write"` 或 `"read-only"`，或通过环境变量 `DSH_SUBAGENT_PERMISSION` 修改默认级别。
- **运行数据保护**：`state/` 目录存放私有运行时数据，已在 `.gitignore` 中排除。日志、心跳与任务记录文件（`task.json` / `meta.json` / `stderr.log`）包含本地绝对路径、工作空间名、提示词与任务输出。仓库内不包含任何真实任务现场数据。
- **配置写入安全**：安装脚本在修改配置文件前均生成备份副本（`.bak-dshsubagent-<时间戳>` 或 `<原文件>.bak-dshsubagent-<时间戳>`），遇到无法解析的 JSON 文件自动跳过，不覆盖现有数据。
- **运行平台**：当前仅针对 **Windows** 环境开发与验证，依赖 `taskkill` 与 PowerShell 进程管理机制。

---

## 系统工作原理

本机各 Agent 工具通过 MCP 协议将任务委派给独立的 DeepSeek Harness 实例，并在指定工作空间内获取执行结果。

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

与内置子代理的主要区别：任务作为**独立的 DSH 系统进程**运行，拥有独立的上下文窗口、模型配置、工具链以及持久化会话记录，而非宿主工具内的函数调用。

---

## 1. 一分钟自检

```powershell
# 桥接是否可用(等价于 harness 里的 dsh_health 工具)
dsh-subagent --where

# 真跑一轮:在指定工作空间里让 DSH 干一件可验证的事
dsh-subagent -w D:\some\repo "列出后端路由文件,汇总最近改动"

# 协议级自检(会真的拉起 MCP server 并跑一轮任务)
node $env:USERPROFILE\.dsh\subagent\test\selftest.mjs

# 等待规则:默认短超时自己等、只有 running 才轮询(会真的派两个任务)
node $env:USERPROFILE\.dsh\subagent\test\wait-policy-probe.mjs

# 监控窗口自动拉起(假 exe + 临时 DSH_HOME,**不会真的启动 GUI**)
node $env:USERPROFILE\.dsh\subagent\test\monitor-autostart-probe.mjs

# 台账残留记录(记录说在跑、pid 早没了)→ 必须按 pid 判活
node $env:USERPROFILE\.dsh\subagent\test\ledger-liveness-probe.mjs

# 叶子检查:外部任务不能再生子代理(配置级 + 解出会话日志看真实工具表)
node $env:USERPROFILE\.dsh\subagent\test\leaf-only-probe.mjs <sessionId片段>

# 卡片底部状态条的数字:真实任务日志 → token 用量(逐帧解 zstd,只读)
node $env:USERPROFILE\.dsh\subagent\test\usage-fold-probe.mjs --all
```

---

## 2. 对外暴露的六个 MCP 工具

MCP 服务器名称统一为 **`dsh`**，在各客户端中工具名称形如 `mcp__dsh__dsh_task`（Claude Code）或 `dsh.dsh_task`（Codex / Cursor）。

| 工具名称 | 功能描述 |
| --- | --- |
| `dsh_task` | 委托一项自包含任务。必须指定 `expected_seconds` 预估耗时；默认执行 45 秒短超时等待：窗口内完成直接带回结果（不需要轮询），超时未完成返回 `status: running` 与 `job_id`（见 §2.3） |
| `dsh_task_status` | 查询任务状态或继续等待；返回 `expected_seconds`、`deadlineAt`、`remainingSeconds`、`process_tree`（实时后代进程数与整树 CPU 耗时）与 `recent_activity`（子代理此刻在干什么，包括 `activity` 事件）；`ok` 时一并返回 DSH 的最终答复全文 |
| `dsh_task_cancel` | 优雅取消任务：发送终止标记并通知子代理进程安全收尾退出 |
| `dsh_task_kill` | 强制终止进程树：支持按 `job_id` 或按 `caller` 批量终止该调用方的全部任务；针对外部进程调用 `taskkill` 并校验退出码（失败时如实报告 `killed:false` 而非报告 `killed: true`）；返回实际终止与已结束的任务清单 |
| `dsh_health` | 健康探活：返回解析到的 dsh 启动器、`DSH_HOME`、默认工作空间、默认模型、每个调用方的并发数（`activeByCaller`）、每个实时任务的截止与进度（`liveTasks`）、最近任务列表，以及已接入模型列表（`models`：按 provider 分组，含 `defaultModel` 与枚举失败时的 `error`）和模型策略配置（`modelPolicy.path` / `fileUrl` / `defaultModel` / `presets`） |
| `dsh_setup` | 首次接入配置：将用户选定的默认模型写入策略文件（`config/model-policy.md`），只改写 `默认模型:` 声明行，保留文件其余内容与用户自定义修改。支持三种参数：`default_model`（必须为本实例已接入模型，裸 id 或 `provider/id`）、`preset`（如 `本项目方案`）或 `policy_markdown`（替换正文）。输入无效时直接报错（`isError:true`）并列出可用模型清单 |

### `dsh_task` 参数详细定义

| 参数名称 | 类型与约束 | 详细说明 |
| --- | --- | --- |
| `prompt`（必填） | 字符串 | 必须自包含完整任务上下文：DSH 独立进程无法读取外部调用方工具的对话历史或已打开文件，且执行过程中不会提问 |
| `expected_seconds`（必填） | 正整数 | 调用方预估的任务执行秒数。缺失或非正数值将被直接拒绝，以 `isError: true` 形式返回错误结果。该参数同时决定截止时间：`deadlineAt = startedAt + expected_seconds × DSH_SUBAGENT_DEADLINE_GRACE`（默认宽限系数为 2），超时将终止进程树并记录 `status: "deadline"` |
| `acceptance` | 可选字符串 | 单句验收标准描述文本（如“做完 = …”），记录至 `task.json` 并在结果中回显；超过 2000 字符将以 `isError: true` 拒绝 |
| `workspace` | 可选字符串 | 目标工作空间的绝对路径；缺省时依次尝试外部调用方工作空间（MCP roots）与服务器当前工作目录（server cwd） |
| `wait_seconds` | 可选数值（默认 45） | 本次调用最多阻塞等待的秒数（默认 45 秒短超时，推荐直接省略）；传入 `0` 表示立即返回 `job_id`（不推荐，会拆解为多轮轮询，且不要传 `wait_seconds: 0`）。建议不要传递大于 60 的数值，多数 Agent 客户端单次工具超时阈值为 60 秒（见 §2.3） |
| `timeout_seconds` | 可选数值（默认 1800） | 外层绝对超时时间（秒），作为第二重兜底保护，与 `expected_seconds` 截止机制同时生效 |
| `model` / `provider` | 可选字符串 | 单次任务指定模型与服务商。模型清单动态从 `dsh_health` 中的 `models.providers`（权威来源源自 `$DSH_HOME/settings.yaml` 的 `models` 数组，包含 `file:` / `file:///` / `file:///…` 路径规则）获取，规则配置见 `config/model-policy.md`。可调用 `dsh_setup(preset: "本项目方案")` 切换预设。省略 `model` 沿用默认模型；指定未接入模型时直接报错（返回 `UNKNOWN_MODEL` 或 `NO_ADAPTER`），不进行静默回退 |
| `reasoning_effort` | 可选字符串 | 单次任务指定推理强度档位（必须为该模型在 `settings.yaml` 的 `models[].reasoningEfforts` 中声明的档位，常见包括 `off`/`minimal`/`low`/`medium`/`high`/`xhigh`/`max`）。传入未声明的档位时直接报错（返回 `UNSUPPORTED_REASONING_EFFORT` 快速失败，耗时约 0.5 秒且不调用模型）。结果头部回显 `model:` 与 `reasoning_effort:` 实际生效值 |
| `permission` | 可选字符串（默认 `danger-full-access`） | 权限模式：`read-only`、`workspace-write`、`danger-full-access` |
| `raw_prompt` | 可选布尔值 | 为 `true` 时不附加默认的「委托说明」前缀，直接传递原始提示词 |

调用方标识识别：每个 MCP 连接在 `initialize` 请求中携带的 `clientInfo.name` 会记录至该连接创建的每个任务元数据中（`task.json` 的 `caller` 与 `callerVersion`，并在工具结果的 `caller:` 行显示）。未提供时默认为 `"unknown"`，命令行直接调用记录为 `"cli"`。GUI 监控面板与 `dsh_health` 均基于此标识进行分组。

等待执行策略说明：`dsh_task` 默认等待 45 秒。若任务在此期间完成，结果直接在当前调用中返回，无需额外轮询；若超过 45 秒未完成，返回 `status: running` 与 `job_id`，此时外部 Agent 应在同一会话中调用 `dsh_task_status(job_id, wait_seconds=30)` 进行等待与轮询（每次等待 30 秒），直至达到终态（`ok` / `error` / `deadline` / `stalled` / `cancelled` / `killed`）。请勿直接传入 `wait_seconds=0`，避免过早拆分成多次模型轮询往返。

委托说明前缀：桥接层默认在提示词前添加简要委托指引（明确为单次会话、无人交互应答、结束时汇报修改文件与结果结论），防止 DSH 进程因等待用户交互而挂起。

### 2.1 工具调用规范与 Schema 说明

操作约定已直接固化至 MCP 工具 Schema 定义中：

| 定义位置 | 规范内容 |
| --- | --- |
| `initialize.instructions` | 包含 `initialize 带委派操作手册` 概要（≤1500字符）：时间预估、验收标准、短超时优先等待、状态流转与失败排查说明 |
| `dsh_task.description` | 包含 `dsh_task 描述含完整委派约定`（约 2900 字符）：**先拆再派的原则与阈值**（一次只派一个可独立验收的产物、`expected_seconds` ≤ 300s；超过 300s、要改 3 个以上文件、或属于「先调研再实现再验证」的多阶段作业必须先拆；互不依赖的子任务同一轮里并发派出，有依赖的才串行）、明确的执行上限与经验区间（单文件 60~180s、多文件特性 300~900s、重构 900~1800s 且需拆分）、`deadlineAt = 开始时刻 + expected_seconds × grace`、七种状态语义、基于 `recent_activity` / `progress_bytes` / `last_progress_at` 的排查流程、模型配置四步法与禁止项 |
| 各参数 `description` | `expected_seconds` 说明截止时间与参考区间；`acceptance` 提供可判定正例；`wait_seconds` 说明默认 45 秒短超时及 `dsh_task_status(wait_seconds=30)` 轮询规则（禁止传 0 或大于 60）；`permission` 提示受限模式下使用 write/edit 工具；`timeout_seconds`/`model`/`provider`/`reasoning_effort`/`raw_prompt`/`label` 说明错误处理与错误代码（`UNKNOWN_MODEL` / `NO_ADAPTER` / `UNSUPPORTED_REASONING_EFFORT`） |
| `dsh_setup.description` | 说明三种配置模式（`default_model` / `preset` / `policy_markdown`），强调仅修改 `默认模型:` 声明行并保留用户其余配置 |
| `dsh_task_status.description` | 解析 `progress_bytes`、`last_progress`、`recent_activity`、`process_tree`、`silent_seconds` 字段定义 |
| `dsh_task_kill` / `dsh_task_cancel.description` | 说明按 `job_id` 与按 `caller` 两种终止模式及超时止损场景 |
| `dsh_health.description` | 说明 `liveTasks`、`activeByCaller`、看门狗阈值与 `monitorHost` 字段定义 |

自检套件包含对上述 Schema 文案的完整断言校验，确保规范描述不丢失。

### 2.2 任务终止响应机制

当外部客户端取消当前轮次请求时，客户端会发送 MCP `notifications/cancelled` 通知。桥接层执行以下终止逻辑：

| 触发场景 | 桥接层处理逻辑 |
| --- | --- |
| 取消正在等待的 `dsh_task` 或 `dsh_task_status` 请求 | 精确终止该请求对应的单个子代理任务 |
| 收到未关联具体请求的取消通知 | 若当前连接仅有一个活跃任务在运行，则终止该任务 |
| 关闭 MCP 连接或关闭外部客户端 | 终止当前连接名下的所有活跃任务并退出服务进程 |
| 终止 MCP 服务进程（`SIGTERM`/`SIGINT`） | 终止本进程名下的全部任务后退出 |

服务不依据轮询空闲时长猜测连接状态，仅响应明确的停止信号。在 Windows 环境下通过 `taskkill /F` 或 `TerminateProcess` 强制终止外部进程，并通过测试确保取消通知到达后子进程实际退出。

### 2.3 执行等待策略与超时控制

长任务若默认采用 `wait_seconds=0` 会被拆解为多次频繁的 `dsh_task_status` 轮询请求，增加额外的模型推理开销。

桥接层采用短超时优先机制：`dsh_task` 默认阻塞等待 **45 秒**。任务在 45 秒内完成则直接返回结果，零轮询；超时未完成则返回 `status: running`，转由调用方使用 `dsh_task_status`（默认单次等待 **30 秒**）按轮次推进。

默认等待时长的评估依据：

| 客户端环境 | 单次工具调用超时阈值 | 设定结论 |
| --- | --- | --- |
| Codex（`codex-mcp-client`） | **60 秒**（`mcp_servers.<id>.tool_timeout_sec` 默认值） | 作为最严格的限制条件 |
| Claude Code | Stdio 服务空闲窗口默认 30 分钟，单次上限约 28 小时；超过 2 分钟的调用自动转为后台任务 | 远宽于 45 秒 |
| Cursor（`cursor-vscode`） | 官方未公开单次限制 | 参照 60 秒上限保守处理 |

依据 60 秒阈值预留 25% 安全余量确定为 **45 秒**，状态轮询设置为 **30 秒**。实测短任务在 DSH 侧耗时 1.4~1.7 秒，`dsh_task` 在 3.5 秒内即可完成并带回终态结果（通过 `test/wait-policy-probe.mjs` 验证）。

如需支持长任务单次直接返回，需同步调整客户端工具超时与桥接层等待配置：

```toml
# ① 先把调用方的单次工具超时调大(Codex 为例;command/args 用安装器写好的那两行)
[mcp_servers.dsh]
command = "C:\\Program Files\\nodejs\\node.exe"
args = ["C:\\Users\\<you>\\.dsh\\subagent\\bin\\dsh-subagent-mcp.mjs"]
tool_timeout_sec = 600
```

```powershell
# ② 再同步把桥接层的等待调大(两个都可单独调)
DSH_SUBAGENT_WAIT_SECONDS=540          # dsh_task 的短超时
DSH_SUBAGENT_STATUS_WAIT_SECONDS=540   # dsh_task_status 的默认等待
```

相关配置通过环境变量覆盖，可通过 `dsh_health` 返回的 `defaultWaitSeconds`、`statusWaitSeconds`、`waitModel` 查看生效值。修改后需重启客户端生效。

### 2.4 模型配置机制与策略文件

桥接层动态获取模型清单，模型选择规则保存在外部策略文件中：

| 环节 | 技术实现与定义 |
| --- | --- |
| 已接入模型 | 通过 `dsh_health` 返回 `models:{ providers:{ <你的路由名>:[…] }, defaultModel, error }`（即 `dsh_health.models`），从 `$DSH_HOME/settings.yaml` 的 `llm-pi-ai.providers.<provider>.models`（以及 `llm-pi-ai.providers.<route>.models`）与 `llm-deepseek.models` 数组中解析 `id`（仅匹配 `id:` 字段）；文件异常时在 `error` 中记录原因 |
| 策略文件 | 路径为 `~/.dsh/subagent/config/model-policy.md`。顶部声明 `默认模型: <模型 id>`，`## 预设方案` 下包含各 `### <名字>` 分组与 `预设默认模型: <模型 id>` 行，`## 模型选择规则` 为说明文本。桥接层每次调用均重新读取该文件（可通过 `DSH_SUBAGENT_POLICY` 覆盖路径） |
| 访问链接 | 通过 `dsh_health` 返回 `modelPolicy.path` 与 `modelPolicy.fileUrl`（如 `file:///C:/Users/…/model-policy.md`，使用 `modelPolicy` 统一管理） |
| 预设方案 | 包含 `### 本项目方案`（`本项目方案`）：默认任务使用 `deepseek-v4.1-flash`，文档编写使用 `gemini-3.7-flash`，复杂任务由主模型直接处理 |

在未配置默认模型时（策略文件中为 `默认模型: (未指定)`），`dsh_task` 与 `dsh_health` 返回内容末尾附带 6 行初始化指引（包含查询模型、获取用户选择、调用 `dsh_setup` 写入配置及提供策略文件链接四要素）。写入配置后指引自动停用。

```jsonc
// 落盘:只改策略文件里 `默认模型:` 那一行,其余内容与用户改动一律保留
{ "name": "dsh_setup", "arguments": { "default_model": "deepseek-v4.1-flash" } }   // 已接入的模型,裸 id 或 provider/id
{ "name": "dsh_setup", "arguments": { "preset": "本项目方案" } }                     // 用预设里声明的模型
{ "name": "dsh_setup", "arguments": { "policy_markdown": "…" } }                    // 整体替换正文(必须保留 `默认模型:` 行)
```

若传入未注册模型 ID 则返回 `isError:true` 并输出可用模型列表；若参数类型错误（如 `default_model: 3`）同样返回 `isError:true` 并指明错误参数名。可通过 `dsh_setup(default_model: "…")` 写入配置。

---

## 3. 本机配置注册详情

| 外部工具 | 配置文件路径 | 写入内容 |
| --- | --- | --- |
| Cursor（IDE + cursor-agent CLI） | `~/.cursor/mcp.json` | `mcpServers.dsh` |
| Cursor 用户级规则 | `~/.cursor/rules/dsh-subagent.mdc` | 「委派子任务优先用 DSH」 |
| Claude Code | `~/.claude.json` | 用户级 `mcpServers.dsh` |
| Claude Code 子代理定义 | `~/.claude/agents/dsh.md` | `Task(subagent_type: "dsh")` = 转发给 DSH |
| Claude Code 全局说明 | `~/.claude/CLAUDE.md` | 「子代理委派:统一走 DSH」 |
| Claude Code 工具权限 | `~/.claude/settings.json` | `permissions.allow += mcp__dsh` |
| Claude Desktop（若已安装） | `%APPDATA%\Claude\claude_desktop_config.json` | `mcpServers.dsh` |
| Codex CLI / Desktop | `~/.codex/config.toml` | `[mcp_servers.dsh]`（含 `startup_timeout_sec = 60` / `tool_timeout_sec = 600`） |
| Codex 全局说明 | `~/.codex/AGENTS.md` | 「子代理委派:统一走 DSH」 |
| Gemini CLI | `~/.gemini/settings.json` | `mcpServers.dsh` |
| Antigravity | `~/.gemini/antigravity/mcp_config.json` | `mcpServers.dsh` |
| Kiro | `~/.kiro/settings/mcp.json` | `mcpServers.dsh` |
| Qoder | `~/.qoder/mcp.json` | `mcpServers.dsh` |
| VS Code / Copilot | `%APPDATA%\Code\User\mcp.json` | `servers.dsh` |
| Copilot CLI 备用路径 | `~/.vscode/mcp.json` | `servers.dsh` |
| opencode | `~/.config/opencode/opencode.json` | `mcp.dsh` |
| 命令行脚本路径 | `~/.local/bin/dsh-subagent.cmd`、`dsh-subagent-mcp.cmd` | 用户 CLI 入口 |
| DSH 本体 Profile | `$DSH_HOME/profiles/subagent/`（位于 `$DSH_HOME/profiles/` 目录下） | 独立子代理 Profile |
| DSH Desktop 宿主配置 | `$DSH_HOME/profiles/desktop/cordis.patch.yml`（`~/.dsh/profiles/desktop/cordis.patch.yml`） | 包含 `>>> dsh-subagent-observer >>>` 与 `>>> dsh-subagent-panel >>>` 受管块 |
| DSH Desktop 插件本体 | `$DSH_HOME/subagent/monitor/observer.mjs`、`$DSH_HOME/subagent/gui/**` | 宿主监控扩展脚本 |

配置写入执行幂等更新，修改前备份为 `<原文件>.bak-dshsubagent-<时间戳>`，遇到无法解析的 JSON 文件自动跳过。

### 3.1 推理强度配置（固定为 `high`）

针对 `llm-pi-ai` 下你自己的路由，处理某个模型（例如 `deepseek-v4.1-flash`）的推理强度配置。在 `~/.dsh/settings.yaml` 中声明支持档位与默认强度：

```yaml
llm-pi-ai:
  providers:
    my-gateway:
      apiKeyEnv: MY_GATEWAY_API_KEY
      api: openai-responses
      baseURL: https://your-gateway.example.com/v1
      reasoning: high            # 路由默认推理强度:没有显式 --reasoning-effort 时就用它
      models:
        - id: deepseek-v4.1-flash
          reasoningEfforts:      # 声明"这个模型支持哪些档位",并给出各档位落到协议上的写法
            off: none            # 网关不接受空值,off 必须显式写成 none
            minimal: minimal
            low: low
            medium: medium
            high: high
            xhigh: xhigh
            max: max
```

要点解析：

- **没有 `75` 这个取值。** 网关只认 `none|minimal|low|medium|high|xhigh|max`,传 `75` 会被拒
  (`unknown variant \`75\``,HTTP 400)。"75" 是 harness 侧的显示刻度,落到这个网关就是 `high`
  (与 Codex 的 `model_reasoning_effort = "high"` 同档)。本机的 `vision-toolkit`、以后新增的服务商都可以按此规则配置。
- `reasoningEfforts` 用于声明模型支持的档位列表，缺少声明时调用 `--reasoning-effort high` 会报 `UNSUPPORTED_REASONING_EFFORT`；`reasoning` 决定未传参时的默认级别（此处固定为 `effort: "high"`）。网关实测未声明时 `reasoning_tokens = 103`（`reasoning_tokens=103`），显式指定时 `reasoning_tokens = 35`（`reasoning_tokens=35`）。
- 配置文件在操作时动态重新读取，修改后无需重启 DSH Desktop。
- 单次调用可通过 `dsh_task` 的 `model` 参数或 `dsh --profile subagent --reasoning-effort low --prompt ...` 调整。

实测验证：

```powershell
# 改之前:失败 —— 说明这个模型压根没声明推理能力(连 high 都不支持)
dsh --profile subagent --prompt "只回答两个字:好的" --reasoning-effort high
# → exit 1, {"code":"UNSUPPORTED_REASONING_EFFORT","message":"... does not support reasoning effort \"high\""}

# 改之后:成功
dsh --profile subagent --prompt "只回答两个字:好的" --reasoning-effort high
# → exit 0, meta.json 里 {"reasoningEffort":"high","stopReason":"completed"}
```

若配置出现格式错误，`dsh-settings-file` 将整段拒绝加载并直接报错（`NO_ADAPTER: no adapter registered for provider "my-gateway"`），不进行静默回退。

安装与卸载脚本（由 `install.mjs` 与 `uninstall.mjs` 托管，版本号同步于 `package.json`）：

```powershell
node $env:USERPROFILE\.dsh\subagent\install.mjs              # 幂等重装(推荐)
node $env:USERPROFILE\.dsh\subagent\install.mjs --dry-run    # 只看会改什么
node $env:USERPROFILE\.dsh\subagent\uninstall.mjs            # 摘掉所有 MCP 注册
```

---

## 4. DSH `subagent` Profile 结构与限制

Profile 部署于 `$DSH_HOME/profiles/subagent/`（源码位于 `profile/`）：

```
package.json          bundles = dsh-base + dsh-headless,patchReload = startup
cordis.patch.yml      在 headless 基线上做的 7 处改动(逐条有注释)
subagent-startup.js   任务解析:--prompt / --prompt-stdin / --prompt-file / 位置参数
subagent-runner.js    一次性 runner:跑一轮 → 写 result.txt / meta.json → 退出
```

相对于官方 Headless 的调整：

1. 启动器支持 `--prompt-stdin`、`--result-file`、`--metadata-file`、`--model`。
2. 运行器输出最终答复与 `{sessionId, model, stopReason, durationMs}` 元数据，支持单次调用指定模型。
3. 停用标题自动生成插件以减少模型调用。
4. 审批策略固定为 `never`。
5. 沙箱模式由 `DSH_SUBAGENT_PERMISSION` 环境变量控制（默认 `danger-full-access`）。
6. 显式声明无人值守权限预设表（避免 `--permission workspace-write` 启动异常）。
7. 施加叶子节点限制条件，禁止外部任务递归分派子代理。

### 4.1 叶子限制条件（禁止外部任务递归派生子代理）

外部工具通过 `dsh_task` 调用的任务禁止递归创建子代理，Profile 禁用了以下插件：

| 禁用插件项 | 移除的工具接口 |
| --- | --- |
| `tool-subagent` | `subagent` |
| `tool-subagent-fork` | `subagent_fork` |
| `tool-workflow` + `workflow-worker-thread` | `workflow`（脚本内 `agent()` 扇出） |
| `tool-ralph` | `ralph` |
| `tool-subagent-control` + `tool-subagent-list-agents` | `list_agents` / `send_message` / `interrupt_agent` |

会话下发的工具表比对（解压 `jsonl.zstd` 验证）：

| 检查状态 | 可用工具总数 | 分叉类工具清单 |
| --- | --- | --- |
| 限制前 | 25 | `subagent`, `subagent_fork`, `workflow`, `ralph`, `list_agents`, `send_message`, `interrupt_agent` |
| 限制后 | 18 | 上述 7 个分叉工具全部移除；保留 `pwsh` / `read` / `write` / `edit` / `grep` / `web_search` / `todo_write` 等操作工具 |

自检验证命令：

```powershell
node $env:USERPROFILE\.dsh\subagent\test\leaf-only-probe.mjs <sessionId片段>
```

命令行直接调用测试：

```powershell
cd D:\some\repo
dsh --profile subagent --prompt "跑一遍单测并汇总失败项"
# 长提示词走管道,不受命令行长度限制:
type task.md | dsh --profile subagent --prompt-stdin
```

---

## 5. 权限管理与沙箱机制

| 关注维度 | 执行现状 |
| --- | --- |
| 默认权限 | `danger-full-access`（全权限读写模式） |
| 收紧方式 | 传入参数 `permission: "workspace-write"` / `"read-only"` 或设置环境变量 `DSH_SUBAGENT_PERMISSION` |
| 审批模式 | 子代理进程固定为 `never`，越界操作由沙箱直接拒绝 |
| 并发控制 | 单个 MCP 服务进程默认最多 4 个并发 DSH 实例，超出排队等待（详见 §6.1） |
| 审计记录 | 每次任务持久化至 `$DSH_HOME/subagent/state/tasks/<job-id>/{prompt.md,result.txt,meta.json,stderr.log,task.json}` |
| 遥测设置 | 遵循 DSH 自身配置，可设置 `DSH_TELEMETRY_DISABLED=1` 禁用 |

权限生效机制：

1. Profile 显式定义完整的权限预设映射表（三种模式均对应 `approval: never`），避免 `dsh-permission-presets` 在构造期抛出 `composed sandbox and approval defaults match no preset` 异常导致进程退出。
2. 运行器在执行前通过 `permissionPresets.set()` 将目标权限写入当前会话事件流，工具层依据 `ctx.sandboxPolicy.resolve({session})` 动态解析沙箱策略；若锁定失败则直接报错退出。

已知运行边界：两个 profile 的沙箱相关行集合一致（`sandbox-local` / `sandbox-policy` / `pwsh-sandbox` / `fs-sandbox`）。在 Windows 环境下，`workspace-write` 与 `read-only` 模式会导致 `pwsh` 工具无法拉起交互式 Shell，返回全空文本且无 `[exit code: N]` 或 `[sandbox: …]` 标记。在此类受限模式下，文件操作应使用 `write` / `edit` 工具（会返回 `[sandbox: file access denied under … mode]`），执行脚本工作应使用 `danger-full-access`。

### 5.1 沙箱模式下 Shell 空转检测

在 `workspace-write` 或 `read-only` 模式下，DSH 底层沙箱机制会导致 Shell 工具返回空内容（`"\r\n"`）且标记为 `isError: false`，进程并未实际启动。在同一条 `Write-Output SPAWN-PING` 测试中，读取真实会话日志的 `tool/result` 记录：

| 权限等级 | 命令实际返回数据 | 执行状态 |
| --- | --- | --- |
| `danger-full-access` | `SPAWN-PING\r\nELAPSED_MS=59\r\n` | 进程正常启动并执行 |
| `workspace-write` / `read-only` | `"\r\n"`（`isError: false`） | 进程未执行 |

对照实验证明：执行 `exit 3` 不返回 `[exit code: 3]`，`Start-Sleep -Seconds 5` 不发生阻塞，`Set-Content` 与 `cmd /c echo > file` 不生成文件，而文件读写工具正常运行。

桥接层在任务结束时会解析会话日志，检测是否存在此类空转的 Shell 调用。若存在，将在答复末尾附加包含调用次数与命令样例的告警，并在元数据中记录 `shellHollowCalls` 与 `shellHollowSamples`。需执行命令的任务应显式指定 `permission: "danger-full-access"`，可通过分派执行 `echo` 命令验证执行状态。

---

## 6. 并发控制与状态可视化

### 6.1 并发与任务生命周期管理

| 控制维度 | 执行机制 |
| --- | --- |
| 单次会话并发请求 | 支持并行处理。MCP 层基于异步事件（`lib/mcp.mjs` 中的 `onFrame`）分派任务，互不阻塞 |
| 单进程并发上限 | 默认上限为 4（由 `DSH_SUBAGENT_MAX_CONCURRENCY` 控制），超出限制的任务进入队列排队等待 |
| 多客户端隔离 | 每个客户端工具运行独立的 MCP 服务进程，各享有独立的并发配额（CLI `dsh-subagent` 同样独立） |
| 配额调整 | 在客户端配置的 `env` 中添加 `"DSH_SUBAGENT_MAX_CONCURRENCY": "8"`，重启客户端生效 |
| 状态查询 | 通过 `dsh_health` 返回 `maxConcurrency`、`activeTasks`、`activeByCaller`（如 `cursor-vscode: 2 running`）、`liveTasks`（包含 `job_id/caller/workspace/status/pid/deadlineAt/remainingSeconds/lastProgressAt/progressBytes/queuedSeconds`）及最近任务列表 |

实测通过 `node test/concurrency-probe.mjs <工作空间> 3`（`node test/concurrency-probe.mjs <ws> 3`）验证 3 路并发正常并行执行。

任务取消与终止：

- `dsh_task_cancel`：优雅取消，对运行中及排队中的任务均有效。
- `dsh_task_kill`：强制终止指定 `job_id` 或指定 `caller` 在当前服务进程内的全部活跃任务进程树。

### 6.2 超时保护与停滞看门狗

| 保护机制 | 触发条件 | 执行动作与状态 |
| --- | --- | --- |
| 外层超时上限 | 达到 `timeout_seconds`（默认 1800） | 终止任务，记录 `status: "timeout"` |
| 预估截止时间 | 达到 `startedAt + expected_seconds × grace`（默认系数为 2） | 终止任务，记录 `status: "deadline"`，返回 `error: 超出预估时间 Ns × grace G 仍未完成,已终止` |
| 停滞看门狗 | 每 `DSH_SUBAGENT_WATCHDOG_INTERVAL`（默认 30 秒）采样一次，满足多信号无增长、静默时间达 `DSH_SUBAGENT_STALL_MIN_SECONDS`（默认 180 秒）且连续 `DSH_SUBAGENT_STALL_PROBES`（默认 2）次采样无变化 | 终止进程树，记录 `status: "stalled"` 并保存取证数据（`signalState` / `treePids` / `treeCpuMs` / `cpuDeltaMs` / `silenceSeconds`） |

#### 停滞判定的信号指标

单一日志大小不足以判定任务是否停滞（例如长时间执行复杂循环脚本时日志可能暂时无增长）。因此采样以下综合指标：

| 信号类别 | 检测指标 | 说明 |
| --- | --- | --- |
| 输出日志 | `stderr.log` / `stdout.log` / `result.txt` / `session.jsonl.zstd` 的字节数 | 仅比对文件字节大小，不使用不可靠的修改时间（mtime） |
| 进程树状态 | ① 根进程存活状态 ② 后代进程 PID 集合变动 ③ 整树累计 CPU（`KernelModeTime + UserModeTime`）增长是否达到 `DSH_SUBAGENT_STALL_CPU_MS`（默认 200ms） | 单轮通过 `Get-CimInstance`（`Get-CimInstance Win32_Process`）查询全表快照，未达阈值的增量进行累加 |
| 外部观测 | 调用方通过 `dsh_task_status` 读取到的 `progressBytes` 增量 | 外部状态查询产生的数据推进 |

运行规则与护栏：

- 排队中任务不进行停滞判定，通过 `queuedSeconds` 监控排队时长。
- 首个探测周期完成前不执行终止；已结束或已取消的任务不处理。
- 仅依据字节增长判定进展，时间戳变化不计入进展。
- 后代进程活跃或 CPU 增长的长命令视为正常执行。
- 需同时满足静默时长达到 `DSH_SUBAGENT_STALL_MIN_SECONDS` 且连续 `DSH_SUBAGENT_STALL_PROBES` 次采样无进展才触发终止。
- 引入 CPU 干活强度下限 `DSH_SUBAGENT_STALL_CPU_WORK_FLOOR_MS`（默认 1500ms），将调度与定时器空转噪声与实际计算工作区分开。
- 对照实验证明：设置 `DSH_SUBAGENT_STALL_CPU_MS=200` `(且**不设**` `..._CPU_WORK_FLOOR_MS`) 跑同一个自检时，小幅 CPU 增量会使 `progressed` 标志置位，导致 `stalledProbes` 采样计数反复归零而漏判挂起；设置下限阈值后可准确认定停滞。
- 快速测试可通过设置 `DSH_SUBAGENT_WATCHDOG_INTERVAL=5` 与 `DSH_SUBAGENT_STALL_MIN_SECONDS=10`；设置 `DSH_SUBAGENT_WATCHDOG=off` 可整体关闭看门狗。

### 6.3 宿主会话列表可见性

子代理创建的会话保存在 `$DSH_HOME/sessions/<工作空间key>/session-<uuid>/` 目录下（例如工作空间 `D:\work\demo` 对应目录为 `$DSH_HOME\sessions\--D-work-demo--\`，路径特殊字符编码为 `~XXXX~` 形式）。会话数据随执行实时落盘，可在 DSH Desktop 列表中查阅。

实时查看任务输出：

```powershell
# 推理流(实时增长)
Get-Content -Wait $env:USERPROFILE\.dsh\subagent\state\tasks\<job-id>\stderr.log
# 当前状态 / 工作空间 / 产物
Get-Content $env:USERPROFILE\.dsh\subagent\state\tasks\<job-id>\task.json
```

任务结束后，`result.txt` 存放最终答复文本，`meta.json` 中记录 `sessionId`。实时查看任务输出也可直接通过 `Get-Content -Wait …\stderr.log` 命令查看。

### 6.4 宿主状态观察器（`monitor/observer.mjs`）

观察器插件加载于 DSH Desktop 宿主进程中，将外部任务状态同步至界面：

| 任务状态阶段 | 界面显示状态 |
| --- | --- |
| 任务启动（约 2 秒内） | 会话自动显示于对应工作空间的侧边栏，并显示运行中标记 |
| 运行中 | 会话置顶显示，标题包含调用方与任务信息（带有 `⚡ <调用方> · <标题> ⚠运行中·勿点开` 说明），携带状态投影数据 |
| 任务结束 | 运行中标记清除，会话保留在列表中供完整查阅 |

实现机制：

1. 桥接层在任务启动时将 `sessionId` 写入 `meta.json`，并在 `task.json` 中记录 `pid` / `status` / `workspace`。
2. 观察器每 2 秒扫描 `$DSH_HOME/subagent/state/tasks/*/`，校验 `pid` 存活状态，并发送 `api-session/added`、`api-session/status`、`api-session/activity`（简称 `activity`）事件。
3. 客户端接收事件后调用 `mergeSummary` 与 `session.handleRunning(running)` 更新侧边栏。
4. 携带 `projections.values['dsh-subagent']` 投影数据，每 20 秒（或数据变动后经过 `ACTIVITY_MS`）重播一次，确保页面刷新后状态恢复。

安装文件：

- 插件本体：`~/.dsh/subagent/monitor/observer.mjs`（依赖 `node:fs` 与 `ctx.emit`）。
- 宿主配置：`~/.dsh/profiles/desktop/cordis.patch.yml` 中的 `>>> dsh-subagent-observer >>>` 受管块。
- 日志文件：`~/.dsh/subagent/state/observer.log`（可设置 `DSH_SUBAGENT_OBSERVER_DEBUG=1` 开启调试输出）。

配置生效要求：`desktop` profile 的 `patchReload: live` 机制在打包环境下不自动热加载，首次安装后需重启一次 DSH Desktop。

观察器每 5 秒更新一次心跳文件 `$DSH_HOME/subagent/state/observer-heartbeat.json`：

```json
{ "at": "2026-09-11T10:31:02.123Z", "epochMs": 1762331462123, "pid": 12345,
  "engine": "dsh-desktop-observer", "profile": "desktop", "pollMs": 2000,
  "trackedTasks": 3, "activeTasks": 1 }
```

宿主自动启动决策流程（`lib/monitor-host.mjs`）：

| 步骤 | 判定条件 | 执行操作 |
| --- | --- | --- |
| 1 | 心跳时间有效（`Date.now() - epochMs < 20000`）且心跳记录的 PID 存活 | 标记 `already-running`，不启动新宿主 |
| 2 | 心跳文件存在但 PID 已退出或时间过期 | 判定为过期记录，继续后续检查 |
| 3 | 环境变量 `DSH_SUBAGENT_AUTOSTART_MONITOR=off` | 标记 `skipped` |
| 4 | 运行平台非 Windows | 标记 `skipped` |
| 5 | 枚举进程中已存在真正的图形界面宿主进程 | 标记 `gui-open-old-observer`，不重复启动 |
| 6 | 进程表查询连续失败两次 | 标记 `probe-failed`，暂不启动 |
| 7 | 距上次启动尝试未超过冷却时间（`DSH_SUBAGENT_MONITOR_COOLDOWN_MS`，默认 60000） | 标记 `skipped` |
| 8 | 上述条件均不满足 | 标记 `launched`，调用 `spawn(exe, args, {detached:true, stdio:'ignore', windowsHide:false}).unref()` 后台启动 |
| — | 找不到可执行文件 | 标记 `unavailable` |
| — | 仅执行只读状态查询 | 标记 `unknown`（`dsh_task_status` 接口保持只读） |

进程分类规则（与 `test/live-audit.mjs` 一致）：命令行包含 `--type=` 判定为渲染子进程；包含 `--expose-internals` 判定为 CLI 子代理任务；两者均不包含判定为图形宿主主进程（阻止重复启动）。命令行是用 base64 编码从 PowerShell 传递的（直接使用 `"$pid|$cmdline"` 会被多行脚本 `node -e "…"` 的换行符切断并解析出 `pid=NaN` 假条目）。可通过 `DSH_SUBAGENT_MONITOR_FORCE=1` 强制启动，或设置 `DSH_SUBAGENT_MONITOR_HOST_CHECK=off` 关闭宿主检测。

可执行文件定位顺序：`DSH_SUBAGENT_MONITOR_CMD`（可通过 `DSH_SUBAGENT_MONITOR_ARGS` 追加参数）→ `C:\Program Files\DSH Desktop\DSH Desktop.exe` → `%LOCALAPPDATA%\Programs\DSH Desktop\DSH Desktop.exe`。日志记录于 `$DSH_HOME/subagent/state/monitor-host.log`。状态可通过 `dsh_health` 中的 `monitorHost`（包含 `running`、`state`（状态包括 `host-with-heartbeat` / `host-older-observer` / `no-host`）、`guiOpen`、`guiHostPids`、`cliProcessPids`、`heartbeatAt`、`heartbeatAgeMs`、`heartbeatPidAlive`、`heartbeatResidue`、`processProbeFailed`、`autostart`、`lastLaunch`）及任务返回结果中的 `monitor_host: <action>(<reason>)` 查看。

自检验证命令：

```powershell
node $env:USERPROFILE\.dsh\subagent\test\monitor-autostart-probe.mjs   # 26 项:三步判活逐条 + 命令行分类
```

配置参数包含 `DSH_SUBAGENT_OBSERVER_INTERVAL`、`DSH_SUBAGENT_OBSERVER_ANNOUNCE_AGE_MS`、`DSH_SUBAGENT_OBSERVER_REANNOUNCE_MS`、`DSH_SUBAGENT_OBSERVER_MAX_AGE_MS`。

自检测试：

```powershell
node $env:USERPROFILE\.dsh\subagent\test\observer-selftest.mjs   # 49 项,含投影、僵尸/半成品判活、心跳+规则版本、token 折叠、吞吐窗口、只读转录、0.1.5 新日志名
node $env:USERPROFILE\.dsh\subagent\test\live-audit.mjs          # 现场审计:真的在跑几个 / 残留记录几个 / 宿主状态
```

### 6.5 悬浮卡片 Subagent（独立实时视图）

悬浮面板插件 `dsh-subagent-panel` 加载于窗口右上角，提供独立的运行状态视图：

| 功能特性 | 技术说明 |
| --- | --- |
| 分组展示 | 按 **Cursor / Claude Code / Codex / 命令行 / 自检 / 未知来源** 分组，显示对应字形标识 |
| 内置子代理支持 | 支持展示 DSH 内部的 `subagent`（`subagentsByParent` 目录），归入「本机 DSH 子代理 ✦」分组，显示 `L1 ⊞` 层级标记与状态 |
| 交互展开 | 点击分组标题展开卡片列表，包含活跃任务的分组默认保持展开 |
| 默认过滤 | 头部默认仅展示运行中会话，点击 `全部` 展示历史完成记录 |
| 视觉设计 | 独立配色方案，适配浅色与深色主题，符合 WCAG 对比度规范 |
| 界面缩放 | 头部提供 `−` / `120%` / `+`（缩放栏 `− 120% +`）按钮，支持 60%~200% 范围调节，数据持久化于 `localStorage` |
| 自由调整尺寸 | 提供三个调节手柄（右侧调节宽、底部调节高、右下角同时调节），数据保存在 `localStorage`，双击手柄恢复默认尺寸 |
| 自适应多列布局 | 网格布局使用 `repeat(auto-fill, minmax(132px, 1fr))` 随实际宽度自适应列数，高度拉伸后内容区域滚动 |
| 状态汇总统计 | 底部显示 Token 汇总：`250 tok/s \| 缓存命中 99% \| 输入 111M tok · 输出 636K tok` |
| 空状态展示 | 无活跃任务时居中显示图标与「无活跃子代理」提示文本 |
| 实时详情查看 | 点击运行中任务卡片进入只读详情页，展示调用方、工作空间、已耗时、验收条件、Token 明细及**会话转录**（用户提示词、助手答复、工具调用、工具返回；观察器只读折叠会话日志得来）；没有转录时退回 `stderr.log` 最新输出行 |
| 历史会话访问 | 点击已完成卡片调用 `ctx.sessions.open(id)` 打开对应会话 |
| 拖动与折叠 | 头部支持拖动调整位置，点击 `收起` 后最小化为紧凑状态条 |

头部控件在小尺寸下支持折行（`flex-wrap: wrap`），采用 `flex` 布局并保持 `flex: none` 与 `white-space: nowrap`，避免将 `Subagent` 标题截断为 `SUBAGENT…` 或 `SUBAGENT`。

#### 7.5.1 底部状态条 Token 统计数据来源

| 会话类型 | 数据源 | 说明 |
| --- | --- | --- |
| 本机 DSH 子代理 / 宿主自身会话 | 宿主 `projectionValues.tokenUsage` 投影 | 直接读取宿主自身的 Token 计量数据 |
| 外部 `dsh_task` 任务 | 观察器解析子代理的会话日志 | 独立解压分析会话日志文件计算用量 |

Token 折叠逻辑遵循同轮次 `(turn, step)` 的 `assistant/chunk(chunk.type=usage)` 与 `assistant/message(data.usage)` 样本执行替换更新（避免用量翻倍），遇到 `llm/retry-started` 重置替换槽。缓存命中率计算公式为 `缓存读 / prompt 侧总量`。

数据解压要求：由于会话日志采用多帧 zstd 追加写格式，必须逐帧解压（避免使用 `zstdDecompressSync(整个文件)` 导致仅解出首帧数据），折叠结果按 `(size, mtime)` 缓存并以 5 秒周期节流。

#### 7.5.2 吞吐速率（tok/s）计算规则与窗口设定

吞吐速率计算统一在观察器内进行（`rateOf`）：依据真实采样时间跨度计算 `Δ输出 / Δ真实采样时间`（时间跨度小于 3 秒不计算速率，旧实现直接在客户端计算 `Δ输出/Δt` 产生严重误差；避免类似 `2 秒里跳 6000 token` 被误算为 3000 tok/s，跨 29 秒的 6000 token 准确计算为约 207 tok/s），并取最近 4 次采样的平滑平均值。客户端仅负责渲染显示，不保留采样窗口。

实测输出：通过 `test/observer-selftest.mjs` 验证投影数据中输出速率低于 2000（`< 2000` 断言），仅运行中任务显示速率（第二行显示 `↑输入 ↓输出` 与 `N tok/s` 吞吐指标，单位 `tok/s`，待机显示 `-` 或 `—`），结束后恢复。

真实日志折叠范例（`node test/usage-fold-probe.mjs --all`）：

```
1282 帧 / 1727 行 / 699.4K   输入 92103 · 输出 50207 · 缓存读 1949440 · 36 次调用 → 命中率 95.5%
1053 帧 / 1465 行 / 594.6K   输入 75871 · 输出 44498 · 缓存读 2522880 · 38 次调用 → 命中率 97.1%
```

观察器版本识别：查看心跳文件中的 `usageRate: { minSpanMs, samples, foldThrottleMs }`（`usageRate`）字段（包含 `minSpanMs`、`samples`、`foldThrottleMs`），若缺少该字段说明需重启 DSH Desktop。

客户端 Bundle 包含内容哈希（如 `.../client.js&rev=c06568fbaf88308f-47` 或 `rev=da77570553a2`），响应头包含 `cache-control: public, max-age=31536000, immutable`，修改客户端代码后通常直接刷新页面生效（必要时按 `Ctrl+F5` 强制刷新）。

独立配色与对比度设计：浅色主题下宿主 `--dsw-alias-border-inverted` 为 `#0000`，`--dsw-alias-state-warn-primary` 为 `#f59e0b`（对比度仅 2.15:1）。面板采用独立色板，确保达到 WCAG AA 对比度要求：

| 文本类别 | 浅色主题（白底） | 深色主题（卡片 `#14171d`） |
| --- | --- | --- |
| 正文 / 次要 / 第三级文本 | 18.5 / 9.7 / 6.4 : 1 | 16.6 / 11.9 / 8.2 : 1 |
| 强调 / 成功状态 | 6.6 / 7.6 : 1 | 8.9 / 10.4 : 1 |
| 告警状态 | **7.0 : 1** | **11.7 : 1** |
| 错误状态 | 7.8 : 1 | 9.0 : 1 |

在浅色主题下，`state-warn-primary`（即 `--dsw-alias-state-warn-primary`）默认的 `#f59e0b` 对比度不足，插件将其重载为 `#8a4700`（`body:not([data-ds-dark-theme]) { --dsw-alias-state-warn-primary: #8a4700 }`），调整 `-primary` 文本与指示点用色（`-secondary` 与 `-tertiary` 保持不变，深色主题 `body[data-ds-dark-theme]` 不受影响），详情页超时行通过 `data-tone="err"/"warn"` 标记染色。

布局缩放机制：使用 `zoom` 代替 `transform`（`transform: scale()`），使布局与点击区域同步缩放（外层为 `.sap-zoom`）；窗口宽高直接通过 CSS 变量控制（`width: var(--sap-w, 300px)` 与 `height: var(--sap-h, auto)`）。

数据流与加载机制：面板注册于 `shell.overlay` 悬浮层，通过读取 `projectionValues['dsh-subagent']` 获取数据，包含生效模型参数（`model` / `provider` / `reasoningEffort`），优先读取 `state/tasks/<job-id>/meta.json`（包含 `provider: "my-gateway"` 与 `model: "deepseek-v4.1-flash"`），缺失时回退至 `task.json`。

安装文件：包含 `~/.dsh/subagent/gui/package.json`、`gui/lib/index.js`、`gui/lib/client.js`（通过 `window.__ModuleLoader__.load` 加载，使用 `dsh.client` 与 `exports["./client"]`），并在 `~/.dsh/profiles/desktop/cordis.patch.yml` 中添加指向 `file://`（`file:` / `file:///` / `file:///…`）的 `>>> dsh-subagent-panel >>>` 受管块。首次使用需刷新页面并重启宿主。

自检脚本：

```powershell
# 卡片逻辑(离线:假 window/__ModuleLoader__ + 迷你 React,真跑组件函数)
node $env:USERPROFILE\.dsh\subagent\test\panel-selftest.mjs            # 138 项
# 观察器侧(隔离 DSH_HOME 造假任务现场,投影里带出 model/provider/reasoningEffort/只读转录)
node $env:USERPROFILE\.dsh\subagent\test\observer-selftest.mjs          # 49 项

# 真实任务日志 → token 用量折叠(逐帧解 zstd;只读)
node $env:USERPROFILE\.dsh\subagent\test\usage-fold-probe.mjs --all

# 启动图(起一个一次性 web 实例,确认插件真的进了 __DSH_BOOT__ 且 bundle 能取到)
dsh --patch $env:USERPROFILE\.dsh\subagent\gui\test-overlay.yml --profile web --no-open --port 34199
node $env:USERPROFILE\.dsh\subagent\test\gui-graph-probe.mjs "http://127.0.0.1:34199/?token=<上面打印的 token>"
```

### 6.6 运行中外部会话访问限制说明

宿主在打开会话时会执行 `sessions.follow` 流处理，对非活跃会话调用 `promote()` → `agents.resume()` → `persistence.prepare()`。若对正在写入的外部会话执行该操作：

1. `prepareCore` 会合成中断事件（包含 `interrupted-tool-result-*` 与 `turn/end{reason:"interrupted"}`），并通过 `commitRepair` 执行文件写入。
2. 随后追加 `session/end-seed` 并写入未发布后缀。
3. 外部子进程在不知情的情况下继续以相同序号写入，导致日志中出现重复序号（seq）与伪造的 `turn/end{interrupted}` 标记。

日志取证：分析历史日志中包含此类异常标记的记录（如 `session-5e4c139b…` 出现重复序号）。此外，`follow` 循环仅读取宿主自身的 `session/event`（通过 `dsh-api-session-controller`），不实时跟踪外部文件写入，且在多写并发时执行 `readFile` 与全量解压会导致界面卡顿（底层由 `SessionHistoryController.follow` 处理）。

防护处理策略：

| 任务状态 | 处理方式 |
| --- | --- |
| 任务已结束 | 点击直接调用常规打开流程 |
| 任务运行中 | 默认仅展示只读详情视图，禁用常规打开，提供需二次确认的强制打开按钮 |
| 实时内容查阅 | 在详情页中只读显示会话转录（观察器折叠会话日志），不打开会话；打开会让宿主接管写权并写坏它的日志 |

### 6.7 本机子代理与外部 `dsh_task` 的对比

| 对比维度 | 本机 `subagent` 工具 | 外部 `dsh_task`（MCP） |
| --- | --- | --- |
| 调用来源 | 仅限 DSH 内部运行的模型 | 外部 MCP 客户端工具（Cursor / Claude Code / Codex 等） |
| 运行形式 | 同宿主进程内的子会话（`dsh-subagent-spawn-in-process`） | 独立子进程（`dsh --profile subagent`） |
| 递归深度限制 | 受 `tool-subagent.maxDepth` 限制（默认 3 层） | 由调用方按需控制 |
| 控制通道 | `list_agents` / `send_message` / `interrupt_agent` | `dsh_task_status` / `dsh_health` / `dsh_task_kill` |
| 面板展示 | 「本机 DSH 子代理 ✦」分组（显示 L1/L2/L3 与 `⊞` 标识） | 按外部调用方分组展示 |

卡片同时读取宿主子代理目录（`subagentsByParent`），调用 `ctx.sessions.refreshSubagents` 刷新递归层级，对同进程子代理不施加运行中限制。

### 6.8 任务台账与进程存活状态判定

`state/tasks` 目录为跨进程共享，当服务进程异常退出时可能残留标记为运行中的失效记录。

系统统一在 `taskState`、`taskState()`、`listTasks`、`killByCaller` 三处采用统一状态推导逻辑：

1. 当前进程内持有任务句柄：判定为 `running`。
2. `meta.json` 中已记录 `stopReason`：依据元数据转换为终态（`ok`/`error`）。
3. 检查进程 PID 是否存活：存活判定为 `running`，已退出或未记录 PID 则标记为 `lost`。

`listTasks()` 返回数据包含以下扩展字段：

| 字段名 | 字段含义 |
| --- | --- |
| `status` | 经存活校验后的实际状态（失效记录标记为 `lost`） |
| `stale` | 布尔值，`true` 表示记录标记为运行中但实际进程已退出 |
| `pidAlive` | PID 存活状态（`true` / `false` / `null`） |
| `derived` | 布尔值，标记状态是否由 PID 或元数据推导得出 |

`dsh_task_kill {caller}` 仅对 `pidAlive === true` 的进程执行终止，将失效记录归入 `stale` 列表，输出形如 `另清理了 N 条**残留记录**…` 的提示信息。旧实现通过 `spawn('taskkill', …)` 发送终止信号后不校验结果，即使强杀失败也返回 `killed: true`；当前外部进程终止采用同步执行校验（`execFileSync` / `killTreeSync`），确保进程实际退出（返回退出码 0）才报告成功（`killed: true`），未确认时返回 `killed: false, note: "强杀失败:taskkill 未确认终止(退出码 128);进程可能仍在运行,记录保持 running"`，本进程任务使用 `killTree` 终止。

自检（使用临时 `DSH_HOME` 构造测试数据，不修改真实 `%USERPROFILE%\.dsh` 目录；状态查询调用 `taskState()` 与 `listTasks()` 清理标记为 `status:"running"` 但 PID 已退出的记录；宿主控制器 `dsh-api-session-controller` 的 `summaryFor` 基于 `running: this.ctx.agents.get(session.id)?.status === "running"` 推导）：

```powershell
node $env:USERPROFILE\.dsh\subagent\test\ledger-liveness-probe.mjs   # 20 项:残留记录/在跑/meta 推导/真的杀掉/强杀失败如实回报
```

---

## 7. 环境变量一览表

| 环境变量名称 | 默认值 | 功能说明 |
| --- | --- | --- |
| `DSH_SUBAGENT_WAIT_SECONDS` | `30` | `dsh_task` 默认阻塞等待时间（秒） |
| `DSH_SUBAGENT_DEADLINE_GRACE` | `2` | 截止时间宽限系数：`deadlineAt = startedAt + expected_seconds × grace` |
| `DSH_SUBAGENT_TIMEOUT_SECONDS`（或 `DSH_SUBAGENT_TASK_TIMEOUT`） | `1800` | 最外层绝对超时时间（秒） |
| `DSH_SUBAGENT_WATCHDOG_INTERVAL` | `30` | 停滞看门狗采样检测周期（秒） |
| `DSH_SUBAGENT_STALL_PROBES` | `2` | 判定停滞所需的连续无变化采样次数 |
| `DSH_SUBAGENT_STALL_MIN_SECONDS` | `180` | 判定停滞所需的最小静默秒数 |
| `DSH_SUBAGENT_STALL_CPU_MS` | `200` | 判定为有进展的进程树 CPU 增量阈值（毫秒） |
| `DSH_SUBAGENT_STALL_CPU_WORK_FLOOR_MS` | `1500` | 判定为有效工作的 CPU 增长下限值（毫秒，见 §6.2） |
| `DSH_SUBAGENT_WATCHDOG` | 未设置 | 设置为 `off` 时整体关闭停滞看门狗 |
| `DSH_SUBAGENT_TREE_PROBE_TIMEOUT_MS` | `15000` | 进程快照查询单次超时时间（毫秒） |
| `DSH_SUBAGENT_PS` | 系统 PowerShell | 指定进程快照所使用的 `powershell.exe` 路径 |
| `DSH_SUBAGENT_MAX_CONCURRENCY` | `4` | 单个 MCP 服务进程的最大并发任务数 |
| `DSH_SUBAGENT_AUTOSTART_MONITOR` | 开启 | 设置为 `off` / `0` / `false` 禁用自动启动监控窗口（见 §6.4） |
| `DSH_SUBAGENT_MONITOR_COOLDOWN_MS` | `60000` | 自动启动尝试的冷却时间间隔（毫秒） |
| `DSH_SUBAGENT_MONITOR_HEARTBEAT_MS` | `20000` | 判定监控宿主离线的超时阈值（毫秒） |
| `DSH_SUBAGENT_MONITOR_HOST_CHECK` | 开启 | 设置为 `off` 时关闭宿主已存在则跳过的检查限制 |
| `DSH_SUBAGENT_MONITOR_HOST_PROCESS` | `DSH Desktop.exe` | 宿主进程匹配的映像名称 |
| `DSH_SUBAGENT_MONITOR_FORCE` | 未设置 | 设置为 `1` 强制跳过宿主检查 |
| `DSH_SUBAGENT_MONITOR_CMD` | 未设置 | 自定义拉起的可执行文件路径 |
| `DSH_SUBAGENT_MONITOR_ARGS` | 未设置 | 启动时追加的命令行参数 |
| `DSH_SUBAGENT_HOST_PROBE_TIMEOUT_MS` | `15000` | 宿主进程查询单次超时时间（毫秒） |
| `DSH_SUBAGENT_PERMISSION` | `danger-full-access` | 子代理默认权限等级 |
| `DSH_SUBAGENT_RESULT_CLIP` | `60000` | 返回结果的最大字符数截断上限 |
| `DSH_SUBAGENT_ACTIVITY_CLIP` | `1800` | 状态轮询活动日志的最大字符数上限 |
| `DSH_SUBAGENT_OBSERVER_USAGE_REFRESH_MS` | `5000` | 单个会话日志重新折叠用量的最小间隔（毫秒） |
| `DSH_SUBAGENT_OBSERVER_ACTIVITY_MS` | `5000` | 数据变动触发提前重播的最小间隔（毫秒） |
| `DSH_SUBAGENT_OBSERVER_RATE_MIN_MS` | `3000` | 计算处理速率的最小采样时间窗口（毫秒，见 §6.5.2） |
| `DSH_SUBAGENT_OBSERVER_RATE_SAMPLES` | `4` | 速率统计平滑处理的采样次数 |
| `DSH_SUBAGENT_OBSERVER_TRANSCRIPT_ENTRIES` | `60` | 只读预览的会话转录最多保留多少条（从最旧的开始丢弃） |
| `DSH_SUBAGENT_OBSERVER_TRANSCRIPT_CHARS` | `6000` | 只读预览的会话转录总字数上限（投影要反复重发，必须封顶） |
| `DSH_SUBAGENT_OBSERVER_TRANSCRIPT_ENTRY_CHARS` | `600` | 只读预览的单条转录字数上限（工具返回体常常上万字） |

CLI 命令行支持参数：`--expected-seconds <n>`、`--acceptance <text>`、`--caller <name>`（默认为 `cli`）。

---

## 8. 常见问题解答

**Q: 传入 `permission: "workspace-write"` 时任务在 2 秒内失败并抛出 `permission: composed sandbox and approval defaults match no preset` 异常？**
问题原因与修复：DSH 内置预设表将 `workspace-write` 与 `read-only` 配置为 `approval: ask`，与无人值守模式的 `approval: never` 不匹配，导致插件在构造期抛错。Profile 已显式定义完整的权限预设表，为三种模式均配置 `never` 审批策略，三种权限等级均可正常运行。

**Q: 指定 `permission: "workspace-write"` 时子代理仍可写入工作区外部？**
问题原因：全局设置可能覆盖 Profile 的默认预设（`config.defaultPreset` 与 `permission.defaultPreset`）。当前版本运行器在执行前会将权限等级写入本次会话的事件流中，确保沙箱策略按当前会话权限执行。可通过 `node test/session-perm-probe.mjs <sessionId>` 验证实际生效的权限。

**Q: 客户端中未显示 `dsh` 工具？**
处理方式：重启对应的客户端工具（Cursor / Claude Code / Codex 仅在启动时加载 MCP 配置）。在 Claude Code 中执行 `claude mcp list` 验证连接状态（应显示 `dsh: … √ Connected`），在 Codex 中执行 `codex mcp list`。

**Q: `dsh_task` 返回 `status: running` 后的处理流程？**
处理方式：在当前会话中调用 `dsh_task_status(job_id, wait_seconds=30)`（默认等待 30 秒）轮询状态，直至返回终态。返回数据中包含 `recent_activity` 与 `progress_bytes`，也可通过查看 `prompt.md` 与 `stderr.log` 文件获取实时进度。

**Q: 客户端日志中显示 MCP 服务产生警告信息？**
技术原因：部分客户端会将 MCP 子进程的标准错误输出一律标记为警告。实测 Cursor `mcpprocess.log` 记录如下（包含 `[warning] [McpProcess stderr] ERR dsh-subagent: MCP stdio server ready …`）：

```
[warning] [McpProcess stderr]   ERR dsh-subagent: MCP stdio server ready (bridge v…)
```

当前版本在正常启动路径下实现 `正常启动不往 stderr 写任何东西`，仅在发生异常时输出。排查问题时可设置环境变量 `DSH_SUBAGENT_DEBUG=1` 开启详细日志。

**Q: 任务返回结果为空？**
排查方式：检查任务目录中 `meta.json` 的 `stopReason` 与 `error` 字段，以及 `stderr.log` 文件末尾输出。若出现 `DSH 进程退出码 N`，通常为模型配置或认证凭据异常。

**Q: 子代理提示命令已执行但未产生实际效果？**
排查方式：检查返回内容末尾是否包含 `⚠️ 执行面告警`。若存在，说明当前权限等级导致 Shell 命令被沙箱吞没（详见 §5.1），需改用 `permission: "danger-full-access"` 执行。

**Q: 子代理返回文件为乱码或二进制数据？**
排查方式：检查该文件是否可由外部进程正常读取，确认运行环境中的文件过滤或拦截策略是否对多进程读写产生影响。

**Q: 任务因超时被中断？**
排查方式：`status: deadline` 表示超出预估时间（需调整 `expected_seconds` 或拆分任务）；`status: timeout` 表示达到外层 `timeout_seconds` 上限；`status: stalled` 表示看门狗检测到长时间无进展（详见 §6.2）。同时应确认外部客户端的工具调用超时配置（如 `MCP_TOOL_TIMEOUT`）。

**Q: 如何切换模型？**
- 查询可用模型：通过 `dsh_health` 的 `models.providers`（即 `dsh_health.models`）查看当前实例已接入的模型列表（源自 `$DSH_HOME/settings.yaml`）。
- 编辑策略文件：修改 `~/.dsh/subagent/config/model-policy.md`，调整默认模型或预设方案（`modelPolicy`），修改后即时生效。
- 单次任务指定：在 `dsh_task` 中传入 `model`、`provider` 与 `reasoning_effort` 参数（如 `dsh_task(model: "gemini-3.7-flash", provider: "my-gateway", reasoning_effort: "high")`）或通过 CLI 执行 `dsh-subagent -m <模型 id>`。参数无效时将直接报错（`UNKNOWN_MODEL` / `NO_ADAPTER` / `UNSUPPORTED_REASONING_EFFORT`）。可通过调用 `dsh_setup(default_model: "…")` 或 `dsh_setup(preset: "本项目方案")` 修改默认配置。
- 全局修改：在 DSH 桌面设置中修改默认模型。

**Q: 外部任务能否递归创建子代理？**
不能（参见 §4.1 叶子限制）。外部调用的子代理工具表中已停用 `subagent`、`subagent_fork`、`workflow`、`ralph` 等分派工具。如需恢复，可修改 `profile/cordis.patch.yml` 并重新执行 `node install.mjs --only profile`。

**Q: 父任务结束后后台运行的子代理如何查看？**
查看方式：DSH 宿主在父会话结束后不会终止后台子代理进程。可在悬浮卡片的「本机 DSH 子代理 ✦」分组中查看带有 `L1/L2/L3` 标记的子代理运行状态与进度。

---

## 9. 目录与文件结构速查

```
~/.dsh/subagent/
├── README.md                 本文档
├── install.mjs               幂等装配器(--dry-run / --only=…)
├── uninstall.mjs             摘除所有 harness 里的 dsh 注册
├── profile/                  DSH profile 源文件(install 会同步到 $DSH_HOME/profiles/subagent)
├── config/
│   └── model-policy.md       模型策略(**用户可以随便改**:默认模型 + 预设方案 + 模型选择规则;dsh_setup 落盘到这里)
├── lib/
│   ├── launcher.mjs          定位并解析本机 dsh 启动器(直接 spawn exe,绕开 cmd 转义)
│   ├── tasks.mjs             任务生命周期:启动 / 等待 / 查询 / 取消 / 强杀 / 硬截止 / 停滞看门狗 / 并发上限
│   ├── mcp.mjs               MCP stdio server 与六个工具的实现在此(工具定义里的委派手册也在这)
│   ├── monitor-host.mjs      监控窗口自动拉起(三步判活:心跳+pid 存活 / 残留不采信 / 命令行分类拦第二个 GUI)
│   └── util.mjs              路径、JSON、裁剪、进程存活等小工具
├── bin/
│   ├── dsh-subagent.mjs      CLI:任何 harness 都能 shell 调用
│   └── dsh-subagent-mcp.mjs  MCP server 入口
├── test/
│   ├── selftest.mjs          协议级端到端自检(102 项:含模型枚举规则、策略文件链接与预设、首次接入引导块、dsh_setup 落盘/拒绝路径、隔离 DSH_HOME 的 decoy、生命周期留痕)
│   ├── monitor-autostart-probe.mjs 监控窗口自动拉起自检(26 项,假 exe + 临时 DSH_HOME)
│   ├── ledger-liveness-probe.mjs   台账残留记录自检(20 项,临时 DSH_HOME 造假台账)
│   ├── e2e-harness.mjs       验收脚本:让每个 harness 自己委托一次并核对产物
│   ├── concurrency-probe.mjs 并发(N 路同时委托)+ 取消验证
│   ├── tasks-probe.mjs       只验任务层的小烟测
│   ├── session-perm-probe.mjs 解开某个会话日志,打印它**实际生效**的权限事实
│   ├── panel-selftest.mjs    悬浮卡片逻辑自检(离线 138 项)
│   ├── observer-selftest.mjs GUI 观察器自检(49 项,含心跳+规则版本、残留记录收尾、pid 宽限期、token 折叠、吞吐窗口、只读转录、0.1.5 新日志名)
│   ├── exec-surface-probe.mjs 执行面自检脚本(11 项:会话日志改名兼容 + 沙箱"空转成功"的判定与零误报)
│   ├── live-audit.mjs        活跃审计:真在跑/残留记录/没记 pid/宿主状态/最近任务耗时(--fix 订正残留记录)
│   ├── monitor-live-probe.mjs 真心跳 + 真 dsh_task:验 already-running 分支,并确认不重复拉起 GUI
│   ├── usage-fold-probe.mjs  真实任务日志 → token 用量折叠(逐帧解 zstd,验底部状态条的数据源)
│   ├── leaf-only-probe.mjs   叶子自检脚本(14 项:配置级 7 条检查项 + 会话日志里的真实工具表)
│   ├── launcher-heal-probe.mjs 入口自愈自检脚本(13 项:入口失效自愈 / 回退到下一个候选 / 全失效时聚合报错 / app.asar↔app 互换)
│   ├── gui-graph-probe.mjs   客户端插件启动图自检脚本(真起一个 web 实例)
│   ├── live-probe.mjs        两采样进度自检脚本(判断任务是否真的在动)
│   └── dump-session.mjs      解压查看某个 DSH 会话事件时间线
└── state/
    ├── tasks/<job-id>/       每次委托的完整现场
    └── selftest-report.json  最近一次自检报告
```

---

## 10. 测试与验收实测数据

端到端测试执行命令：`node test/e2e-harness.mjs <工作空间>`（依次驱动 Claude Code、Codex、Cursor 分派任务并校验生成结果）。

实测记录（测试工作目录 `D:\dsh-subagent-selftest`）：

| 测试链路 | 调用方式与命令 | 验证结果 |
| --- | --- | --- |
| Claude Code → `mcp__dsh__dsh_task` | `claude -p … --allowedTools mcp__dsh…` | ✅ 6.1s，生成产物 `e2e-claude-*.txt` |
| Claude Code 子代理 → DSH | `Task(subagent_type: "dsh")` | ✅ 生成产物 `subagent-claude-*.txt` |
| Codex → `mcp__dsh__dsh_task` | `codex exec …` | ✅ 12.5s，生成产物 `e2e-codex-*.txt` |
| Cursor → `mcp__dsh__dsh_task` | `cursor-agent -p --force --approve-mcps` | ✅ 6.0s，生成产物 `e2e-cursor-*.txt` |
| 命令行工具直接调用 | `dsh-subagent -w <dir> "…"` / `--json` | ✅ 5.5s，标准输出返回 DSH 结果 |
| 直接调用 DSH Profile | `dsh --profile subagent --prompt-stdin` | ✅ 1.2s，退出码 0 |
| 协议层自动化测试 | `node test/selftest.mjs` | ✅ 54/54 项全绿（涵盖 caller / `expected_seconds` 必填校验与 `isError:true` 拒绝、强制终止、失效记录 `stale` 标记、`initialize.instructions`、工具定义说明、`monitor_host` 联动、标准错误静默、版本号一致性及 `DSH_SUBAGENT_DEBUG` 开关） |
| 并发任务分派 | `node test/concurrency-probe.mjs <ws> 3` | ✅ 3 路并发耗时 14.6s 全部成功；取消功能正常 |
| 截止时间保护 | `expected_seconds=10`，执行 300s 任务 | ✅ 记录 `status: "deadline"`，返回 `error: 超出预估时间 10s × grace 1.5 仍未完成,已终止`，进程正常终止 |
| 停滞看门狗（真实挂起） | 进程树完全静止（根进程等待 `waitpid`） | ✅ 判定为 `status: "stalled"`，保存 `treePids` / `treeCpuMs` / `signalState` 取证数据 |
| 停滞看门狗（六进程树挂起） | `powershell → bash → bash → node hang.mjs → node(600s sleep)`，日志 4823B 冻结 122 秒，进程树为 `powershell.exe → bash.exe → bash.exe` | ✅ 判定为 `status: "stalled"`（`silentProbes: 2`、`silenceSeconds: 73`、`treeCpuMs: 1078`），通过 CPU 强度下限准确识别空转噪声 |
| 停滞看门狗对照实验（关闭 CPU 强度下限） | 相同六进程树，`stderr` 自 +24s 起冻在 1439 字节，日志冻结约 590 秒，CPU 增量 `cpuDeltaMs` 为 0~188ms | ❌ 未能识别停滞：小幅 CPU 增量导致采样计数归零，`stalledProbes` 循环重置，最终误判为 `status:"ok"`（退出码 1），验证了设置下限阈值的必要性（见 §6.2） |
| 停滞看门狗（长耗时正常任务） | 连续执行 30 次 `Start-Sleep 2`，进程树 CPU 持续增加 | ✅ 未被误杀，任务正常返回 `status: ok` |
| 监控窗口自动启动 | `node test/monitor-autostart-probe.mjs` | ✅ 27/27 项测试通过：心跳有效且 PID 存活时不重复启动（`already-running`）；心跳过期或 PID 不存在时执行拉起（`launched`）；开关关闭时跳过（`skipped`）；检测到已有图形宿主进程时不重复启动（`gui-open-old-observer`）；真实 `--expose-internals` 判定为 `dsh-cli`；`FORCE=1` 强制启动生效 |
| 监控窗口自动启动（端到端链路） | 真实 MCP 服务调用 `dsh_task`（`HOST_CHECK=off`） | ✅ 结果返回 `monitor_host: launched(心跳缺失/过期)`，生成标记文件并在 `monitor-host.log` 记录 `reason=dsh_task <job_id>`，任务返回 `status: ok` |
| 监控窗口自动启动（本地真实环境） | 默认配置运行 | ✅ 心跳文件不存在时检测到已有宿主进程 `guiHosts=[45148]`，状态标记为 `state=host-older-observer` 与 `gui-open-old-observer`，避免重复启动窗口 |
| 任务台账状态修正 | `node test/ledger-liveness-probe.mjs` | ✅ 21/21 项测试通过：失效记录准确标记为 `status:lost` 与 `stale:true`；存活任务标记为 `running` 与 `pidAlive:true`；`killByCaller` 仅终止实际存活进程并将失效记录放入 `stale` 列表，重复执行返回 `notFound:true`；`killTreeSync` 对无效 PID 如实报告失败 |
| 悬浮面板底部状态汇总 | `node test/panel-selftest.mjs`（138 项） | ✅ 格式为 `517/12.2K/517K/1.2M`；部分命中不四舍五入为 100%；支持宿主投影（`tokenUsage`）与观察器日志（`meta.usage`）两种数据源；速率依据观察器 `tokensPerSecond` 渲染，底部按 `tok/s \| 缓存命中 % \| 输入 N tok · 输出 M tok` 格式展示 |
| 会话日志 Token 折叠 | `node test/usage-fold-probe.mjs --all` | ✅ 解析 1282 帧日志（36 次调用，`chunk.type=usage` 与 `data.usage` 各 36 次）：同轮次替换生效，计算结果为输入 92103、输出 50207、缓存读 1949440、命中率 95.5% |
| 吞吐速率统计逻辑 | `node test/observer-selftest.mjs`（49 项） | ✅ `2 秒里跳 6000 token` 不产生速率，`跨 29 秒的 6000 token` 准确计算为约 207 tok/s；无输出增量时不显示速率；采样窗口取最近 4 次平均值，日志增长时投影输出 `tokensPerSecond` 且 `< 2000`；心跳携带 `usageRate` 字段 |
| 面板布局与交互测试 | `node test/panel-selftest.mjs` | ✅ 验证三处调节手柄（`data-axis=x,y,xy`）、光标样式（`cursor: ew-resize/ns-resize`）、自定义宽高变量（`--sap-w` / `--sap-h` 与 `width: var(--sap-w, 300px)`、`height: var(--sap-h, auto)`）、多列网格排列（`repeat(auto-fill, minmax(132px, 1fr))`）、内容滚动样式（`.sap-root[data-sized="true"] .sap-body { max-height: none }` 与 `.sap-root[data-sized="true"] .sap-body`）、头部折行样式（`flex-wrap: wrap` 与 `flex: none`、`white-space: nowrap`）及空状态居中样式（`justify-content: center` 与「无活跃子代理」文案） |
| 启动图与 Bundle 缓存 | `node test/gui-graph-probe.mjs <临时实例 URL>` | ✅ 10/10 项通过：插件注入 `__DSH_BOOT__`，包含 `sap-grip`、`auto-fill`、`flex-wrap`、`自由缩放`、`无活跃子代理` 等新版代码（旧文案 `雷达静默` 与旧算法 `throughputOf` 为 false），响应头包含 `cache-control: public, max-age=31536000, immutable` |
| 本地台账记录检查 | `dsh-subagent --list`（即 `CLI --list` 与 `--list` 参数） | ✅ 检查 134 条历史记录：所有条目均包含 `stale` / `pidAlive` / `derived` 标记，不存在异常运行中记录（已通过 `live-audit --fix` 将 5 条修正为 `lost`） |
| 强制终止功能 | `dsh_task_kill {caller}` | ✅ 成功终止指定调用方的 2 个运行中任务，重复终止已结束任务返回无需终止提示 |
| 注册状态验证 | `claude mcp list` / `codex mcp list` | ✅ 均显示 Connected 或 enabled |
| 宿主界面可见性 | 会话记录位于对应工作空间目录（如 `--D-work-demo--`） | ✅ 运行中文件持续增长（25秒内由 38KB 增至 89KB），会话在列表中正常展示 |
| DSH 0.1.5-rc.1 适配回归测试 | 7 个自检脚本 | ⚠️ 适配前出现多项测试失败：`selftest`（43/51）、`leaf-only-probe`（14/15）、`monitor-live-probe`（7/8） |
| 修复后回归测试 | 9 个自检脚本 | ✅ **296/296 项全绿**：panel 117、selftest 54、observer 35、autostart 26、ledger 20、leaf 14、exec-surface 11、**wait-policy 11**、monitor-live 8 |
| 启动器入口自愈测试（0.1.6） | `node test/launcher-heal-probe.mjs` + 10 个测试脚本 | ✅ **309/309 项全绿**：覆盖入口路径变更自动修正为 `resources\app\lib\desktop-cli.js`、首个候选失效自动回退至第二候选、全候选失效聚合报错、`app.asar` 与 `app` 路径互换等 13 项新增检查；入口失效导致 `Cannot find module` 时执行自愈 |
| 动态指定模型与推理强度（0.1.7） | MCP 服务器实测（包含 `reasoning_effort=low`、错误模型、错误档位、类型校验）+ `npm run test:all` | ✅ **315/315 项全绿**：指定 `reasoningEffort:"low"` 与 `model=deepseek-v4.1-flash` 正确传递至任务元数据；指定未知模型返回 `UNKNOWN_MODEL`（474ms 快速返回且 `result.txt` 0 字节）；指定不支持档位返回 `UNSUPPORTED_REASONING_EFFORT`（557ms）；非字符串类型返回 `isError:true` 拒绝执行并指明错误参数名；工具结果头部回显 `reasoning_effort: <值>` |
| 推理强度固定为 high（§3.1） | `dsh --profile subagent --reasoning-effort high` 测试 | ✅ 声明档位后正常退出并记录 `reasoningEffort: "high"`；网关测试显式 `high` 消耗 `reasoning_tokens=35`（未声明时消耗 `reasoning_tokens=103`）；配置错误时直接报错（`NO_ADAPTER`） |
| 执行等待策略验证（§2.3） | `node test/wait-policy-probe.mjs` | ✅ 11/11 项通过：默认 `defaultWaitSeconds=45` 与 `statusWaitSeconds=30` 且均小于 60；不传 `wait_seconds` 时短任务在 3.5 秒内直接返回 `status: ok` 无需轮询；`DSH_SUBAGENT_WAIT_SECONDS=5` 时超时任务正确返回 `status: running` 并提示 `dsh_task_status(job_id="…", wait_seconds=30)` 轮询；`dsh_task_status` 不传 `wait_seconds` 时自动等待 20.7s 至终态 |
| 受限模式 Shell 空转测试（§5.1） | 三种权限模式实测对比与日志比对 | ✅ `danger-full-access` 正常返回命令输出；`workspace-write` 与 `read-only` 返回空文本且 `isError:false` |
| 空转检测准确率 | 真实会话日志执行 `detectHollowShellCalls` | ✅ 准确检测出 11 次受限空转调用并提取命令内容，全权限日志检测出 0 次，无误报 |
| 会话日志命名兼容性 | `node test/exec-surface-probe.mjs` + `observer-selftest` | ✅ 适配 `session*.jsonl.zstd` 命名规则并优先解析 `session.v3.jsonl.zstd` 格式日志 |
| 请求取消联动测试 | 任务轮询期间发送 `notifications/cancelled` | ✅ 7/7 项通过：任务转为 `cancelled` 状态，请求立即返回，子进程实际终止（通过 `process.kill(pid,0)` 校验），服务正常退出 |
| 桥接层集成测试 | `node test/monitor-live-probe.mjs` 真实调用 | ✅ 4.9 秒完成，产物正常生成，观察器记录 `running=true job=20260911-124736-5c6cbc3c` |
| Profile 命令行直接调用 | `dsh --profile subagent --prompt "…"` | ✅ 1.2 秒完成，返回 `stopReason: completed`，输出答复 |
| 配置行 ID 兼容性审计 | 检查 `app.asar` 中的 12 处 Patch 行 ID | ✅ 12 处配置行均存在，已同步 `tool-subagent-report`（`subagent-report`）的变更（变更为协议消息 kind） |
| 客户端注入点兼容性审计 | 检查 Web 实例打包脚本（11.2MB） | ✅ 6 处注入点均有效（`shell.overlay` / `subagentsByParent` / `projectionValues` / `sessions.open` / `useSessions` / `__ModuleLoader__`），启动图 10/10，加载卡片版本 `36bac599d008e66e-45` |
| 上游 LSP 插件问题影响分析 | 分析 `desktop` profile `--dump-config` 与宿主日志 | ✅ 确认桌面宿主不受影响（无 `lsp-stdio` 与 `tool-lsp`，无 `assertNever` 报错），提供 Web Profile 禁用配置 |
| 标准错误输出静默验证 | 验证 Cursor `mcpprocess.log` | ✅ 正常启动路径下标准错误输出为 0 字节，消除无意义的连接告警；设置 `DSH_SUBAGENT_DEBUG=1` 时才输出版本横幅 |
| 模型参数限制与校验收敛 | 执行 `npm run test:all` | ✅ 61/61 项全绿，验证工具描述与参数定义的一致性 |
| 悬浮卡片显示实际生效模型 | `node test/observer-selftest.mjs`（49 项） + `node test/panel-selftest.mjs`（138 项） | ✅ 测试全绿（0 ❌）：投影优先读取 `meta.json` 中的实际生效模型，无记录时回退至 `task.json`；卡片列表行展示模型 chip，详情页展示服务商与推理强度，旧数据兼容显示为默认 |
| 预览窗口只读显示子代理对话 | `node test/observer-selftest.mjs`（49 项） + `node test/panel-selftest.mjs`（138 项） | ✅ 测试全绿（0 ❌）：观察器与 Token 用量同一趟折叠会话日志，产出「用户 / 助手 / 调用 / 返回」四类转录（推理块不进预览，空返回标成 `(空返回)`），按 60 条与 6000 字封顶后随投影下发；预览窗只渲染 `role` 与 `text`，没有任何写入口，有转录时不再退回 `stderr.log` 尾部 |
| 动态模型管理策略体系 | `npm run test:all`（10 个测试脚本，包含 `test:all` 组合调用） | ✅ **392/392 项全绿**（`selftest.mjs` 包含 102 条断言）：模型列表动态从 `$DSH_HOME/settings.yaml` 解析，从 `llm-pi-ai.providers.<route>.models` 获取，策略文件 `config/model-policy.md` 支持用户自定义与预设方案（`modelPolicy.path` / `fileUrl` / `presets`），未配置时输出初始化引导，执行 `dsh_setup(default_model:)` 写入配置后引导自动关闭，非法参数准确返回 `isError:true` 拒绝处理，短任务正常返回 `status=ok` |
