import { api } from './client.js';

const apiRoot = '/api/pages/latex/';
const call = (operation, data) => api(apiRoot + operation, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
});

export async function mountLatex(panel) {
  panel.innerHTML = `
    <div class="lt-projects">
      <div><label>写作项目 <select id="lt-project"><option value="">选择本机项目</option></select></label>
        <button id="lt-refresh" type="button">刷新列表</button></div>
      <form id="lt-create"><input id="lt-title" aria-label="新项目名称" placeholder="新项目名称" maxlength="200" required><button>新建项目</button></form>
    </div>
    <p id="lt-location" hidden></p><p id="lt-status" role="status"></p>
    <div class="lt-columns" id="lt-workspace" hidden>
      <section class="lt-pane">
        <header><h2>源码</h2><label>文件 <select id="lt-file"></select></label></header>
        <textarea id="lt-source" spellcheck="false" aria-label="LaTeX 源码" autocapitalize="off"></textarea>
        <footer><button id="lt-save" type="button">保存源码</button><button id="lt-reload" type="button">重新读取</button>
          <button id="lt-add" type="button">新建源文件</button></footer>
      </section>
      <section class="lt-pane">
        <header><h2>PDF 预览</h2><label>引擎 <select id="lt-engine"><option>xelatex</option><option>pdflatex</option><option>lualatex</option></select></label>
          <button id="lt-build" type="button" title="用本机 latexmk 编译受信任的项目">在本机编译</button></header>
        <div class="lt-paper"><p id="lt-empty">编译后可逐页预览。</p><img id="lt-image" alt="" hidden></div>
        <footer><button type="button" id="lt-prev">上一页</button><span id="lt-page"></span>
          <button type="button" id="lt-next">下一页</button><button type="button" id="lt-preview">读取现有 PDF</button></footer>
        <details id="lt-details" hidden><summary>编译日志</summary><pre id="lt-log"></pre></details>
      </section>
    </div>`;
  const byId = name => panel.querySelector('#lt-' + name);
  const projects = byId('project'), files = byId('file'), editor = byId('source');
  const status = byId('status'), image = byId('image');
  let catalog = [], project, source, page = 0, pages = 0, busy = false;
  const win = panel.ownerDocument.defaultView;
  const dirty = () => Boolean(source && editor.value !== source.content);
  const binding = p => ({ id: p.id, generation: p.binding_generation });

  function updateControls() {
    for (const input of panel.querySelectorAll('button, input, select')) input.disabled = busy;
    editor.readOnly = busy;
    byId('workspace').hidden = !source;
    byId('save').disabled = busy || !dirty();
    byId('prev').disabled = busy || page <= 1;
    byId('next').disabled = busy || page >= pages;
    byId('preview').disabled = busy || !project?.pdf_present;
  }

  function report(message, error = false) {
    status.textContent = message;
    status.classList.toggle('lt-error', error);
  }

  async function perform(message, action) {
    if (busy) return;
    busy = true;
    updateControls();
    report(message);
    try {
      await action();
    } catch (error) {
      report(error.message || '本机请求失败，请重试。', true);
    } finally {
      projects.value = project?.id || '';
      if (source) files.value = source.path;
      busy = false;
      updateControls();
    }
  }

  function option(label, value) {
    const element = panel.ownerDocument.createElement('option');
    element.textContent = label;
    element.value = value;
    return element;
  }

  function setProjects(items) {
    catalog = items;
    projects.replaceChildren(option('选择本机项目', ''), ...items.map(item => option(item.title, item.id)));
  }

  function discard() {
    return !dirty() || win.confirm('放弃当前文件尚未保存的修改？');
  }

  function setSource(file) {
    source = file;
    files.value = file.path;
    editor.value = file.content;
    editor.scrollTop = 0;
    report('已读取 ' + file.path);
  }

  function clearPreview() {
    page = pages = 0;
    image.removeAttribute('src');
    image.hidden = true;
    byId('empty').hidden = false;
    byId('page').textContent = '';
  }

  async function showPage(number) {
    const result = await call('preview', { ...binding(project), page: number });
    image.src = 'data:image/png;base64,' + result.image;
    image.alt = '编译稿第 ' + result.page + ' 页';
    image.hidden = false;
    byId('empty').hidden = true;
    page = result.page;
    pages = result.page_count;
    byId('page').textContent = page + ' / ' + pages;
  }

  async function openProject(selected) {
    const tree = await call('tree', binding(selected));
    const path = tree.files.includes(tree.main_path) ? tree.main_path : tree.files[0];
    if (!path) throw new Error('项目中没有可读取的源码，请在本机核对项目文件夹。');
    const next = await call('read', { ...binding(selected), path });
    project = selected;
    byId('location').textContent = '稿件目录　' + project.root;
    byId('location').hidden = false;
    files.replaceChildren(...tree.files.map(name => option(name, name)));
    setSource(next);
    byId('details').hidden = true;
    byId('log').textContent = '';
    clearPreview();
    if (tree.truncated) report('已读取 ' + next.path + '。文件列表已达到上限。');
  }

  async function save() {
    if (!dirty()) return;
    const content = editor.value;
    const result = await call('write', { ...binding(project), path: source.path, revision: source.revision, content });
    source = { ...source, content, revision: result.revision };
    report('已保存 ' + source.path);
  }

  projects.addEventListener('change', () => {
    const selected = catalog.find(item => item.id === projects.value);
    if (!selected || !discard()) { projects.value = project?.id || ''; return; }
    void perform('正在读取项目…', () => openProject(selected));
  });
  async function refreshProjects() {
    setProjects((await api(apiRoot + 'projects')).projects);
    report(catalog.length ? '已读取 ' + catalog.length + ' 个本机项目。' : '本库尚无写作项目，可以新建稿件。');
  }
  byId('refresh').addEventListener('click', () => void perform('正在刷新项目列表…', refreshProjects));

  byId('create').addEventListener('submit', event => {
    event.preventDefault();
    const title = byId('title').value.trim();
    if (!title || !discard()) return;
    void perform('正在本地资料库内新建项目…', async () => {
      const result = await call('create', { title });
      setProjects([...catalog, result.project]);
      byId('title').value = '';
      await openProject(result.project);
    });
  });

  files.addEventListener('change', () => {
    const path = files.value;
    if (!discard()) { files.value = source.path; return; }
    void perform('正在读取源文件…', async () => setSource(await call('read', { ...binding(project), path })));
  });
  byId('reload').addEventListener('click', () => {
    if (!discard()) return;
    void perform('正在读取最新源码…', async () => {
      const result = await api(apiRoot + 'projects');
      const selected = result.projects.find(item => item.id === project.id);
      if (!selected) throw new Error('项目已归档或移除。');
      // 绑定变化时切到新文件夹的主文件，旧稿仍留在原目录。
      if (selected.binding_generation !== project.binding_generation) {
        await openProject(selected);
      } else {
        setSource(await call('read', { ...binding(selected), path: source.path }));
      }
      setProjects(result.projects);
    });
  });
  byId('add').addEventListener('click', () => {
    if (!discard()) return;
    const path = win.prompt('新源文件的名称，例如 appendix.tex；也可指定已有子目录。');
    if (!path?.trim()) return;
    void perform('正在新建源文件…', async () => {
      const result = await call('write', { ...binding(project), path: path.trim(), revision: '', content: '' });
      files.append(option(result.path, result.path));
      setSource({ ...result, content: '' });
    });
  });
  byId('save').addEventListener('click', () => void perform('正在保存…', save));
  editor.addEventListener('keydown', event => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      if (dirty()) void perform('正在保存…', save);
    }
  });
  editor.addEventListener('input', () => {
    updateControls();
    report((dirty() ? '尚未保存 ' : '当前文件 ') + source.path);
  });
  win.addEventListener('beforeunload', event => {
    if (dirty()) { event.preventDefault(); event.returnValue = ''; }
  });

  byId('build').addEventListener('click', () => void perform('正在本机编译…', async () => {
    await save();
    report('正在本机编译…');
    clearPreview();
    byId('details').hidden = true;
    const result = await call('compile', { ...binding(project), engine: byId('engine').value });
    const details = byId('details');
    details.hidden = false;
    details.open = !result.ok;
    byId('log').textContent = [...result.warnings, ...result.errors, result.log_tail].join('\n');
    project.pdf_present = Boolean(result.pdf_path);
    if (!result.ok) { report('本次编译失败，请查看日志。源码已保存在本机。', true); return; }
    await showPage(1);
    report('编译完成，共 ' + pages + ' 页。');
  }));
  for (const [id, target] of [['prev', () => page - 1], ['next', () => page + 1], ['preview', () => 1]]) {
    byId(id).addEventListener('click', () => void perform('正在读取 PDF…', async () => {
      await showPage(target());
      report('正在预览本机 PDF。');
    }));
  }

  await perform('正在读取本机写作项目…', refreshProjects);
}
