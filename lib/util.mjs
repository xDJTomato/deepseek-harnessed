/**
 * 桥接层通用工具:路径、id、JSON 读写、并发闸门。
 * @module dsh-subagent/lib/util
 */
import { mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, renameSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 桥接层根目录(<DSH_HOME>/subagent)。 */
export const BRIDGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** DSH home:显式环境变量优先,否则 ~/.dsh。 */
export function dshHome() {
	const explicit = process.env.DSH_HOME;
	if (typeof explicit === 'string' && explicit.trim() !== '') return resolve(explicit.trim());
	return join(homedir(), '.dsh');
}

/** 任务状态目录(<DSH_HOME>/subagent/state/tasks)。 */
export function tasksRoot() {
	return join(dshHome(), 'subagent', 'state', 'tasks');
}

/** 单个任务的目录。 */
export function taskDir(id) {
	return join(tasksRoot(), id);
}

/** 确保目录存在并返回它。 */
export function ensureDir(path) {
	mkdirSync(path, { recursive: true });
	return path;
}

/** 生成任务 id:可排序、可读、带随机后缀。 */
export function newTaskId() {
	const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
	return `${stamp}-${randomUUID().slice(0, 8)}`;
}

/** 读 JSON;文件不存在或损坏时返回 fallback。 */
export function readJson(path, fallback = undefined) {
	try {
		return JSON.parse(readFileSync(path, 'utf8'));
	} catch {
		return fallback;
	}
}

/** 原子写 JSON(先写临时文件再改名;Windows 上改名覆盖需先删目标)。 */
export function writeJson(path, value) {
	ensureDir(dirname(path));
	const text = `${JSON.stringify(value, null, 2)}\n`;
	const tmp = `${path}.tmp-${process.pid}`;
	writeFileSync(tmp, text, 'utf8');
	try {
		renameSync(tmp, path);
	} catch {
		try {
			unlinkSync(path);
			renameSync(tmp, path);
		} catch {
			writeFileSync(path, text, 'utf8');
		}
	}
}

/** 读文本文件;不存在时返回空串。 */
export function readText(path) {
	try {
		return readFileSync(path, 'utf8');
	} catch {
		return '';
	}
}

/** 写文本文件。 */
export function writeText(path, content) {
	ensureDir(dirname(path));
	writeFileSync(path, content, 'utf8');
}

/** 截断过长文本(保留头部与尾部),用于回传给 harness 的上下文控制。 */
export function clip(text, maxChars) {
	if (typeof text !== 'string') return '';
	if (maxChars <= 0 || text.length <= maxChars) return text;
	const head = Math.floor(maxChars * 0.6);
	const tail = maxChars - head;
	return `${text.slice(0, head)}\n\n…[已截断 ${text.length - maxChars} 字符]…\n\n${text.slice(text.length - tail)}`;
}

/** 进程是否还活着(Windows 上 signal 0 即存在性检查)。 */
export function processAlive(pid) {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error?.code === 'EPERM';
	}
}

/** 列出目录下的条目(不存在时返回空数组)。 */
export function listDir(path) {
	try {
		return readdirSync(path).map((name) => ({ name, path: join(path, name) }));
	} catch {
		return [];
	}
}

/** 文件 mtime(毫秒),不存在返回 0。 */
export function mtimeMs(path) {
	try {
		return statSync(path).mtimeMs;
	} catch {
		return 0;
	}
}

/** 一个极小的并发闸门:限制同时运行的 DSH 实例数。 */
export class Gate {
	constructor(limit) {
		this.limit = Number.isInteger(limit) && limit > 0 ? limit : 4;
		this.active = 0;
		this.queue = [];
	}
	/**
	 * 取得一个名额。
	 * @returns 归还名额的函数(幂等)。
	 */
	async acquire() {
		if (this.active >= this.limit) {
			await new Promise((release) => this.queue.push(release));
		}
		this.active += 1;
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.active -= 1;
			const next = this.queue.shift();
			if (next !== undefined) next();
		};
	}
	async run(task) {
		const release = await this.acquire();
		try {
			return await task();
		} finally {
			release();
		}
	}
}
