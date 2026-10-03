/** Collect a complete plain-text response; partial/error streams are never saved. */
export async function collectFeedback(chunks, signal) {
  const text = []
  let terminal
  for await (const chunk of chunks) {
    signal?.throwIfAborted()
    if (chunk.type === 'block-end' && chunk.block.type === 'text') text.push(chunk.block.text)
    if (chunk.type === 'finish') terminal = chunk.reason
  }
  if (!terminal) throw new Error('AI feedback stream ended without a finish event')
  if (terminal.kind !== 'stop') throw new Error(`AI feedback did not complete (${terminal.kind}): ${terminal.failure?.message ?? 'retry with a complete response'}`)
  const answer = text.join('').trim()
  if (!answer) throw new Error('AI feedback returned no text')
  if (answer.length > 100_000) throw new Error('AI feedback exceeds the supported response length')
  return answer
}

/** Reuse Harness provider services without reading or retaining credentials. */
export function createHarnessAI(llm, createUserMessage, config, { attachments } = {}) {
  return async ({ prompt, provider = config.provider, model = config.model, reasoningEffort, signal, images }) => {
    if (!provider || !model) throw new Error('Select a configured Harness provider and model before requesting AI feedback')
    if (reasoningEffort !== undefined && (typeof reasoningEffort !== 'string' || !reasoningEffort.trim())) throw new Error('reasoningEffort must be a non-empty configured model effort')
    const call = { provider, model, maxTokens: config.maxOutputTokens, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) }
    // Prepared calls bind the image capability check to the exact adapter
    // generation that receives the image, even during host model hot-reloads.
    const prepared = images !== undefined && typeof llm.prepareCall === 'function' ? await llm.prepareCall(call, signal) : null
    const info = prepared || await llm.resolveModelInfo(provider, model, signal)
    let content = [{ type: 'text', text: prompt }]
    if (images !== undefined) {
      const fail = (message, code) => Object.assign(new Error(message), { code, status: 409 })
      if (!Array.isArray(images) || images.length !== 1 || images.some(image => !image || image.mediaType !== 'image/png' || typeof image.data !== 'string' || image.data.length > 2_796_204)) throw fail('手写识别需要一张不超过 2 MiB 的 PNG 图片。', 'AI_IMAGE_INVALID')
      // Current Harness text-only routes replace images with placeholder text.
      // Refuse that fallback here: a plausible transcript without seeing the
      // handwriting would be worse than an explicit capability error.
      if (!Array.isArray(info?.inputModalities)) throw fail('当前 DSH 模型没有声明图像输入能力，请选择明确支持图像的模型后识别。', 'AI_IMAGE_CAPABILITY_UNKNOWN')
      if (!info.inputModalities.includes('image')) throw fail('当前 DSH 模型不支持图像输入，请在论文对话中选择视觉模型后识别。', 'AI_IMAGE_MODEL_UNSUPPORTED')
      if (!prepared) throw fail('当前 DSH 版本未提供可核实图像能力的调用接口，请更新 DSH 后识别。', 'AI_IMAGE_RUNTIME_REQUIRED')
      let service
      try { service = typeof attachments === 'function' ? attachments() : attachments } catch { /* Optional Harness service may not be mounted. */ }
      if (typeof service?.admitPromptContent !== 'function') throw fail('当前 DSH 没有可用的图像附件服务；手写原稿仍保留，可稍后识别。', 'AI_IMAGE_SERVICE_REQUIRED')
      signal?.throwIfAborted()
      // Public Harness admission fully decodes and validates the PNG, stores
      // immutable bytes, and returns the native image attachment reference.
      // No credential, filesystem attachment path, or provider-specific shape
      // is accepted from a request.
      content = await service.admitPromptContent([...content, { type: 'image', mediaType: 'image/png', data: images[0].data, name: 'handwriting.png' }])
      signal?.throwIfAborted()
    }
    const message = createUserMessage({ content, source: { kind: 'plugin', plugin: 'paper-library' } })
    const options = { ...(prepared?.config || call), messages: [message], signal }
    return collectFeedback(prepared ? prepared.stream(options) : llm.stream(options), signal)
  }
}

/** Return bounded, keyless route metadata for the library's model selector. */
export async function discoverModels(llm, signal) {
  const providers = []
  for (const provider of llm.listProviders().slice(0, 30)) {
    signal?.throwIfAborted()
    try {
      const models = await llm.listModels(provider.id)
      providers.push({ id: provider.id, name: provider.name ?? provider.id, models: models.slice(0, 100).map(model => ({ id: model.id, name: model.name ?? model.id })) })
    } catch (error) {
      providers.push({ id: provider.id, name: provider.name ?? provider.id, models: [], error: error instanceof Error ? error.message : String(error) })
    }
  }
  return { providers, models: providers.flatMap(provider => provider.models.map(model => ({ ...model, provider: provider.id }))), configured: providers.some(provider => provider.models.length > 0) }
}
