#!/usr/bin/env node
/**
 * dsh-subagent 卸载器:把 install.mjs 写进各 harness 的 `dsh` 注册摘掉。
 *
 * 只删除键名为 dsh 的条目与带标记的指令段落,不动其他任何配置;
 * 仍会先备份(.bak-dshsubagent-<时间戳>)。
 *
 * 用法:
 *   node uninstall.mjs [--dry-run] [--purge]
 *     --purge  连 profile 与 state 一起删(默认保留,便于回滚与查账)
 *
 * @module dsh-subagent/uninstall
 */
import { existsSync, readFileSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { BRIDGE_ROOT, dshHome } from './lib/util.mjs';

const HOME = homedir();
const APPDATA = process.env.APPDATA ?? join(HOME, 'AppData', 'Roaming');
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const dryRun = process.argv.includes('--dry-run');
const purge = process.argv.includes('--purge');
const BEGIN = '<!-- dsh-subagent:begin -->';
const END = '<!-- dsh-subagent:end -->';

/** 备份并写回。 */
function rewrite(path, content) {
	if (dryRun) return;
	copyFileSync(path, `${path}.bak-dshsubagent-${STAMP}`);
	writeFileSync(path, content, 'utf8');
}

/** 从 JSON 配置里摘掉 dsh 条目。 */
function stripJson(name, path, key) {
	if (!existsSync(path)) return;
	let file;
	try {
		file = JSON.parse(readFileSync(path, 'utf8'));
	} catch {
		process.stdout.write(`  ⚠ 跳过 ${path}(JSON 无法解析)\n`);
		return;
	}
	const container = file?.[key];
	if (container === null || typeof container !== 'object' || !('dsh' in container)) {
		process.stdout.write(`  · ${name}: 无 dsh 条目\n`);
		return;
	}
	delete container.dsh;
	process.stdout.write(`  ✓ ${name}: 移除 ${key}.dsh\n`);
	if (!dryRun) rewrite(path, `${JSON.stringify(file, null, 2)}\n`);
}

/** 从 TOML 里摘掉 [mcp_servers.dsh] 段落。 */
function stripCodex() {
	const path = join(HOME, '.codex', 'config.toml');
	if (!existsSync(path)) return;
	const text = readFileSync(path, 'utf8');
	const lines = text.split(/\r?\n/);
	const start = lines.findIndex((line) => line.trim() === '[mcp_servers.dsh]');
	if (start < 0) {
		process.stdout.write('  · codex: 无 [mcp_servers.dsh]\n');
		return;
	}
	let stop = start + 1;
	while (stop < lines.length && !/^\s*\[/.test(lines[stop])) stop += 1;
	const next = [...lines.slice(0, start), ...lines.slice(stop)].join('\n').replace(/\n{3,}/g, '\n\n');
	process.stdout.write('  ✓ codex: 移除 [mcp_servers.dsh]\n');
	rewrite(path, next);
}

/** 删除带标记的指令段落。 */
function stripBlock(name, path) {
	if (!existsSync(path)) return;
	const text = readFileSync(path, 'utf8');
	const start = text.indexOf(BEGIN);
	if (start < 0) return;
	const stop = text.indexOf(END, start);
	if (stop < 0) return;
	const next = `${text.slice(0, start)}${text.slice(stop + END.length + 1)}`.replace(/\n{3,}/g, '\n\n');
	process.stdout.write(`  ✓ ${name}: 移除 dsh-subagent 指令段\n`);
	rewrite(path, next);
}

/**
 * 摘掉 GUI 观察器与悬浮卡片在 desktop profile patch 里托管的插入项。
 * 顺序很重要:插件文件没了却留着 insert,DSH Desktop 下次启动会因为
 * "failed to import loader entry" 整个插件树加载失败 —— 那就等于把 GUI 弄坏了。
 * @param label - 插件名(用于标记与提示)。
 */
function stripManagedPatch(label) {
	const patchPath = join(dshHome(), 'profiles', 'desktop', 'cordis.patch.yml');
	if (!existsSync(patchPath)) return;
	const begin = `# >>> ${label} >>>`;
	const end = `# <<< ${label} <<<`;
	const text = readFileSync(patchPath, 'utf8');
	if (!text.includes(begin) || !text.includes(end)) return;
	const next = `${text.slice(0, text.indexOf(begin))}${text.slice(text.lastIndexOf(end) + end.length)}`
		.replace(/\n{3,}/g, '\n\n');
	process.stdout.write(`  ✓ ${label}: 移除 ${patchPath} 里的插入项\n`);
	rewrite(patchPath, next);
}

process.stdout.write(`dsh-subagent 卸载器${dryRun ? '(dry-run)' : ''}\n`);
stripJson('cursor', join(HOME, '.cursor', 'mcp.json'), 'mcpServers');
stripJson('claude', join(HOME, '.claude.json'), 'mcpServers');
stripJson('claude-desktop', join(APPDATA, 'Claude', 'claude_desktop_config.json'), 'mcpServers');
stripJson('gemini', join(HOME, '.gemini', 'settings.json'), 'mcpServers');
stripJson('antigravity', join(HOME, '.gemini', 'antigravity', 'mcp_config.json'), 'mcpServers');
stripJson('kiro', join(HOME, '.kiro', 'settings', 'mcp.json'), 'mcpServers');
stripJson('qoder', join(HOME, '.qoder', 'mcp.json'), 'mcpServers');
stripJson('vscode', join(APPDATA, 'Code', 'User', 'mcp.json'), 'servers');
stripJson('copilot-cli', join(HOME, '.vscode', 'mcp.json'), 'servers');
stripJson('opencode', join(HOME, '.config', 'opencode', 'opencode.json'), 'mcp');
stripCodex();

stripBlock('claude', join(HOME, '.claude', 'CLAUDE.md'));
stripBlock('codex', join(HOME, '.codex', 'AGENTS.md'));

// GUI 观察器与悬浮卡片:必须先把 desktop profile 里托管的插入项摘掉 —— 否则插件文件
// 被删后那条 insert 会指向不存在的模块,DSH Desktop 下次启动会整棵树加载失败。
stripManagedPatch('dsh-subagent-observer');
stripManagedPatch('dsh-subagent-panel');

for (const file of [
	join(HOME, '.claude', 'agents', 'dsh.md'),
	join(HOME, '.cursor', 'rules', 'dsh-subagent.mdc'),
	join(HOME, '.local', 'bin', 'dsh-subagent.cmd'),
	join(HOME, '.local', 'bin', 'dsh-subagent-mcp.cmd'),
]) {
	if (!existsSync(file)) continue;
	process.stdout.write(`  ✓ 删除 ${file}\n`);
	if (!dryRun) rmSync(file, { force: true });
}

if (purge) {
	const profile = join(dshHome(), 'profiles', 'subagent');
	for (const target of [profile, BRIDGE_ROOT]) {
		if (!existsSync(target)) continue;
		process.stdout.write(`  ✓ 删除 ${target}\n`);
		if (!dryRun) rmSync(target, { recursive: true, force: true });
	}
} else {
	process.stdout.write(`  · 保留 ${join(dshHome(), 'profiles', 'subagent')} 与 ${BRIDGE_ROOT}(加 --purge 可一并删除)\n`);
}

process.stdout.write(`${dryRun ? '(dry-run:没有真正写入)\n' : '卸载完成。重启各 harness 后生效。\n'}`);
void dirname;
