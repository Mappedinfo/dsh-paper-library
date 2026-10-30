import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'

const compiled = await build({ entryPoints: [new URL('../vendor/paper-flow/FlowWindow.tsx', import.meta.url).pathname], bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic', external: ['react', 'react/jsx-runtime'], logLevel: 'silent' })

test('non-modal flow window uses the shared drag controller and Escape closes it', () => {
  const effects = [], events = []
  const react = { useRef: value => ({ current: value }), useEffect: callback => effects.push(callback) }
  const jsx = (type, props) => ({ type, props: props || {} })
  const module = { exports: {} }
  new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(name => {
    if (name === 'react') return react
    if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx }
    throw Error(`Unexpected module ${name}`)
  }, module, module.exports)
  let closed = 0
  const component = module.exports.FlowWindow({ open: true, id: 'synthetic-flow-legend', title: '图例', kind: 'legend', onClose: () => { closed++ }, children: 'Synthetic content' })
  assert.equal(component.props.role, 'dialog')
  assert.equal(component.props['aria-modal'], 'false')
  assert.equal(component.props['aria-labelledby'], 'synthetic-flow-legend-title')
  const panel = { focus: () => events.push('focus') }
  component.props.ref.current = panel
  const previousWindow = globalThis.window
  globalThis.window = { PaperFloatingWindows: { attach: value => { assert.equal(value, panel); events.push('attach'); return { refresh: () => events.push('refresh'), dispose: () => events.push('dispose') } } } }
  try {
    const cleanup = effects[0]()
    assert.deepEqual(events, ['attach', 'refresh', 'focus'])
    let prevented = false, stopped = false
    component.props.onKeyDown({ key: 'Escape', preventDefault: () => { prevented = true }, stopPropagation: () => { stopped = true } })
    assert.equal(closed, 1); assert.equal(prevented, true); assert.equal(stopped, true)
    cleanup()
    assert.deepEqual(events, ['attach', 'refresh', 'focus', 'dispose'])
  } finally { globalThis.window = previousWindow }
})
