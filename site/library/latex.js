import { collectTexInputs, saveCompiledPdf } from './latex-compile.js';

export async function mountLatex(panel, { store, entry, onSaved }) {
  const current = await store.read(entry.path);
  if (current.blob.size > 1024 * 1024) throw new Error('编辑器支持 1 MiB 以内的 TeX 源文件。');
  let saved = await current.blob.text(), revision = current.revision;
  panel.innerHTML = `
    <div class="tex-workbench">
      <div class="tex-grid">
        <section class="tex-pane"><div class="tex-toolbar"><h2>源码</h2>
          <button type="button" data-id="save">保存源码</button></div>
          <textarea data-id="source" class="tex-source" spellcheck="false" autocapitalize="off" aria-label="LaTeX 源码"></textarea>
        </section>
        <section class="tex-pane"><div class="tex-toolbar"><h2>编译预览</h2>
          <select data-id="engine" aria-label="编译引擎"><option value="latex">pdfLaTeX</option><option value="lualatex">LuaLaTeX</option></select>
          <button type="button" data-id="compile">编译 PDF</button><button type="button" data-id="cancel" hidden>取消</button></div>
          <div class="tex-sheet" data-id="sheet"></div>
          <div data-id="output" class="tex-toolbar tex-nav" hidden>
            <button type="button" data-id="prev" aria-label="上一页">上一页</button>
            <span data-id="page"></span><button type="button" data-id="next" aria-label="下一页">下一页</button>
            <button type="button" data-id="keep">保存 PDF 到库</button><a data-id="download">下载 PDF</a>
          </div>
          <details data-id="details" hidden><summary>编译日志</summary><pre data-id="log"></pre></details>
        </section>
      </div>
      <p class="tex-status" data-id="status" role="status"></p>
    </div>`;
  const find = name => panel.querySelector('[data-id="' + name + '"]');
  const source = find('source'), engine = find('engine'), status = find('status');
  const parent = panel.ownerDocument.defaultView;
  const pdfName = entry.path.replace(/\.tex$/i, '') + '.pdf';
  let destroyed = false, worker = null, timer = null, output = null, url = null;
  let previewTask = null, document = null, page = 1, draw = null, viewVersion = 0;
  let saving = null, pendingCompile = 0;
  const dirty = () => source.value !== saved;
  function say(message, error = false) {
    if (!destroyed) { status.textContent = message; status.classList.toggle('tex-error', error); }
  }
  function fresh() {
    find('save').disabled = Boolean(saving) || !dirty();
  }
  function updateProgress(busy) {
    find('compile').disabled = busy;
    engine.disabled = busy;
    find('cancel').hidden = !busy;
  }
  function stop() {
    pendingCompile++;
    worker?.terminate();
    worker = null;
    clearTimeout(timer);
    if (!destroyed) updateProgress(false);
  }
  function releaseOutput() {
    viewVersion++;
    draw?.cancel();
    draw = null;
    previewTask?.destroy().catch(() => {});
    previewTask = null;
    document = null;
    output = null;
    if (url) URL.revokeObjectURL(url);
    url = null;
  }
  async function preview(number) {
    const doc = document, version = ++viewVersion;
    if (!doc || number < 1 || number > doc.numPages) return;
    draw?.cancel();
    const pdfPage = await doc.getPage(number);
    if (destroyed || version !== viewVersion) return;
    const bounds = pdfPage.getViewport({ scale: 1 });
    const viewport = pdfPage.getViewport({ scale: Math.min(2, 1200 / bounds.width, 1700 / bounds.height) });
    const canvas = panel.ownerDocument.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    canvas.setAttribute('aria-label', 'PDF 第 ' + number + ' 页');
    const task = pdfPage.render({ canvasContext: canvas.getContext('2d'), viewport });
    draw = task;
    try { await task.promise; } catch (error) { if (error.name === 'RenderingCancelledException') return; throw error; }
    if (destroyed || version !== viewVersion) return;
    page = number;
    find('sheet').replaceChildren(canvas);
    find('page').textContent = page + ' / ' + doc.numPages;
    find('prev').disabled = page <= 1;
    find('next').disabled = page >= doc.numPages;
    pdfPage.cleanup();
  }
  async function setOutput(bytes) {
    if (destroyed) return;
    releaseOutput();
    output = new Blob([bytes], { type: 'application/pdf' });
    url = URL.createObjectURL(output);
    const link = find('download');
    link.href = url;
    link.download = pdfName.split('/').pop();
    find('output').hidden = false;
    find('sheet').replaceChildren();
    find('page').textContent = '';
    find('prev').disabled = find('next').disabled = true;
    const version = viewVersion;
    const { openBrowserPdf } = await import('./pdf.js');
    if (destroyed || version !== viewVersion) return;
    const loading = openBrowserPdf(bytes);
    previewTask = loading;
    const doc = await loading.promise;
    if (destroyed || version !== viewVersion) return;
    document = doc;
    await preview(1);
  }
  async function compile() {
    if (worker || find('compile').disabled) return;
    const version = ++pendingCompile, text = source.value, selected = engine.value;
    updateProgress(true);
    releaseOutput();
    find('sheet').replaceChildren();
    find('output').hidden = true;
    find('details').hidden = true;
    say('正在载入编译所需的程序与排版文件，首次使用可能稍久…');
    try {
      const files = await collectTexInputs(store, entry.path, text);
      if (destroyed || version !== pendingCompile) return;
      worker = new Worker(new URL('./latex-worker.js', import.meta.url), { type: 'module' });
      timer = setTimeout(() => { stop(); say('编译超时。可检查宏包和循环，或重新载入编译资源。', true); }, 120000);
      worker.onerror = () => { stop(); say('浏览器无法启动 TeX 引擎，请检查站点资源是否已载入。', true); };
      worker.onmessage = async ({ data }) => {
        if (destroyed || version !== pendingCompile || data.event) return;
        stop();
        find('details').hidden = !data.log;
        find('log').textContent = data.log || '';
        if (data.error) { say(data.error, true); return; }
        say('已生成 PDF。');
        try { await setOutput(data.pdf); } catch (error) {
          say('已生成 PDF，可下载查看。预览未完成：' + error.message, true);
        }
      };
      worker.postMessage({ source: text, files, engine: selected });
    } catch (error) { if (!destroyed && version === pendingCompile) { stop(); say(error.message, true); } }
  }
  async function save() {
    if (saving || !dirty()) return;
    const value = source.value;
    const blob = new Blob([value], { type: 'text/plain;charset=utf-8' });
    if (blob.size > 1024 * 1024) { say('源码超过 1 MiB，请拆分文件后再保存。', true); return; }
    saving = store.write(entry.path, blob, revision);
    fresh();
    try {
      const result = await saving;
      revision = result.revision;
      saved = value;
      say(dirty() ? '已保存上一版，当前还有修改。' : '源码已保存。');
      await onSaved();
    } catch (error) { say(error.message, true); }
    finally { saving = null; if (!destroyed) fresh(); }
  }
  async function keep() {
    const blob = output;
    if (!blob) return;
    find('keep').disabled = true;
    try {
      const written = await saveCompiledPdf(store, pdfName, blob, name => parent.confirm('用这次编译结果更新「' + name + '」？'));
      if (!written) return;
      say('已保存 ' + pdfName);
      await onSaved();
    } catch (error) { say(error.message, true); }
    finally { if (!destroyed) find('keep').disabled = false; }
  }
  function preventUnload(event) {
    if (dirty() || saving) { event.preventDefault(); event.returnValue = ''; }
  }
  source.value = saved;
  if (/\\(?:usepackage\s*\{(?:fontspec|luacode)\}|directlua)|%\s*!TEX\s+program\s*=\s*lualatex/i.test(saved)) engine.value = 'lualatex';
  fresh();
  source.addEventListener('input', () => { fresh(); say(dirty() ? '有未保存的修改。' : ''); });
  source.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); void save(); }
  });
  find('save').onclick = save;
  find('compile').onclick = compile;
  find('cancel').onclick = () => { stop(); say('已取消编译。'); };
  find('keep').onclick = keep;
  find('prev').onclick = () => preview(page - 1).catch(error => say(error.message, true));
  find('next').onclick = () => preview(page + 1).catch(error => say(error.message, true));
  parent.addEventListener('beforeunload', preventUnload);
  return {
    canLeave: async () => {
      if (saving) { try { await saving; } catch { /* The draft remains in the editor. */ } }
      return !dirty() || parent.confirm('放弃这个源文件中尚未保存的修改？');
    },
    destroy() { destroyed = true; parent.removeEventListener('beforeunload', preventUnload); stop(); releaseOutput(); },
  };
}
