import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { Script } from 'node:vm'

const bundle = new URL('../lib/client.js', import.meta.url)

test('published client bundle mounts both entry tabs and releases hidden iframes', { skip: !existsSync(bundle) && 'Run npm run build before client bundle tests' }, () => {
  let plugin
  const registrations = new Map()
  const tabs = new Map()
  const bodies = new Map()
  const sources = []
  const effects = []
  const react = { createElement: (type, props) => ({ type, props }), useRef: value => ({ current: value }), useEffect: () => {}, useState: value => [value, () => {}] }
  new Script(readFileSync(bundle, 'utf8')).runInNewContext({
    window: { location: { origin: 'http://localhost:3080' }, addEventListener: () => {}, removeEventListener: () => {}, __ModuleLoader__: { load: entry => {
      assert.equal(entry.id, '@mappedinfo/dsh-paper-library')
      plugin = entry.factory(name => { assert.equal(name, 'react'); return react })
    } } },
  })
  const ctx = {
    effect: callback => effects.push(callback()),
    locale: { register: () => () => {}, bind: () => key => ({ title: 'Paper Library', 'canvas.title': 'Whiteboard' })[key] ?? key },
    sidebarRightTabs: { register: definition => { tabs.set(definition.id, definition); return () => tabs.delete(definition.id) } },
    modelDirectories: { directoryFor: sessionId => ({ sessionId }) },
    sessions: { subagentAddress: () => undefined },
    inputTriggers: { registerSource: source => { sources.push(source); return () => { const index = sources.indexOf(source); if (index >= 0) sources.splice(index, 1) } } },
    slots: {
      inject: (name, callback) => { assert.ok(['sidebar.right.pane.tab', 'conversation.input.overlay', 'conversation.input.dock'].includes(name)); return callback() },
      register: (definition, component) => {
        const key = definition.name === 'sidebar.right.pane.tab' ? `body:${definition.key}` : definition.name === 'conversation.input.dock' ? `dock:${definition.id}` : 'mount'
        if (definition.name === 'sidebar.right.pane.tab') bodies.set(definition.key, { definition, component })
        registrations.set(key, { definition, component })
        return () => { registrations.delete(key); bodies.delete(definition.key) }
      },
    },
  }
  plugin.apply(ctx)
  // One plugin, two entries: the library and the whiteboard are separate tab types with
  // separate start-page capsules, so each opens its own tab next to the other.
  const libraryTab = tabs.get('@mappedinfo/dsh-paper-library')
  const canvasTab = tabs.get('@mappedinfo/dsh-paper-library/whiteboard')
  assert.equal(libraryTab.kind, 'paper-library')
  assert.equal(canvasTab.kind, 'paper-library-whiteboard')
  assert.notEqual(canvasTab.kind, libraryTab.kind, 'two tab types may not share a kind')
  assert.equal(canvasTab.priority, 'extension')
  // Read the vm realm's arrays through a host-realm Array.from: a mapped result would carry
  // the bundle's prototypes and never compare equal to a literal here.
  const guideRows = definition => Array.from(definition.guide, entry => [entry.order, entry.title(), entry.description()])
  assert.deepEqual(guideRows(libraryTab), [[15, 'Paper Library', 'description']])
  assert.deepEqual(guideRows(canvasTab), [[16, 'Whiteboard', 'canvas.description']])
  assert.equal(typeof libraryTab.guide[0].icon, 'function')
  assert.equal(typeof canvasTab.guide[0].icon, 'function')
  // Both reference families are registered on the same trigger, in a stable order.
  assert.deepEqual(sources.map(source => source.name), ['paper-library-annotations', 'paper-library-boards'])
  assert.deepEqual(sources.map(source => source.trigger), ['@', '@'])
  assert.deepEqual(sources.map(source => source.order), [20, 30])
  assert.equal(sources[0].showGroupTitle, false)
  assert.equal(sources[1].showGroupTitle, false)
  assert.equal(bodies.get(libraryTab.id).definition.key, libraryTab.id)
  assert.equal(bodies.get(canvasTab.id).definition.key, canvasTab.id)
  assert.equal(bodies.get(libraryTab.id).definition.locale, 'paperLibrary')
  const injected = bodies.get(libraryTab.id).definition.inject('session-1')
  assert.equal(injected.sessionId, 'session-1')
  assert.equal(injected.directory.sessionId, 'session-1')
  assert.equal(injected.modelAvailable, true)
  assert.ok(injected.conversationBridge)
  assert.equal(registrations.get('mount').definition.name, 'conversation.input.overlay')
  assert.equal(registrations.get('dock:@mappedinfo/dsh-paper-library/references').definition.name, 'conversation.input.dock')
  assert.equal(registrations.get('dock:@mappedinfo/dsh-paper-library/boards').definition.name, 'conversation.input.dock')
  const boardInspector = registrations.get('dock:@mappedinfo/dsh-paper-library/boards')
  assert.deepEqual(boardInspector.definition.inject('session-1').sessionId, 'session-1')
  // Neither inspector shows chrome until an explicit preview exists.
  const boardElement = boardInspector.component({ sessionId: 'session-1', boardReferences: { getSnapshot: () => null, subscribe: () => () => {} }, t: key => key })
  assert.equal(boardElement.type(boardElement.props), null)
  const component = bodies.get(libraryTab.id).component
  const hidden = component({ useTabInfo: () => ({ tab: { visible: false } }) })
  assert.equal(hidden.type(hidden.props), null)
  const visible = component({ useTabInfo: () => ({ tab: { visible: true } }) })
  const iframe = visible.type(visible.props)
  assert.equal(iframe.type, 'iframe')
  assert.equal(iframe.props.src, '/api/paper-library/')
  assert.equal(iframe.props.title, 'Paper Library')
  // The whiteboard tab is the same page asking for its board-only entry view.
  const canvasInjected = bodies.get(canvasTab.id).definition.inject('session-1')
  assert.ok(canvasInjected.conversationBridge, 'the canvas keeps the composer bridge, so 「放入对话」 works there too')
  const canvasFrame = bodies.get(canvasTab.id).component({ useTabInfo: () => ({ tab: { visible: true } }), ...canvasInjected })
  const canvasIframe = canvasFrame.type(canvasFrame.props)
  assert.equal(canvasIframe.props.src, '/api/paper-library/?view=board')
  assert.equal(canvasIframe.props.title, 'Whiteboard')
  for (const dispose of effects.reverse()) dispose()
  assert.equal(sources.length, 0)
  assert.equal(registrations.size, 0)
  assert.equal(tabs.size, 0)
  assert.equal(bodies.size, 0)
})
