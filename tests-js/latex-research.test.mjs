import test from 'node:test'
import assert from 'node:assert/strict'
import { createLatexResearch, normalizeLatexRetrieval } from '../src/harness/latex-research.mjs'

const project = { id: 'lt-0123456789ab', root: '/synthetic', binding_generation: 4 }
const session = (text, trace = []) => ({ text, trace, rounds: 2, calls: trace.length, usedTools: true, truncated: false })
const hit = (line, text = 'sample excerpt') => ({ path: 'chapters/synthetic.tex', line, end_line: line, text, revision: 'rev-123' })
const article = { id: 'doi:10.0000/synthetic', provider: 'crossref', title: 'Synthetic article', authors: ['A. Example'], year: 2024, doi: '10.0000/synthetic', url: 'https://doi.org/10.0000/synthetic', abstract: 'SYNTHETIC_ABSTRACT_ONLY', evidence_level: 'abstract' }

test('project reads are pinned to the server binding; only the approved indexed term goes to public search', async () => {
  const network = [], local = []
  const research = createLatexResearch({
    dispatch: async (args, { signal }) => { signal.throwIfAborted(); local.push(args); return { matches: [hit(17)], truncated: false } },
    search: { search: async args => { network.push(args); return { status: 'ok', results: [article], providers: [{ provider: 'crossref', status: 'ok', count: 1 }] } } },
    run: async ({ tools, executeTool, prompt, requireToolUse }) => {
      assert.equal(requireToolUse, true)
      assert.match(prompt, /SYNTHETIC_PRIVATE_CONTEXT/)
      assert.deepEqual(tools.map(tool => tool.name), ['list_project_files', 'search_project', 'read_project_file', 'read_project_pdf', 'scholar_search'])
      assert.deepEqual(tools.at(-1).parameters.properties.query_index.enum, [1])
      await assert.rejects(executeTool('search_project', { query: 'synthetic', id: 'other', expected_root: '/outside' }), /参数超出/)
      await assert.rejects(executeTool('write_project_file', {}), /没有授权/)
      await assert.rejects(executeTool('scholar_search', { query_index: 1, query: 'SYNTHETIC_PRIVATE_CONTEXT' }), /参数超出/)
      await assert.rejects(executeTool('scholar_search', { query_index: 2 }), /只能选择/)
      const matches = await executeTool('search_project', { query: 'sample', glob: '*.tex' })
      assert.equal(matches.matches[0].source_id, 'F1')
      assert.equal((await executeTool('scholar_search', { query_index: 1 })).results[0].source_id, 'S1')
      await executeTool('scholar_search', { query_index: 1 })
      return session('合成项目 [F1] 与摘要 [S1]。')
    },
  })
  const result = await research({ project, prompt: 'SYNTHETIC_PRIVATE_CONTEXT', retrieval: { project: true, public_queries: ['synthetic public topic'] } })
  assert.deepEqual(local, [{ query: 'sample', glob: '*.tex', action: 'latex_search', id: project.id, expected_root: project.root, expected_binding_generation: 4 }])
  assert.deepEqual(network, [{ query: 'synthetic public topic', limit: 5 }])
  assert.deepEqual(result.retrieval.sources.map(({ id, kind, evidence_level }) => ({ id, kind, evidence_level })), [
    { id: 'F1', kind: 'file', evidence_level: 'project-text' }, { id: 'S1', kind: 'scholar', evidence_level: 'abstract' },
  ])
  assert.equal(result.retrieval.sources[0].line, 17)
  assert.equal(result.retrieval.public_search.attempted, 1)
  assert.doesNotMatch(JSON.stringify(result.retrieval), /sample excerpt|SYNTHETIC_ABSTRACT_ONLY|synthetic public topic|SYNTHETIC_PRIVATE_CONTEXT/)
})

test('structured truncation excludes sources the model never received', async () => {
  const research = createLatexResearch({
    dispatch: async () => ({ matches: [hit(1, 'x'.repeat(130)), hit(2, 'y'.repeat(130)), hit(3, 'z'.repeat(130))], truncated: false }),
    run: async ({ executeTool, prompt }) => {
      const value = await executeTool('search_project', { query: 'example' }, { maxResultCharacters: 400 })
      assert.equal(value.truncated, true)
      assert.equal(value.matches.length, 1)
      assert.ok(JSON.stringify(value).length <= 400)
      return session(prompt.includes('invented citation') ? '误引 [F2]' : '已核对 [F1]')
    },
  })
  const request = { project, prompt: 'read', retrieval: { project: true, public_queries: [] } }
  const result = await research(request)
  assert.deepEqual(result.retrieval.sources.map(item => item.id), ['F1'])
  assert.equal(result.retrieval.truncated, true)
  await assert.rejects(research({ ...request, prompt: 'invented citation' }), error => error.code === 'LATEX_RETRIEVAL_CITATION')
})

test('clipped text retains only its actual line range and clipped listing pagination does not skip files', async () => {
  const files = Array.from({ length: 10 }, (_, index) => ({ path: `${index}-${'x'.repeat(40)}.tex`, kind: 'text', bytes: 3 }))
  const research = createLatexResearch({
    dispatch: async ({ action }) => action === 'latex_retrieval_list'
      ? { files, offset: 20, limit: 10, has_more: false, truncated: false }
      : { path: 'long.tex', content: 'content line\n'.repeat(100), start_line: 21, end_line: 120, revision: 'rev-456', truncated: false },
    run: async ({ executeTool }) => {
      const list = await executeTool('list_project_files', { offset: 20, limit: 10 }, { maxResultCharacters: 360 })
      assert.ok(list.files.length > 0 && list.files.length < 10)
      assert.equal(list.next_offset, 20 + list.files.length)
      assert.equal(list.has_more, true)
      const read = await executeTool('read_project_file', { path: 'long.tex', start_line: 21 }, { maxResultCharacters: 400 })
      assert.ok(read.content && read.end_line < 120)
      assert.equal(read.end_line, 20 + read.content.replace(/\n$/, '').split('\n').length)
      return session(`核对至第 ${read.end_line} 行 [F1]`)
    },
  })
  const result = await research({ project, prompt: 'check', retrieval: { project: true, public_queries: [] } })
  assert.match(result.text, new RegExp(`第 ${result.retrieval.sources[0].end_line} 行`))
  assert.equal(result.retrieval.truncated, true)
})

test('an unavailable academic source is reported as a failure, not an empty search', async () => {
  const research = createLatexResearch({
    search: { search: async () => ({ status: 'unavailable', results: [], providers: [{ provider: 'crossref', status: 'error', error: { code: 'unsafe_dns' } }] }) },
    run: async ({ tools, executeTool }) => {
      assert.deepEqual(tools.map(tool => tool.name), ['scholar_search'])
      await assert.rejects(executeTool('read_project_file', { path: 'main.tex' }), /没有授权/)
      assert.equal((await executeTool('scholar_search', { query_index: 1 })).ok, false)
      throw Object.assign(new Error('no successful tool results'), { code: 'TOOL_AI_NO_RETRIEVAL' })
    },
  })
  await assert.rejects(research({ project, prompt: 'check', retrieval: { project: false, public_queries: ['public topic'] } }), error => error.code === 'LATEX_SCHOLAR_UNAVAILABLE')
})

test('invalid or implicit public keywords are rejected before running tools', () => {
  assert.equal(normalizeLatexRetrieval(undefined), null)
  assert.deepEqual(normalizeLatexRetrieval({ project: true, public_queries: [' a ', 'a'] }), { project: true, public_queries: ['a'] })
  for (const bad of [null, { project: true, public_queries: [] , query: 'x' }, { project: 'true', public_queries: [] }, { project: true, public_queries: ['...'] }, { project: false, public_queries: ['a\nb'] }, { project: false, public_queries: ['a'.repeat(201)] }, { project: false, public_queries: ['a', 'b', 'c', 'd'] }]) {
    assert.throws(() => normalizeLatexRetrieval(bad), error => error.code === 'LATEX_RETRIEVAL_INVALID')
  }
})
