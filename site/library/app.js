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
let lastList = 0;
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
  for (const id of ['import', 'new', 'archive']) el(id).disabled = !ready || store.needsPermission;
  for (const id of ['back', 'migrate', 'open-folder', 'use-browser', 'reconnect', 'recover-browser', 'import-folder']) el(id).disabled = !ready;
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
  const rows = document.createDocumentFragment();
  for (const item of found.slice(page * perPage, (page + 1) * perPage)) {
    const tr = document.createElement('tr');
    const link = document.createElement('button');
    link.className = 'file-link'; link.type = 'button'; link.textContent = item.path;
    link.addEventListener('click', () => operation(() => openEntry(item)));
    tr.insertCell().append(link);
    tr.insertCell().textContent = { pdf: 'PDF', tex: 'LaTeX', asset: '图片' }[item.kind];
    tr.insertCell().textContent = sizeLabel(item.size);
    rows.append(tr);
  }
  el('files').tBodies[0].replaceChildren(rows);
  el('files').hidden = !found.length;
  el('pager').hidden = !found.length;
  el('prev').hidden = el('next').hidden = found.length <= perPage;
  el('prev').disabled = page === 0;
  el('next').disabled = (page + 1) * perPage >= found.length;
  el('count').textContent = found.length > perPage ? (page + 1) + ' / ' + Math.ceil(found.length / perPage) + ' 页 · ' + found.length + ' 份文件' : found.length + ' 份文件';
  el('empty').hidden = Boolean(found.length) || Boolean(store?.needsPermission);
  el('empty-title').textContent = entries.length ? '没有匹配的文件' : '从第一份文献或稿件开始';
  el('empty-detail').textContent = entries.length ? '试试其他关键词或文件类型。' : '将 PDF 或 LaTeX 文件拖到这里，也可以新建稿件。';
}
async function refresh() {
  const ticket = ++lastList;
  el('location').textContent = locationLabel() + ' · 管理文件夹';
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
async function openEntry(entry) {
  if (!entry) return;
  el('shelf').hidden = true;
  el('document').hidden = false;
  el('filename').textContent = entry.path;
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
    editor = await mount(panel, { store, entry, onSaved: () => refresh().catch(error => say(error.message, true)) });
  } catch (error) { panel.textContent = ''; throw error; }
}
async function back() {
  if (editor?.canLeave && !await editor.canLeave()) return;
  await editor?.destroy?.();
  editor = undefined;
  el('work-panel').replaceChildren();
  el('document').hidden = true; el('shelf').hidden = false;
  say(); await refresh();
}
el('back').onclick = () => operation(back);
for (const a of document.querySelectorAll('.masthead a[href="./"]')) a.onclick = event => {
  event.preventDefault(); if (!el('document').hidden) void operation(back);
};
el('search').oninput = () => { page = 0; renderList(); };
for (const button of document.querySelectorAll('[data-kind]')) button.onclick = () => {
  kind = button.dataset.kind; page = 0;
  for (const b of document.querySelectorAll('[data-kind]')) b.setAttribute('aria-pressed', String(b === button));
  renderList();
};
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
for (const [id, directory] of [['file-input', false], ['directory-input', true]]) el(id).onchange = event => {
  const files = Array.from(event.target.files); event.target.value = '';
  if (files.length) void operation(() => importFiles(files, directory));
};
el('shelf').ondragover = event => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); el('shelf').classList.add('dragging'); } };
el('shelf').ondragleave = event => { if (!el('shelf').contains(event.relatedTarget)) el('shelf').classList.remove('dragging'); };
el('shelf').ondrop = event => {
  event.preventDefault(); el('shelf').classList.remove('dragging');
  if (store && !store.needsPermission && event.dataTransfer.files.length) void operation(() => importFiles(Array.from(event.dataTransfer.files)));
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
setupAssistant();
try {
  store = await openBrowserLibrary(); await refresh();
} catch (error) { say('知识库未能打开：' + error.message + '。请检查此站点的存储权限后刷新页面。', true); }
controls();
window.addEventListener('focus', () => {
  if (store && !busy && !el('shelf').hidden && !document.querySelector('dialog[open]')) refresh().catch(error => say(error.message, true));
});
