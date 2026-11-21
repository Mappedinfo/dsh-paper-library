import { api } from './client.js';

const base = '/api/pages/pdf/';
const tools = { select: '浏览', highlight: '高亮', underline: '下划线', strikeout: '删除线', square: '矩形框', note: '便笺' };
const typeNames = { ...tools, ink: '手写' };
const json = (route, value) => api(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });

function button(label, click) {
  const node = document.createElement('button');
  node.type = 'button';
  node.textContent = label;
  node.addEventListener('click', click);
  return node;
}

export function mountPdf(panel) {
  panel.innerHTML = `
    <div class="local-pdf-grid">
      <aside class="local-pdf-sidebar">
        <h2>文献库</h2>
        <form data-el="search"><input type="search" aria-label="检索本机题录" placeholder="检索本机题录" maxlength="500"><button>检索</button></form>
        <label class="local-pdf-import">导入 PDF<input data-el="file" type="file" accept=".pdf,application/pdf"></label>
        <p data-el="list-status" role="status"></p>
        <div data-el="papers" class="local-paper-list"></div>
        <div class="local-pdf-pager"><button data-el="back" type="button">上一批</button><button data-el="next" type="button">下一批</button></div>
      </aside>
      <section class="local-pdf-document" aria-label="PDF 阅读">
        <h2 data-el="title">PDF 阅读</h2>
        <div data-el="welcome" class="local-pdf-welcome">从左侧打开一篇文献，或导入本机 PDF。</div>
        <div data-el="workspace" hidden>
          <div class="local-pdf-toolbar">
            <button type="button" data-el="prev-page">上一页</button>
            <label>第 <input data-el="number" type="number" min="1" value="1" aria-label="跳至页码"> 页 <span data-el="count"></span></label>
            <button type="button" data-el="next-page">下一页</button>
            <button type="button" data-el="smaller" aria-label="缩小">−</button><button type="button" data-el="zoom" title="适应宽度">100%</button><button type="button" data-el="larger" aria-label="放大">＋</button>
            <a data-el="download" download>下载带批注 PDF</a>
          </div>
          <div class="local-pdf-toolbar" data-el="tools" role="group" aria-label="批注工具"></div>
          <div data-el="viewport"></div>
        </div>
        <p data-el="reader-status" role="status"></p>
      </section>
      <aside class="local-pdf-sidebar local-pdf-notes" aria-label="本页批注">
        <h2>本页批注</h2><p data-el="note-status"></p>
        <div data-el="notes"></div>
        <div class="local-pdf-pager" data-el="note-nav" hidden><button data-el="prev-notes" type="button">上一批</button><button data-el="next-notes" type="button">下一批</button></div>
      </aside>
    </div>
    <dialog data-el="dialog" aria-labelledby="local-pdf-dialog-title"><form data-el="editor" class="local-pdf-editor">
      <h2 id="local-pdf-dialog-title"></h2><blockquote data-el="quote" hidden></blockquote>
      <label>备注<textarea data-el="comment" rows="5" maxlength="30000"></textarea></label>
      <p data-el="save-status" role="status"></p>
      <div><button type="button" data-el="cancel">取消</button> <button type="submit" data-el="save">保存到 PDF</button></div>
    </form></dialog>`;
  const get = name => panel.querySelector('[data-el="' + name + '"]');
  const status = (name, message) => { get(name).textContent = message; };
  const showFailure = error => status('reader-status', error.message);
  const work = task => Promise.resolve().then(task).catch(showFailure);
  let paper = null, pageNumber = 1, noteOffset = 0, query = '', offset = 0, listVersion = 0, draft = null, saving = false;
  let papers = [], tool = 'select';
  const pageNotes = new Map();

  function notesForPage(focusId) {
    const page = pageNotes.get(pageNumber);
    const notes = page?.notes ?? [];
    if (focusId) {
      const i = notes.findIndex(note => note.id === focusId);
      if (i >= 0) noteOffset = Math.floor(i / 20) * 20;
    }
    noteOffset = Math.min(noteOffset, Math.max(0, Math.floor((notes.length - 1) / 20) * 20));
    const list = get('notes');
    list.replaceChildren();
    for (const note of notes.slice(noteOffset, noteOffset + 20)) {
      const card = document.createElement('article');
      if (note.id === focusId) card.dataset.focused = 'true';
      const generated = note.generated || note.kind === 'ai-feedback' || note.ai_reading_style;
      const label = (generated ? 'AI · ' : '') + (typeNames[note.type] ?? note.type);
      const locate = button(label, () => work(() => reader.revealAnnotation(note.id, { page: note.page })));
      locate.title = '定位到原页';
      card.append(locate);
      for (const value of [note.text, note.comment]) {
        if (!value) continue;
        const p = document.createElement('p');
        p.textContent = value;
        card.append(p);
      }
      if (note.source === 'paper-library' && note.edit_version && !generated && !note.handwriting && !note.kind) {
        card.append(button('编辑备注', () => openDraft({ id: paper.id, page: note.page, annotation_id: note.id, version: note.edit_version }, note.text, note.comment)));
      }
      list.append(card);
      if (card.dataset.focused) card.scrollIntoView({ block: 'nearest' });
    }
    const range = notes.length ? '第 ' + (noteOffset + 1) + '–' + Math.min(noteOffset + 20, notes.length) + ' 条，共 ' + notes.length + ' 条' : '本页没有批注';
    status('note-status', paper ? (page ? range + (page.truncated ? '（达到本页读取上限）' : '') : '正在读取本页…') : '打开文献后查看。');
    get('note-nav').hidden = notes.length <= 20;
    get('prev-notes').disabled = noteOffset === 0;
    get('next-notes').disabled = noteOffset + 20 >= notes.length;
  }

  function openDraft(value, quote, comment = '') {
    if (get('dialog').open) return;
    draft = value;
    status('save-status', '');
    panel.querySelector('#local-pdf-dialog-title').textContent = value.version ? '编辑备注' : '添加' + tools[value.type];
    const excerpt = get('quote');
    excerpt.textContent = quote || '';
    excerpt.hidden = !quote;
    get('comment').value = comment || '';
    get('dialog').showModal();
    get('comment').focus();
  }

  function createDraft(value, type) {
    if (!value || value.id !== paper?.id || type === 'select') return;
    const { id, page, rects, text, segments } = value;
    const selection = segments ? { segments: segments.map(({ page, rects, text }) => ({ page, rects, text })) } : { rects, text };
    openDraft({ id, page, type, annotation_id: crypto.randomUUID(), ...selection }, text);
  }

  const reader = window.PaperPDFReader.create({
    root: get('viewport'), getPaper: () => paper,
    async api(action, args) {
      if (action !== 'page') throw new Error('未知 PDF 阅读操作。');
      const result = await json('page', args);
      if (paper?.id === args.id) {
        pageNotes.set(args.page, { notes: result.annotations, truncated: result.annotations_truncated });
        // 本机分页渲染器仅保留相邻页面。侧栏只缓存其批注，避免整篇常驻。
        for (const key of pageNotes.keys()) if (Math.abs(key - pageNumber) > 3 && key !== args.page) pageNotes.delete(key);
        if (args.page === pageNumber) notesForPage();
      }
      return result;
    },
    onActivePage(page, state) {
      if (state.paperId !== paper?.id) return;
      if (page !== pageNumber) noteOffset = 0;
      pageNumber = page;
      get('number').value = page;
      get('number').max = state.pageCount;
      status('count', '/ ' + state.pageCount);
      get('prev-page').disabled = page === 1;
      get('next-page').disabled = page === state.pageCount;
      notesForPage();
    },
    onSelection(value, intent) { if (value) createDraft(value, intent.intent); },
    onPageNote(value) { createDraft(value, 'note'); },
    onRectangle(value) { createDraft(value, 'square'); },
    onAnnotationActivate(id) { notesForPage(id); },
    onZoomChange(zoom) { status('zoom', Math.round(zoom * 100) + '%'); },
    onStatus(message) { status('reader-status', message); }
  });

  function chooseTool(name) {
    tool = name;
    reader.setTool(tool, ['square', 'underline', 'strikeout'].includes(tool) ? '#26796a' : '#ffdb66');
    for (const b of get('tools').children) b.setAttribute('aria-pressed', String(b.dataset.tool === tool));
  }
  for (const [name, label] of Object.entries(tools)) {
    const b = button(label, () => chooseTool(name));
    b.dataset.tool = name;
    get('tools').append(b);
  }
  chooseTool(tool);
  get('prev-page').onclick = () => work(() => reader.advance(-1));
  get('next-page').onclick = () => work(() => reader.advance(1));
  get('number').onchange = () => work(() => reader.goTo(get('number').value));
  get('smaller').onclick = () => reader.setZoom(reader.getZoom() - 0.25);
  get('larger').onclick = () => reader.setZoom(reader.getZoom() + 0.25);
  get('zoom').onclick = () => reader.fitToWidth();
  get('prev-notes').onclick = () => { noteOffset -= 20; notesForPage(); };
  get('next-notes').onclick = () => { noteOffset += 20; notesForPage(); };

  function renderPapers() {
    const list = get('papers');
    list.replaceChildren();
    for (const item of papers) {
      const entry = button(item.title || item.citekey, () => work(() => openPaper(item)));
      entry.disabled = !item.pdf;
      entry.title = item.pdf ? item.title || item.citekey : '这条题录没有 PDF 附件';
      entry.setAttribute('aria-current', item.id === paper?.id ? 'true' : 'false');
      if (!item.pdf) entry.append(document.createTextNode('（无 PDF）'));
      list.append(entry);
    }
  }

  async function openPaper(item) {
    paper = item;
    pageNotes.clear();
    pageNumber = 1;
    noteOffset = 0;
    notesForPage();
    renderPapers();
    status('title', item.title || item.citekey);
    get('download').href = base + 'download?id=' + encodeURIComponent(item.id);
    get('welcome').hidden = true;
    get('workspace').hidden = false;
    await reader.open(item);
  }

  async function loadList(pageOffset = 0) {
    const version = ++listVersion;
    status('list-status', '正在检索…');
    try {
      const data = await json('list', { query, offset: pageOffset });
      if (version !== listVersion) return;
      papers = data.items;
      offset = data.offset;
      renderPapers();
      get('back').disabled = offset === 0;
      get('next').disabled = offset + data.limit >= data.total;
      status('list-status', data.total ? '第 ' + (offset + 1) + '–' + (offset + papers.length) + ' 条，共 ' + data.total + ' 条' : query ? '没有匹配的题录。' : '库中还没有文献。');
    } catch (error) { if (version === listVersion) status('list-status', error.message); }
  }

  get('search').onsubmit = event => { event.preventDefault(); query = get('search').querySelector('input').value.trim(); void loadList(); };
  get('back').onclick = () => loadList(Math.max(0, offset - 20));
  get('next').onclick = () => loadList(offset + 20);
  get('back').disabled = get('next').disabled = true;
  get('file').onchange = async event => {
    const input = event.target, file = input.files[0];
    if (!file) return;
    input.disabled = true;
    try {
      if (!file.size || file.size > 64 * 1024 * 1024) throw new Error('请选择一份 64 MiB 以内的非空 PDF。');
      status('list-status', '正在导入本机知识库…');
      const data = await api(base + 'import?filename=' + encodeURIComponent(file.name), { method: 'POST', headers: { 'Content-Type': 'application/pdf' }, body: file });
      query = '';
      get('search').reset();
      await loadList();
      if (data.items[0]) await openPaper(data.items[0]);
      status('list-status', [data.duplicates ? '已打开库中已有的 PDF。' : '已导入本机知识库。', ...(data.warnings || [])].join(' '));
    } catch (error) { status('list-status', error.message); }
    finally { input.disabled = false; input.value = ''; }
  };
  const dialog = get('dialog');
  get('cancel').onclick = () => dialog.close();
  dialog.addEventListener('cancel', event => { if (saving) event.preventDefault(); });
  get('editor').onsubmit = async event => {
    event.preventDefault();
    if (saving || !draft) return;
    const current = draft;
    saving = true;
    get('save').disabled = get('cancel').disabled = true;
    get('comment').readOnly = true;
    try {
      status('save-status', '正在保存…');
      await json(current.version ? 'comment' : 'annotate', { ...current, comment: get('comment').value });
      dialog.close();
      draft = null;
      const pages = current.segments?.map(part => part.page) || [current.page];
      if (paper?.id === current.id) await Promise.all(pages.map(page => reader.refresh(page)));
      status('reader-status', '批注已保存到本机 PDF。');
    } catch (error) { status(dialog.open ? 'save-status' : 'reader-status', error.message); }
    finally {
      saving = false;
      get('save').disabled = get('cancel').disabled = false;
      get('comment').readOnly = false;
    }
  };
  notesForPage();
  return loadList();
}
