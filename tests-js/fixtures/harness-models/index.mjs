import { LlmAdapter } from '@deepseek-ai/dsh-llm'

export const name = 'paper-library-harness-model-fixture'
export const inject = ['llm']
const routes = {
  'paper-library-qa-a': { id: 'reader-a', name: 'QA Reader A' },
  'paper-library-qa-b': { id: 'reader-b', name: 'QA Reader B' },
}

class SelectionOnlyAdapter extends LlmAdapter {
  providerInfo(provider) { return { id: provider, name: provider.endsWith('-a') ? 'Paper Library QA A' : 'Paper Library QA B' } }
  async listModels(provider) { return [{ provider, ...routes[provider] }] }
  async resolveModel(provider, model) {
    return { provider, id: model, name: routes[provider].name, context: { contextWindow: 32768 }, inputModalities: ['text'], reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'low' } }
  }
  async * stream() { throw new Error('Selection-only UI fixture: model generation is deliberately unavailable; no external request was made') }
}

export function apply(ctx) {
  ctx.effect(() => ctx.llm.registerAdapter(Object.keys(routes), new SelectionOnlyAdapter()), 'paper-library: selection-only QA routes')
}
