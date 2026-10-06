import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { createDirectModelAgent } from '../src/direct-model.mjs'
import { classifyModelHttpError } from '../src/model-errors.mjs'
import { createPaperAnalysis } from '../src/harness/paper-analysis.mjs'
import { runAnalysisBatch, validatePlan } from '../scripts/run-paper-analysis-batch.mjs'

async function fixture(t, overrides = {}) {
  const home = await mkdtemp(join(tmpdir(), 'synthetic-paper-batch-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const library = join(home, 'library'); await mkdir(library)
  const f = { home, library, out: join(home, 'output'), calls: 0, active: 0, peak: 0, writes: [], finishedProgress: [] }
  const key = 'SYNTHETIC_CREDENTIAL_NOT_FOR_REAL_USE'
  f.key = key
  f.contextFor = (id, request_id) => ({ id, request_id, stage: 'batch', batch_index: 0, source_ids: [`source-${id}`], pages: [2] })
  f.plan = { library, request_id: 'synthetic-plan', mode: 'metadata', notes: false, review: false,
    routes: [{ name: 'glm', config: join(home, 'glm.json'), ids: ['paper-a', 'paper-b', 'paper-c'] },
      { name: 'kimi', config: join(home, 'kimi.json'), ids: ['paper-d', 'paper-e', 'paper-f'] }] }
  const config = provider => ({ provider, model: 'synthetic-model', keyEnv: 'SYNTHETIC_RUNNER_KEY',
    envFile: join(home, 'unused-private.env'), maxCalls: 20, maxConcurrency: 4 })
  const fakeStore = { async get(key) { return { key, value: null, revision: 0 } },
    async put(key, value) { f.writes.push({ key, value }); return { key, value, revision: 'synthetic-revision' } } }
  f.options = { out: f.out, progressIntervalMs: 5,
    loadConfig: async path => config(path.endsWith('glm.json') ? 'glm' : 'kimi'),
    createStore: () => fakeStore,
    createAgent: (selected, options) => { const { envFile, ...synthetic } = selected; return createDirectModelAgent(synthetic, { ...options, env: { SYNTHETIC_RUNNER_KEY: key } }) },
    createAnalysis: async options => {
      assert.equal(options.modelConfig.maxConcurrency, 2)
      const handle = async input => {
        const results = new Array(input.ids.length); let cursor = 0
        const worker = async () => {
          while (cursor < input.ids.length) {
            const index = cursor++, id = input.ids[index]
            let status = 'complete', error_code
            try { await options.agent({ prompt: 'Only synthetic fixture text.', ...options.agent.model, analysisContext: f.contextFor(id, input.request_id) }) }
            catch (error) { status = 'failed'; error_code = error.code }
            await options.store.put(`analysis.job:${id}`, { id, status, batch_count: 1 }, 0)
            f.finishedProgress.push(JSON.parse(await readFile(join(f.out, 'progress.json'), 'utf8')))
            results[index] = { id, status, ...(error_code ? { error_code } : {}), warnings: [] }
          }
        }
        await Promise.all([worker(), worker()])
        return { status: results.every(row => row.status === 'complete') ? 'complete' : 'failed', results, usage: options.agent.usage() }
      }
      handle.dispose = () => {}; return handle
    },
    fetchImpl: async (url, init) => {
      assert.equal(new Headers(init.headers).get('authorization')?.replace('Bearer ', '') ?? new Headers(init.headers).get('x-api-key'), key)
      f.calls++; f.active++; f.peak = Math.max(f.peak, f.active)
      const content = JSON.stringify({ title: 'Synthetic', body: 'Synthetic fixture only.', nodes: [], edges: [], assertions: [], metadata: {}, field_sources: {} })
      const body = Buffer.from(JSON.stringify(url.includes('bigmodel')
        ? { model: 'synthetic-glm-response', choices: [{ finish_reason: 'stop', message: { content } }], diagnostic_echo: key }
        : { model: 'synthetic-kimi-response', stop_reason: 'end_turn', content: [{ type: 'text', text: content }], diagnostic_echo: key }))
      let ended = false
      const close = () => { if (!ended) { ended = true; f.active-- } }
      const stream = new ReadableStream({ start(controller) {
        controller.enqueue(body.subarray(0, 20))
        setTimeout(() => { if (!ended) { controller.enqueue(body.subarray(20)); controller.close(); close() } }, 15)
      }, cancel() { close() } })
      return new Response(stream, { headers: { 'content-type': 'application/json', 'sensitive-response-header': key } })
    }, ...overrides }
  return f
}

test('two route aliases for one credential share two slots until each response body finishes', async t => {
  const f = await fixture(t), result = await runAnalysisBatch(f.plan, f.options)
  assert.equal(result.status, 'complete'); assert.equal(f.calls, 6); assert.equal(f.peak, 2)
  assert.equal(result.calls, 6)
  assert.deepEqual(result.credential_groups, [{ id: 1, limit: 2, active: 0, peak: 2 }])
  const progress = JSON.parse(await readFile(join(f.out, 'progress.json'), 'utf8'))
  assert.equal(progress.status, 'complete'); assert.equal(progress.calls.succeeded, 6)
  assert.equal(progress.papers.filter(row => row.status === 'complete').length, 6)
  assert.equal(f.finishedProgress.length, 6)
  assert.ok(f.finishedProgress.some(row => row.papers.some(paper => paper.status === 'complete') && row.status === 'running'))
})

test('quota fuses queued aliases for one actual key while a different key continues', async t => {
  const f = await fixture(t)
  f.plan.routes = [
    { name: 'glm', config: join(f.home, 'glm.json'), ids: ['paper-a', 'paper-b', 'paper-c'] },
    { name: 'kimi-alias', config: join(f.home, 'kimi.json'), ids: ['paper-d', 'paper-e', 'paper-f'] },
    { name: 'other-key', config: join(f.home, 'other.json'), ids: ['paper-g', 'paper-h', 'paper-i'] },
  ]
  let quotaSent = false, otherAfterQuota = 0, sharedAfterQuota = 0
  let releaseOther
  const otherGate = new Promise(resolve => { releaseOther = resolve })
  const sharedCredential = 'SHARED_SYNTHETIC_KEY', otherCredential = 'OTHER_SYNTHETIC_KEY'
  f.options.loadConfig = async path => {
    const other = path.endsWith('other.json')
    return { provider: other ? 'glm' : path.endsWith('glm.json') ? 'glm' : 'kimi', model: 'synthetic-model',
      keyEnv: other ? 'OTHER_KEY' : 'SHARED_KEY', maxCalls: 20, maxConcurrency: 2, maxOutputTokens: 8192, timeoutMs: 1000 }
  }
  f.options.createAgent = (selected, { fetchImpl }) => {
    const credential = selected.keyEnv === 'OTHER_KEY' ? otherCredential : sharedCredential
    const agent = async request => {
      const response = await fetchImpl('https://synthetic.invalid/model', { headers: { 'x-api-key': credential }, signal: request.signal })
      const body = await response.text()
      if (!response.ok) {
        const code = classifyModelHttpError(selected.provider, response.status, body)
        throw Object.assign(new Error(code), { code })
      }
      return body
    }
    agent.model = { provider: selected.provider, model: selected.model }
    agent.supportsImages = false
    agent.usage = () => ({ calls: 0 })
    return agent
  }
  f.options.fetchImpl = async (_url, init) => {
    const key = new Headers(init.headers).get('x-api-key')
    if (key === otherCredential && !quotaSent) await otherGate
    if (key === sharedCredential && !quotaSent) {
      await new Promise(resolve => setTimeout(resolve, 20))
      quotaSent = true
      releaseOther()
      return new Response(JSON.stringify({ error: { type: 'permission_error', message: "You've reached your 5-hour usage limit." } }), { status: 403 })
    }
    if (key === sharedCredential) sharedAfterQuota++
    if (key === otherCredential && quotaSent) otherAfterQuota++
    return new Response(JSON.stringify({ model: 'synthetic', ok: true }), { status: 200 })
  }
  const result = await runAnalysisBatch(f.plan, f.options)
  assert.equal(quotaSent, true)
  assert.equal(sharedAfterQuota, 0, 'no aliased-key fetch begins after the quota response')
  assert.ok(otherAfterQuota > 0, 'the unrelated credential remains usable after quota')
  assert.deepEqual(result.credential_groups.map(group => group.peak).sort(), [2, 2])
  assert.ok(result.credential_groups.every(group => group.active === 0 && group.peak <= 2))
  const receipts = await Promise.all((await readdir(join(f.out, 'responses'))).map(async name =>
    JSON.parse(await readFile(join(f.out, 'responses', name), 'utf8'))))
  const sharedGroups = new Set(receipts.filter(call => ['glm', 'kimi-alias'].includes(call.route)).map(call => call.credential_group))
  const otherGroups = new Set(receipts.filter(call => call.route === 'other-key').map(call => call.credential_group))
  assert.equal(sharedGroups.size, 1, 'provider aliases using the same key share one fuse')
  assert.equal(otherGroups.size, 1)
  assert.notEqual([...sharedGroups][0], [...otherGroups][0])
  assert.ok(receipts.some(call => call.error_code === 'DIRECT_MODEL_QUOTA_EXHAUSTED'))
})

test('private artifacts redact actual credentials and contain no response headers or credential config', async t => {
  const f = await fixture(t); await runAnalysisBatch(f.plan, f.options)
  assert.equal((await stat(f.out)).mode & 0o777, 0o700)
  assert.equal((await stat(join(f.out, 'responses'))).mode & 0o777, 0o700)
  const artifacts = ['run-manifest.json', 'progress.json', 'result.json', ...(await readdir(join(f.out, 'responses'))).map(name => `responses/${name}`)]
  for (const name of artifacts) {
    assert.equal((await stat(join(f.out, name))).mode & 0o777, 0o600)
    const body = await readFile(join(f.out, name), 'utf8')
    assert.equal(body.includes(f.key), false)
    assert.equal(body.includes('sensitive-response-header'), false)
    assert.equal(body.includes('keyEnv'), false); assert.equal(body.includes('envFile'), false)
  }
  const receipt = JSON.parse(await readFile(join(f.out, 'responses', '000001-glm.json'), 'utf8'))
  assert.ok(receipt.response_body.includes('[REDACTED]'))
  assert.equal(receipt.status, 'succeeded')
})

test('audit redaction handles Unicode-escaped credentials including JSON inside model messages', async t => {
  const f = await fixture(t)
  f.plan.routes = f.plan.routes.slice(0, 1); f.plan.routes[0].ids = ['paper-a']
  const encoded = [...f.key].map(char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`).join('')
  f.options.fetchImpl = async () => new Response(`{"choices":[{"finish_reason":"stop","message":{"content":${JSON.stringify(`{"title":"Synthetic","body":"${encoded}"}`)}}}],"echo":"${encoded}"}`)
  const result = await runAnalysisBatch(f.plan, f.options)
  assert.equal(result.status, 'failed', 'Existing adapter refuses model output containing its actual key')
  const receipt = JSON.parse(await readFile(join(f.out, 'responses', '000001-glm.json'), 'utf8'))
  assert.equal(receipt.response_body.includes(f.key), false)
  assert.equal(receipt.response_body.includes(encoded), false)
  const body = JSON.parse(receipt.response_body)
  assert.equal(body.echo, '[REDACTED]')
  assert.equal(JSON.parse(body.choices[0].message.content).body, '[REDACTED]')
})

test('bounded oversized responses and unsafe transport messages preserve redacted failure receipts', async t => {
  const f = await fixture(t)
  f.plan.routes = f.plan.routes.slice(0, 1)
  f.options.fetchImpl = async () => new Response('x'.repeat(512 * 1024 + 1))
  const result = await runAnalysisBatch(f.plan, f.options)
  assert.equal(result.status, 'failed')
  const receipt = JSON.parse(await readFile(join(f.out, 'responses', '000001-glm.json'), 'utf8'))
  assert.equal(receipt.transport_error, 'BATCH_RESPONSE_TOO_LARGE')
  assert.equal(receipt.response_body_truncated, true)
  assert.ok(Buffer.byteLength(receipt.response_body) <= 512 * 1024)
  assert.equal(receipt.response_body, '[unparseable response omitted]')
  const second = { ...f.options, out: join(f.home, 'transport-error'), fetchImpl: async () => { throw new Error(`Unsafe synthetic error ${f.key}`) } }
  assert.equal((await runAnalysisBatch(f.plan, second)).status, 'failed')
  const errorReceipt = await readFile(join(second.out, 'responses', '000001-glm.json'), 'utf8')
  assert.equal(errorReceipt.includes(f.key), false); assert.equal(errorReceipt.includes('Unsafe synthetic'), false)
})

test('explicit maxCalls is mandatory before any route sends a request', async t => {
  const f = await fixture(t)
  const load = f.options.loadConfig
  f.options.loadConfig = async path => { const value = await load(path); delete value.maxCalls; return value }
  const result = await runAnalysisBatch(f.plan, f.options)
  assert.equal(result.status, 'failed'); assert.equal(result.error_code, 'BATCH_EXPLICIT_BUDGET_REQUIRED')
  assert.equal(f.calls, 0)
  assert.equal(JSON.parse(await readFile(join(f.out, 'result.json'), 'utf8')).error_code, 'BATCH_EXPLICIT_BUDGET_REQUIRED')
})

test('output cannot overwrite previous run or live inside library or a Git worktree', async t => {
  const f = await fixture(t)
  await mkdir(f.out)
  await assert.rejects(runAnalysisBatch(f.plan, f.options), { code: 'BATCH_OUTPUT_EXISTS' })
  await assert.rejects(runAnalysisBatch(f.plan, { ...f.options, out: join(f.library, 'report') }), { code: 'BATCH_OUTPUT_UNSAFE' })
  const repo = join(f.home, 'public-project'); await mkdir(repo); await writeFile(join(repo, '.git'), 'synthetic worktree marker')
  await assert.rejects(runAnalysisBatch(f.plan, { ...f.options, out: join(repo, 'report') }), { code: 'BATCH_OUTPUT_IN_GIT' })
  assert.equal(f.calls, 0)
})

test('plan rejects duplicate papers across routes, implicit paths and unsupported automatic review', async t => {
  const f = await fixture(t)
  const duplicate = structuredClone(f.plan); duplicate.routes[1].ids.push('paper-a')
  assert.throws(() => validatePlan(duplicate), { code: 'BATCH_DUPLICATE_OR_INVALID_PAPER' })
  for (const change of [{ library: 'relative/library' }, { review: true }, { notes: true }, { routes: [] }, { apiKey: 'synthetic-raw-value' }]) {
    assert.throws(() => validatePlan({ ...f.plan, ...change }), { code: 'BATCH_PLAN_INVALID' })
  }
})

test('audits retain final answers and settings without provider reasoning content', async t => {
  const hidden = 'SYNTHETIC_PRIVATE_REASONING', signature = 'SYNTHETIC_REASONING_SIGNATURE'
  const f = await fixture(t, { fetchImpl: async url => new Response(JSON.stringify(url.includes('bigmodel')
    ? { choices: [{ finish_reason: 'stop', message: { content: '{"answer":true}', reasoning_content: hidden } }] }
    : { stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: hidden, signature },
      { type: 'redacted_thinking', data: hidden }, { type: 'text', text: '{"answer":true}' }] })) })
  await runAnalysisBatch(f.plan, f.options)
  for (const name of await readdir(join(f.out, 'responses'))) {
    const text = await readFile(join(f.out, 'responses', name), 'utf8')
    assert.equal(text.includes(hidden), false)
    assert.equal(text.includes(signature), false)
    const receipt = JSON.parse(text)
    assert.match(receipt.response_body, /answer/)
    assert.equal(receipt.response_body_encoding, 'json-normalized-redacted-no-reasoning')
  }
  const manifest = JSON.parse(await readFile(join(f.out, 'run-manifest.json'), 'utf8'))
  assert.ok(manifest.routes.every(route => route.thinking === 'disabled'))
  assert.ok(manifest.routes.every(route => route.maxOutputTokens === 8192 && route.timeoutMs === 120000))
})

test('effective Kimi thinking budget is identical in outgoing requests, manifest and receipts', async t => {
  const sent = []
  const f = await fixture(t, { fetchImpl: async (url, init) => {
    sent.push(JSON.parse(init.body))
    return new Response(JSON.stringify(url.includes('bigmodel')
      ? { choices: [{ finish_reason: 'stop', message: { content: '{"answer":true}' } }] }
      : { stop_reason: 'end_turn', content: [{ type: 'text', text: '{"answer":true}' }] }))
  } })
  const load = f.options.loadConfig
  f.options.loadConfig = async path => {
    const config = await load(path)
    return config.provider === 'kimi' ? { ...config, model: 'k3-256k', thinking: 'default', reasoningEffort: 'high' } : config
  }
  await runAnalysisBatch(f.plan, f.options)
  const manifest = JSON.parse(await readFile(join(f.out, 'run-manifest.json'), 'utf8'))
  assert.equal(manifest.routes.find(route => route.name === 'kimi').maxOutputTokens, 32768)
  assert.ok(sent.filter(body => body.model === 'k3-256k').every(body => body.max_tokens === 32768))
  for (const name of await readdir(join(f.out, 'responses'))) {
    const receipt = JSON.parse(await readFile(join(f.out, 'responses', name), 'utf8'))
    assert.equal(receipt.max_output_tokens, receipt.provider === 'kimi' ? 32768 : 8192)
  }
})

test('analysis attaches trusted batch, note and review selections without changing call count', async t => {
  const records = new Map(), drafts = new Map(), calls = []
  const sources = [3, 7].map(page => ({ id: `source-${page}`, entity: { kind: 'paper', id: 'paper-a' },
    text: `Synthetic evidence on page ${page}.`, locator: { page }, content_hash: `hash-${page}` }))
  const paper = { id: 'paper-a', pdf: true, title: 'Synthetic paper', modified: 'r1' }
  let revision = 0, index = 0
  const handle = createPaperAnalysis({ library: '/synthetic/library',
    store: { async get(key) { return structuredClone(records.get(key) ?? { key, value: null, revision: 0 }) },
      async put(key, value, expected) {
        assert.equal(expected, records.get(key)?.revision ?? 0)
        const saved = { key, value: structuredClone(value), revision: ++revision }; records.set(key, saved); return structuredClone(saved)
      } },
    resolveModel: async () => ({ provider: 'glm', model: 'synthetic-model' }),
    dispatch: async input => {
      if (input.action === 'get') return paper
      if (input.action === 'paper_analysis_batch') {
        const source = sources[index++]
        return { paper, expected_modified: 'r1', file_version: { bytes: 1 }, sources: [source], source_ids: [source.id],
          next_cursor: index === 1 ? { index: 1, offset: 0 } : null,
          coverage: { page_count: 7, read_pages: [source.locator.page], completed_pages: [source.locator.page], blank_pages: [], truncated_pages: [], omitted_pages: [] } }
      }
      if (input.action === 'knowledge_draft_put') { const draft = { ...structuredClone(input), id: `draft-${drafts.size}` }; drafts.set(draft.id, draft); return draft }
      if (input.action === 'knowledge_draft_get') return drafts.get(input.id)
      if (input.action === 'knowledge_source_get') return sources.find(source => source.id === input.id)
      throw new Error('Unexpected synthetic action')
    },
    agent: async input => {
      calls.push(input)
      if (input.prompt.includes('evidence-atlas')) return JSON.stringify({ title: '证据图谱评审：合成论文',
        body: '快速判定\n案例拆解\n状态矩阵\n归因\n联合覆盖\n形容词\n本文最多能声称\n本文不能声称\n修改清单' })
      if (input.prompt.includes('READING_RECORDS_JSON')) return JSON.stringify({ title: '合成精读笔记', body: '合成资料。' })
      const source = sources[calls.length - 1]
      if (input.prompt.includes('本轮只回答下面列出的阅读问题')) return JSON.stringify({ answers: [
        { question_id: 'q1', choice: 'other', judgment: 'Synthetic assertion', evidence: [{ source_id: 'S1', quote: source.text }] },
      ] })
      return JSON.stringify({ title: 'Synthetic graph', body: 'Synthetic summary.', nodes: [{ id: 'evidence', type: 'evidence', label: 'Synthetic evidence', source_id: source.id, quote: source.text }], edges: [], assertions: [], metadata: {}, field_sources: {} })
    } })
  t.after(() => handle.dispose())
  await handle({ action: 'paper_analysis_start', id: 'paper-a', request_id: 'synthetic-context', pages: [3, 7], question_ids: ['q1'], apply_metadata: false,
    analysisContext: { id: 'forged-paper', source_ids: ['forged-source'] } })
  await handle.wait('paper-a', 'synthetic-context')
  assert.equal((await handle({ action: 'paper_analysis_get', id: 'paper-a' })).status, 'complete')
  assert.equal(calls.length, 4)
  assert.deepEqual(calls.map(call => call.analysisContext), [
    { id: 'paper-a', request_id: 'synthetic-context', stage: 'batch', batch_index: 0, question_ids: ['q1'], source_ids: ['source-3'], pages: [3] },
    { id: 'paper-a', request_id: 'synthetic-context', stage: 'batch', batch_index: 1, question_ids: ['q1'], source_ids: ['source-7'], pages: [7] },
    { id: 'paper-a', request_id: 'synthetic-context', stage: 'note', source_ids: ['source-3', 'source-7'], pages: [3, 7] },
    { id: 'paper-a', request_id: 'synthetic-context', stage: 'review', source_ids: ['source-3', 'source-7'], pages: [3, 7] },
  ])
  assert.ok(calls.every(call => !call.prompt.includes('forged-paper')))
})

test('receipts bind bounded context and returned model to exact prompt hashes without storing prompts', async t => {
  const f = await fixture(t), contextFor = f.contextFor
  f.contextFor = (...args) => ({ ...contextFor(...args), private_extra: 'SYNTHETIC_CONTEXT_MUST_NOT_BE_WRITTEN' })
  assert.equal((await runAnalysisBatch(f.plan, f.options)).status, 'complete')
  const prompt = 'Only synthetic fixture text.', expectedHash = createHash('sha256').update(prompt, 'utf8').digest('hex')
  const manifest = JSON.parse(await readFile(join(f.out, 'run-manifest.json'), 'utf8'))
  for (const name of await readdir(join(f.out, 'responses'))) {
    const text = await readFile(join(f.out, 'responses', name), 'utf8'), receipt = JSON.parse(text)
    const route = manifest.routes.find(route => route.name === receipt.route)
    assert.deepEqual(receipt.analysis_context, contextFor(receipt.analysis_context.id, route.request_id))
    assert.ok(route.ids.includes(receipt.analysis_context.id))
    assert.equal(receipt.prompt_sha256, expectedHash); assert.equal(receipt.prompt_bytes, Buffer.byteLength(prompt, 'utf8'))
    assert.equal(receipt.returned_model, `synthetic-${receipt.provider}-response`)
    assert.equal(text.includes(prompt), false); assert.equal(text.includes('SYNTHETIC_CONTEXT_MUST_NOT_BE_WRITTEN'), false)
  }
  const invalid = await fixture(t)
  invalid.contextFor = (id, request_id) => ({ id, request_id, stage: 'batch', batch_index: 0,
    source_ids: ['SYNTHETIC_INVALID_CONTEXT'], pages: Array.from({ length: 2001 }, (_, i) => i + 1) })
  assert.equal((await runAnalysisBatch(invalid.plan, invalid.options)).status, 'complete', 'Audit validation must not change model workflow')
  for (const name of await readdir(join(invalid.out, 'responses'))) {
    const text = await readFile(join(invalid.out, 'responses', name), 'utf8'), receipt = JSON.parse(text)
    assert.equal(receipt.analysis_context_status, 'invalid'); assert.equal(receipt.analysis_context, undefined)
    assert.equal(text.includes('SYNTHETIC_INVALID_CONTEXT'), false)
  }
})
