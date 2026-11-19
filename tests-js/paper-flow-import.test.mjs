import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveObjectURL } from 'node:buffer'
import { build } from 'esbuild'
import { createWorkspace } from '../vendor/paper-flow/document.js'

// Exercise the real component event handler with deterministic React hooks;
// no browser, private files or real workspace are involved.
const compiled = await build({
  entryPoints: [new URL('../vendor/paper-flow/PaperFlowWorkbench.tsx', import.meta.url).pathname],
  bundle: true, write: false, platform: 'node', format: 'cjs', jsx: 'automatic',
  external: ['react', 'react-dom', 'react/jsx-runtime'], loader: { '.css': 'text' },
  logLevel: 'silent',
})
const waits = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const document = id => ({ schemaVersion: 1, kind: 'paper-flow-document', paper: { id, title: id }, flows: [{ id: 'main', name: 'Synthetic', nodes: [{ id: 'n', label: 'Node', type: 'method', ports: { in: {}, out: {} } }], edges: [] }] })
const walk = element => !element || typeof element !== 'object' ? [] : [element, ...[element.props?.children].flat(9).flatMap(walk)]

function fixture(options = {}) {
  const slots = [], effects = new Set(), changes = []; let cursor = 0
  const hook = value => { const index = cursor++; return slots[index] ||= { current: value } }
  const react = {
    forwardRef: fn => fn,
    useRef: hook,
    useState: initial => { const slot = hook(initial); return [slot.current, value => { slot.current = typeof value === 'function' ? value(slot.current) : value }] },
    useEffect: (callback, dependencies) => {
      const slot = hook(null)
      if (!slot.current || dependencies.some((value, i) => !Object.is(value, slot.current.dependencies[i]))) {
        slot.current?.cleanup?.()
        slot.current = { dependencies, cleanup: callback() }
        effects.add(slot)
      }
    },
    useImperativeHandle: (ref, callback) => { if (ref) ref.current = callback() },
    useMemo: callback => callback(),
  }
  const jsx = (type, props) => ({ type, props: props || {} })
  const module = { exports: {} }
  new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(name => {
    if (name === 'react') return react
    if (name === 'react-dom') return { createPortal: (children, container) => ({ type: 'portal', container, props: { children } }) }
    if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx, Fragment: 'fragment' }
    throw Error(`Unexpected import: ${name}`)
  }, module, module.exports)
  let workspace = createWorkspace([document('original')])
  const ref = {}
  const render = next => {
    if (next) workspace = next
    cursor = 0
    return module.exports.PaperFlowWorkbench({ workspace, onWorkspaceChange: value => changes.push(value), ...options }, ref)
  }
  const element = (tree, type, match) => walk(tree).find(item => item.type === type && match(item.props))
  const begin = (tree, file) => element(tree, 'input', props => props['aria-label'] === '导入论文或工作区 JSON').props.onChange({ target: { files: [file], value: 'chosen' } })
  return { render, begin, element, changes, ref, unmount: () => effects.forEach(slot => slot.current.cleanup?.()) }
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

test('JSON chooser is a real button and reports the selected filename while reading', async () => {
  const f = fixture(), tree = f.render(), waiting = waits()
  const chooser = f.element(tree, 'button', props => props.children === '导入 JSON')
  const input = f.element(tree, 'input', props => props['aria-label'] === '导入论文或工作区 JSON')
  let clicks = 0; input.props.ref.current = { click: () => { clicks++ } }
  chooser.props.onClick(); assert.equal(clicks, 1)
  assert.equal(input.props.className, 'paper-flow-file-input')
  const pending = f.begin(tree, { name: 'synthetic.json', size: 100, text: () => waiting.promise })
  const reading = f.element(f.render(), 'span', props => props.className === 'paper-flow-file-name')
  assert.match(reading.props.children, /正在读取 synthetic\.json/)
  waiting.resolve(JSON.stringify(document('loaded'))); await pending
  assert.equal(f.changes[0].documents[0].paper.id, 'loaded')
  const done = f.element(f.render(), 'span', props => props.className === 'paper-flow-file-name')
  assert.equal(done.props.children, 'synthetic.json')
  const save = f.element(tree, 'button', props => props.children === '保存工作区')
  assert.equal(save.props.className, 'paper-flow-save-workspace')
  assert.match(save.props.title, /下载.*JSON/)
})

test('drop uses the chooser gate and owner guard; multiple files and text preserve the workspace', async () => {
  const f = fixture(); let tree = f.render(); let prevented = 0, stopped = 0, reads = 0
  const root = () => f.element(tree, 'section', props => props['aria-label'] === '通用论文流程工作台')
  const event = files => ({ dataTransfer: { files, types: files.length ? ['Files'] : ['text/plain'] }, preventDefault: () => { prevented++ }, stopPropagation: () => { stopped++ } })
  const file = (name, text) => ({ name, size: 100, text: () => { reads++; return Promise.resolve(text) } })
  root().props.onDrop(event([file('first.json', '{}'), file('second.json', '{}')]))
  await new Promise(setImmediate); tree = f.render()
  assert.equal(reads, 0); assert.equal(f.changes.length, 0)
  assert.match(JSON.stringify(tree), /一次只能导入一个 JSON 文件/)
  root().props.onDrop(event([])); await new Promise(setImmediate); tree = f.render()
  assert.match(JSON.stringify(tree), /不支持链接或文字/)
  root().props.onDrop(event([file('wrong.pdf', '{}')])); await new Promise(setImmediate); tree = f.render()
  assert.equal(reads, 0); assert.match(JSON.stringify(tree), /仅支持 .json/)
  const waiting = waits()
  root().props.onDrop(event([{ name: 'slow.json', size: 100, text: () => waiting.promise }]))
  f.element(tree, 'button', props => props.children === '＋').props.onClick()
  waiting.resolve(JSON.stringify(document('stale-drop'))); await new Promise(setImmediate)
  assert.equal(f.changes.length, 1, 'a later edit wins over the dropped file')
  tree = f.render(f.changes[0])
  root().props.onDrop(event([file('fresh.json', JSON.stringify(document('fresh')))]))
  await new Promise(setImmediate)
  assert.equal(f.changes.at(-1).documents[0].paper.id, 'fresh')
  assert.equal(prevented, 5); assert.equal(stopped, 5)
})

test('full detail is an explicit switch and its question button explains the display without changing data', () => {
  const f = fixture(); let tree = f.render()
  const control = f.element(tree, 'button', props => props.role === 'switch')
  assert.equal(control.props['aria-label'], '完整细节')
  assert.equal(control.props['aria-checked'], true)
  const help = f.element(tree, 'button', props => props['aria-label'] === '完整细节与论文概览有什么区别')
  let focused = 0; help.props.ref.current = { focus: () => { focused++ } }
  help.props.onClick(); tree = f.render()
  const window = walk(tree).find(item => item.props?.kind === 'detail-help')
  assert.equal(window.props.open, true)
  assert.match(JSON.stringify(window), /paper_groups/)
  assert.match(JSON.stringify(window), /未声明分组时/)
  assert.equal(f.changes.length, 0)
  window.props.onClose(); assert.equal(focused, 1)
  control.props.onClick()
  assert.equal(f.changes[0].view.detail, 'overview')
  assert.equal(f.changes[0].documents[0].paper.id, 'original')
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

test('each toolbar has one owner, and moved controls still select, import, compare and open the original floating windows', async () => {
  const opts = { comparisonHost: {}, controlsHost: {}, toolbar: { type: 'button', props: { children: '宿主操作' } } }
  const f = fixture(opts)
  const portals = tree => walk(tree).filter(el => el.type === 'portal')
  const placed = (tree, container) => portals(tree).find(el => el.container === container)
  let tree = f.render()
  const controls = placed(tree, opts.controlsHost), comparison = placed(tree, opts.comparisonHost)
  assert.equal(portals(tree).length, 2)
  const trigger = (where, label) => f.element(where, 'button', props => props.children === label)
  assert.ok(trigger(comparison, '宿主操作')); assert.ok(trigger(comparison, '保存工作区')); assert.ok(trigger(comparison, '导入 JSON'))
  assert.ok(trigger(controls, 'SVG ↓')); assert.ok(trigger(controls, '图例')); assert.ok(trigger(controls, '＋'))
  assert.equal(walk(tree).filter(el => el.type === 'button' && el.props.children === '图例').length, 1)
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><title>Synthetic</title></svg>'
  walk(tree).find(el => typeof el.props?.onDrawing === 'function').props.onDrawing({ svg })
  const saved = [], originalDocument = globalThis.document
  try {
    globalThis.document = { createElement() { return { click() { saved.push({ name: this.download, blob: resolveObjectURL(this.href) }) } } } }
    trigger(controls, 'SVG ↓').props.onClick()
  } finally {
    if (originalDocument === undefined) delete globalThis.document
    else globalThis.document = originalDocument
  }
  assert.equal(saved[0].name, 'paper-flow.svg')
  assert.equal(await saved[0].blob.text(), svg)
  trigger(controls, '＋').props.onClick(); assert.equal(typeof f.changes.at(-1).view.zoom, 'number')
  const pick = f.element(comparison, 'select', props => props['aria-label'] === '论文与流程 B')
  pick.props.onChange({ target: { value: JSON.stringify({ documentId: 'original', flowId: 'main' }) } })
  tree = f.render(f.changes.at(-1))
  const report = trigger(placed(tree, opts.controlsHost), '比较报告')
  report.props.onClick()
  const opened = f.render()
  assert.equal(walk(opened).find(el => el.props?.kind === 'report').props.open, true)
  await f.begin(placed(opened, opts.comparisonHost), { name: 'import.json', size: 64, text: async () => JSON.stringify(document('new')) })
  assert.equal(f.changes.at(-1).selection.left.documentId, 'new')
  for (const host of ['comparisonHost', 'controlsHost']) {
    const row = f.render()
    opts[host] = null
    const mixed = f.render()
    assert.equal(portals(mixed).length, portals(row).length - 1)
    assert.ok(trigger(mixed, '导入 JSON')); assert.ok(trigger(mixed, '图例'))
  }
})

test('common-host fullscreen keeps both portals and exits on Escape, imperative exit, host replacement or unmount', () => {
  function makeHost() {
    const tokens = new Set(), events = new Map()
    return { tokens, events, classList: { add: t => tokens.add(t), remove: t => tokens.delete(t) },
      contains: node => node === 'inside', ownerDocument: { addEventListener: (t, fn) => events.set(t, fn), removeEventListener: t => events.delete(t) } }
  }
  const host = makeHost(), replacement = makeHost()
  const opts = { comparisonHost: {}, controlsHost: {}, fullscreenHost: host }
  const f = fixture(opts)
  const full = () => {
    f.element(f.render(), 'button', props => props.children === '全屏').props.onClick()
    return f.render()
  }
  let tree = full()
  assert.equal(host.tokens.has('paper-flow-host-fullscreen'), true)
  assert.doesNotMatch(tree.props.className, /is-fullscreen/u)
  assert.equal(walk(tree).filter(el => el.type === 'portal').length, 2)
  host.events.get('keydown')({key:'Escape', target:'outside'})
  assert.equal(f.element(f.render(), 'button', p => p.children === '退出全屏').props['aria-pressed'], true)
  host.events.get('keydown')({key:'Escape', target:'inside', preventDefault() {}})
  f.render(); assert.equal(host.tokens.size, 0)
  full(); f.ref.current.exitFullscreen(); f.render(); assert.equal(host.tokens.size, 0)
  full(); opts.fullscreenHost = replacement; f.render()
  assert.equal(host.tokens.size, 0); assert.equal(replacement.tokens.size, 1)
  f.unmount(); assert.equal(replacement.tokens.size, 0); assert.equal(replacement.events.size, 0)
  const legacy = fixture({ controlsHost: {} })
  legacy.element(legacy.render(), 'button', props => props.children === '全屏').props.onClick()
  tree = legacy.render()
  assert.match(tree.props.className, /is-fullscreen/u)
  assert.equal(walk(tree).filter(el => el.type === 'portal').length, 0)
  assert.ok(legacy.element(tree, 'button', p => p.children === '退出全屏'))
})

test('comparison portal keeps file and archive feedback visible while export feedback stays on the canvas', async () => {
  const comparisonHost = {}, f = fixture({ comparisonHost, controlsHost: {} })
  const pair = () => {
    const tree = f.render(), portal = walk(tree).find(el => el.container === comparisonHost)
    const canvas = tree.props.children.filter(child => child?.type !== 'portal')
    return { row: portal.props.children, canvas: { props: { children: canvas } } }
  }
  const notice = (where, role) => walk(where).filter(el => el.props?.role === role).map(el => JSON.stringify(el.props.children)).join(' ')
  const waiting = waits()
  let { row } = pair()
  const read = f.begin(row, { name: 'broken.json', size: 50, text: () => waiting.promise })
  assert.match(notice(pair().row, 'status'), /正在读取 broken\.json/)
  waiting.resolve('{'); await read
  let views = pair()
  assert.match(notice(views.row, 'alert'), /未载入.*JSON/)
  assert.doesNotMatch(notice(views.canvas, 'alert'), /未载入/)
  assert.equal(f.changes.length, 0)
  const documentBefore = globalThis.document
  try {
    const backup = () => f.element(pair().row, 'button', props => props.children === '保存工作区').props.onClick()
    globalThis.document = { createElement: () => ({ click() {} }) }; backup()
    assert.match(notice(pair().row, 'status'), /已发起工作区 JSON 备份下载/)
    globalThis.document = { createElement: () => ({ click() { URL.revokeObjectURL(this.href); throw Error('没有可用的下载位置') } }) }
    backup()
    assert.match(notice(pair().row, 'alert'), /工作区备份失败.*没有可用的下载位置/)
  } finally {
    if (documentBefore === undefined) delete globalThis.document
    else globalThis.document = documentBefore
  }
  f.element(f.render(), 'button', props => props.children === 'SVG ↓').props.onClick()
  views = pair()
  assert.match(notice(views.canvas, 'status'), /画布尚未生成/)
  assert.doesNotMatch(notice(views.row, 'status'), /画布尚未生成/)
})

test('a comparison-row drop stops at the row; sidebar and canvas drops use the same import owner', async () => {
  const host = {}, f = fixture({ comparisonHost: host })
  const tree = f.render(), row = walk(tree).find(el => el.container === host).props.children
  const waiting = waits(), file = { name: 'stale.json', size: 30, text: () => waiting.promise }
  const pending = f.ref.current.importFiles([file])
  let reads = 0, stopped = false
  const fresh = { name: 'fresh.json', size: 50, text: async () => { reads++; return JSON.stringify(document('fresh')) } }
  const event = { dataTransfer: { types: ['Files'], files: [fresh] }, preventDefault() {}, stopPropagation() { stopped = true } }
  for (const key of ['onDragEnter', 'onDragOver', 'onDragLeave']) {
    stopped = false
    row.props[key](event)
    assert.equal(stopped, true, key)
  }
  assert.equal(event.dataTransfer.dropEffect, 'copy')
  stopped = false
  row.props.onDrop(event)
  if (!stopped) tree.props.onDrop(event)
  if (!stopped) await f.ref.current.importFiles(event.dataTransfer.files)
  assert.equal(stopped, true)
  await new Promise(setImmediate)
  waiting.resolve(JSON.stringify(document('old'))); await pending
  assert.equal(reads, 1); assert.deepEqual(f.changes.map(w => w.selection.left.documentId), ['fresh'])
  const portal = () => walk(f.render()).find(el => el.container === host)
  assert.match(JSON.stringify(portal()), /已导入 fresh\.json/)
  await f.ref.current.importFiles([{ name: 'x.pdf', size: 10, text: async () => '' }])
  assert.match(JSON.stringify(portal()), /仅支持 .json/)
  const canvasEvent = { ...event, dataTransfer: { files: [] } }
  tree.props.onDrop(canvasEvent)
  const updated = f.render()
  assert.doesNotMatch(JSON.stringify(portal()), /不支持链接或文字/)
  assert.match(JSON.stringify(updated), /不支持链接或文字/)
})
