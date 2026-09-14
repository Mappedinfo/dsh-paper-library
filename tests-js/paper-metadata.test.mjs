import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { resolveDOIMetadata, resolveMetadata } from '../src/paper-fetch.mjs'
import { bibliographicMetadata, importPDF } from '../src/import-pdf.mjs'

const resolver = async () => [{ address: '93.184.215.14', family: 4 }]
function response(body, headers = {}, statusCode = 200) {
  return { statusCode, headers, body: Readable.from([Buffer.from(body)]), close() { this.body.destroy() } }
}
const crossref = message => response(JSON.stringify({ message }))
const tag = (name, content) => `<meta name="${name}" content="${content}">`

test('Crossref preserves author affiliations and semantic partial dates without inventing editorial dates or JCR', async () => {
  const result = await resolveDOIMetadata('10.1234/metadata', { resolver, transport: async () => crossref({
    DOI: '10.1234/metadata', title: ['Metadata evidence'], type: 'journal-article',
    author: [
      { family: 'Reader', given: 'A.', affiliation: [{ name: 'Institute &amp; Laboratory' }, { name: 'Second Institute' }, { name: 'Second Institute' }] },
      { family: 'Writer', given: 'B.', affiliation: [{ name: 'Different Institute' }] },
    ],
    published: { 'date-parts': [[2026]] }, 'published-online': { 'date-parts': [[2025, 12, 31]] },
    'published-print': { 'date-parts': [[2026, 2]] }, accepted: { 'date-parts': [[2025, 11, 2]] },
    created: { 'date-parts': [[2025, 1, 1]] }, deposited: { 'date-parts': [[2026, 9, 1]] },
    received: { 'date-parts': [[2025, 2, 1]] }, 'is-referenced-by-count': 1000, 'impact-factor': 99,
    journal_rankings: [{ system: 'JCR', year: 2025, category: 'Unknown', quartile: 'Q1' }],
    ISSN: ['1234-5678'],
  }) })
  assert.deepEqual(result.metadata.author, [
    { family: 'Reader', given: 'A.', affiliation: [{ name: 'Institute & Laboratory' }, { name: 'Second Institute' }] },
    { family: 'Writer', given: 'B.', affiliation: [{ name: 'Different Institute' }] },
  ])
  assert.deepEqual(result.metadata.publication_dates, { published: '2026', online: '2025-12-31', print: '2026-02', accepted: '2025-11-02' })
  assert.deepEqual(result.metadata.issued, { 'date-parts': [[2026]] })
  assert.deepEqual(result.metadata.ISSN, ['1234-5678'])
  assert.equal(result.metadata.journal_rankings, undefined)
  assert.equal(result.metadata.publication_dates.received, undefined)
})

test('invalid calendar dates are omitted, and oversized institution names are not silently cut into another identity', async () => {
  const result = await resolveDOIMetadata('10.1234/metadata', { resolver, transport: async () => crossref({
    DOI: '10.1234/metadata', title: ['Metadata evidence'],
    author: [{ family: 'Reader', affiliation: [{ name: 'x'.repeat(501) }, { name: 'Valid Institute' }] }],
    published: { 'date-parts': [[2025, 2, 29]] }, 'published-online': { 'date-parts': [[2024, 2, 29]] },
    'published-print': { 'date-parts': [[2026, 13]] }, accepted: { 'date-parts': [[2025, 4, 31]] },
    created: { 'date-parts': [[2025, 1, 1]] }, deposited: { 'date-parts': [[2026, 9, 1]] },
  }) })
  assert.deepEqual(result.metadata.publication_dates, { online: '2024-02-29' })
  assert.deepEqual(result.metadata.issued, { 'date-parts': [[2024, 2, 29]] })
  assert.deepEqual(result.metadata.author[0].affiliation, [{ name: 'Valid Institute' }])
  assert.match(result.warnings.join(' '), /affiliations.*omitted/)
})

test('landing refresh associates institutions with preceding authors and reads only explicit editorial date tags', async () => {
  const calls = []
  const result = await resolveMetadata('https://publisher.example/article', { resolver, transport: async ({ url }) => {
    calls.push(url.href)
    return response([
      tag('citation_title', 'Evidence from a landing page'),
      tag('citation_author_institution', 'Unmapped institution'),
      tag('citation_author', 'Reader, Alice'), tag('citation_author_institution', 'First Institute'), tag('citation_author_institution', 'Shared Institute'),
      tag('citation_author', 'Writer, Bob'), tag('citation_author_institution', 'Second Institute'),
      tag('citation_publication_date', '2026/9'), tag('citation_online_date', '2026-08-12'), tag('citation_print_date', '2026-09-30'),
      tag('citation_date_received', '2025-10-09'), tag('citation_date_accepted', '2026-06-02'),
      tag('article:modified_time', '2026-09-14'), tag('citation_pdf_url', '/paper.pdf'),
      '<p>Received in 2020; accepted 2021. Impact factor: 100. JCR Q1.</p>',
    ].join(''), { 'content-type': 'text/html' })
  } })
  assert.equal(result.status, 'metadata_only')
  assert.equal(result.path, undefined)
  assert.deepEqual(calls, ['https://publisher.example/article'])
  assert.deepEqual(result.metadata.author, [
    { literal: 'Reader, Alice', affiliation: [{ name: 'First Institute' }, { name: 'Shared Institute' }] },
    { literal: 'Writer, Bob', affiliation: [{ name: 'Second Institute' }] },
  ])
  assert.deepEqual(result.metadata.publication_dates, { published: '2026-09', online: '2026-08-12', print: '2026-09-30', received: '2025-10-09', accepted: '2026-06-02' })
  assert.equal(result.metadata.journal_rankings, undefined)
})

test('DOI metadata-only refresh merges explicit landing dates and author-name matches without index-based affiliation guesses', async () => {
  const calls = []
  const result = await resolveMetadata('10.1234/metadata', { resolver, transport: async ({ url }) => {
    calls.push(url.href)
    if (url.hostname === 'api.crossref.org') return crossref({
      DOI: '10.1234/metadata', title: ['Metadata evidence'],
      resource: { primary: { URL: 'https://publisher.example/article' } },
      link: [{ URL: 'https://publisher.example/download/123', 'content-type': 'application/pdf' }],
      author: [{ given: 'Alice', family: 'Reader' }, { given: 'Bob', family: 'Writer' }],
      accepted: { 'date-parts': [[2026, 5, 1]] },
    })
    return response([
      tag('citation_title', 'Metadata evidence'), tag('citation_doi', '10.1234/metadata'),
      tag('citation_author', 'Bob Writer'), tag('citation_author_institution', 'Bob Institute'),
      tag('citation_author', 'Alice Reader'), tag('citation_author_institution', 'Alice Institute'),
      tag('citation_date_received', '2025-12-03'), tag('citation_date_accepted', '2026-05-02'), tag('citation_pdf_url', '/download.pdf'),
    ].join(''))
  } })
  assert.deepEqual(calls, ['https://api.crossref.org/works/10.1234%2Fmetadata', 'https://publisher.example/article'])
  assert.deepEqual(result.metadata.author.map(person => person.affiliation), [[{ name: 'Alice Institute' }], [{ name: 'Bob Institute' }]])
  assert.deepEqual(result.metadata.publication_dates, { received: '2025-12-03', accepted: '2026-05-01' })
  assert.equal(result.provenance.kind, 'metadata-refresh')
})

test('URL refresh preserves matching landing data on Crossref failure and rejects a different DOI supplement', async () => {
  const result = await resolveMetadata('https://publisher.example/article', { resolver, transport: async ({ url }) => {
    if (url.hostname === 'api.crossref.org') return crossref({ DOI: '10.1234/other', title: ['Other paper'] })
    return response(tag('citation_title', 'Metadata evidence') + tag('citation_doi', '10.1234/metadata') + tag('citation_received_date', '2025-01'))
  } })
  assert.equal(result.metadata.DOI, '10.1234/metadata')
  assert.equal(result.metadata.title, 'Metadata evidence')
  assert.equal(result.metadata.publication_dates.received, '2025-01')
  assert.match(result.warnings.join(' '), /different DOI/)
})

test('failed DOI lookup cannot adopt an unidentified or differently identified landing page', async () => {
  for (const assertedDOI of ['', tag('citation_doi', '10.1234/other')]) {
    const result = await resolveMetadata('10.1234/metadata', { resolver, transport: async ({ url }) => url.hostname === 'api.crossref.org'
      ? response('', {}, 503)
      : response(tag('citation_title', 'Plausible but unidentified article') + assertedDOI) })
    assert.equal(result.status, 'unavailable')
    assert.equal(result.metadata, undefined)
    assert.match(result.warnings.join(' '), /requested DOI|different DOI/)
  }
})

test('metadata-only refresh never follows PDF candidates, consumes a declared PDF body, or starts a known PDF request', async () => {
  let calls = 0, closed = false
  const options = { resolver, transport: async () => {
    calls++
    return { statusCode: 200, headers: { 'content-type': 'application/pdf' }, body: { [Symbol.asyncIterator]() { throw new Error('PDF body must not be read') } }, close() { closed = true } }
  } }
  const known = await resolveMetadata('https://publisher.example/paper.pdf', options)
  assert.equal(known.status, 'unavailable')
  assert.equal(calls, 0)
  const redirected = await resolveMetadata('https://publisher.example/article', options)
  assert.equal(redirected.status, 'unavailable')
  assert.equal(calls, 1)
  assert.equal(closed, true)
  assert.match(redirected.warnings.join(' '), /does not download PDFs/)
  let reads = 0
  const masked = await resolveMetadata('https://publisher.example/article', { resolver, transport: async () => ({
    statusCode: 200, headers: { 'content-type': 'text/html' }, close() {},
    body: { async *[Symbol.asyncIterator]() { reads++; yield Buffer.from('%'); reads++; yield Buffer.from('PDF-'); reads++; throw new Error('Remaining PDF must not be consumed') } },
  }) })
  assert.equal(masked.status, 'unavailable')
  assert.equal(reads, 2)
  assert.match(masked.warnings.join(' '), /stopped after its signature/)
})

test('editorial dates are not inferred from page prose, generic modification tags or malformed explicit tags', async () => {
  const result = await resolveMetadata('https://publisher.example/article', { resolver, transport: async () => response([
    tag('citation_title', 'Metadata evidence'), tag('citation_publication_date', '2026-01'),
    tag('citation_date_received', '2025-02-29'), tag('citation_date_accepted', 'yesterday'),
    tag('article:published_time', '2026-01-01'), tag('article:modified_time', '2026-03-01'),
    '<p>Received 2025-03-01. Accepted 2025-12-02.</p>',
  ].join('')) })
  assert.deepEqual(result.metadata.publication_dates, { published: '2026-01' })
})

test('metadata-only refresh keeps DNS, content, deadline and interruption boundaries', async () => {
  let calls = 0
  const privateTarget = await resolveMetadata('https://publisher.example/article', { resolver: async () => [{ address: '127.0.0.1', family: 4 }], transport: async () => { calls++; return response('') } })
  assert.equal(privateTarget.status, 'unavailable')
  assert.equal(calls, 0)
  const tooLarge = await resolveMetadata('https://publisher.example/article', { resolver, transport: async () => response('x'.repeat(2 * 1024 * 1024 + 1)) })
  assert.equal(tooLarge.status, 'unavailable')
  assert.match(tooLarge.warnings.join(' '), /2 MiB/)
  const slow = await resolveMetadata('https://publisher.example/article', { timeoutMs: 5, resolver: () => new Promise(resolve => setTimeout(() => resolve([]), 20)), transport: async () => { calls++; return response('') } })
  assert.equal(slow.status, 'unavailable')
  assert.match(slow.warnings.join(' '), /deadline|timeout/i)
  const controller = new AbortController()
  controller.abort(new Error('fixture abort'))
  await assert.rejects(resolveMetadata('https://publisher.example/article', { signal: controller.signal, resolver }), /fixture abort/)
})

test('arXiv metadata refresh retains official version and author affiliations with no PDF candidate requests', async () => {
  const calls = []
  const result = await resolveMetadata('arXiv:2401.01234v2', { resolver, transport: async ({ url }) => {
    calls.push(url.href)
    return response('<feed><entry><id>https://arxiv.org/abs/2401.01234v2</id><title>Metadata evidence</title><author><name>Alice Reader</name><arxiv:affiliation>Example Institute</arxiv:affiliation></author><published>2024-01-10T00:00:00Z</published><updated>2024-02-20T00:00:00Z</updated></entry></feed>')
  } })
  assert.deepEqual(calls, ['https://export.arxiv.org/api/query?id_list=2401.01234v2'])
  assert.equal(result.metadata.archive_location, '2401.01234v2')
  assert.deepEqual(result.metadata.author, [{ literal: 'Alice Reader', affiliation: [{ name: 'Example Institute' }] }])
  assert.deepEqual(result.metadata.issued, { 'date-parts': [[2024, 1, 10]] })
  assert.equal(result.metadata.publication_dates, undefined)
})

test('PDF identity gate carries richer bibliographic fields while excluding source-controlled fields', async () => {
  const metadata = {
    title: 'Metadata evidence', author: [{ family: 'Reader', affiliation: [{ name: 'Example Institute' }] }],
    publication_dates: { accepted: '2026-02', received: '2025-12-01' },
    journal_rankings: [{ system: 'JCR', year: 2025, category: 'Example category', quartile: 'Q2', source: 'Imported licensed JCR export' }],
    attachments: [{ path: '/private/not-allowed.pdf' }], metadata_verified: true,
  }
  const requests = []
  await importPDF('/synthetic/not-read.pdf', {}, async request => {
    requests.push(request)
    return request.action === 'inspect_pdf' ? { metadata: { title: metadata.title }, parse: { field_sources: { title: 'pdf-info' } } } : { items: [], warnings: [] }
  }, { metadata })
  assert.deepEqual(requests[1].metadata, bibliographicMetadata(metadata))
  assert.equal(requests[1].metadata.attachments, undefined)
  assert.deepEqual(requests[1].metadata.publication_dates, metadata.publication_dates)
  assert.deepEqual(requests[1].metadata.journal_rankings, metadata.journal_rankings)
})
