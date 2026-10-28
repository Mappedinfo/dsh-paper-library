'use strict';
/** One version list projected into the writing workspace and reading projects. */
window.PaperLatexVersions = (() => {
  function create({ root, api, scope, openVersion }) {
    const make = (tag, cls, text) => { const node = document.createElement(tag); if (cls) node.className = cls; if (text !== undefined) node.textContent = text; return node; };
    let ticket = 0, offset = 0, total = 0, items = [];
    const refreshButton = make('button', 'button subtle', '刷新版本'); refreshButton.type = 'button';
    const message = make('p', 'latex-version-message'); message.setAttribute('role', 'status');
    const list = make('div', 'latex-version-list');
    const more = make('button', 'button subtle', '更多版本'); more.type = 'button'; more.hidden = true;
    root.append(refreshButton, message, list, more);
    function say(text) { message.textContent = text; }
    async function details(version, card, button) {
      if (card.querySelector('.latex-version-detail')) return;
      button.disabled = true;
      try {
        const result = await api('latex_version_get', { version_id: version.id });
        const panel = make('div', 'latex-version-detail');
        for (const review of result.review_pdfs || result.version?.review_pdfs || []) {
          const preview = make('button', 'button subtle', `批注 PDF · ${(review.pdf_version || '').slice(0, 10)}${review.current ? ' · 本次编译' : ' · 原编译锚点'}`); preview.type = 'button';
          preview.addEventListener('click', () => void openVersion(version, review.pdf_version));
          const download = make('a', 'button subtle', '下载此批注 PDF'); download.href = `./latex-version-pdf/${encodeURIComponent(version.id)}?review=${encodeURIComponent(review.pdf_version)}`; download.download = 'annotated-version.pdf';
          panel.append(preview, download);
        }
        const reviews = await api('latex_version_review', { version_id: version.id });
        if (reviews.annotations?.length) {
          const notes = make('details', 'latex-version-notes'); notes.append(make('summary', '', `自审批注（${reviews.annotations.length}）`));
          for (const note of reviews.annotations) {
            const row = make('details'); row.append(make('summary', '', `${note.anchor?.kind === 'source' ? `${note.anchor.path}:${note.anchor.line}` : `PDF 第 ${note.page || note.anchor?.page} 页`} · ${note.type}${note.stale ? ' · 原锚点' : ''}`));
            row.append(make('blockquote', '', note.text || ''), make('p', '', note.comment || '仅标记，无附加评论')); notes.append(row);
          }
          panel.append(notes);
        }
        if (result.sources?.length) {
          const select = make('select'); select.setAttribute('aria-label', '选择快照源文件'); select.append(new Option('查看源文件快照…', ''));
          for (const source of result.sources) select.append(new Option(source.path, source.path));
          const sourceText = make('pre', 'latex-version-source'); sourceText.hidden = true; let read = 0;
          select.addEventListener('change', async () => {
            const request = ++read; if (!select.value) { sourceText.hidden = true; return; }
            sourceText.hidden = false; sourceText.textContent = '读取快照…';
            try { const value = await api('latex_version_read', { version_id: version.id, path: select.value }); if (request === read) sourceText.textContent = value.content; }
            catch (error) { if (request === read) sourceText.textContent = `读取失败：${error.message}`; }
          }); panel.append(select, sourceText);
        }
        panel.append(make('p', 'small muted', '快照只读；旧批注保留原编译位置，不会自动迁移到新稿。')); card.append(panel);
      } catch (error) { say(`版本读取失败：${error.message}`); }
      finally { button.disabled = false; }
    }
    function render() {
      list.textContent = '';
      for (const version of items) {
        const card = make('article', 'latex-version-card'); card.dataset.versionId = version.id;
        const date = new Date(version.created); const stamp = Number.isNaN(date.getTime()) ? version.created : date.toLocaleString();
        card.append(make('strong', '', `${version.project_title || version.main_path} · ${stamp}`));
        card.append(make('p', 'small muted', `${version.main_path} · ${version.engine} · ${version.source_count} 个源文件 · ${version.review_count} 条批注${version.stale_review_count ? `（${version.stale_review_count} 条保留原锚点）` : ''}`));
        const actions = make('div', 'latex-version-actions');
        const preview = make('button', 'button subtle', '预览 PDF'); preview.type = 'button'; preview.addEventListener('click', () => void openVersion(version));
        const show = make('button', 'button subtle', '批注与源码'); show.type = 'button'; show.addEventListener('click', () => void details(version, card, show));
        const download = make('a', 'button subtle', '下载 PDF'); download.href = `./latex-version-pdf/${encodeURIComponent(version.id)}`; download.download = 'manuscript-version.pdf';
        actions.append(preview, show, download); card.append(actions); list.append(card);
      }
      more.hidden = items.length >= total; say(total ? `共 ${total} 个手动编译版本` : '暂无版本；成功手动编译后会自动保存。');
    }
    async function refresh(append = false) {
      const query = scope(); const current = ++ticket;
      if (!query) { items = []; total = 0; list.textContent = ''; more.hidden = true; say('选择一个阅读项目，查看其写作版本。'); return; }
      refreshButton.disabled = true; say('读取版本…');
      try {
        const result = await api('latex_version_list', { ...query, limit: 20, offset: append ? offset : 0 });
        if (current !== ticket) return;
        const next = result.versions || [];
        const unchanged = !append && items.length === next.length && items.every((item, index) => item.id === next[index].id);
        items = append ? [...items, ...next] : next; total = result.total || 0; offset = items.length;
        if (unchanged) say(total ? `共 ${total} 个手动编译版本` : '暂无版本；成功手动编译后会自动保存。'); else render();
      } catch (error) { if (current === ticket) say(`版本读取失败：${error.message}。可点刷新重试。`); }
      finally { if (current === ticket) refreshButton.disabled = false; }
    }
    refreshButton.addEventListener('click', () => void refresh()); more.addEventListener('click', () => void refresh(true));
    return { refresh, clear: () => { ++ticket; items = []; list.textContent = ''; } };
  }
  return { create };
})();
