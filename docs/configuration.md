# 配置参考

三块配置:**桥接层(进程/任务行为)**、**DSH 侧 profile(子代理怎么跑)**、
**宿主插件(观察器 + 悬浮卡片)**。所有环境变量都来自源码实测(逐条 grep 出来的,不是推测)。

---

## 1. 桥接层与任务行为

在**调用方 harness 的环境**里设置(即 `dsh_task` 所在的 MCP server 进程继承的环境)。

### 1.1 任务生命周期

| 变量 | 默认 | 作用 |
| --- | --- | --- |
| `DSH_SUBAGENT_WAIT_SECONDS` | `30` | `dsh_task` 的默认阻塞窗口。超时返回 `status: running` + `job_id`,由调用方继续轮询 |
| `DSH_SUBAGENT_DEADLINE_GRACE` | `2` | 硬截止宽限系数:`deadlineAt = startedAt + expected_seconds × grace`。到点杀进程树并记 `status: "deadline"` |
| `DSH_SUBAGENT_TIMEOUT_SECONDS` | `1800` | **外层**绝对墙钟上限(比硬截止更宽松,两道闸门都生效) |
| `DSH_SUBAGENT_TASK_TIMEOUT` | — | 上面那个变量的别名 |
| `DSH_SUBAGENT_MAX_CONCURRENCY` | `4` | 单个 MCP server 进程的并发上限;超出会排队或拒绝(见 `dsh_health` 的 `activeByCaller`) |
| `DSH_SUBAGENT_RESULT_CLIP` | `60000` | 回传给 harness 的答复字数上限 |
| `DSH_SUBAGENT_ACTIVITY_CLIP` | `1800` | 活动流(`recent_activity`)回传上限 |
| `DSH_SUBAGENT_STDIN_LIMIT` | — | 提示词从 stdin 传入的大小上限 |

### 1.2 工作空间 / 启动器 / 权限

| 变量 | 默认 | 作用 |
| --- | --- | --- |
| `DSH_SUBAGENT_WORKSPACE` | 调用方工作空间 → server cwd | 没有显式 `workspace` 参数时的默认工作空间 |
| `DSH_SUBAGENT_DSH_SHIM` | 自动解析 | 显式指定 `dsh` 启动器(`dsh.cmd`)的路径。解析不到时唯一的救急开关 |
| `DSH_SUBAGENT_PERMISSION` | `danger-full-access` | 子代理默认权限档:`read-only` / `workspace-write` / `danger-full-access`。会同时决定沙箱模式与权限预设 |
| `DSH_PERMISSION_MODE` | — | 上面那个变量的兜底别名 |
| `DSH_SUBAGENT_DEBUG` | — | 设 `1` 打印桥接层调试日志 |

### 1.3 停滞看门狗(防止任务无限挂住)

| 变量 | 默认 | 作用 |
| --- | --- | --- |
| `DSH_SUBAGENT_WATCHDOG` | 开 | 设 `off` 整体关闭停滞探测 |
| `DSH_SUBAGENT_WATCHDOG_INTERVAL` | `30` | 探测间隔(秒);每轮采一次多信号快照 |
| `DSH_SUBAGENT_STALL_PROBES` | `2` | 静默窗口内**连续**多少次"所有信号零变化"才判停滞 |
| `DSH_SUBAGENT_STALL_MIN_SECONDS` | `180` | 判定停滞前的最小静默秒数(防"慢模型响应"被误杀) |
| `DSH_SUBAGENT_STALL_CPU_MS` | `200` | 进程树累计 CPU 增长多少毫秒才算"有进展" |
| `DSH_SUBAGENT_STALL_CPU_WORK_FLOOR_MS` | `1500` | 窗口内树 CPU 增长低于此值**不算"在干活"**:把 IO/定时器空转噪声与真正的工作区分开 |
| `DSH_SUBAGENT_TREE_PROBE_TIMEOUT_MS` | `15000` | 单次进程快照的 `Get-CimInstance` 超时 |
| `DSH_SUBAGENT_PS` | 系统 PowerShell | 覆盖进程快照所用的 `powershell.exe` 路径 |

> 停滞判定是**多信号**的:字节不涨、后代进程不变、树 CPU 不涨,三者**同时**静止才算停滞。
> 只靠"没输出"会误杀正在长时间思考或跑测试的子代理。

### 1.4 监控窗口自动拉起

| 变量 | 默认 | 作用 |
| --- | --- | --- |
| `DSH_SUBAGENT_AUTOSTART_MONITOR` | 开 | 设 `off`/`0`/`false` 关闭"调 `dsh_task` 时自动拉起监控窗口" |
| `DSH_SUBAGENT_MONITOR_COOLDOWN_MS` | `60000` | 两次自动拉起之间的最小间隔,防抖(也用作进程表探测的缓存窗口) |
| `DSH_SUBAGENT_MONITOR_HEARTBEAT_MS` | `20000` | 心跳多旧算"没有宿主在跑" |
| `DSH_SUBAGENT_MONITOR_HOST_CHECK` | 开 | 设 `off` 关掉"已有 GUI 宿主进程就跳过"的闸门(**测试逃生门**) |
| `DSH_SUBAGENT_MONITOR_HOST_PROCESS` | `DSH Desktop.exe` | 枚举/分类时要看的进程映像名 |
| `DSH_SUBAGENT_MONITOR_FORCE` | — | 设 `1` 强制忽略宿主闸门(手动逃生门) |
| `DSH_SUBAGENT_MONITOR_CMD` | — | 覆盖要拉起的可执行文件(测试用假 exe 就靠它) |
| `DSH_SUBAGENT_MONITOR_ARGS` | — | 追加参数(JSON 数组,或按空格拆分的字符串) |
| `DSH_SUBAGENT_HOST_PROBE_TIMEOUT_MS` | `15000` | 宿主进程枚举(`Get-CimInstance`)单次超时;失败会自动重试一次 |

### 1.5 模型策略(选择模型的口径)

模型清单来自 **DSH 自己**(`$DSH_HOME/settings.yaml` 里 `models` 数组声明的 id),桥接层不写死
任何模型;「什么时候用哪个模型」写在**用户可编辑的策略文件**里,每次调用重新读,改完不用重启。

| 项 | 值 |
| --- | --- |
| `DSH_SUBAGENT_POLICY` | 覆写策略文件路径;默认 `<桥接层根>/config/model-policy.md`(即 `~/.dsh/subagent/config/model-policy.md`) |
| 机器读哪几行 | 第一条 `默认模型: <模型 id>` 行;每个 `### <预设名>` 小节里的 `预设默认模型: <模型 id>` 行。其余正文不解析 |
| 未指定 | 写成 `默认模型: (未指定)` ⇒ `dsh_task` / `dsh_health` 的返回值会各带一段「首次接入」引导(≤10 行) |
| 已接入模型 | `dsh_health` 的 `models.providers`(按 provider 分组;只认 `llm-pi-ai.providers.<route>.models` 与 `llm-deepseek.models` 的方括号数组;枚举不到时把原因写进 `models.error` 而不是崩) |
| 路径与链接 | `dsh_health` 的 `modelPolicy.path` / `fileUrl`(`file:///…` 形式的绝对路径) |

三种落盘方式(`dsh_setup`,**只改 `默认模型:` 那一行**):

| 参数 | 语义 | 写错会怎样 |
| --- | --- | --- |
| `default_model` | 已接入的模型,裸 id(如 `deepseek-v4.1-flash`)或 `provider/id` | `isError:true` 并列出可用模型清单 |
| `preset` | 策略文件里已有的预设名(如 `本项目方案`) | `isError:true` 并列出可用预设 |
| `policy_markdown` | **整体替换策略文件正文**(谨慎) | 正文里没有 `默认模型:` 行 ⇒ `isError:true` |

> 参数类型不对(如 `default_model: 3`)同样是 `isError:true` **并点名参数名**。
> 环境变量覆写(含 `DSH_SUBAGENT_POLICY`)要重启对应 harness 才生效 —— MCP server 是它在
> 启动时拉起的常驻进程;但**策略文件的内容改完立刻生效**(每次调用都重读)。

---

## 2. DSH 侧:`subagent` profile

文件:`profile/cordis.patch.yml`(安装后落在 `$DSH_HOME/profiles/subagent/`)。
它替换/关闭了七组插件 row,每一组都有明确原因:

| # | 动作 | 为什么 |
| --- | --- | --- |
| 1–2 | 关掉 `headless-startup` / `headless-runner`,换成自己的 `subagent-startup.js` + `subagent-runner.js` | 原生 headless 只认 argv;我们需要 `--prompt-file` / `--result-file` / `--metadata-file` / `--model` / `--reasoning-effort`,并且要能写结果文件与元数据 |
| 3 | 关掉 `session-title-llm` | 无人查看标题,省一次模型调用和几秒时延 |
| 4 | `approval.policy: never` | 子代理是非交互进程,**没有人能点「同意」** |
| 5 | `sandbox-policy.mode` 由 `DSH_SUBAGENT_PERMISSION` 决定 | 调用方本来就是有写权限的 harness;需要收紧时用 `read-only` / `workspace-write` |
| 6 | 显式声明一张「无人值守」权限预设表 | 见下面的坑 |
| 7 | 关掉所有"能造出更多 agent"的工具 | 叶子闸门,见 §2.2 |

> `sandbox-policy` 的 `workspaceRoot` 取 `process.cwd()` —— 也就是说**子代理的工作空间就是
> 它被启动时的工作目录**,由桥接层按 `workspace` 参数设好。

### 2.1 权限预设为什么必须逐字对齐

`dsh-permission-presets` 在构造时会校验 `(沙箱模式, 审批策略)` 组合,推导不出预设就直接抛:

```
composed sandbox and approval defaults match no preset
```

整棵插件树加载失败,子进程**在 agent 起来之前**就以退出码 1 结束(实测 `--permission
workspace-write` 必崩)。原因是 `dsh-base` 自带的预设表把 `workspace-write` / `read-only`
配成 `approval: ask`,而本 profile 把审批固定成 `never`:

| 组合 | 自带表 | 结果 |
| --- | --- | --- |
| `danger-full-access` + `never` | 命中 | ✔ 所以默认档一直能跑 |
| `workspace-write` + `never` | 无表项 | ✘ 崩 |
| `read-only` + `never` | 无表项 | ✘ 崩 |

所以 profile 里**显式声明整张表**,三种模式都配 `approval: never`,并且
`defaultPreset` 与 `sandbox-policy.mode` 取同一个环境变量,保证两者永远一致。
语义上这也是对的:没有人类可以点同意,越界操作应当被沙箱**直接拒绝**,而不是挂起等审批。

### 2.2 叶子闸门:外部任务不许再分派子代理

由**外部调用方**经 `dsh_task` 调进来的任务不允许再分叉。profile 关掉的是这些**工具**:

```
tool-subagent                subagent(同进程子代理)
tool-subagent-fork           subagent_fork(继承上下文的子代理)
tool-workflow                workflow(脚本里 agent() 扇出 = 批量分叉)
workflow-worker-thread       workflow 的 worker 线程
tool-ralph                   ralph(每轮开一个新子代理)
tool-subagent-control        list_agents / send_message / interrupt_agent
tool-subagent-list-agents
```

只关**工具**,不关服务(`subagent` / `subagent-spawn-in-process` / `subagent-fork-in-process`
保持加载):没有工具就没有调用者,但关服务会让 inject 这些服务的插件加载失败,风险大收益小。

> ⚠️ **这条闸门只管进程内的分叉通道。** DSH 自己内部派活走的是原生 subagent(桌面 profile),
> 不受影响;另外任何有 shell 的 agent 都能自己起一个 dsh 进程,那属于"本来就有终端权限"的
> 范畴,不作为可执行边界来承诺(任务现场与审计仍完整落盘)。
> 自检 `test/leaf-only-probe.mjs` 会**解出真实会话日志里的工具表**来验证闸门真的生效。

---

## 3. 宿主插件:观察器与悬浮卡片

### 3.1 观察器(`monitor/observer.mjs`)

| 变量 | 默认 | 作用 |
| --- | --- | --- |
| `DSH_SUBAGENT_OBSERVER_INTERVAL` | `2000` | 轮询毫秒数 |
| `DSH_SUBAGENT_OBSERVER_ANNOUNCE_AGE_MS` | `600000`(10 分钟) | 只推送"正在跑或刚结束"的窗口 |
| `DSH_SUBAGENT_OBSERVER_REANNOUNCE_MS` | `20000` | 运行中会话的重播间隔(刷新页面后卡片不空靠它) |
| `DSH_SUBAGENT_OBSERVER_MAX_AGE_MS` | `43200000`(12 小时) | 任务现场的最大回溯窗口 |
| `DSH_SUBAGENT_OBSERVER_PID_GRACE_MS` | `120000` | 「记录说在跑、但连 pid 都没记」的信任期;超期即判"半成品记录",不再当在跑 |
| `DSH_SUBAGENT_OBSERVER_USAGE_REFRESH_MS` | `5000` | 同一会话的日志最多多久重新折叠一次(折叠一次约 33ms) |
| `DSH_SUBAGENT_OBSERVER_ACTIVITY_MS` | `5000` | 进度字节 / token 用量变化触发提前重播的最小间隔 |
| `DSH_SUBAGENT_OBSERVER_RATE_MIN_MS` | `3000` | 算吞吐(`tok/s`)的最小采样跨度;**低于它的窗口不算** |
| `DSH_SUBAGENT_OBSERVER_RATE_SAMPLES` | `4` | 吞吐取最近几次采样的平均(≈20~40 秒窗口) |
| `DSH_SUBAGENT_OBSERVER_DEBUG` | — | 设 `1` 每轮都写日志 |

### 3.2 悬浮卡片(字号缩放与窗口尺寸)

卡片的偏好存在浏览器 `localStorage`(key `dsh.subagent.panel.v1`),不进任何配置文件:

| 项目 | 范围 / 默认 | 怎么改 |
| --- | --- | --- |
| 字号缩放 | **60% ~ 200%**,步进 10%(拖拽时 5%) | 头部 `−` / `+`,点百分比复位 100% |
| 窗口宽度 | ≥ 220px,默认 300px | 拖**右边**或**右下角**把手 |
| 窗口高度 | ≥ 120px,默认自适应 | 拖**下边**或**右下角**把手 |
| 复位 | — | **双击任意把手** = 回到默认尺寸/缩放 |
| 位置 | 右上角,默认 `top: 64px; right: 18px` | 拖头部 |

> 网格是 `repeat(auto-fill, minmax(132px, 1fr))`:拉宽卡片会**自动多排几列**
> (300px 两列,700px 四五列)。拉高之后内容区滚动,头部与底部状态条固定。
