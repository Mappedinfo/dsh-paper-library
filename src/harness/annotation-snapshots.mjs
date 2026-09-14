import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, link, lstat, mkdir, open, realpath, unlink } from 'node:fs/promises'
import { join } from 'node:path'

export const ANNOTATION_SNAPSHOT_MAX_BYTES = 1024 * 1024
const MAX_TEXT_BYTES = 200 * 1024
const ID = /^[A-Za-z0-9_-]{1,160}$/
const HASH = /^[a-f0-9]{64}$/
const TOKEN = /^\[\[paper-library-ref:v1:([A-Za-z0-9_-]{1,160}):([a-f0-9]{64})\]\]$/

function identifier(value, name) {
  if (typeof value !== 'string' || !ID.test(value)) throw new Error(`${name} 无效。`)
  return value
}

function session(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 200 || /[\x00-\x1f]/.test(value)) throw new Error('论文对话标识无效。')
  return value
}

export function annotationSnapshotToken(paperId, id) {
  identifier(paperId, '文献标识')
  if (typeof id !== 'string' || !HASH.test(id)) throw new Error('引用快照标识无效。')
  return `[[paper-library-ref:v1:${paperId}:${id}]]`
}

export function parseAnnotationSnapshotToken(token) {
  const match = typeof token === 'string' && TOKEN.exec(token)
  return match ? { paperId: match[1], id: match[2] } : undefined
}

/** Count Unicode code points like Python len(), without allocating char arrays. */
export function annotationSnapshotSourceCharacters(snapshot) {
  let characters = 0
  for (const note of snapshot.annotations) {
    for (const _ of note.text) characters++
    for (const _ of note.comment) characters++
  }
  if (snapshot.selection) for (const _ of snapshot.selection.text) characters++
  return characters
}

function canonical(value, depth = 0, budget = { nodes: 0, bytes: 0 }) {
  if (++budget.nodes > 100000 || depth > 12) throw new Error('引用快照结构超过预算。')
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'string') {
    budget.bytes += Buffer.byteLength(value, 'utf8')
    if (budget.bytes > ANNOTATION_SNAPSHOT_MAX_BYTES) throw new Error('引用快照超过 1 MiB；请减少引用。')
    return value
  }
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (Array.isArray(value)) return value.map(entry => canonical(entry, depth + 1, budget))
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.keys(value).sort().map(key => {
      budget.bytes += Buffer.byteLength(key, 'utf8')
      return [key, canonical(value[key], depth + 1, budget)]
    }))
  }
  throw new Error('引用快照必须是有限的 JSON 数据。')
}

function validateSnapshot(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('引用快照无效。')
  identifier(input.paperId, '文献标识')
  session(input.sessionId)
  if (typeof input.text !== 'string' || !input.text.trim() || Buffer.byteLength(input.text, 'utf8') > MAX_TEXT_BYTES) throw new Error('引用正文为空或超过 200 KiB。')
  if (input.question !== undefined && (typeof input.question !== 'string' || input.question.length > 4000)) throw new Error('引用问题超过 4000 字符。')
  if (!Array.isArray(input.annotation_refs) || input.annotation_refs.length > 1000 || !Array.isArray(input.annotations) || input.annotations.length !== input.annotation_refs.length) throw new Error('引用快照需要最多 1000 条完整批注。')
  const seen = new Set()
  for (let index = 0; index < input.annotation_refs.length; index++) {
    const ref = input.annotation_refs[index], note = input.annotations[index]
    if (!ref || typeof ref.id !== 'string' || ref.id.length < 1 || ref.id.length > 160 || /[\x00-\x1f]/.test(ref.id) || !HASH.test(ref.version) || seen.has(ref.id)) throw new Error('引用快照包含无效或重复的批注身份。')
    seen.add(ref.id)
    if (!note || note.id !== ref.id || note.version !== ref.version || !Number.isSafeInteger(note.page) || note.page < 1 || note.page > 2000 || typeof note.text !== 'string' || typeof note.comment !== 'string' || note.kind === 'ai-feedback') throw new Error('引用快照正文与批注身份不一致。')
  }
  if (input.selection !== undefined && input.selection !== null) {
    const selection = input.selection
    if (!Number.isSafeInteger(selection.page) || selection.page < 1 || selection.page > 2000 || typeof selection.text !== 'string' || !selection.text.trim() || selection.text.length > 8000) throw new Error('引用快照选文无效。')
  }
  if (!input.coverage || input.coverage.requested !== input.annotation_refs.length || input.coverage.included !== input.annotations.length || !Number.isSafeInteger(input.coverage.total) || input.coverage.total < input.annotations.length || typeof input.coverage.total_exact !== 'boolean' || typeof input.coverage.all !== 'boolean' || input.coverage.all !== (input.coverage.total_exact && input.coverage.included === input.coverage.total)) throw new Error('引用快照覆盖范围无效。')
  if (input.coverage.characters !== undefined && (!Number.isSafeInteger(input.coverage.characters) || input.coverage.characters !== annotationSnapshotSourceCharacters(input))) throw new Error('引用快照声明的字符数与完整来源不一致。')
  return canonical(input)
}

function encode(record) {
  const text = JSON.stringify(canonical(record))
  if (Buffer.byteLength(text, 'utf8') > ANNOTATION_SNAPSHOT_MAX_BYTES) throw new Error('引用快照超过 1 MiB；请减少引用。')
  return text
}

async function privateDirectory(path) {
  await mkdir(path, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error })
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('引用快照目录必须是文献库内的真实目录。')
  await chmod(path, 0o700)
}

async function publishFile(directory, destination, encoded) {
  const temporary = join(directory, `.pending-${randomUUID()}`)
  try {
    const handle = await open(temporary, 'wx', 0o600)
    try { await handle.writeFile(encoded, 'utf8'); await handle.sync() } finally { await handle.close() }
    await link(temporary, destination).catch(error => { if (error.code !== 'EEXIST') throw error })
  } finally { await unlink(temporary).catch(() => {}) }
}

async function boundedJSONFile(path, maximum) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size > maximum || stat.size < 2) throw new Error('引用记录文件无效或超过大小预算。')
    const buffer = Buffer.alloc(Math.min(stat.size + 1, maximum + 1))
    let length = 0
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length)
      if (!bytesRead) break
      length += bytesRead
    }
    if (length !== stat.size) throw new Error('引用记录在读取期间发生变化。')
    await handle.chmod(0o600)
    try { return JSON.parse(buffer.subarray(0, length).toString('utf8')) } catch { throw new Error('引用记录 JSON 损坏，请重新选择批注。') }
  } finally { await handle.close() }
}

/** Immutable, private source snapshots. PDF annotations remain authoritative.
 * Only the configured library is used; tokens never choose paths or libraries.
 * No snapshot data or PDF content is retained in a permanent in-memory cache.
 */
export function createAnnotationSnapshotStore({ library }) {
  if (typeof library !== 'string' || !library) throw new Error('引用快照需要已配置的文献库。')

  async function location() {
    const root = await realpath(library)
    const parent = join(root, '.paper-library')
    await privateDirectory(parent)
    const directory = join(parent, 'snapshots')
    await privateDirectory(directory)
    const requests = join(parent, 'requests')
    await privateDirectory(requests)
    return { directory, requests, libraryHash: createHash('sha256').update(root).digest('hex') }
  }

  async function read(id, expected, place) {
    if (typeof id !== 'string' || !HASH.test(id)) throw new Error('引用快照标识无效。')
    identifier(expected?.paperId, '文献标识')
    session(expected?.sessionId)
    const record = await boundedJSONFile(join(place.directory, `${id}.json`), ANNOTATION_SNAPSHOT_MAX_BYTES).catch(error => {
      if (error.code === 'ENOENT') throw new Error('引用快照已丢失，请返回论文重新选择批注。')
      throw error
    })
    if (!record || typeof record !== 'object' || record.schema !== 1 || record.libraryHash !== place.libraryHash) throw new Error('引用快照不属于当前文献库。')
    const snapshot = validateSnapshot(record.snapshot)
    if (snapshot.paperId !== expected.paperId || snapshot.sessionId !== expected.sessionId) throw new Error('引用快照不属于当前论文对话。')
    const hash = createHash('sha256').update(encode({ schema: 1, libraryHash: place.libraryHash, snapshot })).digest('hex')
    if (hash !== id) throw new Error('引用快照校验失败，内容已变化；请重新选择批注。')
    return snapshot
  }

  function requestBinding(requestId, expected, place) {
    if (typeof requestId !== 'string' || !requestId.trim() || requestId.length > 160 || /[\x00-\x1f]/.test(requestId)) throw new Error('引用请求标识无效。')
    identifier(expected?.paperId, '文献标识')
    session(expected?.sessionId)
    const identity = { libraryHash: place.libraryHash, paperId: expected.paperId, sessionId: expected.sessionId, requestId }
    const key = createHash('sha256').update(encode(identity)).digest('hex')
    return { identity, filename: join(place.requests, `${key}.json`) }
  }

  async function findRequest(requestId, expected, place) {
    const { identity, filename } = requestBinding(requestId, expected, place)
    const entry = await boundedJSONFile(filename, 2048).catch(error => { if (error.code === 'ENOENT') return undefined; throw error })
    if (entry === undefined) return null
    if (!entry || typeof entry !== 'object' || entry.schema !== 1 || typeof entry.snapshotId !== 'string' || !HASH.test(entry.snapshotId) || Object.entries(identity).some(([key, value]) => entry[key] !== value)) throw new Error('引用请求记录校验失败；不能安全重试。')
    await read(entry.snapshotId, expected, place)
    return entry.snapshotId
  }

  return {
    async save(input) {
      const snapshot = validateSnapshot(input)
      const place = await location()
      const encoded = encode({ schema: 1, libraryHash: place.libraryHash, snapshot })
      const id = createHash('sha256').update(encoded).digest('hex')
      const destination = join(place.directory, `${id}.json`)
      // Hard linking publishes a complete file atomically and never overwrites
      // an existing snapshot, including concurrent/retried logical submits.
      await publishFile(place.directory, destination, encoded)
      const verified = await read(id, { paperId: snapshot.paperId, sessionId: snapshot.sessionId }, place)
      return { id, token: annotationSnapshotToken(snapshot.paperId, id), snapshot: verified }
    },
    async load(id, expected) { return read(id, expected, await location()) },
    async bindRequest(requestId, snapshotId, expected) {
      const place = await location()
      await read(snapshotId, expected, place)
      const { identity, filename } = requestBinding(requestId, expected, place)
      await publishFile(place.requests, filename, encode({ schema: 1, ...identity, snapshotId }))
      const bound = await findRequest(requestId, expected, place)
      if (bound !== snapshotId) throw new Error('同一发送请求已绑定另一份引用快照；修改材料后请发起新请求。')
      return bound
    },
    async findRequest(requestId, expected) { return findRequest(requestId, expected, await location()) },
  }
}
