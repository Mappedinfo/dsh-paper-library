/**
 * External sources the library indexes by symlink rather than copying.
 *
 * Two ways in, both optional, neither a dependency: the deployment may list folders
 * explicitly (`externalSources`), or point at a sync service's JSON config
 * (`syncConfig`). Explicit entries win on an id collision, duplicates by root are
 * dropped, and the library keeps working with neither configured.
 */
import { createSyncSourceReader } from './sync-config.mjs'

const MAX_SOURCES = 8
const ID = /^[a-z0-9][a-z0-9_.-]{0,63}$/

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
    const id = String(entry?.id ?? '').toLowerCase()
    const root = entry?.root
    if (!ID.test(id)) throw new Error(`paper-library: external source id ${JSON.stringify(entry?.id)} must be lowercase letters, digits, dot, dash or underscore`)
    if (seen.has(id)) throw new Error(`paper-library: duplicate external source id ${id}`)
    if (typeof root !== 'string' || !root.startsWith('/')) throw new Error(`paper-library: external source ${id} needs an absolute root`)
    if (entry?.label !== undefined && (typeof entry.label !== 'string' || entry.label.length > 200)) throw new Error(`paper-library: external source ${id} label must be at most 200 characters`)
    seen.add(id)
    out.push({ id, root, ...(entry.label ? { label: entry.label } : {}), from: 'config' })
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
     * Live preferences may name the sync service config and add folders; a deployment
     * value stays as the fallback, so settings never remove configured roots.
     */
    async list(preferences = {}) {
      const settingPath = typeof preferences.sync_config === 'string' ? preferences.sync_config.trim() : ''
      const settingSources = parseSettingSources(preferences.external_sources)
      const explicit = [...(config?.externalSources || []), ...settingSources]
      const discovered = await readSyncSources(settingPath || config?.syncConfig)
      const roots = new Set(explicit.map(entry => entry.root.replace(/\/+$/, '')))
      const ids = new Set(explicit.map(entry => entry.id))
      const merged = [...explicit]
      for (const entry of discovered.sources) {
        const root = entry.root.replace(/\/+$/, '')
        if (roots.has(root)) continue
        let id = entry.id
        for (let suffix = 2; ids.has(id) && suffix < 10; suffix += 1) id = `${entry.id.slice(0, 60)}-${suffix}`
        if (ids.has(id)) continue
        roots.add(root)
        ids.add(id)
        merged.push({ ...entry, id })
        if (merged.length >= MAX_SOURCES) break
      }
      const configured = typeof preferences.external_sources === 'string' ? preferences.external_sources.trim() : ''
      return {
        sources: merged.slice(0, MAX_SOURCES),
        warnings: discovered.warnings,
        syncConfig: settingPath || config?.syncConfig || null,
        rejectedSettings: Boolean(configured && settingSources.length === 0),
      }
    },
  }
}

/**
 * Tools for the synced corpora. Roots always come from deployment configuration,
 * never from tool arguments, so a model cannot point the index at an arbitrary path.
 */
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
  return { ...result, configured: payload.length, ...(listed.syncConfig ? { sync_config: listed.syncConfig } : {}), warnings }
}
