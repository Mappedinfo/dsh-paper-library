import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLocalStateStore } from '../src/local-state.mjs'
import { createBoardStore } from '../src/harness/board-store.mjs'
import { createBoardFlowStore, BOARD_FLOW_KEY_PREFIX, BOARD_FLOW_LIMITS } from '../src/harness/board-flow-store.mjs'
import { handleBoardRequest } from '../src/harness/board-tools.mjs'
import { createFetchHandler } from '../src/http.mjs'
import { validateFlowWorkspace } from '../src/paper-flow/validation.mjs'

const document = (title = '合成流程') => ({
  schemaVersion: 1, kind: 'paper-flow-document', paper: { id: 'synthetic', title },
  flows: [{ id: 'main', name: 'Main', nodes: [{ id: 'n', label: '合成节点', type: 'method', ports: { in: {}, out: {} } }], edges: [] }],
})

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'paper-board-flow-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const library = join(root, 'library'), home = join(root, 'home')
  await mkdir(library)
  const localState = createLocalStateStore({ library, home })
  const boards = createBoardStore({ localState })
  const parent = await boards.create({ board: {
    title: '原节点画板', nodes: [{ id: 'n-original', kind: 'text', x: 30, y: 20, text: '保留原内容' }], edges: [],
    links: { papers: ['paper-synthetic'], projects: ['project-synthetic'], slides: ['pd-synthetic'] },
  } })
  const flows = createBoardFlowStore({ localState, boards })
  return { root, library, home, localState, boards, flows, parent, id: parent.board.id,
    options: { library, localStateHome: home, localState, boards, boardFlows: flows } }
}

async function call(handler, input) {
  const response = await handler(new Request('http://127.0.0.1/api', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input),
  }))
  return { status: response.status, ...await response.json() }
}

test('a flow companion normalizes, survives a fresh store, and leaves its parent and frozen snapshot unchanged', async t => {
  const f = await fixture(t)
  const before = await f.boards.read(f.id), snapshot = await f.boards.snapshot({ id: f.id })
  assert.deepEqual(await f.flows.get(f.id), { id: f.id, workspace: null, revision: 0 })
  assert.equal((await f.localState.list({ prefix: BOARD_FLOW_KEY_PREFIX })).total, 0, 'reading a missing workspace allocates nothing')
  const input = document(), saved = await f.flows.save({ id: f.id, workspace: input, expectedRevision: 0 })
  assert.deepEqual(saved.workspace, validateFlowWorkspace(input))
  assert.match(saved.revision, /^[a-f0-9]{64}$/)
  input.paper.title = '调用者后来修改输入'
  const fresh = createBoardFlowStore({ localState: createLocalStateStore({ library: f.library, home: f.home }), boards: f.boards })
  assert.deepEqual(await fresh.get(f.id), saved)
  assert.deepEqual(await f.boards.read(f.id), before, 'nodes, links and parent revision are untouched')
  assert.equal((await f.boards.snapshot({ id: f.id })).snapshot_id, snapshot.snapshot_id)
  assert.equal((await f.boards.list()).boards.length, 1, 'companion records never leak into the board list')
})

test('two writers cannot both initialize or overwrite the same flow revision', async t => {
  const f = await fixture(t)
  const second = createBoardFlowStore({ localState: createLocalStateStore({ library: f.library, home: f.home }), boards: f.boards })
  const results = await Promise.allSettled([
    f.flows.save({ id: f.id, workspace: document('窗口一'), expectedRevision: 0 }),
    second.save({ id: f.id, workspace: document('窗口二'), expectedRevision: 0 }),
  ])
  assert.equal(results.filter(item => item.status === 'fulfilled').length, 1)
  const rejected = results.find(item => item.status === 'rejected').reason
  assert.equal(rejected.code, 'STATE_CONFLICT')
  const winner = results.find(item => item.status === 'fulfilled').value
  assert.deepEqual(await second.get(f.id), winner)
  const updated = await second.save({ id: f.id, workspace: document('新版'), expectedRevision: winner.revision })
  await assert.rejects(f.flows.save({ id: f.id, workspace: document('过期'), expectedRevision: winner.revision }), error => error.code === 'STATE_CONFLICT')
  assert.deepEqual(await f.flows.get(f.id), updated)
})

test('invalid, oversized and missing-revision saves preserve the previous workspace', async t => {
  const f = await fixture(t)
  const saved = await f.flows.save({ id: f.id, workspace: document(), expectedRevision: 0 })
  const attempts = [
    [{ id: f.id, workspace: { schemaVersion: 99 }, expectedRevision: saved.revision }, 'BOARD_FLOW_INVALID'],
    [{ id: f.id, workspace: document() }, 'BOARD_FLOW_INVALID'],
    [{ id: '../escape', workspace: document(), expectedRevision: 0 }, 'BOARD_FLOW_INVALID'],
    [{ id: f.id, workspace: document('中'.repeat(Math.ceil(BOARD_FLOW_LIMITS.workspaceBytes / 3))), expectedRevision: saved.revision }, 'BOARD_FLOW_TOO_LARGE'],
  ]
  for (const [input, code] of attempts) {
    await assert.rejects(f.flows.save(input), error => error.code === code)
    assert.deepEqual(await f.flows.get(f.id), saved)
  }
})

test('a missing or deleted parent refuses access without deleting its preserved companion', async t => {
  const f = await fixture(t)
  await assert.rejects(f.flows.get('b-missing'), error => error.code === 'BOARD_NOT_FOUND')
  await assert.rejects(f.flows.save({ id: 'b-missing', workspace: document(), expectedRevision: 0 }), error => error.code === 'BOARD_NOT_FOUND')
  assert.equal((await f.localState.list({ prefix: BOARD_FLOW_KEY_PREFIX })).total, 0)
  await f.flows.save({ id: f.id, workspace: document(), expectedRevision: 0 })
  const record = await f.localState.get(`${BOARD_FLOW_KEY_PREFIX}${f.id}`)
  await f.boards.remove({ id: f.id, expectedRevision: f.parent.revision })
  await assert.rejects(f.flows.get(f.id), error => error.code === 'BOARD_NOT_FOUND')
  await assert.rejects(f.flows.save({ id: f.id, workspace: document('不能写入'), expectedRevision: record.revision }), error => error.code === 'BOARD_NOT_FOUND')
  assert.deepEqual(await f.localState.get(`${BOARD_FLOW_KEY_PREFIX}${f.id}`), record)
})

test('independent boards have independent flow revisions and stored corruption stays visible', async t => {
  const f = await fixture(t)
  const other = await f.boards.create({ board: { title: '第二张', nodes: [], edges: [] } })
  const first = await f.flows.save({ id: f.id, workspace: document('第一份'), expectedRevision: 0 })
  const second = await f.flows.save({ id: other.board.id, workspace: document('第二份'), expectedRevision: 0 })
  await assert.rejects(f.flows.save({ id: f.id, workspace: document('错误版本'), expectedRevision: second.revision }), error => error.code === 'STATE_CONFLICT')
  assert.deepEqual(await f.flows.get(f.id), first)
  await f.localState.put(`${BOARD_FLOW_KEY_PREFIX}${other.board.id}`, { schemaVersion: 99 }, second.revision)
  const corrupt = await f.localState.get(`${BOARD_FLOW_KEY_PREFIX}${other.board.id}`)
  await assert.rejects(f.flows.get(other.board.id), error => error.code === 'BOARD_FLOW_CORRUPT' && error.status === 500)
  assert.deepEqual(await f.localState.get(`${BOARD_FLOW_KEY_PREFIX}${other.board.id}`), corrupt)
})

test('the browser flow API round-trips and shares CAS across newly constructed handlers', async t => {
  const f = await fixture(t), handler = createFetchHandler(f.options)
  const missing = await call(handler, { action: 'board_flow_get', id: f.id })
  assert.equal(missing.status, 200)
  assert.deepEqual(missing.result, { id: f.id, workspace: null, revision: 0 })
  const saved = await call(handler, { action: 'board_flow_save', id: f.id, workspace: document(), expected_revision: 0 })
  assert.equal(saved.status, 200)
  const fresh = createFetchHandler({ library: f.library, localStateHome: f.home })
  assert.deepEqual((await call(fresh, { action: 'board_flow_get', id: f.id })).result, saved.result)
  const stale = await call(fresh, { action: 'board_flow_save', id: f.id, workspace: document('过期'), expected_revision: 0 })
  assert.equal(stale.status, 409)
  assert.equal(stale.code, 'STATE_CONFLICT')
  assert.deepEqual(stale.current.value, saved.result.workspace)
  const invalid = await call(handler, { action: 'board_flow_save', id: f.id, workspace: { schemaVersion: 99 }, expected_revision: saved.result.revision })
  assert.equal(invalid.status, 400)
  assert.equal((await call(handler, { action: 'board_flow_save', id: f.id, workspace: document() })).status, 400)
  assert.deepEqual((await call(handler, { action: 'board_flow_get', id: f.id })).result, saved.result)
})

test('generic browser state and agent requests cannot bypass flow validation or ownership', async t => {
  const f = await fixture(t), handler = createFetchHandler(f.options)
  const key = `${BOARD_FLOW_KEY_PREFIX}${f.id}`
  for (const action of ['state_get', 'state_put', 'state_list']) {
    const denied = await call(handler, { action, key, prefix: key, value: document(), expected_revision: 0 })
    assert.equal(denied.status, 403)
    assert.equal(denied.code, 'STATE_FORBIDDEN')
  }
  for (const action of ['board_flow_get', 'board_flow_save']) {
    await assert.rejects(handleBoardRequest(f.boards, { action, id: f.id, workspace: document(), expected_revision: 0 }, { writer: 'llm', flowStore: f.flows }), error => error.code === 'BOARD_FORBIDDEN')
  }
  assert.equal((await f.localState.list({ prefix: BOARD_FLOW_KEY_PREFIX })).total, 0)
  const unknown = await call(handler, { action: 'board_flow_get', id: 'b-missing' })
  assert.equal(unknown.status, 404)
  assert.equal(unknown.code, 'BOARD_NOT_FOUND')
})
