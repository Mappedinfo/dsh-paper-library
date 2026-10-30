import test from 'node:test'
import assert from 'node:assert/strict'
import { createFlowController } from '../src/paper-flow/controller.mjs'
import { starterWorkspace } from '../src/paper-flow/starter.mjs'
import { validateFlowWorkspace } from '../src/paper-flow/validation.mjs'

const value = name => ({ name })
const validate = input => { if (!input || typeof input.name !== 'string') throw Error('无效工作区'); return structuredClone(input) }
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }

test('neutral starter and teaching example pass the real workspace validator', () => {
  for (const example of [false, true]) {
    const workspace = validateFlowWorkspace(starterWorkspace(example))
    assert.equal(workspace.kind, 'paper-flow-workspace')
    assert.equal(workspace.documents[0].flows[0].nodes.length, example ? 2 : 1)
  }
})

test('edits made during a save are written in order with the returned revision', async () => {
  const first = deferred(), writes = []
  const api = async (action, args) => {
    if (action === 'board_flow_get') return { id: args.id, workspace: value('original'), revision: 0 }
    writes.push(structuredClone(args))
    if (writes.length === 1) return first.promise
    return { id: args.id, workspace: args.workspace, revision: 'r2' }
  }
  const controller = createFlowController({ api, validate, delay: 60000 })
  assert.equal(await controller.open({ id: 'board-a', title: 'A' }), true)
  controller.edit(value('first')); const saving = controller.flush(); controller.edit(value('second'))
  first.resolve({ id: 'board-a', workspace: value('first'), revision: 'r1' })
  assert.equal(await saving, true)
  assert.deepEqual(writes.map(row => [row.workspace.name, row.expected_revision]), [['first', 0], ['second', 'r1']])
  assert.equal(controller.state().workspace.name, 'second'); assert.equal(controller.state().dirty, false)
  controller.dispose()
})

test('conflict or failure prevents leaving and switching until retry or explicit reload', async () => {
  let fail = true
  const api = async (action, args) => {
    if (action === 'board_flow_get') return { id: args.id, workspace: value('stored'), revision: 0 }
    if (fail) throw Object.assign(Error('版本冲突'), { code: 'STATE_CONFLICT' })
    return { id: args.id, workspace: args.workspace, revision: 'r1' }
  }
  const controller = createFlowController({ api, validate, delay: 60000 })
  await controller.open({ id: 'a', title: 'A' }); controller.edit(value('draft'))
  assert.equal(await controller.flush(), false); assert.equal(await controller.prepareLeave(), false)
  assert.equal(await controller.open({ id: 'b', title: 'B' }), false)
  assert.equal(controller.state().id, 'a'); assert.equal(controller.state().workspace.name, 'draft')
  fail = false; assert.equal(await controller.flush({ retry: true }), true); assert.equal(await controller.prepareLeave(), true)
  controller.dispose()
})

test('late reads cannot replace new edits; failed reads retain the old board', async () => {
  const pending = deferred(); let usePending = false
  const api = async (action, args) => {
    if (action === 'board_flow_save') return { id: args.id, workspace: args.workspace, revision: 'r1' }
    if (usePending) return pending.promise
    return { id: args.id, workspace: value('stored'), revision: 0 }
  }
  const controller = createFlowController({ api, validate, delay: 60000 })
  await controller.open({ id: 'a', title: 'A' }); usePending = true
  const opening = controller.open({ id: 'b', title: 'B' }); await Promise.resolve(); controller.edit(value('new edit'))
  pending.resolve({ id: 'b', workspace: value('other'), revision: 0 })
  assert.equal(await opening, false); assert.equal(controller.state().id, 'a'); assert.equal(controller.state().workspace.name, 'new edit')
  controller.dispose()
})

test('empty board is not written until a valid seed or user edit exists', async () => {
  let writes = 0
  const api = async (action, args) => { if (action === 'board_flow_get') return { id: args.id, workspace: null, revision: 0 }; writes++; return { id: args.id, workspace: args.workspace, revision: 'r1' } }
  const controller = createFlowController({ api, validate, delay: 60000 })
  await controller.open({ id: 'a', title: 'A' }); assert.equal(await controller.prepareLeave(), true); assert.equal(writes, 0)
  controller.edit({ wrong: true }); assert.equal(await controller.prepareLeave(), false); assert.equal(controller.state().dirty, true)
  controller.edit(value('fixed')); assert.equal(await controller.prepareLeave(), true); assert.equal(writes, 1)
  controller.dispose()
})

test('a save response with different content never marks the local draft saved', async () => {
  const api = async (action, args) => action === 'board_flow_get'
    ? { id: args.id, workspace: value('stored'), revision: 0 }
    : { id: args.id, workspace: value('old'), revision: 'r1' }
  const controller = createFlowController({ api, validate, delay: 60000 })
  await controller.open({ id: 'a', title: 'A' }); controller.edit(value('draft'))
  assert.equal(await controller.flush(), false); assert.equal(controller.state().workspace.name, 'draft')
  assert.equal(controller.state().dirty, true); assert.equal(controller.state().revision, 0)
  assert.match(controller.state().error, /不一致/); assert.equal(await controller.prepareLeave(), false)
  controller.dispose()
})

test('reopening a clean board refreshes it; reopening a dirty board retains its draft', async () => {
  let reads = 0
  const api = async (_action, args) => ({ id: args.id, workspace: value(`stored-${++reads}`), revision: reads })
  const controller = createFlowController({ api, validate, delay: 60000 })
  await controller.open({ id: 'a', title: 'A' }); await controller.open({ id: 'a', title: 'A' })
  assert.equal(controller.state().workspace.name, 'stored-2')
  controller.edit(value('draft')); await controller.open({ id: 'a', title: 'A' })
  assert.equal(reads, 2); assert.equal(controller.state().workspace.name, 'draft')
  controller.dispose()
})

test('late external imports cannot replace newer edits, reloaded state or another board', async () => {
  const api = async (action, args) => action === 'board_flow_get'
    ? { id: args.id, workspace: value(`stored-${args.id}`), revision: 0 }
    : { id: args.id, workspace: args.workspace, revision: 'r1' }
  const controller = createFlowController({ api, validate, delay: 60000 })
  await controller.open({ id: 'a', title: 'A' })
  async function importLater(wait) { const owner = controller.token(); const input = await wait.promise; return controller.applyExternal(input, owner) }
  const edited = deferred(), afterEdit = importLater(edited)
  const editOwner = controller.token(); controller.edit(value('first'), editOwner); controller.edit(value('second'), editOwner)
  edited.resolve(value('old import')); assert.equal(await afterEdit, false); assert.equal(controller.state().workspace.name, 'second')
  await controller.prepareLeave()
  const reloaded = deferred(), afterReload = importLater(reloaded)
  await controller.reload(); reloaded.resolve(value('old import')); assert.equal(await afterReload, false); assert.equal(controller.state().workspace.name, 'stored-a')
  const switched = deferred(), afterSwitch = importLater(switched)
  await controller.open({ id: 'b', title: 'B' }); switched.resolve(value('old import')); assert.equal(await afterSwitch, false); assert.equal(controller.state().workspace.name, 'stored-b')
  const closed = deferred(), afterClose = importLater(closed)
  controller.invalidatePending(); closed.resolve(value('old import')); assert.equal(await afterClose, false); assert.equal(controller.state().workspace.name, 'stored-b')
  controller.dispose()
})
