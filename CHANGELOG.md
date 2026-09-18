# 更新日志

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/);日期为本地实测日期。

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
