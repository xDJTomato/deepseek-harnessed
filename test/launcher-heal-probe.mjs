/**
 * 垫片入口自愈探针:DSH Desktop 换打包形态后,`dsh.cmd` 垫片里的入口路径失效不再变成
 * "派活静默失败"。
 *
 * 真实故障(2026-09-18 实测):DSH Desktop 更新后打包入口从 `resources\app.asar\lib\desktop-cli.js`
 * 变成 `resources\app\lib\desktop-cli.js`,而 `dsh.cmd` 垫片还是上一次安装时写的。于是每次经垫片
 * 调 dsh 都在 0.8 秒内以 `Error: Cannot find module '…\app.asar\lib\desktop-cli.js'` + exit 1 死掉。
 * `lib/launcher.mjs` 原先直接把垫片里的参数拿去 spawn,不做入口存在性校验,故障就以底层
 * MODULE_NOT_FOUND 的形式冒出来(看起来像"任务被静默吞了")。
 *
 * 这个探针只读文件系统、不 spawn 任何东西,断言四组:
 *   A. 垫片指向不存在的 app.asar 入口、而 resources\app\lib 下真有 → 自愈改指存在的那个,
 *      其余参数与顺序一字不动(候选优先级:app 先于 app.asar.unpacked);
 *   B. 一个候选都没有 → **响亮报错**,且错误里含垫片路径、缺失入口、候选清单与处置办法;
 *   C. exe 不在安装根时,靠 `app.asar` ↔ `app` 互换命中同一位置;
 *   D. 本机真实垫片解析出的入口必须真实存在(修好之前这条就是红的)。
 *
 * 夹具目录按用户约定放在 %TEMP%\dsh-launcher-test-<随机后缀>,**测试结束不删除**(要清理请移到 D:\Stash)。
 *
 * 用法:
 *   node test/launcher-heal-probe.mjs
 */
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveLauncher } from '../lib/launcher.mjs';

let total = 0;
let passed = 0;
function check(name, ok, detail = '') {
	total += 1;
	if (ok) passed += 1;
	console.log(`${ok ? '✅' : '❌'} ${name}${detail === '' ? '' : `  (${detail})`}`);
}

const fixtures = mkdtempSync(join(tmpdir(), 'dsh-launcher-test-'));
console.log(`夹具目录(按约定保留,不删除): ${fixtures}\n`);

/**
 * 在 `dir` 下造一个只指向该目录的 dsh 垫片,并把 DSH_SUBAGENT_DSH_SHIM 指过去。
 * @returns {{shim:string, missingEntry:string}} 垫片路径与"垫片里写的、但不存在"的入口路径
 */
function useShim(dir, exe, missingEntry, tail = []) {
	mkdirSync(dir, { recursive: true });
	const shim = join(dir, 'dsh.cmd');
	writeFileSync(shim, [
		'@echo off',
		'setlocal DisableDelayedExpansion',
		'set "ELECTRON_RUN_AS_NODE=1"',
		'set "DSH_HOME=C:\\fake-from-fixture\\.dsh"',
		`"${exe}" --expose-internals "${missingEntry}"${tail.map((arg) => ` ${arg}`).join('')} %*`,
		'exit /b %errorlevel%',
		'',
	].join('\r\n'), 'utf8');
	process.env.DSH_SUBAGENT_DSH_SHIM = shim;
	return { shim, missingEntry };
}

/** 造一个"存在"的入口文件。 */
function makeEntry(path) {
	mkdirSync(join(path, '..'), { recursive: true });
	writeFileSync(path, '// fixture entry\n', 'utf8');
	return path;
}

// ---- 用例 A:垫片入口失效 + resources\app\lib 下有真入口 → 自愈 ----
const rootA = join(fixtures, 'case-a');
const exeA = join(rootA, 'DSH Desktop.exe');
const goodA = makeEntry(join(rootA, 'resources', 'app', 'lib', 'desktop-cli.js'));
// 顺手把"候选清单里靠后的那个"也造出来:自愈必须取**第一个**存在的候选(app 先于 app.asar.unpacked)
makeEntry(join(rootA, 'resources', 'app.asar.unpacked', 'lib', 'desktop-cli.js'));
const caseA = useShim(rootA, exeA, join(rootA, 'resources', 'app.asar', 'lib', 'desktop-cli.js'), ['--some-extra']);
const launcherA = resolveLauncher();
check('A 入口自愈到真实存在的 resources\\app\\lib\\desktop-cli.js',
	launcherA.args[1] === goodA, `args[1]=${launcherA.args[1]}`);
check('A 自愈后的入口文件确实存在', existsSync(launcherA.args[1]) && existsSync(goodA), `存在=${existsSync(launcherA.args[1])}`);
check('A 其余参数与顺序一字不动',
	JSON.stringify(launcherA.args) === JSON.stringify(['--expose-internals', goodA, '--some-extra']),
	JSON.stringify(launcherA.args));
check('A command / env / shim 不变',
	launcherA.command === exeA && launcherA.env.ELECTRON_RUN_AS_NODE === '1' && launcherA.shim === caseA.shim,
	`command=${launcherA.command} env=${JSON.stringify(launcherA.env)}`);

// ---- 用例 B:一个候选都不存在 → 响亮报错(不静默降级、不伪造成功) ----
const rootB = join(fixtures, 'case-b');
const caseB = useShim(rootB, join(rootB, 'DSH Desktop.exe'), join(rootB, 'resources', 'app.asar', 'lib', 'desktop-cli.js'));
let errorB = null;
try {
	resolveLauncher();
} catch (error) {
	errorB = error;
}
const messageB = errorB === null ? '' : errorB.message;
check('B 一个候选都不存在时抛错(没有静默降级)', errorB !== null, messageB.split('\n')[0]);
check('B 错误里含缺失入口路径', messageB.includes(caseB.missingEntry), caseB.missingEntry);
check('B 错误里含垫片路径', messageB.includes(caseB.shim), caseB.shim);
check('B 错误里含已尝试的候选清单与处置办法',
	/已尝试的候选/.test(messageB) && /垫片/.test(messageB) && messageB.includes(join(rootB, 'resources', 'app', 'lib')),
	messageB.split('\n').slice(2).join(' / '));

// ---- 用例 C:exe 不在安装根 → 靠 app.asar ↔ app 互换命中同一位置 ----
const rootC = join(fixtures, 'case-c');
const exeC = join(rootC, 'resources', 'DSH Desktop.exe');
const goodC = makeEntry(join(rootC, 'resources', 'app', 'lib', 'desktop-cli.js'));
useShim(rootC, exeC, join(rootC, 'resources', 'app.asar', 'lib', 'desktop-cli.js'));
const launcherC = resolveLauncher();
check('C 靠 app.asar→app 互换命中', launcherC.args[1] === goodC, `args[1]=${launcherC.args[1]}`);

// ---- 用例 D:本机真实垫片解析出的入口必须真实存在 ----
delete process.env.DSH_SUBAGENT_DSH_SHIM;
try {
	const real = resolveLauncher();
	const entry = real.args.find((arg) => /\.m?js$/i.test(arg));
	check('D 本机真实垫片的入口文件真实存在',
		typeof entry === 'string' && existsSync(entry), `${real.shim} → ${String(entry)}`);
} catch (error) {
	check('D 本机真实垫片的入口文件真实存在', false, `解析失败:${error.message}`);
}

console.log(`\n${passed}/${total} 通过`);
console.log(`夹具保留在: ${fixtures}(按用户约定不删除;要清理请移到 D:\\Stash)`);
process.exit(passed === total ? 0 : 1);
