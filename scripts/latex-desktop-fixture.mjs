/** Synthetic desktop acceptance against the standalone host and real latexmk.
 * PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs node scripts/latex-desktop-fixture.mjs
 * All project, library, settings and screenshots are confined to a temporary directory.
 */
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const base = await mkdtemp(join(tmpdir(), 'paper-latex-desktop-'))
const manuscript = join(base, 'manuscript')
const checks = []
const record = label => { checks.push(label); console.log(`PASS ${label}`) }
const wait = async (read, predicate, label, attempts = 200) => {
  for (let i = 0; i < attempts; i++) {
    const value = await read()
    if (predicate(value)) return value
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`Timed out: ${label}`)
}
await mkdir(join(manuscript, 'sections'), { recursive: true })
await writeFile(join(manuscript, 'main.tex'), '\\documentclass{article}\n\\begin{document}\n\\input{sections/intro}\n\\end{document}\n')
await writeFile(join(manuscript, 'sections', 'intro.tex'), '\\section{Synthetic}\nA test paragraph.\n' + Array.from({length: 6}, (_, i) => `\\newpage\nSynthetic continuous page ${i + 2}.\n`).join(''))

let child, browser, page
try {
  child = spawn(process.execPath, ['src/server.mjs', '--port', '0', '--library', join(base, 'library'), '--state-home', join(base, 'state')], {
    cwd: root, env: { ...process.env, DSH_HOME: join(base, 'dsh') }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = '', stderr = ''
  child.stdout.on('data', data => { stdout += data })
  child.stderr.on('data', data => { stderr += data })
  const origin = await wait(() => {
    if (child.exitCode !== null) throw new Error(`Host exited: ${stderr}`)
    return stdout.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0]
  }, Boolean, 'standalone host')
  const result = await fetch(`${origin}/api`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'latex_project_create', root: manuscript, title: '合成写作检查' }) }).then(response => response.json())
  if (!result.ok) throw new Error(`Register project: ${JSON.stringify(result)}`)
  const latexId = result.result.project.id
  const api = async (action, args = {}) => {
    for(let attempt=0;attempt<20;attempt++){
      const response = await fetch(`${origin}/api`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({action,...args}) })
      if(response.status===429){await new Promise(resolve=>setTimeout(resolve,100));continue}
      const value=await response.json();if(!value.ok)throw new Error(value.error);return value.result
    }
    throw new Error('Synthetic polling could not obtain an API slot')
  }

  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage({ viewport: { width: 1512, height: 982 } })
  const browserErrors = []
  page.on('pageerror', error => browserErrors.push(error.message))
  await page.goto(`${origin}/?view=latex`, { waitUntil: 'networkidle' })
  await page.locator('#latex-view').waitFor({ state: 'visible' })
  await page.locator('.cm-content').waitFor({ state: 'visible' })
  await wait(() => page.evaluate(() => document.querySelector('#latex-editor')?.value), text => text?.includes('sections/intro'), 'main source')
  const syntax = await page.evaluate(() => ({ command: getComputedStyle(document.querySelector('.cm-line span')).color, text: getComputedStyle(document.querySelector('.cm-editor')).color }))
  if (syntax.command === syntax.text) throw new Error('LaTeX commands have no distinct syntax colour')
  await page.screenshot({ path: join(base, 'desktop-light.png') })
  record('desktop opens synthetic project with CodeMirror and reading rail')

  await page.locator('#latex-nav-toggle').click()
  if (await page.locator('#latex-navigator').isVisible()) throw new Error('navigation did not collapse')
  await page.locator('#latex-nav-toggle').click()
  if (!await page.locator('#latex-navigator').isVisible()) throw new Error('navigation did not reopen')
  await page.locator('#latex-layout-source').click()
  if (await page.locator('.latex-preview-pane').isVisible()) throw new Error('source-only view did not hide preview')
  await page.locator('#latex-layout-pdf').click()
  if (await page.locator('.latex-editor-pane').isVisible()) throw new Error('PDF-only view did not hide source')
  await page.locator('#latex-layout-split').click()
  record('navigation and focus modes toggle without losing the split view')

  await page.locator('#latex-menu-open').click()
  await page.locator('#latex-setting-auto').uncheck()
  for (const engine of ['pdflatex', 'lualatex', 'xelatex']) {
    await page.locator('#latex-setting-engine').selectOption(engine)
    await page.locator('#latex-menu-open').click()
    await page.locator('#latex-compile').click()
    await wait(() => page.locator('#latex-build-info').innerText(), text => text.includes(engine) && text.includes('页'), `${engine} compile`, 500)
    const status = await page.locator('#latex-status').innerText()
    if (!status.includes('完成')) throw new Error(`${engine} failed: ${status}`)
    if (engine !== 'xelatex') await page.locator('#latex-menu-open').click()
  }
  await page.locator('#latex-preview img').first().waitFor({ state: 'visible' })
  record('all three selected engines compile the same synthetic project')
  await page.evaluate(() => { const preview = document.querySelector('#latex-preview'); preview.scrollTop = preview.scrollHeight; preview.dispatchEvent(new Event('scroll')) })
  await wait(() => page.locator('#latex-page-label').innerText(), text => text.includes('7 / 7'), 'continuous last page')
  if (await page.locator('#latex-preview img').count() > 3) throw new Error('continuous preview renders too many pages')
  await page.evaluate(() => { const preview = document.querySelector('#latex-preview'); preview.scrollTop = 0; preview.dispatchEvent(new Event('scroll')) })
  await wait(() => page.locator('#latex-page-label').innerText(), text => text.includes('1 / 7'), 'continuous first page')
  record('continuous scroll reaches both ends while at most three page images are retained')
  for (const [index, mode] of ['highlight','underline','strikeout','comment'].entries()) {
    await page.locator('.latex-page-stage[data-page="1"] .latex-word-text').first().waitFor({state:'attached'})
    await page.locator(`#latex-tool-${mode}`).click()
    await page.evaluate(() => {
      const word=document.querySelector('.latex-page-stage[data-page="1"] .latex-word-text'); const range=document.createRange(); range.selectNodeContents(word)
      const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range)
      word.closest('.latex-text-layer').dispatchEvent(new PointerEvent('pointerup',{bubbles:true,button:0,pointerId:1}))
    })
    if(mode==='comment'){await page.locator('#latex-review-comment').fill('合成：直接选文批注');await page.locator('#latex-review-save').click()}
    await wait(()=>page.locator('#latex-review-message').innerText(),text=>text.includes('批注已保存'),`${mode} save confirmation`)
    await wait(()=>api('latex_review_list',{id:latexId}),value=>value.annotations.length===index+1,`${mode} native annotation`)
    await page.locator('#latex-review-composer').waitFor({state:'hidden'})
  }
  await page.locator('#latex-tool-select').click()
  await page.locator('#latex-compile').click()
  await wait(()=>page.locator('#latex-compile').innerText(),text=>text==='编译','annotated manual snapshot')
  await wait(()=>api('latex_version_list',{id:latexId}),value=>value.versions.some(version=>version.review_count===4),'annotated snapshot stored')
  record('plain marks and direct text comments save as native objects and enter manual versions')

  const editor = page.locator('.cm-content')
  await page.locator('#latex-nav-files').click()
  await page.locator('#latex-files [data-path="sections/intro.tex"]').click()
  await wait(() => page.evaluate(() => document.querySelector('#latex-editor').value), text => text.includes('A test paragraph.'), 'section loaded for SyncTeX')
  await editor.click()
  await page.keyboard.press('Meta+Home')
  await page.keyboard.press('ArrowDown')
  await page.locator('#latex-synctex-forward').click()
  await page.locator('.latex-sync-highlight').waitFor({ state: 'visible' })
  const marker = await page.locator('.latex-sync-highlight').boundingBox()
  await page.mouse.dblclick(marker.x + marker.width / 2, marker.y + marker.height / 2)
  await wait(() => page.locator('#latex-status').innerText(), text => text.includes('已跳到 sections/intro.tex'), 'inverse SyncTeX')
  await page.locator('#latex-files .latex-file-open', { hasText: 'main.tex' }).click()
  await wait(() => page.evaluate(() => document.querySelector('#latex-editor').value), text => text.startsWith('\\documentclass'), 'main reloaded after SyncTeX')
  record('source and PDF jump through real SyncTeX with the new editor')

  await editor.click()
  await page.evaluate(() => { const source = document.querySelector('#latex-editor'); source.setSelectionRange(source.value.length, source.value.length); source.focus() })
  await page.keyboard.insertText('\\sec')
  await page.locator('.cm-tooltip-autocomplete').waitFor({ state: 'visible' })
  await page.keyboard.press('Escape')
  for (let i = 0; i < 4; i++) await page.keyboard.press('Backspace')
  await page.keyboard.press('Meta+End')
  await page.keyboard.insertText('% desktop check 中文\n')
  await wait(() => readFile(join(manuscript, 'main.tex'), 'utf8'), text => text.includes('desktop check 中文'), 'editor autosave')
  await page.keyboard.press('Meta+z')
  await wait(() => readFile(join(manuscript, 'main.tex'), 'utf8'), text => !text.includes('desktop check 中文'), 'undo autosave')
  await page.keyboard.press('Meta+Shift+z')
  await wait(() => readFile(join(manuscript, 'main.tex'), 'utf8'), text => text.includes('desktop check 中文'), 'redo autosave')
  await page.locator('#latex-source-search').click()
  await page.locator('.cm-search').waitFor({ state: 'visible' })
  await page.locator('.cm-search [name="search"]').fill('desktop check')
  await page.locator('.cm-search input[name="replace"]').fill('replaced check')
  await page.locator('.cm-search [name="replaceAll"]').click()
  await wait(() => readFile(join(manuscript, 'main.tex'), 'utf8'), text => text.includes('replaced check 中文'), 'replace autosave')
  await page.locator('.cm-search [name="close"]').click()
  record('real editor input, Unicode, undo, redo and replace persist to disk')

  await page.locator('#latex-nav-files').click()
  await page.locator('#latex-files [data-path="sections/intro.tex"]').click()
  await wait(() => page.evaluate(() => document.querySelector('#latex-editor').value), text => text.includes('A test paragraph.'), 'section loaded')
  await editor.click()
  await page.keyboard.press('Meta+End')
  await page.keyboard.insertText('\\UnknownSyntheticCommand\n')
  await page.locator('#latex-compile').click()
  await wait(() => page.locator('#latex-diagnostics-toggle').innerText(), text => text.includes('失败'), 'compile error')
  await page.screenshot({ path: join(base, 'desktop-diagnostics.png') })
  await page.locator('#latex-files .latex-file-open', { hasText: 'main.tex' }).click()
  await wait(() => page.evaluate(() => document.querySelector('#latex-editor').value), text => text.startsWith('\\documentclass'), 'main loaded before diagnostic jump')
  await page.locator('.latex-diagnostic-link', { hasText: 'intro.tex' }).first().click()
  await wait(() => page.locator('#latex-current-file').innerText(), text => text.includes('sections/intro.tex'), 'error location')
  await editor.click()
  // Loading the file resets undo history; remove the deliberate error explicitly.
  await page.keyboard.press('Meta+a')
  await page.keyboard.insertText('\\section{Synthetic}\nA test paragraph.\n')
  await page.locator('#latex-compile').click()
  await wait(() => page.locator('#latex-diagnostics-toggle').innerText(), text => text.includes('成功'), 'recovered compile')
  await wait(() => page.locator('#latex-compile').innerText(), text => text === '编译', 'recovered preview finished')
  record('real compile errors locate the section and a corrected source compiles again')
  const savedVersions = await api('latex_version_list',{id:latexId})
  const newest = savedVersions.versions[0]
  await page.locator('#latex-tab-version').click()
  const versionCard = page.locator(`#latex-versions [data-version-id="${newest.id}"]`)
  await versionCard.waitFor({state:'visible'})
  await versionCard.getByRole('button',{name:'批注与源码',exact:true}).click()
  await versionCard.locator('.latex-version-notes').waitFor({state:'attached'})
  await versionCard.getByRole('button',{name:'预览 PDF',exact:true}).click()
  await wait(()=>page.locator('#latex-sync-hint').innerText(),text=>text.includes('历史'),'history preview')
  if(!await page.locator('#latex-tool-highlight').isDisabled())throw new Error('historical PDF is writable')
  await page.locator('#latex-tab-version').click()
  await versionCard.getByRole('button',{name:/批注 PDF/}).first().click()
  await wait(()=>page.locator('#latex-sync-hint').innerText(),text=>text.includes('历史'),'annotated history preview')
  await page.locator('#latex-back').click()
  await wait(()=>page.locator('#project-select option').evaluateAll(nodes=>nodes.map(node=>node.value)),values=>values.includes(newest.reading_project_id),'shared reading project appears')
  await page.locator('#project-select').selectOption(newest.reading_project_id)
  await page.locator('#latex-version-shelf summary').click()
  const libraryVersion = page.locator(`#library-latex-versions [data-version-id="${newest.id}"]`)
  await libraryVersion.waitFor({state:'visible'})
  await libraryVersion.getByRole('button',{name:'预览 PDF',exact:true}).click()
  await wait(()=>page.locator('#latex-sync-hint').innerText(),text=>text.includes('历史'),'library entry opens same history')
  record('workspace and reading project open the same immutable version and native review PDF')
  await page.locator('#latex-menu-open').click()
  for(const theme of ['parchment','midnight','system']){
    await page.locator('#latex-setting-theme').selectOption(theme)
    await wait(()=>api('settings_get'),value=>value.value.latex_theme===theme,`${theme} theme persisted`)
  }
  await page.locator('#latex-menu-open').click()
  await page.evaluate(()=>document.fonts.load('12px PaperPixel'))
  const dimensions = await page.evaluate(()=>({select:document.querySelector('#latex-project').getBoundingClientRect().height,button:document.querySelector('#latex-compile').getBoundingClientRect().height,font:document.fonts.check('12px PaperPixel')}))
  if(Math.abs(dimensions.select-dimensions.button)>2 || !dimensions.font)throw new Error(`control/font mismatch: ${JSON.stringify(dimensions)}`)
  record('themes persist locally, project control height matches and pixel font loads locally')

  await page.emulateMedia({ colorScheme: 'dark' })
  await page.screenshot({ path: join(base, 'desktop-dark.png') })
  await page.emulateMedia({ colorScheme: 'light' })
  await page.locator('#latex-review-open').click()
  await page.locator('#latex-review-panel').waitFor({ state: 'visible' })
  await page.screenshot({ path: join(base, 'desktop-review.png') })
  await page.locator('.latex-topbar').screenshot({ path: join(base, 'desktop-toolbar.png') })
  record('light, dark and review rail render at the target viewport')
  if (browserErrors.length) throw new Error(`Browser errors: ${browserErrors.join(' | ')}`)
  console.log(JSON.stringify({ ok: true, checks, screenshots: base, browser_errors: browserErrors }, null, 2))
} catch (error) {
  if (page) {
    await page.screenshot({ path: join(base, 'failure.png') }).catch(() => {})
    console.error(JSON.stringify(await page.evaluate(() => ({ status: document.querySelector('#latex-status')?.textContent, build: document.querySelector('#latex-build-info')?.textContent, errors: document.querySelector('#latex-errors')?.textContent, save: document.querySelector('#latex-save-state')?.textContent })).catch(() => ({}))))
  }
  console.error(JSON.stringify({ ok: false, checks, error: String(error?.stack || error), screenshots: base }, null, 2))
  process.exitCode = 1
} finally {
  await browser?.close().catch(() => {})
  if (child && child.exitCode === null) { child.kill('SIGTERM'); await new Promise(resolve => child.once('exit', resolve)) }
}
