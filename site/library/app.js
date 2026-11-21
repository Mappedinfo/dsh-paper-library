import { openBrowserLibrary, kindForPath, MAX_PDF_BYTES, MAX_TEX_BYTES, MAX_ASSET_BYTES } from './storage.js';
import { setupAssistant } from './assistant.js';

const el = id => document.getElementById(id);
const perPage = 50;
const order = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const template = String.raw`% !TEX program = lualatex
\documentclass{article}
\usepackage{fontspec}
\setmainfont{NotoSansSC-Regular.otf}[Path=./]
\begin{document}

\section{引言}

\end{document}
`;
let store, entries = [], kind = 'all', page = 0, editor, busy = false;
let lastList = 0, current = null, expanded = false, sidebar = true;
const fileTypes = { pdf: 'PDF', tex: 'LaTeX', asset: '图片' };
for (const button of document.querySelectorAll('[data-icon]')) window.PaperIcons?.decorate(button, button.dataset.icon);
el('ui-palette').value = document.documentElement.dataset.palette || 'jade';
el('ui-palette').onchange = event => window.PaperLibraryAppearance?.apply(event.target.value);
const folderPicker = typeof window.showDirectoryPicker === 'function';

function say(message = '', error = false) {
  el('notice').hidden = !message;
  el('notice').textContent = message;
  el('notice').classList.toggle('error', error);
}
function locationLabel() {
  return store.mode === 'folder' ? '文件夹 · ' + store.name : '保存在此浏览器';
}
function controls() {
  const ready = Boolean(store) && !busy;
  el('location').disabled = !ready;
  for (const id of ['import', 'new', 'archive', 'latex-open', 'welcome-import']) el(id).disabled = !ready || store.needsPermission;
  for (const id of ['back', 'root-paper', 'root-latex', 'catalog-expand', 'refresh', 'sidebar-toggle', 'migrate', 'open-folder', 'use-browser', 'reconnect', 'recover-browser', 'import-folder']) el(id).disabled = !ready;
}
async function operation(action, status) {
  if (busy) return;
  busy = true;
  controls();
  if (status) status.textContent = '';
  try { await action(); }
  catch (error) {
    const message = error?.message || '操作未完成，请重试。';
    if (status && status.closest('dialog')?.open) status.textContent = message;
    else say(message, true);
  } finally { busy = false; controls(); }
}
const sizeLabel = bytes => bytes >= 1048576 ? (bytes / 1048576).toFixed(1) + ' MiB' : Math.ceil(bytes / 1024) + ' KiB';
function renderList() {
  const word = el('search').value.trim().toLocaleLowerCase();
  const found = entries.filter(item => (kind === 'all' || item.kind === kind) && item.path.toLocaleLowerCase().includes(word));
  page = Math.max(0, Math.min(page, Math.ceil(found.length / perPage) - 1));
  const rows = document.createDocumentFragment(), cards = document.createDocumentFragment();
  const writing = kind === 'tex';
  el('item-count').textContent = found.length;
  el('catalog-heading').textContent = writing ? 'LaTeX 写作' : '文献';
  for (const [id, active] of [['root-paper', !writing], ['root-latex', writing]]) {
    el(id).setAttribute('aria-pressed', String(active));
    if (active) el(id).setAttribute('aria-current', 'page'); else el(id).removeAttribute('aria-current');
  }
  for (const item of found.slice(page * perPage, (page + 1) * perPage)) {
    const tr = document.createElement('tr');
    const link = document.createElement('button');
    const selected = item.path === current?.path;
    const open = () => operation(() => openEntry(item));
    const buttonTitle = item.path.split('/').pop();
    link.className = 'table-title'; link.type = 'button'; link.textContent = item.path;
    link.title = item.path; link.addEventListener('click', open);
    tr.classList.toggle('selected', selected);
    const card = document.createElement('button');
    card.className = 'paper-card'; card.type = 'button'; card.title = item.path;
    card.classList.toggle('selected', selected);
    card.setAttribute('aria-pressed', String(selected));
    const title = document.createElement('h3'), detail = document.createElement('p');
    const footer = document.createElement('div'), chip = document.createElement('span');
    title.textContent = buttonTitle;
    detail.className = 'card-journal';
    detail.textContent = [item.path.slice(0, -buttonTitle.length).replace(/\/$/, ''), sizeLabel(item.size)].filter(Boolean).join(' · ');
    footer.className = 'card-footer'; chip.className = 'pdf-chip'; chip.textContent = fileTypes[item.kind];
    footer.append(chip); card.append(title, detail, footer); card.addEventListener('click', open);
    cards.append(card);
    tr.insertCell().append(link);
    tr.insertCell().textContent = fileTypes[item.kind];
    tr.insertCell().textContent = sizeLabel(item.size);
    rows.append(tr);
  }
  el('files').tBodies[0].replaceChildren(rows);
  el('paper-list').replaceChildren(cards);
  el('welcome-import').textContent = entries.length ? '选择文献，继续阅读 ↗' : '导入第一篇文献 ↗';
  el('welcome-detail').textContent = entries.length ? '从文献库选择一篇论文，标记值得追问的段落，再把文献之间的联系串起来。' : '导入论文，标记值得追问的段落，再把文献之间的联系串起来。';
  el('pager').hidden = !found.length;
  el('prev').hidden = el('next').hidden = found.length <= perPage;
  el('prev').disabled = page === 0;
  el('next').disabled = (page + 1) * perPage >= found.length;
  el('count').textContent = found.length > perPage ? (page + 1) + ' / ' + Math.ceil(found.length / perPage) + ' 页 · ' + found.length + ' 份文件' : found.length + ' 份文件';
  el('empty').hidden = Boolean(found.length) || Boolean(store?.needsPermission);
  el('empty-title').textContent = entries.length ? '没有匹配的文件' : '还没有文献或稿件';
  el('empty-detail').textContent = entries.length ? '试试其他关键词或文件类型。' : '将 PDF 或 LaTeX 文件拖到这里，也可以新建稿件。';
}
async function refresh() {
  const ticket = ++lastList;
  el('location-label').textContent = locationLabel() + ' · 管理文件夹';
  el('location').title = el('location-label').textContent;
  el('reconnect-bar').hidden = !store.needsPermission;
  el('shelf-body').setAttribute('aria-busy', 'true');
  try {
    const next = store.needsPermission ? [] : await store.list();
    if (ticket !== lastList) return;
    entries = next.sort((a, b) => order.compare(a.path, b.path));
    renderList();
  } catch (error) {
    if (ticket === lastList) { entries = []; renderList(); }
    throw error;
  } finally {
    if (ticket === lastList) {
      el('reconnect-bar').hidden = !store.needsPermission;
      el('shelf-body').setAttribute('aria-busy', 'false');
    }
  }
}
function layout() {
  const writing = current?.kind === 'tex', documentOpen = Boolean(current);
  const showSidebar = !documentOpen || (!writing && sidebar);
  el('workspace').classList.toggle('catalog-expanded', expanded);
  el('workspace').classList.toggle('reading-sidebar-hidden', !showSidebar);
  el('workspace').classList.toggle('show-detail', documentOpen);
  el('paper-list').hidden = expanded;
  el('catalog-table').hidden = !expanded;
  el('shelf').hidden = !showSidebar;
  el('welcome').hidden = documentOpen;
  el('document').hidden = !documentOpen;
  el('back').setAttribute('aria-pressed', String(!documentOpen));
  el('sidebar-toggle').hidden = !documentOpen || writing;
  el('sidebar-toggle').setAttribute('aria-checked', String(showSidebar));
  el('catalog-expand').setAttribute('aria-expanded', String(expanded));
  el('catalog-expand').title = expanded ? '收起表格' : '展开表格';
  el('catalog-expand').setAttribute('aria-label', el('catalog-expand').title);
  el('filename').textContent = current?.path || '选择一篇文献';
  el('filename').title = current?.path || '';
}
async function leaveEditor() {
  if (editor?.canLeave && !await editor.canLeave()) return false;
  await editor?.destroy?.();
  el('work-panel').replaceChildren();
  editor = undefined; current = null;
  return true;
}
async function openEntry(entry) {
  if (!entry || entry.path === current?.path || !await leaveEditor()) return;
  current = entry; expanded = false; layout(); renderList();
  const panel = el('work-panel');
  panel.textContent = '正在打开…';
  try {
    if (entry.kind === 'asset') {
      const { blob } = await store.read(entry.path);
      const image = document.createElement('img');
      const url = URL.createObjectURL(blob);
      image.alt = entry.path; image.className = 'asset-preview'; image.src = url;
      panel.replaceChildren(image);
      editor = { destroy: () => URL.revokeObjectURL(url) };
      return;
    }
    const mount = entry.kind === 'pdf' ? (await import('./pdf.js')).mountPdf : (await import('./latex.js')).mountLatex;
    panel.replaceChildren();
    editor = await mount(panel, {
      store, entry, entries, onOpen: path => operation(() => openEntry(entries.find(item => item.path === path))),
      onSaved: () => refresh().catch(error => say(error.message, true)),
    });
  } catch (error) { await leaveEditor(); layout(); renderList(); throw error; }
}
async function browse(expand, type = kind) {
  if (!await leaveEditor()) return false;
  expanded = expand; sidebar = true;
  el('file-kind').value = kind = type;
  page = 0; layout(); say(); await refresh();
  return true;
}
el('back').onclick = () => operation(() => browse(!expanded));
el('home').onclick = event => {
  event.preventDefault(); if (store) void operation(() => browse(false, 'all'));
};
el('catalog-expand').onclick = () => operation(() => browse(!expanded));
el('root-paper').onclick = () => operation(() => browse(true, 'all'));
el('root-latex').onclick = el('latex-open').onclick = () => operation(() => browse(true, 'tex'));
el('sidebar-toggle').onclick = () => { sidebar = !sidebar; layout(); };
el('refresh').onclick = () => operation(refresh);
el('catalog-search-form').onsubmit = event => { event.preventDefault(); renderList(); };
el('search').oninput = () => { page = 0; renderList(); };
el('file-kind').onchange = event => { kind = event.target.value; page = 0; renderList(); };
window.addEventListener('keydown', event => {
  if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'k' || document.querySelector('dialog[open]') || !store || busy) return;
  event.preventDefault();
  if (el('shelf').hidden) void operation(async () => { if (await browse(true)) el('search').focus(); });
  else el('search').focus();
});
el('prev').onclick = () => { page--; renderList(); };
el('next').onclick = () => { page++; renderList(); };

async function importFiles(files, usePaths = false) {
  const known = new Set(entries.map(item => item.path));
  let added = 0, skipped = 0, other = 0, failed = 0, firstPath, firstError;
  for (const file of files) {
    // A directory input prefixes the selected folder's own name. Retain its contents' layout.
    const path = usePaths && file.webkitRelativePath ? file.webkitRelativePath.split('/').slice(1).join('/') : file.name;
    const type = kindForPath(path);
    if (!type || path.split('/').some(part => part.startsWith('.'))) { other++; continue; }
    if (known.has(path)) { skipped++; continue; }
    try {
      if (file.size > { pdf: MAX_PDF_BYTES, tex: MAX_TEX_BYTES, asset: MAX_ASSET_BYTES }[type]) throw new Error('文件大小超过上限。');
      await store.write(path, file, null);
      known.add(path); added++; firstPath ??= path;
    } catch (error) { failed++; firstError ??= path + '：' + error.message; }
  }
  await refresh();
  const parts = ['已导入 ' + added + ' 份文件'];
  if (skipped) parts.push(skipped + ' 份同名文件已跳过');
  if (other) parts.push(other + ' 份非文献或稿件文件已跳过');
  if (failed) parts.push(failed + ' 份未导入（' + firstError + '）');
  say(parts.join('，') + '。', Boolean(failed));
  if (files.length === 1 && added === 1) await openEntry(entries.find(item => item.path === firstPath));
}
el('import').onclick = () => el('file-input').click();
el('welcome-import').onclick = () => {
  if (entries.length) void operation(() => browse(true, 'all'));
  else el('file-input').click();
};
for (const [id, directory] of [['file-input', false], ['directory-input', true]]) el(id).onchange = event => {
  const files = Array.from(event.target.files); event.target.value = '';
  if (files.length) void operation(() => importFiles(files, directory));
};
el('workspace').ondragover = event => { if (!current && event.dataTransfer.types.includes('Files')) { event.preventDefault(); el('shelf').classList.add('dragging'); } };
el('workspace').ondragleave = event => { if (!el('workspace').contains(event.relatedTarget)) el('shelf').classList.remove('dragging'); };
el('workspace').ondrop = event => {
  event.preventDefault(); el('shelf').classList.remove('dragging');
  if (!current && store && !store.needsPermission && event.dataTransfer.files.length) void operation(() => importFiles(Array.from(event.dataTransfer.files)));
};

el('new').onclick = () => {
  el('new-path').value = 'main.tex'; el('new-status').textContent = '';
  el('new-dialog').showModal(); el('new-path').select();
};
el('new-form').onsubmit = event => {
  event.preventDefault();
  void operation(async () => {
    let path = el('new-path').value.trim();
    if (!path) throw new Error('请输入稿件文件名。');
    if (!/\.tex$/i.test(path)) path += '.tex';
    await store.write(path, new Blob([template], { type: 'text/plain;charset=utf-8' }), null);
    el('new-dialog').close(); say();
    await refresh(); await openEntry(entries.find(item => item.path === path));
  }, el('new-status'));
};

function storageDialog() {
  el('where').textContent = store.mode === 'folder' ? '当前位置：' + store.name : '当前位置：此浏览器。清理网站数据会清除浏览器库。';
  el('migrate-row').hidden = !folderPicker || store.mode !== 'browser';
  el('open-folder-row').hidden = !folderPicker;
  el('use-browser-row').hidden = store.mode !== 'folder';
  el('import-folder-row').hidden = folderPicker || store.mode !== 'browser';
  el('storage-status').textContent = '';
  el('storage-dialog').showModal();
}
el('location').onclick = storageDialog;
for (const button of document.querySelectorAll('[data-close]')) button.onclick = () => { if (!busy) button.closest('dialog').close(); };
el('storage-dialog').addEventListener('cancel', event => { if (busy) event.preventDefault(); });
async function switchStorage(change) {
  if (!await leaveEditor()) return;
  layout(); renderList();
  await change();
  if (el('storage-dialog').open) el('storage-dialog').close();
  page = 0; el('search').value = '';
  await refresh(); say('当前存储位置：' + locationLabel() + '。');
}
for (const [id, migrate] of [['open-folder', false], ['migrate', true]]) el(id).onclick = () => operation(async () => {
  let handle;
  try { handle = await window.showDirectoryPicker({ mode: 'readwrite', id: 'paper-library' }); }
  catch (error) { if (error.name === 'AbortError') return; throw error; }
  el('storage-status').textContent = migrate ? '正在复制并核对文件，请保持页面打开…' : '正在打开文件夹…';
  await switchStorage(() => migrate ? store.migrateTo(handle) : store.openFolder(handle));
}, el('storage-status'));
for (const id of ['use-browser', 'recover-browser']) el(id).onclick = () => operation(() => switchStorage(() => store.useBrowser()), el('storage-status'));
el('reconnect').onclick = () => operation(() => switchStorage(() => store.reconnect()));
el('import-folder').onclick = () => { el('storage-dialog').close(); el('directory-input').click(); };
el('archive').onclick = () => operation(async () => {
  el('storage-status').textContent = '正在导出…';
  const { exportArchive } = await import('./archive.js');
  await exportArchive(store);
  el('storage-status').textContent = '已生成知识库 ZIP。';
}, el('storage-status'));
layout(); controls();
setupAssistant();
try {
  store = await openBrowserLibrary(); await refresh();
} catch (error) { say('知识库未能打开：' + error.message + '。请检查此站点的存储权限后刷新页面。', true); }
controls();
window.addEventListener('focus', () => {
  if (store && !busy && !el('shelf').hidden && !document.querySelector('dialog[open]')) refresh().catch(error => say(error.message, true));
});
