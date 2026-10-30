import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const source = await readFile(new URL('../web/app.js', import.meta.url), 'utf8')
function handler(name, context) {
  const start = source.indexOf(`function ${name}(`), end = source.indexOf('\nfunction ', start + 1)
  return vm.runInNewContext(`(${source.slice(start, end)})`, context)
}
test('global PDF importer steps aside for flow JSON drops and never covers the flow target', () => {
  let imports = 0, prevented = 0
  const overlay = { hidden: false }, notices = [], context = {
    boardUI: { isFlowOpen: () => true }, $: () => overlay, toast: text => notices.push(text),
    enqueueFiles: () => { imports++ }, enqueueImports: () => { imports++ },
  }
  const event = { dataTransfer: { types: ['Files'], files: [{ name: 'synthetic.json' }] }, preventDefault: () => { prevented++ } }
  handler('handleDragOver', context)(event)
  assert.equal(overlay.hidden, true)
  handler('handleDrop', context)(event)
  assert.equal(imports, 0)
  assert.equal(prevented, 2)
  assert.match(notices[0], /流程面板/)
})
test('ordinary reader file imports keep their original drop behavior', () => {
  const overlay = { hidden: true }, files = [{ name: 'synthetic.pdf' }], enqueued = []
  const context = { boardUI: { isFlowOpen: () => false }, $: () => overlay, enqueueFiles: value => enqueued.push(value) }
  const event = { dataTransfer: { types: ['Files'], files }, preventDefault() {} }
  handler('handleDragOver', context)(event)
  assert.equal(overlay.hidden, false)
  handler('handleDrop', context)(event)
  assert.equal(overlay.hidden, true)
  assert.equal(enqueued[0], files)
})
