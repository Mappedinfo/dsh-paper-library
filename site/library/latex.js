import { collectTexInputs, saveCompiledPdf } from './latex-compile.js';

export async function mountLatex(panel, { store, entry, entries = [entry], onOpen, onSaved }) {
  const current = await store.read(entry.path);
  if (current.blob.size > 1024 * 1024) throw new Error('编辑器支持 1 MiB 以内的 TeX 源文件。');
  let saved = await current.blob.text(), revision = current.revision;
  panel.innerHTML = `
    <section id="latex-view" class="browser-tex" aria-label="LaTeX 工作台">
      <aside class="latex-navigator" id="latex-navigator" aria-label="源文件导航">
        <div class="latex-nav-tabs"><strong>文件</strong></div>
        <ul class="latex-files" data-id="files"></ul>
      </aside>
      <div class="latex-editor-surface">
        <header class="latex-toolbar" aria-label="LaTeX 工作台工具栏">
          <strong class="latex-title">LaTeX 工作台</strong>
          <button type="button" class="button primary" data-id="compile">编译</button>
          <select data-id="engine" aria-label="编译引擎"><option value="latex">pdfLaTeX</option><option value="lualatex">LuaLaTeX</option></select>
          <button type="button" class="button subtle" data-id="cancel" hidden>取消编译</button>
          <span class="latex-toolbar-divider" aria-hidden="true"></span>
          <button type="button" class="button subtle paper-switch" data-id="navigator" aria-controls="latex-navigator" aria-expanded="true">侧边导航</button>
          <div class="latex-layout-controls" role="group" aria-label="工作区视图">
            <button type="button" class="button subtle latex-layout-button" data-layout="split" aria-pressed="true">并排</button>
            <button type="button" class="button subtle latex-layout-button" data-layout="source" aria-pressed="false">仅源码</button>
            <button type="button" class="button subtle latex-layout-button" data-layout="pdf" aria-pressed="false">仅 PDF</button>
          </div>
        </header>
        <div class="latex-content"><div class="latex-body" data-id="body" data-layout="split">
          <section class="latex-editor-pane" data-id="editor-pane" aria-label="源文件">
            <div class="latex-breadcrumb"><span data-id="path"></span><button type="button" class="button subtle" data-id="save">保存源码</button></div>
            <div class="latex-editor-wrap"><div class="latex-gutter" aria-hidden="true"><span data-id="lines"></span></div>
              <textarea data-id="source" aria-label="LaTeX 源码" wrap="off" spellcheck="false" autocapitalize="off"></textarea></div>
          </section>
          <div class="latex-splitter" data-id="splitter" role="separator" aria-label="调整源码与预览宽度" aria-valuemin="20" aria-valuemax="80" aria-valuenow="50" tabindex="0"></div>
          <section class="latex-preview-pane" data-id="pdf-pane" aria-label="PDF 预览">
            <div class="latex-preview-toolbar"><span class="latex-tab active">PDF</span>
              <div class="latex-preview-head" data-id="output" hidden>
                <button type="button" class="icon-button" data-id="prev" aria-label="上一页">‹</button><span data-id="page"></span>
                <button type="button" class="icon-button" data-id="next" aria-label="下一页">›</button>
                <div class="latex-pdf-tools"><button type="button" class="button subtle" data-id="keep">保存 PDF 到库</button><a class="button subtle" data-id="download">下载 PDF</a></div>
              </div>
            </div>
            <div class="latex-preview" data-id="sheet"><p class="latex-preview-empty">编译后在此预览 PDF。</p></div>
            <details data-id="details" class="tex-log" hidden><summary>编译日志</summary><pre class="latex-diff" data-id="log"></pre></details>
          </section>
        </div></div>
        <footer class="latex-footer"><p class="latex-status" data-id="status" role="status"></p></footer>
      </div>
    </section>`;
  const find = name => panel.querySelector('[data-id="' + name + '"]');
  const source = find('source'), engine = find('engine'), status = find('status');
  const parent = panel.ownerDocument.defaultView;
  const view = panel.querySelector('#latex-view'), body = find('body'), divider = find('splitter');
  const dir = entry.path.slice(0, entry.path.lastIndexOf('/') + 1);
  find('path').textContent = entry.path;
  const fileList = find('files');
  for (const file of entries.filter(file => file.kind === 'tex' && file.path.startsWith(dir))) {
    const row = panel.ownerDocument.createElement('li'), button = panel.ownerDocument.createElement('button');
    row.className = 'latex-file'; button.className = 'latex-file-open'; button.type = 'button';
    button.textContent = file.path.slice(dir.length);
    if (file.path === entry.path) {
      button.classList.add('active'); button.setAttribute('aria-current', 'page');
      button.onclick = () => source.focus();
    } else if (onOpen) button.onclick = () => onOpen(file.path);
    else button.disabled = true;
    row.append(button); fileList.append(row);
  }
  find('navigator').onclick = event => {
    const collapsed = view.classList.toggle('latex-nav-collapsed');
    view.querySelector('.latex-navigator').hidden = collapsed;
    event.currentTarget.setAttribute('aria-expanded', String(!collapsed));
  };
  const layouts = view.querySelectorAll('button[data-layout]');
  for (const button of layouts) button.onclick = () => {
    const mode = button.dataset.layout;
    body.dataset.layout = mode;
    find('editor-pane').hidden = mode === 'pdf';
    find('pdf-pane').hidden = mode === 'source';
    divider.hidden = mode !== 'split';
    for (const item of layouts) item.setAttribute('aria-pressed', String(item === button));
  };
  const horizontal = () => parent.getComputedStyle(divider).cursor === 'row-resize';
  const orientation = () => divider.setAttribute('aria-orientation', horizontal() ? 'horizontal' : 'vertical');
  function setSplit(value) {
    const percent = Math.min(80, Math.max(20, Math.round(value)));
    body.style.setProperty('--latex-split', percent + '%');
    divider.setAttribute('aria-valuenow', String(percent));
  }
  divider.onpointerdown = event => {
    if (event.button === 0) { event.preventDefault(); divider.focus(); divider.setPointerCapture(event.pointerId); }
  };
  divider.onpointermove = event => {
    if (!divider.hasPointerCapture(event.pointerId)) return;
    const rect = body.getBoundingClientRect();
    setSplit(100 * (horizontal() ? (event.clientY - rect.top) / rect.height : (event.clientX - rect.left) / rect.width));
  };
  divider.onkeydown = event => {
    const keys = horizontal() ? ['ArrowUp', 'ArrowDown'] : ['ArrowLeft', 'ArrowRight'];
    if (!keys.includes(event.key)) return;
    event.preventDefault(); setSplit(Number(divider.getAttribute('aria-valuenow')) + (event.key === keys[0] ? -5 : 5));
  };
  orientation();
  parent.addEventListener('resize', orientation);
  const lines = find('lines');
  let lineCount = 1;
  function displayLineNumbers() {
    const height = Number.parseFloat(parent.getComputedStyle(source).lineHeight) || 20.8;
    const first = Math.min(lineCount - 1, Math.max(0, Math.floor(source.scrollTop / height)));
    const shown = Math.min(lineCount - first, Math.ceil((source.clientHeight || 900) / height) + 2);
    // Just the visible lines are needed, even in a long imported source file.
    lines.textContent = Array.from({ length: shown }, (_, index) => first + index + 1).join('\n');
    lines.style.transform = 'translateY(' + (first * height - source.scrollTop) + 'px)';
  }
  function updateLineCount() {
    lineCount = source.value.split('\n').length;
    lines.parentElement.style.minWidth = String(lineCount).length + 'ch';
    displayLineNumbers();
  }
  const pdfName = entry.path.replace(/\.tex$/i, '') + '.pdf';
  let destroyed = false, worker = null, timer = null, output = null, url = null;
  let previewTask = null, document = null, page = 1, draw = null, viewVersion = 0;
  let saving = null, pendingCompile = 0;
  const dirty = () => source.value !== saved;
  function say(message, error = false) {
    if (!destroyed) { status.textContent = message; status.classList.toggle('error', error); }
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
    canvas.className = 'latex-page';
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
  updateLineCount();
  source.addEventListener('scroll', displayLineNumbers);
  parent.addEventListener('resize', displayLineNumbers);
  if (/\\(?:usepackage\s*\{(?:fontspec|luacode)\}|directlua)|%\s*!TEX\s+program\s*=\s*lualatex/i.test(saved)) engine.value = 'lualatex';
  fresh();
  source.addEventListener('input', () => { updateLineCount(); fresh(); say(dirty() ? '有未保存的修改。' : ''); });
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
    destroy() {
      destroyed = true; parent.removeEventListener('beforeunload', preventUnload);
      parent.removeEventListener('resize', orientation); parent.removeEventListener('resize', displayLineNumbers);
      stop(); releaseOutput();
    },
  };
}
