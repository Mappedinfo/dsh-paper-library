import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { EventEmitter } from 'node:events'
import https from 'node:https'
import { isPublicAddress, resolveAndFetch, resolveDOIMetadata } from '../src/paper-fetch.mjs'

const PUBLIC = [{ address: '93.184.215.14', family: 4 }]
const resolver = async () => PUBLIC
const PDF = Buffer.from('%PDF-1.4\nsynthetic fixture bytes\n%%EOF\n')
function response(body, headers = {}, statusCode = 200) {
  return { statusCode, headers, body: Readable.from(Array.isArray(body) ? body : [Buffer.from(body)]), close() { this.body.destroy() } }
}
async function directory(t) {
  const path = await mkdtemp(join(tmpdir(), 'paper-fetch-test-'))
  t.after(() => rm(path, { recursive: true, force: true }))
  return path
}

test('public address validation rejects private, reserved, mapped and transition IPv4/IPv6 space', () => {
  for (const address of ['0.0.0.0', '10.0.0.1', '100.64.0.1', '127.0.0.1', '169.254.169.254', '172.16.1.2', '192.0.0.1', '192.0.2.1', '192.168.1.1', '198.18.0.2', '198.51.100.1', '203.0.113.4', '224.0.0.1', '255.255.255.255', '::', '::1', '::ffff:8.8.8.8', '64:ff9b::808:808', 'fc00::1', 'fe80::1', 'ff02::1', '2001:db8::1', '2001::1', '2002:808:808::1', '3fff::1', '5f00::1']) assert.equal(isPublicAddress(address), false, address)
  for (const address of ['93.184.215.14', '8.8.8.8', '2606:4700:4700::1111', '2001:4860:4860::8888']) assert.equal(isPublicAddress(address), true, address)
})

test('DOI resolves Crossref CSL, follows official landing metadata, streams PDF and preserves provenance', async t => {
  const dir = await directory(t)
  const requests = []
  const result = await resolveAndFetch('10.1234/reader', { directory: dir, resolver, transport: async request => {
    requests.push(request)
    assert.equal(request.address, PUBLIC[0].address)
    assert.equal(request.headers.Cookie, undefined)
    if (request.url.hostname === 'api.crossref.org') return response(JSON.stringify({ message: { DOI: '10.1234/reader', type: 'journal-article', title: ['Test &amp; Evidence'], author: [{ family: 'Reader', given: 'A.' }], published: { 'date-parts': [[2026, 9]] }, URL: 'https://doi.org/10.1234/reader' } }))
    if (request.url.hostname === 'doi.org') return response('', { location: 'https://publisher.example/article' }, 302)
    if (request.url.pathname === '/article') return response('<meta name="citation_pdf_url" content="/paper.pdf"><meta name="citation_title" content="Fallback title">', { 'content-type': 'text/html' })
    return response([PDF.subarray(0, 2), PDF.subarray(2, 9), PDF.subarray(9)], { 'content-type': 'application/pdf' })
  } })
  assert.equal(result.status, 'downloaded')
  assert.equal(result.metadata.title, 'Test & Evidence')
  assert.deepEqual(result.metadata.author, [{ family: 'Reader', given: 'A.' }])
  assert.deepEqual(await readFile(result.path), PDF)
  assert.equal((await stat(result.path)).mode & 0o777, 0o600)
  assert.equal(result.provenance.source_url, 'https://publisher.example/paper.pdf')
  assert.equal(result.provenance.validation, 'pdf_signature_only')
  assert.deepEqual(result.provenance.requests.map(request => request.status), [200, 302, 200, 200])
  assert.equal(requests.length, 4)
})

test('all redirects re-resolve and reject private or mixed DNS without a second transport request', async t => {
  const dir = await directory(t)
  for (const location of ['http://127.0.0.1/private', 'https://inside.example/private']) {
    let calls = 0
    const result = await resolveAndFetch('https://papers.example/first', { directory: dir, resolver: async hostname => hostname === 'inside.example' ? [...PUBLIC, { address: '10.0.0.1', family: 4 }] : PUBLIC, transport: async () => { calls++; return response('', { location }, 302) } })
    assert.equal(calls, 1)
    assert.equal(result.status, 'unavailable')
    assert.match(result.warnings.join(' '), /private|Private/)
  }
  assert.deepEqual(await readdir(dir), [])
})

test('initial URLs reject credentials, nonstandard ports, alternative loopback spellings and private IPv6', async t => {
  const dir = await directory(t)
  for (const target of ['https://name:secret@papers.example/paper', 'https://papers.example:8443/paper', 'http://2130706433/paper', 'http://0x7f000001/paper', 'http://[::ffff:127.0.0.1]/paper', 'http://[fe80::1]/paper', 'file:///private/paper.pdf']) {
    let calls = 0
    try {
      const result = await resolveAndFetch(target, { directory: dir, resolver, transport: async () => { calls++; return response(PDF) } })
      assert.equal(result.status, 'unavailable')
    } catch (error) { assert.match(error.message, /URL|host|address|permitted|HTTP/) }
    assert.equal(calls, 0, target)
  }
})

test('production request pins the validated DNS answer into Node socket lookup', async t => {
  const dir = await directory(t)
  let resolutionCount = 0
  let requestOptions
  t.mock.method(https, 'request', (url, options, callback) => {
    assert.equal(url.hostname, 'papers.example')
    requestOptions = options
    const request = new EventEmitter()
    request.destroy = () => {}
    request.end = () => {
      const stream = Readable.from([PDF])
      stream.statusCode = 200
      stream.headers = { 'content-type': 'application/pdf' }
      callback(stream)
    }
    return request
  })
  const result = await resolveAndFetch('https://papers.example/paper.pdf', { directory: dir, resolver: async () => { resolutionCount++; return PUBLIC } })
  assert.equal(result.status, 'downloaded')
  assert.equal(resolutionCount, 1)
  assert.equal(requestOptions.agent, false)
  assert.equal(requestOptions.autoSelectFamily, false)
  await new Promise((resolve, reject) => requestOptions.lookup('papers.example', {}, (error, address, family) => { if (error) return reject(error); assert.equal(address, PUBLIC[0].address); assert.equal(family, 4); resolve() }))
  await new Promise(resolve => requestOptions.lookup('different.example', {}, error => { assert.match(error.message, /Unexpected/); resolve() }))
})

test('HTML masquerading as PDF remains metadata-only and creates no downloaded file', async t => {
  const dir = await directory(t)
  const result = await resolveAndFetch('10.1234/blocked', { directory: dir, resolver, transport: async ({ url }) => url.hostname === 'api.crossref.org' ? response(JSON.stringify({ message: { DOI: '10.1234/blocked', title: ['Known paper'] } })) : response('<html>Please log in</html>', { 'content-type': 'application/pdf' }) })
  assert.equal(result.status, 'metadata_only')
  assert.equal(result.metadata.title, 'Known paper')
  assert.match(result.warnings.join(' '), /claimed PDF/)
  assert.deepEqual(await readdir(dir), [])
})

test('streamed PDF cap and interruption remove partial files', async t => {
  const dir = await directory(t)
  const tooLarge = await resolveAndFetch('https://papers.example/huge.pdf', { directory: dir, maxBytes: 32, resolver, transport: async () => response([Buffer.from('%PDF-1.4\n'), Buffer.alloc(64)]) })
  assert.equal(tooLarge.status, 'unavailable')
  assert.match(tooLarge.warnings.join(' '), /byte limit/)
  assert.deepEqual(await readdir(dir), [])
  const controller = new AbortController()
  let closed = false
  const task = resolveAndFetch('https://papers.example/hang.pdf', { directory: dir, signal: controller.signal, resolver, transport: async () => ({ statusCode: 200, headers: {}, body: { async *[Symbol.asyncIterator]() { yield Buffer.from('%PDF-1.4\n'); setImmediate(() => controller.abort(new Error('fixture cancellation'))); await new Promise(() => {}) } }, close() { closed = true } }) })
  await assert.rejects(task, /fixture cancellation/)
  assert.equal(closed, true)
  assert.deepEqual(await readdir(dir), [])
})

test('landing HTML and metadata are bounded to 2 MiB; request and candidate caps terminate', async t => {
  const dir = await directory(t)
  const result = await resolveAndFetch('https://papers.example/huge', { directory: dir, resolver, transport: async () => response([Buffer.alloc(1024 * 1024, 'x'), Buffer.alloc(1024 * 1024, 'x'), Buffer.alloc(1)]) })
  assert.equal(result.status, 'unavailable')
  assert.match(result.warnings.join(' '), /2 MiB/)
  let calls = 0
  const redirects = await resolveAndFetch('https://papers.example/loop', { directory: dir, resolver, transport: async () => { calls++; return response('', { location: `https://papers.example/redirect${calls}` }, 302) } })
  assert.equal(calls, 6)
  assert.match(redirects.warnings.join(' '), /Redirect limit/)
  calls = 0
  await resolveAndFetch('https://papers.example/article', { directory: dir, maxCandidates: 3, resolver, transport: async () => { calls++; return response(Array.from({ length: 12 }, (_, index) => `<a href="/paper${index}.pdf">Paper</a>`).join('')) } })
  assert.equal(calls, 3)
})

test('arXiv explicit version resolves official metadata and downloads only official candidates', async t => {
  const dir = await directory(t)
  const requests = []
  const result = await resolveAndFetch('arXiv:2401.01234v2', { directory: dir, resolver, transport: async ({ url }) => {
    requests.push(url.href)
    return url.hostname === 'export.arxiv.org' ? response('<feed><entry><id>http://arxiv.org/abs/2401.01234v2</id><title>Versioned paper</title><author><name>A Reader</name></author><published>2024-01-10T00:00:00Z</published><summary>Abstract.</summary></entry></feed>') : response(PDF)
  } })
  assert.equal(result.status, 'downloaded')
  assert.equal(result.metadata.archive_location, '2401.01234v2')
  assert.deepEqual(result.metadata.author, [{ literal: 'A Reader' }])
  assert.deepEqual(requests, ['https://export.arxiv.org/api/query?id_list=2401.01234v2', 'https://arxiv.org/pdf/2401.01234v2'])
})

test('DOI enrichment reports source failure and rejects mismatched work identity', async () => {
  const result = await resolveDOIMetadata('10.1234/requested', { resolver, transport: async () => response(JSON.stringify({ message: { DOI: '10.1234/different', title: ['Wrong paper'] } })) })
  assert.equal(result.metadata, undefined)
  assert.match(result.warnings.join(' '), /different DOI/)
  assert.equal(result.provenance.requests.length, 1)
  await assert.rejects(resolveDOIMetadata('10.1234/requested', { transport: 'from-browser' }), /function-only/)
})

test('total deadline bounds slow DNS and metadata body reads without starting another candidate', async t => {
  const dir = await directory(t)
  let calls = 0
  const result = await resolveAndFetch('https://papers.example/slow.pdf', { directory: dir, timeoutMs: 5, resolver: () => new Promise(resolve => setTimeout(() => resolve(PUBLIC), 20)), transport: async () => { calls++; return response(PDF) } })
  assert.equal(result.status, 'unavailable')
  assert.equal(calls, 0)
  assert.match(result.warnings.join(' '), /deadline/)
  let closed = false
  const metadata = await resolveDOIMetadata('10.1234/slow', { timeoutMs: 5, resolver, transport: async () => ({ statusCode: 200, headers: {}, body: { async *[Symbol.asyncIterator]() { await new Promise(resolve => setTimeout(resolve, 20)); yield Buffer.from('{}') } }, close() { closed = true } }) })
  assert.equal(metadata.metadata, undefined)
  assert.equal(closed, true)
  assert.match(metadata.warnings.join(' '), /timeout/i)
})
