# 更新日志

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/);日期为本地实测日期。

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
