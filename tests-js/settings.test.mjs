import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createLocalStateStore } from '../src/local-state.mjs';
import { createPaperLibrarySettings, createPaperLibrarySettingsSchema, PAPER_LIBRARY_SETTINGS_DEFAULTS } from '../src/harness/settings.mjs';

const NS = 'paper-library', marker = 'settings.migration:paper-library', backup = 'settings.backup:paper-library';
const code = expected => error => error.code === expected;
function host({ user = {}, writable = true } = {}) {
  let base = {}, revision = 0, value, registered = false;
  const observers = new Set(), updates = [];
  const settle = () => { value = { ...base, ...user }; for (const observer of observers) observer(value); };
  return {
    writable, updates,
    register(ns, _schema, options) { assert.equal(ns, NS); assert.equal(registered, false); registered = true; base = options.base; settle(); return { get: () => value, watch: fn => { observers.add(fn); return () => observers.delete(fn); } }; },
    describe(options) { assert.equal(options.redactSecrets, true); return [{ ns: NS, schema: {}, value: structuredClone(value), base: structuredClone(base), user: structuredClone(user), revision, applies: 'live' }]; },
    async update(ns, patch, expected) {
      assert.equal(ns, NS); if (!this.writable) throw Error('read-only');
      if (expected !== revision) throw Object.assign(Error('conflict'), { code: 'SETTINGS_CONFLICT' });
      updates.push(structuredClone(patch)); user = { ...user, ...patch }; revision++; settle();
    },
    async mutate(ns, ops, expected) {
      assert.equal(ns, NS); if (expected !== revision) throw Object.assign(Error('conflict'), { code: 'SETTINGS_CONFLICT' });
      for (const op of ops) { assert.equal(op.op, 'unset'); delete user[op.path[0]]; } revision++; settle();
    },
    external(patch) { user = { ...user, ...patch }; revision++; settle(); },
    raw: () => structuredClone(user),
    observers: () => observers.size,
  };
}
async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'paper-settings-')), library = join(directory, 'library'), home = join(directory, 'home');
  await mkdir(library); const store = createLocalStateStore({ library, home });
  t.after(() => rm(directory, { recursive: true, force: true }));
  if (options.legacy) await store.put('preferences', options.legacy, 0);
  const settings = options.native === false ? undefined : host(options);
  const service = createPaperLibrarySettings({ store, settings, schema: {}, base: options.base });
  t.after(() => service.dispose()); await service.ready;
  return { directory, library, home, store, settings, service };
}

test('schema exposes only the four live preference fields with safe defaults', () => {
  const field = type => ({ type, default(value) { this.value = value; return this; } });
  const schema = createPaperLibrarySettingsSchema({ object: value => value, boolean: () => field('boolean'), const: value => value, union: values => ({ ...field('union'), values }) });
  assert.deepEqual(Object.keys(schema), Object.keys(PAPER_LIBRARY_SETTINGS_DEFAULTS));
  assert.equal(schema.auto_analysis.value, true); assert.deepEqual(schema['reading-panel-side'].values, ['left', 'right']);
});

test('migration respects explicit native false, normalizes legacy strings and retains unrelated data', async t => {
  const legacy = { auto_analysis: true, analysis_fill: 'true', 'auto-paper-conversation': 'false', 'reading-panel-side': 'right', model: 'legacy-route', unknown: { keep: true } };
  const f = await fixture(t, { legacy, user: { auto_analysis: false, future: 7 } });
  const view = await f.service.get();
  assert.equal(view.backend, 'dsh'); assert.equal(view.writable, true);
  assert.deepEqual(view.value, { auto_analysis: false, analysis_fill: true, 'auto-paper-conversation': false, 'reading-panel-side': 'right' });
  assert.deepEqual((await f.store.get('preferences')).value, legacy);
  assert.deepEqual((await f.store.get(backup)).value, legacy);
  assert.equal(f.settings.raw().future, 7);
  assert.deepEqual((await f.service.localState.get('preferences')).value.unknown, { keep: true });
  assert.ok(!(await f.store.get(marker)).value.imported_fields.includes('auto_analysis'));
});

test('invalid legacy preference values stay backed up but never reach the native namespace', async t => {
  const f = await fixture(t, { legacy: { auto_analysis: 'yes', analysis_fill: 1, 'reading-panel-side': 'outside' } });
  assert.deepEqual((await f.service.get()).value, PAPER_LIBRARY_SETTINGS_DEFAULTS);
  assert.equal(f.settings.updates.length, 0);
  assert.deepEqual((await f.store.get(marker)).value.ignored_fields.sort(), ['analysis_fill', 'auto_analysis', 'reading-panel-side']);
});

test('native edits are immediately visible through old preference API and invalidate stale writes', async t => {
  const f = await fixture(t), first = await f.service.localState.get('preferences');
  f.settings.external({ auto_analysis: true });
  const next = await f.service.localState.get('preferences');
  assert.equal(next.value.auto_analysis, true); assert.notEqual(next.revision, first.revision);
  await assert.rejects(f.service.localState.put('preferences', { ...first.value, analysis_fill: true }, first.revision), code('STATE_CONFLICT'));
  assert.equal(f.settings.raw().analysis_fill, undefined);
});

test('inline preference writes use the native authority and preserve original legacy bytes', async t => {
  const f = await fixture(t, { legacy: { auto_analysis: false, extra: 'kept' } }), old = await f.store.get('preferences');
  const first = await f.service.localState.get('preferences');
  const next = await f.service.localState.put('preferences', { ...first.value, auto_analysis: true }, first.revision);
  assert.equal(f.settings.raw().auto_analysis, true); assert.equal(next.value.extra, 'kept');
  assert.deepEqual(await f.store.get('preferences'), old, 'managed writes must never refresh a second truth');
  assert.deepEqual(next.value, { ...first.value, auto_analysis: true });
});

test('revision fences serialize competing edits and translate native races to state conflicts', async t => {
  const f = await fixture(t), first = await f.service.get();
  const results = await Promise.allSettled([f.service.update({ auto_analysis: true }, first.revision), f.service.update({ analysis_fill: true }, first.revision)]);
  assert.equal(results.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal(results.find(item => item.status === 'rejected').reason.code, 'STATE_CONFLICT');
  const latest = await f.service.get(), update = f.settings.update;
  f.settings.update = function(...args) { this.external({ analysis_fill: true }); return update.apply(this, args); };
  await assert.rejects(f.service.update({ auto_analysis: false }, latest.revision), code('STATE_CONFLICT'));
});

test('partial reset restores composition defaults, preserves other native keys, never reimports on restart', async t => {
  const f = await fixture(t, { legacy: { auto_analysis: true }, user: { future: 1 }, base: { 'reading-panel-side': 'right' } });
  let view = await f.service.get(); assert.equal(view.value.auto_analysis, true);
  view = await f.service.reset(view.revision, ['auto_analysis']); assert.equal(view.value.auto_analysis, true);
  assert.equal(view.value['reading-panel-side'], 'right'); assert.equal(f.settings.raw().future, 1);
  const restartedHost = host({ user: f.settings.raw() }), restarted = createPaperLibrarySettings({ store: f.store, settings: restartedHost, schema: {} });
  t.after(() => restarted.dispose()); await restarted.ready;
  assert.equal((await restarted.get()).value.auto_analysis, true); assert.equal(restartedHost.updates.length, 0);
});

test('standalone never migrated deployments use host disk with cross-instance conflicts', async t => {
  const f = await fixture(t, { native: false }), second = createPaperLibrarySettings({ store: createLocalStateStore({ library: f.library, home: f.home }) });
  t.after(() => second.dispose());
  const first = await f.service.get(); assert.equal(first.backend, 'local'); assert.equal(first.writable, true);
  await f.service.update({ analysis_fill: true }, first.revision);
  assert.equal((await second.get()).value.analysis_fill, true);
  await assert.rejects(second.update({ auto_analysis: true }, first.revision), code('STATE_CONFLICT'));
  const reset = await second.reset((await second.get()).revision); assert.equal(reset.value.analysis_fill, true);
});

test('standalone fails closed once DSH owns these settings and hides stale managed values', async t => {
  const f = await fixture(t, { legacy: { auto_analysis: true, model: 'kept' } });
  const standalone = createPaperLibrarySettings({ store: f.store }); t.after(() => standalone.dispose());
  const view = await standalone.get();
  assert.equal(view.backend, 'dsh'); assert.equal(view.available, false); assert.equal(view.writable, false); assert.equal(view.value, null);
  const oldAPI = await standalone.localState.get('preferences'); assert.deepEqual(oldAPI.value, { model: 'kept' });
  await assert.rejects(standalone.update({ analysis_fill: true }, view.revision), code('SETTINGS_UNAVAILABLE'));
  await assert.rejects(standalone.localState.put('preferences', oldAPI.value, oldAPI.revision), code('SETTINGS_UNAVAILABLE'));
});

test('legacy-only edits preserve managed recovery values and mixed-store writes are refused', async t => {
  const f = await fixture(t, { legacy: { auto_analysis: false, old: 1 }, user: { auto_analysis: true } });
  let current = await f.service.localState.get('preferences');
  current = await f.service.localState.put('preferences', { ...current.value, old: 2 }, current.revision);
  assert.deepEqual((await f.store.get('preferences')).value, { auto_analysis: false, old: 2 });
  await assert.rejects(f.service.localState.put('preferences', { ...current.value, old: 3, analysis_fill: false }, current.revision), code('SETTINGS_INVALID'));
  assert.equal(f.settings.raw().analysis_fill, undefined);
  assert.equal((await f.store.get('preferences')).value.old, 2);
});

test('invalid keys, values, revisions and omitted legacy fields reject before writes', async t => {
  const f = await fixture(t, { legacy: { old: 1 } }), first = await f.service.get();
  for (const patch of [{ library: '/tmp/a' }, { provider: 'x' }, { auto_analysis: 'true' }, { 'reading-panel-side': 'top' }]) {
    assert.throws(() => f.service.update(patch, first.revision), code('SETTINGS_INVALID'));
  }
  await assert.rejects(f.service.update({ auto_analysis: true }, undefined), code('SETTINGS_INVALID'));
  assert.throws(() => f.service.reset(first.revision, ['unknown']), code('SETTINGS_INVALID'));
  assert.throws(() => f.service.reset(first.revision, ['auto_analysis', 'auto_analysis']), code('SETTINGS_INVALID'));
  const prefs = await f.service.localState.get('preferences');
  await assert.rejects(f.service.localState.put('preferences', { auto_analysis: true }, prefs.revision), code('SETTINGS_INVALID'));
  assert.equal(f.settings.updates.length, 0);
});

test('non-settings drafts pass through exactly and migration reads no unrelated records', async t => {
  const f = await fixture(t), saved = await f.store.put('chat:one', { draft: 'private draft' }, 0);
  assert.deepEqual(await f.service.localState.get('chat:one'), saved);
  const next = await f.service.localState.put('chat:one', { draft: 'next' }, saved.revision);
  assert.deepEqual(await f.store.get('chat:one'), next);
  assert.equal((await f.service.localState.list({ prefix: 'chat:' })).records.length, 1);
  const records = await f.service.localState.list({ prefix: 'preferences', limit: 1 });
  assert.equal(records.total, 1); assert.equal(records.records[0].key, 'preferences');
  const reads = [], calls = { ...f.store, get(key) { reads.push(key); return f.store.get(key); }, list() { throw Error('migration must not enumerate state'); } };
  const another = createPaperLibrarySettings({ store: calls, settings: host(), schema: {} }); t.after(() => another.dispose());
  await another.ready; await another.get();
  assert.ok(reads.every(key => ['preferences', marker].includes(key)));
});

test('native subscriptions clean up and read-only provider refuses user writes', async t => {
  const f = await fixture(t), seen = [];
  const off = f.service.subscribe(() => seen.push('updated'));
  f.settings.external({ analysis_fill: true }); assert.equal(seen.length, 1);
  off(); f.settings.external({ analysis_fill: false }); assert.equal(seen.length, 1);
  f.settings.writable = false;
  const view = await f.service.get(); assert.equal(view.writable, false);
  await assert.rejects(f.service.update({ auto_analysis: true }, view.revision), code('SETTINGS_UNAVAILABLE'));
  await f.service.dispose(); assert.equal(f.settings.observers(), 0);
});

test('corrupt legacy or migration records are preserved and fail initialization', async t => {
  const f = await fixture(t, { native: false });
  await f.store.put('preferences', 'malformed', 0);
  const first = createPaperLibrarySettings({ store: f.store, settings: host(), schema: {} }); t.after(() => first.dispose());
  await assert.rejects(first.ready, code('STATE_CORRUPT')); assert.equal((await f.store.get('preferences')).value, 'malformed');
  await f.store.put(marker, { version: 99 }, 0);
  const second = createPaperLibrarySettings({ store: f.store, settings: host(), schema: {} }); t.after(() => second.dispose());
  await assert.rejects(second.ready, code('STATE_CORRUPT')); assert.equal((await f.store.get(marker)).value.version, 99);
});

test('actual DSH settings-file persists namespace edits, rejects stale clients and follows external disk changes', async t => {
  const project = dirname(dirname(fileURLToPath(import.meta.url)));
  const harness = resolve(process.env.DSH_CHECKOUT ?? join(project, '../../deepseek-ai/deepseek-harness'));
  const providerEntry = join(harness, 'packages/settings/settings-file/lib/index.js');
  try { await access(providerEntry); } catch { t.skip('Build DSH_CHECKOUT to run native settings-file integration'); return; }
  const hostRequire = createRequire(providerEntry);
  // Cordis and schemastery's CJS entry share cosmokit; Node's CJS→ESM bridge
  // cannot synchronously require it while a parallel dynamic import is pending.
  const { Context } = await import(pathToFileURL(hostRequire.resolve('@deepseek-ai/cordis')));
  const schemaModule = await import(pathToFileURL(hostRequire.resolve('@deepseek-ai/schemastery')));
  const { FileSettingsProvider } = await import(pathToFileURL(providerEntry));
  const Schema = schemaModule.default;
  const root = await mkdtemp(join(tmpdir(), 'paper-settings-native-')), library = join(root, 'library'), home = join(root, 'home'), path = join(home, 'settings.json');
  await mkdir(library); await mkdir(home);
  await writeFile(path, JSON.stringify({ 'unrelated-plugin': { keep: 'synthetic sentinel' }, [NS]: { analysis_fill: false } }));
  const store = createLocalStateStore({ library, home }); await store.put('preferences', { auto_analysis: true, legacy: 'untouched' }, 0);
  const ctx = new Context(), provider = ctx.plugin(FileSettingsProvider, { path, watch: true, debounceMs: 5 });
  let owner, service;
  t.after(async () => { await owner?.dispose(); await provider.dispose(); await rm(root, { recursive: true, force: true }); });
  await provider;
  owner = ctx.plugin({ inject: ['settings'], apply(scoped) {
    service = createPaperLibrarySettings({ store, settings: scoped.settings, schema: createPaperLibrarySettingsSchema(Schema) });
    scoped.effect(() => () => service.dispose());
  } });
  await owner; await service.ready;
  assert.equal((await service.get()).value.auto_analysis, true, 'real provider migrates only the absent native override');
  const old = await service.get(), prefs = await service.localState.get('preferences');
  await service.localState.put('preferences', { ...prefs.value, analysis_fill: true }, prefs.revision);
  let disk = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(disk[NS].analysis_fill, true); assert.equal(disk['unrelated-plugin'].keep, 'synthetic sentinel');
  assert.deepEqual((await store.get('preferences')).value, { auto_analysis: true, legacy: 'untouched' });
  await assert.rejects(service.update({ auto_analysis: false }, old.revision), code('STATE_CONFLICT'));
  disk[NS]['reading-panel-side'] = 'right'; await writeFile(path, JSON.stringify(disk));
  const deadline = Date.now() + 3000;
  while ((await service.get()).value['reading-panel-side'] !== 'right' && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal((await service.localState.get('preferences')).value['reading-panel-side'], 'right');
  const reset = await service.reset((await service.get()).revision, ['auto_analysis']); assert.equal(reset.value.auto_analysis, true);
  disk = JSON.parse(await readFile(path, 'utf8')); assert.equal(Object.hasOwn(disk[NS], 'auto_analysis'), false); assert.equal(disk[NS].analysis_fill, true);
  await owner.dispose(); assert.equal(ctx.settings.describe().some(item => item.ns === NS), false, 'namespace registration follows the caller fiber');
});

test('dispose waits for an in-flight migration before returning', async t => {
  const f = await fixture(t, { native: false, legacy: { auto_analysis: true } });
  let release, entered; const gate = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
  const settings = host(), update = settings.update;
  settings.update = async function(...args) { entered(); await gate; return update.apply(this, args); };
  const service = createPaperLibrarySettings({ store: f.store, settings, schema: {} });
  await started; let done = false;
  const disposal = service.dispose().then(() => { done = true; });
  await Promise.resolve(); assert.equal(done, false);
  release(); await disposal; assert.equal(done, true); assert.equal((await f.store.get(marker)).value.version, 1);
});
