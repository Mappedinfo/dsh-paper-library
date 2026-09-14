import { createHash } from 'node:crypto'
import { z } from 'zod'

export const ANNOTATION_USAGE_KEY = 'paperLibraryAnnotationUsage'
export const ANNOTATION_REFERENCE_PLUGIN = 'Paper Library'
const MAX_USAGE = 5000
const identifier = z.string().min(1).max(160)
const revision = z.string().regex(/^[a-f0-9]{64}$/)
const referenceSchema = z.object({ id: identifier, version: revision, page: z.number().int().min(1).max(2000).optional() })
const referenceSourceSchema = z.object({
  version: z.literal(1),
  paperId: identifier, sessionId: z.string().min(1).max(200), snapshot_id: revision,
  annotation_refs: z.array(referenceSchema).max(1000), body_hash: revision,
})
const sourceSchema = z.object({ kind: z.literal('plugin'), plugin: z.literal(ANNOTATION_REFERENCE_PLUGIN), paperLibraryReference: referenceSourceSchema })
const usageSchema = z.object({
  sessionId: z.string(), revision: z.number().int(), truncated: z.boolean(),
  usage: z.record(identifier, revision).refine(value => Object.keys(value).length <= MAX_USAGE),
})

export const annotationBodyHash = text => createHash('sha256').update(text).digest('hex')
const textOf = content => Array.isArray(content) ? content.filter(block => block.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n') : ''

/** A source token alone is never evidence that its snapshot reached the log. */
export function loggedAnnotationReference(event, sessionId) {
  if (event.type !== 'user/message' || event.data?.source?.kind !== 'plugin' || event.data.source.plugin !== ANNOTATION_REFERENCE_PLUGIN) return null
  const parsed = sourceSchema.safeParse(event.data.source)
  if (!parsed.success) return null
  const source = parsed.data.paperLibraryReference
  if (sessionId && source.sessionId !== sessionId) return null
  const text = textOf(event.data.content)
  if (annotationBodyHash(text) !== source.body_hash) return null
  return { ...source, text }
}

export function emptyAnnotationUsage(sessionId) {
  return { sessionId, revision: -1, truncated: false, usage: {} }
}

/** Pure bounded fold; it neither opens PDFs nor holds its own live observers. */
export function foldAnnotationUsage(state, event) {
  const source = loggedAnnotationReference(event, state.sessionId)
  if (!source) return state
  const usage = { ...state.usage }
  for (const reference of source.annotation_refs) {
    // Reinsert to make eviction reflect the most recent explicit citation.
    delete usage[reference.id]
    Object.defineProperty(usage, reference.id, { value: reference.version, enumerable: true, configurable: true, writable: true })
  }
  const keys = Object.keys(usage)
  for (const id of keys.slice(0, Math.max(0, keys.length - MAX_USAGE))) delete usage[id]
  return { ...state, usage, revision: event.seq, truncated: state.truncated || keys.length > MAX_USAGE }
}

export const annotationUsageProjection = {
  key: ANNOTATION_USAGE_KEY,
  stateVersion: 1,
  stateSchema: usageSchema,
  init: header => emptyAnnotationUsage(header.id),
  apply: foldAnnotationUsage,
  wire: { viewSchema: usageSchema, view: state => state },
}

/** Metadata stays in the log source envelope instead of consuming model tokens. */
export function annotationReferenceSource(snapshot, snapshotId) {
  return sourceSchema.parse({
    kind: 'plugin', plugin: ANNOTATION_REFERENCE_PLUGIN,
    paperLibraryReference: { version: 1,
      paperId: snapshot.paperId, sessionId: snapshot.sessionId, snapshot_id: snapshotId,
      annotation_refs: snapshot.annotation_refs,
      body_hash: annotationBodyHash(snapshot.text),
    },
  })
}
