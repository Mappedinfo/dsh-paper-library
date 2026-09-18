import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFile } from 'node:fs/promises'
import { splitFeedbackReplies } from '../src/bridge.mjs'

const context = vm.createContext({ window: {} })
vm.runInContext(await readFile(new URL('../web/annotation-threads.js', import.meta.url), 'utf8'), context)
const { threads, isAi } = context.window.PaperAnnotationThreads
// Values built inside the VM realm are copied into host objects before asserting.
const plain = value => JSON.parse(JSON.stringify(value))
const ids = list => Array.from(list || [], value => value.id)

const note = (id, extra = {}) => ({ id, type: 'note', comment: `comment ${id}`, ...extra })
const ai = (id, extra = {}) => ({ id, type: 'note', kind: 'ai-feedback', comment: `reply ${id}`, ...extra })

test('per-annotation replies nest under exactly their own annotation', () => {
  const annotations = [note('a'), note('b'), ai('r1', { annotation_ids: ['a'], reply_to: 'a' }), ai('r2', { annotation_ids: ['b'], reply_to: 'b' })]
  const { notes, replies, unlinked } = threads(annotations)
  assert.deepEqual(ids(notes), ['a', 'b'])
  assert.deepEqual(ids(replies.get('a')), ['r1'])
  assert.deepEqual(ids(replies.get('b')), ['r2'])
  assert.deepEqual(ids(unlinked), [])
  assert.equal(isAi(ai('r1')), true)
  assert.equal(isAi(note('a')), false)
})

test('a combined feedback answer is shown once instead of copied under every annotation', () => {
  const annotations = [note('a'), note('b'), note('c'), ai('combined', { annotation_ids: ['a', 'b', 'c'], model: 'synthetic/model' })]
  const { replies, unlinked } = threads(annotations)
  assert.deepEqual(ids(replies.get('a')), ['combined'])
  assert.deepEqual(ids(replies.get('b')), [], 'A combined answer is never duplicated')
  assert.deepEqual(ids(replies.get('c')), [])
  assert.deepEqual(ids(unlinked), [])
})

test('a conversation reply keeps its documented shared placement under every cited annotation', () => {
  const annotations = [note('a'), note('b'), ai('chat', { annotation_ids: ['a', 'b'], source_kind: 'dsh-conversation' })]
  const { replies } = threads(annotations)
  assert.deepEqual(ids(replies.get('a')), ['chat'])
  assert.deepEqual(ids(replies.get('b')), ['chat'])
})

test('replies fall back to /IRT provenance, skip unknown parents and survive empty input', () => {
  const annotations = [note('a'), ai('legacy', { reply_to: 'a' }), ai('orphan', { annotation_ids: ['missing'] })]
  const { replies, unlinked } = threads(annotations)
  assert.deepEqual(ids(replies.get('a')), ['legacy'])
  assert.deepEqual(ids(unlinked), ['orphan'])
  const empty = threads([])
  assert.deepEqual(ids(empty.notes), []); assert.deepEqual(ids(empty.unlinked), []); assert.equal(empty.replies.size, 0)
  assert.deepEqual(ids(threads(undefined).notes), [])
})

test('splitFeedbackReplies accepts one entry per annotation and reports unanswered ids', () => {
  const annotations = [{ id: 'a', page: 1 }, { id: 'b', page: 2 }]
  const split = splitFeedbackReplies(JSON.stringify({ replies: [{ annotation_id: 'a', comment: ' answer for a ' }] }), annotations)
  assert.deepEqual(split.missing, ['b'])
  assert.deepEqual(split.replies, [{ annotation_id: 'a', comment: 'answer for a' }])
  const fenced = splitFeedbackReplies('```json\n[{"annotation_id":"b","comment":"answer for b"}]\n```', annotations)
  assert.deepEqual(fenced.replies, [{ annotation_id: 'b', comment: 'answer for b' }])
  assert.equal(splitFeedbackReplies('One combined answer for both annotations.', annotations), null, 'A combined answer is not a split')
  assert.equal(splitFeedbackReplies('', annotations), null)
})

test('splitFeedbackReplies refuses mis-assignment instead of writing to the wrong annotation', () => {
  const annotations = [{ id: 'a', page: 1 }, { id: 'b', page: 2 }]
  const build = body => JSON.stringify(body)
  assert.throws(() => splitFeedbackReplies(build({ replies: [{ annotation_id: 'external', comment: 'x' }] }), annotations), /未提供的批注/)
  assert.throws(() => splitFeedbackReplies(build({ replies: [{ annotation_id: 'a', comment: 'x' }, { annotation_id: 'a', comment: 'y' }] }), annotations), /同一条批注/)
  assert.throws(() => splitFeedbackReplies(build({ replies: [{ annotation_id: 'a', comment: '  ' }] }), annotations), /空回复/)
  assert.throws(() => splitFeedbackReplies(build({ replies: [{ annotation_id: 'a', comment: 'x'.repeat(8001) }] }), annotations), /8000/)
  assert.throws(() => splitFeedbackReplies(build({ replies: [] }), annotations), /数量/)
  assert.throws(() => splitFeedbackReplies(build({ replies: [{ annotation_id: 'a', comment: 'x' }, { annotation_id: 'b', comment: 'y' }, { annotation_id: 'c', comment: 'z' }] }), annotations), /数量/)
  assert.throws(() => splitFeedbackReplies(build({ replies: ['nope'] }), annotations), /格式无效/)
})
