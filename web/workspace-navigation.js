'use strict';
// 内容分类共用检索行、路径和已有关系；阅读项目与写作项目分别展示。
window.PaperWorkspaceNavigation = (() => {
  const KINDS = Object.freeze({ paper: '文献', dataset: '数据集', board: '画板', latex: 'LaTeX 写作', project: '阅读项目' });
  const ROOTS = Object.freeze({ ...KINDS, notes: '笔记', scholar: '研究人员' });
  const PAGE = 20, TRAIL = 8;
  const key = item => item ? `${item.kind}\u0000${item.id}` : '';
  function target(value) {
    if (!value || !Object.hasOwn(KINDS, value.kind) || typeof value.id !== 'string' || !value.id || value.id.length > 200) throw Error('关联内容的标识无效。');
    return { kind: value.kind, id: value.id, title: String(value.title || value.id).slice(0, 500), ...(typeof value.relation === 'string' ? { relation: value.relation.slice(0, 300) } : {}), ...(value.via && typeof value.via.title === 'string' ? { via: { title: value.via.title.slice(0, 300) } } : {}), missing: value.missing === true, ...(Number.isSafeInteger(value.paper_count) ? { paper_count: value.paper_count } : {}), ...(typeof value.description === 'string' ? { description: value.description.slice(0, 500) } : {}) };
  }
  function page(value, kind) {
    if (!value || !Array.isArray(value.items) || value.items.length > PAGE || !Number.isSafeInteger(value.offset) || value.offset < 0) throw Error('关联内容列表响应无效。');
    const items = value.items.map(target);
    if (items.some(item => item.kind !== kind)) throw Error('关联内容的类别与列表不一致。');
    return { items, offset: value.offset, total: Number.isSafeInteger(value.total) && value.total >= 0 ? value.total : null, known_total: Number.isSafeInteger(value.known_total) && value.known_total >= 0 ? value.known_total : items.length, has_more: value.has_more === true, truncated: value.truncated === true };
  }
  const count = value => value?.total === null ? `至少 ${value.known_total}` : String(value?.total ?? 0);
  function create(options) {
    const { root, catalogRoot, relatedRoot, api, paperSearch, paperHeading, actions } = options, doc = root.ownerDocument;
    const paperHeadingHome = paperHeading?.parentNode;
    const paperSearchHome = paperSearch?.parentNode;
    const actionsHome = actions?.parentNode;
    if (!root || !catalogRoot || !relatedRoot || typeof api !== 'function') throw Error('工作区导航需要导航、目录与关联内容容器。');
    let live = true, section = 'paper', current = null, trail = [], transition = false, intent = 0, pending = null, catalogSequence = 0, relatedSequence = 0;
    const catalogState = Object.fromEntries(['dataset', 'board', 'latex', 'project'].map(kind => [kind, { query: '', draft: '', offset: 0, page: null, busy: false, error: '', warnings: [] }]));
    let related = { groups: {}, busy: false, error: '', warnings: [], truncated: false }, groupRequests = {}, relatedLoaded = false, popup = null;
    const listeners = [];
    const el = (tag, className, text) => { const node = doc.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; };
    const listen = (node, event, fn, options) => { node.addEventListener(event, fn, options); listeners.push(() => node.removeEventListener(event, fn, options)); };
    const button = (text, fn, className = 'workspace-nav-button') => { const node = el('button', className, text); node.type = 'button'; node.addEventListener('click', fn); return node; };
    const nav = el('nav', 'workspace-navigation'); nav.setAttribute('aria-label', '资料库导航');
    const roots = el('div', 'workspace-navigation-roots'), crumbs = el('ol', 'workspace-breadcrumbs'); crumbs.setAttribute('aria-label', '关联内容路径');
    const rootButtons = {}, rootDividers = {};
    let rootsExpanded = false;
    for (const [kind, label] of Object.entries(ROOTS)) {
      if (kind === 'notes' && !options.onNotes) continue;
      if (kind === 'scholar' && !options.scholars) continue;
      if (roots.children.length) { const divider = el('span', 'workspace-root-divider', '/'); divider.setAttribute('aria-hidden', 'true'); roots.append(divider); rootDividers[kind] = divider; }
      const control = button(label, () => void selectRoot(kind), 'workspace-root-button'); control.dataset.kind = kind; rootButtons[kind] = control; roots.append(control);
    }
    const rootKinds = Object.keys(rootButtons);
    const moreRoots = button('»»»', () => { rootsExpanded = !rootsExpanded; renderNavigation(); }, 'workspace-nav-button workspace-root-more');
    roots.append(moreRoots);
    const searchHost = el('div', 'workspace-nav-search'), actionHost = el('div', 'workspace-nav-actions');
    const pathButton = button('路径', () => togglePopup('path'), 'workspace-nav-button workspace-path-toggle');
    const relatedButton = button('关联', () => togglePopup('related'), 'workspace-nav-button workspace-related-toggle');
    const pathPopup = el('section', 'workspace-popup workspace-path-popup'); pathPopup.id = 'workspace-path-popup'; pathPopup.hidden = true; pathPopup.setAttribute('role', 'region'); pathPopup.setAttribute('aria-label', '关联内容路径');
    const popupHeading = (title, close) => { const header = el('header', 'workspace-popup-heading'); header.append(el('strong', '', title), button('×', close, 'workspace-nav-button workspace-popup-close')); header.lastElementChild?.setAttribute('aria-label', '关闭'); return header; };
    pathPopup.append(popupHeading('关联内容路径', () => closePopovers(true)), crumbs);
    pathButton.setAttribute('aria-controls', pathPopup.id); relatedButton.setAttribute('aria-controls', 'workspace-related');
    pathButton.setAttribute('aria-expanded', 'false'); relatedButton.setAttribute('aria-expanded', 'false');
    actionHost.append(pathButton, relatedButton); if (actions) actionHost.append(actions);
    nav.append(roots, searchHost, actionHost, pathPopup); root.replaceChildren(nav);
    if(paperHeading){paperHeading.classList.add('workspace-paper-heading');nav.insertBefore(paperHeading,searchHost);}
    const catalog = el('section', 'workspace-catalog'); catalog.setAttribute('aria-label', '工作区目录');
    const catalogHeader = el('header', 'workspace-section-header'), catalogTitle = el('strong'), catalogRefresh = button('刷新', () => void loadCatalog()); const projectCreate = button('新建阅读项目', () => options.onCreateProject?.()); projectCreate.hidden = true; catalogHeader.append(catalogTitle, projectCreate, catalogRefresh);
    const searchForm = el('form', 'workspace-catalog-search'), search = el('input'); search.type = 'search'; search.maxLength = 200; search.placeholder = '检索名称'; search.setAttribute('aria-label', '检索工作区目录');
    const searchButton = el('button', 'workspace-nav-button', '检索'); searchButton.type = 'submit'; searchForm.append(search, searchButton); if (paperSearch) searchHost.append(paperSearch); searchHost.append(searchForm);
    listen(search, 'input', () => { if (catalogState[section] && !current) catalogState[section].draft = search.value.slice(0, 200); });
    listen(searchForm, 'submit', event => { event.preventDefault(); const state = catalogState[section]; if (!state || current) return; state.draft = search.value.slice(0, 200); state.query = state.draft.trim(); state.offset = 0; void loadCatalog(); });
    const catalogStatus = el('p', 'workspace-nav-status'); catalogStatus.setAttribute('role', 'status');
    const catalogList = el('div', 'workspace-object-list'), catalogPager = el('div', 'workspace-nav-pagination');
    const catalogDescription = el('p', 'workspace-nav-description'); catalogDescription.hidden = true;
    const datasetActions = el('div', 'workspace-dataset-actions');
    catalog.append(catalogHeader, datasetActions, catalogDescription, catalogStatus, catalogList, catalogPager); catalogRoot.replaceChildren(catalog);
    const relations = el('details', 'workspace-related'), relatedSummary = el('summary'), relatedBody = el('div', 'workspace-related-body');
    relatedSummary.setAttribute('aria-label', '关联子内容'); relations.append(relatedSummary, relatedBody);
    const relatedHeading = popupHeading('关联内容', () => closePopovers(true));
    relatedRoot.id ||= 'workspace-related'; relatedRoot.replaceChildren(relatedHeading, relations);
    const popupTrigger = value => value === 'path' ? pathButton : relatedButton;
    function placePopovers() {
      if (!popup) return;
      window.PaperFloatingWindows?.placeBelow(popupTrigger(popup), popup === 'path' ? pathPopup : relatedRoot);
    }
    function closePopovers(focus = false) {
      const previous = popup; popup = null; pathPopup.hidden = true;
      if (current?.kind !== 'project') relatedRoot.hidden = true;
      pathButton.setAttribute('aria-expanded', 'false'); relatedButton.setAttribute('aria-expanded', 'false');
      if (focus && previous) popupTrigger(previous).focus();
    }
    function mountActions(host = nav) {
      if (actionHost.parentNode === host) return;
      closePopovers();
      if (host === nav) nav.insertBefore(actionHost, pathPopup);
      else host.append(actionHost);
    }
    function togglePopup(value) {
      if (!live || transition || !current) return;
      if (popup === value) { closePopovers(true); return; }
      closePopovers(); popup = value;
      pathPopup.hidden = value !== 'path'; if (value === 'related') relatedRoot.hidden = false;
      popupTrigger(value).setAttribute('aria-expanded', 'true');
      if (typeof window.CustomEvent === 'function') doc.dispatchEvent(new window.CustomEvent('paper-library:workspace-popup', { detail: { id: value === 'path' ? pathPopup.id : relatedRoot.id } }));
      placePopovers();
      if (value === 'related' && !relatedLoaded && !related.busy) void loadRelated();
    }
    if (doc.addEventListener) {
      listen(doc, 'click', event => { if (popup && !pathPopup.contains(event.target) && !relatedRoot.contains(event.target) && !pathButton.contains(event.target) && !relatedButton.contains(event.target)) closePopovers(); });
      listen(doc, 'keydown', event => { if (popup && event.key === 'Escape') { event.preventDefault(); closePopovers(true); } });
      listen(doc, 'paper-library:workspace-popup', event => { if (![pathPopup.id, relatedRoot.id].includes(event.detail?.id)) closePopovers(); });
      listen(doc, 'scroll', placePopovers, true);
    }
    if (window.addEventListener) listen(window, 'resize', placePopovers);
    const state = () => ({ section, current: current ? { ...current } : null, trail: trail.map(item => ({ ...item })) });
    const emit = () => { if (live) options.onChange?.(state()); };
    const warnings = value => Array.isArray(value) ? value.filter(text => typeof text === 'string').slice(0, 6).map(text => text.slice(0, 300)) : [];
    function describe(item) { const embedded = item.via?.title && item.relation?.includes('阅读项目') && item.relation.includes(item.via.title); return [item.relation, item.via?.title && !embedded ? `经阅读项目：${item.via.title}` : '', item.missing ? '原内容已不可用' : ''].filter(Boolean).join(' · '); }
    function row(item, inCatalog = false) {
      const record = el('div', 'workspace-object-row'), open = button(item.title, () => void navigate(item), 'workspace-object-open');
      open.title = item.title; open.disabled = item.missing || transition;
      const detail = [describe(item), item.kind === 'project' && Number.isSafeInteger(item.paper_count) ? `${item.paper_count} 篇文献` : '', item.kind === 'project' ? item.description : ''].filter(Boolean).join(' · '); if (detail) open.append(el('small', 'workspace-object-relation', detail));
      const arrow = el('span', 'workspace-object-arrow', '↗'); arrow.setAttribute('aria-hidden', 'true'); record.append(open, arrow);
      if (inCatalog && item.kind === 'dataset') options.decorateDatasetRow?.(record, item);
      return record;
    }
    function pager(host, result, action, busy) {
      host.replaceChildren(); if (!result || !result.items.length && !result.offset) return;
      const previous = button('← 上一页', () => action(Math.max(0, result.offset - PAGE))), next = button('下一页 →', () => action(result.offset + PAGE));
      previous.disabled = busy || result.offset === 0; next.disabled = busy || !result.has_more;
      host.append(previous, el('span', '', `${result.items.length ? result.offset + 1 : 0}–${result.offset + result.items.length} / ${count(result)}`), next);
    }
    function renderNavigation() {
      if (paperSearch) paperSearch.hidden = section !== 'paper';
      if (paperHeading) paperHeading.hidden = section !== 'paper';
      searchForm.hidden = !catalogState[section] || !!current; searchHost.hidden = section !== 'paper' && searchForm.hidden;
      search.disabled = transition; if (paperSearch) paperSearch.setAttribute('aria-busy', String(transition));
      const primary = rootKinds.includes(section) ? new Set([section, ...rootKinds.filter(kind => kind !== section).slice(0, 2)]) : new Set(rootKinds.slice(0, 3));
      for (const [kind, control] of Object.entries(rootButtons)) {
        control.hidden = !rootsExpanded && !primary.has(kind);
        if (rootDividers[kind]) rootDividers[kind].hidden = control.hidden;
        control.setAttribute('aria-pressed', String(section === kind)); control.disabled = transition;
        if (section === kind && !current) control.setAttribute('aria-current', 'page'); else control.removeAttribute('aria-current');
      }
      moreRoots.hidden = rootKinds.length <= 3; moreRoots.disabled = transition;
      moreRoots.textContent = rootsExpanded ? '«««' : '»»»';
      moreRoots.setAttribute('aria-expanded', String(rootsExpanded));
      moreRoots.setAttribute('aria-label', rootsExpanded ? '收起其他工作区入口' : '展开其他工作区入口');
      moreRoots.title = rootsExpanded ? '收起其他入口' : '展开其他入口';
      pathButton.hidden = !current; relatedButton.hidden = !current || current.kind === 'project'; actionHost.hidden = !current && (!actions || actions.hidden);
      pathButton.disabled = transition; relatedButton.disabled = transition;
      pathButton.title = current ? `${KINDS[current.kind]} · ${current.title}` : '关联内容路径';
      relatedButton.title = '按需查看此条目的关联文献、画板、写作与阅读项目';
      crumbs.replaceChildren(); crumbs.hidden = !current;
      for (let i = 0; i < trail.length; i++) {
        const item = trail[i], part = el('li');
        if (i) { const separator = el('span', 'workspace-crumb-divider', '›'); separator.setAttribute('aria-hidden', 'true'); part.append(separator); }
        if (i === trail.length - 1) { const label = el('span', 'workspace-current-title', item.title); label.setAttribute('aria-current', 'page'); label.title = `${KINDS[item.kind]} · ${item.title}`; part.append(label); }
        else { const ancestor = button(item.title, () => void navigate(item), 'workspace-crumb-button'); ancestor.title = `${KINDS[item.kind]} · ${item.title}`; ancestor.disabled = transition; part.append(ancestor); }
        crumbs.append(part);
      }
    }
    function renderCatalog() {
      const visible = Boolean(catalogState[section]) && !current; catalogRoot.hidden = !visible; if (!visible) return;
      const value = catalogState[section]; catalogTitle.textContent = `${KINDS[section]}${value.page ? ` · ${count(value.page)}` : ''}`;
      projectCreate.hidden = section !== 'project' || typeof options.onCreateProject !== 'function'; projectCreate.disabled = transition;
      catalogDescription.hidden = section !== 'project'; catalogDescription.textContent = '按主题组织阅读与研究文献，可关联画板和写作；LaTeX 写作是单独的写作项目。';
      search.placeholder = `检索${KINDS[section]}`;
      catalogRefresh.disabled = value.busy || transition; search.disabled = transition; searchButton.disabled = value.busy || transition; search.value = value.draft;
      catalogStatus.textContent = [value.busy ? '正在读取…' : '', value.error ? `${value.error}${value.page ? '；仍显示上一次结果。' : ''}` : '', ...value.warnings].filter(Boolean).join(' '); catalogStatus.classList.toggle('is-error', !!value.error);
      datasetActions.hidden = section !== 'dataset';
      if (!datasetActions.hidden) options.datasetCatalogActions?.(datasetActions);
      catalogList.replaceChildren();
      for (const item of value.page?.items || []) catalogList.append(row(item, true));
      if (!value.busy && !value.error && !value.page?.items.length) catalogList.append(el('p', 'workspace-nav-empty', value.query ? '没有找到匹配内容。' : `还没有${KINDS[section]}。`));
      pager(catalogPager, value.page, offset => { value.offset = offset; void loadCatalog(); }, value.busy || transition);
    }
    function renderRelated() {
      const project = current?.kind === 'project';
      relatedRoot.hidden = !current || !project && popup !== 'related';
      relatedRoot.classList.toggle('workspace-popup', !!current && !project); relatedRoot.classList.toggle('workspace-related-popup', !!current && !project);
      relatedRoot.setAttribute('role', 'region'); relatedRoot.setAttribute('aria-label', project ? '阅读项目内容' : '关联内容'); relatedHeading.hidden = !current || project;
      if (project && relatedRoot.style) for (const name of ['position', 'top', 'left', 'right', 'max-width', 'max-height']) relatedRoot.style.removeProperty?.(name);
      if (!current) return;
      const labels = Object.entries(KINDS).filter(([kind]) => kind !== current.kind || related.groups[kind]?.items.length).map(([kind, label]) => related.groups[kind] ? `${label} ${count(related.groups[kind])}` : '').filter(Boolean);
      relatedSummary.textContent = `${current.kind === 'project' ? '项目内容' : '关联内容'}${labels.length ? ` · ${labels.join(' / ')}` : ''}`;
      relations.dataset.kind = current.kind;
      relations.open = true;
      relatedBody.replaceChildren();
      if (current.kind === 'project') relatedBody.append(el('p', 'workspace-nav-description', [current.description, '按主题组织阅读与研究文献；LaTeX 写作是单独的写作项目。'].filter(Boolean).join(' ')));
      const status = el('p', 'workspace-nav-status', [related.busy ? '正在读取关联…' : '', related.error, ...related.warnings].filter(Boolean).join(' ')); status.setAttribute('role', 'status'); status.classList.toggle('is-error', !!related.error); relatedBody.append(status);
      let shown = false;
      for (const [kind, label] of Object.entries(KINDS)) {
        const result = related.groups[kind]; if (!result || kind === current.kind && !result.items.length) continue;
        const group = el('section', 'workspace-related-group'), heading = el('h4', '', `${label} · ${count(result)}`); group.append(heading);
        for (const item of result.items) { group.append(row(item)); shown = true; }
        if (!result.items.length) group.append(el('p', 'workspace-nav-empty', result.truncated || related.truncated ? '当前范围未找到关联。' : '暂无已登记关联。'));
        const pagination = el('div', 'workspace-nav-pagination'); pager(pagination, result, offset => void loadRelated(kind, offset), related.busy || groupRequests[kind]?.busy || transition); group.append(pagination); relatedBody.append(group);
      }
      if (!shown && !Object.keys(related.groups).length && !related.busy && !related.error) relatedBody.append(el('p', 'workspace-nav-empty', relatedLoaded ? '暂无已登记关联。' : '打开后读取已有联系。'));
      placePopovers();
    }
    function render() { renderNavigation(); renderCatalog(); renderRelated(); }
    async function loadCatalog() {
      if (!live || current || !catalogState[section]) return false;
      const kind = section, value = catalogState[kind], query = value.query, offset = value.offset, owner = ++catalogSequence;
      value.busy = true; value.error = ''; renderCatalog();
      try {
        const result = await api('workspace_catalog', { kind, query, offset, limit: PAGE });
        if (!live || current || section !== kind || owner !== catalogSequence || query !== value.query || offset !== value.offset) return false;
        value.page = page(result, kind); value.warnings = warnings(result.warnings); if (result.truncated && !value.warnings.length) value.warnings.push('当前目录仅覆盖已读取的范围。'); return true;
      } catch (error) { if (live && owner === catalogSequence && section === kind && !current) value.error = error.message || '读取目录失败'; return false; }
      finally { if (live && owner === catalogSequence) { value.busy = false; renderCatalog(); } }
    }
    async function loadRelated(groupKind, offset = 0) {
      if (!live || !current) return false;
      const owner = relatedSequence, focus = { ...current }, focusKey = key(focus), groupOwner = (groupRequests[groupKind || '*']?.sequence || 0) + 1;
      groupRequests[groupKind || '*'] = { sequence: groupOwner, busy: true };
      if (!groupKind) related.busy = true; related.error = ''; renderRelated();
      const stillCurrent = () => live && owner === relatedSequence && key(current) === focusKey && groupRequests[groupKind || '*']?.sequence === groupOwner;
      try {
        const result = await api('workspace_related', { kind: focus.kind, id: focus.id, offset, limit: PAGE, ...(groupKind ? { group_kind: groupKind } : {}) });
        if (!stillCurrent()) return false;
        if (result.focus && key(result.focus) !== focusKey) throw Error('关联内容与当前条目不一致。');
        const groups = {}; for (const kind of Object.keys(KINDS)) { if (result.groups?.[kind]) groups[kind] = page(result.groups[kind], kind); }
        related.groups = groupKind ? { ...related.groups, ...(groups[groupKind] ? { [groupKind]: groups[groupKind] } : {}) } : groups;
        related.warnings = warnings(result.warnings); related.truncated = result.truncated === true; relatedLoaded = true; return true;
      } catch (error) { if (stillCurrent()) related.error = `${error.message || '读取关联失败'}${Object.keys(related.groups).length ? '；已有列表保留。' : ''}`; return false; }
      finally { if (stillCurrent()) { groupRequests[groupKind || '*'].busy = false; if (!groupKind) related.busy = false; renderRelated(); } }
    }
    function nextTrail(item) { const at = trail.findIndex(value => key(value) === key(item)); return at >= 0 ? trail.slice(0, at + 1) : [...trail, item].slice(-TRAIL); }
    function setCurrent(value, { section: confirmedSection } = {}) {
      if (!live) return false;
      const next = value == null ? null : target(value), same = key(next) === key(current);
      if (confirmedSection !== undefined && !Object.hasOwn(KINDS, confirmedSection)) throw Error('工作区类别无效。');
      if (next && transition && (!pending || key(pending.target) !== key(next))) { ++intent; pending = null; transition = false; }
      if (same && (confirmedSection === undefined || confirmedSection === section)) { if (next && next.title !== current.title) { current = next; trail[trail.length - 1] = next; renderNavigation(); emit(); } return true; }
      closePopovers();
      rootsExpanded = false;
      ++catalogSequence; ++relatedSequence; groupRequests = {}; relatedLoaded = false; related = { groups: {}, busy: false, error: '', warnings: [], truncated: false };
      if (next) { section = next.kind; trail = pending && key(pending.target) === key(next) ? pending.trail : [next]; current = next; }
      else { current = null; trail = []; if (confirmedSection) section = confirmedSection; }
      if (current?.kind === 'project') relations.open = true; else if (next) relations.open = false;
      render(); emit(); if (current?.kind === 'project') void loadRelated(); return true;
    }
    async function selectRoot(kind) {
      if (!Object.hasOwn(rootButtons, kind) || !live || transition) return false;
      const owner = ++intent; transition = true; renderNavigation();
      try {
        if (await options.prepare?.() === false || !live || owner !== intent) return false;
        if (await options.onRootChange?.(kind) === false || !live || owner !== intent) return false;
        closePopovers(); rootsExpanded = false; section = kind; current = null; trail = []; ++catalogSequence; ++relatedSequence; groupRequests = {}; relatedLoaded = false; related = { groups: {}, busy: false, error: '', warnings: [], truncated: false }; render(); emit();
        if (kind === 'notes') void options.onNotes();
        else if (catalogState[kind]) void loadCatalog();
        return true;
      } catch (error) { options.toast?.(error.message || '切换工作区失败', true); return false; }
      finally { if (live && owner === intent) { transition = false; render(); } }
    }
    async function navigate(value) {
      if (!live || transition) return false;
      let item; try { item = target(value); } catch (error) { options.toast?.(error.message, true); return false; }
      if (item.missing) return false;
      const owner = ++intent; transition = true; pending = { target: item, trail: nextTrail(item) }; render();
      try {
        if (await options.prepare?.() === false || !live || owner !== intent) return false;
        if (await options.onNavigate?.(item) === false || !live || owner !== intent) return false;
        if (key(current) !== key(item)) setCurrent(item); return true;
      } catch (error) { options.toast?.(error.message || '打开关联内容失败', true); return false; }
      finally { if (owner === intent) { pending = null; transition = false; if (live) render(); } }
    }
    render();
    return { setCurrent, selectRoot, navigate, mountActions, renderCatalog, closePopovers, refresh: () => { if (current) { ++relatedSequence; groupRequests = {}; related.busy = false; relatedLoaded = false; if (current.kind === 'project' || popup === 'related') return loadRelated(); renderRelated(); return true; } return loadCatalog(); }, state, dispose() { closePopovers(); mountActions(); live = false; ++intent; ++catalogSequence; ++relatedSequence; for (const remove of listeners) remove(); if (paperSearch && paperSearchHome) { paperSearch.hidden = false; paperSearchHome.append(paperSearch); } if(paperHeading&&paperHeadingHome){paperHeading.hidden=false;paperHeading.classList.remove('workspace-paper-heading');paperHeadingHome.prepend(paperHeading);} if (actions && actionsHome) actionsHome.append(actions); root.replaceChildren(); catalogRoot.replaceChildren(); relatedRoot.replaceChildren(); } };
  }
  return Object.freeze({ create });
})();

window.PaperLibraryNotes = (() => {
  function create({ root, api, getPaper, openNote, toast }) {
    const make = (tag, text, className) => {
      const node = root.ownerDocument.createElement(tag);
      if (text) node.textContent = text;
      if (className) node.className = className;
      return node;
    };
    const button = (text, run) => {
      const node = make('button', text, 'button subtle');
      node.type = 'button';
      node.addEventListener('click', run);
      return node;
    };
    const option = (value, title) => {
      const node = make('option', title); node.value = value;
      return node;
    };
    const select = (label, options) => {
      const node = make('select');
      node.setAttribute('aria-label', label);
      node.append(...options.map(([value, title]) => option(value, title)));
      return node;
    };
    const labeled = (title, input) => {
      const label = make('label');
      label.append(make('span', title), input);
      return label;
    };
    const input = (label, placeholder, length) => {
      const node = make('input');
      node.type = 'search'; node.maxLength = length; node.placeholder = placeholder;
      node.setAttribute('aria-label', label);
      return node;
    };

    const head = make('header', '', 'notes-library-heading'), views = make('div', '', 'notes-library-views');
    views.setAttribute('role', 'group'); views.setAttribute('aria-label', '展示样式');
    const cardsButton = button('卡片', () => setView('cards'));
    const tableButton = button('表格', () => setView('table'));
    const refresh = button('刷新', () => void readScope(true));
    views.append(cardsButton, tableButton, refresh);
    head.append(make('h2', '笔记'), views);

    const form = make('form', '', 'notes-library-filters');
    const scope = select('检索范围', [['all','全库'],['paper','当前文献'],['project','阅读项目']]);
    const projects = select('选择阅读项目', [['','选择项目']]), projectField = labeled('项目', projects);
    const category = select('收录条件', [['all','标星或有标签'],['starred','已标星'],['tagged','有标签'],['both','标星且有标签']]);
    const field = select('检索字段', [['all','全部字段'],['content','原文与备注'],['paper','文献标题'],['tags','标签']]);
    const query = input('笔记关键词', '输入关键词', 200);
    const tag = input('筛选标签', '输入或选择标签', 60);
    const tags = make('datalist'); tags.id = 'notes-library-tags';
    tag.setAttribute('list', tags.id);
    const submit = make('button', '搜索', 'button'); submit.type = 'submit';
    form.append(labeled('范围',scope),projectField,labeled('收录',category),labeled('字段',field),labeled('关键词',query),labeled('标签',tag),submit,tags);
    const statusBar = make('div', '', 'notes-library-status'), status = make('p'), coverageStatus = make('span');
    status.setAttribute('role', 'status');
    const pause = button('暂停更新', () => {
      scanController?.abort();
      scanController = null;
      showCoverage(coverage);
    });
    statusBar.append(status,coverageStatus,pause);
    const results = make('div', '', 'notes-library-results'), pager = make('footer', '', 'notes-library-pager');
    const back = button('上一页', () => void loadPage(Math.max(0, offset - 24)));
    const next = button('下一页', () => void loadPage(offset + 24));
    pager.append(back,next);
    root.replaceChildren(head,form,statusBar,results,pager);

    let view = 'cards', offset = 0, scopeTicket = 0, listTicket = 0, active = false;
    let scopeArgs = {}, filters = {}, coverage, lastPage, scanController;
    function setView(value) {
      view = value;
      cardsButton.setAttribute('aria-pressed', String(view === 'cards'));
      tableButton.setAttribute('aria-pressed', String(view === 'table'));
      if (lastPage) render(lastPage);
    }

    function tagButtons(note) {
      const group = make('div', '', 'notes-library-tags');
      for (const label of note.tags) group.append(button('#' + label, () => {
        tag.value = label;
        search();
      }));
      return group;
    }
    function openButton(note) {
      const control = button(`${note.title} · 第 ${note.page} 页`, async () => {
        control.disabled = true;
        try { await openNote(note); } catch (error) { toast(error.message,true); }
        finally { control.disabled = Boolean(note.unavailable); }
      });
      control.classList.add('notes-library-source');
      control.disabled = Boolean(note.unavailable);
      return control;
    }
    function excerpts(note) {
      const content = make('div', '', 'notes-library-excerpts');
      if (note.unavailable) content.append(make('p','原批注暂不可用','muted'));
      if (note.text) content.append(make('blockquote',note.text));
      if (note.comment) content.append(make('p',note.comment,'notes-library-comment'));
      return content;
    }
    function star(note) {
      const mark = make('span', note.favorite ? '★' : '', 'notes-library-star');
      if (note.favorite) { mark.title = '已收藏'; mark.setAttribute('aria-label', '已收藏'); }
      return mark;
    }
    function render(page) {
      results.replaceChildren();
      status.textContent = page.total ? `${page.offset + 1}–${page.offset + page.items.length} / ${page.total} 条` :
        filters.query || filters.tag || filters.category !== 'all' ? '没有匹配的笔记。' : '在阅读侧栏为批注标星或添加标签后，会显示在这里。';
      tags.replaceChildren(...page.tags.map(row=>option(row.tag,`${row.tag} · ${row.total}`)));
      pager.hidden = !page.offset && !page.has_more;
      back.disabled = !page.offset; next.disabled = !page.has_more;
      if (!page.items.length) return;
      if (view === 'cards') {
        const grid = make('div', '', 'notes-library-cards');
        for (const note of page.items) {
          const card = make('article', '', 'notes-library-card'), source = make('header');
          source.append(openButton(note),star(note));
          card.append(source,excerpts(note),tagButtons(note)); grid.append(card);
        }
        results.append(grid);
        return;
      }
      const table = make('table', '', 'notes-library-table'), columns = make('tr'), body = make('tbody');
      for (const name of ['来源', '原文与备注', '标签', '收藏']) {
        const cell = make('th', name); cell.scope = 'col'; columns.append(cell);
      }
      const heading = make('thead'); heading.append(columns); table.append(heading,body);
      for (const note of page.items) {
        const row = make('tr');
        for (const element of [openButton(note),excerpts(note),tagButtons(note),star(note)]) {
          const cell = make('td'); cell.append(element); row.append(cell);
        }
        body.append(row);
      }
      results.append(table);
    }

    function showCoverage(value) {
      coverage = value;
      pause.hidden = !scanController;
      coverageStatus.textContent = value && (value.pending || value.incomplete || scanController)
        ? `${scanController ? '正在更新 · ' : ''}已读取 ${value.indexed} / ${value.documents} 篇 PDF${value.incomplete ? ` · ${value.incomplete} 篇读取不完整` : ''}` : '';
    }
    async function loadPage(value = 0) {
      const request = ++listTicket, epoch = scopeTicket;
      offset = value;
      try {
        const page = await api('annotation_favorites_list', {view:'notes',...scopeArgs,...filters,offset});
        if (!active || epoch !== scopeTicket) return;
        if (request !== listTicket) return page.coverage;
        if (offset && !page.items.length) return loadPage(Math.max(0,offset-24));
        lastPage = page;
        render(page);
        showCoverage(page.coverage);
        return page.coverage;
      } catch (error) {
        if (active && epoch === scopeTicket && request === listTicket) status.textContent = error.message;
      }
    }
    function eligible() {
      return scope.value === 'all' || scope.value === 'paper' && Boolean(scopeArgs.paper_id) ||
        scope.value === 'project' && Boolean(scopeArgs.project_id);
    }
    function search() {
      filters = {query:query.value.trim(),tag:tag.value.trim(),field:field.value,category:category.value};
      if (eligible()) void loadPage();
    }
    async function readScope(retryIncomplete = false) {
      const epoch = ++scopeTicket;
      scanController?.abort(); scanController = null;
      const paper = getPaper();
      scopeArgs = scope.value === 'paper' && paper?.pdf && !paper.archived ? {paper_id:paper.id} :
        scope.value === 'project' && projects.value ? {project_id:projects.value} : {};
      projectField.hidden = scope.value !== 'project';
      results.replaceChildren(); pager.hidden = true; lastPage = null; showCoverage(null);
      if (!eligible()) {
        status.textContent = scope.value === 'project' ? '请选择阅读项目。' : '请先打开一篇有 PDF 的在库文献。';
        return;
      }
      status.textContent = '正在读取笔记…';
      const current = await loadPage();
      if (!active || epoch !== scopeTicket || !(current?.pending || retryIncomplete && current?.incomplete)) return;
      const controller = new AbortController();
      scanController = controller; showCoverage(current);
      let steps = 0, retry = retryIncomplete;
      try {
        let progress;
        do {
          progress = await api('annotation_favorites_list', {view:'notes',prepare:true,...scopeArgs,retry_incomplete:retry}, {signal:controller.signal});
          retry = false;
          if (!active || epoch !== scopeTicket || controller.signal.aborted) return;
          showCoverage(progress);
          if (++steps === 1 || !progress.pending || steps % 4 === 0) await loadPage(offset);
          if (!progress.progressed && progress.pending) throw Error('部分 PDF 正在变化，可稍后刷新。');
          if (progress.pending) await new Promise(resolve => setTimeout(resolve, 100));
        } while (progress.pending && active && epoch === scopeTicket && !controller.signal.aborted);
      } catch (error) {
        if (active && epoch === scopeTicket && !controller.signal.aborted) toast(error.message,true);
      } finally {
        if (scanController === controller) { scanController = null; showCoverage(coverage); }
      }
    }

    async function readProjects() {
      try {
        const rows = [];
        for (let offset=0;offset<500;) {
          const page = await api('project_list',{offset,limit:200});
          if (!active) return;
          rows.push(...page.projects);
          offset += page.projects.length;
          if (!page.projects.length || offset >= page.total) break;
        }
        const value = projects.value;
        projects.replaceChildren(option('','选择项目'),...rows.map(row=>option(row.id,row.title)));
        if (rows.some(row=>row.id===value)) projects.value = value;
        else if (value && scope.value === 'project') void readScope();
      } catch (error) { if (active) toast(error.message,true); }
    }
    form.addEventListener('submit',event=>{event.preventDefault();search();});
    scope.addEventListener('change',()=>{void readScope(); if (scope.value === 'project') void readProjects();});
    projects.addEventListener('change',()=>void readScope());
    for (const control of [category,field,tag]) control.addEventListener('change',search);
    setView(view); pager.hidden = projectField.hidden = pause.hidden = true;
    filters = {query:'',tag:'',field:'all',category:'all'};
    return {
      open() { active = true; void readScope(); if (scope.value === 'project') void readProjects(); },
      close() { active = false; ++scopeTicket; scanController?.abort(); scanController = null; },
    };
  }
  return { create };
})();
