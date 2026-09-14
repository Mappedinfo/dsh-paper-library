import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { THEME_TOKENS, bindThemeContext, themeContext } from '../src/client/theme-context.mjs'

const script = readFileSync(new URL('../web/theme.js', import.meta.url), 'utf8')
const tick = () => new Promise(resolve => queueMicrotask(resolve))
function eventTarget() {
  const listeners = new Map()
  return { listeners,
    addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn) },
    removeEventListener(type, fn) { listeners.get(type)?.delete(fn) },
    emit(type, event = {}) { for (const fn of [...(listeners.get(type) || [])]) fn(event) },
  }
}
function host() {
  const messages = [], observers = [], subscribers = new Set(), values = new Map([
    ['--dsw-alias-bg-base', 'rgb(255, 255, 255)'], ['--dsw-font-family', 'Arial, sans-serif'], ['--dsh-content-font-size', '14px'],
  ])
  let snapshot = { active: { id: 'custom-light', colorScheme: 'light', tokens: {}, private: 'must-not-cross' }, fontSize: 14, revision: 1 }
  const body = { dark: false, hasAttribute(name) { return name === 'data-ds-dark-theme' && this.dark } }
  const document = { ...eventTarget(), body, documentElement: {} }
  const window = { ...eventTarget(), document, location: { origin: 'http://localhost:3080' }, queueMicrotask,
    getComputedStyle: () => ({ getPropertyValue: name => values.get(name) || '', fontFamily: 'Arial, sans-serif' }),
    MutationObserver: class { constructor(fn) { this.fn = fn; this.observations = []; observers.push(this) } observe(...args) { this.observations.push(args) } disconnect() { this.disconnected = true } },
  }
  const target = { postMessage: (data, origin) => messages.push({ data, origin }) }
  return { window, target, messages, observers, values, subscribers, getTheme: () => snapshot,
    subscribe: fn => { subscribers.add(fn); return () => subscribers.delete(fn) },
    update(next) { snapshot = next; for (const fn of subscribers) fn(next) },
  }
}
function child({ embedded = true, dark = false } = {}) {
  const properties = new Map(), media = { ...eventTarget(), matches: dark }, sent = []
  const root = { dataset: {}, style: { setProperty: (key, value) => properties.set(key, value), removeProperty: key => properties.delete(key) } }
  const window = { ...eventTarget(), document: { documentElement: root }, location: { origin: 'http://localhost:3080' }, matchMedia: () => media,
    CSS: { supports: (_property, value) => !value.includes('invalid-css') },
  }
  Object.defineProperty(window, 'localStorage', { get: () => { throw new Error('Theme must not access browser storage') } })
  Object.defineProperty(window, 'caches', { get: () => { throw new Error('Theme must not access caches') } })
  window.parent = embedded ? { postMessage: (data, origin) => sent.push({ data, origin }) } : window
  vm.runInNewContext(script, { window }, { filename: 'web/theme.js' })
  const send = (data, overrides = {}) => window.emit('message', { data, source: window.parent, origin: window.location.origin, ...overrides })
  return { window, root, properties, media, sent, send, api: window.PaperLibraryTheme }
}
const packet = (tokens = {}, mode = 'dark') => ({ type: 'paper-library:theme', version: 1, status: 'ready', mode, tokens })

test('official theme semantics and font size win over custom theme names and earlier DOM projection', async () => {
  const f = host(), dispose = bindThemeContext(f)
  await tick()
  assert.equal(f.messages[0].data.mode, 'light')
  f.update({ active: { id: 'moonlight', colorScheme: 'dark', tokens: {} }, fontSize: 17, revision: 2 })
  f.values.set('--dsw-alias-bg-base', 'rgb(21, 21, 23)')
  await tick()
  assert.equal(f.messages.at(-1).data.mode, 'dark')
  assert.equal(f.messages.at(-1).data.tokens['--dsw-alias-bg-base'], 'rgb(21, 21, 23)')
  assert.equal(f.messages.at(-1).data.tokens['--dsh-content-font-size'], '17px')
  assert.equal(JSON.stringify(f.messages).includes('must-not-cross'), false)
  dispose()
})

test('host transmits only bounded presentation values, including resolved rather than dependent CSS variables', () => {
  const f = host()
  f.values.set('--unknown-token', 'private')
  f.values.set('--dsw-alias-bg-layer-1', 'url(https://invalid.test/tracking)')
  f.values.set('--dsw-alias-bg-layer-2', 'var(--arbitrary-host-value)')
  f.values.set('--dsw-alias-bg-layer-3', 'x'.repeat(513))
  f.values.set('--dsw-font-family', "-apple-system,\n 'PingFang SC', sans-serif")
  const context = themeContext(f)
  assert.deepEqual(Object.keys(context.tokens).sort(), ['--dsh-content-font-size', '--dsw-alias-bg-base', '--dsw-font-family'])
  assert.equal(context.version, 1)
  assert.equal(Object.keys(context).length, 5)
  assert.equal(context.tokens['--dsw-font-family'], "-apple-system,  'PingFang SC', sans-serif")
})

test('host handshake requires exact origin, source and version and rehydrates the same frame after reload', async () => {
  const f = host(), dispose = bindThemeContext(f)
  await tick()
  const request = { type: 'paper-library:request-theme', version: 1 }
  for (const overrides of [{ origin: 'https://invalid.test' }, { source: {} }, { data: { ...request, version: 2 } }]) {
    f.window.emit('message', { origin: f.window.location.origin, source: f.target, data: request, ...overrides })
  }
  await tick(); assert.equal(f.messages.length, 1)
  f.window.emit('message', { origin: f.window.location.origin, source: f.target, data: request })
  await tick(); assert.equal(f.messages.length, 2)
  assert.deepEqual(f.messages[0], f.messages[1])
  dispose()
})

test('bridge coalesces appearance changes, observes no subtree and fully disposes late work', async () => {
  const f = host(), dispose = bindThemeContext(f), late = [...f.subscribers][0]
  await tick()
  for (const [element, options] of f.observers[0].observations) {
    assert.ok([f.window.document.body, f.window.document.documentElement].includes(element))
    assert.equal(options.subtree, undefined)
    assert.equal(options.childList, undefined)
  }
  for (let n = 0; n < 100; n++) f.observers[0].fn()
  await tick(); assert.equal(f.messages.length, 1)
  f.values.set('--dsw-alias-bg-base', 'rgb(2, 3, 4)')
  late(); dispose(); dispose(); late(); f.observers[0].fn()
  await tick()
  assert.equal(f.messages.length, 2)
  assert.equal(f.messages.at(-1).data.status, 'unavailable')
  assert.equal(f.subscribers.size, 0)
  assert.equal(f.window.listeners.get('message').size, 0)
  assert.equal(f.window.document.listeners.get('load').size, 0)
  assert.equal(f.observers[0].disconnected, true)
})

test('bootstrap without optional theme service derives only the host theme attribute and safe content size', () => {
  const f = host(); f.window.document.body.dark = true; f.values.set('--dsh-content-font-size', '99px')
  const context = themeContext({ window: f.window })
  assert.equal(context.mode, 'dark')
  assert.equal(context.tokens['--dsh-content-font-size'], undefined)
})

test('standalone preview follows system theme changes without browser persistence', () => {
  const f = child({ embedded: false })
  assert.equal(f.root.dataset.theme, 'light'); assert.equal(f.sent.length, 0)
  f.media.matches = true; f.media.emit('change')
  assert.equal(f.root.dataset.theme, 'dark')
  f.send(packet({ '--dsw-alias-bg-base': 'red' }, 'light'))
  assert.equal(f.root.dataset.theme, 'dark'); assert.equal(f.properties.size, 0)
  f.api.instance.dispose(); f.media.matches = false; f.media.emit('change')
  assert.equal(f.root.dataset.theme, 'dark')
})

test('embedded palette requires same-origin parent and the current protocol', () => {
  const f = child()
  for (const overrides of [{ origin: 'https://invalid.test' }, { source: {} }]) f.send(packet(), overrides)
  f.send({ ...packet(), version: 2 }); f.send({ ...packet(), mode: 'system' })
  assert.equal(f.root.dataset.theme, 'light')
  f.send(packet({ '--dsw-alias-bg-base': 'rgb(21,21,23)' }))
  assert.equal(f.root.dataset.theme, 'dark')
  assert.equal(f.sent[0].data.type, 'paper-library:request-theme')
  assert.equal(f.sent[0].origin, f.window.location.origin)
})

test('palette replaces only its own allowlisted values and rejects CSS payloads and unsupported font sizes', () => {
  const f = child()
  f.properties.set('--unrelated-style', 'keep')
  f.send(packet({ '--dsw-alias-bg-base': 'rgb(21,21,23)', '--dsw-alias-label-primary': 'white', '--dsh-content-font-size': '16px' }))
  f.send(packet({ '--dsw-alias-bg-base': 'url(https://invalid.test)', '--dsw-alias-link': 'invalid-css', '--dsh-content-font-size': '40px', '--dsw-font-family': 'Arial, sans-serif', '--unrelated-style': 'overwrite' }, 'light'))
  assert.equal(f.properties.get('--unrelated-style'), 'keep')
  assert.equal(f.properties.get('--dsw-alias-label-primary'), undefined)
  assert.equal(f.properties.get('--dsw-alias-bg-base'), undefined)
  assert.equal(f.properties.get('--dsh-content-font-size'), undefined)
  assert.equal(f.properties.get('--dsw-font-family'), 'Arial, sans-serif')
})

test('host theme overrides system preference until host bridge is released', () => {
  const f = child()
  f.send(packet({ '--dsw-alias-bg-base': 'black' }, 'dark'))
  f.media.matches = false; f.media.emit('change')
  assert.equal(f.root.dataset.theme, 'dark')
  f.send({ type: 'paper-library:theme', version: 1, status: 'unavailable' })
  assert.equal(f.root.dataset.theme, 'light'); assert.equal(f.properties.size, 0)
})

test('bfcache restore requests fresh host context and final page release removes listeners', () => {
  const f = child()
  f.window.emit('pagehide', { persisted: true }); f.window.emit('pageshow')
  assert.equal(f.sent.length, 2)
  f.send(packet()); assert.equal(f.root.dataset.theme, 'dark')
  f.window.emit('pagehide', { persisted: false })
  for (const type of ['message', 'pageshow', 'pagehide']) assert.equal(f.window.listeners.get(type).size, 0)
  assert.equal(f.media.listeners.get('change').size, 0)
  f.send(packet({}, 'light')); assert.equal(f.root.dataset.theme, 'dark')
})

test('host and browser share the exact presentation allowlist', () => {
  const f = child()
  assert.deepEqual(Array.from(f.api.tokens), THEME_TOKENS)
  assert.equal(new Set(THEME_TOKENS).size, THEME_TOKENS.length)
})
