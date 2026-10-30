'use strict';
// Shared window geometry only. Each feature continues to own saving and closing.
window.PaperFloatingWindows = (() => {
  const selector = 'dialog,[role="dialog"]:not(.presentation),.language-panel,.reading-side-panel,.reading-chat-panel,.paper-analysis-panel,.challenge-panel';
  const states = new Map(), properties = ['position','inset','left','top','right','bottom','margin','width','height','max-width','max-height','z-index','box-sizing'];
  let persistence, observer, nextLayer = 50, started = false;
  const visible = element => !element.hidden && (element.tagName !== 'DIALOG' || element.open) && element.getClientRects().length > 0;
  const expanded = element => element.classList.contains('is-expanded') || document.fullscreenElement === element;
  const headerOf = element => element.querySelector(':scope > header,:scope > form > header,:scope > .dialog-heading,:scope > form > .dialog-heading,:scope > .summary-dialog-head,:scope > .dialog-header,:scope > .modal-header,:scope > h2,:scope > h3');
  const embedded = element => element.tagName === 'DIALOG' && Boolean(element.parentElement?.closest(selector));
  // Small menus escape scrolling toolbars but stay below their own trigger.
  // Feature owners still decide when a menu opens, closes or receives focus.
  function placeBelow(trigger, panel) {
    if (!trigger || !panel) return;
    const anchor = trigger.getBoundingClientRect(), view = trigger.ownerDocument?.defaultView || window;
    const gutter = 8, top = (anchor.bottom ?? anchor.top + anchor.height) + 5;
    const width = Math.min(panel.getBoundingClientRect().width, Math.max(0, view.innerWidth - gutter * 2));
    panel.style.position = 'fixed';
    panel.style.top = `${top}px`;
    panel.style.left = `${Math.max(gutter, Math.min(anchor.left, view.innerWidth - width - gutter))}px`;
    panel.style.right = 'auto';
    panel.style.maxWidth = `${Math.max(0, view.innerWidth - gutter * 2)}px`;
    panel.style.maxHeight = `${Math.max(0, view.innerHeight - top - gutter)}px`;
  }
  function attach(element, options = {}) {
    if (!element || embedded(element)) return null;
    if (states.has(element)) return states.get(element).api;
    const key = options.key || (element.id ? `reader:floating-${element.id}` : null), store = options.persistence || persistence;
    const original = new Map(properties.map(name => [name, [element.style.getPropertyValue(name), element.style.getPropertyPriority(name)]]));
    const state = { element, position: null, revision: 0, loaded: false, disposed: false, dragging: null, timer: null, header: null, grip: null, suspended: false, wasVisible: false };
    const off = [];
    function listen(target, type, fn) { target.addEventListener(type, fn); off.push(() => target.removeEventListener(type, fn)); }
    function restoreStyles() { for (const [name, [value, priority]] of original) { if (value) element.style.setProperty(name, value, priority); else element.style.removeProperty(name); } }
    function apply(value, notify = true) {
      if (!value || state.disposed || !visible(element) || expanded(element)) return;
      const maxWidth = Math.max(1, window.innerWidth - 16), maxHeight = Math.max(1, window.innerHeight - 16);
      const width = Math.min(maxWidth, Math.max(1, Number(value.width) || element.getBoundingClientRect().width));
      const height = Math.min(maxHeight, Math.max(1, Number(value.height) || element.getBoundingClientRect().height));
      const x = Math.max(8, Math.min(Number(value.x) || 0, Math.max(8, window.innerWidth - width - 8)));
      const y = Math.max(8, Math.min(Number(value.y) || 0, Math.max(8, window.innerHeight - height - 8)));
      state.position = { x, y, width, height };
      const first = !element.classList.contains('paper-floating-positioned');
      if (first) element.classList.add('paper-floating-positioned');
      Object.assign(element.style, { position: 'fixed', inset: 'auto', left: `${x}px`, top: `${y}px`, right: 'auto', bottom: 'auto', margin: '0', width: `${width}px`, height: `${height}px`, maxWidth: `${maxWidth}px`, maxHeight: `${maxHeight}px`, boxSizing: 'border-box' });
      if (first && notify) element.dispatchEvent(new Event('paper-floating-positioned', { bubbles: true }));
    }
    function save() {
      clearTimeout(state.timer);
      if (!store || !key || !state.loaded || !state.position || !visible(element) || expanded(element) || element.classList.contains('is-collapsed')) return;
      const b = element.getBoundingClientRect(); state.position = { x: b.left, y: b.top, width: b.width, height: b.height };
      const value = { ...state.position }; state.timer = setTimeout(() => { state.timer = null; if (!state.disposed) void store.put(key, value).catch(() => {}); }, 180);
    }
    async function restore() {
      if (state.loaded || state.disposed) { if (state.position) apply(state.position); return; }
      state.loaded = true; const revision = state.revision;
      if (!store || !key) return;
      try { const saved = await store?.get(key); if (!state.disposed && state.revision === revision && saved && ['x','y','width','height'].every(k => Number.isFinite(saved[k]))) { state.position = saved; apply(saved); } } catch { /* Geometry loss cannot block document work. */ }
    }
    function front() { if (!expanded(element)) { const floor = Number(element.dataset?.floatingMinLayer); nextLayer = Math.max(nextLayer + 1, Number.isFinite(floor) ? floor : 0); const layer = String(nextLayer); element.style.zIndex = layer; const host = element.closest('.reading-panels-global-host'); if (host) host.style.zIndex = layer; } }
    function refresh() {
      if (state.disposed) return;
      if (expanded(element)) { if (!state.suspended) { state.suspended = true; restoreStyles(); } }
      else if (state.suspended) { state.suspended = false; if (state.position) apply(state.position); }
      const header = headerOf(element);
      if (header !== state.header || state.grip && !state.grip.isConnected) {
        state.grip?.remove(); state.header = header;
        if (header) {
          header.classList.add('paper-floating-header');
          const existing = element.querySelector('#language-drag');
          const grip = existing || document.createElement('button');
          if (!existing) { grip.type = 'button'; grip.textContent = '⠿'; header.prepend(grip); }
          grip.classList.add('paper-floating-grip'); grip.setAttribute('aria-label', '移动窗口'); grip.title = '拖动窗口；方向键移动，Shift 加速';
          state.grip = grip;
        }
      }
      if (state.grip) state.grip.disabled = expanded(element);
      const nowVisible = visible(element); if (nowVisible && !state.wasVisible) front(); state.wasVisible = nowVisible;
      if (nowVisible) { void restore(); if (state.position && !expanded(element)) apply(state.position); }
    }
    function finish(event) {
      if (state.dragging?.id !== event.pointerId) return;
      const id = state.dragging.id; state.dragging = null; element.classList.remove('paper-floating-dragging');
      try { if (element.hasPointerCapture?.(id)) element.releasePointerCapture(id); } catch { /* Already released by the platform. */ }
      save();
    }
    listen(element, 'pointerdown', event => {
      front(); if (event.button !== 0 || event.isPrimary === false || expanded(element)) return;
      const header = headerOf(element); if (!header?.contains(event.target)) return;
      if (event.target.closest('button,input,select,textarea,a,summary,[contenteditable]') !== state.grip && event.target.closest('button,input,select,textarea,a,summary,[contenteditable]')) return;
      const b = element.getBoundingClientRect(); ++state.revision;
      state.dragging = { id: event.pointerId, x: event.clientX, y: event.clientY, box: b }; event.preventDefault();
      apply({ x: b.left, y: b.top, width: b.width, height: b.height }); front(); element.classList.add('paper-floating-dragging');
      try { element.setPointerCapture(event.pointerId); } catch { /* Window-level end handlers still release the gesture. */ }
    });
    listen(element, 'pointermove', event => { const d = state.dragging; if (!d || d.id !== event.pointerId) return; event.preventDefault(); apply({ x: d.box.left + event.clientX - d.x, y: d.box.top + event.clientY - d.y, width: d.box.width, height: d.box.height }); });
    for (const name of ['pointerup','pointercancel','lostpointercapture']) listen(window, name, finish);
    listen(element, 'keydown', event => {
      if (event.target !== state.grip || expanded(element)) return;
      const delta = { ArrowLeft: [-1,0], ArrowRight: [1,0], ArrowUp: [0,-1], ArrowDown: [0,1] }[event.key]; if (!delta) return;
      event.preventDefault(); const b = element.getBoundingClientRect(), step = event.shiftKey ? 40 : 10; ++state.revision; front();
      apply({ x: b.left + delta[0] * step, y: b.top + delta[1] * step, width: b.width, height: b.height }); save();
    });
    const resize = typeof ResizeObserver === 'function' ? new ResizeObserver(() => { if (state.position && visible(element) && !expanded(element) && !element.classList.contains('is-collapsed') && !state.dragging) { const b = element.getBoundingClientRect(); apply({ x: b.left, y: b.top, width: b.width, height: b.height }); save(); } }) : null;
    resize?.observe(element);
    state.api = { restore, save, refresh, reset() { ++state.revision; clearTimeout(state.timer); state.position = null; restoreStyles(); element.classList.remove('paper-floating-positioned'); if (store && key) void store.put(key, null).catch(() => {}); }, dispose() { if (state.timer !== null && store && key && state.position) void store.put(key, { ...state.position }).catch(() => {}); state.disposed = true; clearTimeout(state.timer); resize?.disconnect(); for (const remove of off) remove(); state.grip?.remove(); state.header?.classList.remove('paper-floating-header'); states.delete(element); } };
    states.set(element, state); refresh(); return state.api;
  }
  function scan() {
    for (const [element, state] of states) { if (!element.isConnected || embedded(element)) state.api.dispose(); else state.api.refresh(); }
    for (const element of document.querySelectorAll(selector)) if (!embedded(element)) attach(element);
  }
  function viewportChanged() { for (const state of states.values()) { if (!state.position || !visible(state.element)) continue; state.api.refresh(); state.api.save(); } }
  function start(options = {}) {
    persistence = options.persistence || persistence;
    if (!started) { started = true; observer = new MutationObserver(scan); observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden','open','class'] }); window.addEventListener('resize', viewportChanged); document.addEventListener('fullscreenchange', scan); scan(); }
    return { dispose() { observer?.disconnect(); window.removeEventListener('resize', viewportChanged); document.removeEventListener('fullscreenchange', scan); for (const state of [...states.values()]) state.api.dispose(); started = false; } };
  }
  return { start, attach, placeBelow, reset(element) { states.get(element)?.api.reset(); } };
})();
if (document.body?.hasAttribute('data-floating-windows')) {
  const floating = window.PaperFloatingWindows.start();
  window.addEventListener('pagehide', () => floating.dispose(), { once: true });
}
