# 客户端接入:Cursor / Claude Code / Codex / …

`node install.mjs` 会自动注册**本机已安装**的 harness。这一页说明每个客户端写到哪、
写进去的是什么,以及安装器不管的客户端怎么手工接。

MCP server 统一叫 **`dsh`**,所以各家的工具名形如:

| 客户端 | 工具名 |
| --- | --- |
| Claude Code | `mcp__dsh__dsh_task` |
| Cursor / Codex / 其它 | `dsh.dsh_task` |

暴露六个工具:`dsh_task`(委托)、`dsh_task_status`(查/继续等)、`dsh_task_cancel`(优雅取消)、
`dsh_task_kill`(强制终止)、`dsh_health`(探活:含已接入模型与模型策略文件)、`dsh_setup`(首次接入落盘默认模型)。
语义见 [README §2](../README.md#2-对外暴露的六个-mcp-工具)。

---

## 0. 外部 agent 第一次调用会看到什么

**第一次调用(这个实例还没人指定过默认模型)时**,`dsh_health` 的输出末尾与 `dsh_task` 的返回值
末尾都会多出一段 6 行的「**首次接入**」引导块。调用方 agent(你)按它走四步:

1. **看清已接入模型**:`dsh_health` 的 `models.providers`(按 provider 分组)—— 权威来源是
   `$DSH_HOME/settings.yaml` 的 `models` 数组,**不要凭记忆猜 id**。
2. **请用户指定一个默认模型**:MCP server 自己不能跟用户对话,所以这一步只能由你转达
   (把候选模型列给用户挑)。
3. **落盘**:`dsh_setup(default_model: "<模型 id>")`,或直接用预设 `dsh_setup(preset: "本项目方案")`。
   用没接入的 id 会被拒绝并列出可用清单(重新问用户即可)。
4. **把策略文件链接给用户**:引导块里有 `fileUrl`(`file:///…/config/model-policy.md`),
   告诉用户「这里面的模型选择规则你可以自己改」—— 改完立刻生效,不用重启任何东西。

**用户指定过之后**(策略文件里 `默认模型:` 有值)这段引导**不再出现**,`dsh_health` 的
`modelPolicy.defaultModel` 就是那把口径。日常派活时按策略文件的口径传 `dsh_task` 的 `model`;
`model` 传错是**响亮失败**(`UNKNOWN_MODEL`),不会静默退回默认模型。

> 之后想改口径:直接编辑 `~/.dsh/subagent/config/model-policy.md`(人可读的「预设方案」/「模型选择规则」),
> 或让 agent 再调一次 `dsh_setup`。文件位置可用 `DSH_SUBAGENT_POLICY` 覆写(见
> [configuration.md §1.5](./configuration.md#15-模型策略选择模型的口径))。

---

## 1. 自动注册矩阵

| Harness | 配置文件 | 写入内容 | JSON 形状 |
| --- | --- | --- | --- |
| Cursor(IDE + `cursor-agent` CLI) | `~/.cursor/mcp.json` | `mcpServers.dsh` | `{command, args, env}` |
| Cursor 用户级规则(尽力而为) | `~/.cursor/rules/dsh-subagent.mdc` | 「委派子任务优先用 DSH」 | 文本 |
| Claude Code | `~/.claude.json` | 用户级 `mcpServers.dsh` | `{command, args, env}` |
| Claude Code 子代理 | `~/.claude/agents/dsh.md` | `Task(subagent_type: "dsh")` = 转发给 DSH | Markdown |
| Claude Code 全局记忆 | `~/.claude/CLAUDE.md` | 「子代理委派:统一走 DSH」 | 受管区块 |
| Claude Code 权限 | `~/.claude/settings.json` | `permissions.allow += mcp__dsh` | JSON |
| Claude Desktop(若安装) | `%APPDATA%\Claude\claude_desktop_config.json` | `mcpServers.dsh` | `{command, args, env}` |
| Codex CLI / Desktop | `~/.codex/config.toml` | `[mcp_servers.dsh]` | TOML 段落 |
| Codex 全局记忆 | `~/.codex/AGENTS.md` | 「子代理委派:统一走 DSH」 | 受管区块 |
| Gemini CLI | `~/.gemini/settings.json` | `mcpServers.dsh` | `{command, args, env}` |
| Antigravity | `~/.gemini/antigravity/mcp_config.json` | `mcpServers.dsh` | `{command, args, env}` |
| Kiro | `~/.kiro/settings/mcp.json` | `mcpServers.dsh` | `{command, args, env}` |
| Qoder | `~/.qoder/mcp.json` | `mcpServers.dsh` | `{command, args, env}` |
| VS Code / Copilot | `%APPDATA%\Code\User\mcp.json` | `servers.dsh` | `{type: "stdio", command, args}` |
| Copilot CLI 回退路径 | `~/.vscode/mcp.json` | `servers.dsh` | `{type: "stdio", command, args}` |
| opencode | `~/.config/opencode/opencode.json` | `mcp.dsh` | `{type: "local", command: [node, entry]}` |

**安全闸**:已有配置文件但 JSON 解析失败时**跳过不写**,绝不覆盖用户配置;
只注册**已安装**的客户端(Claude Desktop 等不存在就报 `skip`)。每次写入前备份成
`<文件>.bak-dshsubagent-<时间戳>`。

只注册某几个:

```powershell
node install.mjs --only cursor,claude,codex
```

---

## 2. 手工接入(安装器不认识的客户端)

任何支持 stdio MCP 的客户端,填这一对即可:

```jsonc
{
  "mcpServers": {
    "dsh": {
      "command": "C:\\Program Files\\nodejs\\node.exe",   // 或 <node> 的绝对路径
      "args": ["C:\\Users\\<你>\\.dsh\\subagent\\bin\\dsh-subagent-mcp.mjs"],
      "env": {}
    }
  }
}
```

要点:

- 用 **node 的绝对路径** + 入口脚本的绝对路径。别依赖 PATH —— GUI 客户端启动时继承的
  PATH 经常和终端不一样(`DSH_SUBAGENT_DSH_SHIM` 就是为这种情形准备的)。
- `dsh_task` 会继承 MCP server 进程的环境变量,所以 [configuration.md](./configuration.md)
  里的 `DSH_SUBAGENT_*` 都写在 `env` 里。
- 想按项目隔离,就把同样的配置写进项目级配置(例如 Cursor 的 `.cursor/mcp.json`)。

### Claude Code CLI 手工版

```powershell
claude mcp add dsh --scope user -- node $env:USERPROFILE\.dsh\subagent\bin\dsh-subagent-mcp.mjs
claude mcp list     # 应显示 dsh → Connected
```

### Codex CLI 手工版

```powershell
codex mcp add dsh -- node $env:USERPROFILE\.dsh\subagent\bin\dsh-subagent-mcp.mjs
codex mcp list      # 应显示 dsh → enabled
```

### 命令行直用(不走 MCP)

```powershell
dsh-subagent -w D:\some\repo "把 README 的安装步骤补全"       # stdout 就是 DSH 的答复
dsh-subagent --json -w D:\some\repo "…"                      # 结构化输出
dsh-subagent --where                                         # 探活
```

---

## 3. 让内置 subagent「转调」DSH

安装器的第四件事就是给 Claude Code / Codex / Cursor 写全局指令,让它们**优先把子任务委托给
DSH 实例**,而不是用自己的内置 subagent:

- **Claude Code**:`~/.claude/agents/dsh.md` 定义了一个名为 `dsh` 的子代理,
  于是 `Task(subagent_type: "dsh")` 实际是转发给 DSH;`~/.claude/CLAUDE.md` 里写明"子代理委派统一走 DSH"。
- **Codex**:`~/.codex/AGENTS.md` 里写明同样的事。
- **Cursor**:`~/.cursor/rules/dsh-subagent.mdc` 写用户级规则(尽力而为)。

这些是**受管区块**,`uninstall.mjs` 会按标记精确摘除,不动你在同一份文件里的其它内容。

> 这一层是"行为约定",不是强制:它改的是提示词,不是客户端源码。真正不可绕过的只有
> [叶子闸门](./configuration.md#22-叶子闸门外部任务不许再分派子代理) ——
> 那是 DSH 侧关掉工具,子代理**没有**分叉能力。

---

## 4. 调用方身份是怎么识别的

每个 MCP 连接在 `initialize` 里带的 `clientInfo.name` 会记到该连接发起的每个任务上
(`task.json` 的 `caller` / `callerVersion`,工具结果里的 `caller:` 行)。缺省 `"unknown"`,
命令行入口记 `"cli"`。GUI 的悬浮卡片与 `dsh_health` 都按它分组 —— 所以卡片上会分
**Cursor / Claude Code / Codex / 命令行 / 自检 / 未知来源** 几组。

---

## 5. 验证接入

```powershell
# ① 客户端认到服务器了吗
claude mcp list          # 期望:dsh → Connected
codex mcp list           # 期望:dsh → enabled

# ② 桥接层自己探活
dsh-subagent --where

# ③ 真跑一轮(在客户端里发一句让它委托的话)
#    "用 dsh 在 D:\some\repo 里列出所有路由文件"
```

跑起来之后,DSH Desktop 右上角的悬浮卡片会立刻出现该会话的磁贴(需要观察器已生效,
见 [install.md §3](./install.md#3-让-gui-真正看到实时数据必读))。
