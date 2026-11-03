import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFile } from 'node:fs/promises'

const app = await readFile(new URL('../web/app.js', import.meta.url), 'utf8')
const source = app.slice(app.indexOf('function closeWorkspaceVersions('), app.indexOf('function placeWorkspaceNavigation('))
function fixture() {
  const events = new Map(), calls = []
  const listen = (type, fn) => events.set(type, [...(events.get(type) || []), fn])
  const emit = (type, event = {}) => { for (const fn of events.get(type) || []) fn(event) }
  const trigger = { setAttribute: (key, value) => calls.push({ key, value }), focus: () => calls.push('focus') }
  const menuEvents = {}, closeEvents = {}, popup = {}
  const menu = { open: false, dataset: {}, querySelector: () => trigger, contains: target => target === menu || target === popup,
    addEventListener: (type, fn) => { menuEvents[type] = fn } }
  const nodes = { 'workspace-versions': menu, 'workspace-version-popup': popup, 'workspace-versions-close': { addEventListener: (type, fn) => { closeEvents[type] = fn } } }
  const context = vm.createContext({ $: id => nodes[id], libraryLatexVersions: { refresh: () => calls.push('refresh') },
    document: { addEventListener: listen, dispatchEvent: event => emit(event.type, event) },
    window: { addEventListener: listen, PaperFloatingWindows: { placeBelow: (button, panel) => { assert.equal(button, trigger); assert.equal(panel, popup); calls.push('place') } } },
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail } },
  })
  vm.runInContext(source, context); context.bindWorkspaceVersions()
  return { calls, context, emit, menu, popup, menuEvents, closeEvents, open() { menu.open = true; menuEvents.toggle() } }
}

test('compilation history fetches only when opened, repositions its popup and binds once', () => {
  const f = fixture()
  assert.deepEqual(f.calls, [])
  f.context.bindWorkspaceVersions(); f.open()
  assert.equal(f.calls.filter(value => value === 'refresh').length, 1)
  f.emit('resize'); f.emit('scroll')
  assert.equal(f.calls.filter(value => value === 'place').length, 3)
  f.menu.open = false; f.menuEvents.toggle(); f.emit('resize')
  assert.equal(f.calls.filter(value => value === 'refresh').length, 1)
  assert.equal(f.calls.filter(value => value === 'place').length, 3)
})

test('outside interaction and a different workspace popup dismiss versions without stealing focus', () => {
  const f = fixture(); f.open()
  f.emit('pointerdown', { target: f.popup }); assert.equal(f.menu.open, true)
  f.emit('pointerdown', { target: {} }); assert.equal(f.menu.open, false)
  assert.equal(f.calls.includes('focus'), false)
  f.open(); f.emit('paper-library:workspace-popup', { detail: { id: 'workspace-path-popup' } })
  assert.equal(f.menu.open, false)
})

test('Escape and the explicit close button return focus to the versions trigger', () => {
  const f = fixture(); f.open()
  let prevented = false
  f.emit('keydown', { key: 'Escape', preventDefault() { prevented = true }, stopPropagation() {} })
  assert.equal(prevented, true); assert.equal(f.menu.open, false)
  f.open(); f.closeEvents.click(); assert.equal(f.menu.open, false)
  assert.equal(f.calls.filter(value => value === 'focus').length, 2)
})
