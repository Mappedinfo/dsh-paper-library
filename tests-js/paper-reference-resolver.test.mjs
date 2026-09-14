import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { preparePaperReferenceMessages } from '../src/harness/paper-reference-resolver.mjs'
import { annotationBodyHash, loggedAnnotationReference } from '../src/harness/annotation-usage.mjs'
import { annotationSnapshotToken, createAnnotationSnapshotStore } from '../src/harness/annotation-snapshots.mjs'
import { createPaperChat } from '../src/harness/paper-chat.mjs'

const version = 'a'.repeat(64), sessionId = 'session-1'
const user = text => createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] })
function snapshot(index, quote = 'source', { session = sessionId, paperId = 'paper-1' } = {}) {
  const note = { id: `note-${index}`, version, page: index + 1, text: quote, comment: '' }
  return { paperId, sessionId: session, text: `**第 ${note.page} 页**\n${quote}`, annotations: [note], annotation_refs: [{ id: note.id, version, page: note.page }], coverage: { requested: 1, included: 1, total: 1, total_exact: true, all: true, characters: [...quote].length } }
}
async function fixture(t, snapshots) {
  const library = await mkdtemp(join(tmpdir(), 'paper-reference-test-'))
  t.after(() => rm(library, { recursive: true, force: true }))
  const store = createAnnotationSnapshotStore({ library }), saved = []
  for (const value of snapshots) saved.push(await store.save(value))
  return { library, store, saved }
}

test('real native user messages expand canonical references to immutable context with producer metadata outside body', async t => {
  const { store, saved: [saved] } = await fixture(t, [snapshot(0)])
  const original = user(`请解释这个假设。\n${saved.token}\n也说明局限。`)
  const messages = await preparePaperReferenceMessages([original], { store, sessionId })
  assert.equal(messages.length, 2)
  assert.equal(messages[0].id, original.id)
  assert.match(messages[0].content[0].text, /请解释这个假设。/)
  assert.match(messages[0].content[0].text, /也说明局限。/)
  assert.equal(messages[0].content[0].text.includes(saved.token), false)
  assert.equal(original.content[0].text.includes(saved.token), true)
  const context = messages[1]
  assert.equal(context.role, 'user')
  assert.notEqual(context.id, original.id)
  assert.equal(context.source.kind, 'plugin')
  assert.equal(context.source.plugin, 'Paper Library')
  assert.equal(context.source.paperLibraryReference.snapshot_id, saved.id)
  assert.equal(context.source.paperLibraryReference.body_hash, annotationBodyHash(saved.snapshot.text))
  assert.equal(context.content[0].text, saved.snapshot.text)
  assert.equal(context.content[0].text.includes(saved.id), false)
  assert.ok(Object.isFrozen(context) && Object.isFrozen(context.content))
  const logged = loggedAnnotationReference({ type: 'user/message', data: context }, sessionId)
  assert.equal(logged.annotation_refs[0].id, 'note-0')
})

test('repeated references resolve once while distinct batches preserve questions and non-text content', async t => {
  const { store, saved: [a, b] } = await fixture(t, [snapshot(0), snapshot(1, 'second source')])
  const loads = []
  const counted = { load: async (...args) => { loads.push(args); return store.load(...args) } }
  const image = { type: 'image', source: { type: 'base64', mediaType: 'image/png', data: 'synthetic-only' } }
  const original = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: `比较 ${a.token} 与 ${b.token}` }, image, { type: 'text', text: `再次引用 ${a.token} 的边界？` }] })
  const messages = await preparePaperReferenceMessages([original], { store: counted, sessionId })
  assert.equal(loads.length, 2)
  assert.equal(messages.length, 3)
  assert.deepEqual(messages[0].content[1], image)
  assert.match(messages[0].content[2].text, /边界？/)
  assert.deepEqual(messages.slice(1).map(message => message.content[0].text), [a.snapshot.text, b.snapshot.text])
  assert.deepEqual(loads[0][1], { paperId: 'paper-1', sessionId })
})

test('unreferenced user messages and model/plugin text are not resolved or silently reinterpreted', async () => {
  const token = annotationSnapshotToken('paper-1', 'b'.repeat(64))
  const plain = user('普通追问'), ai = createAssistantMessage({ source: { provider: 'fixture', model: 'fixture' }, content: [{ type: 'text', text: token }] })
  const injected = createUserMessage({ source: { kind: 'plugin', plugin: 'Fixture' }, content: [{ type: 'text', text: token }] })
  const inputs = [plain, ai, injected]
  const messages = await preparePaperReferenceMessages(inputs, { store: { load: () => assert.fail('Non-user references never load a snapshot') }, sessionId })
  assert.deepEqual(messages, inputs)
  assert.ok(messages.every((message, index) => message === inputs[index]))
})

test('missing, malformed, partially valid and cross-session references fail without producing partial context', async t => {
  const { store, saved: [saved] } = await fixture(t, [snapshot(0)])
  await assert.rejects(preparePaperReferenceMessages([user(saved.token)], { store, sessionId: 'another-session' }), /不属于当前论文对话/)
  await assert.rejects(preparePaperReferenceMessages([user(annotationSnapshotToken('paper-1', 'f'.repeat(64)))], { store, sessionId }), /丢失/)
  for (const text of ['[[paper-library-ref:v1:paper-1:bad]]', '[[paper-library-ref:v2:paper-1:bad]]', `${saved.token} [[paper-library-ref:v1:broken`]) {
    await assert.rejects(preparePaperReferenceMessages([user(text)], { store, sessionId }), /格式无效/)
  }
})

test('aggregate source budgets reject multiple batches rather than truncate and at most four batches enter a message', async t => {
  const { store, saved } = await fixture(t, Array.from({ length: 5 }, (_, index) => snapshot(index, '123456')))
  await assert.rejects(preparePaperReferenceMessages([user(`${saved[0].token}\n${saved[1].token}`)], { store, sessionId, maxCharacters: 10 }), /超过 10 字符预算/)
  const one = await preparePaperReferenceMessages([user(`${saved[0].token}\n${saved[0].token}`)], { store, sessionId, maxCharacters: 6 })
  assert.equal(one.length, 2)
  await assert.rejects(preparePaperReferenceMessages([user(saved.map(value => value.token).join('\n'))], { store, sessionId, maxCharacters: 100 }), /最多引用 4 组/)
})

test('source budget is derived from complete immutable material when older snapshots omit the character hint', async t => {
  const value = snapshot(0, '123456')
  delete value.coverage.characters
  const { store, saved: [saved] } = await fixture(t, [value])
  await assert.rejects(preparePaperReferenceMessages([user(saved.token)], { store, sessionId, maxCharacters: 5 }), /超过 5 字符预算/)
})

test('a pre-step decision applies one aggregate budget across several queued user messages', async t => {
  const { store, saved: [a, b] } = await fixture(t, [snapshot(0, '123456'), snapshot(1, 'abcdef')])
  await assert.rejects(preparePaperReferenceMessages([user(a.token), user(b.token)], { store, sessionId, maxCharacters: 10 }), /共 12 字符/)
})

test('source budgets count Unicode code points consistently with the PDF worker', async t => {
  const { store, saved: [saved] } = await fixture(t, [snapshot(0, '🧠中文')])
  const result = await preparePaperReferenceMessages([user(saved.token)], { store, sessionId, maxCharacters: 3 })
  assert.equal(result[1].content[0].text, saved.snapshot.text)
  await assert.rejects(preparePaperReferenceMessages([user(saved.token)], { store, sessionId, maxCharacters: 2 }), /共 3 字符/)
})

test('a reused snapshot ID cannot bypass the paper identity in a second token', async t => {
  const { store, saved: [saved] } = await fixture(t, [snapshot(0)])
  const wrongPaper = annotationSnapshotToken('different-paper', saved.id)
  await assert.rejects(preparePaperReferenceMessages([user(`${saved.token}\n${wrongPaper}`)], { store, sessionId }), /论文|文献|批注引用/)
})

test('cancellation stops before source reads and wrong-session store responses cannot reach the model messages', async () => {
  const token = annotationSnapshotToken('paper-1', 'b'.repeat(64))
  await assert.rejects(preparePaperReferenceMessages([user(token)], { store: { load: () => assert.fail('An aborted attempt must not read') }, sessionId, signal: AbortSignal.abort() }), { name: 'AbortError' })
  await assert.rejects(preparePaperReferenceMessages([user(token)], { store: { load: async () => snapshot(0, 'source', { session: 'other' }) }, sessionId }), /另一篇论文/)
})

test('pre-step installation awaits next once, preserves reject and decision fields, and does no PDF or model work', async () => {
  let listener, registered
  const ctx = { sessionController: {}, effect: callback => callback(), sessionProjections: { register: projection => { registered = projection; return () => {} } }, on: (event, fn, options) => { assert.equal(event, 'agent/pre-step'); assert.equal(options.prepend, true); listener = fn } }
  const chat = createPaperChat(ctx, { library: '/synthetic/unused', dispatch: () => assert.fail('Reference preparation must not parse PDFs or call a model') })
  chat.install()
  assert.equal(registered.key, 'paperLibraryAnnotationUsage')
  let calls = 0
  const rejection = { kind: 'reject', reason: 'fixture refusal' }
  assert.equal(await listener({ agent: { session: { id: sessionId } } }, async () => { calls++; return rejection }), rejection)
  const original = user('普通追问')
  const accepted = await listener({ agent: { session: { id: sessionId } } }, async () => { calls++; return { kind: 'enter', messages: [original], fixture: 'preserved' } })
  assert.equal(calls, 2)
  assert.equal(accepted.fixture, 'preserved')
  assert.equal(accepted.messages[0], original)
})
