'use strict';
/** One reader's source/PDF review, projected through the existing annotation model. */
window.PaperLatexReview = (() => {
  const make = (tag, cls, text) => { const node = document.createElement(tag); if (cls) node.className = cls; if (text !== undefined) node.textContent = text; return node; };
  const boundedText = (value, limit = 500) => typeof value === 'string' ? value.slice(0, limit) : '';
  const positiveInt = value => Number.isSafeInteger(value) && value > 0 ? value : 0;
  const toolNames = { list_project_files: '查看项目文件', search_project: '搜索项目文件', read_project_file: '读取项目片段', read_project_pdf: '读取项目 PDF', scholar_search: '公开学术检索' };
  const providerLabels = { crossref: 'Crossref', arxiv: 'arXiv' };
  const providerErrors = { unsafe_dns: '网络解析受限', timeout: '超时', rate_limited: '来源限速', response_too_large: '响应过大', redirect_rejected: '来源重定向', invalid_response: '无法读取响应' };
  const toolName = name => typeof name === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(name) ? (Object.hasOwn(toolNames, name) ? toolNames[name] : name) : '检索工具';
  function scholarlyLink(value) {
    if (typeof value !== 'string' || value.length > 1000) return null;
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash) return null;
      if (url.hostname === 'doi.org' && /^\/10\.\d{4,9}\/[^\s?#\x00-\x1f\x7f]+$/i.test(decodeURIComponent(url.pathname))) return url.href;
      if (url.hostname === 'arxiv.org' && /^\/abs\/(?:\d{4}\.\d{4,5}|[a-z][a-z.-]*(?:\.[A-Z]{2})?\/\d{7})(?:v\d+)?$/i.test(url.pathname)) return url.href;
    } catch { /* Plain text remains visible for malformed links. */ }
    return null;
  }
  function retrievalDetails(retrieval) {
    if (!retrieval || typeof retrieval !== 'object') return null;
    const rawSources = Array.isArray(retrieval.sources) ? retrieval.sources : [];
    const sources = rawSources.slice(0, 60).filter(source => source && typeof source.id === 'string' && /^[FS]\d{1,3}$/.test(source.id) && ['file', 'pdf', 'scholar'].includes(source.kind));
    const trace = Array.isArray(retrieval.trace) ? retrieval.trace.slice(0, 24).filter(step => step && typeof step.name === 'string') : [];
    const publicSearch = retrieval.public_search;
    const requested = positiveInt(publicSearch?.requested), attempted = positiveInt(publicSearch?.attempted);
    const outcomes = Array.isArray(publicSearch?.outcomes) ? publicSearch.outcomes.slice(0, 3).filter(result => result && positiveInt(result.index)) : [];
    const details = make('details', 'latex-retrieval-details');
    details.append(make('summary', '', `检索来源 · ${sources.length} 条${retrieval.truncated || rawSources.length > 60 ? ' · 已截断' : ''}`));
    const localAttempt = trace.some(step => step.name !== 'scholar_search' && Object.hasOwn(toolNames, step.name));
    const localSources = sources.some(source => source.kind === 'file' || source.kind === 'pdf');
    const local = retrieval.project === true ? (localSources ? '已取得来源' : localAttempt ? '已调用工具，未取得可引用来源' : '已开启，未调用') : '未开启';
    const publicScope = requested ? (attempted ? `已尝试 ${attempted}/${requested} 条检索词` : `已提供 ${requested} 条检索词，未调用`) : '未开启';
    details.append(make('p', 'latex-retrieval-hint', `当前项目：${local}。公开学术：${publicScope}。`));
    if (!sources.length) details.append(make('p', 'latex-retrieval-hint', '本次没有取得可引用的检索来源。'));
    if (requested || sources.some(source => source.kind === 'scholar')) details.append(make('p', 'latex-retrieval-hint', '学术来源仅为题录或摘要；未读取论文全文。'));
    if (outcomes.length) {
      const statusLabels = { ok: '有结果', empty: '无结果', partial: '部分来源不可用', unavailable: '检索不可用' };
      const outcomeList = make('ul', 'latex-retrieval-outcomes');
      for (const outcome of outcomes) {
        const providers = Array.isArray(outcome.providers) ? outcome.providers.slice(0, 2).filter(provider => provider && Object.hasOwn(providerLabels, provider.provider)).map(provider => {
          const status = provider.status === 'ok' ? `${positiveInt(provider.count)} 条` : provider.status === 'empty' ? '无结果' : '不可用';
          const reason = provider.status === 'error' && Object.hasOwn(providerErrors, provider.error?.code) ? `（${providerErrors[provider.error.code]}）` : '';
          return `${providerLabels[provider.provider]}：${status}${reason}`;
        }) : [];
        const status = Object.hasOwn(statusLabels, outcome.status) ? statusLabels[outcome.status] : '结果未确认';
        outcomeList.append(make('li', '', `检索词 ${outcome.index} · ${status}${providers.length ? `（${providers.join('；')}）` : ''}`));
      }
      details.append(outcomeList);
    }
    if (sources.length) {
      const list = make('ol', 'latex-retrieval-sources');
      for (const source of sources) {
        const row = make('li', 'latex-retrieval-source');
        const label = make('span', 'latex-retrieval-id', `[${source.id}]`);
        if (source.kind === 'scholar') {
          const title = boundedText(source.title) || '未提供标题';
          const href = scholarlyLink(source.url);
          const name = make(href ? 'a' : 'strong', '', title);
          if (href) { name.href = href; name.target = '_blank'; name.rel = 'noopener noreferrer'; }
          row.append(label, name);
          const authors = Array.isArray(source.authors) ? source.authors.slice(0, 12).map(value => boundedText(value, 120)).filter(Boolean).join('、') : '';
          const provider = Object.hasOwn(providerLabels, source.provider) ? providerLabels[source.provider] : '';
          const doi = boundedText(source.doi, 250);
          const meta = [source.evidence_level === 'abstract' ? '摘要' : '题录', provider, authors, positiveInt(source.year), doi ? `DOI ${doi}` : ''].filter(Boolean);
          row.append(make('p', 'latex-retrieval-meta', meta.join(' · ')));
        } else {
          const path = boundedText(source.path, 600) || (source.kind === 'pdf' ? '编译 PDF' : '项目文件');
          const line = positiveInt(source.line), end = positiveInt(source.end_line), page = positiveInt(source.page);
          const locator = source.kind === 'pdf' ? (page ? ` · 第 ${page} 页` : '') : (line ? `:${line}${end > line ? `–${end}` : ''}` : '');
          row.append(label, make('code', '', path + locator));
          const version = boundedText(source.kind === 'pdf' ? source.pdf_version : source.revision, 80);
          row.append(make('p', 'latex-retrieval-meta', `${source.kind === 'pdf' ? '项目 PDF 片段' : '项目文本片段'}${version ? ` · ${source.kind === 'pdf' ? '编译' : '修订'} ${version}` : ''}`));
        }
        list.append(row);
      }
      details.append(list);
    }
    if (trace.length) {
      const steps = make('details', 'latex-retrieval-trace');
      const calls = positiveInt(retrieval.calls), rounds = positiveInt(retrieval.rounds);
      steps.append(make('summary', '', `检索步骤 · ${calls || trace.length} 次${rounds ? ` / ${rounds} 轮` : ''}`));
      const used = retrieval.used_tools === true ? [...new Set(trace.filter(step => step.status === 'ok').map(step => toolName(step.name)))] : [];
      if (used.length) steps.append(make('p', 'latex-retrieval-meta', used.join('、')));
      const statuses = { ok: '已返回', empty: '无结果', error: '未成功', failed: '未成功', denied: '未获授权', invalid: '参数无效', unavailable: '不可用', skipped: '未执行', partial: '部分返回' };
      const stepList = make('ol', 'latex-retrieval-outcomes');
      for (const step of trace) {
        const status = Object.hasOwn(statuses, step.status) ? statuses[step.status] : '已记录';
        const round = positiveInt(step.round);
        stepList.append(make('li', '', `${round ? `第 ${round} 轮 · ` : ''}${toolName(step.name)}：${status}${step.truncated ? ' · 已截断' : ''}`));
      }
      steps.append(stepList); details.append(steps);
    }
    return details;
  }

  function collaborationDetails(entry, { previousVersion = false, showContext = false } = {}) {
    const detail = make('details', 'latex-review-collaboration');
    const heading = { ask: 'DSH 回复', propose: 'DSH 修改提案', proposal: 'DSH 修改提案', accept: 'DSH 修改已确认', accepted: 'DSH 修改已确认', discarded: 'DSH 提案已放弃' };
    const title = Object.hasOwn(heading, entry.kind) ? heading[entry.kind] : 'DSH 协作记录';
    const old = previousVersion ? ' · 来自较早批注版本' : '';
    detail.append(make('summary', '', `${title}${old}${entry.model ? ` · ${entry.model}` : ''}`));
    if (showContext && entry.path) detail.append(make('p', 'latex-retrieval-meta', `源码 ${entry.path}`));
    if (showContext && entry.question && !entry.review_note) detail.append(make('p', '', entry.question));
    const content = entry.kind === 'ask' ? entry.answer : [entry.summary, entry.notes].filter(Boolean).join('\n');
    detail.append(make('p', 'latex-review-collaboration-body', String(content || '协作操作已记录。').slice(0, 12000)));
    if (!showContext && entry.kind !== 'ask' && entry.path) detail.append(make('p', '', `目标源码 ${entry.path}`));
    if (!showContext && ['propose', 'proposal'].includes(entry.kind)) detail.append(make('p', '', '可在「写作记录」中审阅待确认的提案。'));
    const sources = retrievalDetails(entry.retrieval);
    if (sources) detail.append(sources);
    return detail;
  }

  function create({ root, api, context, revealSource, revealPdf, changed = () => {}, show = () => {}, onAsk, onPropose, onStop }) {
    let notes = [], draft = null, saving = false, sequence = 0, disposed = false, collaborating = null, collaboration = [];
    let collaborationKey = null;
    const head = make('div', 'latex-review-head');
    head.append(make('strong', '', '我的批注'));
    const filter = make('select'); filter.id = 'latex-review-filter'; filter.setAttribute('aria-label', '批注筛选');
    for (const [value, label] of [['open', '待处理'], ['all', '全部'], ['resolved', '已解决'], ['stale', '待重定位'], ['source', '源码'], ['pdf', 'PDF']]) { const option = make('option', '', label); option.value = value; filter.append(option); }
    const refresh = make('button', 'button subtle', '刷新'); refresh.type = 'button'; refresh.id = 'latex-review-refresh';
    const stop = make('button', 'button latex-ai-stop', '停止'); stop.type = 'button'; stop.id = 'latex-review-ai-stop'; stop.hidden = true;
    stop.setAttribute('aria-label', '停止当前批注的 DSH 操作');
    stop.addEventListener('click', () => onStop?.());
    head.append(filter, refresh, stop);
    const message = make('p', 'latex-review-message'); message.id = 'latex-review-message'; message.setAttribute('role', 'status');
    const composer = make('section', 'latex-review-composer'); composer.id = 'latex-review-composer'; composer.hidden = true;
    const anchor = make('p', 'latex-review-anchor'); anchor.id = 'latex-review-anchor';
    const quote = make('blockquote', 'latex-review-quote'); quote.id = 'latex-review-quote';
    const comment = make('textarea'); comment.id = 'latex-review-comment'; comment.rows = 4; comment.maxLength = 8000; comment.placeholder = '记下疑问、推理或修改想法…'; comment.setAttribute('aria-label', '我的批注内容');
    const save = make('button', 'button primary', '保存批注'); save.id = 'latex-review-save'; save.type = 'button';
    const cancel = make('button', 'button subtle', '取消'); cancel.id = 'latex-review-cancel'; cancel.type = 'button';
    const actions = make('div', 'latex-review-actions'); actions.append(save, cancel);
    composer.append(anchor, quote, comment, actions);
    const list = make('div', 'latex-review-list'); list.id = 'latex-review-list';
    const exports = make('div', 'latex-review-exports');
    for (const [format, label] of [['json', 'JSON'], ['markdown', '笔记 Markdown'], ['pdf', '批注 PDF']]) {
      const button = make('button', 'button latex-review-export', label); button.type = 'button'; button.id = `latex-review-export-${format}`;
      button.addEventListener('click', () => void download(format)); exports.append(button);
    }
    root.append(head, message, composer, list, exports);
    function say(text, error = false) { message.textContent = text; message.classList.toggle('error', error); }
    function label(value) { return value.kind === 'source' ? `${value.path}:${value.line || '选段'} · 源码` : `PDF 第 ${value.page} 页 · 编译 ${value.pdf_version.slice(0, 10)}`; }
    function key(value = context()) { return JSON.stringify([value.id, value.main, value.binding_generation ?? 0]); }
    function begin(value, type = 'note', { instant = false } = {}) {
      if (draft || saving) { show(); say('请先保存或取消当前批注，选段已保留。', true); return false; }
      draft = { key: key(), anchor: value, type, request_id: crypto.randomUUID().replaceAll('-', '') };
      comment.value = '';
      if (instant) { void saveDraft(); return true; }
      composer.hidden = false; anchor.textContent = label(value); quote.textContent = value.text || '区域便笺'; comment.value = ''; show(); comment.focus();
      say(value.kind === 'pdf' && context().dirty ? '此批注属于已编译 PDF；源码有未保存改动。' : '批注写入自审记录，正文不改动。');
      return true;
    }
    function beginSource() {
      const current = context();
      if (!current.id || !current.file || current.dirty) { say('请先保存源码，再选择选段或当前行批注。', true); show(); return false; }
      const editor = current.editor, body = editor.value;
      let start = editor.selectionStart || 0, end = editor.selectionEnd || start;
      if (start === end) { start = body.lastIndexOf('\n', Math.max(0, start - 1)) + 1; const newline = body.indexOf('\n', end); end = newline < 0 ? body.length : newline; if (end === start && end < body.length) end++; }
      if (start === end) { say('当前文件为空，请先写入内容。', true); show(); return false; }
      return begin({ kind: 'source', path: current.file, revision: current.revision, start: Array.from(body.slice(0, start)).length,
        end: Array.from(body.slice(0, end)).length, line: body.slice(0, start).split('\n').length, text: body.slice(start, end) });
    }
    async function refreshNotes() {
      const current = context(), ticket = ++sequence, identity = key();
      if (!current.id) return;
      try {
        const result = await api('latex_review_list', { id: current.id });
        if (disposed || ticket !== sequence || identity !== key()) return;
        notes = result.annotations || []; render(); changed({ annotations: notes });
        if (!draft) say(result.truncated ? '列表达到上限，请导出核对完整记录。' : `${notes.filter(note => note.status === 'open').length} 条待处理 · ${notes.filter(note => matchedAnchor(note)).length} 条自动匹配 · ${notes.filter(note => note.stale && !matchedAnchor(note)).length} 条待重定位`);
      } catch (error) { if (ticket === sequence) say(`批注读取失败：${error.message}。可点刷新重试。`, true); }
    }
    function edit(note) {
      if (draft || saving || collaborating) { say(collaborating ? 'DSH 正在处理批注，请稍候再编辑。' : '请先保存或取消当前批注。', true); show(); return; }
      draft = { key: key(), note_id: note.id, expected_version: note.version, status: note.status };
      composer.hidden = false; anchor.textContent = label(note.anchor); quote.textContent = note.text; comment.value = note.comment; show(); comment.focus();
    }
    async function saveDraft() {
      if (!draft || saving || draft.key !== key()) return false;
      const owner = draft, identity = owner.key, projectId = context().id;
      saving = true; save.disabled = true; cancel.disabled = true;
      say('正在保存批注…');
      const frozen = { ...draft, comment: comment.value }; delete frozen.key;
      try {
        const result = await api('latex_review_put', { id: projectId, ...frozen });
        if (disposed || identity !== key() || draft !== owner) return false;
        draft = null; composer.hidden = true; comment.value = '';
        try { await refreshNotes(); if (!disposed && identity === key()) await changed({ annotations: notes }); }
        catch (error) { if (!disposed && identity === key()) say(`批注已保存；显示刷新未完成：${error.message}`, true); return result.annotation || true; }
        if (!disposed && identity === key()) say('批注已保存；正文与编译原 PDF 保留。');
        return result.annotation || true;
      } catch (error) {
        if (disposed || identity !== key() || draft !== owner) return false;
        if (draft?.anchor) { composer.hidden = false; anchor.textContent = label(draft.anchor); quote.textContent = draft.anchor.text || '区域便笺'; show(); comment.focus(); }
        say(`批注未保存：${error.message}。当前文字和选段已保留，可重试或取消。`, true);
        return false;
      }
      finally { saving = false; save.disabled = false; cancel.disabled = false; }
    }
    async function setStatus(note) {
      if (draft || saving || collaborating) { say(collaborating ? 'DSH 正在处理批注，请稍候再修改状态。' : '请先保存或取消当前批注。', true); return; }
      saving = true;
      try {
        await api('latex_review_put', { id: context().id, note_id: note.id, expected_version: note.version, comment: note.comment, status: note.status === 'resolved' ? 'open' : 'resolved' });
        await refreshNotes();
      } catch (error) { say(`状态未保存：${error.message}，请刷新后重试。`, true); }
      finally { saving = false; }
    }
    async function runNote(kind, note) {
      const run = kind === 'ask' ? onAsk : onPropose;
      if (disposed || collaborating || typeof run !== 'function') return false;
      if (draft || saving) { say('请先保存或取消当前批注，再问 DSH。', true); show(); return false; }
      if (!notes.some(value => value.id === note.id && value.version === note.version)) { say('批注已变化，请刷新后重试。', true); return false; }
      const owner = { key: key(), id: note.id, version: note.version, kind };
      collaborating = owner; render(); say(kind === 'ask' ? 'DSH 正在阅读这条批注…' : '正在按这条批注生成修改提案…');
      try {
        const result = await run(JSON.parse(JSON.stringify(note)));
        if (disposed || owner.key !== key() || collaborating !== owner) return false;
        say(result === false ? 'DSH 操作未完成，请重试。' : kind === 'ask' ? 'DSH 回复已生成。' : '提案处理已完成，可在「写作记录」查看。', result === false);
        return result !== false;
      } catch (error) { if (!disposed && owner.key === key() && collaborating === owner) say(`DSH 操作未完成：${error.message}。批注仍保留，可重试。`, true); return false; }
      finally { if (collaborating === owner) { collaborating = null; if (!disposed && owner.key === key()) render(); } }
    }
    function cancelCollaboration(message = '') {
      if (!collaborating) return false;
      collaborating = null;
      if (!disposed) { render(); if (message) say(message); }
      return true;
    }
    function setCollaboration(entries, identity = context()) {
      const scope = { ...identity, binding_generation: identity.binding_generation ?? context().binding_generation ?? 0 };
      if (disposed || key(scope) !== key() || !Array.isArray(entries)) return false;
      collaborationKey = key(); collaboration = entries.filter(entry => entry && typeof entry === 'object' && typeof entry.review_note?.id === 'string').slice(0, 40);
      render(); return true;
    }
    function renderCollaboration(note, card) {
      if (collaborationKey !== key()) return;
      for (const entry of collaboration.filter(value => value.review_note.id === note.id).slice(0, 3)) {
        card.append(collaborationDetails(entry, { previousVersion: entry.review_note.version !== note.version }));
      }
    }
    function matchedAnchor(note) {
      const anchor = note.relocation?.status === 'matched' ? note.relocation.anchor : null;
      return anchor?.kind === note.anchor?.kind ? anchor : null;
    }
    function relocationHint(note) {
      const reason = note.relocation?.reason;
      const hints = { ambiguous: '找到多个相近位置，无法唯一确定；请在新位置建立批注后再解决此条。', short: '引用文字过短，无法可靠自动定位；请在新位置建立批注。', no_text: '此批注没有可匹配的文字，请手动定位。', budget: '当前文档超过自动匹配范围，尚未确认唯一位置。' };
      return hints[reason] || (reason?.includes('short') ? hints.short : reason === 'migrated_entry' ? '此批注来自原项目入口，未自动关联到当前入口，请核对原始位置。' : note.relocation?.status === 'ambiguous' ? hints.ambiguous : note.relocation?.status === 'budget' ? hints.budget : '原锚点已变化，尚未找到唯一且足够相似的位置；请在新位置建立批注后再解决此条。');
    }
    function render() {
      list.textContent = '';
      stop.hidden = !collaborating || typeof onStop !== 'function';
      const visible = notes.filter(note => filter.value === 'all' || filter.value === note.status || filter.value === note.anchor.kind || filter.value === 'stale' && note.stale && !matchedAnchor(note));
      for (const note of visible) {
        const card = make('article', 'latex-review-card'); card.dataset.note = note.id;
        const relocated = matchedAnchor(note), target = relocated || note.anchor;
        const location = make('button', 'latex-review-location', label(target)); location.type = 'button';
        location.disabled = note.stale && !relocated;
        location.addEventListener('click', () => void (target.kind === 'source' ? revealSource(target) : revealPdf(target)));
        const state = make('span', 'latex-review-state', `${note.status === 'resolved' ? '已解决' : '待处理'}${relocated ? ' · 自动匹配' : note.stale ? ' · 待重定位' : ''}`);
        card.append(location, state, make('blockquote', 'latex-review-quote', note.text.slice(0, 1200)), make('p', 'latex-review-body', note.comment));
        if (relocated) {
          const score = Number.isFinite(note.relocation.score) ? ` · ${Math.round(note.relocation.score * 100)}%` : '';
          const pages = note.relocation.anchors?.length > 1 ? ` · 跨 ${note.relocation.anchors.length} 页，定位到开头` : '';
          card.append(make('small', 'latex-review-relocated', `已按唯一${note.relocation.method === 'fuzzy' ? '高相似度文本' : '原文'}匹配到当前版本${score}${pages}；用于定位和预览，原批注和旧锚点保留。`));
          const original = make('details', 'latex-review-original-anchor'); original.append(make('summary', '', '原始位置'), make('p', '', label(note.anchor))); card.append(original);
        } else if (note.stale) card.append(make('small', '', relocationHint(note)));
        const row = make('div', 'latex-review-actions latex-review-card-actions');
        const editButton = make('button', 'button subtle', '编辑'); editButton.type = 'button'; editButton.addEventListener('click', () => edit(note));
        const resolve = make('button', 'button subtle', note.status === 'resolved' ? '重新打开' : '解决'); resolve.type = 'button'; resolve.addEventListener('click', () => void setStatus(note));
        const ask = make('button', 'button subtle', '问 DSH'); ask.type = 'button'; ask.dataset.reviewAction = 'ask'; ask.addEventListener('click', () => void runNote('ask', note));
        const propose = make('button', 'button subtle', '生成修改提案'); propose.type = 'button'; propose.dataset.reviewAction = 'propose'; propose.addEventListener('click', () => void runNote('propose', note));
        editButton.disabled = resolve.disabled = Boolean(collaborating);
        ask.disabled = Boolean(collaborating || saving || draft || typeof onAsk !== 'function'); propose.disabled = Boolean(collaborating || saving || draft || typeof onPropose !== 'function');
        row.append(editButton, resolve, ask, propose); card.append(row); renderCollaboration(note, card); list.append(card);
      }
      if (!visible.length) list.append(make('p', 'latex-review-empty', '暂无此类批注。源码选段后点「批注选段／当前行」；PDF 可选择高亮或区域便笺。'));
    }
    async function download(format) {
      if (!context().id) return;
      if (draft || saving) { say('先保存或取消批注，再导出。', true); return; }
      try {
        if (format === 'pdf') {
          const current = context();
          const binding = Number.isSafeInteger(current.binding_generation) ? `?binding_generation=${current.binding_generation}` : '';
          const link = make('a'); link.href = `./latex-review-pdf/${encodeURIComponent(current.id)}${binding}`; link.download = 'manuscript-review.pdf'; link.click();
          say('正在导出当前编译的批注 PDF；源码批注附为 JSON，不修改原 PDF。'); return;
        }
        const result = await api('latex_review_export', { id: context().id, format });
        const url = URL.createObjectURL(new Blob([result.text], { type: result.mime }));
        const link = make('a'); link.href = url; link.download = result.filename; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      } catch (error) { say(`导出失败：${error.message}`, true); }
    }
    save.addEventListener('click', () => void saveDraft());
    cancel.addEventListener('click', () => { if (!saving) { draft = null; comment.value = ''; composer.hidden = true; say('已取消未保存批注。'); } });
    refresh.addEventListener('click', () => void refreshNotes()); filter.addEventListener('change', render);
    return { refresh: refreshNotes, annotations: () => notes, beginSource, setCollaboration, cancelCollaboration, beginPdf: (anchor, type, options) => begin(anchor, type, options), hasDraft: () => Boolean(draft || saving),
      reset() { if (draft || saving) return false; ++sequence; notes = []; collaborating = null; collaboration = []; collaborationKey = null; render(); return true; },
      dispose() { disposed = true; ++sequence; collaborating = null; collaboration = []; }, testHooks: { saveDraft, edit, setStatus, runNote, notes: () => notes } };
  }
  return { create, retrievalDetails, collaborationDetails };
})();
