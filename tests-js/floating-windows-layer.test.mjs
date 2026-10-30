import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('../web/floating-windows.js', import.meta.url), 'utf8')
const classes = () => ({ add() {}, remove() {}, contains: () => false })
function element(floor) {
  const listeners = new Map()
  const header = { classList: classes(), prepend() {} }
  return {
    tagName: 'SECTION', id: '', hidden: false, isConnected: true,
    dataset: floor === undefined ? {} : { floatingMinLayer: String(floor) },
    style: { getPropertyValue: () => '', getPropertyPriority: () => '', removeProperty() {} },
    classList: classes(), getClientRects: () => [{}], closest: () => null,
    querySelector: selector => selector.includes(':scope') ? header : null,
    addEventListener: (name, callback) => listeners.set(name, callback), removeEventListener() {},
    bringForward: () => listeners.get('pointerdown')({ button: 1 }),
  }
}

test('floating windows respect a host layer floor and still bring the active window forward', () => {
  const window = { addEventListener() {}, removeEventListener() {} }
  const document = { body: { hasAttribute: () => false }, createElement: () => ({
    classList: classes(), setAttribute() {}, remove() {}, isConnected: true,
  }) }
  vm.runInNewContext(source, { window, document, clearTimeout, setTimeout })
  const flow = element(1502), first = window.PaperFloatingWindows.attach(flow)
  assert.ok(Number(flow.style.zIndex) >= 1502)
  const ordinary = element(), second = window.PaperFloatingWindows.attach(ordinary)
  assert.ok(Number(ordinary.style.zIndex) > Number(flow.style.zIndex))
  flow.bringForward()
  assert.ok(Number(flow.style.zIndex) > Number(ordinary.style.zIndex))
  first.dispose(); second.dispose()
})
