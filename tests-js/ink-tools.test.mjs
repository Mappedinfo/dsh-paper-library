import test from 'node:test'
import assert from 'node:assert/strict'
import { TOOL_SPECS, requestFromTool } from '../src/harness/tools.mjs'

test('native ink tool carries nested stroke geometry and retry identity through the closed schema', () => {
  const spec = TOOL_SPECS.find(value => value.name === 'library_annotate')
  assert.ok(spec.parameters.type.enum.includes('ink'))
  assert.ok(!spec.parameters.rects.required)
  assert.equal(spec.parameters.paths.items.items.items.type, 'number')
  const fields = { id: 'paper-one', page: 1, type: 'ink', paths: [[[20, 30], [40, 50]]], width: 2,
    annotation_id: 'ca9b4f7a-7575-4e96-8b19-31c4021b3ef2', color: '#305080' }
  assert.deepEqual(requestFromTool(spec, { ...fields, library: '/private', action: 'delete' }, {}), { action: 'annotate', ...fields })
  assert.throws(() => requestFromTool(spec, { ...fields, paths: [Array.from({ length: 8000 }, () => [23.123456789, 42.123456789])] }, {}), /128 KiB/)
})
