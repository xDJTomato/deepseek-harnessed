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
 * 这个探针只读文件系统、不 spawn 任何东西(并把 PATH/APPDATA 收紧到夹具里,否则本机真实的
 * dsh.cmd 会顶上来),断言五组:
 *   A. 垫片指向不存在的 app.asar 入口、而 resources\app\lib 下真有 → 自愈改指存在的那个,
 *      其余参数与顺序一字不动(候选优先级:app 先于 app.asar.unpacked);
 *   B. 所有候选都失效 → **聚合报错**,逐条列出每个垫片为什么不行,并给出处置办法;
 *   C. exe 不在安装根时,靠 `app.asar` ↔ `app` 互换命中同一位置;
 *   D. 候选 1 是入口失效的陈旧残留、候选 2 可用 → **回退到候选 2 并成功**
 *      (一个残留垫片不该埋掉本机其它可用的 dsh);
 *   E. 本机真实垫片解析出的入口必须真实存在(修好之前这条就是红的)。
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

const REAL_ENV = { PATH: process.env.PATH, APPDATA: process.env.APPDATA, SHIM: process.env.DSH_SUBAGENT_DSH_SHIM };

/** 把解析面收紧到夹具里:只留显式指定的候选 1 与候选 2。 */
function isolateEnv({ shim, appData }) {
	if (shim === undefined) delete process.env.DSH_SUBAGENT_DSH_SHIM;
	else process.env.DSH_SUBAGENT_DSH_SHIM = shim;
	if (appData === undefined) delete process.env.APPDATA;
	else process.env.APPDATA = appData;
	process.env.PATH = '';
}

/** 恢复本机真实环境(最后一个用例要解析真实垫片)。 */
function restoreEnv() {
	const saved = { PATH: REAL_ENV.PATH, APPDATA: REAL_ENV.APPDATA, DSH_SUBAGENT_DSH_SHIM: REAL_ENV.SHIM };
	for (const [key, value] of Object.entries(saved)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
}

/** 在 `dir` 下写一份 dsh.cmd 垫片,返回它的路径(不设置环境变量)。 */
function writeShim(dir, exe, entry, tail = []) {
	mkdirSync(dir, { recursive: true });
	const shim = join(dir, 'dsh.cmd');
	writeFileSync(shim, [
		'@echo off',
		'setlocal DisableDelayedExpansion',
		'set "ELECTRON_RUN_AS_NODE=1"',
		'set "DSH_HOME=C:\\fake-from-fixture\\.dsh"',
		`"${exe}" --expose-internals "${entry}"${tail.map((arg) => ` ${arg}`).join('')} %*`,
		'exit /b %errorlevel%',
		'',
	].join('\r\n'), 'utf8');
	return shim;
}

/** 按 APPDATA 惯例写一份垫片(= 解析时的候选 2)。 */
function appDataShim(appData, exe, entry) {
	return writeShim(join(appData, 'DSH Desktop', 'host-commands', 'desktop', 'bin'), exe, entry);
}

/**
 * 写一份垫片、把它设成候选 1(DSH_SUBAGENT_DSH_SHIM),并把环境收紧。
 * @returns {{shim:string, missingEntry:string}} 垫片路径与"垫片里写的、但不存在"的入口路径
 */
function useShim(dir, exe, missingEntry, tail = []) {
	const shim = writeShim(dir, exe, missingEntry, tail);
	isolateEnv({ shim });
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

// ---- 用例 B:所有候选都失效 → 聚合报错(不静默降级、不伪造成功) ----
const rootB = join(fixtures, 'case-b');
const missingB1 = join(rootB, 'stale-shim', 'resources', 'app.asar', 'lib', 'desktop-cli.js');
const envShimB = writeShim(join(rootB, 'stale-shim'), join(rootB, 'stale-shim', 'DSH Desktop.exe'), missingB1);
const appDataB = join(rootB, 'appdata');
const missingB2 = join(rootB, 'appdata-install', 'resources', 'app.asar', 'lib', 'desktop-cli.js');
const appDataShimB = appDataShim(appDataB, join(rootB, 'appdata-install', 'DSH Desktop.exe'), missingB2);
isolateEnv({ shim: envShimB, appData: appDataB });
let errorB = null;
try {
	resolveLauncher();
} catch (error) {
	errorB = error;
}
const messageB = errorB === null ? '' : errorB.message;
check('B 所有候选都失效时抛聚合错(没有静默降级)', errorB !== null, messageB.split('\n')[0]);
check('B 逐条列出候选 1 的原因(含缺失入口路径)', messageB.includes(missingB1), missingB1);
check('B 逐条列出候选 2 的原因(两个垫片路径都在)',
	messageB.includes(envShimB) && messageB.includes(appDataShimB), appDataShimB);
check('B 每个候选都带上"已尝试的候选"清单',
	(messageB.match(/已尝试的候选/g) ?? []).length >= 2, `出现 ${(messageB.match(/已尝试的候选/g) ?? []).length} 次`);
check('B 给出处置办法(修垫片 / 删掉让其重建 / 显式指定)',
	/处置/.test(messageB) && /重建/.test(messageB) && messageB.includes('DSH_SUBAGENT_DSH_SHIM'),
	messageB.split('\n').slice(-3, -1).join(' / '));

// ---- 用例 C:exe 不在安装根 → 靠 app.asar ↔ app 互换命中同一位置 ----
const rootC = join(fixtures, 'case-c');
const exeC = join(rootC, 'resources', 'DSH Desktop.exe');
const goodC = makeEntry(join(rootC, 'resources', 'app', 'lib', 'desktop-cli.js'));
useShim(rootC, exeC, join(rootC, 'resources', 'app.asar', 'lib', 'desktop-cli.js'));
const launcherC = resolveLauncher();
check('C 靠 app.asar→app 互换命中', launcherC.args[1] === goodC, `args[1]=${launcherC.args[1]}`);

// ---- 用例 D:候选 1 是失效残留、候选 2 可用 → 回退到候选 2(不是硬失败) ----
const rootD = join(fixtures, 'case-d');
const staleShimD = writeShim(join(rootD, 'stale-shim'), join(rootD, 'stale-shim', 'DSH Desktop.exe'), join(rootD, 'stale-shim', 'resources', 'app.asar', 'lib', 'desktop-cli.js'));
const appDataD = join(rootD, 'appdata');
const goodEntryD = makeEntry(join(rootD, 'good-install', 'resources', 'app', 'lib', 'desktop-cli.js'));
const goodShimD = appDataShim(appDataD, join(rootD, 'good-install', 'DSH Desktop.exe'), goodEntryD);
isolateEnv({ shim: staleShimD, appData: appDataD });
// 拿 try 包住:这条用例想要的正是"回退成功",一旦抛错就是回归 —— 报 ❌,不要让探针自己崩掉
let launcherD = null;
let errorD = '';
try {
	launcherD = resolveLauncher();
} catch (error) {
	errorD = error.message;
}
check('D 候选 1 入口失效时回退到候选 2(一个陈旧残留不该硬失败)',
	launcherD !== null && launcherD.shim === goodShimD && launcherD.args[1] === goodEntryD,
	launcherD === null ? `抛错了(硬失败):${errorD.split('\n')[0]}` : `shim=${launcherD.shim}`);
check('D 回退后的入口文件确实存在',
	launcherD !== null && existsSync(launcherD.args[1]), launcherD === null ? '同上' : launcherD.args[1]);

// ---- 用例 E:本机真实垫片解析出的入口必须真实存在 ----
restoreEnv();
try {
	const real = resolveLauncher();
	const entry = real.args.find((arg) => /\.m?js$/i.test(arg));
	check('E 本机真实垫片的入口文件真实存在',
		typeof entry === 'string' && existsSync(entry), `${real.shim} → ${String(entry)}`);
} catch (error) {
	check('E 本机真实垫片的入口文件真实存在', false, `解析失败:${error.message}`);
}

console.log(`\n${passed}/${total} 通过`);
console.log(`夹具保留在: ${fixtures}(按用户约定不删除;要清理请移到 D:\\Stash)`);
process.exit(passed === total ? 0 : 1);
