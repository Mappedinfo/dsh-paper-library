/**
 * Read the sources another sync service already maintains, without depending on it.
 *
 * A data-sync plugin keeps a list of local folders in step across machines. When the
 * user points `syncConfig` at that service's JSON config, this module reads the
 * directory roots out of it so the library can index them by symlink. Nothing is
 * imported, executed or written: an unreadable, renamed or absent file simply leaves
 * the explicitly configured `externalSources` in charge, and the reason is reported.
 *
 * The read is bounded and memoized by mtime, so calling it per request stays cheap
 * and a config edited while the host runs is picked up without a restart.
 */
import { readFile, stat } from 'node:fs/promises'

const MAX_BYTES = 256 * 1024
const MAX_SOURCES = 8
const ID = /^[a-z0-9][a-z0-9_.-]{0,63}$/
const SKIP_KINDS = new Set(['paper-library'])

/** Turn one service config into paper-library external sources. Never guesses a path. */
export function sourcesFromSyncConfig(value) {
  const warnings = []
  const out = []
  const entries = Array.isArray(value?.sources) ? value.sources : []
  if (!Array.isArray(value?.sources)) warnings.push('sync config has no sources array')
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue
    if (entry.kind && SKIP_KINDS.has(String(entry.kind))) continue
    if (entry.kind && String(entry.kind) !== 'directory') continue
    const root = entry.root
    if (typeof root !== 'string' || !root.trim() || !root.startsWith('/')) continue
    const id = `sync-${String(entry.id || out.length).toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '')}`.slice(0, 64)
    if (!ID.test(id)) continue
    out.push({ id, root, label: String(entry.id || id), from: 'sync-config' })
    if (out.length >= MAX_SOURCES) {
      warnings.push(`sync config lists more than ${MAX_SOURCES} directories; the rest were ignored`)
      break
    }
  }
  return { sources: out, warnings }
}

/** Bounded, memoized read of a sync service config file. */
export function createSyncSourceReader({ readFile: read = readFile, statFile = stat } = {}) {
  const cache = new Map()
  return async function readSyncSources(path) {
    if (!path) return { sources: [], warnings: [] }
    let stamp
    try {
      const info = await statFile(path)
      if (!info.isFile() || info.size > MAX_BYTES) return { sources: [], warnings: [`${path} is not a readable file of at most ${MAX_BYTES} bytes`] }
      stamp = `${info.size}:${info.mtimeMs}`
    } catch (error) {
      return { sources: [], warnings: [`sync config is unavailable: ${error.code || error.message}`] }
    }
    const hit = cache.get(path)
    if (hit && hit.stamp === stamp) return hit.value
    let value
    try {
      value = sourcesFromSyncConfig(JSON.parse(await read(path, 'utf8')))
    } catch (error) {
      value = { sources: [], warnings: [`sync config could not be parsed: ${error.message}`] }
    }
    cache.set(path, { stamp, value })
    return value
  }
}
