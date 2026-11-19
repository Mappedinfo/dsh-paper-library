import test from 'node:test'
import assert from 'node:assert/strict'
import { nodeTensorPreview, shapeSketch, tileCount } from '../src/paper-flow/tensor-preview.mjs'

test('distinguishes scalar, unknown shape, symbolic matrix, higher rank and an open prefix', () => {
  assert.equal(shapeSketch(null).kind, 'unknown')
  assert.equal(shapeSketch([]).kind, 'scalar')
  assert.equal(shapeSketch([12]).kind, 'vector')
  assert.equal(shapeSketch(['B', 16]).kind, 'matrix')
  assert.deepEqual(shapeSketch(['B', 'T', 8]).prefix, ['B'])
  assert.equal(shapeSketch(['B', 'T', 8]).kind, 'slices')
  assert.equal(shapeSketch(['...', 8]).kind, 'vector')
  assert.equal(shapeSketch(['...', 8]).open, true)
  assert.equal(shapeSketch(['...']).kind, 'open')
  assert.equal(shapeSketch(['B', 0, 8]).kind, 'empty')
  assert.equal(tileCount(1200), 5)
})

test('legacy tensor ports retain names and unknown rank; control flow does not claim a shape', () => {
  const legacy = nodeTensorPreview({ op: 'input', ports: { in: {}, out: { x: { type: 'tensor' } } } })
  assert.deepEqual(legacy.outputs.map(a => [a.name, a.shape]), [['x', null]])
  assert.equal(legacy.status, 'unknown')
  assert.equal(nodeTensorPreview({ op: 'guard' }).status, 'not_applicable')
  assert.equal(nodeTensorPreview({ op: 'loss' }).status, 'unknown')
})

test('preserves shape, named weights, partial inference, axis notes and malformed-descriptor bounds', () => {
  const raw = { status: 'partial', note: 'Batch size not known', inputs: [{ name: 'features', shape: ['B', 'T', 8] }],
    outputs: [{ name: 'result', shape: null, note: 'dynamic' }], parameters: [{ name: 'weight', shape: [16, 8] }] }
  const data = nodeTensorPreview({ tensor: raw })
  assert.equal(data.status, 'partial')
  assert.deepEqual(data.parameters[0].shape, [16, 8])
  assert.equal(data.outputs[0].note, 'dynamic')
  assert.deepEqual(nodeTensorPreview({ tensor: { ...raw, inputs: [null, { name: 'x', shape: ['B', -1] }] } }).inputs,
    [{ name: 'x', shape: null, note: '' }])
})

test('an explicit None attention output is distinct from a tensor of unknown shape', () => {
  const inputs = [], outputs = [{ name: 'attn_weights', shape: null, kind: 'none', note: 'None because need_weights=False.' }, { name: 'dynamic', shape: null }]
  const rows = nodeTensorPreview({ tensor: { status: 'partial', inputs, outputs, parameters: [] } }).outputs
  assert.equal(rows[0].note, outputs[0].note)
  assert.deepEqual(rows.map(item => shapeSketch(item.shape, item.kind).kind), ['none', 'unknown'])
  assert.equal(shapeSketch(rows[0].shape, rows[0].kind).label, '未返回（None）')
})
