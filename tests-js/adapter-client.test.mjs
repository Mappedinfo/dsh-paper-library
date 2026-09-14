import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { Script } from 'node:vm'

const bundle = new URL('../lib/client.js', import.meta.url)

test('published client bundle mounts the public library tab and releases hidden iframes', { skip: !existsSync(bundle) && 'Run npm run build before client bundle tests' }, () => {
  let plugin
  const registrations = new Map()
  const effects = []
  const react = { createElement: (type, props) => ({ type, props }), useRef: value => ({ current: value }), useEffect: () => {} }
  new Script(readFileSync(bundle, 'utf8')).runInNewContext({
    window: { __ModuleLoader__: { load: entry => {
      assert.equal(entry.id, '@mappedinfo/dsh-paper-library')
      plugin = entry.factory(name => { assert.equal(name, 'react'); return react })
    } } },
  })
  const ctx = {
    effect: callback => effects.push(callback()),
    locale: { register: () => () => {}, bind: () => key => key === 'title' ? 'Paper Library' : key },
    sidebarRightTabs: { register: definition => { registrations.set('tab', definition); return () => registrations.delete('tab') } },
    modelDirectories: { directoryFor: sessionId => ({ sessionId }) },
    sessions: { subagentAddress: () => undefined },
    slots: {
      inject: (name, callback) => { assert.equal(name, 'sidebar.right.pane.tab'); return callback() },
      register: (definition, component) => { registrations.set('body', { definition, component }); return () => registrations.delete('body') },
    },
  }
  plugin.apply(ctx)
  assert.equal(registrations.get('tab').kind, 'paper-library')
  assert.equal(registrations.get('body').definition.key, registrations.get('tab').id)
  const injected = registrations.get('body').definition.inject('session-1')
  assert.equal(injected.sessionId, 'session-1')
  assert.equal(injected.directory.sessionId, 'session-1')
  assert.equal(injected.modelAvailable, true)
  const component = registrations.get('body').component
  const hidden = component({ useTabInfo: () => ({ tab: { visible: false } }) })
  assert.equal(hidden.type(hidden.props), null)
  const visible = component({ useTabInfo: () => ({ tab: { visible: true } }) })
  const iframe = visible.type(visible.props)
  assert.equal(iframe.type, 'iframe')
  assert.equal(iframe.props.src, '/api/paper-library/')
  for (const dispose of effects.reverse()) dispose()
  assert.equal(registrations.size, 0)
})
