import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'

// Exercise the shipped browser module without adding React as a plugin runtime dependency.
const compiled = await build({ entryPoints: [new URL('../src/client/settings.mjs', import.meta.url).pathname], bundle: true, write: false, platform: 'browser', format: 'cjs', external: ['react'] })
const module = { exports: {} }
const effects = []
const react = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useState: initial => [initial, () => {}],
  useEffect: callback => effects.push(callback),
}
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(name => { assert.equal(name, 'react'); return react }, module, module.exports)
const { SETTINGS_DEFAULTS, SETTINGS_NAMESPACE, createSettingsCardModel, PaperLibrarySettingsCard, bindSettingsInvalidation, registerPaperLibrarySettings } = module.exports

function scopeFixture(overrides = {}) {
  let snapshot = { status: 'ready', value: { ...SETTINGS_DEFAULTS }, base: { ...SETTINGS_DEFAULTS }, user: {}, revision: 1, writable: true, mode: 'host', ...overrides }
  const listeners = new Set()
  const calls = []
  const scope = {
    getSnapshot: () => snapshot,
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener) },
    mutate: async (ops, revision) => {
      calls.push({ ops, revision })
      assert.equal(revision, snapshot.revision)
      const user = { ...snapshot.user }
      for (const op of ops) if (op.op === 'set') user[op.path[0]] = op.value; else delete user[op.path[0]]
      update({ user, value: { ...SETTINGS_DEFAULTS, ...snapshot.base, ...user }, revision: snapshot.revision + 1 })
    },
  }
  function update(patch) { snapshot = { ...snapshot, ...patch }; for (const listener of listeners) listener() }
  return { scope, update, calls, listeners }
}

test('native settings mutations preserve captured revision and acknowledge accepted user-layer readback', async () => {
  const fixture = scopeFixture()
  const model = createSettingsCardModel(fixture.scope)
  assert.equal(await model.set('auto_analysis', true), true)
  assert.deepEqual(fixture.calls, [{ ops: [{ op: 'set', path: ['auto_analysis'], value: true }], revision: 1 }])
  assert.equal(model.getSnapshot().state, 'saved')
  assert.equal(model.getSnapshot().scope.value.auto_analysis, true)
  assert.equal(await model.set('reading-panel-side', 'right'), true)
  assert.equal(fixture.calls[1].revision, 2)
  assert.equal(await model.set('provider', 'copied-model'), false)
  assert.equal(await model.set('auto_analysis', 'true'), false)
  assert.equal(await model.set('reading-panel-side', 'floating'), false)
  assert.equal(fixture.calls.length, 2)
})

test('scope recovery that resolves after a rejected mutation remains a visible conflict', async () => {
  const fixture = scopeFixture()
  fixture.scope.mutate = async () => fixture.update({ revision: 2 })
  const model = createSettingsCardModel(fixture.scope)
  assert.equal(await model.set('analysis_fill', true), false)
  assert.equal(model.getSnapshot().state, 'conflict')
  assert.equal(model.getSnapshot().scope.value.analysis_fill, true)
  // Equal resolved values do not prove that a native override was persisted.
  assert.equal(await model.set('analysis_fill', false), false)
  fixture.scope.mutate = async () => { throw new Error('connection closed') }
  assert.equal(await model.set('analysis_fill', true), false)
  assert.equal(model.getSnapshot().state, 'failed')
})

test('pending writes cannot overlap and unavailable or memory-only scopes never accept settings edits', async () => {
  const fixture = scopeFixture()
  let finish
  const persist = fixture.scope.mutate
  fixture.scope.mutate = async (...args) => { await new Promise(resolve => { finish = resolve }); await persist(...args) }
  const model = createSettingsCardModel(fixture.scope)
  const first = model.set('auto_analysis', true)
  assert.equal(model.getSnapshot().state, 'saving')
  assert.equal(model.getSnapshot().pending.auto_analysis, true)
  assert.equal(await model.set('analysis_fill', true), false)
  finish(); assert.equal(await first, true)
  assert.equal(model.getSnapshot().pending, undefined)
  for (const change of [{ mode: 'memory' }, { writable: false }, { status: 'loading' }, { status: 'unavailable' }, { revision: undefined }]) {
    const current = scopeFixture(change)
    assert.equal(await createSettingsCardModel(current.scope).set('auto_analysis', true), false)
    assert.equal(current.calls.length, 0)
  }
})

test('reset clears only four plugin overrides and recovers composition defaults without touching other fields', async () => {
  const fixture = scopeFixture({
    base: { ...SETTINGS_DEFAULTS, 'reading-panel-side': 'right' },
    user: { auto_analysis: true, analysis_fill: true, 'reading-panel-side': 'left', other_plugin_data: 'keep' },
  })
  const model = createSettingsCardModel(fixture.scope)
  assert.equal(await model.reset(), true)
  assert.deepEqual(fixture.calls[0].ops.map(op => [op.op, op.path]), Object.keys(SETTINGS_DEFAULTS).map(key => ['unset', [key]]))
  assert.deepEqual(model.getSnapshot().scope.user, { other_plugin_data: 'keep' })
  assert.equal(model.getSnapshot().scope.value['reading-panel-side'], 'right')
  assert.equal(model.getSnapshot().scope.value.auto_analysis, true)
})

test('card subscribes to cross-surface accepted snapshots and releases subscriptions on unmount/disposal', async () => {
  const fixture = scopeFixture()
  const model = createSettingsCardModel(fixture.scope)
  let updates = 0
  const unsubscribe = model.subscribe(() => { updates++ })
  fixture.update({ revision: 2, value: { ...SETTINGS_DEFAULTS, analysis_fill: true } })
  assert.equal(updates, 1)
  assert.equal(model.getSnapshot().scope.value.analysis_fill, true)
  unsubscribe(); assert.equal(fixture.listeners.size, 0)
  model.subscribe(() => { updates++ })
  model.dispose(); assert.equal(fixture.listeners.size, 0)
  fixture.update({ revision: 3 })
  assert.equal(updates, 1)
  assert.equal(await model.set('analysis_fill', false), false)
})

function walk(node) { return [node, ...(node?.children ?? []).flatMap(child => child && typeof child === 'object' ? walk(child) : [])] }
test('native card exposes all four labelled controls, quota descriptions and honest persistence states', () => {
  const fixture = scopeFixture({ status: 'loading' })
  const model = createSettingsCardModel(fixture.scope)
  const rendered = PaperLibrarySettingsCard({ model, t: key => key })
  const nodes = walk(rendered)
  const controls = nodes.filter(node => ['input', 'select'].includes(node.type))
  assert.equal(controls.length, 4)
  for (const control of controls) {
    assert.equal(control.props.disabled, true)
    assert.ok(nodes.some(node => node.type === 'label' && node.props.htmlFor === control.props.id))
    assert.ok(nodes.some(node => node.props.id === control.props['aria-describedby']))
  }
  assert.ok(nodes.some(node => node.props.role === 'status' && node.children.includes('loading')))
  fixture.update({ status: 'ready' })
  const ready = walk(PaperLibrarySettingsCard({ model, t: key => key }))
  assert.equal(ready.filter(node => node.type === 'input').every(node => node.props.checked === SETTINGS_DEFAULTS[node.props.id.replace('paper-library-setting-', '')] && !node.props.disabled), true)
  assert.ok(ready.some(node => node.type === 'p' && node.children.includes('model')))
})

function windowFixture() {
  const listeners = new Set()
  return {
    location: { origin: 'http://localhost:3080' },
    addEventListener: (name, listener) => { assert.equal(name, 'message'); listeners.add(listener) },
    removeEventListener: (name, listener) => { assert.equal(name, 'message'); listeners.delete(listener) },
    dispatch: event => { for (const listener of listeners) listener(event) },
    listeners,
  }
}
test('iframe invalidation is revision-only, same-origin, source-checked, deduplicated and disposable', () => {
  const fixture = scopeFixture()
  const window = windowFixture()
  const messages = []
  const target = { postMessage: (value, origin) => messages.push({ value, origin }) }
  const dispose = bindSettingsInvalidation({ window, target, scope: fixture.scope })
  assert.deepEqual(messages, [{ value: { type: 'paper-library:settings-changed', version: 1, namespace: SETTINGS_NAMESPACE, revision: 1 }, origin: window.location.origin }])
  fixture.update({ value: { ...SETTINGS_DEFAULTS } })
  assert.equal(messages.length, 1)
  fixture.update({ revision: 2 })
  assert.equal(messages.length, 2)
  const data = { type: 'paper-library:settings-ready', version: 1 }
  window.dispatch({ origin: 'https://foreign.example', source: target, data })
  window.dispatch({ origin: window.location.origin, source: {}, data })
  window.dispatch({ origin: window.location.origin, source: target, data: { ...data, version: 2 } })
  assert.equal(messages.length, 2)
  window.dispatch({ origin: window.location.origin, source: target, data })
  assert.equal(messages.length, 3)
  dispose()
  assert.equal(window.listeners.size, 0)
  assert.equal(fixture.listeners.size, 0)
  fixture.update({ revision: 3 })
  assert.equal(messages.length, 3)
})

test('native registration is optional, uses the exact namespace, preserves unrelated locales, and handles late service availability', () => {
  const window = windowFixture()
  assert.equal(typeof registerPaperLibrarySettings({}, window).bind, 'function')
  let provide
  const bridge = registerPaperLibrarySettings({ inject: (dependencies, callback) => { assert.deepEqual(dependencies, ['settingsScope']); provide = callback } }, window)
  const messages = []
  const stop = bridge.bind({ postMessage: message => messages.push(message) })
  assert.equal(messages.length, 0)
  const fixture = scopeFixture()
  const disposers = []
  let definition
  let component
  let localeNamespace
  const ctx = {
    settingsScope: { bind: spec => { assert.deepEqual(spec, { namespace: 'paper-library' }); return fixture.scope } },
    effect: callback => disposers.push(callback()),
    locale: {
      register: (ns, copy) => { localeNamespace = ns; assert.match(copy.zh['auto_analysis.hint'], /额度/); assert.match(copy.zh['auto-paper-conversation.hint'], /额度/); return () => {} },
      bind: ns => { assert.equal(ns, localeNamespace); return key => key },
    },
    slots: {
      inject: (name, callback) => { assert.equal(name, 'settings.plugin.item'); return callback() },
      register: (def, render) => { definition = def; component = render; return () => { definition = undefined } },
    },
  }
  provide(ctx)
  assert.equal(definition.key, SETTINGS_NAMESPACE)
  assert.equal(definition.locale, 'paperLibrarySettings')
  assert.equal(component(definition.inject()).type, PaperLibrarySettingsCard)
  assert.equal(messages.length, 1)
  stop(); assert.equal(fixture.listeners.size, 0)
  for (const dispose of disposers.reverse()) dispose?.()
  assert.equal(definition, undefined)
  assert.equal(window.listeners.size, 0)
})
