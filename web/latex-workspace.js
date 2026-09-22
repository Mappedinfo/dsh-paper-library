'use strict';
/**
 * LaTeX workspace: edit a project folder's sources and look at the PDF they build to.
 *
 * The folder stays authoritative. This panel reads and writes through the same
 * revision-checked actions the agent uses, so a stale save is refused with the
 * current text and offered as a choice instead of silently overwriting a change
 * made in another editor. Compiling runs the reader's own latexmk in that folder
 * and shows the real exit code, errors and log tail.
 */
window.PaperLatexWorkspace = (() => {
  const AUTOSAVE_MS = 900;
  const MAX_RENDERED_PAGES = 6;
  function create({api, toast = () => {}, getLibrary = () => ''}) {
    const make = (tag, cls, text) => { const node = document.createElement(tag); if (cls) node.className = cls; if (text !== undefined) node.textContent = text; return node; };
    let projects = [], project = null, tree = null, file = null, revision = null, pageCount = 0, page = 1;
    let dirty = false, saving = false, compiling = false, disposed = false, timer = null, generation = 0, saveQueue = Promise.resolve();
    const rendered = new Map();
    let pendingConflict = null;

    const trigger = make('button', 'button subtle', 'LaTeX'); trigger.id = 'latex-open'; trigger.type = 'button';
    trigger.title = '打开 LaTeX 工作台：编辑项目文件夹里的 .tex 并查看它编译出的 PDF';
    (document.querySelector('.topbar-actions') || document.body).append(trigger);

    const dialog = make('dialog', 'latex-workspace'); dialog.id = 'latex-workspace'; dialog.setAttribute('aria-labelledby', 'latex-workspace-title');
    const header = make('header');
    const title = make('strong', '', 'LaTeX 工作台'); title.id = 'latex-workspace-title';
    const subtitle = make('small', '', '项目就是一个装着 .tex 和对应 PDF 的文件夹');
    const titleBox = make('div', 'latex-title'); titleBox.append(title, subtitle);
    const closeButton = make('button', 'icon-button', '×'); closeButton.type = 'button'; closeButton.id = 'latex-close'; closeButton.setAttribute('aria-label', '关闭 LaTeX 工作台'); closeButton.addEventListener('click', () => dialog.close());
    header.append(titleBox, closeButton);

    const toolbar = make('div', 'latex-toolbar');
    const projectSelect = make('select'); projectSelect.id = 'latex-project'; projectSelect.setAttribute('aria-label', '选择 LaTeX 项目');
    const newToggle = make('button', 'button subtle', '＋ 登记文件夹'); newToggle.id = 'latex-project-new'; newToggle.type = 'button';
    const compile = make('button', 'button primary', '编译'); compile.id = 'latex-compile'; compile.type = 'button';
    const diffOpen = make('button', 'button subtle', '与上一版对比'); diffOpen.id = 'latex-diff-open'; diffOpen.type = 'button';
    const compareSelect = make('select'); compareSelect.id = 'latex-compare'; compareSelect.setAttribute('aria-label', '与另一个项目对比');
    const compareRun = make('button', 'button subtle', '项目对照'); compareRun.id = 'latex-compare-run'; compareRun.type = 'button';
    compareSelect.disabled = true;
    const mainLabel = make('span', 'latex-main'); mainLabel.id = 'latex-main';
    const saveState = make('span', 'latex-save-state'); saveState.id = 'latex-save-state'; saveState.setAttribute('role', 'status');
    toolbar.append(projectSelect, newToggle, mainLabel, saveState, compile, diffOpen, compareSelect, compareRun);

    const newForm = make('form', 'latex-new-form'); newForm.id = 'latex-new-form'; newForm.hidden = true;
    const newRoot = make('input'); newRoot.id = 'latex-new-root'; newRoot.type = 'text'; newRoot.placeholder = '/绝对/路径/到/你的/论文文件夹'; newRoot.autocomplete = 'off'; newRoot.spellcheck = false;
    const newTitle = make('input'); newTitle.id = 'latex-new-title'; newTitle.type = 'text'; newTitle.placeholder = '标题（可留空，默认用文件夹名）'; newTitle.autocomplete = 'off';
    const newStarter = make('input'); newStarter.id = 'latex-new-starter'; newStarter.type = 'checkbox';
    const starterLabel = make('label', 'latex-check'); starterLabel.append(newStarter, make('span', '', '文件夹里没有 .tex 时写入一个最小 main.tex'));
    const newSubmit = make('button', 'button primary', '登记'); newSubmit.id = 'latex-new-submit'; newSubmit.type = 'submit';
    const newCancel = make('button', 'button subtle', '取消'); newCancel.id = 'latex-new-cancel'; newCancel.type = 'button';
    newForm.append(newRoot, newTitle, starterLabel, newSubmit, newCancel);

    const body = make('div', 'latex-body');
    const left = make('section', 'latex-editor-pane'); left.setAttribute('aria-label', '源文件');
    const fileList = make('ul', 'latex-files'); fileList.id = 'latex-files';
    const editorWrap = make('div', 'latex-editor-wrap');
    const gutter = make('div', 'latex-gutter'); gutter.id = 'latex-gutter'; gutter.setAttribute('aria-hidden', 'true');
    const editor = make('textarea'); editor.id = 'latex-editor'; editor.spellcheck = false; editor.autocomplete = 'off'; editor.setAttribute('aria-label', 'LaTeX 源文件内容');
    editorWrap.append(gutter, editor);
    left.append(fileList, editorWrap);

    const right = make('section', 'latex-preview-pane'); right.setAttribute('aria-label', 'PDF 预览');
    const previewHead = make('div', 'latex-preview-head');
    const pagePrev = make('button', 'icon-button', '‹'); pagePrev.id = 'latex-page-prev'; pagePrev.type = 'button'; pagePrev.setAttribute('aria-label', '上一页');
    const pageNext = make('button', 'icon-button', '›'); pageNext.id = 'latex-page-next'; pageNext.type = 'button'; pageNext.setAttribute('aria-label', '下一页');
    const pageLabel = make('span', 'latex-page-label'); pageLabel.id = 'latex-page-label'; pageLabel.textContent = '—';
    const buildInfo = make('span', 'latex-build-info'); buildInfo.id = 'latex-build-info';
    previewHead.append(pagePrev, pageLabel, pageNext, buildInfo);
    const preview = make('div', 'latex-preview'); preview.id = 'latex-preview';
    const errors = make('ul', 'latex-errors'); errors.id = 'latex-errors';
    right.append(previewHead, preview, errors);
    body.append(left, right);

    const diff = make('pre', 'latex-diff'); diff.id = 'latex-diff'; diff.hidden = true;
    const status = make('p', 'latex-status'); status.id = 'latex-status'; status.setAttribute('role', 'status');
    const conflictBar = make('div', 'latex-conflict'); conflictBar.id = 'latex-conflict'; conflictBar.hidden = true;
    const conflictText = make('span', '', ''); conflictText.id = 'latex-conflict-text';
    const reload = make('button', 'button subtle', '载入最新'); reload.id = 'latex-conflict-reload'; reload.type = 'button';
    const overwrite = make('button', 'button subtle', '用我的版本覆盖'); overwrite.id = 'latex-conflict-overwrite'; overwrite.type = 'button';
    conflictBar.append(conflictText, reload, overwrite);
    const footer = make('footer', 'latex-footer');
    footer.append(conflictBar, status);
    dialog.append(header, toolbar, newForm, body, diff, footer);
    document.body.append(dialog);

    function say(text, error = false) { status.textContent = text; status.classList.toggle('error', error); }
    function setSaveState(text, kind = '') { saveState.textContent = text; saveState.dataset.state = kind; }
    function lineNumbers() {
      const lines = editor.value.split('\n').length;
      const buffer = [];
      for (let index = 1; index <= lines; index += 1) buffer.push(String(index));
      gutter.textContent = buffer.join('\n');
      gutter.scrollTop = editor.scrollTop;
    }
    function syncScroll() { gutter.scrollTop = editor.scrollTop; }
    editor.addEventListener('scroll', syncScroll);
    editor.addEventListener('input', () => {
      dirty = true; pendingConflict = null; conflictBar.hidden = true; lineNumbers(); setSaveState('未保存', 'dirty'); scheduleSave();
    });

    function scheduleSave() {
      clearTimeout(timer);
      timer = setTimeout(() => { void flush('auto'); }, AUTOSAVE_MS);
    }

    /** Serialize saves so two keystrokes can never race the same revision. */
    function flush(reason = 'manual') {
      if (!file || !dirty || disposed) return Promise.resolve();
      const body = editor.value;
      const ticket = generation;
      clearTimeout(timer);
      saveQueue = saveQueue.then(async () => {
        if (disposed || !file) return;
        // The revision is read inside the queue: an earlier save in this queue has
        // already advanced it, so the next write is checked against what it wrote.
        const expected = revision;
        saving = true; setSaveState(reason === 'manual' ? '保存中…' : '自动保存…', 'saving');
        try {
          const result = await api('latex_write', { id: project.id, path: file, content: body, expected_revision: expected, origin: 'reader' });
          if (ticket !== generation) return;
          revision = result.revision;
          dirty = editor.value !== body;
          setSaveState(result.changed ? '已保存' : '没有改动', 'saved');
          if (reason === 'manual') say(`已保存 ${file}（${result.bytes} 字节）`);
        } catch (error) {
          if (error.code === 'STATE_CONFLICT' && error.current) {
            pendingConflict = { path: file, content: editor.value, current: error.current };
            conflictText.textContent = '这个文件在别处被改过：你的编辑没有写入。';
            conflictBar.hidden = false;
            setSaveState('冲突未保存', 'conflict');
            say('保存冲突：请选择载入最新版本，或用你的版本覆盖。', true);
            return;
          }
          setSaveState('保存失败', 'error');
          say(`保存失败：${error.message}`, true);
        } finally {
          saving = false;
        }
      }).catch(error => { say(String(error.message || error), true); });
      return saveQueue;
    }

    reload.addEventListener('click', () => {
      if (!pendingConflict) return;
      editor.value = pendingConflict.current.content || '';
      revision = pendingConflict.current.revision;
      dirty = false; pendingConflict = null; conflictBar.hidden = true; lineNumbers(); setSaveState('已载入最新', 'saved');
      say('已载入磁盘上的最新内容；你的未保存改动已丢弃。');
    });
    overwrite.addEventListener('click', async () => {
      if (!pendingConflict) return;
      const body = editor.value;
      try {
        const result = await api('latex_write', { id: project.id, path: pendingConflict.path, content: body, expected_revision: pendingConflict.current.revision, origin: 'reader' });
        revision = result.revision; dirty = false; pendingConflict = null; conflictBar.hidden = true; setSaveState('已覆盖保存', 'saved');
        say('已用你的版本覆盖，并保留了一份写入前历史。');
      } catch (error) {
        say(`覆盖失败：${error.message}`, true);
      }
    });

    async function refreshProjects(preferred) {
      const result = await api('latex_project_list', { limit: 200, include_archived: false });
      projects = result.projects || [];
      projectSelect.textContent = '';
      if (!projects.length) {
        const option = make('option', '', '还没有 LaTeX 项目'); option.value = ''; projectSelect.append(option);
      }
      for (const item of projects) {
        const option = make('option', '', item.main_path ? `${item.title} · ${item.main_path}` : item.title);
        option.value = item.id; projectSelect.append(option);
      }
      compareSelect.textContent = '';
      const none = make('option', '', '选择另一个项目…'); none.value = ''; compareSelect.append(none);
      for (const item of projects) { const option = make('option', '', item.title); option.value = item.id; compareSelect.append(option); }
      const wanted = preferred && projects.some(item => item.id === preferred) ? preferred : project?.id;
      if (wanted && projects.some(item => item.id === wanted)) projectSelect.value = wanted;
      return projects;
    }

    async function selectProject(id) {
      if (!id) { project = null; await renderEmpty(); return; }
      if (dirty) await flush('manual');
      generation += 1;
      rendered.clear();
      project = projects.find(item => item.id === id) || null;
      if (!project) { await renderEmpty(); return; }
      await loadTree();
      const main = project.main_path || (tree?.files || []).find(item => item.kind === 'text')?.path;
      if (main) await openFile(main);
      else { file = null; revision = null; editor.value = ''; lineNumbers(); say('这个项目里还没有可编辑的文本源文件。'); }
      page = 1;
      if (project.pdf_present) await loadLayout(); else setPreviewMessage('还没有 PDF；点「编译」生成。');
    }

    async function renderEmpty() {
      file = null; revision = null; editor.value = ''; lineNumbers(); tree = null;
      fileList.textContent = ''; errors.textContent = ''; setPreviewMessage('先从上方选择或登记一个 LaTeX 项目文件夹。');
      mainLabel.textContent = ''; setSaveState(''); buildInfo.textContent = '';
      compareSelect.disabled = true;
    }

    function setPreviewMessage(text) {
      preview.textContent = '';
      const note = make('p', 'latex-preview-empty', text);
      preview.append(note); pageCount = 0; pageLabel.textContent = '—';
    }

    async function loadTree() {
      tree = await api('latex_tree', { id: project.id });
      fileList.textContent = '';
      let count = 0;
      for (const item of tree.files || []) {
        if (item.kind !== 'text') continue;
        const entry = make('li', 'latex-file');
        const button = make('button', 'latex-file-open', `${item.main ? '★ ' : ''}${item.path}`); button.type = 'button'; button.dataset.path = item.path;
        button.title = `${item.bytes} 字节 · ${item.modified}`;
        button.addEventListener('click', () => void openFile(item.path));
        entry.append(button); fileList.append(entry); count += 1;
      }
      if (!count) fileList.append(make('li', 'latex-file', '（没有 .tex/.bib 文本文件）'));
      mainLabel.textContent = project.main_path ? `主文件 ${project.main_path}` : '未设置主文件';
      compareSelect.disabled = false;
    }

    async function openFile(path, options = {}) {
      if (path === file && !options.force) return;
      if (dirty && file && file !== path) await flush('manual');
      const read = await api('latex_read', { id: project.id, path });
      file = read.path; revision = read.revision; dirty = false;
      editor.value = read.content; lineNumbers(); editor.scrollTop = 0; gutter.scrollTop = 0;
      pendingConflict = null; conflictBar.hidden = true;
      setSaveState('已载入', 'saved');
      for (const button of fileList.querySelectorAll('button')) button.classList.toggle('active', button.dataset.path === file);
      say(`${file} · ${read.bytes} 字节 · ${read.lines} 行 · 修订 ${read.revision.slice(0, 8)}`);
    }

    async function loadLayout() {
      try {
        const layout = await api('latex_pdf_pages', { id: project.id });
        pageCount = layout.page_count; page = Math.min(Math.max(1, page), Math.max(1, pageCount));
        await renderPage(page);
      } catch (error) {
        setPreviewMessage(`无法预览：${error.message}`);
      }
    }

    async function renderPage(number) {
      if (!project || !pageCount) return;
      page = Math.min(Math.max(1, number), pageCount);
      pageLabel.textContent = `第 ${page} / ${pageCount} 页`;
      pagePrev.disabled = page <= 1; pageNext.disabled = page >= pageCount;
      const key = `${project.id}:${page}`;
      let image = rendered.get(key);
      if (!image) {
        const result = await api('latex_pdf_page', { id: project.id, page, scale: 1.4 });
        image = `data:image/png;base64,${result.image}`;
        rendered.set(key, image);
        if (rendered.size > MAX_RENDERED_PAGES) rendered.delete(rendered.keys().next().value);
      }
      preview.textContent = '';
      const img = document.createElement('img'); img.className = 'latex-page'; img.alt = `第 ${page} 页`; img.src = image;
      preview.append(img);
    }

    pagePrev.addEventListener('click', () => void renderPage(page - 1));
    pageNext.addEventListener('click', () => void renderPage(page + 1));

    compile.addEventListener('click', async () => {
      if (!project || compiling) return;
      if (dirty) await flush('manual');
      compiling = true; compile.disabled = true; compile.textContent = '编译中…';
      errors.textContent = ''; buildInfo.textContent = '';
      say(`正在用 latexmk 编译 ${project.main_path || '主文件'}…`);
      try {
        const result = await api('latex_compile', { id: project.id, engine: 'xelatex', timeout_seconds: 120 });
        buildInfo.textContent = `${result.engine} · ${(result.duration_ms / 1000).toFixed(1)}s · ${result.pages ?? '—'} 页`;
        for (const line of result.errors || []) errors.append(make('li', '', line));
        if (result.ok) {
          rendered.clear();
          say(`编译完成：${result.pdf_path}（${result.pages} 页，${result.duration_ms} 毫秒）`);
          await loadLayout();
        } else {
          say(result.timed_out ? '编译超时，已停止。' : `编译失败（退出码 ${result.exit_code}）。请看下方错误与日志。`, true);
          if (result.log_tail) {
            const details = make('details', 'latex-log');
            details.append(make('summary', '', '查看 latexmk 输出尾部'), make('pre', '', result.log_tail));
            errors.append(details);
          }
        }
      } catch (error) {
        say(`编译未完成：${error.message}`, true);
      } finally {
        compiling = false; compile.disabled = false; compile.textContent = '编译';
      }
    });

    diffOpen.addEventListener('click', async () => {
      if (!project) return;
      if (dirty) await flush('manual');
      try {
        const result = await api('latex_diff', { id: project.id, path: file || project.main_path, from_revision: 'previous', to_revision: 'current' });
        diff.hidden = false;
        diff.textContent = result.changed ? result.diff : '与上一版没有差异。';
        say(result.changed ? `与上一版对比：+${result.added} / -${result.removed}${result.truncated ? '（已截断）' : ''}` : '与上一版没有差异。');
      } catch (error) {
        say(`无法对比：${error.message}`, true);
      }
    });

    compareRun.addEventListener('click', async () => {
      const other = compareSelect.value;
      if (!project || !other) { say('请选择另一个项目再对照。', true); return; }
      try {
        const result = await api('latex_compare', { a: project.id, b: other, path: file || undefined });
        diff.hidden = false;
        diff.textContent = result.changed ? result.diff : '两个项目在这一文件上没有差异。';
        say(result.changed ? `项目对照：+${result.added} / -${result.removed}` : '两个项目在这一文件上没有差异。');
      } catch (error) {
        say(`无法对照：${error.message}`, true);
      }
    });

    projectSelect.addEventListener('change', () => void selectProject(projectSelect.value));
    newToggle.addEventListener('click', () => { newForm.hidden = !newForm.hidden; if (!newForm.hidden) newRoot.focus(); });
    newCancel.addEventListener('click', () => { newForm.hidden = true; });
    newForm.addEventListener('submit', async event => {
      event.preventDefault();
      const root = newRoot.value.trim();
      if (!root) { say('请填写项目文件夹的绝对路径。', true); return; }
      try {
        const created = await api('latex_project_create', { root, ...(newTitle.value.trim() ? { title: newTitle.value.trim() } : {}), create_missing: newStarter.checked });
        newForm.hidden = true; newRoot.value = ''; newTitle.value = ''; newStarter.checked = false;
        project = created.project;
        await refreshProjects(created.project.id);
        await selectProject(created.project.id);
        say(`已登记 ${created.project.root}`);
      } catch (error) {
        say(`登记失败：${error.message}`, true);
      }
    });

    dialog.addEventListener('keydown', event => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') { event.preventDefault(); void flush('manual'); }
    });
    dialog.addEventListener('close', () => { clearTimeout(timer); if (dirty) void flush('manual'); });

    async function open(preferred) {
      if (!dialog.open) dialog.showModal();
      try {
        await refreshProjects(preferred);
        const wanted = project?.id && projects.some(item => item.id === project.id) ? project.id : projects[0]?.id;
        if (wanted) await selectProject(wanted);
        else await renderEmpty();
      } catch (error) {
        say(`无法读取项目列表：${error.message}`, true);
      }
    }

    async function close() { if (dirty) await flush('manual'); dialog.close(); }

    trigger.addEventListener('click', () => void open());
    lineNumbers();
    void renderEmpty();

    return {
      open, close,
      isOpen: () => dialog.open,
      refresh: () => open(project?.id),
      /** Used by the acceptance fixture to drive the editor without a real keyboard. */
      testHooks: {
        setProject: id => selectProject(id),
        type: text => { editor.value = text; dirty = true; lineNumbers(); setSaveState('未保存', 'dirty'); return flush('manual'); },
        flush: () => flush('manual'),
        openFile,
        state: () => ({ project: project?.id || null, file, revision, dirty, pageCount, page, conflict: Boolean(pendingConflict) }),
      },
      dispose() { disposed = true; clearTimeout(timer); dialog.remove(); trigger.remove(); },
    };
  }
  return { create };
})();
