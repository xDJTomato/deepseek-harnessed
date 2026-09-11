#!/usr/bin/env node
/**
 * dsh-subagent-mcp —— MCP stdio server 入口。
 *
 * 被 Cursor / Claude Code / Codex / Gemini CLI / Kiro / Qoder / Antigravity
 * 以 `command + args` 方式拉起;stdout 是协议通道,日志走 stderr。
 *
 * @module dsh-subagent/bin/dsh-subagent-mcp
 */
import process from 'node:process';
import { serve, SERVER_VERSION } from '../lib/mcp.mjs';

if (process.argv.includes('--version') || process.argv.includes('-V')) {
	process.stdout.write(`${SERVER_VERSION}\n`);
} else if (process.argv.includes('--help') || process.argv.includes('-h')) {
	process.stdout.write(`dsh-subagent-mcp ${SERVER_VERSION} —— DSH subagent 桥接的 MCP stdio server\n\n由 harness 自动拉起,一般无需手工运行。\n`);
} else {
	serve();
}
