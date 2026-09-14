/** Bounded public-paper acquisition. These bytes still require a PDF parser before import. */
import http from 'node:http'
import https from 'node:https'
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { mkdir, open, rename, rm } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { networkInterfaces } from 'node:os'

const TEXT_LIMIT = 2 * 1024 * 1024
const PDF_LIMIT = 250 * 1024 * 1024
const USER_AGENT = 'Mappedinfo-Paper-Library/0.1 (public scholarly PDF retrieval)'
const ARXIV_ID = /^(?:\d{4}\.\d{4,5}|[a-z][a-z.-]*(?:\.[A-Z]{2})?\/\d{7})(?:v\d+)?$/i
const DOI = /^10\.\d{4,9}\/[^\s?#]+$/i

function bounded(value, fallback, ceiling, label) {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || value < 1 || value > ceiling) throw new Error(`${label} must be an integer between 1 and ${ceiling}`)
  return value
}

function ipv4Number(address) {
  return address.split('.').reduce((value, octet) => value * 256 + Number(octet), 0)
}

function v4In(address, base, bits) {
  return Math.floor(ipv4Number(address) / 2 ** (32 - bits)) === Math.floor(ipv4Number(base) / 2 ** (32 - bits))
}

function ipv6Number(address) {
  if (address.includes('.') || address.includes('%')) return null
  const [left, right] = address.toLowerCase().split('::')
  const before = left ? left.split(':') : []
  const after = right ? right.split(':') : []
  const groups = right === undefined ? before : [...before, ...Array(8 - before.length - after.length).fill('0'), ...after]
  if (groups.length !== 8) return null
  return groups.reduce((value, group) => (value << 16n) + BigInt(`0x${group}`), 0n)
}

/** Conservative globally routed address allowlist; mixed public/private DNS answers reject.
 * Special-purpose registries verified 2026-09-14:
 * https://www.iana.org/assignments/iana-ipv4-special-registry/
 * https://www.iana.org/assignments/iana-ipv6-special-registry/
 */
export function isPublicAddress(address) {
  if (isIP(address) === 4) {
    return ![
      ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
      ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
      ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
      ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
    ].some(([base, bits]) => v4In(address, base, bits))
  }
  if (isIP(address) !== 6) return false
  const number = ipv6Number(address)
  if (number === null || number >> 125n !== 1n) return false // only 2000::/3 global unicast
  return ![['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]].some(([base, bits]) => number >> BigInt(128 - bits) === ipv6Number(base) >> BigInt(128 - bits))
}

function publicURL(value) {
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only public HTTP(S) URLs are supported')
  if (url.username || url.password) throw new Error('URL credentials are not permitted')
  if (url.port) throw new Error('Nonstandard URL ports are not permitted')
  const hostname = url.hostname.replace(/^\[|\]$/g, '')
  if (!hostname || hostname.endsWith('.') || hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) throw new Error('Local or ambiguous hostnames are not permitted')
  if (isIP(hostname) && !isPublicAddress(hostname)) throw new Error('Private, local, or reserved addresses are not permitted')
  url.hash = ''
  return url
}

function isLocalInterface(address) {
  const key = value => isIP(value) === 6 ? ipv6Number(value)?.toString() : value
  return Object.values(networkInterfaces()).flat().some(entry => entry && key(entry.address) === key(address))
}

function abortable(promise, signal) {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

/** The sole production transport. DNS is never resolved again by the socket. */
function pinnedRequest({ url, address, family, signal, headers }) {
  return new Promise((resolve, reject) => {
    const hostname = url.hostname.replace(/^\[|\]$/g, '')
    const request = (url.protocol === 'https:' ? https : http).request(url, {
      method: 'GET', agent: false, autoSelectFamily: false, family, signal, headers,
      lookup: (_hostname, options, callback) => {
        if (_hostname !== hostname) return callback(new Error('Unexpected DNS lookup hostname'))
        if (options?.all) callback(null, [{ address, family }])
        else callback(null, address, family)
      },
    }, response => resolve({
      statusCode: response.statusCode, headers: response.headers, body: response,
      close: () => { response.destroy(); request.destroy() },
    }))
    request.on('error', reject)
    request.end()
  })
}

function context(options, target) {
  const timeoutMs = bounded(options.timeoutMs, 60_000, 120_000, 'timeoutMs')
  const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs)
  if (options.transport !== undefined && typeof options.transport !== 'function') throw new Error('transport is an internal function-only test seam')
  if (options.resolver !== undefined && typeof options.resolver !== 'function') throw new Error('resolver is an internal function-only test seam')
  return {
    options, signal, transport: options.transport ?? pinnedRequest,
    resolver: options.resolver ?? (hostname => lookup(hostname, { all: true, verbatim: true })),
    maxBytes: bounded(options.maxBytes, PDF_LIMIT, PDF_LIMIT, 'maxBytes'),
    maxCandidates: bounded(options.maxCandidates, 8, 8, 'maxCandidates'),
    requests: 0, warnings: [], provenance: { target, fetched_at: new Date().toISOString(), requests: [] },
  }
}

function errorText(error) { return String(error?.message ?? error).slice(0, 500) }

function warn(ctx, error) {
  ctx.options.signal?.throwIfAborted()
  ctx.warnings.push(errorText(error))
}

async function requestPublic(value, ctx, kind) {
  let url = publicURL(value)
  for (let redirects = 0; redirects <= 5; redirects++) {
    ctx.signal.throwIfAborted()
    if (++ctx.requests > 16) throw new Error('Public request limit reached')
    const record = { url: url.href, kind }
    ctx.provenance.requests.push(record)
    let response
    try {
      const hostname = url.hostname.replace(/^\[|\]$/g, '')
      const answers = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await abortable(ctx.resolver(hostname), ctx.signal)
      if (!Array.isArray(answers) || !answers.length || answers.some(answer => !isPublicAddress(answer.address) || isLocalInterface(answer.address) || isIP(answer.address) !== answer.family)) throw new Error('DNS resolved to a private, local, reserved, or invalid address')
      const { address, family } = answers.find(answer => answer.family === 4) ?? answers[0]
      const requestSignal = AbortSignal.any([ctx.signal, AbortSignal.timeout(15_000)])
      response = await abortable(ctx.transport({ url, address, family, signal: requestSignal, headers: {
        'User-Agent': USER_AGENT, Accept: kind === 'metadata' ? 'application/json, application/atom+xml, application/xml;q=0.9' : 'application/pdf, text/html;q=0.9, */*;q=0.1',
        'Accept-Encoding': 'identity',
      } }), requestSignal)
      record.status = response.statusCode
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        const location = response.headers.location
        response.close?.()
        if (typeof location !== 'string') throw new Error('Redirect response omitted a Location URL')
        if (redirects === 5) throw new Error('Redirect limit reached')
        url = publicURL(new URL(location, url).href)
        continue
      }
      if (response.statusCode !== 200) throw new Error(`Public source returned HTTP ${response.statusCode}; login, payment, and retry bypasses are not attempted`)
      if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') throw new Error('Compressed response was not accepted; the source ignored identity encoding')
      return { ...response, close: response.close?.bind(response), url: url.href, signal: requestSignal }
    } catch (error) {
      response?.close?.()
      record.error = errorText(error)
      throw error
    }
  }
}

async function readText(response, limit = TEXT_LIMIT) {
  const length = Number(response.headers['content-length'])
  if (Number.isFinite(length) && length > limit) { response.close?.(); throw new Error('Metadata or landing page exceeds 2 MiB limit') }
  const chunks = []
  let size = 0
  try {
    const iterator = response.body[Symbol.asyncIterator]()
    while (true) {
      const next = await abortable(iterator.next(), response.signal)
      if (next.done) break
      const chunk = next.value
      size += chunk.length
      if (size > limit) throw new Error('Metadata or landing page exceeds 2 MiB limit')
      chunks.push(Buffer.from(chunk))
    }
    return Buffer.concat(chunks, size).toString('utf8')
  } finally { response.close?.() }
}

const decode = text => String(text ?? '').replace(/&(?:amp|quot|apos|lt|gt|#\d+|#x[0-9a-f]+);/gi, entity => {
  const named = { '&amp;': '&', '&quot;': '"', '&apos;': "'", '&lt;': '<', '&gt;': '>' }
  if (named[entity.toLowerCase()]) return named[entity.toLowerCase()]
  const hex = entity[2].toLowerCase() === 'x'
  const code = parseInt(entity.slice(hex ? 3 : 2, -1), hex ? 16 : 10)
  return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : ''
})
const clean = text => decode(String(text ?? '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim()
const first = value => Array.isArray(value) ? value[0] : value

function normalizeDOI(value) {
  let doi = String(value).trim().replace(/^doi:\s*/i, '')
  if (/^https?:\/\/(?:dx\.)?doi\.org\//i.test(doi)) doi = decodeURIComponent(new URL(doi).pathname.slice(1))
  if (doi.length > 512 || !DOI.test(doi)) throw new Error('Invalid DOI')
  return doi
}

function crossrefCSL(item, doi) {
  if (item.DOI && String(item.DOI).toLowerCase() !== doi.toLowerCase()) throw new Error('Crossref returned metadata for a different DOI')
  const type = { 'journal-article': 'article-journal', 'proceedings-article': 'paper-conference', 'book-chapter': 'chapter', 'posted-content': 'article' }[item.type] ?? 'article'
  const csl = { id: doi, type, DOI: doi, title: clean(first(item.title)), URL: item.URL || `https://doi.org/${doi}` }
  if (Array.isArray(item.author)) csl.author = item.author.slice(0, 100).map(person => person.family ? { family: person.family, ...(person.given ? { given: person.given } : {}) } : { literal: clean(person.name || person.given) }).filter(person => person.family || person.literal)
  for (const [key, value] of Object.entries({ 'container-title': first(item['container-title']), volume: item.volume, issue: item.issue, page: item.page, publisher: item.publisher, abstract: item.abstract })) if (value) csl[key] = clean(value)
  const issued = item.published ?? item['published-print'] ?? item['published-online'] ?? item.issued
  if (Array.isArray(issued?.['date-parts']?.[0])) csl.issued = { 'date-parts': [issued['date-parts'][0].slice(0, 3)] }
  return csl
}

async function doiMetadata(doi, ctx) {
  const response = await requestPublic(`https://api.crossref.org/works/${encodeURIComponent(doi)}`, ctx, 'metadata')
  const data = JSON.parse(await readText(response))
  if (!data.message || typeof data.message !== 'object') throw new Error('Crossref response has no work metadata')
  const metadata = crossrefCSL(data.message, doi)
  const links = Array.isArray(data.message.link) ? data.message.link : []
  const candidates = links.filter(link => link?.['content-type'] === 'application/pdf' || /\.pdf(?:$|[?#])/i.test(link?.URL ?? '')).map(link => link.URL).filter(value => typeof value === 'string').slice(0, 3)
  if (data.message.resource?.primary?.URL) candidates.push(data.message.resource.primary.URL)
  if (data.message.URL) candidates.push(data.message.URL)
  candidates.push(`https://doi.org/${doi}`)
  return { metadata, candidates }
}

/** Resolve a recognized DOI for local-PDF enrichment; does not download a PDF. */
export async function resolveDOIMetadata(value, options = {}) {
  const doi = normalizeDOI(value)
  const ctx = context(options, doi)
  let result = { candidates: [`https://doi.org/${doi}`] }
  try { result = await doiMetadata(doi, ctx) } catch (error) { warn(ctx, error) }
  return { ...result, provenance: ctx.provenance, warnings: ctx.warnings }
}

function attrs(tag) {
  const result = {}
  for (const match of tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) result[match[1].toLowerCase()] = decode(match[2] ?? match[3] ?? match[4])
  return result
}

function landingMetadata(html, url) {
  const meta = new Map()
  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    const attributes = attrs(match[0])
    const key = (attributes.name ?? attributes.property ?? '').toLowerCase()
    if (key && attributes.content) meta.set(key, [...(meta.get(key) ?? []), attributes.content.slice(0, 20_000)].slice(0, 100))
  }
  const get = key => first(meta.get(key))
  const metadata = { type: 'article', URL: url }
  const title = get('citation_title') ?? get('dc.title') ?? get('og:title')
  if (title) metadata.title = clean(title)
  const authors = meta.get('citation_author') ?? meta.get('dc.creator')
  if (authors) metadata.author = authors.map(name => ({ literal: clean(name) }))
  const doi = get('citation_doi') ?? get('dc.identifier')
  if (doi) { try { metadata.DOI = normalizeDOI(doi) } catch {} }
  const date = get('citation_publication_date') ?? get('citation_date') ?? get('dc.date')
  if (date && /^\d{4}(?:[-/]\d{1,2})?(?:[-/]\d{1,2})?$/.test(date.trim())) metadata.issued = { 'date-parts': [date.trim().split(/[-/]/).map(Number)] }
  for (const [key, value] of [['container-title', get('citation_journal_title')], ['volume', get('citation_volume')], ['issue', get('citation_issue')]]) if (value) metadata[key] = clean(value)
  const candidates = [...(meta.get('citation_pdf_url') ?? [])]
  for (const match of html.matchAll(/<(?:link|a)\b[^>]*>/gi)) {
    const attributes = attrs(match[0])
    if (attributes.href && (attributes.type?.toLowerCase() === 'application/pdf' || /\.pdf(?:$|[?#])/i.test(attributes.href))) candidates.push(attributes.href)
    if (candidates.length >= 12) break
  }
  return { metadata: metadata.title || metadata.DOI ? metadata : undefined, candidates: candidates.slice(0, 12).flatMap(candidate => { try { return [new URL(candidate, url).href] } catch { return [] } }) }
}

function arxivID(value) {
  let id = value.replace(/^arxiv:\s*/i, '')
  if (/^https?:\/\//i.test(id)) {
    const url = publicURL(id)
    if (!['arxiv.org', 'www.arxiv.org', 'export.arxiv.org'].includes(url.hostname)) return null
    id = url.pathname.replace(/^\/(?:abs|pdf)\//, '').replace(/\.pdf$/, '')
  }
  return ARXIV_ID.test(id) ? id : null
}

async function arxivMetadata(id, ctx) {
  const response = await requestPublic(`https://export.arxiv.org/api/query?id_list=${encodeURIComponent(id)}`, ctx, 'metadata')
  const xml = await readText(response)
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('Unexpected XML document entities')
  const entry = xml.match(/<entry\b[^>]*>([\s\S]*?)<\/entry>/i)?.[1]
  if (!entry) throw new Error('arXiv API returned no entry')
  const field = tag => clean(entry.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'))?.[1])
  const returnedID = arxivID(field('id'))
  if (!returnedID || returnedID.replace(/v\d+$/, '') !== id.replace(/v\d+$/, '') || /v\d+$/.test(id) && returnedID !== id) throw new Error('arXiv API returned a different article or version')
  const metadata = { id: `arxiv:${returnedID}`, type: 'article', title: field('title'), URL: `https://arxiv.org/abs/${returnedID}`, archive: 'arXiv', archive_location: returnedID }
  metadata.author = [...entry.matchAll(/<author\b[^>]*>[\s\S]*?<name\b[^>]*>([\s\S]*?)<\/name>[\s\S]*?<\/author>/gi)].slice(0, 100).map(match => ({ literal: clean(match[1]) }))
  const published = field('published')
  if (/^\d{4}-\d{2}-\d{2}/.test(published)) metadata.issued = { 'date-parts': [published.slice(0, 10).split('-').map(Number)] }
  if (field('summary')) metadata.abstract = field('summary')
  if (field('arxiv:doi')) { try { metadata.DOI = normalizeDOI(field('arxiv:doi')) } catch {} }
  return metadata
}

async function consumeCandidate(response, directory, ctx) {
  const iterator = response.body[Symbol.asyncIterator]()
  const prefix = []
  let size = 0
  let handle
  let partial
  try {
    while (size < 5) {
      const result = await abortable(iterator.next(), response.signal)
      if (result.done) break
      const chunk = Buffer.from(result.value)
      prefix.push(chunk); size += chunk.length
      if (size > ctx.maxBytes) throw new Error('PDF exceeds configured byte limit')
    }
    const signature = Buffer.concat(prefix, size).subarray(0, 5).toString('ascii')
    if (signature !== '%PDF-') {
      const body = { async *[Symbol.asyncIterator]() { yield* prefix; while (true) { const next = await abortable(iterator.next(), response.signal); if (next.done) break; yield next.value } } }
      if (/application\/pdf/i.test(response.headers['content-type'] ?? '')) throw new Error('Source claimed PDF but returned a non-PDF payload (possibly a login or block page)')
      return { html: await readText({ ...response, body }) }
    }
    const length = Number(response.headers['content-length'])
    if (Number.isFinite(length) && length > ctx.maxBytes) throw new Error('PDF exceeds configured byte limit')
    const path = join(directory, `paper-${randomUUID()}.pdf`)
    partial = `${path}.part`
    handle = await open(partial, 'wx', 0o600)
    for (const chunk of prefix) await handle.writeFile(chunk)
    while (true) {
      const next = await abortable(iterator.next(), response.signal)
      if (next.done) break
      const chunk = Buffer.from(next.value)
      size += chunk.length
      if (size > ctx.maxBytes) throw new Error('PDF exceeds configured byte limit')
      await handle.writeFile(chunk)
    }
    response.signal.throwIfAborted()
    await handle.close(); handle = undefined
    await rename(partial, path); partial = undefined
    return { path, bytes: size }
  } finally {
    response.close?.()
    await handle?.close()
    if (partial) await rm(partial, { force: true })
  }
}

/** Download public bytes to the caller's temporary directory; no user-library mutations. */
export async function resolveAndFetch(target, options = {}) {
  if (typeof target !== 'string' || !target.trim() || target.length > 4096) throw new Error('Provide a DOI, arXiv ID, or public paper URL')
  if (typeof options.directory !== 'string' || !isAbsolute(options.directory)) throw new Error('A caller-owned absolute temporary directory is required')
  target = target.trim()
  const ctx = context(options, target)
  const queue = []
  const seen = new Set()
  let metadata
  const add = (value, depth = 0) => {
    if (typeof value !== 'string' || value.length > 8192) return
    try {
      const url = publicURL(value).href
      if (!seen.has(url) && queue.length < ctx.maxCandidates) { seen.add(url); queue.push({ url, depth }) }
    } catch (error) { warn(ctx, error) }
  }
  let doi
  try { doi = normalizeDOI(target) } catch {}
  if (doi) {
    try { const result = await doiMetadata(doi, ctx); metadata = result.metadata; result.candidates.forEach(url => add(url)) } catch (error) { warn(ctx, error) }
    add(`https://doi.org/${doi}`)
  } else {
    const id = arxivID(target)
    if (id) {
      try { metadata = await arxivMetadata(id, ctx) } catch (error) { warn(ctx, error) }
      const version = metadata?.archive_location ?? id
      add(`https://arxiv.org/pdf/${version}`)
      add(`https://arxiv.org/abs/${version}`)
    } else add(target)
  }
  await mkdir(options.directory, { recursive: true })
  for (let index = 0; index < queue.length && index < ctx.maxCandidates; index++) {
    if (ctx.signal.aborted || ctx.requests >= 16) break
    const candidate = queue[index]
    try {
      const response = await requestPublic(candidate.url, ctx, 'paper')
      const result = await consumeCandidate(response, options.directory, ctx)
      if (result.path) return { status: 'downloaded', path: result.path, metadata, bytes: result.bytes, provenance: { ...ctx.provenance, source_url: response.url, validation: 'pdf_signature_only' }, warnings: ctx.warnings }
      const landing = landingMetadata(result.html, response.url)
      if (metadata?.DOI && landing.metadata?.DOI && metadata.DOI.toLowerCase() !== landing.metadata.DOI.toLowerCase()) throw new Error('Landing page identifies a different DOI; its PDF links were not followed')
      metadata = metadata ? { ...landing.metadata, ...metadata } : landing.metadata
      if (candidate.depth < 2) landing.candidates.forEach(url => add(url, candidate.depth + 1))
      if (!landing.candidates.length) ctx.warnings.push('Landing page exposed no public PDF link; no login, cookies, or paywall bypass attempted')
    } catch (error) { warn(ctx, error) }
  }
  ctx.options.signal?.throwIfAborted()
  if (ctx.signal.aborted) ctx.warnings.push('Public acquisition deadline reached')
  if (ctx.requests >= 16) ctx.warnings.push('Public request limit reached')
  return { status: metadata ? 'metadata_only' : 'unavailable', metadata, provenance: ctx.provenance, warnings: [...new Set(ctx.warnings)] }
}
