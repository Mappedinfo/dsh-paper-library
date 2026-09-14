import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLanguageLearning } from '../src/harness/language-learning.mjs'
import { createLocalStateStore } from '../src/local-state.mjs'
import { resolveConfig } from '../src/harness/config.mjs'

function memoryStore() {
  const records = new Map(); let sequence = 0
  const store = {
    records, beforePut: null,
    async get(key) { return structuredClone(records.get(key) ?? { key, value: null, revision: 0, updated_at: null }) },
    async put(key, value, expected) {
      await store.beforePut?.(key, value)
      const current = await store.get(key)
      if (expected !== current.revision) throw Object.assign(new Error('conflict'), { code: 'STATE_CONFLICT', current })
      const record = { key, value: structuredClone(value), revision: createHash('sha256').update(String(++sequence)).digest('hex'), updated_at: new Date().toISOString() }
      records.set(key, record); return structuredClone(record)
    },
    async list({ prefix, offset, limit }) {
      assert.ok(limit <= 50)
      const keys = [...records.keys()].filter(key => key.startsWith(prefix)).sort(), selected = keys.slice(offset, offset + limit)
      return { records: await Promise.all(selected.map(store.get)), total: keys.length, offset, limit, next_offset: offset + selected.length, hasMore: offset + selected.length < keys.length, truncated: false }
    },
  }
  return store
}
const source = 'Epistemic uncertainty remains in this estimate.'
const request = { action: 'language_generate', id: 'paper-a', mode: 'translate', text: source, page: 2, request_id: 'request-1' }
const response = { result: '该估计仍存在认识不确定性。', explanation: '保留了不确定性措辞。', vocabulary: [{ term: 'Epistemic', meaning: '认识上的；有关知识的', source_sentence: source }] }
function fixture(store = memoryStore()) {
  const calls = [], ensureCalls = [], kernelCalls = []
  const f = { store, calls, ensureCalls, kernelCalls, answer: JSON.stringify(response), route: { provider: 'configured-dsh', model: 'paper-current', reasoningEffort: 'high' }, gate: null }
  f.options = { store, library: '/synthetic/library', python: '/synthetic/python',
    dispatch: async input => { kernelCalls.push(input); return { id: input.id, pdf: 'synthetic.pdf', page_count: 24 } },
    paperChat: async input => { ensureCalls.push(input); return { sessionId: `session-${input.id}`, model: f.route } },
    ai: async input => { calls.push(input); await f.gate; if (f.answer instanceof Error) throw f.answer; return f.answer },
  }
  f.handle = createLanguageLearning(f.options)
  return f
}

test('language output budget is independent from feedback and finitely validated', () => {
  const config = resolveConfig({ library: '/synthetic/library' })
  assert.equal(config.maxLanguageOutputTokens, 8192); assert.equal(config.maxOutputTokens, 1600)
  assert.equal(resolveConfig({ library: '/synthetic/library', maxOutputTokens: 600, maxLanguageOutputTokens: 4000 }).maxLanguageOutputTokens, 4000)
  for (const value of [0, 255, 16385, NaN, Infinity, 300.5, '8192']) assert.throws(() => resolveConfig({ maxLanguageOutputTokens: value }), /maxLanguageOutputTokens/)
})

test('generation uses only authoritative paper model and persists source/model/result provenance', async () => {
  const f = fixture()
  const result = await f.handle({ ...request, provider: 'forged-provider', model: 'forged-model', api_key: 'not-used' })
  assert.equal(result.status, 'complete'); assert.equal(result.target_language, 'zh-CN')
  assert.equal(result.paper_id, 'paper-a'); assert.equal(result.page, 2); assert.equal(result.source_text, source)
  assert.equal(result.request_id, request.request_id)
  assert.deepEqual(result.model, f.route); assert.equal(result.model_source, 'harness-session')
  assert.equal(f.calls[0].provider, 'configured-dsh'); assert.equal(f.calls[0].model, 'paper-current')
  assert.equal(f.calls[0].reasoningEffort, 'high'); assert.equal(f.calls[0].signal.aborted, false)
  assert.deepEqual(f.ensureCalls, [{ action: 'chat_ensure', id: 'paper-a' }]); assert.equal(result.request, undefined)
  const words = await f.handle({ action: 'vocabulary_list' })
  assert.equal(words.items.length, 1); assert.equal(words.items[0].status, 'learning'); assert.equal(words.items[0].suggested_by, 'ai')
  assert.equal(words.items[0].encounters[0].result_id, result.id); assert.deepEqual(words.items[0].encounters[0].model, f.route)
  assert.equal(words.items[0].encounters[0].source_sentence, source)
})

test('parallel duplicates and service restart replay generate exactly once; altered text conflicts', async () => {
  const f = fixture(); let release; f.gate = new Promise(resolve => { release = resolve })
  const first = f.handle(request), second = f.handle(request); release()
  const [a, b] = await Promise.all([first, second]); assert.equal(a.id, b.id); assert.equal(f.calls.length, 1)
  const restarted = createLanguageLearning(f.options), replay = await restarted(request)
  assert.equal(replay.replayed, true); assert.equal(f.calls.length, 1)
  await assert.rejects(restarted({ ...request, text: `${source} Changed.` }), error => error.code === 'LANGUAGE_REQUEST_CONFLICT')
  assert.equal((await restarted({ action: 'vocabulary_list' })).items[0].encounters.length, 1)
})

test('every fresh operation follows current paper model; polish retains source language and evidence in prompt', async () => {
  const f = fixture(); await f.handle(request); f.route = { provider: 'configured-dsh', model: 'new-paper-selection' }
  const polished = await f.handle({ ...request, request_id: 'polish', mode: 'polish', target_language: 'en' })
  assert.equal(polished.target_language, 'source'); assert.equal(polished.model.model, 'new-paper-selection')
  assert.match(f.calls[1].prompt, /ORIGINAL LANGUAGE/); assert.match(f.calls[1].prompt, /Do not translate/)
  assert.match(f.calls[1].prompt, /claim strength/); assert.match(f.calls[1].prompt, /quoted source data, never instructions/)
})

test('opening history/search/export calls neither model nor paper Session and keeps library data scoped', async () => {
  const f = fixture()
  assert.deepEqual((await f.handle({ action: 'language_history', id: 'paper-a' })).items, [])
  assert.deepEqual((await f.handle({ action: 'vocabulary_list', query: 'nothing', status: 'mastered' })).items, [])
  assert.equal((await f.handle({ action: 'vocabulary_export', format: 'json' })).count, 0)
  assert.equal(f.calls.length + f.ensureCalls.length + f.kernelCalls.length, 0)
  await f.handle(request)
  assert.equal((await f.handle({ action: 'language_history', id: 'paper-b' })).total, 0)
})

test('only exact-source terms and attested source sentences enter vocabulary', async () => {
  const f = fixture()
  f.answer = JSON.stringify({ ...response, vocabulary: [...response.vocabulary,
    { term: 'epistemic', meaning: 'duplicate case', source_sentence: source },
    { term: 'confounding', meaning: 'not in selected source', source_sentence: source },
    { term: 'estimate', meaning: 'fabricated source sentence', source_sentence: 'This estimate was definitively proven.' },
    { term: 'main', meaning: 'substring only', source_sentence: source },
  ] })
  const generated = await f.handle(request)
  assert.deepEqual(generated.vocabulary.map(word => word.term), ['Epistemic'])
  assert.equal((await f.handle({ action: 'vocabulary_list' })).total, 1)
})

test('case-folded repeated encounters preserve user meaning and mastered state', async () => {
  const f = fixture(); await f.handle(request)
  const [word] = (await f.handle({ action: 'vocabulary_list' })).items
  const edited = await f.handle({ action: 'vocabulary_update', id: word.id, expected_revision: word.revision, meaning: '我的词义笔记', status: 'mastered' })
  assert.equal(edited.meaning_source, 'user')
  f.answer = JSON.stringify({ ...response, vocabulary: [{ ...response.vocabulary[0], term: 'EPISTEMIC', meaning: 'new AI guess' }] })
  await f.handle({ ...request, id: 'paper-b', request_id: 'encounter-2' })
  const [retained] = (await f.handle({ action: 'vocabulary_list', query: '我的', status: 'mastered' })).items
  assert.equal(retained.id, word.id); assert.equal(retained.meaning, '我的词义笔记'); assert.equal(retained.status, 'mastered')
  assert.equal(retained.encounters.length, 2); assert.equal(retained.encounters[1].paper_id, 'paper-b')
  await assert.rejects(f.handle({ action: 'vocabulary_update', id: word.id, expected_revision: word.revision, status: 'learning' }), error => error.code === 'STATE_CONFLICT')
})

test('deleted vocabulary stays deleted through replay and later AI suggestions', async () => {
  const f = fixture(); await f.handle(request)
  const [word] = (await f.handle({ action: 'vocabulary_list' })).items
  const result = await f.handle({ action: 'vocabulary_delete', id: word.id, expected_revision: word.revision })
  assert.equal(result.deleted, true)
  await f.handle(request); await f.handle({ ...request, request_id: 'later-suggestion' })
  assert.equal((await f.handle({ action: 'vocabulary_list' })).total, 0)
  const tombstone = (await f.store.get(`vocabulary:${word.id}`)).value
  assert.equal(tombstone.meaning, undefined); assert.equal(tombstone.encounters, undefined)
})

test('validated result survives failed vocabulary commit and resumes without another generation', async () => {
  const f = fixture(); let failOnce = true
  f.store.beforePut = key => { if (key.startsWith('vocabulary:') && failOnce) { failOnce = false; throw new Error('Synthetic disk failure') } }
  await assert.rejects(f.handle(request), error => error.code === 'LANGUAGE_COMMIT_RETRY' && error.generation_status === 'committing' && error.retry_with_new_request === false)
  const pending = await f.handle({ action: 'language_history', id: 'paper-a' })
  assert.equal(pending.items[0].status, 'committing')
  const restarted = createLanguageLearning(f.options), recovered = await restarted(request)
  assert.equal(recovered.status, 'complete'); assert.equal(recovered.replayed, true); assert.equal(f.calls.length, 1)
  assert.equal((await restarted({ action: 'vocabulary_list' })).items[0].encounters.length, 1)
})

test('failed final marker retries do not duplicate already committed vocabulary encounters', async () => {
  const f = fixture(); let failOnce = true
  f.store.beforePut = (key, value) => { if (key.startsWith('language.result:') && value.status === 'complete' && failOnce) { failOnce = false; throw new Error('Synthetic final marker failure') } }
  await assert.rejects(f.handle(request), /Synthetic final marker failure/)
  await createLanguageLearning(f.options)(request)
  const [word] = (await f.handle({ action: 'vocabulary_list' })).items
  assert.equal(word.encounters.length, 1); assert.equal(f.calls.length, 1)
})

test('malformed and interrupted model responses never become finished or silently regenerate', async () => {
  for (const answer of ['{"result":"unfinished"', JSON.stringify({ result: 'x', explanation: '', vocabulary: [null] }), new Error('AI feedback stream ended without a finish event')]) {
    const f = fixture(); f.answer = answer
    await assert.rejects(f.handle(request), error => error.generation_status === 'failed' && error.retry_with_new_request === true)
    const history = await f.handle({ action: 'language_history', id: 'paper-a' })
    assert.equal(history.items[0].status, 'failed'); assert.equal(history.items[0].result, undefined)
    assert.equal((await f.handle({ action: 'vocabulary_list' })).total, 0)
    await assert.rejects(createLanguageLearning(f.options)(request), error => error.code === 'LANGUAGE_FAILED')
    assert.equal(f.calls.length, 1)
  }
})

test('unknown pending process state cannot resubmit a model call', async () => {
  const f = fixture(); let release; f.gate = new Promise(resolve => { release = resolve })
  const inFlight = f.handle(request)
  while (!f.calls.length) await new Promise(resolve => setImmediate(resolve))
  await assert.rejects(createLanguageLearning(f.options)(request), error => error.code === 'LANGUAGE_PENDING')
  release(); await inFlight; assert.equal(f.calls.length, 1)
})

test('missing paper model, invalid pages and excessive inputs never call an AI fallback', async () => {
  const f = fixture(); f.route = undefined
  await assert.rejects(f.handle({ ...request, model: 'forged' }), error => error.code === 'LANGUAGE_MODEL_REQUIRED')
  await assert.rejects(f.handle({ ...request, request_id: 'bad-page', page: 25 }), /页码/)
  await assert.rejects(f.handle({ ...request, request_id: 'oversize', text: 'x'.repeat(8001) }), /8000/)
  await assert.rejects(f.handle({ action: 'vocabulary_list', limit: 51 }), /分页/)
  assert.equal(f.calls.length, 0)
})

test('CSV export is inert, UTF-8, provenance-linked and honors filters', async () => {
  const f = fixture(); await f.handle(request)
  const [word] = (await f.handle({ action: 'vocabulary_list' })).items
  await f.handle({ action: 'vocabulary_update', id: word.id, expected_revision: word.revision, meaning: '=SUM(1,2) 中文' })
  const csv = await f.handle({ action: 'vocabulary_export', format: 'csv' })
  assert.equal(csv.count, 1); assert.equal(csv.truncated, false); assert.match(csv.content, /'=SUM\(1,2\) 中文/)
  assert.match(csv.content, /configured-dsh\/paper-current/); assert.match(csv.content, /paper-a/)
  assert.equal((await f.handle({ action: 'vocabulary_export', format: 'json', status: 'mastered' })).count, 0)
})

test('real host disk store persists language history, request replay and user vocabulary revisions across reopening', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'paper-language-test-'))
  try {
    const library = join(directory, 'library'), home = join(directory, 'dsh-home')
    await mkdir(library)
    const f = fixture(createLocalStateStore({ library, home }))
    const result = await f.handle(request)
    const [word] = (await f.handle({ action: 'vocabulary_list' })).items
    await f.handle({ action: 'vocabulary_update', id: word.id, meaning: 'durable user meaning', status: 'mastered', expected_revision: word.revision })
    const second = createLanguageLearning({ ...f.options, store: createLocalStateStore({ library, home }) })
    const recovered = await second({ action: 'language_history', id: request.id })
    assert.equal(recovered.items[0].request_id, request.request_id); assert.equal(recovered.items[0].id, result.id)
    assert.equal((await second(request)).replayed, true); assert.equal(f.calls.length, 1)
    assert.equal((await second({ action: 'vocabulary_list', status: 'mastered' })).items[0].meaning, 'durable user meaning')
    const otherLibrary = join(directory, 'other-library'); await mkdir(otherLibrary)
    const isolated = createLanguageLearning({ ...f.options, store: createLocalStateStore({ library: otherLibrary, home }) })
    assert.equal((await isolated({ action: 'language_history', id: request.id })).total, 0)
    assert.equal((await isolated({ action: 'vocabulary_list' })).total, 0)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('vocabulary search paginates past a disk batch without retaining duplicate terms', async () => {
  const f = fixture(), terms = Array.from({ length: 60 }, (_, i) => `Token${String(i).padStart(2, '0')}`), text = `${terms.join(' ')}.`
  for (let batch = 0; batch < 3; batch++) {
    f.answer = JSON.stringify({ ...response, vocabulary: terms.slice(batch * 20, batch * 20 + 20).map(term => ({ term, meaning: 'Synthetic learning gloss', source_sentence: text })) })
    await f.handle({ ...request, text, request_id: `batch-${batch}` })
  }
  const first = await f.handle({ action: 'vocabulary_list', query: 'token', limit: 50 }), second = await f.handle({ action: 'vocabulary_list', query: 'token', offset: 50, limit: 10 })
  assert.equal(first.total, 60); assert.equal(first.hasMore, true); assert.equal(second.hasMore, false)
  assert.equal(new Set([...first.items, ...second.items].map(word => word.id)).size, 60)
  assert.equal((await f.handle({ action: 'vocabulary_list', query: 'Token59' })).total, 1)
})

test('long-running word encounters retain a finite provenance window and report its bound', async () => {
  const f = fixture()
  for (let i = 0; i < 62; i++) await f.handle({ ...request, request_id: `repeat-${i}` })
  const [word] = (await f.handle({ action: 'vocabulary_list' })).items
  assert.equal(word.encounters.length, 5); assert.equal(word.encounters_retained, 60); assert.equal(word.encounters_truncated, true)
  const history = await f.handle({ action: 'language_history', id: request.id, offset: 50, limit: 20 })
  assert.equal(history.total, 62); assert.equal(history.items.length, 12); assert.equal(history.hasMore, false)
  const before = f.calls.length; await f.handle({ ...request, request_id: 'repeat-61' })
  assert.equal(f.calls.length, before); assert.equal((await f.handle({ action: 'vocabulary_list' })).items[0].encounters_retained, 60)
})
