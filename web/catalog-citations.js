'use strict';

window.PaperCatalogCitations = {
  create({ root, api, toast, sortScope = () => null, onResort }) {
    const targets = new Map(), latest = new Map();
    let heading, refreshButton, visible = false, running = false, previousSortedScope;
    const observer = typeof IntersectionObserver === 'function' ? new IntersectionObserver(entries => {
      const entry = entries.find(value => value.target === heading);
      if (!entry) return;
      visible = entry.isIntersecting;
      if (visible) void load(false);
    }, { root }) : null;

    function element(tag, text, className) {
      const node = document.createElement(tag);
      node.textContent = text;
      if (className) node.className = className;
      return node;
    }

    function paint(node, doi, saved) {
      const result = sortScope() ? null : latest.get(doi);
      const found = result?.status === 'found' && (!saved?.fetched_at || result.fetched_at >= saved.fetched_at);
      const value = found ? result : saved?.status === 'found' ? saved : result || saved;
      node.replaceChildren();
      node.removeAttribute('title');
      if (value?.status !== 'found') {
        node.textContent = '—';
        node.title = value?.status === 'not_found' ? '公开引文库暂无可核对的引用量' :
          !doi ? '缺少公开 DOI 或 arXiv 标识' : value?.status === 'unavailable' ? '暂时无法查询，可重试' : '待查询';
        return;
      }
      const safeLink = /^https:\/\/(?:openalex\.org\/W\d+$|api\.openalex\.org\/works\/|api\.crossref\.org\/works\/)/.test(value.url || '');
      const count = element(safeLink ? 'a' : 'span', value.count.toLocaleString());
      if (safeLink) { count.href = value.url; count.target = '_blank'; count.rel = 'noopener noreferrer'; }
      node.append(count, element('small', value.source, 'catalog-citation-source'));
      const date = value.fetched_at?.slice(0, 10);
      node.title = [value.source, date ? `采集于 ${date}` : '采集时间未记录'].join(' · ');
    }

    function buttonState() {
      if (refreshButton) {
        refreshButton.disabled = running || !targets.size;
        refreshButton.textContent = running ? '…' : '↻';
      }
    }

    async function load(manual) {
      if (running) return;
      const dois = [...targets].filter(([doi, group]) => manual || group.pending && !latest.has(doi)).map(([doi]) => doi);
      if (!dois.length) return;
      const sorted = sortScope();
      // Reordering can pull a different set of unknown rows onto this page.
      // Start one automatic pass per sorted page, then wait for navigation or a click.
      if (!manual && sorted && sorted === previousSortedScope) return;
      previousSortedScope = sorted;
      const view = [...targets.keys()].join('\n');
      running = true;
      buttonState();
      let failures = 0;
      let changed = false;
      try {
        for (let start = 0; start < dois.length && view === [...targets.keys()].join('\n'); start += 8) {
          const batch = dois.slice(start, start + 8);
          const result = await api('catalog_citation_counts', { dois: batch });
          for (const item of result.items) {
            failures += item.status === 'unavailable';
            latest.delete(item.doi);
            latest.set(item.doi, item);
            const cells = targets.get(item.doi)?.cells || [];
            if (item.status === 'found' && (!cells.length || cells.some(({ saved }) =>
              saved?.count !== item.count || saved.source !== item.source || saved.fetched_at !== item.fetched_at))) changed = true;
            for (const { node, saved } of cells) paint(node, item.doi, saved);
          }
          while (latest.size > 1000) latest.delete(latest.keys().next().value);
        }
        if (manual && failures) toast(`${failures} 条引用量查询暂未完成，可重试。`, true);
      } catch (error) {
        if (manual || view === [...targets.keys()].join('\n')) toast(`引用量查询未完成：${error.message}`, true);
      } finally {
        running = false;
        buttonState();
        if (changed && sortScope()) void onResort?.();
        else if (visible && view !== [...targets.keys()].join('\n')) void load(false);
      }
    }

    return {
      reset() {
        observer?.disconnect();
        heading = refreshButton = null;
        targets.clear();
        visible = false;
      },
      mountHeader(cell) {
        heading = cell;
        refreshButton = element('button', '↻', 'button subtle catalog-citation-refresh');
        refreshButton.type = 'button';
        refreshButton.setAttribute('aria-label', '查询本页引用量');
        refreshButton.title = '查询本页引用量';
        refreshButton.addEventListener('click', () => void load(true));
        cell.append(refreshButton);
      },
      cell(item) {
        const node = element('div', '', 'catalog-citation-value');
        const doi = item.citation_lookup_doi, saved = item.citation_snapshot;
        if (doi && !item.archived) {
          if (!targets.has(doi)) targets.set(doi, { pending: item.citation_needs_lookup, cells: [] });
          targets.get(doi).cells.push({ node, saved });
        }
        paint(node, doi, saved);
        return node;
      },
      connect() {
        buttonState();
        if (heading) observer?.observe(heading);
      },
    };
  },
};
