'use strict';
/** One reader's source/PDF review, projected through the existing annotation model. */
window.PaperLatexReview = (() => {
  function create({ root, api, context, revealSource, revealPdf, changed = () => {}, show = () => {}, onAsk, onPropose }) {
    const make = (tag, cls, text) => { const node = document.createElement(tag); if (cls) node.className = cls; if (text !== undefined) node.textContent = text; return node; };
    let notes = [], draft = null, saving = false, sequence = 0, disposed = false, collaborating = null, collaboration = [];
    let collaborationKey = null;
    const head = make('div', 'latex-review-head');
    head.append(make('strong', '', '我的批注'));
    const filter = make('select'); filter.id = 'latex-review-filter'; filter.setAttribute('aria-label', '批注筛选');
    for (const [value, label] of [['open', '待处理'], ['all', '全部'], ['resolved', '已解决'], ['stale', '待重定位'], ['source', '源码'], ['pdf', 'PDF']]) { const option = make('option', '', label); option.value = value; filter.append(option); }
    const refresh = make('button', 'button subtle', '刷新'); refresh.type = 'button'; refresh.id = 'latex-review-refresh';
    head.append(filter, refresh);
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
    async function createSourceComment(value) {
      if (typeof value !== 'string' || !value.trim()) { say('请先填写批注内容。', true); return false; }
      if (value.length > 8000) { say('批注内容最多 8000 字符，请缩短后保存。', true); return false; }
      if (draft || saving || collaborating) { say('请先完成当前批注或 DSH 操作。', true); show(); return false; }
      if (!beginSource()) return false;
      comment.value = value;
      return saveDraft();
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
        say(result === false ? 'DSH 操作未完成；请查看协作区提示后重试。' : kind === 'ask' ? 'DSH 回复已生成。' : '修改提案已生成；确认后才会写入源码。', result === false);
        return result !== false;
      } catch (error) { if (!disposed && owner.key === key()) say(`DSH 操作未完成：${error.message}。批注仍保留，可重试。`, true); return false; }
      finally { if (collaborating === owner) { collaborating = null; if (!disposed && owner.key === key()) render(); } }
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
        const detail = make('details', 'latex-review-collaboration');
        const old = entry.review_note.version !== note.version ? ' · 来自较早批注版本' : '';
        const heading = entry.kind === 'ask' ? 'DSH 回复' : ['propose', 'proposal'].includes(entry.kind) ? 'DSH 修改提案' : ['accept', 'accepted'].includes(entry.kind) ? 'DSH 修改已确认' : entry.kind === 'discarded' ? 'DSH 提案已放弃' : 'DSH 协作记录';
        detail.append(make('summary', '', `${heading}${old}${entry.model ? ` · ${entry.model}` : ''}`));
        const content = entry.kind === 'ask' ? entry.answer : [entry.summary, entry.notes, entry.path ? `目标源码：${entry.path}` : '', ['propose', 'proposal'].includes(entry.kind) ? '请在写作区审阅提案，确认后才会修改源码。' : ''].filter(Boolean).join('\n');
        detail.append(make('p', 'latex-review-collaboration-body', String(content || '协作操作已记录。').slice(0, 12000))); card.append(detail);
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
    return { refresh: refreshNotes, annotations: () => notes, beginSource, createSourceComment, setCollaboration, beginPdf: (anchor, type, options) => begin(anchor, type, options), hasDraft: () => Boolean(draft || saving),
      reset() { if (draft || saving) return false; ++sequence; notes = []; collaborating = null; collaboration = []; collaborationKey = null; render(); return true; },
      dispose() { disposed = true; ++sequence; collaborating = null; collaboration = []; }, testHooks: { saveDraft, edit, setStatus, runNote, notes: () => notes } };
  }
  return { create };
})();
