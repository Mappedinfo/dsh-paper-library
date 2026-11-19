import test from 'node:test'
import assert from 'node:assert/strict'
import { nodeTensorPreview, tensorDimensionContext, bindTensorShape, boundAxisLabel, shapeSketch, tileCount } from '../src/paper-flow/tensor-preview.mjs'

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

const descriptors = (...shapes) => ({ inputs: shapes.map((shape, i) => ({ name: String(i), shape })), outputs: [], parameters: [] })

test('each node shows only its distinct symbols in input, output and parameter shapes and keeps explicit labels', () => {
  const tensor = { inputs: [{shape:['B','T',32]}], outputs: [{shape:['B','T',32]}], parameters: [{shape:['S','T2',32]}, {shape:null,kind:'none'}] }
  const meanings = { B: '批大小', S: '源序列长度', T: '目标序列长度' }
  const ctx = tensorDimensionContext(tensor, { B: 2, S: 8, T: 5, other: 99 }, meanings)
  assert.equal(ctx.mode, 'example')
  assert.deepEqual([...ctx.bindings.keys()], ['B','T','S','T2'])
  assert.equal(ctx.bindings.get('T').meaning, '目标序列长度')
  assert.equal(ctx.bindings.get('T2').meaning, '')
  assert.equal(boundAxisLabel('T2', ctx), 'T2 = 未指定')
  assert.equal(boundAxisLabel(32, ctx), '32')
  assert.deepEqual(bindTensorShape(tensor.inputs[0].shape, ctx).shape, [2,5,32])
  assert.deepEqual(tensor.inputs[0].shape, ['B','T',32])
})

test('actual input axes take precedence throughout the figure; unobserved symbols never fall back to example values', () => {
  const tensor = descriptors(['B','S','T'], ['...', 'B', '?'], null, [])
  const ctx = tensorDimensionContext(tensor, { B:2,S:8,T:5 }, {}, { B:{value:4,source:'/inputs/source.npy'}, S:{value:12,source:'source.npy'} })
  assert.equal(ctx.mode, 'actual')
  assert.equal(ctx.bindings.get('B').source, 'source.npy')
  assert.equal(ctx.bindings.get('T').value, undefined)
  assert.deepEqual(bindTensorShape(tensor.inputs[0].shape, ctx).shape, [4,12,'T'])
  assert.equal(boundAxisLabel('B',ctx), 'B = 4')
  assert.equal(boundAxisLabel('S',ctx), 'S = 12')
  assert.equal(boundAxisLabel('T',ctx), 'T = 未指定')
  const open = shapeSketch(bindTensorShape(tensor.inputs[1].shape, ctx).shape)
  assert.equal(open.open,true); assert.deepEqual(open.axes,[4,'?'])
  assert.equal(shapeSketch(bindTensorShape(null, ctx).shape,'none').kind,'none')
  assert.equal(shapeSketch(bindTensorShape([], ctx).shape).kind,'scalar')
  const other = tensorDimensionContext(descriptors(['T']), { T:5 }, {}, { B:{value:4,source:'source.npy'} })
  assert.equal(boundAxisLabel('T',other),'T = 未指定')
})

test('symbolic arithmetic uses whole identifiers, integer precedence and partial substitution only where safe', () => {
  const shape = ['N2', 'N * 2 + (T - 1)', 'Num + N', 'N // 3', 'N / 3', '?', '...', 'math.ceil(N)', 'N.value', 'foo(N)', 99]
  const ctx = tensorDimensionContext(descriptors(shape), { N:4, N2:11, T:2, Num:-1, foo:4, math:8 })
  assert.deepEqual([...ctx.bindings.keys()], ['N2','N','T','Num'])
  assert.deepEqual(bindTensorShape(shape, ctx).shape, [11,9,'Num + 4',1,'4 / 3','?','...','math.ceil(N)','N.value','foo(N)',99])
  assert.deepEqual(bindTensorShape(['N×N2','2N','T2','1 + (T'], ctx).shape, [44,'2N','T2','1 + (T'])
  const max=Number.MAX_SAFE_INTEGER
  const wide=tensorDimensionContext(descriptors(['P % Q']), {P:max-1,Q:max})
  assert.deepEqual(bindTensorShape(['P % Q'],wide).shape,[max-1])
  assert.equal(shapeSketch(bindTensorShape(['B','S'], tensorDimensionContext(descriptors(['B','S']),{B:0,S:8})).shape).kind,'empty')
})

test('malformed bindings, negative or oversized lengths do not become example measurements', () => {
  const tensor=descriptors(['B','S','T','X','Y'])
  const invalid=tensorDimensionContext(tensor, { B:Infinity,S:1.4,T:-1,X:'7',Y:Number.MAX_SAFE_INTEGER+1 }, undefined, { B:{ value:4, source:'' }, S:{ value:-1, source:'bad.npy' } })
  assert.equal(invalid.mode,'example')
  assert.ok([...invalid.bindings.values()].every(info => info.value === undefined))
  assert.deepEqual(bindTensorShape(['B','S','T'],invalid).shape,['B','S','T'])
})

test('imported measured axes require named sources; new local files replace the entire imported batch', () => {
  const tensor=descriptors(['B','S','T'])
  const imported={ B:{ value:4,source:'batch04.npy' }, S:{ value:12,source:'Recorded run / input pair' }, T:{ value:5,source:'' } }
  const fromRecord=tensorDimensionContext(tensor,{B:2,S:8,T:5},{},undefined,imported)
  assert.equal(fromRecord.imported,true)
  assert.equal(fromRecord.mode,'actual')
  assert.deepEqual(bindTensorShape(tensor.inputs[0].shape,fromRecord).shape,[4,12,'T'])
  assert.equal(fromRecord.bindings.get('S').source,'Recorded run / input pair')
  const fromLocal=tensorDimensionContext(tensor,{B:2,S:8,T:5},{},{T:{value:3,source:'target.npy'}},imported)
  assert.equal(fromLocal.imported,false)
  assert.deepEqual(bindTensorShape(tensor.inputs[0].shape,fromLocal).shape,['B','S',3])
})
