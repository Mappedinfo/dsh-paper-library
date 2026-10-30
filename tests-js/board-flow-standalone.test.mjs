import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { webcrypto } from 'node:crypto'
import vm from 'node:vm'
import { validateFlowWorkspace } from '../src/paper-flow/validation.mjs'

const source = await readFile(new URL('../site/standalone.js', import.meta.url), 'utf8')
const KEY = 'paper-library-whiteboard.v1'
const plain = value => JSON.parse(JSON.stringify(value))
const flow = (title = '合成流程') => ({ schemaVersion: 1, kind: 'paper-flow-document', paper: { id: 'synthetic', title },
  flows: [{ id: 'main', name: 'Main', nodes: [{ id: 'n', label: 'Node', type: 'method', ports: { in: {}, out: {} } }], edges: [] }] })
const newBoard = (title = '合成画板') => ({ action: 'board_create', board: { title, nodes: [{ id: 'n-original', kind: 'text', text: '原内容', x: 3, y: 4 }], edges: [] } })

function memoryStorage() {
  const data = new Map()
  return { fail: false, getItem: key => data.get(key) ?? null,
    setItem(key, value) { if (this.fail) throw Error('synthetic storage failure'); data.set(key, String(value)) }, removeItem: key => data.delete(key) }
}
function store(storage = memoryStorage(), options = {}) {
  const window = { crypto: webcrypto, PaperBoard: { model: {}, outline: board => ({ text: board.title }) }, navigator: {} }
  const document = { readyState: 'loading', addEventListener() {} }
  vm.runInNewContext(source, { window, document, TextEncoder, Uint8Array, setTimeout, clearTimeout })
  return window.PaperBoardStandalone.createStore(storage, { validateFlow: validateFlowWorkspace, ...options })
}
function lockManager() {
  let pending = Promise.resolve()
  const calls = []
  return { calls, request(name, options, task) { calls.push({ name, ...options }); const result = pending.then(task, task); pending = result.catch(() => {}); return result } }
}

test('standalone flow actions are lazy, normalized and separate from node board data', async () => {
  const storage = memoryStorage(), validated = []
  const first = store(storage, { validateFlow: value => { validated.push(value); return validateFlowWorkspace(value) } })
  const created = await first.handle(newBoard()), id = created.board.id
  const before = await first.handle({ action: 'board_get', id })
  assert.equal(validated.length, 0)
  assert.deepEqual(plain(await first.handle({ action: 'board_flow_get', id })), { id, workspace: null, revision: 0 })
  assert.equal(validated.length, 0, 'empty and ordinary board reads do not load the flow engine')
  const saved = await first.handle({ action: 'board_flow_save', id, workspace: flow(), expected_revision: 0 })
  assert.equal(validated.length, 1)
  assert.deepEqual(plain(saved.workspace), validateFlowWorkspace(flow()))
  assert.deepEqual(plain(await store(storage).handle({ action: 'board_flow_get', id })), plain(saved))
  assert.deepEqual(plain(await first.handle({ action: 'board_get', id })), plain(before))
  assert.equal((await first.handle({ action: 'board_list' })).boards.length, 1)
})

test('standalone Web Locks serialize concurrent flow writers and stale revisions retain the winning content', async () => {
  const storage = memoryStorage(), locks = lockManager(), one = store(storage, { locks }), two = store(storage, { locks })
  const id = (await one.handle(newBoard())).board.id
  const writes = await Promise.allSettled([
    one.handle({ action: 'board_flow_save', id, workspace: flow('窗口一'), expected_revision: 0 }),
    two.handle({ action: 'board_flow_save', id, workspace: flow('窗口二'), expected_revision: 0 }),
  ])
  assert.equal(writes.filter(item => item.status === 'fulfilled').length, 1)
  const rejected = writes.find(item => item.status === 'rejected').reason
  assert.equal(rejected.code, 'STATE_CONFLICT')
  const winner = writes.find(item => item.status === 'fulfilled').value
  assert.deepEqual(plain(await two.handle({ action: 'board_flow_get', id })), plain(winner))
  assert.equal(locks.calls.every(call => call.name === KEY && call.mode === 'exclusive'), true)
})

test('standalone fallback rechecks storage after async validation instead of overwriting a concurrent board', async () => {
  const storage = memoryStorage(), other = store(storage)
  let start, finish
  const started = new Promise(resolve => { start = resolve }), gate = new Promise(resolve => { finish = resolve })
  const waiting = store(storage, { validateFlow: async value => { start(); await gate; return validateFlowWorkspace(value) } })
  const id = (await other.handle(newBoard())).board.id
  const saving = waiting.handle({ action: 'board_flow_save', id, workspace: flow(), expected_revision: 0 })
  await started
  await other.handle(newBoard('并发新画板'))
  const changed = storage.getItem(KEY)
  finish()
  await assert.rejects(saving, error => error.code === 'STATE_CONFLICT')
  assert.equal(storage.getItem(KEY), changed)
  assert.equal((await other.handle({ action: 'board_list' })).boards.length, 2)
  assert.equal((await other.handle({ action: 'board_flow_get', id })).workspace, null)
})

test('standalone flow validation, UTF-8 budget and failed storage writes leave previous bytes unchanged', async () => {
  const storage = memoryStorage(), local = store(storage), id = (await local.handle(newBoard())).board.id
  const saved = await local.handle({ action: 'board_flow_save', id, workspace: flow(), expected_revision: 0 })
  const before = storage.getItem(KEY)
  for (const [payload, code] of [
    [{ workspace: { schemaVersion: 99 }, expected_revision: saved.revision }, 'BOARD_FLOW_INVALID'],
    [{ workspace: flow() }, 'BOARD_FLOW_INVALID'],
    [{ workspace: flow('中'.repeat(65536)), expected_revision: saved.revision }, 'BOARD_FLOW_TOO_LARGE'],
  ]) {
    await assert.rejects(local.handle({ action: 'board_flow_save', id, ...payload }), error => error.code === code)
    assert.equal(storage.getItem(KEY), before)
  }
  storage.fail = true
  await assert.rejects(local.handle({ action: 'board_flow_save', id, workspace: flow('写入失败'), expected_revision: saved.revision }), error => error.code === 'BOARD_STORAGE')
  storage.fail = false
  assert.equal(storage.getItem(KEY), before)
})

test('standalone JSON backup restores flow companions under remapped duplicate board IDs', async () => {
  const storage = memoryStorage(), local = store(storage), id = (await local.handle(newBoard())).board.id
  const original = await local.handle({ action: 'board_flow_save', id, workspace: flow(), expected_revision: 0 })
  const backup = plain(local.exportAll())
  assert.equal(backup.schema, 'paper-library-whiteboard.v1')
  assert.equal(backup.boards.length, 1)
  assert.deepEqual(backup.flow_workspaces[id], plain(original.workspace))
  const result = await local.importAll(backup)
  assert.deepEqual(plain(result), { added: 1, renamed: 1 })
  const ids = (await local.handle({ action: 'board_list' })).boards.map(item => item.id)
  const imported = ids.find(value => value !== id)
  assert.deepEqual(plain((await local.handle({ action: 'board_flow_get', id: imported })).workspace), plain(original.workspace))
  assert.deepEqual(plain(await local.handle({ action: 'board_flow_get', id })), plain(original))
  assert.deepEqual(plain((await local.handle({ action: 'board_get', id: imported })).board.nodes), backup.boards[0].nodes)
  const fresh = store(memoryStorage())
  await fresh.importAll(backup)
  assert.deepEqual(plain((await fresh.handle({ action: 'board_flow_get', id })).workspace), plain(original.workspace))
})

test('standalone invalid companion imports fail before any node board or flow is written', async () => {
  const storage = memoryStorage(), local = store(storage), id = (await local.handle(newBoard())).board.id
  const backup = plain(local.exportAll()), before = storage.getItem(KEY)
  for (const flows of [{ [id]: { schemaVersion: 99 } }, { 'board-missing': flow() }, []]) {
    await assert.rejects(local.importAll({ ...backup, flow_workspaces: flows }), error => error.code === 'BOARD_FLOW_INVALID')
    assert.equal(storage.getItem(KEY), before)
  }
  await local.importAll({ boards: backup.boards })
  assert.equal((await local.handle({ action: 'board_list' })).boards.length, 2, 'legacy backups without companions still import')
})

test('standalone parent deletion preserves hidden flow data and corrupted state cannot be overwritten', async () => {
  const storage = memoryStorage(), local = store(storage), parent = await local.handle(newBoard()), id = parent.board.id
  await local.handle({ action: 'board_flow_save', id, workspace: flow(), expected_revision: 0 })
  const oldFlow = JSON.parse(storage.getItem(KEY)).flow_workspaces[id]
  await local.handle({ action: 'board_delete', id, expected_revision: parent.revision })
  for (const action of ['board_flow_get', 'board_flow_save']) await assert.rejects(local.handle({ action, id, workspace: flow(), expected_revision: oldFlow.revision }), error => error.code === 'BOARD_NOT_FOUND')
  assert.deepEqual(JSON.parse(storage.getItem(KEY)).flow_workspaces[id], oldFlow)
  storage.setItem(KEY, '{corrupt')
  await assert.rejects(local.handle(newBoard()), error => error.code === 'STATE_CORRUPT')
  assert.equal(storage.getItem(KEY), '{corrupt')
})

test('standalone corrupt flow envelopes cannot masquerade as an unwritten revision zero', async () => {
  const storage = memoryStorage(), local = store(storage), id = (await local.handle(newBoard())).board.id
  const base = JSON.parse(storage.getItem(KEY))
  for (const entry of [null, { workspace: flow(), revision: '' }]) {
    storage.setItem(KEY, JSON.stringify({ ...base, flow_workspaces: { [id]: entry } }))
    const before = storage.getItem(KEY)
    for (const action of ['board_flow_get', 'board_flow_save']) await assert.rejects(local.handle({ action, id, workspace: flow(), expected_revision: 0 }), error => error.code === 'BOARD_FLOW_CORRUPT')
    assert.equal(storage.getItem(KEY), before)
  }
})
