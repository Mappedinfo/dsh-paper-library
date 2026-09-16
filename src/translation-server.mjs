/** Optional Zotero translation-server client: an external, loopback-only sidecar.
 *
 * The server is never bundled or spawned by this plugin. Only identifiers and
 * public URLs are sent — PDF text, notes and private drafts never leave through
 * this path. Responses are treated as untrusted data and pass the same identity
 * gates (exact DOI or exact normalized title) as every other metadata source.
 */

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]'])
const MAX_BODY = 1024 * 1024
const fail = (message, code = 'TRANSLATION_SERVER_INVALID', status = 400) => Object.assign(new Error(message), { code, status })

export function translationServerUrl(value) {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string' || value.length > 500) throw fail('translationServer 配置无效。')
  let url
  try { url = new URL(value) } catch { throw fail('translationServer 配置无效。') }
  if (url.protocol !== 'http:' || !LOOPBACK.has(url.hostname) || url.username || url.password || url.pathname !== '/' && url.pathname !== '' || url.search || url.hash) {
    throw fail('translationServer 只接受绑定本机回环的 http 地址（如 http://127.0.0.1:1969）。')
  }
  return url.origin
}

async function defaultTransport({ url, body }) {
  const response = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'text/plain', Accept: 'application/json' }, body,
    signal: AbortSignal.timeout(15000), redirect: 'error',
  })
  const reader = response.body?.getReader()
  let text = '', bytes = 0
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > MAX_BODY) throw fail('translation-server 响应超过 1 MiB 预算。', 'TRANSLATION_SERVER_BUDGET', 502)
      text += new TextDecoder().decode(value, { stream: true })
    }
  }
  return { statusCode: response.status, text }
}

const IDENTIFIER = /^(10\.\d{4,9}\/\S+|(\d{4}\.\d{4,5}|[a-z-]+(\.[A-Z]{2})?\/\d{7})(v\d+)?|pubmed:\d+|[\dX-]{10,17})$/i

/** Map a Zotero API item into this plugin's bibliographic metadata shape.
 * Missing or unparsable values stay absent; nothing is inferred. */
export function zoteroItemToMetadata(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return {}
  const metadata = {}
  const text = (value, max = 4000) => typeof value === 'string' && value.trim() && value.length <= max ? value.trim() : undefined
  if (text(item.title)) metadata.title = text(item.title)
  const type = { journalArticle: 'article-journal', magazineArticle: 'article-magazine', newspaperArticle: 'article-newspaper', conferencePaper: 'paper-conference', book: 'book', bookSection: 'chapter', report: 'report', thesis: 'thesis', preprint: 'article', webpage: 'webpage', document: 'document', dataset: 'dataset', computerProgram: 'software' }[item.itemType]
  if (type) metadata.type = type
  if (Array.isArray(item.creators)) {
    const authors = item.creators.filter(creator => creator && creator.creatorType === 'author').slice(0, 200).map(creator => {
      if (text(creator.lastName, 500)) return { family: text(creator.lastName, 500), ...(text(creator.firstName, 500) ? { given: text(creator.firstName, 500) } : {}) }
      if (text(creator.name, 500)) return { literal: text(creator.name, 500) }
      return null
    }).filter(Boolean)
    if (authors.length) metadata.author = authors
  }
  if (text(item.DOI, 300)) metadata.DOI = text(item.DOI, 300)
  if (text(item.url, 2000)) metadata.URL = text(item.url, 2000)
  if (text(item.abstractNote)) metadata.abstract = text(item.abstractNote)
  const container = text(item.publicationTitle, 500) || text(item.proceedingsTitle, 500) || (type !== 'book' && type !== 'report' ? text(item.bookTitle, 500) : undefined)
  if (container) metadata['container-title'] = container
  if (text(item.publisher, 500)) metadata.publisher = text(item.publisher, 500)
  for (const [from, to] of [['volume', 'volume'], ['issue', 'issue'], ['pages', 'page'], ['ISBN', 'ISBN'], ['ISSN', 'ISSN'], ['editionNumber', 'edition'], ['series', 'collection-title']]) {
    if (text(item[from], 200)) metadata[to] = text(item[from], 200)
  }
  if (text(item.date, 100)) {
    const match = item.date.match(/(\d{4})(?:[-/.\s](\d{1,2}))?(?:[-/.\s](\d{1,2}))?/)
    if (match) {
      const parts = [Number(match[1])]
      if (match[2] && Number(match[2]) >= 1 && Number(match[2]) <= 12) parts.push(Number(match[2]))
      if (match[3] && parts.length === 2 && Number(match[3]) >= 1 && Number(match[3]) <= 31) parts.push(Number(match[3]))
      if (parts[0] >= 1000 && parts[0] <= 2999) metadata.issued = { 'date-parts': [parts] }
    }
  }
  return metadata
}

export function createTranslationServerClient(options = {}) {
  const origin = translationServerUrl(typeof options === 'string' ? options : options.url)
  if (!origin) throw fail('translationServer 未配置。', 'TRANSLATION_SERVER_UNAVAILABLE', 503)
  const transport = options.transport ?? defaultTransport
  if (typeof transport !== 'function') throw fail('transport 是内部测试接缝。')
  async function call(endpoint, payload) {
    if (typeof payload !== 'string' || !payload.trim() || Buffer.byteLength(payload) > 4096) throw fail('提交给 translation-server 的内容无效。')
    const result = await transport({ url: `${origin}/${endpoint}`, body: payload.trim() })
    if (!result || result.statusCode !== 200 || typeof result.text !== 'string') throw fail(`translation-server 未返回可用结果（HTTP ${result?.statusCode ?? '无响应'}）。`, 'TRANSLATION_SERVER_UNAVAILABLE', 502)
    let items
    try { items = JSON.parse(result.text) } catch { throw fail('translation-server 返回了无法解析的响应。', 'TRANSLATION_SERVER_INVALID', 502) }
    if (!Array.isArray(items)) throw fail('translation-server 返回了无法解析的响应。', 'TRANSLATION_SERVER_INVALID', 502)
    return items.slice(0, 20)
  }
  return {
    origin,
    async lookup(target) {
      const value = String(target || '').trim()
      if (!value || value.length > 4096) throw fail('缺少可核验的标识符或链接。')
      const isUrl = /^https?:\/\//i.test(value)
      if (!isUrl && !IDENTIFIER.test(value.replace(/^doi:\s*/i, ''))) throw fail('translation-server 仅用于 DOI、ISBN、PMID、arXiv 或公开页面链接。')
      const items = await call(isUrl ? 'web' : 'search', value)
      return items.map(zoteroItemToMetadata).filter(item => item.title)
    },
  }
}
