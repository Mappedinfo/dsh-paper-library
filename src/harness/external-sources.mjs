/**
 * External sources the library indexes by symlink rather than copying.
 *
 * Two ways in, both optional, neither a dependency: the deployment may list folders
 * explicitly (`externalSources`), or point at a sync service's own JSON config
 * (`syncConfig`). A sync config only *offers* directories — a source is indexed when
 * it is selected, either by naming its id, by setting `{"select":"all"}`, or by
 * giving an absolute root. Directories inside the DSH home are never offered: they
 * hold plugin state, not papers. Duplicates by root are dropped, and the library
 * keeps working with nothing configured.
 */
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { createSyncSourceReader } from './sync-config.mjs'

const MAX_SOURCES = 8
const ID = /^[a-z0-9][a-z0-9_.-]{0,63}$/
const under = (path, root) => Boolean(root) && (path === root || path.startsWith(`${root}/`))

/** The DSH home holds state and sessions; it is never a paper corpus. */
function dshHome(config) {
  const value = config?.localStateHome || process.env.DSH_HOME || join(homedir(), '.dsh')
  return resolve(value).replace(/\/+$/, '')
}

/** Validate the deployment's explicit list; request JSON never supplies these roots. */
export function normalizeConfiguredSources(raw) {
  if (raw === undefined || raw === null || raw === '') return []
  let value = raw
  if (typeof value === 'string') {
    if (value.length > 64 * 1024) throw new Error('paper-library: externalSources is too large')
    try {
      value = JSON.parse(value)
    } catch {
      throw new Error('paper-library: externalSources must be an array or JSON array')
    }
  }
  if (!Array.isArray(value)) throw new Error('paper-library: externalSources must be an array')
  if (value.length > MAX_SOURCES) throw new Error(`paper-library: at most ${MAX_SOURCES} external sources are supported`)
  const out = []
  const seen = new Set()
  for (const entry of value) {
    if (entry?.select !== undefined) {
      // `{"select":"all"}` indexes every directory the sync service already maintains.
      if (entry.select !== 'all') throw new Error('paper-library: external source select must be "all"')
      if (seen.has('select:all')) throw new Error('paper-library: duplicate select entry')
      seen.add('select:all')
      out.push({ select: 'all', from: 'config' })
      continue
    }
    const id = String(entry?.id ?? '').toLowerCase()
    if (!ID.test(id)) throw new Error(`paper-library: external source id ${JSON.stringify(entry?.id)} must be lowercase letters, digits, dot, dash or underscore`)
    if (seen.has(id)) throw new Error(`paper-library: duplicate external source id ${id}`)
    const root = entry?.root
    if (root !== undefined && (typeof root !== 'string' || !root.startsWith('/'))) throw new Error(`paper-library: external source ${id} needs an absolute root`)
    if (entry?.label !== undefined && (typeof entry.label !== 'string' || entry.label.length > 200)) throw new Error(`paper-library: external source ${id} label must be at most 200 characters`)
    seen.add(id)
    // Without a root the entry selects a directory the sync service config offers.
    out.push({ id, ...(root === undefined ? {} : { root }), ...(entry.label ? { label: entry.label } : {}), from: 'config' })
  }
  return out
}

/**
 * Combine explicit and discovered sources into the list a worker request carries.
 * Roots are deduplicated so one folder is never indexed twice under two names.
 */
export function createExternalSources({ config, readFile, statFile } = {}) {
  const readSyncSources = createSyncSourceReader({ ...(readFile ? { readFile } : {}), ...(statFile ? { statFile } : {}) })
  return {
    configured: config?.externalSources || [],
    syncConfig: config?.syncConfig,
    /**
     * Resolve the effective list for one call. Settings may name the sync service
     * config and select sources; a deployment value stays the fallback, so settings
     * never drop a configured root. Nothing is indexed merely because it was offered.
     */
    async list(preferences = {}) {
      const settingPath = typeof preferences.sync_config === 'string' ? preferences.sync_config.trim() : ''
      const settingSources = parseSettingSources(preferences.external_sources)
      const explicit = [...(config?.externalSources || []), ...settingSources]
      const home = dshHome(config)
      const read = await readSyncSources(settingPath || config?.syncConfig)
      const offered = read.sources.filter(entry => !under(entry.root.replace(/\/+$/, ''), home))
      const warnings = [...read.warnings]
      const excluded = read.sources.length - offered.length
      if (excluded) warnings.push(`${excluded} sync source(s) inside the DSH home hold state, not papers, and were not offered`)
      const reserved = offered.length > MAX_SOURCES - explicit.length
      if (reserved) warnings.push('a sync config offering many directories may not all fit in eight sources')

      const sources = []
      const missing = []
      let selectAll = false
      for (const entry of explicit) {
        if (entry.select === 'all') {
          selectAll = true
          continue
        }
        if (entry.root) {
          sources.push({ id: entry.id, root: entry.root, ...(entry.label ? { label: entry.label } : {}), from: entry.from || 'config' })
          continue
        }
        const match = offered.find(candidate => candidate.id === entry.id)
        if (match) sources.push({ ...match, from: 'selection' })
        else missing.push(entry.id)
      }
      if (selectAll) for (const candidate of offered) if (!sources.some(entry => entry.root === candidate.root)) sources.push({ ...candidate, from: 'selection' })
      if (missing.length) warnings.push(`no sync service directory matches: ${missing.join(', ')}`)

      const roots = new Set()
      const deduped = []
      for (const entry of sources) {
        const key = entry.root.replace(/\/+$/, '')
        if (roots.has(key)) continue
        roots.add(key)
        deduped.push(entry)
      }
      const configured = typeof preferences.external_sources === 'string' ? preferences.external_sources.trim() : ''
      return {
        sources: deduped.slice(0, MAX_SOURCES),
        offered,
        warnings,
        syncConfig: settingPath || config?.syncConfig || null,
        rejectedSettings: Boolean(configured && settingSources.length === 0),
      }
    },
  }
}

/** Settings hold the same shape as deployment entries; invalid text is reported, not thrown. */
function parseSettingSources(value) {
  if (typeof value !== 'string' || !value.trim()) return []
  try {
    return normalizeConfiguredSources(value).map(entry => ({ ...entry, from: 'settings' }))
  } catch {
    return []
  }
}

export const SOURCE_TOOL_SPECS = [
  {
    name: 'library_sources',
    action: 'external_status',
    sources: true,
    title: 'List synced paper folders',
    parameters: {},
  },
  {
    name: 'library_sources_scan',
    action: 'external_scan',
    sources: true,
    mutate: true,
    title: 'Index synced paper folders by symlink',
    parameters: {
      operation: { type: 'string', enum: ['scan', 'prune'], description: 'scan indexes new and changed PDFs; prune only removes links whose file is gone' },
      source: { type: 'string', description: 'One configured source id; omit to scan every source' },
      limit: { type: 'integer', description: '1–2000 files to index in this call; default 200, so a large corpus resumes over several calls' },
    },
  },
]

/** Build the worker request for a source tool and carry the config warnings through. */
export async function handleSourceRequest(sources, spec, request, dispatch, options, signal, preferences = {}) {
  const listed = await sources.list(preferences)
  const payload = listed.sources.map(({ id, root, label }) => ({ id, root, ...(label ? { label } : {}) }))
  const action = spec.action === 'external_status' ? 'external_status' : request.operation === 'prune' ? 'external_prune' : 'external_scan'
  const result = await dispatch({
    action,
    sources: payload,
    ...(request.source ? { source: request.source } : {}),
    ...(action === 'external_scan' && request.limit !== undefined ? { limit: request.limit } : {}),
  }, { ...options, signal })
  const warnings = [...(result.warnings || []), ...listed.warnings, ...(listed.rejectedSettings ? ['设置里的外部文献源不是有效 JSON 数组，已忽略。'] : [])]
  const selected = new Set(payload.map(entry => entry.root.replace(/\/+$/, '')))
  // Offered-but-unselected directories are reported so a reader can add one by id
  // without the plugin indexing anything nobody asked for.
  const offered = (listed.offered || []).filter(entry => !selected.has(entry.root.replace(/\/+$/, ''))).map(entry => ({ id: entry.id, root: entry.root, label: entry.label }))
  return {
    ...result,
    configured: payload.length,
    ...(listed.syncConfig ? { sync_config: listed.syncConfig } : {}),
    ...(offered.length ? { offered, offered_hint: '数据同步服务还维护这些目录；要纳入索引，在「额外外部文献源」里填 [{"id":"<id>"}] 或 {"select":"all"}' } : {}),
    warnings,
  }
}
