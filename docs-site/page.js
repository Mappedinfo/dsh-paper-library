/* Reader-side behaviour for the docs pages: search over the published index, a table of
 * contents that follows the scroll, and heading permalinks that copy a deep link.
 *
 * The search index is a static JSON file, so this page has no server and no third-party
 * request: everything the reader searches was built from this repository's own markdown. */
(() => {
  const body = document.body;
  const assets = body.dataset.assets || '_assets';
  const input = document.getElementById('q');
  const box = document.getElementById('results');
  if (!input || !box) return;

  let index = null;
  let loading = null;

  const esc = text => String(text).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function load() {
    if (index) return Promise.resolve(index);
    if (loading) return loading;
    loading = fetch(`${assets}/search.json`)
      .then(response => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
      })
      .then(data => {
        index = data.entries.map(entry => ({
          ...entry,
          haystack: `${entry.title} ${entry.shelfTitle} ${entry.headings.map(h => h.text).join(' ')} ${entry.body}`.toLowerCase(),
        }));
        return index;
      })
      .catch(error => {
        loading = null;
        throw error;
      });
    return loading;
  }

  /** One query, every token must appear; CJK works because matching is substring based. */
  function search(query) {
    const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (!tokens.length) return [];
    return index
      .map(entry => {
        const title = entry.title.toLowerCase();
        const headingTexts = entry.headings.map(h => h.text.toLowerCase());
        let score = 0;
        for (const token of tokens) {
          if (!entry.haystack.includes(token)) return { entry, score: -1 };
          if (title.includes(token)) score += 60;
          if (entry.shelfTitle.toLowerCase().includes(token)) score += 20;
          if (headingTexts.some(text => text.includes(token))) score += 25;
          if (entry.body.toLowerCase().includes(token)) score += 4;
        }
        return { entry, score };
      })
      .filter(hit => hit.score >= 0)
      .sort((a, b) => b.score - a.score || a.entry.words - b.entry.words)
      .slice(0, 9);
  }

  function snippet(entry, tokens) {
    const text = entry.body;
    const lower = text.toLowerCase();
    let at = -1;
    for (const token of tokens) {
      const found = lower.indexOf(token);
      if (found >= 0 && (at < 0 || found < at)) at = found;
    }
    if (at < 0) return `${esc(text.slice(0, 96))}…`;
    const start = Math.max(0, at - 42);
    const end = Math.min(text.length, at + 108);
    let html = esc((start > 0 ? '…' : '') + text.slice(start, at));
    const rest = text.slice(at, end);
    let cursor = 0;
    const lowerRest = rest.toLowerCase();
    for (const token of tokens) {
      const found = lowerRest.indexOf(token, cursor);
      if (found < 0) continue;
      html += esc(rest.slice(cursor, found)) + `<mark>${esc(rest.slice(found, found + token.length))}</mark>`;
      cursor = found + token.length;
    }
    return `${html}${esc(rest.slice(cursor))}${end < text.length ? '…' : ''}`;
  }

  function render(query) {
    const tokens = query.split(/\s+/).filter(Boolean);
    if (!tokens.length) {
      box.hidden = true;
      return;
    }
    if (!index) {
      box.innerHTML = '<li class="note">正在读取搜索索引…</li>';
      box.hidden = false;
      return;
    }
    const hits = search(query);
    if (!hits.length) {
      box.innerHTML = `<li class="note">没有匹配「${esc(query)}」的文档。试试批注、LaTeX、画板、MCP、验证。</li>`;
      box.hidden = false;
      return;
    }
    // The index stores paths relative to the docs root, so a page in a subdirectory has to rejoin it.
    const root = (body.dataset.landing || './').replace(/[^/]*$/, '');
    box.innerHTML = hits
      .map(hit => {
        const inPage = hit.entry.headings
          .filter(h => tokens.some(token => h.text.toLowerCase().includes(token.toLowerCase())))
          .slice(0, 3);
        const href = esc(root + hit.entry.href);
        const links = inPage.map(h => `<a href="${href}#${esc(h.id)}">${esc(h.text)}</a>`).join('');
        const more = links ? `<span class="more">${links}</span>` : '';
        return `<li><a class="hit" href="${href}"><strong>${esc(hit.entry.title)}</strong><span class="shelf-tag">${esc(hit.entry.shelfTitle)} · ${hit.entry.headings.length} 个小节</span><span>${snippet(hit.entry, tokens)}</span></a>${more}</li>`;
      })
      .join('');
    box.hidden = false;
  }

  let timer;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    const query = input.value.trim();
    if (query && !index) {
      load()
        .then(() => render(input.value.trim()))
        .catch(error => {
          box.innerHTML = `<li class="note">搜索索引读取失败（${esc(error.message)}）。请通过 GitHub Pages 或本地静态服务器访问本站。</li>`;
          box.hidden = false;
        });
      box.hidden = false;
      return;
    }
    timer = setTimeout(() => render(query), 90);
  });

  input.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      box.hidden = true;
      input.blur();
      return;
    }
    if (event.key === 'Enter') {
      const first = box.querySelector('a.hit');
      if (first) {
        event.preventDefault();
        first.click();
      }
    }
  });

  document.addEventListener('keydown', event => {
    if (event.key === '/' && document.activeElement !== input && !/^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName)) {
      event.preventDefault();
      input.focus();
    }
  });

  document.addEventListener('click', event => {
    if (!event.target.closest('.lookup')) box.hidden = true;
  });

  /* ---- table of contents follows the reader ---- */
  const tocLinks = [...document.querySelectorAll('.toc a[href^="#"]')];
  if (tocLinks.length) {
    const targets = tocLinks.map(link => document.getElementById(decodeURIComponent(link.getAttribute('href').slice(1)))).filter(Boolean);
    const mark = () => {
      const top = window.scrollY + 110;
      let active = targets[0];
      for (const node of targets) {
        if (node.offsetTop <= top) active = node;
      }
      tocLinks.forEach(link => link.classList.toggle('is-active', active && link.getAttribute('href') === `#${active.id}`));
    };
    window.addEventListener('scroll', mark, { passive: true });
    mark();
  }

  /* ---- heading permalinks ---- */
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.setAttribute('role', 'status');
  document.body.appendChild(toast);
  let toastTimer;
  const say = message => {
    toast.textContent = message;
    toast.classList.add('is-on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('is-on'), 1800);
  };

  document.querySelectorAll('.reading .dl').forEach(link => {
    link.addEventListener('click', async event => {
      event.preventDefault();
      const url = new URL(link.getAttribute('href'), location.href).href;
      history.replaceState(null, '', link.getAttribute('href'));
      try {
        await navigator.clipboard.writeText(url);
        say('已复制该小节的直达链接');
      } catch {
        say(url);
      }
    });
  });

  /* ---- the shelf rail collapses on narrow screens ---- */
  const toggle = document.getElementById('rail-toggle');
  const rail = document.getElementById('rail-nav');
  if (toggle && rail) {
    toggle.addEventListener('click', () => {
      const open = rail.classList.toggle('is-open');
      toggle.setAttribute('aria-expanded', String(open));
    });
  }

  if (location.hash) {
    const anchor = document.getElementById(decodeURIComponent(location.hash.slice(1)));
    if (anchor) anchor.classList.add('is-target');
  }
})();
