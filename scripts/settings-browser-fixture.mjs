/** Native DSH settings and Paper Library settings share one isolated host document.
 * Requires an existing Playwright runtime through PLAYWRIGHT_MODULE; no real data/model.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { access, copyFile, mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createLocalStateStore } from '../src/local-state.mjs'

const project = dirname(dirname(fileURLToPath(import.meta.url)))
const harness = resolve(process.env.DSH_CHECKOUT ?? join(project, '../../deepseek-ai/deepseek-harness'))
const templateHome = resolve(process.env.DSH_TEST_HOME ?? join(project, '.local/paper-chat-test-home'))
const profile = process.env.DSH_TEST_PROFILE ?? 'paper-chat-test'
const run = join(templateHome, 'runs', `settings-browser-${randomUUID()}`), home = join(run, 'home'), library = join(run, 'library')
const reportPath = join(project, 'docs/validation/settings-browser.json')
const checks = [], browserErrors = [], external = [], screenshots = []
let child, timer, browser, report, logs = '', host
const record = value => { checks.push(value); console.log(`PASS ${value}`) }
const wait = ms => new Promise(resolveWait => setTimeout(resolveWait, ms))
async function until(read, accept, label) {
  for (let attempt = 0; attempt < 150; attempt++) { const value = await read(); if (accept(value)) return value; await wait(100) }
  throw new Error(`Timed out: ${label}`)
}
async function stopHost() {
  if (!child || child.exitCode !== null) return
  await new Promise(done => { const guard = setTimeout(() => child.kill('SIGKILL'), 3000); child.once('exit', () => { clearTimeout(guard); done() }); child.kill('SIGINT') })
}
async function startHost() {
  const env = Object.fromEntries(['PATH', 'HOME', 'SHELL', 'LANG', 'LC_ALL', 'TMPDIR'].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]))
  Object.assign(env, { DSH_HOME: home, DSH_PAPER_LIBRARY_DIR: library })
  let output = ''
  child = spawn(process.execPath, [join(harness, 'apps/cli/lib/bin.js'), '--profile', profile, '--patch', join(project, 'tests-js/fixtures/harness-chat/cordis.patch.yml'), '--port', '0', '--no-open'], { cwd: run, env, stdio: ['ignore', 'pipe', 'pipe'] })
  const url = await new Promise((accept, reject) => {
    timer = setTimeout(() => reject(new Error('Isolated settings host did not start within 40 seconds')), 40000)
    child.stdout.on('data', bytes => { output = (output + bytes.toString()).slice(-24000); logs += bytes.toString(); const match = output.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+)/); if (match) accept(match[1]) })
    child.stderr.on('data', bytes => { logs += bytes.toString() })
    child.on('error', reject); child.on('exit', code => reject(new Error(`Isolated settings host exited ${code}`)))
  })
  clearTimeout(timer)
  return { url, origin: new URL(url).origin }
}
async function newPage() {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const page = await context.newPage(); page.setDefaultTimeout(15000)
  page.on('pageerror', error => browserErrors.push(error.message))
  page.on('request', request => { if (/^https?:/.test(request.url()) && new URL(request.url()).origin !== host.origin) external.push(new URL(request.url()).origin) })
  await page.addInitScript(() => {
    const set = Storage.prototype.setItem
    Storage.prototype.setItem = function (...args) {
      if (location.pathname.startsWith('/api/paper-library/')) throw new Error('Paper Library browser-storage writes forbidden')
      return set.apply(this, args)
    }
  })
  await page.goto(host.url); await page.waitForLoadState('networkidle')
  const notice = page.getByRole('button', { name: 'Continue', exact: true })
  if (await notice.isVisible()) await notice.click()
  return page
}
async function api(page, input) {
  const response = await page.context().request.post(`${host.origin}/api/paper-library/api`, { data: input, headers: { Origin: host.origin } })
  const body = await response.json(); assert.equal(body.ok, true, JSON.stringify(body)); return body.result
}
async function openSettings(page) {
  if (!await page.getByRole('dialog').isVisible()) await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Plugins', exact: true }).click()
  await page.getByRole('tab', { name: 'Plugin configuration', exact: true }).click()
  await page.locator('[data-paper-library-settings]').waitFor()
}
const defaults = { auto_analysis: false, analysis_fill: false, 'auto-paper-conversation': false, 'reading-panel-side': 'left' }
async function nativeValue(page, key) {
  const locator = page.locator(`#paper-library-setting-${key}`)
  return key === 'reading-panel-side' ? locator.inputValue() : locator.isChecked()
}
async function ownValue(page, key) {
  const locator = page.locator(`#setting-${key}`)
  return key === 'reading-panel-side' ? locator.inputValue() : locator.isChecked()
}
async function openOwnSettings() {
  const page = await newPage()
  await page.goto(`${host.origin}/api/paper-library/`); await page.waitForLoadState('networkidle')
  await page.locator('#settings-open').click(); await page.locator('#library-settings').waitFor()
  await until(() => page.locator('#setting-reading-panel-side').isEnabled(), Boolean, 'own settings writable')
  return page
}

try {
  const local = relative(join(project, '.local'), templateHome)
  assert.ok(local && !local.startsWith('..') && !local.startsWith('/'), 'Dedicated ignored test home required')
  assert.match(profile, /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/)
  const templateProfile = join(templateHome, 'profiles', profile), fixtureProfile = join(home, 'profiles', profile)
  await access(join(templateProfile, 'package.json')); await mkdir(fixtureProfile, { recursive: true }); await mkdir(library, { recursive: true })
  for (const name of ['package.json', 'cordis.yml', 'cordis.patch.yml']) await copyFile(join(templateProfile, name), join(fixtureProfile, name))
  await symlink(join(templateProfile, 'node_modules'), join(fixtureProfile, 'node_modules'), 'dir')
  // Legacy values deliberately equal safe defaults: migration can be proven without auto-running anything.
  const store = createLocalStateStore({ library, home })
  await store.put('preferences', { auto_analysis: 'false', analysis_fill: false, 'auto-paper-conversation': 'false', 'reading-panel-side': 'left', fixture_extra: 'preserve' }, 0)
  host = await startHost()
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright'); browser = await chromium.launch({ headless: true })
  let page = await newPage()
  await writeFile(join(run, 'initial-dom.txt'), await page.locator('body').innerText())
  await writeFile(join(run, 'initial-buttons.json'), JSON.stringify(await page.locator('button').evaluateAll(nodes => nodes.map(n => ({text:n.innerText,title:n.title,label:n.getAttribute('aria-label')}))), null, 2))
  if (process.argv.includes('--recon')) {
    console.log(JSON.stringify({ run: relative(project, run), body: await page.locator('body').innerText() }))
    await openSettings(page)
    await page.screenshot({ path: join(run, 'native-settings-recon.png') })
    console.log(JSON.stringify({ settings: await page.getByRole('dialog').innerText() }))
  } else {
    const initial = await api(page, { action: 'settings_get' })
    assert.equal(initial.backend, 'dsh'); assert.equal(initial.available, true); assert.equal(initial.writable, true)
    assert.deepEqual(initial.value, defaults)
    const migrated = await store.get('settings.migration:paper-library'), backup = await store.get('settings.backup:paper-library')
    assert.equal(migrated.value.namespace, 'paper-library')
    assert.deepEqual([...migrated.value.imported_fields].sort(), Object.keys(defaults).sort())
    assert.equal(backup.value.auto_analysis, 'false'); assert.equal(backup.value.fixture_extra, 'preserve')
    record('legacy-preferences-migrate-to-native-namespace-with-safe-defaults-and-recovery-copy')
    await openSettings(page)
    for (const [key, value] of Object.entries(defaults)) assert.equal(await nativeValue(page, key), value)
    await page.getByRole('tab', { name: 'Plugin list', exact: true }).click()
    await page.getByRole('searchbox', { name: 'Search plugins', exact: true }).fill('@mappedinfo/dsh-paper-library')
    const pluginEntry = page.locator('[data-plugin-module="@mappedinfo/dsh-paper-library"]')
    await pluginEntry.waitFor(); assert.match(await pluginEntry.innerText(), /paper-library/)
    await page.getByRole('tab', { name: 'Plugin configuration', exact: true }).click()
    await page.locator('[data-paper-library-settings]').waitFor()
    record('official-plugin-inventory-lists-library-and-configuration-tab-renders-native-keyed-card')
    await page.locator('#paper-library-setting-reading-panel-side').selectOption('right')
    await until(() => api(page, { action: 'settings_get' }), value => value.value['reading-panel-side'] === 'right', 'native sidebar write')
    const ownPage = await openOwnSettings()
    assert.equal(await ownValue(ownPage, 'reading-panel-side'), 'right')
    await ownPage.locator('#setting-reading-panel-side').selectOption('left')
    await until(() => nativeValue(page, 'reading-panel-side'), value => value === 'left', 'own settings update native scope live')
    record('sidebar-edits-in-both-entry-points-share-one-native-value-without-native-page-reload')
    for (const key of ['auto_analysis', 'analysis_fill', 'auto-paper-conversation']) {
      await page.bringToFront(); await page.locator(`#paper-library-setting-${key}`).check()
      await until(() => api(page, { action: 'settings_get' }), value => value.value[key] === true, `native ${key} saved`)
      await ownPage.bringToFront()
      await until(() => ownValue(ownPage, key), value => value === true, `own ${key} follows native on focus`)
      await ownPage.locator(`#setting-${key}`).uncheck()
      await until(() => nativeValue(page, key), value => value === false, `native ${key} follows own write`)
    }
    assert.deepEqual((await api(page, { action: 'settings_get' })).value, defaults)
    record('all-automation-options-sync-native-to-visible-library-settings-and-library-to-native-live')
    for (const width of [511, 900]) {
      await ownPage.setViewportSize({ width, height: 760 })
      assert.equal(await ownPage.locator('#library-settings').evaluate(node => node.getBoundingClientRect().right <= innerWidth && node.scrollWidth <= node.clientWidth + 1), true)
    }
    await ownPage.screenshot({ path: join(run, 'library-settings-900.png') }); screenshots.push(relative(project, join(run, 'library-settings-900.png')))
    await page.bringToFront(); await page.locator('[data-paper-library-settings]').screenshot({ path: join(run, 'native-settings-card.png') }); screenshots.push(relative(project, join(run, 'native-settings-card.png')))
    record('own-settings-fit-narrow-and-wide-browser-and-native-card-renders-dsh-themed-controls')
    await ownPage.bringToFront(); await ownPage.locator('#setting-reading-panel-side').selectOption('right')
    await until(() => api(page, { action: 'settings_get' }), value => value.value['reading-panel-side'] === 'right', 'persist side for restoration')
    await ownPage.locator('#setting-analysis_fill').check()
    await until(() => api(page, { action: 'settings_get' }), value => value.value.analysis_fill === true, 'persist fill for restoration')
    const restoredBrowser = await openOwnSettings()
    assert.equal(await ownValue(restoredBrowser, 'analysis_fill'), true)
    assert.equal(await ownValue(restoredBrowser, 'reading-panel-side'), 'right')
    const nativeFile = await readFile(join(home, 'settings.yaml'), 'utf8')
    assert.match(nativeFile, /paper-library:/)
    assert.equal((await store.get('preferences')).value.fixture_extra, 'preserve')
    record('another-browser-recovers-host-file-settings-without-browser-storage-or-library-scanning')
    const observation = await (await page.context().request.get(`${host.origin}/api/paper-chat-fixture`)).json()
    assert.equal(observation.generations, 0)
    await Promise.all(browser.contexts().map(context => context.close())); await stopHost(); host = await startHost()
    page = await newPage(); await openSettings(page)
    assert.equal(await nativeValue(page, 'analysis_fill'), true)
    assert.equal(await nativeValue(page, 'reading-panel-side'), 'right')
    const restored = await api(page, { action: 'settings_get' }); assert.equal(restored.value.analysis_fill, true)
    await page.locator('[data-paper-library-settings]').getByRole('button', { name: 'Restore defaults', exact: true }).click()
    await until(() => api(page, { action: 'settings_get' }), value => JSON.stringify(value.value) === JSON.stringify({...defaults,auto_analysis:true,analysis_fill:true}), 'native reset defaults')
    assert.equal((await store.get('preferences')).value.fixture_extra, 'preserve')
    assert.equal((await (await page.context().request.get(`${host.origin}/api/paper-chat-fixture`)).json()).generations, 0)
    record('host-restart-restores-native-settings-and-reset-preserves-unrelated-preferences-with-zero-model-calls')
    assert.deepEqual(browserErrors, []); assert.deepEqual(external, [])
    report = { verified_at: new Date().toISOString(), ok: true, checks, browser_errors: browserErrors, external_requests: external,
      model_generations: 0, external_model_requests: 0, private_documents_read: 0, library_browser_storage_writes: 0,
      screenshots, scope: 'Actual Chromium and isolated native DSH settings-file provider; official Plugins inventory/card and authenticated standalone library settings page. Empty synthetic library; no model generation.',
      limitations: ['Native reading iframe invalidation protocol is unit-tested separately; this walkthrough verifies visible library settings refresh and native reactive scope, not an active PDF reading pane.'] }
  }
} catch (error) {
  if (browser) for (const page of browser.contexts().flatMap(context => context.pages())) {
    await page.screenshot({ path: join(run, `failure-${Date.now()}.png`) }).catch(() => {})
    await writeFile(join(run, 'failure-dom.txt'), await page.locator('body').innerText()).catch(() => {})
  }
  report = { verified_at: new Date().toISOString(), ok: false, checks, error: error.message, external_model_requests: 0 }
  process.exitCode = 1; console.error(error)
} finally {
  clearTimeout(timer); await browser?.close(); await stopHost()
  await writeFile(join(run, 'host.log'), logs.replace(/token=[^\s&]+/g, 'token=<redacted>'))
  if (report) await writeFile(reportPath, JSON.stringify({ ...report, isolated_hosts_stopped: true }, null, 2) + '\n')
}
