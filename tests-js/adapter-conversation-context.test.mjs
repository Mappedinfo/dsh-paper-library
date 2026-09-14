import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { appendConversationDraft, createConversationBridge, readerSnapshot } from '../src/client/conversation-context.mjs'

const tick = async () => { for (let i = 0; i < 6; i++) await Promise.resolve() }

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
  e.message({ type: 'paper-library:reader-state', snapshot: { ...snapshot, chatDraft: '文'.repeat(23000) } })
  assert.equal(e.messages.at(-1).value.type, 'paper-library:reader-state-error')
  e.message({ type: 'paper-library:ready' })
  assert.deepEqual(e.messages.at(-1).value.snapshot, snapshot)
  assert.throws(() => readerSnapshot({ ...snapshot, page: -1 }), /页码/)
  assert.throws(() => readerSnapshot({ ...snapshot, annotationDraft: { mode: 'image' } }), /草稿类型/)
  assert.throws(() => readerSnapshot({ ...snapshot, chatContext: { annotationIds: Array(41).fill('note') } }), /40/)
  assert.throws(() => readerSnapshot({ ...snapshot, chatContext: { annotationIds: [], selection: { page: 2, text: 'x'.repeat(8001) } } }), /长度/)
  assert.throws(() => readerSnapshot({ ...snapshot, chatDraft: 'x'.repeat(64000), chatContext: { annotationIds: [], selection: { page: 2, text: 'x'.repeat(3000) } } }), /64 KiB/)
  e.bridge.dispose()
})
