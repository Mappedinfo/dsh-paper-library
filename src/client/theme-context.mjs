/** Only presentation tokens cross this boundary; the host retains theme ownership. */
export const THEME_TOKENS = Object.freeze([
  '--dsw-alias-bg-base', '--dsw-alias-bg-layer-1', '--dsw-alias-bg-layer-2', '--dsw-alias-bg-layer-3',
  '--dsw-alias-bg-overlay', '--dsw-alias-bg-module-platform', '--dsw-alias-bg-mask-1', '--dsw-alias-bg-mask-drop',
  '--dsw-alias-border-l1', '--dsw-alias-border-l2', '--dsw-alias-border-l4',
  '--dsw-alias-brand-primary', '--dsw-alias-label-primary', '--dsw-alias-label-secondary',
  '--dsw-alias-label-tertiary', '--dsw-alias-label-primary-foreground', '--dsw-alias-link',
  '--dsw-alias-button-primary-fill', '--dsw-alias-button-primary-hover', '--dsw-alias-button-floating-fill',
  '--dsw-alias-interactive-bg-hover', '--dsw-alias-interactive-bg-hover-solid', '--dsw-alias-interactive-bg-active',
  '--dsw-specific-sidebar-fill', '--dsw-specific-sidebar-nav-item-active', '--dsw-specific-sidebar-nav-item-hover',
  '--dsw-specific-bubble', '--dsw-specific-input-major', '--dsw-specific-tip',
  '--dsw-alias-state-error-primary', '--dsw-alias-state-success-primary', '--dsw-alias-state-warn-primary',
  '--dsw-alias-state-warn-label', '--dsw-alias-state-warn-tertiary',
  '--dsw-alias-scrollbar-bg-l1', '--dsw-alias-scrollbar-hover-l1', '--dsw-font-family', '--dsh-content-font-size',
])

const TYPE = 'paper-library:theme'
const safeValue = value => typeof value === 'string' && value.length > 0 && value.length <= 512
  && !/[;{}<>\u0000-\u001f]/.test(value) && !/(?:url|expression|var)\s*\(|@import/i.test(value)

/** Snapshot colors are resolved from the host palette: built-in tokens are CSS-owned. */
export function themeContext({ window, getTheme }) {
  const body = window.document.body
  const snapshot = getTheme?.()
  const computed = window.getComputedStyle(body)
  const mode = ['light', 'dark'].includes(snapshot?.active?.colorScheme)
    ? snapshot.active.colorScheme : body.hasAttribute('data-ds-dark-theme') ? 'dark' : 'light'
  const tokens = {}
  for (const name of THEME_TOKENS) {
    const value = computed.getPropertyValue(name).replace(/[\t\r\n\f]+/g, ' ').trim()
    if (safeValue(value)) tokens[name] = value
  }
  if (!tokens['--dsw-font-family'] && safeValue(computed.fontFamily)) tokens['--dsw-font-family'] = computed.fontFamily
  if (Number.isInteger(snapshot?.fontSize) && snapshot.fontSize >= 12 && snapshot.fontSize <= 17) {
    tokens['--dsh-content-font-size'] = `${snapshot.fontSize}px`
  } else if (!/^(?:1[2-7])px$/.test(tokens['--dsh-content-font-size'] ?? '')) {
    delete tokens['--dsh-content-font-size']
  }
  return { type: TYPE, version: 1, status: 'ready', mode, tokens }
}

/** One visible iframe, official theme events, bounded DOM attributes, no polling or storage. */
export function bindThemeContext({ window, target, getTheme, subscribe }) {
  const origin = window.location.origin
  let active = true
  let queued = false
  let previous = ''
  const publish = () => {
    queued = false
    if (!active) return
    const context = themeContext({ window, getTheme })
    const serialized = JSON.stringify(context)
    if (serialized === previous) return
    previous = serialized
    target.postMessage(context, origin)
  }
  // ThemePresenter projects the same official event synchronously; read after its listeners.
  const schedule = () => {
    if (!active || queued) return
    queued = true
    window.queueMicrotask(publish)
  }
  const request = event => {
    if (event.origin !== origin || event.source !== target || event.data?.version !== 1
      || !['paper-library:ready', 'paper-library:request-theme'].includes(event.data?.type)) return
    previous = '' // A new document in the same WindowProxy still needs its initial palette.
    schedule()
  }
  const observer = window.MutationObserver ? new window.MutationObserver(schedule) : null
  // The service owns mode/font; these attributes also cover bootstrap and typography overrides.
  observer?.observe(window.document.body, { attributes: true, attributeFilter: ['style', 'class', 'data-ds-dark-theme'] })
  observer?.observe(window.document.documentElement, { attributes: true, attributeFilter: ['style', 'class'] })
  const stylesheetLoaded = event => {
    if (event.target?.tagName === 'LINK' && event.target.rel === 'stylesheet') schedule()
  }
  window.document.addEventListener('load', stylesheetLoaded, true)
  window.addEventListener('message', request)
  const unsubscribe = subscribe?.(schedule)
  schedule()
  return () => {
    if (!active) return
    active = false
    observer?.disconnect()
    unsubscribe?.()
    window.document.removeEventListener('load', stylesheetLoaded, true)
    window.removeEventListener('message', request)
    target.postMessage({ type: TYPE, version: 1, status: 'unavailable', mode: null, tokens: {} }, origin)
  }
}
