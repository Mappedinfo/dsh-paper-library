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
  await page.locator('#latex-workspace').waitFor({ state: 'visible' })
  await until(() => page.locator('#latex-editor').inputValue(), value => value.includes('Shell integration manuscript.'), 'project loaded in the editor')
  const options = await page.locator('#latex-project option').allInnerTexts()
  if (!options.some(text => text.includes('外壳验证'))) throw new Error(`project missing from the picker: ${options.join(', ')}`)
  record('opening-the-panel-loads-the-registered-project-and-its-source')

  await until(() => page.locator('#latex-status').innerText(), value => value.includes('不可用') || value.includes('未连接'), 'collaboration availability reported')
  const aiVisible = await page.locator('#latex-ai').isVisible()
  if (aiVisible) throw new Error('the collaboration strip must stay hidden without a DSH route')
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
