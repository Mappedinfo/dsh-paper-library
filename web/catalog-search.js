'use strict';

window.PaperCatalogSearch = {
  create({ api, project, searchMetadata, prepare, navigate, toast }) {
    const get = part => document.getElementById(`catalog-search-${part}`);
    const form = get('form'), input = document.getElementById('search'), scope = get('scope');
    const view = get('view'), catalog = view.parentElement;
    const status = get('status'), error = get('error'), results = get('results');
    const stop = get('stop'), previous = get('previous'), more = get('more'), restart = get('restart'), build = get('prepare');
    const actions = [stop, build, restart, previous, more];
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
      const { query, coverage, page, cursors, first, shown, paperCount, failed } = active;
      stop.hidden = task !== 'index';
      more.hidden = !cursors[page + 1];
      previous.hidden = page === 0 || failed === 'CATALOG_SEARCH_CHANGED';
      more.disabled = previous.disabled = Boolean(task);
      restart.hidden = Boolean(task) || !query || !failed;
      build.hidden = Boolean(task) || (coverage ? coverage.pdfs_pending === 0 : Boolean(query));
      get('actions').hidden = actions.every(button => button.hidden);
      results.setAttribute('aria-busy', String(task === 'search'));
      const pending = coverage?.pdfs_pending;
      const range = first === shown ? String(shown) : `${first}–${shown}`;
      const phase = task === 'index' ? '正在准备索引' : task === 'search' ? '正在搜索索引' :
        failed ? '操作未完成' : query ? (shown ? `命中页 ${range}（本页 ${paperCount} 篇文献）` :
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

    function returnToCatalog(focus = false) {
      cancel();
      active = null;
      results.replaceChildren();
      view.hidden = true;
      catalog.removeAttribute('data-catalog-text-results');
      if (focus) input.focus();
    }

    function openHit(button, hit) {
      button.type = 'button';
      button.addEventListener('click', async () => {
        if (opening) return;
        const search = active;
        opening = true;
        try {
          if (!await prepare() || active !== search || !button.isConnected) return;
          if (!await navigate(hit)) toast('未能打开命中页，请重新搜索后再试。', true);
        } catch (failure) {
          toast(failure.message, true);
        } finally {
          opening = false;
        }
      });
    }

    function appendSnippet(node, hit) {
      const { snippet, match_start: start, match_end: end } = hit;
      const characters = Array.from(snippet);
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > characters.length) {
        node.textContent = snippet;
        return;
      }
      const mark = document.createElement('mark');
      mark.textContent = characters.slice(start, end).join('');
      node.append(characters.slice(0, start).join(''), mark, characters.slice(end).join(''));
    }

    function renderHits(hits) {
      const papers = new Map();
      for (const hit of hits) {
        let pages = papers.get(hit.paper_id);
        if (!pages) {
          const row = document.createElement('li'), heading = document.createElement('h3'), title = document.createElement('button');
          title.className = 'table-title catalog-search-paper';
          title.textContent = hit.title;
          openHit(title, hit);
          heading.append(title);
          pages = document.createElement('ul');
          pages.className = 'catalog-search-pages';
          row.append(heading, pages);
          results.append(row);
          papers.set(hit.paper_id, pages);
        }
        const row = document.createElement('li'), button = document.createElement('button');
        const page = document.createElement('span'), snippet = document.createElement('span');
        button.className = 'catalog-search-hit';
        page.className = 'catalog-search-page';
        page.textContent = `第 ${hit.page} 页`;
        appendSnippet(snippet, hit);
        button.append(page, snippet);
        openHit(button, hit);
        row.append(button);
        pages.append(row);
      }
      return papers.size;
    }

    async function run(nextTask, page = 0) {
      if (controller || !active) return;
      const current = new AbortController();
      controller = current;
      task = nextTask;
      active.failed = false;
      error.hidden = true;
      update();
      let refresh = false;
      const currentRun = () => controller === current;
      const params = { project_id: active.projectId };
      try {
        if (nextTask === 'index') {
          do {
            const data = await api('catalog_search_prepare', params, { signal: current.signal });
            if (!currentRun()) return;
            active.coverage = data;
            active.page = 0;
            active.cursors = [null];
            update();
          } while (active.coverage.pdfs_pending);
          refresh = Boolean(active.query);
        } else {
          const cursor = active.cursors[page];
          const data = await api('catalog_text_search', {
            ...params, query: active.query, cursor,
          }, { signal: current.signal });
          if (!currentRun()) return;
          const offset = cursor?.offset ?? 0;
          active.page = page;
          active.first = offset + 1;
          active.shown = offset + data.matches.length;
          active.coverage = data;
          active.cursors.length = page + 1;
          active.cursors.push(data.next_cursor);
          results.replaceChildren();
          results.scrollTop = 0;
          active.paperCount = renderHits(data.matches);
        }
      } catch (failure) {
        if (!currentRun()) return;
        active.failed = failure.code || true;
        if (failure.code === 'CATALOG_SEARCH_CHANGED') active.cursors = [null];
        error.textContent = failure.message;
        error.hidden = false;
      } finally {
        if (currentRun()) {
          cancel();
          update();
          if (refresh) void run('search');
        }
      }
    }

    input.addEventListener('input', () => {
      syncMode();
      if (scope.value === 'metadata') searchMetadata();
      else if (active && !input.value.trim()) returnToCatalog();
    });
    scope.addEventListener('change', () => {
      returnToCatalog();
      syncMode();
      if (scope.value === 'metadata') searchMetadata();
    });
    function startSearch(query, currentProject = null) {
      cancel();
      active = { query, projectId: currentProject?.id ?? null, page: 0, cursors: [null], first: 0, shown: 0 };
      results.replaceChildren();
      get('context').textContent = [currentProject?.title || '全库在库文献', query && `“${query}”`].filter(Boolean).join(' · ');
      catalog.setAttribute('data-catalog-text-results', '');
      view.hidden = false;
      void run(query ? 'search' : 'index');
    }
    form.addEventListener('submit', event => {
      event.preventDefault();
      if (scope.value === 'metadata') return searchMetadata();
      const currentProject = scope.value === 'project' ? project() : null;
      if (scope.value === 'project' && !currentProject) return;
      startSearch(input.value.trim(), currentProject);
    });
    get('clear').addEventListener('click', () => returnToCatalog(true));
    previous.addEventListener('click', () => void run('search', active.page - 1));
    more.addEventListener('click', () => void run('search', active.page + 1));
    stop.addEventListener('click', () => {
      cancel();
      if (active.query) void run('search');
      else update();
    });
    restart.addEventListener('click', () => void run('search'));
    build.addEventListener('click', () => void run('index'));
    syncMode();

    return {
      searchLibrary(phrase) {
        const query = phrase.trim();
        if (!query) return false;
        input.value = query;
        scope.value = 'library';
        syncMode();
        startSearch(query);
        input.focus();
        return true;
      },
      syncProject() {
        const current = project();
        get('project').disabled = !current;
        if (active?.projectId && active.projectId !== current?.id) returnToCatalog();
        if (!current && scope.value === 'project') {
          scope.value = 'library';
          syncMode();
        }
      },
      setMetadataQuery(query) {
        returnToCatalog();
        input.value = query;
        scope.value = 'metadata';
        syncMode();
        searchMetadata();
      },
    };
  },
};
