import test from 'node:test'
import assert from 'node:assert/strict'
import { selectionContexts } from '../vendor/paper-flow/selection-context.js'

const refA = { documentId: 'doc-a', flowId: 'flow-a' }, refB = { documentId: 'doc-b', flowId: 'flow-b' }
const graph = (id, prefix) => ({
  id, name: 'Synthetic flow', nodes: ['source', 'step', 'result'].map(id => ({ id: `${prefix}-${id}`, label: id })), edges: [],
  paper_groups: [{ id: `${prefix}-overview`, members: [`${prefix}-source`, `${prefix}-step`] }],
  detail_groups: [{ id: `${prefix}-detail`, members: [`${prefix}-step`, `${prefix}-result`] }],
})
function fixture() {
  return { selection: { left: refA, right: refB }, documents: [
    { paper: { id: refA.documentId, title: 'Synthetic A' }, flows: [graph(refA.flowId, 'left')] },
    { paper: { id: refB.documentId, title: 'Synthetic B' }, flows: [graph(refB.flowId, 'right')] },
  ] }
}
const expected = (ref, side, nodeIds) => ({ ref, side, nodeIds })

test('raw A and B resolve only the selected flow and do not mutate source declarations', () => {
  const workspace = fixture(), before = JSON.stringify(workspace)
  assert.deepEqual(selectionContexts(workspace, 'a', 'left-step'), [expected(refA, 'a', ['left-step'])])
  assert.deepEqual(selectionContexts(workspace, 'b', 'right-result'), [expected(refB, 'b', ['right-result'])])
  assert.deepEqual(selectionContexts(workspace, 'a', 'right-result'), [])
  assert.equal(JSON.stringify(workspace), before)
})

test('paper and detail group IDs expand only their explicitly declared members', () => {
  const workspace = fixture()
  assert.deepEqual(selectionContexts(workspace, 'a', 'left-overview'), [expected(refA, 'a', ['left-source', 'left-step'])])
  assert.deepEqual(selectionContexts(workspace, 'b', 'right-detail'), [expected(refB, 'b', ['right-step', 'right-result'])])
  assert.deepEqual(selectionContexts(workspace, 'a', '@detail_left-detail'), [], 'a generated-looking prefix is not membership evidence')
})

test('presentation members and collapsed members recursively retain raw source identity', () => {
  const workspace = fixture()
  const visible = { id: 'generated-group', presentation_members: [
    { id: 'left-source' }, { id: 'nested', members: ['left-detail', { id: 'missing' }] }, { id: 'left-source' },
  ] }
  assert.deepEqual(selectionContexts(workspace, 'a', visible.id, visible), [expected(refA, 'a', ['left-source', 'left-step', 'left-result'])])
  assert.deepEqual(selectionContexts(workspace, 'a', 'unknown', { id: 'unknown', members: ['left-step'] }), [expected(refA, 'a', ['left-step'])])
})

test('merged shared and one-sided nodes use explicit source_ids for each original flow', () => {
  const workspace = fixture()
  const shared = { id: 'opaque-merged-id', source_ids: { a: 'left-step', b: 'right-result' } }
  assert.deepEqual(selectionContexts(workspace, 'merged', shared.id, shared), [
    expected(refA, 'a', ['left-step']), expected(refB, 'b', ['right-result']),
  ])
  const oneSided = { id: 'opaque-one-sided', source_ids: { b: 'right-source' } }
  assert.deepEqual(selectionContexts(workspace, 'merged', oneSided.id, oneSided), [expected(refB, 'b', ['right-source'])])
  assert.deepEqual(selectionContexts(workspace, 'merged', 'shared_left-step', { id: 'shared_left-step', label: 'left-step' }), [])
})

test('merged string and object group members resolve through the supplied visible graph', () => {
  const workspace = fixture()
  const merged = { nodes: [
    { id: 'opaque-1', source_ids: { a: 'left-source', b: 'right-source' } },
    { id: 'opaque-2', source_ids: { b: 'right-detail' } },
  ], detail_groups: [{ id: 'opaque-group', members: ['opaque-1', 'opaque-2'] }] }
  const visible = { id: 'visible-wrapper', presentation_members: ['opaque-group', { id: 'nested', members: [merged.nodes[0]] }] }
  assert.deepEqual(selectionContexts(workspace, 'merged', visible.id, visible, merged), [
    expected(refA, 'a', ['left-source']), expected(refB, 'b', ['right-source', 'right-step', 'right-result']),
  ])
  assert.deepEqual(selectionContexts(workspace, 'merged', 'opaque-1', undefined, merged), [
    expected(refA, 'a', ['left-source']), expected(refB, 'b', ['right-source']),
  ])
  assert.deepEqual(selectionContexts(workspace, 'merged', visible.id, { id: visible.id, members: ['left-step', 'right-step'] }, merged), [], 'raw-looking strings cannot be guessed as merged source IDs')
})

test('unknown aliases, labels, metadata and malformed mappings never create references', () => {
  const workspace = fixture()
  assert.deepEqual(selectionContexts(workspace, 'a', 'unknown', { id: 'unknown', label: 'left-step', semantic_key: 'left-step', config: { members: ['left-step'] } }), [])
  assert.deepEqual(selectionContexts(workspace, 'merged', 'unknown', { id: 'unknown', source_ids: { a: 'missing', b: ['right-step'] }, members: ['right-step'] }), [])
  assert.deepEqual(selectionContexts(workspace, 'a', 'unknown', { id: 'unknown', members: 'left-step', presentation_members: { id: 'left-step' } }), [])
  assert.deepEqual(selectionContexts({ ...workspace, selection: { left: refA } }, 'b', 'right-step'), [])
  assert.deepEqual(selectionContexts({ ...workspace, selection: { left: { documentId: 'missing', flowId: 'missing' } } }, 'a', 'left-step'), [])
})

test('cyclic optional membership is bounded and duplicate members remain single selections', () => {
  const workspace = fixture(), visible = { id: 'cyclic', members: ['left-step', 'left-step'] }
  visible.members.push(visible)
  assert.deepEqual(selectionContexts(workspace, 'a', 'cyclic', visible), [expected(refA, 'a', ['left-step'])])
})
