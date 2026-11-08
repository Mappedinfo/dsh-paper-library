(function () {
  'use strict';
  const TYPES = Object.freeze({ paper: '文献', author: '作者', institution: '单位', method: '方法', dataset: '数据', claim: '论点', evidence: '论据', concept: '概念', tag: '标签', observation: '观察', question: '问题', gap: '缺口', metric: '指标', experiment: '实验', task: '任务', topic: '主题', idea: '思路', figure: '图', formula: '公式', project: '项目', expert: '专家' });
  const RELATIONS = Object.freeze({ supports: '支持', contradicts: '矛盾', uses: '使用', evaluates: '评估', derived_from: '源自', explains: '解释', extends: '扩展', cites: '引用', related: '相关', authored_by: '作者为', affiliated_with: '隶属于', published_by: '出版方为', tagged: '标签为', contains: '包含', addresses:'针对', proposes:'提出', reports:'报告', qualifies:'限定', assumes:'假设', defines:'定义', identifies:'识别', motivates:'动机', justifies:'说明依据', measures:'测量', observed_on:'观察于', produced_by:'产生于', measured_by:'以此衡量', for_task:'针对任务', produces:'产出', mentions:'提及', describes:'描述' });
  const EDITABLE_TYPES = ['method', 'dataset', 'claim', 'evidence', 'concept', 'author', 'institution'];
  const EDITABLE_RELATIONS = ['supports', 'contradicts', 'uses', 'evaluates', 'derived_from', 'explains', 'extends', 'cites', 'related', 'authored_by', 'affiliated_with', 'published_by'];
  const SVG = 'http://www.w3.org/2000/svg';
  let instanceSequence = 0;
  const nodeName = node => `${TYPES[node.type] || node.type} · ${node.label}`;
  const relationLabel = relation => RELATIONS[relation] || relation;
  // Approximate 16px system-font advances conservatively. Diagram columns are
  // 180px apart; labels get 144px and the full name stays in title/inspector.
  function labelWidth(value) {
    let width = 0;
    for (const character of value) {
      if (/[\p{Mark}\u200d\ufe0f]/u.test(character)) continue;
      width += /\s/u.test(character) ? 4 : /[ilIjtfr.,:;!'|]/.test(character) ? 5 : /[MWmw@#%&]/.test(character) ? 15 : /[A-Z0-9]/.test(character) ? 11 : /[a-z]/.test(character) ? 9 : 16;
    }
    return width;
  }
  function shortLabel(value, maximum = 144) {
    if (labelWidth(value) <= maximum) return value;
    let result = '', width = 0; const budget = Math.max(0, maximum - 16);
    for (const character of value) { const next = labelWidth(character); if (width + next > budget) break; result += character; width += next; }
    return result + '…';
  }
  function createViewport(bounds = { width: 640, height: 440 }, size = bounds) {
    let width = Math.max(1, size.width || 640), height = Math.max(1, size.height || 440), zoom = 1, x = bounds.width / 2, y = bounds.height / 2;
    function snapshot() {
      const unit = Math.max(bounds.width / width, bounds.height / height) / zoom;
      return { x: x - width * unit / 2, y: y - height * unit / 2, width: width * unit, height: height * unit, zoom };
    }
    function clamp() {
      const view = snapshot(), visibleX = Math.min(bounds.width * .2, view.width * .75), visibleY = Math.min(bounds.height * .2, view.height * .75);
      x = Math.max(-view.width / 2 + visibleX, Math.min(bounds.width + view.width / 2 - visibleX, x));
      y = Math.max(-view.height / 2 + visibleY, Math.min(bounds.height + view.height / 2 - visibleY, y));
    }
    function setZoom(value, anchor = { x: .5, y: .5 }) {
      if (!Number.isFinite(value)) return snapshot();
      anchor = { x: Number.isFinite(anchor?.x) ? Math.max(0, Math.min(1, anchor.x)) : .5, y: Number.isFinite(anchor?.y) ? Math.max(0, Math.min(1, anchor.y)) : .5 };
      const before = snapshot(); zoom = Math.max(.5, Math.min(8, value)); const after = snapshot();
      x += (anchor.x - .5) * (before.width - after.width); y += (anchor.y - .5) * (before.height - after.height); clamp(); return snapshot();
    }
    function pan(dx, dy) { if (Number.isFinite(dx) && Number.isFinite(dy)) { x += dx; y += dy; clamp(); } return snapshot(); }
    function resize(next) { if (Number.isFinite(next.width) && next.width > 0) width = next.width; if (Number.isFinite(next.height) && next.height > 0) height = next.height; return snapshot(); }
    function fit() { zoom = 1; x = bounds.width / 2; y = bounds.height / 2; return snapshot(); }
    return { snapshot, setZoom, pan, resize, fit };
  }
  function statisticsOf(value) {
    const count = number => Number.isSafeInteger(number) && number >= 0;
    const invalid = () => { throw new Error('统计结果不完整，请重新读取。'); };
    if (!value || value.scope !== 'active-library' || !count(value.total_papers)) invalid();
    const total = value.total_papers, years = value.years, citations = value.citations;
    if (!years || !count(years.known) || !count(years.missing) || !count(years.other_count) || years.known + years.missing !== total || !Array.isArray(years.items) || years.items.length > 200) invalid();
    const seenYears = new Set(); let yearSum = years.other_count;
    for (const item of years.items) { if (!item || !Number.isInteger(item.year) || item.year < 1 || item.year > 9999 || !count(item.count) || item.count < 1 || seenYears.has(item.year)) invalid(); seenYears.add(item.year); yearSum += item.count; }
    if (yearSum !== years.known || !citations || !count(citations.known_papers) || !count(citations.missing_papers) || citations.known_papers + citations.missing_papers !== total || !Array.isArray(citations.sources) || citations.sources.length > 3) invalid();
    const seenSources = new Set(); let sourceSum = 0;
    for (const source of citations.sources) {
      if (!source || typeof source.id !== 'string' || !['crossref', 'openalex', 'semantic-scholar'].includes(source.id) || seenSources.has(source.id) || typeof source.label !== 'string' || source.label.length > 80 || !count(source.known) || !count(source.missing) || source.known + source.missing !== total || !Array.isArray(source.buckets) || source.buckets.length !== 6) invalid();
      seenSources.add(source.id); let sum = 0;
      for (const bucket of source.buckets) { if (!bucket || typeof bucket.label !== 'string' || bucket.label.length > 20 || !count(bucket.count)) invalid(); sum += bucket.count; }
      if (sum !== source.known) invalid(); sourceSum += source.known;
    }
    if (citations.known_papers > sourceSum) invalid();
    return value;
  }
  function scopedEdges(graph, nodeId) { return nodeId ? graph.edges.filter(edge => edge.source === nodeId || edge.target === nodeId) : graph.edges; }
  function evidenceSummary(evidence = {}) {
    const parts = [];
    if (Number.isInteger(evidence.page) && evidence.page > 0) parts.push(`PDF 第 ${evidence.page} 页`);
    if (evidence.quote) parts.push(`原文：${evidence.quote}`);
    if (evidence.note) parts.push(`说明：${evidence.note}`);
    if (evidence.source) parts.push(`来源：${evidence.source}`);
    if (evidence.annotation_id) parts.push(`批注：${evidence.annotation_id}`);
    return parts.length ? parts.join('\n') : '尚未补充原文依据';
  }
  function create({ root, api, getPaper, openPaper, navigatePage, navigatePaper, onOpenLibrary, onAnalyze, scope = 'paper', onAddToBoard, toast = () => {} }) {
    if (!root) throw new Error('Knowledge graph requires a mount element');
    const libraryScope = scope === 'library';
    let graph = { nodes: [], edges: [] }, selected = null, edgePage = 0, revision = 0, paperId = null, editing = null, busy = false, catalogOffset = 0;
    let viewport = null, panGesture = null, statistics = null, statisticsFlight = null, statisticsRevision = 0, citationSource = '', focusPaperId = null;
    let readingCursor = {}, readingQuestionOffset = 0;
    const markerId = `kg-arrow-${++instanceSequence}`;
    root.classList.add('knowledge-graph');
    root.innerHTML = `<div class="kg-toolbar"><div><h3>知识图谱</h3><p>记录方法、数据、论点与论据之间的联系。</p></div><div class="kg-actions"><button type="button" class="button subtle" data-kg="extract-references">提取参考文献</button><button type="button" class="button subtle" data-kg="add-board">加入画板</button><button type="button" class="button" data-kg="add-node">＋ 节点</button><button type="button" class="button" data-kg="add-edge">＋ 关系</button></div></div>
      <div class="kg-controls"><label>节点类型 <select data-kg="filter"><option value="">全部类型</option></select></label><button type="button" class="text-button" data-kg="reset">取消聚焦</button></div>
      <div class="kg-legend" data-kg="legend"></div><p class="kg-status" role="status" data-kg="status"></p>
      <div class="kg-canvas" data-kg="canvas"></div><section class="kg-inspector" data-kg="inspector" hidden></section>
      <div class="kg-relations-heading"><h4 data-kg="relations-heading">关系</h4><div><button class="text-button" type="button" data-kg="previous">上一页</button><span data-kg="page"></span><button class="text-button" type="button" data-kg="next">下一页</button></div></div><div class="kg-relations" data-kg="relations"></div>
      <dialog class="kg-dialog" data-kg="dialog"><form data-kg="form"><h3 data-kg="form-title"></h3><div data-kg="node-fields"><label>类型 <select name="type"></select></label><label>名称 <input name="label" maxlength="500" required></label><label>内容说明 <textarea name="description" rows="3" maxlength="4000"></textarea></label></div><div data-kg="edge-fields"><label>起点 <select name="source"></select></label><label>如何联系 <select name="relation"></select></label><label>终点 <select name="target"></select></label></div><fieldset><legend>依据与出处</legend><p class="kg-help">只填写已知信息。没有页码或原文时保留为空，读者记录会与资料字段区分。</p><label>PDF 页码 <input name="page" type="number" min="1" max="100000" placeholder="未记录"></label><label>原文摘录 <textarea name="quote" rows="3" maxlength="4000"></textarea></label><label>依据说明 <textarea name="note" rows="2" maxlength="2000"></textarea></label><label>来源链接或位置 <input name="evidence_source" maxlength="1000"></label><label>批注标识（可选） <input name="annotation_id" maxlength="200"></label></fieldset><p role="alert" class="kg-error" data-kg="error" hidden></p><footer><button type="button" class="button" data-kg="cancel">取消</button><button type="submit" class="button primary" data-kg="save">保存</button></footer></form></dialog>`;
    const el = key => root.querySelector(`[data-kg="${key}"]`), form = el('form'), field = key => form.elements.namedItem(key);
    const dom = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; };
    const option = (value, label) => { const node = dom('option', '', label); node.value = value; return node; };
    const canvas = el('canvas'); canvas.tabIndex = 0; canvas.setAttribute('role', 'group'); canvas.setAttribute('aria-label', '关系图；拖动空白或方向键平移，加减号缩放，0 适应全图，Tab 选择节点');
    const viewTools = dom('div', 'kg-view-tools'), zoomOut = dom('button', 'button subtle', '−'), zoomIn = dom('button', 'button subtle', '＋'), fitButton = dom('button', 'button subtle', '适应全图'), zoomLabel = dom('output', 'kg-zoom', '100%'), selectionLabel = dom('span', 'kg-selection-label', '尚未选择节点');
    zoomOut.type = zoomIn.type = fitButton.type = 'button'; zoomOut.setAttribute('aria-label', '缩小图谱'); zoomIn.setAttribute('aria-label', '放大图谱'); fitButton.dataset.kg = 'fit'; zoomLabel.setAttribute('aria-label', '图谱缩放比例'); selectionLabel.setAttribute('role', 'status');
    viewTools.append(zoomOut, zoomLabel, zoomIn, fitButton, selectionLabel); canvas.before(viewTools);
    const navigationHint = dom('p', 'kg-help kg-navigation-hint', '拖动空白平移 · Ctrl／⌘ + 滚轮缩放 · 方向键平移 · + / − 缩放 · 0 适应全图'); canvas.after(navigationHint);
    const statisticsPanel = dom('section', 'kg-statistics'); statisticsPanel.hidden = !libraryScope; statisticsPanel.setAttribute('aria-label', '全库文献统计'); navigationHint.after(statisticsPanel);
    root.querySelector('h3').textContent = libraryScope ? '全库图谱' : '本文图谱';
    root.querySelector('.kg-toolbar p').textContent = libraryScope ? '跨文献浏览已保存的关系；按目录分批显示，原文依据保留在所属论文中。' : '从全文分析生成方法、数据与证据关系；AI 草稿保留来源、待核对。';
    if (!libraryScope && onOpenLibrary) {
      const globalButton=dom('button','button subtle','查看全库图谱');globalButton.type='button';globalButton.addEventListener('click',()=>onOpenLibrary({focus_id:paperId}));root.querySelector('.kg-actions').prepend(globalButton);
    }
    const graphMode=dom('select');graphMode.setAttribute('aria-label','图谱模式');graphMode.dataset.kg='mode';if(!libraryScope)graphMode.append(option('reading','全文判断'));graphMode.append(option('all','全部关系'),option('citations','论文引用'));el('filter').parentElement.before(graphMode);
    graphMode.addEventListener('change',()=>{el('filter').value='';readingCursor={};readingQuestionOffset=0;void load(getPaper(),catalogOffset);});
    const readingNav=dom('nav','kg-reading-nav'),readingList=dom('section','kg-reading-list');readingNav.setAttribute('aria-label','全文判断导航');readingList.setAttribute('aria-label','全文判断内容');el('status').after(readingNav);el('inspector').after(readingList);
    const retryButton=action('重试读取图谱',()=>void load(getPaper(),catalogOffset),'button subtle');retryButton.hidden=true;el('status').after(retryButton);
    if(!libraryScope&&onAnalyze){const analyze=action('全文分析建图',async()=>{analyze.disabled=true;try{await onAnalyze();}catch(error){status(error.message,true);}finally{analyze.disabled=false;}},'button');analyze.dataset.kg='analyze';root.querySelector('.kg-actions').prepend(analyze);}
    for (const key of ['add-node','add-edge']) if(libraryScope)el(key).hidden=true;
    if (!onAddToBoard) el('add-board').hidden=true;
    const catalogPager=dom('div','kg-catalog-pager'),catalogPrevious=dom('button','button subtle','上一批文献'),catalogNext=dom('button','button subtle','下一批文献');
    catalogPrevious.type=catalogNext.type='button';catalogPager.append(catalogPrevious,catalogNext);catalogPager.hidden=!libraryScope;el('status').after(catalogPager);
    catalogPrevious.addEventListener('click',()=>void load(null,graph.scope?.previous_offset??0));catalogNext.addEventListener('click',()=>void load(null,graph.scope?.next_offset??0));
    for (const [value, label] of Object.entries(TYPES)) el('filter').append(option(value, label));
    for (const value of EDITABLE_TYPES) field('type').append(option(value, TYPES[value]));
    for (const value of EDITABLE_RELATIONS) field('relation').append(option(value, relationLabel(value)));
    function status(text, error = false) { el('status').textContent = text; el('status').classList.toggle('kg-error', error); }
    function action(label, callback, className = 'text-button') { const button = dom('button', className, label); button.type = 'button'; button.addEventListener('click', callback); return button; }
    function applyViewport() {
      const svg = canvas.querySelector('svg'); if (!svg || !viewport) return;
      const value = viewport.snapshot(); svg.setAttribute('viewBox', `${value.x} ${value.y} ${value.width} ${value.height}`);
      canvas.dataset.zoom = String(value.zoom); zoomLabel.value = zoomLabel.textContent = `${Math.round(value.zoom * 100)}%`;
      zoomOut.disabled = value.zoom <= .5; zoomIn.disabled = value.zoom >= 8;
    }
    function resize() { if (viewport) { viewport.resize({ width: canvas.clientWidth || 640, height: canvas.clientHeight || 440 }); applyViewport(); } }
    function fit() { if (viewport) { resize(); viewport.fit(); applyViewport(); } }
    function changeZoom(factor, anchor) { if (viewport) { viewport.setZoom(viewport.snapshot().zoom * factor, anchor); applyViewport(); } }
    zoomOut.addEventListener('click', () => changeZoom(1 / 1.25)); zoomIn.addEventListener('click', () => changeZoom(1.25)); fitButton.addEventListener('click', fit);
    canvas.addEventListener('wheel', event => {
      if ((!event.ctrlKey && !event.metaKey) || !viewport) return;
      event.preventDefault(); const rect = canvas.getBoundingClientRect();
      changeZoom(Math.exp(-Math.max(-100, Math.min(100, event.deltaY)) * .01), { x: (event.clientX - rect.left) / rect.width, y: (event.clientY - rect.top) / rect.height });
    }, { passive: false });
    canvas.addEventListener('keydown', event => {
      if (!viewport || event.ctrlKey || event.metaKey || event.altKey) return;
      const step = viewport.snapshot().width * .08, moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
      if (moves[event.key]) { event.preventDefault(); viewport.pan(...moves[event.key]); applyViewport(); }
      else if (['+', '='].includes(event.key)) { event.preventDefault(); changeZoom(1.25); }
      else if (event.key === '-') { event.preventDefault(); changeZoom(1 / 1.25); }
      else if (event.key === '0' || event.key === 'Home') { event.preventDefault(); fit(); }
    });
    canvas.addEventListener('pointerdown', event => {
      if (!viewport || event.button !== 0 || event.target.closest?.('.kg-node')) return;
      panGesture = { id: event.pointerId, x: event.clientX, y: event.clientY }; canvas.classList.add('is-panning'); canvas.focus({ preventScroll: true });
      try { canvas.setPointerCapture(event.pointerId); } catch {} event.preventDefault();
    });
    canvas.addEventListener('pointermove', event => {
      if (!viewport || panGesture?.id !== event.pointerId) return;
      const value = viewport.snapshot(); viewport.pan((panGesture.x - event.clientX) * value.width / (canvas.clientWidth || 640), (panGesture.y - event.clientY) * value.height / (canvas.clientHeight || 440));
      panGesture.x = event.clientX; panGesture.y = event.clientY; applyViewport();
    });
    const endPan = event => { if (panGesture?.id !== event.pointerId) return; panGesture = null; canvas.classList.remove('is-panning'); try { if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId); } catch {} };
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) canvas.addEventListener(type, endPan);
    function barChart(host, values, label) {
      const svg = document.createElementNS(SVG, 'svg'); svg.setAttribute('viewBox', '0 0 900 230'); svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', label); svg.classList.add('kg-stat-chart');
      const maximum = Math.max(1, ...values.map(value => value.count)), spacing = 840 / Math.max(1, values.length), stride = Math.max(1, Math.ceil(values.length / 14));
      values.forEach((value, index) => {
        const group = document.createElementNS(SVG, 'g'), bar = document.createElementNS(SVG, 'rect'), title = document.createElementNS(SVG, 'title');
        const height = value.count / maximum * 155, x = 36 + index * spacing;
        title.textContent = `${value.label}：${value.count} 篇`; bar.setAttribute('x', String(x)); bar.setAttribute('y', String(178 - height)); bar.setAttribute('width', String(Math.max(1, spacing * .7))); bar.setAttribute('height', String(height));
        if (value.missing) bar.classList.add('is-missing'); group.append(title, bar);
        if (index % stride === 0 || index === values.length - 1 || value.missing) {
          const text = document.createElementNS(SVG, 'text'); text.textContent = value.label; text.setAttribute('x', String(x + spacing * .35)); text.setAttribute('y', '205'); text.style.textAnchor = index === 0 ? 'start' : index === values.length - 1 ? 'end' : 'middle'; group.append(text);
          if (values.length < 20) { const number = document.createElementNS(SVG, 'text'); number.textContent = String(value.count); number.setAttribute('x', String(x + spacing * .35)); number.setAttribute('y', String(168 - height)); group.append(number); }
        }
        svg.append(group);
      }); host.append(svg);
      const details = dom('details', 'kg-stat-data'); details.append(dom('summary', '', '查看统计明细'));
      const table = dom('table'), caption = dom('caption', '', label), head = dom('tr'); head.append(dom('th', '', '分组'), dom('th', '', '文献数')); const thead = dom('thead'); thead.append(head); const tbody = dom('tbody');
      for (const value of values) { const row = dom('tr'); row.append(dom('td', '', value.label), dom('td', '', String(value.count))); tbody.append(row); }
      table.append(caption, thead, tbody); details.append(table); host.append(details);
    }
    function renderStatistics(message = '', error = false) {
      if (!libraryScope) return;
      statisticsPanel.replaceChildren(); const heading = dom('div', 'kg-statistics-heading'); heading.append(dom('h4', '', '全库文献统计'));
      if (statistics) heading.append(dom('span', 'kg-stat-total', `${statistics.total_papers} 篇有效文献`));
      statisticsPanel.append(heading);
      if (message) { const note = dom('p', `kg-status${error ? ' kg-error' : ''}`, message); note.setAttribute('role', 'status'); if (error) note.append(action('重新读取统计', () => void loadStatistics(true))); statisticsPanel.append(note); }
      if (!statistics) return;
      const cards = dom('div', 'kg-statistics-grid'), yearCard = dom('article', 'kg-stat-card'), citationCard = dom('article', 'kg-stat-card');
      const years = statistics.years; yearCard.append(dom('h5', '', '发表年份'), dom('p', 'kg-stat-coverage', `已知 ${years.known} / ${statistics.total_papers} 篇 · 年份缺失 ${years.missing} 篇`));
      const yearValues = [...(years.other_count ? [{ label: '较早年份合计', count: years.other_count }] : []), ...years.items.map(item => ({ label: String(item.year), count: item.count })), { label: '年份缺失', count: years.missing, missing: true }];
      if (statistics.total_papers) barChart(yearCard, yearValues, '按已保存发表年份统计的文献数；缺失年份单列');
      else yearCard.append(dom('p', 'kg-help', '文献库尚无有效文献。'));
      if (years.other_count) yearCard.append(dom('p', 'kg-help', '图中列出最近 200 个已知年份，其余较早年份合并；全库条目均计入。'));
      citationCard.append(dom('h5', '', '已采集引用量'), dom('p', 'kg-stat-coverage', `至少一个来源已知 ${statistics.citations.known_papers} / ${statistics.total_papers} 篇 · 未知 ${statistics.citations.missing_papers} 篇`));
      const sources = statistics.citations.sources.filter(source => source.known > 0);
      if (!sources.length) citationCard.append(dom('p', 'kg-stat-empty', '尚未采集带来源的引用量。未知不计为 0，也不会从当前图中的连线数量推算。'));
      else {
        if (!sources.some(source => source.id === citationSource)) citationSource = sources[0].id;
        const sourceLabel = dom('label', 'kg-stat-source', '统计来源 '), sourceSelect = dom('select'); sourceSelect.setAttribute('aria-label', '引用量统计来源');
        for (const source of sources) sourceSelect.append(option(source.id, `${source.label} · ${source.known} 篇`)); sourceSelect.value = citationSource; sourceLabel.append(sourceSelect); citationCard.append(sourceLabel);
        const chart = dom('div'); citationCard.append(chart);
        const draw = () => { const source = sources.find(value => value.id === citationSource); chart.replaceChildren(); chart.append(dom('p', 'kg-help', `${source.label}：已知 ${source.known} 篇，未采集 ${source.missing} 篇。不同来源分别统计，不相加。`)); barChart(chart, source.buckets, `${source.label} 已保存引用量区间的文献数`); };
        sourceSelect.addEventListener('change', () => { citationSource = sourceSelect.value; draw(); }); draw();
      }
      cards.append(yearCard, citationCard); statisticsPanel.append(cards, dom('p', 'kg-help', '范围为整个有效文献目录，与当前图谱的文献批次无关；只读取已保存元数据，不联网更新。引用量是来源快照，可能随时间变化。'));
    }
    async function loadStatistics(force = false) {
      if (!libraryScope) return;
      if (statisticsFlight && !force) return statisticsFlight;
      if (statistics && !force) return statistics;
      const ticket = ++statisticsRevision; statisticsPanel.setAttribute('aria-busy', 'true'); renderStatistics('正在汇总全库已保存元数据…');
      const task = (async () => {
        try { const result = statisticsOf(await api('graph_statistics', {})); if (ticket === statisticsRevision) { statistics = result; renderStatistics(); } return result; }
        catch (error) { if (ticket === statisticsRevision) renderStatistics(`${statistics ? '保留上次统计；' : ''}统计读取失败：${error.message}`, true); }
        finally { if (ticket === statisticsRevision) { statisticsPanel.setAttribute('aria-busy', 'false'); statisticsFlight = null; } }
      })(); statisticsFlight = task; return task;
    }
    function evidenceContent(parent, entry) {
      parent.append(dom('p', 'kg-provenance', entry.provenance === 'pdf-reference' ? '来自 PDF 参考文献原文 · 未补造题录字段' : ['ai-analysis','analysis-answer','analysis-group'].includes(entry.provenance) ? `AI 分析 · ${entry.review_status==='accepted'?'已核对':'待核对'}` : ['catalog-metadata','catalog-reference'].includes(entry.provenance) ? '来自已保存文献资料' : '读者记录 · 需要结合原文判断'));
      parent.append(dom('p', 'kg-evidence', evidenceSummary(entry.evidence)));
      if (Number.isInteger(entry.evidence?.page) && entry.evidence.page > 0) {
        if (libraryScope && entry.paper_id && navigatePaper) parent.append(action(`打开来源论文第 ${entry.evidence.page} 页`,()=>navigatePaper(entry.paper_id,entry.evidence.page)));
        else if (!libraryScope && getPaper()?.pdf) parent.append(action(`返回 PDF 第 ${entry.evidence.page} 页`, () => navigatePage?.(entry.evidence.page)));
      }
    }
    function renderInspector() {
      const host = el('inspector'), node = graph.nodes.find(node => node.id === selected);
      host.replaceChildren(); host.hidden = !node;
      if (!node) return;
      const heading = dom('div', 'kg-inspector-heading'); heading.append(dom('h4', '', nodeName(node)), action('收起', () => { selected = null; render(); })); host.append(heading);
      if (node.external_reference) host.append(dom('p', 'kg-help', '被引文献尚未匹配库内条目；可以查看参考文献原文与来源页。'));
      if (node.description) host.append(dom('p', 'kg-description', node.description));
      if(node.reading_target)host.append(action(node.reading_target.answer_id?'查看判断图谱':'展开问题',()=>void openReading(node.reading_target),'button'));
      if(node.provenance!=='analysis-group')evidenceContent(host, node);
      if (node.identity_reliable === false) host.append(dom('p', 'kg-help', '同名作者尚缺少可区分的资料。补充 ORCID 或不同单位后，才可为其保存读者关系。'));
      if (node.type === 'paper' && !node.external_reference && node.id !== paperId) host.append(action('打开文献', () => openPaper?.(node.id)));
      if (node.editable && !libraryScope) {
        const actions = dom('div', 'kg-actions');
        actions.append(action('编辑节点', () => showEditor('node', node)), action('删除节点', () => remove('node', node), 'text-button danger')); host.append(actions);
      }
    }
    function openReading(target = {}) {
      if(libraryScope||graphMode.value!=='reading')return;
      if(target.answer_id)readingQuestionOffset=graph.reading?.offset??readingQuestionOffset;
      readingCursor={...(readingCursor.request_id?{request_id:readingCursor.request_id}:{}),...target};
      return load(getPaper());
    }
    function renderReading() {
      const reading=graph.reading,isReading=!libraryScope&&graphMode.value==='reading';
      readingNav.hidden=readingList.hidden=!isReading;readingNav.replaceChildren();readingList.replaceChildren();
      if(!isReading)return;
      readingNav.append(action('问题总览',()=>void openReading(), 'button subtle'));
      if(reading?.question_id){const title=reading.questions?.find(q=>q.id===reading.question_id)?.title||reading.question_id;readingNav.append(dom('span','kg-reading-separator','/'),action(title,()=>void openReading({question_id:reading.question_id,offset:readingQuestionOffset}),'button subtle'));}
      if(reading?.level==='answer')readingNav.append(dom('span','kg-reading-separator','/'),dom('span','','判断与原文证据'));
      const refresh=action('刷新全文图谱',()=>{readingCursor={};readingQuestionOffset=0;void load(getPaper());},'button subtle');refresh.classList.add('kg-reading-refresh');readingNav.append(refresh);
      if(!reading)return;
      if(reading.level==='question'){
        const pager=dom('div','kg-reading-pager'),previous=action('上一页判断',()=>void openReading({question_id:reading.question_id,offset:reading.previous_offset}),'button subtle'),next=action('下一页判断',()=>void openReading({question_id:reading.question_id,offset:reading.next_offset}),'button subtle');previous.disabled=reading.previous_offset==null;next.disabled=reading.next_offset==null;
        pager.append(previous,dom('span','',`第 ${reading.total?Number(reading.offset||0)+1:0}–${Math.min(Number(reading.offset||0)+Number(reading.limit||12),reading.total||0)} 项 / ${reading.total||0} 项`),next);readingNav.append(pager);
      }
      if(reading.level==='overview'){
        const groups=dom('div','kg-reading-groups');
        for(const question of reading.questions||[]){const control=action(`${question.title} · ${question.total} 项`,()=>void openReading({question_id:question.id,offset:0}),'button subtle');control.dataset.questionId=question.id;groups.append(control);}readingList.append(groups);
      }else if(reading.level==='question'){
        for(const entry of graph.nodes.filter(node=>node.reading_target?.answer_id)){
          const card=dom('article','kg-reading-answer');card.dataset.answerId=entry.reading_target.answer_id;
          if(entry.valid===false)card.append(dom('span','kg-reading-check kg-error','未通过原文／结构检查'));
          else if(entry.neutral)card.append(dom('span','kg-reading-check','未报告／不适用'));
          else card.append(dom('span','kg-reading-check','AI 判断 · 待核对'));
          card.append(dom('p','kg-reading-judgment',entry.description||entry.label));
          if(entry.evidence?.page)card.append(dom('span','kg-help',`PDF 第 ${entry.evidence.page} 页`));
          card.append(action('查看判断图谱',()=>void openReading(entry.reading_target),'button subtle'));readingList.append(card);
        }
        if(!reading.total)readingList.append(dom('p','kg-help','此问题没有已保存判断。未完成或撤回的回答不会补成肯定结论。'));
      }else if(reading.level==='answer'){
        const seen=new Set(),nodes=graph.nodes.filter(node=>{if(!node.evidence?.quote)return false;const key=JSON.stringify([node.evidence.page,node.evidence.source,node.evidence.quote]);if(seen.has(key))return false;seen.add(key);return true;});
        if(reading.answer?.judgment&&!nodes.some(n=>n.label===reading.answer.judgment))readingList.append(dom('p','kg-reading-judgment',reading.answer.judgment));
        if(reading.answer?.source_status==='inferred')readingList.append(dom('p','kg-help','读者推断／待核对问题，尚非作者报告事实。'));
        for(const entry of nodes){const card=dom('article','kg-reading-source');card.append(dom('h4','',entry.label));evidenceContent(card,entry);readingList.append(card);}
        for(const item of reading.limitations||[]){const text=typeof item==='string'?item:item.message||item.reason||item.code;readingList.append(dom('p','kg-help',text));}
      }
    }
    function renderRelations() {
      const values = scopedEdges(displayGraph(), selected), nodeById = new Map(graph.nodes.map(node => [node.id, node]));
      const pages = Math.max(1, Math.ceil(values.length / 20)); edgePage = Math.min(edgePage, pages - 1);
      el('relations-heading').textContent = `${selected ? '此节点的关系' : '关系'} · ${values.length}`;
      el('page').textContent = `${edgePage + 1} / ${pages}`; el('previous').disabled = edgePage <= 0; el('next').disabled = edgePage >= pages - 1;
      const host = el('relations'); host.replaceChildren();
      if (!values.length) { host.append(dom('p', 'kg-help', graphMode.value==='reading'?'当前层级没有可绘制关系；未报告、撤回或尚未明确的关系不会推测连线。':'尚无关系。添加节点后，可以明确记录谁支持谁、使用什么方法或数据。')); return; }
      for (const edge of values.slice(edgePage * 20, (edgePage + 1) * 20)) {
        const row = dom('details', 'kg-relation'), summary = dom('summary');
        summary.append(dom('span', 'kg-endpoint', nodeById.get(edge.source)?.label || edge.source), dom('strong', 'kg-relation-name', `— ${relationLabel(edge.relation)} →`), dom('span', 'kg-endpoint', nodeById.get(edge.target)?.label || edge.target));
        row.append(summary); const content = dom('div', 'kg-relation-content'); evidenceContent(content, edge);
        if (edge.editable && !libraryScope) { const actions = dom('div', 'kg-actions'); actions.append(action('编辑关系', () => showEditor('edge', edge)), action('删除关系', () => remove('edge', edge), 'text-button danger')); content.append(actions); }
        else if (edge.legacy) content.append(dom('p', 'kg-help', '原有文献联系，已保留其说明与方向。'));
        row.append(content); host.append(row);
      }
    }
    function displayGraph(){const filter=el('filter').value;const nodes=graph.nodes.filter(node=>(graphMode.value!=='citations'||node.type==='paper')&&(!filter||node.type===filter||node.id===paperId));const ids=new Set(nodes.map(n=>n.id));return {...graph,nodes,edges:graph.edges.filter(e=>ids.has(e.source)&&ids.has(e.target)&&(graphMode.value!=='citations'||e.relation==='cites'))};}
    function renderCanvas() {
      const display=displayGraph(),visible=display.nodes;
      const focusEdges=selected?display.edges.filter(e=>e.source===selected||e.target===selected):focusPaperId?display.edges.filter(e=>e.paper_id===focusPaperId||e.source===focusPaperId||e.target===focusPaperId):[];
      const focusNodes=new Set([selected||focusPaperId,...focusEdges.flatMap(e=>[e.source,e.target])]);const focusIds=new Set(focusEdges.map(e=>e.id)),focused=Boolean(selected||focusPaperId);
      const host = el('canvas'),readingDetail=!libraryScope&&graphMode.value==='reading'&&graph.reading?.level==='answer';host.classList.toggle('is-reading-detail',readingDetail);host.replaceChildren();
      selectionLabel.textContent = selected ? `已选：${graph.nodes.find(node => node.id === selected)?.label || ''}` : focusPaperId?'已高亮本文关系，其他节点淡化':'尚未选择节点';
      if (!visible.length) { viewport = null; host.append(dom('p', 'kg-help', '当前类型没有节点。')); return; }
      const columns = Math.min(10, Math.max(1, Math.ceil(Math.sqrt(visible.length * 1.5)))), rows = Math.ceil(visible.length / columns);
      const rowHeight=100,gridWidth=columns*180+80,gridHeight=Math.max(160,rows*rowHeight+50);
      // 单项证据图保持正常字号；适应视图只收缩大图，不把两三个节点放大成海报。
      const width=readingDetail?Math.max(gridWidth,640,host.clientWidth||0):gridWidth,height=readingDetail?Math.max(gridHeight,300,host.clientHeight||0):gridHeight,positions=new Map();
      const svg = document.createElementNS(SVG, 'svg'); svg.setAttribute('role', 'group'); svg.setAttribute('aria-label', '文献知识图谱，使用 Tab 选择节点查看关系与来源');
      const defs = document.createElementNS(SVG, 'defs'), marker = document.createElementNS(SVG, 'marker'), arrow = document.createElementNS(SVG, 'path');
      marker.setAttribute('id', markerId); marker.setAttribute('viewBox', '0 0 10 10'); marker.setAttribute('refX', '9'); marker.setAttribute('refY', '5'); marker.setAttribute('markerWidth', '5'); marker.setAttribute('markerHeight', '5'); marker.setAttribute('orient', 'auto-start-reverse'); arrow.setAttribute('d', 'M 0 0 L 10 5 L 0 10 z'); marker.append(arrow); defs.append(marker); svg.append(defs);
      visible.forEach((node,index)=>{const row=Math.floor(index/columns),column=index%columns,rowCount=Math.min(columns,visible.length-row*columns);positions.set(node.id,readingDetail?{x:width/2+(column-(rowCount-1)/2)*180,y:height/2+(row-(rows-1)/2)*rowHeight-12}:{x:(column+.5)*180+40,y:row*rowHeight+38});});
      for (const edge of display.edges) {
        const source = positions.get(edge.source), target = positions.get(edge.target); if (!source || !target) continue;
        const dx = target.x - source.x, dy = target.y - source.y, distance = Math.hypot(dx, dy) || 1;
        const line = document.createElementNS(SVG, 'path');
        const x1=source.x+dx/distance*21,y1=source.y+dy/distance*21,x2=target.x-dx/distance*25,y2=target.y-dy/distance*25,bend=Math.min(70,distance*.18);line.setAttribute('d',`M ${x1} ${y1} Q ${(x1+x2)/2-dy/distance*bend} ${(y1+y2)/2+dx/distance*bend} ${x2} ${y2}`); line.setAttribute('marker-end', `url(#${markerId})`);
        line.classList.add('kg-edge'); if (focused) line.classList.add(focusIds.has(edge.id) ? 'is-selected' : 'is-muted'); const title = document.createElementNS(SVG, 'title'); title.textContent = relationLabel(edge.relation); line.append(title); svg.append(line);
      }
      for (const node of visible) {
        const pos = positions.get(node.id), group = document.createElementNS(SVG, 'g'); group.dataset.nodeId = node.id; group.setAttribute('transform', `translate(${pos.x},${pos.y})`); group.setAttribute('tabindex', '0'); group.setAttribute('role', 'button'); group.setAttribute('aria-label', nodeName(node)); group.setAttribute('aria-pressed', String(selected === node.id)); group.classList.add('kg-node', `kg-type-${node.type}`); if (selected === node.id) group.classList.add('is-selected');if(focused)group.classList.add(focusNodes.has(node.id)?'is-highlighted':'is-muted');if(['ai-analysis','analysis-answer','analysis-group'].includes(node.provenance)&&node.review_status!=='accepted')group.classList.add('is-ai-draft');
        const ring = document.createElementNS(SVG, 'circle'); ring.setAttribute('r', '26'); ring.classList.add('kg-selection-ring'); const circle = document.createElementNS(SVG, 'circle'); circle.setAttribute('r', '20');
        const typeText = document.createElementNS(SVG, 'text'); typeText.textContent = TYPES[node.type] || node.type; typeText.setAttribute('y', '4'); typeText.classList.add('kg-node-type');
        const label = document.createElementNS(SVG, 'text'); label.setAttribute('y', '46'); label.classList.add('kg-node-label'); label.textContent = shortLabel(node.label);
        const title = document.createElementNS(SVG, 'title'); title.textContent = nodeName(node); group.append(ring, circle, typeText, label, title);
        group.addEventListener('focus', () => {
          if (!viewport) return; const view = viewport.snapshot(), margin = Math.min(60, view.width / 4, view.height / 4);
          const dx = pos.x < view.x + margin ? pos.x - view.x - margin : pos.x > view.x + view.width - margin ? pos.x - view.x - view.width + margin : 0;
          const dy = pos.y < view.y + margin ? pos.y - view.y - margin : pos.y > view.y + view.height - margin ? pos.y - view.y - view.height + margin : 0;
          if (dx || dy) { viewport.pan(dx, dy); applyViewport(); }
        });
        const choose = () => { selected = node.id; edgePage = 0; render(); [...canvas.querySelectorAll('.kg-node')].find(value => value.dataset.nodeId === selected)?.focus({ preventScroll: true }); }; group.addEventListener('click', choose); group.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); choose(); } }); svg.append(group);
      }
      host.append(svg);
      if (!viewport) {
        const size = { width: host.clientWidth || 640, height: host.clientHeight || 440 }; viewport = createViewport({ width, height }, size);
        // 首次载入完整入框；自动放大会把第一行（包括聚焦论文）裁到画布外。
        viewport.fit();
      }
      applyViewport();
    }
    function render() {
      const types = new Set(graph.nodes.map(node => node.type)), legend = el('legend'); legend.replaceChildren();
      for (const [type, label] of Object.entries(TYPES)) if (types.has(type)) { const item = dom('span', `kg-legend-item kg-type-${type}`); item.append(dom('i'), document.createTextNode(label)); legend.append(item); }
      el('extract-references').hidden = libraryScope; el('extract-references').disabled = busy || !paperId || !getPaper()?.pdf;
      const readingMode=!libraryScope&&graphMode.value==='reading';
      el('filter').parentElement.hidden=readingMode;el('add-node').hidden=el('add-edge').hidden=libraryScope||readingMode;
      el('add-node').disabled = !paperId; el('add-edge').disabled = graph.nodes.length < 2;
      el('reset').disabled=!selected&&!focusPaperId&&!el('filter').value;
      renderCanvas(); renderInspector(); renderRelations();renderReading();
    }
    async function load(item = getPaper(), offset = 0) {
      catalogOffset=offset;
      if(!libraryScope&&paperId!==item?.id){readingCursor={};readingQuestionOffset=0;}
      const requestedMode=graphMode.value;retryButton.hidden=true;
      const run = ++revision; paperId = libraryScope ? null : item?.id || null; selected = null; edgePage = 0; viewport = null; closeEditor(); graph = { nodes: [], edges: [] }; render();
      if (libraryScope) void loadStatistics();
      if (!paperId && !libraryScope) { status('选择一篇文献查看本文图谱，或从顶栏打开全库图谱。'); return; }
      const requestedId = paperId; status(libraryScope ? '正在读取全库图谱…' : '正在读取本文图谱…');
      try {
        catalogPrevious.disabled=catalogNext.disabled=true;
        let referenceNotice='';
        if(!libraryScope&&requestedMode==='citations'&&item?.pdf){
          try {
            const snapshot=await api('graph_references_get',{id:requestedId});
            if(run!==revision||getPaper()?.id!==requestedId||requestedMode!==graphMode.value)return;
            if(!snapshot||snapshot.stale||snapshot.parser_version!==2){
              status('正在从 PDF 参考文献构建引用关系…');
              const extracted=await api('graph_references_extract',{id:requestedId});
              referenceNotice=`已解析 ${extracted.count} 条题录，可绘制 ${extracted.graph_count??extracted.count} 条引用。`;
            }
          } catch(error){referenceNotice=`参考文献未自动更新：${error.message}`;}
          if(run!==revision||getPaper()?.id!==requestedId||requestedMode!==graphMode.value)return;
        }
        const result = requestedMode==='reading'&&!libraryScope?await api('paper_analysis_graph',{id:requestedId,...readingCursor}):await api('graph', { ...(libraryScope ? {offset,...(focusPaperId?{focus_id:focusPaperId}:{})} : {id:requestedId}), view:requestedMode||'all', limit: 100 });
        if (run !== revision || requestedMode!==graphMode.value || (!libraryScope && getPaper()?.id !== requestedId)) return;
        if(requestedMode==='reading'&&result.reading?.request_id)readingCursor.request_id=result.reading.request_id;
        graph = result;if(referenceNotice)graph.warnings=[...(graph.warnings||[]),referenceNotice]; render();catalogPrevious.disabled=graph.scope?.previous_offset==null;catalogNext.disabled=graph.scope?.next_offset==null;
        if(graphMode.value==='citations'&&!graph.edges.length)graph.warnings=[...(graph.warnings||[]),'当前范围尚无已记录的论文引用；共同作者或关键词不作为引用。'];
        if(requestedMode==='reading'){const r=graph.reading;if(!r||r.status==='idle'){status('尚无全文分析记录。点击「全文分析建图」生成，已有记录将直接展示，无需重复调用模型。');return;}if(r.status==='unsupported'){status('这次旧版分析没有逐题判断记录；可切换「全部关系」查看已保存草稿，或点击「全文分析建图」重新分析。');return;}const title=r.questions?.find(q=>q.id===r.question_id)?.title||'';status(`全文 ${r.total_answers||0} 项判断 · ${r.valid_answers||0} 项通过原文校验 · ${r.level==='overview'?'按问题展开查看全部判断':r.level==='question'?`${title} · 当前 ${graph.nodes.filter(n=>n.reading_target?.answer_id).length} / ${r.total||0} 项`:'单项判断的完整证据与关系'}。AI 分析待核对。${graph.warnings?.length?' '+graph.warnings.join(' '):''}`);return;}
        const range=libraryScope ? `全库目录 ${graph.scope?.paper_count ? offset+1 : 0}–${offset+(graph.scope?.paper_count||0)} / ${graph.scope?.total_papers||0} 篇 · ` : '本文 · ';
        status(`${range}${graph.nodes.length} 个节点 · ${graph.edges.length} 条关系。${graph.nodes.some(n=>n.provenance==='ai-analysis'&&n.review_status!=='accepted')?' 虚线节点为 AI 分析草稿，待核对。':''}${graph.truncated ? ' 当前为部分图谱；最多显示 100 个节点，已保存记录仍保留。' : ' 点击节点查看关系和依据。'}${graph.warnings?.length ? ' ' + graph.warnings.join(' ') : ''}`);
      } catch (error) { if (run === revision&&requestedMode===graphMode.value&&(!requestedId||getPaper()?.id===requestedId)){status(`图谱读取失败：${error.message}`, true);retryButton.hidden=false;} }
    }
    function closeEditor() { if (el('dialog').open) el('dialog').close(); editing = null; }
    function showEditor(kind, value = null) {
      if (busy || !paperId || graphMode.value==='reading') return;
      editing = { kind, value, paperId }; form.reset(); el('error').hidden = true;
      el('form-title').textContent = `${value ? '编辑' : '添加'}${kind === 'node' ? '节点' : '关系'}`;
      el('node-fields').hidden = kind !== 'node'; el('edge-fields').hidden = kind !== 'edge'; field('label').required = kind === 'node';
      if (kind === 'node') { field('type').value = value?.type || 'claim'; field('label').value = value?.label || ''; field('description').value = value?.description || ''; }
      else {
        for (const key of ['source', 'target']) { field(key).replaceChildren(); for (const node of graph.nodes) { const choice = option(node.id, nodeName(node)); choice.disabled = node.identity_reliable === false; field(key).append(choice); } }
        const chosen = graph.nodes.find(node => node.id === selected && node.identity_reliable !== false);
        field('source').value = value?.source || chosen?.id || paperId; field('target').value = value?.target || graph.nodes.find(node => node.id !== field('source').value && node.identity_reliable !== false)?.id || ''; field('relation').value = value?.relation || 'supports';
      }
      for (const key of ['page', 'quote', 'note', 'annotation_id']) field(key).value = value?.evidence?.[key] ?? '';
      field('evidence_source').value = value?.evidence?.source || ''; el('dialog').showModal(); (kind === 'node' ? field('label') : field('source')).focus();
    }
    async function save(event) {
      event.preventDefault(); if (busy || !editing) return;
      const task = editing; if (task.paperId !== getPaper()?.id) { closeEditor(); return; }
      const evidence = { page: field('page').value === '' ? null : Number(field('page').value), quote: field('quote').value, note: field('note').value, source: field('evidence_source').value, annotation_id: field('annotation_id').value };
      const args = task.kind === 'node' ? { node_id: task.value?.id, type: field('type').value, label: field('label').value, description: field('description').value } : { edge_id: task.value?.id, source: field('source').value, target: field('target').value, relation: field('relation').value };
      busy = true; el('save').disabled = true; el('error').hidden = true;
      try {
        const result = await api(`graph_${task.kind}_put`, { id: task.paperId, ...args, evidence });
        if (task.paperId === getPaper()?.id) { closeEditor(); await load(); if (task.kind === 'node') { selected = result.id; render(); } toast('已保存图谱记录'); }
      } catch (error) { if (task.paperId === getPaper()?.id) { el('error').textContent = error.message; el('error').hidden = false; } }
      finally { busy = false; el('save').disabled = false; }
    }
    async function remove(kind, value) {
      if (busy || !paperId) return;
      const targetPaper = paperId, name = kind === 'node' ? '节点及其关联关系' : '这条关系';
      if (!window.confirm(`删除${name}？此操作不会修改 PDF。`)) return;
      busy = true;
      try { await api(`graph_${kind}_delete`, { id: targetPaper, [`${kind}_id`]: value.id }); if (targetPaper === getPaper()?.id) { await load(); toast('已删除图谱记录'); } }
      catch (error) { toast(error.message, true); }
      finally { busy = false; }
    }
    el('add-node').addEventListener('click', () => showEditor('node')); el('add-edge').addEventListener('click', () => showEditor('edge'));
    // The board shares this column, so a selected graph node is handed over explicitly
    // rather than dragged: the panel owns its markup and reports the node as it stands.
    el('add-board').addEventListener('click', () => {
      const node = graph.nodes.find(value => value.id === selected);
      if (!node) { toast('请先在知识图谱里选中一个节点。', true); return; }
      if (typeof onAddToBoard !== 'function') { toast('画板尚未连接。', true); return; }
      onAddToBoard(node);
    });
    el('extract-references').addEventListener('click', async () => {
      if (busy || !paperId || !getPaper()?.pdf) return;
      const id = paperId; busy = true; el('extract-references').disabled = true; status('正在读取当前 PDF 的参考文献…');
      try {
        const result = await api('graph_references_extract', { id });
        if (getPaper()?.id !== id) return;
        graphMode.value = 'citations'; el('filter').value = ''; await load(getPaper());
        toast(`已保存 ${result.count} 条题录、${result.graph_count??result.count} 条引用关系，来源 PDF 第 ${result.reference_pages.join('、')} 页。`);
      } catch (error) { if (getPaper()?.id === id) status(`参考文献未更新：${error.message}`, true); }
      finally { busy = false; el('extract-references').disabled = !paperId || !getPaper()?.pdf; }
    });
    el('cancel').addEventListener('click', closeEditor); form.addEventListener('submit', save);
    el('dialog').addEventListener('cancel', event => { if (busy) event.preventDefault(); else editing = null; });
    el('filter').addEventListener('change', () => { viewport = null; const filter = el('filter').value, node = graph.nodes.find(value => value.id === selected); if (filter && node && node.type !== filter && node.id !== paperId) { selected = null; edgePage = 0; } render(); }); el('reset').addEventListener('click', () => { selected = null; focusPaperId=null;el('filter').value='';viewport=null;edgePage = 0; render();fit(); });
    el('previous').addEventListener('click', () => { edgePage = Math.max(0, edgePage - 1); renderRelations(); }); el('next').addEventListener('click', () => { edgePage++; renderRelations(); });
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(resize) : null; observer?.observe(canvas);
    function clear() { readingCursor={};readingQuestionOffset=0;retryButton.hidden=true;++revision; ++statisticsRevision; statistics = null; statisticsFlight = null; statisticsPanel.setAttribute('aria-busy', 'false'); viewport = null; const gesture = panGesture; panGesture = null; canvas.classList.remove('is-panning'); try { if (gesture && canvas.hasPointerCapture(gesture.id)) canvas.releasePointerCapture(gesture.id); } catch {} paperId = null; selected = null; graph = { nodes: [], edges: [] }; closeEditor(); render(); renderStatistics(); status('选择一篇文献查看知识图谱。'); }
    clear(); return { load, showReading:()=>{if(libraryScope)return;graphMode.value='reading';readingCursor={};readingQuestionOffset=0;el('filter').value='';return load(getPaper());}, focusPaper:async id=>{focusPaperId=id||null;graphMode.value='all';el('filter').value='';return load(null,0);}, reload:()=>{ readingCursor={};readingQuestionOffset=0;if(libraryScope)void loadStatistics(true);return load(getPaper(),catalogOffset); }, clear, resize, fit, resetView: fit, getViewport:()=>viewport?.snapshot() || null, selectedNode: () => graph.nodes.find(node => node.id === selected) ?? null };
  }
  window.PaperKnowledgeGraph = Object.freeze({ create, createViewport, statisticsOf, shortLabel, labelWidth, types: TYPES, relations: RELATIONS, evidenceSummary, scopedEdges, relationLabel });
})();
