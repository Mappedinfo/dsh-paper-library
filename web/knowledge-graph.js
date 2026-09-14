(function () {
  'use strict';
  const TYPES = Object.freeze({ paper: '文献', author: '作者', institution: '单位', method: '方法', dataset: '数据', claim: '论点', evidence: '论据', concept: '概念', tag: '标签' });
  const RELATIONS = Object.freeze({ supports: '支持', contradicts: '矛盾', uses: '使用', evaluates: '评估', derived_from: '源自', explains: '解释', extends: '扩展', cites: '引用', related: '相关', authored_by: '作者为', affiliated_with: '隶属于', published_by: '出版方为', tagged: '标签为', contains: '包含' });
  const EDITABLE_TYPES = ['method', 'dataset', 'claim', 'evidence', 'concept', 'author', 'institution'];
  const EDITABLE_RELATIONS = ['supports', 'contradicts', 'uses', 'evaluates', 'derived_from', 'explains', 'extends', 'cites', 'related', 'authored_by', 'affiliated_with', 'published_by'];
  const SVG = 'http://www.w3.org/2000/svg';
  const nodeName = node => `${TYPES[node.type] || node.type} · ${node.label}`;
  const relationLabel = relation => RELATIONS[relation] || relation;
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
  function create({ root, api, getPaper, openPaper, navigatePage, toast = () => {} }) {
    if (!root) throw new Error('Knowledge graph requires a mount element');
    let graph = { nodes: [], edges: [] }, selected = null, edgePage = 0, revision = 0, paperId = null, editing = null, busy = false;
    root.classList.add('knowledge-graph');
    root.innerHTML = `<div class="kg-toolbar"><div><h3>知识图谱</h3><p>记录方法、数据、论点与论据之间的联系。</p></div><div class="kg-actions"><button type="button" class="button" data-kg="add-node">＋ 节点</button><button type="button" class="button" data-kg="add-edge">＋ 关系</button></div></div>
      <div class="kg-controls"><label>节点类型 <select data-kg="filter"><option value="">全部类型</option></select></label><button type="button" class="text-button" data-kg="reset">查看全部关系</button></div>
      <div class="kg-legend" data-kg="legend"></div><p class="kg-status" role="status" data-kg="status"></p>
      <div class="kg-canvas" data-kg="canvas"></div><section class="kg-inspector" data-kg="inspector" hidden></section>
      <div class="kg-relations-heading"><h4 data-kg="relations-heading">关系</h4><div><button class="text-button" type="button" data-kg="previous">上一页</button><span data-kg="page"></span><button class="text-button" type="button" data-kg="next">下一页</button></div></div><div class="kg-relations" data-kg="relations"></div>
      <dialog class="kg-dialog" data-kg="dialog"><form data-kg="form"><h3 data-kg="form-title"></h3><div data-kg="node-fields"><label>类型 <select name="type"></select></label><label>名称 <input name="label" maxlength="500" required></label><label>内容说明 <textarea name="description" rows="3" maxlength="4000"></textarea></label></div><div data-kg="edge-fields"><label>起点 <select name="source"></select></label><label>如何联系 <select name="relation"></select></label><label>终点 <select name="target"></select></label></div><fieldset><legend>依据与出处</legend><p class="kg-help">只填写已知信息。没有页码或原文时保留为空，读者记录会与资料字段区分。</p><label>PDF 页码 <input name="page" type="number" min="1" max="100000" placeholder="未记录"></label><label>原文摘录 <textarea name="quote" rows="3" maxlength="4000"></textarea></label><label>依据说明 <textarea name="note" rows="2" maxlength="2000"></textarea></label><label>来源链接或位置 <input name="evidence_source" maxlength="1000"></label><label>批注标识（可选） <input name="annotation_id" maxlength="200"></label></fieldset><p role="alert" class="kg-error" data-kg="error" hidden></p><footer><button type="button" class="button" data-kg="cancel">取消</button><button type="submit" class="button primary" data-kg="save">保存</button></footer></form></dialog>`;
    const el = key => root.querySelector(`[data-kg="${key}"]`), form = el('form'), field = key => form.elements.namedItem(key);
    const dom = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; };
    const option = (value, label) => { const node = dom('option', '', label); node.value = value; return node; };
    for (const [value, label] of Object.entries(TYPES)) el('filter').append(option(value, label));
    for (const value of EDITABLE_TYPES) field('type').append(option(value, TYPES[value]));
    for (const value of EDITABLE_RELATIONS) field('relation').append(option(value, relationLabel(value)));
    function status(text, error = false) { el('status').textContent = text; el('status').classList.toggle('kg-error', error); }
    function action(label, callback, className = 'text-button') { const button = dom('button', className, label); button.type = 'button'; button.addEventListener('click', callback); return button; }
    function evidenceContent(parent, entry) {
      parent.append(dom('p', 'kg-provenance', entry.provenance === 'catalog-metadata' ? '来自文献资料 · 编辑资料可更新' : '读者记录 · 需要结合原文判断'));
      parent.append(dom('p', 'kg-evidence', evidenceSummary(entry.evidence)));
      if (Number.isInteger(entry.evidence?.page) && entry.evidence.page > 0 && getPaper()?.pdf) parent.append(action(`返回 PDF 第 ${entry.evidence.page} 页`, () => navigatePage?.(entry.evidence.page)));
    }
    function renderInspector() {
      const host = el('inspector'), node = graph.nodes.find(node => node.id === selected);
      host.replaceChildren(); host.hidden = !node;
      if (!node) return;
      const heading = dom('div', 'kg-inspector-heading'); heading.append(dom('h4', '', nodeName(node)), action('收起', () => { selected = null; render(); })); host.append(heading);
      if (node.description) host.append(dom('p', 'kg-description', node.description));
      evidenceContent(host, node);
      if (node.identity_reliable === false) host.append(dom('p', 'kg-help', '同名作者尚缺少可区分的资料。补充 ORCID 或不同单位后，才可为其保存读者关系。'));
      if (node.type === 'paper' && node.id !== paperId) host.append(action('打开文献', () => openPaper?.(node.id)));
      if (node.editable) {
        const actions = dom('div', 'kg-actions');
        actions.append(action('编辑节点', () => showEditor('node', node)), action('删除节点', () => remove('node', node), 'text-button danger')); host.append(actions);
      }
    }
    function renderRelations() {
      const values = scopedEdges(graph, selected), nodeById = new Map(graph.nodes.map(node => [node.id, node]));
      const pages = Math.max(1, Math.ceil(values.length / 20)); edgePage = Math.min(edgePage, pages - 1);
      el('relations-heading').textContent = `${selected ? '此节点的关系' : '关系'} · ${values.length}`;
      el('page').textContent = `${edgePage + 1} / ${pages}`; el('previous').disabled = edgePage <= 0; el('next').disabled = edgePage >= pages - 1;
      const host = el('relations'); host.replaceChildren();
      if (!values.length) { host.append(dom('p', 'kg-help', '尚无关系。添加节点后，可以明确记录谁支持谁、使用什么方法或数据。')); return; }
      for (const edge of values.slice(edgePage * 20, (edgePage + 1) * 20)) {
        const row = dom('details', 'kg-relation'), summary = dom('summary');
        summary.append(dom('span', 'kg-endpoint', nodeById.get(edge.source)?.label || edge.source), dom('strong', 'kg-relation-name', `— ${relationLabel(edge.relation)} →`), dom('span', 'kg-endpoint', nodeById.get(edge.target)?.label || edge.target));
        row.append(summary); const content = dom('div', 'kg-relation-content'); evidenceContent(content, edge);
        if (edge.editable) { const actions = dom('div', 'kg-actions'); actions.append(action('编辑关系', () => showEditor('edge', edge)), action('删除关系', () => remove('edge', edge), 'text-button danger')); content.append(actions); }
        else if (edge.legacy) content.append(dom('p', 'kg-help', '原有文献联系，已保留其说明与方向。'));
        row.append(content); host.append(row);
      }
    }
    function renderCanvas() {
      const filter = el('filter').value, visible = graph.nodes.filter(node => !filter || node.type === filter || node.id === paperId);
      const host = el('canvas'); host.replaceChildren();
      if (!visible.length) { host.append(dom('p', 'kg-help', '当前类型没有节点。')); return; }
      const columns = Math.min(4, Math.max(1, Math.ceil(Math.sqrt(visible.length)))), rows = Math.ceil(visible.length / columns);
      const width = 640, rowHeight = 88, height = Math.max(210, rows * rowHeight + 32), positions = new Map();
      const svg = document.createElementNS(SVG, 'svg'); svg.setAttribute('viewBox', `0 0 ${width} ${height}`); svg.setAttribute('role', 'group'); svg.setAttribute('aria-label', '文献知识图谱，使用 Tab 选择节点查看关系与来源');
      svg.style.minHeight = `${Math.min(420, height)}px`;
      const defs = document.createElementNS(SVG, 'defs'), marker = document.createElementNS(SVG, 'marker'), arrow = document.createElementNS(SVG, 'path');
      marker.setAttribute('id', 'kg-arrow'); marker.setAttribute('viewBox', '0 0 10 10'); marker.setAttribute('refX', '9'); marker.setAttribute('refY', '5'); marker.setAttribute('markerWidth', '5'); marker.setAttribute('markerHeight', '5'); marker.setAttribute('orient', 'auto-start-reverse'); arrow.setAttribute('d', 'M 0 0 L 10 5 L 0 10 z'); marker.append(arrow); defs.append(marker); svg.append(defs);
      visible.forEach((node, index) => positions.set(node.id, { x: (index % columns + .5) * width / columns, y: Math.floor(index / columns) * rowHeight + 48 }));
      for (const edge of graph.edges) {
        const source = positions.get(edge.source), target = positions.get(edge.target); if (!source || !target) continue;
        const dx = target.x - source.x, dy = target.y - source.y, distance = Math.hypot(dx, dy) || 1;
        const line = document.createElementNS(SVG, 'line');
        line.setAttribute('x1', String(source.x + dx / distance * 17)); line.setAttribute('y1', String(source.y + dy / distance * 17)); line.setAttribute('x2', String(target.x - dx / distance * 21)); line.setAttribute('y2', String(target.y - dy / distance * 21)); line.setAttribute('marker-end', 'url(#kg-arrow)');
        line.classList.add('kg-edge'); if (selected && (edge.source === selected || edge.target === selected)) line.classList.add('is-selected'); const title = document.createElementNS(SVG, 'title'); title.textContent = relationLabel(edge.relation); line.append(title); svg.append(line);
      }
      for (const node of visible) {
        const pos = positions.get(node.id), group = document.createElementNS(SVG, 'g'); group.setAttribute('transform', `translate(${pos.x},${pos.y})`); group.setAttribute('tabindex', '0'); group.setAttribute('role', 'button'); group.setAttribute('aria-label', nodeName(node)); group.setAttribute('aria-pressed', String(selected === node.id)); group.classList.add('kg-node', `kg-type-${node.type}`); if (selected === node.id) group.classList.add('is-selected');
        const circle = document.createElementNS(SVG, 'circle'); circle.setAttribute('r', '16');
        const typeText = document.createElementNS(SVG, 'text'); typeText.textContent = TYPES[node.type] || node.type; typeText.setAttribute('y', '4'); typeText.classList.add('kg-node-type');
        const label = document.createElementNS(SVG, 'text'); label.setAttribute('y', '35'); label.classList.add('kg-node-label'); label.textContent = node.label.length > 18 ? node.label.slice(0, 17) + '…' : node.label;
        const title = document.createElementNS(SVG, 'title'); title.textContent = nodeName(node); group.append(circle, typeText, label, title);
        const choose = () => { selected = node.id; edgePage = 0; render(); }; group.addEventListener('click', choose); group.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); choose(); } }); svg.append(group);
      }
      host.append(svg);
    }
    function render() {
      const types = new Set(graph.nodes.map(node => node.type)), legend = el('legend'); legend.replaceChildren();
      for (const [type, label] of Object.entries(TYPES)) if (types.has(type)) { const item = dom('span', `kg-legend-item kg-type-${type}`); item.append(dom('i'), document.createTextNode(label)); legend.append(item); }
      el('add-node').disabled = !paperId; el('add-edge').disabled = graph.nodes.length < 2;
      renderCanvas(); renderInspector(); renderRelations();
    }
    async function load(item = getPaper()) {
      const run = ++revision; paperId = item?.id || null; selected = null; edgePage = 0; closeEditor(); graph = { nodes: [], edges: [] }; render();
      if (!paperId) { status('选择一篇文献查看知识图谱。'); return; }
      const requestedId = paperId; status('正在读取当前文献图谱…');
      try {
        const result = await api('graph', { id: requestedId, limit: 100 });
        if (run !== revision || getPaper()?.id !== requestedId) return;
        graph = result; render(); status(`${graph.nodes.length} 个节点 · ${graph.edges.length} 条关系。${graph.truncated ? ' 当前为部分图谱；最多显示 100 个节点，已保存记录仍保留。' : ' 点击节点查看关系和依据。'}${graph.warnings?.length ? ' ' + graph.warnings.join(' ') : ''}`);
      } catch (error) { if (run === revision) status(`图谱读取失败：${error.message}`, true); }
    }
    function closeEditor() { if (el('dialog').open) el('dialog').close(); editing = null; }
    function showEditor(kind, value = null) {
      if (busy || !paperId) return;
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
    el('cancel').addEventListener('click', closeEditor); form.addEventListener('submit', save);
    el('dialog').addEventListener('cancel', event => { if (busy) event.preventDefault(); else editing = null; });
    el('filter').addEventListener('change', renderCanvas); el('reset').addEventListener('click', () => { selected = null; edgePage = 0; render(); });
    el('previous').addEventListener('click', () => { edgePage = Math.max(0, edgePage - 1); renderRelations(); }); el('next').addEventListener('click', () => { edgePage++; renderRelations(); });
    function clear() { ++revision; paperId = null; selected = null; graph = { nodes: [], edges: [] }; closeEditor(); render(); status('选择一篇文献查看知识图谱。'); }
    clear(); return { load, clear };
  }
  window.PaperKnowledgeGraph = Object.freeze({ create, types: TYPES, relations: RELATIONS, evidenceSummary, scopedEdges, relationLabel });
})();
