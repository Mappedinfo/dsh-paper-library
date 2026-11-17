import test from 'node:test'
import assert from 'node:assert/strict'
import { createDeepSeekPublicResearch, projectDeepSeekResearch, publicResearchURL } from '../src/harness/deepseek-public-research.mjs'

const link = 'https://example.edu/public/concept'
const evidence = 'A synthetic research concept.'
const cited = (url, text = '一个合成研究概念。') => ({
  type: 'text', text, citations: [{ type: 'web_search_result_location', url, cited_text: 'Provider answer, not source text' }],
})
const message = content => ({ stop_reason: 'end_turn', content })
const search = [
  { type: 'server_tool_use', id: 'search', name: 'deepseek_web_search', input: { action: 'search' } },
  { type: 'web_search_tool_result', tool_use_id: 'search', content: [
    { type: 'web_search_result', url: link, title: 'Public concept', snippet: evidence, encrypted_content: 'opaque' },
  ] },
]
function open(mode, url = link) {
  return [
    { type: 'server_tool_use', id: 'open', name: mode === 'link' ? 'deepseek_read_url' : 'deepseek_web_search',
      input: { action: mode === 'link' ? 'read_link' : 'open_page', url } },
    { type: 'web_fetch_tool_result', tool_use_id: 'open', ...(mode === 'link' ? { signature: 'opaque' } : {}),
      content: { type: 'web_fetch_result', url, content: { type: 'document', title: 'Public concept' } } },
  ]
}

test('all research modes use the documented request and return attributable citations', async () => {
  for (const [mode, tool, blocks] of [
    ['standard', 'deepseek_web_search', search],
    ['deep', 'deepseek_web_search', [...search, ...open('deep')]],
    ['link', 'deepseek_read_url', open('link')],
  ]) {
    const run = createDeepSeekPublicResearch({ resolveKey: async () => 'synthetic-key',
      fetch: async (url, init) => {
        assert.equal(url, 'https://api.deepseek.com/anthropic/v1/messages')
        assert.equal(init.headers['x-api-key'], 'synthetic-key')
        assert.equal(init.redirect, 'error')
        const body = JSON.parse(init.body)
        assert.deepEqual(body.tools, [{ type: tool, name: tool }])
        assert.equal(body.model, 'deepseek-flash')
        assert.equal(body.thinking.type, mode === 'deep' ? 'enabled' : 'disabled')
        assert.match(body.messages[0].content, /Synthetic research/)
        assert.equal(body.messages[0].content.includes(link), mode === 'link')
        return Response.json(message([...blocks, cited(link)]))
      } })
    const result = await run({ query: 'Synthetic research', mode, link: mode === 'link' ? link : '', signal: AbortSignal.timeout(1000) })
    assert.equal(result.status, 'explained')
    assert.deepEqual(result.explanation.definition.citations, [1])
    assert.equal(result.explanation.sources[0].evidence, mode === 'standard' ? 'snippet' : 'webpage')
    assert.equal(result.explanation.sources[0].excerpt, mode === 'link' ? '' : evidence)
    assert.doesNotMatch(JSON.stringify(result), /opaque|Provider answer/)
  }
})

test('unsupported or unpaired citations do not turn a search into an explanation', () => {
  const result = projectDeepSeekResearch(message([...search, cited('https://example.edu/unsupported')]), { mode: 'standard' })
  assert.equal(result.status, 'insufficient')
  assert.equal(result.sources[0].url, link)
  const differentURL = 'https://example.edu/wrong-source'
  const wrongPage = projectDeepSeekResearch(message([...open('link', differentURL), cited(differentURL)]), { mode: 'link', link })
  assert.deepEqual(wrongPage, { status: 'insufficient', sources: [] })
  assert.equal(projectDeepSeekResearch(message([search[1], cited(link)]), { mode: 'standard' }).status, 'insufficient')
  assert.equal(projectDeepSeekResearch({ ...message([...search, cited(link)]), stop_reason: 'max_tokens' }, { mode: 'standard' }).status, 'generation_failed')
})

test('reading one confirmed link can save an explanation with a page source when no inline citation is returned', () => {
  const result = projectDeepSeekResearch(message([...open('link'), { type: 'text', text: '释义：一个合成研究概念。' }]), { mode: 'link', link })
  assert.equal(result.status, 'explained')
  assert.equal(result.explanation.link_summary, true)
  assert.deepEqual(result.explanation.definition, { text: '一个合成研究概念。', citations: [] })
  assert.equal(result.explanation.sources[0].url, link)
  const insufficient = projectDeepSeekResearch(message([...open('link'), { type: 'text', text: 'INSUFFICIENT' }]), { mode: 'link', link })
  assert.equal(insufficient.status, 'insufficient')
})

test('missing credentials skip network, provider errors have bounded public status', async () => {
  const input = { mode: 'deep', query: 'Synthetic search', signal: AbortSignal.timeout(1000) }
  const run = createDeepSeekPublicResearch({ resolveKey: async () => undefined, fetch: () => assert.fail('Unexpected request') })
  assert.deepEqual(await run(input), { status: 'unavailable', reason: 'missing_key', sources: [] })
  const throttled = createDeepSeekPublicResearch({ resolveKey: async () => 'test', fetch: async () => new Response('private upstream detail', { status: 429 }) })
  assert.deepEqual(await throttled(input), { status: 'unavailable', reason: 'rate_limited', sources: [] })
  for (const url of ['file:///private/doc', 'https://127.0.0.1/', 'https://[::1]/', 'https://host.local/doc', 'https://login@example.edu/doc']) {
    assert.equal(publicResearchURL(url), '')
  }
})
