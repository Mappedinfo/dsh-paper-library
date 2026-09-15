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
    const prompt = options.messages.flatMap(message => message.content.filter(block => block.type === 'text').map(block => block.text)).join('\n')
    let reply = REPLY
    if (prompt.includes('LIBRARY_KNOWLEDGE_JSON:\n')) {
      const selected = JSON.parse(prompt.slice(prompt.lastIndexOf('LIBRARY_KNOWLEDGE_JSON:\n') + 'LIBRARY_KNOWLEDGE_JSON:\n'.length))
      const source = selected.sources[0]
      reply = JSON.stringify({ title: 'Synthetic dataset knowledge', body: `# Synthetic dataset\n\n${source.text}\n\nSource: [${source.id}]\n\nThis is a deterministic integration fixture, not a scientific assessment.`, nodes: [], edges: [], assertions: [] })
      if (selected.mode === 'graph') reply = JSON.stringify({ title:'Synthetic typed graph', body:'Synthetic relationships for integration testing.', nodes:[{id:'source-excerpt',type:'evidence',label:'Selected source',source_id:source.id,quote:source.text},{id:'reported-count',type:'observation',label:'The selected source reports twelve example trips',source_node:'evidence:source-excerpt'},{id:'bounded-claim',type:'claim',label:'This synthetic release reports twelve trips'}], edges:[{subject:'observation:reported-count',object:`${selected.entity.kind}:${selected.entity.id}`,relation:'observed_on',source_id:source.id,surface:'Selected synthetic release only'}], assertions:[{subject:'observation:reported-count',object:'claim:bounded-claim',relation:'supports',surface:'Source-reported synthetic count only'}] })
      this.observation.knowledge = [...this.observation.knowledge, { provider: options.provider, model: options.model, maxTokens: options.maxTokens, mode: selected.mode, sourceIds: selected.sources.map(item => item.id), sourceTexts: selected.sources.map(item => item.text) }].slice(-8)
    }
    if (prompt.includes('SOURCE_JSON:\n')) {
      const source = JSON.parse(prompt.slice(prompt.lastIndexOf('SOURCE_JSON:\n') + 'SOURCE_JSON:\n'.length)).text
      const polish = prompt.includes('ORIGINAL LANGUAGE')
      reply = JSON.stringify({ result: polish ? source : '合成翻译：该估计仍存在认识不确定性。', explanation: 'Synthetic deterministic language fixture; no model-quality claim.', vocabulary: /\bEpistemic\b/i.test(source) ? [{ term: 'Epistemic', meaning: '认识上的；有关知识的', source_sentence: source }] : [] })
      this.observation.language = [...this.observation.language, { provider: options.provider, model: options.model, maxTokens: options.maxTokens, mode: polish ? 'polish' : 'translate' }].slice(-8)
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: reply }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** Test-only authenticated booleans make cold lifecycle assertions independent from plugin receipts. */
export function apply(ctx) {
  const observation = { generations: 0, references: [], language: [], knowledge: [] }
  ctx.effect(() => ctx.llm.registerAdapter([PROVIDER], new ReadingAdapter(observation)), 'paper-library: deterministic test model')
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix', path: '/api/paper-chat-fixture', handler(req, res) {
      const rejection = ctx.connection.requestRejection(req)
      if (rejection !== undefined) { res.writeHead(rejection); res.end(); return }
      const url = new URL(req.url, 'http://127.0.0.1')
      const ids = url.searchParams.getAll('session')
      if (req.method !== 'GET' || ids.length > 12 || ids.some(id => !/^paper-library-[a-f0-9]{40}$/.test(id))) { res.writeHead(400); res.end(); return }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ generations: observation.generations, references: observation.references, language: observation.language, knowledge: observation.knowledge, observations: ids.map(id => ({ sessionLoaded: Boolean(ctx.sessions.get(id)), agentLoaded: Boolean(ctx.agents.get(id)) })) }))
    },
  }), 'paper-library: cold-session fixture observations')
}
