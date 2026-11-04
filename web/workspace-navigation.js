'use strict';
// 内容分类共用检索行、路径和已有关系；阅读项目与写作项目分别展示。
window.PaperWorkspaceNavigation = (() => {
  const KINDS = Object.freeze({ paper: '文献', board: '画板', latex: 'LaTeX 写作', project: '阅读项目' });
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
    const { root, catalogRoot, relatedRoot, api, paperSearch, actions } = options, doc = root.ownerDocument;
    const paperSearchHome = paperSearch?.parentNode;
    const actionsHome = actions?.parentNode;
    if (!root || !catalogRoot || !relatedRoot || typeof api !== 'function') throw Error('工作区导航需要导航、目录与关联内容容器。');
    let live = true, section = 'paper', current = null, trail = [], transition = false, intent = 0, pending = null, catalogSequence = 0, relatedSequence = 0;
    const catalogState = Object.fromEntries(['board', 'latex', 'project'].map(kind => [kind, { query: '', draft: '', offset: 0, page: null, busy: false, error: '', warnings: [] }]));
    let related = { groups: {}, busy: false, error: '', warnings: [], truncated: false }, groupRequests = {}, relatedLoaded = false, popup = null;
    const listeners = [];
    const el = (tag, className, text) => { const node = doc.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; };
    const listen = (node, event, fn, options) => { node.addEventListener(event, fn, options); listeners.push(() => node.removeEventListener(event, fn, options)); };
    const button = (text, fn, className = 'workspace-nav-button') => { const node = el('button', className, text); node.type = 'button'; node.addEventListener('click', fn); return node; };
    const nav = el('nav', 'workspace-navigation'); nav.setAttribute('aria-label', '文献、画板、写作与阅读项目导航');
    const roots = el('div', 'workspace-navigation-roots'), crumbs = el('ol', 'workspace-breadcrumbs'); crumbs.setAttribute('aria-label', '关联内容路径');
    const rootButtons = {};
    for (const [kind, label] of Object.entries(KINDS)) {
      if (roots.children.length) { const divider = el('span', 'workspace-root-divider', '/'); divider.setAttribute('aria-hidden', 'true'); roots.append(divider); }
      const control = button(label, () => void selectRoot(kind), 'workspace-root-button'); control.dataset.kind = kind; rootButtons[kind] = control; roots.append(control);
    }
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
    const catalog = el('section', 'workspace-catalog'); catalog.setAttribute('aria-label', '工作区目录');
    const catalogHeader = el('header', 'workspace-section-header'), catalogTitle = el('strong'), catalogRefresh = button('刷新', () => void loadCatalog()); const projectCreate = button('新建阅读项目', () => options.onCreateProject?.()); projectCreate.hidden = true; catalogHeader.append(catalogTitle, projectCreate, catalogRefresh);
    const searchForm = el('form', 'workspace-catalog-search'), search = el('input'); search.type = 'search'; search.maxLength = 200; search.placeholder = '检索名称'; search.setAttribute('aria-label', '检索画板、写作或阅读项目');
    const searchButton = el('button', 'workspace-nav-button', '检索'); searchButton.type = 'submit'; searchForm.append(search, searchButton); if (paperSearch) searchHost.append(paperSearch); searchHost.append(searchForm);
    listen(search, 'input', () => { if (section !== 'paper' && !current) catalogState[section].draft = search.value.slice(0, 200); });
    listen(searchForm, 'submit', event => { event.preventDefault(); if (section === 'paper' || current) return; const state = catalogState[section]; state.draft = search.value.slice(0, 200); state.query = state.draft.trim(); state.offset = 0; void loadCatalog(); });
    const catalogStatus = el('p', 'workspace-nav-status'); catalogStatus.setAttribute('role', 'status');
    const catalogList = el('div', 'workspace-object-list'), catalogPager = el('div', 'workspace-nav-pagination');
    const catalogDescription = el('p', 'workspace-nav-description'); catalogDescription.hidden = true;
    catalog.append(catalogHeader, catalogDescription, catalogStatus, catalogList, catalogPager); catalogRoot.replaceChildren(catalog);
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
    function row(item) {
      const record = el('div', 'workspace-object-row'), open = button(item.title, () => void navigate(item), 'workspace-object-open');
      open.title = item.title; open.disabled = item.missing || transition;
      const detail = [describe(item), item.kind === 'project' && Number.isSafeInteger(item.paper_count) ? `${item.paper_count} 篇文献` : '', item.kind === 'project' ? item.description : ''].filter(Boolean).join(' · '); if (detail) open.append(el('small', 'workspace-object-relation', detail));
      const arrow = el('span', 'workspace-object-arrow', '↗'); arrow.setAttribute('aria-hidden', 'true'); record.append(open, arrow); return record;
    }
    function pager(host, result, action, busy) {
      host.replaceChildren(); if (!result || !result.items.length && !result.offset) return;
      const previous = button('← 上一页', () => action(Math.max(0, result.offset - PAGE))), next = button('下一页 →', () => action(result.offset + PAGE));
      previous.disabled = busy || result.offset === 0; next.disabled = busy || !result.has_more;
      host.append(previous, el('span', '', `${result.items.length ? result.offset + 1 : 0}–${result.offset + result.items.length} / ${count(result)}`), next);
    }
    function renderNavigation() {
      if (paperSearch) paperSearch.hidden = section !== 'paper';
      searchForm.hidden = section === 'paper' || !!current; searchHost.hidden = section !== 'paper' && !!current;
      search.disabled = transition; if (paperSearch) paperSearch.setAttribute('aria-busy', String(transition));
      for (const [kind, control] of Object.entries(rootButtons)) { control.setAttribute('aria-pressed', String(section === kind)); control.disabled = transition; if (section === kind && !current) control.setAttribute('aria-current', 'page'); else control.removeAttribute('aria-current'); }
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
      const visible = section !== 'paper' && !current; catalogRoot.hidden = !visible; if (!visible) return;
      const value = catalogState[section]; catalogTitle.textContent = `${KINDS[section]}${value.page ? ` · ${count(value.page)}` : ''}`;
      projectCreate.hidden = section !== 'project' || typeof options.onCreateProject !== 'function'; projectCreate.disabled = transition;
      catalogDescription.hidden = section !== 'project'; catalogDescription.textContent = '按主题组织阅读与研究文献，可关联画板和写作；LaTeX 写作是单独的写作项目。';
      search.placeholder = `检索${KINDS[section]}`;
      catalogRefresh.disabled = value.busy || transition; search.disabled = transition; searchButton.disabled = value.busy || transition; search.value = value.draft;
      catalogStatus.textContent = [value.busy ? '正在读取…' : '', value.error ? `${value.error}${value.page ? '；仍显示上一次结果。' : ''}` : '', ...value.warnings].filter(Boolean).join(' '); catalogStatus.classList.toggle('is-error', !!value.error);
      catalogList.replaceChildren();
      for (const item of value.page?.items || []) catalogList.append(row(item));
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
      if (!live || current || section === 'paper') return false;
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
      ++catalogSequence; ++relatedSequence; groupRequests = {}; relatedLoaded = false; related = { groups: {}, busy: false, error: '', warnings: [], truncated: false };
      if (next) { section = next.kind; trail = pending && key(pending.target) === key(next) ? pending.trail : [next]; current = next; }
      else { current = null; trail = []; if (confirmedSection) section = confirmedSection; }
      if (current?.kind === 'project') relations.open = true; else if (next) relations.open = false;
      render(); emit(); if (current?.kind === 'project') void loadRelated(); return true;
    }
    async function selectRoot(kind) {
      if (!Object.hasOwn(KINDS, kind) || !live || transition) return false;
      const owner = ++intent; transition = true; renderNavigation();
      try {
        if (await options.prepare?.() === false || !live || owner !== intent) return false;
        if (await options.onRootChange?.(kind) === false || !live || owner !== intent) return false;
        closePopovers(); section = kind; current = null; trail = []; ++catalogSequence; ++relatedSequence; groupRequests = {}; relatedLoaded = false; related = { groups: {}, busy: false, error: '', warnings: [], truncated: false }; render(); emit();
        if (kind !== 'paper') void loadCatalog(); return true;
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
    return { setCurrent, selectRoot, navigate, mountActions, closePopovers, refresh: () => { if (current) { ++relatedSequence; groupRequests = {}; related.busy = false; relatedLoaded = false; if (current.kind === 'project' || popup === 'related') return loadRelated(); renderRelated(); return true; } return loadCatalog(); }, state, dispose() { closePopovers(); mountActions(); live = false; ++intent; ++catalogSequence; ++relatedSequence; for (const remove of listeners) remove(); if (paperSearch && paperSearchHome) { paperSearch.hidden = false; paperSearchHome.append(paperSearch); } if (actions && actionsHome) actionsHome.append(actions); root.replaceChildren(); catalogRoot.replaceChildren(); relatedRoot.replaceChildren(); } };
  }
  return Object.freeze({ create });
})();
