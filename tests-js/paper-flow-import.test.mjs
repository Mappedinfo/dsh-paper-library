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

test('legend opens without changing the canvas and comparison controls require a second flow', () => {
  const f = fixture(); let tree = f.render()
  const button = (root, text) => f.element(root, 'button', props => props.children === text)
  assert.ok(button(tree, '图例'))
  assert.equal(button(tree, '比较报告'), undefined)
  assert.equal(button(tree, '人工对应与排除'), undefined)
  const before = f.element(tree, 'div', props => props.className === 'paper-flow-single')
  const trigger = button(tree, '图例'); let focused = 0; trigger.props.ref.current = { focus: () => { focused++ } }
  trigger.props.onClick(); tree = f.render()
  const legend = walk(tree).find(item => item.props?.kind === 'legend')
  assert.equal(legend.props.open, true)
  assert.equal(button(tree, '图例').props['aria-expanded'], true)
  assert.equal(f.element(tree, 'div', props => props.className === 'paper-flow-single').type, before.type)
  assert.equal(f.changes.length, 0)
  legend.props.onClose(); tree = f.render()
  assert.equal(focused, 1)
  assert.equal(walk(tree).find(item => item.props?.kind === 'legend').props.open, false)
})

test('adding a manual correspondence leaves its non-modal window open', () => {
  const f = fixture(), workspace = createWorkspace([document('a'), document('b')], { left: { documentId: 'a', flowId: 'main' }, right: { documentId: 'b', flowId: 'main' } })
  let tree = f.render(workspace)
  const button = (root, text) => f.element(root, 'button', props => props.children === text)
  const current = () => walk(tree).find(item => item.props?.kind === 'manual')
  button(tree, '人工对应与排除').props.onClick(); tree = f.render()
  let selects = walk(current()).filter(item => item.type === 'select')
  selects[1].props.onChange({ target: { value: 'n' } }); tree = f.render()
  selects = walk(current()).filter(item => item.type === 'select')
  selects[2].props.onChange({ target: { value: 'n' } }); tree = f.render()
  walk(current()).find(item => item.type === 'input' && item.props.value === '').props.onChange({ target: { value: '合成理由' } })
  tree = f.render(); button(current(), '添加对应').props.onClick(); tree = f.render()
  assert.equal(f.changes.length, 1)
  assert.equal(f.changes[0].comparison.correspondences[0].reason, '合成理由')
  assert.equal(current().props.open, true)
})

test('canvas clicks choose manual correspondence nodes without covering the window with node details', () => {
  const f = fixture(), workspace = createWorkspace([document('a'), document('b')], { left: { documentId: 'a', flowId: 'main' }, right: { documentId: 'b', flowId: 'main' } })
  let tree = f.render(workspace)
  const flow = () => walk(tree).find(item => item.type?.name === 'FlowCompare')
  const manual = () => walk(tree).find(item => item.props?.kind === 'manual')
  const button = text => f.element(tree, 'button', props => props.children === text)
  flow().props.onNodeSelect('a', 'n'); tree = f.render()
  assert.ok(f.element(tree, 'aside', props => props['aria-label'] === '节点详情'))
  button('人工对应与排除').props.onClick(); tree = f.render()
  assert.equal(f.element(tree, 'aside', props => props['aria-label'] === '节点详情'), undefined)
  flow().props.onNodeSelect('a', 'n'); flow().props.onNodeSelect('b', 'n'); tree = f.render()
  const selects = walk(manual()).filter(item => item.type === 'select')
  assert.equal(selects[1].props.value, 'n'); assert.equal(selects[2].props.value, 'n')
  assert.equal(manual().props.open, true)
  assert.equal(f.element(tree, 'aside', props => props['aria-label'] === '节点详情'), undefined)
  manual().props.onClose(); tree = f.render()
  flow().props.onNodeSelect('a', 'n'); tree = f.render()
  assert.ok(f.element(tree, 'aside', props => props['aria-label'] === '节点详情'))
})

test('comparison and manual windows keep drafts when closed, but close when the selected pair changes', () => {
  const f = fixture()
  const a = document('a'), b = document('b'), c = document('c')
  const workspace = createWorkspace([a, b, c], { left: { documentId: 'a', flowId: 'main' }, right: { documentId: 'b', flowId: 'main' } })
  const button = (root, text) => f.element(root, 'button', props => props.children === text)
  let tree = f.render(workspace)
  assert.ok(button(tree, '比较报告')); assert.ok(button(tree, '人工对应与排除'))
  const canvas = walk(tree).find(item => item.type?.name === 'FlowCompare')
  button(tree, '比较报告').props.onClick(); button(tree, '人工对应与排除').props.onClick()
  tree = f.render()
  let manual = walk(tree).find(item => item.props?.kind === 'manual')
  assert.equal(manual.props.open, true)
  assert.equal(walk(tree).find(item => item.props?.kind === 'report').props.open, true)
  assert.equal(walk(tree).find(item => item.type?.name === 'FlowCompare').type, canvas.type)
  const unchanged = walk(tree).find(item => item.type?.name === 'FlowCompare')
  for (const key of ['draftA', 'draftB', 'mergedDraft']) assert.equal(unchanged.props[key], canvas.props[key], 'opening a window must not create a new canvas draft')
  const reason = walk(manual).find(item => item.type === 'input' && item.props.value === '')
  reason.props.onChange({ target: { value: '合成对应理由' } })
  tree = f.render(); manual = walk(tree).find(item => item.props?.kind === 'manual')
  manual.props.onClose(); tree = f.render()
  assert.equal(walk(tree).find(item => item.props?.kind === 'manual').props.open, false)
  button(tree, '人工对应与排除').props.onClick(); tree = f.render()
  manual = walk(tree).find(item => item.props?.kind === 'manual')
  assert.equal(walk(manual).find(item => item.type === 'input' && item.props.value === '合成对应理由').props.value, '合成对应理由')
  tree = f.render({ ...workspace, selection: { ...workspace.selection, right: { documentId: 'c', flowId: 'main' } } })
  assert.equal(walk(tree).find(item => item.props?.kind === 'manual').props.open, false)
  assert.equal(walk(tree).find(item => item.props?.kind === 'report').props.open, false)
})
