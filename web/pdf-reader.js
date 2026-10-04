(function () {
  'use strict';
  const MAX_PAGES = 2000, MAX_RESIDENT = 3, GAP = 16, CAPTION = 24, PADDING = 12;
  const TOOLS = new Set(['select', 'highlight', 'underline', 'strikeout', 'note', 'ink']);
  const MARKUP_TOOLS = new Set(['highlight', 'underline', 'strikeout']);
  const MAX_INK_PATHS = 64, MAX_INK_POINTS = 4096;
  const inkId = value => typeof value === 'string' && !!value.trim() && value.length <= 256 && !/[\u0000-\u001f]/.test(value);
  /** Diagnostic metadata is deliberately separate from PDF paths and text. */
  function createInkTrace(callback = () => {}) {
    const events = new Set(['stroke_start', 'stroke_end', 'stroke_cancel', 'input_blocked', 'draft_clear', 'draft_restore', 'overlay_update', 'overlay_retire', 'page_install', 'page_defer']);
    return (event, details = {}) => {
      if (!events.has(event)) return;
      const record = { event };
      for (const key of ['paperId', 'annotationId']) if (inkId(details[key])) record[key] = details[key];
      for (const key of ['page', 'strokes', 'points', 'revision', 'count']) if (Number.isSafeInteger(details[key]) && details[key] >= 0) record[key] = details[key];
      if (['pen', 'mouse', 'touch', 'unknown'].includes(details.pointerType)) record.pointerType = details.pointerType;
      if (typeof details.reason === 'string' && /^[a-z_]{1,64}$/.test(details.reason)) record.reason = details.reason;
      try { const pending = callback(record); if (pending && typeof pending.then === 'function') Promise.resolve(pending).catch(() => {}); } catch { /* Diagnostics can never interrupt input. */ }
    };
  }
  /** Pointer type comes from the browser, never pressure or a platform guess.
   * Compatibility stays opt-out because Sidecar can report a Pencil as mouse. */
  function createInputPolicy(onChange = () => {}) {
    let lastType = null, seenPen = false, penOnly = false;
    const info = () => ({ lastType, seenPen, penOnly });
    return {
      info,
      observe(event) {
        if (event.isTrusted === false) return;
        const type = ['pen', 'mouse', 'touch'].includes(event.pointerType) ? event.pointerType : 'unknown';
        if (type === lastType) return;
        lastType = type; if (type === 'pen') seenPen = true; onChange(info());
      },
      setPenOnly(value) { const next = !!value; if (next !== penOnly) { penOnly = next; onChange(info()); } return penOnly; },
      accepts(event) { return event.pointerType !== 'touch' && (!penOnly || event.pointerType === 'pen'); },
    };
  }
  /** Snap only to a real text box; the browser still determines the character
   * boundary inside its fitted text run. Useful when a pen is just below text. */
  function nearestTextPosition(boxes, x, y, limit = Infinity) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    let best = null, distance = limit * limit;
    boxes.forEach((box, index) => {
      if (!box || ![box.left, box.top, box.right, box.bottom].every(Number.isFinite) || box.right <= box.left || box.bottom <= box.top) return;
      const dx = Math.max(box.left - x, 0, x - box.right), dy = Math.max(box.top - y, 0, y - box.bottom), next = dx * dx + dy * dy;
      if (next > distance || (best && next === distance)) return;
      distance = next; best = { index, x: Math.max(box.left + .01, Math.min(box.right - .01, x)), y: Math.max(box.top + .01, Math.min(box.bottom - .01, y)) };
    });
    return best;
  }
  /** All annotation geometry uses the displayed (already rotated) PDF page.
   * Scaling from its live bounds also works after zoom or horizontal scrolling. */
  function inkPoint(event, box, geometry) {
    if (!box?.width || !box?.height || !geometry || !Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return null;
    return [(event.clientX - box.left) / box.width * geometry.width, (event.clientY - box.top) / box.height * geometry.height].map((value, axis) => Math.max(0, Math.min(axis ? geometry.height : geometry.width, Math.round(value * 1000) / 1000)));
  }
  function regionRects(rects, geometry, padding = 0) {
    if (!geometry || !Array.isArray(rects) || !rects.length || rects.length > 200) return [];
    if (rects.some(rect => !Array.isArray(rect) || rect.length !== 4 || !rect.every(Number.isFinite) || rect[2] < rect[0] || rect[3] < rect[1])) return [];
    return rects.map(rect => {
      const pad = Math.max(0, padding), [x0, y0, x1, y1] = rect;
      return [Math.max(0, x0 - pad), Math.max(0, y0 - pad), Math.min(geometry.width, Math.max(x1 + pad, x0 + 1)), Math.min(geometry.height, Math.max(y1 + pad, y0 + 1))];
    }).filter(rect => rect[2] > rect[0] && rect[3] > rect[1]);
  }
  /** Preserve position when already visible; move only the obscured edge. */
  function minimumScroll(start, end, viewStart, viewSize, margin = 20) {
    const inset = Math.min(margin, viewSize / 4), low = viewStart + inset, high = viewStart + viewSize - inset;
    if (start >= low && end <= high) return viewStart;
    if (end - start > viewSize - inset * 2) return Math.max(0, (start + end - viewSize) / 2);
    return Math.max(0, start < low ? start - inset : end - viewSize + inset);
  }
  /** Frozen queue snapshots outlive the active draft. A save acknowledgment is
   * insufficient to remove pixels: only a decoded raster with that ID is. */
  function createInkOverlays() {
    let values = new Map(); const rasters = new Map();
    const key = value => JSON.stringify([value.paperId, value.annotation_id]);
    const clone = value => ({ ...value, paths: value.paths.map(path => path.map(point => [...point])) });
    const present = value => rasters.get(JSON.stringify([value.paperId, value.page]))?.has(value.annotation_id);
    function replace(batches) {
      if (!Array.isArray(batches) || batches.length > 32) throw new Error('待显示笔迹超出单次上限');
      const next = new Map([...values].filter(([, value]) => value.status === 'saved' && !present(value)));
      for (const batch of batches) {
        if (!batch || !inkId(batch.annotation_id) || !['pending', 'staging', 'stage_failed', 'queued', 'writing', 'uncertain', 'saved'].includes(batch.status)) throw new Error('待显示笔迹格式无效');
        const buffer = createInkBuffer(); buffer.restore({ ...batch, revision: 0 });
        const { revision, ...draft } = buffer.snapshot(), value = { ...draft, annotation_id: batch.annotation_id, status: batch.status === 'saved' ? 'saved' : 'pending' };
        const old = values.get(key(value));
        if (old && JSON.stringify({ ...old, status: null }) !== JSON.stringify({ ...value, status: null })) throw new Error('同一保存身份不能替换笔迹');
        if (old?.status === 'saved') value.status = 'saved';
        if (present(value)) next.delete(key(value)); else next.set(key(value), value);
      }
      if (next.size > 64 || encodeURIComponent(JSON.stringify([...next.values()])).replace(/%[0-9a-f]{2}/gi, 'x').length > 4 * 1024 * 1024) throw new Error('待刷新笔迹过多，请先刷新已保存页面');
      values = next; return snapshot();
    }
    function confirm(paperId, page, ids) {
      rasters.set(JSON.stringify([paperId, page]), new Set(ids));
      for (const [id, value] of values) if (value.paperId === paperId && value.page === page && present(value)) values.delete(id);
    }
    function forget(paperId, page) { rasters.delete(JSON.stringify([paperId, page])); }
    function snapshot() { return [...values.values()].map(clone); }
    return { replace, confirm, forget, snapshot, forPage: (paperId, page) => [...values.values()].filter(value => value.paperId === paperId && value.page === page), clearRasters: () => rasters.clear(), clear: () => { values.clear(); rasters.clear(); } };
  }
  /** A bounded, single-page draft independent of page raster residency. A
   * cancelled pointer loses only its unfinished stroke; snapshots for saving
   * never include an in-progress stroke. */
  function createInkBuffer() {
    let draft = null, stroke = null, revision = 0, points = 0, context = null;
    const clone = paths => paths.map(path => path.map(point => [...point]));
    const getContext = () => context ? { ...context } : null;
    function setContext(value) {
      if (value !== null && (!value || typeof value !== 'object' || !inkId(value.paperId) || !inkId(value.parentId) || !Number.isInteger(value.page) || value.page < 1 || value.page > MAX_PAGES)) throw new Error('请先选择一条有效的 PDF 批注，再在其页面上手写。');
      const next = value === null ? null : { paperId: value.paperId, page: value.page, parentId: value.parentId };
      // Never relabel existing free ink or move a linked draft to another note.
      // A caller must explicitly finish or discard that draft before switching.
      if (draft && ((draft.parentId || null) !== (next?.parentId || null) || next && (draft.paperId !== next.paperId || draft.page !== next.page))) throw new Error('已有未保存的手写，请先保存或取消，再切换关联批注。');
      context = next; return getContext();
    }
    function start(origin, point, style) {
      if (stroke) return false;
      if (context && (context.paperId !== origin.paperId || context.page !== origin.page)) throw new Error(`这段手写关联原文第 ${context.page} 页的批注，请返回该文献的这一页继续书写。`);
      if (draft && (draft.paperId !== origin.paperId || draft.page !== origin.page)) throw new Error('请先保存或取消原页面上的手写，再在其他页面书写。');
      if (draft && (draft.paths.length >= MAX_INK_PATHS || points + 2 > MAX_INK_POINTS)) throw new Error('本次手写已达上限，请保存后继续。');
      if (!draft) draft = { paperId: origin.paperId, page: origin.page, ...(context ? { parentId: context.parentId } : {}), paths: [], width: style.width, color: style.color, revision };
      stroke = [[...point]]; return true;
    }
    function append(point, endpoint = false) {
      if (!stroke || !point) return false;
      const previous = stroke.at(-1), distance = Math.hypot(point[0] - previous[0], point[1] - previous[1]);
      if (distance === 0 || (!endpoint && distance < .25)) return false;
      if (points + stroke.length >= MAX_INK_POINTS) throw new Error('本次手写已达点数上限，已保留画出的部分；请保存后继续。');
      stroke.push([...point]); return true;
    }
    function end(cancelled = false) {
      if (!stroke) return false;
      if (!cancelled) {
        if (stroke.length === 1) stroke.push([...stroke[0]]);
        draft.paths.push(stroke); points += stroke.length; draft.revision = ++revision;
      }
      stroke = null; if (!draft.paths.length) draft = null; return !cancelled;
    }
    function snapshot() { return draft?.paths.length ? { ...draft, paths: clone(draft.paths) } : null; }
    function preview() { return draft ? { ...draft, paths: [...draft.paths, ...(stroke ? [stroke] : [])] } : null; }
    function undo() {
      end(true); if (!draft) return false;
      points -= draft.paths.pop().length; draft.revision = ++revision;
      if (!draft.paths.length) draft = null; return true;
    }
    function clear(expectedRevision) {
      if (expectedRevision !== undefined && expectedRevision !== draft?.revision) return false;
      draft = null; stroke = null; points = 0; ++revision; return true;
    }
    function restore(value) {
      if (draft || stroke) throw new Error('已有手写草稿，不能用另一份草稿覆盖。');
      if (value === null || value === undefined) return false;
      const invalid = () => { throw new Error('保存的手写草稿不完整或超出上限，请保留草稿并重试。'); };
      if (!value || typeof value !== 'object' || !inkId(value.paperId) || value.parentId !== undefined && !inkId(value.parentId)
        || !Number.isInteger(value.page) || value.page < 1 || value.page > MAX_PAGES || !Number.isFinite(value.width) || value.width < .5 || value.width > 8 || !/^#[0-9a-f]{6}$/i.test(value.color)
        || !Number.isSafeInteger(value.revision) || value.revision < 0 || !Array.isArray(value.paths) || !value.paths.length || value.paths.length > MAX_INK_PATHS) invalid();
      let count = 0;
      for (const path of value.paths) {
        if (!Array.isArray(path) || path.length < 2 || (count += path.length) > MAX_INK_POINTS) invalid();
        for (const point of path) if (!Array.isArray(point) || point.length !== 2 || !point.every(coordinate => Number.isFinite(coordinate) && coordinate >= 0 && coordinate <= 100000)) invalid();
      }
      const restored = { paperId: value.paperId, page: value.page, ...(value.parentId === undefined ? {} : { parentId: value.parentId }), paths: clone(value.paths), width: value.width, color: value.color, revision: Math.max(revision + 1, value.revision) };
      if (encodeURIComponent(JSON.stringify(restored)).replace(/%[0-9a-f]{2}/gi, 'x').length > 128 * 1024) invalid();
      draft = restored; revision = restored.revision; points = count;
      context = restored.parentId ? { paperId: restored.paperId, page: restored.page, parentId: restored.parentId } : null;
      return true;
    }
    return { start, append, end, snapshot, preview, undo, clear, restore, setContext, getContext, isDrawing: () => !!stroke };
  }
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
  /** Clip每个被选中的词框到真实选区：横向取该词被选中字符的矩形，纵向沿用词框
   * （与栅格文字一致）。只要这个词确实被选中且有文字，就绝不丢弃——否则界面
   * 高亮过的文字会从批注与预览中消失。缺少可测量矩形时回退到整个词框。 */
  function clipWords(entries) {
    const words = [];
    for (const entry of entries || []) {
      if (!entry || !Array.isArray(entry.box) || entry.box.length < 4 || !entry.box.every(Number.isFinite)) continue;
      const [left, top, right, bottom] = entry.box;
      if (right <= left || bottom <= top) continue;
      const text = typeof entry.text === 'string' ? entry.text.replace(/\s+/g, ' ').trim() : '';
      if (!text) continue;
      const parts = (Array.isArray(entry.parts) ? entry.parts : [])
        .filter(part => Array.isArray(part) && part.length >= 2 && part.every(Number.isFinite))
        .map(part => [Math.max(left, part[0]), Math.min(right, part[part.length >= 2 ? 1 : 1])])
        .filter(part => part[1] - part[0] > .5);
      const start = parts.length ? Math.min(...parts.map(part => part[0])) : left;
      const end = parts.length ? Math.max(...parts.map(part => part[1])) : right;
      words.push([start, top, end, bottom, text]);
    }
    return words;
  }
  const CJK = /[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef]/;
  /** Join selected pieces the way the page is laid out:
   * - a wrap contributes no space (the page breaks the line, not a space),
   *   which also keeps a hyphenated break as one word ("measure-" + "ment");
   * - CJK neighbours never get a separator, matching the page text;
   * - Latin words on the same visual line keep their space. */
  function joinSelection(pieces) {
    let text = '', previous = null;
    for (const piece of pieces) {
      if (!piece.text) continue;
      if (!text) { text = piece.text; previous = piece; continue; }
      const sameLine = Math.abs(previous.top - piece.top) < 2 && Math.abs(previous.bottom - piece.bottom) < 2
        || Math.abs(previous.left - piece.left) < 2 && Math.abs(previous.right - piece.right) < 2;
      const cjk = CJK.test(text.slice(-1)) || CJK.test(piece.text[0]);
      text += sameLine && !cjk ? ' ' + piece.text : piece.text;
      previous = piece;
    }
    return text;
  }
  /** rgba() text for a hex colour; used for the live selection wash so the
   * highlight always shows the colour that will be saved. */
  function hexTint(value, alpha = .45) {
    const hex = typeof value === 'string' ? value.trim() : '';
    const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(hex);
    const full = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
    if (!short && !full) return '';
    const channels = (short ? [short[1] + short[1], short[2] + short[2], short[3] + short[3]] : full.slice(1)).map(part => Number.parseInt(part, 16));
    const level = Number.isFinite(alpha) ? Math.min(1, Math.max(0, alpha)) : .45;
    return `rgba(${channels.join(', ')}, ${level})`;
  }
  /** rgba() text for a saved PDF annotation colour ({stroke:[r,g,b]} in 0–1). */
  function annotationTint(annotation, alpha = .38) {
    const stroke = annotation?.color?.stroke;
    if (!Array.isArray(stroke) || stroke.length < 3 || !stroke.slice(0, 3).every(value => Number.isFinite(value))) return '';
    const channels = stroke.slice(0, 3).map(value => Math.round(Math.min(1, Math.max(0, value)) * 255));
    return `rgba(${channels.join(', ')}, ${Number.isFinite(alpha) ? Math.min(1, Math.max(0, alpha)) : .38})`;
  }
  function mergeSelection(words, page) {
    const rects = [], pieces = []; let characters = 0;
    for (const word of words) {
      if (!Array.isArray(word) || word.length < 5 || !word.slice(0, 4).every(Number.isFinite) || typeof word[4] !== 'string') continue;
      const rect = word.slice(0, 4), last = rects.at(-1), height = rect[3] - rect[1];
      if (height <= 0 || rect[2] <= rect[0]) continue;
      if (last && Math.abs(last[1] - rect[1]) < 2 && Math.abs(last[3] - rect[3]) < 2 && rect[0] >= last[2] - 2 && rect[0] - last[2] < height * 1.5) { last[2] = Math.max(last[2], rect[2]); last[1] = Math.min(last[1], rect[1]); last[3] = Math.max(last[3], rect[3]); }
      else rects.push(rect);
      const text = word[4].trim();
      pieces.push({ text, left: rect[0], top: rect[1], right: rect[2], bottom: rect[3] });
      characters += text.length + 1;
      if (rects.length > 200 || characters > 20000) throw new Error('选择范围超过单次批注上限，请缩小到较短的段落。');
    }
    const text = joinSelection(pieces);
    return { page, text, rects, wordCount: pieces.length };
  }
  /** Serial scheduling owns page identities, never retains raster/word payloads. */
  function createPageWindow({ load, install, evict, onError = () => {} }) {
    let epoch = 0, id = null, wanted = [], running = null, inFlight = null, disposed = false;
    const residents = new Set(), failures = new Map(), revisions = new Map(), waiters = new Map(), dirty = new Set();
    const needs = page => (!residents.has(page) || dirty.has(page)) && !failures.has(page);
    const settle = (page, value, error) => { for (const waiter of waiters.get(page) || []) error ? waiter.reject(error) : waiter.resolve(value); waiters.delete(page); };
    function drop(page) { if (residents.delete(page)) evict(page); }
    function pump() {
      if (running || disposed) return running;
      running = (async () => {
        while (!disposed) {
          const page = wanted.find(needs);
          if (page === undefined || !id) break;
          const job = { id, page, epoch, revision: revisions.get(page) || 0, preserved: residents.has(page) }; job.current = () => job.epoch === epoch && job.id === id && wanted.includes(page) && job.revision === (revisions.get(page) || 0); inFlight = job;
          try {
            const result = await load(job);
            if (job.epoch !== epoch || job.id !== id || !wanted.includes(page) || job.revision !== (revisions.get(page) || 0)) continue;
            // The wanted set has at most three entries. Evict before installing,
            // including during rapid jumps, so no fourth raster becomes resident.
            for (const old of [...residents]) if (!wanted.includes(old)) drop(old);
            if (!residents.has(page) && residents.size >= MAX_RESIDENT) drop([...residents].find(old => old !== page));
            const installed = install(page, result, job); residents.add(page); await installed;
            if (job.current()) { dirty.delete(page); settle(page, true); }
            else if (job.epoch === epoch && !wanted.includes(page)) drop(page);
          } catch (error) {
            if (job.current()) { if (!job.preserved) drop(page); failures.set(page, error); onError(page, error, { preserved: job.preserved }); settle(page, false, error); }
          } finally { if (inFlight === job) inFlight = null; }
        }
      })().finally(() => { running = null; if (!disposed && id && wanted.some(needs)) void pump(); });
      return running;
    }
    function want(pages) {
      wanted = [...new Set(pages)].filter(page => Number.isInteger(page) && page > 0).slice(0, MAX_RESIDENT);
      for (const page of [...residents]) if (!wanted.includes(page)) drop(page);
      for (const page of [...failures.keys()]) if (!wanted.includes(page)) failures.delete(page);
      for (const page of [...waiters.keys()]) if (!wanted.includes(page)) settle(page, false);
      void pump();
    }
    function reset(nextId) { ++epoch; id = nextId; wanted = []; for (const page of [...residents]) drop(page); for (const page of [...waiters.keys()]) settle(page, false); failures.clear(); revisions.clear(); dirty.clear(); }
    function ready(page) { if (residents.has(page) && !dirty.has(page) && inFlight?.page !== page) return Promise.resolve(true); if (failures.has(page)) return Promise.reject(failures.get(page)); if (!wanted.includes(page)) return Promise.resolve(false); return new Promise((resolve, reject) => { const values = waiters.get(page) || []; values.push({ resolve, reject }); waiters.set(page, values); }); }
    function invalidate(page, { preserve = false } = {}) { revisions.set(page, (revisions.get(page) || 0) + 1); dirty.add(page); if (!preserve) drop(page); failures.delete(page); void pump(); }
    function dispose() { reset(null); disposed = true; }
    return { reset, want, ready, invalidate, dispose, idle: () => running || Promise.resolve(), snapshot: () => ({ id, residents: [...residents], wanted: [...wanted], inFlight: inFlight ? { id: inFlight.id, page: inFlight.page } : null }) };
  }
  function create({ root, api, getPaper, onActivePage = () => {}, onSelection = () => {}, onStatus: reportStatus = () => {}, onPageNote = () => {}, onAnnotationActivate = () => {}, onInkChange = () => {}, onInputChange = () => {}, onFocusChange = () => {}, onInkTrace = () => {} }) {
    if (!root) throw new Error('PDF reader requires a scroll viewport');
    let paperId = null, pages = [], metrics = [], slots = [], active = 1, selection = null, tool = 'select', color = '#ffdb66', generation = 0, jumpTarget = null, frame = null, selectionTimer = null, resizeTimer = null, flashTimer = null, disposed = false, layoutPromise = null, layoutWidth = 0, lastSelection = '', pendingRange = null, transport = Promise.resolve(), zoom = 1;
    const renderedScales = new Map(), pageAnnotations = new Map();
    const ink = createInkBuffer();
    const traceInk = createInkTrace(onInkTrace);
    const inkDetails = () => { const draft = ink.preview(); return draft ? { paperId: draft.paperId, page: draft.page, strokes: draft.paths.length, points: draft.paths.reduce((total, path) => total + path.length, 0), revision: draft.revision } : { paperId, strokes: 0, points: 0 }; };
    const input = createInputPolicy(onInputChange), handledTouches = new Set();
    const overlays = createInkOverlays(), inputWaiters = new Set(), dirtyPages = new Set(), refreshWaiters = new Map();
    let nativeGesture = null, nativeEndTimer = null, refreshTimer = null, focusSequence = 0, focusState = null, returnPosition = null, focusCancelled = null;
    let inkWidth = 2, inkGesture = null, inkFrame = null, inkEnabled = true, markupGesture = null, touchPan = null, policyRejected = false;
    const policyRejection = '仅用笔标注已开启；当前输入未被浏览器识别为笔。';
    function onStatus(message, error = false) { policyRejected = false; reportStatus(message, error); }
    function acceptedAnnotationInput() {
      if (!policyRejected) return;
      policyRejected = false;
      // The host may have shown a different error since this rejection.
      reportStatus('', false, { clearIf: policyRejection });
    }
    const dom = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; };
    root.classList.add('paper-pdf-reader'); root.tabIndex = 0; root.setAttribute('aria-label', 'PDF 连续阅读区域');
    const strip = dom('div', 'pdr-pages'); root.replaceChildren(strip);
    function inputBusy(page) { return [inkGesture, markupGesture, nativeGesture].some(gesture => gesture && (!page || Number(gesture.sheet.dataset.pdfPage) === page)) || !!touchPan; }
    function waitForInput(page, valid) { if (!valid()) return Promise.resolve(false); if (!inputBusy(page)) return Promise.resolve(true); return new Promise(resolve => inputWaiters.add({ page, valid, resolve })); }
    function inputEnded() {
      for (const waiter of inputWaiters) if (!waiter.valid() || !inputBusy(waiter.page)) { inputWaiters.delete(waiter); waiter.resolve(waiter.valid()); }
      scheduleRefresh();
    }
    function paintOverlays(onlyPage) {
      for (const layer of root.querySelectorAll('.pdr-ink-overlay')) if (!onlyPage || Number(layer.dataset.pdfPage) === onlyPage) layer.remove();
      for (const batch of overlays.snapshot()) {
        if (batch.paperId !== paperId || onlyPage && batch.page !== onlyPage) continue;
        const slot = slots[batch.page - 1], geometry = pages[batch.page - 1]; if (!slot || !geometry) continue;
        const layer = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); layer.classList.add('pdr-ink-overlay'); layer.dataset.annotationId = batch.annotation_id; layer.dataset.status = batch.status; layer.dataset.pdfPage = String(batch.page);
        layer.setAttribute('viewBox', `0 0 ${geometry.width} ${geometry.height}`); layer.setAttribute('preserveAspectRatio', 'none'); layer.setAttribute('aria-hidden', 'true'); layer.setAttribute('stroke', batch.color); layer.setAttribute('stroke-width', String(batch.width));
        for (const path of batch.paths) { const line = document.createElementNS('http://www.w3.org/2000/svg', 'polyline'); line.setAttribute('points', path.map(point => point.join(',')).join(' ')); layer.append(line); }
        slot.sheet.append(layer);
      }
    }
    function setInkOverlays(batches) { overlays.replace(batches); paintOverlays(); traceInk('overlay_update', { paperId, count: overlays.snapshot().length }); return true; }
    function paintInkContext() {
      const context = ink.getContext();
      root.dataset.inkContext = context ? 'linked' : 'free';
      slots.forEach((slot, index) => slot.sheet.classList.toggle('pdr-ink-target', context?.paperId === paperId && context.page === index + 1));
    }
    function paintInk() {
      const draft = ink.preview();
      for (const layer of root.querySelectorAll('.pdr-ink-draft')) if (!draft || draft.paperId !== paperId || Number(layer.dataset.pdfPage) !== draft.page) layer.remove();
      if (!draft || draft.paperId !== paperId) return;
      const sheet = slots[draft.page - 1]?.sheet, geometry = pages[draft.page - 1];
      if (!sheet || !geometry) return;
      let layer = sheet.querySelector('.pdr-ink-draft');
      if (!layer) {
        layer = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); layer.classList.add('pdr-ink-draft'); layer.dataset.pdfPage = String(draft.page);
        layer.setAttribute('viewBox', `0 0 ${geometry.width} ${geometry.height}`); layer.setAttribute('preserveAspectRatio', 'none'); layer.setAttribute('aria-hidden', 'true'); sheet.append(layer);
      }
      layer.setAttribute('stroke', draft.color); layer.setAttribute('stroke-width', String(draft.width));
      while (layer.children.length > draft.paths.length) layer.lastElementChild.remove();
      draft.paths.forEach((path, index) => {
        let line = layer.children[index];
        if (!line) { line = document.createElementNS('http://www.w3.org/2000/svg', 'polyline'); layer.append(line); }
        const points = (path.length === 1 ? [path[0], path[0]] : path).map(point => point.join(',')).join(' ');
        if (line.getAttribute('points') !== points) line.setAttribute('points', points);
      });
    }
    function scheduleInk() {
      if (inkFrame !== null) return;
      inkFrame = window.requestAnimationFrame(() => { inkFrame = null; paintInk(); });
    }
    function inkChanged() { paintInk(); onInkChange(ink.snapshot()); }
    function endInk(cancelled = false, reason = 'pointerup') {
      if (!inkGesture) return false;
      const { pointerId, pointerType } = inkGesture, details = inkDetails(); inkGesture = null;
      const changed = ink.end(cancelled);
      try { if (root.hasPointerCapture?.(pointerId)) root.releasePointerCapture(pointerId); } catch { /* The platform may have released capture already. */ }
      if (inkFrame !== null) { window.cancelAnimationFrame(inkFrame); inkFrame = null; }
      if (changed) inkChanged(); else paintInk();
      traceInk(cancelled ? 'stroke_cancel' : 'stroke_end', { ...details, pointerType, reason, revision: ink.snapshot()?.revision ?? details.revision });
      if (changed && ['pointercancel', 'lostpointercapture', 'pointerleave', 'disabled', 'reader_clear', 'tool_change', 'pen_only'].includes(reason)) onStatus('笔输入中断，已保留刚才画出的部分；可继续书写。');
      inputEnded();
      return changed;
    }
    function appendInk(event) {
      const gesture = inkGesture;
      if (!gesture || gesture.pointerId !== event.pointerId || gesture.limited) return;
      const box = gesture.sheet.getBoundingClientRect();
      let samples = [];
      try { samples = event.getCoalescedEvents?.() || []; } catch { /* Mouse fallback has no coalesced events. */ }
      for (const sample of [...samples, event]) {
        const point = inkPoint(sample, box, gesture.geometry); if (!point) continue;
        try { ink.append(point, event.type === 'pointerup' && sample === event); }
        catch (error) { gesture.limited = true; onStatus(error.message, true); break; }
      }
      scheduleInk();
    }
    function endTouchPan() {
      if (!touchPan) return;
      const pointerId = touchPan.pointerId; touchPan = null;
      try { if (root.hasPointerCapture?.(pointerId)) root.releasePointerCapture(pointerId); } catch { /* Already released by the browser. */ }
      inputEnded();
    }
    function moveTouchPan(event) {
      if (touchPan?.pointerId !== event.pointerId || inkGesture || markupGesture) return;
      if (!Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return;
      root.scrollLeft += touchPan.x - event.clientX; root.scrollTop += touchPan.y - event.clientY;
      touchPan.x = event.clientX; touchPan.y = event.clientY;
    }
    function textCaret(sheet, x, y, nearStart = false) {
      const read = (left, top) => {
        let node, offset;
        try {
          const caret = document.caretPositionFromPoint?.(left, top);
          if (caret) { node = caret.offsetNode; offset = caret.offset; }
          else { const range = document.caretRangeFromPoint?.(left, top); node = range?.startContainer; offset = range?.startOffset; }
        } catch { return null; }
        const element = node?.nodeType === 3 ? node.parentElement : node;
        return node?.nodeType === 3 && element?.closest?.('.pdr-word,.pdf-word-gap') && sheet.contains(node) ? { node, offset } : null;
      };
      const exact = read(x, y); if (exact) return exact;
      const words = [...sheet.querySelectorAll('.pdr-word')], boxes = words.map(word => word.getBoundingClientRect());
      const point = nearestTextPosition(boxes, x, y, nearStart ? 18 : Infinity); if (!point) return null;
      const word = words[point.index], measured = read(point.x, point.y);
      if (measured && word.contains(measured.node)) return measured;
      // Some engines resolve empty page space to the layer element. Snap to
      // the nearest measured word edge rather than estimate glyph advances.
      const node = word.querySelector('.pdf-word-text')?.firstChild;
      return node?.nodeType === 3 ? { node, offset: x <= boxes[point.index].left ? 0 : node.textContent.length } : null;
    }
    function startMarkup(event, sheet) {
      event.preventDefault();
      if (selectionTimer !== null) { window.clearTimeout(selectionTimer); selectionTimer = null; }
      window.getSelection()?.removeAllRanges(); selection = null; lastSelection = ''; pendingRange = null;
      markupGesture = { pointerId: event.pointerId, pointerType: event.pointerType, sheet, anchor: textCaret(sheet, event.clientX, event.clientY, true), x: event.clientX, y: event.clientY, dragged: false };
      try { root.setPointerCapture(event.pointerId); } catch { /* A missed capture is cancelled on leaving the reader. */ }
    }
    function moveMarkup(event) {
      const gesture = markupGesture; if (!gesture || gesture.pointerId !== event.pointerId) return;
      if (!gesture.sheet.isConnected || (gesture.anchor && !gesture.anchor.node.isConnected)) { endMarkup(true); return; }
      if (!gesture.dragged && Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) < 3) return;
      gesture.dragged = true;
      const box = gesture.sheet.getBoundingClientRect();
      if (!gesture.anchor || event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) return;
      const focus = textCaret(gesture.sheet, event.clientX, event.clientY); if (!focus) return;
      const value = window.getSelection(); if (!value) return;
      try {
        value.setBaseAndExtent(gesture.anchor.node, gesture.anchor.offset, focus.node, focus.offset);
        pendingRange = value.rangeCount ? value.getRangeAt(0).cloneRange() : null;
      } catch { endMarkup(true); }
    }
    function endMarkup(cancelled = false) {
      const gesture = markupGesture; if (!gesture) return null;
      markupGesture = null;
      try { if (root.hasPointerCapture?.(gesture.pointerId)) root.releasePointerCapture(gesture.pointerId); } catch { /* Already released by the platform. */ }
      if (cancelled) { pendingRange = null; lastSelection = ''; selection = null; window.getSelection()?.removeAllRanges(); }
      inputEnded();
      return gesture;
    }
    function pointerDown(event) {
      input.observe(event);
      if (!(event.pointerType === 'touch' && (inkGesture || markupGesture))) cancelNavigation();
      if (tool === 'select' && event.button === 0 && event.isPrimary !== false) {
        const sheet = event.target.closest?.('.pdr-sheet'); if (sheet && root.contains(sheet)) nativeGesture = { pointerId: event.pointerId, sheet };
      }
      const annotating = tool === 'ink' || MARKUP_TOOLS.has(tool);
      if (event.pointerType === 'touch' && annotating) {
        event.preventDefault(); if (handledTouches.size < 32) handledTouches.add(event.pointerId);
        // A palm must not change the pen's selection, scroll position or capture.
        if (inkGesture) traceInk('input_blocked', { paperId, pointerType: 'touch', reason: 'touch_during_stroke' });
        if (inkGesture || markupGesture || touchPan || event.isPrimary === false || !paperId || !Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return;
        touchPan = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
        try { root.setPointerCapture(event.pointerId); } catch { /* Leaving the viewport cancels this pan. */ }
        return;
      }
      if (annotating && !input.accepts(event)) { event.preventDefault(); onStatus(policyRejection, true); policyRejected = true; traceInk('input_blocked', { paperId, pointerType: event.pointerType, reason: 'pen_only' }); return; }
      if (annotating) endTouchPan();
      pendingRange = null;
      if (MARKUP_TOOLS.has(tool)) {
        if (!paperId || inkGesture || markupGesture) return;
        const sheet = event.target.closest?.('.pdr-sheet'); if (!sheet || !root.contains(sheet) || sheet.dataset.loaded !== 'true') return;
        if (event.isPrimary === false || event.button !== 0) return;
        startMarkup(event, sheet); acceptedAnnotationInput(); return;
      }
      if (tool !== 'ink') return;
      if (!inkEnabled || !paperId || event.pointerType === 'touch' || event.isPrimary === false || event.button !== 0 || inkGesture) { traceInk('input_blocked', { paperId, pointerType: event.pointerType, reason: !inkEnabled ? 'disabled' : inkGesture ? 'stroke_active' : 'pointer_ineligible' }); return; }
      const sheet = event.target.closest?.('.pdr-sheet'); if (!sheet || !root.contains(sheet) || sheet.dataset.loaded !== 'true') { traceInk('input_blocked', { paperId, pointerType: event.pointerType, reason: 'page_not_ready' }); return; }
      const page = Number(sheet.dataset.pdfPage), geometry = pages[page - 1], point = inkPoint(event, sheet.getBoundingClientRect(), geometry); if (!point) return;
      event.preventDefault(); window.getSelection()?.removeAllRanges(); selection = null; lastSelection = '';
      try {
        if (!ink.start({ paperId, page }, point, { color, width: inkWidth })) return;
        acceptedAnnotationInput();
        inkGesture = { pointerId: event.pointerId, pointerType: event.pointerType, sheet, geometry, limited: false };
        try { root.setPointerCapture(event.pointerId); } catch { /* Leaving the viewport preserves the captured part instead of leaving a stuck gesture. */ }
        traceInk('stroke_start', { ...inkDetails(), pointerType: event.pointerType });
        root.focus({ preventScroll: true }); scheduleInk();
      } catch (error) { traceInk('input_blocked', { ...inkDetails(), pointerType: event.pointerType, reason: 'draft_conflict_or_limit' }); onStatus(error.message, true); }
    }
    function pointerMove(event) {
      if (event.pointerType === 'touch' && (handledTouches.has(event.pointerId) || tool === 'ink' || MARKUP_TOOLS.has(tool))) { event.preventDefault(); moveTouchPan(event); return; }
      if (markupGesture?.pointerId === event.pointerId) { input.observe(event); event.preventDefault(); moveMarkup(event); } else if (inkGesture?.pointerId === event.pointerId) { input.observe(event); event.preventDefault(); appendInk(event); }
    }
    function nativePointerEnded(event) {
      if (nativeGesture?.pointerId !== event.pointerId) return;
      if (event.type !== 'pointerup') { nativeGesture = null; inputEnded(); return; }
      if (nativeEndTimer !== null) return;
      const gesture = nativeGesture;
      nativeEndTimer = window.setTimeout(() => { nativeEndTimer = null; if (nativeGesture === gesture) { captureSelection(); nativeGesture = null; inputEnded(); } }, 0);
    }
    function pointerCancel(event) {
      // A child's lost-capture event bubbles. It must not cancel a pointer that
      // this viewport has just captured (or recaptured) for the same stroke.
      if (event.type === 'lostpointercapture' && (event.target !== root || root.hasPointerCapture?.(event.pointerId))) return;
      nativePointerEnded(event); if (touchPan?.pointerId === event.pointerId) endTouchPan();
      if (event.pointerType === 'touch') { if (event.type !== 'lostpointercapture') handledTouches.delete(event.pointerId); return; }
      if (markupGesture?.pointerId === event.pointerId) endMarkup(true);
      if (inkGesture?.pointerId === event.pointerId) endInk(false, event.type);
    }
    function pointerLeave(event) { if (root.hasPointerCapture?.(event.pointerId)) return; if (touchPan?.pointerId === event.pointerId) endTouchPan(); if (event.pointerType === 'touch') return; if (markupGesture?.pointerId === event.pointerId) endMarkup(true); if (inkGesture?.pointerId === event.pointerId) endInk(false, 'pointerleave'); }
    function undoInk() { if (!inkEnabled) return false; if (inkGesture) { endInk(true, 'undo'); return true; } const changed = ink.undo(); if (changed) inkChanged(); return changed; }
    function clearInk(expectedRevision) { if (expectedRevision !== undefined && expectedRevision !== ink.snapshot()?.revision) { traceInk('draft_clear', { ...inkDetails(), reason: 'revision_mismatch' }); return false; } const details = inkDetails(); endInk(true, 'clear'); const cleared = ink.clear(expectedRevision); if (cleared) inkChanged(); traceInk('draft_clear', { ...details, reason: cleared ? 'explicit_clear' : 'revision_mismatch' }); return cleared; }
    function restoreInkDraft(value) { const restored = ink.restore(value); if (restored) { paintInkContext(); inkChanged(); traceInk('draft_restore', inkDetails()); } return restored; }
    function setInkContext(value) { const context = ink.setContext(value); paintInkContext(); return context; }
    function setInkEnabled(value) { const next = !!value; inkEnabled = next; if (!next) { endInk(false, 'disabled'); inkEnabled = false; } }
    function setPenOnly(value) { if (value) { if (inkGesture && inkGesture.pointerType !== 'pen') endInk(false, 'pen_only'); if (markupGesture && markupGesture.pointerType !== 'pen') endMarkup(true); } return input.setPenOnly(value); }
    const current = (id, ticket) => !disposed && id === paperId && id === getPaper()?.id && ticket === generation;
    function request(action, args, valid) { const task = transport.catch(() => {}).then(() => valid() ? api(action, args) : null); transport = task.catch(() => {}); return task; }
    // zoom 1 is fit-width; wider layouts scroll horizontally. Raster density may
    // rise with zoom (capped at 4) so magnified text stays sharp within budget.
    const fitWidth = () => Math.max(1, Math.min(1100, (root.clientWidth || 664) - PADDING * 2));
    function scaleFor(page) { const geometry = pages[page - 1]; const cap = Math.min(2 * Math.max(1, zoom), 4); return Math.max(.2, Math.min(cap, layoutWidth / geometry.width * Math.min(2, window.devicePixelRatio || 1))); }
    function announce(loaded = queue.snapshot().residents.includes(active) && slots[active - 1]?.sheet.dataset.loaded === 'true') { const geometry = pages[active - 1]; if (geometry) onActivePage(active, { paperId, pageCount: pages.length, width: geometry.width, height: geometry.height, loaded }); }
    function placeholder(page, message = '滚动到这里时载入', error = false) {
      const slot = slots[page - 1]; if (!slot) return;
      if (markupGesture?.sheet === slot.sheet) endMarkup(true);
      renderedScales.delete(page); pageAnnotations.delete(page);
      overlays.forget(paperId, page);
      for (const image of slot.sheet.querySelectorAll('img')) image.removeAttribute('src');
      const note = dom('div', `pdr-placeholder${error ? ' pdr-error' : ''}`); note.append(dom('span', '', message));
      if (error) { const retry = dom('button', 'button subtle', '重试此页'); retry.type = 'button'; retry.dataset.retryPage = String(page); note.append(retry); }
      slot.sheet.replaceChildren(note); slot.sheet.dataset.loaded = 'false';
      if (ink.preview()?.paperId === paperId && ink.preview()?.page === page) paintInk();
      paintOverlays(page);
    }
    /** One invisible text run per raster word.
     *
     * The run's glyph advance is fitted to the word's own box afterwards
     * (fitWordLayer), so the selectable layer sits exactly over the raster:
     * dragging a visible word hits that word, and the highlight covers the same
     * glyphs. The separator space stays inside the run (it keeps cross-word
     * selection continuous) but outside the fitted inline box, so releasing the
     * pointer in a gap never reaches into the following word. */
    function renderWords(sheet, words, geometry) {
      const layer = dom('div', 'word-layer pdr-word-layer'); layer.dataset.pdfPage = String(geometry.page); layer.setAttribute('aria-label', `PDF 第 ${geometry.page} 页可选文字`);
      const fragment = document.createDocumentFragment(), factor = layoutWidth / geometry.width;
      let previous = null, lineLast = null;
      const flushTrailing = () => { if (!lineLast) return; const width = Math.max(6, (lineLast.y1 - lineLast.y0) * .6); fragment.append(gapRun(lineLast.x1, lineLast.x1 + width, lineLast.y0, lineLast.y1, geometry, factor)); lineLast = null; };
      for (const word of words) {
        if (!Array.isArray(word) || word.length < 5 || !word.slice(0, 4).every(Number.isFinite) || typeof word[4] !== 'string') continue;
        const [x0, y0, x1, y1, text] = word;
        if (x1 <= x0 || y1 <= y0 || x0 < -1 || y0 < -1 || x1 > geometry.width + 1 || y1 > geometry.height + 1) { previous = null; flushTrailing(); continue; }
        const span = dom('span', 'pdf-word pdr-word'); span.dataset.rect = JSON.stringify([x0, y0, x1, y1]); span.dataset.pdfPage = String(geometry.page); span.dataset.height = String(y1 - y0);
        const run = dom('i', 'pdf-word-text', text);
        span.append(run);
        Object.assign(span.style, { left: `${x0 / geometry.width * 100}%`, top: `${y0 / geometry.height * 100}%`, width: `${(x1 - x0) / geometry.width * 100}%`, height: `${(y1 - y0) / geometry.height * 100}%`, fontSize: `${(y1 - y0) * factor}px` });
        // The separator space gets its own run over the real gap. Without it a
        // pointer released between two words hits the bare layer, where the
        // browser resolves the caret to the layer instead of the previous word.
        if (previous && Math.abs(previous.y0 - y0) < .5) {
          if (x0 - previous.x1 > .5) fragment.append(gapRun(previous.x1, x0, y0, y1, geometry, factor));
        } else flushTrailing();
        fragment.append(span);
        previous = { x1, y0, y1 }; lineLast = { x1, y0, y1 };
      }
      flushTrailing();
      layer.append(fragment); sheet.append(layer); fitWordLayer(layer);
    }
    /** Fit each text run to its word box so the invisible layer matches the raster.
     * A run that cannot be measured keeps its natural width. */
    function fitWordLayer(layer) {
      if (!layer) return;
      for (const span of layer.querySelectorAll('.pdr-word')) {
        const run = span.querySelector('.pdf-word-text');
        if (!run) continue;
        const box = span.getBoundingClientRect().width, natural = textWidth(run);
        const scale = box > 0 && natural > 0 ? Math.min(4, Math.max(.25, box / natural)) : 1;
        run.style.transform = `scaleX(${scale})`;
        span.dataset.textScale = String(scale);
      }
    }
    /** A space run covering one real inter-word gap, positioned like its neighbours. */
    function gapRun(left, right, y0, y1, geometry, factor) {
      const gap = dom('span', 'pdf-word-gap', ' ');
      gap.style.left = `${left / geometry.width * 100}%`;
      gap.style.top = `${y0 / geometry.height * 100}%`;
      gap.style.width = `${(right - left) / geometry.width * 100}%`;
      gap.style.height = `${(y1 - y0) / geometry.height * 100}%`;
      gap.style.fontSize = `${(y1 - y0) * factor}px`;
      return gap;
    }
    function textWidth(run) {
      try { const range = document.createRange(); range.selectNodeContents(run); const rect = range.getBoundingClientRect(); return rect.width; } catch { return 0; }
    }
    const queue = createPageWindow({
      load: job => { const ticket = generation, scale = scaleFor(job.page); job.requestedScale = scale; return request('page', { id: job.id, page: job.page, scale }, () => current(job.id, ticket)); },
      async install(page, result, job) {
        const ticket = generation, id = paperId;
        const geometry = pages[page - 1];
        if (!result || result.page !== page || result.page_count !== pages.length || Math.abs(result.width - geometry.width) > .1 || Math.abs(result.height - geometry.height) > .1 || typeof result.image !== 'string' || result.image.length > 24 * 1024 * 1024 || !Array.isArray(result.words) || result.words.length > 20000 || (result.annotations !== undefined && (!Array.isArray(result.annotations) || result.annotations.length > 1000))) throw new Error('页面内容或尺寸已改变，请重新打开 PDF 后重试。');
        const sheet = slots[page - 1].sheet, image = dom('img', 'pdr-page-image');
        image.alt = `PDF 第 ${page} 页`; image.draggable = false; image.decoding = 'async'; image.dataset.pdfPage = String(page); image.src = `data:image/png;base64,${result.image}`;
        if (image.decode) await image.decode();
        const valid = () => current(id, ticket) && job.current();
        if (valid() && inputBusy(page)) traceInk('page_defer', { paperId: id, page, reason: 'active_input' });
        if (!await waitForInput(page, valid) || !valid()) return;
        // Decode off-DOM, then replace only between complete input gestures.
        sheet.replaceChildren(image); renderWords(sheet, result.words, geometry); sheet.dataset.loaded = 'true'; paintInk();
        // Saved annotations travel with the page payload so clicks can link the
        // raster markup to its rail entry without a second catalogue read.
        pageAnnotations.set(page, (result.annotations || []).filter(annotation => annotation && typeof annotation.id === 'string' && Array.isArray(annotation.rects) && annotation.rects.some(rect => Array.isArray(rect) && rect.length >= 4)));
        const rasterIds = (result.annotations || []).map(annotation => annotation?.id).filter(value => typeof value === 'string'), retired = overlays.forPage(id, page).filter(batch => rasterIds.includes(batch.annotation_id));
        overlays.confirm(id, page, rasterIds); paintOverlays(page); paintFocus();
        traceInk('page_install', { paperId: id, page, count: rasterIds.length });
        for (const batch of retired) traceInk('overlay_retire', { paperId: id, page, annotationId: batch.annotation_id, reason: 'raster_confirmed' });
        renderedScales.set(page, job.requestedScale);
        if (!current(id, ticket) || !sheet.contains(image)) return;
        if (page === active) { announce(true); onStatus(result.words_truncated ? '这一页的可选文字超过上限，仅显示部分文字层。' : result.words.length ? '连续滚动阅读；选中文字后可批注或提问。' : '这一页没有可选择的文字，可使用页批注。'); }
      },
      evict: page => placeholder(page),
      onError: (page, error, info) => { if (!info?.preserved) placeholder(page, `第 ${page} 页读取失败：${error.message}`, true); if (page === active) onStatus(error.message, true); },
    });
    function updateWindow(priority) {
      if (!pages.length || disposed || root.clientHeight <= 0) return;
      const next = pageAt(metrics, root.scrollTop + root.clientHeight * .35);
      if (next !== active) { active = next; announce(); }
      const busyPage = Number((inkGesture || markupGesture || nativeGesture)?.sheet.dataset.pdfPage);
      const wanted = visibleWindow(metrics, root.scrollTop, root.clientHeight, priority || jumpTarget);
      queue.want(busyPage ? [busyPage, ...wanted].slice(0, MAX_RESIDENT) : wanted);
      inputEnded();
    }
    function scroll() { if (frame !== null) return; frame = window.requestAnimationFrame(() => { frame = null; updateWindow(); }); }
    function resize() {
      if (!pages.length || root.clientWidth <= 0 || disposed) return;
      const width = Math.max(1, fitWidth() * zoom);
      if (Math.abs(width - layoutWidth) < 1) { updateWindow(); return; }
      const oldPage = pageAt(metrics, root.scrollTop), previous = metrics[oldPage - 1], fraction = previous ? (root.scrollTop - previous.top) / previous.height : 0;
      layoutWidth = width; metrics = pageMetrics(pages, width);
      for (const metric of metrics) { const slot = slots[metric.page - 1]; slot.outer.style.width = `${width}px`; slot.outer.style.height = `${metric.height}px`; slot.sheet.style.height = `${metric.height - CAPTION}px`; }
      for (const page of queue.snapshot().residents) {
        const sheet = slots[page - 1].sheet, factor = width / pages[page - 1].width;
        for (const span of sheet.querySelectorAll('.pdr-word')) span.style.fontSize = `${Number(span.dataset.height) * factor}px`;
        fitWordLayer(sheet.querySelector('.pdr-word-layer'));
      }
      if (previous) root.scrollTop = metrics[oldPage - 1].top + fraction * metrics[oldPage - 1].height;
      updateWindow();
      // Keep fit-width text sharp after expanding the pane, and release an
      // unnecessarily large raster after shrinking. Coalesce sidebar dragging.
      if (resizeTimer !== null) window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        resizeTimer = null;
        for (const page of queue.snapshot().residents) {
          const rendered = renderedScales.get(page), desired = scaleFor(page);
          if (rendered && (desired > rendered * 1.25 || desired < rendered * .65)) void refresh(page, { defer: true });
        }
      }, 120);
    }
    function clear() {
      // The draft belongs to its original paper/page, not to the disposable
      // raster window. The caller offers save/discard before leaving the page.
      endInk(false, 'reader_clear'); endMarkup(true); endTouchPan(); nativeGesture = null; cancelNavigation(); returnPosition = null; overlays.clearRasters();
      ++generation; paperId = null; jumpTarget = null; selection = null; lastSelection = ''; queue.reset(null); renderedScales.clear(); pageAnnotations.clear(); pages = []; metrics = []; slots = []; active = 1; layoutWidth = 0; layoutPromise = null; strip.replaceChildren(); root.scrollTop = 0;
      if (frame !== null) { window.cancelAnimationFrame(frame); frame = null; } if (selectionTimer !== null) { window.clearTimeout(selectionTimer); selectionTimer = null; }
      if (resizeTimer !== null) { window.clearTimeout(resizeTimer); resizeTimer = null; }
      if (flashTimer !== null) { window.clearTimeout(flashTimer); flashTimer = null; }
      if (refreshTimer !== null) { window.clearTimeout(refreshTimer); refreshTimer = null; }
      if (nativeEndTimer !== null) { window.clearTimeout(nativeEndTimer); nativeEndTimer = null; }
      dirtyPages.clear(); for (const list of refreshWaiters.values()) for (const waiter of list) waiter.resolve(false); refreshWaiters.clear(); inputEnded(); emitFocus();
    }
    async function open(paper, { page = 1 } = {}) {
      clear(); if (!paper?.id || !paper.pdf || disposed) return false;
      paperId = paper.id; queue.reset(paperId); const id = paperId, ticket = generation; onStatus('正在读取 PDF 页面尺寸…');
      const loading = dom('div', 'pdr-placeholder', '正在准备连续阅读…'); strip.append(loading);
      layoutPromise = (async () => {
        try {
          const layout = await request('page_layout', { id }, () => current(id, ticket)); if (!current(id, ticket)) return false;
          pages = validateLayout(layout); slots = pages.map(geometry => { const outer = dom('section', 'pdr-page-slot'); outer.dataset.pdfPage = String(geometry.page); outer.setAttribute('aria-label', `PDF 第 ${geometry.page} 页`); const caption = dom('div', 'pdr-page-caption', `${geometry.page} / ${pages.length}`), sheet = dom('div', 'pdr-sheet'); sheet.dataset.pdfPage = String(geometry.page); outer.append(caption, sheet); return { outer, sheet }; });
          strip.replaceChildren(...slots.map(slot => slot.outer)); paintInkContext(); for (const geometry of pages) placeholder(geometry.page);
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
      cancelNavigation();
      const id = paperId, ticket = generation;
      if (layoutPromise && !pages.length) { if (!await layoutPromise || !current(id, ticket)) return false; }
      if (!pages.length) return false;
      const page = Math.max(1, Math.min(pages.length, Math.trunc(Number(value)) || 1));
      if (markupGesture && Number(markupGesture.sheet.dataset.pdfPage) !== page) endMarkup(true);
      jumpTarget = page; active = page; root.scrollTop = Math.max(0, metrics[page - 1].top - PADDING); announce(); queue.want(visibleWindow(metrics, root.scrollTop, root.clientHeight, page));
      try { return await queue.ready(page); }
      finally { if (current(id, ticket) && jumpTarget === page) { jumpTarget = null; updateWindow(); } }
    }
    function pageVisible(page) { const metric = metrics[page - 1]; return !!metric && metric.top + metric.height > root.scrollTop && metric.top < root.scrollTop + root.clientHeight; }
    function scheduleRefresh(delay = 240) { if (!dirtyPages.size || refreshTimer !== null || disposed) return; refreshTimer = window.setTimeout(() => { refreshTimer = null; flushRefresh(); }, delay); }
    function flushRefresh() {
      if (disposed) return;
      if (inputBusy()) { for (const page of dirtyPages) if (pageVisible(page)) traceInk('page_defer', { paperId, page, reason: 'active_input' }); return; }
      for (const page of dirtyPages) {
        if (!pageVisible(page) || !queue.snapshot().wanted.includes(page)) continue;
        dirtyPages.delete(page); queue.invalidate(page, { preserve: true });
        const list = refreshWaiters.get(page) || []; refreshWaiters.delete(page);
        void queue.ready(page).then(value => { for (const waiter of list) waiter.resolve(value); }, error => { for (const waiter of list) waiter.reject(error); });
      }
    }
    async function refresh(value = active, { defer = false } = {}) {
      if (!pages.length) return false;
      const page = Math.max(1, Math.min(pages.length, Math.trunc(Number(value)) || active)); dirtyPages.add(page);
      if (defer || !pageVisible(page)) { scheduleRefresh(); return true; }
      const pending = new Promise((resolve, reject) => { const list = refreshWaiters.get(page) || []; list.push({ resolve, reject }); refreshWaiters.set(page, list); });
      flushRefresh(); return pending;
    }
    function layerOf(node) { const element = node?.nodeType === 3 ? node.parentElement : node; return element?.closest?.('.pdr-word-layer'); }
    /** The selection's slice inside one word span, or null when it cannot be built. */
    function sliceOf(range, span) {
      try {
        const bounds = document.createRange(); bounds.selectNodeContents(span);
        const slice = range.cloneRange();
        if (slice.compareBoundaryPoints(Range.START_TO_START, bounds) < 0) slice.setStart(bounds.startContainer, bounds.startOffset);
        if (slice.compareBoundaryPoints(Range.END_TO_END, bounds) > 0) slice.setEnd(bounds.endContainer, bounds.endOffset);
        return slice;
      } catch { return null; }
    }
    function captureSelection() {
      if (tool === 'note' || tool === 'ink' || markupGesture || !paperId) return;
      const live = window.getSelection();
      // A drag can end over a non-text area (past the last word of a line, a
      // caption, the page margin): Chrome then resolves the caret to the layer
      // and collapses the selection. Restore the last real range of this drag so
      // the reader keeps what it showed while dragging.
      if (live && (!live.rangeCount || live.isCollapsed) && pendingRange?.startContainer?.isConnected && pendingRange?.endContainer?.isConnected) {
        try { live.removeAllRanges(); live.addRange(pendingRange); } catch { /* keep the collapsed selection */ }
      }
      const value = window.getSelection();
      if (!value?.rangeCount || value.isCollapsed) return;
      const anchor = layerOf(value.anchorNode), focus = layerOf(value.focusNode);
      if (!anchor || !focus || !root.contains(anchor) || !root.contains(focus)) {
        if (root.contains(value.anchorNode) || root.contains(value.focusNode)) { selection = null; lastSelection = ''; onSelection(null, { intent: tool, color }); onStatus('请选择同一 PDF 页内的文字，再保存批注。', true); }
        return;
      }
      if (anchor !== focus) { selection = null; lastSelection = ''; onSelection(null, { intent: tool, color }); onStatus('选文跨越了多个 PDF 页面，请分别选择并保存每一页的批注。', true); return; }
      const page = Number(anchor.dataset.pdfPage), geometry = pages[page - 1], sheet = anchor.closest?.('.pdr-sheet');
      const range = value.getRangeAt(0), box = sheet?.getBoundingClientRect();
      if (!geometry || !box?.width || !box?.height) return;
      // Client rects describe what the reader actually dragged over, including a
      // partial word; each overlapped word box is clipped to that coverage.
      const entries = [], scaleX = geometry.width / box.width, scaleY = geometry.height / box.height;
      for (const span of anchor.children) {
        if (!value.containsNode(span, true)) continue;
        const word = span.getBoundingClientRect();
        // The slice is the exact selected part of this word; its own client
        // rectangles describe where those characters are, in any page layout.
        const slice = sliceOf(range, span);
        const text = slice ? slice.toString() : span.textContent;
        if (!text || !text.trim()) continue;
        const parts = slice && typeof slice.getClientRects === 'function'
          ? [...slice.getClientRects()].filter(rect => rect.width > 0 && rect.height > 0).map(rect => [rect.left, rect.right])
          : [];
        entries.push({ box: [word.left, word.top, word.right, word.bottom], parts, text });
      }
      const selected = clipWords(entries).map(([left, top, right, bottom, text]) => [(left - box.left) * scaleX, (top - box.top) * scaleY, (right - box.left) * scaleX, (bottom - box.top) * scaleY, text]);
      if (!selected.length) return;
      try {
        const result = mergeSelection(selected, page); if (!result.rects.length || !result.text.trim()) return;
        const digest = JSON.stringify([result.page, result.text, result.rects]); if (digest === lastSelection) return;
        lastSelection = digest; selection = { id: paperId, ...result }; onSelection(selection, { intent: tool, color });
      } catch (error) { selection = null; lastSelection = ''; onSelection(null, { intent: tool, color }); onStatus(error.message, true); }
    }
    /** Annotation hit-testing uses the same display-space rectangles as the word
     * layer, so a click that did not select text can link raster markup to its
     * rail entry. Text selection keeps priority: a non-collapsed selection never
     * activates an annotation. */
    function annotationAt(page, x, y) {
      for (const annotation of pageAnnotations.get(page) || []) for (const rect of annotation.rects) {
        if (x >= rect[0] - 2 && x <= rect[2] + 2 && y >= rect[1] - 2 && y <= rect[3] + 2) return annotation;
      }
      return null;
    }
    function emitFocus() { onFocusChange({ active: !!focusState && !focusState.loading, pending: !!focusState?.loading, focusId: focusState?.focusId || null, kind: focusState?.kind || null, canReturn: !!returnPosition }); }
    function clearFocus() {
      for (const node of root.querySelectorAll('.pdr-annotation-flash')) node.remove();
      if (flashTimer !== null) { window.clearTimeout(flashTimer); flashTimer = null; }
    }
    function cancelNavigation() {
      focusCancelled?.(); focusCancelled = null;
      ++focusSequence; jumpTarget = null; focusState = null; clearFocus(); emitFocus();
      for (const waiter of inputWaiters) if (!waiter.valid()) { inputWaiters.delete(waiter); waiter.resolve(false); }
    }
    function userNavigate(event) {
      if (event.type === 'keydown' && (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End', ' ', 'Escape'].includes(event.key) || event.target.closest?.('input,textarea,[contenteditable]'))) return;
      cancelNavigation(); updateWindow();
    }
    function paintFocus() {
      for (const node of root.querySelectorAll('.pdr-annotation-flash')) node.remove();
      if (!focusState || focusState.loading || focusState.expires <= Date.now()) return;
      const { page, rects, tint, kind, focusId } = focusState, slot = slots[page - 1], geometry = pages[page - 1]; if (!slot || !geometry) return;
      for (const rect of rects) {
        const box = dom('div', 'pdr-annotation-flash'); box.dataset.focusId = focusId; box.dataset.focusKind = kind;
        Object.assign(box.style, { left: `${rect[0] / geometry.width * 100}%`, top: `${rect[1] / geometry.height * 100}%`, width: `${(rect[2] - rect[0]) / geometry.width * 100}%`, height: `${(rect[3] - rect[1]) / geometry.height * 100}%` });
        if (tint) box.style.borderColor = tint;
        slot.sheet.append(box);
      }
    }
    function flashAnnotation(page, rects, annotation) {
      cancelNavigation(); const clipped = regionRects(rects, pages[page - 1], 1); if (!clipped.length) return;
      const sequence = focusSequence;
      focusState = { page, rects: clipped, kind: annotation?.type === 'ink' ? 'ink' : 'quote', focusId: annotation?.id || '', tint: annotationTint(annotation, 1), loading: false, expires: Date.now() + 1800 };
      paintFocus(); emitFocus(); flashTimer = window.setTimeout(() => { if (sequence === focusSequence) { focusState = null; clearFocus(); emitFocus(); } }, 1800);
    }
    function readingPosition() {
      const page = pageAt(metrics, root.scrollTop), metric = metrics[page - 1];
      return metric ? { paperId, page, fraction: (root.scrollTop - metric.top) / metric.height, horizontal: root.scrollLeft / layoutWidth, zoom } : null;
    }
    async function focusRegion(value, annotationId) {
      if (disposed || value?.paperId !== paperId || !Number.isInteger(value.page) || !pages[value.page - 1]) return false;
      const { page } = value, id = paperId, ticket = generation;
      if (!annotationId && !regionRects(value.rects, pages[page - 1]).length) return false;
      cancelNavigation(); const sequence = focusSequence, valid = () => current(id, ticket) && sequence === focusSequence;
      const cancelled = new Promise(resolve => { focusCancelled = () => resolve(false); });
      if (!returnPosition) returnPosition = readingPosition();
      focusState = { page, kind: value.kind === 'ink' ? 'ink' : 'quote', focusId: typeof value.focusId === 'string' ? value.focusId.slice(0, 256) : annotationId || '', loading: true }; emitFocus();
      try {
        if (!await waitForInput(null, valid)) return false;
        jumpTarget = page;
        const dirty = dirtyPages.delete(page);
        queue.want(visibleWindow(metrics, root.scrollTop, root.clientHeight, page));
        if (dirty) {
          queue.invalidate(page, { preserve: true });
          const list = refreshWaiters.get(page) || []; refreshWaiters.delete(page);
          void queue.ready(page).then(value => { for (const waiter of list) waiter.resolve(value); }, error => { for (const waiter of list) waiter.reject(error); });
        }
        if (!await Promise.race([queue.ready(page), cancelled]) || !valid() || !await waitForInput(null, valid)) return false;
        const annotation = annotationId ? (pageAnnotations.get(page) || []).find(item => item.id === annotationId) : null;
        const geometry = pages[page - 1], rects = regionRects(annotationId ? annotation?.rects : value.rects, geometry, value.kind === 'ink' ? 3 : 1);
        if (!rects.length) return false;
        const sheet = slots[page - 1].sheet.getBoundingClientRect(), viewport = root.getBoundingClientRect();
        const left = root.scrollLeft + sheet.left - viewport.left - (root.clientLeft || 0), top = root.scrollTop + sheet.top - viewport.top - (root.clientTop || 0);
        const x0 = left + Math.min(...rects.map(rect => rect[0])) / geometry.width * sheet.width, x1 = left + Math.max(...rects.map(rect => rect[2])) / geometry.width * sheet.width;
        const y0 = top + Math.min(...rects.map(rect => rect[1])) / geometry.height * sheet.height, y1 = top + Math.max(...rects.map(rect => rect[3])) / geometry.height * sheet.height;
        root.scrollLeft = minimumScroll(x0, x1, root.scrollLeft, root.clientWidth); root.scrollTop = minimumScroll(y0, y1, root.scrollTop, root.clientHeight);
        focusState = { ...focusState, rects, tint: annotationTint(annotation, 1), loading: false, expires: Date.now() + 1800 }; paintFocus(); emitFocus();
        flashTimer = window.setTimeout(() => { flashTimer = null; if (valid()) { focusState = null; clearFocus(); emitFocus(); } }, 1800);
        return true;
      } finally {
        if (valid()) { focusCancelled = null; jumpTarget = null; if (focusState?.loading) { focusState = null; emitFocus(); } updateWindow(); }
      }
    }
    function revealRegion(value) { return focusRegion(value); }
    function revealAnnotation(id, { page } = {}) {
      let target = Number.isInteger(page) ? page : null;
      if (target === null) for (const [number, list] of pageAnnotations) if (list.some(annotation => annotation.id === id)) { target = number; break; }
      return typeof id === 'string' ? focusRegion({ paperId, page: target, kind: 'quote', focusId: id }, id) : Promise.resolve(false);
    }
    async function returnToReadingPosition() {
      const position = returnPosition; if (!position || position.paperId !== paperId) return false;
      cancelNavigation(); const sequence = focusSequence, id = paperId, ticket = generation, valid = () => current(id, ticket) && focusSequence === sequence;
      if (!await waitForInput(null, valid)) return false;
      zoom = position.zoom; resize(); const metric = metrics[position.page - 1]; if (!metric || !valid()) return false;
      root.scrollTop = metric.top + position.fraction * metric.height; root.scrollLeft = position.horizontal * layoutWidth;
      returnPosition = null; emitFocus(); updateWindow(position.page); return true;
    }
    function pointerUp(event) {
      nativePointerEnded(event);
      if (event.pointerType === 'touch' && (handledTouches.has(event.pointerId) || tool === 'ink' || MARKUP_TOOLS.has(tool))) { event.preventDefault(); if (touchPan?.pointerId === event.pointerId) { moveTouchPan(event); endTouchPan(); } handledTouches.delete(event.pointerId); return; }
      if (markupGesture?.pointerId === event.pointerId) {
        event.preventDefault(); moveMarkup(event);
        const gesture = markupGesture; if (!gesture) return;
        const box = gesture.sheet.getBoundingClientRect(), outside = event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom;
        endMarkup(outside);
        if (outside) { if (gesture.dragged) onStatus('请在同一 PDF 页内划选文字，再保存批注。', true); return; }
        if (gesture.dragged) captureSelection();
        else activateAnnotation(gesture.sheet, event);
        return;
      }
      if (MARKUP_TOOLS.has(tool)) return;
      if (inkGesture?.pointerId === event.pointerId) { event.preventDefault(); appendInk(event); endInk(); return; }
      if (tool === 'ink') return;
      if (tool === 'note') {
        const sheet = event.target.closest?.('.pdr-sheet'); if (!sheet || !root.contains(sheet) || sheet.dataset.loaded !== 'true') return;
        const page = Number(sheet.dataset.pdfPage), geometry = pages[page - 1], box = sheet.getBoundingClientRect();
        if (!box.width || !box.height) return;
        const x = Math.max(0, Math.min(geometry.width - Math.min(20, geometry.width), (event.clientX - box.left) / box.width * geometry.width)), y = Math.max(0, Math.min(geometry.height - Math.min(20, geometry.height), (event.clientY - box.top) / box.height * geometry.height));
        onPageNote({ id: paperId, page, text: '', rects: [[x, y, Math.min(geometry.width, x + 20), Math.min(geometry.height, y + 20)]] }, { intent: 'note', color }); return;
      }
      // A plain click on saved markup links to the rail; a text selection keeps
      // its existing annotation flow instead.
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed) {
        const sheet = event.target.closest?.('.pdr-sheet');
        activateAnnotation(sheet, event);
      }
      if (selectionTimer !== null) window.clearTimeout(selectionTimer); selectionTimer = window.setTimeout(() => { selectionTimer = null; captureSelection(); }, 0);
    }
    function activateAnnotation(sheet, event) {
      if (!sheet || !root.contains(sheet) || sheet.dataset.loaded !== 'true') return;
      const page = Number(sheet.dataset.pdfPage), geometry = pages[page - 1], box = sheet.getBoundingClientRect();
      if (!geometry || !box.width || !box.height) return;
      const hit = annotationAt(page, (event.clientX - box.left) / box.width * geometry.width, (event.clientY - box.top) / box.height * geometry.height);
      if (hit) { flashAnnotation(page, hit.rects, hit); onAnnotationActivate(hit.id, { page }); }
    }
    function click(event) { const retry = event.target.closest?.('[data-retry-page]'); if (retry && root.contains(retry)) void refresh(Number(retry.dataset.retryPage)).catch(() => {}); }
    function setTool(value, nextColor) {
      if (!TOOLS.has(value)) throw new Error('Unsupported PDF annotation tool');
      const options = typeof nextColor === 'object' && nextColor !== null ? nextColor : { color: nextColor };
      if (options.color !== undefined && !/^#[0-9a-f]{6}$/i.test(options.color)) throw new Error('Annotation color must be #RRGGBB');
      if (options.width !== undefined && (!Number.isFinite(options.width) || options.width < .5 || options.width > 8)) throw new Error('手写笔宽必须在 0.5–8 之间');
      if (value !== tool) { endInk(false, 'tool_change'); endMarkup(true); endTouchPan(); nativeGesture = null; inputEnded(); }
      tool = value;
      if (options.color !== undefined) color = options.color;
      if (options.width !== undefined) inkWidth = options.width;
      if (tool === 'ink') {
        window.getSelection()?.removeAllRanges(); selection = null; pendingRange = null;
        if (selectionTimer !== null) { window.clearTimeout(selectionTimer); selectionTimer = null; }
      }
      root.dataset.tool = tool;
      // The selection must preview the colour that will be written to the PDF.
      const tint = hexTint(color, .5);
      if (tint) root.style.setProperty('--pdr-selection', tint);
      lastSelection = '';
    }
    function setZoom(value) {
      const next = Number(value);
      if (!Number.isFinite(next)) throw new Error('缩放比例无效');
      const clamped = Math.round(Math.max(.25, Math.min(4, next)) * 100) / 100;
      if (Math.abs(clamped - zoom) < .001) return zoom;
      cancelNavigation();
      zoom = clamped; resize(); return zoom;
    }
    // Clearing a browser selection must permit choosing the same passage again.
    // Keep the frozen source available while toolbar/dialog focus collapses it.
    function selectionChanged() {
      if (tool === 'ink') return;
      const value = window.getSelection();
      if (!value?.rangeCount || value.isCollapsed) { lastSelection = ''; return; }
      const anchor = layerOf(value.anchorNode), focus = layerOf(value.focusNode);
      if (!anchor || anchor !== focus || !root.contains(anchor)) return;
      // Remember the last real selection of the current drag for pointerup.
      try { pendingRange = value.getRangeAt(0).cloneRange(); } catch { pendingRange = null; }
    }
    const resizeObserver = new ResizeObserver(() => { try { resize(); } catch (error) { onStatus(error.message, true); } }); resizeObserver.observe(root);
    root.addEventListener('pointerdown', pointerDown); root.addEventListener('pointermove', pointerMove); root.addEventListener('pointercancel', pointerCancel); root.addEventListener('lostpointercapture', pointerCancel); root.addEventListener('pointerleave', pointerLeave);
    root.addEventListener('scroll', scroll, { passive: true }); root.addEventListener('pointerup', pointerUp); root.addEventListener('keyup', captureSelection); root.addEventListener('click', click); setTool('select');
    root.addEventListener('wheel', userNavigate, { passive: true }); root.addEventListener('keydown', userNavigate);
    document.addEventListener('selectionchange', selectionChanged); document.addEventListener('pointerup', nativePointerEnded); document.addEventListener('pointercancel', nativePointerEnded);
    function dispose() { clear(); disposed = true; ink.clear(); overlays.clear(); queue.dispose(); resizeObserver.disconnect(); root.removeEventListener('pointerdown', pointerDown); root.removeEventListener('pointermove', pointerMove); root.removeEventListener('pointercancel', pointerCancel); root.removeEventListener('lostpointercapture', pointerCancel); root.removeEventListener('pointerleave', pointerLeave); root.removeEventListener('scroll', scroll); root.removeEventListener('pointerup', pointerUp); root.removeEventListener('keyup', captureSelection); root.removeEventListener('click', click); root.removeEventListener('wheel', userNavigate); root.removeEventListener('keydown', userNavigate); document.removeEventListener('selectionchange', selectionChanged); document.removeEventListener('pointerup', nativePointerEnded); document.removeEventListener('pointercancel', nativePointerEnded); }
    return { open, goTo, refresh, clear, dispose, setTool, setZoom, getZoom: () => zoom, resize, revealAnnotation, revealRegion, returnToReadingPosition, getReadingReturnPosition: () => returnPosition ? { ...returnPosition } : null, setInkOverlays, getInkOverlays: () => overlays.snapshot(), getInkDraft: () => ink.snapshot(), undoInk, clearInk, restoreInkDraft, setInkContext, getInkContext: () => ink.getContext(), setInkEnabled, setPenOnly, getInputInfo: () => input.info(), isInking: () => ink.isDrawing(), getSnapshot: () => ({ paperId, page: active, pageCount: pages.length, zoom, selection: selection ? { ...selection, rects: selection.rects.map(rect => [...rect]) } : null, residentPages: queue.snapshot().residents, inFlightPage: queue.snapshot().inFlight?.page || null }) };
  }
  window.PaperPDFReader = Object.freeze({ create, createPageWindow, validateLayout, pageMetrics, pageAt, visibleWindow, mergeSelection, clipWords, joinSelection, hexTint, annotationTint, inkPoint, createInkBuffer, createInputPolicy, createInkTrace, createInkOverlays, regionRects, minimumScroll, nearestTextPosition });
})();
