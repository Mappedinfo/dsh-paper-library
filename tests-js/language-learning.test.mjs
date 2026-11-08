import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLanguageLearning, resolveTranslationTarget } from '../src/harness/language-learning.mjs'
import { createAnnotationTranslation } from '../src/harness/annotation-translation.mjs'
import { createLocalStateStore } from '../src/local-state.mjs'
import { resolveConfig } from '../src/harness/config.mjs'
import { createFetchHandler } from '../src/http.mjs'

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
    getDefaultModel: () => f.route,
    models: async () => ({ models: [{ provider: 'configured-dsh', id: 'paper-current' }, { provider: 'configured-dsh', id: 'new-paper-selection' }, { provider: 'configured-dsh', id: 'override' }] }),
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

test('generation uses the host default model and persists source/model/result provenance', async () => {
  const f = fixture()
  const result = await f.handle({ ...request, provider: 'forged-provider', model: 'forged-model', api_key: 'not-used' })
  assert.equal(result.status, 'complete'); assert.equal(result.target_language, 'zh-CN')
  assert.equal(result.paper_id, 'paper-a'); assert.equal(result.page, 2); assert.equal(result.source_text, source)
  assert.equal(result.request_id, request.request_id)
  assert.deepEqual(result.model, f.route); assert.equal(result.model_source, 'harness-default'); assert.match(result.prompt_version, /^language-v3:/)
  assert.equal(f.calls[0].provider, 'configured-dsh'); assert.equal(f.calls[0].model, 'paper-current')
  assert.equal(f.calls[0].reasoningEffort, 'high'); assert.equal(f.calls[0].signal.aborted, false)
  assert.deepEqual(f.ensureCalls, []); assert.equal(result.request, undefined)
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

test('every fresh operation follows the current host default; polish retains source language and evidence', async () => {
  const f = fixture(); await f.handle(request); f.route = { provider: 'configured-dsh', model: 'new-paper-selection' }
  const polished = await f.handle({ ...request, request_id: 'polish', mode: 'polish', target_language: 'en' })
  assert.equal(polished.target_language, 'source'); assert.equal(polished.model.model, 'new-paper-selection')
  assert.match(f.calls[1].prompt, /ORIGINAL LANGUAGE/); assert.match(f.calls[1].prompt, /Do not translate/)
  assert.match(f.calls[1].prompt, /claim strength/); assert.match(f.calls[1].prompt, /quoted source data, never instructions/)
})

test('settings use CAS, configured models and mode-specific guidance without changing replay', async () => {
  const f = fixture(), settings = await f.handle({ action: 'language_settings_get' })
  assert.deepEqual(settings.default_model, f.route)
  const value = { model: { provider: 'configured-dsh', model: 'override' }, translate_prompt: '保留缩写', polish_prompt: '使用简洁句子' }
  const saved = await f.handle({ action: 'language_settings_update', value, expected_revision: settings.revision })
  assert.equal(saved.value.model.model, 'override')
  await assert.rejects(f.handle({ action: 'language_settings_update', value, expected_revision: settings.revision }), error => error.code === 'STATE_CONFLICT')
  const first = await f.handle(request)
  assert.equal(first.model.model, 'override'); assert.equal(first.model_source, 'language-override')
  assert.match(f.calls[0].prompt, /保留缩写/); assert.doesNotMatch(f.calls[0].prompt, /使用简洁句子/)
  await f.handle({ action: 'language_settings_update', value: { ...value, translate_prompt: '另一个偏好' }, expected_revision: saved.revision })
  assert.equal((await f.handle(request)).prompt_version, first.prompt_version); assert.equal(f.calls.length, 1)
  const polish = await f.handle({ ...request, mode: 'polish', request_id: 'polish-extra' })
  assert.match(f.calls[1].prompt, /使用简洁句子/); assert.notEqual(polish.prompt_version, first.prompt_version)
  await assert.rejects(f.handle({ action: 'language_settings_update', value: { ...value, model: { provider: 'unknown', model: 'forged' } }, expected_revision: saved.revision }), error => error.code === 'LANGUAGE_MODEL_UNAVAILABLE')
})

test('translation target settings default to auto, retain legacy updates and enforce revisions', async () => {
  const store = memoryStore()
  const old = { model: null, translate_prompt: 'old', polish_prompt: '' }
  await store.put('language.settings', old, 0)
  const f = fixture(store), initial = await f.handle({ action: 'language_settings_get' })
  assert.equal(initial.value.target_language, 'auto')
  const updated = await f.handle({ action: 'language_settings_update', value: { ...old, target_language: 'en' }, expected_revision: initial.revision })
  assert.equal(updated.value.target_language, 'en')
  const legacy = await f.handle({ action: 'language_settings_update', value: { ...old, translate_prompt: 'legacy edit' }, expected_revision: updated.revision })
  assert.equal(legacy.value.target_language, 'en')
  await assert.rejects(f.handle({ action: 'language_settings_update', value: { ...old, target_language: 'auto' }, expected_revision: updated.revision }), error => error.code === 'STATE_CONFLICT')
  await assert.rejects(f.handle({ action: 'language_settings_update', value: { ...old, target_language: 'fr' }, expected_revision: legacy.revision }), /翻译目标语言无效/)
})

test('automatic translation resolves bounded source script while old requests replay unchanged', async () => {
  const f = fixture()
  const chinese = await f.handle({ ...request, request_id: 'chinese', text: '请翻译模型训练结果。', target_language: 'auto' })
  assert.equal(chinese.target_language, 'en')
  assert.equal(chinese.requested_target_language, 'auto')
  assert.match(f.calls[0].prompt, /into English/)
  const english = await f.handle({ ...request, request_id: 'english', text: 'The estimate uses data from 中国.', target_language: 'auto' })
  assert.equal(english.target_language, 'zh-CN')
  assert.match(f.calls[1].prompt, /into Simplified Chinese/)
  const forced = await f.handle({ ...request, request_id: 'explicit', text: '请翻译模型训练结果。', target_language: 'zh-CN' })
  assert.equal(forced.target_language, 'zh-CN')
  const legacy = await f.handle({ ...request, request_id: 'old-replay', text: '请翻译模型训练结果。' })
  assert.equal(legacy.target_language, 'zh-CN')
  const replay = await createLanguageLearning(f.options)({ ...request, request_id: 'old-replay', text: '请翻译模型训练结果。' })
  assert.equal(replay.replayed, true)
  assert.equal(f.calls.length, 4)
})

test('automatic language resolution ignores common TeX markup, citations, comments and formulas', () => {
  const chinese = String.raw`\section{研究结果} % English comment with many distracting words
\textbf{模型训练}，参见 \cite{very-long-english-citation-key}。$englishvariables + anotherformula$`
  assert.equal(resolveTranslationTarget(chinese, 'auto'), 'en')
  const english = String.raw`This method reports results in \textbf{English}. \cite{中文引用} $变量 + 公式$`
  assert.equal(resolveTranslationTarget(english, 'auto'), 'zh-CN')
  assert.equal(resolveTranslationTarget(chinese, 'zh-CN'), 'zh-CN')
  assert.throws(() => resolveTranslationTarget(chinese, 'fr'), /翻译目标语言无效/)
})

test('automatic direction distinguishes Japanese and Korean script from traditional Chinese and mixed English', () => {
  assert.equal(resolveTranslationTarget('この研究では都市の成長を分析します。', 'auto'), 'zh-CN')
  assert.equal(resolveTranslationTarget('東京に行く。', 'auto'), 'zh-CN')
  assert.equal(resolveTranslationTarget('이 연구에서는 도시의 성장과 文化 변화를 분석합니다.', 'auto'), 'zh-CN')
  assert.equal(resolveTranslationTarget('本研究分析城市增長及其空間變化。', 'auto'), 'en')
  assert.equal(resolveTranslationTarget('The paper discusses 中国 and 日本 with synthetic data.', 'auto'), 'zh-CN')
  assert.equal(resolveTranslationTarget('城市研究引用あ這個符號。', 'auto'), 'en', 'one incidental kana should not determine the passage language')
  assert.equal(resolveTranslationTarget(String.raw`\cite{かなかな} 本研究分析城市增長。`, 'auto'), 'en', 'citation keys are excluded')
})

test('language settings and generation route through the host HTTP adapter', async () => {
  const f = fixture(), handler = createFetchHandler({ library: '/synthetic/library', localState: f.store, languageLearning: f.handle })
  const call = async input => {
    const response = await handler(new Request('http://localhost/api', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }))
    const body = await response.json(); assert.equal(body.ok, true, body.error); return body.result
  }
  const initial = await call({ action: 'language_settings_get' })
  assert.equal(initial.default_model.model, 'paper-current')
  await call({ action: 'language_settings_update', expected_revision: initial.revision, value: { model: { provider: 'configured-dsh', model: 'override' }, translate_prompt: '保留合成术语', polish_prompt: '' } })
  const result = await call(request)
  assert.equal(result.model.model, 'override');assert.match(f.calls[0].prompt, /保留合成术语/)
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

for (const cached of [undefined, 0, 1, 99, '24']) test(`page validation reads the PDF rather than cached page_count=${cached}`, async () => {
  const f = fixture(); f.options.dispatch = async input => input.action === 'get' ? {pdf:true,page_count:cached} : {page_count:24}; f.handle=createLanguageLearning(f.options)
  assert.equal((await f.handle(request)).status,'complete')
  await assert.rejects(f.handle({...request,request_id:'beyond-real-file',page:25}), /页码/)
  assert.equal(f.calls.length,1)
})

test('automatic translation chooses configured Flash without reasoning; polish and explicit choices retain their route',async()=>{
 const f=fixture();f.options.models=async()=>({models:[{provider:'deepseek-official',id:'deepseek-flash'},{provider:f.route.provider,id:f.route.model}]});const handle=createLanguageLearning(f.options);
 const translated=await handle({...request,request_id:'quick-translate'});assert.deepEqual(translated.model,{provider:'deepseek-official',model:'deepseek-flash',reasoningEffort:'off'});assert.equal(translated.model_source,'translation-lightweight');
 const polished=await handle({...request,mode:'polish',request_id:'normal-polish'});assert.deepEqual(polished.model,f.route);
 const settings=await handle({action:'language_settings_get'});assert.equal(settings.translation_default_model.model,'deepseek-flash');
 await handle({action:'language_settings_update',expected_revision:settings.revision,value:{model:f.route,translate_prompt:'',polish_prompt:''}});
 const explicit=await handle({...request,request_id:'explicit-translate'});assert.deepEqual(explicit.model,f.route);assert.equal(explicit.model_source,'language-override');
});

test('vocabulary ordering applies to the whole matched set before pagination',async()=>{
 const f=fixture();for(const [i,term]of ['Zulu','alpha','Beta'].entries()){const id=String(i).padStart(64,'0');await f.store.put(`vocabulary:${id}`,{id,term,meaning:'Synthetic',status:'learning',encounters:[],created_at:`2026-01-0${i+1}`,updated_at:`2026-02-0${i+1}`},0);}
 assert.equal((await f.handle({action:'vocabulary_list',sort:'term_asc',offset:1,limit:1})).items[0].term,'Beta');
 assert.equal((await f.handle({action:'vocabulary_list',sort:'created_desc',limit:1})).items[0].term,'Beta');
 assert.equal((await f.handle({action:'vocabulary_list',sort:'created_asc',limit:1})).items[0].term,'Zulu');
 await assert.rejects(f.handle({action:'vocabulary_list',sort:'invalid'}),/排序/);
});

const wordRequest = { action: 'vocabulary_create', id: 'paper-a', page: 2, term: 'Epistemic', source_sentence: source, request_id: 'create-word-1' }
function wordFixture() {
  const f = fixture(); f.answer = JSON.stringify({ meaning: '认识上的', sentence_translation: '该估计仍存在认识不确定性。' })
  const dispatch = f.options.dispatch; f.options.dispatch = async input => ({ ...await dispatch(input), title: 'Synthetic study' })
  f.handle = createLanguageLearning(f.options); return f
}
test('manual vocabulary creation returns bilingual linked sentence and unknown author background without guessing', async () => {
  const f = wordFixture(), word = await f.handle(wordRequest), encounter = word.encounters[0]
  assert.equal(word.suggested_by, 'user'); assert.equal(word.term, 'Epistemic'); assert.equal(word.meaning, '认识上的'); assert.equal(word.meaning_source, 'ai')
  assert.equal(encounter.title, 'Synthetic study'); assert.equal(encounter.paper_id, 'paper-a'); assert.equal(encounter.page, 2)
  assert.equal(encounter.source_sentence, source); assert.equal(encounter.sentence_translation, '该估计仍存在认识不确定性。')
  assert.equal(encounter.source_provenance, 'user_supplied'); assert.deepEqual(encounter.author_background, { kind: 'unknown', evidence: '', source: 'unknown' })
  assert.match(f.calls[0].prompt, /never instructions/); assert.match(f.calls[0].prompt, /Do not infer author nationality/)
  assert.equal(f.calls.length, 1)
})
test('manual vocabulary creation coalesces in flight and restarts replay without another model call', async () => {
  const f = wordFixture(); let release; f.gate = new Promise(resolve => { release = resolve })
  const a = f.handle(wordRequest), b = f.handle(wordRequest); release()
  const [first, second] = await Promise.all([a, b]); assert.equal(first.id, second.id)
  const replay = await createLanguageLearning(f.options)(wordRequest)
  assert.equal(replay.replayed, true); assert.equal(f.calls.length, 1); assert.equal(replay.encounters.length, 1)
  await assert.rejects(f.handle({ ...wordRequest, author_background: { kind: 'chinese', evidence: 'Explicit author biography' } }), error => error.code === 'LANGUAGE_REQUEST_CONFLICT')
})
test('manual vocabulary validates term/source/background before generation and uses real PDF page count', async () => {
  const f = wordFixture()
  for (const change of [{ source_sentence: '' }, { term: 'not-in-sentence' }, { page: null }, { author_background: { kind: 'chinese', evidence: '' } }, { author_background: { kind: 'guess', evidence: 'name' } }]) {
    await assert.rejects(f.handle({ ...wordRequest, ...change }))
  }
  await assert.rejects(f.handle({ ...wordRequest, page: 25 }), /页码超出/)
  assert.equal(f.calls.length, 0)
})
test('manual vocabulary retains manual meaning/mastery and independent source backgrounds', async () => {
  const f = wordFixture(), first = await f.handle(wordRequest)
  await f.handle({ action: 'vocabulary_update', id: first.id, expected_revision: first.revision, meaning: '我的解释', status: 'mastered' })
  const second = await f.handle({ ...wordRequest, id: 'paper-b', request_id: 'another-source', author_background: { kind: 'mixed', evidence: '用户核对的作者自述' } })
  assert.equal(second.meaning, '我的解释'); assert.equal(second.status, 'mastered'); assert.equal(second.encounters.length, 2)
  assert.equal(second.encounters[0].author_background.kind, 'unknown'); assert.equal(second.encounters[1].author_background.kind, 'mixed')
  assert.equal(second.encounters[1].author_background.source, 'user')
  const csv = await f.handle({ action: 'vocabulary_export', format: 'csv' }); assert.match(csv.content, /sentence_translation/); assert.match(csv.content, /用户核对的作者自述/)
})
test('manual vocabulary retries validated commit failure without generating again', async () => {
  const f = wordFixture(); let failed = false
  f.store.beforePut = async key => { if (key.startsWith('vocabulary:') && !failed) { failed = true; throw new Error('storage unavailable') } }
  await assert.rejects(f.handle(wordRequest), error => error.code === 'LANGUAGE_COMMIT_RETRY')
  const word = await createLanguageLearning(f.options)(wordRequest)
  assert.equal(word.encounters.length, 1); assert.equal(f.calls.length, 1)
})
test('manual vocabulary malformed output is not saved and replay cannot silently retry AI', async () => {
  const f = wordFixture(); f.answer = JSON.stringify({ meaning: '认识上的' })
  await assert.rejects(f.handle(wordRequest)); await assert.rejects(f.handle(wordRequest), error => error.code === 'LANGUAGE_FAILED')
  assert.equal((await f.handle({ action: 'vocabulary_list' })).total, 0); assert.equal(f.calls.length, 1)
})
test('manual vocabulary does not resurrect deleted entries or silently truncate a full source list', async () => {
  const f = wordFixture(), word = await f.handle(wordRequest), key = `vocabulary:${word.id}`, record = await f.store.get(key)
  await f.store.put(key, { ...record.value, encounters: Array.from({ length: 60 }, (_, i) => ({ ...record.value.encounters[0], result_id: `r-${i}` })) }, record.revision)
  await assert.rejects(f.handle({ ...wordRequest, request_id: 'over-capacity' }), /60 条来源/)
  const full = (await f.handle({ action: 'vocabulary_list' })).items[0]
  await f.handle({ action: 'vocabulary_delete', id: word.id, expected_revision: full.revision })
  await assert.rejects(f.handle(wordRequest), /删除/)
  await assert.rejects(f.handle({ ...wordRequest, request_id: 'deleted-new' }), /删除/)
  assert.equal(f.calls.length, 1)
})
test('manual vocabulary HTTP action uses configured language handler', async () => {
  const f = wordFixture(), handler = createFetchHandler({ library: '/synthetic/library', localState: f.store, languageLearning: f.handle })
  const response = await handler(new Request('http://localhost/api', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(wordRequest) }))
  const body = await response.json(); assert.equal(body.ok, true, body.error); assert.equal(body.result.term, 'Epistemic')
})


test('translation collects complete academic phrases with exact bilingual source and paper provenance in one call', async () => {
  const f = fixture(), sentence = 'We use relative location encoding.', text = `${sentence} The results remain uncertain.`
  f.options.dispatch = async input => ({ id: input.id, title: 'Synthetic spatial study', pdf: 'synthetic.pdf', page_count: 2 })
  f.handle = createLanguageLearning(f.options)
  f.answer = JSON.stringify({ explanation: '忠实翻译。', result: '我们使用相对位置编码。结果仍不确定。', vocabulary: [
    { term: 'relative location encoding', meaning: '相对位置编码', source_sentence: sentence, sentence_translation: '我们使用相对位置编码。' },
    { term: 'uncertain', meaning: '不确定的', source_sentence: 'The results remain uncertain.', sentence_translation: '结果仍不确定。' },
  ] })
  await f.handle({ ...request, text })
  const { items } = await f.handle({ action: 'vocabulary_list' })
  assert.equal(f.calls.length, 1); assert.equal(items.length, 2)
  const word = items.find(item => item.term === 'relative location encoding'), encounter = word.encounters[0]
  assert.equal(encounter.source_sentence, sentence); assert.equal(encounter.sentence_translation, '我们使用相对位置编码。')
  assert.equal(encounter.title, 'Synthetic spatial study'); assert.equal(encounter.paper_id, 'paper-a'); assert.equal(encounter.page, 2)
  assert.equal(encounter.author_background.kind, 'unknown'); assert.equal(encounter.source_provenance, 'selected_text')
  assert.match(f.calls[0].prompt, /sentence_translation/)
})

test('translation rejects invented context and malformed lexical fragments without rejecting useful scholarly words', async () => {
  const f = fixture(), text = 'Evidence constrains the claim. See https://example.test. The model is uncertain.'
  f.answer = JSON.stringify({ explanation: '忠实翻译。', result: '证据约束主张。参见链接。模型存在不确定性。', vocabulary: [
    { term: 'Evidence', meaning: '证据', source_sentence: 'Evidence constrains the claim.', sentence_translation: '证据约束主张。' },
    { term: 'uncertain', meaning: '不确定的', source_sentence: 'The model is uncertain on this task.', sentence_translation: '模型在此任务上不确定。' },
    { term: 'model', meaning: '模型', source_sentence: 'the model is uncertain.', sentence_translation: '模型不确定。' },
    { term: 'https://example.test', meaning: '链接', source_sentence: 'See https://example.test.', sentence_translation: '参见链接。' },
    { term: 'The model is uncertain.', meaning: '模型不确定', source_sentence: 'The model is uncertain.', sentence_translation: '模型不确定。' },
    { term: 'the', meaning: '这个', source_sentence: 'Evidence constrains the claim.', sentence_translation: '证据约束主张。' },
  ] })
  await f.handle({ ...request, text })
  assert.deepEqual((await f.handle({ action: 'vocabulary_list' })).items.map(item => item.term), ['Evidence'])
})

test('legacy translation output reuses only an exact full-source translation and never a paragraph for a substring', async () => {
  const f = fixture(), text = `${source} We need further evidence.`
  f.answer = JSON.stringify(response)
  await f.handle({ ...request, text })
  const word = (await f.handle({ action: 'vocabulary_list' })).items[0]
  assert.equal(word.encounters[0].sentence_translation, undefined)
  await f.handle({ ...request, request_id: 'exact-source' })
  assert.equal((await f.handle({ action: 'vocabulary_list' })).items[0].encounters[1].sentence_translation, response.result)
})

test('a translated standalone word is collected even when the model omits its vocabulary suggestion', async () => {
  const f = fixture(); f.answer = JSON.stringify({ explanation: '词义对照。', result: '渗透；弥漫', vocabulary: [] })
  await f.handle({ ...request, text: 'permeate' })
  const word = (await f.handle({ action: 'vocabulary_list' })).items[0]
  assert.equal(word.term, 'permeate'); assert.equal(word.meaning, '渗透；弥漫')
  assert.equal(word.encounters[0].sentence_translation, '渗透；弥漫'); assert.equal(f.calls.length, 1)
})

test('native annotation translation accumulates vocabulary once and preserves manual edits across PDF retry and replay', async () => {
  const f = fixture(); let failPdf = true, saved = false
  const options = { store: f.store, languageLearning: f.handle, dispatch: async input => {
    if (input.action === 'annotation_context_exact') return { annotations: [{ id: 'note-1', page: 2, text: source, comment: '' }] }
    if (input.text) { if (failPdf) throw Error('synthetic PDF write failed'); saved = true }
    return { saved, duplicate: saved && !input.text }
  } }
  const input = { action: 'annotation_translate', id: 'paper-a', annotation_id: 'note-1', version: 'a'.repeat(64) }
  await assert.rejects(createAnnotationTranslation(options)(input), /synthetic PDF write failed/)
  let word = (await f.handle({ action: 'vocabulary_list' })).items[0]
  await f.handle({ action: 'vocabulary_update', id: word.id, expected_revision: word.revision, meaning: '用户保留的词义', status: 'mastered' })
  failPdf = false
  assert.equal((await createAnnotationTranslation(options)(input)).saved, true)
  assert.equal((await createAnnotationTranslation(options)(input)).duplicate, true)
  word = (await f.handle({ action: 'vocabulary_list' })).items[0]
  assert.equal(f.calls.length, 1); assert.equal(word.encounters.length, 1)
  assert.equal(word.meaning, '用户保留的词义'); assert.equal(word.status, 'mastered')
  assert.equal(word.encounters[0].source_sentence, source); assert.equal(word.encounters[0].sentence_translation, response.result)
})

test('polish directions reach faithful prompts and persist in results and history', async () => {
  const f = fixture()
  const directions = { general: /minimal necessary edits/, grammar: /grammar, spelling, punctuation/, concise: /Remove redundancy/, academic: /neutral academic wording/, cohesion: /Do not invent causal or logical links/, plain: /Retain essential technical terms and all qualifications/ }
  for (const [direction, expected] of Object.entries(directions)) {
    const result = await f.handle({ ...request, mode: 'polish', polish_direction: direction, request_id: `direction-${direction}` })
    const prompt = f.calls.at(-1).prompt
    assert.match(prompt, expected); assert.match(prompt, /ORIGINAL LANGUAGE/); assert.match(prompt, /uncertainty and claim strength/); assert.match(prompt, /Do not invent facts or relationships/)
    assert.equal(result.polish_direction, direction); assert.match(result.prompt_version, new RegExp(`^language-polish-v4:${direction}:`))
    const stored = [...f.store.records.values()].find(row => row.value.request_id === `direction-${direction}`)
    assert.equal(stored.value.polish_direction, direction)
  }
  const history = await f.handle({ action: 'language_history', id: request.id })
  assert.deepEqual(new Set(history.items.map(row => row.polish_direction)), new Set(Object.keys(directions)))
})

test('polish default preserves legacy fingerprints while changing direction conflicts', async () => {
  const f = fixture(), input = { ...request, mode: 'polish', request_id: 'legacy-polish' }
  const first = await f.handle(input)
  const stored = [...f.store.records.values()].find(row => row.value.request_id === input.request_id)
  const legacy = { id: input.id, mode: 'polish', text: source, page: 2, target_language: 'source', request_id: input.request_id }
  assert.deepEqual(stored.value.request, legacy)
  assert.equal(stored.value.fingerprint, createHash('sha256').update(JSON.stringify(legacy)).digest('hex'))
  // 模拟磁盘上的旧版完成记录，显式 general 仍能复用而不再次调用模型。
  delete stored.value.polish_direction
  const replayed = await createLanguageLearning(f.options)({ ...input, polish_direction: 'general' })
  assert.equal(replayed.id, first.id); assert.equal(replayed.polish_direction, 'general'); assert.equal(replayed.replayed, true)
  await assert.rejects(f.handle({ ...input, polish_direction: 'grammar' }), error => error.code === 'LANGUAGE_REQUEST_CONFLICT')
  assert.equal(f.calls.length, 1)
})

test('invalid polish directions and translation misuse reject before calling a model', async () => {
  const f = fixture()
  for (const value of ['unknown', 'toString', null, 1, {}, ['grammar']]) {
    await assert.rejects(f.handle({ ...request, mode: 'polish', polish_direction: value }), error => error.code === 'LANGUAGE_INVALID')
  }
  await assert.rejects(f.handle({ ...request, polish_direction: 'general' }), error => error.code === 'LANGUAGE_INVALID')
  assert.equal(f.calls.length, 0); assert.equal(f.store.records.size, 0)
})
