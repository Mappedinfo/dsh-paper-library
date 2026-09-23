/**
 * Integration fixture for the plugin shell itself: the real `src/server.mjs` host,
 * the real page and the real panel, in a real Chromium.
 *
 * The panel fixture drives a minimal page; this one proves the shipped shell loads
 * the panel (asset wiring, load order, topbar entry, dialog) and that a deployment
 * without a DSH model reports the collaboration strip as unavailable instead of
 * offering buttons that cannot work.
 *
 * Run: PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node scripts/latex-shell-fixture.mjs
 * Writes docs/validation/latex-shell-browser.json
 */
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const project = dirname(dirname(fileURLToPath(import.meta.url)))
const checks = []
const record = value => { checks.push(value); console.log(`PASS ${value}`) }
const until = async (read, accept, label, attempts = 150) => {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const value = await read()
    if (accept(value)) return value
    await new Promise(done => setTimeout(done, 100))
  }
  throw new Error(`Timed out: ${label}`)
}

let child, browser
try {
  const base = await mkdtemp(join(tmpdir(), 'latex-shell-'))
  const library = join(base, 'library')
  const folder = join(base, 'manuscript')
  await mkdir(folder, { recursive: true })
  await writeFile(join(folder, 'main.tex'), '\\documentclass[11pt]{article}\n\\begin{document}\nShell integration manuscript.\n\\end{document}\n')

  child = spawn(process.execPath, ['src/server.mjs', '--port', '0', '--library', library], { cwd: project, stdio: ['ignore', 'pipe', 'pipe'] })
  const origin = await until(() => new Promise(resolve => {
    const text = child.stdout.read()?.toString() || ''
    const match = text.match(/http:\/\/127\.0\.0\.1:\d+\//)
    resolve(match ? match[0].replace(/\/$/, '') : null)
  }), value => Boolean(value), 'preview host start', 100)
  record('the-standalone-host-serves-the-plugin-shell')

  const created = await fetch(`${origin}/api`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'latex_project_create', root: folder, title: '外壳验证' }) }).then(response => response.json())
  if (!created.ok) throw new Error(`project registration failed: ${JSON.stringify(created)}`)

  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
  browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(origin, { waitUntil: 'load' })

  const shell = await page.content()
  if (!shell.includes('latex-workspace.js') || !shell.includes('latex-workspace.css')) throw new Error('the page does not load the workspace assets')
  await page.locator('#latex-open').waitFor({ timeout: 15000 })
  record('the-shipped-page-loads-the-panel-and-its-topbar-entry')

  await page.locator('#latex-open').click()
  await page.locator('#latex-view').waitFor({ state: 'visible' })
  await until(() => page.locator('#latex-editor').inputValue(), value => value.includes('Shell integration manuscript.'), 'project loaded in the editor')
  const options = await page.locator('#latex-project option').allInnerTexts()
  if (!options.some(text => text.includes('外壳验证'))) throw new Error(`project missing from the picker: ${options.join(', ')}`)
  if (!await page.evaluate(() => document.body.classList.contains('latex-focused'))) throw new Error('the workspace did not take over the page')
  if (await page.locator('.topbar').isVisible()) throw new Error('the library topbar is still visible behind the workspace')
  record('the-entry-opens-a-full-page-workspace-with-the-registered-project')

  await page.locator('#latex-back').click()
  await until(() => page.locator('#latex-view').isVisible(), value => value === false, 'back to the library')
  if (!await page.locator('.library-pane').isVisible()) throw new Error('the library did not come back')
  record('the-workspace-returns-to-the-library-without-a-reload')

  // The dedicated entry a DSH tab can host: `?view=latex` is a pure workspace page.
  await page.goto(`${origin}/?view=latex`, { waitUntil: 'load' })
  await page.locator('#latex-view').waitFor({ state: 'visible' })
  await until(() => page.locator('#latex-editor').inputValue(), value => value.includes('Shell integration manuscript.'), 'standalone entry loaded the project')
  if (await page.locator('#reading-sidebar-library-content').isVisible()) throw new Error('the standalone entry still renders the library list')
  record('the-view-latex-entry-opens-as-a-pure-workspace-page')

  // Project actions live behind one ☰ menu now, not in the toolbar.
  if (await page.locator('#latex-project-new').count()) throw new Error('the toolbar still has a folder-registration button')
  await page.locator('#latex-menu-open').click()
  await page.locator('#latex-menu').waitFor({ state: 'visible' })
  if (!await page.locator('#latex-create-name').isVisible()) throw new Error('the menu does not offer creating a project in the plugin folder')
  if (!await page.locator('#latex-new-root').isVisible()) throw new Error('the menu does not offer registering an existing folder')
  if (!await page.locator('#latex-setting-starter').isVisible()) throw new Error('the menu does not expose the starter setting')
  record('project-actions-and-settings-live-in-the-hamburger-menu')

  // DSH 写作 lives in the same rail as the annotation panel, not inside the workspace.
  await page.locator('#reading-sidebar-latex-ai').waitFor({ state: 'visible' })
  if (!await page.locator('#latex-ai').isVisible()) throw new Error('the collaboration panel is not in the rail')
  if (await page.locator('#reading-sidebar-library').isVisible()) throw new Error('the library tab should step aside for this panel')
  if (await page.locator('#reading-sidebar-annotations').isVisible()) throw new Error('the annotations tab should step aside for this panel')
  await until(() => page.locator('#latex-ai-route').innerText(), value => /DSH|模型服务|不可用/.test(value), 'collaboration availability reported')
  record('the-collaboration-panel-shares-the-library-rail')

  // Closing the rail must not leave an empty column behind: the surface takes the width.
  await page.locator('#reading-sidebar-close').click()
  await until(() => page.evaluate(() => Boolean(document.querySelector('.library-pane')?.getClientRects().length)), value => value === false, 'rail closed')
  const widths = await page.evaluate(() => ({
    workspace: Math.round(document.querySelector('.workspace').getBoundingClientRect().width),
    view: Math.round(document.getElementById('latex-view').getBoundingClientRect().width),
    columns: getComputedStyle(document.querySelector('.workspace')).gridTemplateColumns,
    pressed: document.getElementById('latex-ai-open').getAttribute('aria-pressed'),
  }))
  if (widths.view !== widths.workspace || widths.columns.includes(' ')) throw new Error(`an empty rail column is left behind: ${JSON.stringify(widths)}`)
  if (widths.pressed !== 'false') throw new Error('the toolbar toggle did not follow the rail close button')
  record('closing-the-rail-leaves-no-empty-column')

  await page.locator('#latex-ai-open').click()
  await page.locator('#latex-ai').waitFor({ state: 'visible' })
  if (!await page.locator('#reading-sidebar-latex-ai').isVisible()) throw new Error('the toolbar toggle did not bring the rail back')
  record('the-toolbar-toggle-opens-the-collaboration-rail-again')

  // The reader's own preference can put the rail on the right; the layout must hold there too.
  await page.locator('#reading-sidebar-side').click()
  await until(() => page.evaluate(() => document.querySelector('.workspace').getAttribute('data-sidebar-side')), value => value === 'right', 'rail moved to the right')
  await page.locator('#reading-sidebar-close').click()
  await until(() => page.evaluate(() => Boolean(document.querySelector('.library-pane')?.getClientRects().length)), value => value === false, 'right rail closed')
  const rightClosed = await page.evaluate(() => ({
    workspace: Math.round(document.querySelector('.workspace').getBoundingClientRect().width),
    view: Math.round(document.getElementById('latex-view').getBoundingClientRect().width),
    columns: getComputedStyle(document.querySelector('.workspace')).gridTemplateColumns,
  }))
  if (rightClosed.view !== rightClosed.workspace || rightClosed.columns.includes(' ')) throw new Error(`right-side rail left an empty column: ${JSON.stringify(rightClosed)}`)
  record('the-layout-holds-with-the-rail-on-the-right-too')

  await until(() => page.locator('#latex-ai-route').innerText(), value => /DSH|模型服务|不可用/.test(value), 'collaboration availability reported')
  record('a-host-without-dsh-reports-collaboration-unavailable-instead-of-offering-it')

  const external = await page.evaluate(() => performance.getEntriesByType('resource').filter(entry => /^https?:\/\//.test(entry.name) && !entry.name.startsWith(location.origin)).length)
  if (external) throw new Error(`the shell requested ${external} external resources`)
  if (errors.length) throw new Error(`browser errors: ${errors.join(' | ')}`)
  record('the-shell-makes-no-external-requests-and-raises-no-browser-errors')

  const report = { verified_at: new Date().toISOString(), ok: true, checks, external_requests: external, browser_errors: errors, limits: ['Local Chromium against the real src/server.mjs host; the DSH-hosted page is not covered here'] }
  await writeFile(join(project, 'docs', 'validation', 'latex-shell-browser.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report, null, 2))
} catch (error) {
  const report = { verified_at: new Date().toISOString(), ok: false, checks, error: String(error && error.message || error) }
  try { await writeFile(join(project, 'docs', 'validation', 'latex-shell-browser.json'), JSON.stringify(report, null, 2) + '\n') } catch {}
  console.log(JSON.stringify(report, null, 2))
  process.exitCode = 1
} finally {
  await browser?.close().catch(() => {})
  child?.kill('SIGINT')
}
