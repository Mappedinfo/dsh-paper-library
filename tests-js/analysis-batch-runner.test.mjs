import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDirectModelAgent } from '../src/direct-model.mjs'
import { runAnalysisBatch, validatePlan } from '../scripts/run-paper-analysis-batch.mjs'

async function fixture(t, overrides = {}) {
  const home = await mkdtemp(join(tmpdir(), 'synthetic-paper-batch-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const library = join(home, 'library'); await mkdir(library)
  const f = { home, library, out: join(home, 'output'), calls: 0, active: 0, peak: 0, writes: [], finishedProgress: [] }
  const key = 'SYNTHETIC_CREDENTIAL_NOT_FOR_REAL_USE'
  f.key = key
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
            try { await options.agent({ prompt: 'Only synthetic fixture text.', ...options.agent.model }) }
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
        ? { choices: [{ finish_reason: 'stop', message: { content } }], diagnostic_echo: key }
        : { stop_reason: 'end_turn', content: [{ type: 'text', text: content }], diagnostic_echo: key }))
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
  assert.equal(Buffer.byteLength(receipt.response_body), 512 * 1024)
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
