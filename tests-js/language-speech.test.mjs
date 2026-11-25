import assert from 'node:assert/strict'
import test from 'node:test'
import { createDeepSeekSpeech } from '../src/harness/deepseek-speech.mjs'
import { createFetchHandler } from '../src/http.mjs'

function speechRequest(text, origin) {
  return new Request('http://localhost/api/paper-library/language-speech', {
    method: 'POST', headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) },
    body: JSON.stringify({ text, paperId: 'must not be sent', voice_id: 'must not be sent' }),
  })
}

test('the DSH speech route forwards only text and returns WAV without caching', async () => {
  const wave = Buffer.alloc(46)
  wave.write('RIFF', 0)
  wave.write('WAVE', 8)
  const languageSpeech = createDeepSeekSpeech({
    resolveKey: async () => 'synthetic-key',
    async fetch(url, input) {
      assert.equal(url, 'https://api.deepseek.com/v1/tools/tts')
      assert.equal(input.redirect, 'error')
      assert.equal(input.headers.authorization, 'Bearer synthetic-key')
      assert.deepEqual(JSON.parse(input.body), { text: 'A synthetic term.', format: 'wav', filter_markdown: false })
      return new Response(wave, { headers: { 'content-type': 'audio/wav' } })
    },
  })
  const handle = createFetchHandler({ basePath: '/api/paper-library', languageSpeech })
  const response = await handle(speechRequest('A synthetic term.'))
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'audio/wav')
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), wave)
  assert.equal((await handle(speechRequest('A synthetic term.', 'https://other.example'))).status, 403)
  assert.equal((await handle(speechRequest('x'.repeat(2001)))).status, 400)
  const page = await handle(new Request('http://localhost/api/paper-library/'))
  assert.match(page.headers.get('content-security-policy'), /media-src 'self' blob:/)
})

test('speech reports missing credentials and provider failures without relaying response bodies', async () => {
  const text = 'Synthetic source sentence.'
  const withoutKey = createDeepSeekSpeech({ resolveKey: () => null, fetch: assert.fail })
  await assert.rejects(withoutKey(text), { status: 409 })

  for (const [upstream, expected] of [[401, 502], [429, 503], [200, 502]]) {
    const speak = createDeepSeekSpeech({ resolveKey: () => 'synthetic-key',
      fetch: async () => new Response('private provider diagnostics', { status: upstream, headers: { 'content-type': 'audio/wav' } }) })
    await assert.rejects(speak(text), error => error.status === expected && !error.message.includes('private provider diagnostics'))
  }
})
