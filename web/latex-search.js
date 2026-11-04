'use strict';
window.PaperLatexSearch = (() => {
  function create({ toolbar, topbar, search, reveal, changed = () => {} }) {
    const make = (tag, cls, text) => {
      const node = document.createElement(tag);
      if (cls) node.className = cls;
      if (text !== undefined) node.textContent = text;
      return node;
    };
    const button = (text, cls = '', type = 'button') => {
      const node = make('button', `button subtle${cls ? ` ${cls}` : ''}`, text);
      node.type = type;
      return node;
    };
    const toggle = button('搜索', 'latex-workspace-search-toggle');
    toggle.id = 'latex-workspace-search-open';
    toggle.setAttribute('aria-expanded', 'false');
    toggle.setAttribute('aria-controls', 'latex-workspace-search');
    const panel = make('section', 'latex-workspace-search');
    panel.id = 'latex-workspace-search';
    panel.hidden = true;
    panel.setAttribute('aria-label', '工作台搜索');

    const controls = make('form', 'latex-workspace-search-controls');
    controls.setAttribute('role', 'search');
    const scope = make('select');
    scope.id = 'latex-workspace-search-scope';
    scope.setAttribute('aria-label', '搜索范围');
    for (const [value, text] of [['pdf', 'PDF'], ['source', 'LaTeX 源码']]) {
      const option = make('option', '', text);
      option.value = value;
      scope.append(option);
    }
    scope.value = 'pdf';
    const input = make('input');
    input.id = 'latex-workspace-search-query';
    input.type = 'search';
    input.maxLength = 200;
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.placeholder = '输入搜索词';
    input.setAttribute('aria-label', '搜索词');
    const submit = button('查找', '', 'submit');
    const previous = button('‹');
    previous.id = 'latex-workspace-search-prev';
    previous.setAttribute('aria-label', '上一条结果');
    const next = button('›');
    next.id = 'latex-workspace-search-next';
    next.setAttribute('aria-label', '下一条结果');
    const choices = make('select', 'latex-workspace-search-results');
    choices.id = 'latex-workspace-search-results';
    choices.setAttribute('aria-label', '搜索结果');
    const more = button('继续搜索');
    more.id = 'latex-workspace-search-more';
    const status = make('span', 'latex-workspace-search-status');
    status.id = 'latex-workspace-search-status';
    status.setAttribute('role', 'status');
    controls.append(scope, input, submit, previous, next, choices, more, status);
    panel.append(controls);
    toolbar.append(toggle);
    topbar.append(panel);

    let request = null;
    let navigation = 0;
    let matches = [];
    let activeIndex = -1;
    let cursor = null;
    let summary = '';

    function say(message, error = false) {
      status.textContent = message;
      status.classList.toggle('error', error);
    }
    function syncControls() {
      previous.disabled = Boolean(request) || activeIndex <= 0;
      next.disabled = Boolean(request) || activeIndex >= matches.length - 1;
      choices.disabled = Boolean(request) || !matches.length;
      choices.hidden = !matches.length;
      choices.value = activeIndex >= 0 ? String(activeIndex) : '';
      more.hidden = cursor == null;
      more.disabled = Boolean(request);
    }
    function replaceMatches(value) {
      matches = value;
      activeIndex = -1;
      choices.textContent = '';
      matches.forEach((hit, index) => {
        const option = make('option', '', hit.label || `第 ${index + 1} 条结果`);
        option.value = String(index);
        choices.append(option);
      });
      syncControls();
      changed();
    }
    function reset(onlyScope) {
      if (onlyScope && onlyScope !== scope.value) return;
      request?.abort();
      request = null;
      ++navigation;
      cursor = null;
      summary = '';
      replaceMatches([]);
      say('');
    }
    function setOpen(open) {
      panel.hidden = !open;
      toggle.setAttribute('aria-expanded', String(open));
      if (open) input.focus();
      else reset();
    }
    async function activate(index) {
      const hit = matches[index];
      if (!hit || request) return;
      const ticket = ++navigation;
      const isCurrent = () => ticket === navigation && !panel.hidden;
      activeIndex = index;
      syncControls();
      say(`第 ${index + 1} / ${matches.length} 条${summary ? ` · ${summary}` : ''}`);
      changed();
      try {
        await reveal(scope.value, hit, isCurrent);
      } catch (error) {
        if (isCurrent() && error?.name !== 'AbortError') say(error?.message || '无法定位此结果。', true);
      }
    }
    async function run(continueSearch = false) {
      const query = input.value.trim();
      if (panel.hidden || continueSearch && cursor == null) return;
      if (!query) {
        reset();
        say('请输入搜索词。');
        return;
      }
      const nextCursor = continueSearch ? cursor : null;
      reset();
      const controller = new AbortController();
      request = controller;
      cursor = nextCursor;
      syncControls();
      say('正在搜索…');
      try {
        const result = await search(scope.value, query, {
          signal: controller.signal,
          ...(nextCursor != null ? { cursor: nextCursor } : {}),
        });
        if (request !== controller) return;
        request = null;
        cursor = result.next_cursor ?? null;
        summary = result.summary || '';
        replaceMatches(result.matches || []);
        if (matches.length) await activate(0);
        else say(summary || '没有找到匹配结果。');
      } catch (error) {
        if (request !== controller) return;
        request = null;
        syncControls();
        if (error?.name !== 'AbortError') say(error?.message || '搜索失败。', true);
      }
    }

    toggle.addEventListener('click', () => setOpen(panel.hidden));
    panel.addEventListener('keydown', event => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      toggle.focus();
    });
    controls.addEventListener('submit', event => { event.preventDefault(); void run(); });
    input.addEventListener('input', () => reset());
    scope.addEventListener('change', () => {
      reset();
      input.placeholder = scope.value === 'source' ? '搜索所有章节' : '输入搜索词';
      input.focus();
    });
    previous.addEventListener('click', () => void activate(activeIndex - 1));
    next.addEventListener('click', () => void activate(activeIndex + 1));
    choices.addEventListener('change', () => void activate(Number(choices.value)));
    more.addEventListener('click', () => void run(true));
    syncControls();

    return {
      reset,
      close: () => setOpen(false),
      results: requestedScope => requestedScope === scope.value
        ? { matches, active: matches[activeIndex] ?? null }
        : { matches: [], active: null },
    };
  }
  return { create };
})();
