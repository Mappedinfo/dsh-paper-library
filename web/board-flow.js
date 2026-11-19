'use strict';
// Load the full workflow engine only when its view is requested.
window.PaperBoardFlowLoader = (() => {
  const base = document.currentScript?.src || window.location.href;
  let loading, loaded = false;
  function load() {
    if (loaded && window.PaperBoardFlow) return Promise.resolve(window.PaperBoardFlow);
    if (loading) return loading;
    const css = document.createElement('link'), script = document.createElement('script');
    css.rel = 'stylesheet'; css.href = new URL('./paper-flow-editor.css', base).href;
    script.src = new URL('./paper-flow-editor.js', base).href;
    loading = Promise.all([
      new Promise((resolve, reject) => { css.onload = resolve; css.onerror = () => reject(new Error('流程样式加载失败，请重试。')); document.head.append(css); }),
      window.PaperBoardFlow ? Promise.resolve() : new Promise((resolve, reject) => { script.onload = resolve; script.onerror = () => reject(new Error('流程组件加载失败，请重试。')); document.head.append(script); }),
    ]).then(() => {
      if (!window.PaperBoardFlow) throw new Error('流程组件未就绪，请重试。');
      loaded = true; return window.PaperBoardFlow;
    }).catch(error => { css.remove(); script.remove(); loading = null; throw error; });
    return loading;
  }
  return Object.freeze({ load });
})();

// 原生文献工具栏和流程组件共用 ownerDocument 的面板状态，不另存选择。
(() => {
  const tools = document.getElementById?.('paper-tools');
  if (!tools) return;
  const doc = tools.ownerDocument;
  const group = doc.createElement('div');
  group.className = 'reader-control-group paper-flow-native-panels';
  group.setAttribute('role', 'group');
  group.setAttribute('aria-label', '论文流程面板');
  group.hidden = true;
  const buttons = new Map();
  for (const [panel, label] of [['compare', '比较'], ['code', '代码与数据']]) {
    const button = doc.createElement('button');
    button.type = 'button';
    button.id = 'paper-flow-' + panel + '-toggle';
    button.className = 'button subtle';
    button.textContent = label;
    button.setAttribute('aria-controls', 'paper-flow-' + panel + '-panel');
    button.setAttribute('aria-expanded', 'false');
    button.addEventListener('click', () => {
      if (!group.hidden) doc.dispatchEvent(new CustomEvent('paper-flow-panel-toggle', { detail: { panel } }));
    });
    group.append(button);
    buttons.set(panel, button);
  }
  tools.prepend(group);
  doc.addEventListener('paper-flow-panels-state', event => {
    const state = event.detail;
    if (!state || typeof state.open !== 'boolean') return;
    group.hidden = !state.open;
    for (const [panel, button] of buttons) {
      button.setAttribute('aria-expanded', String(state.open && state.panel === panel));
    }
  });
})();
