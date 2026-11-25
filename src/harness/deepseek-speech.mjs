import { awaitWithAbort } from './ai.mjs'

const ENDPOINT = 'https://api.deepseek.com/v1/tools/tts'
const MAX_AUDIO_BYTES = 24 * 1024 * 1024
const fail = (message, status) => Object.assign(new Error(message), { status })
export const DEFAULT_SPEECH_VOICE = 'stella'
export const isSpeechVoice = value => value === DEFAULT_SPEECH_VOICE || value === 'tide'

export function createDeepSeekSpeech({ resolveKey, resolveVoice = () => DEFAULT_SPEECH_VOICE, fetch = globalThis.fetch }) {
  return async (input, callerSignal) => {
    const text = typeof input === 'string' ? input.trim() : ''
    if (!text || text.length > 2000) throw fail('朗读内容须为 1–2000 个字符。', 400)

    const timeout = AbortSignal.timeout(60_000)
    const signal = callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout
    try {
      signal.throwIfAborted()
      const key = (await awaitWithAbort(resolveKey(), signal))?.trim()
      if (!key || /\s/u.test(key)) throw fail('请在 DSH 配置 DEEPSEEK_API_KEY 后使用 DeepSeek 朗读。', 409)
      const voice = await awaitWithAbort(resolveVoice(), signal)
      const response = await fetch(ENDPOINT, {
        method: 'POST', redirect: 'error', signal,
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ text, voice_id: isSpeechVoice(voice) ? voice : DEFAULT_SPEECH_VOICE, format: 'wav', filter_markdown: false }),
      })
      if (!response.ok || !response.headers.get('content-type')?.toLowerCase().startsWith('audio/wav') ||
          Number(response.headers.get('content-length')) > MAX_AUDIO_BYTES || !response.body) {
        void response.body?.cancel().catch(() => {})
        if ([401, 403].includes(response.status)) throw fail('DeepSeek 朗读认证失败，请检查 API Key。', 502)
        if (response.status === 402) throw fail('DeepSeek 账户余额不足。', 402)
        if (response.status === 400) throw fail('DeepSeek 无法朗读这段文字。', 422)
        if (response.status === 429 || response.status === 503) throw fail('DeepSeek 朗读服务繁忙，请稍后再试。', 503)
        if (response.status === 504) throw fail('DeepSeek 朗读超时，请稍后再试。', 504)
        throw fail('DeepSeek 未返回有效的语音。', 502)
      }
      const chunks = []
      let size = 0
      for await (const chunk of response.body) {
        size += chunk.byteLength
        if (size > MAX_AUDIO_BYTES) throw fail('DeepSeek 返回的语音超出大小限制。', 502)
        chunks.push(chunk)
      }
      const audio = Buffer.concat(chunks, size)
      if (audio.length <= 44 || audio.toString('ascii', 0, 4) !== 'RIFF' || audio.toString('ascii', 8, 12) !== 'WAVE') {
        throw fail('DeepSeek 未返回有效的 WAV 语音。', 502)
      }
      return audio
    } catch (error) {
      callerSignal?.throwIfAborted()
      if (timeout.aborted) throw fail('DeepSeek 朗读超时，请稍后再试。', 504)
      if (error.status) throw error
      throw fail('无法连接 DeepSeek 朗读服务，请检查模型网络设置。', 502)
    }
  }
}
