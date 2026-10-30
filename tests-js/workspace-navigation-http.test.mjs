import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFetchHandler } from '../src/http.mjs'
import { createLocalStateStore } from '../src/local-state.mjs'
import { createBoardStore } from '../src/harness/board-store.mjs'
import { createWorkspaceNavigation } from '../src/harness/workspace-navigation.mjs'

const origin = 'http://127.0.0.1', basePath = '/api/paper-library'
async function fixture(t, extra = {}) {
  const root = await mkdtemp(join(tmpdir(), 'paper-workspace-navigation-http-')), library = join(root, 'library'), home = join(root, 'state')
  await mkdir(library)
  t.after(() => rm(root, { recursive: true, force: true }))
  const localState = createLocalStateStore({ library, home }), boards = createBoardStore({ localState })
  const options = { library, localStateHome: home, localState, boards, basePath, python: join(root, 'missing-python-must-not-run'), ai() { throw Error('Navigation must not invoke a model') } }
  const handler = createFetchHandler({ ...options, ...extra })
  const call = async (input, init = {}) => {
    const response = await handler(new Request(`${origin}${basePath}/api`, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify(input), ...init }))
    return { status: response.status, ...await response.json() }
  }
  return { root, library, boards, options, handler, call }
}

test('HTTP forwards only the two navigation actions and propagates the request abort signal', async t => {
  const seen = [], f = await fixture(t, { workspaceNavigation: { async handle(input, options) { seen.push({ input, options }); return { received: input.action } } } })
  const input = { action: 'workspace_catalog', kind: 'board', offset: 0, limit: 20 }
  const controller = new AbortController(), request = new Request(`${origin}${basePath}/api`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input), signal: controller.signal })
  const response = await f.handler(request)
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), { ok: true, result: { received: 'workspace_catalog' } })
  assert.deepEqual(seen[0].input, input); assert.equal(seen[0].options.signal, request.signal)
  controller.abort(); assert.equal(seen[0].options.signal.aborted, true)
  const related = await f.call({ action: 'workspace_related', kind: 'paper', id: 'synthetic-paper' })
  assert.equal(related.result.received, 'workspace_related'); assert.equal(seen.length, 2)
  const unsupported = await f.call({ action: 'workspace_write', kind: 'board', id: 'synthetic-board' })
  assert.equal(unsupported.status, 400); assert.equal(seen.length, 2, 'unknown workspace actions never enter the read service')
  assert.deepEqual(await readdir(f.library), [], 'injected metadata navigation does not start a worker or create a source catalog')
})

test('HTTP real metadata projection retains reciprocal links without modifying boards or reading source files', async t => {
  const f = await fixture(t), calls = []
  const created = await f.boards.create({ board: { title: '合成画板', nodes: [{ id: 'n-paper', kind: 'paper', paper: { id: 'synthetic-paper', title: '原题名' }, x: 1, y: 2 }], edges: [], links: { papers: ['synthetic-paper'], projects: ['synthetic-reading'] } } })
  const service = createWorkspaceNavigation({ boards: f.boards, request: async (input, signal) => {
    calls.push(input); assert.equal(signal instanceof AbortSignal, true)
    if (input.action === 'get') return { id: 'synthetic-paper', title: '合成文献', resource_kind: 'paper' }
    if (input.action === 'project_get') return { project: { id: 'synthetic-reading', title: '合成阅读项目' }, papers: [], total: 1 }
    if (input.action === 'project_for_paper' || input.action === 'project_list') return { projects: [{ id: 'synthetic-reading', title: '合成阅读项目' }], total: 1 }
    if (input.action === 'resource_list') return { items: [{ id: 'synthetic-paper', title: '合成文献', resource_kind: 'paper' }], total: 1 }
    if (input.action === 'latex_project_list') return { projects: [{ id: 'synthetic-latex', title: '合成写作项目', reading_project_id: 'synthetic-reading', exists: true, root: '/synthetic/private-root' }], total: 1 }
    throw Error(`Forbidden metadata request: ${input.action}`)
  } })
  const handler = createFetchHandler({ ...f.options, workspaceNavigation: service })
  const call = async input => {
    const response = await handler(new Request(`${origin}${basePath}/api`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }))
    assert.equal(response.status, 200)
    return (await response.json()).result
  }
  const paper = await call({ action: 'workspace_related', kind: 'paper', id: 'synthetic-paper' })
  assert.equal(paper.groups.board.items[0].id, created.board.id)
  assert.equal(paper.groups.latex.items[0].id, 'synthetic-latex')
  assert.match(paper.groups.latex.items[0].relation, /通过阅读项目/)
  const board = await call({ action: 'workspace_related', kind: 'board', id: created.board.id })
  assert.equal(board.groups.paper.items[0].title, '合成文献')
  assert.equal(board.groups.latex.items[0].id, 'synthetic-latex')
  const latex = await call({ action: 'workspace_related', kind: 'latex', id: 'synthetic-latex' })
  assert.equal(latex.groups.paper.items[0].id, 'synthetic-paper')
  assert.equal(latex.groups.board.items[0].id, created.board.id)
  const reading = await call({ action: 'workspace_related', kind: 'project', id: 'synthetic-reading' })
  assert.equal(reading.groups.paper.items[0].id, 'synthetic-paper'); assert.equal(reading.groups.board.items[0].id, created.board.id); assert.equal(reading.groups.latex.items[0].id, 'synthetic-latex')
  const projects = await call({ action: 'workspace_catalog', kind: 'project', limit: 20, offset: 0 })
  assert.equal(projects.items[0].kind, 'project'); assert.equal(projects.total, 1)
  assert.equal(JSON.stringify([paper, board, latex]).includes('/synthetic/private-root'), false)
  const unchanged = await f.boards.read(created.board.id)
  assert.equal(unchanged.revision, created.revision); assert.deepEqual(unchanged.board, created.board)
  assert.equal(calls.some(input => /pdf|compile|read|outline|tree|snapshot|write/.test(input.action) && !['project_for_paper'].includes(input.action)), false)
  assert.deepEqual(await readdir(f.library), [], 'all navigation inputs are stored metadata, not PDF or TeX source files')
})

test('HTTP rejects malformed navigation pagination and identities before requesting metadata', async t => {
  const f = await fixture(t), calls = []
  const service = createWorkspaceNavigation({ boards: f.boards, request: async input => { calls.push(input); throw Error('must not request metadata') } })
  const handler = createFetchHandler({ ...f.options, workspaceNavigation: service })
  for (const input of [
    { action: 'workspace_catalog', kind: 'latex', limit: 21 },
    { action: 'workspace_catalog', kind: 'latex', query: 'q'.repeat(201) },
    { action: 'workspace_catalog', kind: 'board', offset: -1 },
    { action: 'workspace_related', kind: 'latex', id: '' },
    { action: 'workspace_related', kind: 'paper', id: 'id\ninvalid' },
    { action: 'workspace_related', kind: 'board', id: 'a', group_kind: 'source-file' },
  ]) {
    const response = await handler(new Request(`${origin}${basePath}/api`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }))
    const body = await response.json()
    assert.equal(response.status, 400); assert.equal(body.code, 'WORKSPACE_NAV_INVALID')
  }
  const invalidJson = await handler(new Request(`${origin}${basePath}/api`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' }))
  assert.equal(invalidJson.status, 400); assert.equal(calls.length, 0)
  const wrongOrigin = await f.call({ action: 'workspace_catalog', kind: 'board' }, { headers: { 'content-type': 'application/json', origin: 'https://untrusted.invalid' } })
  assert.equal(wrongOrigin.status, 403)
})

test('navigation assets are served with their current bytes and linked from the main document', async t => {
  const f = await fixture(t)
  for (const file of ['workspace-navigation.js', 'workspace-navigation.css']) {
    const response = await f.handler(new Request(`${origin}${basePath}/${file}`))
    assert.equal(response.status, 200)
    assert.equal(await response.text(), await readFile(new URL(`../web/${file}`, import.meta.url), 'utf8'))
    assert.match(response.headers.get('content-type'), file.endsWith('.js') ? /javascript/ : /css/)
  }
  const page = await f.handler(new Request(`${origin}${basePath}/`)), html = await page.text()
  assert.equal(page.status, 200); assert.match(html, /href="\.\/workspace-navigation\.css"/); assert.match(html, /src="\.\/workspace-navigation\.js"/)
  assert.match(html, /id="workspace-navigation"/)
})
