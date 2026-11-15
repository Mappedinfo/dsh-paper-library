'use strict';

window.PaperCatalogSearch = {
  create({ api, project, searchMetadata, prepare, navigate, toast }) {
    const get = part => document.getElementById(`catalog-search-${part}`);
    const form = get('form'), input = document.getElementById('search'), scope = get('scope');
    const dialog = get('dialog'), status = get('status'), error = get('error'), results = get('results');
    const stop = get('stop'), more = get('more'), restart = get('restart');
    const limit = 40;
    let search, controller, opening = false;

    function syncMode() {
      const metadata = scope.value === 'metadata';
      input.placeholder = metadata ? '检索文献、数据集与演示…' : '输入 PDF 正文关键词';
      input.setAttribute('aria-label', metadata ? '检索文献、数据集与演示文稿' : 'PDF 正文关键词或短语');
      get('submit').hidden = metadata;
      get('shortcut').hidden = !metadata;
    }

    function update() {
      stop.hidden = !controller;
      more.hidden = Boolean(controller) || search.complete || search.changed;
      more.textContent = search.failed ? '重试' : results.childElementCount >= limit ? '继续找下一批' : '继续搜索';
      restart.hidden = Boolean(controller);
      results.setAttribute('aria-busy', String(Boolean(controller)));
      const progress = search.total === null ? '' : `${search.completed}/${search.total} 篇 PDF 已处理 · ${search.scanned} 页已读取`;
      const state = controller ? '搜索中' : search.failed ? '搜索未完成' : search.complete ? '搜索结束' : '待继续搜索';
      const hits = search.hits ? `累计 ${search.hits} 个命中页` : search.complete ? '未找到匹配页' : '暂未命中';
      status.textContent = [state, hits, progress, search.empty && `${search.empty} 页无可选文字`,
        search.skipped && `${search.skipped} 页未能读取`, search.unreadable && `${search.unreadable} 篇 PDF 不可读`,
        search.missing && `${search.missing} 条无 PDF`].filter(Boolean).join(' · ');
    }

    function cancel() {
      controller?.abort();
      controller = null;
      if (search) update();
    }

    function appendHit(hit) {
      const row = document.createElement('li'), button = document.createElement('button');
      const title = document.createElement('strong'), snippet = document.createElement('span');
      button.type = 'button';
      button.className = 'button catalog-search-hit';
      title.textContent = `${hit.title} · 第 ${hit.page} 页`;
      snippet.textContent = hit.snippet;
      button.append(title, snippet);
      button.addEventListener('click', async () => {
        if (opening) return;
        const active = search;
        opening = true;
        try {
          if (!await prepare() || !dialog.open || search !== active) return;
          cancel();
          dialog.close();
          if (!await navigate(hit)) toast('未能打开命中页，请重新搜索后再试。', true);
        } catch (failure) {
          toast(failure.message, true);
        } finally {
          opening = false;
        }
      });
      row.append(button);
      results.append(row);
    }

    async function run() {
      if (controller || search.complete || search.changed) return;
      const active = search, current = new AbortController();
      controller = current;
      let replace = results.childElementCount >= limit;
      error.hidden = true;
      active.failed = false;
      update();
      try {
        while (true) {
          const data = await api('catalog_text_search', {
            query: active.query, project_id: active.projectId, cursor: active.cursor,
            limit: replace ? limit : limit - results.childElementCount,
          }, { signal: current.signal });
          if (controller !== current || !dialog.open) return;
          if (replace && data.matches.length) {
            results.replaceChildren();
            results.scrollTop = 0;
            replace = false;
          }
          data.matches.forEach(appendHit);
          active.cursor = data.next_cursor;
          active.complete = !active.cursor;
          active.hits += data.matches.length;
          active.scanned += data.scanned_pages;
          active.empty += data.no_text_pages;
          active.skipped += data.skipped_pages;
          active.unreadable += data.unreadable_pdfs;
          active.total = data.pdf_count;
          active.completed = data.pdfs_completed;
          active.missing = data.without_pdf;
          update();
          if (active.complete || (!replace && results.childElementCount >= limit)) break;
        }
      } catch (failure) {
        if (controller !== current || !dialog.open) return;
        active.failed = true;
        active.changed = failure.code === 'CATALOG_SEARCH_CHANGED';
        error.textContent = failure.message;
        error.hidden = false;
      } finally {
        if (controller === current) {
          controller = null;
          update();
        }
      }
    }

    function start(query, currentProject) {
      cancel();
      search = { query, projectId: currentProject?.id ?? null, projectTitle: currentProject?.title,
        cursor: null, complete: false, failed: false, changed: false, total: null,
        scanned: 0, empty: 0, skipped: 0, unreadable: 0, hits: 0 };
      results.replaceChildren();
      get('context').textContent = `${search.projectTitle || '全库在库文献'} · “${search.query}”`;
      void run();
    }

    input.addEventListener('input', () => { if (scope.value === 'metadata') searchMetadata(); });
    scope.addEventListener('change', () => {
      syncMode();
      if (scope.value === 'metadata') searchMetadata();
    });
    form.addEventListener('submit', event => {
      event.preventDefault();
      const query = input.value.trim();
      if (scope.value === 'metadata') return searchMetadata();
      if (!query) return input.focus();
      const currentProject = scope.value === 'project' ? project() : null;
      if (scope.value === 'project' && !currentProject) return;
      dialog.showModal();
      if (search?.query === query && search.projectId === (currentProject?.id ?? null)) update();
      else start(query, currentProject);
    });
    more.addEventListener('click', () => void run());
    stop.addEventListener('click', cancel);
    restart.addEventListener('click', () => start(search.query, search.projectId ? { id: search.projectId, title: search.projectTitle } : null));
    dialog.addEventListener('close', () => { if (!dialog.open) cancel(); });
    syncMode();

    return {
      syncProject() {
        const current = project();
        get('project').disabled = !current;
        if (!current && scope.value === 'project') {
          scope.value = 'library';
          syncMode();
        }
      },
      setMetadataQuery(query) {
        input.value = query;
        scope.value = 'metadata';
        syncMode();
        searchMetadata();
      },
    };
  },
};
