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
