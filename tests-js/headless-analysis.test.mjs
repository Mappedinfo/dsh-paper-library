import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { createHeadlessAnalysis, loadModelConfig } from '../src/headless-analysis.mjs'

const request = { action: 'paper_analysis_run', ids: ['paper-a', 'paper-b'], request_id: 'batch-a', mode: 'metadata' }
const gate = () => { let resolve; const promise = new Promise(done => (resolve = done)); return { promise, resolve } }
async function until(predicate) {
  for (let n = 0; n < 200; n++) { if (await predicate()) return; await new Promise(resolve => setImmediate(resolve)) }
  assert.fail('Synthetic operation did not reach its checkpoint')
}
function assertPlainTree(value, seen = new WeakSet()) {
  if (value && typeof value === 'object') {
    assert.equal(seen.has(value), false); seen.add(value)
    for (const item of Object.values(value)) assertPlainTree(item, seen)
  }
}
async function fixture(config = {}) {
  const f = { records: new Map(), drafts: new Map(), requests: [], calls: [], generationGate: null, failures: new Set(), live: 0, peak: 0 }
  let revision = 0
  f.store = {
    async get(key) { return structuredClone(f.records.get(key) ?? { key, value: null, revision: 0 }) },
    async put(key, value, expected) {
      assertPlainTree(value)
      if (expected !== (f.records.get(key)?.revision ?? 0)) throw Object.assign(new Error('CAS conflict'), { code: 'STATE_CONFLICT' })
      const saved = { key, value: structuredClone(value), revision: ++revision }
      f.records.set(key, saved); return structuredClone(saved)
    },
  }
  f.dispatch = async (input, options) => {
    f.requests.push(structuredClone(input))
    assert.equal(options.library, '/synthetic/library')
    assert.equal(options.python, '/synthetic/python')
    if (input.action === 'get') return { id: input.id, pdf: true, modified: 'revision-a' }
    if (input.action === 'paper_analysis_batch') return {
      paper: { id: input.id, title: 'Synthetic paper' }, expected_modified: 'revision-a', file_version: { size: 100, mtime_ns: '100' },
      sources: [{ id: `source-${input.id}`, entity: { kind: 'paper', id: input.id }, text: 'Evidence from Synthetic Journal.', content_hash: 'synthetic-hash', locator: { page: 1 } }],
      source_ids: [`source-${input.id}`], coverage: { page_count: 1, read_pages: [1], completed_pages: [1], blank_pages: [], truncated_pages: [], omitted_pages: [], characters: 32 },
    }
    if (input.action === 'knowledge_draft_put') {
      const draft = { ...structuredClone(input), id: `draft-${f.drafts.size}`, status: 'needs-review' }
      f.drafts.set(draft.id, draft); return structuredClone(draft)
    }
    if (input.action === 'knowledge_draft_get') return structuredClone(f.drafts.get(input.id))
    if (input.action === 'knowledge_source_get') return { id: input.id, entity: { kind: 'paper', id: input.id.slice(7) }, text: 'Evidence from Synthetic Journal.', content_hash: 'synthetic-hash', locator: { page: 1 } }
    if (input.action === 'paper_analysis_apply_metadata') return { paper: { modified: 'revision-b' }, applied_fields: Object.keys(input.metadata), skipped_fields: [] }
    throw new Error(`Unexpected synthetic action: ${input.action}`)
  }
  f.agent = async input => {
    f.calls.push(input); f.live++; f.peak = Math.max(f.peak, f.live)
    try {
      await f.generationGate?.promise
      const id = input.analysisContext?.id ?? input.prompt.match(/"id":"(paper-[a-z0-9]+)"/)?.[1] ?? 'paper-a'
      if (f.failures.has(id)) throw new Error('Synthetic generation failure')
      if (input.analysisContext?.question_ids) return JSON.stringify({ answers: input.analysisContext.question_ids.map(question_id => ({ question_id, choice: 'not_reported' })) })
      if (input.prompt.includes('READING_RECORDS_JSON')) return JSON.stringify({ title: '合成精读笔记', body: '仅依据合成来源的笔记。' })
      return JSON.stringify({ title: 'Synthetic graph', body: 'Synthetic material only.', nodes: [], edges: [], assertions: [],
        metadata: { 'container-title': 'Synthetic Journal' }, field_sources: { 'container-title': [{ source_id: `source-${id}`, quote: 'Synthetic Journal' }] } })
    } finally { f.live-- }
  }
  f.agent.model = { provider: 'glm', model: 'synthetic-model' }
  f.agent.usage = () => ({ calls: f.calls.length, input_tokens: null, output_tokens: null })
  f.options = { library: '/synthetic/library', python: '/synthetic/python', store: f.store, dispatch: f.dispatch, agent: f.agent,
    modelConfig: { provider: 'glm', model: 'synthetic-model', keyEnv: 'SYNTHETIC_TEST_KEY', ...config } }
  f.handle = await createHeadlessAnalysis(f.options)
  return f
}

test('metadata batch uses first page and never applies metadata, reviews or reads notes by default', async () => {
  const f = await fixture(), result = await f.handle(request)
  assert.equal(result.status, 'complete'); assert.equal(result.results.length, 2)
  assert.equal(f.calls.length, 2)
  assert.equal(result.usage.calls, 2)
  assert.ok(f.requests.filter(r => r.action === 'paper_analysis_batch').every(r => JSON.stringify(r.pages) === '[1]'))
  assert.equal(f.requests.some(r => r.action === 'paper_analysis_apply_metadata' || r.action === 'knowledge_source_get'), false)
  assert.equal(result.results.some(r => r.draft), false, 'Batch output does not duplicate full drafts')
  assert.ok(result.results.every(r => r.analysis_complete === undefined), 'Metadata/legacy completion cannot fabricate questionnaire coverage')
  const jobs = [...f.records.values()].filter(r => r.value.id)
  assert.ok(jobs.every(r => r.value.execution === 'direct' && r.value.review === false && r.value.notes === false))
})

test('full mode defaults to the grouped question protocol and one reading note without automatic review or metadata writes', async () => {
  const f = await fixture(), result = await f.handle({ ...request, ids: ['paper-a'], mode: 'full' })
  assert.equal(result.status, 'complete'); assert.equal(f.calls.length, 4)
  assert.equal(Object.hasOwn(f.requests.find(r => r.action === 'paper_analysis_batch'), 'pages'), false)
  assert.ok(result.results[0].note_draft_id)
  assert.equal(result.results[0].review_draft_id, undefined)
  assert.equal(result.results[0].questionnaire.version, 'reading-questions-v2')
  assert.equal(result.results[0].question_coverage.complete, true)
  assert.deepEqual(result.results[0].question_summary, { answers: 6, valid_answers: 6, invalid_answers: 0, other_answers: 0, projection_limitations: 0 })
  assert.equal(f.calls.filter(call => call.analysisContext?.question_ids).length, 3)
  assert.equal(f.requests.some(r => r.action === 'paper_analysis_apply_metadata'), false)
})

test('completed batches replay after process recreation without another model call', async () => {
  const f = await fixture(), first = await f.handle(request), calls = f.calls.length
  const restarted = await createHeadlessAnalysis(f.options), second = await restarted(request)
  assert.equal(second.status, 'complete'); assert.equal(second.reused, true)
  assert.deepEqual(second.results.map(r => r.request_id), first.results.map(r => r.request_id))
  assert.equal(f.calls.length, calls)
})

test('identical concurrent batch requests share one job; changed selections or options conflict', async () => {
  const f = await fixture(); f.generationGate = gate()
  const first = f.handle(request), second = f.handle(request)
  await until(() => f.calls.length === 1)
  await assert.rejects(f.handle({ ...request, ids: ['paper-a'] }), { code: 'ANALYSIS_CONFLICT' })
  f.generationGate.resolve()
  assert.deepEqual(await first, await second); assert.equal(f.calls.length, 2)
  for (const change of [{ ids: ['paper-b', 'paper-a'] }, { pages: [2] }, { apply_metadata: true }, { mode: 'full' }]) {
    await assert.rejects(f.handle({ ...request, ...change }), { code: 'ANALYSIS_CONFLICT' })
  }
})

test('question controls participate in full-mode request identity', async () => {
  const f = await fixture(), full = { ...request, ids: ['paper-a'], mode: 'full', question_ids: ['q1', 'q3'] }
  await f.handle(full)
  assert.deepEqual(f.calls.filter(call => call.analysisContext?.question_ids).map(call => call.analysisContext.question_ids), [['q1'], ['q3']])
  await assert.rejects(f.handle({ ...full, question_ids: ['q1'] }), { code: 'ANALYSIS_CONFLICT' })
  await assert.rejects(f.handle({ ...full, question_mode: 'separate' }), { code: 'ANALYSIS_CONFLICT' })
  const saved = [...f.records.values()].find(row => row.key.startsWith('analysis.headless-batch:'))
  assert.deepEqual(saved.value.options.question_ids, ['q1', 'q3'])
})

test('a batch made only of partial question analyses remains partial', async () => {
  const f = await fixture(); f.failures.add('paper-a')
  const result = await f.handle({ action: 'paper_analysis_run', ids: ['paper-a'], request_id: 'partial-questions', mode: 'full',
    notes: false, review: false, question_ids: ['q1'] })
  assert.equal(result.results[0].status, 'partial')
  assert.equal(result.status, 'partial')
  assert.equal(result.counts.partial, 1)
})

test('fatal model quota preserves finished papers, blocks unstarted papers, and replays without calls', async () => {
  const f = await fixture({ maxConcurrency: 1 })
  f.handle.dispose()
  f.calls.length = 0
  f.agent = Object.assign(async input => {
    f.calls.push(input)
    if (input.analysisContext?.id === 'paper-b') throw Object.assign(new Error('private provider quota response'), { code: 'DIRECT_MODEL_QUOTA_EXHAUSTED' })
    return JSON.stringify({ answers: input.analysisContext.question_ids.map(question_id => ({ question_id, choice: 'not_reported' })) })
  }, { model: { provider: 'glm', model: 'synthetic-model' }, usage: () => ({ calls: f.calls.length }) })
  f.options.agent = f.agent
  f.handle = await createHeadlessAnalysis(f.options)
  const input = { action: 'paper_analysis_run', ids: ['paper-a', 'paper-b', 'paper-c'], request_id: 'quota-fuse', mode: 'full', notes: false, review: false }
  const first = await f.handle(input)
  assert.equal(first.status, 'partial')
  assert.deepEqual(first.results.map(row => row.status), ['complete', 'failed', 'skipped'])
  assert.ok(first.results[2].error_code === 'DIRECT_MODEL_QUOTA_EXHAUSTED' && first.results[2].skipped_reason === 'DIRECT_MODEL_QUOTA_EXHAUSTED')
  assert.equal(f.calls.length, 4)
  const saved = [...f.records.values()].find(row => row.key.startsWith('analysis.headless-batch:'))
  assert.equal(saved.value.status, 'partial')
  assert.equal(saved.value.counts.complete, 1)
  assert.equal(saved.value.counts.skipped, 1)
  const replay = await f.handle(input)
  assert.equal(replay.reused, true)
  assert.deepEqual(replay.results.map(row => row.status), ['complete', 'failed', 'skipped'])
  assert.equal(f.calls.length, 4)
})

test('K3 thinking with a too-small explicit output budget keeps its actionable config error', async t => {
  const root = await mkdtemp(join(tmpdir(), 'analysis-budget-config-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'kimi.json')
  await writeFile(path, JSON.stringify({ provider: 'kimi', model: 'k3-256k', keyEnv: 'SYNTHETIC_KEY', thinking: 'default', reasoningEffort: 'high', maxOutputTokens: 8192 }))
  await assert.rejects(loadModelConfig(path), { code: 'DIRECT_MODEL_OUTPUT_BUDGET_TOO_SMALL' })
})

test('changed configured provider/model or budgets conflict across processes', async () => {
  const f = await fixture(); await f.handle(request)
  const changedAgent = Object.assign(async input => f.agent(input), { model: { provider: 'kimi', model: 'other-model' } })
  const changedModel = await createHeadlessAnalysis({ ...f.options, agent: changedAgent })
  await assert.rejects(changedModel(request), { code: 'ANALYSIS_CONFLICT' })
  const changedBudget = await createHeadlessAnalysis({ ...f.options, modelConfig: { ...f.options.modelConfig, maxCalls: 20 } })
  await assert.rejects(changedBudget(request), { code: 'ANALYSIS_CONFLICT' })
})

test('batch identity includes effective thinking and reasoning effort across processes', async () => {
  const f = await fixture(); await f.handle(request)
  const legacyLimits = [...f.records.values()].find(row => row.key.startsWith('analysis.headless-batch:')).value.limits
  assert.deepEqual(legacyLimits, { maxConcurrency: 1, maxCalls: 100, maxOutputTokens: 8192, timeoutMs: 120000 })
  const explicitDefault = await createHeadlessAnalysis({ ...f.options, modelConfig: { ...f.options.modelConfig, thinking: 'disabled' } })
  assert.equal((await explicitDefault(request)).reused, true)
  for (const change of [{ thinking: 'default' }, { thinking: 'enabled' }, { thinking: 'default', reasoningEffort: 'low' }]) {
    const changed = await createHeadlessAnalysis({ ...f.options, modelConfig: { ...f.options.modelConfig, ...change } })
    await assert.rejects(changed(request), { code: 'ANALYSIS_CONFLICT' })
  }
  const g = await fixture({ thinking: 'default', reasoningEffort: 'low' }); await g.handle(request)
  const manifest = [...g.records.values()].find(row => row.key.startsWith('analysis.headless-batch:')).value
  assert.equal(manifest.limits.thinking, 'default'); assert.equal(manifest.limits.reasoningEffort, 'low')
  for (const reasoningEffort of ['high', 'max', undefined]) {
    const changed = await createHeadlessAnalysis({ ...g.options, modelConfig: { ...g.options.modelConfig, reasoningEffort } })
    await assert.rejects(changed(request), { code: 'ANALYSIS_CONFLICT' })
  }
  assert.equal(f.calls.length, 2); assert.equal(g.calls.length, 2)
})

test('bounded concurrency admits starts serially without ANALYSIS_BUSY failures', async () => {
  const f = await fixture({ maxConcurrency: 2 }); f.generationGate = gate()
  const run = f.handle({ ...request, ids: ['paper-a', 'paper-b', 'paper-c', 'paper-d'] })
  await until(() => f.calls.length === 2)
  assert.equal(f.peak, 2)
  f.generationGate.resolve()
  const result = await run
  assert.equal(result.status, 'complete'); assert.equal(result.results.length, 4)
  assert.equal(f.peak, 2)
})

test('separate batches share the same concurrency bound and safe admission queue', async () => {
  const f = await fixture(); f.generationGate = gate()
  const first = f.handle({ ...request, ids: ['paper-a'] }), second = f.handle({ ...request, ids: ['paper-b'], request_id: 'batch-b' })
  await until(() => f.calls.length === 1); assert.equal(f.peak, 1)
  f.generationGate.resolve()
  assert.equal((await first).status, 'complete'); assert.equal((await second).status, 'complete')
  assert.equal(f.peak, 1)
})

test('another process reports uncertain jobs and does not take over unstarted batch members', async () => {
  const f = await fixture(); f.generationGate = gate()
  const first = f.handle(request)
  await until(() => f.calls.length === 1)
  const restarted = await createHeadlessAnalysis(f.options), observed = await restarted(request)
  assert.equal(observed.manifest_status, 'unconfirmed')
  assert.equal(observed.results[0].status, 'unconfirmed')
  assert.equal(observed.results[1].status, 'not_started')
  assert.equal(f.calls.length, 1)
  f.generationGate.resolve(); assert.equal((await first).status, 'complete')
})

test('failed papers remain failed on replay and batch has explicit partial outcome', async () => {
  const f = await fixture(); f.failures.add('paper-b')
  const result = await f.handle(request)
  assert.equal(result.status, 'partial')
  assert.deepEqual(result.results.map(r => r.status), ['complete', 'failed'])
  f.failures.clear()
  assert.equal((await (await createHeadlessAnalysis(f.options))(request)).status, 'partial')
  assert.equal(f.calls.length, 2)
})

test('admission failures preserve a durable per-paper failure without replay', async () => {
  const f = await fixture(), original = f.options.dispatch
  f.options.dispatch = async (input, options) => {
    if (input.action === 'get' && input.id === 'paper-b') throw Object.assign(new Error('Synthetic missing paper'), { code: 'PAPER_NOT_FOUND' })
    return original(input, options)
  }
  const handle = await createHeadlessAnalysis(f.options), first = await handle(request)
  assert.equal(first.status, 'partial'); assert.equal(first.results[1].error_code, 'PAPER_NOT_FOUND')
  const second = await (await createHeadlessAnalysis({ ...f.options, dispatch: original }))(request)
  assert.equal(second.results[1].status, 'failed'); assert.equal(second.results[1].error_code, 'PAPER_NOT_FOUND')
  assert.equal(f.calls.length, 1)
})

test('attempt budget bounds model calls and keeps earlier results', async () => {
  const f = await fixture({ maxCalls: 1 })
  const result = await f.handle(request)
  assert.equal(result.status, 'partial'); assert.equal(f.calls.length, 1)
  assert.equal(result.results[0].status, 'complete'); assert.equal(result.results[1].status, 'failed')
  assert.match(result.results[1].error, /次数|预算/)
})

test('get and explicit apply work without model config or credential reads', async () => {
  const f = await fixture(), batch = await f.handle({ ...request, ids: ['paper-a'] })
  const readOnly = await createHeadlessAnalysis({ ...f.options, agent: undefined, modelConfig: undefined })
  const input = { id: 'paper-a', request_id: batch.results[0].request_id }
  assert.equal((await readOnly({ ...input, action: 'paper_analysis_get' })).status, 'complete')
  const applied = await readOnly({ ...input, action: 'paper_analysis_apply' })
  assert.deepEqual(applied.metadata_result.applied_fields, ['container-title'])
  assert.equal(f.calls.length, 1)
})

test('automatic UI reuse reads existing results or idle without creating jobs or loading credentials', async () => {
  const f = await fixture()
  const automatic = await createHeadlessAnalysis({ ...f.options, agent: undefined })
  const input = { action: 'paper_analysis_start', id: 'paper-a', request_id: 'automatic-a', reuse: true }
  assert.equal((await automatic(input)).status, 'idle')
  assert.equal(f.records.size, 0); assert.equal(f.requests.length, 0); assert.equal(f.calls.length, 0)
  const batch = await f.handle({ ...request, ids: ['paper-a'] })
  const selected = await automatic(input)
  assert.equal(selected.status, 'complete')
  assert.equal(selected.request_id, batch.results[0].request_id)
  assert.equal(f.calls.length, 1)
  const noConfig = await createHeadlessAnalysis({ ...f.options, agent: undefined, modelConfig: undefined })
  assert.equal((await noConfig({ ...input, id: 'paper-b' })).status, 'idle')
})

test('single start returns promptly and explicit wait gets completion; cancel preserves stopped result', async () => {
  const f = await fixture(); f.generationGate = gate()
  const input = { action: 'paper_analysis_start', id: 'paper-a', request_id: 'single-a', mode: 'metadata' }
  assert.equal((await f.handle(input)).status, 'queued')
  await until(() => f.calls.length === 1)
  const cancellation = f.handle({ action: 'paper_analysis_cancel', id: input.id, request_id: input.request_id })
  f.generationGate.resolve()
  assert.equal((await cancellation).status, 'cancelled')
  await f.handle.wait(input.id, input.request_id)
  assert.equal((await f.handle(input)).status, 'cancelled')
  assert.equal(f.calls.length, 1)
})

test('invalid selection, duplicate IDs and unsupported metadata options create no jobs', async () => {
  const f = await fixture()
  const invalid = [{ ids: [] }, { ids: ['paper-a', 'paper-a'] }, { ids: ['../paper'] }, { ids: ['dataset_a'] },
    { id: 'paper-a' }, { request_id: '' }, { pages: [1, 1] }, { notes: true }, { review: true }, { mode: 'unknown' },
    { ids: Array.from({ length: 2001 }, (_, n) => `paper-${n}`) }]
  for (const changes of invalid) await assert.rejects(f.handle({ ...request, ...changes }), { code: 'ANALYSIS_INVALID' })
  assert.equal(f.records.size, 0); assert.equal(f.calls.length, 0)
})

test('manifest remains bounded with 2000 maximum-length IDs', async () => {
  const f = await fixture(); f.generationGate = gate()
  const ids = Array.from({ length: 2000 }, (_, n) => `paper-${String(n).padStart(4, '0')}-${'x'.repeat(149)}`)
  const run = f.handle({ ...request, ids })
  await until(() => [...f.records.keys()].some(key => key.startsWith('analysis.headless-batch:')))
  const manifest = [...f.records.values()].find(r => r.key.startsWith('analysis.headless-batch:'))
  assert.ok(Buffer.byteLength(JSON.stringify(manifest)) < 5000)
  f.handle.dispose(); f.generationGate.resolve()
  assert.equal((await run).status, 'failed')
})

test('loadModelConfig reads only explicit bounded JSON and resolves explicit envFile relative to it', async t => {
  const home = await mkdtemp(join(tmpdir(), 'paper-headless-config-')); t.after(() => rm(home, { recursive: true, force: true }))
  const path = join(home, 'model.json'), valid = { provider: 'glm', model: 'synthetic-model', keyEnv: 'SYNTHETIC_TEST_KEY', envFile: 'keys.env', maxCalls: 3 }
  await writeFile(path, JSON.stringify(valid))
  assert.deepEqual(await loadModelConfig(path), { ...valid, envFile: join(home, 'keys.env') })
  for (const value of [{ ...valid, apiKey: 'synthetic-private-value' }, { ...valid, unknown: true }, { ...valid, maxConcurrency: 5 }, { ...valid, keyEnv: 'invalid-key' }, []]) {
    await writeFile(path, JSON.stringify(value))
    await assert.rejects(loadModelConfig(path), error => error.code === 'DIRECT_MODEL_CONFIG_INVALID' && !error.message.includes('synthetic-private-value'))
  }
  await writeFile(path, ' '.repeat(65537)); await assert.rejects(loadModelConfig(path), { code: 'DIRECT_MODEL_CONFIG_INVALID' })
  const link = join(home, 'link.json'); await symlink(path, link)
  await assert.rejects(loadModelConfig(link), { code: 'DIRECT_MODEL_CONFIG_INVALID' })
  await assert.rejects(createHeadlessAnalysis({ modelConfig: { ...valid, apiKey: 'synthetic-private-value' } }), { code: 'DIRECT_MODEL_CONFIG_INVALID' })
})

test('explicit model config validates reasoning compatibility without loading credentials', async t => {
  const home = await mkdtemp(join(tmpdir(), 'paper-headless-reasoning-')); t.after(() => rm(home, { recursive: true, force: true }))
  const path = join(home, 'model.json'), base = { provider: 'glm', model: 'glm-5.3-flash', keyEnv: 'SYNTHETIC_TEST_KEY', envFile: join(home, 'not-created.env') }
  for (const thinking of ['default', 'enabled']) {
    const config = { ...base, thinking, reasoningEffort: 'low' }
    await writeFile(path, JSON.stringify(config)); assert.deepEqual(await loadModelConfig(path), config)
    await createHeadlessAnalysis({ modelConfig: config })
  }
  for (const change of [{}, { thinking: 'disabled' }, { thinking: 'default', reasoningEffort: 'medium' },
    { thinking: null }, { provider: 'kimi', model: 'k3-256k' }, { provider: 'kimi', model: 'k3', thinking: 'disabled' }]) {
    const config = { ...base, ...change }
    await writeFile(path, JSON.stringify(config)); await assert.rejects(loadModelConfig(path), { code: 'DIRECT_MODEL_CONFIG_INVALID' })
    await assert.rejects(createHeadlessAnalysis({ modelConfig: config }), { code: 'DIRECT_MODEL_CONFIG_INVALID' })
  }
})

test('headless DeepSeek configuration validates without reading the explicitly named credential file', async t => {
  const home = await mkdtemp(join(tmpdir(), 'paper-headless-deepseek-')); t.after(() => rm(home, { recursive: true, force: true }))
  const path = join(home, 'model.json'), base = { provider: 'deepseek', model: 'deepseek-flash', keyEnv: 'SYNTHETIC_CUSTOM_KEY',
    envFile: join(home, 'not-created.env'), maxOutputTokens: 32768 }
  for (const thinking of ['disabled', 'enabled', 'default']) {
    const config = { ...base, thinking, ...(thinking === 'disabled' ? {} : { reasoningEffort: 'low' }) }
    await writeFile(path, JSON.stringify(config))
    assert.deepEqual(await loadModelConfig(path), config)
    const handle = await createHeadlessAnalysis({ modelConfig: config })
    handle.dispose()
  }
  for (const change of [{ thinking: 'enabled', reasoningEffort: 'medium' }, { thinking: 'disabled', reasoningEffort: 'low' },
    { thinking: 'automatic' }, { maxOutputTokens: 32769 }]) {
    const config = { ...base, ...change }
    await writeFile(path, JSON.stringify(config))
    await assert.rejects(loadModelConfig(path), { code: 'DIRECT_MODEL_CONFIG_INVALID' })
    await assert.rejects(createHeadlessAnalysis({ modelConfig: config }), { code: 'DIRECT_MODEL_CONFIG_INVALID' })
  }
})

async function cli(args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    const timer = setTimeout(() => { child.kill(); reject(new Error('Synthetic CLI timeout')) }, 15000)
    child.stdout.on('data', chunk => { stdout += chunk }); child.stderr.on('data', chunk => { stderr += chunk })
    child.on('error', reject)
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }) })
    child.stdin.end(JSON.stringify(input))
  })
}
test('CLI get needs no model config; missing generation config exits nonzero without losing JSON', async t => {
  const home = await mkdtemp(join(tmpdir(), 'paper-headless-cli-')); t.after(() => rm(home, { recursive: true, force: true }))
  const library = join(home, 'library'); await mkdir(library)
  const args = ['src/cli.mjs', '--library', library, '--state-home', join(home, 'state')]
  const get = await cli(args, { action: 'paper_analysis_get', id: 'paper-a' })
  assert.equal(get.code, 0); assert.equal(JSON.parse(get.stdout).result.status, 'idle')
  const reuse = await cli(args, { action: 'paper_analysis_start', id: 'paper-a', request_id: 'automatic-a', reuse: true })
  assert.equal(reuse.code, 0); assert.equal(JSON.parse(reuse.stdout).result.status, 'idle')
  const start = await cli(args, { action: 'paper_analysis_start', id: 'paper-a', request_id: 'request-a', mode: 'metadata' })
  assert.equal(start.code, 1); assert.equal(JSON.parse(start.stdout).code, 'ANALYSIS_MODEL_REQUIRED')
  assert.equal(start.stdout.includes(library), false)
})

test('CLI waits for start and preserves failed batch JSON using only synthetic modules', async t => {
  const home = await mkdtemp(join(tmpdir(), 'paper-headless-cli-fixture-')); t.after(() => rm(home, { recursive: true, force: true }))
  const library = join(home, 'library'); await mkdir(library)
  const config = join(home, 'model.json'); await writeFile(config, JSON.stringify({ provider: 'glm', model: 'synthetic-model', keyEnv: 'SYNTHETIC_UNUSED_KEY' }))
  const bridge = `const drafts=new Map(); export const defaultLibrary=${JSON.stringify(library)};
    export async function dispatch(input){
      if(input.action==='get')return{id:input.id,pdf:true,modified:'r1'};
      if(input.action==='paper_analysis_batch')return{paper:{id:input.id},expected_modified:'r1',file_version:{size:1,mtime_ns:'1'},sources:[{id:'source-a',entity:{kind:'paper',id:input.id},text:'Synthetic text',locator:{page:1},content_hash:'hash'}],source_ids:['source-a'],coverage:{page_count:1,read_pages:[1],completed_pages:[1]}};
      if(input.action==='knowledge_draft_put'){const d={...input,id:'draft-a',status:'needs-review'};drafts.set(d.id,d);return d};
      if(input.action==='knowledge_draft_get')return drafts.get(input.id);
      throw new Error('Unexpected synthetic action'); }`
  const direct = `export {directModelReasoningOptions,directModelOutputBudget} from ${JSON.stringify(new URL('../src/direct-model.mjs?actual', import.meta.url).href)}; export async function createDirectModelAgent(config){const fn=async()=>{await new Promise(r=>setTimeout(r,25));if(config.model==='synthetic-failure')throw new Error('Synthetic failure');return JSON.stringify({title:'Synthetic',body:'Synthetic',nodes:[],edges:[],assertions:[],metadata:{},field_sources:{}})};fn.model={provider:config.provider,model:config.model};return fn}`
  const loader = join(home, 'loader.mjs')
  await writeFile(loader, `export async function load(url,context,next){if(url.endsWith('/src/bridge.mjs'))return{format:'module',shortCircuit:true,source:${JSON.stringify(bridge)}};if(url.endsWith('/src/direct-model.mjs'))return{format:'module',shortCircuit:true,source:${JSON.stringify(direct)}};return next(url,context)}`)
  const args = ['--no-warnings', '--loader', loader, 'src/cli.mjs', '--library', library, '--state-home', join(home, 'state'), '--model-config', config]
  const started = await cli(args, { action: 'paper_analysis_start', id: 'paper-a', request_id: 'start-a', mode: 'metadata' })
  assert.equal(started.code, 0, started.stdout + started.stderr)
  assert.equal(JSON.parse(started.stdout).result.status, 'complete')
  await writeFile(config, JSON.stringify({ provider: 'glm', model: 'synthetic-failure', keyEnv: 'SYNTHETIC_UNUSED_KEY' }))
  const failed = await cli(args, { ...request, request_id: 'failed-batch', ids: ['paper-b'] })
  assert.equal(failed.code, 1)
  const output = JSON.parse(failed.stdout)
  assert.equal(output.ok, false); assert.equal(output.result.status, 'failed')
  assert.equal(output.result.results[0].status, 'failed')
})
