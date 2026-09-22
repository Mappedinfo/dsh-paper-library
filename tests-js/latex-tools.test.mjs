/**
 * The LaTeX tool surface: reading and editing stay separate tools, every path is
 * project-relative, and the worker's action names match what the reader bridge
 * admits so a tool call cannot be rejected as an unknown operation.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { BRIDGE_ACTIONS } from '../src/bridge.mjs'
import { LATEX_TOOL_SPECS, latexToolRequest } from '../src/harness/latex-tools.mjs'
import { TOOL_SPECS, requestFromTool } from '../src/harness/tools.mjs'

const spec = name => TOOL_SPECS.find(value => value.name === name)
const exec = { agent: { session: { header: { cwd: '/tmp/workspace' } } } }

test('reading and editing are separate tools with disjoint operations', () => {
  const read = spec('library_latex')
  const edit = spec('library_latex_edit')
  assert.ok(read && edit)
  assert.deepEqual(LATEX_TOOL_SPECS.map(item => item.name), ['library_latex', 'library_latex_edit'])
  assert.equal(read.mutate, undefined)
  assert.equal(edit.mutate, true)
  const readOps = new Set(read.parameters.operation.enum)
  const editOps = new Set(edit.parameters.operation.enum)
  for (const operation of editOps) assert.ok(!readOps.has(operation), operation)
  assert.throws(() => requestFromTool(read, { operation: 'write', input_json: '{}' }, exec), /library_latex_edit/)
  assert.throws(() => requestFromTool(edit, { operation: 'read', input_json: '{}' }, exec), /library_latex for reads/)
  assert.throws(() => requestFromTool(edit, { operation: 'nope', input_json: '{}' }, exec), /Unsupported LaTeX operation/)
})

test('latex requests map to worker actions and never carry deployment paths', () => {
  const edit = spec('library_latex_edit')
  assert.deepEqual(
    requestFromTool(edit, { operation: 'write', input_json: JSON.stringify({ id: 'lt-0123456789ab', path: 'sections/intro.tex', content: 'text', expected_revision: 'abc', origin: 'llm' }) }, exec),
    { id: 'lt-0123456789ab', path: 'sections/intro.tex', content: 'text', expected_revision: 'abc', origin: 'llm', action: 'latex_write' },
  )
  assert.deepEqual(
    requestFromTool(spec('library_latex'), { operation: 'compare', input_json: JSON.stringify({ a: 'lt-0123456789ab', b: 'lt-abcdef012345' }) }, exec),
    { a: 'lt-0123456789ab', b: 'lt-abcdef012345', action: 'latex_compare' },
  )
  assert.throws(() => latexToolRequest(edit, { operation: 'write', input_json: JSON.stringify({ action: 'latex_clean' }) }), /owned by the host/)
  assert.throws(() => latexToolRequest(edit, { operation: 'write', input_json: JSON.stringify({ library: '/etc' }) }), /owned by the host/)
  assert.throws(() => latexToolRequest(edit, { operation: 'write', input_json: 'not json' }), /valid JSON/)
  assert.throws(() => latexToolRequest(edit, { operation: 'write', input_json: '[]' }), /must be an object/)
  assert.throws(() => latexToolRequest(edit, { operation: 'write', input_json: JSON.stringify({ content: 'x'.repeat(130 * 1024) }) }), /128 KiB/)
  assert.equal(latexToolRequest(edit, { operation: 'project_create', input_json: JSON.stringify({ root: '/Users/example/papers/manuscript', create_missing: true }) }).action, 'latex_project_create')
})

test('the bridge admits exactly the actions these tools produce', () => {
  const produced = new Set()
  for (const item of LATEX_TOOL_SPECS) for (const operation of item.parameters.operation.enum) produced.add(`latex_${operation}`)
  assert.deepEqual([...produced].sort(), [...BRIDGE_ACTIONS.latex].sort())
  assert.equal(BRIDGE_ACTIONS.latex.size, 16)
  for (const name of produced) assert.ok(BRIDGE_ACTIONS.latex.has(name), name)
})
