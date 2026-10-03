import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { appendConversationDraft, createConversationBridge, readerSnapshot } from '../src/client/conversation-context.mjs'

const tick = async () => { for (let i = 0; i < 6; i++) await Promise.resolve() }

function handwrittenDraft() {
  return {
    id: 'paper-1', annotation_id: 'original-annotation', page: 3,
    board: { width: 640, height: 360, strokes: [{ points: [[10, 20], [30.5, 40]], color: '#204080', width: 2 }] },
    transcript: '这里是读者的想法', transcription_source: 'edited', expected_version: 'a'.repeat(64), boardDirty: true,
    uncertain: { request_id: 'c8b9f5c0-d9de-4a65-ae74-71a7d87e0f43', expected_version: 'a'.repeat(64) },
    recognition: { request_id: '341ce2fb-a377-423a-942f-94a60c164d77' }, updatedAt: 1791000000000,
  }
}

function inlineInkRecord(parentId = 'original-annotation') {
  return { draft: { paperId: 'paper-1', page: 3, paths: [[[10, 20], [30.5, 40]]], width: 2, color: '#204080', revision: 7, ...(parentId ? { parentId } : {}) },
    annotation_id: 'ea1c165f-177e-40b1-a55e-71c2e912a052', attempted: true, updatedAt: 1791000000000 }
}
const inlineContext = () => ({ paperId: 'paper-1', page: 3, parentId: 'original-annotation', previousTool: 'underline' })

test('inline linked ink crosses the authorized iframe handoff with exact retry identity and detached vectors', () => {
  const e = environment(), record = inlineInkRecord(), linked = inlineContext()
  const snapshot = { paperId: 'paper-1', page: 1, tab: 'reader', chatDraft: '', linkedHandwriting: linked, inkDraftRecord: record }
  const expected = structuredClone(snapshot)
  e.message({ type: 'paper-library:reader-state', snapshot })
  record.draft.paths[0][0][0] = 999; record.annotation_id = 'mutated'; record.attempted = false; linked.parentId = 'mutated'
  e.detach()
  // An obsolete child cannot replace the frozen handoff, even at the same origin.
  e.message({ type: 'paper-library:reader-state', snapshot: { paperId: 'paper-1', page: 1, chatDraft: 'obsolete' } })
  const target = { postMessage: (value, origin) => e.messages.push({ value, origin }) }
  e.bridge.attach(target); e.message({ type: 'paper-library:ready' }, target)
  assert.deepEqual(e.messages.at(-1).value.snapshot, expected)
  const count = e.messages.length; e.message({ type: 'paper-library:ready' }, target); assert.equal(e.messages.length, count)
  e.bridge.dispose()
})

test('inline handoff keeps free ink and strips images and unknown fields at every retained boundary', () => {
  const record = inlineInkRecord(null), image = 'data:image/png;base64,' + 'x'.repeat(300000)
  record.image = image; record.ownerConfig = 'never-retain'; record.draft.image = image; record.draft.model = 'never-retain'
  record.draft.paths[0].image = image; record.draft.paths[0][0].image = image
  const snapshot = readerSnapshot({ paperId: 'paper-1', page: 1, inkDraftRecord: record, image })
  assert.deepEqual(snapshot.inkDraftRecord, inlineInkRecord(null))
  assert.equal(Object.hasOwn(snapshot, 'linkedHandwriting'), false)
  assert.equal(JSON.stringify(snapshot).includes('data:image'), false)
  assert.equal(JSON.stringify(snapshot).includes('never-retain'), false)
  for (const previousTool of ['select', 'highlight', 'underline', 'strikeout', 'note']) {
    const linked = { ...inlineContext(), previousTool, image, privateConfig: 'never-retain' }
    assert.deepEqual(readerSnapshot({ paperId: 'paper-1', page: 1, linkedHandwriting: linked }).linkedHandwriting, { ...inlineContext(), previousTool })
  }
  const blank = readerSnapshot({ paperId: 'paper-1', page: 1, inkDraftRecord: null, linkedHandwriting: null })
  assert.equal(Object.hasOwn(blank, 'inkDraftRecord'), false); assert.equal(Object.hasOwn(blank, 'linkedHandwriting'), false)
})

test('frozen batches survive handoff while durable queue payloads cross only by bounded reference',()=>{
  const record={...inlineInkRecord(null),frozen:true};
  const ref={paperId:'paper-1',annotation_id:record.annotation_id,paths:'must not cross'};
  const clean=readerSnapshot({paperId:'paper-1',page:1,inkDraftRecord:record,inkQueueRefs:[ref]});
  assert.equal(clean.inkDraftRecord.frozen,true);assert.deepEqual(clean.inkQueueRefs,[{paperId:ref.paperId,annotation_id:ref.annotation_id}]);
  assert.throws(()=>readerSnapshot({paperId:'paper-1',page:1,inkQueueRefs:Array(33).fill(ref)}));
  assert.throws(()=>readerSnapshot({paperId:'paper-1',page:1,inkQueueRefs:[{...ref,annotation_id:'bad'}]}));
})

test('inline handoff rejects cross-paper, mismatched parent and malformed save identities', () => {
  const base = { paperId: 'paper-1', page: 1 }
  for (const change of [{ paperId: 'paper-2' }, { paperId: '' }, { parentId: '' }, { parentId: ' ' }, { parentId: 'x'.repeat(161) }, { parentId: 'a\u007fb' }, { parentId: 'a\nb' }, { page: 0 }, { page: 2001 }, { previousTool: 'ink' }, { previousTool: 'eraser' }, { previousTool: undefined }]) {
    assert.throws(() => readerSnapshot({ ...base, linkedHandwriting: { ...inlineContext(), ...change } }), Error, JSON.stringify(change))
  }
  for (const change of [{ annotation_id: '' }, { annotation_id: 'not-a-uuid' }, { attempted: undefined }, { attempted: 1 }, { updatedAt: 0 }, { updatedAt: -1 }, { updatedAt: NaN }, { updatedAt: Infinity }, { draft: null }]) {
    assert.throws(() => readerSnapshot({ ...base, inkDraftRecord: { ...inlineInkRecord(), ...change } }), Error, JSON.stringify(change))
  }
  for (const change of [{ paperId: 'paper-2' }, { paperId: '' }, { page: 0 }, { page: 2001 }, { revision: 0 }, { revision: 1.5 }, { revision: Number.MAX_SAFE_INTEGER + 1 }, { parentId: '' }, { parentId: null }, { parentId: 'a'.repeat(161) }, { parentId: 'a\nb' }]) {
    const record = inlineInkRecord(); record.draft = { ...record.draft, ...change }
    assert.throws(() => readerSnapshot({ ...base, inkDraftRecord: record }), Error, JSON.stringify(change))
  }
  for (const paperId of [null, 'paper-2']) {
    assert.throws(() => readerSnapshot({ ...base, paperId, linkedHandwriting: inlineContext() }), /身份/)
    assert.throws(() => readerSnapshot({ ...base, paperId, inkDraftRecord: inlineInkRecord() }), /身份/)
  }
  for (const change of [{ parentId: 'another-annotation' }, { page: 2 }]) {
    assert.throws(() => readerSnapshot({ ...base, linkedHandwriting: { ...inlineContext(), ...change }, inkDraftRecord: inlineInkRecord() }), /不一致/)
  }
  assert.throws(() => readerSnapshot({ ...base, linkedHandwriting: inlineContext(), inkDraftRecord: inlineInkRecord(null) }), /不一致/)
})

test('inline handoff bounds stroke counts, point geometry, pen style and total snapshot bytes', () => {
  const base = { paperId: 'paper-1', page: 1 }, record = inlineInkRecord(), draft = record.draft
  const invalid = [
    { paths: [] }, { paths: Array(65).fill([[0, 0], [1, 1]]) }, { paths: [Array(4097).fill([1, 2])] },
    ...[null, [], [[0, 0]], [[0, 0], [20001, 1]], [[0, 0], [1, 20001]], [[0, 0], [-1, 2]], [[0, 0], [Infinity, 1]], [[0, 0], [NaN, 1]], [[0, 0], [true, 1]], [[0, 0], [1, 2, 3]]].map(path => ({ paths: [path] })),
    ...[0, .49, 8.01, NaN, true].map(width => ({ width })), ...['red', '#fff', '#12345678'].map(color => ({ color })),
  ]
  for (const change of invalid) assert.throws(() => readerSnapshot({ ...base, inkDraftRecord: { ...record, draft: { ...draft, ...change } } }), Error, JSON.stringify(change)?.slice(0, 120))
  for (const width of [.5, 8]) {
    const bounded = { ...record, draft: { ...draft, width, paths: [Array(4096).fill([0, 20000])] } }
    assert.equal(readerSnapshot({ ...base, inkDraftRecord: bounded }).inkDraftRecord.draft.paths[0].length, 4096)
  }
  assert.equal(readerSnapshot({ ...base, inkDraftRecord: { ...record, draft: { ...draft, paths: Array(64).fill([[0, 0], [1, 1]]) } } }).inkDraftRecord.draft.paths.length, 64)
  const unrestorable = { ...record, draft: { ...draft, paths: [Array(4096).fill([1.123456789012345, 2.123456789012345])] } }
  assert.throws(() => readerSnapshot({ ...base, inkDraftRecord: unrestorable }), /128 KiB/)
  const large = { ...record, draft: { ...draft, paths: [Array(4096).fill([1000.123456, 1000.654321])] } }
  assert.ok(Buffer.byteLength(JSON.stringify(large)) < 256 * 1024)
  assert.throws(() => readerSnapshot({ ...base, chatDraft: '字'.repeat(64000), inkDraftRecord: large }), /256 KiB/)
})

test('an invalid linked update retains the last good attempted ink for replacement-frame recovery', () => {
  const e = environment(), snapshot = { paperId: 'paper-1', page: 3, tab: 'annotations', chatDraft: '', linkedHandwriting: inlineContext(), inkDraftRecord: inlineInkRecord() }
  e.message({ type: 'paper-library:reader-state', snapshot })
  e.message({ type: 'paper-library:reader-state', snapshot: { ...snapshot, inkDraftRecord: { ...inlineInkRecord(), annotation_id: 'corrupt-retry-id' } } })
  assert.equal(e.messages.at(-1).value.type, 'paper-library:reader-state-error')
  e.detach(); const target = { postMessage: (value, origin) => e.messages.push({ value, origin }) }; e.bridge.attach(target)
  e.message({ type: 'paper-library:ready' }, target)
  assert.deepEqual(e.messages.at(-1).value.snapshot, snapshot)
  e.bridge.dispose()
})

test('handwriting handoff retains exact bounded vectors, CAS and retry identity across iframe replacement', () => {
  const e = environment()
  const draft = handwrittenDraft()
  // This valid board exceeds the browser keepalive body ceiling. Its parent
  // snapshot must survive independently of an unfinished state_put request.
  draft.board.strokes[0].points = Array.from({ length: 6000 }, (_, index) => [10 + index % 600, 20.125])
  const snapshot = { paperId: 'paper-1', page: 3, tab: 'annotations', chatDraft: '', handwritingDraft: draft }
  assert.ok(Buffer.byteLength(JSON.stringify(draft)) > 60000)
  const expected = structuredClone(snapshot)
  e.message({ type: 'paper-library:reader-state', snapshot })
  // Handoff stores a detached copy, even if the outgoing child keeps editing.
  draft.board.strokes[0].points[0][0] = 999
  e.detach()
  const target = { postMessage: (value, origin) => e.messages.push({ value, origin }) }
  e.bridge.attach(target); e.message({ type: 'paper-library:ready' }, target)
  assert.deepEqual(e.messages.at(-1).value.snapshot, expected)
  e.bridge.dispose()
})

test('handwriting handoff strips PNGs and unknown fields at every retained object boundary', () => {
  const draft = handwrittenDraft(), image = 'data:image/png;base64,' + 'x'.repeat(300000)
  draft.image = image; draft.pdf = image; draft.ownerConfig = { secret: 'never retain' }
  draft.board.image = image; draft.board.strokes[0].image = image
  draft.uncertain.image = image; draft.uncertain.board = { bad: 'payload' }
  draft.recognition.image = image; draft.recognition.model = 'never retain'
  const snapshot = readerSnapshot({ paperId: 'paper-1', page: 3, chatDraft: '', handwritingDraft: draft, image })
  assert.deepEqual(snapshot.handwritingDraft, handwrittenDraft())
  assert.equal(JSON.stringify(snapshot).includes('never retain'), false)
  assert.equal(JSON.stringify(snapshot).includes('data:image'), false)
})

test('handwriting handoff rejects cross-paper identity, malformed versions and invalid provenance', () => {
  const snapshot = { paperId: 'paper-1', page: 3, tab: 'annotations', chatDraft: '' }
  const invalid = [
    { id: 'paper-2' }, { id: '' }, { annotation_id: '' }, { annotation_id: 'a'.repeat(161) },
    { annotation_id: 'control\nid' }, { page: 0 }, { page: 2001 },
    { expected_version: 'not-a-version' }, { expected_version: undefined },
    { uncertain: { request_id: 'not-a-uuid', expected_version: null } },
    { uncertain: { request_id: handwrittenDraft().uncertain.request_id, expected_version: 'bad' } },
    { recognition: { request_id: 'bad' } }, { recognition: [] },
    { transcription_source: 'guessed' }, { transcription_source: 'none' },
    { transcript: '字'.repeat(12001) }, { transcript: '😀'.repeat(12001) },
    { boardDirty: 'true' }, { updatedAt: 0 }, { updatedAt: -1 }, { updatedAt: Infinity }, { updatedAt: NaN },
  ]
  for (const change of invalid) {
    assert.throws(() => readerSnapshot({ ...snapshot, handwritingDraft: { ...handwrittenDraft(), ...change } }), Error, JSON.stringify(change))
  }
  assert.throws(() => readerSnapshot({ ...snapshot, paperId: null, handwritingDraft: handwrittenDraft() }), /身份/)
  const e = environment()
  const good = { ...snapshot, handwritingDraft: handwrittenDraft() }
  e.message({ type: 'paper-library:reader-state', snapshot: good })
  e.message({ type: 'paper-library:reader-state', snapshot: { ...good, handwritingDraft: { ...good.handwritingDraft, id: 'paper-2' } } })
  assert.equal(e.messages.at(-1).value.type, 'paper-library:reader-state-error')
  e.message({ type: 'paper-library:ready' })
  assert.deepEqual(e.messages.at(-1).value.snapshot, good)
  e.bridge.dispose()
})

test('handwriting handoff validates finite in-board coordinates, strokes and byte budgets', () => {
  const base = handwrittenDraft(), stroke = base.board.strokes[0]
  const invalidBoards = [
    null, [], { ...base.board, width: 0 }, { ...base.board, height: 4097 }, { ...base.board, width: Infinity },
    { ...base.board, strokes: Array(129).fill(stroke) },
    { ...base.board, strokes: [{ ...stroke, points: Array(8193).fill([10, 20]) }] },
    ...[null, [], [[0, 0]], [[0, 0], [641, 1]], [[0, 0], [1, 361]], [[0, 0], [-1, 2]],
      [[0, 0], [Infinity, 0]], [[0, 0], [NaN, 0]], [[0, 0], [true, 0]], [[0, 0], [1, 2, 3]]
    ].map(points => ({ ...base.board, strokes: [{ ...stroke, points }] })),
    ...['red', '#fff', '#12345678'].map(color => ({ ...base.board, strokes: [{ ...stroke, color }] })),
    ...[0, 16.1, NaN, true].map(width => ({ ...base.board, strokes: [{ ...stroke, width }] })),
  ]
  for (const board of invalidBoards) {
    assert.throws(() => readerSnapshot({ paperId: 'paper-1', page: 3, handwritingDraft: { ...base, board } }), Error, JSON.stringify(board)?.slice(0, 120))
  }
  const oversizedBoard = { ...base.board, strokes: [{ ...stroke, points: Array(8192).fill([1.123456789012345, 2.123456789012345]) }] }
  assert.throws(() => readerSnapshot({ paperId: 'paper-1', page: 3, handwritingDraft: { ...base, board: oversizedBoard } }), /256 KiB/)
  const bigBoard = { width: 2048, height: 2048, strokes: [{ ...stroke, points: Array(7000).fill([1000.123456, 1000.654321]) }] }
  assert.ok(Buffer.byteLength(JSON.stringify(bigBoard)) < 256 * 1024)
  assert.throws(() => readerSnapshot({ paperId: 'paper-1', page: 3, chatDraft: '字'.repeat(64000), handwritingDraft: { ...base, board: bigBoard } }), /256 KiB/)
})

test('handwriting handoff accepts blank boards, full worker dimensions and Unicode transcript limit', () => {
  const draft = { ...handwrittenDraft(), board: { width: 4096, height: 1, strokes: [{ points: [[0, 0], [4096, 1]], color: '#Ab12Cd', width: 16 }] },
    transcript: '😀'.repeat(12000), uncertain: null, recognition: null, expected_version: null, boardDirty: false }
  const snapshot = readerSnapshot({ paperId: 'paper-1', page: 3, handwritingDraft: draft })
  assert.deepEqual(snapshot.handwritingDraft, draft)
  const blank = { ...draft, board: { width: 640, height: 360, strokes: [] }, transcript: '', transcription_source: 'none' }
  assert.deepEqual(readerSnapshot({ paperId: 'paper-1', page: 3, handwritingDraft: blank }).handwritingDraft, blank)
  assert.equal(Object.hasOwn(readerSnapshot({ paperId: 'paper-1', page: 3, handwritingDraft: null }), 'handwritingDraft'), false)
})

function environment() {
  const listeners = new Set(), frames = new Map(), timers = new Map(), messages = []
  let sequence = 0, current = 'source', state = { draft: '', phase: 'plain', occurrences: [], attachmentIds: [], draftRev: 1 }
  const operations = [], inputEdits = []
  const window = {
    location: { origin: 'http://localhost:3080' },
    addEventListener: (_, listener) => listeners.add(listener),
    removeEventListener: (_, listener) => listeners.delete(listener),
    requestAnimationFrame: fn => { frames.set(++sequence, fn); return sequence },
    cancelAnimationFrame: id => frames.delete(id),
    setTimeout: fn => { timers.set(++sequence, fn); return sequence },
    clearTimeout: id => timers.delete(id),
  }
  let block, applied = true
  const scope = { bail: (subject, name, request) => { assert.equal(subject, scope, 'Input edits must dispatch with the exact Session context subject'); inputEdits.push({ name, request }); return applied ? true : undefined } }
  const binding = { ctx: scope, session: { getSnapshot: () => ({ removed: false }) } }
  const ctx = {
    sessions: {
      refresh: async () => { operations.push('refresh') },
      binding: id => ['source', 'paper', 'other'].includes(id) ? binding : undefined,
      open: id => { current = id; operations.push(`open:${id}`) },
      subagentAddress: () => undefined,
      list: { getSnapshot: () => ({ current }) },
    },
    conversation: {
      input: { for: actx => { assert.equal(actx, scope); return { state: { getSnapshot: () => state } } } },
      blocks: { storeFor: () => ({ getSnapshot: () => block }) },
    },
    sidebarRight: { openTab: kind => operations.push(`tab:${current}:${kind}`) },
  }
  const bridge = createConversationBridge({ window, ctx })
  const target = { postMessage: (value, origin) => messages.push({ value, origin }) }
  const detach = bridge.attach(target)
  const message = (data, source = target, origin = window.location.origin) => {
    for (const listener of listeners) listener({ source, origin, data: { version: 1, ...data } })
  }
  const frame = () => { for (const [id, fn] of [...frames]) { frames.delete(id); fn() } }
  const action = (action, extra = {}) => message({ type: 'paper-library:conversation-action', requestId: 'request-1', action, sessionId: 'paper', ...extra })
  return { window, ctx, bridge, target, detach, message, action, frame, timers, messages, operations, inputEdits, listeners,
    setState: value => { state = { ...state, ...value } },
    setCurrent: value => { current = value }, setBlock: value => { block = value }, setApplied: value => { applied = value },
  }
}

test('only the registered iframe, same origin and supported message version may access main conversations', async () => {
  const e = environment()
  const data = { type: 'paper-library:conversation-action', requestId: 'a', action: 'refresh' }
  e.message(data, {}, e.window.location.origin)
  e.message(data, e.target, 'https://attacker.invalid')
  e.message({ ...data, version: 2 })
  await tick()
  assert.deepEqual(e.operations, [])
  e.message(data)
  await tick()
  assert.deepEqual(e.operations, ['refresh'])
  assert.deepEqual(e.messages.at(-1), { value: { type: 'paper-library:conversation-result', version: 1, requestId: 'a', ok: true }, origin: e.window.location.origin })
  e.detach()
  e.message({ ...data, requestId: 'b' })
  await tick()
  assert.deepEqual(e.operations, ['refresh'])
  e.bridge.dispose()
})

test('draft waits for the target composer and restores the library after the old iframe unmounts', async () => {
  const e = environment()
  e.action('draft', { text: '第 3 页：这个假设成立吗？' })
  await tick()
  assert.deepEqual(e.operations, ['refresh', 'open:paper'])
  assert.equal(e.inputEdits.length, 0)
  e.detach()
  // Harness restores persisted text when this previously unopened session mounts.
  e.setState({ draft: '已有问题', draftRev: 9 })
  const unmount = e.bridge.mountedSession('paper')
  e.frame()
  await tick()
  assert.deepEqual(e.operations, ['refresh', 'open:paper', 'tab:paper:paper-library'])
  assert.deepEqual(e.inputEdits, [{ name: 'slash/input-insert-text', request: { text: '\n\n第 3 页：这个假设成立吗？', span: { start: 4, end: 4, draftRev: 9 } } }])
  assert.equal(e.messages.at(-1).value.ok, true)
  assert.equal(e.timers.size, 0)
  unmount(); e.bridge.dispose()
})

test('appending to chip-bearing drafts uses detect coordinates while leaving attachments and chip values untouched', () => {
  const e = environment()
  const occurrences = [{ offset: 2, length: 11, ref: 'opaque-file' }, { offset: 14, length: 6, ref: 'opaque-session' }]
  const attachmentIds = ['image-1']
  e.setState({ draft: '看 @paper.pdf  和 @其他会话', occurrences, attachmentIds, draftRev: 23 })
  const before = e.ctx.conversation.input.for(e.ctx.sessions.binding('paper').ctx).state.getSnapshot()
  appendConversationDraft(e.ctx, 'paper', '引用的原文')
  const edit = e.inputEdits[0].request
  assert.equal(edit.span.start, before.draft.length - (11 - 1) - (6 - 1))
  assert.equal(edit.span.end, edit.span.start)
  assert.equal(edit.span.draftRev, 23)
  assert.equal(edit.text, '\n\n引用的原文')
  assert.equal(before.occurrences, occurrences)
  assert.equal(before.attachmentIds, attachmentIds)
  e.bridge.dispose()
})

const harness = resolve(process.env.DSH_CHECKOUT ?? join(dirname(fileURLToPath(import.meta.url)), '../../../deepseek-ai/deepseek-harness'))
const cordisModule = join(harness, 'vendor/cordis/lib/index.js')
test('actual Cordis dispatch routes the append only to the target session, despite an earlier hidden composer listener', { skip: !existsSync(cordisModule) && 'Set DSH_CHECKOUT to a built Harness checkout' }, async () => {
  const { Context } = await import(pathToFileURL(cordisModule))
  const root = new Context()
  const tag = Symbol('fixture.session')
  const scope = id => root.extend({ [tag]: id, [Context.filter]: listener => listener[tag] === undefined || listener[tag] === id })
  const hidden = scope('hidden-a'), target = scope('target-b')
  const drafts = { hidden: 'Hidden draft A.', target: 'Existing draft B.' }
  try {
    hidden.on('slash/input-insert-text', ({ text }) => { drafts.hidden += text; return true })
    target.on('slash/input-insert-text', ({ text }) => { drafts.target += text; return true })
    const ctx = {
      sessions: { binding: () => ({ ctx: target, session: { getSnapshot: () => ({ removed: false }) } }), subagentAddress: () => undefined },
      conversation: {
        input: { for: () => ({ state: { getSnapshot: () => ({ phase: 'plain', draft: drafts.target, draftRev: 1, occurrences: [] }) } }) },
        blocks: { storeFor: () => ({ getSnapshot: () => undefined }) },
      },
    }
    appendConversationDraft(ctx, 'target-b', 'The quoted paper passage.')
    assert.equal(drafts.hidden, 'Hidden draft A.')
    assert.equal(drafts.target, 'Existing draft B.\n\nThe quoted paper passage.')
  } finally { await root.fiber.dispose() }
})

test('command, submission and blocked inputs reject append without changing any draft', () => {
  const e = environment()
  for (const phase of ['claimed', 'adjudicating', 'submitting']) {
    e.setState({ draft: '/model pending', phase })
    assert.throws(() => appendConversationDraft(e.ctx, 'paper', 'new note'), /现有草稿已保留/)
  }
  e.setState({ phase: 'plain' }); e.setBlock({ reason: '模型尚未加载' })
  assert.throws(() => appendConversationDraft(e.ctx, 'paper', 'new note'), /模型尚未加载/)
  assert.equal(e.inputEdits.length, 0)
  e.setBlock(undefined); e.setApplied(false)
  assert.throws(() => appendConversationDraft(e.ctx, 'paper', 'new note'), /刚刚发生变化/)
  e.bridge.dispose()
})

test('open has no composer mutation and respects a later user navigation', async () => {
  const e = environment()
  e.action('open')
  await tick()
  e.bridge.mountedSession('paper')
  e.setCurrent('other')
  e.frame()
  await tick()
  assert.deepEqual(e.operations, ['refresh', 'open:paper'])
  assert.equal(e.inputEdits.length, 0)
  assert.equal(e.messages.at(-1).value.ok, false)
  assert.match(e.messages.at(-1).value.error, /已取消/)
  e.bridge.dispose()
})

test('same-frame duplicate request IDs replay results without a second insertion', async () => {
  const e = environment()
  e.bridge.mountedSession('paper')
  e.action('draft', { text: 'one note' }); e.action('draft', { text: 'one note' })
  await tick(); e.frame(); await tick()
  e.action('draft', { text: 'one note' })
  await tick()
  assert.equal(e.inputEdits.length, 1)
  assert.deepEqual(e.messages.at(-1).value, e.messages.at(-2).value)
  e.bridge.dispose()
})

test('missing sessions, invalid actions, and invalid draft payloads leave navigation and inputs untouched', async () => {
  const e = environment()
  e.action('open', { sessionId: 'missing', requestId: 'missing' })
  e.action('send', { requestId: 'send' })
  e.action('draft', { text: '', requestId: 'empty' })
  await tick()
  assert.equal(e.messages.length, 3)
  assert.ok(e.messages.every(message => message.value.ok === false))
  assert.equal(e.inputEdits.length, 0)
  assert.ok(e.operations.every(operation => operation === 'refresh'))
  e.bridge.dispose()
})

test('navigation timeout reports recovery and plugin disposal releases its listener and timers', async () => {
  const e = environment()
  e.action('open')
  await tick()
  for (const fn of e.timers.values()) fn()
  await tick()
  assert.match(e.messages.at(-1).value.error, /从右侧栏打开文献库/)
  assert.equal(e.timers.size, 0)
  e.action('open', { requestId: 'again' })
  await tick()
  const before = e.messages.length
  e.bridge.dispose()
  await tick()
  assert.equal(e.listeners.size, 0)
  assert.equal(e.timers.size, 0)
  assert.equal(e.messages.length, before)
})

test('a terminal navigation result reaches the replacement frame once and never repeats on later mounts', async () => {
  const e = environment()
  e.action('draft', { text: 'My annotation' })
  await tick()
  e.detach()
  e.setState({ phase: 'claimed' })
  e.bridge.mountedSession('paper')
  e.frame(); await tick()
  const replacement = { postMessage: (value, origin) => e.messages.push({ value, origin }) }
  const detach = e.bridge.attach(replacement)
  e.message({ type: 'paper-library:ready' }, replacement)
  const result = e.messages.at(-1).value
  assert.equal(result.relay, true)
  assert.equal(result.sessionId, 'paper')
  assert.equal(result.ok, false)
  assert.match(result.error, /现有草稿已保留/)
  const count = e.messages.length
  e.message({ type: 'paper-library:ready' }, replacement)
  assert.equal(e.messages.length, count)
  detach()
  const later = { postMessage: () => assert.fail('An already consumed action must not be replayed') }
  e.bridge.attach(later)
  e.message({ type: 'paper-library:ready' }, later)
  e.bridge.dispose()
})

test('a replacement frame already ready receives the terminal result without another handshake', async () => {
  const e = environment()
  e.action('open')
  await tick()
  e.detach()
  const replacement = { postMessage: (value, origin) => e.messages.push({ value, origin }) }
  e.bridge.attach(replacement)
  e.message({ type: 'paper-library:ready' }, replacement)
  e.bridge.mountedSession('paper')
  e.frame(); await tick()
  assert.equal(e.messages.at(-1).value.relay, true)
  assert.equal(e.messages.at(-1).value.ok, true)
  e.bridge.dispose()
})

test('the latest bounded reading snapshot restores once per new iframe, preserving PDF and chat drafts', () => {
  const e = environment()
  const snapshot = { paperId: 'paper-1', page: 3, tab: 'conversation', chatDraft: '这里需要进一步核验', chatContext: { annotationIds: ['note-1'], selection: { page: 3, text: 'The selected source passage.' } }, annotationDraft: { mode: 'highlight', id: 'paper-1', page: 3, comment: '我的问题', selection: { page: 3, text: 'Quoted evidence.', rects: [[1, 2, 30, 40]] } }, image: 'data:must-not-be-retained' }
  e.message({ type: 'paper-library:reader-state', snapshot })
  e.detach()
  const target = { postMessage: (value, origin) => e.messages.push({ value, origin }) }
  e.bridge.attach(target)
  e.message({ type: 'paper-library:ready' }, target)
  const restored = e.messages.at(-1).value
  assert.equal(restored.type, 'paper-library:restore')
  assert.equal(restored.snapshot.chatDraft, snapshot.chatDraft)
  assert.deepEqual(restored.snapshot.chatContext, snapshot.chatContext)
  assert.deepEqual(restored.snapshot.annotationDraft, snapshot.annotationDraft)
  assert.equal(Object.hasOwn(restored.snapshot, 'image'), false)
  const count = e.messages.length
  e.message({ type: 'paper-library:ready' }, target)
  assert.equal(e.messages.length, count)
  e.bridge.dispose()
})

test('invalid or oversized snapshots preserve the last good reading state and never retain arbitrary fields', () => {
  const e = environment()
  const snapshot = { paperId: 'paper-1', page: 1, tab: 'reader', chatDraft: 'small draft' }
  e.message({ type: 'paper-library:reader-state', snapshot })
  e.message({ type: 'paper-library:reader-state', snapshot: { ...snapshot, annotationDraft: { mode: 'note', id: 'paper-1', page: 1, comment: '文'.repeat(64000), quote: '文'.repeat(64000) } } })
  assert.equal(e.messages.at(-1).value.type, 'paper-library:reader-state-error')
  e.message({ type: 'paper-library:ready' })
  assert.deepEqual(e.messages.at(-1).value.snapshot, snapshot)
  assert.throws(() => readerSnapshot({ ...snapshot, page: -1 }), /页码/)
  assert.throws(() => readerSnapshot({ ...snapshot, annotationDraft: { mode: 'image' } }), /草稿类型/)
  assert.throws(() => readerSnapshot({ ...snapshot, chatContext: { annotationIds: Array(1001).fill('note') } }), /1000/)
  assert.throws(() => readerSnapshot({ ...snapshot, chatContext: { annotationIds: [], selection: { page: 2, text: 'x'.repeat(8001) } } }), /长度/)
  assert.throws(() => readerSnapshot({ ...snapshot, annotationDraft: { mode: 'note', id: 'paper-1', page: 1, comment: '文'.repeat(64000), quote: '文'.repeat(64000) } }), /256 KiB/)
  e.bridge.dispose()
})

test('reading panel position and underline or strikeout drafts survive iframe replacement without raster caches', () => {
  for (const mode of ['underline', 'strikeout']) {
    const e = environment()
    const snapshot = { paperId: 'paper-1', page: 2, tab: 'reader', chatDraft: 'A continuing paper question',
      panels: { side: 'left', annotations: true, metadata: false, chat: true, image: 'discard-me', width: 9000 },
      annotationDraft: { id: 'paper-1', page: 2, mode, color: '#4b8CDD', comment: 'Reader interpretation',
        selection: { page: 2, text: 'Exact original passage', rects: [[10, 20, 90, 35]], renderedImage: 'discard-me' } },
      residentPages: [{ page: 1, image: 'discard-me', words: ['discard-me'] }],
    }
    e.message({ type: 'paper-library:reader-state', snapshot }); e.detach()
    const target = { postMessage: (value, origin) => e.messages.push({ value, origin }) }; e.bridge.attach(target)
    e.message({ type: 'paper-library:ready' }, target)
    const restored = e.messages.at(-1).value.snapshot
    assert.deepEqual(restored.panels, { side: 'left', annotations: true, metadata: false, chat: true })
    assert.equal(restored.annotationDraft.mode, mode); assert.equal(restored.annotationDraft.color, '#4b8CDD')
    assert.deepEqual(restored.annotationDraft.selection, { page: 2, text: 'Exact original passage', rects: [[10, 20, 90, 35]] })
    assert.equal(Object.hasOwn(restored, 'residentPages'), false)
    assert.equal(restored.chatDraft, snapshot.chatDraft)
    e.bridge.dispose()
  }
})

test('invalid panel placement or annotation color cannot overwrite the last good reader snapshot', () => {
  const e = environment()
  const snapshot = { paperId: 'paper-1', page: 4, tab: 'annotations', chatDraft: '', panels: { side: 'right', annotations: true, metadata: false, chat: false }, annotationDraft: { id: 'paper-1', page: 4, mode: 'strikeout', color: '#ffdb66', comment: '' } }
  e.message({ type: 'paper-library:reader-state', snapshot })
  for (const color of ['red', '#fff', '#11223344', '', 42]) {
    assert.throws(() => readerSnapshot({ ...snapshot, annotationDraft: { ...snapshot.annotationDraft, color } }), /颜色/)
    e.message({ type: 'paper-library:reader-state', snapshot: { ...snapshot, annotationDraft: { ...snapshot.annotationDraft, color } } })
    assert.equal(e.messages.at(-1).value.type, 'paper-library:reader-state-error')
  }
  assert.throws(() => readerSnapshot({ ...snapshot, panels: { side: 'bottom' } }), /侧栏位置/)
  e.message({ type: 'paper-library:reader-state', snapshot: { ...snapshot, panels: { side: 'bottom' } } })
  assert.equal(e.messages.at(-1).value.type, 'paper-library:reader-state-error')
  e.message({ type: 'paper-library:ready' })
  assert.deepEqual(e.messages.at(-1).value.snapshot, snapshot)
  e.bridge.dispose()
})

test('up to 1000 annotation identities and revisions restore without retaining note bodies', () => {
  const refs = Array.from({ length: 1000 }, (_, index) => ({ id: `note-${index}`, version: 'a'.repeat(64), text: 'not retained' }))
  const snapshot = readerSnapshot({ paperId: 'paper-1', page: 1, tab: 'conversation', chatDraft: '', chatContext: { annotationRefs: refs } })
  assert.equal(snapshot.chatContext.annotationRefs.length, 1000)
  assert.equal(Object.hasOwn(snapshot.chatContext.annotationRefs[0], 'text'), false)
  assert.throws(() => readerSnapshot({ paperId: 'paper-1', page: 1, chatContext: { annotationRefs: [{ id: 'note', version: 'stale?' }] } }), /版本/)
})

test('the bridge transfers canonical draft tokens as chips and rejects mismatched snapshot identity', async () => {
  const e = environment()
  const hash = 'a'.repeat(64), ref = `[[paper-library-ref:v1:paper-1:${hash}]]`
  const reference = { ref, label: '批注 3 条', clipboardText: ref }
  e.bridge.mountedSession('paper')
  e.action('draft', { text: 'Readable snapshot', draft_text: `${ref}\n\n我的问题`, reference, snapshot_id: hash })
  await tick(); e.frame(); await tick()
  assert.equal(e.inputEdits[0].name, 'slash/input-insert-text')
  assert.equal(e.inputEdits[0].request.text, `${ref}\n\n我的问题`)
  assert.equal(e.inputEdits[1].name, 'slash/input-insert-reference')
  assert.equal(e.inputEdits[1].request.reference.ref, ref)
  e.action('draft', { requestId: 'wrong', text: 'Readable snapshot', draft_text: ref, reference, snapshot_id: 'b'.repeat(64) })
  await tick()
  assert.match(e.messages.at(-1).value.error, /快照不一致/)
  assert.equal(e.inputEdits.length, 2)
  e.bridge.dispose()
})

test('reference page navigation waits for an authorized ready iframe and never edits a composer', async () => {
  const e = environment()
  e.setCurrent('paper'); e.bridge.mountedSession('paper')
  const pending = e.bridge.openReference({ sessionId: 'paper', paperId: 'paper-1', page: 8, snapshot_id: 'a'.repeat(64) })
  e.frame(); await pending
  assert.equal(e.messages.length, 0)
  e.message({ type: 'paper-library:ready' })
  assert.equal(e.messages.at(-1).value.type, 'paper-library:reference-open')
  assert.equal(e.messages.at(-1).value.page, 8)
  assert.equal(e.inputEdits.length, 0)
  e.setCurrent('other')
  await assert.rejects(e.bridge.openReference({ sessionId: 'paper', paperId: 'paper-1', page: 8, snapshot_id: 'a'.repeat(64) }), /其他对话/)
  e.bridge.dispose()
})
