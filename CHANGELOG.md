# 更新日志

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/);日期为本地实测日期。

## [未发布]

### 新增

- **桥接进程的生命周期留痕**(`state/mcp-lifecycle.log`):启动(带版本号)、退出原因、
  未处理异常/未处理拒绝的堆栈,各写一行。起因是实际踩到的故障 —— Codex 里 `dsh_task`
  调用返回 `tool call error: tool call failed for 'dsh/dsh_task' / Caused by: Transport closed`,
  而"客户端关掉了管道"和"桥接进程崩了"在调用方看来**完全一样**,当时只能靠数 `node.exe`
  进程个数才敢确认桥接进程已经不在了。这几行不看 `DSH_SUBAGENT_DEBUG`、也不走 stderr
  (harness 会把 MCP 子进程的 stderr 渲染成 warning),正常一天只多两条。
- 未处理异常与未处理拒绝**不再带走整条通道**:Node 24 默认把未处理的 Promise 拒绝当异常抛出,
  过去一个没包住的 `await` 就能让整个 stdio 服务退出 —— 之后调用方每次调用都是
  `Transport closed`,直到它自己重启。现在记一行留痕,继续服务下一个请求。

### 修复

- 连接收尾只会执行一次(原先 stdin 的 `end` 与 `close` 会各走一遍 `shutdown`,
  生命周期日志里出现两条重复的退出原因)。

### 校验

- `npm run test:all` → 392 项(selftest 102、panel 138、observer 49、launcher 13、ledger 20、
  autostart 26、leaf 14、exec-surface 11、monitor-live 8、wait-policy 11);
  新增两条断言:客户端关掉管道后 `state/mcp-lifecycle.log` 里必须留下退出原因与退出码,
  以及启动行必须带版本号。

## [0.1.10] — 2026-09-21

### 新增

- **预览窗口里只读显示子代理的对话内容**。运行中的外部任务**不能**像普通会话那样点开
  (点开 = 宿主接管写权、写坏子进程正在写的日志),原先那个只读详情页只能看到
  `stderr.log` 的最新几行。现在观察器在**算 Token 用量的同一趟解码**里把会话日志折成转录,
  随 `dsh-subagent` 投影下发,详情页按四条角色只读渲染:
  - `用户` / `助手`:取消息体里的文本块;**推理块(reasoning)故意丢掉**(长且刷屏);
  - `调用`:显示成 `工具名(命令)`,参数是 JSON 时取 `command`/`description`/`path`,不是一坨转义 JSON;
  - `返回`:折成单行;空的返回标成 `(空返回)`(沙箱把命令吞掉时的现场,最该被看见的一种返回),
    `isError` 的加 `[错误]` 前缀。
- 转录随投影每 2~20 秒重发,因此**必须封顶**:默认最多 60 条、总计 6000 字、单条 600 字,
  超出从最旧的开始丢(可用 `DSH_SUBAGENT_OBSERVER_TRANSCRIPT_ENTRIES` /
  `_TRANSCRIPT_CHARS` / `_TRANSCRIPT_ENTRY_CHARS` 调整)。老投影没有这个字段时,
  详情页退回原来 `stderr.log` 的尾部,不会突然空掉。
- 客户端只认 `role` 与 `text` 两个字段(转录是外部数据),转录节点上**没有任何点击或写入钩子**:
  只读是结构性的,不是靠约定。

### 修复

- **自检不再拿用户的策略文件当"未指定"用**。`test/selftest.mjs` 原先把仓库里那份
  `config/model-policy.md` 原样复制成临时副本,再断言"默认模型未指定 → 会输出首次接入引导" ——
  可策略文件本来就是给用户改的:用户一设默认模型,这 4 条断言就红(本机实测踩到)。
  现在副本里显式把「默认模型」那行改成 `(未指定)`(那才是要测的状态),
  仓库那份只做结构性断言:`(未指定)` 或一个裸模型 id 都算合法。

### 校验

- `npm run test:all`:**390/390 全绿**(`exit=0`;selftest 100、panel 138、observer 49、
  launcher 13、ledger 20、autostart 26、leaf 14、exec-surface 11、wait-policy 11、monitor-live 8)。
- 新增断言:转录四条角色的折叠顺序、推理块不进预览、工具调用折成 `名字(命令)`、空返回与
  `[错误]` 前缀、条数与字数两种封顶(丢最旧的)、投影里真的带出转录且每条只有两个字段;
  客户端侧断言详情页渲染转录、有转录时不再退回 `stderr.log`、转录节点无任何交互钩子、
  写入口仍只有原来那两个按钮。
- 心跳加 `transcriptCaps` 标记(与既有的 `usageRate` 同一用途):`$DSH_HOME/subagent/state/observer-heartbeat.json`
  里有这一项,才说明宿主里跑着的观察器是带只读转录的那一版;**没有它就只能重启宿主**,
  刷新页面不会让观察器换版本。
- 现场验证(`state/transcript-probe/verify-live.mjs`):411 KB 真实会话日志解码 14ms、
  折出 22 条转录、封顶生效。
- 文档闸门(`state/docs-rewrite/check-docs-rewrite.cjs verify`):`exit=0`。README 里三处
  代码注释的测试项数按实测更新(38/126/117 → 48/138/138),这类计数改动会触发闸门的
  "代码块逐行不许丢",已按既有做法记入 `intentional-deltas.md` 并重取基线。

## [0.1.9] — 2026-09-21

### 变更

- **四份标准文档改用 `gemini-3.7-flash` 重写为朴实技术语言**:`README.md`、`docs/clients.md`、
  `docs/configuration.md`、`docs/install.md`。技术信息一条没少(行内记号 704 → 714、代码行 139、
  版本号 9、跨文档链接 3 全部保留),只是把生造词与黑话换成普通话术
  (磁贴 / 硬承诺 / 响亮失败 / 口径 / 幽灵 / 垫片 / 探针 / 闸门 → 卡片 / 明确的执行上限 /
  直接报错不静默 / 规则 / 残留记录 / 入口脚本 / 自检脚本 / 检查)。
- **公开仓库脱敏**:README 与策略文件里的内部标识换成中性占位符 —— 网关地址、API key 环境变量名、
  路由名,以及只在本机存在的模型别名;`lib/mcp.mjs` 里"本机当前是某个 provider"这类
  写死本机事实的句子删掉(模型清单本来就该从 `dsh_health.models` 查,这正是 0.1.8 的方向)。
  模型 id 示例(`deepseek-v4.1-flash` / `gemini-3.7-flash`)按需保留,示例仍可照抄。

### 修复

- **`test/selftest.mjs` 里的机器相关断言改成结构断言**:原先断言"本机 43 个模型"、
  "本机默认模型是 `provider/某模型`",换一台机器 clone 下来必红。现在改为断言结构
  (providers 是对象、每项都是非空 id 数组、顺序与去重与独立解析逐项一致、`defaultModel` 的
  provider 前缀必须是真实 provider),并加一条**跨文件一致性断言**:枚举结果必须覆盖策略文件里
  `预设默认模型:` 点名的模型(点名的模型没接入 = 真问题,换机器也有意义)。
  「裸 id」「`provider/id`」两条断言改为运行时取值,不再写死 provider 名。

### 校验

- 文档闸门(`state/docs-rewrite/check-docs-rewrite.cjs`):行内记号、代码块行、版本号、跨文档链接
  **0 丢失**(重写期间一度掉到 454 个记号,靠闸门逐项补齐回 714),黑话 **0 命中**。
  重写前后的度量对照见 `state/docs-rewrite/intentional-deltas.md`。
- `npm run test:all`:**366/366 全绿**(`exit=0`;selftest 99、panel 126、observer 38、launcher 13、
  ledger 20、autostart 26、leaf 14、exec-surface 11、wait-policy 11、monitor-live 8)。
  改完的断言实测有效:枚举 43 个、拒绝时列出全部 43 个可用模型、`provider/id` 与裸 id 两种形式都落盘、
  合成 fixture 的 decoy 插件 id 不算模型。

## [0.1.8] — 2026-09-21

### 新增

- **首次接入引导**:别的 agent 第一次接到这个桥接层时(策略文件里还没指定默认模型),
  `dsh_task` 与 `dsh_health` 的返回值末尾会带一段紧凑引导,四步:
  ① 先枚举这个 DSH 实例**已接入**的模型(不猜 id);② **请用户指定一个默认模型**
  (MCP server 不能直接跟用户对话,由调用方 agent 转达);③ 用 `dsh_setup` 落盘;
  ④ 把策略文件链接给用户。指定过之后**不再出现**(策略文件是全局的,不按 caller 记状态)。
- **新工具 `dsh_setup`**(首次接入用):把用户选定的默认模型落盘。三种用法 ——
  `default_model`(裸 id 或 `provider/id`)、`preset`(用策略文件里某个预设声明的模型)、
  `policy_markdown`(整体替换策略文件正文)。**只改 `默认模型:` 那一行**,文件其余内容与
  用户自己的改动一律保留。传一个不在已接入清单里的模型会被**拒绝并列出可用清单**
  (`isError:true`),调用方据此重新问用户;`policy_markdown` 若丢掉机器可读的
  `默认模型:` 行同样拒收;`$DSH_HOME/settings.yaml` 读不到或形状不认识时**一律拒绝**
  (不允许盲写策略文件)。
- **`dsh_health` 暴露模型清单**:新增 `models`(按 provider 分组,取自
  `$DSH_HOME/settings.yaml` 的 models 数组;含 `defaultModel`,枚举失败时给 `error` 而不是空数据),
  以及 `modelPolicy`(`path` / `fileUrl` 链接 / `defaultModel` / `presets`)。
- **用户可编辑的模型策略文件** `config/model-policy.md` —— 即"选择模型的系统提示词"。
  桥接层每次调用都重读它,机器只解析两处(第一条 `默认模型:` 行、每个预设小节里的
  `预设默认模型:` 行),**其余正文随便改**;改完即生效,不用重启任何东西。
  路径可用 `DSH_SUBAGENT_POLICY` 覆写。文件自带「本项目方案」预设。
- **监控卡片显示"这次调用实际用的模型"**:观察器把 `model` / `provider` /
  `reasoningEffort` 带进投影(以任务运行时的 `meta.json` 为准,缺失时退回调用方请求值),
  面板列表行显示模型,详情页增加「模型 / 服务商 / 推理档」三行。

### 变更

- **模型口径不再写死在工具描述里**:`dsh_task` 的描述与 `model` 字段改为"以策略文件为准"
  (动态带上策略文件路径与预设名),并说明首次接入的四步流程;可用模型清单改由
  `dsh_health.models` 提供。这样换机器、换 provider、换口径都不用改代码。
- 模型枚举**只在 models 数组范围内取 id**,不扫全文件(settings.yaml 别处也可能出现 `id:`
  之类的键);认不出形状时返回明确 `error`,不会把非模型的键当成模型。

### 校验

- `npm run test:all`:**365/365 全绿**(改前 328;`exit=0`,`❌` 计数 0)。其中
  `selftest.mjs` 由 61 → **98** 项(**+37,原有断言一条未删**),其余 9 个探针一字未改。
- 新增覆盖:工具清单含 `dsh_setup`;模型枚举读到 43 个且去重保序(与自检侧独立解析逐项比对);
  合成 fixture 里的 decoy 插件 id 不被当成模型;引导块四要素齐全且 ≤10 行(实际 6 行);
  四条拒绝路径(未接入模型 / 不存在的预设 / 参数类型错 / 无参)都点名并列出可用项;
  落盘只改 `默认模型:` 一行、其余内容逐字未变;落盘后引导块消失;
  `preset` 与 `provider/id` 两种形式都生效;`settings.yaml` 缺失时响亮拒绝且**不会创建**策略文件;
  自检全程不写仓库里那份策略文件(经 `DSH_SUBAGENT_POLICY` 隔离到临时副本)。
- 敏感词闸门:`git grep -nEi` 查加解密类字样 **0 命中**(未跟踪的新文件用 `--no-index` 单独查过,同样 0 命中)。

## [0.1.7] — 2026-09-20

### 新增

- **`dsh_task` 暴露 `reasoning_effort`(单次调用改推理强度)**:`lib/tasks.mjs` 的 `startTask()`
  早就支持它(写进 `task.json` 的 `reasoningEffort` 并拼出 `--reasoning-effort <值>`),但 `lib/mcp.mjs`
  **完全没有暴露这个参数**。现在 schema 里有它(`type: 'string'`,位置在 `provider` 之后)、
  `runTask()` 把它转发给 `startTask()`,工具结果的头部在有值时回显 `reasoning_effort: <值>`
  (与 `model:` 并列),调用方能自己确认"我指定的档位真的到达了 DSH"。

### 修复

- **工具说明里举的模型名是错的,照抄只会失败**:`model` / `provider` 的 `description` 原先举例
  `deepseek-v4-pro` / `claude-sonnet-4.6`,而本机 DSH 里**并不存在**这些模型(实测本机
  `%DSH_HOME%\settings.yaml` 的 `llm-pi-ai.providers.<路由名>.models[]` 只配了一个模型),
  调用方照抄就拿到 `UNKNOWN_MODEL`。现在写明取值必须是本机已配置的模型 / 已注册的 provider,
  例子换成真实存在的模型 id,并把 `reasoning_effort` 的取值来源
  (`models[].reasoningEfforts`)与失败语义(`UNSUPPORTED_REASONING_EFFORT`)一并写清;
  README §2 的参数表与 FAQ 同步。
- **可选参数"类型不对被静默忽略"改成响亮失败**:`model` / `provider` / `reasoning_effort` 传非字符串
  (例如 `reasoning_effort: 3`、`model: {}`)时,旧行为是**悄悄当成没传**,调用方以为指定生效了 ——
  与本仓库"响亮失败、不静默降级"的口径不符。现在三者在 `runTask()` 里走同一个共享校验:
  类型不对返回 `isError: true` 并点名参数名与"必须是字符串";空串/纯空白仍视为未提供(沿用 DSH 默认)。
  `test/selftest.mjs` 增加了可机检的断言(档位 schema、`reasoningEfforts`/`UNSUPPORTED_REASONING_EFFORT`
  文案、`model` 的"已配置 + UNKNOWN_MODEL"、类型不对被拒)。

## [0.1.6] — 2026-09-18

### 修复

- **DSH Desktop 更新后垫片入口失效,表现为"派活静默失败"(真实故障)**:本机 `dsh` 是 DSH Desktop
  生成的 cmd 垫片,里面写死了打包入口。Desktop 换打包形态后入口从
  `resources\app.asar\lib\desktop-cli.js` 变成 `resources\app\lib\desktop-cli.js`,而**垫片不会跟着
  更新** —— 每次经它调 dsh 都在 0.8 秒内 `Error: Cannot find module '…\app.asar\lib\desktop-cli.js'`
  + exit 1。`lib/launcher.mjs` 原先把垫片参数直接拿去 spawn、**不校验入口存在性**,故障就以底层
  MODULE_NOT_FOUND 冒出来。现在 `resolveLauncher()` 解析完就校验 `*.js` / `*.mjs` 入口:
  **入口在就照原样**;**不在就按候选清单自愈**(安装根下的 `resources\app\lib\`、
  `resources\app.asar\lib\`、`resources\app.asar.unpacked\lib\`,以及缺失路径上 `app.asar` ↔ `app`
  互换后的同一位置,取第一个真实存在的,其余参数顺序不动);**一个都没命中就响亮报错**,错误里带
  垫片路径、缺失入口、已尝试的候选清单与处置办法(删掉垫片让它重建,或改垫片里的入口),
  不静默降级、不伪造成功。
- **一个残留垫片不再埋掉本机其它可用的 dsh**:入口失效且自愈不命中时**先回退到下一个候选**
  (保持旧代码"换下一个候选"的语义,`%APPDATA%\DSH Desktop\host-commands\…\dsh.cmd` 是一份陈旧
  残留时,PATH 里那个可用的 `dsh` 仍然能用),每个候选的失败原因收集起来,**所有候选都失败才抛
  聚合错误**:一句话结论 + 逐条列出每个候选为什么不行 + 处置办法(修垫片里的入口 / 删掉失效垫片
  让 DSH Desktop 重建 / 用 `DSH_SUBAGENT_DSH_SHIM` 显式指定)。"响亮报错"与可用性不再二选一。
- **安装器不再把 Codex 手写的 `tool_timeout_sec` 删掉**:`install.mjs` 的 `registerCodex()` 现在与
  README §2 口径一致地写出 `tool_timeout_sec = 600`。原先它不写这一行,而块替换是"整块覆盖",
  于是用户按 README 手写的 600 会在下一次重跑安装器时被静默删掉 —— Codex 侧长任务又被 60s 掐断,
  掐断时的 `notifications/cancelled` 还会被桥接层当成"调用方停了这一轮"而杀掉正在跑的任务。
  同时把"这一块要不要改写"的判据从"整块文本一模一样"放宽成"要求的那几行都在",手写的说明注释
  与自己调过的值不再被吞掉(实测:真实配置里那一块的 4 行注释原先会在重跑时消失)。
- `--dry-run` 现在逐条列出将要执行的动作(其中 `ok` = 已是目标状态、一个字都没动)。原先干跑只说
  "共 N 条动作",看不出会动什么 —— 而 README §2 / `docs/install.md` 一直承诺"只看会改什么"。

### 新增

- `test/launcher-heal-probe.mjs`(13 项,只读文件系统、不 spawn 任何东西,并把 PATH/APPDATA 收紧到
  夹具里):断言入口失效时自愈到 `resources\app\lib\`(候选优先级与其余参数顺序不变)、所有候选都
  失效时抛聚合错且逐条列出每个垫片的原因与处置办法、exe 不在安装根时靠 `app.asar` ↔ `app` 互换
  命中、**候选 1 是失效残留而候选 2 可用时回退到候选 2**、本机真实垫片的入口真实存在。
  `npm run test:launcher`,并已并入 `npm run test:all`(全套 10 个探针)。

## [0.1.5] — 2026-09-18

### 变更

- **等待口径反转:先等到结果,超时才轮询**(委派不再被拆成一串轮询)。旧口径是
  "`wait_seconds` 默认 30,建议传 0 或 ≤30",于是每次委派都变成"立刻拿 `job_id` + 每 20~30 秒
  轮询一次":一个 5 分钟的任务要十几次往返,而**每一轮都是调用方一次完整的推理**,又慢又贵。
  现在 `dsh_task` 默认自己等 **45s**(短超时):任务在这段里结束就把结果**直接带回**,零轮询;
  只有到点还没结束才返回 `status: running`,那时才用 `dsh_task_status`(默认等 **30s**)
  一轮一轮推到终态。**轮询从默认路径降级为兜底**。
- 两个默认值的来源是评估结果,不是拍脑袋:`dsh_task` 的 45s = 最紧的调用方单次工具超时
  (Codex `mcp_servers.<id>.tool_timeout_sec` 默认 **60s**,官方 config reference)留 25% 余量;
  Claude Code 的 stdio 空闲窗默认 30 分钟、超 2 分钟自动转后台,远宽于此;Cursor 未公开,
  按 60s 保守处理。取 60s 以上会踩到"harness 先掐断调用 ⇒ 可能发 `notifications/cancelled`
  ⇒ 把还在跑的任务当成'停这一轮'杀掉"的分支(0.1.4 的取消语义)。README §2.3 有完整推导与
  "想让长任务也一次返回"的两步改法。
- 沿用的环境变量:`DSH_SUBAGENT_WAIT_SECONDS`(`dsh_task` 短超时,默认 45);
  新增 `DSH_SUBAGENT_STATUS_WAIT_SECONDS`(`dsh_task_status` 默认等待,默认 30)。
  `dsh_health` 现在回报 `defaultWaitSeconds` / `statusWaitSeconds` / `waitModel`。
- 工具文案同步改写(否则模型还会照旧文案传 `wait_seconds=0`):`initialize.instructions`、
  `dsh_task.description`、`wait_seconds` 字段说明、`dsh_task_status` 描述与字段说明、
  以及"返回 running"时的下一步提示(`dsh_task_status(job_id="…", wait_seconds=30)`)。
  三处都在劝退:别传 `0`、也别传 `>60`。

### 新增

- `test/wait-policy-probe.mjs`(11 项,真起 MCP server + 真派任务):断言默认口径出自策略本身、
  不传 `wait_seconds` 时**一次调用就带回终态**(实测 3.5s)、短超时到点才返回 `running` 并给出
  轮询命令、`dsh_task_status` 不传 `wait_seconds` 时自己会等(实测 20.7s)。
  `npm run test:wait`,并已并入 `npm run test:all`(全套 9 个探针)。
- 自检里多一条**口径回归闸**:`dsh_health` 的 `defaultWaitSeconds` / `statusWaitSeconds` 必须
  等于当前默认值且都 `< 60`,防止以后有人把等待调到 harness 工具超时之上。

## [0.1.4] — 2026-09-14

### 修复

- **调用方停这一轮,子代理这边不再继续跑**(真实故障):在 Cursor / Claude Code 里按"停止本轮",
  harness 会发 MCP 的 `notifications/cancelled`,而桥接层原先**直接忽略**它(注释写着"留给任务
  自己按 timeout 收尾")。后果是调用方那边已经停了,这边的 `dsh` 实例还在后台继续跑、继续烧
  token,还往工作区里写文件 —— 看起来像"幽灵改动"。现在四条明确的停止信号都会被真的执行:
  ① 取消在途请求 ⇒ 停掉该请求对应的任务(精确);② 取消对不上具体请求 ⇒ 只在本连接恰好一个
  任务在跑时停它;③ 连接断开(`end`/`close`)⇒ 停掉本连接名下全部任务再退出;
  ④ `SIGINT`/`SIGTERM` ⇒ 先停掉本进程名下全部任务再退出。
- 刻意没做"按轮询间隔猜调用方还在不在":调用方可能只是在思考,拿它当依据会误杀真正在跑的活。
  客户端既不取消也不关连接时,任务仍会跑到自己的 `deadline`,这种情况用
  `dsh_task_cancel` / `dsh_task_kill` 主动止损。

### 新增

- `test/cancel-propagation-probe.mjs`(7 项,真起 MCP server + 真派任务):在轮询请求在途时发取消
  通知,断言任务被停、**子进程真的消失**(用 `process.kill(pid, 0)` 探,不是只看状态字段)、
  连接断开后 server 自行退出。`npm run test:cancel`。
- `dsh_task_status` 的工具描述里写明取消语义(只想看状态就用 `wait_seconds=0`)。

### 修正

- **测试项数口径**:README / CHANGELOG 里的"全套 N/N"一直是把每个探针的收尾行
  "…通过 ✅"也数进去,普遍多算 1~2 项。现在只取各探针**自报**的通过数,当前是
  **284/284**(panel 117、selftest 53、observer 35、autostart 26、ledger 20、leaf 14、
  exec-surface 11、monitor-live 8),历史行也已回订正。代码与测试行为没有任何变化。

## [0.1.3] — 2026-09-14

### 新增

- **执行面体检(空转检测)**:任务收尾时桥接层解会话日志,把"命令没跑却报成功"的 shell 调用
  数出来,在答复末尾附告警(次数、命令样例、当前权限档、出路),并落进任务记录的
  `shellHollowCalls` / `shellHollowSamples`。调用方不会再拿到一个"完成但什么都没做"的结果。
- `test/exec-surface-probe.mjs`(11 项,离线):锁死下面两件事 —— 会话日志改名兼容、
  "空转成功"的判定规则与零误报。

### 修复

- **会话日志改名导致的静默回归**:DSH 0.1.5 起把 `session.jsonl.zstd` 改成
  `session.v3.jsonl.zstd`(实测改名时刻与本机升级时刻一致)。原先观察器与桥接层都硬编码旧名,
  **找不到文件时安静返回 null**,于是监控卡片的 token 用量对所有新会话都成了空 —— 一个不报错的
  假数字。现在统一按 `session*.jsonl.zstd` 找(取最大者,不依赖 mtime),并把同样的查找逻辑
  用到各探针上;`leaf-only-probe` 的会话级断言也不再可能"静默空转"。

### 文档

- 新增 §5.1:记录**沙箱档下 shell 会"空转成功"**(`workspace-write` / `read-only` 下命令从未启动,
  工具却返回 `"\r\n"` + `isError:false`)的完整证据与对照实验,含 `danger-full-access` 的正确行为、
  "与 DSH 版本无关"(升级前后日志一致)、"与本插件配置无关"(两个 profile 沙箱行一致)的判定,
  以及桥接层的告警行为与处置办法。常见问题同步。
- 验收记录补 3 行(空转复现、检测准确率、日志改名兼容)。

## [0.1.2] — 2026-09-11

### 修复

- **MCP 连接不再让 harness 报 warning**。原先 server 启动会往 stderr 打一行纯信息横幅,
  而 harness 把 MCP 子进程的 stderr **一律渲染成 warning/error** —— Cursor 的 `mcpprocess.log`
  里就是 `[warning] [McpProcess stderr]   ERR dsh-subagent: MCP stdio server ready …`。
  现在**正常路径下 stderr 一个字都不写**,stderr 只留给真的出问题(如进程树探测不可用的
  降级告警);排查时设 `DSH_SUBAGENT_DEBUG=1` 即恢复横幅与调试行。
- **版本号只有一个来源**:`SERVER_VERSION` 原先硬编码 `0.2.0`,与 `package.json`(`0.1.1`)
  各自漂移,用户看到的横幅版本和仓库对不上。现在直接读 `package.json`。

### 文档

- README 精简:删掉与**特定机器环境**强绑定的说明,相关设计理由改为环境无关表述
  (例如"判进度只看字节数、不依赖 mtime"保留,"本机为什么 mtime 不可靠"不再展开)。
- README 新增常见问题条目解释上面那个 warning,并在验收记录里补了对应实测行。
- README 章节重新编号(§1~§10),全部交叉引用同步。

### 测试

- `test/selftest.mjs` 新增 3 项:`serverInfo.version 与 package.json 一致`、
  `正常启动不往 stderr 写任何东西`、`DSH_SUBAGENT_DEBUG=1 时才有启动横幅`。
- 全套 **272/272**(panel 117、selftest 53、observer 34、autostart 26、ledger 20、leaf 14、monitor-live 8)。
  注:本条原先写作 275/275,是计数口径错了(把每个探针的收尾行"…通过 ✅"也数了进去);
  0.1.4 里改为只取各探针**自报**的通过数,并回订正了本行。

## [0.1.1] — 2026-09-11

**适配 DSH 0.1.5-rc.1**。升级当场打坏了整个桥接层(协议级自检 43/51:`dsh_task` 1.5 秒即失败、
不写文件、答复为空),修完后 272/272 全绿。

### 修复(破坏性 API 变化)

- **`@deepseek-ai/dsh-llm` 不再导出 `assertNever`**(搬到 `dsh-util-values`):`subagent-runner.js`
  还带着这个 import,导致 subagent profile 在插件树加载阶段就
  `SyntaxError: does not provide an export named 'assertNever'` —— 表现为"任务跑完了但什么都没发生",
  最难查的一种坏法。改为 runner 内的 `warnUnknownChunk()`:未知 chunk **告警并忽略**,
  而不是抛异常(旧语义下,新版一旦给推理流加一种 chunk 类型就会整轮崩掉)。
- **`permissionPresets.current()` 改收 Session 对象**(原先收事件数组):传错形状不从参数校验报错,
  而是从 DSH 内部炸出 `Cannot read properties of undefined (reading 'header')`。新增
  `currentPreset()`:先按新版调,失败再按旧版调,两条路都不通才抛原始错误 —— 同时兼容 ≤0.1.4。
- **`session.events` → `session.log`**:新增 `eventsOf(session)` 兼容两个名字。
- `fail()` 现在打印**完整栈**。原先只打 `error.message`,上面第二条最初只表现为一句没头没尾的报错。

### 测试与工具

- `test/leaf-only-probe.mjs`:去掉失效的 `tool-subagent-report` 断言(0.1.5 起它不再是 loader 行,
  `subagent-report` 变成会话协议里的消息 kind),并在注释里写明版本注记。
- `test/monitor-live-probe.mjs`:GUI 宿主判定从**排除法**改成**正面识别**(真宿主必定带 `--type=` 子进程)。
  旧写法会把宿主派生的瞬时进程误判成第二个 GUI,导致"没有重复宿主"这条断言随时误报。
- `profile/cordis.patch.yml`:更正"进程内分叉服务保持加载"的过期注释 —— 实测 0.1.5 的 base bundles
  已把这 `subagent-spawn-in-process` / `subagent-fork-in-process` 全局关闭(两个 profile 都是)。
- README 新增「DSH 版本兼容性」章节,并校准目录树里几处过期计数。

### 已知上游问题(与本插件无关)

- 随 0.1.5-rc.1 发布的 `lsp-stdio` / `tool-lsp` 没跟上 `assertNever` 迁移,import 即失败;
  插件树是整体加载语义,所以 `dsh --profile web` **完全起不来**。桌面宿主不受影响
  (它的插件树里没有这两行,日志也无该错误)。给你留了两行 overlay 的临时绕开办法。

## [0.1.0] — 2026-09-11

首个公开版本。三部分一起来:**MCP 桥接层 + DSH `subagent` profile + DSH Desktop GUI 监控插件**。

### 桥接层(MCP)

- 五个工具:`dsh_task` / `dsh_task_status` / `dsh_task_cancel` / `dsh_task_kill` / `dsh_health`,
  服务器名统一 `dsh`。
- `expected_seconds` **必填**,缺失以 `isError: true` 拒绝(不做默认值兜底);
  它同时是硬截止:`deadlineAt = startedAt + expected_seconds × grace`。
- 七种状态语义:`ok` / `error` / `deadline` / `stalled` / `cancelled` / `killed` / `running`。
- **停滞看门狗**:多信号判活(输出字节、后代进程、整树 CPU),加"窗口内 CPU 强度下限"
  把 IO/定时器空转噪声与真正的工作区分开(实测能救回"长时间不出字但在干活"的任务,
  也能抓住"树 CPU 每轮仍有 15~220ms 空转噪声"的真挂起)。
- **强杀是验证过的**:非本进程启动的任务走 `taskkill /T /F` 并检查退出码,
  失败如实报 `killed:false` 而不是谎报成功。
- **工具调用建议写进工具定义本身**(`initialize.instructions` + 各字段 `description`),
  任何 harness 的模型只读 schema 就知道怎么估时长、怎么轮询、怎么止损。
- 监控窗口自动拉起:调 `dsh_task` 时若没有宿主在跑,自动启动 DSH Desktop;
  能区分**心跳新鲜但 pid 已死**的残留、以及**宿主在跑旧版观察器**的情形。

### DSH 侧 profile

- 一次会话、`approval: never`(无人可点同意)、标题不再花一次模型调用。
- 三种沙箱模式都配 `approval: never` 的**显式权限预设表**(否则 `workspace-write` /
  `read-only` 会在插件树加载阶段就崩)。
- **叶子闸门**:外部任务关掉 `subagent` / `subagent_fork` / `workflow` / `ralph` 等
  所有分叉工具,自检会解出真实会话日志里的工具表来验证。

### GUI 监控插件

- 观察器:把外部任务的实时状态(状态、截止、进度字节、最近输出行、token 用量)写进会话**投影**,
  于是卡片与侧边栏永远一致,不需要第二条通道。
- **幽灵记录按 pid 判活**:记录说在跑但进程已死的,一律推 `running=false`;
  「没记 pid」有 120 秒信任期,超期即判半成品记录(否则会永远显示活跃)。
- 悬浮卡片:按调用方分组、手机式展开成磁贴、只读详情页、可拖动、可收起。
- **自由改尺寸**(右/下/右下角三个把手,宽高独立,双击复位),网格 `auto-fill` ——
  拉宽自动多列。
- **底部状态条**:`tok/s | 缓存命中 % | 输入 N tok · 输出 M tok`,
  与宿主自己的对话统计同口径:缓存命中率部分命中**绝不显示成 100%**。
- **token 用量双数据源**:宿主会话读标准 `tokenUsage` 投影;外部任务由观察器**逐帧解
  zstd 折叠会话日志**(整块解只出第一帧且不报错,是个静默坑)。
- **吞吐口径**:只由观察器按真实采样时间跨度算(≥3 秒、最近 4 次采样平均),
  客户端不再自己每秒采样 —— 旧算法会把"2 秒里跳 6000 token"算成 3000 tok/s。

### 安装与自检

- `install.mjs` 一条命令装配全部:**幂等**、**先备份**、**永不覆盖解析失败的 JSON 配置**,
  支持 `--dry-run` 与 `--only profile,observer,panel,cursor,…`。
- `uninstall.mjs` 按受管标记精确摘除。
- 离线自检套件(273 项)全部可用 `node test\*.mjs` 复跑,含真实多帧 zstd 日志与真进程判活。
