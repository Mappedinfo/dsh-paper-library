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
export function createHarnessAI(llm, createUserMessage, config) {
  return async ({ prompt, provider = config.provider, model = config.model, reasoningEffort, signal }) => {
    if (!provider || !model) throw new Error('Select a configured Harness provider and model before requesting AI feedback')
    if (reasoningEffort !== undefined && (typeof reasoningEffort !== 'string' || !reasoningEffort.trim())) throw new Error('reasoningEffort must be a non-empty configured model effort')
    await llm.resolveModelInfo(provider, model, signal)
    const message = createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: 'plugin', plugin: 'paper-library' } })
    return collectFeedback(llm.stream({ provider, model, messages: [message], maxTokens: config.maxOutputTokens, signal, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) }), signal)
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
