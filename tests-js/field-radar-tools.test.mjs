import test from 'node:test'
import assert from 'node:assert/strict'
import { FIELD_RADAR_TOOL_SPECS, fieldRadarToolRequest } from '../src/harness/field-radar-tools.mjs'
import { registerLibraryTools, requestFromTool } from '../src/harness/tools.mjs'
import { bundledLibrarySkills } from '../src/harness/skills.mjs'
const read = FIELD_RADAR_TOOL_SPECS[0], write = FIELD_RADAR_TOOL_SPECS[1], analyze = FIELD_RADAR_TOOL_SPECS[2]
test('closed radar tools cannot supply actions, runtime settings, paths or oversized envelopes', () => {
  assert.deepEqual(fieldRadarToolRequest(read, { operation: 'get', input_json: '{"id":"topic"}' }), { action: 'field_radar_get', id: 'topic' })
  for (const value of [{ action: 'delete' }, { path: '/private' }, { library: '/private' }, { provider: 'override' }, []]) assert.throws(() => fieldRadarToolRequest(read, { operation: 'get', input_json: JSON.stringify(value) }))
  assert.throws(() => fieldRadarToolRequest(read, { operation: 'import', input_json: '{}' }))
  assert.throws(() => fieldRadarToolRequest(write, { input_json: JSON.stringify({ document: 'x'.repeat(128 * 1024) }) }))
  assert.deepEqual(requestFromTool(analyze, { input_json: '{"id":"topic","expected_revision":"abc","request_id":"r1"}' }, {}), { action: 'field_radar_analyze', id: 'topic', expected_revision: 'abc', request_id: 'r1' })
})
test('registration delegates shared services, propagates cancellation and routes mutations through policy', async () => {
  const tools = new Map(), hooks = [], calls = [], signal = new AbortController().signal
  const ctx = { tools: { register: tool => { tools.set(tool.name, tool); return () => tools.delete(tool.name) } }, on: (name, fn) => { hooks.push(fn); return () => {} } }
  const service = { handle: async (request, context) => { calls.push({ request, signal: context.signal }); return { fixture: true } } }
  const dispose = registerLibraryTools(ctx, value => value, () => { throw new Error('Must not dispatch to Python') }, { fieldRadar: service, fieldRadarAnalysis: service }, { requireToolApproval: true })
  const exec = { signal }
  await tools.get(read.name).execute({ operation: 'list', input_json: '{}' }, exec)
  await tools.get(write.name).execute({ input_json: '{"document":{},"expected_revision":0}' }, exec)
  await tools.get(analyze.name).execute({ input_json: '{"id":"topic","expected_revision":"abc","request_id":"r1"}' }, exec)
  assert.deepEqual(calls.map(row => row.request.action), ['field_radar_list', 'field_radar_import', 'field_radar_analyze']); assert.ok(calls.every(row => row.signal === signal))
  const next = async () => ({ kind: 'allow' })
  assert.equal((await hooks[0]({ name: read.name }, next)).kind, 'allow')
  assert.equal((await hooks[0]({ name: write.name }, next)).kind, 'ask')
  assert.match((await hooks[0]({ name: analyze.name }, next)).reason, /model quota/)
  assert.equal((await hooks[0]({ name: analyze.name }, async () => ({ kind: 'deny' }))).kind, 'deny')
  dispose(); assert.equal(tools.size, 0)
})
test('bundled radar skill is registered with evidence, inference, automation and budget boundaries', () => { const skill = bundledLibrarySkills().find(row => row.name === 'paper-library-radar'); assert.ok(skill); assert.match(skill.content, /library_field_radar_analyze/); assert.match(skill.content, /128 KiB/); assert.match(skill.content, /not an autonomous schedule/); assert.match(skill.content, /do not require the user to read papers first/); assert.equal(skill.invocation.modelInvocable, true) })
