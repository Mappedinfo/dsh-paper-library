import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { createWorkspace } from '../vendor/paper-flow/document.js'

// Exercise the real component event handler with deterministic React hooks;
// no browser, private files or real workspace are involved.
const compiled = await build({
  entryPoints: [new URL('../vendor/paper-flow/PaperFlowWorkbench.tsx', import.meta.url).pathname],
  bundle: true, write: false, platform: 'node', format: 'cjs', jsx: 'automatic',
  external: ['react', 'react/jsx-runtime'], loader: { '.css': 'text' },
  logLevel: 'silent',
})
const waits = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const document = id => ({ schemaVersion: 1, kind: 'paper-flow-document', paper: { id, title: id }, flows: [{ id: 'main', name: 'Synthetic', nodes: [{ id: 'n', label: 'Node', type: 'method', ports: { in: {}, out: {} } }], edges: [] }] })
const walk = element => !element || typeof element !== 'object' ? [] : [element, ...[element.props?.children].flat(9).flatMap(walk)]

function fixture() {
  const slots = [], effects = [], changes = []; let cursor = 0
  const hook = value => { const index = cursor++; return slots[index] ||= { current: value } }
  const react = {
    forwardRef: fn => fn,
    useRef: hook,
    useState: initial => { const slot = hook(initial); return [slot.current, value => { slot.current = typeof value === 'function' ? value(slot.current) : value }] },
    useEffect: callback => { const slot = hook(null); if (!slot.current) { slot.current = callback(); effects.push(slot.current) } },
    useImperativeHandle: (ref, callback) => { if (ref) ref.current = callback() },
    useMemo: callback => callback(),
  }
  const jsx = (type, props) => ({ type, props: props || {} })
  const module = { exports: {} }
  new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(name => {
    if (name === 'react') return react
    if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx, Fragment: 'fragment' }
    throw Error(`Unexpected import: ${name}`)
  }, module, module.exports)
  let workspace = createWorkspace([document('original')])
  const ref = {}
  const render = next => {
    if (next) workspace = next
    cursor = 0
    return module.exports.PaperFlowWorkbench({ workspace, onWorkspaceChange: value => changes.push(value) }, ref)
  }
  const element = (tree, type, match) => walk(tree).find(item => item.type === type && match(item.props))
  const begin = (tree, file) => element(tree, 'input', props => props['aria-label'] === '导入论文或工作区 JSON').props.onChange({ target: { files: [file], value: 'chosen' } })
  return { render, begin, element, changes, ref, unmount: () => effects.forEach(cleanup => cleanup?.()) }
}

test('late file reads cannot replace a workspace edited before the parent rerenders', async () => {
  const f = fixture(), tree = f.render(), waiting = waits()
  const importing = f.begin(tree, { size: 100, text: () => waiting.promise })
  const zoom = f.element(tree, 'button', props => props.children === '＋')
  zoom.props.onClick()
  assert.equal(f.changes.length, 1, 'ordinary editing proceeds immediately')
  waiting.resolve(JSON.stringify(document('stale'))); await importing
  assert.equal(f.changes.length, 1, 'late import cannot replace the edit')
})

test('workspace replacement, a newer import and unmount invalidate older reads', async () => {
  const f = fixture(); let tree = f.render(), first = waits()
  let importing = f.begin(tree, { size: 100, text: () => first.promise })
  tree = f.render(createWorkspace([document('replacement')]))
  first.resolve(JSON.stringify(document('stale'))); await importing
  assert.equal(f.changes.length, 0)
  const older = waits(), newer = waits()
  const firstImport = f.begin(tree, { size: 100, text: () => older.promise })
  const secondImport = f.begin(tree, { size: 100, text: () => newer.promise })
  newer.resolve(JSON.stringify(document('newer'))); await secondImport
  older.resolve(JSON.stringify(document('older'))); await firstImport
  assert.equal(f.changes.length, 1)
  assert.equal(f.changes[0].documents[0].paper.id, 'newer')
  tree = f.render(createWorkspace([document('after')])); first = waits()
  importing = f.begin(tree, { size: 100, text: () => first.promise })
  f.unmount(); first.resolve(JSON.stringify(document('unmounted'))); await importing
  assert.equal(f.changes.length, 1)
})

test('imperative reload and a later oversize selection invalidate pending file reads', async () => {
  const f = fixture(), tree = f.render(), first = waits()
  let pending = f.begin(tree, { size: 100, text: () => first.promise })
  assert.equal(f.ref.current.load(JSON.stringify(document('reloaded'))).ok, true)
  first.resolve(JSON.stringify(document('stale'))); await pending
  assert.equal(f.changes.length, 1)
  assert.equal(f.changes[0].documents[0].paper.id, 'reloaded')
  const second = waits(); let oversizeRead = false
  pending = f.begin(tree, { size: 100, text: () => second.promise })
  await f.begin(tree, { size: 192 * 1024 + 1, text: () => { oversizeRead = true } })
  second.resolve(JSON.stringify(document('stale-again'))); await pending
  assert.equal(oversizeRead, false)
  assert.equal(f.changes.length, 1)
})
