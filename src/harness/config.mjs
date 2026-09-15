import { isAbsolute, resolve } from 'node:path'
import { defaultLibrary } from '../bridge.mjs'

/** Resolve deployment-owned paths; request JSON never controls these options. */
export function resolveConfig(raw = {}) {
  const library = raw.library ?? defaultLibrary
  if (typeof library !== 'string' || !isAbsolute(library)) throw new Error('paper-library: library must be an absolute directory')
  for (const key of ['python', 'provider', 'model']) {
    if (raw[key] !== undefined && (typeof raw[key] !== 'string' || !raw[key].trim())) throw new Error(`paper-library: ${key} must be a non-empty string`)
  }
  if (raw.python !== undefined && !isAbsolute(raw.python)) throw new Error('paper-library: python must be an absolute executable path')
  if (raw.localStateHome !== undefined && (typeof raw.localStateHome !== 'string' || !isAbsolute(raw.localStateHome))) throw new Error('paper-library: localStateHome must be an absolute directory')
  if (raw.requireToolApproval !== undefined && typeof raw.requireToolApproval !== 'boolean') throw new Error('paper-library: requireToolApproval must be boolean')
  const maxOutputTokens = raw.maxOutputTokens ?? 1600
  if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 64 || maxOutputTokens > 16384) throw new Error('paper-library: maxOutputTokens must be an integer from 64 to 16384')
  const maxLanguageOutputTokens = raw.maxLanguageOutputTokens ?? 8192
  if (!Number.isSafeInteger(maxLanguageOutputTokens) || maxLanguageOutputTokens < 256 || maxLanguageOutputTokens > 16384) throw new Error('paper-library: maxLanguageOutputTokens must be an integer from 256 to 16384')
  const maxAnnotationCharacters = raw.maxAnnotationCharacters ?? 24000
  if (!Number.isSafeInteger(maxAnnotationCharacters) || maxAnnotationCharacters < 1000 || maxAnnotationCharacters > 96000) throw new Error('paper-library: maxAnnotationCharacters must be an integer from 1000 to 96000')
  const analysisConcurrency = raw.analysisConcurrency ?? 2
  if (!Number.isSafeInteger(analysisConcurrency) || analysisConcurrency < 1 || analysisConcurrency > 4) throw new Error('paper-library: analysisConcurrency must be an integer from 1 to 4')
  return { library: resolve(library), ...(raw.localStateHome === undefined ? {} : { localStateHome: resolve(raw.localStateHome) }), python: raw.python, provider: raw.provider, model: raw.model, maxOutputTokens, maxLanguageOutputTokens, maxAnnotationCharacters, analysisConcurrency, requireToolApproval: raw.requireToolApproval ?? true }
}
