import { AsyncLocalStorage } from 'node:async_hooks'
import { realpath } from 'node:fs/promises'

const KEY = 'paper.model.settings'
const fail = (message, status = 409) => Object.assign(new Error(message), { code: 'PAPER_MODEL_UNAVAILABLE', status })

function field(value, name) {
  if (typeof value !== 'string' || !value.trim() || value.length > 200 || /[\x00-\x1f]/.test(value)) throw fail(`${name}无效。`, 400)
  return value
}
function selection(value) {
  if (!value) return null
  return { provider: field(value.provider, '模型供应商'), model: field(value.model, '模型'),
    ...(value.reasoningEffort ? { reasoningEffort: field(value.reasoningEffort, '推理强度') } : {}) }
}

export function createPaperModel({ store, models, llm, getDefault, library }) {
  let record, directory, changes = 0
  const admissions = new AsyncLocalStorage()
  const accepted = new WeakMap(), turns = new WeakMap()
  const datasetSessions = new Set()
  const read = async () => {
    const observed = changes
    const latest = await store.get(KEY)
    if (observed === changes) record = latest
    return record
  }
  const ready = Promise.all([read(), realpath(library).then(value => { directory = value }, () => {})])
  // A failed initial read is retried on explicit access.
  void ready.catch(() => {})
  const current = () => selection(record?.value?.model || getDefault())
  async function efforts(route, signal) {
    try {
      const info = await llm.resolveModelInfo(route.provider, route.model, signal)
      return (info?.reasoning?.efforts || []).slice(0, 40).map(({ id, name }) => ({ id, name }))
    } catch {
      signal?.throwIfAborted()
      throw fail('这个模型当前不可用，请重新读取模型列表。')
    }
  }
  async function validate(route, signal) {
    const supported = await efforts(route, signal)
    if (route.reasoningEffort && !supported.some(item => item.id === route.reasoningEffort)) throw fail('所选推理强度当前不可用，请重新选择。')
    try { await llm.resolveCallConfig(route) } catch { signal?.throwIfAborted(); throw fail('模型配置当前不可用，请检查 DSH 模型设置。') }
    signal?.throwIfAborted()
    return route
  }
  async function resolve(signal, pinned) {
    if (!pinned) await read()
    const route = pinned ? selection(pinned) : current()
    if (!route) throw fail('请在 DSH 或资料库设置中选择模型。')
    return validate(route, signal)
  }
  async function view(signal) {
    const latest = await read()
    const catalog = await models(signal)
    const route = current()
    let warning = ''
    if (latest.value?.model) {
      if (!catalog.models.some(item => item.provider === route.provider && item.id === route.model)) warning = '已保存的模型当前不在 DSH 可用列表中。'
      else try { await validate(route, signal) } catch (error) { signal?.throwIfAborted(); warning = error.message }
    } else if (!route) warning = 'DSH 尚未设置默认模型。'
    return { value: { model: latest.value?.model || null }, revision: latest.revision, models: catalog.models, effective_model: route, warning, writable: true }
  }
  async function handle(input, { signal } = {}) {
    if (input.action === 'paper_model_get') return view(signal)
    if (input.action === 'paper_model_efforts') {
      const route = selection(input.model)
      if (!route) throw fail('请选择模型。', 400)
      return { efforts: await efforts(route, signal) }
    }
    if (input.expected_revision !== 0 && (typeof input.expected_revision !== 'string' || !/^[a-f0-9]{64}$/.test(input.expected_revision))) throw fail('请刷新设置后保存。', 400)
    const model = selection(input.model)
    const catalog = await models(signal)
    if (model) {
      if (!catalog.models.some(item => item.provider === model.provider && item.id === model.model)) throw fail('所选模型不在 DSH 当前可用列表中。')
      await validate(model, signal)
    }
    const saved = await store.put(KEY, { model }, input.expected_revision)
    changes++
    record = saved
    const route = current()
    return { value: saved.value, revision: saved.revision, models: catalog.models, effective_model: route,
      warning: route ? '' : 'DSH 尚未设置默认模型。', writable: true }
  }
  function owns(agent) {
    const id = agent?.session?.id
    return directory && agent?.session?.header?.cwd === directory && /^paper-library-[a-f0-9]{40}$/.test(id || '') && !datasetSessions.has(id)
  }
  function install(ctx) {
    ctx.on('agent/inbox/inserted', ({ agent, message }) => {
      if (!owns(agent)) return
      const pinned = admissions.getStore()
      accepted.set(message, pinned?.sessionId === agent.session.id ? pinned.route : current())
    })
    ctx.on('agent/inbox/claimed', ({ agent, message, turn }) => {
      if (!owns(agent) || turns.get(agent) === turn) return
      // The oldest claimed input determines the route for the whole turn.
      // Recovered inbox work without an admission in this process keeps its native route.
      turns.set(agent, turn)
      const route = accepted.get(message)
      if (route) agent.model.select(route)
    })
  }
  return { handle, ready, current, resolve, install,
    ownDirectory: value => { directory = value },
    exclude: id => { datasetSessions.add(id) },
    admit: (sessionId, route, run) => admissions.run({ sessionId, route }, run) }
}
