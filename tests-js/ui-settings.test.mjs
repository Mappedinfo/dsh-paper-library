import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../web/settings.js', import.meta.url), 'utf8');
const analysisSource = await readFile(new URL('../web/paper-analysis.js', import.meta.url), 'utf8');
const flush = async () => { await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve)); };
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const view = (revision, patch = {}, extra = {}) => ({ namespace: 'paper-library', backend: 'dsh', available: true, writable: true,
  revision: String(revision).padStart(64, '0'), native_revision: revision,
  value: { auto_analysis: false, analysis_fill: false, 'auto-paper-conversation': false, 'reading-panel-side': 'left', ...patch }, user: patch, ...extra });

function fixture({ api, getPreferences } = {}) {
  const ids = new Map(), changes = [], calls = [], timeouts = new Map(), intervals = new Map(); let timerId = 0, listener;
  class Element {
    constructor(tag) { this.tagName = tag; this.children = []; this.listeners = new Map(); this.attributes = {}; this.classList = { toggle() {} }; this.checked = false; this.disabled = false; this.open = false; this.value = ''; }
    set id(id) { this._id = id; ids.set(id, this); } get id() { return this._id; }
    append(...nodes) { this.children.push(...nodes); }
    setAttribute(key, value) { this.attributes[key] = value; }
    addEventListener(name, fn) { if (!this.listeners.has(name)) this.listeners.set(name, new Set()); this.listeners.get(name).add(fn); }
    removeEventListener(name, fn) { this.listeners.get(name)?.delete(fn); }
    emit(name, event = {}) { for (const fn of this.listeners.get(name) ?? []) fn(event); }
    showModal() { this.open = true; } close() { this.open = false; this.emit('close'); }
  }
  const bar = new Element('div'), document = new Element('document'), window = new Element('window');
  document.body = new Element('body'); document.hidden = false; document.createElement = tag => new Element(tag); document.querySelector = () => bar;
  window.location = { origin: 'http://127.0.0.1:1' }; window.parent = { postMessage() {} };
  const persistence = { async get(key) { assert.equal(key, 'preferences'); const result = await getPreferences?.(); listener?.({ key, status: 'saved' }); return result ?? {}; }, subscribe(fn) { listener = fn; return () => { listener = undefined; }; } };
  const context = { window, document, queueMicrotask,
    setTimeout: fn => { timeouts.set(++timerId, fn); return timerId; }, clearTimeout: id => timeouts.delete(id),
    setInterval: fn => { intervals.set(++timerId, fn); return timerId; }, clearInterval: id => intervals.delete(id),
  };
  vm.runInNewContext(source, context);
  const ui = window.PaperLibrarySettings.create({ persistence, api: async (action, args) => { calls.push({ action, args }); return api(action, args); }, onChange: (value, descriptor) => changes.push({ value: structuredClone(value), descriptor: structuredClone(descriptor) }) });
  const invalidate = revision => window.emit('message', { origin: window.location.origin, source: window.parent,
    data: { type: 'paper-library:settings-changed', version: 1, namespace: 'paper-library', revision } });
  return { ui, ids, calls, changes, invalidate, document, window, intervals,
    async timers() { const ready = [...timeouts.values()]; timeouts.clear(); for (const fn of ready) fn(); await flush(); },
    change(key, value) { const input = ids.get(`setting-${key}`); if (input.type === 'checkbox') input.checked = value; else input.value = value; input.emit('change'); },
    status: () => ids.get('settings-status').textContent,
  };
}

test('an older document response cannot overwrite a newer successful automation opt-out', async () => {
  const old = deferred(); let reads = 0;
  const f = fixture({ api: action => action === 'settings_update' ? view(2, { auto_analysis: false }) : ++reads === 1 ? view(1, { auto_analysis: true }) : old.promise });
  await f.ui.refresh(); const pending = f.ui.refresh();
  f.change('auto_analysis', false); await flush(); assert.equal(f.ids.get('setting-auto_analysis').checked, false);
  old.resolve(view(1, { auto_analysis: true })); await pending; await flush();
  assert.deepEqual(f.changes.map(item => item.value.auto_analysis), [true, false]);
  assert.match(f.status(), /已保存到主机/); assert.equal(f.calls.filter(item => item.action === 'settings_update').length, 1);
  f.ui.dispose();
});

test('an earlier preferences mirror load cannot reapply defaults after a save completes', async () => {
  const oldPreferences = deferred(); let reads = 0;
  const f = fixture({ api: action => action === 'settings_update' ? view(2, { auto_analysis: false }) : view(1, { auto_analysis: true }),
    getPreferences: () => ++reads === 2 ? oldPreferences.promise : {} });
  await f.ui.refresh(); const pending = f.ui.refresh(); await flush();
  f.change('auto_analysis', false); await flush();
  oldPreferences.resolve({ auto_analysis: true }); await pending; await flush();
  assert.deepEqual(f.changes.map(item => item.value.auto_analysis), [true, false]);
  assert.equal(f.ids.get('setting-auto_analysis').checked, false); f.ui.dispose();
});

test('native invalidations during a document read discard its result and coalesce one trailing refresh', async () => {
  const old = deferred(); let reads = 0;
  const f = fixture({ api: () => ++reads === 1 ? view(1, { auto_analysis: true }) : reads === 2 ? old.promise : view(3, { auto_analysis: false }) });
  await f.ui.refresh(); const pending = f.ui.refresh();
  f.invalidate(2); f.invalidate(3); old.resolve(view(1, { auto_analysis: true })); await pending; await flush();
  assert.equal(reads, 3); assert.deepEqual(f.changes.map(item => item.value.auto_analysis), [true, false]);
  assert.equal(f.ids.get('setting-auto_analysis').checked, false); f.ui.dispose();
});

test('native invalidation remains queued while the preferences mirror is pending', async () => {
  const oldPreferences = deferred(); let preferenceReads = 0, reads = 0;
  const f = fixture({ api: () => ++reads < 3 ? view(1, { auto_analysis: true }) : view(2, { auto_analysis: false }),
    getPreferences: () => ++preferenceReads === 2 ? oldPreferences.promise : {} });
  await f.ui.refresh(); const pending = f.ui.refresh(); await flush();
  f.invalidate(2); oldPreferences.resolve({}); await pending; await flush();
  assert.equal(reads, 3); assert.deepEqual(f.changes.map(item => item.value.auto_analysis), [true, false]); f.ui.dispose();
});

test('invalidations during a pending write cause a final fresh read instead of being lost', async () => {
  const writing = deferred(); let reads = 0;
  const f = fixture({ api: action => action === 'settings_update' ? writing.promise : ++reads === 1 ? view(1) : view(3, { analysis_fill: true, 'reading-panel-side': 'right' }) });
  await f.ui.refresh(); f.change('analysis_fill', true);
  assert.equal(f.ids.get('setting-analysis_fill').checked, true, 'pending intent stays displayed');
  f.invalidate(2); f.invalidate(3); writing.resolve(view(2, { analysis_fill: true })); await flush();
  assert.equal(reads, 2); assert.equal(f.ids.get('setting-reading-panel-side').value, 'right');
  assert.equal(f.calls.some(item => /analysis_start|generate|send/.test(item.action)), false); f.ui.dispose();
});

test('own preferences-read notifications do not create a polling feedback loop', async () => {
  const f = fixture({ api: () => view(1) }); await f.ui.refresh(); await flush(); await f.timers();
  assert.equal(f.calls.length, 1); f.ui.dispose();
});

test('a rejected or mismatched save never reports success and retains authoritative checkbox state', async () => {
  for (const mismatch of [false, true]) {
    const f = fixture({ api: action => { if (action === 'settings_update') { if (mismatch) return view(2, { auto_analysis: false }); throw Error('conflict'); } return view(1); } });
    await f.ui.refresh(); f.change('auto_analysis', true); await flush();
    assert.match(f.status(), /未保存/); assert.equal(f.ids.get('setting-auto_analysis').checked, false); f.ui.dispose();
  }
});

test('local saves use local copy and disposed controllers ignore pending document results', async () => {
  const old = deferred(); let reads = 0;
  const f = fixture({ api: action => action === 'settings_update' ? view(2, { analysis_fill: true }, { backend: 'local' }) : ++reads === 1 ? view(1, {}, { backend: 'local' }) : old.promise });
  await f.ui.refresh(); f.change('analysis_fill', true); await flush(); assert.equal(f.status(), '已保存到本机');
  const pending = f.ui.refresh(); f.ui.dispose(); old.resolve(view(9)); await pending; await flush();
  assert.equal(f.changes.length, 2); assert.equal(f.ids.get('setting-analysis_fill').checked, true); assert.equal(f.intervals.size, 0);
});

test('late analysis availability preference reads cannot re-enable newer disabled automation', async () => {
  const ids = new Map(), old = deferred(), calls = [];
  const element = () => ({ children: [], value: '', classList: { toggle() {} }, append(...nodes) { this.children.push(...nodes); },
    addEventListener() {}, setAttribute() {}, replaceChildren() {} });
  const get = id => { if (!ids.has(id)) ids.set(id, element()); return ids.get(id); };
  const document = { body: element(), hidden: false, createElement: element, getElementById: get, addEventListener() {}, removeEventListener() {} };
  const window = {};
  vm.runInNewContext(analysisSource, { document, window, setTimeout, clearTimeout });
  const analysis = window.PaperAnalysis.create({ state: { active: null }, api: async action => { calls.push(action); return {}; },
    persistence: { get: async key => { assert.equal(key, 'preferences'); return old.promise; } } });
  const loading = analysis.setAvailable(true);
  analysis.applyPreferences({ auto_analysis: false, analysis_fill: false });
  old.resolve({ auto_analysis: true, analysis_fill: true }); await loading;
  assert.equal(get('analysis-auto').checked, false); assert.equal(get('analysis-fill').checked, false);
  assert.deepEqual(calls, []); analysis.dispose();
});
