import test from 'node:test'
import assert from 'node:assert/strict'
import { createScholarlySearch, SCHOLARLY_SEARCH_LIMITS } from '../src/harness/scholarly-search.mjs'

const atom = entries => `<feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom">${entries}</feed>`
const entry = (id = '2601.00001v1', extra = '') => `<entry><id>http://arxiv.org/abs/${id}</id><title>Synthetic graph methods</title><published>2026-01-02T00:00:00Z</published><author><name>Alice Example</name></author><summary>A synthetic abstract for a bounded metadata test.</summary>${extra}</entry>`
const crossref = items => new Response(JSON.stringify({ status: 'ok', message: { items } }), { headers: { 'content-type': 'application/json' } })
const arxiv = entries => new Response(atom(entries), { headers: { 'content-type': 'application/atom+xml' } })
const item = extra => ({ DOI: '10.1234/synthetic', title: ['Synthetic graph methods'], author: [{ given: 'Bob', family: 'Example' }], published: { 'date-parts': [[2025]] }, ...extra })
function provider(crossrefResult = () => crossref([]), arxivResult = () => arxiv('')) {
  const calls = []
  return { calls, search: createScholarlySearch({ fetch: async (url, init) => {
    calls.push({ url, init, time: Date.now() })
    assert.equal(init.redirect, 'manual')
    assert.equal(init.headers['Accept-Encoding'], 'identity')
    return url.hostname === 'api.crossref.org' ? crossrefResult(url, init) : arxivResult(url, init)
  } }) }
}

test('bounded scholarly results preserve explicit metadata, abstract scope, and canonical source URLs', async () => {
  const { search, calls } = provider(() => crossref([item({ abstract: '<jats:p>A &amp; B. <jats:italic>Synthetic evidence.</jats:italic></jats:p>', URL: 'http://127.0.0.1/private', link: [{ URL: 'https://attacker.invalid/full.pdf' }] })]), () => arxiv(entry()))
  const result = await search.search({ query: 'synthetic graph', limit: 3 })
  assert.equal(result.status, 'ok')
  assert.equal(result.results.length, 2)
  assert.deepEqual(result.results[0], {
    id: 'doi:10.1234/synthetic', provider: 'crossref', title: 'Synthetic graph methods', authors: ['Bob Example'], year: 2025,
    doi: '10.1234/synthetic', url: 'https://doi.org/10.1234/synthetic', abstract: 'A & B. Synthetic evidence.', abstract_truncated: false, evidence_level: 'abstract',
  })
  assert.equal(result.results[1].url, 'https://arxiv.org/abs/2601.00001v1')
  assert.equal(result.results[1].year, 2026)
  assert.deepEqual(result.results[1].authors, ['Alice Example'])
  assert.match(result.evidence_scope, /full text was not retrieved.*do not establish scholarly consensus/)
  assert.equal(calls.length, 2)
  assert.deepEqual(calls.map(call => call.url.origin).sort(), ['https://api.crossref.org', 'https://export.arxiv.org'])
  assert.equal(calls[0].url.searchParams.get('rows'), '3')
  assert.equal(calls[1].url.searchParams.get('search_query'), 'all:"synthetic" AND all:"graph"')
})

test('missing authors, date, or abstract remain absent and identical DOI alone permits deduplication', async () => {
  const { search } = provider(() => crossref([item({ author: undefined, published: undefined, created: { 'date-parts': [[2020]] }, abstract: undefined }), item({ DOI: '10.1234/other', title: ['Synthetic graph methods'] })]), () => arxiv(entry('2601.00002', '<arxiv:doi>10.1234/SYNTHETIC</arxiv:doi>')))
  const result = await search.search({ query: 'synthetic', limit: 5 })
  assert.equal(result.results.length, 2)
  assert.deepEqual(result.results[0].authors, [])
  assert.equal(result.results[0].year, null)
  assert.equal(result.results[0].abstract, null)
  assert.equal(result.results[0].evidence_level, 'metadata')
  assert.equal(result.results[1].doi, '10.1234/other')
})

test('successful empty search differs from failed and partially available providers', async () => {
  const empty = provider()
  assert.equal((await empty.search.search({ query: 'synthetic empty' })).status, 'empty')
  const partial = provider(() => crossref([]), () => new Response('unavailable', { status: 503 }))
  const result = await partial.search.search({ query: 'synthetic partial' })
  assert.equal(result.status, 'partial')
  assert.deepEqual(result.providers.map(value => value.status), ['empty', 'error'])
  assert.equal(result.providers[1].error.code, 'http_error')
  const unavailable = provider(() => { throw new Error('contains internal network detail') }, () => new Response('slow down', { status: 429 }))
  const failed = await unavailable.search.search({ query: 'synthetic unavailable' })
  assert.equal(failed.status, 'unavailable')
  assert.equal(failed.providers[0].error.message, 'Scholarly source could not be reached')
  assert.equal(failed.providers[1].error.code, 'rate_limited')
})

test('redirects are rejected without fetching their targets', async () => {
  const { search, calls } = provider(() => new Response('', { status: 302, headers: { location: 'http://127.0.0.1/private' } }), () => arxiv(''))
  const result = await search.search({ query: 'synthetic redirect' })
  assert.equal(result.status, 'partial')
  assert.equal(result.providers[0].error.code, 'redirect_rejected')
  assert.equal(calls.length, 2)
  assert.ok(calls.every(call => call.url.protocol === 'https:'))
})

test('invalid queries and result limits fail before any network request', async () => {
  const { search, calls } = provider()
  for (const query of ['', ' '.repeat(3), 'x'.repeat(201), 'synthetic\nprivate', '???', null]) {
    await assert.rejects(() => search.search({ query }), TypeError)
  }
  for (const limit of [0, 6, 1.5, '2', null]) await assert.rejects(() => search.search({ query: 'synthetic', limit }), TypeError)
  assert.equal(calls.length, 0)
})

test('metadata size is bounded both with and without a declared Content-Length', async () => {
  const { search } = provider(
    () => new Response('{}', { headers: { 'content-type': 'application/json', 'content-length': String(SCHOLARLY_SEARCH_LIMITS.responseBytes + 1) } }),
    () => new Response('x'.repeat(SCHOLARLY_SEARCH_LIMITS.responseBytes + 1), { headers: { 'content-type': 'application/atom+xml' } }),
  )
  const result = await search.search({ query: 'synthetic oversized' })
  assert.equal(result.status, 'unavailable')
  assert.ok(result.providers.every(value => value.error.code === 'response_too_large'))
})

test('malformed formats, XML entities, provider error entries, and foreign IDs are visible failures', async () => {
  const cases = [
    () => new Response('<!DOCTYPE feed [<!ENTITY x "no">]>' + atom(''), { headers: { 'content-type': 'application/atom+xml' } }),
    () => arxiv('<entry><id>http://arxiv.org/api/errors</id><title>Bad query</title></entry>'),
    () => arxiv('<entry><id>https://evil.invalid/abs/2601.00001</id><title>Foreign</title></entry>'),
  ]
  for (const response of cases) {
    const { search } = provider(() => new Response('not JSON', { headers: { 'content-type': 'application/json' } }), response)
    const result = await search.search({ query: 'synthetic invalid' })
    assert.equal(result.status, 'unavailable')
    assert.ok(result.providers.every(value => value.error.code === 'invalid_response'))
  }
})

test('abstract excerpts have explicit truncation and the total result limit is enforced across providers', async () => {
  const { search } = provider(() => crossref([item({ abstract: 'x'.repeat(1800) }), item({ DOI: '10.1234/second' })]), () => arxiv(entry('2601.00002') + entry('2601.00003')))
  const result = await search.search({ query: 'synthetic excerpt', limit: 2 })
  assert.equal(result.results.length, 2)
  assert.equal(result.results[0].abstract.length, SCHOLARLY_SEARCH_LIMITS.abstractCharacters)
  assert.equal(result.results[0].abstract_truncated, true)
  assert.deepEqual(result.results.map(value => value.provider), ['crossref', 'arxiv'])
})

test('cancellation interrupts stalled responses without retrying or waiting for the next arXiv slot', async () => {
  const controller = new AbortController()
  const { search, calls } = provider(() => new Response(new ReadableStream({ start() {}, cancel() {} }), { headers: { 'content-type': 'application/json' } }))
  const pending = search.search({ query: 'synthetic cancellation' }, { signal: controller.signal })
  await new Promise(resolve => setTimeout(resolve, 10))
  controller.abort(new Error('cancelled by synthetic test'))
  await assert.rejects(pending, /cancelled by synthetic test/)
  assert.ok(calls.length <= 2)
})

test('production transport rejects private or mixed DNS without opening a socket', async () => {
  const search = createScholarlySearch({ resolver: async () => [{ address: '127.0.0.1', family: 4 }, { address: '93.184.215.14', family: 4 }] })
  const result = await search.search({ query: 'synthetic dns' })
  assert.equal(result.status, 'unavailable')
  assert.ok(result.providers.every(value => value.error.code === 'unsafe_dns'))
})

test('arXiv starts stay at least three seconds apart and never overlap across factories', async () => {
  let active = 0
  let maxActive = 0
  const starts = []
  const fetch = async url => {
    if (url.hostname === 'api.crossref.org') return crossref([])
    starts.push(Date.now())
    active++
    maxActive = Math.max(maxActive, active)
    return new Response(new ReadableStream({
      async start(controller) {
        await new Promise(resolve => setTimeout(resolve, 20))
        controller.enqueue(new TextEncoder().encode(atom('')))
        controller.close()
        active--
      },
    }), { headers: { 'content-type': 'application/atom+xml' } })
  }
  const first = createScholarlySearch({ fetch })
  const second = createScholarlySearch({ fetch })
  await Promise.all([first.search({ query: 'synthetic first' }), second.search({ query: 'synthetic second' })])
  assert.equal(starts.length, 2)
  assert.ok(starts[1] - starts[0] >= 2990)
  assert.equal(maxActive, 1)
})

test('missing article identity is a visible response error rather than a false empty search', async () => {
  const { search } = provider(() => crossref([item({ DOI: 'https://evil.invalid/document' })]), () => arxiv('<entry><id>http://arxiv.org/abs/2601.00004</id></entry>'))
  const result = await search.search({ query: 'synthetic missing identity' })
  assert.equal(result.status, 'unavailable')
  assert.ok(result.providers.every(value => value.error.code === 'invalid_response'))
})

test('per-request timeout bounds a transport that never resolves', async () => {
  const search = createScholarlySearch({ fetch: async () => new Promise(() => {}) })
  const start = Date.now()
  // AbortSignal.timeout 的计时器不会独自维持进程；保留一个仅用于本测试的句柄。
  const keepAlive = setInterval(() => {}, 1000)
  try {
    const result = await search.search({ query: 'synthetic timeout' })
    assert.equal(result.status, 'unavailable')
    assert.ok(result.providers.every(value => value.error.code === 'timeout'))
    assert.ok(Date.now() - start < SCHOLARLY_SEARCH_LIMITS.searchTimeoutMs + 1000)
  } finally { clearInterval(keepAlive) }
})
