import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('../web/icons.js', import.meta.url), 'utf8')
function fixture() {
  const document = { createElementNS(_ns, tag) { return { tag, attrs: {}, children: [], setAttribute(k, v) { this.attrs[k] = v }, append(child) { this.children.push(child) } } } }
  class XMLSerializer { serializeToString(svg) { return `<svg viewBox="${svg.attrs.viewBox}"/>` } }
  const window = {}; vm.runInNewContext(source, { window, document, XMLSerializer, encodeURIComponent })
  return window.PaperIcons
}

test('local Lucide icons are decorative and reject arbitrary names', () => {
  const icons = fixture(), arrow = icons.create('arrow-left', { size: 20 })
  assert.equal(arrow.attrs.width, '20'); assert.equal(arrow.attrs['aria-hidden'], 'true')
  assert.equal(arrow.attrs.viewBox, '0 0 24 24'); assert.ok(arrow.children.length)
  assert.throws(() => icons.create('<script>'), /Unknown paper icon/)
})

test('button decoration survives replacement of the visible label', () => {
  const icons = fixture(), classes = new Set(), properties = {}
  const button = { textContent: '开始', dataset: {}, style: { setProperty: (key, value) => { properties[key] = value } }, classList: { add: value => classes.add(value) } }
  icons.decorate(button, 'sparkles'); button.textContent = '完成'
  assert.equal(button.dataset.paperIcon, 'sparkles')
  assert.ok(classes.has('paper-icon-decorated')); assert.match(properties['--paper-icon'], /^url\("data:image\/svg\+xml,/)
  assert.equal(button.textContent, '完成')
})
