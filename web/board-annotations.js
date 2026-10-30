'use strict';
// Reader annotations share the reading rail, while their storage stays separate from PDF notes.
window.PaperBoardAnnotations = (() => {
  function create(options) {
    const { root, api } = options, doc = root.ownerDocument;
    let live = true, id = null, epoch = 0, revision = 0, notes = [], activeId = null, target = null;
    let initial = '', busy = false, loading = false, sequence = 0;
    const currentId = () => typeof options.boardId === 'function' ? options.boardId() : options.boardId;
    const currentTarget = () => typeof options.target === 'function' ? options.target() : options.target;
    const copyTarget = value => value ? { ...value, ...(Array.isArray(value.node_ids) ? { node_ids: [...value.node_ids] } : {}) } : { kind: 'board' };
    const targetKey = value => JSON.stringify([value?.kind || 'board', value?.paper_id, value?.flow_id, value?.node_id, [...(value?.node_ids || [])].sort(), value?.x, value?.y]);
    const toast = (message, error = false) => options.toast?.(message, error);
    const el = (tag, className, text) => { const node = doc.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; };
    const button = (text, action) => { const node = el('button', 'button subtle', text); node.type = 'button'; node.addEventListener('click', action); return node; };
    const host = el('section', 'board-annotations'); host.setAttribute('aria-label', '画板与流程批注');
    const header = el('header', 'board-annotations-header'), heading = el('strong', '', '画板与流程批注');
    const refresh = button('重新读取', () => void reload()); header.append(heading, refresh);
    const source = el('p', 'board-annotation-source'), status = el('p', 'board-annotation-status'); status.setAttribute('role', 'status');
    const form = el('form', 'board-annotation-editor'), label = el('label', '', '写下批注');
    const textarea = el('textarea'); textarea.rows = 4; textarea.maxLength = 4000; textarea.setAttribute('aria-label', '画板或流程批注内容'); textarea.placeholder = '记录问题、解释或待核实的想法。'; label.append(textarea);
    const actions = el('div', 'board-annotation-actions');
    const save = button('保存批注', () => void submit()), cancel = button('取消编辑', () => reset()), add = button('批注当前选中', () => chooseTarget(currentTarget()));
    actions.append(save, cancel, add); form.append(label, actions); form.addEventListener('submit', event => { event.preventDefault(); void submit(); });
    const list = el('div', 'board-annotation-list'); host.append(header, source, status, form, list); root.replaceChildren(host);
    const dirty = () => textarea.value !== initial;
    const notify = () => options.onChange?.({ dirty: dirty(), busy, loading, id });
    const setStatus = (message, error = false) => { status.textContent = message; status.classList.toggle('is-error', error); };
    function targetLabel(value) { return value?.kind === 'flow' ? `流程 ${value.flow_id}${value.node_id ? ` · 节点 ${value.node_id}` : value.node_ids?.length ? ` · ${value.node_ids.length} 个流程节点` : ' · 整张流程'}` : value?.node_ids?.length ? `画板 · ${value.node_ids.length} 个选中节点` : '整张画板'; }
    function sync() {
      const active = notes.find(note => note.id === activeId);
      source.textContent = active ? `${active.target.kind === 'flow' ? '流程' : '画板'}：${active.label}${active.stale ? '（原目标已移除，摘录保留）' : ''}` : targetLabel(target);
      save.textContent = busy ? '正在保存…' : activeId ? '保存修改' : '保存批注';
      save.disabled = busy || loading || !id || !textarea.value.trim() || !dirty(); textarea.disabled = busy;
      cancel.disabled = busy || !dirty() && !activeId; add.disabled = busy; refresh.disabled = busy || loading;
      for (const node of list.querySelectorAll?.('button') || []) node.disabled = busy || node.dataset.stale === 'true';
      notify();
    }
    function reset() { activeId = null; target = copyTarget(currentTarget()); textarea.value = ''; initial = ''; setStatus(''); sync(); }
    function ensureClean() {
      if (!live || busy || loading) { if (busy || loading) toast('批注正在处理，请稍后再切换。', true); return false; }
      if (dirty()) { toast('批注文字尚未保存，请先保存或取消编辑。', true); return false; }
      return true;
    }
    function chooseTarget(next, { focus = true } = {}) { if (!ensureClean()) return false; activeId = null; target = copyTarget(next); textarea.value = ''; initial = ''; setStatus(''); sync(); if (focus) textarea.focus(); return true; }
    function edit(note) { if (!ensureClean()) return; activeId = note.id; target = copyTarget(note.target); textarea.value = note.comment; initial = note.comment; setStatus(''); sync(); textarea.focus(); }
    function render() {
      list.replaceChildren(); heading.textContent = `画板与流程批注 · ${notes.length}`;
      if (!notes.length) list.append(el('p', 'small muted', '尚无批注。可批注整张画板、选中节点或流程节点。'));
      for (const note of [...notes].reverse()) {
        const card = el('article', 'board-annotation-card'); card.dataset.annotationId = note.id;
        card.append(el('strong', 'board-annotation-title', `${note.target.kind === 'flow' ? '流程' : '画板'} · ${note.label}`));
        if (note.stale) card.append(el('p', 'small muted', '原目标已移除，以下是创建批注时的摘录。'));
        if (note.quote) card.append(el('blockquote', 'board-annotation-quote', note.quote));
        card.append(el('p', 'board-annotation-comment', note.comment));
        const row = el('div', 'board-annotation-actions');
        if (options.onFocus) { const locate = button('定位', () => void Promise.resolve().then(() => options.onFocus(note.target, note)).catch(error => toast(error.message || '定位失败', true))); locate.dataset.stale = String(!!note.stale); row.append(locate); }
        row.append(button('编辑', () => edit(note)), button('删除', () => void remove(note)));
        if (options.onSend) row.append(button('放入对话', () => void Promise.resolve().then(() => options.onSend(note)).catch(error => toast(error.message || '放入对话失败', true))));
        card.append(row); list.append(card);
      }
      sync();
    }
    async function reload() {
      if (!live || busy) return false;
      const owner = currentId(); if (!owner) return false;
      if (id !== owner) {
        if (id && dirty()) { toast('原画板仍有未保存批注，请先保存或取消编辑。', true); return false; }
        id = owner; ++epoch; revision = 0; notes = []; activeId = null; target = copyTarget(currentTarget()); textarea.value = ''; initial = ''; render();
      }
      const token = { id, epoch, sequence: ++sequence }; loading = true; setStatus('正在读取批注…'); sync();
      try {
        const result = await api('board_annotations_list', { id: token.id });
        if (!live || token.id !== id || token.epoch !== epoch || token.sequence !== sequence || currentId() !== token.id) return false;
        revision = result.revision; notes = result.notes || [];
        setStatus(dirty() ? '已读取最新列表；当前未保存文字保留。' : ''); render(); return true;
      } catch (error) { if (live && token.epoch === epoch && token.sequence === sequence) { setStatus(`${error.message || '读取批注失败'}；已有文字仍保留。`, true); toast(error.message || '读取批注失败', true); } return false; }
      finally { if (live && token.epoch === epoch && token.sequence === sequence) { loading = false; sync(); } }
    }
    async function submit() {
      if (!live || busy || loading || !id || !dirty() || !textarea.value.trim()) return false;
      if (currentId() !== id) { toast('画板已切换，原批注文字仍保留，请先返回原画板处理。', true); return false; }
      const token = { id, epoch }, submitted = textarea.value, selected = activeId;
      busy = true; setStatus('正在保存批注…'); sync();
      try {
        const result = await api(selected ? 'board_annotations_update' : 'board_annotations_create', { id: token.id, expected_revision: revision, ...(selected ? { note_id: selected } : { target }), comment: submitted });
        if (!live || token.id !== id || token.epoch !== epoch || currentId() !== token.id) return false;
        revision = result.revision; notes = result.notes || []; activeId = null; textarea.value = ''; initial = ''; target = copyTarget(currentTarget()); setStatus('批注已保存。'); render(); return true;
      } catch (error) { if (live && token.id === id && token.epoch === epoch) { setStatus(`${error.message || '保存批注失败'}；文字仍保留，可重新读取后重试。`, true); toast(error.message || '保存批注失败', true); } return false; }
      finally { if (live && token.id === id && token.epoch === epoch) { busy = false; sync(); } }
    }
    async function remove(note) {
      if (!ensureClean() || !id || currentId() !== id) return false;
      if (!doc.defaultView?.confirm?.('删除这条画板／流程批注？此操作不会删除节点或 PDF 批注。')) return false;
      const token = { id, epoch }; busy = true; setStatus('正在删除批注…'); sync();
      try {
        const result = await api('board_annotations_delete', { id: token.id, note_id: note.id, expected_revision: revision });
        if (!live || token.id !== id || token.epoch !== epoch || currentId() !== token.id) return false;
        revision = result.revision; notes = result.notes || []; if (activeId === note.id) reset(); setStatus('批注已删除。'); render(); return true;
      } catch (error) { if (live && token.epoch === epoch) { setStatus(error.message || '删除失败', true); toast(error.message || '删除失败', true); } return false; }
      finally { if (live && token.epoch === epoch) { busy = false; sync(); } }
    }
    textarea.addEventListener('input', sync);
    async function open(next) { if (next !== undefined && !chooseTarget(next)) return false; root.hidden = false; const result = await reload(); if (result && !activeId && !dirty()) { target = copyTarget(next || currentTarget()); sync(); } return result; }
    sync();
    return { open, reload, updateTarget(next) { const value = next || currentTarget(); if (targetKey(target) === targetKey(value)) return true; if (dirty() || busy || loading) return false; return chooseTarget(value, { focus: false }); }, hasDraft: dirty, prepareLeave: ensureClean, dispose() { live = false; ++epoch; ++sequence; root.replaceChildren(); } };
  }
  return Object.freeze({ create });
})();
