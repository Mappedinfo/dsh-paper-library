/** Direct DSH plugin smoke test. Supply DSH_TEST_LAUNCH_URL only to this process.
 * --reload-plugin asks native Plugin Manager to reconcile this enabled plugin.
 * Generated projects are archived by exact IDs; no existing manuscript is opened.
 */
import { mkdtemp, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'

const launch = new URL(process.env.DSH_TEST_LAUNCH_URL || 'http://127.0.0.1:3080/')
if (launch.hostname !== '127.0.0.1' || !launch.searchParams.has('token')) throw new Error('Provide a loopback launch URL through DSH_TEST_LAUNCH_URL')
const login = await fetch(launch, { redirect: 'manual' })
const cookie = login.headers.get('set-cookie')?.split(';')[0]
if (!cookie) throw new Error('DSH authentication did not issue a session')
const origin = launch.origin
const headers = { cookie, 'Content-Type': 'application/json', origin }
const call = async input => {
  const response = await fetch(`${origin}/api/paper-library/api`, { method: 'POST', headers, body: JSON.stringify(input) })
  const result = await response.json()
  if (!response.ok || !result.ok) throw new Error(result.error || `Plugin HTTP ${response.status}`)
  return result.result
}
const rpc = async (method, args = {}) => {
  const response = await fetch(`${origin}/api/${method}`, { method: 'POST', headers, body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload: { args } }) })
  const value = await response.json()
  if (!value.result?.ok) throw new Error(value.result?.error?.message || 'Native plugin request failed')
  return value.result.value
}
const checks = []
const record = text => { checks.push(text); console.log(`PASS ${text}`) }
let project, readingId
try {
  if (process.argv.includes('--reload-plugin')) {
    const plugins = await rpc('pluginManager/listPlugins')
    const matches = plugins.filter(item => item.moduleName === '@mappedinfo/dsh-paper-library')
    assert.equal(matches.length, 1, 'exactly one Paper Library runtime entry is required')
    assert.equal(matches[0].enabled, true, 'do not change a deliberately disabled plugin')
    const outcome = await rpc('pluginManager/setPluginEnabled', { id: matches[0].entryId, enabled: true })
    assert.equal(outcome.application, 'applied', 'plugin reconciliation needs attention')
    record('native manager reconciles the enabled Paper Library entry')
  }
  let ready = false
  for (let i = 0; i < 50; i++) {
    try { await call({ action: 'latex_version_list', id: 'synthetic-probe-nonexistent', limit: 1 }); ready = true; break } catch {}
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  assert.ok(ready, 'the loaded plugin does not expose the new version API')
  const root = await mkdtemp(join(tmpdir(), 'dsh-latex-live-'))
  const source = '\\documentclass{article}\n\\begin{document}\nSynthetic annotation workflow.\\newpage\nSecond synthetic page.\n\\end{document}\n'
  await writeFile(join(root, 'main.tex'), source)
  project = (await call({ action: 'latex_project_create', root, title: `合成插件验收 ${Date.now()}` })).project
  const first = await call({ action: 'latex_compile', id: project.id, engine: 'pdflatex', save_version: true })
  assert.ok(first.ok && first.version, first.version_error || 'manual build failed'); readingId = first.version.reading_project_id
  record('manual compilation saves a shared reading-project version')
  const before = createHash('sha256').update(await readFile(join(root, 'main.pdf'))).digest('hex')
  const layout = await call({ action: 'latex_pdf_pages', id: project.id })
  const page = await call({ action: 'latex_pdf_page', id: project.id, page: 1 })
  const word = page.words[0]
  for (const type of ['highlight', 'underline', 'strikeout', 'note']) {
    await call({ action: 'latex_review_put', id: project.id, type, request_id: randomUUID().replaceAll('-', ''),
      anchor: { kind: 'pdf', pdf_version: layout.build.pdf_version, page: 1, rects: [word.slice(0, 4)], text: word[4] }, comment: type === 'note' ? '合成：直接文字批注' : '' })
  }
  assert.equal(createHash('sha256').update(await readFile(join(root, 'main.pdf'))).digest('hex'), before)
  record('native annotations save without modifying the compiled original PDF')
  const second = await call({ action: 'latex_compile', id: project.id, engine: 'pdflatex', save_version: true })
  assert.ok(second.version, second.version_error); assert.equal(second.version.review_count, 4)
  const byWriting = await call({ action: 'latex_version_list', id: project.id })
  const byReading = await call({ action: 'latex_version_list', reading_project_id: readingId })
  assert.deepEqual(byWriting.versions.map(item => item.id), byReading.versions.map(item => item.id))
  const snapshot = await call({ action: 'latex_version_get', version_id: second.version.id })
  assert.ok(snapshot.review_pdfs.length)
  const rendered = await call({ action: 'latex_version_pdf_page', version_id: second.version.id, review_pdf_version: snapshot.review_pdfs[0].pdf_version, page: 1 })
  assert.equal(rendered.annotations.length, 4)
  const notes = await call({ action: 'latex_version_review', version_id: second.version.id })
  assert.equal(notes.annotations.length, 4)
  const saved = await call({ action: 'latex_version_read', version_id: second.version.id, path: 'main.tex' })
  assert.equal(saved.content, source)
  record('both entries read identical version IDs, source and original native annotations')
  const last = await call({ action: 'latex_version_pdf_page', version_id: second.version.id, page: 2 })
  assert.ok(last.image)
  record('historical page rendering works through the existing DSH plugin endpoint')
  console.log(JSON.stringify({ ok: true, origin, checks, synthetic_project: project.id, synthetic_root: root, model_calls: 0 }, null, 2))
} finally {
  if (project) await call({ action: 'latex_project_archive', id: project.id }).catch(error => console.error(`Synthetic manuscript archive failed: ${error.message}`))
  if (readingId) await call({ action: 'project_archive', id: readingId }).catch(error => console.error(`Synthetic reading project archive failed: ${error.message}`))
}
