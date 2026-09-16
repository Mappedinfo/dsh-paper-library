(function () {
  'use strict';
  const MAX_PAGES = 2000, MAX_RESIDENT = 3, GAP = 16, CAPTION = 24, PADDING = 12;
  const TOOLS = new Set(['select', 'highlight', 'underline', 'strikeout', 'note']);
  function validateLayout(value) {
    if (!value || !Number.isInteger(value.page_count) || value.page_count < 1 || value.page_count > MAX_PAGES || !Array.isArray(value.pages) || value.pages.length !== value.page_count) throw new Error('PDF 页面尺寸列表不完整或超过 2,000 页。');
    return value.pages.map((page, index) => {
      if (page.page !== index + 1 || !Number.isFinite(page.width) || !Number.isFinite(page.height) || page.width <= 0 || page.height <= 0 || page.width > 100000 || page.height > 100000 || page.height / page.width > 100) throw new Error('PDF 页面尺寸不适合连续阅读，请检查文件。');
      return { page: page.page, width: page.width, height: page.height };
    });
  }
  function pageMetrics(pages, width) {
    let top = PADDING;
    const metrics = pages.map(page => { const height = width * page.height / page.width + CAPTION; const result = { ...page, top, height }; top += height + GAP; return result; });
    if (top > 20000000) throw new Error('连续页面高度超出浏览器显示范围，请使用外部 PDF 阅读器。');
    return metrics;
  }
  function pageAt(metrics, point) {
    if (!metrics.length) return 1;
    let low = 0, high = metrics.length - 1;
    while (low < high) { const middle = Math.ceil((low + high) / 2); if (metrics[middle].top <= point) low = middle; else high = middle - 1; }
    return metrics[low].page;
  }
  function visibleWindow(metrics, top, height, priority) {
    if (!metrics.length) return [];
    const center = priority || pageAt(metrics, top + Math.max(1, height) * .35);
    const candidates = [center, center + 1, center - 1, center + 2, center - 2];
    return [...new Set(candidates)].filter(page => page > 0 && page <= metrics.length).slice(0, MAX_RESIDENT);
  }
  function mergeSelection(words, page) {
    const rects = [], text = []; let characters = 0;
    for (const word of words) {
      if (!Array.isArray(word) || word.length < 5 || !word.slice(0, 4).every(Number.isFinite) || typeof word[4] !== 'string') continue;
      const rect = word.slice(0, 4), last = rects.at(-1), height = rect[3] - rect[1];
      if (height <= 0 || rect[2] <= rect[0]) continue;
      if (last && Math.abs(last[1] - rect[1]) < 2 && Math.abs(last[3] - rect[3]) < 2 && rect[0] >= last[2] - 2 && rect[0] - last[2] < height * 1.5) { last[2] = Math.max(last[2], rect[2]); last[1] = Math.min(last[1], rect[1]); last[3] = Math.max(last[3], rect[3]); }
      else rects.push(rect);
      text.push(word[4].trim());
      characters += word[4].trim().length + 1;
      if (rects.length > 200 || characters > 20000) throw new Error('选择范围超过单次批注上限，请缩小到较短的段落。');
    }
    return { page, text: text.join(' '), rects, wordCount: text.length };
  }
  /** Serial scheduling owns page identities, never retains raster/word payloads. */
  function createPageWindow({ load, install, evict, onError = () => {} }) {
    let epoch = 0, id = null, wanted = [], running = null, inFlight = null, disposed = false;
    const residents = new Set(), failures = new Map(), revisions = new Map(), waiters = new Map();
    const settle = (page, value, error) => { for (const waiter of waiters.get(page) || []) error ? waiter.reject(error) : waiter.resolve(value); waiters.delete(page); };
    function drop(page) { if (residents.delete(page)) evict(page); }
    function pump() {
      if (running || disposed) return running;
      running = (async () => {
        while (!disposed) {
          const page = wanted.find(page => !residents.has(page) && !failures.has(page));
          if (page === undefined || !id) break;
          const job = { id, page, epoch, revision: revisions.get(page) || 0 }; inFlight = job;
          try {
            const result = await load(job);
            if (job.epoch !== epoch || job.id !== id || !wanted.includes(page) || job.revision !== (revisions.get(page) || 0)) continue;
            // The wanted set has at most three entries. Evict before installing,
            // including during rapid jumps, so no fourth raster becomes resident.
            for (const old of [...residents]) if (!wanted.includes(old)) drop(old);
            if (residents.size >= MAX_RESIDENT) drop([...residents].find(old => old !== page));
            const installed = install(page, result, job); residents.add(page); await installed;
            if (job.epoch === epoch && job.id === id && wanted.includes(page) && job.revision === (revisions.get(page) || 0)) settle(page, true);
            else if (job.epoch === epoch) drop(page);
          } catch (error) {
            if (job.epoch === epoch && job.id === id && wanted.includes(page) && job.revision === (revisions.get(page) || 0)) { drop(page); failures.set(page, error); onError(page, error); settle(page, false, error); }
          } finally { if (inFlight === job) inFlight = null; }
        }
      })().finally(() => { running = null; if (!disposed && id && wanted.some(page => !residents.has(page) && !failures.has(page))) void pump(); });
      return running;
    }
    function want(pages) {
      wanted = [...new Set(pages)].filter(page => Number.isInteger(page) && page > 0).slice(0, MAX_RESIDENT);
      for (const page of [...residents]) if (!wanted.includes(page)) drop(page);
      for (const page of [...failures.keys()]) if (!wanted.includes(page)) failures.delete(page);
      for (const page of [...waiters.keys()]) if (!wanted.includes(page)) settle(page, false);
      void pump();
    }
    function reset(nextId) { ++epoch; id = nextId; wanted = []; for (const page of [...residents]) drop(page); for (const page of [...waiters.keys()]) settle(page, false); failures.clear(); revisions.clear(); }
    function ready(page) { if (residents.has(page) && inFlight?.page !== page) return Promise.resolve(true); if (failures.has(page)) return Promise.reject(failures.get(page)); if (!wanted.includes(page)) return Promise.resolve(false); return new Promise((resolve, reject) => { const values = waiters.get(page) || []; values.push({ resolve, reject }); waiters.set(page, values); }); }
    function invalidate(page) { revisions.set(page, (revisions.get(page) || 0) + 1); drop(page); failures.delete(page); void pump(); }
    function dispose() { reset(null); disposed = true; }
    return { reset, want, ready, invalidate, dispose, idle: () => running || Promise.resolve(), snapshot: () => ({ id, residents: [...residents], wanted: [...wanted], inFlight: inFlight ? { id: inFlight.id, page: inFlight.page } : null }) };
  }
  function create({ root, api, getPaper, onActivePage = () => {}, onSelection = () => {}, onStatus = () => {}, onPageNote = () => {} }) {
    if (!root) throw new Error('PDF reader requires a scroll viewport');
    let paperId = null, pages = [], metrics = [], slots = [], active = 1, selection = null, tool = 'select', color = '#ffdb66', generation = 0, jumpTarget = null, frame = null, selectionTimer = null, resizeTimer = null, disposed = false, layoutPromise = null, layoutWidth = 0, lastSelection = '', transport = Promise.resolve(), zoom = 1;
    const renderedScales = new Map();
    const dom = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; };
    root.classList.add('paper-pdf-reader'); root.tabIndex = 0; root.setAttribute('aria-label', 'PDF 连续阅读区域');
    const strip = dom('div', 'pdr-pages'); root.replaceChildren(strip);
    const current = (id, ticket) => !disposed && id === paperId && id === getPaper()?.id && ticket === generation;
    function request(action, args, valid) { const task = transport.catch(() => {}).then(() => valid() ? api(action, args) : null); transport = task.catch(() => {}); return task; }
    // zoom 1 is fit-width; wider layouts scroll horizontally. Raster density may
    // rise with zoom (capped at 4) so magnified text stays sharp within budget.
    const fitWidth = () => Math.max(1, Math.min(1100, (root.clientWidth || 664) - PADDING * 2));
    function scaleFor(page) { const geometry = pages[page - 1]; const cap = Math.min(2 * Math.max(1, zoom), 4); return Math.max(.2, Math.min(cap, layoutWidth / geometry.width * Math.min(2, window.devicePixelRatio || 1))); }
    function announce(loaded = queue.snapshot().residents.includes(active)) { const geometry = pages[active - 1]; if (geometry) onActivePage(active, { paperId, pageCount: pages.length, width: geometry.width, height: geometry.height, loaded }); }
    function placeholder(page, message = '滚动到这里时载入', error = false) {
      const slot = slots[page - 1]; if (!slot) return;
      renderedScales.delete(page);
      for (const image of slot.sheet.querySelectorAll('img')) image.removeAttribute('src');
      const note = dom('div', `pdr-placeholder${error ? ' pdr-error' : ''}`); note.append(dom('span', '', message));
      if (error) { const retry = dom('button', 'button subtle', '重试此页'); retry.type = 'button'; retry.dataset.retryPage = String(page); note.append(retry); }
      slot.sheet.replaceChildren(note); slot.sheet.dataset.loaded = 'false';
    }
    function renderWords(sheet, words, geometry) {
      const layer = dom('div', 'word-layer pdr-word-layer'); layer.dataset.pdfPage = String(geometry.page); layer.setAttribute('aria-label', `PDF 第 ${geometry.page} 页可选文字`);
      const fragment = document.createDocumentFragment(), factor = layoutWidth / geometry.width;
      for (const word of words) {
        if (!Array.isArray(word) || word.length < 5 || !word.slice(0, 4).every(Number.isFinite) || typeof word[4] !== 'string') continue;
        const [x0, y0, x1, y1, text] = word;
        if (x1 <= x0 || y1 <= y0 || x0 < -1 || y0 < -1 || x1 > geometry.width + 1 || y1 > geometry.height + 1) continue;
        const span = dom('span', 'pdf-word pdr-word', `${text} `); span.dataset.rect = JSON.stringify([x0, y0, x1, y1]); span.dataset.pdfPage = String(geometry.page); span.dataset.height = String(y1 - y0);
        Object.assign(span.style, { left: `${x0 / geometry.width * 100}%`, top: `${y0 / geometry.height * 100}%`, width: `${(x1 - x0) / geometry.width * 100}%`, height: `${(y1 - y0) / geometry.height * 100}%`, fontSize: `${(y1 - y0) * factor * .85}px` }); fragment.append(span);
      }
      layer.append(fragment); sheet.append(layer);
    }
    const queue = createPageWindow({
      load: job => { const ticket = generation, scale = scaleFor(job.page); job.requestedScale = scale; return request('page', { id: job.id, page: job.page, scale }, () => current(job.id, ticket)); },
      async install(page, result, job) {
        const ticket = generation, id = paperId;
        const geometry = pages[page - 1];
        if (!result || result.page !== page || result.page_count !== pages.length || Math.abs(result.width - geometry.width) > .1 || Math.abs(result.height - geometry.height) > .1 || typeof result.image !== 'string' || result.image.length > 24 * 1024 * 1024 || !Array.isArray(result.words) || result.words.length > 20000) throw new Error('页面内容或尺寸已改变，请重新打开 PDF 后重试。');
        const sheet = slots[page - 1].sheet, image = dom('img', 'pdr-page-image'); image.alt = `PDF 第 ${page} 页`; image.draggable = false; image.decoding = 'async'; image.dataset.pdfPage = String(page); image.src = `data:image/png;base64,${result.image}`; sheet.replaceChildren(image); renderWords(sheet, result.words, geometry); sheet.dataset.loaded = 'true';
        renderedScales.set(page, job.requestedScale);
        if (image.decode) await image.decode();
        if (!current(id, ticket) || !sheet.contains(image)) return;
        if (page === active) { announce(true); onStatus(result.words_truncated ? '这一页的可选文字超过上限，仅显示部分文字层。' : result.words.length ? '连续滚动阅读；选中文字后可批注或提问。' : '这一页没有可选择的文字，可使用页批注。'); }
      },
      evict: page => placeholder(page),
      onError: (page, error) => { placeholder(page, `第 ${page} 页读取失败：${error.message}`, true); if (page === active) onStatus(error.message, true); },
    });
    function updateWindow(priority) {
      if (!pages.length || disposed || root.clientHeight <= 0) return;
      const next = pageAt(metrics, root.scrollTop + root.clientHeight * .35);
      if (next !== active) { active = next; announce(); }
      queue.want(visibleWindow(metrics, root.scrollTop, root.clientHeight, priority || jumpTarget));
    }
    function scroll() { if (frame !== null) return; frame = window.requestAnimationFrame(() => { frame = null; updateWindow(); }); }
    function resize() {
      if (!pages.length || root.clientWidth <= 0 || disposed) return;
      const width = Math.max(1, fitWidth() * zoom);
      if (Math.abs(width - layoutWidth) < 1) { updateWindow(); return; }
      const oldPage = pageAt(metrics, root.scrollTop), previous = metrics[oldPage - 1], fraction = previous ? (root.scrollTop - previous.top) / previous.height : 0;
      layoutWidth = width; metrics = pageMetrics(pages, width);
      for (const metric of metrics) { const slot = slots[metric.page - 1]; slot.outer.style.width = `${width}px`; slot.outer.style.height = `${metric.height}px`; slot.sheet.style.height = `${metric.height - CAPTION}px`; }
      for (const page of queue.snapshot().residents) for (const span of slots[page - 1].sheet.querySelectorAll('.pdr-word')) span.style.fontSize = `${Number(span.dataset.height) * width / pages[page - 1].width * .85}px`;
      if (previous) root.scrollTop = metrics[oldPage - 1].top + fraction * metrics[oldPage - 1].height;
      updateWindow();
      // Keep fit-width text sharp after expanding the pane, and release an
      // unnecessarily large raster after shrinking. Coalesce sidebar dragging.
      if (resizeTimer !== null) window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        resizeTimer = null;
        for (const page of queue.snapshot().residents) {
          const rendered = renderedScales.get(page), desired = scaleFor(page);
          if (rendered && (desired > rendered * 1.25 || desired < rendered * .65)) queue.invalidate(page);
        }
      }, 120);
    }
    function clear() {
      ++generation; paperId = null; jumpTarget = null; selection = null; lastSelection = ''; queue.reset(null); renderedScales.clear(); pages = []; metrics = []; slots = []; active = 1; layoutWidth = 0; layoutPromise = null; strip.replaceChildren(); root.scrollTop = 0;
      if (frame !== null) { window.cancelAnimationFrame(frame); frame = null; } if (selectionTimer !== null) { window.clearTimeout(selectionTimer); selectionTimer = null; }
      if (resizeTimer !== null) { window.clearTimeout(resizeTimer); resizeTimer = null; }
    }
    async function open(paper, { page = 1 } = {}) {
      clear(); if (!paper?.id || !paper.pdf || disposed) return false;
      paperId = paper.id; queue.reset(paperId); const id = paperId, ticket = generation; onStatus('正在读取 PDF 页面尺寸…');
      const loading = dom('div', 'pdr-placeholder', '正在准备连续阅读…'); strip.append(loading);
      layoutPromise = (async () => {
        try {
          const layout = await request('page_layout', { id }, () => current(id, ticket)); if (!current(id, ticket)) return false;
          pages = validateLayout(layout); slots = pages.map(geometry => { const outer = dom('section', 'pdr-page-slot'); outer.dataset.pdfPage = String(geometry.page); outer.setAttribute('aria-label', `PDF 第 ${geometry.page} 页`); const caption = dom('div', 'pdr-page-caption', `${geometry.page} / ${pages.length}`), sheet = dom('div', 'pdr-sheet'); sheet.dataset.pdfPage = String(geometry.page); outer.append(caption, sheet); return { outer, sheet }; });
          strip.replaceChildren(...slots.map(slot => slot.outer)); for (const geometry of pages) placeholder(geometry.page);
          layoutWidth = Math.max(1, fitWidth() * zoom); metrics = pageMetrics(pages, layoutWidth);
          for (const metric of metrics) { const slot = slots[metric.page - 1]; slot.outer.style.width = `${layoutWidth}px`; slot.outer.style.height = `${metric.height}px`; slot.sheet.style.height = `${metric.height - CAPTION}px`; }
          active = Math.max(1, Math.min(pages.length, Math.trunc(Number(page)) || 1)); announce(false); return true;
        } catch (error) {
          if (current(id, ticket)) { strip.replaceChildren(dom('p', 'pdr-layout-error', `PDF 连续阅读暂不可用：${error.message}`)); onStatus(error.message, true); }
          throw error;
        }
      })();
      if (!await layoutPromise || !current(id, ticket)) return false;
      return goTo(page);
    }
    async function goTo(value) {
      const id = paperId, ticket = generation;
      if (layoutPromise && !pages.length) { if (!await layoutPromise || !current(id, ticket)) return false; }
      if (!pages.length) return false;
      const page = Math.max(1, Math.min(pages.length, Math.trunc(Number(value)) || 1)); jumpTarget = page; active = page; root.scrollTop = Math.max(0, metrics[page - 1].top - PADDING); announce(); queue.want(visibleWindow(metrics, root.scrollTop, root.clientHeight, page));
      try { return await queue.ready(page); }
      finally { if (current(id, ticket) && jumpTarget === page) { jumpTarget = null; updateWindow(); } }
    }
    async function refresh(value = active) {
      if (!pages.length) return false;
      const page = Math.max(1, Math.min(pages.length, Math.trunc(Number(value)) || active)), id = paperId, ticket = generation;
      queue.want([page, ...visibleWindow(metrics, root.scrollTop, root.clientHeight)].slice(0, MAX_RESIDENT)); queue.invalidate(page);
      try { return await queue.ready(page); }
      finally { if (current(id, ticket)) updateWindow(); }
    }
    function layerOf(node) { const element = node?.nodeType === 3 ? node.parentElement : node; return element?.closest?.('.pdr-word-layer'); }
    function captureSelection() {
      if (tool === 'note' || !paperId) return;
      const value = window.getSelection(); if (!value?.rangeCount || value.isCollapsed) return;
      const anchor = layerOf(value.anchorNode), focus = layerOf(value.focusNode);
      if (!anchor || !focus || !root.contains(anchor) || !root.contains(focus)) {
        if (root.contains(value.anchorNode) || root.contains(value.focusNode)) { selection = null; lastSelection = ''; onSelection(null, { intent: tool, color }); onStatus('请选择同一 PDF 页内的文字，再保存批注。', true); }
        return;
      }
      if (anchor !== focus) { selection = null; lastSelection = ''; onSelection(null, { intent: tool, color }); onStatus('选文跨越了多个 PDF 页面，请分别选择并保存每一页的批注。', true); return; }
      const selected = [];
      for (const span of anchor.children) if (value.containsNode(span, true)) selected.push([...JSON.parse(span.dataset.rect), span.textContent.trim()]);
      if (!selected.length) return;
      try {
        const result = mergeSelection(selected, Number(anchor.dataset.pdfPage)); if (!result.rects.length) return;
        const digest = JSON.stringify([result.page, result.text, result.rects]); if (digest === lastSelection) return;
        lastSelection = digest; selection = { id: paperId, ...result }; onSelection(selection, { intent: tool, color });
      } catch (error) { selection = null; lastSelection = ''; onSelection(null, { intent: tool, color }); onStatus(error.message, true); }
    }
    function pointerUp(event) {
      if (tool === 'note') {
        const sheet = event.target.closest?.('.pdr-sheet'); if (!sheet || !root.contains(sheet) || sheet.dataset.loaded !== 'true') return;
        const page = Number(sheet.dataset.pdfPage), geometry = pages[page - 1], box = sheet.getBoundingClientRect();
        if (!box.width || !box.height) return;
        const x = Math.max(0, Math.min(geometry.width - Math.min(20, geometry.width), (event.clientX - box.left) / box.width * geometry.width)), y = Math.max(0, Math.min(geometry.height - Math.min(20, geometry.height), (event.clientY - box.top) / box.height * geometry.height));
        onPageNote({ id: paperId, page, text: '', rects: [[x, y, Math.min(geometry.width, x + 20), Math.min(geometry.height, y + 20)]] }, { intent: 'note', color }); return;
      }
      if (selectionTimer !== null) window.clearTimeout(selectionTimer); selectionTimer = window.setTimeout(() => { selectionTimer = null; captureSelection(); }, 0);
    }
    function click(event) { const retry = event.target.closest?.('[data-retry-page]'); if (retry && root.contains(retry)) void refresh(Number(retry.dataset.retryPage)).catch(() => {}); }
    function setTool(value, nextColor) { if (!TOOLS.has(value)) throw new Error('Unsupported PDF annotation tool'); tool = value; if (nextColor !== undefined) { if (!/^#[0-9a-f]{6}$/i.test(nextColor)) throw new Error('Annotation color must be #RRGGBB'); color = nextColor; } root.dataset.tool = tool; lastSelection = ''; }
    function setZoom(value) {
      const next = Number(value);
      if (!Number.isFinite(next)) throw new Error('缩放比例无效');
      const clamped = Math.round(Math.max(.25, Math.min(4, next)) * 100) / 100;
      if (Math.abs(clamped - zoom) < .001) return zoom;
      zoom = clamped; resize(); return zoom;
    }
    // Clearing a browser selection must permit choosing the same passage again.
    // Keep the frozen source available while toolbar/dialog focus collapses it.
    function selectionChanged() { const value = window.getSelection(); if (!value?.rangeCount || value.isCollapsed) lastSelection = ''; }
    const resizeObserver = new ResizeObserver(() => { try { resize(); } catch (error) { onStatus(error.message, true); } }); resizeObserver.observe(root);
    root.addEventListener('scroll', scroll, { passive: true }); root.addEventListener('pointerup', pointerUp); root.addEventListener('keyup', captureSelection); root.addEventListener('click', click); setTool('select');
    document.addEventListener('selectionchange', selectionChanged);
    function dispose() { clear(); disposed = true; queue.dispose(); resizeObserver.disconnect(); root.removeEventListener('scroll', scroll); root.removeEventListener('pointerup', pointerUp); root.removeEventListener('keyup', captureSelection); root.removeEventListener('click', click); document.removeEventListener('selectionchange', selectionChanged); }
    return { open, goTo, refresh, clear, dispose, setTool, setZoom, getZoom: () => zoom, resize, getSnapshot: () => ({ paperId, page: active, pageCount: pages.length, zoom, selection: selection ? { ...selection, rects: selection.rects.map(rect => [...rect]) } : null, residentPages: queue.snapshot().residents, inFlightPage: queue.snapshot().inFlight?.page || null }) };
  }
  window.PaperPDFReader = Object.freeze({ create, createPageWindow, validateLayout, pageMetrics, pageAt, visibleWindow, mergeSelection });
})();
