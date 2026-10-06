const QUOTA = /(?:insufficient[_\s-]*quota|usage\s+limit|quota\s+(?:is\s+)?(?:exhausted|exceeded|limit)|exceeded.{0,40}quota|quota.{0,40}(?:exhausted|exceeded|limit))/i
const AUTH = /(?:invalid[_\s-]*(?:api[_\s-]*)?key|unauthori[sz]ed|authentication|permission[_\s-]*error|forbidden|credential)/i

function diagnosticText(body) {
  if (typeof body === 'string') {
    if (body.length > 65536) body = body.slice(0, 65536)
    try { body = JSON.parse(body) } catch { return body }
  }
  if (!body || typeof body !== 'object') return ''
  const values = []
  const visit = (value, depth) => {
    if (depth > 4 || values.length > 32) return
    if (typeof value === 'string') values.push(value.slice(0, 1200))
    else if (Array.isArray(value)) for (const item of value.slice(0, 16)) visit(item, depth + 1)
    else if (value && typeof value === 'object') {
      for (const key of ['error', 'type', 'code', 'message', 'detail', 'reason']) if (Object.hasOwn(value, key)) visit(value[key], depth + 1)
    }
  }
  visit(body, 0)
  return values.join(' ').slice(0, 8192)
}

/** Classify provider HTTP errors without returning provider text or credentials. */
export function classifyModelHttpError(provider, status, body) {
  const text = diagnosticText(body)
  if (status === 402 || (status === 403 || status === 429) && QUOTA.test(text)) {
    return 'DIRECT_MODEL_QUOTA_EXHAUSTED'
  }
  if (status === 401 || status === 403 && (AUTH.test(text) || !QUOTA.test(text))) return 'DIRECT_MODEL_AUTH_ERROR'
  if (status === 429) return 'DIRECT_MODEL_RATE_LIMITED'
  return 'DIRECT_MODEL_HTTP_ERROR'
}

export function isFatalModelError(error) {
  return ['DIRECT_MODEL_QUOTA_EXHAUSTED', 'DIRECT_MODEL_AUTH_ERROR'].includes(error?.code)
}

/** 截断诊断只携带固定停止原因和计数，不传播供应商正文。 */
export function safeTruncationDetails(error) {
  if (error?.code !== 'DIRECT_MODEL_OUTPUT_TRUNCATED' || !error.details || typeof error.details !== 'object') return undefined
  const result = {}
  if (['max_tokens', 'length'].includes(error.details.stop_reason)) result.stop_reason = error.details.stop_reason
  for (const key of ['max_output_tokens', 'output_tokens', 'thinking_tokens']) {
    const value = error.details[key]
    if (Number.isSafeInteger(value) && value >= 0) result[key] = value
  }
  return Object.keys(result).length ? result : undefined
}

export function safeModelErrorMessage(code) {
  if (code === 'DIRECT_MODEL_QUOTA_EXHAUSTED') return '模型服务额度已耗尽；本轮停止后续请求。'
  if (code === 'DIRECT_MODEL_AUTH_ERROR') return '模型服务认证失败；本轮停止后续请求。'
  if (code === 'DIRECT_MODEL_RATE_LIMITED') return '模型服务暂时限流。'
  if (code === 'DIRECT_MODEL_OUTPUT_TRUNCATED') return '模型输出达到本次令牌上限；本篇停止后续问题组。'
  return '模型服务请求失败。'
}
