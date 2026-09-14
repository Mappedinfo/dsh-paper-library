'use strict';

// No document or image cache: the UI holds one bounded list and one rendered PDF page.
const $ = (id) => document.getElementById(id);
const state = {
  items: [], total: 0, libraryCount: 0, offset: 0, limit: 40, query: '', active: null, tab: 'reader',
  page: 1, pageCount: 0, pageData: null, selection: null, annotations: [], noteOffset: 0,
  models: [], harnessContext: null, modelTicket: 0, library: '', listTicket: 0, itemTicket: 0, pageTicket: 0, metadataDraft: null, openedId: null,
  pageWanted: null, pageRunning: false, annotationDraft: null, upload: null, aiBusy: false,
};
const relationNames = { related: '相关', supports: '支持', contradicts: '相矛盾', cites: '引用', tagged: '标签', tag: '标签', has_tag: '标签' };
const typeNames = { 'article-journal': '期刊论文', 'paper-conference': '会议论文', book: '图书', chapter: '章节', thesis: '学位论文', report: '报告', document: '文献' };

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
async function api(action, args = {}) {
  const response = await fetch('./api', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, ...args }) });
  let data;
  try { data = await response.json(); } catch { throw new Error(`服务返回无法读取的响应（HTTP ${response.status}）。请刷新后重试。`); }
  if (!response.ok || !data.ok) throw new Error(typeof data.error === 'string' ? data.error : data.error?.message || `请求未完成（HTTP ${response.status}）`);
  return data.result;
}
function errorAt(id, error) {
  const node = $(id); node.textContent = error?.message || String(error || ''); node.hidden = !error;
  if (error && id === 'detail-error') { const retry = el('button', 'button subtle', '重新读取'); retry.addEventListener('click', () => state.active?.pdf ? requestPage(state.page) : state.openedId && openPaper(state.openedId)); node.append(retry); }
}
let toastTimer;
function toast(message, isError = false) {
  clearTimeout(toastTimer); $('toast').textContent = message; $('toast').classList.toggle('error', isError); $('toast').hidden = false;
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, isError ? 7000 : 3500);
}
function debounce(fn, delay = 220) { let timer; return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), delay); }; }
function tags(item) { return (item.tags || []).map((tag) => typeof tag === 'string' ? tag : tag.tag || tag.name || '').filter(Boolean); }
function authorName(author) { return author.literal || [author.given, author.family].filter(Boolean).join(' ') || ''; }
function authors(item) { return (item.author || []).map(authorName).filter(Boolean).join(' · ') || '作者信息待补充'; }
function year(item) { return item.issued?.['date-parts']?.[0]?.[0] || item.year || ''; }
function title(item) { return item.title || '未命名文献'; }
function displayDate(value) { if (!value) return ''; const pdfDate = /^D:(\d{4})(\d{2})(\d{2})/.exec(String(value)); if (pdfDate) return `${pdfDate[1]}/${pdfDate[2]}/${pdfDate[3]}`; const date = new Date(value); return Number.isNaN(date.valueOf()) ? String(value) : date.toLocaleDateString('zh-CN'); }
function emptyState(heading, description) { const box = el('div', 'empty-state'); box.append(el('h3', '', heading), el('p', '', description)); return box; }
function preferenceKey() { return `paper-library:${state.library || 'default'}:auto-feedback`; }
function modelKey() { return `paper-library:${state.library || 'default'}:model`; }
function readPreference(key) { try { return localStorage.getItem(key); } catch { return null; } }
function savePreference(key, value) { try { localStorage.setItem(key, value); } catch { toast('浏览器未允许保存偏好；本次会话仍可使用。'); } }
function openDialog(id) { const dialog = $(id); if (!dialog.open) dialog.showModal(); }
function closeDialog(id) { $(id).close(); }
function setBusy(form, busy) { form.querySelectorAll('button[type="submit"]').forEach((node) => { node.disabled = busy; }); form.classList.toggle('busy', busy); }

async function loadStatus() {
  try {
    const result = await api('status'); state.library = result.library || '';
    $('library-status').textContent = '本地文献库'; $('library-status').title = state.library;
    $('item-count').textContent = result.count ?? '0';
    state.libraryCount = result.count || 0; renderWelcome();
    $('auto-feedback').checked = readPreference(preferenceKey()) === 'true';
  } catch (error) { $('library-status').textContent = '连接未完成'; errorAt('library-error', error); }
}
async function loadList() {
  const ticket = ++state.listTicket;
  errorAt('library-error', null);
  if (!state.items.length) $('paper-list').replaceChildren(el('div', 'loading', '正在检索文献…'));
  try {
    const result = await api('list', { query: state.query, limit: state.limit, offset: state.offset });
    if (ticket !== state.listTicket) return;
    state.items = result.items || []; state.total = result.total || 0;
    renderList();
  } catch (error) {
    if (ticket !== state.listTicket) return;
    errorAt('library-error', error);
    if (!state.items.length) $('paper-list').replaceChildren(emptyState('暂时无法读取文献', '检索条件已保留。使用右上方刷新按钮重试。'));
  }
}
function renderList() {
  const fragment = document.createDocumentFragment();
  for (const item of state.items) {
    const card = el('button', `paper-card${state.active?.id === item.id ? ' selected' : ''}`);
    card.type = 'button'; card.dataset.id = item.id; card.setAttribute('aria-pressed', String(state.active?.id === item.id));
    card.append(el('h3', '', title(item)), el('p', '', `${authors(item)}${year(item) ? ` · ${year(item)}` : ''}`));
    const footer = el('div', 'card-footer');
    if (item.pdf) footer.append(el('span', 'pdf-chip', 'PDF'));
    for (const tag of tags(item).slice(0, 3)) footer.append(el('span', 'chip', tag));
    if (!footer.children.length) footer.append(el('span', 'chip', item.citekey || typeNames[item.type] || '文献资料'));
    card.append(footer); fragment.append(card);
  }
  if (!state.items.length) fragment.append(emptyState(state.query ? '没有匹配的文献' : '书架等待第一篇论文', state.query ? '试试更短的词、作者姓名或标签。' : '从 DOI、PDF 或已有文献库导入，开始积累阅读线索。'));
  $('paper-list').replaceChildren(fragment);
  $('search-summary').textContent = state.query ? `检索结果 · ${state.total}` : '全部文献';
  if (!state.query) { $('item-count').textContent = state.total; state.libraryCount = state.total; }
  renderWelcome();
  $('list-range').textContent = state.total ? `${state.offset + 1}–${Math.min(state.offset + state.limit, state.total)} / ${state.total}` : '0 篇';
  $('previous-list').disabled = state.offset === 0;
  $('next-list').disabled = state.offset + state.limit >= state.total;
}
function renderWelcome() {
  $('welcome-import').textContent = state.libraryCount ? '选择文献，继续阅读 ↗' : '导入第一篇文献 ↗';
  document.querySelector('.welcome > p:not(.eyebrow)').textContent = state.libraryCount ? '从文献库选择一篇论文，标记值得追问的段落，再把文献之间的联系串起来。' : '导入论文，标记值得追问的段落，再把文献之间的联系串起来。';
}
function clearPage() {
  state.pageData = null; $('page-image').removeAttribute('src'); $('word-layer').replaceChildren(); $('pdf-page').hidden = true;
  clearSelection();
}
async function openPaper(id) {
  const ticket = ++state.itemTicket;
  state.openedId = id;
  ++state.pageTicket; state.pageWanted = null; clearPage(); state.annotations = []; state.annotationsTruncated = false; state.noteOffset = 0;
  $('annotation-list').replaceChildren(); $('annotation-count').textContent = ''; $('feedback-list').replaceChildren(); $('feedback-status').textContent = ''; $('graph-stage').replaceChildren(); $('graph-links').replaceChildren(); $('download-pdf').hidden = true;
  errorAt('detail-error', null);
  document.querySelector('.workspace').classList.add('show-detail');
  $('welcome').hidden = true; $('paper-detail').hidden = false;
  $('paper-title').textContent = '正在打开文献…'; $('paper-authors').textContent = ''; $('paper-tags').replaceChildren();
  state.active = null; state.selection = null; state.page = 1; state.pageCount = 0;
  $('reader-content').hidden = true; $('no-pdf').hidden = true;
  try {
    const item = await api('get', { id }); if (ticket !== state.itemTicket) return;
    state.active = item; renderPaperHeader(); renderList(); await switchTab('reader');
    if (item.pdf) loadAnnotations(id); else renderAnnotations(); loadFeedback(id);
  } catch (error) { if (ticket === state.itemTicket) { $('paper-title').textContent = '文献未能打开'; errorAt('detail-error', error); } }
}
function renderPaperHeader() {
  const item = state.active; if (!item) return;
  $('paper-title').textContent = title(item);
  const details = [authors(item), year(item), item['container-title']].filter(Boolean);
  $('paper-authors').textContent = details.join(' · ');
  $('paper-type').textContent = `${typeNames[item.type] || '文献'}${item.citekey ? ` / ${item.citekey}` : ''}`;
  $('paper-tags').replaceChildren(...tags(item).map((tag) => el('span', 'chip', tag)));
  $('download-pdf').hidden = !item.pdf; $('download-pdf').href = `./pdf/${encodeURIComponent(item.id)}`;
  $('no-pdf').hidden = Boolean(item.pdf); $('reader-content').hidden = !item.pdf;
}
async function switchTab(tab) {
  state.tab = tab;
  for (const node of document.querySelectorAll('.tab')) { const selected = node.dataset.tab === tab; node.classList.toggle('active', selected); if (selected) node.setAttribute('aria-current', 'page'); else node.removeAttribute('aria-current'); }
  for (const name of ['reader', 'annotations', 'graph']) $(`${name}-tab`).hidden = name !== tab;
  if (!state.active) return;
  if (tab === 'reader' && state.active.pdf && !state.pageData) await requestPage(state.page);
  if (tab === 'annotations') { if (state.active.pdf) await loadAnnotations(state.active.id); else renderAnnotations(); loadFeedback(state.active.id); if (!currentHarnessRoute() && !state.models.length) loadModels(); }
  if (tab === 'graph') await loadGraph();
}
async function requestPage(page) {
  if (!state.active?.pdf) return;
  const next = Math.max(1, Math.min(Number(page) || 1, state.pageCount || Infinity));
  state.pageWanted = { id: state.active.id, page: next, ticket: ++state.pageTicket };
  clearPage();
  if (state.pageRunning) return;
  state.pageRunning = true;
  try {
    // Serialize page renders even when the user switches documents rapidly.
    while (state.pageWanted) {
      const wanted = state.pageWanted; state.pageWanted = null;
      $('page-loading').hidden = false; $('previous-page').disabled = true; $('next-page').disabled = true;
      try {
        const pageData = await api('page', { id: wanted.id, page: wanted.page, scale: 1.25 });
        if (wanted.ticket !== state.pageTicket || wanted.id !== state.active?.id) continue;
        state.page = pageData.page; state.pageCount = pageData.page_count;
        state.pageData = { width: pageData.width, height: pageData.height }; // Never retain the image or word array twice.
        $('page-number').value = state.page; $('page-number').max = state.pageCount; $('page-total').textContent = `/ ${state.pageCount}`;
        $('page-image').src = `data:image/png;base64,${pageData.image}`;
        $('pdf-page').hidden = false; renderWords(pageData.words || [], pageData.width, pageData.height);
        $('page-message').textContent = pageData.words?.length ? '文字选择按整词保存。PDF 中的已有批注会随页面显示。' : '这一页没有可选择的文字，可能是扫描页面。你仍可添加页批注。';
        errorAt('detail-error', null);
      } catch (error) { if (wanted.ticket === state.pageTicket && wanted.id === state.active?.id) errorAt('detail-error', error); }
    }
  } finally {
    state.pageRunning = false; $('page-loading').hidden = true;
    $('previous-page').disabled = state.page <= 1; $('next-page').disabled = !state.pageCount || state.page >= state.pageCount;
  }
}
function renderWords(words, width, height) {
  const fragment = document.createDocumentFragment();
  for (const word of words) {
    if (!Array.isArray(word) || word.length < 5) continue;
    const [x0, y0, x1, y1, text] = word;
    const span = el('span', 'pdf-word', `${text} `);
    span.dataset.rect = JSON.stringify([x0, y0, x1, y1]);
    span.style.left = `${x0 / width * 100}%`; span.style.top = `${y0 / height * 100}%`;
    span.style.width = `${(x1 - x0) / width * 100}%`; span.style.height = `${(y1 - y0) / height * 100}%`;
    span.dataset.height = y1 - y0; fragment.append(span);
  }
  $('word-layer').replaceChildren(fragment); sizeWordLayer();
}
function sizeWordLayer() {
  if (!state.pageData) return;
  const scale = $('pdf-page').clientWidth / state.pageData.width;
  for (const span of $('word-layer').children) span.style.fontSize = `${Number(span.dataset.height) * scale * .85}px`;
}
new ResizeObserver(sizeWordLayer).observe($('pdf-page'));
function readSelection() {
  const selection = window.getSelection(); if (!selection?.rangeCount || selection.isCollapsed || !state.pageData) return;
  if (!$('word-layer').contains(selection.anchorNode) || !$('word-layer').contains(selection.focusNode)) return;
  const words = [];
  for (const node of $('word-layer').children) if (selection.containsNode(node, true)) words.push(node);
  if (!words.length) return;
  const rects = [];
  for (const word of words) {
    const rect = JSON.parse(word.dataset.rect); const last = rects.at(-1);
    // Merge adjacent words on one line; keep columns and separate lines distinct.
    const height = rect[3] - rect[1];
    if (last && Math.abs(last[1] - rect[1]) < 2 && Math.abs(last[3] - rect[3]) < 2 && rect[0] >= last[2] - 2 && rect[0] - last[2] < height * 1.5) { last[2] = Math.max(last[2], rect[2]); last[1] = Math.min(last[1], rect[1]); last[3] = Math.max(last[3], rect[3]); }
    else rects.push(rect);
  }
  const text = words.map((node) => node.textContent.trim()).join(' ');
  if (rects.length > 200 || text.length > 20000) { state.selection = null; $('selection-tools').hidden = true; toast('选择范围超过单次批注上限。请缩小到较短的段落后重试；当前尚未保存批注。', true); return; }
  state.selection = { id: state.active.id, page: state.page, text, rects };
  $('selection-count').textContent = `第 ${state.page} 页 · ${words.length} 个词`;
  $('selection-preview').textContent = state.selection.text; $('selection-tools').hidden = false;
}
function clearSelection() { state.selection = null; $('selection-tools').hidden = true; window.getSelection()?.removeAllRanges(); }

async function loadAnnotations(id) {
  try {
    const result = await api('annotations', { id }); if (id !== state.active?.id) return;
    state.annotations = result.annotations || []; $('annotation-count').textContent = `${state.annotations.length}${result.truncated ? '+' : ''}`;
    state.annotationsTruncated = Boolean(result.truncated);
    state.noteOffset = Math.min(state.noteOffset, Math.max(0, Math.ceil(state.annotations.length / 40) - 1) * 40); renderAnnotations();
  } catch (error) { if (id === state.active?.id) { $('annotation-count').textContent = ''; $('annotation-list').replaceChildren(emptyState('批注暂时未能读取', error.message)); } }
}
function renderAnnotations() {
  const fragment = document.createDocumentFragment();
  for (const note of state.annotations.slice(state.noteOffset, state.noteOffset + 40)) {
    const card = el('article', 'annotation-card'); card.dataset.annotationId = note.id;
    const meta = el('div', 'annotation-meta'); const pageLink = el('button', 'page-link', `第 ${note.page} 页`); pageLink.dataset.noteAction = 'page';
    meta.append(pageLink, el('span', '', displayDate(note.modified || note.created)), el('span', 'note-type', note.kind === 'ai-feedback' || note.type === 'ai_feedback' || note.ai_generated ? 'AI 生成' : note.type === 'highlight' ? '高亮' : '批注'));
    card.append(meta);
    if (note.text) card.append(el('blockquote', '', note.text));
    if (note.comment || note.content) card.append(el('p', 'annotation-comment', note.comment || note.content));
    const actions = el('div', 'annotation-actions'); const edit = el('button', 'button subtle', '编辑'); edit.dataset.noteAction = 'edit'; const remove = el('button', 'button subtle delete-note', '删除'); remove.dataset.noteAction = 'delete'; actions.append(edit, remove); card.append(actions); fragment.append(card);
  }
  if (!state.annotations.length) fragment.append(emptyState('第一条批注，从一个问题开始', '在阅读页选择文字以高亮，或添加一条整页笔记。'));
  if (state.annotations.length > 40) {
    const pagination = el('div', 'pagination'); const previous = el('button', 'button subtle', '← 上一页'); previous.disabled = state.noteOffset === 0; previous.dataset.noteAction = 'previous'; const next = el('button', 'button subtle', '下一页 →'); next.disabled = state.noteOffset + 40 >= state.annotations.length; next.dataset.noteAction = 'next';
    pagination.append(previous, el('span', 'muted', `${state.noteOffset + 1}–${Math.min(state.noteOffset + 40, state.annotations.length)} / ${state.annotations.length}`), next); fragment.append(pagination);
  }
  if (state.annotationsTruncated) fragment.append(el('p', 'small muted', '批注数量或文本量已达读取上限，当前只显示已读取的部分。PDF 中的原始批注仍被保留。'));
  $('annotation-list').replaceChildren(fragment);
}
function openAnnotation(mode, note = null) {
  if (!state.active?.pdf) return;
  if (mode === 'highlight' && !state.selection) return;
  const selection = mode === 'highlight' ? state.selection : null;
  state.annotationDraft = { mode, id: state.active.id, page: note?.page || selection?.page || state.page, note, selection };
  $('annotation-dialog-title').textContent = mode === 'edit' ? '编辑批注' : mode === 'highlight' ? '高亮并批注' : '添加页批注';
  $('annotation-page-label').textContent = `第 ${state.annotationDraft.page} 页`;
  $('annotation-quote').textContent = note?.text || selection?.text || ''; $('annotation-quote').hidden = !$('annotation-quote').textContent;
  $('annotation-comment').value = note?.comment || note?.content || ''; $('annotation-comment').required = mode === 'note';
  errorAt('annotation-error', null); openDialog('annotation-dialog');
}
async function saveAnnotation(event) {
  event.preventDefault(); const draft = state.annotationDraft; if (!draft) return;
  setBusy(event.target, true); errorAt('annotation-error', null);
  try {
    if (draft.mode === 'edit') await api('annotation_update', { id: draft.id, annotation_id: draft.note.id, comment: $('annotation-comment').value });
    else await api('annotate', { id: draft.id, page: draft.page, type: draft.mode, text: draft.selection?.text || '', rects: draft.selection?.rects || [[20, 20, 40, 40]], comment: $('annotation-comment').value, author: 'Reader', color: '#ffdb66' });
    closeDialog('annotation-dialog'); clearSelection(); toast('批注已保存到 PDF');
    if (state.active?.id === draft.id) { await loadAnnotations(draft.id); if (state.page === draft.page) await requestPage(state.page); }
    if ($('auto-feedback').checked) requestFeedback(draft.id, true);
  } catch (error) { errorAt('annotation-error', error); } finally { setBusy(event.target, false); }
}
async function handleNoteAction(event) {
  const button = event.target.closest('[data-note-action]'); if (!button) return;
  const action = button.dataset.noteAction;
  if (action === 'previous' || action === 'next') { state.noteOffset += action === 'next' ? 40 : -40; renderAnnotations(); return; }
  const note = state.annotations.find((entry) => entry.id === button.closest('[data-annotation-id]').dataset.annotationId); if (!note) return;
  if (action === 'page') { state.page = note.page; clearPage(); await switchTab('reader'); }
  if (action === 'edit') openAnnotation('edit', note);
  if (action === 'delete') {
    if (button.dataset.confirm !== 'true') { button.dataset.confirm = 'true'; button.textContent = '确认删除'; setTimeout(() => { if (button.isConnected) { delete button.dataset.confirm; button.textContent = '删除'; } }, 5000); return; }
    const id = state.active.id; button.disabled = true;
    try { await api('annotation_delete', { id, annotation_id: note.id }); toast('批注已删除'); if (state.active?.id === id) { await loadAnnotations(id); if (note.page === state.page) await requestPage(state.page); } }
    catch (error) { toast(error.message, true); button.disabled = false; }
  }
}

function chooseUpload(file) { if (!file) return; state.upload = file; $('upload-label').textContent = `${file.name} · ${(file.size / 1024 / 1024).toFixed(1)} MB`; $('import-source').value = ''; errorAt('import-error', null); }
function fileBase64(file) { return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.onerror = () => reject(new Error('无法读取所选文件。')); reader.readAsDataURL(file); }); }
async function importPapers(event) {
  event.preventDefault(); errorAt('import-error', null); $('import-result').textContent = '';
  const source = $('import-source').value.trim(); const file = state.upload;
  if (!source && !file) { errorAt('import-error', '请输入 DOI、文件路径，或选择一个文件。'); return; }
  setBusy(event.target, true); $('import-submit').textContent = '正在导入…';
  let imported = 0, duplicates = 0, warningCount = 0, firstItem = null;
  const warnings = [];
  try {
    let args;
    if (source) args = /^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:\s*)?10\.\d{4,9}\//i.test(source) ? { doi: source.replace(/^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:\s*)/i, '') } : { path: source };
    else { if (file.size > 32 * 1024 * 1024) throw new Error('浏览器文件导入支持 32 MB 以内文件。更大的文件请在上方填写本地路径导入。'); args = { filename: file.name, content_base64: await fileBase64(file) }; }
    let offset = 0;
    while (true) {
      const result = await api('import', { ...args, offset, limit: 100 });
      imported += Array.isArray(result.imported) ? result.imported.length : result.imported ?? result.items?.length ?? 0;
      duplicates += Array.isArray(result.duplicates) ? result.duplicates.length : result.duplicates || 0;
      firstItem ||= result.items?.[0];
      for (const warning of result.warnings || []) { warningCount++; if (warnings.length < 100) warnings.push(typeof warning === 'string' ? warning : warning.message || JSON.stringify(warning)); }
      const total = result.total_files ?? result.total_records;
      const processed = result.next_offset ?? total;
      $('import-result').textContent = `${total !== undefined ? `已处理 ${processed} / ${total} ${result.total_files !== undefined ? '个 PDF' : '条记录'} · ` : ''}已导入 ${imported} 篇${duplicates ? `，重复 ${duplicates} 篇` : ''}${warningCount ? `，${warningCount} 条提示` : ''}`;
      if (result.done !== false || result.next_offset === null || result.next_offset === undefined) break;
      if (result.next_offset <= offset) throw new Error('批量导入未能继续推进；已完成的记录已保留，请检查文件后重新导入。');
      offset = result.next_offset;
    }
    const message = `已导入 ${imported} 篇${duplicates ? `，识别到 ${duplicates} 篇重复文献` : ''}`;
    state.offset = 0; await loadList(); await loadStatus();
    if (firstItem?.id) await openPaper(firstItem.id);
    state.upload = null; $('import-file').value = ''; $('upload-label').textContent = '选择文件，或拖到这里'; $('import-source').value = '';
    if (warnings.length) $('import-result').textContent = `${message}\n${warnings.join('\n')}${warningCount > warnings.length ? `\n另有 ${warningCount - warnings.length} 条提示，界面展示前 100 条。` : ''}`;
    else { closeDialog('import-dialog'); toast(message); }
  } catch (error) { errorAt('import-error', error); if (imported || duplicates) { $('import-result').textContent = `本次已导入 ${imported} 篇，识别重复 ${duplicates} 篇。已完成的记录仍保存在文献库中；输入已保留，可重试。`; await loadList(); await loadStatus(); } } finally { setBusy(event.target, false); $('import-submit').textContent = '导入文献'; }
}
function openMetadata() {
  const item = state.active; if (!item) return;
  $('edit-title').value = item.title || ''; $('edit-authors').value = (item.author || []).map((author) => author.literal || [author.family, author.given].filter(Boolean).join(', ')).join('\n');
  $('edit-year').value = year(item); $('edit-citekey').value = item.citekey || ''; $('edit-tags').value = tags(item).join(', ');
  state.metadataDraft = { item: structuredClone(item), authorsText: $('edit-authors').value, yearText: $('edit-year').value };
  $('metadata-form').dataset.itemId = item.id; errorAt('metadata-error', null); openDialog('metadata-dialog');
}
async function saveMetadata(event) {
  event.preventDefault(); const id = event.target.dataset.itemId; setBusy(event.target, true); errorAt('metadata-error', null);
  try {
    const original = state.metadataDraft;
    const author = $('edit-authors').value === original?.authorsText ? original.item.author || [] : $('edit-authors').value.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => { const parts = line.split(','); return parts.length > 1 ? { family: parts.shift().trim(), given: parts.join(',').trim() } : { literal: line }; });
    const issued = $('edit-year').value === original?.yearText ? original.item.issued || {} : $('edit-year').value ? { 'date-parts': [[Number($('edit-year').value)]] } : {};
    const metadata = { title: $('edit-title').value.trim(), author, citekey: $('edit-citekey').value.trim(), tags: $('edit-tags').value.split(/[,，]/).map((tag) => tag.trim()).filter(Boolean), issued };
    const result = await api('update', { id, metadata });
    if (state.active?.id === id) { state.active = result; renderPaperHeader(); }
    closeDialog('metadata-dialog'); await loadList(); toast('文献资料已保存');
  } catch (error) { errorAt('metadata-error', error); } finally { setBusy(event.target, false); }
}
async function attachPdf(event) {
  event.preventDefault(); const id = event.target.dataset.itemId; setBusy(event.target, true); errorAt('attach-error', null);
  try { const result = await api('attach', { id, path: $('attach-path').value.trim() }); closeDialog('attach-dialog'); if (state.active?.id === id) { state.active = result; renderPaperHeader(); await requestPage(1); await loadAnnotations(id); } await loadList(); toast('PDF 已复制并关联'); }
  catch (error) { errorAt('attach-error', error); } finally { setBusy(event.target, false); }
}

function downloadText(result) {
  const blob = new Blob([result.text || ''], { type: result.mime || 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob); const anchor = el('a'); anchor.href = url; anchor.download = result.filename || 'export.txt'; document.body.append(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function escapeHtml(value) { return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]); }
function safeCitationHtml(html, plain) {
  // Parse in an inert document, then serialize only formatting tags and text; no source attributes survive.
  if (!html) return `<p>${escapeHtml(plain)}</p>`;
  const doc = new DOMParser().parseFromString(String(html), 'text/html');
  const allowed = new Set(['I', 'EM', 'B', 'STRONG', 'SPAN', 'DIV', 'P', 'BR', 'SUP', 'SUB']);
  function clean(node) {
    if (node.nodeType === Node.TEXT_NODE) return escapeHtml(node.textContent);
    if (node.nodeType !== Node.ELEMENT_NODE || ['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT'].includes(node.tagName)) return '';
    const body = [...node.childNodes].map(clean).join('');
    if (!allowed.has(node.tagName)) return body;
    const tag = node.tagName.toLowerCase(); return tag === 'br' ? '<br>' : `<${tag}>${body}</${tag}>`;
  }
  return [...doc.body.childNodes].map(clean).join('');
}
async function cite(format) {
  if (!state.active) return;
  const button = format === 'apa' ? $('copy-apa') : $('export-bib'); button.disabled = true;
  try {
    const result = await api('cite', { ids: [state.active.id], format });
    if (format !== 'apa') { downloadText(result); toast('BibLaTeX 已导出'); return; }
    try {
      if (navigator.clipboard?.write && window.ClipboardItem) await navigator.clipboard.write([new ClipboardItem({ 'text/plain': new Blob([result.text], { type: 'text/plain' }), 'text/html': new Blob([safeCitationHtml(result.html, result.text)], { type: 'text/html' }) })]);
      else if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(result.text);
      else throw new Error('clipboard unavailable');
      toast('APA 7 引用已复制');
    } catch { $('copy-fallback').value = result.text; $('text-dialog-title').textContent = 'APA 7 引用'; openDialog('text-dialog'); $('copy-fallback').select(); }
  } catch (error) { toast(error.message, true); } finally { button.disabled = false; }
}
async function exportNotes() {
  const format = $('export-notes').value; if (!format || !state.active) return;
  try { downloadText(await api('export_annotations', { id: state.active.id, format })); toast('批注已导出'); } catch (error) { toast(error.message, true); } finally { $('export-notes').value = ''; }
}
async function exportLibrary() {
  const button = $('export-library'); button.disabled = true; button.textContent = '正在导出…';
  try {
    const result = await api('export_library', { format: 'biblatex' });
    downloadText(result); toast(`已导出全部 ${result.count ?? state.libraryCount} 篇文献的 BibLaTeX`);
  } catch (error) { toast(`文献库导出未完成：${error.message}`, true); }
  finally { button.disabled = false; button.textContent = '导出文献库'; }
}

function currentHarnessRoute() {
  const context = state.harnessContext;
  return context?.status === 'ready' && context.provider && context.model ? { provider: context.provider, id: context.model, sessionId: context.sessionId, reasoningEffort: context.reasoningEffort } : null;
}
function manualModel() {
  const value = $('feedback-model').value;
  return value === '' ? null : state.models[Number(value)] || null;
}
function renderModelRoute() {
  const route = currentHarnessRoute();
  const loading = state.harnessContext?.status === 'loading';
  $('feedback-model').closest('label').hidden = Boolean(route) || loading;
  $('current-harness-model').hidden = !route && !loading;
  $('refresh-models').hidden = Boolean(route);
  if (route) {
    $('current-harness-model-name').textContent = `${route.provider} / ${route.id}`;
    $('model-status').textContent = '自动跟随当前 DSH 会话的模型。请求会发送当前文献资料与批注，并使用模型额度。';
  } else if (loading) {
    $('current-harness-model-name').textContent = '正在读取当前会话的模型…';
    $('model-status').textContent = '模型就绪后即可请求反馈；已保存的批注不受影响。';
  }
  $('request-feedback').disabled = state.aiBusy || loading || !(route || manualModel());
}
function announceReady() {
  if (window.parent !== window) window.parent.postMessage({ type: 'paper-library:ready', version: 1 }, window.location.origin);
}
function receiveHarnessContext(event) {
  if (window.parent === window || event.source !== window.parent || event.origin !== window.location.origin) return;
  const data = event.data;
  if (!data || typeof data !== 'object' || data.type !== 'paper-library:context' || data.version !== 1) return;
  const stringValue = (value) => typeof value === 'string' && value.length <= 500 ? value : '';
  const ready = data.status === 'ready';
  const context = { provider: ready ? stringValue(data.provider) : '', model: ready ? stringValue(data.model) : '', sessionId: stringValue(data.sessionId), reasoningEffort: ready ? stringValue(data.reasoningEffort) : '', status: ['ready', 'loading', 'unavailable'].includes(data.status) ? data.status : 'unavailable' };
  if (JSON.stringify(context) === JSON.stringify(state.harnessContext)) return;
  state.harnessContext = context; ++state.modelTicket; state.models = [];
  $('feedback-model').replaceChildren(el('option', '', '正在确认可用模型…'));
  $('feedback-model').firstElementChild.value = '';
  renderModelRoute();
  if (!currentHarnessRoute()) loadModels();
}
async function loadModels() {
  if (currentHarnessRoute() || state.harnessContext?.status === 'loading') { renderModelRoute(); return; }
  const ticket = ++state.modelTicket;
  const select = $('feedback-model');
  try {
    const result = await api('models');
    if (ticket !== state.modelTicket || currentHarnessRoute()) return;
    const candidates = Array.isArray(result) ? result : result.models || [];
    state.models = candidates.map((model) => typeof model === 'string' ? { id: model, name: model } : { ...model, id: model.id || model.model || model.modelId, provider: model.provider || model.providerId }).filter((model) => model.id);
    const options = state.models.map((model, index) => { const option = el('option', '', model.name || model.label || model.id); option.value = String(index); return option; });
    const placeholder = el('option', '', '选择已配置的模型'); placeholder.value = '';
    select.replaceChildren(placeholder, ...options);
    if (!options.length) { select.append(el('option', '', '没有可用模型')); $('model-status').textContent = result.reason || result.message || '请在 DeepSeek Harness 中配置模型后重试。'; }
    else {
      const saved = readPreference(modelKey()); const index = state.models.findIndex((model) => `${model.provider || ''}/${model.id}` === saved); select.value = index >= 0 ? String(index) : '';
      $('model-status').textContent = '尚未收到当前 DSH 会话的模型信息，可明确选择已配置的模型。请求会使用模型额度。';
    }
    renderModelRoute();
  } catch (error) { if (ticket !== state.modelTicket || currentHarnessRoute()) return; state.models = []; select.replaceChildren(el('option', '', '模型服务暂不可用')); $('model-status').textContent = error.message; renderModelRoute(); }
}
async function loadFeedback(id) {
  try {
    const result = await api('feedback', { id }); if (state.active?.id !== id) return;
    const fragment = document.createDocumentFragment();
    for (const feedback of (result.feedback || []).slice(-10).reverse()) {
      const entry = el('article', 'feedback-entry'); const header = el('header');
      header.append(el('span', 'ai-badge', 'AI 生成'), el('span', '', [feedback.model, displayDate(feedback.generated || feedback.created || feedback.timestamp)].filter(Boolean).join(' · ')));
      entry.append(header, el('p', '', feedback.text || feedback.comment || feedback.content || ''));
      if (feedback.annotation_ids?.length) entry.append(el('p', 'small muted', `依据 ${feedback.annotation_ids.length} 条批注`)); fragment.append(entry);
    }
    $('feedback-list').replaceChildren(fragment);
  } catch (error) { if (state.active?.id === id) { $('feedback-status').textContent = `已有反馈暂未读取：${error.message}`; $('feedback-status').classList.add('error'); } }
}
async function requestFeedback(id = state.active?.id, automatic = false) {
  if (!id) return;
  if (state.harnessContext?.status === 'loading') { toast('当前 DSH 会话的模型尚在读取。批注已保存，模型就绪后可请求反馈。'); return; }
  if (state.aiBusy) { if (automatic) toast('AI 请求仍在进行；本次批注已保存，可稍后手动请求新反馈。'); return; }
  if (!currentHarnessRoute() && !state.models.length) await loadModels();
  const model = currentHarnessRoute() || manualModel();
  if (!model) { toast('批注已保留。请在 DSH 当前会话选择模型，或在此明确选择已配置的模型。', true); return; }
  state.aiBusy = true; $('request-feedback').disabled = true;
  $('feedback-status').classList.remove('error'); $('feedback-status').textContent = '正在根据已保存批注生成反馈…';
  if (automatic) toast('批注已保存，正在请求 AI 反馈…');
  try {
    await api('ai_feedback', { id, model: model.id, provider: model.provider, ...(model.sessionId ? { session_id: model.sessionId } : {}), ...(model.reasoningEffort ? { reasoning_effort: model.reasoningEffort } : {}) });
    if (state.active?.id === id) { $('feedback-status').textContent = '反馈已保存，标记为 AI 生成。'; await loadFeedback(id); await loadAnnotations(id); if (state.active.pdf) await requestPage(state.page); }
    toast('AI 反馈已保存');
  } catch (error) {
    if (state.active?.id === id) { $('feedback-status').textContent = `反馈未生成：${error.message}\n批注已保存，可修复模型配置后重试。`; $('feedback-status').classList.add('error'); }
    toast(`AI 反馈未完成：${error.message}`, true);
  } finally { state.aiBusy = false; renderModelRoute(); }
}

function svgEl(tag, attrs, text) { const node = document.createElementNS('http://www.w3.org/2000/svg', tag); for (const [key, value] of Object.entries(attrs || {})) node.setAttribute(key, value); if (text !== undefined) node.textContent = text; return node; }
async function loadGraph() {
  if (!state.active) return; const id = state.active.id;
  $('graph-stage').replaceChildren(el('div', 'loading', '正在整理文献联系…'));
  try {
    const graph = await api('graph', { id, limit: 80 }); if (id !== state.active?.id) return;
    renderGraph(graph);
  } catch (error) { if (id === state.active?.id) $('graph-stage').replaceChildren(emptyState('图谱暂未读取', error.message)); }
}
function renderGraph(graph) {
  const nodes = (graph.nodes || []).slice(0, 80); const byId = new Map(nodes.map((node) => [node.id, node]));
  const edges = (graph.edges || []).filter((edge) => byId.has(edge.source) && byId.has(edge.target)).slice(0, 160);
  if (!nodes.length) { $('graph-stage').replaceChildren(emptyState('从一条联系开始', '添加文献关系或标签，图谱会随之生长。')); $('graph-links').replaceChildren(); $('graph-status').textContent = ''; return; }
  const width = 760, height = nodes.length > 18 ? 500 : 390; const center = nodes.find((node) => node.id === state.active?.id) || nodes[0];
  const positions = new Map([[center.id, { x: width / 2, y: height / 2 }]]); const rest = nodes.filter((node) => node.id !== center.id);
  rest.forEach((node, index) => { const ring = rest.length > 18 && index >= 18 ? 2 : 1; const start = ring === 2 ? 18 : 0; const count = ring === 2 ? rest.length - 18 : Math.min(rest.length, 18); const angle = ((index - start) / count) * Math.PI * 2 - Math.PI / 2; positions.set(node.id, { x: width / 2 + Math.cos(angle) * (ring === 2 ? 295 : rest.length > 18 ? 150 : 225), y: height / 2 + Math.sin(angle) * (ring === 2 ? 210 : rest.length > 18 ? 112 : 132) }); });
  const svg = svgEl('svg', { viewBox: `0 0 ${width} ${height}`, role: 'group', 'aria-label': '文献关系图，文献节点可通过 Tab 键选中并打开' });
  for (const edge of edges) { const source = positions.get(edge.source), target = positions.get(edge.target); const line = svgEl('line', { x1: source.x, y1: source.y, x2: target.x, y2: target.y, stroke: edge.relation === 'contradicts' ? '#b27b64' : '#cbd4c4', 'stroke-width': 1.2, 'stroke-dasharray': edge.relation === 'related' ? '4 4' : 'none' }); line.append(svgEl('title', {}, `${relationNames[edge.relation] || edge.relation} · ${provenanceText(edge.provenance)}`)); svg.append(line); }
  for (const node of nodes) {
    const point = positions.get(node.id); const isPaper = node.type !== 'tag'; const isCenter = node.id === center.id;
    const group = svgEl('g', { transform: `translate(${point.x},${point.y})`, class: 'graph-node', ...(isPaper ? { tabindex: '0', role: 'button', 'aria-label': `打开文献：${node.label}` } : { role: 'img', 'aria-label': `标签：${node.label}` }) });
    group.dataset.graphId = node.id; group.dataset.nodeType = node.type || 'paper';
    group.append(svgEl('title', {}, node.label), svgEl('circle', { r: isCenter ? 15 : isPaper ? 8 : 5, fill: isPaper ? '#28675c' : '#b8995a', stroke: '#fdfcf8', 'stroke-width': 3 }));
    if (nodes.length <= 22 || isCenter) { const label = String(node.label || ''); group.append(svgEl('text', { x: 0, y: isCenter ? 34 : 24, 'text-anchor': 'middle', fill: '#61715e', 'font-size': isCenter ? 12 : 10 }, label.length > 24 ? `${label.slice(0, 23)}…` : label)); }
    svg.append(group);
  }
  $('graph-stage').replaceChildren(svg);
  $('graph-status').textContent = `${nodes.length} 个节点 · ${edges.length} 条联系${graph.truncated || graph.nodes?.length > 80 || (graph.edges?.length > 160) ? ' · 当前展示范围已达上限' : ''}。关系依据见下方；节点位置仅用于浏览。`;
  const fragment = document.createDocumentFragment();
  for (const edge of edges.slice(0, 40)) {
    const row = el('div', 'graph-link-row'); row.append(el('span', '', `${byId.get(edge.source)?.label || edge.source} `), el('strong', '', relationNames[edge.relation] || edge.relation), el('span', '', ` ${byId.get(edge.target)?.label || edge.target}`));
    row.append(el('p', '', `依据：${provenanceText(edge.provenance)}${edge.note ? ` · ${edge.note}` : ''}`)); fragment.append(row);
  }
  if (!edges.length) fragment.append(el('p', 'muted small', '当前文献还没有联系。可添加标签，或手动记录文献之间的支持、矛盾与引用关系。'));
  if (edges.length > 40) fragment.append(el('p', 'small muted', '下方列出前 40 条关系。打开具体文献可缩小图谱范围。'));
  $('graph-links').replaceChildren(fragment);
}
function provenanceText(provenance) { if (!provenance) return '来源未记录'; if (typeof provenance === 'string') return ({ manual: '手动记录', 'user-asserted': '读者明确记录', tag: '文献标签', metadata: '文献资料', 'catalog-metadata': '文献库标签资料' })[provenance] || provenance; return [provenance.kind || provenance.type || provenance.source, provenance.note, provenance.created].filter(Boolean).join(' · ') || JSON.stringify(provenance); }
async function loadLinkTargets() {
  const query = $('link-search').value.trim(); const source = $('link-form').dataset.itemId;
  try { const result = await api('list', { query, limit: 40, offset: 0 }); if (query !== $('link-search').value.trim() || source !== $('link-form').dataset.itemId) return; const options = [el('option', '', '选择目标文献')]; options[0].value = ''; for (const item of (result.items || []).filter((entry) => entry.id !== source)) { const option = el('option', '', title(item)); option.value = item.id; options.push(option); } $('link-target').replaceChildren(...options); }
  catch (error) { errorAt('link-error', error); }
}
function openLink() { if (!state.active) return; $('link-form').dataset.itemId = state.active.id; $('link-source').textContent = title(state.active); $('link-search').value = ''; $('link-note').value = ''; errorAt('link-error', null); openDialog('link-dialog'); loadLinkTargets(); }
async function saveLink(event) {
  event.preventDefault(); setBusy(event.target, true); errorAt('link-error', null);
  try { await api('link', { source: event.target.dataset.itemId, target: $('link-target').value, relation: $('link-relation').value, note: $('link-note').value.trim() }); closeDialog('link-dialog'); await loadGraph(); toast('文献联系已保存'); }
  catch (error) { errorAt('link-error', error); } finally { setBusy(event.target, false); }
}

$('paper-list').addEventListener('click', (event) => { const card = event.target.closest('[data-id]'); if (card) openPaper(card.dataset.id); });
$('search').addEventListener('input', debounce(() => { state.query = $('search').value.trim(); state.offset = 0; loadList(); }));
$('previous-list').addEventListener('click', () => { state.offset = Math.max(0, state.offset - state.limit); loadList(); });
$('next-list').addEventListener('click', () => { state.offset += state.limit; loadList(); });
$('refresh').addEventListener('click', () => { loadStatus(); loadList(); if (state.active && state.tab === 'annotations') loadModels(); });
$('export-library').addEventListener('click', exportLibrary);
$('back-library').addEventListener('click', () => document.querySelector('.workspace').classList.remove('show-detail'));
for (const button of document.querySelectorAll('[data-tab]')) button.addEventListener('click', () => switchTab(button.dataset.tab));
$('import-open').addEventListener('click', () => { errorAt('import-error', null); $('import-result').textContent = ''; openDialog('import-dialog'); });
$('welcome-import').addEventListener('click', () => { if (state.libraryCount) { if (state.items[0]) openPaper(state.items[0].id); else { document.querySelector('.workspace').classList.remove('show-detail'); $('search').focus(); } } else { errorAt('import-error', null); $('import-result').textContent = ''; openDialog('import-dialog'); } });
for (const button of document.querySelectorAll('.dialog-close')) button.addEventListener('click', () => button.closest('dialog').close());
for (const dialog of document.querySelectorAll('dialog')) dialog.addEventListener('click', (event) => { if (event.target === dialog) { const rect = dialog.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close(); } });
$('import-form').addEventListener('submit', importPapers);
$('import-file').addEventListener('change', () => chooseUpload($('import-file').files[0]));
$('import-source').addEventListener('input', () => { if ($('import-source').value.trim()) { state.upload = null; $('import-file').value = ''; $('upload-label').textContent = '选择文件，或拖到这里'; } });
$('drop-zone').addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); $('import-file').click(); } });
for (const name of ['dragenter', 'dragover']) $('drop-zone').addEventListener(name, (event) => { event.preventDefault(); $('drop-zone').classList.add('drag-over'); });
for (const name of ['dragleave', 'drop']) $('drop-zone').addEventListener(name, (event) => { event.preventDefault(); $('drop-zone').classList.remove('drag-over'); if (name === 'drop') chooseUpload(event.dataTransfer.files[0]); });
$('metadata-open').addEventListener('click', openMetadata); $('metadata-form').addEventListener('submit', saveMetadata);
$('attach-open').addEventListener('click', () => { if (!state.active) return; $('attach-form').dataset.itemId = state.active.id; errorAt('attach-error', null); openDialog('attach-dialog'); }); $('attach-form').addEventListener('submit', attachPdf);
$('copy-apa').addEventListener('click', () => cite('apa')); $('export-bib').addEventListener('click', () => cite('biblatex')); $('export-notes').addEventListener('change', exportNotes);
$('previous-page').addEventListener('click', () => requestPage(state.page - 1)); $('next-page').addEventListener('click', () => requestPage(state.page + 1));
$('page-number').addEventListener('change', () => requestPage($('page-number').value));
$('word-layer').addEventListener('pointerup', () => setTimeout(readSelection, 0)); $('word-layer').addEventListener('keyup', readSelection);
$('clear-selection').addEventListener('click', clearSelection); $('annotate-selection').addEventListener('click', () => openAnnotation('highlight'));
$('page-note').addEventListener('click', () => openAnnotation('note')); $('annotation-form').addEventListener('submit', saveAnnotation); $('annotation-list').addEventListener('click', handleNoteAction);
$('request-feedback').addEventListener('click', () => requestFeedback());
$('auto-feedback').addEventListener('change', () => { savePreference(preferenceKey(), String($('auto-feedback').checked)); if ($('auto-feedback').checked) toast('已开启：保存批注后会调用所选模型，并使用模型额度。'); });
$('feedback-model').addEventListener('change', () => { const model = manualModel(); if (model) savePreference(modelKey(), `${model.provider || ''}/${model.id}`); renderModelRoute(); });
$('link-open').addEventListener('click', openLink); $('link-form').addEventListener('submit', saveLink); $('link-search').addEventListener('input', debounce(loadLinkTargets));
function activateGraphNode(event) { const node = event.target.closest('[data-graph-id]'); if (node && node.dataset.nodeType !== 'tag') openPaper(node.dataset.graphId); }
$('graph-stage').addEventListener('click', activateGraphNode); $('graph-stage').addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); activateGraphNode(event); } });
document.addEventListener('keydown', (event) => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close(); document.querySelector('.workspace').classList.remove('show-detail'); $('search').focus(); $('search').select(); } });
async function initialize() { announceReady(); await loadStatus(); await loadList(); loadModels(); }
const currentModelDisplay = el('div', 'current-harness-model'); currentModelDisplay.id = 'current-harness-model'; currentModelDisplay.hidden = true;
currentModelDisplay.append(el('span', '', '当前 DSH 模型'));
const currentModelName = el('strong'); currentModelName.id = 'current-harness-model-name'; currentModelDisplay.append(currentModelName);
$('feedback-model').closest('label').before(currentModelDisplay);
const refreshModels = el('button', 'button subtle', '刷新模型');
refreshModels.id = 'refresh-models';
refreshModels.type = 'button'; refreshModels.style.marginTop = '6px'; refreshModels.style.padding = '3px 0'; refreshModels.style.fontSize = '10px';
refreshModels.addEventListener('click', () => { announceReady(); loadModels(); }); $('model-status').after(refreshModels);
window.addEventListener('message', receiveHarnessContext);
initialize();
