const TYPE = 'paper-library:context'

/** Only public route identifiers cross the iframe boundary; no settings or credentials. */
export function modelContext(sessionId, snapshot, available = true) {
  const context = { type: TYPE, version: 1, sessionId: sessionId ?? null, provider: null, model: null, reasoningEffort: null, status: 'unavailable' }
  if (!available || typeof sessionId !== 'string' || !sessionId) return context
  if (!snapshot || snapshot.status === 'loading' || snapshot.status === 'selecting' || !snapshot.current) return { ...context, status: snapshot?.status === 'error' ? 'unavailable' : 'loading' }
  const selection = snapshot.current
  if (snapshot.routable === false || typeof selection.provider !== 'string' || !selection.provider || typeof selection.model !== 'string' || !selection.model) return context
  return {
    ...context,
    provider: selection.provider,
    model: selection.model,
    reasoningEffort: typeof selection.reasoningEffort === 'string' ? selection.reasoningEffort : null,
    status: 'ready',
  }
}

/** Keep an existing reader frame in sync with its session's composer model store. */
export function bindModelContext({ window, target, sessionId, directory, available = true }) {
  let active = true
  const origin = window.location.origin
  const publish = () => {
    if (active) target.postMessage(modelContext(sessionId, directory?.store.getSnapshot(), available), origin)
  }
  const onMessage = event => {
    if (!active || event.origin !== origin || event.source !== target) return
    if (event.data?.version !== 1 || !['paper-library:ready', 'paper-library:request-context'].includes(event.data?.type)) return
    publish()
  }
  window.addEventListener('message', onMessage)
  const unsubscribe = directory?.store.subscribe(publish)
  publish()
  if (available && directory) void directory.load().then(publish, publish)
  return () => {
    if (!active) return
    active = false
    unsubscribe?.()
    window.removeEventListener('message', onMessage)
    // Address the captured old frame, never a ref that may now point at another session.
    target.postMessage(modelContext(null, null, false), origin)
  }
}
