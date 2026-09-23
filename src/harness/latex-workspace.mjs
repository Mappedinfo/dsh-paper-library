/**
 * The LaTeX workspace's own folder, and its place in the data-sync service.
 *
 * The plugin maintains one folder of manuscripts (default `<DSH home>/manuscripts`)
 * instead of asking the reader for a path on every project, and that folder belongs
 * in the backup like the rest of the user's research data. So this module does two
 * small host-side jobs the worker cannot do:
 *
 * - `latex_ws_create` makes a project folder under the root and registers it through
 *   the normal worker action, so the folder layout, the starter file and the catalog
 *   rules stay in one place.
 * - `latex_ws_sync_attach` adds exactly one source entry to the sync service's own
 *   JSON config, after backing it up. It only ever adds: existing sources are never
 *   removed, reordered or rewritten, and a folder already covered by any source is
 *   reported instead of duplicated.
 */
import { copyFile, mkdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

const MAX_CONFIG_BYTES = 256 * 1024
const MAX_NAME = 60
const SYNC_SOURCE_ID = 'paper-library-latex'
const SYNC_SOURCE_EXCLUDE = ['**/*.aux', '**/*.fls', '**/*.fdb_latexmk', '**/*.synctex.gz', '**/*.out', '**/*.blg', '**/.DS_Store', '**/.latex-build/**']
const SLUG = /[^\p{L}\p{N}_-]+/gu

const fail = (message, code = 'LATEX_WORKSPACE_INVALID', status = 400) => Object.assign(new Error(message), { code, status })
const now = () => new Date().toISOString().replace(/[:.]/g, '-')
const trimSlashes = value => String(value).replace(/\/+$/, '')

/** Same home resolution order as the state store and `latexRoot`. */
function dshHome(config) {
  return resolve(config?.localStateHome || process.env.DSH_HOME?.trim() || join(homedir(), '.dsh'))
}

function expandHome(value) {
  if (value === '~') return homedir()
  return value.startsWith('~/') ? join(homedir(), value.slice(2)) : value
}

/** One folder name, safe to create, and never a path of its own. */
export function projectSlug(value) {
  if (typeof value !== 'string' || !value.trim()) throw fail('请填写项目名称。')
  const slug = value.normalize('NFC').trim().replace(SLUG, '-').replace(/^-+|-+$/g, '').slice(0, MAX_NAME).replace(/[.\s]+$/, '')
  if (!slug || slug === '.' || slug === '..') throw fail('项目名称需要包含可用的文字或字母。')
  return slug
}

/** The entry this plugin would add; exported so a test can assert it verbatim. */
export function syncSourceEntry(root) {
  return {
    id: SYNC_SOURCE_ID,
    kind: 'directory',
    root: trimSlashes(root),
    remote: SYNC_SOURCE_ID,
    include: [],
    exclude: [...SYNC_SOURCE_EXCLUDE],
    required: false,
  }
}

/** Which existing source already covers this folder, if any. */
export function coveringSource(sources, root) {
  const wanted = trimSlashes(expandHome(String(root)))
  for (const source of sources || []) {
    if (!source || typeof source.root !== 'string') continue
    const candidate = trimSlashes(expandHome(source.root))
    if (wanted === candidate || wanted.startsWith(`${candidate}/`)) return source
  }
  return null
}

/** The minimum vault-sync's own validator requires, checked before we write. */
function assertWritableConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail('数据同步服务的配置不是一个 JSON 对象。', 'LATEX_SYNC_INVALID', 409)
  if (!Array.isArray(value.sources)) throw fail('数据同步服务的配置里没有 sources 数组。', 'LATEX_SYNC_INVALID', 409)
  const ids = value.sources.map(source => source?.id)
  const remotes = value.sources.map(source => source?.remote ?? source?.id)
  if (new Set(ids).size !== ids.length) throw fail('数据同步服务的配置里存在重复的源 id。', 'LATEX_SYNC_INVALID', 409)
  if (new Set(remotes).size !== remotes.length) throw fail('数据同步服务的配置里存在重复的远端前缀。', 'LATEX_SYNC_INVALID', 409)
  return value
}

function uniqueField(sources, field, base) {
  const taken = new Set(sources.map(source => source?.[field] ?? source?.id))
  if (!taken.has(base)) return base
  for (let suffix = 2; suffix < 20; suffix += 1) {
    const candidate = `${base.slice(0, 58)}-${suffix}`
    if (!taken.has(candidate)) return candidate
  }
  throw fail(`数据同步服务里已有 ${base} 且后缀用尽，请手动整理配置。`, 'LATEX_SYNC_INVALID', 409)
}

export function createLatexWorkspace({ config = {}, dispatch, settings, library, python, fs = {} } = {}) {
  const io = { readFile, writeFile, mkdir, stat, rename, copyFile, realpath, ...fs }
  if (typeof dispatch !== 'function') throw new Error('paper-library: the LaTeX workspace needs the library dispatch')

  const root = () => resolve(config.latexRoot || join(dshHome(config), 'manuscripts'))

  async function preference() {
    if (!settings?.get) return {}
    try { return (await settings.get()).value || {} } catch { return {} }
  }

  function syncConfigPath(preferences) {
    const configured = typeof preferences.sync_config === 'string' ? preferences.sync_config.trim() : ''
    if (configured) return configured
    if (typeof config.syncConfig === 'string' && config.syncConfig.trim()) return config.syncConfig
    return join(dshHome(config), 'vault-sync', 'config.json')
  }

  async function directoryExists(path) {
    try { return (await io.stat(path)).isDirectory() } catch { return false }
  }

  async function readSyncConfig(path) {
    let raw
    try { raw = await io.readFile(path, 'utf8') } catch (error) {
      return { path, value: null, reason: error.code === 'ENOENT' ? '数据同步服务尚未初始化（找不到它的 config.json）' : `读取失败：${error.message}` }
    }
    if (Buffer.byteLength(raw, 'utf8') > MAX_CONFIG_BYTES) return { path, value: null, reason: '数据同步服务配置超过 256 KiB，未改动' }
    try { return { path, value: assertWritableConfig(JSON.parse(raw)) } } catch (error) { return { path, value: null, reason: error.message } }
  }

  async function attachSync(request = {}) {
    const preferences = await preference()
    const path = syncConfigPath(preferences)
    const wanted = resolve(request.root || root())
    const read = await readSyncConfig(path)
    if (!read.value) {
      // An uninitialised sync service is a fact, not a failure; a config we cannot
      // parse or would have to guess at is refused loudly when asked explicitly.
      if (request.strict && read.reason && !/尚未初始化/.test(read.reason)) throw fail(read.reason, 'LATEX_SYNC_INVALID', 409)
      return { changed: false, path, root: wanted, covered: false, reason: read.reason }
    }
    const existing = coveringSource(read.value.sources, wanted)
    if (existing) return { changed: false, path, root: wanted, covered: true, covering_source: existing.id ?? null }
    const sources = read.value.sources.map(source => (source && typeof source === 'object' ? { ...source } : source))
    const entry = syncSourceEntry(wanted)
    entry.id = uniqueField(sources, 'id', SYNC_SOURCE_ID)
    entry.remote = uniqueField(sources, 'remote', entry.id)
    const next = { ...read.value, sources: [...sources, entry] }
    assertWritableConfig(next)
    const backup = `${path}.bak-${now()}`
    await io.mkdir(dirname(path), { recursive: true })
    await io.copyFile(path, backup)
    // Write beside the original and rename, so an interrupted write cannot truncate it.
    const temporary = `${path}.tmp-${process.pid}-${Date.now()}`
    await io.writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
    await io.rename(temporary, path)
    return { changed: true, path, root: wanted, covered: true, entry, backup, source_count: next.sources.length }
  }

  async function status() {
    const preferences = await preference()
    const path = syncConfigPath(preferences)
    const wanted = root()
    const read = await readSyncConfig(path)
    const existing = read.value ? coveringSource(read.value.sources, wanted) : null
    return {
      root: wanted,
      root_exists: await directoryExists(wanted),
      sync: {
        config_path: path,
        configured: Boolean(read.value),
        covered: Boolean(existing),
        covering_source: existing ? (existing.id ?? null) : null,
        coverable: Boolean(read.value) && !existing,
        reason: read.reason || null,
      },
      settings: {
        starter: preferences.latex_starter !== false,
        auto_compile: preferences.latex_auto_compile !== false,
        split: Number.isSafeInteger(preferences.latex_split) ? preferences.latex_split : 50,
        sync_folder: preferences.latex_sync_folder !== false,
      },
      limits: { name: MAX_NAME, projects_per_folder: 200, config_bytes: MAX_CONFIG_BYTES },
    }
  }

  /** Compare both spellings: the catalog stores the worker's realpath (macOS /var → /private/var). */
  async function spellings(path) {
    const literal = resolve(path)
    try { return [literal, await io.realpath(literal)] } catch { return [literal] }
  }

  /** The project already registered for this folder, if any (`create` is idempotent). */
  async function findProject(directory) {
    const listed = await dispatch({ action: 'latex_project_list', query: basename(directory), limit: 200 }, { library, python })
    const wanted = await spellings(directory)
    for (const item of listed.projects || []) {
      const candidate = await spellings(item.root)
      if (candidate.some(path => wanted.includes(path))) return item
    }
    return null
  }

  async function create(request = {}) {
    const preferences = await preference()
    const wanted = root()
    const slug = projectSlug(request.name)
    const directory = join(wanted, slug)
    const starter = request.starter === undefined ? preferences.latex_starter !== false : request.starter === true
    await io.mkdir(directory, { recursive: true })
    const already = await findProject(directory)
    if (already) {
      let existingSync = { changed: false, skipped: true }
      if (request.sync !== false && preferences.latex_sync_folder !== false) {
        try { existingSync = await attachSync({ root: wanted }) } catch (error) { existingSync = { changed: false, covered: false, reason: error.message } }
      }
      return { project: already, dir: directory, starter_written: false, existing: true, sync: existingSync, root: wanted }
    }
    let project
    try {
      const created = await dispatch({ action: 'latex_project_create', root: directory, ...(request.title ? { title: request.title } : {}), create_missing: starter }, { library, python, signal: request.signal })
      project = created.project
    } catch (error) {
      // The folder stays so the reader can drop sources into it; the message says what to do.
      if (!starter && /没有 \.tex 文件/.test(String(error.message))) {
        throw fail(`已创建 ${directory}，但里面还没有 .tex 文件。把源文件放进去后再次新建，或在 ☰ 菜单里打开「写入最小 main.tex」。`, 'LATEX_WORKSPACE_NO_SOURCE', 409)
      }
      throw error
    }
    let sync = { changed: false, skipped: true }
    if (request.sync !== false && preferences.latex_sync_folder !== false) {
      try { sync = await attachSync({ root: wanted }) } catch (error) { sync = { changed: false, covered: false, reason: error.message } }
    }
    return { project, dir: directory, starter_written: starter, sync, root: wanted }
  }

  return async function handle(input, { signal } = {}) {
    const action = input?.action
    signal?.throwIfAborted()
    if (action === 'latex_ws_status') return status()
    if (action === 'latex_ws_create') return create({ ...input, signal })
    if (action === 'latex_ws_sync_attach') return attachSync({ root: input.root, strict: true })
    throw fail('未知 LaTeX 工作区操作。')
  }
}
