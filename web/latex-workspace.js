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
  const MAX_PREFETCH_DISPLAY_BYTES = 48 * 1024 * 1024;
  const PDF_PAGE_GAP = 16, PDF_PREVIEW_PADDING = 12;
  const MAX_PDF_SEARCH_HITS = 120;
  const SPLIT_MIN = 25, SPLIT_MAX = 75;
  const DEFAULT_SETTINGS = { latex_starter: true, latex_auto_compile: true, latex_engine: 'xelatex', latex_theme: 'system', latex_path_font: 'pixel', latex_accent: 'system', latex_split: 50, latex_sync_folder: true };

  function create({api: transport, toast = () => {}, getLibrary = () => '', rail = null, onVersionSaved = () => {}, onContext = () => {}, onSettingsClose = () => {}}) {
    const make = (tag, cls, text) => { const node = document.createElement(tag); if (cls) node.className = cls; if (text !== undefined) node.textContent = text; return node; };
    let projects = [], project = null, tree = null, file = null, revision = null, pageCount = 0, page = 1, tab = 'pdf';
    // Bind project actions to the location this window opened. A different
    // window may have changed it since this editor loaded its source.
    const api = (action, args = {}, options) => {
      const scoped = action.startsWith('latex_') && !action.startsWith('latex_ws_') && args.id && args.id === project?.id;
      if (!scoped) return transport(action, args, options);
      const expected = {};
      if (project.root && !Object.hasOwn(args, 'expected_root')) expected.expected_root = project.root;
      if (Number.isSafeInteger(project.binding_generation) && !Object.hasOwn(args, 'expected_binding_generation')) expected.expected_binding_generation = project.binding_generation;
      return transport(action, { ...expected, ...args }, options);
    };
    let pageGeometry = []; let syncFlash = null;
    let dirty = false, saving = false, compiling = false, disposed = false, timer = null, compileTimer = null, generation = 0, saveQueue = Promise.resolve();
    let lastBuildOk = null, autoPaused = false, pendingCompile = false;
    const rendered = new Map();
    const pdfLoads = new Map();
    let pdfWindowKey = '', pdfStages = new Map(), pdfPriority = new Set(), pdfScrollTop = 0, pdfScrollDirection = 1;
    let pendingConflict = null;
    let settings = { ...DEFAULT_SETTINGS };
    let settingsRevision = null;
    let committedSettings = { ...DEFAULT_SETTINGS }, pendingSettings = [], settingsTail = Promise.resolve();
    let workspace = { root: null, sync: null };
    let outline = null, navMode = 'outline', fileRequest = 0, navRequest = 0;
    let fileAbort = null, navAbort = null, mediaAbort = null, mediaRequest = 0;
    let pdfVersion = '', zoom = 1, mediaPath = null, mediaPage = 1, mediaZoom = 1, mediaCount = 0;
    let mediaGeometry = null, resizeTimer = null, outlineTimer = null;
    let switching = false, entryRequest = 0, openRequest = 0;
    let pdfBuild = null, pdfTool = 'select', pdfSelection = null, pdfSelectionTimer = null;
    let pdfSource = { kind: 'current' }, pdfSourceEpoch = 0, pdfSourceIntent = 0;
    let projectSearch = null;

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
    const currentContext = () => !view.hidden && project ? { kind: 'latex', id: project.id, title: project.title || '未命名 LaTeX 项目' } : null;
    const notifyContext = (closed = false) => { if (!disposed && (!view.hidden || closed)) onContext(currentContext()); };

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
    const autoToggle = make('button', 'button subtle paper-switch', '自动编译');
    autoToggle.id = 'latex-auto-state'; autoToggle.type = 'button';
    autoToggle.setAttribute('role', 'switch'); autoToggle.setAttribute('aria-label', '自动编译');
    const mainLabel = make('span', 'latex-main'); mainLabel.id = 'latex-main';
    const mainSelect = make('select'); mainSelect.id = 'latex-entry'; mainSelect.setAttribute('aria-label', '编译主文件');
    const saveState = make('span', 'latex-save-state'); saveState.id = 'latex-save-state'; saveState.setAttribute('role', 'status');
    const aiToggle = make('button', 'button subtle paper-switch', '批注与写作'); aiToggle.id = 'latex-ai-open'; aiToggle.type = 'button';
    aiToggle.setAttribute('role', 'switch'); aiToggle.setAttribute('aria-checked', 'false'); aiToggle.setAttribute('aria-controls', 'latex-writing-panel');
    const reviewToggle = make('button', 'button subtle', '自审'); reviewToggle.id = 'latex-review-open'; reviewToggle.type = 'button';
    reviewToggle.hidden = true; // Keep the old action addressable without a second toolbar entry.
    const reviewDivider = make('span', 'latex-toolbar-divider'); reviewDivider.setAttribute('role', 'separator'); reviewDivider.setAttribute('aria-orientation', 'vertical');
    const navToggle = make('button', 'button subtle paper-switch', '侧边导航'); navToggle.id = 'latex-nav-toggle'; navToggle.type = 'button';
    navToggle.setAttribute('aria-controls', 'latex-navigator'); navToggle.setAttribute('aria-expanded', 'true');
    const layoutControls = make('div', 'latex-layout-controls'); layoutControls.setAttribute('role', 'group'); layoutControls.setAttribute('aria-label', '工作区视图');
    const layoutButtons = new Map();
    for (const [mode, label] of [['split', '并排'], ['source', '仅源码'], ['pdf', '仅 PDF']]) {
      const button = make('button', 'button subtle latex-layout-button', label); button.type = 'button'; button.id = `latex-layout-${mode}`;
      button.setAttribute('aria-pressed', String(mode === 'split')); button.addEventListener('click', () => setLayout(mode));
      layoutButtons.set(mode, button); layoutControls.append(button);
    }
    aiToggle.title = '查看批注、向 DSH 提问或审阅修改提案';
    const menuButton = make('button', 'button subtle latex-menu-button', '⚙'); menuButton.id = 'latex-menu-open'; menuButton.type = 'button';
    menuButton.setAttribute('aria-expanded', 'false'); menuButton.setAttribute('aria-controls', 'latex-menu'); menuButton.setAttribute('aria-label', '设置'); menuButton.title = '设置';
    if (window.PaperIcons) { menuButton.textContent = ''; window.PaperIcons.decorate(menuButton, 'settings'); }
    toolbar.append(title, projectSelect, mainLabel, saveState, compile, autoToggle, diagnosticsToggle, navToggle, layoutControls, reviewDivider, reviewToggle, aiToggle);

    const menu = make('div', 'latex-menu'); menu.id = 'latex-menu'; menu.setAttribute('aria-label', '项目与设置'); menu.hidden = true;
    const navigationActions = make('div'); navigationActions.id = 'latex-navigation-actions'; menu.append(navigationActions);
    const entryRow = make('div', 'latex-menu-section');
    const entryLabel = make('label', 'latex-menu-label', '编译主文件'); entryLabel.htmlFor = 'latex-entry';
    entryRow.append(entryLabel, mainSelect);
    const locationRow = make('div', 'latex-menu-section');
    locationRow.append(make('span', 'latex-menu-label', '修改当前项目位置'));
    const locationRoot = make('input'); locationRoot.id = 'latex-location-root'; locationRoot.type = 'text'; locationRoot.placeholder = '项目文件夹的绝对路径'; locationRoot.autocomplete = 'off'; locationRoot.spellcheck = false; locationRoot.setAttribute('aria-label', '当前项目文件夹');
    const locationPick = make('button', 'button subtle', '选择…'); locationPick.id = 'latex-location-pick'; locationPick.type = 'button'; locationPick.title = '选择项目文件夹';
    const locationMain = make('input'); locationMain.id = 'latex-location-main'; locationMain.type = 'text'; locationMain.placeholder = '主文件路径，例如 review/main.tex'; locationMain.autocomplete = 'off'; locationMain.spellcheck = false; locationMain.setAttribute('aria-label', '当前项目主文件路径');
    const locationMainPick = make('button', 'button subtle', '选择主文件…'); locationMainPick.id = 'latex-location-main-pick'; locationMainPick.type = 'button';
    const locationSave = make('button', 'button primary', '保存项目位置'); locationSave.id = 'latex-location-save'; locationSave.type = 'button';
    const locationLine = make('div', 'latex-menu-row'); locationLine.append(locationRoot, locationPick, locationMain, locationMainPick, locationSave);
    locationRow.append(locationLine, make('p', 'latex-menu-hint', '主文件需位于项目文件夹内，可填绝对路径或相对路径；修改登记不会移动或覆盖文件。'));
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
    const newMain = make('input'); newMain.id = 'latex-new-main'; newMain.type = 'text'; newMain.placeholder = '主文件路径（可留空自动寻找）'; newMain.autocomplete = 'off'; newMain.spellcheck = false; newMain.setAttribute('aria-label', '登记项目主文件路径');
    const newMainPick = make('button', 'button subtle', '选择主文件…'); newMainPick.id = 'latex-new-main-pick'; newMainPick.type = 'button';
    const newStarter = make('input'); newStarter.id = 'latex-new-starter'; newStarter.type = 'checkbox';
    const starterLabel = make('label', 'latex-check'); starterLabel.append(newStarter, make('span', '', '没有 .tex 时写入最小 main.tex'));
    const newSubmit = make('button', 'button primary', '登记'); newSubmit.id = 'latex-new-submit'; newSubmit.type = 'button';
    // The browser cannot hand out absolute paths, so the host opens the OS dialog.
    const newPick = make('button', 'button subtle', '选择…'); newPick.id = 'latex-new-pick'; newPick.type = 'button'; newPick.title = '打开系统文件夹选择对话框';
    const registerLine = make('div', 'latex-menu-row'); registerLine.append(newRoot, newPick, newMain, newMainPick, newTitle, starterLabel, newSubmit);
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
    const accentPresets = [['system', '跟随 DSH'], ['#4176e6', '蓝色'], ['#27806b', '青绿'], ['#b7791f', '琥珀'], ['#8250c4', '紫色'], ['custom', '自定义…']];
    const settingAccent = make('select'); settingAccent.id = 'latex-setting-accent'; settingAccent.setAttribute('aria-label', '界面高亮配色');
    for (const [value, label] of accentPresets) { const option = make('option', '', label); option.value = value; settingAccent.append(option); }
    const settingAccentColor = make('input'); settingAccentColor.id = 'latex-setting-accent-color'; settingAccentColor.type = 'color'; settingAccentColor.value = '#4176e6'; settingAccentColor.setAttribute('aria-label', '自定义界面高亮颜色'); settingAccentColor.hidden = true;
    const accentLabel = make('label', 'latex-check'); accentLabel.append(make('span', '', '界面高亮'), settingAccent, settingAccentColor);
    const settingsRetry = make('button', 'button subtle', '重试保存设置'); settingsRetry.id = 'latex-settings-retry'; settingsRetry.type = 'button'; settingsRetry.hidden = true;
    const settingsLine = make('div', 'latex-menu-row'); settingsLine.append(settingStarterLabel, settingAutoLabel, engineLabel, themeLabel, pathFontLabel, accentLabel, settingsRetry);
    settingRow.append(settingsLine);

    const writingModelSettings = make('div', 'latex-menu-section'); writingModelSettings.id = 'latex-writing-model-settings';
    const retrievalSettings = make('section', 'latex-menu-section latex-retrieval-settings'); retrievalSettings.id = 'latex-retrieval-settings'; retrievalSettings.setAttribute('aria-label', '本次检索');
    const retrievalProject = make('input'); retrievalProject.id = 'latex-retrieval-project'; retrievalProject.type = 'checkbox'; retrievalProject.checked = true;
    const retrievalProjectLabel = make('label', 'latex-menu-check'); retrievalProjectLabel.append(retrievalProject, make('span', '', '只读检索当前项目'));
    const retrievalPublic = make('input'); retrievalPublic.id = 'latex-retrieval-public'; retrievalPublic.type = 'checkbox'; retrievalPublic.checked = false;
    retrievalPublic.setAttribute('aria-controls', 'latex-retrieval-public-options');
    const retrievalPublicLabel = make('label', 'latex-menu-check'); retrievalPublicLabel.append(retrievalPublic, make('span', '', '为下一次提问或提案启用公开学术检索'));
    const retrievalPublicOptions = make('div', 'latex-retrieval-public-options'); retrievalPublicOptions.id = 'latex-retrieval-public-options'; retrievalPublicOptions.hidden = true;
    const retrievalQueryLabel = make('label', 'latex-menu-label', '公开检索词'); retrievalQueryLabel.htmlFor = 'latex-retrieval-queries';
    const retrievalQueries = make('textarea'); retrievalQueries.id = 'latex-retrieval-queries'; retrievalQueries.rows = 3; retrievalQueries.spellcheck = false; retrievalQueries.autocomplete = 'off';
    retrievalQueries.placeholder = '一行一个公开检索词，最多 3 行'; retrievalQueries.setAttribute('aria-describedby', 'latex-retrieval-query-hint');
    const retrievalHint = make('p', 'latex-menu-hint', '每行最多 200 字。只有这里填写的词会发给 Crossref 和 arXiv，提问、批注和稿件原文不会作为公开检索词。'); retrievalHint.id = 'latex-retrieval-query-hint';
    retrievalPublicOptions.append(retrievalQueryLabel, retrievalQueries, retrievalHint);
    retrievalSettings.append(make('strong', 'latex-menu-label', '本次检索'), retrievalProjectLabel, retrievalPublicLabel, retrievalPublicOptions);
    const translateSettings = make('div', 'latex-menu-section'); translateSettings.append(make('span', 'latex-menu-label', '本项目选文翻译'));
    const translateModel = make('select'); translateModel.id = 'latex-translate-model'; translateModel.setAttribute('aria-label', '本项目翻译模型');
    const translateTarget = make('select'); translateTarget.id = 'latex-translate-target'; translateTarget.setAttribute('aria-label', '本项目翻译目标语言');
    for (const [value, label] of [['', '跟随语言设置'], ['auto', '自动识别 · 中英互译'], ['zh-CN', '译为中文'], ['en', '译为英文']]) { const option = make('option', '', label); option.value = value; translateTarget.append(option); }
    const translatePrompt = make('textarea'); translatePrompt.id = 'latex-translate-prompt'; translatePrompt.rows = 2; translatePrompt.maxLength = 2000; translatePrompt.placeholder = '本项目补充提示词；留空跟随语言设置'; translatePrompt.setAttribute('aria-label', '本项目翻译补充提示词');
    const translateSave = make('button', 'button subtle', '保存本项目翻译设置'); translateSave.id = 'latex-translate-settings-save'; translateSave.type = 'button';
    translateSettings.append(translateModel, translateTarget, translatePrompt, translateSave, make('p', 'latex-menu-hint', '模型默认跟随语言设置。标为轻量的名称仅供选择；实际价格与延迟未知。'));

    const rootRow = make('div', 'latex-menu-section');
    rootRow.append(make('span', 'latex-menu-label', '论文目录'));
    const rootPath = make('code', 'latex-root'); rootPath.id = 'latex-root'; rootPath.textContent = '读取中…';
    const syncState = make('span', 'latex-sync-state'); syncState.id = 'latex-sync-state';
    const syncAttach = make('button', 'button subtle', '纳入同步'); syncAttach.id = 'latex-sync-attach'; syncAttach.type = 'button';
    const rootLine = make('div', 'latex-menu-row'); rootLine.append(rootPath, syncState, syncAttach);
    rootRow.append(rootLine, make('p', 'latex-menu-hint', '论文目录由插件维护；数据同步服务会把它作为一个独立源备份（只新增，不删改其他源）。'));
    menu.append(entryRow, locationRow, readingRow, createRow, registerRow, compareRow, settingRow, writingModelSettings, retrievalSettings, translateSettings, rootRow);

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
    const sourceTranslate = make('button', 'button subtle', '翻译选文'); sourceTranslate.id = 'latex-translate-selection'; sourceTranslate.type = 'button';
    const sourceSpell = make('button', 'button subtle', '英文拼写'); sourceSpell.id = 'latex-spell-toggle'; sourceSpell.type = 'button'; sourceSpell.disabled = true; sourceSpell.setAttribute('aria-pressed', 'false');
    breadcrumb.append(currentFile, sourceSearch, sourceNote, sourceTranslate, sourceSpell, sourceTools);
    const sourceToolsMenu = make('div', 'latex-source-tools-menu'); sourceToolsMenu.id = 'latex-source-tools-menu'; sourceToolsMenu.hidden = true;
    const figureInsert = make('button', 'button subtle', '插入图片模板　⌘/Ctrl+Shift+I'); figureInsert.id = 'latex-insert-figure'; figureInsert.type = 'button';
    const tableInsert = make('button', 'button subtle', '编辑表格　⌘/Ctrl+Shift+T'); tableInsert.id = 'latex-insert-table'; tableInsert.type = 'button';
    const formulaCheck = make('button', 'button subtle', '提取并检查公式'); formulaCheck.id = 'latex-formula-check'; formulaCheck.type = 'button';
    sourceToolsMenu.append(figureInsert, tableInsert, formulaCheck, make('p', '', '图片拖到源码区或粘贴截图，保存到项目 figures/。表格支持 Markdown、Excel 选区和 .xlsx 文件。'));
    const formulaHost = make('section', 'latex-formula-panel'); formulaHost.id = 'latex-formula-panel'; formulaHost.hidden = true;
    const spellResults = make('div', 'latex-spelling-results'); spellResults.id = 'latex-spelling-results'; spellResults.hidden = true;
    const translateResults = make('section', 'latex-translation-results'); translateResults.id = 'latex-translation-results'; translateResults.hidden = true;
    const translateHeading = make('strong', '', '选文译文'); translateHeading.id = 'latex-translation-heading';
    translateResults.setAttribute('aria-labelledby', translateHeading.id);
    const translateClose = make('button', 'button subtle', '关闭'); translateClose.id = 'latex-translation-close'; translateClose.type = 'button';
    translateClose.setAttribute('aria-label', '关闭译文');
    const translateHeader = make('header', 'latex-translation-header'); translateHeader.append(translateHeading, translateClose);
    const translateBody = make('div');
    translateResults.append(translateHeader, translateBody);
    sourceTranslate.setAttribute('aria-controls', translateResults.id);
    const editorWrap = make('div', 'latex-editor-wrap');
    const gutter = make('div', 'latex-gutter'); gutter.id = 'latex-gutter'; gutter.setAttribute('aria-hidden', 'true');
    const editor = make('textarea'); editor.id = 'latex-editor'; editor.spellcheck = false; editor.autocomplete = 'off'; editor.setAttribute('aria-label', 'LaTeX 源文件内容');
    editorWrap.append(gutter, editor);
    let sourceEditor = null;
    try { sourceEditor = window.PaperLatexEditor?.create?.(editor, editorWrap) || null; } catch { /* Keep the native textarea usable if the enhanced editor cannot mount. */ }
    if (sourceEditor) { editorWrap.classList.add('latex-codemirror'); gutter.hidden = true; }
    sourceSearch.hidden = !sourceEditor;
    sourceSearch.addEventListener('click', () => sourceEditor?.openSearch());
    left.append(breadcrumb, sourceToolsMenu, formulaHost, spellResults, translateResults, editorWrap);

    const splitter = make('div', 'latex-splitter'); splitter.id = 'latex-splitter'; splitter.setAttribute('role', 'separator');
    splitter.setAttribute('aria-orientation', 'vertical'); splitter.setAttribute('aria-label', '调整源码与预览宽度'); splitter.tabIndex = 0;
    splitter.setAttribute('aria-valuemin', String(SPLIT_MIN)); splitter.setAttribute('aria-valuemax', String(SPLIT_MAX));

    const right = make('section', 'latex-preview-pane'); right.setAttribute('aria-label', '预览与协作');
    const tabs = make('div', 'latex-tabs'); tabs.setAttribute('role', 'tablist');
    const tabSpecs = rail ? [['pdf', 'PDF'], ['media', '媒体'], ['version', '版本']] : [['pdf', 'PDF'], ['media', '媒体'], ['ai', '批注与写作'], ['version', '版本']];
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
      button.addEventListener('click', () => { if (pdfSource.kind === 'version' && mode !== 'select') return; clearPdfSelection(); pdfTool = mode; preview.dataset.tool = mode; for (const item of pdfTools.querySelectorAll('button')) item.setAttribute('aria-pressed', String(item === button)); });
      pdfTools.append(button);
    }
    const syncHint = make('p', 'latex-sync-hint'); syncHint.id = 'latex-sync-hint'; syncHint.setAttribute('role', 'status');
    const toPdf = make('button', 'button subtle', '跳到 PDF'); toPdf.id = 'latex-synctex-forward'; toPdf.type = 'button';
    toPdf.title = '把编辑器光标所在行定位到 PDF（SyncTeX）；双击 PDF 可反向跳到源码';
    toPdf.setAttribute('aria-label', '从光标行跳到 PDF 对应位置');
    previewHead.append(pagePrev, pageLabel, pageNext, zoomSelect, toPdf, renderState);
    const preview = make('div', 'latex-preview'); preview.id = 'latex-preview';
    const selectionHighlight = make('button', 'button latex-selection-highlight', '添加高亮');
    selectionHighlight.type = 'button'; selectionHighlight.hidden = true;
    selectionHighlight.addEventListener('pointerdown', event => event.preventDefault());
    selectionHighlight.addEventListener('click', () => {
      if (!pdfSelection) return;
      const { stage, anchor } = pdfSelection;
      if (pdfTool !== 'select' || !canAnnotateStage(stage, anchor.page) || anchor.pdf_version !== pdfBuild.pdf_version) { clearPdfSelection(); return; }
      if (reviewer.beginPdf(anchor, 'highlight', { instant: true })) {
        clearPdfSelection(); window.getSelection()?.removeAllRanges();
      }
    });
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
    const writingPanel = make('section', 'latex-writing-panel'); writingPanel.id = 'latex-writing-panel'; writingPanel.setAttribute('aria-label', '批注与写作');
    const aiModel = make('select'); aiModel.id = 'latex-ai-model'; aiModel.setAttribute('aria-label', 'DSH 写作模型');
    const writingModelLabel = make('label', 'latex-menu-label', 'DSH 写作模型'); writingModelLabel.htmlFor = aiModel.id;
    const aiStatusLine = make('p', 'latex-menu-hint'); aiStatusLine.id = 'latex-ai-route'; aiStatusLine.hidden = true;
    writingModelSettings.append(writingModelLabel, aiModel, make('p', 'latex-menu-hint', '用于批注提问与修改提案；翻译模型在下方单独设置。'), aiStatusLine);
    const detachedProposal = make('div', 'latex-menu-section'); detachedProposal.id = 'latex-detached-proposal'; detachedProposal.hidden = true;
    detachedProposal.append(make('strong', 'latex-menu-label', '待处理的旧提案'), make('p', 'latex-menu-hint', '原批注不可用，可在这里处理这份提案。'));
    menu.append(detachedProposal);
    const proposalBox = make('section', 'latex-review-pending-proposal');
    const aiProposal = make('div', 'latex-ai-proposal'); aiProposal.id = 'latex-ai-proposal';
    const aiAccept = make('button', 'button primary', '接受并写入'); aiAccept.id = 'latex-ai-accept'; aiAccept.type = 'button';
    const aiDiscard = make('button', 'button subtle', '放弃'); aiDiscard.id = 'latex-ai-discard'; aiDiscard.type = 'button';
    const aiActions = make('div', 'latex-ai-actions'); aiActions.append(aiAccept, aiDiscard);
    proposalBox.append(aiProposal, aiActions);
    paneAi.append(writingPanel);

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
    content.append(body);

    const status = make('p', 'latex-status'); status.id = 'latex-status'; status.setAttribute('role', 'status');
    const conflictBar = make('div', 'latex-conflict'); conflictBar.id = 'latex-conflict'; conflictBar.hidden = true;
    const conflictText = make('span', '', ''); conflictText.id = 'latex-conflict-text';
    const reload = make('button', 'button subtle', '载入最新'); reload.id = 'latex-conflict-reload'; reload.type = 'button';
    const overwrite = make('button', 'button subtle', '用我的版本覆盖'); overwrite.id = 'latex-conflict-overwrite'; overwrite.type = 'button';
    conflictBar.append(conflictText, reload, overwrite);
    const footer = make('footer', 'latex-footer');
    footer.append(conflictBar, status);
    const topbar = make('div', 'latex-topbar'); topbar.append(toolbar, menu);
    const editorSurface = make('div', 'latex-editor-surface');
    editorSurface.append(topbar, errors, content, footer);
    view.append(navigator, editorSurface);
    let layout = 'split';
    function setLayout(mode) {
      if (!layoutButtons.has(mode)) return;
      if (mode === 'source') clearPdfSelection();
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
      view.classList.toggle('latex-nav-collapsed', navigator.hidden);
      navToggle.title = navigator.hidden ? '展开侧边导航' : '收起侧边导航';
      navToggle.setAttribute('aria-expanded', String(!navigator.hidden));
      if (layout !== 'source') requestResize();
    });
    const reviewPanel = make('section', 'latex-review-panel'); reviewPanel.id = 'latex-review-panel'; reviewPanel.setAttribute('aria-label', '批注');
    writingPanel.append(reviewPanel);
    const reviewer = window.PaperLatexReview?.create({ root: reviewPanel, api,
      context: () => ({ id: project?.id, main: project?.main_path, binding_generation: project?.binding_generation, file, revision, dirty, editor, build: pdfBuild }),
      show: () => showReview(),
      onAsk: note => aiRun('ask', note), onPropose: note => aiRun('propose', note), onStop: () => cancelAiRun(),
      onDetachedProposal(element) {
        detachedProposal.hidden = !element;
        if (element && element.parentElement !== detachedProposal) detachedProposal.append(element);
      },
      revealSource: async anchor => {
        if (!await openFile(anchor.path, { force: true })) return;
        if (revision !== anchor.revision) { say('源码已变化，原批注待重定位；未按旧偏移选择。', true); void reviewer.refresh(); return; }
        await gotoSource(anchor.path, anchor.line);
        if (file !== anchor.path || revision !== anchor.revision) { say('匹配后源码再次变化，请刷新批注定位。', true); return; }
        const chars = Array.from(editor.value);
        editor.setSelectionRange(chars.slice(0, anchor.start).join('').length, chars.slice(0, anchor.end).join('').length);
      },
      revealPdf: async anchor => {
        if (pdfSource.kind !== 'current' && !await showCurrentPdf()) return;
        if (anchor.pdf_version !== pdfBuild?.pdf_version) { say('批注属于旧编译，待重定位；未定位到当前 PDF。', true); return; }
        if (layout === 'source') setLayout('split');
        setTab('pdf'); await renderPage(anchor.page);
        if (pdfSource.kind !== 'current' || anchor.pdf_version !== pdfBuild?.pdf_version) { say('匹配后 PDF 再次变化，请刷新批注定位。', true); return; }
        const rect = anchor.rects[0]; if (rect) await highlightPdf({ page: anchor.page, h: rect[0], v: rect[3], W: rect[2] - rect[0], H: rect[3] - rect[1], displayCoordinates: true });
      },
      changed: ({ annotations }) => { if (pdfSource.kind === 'current') patchPdfAnnotations(annotations); },
    });
    function showReview() {
      if (!reviewer) { say('自审组件尚未加载；请先刷新插件页面。', true); return; }
      showRail(true);
    }
    reviewToggle.addEventListener('click', () => showReview());
    sourceNote.addEventListener('click', () => reviewer?.beginSource());
    function updateSyncHint() {
      const position = pageCount ? `第 ${page} / ${pageCount} 页 · ` : '';
      syncHint.textContent = position + (pdfSource.kind === 'version' ? '历史版本只读预览；当前源码不能与此 PDF 同步定位或写入批注。' : (dirty ? '源码有未保存修改；PDF 仍属于上次编译，双击定位暂停。' : (pdfBuild?.reason || '编译后可双击正文定位源码；自审批注保存在审阅副本。')));
    }

    function say(text, error = false) { status.textContent = text; status.classList.toggle('error', error); }
    function setSaveState(text, kind = '') { saveState.textContent = text; saveState.dataset.state = kind; }
    function setTab(name) {
      if (name !== 'pdf') clearPdfSelection();
      tab = name;
      if (!rail) syncRailToggle();
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
      projectSearch?.reset('source');
      updateSyncHint(); if (!sourceEditor) updateNavigatorActive(); scheduleSpelling();
    });
    editor.addEventListener('select', () => updateNavigatorActive());
    if (!sourceEditor) for (const event of ['click', 'keyup']) editor.addEventListener(event, () => updateNavigatorActive());
    let spellEnabled = false, spellTimer = null, spellRevision = 0, spellLoaded = false, spellEpoch = 0, spellingLoading = null;
    function ensureSpelling() {
      if (window.PaperLatexSpelling?.checkSpelling) return Promise.resolve(window.PaperLatexSpelling);
      if (!spellingLoading) spellingLoading = new Promise((resolve, reject) => {
        const script = make('script'); script.src = './latex-spelling.js'; script.async = true;
        script.onload = () => window.PaperLatexSpelling?.checkSpelling ? resolve(window.PaperLatexSpelling) : reject(new Error('本地词典没有提供拼写检查'));
        script.onerror = () => { script.remove(); reject(new Error('本地词典加载失败，请刷新后重试')); };
        document.head.append(script);
      }).catch(error => { spellingLoading = null; throw error; });
      return spellingLoading;
    }
    async function loadSpelling() {
      if (spellLoaded) return; spellLoaded = true;
      try { const record = await api('state_get', { key: 'reader:latex-spelling' }); spellRevision = record.revision; spellEnabled = record.value?.enabled === true; sourceSpell.setAttribute('aria-pressed', String(spellEnabled)); scheduleSpelling(); } catch { /* An unavailable preference leaves checking off. */ } finally { sourceSpell.disabled = false; }
    }
    function scheduleSpelling() {
      const epoch = ++spellEpoch; clearTimeout(spellTimer); spellResults.hidden = !spellEnabled;
      if (!spellEnabled) { spellResults.textContent = ''; return; }
      spellResults.textContent = '正在检查英文拼写…';
      spellTimer = setTimeout(async () => {
        try {
          const checker = await ensureSpelling(); if (epoch !== spellEpoch || !spellEnabled || disposed) return;
          const result = checker.checkSpelling(editor.value); spellResults.textContent = '';
          spellResults.append(make('span', '', result.items.length ? '可能拼写有误：' : result.truncated ? '已检查范围未发现英文拼写问题。' : '未发现英文拼写问题。'));
          if (result.truncated) spellResults.append(make('p', '', `已检查前 ${result.checkedCharacters} 字符、${result.checkedWords} 个英文词；达到${result.limitReason === 'results' ? '结果' : '扫描'}上限，后文尚未检查。`));
          for (const item of result.items) { const button = make('button', 'button subtle', item.word); button.type = 'button'; button.title = '定位到源码中的此词'; button.addEventListener('click', () => { editor.setSelectionRange(item.from, item.to); editor.focus(); }); spellResults.append(button); }
        } catch (error) { if (epoch === spellEpoch && spellEnabled && !disposed) spellResults.textContent = `本地拼写检查不可用：${error.message}`; }
      }, 450);
    }
    sourceSpell.addEventListener('click', async () => {
      sourceSpell.disabled = true;
      spellEnabled = !spellEnabled; sourceSpell.setAttribute('aria-pressed', String(spellEnabled)); scheduleSpelling();
      try { const record = await api('state_put', { key: 'reader:latex-spelling', value: { enabled: spellEnabled }, expected_revision: spellRevision }); spellRevision = record.revision; }
      catch (error) { say(`拼写开关未能保存：${error.message}`, true); }
      finally { sourceSpell.disabled = false; }
    });
    function writingContext() {
      return { id: project?.id, root: project?.root, binding_generation: project?.binding_generation, title: project?.title, path: file, revision, content: editor.value, selectionStart: editor.selectionStart || 0, selectionEnd: editor.selectionEnd || 0,
        blocked: !project || !file || editor.disabled || switching || Boolean(pendingConflict) };
    }
    function insertWriting(text, expected) {
      const current = writingContext();
      if (disposed || current.blocked || !expected || current.id !== expected.id || current.root !== expected.root || current.binding_generation !== expected.binding_generation || current.path !== expected.path || current.content !== expected.content) {
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
      const accent = /^#[a-f0-9]{6}$/i.test(settings.latex_accent) ? settings.latex_accent.toLowerCase() : 'system';
      settingAccent.value = accentPresets.some(([value]) => value === accent) ? accent : 'custom';
      settingAccentColor.hidden = settingAccent.value !== 'custom';
      settingAccentColor.value = accent === 'system' ? '#4176e6' : accent;
      view.dataset.latexAccent = accent === 'system' ? 'system' : 'custom';
      view.style.setProperty('--latex-accent-color', settingAccentColor.value);
      createStarter.checked = settings.latex_starter !== false;
      newStarter.checked = settings.latex_starter !== false;
      updateAutoToggle();
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

    function closeMenu() {
      if (menu.hidden) return;
      menu.hidden = true; menuButton.setAttribute('aria-expanded', 'false'); onSettingsClose();
    }
    menuButton.addEventListener('click', event => {
      event.stopPropagation();
      if (!menu.hidden) { closeMenu(); return; }
      menu.hidden = false;
      menuButton.setAttribute('aria-expanded', 'true');
      void refreshWorkspace(); void loadReadingProjects(); void loadTranslationSettings(); void aiStatus();
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
    view.addEventListener('click', event => {
      if (!menu.hidden && !menu.contains(event.target) && !event.target.closest?.('#workspace-path-popup, #workspace-related')) closeMenu();
    });
    view.addEventListener('keydown', event => { if (event.key === 'Escape' && !menu.hidden) { closeMenu(); menuButton.focus(); } });

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
      if (checkReview && writingTools?.hasDraft()) { say('写作工具还有未完成的草稿；请先插入、复制或放弃草稿。', true); return false; }
      if (dirty || saving) await flush('manual');
      await saveQueue;
      if (dirty || pendingConflict) {
        say('当前文件尚未保存；请先解决保存失败或冲突，再切换。', true);
        return false;
      }
      return true;
    }

    function cancelReads() {
      projectSearch?.reset();
      clearPdfSelection();
      fileRequest += 1; navRequest += 1; mediaRequest += 1;
      for (const controller of [fileAbort, navAbort, mediaAbort]) controller?.abort();
      pdfStages.clear(); cancelPdfLoads(); pdfWindowKey = '';
      preview.setAttribute('aria-busy', 'false');
      clearTimeout(outlineTimer); clearTimeout(resizeTimer); clearTimeout(compileTimer);
    }

    function syncLocationFields() {
      locationRoot.value = project?.root || '';
      locationMain.value = project?.main_path || '';
      locationRoot.disabled = locationMain.disabled = locationPick.disabled = locationMainPick.disabled = locationSave.disabled = !project || switching;
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
    async function refreshProjects(preferred, valid = () => !disposed) {
      const result = await api('latex_project_list', { limit: 200, include_archived: false });
      const listed = (result.projects || []).filter(item => item && !item.archived);
      if (preferred && !listed.some(item => item.id === preferred)) {
        const fetched = await api('latex_project_get', { id: preferred, include_archived: false });
        if (!fetched?.project || fetched.project.id !== preferred || fetched.project.archived) throw new Error('指定的 LaTeX 项目不存在或已归档。');
        listed.push(fetched.project);
      }
      if (!valid()) return null;
      projects = listed;
      projectSelect.textContent = '';
      if (!projects.length) {
        const option = make('option', '', '还没有 LaTeX 项目'); option.value = ''; projectSelect.append(option);
      }
      for (const item of projects) {
        const option = make('option', '', `${item.title}${item.exists === false ? '（文件夹不可用）' : ''}`);
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
      cancelTranslation();
      resetAiState();
      if (!id) { project = null; await renderEmpty(); return; }
      cancelReads();
      generation += 1;
      const ticket = generation;
      clearRendered();
      formulas?.clear(); formulas?.close();
      project = projects.find(item => item.id === id) || null;
      if (!project) { await renderEmpty(); return; }
      syncLocationFields();
      resetPdfSource({ kind: 'current' });
      projectSelect.value = project.id;
      errors.textContent = ''; errors.hidden = true; diagnosticsToggle.hidden = true; diagnosticsToggle.setAttribute('aria-expanded', 'false');
      reviewer?.reset(); pdfBuild = null; updateSyncHint();
      file = null; revision = null; editor.value = ''; editor.disabled = true; lineNumbers();
      pageCount = 0; pageGeometry = []; pdfVersion = ''; mediaPath = null; mediaGeometry = null;
      if (mediaUrl) { URL.revokeObjectURL(mediaUrl); mediaUrl = null; }
      mediaPreview.textContent = '从左侧「媒体」选择项目内的文件。'; mediaCrumb.textContent = ''; mediaInfo.textContent = '';
      tree = null; fileList.textContent = ''; outlineList.textContent = ''; mediaList.textContent = ''; currentFile.textContent = '选择源文件';
      compile.disabled = false; mainSelect.disabled = false;
      if (project.exists === false) {
        mainLabel.textContent = `编译：${project.main_path || '未设置'}`;
        mainSelect.textContent = '';
        const option = make('option', '', project.main_path || '未设置'); option.value = project.main_path || ''; mainSelect.append(option);
        compile.disabled = true; mainSelect.disabled = true; lastBuildOk = null; autoPaused = false; updateAutoToggle();
        const hint = '项目文件夹已不可用；打开「项目与设置」，修改当前项目位置和主文件。';
        setPreviewMessage(hint); say(hint, true); notifyContext();
        return;
      }
      setPreviewMessage('读取项目…');
      try { await loadTree(); }
      catch (error) { if (ticket === generation) { say(`项目导航读取失败：${error.message}`, true); notifyContext(); } return; }
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
      autoPaused = false; updateAutoToggle();
      // Whichever surface hosts the collaboration, a project switch re-reads its state.
      if (tab === 'ai' || rail?.visible?.('latex-ai')) void aiStatus();
      notifyContext();
    }

    async function renderEmpty() {
      syncLocationFields();
      file = null; revision = null; editor.value = ''; lineNumbers(); tree = null;
      fileList.textContent = ''; errors.textContent = ''; renderEmptyState();
      outlineList.textContent = ''; mediaList.textContent = ''; mainSelect.textContent = ''; currentFile.textContent = '选择源文件';
      mainLabel.textContent = ''; setSaveState(''); buildInfo.textContent = '';
      errors.hidden = true; diagnosticsToggle.hidden = true; diagnosticsToggle.setAttribute('aria-expanded', 'false');
      lastBuildOk = null; autoPaused = false; updateAutoToggle();
      if (!view.hidden) notifyContext();
    }

    /** No project yet: explain the folder model inline and offer both entry points. */
    function renderEmptyState() {
      clearRendered();
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
      projectSearch?.reset('pdf');
      clearRendered();
      preview.textContent = '';
      const note = make('p', 'latex-preview-empty', text);
      preview.append(note); pageCount = 0; pageLabel.textContent = '—';
    }

    function setNav(name) {
      navMode = name;
      for (const [mode, button] of navButtons) button.setAttribute('aria-selected', String(mode === name));
      outlineList.hidden = name !== 'outline'; fileList.hidden = name !== 'files'; mediaList.hidden = name !== 'media';
    }
    function sourceButton(path, label = path, line = 1, kind = 'file') {
      const button = make('button', 'latex-file-open', label); button.type = 'button'; button.dataset.path = path; button.dataset.line = String(line);
      button.dataset.navKind = kind;
      button.title = `${path}:${line}`;
      button.addEventListener('click', () => void gotoSource(path, line));
      return button;
    }
    function updateNavigatorActive(line) {
      const cursorLine = Number.isSafeInteger(line) ? line : (sourceEditor?.cursorLine?.() || editor.value.slice(0, editor.selectionStart || 0).split('\n').length);
      const outlineButtons = outlineList.querySelectorAll('button[data-path]');
      let currentHeading = null, currentFileButton = null;
      for (const button of outlineButtons) {
        if (button.dataset.path !== file) continue;
        if (button.dataset.navKind === 'file' && !currentFileButton) currentFileButton = button;
        const candidate = Number(button.dataset.line);
        if (button.dataset.navKind === 'heading' && candidate <= cursorLine && (!currentHeading || candidate > Number(currentHeading.dataset.line))) currentHeading = button;
      }
      for (const button of outlineButtons) {
        const active = button === (currentHeading || currentFileButton);
        button.classList.toggle('current-file', Boolean(file) && button.dataset.path === file);
        button.classList.toggle('active', active);
        const current = active ? 'location' : 'false';
        if (button.getAttribute('aria-current') !== current) button.setAttribute('aria-current', current);
      }
      for (const button of fileList.querySelectorAll('button[data-path]')) {
        const active = Boolean(file) && button.dataset.path === file;
        button.classList.toggle('current-file', active); button.classList.toggle('active', active);
        const current = active ? 'location' : 'false';
        if (button.getAttribute('aria-current') !== current) button.setAttribute('aria-current', current);
      }
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
          const button = sourceButton(item.path, label, item.line, item.kind);
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
        updateNavigatorActive();
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
      cancelAiRun({ quiet: true });
      cancelReads(); generation += 1; clearRendered();
      try {
        const result = await api('latex_project_update', { id: project.id, main_path: path });
        project = result.project; projects = projects.map(item => item.id === project.id ? project : item);
        resetAiState();
        syncLocationFields();
        resetPdfSource({ kind: 'current' });
        errors.textContent = ''; diagnosticsToggle.hidden = true; setDiagnosticsOpen(false);
        reviewer?.reset(); pdfBuild = null; updateSyncHint();
        file = null; revision = null; editor.value = ''; editor.disabled = true;
        page = 1; pageGeometry = []; setPreviewMessage('读取主入口…');
        await loadTree(); await openFile(path, { duringSwitch: true });
        if (project.pdf_present) await loadLayout(); else setPreviewMessage('这个主入口还没有 PDF；点「编译」生成。');
        say(`已切换主入口 ${path}`);
        void reviewer?.refresh();
        if (tab === 'ai' || rail?.visible?.('latex-ai')) void aiStatus();
      } catch (error) { mainSelect.value = project.main_path; say(`切换入口失败：${error.message}`, true); }
      finally { switching = false; mainSelect.disabled = false; compile.disabled = false; }
    });

    async function openFile(path, options = {}) {
      const isCurrent = options.isCurrent || (() => true);
      if (!isCurrent() || (switching && !options.duringSwitch)) return false;
      if (path === file && !options.force && !editor.disabled) return true;
      if (!project || !await savedBeforeLeaving() || !isCurrent()) return false;
      const id = project.id, ticket = ++fileRequest, epoch = generation;
      fileAbort?.abort(); fileAbort = new AbortController(); editor.disabled = true;
      let read;
      try { read = await api('latex_read', { id, path }, { signal: fileAbort.signal }); }
      catch (error) {
        if (ticket === fileRequest && error.name !== 'AbortError') say(`文件读取失败：${error.message}`, true);
        return false;
      } finally { if (ticket === fileRequest) editor.disabled = !file; }
      if (ticket !== fileRequest || epoch !== generation || id !== project?.id || disposed || !isCurrent()) return false;
      cancelTranslation(); file = read.path; revision = read.revision; dirty = false;
      editor.disabled = false; currentFile.textContent = file;
      editor.value = read.content; lineNumbers(); editor.scrollTop = 0; gutter.scrollTop = 0;
      patchSourceSearch();
      scheduleSpelling();
      pendingConflict = null; conflictBar.hidden = true;
      setSaveState('已载入', 'saved');
      updateNavigatorActive();
      say(`${file} · ${read.bytes} 字节 · ${read.lines} 行 · 修订 ${read.revision.slice(0, 8)}`);
      return true;
    }

    async function loadLayout() {
      const id = project?.id, ticket = generation, source = pdfSource, sourceEpoch = pdfSourceEpoch;
      try {
        const layout = source.kind === 'version'
          ? await api('latex_version_pdf_pages', { version_id: source.versionId, ...(source.reviewPdfVersion ? { review_pdf_version: source.reviewPdfVersion } : {}) })
          : await api('latex_pdf_pages', { id });
        if (ticket !== generation || id !== project?.id || sourceEpoch !== pdfSourceEpoch || disposed) return false;
        const version = layout.version || buildInfo.dataset.build || '';
        if (version !== pdfVersion) projectSearch?.reset('pdf');
        pdfVersion = version;
        pdfBuild = source.kind === 'current' ? (layout.build || null) : null; updateSyncHint();
        pageCount = layout.page_count; pageGeometry = layout.pages || []; page = Math.min(Math.max(1, page), Math.max(1, pageCount));
        await renderPage(page);
        return ticket === generation && id === project?.id && sourceEpoch === pdfSourceEpoch && !disposed;
      } catch (error) {
        if (ticket !== generation || sourceEpoch !== pdfSourceEpoch) return;
        setPreviewMessage(`无法预览：${error.message}`);
        return false;
      }
    }

    function cancelPdfLoads() {
      for (const [stage, job] of pdfLoads) {
        if (pdfStages.get(Number(stage.dataset.page)) === stage) continue;
        job.controller.abort(); pdfLoads.delete(stage);
      }
    }
    function clearRendered() {
      clearPdfSelection();
      pdfStages.clear(); cancelPdfLoads(); pdfWindowKey = '';
      pdfPriority.clear();
      pdfScrollTop = 0; pdfScrollDirection = 1;
      preview.setAttribute('aria-busy', 'false');
      for (const item of rendered.values()) URL.revokeObjectURL(item.url);
      rendered.clear();
    }
    function resetPdfSource(source) {
      projectSearch?.reset('pdf');
      pdfSource = source; pdfSourceEpoch += 1; pdfSourceIntent += 1; clearRendered();
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
      return Math.max(80, width - PDF_PREVIEW_PADDING * 2) * factor;
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
        const metric = { top, height }; top += height + PDF_PAGE_GAP; return metric;
      });
    }
    function pdfPageAt(metrics, point) {
      let low = 0, high = metrics.length - 1;
      while (low < high) { const mid = Math.floor((low + high + 1) / 2); if (metrics[mid].top <= point) low = mid; else high = mid - 1; }
      return low + 1;
    }
    function pdfNearby(metrics, wanted, scroll) {
      const top = (scroll ? metrics[wanted - 1].top : (preview.scrollTop || 0)) - PDF_PREVIEW_PADDING;
      const first = pdfPageAt(metrics, top), firstMetric = metrics[first - 1];
      const visibleStart = firstMetric.top + firstMetric.height <= top && first < pageCount ? first + 1 : first;
      const bottom = top + Math.max(1, preview.clientHeight);
      const last = pdfPageAt(metrics, bottom - .01);
      // The incoming page becomes urgent as soon as the gap reaches the viewport.
      const gapNeighbor = pdfPageAt(metrics, bottom + PDF_PAGE_GAP);
      // Keep the outgoing page until it leaves the viewport. Use the freed
      // slot for the approaching page while the current one is still visible.
      const approaching = pdfScrollDirection < 0 ? Math.min(visibleStart, Math.max(visibleStart - 1, last - MAX_RENDERED_PAGES + 1)) : visibleStart;
      const start = Math.max(1, wanted - MAX_RENDERED_PAGES + 1, Math.min(wanted, approaching, pageCount - MAX_RENDERED_PAGES + 1));
      const pages = Array.from({ length: Math.min(MAX_RENDERED_PAGES, pageCount - start + 1) }, (_, index) => start + index);
      const priorityStart = pdfScrollDirection < 0 ? first : visibleStart;
      return { pages, priority: new Set([wanted, ...pages.filter(number => number >= priorityStart && number <= gapNeighbor)]) };
    }
    async function renderPage(number, { scroll = true, retry = false } = {}) {
      if (!project || !pageCount) return;
      page = Math.min(Math.max(1, number), pageCount);
      const wanted = page, id = project.id, epoch = generation, source = pdfSource, sourceEpoch = pdfSourceEpoch;
      const geometry = pageGeometry[wanted - 1];
      if (!geometry) return;
      const width = previewWidth(preview, zoom);
      const metrics = pdfMetrics(width), metric = metrics[wanted - 1];
      const previousScroll = preview.scrollTop || 0;
      const delta = (scroll ? metric.top : previousScroll) - pdfScrollTop;
      if (delta) pdfScrollDirection = Math.sign(delta);
      pageLabel.textContent = `第 ${wanted} / ${pageCount} 页`;
      updateSyncHint();
      pagePrev.disabled = page <= 1; pageNext.disabled = page >= pageCount;
      const { pages: nearby, priority } = pdfNearby(metrics, wanted, scroll);
      pdfPriority = priority;
      const sourceKey = source.kind === 'version' ? `version:${source.versionId}:${source.reviewPdfVersion || ''}` : 'current';
      const keys = new Map(nearby.map(value => [value, `${id}:${sourceKey}:${value}:${pdfVersion}:${density(width, pageGeometry[value - 1])}`]));
      const windowKey = `${width}:${[...keys.values()].join('|')}`;
      const changed = windowKey !== pdfWindowKey;
      if (changed) {
        clearPdfSelection();
        pdfWindowKey = windowKey;
        const kept = new Set(keys.values());
        for (const [key, value] of rendered) if (!kept.has(key)) { URL.revokeObjectURL(value.url); rendered.delete(key); }
        const existing = pdfStages; pdfStages = new Map();
        preview.textContent = '';
        const before = make('div', 'latex-page-spacer'); before.style.height = `${metrics[nearby[0] - 1].top}px`; before.style.flex = '0 0 auto'; before.setAttribute('aria-hidden', 'true');
        const after = make('div', 'latex-page-spacer');
        const last = metrics[metrics.length - 1];
        const final = metrics[nearby[nearby.length - 1] - 1];
        after.style.height = `${Math.max(0, last.top + last.height - final.top - final.height)}px`; after.style.flex = '0 0 auto'; after.setAttribute('aria-hidden', 'true');
        preview.append(before);
        for (const number of nearby) {
          const item = metrics[number - 1], old = existing.get(number);
          const stage = old?.dataset.renderKey === keys.get(number) && old.style.width === `${width}px` ? old : make('div', 'latex-page-stage');
          stage.style.width = `${width}px`; stage.style.height = `${item.height}px`;
          stage.dataset.page = String(number); stage.dataset.renderKey = keys.get(number); pdfStages.set(number, stage); preview.append(stage);
          patchPdfSearch(stage);
          if (number !== nearby[nearby.length - 1]) { const gap = make('div', 'latex-page-spacer'); gap.style.height = `${PDF_PAGE_GAP}px`; gap.style.flex = '0 0 auto'; preview.append(gap); }
        }
        preview.append(after);
        cancelPdfLoads();
      }
      if (scroll || changed) preview.scrollTop = scroll ? metric.top : previousScroll;
      pdfScrollTop = preview.scrollTop || 0;
      const stages = pdfStages;
      const load = async (number, stage) => {
        const key = keys.get(number), pageInfo = pageGeometry[number - 1], pageScale = density(width, pageInfo);
        const valid = () => pdfStages.get(number) === stage && epoch === generation && sourceEpoch === pdfSourceEpoch && !disposed;
        try {
          stage.dataset.renderState = 'loading';
          let image = rendered.get(key);
          if (!image) {
            while (valid() && pdfLoads.size >= 2) await Promise.race([...pdfLoads.values()].map(job => job.result.catch(() => {})));
            if (!valid()) return;
            const controller = new AbortController();
            const resultPromise = source.kind === 'version'
              ? api('latex_version_pdf_page', { version_id: source.versionId, ...(source.reviewPdfVersion ? { review_pdf_version: source.reviewPdfVersion } : {}), page: number, scale: pageScale }, { signal: controller.signal })
              : api('latex_pdf_page', { id, page: number, scale: pageScale }, { signal: controller.signal });
            pdfLoads.set(stage, { controller, result: resultPromise });
            let result;
            try { result = await resultPromise; } finally { pdfLoads.delete(stage); }
            if (!valid()) return;
            image = imageUrl(result);
            rendered.set(key, image);
          }
          if (!valid()) return;
          if (!pdfPriority.has(number)) {
            const mountedBytes = [...pdfStages.values()].reduce((sum, item) =>
              sum + (item.dataset.renderState === 'ready' ? rendered.get(item.dataset.renderKey)?.bytes || 0 : 0), 0);
            // Retain the compressed raster in the bounded window. A visible
            // seam can promote it without another request or blanking its neighbor.
            if (mountedBytes + image.bytes > MAX_PREFETCH_DISPLAY_BYTES) {
              stage.dataset.renderState = 'prefetched';
              return;
            }
          }
          const img = document.createElement('img'); img.className = 'latex-page'; img.alt = `第 ${number} 页`; img.src = image.url;
          img.dataset.scale = String(pageScale); img.dataset.page = String(number);
          img.title = '双击跳转到对应的源码位置（SyncTeX）';
          stage.append(img); stage.rasterAnnotationIds = new Set(image.annotations.map(annotation => annotation.id));
          patchPdfPageAnnotations(stage, reviewer?.annotations?.() || []);
          installReviewLayer(stage, img, image.words, pageInfo, number, width);
          stage.dataset.renderState = 'ready'; stage.rasterSize = `${image.width} × ${image.height}`;
          stage.addEventListener('dblclick', event => {
            if (pdfTool !== 'select' || event.target === selectionHighlight) return;
            clearPdfSelection(); void jumpToSource(event, img);
          });
        } catch (error) {
          if (!valid() || error.name === 'AbortError') return;
          stage.dataset.renderState = 'failed';
          stage.append(make('p', 'latex-preview-empty', `预览失败：${error.message}`));
          const retryButton = make('button', 'button subtle', '重试此页'); retryButton.type = 'button'; retryButton.addEventListener('click', () => void renderPage(number, { scroll: false, retry: true })); stage.append(retryButton);
        } finally {
          if (valid() && number === page) updatePdfRenderState(stage);
        }
      };
      function ensureLoad(number, allowRetry) {
        const stage = stages.get(number);
        if (stage.loadPromise || stage.dataset.renderState === 'ready') return stage.loadPromise;
        if (stage.dataset.renderState === 'failed') {
          if (!allowRetry) return;
          stage.textContent = ''; stage.searchMarks = null; stage.savedMarks = null;
          patchPdfSearch(stage);
        }
        stage.loadPromise = load(number, stage).finally(() => { stage.loadPromise = null; });
        return stage.loadPromise;
      }
      const currentLoad = ensureLoad(wanted, scroll || retry);
      for (const number of priority) if (number !== wanted) void ensureLoad(number);
      if (changed) {
        const after = nearby.filter(number => number > wanted), before = nearby.filter(number => number < wanted).reverse();
        const prefetch = pdfScrollDirection < 0 ? [...before, ...after] : [...after, ...before];
        for (const number of prefetch) if (!priority.has(number)) void ensureLoad(number);
      }
      updatePdfRenderState(stages.get(wanted));
      await currentLoad;
    }

    function updatePdfRenderState(stage) {
      const state = stage.dataset.renderState;
      renderState.textContent = state === 'ready' ? stage.rasterSize : state === 'failed' ? '加载失败' : '高清页加载中…';
      preview.setAttribute('aria-busy', String(state === 'loading'));
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
        const relocated = note.relocation?.status === 'matched' && note.relocation.anchor?.kind === 'pdf';
        const targets = relocated && Array.isArray(note.relocation.anchors) ? note.relocation.anchors : [relocated ? note.relocation.anchor : note.anchor];
        const anchor = targets.find(value => value?.kind === 'pdf' && value.page === number && value.pdf_version === pdfBuild?.pdf_version);
        if (anchor?.kind !== 'pdf' || anchor.page !== number || anchor.pdf_version !== pdfBuild?.pdf_version || (!relocated && note.stale) || stage.rasterAnnotationIds?.has(note.id.split(':').at(-1))) continue;
        for (const rect of anchor.rects || []) {
          const [x0, y0, x1, y1] = rect;
          const mark = make('span', `latex-saved-mark latex-saved-${note.type}`); mark.dataset.note = note.id;
          Object.assign(mark.style, { position: 'absolute', left: `${x0 / geometry.width * 100}%`, top: `${y0 / geometry.height * 100}%`, width: `${(x1 - x0) / geometry.width * 100}%`, height: `${(y1 - y0) / geometry.height * 100}%`, boxSizing: 'border-box' });
          if (note.type === 'highlight') mark.style.background = 'rgba(255, 210, 64, .36)';
          else if (note.type === 'underline') mark.style.borderBottom = '2px solid #d59800';
          else if (note.type === 'strikeout') mark.style.background = 'linear-gradient(transparent 45%, #d59800 45%, #d59800 55%, transparent 55%)';
          else { mark.style.border = '1px solid #d59800'; mark.style.background = 'rgba(255, 210, 64, .12)'; }
          if (relocated) { mark.classList.add('latex-relocated-mark'); mark.style.outline = '1px dashed #967100'; mark.style.outlineOffset = '1px'; }
          overlay.append(mark);
        }
      }
    }
    function patchPdfAnnotations(notes) { for (const stage of preview.querySelectorAll('.latex-page-stage')) patchPdfPageAnnotations(stage, notes); }

    function canAnnotateStage(stage, page) {
      return !disposed && !view.hidden && tab === 'pdf' && layout !== 'source' && !!project && !switching && !compiling
        && pdfSource.kind === 'current' && !!pdfBuild?.pdf_version && pdfStages.get(page) === stage;
    }
    function clearPdfSelection() {
      clearTimeout(pdfSelectionTimer); pdfSelectionTimer = null;
      pdfSelection = null; selectionHighlight.hidden = true;
    }
    function pdfSelectionChanged() {
      if (!pdfSelection) return;
      const selection = window.getSelection(), previous = pdfSelection.range;
      const current = selection?.rangeCount && !selection.isCollapsed ? selection.getRangeAt(0) : null;
      if (!current || current.startContainer !== previous.startContainer || current.endContainer !== previous.endContainer
        || current.startOffset !== previous.startOffset || current.endOffset !== previous.endOffset) clearPdfSelection();
    }
    document.addEventListener('selectionchange', pdfSelectionChanged);
    function showPdfSelection(stage, range, anchor) {
      const bounds = range.getBoundingClientRect(), page = stage.getBoundingClientRect(), viewport = preview.getBoundingClientRect();
      stage.append(selectionHighlight); selectionHighlight.hidden = false;
      const { width, height } = selectionHighlight.getBoundingClientRect();
      const left = Math.max(viewport.left, page.left), right = Math.min(viewport.right, page.right);
      const top = Math.max(viewport.top, page.top), bottom = Math.min(viewport.bottom, page.bottom);
      const x = Math.max(left, Math.min(bounds.left, right - width));
      const y = bounds.bottom + height + 6 <= bottom ? bounds.bottom + 6 : Math.max(top, bounds.top - height - 6);
      selectionHighlight.style.left = `${x - page.left}px`;
      selectionHighlight.style.top = `${y - page.top}px`;
      pdfSelection = { stage, anchor, range: range.cloneRange() };
    }

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
        clearPdfSelection();
        if (pdfTool !== 'note' || event.button !== 0) return;
        event.preventDefault(); drag = point(event); layer.setPointerCapture(event.pointerId);
      });
      layer.addEventListener('pointerup', event => {
        if (event.button !== 0 || !canAnnotateStage(stage, wanted)) { drag = null; return; }
        if (pdfTool === 'note' && drag) {
          const end = point(event), start = drag; drag = null;
          const rect = [Math.min(start[0], end[0]), Math.min(start[1], end[1]), Math.max(start[0], end[0]), Math.max(start[1], end[1])];
          if (rect[2] - rect[0] < 2) rect[2] = Math.min(geometry.width, rect[0] + 16);
          if (rect[3] - rect[1] < 2) rect[3] = Math.min(geometry.height, rect[1] + 16);
          reviewer.beginPdf({ kind: 'pdf', page: wanted, pdf_version: pdfBuild?.pdf_version, rects: [rect], text: '' }, 'note'); return;
        }
        if (pdfTool === 'note') return;
        const tool = pdfTool, version = pdfBuild.pdf_version;
        clearTimeout(pdfSelectionTimer);
        pdfSelectionTimer = setTimeout(() => {
          pdfSelectionTimer = null;
          if (pdfTool !== tool || !canAnnotateStage(stage, wanted) || version !== pdfBuild.pdf_version) return;
          const selection = window.getSelection(); if (!selection?.rangeCount || selection.isCollapsed) return;
          const range = selection.getRangeAt(0), bounds = img.getBoundingClientRect(), pieces = [];
          try {
            if (!layer.contains(range.startContainer) || !layer.contains(range.endContainer)) {
              if (tool !== 'select') say('一次选文批注限于同一页，请在单页内重新选择。', true);
              return;
            }
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
            if (!value?.rects.length) return;
            const anchor = { kind: 'pdf', page: wanted, pdf_version: version, rects: value.rects, text: value.text };
            if (tool === 'select') showPdfSelection(stage, range, anchor);
            else reviewer.beginPdf(anchor, tool === 'comment' ? 'note' : tool, { instant: tool !== 'comment' });
          } catch (error) { say(`选区无法批注：${error.message}`, true); }
        }, 0);
      });
      layer.addEventListener('pointercancel', () => { drag = null; clearPdfSelection(); });
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
      clearPdfSelection();
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

    async function searchProject(scope, query, { signal, cursor }) {
      if (!project || project.exists === false || switching) throw new Error('请先打开可用的 LaTeX 项目。');
      const id = project.id;
      if (scope === 'source') {
        const result = await api('latex_source_search', { id, query }, { signal });
        return {
          matches: result.matches.map(hit => ({ ...hit, label: `${hit.path}:${hit.line}:${hit.column} · ${hit.text}` })),
          summary: result.truncated ? '结果达到扫描或显示上限' : '',
        };
      }
      if (!pageCount || !pdfVersion) throw new Error('请先生成或打开一份 PDF。');
      if (compiling && pdfSource.kind === 'current') throw new Error('请等待编译完成后再搜索 PDF。');
      const source = pdfSource, version = pdfVersion, epoch = pdfSourceEpoch;
      const args = { id, query, expected_version: version };
      if (source.kind === 'version') {
        args.version_id = source.versionId;
        if (source.reviewPdfVersion) args.review_pdf_version = source.reviewPdfVersion;
      }
      let start = cursor ?? 1;
      let truncated = false;
      const hits = [];
      // Accumulate bounded results across the document, including late hits.
      while (true) {
        signal.throwIfAborted();
        const result = await api('latex_pdf_search', { ...args, start_page: start }, { signal });
        signal.throwIfAborted();
        if (project?.id !== id || epoch !== pdfSourceEpoch || version !== pdfVersion || result.version !== version) throw new Error('预览已变化，请重新搜索。');
        let next = Number.isSafeInteger(result.next_page) && result.next_page > start && result.next_page <= pageCount ? result.next_page : null;
        if (hits.length && hits.length + result.matches.length > MAX_PDF_SEARCH_HITS) {
          next = start;
        } else {
          hits.push(...result.matches);
          truncated ||= result.truncated;
          if (next !== null && hits.length < MAX_PDF_SEARCH_HITS) { start = next; continue; }
        }
        const summary = [truncated ? '部分页面或匹配超出搜索上限' : '', next ? '还有后续页' : ''].filter(Boolean).join(' · ');
        return {
          matches: hits.map(hit => ({ ...hit, label: `第 ${hit.page} 页${hit.text ? ` · ${hit.text}` : ''}` })),
          summary,
          next_cursor: next,
        };
      }
    }

    function sourceSearchRanges() {
      if (!projectSearch || !file || dirty) return [];
      const { matches, active } = projectSearch.results('source');
      const hits = matches.filter(hit => hit.path === file && hit.revision === revision && Number.isSafeInteger(hit.start) && Number.isSafeInteger(hit.end) && hit.start >= 0 && hit.end > hit.start);
      if (!hits.length) return [];
      const text = editor.value;
      const points = [...new Set(hits.flatMap(hit => [hit.start, hit.end]))].sort((a, b) => a - b);
      const offsets = new Map();
      let point = 0, offset = 0;
      for (const wanted of points) {
        while (point < wanted && offset < text.length) {
          offset += text.codePointAt(offset) > 0xffff ? 2 : 1;
          point++;
        }
        if (point === wanted) offsets.set(wanted, offset);
      }
      return hits.filter(hit => offsets.has(hit.end)).map(hit => ({ hit, from: offsets.get(hit.start), to: offsets.get(hit.end), active: hit === active }));
    }

    function patchSourceSearch() {
      if (!disposed) sourceEditor?.setProjectSearchMatches?.(sourceSearchRanges());
    }

    function patchPdfSearch(stage) {
      const number = Number(stage.dataset.page), geometry = pageGeometry[number - 1];
      const results = projectSearch?.results('pdf');
      const hits = results?.matches.filter(hit => hit.page === number) || [];
      if (stage.searchMarks) stage.searchMarks.textContent = '';
      if (!geometry || !hits.length) return;
      if (!stage.searchMarks) {
        stage.searchMarks = make('div', 'latex-search-pdf-marks');
        stage.searchMarks.setAttribute('aria-hidden', 'true');
        stage.append(stage.searchMarks);
      }
      for (const hit of hits) for (const [x0, y0, x1, y1] of hit.rects) {
        const mark = make('span', hit === results.active ? 'latex-search-pdf-hit active' : 'latex-search-pdf-hit');
        Object.assign(mark.style, {
          left: `${x0 / geometry.width * 100}%`, top: `${y0 / geometry.height * 100}%`,
          width: `${(x1 - x0) / geometry.width * 100}%`, height: `${(y1 - y0) / geometry.height * 100}%`,
        });
        stage.searchMarks.append(mark);
      }
    }

    async function revealSearchHit(scope, hit, isCurrent) {
      if (scope === 'source') {
        if (dirty || saving || pendingConflict) throw new Error('请保存当前源码后再定位已保存的搜索结果。');
        if (!await openFile(hit.path, { isCurrent, force: hit.path === file && revision !== hit.revision })) {
          if (isCurrent()) throw new Error('无法打开这条结果的源码。');
          return;
        }
        if (!isCurrent()) return;
        const range = sourceSearchRanges().find(item => item.hit === hit);
        if (!range) throw new Error('源码修订已变化，请重新搜索。');
        if (layout === 'pdf') setLayout('split');
        editor.setSelectionRange(range.from, range.to);
        if (!sourceEditor) {
          editor.focus();
          editor.scrollTop = Math.max(0, (hit.line - 1) * (parseFloat(getComputedStyle(editor).lineHeight) || 21) - editor.clientHeight / 3);
          gutter.scrollTop = editor.scrollTop;
        }
        updateNavigatorActive(hit.line);
        return;
      }
      if (layout === 'source') setLayout('split');
      setTab('pdf');
      await renderPage(hit.page);
      if (!isCurrent()) return;
      const geometry = pageGeometry[hit.page - 1], rect = hit.rects[0];
      const metric = pdfMetrics(previewWidth(preview, zoom))[hit.page - 1];
      if (geometry && metric && rect) {
        const center = (rect[1] + rect[3]) / (2 * geometry.height);
        preview.scrollTop = Math.max(0, metric.top + center * metric.height - preview.clientHeight / 2);
      }
    }

    projectSearch = window.PaperLatexSearch?.create({
      toolbar, topbar, search: searchProject, reveal: revealSearchHit,
      changed: () => {
        patchSourceSearch();
        for (const stage of preview.querySelectorAll('.latex-page-stage')) patchPdfSearch(stage);
      },
    });
    toolbar.append(menuButton, back);

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
      updateNavigatorActive(target);
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
      if (!result.displayCoordinates && (geometry.rotation || result.rotation)) { say('目标页带旋转，无法标注位置。', true); return; }
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
      diagnosticsToggle.textContent = result.ok ? `编译成功${result.syncUnverified ? ' · SyncTeX 待核验' : ''}${lines.length ? ` · ${lines.length} 条错误` : ''}` : `编译失败 · ${lines.length} 条错误`;
      setDiagnosticsOpen(!result.ok);
    }

    function updateAutoToggle() {
      const enabled = settings.latex_auto_compile !== false;
      autoToggle.setAttribute('aria-checked', String(enabled));
      autoToggle.textContent = enabled && autoPaused ? '自动编译已暂停' : '自动编译';
      autoToggle.title = enabled && (autoPaused || lastBuildOk !== true) && project?.exists !== false
        ? '手动编译成功后，停止输入约 2.5 秒会自动编译'
        : '自动编译会在停止输入约 2.5 秒后运行';
    }
    function canAutoCompile() {
      return !!project && project.exists !== false && settings.latex_auto_compile !== false && !autoPaused && lastBuildOk === true;
    }
    function scheduleCompile() {
      clearTimeout(compileTimer);
      if (!canAutoCompile()) return;
      compileTimer = setTimeout(() => { void compileOnce('auto'); }, AUTOCOMPILE_MS);
    }

    async function compileOnce(reason = 'manual') {
      if (project?.exists === false) { say('项目文件夹已不可用；请先修改项目位置。', true); return; }
      if (!project || switching || compiling) { if (compiling) pendingCompile = true; return; }
      // A new setting may be queued while an earlier save is in flight.
      // Wait until the observed tail is still current before using the engine.
      let observedTail;
      do { observedTail = settingsTail; await observedTail; } while (observedTail !== settingsTail);
      if (reason === 'auto' && (!canAutoCompile() || committedSettings.latex_auto_compile === false)) return;
      if (pendingSettings.some(entry => entry.failed && Object.hasOwn(entry.patch, 'latex_engine'))) {
        say('编译引擎设置尚未保存；请先在写作设置中重试。', true); return;
      }
      const engine = committedSettings.latex_engine || 'xelatex';
      if (!project || switching || compiling) { if (compiling) pendingCompile = true; return; }
      if (!await savedBeforeLeaving(true)) return;
      if (reason === 'auto' && !canAutoCompile()) return;
      if (!project || switching || compiling) { if (compiling) pendingCompile = true; return; }
      compiling = true; compile.disabled = true; compile.textContent = '编译中…';
      if (pdfSource.kind === 'current') projectSearch?.reset('pdf');
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
          let syncIssue = '';
          if (pdfSource.kind === 'current' || reason === 'manual') {
            if (pdfSource.kind !== 'current') resetPdfSource({ kind: 'current' });
            else clearRendered();
            if (await loadLayout() && pdfBuild?.verified === false) {
              syncIssue = pdfBuild.reason || '当前 PDF 的源码定位尚未核验。';
              renderDiagnostics({ ...result, syncUnverified: true, warnings: [...new Set([...(result.warnings || []), syncIssue])] });
            }
          }
          if (result.version) { project.reading_project_id = result.version.reading_project_id; void versions?.refresh(); void onVersionSaved(result.version); }
          if (syncIssue || result.version_error) say([syncIssue, result.version_error].filter(Boolean).join(' · '), true);
        } else {
          autoPaused ||= reason === 'auto';
          const failure = result.timed_out ? '编译超时，已停止。'
            : result.exit_code === 0 ? (result.warnings?.[0] || '编译未生成新的可读 PDF。')
            : `编译失败（退出码 ${result.exit_code}）。请看错误与日志尾。`;
          say(failure + (autoPaused ? ' 自动编译已暂停，手动编译成功后会恢复。' : ''), true);
        }
      } catch (error) {
        lastBuildOk = false;
        autoPaused ||= reason === 'auto';
        renderDiagnostics({ ok: false, errors: [String(error.message || error)] });
        say(`编译未完成：${error.message}`, true);
      } finally {
        compiling = false; compile.disabled = false; compile.textContent = '编译';
        updateAutoToggle();
        if (pendingCompile) { pendingCompile = false; scheduleCompile(); }
      }
    }
    // A manual compile is also how the reader resumes from a failed automatic one.
    compile.addEventListener('click', () => { void compileOnce('manual'); });

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
    locationPick.addEventListener('click', async () => {
      const id = project?.id, epoch = generation;
      if (!id || switching || compiling) return;
      locationPick.disabled = true;
      try {
        const picked = await api('latex_ws_pick_folder', {});
        if (id !== project?.id || epoch !== generation || disposed) return;
        if (picked.cancelled) say('没有选择文件夹。');
        else { locationRoot.value = picked.path; locationRoot.focus(); }
      } catch (error) { if (id === project?.id && epoch === generation) say(`无法打开文件夹选择对话框：${error.message}`, true); }
      finally { locationPick.disabled = !project; }
    });
    async function pickMainFile(input, button, boundProject = false) {
      const id = project?.id, epoch = generation;
      if (boundProject && (!id || switching || compiling)) return;
      button.disabled = true;
      try {
        const picked = await api('latex_ws_pick_tex', {});
        if (disposed || (boundProject && (id !== project?.id || epoch !== generation))) return;
        if (picked.cancelled) say('没有选择主文件。');
        else { input.value = picked.path; input.focus(); }
      } catch (error) { if (!disposed && (!boundProject || id === project?.id && epoch === generation)) say(`无法打开主文件选择对话框：${error.message}`, true); }
      finally { button.disabled = boundProject && !project; }
    }
    locationMainPick.addEventListener('click', () => void pickMainFile(locationMain, locationMainPick, true));
    newMainPick.addEventListener('click', () => void pickMainFile(newMain, newMainPick));
    locationSave.addEventListener('click', async () => {
      const root = locationRoot.value.trim(), main = locationMain.value.trim(), id = project?.id;
      if (!id || switching || compiling) return;
      if (!root || !main) { say('请填写项目文件夹和主文件路径。', true); return; }
      if (ai.busy || ai.proposal) { say('DSH 写作正在运行或有待处理的修改提案；请先完成或放弃。', true); return; }
      const previousDisabled = editor.disabled;
      switching = true; editor.disabled = true; locationRoot.disabled = locationMain.disabled = locationPick.disabled = locationMainPick.disabled = locationSave.disabled = true; mainSelect.disabled = true; compile.disabled = true;
      let changed = false;
      try {
        if (!await savedBeforeLeaving(true) || id !== project?.id || disposed) return;
        cancelTranslation(); cancelReads(); generation += 1;
        const result = await api('latex_project_update', { id, root, main_path: main });
        if (disposed || id !== project?.id) return;
        project = result.project; projects = projects.map(item => item.id === id ? project : item);
        changed = true; syncLocationFields();
        resetPdfSource({ kind: 'current' });
        errors.textContent = ''; diagnosticsToggle.hidden = true; setDiagnosticsOpen(false);
        reviewer?.reset(); formulas?.clear(); formulas?.close(); pdfBuild = null; updateSyncHint();
        file = null; revision = null; editor.value = ''; editor.disabled = true;
        page = 1; pageGeometry = []; setPreviewMessage('读取项目…');
        await loadTree();
        if (!await openFile(project.main_path, { duringSwitch: true })) throw new Error('主文件未能载入');
        if (project.pdf_present) await loadLayout(); else setPreviewMessage('这个主入口还没有 PDF；点「编译」生成。');
        lastBuildOk = project.pdf_present ? true : null; autoPaused = false; updateAutoToggle();
        say(`已更新项目位置：${project.main_path}`); void reviewer?.refresh();
      } catch (error) {
        if (!disposed) say(changed ? `项目位置已更新，但读取失败：${error.message}。可刷新项目导航。` : `项目位置未修改：${error.message}`, true);
      } finally {
        switching = false; locationRoot.disabled = locationMain.disabled = locationPick.disabled = locationMainPick.disabled = locationSave.disabled = !project; mainSelect.disabled = compile.disabled = project?.exists === false;
        if (!changed) editor.disabled = previousDisabled;
      }
    });
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
        const created = await api('latex_project_create', { root, ...(newMain.value.trim() ? { main_path: newMain.value.trim() } : {}), ...(newTitle.value.trim() ? { title: newTitle.value.trim() } : {}), create_missing: newStarter.checked });
        newRoot.value = ''; newMain.value = ''; newTitle.value = ''; closeMenu();
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
    settingAccent.addEventListener('change', () => {
      if (settingAccent.value === 'custom') { settingAccentColor.hidden = false; settingAccentColor.focus(); }
      else void saveSetting({ latex_accent: settingAccent.value });
    });
    settingAccentColor.addEventListener('change', () => void saveSetting({ latex_accent: settingAccentColor.value }));
    function setAutoCompile(enabled) {
      void saveSetting({ latex_auto_compile: enabled });
      scheduleCompile();
    }
    settingAuto.addEventListener('change', () => { void setAutoCompile(settingAuto.checked); });
    autoToggle.addEventListener('click', () => { void setAutoCompile(settings.latex_auto_compile === false); });

    // ---- DSH questions and co-writing ----------------------------------------------
    const ai = { available: false, busy: false, models: [], proposal: null, checked: false, lastRoute: null, entries: [] };
    let aiRequest = 0, aiAbort = null;
    function aiOwner(path = file) { return { id: project?.id, main: project?.main_path, root: project?.root, binding_generation: project?.binding_generation, epoch: generation, path }; }
    function ownsAi(owner) { return !disposed && !view.hidden && owner.id === project?.id && owner.main === project?.main_path && owner.root === project?.root && owner.binding_generation === project?.binding_generation && owner.epoch === generation; }
    function showCollaboration(owner = aiOwner()) {
      if (!ownsAi(owner)) return;
      const proposal = ai.proposal;
      reviewer?.setCollaboration(ai.entries, owner, proposal ? { noteId: proposal.review_note?.id, created: proposal.created, element: proposalBox } : null);
    }
    function rememberCollaboration(entry, owner) {
      if (!entry || !ownsAi(owner)) return;
      const identity = value => JSON.stringify([value.kind, value.created, value.review_note?.id, value.review_note?.version, value.question, value.summary]);
      ai.entries = [entry, ...ai.entries.filter(value => identity(value) !== identity(entry))].slice(0, 4); showCollaboration(owner);
    }

    function updateRetrievalScope() {
      retrievalPublicOptions.hidden = !retrievalPublic.checked;
      retrievalQueries.disabled = !retrievalPublic.checked;
    }
    function clearPublicRetrieval() { retrievalPublic.checked = false; retrievalQueries.value = ''; updateRetrievalScope(); }
    function requestRetrieval() {
      const queries = retrievalPublic.checked ? retrievalQueries.value.split(/\r\n|\r|\n/).map(line => line.trim()).filter(Boolean) : [];
      if (retrievalPublic.checked && !queries.length) throw new Error('请在检索设置中填写本次公开检索词，或关闭公开学术检索。');
      if (queries.length > 3 || queries.some(query => query.length > 200 || /[\x00-\x1f\x7f]/.test(query) || !/[\p{L}\p{N}]/u.test(query))) throw new Error('公开检索词最多 3 行，每行 200 字，须包含文字或数字。');
      return { project: retrievalProject.checked, public_queries: queries };
    }
    retrievalPublic.addEventListener('change', () => {
      if (!retrievalPublic.checked) { clearPublicRetrieval(); return; }
      updateRetrievalScope(); retrievalQueries.focus();
    });
    updateRetrievalScope();

    function aiSelection() {
      const start = editor.selectionStart, end = editor.selectionEnd;
      if (typeof start !== 'number' || typeof end !== 'number' || end <= start) return undefined;
      const value = editor.value.slice(start, end);
      return value.trim() ? value : undefined;
    }
    let translationConfig = null, translationProject = null, translationRevision = null, translationLoad = 0, translationBusy = false, translationRequest = 0, translationAbort = null;
    function cancelTranslation() { ++translationRequest; translationAbort?.abort(); translationAbort = null; translationBusy = false; sourceTranslate.disabled = false; translateResults.hidden = true; translateBody.textContent = ''; }
    translateClose.addEventListener('click', () => { cancelTranslation(); sourceTranslate.focus(); });
    const translationKey = id => `reader:latex-translation-${id}`;
    async function loadTranslationSettings() {
      const id = project?.id, ticket = ++translationLoad; if (!id) { translateSave.disabled = true; return false; }
      translateSave.disabled = true;
      try {
        const [global, record] = await Promise.all([api('language_settings_get', {}), api('state_get', { key: translationKey(id) })]);
        if (ticket !== translationLoad || project?.id !== id || disposed) return false;
        translationConfig = record.value || { model: null, prompt: '' }; translationProject = id; translationRevision = record.revision;
        translateModel.textContent = ''; const automatic = make('option', '', '跟随语言工具设置'); automatic.value = ''; translateModel.append(automatic);
        const options = Array.isArray(global.models) ? global.models : [];
        const groups = new Map();
        for (const model of options) {
          if (!groups.has(model.provider)) { const group = make('optgroup'); group.label = model.provider; groups.set(model.provider, group); translateModel.append(group); }
          const candidate = /(?:flash|mini|nano|small|lite|haiku)/i.test(`${model.id} ${model.name || ''}`);
          const option = make('option', '', `${model.name || model.id}${candidate ? ' · 轻量候选' : ''}`);
          option.value = JSON.stringify({ provider: model.provider, model: model.id }); groups.get(model.provider).append(option);
        }
        const selected = translationConfig.model ? JSON.stringify(translationConfig.model) : '';
        if (selected && !options.some(model => JSON.stringify({ provider: model.provider, model: model.id }) === selected)) {
          const missing = make('option', '', `${translationConfig.model.provider} / ${translationConfig.model.model}（当前不可用）`); missing.value = selected; translateModel.append(missing);
        }
        translateModel.value = selected; translateTarget.value = ['auto', 'zh-CN', 'en'].includes(translationConfig.target_language) ? translationConfig.target_language : ''; translatePrompt.value = translationConfig.prompt || ''; translateSave.disabled = false; return true;
      } catch (error) { if (ticket === translationLoad) say(`翻译设置读取失败：${error.message}`, true); return false; }
    }
    translateSave.addEventListener('click', async () => {
      const id = project?.id; if (!id || translationProject !== id) return;
      let model = null; try { if (translateModel.value) model = JSON.parse(translateModel.value); } catch { say('请选择可用模型。', true); return; }
      const value = { model, target_language: ['auto', 'zh-CN', 'en'].includes(translateTarget.value) ? translateTarget.value : null, prompt: translatePrompt.value }; translateSave.disabled = true;
      try { const record = await api('state_put', { key: translationKey(id), value, expected_revision: translationRevision }); if (id !== project?.id) return; translationConfig = value; translationRevision = record.revision; say('本项目翻译设置已保存。'); }
      catch (error) { say(`翻译设置未保存；输入仍保留：${error.message}`, true); }
      finally { translateSave.disabled = false; }
    });
    sourceTranslate.addEventListener('click', async () => {
      if (translationBusy || !project || !file) return;
      const id = project.id, path = file, epoch = generation, sourceTicket = fileRequest, start = editor.selectionStart, end = editor.selectionEnd, selection = aiSelection();
      if (!selection) { say('请先在源码中选择要翻译的文字。', true); return; }
      if (selection.length > 8000) { say('选文超过 8000 字符，请缩小范围。', true); return; }
      const ticket = ++translationRequest; translationAbort = new AbortController();
      translationBusy = true; sourceTranslate.disabled = true; translateResults.hidden = false;
      translateHeading.textContent = '选文译文'; translateBody.textContent = '正在翻译所选源码草稿…';
      try {
        if (translationProject !== id && !await loadTranslationSettings()) throw new Error('无法读取翻译设置。');
        if (ticket !== translationRequest || project?.id !== id || file !== path || generation !== epoch || fileRequest !== sourceTicket) return;
        const result = await api('latex_ai_translate', { id, path, selection, ...(['auto', 'zh-CN', 'en'].includes(translationConfig?.target_language) ? { target_language: translationConfig.target_language } : {}), ...(translationConfig?.model ? { model_override: translationConfig.model } : {}), ...(translationConfig?.prompt ? { prompt: translationConfig.prompt } : {}) }, { signal: translationAbort.signal });
        if (ticket !== translationRequest || project?.id !== id || file !== path || generation !== epoch || fileRequest !== sourceTicket || disposed) return;
        translateHeading.textContent = `选文译文 · 来源为编辑草稿${editor.value.slice(start, end) !== selection ? '（源码已变化）' : ''}`;
        translateBody.textContent = ''; translateBody.append(make('p', '', result.answer), make('small', '', `${result.model.provider} / ${result.model.model} · ${result.prompt_version}`));
        const original = make('details'); original.append(make('summary', '', '查看送译原文'), make('p', '', selection)); translateBody.append(original);
        const copy = make('button', 'button subtle', '复制译文'); copy.type = 'button'; copy.addEventListener('click', () => { if (!window.navigator?.clipboard) { say('复制不可用，请选择译文复制。', true); return; } void window.navigator.clipboard.writeText(result.answer).then(() => say('译文已复制。'), error => say(`复制失败：${error.message}`, true)); }); translateBody.append(copy);
      } catch (error) { if (ticket === translationRequest && project?.id === id && file === path && error.name !== 'AbortError') translateBody.textContent = `翻译失败：${error.message}`; }
      finally { if (ticket === translationRequest) { translationAbort = null; translationBusy = false; sourceTranslate.disabled = false; } }
    });
    function aiRoute() {
      const choice = ai.models[Number(aiModel.value)];
      if (!choice) return {};
      return { provider: choice.provider, model: choice.id, ...(choice.reasoningEffort ? { reasoningEffort: choice.reasoningEffort } : {}) };
    }
    function aiBusy(on) {
      ai.busy = on;
      aiModel.disabled = on; aiAccept.disabled = on; aiDiscard.disabled = on;
    }
    function cancelAiRun({ quiet = false } = {}) {
      if (!aiAbort) return false;
      const active = aiAbort; aiAbort = null; ++aiRequest; active.abort(); aiBusy(false);
      reviewer?.cancelCollaboration?.(quiet ? '' : '已停止这条批注的 DSH 操作。');
      return true;
    }
    function resetAiState() {
      cancelAiRun({ quiet: true }); ++aiRequest; aiBusy(false);
      ai.entries = []; ai.proposal = null; ai.checked = false;
      renderProposal(); aiStatusLine.hidden = true; clearPublicRetrieval();
    }
    function appendRetrieval(container, retrieval) {
      const details = window.PaperLatexReview?.retrievalDetails?.(retrieval);
      if (details) container.append(details);
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
      } catch {
        ai.models = [];
        const option = make('option', '', '模型列表不可用'); option.value = ''; aiModel.textContent = ''; aiModel.append(option);
      }
    }

    async function aiStatus() {
      if (!project || ai.checked) return;
      const owner = aiOwner(), request = aiRequest;
      const active = () => ownsAi(owner) && request === aiRequest && !ai.busy;
      try {
        const snapshot = await api('latex_ai_status', { id: owner.id });
        if (!active()) return;
        if (!ai.models.length) await loadModels();
        if (!active()) return;
        ai.checked = true; ai.available = true;
        aiStatusLine.hidden = true;
        ai.proposal = snapshot.proposal || null;
        ai.entries = Array.isArray(snapshot.entries) ? snapshot.entries : [];
        renderProposal();
      } catch (error) {
        if (!active()) return;
        ai.available = false;
        aiStatusLine.textContent = error.code === 'LATEX_AI_INVALID' ? '当前主机未连接 DSH 模型服务' : error.message;
        aiStatusLine.hidden = false;
      }
    }

    function renderProposal() {
      const proposal = ai.proposal;
      aiProposal.textContent = '';
      proposalBox.hidden = !proposal;
      if (!proposal) { detachedProposal.hidden = true; showCollaboration(); return; }
      aiProposal.append(make('strong', 'latex-review-author', `${proposal.model.provider}/${proposal.model.model} · 修改提案（待确认）`), make('p', 'latex-ai-summary', `${proposal.summary} · 目标源码 ${proposal.path} · ${proposal.replacements.length} 处改动`));
      const list = make('ul', 'latex-ai-replacements');
      for (const { find, replace } of proposal.replacements.slice(0, 20)) {
        const item = make('li');
        item.append(make('del', '', find), make('ins', '', replace));
        list.append(item);
      }
      aiProposal.append(list);
      if (proposal.notes) aiProposal.append(make('p', 'latex-ai-notes', proposal.notes));
      appendRetrieval(aiProposal, proposal.retrieval);
      showCollaboration();
    }

    async function aiRun(kind, note) {
      if (ai.busy || !file || !project || switching || view.hidden || disposed) return false;
      if (kind === 'propose' && ai.proposal) {
        throw new Error(detachedProposal.hidden ? '请在对应批注下接受或放弃当前提案。' : '请在「设置」中接受或放弃待处理的旧提案。');
      }
      if (dirty || saving || pendingConflict) throw new Error('请先保存当前源码。');
      const value = kind === 'ask' ? '请根据这条已保存批注与原引用，回答其中的问题并解释相关内容。' : '请依据这条已保存批注，为指定的当前源码提出必要修改；保留原意、引文与证据强度，不猜测旧 PDF 的源码位置。';
      const retrieval = requestRetrieval();
      const owner = aiOwner(note.anchor.kind === 'source' ? note.anchor.path : file), request = ++aiRequest;
      const args = { id: owner.id, path: owner.path, review_note: { id: note.id, version: note.version }, ...aiRoute(), retrieval };
      const controller = new AbortController(); aiAbort = controller;
      if (retrieval.public_queries.length) clearPublicRetrieval();
      aiBusy(true);
      try {
        if (kind === 'ask') {
          const result = await api('latex_ai_ask', { ...args, question: value }, { signal: controller.signal });
          if (!ownsAi(owner) || request !== aiRequest) return false;
          rememberCollaboration(result.entry, owner);
        } else {
          const result = await api('latex_ai_propose', { ...args, instruction: value }, { signal: controller.signal });
          if (!ownsAi(owner) || request !== aiRequest) return false;
          rememberCollaboration(result.entry, owner);
          if (!result.changed) {
            ai.proposal = null; renderProposal(); say('模型认为不需要改动。');
          } else {
            ai.proposal = { ...result.proposal, retrieval: result.proposal.retrieval ?? result.entry?.retrieval }; renderProposal();
          }
        }
        return true;
      } catch (error) {
        if (!ownsAi(owner) || request !== aiRequest) return false;
        throw error;
      } finally {
        if (ownsAi(owner) && request === aiRequest) { aiAbort = null; aiBusy(false); }
      }
    }

    async function aiAcceptProposal() {
      if (ai.busy || !ai.proposal) return;
      if (dirty || saving || pendingConflict || reviewer?.hasDraft()) { say('请先保存或取消当前源码和批注草稿，再接受提案。', true); return; }
      const owner = aiOwner(ai.proposal.path), pending = ai.proposal, request = ++aiRequest;
      aiBusy(true); say('正在写入…');
      try {
        const result = await api('latex_ai_accept', { id: owner.id, proposal_id: pending.id });
        if (!ownsAi(owner)) return;
        rememberCollaboration(result.entry, owner);
        ai.proposal = null; renderProposal();
        if (!await openFile(owner.path, { force: true })) { if(ownsAi(owner))say('提案已写入；本窗口还有未保存内容，请保留草稿并处理保存冲突。', true);return; }
        if (!ownsAi(owner)) return;
        setSaveState('已接受 AI 建议', 'saved');
        say(`已写入（${result.origin}）：${result.written.bytes} 字节`);
        scheduleCompile();
      } catch (error) {
        if (!ownsAi(owner)) return;
        if (error.code === 'STATE_CONFLICT' && error.current) {
          pendingConflict = { path: error.current.path, content: editor.value, current: error.current };
          conflictText.textContent = '提案基于的版本已经变了：请载入最新内容后重新生成提案。';
          conflictBar.hidden = false;
          say('文件已被改动，提案没有写入。', true);
        } else say(`接受提案失败：${error.message}`, true);
      } finally { if (ownsAi(owner) && request === aiRequest) aiBusy(false); }
    }

    aiAccept.addEventListener('click', () => void aiAcceptProposal());
    aiDiscard.addEventListener('click', async () => {
      if (ai.busy || !ai.proposal) return;
      const owner = aiOwner(), pending = ai.proposal, request = ++aiRequest; aiBusy(true);
      try { const result = await api('latex_ai_discard', { id: owner.id, proposal_id: pending.id }); if (!ownsAi(owner)) return; rememberCollaboration(result.entry, owner); }
      catch(error) { if(ownsAi(owner))say(`提案未能放弃：${error.message}`,true);return; }
      finally { if(ownsAi(owner) && request === aiRequest)aiBusy(false); }
      ai.proposal = null; renderProposal(); say('已放弃这份提案');
    });

    view.addEventListener('keydown', event => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') { event.preventDefault(); void flush('manual'); }
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && !event.altKey && ['i', 't'].includes(event.key.toLowerCase()) && !writingContext().blocked) {
        event.preventDefault(); event.key.toLowerCase() === 'i' ? writingTools?.figure({ templateOnly: true }) : writingTools?.table();
      }
      if (event.key === 'Escape') { closeSourceTools(); clearPdfSelection(); }
    });

    /** Enter the workspace: the page becomes the surface, library hidden like the board's focus. */
    async function open(preferred) {
      const intent = ++openRequest, valid = () => intent === openRequest && !disposed;
      if (switching || compiling) return false;
      try {
        if (settingsRevision === null) await loadSettings();
        if (!valid()) return false;
        if (!await refreshProjects(preferred, valid) || !valid()) return false;
        const wanted = preferred || (project?.id && projects.some(item => item.id === project.id) ? project.id : projects[0]?.id);
        if ((project || !view.hidden) && !await savedBeforeLeaving(true)) { projectSelect.value = project?.id || ''; return false; }
        if (!valid()) return false;
        void loadSpelling();
        view.hidden = false;
        document.body.classList.add('latex-focused');
        setTab('pdf');
        if (rail) showRail(true);
        void refreshWorkspace();
        if (wanted) await selectProject(wanted);
        else { project = null; await renderEmpty(); }
        return valid() && (!wanted || currentContext()?.id === wanted);
      } catch (error) {
        if (valid()) { say(`无法打开 LaTeX 项目：${error.message}`, true); if (view.hidden) toast(`无法打开 LaTeX 项目：${error.message}`, true); }
        return false;
      }
    }

    async function close() {
      if (switching) { say('正在更新项目，请稍候再关闭。', true); return; }
      ++openRequest;
      clearTimeout(timer); clearTimeout(compileTimer); closeMenu();
      cancelAiRun();
      if (!await savedBeforeLeaving(true)) return;
      clearPublicRetrieval();
      cancelTranslation();
      projectSearch?.close();
      cancelReads();
      showRail(false, { release: true });
      view.hidden = true;
      document.body.classList.remove('latex-focused');
      notifyContext(true);
    }

    /** Manual annotations and DSH collaboration share one rail and keep their own records. */
    if (rail?.registerPanel) {
      try { rail.registerPanel({ id: 'latex-ai', aliases: ['latex-review'], label: '批注与写作', element: writingPanel }); }
      catch (error) { say(`侧栏不可用：${error.message}`, true); }
    }
    function showRail(open, { release = false } = {}) {
      if (!open) cancelAiRun();
      if (!rail?.setExternal) {
        if (open) { if (layout === 'source') setLayout('split'); setTab('ai'); void reviewer?.refresh(); }
        else if (tab === 'ai') setTab('pdf');
        syncRailToggle();
        return;
      }
      try {
        if (open) {
          rail.setExternal(true);
          rail.show('latex-ai');
          void aiStatus();
          void reviewer?.refresh();
        } else {
          rail.close('latex-ai');
          if (release) rail.setExternal(false);
        }
        syncRailToggle();
      } catch (error) { say(`侧栏不可用：${error.message}`, true); }
    }
    function syncRailToggle() { aiToggle.setAttribute('aria-checked', String(rail ? Boolean(rail.visible?.('latex-ai')) : tab === 'ai')); }
    aiToggle.addEventListener('click', () => {
      const open = rail ? !rail.visible?.('latex-ai') : tab !== 'ai';
      showRail(open);
      if (open) void aiStatus();
    });
    // The rail's own × lives in the rail; keep the toolbar toggle honest about it.
    document.querySelector('.library-pane.shared-reading-sidebar')?.addEventListener('click', event => {
      if (event.target?.id === 'reading-sidebar-close' || event.target?.closest?.('#reading-sidebar-close')) { cancelAiRun(); syncRailToggle(); }
      else if (event.target?.id === 'reading-sidebar-side') syncRailToggle();
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
      current: currentContext,
      refresh: () => open(project?.id),
      /** Used by the acceptance fixture to drive the surface without a real keyboard. */
      testHooks: {
        setProject: id => selectProject(id),
        type: text => { editor.value = text; dirty = true; lineNumbers(); setSaveState('未保存', 'dirty'); return flush('manual'); },
        flush: () => flush('manual'),
        openFile,
        gotoSource,
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
    dispose() { disposed = true; cancelAiRun({ quiet: true }); clearPublicRetrieval(); cancelTranslation(); reviewer?.dispose(); writingTools?.dispose(); formulas?.destroy(); sourceEditor?.destroy(); cancelReads(); clearRendered(); if (mediaUrl) URL.revokeObjectURL(mediaUrl); resizeObserver?.disconnect(); window.removeEventListener('resize', requestResize); window.removeEventListener('beforeunload', protectDraft); document.removeEventListener('selectionchange', pdfSelectionChanged); clearTimeout(timer); clearTimeout(compileTimer); clearTimeout(spellTimer); view.hidden = true; document.body.classList.remove('latex-focused'); },
    };
  }
  return { create };
})();
