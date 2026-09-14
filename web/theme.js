(function () {
  'use strict'
  // Keep this narrow protocol list aligned with src/client/theme-context.mjs.
  const TOKENS = Object.freeze([
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
  const safeValue = value => typeof value === 'string' && value.length > 0 && value.length <= 512
    && !/[;{}<>\u0000-\u001f]/.test(value) && !/(?:url|expression|var)\s*\(|@import/i.test(value)

  function create({ window: browser = window } = {}) {
    const root = browser.document.documentElement
    const media = browser.matchMedia('(prefers-color-scheme: dark)')
    const embedded = browser.parent !== browser
    const applied = new Set()
    let active = true
    let hostOwned = false
    const setMode = mode => {
      root.dataset.theme = mode
      root.style.colorScheme = mode
    }
    const systemMode = () => { if (active && !hostOwned) setMode(media.matches ? 'dark' : 'light') }
    const clearTokens = () => {
      for (const name of applied) root.style.removeProperty(name)
      applied.clear()
    }
    const validToken = (name, value) => {
      if (!safeValue(value)) return false
      if (name === '--dsh-content-font-size') return /^(?:1[2-7])px$/.test(value)
      const property = name === '--dsw-font-family' ? 'font-family' : 'color'
      return !browser.CSS?.supports || browser.CSS.supports(property, value)
    }
    const receive = event => {
      if (!active || !embedded || event.origin !== browser.location.origin || event.source !== browser.parent) return
      const data = event.data
      if (data?.type !== 'paper-library:theme' || data.version !== 1) return
      if (data.status === 'unavailable') {
        hostOwned = false
        clearTokens()
        systemMode()
        return
      }
      if (data.status !== 'ready' || !['light', 'dark'].includes(data.mode)
        || !data.tokens || typeof data.tokens !== 'object' || Array.isArray(data.tokens)) return
      clearTokens()
      hostOwned = true
      setMode(data.mode)
      for (const name of TOKENS) {
        const value = data.tokens[name]
        if (!validToken(name, value)) continue
        root.style.setProperty(name, value)
        applied.add(name)
      }
    }
    const request = () => {
      if (active && embedded) browser.parent.postMessage({ type: 'paper-library:request-theme', version: 1 }, browser.location.origin)
    }
    const dispose = () => {
      if (!active) return
      active = false
      media.removeEventListener('change', systemMode)
      browser.removeEventListener('message', receive)
      browser.removeEventListener('pageshow', request)
      browser.removeEventListener('pagehide', onPageHide)
      clearTokens()
    }
    // A bfcache page retains its listeners and asks for current host state on pageshow.
    const onPageHide = event => { if (!event.persisted) dispose() }
    systemMode()
    media.addEventListener('change', systemMode)
    browser.addEventListener('message', receive)
    browser.addEventListener('pageshow', request)
    browser.addEventListener('pagehide', onPageHide)
    request()
    return { dispose }
  }

  window.PaperLibraryTheme = { create, tokens: TOKENS, instance: create() }
})()
