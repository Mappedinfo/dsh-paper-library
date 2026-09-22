/**
 * Acceptance fixture for the LaTeX workspace panel.
 *
 * It serves the real `web/latex-workspace.js` and CSS to a real Chromium, and answers
 * the panel's `/api` calls by dispatching into the real Python worker through the
 * plugin's own bridge. So the browser test exercises the shipped panel, the shipped
 * request surface and a real `latexmk` build — with no DSH host and no network.
 *
 * Run: PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node scripts/latex-workspace-fixture.mjs
 * Writes docs/validation/latex-workspace-browser.json
 */
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dispatch } from '../src/bridge.mjs'

const project = dirname(dirname(fileURLToPath(import.meta.url)))
const checks = []
const record = value => { checks.push(value); console.log(`PASS ${value}`) }
const until = async (read, accept, label, attempts = 200) => {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const value = await read()
    if (accept(value)) return value
    await new Promise(done => setTimeout(done, 100))
  }
  throw new Error(`Timed out: ${label}`)
}

const TYPES = { '.js': 'text/javascript;charset=utf-8', '.css': 'text/css;charset=utf-8', '.html': 'text/html;charset=utf-8' }
const PAGE = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>LaTeX workspace fixture</title>
<link rel="stylesheet" href="./latex-workspace.css"></head>
<body><div class="topbar-actions"></div><main id="host"></main>
<script src="./latex-workspace.js"></script>
<script>
window.__calls = [];
async function api(action, args = {}) {
  window.__calls.push(action);
  const response = await fetch('./api', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, ...args }) });
  const data = await response.json();
  if (!response.ok || !data.ok) {
    const error = new Error(typeof data.error === 'string' ? data.error : (data.error && data.error.message) || ('HTTP ' + response.status));
    error.status = response.status; error.code = data.code; error.current = data.current;
    throw error;
  }
  return data.result;
}
window.latexUI = window.PaperLatexWorkspace.create({ api, toast: message => window.__toast = message, getLibrary: () => 'fixture' });
</script></body></html>`

const python = existsSync(join(project, '.venv', 'bin', 'python')) ? join(project, '.venv', 'bin', 'python') : undefined

async function startServer(library) {
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1')
    if (request.method === 'POST' && url.pathname === '/api') {
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      try {
        const result = await dispatch(JSON.parse(Buffer.concat(chunks).toString('utf8')), { library, python })
        response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true, result }))
      } catch (error) {
        response.writeHead(error.status || 400, { 'Content-Type': 'application/json' })
          .end(JSON.stringify({ ok: false, error: error.message, code: error.code, current: error.current }))
      }
      return
    }
    if (url.pathname === '/' || url.pathname === '/index.html') {
      response.writeHead(200, { 'Content-Type': TYPES['.html'] }).end(PAGE)
      return
    }
    const name = url.pathname.replace(/^\//, '')
    if (/^[\w.-]+\.(js|css)$/.test(name) && existsSync(join(project, 'web', name))) {
      response.writeHead(200, { 'Content-Type': TYPES[extname(name)] }).end(await readFile(join(project, 'web', name)))
      return
    }
    response.writeHead(404).end('not found')
  })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  return { server, origin: `http://127.0.0.1:${server.address().port}` }
}

const TEMPLATE = body => `\\documentclass[11pt]{article}
\\usepackage[margin=1in]{geometry}
\\begin{document}
\\section{Introduction}
${body}
\\end{document}
`

let server, browser, library
try {
  const base = await mkdtemp(join(tmpdir(), 'latex-workspace-'))
  library = join(base, 'library')
  const first = join(base, 'manuscript'), second = join(base, 'submission')
  await mkdir(join(first, 'sections'), { recursive: true })
  await mkdir(second, { recursive: true })
  await writeFile(join(first, 'main.tex'), TEMPLATE('The reader types here.'))
  await writeFile(join(first, 'sections', 'intro.tex'), '\\section{Intro}\nFrom a section file.\n')
  await writeFile(join(first, 'refs.bib'), '@article{a, title={A}}\n')
  await writeFile(join(second, 'main.tex'), TEMPLATE('The submitted version says something else.'))

  const configured = { library, python }
  const created = await dispatch({ action: 'latex_project_create', root: first, title: '手稿' }, configured)
  const other = await dispatch({ action: 'latex_project_create', root: second, title: '投稿版' }, configured)
  record('fixture-projects-register-two-folders-with-their-main-files')

  const started = await startServer(library)
  server = started.server
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
  browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(started.origin, { waitUntil: 'load' })
  await page.waitForFunction(() => window.latexUI)

  await page.locator('#latex-open').click()
  await page.locator('#latex-workspace').waitFor({ state: 'visible' })
  record('topbar-entry-opens-the-workspace-dialog')

  await until(() => page.locator('#latex-editor').inputValue(), value => value.includes('The reader types here.'), 'main.tex loaded')
  const mainLabel = await page.locator('#latex-main').innerText()
  const fileButtons = await page.locator('.latex-file-open').allInnerTexts()
  if (!mainLabel.includes('main.tex')) throw new Error(`main file label missing: ${mainLabel}`)
  if (!fileButtons.some(text => text.includes('sections/intro.tex'))) throw new Error(`file list missing section file: ${fileButtons.join(', ')}`)
  record('panel-loads-the-project-tree-and-main-file')

  await page.evaluate(() => window.latexUI.testHooks.type('\\documentclass[11pt]{article}\n\\usepackage[margin=1in]{geometry}\n\\begin{document}\n\\section{Introduction}\nThe reader retyped this sentence.\n\\end{document}\n'))
  await until(() => page.locator('#latex-save-state').innerText(), value => value.includes('已保存'), 'autosave')
  const onDisk = await readFile(join(first, 'main.tex'), 'utf8')
  if (!onDisk.includes('The reader retyped this sentence.')) throw new Error('write did not reach the folder')
  record('editing-persists-through-the-revision-checked-write')

  await page.locator('#latex-compile').click()
  await until(() => page.locator('#latex-build-info').innerText(), value => value.includes('页'), 'compile finished', 400)
  const image = await until(() => page.locator('#latex-preview img').count(), count => count > 0, 'preview page')
  const label = await page.locator('#latex-page-label').innerText()
  if (!/第 1 \/ \d+ 页/.test(label)) throw new Error(`page label unexpected: ${label}`)
  if (await page.locator('#latex-errors li').count() !== 0) throw new Error('compile reported errors for a valid document')
  if (image < 1) throw new Error('no rendered page')
  await page.locator('#latex-workspace').screenshot({ path: join(project, 'docs', 'images', 'latex-workspace.jpg'), type: 'jpeg', quality: 82 })
  record('compile-produces-a-pdf-and-the-panel-renders-its-first-page')

  // Another editor writes the file behind the panel's back.
  const panelState = await page.evaluate(() => window.latexUI.testHooks.state())
  const externalBody = '\\documentclass{article}\n\\begin{document}\nChanged in another editor.\n\\end{document}\n'
  await dispatch({ action: 'latex_write', id: panelState.project, path: panelState.file, content: externalBody, expected_revision: panelState.revision, origin: 'other-editor' }, configured)
  await page.evaluate(() => window.latexUI.testHooks.type('\\documentclass{article}\n\\begin{document}\nThe panel tried to save this.\n\\end{document}\n'))
  await until(() => page.locator('#latex-conflict').isVisible(), Boolean, 'conflict banner')
  const conflictText = await page.locator('#latex-conflict-text').innerText()
  if (!conflictText.includes('被改过')) throw new Error(`conflict text unexpected: ${conflictText}`)
  const diskAfterConflict = await readFile(join(first, 'main.tex'), 'utf8')
  if (!diskAfterConflict.includes('Changed in another editor.')) throw new Error('a stale save overwrote the newer file')
  record('a-stale-save-is-refused-and-surfaced-without-overwriting')

  await page.locator('#latex-conflict-reload').click()
  await until(() => page.locator('#latex-editor').inputValue(), value => value.includes('Changed in another editor.'), 'reload newest')
  const stillExternal = await readFile(join(first, 'main.tex'), 'utf8')
  if (stillExternal !== externalBody) throw new Error('reloading the newest revision rewrote the file')
  record('reload-adopts-the-newer-revision-without-writing')

  await page.locator('#latex-diff-open').click()
  await until(() => page.locator('#latex-diff').isVisible(), Boolean, 'diff view')
  const diffText = await page.locator('#latex-diff').innerText()
  if (!diffText || diffText.includes('没有差异')) throw new Error(`diff was empty: ${diffText}`)
  record('panel-diffs-the-open-file-against-the-previous-revision')

  await page.locator('.latex-file-open', { hasText: 'refs.bib' }).click()
  await until(() => page.locator('#latex-editor').inputValue(), value => value.includes('@article'), 'bib file loaded')
  record('the-file-list-switches-between-project-files')

  await page.locator('.latex-file-open', { hasText: 'main.tex' }).click()
  await until(() => page.locator('#latex-editor').inputValue(), value => value.includes('Changed in another editor.'), 'main file reloaded')
  await page.locator('#latex-compare').selectOption(other.project.id)
  await page.locator('#latex-compare-run').click()
  await until(() => page.locator('#latex-diff').innerText(), value => value.includes('something else'), 'project comparison')
  record('panel-compares-two-projects-on-the-same-relative-file')

  // A brand-new folder can be registered from the panel itself.
  const fresh = join(base, 'appendix')
  await mkdir(fresh, { recursive: true })
  await page.locator('#latex-project-new').click()
  await page.locator('#latex-new-root').fill(fresh)
  await page.locator('#latex-new-starter').check()
  await page.locator('#latex-new-submit').click()
  await until(() => page.locator('#latex-project option').allInnerTexts(), list => list.some(text => text.includes('appendix')), 'new project registered')
  const starter = await readFile(join(fresh, 'main.tex'), 'utf8')
  if (!starter.includes('\\documentclass')) throw new Error('starter main.tex was not written')
  await until(() => page.locator('#latex-editor').inputValue(), value => value.includes('\\documentclass'), 'starter loaded into the editor')
  record('the-panel-registers-a-new-folder-and-writes-its-starter')

  await page.locator('#latex-close').click()
  await until(() => page.locator('#latex-workspace').isVisible(), value => value === false, 'dialog closed')
  if (errors.length) throw new Error(`browser errors: ${errors.join(' | ')}`)
  record('no-browser-errors-and-the-workspace-closes')

  const calls = await page.evaluate(() => window.__calls)
  const externalRequests = await page.evaluate(() => performance.getEntriesByType('resource').filter(entry => /^https?:\/\//.test(entry.name) && !entry.name.startsWith(location.origin)).length)
  if (externalRequests) throw new Error(`panel requested ${externalRequests} external resources`)
  record('the-live-panel-made-no-external-requests')

  const report = { verified_at: new Date().toISOString(), ok: true, checks, actions: [...new Set(calls)].sort(), external_requests: externalRequests, browser_errors: errors, limits: ['Local Chromium against a real Python worker and real latexmk; not a DSH host run', 'The fixture serves the panel and CSS from web/ verbatim; no build step is involved'] }
  await writeFile(join(project, 'docs', 'validation', 'latex-workspace-browser.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report, null, 2))
} catch (error) {
  const report = { verified_at: new Date().toISOString(), ok: false, checks, error: String(error && error.message || error), limits: ['Local Chromium against a real Python worker and real latexmk'] }
  try { await writeFile(join(project, 'docs', 'validation', 'latex-workspace-browser.json'), JSON.stringify(report, null, 2) + '\n') } catch {}
  console.log(JSON.stringify(report, null, 2))
  process.exitCode = 1
} finally {
  await browser?.close().catch(() => {})
  await new Promise(done => server?.close(done))
}

