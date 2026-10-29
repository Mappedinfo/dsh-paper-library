/** 合成目录与界面高亮验收；所有稿件、状态和截图都在临时目录。
 * PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs node scripts/latex-outline-fixture.mjs
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const base = await mkdtemp(join(tmpdir(), 'paper-latex-outline-'))
const manuscript = join(base, 'manuscript')
const checks = [], errors = [], contrastChecks = []
let customColorControl
const record = label => { checks.push(label); console.log(`PASS ${label}`) }
const wait = async (read, accept, label, attempts = 150) => {
  for (let index = 0; index < attempts; index++) { const value = await read(); if (accept(value)) return value; await new Promise(resolve => setTimeout(resolve, 100)) }
  throw new Error(`Timed out: ${label}`)
}
await mkdir(join(manuscript, 'sections'), { recursive: true })
await writeFile(join(manuscript, 'main.tex'), '\\documentclass{article}\n\\begin{document}\n\\input{sections/intro}\n\\input{sections/method}\n\\end{document}\n')
await writeFile(join(manuscript, 'sections/intro.tex'), '\\section{First synthetic section}\nA short synthetic paragraph.\n\\subsection{Second synthetic heading}\nAnother short paragraph.\n\\subsection{Third synthetic heading}\nA final short paragraph.\n')
await writeFile(join(manuscript, 'sections/method.tex'), '\\section{Another synthetic file}\nA separate synthetic file.\n')

let child, browser, page
try {
  child = spawn(process.execPath, ['src/server.mjs', '--port', '0', '--library', join(base, 'library'), '--state-home', join(base, 'state')], {
    cwd: root, env: { ...process.env, DSH_HOME: join(base, 'dsh') }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = '', stderr = ''
  child.stdout.on('data', chunk => { stdout += chunk }); child.stderr.on('data', chunk => { stderr += chunk })
  const origin = await wait(() => { if (child.exitCode !== null) throw new Error(stderr); return stdout.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0] }, Boolean, 'temporary host')
  const api = async (action, args = {}) => {
    for (let attempt = 0; attempt < 20; attempt++) {
      const response = await fetch(`${origin}/api`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, ...args }) })
      if (response.status === 429) { await new Promise(resolve => setTimeout(resolve, 100)); continue }
      const value = await response.json(); if (!value.ok) throw new Error(value.error); return value.result
    }
    throw new Error('No synthetic API admission slot')
  }
  const project = (await api('latex_project_create', { root: manuscript, title: '合成目录高亮检查' })).project
  const initial = await api('settings_get')
  await api('settings_update', { patch: { latex_auto_compile: false }, expected_revision: initial.revision })
  const build = await api('latex_compile', { id: project.id, engine: 'pdflatex' })
  assert.equal(build.ok, true, build.log_tail)

  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage({ viewport: { width: 1512, height: 982 } })
  page.on('pageerror', error => errors.push(error.message))
  await page.route('**/api', route => {
    const action = route.request().postDataJSON().action
    if (action === 'models') return route.fulfill({ json: { ok: true, result: { models: [] } } })
    if (action === 'latex_ai_status') return route.fulfill({ json: { ok: true, result: { configured: false, entries: [] } } })
    if (/latex_ai_(ask|propose)/.test(action)) throw new Error('No model request is permitted in this fixture')
    return route.continue()
  })
  const open = async () => { await page.goto(`${origin}/?view=latex`, { waitUntil: 'networkidle' }); await page.locator('.cm-content').waitFor({ state: 'visible' }) }
  const heading = text => page.locator('#latex-outline .latex-outline-heading button', { hasText: text })
  const active = () => page.locator('#latex-outline .active').allTextContents()
  const expectActive = text => wait(active, values => values.length === 1 && values[0] === text, `${text} exclusively active`)
  const setting = async (id, value, key, expected = value) => {
    if (!await page.locator('#latex-menu').isVisible()) await page.locator('#latex-menu-open').click()
    await page.locator(id).selectOption(value)
    await wait(() => api('settings_get'), result => result.value[key] === expected, `${key} saved`)
    await page.locator('#latex-menu-open').click()
  }
  const host = async dark => {
    await page.emulateMedia({ colorScheme: dark ? 'dark' : 'light' })
    await page.evaluate(dark => {
      const values = dark
        ? { '--dsw-alias-bg-base': '#111214', '--dsw-alias-bg-layer-1': '#1b1d20', '--dsw-alias-label-primary': '#f9fafb', '--dsw-alias-label-secondary': '#cfd3d6', '--dsw-specific-sidebar-nav-item-active': '#45464a' }
        : { '--dsw-alias-bg-base': '#ffffff', '--dsw-alias-bg-layer-1': '#ffffff', '--dsw-alias-label-primary': '#17212b', '--dsw-alias-label-secondary': '#59646f', '--dsw-specific-sidebar-nav-item-active': '#dce7f2' }
      for (const [name, value] of Object.entries(values)) document.documentElement.style.setProperty(name, value)
    }, dark)
  }
  const colors = async () => {
    await page.mouse.move(1400, 950)
    return page.evaluate(() => {
      const chosen = document.querySelector('#latex-outline .active')
      const sibling = [...document.querySelectorAll('#latex-outline .latex-outline-heading .current-file')].find(node => !node.classList.contains('active'))
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1
      const ctx = canvas.getContext('2d')
      const rgb = color => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = color; ctx.fillRect(0, 0, 1, 1); return [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3) }
      const luminance = pixels => pixels.map(value => { const channel = value / 255; return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4 }).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0)
      const data = node => { const style = getComputedStyle(node), foreground = rgb(style.color), background = rgb(style.backgroundColor), a = luminance(foreground), b = luminance(background); return { foreground, background, contrast: (Math.max(a, b) + .05) / (Math.min(a, b) + .05), marker: style.boxShadow } }
      return { active: data(chosen), sibling: data(sibling) }
    })
  }
  const checkColors = async () => {
    const result = await colors()
    assert.notDeepEqual(result.active.background, result.sibling.background, 'current heading must be stronger than file context')
    assert.ok(result.active.contrast >= 4.5 && result.sibling.contrast >= 4.5, `text contrast: ${JSON.stringify(result)}`)
    contrastChecks.push(result.active.contrast, result.sibling.contrast)
    return result
  }
  const screenshot = async name => {
    await wait(() => page.locator('#latex-preview img.latex-page').evaluateAll(nodes => nodes.length > 0 && nodes.every(node => node.complete && node.naturalWidth > 0)), Boolean, 'preview image decoded')
    await page.locator('#latex-preview img.latex-page').evaluateAll(nodes => Promise.all(nodes.map(node => node.decode())))
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    await page.screenshot({ path: join(base, name) })
  }

  await open()
  await heading('Second synthetic heading').click(); await expectActive('Second synthetic heading')
  assert.equal(await page.locator('#latex-outline [aria-current="location"]').count(), 1)
  assert.equal(await page.locator('#latex-outline .latex-outline-heading .current-file').count(), 3)
  assert.equal(await page.locator('#latex-outline .current-file').evaluateAll(nodes => nodes.every(node => node.dataset.path === 'sections/intro.tex')), true)
  record('one heading is current while related headings retain only file context')

  await page.locator('.cm-line', { hasText: '\\section{First synthetic section}' }).click()
  await expectActive('First synthetic section')
  for (let index = 0; index < 4; index++) await page.keyboard.press('ArrowDown')
  await expectActive('Third synthetic heading')
  await heading('Another synthetic file').click(); await expectActive('Another synthetic file')
  assert.equal(await page.locator('#latex-outline .current-file').evaluateAll(nodes => nodes.every(node => node.dataset.path === 'sections/method.tex')), true)
  await heading('Second synthetic heading').click(); await expectActive('Second synthetic heading')
  record('real editor cursor and cross-file navigation update the exclusive current heading')

  await host(false)
  assert.equal(await page.locator('#latex-view').getAttribute('data-latex-accent'), 'system')
  const inherited = await checkColors(); assert.deepEqual(inherited.active.background, [220, 231, 242])
  await page.evaluate(() => document.documentElement.style.setProperty('--dsw-specific-sidebar-nav-item-active', '#e6d9ed'))
  assert.deepEqual((await checkColors()).active.background, [230, 217, 237])
  record('default highlight follows live DSH tokens with distinct context and readable text')

  await setting('#latex-setting-accent', '#4176e6', 'latex_accent')
  assert.equal(await page.locator('#latex-view').getAttribute('data-latex-accent'), 'custom')
  assert.notDeepEqual((await checkColors()).active.background, [230, 217, 237])
  if (!await page.locator('#latex-menu').isVisible()) await page.locator('#latex-menu-open').click()
  await page.locator('#latex-setting-accent').selectOption('custom')
  await page.locator('#latex-setting-accent-color').fill('#ad476b')
  await wait(() => api('settings_get'), result => result.value.latex_accent === '#ad476b', 'custom accent saved')
  customColorControl = await page.locator('#latex-setting-accent-color').evaluate(node => { const box = node.getBoundingClientRect(), style = getComputedStyle(node); return { width: box.width, height: box.height, padding: style.padding } })
  assert.ok(customColorControl.width >= 36 && customColorControl.width <= 64 && customColorControl.height >= 30 && customColorControl.height <= 44, `compact usable color control: ${JSON.stringify(customColorControl)}`)
  assert.ok(customColorControl.padding.split(' ').every(value => parseFloat(value) <= 6), 'color swatch is not squeezed by normal text-input padding')
  await screenshot('outline-settings.png')
  await page.locator('#latex-menu-open').click()
  await page.reload({ waitUntil: 'networkidle' }); await page.locator('.cm-content').waitFor({ state: 'visible' })
  await heading('Second synthetic heading').click(); await expectActive('Second synthetic heading')
  assert.equal(await page.locator('#latex-view').getAttribute('data-latex-accent'), 'custom')
  assert.equal(await page.locator('#latex-setting-accent-color').inputValue(), '#ad476b')
  await host(false); await checkColors()
  await screenshot('outline-light.png')
  await setting('#latex-setting-accent', 'system', 'latex_accent')
  assert.deepEqual((await checkColors()).active.background, [220, 231, 242])
  record('preset and custom colors persist, then reset returns to DSH without changing its tokens')

  await host(true); await checkColors()
  await screenshot('outline-dark.png')
  await setting('#latex-setting-theme', 'parchment', 'latex_theme'); await checkColors()
  await host(false)
  await setting('#latex-setting-theme', 'midnight', 'latex_theme'); await checkColors()
  record('dark mode and opposite-host local themes retain readable selected and contextual states')
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ ok: true, checks, minimum_text_contrast: Math.min(...contrastChecks), custom_color_control: customColorControl, screenshots: base, browser_errors: errors, model_calls: 0 }, null, 2))
} catch (error) {
  await page?.screenshot({ path: join(base, 'failure.png') }).catch(() => {})
  console.error(JSON.stringify({ ok: false, checks, screenshots: base, error: String(error?.stack || error) }, null, 2)); process.exitCode = 1
} finally {
  await browser?.close().catch(() => {})
  if (child && child.exitCode === null) { child.kill('SIGTERM'); await new Promise(resolve => child.once('exit', resolve)) }
}
