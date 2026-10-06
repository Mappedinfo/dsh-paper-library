#!/usr/bin/env node
// 显式批次的私有运行回执；阅读与分析仍由现有 headless 内核完成。
import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, lstat, mkdir, open, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDirectModelAgent } from '../src/direct-model.mjs'
import { createHeadlessAnalysis, loadModelConfig } from '../src/headless-analysis.mjs'
import { createLocalStateStore } from '../src/local-state.mjs'

const MAX_RESPONSE = 512 * 1024
const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const idValid = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value)
const fail = code => Object.assign(new Error(code), { code })
const safeCode = error => /^[A-Z][A-Z0-9_]{1,100}$/.test(error?.code ?? '') ? error.code : 'BATCH_OPERATION_FAILED'
const stamp = () => new Date().toISOString()
const within = (parent, child) => { const part = relative(parent, child); return part === '' || part !== '..' && !part.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(part) }
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')

export function validatePlan(plan) {
  const fields = new Set(['library', 'python', 'localStateHome', 'request_id', 'mode', 'notes', 'review', 'routes'])
  if (!plan || Array.isArray(plan) || typeof plan !== 'object' || Object.keys(plan).some(key => !fields.has(key)) ||
      typeof plan.library !== 'string' || !isAbsolute(plan.library) || !idValid(plan.request_id) ||
      !['full', 'metadata'].includes(plan.mode) || typeof plan.notes !== 'boolean' || plan.review !== false ||
      plan.mode === 'metadata' && plan.notes || !Array.isArray(plan.routes) || !plan.routes.length || plan.routes.length > 20) throw fail('BATCH_PLAN_INVALID')
  for (const field of ['python', 'localStateHome']) if (plan[field] !== undefined && (typeof plan[field] !== 'string' || !isAbsolute(plan[field]))) throw fail('BATCH_PLAN_INVALID')
  const names = new Set(), ids = new Set()
  for (const route of plan.routes) {
    if (!route || Array.isArray(route) || Object.keys(route).some(key => !['name', 'config', 'ids'].includes(key)) ||
        typeof route.name !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(route.name) || names.has(route.name) ||
        typeof route.config !== 'string' || !isAbsolute(route.config) || !Array.isArray(route.ids) || !route.ids.length) throw fail('BATCH_PLAN_INVALID')
    names.add(route.name)
    for (const id of route.ids) {
      if (!idValid(id) || id.startsWith('dataset_') || ids.has(id)) throw fail('BATCH_DUPLICATE_OR_INVALID_PAPER')
      ids.add(id)
      if (ids.size > 2000) throw fail('BATCH_PLAN_TOO_LARGE')
    }
  }
  return JSON.parse(JSON.stringify(plan))
}

async function readJSON(path, maximum) {
  let handle
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const info = await handle.stat()
    if (!info.isFile() || info.size > maximum) throw fail('BATCH_PLAN_INVALID')
    const buffer = Buffer.alloc(maximum + 1)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    if (bytesRead !== info.size || bytesRead > maximum) throw fail('BATCH_PLAN_INVALID')
    return JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'))
  } catch { throw fail('BATCH_PLAN_INVALID') }
  finally { await handle?.close() }
}

async function prepareOutput(out, library) {
  if (typeof out !== 'string' || !isAbsolute(out)) throw fail('BATCH_OUTPUT_INVALID')
  const target = resolve(out), parent = await realpath(dirname(target)), canonical = join(parent, relative(dirname(target), target))
  const libraryRoot = await realpath(library)
  if (within(libraryRoot, canonical) || within(PROJECT_ROOT, canonical)) throw fail('BATCH_OUTPUT_UNSAFE')
  // 回执含原始模型响应；保守拒绝所有 Git 工作树，不能误放进公开项目。
  for (let cursor = parent;; cursor = dirname(cursor)) {
    try { await lstat(join(cursor, '.git')); throw fail('BATCH_OUTPUT_IN_GIT') }
    catch (error) { if (error.code !== 'ENOENT') throw error }
    if (dirname(cursor) === cursor) break
  }
  try { await mkdir(canonical, { mode: 0o700 }) }
  catch (error) { throw fail(error.code === 'EEXIST' ? 'BATCH_OUTPUT_EXISTS' : 'BATCH_OUTPUT_INVALID') }
  await chmod(canonical, 0o700)
  await mkdir(join(canonical, 'responses'), { mode: 0o700 })
  return canonical
}

class Semaphore {
  active = 0
  peak = 0
  waiting = []
  constructor(id) { this.id = id }
  acquire(signal) {
    if (signal?.aborted) return Promise.reject(fail('BATCH_CALL_ABORTED'))
    return new Promise((accept, reject) => {
      const item = { accept, reject, signal }
      item.abort = () => { this.waiting = this.waiting.filter(row => row !== item); reject(fail('BATCH_CALL_ABORTED')) }
      signal?.addEventListener('abort', item.abort, { once: true })
      this.waiting.push(item); this.pump()
    })
  }
  pump() {
    while (this.active < 2 && this.waiting.length) {
      const item = this.waiting.shift()
      item.signal?.removeEventListener('abort', item.abort)
      if (item.signal?.aborted) { item.reject(fail('BATCH_CALL_ABORTED')); continue }
      this.active++
      this.peak = Math.max(this.peak, this.active)
      let released = false
      item.accept(() => { if (!released) { released = true; this.active--; this.pump() } })
    }
  }
}

function credentialOf(headers) {
  const parsed = new Headers(headers), values = []
  for (const name of ['authorization', 'x-api-key', 'api-key']) {
    const value = parsed.get(name)
    if (value) values.push(name === 'authorization' ? value.replace(/^Bearer\s+/i, '').trim() : value.trim())
  }
  if (!values.length || !values[0] || new Set(values).size !== 1) throw fail('BATCH_CREDENTIAL_HEADER_INVALID')
  return values[0]
}

async function responseBody(response, signal, call) {
  if (!response.body) return ''
  const reader = response.body.getReader(), chunks = []
  let length = 0
  try {
    while (true) {
      if (signal?.aborted) throw fail('BATCH_CALL_ABORTED')
      const { value, done } = await reader.read()
      if (done) break
      const remaining = MAX_RESPONSE - length
      if (value.byteLength > remaining) {
        chunks.push(Buffer.from(value).subarray(0, remaining)); length = MAX_RESPONSE
        call.response_body_truncated = true
        await reader.cancel()
        throw fail('BATCH_RESPONSE_TOO_LARGE')
      }
      chunks.push(Buffer.from(value)); length += value.byteLength
    }
    return Buffer.concat(chunks, length).toString('utf8')
  } finally {
    call.response_bytes = length
    call.response_body = Buffer.concat(chunks, length).toString('utf8')
    try { await reader.cancel() } catch {}
    reader.releaseLock()
  }
}

/** 只供显式计划调用；所有可注入依赖用于合成验证，不做凭据发现。 */
export async function runAnalysisBatch(rawPlan, options = {}) {
  const plan = validatePlan(rawPlan)
  const out = await prepareOutput(options.out, plan.library)
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const agentFactory = options.createAgent ?? createDirectModelAgent
  const analysisFactory = options.createAnalysis ?? createHeadlessAnalysis
  const storeFactory = options.createStore ?? createLocalStateStore
  const loadConfig = options.loadConfig ?? loadModelConfig
  const context = new AsyncLocalStorage(), secrets = new Set(), slots = new Map(), handles = []
  const papers = new Map(plan.routes.flatMap(route => route.ids.map(id => [id, { id, route: route.name, status: 'pending' }])))
  const calls = [], routes = [], startedAt = stamp()
  let persistTail = Promise.resolve(), progressWarning = false, interval
  const redact = text => {
    for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
      text = text.split(secret).join('[REDACTED]')
      const escaped = JSON.stringify(secret).slice(1, -1)
      if (escaped !== secret) text = text.split(escaped).join('[REDACTED]')
    }
    return text
  }
  const credentialGroups = () => [...slots.values()].map(slot => ({ id: slot.id, limit: 2, active: slot.active, peak: slot.peak }))
  function auditBody(body) {
    // API 正文及 message.content 内的嵌套 JSON 都先解码，再脱敏；\u 编码
    // 不能绕过凭据遮蔽。此规范化仅用于审计副本，adapter 仍接收原文。
    function clean(value, depth = 0) {
      if (typeof value === 'string') {
        if (depth < 8) try { const parsed = JSON.parse(value); if (parsed !== value) return typeof parsed === 'string' ? clean(parsed, depth + 1) : JSON.stringify(clean(parsed, depth + 1)) } catch {}
        return redact(value.replace(/\\+u([\da-f]{4})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16))))
      }
      if (Array.isArray(value)) return value.map(item => clean(item, depth))
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [redact(key), clean(item, depth)]))
      return value
    }
    let text
    try { text = JSON.stringify(clean(JSON.parse(body))) }
    catch { text = clean(body) }
    let truncated = Buffer.byteLength(text) > MAX_RESPONSE
    if (truncated) { text = Buffer.from(text).subarray(0, MAX_RESPONSE).toString('utf8'); while (Buffer.byteLength(text) > MAX_RESPONSE) text = text.slice(0, -1) }
    return { text, truncated }
  }
  async function atomic(name, value, exclusive = false) {
    const text = redact(JSON.stringify(value, null, 2)) + '\n'
    const operation = persistTail.catch(() => {}).then(async () => {
      const destination = join(out, name)
      if (exclusive) return writeFile(destination, text, { mode: 0o600, flag: 'wx' })
      const temporary = join(out, `.${name.replaceAll('/', '-')}-${randomUUID()}.tmp`)
      try { await writeFile(temporary, text, { mode: 0o600, flag: 'wx' }); await rename(temporary, destination) }
      finally { await rm(temporary, { force: true }).catch(() => {}) }
    })
    persistTail = operation
    return operation
  }
  function progress(status = 'running') {
    return atomic('progress.json', { schema: 1, request_id: plan.request_id, status, started_at: startedAt, updated_at: stamp(),
      paper_count: papers.size, papers: [...papers.values()],
      calls: { total: calls.length, succeeded: calls.filter(row => row.status === 'succeeded').length,
        failed: calls.filter(row => row.status === 'failed').length, active: calls.filter(row => row.status === 'running').length },
      credential_groups: credentialGroups(),
      routes: routes.map(route => ({ name: route.name, provider: route.config.provider, model: route.config.model,
        maxCalls: route.config.maxCalls, maxConcurrency: route.config.maxConcurrency })) })
  }
  const auditedFetch = async (url, init = {}) => {
    const call = context.getStore()
    if (!call || call.fetched) throw fail('BATCH_CALL_CONTEXT_INVALID')
    call.fetched = true
    const credential = credentialOf(init.headers)
    secrets.add(credential)
    if (!slots.has(credential)) slots.set(credential, new Semaphore(slots.size + 1))
    call.credential_group = slots.get(credential).id
    const release = await slots.get(credential).acquire(init.signal)
    try {
      const response = await fetchImpl(url, init)
      call.http_status = response.status
      const text = await responseBody(response, init.signal, call)
      // 原样交回已有 adapter，由它继续判断截断、JSON schema 和实际 key 泄漏。
      return new Response(text, { status: response.status,
        headers: { 'content-type': response.headers?.get('content-type') ?? 'application/json' } })
    } catch (error) {
      call.transport_error = safeCode(error)
      throw fail(call.transport_error)
    } finally { release() }
  }

  try {
    // 所有预算先验通过后才允许任何 route 发起模型调用。
    for (const route of plan.routes) {
      const config = await loadConfig(route.config)
      if (!Object.hasOwn(config, 'maxCalls') || !Number.isSafeInteger(config.maxCalls) || config.maxCalls < 1 || config.maxCalls > 10000) throw fail('BATCH_EXPLICIT_BUDGET_REQUIRED')
      routes.push({ ...route, config: { ...config, maxConcurrency: Math.min(config.maxConcurrency ?? 2, 2) },
        request_id: `route-${hash([plan.request_id, route.name])}` })
    }
    await atomic('run-manifest.json', { schema: 1, request_id: plan.request_id, mode: plan.mode, notes: plan.notes,
      review: false, apply_metadata: false, started_at: startedAt,
      routes: routes.map(route => ({ name: route.name, request_id: route.request_id, provider: route.config.provider,
        model: route.config.model, maxCalls: route.config.maxCalls, maxConcurrency: route.config.maxConcurrency, ids: route.ids })) }, true)
    await progress()
    interval = setInterval(() => { progress().catch(() => { progressWarning = true }) }, options.progressIntervalMs ?? 30000)
    interval.unref?.()
    const state = storeFactory({ library: plan.library, home: plan.localStateHome })
    const observedStore = { get: (...args) => state.get(...args), async put(key, value, expected) {
      const result = await state.put(key, value, expected)
      if (key.startsWith('analysis.job:') && papers.has(value.id) && typeof value.status === 'string') {
        const previous = papers.get(value.id)
        papers.set(value.id, { ...previous, status: value.status, batch_count: value.batch_count ?? 0,
          ...(value.note_draft_id ? { note_draft_id: value.note_draft_id } : {}), warnings: value.warnings?.length ?? 0 })
        if (['complete', 'failed', 'cancelled'].includes(value.status)) await progress().catch(() => { progressWarning = true })
      }
      return result
    } }
    const results = await Promise.all(routes.map(async route => {
      try {
        const agent = await agentFactory(route.config, { fetchImpl: auditedFetch })
        const auditedAgent = async input => {
          const call = { call_id: calls.length + 1, route: route.name, provider: route.config.provider,
            model: route.config.model, started_at: stamp(), status: 'running' }
          calls.push(call)
          await progress()
          return context.run(call, async () => {
            try { const result = await agent(input); call.status = 'succeeded'; return result }
            catch (error) { call.status = 'failed'; call.error_code = safeCode(error); throw fail(call.error_code) }
            finally {
              call.finished_at = stamp()
              const { fetched, ...receipt } = call
              if (receipt.response_body !== undefined) {
                const safeBody = auditBody(receipt.response_body)
                receipt.response_body = safeBody.text
                receipt.response_body_encoding = 'json-normalized-redacted'
                if (safeBody.truncated) receipt.response_body_truncated = true
              }
              await atomic(`responses/${String(call.call_id).padStart(6, '0')}-${route.name}.json`, receipt, true)
              await progress()
              // 原始正文仅存私有回执，不在运行中的统计列表里长期保留。
              delete call.response_body
            }
          })
        }
        auditedAgent.model = agent.model
        auditedAgent.usage = () => agent.usage?.() ?? { calls: calls.filter(call => call.route === route.name).length }
        const handle = await analysisFactory({ library: plan.library, python: plan.python, localStateHome: plan.localStateHome,
          modelConfig: route.config, store: observedStore, agent: auditedAgent })
        handles.push(handle)
        const result = await handle({ action: 'paper_analysis_run', ids: route.ids, request_id: route.request_id,
          mode: plan.mode, notes: plan.notes, review: false, apply_metadata: false })
        for (const row of result.results ?? []) if (papers.has(row.id)) papers.set(row.id, {
          id: row.id, route: route.name, status: row.status, warnings: row.warnings?.length ?? 0,
          ...(row.note_draft_id ? { note_draft_id: row.note_draft_id } : {}) })
        await progress()
        return { name: route.name, ...result }
      } catch (error) {
        for (const id of route.ids) if (!['complete', 'failed', 'cancelled'].includes(papers.get(id).status)) papers.set(id, { id, route: route.name, status: 'failed' })
        await progress().catch(() => { progressWarning = true })
        return { name: route.name, status: 'failed', error_code: safeCode(error) }
      }
    }))
    clearInterval(interval)
    const status = results.every(row => row.status === 'complete') && !progressWarning ? 'complete'
      : results.some(row => row.status === 'complete' || row.status === 'partial') ? 'partial' : 'failed'
    const result = { schema: 1, request_id: plan.request_id, status, started_at: startedAt, completed_at: stamp(),
      routes: results, calls: calls.length, credential_groups: credentialGroups(), warnings: progressWarning ? ['PROGRESS_WRITE_FAILED'] : [] }
    await atomic('result.json', result, true)
    await progress(status)
    return JSON.parse(redact(JSON.stringify(result)))
  } catch (error) {
    clearInterval(interval)
    const result = { schema: 1, request_id: plan.request_id, status: 'failed', error_code: safeCode(error),
      started_at: startedAt, completed_at: stamp(), calls: calls.length }
    await atomic('result.json', result, true).catch(() => {})
    await progress('failed').catch(() => {})
    return result
  } finally { for (const handle of handles) handle.dispose?.(); await persistTail.catch(() => {}); slots.clear(); secrets.clear() }
}

async function main() {
  const args = process.argv.slice(2)
  if (args.length !== 4 || args[0] !== '--plan' || args[2] !== '--out') throw fail('BATCH_CLI_INVALID')
  const plan = await readJSON(args[1], 1024 * 1024)
  const result = await runAnalysisBatch(plan, { out: args[3] })
  // stdout 只含计数和状态；原始响应与逐篇材料都留在明确指定的私有目录。
  process.stdout.write(JSON.stringify({ status: result.status, route_count: result.routes?.length ?? 0,
    paper_count: plan.routes?.reduce((sum, route) => sum + route.ids.length, 0) ?? 0, calls: result.calls,
    ...(result.error_code ? { error_code: result.error_code } : {}) }) + '\n')
  if (result.status !== 'complete') process.exitCode = 1
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { process.stdout.write(JSON.stringify({ status: 'failed', error_code: safeCode(error) }) + '\n'); process.exitCode = 1 })
}
