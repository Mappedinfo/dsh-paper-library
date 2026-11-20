// 使用本机 DSH 的公开消息工厂与组装器，仅传合成材料，不加载宿主配置或凭据。
import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
import { resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { createHarnessToolAI } from '../src/harness/tool-ai.mjs'
const checkout = resolve(process.env.DSH_CHECKOUT || fileURLToPath(new URL('../../../deepseek-ai/deepseek-harness', import.meta.url)))
const llm = await import(pathToFileURL(resolve(checkout, 'packages/llm/llm/lib/index.js')))
const tools = await import(pathToFileURL(resolve(checkout, 'packages/core/tools/lib/index.js')))
const scope = new AsyncLocalStorage(), sent = []
const route = { provider: 'synthetic', model: 'synthetic-writer', maxOutputTokens: 1024 }
let reads = 0
const host = {
  async prepareCall(config) {
    assert.equal(scope.getStore(), 'writing')
    return { config, async *stream(options) {
      assert.equal(scope.getStore(), 'writing'); sent.push(options)
      if (sent.length === 1) {
        yield { type: 'finish', reason: { kind: 'error', failure: { code: 'NETWORK', status: 503, message: 'synthetic disconnect' } } }; return
      }
      const results = options.messages.filter(message => message.role === 'tool')
      if (!results.length) {
        const id = llm.ToolCallId('synthetic-read')
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index: 0, id, name: 'read_project_file', argumentsDelta: '{"path":"' }
        yield { type: 'tool-call-delta', index: 0, id, argumentsDelta: 'main.tex"}' }
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'read_project_file', arguments: '{"path":"main.tex"}' } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }; return
      }
      assert.equal(results[0].toolCallId, 'synthetic-read')
      assert.equal(JSON.parse(results[0].content[0].text).source_id, 'F1')
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: '合成写作核对 [F1]。' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: '合成写作核对 [F1]。' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } }
  },
}
const generate = createHarnessToolAI(host, { ...llm, ...tools }, route, { network: { run: callback => scope.run('writing', callback) } })
const result = await generate({ prompt: '请核对合成文件，不讨论真实论文。', requireToolUse: true,
  tools: [{ name: 'read_project_file', description: '只读合成项目文件。', parameters: { type: 'object', additionalProperties: false, required: ['path'], properties: { path: { type: 'string' } } } }],
  executeTool(name, args) { assert.equal(name, 'read_project_file'); assert.deepEqual(args, { path: 'main.tex' }); reads++; return { ok: true, source_id: 'F1', content: 'Synthetic text only.' } },
})
assert.equal(result.text, '合成写作核对 [F1]。'); assert.equal(result.usedTools, true)
assert.equal(result.retries, 1); assert.equal(reads, 1); assert.equal(sent.length, 3)
assert.equal(scope.getStore(), undefined)
console.log(JSON.stringify({ nativeProtocol: 'passed', turns: sent.length, retries: result.retries, reads, providerRequests: 0 }))
