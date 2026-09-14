import test from 'node:test'
import assert from 'node:assert/strict'
import { ANNOTATION_SOURCE, annotationReferenceInsert, createAnnotationReferences, draftAnnotationReferences, parseAnnotationReference } from '../src/client/annotation-references.mjs'
import { appendConversationDraft } from '../src/client/conversation-context.mjs'

const hash = 'a'.repeat(64)
const ref = `[[paper-library-ref:v1:paper-1:${hash}]]`
const reference = { ref, label: '批注 3 条', clipboardText: ref }
const response = result => ({ ok: true, headers: { get: () => null }, text: async () => JSON.stringify({ ok: true, result }) })

test('canonical identity survives clipboard, plain persisted draft and async serialization', async () => {
  const manager = createAnnotationReferences({ window: {}, openPaper: () => assert.fail('No read while serializing'), notify: () => {} })
  assert.deepEqual(parseAnnotationReference(ref), { paperId: 'paper-1', snapshot_id: hash, ref })
  assert.equal(parseAnnotationReference(`[[paper-library-ref:v1:../secret:${hash}]]`), null)
  assert.deepEqual(draftAnnotationReferences(`Question ${ref} again ${ref}`), [{ paperId: 'paper-1', snapshot_id: hash, ref }])
  assert.equal(manager.source.codec.clipboardText(ref), ref)
  assert.equal(await manager.source.codec.serialize(ref, new AbortController().signal), ref)
  await assert.rejects(manager.source.codec.serialize('broken', new AbortController().signal), /无效/)
  await assert.rejects(manager.source.codec.serialize(ref, AbortSignal.abort()), /取消/)
  assert.throws(() => annotationReferenceInsert({ ...reference, clipboardText: 'lost identity' }), /无效/)
  manager.dispose()
})

test('on-demand candidates are bounded and scoped to the owning session, with no warmup reads', async () => {
  const manager = createAnnotationReferences({ window: { fetch: () => assert.fail('No candidate PDF requests') }, openPaper: () => {}, notify: () => {} })
  for (let i = 0; i < 15; i++) {
    const token = `[[paper-library-ref:v1:paper-${i}:${hash}]]`
    manager.remember(i === 14 ? 'other' : 'paper', { ref: token, label: `批注 ${i}`, clipboardText: token })
  }
  const candidates = await manager.source.candidates({ sessionId: 'paper' }, { query: '', signal: new AbortController().signal })
  assert.equal(candidates.length, 5)
  assert.equal(candidates.some(candidate => candidate.value.includes('paper-14:')), false)
  assert.equal(manager.source.onPick({ session: { sessionId: 'other' }, candidate: candidates[0] }), undefined)
  const pick = manager.source.onPick({ session: { sessionId: 'paper' }, candidate: candidates[0] })
  assert.equal(pick.insert.source, ANNOTATION_SOURCE)
  manager.dispose()
})

test('preview resolves one immutable snapshot, checks session and reveals its actual page', async () => {
  const reads = [], opens = [], errors = []
  const snapshot = { sessionId: 'paper', text: 'Frozen exact source', annotation_refs: [{ id: 'note-1', version: hash, page: 8 }], coverage: { count: 1 } }
  const manager = createAnnotationReferences({
    window: { fetch: async (url, init) => { reads.push({ url, init }); return response(snapshot) } },
    openPaper: async request => opens.push(request), notify: (...args) => errors.push(args),
  })
  await manager.preview('paper', ref)
  assert.equal(reads.length, 1)
  assert.deepEqual(JSON.parse(reads[0].init.body), { action: 'chat_reference', id: 'paper-1', snapshot_id: hash })
  assert.equal(manager.getSnapshot().snapshot.text, snapshot.text)
  assert.equal(opens[0].page, 8)
  await manager.preview('other', ref)
  assert.match(manager.getSnapshot().error, /不属于当前论文对话/)
  assert.equal(opens.length, 1)
  assert.equal(errors.length, 1)
  manager.dispose()
  assert.equal(manager.getSnapshot(), null)
})

test('closing or superseding an inspector discards late results without navigating', async () => {
  let finish
  const manager = createAnnotationReferences({ window: { fetch: async () => new Promise(resolve => { finish = resolve }) }, openPaper: () => assert.fail('A closed preview must not navigate'), notify: () => assert.fail('Cancellation is not an error') })
  const pending = manager.preview('paper', ref)
  manager.close()
  finish(response({ sessionId: 'paper', text: 'Old', annotation_refs: [{ page: 2 }] }))
  await pending
  assert.equal(manager.getSnapshot(), null)
  manager.dispose()
})

test('missing and oversized immutable references surface a recoverable error before any page navigation', async () => {
  let result = { ok: false, headers: { get: () => null }, text: async () => JSON.stringify({ ok: false, error: '引用快照不存在' }) }
  const errors = []
  const manager = createAnnotationReferences({ window: { fetch: async () => result }, openPaper: () => assert.fail('Invalid snapshots must not navigate'), notify: (_, message) => errors.push(message) })
  await manager.preview('paper', ref)
  assert.match(manager.getSnapshot().error, /不存在/)
  result = { ok: true, headers: { get: () => '600000' }, text: async () => assert.fail('An over-budget response must not be read') }
  await manager.preview('paper', ref)
  assert.match(manager.getSnapshot().error, /上限/)
  assert.equal(errors.length, 2)
  manager.dispose()
})

test('programmatic insertion preserves existing text, chips and attachments and guards the new revision', () => {
  const oldChip = { ref: '@old-file', length: 9, offset: 6 }
  let state = { phase: 'plain', draft: 'Hello @old-file', draftRev: 7, occurrences: [oldChip], attachmentIds: ['attachment'] }
  const calls = []
  const scope = { bail(subject, event, payload) {
    assert.equal(subject, scope)
    calls.push({ event, payload })
    if (event === 'slash/input-insert-text') state = { ...state, draft: state.draft + payload.text, draftRev: 8 }
    return true
  } }
  const ctx = { sessions: { binding: () => ({ ctx: scope, session: { getSnapshot: () => ({ removed: false }) } }), subagentAddress: () => undefined }, conversation: { input: { for: () => ({ state: { getSnapshot: () => state } }) }, blocks: { storeFor: () => ({ getSnapshot: () => undefined }) } } }
  const oldEnd = state.draft.length - (oldChip.length - 1)
  appendConversationDraft(ctx, 'paper', `${ref}\n\nQuestion`, reference)
  assert.equal(calls[0].payload.span.start, oldEnd)
  assert.equal(calls[1].event, 'slash/input-insert-reference')
  assert.deepEqual(calls[1].payload.span, { start: oldEnd + 2, end: oldEnd + 2 + ref.length, draftRev: 8 })
  assert.equal(state.occurrences[0], oldChip)
  assert.deepEqual(state.attachmentIds, ['attachment'])
  assert.throws(() => appendConversationDraft(ctx, 'paper', `${ref}${ref}`, reference), /一次/)
  assert.equal(calls.length, 2)
})

test('a refused chip decoration keeps a sendable canonical text draft without a second append', () => {
  let state = { phase: 'plain', draft: '', draftRev: 1, occurrences: [], attachmentIds: [] }
  const notices = []
  const scope = { bail(_subject, event, payload) {
    if (event === 'slash/input-insert-reference') return undefined
    state = { ...state, draft: payload.text, draftRev: 2 }
    return true
  } }
  const ctx = { sessions: { binding: () => ({ ctx: scope, session: { getSnapshot: () => ({ removed: false }) } }), subagentAddress: () => undefined }, conversation: { input: { for: () => ({ state: { getSnapshot: () => state }, notify: (...args) => notices.push(args) }) }, blocks: { storeFor: () => ({ getSnapshot: () => undefined }) } } }
  assert.equal(appendConversationDraft(ctx, 'paper', `${ref}\n\nQuestion`, reference), false)
  assert.equal(state.draft, `${ref}\n\nQuestion`)
  assert.match(notices[0][1], /保留为文本/)
})
