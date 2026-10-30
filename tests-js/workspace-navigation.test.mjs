import test from 'node:test'
import assert from 'node:assert/strict'
import { createWorkspaceNavigation } from '../src/harness/workspace-navigation.mjs'

const plain = value => JSON.parse(JSON.stringify(value))
function fixture(overrides = {}) {
  const papers = [{ id: 'p-main', title: '合成文献', resource_kind: 'paper' }, { id: 'p-two', title: '第二篇合成文献', resource_kind: 'paper' }]
  const projects = [{ id: 'reading', title: '合成阅读项目' }]
  const boardData = [
    { id: 'b-direct', title: '直接关联画板', links: { papers: ['p-main'], projects: ['reading'] }, nodes: [] },
    { id: 'b-node', title: '节点关联画板', nodes: [{ kind: 'paper', paper: { id: 'p-main', title: '旧题名' } }] },
    { id: 'b-project', title: '阅读项目画板', links: { projects: ['reading'] }, nodes: [] },
    { id: 'b-unrelated', title: '合成文献', nodes: [] },
  ]
  const latex = [
    { id: 'l-main', title: '写作项目', reading_project_id: 'reading', root: '/synthetic/private/path', exists: true, main_path: 'main.tex' },
    { id: 'l-other', title: '合成文献', root: '/synthetic/other', exists: true },
    { id: 'l-missing', title: '目录保留的写作项目', reading_project_id: 'reading', exists: false },
  ]
  const calls = [], reads = []
  const boards = {
    async list() { return { boards: boardData.map(({ id, title, nodes }) => ({ id, title, node_count: nodes.length })), total: boardData.length, truncated: false } },
    async read(id) { reads.push(id); const board = boardData.find(value => value.id === id); if (!board) throw Error('missing board'); return { board: plain(board), revision: 'a'.repeat(64) } },
    ...overrides.boards,
  }
  const request = async (input, signal) => {
    calls.push(plain(input)); signal?.throwIfAborted()
    if (overrides.request) { const result = await overrides.request(input); if (result !== undefined) return result }
    if (input.action === 'get') { const paper = papers.find(item => item.id === input.id); if (!paper) throw Error('missing paper'); return plain(paper) }
    if (input.action === 'project_for_paper') return { projects: input.paper_id === 'p-main' ? plain(projects) : [], total: input.paper_id === 'p-main' ? projects.length : 0 }
    if (input.action === 'project_list') return { projects: plain(projects), total: projects.length }
    if (input.action === 'resource_list') return { items: plain(papers), total: papers.length }
    if (input.action === 'latex_project_list') {
      const candidates = latex.filter(value => !input.query || value.title.includes(input.query))
      return { projects: plain(candidates.slice(input.offset, input.offset + input.limit)), total: candidates.length, truncated: input.offset + input.limit < candidates.length }
    }
    throw Error(`Unexpected request: ${input.action}`)
  }
  return { service: createWorkspaceNavigation({ boards, request }), calls, reads, papers, projects, boardData, latex }
}

test('category catalogs paginate metadata and exclude private roots and source contents', async () => {
  const f = fixture()
  const boards = await f.service.handle({ action: 'workspace_catalog', kind: 'board', query: '画板', offset: 1, limit: 1 })
  assert.equal(boards.items.length, 1); assert.equal(boards.total, 3); assert.equal(boards.has_more, true)
  assert.deepEqual(f.reads, [], 'board catalog uses summaries, not every board body')
  const latex = await f.service.handle({ action: 'workspace_catalog', kind: 'latex', offset: 0, limit: 1 })
  assert.equal(latex.items[0].kind, 'latex'); assert.equal(latex.total, 3); assert.equal(latex.has_more, true); assert.equal(latex.truncated, false)
  assert.equal(JSON.stringify(latex).includes('/synthetic/'), false)
  assert.equal(latex.items[0].main_path, 'main.tex')
})

test('paper children use only explicit board bindings or explicit shared reading projects', async () => {
  const f = fixture(), before = plain({ papers: f.papers, boards: f.boardData, latex: f.latex })
  const got = await f.service.handle({ action: 'workspace_related', kind: 'paper', id: 'p-main' })
  assert.equal(got.focus.title, '合成文献')
  assert.deepEqual(got.groups.board.items.map(item => item.id).sort(), ['b-direct', 'b-node', 'b-project'])
  assert.equal(got.groups.board.items.some(item => item.id === 'b-unrelated'), false, 'equal titles are not links')
  assert.deepEqual(got.groups.latex.items.map(item => item.id).sort(), ['l-main', 'l-missing'])
  const via = got.groups.board.items.find(item => item.id === 'b-project')
  assert.deepEqual(via.via, { kind: 'project', id: 'reading', title: '合成阅读项目' })
  assert.match(via.relation, /通过阅读项目/)
  assert.equal(got.groups.latex.items.find(item => item.id === 'l-missing').missing, true)
  assert.equal(got.groups.paper.total, 0)
  assert.deepEqual(plain({ papers: f.papers, boards: f.boardData, latex: f.latex }), before)
})

test('board children reciprocate saved papers and reading-project writing links without ownership inference', async () => {
  const f = fixture()
  const got = await f.service.handle({ action: 'workspace_related', kind: 'board', id: 'b-direct' })
  assert.deepEqual(got.groups.paper.items.map(item => item.id).sort(), ['p-main', 'p-two'])
  assert.equal(got.groups.paper.items.find(item => item.id === 'p-main').title, '合成文献')
  assert.match(got.groups.paper.items.find(item => item.id === 'p-main').relation, /明确关联/)
  assert.match(got.groups.paper.items.find(item => item.id === 'p-two').relation, /通过阅读项目/)
  assert.deepEqual(got.groups.latex.items.map(item => item.id).sort(), ['l-main', 'l-missing'])
  assert.equal(f.calls.filter(call => call.action === 'project_list').length, 1)
  assert.equal(f.calls.some(call => /write|compile|pdf|tree|outline|snapshot/.test(call.action)), false)
})

test('writing-project children use catalog metadata only and reciprocate reading-project links', async () => {
  const f = fixture()
  const got = await f.service.handle({ action: 'workspace_related', kind: 'latex', id: 'l-main', group_kind: 'paper', offset: 1, limit: 1 })
  assert.equal(got.groups.paper.items.length, 1); assert.equal(got.groups.paper.offset, 1)
  assert.equal(got.groups.board.offset, 0); assert.equal(got.groups.board.total, 2)
  assert.match(got.groups.board.items[0].relation, /通过阅读项目/)
  assert.equal(f.calls.some(call => call.action === 'latex_project_get'), false, 'project_get would walk the source directory; navigation avoids it')
  assert.equal(got.groups.latex.total, 0)
})

test('partial sources and failed metadata remain distinct from an empty relation list', async () => {
  const f = fixture({ boards: { async list() { return { boards: [{ id: 'bad', title: '不可读取' }], total: 70, truncated: true } }, async read() { throw Error('synthetic path must not leak') } }, request: input => { if (input.action === 'latex_project_list') throw Error('synthetic secret source') } })
  const got = await f.service.handle({ action: 'workspace_related', kind: 'paper', id: 'p-main' })
  assert.equal(got.truncated, true); assert.equal(got.groups.board.total, null); assert.equal(got.groups.latex.total, null)
  assert.equal(got.groups.board.known_total, 0); assert.ok(got.warnings.length >= 2)
  assert.equal(JSON.stringify(got).includes('synthetic secret'), false)
  const catalog = await f.service.handle({ action: 'workspace_catalog', kind: 'board' })
  assert.equal(catalog.total, null); assert.equal(catalog.truncated, true)
})

test('large projects and missing direct paper records keep bounded requests and original identities', async () => {
  const f = fixture({ request: input => input.action === 'resource_list' ? { items: [{ id: 'p-main', title: '合成文献' }], total: 100, truncated: true } : undefined })
  f.boardData[0].links.papers = Array.from({ length: 25 }, (_, index) => `unavailable-${index}`)
  const got = await f.service.handle({ action: 'workspace_related', kind: 'board', id: 'b-direct', limit: 3 })
  assert.equal(got.groups.paper.items.length, 3); assert.equal(got.groups.paper.total, null); assert.equal(got.groups.paper.known_total, 26)
  assert.equal(f.calls.filter(call => call.action === 'get').length <= 3, true)
  assert.equal(got.groups.paper.items.some(item => item.missing), true)
  assert.ok(got.warnings.some(value => value.includes('40')))
})

test('input validation and cancellation fail before invoking metadata operations', async () => {
  const f = fixture()
  for (const input of [
    { action: 'workspace_catalog', kind: 'paper' }, { action: 'workspace_catalog', kind: 'latex', limit: 21 },
    { action: 'workspace_related', kind: 'board', id: '' }, { action: 'workspace_related', kind: 'latex', id: 'x', group_kind: 'file' },
    { action: 'workspace_related', kind: 'file', id: 'x' }, { action: 'workspace_write' },
  ]) await assert.rejects(f.service.handle(input), error => error.code === 'WORKSPACE_NAV_INVALID')
  const abort = new AbortController(); abort.abort()
  await assert.rejects(f.service.handle({ action: 'workspace_related', kind: 'board', id: 'b-direct' }, { signal: abort.signal }), error => error.name === 'AbortError')
  assert.equal(f.calls.length, 0); assert.equal(f.reads.length, 0)
})
