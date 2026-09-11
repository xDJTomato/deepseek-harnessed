# 更新日志

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/);日期为本地实测日期。

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
- 全套 **275/275**(panel 117、selftest 54、observer 34、autostart 27、ledger 21、leaf 14、monitor-live 8)。

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
