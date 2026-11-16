/** Manual build version through the shared worker, bridge and HTTP preview. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { dispatch } from '../src/bridge.mjs'
import { createFetchHandler } from '../src/http.mjs'

test('one synthetic manual version is available from project queries and bounded PDF HTTP', async t => {
  try { await promisify(execFile)('latexmk', ['-v']) } catch { t.skip('latexmk unavailable'); return }
  const base = await mkdtemp(join(tmpdir(), 'latex-version-http-'))
  t.after(() => rm(base, { recursive: true, force: true }))
  const root = join(base, 'manuscript'), library = join(base, 'library')
  await mkdir(root)
  await writeFile(join(root, 'main.tex'), '\\documentclass{article}\n\\begin{document}\nSynthetic version.\n\\end{document}\n')
  const python = fileURLToPath(new URL('../.venv/bin/python', import.meta.url))
  const options = { library, python, localStateHome: join(base, 'state') }
  const project = (await dispatch({ action: 'latex_project_create', root }, options)).project
  const source = await dispatch({ action: 'latex_read', id: project.id, path: 'main.tex' }, options)
  const start = source.content.indexOf('Synthetic version')
  await dispatch({ action: 'latex_review_put', id: project.id, anchor: {
    kind: 'source', path: 'main.tex', revision: source.revision,
    start, end: start + 'Synthetic version'.length, text: 'Synthetic version',
  }, comment: 'Synthetic review' }, options)
  const workerDeadlines = [], realSetTimeout = globalThis.setTimeout
  const timer = t.mock.method(globalThis, 'setTimeout', (callback, delay, ...args) => {
    workerDeadlines.push(delay)
    return realSetTimeout(callback, delay, ...args)
  })
  const built = await dispatch({ action: 'latex_compile', id: project.id, engine: 'pdflatex', timeout_seconds: 180, save_version: true }, options)
  timer.mock.restore()
  assert.deepEqual(workerDeadlines, [240_000], 'the worker allows TeX to report its own timeout, with room for lock and snapshots')
  assert.equal(built.ok, true, JSON.stringify(built)); assert.ok(built.version, built.version_error)
  const byManuscript = await dispatch({ action: 'latex_version_list', id: project.id }, options)
  const byReading = await dispatch({ action: 'latex_version_list', reading_project_id: built.version.reading_project_id }, options)
  assert.equal(byManuscript.versions[0].id, byReading.versions[0].id)
  const handler = createFetchHandler(options)
  const response = await handler(new Request(`http://127.0.0.1/latex-version-pdf/${built.version.id}`))
  assert.equal(response.status, 200); assert.match(response.headers.get('content-type'), /application\/pdf/)
  assert.equal(Buffer.from(await response.arrayBuffer()).subarray(0, 5).toString(), '%PDF-')
  const annotatedUrl = `http://127.0.0.1/latex-version-pdf/${built.version.id}?annotated=1`
  const annotated = await handler(new Request(annotatedUrl))
  assert.equal(annotated.status, 200)
  assert.match(annotated.headers.get('content-disposition'), /^attachment;.*annotated-version\.pdf/)
  assert.equal(Buffer.from(await annotated.arrayBuffer()).subarray(0, 5).toString(), '%PDF-')
  const head = await handler(new Request(annotatedUrl, { method: 'HEAD' }))
  assert.equal(head.status, 200); assert.ok(Number(head.headers.get('content-length')) > 0)
  assert.equal((await handler(new Request(`${annotatedUrl}&review=${'0'.repeat(64)}`))).status, 404)
  assert.equal((await handler(new Request(`http://127.0.0.1/latex-version-pdf/${built.version.id}?annotated=bad`))).status, 404)
  const invalid = await handler(new Request(`http://127.0.0.1/latex-version-pdf/${built.version.id}?review=${'0'.repeat(64)}`))
  assert.notEqual(invalid.status, 200)
  const pages = await dispatch({ action: 'latex_version_pdf_pages', version_id: built.version.id }, options)
  assert.equal(pages.page_count, 1)
  const rendered = await dispatch({ action: 'latex_version_pdf_page', version_id: built.version.id, page: 1 }, options)
  assert.ok(rendered.words.length)
})

test('registered synthetic project uses Git worktree actions through HTTP', async t => {
  const git = promisify(execFile)
  const base = await mkdtemp(join(tmpdir(), 'latex-git-http-'))
  t.after(() => rm(base, { recursive: true, force: true }))
  const root = join(base, 'manuscript'), remote = join(base, 'remote')
  await mkdir(root); await mkdir(remote)
  const command = (...args) => git('git', ['-C', root, ...args])
  await command('init', '-b', 'main')
  await command('config', 'user.name', 'Synthetic fixture')
  await command('config', 'user.email', 'fixture@example.invalid')
  await git('git', ['-C', remote, 'init', '--bare'])
  await command('remote', 'add', 'origin', remote)
  const main = join(root, 'main.tex')
  await writeFile(main, 'Original\n')
  await command('add', 'main.tex')
  await command('commit', '-m', 'Start')
  await command('push', '-u', 'origin', 'main')
  const options = { library: join(base, 'library'), python: fileURLToPath(new URL('../.venv/bin/python', import.meta.url)), localStateHome: join(base, 'state') }
  const handler = createFetchHandler(options)
  async function post(action, fields) {
    const req = new Request('http://127.0.0.1/api', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, ...fields }) })
    const res = await handler(req)
    const data = await res.json()
    assert.equal(data.ok, true, data.error)
    return data.result
  }
  const { project } = await post('latex_project_create', { root })
  const id = project.id
  await writeFile(main, 'Updated\n')
  const status = await post('latex_git_status', { id })
  assert.equal(status.scope, '.')
  assert.deepEqual(status.changes.map(item => item.path), ['main.tex'])
  const committed = await post('latex_git_commit', { id, paths: ['main.tex'], message: 'Scoped update', expected_version: status.version })
  const outgoing = await post('latex_git_status', { id })
  assert.equal(outgoing.upstream.ahead, 1)
  const pushed = await post('latex_git_push', { id, expected_version: outgoing.push_version })
  assert.equal(pushed.head, committed.head)
  assert.equal((await git('git', ['-C', remote, 'rev-parse', 'main'])).stdout.trim(), pushed.head)
})
