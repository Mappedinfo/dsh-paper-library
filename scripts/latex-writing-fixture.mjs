/** Synthetic writing tools against the production standalone server.
 * PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs node scripts/latex-writing-fixture.mjs
 * Sources, images, workbooks, library and screenshots remain in one temporary folder.
 */
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const base = await mkdtemp(join(tmpdir(), 'paper-latex-writing-'))
const manuscript = join(base, 'manuscript')
const checks = [], errors = []
const record = text => { checks.push(text); console.log(`PASS ${text}`) }
const wait = async (read, predicate, label, attempts = 200) => {
  for (let index = 0; index < attempts; index++) { const value = await read(); if (predicate(value)) return value; await new Promise(resolve => setTimeout(resolve, 100)) }
  throw new Error(`Timed out: ${label}`)
}
await mkdir(join(manuscript, 'sections'), { recursive: true })
const original = '\\documentclass{article}\n\\usepackage{amsmath,graphicx}\n\\begin{document}\n\\input{sections/formulas}\n\\end{document}\n'
await writeFile(join(manuscript, 'main.tex'), original)
await writeFile(join(manuscript, 'sections', 'formulas.tex'), '\\section{Synthetic formulas}\nInline $x+1$.\n\\begin{equation}\ny^2 = z \\label{eq:synthetic}\n\\end{equation}\nSee \\eqref{eq:synthetic}.\n')
execFileSync('uv', ['run', 'python', '-c', `
import sys
from pathlib import Path
from openpyxl import Workbook
import pymupdf as fitz
base = Path(sys.argv[1])
image = fitz.Pixmap(fitz.csRGB, fitz.IRect(0, 0, 20, 20), False)
image.clear_with(220)
(base / 'synthetic.png').write_bytes(image.tobytes('png'))
book = Workbook()
book.active.title = 'Values'
book.active.append(['Name', 'Score'])
book.active.append(['Synthetic & safe', 7])
other = book.create_sheet('Uncached formula')
other.append(['Name', 'Computed'])
other.append(['No execution', '=1+1'])
book.save(base / 'synthetic.xlsx')
book.close()
`, base], { cwd: root, env: { ...process.env, UV_CACHE_DIR: '/private/tmp/dsh-paper-uv', UV_OFFLINE: '1' }, stdio: 'pipe' })

let child, browser, page, releaseAsset
try {
  child = spawn(process.execPath, ['src/server.mjs', '--port', '0', '--library', join(base, 'library'), '--state-home', join(base, 'state')], {
    cwd: root, env: { ...process.env, DSH_HOME: join(base, 'dsh') }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = '', stderr = ''
  child.stdout.on('data', data => { stdout += data }); child.stderr.on('data', data => { stderr += data })
  const origin = await wait(() => { if (child.exitCode !== null) throw new Error(stderr); return stdout.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0] }, Boolean, 'temporary host')
  const api = async (action, args = {}) => {
    for (let index = 0; index < 20; index++) {
      const response = await fetch(`${origin}/api`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, ...args }) })
      if (response.status === 429) { await new Promise(resolve => setTimeout(resolve, 100)); continue }
      const value = await response.json(); if (!value.ok) throw new Error(value.error); return value.result
    }
    throw new Error('No synthetic API admission slot')
  }
  const project = (await api('latex_project_create', { root: manuscript, title: '合成写作工具检查' })).project
  const settings = await api('settings_get')
  await api('settings_update', { patch: { latex_auto_compile: false }, expected_revision: settings.revision })
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage({ viewport: { width: 1512, height: 982 } })
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin })
  page.on('pageerror', error => errors.push(error.message))
  let formulaRequests = 0, modelCalls = 0, conflict = null, holdAsset = false, assetHeld = false
  await page.route('**/api', async route => {
    const input = route.request().postDataJSON()
    if (input.action === 'models') return route.fulfill({ json: { ok: true, result: { models: [
      { id: 'a1', name: 'Synthetic A1', provider: 'Provider A' }, { id: 'b1', name: 'Synthetic B1', provider: 'Provider B' }, { id: 'a2', name: 'Synthetic A2', provider: 'Provider A' },
    ] } } })
    if (input.action === 'latex_ai_status') return route.fulfill({ json: { ok: true, result: { configured: false, entries: [] } } })
    if (/latex_ai_(ask|propose)/.test(input.action)) { modelCalls++; return route.fulfill({ status: 400, json: { ok: false, error: 'No model calls in this fixture' } }) }
    if (input.action === 'latex_formula_check') formulaRequests++
    if (input.action === 'latex_write' && conflict) return route.fulfill({ status: 409, json: { ok: false, code: 'STATE_CONFLICT', error: 'Synthetic concurrent source edit', current: conflict } })
    if (input.action === 'latex_asset_import' && holdAsset) {
      const response = await route.fetch(); assetHeld = true
      await new Promise(resolve => { releaseAsset = resolve })
      return route.fulfill({ response })
    }
    return route.continue()
  })
  await page.goto(`${origin}/?view=latex`, { waitUntil: 'networkidle' })
  await page.locator('.cm-content').waitFor({ state: 'visible' })
  const source = () => page.evaluate(() => document.querySelector('#latex-editor').value)
  const end = () => page.evaluate(() => { const editor = document.querySelector('#latex-editor'); editor.setSelectionRange(editor.value.length, editor.value.length); editor.focus() })
  const openTool = async id => { await page.locator('#latex-source-tools').click(); await page.locator(id).click() }
  const saved = async path => { const expected = await source(); await wait(() => readFile(join(manuscript, path), 'utf8'), text => text === expected, `${path} saved`) }
  const openFile = async path => { await page.locator('#latex-nav-files').click(); await page.locator(`#latex-files [data-path="${path}"]`).click(); await wait(() => page.locator('#latex-current-file').innerText(), text => text.includes(path), `${path} selected`) }
  await wait(source, text => text === original, 'initial source')
  if (!await page.locator('#latex-ai-model').isVisible()) await page.locator('#latex-ai-open').click()
  await wait(() => page.locator('#latex-ai-model optgroup').count(), count => count === 2, 'provider groups')
  const groups = await page.locator('#latex-ai-model optgroup').evaluateAll(nodes => nodes.map(node => ({ label: node.label, models: [...node.children].map(child => child.textContent) })))
  assert.deepEqual(groups, [{ label: 'Provider A', models: ['Synthetic A1', 'Synthetic A2'] }, { label: 'Provider B', models: ['Synthetic B1'] }])
  await page.locator('#latex-ai-model').selectOption('2')
  assert.equal(await page.locator('#latex-ai-model option:checked').innerText(), 'Synthetic A2')
  record('model choices are visually grouped by provider without a model request')

  await end(); await page.keyboard.press('Meta+Shift+i')
  await wait(source, text => text.includes('\\begin{figure}'), 'figure keyboard template')
  await page.keyboard.press('Meta+z')
  await wait(source, text => text === original, 'figure insertion undo')
  record('figure keyboard template inserts immediately and remains one undoable edit')

  await end(); await page.keyboard.insertText('\n$\\eta=1$\n')
  await openTool('#latex-formula-check')
  await wait(() => page.locator('#latex-formula-status').innerText(), text => text.includes('3 个公式'), 'formula extraction')
  await saved('main.tex')
  const formulaCard = page.locator('.latex-formula-card').filter({ hasText: 'sections/formulas.tex:2' })
  await formulaCard.locator('summary').click(); await formulaCard.getByRole('button', { name: '定位源码', exact: true }).click()
  await wait(() => page.locator('#latex-current-file').innerText(), text => text.includes('sections/formulas.tex'), 'formula source navigation')
  await page.screenshot({ path: join(base, 'formula-panel.png') })
  await page.locator('#latex-formula-close').click(); await openFile('main.tex')
  conflict = await api('latex_read', { id: project.id, path: 'main.tex' })
  const beforeConflict = formulaRequests
  await end(); await page.keyboard.insertText('% unsaved synthetic conflict\n')
  await openTool('#latex-formula-check')
  await wait(() => page.locator('#latex-formula-status').innerText(), text => text.includes('检查已暂停'), 'formula conflict pause')
  assert.equal(formulaRequests, beforeConflict)
  assert.match(await source(), /unsaved synthetic conflict/)
  conflict = null
  await page.locator('#latex-conflict-reload').click(); await page.locator('#latex-formula-close').click()
  record('formula inventory saves current drafts, locates exact sources and pauses without discarding a conflicted draft')

  const image = await readFile(join(base, 'synthetic.png'))
  const transfer = async (event, name, body, mime, target = '.latex-editor-wrap') => page.evaluate(({ event, name, data, mime, target }) => {
    const transfer = new DataTransfer(); transfer.items.add(new File([Uint8Array.from(atob(data), char => char.charCodeAt(0))], name, { type: mime }))
    const payload = { bubbles: true, cancelable: true, ...(event === 'drop' ? { dataTransfer: transfer } : { clipboardData: transfer }) }
    document.querySelector(target).dispatchEvent(event === 'drop' ? new DragEvent(event, payload) : new ClipboardEvent(event, payload))
  }, { event, name, data: body.toString('base64'), mime, target })
  for (const [event, name] of [['drop', 'synthetic-drop.png'], ['paste', 'synthetic-paste.png']]) {
    await end(); await transfer(event, name, image, 'image/png')
    await page.locator('#latex-writing-dialog').waitFor({ state: 'hidden' })
    await wait(source, text => text.includes(`figures/${name.replace('.png', '')}-`), `${event} image inserted`)
    await saved('main.tex')
    const text = await source(), relative = text.match(new RegExp(`figures/${name.replace('.png', '')}-[a-f0-9]+\\.png`))[0]
    assert.deepEqual(await readFile(join(manuscript, relative)), image)
  }
  await page.reload({ waitUntil: 'networkidle' }); await page.locator('.cm-content').waitFor({ state: 'visible' })
  await wait(source, text => text.includes('synthetic-paste-'), 'reloaded image source')
  record('image drop and clipboard paste save exact bytes inside the project and survive reload')

  const tablePaste = async text => {
    await page.locator('#latex-table-paste').focus()
    await page.evaluate(text => navigator.clipboard.writeText(text), text)
    await page.keyboard.press('Meta+v')
    await wait(() => page.locator('#latex-table-grid tbody tr').count(), count => count === 2, 'pasted table grid')
  }
  await end(); await page.keyboard.press('Meta+Shift+t')
  await page.locator('#latex-writing-dialog').waitFor({ state: 'visible' })
  await tablePaste('| Name | Value |\n| --- | ---: |\n| Synthetic | 1 |')
  await page.locator('#latex-table-grid input[aria-label="第 2 行第 1 列"]').fill('A&B')
  await page.locator('#latex-table-grid select[aria-label="第 1 列角色与对齐"]').selectOption('c')
  await page.locator('#latex-table-caption').fill('Synthetic table')
  const markdownOutput = await page.locator('#latex-writing-output').inputValue()
  assert.match(markdownOutput, /\\begin\{tabular\}\{cr\}/); assert.match(markdownOutput, /A\\&B/)
  await page.locator('#latex-writing-insert').click(); await saved('main.tex')
  await end(); await page.keyboard.press('Meta+Shift+t')
  await page.locator('#latex-table-paste').fill('')
  await tablePaste('Name\tValue\nExcel clipboard\t2\n')
  assert.match(await page.locator('#latex-writing-output').inputValue(), /Excel clipboard & 2/)
  await page.getByRole('button', { name: '放弃草稿', exact: true }).click()
  record('Markdown and Excel clipboard tables become editable cells with column roles and escaped LaTeX insertion')

  await end(); await transfer('paste', 'synthetic.xlsx', await readFile(join(base, 'synthetic.xlsx')), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  await wait(() => page.locator('#latex-writing-output').inputValue(), text => text.includes('Synthetic \\& safe & 7'), 'XLSX first worksheet')
  assert.equal(await page.locator('#latex-table-sheet').inputValue(), 'Values')
  await page.locator('#latex-table-sheet').selectOption('Uncached formula')
  await wait(() => page.locator('#latex-writing-status').innerText(), text => text.includes('公式没有缓存结果'), 'inert XLSX formula rejection')
  assert.doesNotMatch(await page.locator('#latex-writing-output').inputValue(), /No execution & 2/)
  await page.screenshot({ path: join(base, 'table-builder.png') })
  await page.getByRole('button', { name: '放弃草稿', exact: true }).click()
  record('XLSX file paste selects a worksheet and never evaluates an uncached formula')

  const mainBeforeLate = await readFile(join(manuscript, 'main.tex'), 'utf8')
  const sectionBeforeLate = await readFile(join(manuscript, 'sections/formulas.tex'), 'utf8')
  await end(); holdAsset = true
  await transfer('drop', 'synthetic-late.png', image, 'image/png')
  await wait(() => assetHeld, Boolean, 'delayed asset result')
  await page.locator('#latex-writing-dialog').getByRole('button', { name: '关闭', exact: true }).click()
  await openFile('sections/formulas.tex')
  releaseAsset(); holdAsset = false
  await wait(() => page.locator('#latex-writing-status').innerText(), text => text.includes('生成内容已保留'), 'stale insertion refused')
  await openTool('#latex-insert-figure')
  assert.match(await page.locator('#latex-writing-output').inputValue(), /synthetic-late-/)
  assert.equal(await source(), sectionBeforeLate)
  assert.equal(await readFile(join(manuscript, 'main.tex'), 'utf8'), mainBeforeLate)
  assert.equal(await readFile(join(manuscript, 'sections/formulas.tex'), 'utf8'), sectionBeforeLate)
  await page.getByRole('button', { name: '放弃草稿', exact: true }).click()
  record('a late image upload cannot insert into another file; generated source remains recoverable')
  const currentMain = await api('latex_read', { id: project.id, path: 'main.tex' })
  await api('latex_write', { id: project.id, path: 'main.tex', content: original, expected_revision: currentMain.revision, origin: 'fixture' })
  const compiled = await api('latex_compile', { id: project.id, engine: 'pdflatex', save_version: false })
  assert.equal(compiled.ok, true)
  await page.reload({ waitUntil: 'networkidle' })
  await page.locator('#latex-preview img').first().waitFor({ state: 'visible' })
  const toolbar = await page.locator('.latex-preview-toolbar').evaluate(node => {
    const bounds = node.getBoundingClientRect()
    return { scrollLeft: node.scrollLeft, outside: [...node.querySelectorAll('button,select')].filter(child => {
      if (!child.getClientRects().length || getComputedStyle(child).display === 'none') return false
      const box = child.getBoundingClientRect(); return box.left < bounds.left - 1 || box.right > bounds.right + 1
    }).map(child => child.id || child.textContent) }
  })
  assert.equal(toolbar.scrollLeft, 0); assert.deepEqual(toolbar.outside, [])
  await page.emulateMedia({ colorScheme: 'light' }); await page.screenshot({ path: join(base, 'writing-light.png') })
  await page.emulateMedia({ colorScheme: 'dark' }); await page.screenshot({ path: join(base, 'writing-dark.png') })
  record('refreshed light and dark workspaces show the rail and all preview controls at 1512×982')
  assert.equal(modelCalls, 0); assert.deepEqual(errors, [])
  console.log(JSON.stringify({ ok: true, checks, artifacts: base, model_calls: modelCalls, browser_errors: errors }, null, 2))
} catch (error) {
  await page?.screenshot({ path: join(base, 'failure.png') }).catch(() => {})
  console.error(JSON.stringify({ ok: false, checks, artifacts: base, error: String(error?.stack || error) }, null, 2)); process.exitCode = 1
} finally {
  releaseAsset?.()
  await browser?.close().catch(() => {})
  if (child && child.exitCode === null) { child.kill('SIGTERM'); await new Promise(resolve => child.once('exit', resolve)) }
}
