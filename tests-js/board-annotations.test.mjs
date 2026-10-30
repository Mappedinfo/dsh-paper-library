import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import vm from 'node:vm'
import { createLocalStateStore } from '../src/local-state.mjs'
import { createBoardStore } from '../src/harness/board-store.mjs'
import { createBoardFlowStore } from '../src/harness/board-flow-store.mjs'
import { createBoardAnnotationStore, handleBoardAnnotationRequest, BOARD_ANNOTATION_KEY_PREFIX } from '../src/harness/board-annotations.mjs'
import { normalizeBoardAnnotationTarget, normalizeBoardAnnotationRecord, BOARD_ANNOTATION_LIMITS } from '../src/board-annotation-schema.mjs'
const document = { schemaVersion: 1, kind: 'paper-flow-document', paper: { id: 'example', title: '合成资料' }, flows: [{ id: 'main', name: '合成流程', nodes: [{ id: 'input', label: '输入', type: 'data', ports: { in: {}, out: {} }, detail: '明确声明的输入说明' }], edges: [] }] }
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'board-annotations-')); t.after(() => rm(root, { recursive: true, force: true })); const library = join(root, 'library'); await mkdir(library)
  const localState = createLocalStateStore({ library, home: join(root, 'home') }), boards = createBoardStore({ localState }), flowStore = createBoardFlowStore({ localState, boards })
  const parent = await boards.create({ board: { title: '合成画板', nodes: [{ id: 'node', kind: 'text', text: '原始节点文字', x: 0, y: 0 }], edges: [] } }); const id = parent.board.id
  const flow = await flowStore.save({ id, workspace: document, expectedRevision: 0 })
  return { localState, boards, flowStore, parent, flow, id, store: createBoardAnnotationStore({ localState, boards, flowStore }) }
}
test('board and flow annotations snapshot explicit labels and live independently of source records', async t => {
  const f = await fixture(t), original = await f.boards.read(f.id)
  assert.deepEqual(await f.store.list(f.id), { id: f.id, revision: 0, notes: [] })
  const a = await f.store.create({ id: f.id, expectedRevision: 0, target: { kind: 'board', node_ids: ['node'], x: 1.111, y: 2.222 }, comment: '读者问题' })
  assert.equal(a.notes[0].quote, '原始节点文字'); assert.equal(a.notes[0].target.x, 1.11)
  const b = await f.store.create({ id: f.id, expectedRevision: a.revision, target: { kind: 'flow', paper_id: 'example', flow_id: 'main', node_id: 'input' }, comment: '流程问题' })
  assert.match(b.notes[1].quote, /明确声明的输入说明/); assert.deepEqual((await f.store.list(f.id)).notes.map(note => note.stale), [false, false])
  assert.deepEqual(await f.boards.read(f.id), original)
  assert.deepEqual(await f.flowStore.get(f.id), f.flow)
  const fresh = createBoardAnnotationStore({ localState: f.localState, boards: f.boards, flowStore: f.flowStore }); assert.deepEqual(await fresh.list(f.id), await f.store.list(f.id))
})
test('annotation CAS prevents concurrent initialization and stale editing from losing a reader note', async t => {
  const f = await fixture(t), args = { id: f.id, expectedRevision: 0, target: { kind: 'board' }, comment: '第一条' }
  const writes = await Promise.allSettled([f.store.create(args), f.store.create({ ...args, comment: '另一条' })]); assert.equal(writes.filter(item => item.status === 'fulfilled').length, 1)
  assert.equal(writes.find(item => item.status === 'rejected').reason.code, 'STATE_CONFLICT')
  const current = await f.store.list(f.id), note = current.notes[0]
  const changed = await f.store.update({ id: f.id, noteId: note.id, comment: '修改后', expectedRevision: current.revision })
  await assert.rejects(f.store.remove({ id: f.id, noteId: note.id, expectedRevision: current.revision }), error => error.code === 'STATE_CONFLICT')
  assert.equal((await f.store.list(f.id)).notes[0].comment, '修改后')
  assert.equal((await f.store.remove({ id: f.id, noteId: note.id, expectedRevision: changed.revision })).notes.length, 0)
})
test('removed board or flow nodes leave stale annotations with the original quote and editable comments', async t => {
  const f = await fixture(t)
  const boardNote = await f.store.create({ id: f.id, expectedRevision: 0, target: { kind: 'board', node_ids: ['node'] }, comment: '保留想法' })
  const flowNote = await f.store.create({ id: f.id, expectedRevision: boardNote.revision, target: { kind: 'flow', paper_id: 'example', flow_id: 'main', node_id: 'input' }, comment: '保留流程问题' })
  await f.boards.save({ id: f.id, board: { ...f.parent.board, nodes: [] }, expectedRevision: f.parent.revision })
  const workspace = structuredClone(f.flow.workspace); workspace.documents[0].flows[0].nodes[0].id = 'replacement'
  await f.flowStore.save({ id: f.id, workspace, expectedRevision: f.flow.revision })
  const stale = await f.store.list(f.id); assert.deepEqual(stale.notes.map(note => note.stale), [true, true]); assert.equal(stale.notes[0].quote, '原始节点文字')
  const updated = await f.store.update({ id: f.id, noteId: stale.notes[1].id, comment: '目标失效后补充', expectedRevision: flowNote.revision }); assert.equal(updated.notes[1].quote, flowNote.notes[1].quote)
  await assert.rejects(f.store.create({ id: f.id, expectedRevision: updated.revision, target: { kind: 'board', node_ids: ['node'] }, comment: '无效目标' }), error => error.code === 'BOARD_ANNOTATION_TARGET_MISSING')
})
test('explicit flow member groups retain all node identities and detect removed members', async t => {
  const f = await fixture(t), workspace = structuredClone(f.flow.workspace)
  workspace.documents[0].flows[0].nodes.push({ id: 'analysis', label: '分析', type: 'method', detail: '明确声明的分析说明', ports: { in: {}, out: {} } })
  const saved = await f.flowStore.save({ id: f.id, workspace, expectedRevision: f.flow.revision })
  const created = await f.store.create({ id: f.id, expectedRevision: 0, target: { kind: 'flow', paper_id: 'example', flow_id: 'main', node_ids: ['input','analysis'] }, comment: '批注这一组' })
  assert.match(created.notes[0].quote, /明确声明的输入说明/); assert.match(created.notes[0].quote, /明确声明的分析说明/)
  assert.deepEqual(created.notes[0].target.node_ids, ['input','analysis'])
  workspace.documents[0].flows[0].nodes.pop(); await f.flowStore.save({ id: f.id, workspace, expectedRevision: saved.revision })
  assert.equal((await f.store.list(f.id)).notes[0].stale, true)
  assert.throws(() => normalizeBoardAnnotationTarget({ kind: 'flow', paper_id: 'example', flow_id: 'main', node_id: 'input', node_ids: ['input'] }))
})
test('invalid targets, missing revisions, oversized comments and model writes cannot change annotations', async t => {
  const f = await fixture(t)
  for (const target of [{ kind: 'flow', paper_id: 'example' }, { kind: 'board', node_ids: ['node','node'] }, { kind: 'board', x: 1 }, { kind: 'board', paper_id: 'bad' }, { kind: 'board', node_ids: ['../bad'] }]) assert.throws(() => normalizeBoardAnnotationTarget(target))
  await assert.rejects(f.store.create({ id: f.id, target: { kind: 'board' }, comment: '缺修订' }))
  await assert.rejects(f.store.create({ id: f.id, expectedRevision: 0, target: { kind: 'board' }, comment: '字'.repeat(4001) }))
  for (const action of ['board_annotations_list','board_annotations_create','board_annotations_update','board_annotations_delete']) await assert.rejects(handleBoardAnnotationRequest(f.store, { action, id: f.id }, { writer: 'llm' }), error => error.code === 'BOARD_FORBIDDEN')
  assert.equal((await f.store.list(f.id)).notes.length, 0)
  await assert.rejects(f.store.list('../bad'))
  await f.localState.put(`${BOARD_ANNOTATION_KEY_PREFIX}${f.id}`, { bad: 'data' }, 0)
  await assert.rejects(f.store.list(f.id), error => error.code === 'BOARD_ANNOTATION_CORRUPT')
  assert.deepEqual((await f.localState.get(`${BOARD_ANNOTATION_KEY_PREFIX}${f.id}`)).value, { bad: 'data' })
})
test('schema limits bound whole annotation records before storage', () => {
  const note = { id: 'note', target: { kind: 'board' }, comment: '字'.repeat(4000), label: '', quote: '字'.repeat(2000), created_at: new Date().toISOString(), updated_at: new Date().toISOString() }
  assert.throws(() => normalizeBoardAnnotationRecord({ schema: 'paper-library-board-annotations.v1', notes: Array.from({ length: 20 }, (_, i) => ({ ...note, id: `note-${i}` })) }), error => error.code === 'BOARD_ANNOTATION_TOO_LARGE')
  assert.equal(BOARD_ANNOTATION_LIMITS.notes, 200)
})

const uiSource = await readFile(new URL('../web/board-annotations.js', import.meta.url), 'utf8')
function ui(api, options = {}) {
  class Element {
    constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.events = {}; this.dataset = {}; this.value = ''; this.textContent = ''; this.disabled = false; this.classList = { toggle() {} }; this.ownerDocument = doc }
    append(...items) { this.children.push(...items) } replaceChildren(...items) { this.children = items } setAttribute() {} focus() { this.focusCalls = (this.focusCalls || 0) + 1; doc.activeElement = this }
    addEventListener(name, fn) { (this.events[name] ||= []).push(fn) }
    async fire(name) { for (const fn of this.events[name] || []) await fn({ preventDefault() {} }) }
    querySelectorAll(tag) { return this.children.flatMap(child => [...(child.tagName === tag.toUpperCase() ? [child] : []), ...child.querySelectorAll(tag)]) }
  }
  const doc = { createElement: tag => new Element(tag), defaultView: { confirm: () => true } }, root = new Element('div'), window = {}, messages = []
  vm.runInNewContext(uiSource, { window }); let id = 'board-1', target = { kind: 'board' }
  const panel = window.PaperBoardAnnotations.create({ root, api, boardId: () => id, target: () => target, toast: text => messages.push(text), ...options })
  return { panel, root, messages, setId(value) { id = value }, textarea: () => root.querySelectorAll('textarea')[0], button: text => root.querySelectorAll('button').find(item => item.textContent === text), target(value) { target = value } }
}
const settle = async () => { await new Promise(resolve => setImmediate(resolve)) }
test('sidebar drafts survive a failed save, reload and attempted board switch', async () => {
  const calls = []
  const f = ui(async (action, args) => { calls.push([action,args]); if (action === 'board_annotations_list') return { revision: 'a'.repeat(64), notes: [] }; throw Object.assign(Error('版本冲突'), { code: 'STATE_CONFLICT' }) })
  assert.equal(await f.panel.open(), true)
  const field = f.textarea(); field.value = '未保存的想法'; await field.fire('input'); assert.equal(f.panel.hasDraft(), true); assert.equal(f.panel.prepareLeave(), false)
  await f.button('保存批注').fire('click'); await settle(); assert.equal(field.value, '未保存的想法')
  assert.equal(await f.panel.reload(), true); assert.equal(field.value, '未保存的想法')
  f.setId('board-2'); assert.equal(await f.panel.open(), false); assert.equal(field.value, '未保存的想法')
  await f.button('取消编辑').fire('click'); assert.equal(f.panel.hasDraft(), false); assert.equal(await f.panel.open(), true)
  assert.equal(calls.filter(([action]) => action === 'board_annotations_create').length, 1)
})
test('a late list reply cannot populate the rail of a newly selected board', async () => {
  let firstResolve; const f = ui(async (_action, args) => args.id === 'board-1' ? new Promise(resolve => { firstResolve = resolve }) : { revision: 0, notes: [] })
  const old = f.panel.open(); f.setId('board-2'); const newer = f.panel.open(); assert.equal(await newer, true)
  firstResolve({ revision: 'a'.repeat(64), notes: [{ id: 'stale', comment: '旧板内容', target: { kind: 'board' }, label: '旧板', quote: '' }] }); assert.equal(await old, false)
  assert.equal(f.root.querySelectorAll('article').length, 0)
})

test('changing canvas selection and a failed reload never retarget an unsaved flow annotation', async () => {
  const requests = [], original = { kind: 'flow', paper_id: 'paper', flow_id: 'main', node_ids: ['one','two'] }
  let failRead = false
  const f = ui(async (action, args) => {
    requests.push([action,structuredClone(args)])
    if (action === 'board_annotations_list') { if (failRead) throw Error('读取失败'); return { revision: 'a'.repeat(64), notes: [] } }
    return { revision: 'b'.repeat(64), notes: [] }
  })
  f.target(original); assert.equal(await f.panel.open(), true)
  f.textarea().value = '保留原选中组的批注'; await f.textarea().fire('input')
  original.node_ids.push('later-caller-change')
  const next = { kind: 'flow', paper_id: 'paper', flow_id: 'main', node_id: 'another' }; f.target(next)
  assert.equal(f.panel.updateTarget(next), false, 'selection is allowed to move, draft anchor stays put')
  failRead = true; assert.equal(await f.panel.reload(), false)
  assert.equal(f.textarea().value, '保留原选中组的批注'); assert.equal(f.panel.prepareLeave(), false)
  await f.button('保存批注').fire('click'); await settle()
  const created = requests.find(([action]) => action === 'board_annotations_create')[1]
  assert.deepEqual(created.target, { kind: 'flow', paper_id: 'paper', flow_id: 'main', node_ids: ['one','two'] })
  assert.equal(created.expected_revision, 'a'.repeat(64)); assert.equal(f.panel.hasDraft(), false)
  assert.equal(f.panel.prepareLeave(), true)
})

test('stale targets disable locating while preserving readable snapshots and editable annotations', async () => {
  const note = { id: 'note-stale', target: { kind: 'flow', paper_id: 'paper', flow_id: 'main', node_id: 'removed' }, label: '原始节点', quote: '创建时的原始说明', comment: '原来的问题', stale: true }
  const calls = [], located = []
  const f = ui(async (action, args) => {
    calls.push([action,args])
    return { revision: action === 'board_annotations_update' ? 'b'.repeat(64) : 'a'.repeat(64), notes: [{ ...note, comment: args.comment || note.comment }] }
  }, { onFocus: target => located.push(target) })
  assert.equal(await f.panel.open(), true)
  assert.equal(f.button('定位').disabled, true); assert.equal(f.button('编辑').disabled, false)
  assert.equal(f.root.querySelectorAll('blockquote')[0].textContent, '创建时的原始说明')
  await f.button('编辑').fire('click'); assert.equal(f.textarea().value, '原来的问题')
  f.textarea().value = '补充问题'; await f.textarea().fire('input'); assert.equal(f.panel.prepareLeave(), false)
  await f.button('保存修改').fire('click'); await settle()
  const edited = calls.find(([action]) => action === 'board_annotations_update')[1]
  assert.equal(edited.note_id, 'note-stale'); assert.equal(edited.comment, '补充问题'); assert.equal(edited.target, undefined)
  assert.equal(f.button('定位').disabled, true); assert.equal(f.button('编辑').disabled, false); assert.equal(located.length, 0)
  assert.equal(f.panel.prepareLeave(), true)
})

test('pending annotation writes guard leaving and keep a stable captured target until settled', async () => {
  let resolveWrite
  const f = ui(async action => action === 'board_annotations_list' ? { revision: 0, notes: [] } : new Promise(resolve => { resolveWrite = resolve }))
  await f.panel.open(); f.textarea().value = '等待写入'; await f.textarea().fire('input')
  await f.button('保存批注').fire('click'); assert.equal(f.textarea().disabled, true); assert.equal(f.panel.prepareLeave(), false)
  assert.equal(f.panel.updateTarget({ kind: 'board', node_ids: ['other'] }), false)
  resolveWrite({ revision: 'a'.repeat(64), notes: [] }); await settle()
  assert.equal(f.textarea().disabled, false); assert.equal(f.panel.hasDraft(), false); assert.equal(f.panel.prepareLeave(), true)
})

test('background target updates preserve canvas focus and repeated targets keep a clean note editor', async () => {
  const note = { id: 'note-one', target: { kind: 'board', node_ids: ['one','two'] }, label: '原节点组', quote: '节点组摘录', comment: '已有批注', stale: false }
  const f = ui(async () => ({ revision: 'a'.repeat(64), notes: [note] }))
  await f.panel.open()
  const field = f.textarea()
  assert.equal(f.panel.updateTarget({ kind: 'board', node_ids: ['one','two'] }), true)
  assert.equal(field.focusCalls || 0, 0, 'selecting on the canvas must not focus the annotation text area')
  await f.button('编辑').fire('click'); assert.equal(field.value, '已有批注'); assert.equal(field.focusCalls, 1)
  assert.ok(f.button('保存修改'), 'a clean existing note is still being edited')
  assert.equal(f.panel.updateTarget({ node_ids: ['two','one'], kind: 'board' }), true)
  assert.equal(field.value, '已有批注'); assert.ok(f.button('保存修改')); assert.equal(field.focusCalls, 1)
  assert.equal(f.panel.updateTarget({ kind: 'board', node_ids: ['other'] }), true)
  assert.equal(field.value, ''); assert.equal(field.focusCalls, 1, 'changing selection also leaves canvas focus alone')
  await f.button('批注当前选中').fire('click'); assert.equal(field.focusCalls, 2, 'the explicit comment action may focus the editor')
})
