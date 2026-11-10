import { validatePaperComparison } from './field-radar-table.mjs'
import { createRelationsStore } from './field-radar-relations.mjs'
/** Explicit, bounded research imports. No model, remote fetch, PDF access or author-name merging. */
import { createHash } from 'node:crypto'
import { validateRadarTranslations } from './field-radar-i18n.mjs'
import { validateRadarGeography } from './field-radar-analytics.mjs'
import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { join, isAbsolute } from 'node:path'
import { LocalStateConflictError } from '../local-state.mjs'
export const FIELD_RADAR_LIMITS = Object.freeze({ bytes: 1024 * 1024, papers: 500, scholars: 300, sources: 1000, claims: 1000, matchPage: 20, candidates: 50 })
const fail = (message, code = 'FIELD_RADAR_INVALID', status = 400) => Object.assign(new Error(message), { code, status })
const hash = text => createHash('sha256').update(text).digest('hex')
const id = value => { if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$/.test(value)) throw fail('雷达标识须为 1–120 个字母、数字、点、下划线或短横线。'); return value }
const string = (value, label, max = 10000) => { if (typeof value !== 'string' || !value.trim() || value.length > max) throw fail(`${label}不能为空且须在长度上限内。`); return value }
const safeURL = value => { if (value == null || value === '') return; if (typeof value !== 'string' || value.length > 10000) throw fail('来源网址必须是有界文本。'); let url; try { url = new URL(value) } catch { throw fail('来源网址无效。') } if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw fail('来源网址只接受无凭据的 HTTP(S) 链接。') }
const doi = value => String(value || '').trim().replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '').replace(/^doi:\s*/i, '').toLowerCase()
const title = value => String(value || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
function page(input, maximum = 50) { const offset = input.offset ?? 0, limit = input.limit ?? 20; if (!Number.isSafeInteger(offset) || offset < 0 || offset > 10000 || !Number.isSafeInteger(limit) || limit < 1 || limit > maximum) throw fail('分页参数超出范围。'); return { offset, limit } }
export function validateFieldRadarDocument(input) {
  let text; try { text = JSON.stringify(input) } catch { throw fail('雷达资料必须是 JSON。') }
  if (!text || Buffer.byteLength(text) > FIELD_RADAR_LIMITS.bytes) throw fail('雷达资料超过 1 MiB。', 'FIELD_RADAR_TOO_LARGE', 413)
  const doc = JSON.parse(text)
  if (!doc || doc.schema_version !== 1 || !doc.topic || typeof doc.topic !== 'object') throw fail('需要 schema_version:1 与 topic。')
  if (Buffer.byteLength(JSON.stringify(doc.topic)) > 16000) throw fail('主题描述超过 16 KiB。')
  id(doc.topic.id); string(doc.topic.title, '主题标题', 500); string(doc.topic.question, '研究问题')
  const collections = {}
  for (const key of ['sources', 'papers', 'scholars', 'claims']) {
    if (!Array.isArray(doc[key]) || doc[key].length > FIELD_RADAR_LIMITS[key]) throw fail(`${key} 条目超出上限或不是数组。`)
    collections[key] = new Set()
    for (const row of doc[key]) { if (!row || typeof row !== 'object' || Array.isArray(row)) throw fail(`${key} 条目无效。`); id(row.id); if (collections[key].has(row.id)) throw fail(`${key} 存在重复标识。`); collections[key].add(row.id) }
  }
  const refs = row => { if (!row || typeof row !== 'object' || !Array.isArray(row.source_ids) || row.source_ids.some(value => !collections.sources.has(value))) throw fail('source_ids 缺失或引用不存在的来源。') }
  for (const source of doc.sources) { string(source.title, '来源标题', 2000); string(source.url, '来源网址', 10000); safeURL(source.url); if (source.accessed_at != null && (typeof source.accessed_at !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(source.accessed_at) || !Number.isFinite(Date.parse(source.accessed_at)) || new Date(source.accessed_at.slice(0, 10)).toISOString().slice(0, 10) !== source.accessed_at.slice(0, 10))) throw fail('来源访问日期无效；未知日期请留空。') }
  for (const paper of doc.papers) { string(paper.title, '论文标题', 2000); refs(paper); if(paper.comparison!==undefined)paper.comparison=validatePaperComparison(paper.comparison,doc); if (paper.year != null && (!Number.isInteger(paper.year) || paper.year < 1000 || paper.year > 9999)) throw fail('论文年份无效；未知年份请留空。') }
  for (const scholar of doc.scholars) { string(scholar.name, '学者姓名', 500); refs(scholar); if (!Array.isArray(scholar.contributions) || scholar.contributions.length > 500) throw fail('学者贡献条目无效。'); for (const row of scholar.contributions) { refs(row); if (row.paper_id != null && !collections.papers.has(row.paper_id)) throw fail('学者贡献引用不存在的论文。') } }
  for (const claim of doc.claims) { string(claim.text, '论断'); refs(claim) }
  const queue = [{ value: doc, depth: 0 }]; let count = 0
  while (queue.length) { const { value, depth } = queue.pop(); if (++count > 50000 || depth > 24) throw fail('资料嵌套过深或节点过多。'); if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) { if (['__proto__', 'constructor', 'prototype'].includes(key)) throw fail('资料包含不安全字段。'); if (key === 'url' || key.endsWith('_url')) safeURL(child); if (key === 'source_ids' && (!Array.isArray(child) || child.some(id => !collections.sources.has(id)))) throw fail('扩展研究记录引用未知来源。'); if (['paper_ids','scholar_ids'].includes(key) && (!Array.isArray(child) || child.some(id => !collections[key === 'paper_ids' ? 'papers' : 'scholars'].has(id)))) throw fail('研究关系引用未知实体。'); if (['source_paper_id','target_paper_id'].includes(key) && child != null && !collections.papers.has(child)) throw fail('研究关系引用未知论文。'); queue.push({ value: child, depth: depth + 1 }) } }
  validateRadarTranslations(doc)
  validateRadarGeography(doc)
  return doc
}

export function createFieldRadarStore({ store, request, library } = {}) {
  if (!store?.get || !store?.put || !store?.list) throw fail('雷达需要本地状态存储。')
  const relations = createRelationsStore(store)
  const key = value => `field-radar-topic:${id(value)}`
  async function get(topicId) {
    const manifest = await store.get(key(topicId))
    if (!manifest.value) return { document: null, revision: 0, updated_at: null }
    const { chunks, digest } = manifest.value
    if (!Array.isArray(chunks) || chunks.length > 12 || !/^[a-f0-9]{64}$/.test(digest)) throw fail('雷达存储清单损坏。', 'FIELD_RADAR_CORRUPT', 500)
    const parts = []
    for (const chunk of chunks) { if (!/^[a-f0-9]{64}$/.test(chunk)) throw fail('雷达分块标识无效。'); const record = await store.get(`field-radar-chunk:${chunk}`); const data = record.value?.data; if (typeof data !== 'string' || hash(data) !== chunk) throw fail('雷达资料分块缺失或校验失败。', 'FIELD_RADAR_CORRUPT', 500); parts.push(Buffer.from(data, 'base64')) }
    const bytes = Buffer.concat(parts)
    if (bytes.length > FIELD_RADAR_LIMITS.bytes || hash(bytes) !== digest) throw fail('雷达资料校验失败。', 'FIELD_RADAR_CORRUPT', 500)
    return { document: validateFieldRadarDocument(JSON.parse(bytes.toString('utf8'))), revision: manifest.revision, updated_at: manifest.updated_at }
  }
  async function importDocument(input) {
    const document = validateFieldRadarDocument(input.document), current = await store.get(key(document.topic.id))
    if (current.revision !== input.expected_revision) throw new LocalStateConflictError({ revision: current.revision, topic: current.value?.topic ?? null })
    const bytes = Buffer.from(JSON.stringify(document)), digest = hash(bytes), chunks = []
    // Content addressed chunks are create-only. The manifest is the single CAS commit point.
    for (let offset = 0; offset < bytes.length; offset += 120000) { const data = bytes.subarray(offset, offset + 120000).toString('base64'), chunk = hash(data), chunkKey = `field-radar-chunk:${chunk}`; chunks.push(chunk); const old = await store.get(chunkKey); if (old.value == null) { try { await store.put(chunkKey, { data }, 0) } catch (error) { if (error.code !== 'STATE_CONFLICT' || (await store.get(chunkKey)).value?.data !== data) throw error } } else if (old.value.data !== data) throw fail('雷达分块校验冲突。') }
    // Snapshot preserves imported provenance even when the topic manifest advances.
    const snapshotKey = `field-radar-snapshot:${digest}`
    if (!(await store.get(snapshotKey)).value) { try { await store.put(snapshotKey, { digest, chunks, topic_id: document.topic.id }, 0) } catch (error) { if (error.code !== 'STATE_CONFLICT') throw error } }
    const saved = await store.put(key(document.topic.id), { topic: document.topic, digest, chunks, counts: Object.fromEntries(['papers', 'scholars', 'sources', 'claims'].map(name => [name, document[name].length])) }, input.expected_revision)
    return { document, revision: saved.revision, updated_at: saved.updated_at }
  }
  async function match(input, { signal } = {}) {
    if (!Array.isArray(input.papers) || input.papers.length > FIELD_RADAR_LIMITS.papers) throw fail('匹配须提供不超过 500 篇论文。')
    const { offset, limit } = page(input, FIELD_RADAR_LIMITS.matchPage), matches = []
    for (const paper of input.papers.slice(offset, offset + limit)) {
      signal?.throwIfAborted(); id(paper.id); string(paper.title, '论文标题', 2000)
      if (paper.doi != null && (typeof paper.doi !== 'string' || paper.doi.length > 500)) throw fail('DOI 超出长度上限。')
      const candidates = new Map(); let truncated = false
      if(paper.local_paper_id!=null){id(paper.local_paper_id);try{const row=await request({action:'get',id:paper.local_paper_id},signal);if(row?.id===paper.local_paper_id&&!row.archived&&(!row.resource_kind||row.resource_kind==='paper')){const a=doi(paper.doi),b=doi(row.DOI??row.doi),sameDOI=a&&a===b,sameTitle=title(paper.title)===title(row.title);if(!a||!b||a===b)candidates.set(row.id,{id:row.id,title:row.title,doi:b||null,pdf:Boolean(row.pdf),match_basis:sameDOI?'doi':sameTitle?'title':'supplied-id-needs-review'});}}catch(error){if(signal?.aborted)throw error;truncated=true;}}

      const prefix=paper.title.trim().split(/[\s:：]/).filter(Boolean)[0]; const queries = [...new Set([doi(paper.doi), paper.title.trim().slice(0, 500), prefix?.length>=6?prefix:null].filter(Boolean))]
      for (const query of queries) {
        if(query===prefix&&candidates.size)continue;
        signal?.throwIfAborted()
        const result = await request({ action: 'resource_list', kind: 'paper', query, archived: false, offset: 0, limit: FIELD_RADAR_LIMITS.candidates }, signal)
        truncated ||= Boolean(result.truncated || result.total > result.items?.length)
        for (const row of (result.items || []).slice(0, FIELD_RADAR_LIMITS.candidates)) {
          const sameDOI = doi(paper.doi) && doi(paper.doi) === doi(row.DOI ?? row.doi), sameTitle = title(paper.title) === title(row.title)
          // A conflicting DOI cannot be treated as a title match.
          if (!sameDOI && (!sameTitle || doi(paper.doi) && doi(row.DOI ?? row.doi) && doi(paper.doi) !== doi(row.DOI ?? row.doi))) continue
          candidates.set(row.id, { id: row.id, title: row.title, doi: row.DOI ?? row.doi ?? null, pdf: Boolean(row.pdf), match_basis: sameDOI ? 'doi' : 'title' })
        }
      }
      const found = [...candidates.values()]
      matches.push({ paper_id: paper.id, status: found.length > 1 || found.some(row=>row.match_basis==='supplied-id-needs-review') ? 'ambiguous' : truncated ? 'incomplete' : found.length === 1 ? 'matched' : 'unmatched', candidates: found, truncated })
    }
    return { matches, total: input.papers.length, offset, limit, next_offset: offset + matches.length < input.papers.length ? offset + matches.length : null }
  }
  async function readSnapshot() {
    if (typeof library !== 'string' || !isAbsolute(library)) throw fail('全名单快照需要已配置的资料库。')
    const directory = join(library, '.paper-library'), path = join(directory, 'field-radar-snapshot.json'), maximum = 6 * 1024 * 1024
    let handle
    try {
      const parent = await lstat(directory)
      if (!parent.isDirectory() || parent.isSymbolicLink()) throw fail('快照目录不能是链接。')
      const expected = await lstat(path)
      if (!expected.isFile() || expected.isSymbolicLink() || expected.nlink !== 1 || expected.size > maximum) throw fail('快照必须是小于 6 MiB 的独立 JSON 文件。')
      handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
      const stat = await handle.stat()
      if (!stat.isFile() || stat.nlink !== 1 || stat.ino !== expected.ino || stat.dev !== expected.dev || stat.size > maximum) throw fail('快照在读取前发生变化。')
      const buffer = Buffer.alloc(stat.size + 1); let size = 0
      while (size < buffer.length) { const part = await handle.read(buffer, size, buffer.length - size, size); if (!part.bytesRead) break; size += part.bytesRead }
      if (size !== stat.size) throw fail('快照在读取期间发生变化。')
      const snapshot = JSON.parse(buffer.subarray(0, size).toString('utf8'))
      if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) throw fail('全名单快照结构无效。')
      return { snapshot }
    } catch (error) { if (error.code === 'ENOENT') return { snapshot: null }; throw error }
    finally { await handle?.close() }
  }
  async function handle(input, context) {
    if (input.action === 'field_radar_relations_get') return relations.get()
    if (input.action === 'field_radar_relations_import') return relations.importDocument(input)
    if (input.action === 'field_radar_snapshot_get') return readSnapshot()
    if (input.action === 'field_radar_get') return get(input.id)
    if (input.action === 'field_radar_import') return importDocument(input)
    if (input.action === 'field_radar_match') return match(input, context)
    if (input.action === 'field_radar_list') { const result = await store.list({ prefix: 'field-radar-topic:', ...page(input) }); return { topics: result.records.map(row => ({ topic: row.value.topic, counts: row.value.counts, revision: row.revision, updated_at: row.updated_at })), total: result.total, next_offset: result.next_offset } }
    throw fail('未知雷达操作。')
  }
  return { handle, get }
}
