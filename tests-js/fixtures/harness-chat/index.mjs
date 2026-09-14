import { LlmAdapter } from '@deepseek-ai/dsh-llm'

export const name = 'paper-library-native-chat-fixture'
export const inject = ['llm', 'webServer', 'connection', 'sessions', 'agents']
export const PROVIDER = 'paper-library-native-chat-fixture'
export const MODEL = 'deterministic-reader'
export const REPLY = 'Synthetic reading reply: the saved annotation is on PDF page 2. This fixture makes no scientific claim.'

/** Deterministic model adapter: no provider SDK, credential access, network or tool calls. */
class ReadingAdapter extends LlmAdapter {
  constructor(observation) { super(); this.observation = observation }
  providerInfo() { return { id: PROVIDER, name: 'Paper Library Native Chat Fixture' } }
  async listModels() { return [{ provider: PROVIDER, id: MODEL, name: 'Deterministic Reader' }] }
  async resolveModel(provider, model) {
    if (provider !== PROVIDER || model !== MODEL) throw new Error('Only the keyless reading fixture model is supported')
    return { provider, id: model, name: 'Deterministic Reader', context: { contextWindow: 32768 }, inputModalities: ['text'] }
  }
  async * stream(options) {
    options.signal?.throwIfAborted()
    this.observation.generations++
    this.observation.references = options.messages.filter(message => message.source?.plugin === 'Paper Library' && message.source.paperLibraryReference).map(message => ({
      snapshotId: message.source.paperLibraryReference.snapshot_id,
      text: message.content.filter(block => block.type === 'text').map(block => block.text).join('\n').slice(0, 4000),
    })).slice(-8)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: REPLY }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: REPLY } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** Test-only authenticated booleans make cold lifecycle assertions independent from plugin receipts. */
export function apply(ctx) {
  const observation = { generations: 0, references: [] }
  ctx.effect(() => ctx.llm.registerAdapter([PROVIDER], new ReadingAdapter(observation)), 'paper-library: deterministic test model')
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix', path: '/api/paper-chat-fixture', handler(req, res) {
      const rejection = ctx.connection.requestRejection(req)
      if (rejection !== undefined) { res.writeHead(rejection); res.end(); return }
      const url = new URL(req.url, 'http://127.0.0.1')
      const ids = url.searchParams.getAll('session')
      if (req.method !== 'GET' || ids.length > 12 || ids.some(id => !/^paper-library-[a-f0-9]{40}$/.test(id))) { res.writeHead(400); res.end(); return }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ generations: observation.generations, references: observation.references, observations: ids.map(id => ({ sessionLoaded: Boolean(ctx.sessions.get(id)), agentLoaded: Boolean(ctx.agents.get(id)) })) }))
    },
  }), 'paper-library: cold-session fixture observations')
}
