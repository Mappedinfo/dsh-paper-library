import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { RESOURCE_DEFAULTS,RESOURCE_FIELDS,RESOURCE_PROFILES,resolveResourcePolicy } from '../src/resource-policy.mjs';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../web/settings.js', import.meta.url), 'utf8');
const analysisSource = await readFile(new URL('../web/paper-analysis.js', import.meta.url), 'utf8');
const flush = async () => { await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve)); };

test('annotation size change saves a number and restores the confirmed host value',async()=>{
  let current=view(1);
  const f=fixture({api:(action,args)=>action==='settings_update'?(current=view(2,args.patch)):current});
  await f.ui.refresh();assert.equal(f.ids.get('setting-annotation_font_size').value,'14');
  f.change('annotation_font_size','20');await flush();
  assert.equal(f.calls.find(call=>call.action==='settings_update').args.patch.annotation_font_size,20);
  await f.ui.refresh();assert.equal(f.ids.get('setting-annotation_font_size').value,'20');
  assert.equal(f.changes.at(-1).value.annotation_font_size,20);f.ui.dispose();
});
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

test('direct analysis keeps unconfirmed jobs polling, blocks reruns without showing cancel, and saves auto-review checkbox', async () => {
  const ids = new Map(), calls = [], patches = [], timers = new Map(); let timerId = 0;
  class Element {
    constructor() { this.children = []; this.listeners = new Map(); this.classList = { toggle() {} }; this.checked = false; this.disabled = false; this.hidden = false; this.value = ''; }
    set id(value) { this._id = value; ids.set(value, this); } get id() { return this._id; }
    append(...values) { this.children.push(...values); } replaceChildren(...values) { this.children = values; }
    setAttribute() {} addEventListener(type, fn) { this.listeners.set(type, fn); }
    emit(type) { this.listeners.get(type)?.(); }
  }
  const get = id => ids.get(id) ?? Object.assign(new Element(), { id });
  const document = { body: new Element(), hidden: false, createElement: () => new Element(), getElementById: id => get(id), addEventListener() {}, removeEventListener() {} };
  const window = {};
  vm.runInNewContext(analysisSource, { document, window, setTimeout: fn => { const id = ++timerId; timers.set(id, fn); return id; }, clearTimeout: id => timers.delete(id) });
  let readCount = 0, currentStatus = 'unconfirmed';
  const analysis = window.PaperAnalysis.create({
    state: { active: { id: 'paper-a', title: 'Synthetic paper', pdf: 'paper.pdf' } },
    api: async (action, args) => { calls.push({ action, args }); if (action === 'paper_analysis_get') { readCount++; return { id: 'paper-a', request_id: 'remote-run', status: currentStatus, stage: currentStatus === 'unconfirmed' ? '执行状态待确认' : '整理完成' }; } return {}; },
    persistence: { get: async () => ({ auto_analysis: false }), patch: async (...args) => patches.push(args) },
  });
  await analysis.setAvailable(true); await flush();
  assert.equal(get('analysis-start').disabled, true);
  assert.equal(get('analysis-cancel').hidden, true);
  assert.match(get('analysis-status').textContent, /可能仍在其他进程运行/);
  assert.ok([...timers.values()].length, 'unconfirmed status schedules another read');
  get('analysis-auto-review').checked = false; get('analysis-auto-review').emit('change'); await flush();
  assert.equal(JSON.stringify(patches.find(([key]) => key === 'preferences')?.[1]), JSON.stringify({ auto_review: false }));
  assert.ok(readCount >= 1); assert.equal(calls.some(call => call.action === 'paper_analysis_start'), false);
  currentStatus = 'complete'; const poll = [...timers.values()].at(-1); timers.clear(); poll?.(); await flush();
  assert.equal(get('analysis-start').disabled, false, 'a completed remote job allows a new explicit run');
  assert.equal(get('analysis-cancel').hidden, true);
  analysis.dispose();
});

for(const palette of ['neutral','rose','apricot'])test(`${palette} palette saves through the shared settings endpoint and stays selected`,async()=>{
  let current=view(1,{ui_palette:'jade'});
  const f=fixture({api:(action,args)=>action==='settings_update'?(current=view(2,args.patch)):current});
  await f.ui.refresh();const input=f.ids.get(`setting-palette-${palette}`);assert.ok(input);input.checked=true;input.emit('change');await flush();
  const request=f.calls.find(call=>call.action==='settings_update');assert.equal(request.args.patch.ui_palette,palette);assert.equal(input.checked,true);
  assert.equal(f.changes.at(-1).value.ui_palette,palette);f.ui.dispose();
});

test('resource presets preview effective values and custom fields save together',async()=>{
 let values={...RESOURCE_DEFAULTS},revision=1;const descriptor=()=>view(revision,values,{resource_policy:resolveResourcePolicy(values),resource_fields:RESOURCE_FIELDS,resource_profiles:RESOURCE_PROFILES});
 const f=fixture({api:(action,args)=>{if(action==='settings_update'){values={...values,...args.patch};revision++;}return descriptor();}});await f.ui.refresh();
 f.change('resource_profile','performance');assert.equal(f.ids.get('setting-resource_preview_mb').value,96);assert.equal(f.ids.get('setting-resource_preview_mb').disabled,true);assert.equal(f.calls.some(x=>x.action==='settings_update'),false);
 f.change('resource_profile','custom');const preview=f.ids.get('setting-resource_preview_mb');assert.equal(preview.disabled,false);preview.value='64';preview.emit('input');const pages=f.ids.get('setting-resource_batch_pages');pages.value='3';pages.emit('input');
 const resources=f.ids.get('settings-resources');resources.children.find(n=>n.textContent==='保存资源配置').emit('click');await flush();
 const update=f.calls.find(x=>x.action==='settings_update');assert.equal(update.args.patch.resource_profile,'custom');assert.equal(update.args.patch.resource_preview_mb,64);assert.equal(update.args.patch.resource_batch_pages,3);assert.equal(Object.keys(update.args.patch).length,8);assert.match(f.status(),/已保存/);
 f.change('resource_profile','eco');assert.equal(preview.value,16);resources.children.find(n=>n.textContent==='保存资源配置').emit('click');await flush();
 f.change('resource_profile','custom');assert.equal(preview.value,64,'switching presets preserves stored custom budgets');assert.equal(pages.value,3);f.ui.dispose();
});

test('resource drafts keep their original CAS revision across polling and preserve conflicting edits',async()=>{
 let values={...RESOURCE_DEFAULTS,resource_profile:'custom'},revision=1;
 const descriptor=()=>view(revision,values,{resource_policy:resolveResourcePolicy(values),resource_fields:RESOURCE_FIELDS,resource_profiles:RESOURCE_PROFILES});
 const f=fixture({api:(action,args)=>{if(action==='settings_update'){if(args.expected_revision!==descriptor().revision)throw new Error('另一窗口已有修改');values={...values,...args.patch};revision++;}return descriptor();}});
 await f.ui.refresh();const preview=f.ids.get('setting-resource_preview_mb');preview.value='32';preview.emit('input');
 values={...values,resource_preview_mb:80};revision=2;await f.ui.refresh();assert.equal(preview.value,32);
 const resources=f.ids.get('settings-resources'),save=resources.children.find(n=>n.textContent==='保存资源配置'),restore=resources.children.find(n=>n.textContent==='恢复已保存');
 save.emit('click');await flush();assert.equal(values.resource_preview_mb,80);assert.equal(preview.value,32);assert.match(f.status(),/资源草稿仍保留.*恢复已保存/);
 await f.ui.refresh();save.emit('click');await flush();assert.ok(f.calls.filter(c=>c.action==='settings_update').every(c=>c.args.expected_revision===view(1).revision),'polling must not advance the resource draft revision');
 restore.emit('click');await flush();assert.equal(preview.value,80);preview.value='64';preview.emit('input');save.emit('click');await flush();assert.equal(values.resource_preview_mb,64);assert.equal(f.calls.filter(c=>c.action==='settings_update').at(-1).args.expected_revision,view(2).revision);f.ui.dispose();
});


for (const backend of ['local', 'dsh']) test(`reading distribution controls persist typed preferences and restore defaults (${backend})`, async () => {
  const defaults = { reading_distribution_enabled: true, reading_distribution_mode: 'density', reading_distribution_ai: true, reading_distribution_smoothing: 3 };
  let values = { ...defaults, annotation_font_size: 18 }, user = { annotation_font_size: 18 }, revision = 1;
  const f = fixture({ api: (action, args) => {
    if (action === 'settings_update') { assert.equal(args.expected_revision, view(revision).revision); values = { ...values, ...args.patch }; user = { ...user, ...args.patch }; revision++; }
    if (action === 'settings_reset') { values = { ...defaults, annotation_font_size: 14 }; user = {}; revision++; }
    return view(revision, values, { backend, user });
  } });
  await f.ui.refresh();
  const group = f.ids.get('settings-reading-distribution'); assert.ok(group);
  assert.ok(group.children.some(node => /不代表阅读完成率或理解程度/.test(node.textContent)));
  assert.equal(f.ids.get('setting-reading_distribution_enabled').checked, true);
  assert.equal(f.ids.get('setting-reading_distribution_mode').value, 'density');
  assert.equal(f.ids.get('setting-reading_distribution_ai').checked, true);
  assert.equal(f.ids.get('setting-reading_distribution_smoothing').value, '3');
  for (const [key, value] of Object.entries({ reading_distribution_enabled: false, reading_distribution_mode: 'bands', reading_distribution_ai: false, reading_distribution_smoothing: 6 })) {
    f.change(key, typeof value === 'number' ? String(value) : value); await flush();
    assert.equal(f.calls.filter(call => call.action === 'settings_update').at(-1).args.patch[key], value);
    assert.equal(f.changes.at(-1).value[key], value);
  }
  assert.equal(values.annotation_font_size, 18, 'ordinary reading preferences survive strip edits');
  await f.ui.refresh();
  assert.equal(f.ids.get('setting-reading_distribution_enabled').checked, false);
  assert.equal(f.ids.get('setting-reading_distribution_smoothing').value, '6');
  f.ids.get('library-settings').children.find(node => node.tagName === 'footer').children.find(node => node.textContent === '恢复默认').emit('click'); await flush();
  assert.equal(f.ids.get('setting-reading_distribution_enabled').checked, true);
  assert.equal(f.ids.get('setting-reading_distribution_mode').value, 'density');
  assert.equal(f.ids.get('setting-reading_distribution_ai').checked, true);
  assert.equal(f.ids.get('setting-reading_distribution_smoothing').value, '3');
  assert.match(f.status(), /已保存到/); f.ui.dispose();
});

test('failed reading strip save restores confirmed state and remains visibly unsaved', async () => {
  const f = fixture({ api: action => { if (action === 'settings_update') throw Error('conflict'); return view(1, { reading_distribution_mode: 'density', reading_distribution_smoothing: 3 }); } });
  await f.ui.refresh(); f.change('reading_distribution_mode', 'bands'); await flush();
  assert.equal(f.ids.get('setting-reading_distribution_mode').value, 'density'); assert.match(f.status(), /未保存/);
  f.change('reading_distribution_smoothing', '6'); await flush();
  assert.equal(f.ids.get('setting-reading_distribution_smoothing').value, '3'); assert.match(f.status(), /未保存/); f.ui.dispose();
});
