/** The reader-facing half of a whiteboard reference: the chip in the composer and the
 * `@` source that owns it.
 *
 * Only identity crosses this boundary. The draft carries a token plus a short label;
 * the material itself stays in the host's immutable snapshot, so a chip can never
 * smuggle content the reader did not freeze, and a preview never invents one.
 */
export const BOARD_SOURCE = 'paper-library-boards'
const TOKEN = /^\[\[paper-library-board:v1:([A-Za-z0-9_-]{1,60}):([a-f0-9]{64})\]\]$/
const TOKENS = /\[\[paper-library-board:v1:([A-Za-z0-9_-]{1,60}):([a-f0-9]{64})\]\]/g
const SNAPSHOT_BYTES = 256 * 1024

export function boardReferenceToken(boardId, snapshotId) {
  if (typeof boardId !== 'string' || !/^[A-Za-z0-9_-]{1,60}$/.test(boardId)) throw new Error('画板引用标识无效。')
  if (typeof snapshotId !== 'string' || !/^[a-f0-9]{64}$/.test(snapshotId)) throw new Error('画板引用快照无效。')
  return `[[paper-library-board:v1:${boardId}:${snapshotId}]]`
}

export function parseBoardReference(ref) {
  const match = typeof ref === 'string' && TOKEN.exec(ref)
  return match ? { boardId: match[1], snapshot_id: match[2], ref } : null
}

/** Bound work to the current draft; finding an identity never reads a board. */
export function draftBoardReferences(draft) {
  if (typeof draft !== 'string') return []
  const found = new Map()
  for (const match of draft.slice(0, 65536).matchAll(TOKENS)) {
    if (!found.has(match[0])) found.set(match[0], { boardId: match[1], snapshot_id: match[2], ref: match[0] })
    if (found.size === 8) break
  }
  return [...found.values()]
}

/** Only the canonical token crosses the codec; the Host resolves its frozen content. */
export function boardReferenceInsert(reference) {
  if (!reference || !parseBoardReference(reference.ref)
    || reference.clipboardText !== reference.ref || typeof reference.label !== 'string'
    || !reference.label.trim() || reference.label.length > 500) throw new Error('画板引用标识或标签无效。')
  return { source: BOARD_SOURCE, ref: reference.ref, label: reference.label, clipboardText: reference.ref }
}

/** One on-demand preview and at most twelve recent identities, with no board cache. */
export function createBoardReferences({ window, notify = () => {} }) {
  const listeners = new Set(), recent = new Map()
  let state = null, controller = null, active = true, sequence = 0
  const publish = value => { state = value; for (const listener of listeners) listener() }
  function remember(sessionId, reference) {
    const insert = boardReferenceInsert(reference)
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
    const identity = parseBoardReference(ref)
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
        body: JSON.stringify({ action: 'board_snapshot_get', snapshot_id: identity.snapshot_id }),
      })
      // Content-Length is optional, so also bound the decoded response before parsing.
      if (Number(response.headers?.get('content-length')) > SNAPSHOT_BYTES) throw new Error('画板引用预览超过读取上限')
      const raw = await response.text()
      if (new TextEncoder().encode(raw).length > SNAPSHOT_BYTES) throw new Error('画板引用预览超过读取上限')
      const envelope = JSON.parse(raw)
      if (!response.ok || !envelope.ok) throw new Error(typeof envelope.error === 'string' ? envelope.error : envelope.error?.message || '无法读取画板引用')
      const snapshot = envelope.result
      if (!snapshot || snapshot.board_id !== identity.boardId || typeof snapshot.text !== 'string') throw new Error('这份画板引用与快照不一致，或内容已不可用')
      if (!active || ticket !== sequence) return true
      controller = null
      publish({ sessionId, ref, snapshot, boardId: identity.boardId, snapshot_id: identity.snapshot_id })
    } catch (error) {
      if (!active || ticket !== sequence || signal.aborted) return true
      const message = error instanceof Error ? error.message : String(error)
      publish({ sessionId, ref, error: message })
      notify(sessionId, message)
    }
    return true
  }
  const source = {
    trigger: '@', name: BOARD_SOURCE, order: 30, showGroupTitle: false,
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
      if (!parseBoardReference(ref)) return false
      void preview(sessionId, ref)
      return true
    },
    codec: {
      clipboardText(ref) { if (!parseBoardReference(ref)) throw new Error('画板引用标识无效'); return ref },
      async serialize(ref, signal) {
        if (signal.aborted) throw new Error('画板引用提交已取消')
        if (!parseBoardReference(ref)) throw new Error('画板引用标识无效')
        return ref
      },
    },
  }
  return {
    source, remember, preview, close,
    getSnapshot: () => state,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    dispose() { close(); active = false; listeners.clear(); recent.clear() },
  }
}
