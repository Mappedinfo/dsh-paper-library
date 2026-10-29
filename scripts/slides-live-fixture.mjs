/**
 * Isolated, synthetic Slides acceptance against an already-running DSH service.
 *
 * DSH_TEST_LAUNCH_URL is obtained by the caller in memory. Never log it, the
 * authentication cookie, existing project data, or response bodies. The test
 * opens a new headless browser context and does not touch the user's tabs.
 * Its list response is restricted to projects created by this process.
 *
 * PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs \
 * DSH_TEST_LAUNCH_URL='<provided privately>' node scripts/slides-live-fixture.mjs
 */
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { deflateSync } from 'node:zlib'
import JSZip from 'jszip'

const launch = process.env.DSH_TEST_LAUNCH_URL
if (!launch) throw new Error('需要通过 DSH_TEST_LAUNCH_URL 提供当前服务的授权入口。')
const modulePath = process.env.PLAYWRIGHT_MODULE || 'playwright'
const base = await mkdtemp(join(tmpdir(), 'paper-library-slides-live-'))
const output = join(base, 'report.json')
const prefix = `Slides 浏览器验收（合成） ${randomUUID().slice(0, 8)}`
const titles = [`${prefix} 主项目`, `${prefix} 切换项目`]
const projects = [], checks = [], contrastChecks = [], browserErrors = [], apiFailures = [], blockedRequests = [], routeErrors = [], cleanupErrors = []
const allowedIds = new Set()
let browser, context, page, phase = '初始化', failure = null, completed = false, tearingDown = false
class FixtureError extends Error {}

async function report(ok = false) {
  const result = { ok, output, phase, checks, contrastChecks, projects, retained: projects[0] || null, cleanupCandidates: projects.slice(1), browserErrors, apiFailures, blockedRequests, routeErrors, cleanupErrors, ...(failure ? { failure } : {}) }
  await writeFile(output, `${JSON.stringify(result, null, 2)}\n`)
  return result
}
async function done(name) { checks.push(name); await report() }
const errorCode = value => typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,60}$/.test(value) ? value : ''
const until = async (read, accept, label, attempts = 150) => {
  for (let index = 0; index < attempts; index++) {
    const value = await read()
    if (accept(value)) return value
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new FixtureError(`等待失败：${label}`)
}
function check(condition, message) { if (!condition) throw new FixtureError(message) }
function assertOwned(id) { if (!allowedIds.has(id)) throw new FixtureError('拒绝访问非本脚本创建的项目。') }
function syntheticPng() {
  const crc = data => {
    let value = 0xffffffff
    for (const byte of data) { value ^= byte; for (let bit = 0; bit < 8; bit++) value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1 }
    return (value ^ 0xffffffff) >>> 0
  }
  const chunk = (type, data) => {
    const name = Buffer.from(type), length = Buffer.alloc(4), checksum = Buffer.alloc(4)
    length.writeUInt32BE(data.length); checksum.writeUInt32BE(crc(Buffer.concat([name, data])))
    return Buffer.concat([length, name, data, checksum])
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(2, 0); ihdr.writeUInt32BE(2, 4); ihdr[8] = 8; ihdr[9] = 6
  const pixels = Buffer.from([0, 40, 120, 200, 255, 220, 140, 60, 255, 0, 100, 180, 80, 255, 180, 80, 160, 255])
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))])
}

try {
  const launchUrl = new URL(launch)
  if (!['http:', 'https:'].includes(launchUrl.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(launchUrl.hostname)) throw new FixtureError('授权入口必须指向本机 DSH 服务。')
  const origin = launchUrl.origin
  const cookies = []
  let target = launchUrl
  phase = '建立隔离会话'
  for (let redirects = 0; redirects < 5; redirects++) {
    const response = await fetch(target, { redirect: 'manual' })
    for (const header of response.headers.getSetCookie()) {
      const first = header.split(';', 1)[0], boundary = first.indexOf('=')
      if (boundary > 0) cookies.push({ name: first.slice(0, boundary), value: first.slice(boundary + 1), url: origin, httpOnly: /;\s*httponly\b/i.test(header), secure: /;\s*secure\b/i.test(header) })
    }
    const location = response.headers.get('location')
    if (response.status < 300 || response.status >= 400 || !location) break
    const next = new URL(location, target)
    if (next.origin !== origin) throw new FixtureError('授权重定向离开了本机服务。')
    target = next
  }
  if (!cookies.length) throw new FixtureError('授权入口未返回会话 cookie。')
  const { chromium } = await import(modulePath)
  browser = await chromium.launch({ headless: true })
  context = await browser.newContext({ viewport: { width: 1512, height: 982 }, acceptDownloads: true, colorScheme: 'light' })
  await context.addCookies(cookies)
  const apiPath = '/api/paper-library/api'
  const pagePath = '/api/paper-library/slides.html'
  const actions = new Set(['slides_list', 'slides_create', 'slides_get', 'slides_save', 'slides_asset_put', 'slides_asset_get', 'slides_brief_get', 'slides_brief_save'])

  const routeRequest = async route => {
    const request = route.request(), url = new URL(request.url())
    if (url.protocol === 'blob:' || url.protocol === 'data:') return route.continue()
    if (url.origin !== origin) { blockedRequests.push({ kind: 'external', protocol: url.protocol }); return route.abort('blockedbyclient') }
    if (url.pathname === '/favicon.ico') return route.fulfill({ status: 204, body: '' })
    if (url.pathname === apiPath && request.method() === 'POST') {
      let input
      try { input = request.postDataJSON() } catch { return route.abort('blockedbyclient') }
      if (!actions.has(input.action)) { blockedRequests.push({ kind: 'action' }); return route.abort('blockedbyclient') }
      if (input.action === 'slides_create' && input.title !== titles[projects.length]) { blockedRequests.push({ kind: 'create-scope' }); return route.abort('blockedbyclient') }
      if (input.id && !allowedIds.has(input.id)) { blockedRequests.push({ kind: 'project-scope', action: input.action }); return route.abort('blockedbyclient') }
      const response = await route.fetch(), raw = await response.body()
      let data
      try { data = JSON.parse(raw.toString('utf8')) } catch { apiFailures.push({ action: input.action, status: response.status(), kind: 'invalid-json' }); return route.fulfill({ response, body: raw }) }
      if (!response.ok() || !data.ok) apiFailures.push({ action: input.action, status: response.status(), code: errorCode(data.code) })
      if (input.action === 'slides_create' && data.ok) {
        const project = data.result?.project
        if (!project || project.title !== input.title || !/^pd-[a-f0-9]{32}$/.test(project.id)) { blockedRequests.push({ kind: 'unexpected-create-response' }); return route.abort('blockedbyclient') }
        allowedIds.add(project.id); projects.push({ id: project.id, title: project.title }); await report()
      }
      if (input.action === 'slides_list' && data.ok) {
        data.result.projects = (data.result.projects || []).filter(project => allowedIds.has(project.id))
        data.result.next_offset = null
      }
      return route.fulfill({ response, body: JSON.stringify(data) })
    }
    const assets = new Set([pagePath, '/api/paper-library/theme.js', '/api/paper-library/theme.css', '/api/paper-library/slides-editor.js', '/api/paper-library/slides-editor.css'])
    if (request.method() === 'GET' && assets.has(url.pathname)) return route.continue()
    blockedRequests.push({ kind: 'unexpected-local' })
    return route.abort('blockedbyclient')
  }
  await context.route('**/*', async route => {
    try { await routeRequest(route) }
    catch {
      routeErrors.push({ kind: tearingDown ? 'teardown' : 'runtime' })
      try { await route.abort('failed') } catch { /* Context may already be closed. */ }
    }
  })

  page = await context.newPage()
  page.on('pageerror', () => browserErrors.push({ kind: 'pageerror' }))
  page.on('console', message => {
    if (message.type() === 'error') browserErrors.push({ kind: phase === '模拟并发修改冲突' && /409/.test(message.text()) ? 'expected-conflict' : 'console-error' })
  })
  const api = async (action, input) => {
    if (!['slides_get', 'slides_save', 'slides_brief_get'].includes(action)) throw new FixtureError('测试 API 操作不在允许范围。')
    assertOwned(input.id)
    const response = await context.request.post(`${origin}${apiPath}`, { data: { action, ...input } })
    const result = await response.json()
    if (!response.ok() || !result.ok) throw new FixtureError(`合成项目 API 失败：${action} / ${response.status()} / ${errorCode(result.code)}`)
    return result.result
  }
  const currentDoc = id => api('slides_get', { id })
  const findText = (document, text) => Object.values(document.slides).some(slide => slide.elements.some(element => typeof element.text === 'string' && element.text.includes(text)))
  const saved = async () => page.locator('.save-pill.saved').waitFor({ state: 'visible', timeout: 20000 })
  const openChooser = async () => { await page.getByRole('button', { name: '打开演示项目' }).click(); await page.locator('.slides-chooser:not([inert])').waitFor({ state: 'visible' }) }
  const openProject = async title => { await page.locator('.slides-projects button').filter({ hasText: title }).click(); await page.locator('.app-shell:not([inert])').waitFor({ state: 'visible' }); await page.locator('.slides-toolbar-context').getByText(title, { exact: true }).waitFor() }
  const fillProjectForm = async (title, template) => {
    await page.locator('.slides-chooser:not([inert])').waitFor({ state: 'visible' })
    const name = page.getByLabel('名称'), choice = page.getByLabel('模板')
    await name.fill(title)
    check(await name.inputValue() === title, '项目名称输入未生效。')
    await choice.selectOption(template)
    check(await choice.inputValue() === template, '项目模板选择未生效。')
  }
  const textEditor = () => page.locator('.inspector section').filter({ has: page.getByRole('heading', { name: 'TYPOGRAPHY', exact: true }) }).locator('textarea')
  const contrast = async (theme, items) => {
    for (const [label, selector] of items) {
      const result = await (typeof selector === 'string' ? page.locator(selector) : selector).first().evaluate(element => {
        const parse = value => {
          if (value === 'transparent') return [0, 0, 0, 0]
          const match = value.match(/^(rgba?|color\(srgb)\((.*)\)$/i) || value.match(/^(color\(srgb)\s+(.*)\)$/i)
          if (!match) throw new Error(`无法解析计算颜色：${value}`)
          const numbers = [...match[2].matchAll(/[-+]?(?:\d*\.)?\d+%?/g)].map(item => item[0])
          if (numbers.length < 3) throw new Error('计算颜色缺少通道')
          const srgb = match[1].toLowerCase().startsWith('color')
          const channels = numbers.slice(0, 3).map(value => value.endsWith('%') ? parseFloat(value) * 2.55 : Number(value) * (srgb ? 255 : 1))
          const alpha = numbers[3] === undefined ? 1 : numbers[3].endsWith('%') ? parseFloat(numbers[3]) / 100 : Number(numbers[3])
          return [...channels, alpha]
        }
        const over = (front, back) => {
          const a = front[3] + back[3] * (1 - front[3])
          return a ? [0, 1, 2].map(index => (front[index] * front[3] + back[index] * back[3] * (1 - front[3])) / a).concat(a) : [0, 0, 0, 0]
        }
        const backgrounds = []
        for (let node = element; node; node = node.parentElement) backgrounds.push(parse(getComputedStyle(node).backgroundColor))
        let background = [255, 255, 255, 1]
        for (const color of backgrounds.reverse()) background = over(color, background)
        const foreground = over(parse(getComputedStyle(element).color), background)
        const luminance = color => {
          const channels = color.slice(0, 3).map(value => { const c = value / 255; return c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4 })
          return .2126 * channels[0] + .7152 * channels[1] + .0722 * channels[2]
        }
        const a = luminance(foreground), b = luminance(background)
        return { ratio: (Math.max(a, b) + .05) / (Math.min(a, b) + .05), foreground: getComputedStyle(element).color, background: background.slice(0, 3).map(Math.round) }
      })
      contrastChecks.push({ theme, label, ...result, ratio: Math.round(result.ratio * 100) / 100 })
      check(result.ratio >= 4.5, `${theme} ${label} 的文字对比度不足 4.5（${result.ratio.toFixed(2)}）。`)
    }
  }

  phase = '打开隔离工作台'
  await page.goto(`${origin}${pagePath}`, { waitUntil: 'networkidle' })
  await page.locator('.slides-chooser:not([inert])').waitFor({ state: 'visible' })
  check(await page.locator('.slides-projects button').count() === 0, '项目列表未限制在本脚本的合成项目。')
  await page.screenshot({ path: join(base, 'empty-light.png') })
  await done('独立 1512×982 工作台，项目列表仅显示本次合成项目')

  phase = '新建模板'
  await fillProjectForm(titles[0], 'paper-reading')
  await page.getByRole('button', { name: '新建', exact: true }).click()
  await page.locator('.app-shell:not([inert])').waitFor({ state: 'visible' })
  await until(() => projects.length, count => count === 1, '合成主项目创建')
  const first = projects[0].id
  await page.locator('.slides-toolbar-context').getByText(titles[0], { exact: true }).waitFor()
  check((await currentDoc(first)).document.deck.slides.length > 1, '论文阅读模板未创建多页。')
  await page.waitForLoadState('networkidle')
  const pageContrast = [['元素列表标题', '.inspector .element-row .element-select strong'], ['页面尺寸', '.inspector .metric-grid strong'], ['缩放数值', '.status-zoom strong']]
  await contrast('light', pageContrast)
  await page.screenshot({ path: join(base, 'editor-light.png') })
  await page.emulateMedia({ colorScheme: 'dark' }); await page.waitForTimeout(200)
  await contrast('dark', pageContrast)
  await page.screenshot({ path: join(base, 'editor-dark-page.png') })
  await page.emulateMedia({ colorScheme: 'light' }); await page.waitForTimeout(200)
  await done('创建合成论文阅读模板')

  phase = '编辑与自动保存'
  await page.getByRole('button', { name: '添加文本' }).click()
  const content = textEditor()
  await content.waitFor({ state: 'visible' })
  const selectedContrast = [['选中文字输入', textEditor()], ['选中元素标题', '.inspector .element-row.active .element-select strong'], ['位置数值', '.inspector .four-grid input[type="number"]'], ['缩放数值', '.status-zoom strong']]
  await contrast('light', selectedContrast)
  await page.screenshot({ path: join(base, 'selected-light.png') })
  await page.emulateMedia({ colorScheme: 'dark' }); await page.waitForTimeout(200)
  await contrast('dark', selectedContrast)
  await page.screenshot({ path: join(base, 'selected-dark.png') })
  await page.emulateMedia({ colorScheme: 'light' }); await page.waitForTimeout(200)
  await done('浅深色元素列表、尺寸、缩放和选中文字输入对比度至少 4.5')
  await content.fill('合成验收：自动保存的文字')
  await content.blur()
  await until(() => currentDoc(first), value => findText(value.document, '合成验收：自动保存的文字'), '自动保存内容')
  await saved()
  await done('编辑文本并通过自动保存回读')

  phase = '手动保存'
  await content.fill('合成验收：手动保存的文字')
  await content.blur()
  await page.getByRole('button', { name: '立即保存' }).click()
  await until(() => currentDoc(first), value => findText(value.document, '合成验收：手动保存的文字'), '手动保存内容')
  await saved()
  await done('手动保存并通过资料库回读')

  phase = '插入表格与卡片'
  await page.getByRole('button', { name: '从 Markdown / CSV / JSON 生成原生表格页' }).click()
  await page.getByLabel('结构化表格数据').fill('# 合成表格\n\n| 指标 | 数值 |\n| --- | --- |\n| 示例 A | 1 |')
  await page.getByRole('button', { name: '生成表格页' }).click()
  await until(() => currentDoc(first), value => Object.values(value.document.slides).some(slide => slide.elements.some(element => element.type === 'table')), '合成表格写入')
  await page.getByRole('button', { name: '从 Markdown / JSON 生成结构化卡片页' }).click()
  await page.getByLabel('结构化卡片内容').fill(JSON.stringify({ title: '合成卡片', cards: [{ title: '示例 A', description: '仅用于功能验收。' }] }))
  await page.getByRole('button', { name: '生成卡片页' }).click()
  await until(() => currentDoc(first), value => findText(value.document, '合成卡片'), '合成卡片写入')
  await saved()
  await done('插入合成表格和卡片并回读')

  phase = '插入图片'
  const png = syntheticPng()
  await page.locator('input[type="file"][accept*="image/png"]').setInputFiles({ name: 'synthetic.png', mimeType: 'image/png', buffer: png })
  await until(() => currentDoc(first), value => Object.values(value.document.slides).some(slide => slide.elements.some(element => element.type === 'image' && /^\.\/assets\/[a-f0-9]{64}\.png$/.test(element.src))), '合成图片写入')
  await saved()
  await done('插入受管合成 PNG 并回读')

  phase = '切换与重载'
  await openChooser()
  await fillProjectForm(titles[1], 'blank')
  await page.getByRole('button', { name: '新建', exact: true }).click()
  await until(() => projects.length, count => count === 2, '第二个合成项目创建')
  await page.locator('.app-shell:not([inert])').waitFor({ state: 'visible' })
  await page.locator('.slides-toolbar-context').getByText(titles[1], { exact: true }).waitFor()
  await openChooser(); await openProject(titles[0]); await saved()
  await page.reload({ waitUntil: 'networkidle' }); await openProject(titles[0])
  await until(() => currentDoc(first), value => findText(value.document, '合成验收：手动保存的文字'), '重载后回读')
  await done('切换合成项目并在页面重载后恢复')

  phase = '制作指导'
  await page.getByRole('button', { name: /制作指导/ }).click()
  const guide = page.getByRole('dialog', { name: '制作指导' })
  await guide.locator('fieldset:not(:disabled)').waitFor()
  await guide.getByLabel('目的').fill('仅测试合成演示文稿。')
  await until(() => api('slides_brief_get', { id: first }), value => value.value?.purpose === '仅测试合成演示文稿。', '制作简报保存')
  await guide.getByRole('button', { name: '关闭', exact: true }).click()
  await guide.waitFor({ state: 'hidden' })
  await done('制作指导简报保存并回读')

  phase = 'HTML 和 ZIP 导出'
  const download = async (name, path) => {
    await page.getByRole('button', { name: '导出', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '导出' })
    const pending = page.waitForEvent('download')
    await dialog.getByRole('button', { name, exact: true }).click()
    await (await pending).saveAs(path)
  }
  const htmlPath = join(base, 'synthetic.html'), zipPath = join(base, 'synthetic.zip')
  await download('HTML', htmlPath)
  check((await readFile(htmlPath, 'utf8')).includes('合成验收：手动保存的文字'), '导出 HTML 缺少合成文本。')
  await download('ZIP 项目', zipPath)
  const zip = await JSZip.loadAsync(await readFile(zipPath))
  const deck = JSON.parse(await zip.file('deck.json').async('string'))
  let exportedText = ''
  for (const path of deck.slides) exportedText += await zip.file(path.replace(/^\.\//, '')).async('string')
  check(exportedText.includes('合成验收：手动保存的文字'), '导出 ZIP 缺少合成文本。')
  check(Object.keys(zip.files).some(name => /^assets\/[a-f0-9]{64}\.png$/.test(name)), '导出 ZIP 缺少合成图片。')
  await done('HTML 和 ZIP 均含合成文本，ZIP 含图片')

  phase = '放映、打印布局与深色界面'
  await page.getByRole('button', { name: '演示', exact: true }).click()
  await page.getByRole('dialog', { name: '放映' }).waitFor()
  const initial = await page.locator('.presentation-nav span').innerText()
  await page.keyboard.press('ArrowRight')
  const next = await page.locator('.presentation-nav span').innerText()
  check(initial !== next, '放映方向键未翻页。')
  await page.keyboard.press('Escape'); await page.getByRole('dialog', { name: '放映' }).waitFor({ state: 'hidden' })
  await page.emulateMedia({ media: 'print' })
  check(await page.locator('.print-page').count() > 1, '打印布局未包含多页。')
  await page.pdf({ path: join(base, 'synthetic-print.pdf'), printBackground: true, preferCSSPageSize: true })
  check((await readFile(join(base, 'synthetic-print.pdf'))).subarray(0, 5).toString() === '%PDF-', '打印布局未生成 PDF。')
  await page.emulateMedia({ media: 'screen', colorScheme: 'dark' }); await page.waitForTimeout(200)
  await page.screenshot({ path: join(base, 'editor-dark.png') })
  await page.emulateMedia({ colorScheme: 'light' })
  await done('放映键盘翻页及退出、合成 PDF 打印布局、浅深色截图')

  phase = '模拟并发修改冲突'
  const existing = await currentDoc(first), modified = structuredClone(existing.document)
  modified.deck.title = `${titles[0]} 远端修改`
  await api('slides_save', { id: first, document: modified, expected_revision: existing.revision })
  await page.getByRole('button', { name: '添加文本' }).click()
  const conflictDraft = textEditor()
  await conflictDraft.fill('合成冲突草稿：必须保留'); await conflictDraft.blur()
  await page.getByRole('button', { name: '立即保存' }).click()
  await page.locator('.slides-save-warning').waitFor({ state: 'visible', timeout: 20000 })
  check((await page.locator('.slides-save-warning').innerText()).includes('草稿保留'), '冲突未提示保留草稿。')
  await page.getByRole('button', { name: '打开演示项目' }).click()
  check(await page.locator('.app-shell').isVisible() && !await page.locator('.slides-chooser').isVisible(), '冲突时错误地切换了项目。')
  check(await conflictDraft.inputValue() === '合成冲突草稿：必须保留', '冲突时本地文字未保留。')
  page.once('dialog', dialog => dialog.accept())
  await page.getByRole('button', { name: '放弃草稿并重新读取' }).click()
  await page.locator('.slides-toolbar-context').getByText(`${titles[0]} 远端修改`, { exact: true }).waitFor()
  check(!findText((await currentDoc(first)).document, '合成冲突草稿：必须保留'), '重读后远端文档意外写入了冲突草稿。')
  await done('并发冲突保留草稿、阻止切换并支持显式重读')

  phase = '核对网络与浏览器错误'
  check(blockedRequests.length === 0, `存在 ${blockedRequests.length} 项被阻止的外部或非授权请求。`)
  const unexpectedBrowserErrors = browserErrors.filter(item => item.kind !== 'expected-conflict')
  check(unexpectedBrowserErrors.length === 0, `浏览器报告 ${unexpectedBrowserErrors.length} 个非预期错误。`)
  const unexpected = apiFailures.filter(item => !(item.action === 'slides_save' && item.status === 409 && item.code === 'STATE_CONFLICT'))
  check(unexpected.length === 0, `存在 ${unexpected.length} 个非预期 API 错误。`)
  check(apiFailures.some(item => item.action === 'slides_save' && item.status === 409), '未观察到预期 CAS 冲突。')
  completed = true
} catch (error) {
  // Playwright errors may contain complete request headers and cookies. Never
  // print or persist their message, stack, cause, URL, or request object.
  failure = error instanceof FixtureError ? error.message : error?.name === 'TimeoutError' ? '浏览器等待超时；请根据执行阶段排查。' : '操作未完成；未记录原始浏览器或网络错误。'
} finally {
  // Let synthetic requests settle before removing interception. Waiting for
  // route handlers is essential: close() must never abort an unobserved fetch.
  if (page && !page.isClosed()) {
    try { await page.waitForLoadState('networkidle', { timeout: 15000 }) }
    catch { cleanupErrors.push({ kind: 'network-idle' }) }
  }
  if (context) {
    try { await context.unrouteAll({ behavior: 'wait' }) }
    catch { cleanupErrors.push({ kind: 'unroute' }) }
  }
  tearingDown = true
  if (context) { try { await context.close() } catch { cleanupErrors.push({ kind: 'context-close' }) } }
  if (browser) { try { await browser.close() } catch { cleanupErrors.push({ kind: 'browser-close' }) } }

  if (!failure && !completed) failure = '验收尚未完成。'
  if (!failure && routeErrors.some(item => item.kind === 'runtime')) failure = '请求拦截发生异常；未记录原始请求信息。'
  if (!failure && cleanupErrors.length) failure = '浏览器清理未完成；请查看清理错误类别。'
  if (!failure && blockedRequests.length) failure = '存在被阻止的外部或非授权请求。'
  if (!failure && browserErrors.some(item => item.kind !== 'expected-conflict')) failure = '浏览器报告非预期错误。'
  if (!failure && apiFailures.some(item => !(item.action === 'slides_save' && item.status === 409 && item.code === 'STATE_CONFLICT'))) failure = '存在非预期 API 错误。'
  if (!failure) phase = '完成'
  else if (completed) phase = '收尾'
  process.exitCode = failure ? 1 : 0
  try {
    const result = await report(!failure)
    if (failure) console.error(JSON.stringify(result, null, 2)); else console.log(JSON.stringify(result, null, 2))
  } catch {
    process.exitCode = 1
    console.error('无法写入验收报告；未输出原始错误或认证信息。')
  }
}
