import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLocalStateStore } from '../src/local-state.mjs'
import { createBoardStore, BOARD_SNAPSHOT_PREFIX } from '../src/harness/board-store.mjs'
import { createBoardFlowStore } from '../src/harness/board-flow-store.mjs'
import { flowContextSelection, renderFlowContext } from '../src/harness/flow-context.mjs'
import { validateFlowWorkspace } from '../src/paper-flow/validation.mjs'
import { handleBoardRequest } from '../src/harness/board-tools.mjs'
import { build } from 'esbuild'

// 原生 DSH peer 不是独立源码测试的必需安装项；只替换宿主消息构造，引用解析与展开使用真实代码。
const compiled = await build({ entryPoints: [new URL('../src/harness/board-references.mjs', import.meta.url).pathname], bundle: true, write: false, format: 'cjs', platform: 'node', external: ['@deepseek-ai/dsh-llm'], logLevel: 'silent' })
const nativeRequire = (await import('node:module')).createRequire(import.meta.url)
const refs = { exports: {} }
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(name => name === '@deepseek-ai/dsh-llm' ? { createUserMessage: value => value, freezeMessage: value => value } : nativeRequire(name), refs, refs.exports)
const { boardReferenceToken, prepareBoardReferenceMessages, loggedBoardReference } = refs.exports
import { createFetchHandler } from '../src/http.mjs'

const node = id => ({ id, label: `合成节点 ${id}`, type: 'method', ports: { in: { input: { type: 'sample' } }, out: { output: { type: 'sample' } } }, detail: `输入明确说明 ${id}`, evidence: `合成依据 ${id}` })
const edge = (from, to, id = `${from}-${to}`) => ({ id, from: `${from}:output`, to: `${to}:input`, label: `已声明 ${from} 到 ${to}`, semantic: 'explicit' })
const document = () => ({ schemaVersion: 1, kind: 'paper-flow-document', paper: { id: 'doc', title: '合成教学文档', sources: ['synthetic:source'] }, flows: [{ id: 'main', name: '合成流程', nodes: ['a', 'b', 'c', 'd', 'sibling', 'unrelated'].map(node), edges: [edge('a', 'b'), edge('b', 'c'), edge('c', 'd'), edge('a', 'sibling')] }] })
const selection = input => flowContextSelection({ paper_id: 'doc', flow_id: 'main', ...input })
const render = (workspace, input = {}) => renderFlowContext(workspace, selection(input))

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'paper-flow-context-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const library = join(root, 'library'), home = join(root, 'home')
  await mkdir(library)
  const localState = createLocalStateStore({ library, home }), boards = createBoardStore({ localState })
  const parent = await boards.create({ board: { title: '合成引用板', nodes: [], edges: [] } })
  const flows = createBoardFlowStore({ localState, boards })
  const saved = await flows.save({ id: parent.board.id, workspace: document(), expectedRevision: 0 })
  return { localState, boards, flows, saved, id: parent.board.id, options: { library, localStateHome: home, localState, boards, boardFlows: flows } }
}

const request = f => ({ id: f.id, paper_id: 'doc', flow_id: 'main', node_id: 'b', expected_revision: f.saved.revision })

test('selected nodes include all directed upstream/downstream but exclude sibling branches and unrelated nodes', () => {
  const workspace = validateFlowWorkspace(document()), before = structuredClone(workspace)
  const result = render(workspace, { node_id: 'b' })
  assert.deepEqual(result.totals, { nodes: 4, edges: 3 })
  assert.deepEqual(result.selected, ['b'])
  for (const id of ['a', 'b', 'c', 'd']) assert.match(result.text, new RegExp(`"id":"${id}"`))
  for (const id of ['sibling', 'unrelated']) assert.equal(result.text.includes(`"id":"${id}"`), false)
  assert.match(result.text, /"scope":"选中节点"/)
  assert.match(result.text, /"scope":"上游"/)
  assert.match(result.text, /"scope":"下游"/)
  assert.match(result.text, /合成依据 b/)
  assert.equal(result.text.includes('因果证明'), false)
  assert.equal(result.truncated, false)
  assert.deepEqual(workspace, before)
})

test('whole graph, multiple explicit roots and cyclic reachability remain deterministic', () => {
  const workspace = validateFlowWorkspace(document())
  assert.deepEqual(render(workspace).totals, { nodes: 6, edges: 4 })
  const multi = render(workspace, { node_ids: ['b', 'unrelated'] })
  assert.deepEqual(multi.selected, ['b', 'unrelated'])
  assert.deepEqual(multi.totals, { nodes: 5, edges: 3 })
  workspace.documents[0].flows[0].edges.push(edge('d', 'a'))
  const first = render(workspace, { node_id: 'b' })
  assert.deepEqual(first, render(workspace, { node_id: 'b' }))
  assert.match(first.text, /上游及下游均可达/)
  assert.equal(first.totals.nodes, 5, 'cycle makes formerly sibling reachable downstream')
})

test('explicit reader relations are identified separately and unresolved display aliases never imply reachability', () => {
  const workspace = validateFlowWorkspace(document())
  const key = JSON.stringify(['doc', 'main', workspace.view.arrangement, workspace.view.treeLevels, workspace.view.detail, workspace.view.grouping])
  workspace.drafts[key] = { nodes: {}, edges: {}, relations: [edge('b', 'unrelated', 'reader-edge'), edge('display-group', 'unrelated', 'display-edge')] }
  const result = render(workspace, { node_id: 'b' })
  assert.equal(result.totals.nodes, 5)
  assert.match(result.text, /读者临时关系/)
  assert.match(result.text, /reader-edge/)
  assert.equal(result.text.includes('display-edge'), false)
  const whole = render(workspace)
  assert.match(whole.text, /显示别名未映射/)
  assert.match(whole.text, /display-edge/)
})

test('all content including headers fits actual budgets and every omission or partial declaration is explicit', () => {
  const workspace = validateFlowWorkspace(document())
  for (const n of workspace.documents[0].flows[0].nodes) { n.detail = '长说明'.repeat(2600); n.evidence = '合成证据'.repeat(2000) }
  for (const maximum of [500, 700, 1000, 24000]) {
    const result = render(workspace, { node_id: 'b', max_characters: maximum })
    assert.ok(result.text.length <= maximum, `${result.text.length} <= ${maximum}`)
    assert.equal(result.truncated, true)
    assert.match(result.text, /省略节点/)
    assert.equal(result.included.nodes + result.partial.nodes + result.omitted.nodes, result.totals.nodes)
    assert.equal(result.included.edges + result.partial.edges + result.omitted.edges, result.totals.edges)
  }
})

test('request identity, absent targets and budget errors fail rather than selecting a fallback', () => {
  const workspace = validateFlowWorkspace(document())
  for (const value of [{ node_ids: [] }, { node_ids: ['a', 'a'] }, { node_id: 'b', node_ids: ['b'] }, { max_characters: 499 }, { max_characters: 24001 }, { paper_id: '' }, { flow_id: null }]) assert.throws(() => selection(value), error => error.code === 'BOARD_FLOW_INVALID')
  for (const value of [{ node_id: 'missing' }, { paper_id: 'missing' }, { flow_id: 'missing' }]) assert.throws(() => render(workspace, value), error => error.code === 'BOARD_FLOW_TARGET_MISSING')
})

test('saved flow references are immutable, idempotent and expand through existing native board tokens', async t => {
  const f = await fixture(t), input = request(f)
  const first = await f.flows.snapshot(input), repeated = await f.flows.snapshot(input)
  assert.equal(first.snapshot_id, repeated.snapshot_id)
  assert.equal(first.flow.revision, f.saved.revision)
  assert.deepEqual(first.flow.node_ids, ['b'])
  assert.equal(first.board_id, f.id)
  assert.equal(first.characters, first.text.length)
  assert.equal(first.characters <= 24000, true)
  const parentBefore = await f.boards.read(f.id)
  const originalSnapshot = await f.boards.snapshotLoad(first.snapshot_id)
  const newer = document(); newer.flows[0].nodes[1].label = '后来修改的节点'
  await f.flows.save({ id: f.id, workspace: newer, expectedRevision: f.saved.revision })
  assert.deepEqual(await f.boards.snapshotLoad(first.snapshot_id), originalSnapshot)
  assert.deepEqual(await f.boards.read(f.id), parentBefore)
  const prepared = await prepareBoardReferenceMessages([{ source: { kind: 'user' }, content: [{ type: 'text', text: boardReferenceToken(f.id, first.snapshot_id) }] }], { boards: f.boards })
  assert.equal(prepared.length, 2)
  assert.equal(prepared[1].content[0].text, first.text)
  assert.ok(loggedBoardReference({ type: 'user/message', data: prepared[1] }))
  const record = await f.localState.get(BOARD_SNAPSHOT_PREFIX + first.snapshot_id)
  await f.localState.put(BOARD_SNAPSHOT_PREFIX + first.snapshot_id, { ...record.value, text: '篡改' }, record.revision)
  await assert.rejects(f.boards.snapshotLoad(first.snapshot_id), error => error.code === 'BOARD_SNAPSHOT_CORRUPT')
})

test('revision races and forbidden callers create no replacement snapshot', async t => {
  const f = await fixture(t), input = request(f)
  for (const expected_revision of [undefined, 0, 'f'.repeat(64)]) await assert.rejects(f.flows.snapshot({ ...input, expected_revision }), error => ['BOARD_FLOW_INVALID', 'STATE_CONFLICT'].includes(error.code))
  await assert.rejects(handleBoardRequest(f.boards, { action: 'board_flow_snapshot', ...input }, { writer: 'llm', flowStore: f.flows }), error => error.code === 'BOARD_FORBIDDEN')
  assert.equal((await f.localState.list({ prefix: BOARD_SNAPSHOT_PREFIX })).total, 0)
  const newer = await f.flows.save({ id: f.id, workspace: document(), expectedRevision: f.saved.revision })
  // Content-identical writes can retain the same revision; force an actual revision change.
  const doc = document(); doc.paper.title = '合成新版本'
  await f.flows.save({ id: f.id, workspace: doc, expectedRevision: newer.revision })
  await assert.rejects(f.flows.snapshot(input), error => error.code === 'STATE_CONFLICT')
  assert.equal((await f.localState.list({ prefix: BOARD_SNAPSHOT_PREFIX })).total, 0)
})

test('authenticated browser action freezes the specified flow and refuses stale or missing source identities', async t => {
  const f = await fixture(t), handler = createFetchHandler(f.options)
  async function call(payload) { const response = await handler(new Request('http://127.0.0.1/api', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })); return { status: response.status, body: await response.json() } }
  const frozen = await call({ action: 'board_flow_snapshot', ...request(f) })
  assert.equal(frozen.status, 200)
  assert.equal(frozen.body.result.flow.flow_id, 'main')
  const missing = await call({ action: 'board_flow_snapshot', ...request(f), node_id: 'absent' })
  assert.equal(missing.status, 404)
  const wrong = await call({ action: 'board_flow_snapshot', ...request(f), expected_revision: 'f'.repeat(64) })
  assert.equal(wrong.status, 409)
})
