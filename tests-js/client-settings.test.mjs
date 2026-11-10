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

test('native annotation size control persists numeric values and rejects out of range sizes',async()=>{
  const fixture=scopeFixture(),model=createSettingsCardModel(fixture.scope);
  const select=walk(PaperLibrarySettingsCard({model,t:key=>key})).find(node=>node.props.id==='paper-library-setting-annotation_font_size');
  assert.equal(select.children.length,13);
  select.props.onChange({currentTarget:{value:'18'}});await new Promise(resolve=>setImmediate(resolve));
  assert.equal(model.getSnapshot().scope.value.annotation_font_size,18);
  for(const value of [11,25,13.5,'20'])assert.equal(await model.set('annotation_font_size',value),false);
  model.dispose();
});
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(name => { assert.equal(name, 'react'); return react }, module, module.exports)
const { SETTINGS_DEFAULTS, SETTINGS_NAMESPACE, createSettingsCardModel, createHttpSettingsScope, createLanguageSettingsModel, PaperLibrarySettingsCard, PaperLibraryLanguageSettings, bindSettingsInvalidation, registerPaperLibrarySettings } = module.exports

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

test('reset clears only managed plugin overrides and recovers composition defaults without touching other fields', async () => {
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
test('native card exposes all labelled controls, quota descriptions and honest persistence states', () => {
  const fixture = scopeFixture({ status: 'loading' })
  const model = createSettingsCardModel(fixture.scope)
  const rendered = PaperLibrarySettingsCard({ model, t: key => key })
  const nodes = walk(rendered)
  const controls = nodes.filter(node => ['input', 'select'].includes(node.type))
  assert.equal(controls.length, 11)
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
  const fixture = scopeFixture()
  const disposers = []
  const definitions = new Map()
  let localeNamespace
  const ctx = {
    settingsScope: { bind: spec => { assert.deepEqual(spec, { namespace: 'paper-library' }); return fixture.scope } },
    effect: callback => disposers.push(callback()),
    locale: {
      register: (ns, copy) => { localeNamespace = ns; assert.match(copy.zh['auto_analysis.hint'], /额度/); assert.match(copy.zh['auto-paper-conversation.hint'], /额度/); return () => {} },
      bind: ns => { assert.equal(ns, localeNamespace); return key => key },
    },
    slots: {
      inject: (name, callback) => { assert.ok(['settings.plugin.item', 'settings.section'].includes(name)); return callback() },
      register: (def, render) => { definitions.set(def.name, { def, render }); return () => { definitions.delete(def.name) } },
    },
    inject: (dependencies, callback) => { assert.deepEqual(dependencies, ['settingsScope']); provide = callback },
  }
  const bridge = registerPaperLibrarySettings(ctx, window)
  const messages = []
  const stop = bridge.bind({ postMessage: message => messages.push(message) })
  assert.equal(messages.length, 0)
  assert.ok(definitions.has('settings.section'), 'section exists before optional legacy service')
  provide(ctx)
  const { def: definition, render: component } = definitions.get('settings.plugin.item')
  assert.equal(definition.key, SETTINGS_NAMESPACE)
  assert.equal(definition.locale, 'paperLibrarySettings')
  assert.equal(component(definition.inject()).type, PaperLibrarySettingsCard)
  const section = definitions.get('settings.section')
  assert.equal(section.def.id, SETTINGS_NAMESPACE)
  assert.equal(section.def.label(), 'title')
  const content = walk(section.render(section.def.inject()))
  assert.ok(content.some(node => node.type === PaperLibrarySettingsCard))
  assert.ok(content.some(node => node.type === PaperLibraryLanguageSettings))
  assert.equal(messages.length, 1)
  stop(); assert.equal(fixture.listeners.size, 0)
  for (const dispose of disposers.reverse()) dispose?.()
  assert.equal(definitions.size, 0)
  assert.equal(window.listeners.size, 0)
})

test('native HTTP settings use the server CAS revision and restrict writes to selected fields', async () => {
  let current = { backend: 'dsh', available: true, writable: true, revision: 'remote-a', value: { ...SETTINGS_DEFAULTS }, user: {}, base: { ...SETTINGS_DEFAULTS } }
  const calls = []
  const scope = createHttpSettingsScope(async (action, args) => {
    calls.push({ action, args })
    if (action === 'settings_update') {
      assert.equal(args.expected_revision, 'remote-a')
      current = { ...current, revision: 'remote-b', value: { ...current.value, ...args.patch }, user: { ...current.user, ...args.patch } }
    }
    return current
  })
  await scope.refresh()
  const model = createSettingsCardModel(scope)
  assert.equal(await model.set('analysis_fill', false), true)
  assert.deepEqual(calls[1].args.patch, { analysis_fill: false })
  assert.equal(await model.reset(), false, 'HTTP cannot silently reset unrelated preferences')
  assert.equal(calls.filter(call => call.action === 'settings_reset').length, 0)
  scope.dispose(); model.dispose()
})

test('language settings use their own revisions and retain drafts across failures and stale writes', async () => {
  let resolveSave
  const requests = []
  const model = createLanguageSettingsModel(async (action, args) => {
    requests.push({ action, args })
    if (action === 'language_settings_get') return { value: { model: null, translate_prompt: '', polish_prompt: '' }, revision: 7, models: [{ provider: 'host', id: 'mini' }], default_model: { provider: 'host', model: 'default' } }
    return await new Promise(resolve => { resolveSave = resolve })
  })
  assert.equal(await model.load(), true)
  model.set('translate_prompt', '保留语气')
  const saving = model.save()
  assert.equal(requests[1].args.expected_revision, 7)
  assert.equal(requests[1].args.value.translate_prompt, '保留语气')
  model.set('polish_prompt', '保留引用')
  resolveSave({ revision: 8, value: requests[1].args.value })
  assert.equal(await saving, true)
  assert.equal(model.getSnapshot().revision, 8)
  assert.equal(model.getSnapshot().value.polish_prompt, '保留引用')
  assert.equal(model.getSnapshot().dirty, true)
  model.dispose()
})

test('language settings conflict preserves editable text and requires an explicit reload', async () => {
  const model = createLanguageSettingsModel(async action => {
    if (action === 'language_settings_get') return { value: { model: null, translate_prompt: '', polish_prompt: '' }, revision: 2, models: [] }
    throw Object.assign(new Error('stale'), { code: 'STATE_CONFLICT' })
  })
  await model.load(); model.set('translate_prompt', '保留数字')
  assert.equal(await model.save(), false)
  assert.equal(model.getSnapshot().status, 'conflict')
  model.set('polish_prompt', '保留引用')
  assert.equal(model.getSnapshot().status, 'conflict')
  assert.equal(await model.save(), false)
  assert.equal(model.getSnapshot().value.translate_prompt, '保留数字')
  await model.load()
  assert.equal(model.getSnapshot().value.translate_prompt, '')
  model.dispose()
})

test('language settings refresh on remount only when there is no unsaved draft', () => {
  let dirty = false, loads = 0
  const model = {
    getSnapshot: () => ({ status: 'ready', value: { model: null, translate_prompt: '', polish_prompt: '' }, models: [], dirty }),
    subscribe: () => () => {}, load: () => { loads++ }, set: () => {}, save: () => {},
  }
  const mount = () => {
    const before = effects.length
    PaperLibraryLanguageSettings({ model, t: key => key })
    assert.equal(effects.length, before + 1)
    return effects.pop()()
  }
  mount()()
  assert.equal(loads, 1)
  mount()()
  assert.equal(loads, 2, 'reopening observes changes made in the language window')
  dirty = true
  mount()()
  assert.equal(loads, 2, 'reopening must not replace a dirty draft')
})

test('language settings always offer explicit reload, disabled during requests', () => {
  const snapshot = { status: 'ready', value: { model: null, translate_prompt: '', polish_prompt: '' }, models: [] }
  let loads = 0
  const model = { getSnapshot: () => snapshot, subscribe: () => () => {}, load: () => { loads++ }, set: () => {}, save: () => {} }
  const reload = () => walk(PaperLibraryLanguageSettings({ model, t: key => key })).find(node => node.type === 'button' && node.children.includes('language.reload'))
  assert.equal(reload().props.disabled, false)
  reload().props.onClick()
  assert.equal(loads, 1)
  snapshot.status = 'saving'
  assert.equal(reload().props.disabled, true)
  snapshot.status = 'loading'
  assert.equal(reload().props.disabled, true)
})

test('native language settings group models by provider and expose the persisted default target', () => {
  const fixture = {
    getSnapshot: () => ({ status: 'ready', value: { model: null, translate_prompt: '', polish_prompt: '', target_language: 'en' }, models: [
      { provider: 'first', id: 'one', name: 'One' }, { provider: 'second', id: 'two', name: 'Two' }, { provider: 'first', id: 'three', name: 'Three' },
    ] }), subscribe: () => () => {}, load: () => {}, save: () => {}, set: () => {},
  }
  const nodes = walk(PaperLibraryLanguageSettings({ model: fixture, t: key => key }))
  const groups = nodes.filter(node => node.type === 'optgroup')
  assert.deepEqual(groups.map(node => node.props.label), ['first', 'second'])
  assert.equal(groups[0].children.filter(child => child?.type === 'option').length, 2)
  const selects = nodes.filter(node => node.type === 'select')
  assert.equal(selects.length, 2)
  assert.equal(selects[1].props.value, 'en')
  assert.deepEqual(selects[1].children.filter(child => child?.type === 'option').map(option => option.props.value), ['auto', 'zh-CN', 'en'])
})

test('native settings offer and persist all three additional workspace palettes',async()=>{
  const fixture=scopeFixture(),model=createSettingsCardModel(fixture.scope);
  const rendered=walk(PaperLibrarySettingsCard({model,t:key=>key}));
  const select=rendered.find(node=>node.props.id==='paper-library-setting-ui_palette');
  assert.ok(select);
  assert.deepEqual(select.children.map(node=>node.props.value),['jade','navy','neutral','rose','apricot','system']);
  for(const palette of ['neutral','rose','apricot']){
    assert.equal(await model.set('ui_palette',palette),true);
    assert.equal(model.getSnapshot().scope.value.ui_palette,palette);
  }
  assert.equal(await model.set('ui_palette','not-a-theme'),false);
});


test('native resource profile uses shared host mutations and rejects unknown tiers',async()=>{
 const fixture=scopeFixture();const model=createSettingsCardModel(fixture.scope);
 for(const profile of ['eco','balanced','performance','custom']){
   assert.equal(await model.set('resource_profile',profile),true);
   assert.equal(model.getSnapshot().scope.value.resource_profile,profile);
 }
 assert.equal(await model.set('resource_profile','unbounded'),false);
 model.dispose();
});


test('native reading distribution controls share defaults and save typed values with reset', async () => {
  const backend = await import('../src/harness/settings.mjs');
  const fixture = scopeFixture({ user: { unrelated: 'keep' } }), model = createSettingsCardModel(fixture.scope);
  const nodes = walk(PaperLibrarySettingsCard({ model, t: key => key }));
  assert.ok(nodes.some(node => node.type === 'legend' && node.children.includes('reading_distribution')));
  for (const key of ['reading_distribution_enabled', 'reading_distribution_mode', 'reading_distribution_ai', 'reading_distribution_smoothing']) assert.equal(SETTINGS_DEFAULTS[key], backend.PAPER_LIBRARY_SETTINGS_DEFAULTS[key]);
  const control = key => nodes.find(node => node.props.id === `paper-library-setting-${key}`);
  assert.deepEqual(control('reading_distribution_mode').children.map(node => node.props.value), ['density', 'bands']);
  assert.deepEqual(control('reading_distribution_smoothing').children.map(node => node.props.value), [1, 2, 3, 4, 5, 6]);
  for (const [key, value] of Object.entries({ reading_distribution_enabled: false, reading_distribution_mode: 'bands', reading_distribution_ai: false, reading_distribution_smoothing: 6 })) {
    control(key).props.onChange({ currentTarget: { checked: value, value: String(value) } });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(model.getSnapshot().scope.value[key], value);
  }
  const count = fixture.calls.length;
  for (const [key, values] of Object.entries({ reading_distribution_enabled: ['false', 0], reading_distribution_ai: ['true', 1], reading_distribution_mode: ['other', true], reading_distribution_smoothing: [0, 7, 2.5, '3', NaN] })) for (const value of values) assert.equal(await model.set(key, value), false);
  assert.equal(fixture.calls.length, count);
  assert.equal(await model.reset(), true);
  assert.deepEqual(model.getSnapshot().scope.user, { unrelated: 'keep' });
  for (const key of Object.keys(SETTINGS_DEFAULTS).filter(key => key.startsWith('reading_distribution_'))) assert.equal(model.getSnapshot().scope.value[key], SETTINGS_DEFAULTS[key]);
  model.dispose();
});
