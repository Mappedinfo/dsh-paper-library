'use strict';
/** One reader's source/PDF review, projected through the existing annotation model. */
window.PaperLatexReview = (() => {
  function create({ root, api, context, revealSource, revealPdf, changed = () => {}, show = () => {} }) {
    const make = (tag, cls, text) => { const node = document.createElement(tag); if (cls) node.className = cls; if (text !== undefined) node.textContent = text; return node; };
    let notes = [], draft = null, saving = false, sequence = 0, disposed = false;
    const head = make('div', 'latex-review-head');
    head.append(make('strong', '', '自审'));
    const filter = make('select'); filter.id = 'latex-review-filter'; filter.setAttribute('aria-label', '批注筛选');
    for (const [value, label] of [['open', '待处理'], ['all', '全部'], ['resolved', '已解决'], ['stale', '待重定位'], ['source', '源码'], ['pdf', 'PDF']]) { const option = make('option', '', label); option.value = value; filter.append(option); }
    const refresh = make('button', 'button subtle', '刷新'); refresh.type = 'button'; refresh.id = 'latex-review-refresh';
    head.append(filter, refresh);
    const message = make('p', 'latex-review-message'); message.id = 'latex-review-message'; message.setAttribute('role', 'status');
    const composer = make('section', 'latex-review-composer'); composer.id = 'latex-review-composer'; composer.hidden = true;
    const anchor = make('p', 'latex-review-anchor'); anchor.id = 'latex-review-anchor';
    const quote = make('blockquote', 'latex-review-quote'); quote.id = 'latex-review-quote';
    const comment = make('textarea'); comment.id = 'latex-review-comment'; comment.rows = 4; comment.maxLength = 8000; comment.placeholder = '记下疑问、推理或修改想法…'; comment.setAttribute('aria-label', '自审批注内容');
    const save = make('button', 'button primary', '保存批注'); save.id = 'latex-review-save'; save.type = 'button';
    const cancel = make('button', 'button subtle', '取消'); cancel.id = 'latex-review-cancel'; cancel.type = 'button';
    const actions = make('div', 'latex-review-actions'); actions.append(save, cancel);
    composer.append(anchor, quote, comment, actions);
    const list = make('div', 'latex-review-list'); list.id = 'latex-review-list';
    const exports = make('div', 'latex-review-exports');
    for (const [format, label] of [['json', 'JSON'], ['markdown', '笔记 Markdown'], ['pdf', '批注 PDF']]) {
      const button = make('button', 'button subtle', label); button.type = 'button'; button.id = `latex-review-export-${format}`;
      button.addEventListener('click', () => void download(format)); exports.append(button);
    }
    root.append(head, message, composer, list, exports);
    function say(text, error = false) { message.textContent = text; message.classList.toggle('error', error); }
    function label(value) { return value.kind === 'source' ? `${value.path}:${value.line || '选段'} · 源码` : `PDF 第 ${value.page} 页 · 编译 ${value.pdf_version.slice(0, 10)}`; }
    function key() { const current = context(); return `${current.id}:${current.main}`; }
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
      if (!current.file || current.dirty) { say('请先保存源码，再选择选段或当前行批注。', true); show(); return; }
      const editor = current.editor, body = editor.value;
      let start = editor.selectionStart || 0, end = editor.selectionEnd || start;
      if (start === end) { start = body.lastIndexOf('\n', Math.max(0, start - 1)) + 1; const newline = body.indexOf('\n', end); end = newline < 0 ? body.length : newline; if (end === start && end < body.length) end++; }
      if (start === end) { say('当前文件为空，请先写入内容。', true); show(); return; }
      begin({ kind: 'source', path: current.file, revision: current.revision, start: Array.from(body.slice(0, start)).length,
        end: Array.from(body.slice(0, end)).length, line: body.slice(0, start).split('\n').length, text: body.slice(start, end) });
    }
    async function refreshNotes() {
      const current = context(), ticket = ++sequence, identity = key();
      if (!current.id) return;
      try {
        const result = await api('latex_review_list', { id: current.id });
        if (disposed || ticket !== sequence || identity !== key()) return;
        notes = result.annotations || []; render();
        if (!draft) say(result.truncated ? '列表达到上限，请导出核对完整记录。' : `${notes.filter(note => note.status === 'open').length} 条待处理 · ${notes.filter(note => note.stale).length} 条待重定位`);
      } catch (error) { if (ticket === sequence) say(`批注读取失败：${error.message}。可点刷新重试。`, true); }
    }
    function edit(note) {
      if (draft || saving) { say('请先保存或取消当前批注。', true); show(); return; }
      draft = { key: key(), note_id: note.id, expected_version: note.version, status: note.status };
      composer.hidden = false; anchor.textContent = label(note.anchor); quote.textContent = note.text; comment.value = note.comment; show(); comment.focus();
    }
    async function saveDraft() {
      if (!draft || saving || draft.key !== key()) return;
      saving = true; save.disabled = true; cancel.disabled = true;
      const frozen = { ...draft, comment: comment.value }; delete frozen.key;
      try {
        await api('latex_review_put', { id: context().id, ...frozen });
        draft = null; composer.hidden = true; comment.value = ''; await refreshNotes(); await changed();
        say('批注已保存；正文与编译原 PDF 保留。');
      } catch (error) {
        if (draft?.anchor) { composer.hidden = false; anchor.textContent = label(draft.anchor); quote.textContent = draft.anchor.text || '区域便笺'; show(); comment.focus(); }
        say(`批注未保存：${error.message}。当前文字和选段已保留，可重试或取消。`, true);
      }
      finally { saving = false; save.disabled = false; cancel.disabled = false; }
    }
    async function setStatus(note) {
      if (draft || saving) { say('请先保存或取消当前批注。', true); return; }
      saving = true;
      try {
        await api('latex_review_put', { id: context().id, note_id: note.id, expected_version: note.version, comment: note.comment, status: note.status === 'resolved' ? 'open' : 'resolved' });
        await refreshNotes();
      } catch (error) { say(`状态未保存：${error.message}，请刷新后重试。`, true); }
      finally { saving = false; }
    }
    function render() {
      list.textContent = '';
      const visible = notes.filter(note => filter.value === 'all' || filter.value === note.status || filter.value === note.anchor.kind || filter.value === 'stale' && note.stale);
      for (const note of visible) {
        const card = make('article', 'latex-review-card'); card.dataset.note = note.id;
        const location = make('button', 'latex-review-location', label(note.anchor)); location.type = 'button';
        location.disabled = note.stale;
        location.addEventListener('click', () => void (note.anchor.kind === 'source' ? revealSource(note.anchor) : revealPdf(note.anchor)));
        const state = make('span', 'latex-review-state', `${note.status === 'resolved' ? '已解决' : '待处理'}${note.stale ? ' · 待重定位' : ''}`);
        card.append(location, state, make('blockquote', 'latex-review-quote', note.text.slice(0, 1200)), make('p', 'latex-review-body', note.comment));
        if (note.stale) card.append(make('small', '', '原锚点已变化：请在新位置建立批注，再解决此条；不会自动猜位置。'));
        const row = make('div', 'latex-review-actions');
        const editButton = make('button', 'button subtle', '编辑'); editButton.type = 'button'; editButton.addEventListener('click', () => edit(note));
        const resolve = make('button', 'button subtle', note.status === 'resolved' ? '重新打开' : '解决'); resolve.type = 'button'; resolve.addEventListener('click', () => void setStatus(note));
        row.append(editButton, resolve); card.append(row); list.append(card);
      }
      if (!visible.length) list.append(make('p', 'latex-review-empty', '暂无此类批注。源码选段后点「批注选段／当前行」；PDF 可选择高亮或区域便笺。'));
    }
    async function download(format) {
      if (!context().id) return;
      if (draft || saving) { say('先保存或取消批注，再导出。', true); return; }
      try {
        if (format === 'pdf') {
          const link = make('a'); link.href = `./latex-review-pdf/${encodeURIComponent(context().id)}`; link.download = 'manuscript-review.pdf'; link.click();
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
    return { refresh: refreshNotes, beginSource, beginPdf: (anchor, type, options) => begin(anchor, type, options), hasDraft: () => Boolean(draft || saving),
      reset() { if (draft || saving) return false; ++sequence; notes = []; render(); return true; },
      dispose() { disposed = true; ++sequence; }, testHooks: { saveDraft, edit, setStatus, notes: () => notes } };
  }
  return { create };
})();
