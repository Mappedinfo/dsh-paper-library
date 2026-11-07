import { createHash, randomUUID } from 'node:crypto'
import { resolveTranslationTarget } from './language-learning.mjs'

/** 按批注版本翻译；模型结果可重用，PDF 写回失败时不重复生成。 */
export function createAnnotationTranslation({ store, languageLearning, dispatch, library, python }) {
  const flights = new Map()
  return async (input, { signal } = {}) => {
    if (!/^[A-Za-z0-9_-]{1,160}$/.test(input.id || '') || typeof input.annotation_id !== 'string' || !input.annotation_id || input.annotation_id.length > 160 || !/^[a-f0-9]{64}$/.test(input.version || '')) throw new Error('请刷新批注后再翻译。')
    const ref = { id: input.annotation_id, version: input.version }
    const worker = extra => dispatch({ action: 'annotation_translation_result', id: input.id, annotation_ref: ref, ...extra }, { library, python, signal })
    const context = await dispatch({ action: 'annotation_context_exact', id: input.id, annotation_refs: [ref], max_characters: 8000 }, { library, python, signal })
    const note = context.annotations[0]
    const text = [...new Set([note.text, note.comment, note.handwriting?.transcript, note.linked_ink?.transcript].filter(x => typeof x === 'string' && x.trim()).map(x => x.trim()))].join('\n\n')
    if (!text || text.length > 8000) throw new Error('批注需要 1–8000 字符的文字；不会截断翻译。')
    const settings = await languageLearning({ action: 'language_settings_get' }, { signal })
    const target = resolveTranslationTarget(text, settings.value.target_language)
    const key = createHash('sha256').update(JSON.stringify([input.id, ref, target])).digest('hex')
    if (flights.has(key)) return flights.get(key)
    const run = async () => {
      const existing = await worker({ request_key: key })
      if (existing.saved) return existing
      const stateKey = `annotation.translation:${key}`
      let attempt = await store.get(stateKey)
      if (!attempt.value) attempt = await store.put(stateKey, { request_id: `annotation-translation:${key}` }, attempt.revision)
      const request = request_id => ({ action: 'language_generate', id: input.id, mode: 'translate', text, page: note.page, target_language: target, request_id })
      let result
      try { result = await languageLearning(request(attempt.value.request_id), { signal }) }
      catch (error) {
        // 此次点击只重试已确认失败的旧请求；本次刚失败或状态未知时不连发。
        if (error.code !== 'LANGUAGE_FAILED' || error.replayed !== true) throw error
        attempt = await store.put(stateKey, { request_id: `annotation-translation:${randomUUID()}` }, attempt.revision)
        result = await languageLearning(request(attempt.value.request_id), { signal })
      }
      return worker({ request_key: key, text: result.result, model: `${result.model.provider}/${result.model.model}` })
    }
    const promise = run(); flights.set(key, promise)
    try { return await promise } finally { flights.delete(key) }
  }
}
