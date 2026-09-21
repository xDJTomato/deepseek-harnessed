# 配置参考

本文档列出桥接层与相关组件的完整配置项，涵盖三个模块：**桥接层运行参数**、**DSH `subagent` profile 配置**与**宿主扩展插件（观察器与悬浮面板）**。所有环境变量均与代码实现逐项对应。

---

## 1. 桥接层与任务行为

以下环境变量在**调用方工具的运行环境**中配置（即运行 `dsh_task` 的 MCP 服务器进程所继承的环境变量）。

### 1.1 任务生命周期

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `DSH_SUBAGENT_WAIT_SECONDS` | `30` | `dsh_task` 的默认阻塞等待时间（秒）。超时后返回 `status: running` 及 `job_id`，转由调用方轮询 |
| `DSH_SUBAGENT_DEADLINE_GRACE` | `2` | 截止时间宽限系数，计算公式：`deadlineAt = startedAt + expected_seconds × grace`。超时将终止进程树并记录 `status: "deadline"` |
| `DSH_SUBAGENT_TIMEOUT_SECONDS` | `1800` | 最外层绝对超时时间（秒），作为兜底限制条件与预估截止时间同时生效 |
| `DSH_SUBAGENT_TASK_TIMEOUT` | — | `DSH_SUBAGENT_TIMEOUT_SECONDS` 的别名 |
| `DSH_SUBAGENT_MAX_CONCURRENCY` | `4` | 单个 MCP 服务进程的最大并发任务数；超出限制的任务将进入队列排队（状态可通过 `dsh_health` 中的 `activeByCaller` 查询） |
| `DSH_SUBAGENT_RESULT_CLIP` | `60000` | 回传给调用方工具的最终文本字数上限 |
| `DSH_SUBAGENT_ACTIVITY_CLIP` | `1800` | 状态轮询返回的最近活动日志（`recent_activity`）字数上限 |
| `DSH_SUBAGENT_STDIN_LIMIT` | — | 通过标准输入传递提示词的最大字节数限制 |

### 1.2 工作空间、启动器与执行权限

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `DSH_SUBAGENT_WORKSPACE` | 调用方工作区 → server cwd | 未在参数中显式指定 `workspace` 时使用的默认目录 |
| `DSH_SUBAGENT_DSH_SHIM` | 自动解析 | 显式指定 `dsh` 启动脚本（`dsh.cmd`）的绝对路径，用于自动解析失败时的路径指定 |
| `DSH_SUBAGENT_PERMISSION` | `danger-full-access` | 子代理默认权限等级，可选值：`read-only` / `workspace-write` / `danger-full-access`（支持通过 `/` 分隔选项）。该值决定沙箱模式与权限预设 |
| `DSH_PERMISSION_MODE` | — | `DSH_SUBAGENT_PERMISSION` 的兼容别名 |
| `DSH_SUBAGENT_DEBUG` | — | 设置为 `1` 时输出桥接层内部调试日志至标准错误 |

### 1.3 停滞看门狗配置

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `DSH_SUBAGENT_WATCHDOG` | 开启 | 设置为 `off` 时关闭停滞检测机制 |
| `DSH_SUBAGENT_WATCHDOG_INTERVAL` | `30` | 采样检测周期（秒），每轮采集日志与进程树快照 |
| `DSH_SUBAGENT_STALL_PROBES` | `2` | 静默窗口期内连续判定为无进展的采样次数阈值 |
| `DSH_SUBAGENT_STALL_MIN_SECONDS` | `180` | 触发停滞判定的最小静默时间（秒），防止模型慢速推理被误终止 |
| `DSH_SUBAGENT_STALL_CPU_MS` | `200` | 进程树累计 CPU 时间增量达到该毫秒数即判定为有进展 |
| `DSH_SUBAGENT_STALL_CPU_WORK_FLOOR_MS` | `1500` | 静默窗口期内进程树 CPU 增长下限值（毫秒）；低于该值视为调度噪声而非实际工作 |
| `DSH_SUBAGENT_TREE_PROBE_TIMEOUT_MS` | `15000` | 单次执行 `Get-CimInstance` 采集进程快照的超时时间（毫秒） |
| `DSH_SUBAGENT_PS` | 系统 PowerShell | 自定义进程快照所使用的 `powershell.exe` 路径 |

停滞判定采用多信号综合比对：日志字节未增加、后代进程无变动、进程树 CPU 无增长三项条件同时满足时才判定为停滞。单项无输出不会误判正常运行的长耗时命令。

### 1.4 监控窗口自动拉起配置

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `DSH_SUBAGENT_AUTOSTART_MONITOR` | 开启 | 设置为 `off` / `0` / `false` 时禁用调用 `dsh_task` 自动启动监控界面的行为 |
| `DSH_SUBAGENT_MONITOR_COOLDOWN_MS` | `60000` | 自动启动尝试的冷却间隔（毫秒），同时作为进程列表采样的缓存有效期 |
| `DSH_SUBAGENT_MONITOR_HEARTBEAT_MS` | `20000` | 心跳超时时间（毫秒），超过该时间判定为无活跃监控宿主 |
| `DSH_SUBAGENT_MONITOR_HOST_CHECK` | 开启 | 设置为 `off` 时关闭检测到已有宿主则跳过启动的限制条件（用于测试环境） |
| `DSH_SUBAGENT_MONITOR_HOST_PROCESS` | `DSH Desktop.exe` | 进程枚举与分类时匹配的进程映像名称 |
| `DSH_SUBAGENT_MONITOR_FORCE` | — | 设置为 `1` 时强制跳过宿主存在性检查 |
| `DSH_SUBAGENT_MONITOR_CMD` | — | 自定义需要拉起的可执行文件路径 |
| `DSH_SUBAGENT_MONITOR_ARGS` | — | 启动可执行文件时追加的参数列表（JSON 数组或以空格分隔的字符串） |
| `DSH_SUBAGENT_HOST_PROBE_TIMEOUT_MS` | `15000` | 宿主进程查询（`Get-CimInstance`）单次超时时间，失败时会自动重试一次 |

### 1.5 模型策略配置

可用模型列表由 DSH 实例自身提供（读取 `$DSH_HOME/settings.yaml` 中 `models` 数组声明的 ID），桥接层不硬编码模型标识。模型选择规则保存在用户可编辑的策略文件中，每次任务分派时实时读取。

| 配置项 | 说明与路径 |
| --- | --- |
| `DSH_SUBAGENT_POLICY` | 覆盖策略文件路径；默认路径为 `<桥接层根>/config/model-policy.md`（即 `~/.dsh/subagent/config/model-policy.md`） |
| 解析规则 | 程序解析第一行 `默认模型: <模型 id>`，以及各 `### <预设名>` 分组下的 `预设默认模型: <模型 id>` 行，其余正文为说明文本 |
| 未配置状态 | 策略文件中声明为 `默认模型: (未指定)` 时，`dsh_task` 与 `dsh_health` 返回引导说明（不超过 10 行） |
| 已注册模型列表 | 通过 `dsh_health` 的 `models.providers` 按服务商分组返回（仅解析 `llm-pi-ai.providers.<route>.models` 与 `llm-deepseek.models` 数组；解析失败时在 `models.error` 记录原因） |
| 访问路径与协议链接 | 通过 `dsh_health` 返回 `modelPolicy.path` 与 `fileUrl`（`file:///…` 格式） |

通过 `dsh_setup` 工具写入默认模型配置（仅更新 `默认模型:` 所在行）：

| 参数名称 | 参数语义与格式 | 错误处理行为 |
| --- | --- | --- |
| `default_model` | 已接入的模型标识，支持裸 ID（如 `deepseek-v4.1-flash`）或 `provider/id` | 传入未接入模型时返回 `isError:true` 并输出可用模型列表 |
| `preset` | 策略文件中声明的预设方案名称（如 `本项目方案`） | 传入未知名称时返回 `isError:true` 并输出可用预设列表 |
| `policy_markdown` | 整体替换策略文件的 Markdown 内容 | 内容中缺少 `默认模型:` 声明行时返回 `isError:true` |

若参数类型错误（例如传入 `default_model: 3`），工具将返回 `isError:true` 并明确指出错误参数名。修改环境变量需重启对应的外部工具进程；直接修改策略文件内容无需重启即可生效。

---

## 2. DSH `subagent` profile 结构

Profile 配置文件位于 `profile/cordis.patch.yml`（安装后部署至 `$DSH_HOME/profiles/subagent/`），包含七项针对无人值守模式的插件调整：

| 序号 | 调整内容 | 技术原因 |
| --- | --- | --- |
| 1–2 | 停用 `headless-startup` 与 `headless-runner`，替换为 `subagent-startup.js` 与 `subagent-runner.js` | 官方 headless 模式仅支持命令行参数；子代理需要支持 `--prompt-file`、`--result-file`、`--metadata-file`、`--model`、`--reasoning-effort`，并输出结构化结果与运行元数据 |
| 3 | 停用 `session-title-llm` | 无人值守任务无需生成会话标题，减少一次模型调用与耗时 |
| 4 | 设置 `approval.policy: never` | 子代理为非交互式后台进程，无人工确认交互界面 |
| 5 | `sandbox-policy.mode` 由 `DSH_SUBAGENT_PERMISSION` 决定 | 外部工具调用默认拥有操作权限；需要限制时可设置为 `read-only` 或 `workspace-write` |
| 6 | 显式配置无人值守权限预设表 | 避免预设不匹配导致启动失败，详见下文分析 |
| 7 | 停用所有子代理递归分派工具 | 施加叶子节点执行限制，详见 §2.2 |

`sandbox-policy` 中的 `workspaceRoot` 设为 `process.cwd()`，子代理的工作目录与其启动时的工作空间路径严格一致。

### 2.1 权限预设必须逐字对齐的原因

`dsh-permission-presets` 在初始化时校验 `(沙箱模式, 审批策略)` 组合，若未匹配到对应预设将抛出异常：

```
composed sandbox and approval defaults match no preset
```

该异常导致插件加载中断，子进程在初始化阶段以退出码 1 异常终止。测试表明使用 `--permission workspace-write` `必崩)。原因是` `dsh-base` `自带的预设表把` `workspace-write` 与 `read-only` 默认配置为 `approval: ask`，而子代理 profile 将审批策略固定为 `never`：

| 组合模式 | 内置预设表匹配状态 | 执行结果 |
| --- | --- | --- |
| `danger-full-access` + `never` | 成功匹配 | 正常运行 |
| `workspace-write` + `never` | 无匹配项 | 启动失败 |
| `read-only` + `never` | 无匹配项 | 启动失败 |

因此 profile 显式定义完整预设表，为三种模式均配置 `approval: never`，并使 `defaultPreset` 与 `sandbox-policy.mode` 共享同一环境变量。超出权限的操作由沙箱直接拒绝，不进行挂起等待。

### 2.2 叶子限制：禁止外部任务派发子任务

外部工具通过 `dsh_task` 调用的任务不允许再次派发子代理。Profile 禁用了以下工具插件：

```
tool-subagent                subagent(同进程子代理)
tool-subagent-fork           subagent_fork(继承上下文的子代理)
tool-workflow                workflow(脚本里 agent() 扇出 = 批量分叉)
workflow-worker-thread       workflow 的 worker 线程
tool-ralph                   ralph(每轮开一个新子代理)
tool-subagent-control        list_agents / send_message / interrupt_agent
tool-subagent-list-agents
```

该配置仅禁用工具层，保留底层服务（`subagent`、`subagent-spawn-in-process`、`subagent-fork-in-process` 仍保持加载），避免依赖这些服务的插件加载失败。

> 注意：此限制仅作用于进程内工具调用。测试脚本 `test/leaf-only-probe.mjs` 会解压会话日志核实工具列表是否生效。

---

## 3. 宿主插件配置

### 3.1 状态观察器（`monitor/observer.mjs`）

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `DSH_SUBAGENT_OBSERVER_INTERVAL` | `2000` | 状态轮询周期（毫秒） |
| `DSH_SUBAGENT_OBSERVER_ANNOUNCE_AGE_MS` | `600000`（10分钟） | 仅推送运行中或最近结束的任务的时间窗口 |
| `DSH_SUBAGENT_OBSERVER_REANNOUNCE_MS` | `20000` | 运行中任务状态重播间隔，确保前端刷新后恢复状态 |
| `DSH_SUBAGENT_OBSERVER_MAX_AGE_MS` | `43200000`（12小时） | 任务记录的最大回溯时间范围 |
| `DSH_SUBAGENT_OBSERVER_PID_GRACE_MS` | `120000` | 未记录 PID 的运行中任务宽限期，超时后标记为失效记录 |
| `DSH_SUBAGENT_OBSERVER_USAGE_REFRESH_MS` | `5000` | 单个会话日志重新统计 Token 用量的最小间隔（毫秒） |
| `DSH_SUBAGENT_OBSERVER_ACTIVITY_MS` | `5000` | 数据变动触发提前重播的最小时间间隔 |
| `DSH_SUBAGENT_OBSERVER_RATE_MIN_MS` | `3000` | 计算处理速率（`tok/s`）的最小采样时间窗口，小于该窗口不计入速率 |
| `DSH_SUBAGENT_OBSERVER_RATE_SAMPLES` | `4` | 速率统计平滑处理的采样次数 |
| `DSH_SUBAGENT_OBSERVER_TRANSCRIPT_ENTRIES` | `60` | 只读预览的会话转录最多保留多少条（从最旧的开始丢弃） |
| `DSH_SUBAGENT_OBSERVER_TRANSCRIPT_CHARS` | `6000` | 只读预览的会话转录总字数上限（投影反复重发，必须封顶） |
| `DSH_SUBAGENT_OBSERVER_TRANSCRIPT_ENTRY_CHARS` | `600` | 只读预览的单条转录字数上限 |
| `DSH_SUBAGENT_OBSERVER_DEBUG` | — | 设置为 `1` 时输出每轮轮询日志 |

### 3.2 悬浮监控面板布局与交互

面板配置保存在浏览器的 `localStorage` 中（键名为 `dsh.subagent.panel.v1`）：

| 调节项 | 调节范围与默认值 | 操作方式 |
| --- | --- | --- |
| 界面缩放比例 | **60% ~ 200%**，步进 10%（拖拽调整时步进 5%） | 点击顶部 `−` / `+` 按钮，点击百分比重置为 100% |
| 窗口宽度 | ≥ 220px，默认 300px | 拖动**右侧**或**右下角**调节手柄 |
| 窗口高度 | ≥ 120px，默认自适应高度 | 拖动**底部**或**右下角**调节手柄 |
| 布局重置 | — | **双击任意调节手柄**恢复默认尺寸与缩放 |
| 显示位置 | 右上角，默认 `top: 64px; right: 18px` | 拖动顶部标题栏移动位置 |

面板网格布局使用 `repeat(auto-fill, minmax(132px, 1fr))`，卡片列数根据实际宽度自动排列；增加高度后内容区域支持滚动，顶部工具栏与底部状态栏保持固定。
