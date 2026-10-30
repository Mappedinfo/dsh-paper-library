import test from 'node:test'
import assert from 'node:assert/strict'
import { compareFlows, prepareGraph } from '../vendor/paper-flow/comparison.js'
import { normalizeGraph } from '../vendor/paper-flow/model.js'
import engine from '../vendor/paper-flow/core/graph.js'

const graph = (id, definition) => ({
  id, name: id,
  ...(definition ? { stages: [definition] } : {}),
  nodes: [{ id: 'n', label: 'Synthetic', stage: 's', source_stage: { id: 'original', title: 'Original' }, type: 'method', op: 'copy', semantic_key: 'copy', ports: { in: {}, out: {} } }],
  edges: [],
})

test('merged comparison preserves conflicting local stage definitions without mutating inputs', () => {
  const a = graph('a', { id: 's', title: 'Preparation', note: 'One' })
  const b = graph('b', { id: 's', title: 'Evaluation', note: 'Two' })
  a.stage_notes = { s: 'A note' }; b.stage_notes = { s: 'B note' }
  const original = structuredClone({ a, b }), result = compareFlows(a, b)
  assert.equal(result.report.pairs.length, 0)
  assert.deepEqual(result.merged.stages.map(s => s.title), ['Preparation', 'Evaluation'])
  assert.equal(new Set(result.merged.stages.map(s => s.id)).size, 2)
  for (const n of result.merged.nodes) {
    const stage = result.merged.stages.find(s => s.id === n.stage)
    assert.equal(stage.comparison_stage_source.id, 's')
    assert.equal(stage.comparison_stage_source.lane, n.status)
    assert.deepEqual(n.source_stage, { id: 'original', title: 'Original' })
    assert.equal(result.merged.stage_notes[n.status][n.stage], `${n.status.toUpperCase()} note`)
  }
  assert.deepEqual({ a, b }, original)
  assert.equal(result.a.nodes[0].stage, 's')
  assert.match(result.report.notes.join(' '), /分别保留/)
  assert.deepEqual(engine.lint(prepareGraph(result.merged, { detail: 'full' })), [])
})

test('a missing stage definition does not acquire the other graph definition', () => {
  const result = compareFlows(graph('a'), graph('b', { id: 's', title: 'Declared B' }))
  assert.equal(result.report.pairs.length, 0)
  const aNode = result.merged.nodes.find(n => n.status === 'a')
  const aStage = result.merged.stages.find(s => s.id === aNode.stage)
  assert.equal(aStage.comparison_stage_source.declared, false)
  assert.match(aStage.title, /未声明定义/)
  assert.equal(result.merged.stages.find(s => s.title === 'Declared B').comparison_stage_source.declared, true)
})

test('identical definitions keep their IDs and an explicit mapping remains authoritative', () => {
  const a = graph('a', { id: 's', title: 'Shared' }), b = graph('b', { title: 'Shared', id: 's' })
  const same = compareFlows(a, b)
  assert.equal(same.report.pairs.length, 1)
  assert.deepEqual(same.merged.stages, a.stages)
  b.stages[0].title = 'Different'
  const mapped = compareFlows(a, b, { mode: 'logical', stageMap: { a: { s: 'joint' }, b: { s: 'joint' }, stages: [{ id: 'joint', title: 'Explicit alignment' }] } })
  assert.equal(mapped.report.pairs.length, 1)
  assert.deepEqual(mapped.merged.stages, [{ id: 'joint', title: 'Explicit alignment' }])
})

test('normalization preserves absent edge declarations instead of inventing data semantics', () => {
  const raw = { id: 'g', name: 'Synthetic', nodes: [], edges: [{ id: 'e', from: 'a:x', to: 'b:x' }] }
  const edge = normalizeGraph(raw).edges[0]
  assert.equal(Object.hasOwn(edge, 'kind'), false)
  assert.equal(Object.hasOwn(edge, 'semantic'), false)
})

test('unassigned nodes stay unassigned when merged with a staged graph or an explicit mapping', () => {
  const a = graph('a'), b = graph('b', { id: 's', title: 'Declared B' })
  delete a.nodes[0].stage
  const merged = compareFlows(a, b).merged
  assert.deepEqual(engine.lint(merged), [])
  assert.equal(merged.nodes.find(n => n.status === 'a').stage, '@unassigned')
  delete b.nodes[0].stage; delete b.stages
  const mapped = compareFlows(a, b, { mode: 'logical', stageMap: { a: {}, b: {}, stages: [{ id: 'joint', title: 'Declared mapping' }] } })
  assert.deepEqual(engine.lint(mapped.merged), [])
  assert.equal(mapped.merged.nodes[0].stage, '@unassigned')
  assert.ok(mapped.report.pairs[0].notCompared.includes('stage'))
  assert.equal(mapped.merged.stages.filter(s => s.id === '@unassigned').length, 1)
})

test('partial explicit stage maps retain unmapped definitions without silently aligning them', () => {
  const a = graph('a', { id: 's', title: 'Local stage' }), b = graph('b', { id: 's', title: 'Local stage' })
  const result = compareFlows(a, b, { mode: 'logical', stageMap: { a: {}, b: {}, stages: [{ id: 'joint', title: 'Unused mapping' }] } })
  assert.deepEqual(engine.lint(result.merged), [])
  assert.equal(result.report.pairs.length, 0)
  assert.equal(result.merged.stages.filter(s => s.title === 'Local stage').length, 2)
  assert.notEqual(result.a.nodes[0].stage, result.b.nodes[0].stage)
})
