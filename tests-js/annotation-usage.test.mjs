import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ANNOTATION_USAGE_KEY, annotationBodyHash, annotationReferenceSource,
  annotationUsageProjection, emptyAnnotationUsage, foldAnnotationUsage, loggedAnnotationReference,
} from '../src/harness/annotation-usage.mjs'

const version = 'a'.repeat(64), newer = 'b'.repeat(64), snapshotId = 'c'.repeat(64)
const snapshot = (refs = [{ id: 'note-1', version, page: 3 }]) => ({ paperId: 'paper-1', sessionId: 'session-1', text: '第 3 页：真实的批注来源。', annotation_refs: refs })
function referenceEvent(seq = 4, value = snapshot()) {
  return { seq, type: 'user/message', data: { source: annotationReferenceSource(value, snapshotId), content: [{ type: 'text', text: value.text }] } }
}

test('only a logged source envelope with its exact body advances the annotation baseline', () => {
  const initial = emptyAnnotationUsage('session-1')
  const token = `[[paper-library-ref:v1:paper-1:${snapshotId}]]`
  for (const event of [
    { seq: 1, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: token }] } },
    { seq: 2, type: 'queue/enqueue', data: referenceEvent().data },
    { seq: 3, type: 'assistant/message', data: referenceEvent().data },
    { ...referenceEvent(), data: { ...referenceEvent().data, source: { kind: 'model', provider: 'fixture', model: 'fixture', paperLibraryReference: referenceEvent().data.source.paperLibraryReference } } },
  ]) assert.equal(foldAnnotationUsage(initial, event), initial)
  const accepted = foldAnnotationUsage(initial, referenceEvent())
  assert.deepEqual(accepted, { sessionId: 'session-1', revision: 4, truncated: false, usage: { 'note-1': version } })
  assert.deepEqual(initial.usage, {}, 'the source state stays immutable')
})

test('wrong sessions, producer names, malformed versions and changed body cannot forge sent status', () => {
  const initial = emptyAnnotationUsage('session-1'), valid = referenceEvent()
  const changed = structuredClone(valid); changed.data.content[0].text += ' changed after hashing'
  const wrongSource = structuredClone(valid); wrongSource.data.source.plugin = 'Unrelated Plugin'
  const invalidVersion = structuredClone(valid); invalidVersion.data.source.paperLibraryReference.annotation_refs[0].version = 'not-a-hash'
  const changedHash = structuredClone(valid); changedHash.data.source.paperLibraryReference.body_hash = 'd'.repeat(64)
  const wrongSession = referenceEvent(5, { ...snapshot(), sessionId: 'session-2' })
  for (const event of [changed, wrongSource, invalidVersion, changedHash, wrongSession]) {
    assert.equal(loggedAnnotationReference(event, 'session-1'), null)
    assert.equal(foldAnnotationUsage(initial, event), initial)
  }
  assert.equal(loggedAnnotationReference(valid, 'session-1').text, snapshot().text)
})

test('later history windows and reply failures retain versions in the durable projection', () => {
  const messages = [referenceEvent()]
  for (let seq = 5; seq < 85; seq++) messages.push({ seq, type: seq % 2 ? 'user/message' : 'assistant/message', data: { source: { kind: seq % 2 ? 'user' : 'model' }, content: [{ type: 'text', text: 'A later turn without paper references.' }] } })
  messages.push({ seq: 85, type: 'turn/end', data: { reason: 'error' } })
  const complete = messages.reduce(foldAnnotationUsage, annotationUsageProjection.init({ id: 'session-1' }))
  assert.equal(annotationUsageProjection.key, ANNOTATION_USAGE_KEY)
  assert.equal(annotationUsageProjection.stateSchema.safeParse(complete).success, true)
  const persisted = JSON.parse(JSON.stringify(annotationUsageProjection.wire.view(complete)))
  const resumed = messages.slice(-20).reduce(foldAnnotationUsage, persisted)
  assert.equal(resumed.usage['note-1'], version)
  assert.equal(resumed.revision, 4)
  assert.equal(annotationUsageProjection.wire.viewSchema.safeParse(resumed).success, true)
})

test('an explicitly resent newer version replaces only its annotation and leaves other versions intact', () => {
  const initial = foldAnnotationUsage(emptyAnnotationUsage('session-1'), referenceEvent(4, snapshot([{ id: 'note-1', version }, { id: 'note-2', version }])))
  const updated = foldAnnotationUsage(initial, referenceEvent(10, snapshot([{ id: 'note-1', version: newer }])))
  assert.deepEqual(updated.usage, { 'note-1': newer, 'note-2': version })
  assert.equal(initial.usage['note-1'], version)
  assert.equal(updated.revision, 10)
})

test('source metadata stays outside model text and prototype-like annotation IDs remain ordinary own data', () => {
  const value = snapshot([{ id: '__proto__', version }, { id: 'constructor', version }])
  const source = annotationReferenceSource(value, snapshotId)
  assert.equal(source.kind, 'plugin')
  assert.equal(source.plugin, 'Paper Library')
  assert.equal(source.paperLibraryReference.body_hash, annotationBodyHash(value.text))
  assert.equal(value.text.includes(snapshotId), false)
  const folded = foldAnnotationUsage(emptyAnnotationUsage('session-1'), referenceEvent(1, value))
  assert.equal(Object.getPrototypeOf(folded.usage), Object.prototype)
  assert.equal(Object.hasOwn(folded.usage, '__proto__'), true)
  assert.equal(folded.usage.__proto__, version)
  assert.equal(folded.usage.constructor, version)
  assert.equal(annotationUsageProjection.stateSchema.safeParse(folded).success, true)
})

test('projection storage is bounded and explicitly reports eviction instead of claiming complete coverage', () => {
  let state = emptyAnnotationUsage('session-1')
  for (let batch = 0; batch < 6; batch++) {
    const refs = Array.from({ length: 1000 }, (_, index) => ({ id: `note-${batch * 1000 + index}`, version }))
    state = foldAnnotationUsage(state, referenceEvent(batch, snapshot(refs)))
  }
  assert.equal(Object.keys(state.usage).length, 5000)
  assert.equal(state.truncated, true)
  assert.equal(Object.hasOwn(state.usage, 'note-0'), false)
  assert.equal(state.usage['note-5999'], version)
  assert.equal(annotationUsageProjection.stateSchema.safeParse(state).success, true)
})
