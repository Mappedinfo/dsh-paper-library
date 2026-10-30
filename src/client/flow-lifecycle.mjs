/** Retain only an active flow or Slides while the tab is hidden. */
export function retainFlowFrame({ visible, slides, flowActive }) {
  return !!(visible || slides || flowActive)
}

/** Accept lifecycle state only from this tab's current same-origin iframe. */
export function bindFlowWindow({ window, getFrame, onChange }) {
  const receive = event => {
    const target = getFrame()?.contentWindow
    if (!target || event.source !== target || event.origin !== window.location.origin
      || event.data?.type !== 'paper-library:flow-window' || event.data?.version !== 1
      || typeof event.data.active !== 'boolean') return
    onChange(event.data.active)
  }
  window.addEventListener('message', receive)
  return () => window.removeEventListener('message', receive)
}
