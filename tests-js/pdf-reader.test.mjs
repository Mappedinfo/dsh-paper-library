import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
const context = vm.createContext({ window: {} });
vm.runInContext(await readFile(new URL('../web/pdf-reader.js', import.meta.url), 'utf8'), context);
const { createPageWindow, validateLayout, pageMetrics, pageAt, visibleWindow, mergeSelection } = context.window.PaperPDFReader;
const plain = value => JSON.parse(JSON.stringify(value));
const flush = () => new Promise(resolve => setImmediate(resolve));
function scheduler({ delayedInstall = false } = {}) {
  const requests = [], installed = new Map(), decoded = [], errors = [], evicted = [];
  let inFlight = 0, peakInFlight = 0, peakResident = 0;
  const queue = createPageWindow({
    load: job => new Promise((resolve, reject) => { inFlight++; peakInFlight = Math.max(peakInFlight, inFlight); requests.push({ ...job, resolve: result => { inFlight--; resolve(result ?? { ...job }); }, reject: error => { inFlight--; reject(error); } }); }),
    install: (page, result) => { installed.set(page, result); peakResident = Math.max(peakResident, installed.size); return delayedInstall ? new Promise((resolve, reject) => decoded.push({ page, resolve, reject })) : undefined; },
    evict: page => { installed.delete(page); evicted.push(page); },
    onError: (page, error) => errors.push({ page, error }),
  });
  return { queue, requests, installed, decoded, errors, evicted, peaks: () => ({ inFlight: peakInFlight, resident: peakResident }) };
}

test('continuous renderer prioritizes latest viewport and holds at most three pages plus one serial request', async () => {
  const h = scheduler(); h.queue.reset('paper-a'); h.queue.want([1, 2, 3]);
  const oldReady = h.queue.ready(1); assert.equal(h.requests.length, 1);
  h.queue.want([10, 11, 9]); assert.equal(await oldReady, false);
  h.requests[0].resolve(); await flush(); assert.deepEqual([...h.installed.keys()], []); assert.equal(h.requests[1].page, 10);
  const ready = h.queue.ready(10); h.requests[1].resolve(); assert.equal(await ready, true); await flush();
  h.requests[2].resolve(); await flush(); h.requests[3].resolve(); await h.queue.idle();
  assert.deepEqual(plain(h.queue.snapshot().residents), [10, 11, 9]);
  h.queue.want([20, 21, 19]); assert.equal(h.installed.size, 0); assert.equal(h.requests.length, 5);
  h.requests[4].resolve(); await flush(); h.requests[5].resolve(); await flush(); h.requests[6].resolve(); await h.queue.idle();
  assert.deepEqual(h.peaks(), { inFlight: 1, resident: 3 });
});

test('paper switches and disposal discard obsolete raster responses without writing into another paper', async () => {
  const h = scheduler(); h.queue.reset('old'); h.queue.want([1]); const old = h.queue.ready(1);
  h.queue.reset('new'); h.queue.want([1]); assert.equal(await old, false); assert.equal(h.requests.length, 1);
  h.requests[0].resolve(); await flush(); assert.equal(h.installed.size, 0); assert.equal(h.requests[1].id, 'new');
  h.requests[1].resolve(); await h.queue.idle(); assert.equal(h.installed.get(1).id, 'new');
  h.queue.want([2]); const pending = h.queue.ready(2); h.queue.dispose(); assert.equal(await pending, false); h.requests[2].resolve(); await h.queue.idle(); assert.equal(h.installed.size, 0); assert.deepEqual(h.errors, []);
});

test('annotation refresh invalidates an older in-flight render and waits for the newer page version', async () => {
  const h = scheduler(); h.queue.reset('paper'); h.queue.want([2]); const pending = h.queue.ready(2);
  h.queue.invalidate(2); h.requests[0].resolve({ version: 'before-save' }); await flush();
  assert.equal(h.installed.size, 0); assert.equal(h.requests.length, 2); assert.equal(h.requests[1].page, 2);
  h.requests[1].resolve({ version: 'after-save' }); assert.equal(await pending, true); await h.queue.idle(); assert.equal(h.installed.get(2).version, 'after-save');
});

test('page failure remains retryable and does not block neighboring pages', async () => {
  const h = scheduler(); h.queue.reset('paper'); h.queue.want([2, 3]); const pending = h.queue.ready(2); const rejection = assert.rejects(pending, /broken page/);
  h.requests[0].reject(new Error('broken page')); await rejection; await flush();
  assert.equal(h.requests[1].page, 3); h.requests[1].resolve(); await h.queue.idle(); assert.equal(h.installed.has(3), true);
  h.queue.invalidate(2); const retry = h.queue.ready(2); h.requests[2].resolve(); assert.equal(await retry, true); await h.queue.idle(); assert.equal(h.errors.length, 1);
});

test('jump readiness waits for image decoding and eviction still clears an image being decoded', async () => {
  const h = scheduler({ delayedInstall: true }); h.queue.reset('paper'); h.queue.want([1]); let finished = false; const ready = h.queue.ready(1).then(value => { finished = true; return value; });
  h.requests[0].resolve(); await flush(); assert.equal(h.installed.size, 1); assert.equal(finished, false);
  h.queue.want([2]); assert.equal(await ready, false); assert.equal(h.installed.size, 0); h.decoded[0].resolve(); await flush();
  assert.equal(h.requests[1].page, 2); const next = h.queue.ready(2); h.requests[1].resolve(); await flush(); h.decoded[1].resolve(); assert.equal(await next, true); await h.queue.idle(); assert.equal(h.peaks().inFlight, 1);
});

test('duplicate and excessive viewport requests cannot expand the render window', async () => {
  const h = scheduler(); h.queue.reset('paper'); h.queue.want([1, 1, 2, 3, 4, 5, NaN, -1]);
  assert.deepEqual(plain(h.queue.snapshot().wanted), [1, 2, 3]);
  h.requests[0].resolve(); await flush(); h.requests[1].resolve(); await flush(); h.requests[2].resolve(); await h.queue.idle();
  assert.equal(h.requests.length, 3); assert.equal(h.installed.size, 3);
});

test('geometry-only layout supports 2000 pages, mixed orientation and stable scroll anchors', () => {
  const pages = validateLayout({ page_count: 2000, pages: Array.from({ length: 2000 }, (_, i) => ({ page: i + 1, width: i % 2 ? 800 : 600, height: i % 2 ? 600 : 800, rotation: i % 2 ? 90 : 0 })) });
  const first = pageMetrics(pages, 600), second = pageMetrics(pages, 900), original = first[949];
  const scrollTop = original.top + original.height * .3; assert.equal(pageAt(first, scrollTop), 950);
  const preserved = second[949].top + (scrollTop - original.top) / original.height * second[949].height;
  assert.equal(pageAt(second, preserved), 950); assert.ok(Math.abs((preserved - second[949].top) / second[949].height - .3) < 1e-10);
  assert.deepEqual(plain(visibleWindow(first, scrollTop, 500, 950)), [950, 951, 949]);
  assert.deepEqual(plain(visibleWindow(first, 0, 500, 1)), [1, 2, 3]);
  assert.deepEqual(plain(visibleWindow(first, first.at(-1).top, 500, 2000)), [2000, 1999, 1998]);
});

test('layout rejects missing, duplicate, invalid and oversized page geometry instead of inventing dimensions', () => {
  const valid = { page_count: 1, pages: [{ page: 1, width: 600, height: 800 }] };
  assert.throws(() => validateLayout({ ...valid, page_count: 2 }), /不完整/);
  assert.throws(() => validateLayout({ ...valid, pages: [{ page: 2, width: 600, height: 800 }] }), /尺寸/);
  assert.throws(() => validateLayout({ ...valid, pages: [{ page: 1, width: 0, height: 800 }] }), /尺寸/);
  assert.throws(() => validateLayout({ ...valid, page_count: 2001 }), /2,000/);
});

test('selection uses displayed PDF coordinates, merges only adjacent words on a line and preserves columns', () => {
  const selection = mergeSelection([[10, 20, 30, 30, 'First'], [32, 20, 50, 30, 'line'], [250, 20, 300, 30, 'column'], [10, 40, 30, 50, 'Next']], 2);
  assert.deepEqual(plain(selection), { page: 2, text: 'First line column Next', rects: [[10, 20, 50, 30], [250, 20, 300, 30], [10, 40, 30, 50]], wordCount: 4 });
  assert.throws(() => mergeSelection([[0, 0, 10, 10, 'x'.repeat(20001)]], 1), /上限/);
  assert.throws(() => mergeSelection(Array.from({ length: 201 }, (_, i) => [0, i * 20, 10, i * 20 + 10, 'x']), 1), /上限/);
});
