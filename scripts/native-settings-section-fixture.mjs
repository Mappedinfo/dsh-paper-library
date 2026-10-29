/** Isolated native DSH settings walkthrough; no user profile, documents or model calls. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { access, copyFile, mkdir, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const project = dirname(dirname(fileURLToPath(import.meta.url)))
const harness = resolve(process.env.DSH_CHECKOUT ?? join(project, '../../deepseek-ai/deepseek-harness'))
const templateHome = resolve(process.env.DSH_TEST_HOME ?? join(project, '.local/paper-chat-test-home'))
const profile = process.env.DSH_TEST_PROFILE ?? 'paper-chat-test'
const run = join(templateHome, 'runs', `native-settings-${randomUUID()}`), home = join(run, 'home'), library = join(run, 'library')
const reportPath = process.env.NATIVE_SETTINGS_REPORT || join(tmpdir(), `paper-library-native-settings-${randomUUID()}.json`)
const checks = [], errors = [], external = []
let child, browser, host, timer, page, report
const record = value => { checks.push(value); console.log(`PASS ${value}`) }
const wait = ms => new Promise(resolveWait => setTimeout(resolveWait, ms))
async function until(read, accept, label) {
  for (let n = 0; n < 150; n++) { const value = await read(); if (accept(value)) return value; await wait(100) }
  throw new Error(`Timed out: ${label}`)
}
async function stopHost() {
  if (!child || child.exitCode !== null) return
  await new Promise(done => { const guard = setTimeout(() => child.kill('SIGKILL'), 3000); child.once('exit', () => { clearTimeout(guard); done() }); child.kill('SIGINT') })
}
async function startHost() {
  const env = Object.fromEntries(['PATH', 'HOME', 'SHELL', 'LANG', 'LC_ALL', 'TMPDIR'].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]))
  Object.assign(env, { DSH_HOME: home, DSH_PAPER_LIBRARY_DIR: library })
  child = spawn(process.execPath, [join(harness, 'apps/cli/lib/bin.js'), '--profile', profile, '--patch', join(project, 'tests-js/fixtures/harness-chat/cordis.patch.yml'), '--port', '0', '--no-open'], { cwd: run, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  const url = await new Promise((accept, reject) => {
    timer = setTimeout(() => reject(new Error('Isolated DSH host did not start within 40 seconds')), 40000)
    child.stdout.on('data', bytes => { output = (output + bytes.toString()).slice(-24000); const match = output.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+)/); if (match) accept(match[1]) })
    child.stderr.resume()
    child.on('error', reject); child.on('exit', code => reject(new Error(`Isolated DSH host exited ${code}`)))
  })
  clearTimeout(timer)
  return { url, origin: new URL(url).origin }
}
async function api(target, input) {
  const response = await target.context().request.post(`${host.origin}/api/paper-library/api`, { data: input, headers: { Origin: host.origin } })
  const body = await response.json()
  if (!response.ok() || !body.ok) throw Object.assign(new Error(`API failed: ${body.code || response.status()}`), { code: body.code })
  return body.result
}
try {
  const local = relative(join(project, '.local'), templateHome)
  assert.ok(local && !local.startsWith('..') && !local.startsWith('/'), 'Dedicated ignored test home required')
  assert.match(profile, /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/)
  const templateProfile = join(templateHome, 'profiles', profile), fixtureProfile = join(home, 'profiles', profile)
  await access(join(templateProfile, 'package.json')); await mkdir(fixtureProfile, { recursive: true }); await mkdir(library, { recursive: true })
  for (const name of ['package.json', 'cordis.yml', 'cordis.patch.yml']) await copyFile(join(templateProfile, name), join(fixtureProfile, name))
  await symlink(join(templateProfile, 'node_modules'), join(fixtureProfile, 'node_modules'), 'dir')
  host = await startHost()
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
  browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport: { width: 1512, height: 982 } })
  await context.route('**/*', async route => {
    const url = route.request().url()
    if (/^https?:/.test(url) && new URL(url).origin !== host.origin) { external.push(new URL(url).origin); await route.abort(); return }
    await route.continue()
  })
  page = await context.newPage(); page.setDefaultTimeout(15000)
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(host.url); await page.waitForLoadState('networkidle')
  const notice = page.getByRole('button', { name: 'Continue', exact: true })
  if (await notice.isVisible()) await notice.click()
  await page.getByText('More', { exact: true }).last().click()
  await page.getByText('Settings', { exact: true }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('button', { name: 'Paper Library', exact: true }).click()
  await page.locator('[data-paper-library-settings]').waitFor()
  const language = page.getByRole('region', { name: 'Language model and prompts' })
  await language.waitFor()
  const select = language.getByLabel('Model', { exact: true })
  await until(() => select.isEnabled(), Boolean, 'native language settings loaded')
  assert.match(await select.inputValue(), /^$/)
  assert.equal(await language.getByLabel('Default translation target', { exact: true }).inputValue(), 'auto')
  record('left-navigation-opens-native-library-settings-and-default-language-model')
  await page.locator('#paper-library-setting-reading-panel-side').selectOption('right')
  await until(() => api(page, { action: 'settings_get' }), result => result.value['reading-panel-side'] === 'right', 'native library preference saved')
  record('native-library-control-saves-through-shared-preferences-api')
  const initialLanguage = await api(page, { action: 'language_settings_get' })
  const fixtureModel = initialLanguage.models.find(item => item.provider === 'paper-library-native-chat-fixture' && item.id === 'deterministic-reader')
  assert.ok(fixtureModel, 'isolated deterministic model must be discoverable')
  await select.selectOption(JSON.stringify([fixtureModel.provider, fixtureModel.id]))
  const translate = language.getByLabel('Additional translation instructions')
  const polish = language.getByLabel('Additional polishing instructions')
  await translate.fill('Synthetic translation guidance')
  await polish.fill('Synthetic polishing guidance')
  await language.getByRole('button', { name: 'Save language settings' }).click()
  await language.getByRole('status').filter({ hasText: 'Language settings saved.' }).waitFor()
  let value = await api(page, { action: 'language_settings_get' })
  assert.equal(value.value.translate_prompt, 'Synthetic translation guidance')
  assert.equal(value.value.polish_prompt, 'Synthetic polishing guidance')
  assert.deepEqual(value.value.model, { provider: fixtureModel.provider, model: fixtureModel.id })
  record('native-model-and-prompts-save-to-the-shared-language-settings-api')
  const own = await context.newPage(); own.setDefaultTimeout(15000)
  own.on('pageerror', error => errors.push(error.message))
  await own.goto(`${host.origin}/api/paper-library/`); await own.waitForLoadState('networkidle')
  await own.locator('#settings-open').click()
  await own.locator('#settings-language').click()
  await own.locator('#language-settings').waitFor()
  await until(() => own.locator('#language-settings-save').isEnabled(), Boolean, 'library language settings loaded')
  assert.equal(await own.locator('#language-settings-translate').inputValue(), 'Synthetic translation guidance')
  await own.locator('#language-settings-translate').fill('Synthetic second-window change')
  await own.locator('#language-settings-save').click()
  await until(() => api(page, { action: 'language_settings_get' }), result => result.value.translate_prompt === 'Synthetic second-window change', 'library language setting saved')
  record('library-language-window-reads-and-updates-the-same-settings')
  await page.bringToFront()
  await translate.fill('Unsaved native draft')
  await language.getByRole('button', { name: 'Save language settings' }).click()
  await language.getByRole('alert').filter({ hasText: 'Settings changed in another window' }).waitFor()
  assert.equal(await translate.inputValue(), 'Unsaved native draft')
  assert.equal((await api(page, { action: 'language_settings_get' })).value.translate_prompt, 'Synthetic second-window change')
  record('concurrent-save-conflict-retains-native-draft-and-does-not-overwrite-shared-value')
  await language.getByRole('button', { name: 'Reload (discard unsaved changes here)' }).click()
  await until(() => translate.inputValue(), result => result === 'Synthetic second-window change', 'explicit native reload')
  await own.locator('#language-settings-translate').fill('Synthetic reopened change')
  await own.locator('#language-settings-save').click()
  await until(() => api(page, { action: 'language_settings_get' }), result => result.value.translate_prompt === 'Synthetic reopened change', 'second window later update')
  await dialog.getByRole('button', { name: 'General', exact: true }).click()
  await dialog.getByRole('button', { name: 'Paper Library', exact: true }).click()
  await until(() => translate.inputValue(), result => result === 'Synthetic reopened change', 'native remount refresh')
  record('explicit-reload-and-clean-remount-read-latest-language-settings')
  await page.screenshot({ path: join(run, 'native-settings-section.png') })
  const observation = await (await context.request.get(`${host.origin}/api/paper-chat-fixture`)).json()
  assert.equal(observation.generations, 0)
  assert.deepEqual(errors, []); assert.deepEqual(external, [])
  report = { ok: true, checks, browser_errors: errors, external_requests: external, model_generations: 0, private_documents_read: 0, screenshot: join(run, 'native-settings-section.png'), viewport: '1512x982' }
} catch (error) {
  await page?.screenshot({ path: join(run, 'failure.png') }).catch(() => {})
  await writeFile(join(run, 'failure-dom.txt'), await page?.locator('body').innerText().catch(() => '') || '').catch(() => {})
  report = { ok: false, checks, error: error.message.replace(/token=[^\s&]+/gi, 'token=<redacted>'), browser_errors: errors, external_requests: external, run }
  process.exitCode = 1
} finally {
  clearTimeout(timer)
  await browser?.close().catch(() => {})
  await stopHost()
  report = { ...report, isolated_host_stopped: !child || child.exitCode !== null || child.signalCode !== null }
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ report: reportPath, ok: report.ok, checks: checks.length, isolated_host_stopped: report.isolated_host_stopped }))
}
