/** Durable reader-owned state under the same home selection as DeepSeek Harness.
 * Records are loaded on demand. Only resolved paths, never record bodies, are
 * retained by this object. State is user data and is not expired or evicted.
 */
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, opendir, realpath, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

const MAX_RECORD_BYTES = 256 * 1024, MAX_LIST_BYTES = 8 * 1024 * 1024;
const KEY = /^[A-Za-z][A-Za-z0-9_.-]*(?::[A-Za-z0-9_.-]+)*$/;
const REVISION = /^[a-f0-9]{64}$/;
const sha256 = value => createHash('sha256').update(value).digest('hex');
// A one-byte separator escape keeps even a 200-character key below filesystem
// filename limits; '~' is excluded from logical keys, so the mapping is bijective.
const filenameKey = key => key.replaceAll(':', '~');
async function optional(name) {
  try { return await import(name); }
  catch (error) { if (error.code === 'ERR_MODULE_NOT_FOUND' && error.message.includes(name)) return null; throw error; }
}
const [homePaths, atomicWrite] = await Promise.all([optional('@deepseek-ai/dsh-home-paths'), optional('@deepseek-ai/dsh-atomic-write')]);

/** Standalone fallback follows official configured > DSH_HOME > ~/.dsh rules. */
export function resolveLocalStateHome(configured, env = process.env) {
  if (configured !== undefined && (typeof configured !== 'string' || !configured.trim())) throw new Error('Local state home must be a non-empty path');
  if (homePaths) return homePaths.resolveDshHome(configured, env);
  const selected = configured ?? (env.DSH_HOME?.trim() ? env.DSH_HOME : join(homedir(), '.dsh'));
  const expanded = selected === '~' ? homedir() : selected.startsWith('~/') || selected.startsWith('~\\') ? join(homedir(), selected.slice(2)) : selected;
  return resolve(expanded);
}
export class LocalStateConflictError extends Error {
  constructor(current) { super('本地状态已在另一窗口更新，请读取当前版本后再保存。'); this.name = 'LocalStateConflictError'; this.code = 'STATE_CONFLICT'; this.status = 409; this.current = current; }
}
export class LocalStateError extends Error {
  constructor(message, code = 'STATE_INVALID', status = 400) { super(message); this.name = 'LocalStateError'; this.code = code; this.status = status; }
}
function keyValue(key) { if (typeof key !== 'string' || key.length > 200 || !KEY.test(key)) throw new LocalStateError('状态键必须是 1–200 个字母、数字、点、短横线、下划线或冒号分段。'); return key; }
function prefixValue(prefix) { if (typeof prefix !== 'string' || prefix.length > 200 || (prefix && !/^[A-Za-z][A-Za-z0-9_.:-]*$/.test(prefix))) throw new LocalStateError('无效的状态键前缀。'); return prefix; }
async function canonicalPath(path) {
  if (homePaths) return homePaths.canonicalizeWatchPath(path);
  const suffix = []; let current = resolve(path);
  while (true) {
    try { const canonical = await realpath(current); const directory = await opendir(canonical); await directory.close(); return join(canonical, ...suffix.reverse()); }
    catch (error) { if (error.code !== 'ENOENT') throw error; const parent = dirname(current); if (parent === current) throw error; suffix.push(basename(current)); current = parent; }
  }
}
function validateJSON(value) {
  const queue = [{ value, depth: 0 }], seen = new Set(); let count = 0, bytes = 0;
  const addBytes = amount => { bytes += amount; if (bytes > MAX_RECORD_BYTES) throw new LocalStateError('单条状态超过 256 KiB 上限。', 'STATE_TOO_LARGE', 413); };
  while (queue.length) {
    const current = queue.pop(), item = current.value;
    if (++count > 30000 || current.depth > 32) throw new LocalStateError('状态内容结构过深或条目过多。');
    if (item === null || typeof item === 'boolean') { addBytes(5); continue; }
    if (typeof item === 'string') { if (item.length > MAX_RECORD_BYTES) throw new LocalStateError('单条状态超过 256 KiB 上限。', 'STATE_TOO_LARGE', 413); addBytes(Buffer.byteLength(item, 'utf8') + 2); continue; }
    if (typeof item === 'number') { if (!Number.isFinite(item)) throw new LocalStateError('状态数字必须是有限值。'); addBytes(String(item).length); continue; }
    if (typeof item !== 'object' || (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) || seen.has(item)) throw new LocalStateError('状态必须是无循环的普通 JSON 数据。');
    seen.add(item);
    const values = Array.isArray(item) ? item : Object.values(item);
    if (count + queue.length + values.length > 30000) throw new LocalStateError('状态条目过多。');
    addBytes(values.length + 2);
    if (!Array.isArray(item)) for (const key of Object.keys(item)) addBytes(Buffer.byteLength(key, 'utf8') + 3);
    for (const child of values) queue.push({ value: child, depth: current.depth + 1 });
  }
}
async function inspectDirectory(path) {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new LocalStateError('状态目录不能是符号链接或普通文件。', 'STATE_UNSAFE_PATH');
}
async function privateDirectory(path) {
  try { await mkdir(path, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  await inspectDirectory(path); await chmod(path, 0o700);
  // Commit newly created state-tree directory entries as well as record data.
  await syncDirectory(path); await syncDirectory(dirname(path));
}
async function syncDirectory(path) {
  const directory = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await directory.sync(); } finally { await directory.close(); }
}
async function safeFile(path, optional = false) {
  try { const info = await lstat(path); if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new LocalStateError('状态文件不能是链接或特殊文件。', 'STATE_UNSAFE_PATH'); return info; }
  catch (error) { if (optional && error.code === 'ENOENT') return null; throw error; }
}
async function readEnvelope(path) {
  let handle;
  try {
    // NONBLOCK also prevents a planted FIFO from hanging before fstat can
    // reject it; it has no effect on ordinary disk-file reads.
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1) throw new LocalStateError('状态文件不是独立的普通文件。', 'STATE_UNSAFE_PATH');
    if (info.size > MAX_RECORD_BYTES) throw new LocalStateError('已保存状态超过 256 KiB，请保留文件后人工检查。', 'STATE_CORRUPT');
    const buffer = Buffer.alloc(Math.min(MAX_RECORD_BYTES + 1, info.size + 1)); let size = 0;
    while (size < buffer.length) { const chunk = await handle.read(buffer, size, buffer.length - size, size); if (!chunk.bytesRead) break; size += chunk.bytesRead; }
    if (size !== info.size || size > MAX_RECORD_BYTES) throw new LocalStateError('读取时状态文件发生非原子变化，请重试并保留文件。', 'STATE_CORRUPT');
    let envelope;
    try { envelope = JSON.parse(buffer.subarray(0, size).toString('utf8')); } catch { throw new LocalStateError('状态文件损坏，已保留原文件；请修复后重试。', 'STATE_CORRUPT'); }
    return envelope;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    if (error.code === 'ELOOP') throw new LocalStateError('拒绝读取符号链接状态文件。', 'STATE_UNSAFE_PATH');
    throw error;
  } finally { await handle?.close(); }
}
async function fallbackLock(path, operation) {
  const lockPath = `${path}.lock`, deadline = Date.now() + 2000; let handle;
  while (!handle) {
    try { handle = await open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (Date.now() >= deadline) throw new LocalStateError('状态写锁仍被占用，请稍后重试；不会自动删除现有锁。', 'STATE_LOCKED', 503);
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
  try { await handle.writeFile(`${process.pid}\n`); return await operation(); } finally { await handle.close(); await rm(lockPath); }
}
async function locked(path, operation) {
  await safeFile(`${path}.lock`, true);
  if (!atomicWrite) return fallbackLock(path, operation);
  try { return await atomicWrite.withFileLock(path, operation, { waitMs: 2000 }); }
  catch (error) { if (/timed out waiting for the writer lock/.test(error.message)) throw new LocalStateError('状态写锁仍被占用，请稍后重试；不会自动删除现有锁。', 'STATE_LOCKED', 503); throw error; }
}
async function writeDurable(path, text) {
  // The official writeFileAtomic currently excludes fsync by contract. Preserve
  // its sibling/exclusive-create/rename pattern, adding file-before-rename and
  // directory-after-rename fsync before reporting success.
  const temporary = `${path}.${randomUUID()}.tmp`; let handle;
  try {
    handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await handle.writeFile(text, 'utf8'); await handle.sync(); await handle.close(); handle = null;
    await safeFile(path, true); await rename(temporary, path);
    await syncDirectory(dirname(path));
  } finally { await handle?.close(); await rm(temporary, { force: true }); }
}

export function createLocalStateStore({ library, home } = {}) {
  if (typeof library !== 'string' || !isAbsolute(library)) throw new LocalStateError('状态存储需要部署方指定绝对文献库路径。');
  const configuredHome = resolveLocalStateHome(home); let location;
  async function ready() {
    if (!location) {
      location = (async () => {
        const canonicalLibrary = await canonicalPath(library), libraryId = sha256(canonicalLibrary);
        await mkdir(configuredHome, { recursive: true, mode: 0o700 }); const actualHome = await realpath(configuredHome);
        const parent = join(actualHome, 'paper-library'), owner = join(parent, libraryId), state = join(owner, 'state');
        for (const path of [parent, owner, state]) await privateDirectory(path);
        return { home: actualHome, parent, owner, state, libraryId };
      })().catch(error => { location = null; throw error; });
    }
    const result = await location;
    for (const path of [result.home, result.parent, result.owner, result.state]) await inspectDirectory(path);
    return result;
  }
  async function readRecord(key, resolved) {
    const envelope = await readEnvelope(join(resolved.state, `${filenameKey(key)}.json`));
    if (envelope === null) return { key, value: null, revision: 0, updated_at: null };
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope) || Object.keys(envelope).sort().join(',') !== 'key,library,nonce,revision,schema,updated_at,value' || envelope.schema !== 1 || envelope.library !== resolved.libraryId || envelope.key !== key || !REVISION.test(envelope.revision) || typeof envelope.nonce !== 'string' || typeof envelope.updated_at !== 'string' || !Number.isFinite(Date.parse(envelope.updated_at))) throw new LocalStateError('状态记录身份或结构损坏，已保留文件。', 'STATE_CORRUPT');
    const { revision, ...content } = envelope;
    if (sha256(JSON.stringify(content)) !== revision) throw new LocalStateError('状态内容校验失败，已保留文件。', 'STATE_CORRUPT');
    validateJSON(envelope.value);
    return { key, value: envelope.value, revision, updated_at: envelope.updated_at };
  }
  async function get(key) { return readRecord(keyValue(key), await ready()); }
  async function put(key, value, expectedRevision) {
    keyValue(key); validateJSON(value);
    if (expectedRevision !== 0 && !(typeof expectedRevision === 'string' && REVISION.test(expectedRevision))) throw new LocalStateError('保存必须提供 expected_revision：首次为 0，随后使用读取到的版本。');
    const resolved = await ready(), path = join(resolved.state, `${filenameKey(key)}.json`);
    return locked(path, async () => {
      await ready(); const current = await readRecord(key, resolved);
      if (current.revision !== expectedRevision) throw new LocalStateConflictError(current);
      const content = { schema: 1, library: resolved.libraryId, key, nonce: randomUUID(), updated_at: new Date().toISOString(), value };
      const revision = sha256(JSON.stringify(content)), text = JSON.stringify({ ...content, revision });
      if (Buffer.byteLength(text, 'utf8') > MAX_RECORD_BYTES) throw new LocalStateError('单条状态超过 256 KiB 上限。', 'STATE_TOO_LARGE', 413);
      await writeDurable(path, text);
      return { key, value: JSON.parse(text).value, revision, updated_at: content.updated_at };
    });
  }
  async function list({ prefix = '', offset = 0, limit = 20 } = {}) {
    prefixValue(prefix);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 10000 || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new LocalStateError('状态分页要求 offset 0–10000、limit 1–50。');
    const resolved = await ready(), candidates = [], maximum = offset + limit, encodedPrefix = filenameKey(prefix); let total = 0;
    const directory = await opendir(resolved.state);
    for await (const entry of directory) {
      if (!entry.name.endsWith('.json') || !entry.name.startsWith(encodedPrefix)) continue;
      let key; try { key = entry.name.slice(0, -5).replaceAll('~', ':'); keyValue(key); } catch { throw new LocalStateError('状态目录包含无法识别的记录文件，请保留后检查。', 'STATE_CORRUPT'); }
      if (!key.startsWith(prefix)) continue;
      if (!entry.isFile() || entry.isSymbolicLink()) throw new LocalStateError('状态列表包含链接或特殊文件。', 'STATE_UNSAFE_PATH');
      total++;
      // Bounded insertion window gives stable key ordering without loading all
      // record names or bodies, even when the archive has grown substantially.
      let low = 0, high = candidates.length;
      while (low < high) { const middle = (low + high) >>> 1; if (candidates[middle] < key) low = middle + 1; else high = middle; }
      if (low < maximum) { candidates.splice(low, 0, key); if (candidates.length > maximum) candidates.pop(); }
    }
    const records = []; let bytes = 0;
    for (const key of candidates.slice(offset, maximum)) {
      const record = await readRecord(key, resolved), size = Buffer.byteLength(JSON.stringify(record), 'utf8');
      if (bytes + size > MAX_LIST_BYTES && records.length) break;
      records.push(record); bytes += size;
    }
    const nextOffset = offset + records.length, hasMore = nextOffset < total;
    return { records, total, offset, limit, next_offset: hasMore ? nextOffset : null, hasMore, truncated: records.length < Math.min(limit, Math.max(0, total - offset)) };
  }
  return { get, put, list };
}
