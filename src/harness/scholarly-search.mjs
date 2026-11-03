/** 只读公开题录检索。调用方必须仅传入用户本次明确提供的公开检索词。
 * Crossref: https://www.crossref.org/documentation/retrieve-metadata/rest-api/
 * arXiv: https://info.arxiv.org/help/api/user-manual.html
 * arXiv 限速: https://info.arxiv.org/help/api/tou.html
 * 这些结果仅是题录或摘要，不能代替全文，也不能据此宣称学术共识。
 */
import https from 'node:https'
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { networkInterfaces } from 'node:os'
import { Readable } from 'node:stream'
import { isPublicAddress } from '../paper-fetch.mjs'

export const SCHOLARLY_SEARCH_LIMITS = Object.freeze({
  queryCharacters: 200, results: 5, requests: 2, responseBytes: 512 * 1024,
  requestTimeoutMs: 12_000, searchTimeoutMs: 25_000, abstractCharacters: 1600,
})
const USER_AGENT = 'Mappedinfo-Paper-Library/0.2 (bounded public scholarly metadata search)'
const DOI = /^10\.\d{4,9}\/[^\s?#\x00-\x1f\x7f]+$/i
const ARXIV_ID = /^(?:\d{4}\.\d{4,5}|[a-z][a-z.-]*(?:\.[A-Z]{2})?\/\d{7})(?:v\d+)?$/i
const ORIGINS = new Set(['https://api.crossref.org', 'https://export.arxiv.org'])
let arxivQueue = Promise.resolve()
let arxivStartedAt = 0
let arxivPending = 0

function failure(code, message) { return Object.assign(new Error(message), { code }) }
function abortable(promise, signal) {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}
async function delay(ms, signal) {
  if (ms <= 0) return
  let timer
  try { await abortable(new Promise(resolve => { timer = setTimeout(resolve, ms) }), signal) }
  finally { clearTimeout(timer) }
}

// 所有工厂共享 arXiv 队列；请求完整读取或关闭后，才允许下一连接。
async function serialArxiv(operation, signal) {
  if (arxivPending >= 6) throw failure('busy', 'arXiv search queue is full')
  arxivPending++
  const result = arxivQueue.then(async () => {
    signal.throwIfAborted()
    await delay(Math.max(0, arxivStartedAt + 3000 - Date.now()), signal)
    signal.throwIfAborted()
    arxivStartedAt = Date.now()
    return operation()
  }).finally(() => { arxivPending-- })
  arxivQueue = result.catch(() => {})
  return abortable(result, signal)
}

/** 生产网络入口固定域名、校验全部 DNS 答案并将 socket 绑定到已校验地址。 */
async function pinnedFetch(url, { signal, headers }, resolver) {
  const answers = await abortable(resolver(url.hostname), signal)
  const localAddresses = new Set(Object.values(networkInterfaces()).flat().filter(Boolean).map(entry => entry.address))
  if (!Array.isArray(answers) || !answers.length || answers.some(answer => !isPublicAddress(answer.address) || localAddresses.has(answer.address) || isIP(answer.address) !== answer.family)) {
    throw failure('unsafe_dns', 'Scholarly source DNS did not resolve exclusively to public addresses')
  }
  const { address, family } = answers.find(answer => answer.family === 4) ?? answers[0]
  return new Promise((resolve, reject) => {
    const request = https.request(url, {
      method: 'GET', agent: false, autoSelectFamily: false, family, signal, headers,
      lookup: (hostname, options, callback) => {
        if (hostname !== url.hostname) return callback(failure('unsafe_dns', 'Unexpected DNS lookup hostname'))
        if (options?.all) callback(null, [{ address, family }])
        else callback(null, address, family)
      },
    }, response => resolve({
      status: response.statusCode, headers: new Headers(response.headers),
      body: Readable.toWeb(response), url: url.href, redirected: false,
      close: () => { response.destroy(); request.destroy() },
    }))
    request.on('error', reject)
    request.end()
  })
}

const decode = value => String(value ?? '').replace(/&(?:amp|quot|apos|lt|gt|#\d+|#x[0-9a-f]+);/gi, entity => {
  const named = { '&amp;': '&', '&quot;': '"', '&apos;': "'", '&lt;': '<', '&gt;': '>' }
  if (named[entity.toLowerCase()]) return named[entity.toLowerCase()]
  const hex = entity[2].toLowerCase() === 'x'
  const code = parseInt(entity.slice(hex ? 3 : 2, -1), hex ? 16 : 10)
  return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : ''
})
const plain = (value, limit = 1000) => decode((typeof value === 'string' ? value : '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]*>/g, ' ')).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').replace(/\s+/g, ' ').trim().slice(0, limit)
const field = (xml, tag) => xml.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'))?.[1]
function doiValue(value) {
  if (typeof value !== 'string') return null
  const doi = value.trim().replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '').replace(/^doi:\s*/i, '')
  return doi.length <= 250 && DOI.test(doi) ? doi : null
}
function doiURL(doi) { return `https://doi.org/${doi.split('/').map(encodeURIComponent).join('/')}` }
function yearValue(value) { return Number.isInteger(value) && value > 0 && value <= 9999 ? value : null }
function resultRecord({ id, provider, title, authors, year, doi, url, abstract }) {
  const text = plain(abstract, SCHOLARLY_SEARCH_LIMITS.abstractCharacters + 1)
  return {
    id, provider, title, authors, year, doi, url,
    abstract: text ? text.slice(0, SCHOLARLY_SEARCH_LIMITS.abstractCharacters) : null,
    abstract_truncated: text.length > SCHOLARLY_SEARCH_LIMITS.abstractCharacters,
    evidence_level: text ? 'abstract' : 'metadata',
  }
}

function crossrefResults(text, limit) {
  let body
  try { body = JSON.parse(text) } catch { throw failure('invalid_response', 'Crossref returned invalid JSON') }
  if (body?.status !== 'ok' || !Array.isArray(body?.message?.items)) throw failure('invalid_response', 'Crossref returned an unexpected response')
  return body.message.items.slice(0, limit).map(item => {
    const doi = doiValue(item?.DOI)
    const title = plain(Array.isArray(item?.title) ? item.title[0] : item?.title)
    if (!doi || !title) throw failure('invalid_response', 'Crossref result omitted a valid DOI or title')
    const authors = Array.isArray(item.author) ? item.author.slice(0, 100).map(person => plain(person?.name || [person?.given, person?.family].filter(value => typeof value === 'string').join(' '), 200)).filter(Boolean) : []
    // created/deposited 是登记时间，不作为发表年份。
    const year = ['published', 'published-print', 'published-online', 'issued'].map(key => yearValue(item?.[key]?.['date-parts']?.[0]?.[0])).find(value => value !== null) ?? null
    return resultRecord({ id: `doi:${doi.toLowerCase()}`, provider: 'crossref', title, authors, year, doi, url: doiURL(doi), abstract: item.abstract })
  })
}

function arxivResults(xml, limit) {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml) || !/<feed\b[^>]*\bxmlns=["']http:\/\/www\.w3\.org\/2005\/Atom["']/i.test(xml) || !/<\/feed>\s*$/i.test(xml)) throw failure('invalid_response', 'arXiv returned an invalid Atom feed')
  return [...xml.matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/gi)].slice(0, limit).map(match => {
    const entry = match[1]
    const rawID = plain(field(entry, 'id'))
    let id
    try {
      const url = new URL(rawID)
      if (!['http:', 'https:'].includes(url.protocol) || !['arxiv.org', 'export.arxiv.org'].includes(url.hostname) || url.port || url.username || url.password || url.search || url.hash) throw new Error('Invalid identifier URL')
      id = url.pathname.replace(/^\/abs\//, '')
    } catch { throw failure('invalid_response', 'arXiv returned an invalid article identifier URL') }
    if (!ARXIV_ID.test(id)) throw failure('invalid_response', 'arXiv returned an error or invalid article identifier')
    const title = plain(field(entry, 'title'))
    if (!title) throw failure('invalid_response', 'arXiv result omitted its title')
    const authors = [...entry.matchAll(/<author\b[^>]*>([\s\S]*?)<\/author>/gi)].slice(0, 100).map(author => plain(field(author[1], 'name'), 200)).filter(Boolean)
    const published = plain(field(entry, 'published'))
    const year = /^\d{4}-\d{2}-\d{2}T/.test(published) ? yearValue(Number(published.slice(0, 4))) : null
    return resultRecord({ id: `arxiv:${id}`, provider: 'arxiv', title, authors, year, doi: doiValue(plain(field(entry, 'arxiv:doi'))), url: `https://arxiv.org/abs/${id}`, abstract: field(entry, 'summary') })
  })
}

async function readBounded(response, signal) {
  const sizeLimit = SCHOLARLY_SEARCH_LIMITS.responseBytes
  const length = Number(response.headers.get('content-length'))
  if (Number.isFinite(length) && length > sizeLimit) throw failure('response_too_large', 'Scholarly metadata exceeds the response limit')
  const reader = response.body?.getReader()
  if (!reader) throw failure('invalid_response', 'Scholarly source returned no body')
  const chunks = []
  let size = 0
  try {
    while (true) {
      const { value, done } = await abortable(reader.read(), signal)
      if (done) break
      const chunk = Buffer.from(value)
      size += chunk.length
      if (size > sizeLimit) throw failure('response_too_large', 'Scholarly metadata exceeds the response limit')
      chunks.push(chunk)
    }
    return Buffer.concat(chunks, size).toString('utf8')
  } finally { void reader.cancel().catch(() => {}); reader.releaseLock() }
}

/** fetch/resolver 仅为函数形式的测试注入点；生产调用无需配置或凭据。 */
export function createScholarlySearch(options = {}) {
  for (const key of ['fetch', 'resolver']) if (options[key] !== undefined && typeof options[key] !== 'function') throw new TypeError(`${key} must be a function`)
  const resolver = options.resolver ?? (hostname => lookup(hostname, { all: true, verbatim: true }))
  const fetch = options.fetch ?? ((url, init) => pinnedFetch(url, init, resolver))
  async function source(provider, url, signal, limit) {
    const operation = async () => {
      const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(SCHOLARLY_SEARCH_LIMITS.requestTimeoutMs)])
      let response
      try {
        if (!ORIGINS.has(url.origin) || url.username || url.password || url.port) throw failure('unsafe_url', 'Unexpected scholarly source')
        response = await abortable(fetch(url, { signal: requestSignal, redirect: 'manual', headers: { 'User-Agent': USER_AGENT, Accept: provider === 'crossref' ? 'application/json' : 'application/atom+xml', 'Accept-Encoding': 'identity' } }), requestSignal)
        if (response.redirected || response.url && new URL(response.url).href !== url.href || response.status >= 300 && response.status < 400) throw failure('redirect_rejected', 'Scholarly source redirect was not followed')
        if (response.status !== 200) throw failure(response.status === 429 ? 'rate_limited' : 'http_error', `Scholarly source returned HTTP ${response.status}`)
        const encoding = response.headers.get('content-encoding')
        if (encoding && encoding !== 'identity') throw failure('invalid_response', 'Compressed scholarly response was not accepted')
        const type = response.headers.get('content-type') ?? ''
        if (provider === 'crossref' ? !/^application\/(?:[^;]+\+)?json\b/i.test(type) : !/^(?:application|text)\/(?:atom\+xml|xml)\b/i.test(type)) throw failure('invalid_response', 'Scholarly source returned an unexpected content type')
        const body = await readBounded(response, requestSignal)
        return provider === 'crossref' ? crossrefResults(body, limit) : arxivResults(body, limit)
      } finally {
        response?.close?.()
        if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {})
      }
    }
    try {
      const results = await (provider === 'arxiv' ? serialArxiv(operation, signal) : operation())
      return { provider, status: results.length ? 'ok' : 'empty', results }
    } catch (error) {
      const code = error?.name === 'TimeoutError' ? 'timeout' : error?.code ?? 'network_error'
      return { provider, status: 'error', results: [], error: { code, message: code === 'network_error' ? 'Scholarly source could not be reached' : String(error.message).slice(0, 200) } }
    }
  }
  return {
    async search({ query, limit = SCHOLARLY_SEARCH_LIMITS.results } = {}, { signal: callerSignal } = {}) {
      if (typeof query !== 'string' || !query.trim() || query.length > SCHOLARLY_SEARCH_LIMITS.queryCharacters || /[\x00-\x1f\x7f]/.test(query)) throw new TypeError('Provide a public search query of 1–200 characters without control characters')
      if (!Number.isInteger(limit) || limit < 1 || limit > SCHOLARLY_SEARCH_LIMITS.results) throw new TypeError('limit must be an integer between 1 and 5')
      callerSignal?.throwIfAborted()
      query = query.trim()
      const signal = AbortSignal.any([...(callerSignal ? [callerSignal] : []), AbortSignal.timeout(SCHOLARLY_SEARCH_LIMITS.searchTimeoutMs)])
      const crossref = new URL('https://api.crossref.org/works')
      crossref.searchParams.set('query.bibliographic', query)
      crossref.searchParams.set('rows', String(limit))
      const arxiv = new URL('https://export.arxiv.org/api/query')
      // 将输入作为普通词项，而不是允许模型通过检索词改变查询语法。
      const terms = query.match(/[\p{L}\p{N}][\p{L}\p{N}\p{M}._-]*/gu)
      if (!terms?.length) throw new TypeError('Public search query must contain words or numbers')
      arxiv.searchParams.set('search_query', terms.map(term => `all:"${term}"`).join(' AND '))
      arxiv.searchParams.set('start', '0')
      arxiv.searchParams.set('max_results', String(limit))
      const providers = await Promise.all([source('crossref', crossref, signal, limit), source('arxiv', arxiv, signal, limit)])
      callerSignal?.throwIfAborted()
      // 仅按明确 DOI 或 arXiv ID 去重，不按相似标题合并不同论文。
      const results = []
      const seen = new Set()
      for (let index = 0; index < limit; index++) for (const provider of providers) {
        const item = provider.results[index]
        if (!item) continue
        const key = item.doi ? `doi:${item.doi.toLowerCase()}` : item.id
        if (seen.has(key)) continue
        seen.add(key)
        if (results.length < limit) results.push(item)
      }
      const errors = providers.filter(provider => provider.status === 'error').length
      return {
        status: errors === providers.length ? 'unavailable' : errors ? 'partial' : results.length ? 'ok' : 'empty',
        query, results,
        providers: providers.map(({ provider, status, results, error }) => ({ provider, status, count: results.length, ...(error ? { error } : {}) })),
        evidence_scope: 'Search results contain metadata or abstract excerpts only; full text was not retrieved. They do not establish scholarly consensus.',
      }
    },
  }
}
