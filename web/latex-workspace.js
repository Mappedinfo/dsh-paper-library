'use strict';
/**
 * LaTeX workspace: edit a project folder's sources with the PDF beside them.
 *
 * The folder stays authoritative. This panel reads and writes through the same
 * revision-checked actions the agent uses, so a stale save is refused with the
 * current text and offered as a choice instead of silently overwriting a change
 * made in another editor. Compiling runs the reader's own latexmk in that folder
 * and shows the real exit code, errors and log tail.
 *
 * Layout follows the Overleaf habit: source left, PDF right, one draggable divider,
 * and everything else (project actions, settings, DSH collaboration, versions) behind
 * the ☰ menu or the right pane's tabs.
 */
window.PaperLatexWorkspace = (() => {
  const AUTOSAVE_MS = 900;
  const AUTOCOMPILE_MS = 2500;
  const MAX_RENDERED_PAGES = 6;
  const SPLIT_MIN = 25, SPLIT_MAX = 75;
  const DEFAULT_SETTINGS = { latex_starter: true, latex_auto_compile: true, latex_split: 50, latex_sync_folder: true };

  function create({api, toast = () => {}, getLibrary = () => '', rail = null}) {
    const make = (tag, cls, text) => { const node = document.createElement(tag); if (cls) node.className = cls; if (text !== undefined) node.textContent = text; return node; };
    let projects = [], project = null, tree = null, file = null, revision = null, pageCount = 0, page = 1, tab = 'pdf';
    let dirty = false, saving = false, compiling = false, disposed = false, timer = null, compileTimer = null, generation = 0, saveQueue = Promise.resolve();
    let lastBuildOk = null, autoPaused = false, pendingCompile = false;
    const rendered = new Map();
    let pendingConflict = null;
    let settings = { ...DEFAULT_SETTINGS };
    let settingsRevision = null;
    let workspace = { root: null, sync: null };

    // A standalone surface, like the whiteboard: the page itself becomes the workspace and
    // `?view=latex` opens it without the library, so a DSH tab can host it directly.
    const trigger = document.getElementById('latex-open') || (() => {
      const button = make('button', 'button subtle', 'LaTeX'); button.id = 'latex-open'; button.type = 'button';
      button.title = '打开 LaTeX 工作台：编辑项目文件夹里的 .tex 并查看它编译出的 PDF';
      (document.querySelector('.topbar-actions') || document.body).append(button);
      return button;
    })();
    const view = document.getElementById('latex-view') || (() => {
      const section = make('section', 'latex-view'); section.id = 'latex-view'; section.hidden = true;
      section.setAttribute('aria-label', 'LaTeX 工作台');
      (document.querySelector('.workspace') || document.body).append(section);
      return section;
    })();
    view.hidden = true;
    view.textContent = '';

    const header = make('header', 'latex-header');
    const title = make('strong', '', 'LaTeX 工作台'); title.id = 'latex-workspace-title';
    const subtitle = make('small', '', '项目就是一个装着 .tex 和对应 PDF 的文件夹');
    const titleBox = make('div', 'latex-title'); titleBox.append(title, subtitle);
    const back = make('button', 'button subtle', '返回文献库'); back.id = 'latex-back'; back.type = 'button';
    back.title = '关闭工作台，回到文献库列表';
    header.append(titleBox, back);

    // ---- toolbar: project, compile, and one menu for everything project-shaped ----
    const toolbar = make('div', 'latex-toolbar');
    const projectSelect = make('select'); projectSelect.id = 'latex-project'; projectSelect.setAttribute('aria-label', '选择 LaTeX 项目');
    const compile = make('button', 'button primary', '编译'); compile.id = 'latex-compile'; compile.type = 'button';
    const autoLabel = make('span', 'latex-auto'); autoLabel.id = 'latex-auto-state';
    const mainLabel = make('span', 'latex-main'); mainLabel.id = 'latex-main';
    const saveState = make('span', 'latex-save-state'); saveState.id = 'latex-save-state'; saveState.setAttribute('role', 'status');
    const aiToggle = make('button', 'button subtle', 'DSH 写作'); aiToggle.id = 'latex-ai-open'; aiToggle.type = 'button';
    aiToggle.title = '在侧栏里提问或让模型改稿';
    aiToggle.hidden = !rail;
    const menuButton = make('button', 'button subtle latex-menu-button', '☰'); menuButton.id = 'latex-menu-open'; menuButton.type = 'button';
    menuButton.setAttribute('aria-expanded', 'false'); menuButton.setAttribute('aria-controls', 'latex-menu'); menuButton.setAttribute('aria-label', '项目与设置'); menuButton.title = '项目与设置';
    toolbar.append(projectSelect, mainLabel, saveState, autoLabel, compile, aiToggle, menuButton);

    const menu = make('div', 'latex-menu'); menu.id = 'latex-menu'; menu.setAttribute('aria-label', '项目与设置'); menu.hidden = true;
    const createRow = make('div', 'latex-menu-section');
    createRow.append(make('span', 'latex-menu-label', '新建项目（放在插件的论文目录里）'));
    const createName = make('input'); createName.id = 'latex-create-name'; createName.type = 'text'; createName.placeholder = '项目名称，例如 邻域效应-论文'; createName.autocomplete = 'off';
    const createStarter = make('input'); createStarter.id = 'latex-create-starter'; createStarter.type = 'checkbox';
    const createStarterLabel = make('label', 'latex-check'); createStarterLabel.append(createStarter, make('span', '', '写入最小 main.tex'));
    const createRun = make('button', 'button primary', '新建'); createRun.id = 'latex-create-run'; createRun.type = 'button';
    const createLine = make('div', 'latex-menu-row'); createLine.append(createName, createStarterLabel, createRun);
    createRow.append(createLine);

    const registerRow = make('div', 'latex-menu-section');
    registerRow.append(make('span', 'latex-menu-label', '登记已有文件夹（绝对路径，文件留在原处）'));
    const newRoot = make('input'); newRoot.id = 'latex-new-root'; newRoot.type = 'text'; newRoot.placeholder = '/绝对/路径/到/你的/论文文件夹'; newRoot.autocomplete = 'off'; newRoot.spellcheck = false;
    const newTitle = make('input'); newTitle.id = 'latex-new-title'; newTitle.type = 'text'; newTitle.placeholder = '标题（可留空）'; newTitle.autocomplete = 'off';
    const newStarter = make('input'); newStarter.id = 'latex-new-starter'; newStarter.type = 'checkbox';
    const starterLabel = make('label', 'latex-check'); starterLabel.append(newStarter, make('span', '', '没有 .tex 时写入最小 main.tex'));
    const newSubmit = make('button', 'button primary', '登记'); newSubmit.id = 'latex-new-submit'; newSubmit.type = 'button';
    const registerLine = make('div', 'latex-menu-row'); registerLine.append(newRoot, newTitle, starterLabel, newSubmit);
    registerRow.append(registerLine);

    const compareRow = make('div', 'latex-menu-section');
    compareRow.append(make('span', 'latex-menu-label', '与其他项目对比同一相对路径'));
    const compareSelect = make('select'); compareSelect.id = 'latex-compare'; compareSelect.setAttribute('aria-label', '与其他项目对比'); compareSelect.disabled = true;
    const compareRun = make('button', 'button subtle', '对比'); compareRun.id = 'latex-compare-run'; compareRun.type = 'button';
    const compareLine = make('div', 'latex-menu-row'); compareLine.append(compareSelect, compareRun);
    compareRow.append(compareLine);

    const settingRow = make('div', 'latex-menu-section');
    settingRow.append(make('span', 'latex-menu-label', '写作设置'));
    const settingStarter = make('input'); settingStarter.id = 'latex-setting-starter'; settingStarter.type = 'checkbox';
    const settingStarterLabel = make('label', 'latex-check'); settingStarterLabel.append(settingStarter, make('span', '', '没有 .tex 时写入最小 main.tex'));
    const settingAuto = make('input'); settingAuto.id = 'latex-setting-auto'; settingAuto.type = 'checkbox';
    const settingAutoLabel = make('label', 'latex-check'); settingAutoLabel.append(settingAuto, make('span', '', '自动编译（停止输入后约 2.5 秒）'));
    const settingsLine = make('div', 'latex-menu-row'); settingsLine.append(settingStarterLabel, settingAutoLabel);
    settingRow.append(settingsLine);

    const rootRow = make('div', 'latex-menu-section');
    rootRow.append(make('span', 'latex-menu-label', '论文目录'));
    const rootPath = make('code', 'latex-root'); rootPath.id = 'latex-root'; rootPath.textContent = '读取中…';
    const syncState = make('span', 'latex-sync-state'); syncState.id = 'latex-sync-state';
    const syncAttach = make('button', 'button subtle', '纳入同步'); syncAttach.id = 'latex-sync-attach'; syncAttach.type = 'button';
    const rootLine = make('div', 'latex-menu-row'); rootLine.append(rootPath, syncState, syncAttach);
    rootRow.append(rootLine, make('p', 'latex-menu-hint', '论文目录由插件维护；数据同步服务会把它作为一个独立源备份（只新增，不删改其他源）。'));
    menu.append(createRow, registerRow, compareRow, settingRow, rootRow);

    // ---- body: source | divider | (pdf | dsh | versions) ----
    const body = make('div', 'latex-body');
    const left = make('section', 'latex-editor-pane'); left.setAttribute('aria-label', '源文件');
    const fileList = make('ul', 'latex-files'); fileList.id = 'latex-files';
    const editorWrap = make('div', 'latex-editor-wrap');
    const gutter = make('div', 'latex-gutter'); gutter.id = 'latex-gutter'; gutter.setAttribute('aria-hidden', 'true');
    const editor = make('textarea'); editor.id = 'latex-editor'; editor.spellcheck = false; editor.autocomplete = 'off'; editor.setAttribute('aria-label', 'LaTeX 源文件内容');
    editorWrap.append(gutter, editor);
    left.append(fileList, editorWrap);

    const splitter = make('div', 'latex-splitter'); splitter.id = 'latex-splitter'; splitter.setAttribute('role', 'separator');
    splitter.setAttribute('aria-orientation', 'vertical'); splitter.setAttribute('aria-label', '调整源码与预览宽度'); splitter.tabIndex = 0;

    const right = make('section', 'latex-preview-pane'); right.setAttribute('aria-label', '预览与协作');
    const tabs = make('div', 'latex-tabs'); tabs.setAttribute('role', 'tablist');
    const tabSpecs = rail ? [['pdf', 'PDF'], ['version', '版本']] : [['pdf', 'PDF'], ['ai', 'DSH 协作'], ['version', '版本']];
    const tabButtons = new Map();
    for (const [name, label] of tabSpecs) {
      const button = make('button', 'latex-tab', label); button.id = `latex-tab-${name}`; button.type = 'button';
      button.setAttribute('role', 'tab'); button.setAttribute('aria-controls', `latex-pane-${name}`);
      button.addEventListener('click', () => setTab(name));
      tabButtons.set(name, button); tabs.append(button);
    }
    const buildInfo = make('span', 'latex-build-info'); buildInfo.id = 'latex-build-info';
    tabs.append(buildInfo);

    const panePdf = make('div', 'latex-pane'); panePdf.id = 'latex-pane-pdf'; panePdf.setAttribute('role', 'tabpanel');
    const previewHead = make('div', 'latex-preview-head');
    const pagePrev = make('button', 'icon-button', '‹'); pagePrev.id = 'latex-page-prev'; pagePrev.type = 'button'; pagePrev.setAttribute('aria-label', '上一页');
    const pageNext = make('button', 'icon-button', '›'); pageNext.id = 'latex-page-next'; pageNext.type = 'button'; pageNext.setAttribute('aria-label', '下一页');
    const pageLabel = make('span', 'latex-page-label'); pageLabel.id = 'latex-page-label'; pageLabel.textContent = '—';
    previewHead.append(pagePrev, pageLabel, pageNext);
    const preview = make('div', 'latex-preview'); preview.id = 'latex-preview';
    const errors = make('ul', 'latex-errors'); errors.id = 'latex-errors';
    panePdf.append(previewHead, preview, errors);

    const paneAi = make('div', 'latex-pane'); paneAi.id = 'latex-pane-ai'; paneAi.setAttribute('role', 'tabpanel'); paneAi.hidden = Boolean(rail);
    const aiSection = make('section', 'latex-ai'); aiSection.id = 'latex-ai';
    const aiHead = make('div', 'latex-ai-head');
    const aiModel = make('select'); aiModel.id = 'latex-ai-model'; aiModel.setAttribute('aria-label', 'DSH 模型');
    const aiAsk = make('button', 'button subtle', '问 DSH'); aiAsk.id = 'latex-ai-ask'; aiAsk.type = 'button';
    const aiPropose = make('button', 'button subtle', '生成修改提案'); aiPropose.id = 'latex-ai-propose'; aiPropose.type = 'button';
    const aiStatusLine = make('span', 'latex-ai-route'); aiStatusLine.id = 'latex-ai-route';
    aiHead.append(aiModel, aiAsk, aiPropose, aiStatusLine);
    const aiInput = make('textarea'); aiInput.id = 'latex-ai-input'; aiInput.rows = 3; aiInput.spellcheck = false;
    aiInput.placeholder = '问一个问题，或说明想怎么改；先在编辑器里选中一段就只处理这一段。';
    aiInput.setAttribute('aria-label', '给 DSH 的问题或写作要求');
    const aiAnswer = make('div', 'latex-ai-answer'); aiAnswer.id = 'latex-ai-answer';
    const aiProposal = make('div', 'latex-ai-proposal'); aiProposal.id = 'latex-ai-proposal';
    const aiAccept = make('button', 'button primary', '接受并写入'); aiAccept.id = 'latex-ai-accept'; aiAccept.type = 'button';
    const aiDiscard = make('button', 'button subtle', '放弃'); aiDiscard.id = 'latex-ai-discard'; aiDiscard.type = 'button';
    const aiActions = make('div', 'latex-ai-actions'); aiActions.append(aiAccept, aiDiscard);
    aiSection.append(aiHead, aiInput, aiAnswer, aiProposal, aiActions);
    paneAi.append(aiSection);

    const paneVersion = make('div', 'latex-pane'); paneVersion.id = 'latex-pane-version'; paneVersion.setAttribute('role', 'tabpanel');
    const versionHead = make('div', 'latex-preview-head');
    const diffOpen = make('button', 'button subtle', '与上一版对比'); diffOpen.id = 'latex-diff-open'; diffOpen.type = 'button';
    const diffHint = make('span', 'latex-page-label', '当前文件与它上一个落库版本');
    versionHead.append(diffOpen, diffHint);
    const diff = make('pre', 'latex-diff'); diff.id = 'latex-diff';
    diff.textContent = '点「与上一版对比」查看这个文件的改动；菜单里的「与其他项目对比」结果显示在这里。';
    paneVersion.append(versionHead, diff);

    right.append(tabs, panePdf, paneAi, paneVersion);
    body.append(left, splitter, right);

    const status = make('p', 'latex-status'); status.id = 'latex-status'; status.setAttribute('role', 'status');
    const conflictBar = make('div', 'latex-conflict'); conflictBar.id = 'latex-conflict'; conflictBar.hidden = true;
    const conflictText = make('span', '', ''); conflictText.id = 'latex-conflict-text';
    const reload = make('button', 'button subtle', '载入最新'); reload.id = 'latex-conflict-reload'; reload.type = 'button';
    const overwrite = make('button', 'button subtle', '用我的版本覆盖'); overwrite.id = 'latex-conflict-overwrite'; overwrite.type = 'button';
    conflictBar.append(conflictText, reload, overwrite);
    const footer = make('footer', 'latex-footer');
    footer.append(conflictBar, status);
    view.append(header, toolbar, menu, body, footer);

    function say(text, error = false) { status.textContent = text; status.classList.toggle('error', error); }
    function setSaveState(text, kind = '') { saveState.textContent = text; saveState.dataset.state = kind; }
    function setTab(name) {
      tab = name;
      for (const [candidate, button] of tabButtons) {
        const active = candidate === name;
        button.classList.toggle('active', active);
        button.setAttribute('aria-selected', String(active));
      }
      for (const [candidate, pane] of [['pdf', panePdf], ['ai', paneAi], ['version', paneVersion]]) pane.hidden = candidate !== name;
      if (name === 'ai' && project) void aiStatus();
    }
    function lineNumbers() {
      const lines = editor.value.split('\n').length;
      const buffer = [];
      for (let index = 1; index <= lines; index += 1) buffer.push(String(index));
      gutter.textContent = buffer.join('\n');
      gutter.scrollTop = editor.scrollTop;
    }
    editor.addEventListener('scroll', () => { gutter.scrollTop = editor.scrollTop; });
    editor.addEventListener('input', () => {
      dirty = true; pendingConflict = null; conflictBar.hidden = true; lineNumbers(); setSaveState('未保存', 'dirty'); scheduleSave();
    });

    // ---- settings, root and sync -------------------------------------------------
    function applySettings(value, revision) {
      if (value && typeof value === 'object') settings = { ...DEFAULT_SETTINGS, ...value };
      if (revision !== undefined) settingsRevision = revision;
      settingStarter.checked = settings.latex_starter !== false;
      settingAuto.checked = settings.latex_auto_compile !== false;
      createStarter.checked = settings.latex_starter !== false;
      newStarter.checked = settings.latex_starter !== false;
      autoLabel.textContent = settings.latex_auto_compile === false ? '自动编译已关' : (autoPaused ? '自动编译已暂停' : '自动编译');
      setSplit(Number.isSafeInteger(settings.latex_split) ? settings.latex_split : 50, { persist: false });
    }
    async function loadSettings() {
      try { const snapshot = await api('settings_get'); applySettings(snapshot.value, snapshot.revision); }
      catch { applySettings(DEFAULT_SETTINGS, null); }
    }
    async function saveSetting(patch) {
      applySettings(patch);
      if (settingsRevision === null) { say('本次运行无法保存设置（未连接 DSH 设置服务）。', true); return; }
      try {
        const snapshot = await api('settings_update', { patch, expected_revision: settingsRevision });
        applySettings(snapshot.value, snapshot.revision);
        say('设置已保存');
      } catch (error) {
        say(`设置未保存：${error.message}`, true);
        await loadSettings();
      }
    }

    function setSplit(percent, { persist = false } = {}) {
      const clamped = Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, Math.round(percent)));
      body.style.setProperty('--latex-split', `${clamped}%`);
      splitter.setAttribute('aria-valuenow', String(clamped));
      settings.latex_split = clamped;
      if (persist) void saveSetting({ latex_split: clamped });
      return clamped;
    }
    let dragging = false;
    function splitFromEvent(event) {
      const rect = body.getBoundingClientRect();
      if (!rect.width) return settings.latex_split;
      return ((event.clientX - rect.left) / rect.width) * 100;
    }
    splitter.addEventListener('pointerdown', event => {
      dragging = true; splitter.setPointerCapture(event.pointerId); splitter.classList.add('dragging'); event.preventDefault();
    });
    splitter.addEventListener('pointermove', event => { if (dragging) setSplit(splitFromEvent(event)); });
    splitter.addEventListener('pointerup', event => {
      if (!dragging) return;
      dragging = false; splitter.classList.remove('dragging');
      try { splitter.releasePointerCapture(event.pointerId); } catch { /* the capture may already be gone */ }
      void saveSetting({ latex_split: settings.latex_split });
    });
    splitter.addEventListener('keydown', event => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault();
      void saveSetting({ latex_split: setSplit(settings.latex_split + (event.key === 'ArrowRight' ? 2 : -2)) });
    });

    async function refreshWorkspace() {
      try {
        const state = await api('latex_ws_status');
        workspace = state;
        rootPath.textContent = state.root;
        if (state.sync?.covered) { syncState.textContent = `已纳入同步（${state.sync.covering_source || '已有源'}）`; syncAttach.hidden = true; }
        else if (state.sync?.coverable) { syncState.textContent = '尚未纳入同步'; syncAttach.hidden = false; }
        else { syncState.textContent = state.sync?.reason || '数据同步服务不可用'; syncAttach.hidden = true; }
        return state;
      } catch (error) {
        workspace = { root: null, sync: null };
        rootPath.textContent = '不可用';
        syncState.textContent = error.message;
        syncAttach.hidden = true;
        return null;
      }
    }
    syncAttach.addEventListener('click', async () => {
      syncAttach.disabled = true;
      try {
        const result = await api('latex_ws_sync_attach');
        say(result.changed ? `已把论文目录加入数据同步服务（配置已备份：${result.backup}）` : '这个目录已经在同步范围内，未改动配置');
        await refreshWorkspace();
      } catch (error) {
        say(`未加入同步：${error.message}`, true);
      } finally { syncAttach.disabled = false; }
    });

    function closeMenu() { menu.hidden = true; menuButton.setAttribute('aria-expanded', 'false'); }
    menuButton.addEventListener('click', event => {
      event.stopPropagation();
      menu.hidden = !menu.hidden;
      menuButton.setAttribute('aria-expanded', String(!menu.hidden));
      if (!menu.hidden) void refreshWorkspace();
    });
    menu.addEventListener('click', event => event.stopPropagation());
    view.addEventListener('click', () => closeMenu());
    view.addEventListener('keydown', event => { if (event.key === 'Escape' && !menu.hidden) closeMenu(); });

    // ---- saving ------------------------------------------------------------------
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
          if (result.changed) scheduleCompile();
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
        scheduleCompile();
      } catch (error) {
        say(`覆盖失败：${error.message}`, true);
      }
    });

    // ---- projects -----------------------------------------------------------------
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
      compareSelect.disabled = projects.length < 2;
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
      // An existing PDF means idle recompiling can start safely; a folder that has never
      // built needs one manual compile first, so a broken document cannot loop.
      lastBuildOk = project.pdf_present ? true : null;
      autoPaused = false;
      ai.checked = false; aiAnswer.textContent = ''; aiProposal.textContent = '';
      // Whichever surface hosts the collaboration, a project switch re-reads its state.
      if (tab === 'ai' || rail?.visible?.('latex-ai')) void aiStatus();
    }

    async function renderEmpty() {
      file = null; revision = null; editor.value = ''; lineNumbers(); tree = null;
      fileList.textContent = ''; errors.textContent = ''; setPreviewMessage('在 ☰ 菜单里新建一个项目，或登记已有文件夹。');
      mainLabel.textContent = ''; setSaveState(''); buildInfo.textContent = '';
      lastBuildOk = null; autoPaused = false;
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
      const key = `${project.id}:${page}:${buildInfo.dataset.build || ''}`;
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

    // ---- compiling ----------------------------------------------------------------
    function scheduleCompile() {
      clearTimeout(compileTimer);
      if (settings.latex_auto_compile === false || autoPaused || lastBuildOk !== true || !project) return;
      compileTimer = setTimeout(() => { void compileOnce('auto'); }, AUTOCOMPILE_MS);
    }

    async function compileOnce(reason = 'manual') {
      if (!project || compiling) { if (compiling) pendingCompile = true; return; }
      if (dirty) await flush('manual');
      compiling = true; compile.disabled = true; compile.textContent = '编译中…';
      errors.textContent = ''; buildInfo.textContent = reason === 'auto' ? '自动编译中…' : '';
      if (reason === 'manual') say(`正在用 latexmk 编译 ${project.main_path || '主文件'}…`);
      try {
        const result = await api('latex_compile', { id: project.id, engine: 'xelatex', timeout_seconds: 120 });
        buildInfo.dataset.build = String(Date.now());
        buildInfo.textContent = `${result.engine} · ${(result.duration_ms / 1000).toFixed(1)}s · ${result.pages ?? '—'} 页`;
        for (const line of result.errors || []) errors.append(make('li', '', line));
        lastBuildOk = result.ok;
        if (result.ok) {
          autoPaused = false;
          rendered.clear();
          say(`编译完成：${result.pdf_path}（${result.pages} 页，${result.duration_ms} 毫秒${reason === 'auto' ? '，自动' : ''}）`);
          await loadLayout();
        } else {
          autoPaused = reason === 'auto';
          say(result.timed_out ? '编译超时，已停止。' : `编译失败（退出码 ${result.exit_code}）。请看错误与日志尾。${autoPaused ? ' 自动编译已暂停，手动编译成功后会恢复。' : ''}`, true);
          if (result.log_tail) {
            const details = make('details', 'latex-log');
            details.append(make('summary', '', '查看 latexmk 输出尾部'), make('pre', '', result.log_tail));
            errors.append(details);
          }
        }
      } catch (error) {
        lastBuildOk = false;
        autoPaused = reason === 'auto';
        say(`编译未完成：${error.message}`, true);
      } finally {
        compiling = false; compile.disabled = false; compile.textContent = '编译';
        autoLabel.textContent = settings.latex_auto_compile === false ? '自动编译已关' : (autoPaused ? '自动编译已暂停' : '自动编译');
        if (pendingCompile) { pendingCompile = false; scheduleCompile(); }
      }
    }
    // A manual compile is also how the reader resumes from a failed automatic one.
    compile.addEventListener('click', () => { autoPaused = false; void compileOnce('manual'); });

    // ---- versions -----------------------------------------------------------------
    async function showDiff() {
      if (!project) return;
      if (dirty) await flush('manual');
      setTab('version');
      try {
        const result = await api('latex_diff', { id: project.id, path: file || project.main_path, from_revision: 'previous', to_revision: 'current' });
        diff.textContent = result.changed ? result.diff : '与上一版没有差异。';
        say(result.changed ? `与上一版对比：+${result.added} / -${result.removed}${result.truncated ? '（已截断）' : ''}` : '与上一版没有差异。');
      } catch (error) {
        diff.textContent = `无法对比：${error.message}`;
        say(`无法对比：${error.message}`, true);
      }
    }
    diffOpen.addEventListener('click', () => void showDiff());
    compareRun.addEventListener('click', async () => {
      const other = compareSelect.value;
      if (!project || !other) { say('请选择另一个项目再对比。', true); return; }
      closeMenu(); setTab('version');
      try {
        const result = await api('latex_compare', { a: project.id, b: other, path: file || undefined });
        diff.textContent = result.changed ? result.diff : '两个项目在这一文件上没有差异。';
        say(result.changed ? `与其他项目对比：+${result.added} / -${result.removed}` : '两个项目在这一文件上没有差异。');
      } catch (error) {
        diff.textContent = `无法对比：${error.message}`;
        say(`无法对比：${error.message}`, true);
      }
    });

    projectSelect.addEventListener('change', () => void selectProject(projectSelect.value));
    createRun.addEventListener('click', async () => {
      const name = createName.value.trim();
      if (!name) { say('请填写项目名称。', true); return; }
      createRun.disabled = true;
      try {
        const created = await api('latex_ws_create', { name, starter: createStarter.checked });
        createName.value = '';
        closeMenu();
        project = created.project;
        await refreshProjects(created.project.id);
        await selectProject(created.project.id);
        say(created.existing ? `这个项目已经在库里：${created.project.root}` : `已新建 ${created.dir}${created.sync?.changed ? '，并加入数据同步服务' : ''}`);
        if (created.sync && created.sync.changed === false && created.sync.reason) say(`项目已创建；未加入同步：${created.sync.reason}`, true);
      } catch (error) {
        say(`新建失败：${error.message}`, true);
      } finally { createRun.disabled = false; }
    });
    newSubmit.addEventListener('click', async () => {
      const root = newRoot.value.trim();
      if (!root) { say('请填写项目文件夹的绝对路径。', true); return; }
      try {
        const created = await api('latex_project_create', { root, ...(newTitle.value.trim() ? { title: newTitle.value.trim() } : {}), create_missing: newStarter.checked });
        newRoot.value = ''; newTitle.value = ''; closeMenu();
        project = created.project;
        await refreshProjects(created.project.id);
        await selectProject(created.project.id);
        say(`已登记 ${created.project.root}`);
      } catch (error) {
        say(`登记失败：${error.message}`, true);
      }
    });
    settingStarter.addEventListener('change', () => void saveSetting({ latex_starter: settingStarter.checked }));
    settingAuto.addEventListener('change', () => {
      autoPaused = false;
      void saveSetting({ latex_auto_compile: settingAuto.checked });
      if (settingAuto.checked) scheduleCompile();
    });

    // ---- DSH questions and co-writing ----------------------------------------------
    const ai = { available: false, busy: false, models: [], proposal: null, checked: false, lastRoute: null };

    function aiSelection() {
      const start = editor.selectionStart, end = editor.selectionEnd;
      if (typeof start !== 'number' || typeof end !== 'number' || end <= start) return undefined;
      const value = editor.value.slice(start, end);
      return value.trim() ? value : undefined;
    }
    function aiRoute() {
      const choice = ai.models[Number(aiModel.value)];
      if (!choice) return {};
      return { provider: choice.provider, model: choice.id, ...(choice.reasoningEffort ? { reasoningEffort: choice.reasoningEffort } : {}) };
    }
    function aiSay(text, error = false) { aiStatusLine.textContent = text; aiStatusLine.classList.toggle('error', error); }
    function aiBusy(on) {
      ai.busy = on;
      aiAsk.disabled = on; aiPropose.disabled = on; aiAccept.disabled = on; aiDiscard.disabled = on;
    }

    async function loadModels() {
      try {
        const result = await api('models');
        ai.models = (Array.isArray(result) ? result : result.models || []).filter(model => model && (model.id || model.model) && model.provider);
        aiModel.textContent = '';
        if (!ai.models.length) { const option = make('option', '', '没有可用模型'); option.value = ''; aiModel.append(option); return; }
        ai.models.forEach((model, index) => {
          const option = make('option', '', `${model.name || model.id} · ${model.provider}`);
          option.value = String(index); aiModel.append(option);
        });
        const preferred = ai.models.findIndex(model => `${model.provider}/${model.id}` === ai.lastRoute);
        aiModel.value = String(preferred >= 0 ? preferred : 0);
      } catch (error) {
        ai.models = [];
        aiSay(`无法读取模型列表：${error.message}`, true);
      }
    }

    async function aiStatus() {
      if (!project || ai.checked) return;
      try {
        const snapshot = await api('latex_ai_status', { id: project.id });
        ai.checked = true; ai.available = true;
        if (!ai.models.length) await loadModels();
        ai.proposal = snapshot.proposal || null;
        renderProposal();
        if (snapshot.proposal) aiSay('有一份待确认的提案');
        else if (snapshot.entries?.length) aiSay(`${snapshot.entries.length} 条协作记录`);
        else aiSay(snapshot.configured ? '模型来自插件配置' : '请选择模型');
      } catch (error) {
        ai.available = false;
        aiSay(error.code === 'LATEX_AI_INVALID' ? '当前主机未连接 DSH 模型服务' : error.message, true);
      }
    }

    function renderProposal() {
      const proposal = ai.proposal;
      aiProposal.textContent = '';
      aiAccept.hidden = !proposal; aiDiscard.hidden = !proposal;
      if (!proposal) return;
      aiProposal.append(make('p', 'latex-ai-summary', `${proposal.summary} · ${proposal.replacements.length} 处改动 · ${proposal.model.provider}/${proposal.model.model}`));
      const list = make('ul', 'latex-ai-replacements');
      for (const { find, replace } of proposal.replacements.slice(0, 20)) {
        const item = make('li');
        item.append(make('del', '', find), make('ins', '', replace));
        list.append(item);
      }
      aiProposal.append(list);
      if (proposal.notes) aiProposal.append(make('p', 'latex-ai-notes', proposal.notes));
    }

    async function aiRun(kind) {
      if (ai.busy || !file || !project) return;
      const value = aiInput.value.trim();
      const selection = aiSelection();
      if (!value) { aiSay(kind === 'ask' ? '请先写下问题。' : '请先说明想怎么改。', true); return; }
      aiBusy(true);
      aiSay((kind === 'ask' ? '正在问 DSH…' : '正在生成修改提案…') + (selection ? '（只发送选中的片段）' : ''));
      try {
        if (kind === 'ask') {
          const result = await api('latex_ai_ask', { id: project.id, path: file, question: value, ...(selection ? { selection } : {}), ...aiRoute() });
          aiAnswer.textContent = '';
          aiAnswer.append(make('p', 'latex-ai-question', value), make('p', 'latex-ai-text', result.answer));
          aiSay(`回答来自 ${result.model.provider}/${result.model.model}${result.material.truncated ? '（材料已截断）' : ''}`);
        } else {
          const result = await api('latex_ai_propose', { id: project.id, path: file, instruction: value, ...(selection ? { selection } : {}), ...aiRoute() });
          if (!result.changed) { ai.proposal = null; renderProposal(); aiSay('模型认为不需要改动。'); }
          else { ai.proposal = result.proposal; renderProposal(); aiSay(`提案：${result.proposal.replacements.length} 处改动，等待你确认`); }
        }
      } catch (error) {
        aiSay(`${kind === 'ask' ? '提问' : '生成提案'}失败：${error.message}`, true);
        if (error.status === 409 || error.code === 'LATEX_AI_MODEL_REQUIRED') toast?.(error.message);
      } finally {
        aiBusy(false);
      }
    }

    async function aiAcceptProposal() {
      if (ai.busy || !ai.proposal) return;
      aiBusy(true); aiSay('正在写入…');
      try {
        const result = await api('latex_ai_accept', { id: project.id, proposal_id: ai.proposal.id });
        ai.proposal = null; renderProposal();
        await openFile(file, { force: true });
        setSaveState('已接受 AI 建议', 'saved');
        aiSay(`已写入（${result.origin}）：${result.written.bytes} 字节`);
        scheduleCompile();
      } catch (error) {
        if (error.code === 'STATE_CONFLICT' && error.current) {
          pendingConflict = { path: error.current.path, content: editor.value, current: error.current };
          conflictText.textContent = '提案基于的版本已经变了：请载入最新内容后重新生成提案。';
          conflictBar.hidden = false;
          aiSay('文件已被改动，提案没有写入。', true);
        } else aiSay(`接受提案失败：${error.message}`, true);
      } finally { aiBusy(false); }
    }

    aiAsk.addEventListener('click', () => void aiRun('ask'));
    aiPropose.addEventListener('click', () => void aiRun('propose'));
    aiAccept.addEventListener('click', () => void aiAcceptProposal());
    aiDiscard.addEventListener('click', async () => {
      if (!ai.proposal) return;
      try { await api('latex_ai_discard', { id: project.id }); } catch { /* the local copy is dropped either way */ }
      ai.proposal = null; renderProposal(); aiSay('已放弃这份提案');
    });
    aiInput.addEventListener('keydown', event => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); void aiRun('ask'); }
    });

    view.addEventListener('keydown', event => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') { event.preventDefault(); void flush('manual'); }
    });

    /** Enter the workspace: the page becomes the surface, library hidden like the board's focus. */
    async function open(preferred) {
      view.hidden = false;
      document.body.classList.add('latex-focused');
      setTab('pdf');
      showRail(true);
      try {
        if (settingsRevision === null) await loadSettings();
        void refreshWorkspace();
        await refreshProjects(preferred);
        const wanted = project?.id && projects.some(item => item.id === project.id) ? project.id : projects[0]?.id;
        if (wanted) await selectProject(wanted);
        else await renderEmpty();
      } catch (error) {
        say(`无法读取项目列表：${error.message}`, true);
      }
    }

    async function close() {
      clearTimeout(timer); clearTimeout(compileTimer); closeMenu();
      if (dirty) await flush('manual');
      showRail(false);
      view.hidden = true;
      document.body.classList.remove('latex-focused');
    }

    /** The collaboration lives in the reading rail when there is one (same type as 批注). */
    if (rail?.registerPanel) {
      try { rail.registerPanel({ id: 'latex-ai', label: 'DSH 写作', element: aiSection }); }
      catch (error) { say(`侧栏不可用：${error.message}`, true); }
    }
    function showRail(open) {
      if (!rail?.setExternal) return;
      try {
        rail.setExternal(open);
        if (open) { rail.show('latex-ai'); void aiStatus(); }
        else rail.close('latex-ai');
        syncRailToggle();
      } catch (error) { say(`侧栏不可用：${error.message}`, true); }
    }
    function syncRailToggle() { aiToggle.setAttribute('aria-pressed', String(Boolean(rail?.visible?.('latex-ai')))); }
    aiToggle.addEventListener('click', () => {
      const open = !(rail?.visible?.('latex-ai'));
      showRail(open);
      if (open) void aiStatus();
    });
    // The rail's own × lives in the rail; keep the toolbar toggle honest about it.
    document.querySelector('.library-pane.shared-reading-sidebar')?.addEventListener('click', event => {
      if (event.target?.id === 'reading-sidebar-close' || event.target?.id === 'reading-sidebar-side') syncRailToggle();
    });

    back.addEventListener('click', () => void close());
    trigger.addEventListener('click', () => void open());
    applySettings(DEFAULT_SETTINGS, null);
    setTab('pdf');
    lineNumbers();
    void renderEmpty();

    return {
      open, close,
      isOpen: () => !view.hidden,
      refresh: () => open(project?.id),
      /** Used by the acceptance fixture to drive the surface without a real keyboard. */
      testHooks: {
        setProject: id => selectProject(id),
        type: text => { editor.value = text; dirty = true; lineNumbers(); setSaveState('未保存', 'dirty'); return flush('manual'); },
        flush: () => flush('manual'),
        openFile,
        compile: reason => compileOnce(reason || 'manual'),
        setTab,
        showRail,
        railVisible: () => Boolean(rail?.visible?.('latex-ai')),
        setSplit: (percent, persist) => setSplit(percent, { persist: persist === true }),
        create: (name, starter) => api('latex_ws_create', { name, starter }),
        attachSync: () => api('latex_ws_sync_attach'),
        status: () => refreshWorkspace(),
        state: () => ({
          project: project?.id || null, file, revision, dirty, pageCount, page, tab, split: settings.latex_split, rail: Boolean(rail), railOpen: Boolean(rail?.visible?.('latex-ai')),
          auto: settings.latex_auto_compile !== false, autoPaused, lastBuildOk, root: workspace.root,
          syncCovered: Boolean(workspace.sync?.covered), conflict: Boolean(pendingConflict),
          ai: { available: ai.available, proposal: ai.proposal?.id || null },
        }),
      },
      dispose() { disposed = true; clearTimeout(timer); clearTimeout(compileTimer); view.hidden = true; document.body.classList.remove('latex-focused'); },
    };
  }
  return { create };
})();
