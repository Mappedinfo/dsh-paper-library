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
  const MAX_RENDERED_PAGES = 3;
  const MAX_CACHED_BYTES = 48 * 1024 * 1024;
  const SPLIT_MIN = 25, SPLIT_MAX = 75;
  const DEFAULT_SETTINGS = { latex_starter: true, latex_auto_compile: true, latex_engine: 'xelatex', latex_theme: 'system', latex_path_font: 'pixel', latex_split: 50, latex_sync_folder: true };

  function create({api, toast = () => {}, getLibrary = () => '', rail = null, onVersionSaved = () => {}}) {
    const make = (tag, cls, text) => { const node = document.createElement(tag); if (cls) node.className = cls; if (text !== undefined) node.textContent = text; return node; };
    let projects = [], project = null, tree = null, file = null, revision = null, pageCount = 0, page = 1, tab = 'pdf';
    let pageGeometry = []; let syncFlash = null;
    let dirty = false, saving = false, compiling = false, disposed = false, timer = null, compileTimer = null, generation = 0, saveQueue = Promise.resolve();
    let lastBuildOk = null, autoPaused = false, pendingCompile = false;
    const rendered = new Map();
    let pdfWindowKey = '';
    let pendingConflict = null;
    let settings = { ...DEFAULT_SETTINGS };
    let settingsRevision = null;
    let committedSettings = { ...DEFAULT_SETTINGS }, pendingSettings = [], settingsTail = Promise.resolve();
    let workspace = { root: null, sync: null };
    let outline = null, navMode = 'outline', fileRequest = 0, navRequest = 0, pageRequest = 0;
    let fileAbort = null, pageAbort = null, navAbort = null, mediaAbort = null, mediaRequest = 0;
    let pdfVersion = '', zoom = 1, mediaPath = null, mediaPage = 1, mediaZoom = 1, mediaCount = 0;
    let mediaGeometry = null, resizeTimer = null, outlineTimer = null;
    let switching = false, entryRequest = 0;
    let pdfBuild = null, pdfTool = 'select';
    let pdfSource = { kind: 'current' }, pdfSourceEpoch = 0, pdfSourceIntent = 0;

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

    const title = make('strong', 'latex-title', 'LaTeX 工作台'); title.id = 'latex-workspace-title';
    const back = make('button', 'button subtle', '返回文献库'); back.id = 'latex-back'; back.type = 'button';
    back.title = '关闭工作台，回到文献库列表';

    // ---- toolbar: project, compile, and one menu for everything project-shaped ----
    const toolbar = make('header', 'latex-toolbar'); toolbar.setAttribute('aria-label', 'LaTeX 工作台工具栏');
    const projectSelect = make('select'); projectSelect.id = 'latex-project'; projectSelect.setAttribute('aria-label', '选择 LaTeX 项目');
    const compile = make('button', 'button primary', '编译'); compile.id = 'latex-compile'; compile.type = 'button';
    const diagnosticsToggle = make('button', 'button subtle latex-diagnostics-toggle', '编译状态'); diagnosticsToggle.id = 'latex-diagnostics-toggle'; diagnosticsToggle.type = 'button';
    diagnosticsToggle.setAttribute('aria-expanded', 'false'); diagnosticsToggle.setAttribute('aria-controls', 'latex-errors');
    diagnosticsToggle.hidden = true;
    const autoLabel = make('span', 'latex-auto'); autoLabel.id = 'latex-auto-state';
    const mainLabel = make('span', 'latex-main'); mainLabel.id = 'latex-main';
    const mainSelect = make('select'); mainSelect.id = 'latex-entry'; mainSelect.setAttribute('aria-label', '编译主文件');
    const saveState = make('span', 'latex-save-state'); saveState.id = 'latex-save-state'; saveState.setAttribute('role', 'status');
    const aiToggle = make('button', 'button subtle', 'DSH 写作'); aiToggle.id = 'latex-ai-open'; aiToggle.type = 'button';
    const reviewToggle = make('button', 'button subtle', '自审'); reviewToggle.id = 'latex-review-open'; reviewToggle.type = 'button';
    const navToggle = make('button', 'button subtle', '收起导航'); navToggle.id = 'latex-nav-toggle'; navToggle.type = 'button';
    navToggle.setAttribute('aria-controls', 'latex-navigator'); navToggle.setAttribute('aria-expanded', 'true');
    const layoutControls = make('div', 'latex-layout-controls'); layoutControls.setAttribute('role', 'group'); layoutControls.setAttribute('aria-label', '工作区视图');
    const layoutButtons = new Map();
    for (const [mode, label] of [['split', '并排'], ['source', '仅源码'], ['pdf', '仅 PDF']]) {
      const button = make('button', 'button subtle latex-layout-button', label); button.type = 'button'; button.id = `latex-layout-${mode}`;
      button.setAttribute('aria-pressed', String(mode === 'split')); button.addEventListener('click', () => setLayout(mode));
      layoutButtons.set(mode, button); layoutControls.append(button);
    }
    aiToggle.title = '在侧栏里提问或让模型改稿';
    aiToggle.hidden = !rail;
    const menuButton = make('button', 'button subtle latex-menu-button', '☰'); menuButton.id = 'latex-menu-open'; menuButton.type = 'button';
    menuButton.setAttribute('aria-expanded', 'false'); menuButton.setAttribute('aria-controls', 'latex-menu'); menuButton.setAttribute('aria-label', '项目与设置'); menuButton.title = '项目与设置';
    toolbar.append(title, projectSelect, mainLabel, saveState, autoLabel, compile, diagnosticsToggle, navToggle, layoutControls, reviewToggle, aiToggle, menuButton, back);

    const menu = make('div', 'latex-menu'); menu.id = 'latex-menu'; menu.setAttribute('aria-label', '项目与设置'); menu.hidden = true;
    const entryRow = make('div', 'latex-menu-section');
    const entryLabel = make('label', 'latex-menu-label', '编译主文件'); entryLabel.htmlFor = 'latex-entry';
    entryRow.append(entryLabel, mainSelect);
    const readingRow = make('div', 'latex-menu-section');
    const readingLabel = make('label', 'latex-menu-label', '版本所属的阅读项目'); readingLabel.htmlFor = 'latex-reading-project';
    const readingSelect = make('select'); readingSelect.id = 'latex-reading-project'; readingSelect.setAttribute('aria-label', '版本所属的阅读项目');
    const readingLink = make('button', 'button subtle', '关联项目'); readingLink.type = 'button'; readingLink.id = 'latex-reading-link';
    readingRow.append(readingLabel, readingSelect, readingLink);
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
    // The browser cannot hand out absolute paths, so the host opens the OS dialog.
    const newPick = make('button', 'button subtle', '选择…'); newPick.id = 'latex-new-pick'; newPick.type = 'button'; newPick.title = '打开系统文件夹选择对话框';
    const registerLine = make('div', 'latex-menu-row'); registerLine.append(newRoot, newPick, newTitle, starterLabel, newSubmit);
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
    const settingEngine = make('select'); settingEngine.id = 'latex-setting-engine'; settingEngine.setAttribute('aria-label', 'LaTeX 编译引擎（全部项目）');
    for (const [value, label] of [['xelatex', 'XeLaTeX'], ['pdflatex', 'pdfLaTeX'], ['lualatex', 'LuaLaTeX']]) { const option = make('option', '', label); option.value = value; settingEngine.append(option); }
    const engineLabel = make('label', 'latex-check'); engineLabel.append(make('span', '', '编译引擎（全部项目）'), settingEngine);
    const settingTheme = make('select'); settingTheme.id = 'latex-setting-theme'; settingTheme.setAttribute('aria-label', 'LaTeX 工作台配色');
    for (const [value, label] of [['system', '跟随宿主'], ['parchment', '纸色'], ['midnight', '夜色']]) { const option = make('option', '', label); option.value = value; settingTheme.append(option); }
    const themeLabel = make('label', 'latex-check'); themeLabel.append(make('span', '', '工作台配色'), settingTheme);
    const settingPathFont = make('select'); settingPathFont.id = 'latex-setting-path-font'; settingPathFont.setAttribute('aria-label', '文件路径字体');
    for (const [value, label] of [['pixel', '像素'], ['mono', '等宽'], ['system', '跟随界面']]) { const option = make('option', '', label); option.value = value; settingPathFont.append(option); }
    const pathFontLabel = make('label', 'latex-check'); pathFontLabel.append(make('span', '', '文件路径字体'), settingPathFont);
    const settingsRetry = make('button', 'button subtle', '重试保存设置'); settingsRetry.id = 'latex-settings-retry'; settingsRetry.type = 'button'; settingsRetry.hidden = true;
    const settingsLine = make('div', 'latex-menu-row'); settingsLine.append(settingStarterLabel, settingAutoLabel, engineLabel, themeLabel, pathFontLabel, settingsRetry);
    settingRow.append(settingsLine);

    const rootRow = make('div', 'latex-menu-section');
    rootRow.append(make('span', 'latex-menu-label', '论文目录'));
    const rootPath = make('code', 'latex-root'); rootPath.id = 'latex-root'; rootPath.textContent = '读取中…';
    const syncState = make('span', 'latex-sync-state'); syncState.id = 'latex-sync-state';
    const syncAttach = make('button', 'button subtle', '纳入同步'); syncAttach.id = 'latex-sync-attach'; syncAttach.type = 'button';
    const rootLine = make('div', 'latex-menu-row'); rootLine.append(rootPath, syncState, syncAttach);
    rootRow.append(rootLine, make('p', 'latex-menu-hint', '论文目录由插件维护；数据同步服务会把它作为一个独立源备份（只新增，不删改其他源）。'));
    menu.append(entryRow, readingRow, createRow, registerRow, compareRow, settingRow, rootRow);

    // ---- body: source | divider | (pdf | dsh | versions) ----
    const content = make('div', 'latex-content');
    const navigator = make('aside', 'latex-navigator'); navigator.id = 'latex-navigator'; navigator.setAttribute('aria-label', '项目导航');
    const navTabs = make('div', 'latex-nav-tabs'); navTabs.setAttribute('role', 'tablist');
    const navButtons = new Map();
    for (const [name, label] of [['outline', '章节'], ['files', '文件'], ['media', '媒体']]) {
      const button = make('button', 'latex-nav-tab', label); button.id = `latex-nav-${name}`; button.type = 'button'; button.setAttribute('role', 'tab');
      button.setAttribute('aria-controls', name === 'files' ? 'latex-files' : `latex-${name}`);
      button.addEventListener('click', () => setNav(name)); navButtons.set(name, button); navTabs.append(button);
    }
    const navRefresh = make('button', 'latex-nav-tab', '↻'); navRefresh.id = 'latex-nav-refresh'; navRefresh.type = 'button'; navRefresh.setAttribute('aria-label', '刷新项目导航'); navTabs.append(navRefresh);
    const outlineList = make('div', 'latex-outline'); outlineList.id = 'latex-outline'; outlineList.setAttribute('role', 'tabpanel');
    const mediaList = make('div', 'latex-media'); mediaList.id = 'latex-media'; mediaList.setAttribute('role', 'tabpanel');
    const navHint = make('p', 'latex-nav-hint'); navHint.textContent = '按已保存源码顺序；宏与条件不展开。';
    const body = make('div', 'latex-body');
    const left = make('section', 'latex-editor-pane'); left.setAttribute('aria-label', '源文件');
    const fileList = make('ul', 'latex-files'); fileList.id = 'latex-files';
    fileList.setAttribute('role', 'tabpanel');
    navigator.append(navTabs, outlineList, fileList, mediaList, navHint);
    const breadcrumb = make('div', 'latex-breadcrumb'); breadcrumb.id = 'latex-current-file';
    const currentFile = make('span', '', '选择源文件');
    const sourceNote = make('button', 'button subtle', '批注'); sourceNote.id = 'latex-source-note'; sourceNote.type = 'button'; sourceNote.title = '批注选段／当前行';
    const sourceSearch = make('button', 'button subtle', '查找'); sourceSearch.id = 'latex-source-search'; sourceSearch.type = 'button'; sourceSearch.title = '当前文件查找／替换（⌘/Ctrl+F）';
    const sourceTools = make('button', 'button subtle', '插入'); sourceTools.id = 'latex-source-tools'; sourceTools.type = 'button'; sourceTools.setAttribute('aria-expanded', 'false'); sourceTools.setAttribute('aria-controls', 'latex-source-tools-menu');
    breadcrumb.append(currentFile, sourceSearch, sourceNote, sourceTools);
    const sourceToolsMenu = make('div', 'latex-source-tools-menu'); sourceToolsMenu.id = 'latex-source-tools-menu'; sourceToolsMenu.hidden = true;
    const figureInsert = make('button', 'button subtle', '插入图片模板　⌘/Ctrl+Shift+I'); figureInsert.id = 'latex-insert-figure'; figureInsert.type = 'button';
    const tableInsert = make('button', 'button subtle', '编辑表格　⌘/Ctrl+Shift+T'); tableInsert.id = 'latex-insert-table'; tableInsert.type = 'button';
    const formulaCheck = make('button', 'button subtle', '提取并检查公式'); formulaCheck.id = 'latex-formula-check'; formulaCheck.type = 'button';
    sourceToolsMenu.append(figureInsert, tableInsert, formulaCheck, make('p', '', '图片拖到源码区或粘贴截图，保存到项目 figures/。表格支持 Markdown、Excel 选区和 .xlsx 文件。'));
    const formulaHost = make('section', 'latex-formula-panel'); formulaHost.id = 'latex-formula-panel'; formulaHost.hidden = true;
    const editorWrap = make('div', 'latex-editor-wrap');
    const gutter = make('div', 'latex-gutter'); gutter.id = 'latex-gutter'; gutter.setAttribute('aria-hidden', 'true');
    const editor = make('textarea'); editor.id = 'latex-editor'; editor.spellcheck = false; editor.autocomplete = 'off'; editor.setAttribute('aria-label', 'LaTeX 源文件内容');
    editorWrap.append(gutter, editor);
    const sourceEditor = window.PaperLatexEditor?.create(editor, editorWrap) || null;
    if (sourceEditor) { editorWrap.classList.add('latex-codemirror'); gutter.hidden = true; }
    sourceSearch.hidden = !sourceEditor;
    sourceSearch.addEventListener('click', () => sourceEditor?.openSearch());
    left.append(breadcrumb, sourceToolsMenu, formulaHost, editorWrap);

    const splitter = make('div', 'latex-splitter'); splitter.id = 'latex-splitter'; splitter.setAttribute('role', 'separator');
    splitter.setAttribute('aria-orientation', 'vertical'); splitter.setAttribute('aria-label', '调整源码与预览宽度'); splitter.tabIndex = 0;
    splitter.setAttribute('aria-valuemin', String(SPLIT_MIN)); splitter.setAttribute('aria-valuemax', String(SPLIT_MAX));

    const right = make('section', 'latex-preview-pane'); right.setAttribute('aria-label', '预览与协作');
    const tabs = make('div', 'latex-tabs'); tabs.setAttribute('role', 'tablist');
    const tabSpecs = rail ? [['pdf', 'PDF'], ['media', '媒体'], ['version', '版本']] : [['pdf', 'PDF'], ['media', '媒体'], ['ai', 'DSH 协作'], ['version', '版本']];
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
    const zoomSelect = make('select'); zoomSelect.id = 'latex-zoom'; zoomSelect.setAttribute('aria-label', 'PDF 缩放');
    for (const [value, label] of [['1', '全宽'], ['1.25', '125%'], ['1.5', '150%'], ['2', '200%'], ['3', '300%'], ['4', '400%']]) { const option = make('option', '', label); option.value = value; zoomSelect.append(option); }
    const renderState = make('span', 'latex-render-state'); renderState.id = 'latex-render-state'; renderState.setAttribute('role', 'status');
    const pdfTools = make('div', 'latex-pdf-tools');
    for (const [mode, label] of [['select', '选择'], ['highlight', '高亮'], ['underline', '下划线'], ['strikeout', '删除线'], ['comment', '批注'], ['note', '区域']]) {
      const button = make('button', 'button subtle', label); button.type = 'button'; button.id = `latex-tool-${mode}`;
      const description = { select: '选择文字／双击定位源码', highlight: '文字高亮', underline: '文字下划线', strikeout: '文字删除线', comment: '选中文字添加批注', note: '添加区域便笺' }[mode];
      button.title = description; button.setAttribute('aria-label', description);
      button.setAttribute('aria-pressed', String(mode === pdfTool));
      button.addEventListener('click', () => { if (pdfSource.kind === 'version' && mode !== 'select') return; pdfTool = mode; preview.dataset.tool = mode; for (const item of pdfTools.querySelectorAll('button')) item.setAttribute('aria-pressed', String(item === button)); });
      pdfTools.append(button);
    }
    const syncHint = make('p', 'latex-sync-hint'); syncHint.id = 'latex-sync-hint'; syncHint.setAttribute('role', 'status');
    const toPdf = make('button', 'button subtle', '跳到 PDF'); toPdf.id = 'latex-synctex-forward'; toPdf.type = 'button';
    toPdf.title = '把编辑器光标所在行定位到 PDF（SyncTeX）；双击 PDF 可反向跳到源码';
    toPdf.setAttribute('aria-label', '从光标行跳到 PDF 对应位置');
    previewHead.append(pagePrev, pageLabel, pageNext, zoomSelect, toPdf, renderState);
    const preview = make('div', 'latex-preview'); preview.id = 'latex-preview';
    const errors = make('ul', 'latex-errors'); errors.id = 'latex-errors'; errors.hidden = true;
    panePdf.append(syncHint, preview);
    const paneMedia = make('div', 'latex-pane'); paneMedia.id = 'latex-pane-media'; paneMedia.setAttribute('role', 'tabpanel');
    const mediaHead = make('div', 'latex-preview-head');
    const mediaPrev = make('button', 'icon-button', '‹'); mediaPrev.id = 'latex-media-prev'; mediaPrev.type = 'button'; mediaPrev.setAttribute('aria-label', '媒体上一页');
    const mediaNext = make('button', 'icon-button', '›'); mediaNext.id = 'latex-media-next'; mediaNext.type = 'button'; mediaNext.setAttribute('aria-label', '媒体下一页');
    const mediaFit = make('button', 'button subtle', '适应'); mediaFit.id = 'latex-media-fit'; mediaFit.type = 'button';
    const mediaPlus = make('button', 'button subtle', '＋'); mediaPlus.id = 'latex-media-plus'; mediaPlus.type = 'button'; mediaPlus.setAttribute('aria-label', '放大媒体');
    const mediaMinus = make('button', 'button subtle', '−'); mediaMinus.id = 'latex-media-minus'; mediaMinus.type = 'button'; mediaMinus.setAttribute('aria-label', '缩小媒体');
    const mediaInfo = make('span', 'latex-page-label'); mediaInfo.id = 'latex-media-info'; mediaInfo.setAttribute('role', 'status');
    mediaHead.append(mediaPrev, mediaNext, mediaMinus, mediaFit, mediaPlus);
    const mediaCrumb = make('code', 'latex-breadcrumb'); mediaCrumb.id = 'latex-media-path';
    const mediaPreview = make('div', 'latex-preview'); mediaPreview.id = 'latex-media-preview';
    mediaPreview.textContent = '从左侧「媒体」选择项目内的文件。';
    paneMedia.append(mediaCrumb, mediaInfo, mediaPreview);

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
    const versionRoot = make('section', 'latex-versions'); versionRoot.id = 'latex-versions';
    const returnCurrent = make('button', 'button subtle', '返回当前编译稿'); returnCurrent.id = 'latex-version-current'; returnCurrent.type = 'button'; returnCurrent.addEventListener('click', () => void showCurrentPdf());
    const versions = window.PaperLatexVersions?.create({ root: versionRoot, api, scope: () => project ? { id: project.id } : null,
      openVersion: (version, reviewPdfVersion) => showVersion(version.id, reviewPdfVersion) });
    const versionHead = make('div', 'latex-preview-head');
    const diffOpen = make('button', 'button subtle', '与上一版对比'); diffOpen.id = 'latex-diff-open'; diffOpen.type = 'button';
    const diffHint = make('span', 'latex-page-label', '当前文件与它上一个落库版本');
    versionHead.append(diffOpen, diffHint);
    const diff = make('pre', 'latex-diff'); diff.id = 'latex-diff';
    diff.textContent = '点「与上一版对比」查看这个文件的改动；菜单里的「与其他项目对比」结果显示在这里。';
    paneVersion.append(returnCurrent, versionRoot, versionHead, diff);

    const previewToolbar = make('div', 'latex-preview-toolbar');
    previewToolbar.setAttribute('aria-label', '预览工具');
    previewToolbar.append(tabs, previewHead, pdfTools, mediaHead);
    right.append(previewToolbar, panePdf, paneMedia, paneAi, paneVersion);
    body.append(left, splitter, right);
    content.append(navigator, body);

    const status = make('p', 'latex-status'); status.id = 'latex-status'; status.setAttribute('role', 'status');
    const conflictBar = make('div', 'latex-conflict'); conflictBar.id = 'latex-conflict'; conflictBar.hidden = true;
    const conflictText = make('span', '', ''); conflictText.id = 'latex-conflict-text';
    const reload = make('button', 'button subtle', '载入最新'); reload.id = 'latex-conflict-reload'; reload.type = 'button';
    const overwrite = make('button', 'button subtle', '用我的版本覆盖'); overwrite.id = 'latex-conflict-overwrite'; overwrite.type = 'button';
    conflictBar.append(conflictText, reload, overwrite);
    const footer = make('footer', 'latex-footer');
    footer.append(conflictBar, status);
    const topbar = make('div', 'latex-topbar'); topbar.append(toolbar, menu);
    view.append(topbar, errors, content, footer);
    let layout = 'split';
    function setLayout(mode) {
      if (!layoutButtons.has(mode)) return;
      layout = mode;
      body.dataset.layout = mode;
      left.hidden = mode === 'pdf';
      right.hidden = mode === 'source';
      splitter.hidden = mode !== 'split';
      for (const [candidate, button] of layoutButtons) button.setAttribute('aria-pressed', String(candidate === mode));
      if (mode === 'pdf') setTab('pdf');
      if (mode !== 'source') requestResize();
    }
    navToggle.addEventListener('click', () => {
      navigator.hidden = !navigator.hidden;
      content.classList.toggle('latex-nav-collapsed', navigator.hidden);
      navToggle.textContent = navigator.hidden ? '展开导航' : '收起导航';
      navToggle.setAttribute('aria-expanded', String(!navigator.hidden));
      if (layout !== 'source') requestResize();
    });
    const reviewPanel = make('section', 'latex-review-panel'); reviewPanel.id = 'latex-review-panel'; reviewPanel.setAttribute('aria-label', '自审批注');
    if (!rail) { reviewPanel.hidden = true; content.append(reviewPanel); }
    const reviewer = window.PaperLatexReview?.create({ root: reviewPanel, api,
      context: () => ({ id: project?.id, main: project?.main_path, file, revision, dirty, editor, build: pdfBuild }),
      show: () => showReview(),
      revealSource: async anchor => {
        if (!await openFile(anchor.path, { force: true })) return;
        if (revision !== anchor.revision) { say('源码已变化，原批注待重定位；未按旧偏移选择。', true); void reviewer.refresh(); return; }
        await gotoSource(anchor.path, anchor.line);
        const chars = Array.from(editor.value);
        editor.setSelectionRange(chars.slice(0, anchor.start).join('').length, chars.slice(0, anchor.end).join('').length);
      },
      revealPdf: async anchor => {
        if (pdfSource.kind !== 'current' && !await showCurrentPdf()) return;
        if (anchor.pdf_version !== pdfBuild?.pdf_version) { say('批注属于旧编译，待重定位；未定位到当前 PDF。', true); return; }
        if (layout === 'source') setLayout('split');
        setTab('pdf'); await renderPage(anchor.page);
        const rect = anchor.rects[0]; if (rect) await highlightPdf({ page: anchor.page, h: rect[0], v: rect[3], W: rect[2] - rect[0], H: rect[3] - rect[1] });
      },
      changed: ({ annotations }) => { if (pdfSource.kind === 'current') patchPdfAnnotations(annotations); },
    });
    function showReview() {
      if (!reviewer) { say('自审组件尚未加载；请先刷新插件页面。', true); return; }
      if (rail?.setExternal) { rail.setExternal(true); rail.show('latex-review'); }
      else reviewPanel.hidden = false;
    }
    reviewToggle.addEventListener('click', () => { showReview(); if (reviewer) void reviewer.refresh(); });
    sourceNote.addEventListener('click', () => reviewer?.beginSource());
    function updateSyncHint() {
      const position = pageCount ? `第 ${page} / ${pageCount} 页 · ` : '';
      syncHint.textContent = position + (pdfSource.kind === 'version' ? '历史版本只读预览；当前源码不能与此 PDF 同步定位或写入批注。' : (dirty ? '源码有未保存修改；PDF 仍属于上次编译，双击定位暂停。' : (pdfBuild?.reason || '编译后可双击正文定位源码；自审批注保存在审阅副本。')));
    }

    function say(text, error = false) { status.textContent = text; status.classList.toggle('error', error); }
    function setSaveState(text, kind = '') { saveState.textContent = text; saveState.dataset.state = kind; }
    function setTab(name) {
      tab = name;
      previewHead.hidden = name !== 'pdf'; pdfTools.hidden = name !== 'pdf'; mediaHead.hidden = name !== 'media';
      for (const [candidate, button] of tabButtons) {
        const active = candidate === name;
        button.classList.toggle('active', active);
        button.setAttribute('aria-selected', String(active));
      }
      for (const [candidate, pane] of [['pdf', panePdf], ['media', paneMedia], ['ai', paneAi], ['version', paneVersion]]) pane.hidden = candidate !== name;
      if (name === 'ai' && project) void aiStatus();
      if (name === 'version' && project) void versions?.refresh();
      if (name === 'pdf' && pageCount) requestResize();
    }
    function lineNumbers() {
      if (sourceEditor) return; // CodeMirror renders only the visible gutter lines.
      const lines = editor.value.split('\n').length;
      const buffer = [];
      for (let index = 1; index <= lines; index += 1) buffer.push(String(index));
      gutter.textContent = buffer.join('\n');
      gutter.scrollTop = editor.scrollTop;
    }
    editor.addEventListener('scroll', () => { gutter.scrollTop = editor.scrollTop; });
    editor.addEventListener('input', () => {
      dirty = true; pendingConflict = null; conflictBar.hidden = true; lineNumbers(); setSaveState('未保存', 'dirty'); scheduleSave();
      updateSyncHint();
    });
    function writingContext() {
      return { id: project?.id, title: project?.title, path: file, revision, content: editor.value, selectionStart: editor.selectionStart || 0, selectionEnd: editor.selectionEnd || 0,
        blocked: !project || !file || editor.disabled || switching || Boolean(pendingConflict) };
    }
    function insertWriting(text, expected) {
      const current = writingContext();
      if (disposed || current.blocked || !expected || current.id !== expected.id || current.path !== expected.path || current.content !== expected.content) {
        say('源码已切换或发生改动；插入内容保留在工具中，请确认后再复制。', true); return false;
      }
      const start = Math.min(expected.selectionStart || 0, editor.value.length), end = Math.min(expected.selectionEnd || start, editor.value.length);
      if (sourceEditor) return sourceEditor.insert(text, start, end);
      editor.value = editor.value.slice(0, start) + text + editor.value.slice(end);
      editor.setSelectionRange(start + text.length, start + text.length);
      editor.dispatchEvent(new Event('input', { bubbles: true })); editor.focus(); return true;
    }
    const writingTools = window.PaperLatexWritingTools?.create({ root: view, api, toast, getContext: writingContext, insert: insertWriting,
      onAssetsChanged: () => { if (project) void loadTree(); } });
    const formulas = window.PaperLatexFormulas?.create({ host: formulaHost, api, getProject: () => project,
      beforeRefresh: async () => { if (!project || !file || switching) return false; await flush('manual'); await saveQueue; return !dirty && !pendingConflict; },
      onLocate: ({ path, line }) => gotoSource(path, line) });
    function closeSourceTools() { sourceToolsMenu.hidden = true; sourceTools.setAttribute('aria-expanded', 'false'); }
    sourceTools.addEventListener('click', event => { event.stopPropagation(); sourceToolsMenu.hidden = !sourceToolsMenu.hidden; sourceTools.setAttribute('aria-expanded', String(!sourceToolsMenu.hidden)); });
    sourceToolsMenu.addEventListener('click', event => event.stopPropagation());
    figureInsert.addEventListener('click', () => { closeSourceTools(); writingTools?.figure(); });
    tableInsert.addEventListener('click', () => { closeSourceTools(); writingTools?.table(); });
    formulaCheck.addEventListener('click', () => { closeSourceTools(); void formulas?.open(); });
    editorWrap.addEventListener('dragover', event => { if ([...(event.dataTransfer?.types || [])].includes('Files')) event.preventDefault(); });
    editorWrap.addEventListener('drop', event => { void writingTools?.handleTransfer(event); });
    editorWrap.addEventListener('paste', event => { void writingTools?.handleTransfer(event); });
    view.addEventListener('click', closeSourceTools);

    // ---- settings, root and sync -------------------------------------------------
    function applySettings(value, revision) {
      if (value && typeof value === 'object') settings = { ...DEFAULT_SETTINGS, ...value };
      if (revision !== undefined) settingsRevision = revision;
      settingStarter.checked = settings.latex_starter !== false;
      settingAuto.checked = settings.latex_auto_compile !== false;
      settingEngine.value = settings.latex_engine || 'xelatex';
      settingTheme.value = settings.latex_theme || 'system';
      view.dataset.latexTheme = settingTheme.value;
      settingPathFont.value = settings.latex_path_font || 'pixel';
      view.dataset.latexPathFont = settingPathFont.value;
      createStarter.checked = settings.latex_starter !== false;
      newStarter.checked = settings.latex_starter !== false;
      autoLabel.textContent = settings.latex_auto_compile === false ? '自动编译已关' : (autoPaused ? '自动编译已暂停' : '自动编译');
      setSplit(Number.isSafeInteger(settings.latex_split) ? settings.latex_split : 50, { persist: false });
    }
    function showPendingSettings() {
      const pending = Object.assign({}, ...pendingSettings.map(entry => entry.patch));
      applySettings({ ...committedSettings, ...pending }, settingsRevision);
      settingsRetry.hidden = !pendingSettings.some(entry => entry.failed);
    }
    function acceptSettings(snapshot) {
      committedSettings = { ...DEFAULT_SETTINGS, ...snapshot.value };
      settingsRevision = snapshot.revision;
      showPendingSettings();
    }
    async function loadSettings() {
      try { acceptSettings(await api('settings_get')); }
      catch { acceptSettings({ value: DEFAULT_SETTINGS, revision: null }); }
    }
    function saveSetting(patch) {
      // A newer choice supersedes a failed, unsaved choice of the same field.
      const keys = Object.keys(patch);
      pendingSettings = pendingSettings.filter(entry => !entry.failed || !keys.some(key => Object.hasOwn(entry.patch, key)));
      const entry = { patch, failed: false };
      pendingSettings.push(entry);
      showPendingSettings();
      const save = async () => {
        try {
          if (settingsRevision === null) acceptSettings(await api('settings_get'));
          if (settingsRevision === null) throw new Error('未连接设置服务');
          let snapshot;
          try { snapshot = await api('settings_update', { patch, expected_revision: settingsRevision }); }
          catch (error) {
            if (error.code !== 'STATE_CONFLICT') throw error;
            // Another client changed settings. Rebase this explicit choice on the
            // newest revision once; unrelated changes stay authoritative.
            acceptSettings(await api('settings_get'));
            snapshot = await api('settings_update', { patch, expected_revision: settingsRevision });
          }
          pendingSettings = pendingSettings.filter(item => item !== entry);
          acceptSettings(snapshot);
          if (!pendingSettings.some(item => item.failed)) say('设置已保存');
          return true;
        } catch (error) {
          entry.failed = true;
          showPendingSettings();
          say(`设置未保存：${error.message}。选择已保留，请在写作设置中重试。`, true);
          return false;
        }
      };
      settingsTail = settingsTail.then(save, save);
      return settingsTail;
    }
    settingsRetry.addEventListener('click', () => {
      const failed = pendingSettings.filter(entry => entry.failed).map(entry => entry.patch);
      pendingSettings = pendingSettings.filter(entry => !entry.failed);
      for (const patch of failed) void saveSetting(patch);
    });

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
      if (!menu.hidden) { void refreshWorkspace(); void loadReadingProjects(); }
    });
    let readingRequest = 0;
    async function loadReadingProjects() {
      const id = project?.id, request = ++readingRequest; if (!id) return;
      try {
        const result = await api('project_list', { limit: 200 });
        if (request !== readingRequest || project?.id !== id) return;
        readingSelect.textContent = ''; const empty = make('option', '', '首次手动保存版本时新建同名阅读项目'); empty.value = ''; readingSelect.append(empty);
        for (const item of result.projects || []) { const option = make('option', '', item.title); option.value = item.id; readingSelect.append(option); }
        if (project.reading_project_id && !(result.projects || []).some(item => item.id === project.reading_project_id)) { const option = make('option', '', `已关联项目 ${project.reading_project_id}`); option.value = project.reading_project_id; readingSelect.append(option); }
        readingSelect.value = project.reading_project_id || '';
      } catch (error) { say(`阅读项目读取失败：${error.message}`, true); }
    }
    readingLink.addEventListener('click', async () => {
      if (!project) return; const id = project.id; readingLink.disabled = true;
      try { const result = await api('latex_project_link_reading', { id, reading_project_id: readingSelect.value || null }); if (project?.id === id) { project.reading_project_id = result.reading_project_id; say('版本所属的阅读项目已更新'); void versions?.refresh(); } }
      catch (error) { say(`关联未保存：${error.message}`, true); }
      finally { readingLink.disabled = false; }
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
      const targetProject = project.id, targetFile = file;
      clearTimeout(timer);
      saveQueue = saveQueue.then(async () => {
        if (disposed || ticket !== generation || file !== targetFile) return;
        // The revision is read inside the queue: an earlier save in this queue has
        // already advanced it, so the next write is checked against what it wrote.
        const expected = revision;
        saving = true; setSaveState(reason === 'manual' ? '保存中…' : '自动保存…', 'saving');
        try {
          const result = await api('latex_write', { id: targetProject, path: targetFile, content: body, expected_revision: expected, origin: 'reader' });
          if (ticket !== generation) return;
          revision = result.revision;
          dirty = editor.value !== body;
          setSaveState(result.changed ? '已保存' : '没有改动', 'saved');
          if (reason === 'manual') say(`已保存 ${file}（${result.bytes} 字节）`);
          if (result.changed) {
            scheduleCompile(); scheduleOutline();
            if (pdfBuild) pdfBuild = { ...pdfBuild, verified: false, reason: '源码已保存，当前 PDF 待重新编译；旧批注不会自动移动。' };
            updateSyncHint(); void reviewer?.refresh();
          }
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

    async function savedBeforeLeaving(checkReview = false) {
      if (checkReview && reviewer?.hasDraft()) { showReview(); say('自审批注尚未保存；请保存或取消后再切换、编译或关闭。', true); return false; }
      if (dirty || saving) await flush('manual');
      await saveQueue;
      if (dirty || pendingConflict) {
        say('当前文件尚未保存；请先解决保存失败或冲突，再切换。', true);
        return false;
      }
      return true;
    }

    function cancelReads() {
      fileRequest += 1; pageRequest += 1; navRequest += 1; mediaRequest += 1;
      for (const controller of [fileAbort, pageAbort, navAbort, mediaAbort]) controller?.abort();
      clearTimeout(outlineTimer); clearTimeout(resizeTimer); clearTimeout(compileTimer);
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
        const option = make('option', '', item.title);
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
      if (switching || compiling) { projectSelect.value = project?.id || ''; return; }
      if (!await savedBeforeLeaving(true)) { projectSelect.value = project?.id || ''; return; }
      if (!id) { project = null; await renderEmpty(); return; }
      cancelReads();
      generation += 1;
      const ticket = generation;
      clearRendered();
      formulas?.clear(); formulas?.close();
      project = projects.find(item => item.id === id) || null;
      if (!project) { await renderEmpty(); return; }
      resetPdfSource({ kind: 'current' });
      projectSelect.value = project.id;
      errors.textContent = ''; errors.hidden = true; diagnosticsToggle.hidden = true; diagnosticsToggle.setAttribute('aria-expanded', 'false');
      reviewer?.reset(); pdfBuild = null; updateSyncHint();
      file = null; revision = null; editor.value = ''; editor.disabled = true; lineNumbers();
      pageCount = 0; pageGeometry = []; pdfVersion = ''; mediaPath = null; mediaGeometry = null;
      if (mediaUrl) { URL.revokeObjectURL(mediaUrl); mediaUrl = null; }
      mediaPreview.textContent = '从左侧「媒体」选择项目内的文件。'; mediaCrumb.textContent = ''; mediaInfo.textContent = '';
      setPreviewMessage('读取项目…');
      try { await loadTree(); }
      catch (error) { if (ticket === generation) say(`项目导航读取失败：${error.message}`, true); return; }
      if (ticket !== generation) return;
      const main = project.main_path || (tree?.files || []).find(item => item.kind === 'text')?.path;
      if (main) await openFile(main);
      else { file = null; revision = null; editor.value = ''; lineNumbers(); say('这个项目里还没有可编辑的文本源文件。'); }
      page = 1;
      if (project.pdf_present) await loadLayout(); else setPreviewMessage('还没有 PDF；点「编译」生成。');
      if (ticket !== generation) return;
      void reviewer?.refresh();
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
      fileList.textContent = ''; errors.textContent = ''; renderEmptyState();
      outlineList.textContent = ''; mediaList.textContent = ''; mainSelect.textContent = ''; currentFile.textContent = '选择源文件';
      mainLabel.textContent = ''; setSaveState(''); buildInfo.textContent = '';
      errors.hidden = true; diagnosticsToggle.hidden = true; diagnosticsToggle.setAttribute('aria-expanded', 'false');
      lastBuildOk = null; autoPaused = false;
    }

    /** No project yet: explain the folder model inline and offer both entry points. */
    function renderEmptyState() {
      preview.textContent = '';
      pageCount = 0; pageLabel.textContent = '—';
      const card = make('div', 'latex-preview-empty-card');
      card.append(make('p', 'latex-preview-empty', '还没有 LaTeX 项目。'));
      card.append(make('p', 'latex-preview-empty-hint',
        '项目就是一个装着 .tex 和对应 PDF 的文件夹：可以新建一个，也可以登记磁盘上已有的文件夹——文件留在原处，插件只登记、不改动也不删除；文件夹里还没有 .tex 时，可勾选写入最小 main.tex。'));
      const row = make('div', 'latex-preview-empty-actions');
      const createButton = make('button', 'button', '新建项目…'); createButton.type = 'button';
      const registerButton = make('button', 'button subtle', '登记已有文件夹…'); registerButton.type = 'button';
      row.append(createButton, registerButton);
      card.append(row);
      preview.append(card);
      const openMenuTo = target => {
        menu.hidden = false;
        menuButton.setAttribute('aria-expanded', 'true');
        void refreshWorkspace();
        target.focus();
      };
      createButton.addEventListener('click', event => { event.stopPropagation(); openMenuTo(createName); });
      registerButton.addEventListener('click', event => { event.stopPropagation(); openMenuTo(newRoot); });
    }

    function setPreviewMessage(text) {
      preview.textContent = '';
      const note = make('p', 'latex-preview-empty', text);
      preview.append(note); pageCount = 0; pageLabel.textContent = '—';
    }

    function setNav(name) {
      navMode = name;
      for (const [mode, button] of navButtons) button.setAttribute('aria-selected', String(mode === name));
      outlineList.hidden = name !== 'outline'; fileList.hidden = name !== 'files'; mediaList.hidden = name !== 'media';
    }
    function sourceButton(path, label = path, line = 1) {
      const button = make('button', 'latex-file-open', label); button.type = 'button'; button.dataset.path = path; button.dataset.line = String(line);
      button.title = `${path}:${line}`;
      button.addEventListener('click', () => void gotoSource(path, line));
      button.classList.toggle('active', path === file);
      return button;
    }
    function directoryTree(container, items, media = false) {
      container.textContent = '';
      const folders = new Map([['', container]]);
      for (const item of items) {
        const parts = item.path.split('/'); let parent = container, prefix = '';
        for (const part of parts.slice(0, -1)) {
          prefix += `${part}/`;
          if (!folders.has(prefix)) {
            const details = make('details', 'latex-directory'); details.open = true;
            details.append(make('summary', '', part)); parent.append(details); folders.set(prefix, details);
          }
          parent = folders.get(prefix);
        }
        const row = make('li', 'latex-file');
        if (media) {
          const button = make('button', 'latex-file-open', parts.at(-1)); button.type = 'button'; button.dataset.media = item.path;
          button.title = `${item.path} · ${item.bytes} 字节`;
          button.addEventListener('click', () => void openMedia(item.path)); row.append(button);
        } else row.append(sourceButton(item.path, `${item.main ? '★ ' : ''}${parts.at(-1)}`));
        parent.append(row);
      }
      if (!items.length) container.append(make('p', 'latex-nav-hint', media ? '暂无媒体文件' : '暂无源文件'));
    }
    async function loadOutline() {
      if (!project) return;
      const id = project.id, ticket = ++navRequest;
      navAbort?.abort(); navAbort = new AbortController();
      try {
        const result = await api('latex_outline', { id }, { signal: navAbort.signal });
        if (ticket !== navRequest || id !== project?.id || disposed) return;
        outline = result; outlineList.textContent = '';
        for (const item of result.events || []) {
          const row = make('div', `latex-outline-${item.kind}`);
          const label = item.kind === 'file' ? `${item.repeated ? '↳ ' : ''}${item.title}` : item.title;
          const button = sourceButton(item.path, label, item.line);
          if (item.kind === 'warning') button.title += item.target ? ` · ${item.target}` : '';
          if (item.kind === 'heading') button.style.paddingLeft = `${8 + Math.max(0, item.level - 2) * 12}px`;
          row.append(button); outlineList.append(row);
        }
        if (result.unreferenced?.length) {
          const group = make('details', 'latex-directory'); group.append(make('summary', '', '其他文本文件'));
          for (const path of result.unreferenced) group.append(sourceButton(path));
          outlineList.append(group);
        }
        const candidates = [...new Set([project.main_path, ...(result.entries || [])].filter(Boolean))];
        mainSelect.textContent = '';
        for (const path of candidates) { const option = make('option', '', path); option.value = path; mainSelect.append(option); }
        mainSelect.value = project.main_path;
        navHint.textContent = result.truncated || result.tree_truncated || !result.entry_scan_complete ? '导航达到读取预算，结果可能不完整；可用文件树打开。' : '按已保存源码顺序；宏与条件不展开。';
      } catch (error) {
        if (ticket !== navRequest || error.name === 'AbortError') return;
        outlineList.textContent = `章节读取失败：${error.message}。可用「文件」导航，或点 ↻ 重试。`;
      }
    }
    function scheduleOutline() { clearTimeout(outlineTimer); outlineTimer = setTimeout(() => void loadOutline(), 1200); }
    async function loadTree() {
      const id = project.id, ticket = generation;
      const result = await api('latex_tree', { id });
      if (id !== project?.id || ticket !== generation) return;
      tree = result;
      directoryTree(fileList, (tree.files || []).filter(item => item.kind === 'text'));
      directoryTree(mediaList, (tree.files || []).filter(item => item.kind === 'asset' || item.kind === 'other'), true);
      mainLabel.textContent = `编译：${project.main_path || '未设置'}`;
      mainLabel.title = `编译主文件：${project.main_path || '未设置'}`;
      mainSelect.textContent = '';
      const option = make('option', '', project.main_path || '未设置'); option.value = project.main_path || ''; mainSelect.append(option);
      await loadOutline();
    }
    navRefresh.addEventListener('click', () => { if (project) void loadTree().catch(error => say(`导航读取失败：${error.message}`, true)); });
    mainSelect.addEventListener('change', async () => {
      const path = mainSelect.value;
      const intent = ++entryRequest, id = project?.id;
      if (!project || path === project.main_path || switching || compiling) { mainSelect.value = project?.main_path || ''; return; }
      if (!await savedBeforeLeaving(true)) { mainSelect.value = project.main_path; return; }
      if (intent !== entryRequest || id !== project?.id) return;
      switching = true; mainSelect.disabled = true; compile.disabled = true;
      cancelReads(); generation += 1; clearRendered();
      try {
        const result = await api('latex_project_update', { id: project.id, main_path: path });
        project = result.project; projects = projects.map(item => item.id === project.id ? project : item);
        resetPdfSource({ kind: 'current' });
        errors.textContent = ''; diagnosticsToggle.hidden = true; setDiagnosticsOpen(false);
        reviewer?.reset(); pdfBuild = null; updateSyncHint();
        file = null; revision = null; editor.value = ''; editor.disabled = true;
        page = 1; pageGeometry = []; setPreviewMessage('读取主入口…');
        await loadTree(); await openFile(path);
        if (project.pdf_present) await loadLayout(); else setPreviewMessage('这个主入口还没有 PDF；点「编译」生成。');
        say(`已切换主入口 ${path}`);
        void reviewer?.refresh();
      } catch (error) { mainSelect.value = project.main_path; say(`切换入口失败：${error.message}`, true); }
      finally { switching = false; mainSelect.disabled = false; compile.disabled = false; }
    });

    async function openFile(path, options = {}) {
      if (path === file && !options.force && !editor.disabled) return true;
      if (!project || !await savedBeforeLeaving()) return false;
      const id = project.id, ticket = ++fileRequest, epoch = generation;
      fileAbort?.abort(); fileAbort = new AbortController(); editor.disabled = true;
      let read;
      try { read = await api('latex_read', { id, path }, { signal: fileAbort.signal }); }
      catch (error) {
        if (ticket === fileRequest && error.name !== 'AbortError') say(`文件读取失败：${error.message}`, true);
        return false;
      } finally { if (ticket === fileRequest) editor.disabled = !file; }
      if (ticket !== fileRequest || epoch !== generation || id !== project?.id || disposed) return false;
      file = read.path; revision = read.revision; dirty = false;
      editor.disabled = false; currentFile.textContent = file;
      editor.value = read.content; lineNumbers(); editor.scrollTop = 0; gutter.scrollTop = 0;
      pendingConflict = null; conflictBar.hidden = true;
      setSaveState('已载入', 'saved');
      for (const button of navigator.querySelectorAll('button[data-path]')) button.classList.toggle('active', button.dataset.path === file);
      say(`${file} · ${read.bytes} 字节 · ${read.lines} 行 · 修订 ${read.revision.slice(0, 8)}`);
      return true;
    }

    async function loadLayout() {
      const id = project?.id, ticket = generation, source = pdfSource, sourceEpoch = pdfSourceEpoch;
      try {
        const layout = source.kind === 'version'
          ? await api('latex_version_pdf_pages', { version_id: source.versionId, ...(source.reviewPdfVersion ? { review_pdf_version: source.reviewPdfVersion } : {}) })
          : await api('latex_pdf_pages', { id });
        if (ticket !== generation || id !== project?.id || sourceEpoch !== pdfSourceEpoch || disposed) return;
        pdfVersion = layout.version || buildInfo.dataset.build || '';
        pdfBuild = source.kind === 'current' ? (layout.build || null) : null; updateSyncHint();
        pageCount = layout.page_count; pageGeometry = layout.pages || []; page = Math.min(Math.max(1, page), Math.max(1, pageCount));
        await renderPage(page);
      } catch (error) {
        if (ticket !== generation || sourceEpoch !== pdfSourceEpoch) return;
        setPreviewMessage(`无法预览：${error.message}`);
      }
    }

    function clearRendered() { for (const item of rendered.values()) URL.revokeObjectURL(item.url); rendered.clear(); pdfWindowKey = ''; }
    function resetPdfSource(source) {
      pdfSource = source; pdfSourceEpoch += 1; pdfSourceIntent += 1; pageRequest += 1; pageAbort?.abort(); clearRendered();
      pdfVersion = ''; pdfBuild = null; page = 1; pageCount = 0; pageGeometry = []; pdfTool = 'select';
      preview.dataset.tool = pdfTool;
      for (const button of pdfTools.querySelectorAll('button')) {
        button.disabled = source.kind === 'version' && button.id !== 'latex-tool-select';
        button.setAttribute('aria-pressed', String(button.id === 'latex-tool-select'));
      }
      toPdf.disabled = source.kind === 'version'; updateSyncHint();
    }
    async function showVersion(versionId, reviewPdfVersion = null) {
      const intent = ++pdfSourceIntent;
      if (!project || !versionId || switching || compiling || !await savedBeforeLeaving(true) || intent !== pdfSourceIntent) return false;
      const id = project.id, ticket = generation;
      try {
        const result = await api('latex_version_get', { version_id: versionId });
        if (ticket !== generation || id !== project?.id || intent !== pdfSourceIntent) return false;
        if (result.version?.project_id !== id) throw new Error('这个版本不属于当前 LaTeX 项目。');
        resetPdfSource({ kind: 'version', versionId, reviewPdfVersion });
        const sourceEpoch = pdfSourceEpoch;
        setPreviewMessage('读取历史版本…'); if (layout === 'source') setLayout('split'); setTab('pdf');
        await loadLayout();
        if (ticket !== generation || sourceEpoch !== pdfSourceEpoch || !pageCount) return false;
        say(`正在只读预览历史版本 ${versionId}。`); return true;
      } catch (error) { if (intent === pdfSourceIntent) say(`无法打开历史版本：${error.message}`, true); return false; }
    }
    async function showCurrentPdf() {
      const intent = ++pdfSourceIntent;
      if (!project || switching || compiling || !await savedBeforeLeaving(true) || intent !== pdfSourceIntent) return false;
      const id = project.id, ticket = generation;
      resetPdfSource({ kind: 'current' });
      const sourceEpoch = pdfSourceEpoch;
      setPreviewMessage('读取当前编译稿…'); if (layout === 'source') setLayout('split'); setTab('pdf');
      if (project.pdf_present || lastBuildOk) await loadLayout(); else { setPreviewMessage('还没有 PDF；点「编译」生成。'); return false; }
      return ticket === generation && id === project?.id && sourceEpoch === pdfSourceEpoch && pageCount > 0;
    }
    function imageUrl(result) {
      const bytes = Uint8Array.from(atob(result.image), char => char.charCodeAt(0));
      return { url: URL.createObjectURL(new Blob([bytes], { type: 'image/png' })), bytes: bytes.length + result.pixel_width * result.pixel_height * 4, width: result.pixel_width, height: result.pixel_height, words: result.words || [], annotations: result.annotations || [] };
    }
    function previewWidth(element, factor = 1) {
      const width = element.clientWidth || right.clientWidth || 600;
      return Math.max(80, width - 24) * factor;
    }
    function density(width, geometry) {
      // Round upwards into small buckets: repeated splitter movements reuse pages
      // without ever requesting fewer pixels than the display needs.
      return Math.ceil(width * (window.devicePixelRatio || 1) / geometry.width * 8) / 8;
    }
    function pdfMetrics(width) {
      let top = 0;
      return pageGeometry.map(geometry => {
        const height = width * geometry.height / geometry.width;
        const metric = { top, height }; top += height + 16; return metric;
      });
    }
    function pdfPageAt(metrics, point) {
      let low = 0, high = metrics.length - 1;
      while (low < high) { const mid = Math.floor((low + high + 1) / 2); if (metrics[mid].top <= point) low = mid; else high = mid - 1; }
      return low + 1;
    }
    function pdfNearby(metrics, wanted, scroll) {
      const top = scroll ? metrics[wanted - 1].top : (preview.scrollTop || 0);
      const first = pdfPageAt(metrics, top), ahead = pdfPageAt(metrics, top + (preview.clientHeight || 600) * 2);
      let start = Math.max(1, wanted - 1);
      // Prepare the approaching page a viewport before it enters. Keep the
      // visible leading page and at most three raster/selection layers.
      if (ahead > start + 2) start = Math.min(wanted, first, ahead - 2);
      return Array.from({ length: Math.min(3, pageCount - start + 1) }, (_, index) => start + index);
    }
    async function renderPage(number, { scroll = true } = {}) {
      if (!project || !pageCount) return;
      page = Math.min(Math.max(1, number), pageCount);
      const wanted = page, id = project.id, epoch = generation, source = pdfSource, sourceEpoch = pdfSourceEpoch;
      const geometry = pageGeometry[wanted - 1];
      if (!geometry) return;
      const width = previewWidth(preview, zoom);
      const metrics = pdfMetrics(width), metric = metrics[wanted - 1];
      const previousScroll = preview.scrollTop || 0;
      pageLabel.textContent = `第 ${wanted} / ${pageCount} 页`;
      updateSyncHint();
      pagePrev.disabled = page <= 1; pageNext.disabled = page >= pageCount;
      const nearby = pdfNearby(metrics, wanted, scroll);
      const sourceKey = source.kind === 'version' ? `version:${source.versionId}:${source.reviewPdfVersion || ''}` : 'current';
      const keys = new Map(nearby.map(value => [value, `${id}:${sourceKey}:${value}:${pdfVersion}:${density(width, pageGeometry[value - 1])}`]));
      const windowKey = `${width}:${[...keys.values()].join('|')}`;
      const existing = new Map(Array.from(preview.querySelectorAll('.latex-page-stage'), stage => [Number(stage.dataset.page), stage]));
      if (windowKey === pdfWindowKey && (existing.get(wanted)?.querySelector('img') || existing.get(wanted)?.dataset.renderState === 'loading')) {
        if (scroll) preview.scrollTop = metric.top;
        return;
      }
      const ticket = ++pageRequest;
      pageAbort?.abort(); pageAbort = new AbortController();
      pdfWindowKey = windowKey;
      for (const [key, value] of rendered) if (![...keys.values()].includes(key)) { URL.revokeObjectURL(value.url); rendered.delete(key); }
      preview.textContent = '';
      const before = make('div', 'latex-page-spacer'); before.style.height = `${metrics[nearby[0] - 1].top}px`; before.style.flex = '0 0 auto'; before.setAttribute('aria-hidden', 'true');
      const after = make('div', 'latex-page-spacer');
      const last = metrics[metrics.length - 1];
      const final = metrics[nearby[nearby.length - 1] - 1];
      after.style.height = `${Math.max(0, last.top + last.height - final.top - final.height)}px`; after.style.flex = '0 0 auto'; after.setAttribute('aria-hidden', 'true');
      const stages = new Map(); preview.append(before);
      for (const number of nearby) {
        const item = metrics[number - 1], old = existing.get(number);
        const stage = old?.dataset.renderKey === keys.get(number) && rendered.has(keys.get(number)) ? old : make('div', 'latex-page-stage');
        stage.style.width = `${width}px`; stage.style.height = `${item.height}px`;
        stage.dataset.page = String(number); stage.dataset.renderKey = keys.get(number); stages.set(number, stage); preview.append(stage);
        if (number !== nearby[nearby.length - 1]) { const gap = make('div', 'latex-page-spacer'); gap.style.height = '16px'; gap.style.flex = '0 0 auto'; preview.append(gap); }
      }
      preview.append(after);
      preview.scrollTop = scroll ? metric.top : previousScroll;
      renderState.textContent = '高清页加载中…'; preview.setAttribute('aria-busy', 'true');
      const valid = () => ticket === pageRequest && epoch === generation && sourceEpoch === pdfSourceEpoch && !disposed;
      const load = async number => {
        const stage = stages.get(number), key = keys.get(number), pageInfo = pageGeometry[number - 1], pageScale = density(width, pageInfo);
        try {
          if (stage.querySelector('img')) return;
          stage.dataset.renderState = 'loading';
          let image = rendered.get(key);
          if (!image) {
            const result = source.kind === 'version'
              ? await api('latex_version_pdf_page', { version_id: source.versionId, ...(source.reviewPdfVersion ? { review_pdf_version: source.reviewPdfVersion } : {}), page: number, scale: pageScale }, { signal: pageAbort.signal })
              : await api('latex_pdf_page', { id, page: number, scale: pageScale }, { signal: pageAbort.signal });
            if (!valid()) return;
            image = imageUrl(result);
            let bytes = [...rendered.values()].reduce((sum, item) => sum + item.bytes, 0);
            if (number === wanted) for (const [oldKey, old] of rendered) {
              if (bytes + image.bytes <= MAX_CACHED_BYTES && rendered.size < MAX_RENDERED_PAGES) break;
              URL.revokeObjectURL(old.url); rendered.delete(oldKey); bytes -= old.bytes;
            }
            if (number !== wanted && (rendered.size >= MAX_RENDERED_PAGES || bytes + image.bytes > MAX_CACHED_BYTES)) { URL.revokeObjectURL(image.url); stage.dataset.renderState = 'idle'; return; }
            rendered.set(key, image);
          }
          if (!valid()) return;
          const img = document.createElement('img'); img.className = 'latex-page'; img.alt = `第 ${number} 页`; img.src = image.url;
          img.dataset.scale = String(pageScale); img.dataset.page = String(number);
          img.title = '双击跳转到对应的源码位置（SyncTeX）';
          stage.append(img); stage.rasterAnnotationIds = new Set(image.annotations.map(annotation => annotation.id));
          patchPdfPageAnnotations(stage, reviewer?.annotations?.() || []);
          installReviewLayer(stage, img, image.words, pageInfo, number, width);
          stage.dataset.renderState = 'ready';
          stage.addEventListener('dblclick', event => { if (pdfTool === 'select') void jumpToSource(event, img); });
          if (number === wanted) renderState.textContent = `${image.width} × ${image.height}`;
        } catch (error) {
          if (!valid() || error.name === 'AbortError') return;
          stage.dataset.renderState = 'failed';
          stage.append(make('p', 'latex-preview-empty', `预览失败：${error.message}`));
          const retry = make('button', 'button subtle', '重试此页'); retry.type = 'button'; retry.addEventListener('click', () => void renderPage(number, { scroll: false })); stage.append(retry);
          if (number === wanted) renderState.textContent = '加载失败';
        }
      };
      const priority = [...nearby.filter(number => number > wanted), ...nearby.filter(number => number < wanted).reverse()];
      const currentLoad = load(wanted), adjacentLoad = priority.length ? load(priority.shift()) : Promise.resolve();
      await currentLoad;
      if (valid()) preview.setAttribute('aria-busy', 'false');
      void (async () => { await adjacentLoad; for (const number of priority) if (valid()) await load(number); })();
    }

    function patchPdfPageAnnotations(stage, notes) {
      if (pdfSource.kind !== 'current') return;
      const number = Number(stage.dataset.page), geometry = pageGeometry[number - 1];
      if (!geometry) return;
      let overlay = stage.savedMarks;
      if (!overlay) {
        overlay = make('div', 'latex-saved-marks'); overlay.setAttribute('aria-hidden', 'true');
        Object.assign(overlay.style, { position: 'absolute', inset: '0', pointerEvents: 'none' });
        stage.savedMarks = overlay; stage.append(overlay);
      }
      overlay.textContent = '';
      for (const note of notes) {
        if (note.anchor?.kind !== 'pdf' || note.anchor.page !== number || note.anchor.pdf_version !== pdfBuild?.pdf_version || stage.rasterAnnotationIds?.has(note.id.split(':').at(-1))) continue;
        for (const rect of note.anchor.rects || []) {
          const [x0, y0, x1, y1] = rect;
          const mark = make('span', `latex-saved-mark latex-saved-${note.type}`); mark.dataset.note = note.id;
          Object.assign(mark.style, { position: 'absolute', left: `${x0 / geometry.width * 100}%`, top: `${y0 / geometry.height * 100}%`, width: `${(x1 - x0) / geometry.width * 100}%`, height: `${(y1 - y0) / geometry.height * 100}%`, boxSizing: 'border-box' });
          if (note.type === 'highlight') mark.style.background = 'rgba(255, 210, 64, .36)';
          else if (note.type === 'underline') mark.style.borderBottom = '2px solid #d59800';
          else if (note.type === 'strikeout') mark.style.background = 'linear-gradient(transparent 45%, #d59800 45%, #d59800 55%, transparent 55%)';
          else { mark.style.border = '1px solid #d59800'; mark.style.background = 'rgba(255, 210, 64, .12)'; }
          overlay.append(mark);
        }
      }
    }
    function patchPdfAnnotations(notes) { for (const stage of preview.querySelectorAll('.latex-page-stage')) patchPdfPageAnnotations(stage, notes); }

    function installReviewLayer(stage, img, words, geometry, wanted, width) {
      if (!reviewer) return;
      const layer = make('div', 'latex-text-layer'); layer.setAttribute('aria-label', 'PDF 正文选区');
      for (const word of words) {
        if (!Array.isArray(word) || word.length < 5) continue;
        const [x0, y0, x1, y1, text] = word;
        const span = make('span', 'latex-pdf-word'); span.dataset.rect = JSON.stringify(word.slice(0, 4));
        const run = make('i', 'latex-word-text', text); span.append(run);
        Object.assign(span.style, { left: `${x0 / geometry.width * 100}%`, top: `${y0 / geometry.height * 100}%`, width: `${(x1 - x0) / geometry.width * 100}%`, height: `${(y1 - y0) / geometry.height * 100}%`, fontSize: `${(y1 - y0) * width / geometry.width}px` });
        layer.append(span);
      }
      stage.append(layer);
      for (const span of layer.querySelectorAll('.latex-pdf-word')) {
        try {
          const run = span.firstChild, range = document.createRange(); range.selectNodeContents(run);
          const measured = range.getBoundingClientRect().width;
          if (measured > 0) run.style.transform = `scaleX(${span.getBoundingClientRect().width / measured})`;
        } catch { /* Preserve selection if a font measurement is not available yet. */ }
      }
      let drag = null;
      const point = event => { const rect = img.getBoundingClientRect(); return [Math.max(0, Math.min(geometry.width, (event.clientX - rect.left) / rect.width * geometry.width)), Math.max(0, Math.min(geometry.height, (event.clientY - rect.top) / rect.height * geometry.height))]; };
      layer.addEventListener('pointerdown', event => {
        if (pdfTool !== 'note' || event.button !== 0) return;
        event.preventDefault(); drag = point(event); layer.setPointerCapture(event.pointerId);
      });
      layer.addEventListener('pointerup', event => {
        if (pdfTool === 'note' && drag) {
          const end = point(event), start = drag; drag = null;
          const rect = [Math.min(start[0], end[0]), Math.min(start[1], end[1]), Math.max(start[0], end[0]), Math.max(start[1], end[1])];
          if (rect[2] - rect[0] < 2) rect[2] = Math.min(geometry.width, rect[0] + 16);
          if (rect[3] - rect[1] < 2) rect[3] = Math.min(geometry.height, rect[1] + 16);
          reviewer.beginPdf({ kind: 'pdf', page: wanted, pdf_version: pdfBuild?.pdf_version, rects: [rect], text: '' }, 'note'); return;
        }
        if (!['highlight', 'underline', 'strikeout', 'comment'].includes(pdfTool)) return;
        const tool = pdfTool;
        setTimeout(() => {
          const selection = window.getSelection(); if (!selection?.rangeCount || selection.isCollapsed) return;
          const range = selection.getRangeAt(0), bounds = img.getBoundingClientRect(), pieces = [];
          try {
            if (!layer.contains(range.startContainer) || !layer.contains(range.endContainer)) { say('一次选文批注限于同一页，请在单页内重新选择。', true); return; }
            for (const span of layer.querySelectorAll('.latex-pdf-word')) {
              const run = span.firstChild; if (!range.intersectsNode(run)) continue;
              const part = document.createRange(); part.selectNodeContents(run);
              if (range.compareBoundaryPoints(Range.START_TO_START, part) > 0) part.setStart(range.startContainer, range.startOffset);
              if (range.compareBoundaryPoints(Range.END_TO_END, part) < 0) part.setEnd(range.endContainer, range.endOffset);
              const text = part.toString(); if (!text) continue;
              const rect = part.getBoundingClientRect(), box = JSON.parse(span.dataset.rect);
              pieces.push([Math.max(box[0], (rect.left - bounds.left) / bounds.width * geometry.width), box[1], Math.min(box[2], (rect.right - bounds.left) / bounds.width * geometry.width), box[3], text]);
            }
            const value = window.PaperPDFReader?.mergeSelection(pieces, wanted);
            if (value?.rects.length) reviewer.beginPdf({ kind: 'pdf', page: wanted, pdf_version: pdfBuild?.pdf_version, rects: value.rects, text: value.text }, tool === 'comment' ? 'note' : tool, { instant: tool !== 'comment' });
          } catch (error) { say(`选区无法批注：${error.message}`, true); }
        }, 0);
      });
      layer.addEventListener('pointercancel', () => { drag = null; });
    }

    function requestResize() {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (!view.hidden && tab === 'pdf' && pageCount) void renderPage(page, { scroll: false });
        if (!view.hidden && tab === 'media' && mediaPath && mediaGeometry) void openMedia(mediaPath, { page: mediaPage, refresh: true });
      }, 180);
    }
    const resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(requestResize) : null;
    resizeObserver?.observe(right);
    window.addEventListener('resize', requestResize);
    zoomSelect.addEventListener('change', () => { zoom = Number(zoomSelect.value); void renderPage(page); });
    preview.addEventListener('scroll', () => {
      if (!pageCount || !project || tab !== 'pdf') return;
      const metrics = pdfMetrics(previewWidth(preview, zoom));
      const next = pdfPageAt(metrics, Math.max(0, (preview.scrollTop || 0) + (preview.clientHeight || 0) * .35));
      void renderPage(next, { scroll: false });
    }, { passive: true });

    let mediaUrl = null;
    async function openMedia(path, { page: wanted = 1, refresh = false } = {}) {
      if (!project) return;
      if (!refresh && layout === 'source') setLayout('split');
      if (!refresh && path !== mediaPath) { mediaZoom = 1; mediaGeometry = null; }
      if (wanted !== mediaPage) mediaGeometry = null;
      mediaPath = path; mediaPage = wanted; setTab('media'); setNav('media');
      mediaPrev.disabled = true; mediaNext.disabled = true;
      mediaAbort?.abort(); mediaAbort = new AbortController();
      const id = project.id, epoch = generation, ticket = ++mediaRequest;
      mediaCrumb.textContent = path; mediaInfo.textContent = '媒体加载中…'; mediaPreview.textContent = '';
      mediaPreview.setAttribute('aria-busy', 'true');
      if (mediaUrl) { URL.revokeObjectURL(mediaUrl); mediaUrl = null; }
      try {
        // First request discovers geometry at a modest density. Immediately
        // replace it at the exact display density when a larger render is needed.
        let scale = mediaGeometry ? density(Math.min(previewWidth(mediaPreview), mediaGeometry.width) * mediaZoom, mediaGeometry) : 1;
        let result = await api('latex_media_preview', { id, path, page: wanted, scale }, { signal: mediaAbort.signal });
        if (ticket !== mediaRequest || epoch !== generation || disposed) return;
        if (!result.supported) { mediaInfo.textContent = `${result.bytes} 字节`; mediaPreview.textContent = result.reason; return; }
        mediaGeometry = { width: result.width, height: result.height }; mediaCount = result.page_count;
        const width = Math.min(previewWidth(mediaPreview), result.width) * mediaZoom;
        const target = density(width, mediaGeometry);
        if (target > scale + 0.01) {
          result = await api('latex_media_preview', { id, path, page: wanted, scale: target }, { signal: mediaAbort.signal });
          if (ticket !== mediaRequest || epoch !== generation || disposed) return;
        }
        const image = imageUrl(result); mediaUrl = image.url;
        const img = make('img', 'latex-media-image'); img.alt = path; img.src = image.url; img.style.width = `${width}px`;
        mediaPreview.append(img);
        mediaInfo.textContent = `${Math.round(result.source_width || result.width)} × ${Math.round(result.source_height || result.height)} · ${Math.round(result.bytes / 1024)} KiB · 第 ${wanted}/${mediaCount} 页 · ${Math.round(mediaZoom * 100)}%`;
        mediaPrev.disabled = wanted <= 1; mediaNext.disabled = wanted >= mediaCount;
      } catch (error) {
        if (ticket !== mediaRequest || epoch !== generation || error.name === 'AbortError') return;
        mediaInfo.textContent = '媒体加载失败'; mediaPreview.textContent = error.message;
        const retry = make('button', 'button subtle', '重试媒体'); retry.type = 'button'; retry.addEventListener('click', () => void openMedia(path, { page: wanted, refresh: true })); mediaPreview.append(retry);
      } finally { if (ticket === mediaRequest) mediaPreview.setAttribute('aria-busy', 'false'); }
    }
    mediaPrev.addEventListener('click', () => { if (mediaPage > 1) void openMedia(mediaPath, { page: mediaPage - 1, refresh: true }); });
    mediaNext.addEventListener('click', () => { if (mediaPage < mediaCount) void openMedia(mediaPath, { page: mediaPage + 1, refresh: true }); });
    mediaFit.addEventListener('click', () => { mediaZoom = 1; if (mediaPath) void openMedia(mediaPath, { page: mediaPage, refresh: true }); });
    mediaPlus.addEventListener('click', () => { mediaZoom = Math.min(4, mediaZoom * 1.25); if (mediaPath) void openMedia(mediaPath, { page: mediaPage, refresh: true }); });
    mediaMinus.addEventListener('click', () => { mediaZoom = Math.max(0.25, mediaZoom / 1.25); if (mediaPath) void openMedia(mediaPath, { page: mediaPage, refresh: true }); });

    pagePrev.addEventListener('click', () => void renderPage(page - 1));
    pageNext.addEventListener('click', () => void renderPage(page + 1));

    // ---- SyncTeX: source and PDF jump to each other ------------------------------
    // Coordinates are displayed PDF points with a top-left origin on both ends; the
    // img's bounding box converts between bitmap pixels and those points. Rotated
    // pages are refused because SyncTeX counts in the unrotated frame.
    async function gotoSource(path, line) {
      if ((path !== file || editor.disabled) && !await openFile(path)) return;
      if (layout === 'pdf') setLayout('split');
      const lines = editor.value.split('\n');
      const target = Math.min(Math.max(1, line), lines.length);
      let offset = 0;
      for (let index = 0; index < target - 1; index += 1) offset += lines[index].length + 1;
      editor.focus();
      editor.setSelectionRange(offset, offset + lines[target - 1].length);
      if (!sourceEditor) {
        const lineHeight = parseFloat(getComputedStyle(editor).lineHeight) || 21;
        editor.scrollTop = Math.max(0, (target - 1) * lineHeight - editor.clientHeight / 3);
        gutter.scrollTop = editor.scrollTop;
      }
      say(`已跳到 ${path}:${target}`);
    }

    async function jumpToSource(event, img) {
      if (!project) return;
      if (pdfSource.kind !== 'current') { say('历史版本为只读预览，不能定位当前源码。', true); return; }
      if (dirty || saving) { say('源码有未保存修改；请先保存并编译，双击不会覆盖你的编辑。', true); return; }
      const targetPage = Number(img.dataset.page) || page;
      const geometry = pageGeometry[targetPage - 1];
      if (!geometry) return;
      if (geometry.rotation) { say('这一页带旋转，SyncTeX 坐标对不上，暂不支持跳转。', true); return; }
      const rect = img.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const x = ((event.clientX - rect.left) / rect.width) * geometry.width;
      const y = ((event.clientY - rect.top) / rect.height) * geometry.height;
      try {
        const ticket = generation;
        const result = await api('latex_synctex_edit', { id: project.id, page: targetPage, x, y, pdf_version: pdfBuild?.pdf_version });
        if (ticket !== generation || !await openFile(result.path, { force: true })) return;
        if (result.source_revision && revision !== result.source_revision) { say('目标源码已变化；定位暂停，请重新编译。', true); return; }
        await gotoSource(result.path, result.line);
      } catch (error) {
        say(`SyncTeX 跳转：${error.message}`, true);
      }
    }

    async function highlightPdf(result) {
      const geometry = pageGeometry[result.page - 1];
      const img = preview.querySelector(`img.latex-page[data-page="${result.page}"]`);
      if (!geometry || !img) return;
      if (geometry.rotation || result.rotation) { say('目标页带旋转，无法标注位置。', true); return; }
      try { await img.decode(); } catch { /* a cached data URL is already decoded */ }
      const rect = img.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const stage = img.parentElement;
      const stale = stage.querySelector('.latex-sync-highlight');
      if (stale) stale.remove();
      const kx = rect.width / geometry.width, ky = rect.height / geometry.height;
      const marker = make('div', 'latex-sync-highlight');
      const left = (result.h ?? result.x ?? 0) * kx;
      const top = Math.max(0, ((result.v ?? result.y ?? 0) - (result.H ?? 0)) * ky);
      marker.style.left = `${left}px`;
      marker.style.top = `${top}px`;
      marker.style.width = `${Math.max(24, (result.W ?? 24) * kx)}px`;
      marker.style.height = `${Math.max(14, (result.H ?? 8) * ky + 6)}px`;
      stage.append(marker);
      marker.scrollIntoView({ block: 'center', behavior: 'smooth' });
      clearTimeout(syncFlash);
      syncFlash = setTimeout(() => marker.remove(), 2600);
    }

    async function jumpToPdf() {
      if (!project || !file) { say('先在左侧打开一个源文件。', true); return; }
      if (pdfSource.kind !== 'current') { say('历史版本为只读预览，请先返回当前编译稿。', true); return; }
      if (!pageCount) { say('还没有 PDF；先编译一次。', true); return; }
      if (dirty || saving) { say('请先保存并编译当前源码，再定位 PDF。', true); return; }
      const line = editor.value.slice(0, editor.selectionStart).split('\n').length;
      try {
        const result = await api('latex_synctex_view', { id: project.id, path: file, line });
        if (layout === 'source') setLayout('split');
        setTab('pdf');
        if (result.page !== page) await renderPage(result.page);
        await highlightPdf(result);
        say(`${file}:${line} → 第 ${result.page} 页`);
      } catch (error) {
        say(`SyncTeX 跳转：${error.message}`, true);
      }
    }
    toPdf.addEventListener('click', () => void jumpToPdf());

    // ---- compiling ----------------------------------------------------------------
    function setDiagnosticsOpen(open) {
      errors.hidden = !open;
      diagnosticsToggle.setAttribute('aria-expanded', String(open));
    }
    diagnosticsToggle.addEventListener('click', () => setDiagnosticsOpen(errors.hidden));

    // Only make a location actionable if the compiler path resolves exactly to a
    // text file in the current project tree. Unknown or external paths remain text.
    function diagnosticLocation(line) {
      const match = /^(.+):(\d+):\s/.exec(line);
      if (!match) return null;
      let path = match[1];
      const root = (tree?.root || '').replace(/\/$/, '');
      if (root && path.startsWith(`${root}/`)) path = path.slice(root.length + 1);
      while (path.startsWith('./')) path = path.slice(2);
      if (!path || path.startsWith('/') || path.split('/').some(part => part === '..' || part === '.')) return null;
      if (!(tree?.files || []).some(item => item.kind === 'text' && item.path === path)) return null;
      const targetLine = Number(match[2]);
      return Number.isSafeInteger(targetLine) && targetLine > 0 ? { path, line: targetLine } : null;
    }

    function renderDiagnostics(result) {
      errors.textContent = '';
      const lines = Array.isArray(result.errors) ? result.errors : [];
      for (const line of lines) {
        const row = make('li', 'latex-diagnostic');
        const location = diagnosticLocation(line);
        if (location) {
          const button = make('button', 'latex-diagnostic-link', line); button.type = 'button';
          button.title = `定位 ${location.path}:${location.line}`;
          button.addEventListener('click', () => void gotoSource(location.path, location.line));
          row.append(button);
        } else row.textContent = line;
        errors.append(row);
      }
      for (const warning of result.warnings || []) errors.append(make('li', 'latex-diagnostic-warning', warning));
      if (!result.ok && !lines.length) errors.append(make('li', '', '未识别到可定位的错误；请查看下面的编译日志。'));
      if (result.log_tail) {
        const row = make('li', 'latex-log-row');
        const details = make('details', 'latex-log');
        details.append(make('summary', '', '查看 latexmk 输出尾部'), make('pre', '', result.log_tail));
        row.append(details); errors.append(row);
      }
      diagnosticsToggle.hidden = false;
      diagnosticsToggle.textContent = result.ok ? `编译成功${lines.length ? ` · ${lines.length} 条错误` : ''}` : `编译失败 · ${lines.length} 条错误`;
      setDiagnosticsOpen(!result.ok);
    }

    function scheduleCompile() {
      clearTimeout(compileTimer);
      if (settings.latex_auto_compile === false || autoPaused || lastBuildOk !== true || !project) return;
      compileTimer = setTimeout(() => { void compileOnce('auto'); }, AUTOCOMPILE_MS);
    }

    async function compileOnce(reason = 'manual') {
      if (!project || switching || compiling) { if (compiling) pendingCompile = true; return; }
      // A new setting may be queued while an earlier save is in flight.
      // Wait until the observed tail is still current before using the engine.
      let observedTail;
      do { observedTail = settingsTail; await observedTail; } while (observedTail !== settingsTail);
      if (pendingSettings.some(entry => entry.failed && Object.hasOwn(entry.patch, 'latex_engine'))) {
        say('编译引擎设置尚未保存；请先在写作设置中重试。', true); return;
      }
      const engine = committedSettings.latex_engine || 'xelatex';
      if (!project || switching || compiling) { if (compiling) pendingCompile = true; return; }
      if (!await savedBeforeLeaving(true)) return;
      if (!project || switching || compiling) { if (compiling) pendingCompile = true; return; }
      compiling = true; compile.disabled = true; compile.textContent = '编译中…';
      errors.textContent = ''; diagnosticsToggle.hidden = true; setDiagnosticsOpen(false); buildInfo.textContent = reason === 'auto' ? '自动编译中…' : '';
      if (reason === 'manual') say(`正在用 latexmk 编译 ${project.main_path || '主文件'}…`);
      const target = { id: project.id, main: project.main_path, generation };
      try {
        const result = await api('latex_compile', { id: target.id, engine, timeout_seconds: 120, ...(reason === 'manual' ? { save_version: true } : {}) });
        if (target.id !== project?.id || target.main !== project.main_path || target.generation !== generation) { if (result.version) void onVersionSaved(result.version); return; }
        buildInfo.dataset.build = String(Date.now());
        buildInfo.textContent = `${result.engine} · ${(result.duration_ms / 1000).toFixed(1)}s · ${result.pages ?? '—'} 页`;
        diagnosticsToggle.title = buildInfo.textContent;
        renderDiagnostics(result);
        lastBuildOk = result.ok;
        if (result.ok) {
          autoPaused = false;
          say(`编译完成：${result.pdf_path}（${result.pages} 页，${result.duration_ms} 毫秒${reason === 'auto' ? '，自动' : ''}）`);
          if (pdfSource.kind === 'current' || reason === 'manual') {
            if (pdfSource.kind !== 'current') resetPdfSource({ kind: 'current' });
            else clearRendered();
            await loadLayout();
          }
          if (result.version) { project.reading_project_id = result.version.reading_project_id; void versions?.refresh(); void onVersionSaved(result.version); }
          if (result.version_error) say(`${result.version_error}。原文件与批注保留。`, true);
        } else {
          autoPaused = reason === 'auto';
          say(result.timed_out ? '编译超时，已停止。' : `编译失败（退出码 ${result.exit_code}）。请看错误与日志尾。${autoPaused ? ' 自动编译已暂停，手动编译成功后会恢复。' : ''}`, true);
        }
      } catch (error) {
        lastBuildOk = false;
        autoPaused = reason === 'auto';
        renderDiagnostics({ ok: false, errors: [String(error.message || error)] });
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
        await refreshProjects(created.project.id);
        await selectProject(created.project.id);
        say(created.existing ? `这个项目已经在库里：${created.project.root}` : `已新建 ${created.dir}${created.sync?.changed ? '，并加入数据同步服务' : ''}`);
        if (created.sync && created.sync.changed === false && created.sync.reason) say(`项目已创建；未加入同步：${created.sync.reason}`, true);
      } catch (error) {
        say(`新建失败：${error.message}`, true);
      } finally { createRun.disabled = false; }
    });
    newPick.addEventListener('click', async () => {
      newPick.disabled = true;
      try {
        const picked = await api('latex_ws_pick_folder', {});
        if (picked.cancelled) say('没有选择文件夹。');
        else { newRoot.value = picked.path; newRoot.focus(); }
      } catch (error) {
        say(`无法打开文件夹选择对话框：${error.message}`, true);
      } finally { newPick.disabled = false; }
    });
    newSubmit.addEventListener('click', async () => {
      const root = newRoot.value.trim();
      if (!root) { say('请填写项目文件夹的绝对路径。', true); return; }
      try {
        const created = await api('latex_project_create', { root, ...(newTitle.value.trim() ? { title: newTitle.value.trim() } : {}), create_missing: newStarter.checked });
        newRoot.value = ''; newTitle.value = ''; closeMenu();
        await refreshProjects(created.project.id);
        await selectProject(created.project.id);
        say(`已登记 ${created.project.root}`);
      } catch (error) {
        say(`登记失败：${error.message}`, true);
      }
    });
    settingStarter.addEventListener('change', () => void saveSetting({ latex_starter: settingStarter.checked }));
    settingEngine.addEventListener('change', () => void saveSetting({ latex_engine: settingEngine.value }));
    settingTheme.addEventListener('change', () => void saveSetting({ latex_theme: settingTheme.value }));
    settingPathFont.addEventListener('change', () => void saveSetting({ latex_path_font: settingPathFont.value }));
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
        const providers = new Map();
        ai.models.forEach((model, index) => {
          if (!providers.has(model.provider)) { const group = make('optgroup'); group.label = model.provider; providers.set(model.provider, group); aiModel.append(group); }
          const option = make('option', '', model.name || model.id);
          option.value = String(index); providers.get(model.provider).append(option);
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
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && !event.altKey && ['i', 't'].includes(event.key.toLowerCase()) && !writingContext().blocked) {
        event.preventDefault(); event.key.toLowerCase() === 'i' ? writingTools?.figure({ templateOnly: true }) : writingTools?.table();
      }
      if (event.key === 'Escape') closeSourceTools();
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
        const wanted = preferred && projects.some(item => item.id === preferred) ? preferred : project?.id && projects.some(item => item.id === project.id) ? project.id : projects[0]?.id;
        if (wanted) await selectProject(wanted);
        else await renderEmpty();
      } catch (error) {
        say(`无法读取项目列表：${error.message}`, true);
      }
    }

    async function close() {
      clearTimeout(timer); clearTimeout(compileTimer); closeMenu();
      if (!await savedBeforeLeaving(true)) return;
      cancelReads();
      showRail(false);
      view.hidden = true;
      document.body.classList.remove('latex-focused');
    }

    /** The collaboration lives in the reading rail when there is one (same type as 批注). */
    if (rail?.registerPanel) {
      try { rail.registerPanel({ id: 'latex-ai', label: 'DSH 写作', element: aiSection }); if (reviewer) rail.registerPanel({ id: 'latex-review', label: '自审', element: reviewPanel }); }
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
    const protectDraft = event => { if (dirty || saving || pendingConflict || reviewer?.hasDraft() || writingTools?.hasDraft()) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', protectDraft);
    applySettings(DEFAULT_SETTINGS, null);
    setNav('outline');
    setTab('pdf');
    lineNumbers();
    void renderEmpty();

    return {
      open, close, showVersion, showCurrentPdf,
      isOpen: () => !view.hidden,
      refresh: () => open(project?.id),
      /** Used by the acceptance fixture to drive the surface without a real keyboard. */
      testHooks: {
        setProject: id => selectProject(id),
        type: text => { editor.value = text; dirty = true; lineNumbers(); setSaveState('未保存', 'dirty'); return flush('manual'); },
        flush: () => flush('manual'),
        openFile,
        openMedia,
        renderPage,
        loadOutline,
        reviewer: () => reviewer,
        compile: reason => compileOnce(reason || 'manual'),
        setTab,
        showRail,
        railVisible: () => Boolean(rail?.visible?.('latex-ai')),
        setSplit: (percent, persist) => setSplit(percent, { persist: persist === true }),
        create: (name, starter) => api('latex_ws_create', { name, starter }),
        attachSync: () => api('latex_ws_sync_attach'),
        status: () => refreshWorkspace(),
        state: () => ({
          project: project?.id || null, file, revision, dirty, pageCount, page, tab, pdfSource: { ...pdfSource }, split: settings.latex_split, rail: Boolean(rail), railOpen: Boolean(rail?.visible?.('latex-ai')),
          auto: settings.latex_auto_compile !== false, autoPaused, lastBuildOk, root: workspace.root,
          syncCovered: Boolean(workspace.sync?.covered), conflict: Boolean(pendingConflict),
          ai: { available: ai.available, proposal: ai.proposal?.id || null },
        }),
      },
      dispose() { disposed = true; reviewer?.dispose(); writingTools?.dispose(); formulas?.destroy(); sourceEditor?.destroy(); cancelReads(); clearRendered(); if (mediaUrl) URL.revokeObjectURL(mediaUrl); resizeObserver?.disconnect(); window.removeEventListener('resize', requestResize); window.removeEventListener('beforeunload', protectDraft); clearTimeout(timer); clearTimeout(compileTimer); view.hidden = true; document.body.classList.remove('latex-focused'); },
    };
  }
  return { create };
})();
