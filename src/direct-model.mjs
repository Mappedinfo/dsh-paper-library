import { lstat, open } from 'node:fs/promises'
import { Buffer } from 'node:buffer'
import { constants as fsConstants } from 'node:fs'

const MAX_PROMPT_BYTES = 128 * 1024
const MAX_RESPONSE_BYTES = 512 * 1024
const MAX_TEXT_BYTES = 160_000
const USER_AGENT = 'dsh-paper-library (direct metadata analysis; https://github.com/mappedinfo/dsh-paper-library)'
const MAX_ENV_FILE_BYTES = 1024 * 1024
const ENDPOINTS = Object.freeze({
  glm: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
  kimi: 'https://api.kimi.com/coding/v1/messages',
})

function safeError(code, status) {
  const error = new Error(code)
  error.code = code
  if (status !== undefined) error.status = status
  return error
}

/** Pure validation shared with batch identity checks; never loads credentials. */
export function directModelReasoningOptions(config) {
  const thinking = config?.thinking === undefined ? 'disabled' : config.thinking
  const reasoningEffort = config?.reasoningEffort
  if (!['disabled', 'enabled', 'default'].includes(thinking) ||
      (reasoningEffort !== undefined && (!['low', 'high', 'max'].includes(reasoningEffort) || thinking === 'disabled'))) {
    throw safeError('DIRECT_MODEL_CONFIG_INVALID', 400)
  }
  const model = typeof config?.model === 'string' ? config.model.trim().toLowerCase() : ''
  if (thinking === 'disabled' && ((config?.provider === 'kimi' && ['k3', 'k3-256k'].includes(model)) ||
      (config?.provider === 'glm' && ['glm-5.3-flash', 'glm-5.3-flashx'].includes(model)))) {
    throw safeError('DIRECT_MODEL_CONFIG_INVALID', 400)
  }
  return { thinking, ...(reasoningEffort !== undefined ? { reasoningEffort } : {}) }
}

function validateConfig(config) {
  if (!config || !['glm', 'kimi'].includes(config.provider)) throw safeError('DIRECT_MODEL_CONFIG_INVALID', 400)
  if (typeof config.model !== 'string' || !config.model.trim() || config.model.length > 200) throw safeError('DIRECT_MODEL_CONFIG_INVALID', 400)
  if (typeof config.keyEnv !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(config.keyEnv)) throw safeError('DIRECT_MODEL_CONFIG_INVALID', 400)
  if (config.envFile !== undefined && (typeof config.envFile !== 'string' || !config.envFile)) throw safeError('DIRECT_MODEL_CONFIG_INVALID', 400)
  const maxOutputTokens = config.maxOutputTokens ?? 8192
  const maxCalls = config.maxCalls ?? 100
  const timeoutMs = config.timeoutMs ?? 120_000
  if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > 32_768 ||
      !Number.isSafeInteger(maxCalls) || maxCalls < 1 || maxCalls > 10_000 ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000) {
    throw safeError('DIRECT_MODEL_CONFIG_INVALID', 400)
  }
  return Object.freeze({ provider: config.provider, model: config.model, keyEnv: config.keyEnv,
    envFile: config.envFile, maxOutputTokens, maxCalls, timeoutMs, ...directModelReasoningOptions(config) })
}

function parseEnvValue(raw) {
  const value = raw.trim()
  let key
  let remainder = ''
  if (value.startsWith('"') || value.startsWith("'")) {
    const quote = value[0]
    const end = value.indexOf(quote, 1)
    if (end < 0) throw safeError('DIRECT_MODEL_ENV_FILE_INVALID', 400)
    key = value.slice(1, end)
    remainder = value.slice(end + 1).trim()
    if (remainder && !remainder.startsWith('#')) throw safeError('DIRECT_MODEL_ENV_FILE_INVALID', 400)
  } else {
    const commentAt = value.search(/\s+#/)
    key = (commentAt < 0 ? value : value.slice(0, commentAt)).trim()
  }
  if (!key || /[\s\x00-\x1f\x7f`$]/.test(key)) throw safeError('DIRECT_MODEL_ENV_FILE_INVALID', 400)
  return key
}

async function resolveKey(config, env) {
  if (!config.envFile) {
    const direct = env?.[config.keyEnv]
    if (typeof direct !== 'string' || !direct.trim() || /[\s\x00-\x1f\x7f`$]/.test(direct.trim())) throw safeError('DIRECT_MODEL_KEY_MISSING', 401)
    return direct.trim()
  }
  let handle
  try {
    const before = await lstat(config.envFile)
    if (!before.isFile() || before.size > MAX_ENV_FILE_BYTES || (before.mode & fsConstants.S_IFMT) !== fsConstants.S_IFREG) throw safeError('DIRECT_MODEL_ENV_FILE_INVALID', 400)
    handle = await open(config.envFile, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0))
    const opened = await handle.stat()
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size > MAX_ENV_FILE_BYTES) throw safeError('DIRECT_MODEL_ENV_FILE_INVALID', 400)
    const chunks = []
    let size = 0
    while (true) {
      const buffer = Buffer.alloc(Math.min(64 * 1024, MAX_ENV_FILE_BYTES + 1 - size))
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null)
      if (!bytesRead) break
      size += bytesRead
      if (size > MAX_ENV_FILE_BYTES) throw safeError('DIRECT_MODEL_ENV_FILE_INVALID', 400)
      chunks.push(buffer.subarray(0, bytesRead))
    }
    const after = await handle.stat()
    const finalPath = await lstat(config.envFile)
    const identity = st => [st.dev, st.ino, st.mode, st.size, st.mtimeMs, st.ctimeMs].join(':')
    if (identity(before) !== identity(after) || identity(before) !== identity(finalPath)) throw safeError('DIRECT_MODEL_ENV_FILE_INVALID', 400)
    const contents = Buffer.concat(chunks, size).toString('utf8').replace(/^\uFEFF/, '')
    const pattern = new RegExp(`^\\s*(?:export\\s+)?${config.keyEnv}\\s*=\\s*(.*?)\\s*$`)
    const matches = []
    for (const line of contents.split(/\r?\n/)) {
      const match = pattern.exec(line)
      if (match) matches.push(parseEnvValue(match[1]))
    }
    if (matches.length !== 1) throw safeError(matches.length > 1 ? 'DIRECT_MODEL_ENV_FILE_INVALID' : 'DIRECT_MODEL_KEY_MISSING', matches.length > 1 ? 400 : 401)
    return matches[0]
  } catch (error) {
    if (error?.code?.startsWith('DIRECT_MODEL_')) throw error
    throw safeError('DIRECT_MODEL_KEY_MISSING', 401)
  } finally {
    await handle?.close().catch(() => {})
  }
}

async function readBounded(response) {
  const declared = Number(response.headers?.get?.('content-length'))
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw safeError('DIRECT_MODEL_RESPONSE_TOO_LARGE', 502)
  if (!response.body?.getReader) {
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.byteLength > MAX_RESPONSE_BYTES) throw safeError('DIRECT_MODEL_RESPONSE_TOO_LARGE', 502)
    return Buffer.from(bytes).toString('utf8')
  }
  const reader = response.body.getReader()
  const chunks = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => {})
        throw safeError('DIRECT_MODEL_RESPONSE_TOO_LARGE', 502)
      }
      chunks.push(Buffer.from(value))
    }
  } finally {
    reader.releaseLock?.()
  }
  return Buffer.concat(chunks, size).toString('utf8')
}

function recordTokenUsage(provider, data, state) {
  const usage = data?.usage || {}
  const input = provider === 'glm' ? usage.prompt_tokens : usage.input_tokens
  const output = provider === 'glm' ? usage.completion_tokens : usage.output_tokens
  if (Number.isSafeInteger(input) && input >= 0) state.inputTokens += input
  else state.inputKnown = false
  if (Number.isSafeInteger(output) && output >= 0) state.outputTokens += output
  else state.outputKnown = false
}

function parseModelResponse(provider, data) {
  if (provider === 'glm') {
    const choice = data?.choices?.[0]
    if (!choice || choice.finish_reason !== 'stop' || choice.message?.tool_calls?.length || choice.message?.function_call) {
      throw safeError('DIRECT_MODEL_INCOMPLETE', 502)
    }
    if (typeof choice.message?.content !== 'string') throw safeError('DIRECT_MODEL_INVALID_OUTPUT', 502)
    return choice.message.content
  }
  if (data?.stop_reason !== 'end_turn' || !Array.isArray(data.content) ||
      data.content.some(block => !['text', 'thinking', 'redacted_thinking'].includes(block?.type))) {
    throw safeError('DIRECT_MODEL_INCOMPLETE', 502)
  }
  const text = data.content.filter(block => block.type === 'text')
  if (!text.length || text.some(block => typeof block.text !== 'string')) throw safeError('DIRECT_MODEL_INVALID_OUTPUT', 502)
  // Thinking blocks are protocol metadata, never part of the returned answer.
  return text.map(block => block.text).join('')
}

function toJsonText(text, key) {
  if (Buffer.byteLength(text, 'utf8') > MAX_TEXT_BYTES) throw safeError('DIRECT_MODEL_OUTPUT_TOO_LARGE', 502)
  if (text.includes(key)) throw safeError('DIRECT_MODEL_OUTPUT_CONTAINS_SECRET', 502)
  const fence = /^\s*```json\s*\r?\n([\s\S]*?)\r?\n```\s*$/i.exec(text)
  if (fence) text = fence[1]
  let parsed
  try { parsed = JSON.parse(text) } catch { throw safeError('DIRECT_MODEL_INVALID_OUTPUT', 502) }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw safeError('DIRECT_MODEL_INVALID_OUTPUT', 502)
  if (Object.keys(parsed).length === 1 && Object.hasOwn(parsed, 'answer') && parsed.answer && typeof parsed.answer === 'object' && !Array.isArray(parsed.answer)) {
    parsed = parsed.answer
  }
  const serialized = JSON.stringify(parsed)
  if (serialized.includes(key)) throw safeError('DIRECT_MODEL_OUTPUT_CONTAINS_SECRET', 502)
  if (Buffer.byteLength(serialized, 'utf8') > MAX_TEXT_BYTES) throw safeError('DIRECT_MODEL_OUTPUT_TOO_LARGE', 502)
  return serialized
}

/** Build a direct, bounded agent for the two explicitly supported official APIs. */
export async function createDirectModelAgent(config, { fetchImpl = globalThis.fetch, env = process.env } = {}) {
  const effective = validateConfig(config)
  if (typeof fetchImpl !== 'function') throw safeError('DIRECT_MODEL_CONFIG_INVALID', 400)
  const key = await resolveKey(effective, env)
  const usage = { calls: 0, failures: 0, inputTokens: 0, outputTokens: 0, inputKnown: true, outputKnown: true }
  const agent = async ({ prompt, provider = effective.provider, model = effective.model, signal } = {}) => {
    if (provider !== effective.provider || model !== effective.model) throw safeError('DIRECT_MODEL_ROUTE_MISMATCH', 409)
    if (typeof prompt !== 'string' || !prompt.trim() || Buffer.byteLength(prompt, 'utf8') > MAX_PROMPT_BYTES) throw safeError('DIRECT_MODEL_PROMPT_INVALID', 413)
    if (signal?.aborted) throw safeError('DIRECT_MODEL_ABORTED', 499)
    if (usage.calls >= effective.maxCalls) throw safeError('DIRECT_MODEL_BUDGET_EXHAUSTED', 429)
    usage.calls++
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), effective.timeoutMs)
    timer.unref?.()
    const requestSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
    let response, usageReceived = false
    try {
      const headers = effective.provider === 'glm'
        ? { authorization: `Bearer ${key}`, 'content-type': 'application/json', 'user-agent': USER_AGENT }
        : { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json', 'user-agent': USER_AGENT }
      const reasoning = { ...(effective.thinking === 'default' ? {} : { thinking: { type: effective.thinking } }),
        ...(effective.reasoningEffort !== undefined ? { reasoning_effort: effective.reasoningEffort } : {}) }
      const body = effective.provider === 'glm'
        ? { model, messages: [{ role: 'user', content: prompt }], max_tokens: effective.maxOutputTokens, stream: false, ...reasoning, response_format: { type: 'json_object' } }
        : { model, max_tokens: effective.maxOutputTokens, messages: [{ role: 'user', content: prompt }], stream: false, ...reasoning }
      response = await fetchImpl(ENDPOINTS[effective.provider], { method: 'POST', headers, body: JSON.stringify(body), signal: requestSignal, redirect: 'manual' })
      if (response.status >= 300 && response.status < 400) throw safeError('DIRECT_MODEL_REDIRECT_REFUSED', response.status)
      if (!response.ok) throw safeError('DIRECT_MODEL_HTTP_ERROR', response.status)
      const raw = await readBounded(response)
      if (requestSignal.aborted) throw safeError('DIRECT_MODEL_ABORTED', 499)
      let data
      try { data = JSON.parse(raw) } catch { throw safeError('DIRECT_MODEL_INVALID_RESPONSE', 502) }
      usageReceived = true
      recordTokenUsage(effective.provider, data, usage)
      const result = toJsonText(parseModelResponse(effective.provider, data), key)
      if (requestSignal.aborted) throw safeError('DIRECT_MODEL_ABORTED', 499)
      return result
    } catch (error) {
      usage.failures++
      if (!usageReceived) { usage.inputKnown = false; usage.outputKnown = false }
      if (error?.code?.startsWith('DIRECT_MODEL_')) throw error
      if (signal?.aborted || requestSignal.aborted) throw safeError('DIRECT_MODEL_ABORTED', 499)
      throw safeError('DIRECT_MODEL_NETWORK_ERROR', 503)
    } finally {
      clearTimeout(timer)
      if (response?.body && !response.bodyUsed) await response.body.cancel().catch(() => {})
    }
  }
  agent.model = { provider: effective.provider, model: effective.model }
  agent.usage = () => ({ calls: usage.calls, input_tokens: usage.inputKnown ? usage.inputTokens : null,
    output_tokens: usage.outputKnown ? usage.outputTokens : null, failures: usage.failures })
  return agent
}
