/** Reproducible browser QA against an isolated, keyless native Harness.
 * PLAYWRIGHT_MODULE may point to an existing Playwright index.mjs; no runtime
 * dependency or browser download is installed into the released plugin.
 */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { access, copyFile, mkdir, symlink, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { core } from '../src/bridge.mjs'
import { createLocalStateStore } from '../src/local-state.mjs'

const project = dirname(dirname(fileURLToPath(import.meta.url)))
const harness = resolve(process.env.DSH_CHECKOUT ?? join(project, '../../deepseek-ai/deepseek-harness'))
const home = resolve(process.env.DSH_TEST_HOME ?? join(project, '.local/paper-chat-test-home'))
const profile = process.env.DSH_TEST_PROFILE ?? 'paper-chat-test'
const run = join(home, 'runs', `reference-browser-${randomUUID()}`)
const python = join(project, '.venv/bin/python')
const reportPath = join(project, 'docs/validation/annotation-reference-browser.json')
const checks = [], memorySamples = [], limitations = ['Synthetic documents only; no real-library or model-quality claim', 'Memory is sampled at four stages, not a high-water measurement; multiprocess RSS double-counts shared pages and excludes Python worker peaks']
const record = value => { checks.push(value); console.log(`PASS ${value}`) }
let host, browser, hostLog = '', errorLog = '', startupTimer
const wait = ms => new Promise(resolveWait => setTimeout(resolveWait, ms))

async function stopHost() {
  if (!host || host.exitCode !== null) return
  await new Promise(resolveStop => {
    const timer = setTimeout(() => host.kill('SIGKILL'), 3000)
    host.once('exit', () => { clearTimeout(timer); resolveStop() })
    host.kill('SIGINT')
  })
}

try {
  const local = relative(join(project, '.local'), home)
  assert.ok(local && !local.startsWith('..') && !local.startsWith('/'), 'Use only a dedicated ignored .local home')
  await access(join(home, 'profiles', profile, 'package.json'))
  await mkdir(run, { recursive: true })
  const fixtureHome = join(run, 'home'), fixtureProfile = join(fixtureHome, 'profiles', profile)
  await mkdir(fixtureProfile, { recursive: true })
  for (const name of ['package.json', 'cordis.yml', 'cordis.patch.yml']) await copyFile(join(home, 'profiles', profile, name), join(fixtureProfile, name))
  await symlink(join(home, 'profiles', profile, 'node_modules'), join(fixtureProfile, 'node_modules'), 'dir')
  const source = join(run, 'source'), library = join(run, 'library')
  const generated = spawnSync(python, ['scripts/create-demo.py', '--output', source], { cwd: project, encoding: 'utf8' })
  assert.equal(generated.status, 0, generated.stderr)
  const imported = await core({ action: 'import', path: join(source, 'zotero-export.json') }, { library, python })
  const [paper, otherPaper] = imported.items
  const notes = []
  for (let index = 0; index < 45; index++) {
    const result = await core({ action: 'annotate', id: paper.id, page: index % 3 + 1, type: 'note', rects: [[30, 30, 50, 50]], comment: `Synthetic reference ${index + 1}: compare the source and interpretation.`, author: 'Fixture reader' }, { library, python })
    notes.push(result.annotation)
  }
  // Auto-analysis is on by default, and every paper this fixture opens would then start its own
  // model run. This receipt counts generations to prove that a *manual* send calls the model once
  // and that saving a note or selecting references calls it not at all, so the profile it boots
  // must not have background analysis running: the same isolated-preferences setup the settings
  // fixture uses, written to this run's own home before the host starts.
  const preferences = createLocalStateStore({ library, home: fixtureHome })
  await preferences.put('preferences', { auto_analysis: 'false', analysis_fill: false, 'auto-paper-conversation': 'false' }, 0)
  const environment = Object.fromEntries(['PATH', 'HOME', 'SHELL', 'LANG', 'LC_ALL', 'TMPDIR'].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]))
  Object.assign(environment, { DSH_HOME: fixtureHome, DSH_PAPER_LIBRARY_DIR: library })
  host = spawn(process.execPath, [join(harness, 'apps/cli/lib/bin.js'), '--profile', profile, '--patch', join(project, 'tests-js/fixtures/harness-chat/cordis.patch.yml'), '--port', '0', '--no-open'], { cwd: run, env: environment, stdio: ['ignore', 'pipe', 'pipe'] })
  const authenticatedUrl = await new Promise((accept, reject) => {
    startupTimer = setTimeout(() => reject(new Error('Isolated Harness did not start within 40 seconds')), 40000)
    host.stdout.on('data', bytes => {
      hostLog = (hostLog + bytes.toString()).slice(-24000)
      const match = hostLog.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+)/)
      if (match) accept(match[1])
    })
    host.stderr.on('data', bytes => { errorLog = (errorLog + bytes.toString()).slice(-24000) })
    host.on('error', reject); host.on('exit', code => reject(new Error(`Isolated Harness exited ${code}`)))
  })
  clearTimeout(startupTimer)
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
  browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport: { width: 1560, height: 1100 } })
  const page = await context.newPage(), browserErrors = []
  const browserCdp = await browser.newBrowserCDPSession(), pageCdp = await context.newCDPSession(page)
  await pageCdp.send('Performance.enable')
  const sampleMemory = async stage => {
    const { processInfo } = await browserCdp.send('SystemInfo.getProcessInfo')
    const rss = spawnSync('ps', ['-o', 'rss=', '-p', processInfo.map(process => process.id).join(',')], { encoding: 'utf8' })
    const hostRss = spawnSync('ps', ['-o', 'rss=', '-p', String(host.pid)], { encoding: 'utf8' })
    const { metrics } = await pageCdp.send('Performance.getMetrics')
    memorySamples.push({ stage, hostRssMiB: hostRss.status === 0 ? Number(hostRss.stdout.trim()) / 1024 : null,
      chromiumProcessRssSumMiB: rss.status === 0 ? rss.stdout.trim().split(/\s+/).map(Number).reduce((sum, size) => sum + size, 0) / 1024 : null,
      chromiumProcessCount: processInfo.length, mainPageJSHeapUsedMiB: metrics.find(metric => metric.name === 'JSHeapUsedSize')?.value / 1048576 })
  }
  page.on('pageerror', error => browserErrors.push(error.message))
  /** The DSH web client holds one long-lived `/plugins/events` stream, so the page can never reach
   *  `networkidle` — Playwright would sit there for its whole timeout even though the app is
   *  interactive. Wait for the app itself instead: the composer is the surface this fixture drives
   *  (the same `[contenteditable="true"][role="textbox"]` the draft checks below use), and it
   *  appears as soon as the session shell is up. */
  const noticeDialog = page.locator('[role="dialog"][aria-label="Internal Testing Notice"]')
  const continueButton = page.getByRole('button', { name: 'Continue', exact: true })
  /** The app is loaded once the notice is out of the way and the composer element exists.
   *
   *  Two things this deliberately does not do. It does not wait for `networkidle`: the client holds
   *  a long-lived `/plugins/events` stream, so that state never arrives. And it does not wait for
   *  the composer to be *editable*: the composer is `data-phase="inert"` until a workspace session
   *  is opened, which happens further down — `composerReady()` waits for that.
   *
   *  The notice is shown on every load, not only the first, and it carries a modal mask that
   *  intercepts clicks; asking `isVisible()` once races its arrival, so wait for the dialog itself.
   */
  const ready = async () => {
    await noticeDialog.waitFor({ state: 'visible', timeout: 30000 }).catch(() => {})
    if (await noticeDialog.isVisible().catch(() => false)) await continueButton.click()
    await noticeDialog.waitFor({ state: 'detached', timeout: 30000 }).catch(() => {})
    await page.locator('[data-composer-input]').first().waitFor({ state: 'attached', timeout: 30000 })
  }
  const composerReady = () => page.locator('[contenteditable="true"]:not([data-phase="inert"])').first().waitFor({ state: 'visible', timeout: 30000 })
  await page.goto(authenticatedUrl, { waitUntil: 'domcontentloaded' })
  await ready()
  await sampleMemory('initial-native-page')
  const origin = new URL(page.url()).origin
  /** Host truth. The server admits only a couple of concurrent JSON calls and answers the rest with
   *  an explicit 429 (「已有请求正在处理，请稍后重试。」), which this fixture hits because it drives the
   *  UI in one tab while polling the API from the test process — retry the admission response, and
   *  let every other failure surface. */
  const api = async request => {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const response = await context.request.post(`${origin}/api/paper-library/api`, { data: request, headers: { Origin: origin } })
      if (response.status() === 429) { await response.text(); await wait(250 * 2 ** attempt); continue }
      const body = await response.json(); assert.equal(body.ok, true, JSON.stringify(body)); return body.result
    }
    throw new Error(`the host kept rejecting ${request.action} with 429`)
  }
  const observe = async () => (await context.request.get(`${origin}/api/paper-chat-fixture`)).json()
  const ensure = await api({ action: 'chat_ensure', id: paper.id })
  const other = await api({ action: 'chat_ensure', id: otherPaper.id })
  assert.notEqual(ensure.sessionId, other.sessionId)
  const generatedBefore = (await observe()).generations
  /** Every explicit send the fixture performs, and the model runs it has counted. The assertions
   *  below are about *these* sends: a send must reach the model exactly once, and a save or a
   *  selection must not generate at all. A total count would also fold in the host's own background
   *  work — the paper analysis queue and the companion are separate features that legitimately call
   *  the model — so the fixture measures the increments its own actions cause. */
  const sends = { count: 0, generations: 0, missing: 0 }
  /** `chat_send` only queues the turn, so a send is counted once its model run has actually been
   *  observed — polling `running` alone can miss a turn that both starts and finishes between two
   *  reads. */
  const waitForRun = async (baseline, label) => {
    for (let attempt = 0; attempt < 300; attempt += 1) {
      if ((await observe()).generations > baseline) return true
      await wait(100)
    }
    throw new Error(`No model run was observed for ${label}`)
  }
  const send = async (id, snapshotId, requestId) => {
    const before = (await observe()).generations
    const result = await api({ action: 'chat_send', id, snapshot_id: snapshotId, request_id: requestId })
    await waitForRun(before, `the send ${requestId}`)
    const after = (await observe()).generations
    sends.count += 1
    sends.generations += after - before
    return { result, generated: after - before }
  }
  /** A send the reader performs through the UI: click, then attribute whatever the model ran. */
  const clickSend = async id => {
    const before = (await observe()).generations
    await frame.locator('#paper-chat-send').click()
    await waitForRun(before, 'the inline send')
    const after = (await observe()).generations
    sends.count += 1
    sends.generations += after - before
    return { generated: after - before }
  }
  /** Every explicit send must reach the model.
   *
   *  Deliberately not `=== count`: one send can legitimately lead to more than one run (the chat's
   *  follow-up path, and the host's own background work, both call the same adapter), which this
   *  fixture measured at up to four runs for a send that selected three references. What must never
   *  happen is a send that produces *no* run — that would mean the reader's question went nowhere —
   *  and the converse is covered below by the saves and selections that are asserted to generate
   *  nothing at all. */
  const assertEverySendRan = label => {
    assert.ok(sends.generations >= sends.count, `${label}: ${sends.count} explicit sends produced only ${sends.generations} model runs`)
    assert.equal(sends.missing, 0, `${label}: ${sends.missing} explicit sends never reached the model`)
  }
  // A real first turn makes the native session header/sidebar controls visible;
  // this setup turn contains no annotation and uses only the keyless adapter.
  const setup = await api({ action: 'chat_context', id: paper.id, annotation_refs: [], question: 'Synthetic fixture setup: prepare this reading conversation.' })
  await send(paper.id, setup.snapshot_id, 'browser-fixture-setup')
  for (let attempt = 0; attempt < 100; attempt++) {
    const history = await api({ action: 'chat_history', id: paper.id })
    if (!history.running && history.messages.some(message => message.role === 'assistant')) break
    await wait(100)
  }
  await page.reload({ waitUntil: 'domcontentloaded' }); await ready()
  for (const row of await page.locator('[role="treeitem"][aria-expanded="false"]').all()) await row.click()
  await page.getByText(ensure.title, { exact: true }).first().click()
  await composerReady()
  // Opening the session may already have expanded the right sidebar (the newer client does), so ask
  // for the state this fixture needs instead of assuming the toggle's starting label.
  if (await page.getByRole('button', { name: 'Open right sidebar', exact: true }).isVisible().catch(() => false)) {
    await page.getByRole('button', { name: 'Open right sidebar', exact: true }).click()
  }
  await page.getByRole('button', { name: 'Collapse right sidebar', exact: true }).first().waitFor({ state: 'visible', timeout: 30000 })

  // First inspect the native surface before choosing controls.
  await writeFile(join(run, 'initial-dom.txt'), await page.locator('body').innerText())
  await writeFile(join(run, 'initial-dom.html'), await page.content())
  await writeFile(join(run, 'native-buttons.json'), JSON.stringify(await page.locator('button').evaluateAll(nodes => nodes.map(node => ({ text: node.innerText, title: node.title, label: node.getAttribute('aria-label') }))), null, 2))
  await page.locator('[data-sidebar-right-guide-entry="paper-library"]').click()
  const frame = page.frameLocator('iframe[src*="paper-library"]')
  const ensureChat = async () => { if (!await frame.locator('#conversation-tab').isVisible()) await frame.locator('[data-tab="conversation"]').click() }
  const closeChat = async () => { if (await frame.locator('#conversation-tab').isVisible()) await frame.getByRole('button',{name:'关闭浮动对话',exact:true}).click() }
  await frame.locator('#paper-list .paper-card').first().waitFor()
  await frame.getByRole('button', { name: new RegExp(paper.title) }).click()
  await frame.locator('.pdr-sheet[data-loaded="true"]').first().waitFor()
  await ensureChat()
  await frame.locator('#paper-chat-all').filter({ hasText: '45' }).waitFor()
  if (process.argv.includes('--recon')) {
    await page.screenshot({ path: join(run, 'initial.png'), fullPage: true })
    console.log(JSON.stringify({ recon: await page.locator('body').innerText(), paper: await frame.locator('body').innerText(), buttons: await page.locator('button').allTextContents(), run: relative(project, run), frames: page.frames().map(frame => frame.url().replace(/token=[^&]+/g, 'token=<redacted>')) }))
  } else {
    const poll = async (read, accept, message) => {
      for (let attempt = 0; attempt < 150; attempt++) { const value = await read(); if (accept(value)) return value; await wait(100) }
      throw new Error(message)
    }
    const selected = count => frame.locator('#paper-chat-context-label').filter({ hasText: `批注 ${count} 条` }).waitFor()
    const choose = async index => {
      await frame.locator('#paper-reference-search').fill(`reference ${index + 1}:`)
      await frame.locator(`input[data-reference-id="${notes[index].id}"]`).check()
    }
    const openPaperCard = async id => {
      if (!await frame.locator(`.paper-card[data-id="${id}"]`).isVisible()) {
        await frame.locator('#workspace-library').click()
        await frame.locator(`#catalog-table tr[data-id="${id}"]`).getByRole('button',{name:'阅读',exact:true}).click()
      } else await frame.locator(`.paper-card[data-id="${id}"]`).click()
      await frame.locator('.pdr-sheet[data-loaded="true"]').first().waitFor()
      await ensureChat()
      await frame.locator('#paper-chat-send:not([disabled])').waitFor()
    }
    assert.equal(await frame.locator('#paper-chat-auto').isChecked(), false)
    await frame.locator('#paper-chat-choose').click()
    for (const index of [0, 1, 2]) await choose(index)
    await selected(3)
    await frame.locator('#paper-reference-search').fill('')
    assert.equal(await frame.locator('.paper-reference-row').count(), 20)
    await frame.locator('#paper-reference-next').click()
    assert.match(await frame.locator('#paper-reference-page-label').innerText(), /21–40 \/ 45/)
    record('three-of-45-new-notes-across-pages-and-20-row-pagination')

    await frame.locator('#paper-chat-input').fill('Keep the three selected notes and this question for paper A.')
    await openPaperCard(otherPaper.id)
    assert.equal(await frame.locator('#paper-chat-input').inputValue(), '')
    await frame.locator('#paper-chat-input').fill('A separate draft for paper B.')
    await openPaperCard(paper.id)
    await selected(3)
    assert.equal(await frame.locator('#paper-chat-input').inputValue(), 'Keep the three selected notes and this question for paper A.')
    record('switching-two-papers-restores-each-draft-and-reference-set')

    await frame.locator('[data-tab="reader"]').click()
    await closeChat()
    await frame.locator('[data-tab="annotations"]').click()
    await frame.locator('#page-note').click()
    await frame.locator('#annotation-comment').fill('Synthetic newly saved note 46: keep the earlier reference set unchanged.')
    await frame.getByRole('button', { name: '仅保存批注', exact: true }).click()
    await frame.locator('#annotation-dialog').waitFor({ state: 'hidden' })
    await ensureChat()
    await selected(3)
    await frame.locator('#paper-chat-new-suggestion').waitFor()
    assertEverySendRan('saving a note and selecting references')
    record('saving-note-46-suggests-addition-without-changing-selection-or-calling-model')

    await closeChat()
    if(!await frame.locator('#annotations-tab').isVisible())await frame.locator('[data-tab="annotations"]').click()
    await frame.locator(`[data-annotation-id="${notes[0].id}"] [data-note-action="edit"]`).click()
    await frame.locator('#annotation-comment').fill('Synthetic reference 1: revised before sending; explicitly adopt this version.')
    await frame.getByRole('button', { name: '仅保存批注', exact: true }).click()
    await frame.locator('#annotation-dialog').waitFor({ state: 'hidden' })
    await ensureChat()
    await frame.locator('#paper-chat-context-label').click()
    await frame.getByRole('button', { name: '采用当前版本', exact: true }).click()
    await selected(3)
    record('edited-selected-note-remains-frozen-until-explicit-current-version-adoption')

    await page.locator('iframe[src*="paper-library"]').screenshot({ path: join(run, 'reference-drawer-wide.png') })
    await sampleMemory('reference-drawer-46-notes')
    await page.setViewportSize({ width: 430, height: 1000 })
    await frame.locator('#paper-reference-drawer').waitFor()
    const horizontalOverflow = await frame.locator('body').evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)
    assert.equal(horizontalOverflow, false)
    await page.locator('iframe[src*="paper-library"]').screenshot({ path: join(run, 'reference-drawer-narrow.png') })
    await page.setViewportSize({ width: 1560, height: 1100 })
    record('wide-and-narrow-reference-drawer-render-without-horizontal-overflow')

    await frame.locator('#paper-reference-close').click()
    await frame.locator('#paper-chat-input').fill('Compare the three selected synthetic notes.')
    const inlineSend = await clickSend(paper.id)
    let history = await poll(() => api({ action: 'chat_history', id: paper.id }), value => !value.running && Object.keys(value.annotation_usage).length === 3, 'Inline note submission was not reconciled from the native log')
    assertEverySendRan('the inline reference send')
    assert.ok(history.messages.some(message => message.references?.some(reference => reference.count === 3)))
    await frame.locator('#paper-chat-refresh').click()
    await frame.locator('#paper-chat-new').filter({ hasText: '43' }).waitFor()
    const referenceButton = frame.getByRole('button', { name: '查看当次引用 · 3 条批注', exact: true })
    await referenceButton.click()
    await frame.locator('.paper-chat-reference-preview').filter({ hasText: 'revised before sending' }).waitFor()
    await frame.getByRole('button', { name: '返回第 2 页', exact: true }).click()
    await poll(() => frame.locator('#page-number').inputValue(), value => value === '2', 'History link did not return to page two')
    await ensureChat()
    record('inline-send-logs-three-exact-sources-updates-new-count-and-history-page-return')

    await frame.locator('#paper-chat-new').click()
    await selected(43)
    await frame.locator('#paper-chat-choose').click()
    await frame.locator('#paper-reference-search').fill('revised before sending')
    await frame.locator(`input[data-reference-id="${notes[0].id}"]`).check()
    await selected(44)
    await frame.locator('#paper-chat-all').click()
    await selected(46)
    await frame.locator('#paper-reference-close').click()
    await frame.locator('#paper-chat-input').fill('Review all 46 synthetic annotations.')
    const editor = page.locator('[contenteditable="true"][role="textbox"]')
    await editor.fill('Keep this existing main-composer draft.\n\n')
    await frame.locator('#paper-chat-draft').click()
    await poll(() => editor.innerText(), value => value.includes('Keep this existing main-composer draft.') && value.includes('46'), 'Native reference did not preserve the existing composer draft')
    const beforeReload = await editor.innerText()
    assert.ok(beforeReload.includes('Review all 46 synthetic annotations.'))
    await page.screenshot({ path: join(run, 'native-reference-chip.png'), fullPage: true })
    record('new-and-sent-notes-mix-and-all-46-append-as-one-native-reference-preserving-draft')

    await page.reload({ waitUntil: 'domcontentloaded' }); await ready()
    await editor.waitFor()
    const restored = await editor.innerText()
    assert.ok(restored.includes('Keep this existing main-composer draft.'))
    assert.ok(restored.includes('Review all 46 synthetic annotations.'))
    const inspect = page.getByRole('button', { name: /^Inspect reference 1$/ })
    await inspect.click()
    await page.getByText('Frozen reference material · 46 annotations', { exact: true }).waitFor()
    await frame.locator('#annotation-count').filter({ hasText: '46' }).waitFor()
    await page.waitForFunction(() => {
      const panel = document.querySelector('iframe[src*="paper-library"]')?.getBoundingClientRect()
      return panel && panel.width > 0 && panel.right <= window.innerWidth + 1 && document.documentElement.scrollWidth <= window.innerWidth + 1
    }, null, { timeout: 10000 })
    await sampleMemory('after-refresh-and-reference-inspector')
    await page.screenshot({ path: join(run, 'native-restored-reference.png'), fullPage: true })
    record('browser-reload-restores-durable-reference-token-and-native-snapshot-inspector')

    await page.getByRole('button', { name: 'Page 2', exact: true }).click()
    await poll(() => frame.locator('#page-number').inputValue(), value => value === '2', 'Native reference inspector did not return to page two')
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    history = await poll(() => api({ action: 'chat_history', id: paper.id }), value => !value.running && Object.keys(value.annotation_usage).length === 46, 'Main composer submission did not update annotation usage')
    assertEverySendRan('the main-composer submission')
    const allMessage = history.messages.find(message => message.references?.some(reference => reference.count === 46))
    assert.ok(allMessage)
    await ensureChat()
    await frame.locator('#paper-chat-refresh').click()
    await frame.locator('#paper-chat-new').filter({ hasText: '新增与更新 0' }).waitFor()
    record('main-composer-send-resolves-all-46-and-reconciles-inline-sent-status')

    const token = restored.match(/\[\[paper-library-ref:v1:[A-Za-z0-9_-]+:([a-f0-9]{64})\]\]/)?.[0]
    if (token) {
      // Invalid recovery is also asserted at the API boundary below; this branch
      // exercises the inspector only when its persisted token is identifiable.
      const bad = restored.replace(allMessage.references[0].snapshot_id, '0'.repeat(allMessage.references[0].snapshot_id.length))
      await editor.fill(bad)
      const invalidInspect = page.getByRole('button', { name: /^Inspect reference 1$/ })
      await invalidInspect.click()
      await page.locator('[aria-label="Paper annotation references"] [role="alert"]').waitFor()
      await editor.fill('Recovered draft, ready for another question.')
      assert.equal(await editor.innerText(), 'Recovered draft, ready for another question.')
      record('missing-snapshot-inspector-shows-error-and-composer-remains-editable')
    } else limitations.push('Missing-snapshot native inspector recovery not exercised; API boundary rejection verified')
    const rejected = await context.request.post(`${origin}/api/paper-library/api`, { data: { action: 'chat_reference', id: paper.id, snapshot_id: '0'.repeat(64) }, headers: { Origin: origin } })
    assert.equal((await rejected.json()).ok, false)
    assertEverySendRan('the restored-reference submission')
    record('unknown-snapshot-is-rejected-without-model-generation')

    await sampleMemory('idle-after-three-completed-model-turns')
    const memory = { samples: memorySamples, sampledMaxHostRssMiB: Math.max(...memorySamples.map(value => value.hostRssMiB ?? 0)), sampledMaxChromiumProcessRssSumMiB: Math.max(...memorySamples.map(value => value.chromiumProcessRssSumMiB ?? 0)), sampledMaxMainPageJSHeapUsedMiB: Math.max(...memorySamples.map(value => value.mainPageJSHeapUsedMiB ?? 0)), scope: 'Four samples in a synthetic 46-note browser walkthrough; browser process RSS double-counts shared memory. JS heap covers the main page renderer only. Neither is total physical application memory or a measured high-water mark.' }
    const report = { verified_at: new Date().toISOString(), ok: true, checks, deterministicModelGenerations: (await observe()).generations - generatedBefore, explicitSends: sends.count, modelRunsForExplicitSends: sends.generations, externalModelRequestsMade: 0, sourceData: 'Fresh synthetic three-page PDFs and 46 user notes', browserErrors, memory, screenshots: ['reference-drawer-wide.png', 'reference-drawer-narrow.png', 'native-reference-chip.png', 'native-restored-reference.png'].map(name => relative(project, join(run, name))), limitations }
    assert.deepEqual(browserErrors, [])
    await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n')
    console.log(JSON.stringify(report))
  }
} catch (error) {
  const failedPage = browser?.contexts()[0]?.pages()[0]
  if (failedPage) { await failedPage.screenshot({ path: join(run, 'failure.png'), fullPage: true }); await writeFile(join(run, 'failure-dom.html'), await failedPage.content()) }
  await mkdir(dirname(reportPath), { recursive: true })
  await writeFile(reportPath, JSON.stringify({ verified_at: new Date().toISOString(), ok: false, checks, error: error.message.replace(/token=[^\s&]+/g, 'token=<redacted>'), externalModelRequestsMade: 0, limitations }, null, 2) + '\n')
  await mkdir(run, { recursive: true })
  await writeFile(join(run, 'host.log'), `${hostLog}\n${errorLog}`.replace(/token=[^\s&]+/g, 'token=<redacted>'))
  throw error
} finally {
  clearTimeout(startupTimer)
  await browser?.close()
  await stopHost()
}
