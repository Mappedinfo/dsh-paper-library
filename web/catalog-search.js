'use strict';

window.PaperCatalogSearch = {
  create({ api, project, searchMetadata, prepare, navigate, toast }) {
    const get = part => document.getElementById(`catalog-search-${part}`);
    const form = get('form'), input = document.getElementById('search'), scope = get('scope');
    const dialog = get('dialog'), status = get('status'), error = get('error'), results = get('results');
    const stop = get('stop'), more = get('more'), restart = get('restart'), build = get('prepare');
    let active, controller, task, opening = false;

    function syncMode() {
      const metadata = scope.value === 'metadata';
      input.placeholder = metadata ? '检索文献、数据集与演示…' : '输入 PDF 正文关键词';
      input.setAttribute('aria-label', metadata ? '检索文献、数据集与演示文稿' : 'PDF 正文关键词或短语');
      get('submit').hidden = metadata;
      get('submit').textContent = input.value.trim() ? '搜索' : '准备索引';
      get('shortcut').hidden = !metadata;
    }

    function update() {
      const { query, coverage, cursor, first, shown, failed } = active;
      stop.hidden = task !== 'index';
      more.hidden = Boolean(task) || !cursor;
      restart.hidden = Boolean(task) || !query;
      build.hidden = Boolean(task) || (coverage ? coverage.pdfs_pending === 0 : Boolean(query));
      results.hidden = !results.childElementCount;
      results.setAttribute('aria-busy', String(task === 'search'));
      const pending = coverage?.pdfs_pending;
      const range = first === shown ? String(shown) : `${first}–${shown}`;
      const phase = task === 'index' ? '正在准备索引' : task === 'search' ? '正在搜索索引' :
        failed ? '操作未完成' : query ? (shown ? `命中页 ${range}${cursor ? '，还有结果' : ''}` :
          pending ? '已准备的内容暂未命中' : '未找到匹配页') : pending ? '索引准备已暂停' : '索引已就绪';
      const counts = coverage ? [
        `${coverage.pdfs_completed}/${coverage.pdf_count} 篇 PDF 已处理`,
        pending && `${pending} 篇待索引`, `${coverage.indexed_pages} 页可搜索`,
        coverage.no_text_pages && `${coverage.no_text_pages} 页无可选文字`,
        coverage.skipped_pages && `${coverage.skipped_pages} 页未能读取`,
        coverage.unreadable_pdfs && `${coverage.unreadable_pdfs} 篇 PDF 不可读`,
        coverage.without_pdf && `${coverage.without_pdf} 条无 PDF`,
      ] : [];
      status.textContent = [phase, ...counts].filter(Boolean).join(' · ');
    }

    function cancel() {
      controller?.abort();
      controller = null;
      task = null;
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
        const search = active;
        opening = true;
        try {
          if (!await prepare() || !dialog.open || active !== search) return;
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

    async function run(nextTask, nextPage = false) {
      if (controller) return;
      const current = new AbortController();
      controller = current;
      task = nextTask;
      active.failed = false;
      error.hidden = true;
      update();
      let refresh = false;
      const currentRun = () => controller === current && dialog.open;
      const params = { project_id: active.projectId };
      try {
        if (nextTask === 'index') {
          do {
            const data = await api('catalog_search_prepare', params, { signal: current.signal });
            if (!currentRun()) return;
            active.coverage = data;
            active.cursor = null;
            update();
          } while (active.coverage.pdfs_pending);
          refresh = Boolean(active.query);
        } else {
          const data = await api('catalog_text_search', {
            ...params, query: active.query, cursor: nextPage ? active.cursor : null,
          }, { signal: current.signal });
          if (!currentRun()) return;
          const offset = nextPage ? active.shown : 0;
          active.first = offset + 1;
          active.shown = offset + data.matches.length;
          active.coverage = data;
          active.cursor = data.next_cursor;
          results.replaceChildren();
          results.scrollTop = 0;
          data.matches.forEach(appendHit);
        }
      } catch (failure) {
        if (!currentRun()) return;
        active.failed = true;
        if (failure.code === 'CATALOG_SEARCH_CHANGED') active.cursor = null;
        error.textContent = failure.message;
        error.hidden = false;
      } finally {
        if (controller === current) {
          cancel();
          update();
          if (refresh) void run('search');
        }
      }
    }

    input.addEventListener('input', () => {
      syncMode();
      if (scope.value === 'metadata') searchMetadata();
    });
    scope.addEventListener('change', () => {
      syncMode();
      if (scope.value === 'metadata') searchMetadata();
    });
    form.addEventListener('submit', event => {
      event.preventDefault();
      if (scope.value === 'metadata') return searchMetadata();
      const currentProject = scope.value === 'project' ? project() : null;
      if (scope.value === 'project' && !currentProject) return;
      const query = input.value.trim();
      cancel();
      active = { query, projectId: currentProject?.id ?? null, first: 0, shown: 0 };
      results.replaceChildren();
      get('context').textContent = [currentProject?.title || '全库在库文献', query && `“${query}”`].filter(Boolean).join(' · ');
      dialog.showModal();
      void run(query ? 'search' : 'index');
    });
    more.addEventListener('click', () => void run('search', true));
    stop.addEventListener('click', () => {
      cancel();
      if (active.query) void run('search');
      else update();
    });
    restart.addEventListener('click', () => void run('search'));
    build.addEventListener('click', () => void run('index'));
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
