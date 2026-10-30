import test from 'node:test'
import assert from 'node:assert/strict'
import { compareFlows, prepareGraph } from '../vendor/paper-flow/comparison.js'
import engine from '../vendor/paper-flow/core/graph.js'

const graph = (name, logical = { key: 'clean', function: 'normalize' }, extra = {}) => ({
  id: name, name, nodes: [{ id: 'n', label: 'Synthetic', type: 'method', op: 'normalize', logical, ports: { in: {}, out: {} }, ...extra }], edges: [],
})
const pairs = (a, b) => compareFlows(a, b).report.pairs
const linked = (name, outPort, inPort, { role, portType = 'text', kind = 'data', semantic } = {}) => ({
  id: name, name, nodes: [
    { id: 'a', label: 'Source', type: 'method', op: 'source', logical: { key: 'source', function: 'produce', ...(role !== undefined ? { ports: { out: { [outPort]: role } } } : {}) }, ports: { in: {}, out: { [outPort]: { type: portType } } } },
    { id: 'b', label: 'Target', type: 'method', op: 'target', logical: { key: 'target', function: 'consume', ...(role !== undefined ? { ports: { in: { [inPort]: role } } } : {}) }, ports: { in: { [inPort]: { type: portType } }, out: {} } },
  ], edges: [{ id: 'edge', from: `a:${outPort}`, to: `b:${inPort}`, ...(kind !== undefined ? { kind } : {}), ...(semantic !== undefined ? { semantic } : {}) }],
})

test('matching uses declared fields, does not invent geographical claims or differences', () => {
  const [pair] = pairs(graph('a'), graph('b'))
  assert.equal(pair.equivalence, 'logical')
  assert.ok(pair.comparedFields.includes('logical.key'))
  assert.ok(pair.comparedFields.includes('logical.function'))
  assert.ok(pair.notCompared.includes('stage'))
  assert.doesNotMatch(pair.reason, /城市|时空|空间|时间|科学等价.*一致/)
  assert.equal(pair.impacted, false)
  assert.equal(pair.impact_reason, undefined)
  assert.deepEqual(pair.declaredDifferences, [])
})

test('missing, unknown, conflicting or incompatible selected logical fields cannot match', () => {
  const base = { key: 'clean', function: 'normalize', constraints: { language: 'en' } }
  assert.equal(pairs(graph('a', base), graph('b', { key: 'clean', function: 'normalize' })).length, 0)
  assert.equal(pairs(graph('a', base), graph('b', { ...base, constraints: { language: 'zh' } })).length, 0)
  assert.equal(pairs(graph('a', { ...base, constraints: { language: 'unknown' } }), graph('b', { ...base, constraints: { language: 'unknown' } })).length, 0)
  assert.equal(pairs(graph('a', { ...base, compare_fields: ['constraints.language'] }), graph('b', { ...base, compare_fields: ['constraints.missing'] })).length, 0)
  assert.equal(pairs(graph('a', { ...base, compare_fields: ['constraints.missing'] }), graph('b', { ...base, compare_fields: ['constraints.missing'] })).length, 0)
})

test('explicit partial basis retains and reports unselected differences', () => {
  const l = { key: 'clean', function: 'normalize', compare_fields: ['key', 'function'], space: { scope: 'A' }, constraints: { script: 'one' } }
  const r = { ...l, space: { scope: 'B' }, constraints: { script: 'two' } }
  const [pair] = pairs(graph('a', l), graph('b', r))
  assert.ok(pair)
  assert.ok(pair.notCompared.includes('logical.space.scope'))
  assert.ok(pair.notCompared.includes('logical.constraints.script'))
  assert.ok(pair.declaredDifferences.some(item => item.field === 'logical_scope.space.scope'))
  assert.match(pair.reason, /其他声明有差异/)
  assert.equal(pair.impacted, true)
})

test('domain-sounding comparison levels do not silently ignore unselected or conflicting scopes', () => {
  const a = { key: 'compare', function: 'evaluate', comparison_level: 'evaluation_function', space: { scope: 'A' } }
  const b = { ...a, space: { scope: 'B' } }
  assert.equal(pairs(graph('a', a), graph('b', b)).length, 0, 'default compares every declared logical field')
  a.compare_fields = ['key', 'function']; b.compare_fields = ['function', 'key']
  const [pair] = pairs(graph('a', a), graph('b', b))
  assert.ok(pair.notCompared.includes('logical.space.scope'))
  assert.ok(pair.notCompared.includes('logical.comparison_level'))
  assert.ok(pair.declaredDifferences.some(item => item.field === 'logical_scope.space.scope'))
})

test('selected Unicode paths are compared and unselected unknown values are not evidence', () => {
  const a = { key: 'clean', function: 'normalize', compare_fields: ['constraints.材料'], constraints: { 材料: '文本', 来源: 'unknown' } }
  const b = structuredClone(a)
  const [pair] = pairs(graph('a', a), graph('b', b))
  assert.ok(pair.comparedFields.includes('logical.constraints.材料'))
  assert.ok(pair.notCompared.includes('logical.constraints.来源'))
  b.constraints.材料 = '图像'
  assert.equal(pairs(graph('a', a), graph('b', b)).length, 0)
})

test('equivalent explicit field lists are order independent and do not create a false impact', () => {
  const l = { key: 'clean', function: 'normalize', compare_fields: ['key', 'function'] }
  const r = { ...l, compare_fields: ['function', 'key'] }
  const [pair] = pairs(graph('a', l), graph('b', r))
  assert.ok(pair)
  assert.deepEqual(pair.declaredDifferences, [])
  assert.equal(pair.impacted, false)
})

test('equal local stage IDs with conflicting stage definitions do not merge', () => {
  const a = graph('a', undefined, { stage: 's' }), b = graph('b', undefined, { stage: 's' })
  a.stages = [{ id: 's', title: 'Preparation' }]
  b.stages = [{ id: 's', title: 'Evaluation' }]
  assert.equal(pairs(a, b).length, 0)
  a.nodes[0].semantic_key = 'same'; b.nodes[0].semantic_key = 'same'
  assert.equal(pairs(a, b).length, 0, 'strict matching must also respect stage definitions')
})

test('an explicit stage map enables alignment while missing definitions remain unconfirmed', () => {
  const a = graph('a', undefined, { stage: 'left' }), b = graph('b', undefined, { stage: 'right' })
  a.stages = [{ id: 'left', title: 'A phase' }]; b.stages = [{ id: 'right', title: 'B phase' }]
  assert.equal(pairs(a, b).length, 0)
  const mapped = compareFlows(a, b, { mode: 'logical', correspondences: [], exclusions: [], stageMap: { a: { left: 'joint' }, b: { right: 'joint' }, stages: [{ id: 'joint', title: 'Declared mapping' }] } })
  assert.equal(mapped.report.pairs.length, 1)
  assert.ok(mapped.report.pairs[0].comparedFields.includes('stage.definition'))
  delete a.stages; delete b.stages
  a.nodes[0].stage = 'same'; b.nodes[0].stage = 'same'
  assert.equal(pairs(a, b).length, 0, 'matching local names without definitions is insufficient')
})

test('strict matching reports only real declarations and legends avoid domain defaults', () => {
  const a = graph('a', undefined, { semantic_key: 'shared' }), b = graph('b', undefined, { semantic_key: 'shared' })
  delete a.nodes[0].logical; delete b.nodes[0].logical
  const [pair] = pairs(a, b)
  assert.equal(pair.equivalence, 'strict')
  assert.ok(pair.comparedFields.includes('op'))
  assert.ok(pair.notCompared.includes('stage'))
  assert.ok(pair.notCompared.includes('config'))
  assert.equal(pair.logical_equal, undefined)
  assert.doesNotMatch(pair.reason, /阶段.*一致|配置.*一致/)
  const merged = compareFlows(a, b).merged
  const svg = engine.svg(prepareGraph(merged, { detail: 'full', arrangement: 'trunks', treeLevels: 'expanded', grouping: true })).svg
  assert.doesNotMatch(svg, /城市|时空|监督\/参数|权重|张量|实验输入资源/)
})

test('unknown or missing functional port roles cannot align different port names', () => {
  for (const role of ['unknown', 'unverified', '', null, undefined]) {
    const result = compareFlows(linked('a', 'outA', 'inA', { role }), linked('b', 'outB', 'inB', { role })).report
    assert.equal(result.pairs.length, 2)
    assert.equal(result.edgePairs.length, 0, `unconfirmed role ${role} must not align different names`)
  }
})

test('declared same port names and known types remain a valid fallback when a role is missing', () => {
  const a = linked('a', 'out', 'in', { role: 'feature' }), b = linked('b', 'out', 'in', {})
  const result = compareFlows(a, b).report
  assert.equal(result.edgePairs.length, 1)
  assert.ok(result.edgePairs[0].comparedFields.includes('ports'))
  assert.doesNotMatch(result.edgePairs[0].reason, /功能端口按声明对齐/)
})

test('explicit matching functional roles can align different ports without hiding declared type differences', () => {
  const a = linked('a', 'outA', 'inA', { role: 'shared', portType: 'text' })
  const b = linked('b', 'outB', 'inB', { role: 'shared', portType: 'image' })
  const [edge] = compareFlows(a, b).report.edgePairs
  assert.equal(edge.equivalence, 'logical')
  assert.ok(edge.comparedFields.includes('logical.ports'))
  assert.ok(edge.notCompared.includes('ports'))
  assert.ok(edge.declaredDifferences.some(item => item.field === 'from.type'))
  assert.ok(edge.declaredDifferences.some(item => item.field === 'to.type'))
})

test('unknown port types do not prove strict node or edge equality', () => {
  const a = linked('a', 'out', 'in', { role: 'shared', portType: 'unknown' })
  const b = linked('b', 'out', 'in', { role: 'shared', portType: 'unknown' })
  a.nodes.forEach(n => { n.semantic_key = n.id }); b.nodes.forEach(n => { n.semantic_key = n.id })
  const report = compareFlows(a, b).report
  assert.ok(report.pairs.every(pair => pair.equivalence !== 'strict'))
  assert.ok(report.edgePairs.every(pair => pair.equivalence !== 'strict'))
})

test('unknown edge kind or unconfirmed kind never becomes a strict claimed basis', () => {
  const unknown = compareFlows(linked('a', 'out', 'in', { kind: 'unknown', semantic: 'unknown' }), linked('b', 'out', 'in', { kind: 'unknown', semantic: 'unknown' })).report
  assert.equal(unknown.edgePairs.length, 0)
  const a = linked('a', 'out', 'in', {}), b = linked('b', 'out', 'in', {})
  delete a.edges[0].kind; delete b.edges[0].kind
  const missing = compareFlows(a, b).report
  assert.equal(missing.edgePairs.length, 0, 'unconfirmed edge kind retains both edges')
  const different = compareFlows(a, linked('b', 'out', 'in', { kind: 'data' })).report
  assert.equal(different.edgePairs.length, 0, 'absent kind must not be silently treated as declared data')
})

test('unknown semantic, config or condition values cannot produce an edge match', () => {
  for (const [field, value] of [['semantic', 'unverified'], ['config', { setting: 'unknown' }], ['condition', '未知']]) {
    const a = linked('a', 'out', 'in', {}), b = linked('b', 'out', 'in', {})
    a.edges[0][field] = value; b.edges[0][field] = structuredClone(value)
    assert.equal(compareFlows(a, b).report.edgePairs.length, 0, field)
  }
})

test('unknown edge metadata cannot disambiguate duplicate strict node candidates', () => {
  const make = id => {
    const common = (nodeId, key) => ({ id: nodeId, label: nodeId, type: 'method', semantic_key: key, op: 'normalize', ports: { in: { p: { type: 'text' } }, out: { p: { type: 'text' } } } })
    return { id, name: id, nodes: [common('a1', 'duplicate'), common('a2', 'duplicate'), common('b1', 'one'), common('b2', 'two')], edges: [
      { id: 'e1', from: 'a1:p', to: 'b1:p', kind: 'unknown' }, { id: 'e2', from: 'a2:p', to: 'b2:p', kind: 'unknown' },
    ] }
  }
  const report = compareFlows(make('left'), make('right')).report
  assert.equal(report.pairs.filter(pair => pair.semantic_key === 'duplicate').length, 0)
})

test('matched edges preserve unselected B metadata and report differences without mutating input', () => {
  const a = linked('a', 'out', 'in', {}), b = linked('b', 'out', 'in', {})
  Object.assign(a.edges[0], { label: 'A label', detail: 'A detail', evidence: 'A evidence', state: 'A state' })
  Object.assign(b.edges[0], { label: 'B label', detail: 'B detail', evidence: 'B evidence', state: 'B state' })
  const source = JSON.stringify({ a, b })
  const result = compareFlows(a, b)
  const [pair] = result.report.edgePairs, [edge] = result.merged.edges.filter(item => item.status === 'shared')
  for (const field of ['label', 'detail', 'evidence', 'state']) {
    assert.ok(pair.notCompared.includes(field))
    assert.ok(pair.declaredDifferences.some(item => item.field === field))
    assert.equal(edge.other[field], b.edges[0][field])
  }
  assert.match(pair.reason, /其他声明有差异/)
  assert.deepEqual(edge.declaredDifferences, pair.declaredDifferences)
  assert.equal(JSON.stringify({ a, b }), source)
})

test('unmatched or unknown inputs do not imply downstream impact or specification differences', () => {
  const a = linked('a', 'out', 'in', { kind: 'unknown' }), b = linked('b', 'out', 'in', { kind: 'unknown' })
  const result = compareFlows(a, b)
  assert.equal(result.report.edgePairs.length, 0)
  assert.ok(result.report.pairs.every(pair => !pair.impacted && !pair.impact_reason))
  assert.ok(result.report.aOnlyEdges.every(edge => !edge.reason.includes('不同')))
  const svg = engine.svg(prepareGraph(result.merged, { detail: 'full', arrangement: 'trunks', treeLevels: 'expanded', grouping: true })).svg
  assert.doesNotMatch(svg, /规格不同|上游影响|A独有|B独有/)
  assert.match(svg, /所选字段一致/)
})
