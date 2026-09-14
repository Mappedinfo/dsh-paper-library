'use strict';

// No document or image cache: the UI holds one bounded list and one rendered PDF page.
const $ = (id) => document.getElementById(id);
const state = {
  items: [], total: 0, libraryCount: 0, offset: 0, limit: 40, query: '', active: null, tab: 'reader',
  page: 1, pageCount: 0, pageData: null, selection: null, annotations: [], noteOffset: 0,
  models: [], harnessContext: null, modelTicket: 0, library: '', listTicket: 0, itemTicket: 0, pageTicket: 0, metadataDraft: null, openedId: null,
  pageWanted: null, pageRunning: false, pagePromise: null, annotationDraft: null, aiBusy: false,
};
let paperChatUI;
let readerRestore = null;
let restoringReader = false;
let initializedReader = false;
const intake = { pending: [], records: [], running: false, current: null, sequence: 0, total: 0, completed: 0, failed: 0, metadataOnly: 0, promise: null };
const relationNames = { related: '相关', supports: '支持', contradicts: '相矛盾', cites: '引用', tagged: '标签', tag: '标签', has_tag: '标签' };
const typeNames = { 'article-journal': '期刊论文', 'paper-conference': '会议论文', book: '图书', chapter: '章节', thesis: '学位论文', report: '报告', document: '文献' };

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
async function api(action, args = {}) {
  let response;
  // The server rejects excess requests before reading or dispatching them. Retry
  // only that explicit admission response; an uncertain mutation is never replayed.
  for (let attempt = 0; attempt < 5; attempt++) {
    response = await fetch('./api', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, ...args }) });
    if (response.status !== 429 || attempt === 4) break;
    await response.text();
    await new Promise(resolve => setTimeout(resolve, 250 * 2 ** attempt));
  }
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
    paperChatUI?.setAvailable(result.paper_conversations);
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
  $('paper-title').textContent = '正在打开文献…'; $('paper-authors').textContent = ''; $('paper-tags').replaceChildren(); $('paper-file-meta').hidden = true;
  state.active = null; state.selection = null; state.page = 1; state.pageCount = 0;
  $('reader-content').hidden = true; $('no-pdf').hidden = true;
  try {
    const item = await api('get', { id }); if (ticket !== state.itemTicket) return;
    state.active = item; renderPaperHeader(); renderList();
    void paperChatUI?.paperOpened(item);
    await switchTab('reader');
    if (item.pdf) loadAnnotations(id); else renderAnnotations(); loadFeedback(id);
    publishReaderState();
  } catch (error) { if (ticket === state.itemTicket) { $('paper-title').textContent = '文献未能打开'; errorAt('detail-error', error); } }
}
function renderPaperHeader() {
  const item = state.active; if (!item) return;
  $('paper-title').textContent = title(item);
  const details = [authors(item), year(item), item['container-title']].filter(Boolean);
  $('paper-authors').textContent = details.join(' · ');
  $('paper-type').textContent = `${typeNames[item.type] || '文献'}${item.citekey ? ` / ${item.citekey}` : ''}`;
  $('paper-tags').replaceChildren(...tags(item).map((tag) => el('span', 'chip', tag)));
  const fileNotes = [item.pdf_filename ? `PDF：${item.pdf_filename}` : '', item.parse?.needs_review ? '自动识别的文献资料待核对' : ''].filter(Boolean);
  $('paper-file-meta').textContent = fileNotes.join(' · '); $('paper-file-meta').hidden = !fileNotes.length; $('paper-file-meta').classList.toggle('needs-review', Boolean(item.parse?.needs_review));
  $('download-pdf').hidden = !item.pdf; $('download-pdf').href = `./pdf/${encodeURIComponent(item.id)}`;
  $('no-pdf').hidden = Boolean(item.pdf); $('reader-content').hidden = !item.pdf;
}
async function switchTab(tab) {
  state.tab = tab;
  for (const node of document.querySelectorAll('.tab')) { const selected = node.dataset.tab === tab; node.classList.toggle('active', selected); if (selected) node.setAttribute('aria-current', 'page'); else node.removeAttribute('aria-current'); }
  for (const name of ['reader', 'annotations', 'conversation', 'graph']) $(`${name}-tab`).hidden = name !== tab;
  paperChatUI?.visible(tab === 'conversation');
  if (!state.active) return;
  if (tab === 'reader' && state.active.pdf && !state.pageData) await requestPage(state.page);
  if (tab === 'annotations') { if (state.active.pdf) await loadAnnotations(state.active.id); else renderAnnotations(); loadFeedback(state.active.id); if (!paperChatUI?.available() && !currentHarnessRoute() && !state.models.length) loadModels(); }
  if (tab === 'graph') await loadGraph();
  publishReaderState();
}
function requestPage(page) {
  if (!state.active?.pdf) return;
  const next = Math.max(1, Math.min(Number(page) || 1, state.pageCount || Infinity));
  state.pageWanted = { id: state.active.id, page: next, ticket: ++state.pageTicket };
  clearPage();
  if (state.pageRunning) return state.pagePromise;
  state.pageRunning = true;
  state.pagePromise = renderPageQueue();
  return state.pagePromise;
}
async function renderPageQueue() {
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
        publishReaderState();
      } catch (error) { if (wanted.ticket === state.pageTicket && wanted.id === state.active?.id) errorAt('detail-error', error); }
    }
  } finally {
    state.pageRunning = false; state.pagePromise = null; $('page-loading').hidden = true;
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
    const actions = el('div', 'annotation-actions'); const edit = el('button', 'button subtle', '编辑'); edit.dataset.noteAction = 'edit'; const remove = el('button', 'button subtle delete-note', '删除'); remove.dataset.noteAction = 'delete'; actions.append(edit, remove);
    if (paperChatUI?.available() && note.kind !== 'ai-feedback' && note.type !== 'ai_feedback' && !note.ai_generated) { const discuss = el('button', 'button subtle', paperChatUI.hasAnnotation(note.id) ? '移出本次引用' : '加入本次引用'); discuss.dataset.noteAction = 'discuss'; actions.append(discuss); }
    card.append(actions); fragment.append(card);
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
  $('annotation-save-draft').hidden = !paperChatUI?.available(); publishReaderState();
}
async function saveAnnotation(event) {
  event.preventDefault(); const draft = state.annotationDraft; if (!draft) return;
  setBusy(event.target, true); errorAt('annotation-error', null);
  try {
    const result = draft.mode === 'edit'
      ? await api('annotation_update', { id: draft.id, annotation_id: draft.note.id, comment: $('annotation-comment').value })
      : await api('annotate', { id: draft.id, page: draft.page, type: draft.mode, text: draft.selection?.text || '', rects: draft.selection?.rects || [[20, 20, 40, 40]], comment: $('annotation-comment').value, author: 'Reader', color: '#ffdb66' });
    closeDialog('annotation-dialog'); clearSelection(); toast('批注已保存到 PDF');
    if (state.active?.id === draft.id) { await loadAnnotations(draft.id); if (state.page === draft.page) await requestPage(state.page); }
    publishReaderState();
    if (paperChatUI?.available()) await paperChatUI.savedAnnotation(draft.id, result.annotation?.id || draft.note?.id, event.submitter?.id === 'annotation-save-draft');
    else if ($('auto-feedback').checked) requestFeedback(draft.id, true);
  } catch (error) { errorAt('annotation-error', error); } finally { setBusy(event.target, false); }
}
async function handleNoteAction(event) {
  const button = event.target.closest('[data-note-action]'); if (!button) return;
  const action = button.dataset.noteAction;
  if (action === 'previous' || action === 'next') { state.noteOffset += action === 'next' ? 40 : -40; renderAnnotations(); return; }
  const note = state.annotations.find((entry) => entry.id === button.closest('[data-annotation-id]').dataset.annotationId); if (!note) return;
  if (action === 'discuss') { await paperChatUI?.useAnnotation(note); if (state.active?.id) renderAnnotations(); return; }
  if (action === 'page') { state.page = note.page; clearPage(); await switchTab('reader'); }
  if (action === 'edit') openAnnotation('edit', note);
  if (action === 'delete') {
    if (button.dataset.confirm !== 'true') { button.dataset.confirm = 'true'; button.textContent = '确认删除'; setTimeout(() => { if (button.isConnected) { delete button.dataset.confirm; button.textContent = '删除'; } }, 5000); return; }
    const id = state.active.id; button.disabled = true;
    try { await api('annotation_delete', { id, annotation_id: note.id }); toast('批注已删除'); if (state.active?.id === id) { await loadAnnotations(id); await paperChatUI?.annotationsChanged(id); if (note.page === state.page) await requestPage(state.page); } }
    catch (error) { toast(error.message, true); button.disabled = false; }
  }
}

function fileBase64(file) { return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.onerror = () => reject(new Error('无法读取所选文件。')); reader.readAsDataURL(file); }); }
function linkArguments(value) {
  const source = String(value || '').trim().replace(/^<(.*)>$/, '$1');
  if (/^(?:doi:\s*)?10\.\d{4,9}\/\S+$/i.test(source)) return { doi: source.replace(/^doi:\s*/i, '') };
  if (/^https?:\/\//i.test(source)) { try { const url = new URL(source); if (!url.username && !url.password && url.href.length <= 4096) return { url: url.href }; } catch {} }
  return null;
}
function importWarning(value) { return typeof value === 'string' ? value : value?.message || JSON.stringify(value); }
function importCount(value) { return Array.isArray(value) ? value.length : Number(value) || 0; }
function newImportSummary() { return { imported: 0, duplicates: 0, skipped: 0, pdfCount: 0, recordCount: 0, firstItem: null, filenames: [], needsReview: false, parseStatuses: [], warnings: [], warningCount: 0, acquisition: null }; }
function addImportResult(summary, result) {
  summary.imported += importCount(result.imported); summary.duplicates += importCount(result.duplicates); summary.skipped += importCount(result.skipped);
  const items = result.items || []; summary.recordCount += items.length; summary.pdfCount += items.filter(item => item.pdf).length;
  if (!summary.firstItem && items[0]) summary.firstItem = { id: items[0].id, title: title(items[0]), pdf: Boolean(items[0].pdf) };
  for (const item of items) {
    if (item.pdf_filename && summary.filenames.length < 3) summary.filenames.push(item.pdf_filename);
    summary.needsReview ||= Boolean(item.parse?.needs_review);
    if (item.parse?.status && !summary.parseStatuses.includes(item.parse.status)) summary.parseStatuses.push(item.parse.status);
  }
  if (result.acquisition) summary.acquisition = { status: result.acquisition.status, source_url: result.acquisition.source_url };
  const warnings = new Set([...(result.warnings || []), ...(result.acquisition?.warnings || []), ...items.flatMap(item => item.parse?.warnings || [])].map(importWarning));
  for (const warning of warnings) { if (summary.warnings.includes(warning)) continue; summary.warningCount++; if (summary.warnings.length < 100) summary.warnings.push(warning); }
}
function importOutcome(summary) {
  let text;
  if (summary.pdfCount) text = `${summary.pdfCount} 篇 PDF 已在文献库中保存`;
  else if (summary.recordCount || summary.imported || summary.duplicates) text = '仅保存文献资料，尚未取得 PDF';
  else text = '未保存文献或 PDF';
  if (summary.imported > 1) text += ` · 新增 ${summary.imported} 篇`;
  if (summary.duplicates) text += ` · 重复 ${summary.duplicates} 篇`;
  if (summary.skipped) text += ` · 跳过 ${summary.skipped} 项`;
  if (summary.needsReview) text += ' · 自动识别资料待核对';
  else if (summary.parseStatuses.includes('embedded-metadata')) text += ' · 已读取 PDF 内的文献资料';
  else if (summary.parseStatuses.includes('local-parse')) text += ' · 已提取 PDF 资料';
  return text;
}
async function uploadPdf(file) {
  if (file.size > 250 * 1024 * 1024) throw new Error('PDF 超过 250 MiB，请使用较小文件。');
  // A File is sent directly. No FileReader/base64/ArrayBuffer copy for PDFs.
  const response = await fetch(`./upload?filename=${encodeURIComponent(file.name)}`, { method: 'POST', headers: { 'Content-Type': 'application/pdf' }, body: file });
  let data;
  try { data = await response.json(); } catch { throw new Error(`PDF 上传未返回可读取的结果（HTTP ${response.status}）。可重新拖入重试。`); }
  if (!response.ok || !data.ok) throw new Error(typeof data.error === 'string' ? data.error : data.error?.message || `PDF 未保存（HTTP ${response.status}）`);
  return data.result;
}
async function executeImport(job) {
  const summary = newImportSummary(); job.summary = summary;
  if (job.file && /\.pdf$/i.test(job.file.name)) {
    job.message = '正在上传、保存并解析 PDF…'; renderImportQueue();
    addImportResult(summary, await uploadPdf(job.file)); return summary;
  }
  let args = job.args;
  if (job.file) {
    if (!/\.(json|ris|bib)$/i.test(job.file.name)) throw new Error('文件格式暂不支持。请导入 PDF、JSON、RIS 或 BIB。');
    if (job.file.size > 32 * 1024 * 1024) throw new Error('资料文件超过 32 MiB，请分批导出后重新导入。');
    args = { filename: job.file.name, content_base64: await fileBase64(job.file) };
  }
  let offset = 0;
  while (true) {
    job.message = args.url || args.doi ? '正在获取论文、保存并解析资料…' : '正在保存并解析文献资料…'; renderImportQueue();
    const result = await api('import', { ...args, offset, limit: 100 }); addImportResult(summary, result);
    const total = result.total_files ?? result.total_records;
    if (total !== undefined) { job.message = `已处理 ${result.next_offset ?? total} / ${total} ${result.total_files !== undefined ? '个 PDF' : '条记录'} · 已导入 ${summary.imported} 篇`; renderImportQueue(); }
    if (result.done !== false || result.next_offset === null || result.next_offset === undefined) break;
    if (result.next_offset <= offset) throw new Error('批量导入未继续推进。已完成的记录已保留，可重试。');
    offset = result.next_offset;
  }
  return summary;
}
function renderImportQueue() {
  $('queue-toggle').hidden = !intake.total;
  const done = intake.completed + intake.failed;
  $('queue-toggle').textContent = intake.running ? `导入 ${done}/${intake.total}` : '导入结果';
  $('queue-summary').textContent = `${intake.running ? '正在依次处理' : '处理已结束'} · ${done}/${intake.total}${intake.failed ? ` · 失败 ${intake.failed}` : ''}${intake.metadataOnly ? ` · 仅文献资料 ${intake.metadataOnly}` : ''}`;
  const fragment = document.createDocumentFragment();
  for (const job of intake.records.slice(-50)) {
    const row = el('li', `queue-entry ${job.status}`); row.dataset.queueId = String(job.id);
    row.append(el('strong', '', `${job.status === 'pending' ? '等待 · ' : job.status === 'working' ? '正在处理 · ' : job.status === 'failed' ? '未完成 · ' : ''}${job.label}`), el('p', '', job.message || '等待前一项完成'));
    const summary = job.summary;
    if (summary?.filenames.length) row.append(el('p', 'saved-name', `保存文件：${summary.filenames.join('；')}`));
    if (summary?.warnings.length) row.append(el('p', 'queue-warning', `${summary.warnings.slice(0, 3).join('\n')}${summary.warningCount > 3 ? `\n还有 ${summary.warningCount - 3} 条提示，打开文献后请核对资料。` : ''}`));
    if (summary?.firstItem?.id) { const open = el('button', 'queue-paper', `打开：${summary.firstItem.title}`); open.dataset.queuePaper = summary.firstItem.id; row.append(open); }
    if (job.status === 'failed' && job.args) { const retry = el('button', 'button subtle queue-retry', '重试'); retry.dataset.queueRetry = String(job.id); row.append(retry); }
    if (job.status === 'failed' && !job.args) row.append(el('p', '', '可重新拖入这个文件重试。'));
    fragment.append(row);
  }
  $('queue-list').replaceChildren(fragment);
}
function enqueueImports(sources) {
  const capacity = Math.max(0, 50 - intake.pending.length - (intake.current ? 1 : 0));
  const accepted = sources.slice(0, capacity);
  for (const source of accepted) {
    const job = { ...source, id: ++intake.sequence, status: 'pending', message: '', summary: null };
    intake.pending.push(job); intake.records.push(job); intake.total++;
  }
  // Completed history never holds File objects or grows with library size.
  if (intake.records.length > 50) intake.records.splice(0, intake.records.length - 50);
  if (sources.length > accepted.length) toast(`队列最多同时处理 50 项；还有 ${sources.length - accepted.length} 项尚未加入，请稍后分批导入。`, true);
  if (accepted.length) { $('import-queue').hidden = false; renderImportQueue(); if (!intake.running) intake.promise = runImportQueue(); }
  return accepted.length;
}
async function runImportQueue() {
  intake.running = true;
  try {
    while (intake.pending.length) {
      const job = intake.pending.shift(); intake.current = job; job.status = 'working'; renderImportQueue();
      try {
        const summary = await executeImport(job);
        job.status = summary.pdfCount ? 'done' : summary.recordCount || summary.imported || summary.duplicates ? 'review' : 'skipped';
        job.message = importOutcome(summary); intake.completed++; if (!summary.pdfCount && (summary.recordCount || summary.imported || summary.duplicates)) intake.metadataOnly++;
        if (job.inputId && $(job.inputId).value.trim() === job.originalInput) $(job.inputId).value = '';
      } catch (error) {
        job.status = 'failed'; intake.failed++;
        const partial = job.summary && (job.summary.imported || job.summary.duplicates) ? `\n已完成部分已保留：${importOutcome(job.summary)}` : '';
        job.message = `${error.message || '导入未完成'}${partial}`;
      } finally {
        job.file = null; intake.current = null; renderImportQueue();
      }
      state.offset = 0; await loadList(); await loadStatus();
      if (!state.active && !state.openedId && job.summary?.firstItem?.id) await openPaper(job.summary.firstItem.id);
    }
  } finally { intake.running = false; intake.current = null; renderImportQueue(); }
}
function enqueueFiles(files) {
  const sources = Array.from(files || []).map(file => ({ file, label: file.name || '未命名文件' }));
  const count = enqueueImports(sources);
  if (count && $('import-dialog').open) closeDialog('import-dialog');
  return count;
}
function enqueueLink(value, inputId = null) {
  const originalInput = String(value || '').trim(); const args = linkArguments(originalInput); if (!args) return false;
  return enqueueImports([{ args, label: originalInput, originalInput, inputId }]) > 0;
}
function editableTarget(target) { return Boolean(target?.isContentEditable || target?.closest?.('input, textarea, select, [contenteditable]')); }
function handlePaste(event) {
  const text = event.clipboardData?.getData('text/plain')?.trim(); if (!text || !linkArguments(text)) return;
  const inputId = ['quick-import-source', 'import-source'].includes(event.target?.id) ? event.target.id : null;
  if (!inputId && editableTarget(event.target)) return;
  event.preventDefault();
  if (inputId) $(inputId).value = text;
  if (enqueueLink(text, inputId) && inputId === 'import-source') closeDialog('import-dialog');
}
function transferLinks(transfer) {
  const value = transfer?.getData('text/uri-list') || transfer?.getData('text/plain') || '';
  return value.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#')).map(value => ({ value, args: linkArguments(value) })).filter(entry => entry.args);
}
function handleDrop(event) {
  $('window-drop-overlay').hidden = true;
  const files = event.dataTransfer?.files;
  if (files?.length) { event.preventDefault(); enqueueFiles(files); return; }
  if (editableTarget(event.target) && !['quick-import-source', 'import-source'].includes(event.target.id)) return;
  const links = transferLinks(event.dataTransfer); if (!links.length) return;
  event.preventDefault(); enqueueImports(links.map(entry => ({ args: entry.args, label: entry.value })));
  if ($('import-dialog').open) closeDialog('import-dialog');
}
function handleDragOver(event) {
  const types = Array.from(event.dataTransfer?.types || []);
  if (types.includes('Files')) { event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'; $('window-drop-overlay').hidden = false; }
  else if (!editableTarget(event.target) && (types.includes('text/uri-list') || types.includes('text/plain'))) event.preventDefault();
}
function importPapers(event) {
  event.preventDefault(); const source = $('import-source').value.trim(); errorAt('import-error', null);
  if (!source) { errorAt('import-error', '请粘贴论文链接、DOI 或填写本地路径，也可直接选择文件。'); return; }
  const args = linkArguments(source) || { path: source };
  if (enqueueImports([{ args, label: source, inputId: 'import-source', originalInput: source }])) closeDialog('import-dialog');
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
  if (event.origin === window.location.origin && event.source === window.parent && window.parent !== window && event.data?.version === 1) {
    if (event.data.type === 'paper-library:restore') {
      readerRestore = event.data.snapshot;
      if (initializedReader) void restoreReaderState();
      return;
    }
    if (event.data.type === 'paper-library:reader-state-error') { toast(event.data.error || '阅读草稿暂未保存到主窗口。', true); return; }
  }
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
$('back-library').addEventListener('click', () => { document.querySelector('.workspace').classList.remove('show-detail'); paperChatUI?.visible(false); });
for (const button of document.querySelectorAll('[data-tab]')) button.addEventListener('click', () => switchTab(button.dataset.tab));
$('import-open').addEventListener('click', () => { errorAt('import-error', null); $('import-result').textContent = ''; openDialog('import-dialog'); });
$('welcome-import').addEventListener('click', () => { if (state.libraryCount) { if (state.items[0]) openPaper(state.items[0].id); else { document.querySelector('.workspace').classList.remove('show-detail'); $('search').focus(); } } else { errorAt('import-error', null); $('import-result').textContent = ''; openDialog('import-dialog'); } });
for (const button of document.querySelectorAll('.dialog-close')) button.addEventListener('click', () => button.closest('dialog').close());
for (const dialog of document.querySelectorAll('dialog')) dialog.addEventListener('click', (event) => { if (event.target === dialog) { const rect = dialog.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close(); } });
$('import-form').addEventListener('submit', importPapers);
$('import-file').addEventListener('change', () => { enqueueFiles($('import-file').files); $('import-file').value = ''; });
$('quick-import-form').addEventListener('submit', (event) => { event.preventDefault(); if (!enqueueLink($('quick-import-source').value, 'quick-import-source')) toast('请输入完整论文链接或 DOI。', true); });
$('drop-zone').addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); $('import-file').click(); } });
$('queue-toggle').addEventListener('click', () => { $('import-queue').hidden = !$('import-queue').hidden; });
$('queue-hide').addEventListener('click', () => { $('import-queue').hidden = true; });
$('queue-list').addEventListener('click', (event) => {
  const paper = event.target.closest('[data-queue-paper]'); if (paper) { openPaper(paper.dataset.queuePaper); return; }
  const retry = event.target.closest('[data-queue-retry]'); if (!retry) return;
  const job = intake.records.find(entry => String(entry.id) === retry.dataset.queueRetry);
  if (job?.args) enqueueImports([{ args: job.args, label: job.label, inputId: job.inputId, originalInput: job.originalInput }]);
});
document.addEventListener('paste', handlePaste);
document.addEventListener('dragover', handleDragOver);
document.addEventListener('dragenter', handleDragOver);
document.addEventListener('dragleave', (event) => { if (!event.relatedTarget) $('window-drop-overlay').hidden = true; });
document.addEventListener('dragend', () => { $('window-drop-overlay').hidden = true; });
document.addEventListener('drop', handleDrop);
$('metadata-open').addEventListener('click', openMetadata); $('metadata-form').addEventListener('submit', saveMetadata);
$('attach-open').addEventListener('click', () => { if (!state.active) return; $('attach-form').dataset.itemId = state.active.id; errorAt('attach-error', null); openDialog('attach-dialog'); }); $('attach-form').addEventListener('submit', attachPdf);
$('copy-apa').addEventListener('click', () => cite('apa')); $('export-bib').addEventListener('click', () => cite('biblatex')); $('export-notes').addEventListener('change', exportNotes);
$('previous-page').addEventListener('click', () => requestPage(state.page - 1)); $('next-page').addEventListener('click', () => requestPage(state.page + 1));
$('page-number').addEventListener('change', () => requestPage($('page-number').value));
$('word-layer').addEventListener('pointerup', () => setTimeout(readSelection, 0)); $('word-layer').addEventListener('keyup', readSelection);
$('clear-selection').addEventListener('click', clearSelection); $('annotate-selection').addEventListener('click', () => openAnnotation('highlight'));
$('discuss-selection').addEventListener('click', () => paperChatUI?.useSelection(state.selection));
$('annotation-comment').addEventListener('input', publishReaderState);
$('annotation-dialog').addEventListener('close', publishReaderState);
$('page-note').addEventListener('click', () => openAnnotation('note')); $('annotation-form').addEventListener('submit', saveAnnotation); $('annotation-list').addEventListener('click', handleNoteAction);
$('request-feedback').addEventListener('click', () => requestFeedback());
$('auto-feedback').addEventListener('change', () => { savePreference(preferenceKey(), String($('auto-feedback').checked)); if ($('auto-feedback').checked) toast('已开启：保存批注后会调用所选模型，并使用模型额度。'); });
$('feedback-model').addEventListener('change', () => { const model = manualModel(); if (model) savePreference(modelKey(), `${model.provider || ''}/${model.id}`); renderModelRoute(); });
$('link-open').addEventListener('click', openLink); $('link-form').addEventListener('submit', saveLink); $('link-search').addEventListener('input', debounce(loadLinkTargets));
function activateGraphNode(event) { const node = event.target.closest('[data-graph-id]'); if (node && node.dataset.nodeType !== 'tag') openPaper(node.dataset.graphId); }
$('graph-stage').addEventListener('click', activateGraphNode); $('graph-stage').addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); activateGraphNode(event); } });
document.addEventListener('keydown', (event) => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close(); document.querySelector('.workspace').classList.remove('show-detail'); paperChatUI?.visible(false); $('search').focus(); $('search').select(); } });
function publishReaderState() {
  if (restoringReader || !state.active || window.parent === window) return true;
  const snapshot = { paperId: state.active.id, page: state.page, tab: state.tab, chatDraft: paperChatUI?.draft() || '', chatContext: paperChatUI?.context() || { annotationRefs: [] } };
  if ($('annotation-dialog').open && state.annotationDraft?.id === state.active.id) {
    const draft = state.annotationDraft;
    snapshot.annotationDraft = { mode: draft.mode, id: draft.id, page: draft.page, comment: $('annotation-comment').value,
      ...(draft.note ? { note: { id: draft.note.id, page: draft.note.page } } : {}),
      ...(draft.selection ? { selection: { page: draft.selection.page, text: draft.selection.text, rects: draft.selection.rects } } : {}),
    };
  }
  const serialized = JSON.stringify(snapshot);
  if (new Blob([serialized]).size > 256 * 1024) return false;
  window.parent.postMessage({ type: 'paper-library:reader-state', version: 1, snapshot }, window.location.origin);
  return true;
}
async function restoreReaderState() {
  if (!readerRestore || restoringReader) return;
  const snapshot = readerRestore; readerRestore = null;
  if (typeof snapshot.paperId !== 'string' || !snapshot.paperId || !Number.isInteger(snapshot.page) || snapshot.page < 1) return;
  restoringReader = true;
  try {
    await openPaper(snapshot.paperId);
    if (state.active?.id !== snapshot.paperId) return;
    if (state.active.pdf && snapshot.page !== state.page) await requestPage(snapshot.page);
    paperChatUI?.restoreDraft(snapshot.chatDraft);
    paperChatUI?.restoreContext(snapshot.chatContext);
    if (['reader', 'annotations', 'conversation', 'graph'].includes(snapshot.tab)) await switchTab(snapshot.tab);
    const draft = snapshot.annotationDraft;
    if (draft?.id === state.active.id && ['note', 'highlight', 'edit'].includes(draft.mode)) {
      if (draft.mode === 'edit') {
        await loadAnnotations(state.active.id);
        const note = state.annotations.find(note => note.id === draft.note?.id);
        if (!note) { toast('原批注已变化，未保存的文字保留在对话草稿中。', true); paperChatUI?.restoreDraft([snapshot.chatDraft, draft.comment].filter(Boolean).join('\n\n')); return; }
        openAnnotation('edit', note);
      } else {
        if (draft.selection) state.selection = draft.selection;
        openAnnotation(draft.mode);
        // A queued page render may still be completing. The saved draft's page
        // is authoritative for this annotation, independent of the reader image.
        state.annotationDraft.page = draft.page;
        $('annotation-page-label').textContent = `第 ${draft.page} 页`;
      }
      $('annotation-comment').value = draft.comment || '';
    }
  } finally { restoringReader = false; publishReaderState(); }
}
let pendingReferenceOpen = null;
async function openReferencedPaper(value) {
  if (!initializedReader) { pendingReferenceOpen = value; return; }
  if (state.active?.id !== value.paperId) await openPaper(value.paperId);
  if (state.active?.id !== value.paperId) return;
  await switchTab('reader');
  if (state.active.pdf && value.page !== state.page) await requestPage(value.page);
  publishReaderState();
}
async function initialize() { announceReady(); await loadStatus(); await loadList(); initializedReader = true; await restoreReaderState(); if (pendingReferenceOpen) { const value = pendingReferenceOpen; pendingReferenceOpen = null; await openReferencedPaper(value); } if (!paperChatUI?.available()) loadModels(); }
const currentModelDisplay = el('div', 'current-harness-model'); currentModelDisplay.id = 'current-harness-model'; currentModelDisplay.hidden = true;
currentModelDisplay.append(el('span', '', '当前 DSH 模型'));
const currentModelName = el('strong'); currentModelName.id = 'current-harness-model-name'; currentModelDisplay.append(currentModelName);
$('feedback-model').closest('label').before(currentModelDisplay);
const refreshModels = el('button', 'button subtle', '刷新模型');
refreshModels.id = 'refresh-models';
refreshModels.type = 'button'; refreshModels.style.marginTop = '6px'; refreshModels.style.padding = '3px 0'; refreshModels.style.fontSize = '10px';
refreshModels.addEventListener('click', () => { announceReady(); loadModels(); }); $('model-status').after(refreshModels);
paperChatUI = window.PaperLibraryChat?.create({ api, toast, getPaper: () => state.active, getContext: () => state.harnessContext,
  getAnnotations: () => state.annotations, getLibrary: () => state.library,
  navigate: switchTab, navigateReference: (paperId, page) => openReferencedPaper({ paperId, page }), changed: publishReaderState,
  savedFeedback: async id => { if (state.active?.id !== id) return; await loadFeedback(id); await loadAnnotations(id); if (state.active.pdf) await requestPage(state.page); },
});
window.addEventListener('pagehide', () => { publishReaderState(); paperChatUI?.dispose(); });
window.addEventListener('message', event => {
  receiveHarnessContext(event);
  const value = event.data;
  if (event.source !== window.parent || event.origin !== window.location.origin || value?.type !== 'paper-library:reference-open' || value.version !== 1 || typeof value.paperId !== 'string' || !value.paperId || value.paperId.length > 160 || !Number.isInteger(value.page) || value.page < 1 || value.page > 2000) return;
  void openReferencedPaper(value).catch(error => toast(error.message, true));
});
initialize();
