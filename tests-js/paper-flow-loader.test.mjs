import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('../web/board-flow.js', import.meta.url), 'utf8')
function fixture() {
  const nodes = [], window = { location: { href: 'https://synthetic.invalid/api/paper-library/' } }
  const document = {
    currentScript: { src: window.location.href + 'board-flow.js' },
    head: { append(node) { nodes.push(node) } },
    createElement(tag) { return { tag, remove() { this.removed = true } } },
  }
  vm.runInNewContext(source, { window, document, URL })
  return { window, nodes, load: window.PaperBoardFlowLoader.load }
}
test('workflow assets load once and only from the current local host', async () => {
  const f = fixture(), first = f.load(), second = f.load()
  assert.equal(first, second); assert.equal(f.nodes.length, 2)
  assert.equal(f.nodes[0].href, 'https://synthetic.invalid/api/paper-library/paper-flow-editor.css')
  assert.equal(f.nodes[1].src, 'https://synthetic.invalid/api/paper-library/paper-flow-editor.js')
  const api = { create() {} }; f.window.PaperBoardFlow = api
  f.nodes[1].onload(); f.nodes[0].onload()
  assert.equal(await first, api); assert.equal(await f.load(), api); assert.equal(f.nodes.length, 2)
})
test('failed CSS can retry even when the engine has already finished loading', async () => {
  const f = fixture(), first = f.load(), api = { create() {} }
  f.window.PaperBoardFlow = api; f.nodes[1].onload(); f.nodes[0].onerror()
  await assert.rejects(first, /样式加载失败/)
  assert.equal(f.nodes[0].removed, true)
  const retry = f.load(); assert.equal(f.nodes.length, 3)
  f.nodes[2].onload(); assert.equal(await retry, api)
})
