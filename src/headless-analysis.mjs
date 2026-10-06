import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { defaultLibrary, dispatch as defaultDispatch } from './bridge.mjs'
import { createLocalStateStore } from './local-state.mjs'
import { createPaperAnalysis } from './harness/paper-analysis.mjs'
import { directModelReasoningOptions } from './direct-model.mjs'
import { analysisInputOptions } from './analysis-input.mjs'

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value)
const fail = (code, message = '后台整理请求无效。', status = 400) => Object.assign(new Error(message), { code, status })
const active = new Set(['queued', 'reading', 'generating', 'committing'])
const actions = new Set(['paper_analysis_start', 'paper_analysis_get', 'paper_analysis_cancel', 'paper_analysis_apply', 'paper_analysis_context', 'paper_analysis_run'])
const clone = value => JSON.parse(JSON.stringify(value))
const configFields = new Set(['provider', 'model', 'keyEnv', 'envFile', 'maxOutputTokens', 'maxCalls', 'timeoutMs', 'maxConcurrency', 'thinking', 'reasoningEffort'])

function validatedConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config) || Object.keys(config).some(key => !configFields.has(key)) ||
      !['glm', 'kimi'].includes(config.provider) || typeof config.model !== 'string' || !config.model.trim() ||
      config.model.length > 200 || /[\x00-\x1f]/.test(config.model) || typeof config.keyEnv !== 'string' ||
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(config.keyEnv)) throw fail('DIRECT_MODEL_CONFIG_INVALID', '模型配置无效。')
  for (const [key, maximum] of [['maxOutputTokens', 32768], ['maxCalls', 10000], ['timeoutMs', 600000], ['maxConcurrency', 4]]) {
    if (config[key] !== undefined && (!Number.isSafeInteger(config[key]) || config[key] < 1 || config[key] > maximum)) throw fail('DIRECT_MODEL_CONFIG_INVALID', '模型配置无效。')
  }
  if (config.envFile !== undefined && (typeof config.envFile !== 'string' || !config.envFile.trim() || /[\x00-\x1f]/.test(config.envFile))) throw fail('DIRECT_MODEL_CONFIG_INVALID', '模型配置无效。')
  directModelReasoningOptions(config)
  return clone(config)
}

/** 仅读取调用者明确指定的配置；不搜索用户目录，不接受配置内直接存储的密钥。 */
export async function loadModelConfig(path) {
  let file
  try {
    if (typeof path !== 'string' || !path.trim()) throw new Error()
    const location = resolve(path)
    file = await open(location, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const info = await file.stat()
    if (!info.isFile() || info.size > 65536) throw new Error()
    const buffer = Buffer.alloc(65537)
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
    if (bytesRead !== info.size || bytesRead > 65536) throw new Error()
    const config = validatedConfig(JSON.parse(buffer.subarray(0, bytesRead).toString('utf8')))
    if (config.envFile !== undefined) {
      config.envFile = resolve(dirname(location), config.envFile)
    }
    return config
  } catch {
    throw fail('DIRECT_MODEL_CONFIG_INVALID', '模型配置无效或无法安全读取。')
  } finally { await file?.close() }
}

function effectiveOptions(input) {
  const mode = input.mode ?? 'full'
  if (!['full', 'metadata'].includes(mode)) throw fail('ANALYSIS_INVALID')
  for (const key of ['notes', 'review', 'apply_metadata']) if (input[key] !== undefined && typeof input[key] !== 'boolean') throw fail('ANALYSIS_INVALID')
  if (mode === 'metadata' && (input.notes === true || input.review === true)) throw fail('ANALYSIS_INVALID', '仅资料模式不能生成精读笔记或评审。')
  const pages = input.pages ?? (mode === 'metadata' ? [1] : undefined)
  if (pages !== undefined && (!Array.isArray(pages) || !pages.length || pages.length > 2000 || new Set(pages).size !== pages.length || pages.some(n => !Number.isInteger(n) || n < 1 || n > 2000))) throw fail('ANALYSIS_INVALID')
  return { mode, ...(pages ? { pages: [...pages] } : {}), notes: input.notes ?? mode === 'full',
    review: input.review ?? false, apply_metadata: input.apply_metadata ?? false, ...analysisInputOptions(input) }
}

function compact(record, id, requestId) {
  return clone({ id, request_id: requestId, status: record.status,
    ...(record.stage ? { stage: record.stage } : {}),
    ...(record.error ? { error: record.error } : {}),
    ...(record.error_code ? { error_code: record.error_code } : {}),
    ...(record.coverage ? { coverage: record.coverage } : {}),
    ...(record.model ? { model: record.model } : {}),
    ...(record.draft_id ? { draft_id: record.draft_id } : {}),
    ...(record.note_draft_id ? { note_draft_id: record.note_draft_id } : {}),
    ...(record.review_draft_id ? { review_draft_id: record.review_draft_id } : {}),
    metadata_fields: Object.keys(record.metadata ?? {}), warnings: record.warnings ?? [] })
}

function aggregate(results) {
  const completed = results.filter(row => row.status === 'complete').length
  const clean = results.filter(row => row.status === 'complete' && !row.warnings?.length).length
  return { status: clean === results.length ? 'complete' : completed ? 'partial' : 'failed',
    counts: { total: results.length, complete: completed, incomplete: results.length - completed,
      with_warnings: results.filter(row => row.warnings?.length).length } }
}

/** 无界面入口只复用既有阅读／草稿内核，不创建浏览器或 DSH 对话。
 * 批次只记录选择摘要；逐篇结果由同一个持久作业状态管理。中断批次不自动接管。 */
export async function createHeadlessAnalysis(options = {}) {
  const library = resolve(options.library ?? defaultLibrary)
  const store = options.store ?? createLocalStateStore({ library, home: options.localStateHome })
  const dispatch = options.dispatch ?? defaultDispatch
  const config = options.modelConfig === undefined ? undefined : validatedConfig(options.modelConfig)
  const maxConcurrency = config?.maxConcurrency ?? 1
  const maxCalls = config?.maxCalls ?? 100
  if (!Number.isSafeInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > 4 ||
      !Number.isSafeInteger(maxCalls) || maxCalls < 1 || maxCalls > 10000) throw fail('ANALYSIS_INVALID')
  let configuredAgent = options.agent, agentPromise, disposed = false, attempts = 0
  let admission = Promise.resolve()
  const jobs = new Map(), batches = new Map()

  function model() {
    const route = options.agent?.model ?? (config && { provider: config.provider, model: config.model })
    if (!route || typeof route.provider !== 'string' || !route.provider || typeof route.model !== 'string' || !route.model) throw fail('ANALYSIS_MODEL_REQUIRED', '请显式提供模型配置。', 409)
    return { provider: route.provider, model: route.model }
  }
  async function getAgent() {
    if (disposed) throw fail('ANALYSIS_UNAVAILABLE', '后台整理入口已关闭。', 409)
    if (typeof configuredAgent === 'function') return configuredAgent
    if (!config) throw fail('ANALYSIS_MODEL_REQUIRED', '请显式提供模型配置。', 409)
    if (!agentPromise) agentPromise = import('./direct-model.mjs').then(({ createDirectModelAgent }) => createDirectModelAgent(config)).then(agent => (configuredAgent = agent))
    return agentPromise
  }
  const usage = () => configuredAgent?.usage?.() ?? { calls: attempts, input_tokens: null, output_tokens: null }
  const engine = createPaperAnalysis({ store, dispatch, library, python: options.python, maxConcurrency, execution: 'direct',
    resolveModel: async () => { await getAgent(); return model() },
    agent: async request => {
      const agent = await getAgent()
      if (attempts >= maxCalls) throw fail('DIRECT_MODEL_BUDGET_EXHAUSTED', '本次模型调用次数已达上限。', 429)
      attempts++
      return agent(request)
    } })

  async function start(input) {
    if (!validId(input.id) || input.id.startsWith('dataset_') || !validId(input.request_id)) throw fail('ANALYSIS_INVALID')
    const configured = await getAgent()
    if (input.include_images === true && configured.supportsImages !== true) throw fail('PAPER_ANALYSIS_IMAGES_UNSUPPORTED', '当前分析适配器未确认图片支持。', 409)
    model()
    // 引擎 admission 跨异步 CAS 写入；串行调用 start，但阅读和模型阶段仍可并发。
    const operation = admission.catch(() => {}).then(async () => {
      let record
      while (true) {
        try { record = await engine(input); break }
        catch (error) {
          if (error.code !== 'ANALYSIS_BUSY' || !jobs.size) throw error
          await Promise.race(jobs.values())
        }
      }
      const key = hash([input.id, input.request_id])
      if (active.has(record.status) && !jobs.has(key)) {
        const promise = engine.wait(input.id, input.request_id).finally(() => jobs.delete(key))
        jobs.set(key, promise)
      }
      return record
    })
    admission = operation.then(() => {}, () => {})
    return operation
  }

  function batchRequest(input) {
    if (!validId(input.request_id) || (input.id !== undefined && input.ids !== undefined)) throw fail('ANALYSIS_INVALID')
    const ids = input.ids ?? (input.id === undefined ? null : [input.id])
    if (!Array.isArray(ids) || !ids.length || ids.length > 2000 || new Set(ids).size !== ids.length || ids.some(id => !validId(id) || id.startsWith('dataset_'))) throw fail('ANALYSIS_INVALID')
    const selected = [...ids], effective = effectiveOptions(input), route = model()
    const reasoning = directModelReasoningOptions(config)
    // Preserve manifests made before explicit reasoning controls existed.
    const limits = { maxConcurrency, maxCalls, maxOutputTokens: config?.maxOutputTokens ?? 8192, timeoutMs: config?.timeoutMs ?? 120000,
      ...(reasoning.thinking === 'disabled' ? {} : reasoning) }
    return { ids: selected, effective, route, limits,
      fingerprint: hash({ ids: selected, options: effective, model: route, limits }) }
  }
  const childId = (requestId, id) => `batch-${hash([requestId, id])}`
  const failureKey = (requestId, id) => `analysis.headless-failure:${hash([requestId, id])}`
  async function readBatch(input, selected, saved) {
    const results = []
    for (const id of selected.ids) {
      const requestId = childId(input.request_id, id)
      let record = await engine({ action: 'paper_analysis_get', id, request_id: requestId })
      if (record.status === 'idle') record = (await store.get(failureKey(input.request_id, id))).value ?? { status: 'not_started' }
      results.push(compact(record, id, requestId))
    }
    return { request_id: input.request_id, ...aggregate(results), results, reused: true,
      manifest_status: saved.value.status === 'running' ? 'unconfirmed' : saved.value.status,
      usage: usage(), usage_scope: 'headless_instance', original_usage_snapshot: saved.value.usage_snapshot ?? null }
  }
  async function runBatch(input, selected) {
    const key = `analysis.headless-batch:${hash(input.request_id)}`
    let saved = await store.get(key)
    if (saved.value) {
      if (saved.value.fingerprint !== selected.fingerprint) throw fail('ANALYSIS_CONFLICT', '批次请求内容已改变，请使用新的请求标识。', 409)
      return readBatch(input, selected, saved)
    }
    // 先解析显式凭据配置，再占用批次；缺配置不能留下假运行记录。
    await getAgent()
    try {
      saved = await store.put(key, { fingerprint: selected.fingerprint, ids_hash: hash(selected.ids),
        count: selected.ids.length, options: selected.effective, model: selected.route, limits: selected.limits,
        status: 'running', created_at: new Date().toISOString() }, 0)
    } catch (error) {
      if (error.code !== 'STATE_CONFLICT') throw error
      saved = await store.get(key)
      if (saved.value?.fingerprint !== selected.fingerprint) throw fail('ANALYSIS_CONFLICT', '批次请求内容已改变。', 409)
      return readBatch(input, selected, saved)
    }
    const results = new Array(selected.ids.length)
    let next = 0
    async function worker() {
      while (next < selected.ids.length) {
        const index = next++, id = selected.ids[index], requestId = childId(input.request_id, id)
        try {
          await start({ action: 'paper_analysis_start', id, request_id: requestId, ...selected.effective })
          await engine.wait(id, requestId)
          results[index] = compact(await engine({ action: 'paper_analysis_get', id, request_id: requestId }), id, requestId)
        } catch (error) {
          results[index] = compact({ status: 'failed', error: '此篇后台整理未完成。', error_code: error.code ?? 'ANALYSIS_FAILED' }, id, requestId)
          try { await store.put(failureKey(input.request_id, id), results[index], 0) }
          catch { results[index].warnings.push('逐篇失败状态未能保存；此批次不会自动重跑。') }
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(maxConcurrency, selected.ids.length) }, () => worker()))
    const outcome = aggregate(results), snapshot = clone(usage())
    await store.put(key, { ...saved.value, status: outcome.status, counts: outcome.counts,
      usage_snapshot: snapshot, completed_at: new Date().toISOString() }, saved.revision)
    return { request_id: input.request_id, ...outcome, results, reused: false,
      usage: snapshot, usage_scope: 'headless_instance' }
  }

  async function handle(input) {
    if (!actions.has(input?.action)) throw fail('ANALYSIS_INVALID')
    if (input.action === 'paper_analysis_run') {
      const selected = batchRequest(input), previous = batches.get(input.request_id)
      if (previous) {
        if (previous.fingerprint !== selected.fingerprint) throw fail('ANALYSIS_CONFLICT', '批次请求内容已改变。', 409)
        return previous.promise
      }
      const promise = runBatch(input, selected)
      batches.set(input.request_id, { fingerprint: selected.fingerprint, promise })
      try { return await promise } finally { batches.delete(input.request_id) }
    }
    if (input.action === 'paper_analysis_start') {
      // 读者界面选中文献时会自动带 reuse:true；独立入口只允许查已有结果，
      // 不继承 DSH 的自动分析授权，也不为自动选择读取模型凭据。
      if (input.reuse === true) {
        const record = await engine({ action: 'paper_analysis_get', id: input.id,
          ...(input.request_id !== undefined ? { request_id: input.request_id } : {}) })
        if (record.status !== 'idle' || input.request_id === undefined) return record
        return engine({ action: 'paper_analysis_get', id: input.id })
      }
      return start({ ...input, ...effectiveOptions(input) })
    }
    return engine(input)
  }
  handle.wait = (id, requestId) => engine.wait(id, requestId)
  handle.dispose = () => { disposed = true; engine.dispose() }
  handle.usage = usage
  return handle
}
