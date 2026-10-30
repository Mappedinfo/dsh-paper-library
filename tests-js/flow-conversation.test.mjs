import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFile } from 'node:fs/promises'
import { build } from 'esbuild'

const bridgeSource = await readFile(new URL('../web/board-bridge.js', import.meta.url), 'utf8')
const compiled = await build({ entryPoints: [new URL('../src/paper-flow/main.tsx', import.meta.url).pathname], bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic', loader: { '.css': 'empty' }, external: ['react', 'react-dom/client', 'react/jsx-runtime', '../../vendor/paper-flow/index'], logLevel: 'silent' })
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const tick = () => new Promise(resolve => setImmediate(resolve))
const workspace = () => ({ schemaVersion: 1, kind: 'paper-flow-document', paper: { id: 'doc', title: '合成资料' }, flows: [{ id: 'flow', name: '合成流程', nodes: [{ id: 'n', label: '合成节点', type: 'method', ports: { in: {}, out: {} } }], edges: [] }] })

function bridgeFixture() {
  let boardId = 'b-current', sessionId = 'session-current', live = true
  const posted = [], messages = [], timers = new Map(), listeners = new Map()
  let serial = 0
  const parent = { postMessage: (data, origin) => posted.push({ data, origin }) }
  const view = { parent, location: { origin: 'https://synthetic.invalid' }, addEventListener(type, callback) { listeners.set(type, callback) }, removeEventListener(type) { listeners.delete(type) } }
  const window = {}
  vm.runInNewContext(bridgeSource, { window, setTimeout(callback) { const id = ++serial; timers.set(id, callback); return id }, clearTimeout: id => timers.delete(id) })
  const bridge = window.PaperBoardBridge.create({ doc: { defaultView: view }, api: () => { throw Error('sendSnapshot must not call an API') }, capabilities: () => ({ conversation: true }), boardId: () => boardId, sessionId: () => sessionId, live: () => live, board: () => ({ title: '合成标题' }), toast: text => messages.push(text) })
  bridge.listen()
  return { bridge, posted, messages, timers, setBoard: id => { boardId = id }, setSession: id => { sessionId = id }, setLive: value => { live = value }, answer(data, source = parent, origin = view.location.origin) { bridge.onResult({ data, source, origin }) }, parent, view }
}

test('flow composer bridge posts frozen identity only, validates host answers and never sends a model request', async () => {
  const f = bridgeFixture(), frozen = { board_id: 'b-current', snapshot_id: 'a'.repeat(64), board_title: '合成流程', text: '私人材料不应进入 postMessage', nodes: [{ label: '不得发送' }] }
  try {
    const pending = f.bridge.sendSnapshot(frozen, 'session-current')
    assert.equal(f.posted.length, 1)
    const { data, origin } = f.posted[0]
    assert.equal(origin, 'https://synthetic.invalid')
    assert.deepEqual(Object.keys(data).sort(), ['type', 'version', 'requestId', 'action', 'sessionId', 'board_id', 'snapshot_id', 'title'].sort())
    assert.equal(data.action, 'board_draft')
    assert.equal(data.snapshot_id, frozen.snapshot_id)
    assert.equal(JSON.stringify(data).includes(frozen.text), false)
    f.answer({ type: 'paper-library:conversation-result', version: 1, requestId: data.requestId, ok: true }, {}, origin)
    assert.equal(f.bridge.pendingCount(), 1)
    f.answer({ type: 'paper-library:conversation-result', version: 1, requestId: data.requestId, ok: true }, f.parent, 'https://elsewhere.invalid')
    assert.equal(f.bridge.pendingCount(), 1)
    f.answer({ type: 'paper-library:conversation-result', version: 1, requestId: data.requestId, ok: true })
    assert.equal(await pending, true)
    assert.equal(f.timers.size, 0)
  } finally { f.bridge.dispose() }
})

test('stale board/session, absent session, disposed panel and invalid snapshots cannot post a flow reference', async () => {
  const frozen = { board_id: 'b-current', snapshot_id: 'a'.repeat(64) }
  for (const change of [f => f.setBoard('b-other'), f => f.setSession('session-other'), f => f.setLive(false)]) {
    const f = bridgeFixture(); change(f)
    try { assert.equal(await f.bridge.sendSnapshot(frozen, 'session-current'), false); assert.equal(f.posted.length, 0) } finally { f.bridge.dispose() }
  }
  const f = bridgeFixture()
  try {
    for (const value of [null, '', '  ']) { f.setSession(value); assert.equal(await f.bridge.sendSnapshot(frozen, value), false) }
    f.setSession('session-current')
    for (const value of [null, { ...frozen, snapshot_id: ['a'.repeat(64)] }, { ...frozen, snapshot_id: 'bad' }]) assert.equal(await f.bridge.sendSnapshot(value, 'session-current'), false)
    assert.equal(f.posted.length, 0)
  } finally { f.bridge.dispose() }
})

function hostFixture({ snapshot, save } = {}) {
  const calls = [], sent = [], messages = [], view = { addEventListener() {}, removeEventListener() {} }
  let rendered, sessionId = 'session-current', revision = 'a'.repeat(64), value = workspace()
  const root = { hidden: false, querySelectorAll: () => [] }
  const jsx = (type, props) => ({ type, props: props || {} })
  const module = { exports: {} }
  const react = { Component: class {}, useEffect() {}, useRef: current => ({ current }), useState: initializer => [typeof initializer === 'function' ? initializer() : initializer, () => {}] }
  new Function('require', 'module', 'exports', 'window', compiled.outputFiles[0].text)(name => {
    if (name === 'react') return react
    if (name === 'react-dom/client') return { createRoot: () => ({ render: element => { rendered = element }, unmount() {} }) }
    if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx }
    if (name === '../../vendor/paper-flow/index') return { PaperFlowWorkbench() {} }
    throw Error(`Unexpected module ${name}`)
  }, module, module.exports, view)
  const flow = view.PaperBoardFlow.create({ root, toast: message => messages.push(message), onClose() {}, getSessionId: () => sessionId,
    async api(action, args) {
      calls.push({ action, args })
      if (action === 'board_flow_get') return { id: args.id, workspace: value, revision }
      if (action === 'board_flow_save') { if (save) return save(args); value = args.workspace; revision = 'b'.repeat(64); return { id: args.id, workspace: value, revision } }
      if (action === 'board_flow_snapshot') return snapshot ? snapshot(args) : { board_id: args.id, snapshot_id: 'c'.repeat(64), text: '有界合成快照' }
      throw Error(`Unexpected action ${action}`)
    }, async sendSnapshot(...args) { sent.push(args); return true } })
  return { flow, calls, sent, messages, props: () => rendered.props, setSession: value => { sessionId = value } }
}

test('flow host flushes current edits before freezing exact saved revision and selected source nodes', async () => {
  const f = hostFixture()
  try {
    await f.flow.open({ id: 'b-current', title: '合成板' })
    const current = f.props().controller.state().workspace
    current.documents[0].flows[0].nodes[0].label = '修改后的合成节点'
    f.props().controller.edit(current)
    await f.props().send({ documentId: 'doc', flowId: 'flow' }, ['n'])
    assert.deepEqual(f.calls.map(call => call.action), ['board_flow_get', 'board_flow_save', 'board_flow_snapshot'])
    assert.deepEqual(f.calls.at(-1).args, { id: 'b-current', paper_id: 'doc', flow_id: 'flow', node_ids: ['n'], expected_revision: 'b'.repeat(64) })
    assert.equal(f.sent.length, 1)
    assert.equal(f.sent[0][1], 'session-current')
  } finally { f.flow.dispose() }
})

test('late flow snapshots cannot enter a newly edited, switched or closed host or another session', async () => {
  for (const change of [async f => { const current = f.props().controller.state().workspace; current.documents[0].paper.title = '新的草稿'; f.props().controller.edit(current) }, async f => { f.setSession('session-new') }, async f => { await f.flow.close() }, async f => { await f.flow.open({ id: 'b-other', title: '另一张' }) }]) {
    const late = deferred(), f = hostFixture({ snapshot: () => late.promise })
    try {
      await f.flow.open({ id: 'b-current', title: '合成板' })
      const sending = f.props().send({ documentId: 'doc', flowId: 'flow' }, ['n'])
      await tick()
      assert.equal(f.calls.at(-1).action, 'board_flow_snapshot')
      await change(f)
      late.resolve({ board_id: 'b-current', snapshot_id: 'c'.repeat(64), text: '旧材料' })
      await sending
      assert.equal(f.sent.length, 0)
      assert.match(f.messages.at(-1), /页面或会话已切换/)
    } finally { f.flow.dispose() }
  }
})

test('unsaved/conflicting source and absent DSH session never freeze or post flow material', async () => {
  const blocked = hostFixture({ save: async () => { throw Error('合成保存冲突') } })
  try {
    await blocked.flow.open({ id: 'b-current', title: '合成板' })
    blocked.props().controller.edit(blocked.props().controller.state().workspace)
    await blocked.props().send({ documentId: 'doc', flowId: 'flow' })
    assert.equal(blocked.calls.some(call => call.action === 'board_flow_snapshot'), false)
    assert.equal(blocked.sent.length, 0)
  } finally { blocked.flow.dispose() }
  const empty = hostFixture()
  try {
    await empty.flow.open({ id: 'b-current', title: '合成板' })
    empty.setSession(null)
    await empty.props().send({ documentId: 'doc', flowId: 'flow' })
    assert.equal(empty.calls.some(call => call.action === 'board_flow_snapshot'), false)
    assert.equal(empty.sent.length, 0)
  } finally { empty.flow.dispose() }
})
