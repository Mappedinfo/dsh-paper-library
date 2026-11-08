// 一个进程同时只运行一个文献/引用 worker。后台读取让出交互空闲时间。
export function createWorkerScheduler({
  cooldownMs = 750, maxQueued = 64, maxBackgroundQueued = 16, maxWaiters = 64,
  now = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout,
} = {}) {
  const foreground = [], background = [], keyed = new Map();
  let active = null, timer = null, idleSince = now();

  function error(message, code) { return Object.assign(new Error(message), { code }); }
  function settle(waiter, failed, result) {
    waiter.signal?.removeEventListener('abort', waiter.abort);
    (failed ? waiter.reject : waiter.resolve)(result);
  }
  function removeQueued(job) {
    const queue = job.priority === 'background' ? background : foreground;
    const index = queue.indexOf(job);
    if (index >= 0) queue.splice(index, 1);
    if (job.key && keyed.get(job.key) === job) keyed.delete(job.key);
  }
  function pump() {
    if (timer !== null) { clearTimer(timer); timer = null; }
    if (active) return;
    let job = foreground.shift();
    if (!job && background.length) {
      const wait = Math.max(0, idleSince + (background[0].cooldownMs ?? cooldownMs) - now());
      if (wait > 0) { timer = setTimer(() => { timer = null; pump(); }, wait); return; }
      job = background.shift();
    }
    if (!job) return;
    active = job;
    job.started = true;
    Promise.resolve().then(() => job.run({ signal: job.controller.signal })).then(
      result => finish(job, false, result), failure => finish(job, true, failure),
    );
  }
  function finish(job, failed, result) {
    if (job.key && keyed.get(job.key) === job) keyed.delete(job.key);
    for (const waiter of job.waiters) settle(waiter, failed, result);
    job.waiters.clear();
    active = null;
    idleSince = now();
    pump();
  }
  function schedule(run, { priority = 'foreground', key, signal, cancelRunning = false, cooldownMs: requestedCooldown } = {}) {
    if (signal?.aborted) return Promise.reject(error('操作已取消。', 'ABORT_ERR'));
    const low = priority === 'background';
    let job = key ? keyed.get(key) : undefined;
    if (job?.controller.signal.aborted) job = undefined;
    if (job && job.waiters.size >= maxWaiters) return Promise.reject(error('相同任务的等待窗口过多，请稍后重试。', 'WORKER_QUEUE_FULL'));
    if (!job) {
      if (foreground.length + background.length >= maxQueued || (low && background.length >= maxBackgroundQueued)) {
        return Promise.reject(error('文献处理队列已满，请等待当前操作完成后重试。', 'WORKER_QUEUE_FULL'));
      }
      job = { run, priority: low ? 'background' : 'foreground', key, controller: new AbortController(),
        started: false, cancelRunning, cooldownMs:Number.isFinite(requestedCooldown)?Math.max(250,Math.min(10000,requestedCooldown)):undefined, waiters: new Set() };
      if (key) keyed.set(key, job);
      (low ? background : foreground).push(job);
    }
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, signal, abort: null };
      waiter.abort = () => {
        if (!job.waiters.delete(waiter)) return;
        const message = job.started && !job.cancelRunning ? '已取消等待；已开始的操作仍将安全完成。' : '操作已取消。';
        settle(waiter, true, error(message, 'ABORT_ERR'));
        if (!job.waiters.size) {
          if (!job.started) removeQueued(job);
          else if (job.cancelRunning) {
            job.controller.abort();
            if (job.key && keyed.get(job.key) === job) keyed.delete(job.key);
          }
        }
        pump();
      };
      job.waiters.add(waiter);
      signal?.addEventListener('abort', waiter.abort, { once: true });
      // 覆盖注册监听前 signal 已变化的调用方实现。
      if (signal?.aborted) waiter.abort();
      pump();
    });
  }
  return { schedule, snapshot: () => ({ active: active ? active.priority : null,
    foreground: foreground.length, background: background.length,
    waiters: [...foreground, ...background, ...(active ? [active] : [])].reduce((n, job) => n + job.waiters.size, 0) }) };
}

// 热重载或同进程的多个插件入口仍共享一个 worker 并发额度。
const schedulerSymbol = Symbol.for('mappedinfo.paper-library.worker-scheduler.v1');
export const workerScheduler = globalThis[schedulerSymbol] ||= createWorkerScheduler();
