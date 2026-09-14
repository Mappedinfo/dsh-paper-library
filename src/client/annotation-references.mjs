export const ANNOTATION_SOURCE = 'paper-library-annotations'
const TOKEN = /^\[\[paper-library-ref:v1:([A-Za-z0-9_-]{1,160}):([a-f0-9]{64})\]\]$/
const TOKENS = /\[\[paper-library-ref:v1:([A-Za-z0-9_-]{1,160}):([a-f0-9]{64})\]\]/g
const SNAPSHOT_BYTES = 512 * 1024

/** Reference identity survives Harness's plain-string draft persistence. */
export function parseAnnotationReference(ref) {
  if (typeof ref !== 'string') return null
  const match = TOKEN.exec(ref)
  return match ? { paperId: match[1], snapshot_id: match[2], ref } : null
}

/** Bound work to the current draft; finding an identity never reads a PDF. */
export function draftAnnotationReferences(draft) {
  if (typeof draft !== 'string') return []
  const found = new Map()
  for (const match of draft.slice(0, 65536).matchAll(TOKENS)) {
    if (!found.has(match[0])) found.set(match[0], { paperId: match[1], snapshot_id: match[2], ref: match[0] })
    if (found.size === 8) break
  }
  return [...found.values()]
}

/** Only canonical tokens cross the codec; the Host resolves their immutable content. */
export function annotationReferenceInsert(reference) {
  if (!reference || !parseAnnotationReference(reference.ref)
    || reference.clipboardText !== reference.ref || typeof reference.label !== 'string'
    || !reference.label.trim() || reference.label.length > 500) throw new Error('批注引用标识或标签无效')
  return { source: ANNOTATION_SOURCE, ref: reference.ref, label: reference.label, clipboardText: reference.ref }
}

/** One on-demand preview and at most twelve recent identities, with no document cache. */
export function createAnnotationReferences({ window, openPaper, notify }) {
  const listeners = new Set(), recent = new Map()
  let state = null, controller = null, active = true, sequence = 0
  const publish = value => { state = value; for (const listener of listeners) listener() }
  const remember = (sessionId, reference) => {
    const insert = annotationReferenceInsert(reference)
    recent.delete(insert.ref)
    recent.set(insert.ref, { sessionId, reference: insert })
    while (recent.size > 12) recent.delete(recent.keys().next().value)
    return insert
  }
  function close() {
    sequence += 1
    controller?.abort(); controller = null
    if (active) publish(null)
  }
  async function preview(sessionId, ref) {
    const identity = parseAnnotationReference(ref)
    if (!identity) return false
    close()
    const ticket = ++sequence
    controller = new AbortController()
    const signal = controller.signal
    publish({ sessionId, ref, loading: true })
    try {
      const response = await window.fetch('/api/paper-library/api', {
        method: 'POST', credentials: 'same-origin', signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'chat_reference', id: identity.paperId, snapshot_id: identity.snapshot_id }),
      })
      // Content-Length is optional, so also bound the decoded response before parsing.
      if (Number(response.headers?.get('content-length')) > SNAPSHOT_BYTES) throw new Error('引用预览超过读取上限')
      const raw = await response.text()
      if (new TextEncoder().encode(raw).length > SNAPSHOT_BYTES) throw new Error('引用预览超过读取上限')
      const envelope = JSON.parse(raw)
      if (!response.ok || !envelope.ok) throw new Error(typeof envelope.error === 'string' ? envelope.error : envelope.error?.message || '无法读取批注引用')
      const snapshot = envelope.result
      if (snapshot?.sessionId !== sessionId || typeof snapshot.text !== 'string'
        || !Array.isArray(snapshot.annotation_refs) || snapshot.annotation_refs.length > 1000) throw new Error('这份批注引用不属于当前论文对话，或内容已不可用')
      if (!active || ticket !== sequence) return true
      controller = null
      publish({ sessionId, ref, snapshot, paperId: identity.paperId, snapshot_id: identity.snapshot_id })
      const page = snapshot.annotation_refs.find(note => Number.isSafeInteger(note.page) && note.page > 0)?.page
      if (page) await openPaper({ sessionId, paperId: identity.paperId, page, snapshot_id: identity.snapshot_id })
    } catch (error) {
      if (!active || ticket !== sequence || signal.aborted) return true
      const message = error instanceof Error ? error.message : String(error)
      publish({ sessionId, ref, error: message })
      notify(sessionId, message)
    }
    return true
  }
  const source = {
    trigger: '@', name: ANNOTATION_SOURCE, order: 20, showGroupTitle: false,
    async candidates({ sessionId }, { query, signal }) {
      if (signal.aborted) return []
      return [...recent.values()].reverse().filter(item => item.sessionId === sessionId
        && (!query || item.reference.label.toLocaleLowerCase().includes(query.toLocaleLowerCase())))
        .slice(0, 5).map(({ reference }) => ({ name: reference.label, value: reference.ref }))
    },
    onPick({ session, candidate }) {
      const item = recent.get(candidate.value)
      return item?.sessionId === session.sessionId ? { insert: item.reference } : undefined
    },
    openReference({ sessionId }, { ref }) {
      if (!parseAnnotationReference(ref)) return false
      void preview(sessionId, ref)
      return true
    },
    codec: {
      clipboardText(ref) { if (!parseAnnotationReference(ref)) throw new Error('批注引用标识无效'); return ref },
      async serialize(ref, signal) {
        if (signal.aborted) throw new Error('批注引用提交已取消')
        if (!parseAnnotationReference(ref)) throw new Error('批注引用标识无效')
        return ref
      },
    },
  }
  return {
    source, remember, preview, close,
    async openPage(page) {
      if (!state?.snapshot || !Number.isSafeInteger(page) || page < 1 || page > 2000) return
      const current = state
      try { await openPaper({ sessionId: current.sessionId, paperId: current.paperId, snapshot_id: current.snapshot_id, page }) }
      catch (error) {
        if (!active || state !== current) return
        const message = error instanceof Error ? error.message : String(error)
        publish({ ...current, error: message }); notify(current.sessionId, message)
      }
    },
    getSnapshot: () => state,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    dispose() { close(); active = false; listeners.clear(); recent.clear() },
  }
}
