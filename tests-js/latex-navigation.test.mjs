/** New read actions cross the tool, bridge, real worker and HTTP route. */
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
import { LATEX_TOOL_SPECS, latexToolRequest } from '../src/harness/latex-tools.mjs'

test('outline and media are bounded read actions through all existing request layers', async t => {
  const base = await mkdtemp(join(tmpdir(), 'latex-navigation-'))
  t.after(() => rm(base, { recursive: true, force: true }))
  const root = join(base, 'manuscript'), library = join(base, 'library')
  const python = fileURLToPath(new URL('../.venv/bin/python', import.meta.url))
  await mkdir(join(root, 'media'), { recursive: true })
  await writeFile(join(root, 'main.tex'), '\\documentclass{article}\n\\input{chapter}\n')
  await writeFile(join(root, 'chapter.tex'), '\\section{第一章}\n')
  await writeFile(join(root, 'media', 'diagram.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60"><rect width="80" height="40" fill="blue"/></svg>')
  await promisify(execFile)(python, ['-c', 'import pymupdf as f,sys; d=f.open(); p=d.new_page(); p.insert_text((50,60),"Synthetic review PDF"); d.save(sys.argv[1])', join(root, 'main.pdf')])
  const options = { library, python, localStateHome: join(base, 'state') }
  const { project } = await dispatch({ action: 'latex_project_create', root }, options)
  const read = LATEX_TOOL_SPECS.find(spec => spec.name === 'library_latex')
  const request = latexToolRequest(read, { operation: 'outline', input_json: JSON.stringify({ id: project.id }) })
  const outline = await dispatch(request, options)
  assert.deepEqual(outline.referenced, ['chapter.tex', 'main.tex'])
  assert.equal(outline.events.find(event => event.kind === 'heading').title, '第一章')
  const handler = createFetchHandler(options)
  const call = payload => handler(new Request('http://127.0.0.1/api', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }))
  const response = await call(latexToolRequest(read, { operation: 'media_preview', input_json: JSON.stringify({ id: project.id, path: 'media/diagram.svg', scale: 2 }) }))
  assert.equal(response.status, 200)
  const media = (await response.json()).result
  assert.equal(media.pixel_width, 240)
  assert.equal(media.mime_type, 'image/png')
  assert.ok(Buffer.from(media.image, 'base64').subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])))
  const escaped = await call({ action: 'latex_media_preview', id: project.id, path: '../outside.png' })
  assert.notEqual(escaped.status, 200)
  assert.match(JSON.stringify(await escaped.json()), /超出项目/)
  // The review path reuses the same tool/HTTP/worker boundaries and source CAS.
  const savedSource = await dispatch({ action: 'latex_read', id: project.id, path: 'chapter.tex' }, options)
  const put = await call({ action: 'latex_review_put', id: project.id, anchor: { kind: 'source', path: 'chapter.tex', revision: savedSource.revision, start: 0, end: Array.from(savedSource.content).length, text: savedSource.content }, comment: 'Synthetic review thought', request_id: 'c'.repeat(32) })
  assert.equal(put.status, 200)
  const note = (await put.json()).result.annotation
  const saved = await call({ action: 'latex_review_list', id: project.id })
  assert.equal((await saved.json()).result.annotations[0].comment, 'Synthetic review thought')
  const conflict = await call({ action: 'latex_review_put', id: project.id, note_id: note.id, expected_version: 'old', comment: 'cannot overwrite' })
  assert.equal(conflict.status, 409)
  const exported = await call({ action: 'latex_review_export', id: project.id, format: 'json' })
  assert.equal(JSON.parse((await exported.json()).result.text).schema, 'paper-library.annotations.v1')
  const pdfExport = await handler(new Request(`http://127.0.0.1/latex-review-pdf/${project.id}`))
  assert.equal(pdfExport.status, 200)
  assert.equal(pdfExport.headers.get('Content-Type'), 'application/pdf')
  assert.match(pdfExport.headers.get('Content-Disposition'), /attachment/)
  assert.equal(Buffer.from(await pdfExport.arrayBuffer()).subarray(0, 5).toString(), '%PDF-')
  const removed = await call({ action: 'latex_review_delete', id: project.id, note_id: note.id, expected_version: note.version })
  assert.equal(removed.status, 200)
})
