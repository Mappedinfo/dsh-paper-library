import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { webcrypto } from 'node:crypto'
import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('../web/app.js', import.meta.url), 'utf8')
const storage = source.slice(source.indexOf('let workspaceStorageKey;'), source.indexOf('function publishReaderState('))
const initialize = source.slice(source.indexOf('async function initialize()'), source.indexOf('const currentModelDisplay'))
const writing = { section: 'latex', current: { kind: 'latex', id: 'synthetic-writer' }, table: false }
const tick = () => new Promise(resolve => setImmediate(resolve))
function fixture(search, records = new Map(), snapshot = null, historyState = null) {
  const params = new URLSearchParams(search), paper = params.get('paper'), view = params.get('view') || 'library'
  const calls = [], reads = [], state = { active: null, page: 1 }
  const context = {
    URLSearchParams, TextEncoder, Uint8Array, crypto: webcrypto, location: { search },
    history: { state: historyState, replaceState(value) { this.state = value } },
    ENTRY_VIEW: view, ENTRY_PAPER: paper,
    persistence: { async get(key) { reads.push(key); return structuredClone(records.get(key) ?? null) }, async put(key, value) { records.set(key, structuredClone(value)) } },
    workspaceNavigationUI: { navigate: async item => calls.push(['navigate', item.kind, item.id]), selectRoot: async section => calls.push(['root', section]) },
    window: { location: { origin: 'http://localhost' } }, state,
    readerLabelKey: 'reader:tab-label:' + (paper || 'main'), readerEntryKey: paper ? 'reader:tab:' + paper : 'reader',
    readerRestore: snapshot, durableReaderLoaded: false, initializedReader: false, customPaperTabLabel: '', pendingReferenceOpen: null,
    announceReady() {}, loadStatus: async () => {}, ensureCatalogLoaded: async () => {}, publishPaperTabLabel() {}, loadModels() {},
    applyEntryView: async () => calls.push(['entry', view]),
    openPaper: async id => { state.active = { id }; state.page = records.get('reader:' + id)?.page || 1; calls.push(['paper', id]); return 1 },
    restoreReaderState: async () => { const saved = context.readerRestore; if (saved) { state.active = { id: saved.paperId }; state.page = saved.page; } },
    paperChatUI: { available: () => true }, toast: message => { throw Error(message) },
  }
  context.window.parent = context.window
  vm.createContext(context); vm.runInContext(storage + '\n' + initialize, context)
  return { context, state, calls, reads, records }
}

test('a reading tab ignores another tab’s last writer while that writer resumes its own workspace', async () => {
  const records = new Map([['workspace:last:main', writing], ['reader', { paperId: 'paper-a' }], ['reader:paper-a', { paperId: 'paper-a', page: 4 }]])
  const writer = fixture('?workspace=writer-tab', records), reader = fixture('?workspace=reader-tab', records)
  writer.context.publishWorkspaceState(writing); await writer.context.workspaceStateKey(); await tick()
  const writerKey = await writer.context.workspaceStateKey(), readerKey = await reader.context.workspaceStateKey()
  assert.notEqual(writerKey, readerKey)
  await reader.context.initialize()
  assert.equal(reader.state.active.id, 'paper-a'); assert.equal(reader.state.page, 4)
  assert.deepEqual(reader.calls, []); assert.equal(reader.reads.includes('workspace:last:main'), false)
  const reopened = fixture('?workspace=writer-tab', records); await reopened.context.initialize()
  assert.deepEqual(reopened.calls, [['navigate', 'latex', 'synthetic-writer']])
  reader.context.publishWorkspaceState({ section: 'paper', current: { kind: 'paper', id: 'paper-a' }, table: false }); await tick()
  assert.equal(records.get(writerKey).section, 'latex')
})

test('explicit paper entry takes precedence over saved and late host workspace restoration', async () => {
  const records = new Map([['reader:paper-a', { paperId: 'paper-a', page: 7 }]])
  const reader = fixture('?paper=paper-a&workspace=reader-tab', records, { paperId: 'paper-a', page: 7, workspace: writing })
  reader.context.publishWorkspaceState(writing); await reader.context.workspaceStateKey(); await tick()
  await reader.context.initialize()
  await reader.context.restoreWorkspaceSnapshot(writing)
  await reader.context.restoreWorkspaceSnapshot({ section: 'board', current: { kind: 'board', id: 'synthetic-board' } })
  assert.deepEqual(reader.calls, [['paper', 'paper-a']]); assert.equal(reader.state.page, 7)
})

test('entry types and two tabs for the same paper have distinct bounded durable keys', async () => {
  const urls = ['', '?view=latex', '?view=board', '?paper=paper-a&workspace=first', '?paper=paper-a&workspace=second', '?workspace=标签/长标识'.repeat(15)]
  const keys = await Promise.all(urls.map(url => fixture(url).context.workspaceStateKey()))
  assert.equal(new Set(keys).size, keys.length)
  for (const key of keys) { assert.match(key, /^workspace:last:[A-Za-z0-9_-]{1,160}$/); assert.ok(key.length <= 240) }
  assert.equal(keys[3], await fixture(urls[3]).context.workspaceStateKey())
})

test('a dedicated writer entry stays in writing and does not restore the shared reader workspace', async () => {
  const f = fixture('?view=latex&workspace=writer-tab', new Map([['workspace:last:main', { section: 'paper', current: null, table: true }]]))
  await f.context.initialize(); assert.deepEqual(f.calls, [['entry', 'latex']]); assert.deepEqual(f.reads, [])
})

test('standalone browser tabs isolate navigation and retain their identity on refresh without changing the URL', async () => {
  const first = fixture(''), second = fixture('')
  const firstKey = await first.context.workspaceStateKey(), secondKey = await second.context.workspaceStateKey()
  assert.notEqual(firstKey, secondKey)
  const refreshed = fixture('', first.records, null, first.context.history.state)
  assert.equal(await refreshed.context.workspaceStateKey(), firstKey)
  assert.equal(refreshed.context.location.search, '')
  first.context.publishWorkspaceState(writing)
  assert.equal(first.records.get(firstKey).section, 'latex', 'pagehide queues state before the existing persistence flush')
  const other = fixture('', new Map(), null, { unrelated: 'kept' }); await other.context.workspaceStateKey()
  assert.equal(other.context.history.state.unrelated, 'kept')
})
