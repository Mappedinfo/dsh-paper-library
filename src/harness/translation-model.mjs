import { awaitWithAbort } from './ai.mjs'

const lightweightRoutes = [
  { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'off' },
  { provider: 'kimi-coding', model: 'kimi-for-coding-highspeed', reasoningEffort: 'low' },
  { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'off' },
]
const listed = (route, available) => available.some(item => item.provider === route.provider && item.id === route.model)
const service = provider => ['deepseek-official', 'deepseek-account'].includes(provider) ? 'deepseek' : provider
const routeName = ({ provider, model }) => `${provider}/${model}`

export function preferredTranslationModel(available = []) {
  return lightweightRoutes.find(route => listed(route, available)) ?? null
}

async function fallbackModel(model, available, getDefaultModel, signal) {
  const other = route => route?.provider && route.model && service(route.provider) !== service(model.provider)
  const lightweight = lightweightRoutes.find(route => other(route) && listed(route, available))
  if (lightweight) return lightweight
  const candidates = available.map(({ provider, id }) => ({ provider, model: id })).filter(other)
  if (!candidates.length) return null
  let host
  try { host = await awaitWithAbort(getDefaultModel?.(), signal) } catch { signal.throwIfAborted() }
  return other(host) && listed(host, available) ? host : candidates[0]
}

function temporaryFailure(error) {
  const { kind, code, status } = error?.llmFailure ?? error?.failure ?? error ?? {}
  if (kind && kind !== 'error') return null
  if (code === 'TIMEOUT' || status === 408) return '响应超时'
  if (code === 'TRANSPORT') return '连接中断或未收到完整响应'
  if (code === 'RATE_LIMIT' || status === 429) return '服务限流'
  if (code === 'SERVER' || (Number.isInteger(status) && status >= 500 && status < 600)) return '服务暂时不可用'
  return null
}

/** Allow one switch to another configured service, within the same request deadline. */
export async function translateWithFallback({ ai, prompt, model, available = [], getDefaultModel, signal }) {
  const deadline = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(120000)])
  const backup = await fallbackModel(model, available, getDefaultModel, deadline)
  const firstTimeout = backup ? AbortSignal.timeout(55000) : null
  const firstSignal = firstTimeout ? AbortSignal.any([deadline, firstTimeout]) : deadline
  const run = async (route, callSignal) => {
    callSignal.throwIfAborted()
    return awaitWithAbort(ai({ prompt, ...route, signal: callSignal }), callSignal)
  }
  try {
    return { raw: await run(model, firstSignal), model }
  } catch (error) {
    deadline.throwIfAborted()
    const reason = firstTimeout?.aborted ? '响应超时' : temporaryFailure(error)
    if (!reason) throw error
    const message = `翻译主模型 ${routeName(model)}${reason}。`
    const failed = detail => Object.assign(new Error(message + detail), { code: 'LANGUAGE_TRANSLATION_TEMPORARY', status: 502 })
    if (!backup) throw failed('当前没有其他已配置的模型服务可切换。')
    try {
      return { raw: await run(backup, deadline), model: backup, fallback_from: model }
    } catch (backupError) {
      deadline.throwIfAborted()
      throw failed(`备用模型 ${routeName(backup)}${temporaryFailure(backupError) ?? '也未完成请求'}。`)
    }
  }
}
