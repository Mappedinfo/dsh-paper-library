/** Browsers decide whether and how to display this standard unload warning. */
export function bindFlowUnloadGuard({ window, state }) {
  const guard = event => {
    const snapshot = state()
    if (!snapshot.dirty && !snapshot.saving && !snapshot.invalid && !snapshot.blocked) return
    event.preventDefault()
    event.returnValue = ''
  }
  window.addEventListener('beforeunload', guard)
  return () => window.removeEventListener('beforeunload', guard)
}
