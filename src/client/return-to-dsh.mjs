/** Accept a return request only from this visible, same-origin plugin frame. */
export function bindReturnToDsh({ window, target, tabId, sessionId, sidebar }) {
  const origin = window.location.origin
  const receive = event => {
    if (event.origin !== origin || event.source !== target || event.data?.type !== 'paper-library:return-to-dsh' || event.data?.version !== 1) return
    if (sidebar.mounted.getSnapshot() !== sessionId) return
    sidebar.hide(tabId)
  }
  window.addEventListener('message', receive)
  return () => window.removeEventListener('message', receive)
}
