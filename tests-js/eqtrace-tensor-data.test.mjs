import test from 'node:test'
import assert from 'node:assert/strict'
import { bindInputShape, readNpyShape } from '../src/paper-flow/tensor-data.mjs'

function makeNpy({ version = 1, header, payload = 0, pad = true }) {
  const lengthEnd = version === 1 ? 10 : 12
  if (pad) header += ' '.repeat((64 - ((lengthEnd + header.length + 1) % 64)) % 64) + '\n'
  const encoded = new TextEncoder().encode(header)
  const prefix = new Uint8Array(lengthEnd)
  prefix.set([147, 78, 85, 77, 80, 89, version, 0])
  const view = new DataView(prefix.buffer)
  if (version === 1) view.setUint16(8, encoded.length, true)
  else view.setUint32(8, encoded.length, true)
  return new Blob([prefix, encoded, new Uint8Array(payload)])
}
const headerOf = (shape, dtype = '<f4', order = 'False') =>
  "{'descr': '" + dtype + "', 'fortran_order': " + order + ", 'shape': " + shape + ", }"

test('reads only the prefix and header of NumPy versions 1, 2 and 3', async () => {
  for (const version of [1, 2, 3]) {
    const file = makeNpy({ version, header: headerOf('(2, 3)', '>f8', 'True'), payload: 48 })
    const reads = []
    const guarded = { size: file.size, slice(start, end) {
      assert.ok(end <= file.size - 48, 'must never read array values')
      reads.push([start, end]); return file.slice(start, end)
    }}
    assert.deepEqual(await readNpyShape(guarded), { shape: [2, 3], dtype: '>f8', fortranOrder: true })
    assert.equal(reads.at(-1)[1], file.size - 48)
  }
})

test('accepts scalar, vector, empty and complex arrays and arbitrary dictionary key order', async () => {
  for (const [tuple, shape, dtype, payload] of [
    ['()', [], '|b1', 1], ['(4,)', [4], '<c16', 64], ['(9007199254740991, 0)', [Number.MAX_SAFE_INTEGER,0], '<i4', 0],
  ]) {
    const header = '{"shape":' + tuple + ',"fortran_order":False,"descr":"' + dtype + '"}'
    assert.deepEqual(await readNpyShape(makeNpy({ header, payload })), { shape, dtype, fortranOrder: false })
  }
})

test('rejects wrong magic/version, malformed or truncated headers and incorrect payload lengths', async () => {
  await assert.rejects(readNpyShape(new Blob(['not-an-npy-file'])), /NPY 标识/)
  const good = makeNpy({ header: headerOf('(3,)'), payload: 12 })
  await assert.rejects(readNpyShape(good.slice(0, 8)), /截断/)
  await assert.rejects(readNpyShape(good.slice(0, 20)), /截断/)
  await assert.rejects(readNpyShape(good.slice(0, good.size - 1)), /数据长度/)
  await assert.rejects(readNpyShape(new Blob([good, new Uint8Array(1)])), /数据长度/)
  await assert.rejects(readNpyShape(makeNpy({ version: 4, header: headerOf('()') })), /只支持/)
  await assert.rejects(readNpyShape(makeNpy({ header: headerOf('()'), pad: false })), /文件头无效/)
  const oversized = new Uint8Array([147,78,85,77,80,89,2,0,1,0,1,0])
  await assert.rejects(readNpyShape(new Blob([oversized])), /64 KiB/)
})

test('rejects invalid types, duplicate fields, unsafe integers and nonliteral expressions', async () => {
  for (const header of [headerOf('(2,)', '|O'), headerOf('(2,)', 'float(4)'), headerOf('(2,)', '<f3'),
    headerOf('(2)'), headerOf('(-1,)'), headerOf('(2 * 3,)'), headerOf('(9007199254740992,)'),
    headerOf('()', '<i2', '0'), headerOf('()').replace('}', "'shape': (),}"),
    headerOf('()') + ';globalThis.evaluated=true', headerOf('()').replace("'shape'", "'wrong_field'")]) {
    await assert.rejects(readNpyShape(makeNpy({ header })), /NPY|数值|浮点/)
  }
})

test('binds only named axes, respects fixed/repeated dimensions, wildcards, scalars and unknown rank', () => {
  assert.deepEqual({ ...bindInputShape(['B','S','S',8], [0,5,5,8]) }, { B: 0, S: 5 })
  assert.deepEqual({ ...bindInputShape(['...', '?', 'T', 16], [7,9,12,16]) }, { T: 12 })
  assert.deepEqual({ ...bindInputShape(['...', 'T'], [4]) }, { T: 4 })
  for (const [declared, actual] of [[[],[]],[['...'],[]],[null,[2,3]]]) {
    assert.deepEqual({ ...bindInputShape(declared, actual) }, {})
  }
  const safe = bindInputShape(['constructor'], [2])
  assert.equal(Object.getPrototypeOf(safe), null)
  assert.equal(safe.constructor, 2)
})

test('fails conflicting bindings or nonliteral axes without evaluating text', () => {
  for (const [declared, actual] of [
    [['B','B'], [2,3]], [[5], [9]], [['B','T'], [9]], [['...','T',4], [4]],
    [['B','...'], [3,5]], [['T+1'], [3]], [['B'], [1.5]], [['B'], [-1]], [['B'], [Infinity]], [[], new Array(1)],
  ]) assert.throws(() => bindInputShape(declared, actual), /轴|符号|维数|省略号/)
})
