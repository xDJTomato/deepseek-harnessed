# 客户端接入指南：Cursor / Claude Code / Codex / …

运行 `node install.mjs` 会自动将桥接服务注册至**本机已安装的外部工具**中。本文档说明各客户端的配置文件路径、写入内容结构，以及手动接入其他工具的方法。

MCP 服务器名称统一为 **`dsh`**，各客户端中的工具命名格式如下：

| 客户端类型 | 对应工具名称 |
| --- | --- |
| Claude Code | `mcp__dsh__dsh_task` |
| Cursor / Codex / 其他工具 | `dsh.dsh_task` |

服务共提供六个 MCP 工具：`dsh_task`（任务分派）、`dsh_task_status`（状态查询与等待）、`dsh_task_cancel`（任务取消）、`dsh_task_kill`（强制终止）、`dsh_health`（健康检查：返回已接入模型与模型策略文件）、`dsh_setup`（写入默认模型配置）。工具详细定义与返回结构参见 [README §2](../README.md#2-对外暴露的六个-mcp-工具)。

---

## 0. 首次调用流程与模型配置引导

在未配置默认模型的情况下，首次调用 `dsh_health` 或 `dsh_task` 时，返回内容末尾将附加一段包含 6 行指引的**首次接入引导说明**。调用方 Agent 按以下流程执行初始化：

1. **获取已接入模型列表**：读取 `dsh_health` 返回的 `models.providers`（按服务商分组）。模型权威来源为 `$DSH_HOME/settings.yaml` 中的 `models` 数组，请勿自行构造不存在的模型 ID。
2. **确认默认模型选择**：由于 MCP 服务不直接与用户交互，需由调用方 Agent 将可用模型列表展示给用户并获取选择。
3. **写入配置**：调用 `dsh_setup(default_model: "<模型 id>")`，或使用预设方案 `dsh_setup(preset: "本项目方案")`。若传入未接入的模型 ID，服务将直接报错并返回可用列表。
4. **展示策略文件路径**：引导说明中包含 `fileUrl`（形如 `file:///…/config/model-policy.md`），用户可直接编辑该文件调整模型选择规则，修改后即时生效。

完成配置后（策略文件中 `默认模型:` 已写入有效值），后续响应将不再包含引导说明，`dsh_health` 中的 `modelPolicy.defaultModel` 即为当前默认模型。日常任务分派时，可按策略文件规则在 `dsh_task` 中传入 `model` 参数；若指定的 `model` 不存在，服务将直接报错（返回 `UNKNOWN_MODEL` 错误代码），不进行静默回退。

后续如需修改模型规则，可直接编辑 `~/.dsh/subagent/config/model-policy.md`，或再次调用 `dsh_setup`。策略文件路径支持通过 `DSH_SUBAGENT_POLICY` 环境变量覆盖（详见 [配置参考文档 §1.5](./configuration.md)）。

---

## 1. 自动注册配置矩阵

| 外部工具 | 配置文件路径 | 写入键名 | 数据格式 |
| --- | --- | --- | --- |
| Cursor（IDE 与 `cursor-agent` CLI） | `~/.cursor/mcp.json` | `mcpServers.dsh` | `{command, args, env}` |
| Cursor 用户级规则 | `~/.cursor/rules/dsh-subagent.mdc` | 优先分派任务至 DSH 的规则说明 | 文本 |
| Claude Code | `~/.claude.json` | 用户级 `mcpServers.dsh` | `{command, args, env}` |
| Claude Code 子代理定义 | `~/.claude/agents/dsh.md` | 将 `Task(subagent_type: "dsh")` 转发至 DSH | Markdown |
| Claude Code 全局说明 | `~/.claude/CLAUDE.md` | 子代理任务统一路由至 DSH | 受管配置块 |
| Claude Code 工具权限 | `~/.claude/settings.json` | `permissions.allow += mcp__dsh` | JSON |
| Claude Desktop（若已安装） | `%APPDATA%\Claude\claude_desktop_config.json` | `mcpServers.dsh` | `{command, args, env}` |
| Codex CLI / Desktop | `~/.codex/config.toml` | `[mcp_servers.dsh]` | TOML 段落 |
| Codex 全局说明 | `~/.codex/AGENTS.md` | 子代理任务统一路由至 DSH | 受管配置块 |
| Gemini CLI | `~/.gemini/settings.json` | `mcpServers.dsh` | `{command, args, env}` |
| Antigravity | `~/.gemini/antigravity/mcp_config.json` | `mcpServers.dsh` | `{command, args, env}` |
| Kiro | `~/.kiro/settings/mcp.json` | `mcpServers.dsh` | `{command, args, env}` |
| Qoder | `~/.qoder/mcp.json` | `mcpServers.dsh` | `{command, args, env}` |
| VS Code / Copilot | `%APPDATA%\Code\User\mcp.json` | `servers.dsh` | `{type: "stdio", command, args}` |
| Copilot CLI 备用路径 | `~/.vscode/mcp.json` | `servers.dsh` | `{type: "stdio", command, args}` |
| opencode | `~/.config/opencode/opencode.json` | `mcp.dsh` | `{type: "local", command: [node, entry]}` |

安全机制：若已有配置文件解析 JSON 失败，程序将跳过修改以保护用户配置；未安装的客户端标记为 `skip`。修改已有文件前均会自动生成 `<文件>.bak-dshsubagent-<时间戳>` 备份。

指定客户端进行注册：

```powershell
node install.mjs --only cursor,claude,codex
```

---

## 2. 手动接入配置（未预置的客户端）

对于支持标准 Stdio MCP 协议的工具，在对应配置文件中添加以下配置项：

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

配置说明：

- 建议使用 Node.js 可执行文件与入口脚本的绝对路径，避免依赖可能不一致的系统 PATH 环境变量（必要时可设置 `DSH_SUBAGENT_DSH_SHIM`）。
- `dsh_task` 将继承 MCP 服务器进程的环境变量，[配置参考文档](./configuration.md) 中列出的 `DSH_SUBAGENT_*` 参数可写入 `env` 对象。
- 如需按项目隔离，可将上述配置写入项目专属配置文件（例如 Cursor 的 `.cursor/mcp.json`）。

### Claude Code CLI 手动接入

```powershell
claude mcp add dsh --scope user -- node $env:USERPROFILE\.dsh\subagent\bin\dsh-subagent-mcp.mjs
claude mcp list     # 应显示 dsh → Connected
```

### Codex CLI 手动接入

```powershell
codex mcp add dsh -- node $env:USERPROFILE\.dsh\subagent\bin\dsh-subagent-mcp.mjs
codex mcp list      # 应显示 dsh → enabled
```

### 命令行直接调用（无需 MCP 客户端）

```powershell
dsh-subagent -w D:\some\repo "把 README 的安装步骤补全"       # stdout 就是 DSH 的答复
dsh-subagent --json -w D:\some\repo "…"                      # 结构化输出
dsh-subagent --where                                         # 探活
```

---

## 3. 内置子代理路由设置

安装程序向 Claude Code、Codex、Cursor 写入全局指导说明，使其优先将子任务委派给 DSH 实例：

- **Claude Code**：在 `~/.claude/agents/dsh.md` 中定义名为 `dsh` 的子代理，使 `Task(subagent_type: "dsh")` 调用直接路由至 DSH；并在 `~/.claude/CLAUDE.md` 中说明子任务委派统一由 DSH 处理。
- **Codex**：在 `~/.codex/AGENTS.md` 中写入相同说明。
- **Cursor**：在 `~/.cursor/rules/dsh-subagent.mdc` 中写入用户级规则。

上述内容均位于受管标记区块内，执行 `uninstall.mjs` 会自动精准清理，保留用户的其他自定义内容。

> 注意：提示词层面的路由引导为约定策略；DSH 进程内通过 [叶子限制配置](./configuration.md) 禁用了子任务再分派工具，防止递归创建子代理。

---

## 4. 调用方身份识别机制

MCP 连接在初始化（`initialize`）请求中携带的 `clientInfo.name` 会附加至该连接创建的所有任务元数据中（保存在 `task.json` 的 `caller` 与 `callerVersion` 字段，并在工具返回文本的 `caller:` 行显示）。未提供时默认为 `"unknown"`，命令行直接调用标记为 `"cli"`。DSH Desktop 的监控面板与 `dsh_health` 均依据此字段进行分组呈现。

---

## 5. 接入验证步骤

```powershell
# ① 客户端认到服务器了吗
claude mcp list          # 期望:dsh → Connected
codex mcp list           # 期望:dsh → enabled

# ② 桥接层自己探活
dsh-subagent --where

# ③ 真跑一轮(在客户端里发一句让它委托的话)
#    "用 dsh 在 D:\some\repo 里列出所有路由文件"
```

任务分派后，DSH Desktop 界面上的状态面板将显示当前任务卡片（需观察器插件处于运行状态，详见 [安装文档 §3](./install.md#3-让-gui-真正看到实时数据必读)）。
