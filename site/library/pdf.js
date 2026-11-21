import * as pdfjs from './pdf-assets/pdf.mjs';
import { markNames, maxPdfBytes, webAuthor, writeNativeMark } from './pdf-annotations.js';

const asset = path => new URL('./pdf-assets/' + path, import.meta.url).href;
pdfjs.GlobalWorkerOptions.workerSrc = asset('pdf.worker.mjs');

export function openBrowserPdf(bytes) {
  return pdfjs.getDocument({ data: bytes, cMapUrl: asset('cmaps/'), cMapPacked: true,
    standardFontDataUrl: asset('standard_fonts/'), wasmUrl: asset('wasm/'), iccUrl: asset('iccs/'),
    disableWorkerRendering: true, useWorkerFetch: true, useSystemFonts: true, enableXfa: false,
    isEvalSupported: false, maxImageSize: 32000000, canvasMaxAreaInBytes: 64000000 });
}

const markup = new Set(['Highlight', 'Underline', 'StrikeOut']);
const MAX_PIXELS = 8_000_000;
function el(tag, text) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  return node;
}
function download(blob, name) {
  const url = URL.createObjectURL(blob), link = el('a');
  link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

export function mountPdf(panel, { store, entry, onSaved }) {
  const root = el('section');
  root.className = 'browser-pdf';
  root.innerHTML = `
    <div class="paper-tools" aria-label="当前文献工具栏">
      <div class="reader-control-group" role="group" aria-label="PDF 导航"><div class="toolbar-reader">
        <div class="page-controls"><button class="icon-button" data-el="prev" aria-label="上一页">←</button>
          <label><input data-el="number" aria-label="页码" type="number" min="1" value="1"><span data-el="count">/ —</span></label>
          <button class="icon-button" data-el="next" aria-label="下一页">→</button></div>
        <label class="bp-zoom">缩放 <select data-el="zoom"><option value="1">适合宽度</option><option value=".75">75%</option><option value="1.25">125%</option><option value="1.75">175%</option></select></label>
      </div></div>
      <div class="reader-control-group" role="group" aria-label="导出"><button class="button subtle" data-el="export">下载批注 PDF</button></div>
      <span class="reader-inline-feedback" role="status" data-el="status"></span>
    </div>
    <div class="annotation-tool-group" data-el="tools" role="group" aria-label="PDF 批注工具" hidden></div>
    <div class="bp-layout">
      <aside id="bp-annotation-rail" class="shared-reading-sidebar bp-notes" data-el="rail" aria-label="本页批注" hidden>
        <div class="reading-sidebar-header"><strong>本页批注</strong><span class="count" data-el="note-count"></span></div>
        <div id="annotation-list" class="annotation-list" data-el="notes"></div>
      </aside>
      <div class="paper-pdf-reader" data-el="scroll" tabindex="0" aria-label="当前 PDF 页">
        <div class="pdr-pages"><div class="pdr-page-slot"><div class="pdr-sheet bp-sheet" data-el="sheet">
          <canvas data-el="canvas" aria-label="PDF 页内容"></canvas><div class="bp-text" data-el="text"></div>
          <div data-el="region" class="pdr-square-draft bp-region" hidden></div>
        </div><div class="pdr-page-caption" data-el="caption"></div></div></div>
      </div>
    </div>
    <dialog data-el="dialog" aria-labelledby="bp-dialog-title"><form data-el="form">
      <div class="dialog-heading"><h2 id="bp-dialog-title" data-el="title"></h2></div>
      <blockquote data-el="quote" hidden></blockquote>
      <label class="field">备注<textarea data-el="comment" rows="4" maxlength="10000"></textarea></label>
      <p class="form-result" data-el="error" role="status"></p><div class="dialog-actions">
      <button class="button subtle" type="button" data-el="cancel">取消</button>
      <button class="button primary" type="submit" data-el="save">保存批注</button></div></form></dialog>`;
  panel.append(root);
  const get = name => root.querySelector('[data-el="' + name + '"]');
  const status = text => { get('status').textContent = text; };
  const sheet = get('sheet'), layer = get('text'), dialog = get('dialog');
  const tools = get('tools');
  const viewTabs = panel.ownerDocument.getElementById('reader-tabs');
  const readerTab = el('button', '阅读'), annotationsTab = el('button', '批注');
  for (const tab of [readerTab, annotationsTab]) {
    tab.type = 'button'; tab.className = 'tab';
    tab.setAttribute('aria-pressed', String(tab === readerTab));
  }
  annotationsTab.setAttribute('aria-controls', 'bp-annotation-rail');
  let tool = '';
  const name = entry.path.split('/').at(-1);
  let task, doc, page, viewport, textTask, paint, source, revision, pending, drag;
  let number = 1, busy = true, saving = false, disposed = false, editable = false;
  let renderedWidth = 0, resizeTimer;
  const availableWidth = () => Math.max(240, get('scroll').clientWidth - 24);
  function resizePage() {
    clearTimeout(resizeTimer);
    if (disposed || busy || saving || dialog.open || !doc || !renderedWidth || availableWidth() === renderedWidth) return;
    resizeTimer = setTimeout(() => {
      if (!disposed && !busy && !saving && !dialog.open && availableWidth() !== renderedWidth) void render();
    }, 120);
  }
  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(resizePage) : null;
  observer?.observe(get('scroll'));
  for (const type of ['', 'Square', 'Highlight', 'Underline', 'StrikeOut', 'Text']) {
    const button = el('button', markNames[type] || '选择');
    button.type = 'button';
    button.className = 'button subtle';
    button.dataset.tool = type;
    button.setAttribute('aria-pressed', String(type === tool));
    button.onclick = () => selectTool(type);
    tools.append(button);
  }
  window.PaperIcons?.decorate(get('export'), 'download');
  function selectTool(type) {
    stopDrag();
    tool = type;
    for (const button of tools.children) button.setAttribute('aria-pressed', String(button.dataset.tool === type));
    sheet.dataset.draw = String(['Text', 'Square'].includes(tool));
    status(hint());
  }
  function showAnnotations(show) {
    readerTab.setAttribute('aria-pressed', String(!show));
    annotationsTab.setAttribute('aria-pressed', String(show));
    get('rail').hidden = tools.hidden = !show;
    if (!show) selectTool('');
    resizePage();
  }
  readerTab.onclick = () => showAnnotations(false);
  annotationsTab.onclick = () => showAnnotations(true);
  function controls() {
    get('prev').disabled = busy || number <= 1;
    get('next').disabled = busy || !doc || number >= doc.numPages;
    get('zoom').disabled = busy || !doc;
    get('number').disabled = busy || !doc;
    get('export').disabled = !source;
    annotationsTab.disabled = readerTab.disabled = busy || !doc;
    for (const button of tools.children) button.disabled = busy || !editable;
  }
  function hint() {
    if (!editable) return '此文件仅供阅读和下载。';
    if (markup.has(tool)) return '拖选本页文字以添加' + markNames[tool] + '。';
    if (tool === 'Square') return '在页面上拖动以标出一个区域。';
    if (tool === 'Text') return '点击页面，放置便笺。';
    return '';
  }
  function showEditor(data, quote = '', note = '') {
    pending = data;
    get('title').textContent = data.annotationId ? '编辑备注' : '添加' + markNames[data.type];
    get('quote').textContent = quote.slice(0, 500); get('quote').hidden = !quote;
    get('error').textContent = ''; get('comment').value = note;
    dialog.showModal(); get('comment').focus();
  }
  function notes(items) {
    const filtered = items.filter(a => a.subtype !== 'Link' && a.subtype !== 'Popup' && a.subtype !== 'Widget');
    const list = get('notes'); list.replaceChildren();
    get('note-count').textContent = String(filtered.length);
    if (!filtered.length) {
      const empty = el('p', '本页暂无批注。'); empty.className = 'muted'; list.append(empty);
    }
    for (const item of filtered.slice(0, 300)) {
      const card = el('article'), meta = el('header'), type = el('span', markNames[item.subtype] || item.subtype);
      card.className = 'annotation-card'; meta.className = 'annotation-meta'; type.className = 'note-type';
      meta.append(el('span', '第 ' + number + ' 页'));
      if (item.titleObj?.str && item.titleObj.str !== webAuthor) meta.append(el('span', item.titleObj.str));
      meta.append(type); card.append(meta);
      if (item.color?.length === 3) card.style.setProperty('--annotation-card-color', 'rgb(' + Array.from(item.color).join(' ') + ')');
      const note = item.contentsObj?.str || '';
      if (note) {
        const content = el('p', note.slice(0, 10000)); content.className = 'annotation-comment'; card.append(content);
      }
      if (editable && item.titleObj?.str === webAuthor) {
        const actions = el('div'), edit = el('button', '编辑备注');
        actions.className = 'annotation-actions'; edit.className = 'button subtle';
        edit.onclick = () => { if (!busy) showEditor({ pageNumber: number, annotationId: item.id }, '', note); };
        actions.append(edit); card.append(actions);
      }
      list.append(card);
    }
    if (filtered.length > 300) list.append(el('p', '仅列出本页前 300 条批注。'));
  }
  async function render(target = number) {
    if (disposed || !doc) return;
    busy = true; controls(); status('正在读取页面…');
    number = Math.max(1, Math.min(doc.numPages, Math.trunc(target) || 1));
    get('number').value = number; get('number').max = doc.numPages; get('count').textContent = '/ ' + doc.numPages;
    get('caption').textContent = '第 ' + number + ' 页';
    get('note-count').textContent = '';
    get('notes').replaceChildren(); layer.replaceChildren(); layer.hidden = true;
    try {
      page?.cleanup(); page = await doc.getPage(number);
      if (disposed) return;
      const base = page.getViewport({ scale: 1 });
      renderedWidth = availableWidth();
      const scale = Math.min(5, renderedWidth / base.width * Number(get('zoom').value), 6000 / Math.max(base.width, base.height));
      viewport = page.getViewport({ scale });
      const ratio = Math.min(devicePixelRatio || 1, 2, Math.sqrt(MAX_PIXELS / (viewport.width * viewport.height)),
        8192 / Math.max(viewport.width, viewport.height));
      const canvas = get('canvas');
      canvas.width = Math.max(1, Math.floor(viewport.width * ratio)); canvas.height = Math.max(1, Math.floor(viewport.height * ratio));
      sheet.style.width = viewport.width + 'px'; sheet.style.height = viewport.height + 'px';
      sheet.style.setProperty('--total-scale-factor', String(scale * page.userUnit));
      paint = page.render({ canvasContext: canvas.getContext('2d'), viewport, transform: [ratio, 0, 0, ratio, 0, 0] });
      await paint.promise;
      if (disposed) return;
      const annotations = await page.getAnnotations({ intent: 'display' });
      if (disposed) return;
      notes(annotations);
      // TextLayer uses the unrotated page box and rotates its contents to match the canvas.
      textTask = new pdfjs.TextLayer({ textContentSource: page.streamTextContent(), container: layer, viewport });
      await textTask.render();
      if (disposed) return;
      layer.hidden = false; status(hint());
    } catch (err) { if (!disposed) status('无法完整显示本页。' + err.message); }
    finally { if (!disposed) { busy = false; controls(); resizePage(); } }
  }
  async function load(blob, at) {
    await task?.destroy();
    if (disposed) return;
    doc = page = null;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (disposed) return;
    task = openBrowserPdf(bytes);
    doc = await task.promise;
    if (disposed) return;
    const perms = await doc.getPermissions();
    editable = !perms || perms.has(pdfjs.PermissionFlag.MODIFY_ANNOTATIONS);
    await render(at);
  }
  function quad(left, top, right, bottom, textAngle = 0) {
    const corners = [[left,top],[right,top],[right,bottom],[left,bottom]];
    const rotation = ((Math.round(textAngle / 90) % 4) + 4) % 4;
    // QuadPoints follow the text baseline, even when a rotated page shows a vertical line.
    return [0,1,3,2].flatMap(i => viewport.convertToPdfPoint(...corners[(i + rotation) % 4]));
  }
  function position(e) {
    const box = sheet.getBoundingClientRect();
    return [Math.min(viewport.width, Math.max(0, (e.clientX - box.left) * viewport.width / box.width)),
      Math.min(viewport.height, Math.max(0, (e.clientY - box.top) * viewport.height / box.height))];
  }
  function selectText() {
    if (busy || disposed || !editable || !markup.has(tool) || dialog.open) return;
    const selection = window.getSelection();
    if (!selection?.rangeCount || selection.isCollapsed || !layer.contains(selection.anchorNode) || !layer.contains(selection.focusNode)) return;
    const selected = selection.getRangeAt(0);
    const box = sheet.getBoundingClientRect(), quads = [];
    // Ranges across spans also report the spans themselves. Use only the selected text node fragments.
    const walker = document.createTreeWalker(selected.commonAncestorContainer, NodeFilter.SHOW_TEXT);
    let node = selected.commonAncestorContainer.nodeType === Node.TEXT_NODE ? selected.commonAncestorContainer : walker.nextNode();
    while (node) {
      if (selected.intersectsNode(node)) {
        const r = document.createRange(); r.selectNodeContents(node);
        if (selected.startContainer === node) r.setStart(node, selected.startOffset);
        if (selected.endContainer === node) r.setEnd(node, selected.endOffset);
        const angle = viewport.rotation + (parseFloat(node.parentElement?.style.getPropertyValue('--rotate')) || 0);
        for (const rect of r.getClientRects()) {
          if (rect.width < .5 || rect.height < .5) continue;
          quads.push(quad((rect.left - box.left) * viewport.width / box.width, (rect.top - box.top) * viewport.height / box.height,
            (rect.right - box.left) * viewport.width / box.width, (rect.bottom - box.top) * viewport.height / box.height, angle));
          if (quads.length > 200) { status('选文超过 200 个片段，请缩小范围。'); return; }
        }
      }
      node = walker.nextNode();
    }
    if (quads.length) showEditor({ pageNumber: number, type: tool, quads }, selection.toString());
  }
  sheet.addEventListener('pointerup', () => setTimeout(selectText, 0));
  layer.addEventListener('keyup', event => { if (event.key === 'Enter') selectText(); });
  function stopDrag() { drag = null; get('region').hidden = true; }
  sheet.addEventListener('pointerdown', event => {
    if (!editable || busy || event.button !== 0 || !['Square','Text'].includes(tool)) return;
    event.preventDefault(); sheet.setPointerCapture(event.pointerId);
    drag = { start: position(event), pointer: event.pointerId };
  });
  sheet.addEventListener('pointermove', event => {
    if (!drag || drag.pointer !== event.pointerId || tool !== 'Square') return;
    const [x,y] = drag.start, [b,c] = position(event), region = get('region'); region.hidden = false;
    Object.assign(region.style, { left: Math.min(x,b) + 'px', top: Math.min(y,c) + 'px',
      width: Math.abs(x-b) + 'px', height: Math.abs(y-c) + 'px' });
  });
  sheet.addEventListener('pointerup', event => {
    if (!drag || drag.pointer !== event.pointerId) return;
    const [x,y] = drag.start, [b,c] = position(event);
    stopDrag();
    let q;
    if (tool === 'Text') {
      const s = Math.min(18 * viewport.scale, viewport.width, viewport.height);
      const left = Math.max(0, Math.min(x, viewport.width - s)), top = Math.max(0, Math.min(y, viewport.height - s));
      q = quad(left, top, left + s, top + s);
    } else if (Math.abs(b-x) >= 3 && Math.abs(c-y) >= 3) q = quad(Math.min(x,b), Math.min(y,c), Math.max(x,b), Math.max(y,c));
    if (q) showEditor({ pageNumber: number, type: tool, quads: [q] });
  });
  sheet.addEventListener('pointercancel', stopDrag);
  get('prev').onclick = () => { if (!busy) void render(number - 1); };
  get('next').onclick = () => { if (!busy) void render(number + 1); };
  get('number').onchange = () => { if (!busy) void render(Number(get('number').value)); };
  get('zoom').onchange = () => { if (!busy) void render(); };
  get('export').onclick = () => { if (source) download(source, name); };
  get('cancel').onclick = () => dialog.close();
  dialog.oncancel = event => { if (saving) event.preventDefault(); };
  dialog.onclose = () => { pending = null; resizePage(); };
  get('form').onsubmit = async event => {
    event.preventDefault();
    if (!pending || saving) return;
    saving = true; get('save').disabled = get('cancel').disabled = true; get('comment').readOnly = true;
    get('error').textContent = '正在保存…';
    try {
      const { blob } = await writeNativeMark(source, { ...pending, note: get('comment').value });
      const saved = await store.write(entry.path, blob, revision);
      source = blob; revision = saved.revision;
      dialog.close(); window.getSelection()?.removeAllRanges();
      await load(source, number);
      if (!disposed) { await onSaved?.(); status('批注已保存。' + hint()); }
    } catch (err) {
      if (!disposed) {
        if (dialog.open) get('error').textContent = err.message;
        else status('批注已保存。重新读取时遇到问题：' + err.message);
      }
    } finally {
      saving = false; get('save').disabled = get('cancel').disabled = false; get('comment').readOnly = false;
    }
  };
  controls(); status('正在打开 PDF…');
  (async () => {
    if (entry.size > maxPdfBytes) throw new Error('浏览器阅读单份 PDF 的上限为 64 MiB。');
    const result = await store.read(entry.path);
    if (disposed) return;
    source = result.blob; revision = result.revision;
    if (source.size > maxPdfBytes) throw new Error('浏览器阅读单份 PDF 的上限为 64 MiB。');
    await load(source, 1);
    if (!disposed) viewTabs.append(readerTab, annotationsTab);
  })().catch(err => { if (!disposed) { busy = false; controls(); status('打开 PDF 失败。' + err.message); } });
  return {
    canLeave() { if (saving) return false; return !pending || confirm('放弃尚未保存的批注？'); },
    destroy() {
      disposed = true; readerTab.remove(); annotationsTab.remove();
      clearTimeout(resizeTimer); observer?.disconnect();
      paint?.cancel(); textTask?.cancel(); task?.destroy()?.catch(() => {}); root.remove(); source = null;
    },
  };
}
