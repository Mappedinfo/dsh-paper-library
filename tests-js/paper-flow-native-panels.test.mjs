import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const asset = name => readFile(new URL('../web/' + name, import.meta.url), 'utf8')
const loader = await asset('board-flow.js')

test('native panel controls send requests and take their expanded state from their owner document', () => {
  class Element extends EventTarget {
    constructor(doc) { super(); this.ownerDocument = doc; this.children = []; this.attrs = new Map() }
    setAttribute(name, value) { this.attrs.set(name, value) }
    append(node) { this.children.push(node) }
    prepend(node) { this.children.unshift(node) }
  }
  const doc = new EventTarget()
  const toolbar = new Element(doc), window = { location: { href: 'https://synthetic.invalid/' } }
  doc.getElementById = id => id === 'paper-tools' ? toolbar : null
  doc.createElement = () => new Element(doc)
  vm.runInNewContext(loader, { document: doc, window, CustomEvent })
  const [group] = toolbar.children, [compare, code] = group.children, requests = []
  doc.addEventListener('paper-flow-panel-toggle', event => requests.push(event.detail.panel))
  function publish(open, panel) { doc.dispatchEvent(new CustomEvent('paper-flow-panels-state', { detail: { open, panel } })) }
  assert.equal(group.hidden, true)
  assert.equal(compare.attrs.get('aria-controls'), 'paper-flow-compare-panel')
  assert.equal(code.id, 'paper-flow-code-toggle')
  code.dispatchEvent(new Event('click')); assert.deepEqual(requests, [])
  publish(true, null)
  compare.dispatchEvent(new Event('click')); code.dispatchEvent(new Event('click'))
  assert.deepEqual(requests, ['compare', 'code'])
  assert.equal(compare.attrs.get('aria-expanded'), 'false')
  publish(true, 'compare')
  assert.equal(compare.attrs.get('aria-expanded'), 'true')
  publish(true, 'code')
  assert.equal(compare.attrs.get('aria-expanded'), 'false')
  assert.equal(code.attrs.get('aria-expanded'), 'true')
  publish(false, null)
  assert.equal(code.attrs.get('aria-expanded'), 'false')
  assert.equal(group.hidden, true)
})

const browserLib = await import(process.env.PLAYWRIGHT_MODULE || 'playwright').catch(() => null)

test('exactly one return is visible in hosted board, focus, system fullscreen and flow viewport fullscreen', {
  skip: !browserLib && 'Set PLAYWRIGHT_MODULE to the installed Playwright package for the browser fixture.',
}, async () => {
  const browser = await browserLib.chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    const html = '<body class="board-mode"><header class="topbar"><div id="topbar-end"></div><div id="paper-tools"></div></header><section id="board-view"><header class="board-toolbar board-bar"></header><div id="board-flow-view" hidden><div class="board-flow-host"><div class="board-flow-host-tools"></div></div></div></section></body>'
    const origin = 'https://synthetic.invalid'
    await page.route(origin + '/**', route => route.fulfill({ contentType: 'text/html', body: html }))
    async function mount(path) {
      await page.goto(origin + path)
      await page.addStyleTag({ content: await asset('board.css') })
      await page.addScriptTag({ content: await asset('return-to-dsh.js') })
      await page.addScriptTag({ content: loader })
      await page.evaluate(() => {
        for (const [selector, id] of [['#topbar-end', 'library-return-to-dsh'], ['.board-toolbar', 'board-return'], ['.board-flow-host-tools', 'flow-return']]) {
          const button = window.PaperReturnToDsh.create({ host: document.querySelector(selector), prepare: async () => false })
          if (button) button.id = id
        }
      })
    }
    const visible = () => page.locator('.return-to-dsh:visible').evaluateAll(nodes => nodes.map(n => n.id))
    const setBoard = async (flow, focus, viewport) => page.evaluate(([f, b, v]) => {
      document.body.classList.toggle('board-focused', b)
      document.querySelector('#board-view').classList.toggle('has-paper-flow', f)
      document.querySelector('#board-flow-view').hidden = !f
      document.querySelector('.board-flow-host').classList.toggle('paper-flow-host-fullscreen', v)
      document.dispatchEvent(new CustomEvent('paper-flow-panels-state', { detail: { open: f, panel: null } }))
    }, [flow, focus, viewport])
    await mount('/api/paper-library/')
    for (const [flow, focus, viewport, expected] of [
      [false, false, false, 'library-return-to-dsh'], [true, false, false, 'library-return-to-dsh'],
      [false, true, false, 'board-return'], [true, true, false, 'flow-return'], [true, false, true, 'flow-return'],
    ]) {
      await setBoard(flow, focus, viewport)
      assert.deepEqual(await visible(), [expected])
      assert.equal(await page.locator('#paper-flow-code-toggle').isVisible(), flow && !focus && !viewport)
    }
    await setBoard(false, false, false)
    await page.locator('#board-view').evaluate(element => element.requestFullscreen())
    assert.deepEqual(await visible(), ['board-return'])
    await setBoard(true, false, false)
    assert.deepEqual(await visible(), ['flow-return'])
    assert.equal(await page.locator('#paper-flow-code-toggle').isVisible(), false)
    await page.evaluate(() => document.exitFullscreen())
    assert.deepEqual(await visible(), ['library-return-to-dsh'])
    await mount('/standalone/')
    await setBoard(true, false, false)
    assert.deepEqual(await visible(), [])
  } finally { await browser.close() }
})
