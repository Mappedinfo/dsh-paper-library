import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkerScheduler } from '../src/worker-scheduler.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
function fixture(options = {}) {
  let time = 0, next = 0;
  const timers = new Map();
  const scheduler = createWorkerScheduler({ ...options, now: () => time,
    setTimer: (fn, delay) => { const id = ++next; timers.set(id, { fn, at: time + delay }); return id; },
    clearTimer: id => timers.delete(id) });
  return { ...scheduler, async advance(ms) {
    time += ms;
    for (const [id, timer] of timers) if (timer.at <= time) { timers.delete(id); timer.fn(); }
    await tick();
  } };
}

test('foreground overtakes queued background; each idle gap is at least 750 ms', async () => {
  const f = fixture(), order = [], first = deferred();
  const a = f.schedule(() => { order.push('write'); return first.promise; });
  const b = f.schedule(() => order.push('scan'), { priority: 'background' });
  const c = f.schedule(() => order.push('preview'), { priority: 'background' });
  const d = f.schedule(() => order.push('page'));
  await tick(); assert.deepEqual(order, ['write']);
  first.resolve(); await a; await d;
  assert.deepEqual(order, ['write', 'page']);
  await f.advance(749); assert.equal(order.length, 2);
  await f.advance(1); await b; assert.deepEqual(order, ['write', 'page', 'scan']);
  await f.advance(749); assert.equal(order.length, 3);
  await f.advance(1); await c;
  assert.deepEqual(order, ['write', 'page', 'scan', 'preview']);
});

test('foreground runs immediately during background cooldown and restarts idle gap', async () => {
  const f = fixture(), order = [];
  const low = f.schedule(() => order.push('low'), { priority: 'background' });
  await f.advance(600);
  await f.schedule(() => order.push('foreground'));
  await f.advance(150); assert.deepEqual(order, ['foreground']);
  await f.advance(600); await low; assert.deepEqual(order, ['foreground', 'low']);
});

test('same keyed scan shares queued and running work, then releases dedupe key', async () => {
  const f = fixture(), gate = deferred(); let runs = 0;
  const run = () => { runs++; return gate.promise; };
  const a = f.schedule(run, { priority: 'background', key: 'library:paper:page1' });
  const b = f.schedule(run, { priority: 'background', key: 'library:paper:page1' });
  assert.equal(f.snapshot().background, 1);
  await f.advance(750);
  const c = f.schedule(run, { priority: 'background', key: 'library:paper:page1' });
  gate.resolve({ found: 3 });
  assert.deepEqual(await Promise.all([a, b, c]), [{ found: 3 }, { found: 3 }, { found: 3 }]);
  assert.equal(runs, 1);
  const d = f.schedule(run, { priority: 'background', key: 'library:paper:page1' });
  await f.advance(750); await d; assert.equal(runs, 2);
});

test('aborted queued job never starts and does not block following jobs', async () => {
  const f = fixture(), controller = new AbortController(); let starts = 0;
  const promise = f.schedule(() => starts++, { priority: 'background', signal: controller.signal });
  const rejected = assert.rejects(promise, { code: 'ABORT_ERR' });
  controller.abort(); await rejected;
  await f.advance(1000);
  assert.equal(starts, 0); assert.equal(f.snapshot().background, 0);
  assert.equal(await f.schedule(() => 'ok'), 'ok');
  await assert.rejects(f.schedule(() => assert.fail('already aborted'), { signal: controller.signal }), { code: 'ABORT_ERR' });
});

test('canceling one deduplicated waiter does not cancel remaining subscribers', async () => {
  const f = fixture(), controller = new AbortController(), gate = deferred(); let signal;
  const a = f.schedule(context => { signal = context.signal; return gate.promise; },
    { priority: 'background', key: 'shared', signal: controller.signal, cancelRunning: true });
  const b = f.schedule(() => assert.fail('duplicate'), { priority: 'background', key: 'shared' });
  await f.advance(750);
  const rejected = assert.rejects(a, { code: 'ABORT_ERR' }); controller.abort(); await rejected;
  assert.equal(signal.aborted, false);
  gate.resolve('retained'); assert.equal(await b, 'retained');
});

test('canceling an active write never kills it or releases its single-worker slot early', async () => {
  const f = fixture(), controller = new AbortController(), gate = deferred(); let signal, nextStarted = false;
  const write = f.schedule(context => { signal = context.signal; return gate.promise; }, { signal: controller.signal });
  await tick();
  const next = f.schedule(() => { nextStarted = true; });
  const rejected = assert.rejects(write, /仍将安全完成/); controller.abort(); await rejected;
  assert.equal(signal.aborted, false); assert.equal(nextStarted, false);
  gate.resolve(); await next; assert.equal(nextStarted, true);
});

test('last canceled scan waiter may abort scan but waits for process exit before next work', async () => {
  const f = fixture(), controller = new AbortController(), processExit = deferred(); let signal, nextStarted = false;
  const scan = f.schedule(context => { signal = context.signal; return processExit.promise; },
    { priority: 'background', signal: controller.signal, cancelRunning: true, key: 'scan' });
  await f.advance(750);
  const next = f.schedule(() => { nextStarted = true; });
  const rejected = assert.rejects(scan, { code: 'ABORT_ERR' }); controller.abort(); await rejected;
  assert.equal(signal.aborted, true); assert.equal(nextStarted, false);
  processExit.reject(new Error('process stopped')); await next;
  assert.equal(nextStarted, true);
});

test('queue and same-job subscribers are bounded; foreground has reserved admission', async () => {
  const f = fixture({ maxQueued: 2, maxBackgroundQueued: 1, maxWaiters: 2 }), gate = deferred();
  const active = f.schedule(() => gate.promise);
  const low = f.schedule(() => 'low', { priority: 'background', key: 'one' });
  const shared = f.schedule(() => 'unused', { priority: 'background', key: 'one' });
  await assert.rejects(f.schedule(() => 0, { priority: 'background', key: 'one' }), { code: 'WORKER_QUEUE_FULL' });
  await assert.rejects(f.schedule(() => 0, { priority: 'background', key: 'two' }), { code: 'WORKER_QUEUE_FULL' });
  const front = f.schedule(() => 'front');
  await assert.rejects(f.schedule(() => 0), { code: 'WORKER_QUEUE_FULL' });
  gate.resolve(); await active; await front; await f.advance(750);
  assert.deepEqual(await Promise.all([low, shared]), ['low', 'low']);
});

test('failures release worker capacity and do not poison subsequent work', async () => {
  const f = fixture();
  await assert.rejects(f.schedule(() => { throw new Error('synthetic failure'); }), /synthetic failure/);
  assert.equal(await f.schedule(() => 4), 4);
  assert.deepEqual(f.snapshot(), { active: null, foreground: 0, background: 0, waiters: 0 });
});

test('reloaded module shares the process-wide singleton', async () => {
  const first = await import('../src/worker-scheduler.mjs');
  const reloaded = await import('../src/worker-scheduler.mjs?synthetic-reload');
  assert.equal(first.workerScheduler, reloaded.workerScheduler);
});

async function fakeWorker(t) {
  const directory = await mkdtemp(join(tmpdir(), 'paper-worker-synthetic-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const python = join(directory, 'worker'), log = join(directory, 'runs.jsonl');
  await writeFile(python, `#!${process.execPath}
import { appendFileSync } from 'node:fs';
if (process.argv.includes('-c')) process.exit(0);
let text = ''; for await (const chunk of process.stdin) text += chunk;
const request = JSON.parse(text);
appendFileSync(${JSON.stringify(log)}, JSON.stringify({action:request.action,id:request.id})+'\\n');
if(request.id === 'ignore-term') {
  process.on('SIGTERM', () => {});
  setInterval(() => {}, 1000);
} else {
  setTimeout(() => process.stdout.write(JSON.stringify({ok:true,result:{action:request.action,id:request.id}})), 20);
}
`, { mode: 0o700 });
  const runs = async () => { try { return (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse); } catch { return []; } };
  return { options: { python, library: join(directory, 'library') }, runs };
}

test('bridge canonicalizes scan params and foreground list overtakes duplicate scan', async t => {
  const { core } = await import('../src/bridge.mjs');
  const f = await fakeWorker(t);
  const a = core({ action: 'document_elements_scan', id: 'paper', pages: [1, 2] }, f.options);
  const b = core({ pages: [1, 2], id: 'paper', action: 'document_elements_scan' }, f.options);
  await core({ action: 'document_elements_list', id: 'paper' }, f.options);
  assert.deepEqual((await f.runs()).map(run => run.action), ['document_elements_list']);
  assert.deepEqual(await a, await b);
  assert.deepEqual((await f.runs()).map(run => run.action), ['document_elements_list', 'document_elements_scan']);
});

test('bridge abort escalates only background scan and waits for its exit before foreground', async t => {
  const { core } = await import('../src/bridge.mjs');
  const f = await fakeWorker(t), controller = new AbortController();
  const scan = core({ action: 'document_elements_scan', id: 'ignore-term' }, { ...f.options, signal: controller.signal });
  const rejected = assert.rejects(scan, { code: 'ABORT_ERR' });
  const until = Date.now() + 5000;
  while (!(await f.runs()).length && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal((await f.runs())[0]?.id, 'ignore-term');
  // 启动日志先于 SIGTERM handler 注册；让测试 worker 完成启动。
  await new Promise(resolve => setTimeout(resolve, 50));
  const foreground = core({ action: 'annotations', id: 'next' }, f.options);
  controller.abort(); await rejected;
  assert.equal((await f.runs()).length, 1);
  assert.equal((await foreground).id, 'next');
  assert.equal((await f.runs()).length, 2);
});

test('internal analysis priority yields; request payload cannot change priority; status stays foreground', async t => {
  const { core } = await import('../src/bridge.mjs');
  const f = await fakeWorker(t);
  const analysis = core({ action: 'paper_analysis_batch', id: 'analysis', workerPriority: 'foreground' },
    { ...f.options, workerPriority: 'background' });
  const reading = core({ action: 'annotations', id: 'reading', workerPriority: 'background' }, f.options);
  const status = core({ action: 'status', id: 'status' }, { ...f.options, workerPriority: 'background' });
  await reading; await status;
  assert.deepEqual((await f.runs()).map(run => run.id), ['reading', 'status']);
  await analysis;
  assert.deepEqual((await f.runs()).map(run => run.id), ['reading', 'status', 'analysis']);
});


test('configured per-job background cooldown still yields to foreground',async()=>{const f=fixture(),order=[];const low=f.schedule(()=>order.push('background'),{priority:'background',cooldownMs:250});await f.advance(200);assert.deepEqual(order,[]);await f.schedule(()=>order.push('foreground'));await f.advance(249);assert.deepEqual(order,['foreground']);await f.advance(1);await low;assert.deepEqual(order,['foreground','background']);});
