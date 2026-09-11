/**
 * 直接驱动 tasks 层的小测试:验证 startTask / waitForTask 真的会等待。
 * node test/tasks-probe.mjs
 */
import { startTask, waitForTask, listTasks } from '../lib/tasks.mjs';

const started = await startTask({
	prompt: '回答两个字:收到',
	workspace: process.argv[2] ?? 'D:\\dsh-subagent-selftest',
	expectedSeconds: 120,
	caller: 'probe',
});
console.log('started:', started.id, 'pid=', started.record.pid, 'typeof done=', typeof started.done);
const t0 = Date.now();
const state = await waitForTask(started.id, 120000);
console.log('waitForTask returned after', ((Date.now() - t0) / 1000).toFixed(1), 's status=', state.status, 'error=', state.error);
console.log('result head:', (state.result ?? '').slice(0, 120));
console.log('recent:', listTasks(3).map((t) => `${t.id}:${t.status}`).join(', '));
