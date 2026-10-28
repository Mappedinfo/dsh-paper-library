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
  const built = await dispatch({ action: 'latex_compile', id: project.id, engine: 'pdflatex', save_version: true }, options)
  assert.equal(built.ok, true, JSON.stringify(built)); assert.ok(built.version, built.version_error)
  const byManuscript = await dispatch({ action: 'latex_version_list', id: project.id }, options)
  const byReading = await dispatch({ action: 'latex_version_list', reading_project_id: built.version.reading_project_id }, options)
  assert.equal(byManuscript.versions[0].id, byReading.versions[0].id)
  const handler = createFetchHandler(options)
  const response = await handler(new Request(`http://127.0.0.1/latex-version-pdf/${built.version.id}`))
  assert.equal(response.status, 200); assert.match(response.headers.get('content-type'), /application\/pdf/)
  assert.equal(Buffer.from(await response.arrayBuffer()).subarray(0, 5).toString(), '%PDF-')
  const invalid = await handler(new Request(`http://127.0.0.1/latex-version-pdf/${built.version.id}?review=${'0'.repeat(64)}`))
  assert.notEqual(invalid.status, 200)
  const pages = await dispatch({ action: 'latex_version_pdf_pages', version_id: built.version.id }, options)
  assert.equal(pages.page_count, 1)
  const rendered = await dispatch({ action: 'latex_version_pdf_page', version_id: built.version.id, page: 1 }, options)
  assert.ok(rendered.words.length)
})
