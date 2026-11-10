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
const PUBLIC_METADATA_HOSTS = new Set(['api.crossref.org', 'api.datacite.org', 'export.arxiv.org'])

export function isDirectPDFURL(value) {
  if (typeof value !== 'string') return false
  try {
    const url = new URL(value)
    return /\.pdf$/i.test(decodeURIComponent(url.pathname)) ||
      (['arxiv.org', 'www.arxiv.org', 'export.arxiv.org'].includes(url.hostname) && url.pathname.startsWith('/pdf/'))
  } catch { return false }
}

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

async function requestPublic(value, ctx, kind, timeoutMs) {
  let url = publicURL(value)
  const signal = timeoutMs ? AbortSignal.any([ctx.signal, AbortSignal.timeout(timeoutMs)]) : ctx.signal
  for (let redirects = 0; redirects <= 5; redirects++) {
    signal.throwIfAborted()
    if (++ctx.requests > 16) throw new Error('Public request limit reached')
    const record = { url: url.href, kind }
    ctx.provenance.requests.push(record)
    let response
    try {
      const hostname = url.hostname.replace(/^\[|\]$/g, '')
      let answers = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await abortable(ctx.resolver(hostname), signal)
      // 部分本地代理用 198.18/15 作为 Fake-IP。仅对固定题录服务
      // 通过加密 DNS 取得真实公网地址，随后仍校验并固定连接地址。
      if(!ctx.options.resolver && PUBLIC_METADATA_HOSTS.has(hostname) && answers.length && answers.every(answer=>isIP(answer.address)===4&&v4In(answer.address,'198.18.0.0',15))) {
        const dnsSignal=AbortSignal.any([signal,AbortSignal.timeout(6000)]);
        const dns=await pinnedRequest({url:new URL(`https://1.1.1.1/dns-query?name=${encodeURIComponent(hostname)}&type=A`),address:'1.1.1.1',family:4,signal:dnsSignal,headers:{Accept:'application/dns-json'}});
        try {if(dns.statusCode!==200)throw Error('公开题录 DNS 查询失败');const data=JSON.parse(await readText({...dns,signal:dnsSignal},16384));answers=(data.Answer||[]).filter(row=>row.type===1).map(row=>({address:row.data,family:4}));record.dns_provider='Cloudflare DoH';}finally{dns.close();}
      }
      if (!Array.isArray(answers) || !answers.length || answers.some(answer => !isPublicAddress(answer.address) || isLocalInterface(answer.address) || isIP(answer.address) !== answer.family)) throw new Error('DNS resolved to a private, local, reserved, or invalid address')
      const { address, family } = answers.find(answer => answer.family === 4) ?? answers[0]
      const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(15_000)])
      response = await abortable(ctx.transport({ url, address, family, signal: requestSignal, headers: {
        'User-Agent': USER_AGENT, Accept: kind === 'metadata' ? 'application/json, application/atom+xml, application/xml;q=0.9' : kind === 'landing-metadata' ? 'text/html, application/xhtml+xml;q=0.9' : 'application/pdf, text/html;q=0.9, */*;q=0.1',
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

async function readText(response, limit = TEXT_LIMIT, metadataOnly = false) {
  if (metadataOnly && /application\/pdf/i.test(response.headers['content-type'] ?? '')) {
    response.close?.()
    throw Object.assign(new Error('Metadata refresh does not download PDFs; provide a DOI or article landing URL'), { code:'PUBLIC_PDF_URL' })
  }
  const length = Number(response.headers['content-length'])
  if (Number.isFinite(length) && length > limit) { response.close?.(); throw new Error('Metadata or landing page exceeds 2 MiB limit') }
  const chunks = []
  let size = 0
  let signatureChecked = false
  try {
    const iterator = response.body[Symbol.asyncIterator]()
    while (true) {
      const next = await abortable(iterator.next(), response.signal)
      if (next.done) break
      const chunk = next.value
      size += chunk.length
      if (size > limit) throw new Error('Metadata or landing page exceeds 2 MiB limit')
      chunks.push(Buffer.from(chunk))
      if (metadataOnly && !signatureChecked && size >= 5) {
        signatureChecked = true
        if (Buffer.concat(chunks, size).subarray(0, 5).toString('ascii') === '%PDF-') throw Object.assign(new Error('Metadata refresh received a PDF; stopped after its signature'), { code:'PUBLIC_PDF_URL' })
      }
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

// Partial dates preserve source precision; never synthesize January 1 or accept
// Date.parse rollover. Crossref created/deposited are registry dates, not history:
// https://github.com/CrossRef/rest-api-doc/blob/master/api_format.md
function partialDate(value) {
  const raw = Array.isArray(value?.['date-parts']?.[0]) ? value['date-parts'][0] : value
  const parts = Array.isArray(raw) ? raw : typeof raw === 'string' && /^\d{4}(?:[-/]\d{1,2}){0,2}$/.test(raw.trim()) ? raw.trim().split(/[-/]/).map(Number) : []
  if (!parts.length || parts.length > 3 || parts.some(part => !Number.isInteger(part))) return undefined
  const [year, month, day] = parts
  if (year < 1 || year > 9999 || month !== undefined && (month < 1 || month > 12)) return undefined
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  if (day !== undefined && (day < 1 || day > [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1])) return undefined
  return parts.map((part, index) => String(part).padStart(index ? 2 : 4, '0')).join('-')
}

function affiliations(value, warnings = []) {
  if (!Array.isArray(value)) return []
  const names = value.map(entry => clean(typeof entry === 'string' ? entry : entry?.name)).filter(Boolean)
  const valid = [...new Set(names.filter(name => name.length <= 500))]
  if (names.some(name => name.length > 500) || valid.length > 30) warnings.push('Some affiliations exceed the 30-institution / 500-character limits and were omitted; review the source metadata')
  return valid.slice(0, 30).map(name => ({ name }))
}

function sourceDates(entries) {
  return Object.fromEntries(entries.flatMap(([key, value]) => {
    const date = partialDate(value)
    return date ? [[key, date]] : []
  }))
}

export function normalizeDOI(value) {
  let doi = String(value).trim().replace(/^doi:\s*/i, '')
  if (/^https?:\/\/(?:dx\.)?doi\.org\//i.test(doi)) doi = decodeURIComponent(new URL(doi).pathname.slice(1))
  if (doi.length > 512 || !DOI.test(doi)) throw new Error('Invalid DOI')
  return doi
}

function crossrefCSL(item, doi, ctx) {
  if (item.DOI && String(item.DOI).toLowerCase() !== doi.toLowerCase()) throw new Error('Crossref returned metadata for a different DOI')
  const type = { 'journal-article': 'article-journal', 'proceedings-article': 'paper-conference', 'book-chapter': 'chapter', book: 'book', 'edited-book': 'book', report: 'report', dissertation: 'thesis', dataset: 'dataset' }[item.type] ?? 'article'
  const csl = { id: doi, type, DOI: doi, title: clean(first(item.title)), URL: item.URL || `https://doi.org/${doi}` }
  if(item.type==='posted-content'&&item.subtype==='preprint')csl.genre='Preprint'
  for (const role of ['author','editor']) if (Array.isArray(item[role])) csl[role] = item[role].slice(0, 100).filter(person => person && typeof person === 'object').map(person => {
    const author = person.family ? { family: clean(person.family), ...(person.given ? { given: clean(person.given) } : {}) } : { literal: clean(person.name || person.given) }
    const affiliation = affiliations(person.affiliation, ctx.warnings)
    if (affiliation.length) author.affiliation = affiliation
    return author
  }).filter(person => person.family || person.literal)
  for (const [key, value] of Object.entries({ 'container-title': first(item['container-title']), volume: item.volume, issue: item.issue, page: item.page, number: item['article-number'], publisher: item.publisher, abstract: item.abstract })) if (value) csl[key] = clean(value)
  const dates = sourceDates([['published', item.published], ['online', item['published-online']], ['print', item['published-print']], ['accepted', item.accepted]])
  if (Object.keys(dates).length) csl.publication_dates = dates
  const issued = [item.published, item['published-print'], item['published-online'], item.issued].map(partialDate).find(Boolean)
  if (issued) csl.issued = { 'date-parts': [issued.split('-').map(Number)] }
  for (const key of ['ISSN', 'ISBN']) if (Array.isArray(item[key])) csl[key] = item[key].filter(value => typeof value === 'string').slice(0, 20).map(clean)
  return csl
}

async function doiMetadata(doi, ctx) {
  const response = await requestPublic(`https://api.crossref.org/works/${encodeURIComponent(doi)}`, ctx, 'metadata')
  const data = JSON.parse(await readText(response))
  if (!data.message || typeof data.message !== 'object') throw new Error('Crossref response has no work metadata')
  if (typeof data.message.DOI !== 'string' || !data.message.DOI.trim()) throw new Error('Crossref response has no DOI')
  const metadata = crossrefCSL(data.message, doi, ctx)
  const links = Array.isArray(data.message.link) ? data.message.link : []
  const candidates = links.filter(link => link?.['content-type'] === 'application/pdf' || /\.pdf(?:$|[?#])/i.test(link?.URL ?? '')).map(link => link.URL).filter(value => typeof value === 'string').slice(0, 3)
  if (data.message.resource?.primary?.URL) candidates.push(data.message.resource.primary.URL)
  if (data.message.URL) candidates.push(data.message.URL)
  candidates.push(`https://doi.org/${doi}`)
  const landingCandidates = [data.message.resource?.primary?.URL, data.message.URL, `https://doi.org/${doi}`].filter(value => typeof value === 'string')
  return { metadata, candidates, landingCandidates }
}

const dataciteTypes = {
  JournalArticle:'article-journal', ConferencePaper:'paper-conference', Book:'book', BookChapter:'chapter',
  Dissertation:'thesis', Report:'report', Preprint:'article', Text:'article', DataPaper:'article-journal', Dataset:'dataset',
}
function dataciteCSL(record) {
  const a = record?.attributes, kind = a?.types?.resourceTypeGeneral
  if (!Object.hasOwn(dataciteTypes, kind)) return undefined
  const doi = normalizeDOI(a.doi), title = clean(a.titles?.[0]?.title)
  if (!title) return undefined
  const metadata = { type:dataciteTypes[kind], DOI:doi, title, URL:`https://doi.org/${doi}` }
  if(kind==='Preprint')metadata.genre='Preprint'
  if(kind==='Dataset'&&a.version)metadata.version=clean(a.version)
  const abstracts=(Array.isArray(a.descriptions)?a.descriptions:[]).filter(value=>value?.descriptionType==='Abstract'&&typeof value.description==='string').slice(0,2)
  if(abstracts.length===1)metadata.abstract=clean(abstracts[0].description)
  const authors = Array.isArray(a.creators) ? a.creators.slice(0, 100).filter(Boolean).map(person => {
    if (person.familyName && person.nameType !== 'Organizational') {
      return { family:clean(person.familyName), ...(person.givenName ? { given:clean(person.givenName) } : {}) }
    }
    return { literal:clean(person.name) }
  }).filter(person => person.family || person.literal) : []
  if (authors.length) metadata.author = authors
  const year = Number(a.publicationYear)
  if (Number.isInteger(year) && year > 0 && year < 10000) metadata.issued = { 'date-parts':[[year]] }
  const parents = Array.isArray(a.relatedItems) ? a.relatedItems.filter(item => item?.relationType === 'IsPublishedIn') : []
  const parent = parents.length === 1 ? parents[0] : undefined
  const first = clean(parent?.firstPage), last = clean(parent?.lastPage)
  const publisher = parent?.publisher || (typeof a.publisher === 'string' ? a.publisher : a.publisher?.name)
  for (const [key,value] of Object.entries({ 'container-title':parent?.titles?.[0]?.title, publisher, volume:parent?.volume,
    issue:parent?.issue, page:first && last && first !== last ? `${first}-${last}` : first,
    number:parent?.numberType === 'Article' ? parent.number : undefined })) {
    if (value) metadata[key] = clean(value)
  }
  return metadata
}

function exactTitleRecords(rows, expected, titleOf, doiOf) {
  const matches = new Map()
  if (Array.isArray(rows)) for (const row of rows.slice(0, 5)) {
    if (identityText(titleOf(row)) !== expected) continue
    try { matches.set(normalizeDOI(doiOf(row)).toLowerCase(), row) } catch { /* Invalid identifiers are not candidates. */ }
  }
  return [...matches.values()]
}

/** 用户明确补全当前条目时，按题名检索公开题录；不发送 PDF 文本。 */
export async function resolveTitleMetadata(title, options = {}) {
  if(typeof title!=='string'||title.trim().length<8||title.length>1000)throw new Error('题名过短或过长，请先核对文献标题。')
  const ctx=context(options,title), expected=identityText(title);
  let metadata;
  try {
    const response=await requestPublic(`https://api.crossref.org/works?query.title=${encodeURIComponent(title)}&rows=5`,ctx,'metadata',11000);
    const data=JSON.parse(await readText(response));
    const matches=exactTitleRecords(data.message?.items,expected,item=>first(item?.title),item=>item?.DOI)
      .filter(item=>(!options.publishedOnly || item.type !== 'posted-content')&&(!options.doiType ||
        item.type===({'article-journal':'journal-article','paper-conference':'proceedings-article',preprint:'posted-content',dataset:'dataset'}[options.doiType])&&
        (options.doiType!=='preprint'||item.subtype==='preprint')));
    if(matches.length===1){
      metadata=crossrefCSL(matches[0],normalizeDOI(matches[0].DOI),ctx);
      if(matches[0].type==='posted-content')ctx.warnings.push('找到同题名的预印本或早期稿 DOI，请核对引用版本。');
    }
    else if(matches.length>1)ctx.warnings.push('题名对应多个 DOI，请指定 DOI 后再补全。');
    if(matches.length>1)return {metadata,ambiguous:true,provenance:ctx.provenance,warnings:ctx.warnings};
  }catch(error){warn(ctx,error)}
  if (!metadata && !options.crossrefOnly) try {
    // Phrase search supplies candidates. Accept only an exact title and a DOI
    // registered for the requested version of the work.
    const escaped = title.replace(/["\\]/g, ' ')
    const response = await requestPublic(`https://api.datacite.org/dois?query=${encodeURIComponent(`titles.title:"${escaped}"`)}&page%5Bsize%5D=5`,ctx,'metadata',8000)
    const data = JSON.parse(await readText(response))
    const matches = exactTitleRecords(data.data,expected,row=>row?.attributes?.titles?.[0]?.title,row=>row?.attributes?.doi)
      .filter(row=>(!options.publishedOnly || !['Preprint','Text'].includes(row.attributes.types?.resourceTypeGeneral))&&
        (!options.doiType || row.attributes.types?.resourceTypeGeneral===({'article-journal':'JournalArticle','paper-conference':'ConferencePaper',preprint:'Preprint',dataset:'Dataset'}[options.doiType])&&
          (options.doiType!=='dataset'||!row.attributes.version&&!row.attributes.relatedIdentifiers?.some(link=>link.relationType==='IsVersionOf'))))
      .map(dataciteCSL).filter(Boolean)
    if (matches.length > 1) {
      ctx.warnings.push('DataCite 找到多个同题名 DOI，请提供该出版版本的 DOI。')
      return { metadata, ambiguous:true, provenance:ctx.provenance, warnings:ctx.warnings }
    }
    metadata = matches[0]
    if (metadata?.type === 'article' && /^10\.48550\/arxiv\./i.test(metadata.DOI)) ctx.warnings.push('找到同题名的 arXiv 预印本 DOI，请核对引用版本。')
  } catch(error) { warn(ctx,error) }
  if(!metadata&&!options.crossrefOnly&&!options.publishedOnly&&!options.doiType)try{
    const response=await requestPublic(`https://export.arxiv.org/api/query?search_query=${encodeURIComponent('ti:"'+title.replace(/"/g,'')+'"')}&max_results=5`,ctx,'metadata');
    const xml=await readText(response);if(/<!DOCTYPE|<!ENTITY/i.test(xml))throw new Error('Unexpected XML document entities');
    const matches=[...xml.matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/gi)].map(match=>match[1]).filter(entry=>identityText(entry.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]||'')===expected);
    if(matches.length===1){const id=arxivID(clean(matches[0].match(/<id[^>]*>([\s\S]*?)<\/id>/i)?.[1]));if(id)metadata=await arxivMetadata(id,ctx);}
    else if(matches.length>1)ctx.warnings.push('arXiv 返回多个同题名条目，请指定论文链接。');
  }catch(error){warn(ctx,error)}
  return {metadata,provenance:ctx.provenance,warnings:ctx.warnings};
}

/** Resolve a recognized DOI for local-PDF enrichment; does not download a PDF. */
export async function resolveDOIMetadata(value, options = {}) {
  const doi = normalizeDOI(value)
  const ctx = context(options, doi)
  let result = { candidates: [`https://doi.org/${doi}`] }
  try {
    if(options.doiType==='preprint'&&/^10\.48550\/arxiv\./i.test(doi)){
      const response=await requestPublic(`https://api.datacite.org/dois/${encodeURIComponent(doi)}`,ctx,'metadata');
      const metadata=dataciteCSL(JSON.parse(await readText(response)).data);
      if(metadata?.DOI.toLowerCase()!==doi.toLowerCase())throw Error('DataCite returned no metadata for the requested DOI');
      result={metadata};
    }else result=await doiMetadata(doi,ctx);
  } catch (error) { warn(ctx, error) }
  return { ...result, provenance: ctx.provenance, warnings: ctx.warnings }
}

function attrs(tag) {
  const result = {}
  for (const match of tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) result[match[1].toLowerCase()] = decode(match[2] ?? match[3] ?? match[4])
  return result
}

function landingMetadata(html, url, ctx) {
  const meta = new Map()
  const citationAuthors = []
  let currentAuthor
  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    const attributes = attrs(match[0])
    const key = (attributes.name ?? attributes.property ?? '').toLowerCase()
    if (key && attributes.content) meta.set(key, [...(meta.get(key) ?? []), attributes.content.slice(0, 20_000)].slice(0, 100))
    // Highwire's institution tag belongs to the immediately preceding author;
    // do not zip a separate institution list to author indices.
    if (key === 'citation_author') {
      const literal = clean(attributes.content)
      currentAuthor = literal && citationAuthors.length < 100 ? { literal } : undefined
      if (currentAuthor) citationAuthors.push(currentAuthor)
    } else if (['citation_author_institution', 'citation_author_affiliation'].includes(key) && currentAuthor) {
      const affiliation = affiliations([...(currentAuthor.affiliation ?? []), { name: attributes.content }], ctx.warnings)
      if (affiliation.length) currentAuthor.affiliation = affiliation
    }
  }
  const get = key => first(meta.get(key))
  const conference = get('citation_conference_title'), journal = get('citation_journal_title');
  const metadata = { type: conference ? 'paper-conference' : journal ? 'article-journal' : 'article', URL: url }
  const title = get('citation_title') ?? get('dc.title') ?? get('og:title')
  if (title) metadata.title = clean(title)
  const abstract=get('citation_abstract')??get('dc.description.abstract')
  if(abstract)metadata.abstract=clean(abstract)
  const authors = meta.get('dc.creator')
  if (citationAuthors.length) metadata.author = citationAuthors
  else if (authors) metadata.author = authors.map(name => ({ literal: clean(name) })).filter(person => person.literal)
  const doi = get('citation_doi') ?? get('dc.identifier')
  if (doi) { try { metadata.DOI = normalizeDOI(doi) } catch {} }
  const dates = sourceDates([
    ['published', get('citation_publication_date') ?? get('citation_date')],
    ['online', get('citation_online_date') ?? get('citation_publication_date_online')],
    ['print', get('citation_print_date') ?? get('citation_publication_date_print')],
    ['received', get('citation_date_received') ?? get('citation_received_date') ?? get('dc.date.received')],
    ['accepted', get('citation_date_accepted') ?? get('citation_accepted_date') ?? get('dc.date.accepted')],
  ])
  if (Object.keys(dates).length) metadata.publication_dates = dates
  const date = dates.published ?? dates.print ?? dates.online ?? partialDate(get('dc.date'))
  if (date) metadata.issued = { 'date-parts': [date.split('-').map(Number)] }
  const firstPage = get('citation_firstpage'), lastPage = get('citation_lastpage');
  const pages = firstPage && lastPage && firstPage !== lastPage ? `${firstPage}-${lastPage}` : firstPage;
  for (const [key, value] of [['container-title', conference || journal], ['volume', get('citation_volume')], ['issue', get('citation_issue')], ['page', pages], ['number', get('citation_article_number')], ['publisher', get('citation_publisher')]]) if (value) metadata[key] = clean(value)
  const candidates = [...(meta.get('citation_pdf_url') ?? [])]
  for (const match of html.matchAll(/<(?:link|a)\b[^>]*>/gi)) {
    const attributes = attrs(match[0])
    if (attributes.href && (attributes.type?.toLowerCase() === 'application/pdf' || /\.pdf(?:$|[?#])/i.test(attributes.href))) candidates.push(attributes.href)
    if (candidates.length >= 12) break
  }
  return { metadata: metadata.title || metadata.DOI ? metadata : undefined, candidates: candidates.slice(0, 12).flatMap(candidate => { try { return [new URL(candidate, url).href] } catch { return [] } }) }
}

const identityText = value => clean(value).normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
const authorNames = person => person.literal ? [identityText(person.literal)] : [identityText(`${person.given ?? ''} ${person.family ?? ''}`), identityText(`${person.family ?? ''} ${person.given ?? ''}`)]

function mergeMetadata(primary, supplement, ctx) {
  if (!primary) return supplement
  if (!supplement) return primary
  const bothDOI = primary.DOI && supplement.DOI
  if (bothDOI && primary.DOI.toLowerCase() !== supplement.DOI.toLowerCase()) throw new Error('Landing page identifies a different DOI; its metadata and PDF links were not used')
  const title = identityText(primary.title)
  if (!bothDOI && !(title.length >= 8 && title === identityText(supplement.title))) {
    ctx.warnings.push('Supplementary landing metadata has no matching DOI or exact title; it was not merged')
    return primary
  }
  const metadata = { ...supplement, ...primary }
  const dates = { ...supplement.publication_dates, ...primary.publication_dates }
  if (Object.keys(dates).length) metadata.publication_dates = dates
  if (primary.author?.length && supplement.author?.length) {
    metadata.author = primary.author.map(person => {
      if (person.affiliation?.length) return person
      const names = authorNames(person)
      const matches = supplement.author.filter(candidate => authorNames(candidate).some(name => name && names.includes(name)))
      return matches.length === 1 && matches[0].affiliation?.length ? { ...person, affiliation: matches[0].affiliation } : person
    })
  } else if (!primary.author?.length && supplement.author?.length) metadata.author = supplement.author
  return metadata
}

export function arxivID(value) {
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
  metadata.author = [...entry.matchAll(/<author\b[^>]*>([\s\S]*?)<\/author>/gi)].slice(0, 100).map(match => {
    const author = { literal: clean(match[1].match(/<name\b[^>]*>([\s\S]*?)<\/name>/i)?.[1]) }
    const affiliation = affiliations([...match[1].matchAll(/<arxiv:affiliation\b[^>]*>([\s\S]*?)<\/arxiv:affiliation>/gi)].map(value => clean(value[1])), ctx.warnings)
    if (affiliation.length) author.affiliation = affiliation
    return author
  }).filter(person => person.literal)
  const published = field('published')
  const date = /^\d{4}-\d{2}-\d{2}(?:T|$)/.test(published) ? partialDate(published.slice(0, 10)) : undefined
  // arXiv's published means first-version submission, not journal publication.
  // Keep the preprint citation date without inventing editorial-history dates.
  // https://info.arxiv.org/help/api/user-manual.html#3321-title-id-published-and-updated
  if (date) metadata.issued = { 'date-parts': [date.split('-').map(Number)] }
  if (field('summary')) metadata.abstract = field('summary')
  if (field('arxiv:doi')) { try { metadata.DOI = normalizeDOI(field('arxiv:doi')) } catch {} }
  return metadata
}

/** Bounded metadata refresh: no file writes, PDF candidates, model or library access.
 * Caller must validate the returned identity before updating an existing record.
 * JCR is deliberately absent: year/category rankings require a sourced import or
 * manual record, and cannot be derived from Crossref citation counts or an IF.
 */
export async function resolveMetadata(target, options = {}) {
  if (typeof target !== 'string' || !target.trim() || target.length > 4096) throw new Error('Provide a DOI, arXiv ID, or public article landing URL')
  target = target.trim()
  const ctx = context(options, target)
  let metadata, doi, pdfURL = false
  try { doi = normalizeDOI(target) } catch {}
  try {
    if (doi) {
      let candidates = [`https://doi.org/${doi}`]
      try {
        const result = await doiMetadata(doi, ctx)
        metadata = result.metadata
        candidates = result.landingCandidates
      } catch (error) { warn(ctx, error) }
      if (!metadata) try {
        const response = await requestPublic(`https://api.datacite.org/dois/${encodeURIComponent(doi)}`, ctx, 'metadata')
        const record = JSON.parse(await readText(response)).data
        const item = dataciteCSL(record)
        if (!item || item.DOI.toLowerCase() !== doi.toLowerCase()) throw new Error('DataCite returned no metadata for the requested DOI')
        metadata = item
        candidates = []
      } catch (error) { warn(ctx, error) }
      // One landing page can supply explicit editorial dates missing in Crossref.
      // PDF links are never followed by this metadata-only path.
      const landingURL = candidates.find(value => !/\.pdf(?:$|[?#])/i.test(value))
      if (landingURL) {
        const response = await requestPublic(landingURL, ctx, 'landing-metadata')
        const landing = landingMetadata(await readText(response, TEXT_LIMIT, true), response.url, ctx)
        if (landing.metadata?.DOI && landing.metadata.DOI.toLowerCase() !== doi.toLowerCase()) throw new Error('Landing page identifies a different DOI')
        // Without a successful Crossref record, the landing must assert the DOI.
        if (!metadata && landing.metadata?.DOI?.toLowerCase() !== doi.toLowerCase()) throw new Error('Landing metadata does not establish the requested DOI')
        metadata = mergeMetadata(metadata, landing.metadata, ctx)
      }
    } else {
      const id = arxivID(target)
      if (id) metadata = await arxivMetadata(id, ctx)
      else {
        const url = publicURL(target)
        if (/\.pdf$/i.test(url.pathname)) throw new Error('Metadata refresh needs a DOI or article landing URL, not a PDF URL')
        const response = await requestPublic(url.href, ctx, 'landing-metadata')
        const landing = landingMetadata(await readText(response, TEXT_LIMIT, true), response.url, ctx)
        metadata = landing.metadata
        if (metadata?.DOI) {
          try {
            const result = await doiMetadata(metadata.DOI, ctx)
            metadata = mergeMetadata(result.metadata, metadata, ctx)
          } catch (error) { warn(ctx, error) }
        }
      }
    }
  } catch (error) { pdfURL = error.code === 'PUBLIC_PDF_URL'; warn(ctx, error) }
  ctx.options.signal?.throwIfAborted()
  if (ctx.signal.aborted) ctx.warnings.push('Metadata refresh deadline reached')
  if (!metadata && !ctx.warnings.length) ctx.warnings.push('The article page exposed no supported bibliographic metadata')
  return { status: metadata ? 'metadata_only' : 'unavailable', metadata, ...(pdfURL ? { pdf_url:true } : {}), provenance: { ...ctx.provenance, kind: 'metadata-refresh' }, warnings: [...new Set(ctx.warnings)] }
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
      const landing = landingMetadata(result.html, response.url, ctx)
      metadata = mergeMetadata(metadata, landing.metadata, ctx)
      if (candidate.depth < 2) landing.candidates.forEach(url => add(url, candidate.depth + 1))
      if (!landing.candidates.length) ctx.warnings.push('Landing page exposed no public PDF link; no login, cookies, or paywall bypass attempted')
    } catch (error) { warn(ctx, error) }
  }
  ctx.options.signal?.throwIfAborted()
  if (ctx.signal.aborted) ctx.warnings.push('Public acquisition deadline reached')
  if (ctx.requests >= 16) ctx.warnings.push('Public request limit reached')
  return { status: metadata ? 'metadata_only' : 'unavailable', metadata, provenance: ctx.provenance, warnings: [...new Set(ctx.warnings)] }
}
