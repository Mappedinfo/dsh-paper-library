'use strict';
// A bounded handwriting surface shared by annotation notes. The saved PDF is
// authoritative; host state contains only an unfinished, revision-checked draft.
window.PaperHandwritingNote = (() => {
  const WIDTH = 640, HEIGHT = 360, MAX_STROKES = 128, MAX_POINTS = 8192;
  const clone = value => JSON.parse(JSON.stringify(value));
  function validBoard(board) {
    return Number.isFinite(board?.width) && board.width > 0 && board.width <= 4096 && Number.isFinite(board?.height) && board.height > 0 && board.height <= 4096 && Array.isArray(board.strokes) && board.strokes.length <= MAX_STROKES &&
      board.strokes.reduce((sum, stroke) => sum + (stroke?.points?.length || 0), 0) <= MAX_POINTS && board.strokes.every(stroke =>
        /^#[0-9a-f]{6}$/i.test(stroke.color) && Number.isFinite(stroke.width) && stroke.width >= .5 && stroke.width <= 16 &&
        Array.isArray(stroke.points) && stroke.points.length >= 2 && stroke.points.every(point => Array.isArray(point) && point.length === 2 && point.every(Number.isFinite) && point[0] >= 0 && point[0] <= board.width && point[1] >= 0 && point[1] <= board.height));
  }
  function segmentDistance(point, a, b) {
    const dx = b[0] - a[0], dy = b[1] - a[1], length = dx * dx + dy * dy;
    const t = length ? Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / length)) : 0;
    return Math.hypot(point[0] - a[0] - t * dx, point[1] - a[1] - t * dy);
  }
  function create({ api, persistence, toast, changed = async () => {}, draftChanged = () => {}, available = () => false }) {
    const dialog = document.createElement('dialog'); dialog.id = 'handwriting-dialog'; dialog.className = 'handwriting-dialog';
    dialog.innerHTML = `<div class="dialog-heading"><div><p id="handwriting-anchor" class="eyebrow"></p><h2>手写便签</h2></div><button type="button" id="handwriting-close" class="icon-button" aria-label="关闭手写便签">×</button></div>
      <blockquote id="handwriting-quote"></blockquote>
      <div class="handwriting-tools" role="toolbar" aria-label="手写工具">
        <button type="button" id="handwriting-pen" class="button" aria-pressed="true">笔</button><button type="button" id="handwriting-eraser" class="button" aria-pressed="false">橡皮</button>
        <label>颜色 <input id="handwriting-color" type="color" value="#2455a4" aria-label="便签笔迹颜色"></label>
        <label>笔宽 <select id="handwriting-width" aria-label="便签笔宽"><option value="1">细</option><option value="2" selected>中</option><option value="4">粗</option></select></label>
        <button type="button" id="handwriting-undo" class="button" disabled>撤销</button><button type="button" id="handwriting-redo" class="button" disabled>重做</button>
      </div>
      <div class="handwriting-paper"><svg id="handwriting-canvas" viewBox="0 0 640 360" role="img" aria-label="手写便签画布，使用 Pencil 或鼠标书写"></svg></div>
      <p class="small muted">笔和鼠标写画，橡皮擦除整笔。原笔迹会随 PDF 保留。</p>
      <label class="field">识别文字 · 可校对<textarea id="handwriting-transcript" rows="3" maxlength="12000" placeholder="保存后自动识别，也可自己填写文字。"></textarea></label>
      <div class="handwriting-footer"><label><input id="handwriting-auto" type="checkbox" checked> 保存后自动转文字</label><button id="handwriting-recognize" type="button" class="button subtle">重新识别</button><button id="handwriting-new-recognition" type="button" class="button subtle" hidden title="上次识别可能已使用额度；此操作会重新调用模型。">重新发起识别</button><button id="handwriting-cancel-recognition" type="button" class="button subtle" hidden>停止等待</button></div>
      <p id="handwriting-status" class="small" role="status" aria-live="polite"></p>
      <div class="dialog-actions"><button type="button" id="handwriting-export" class="button">导出笔迹</button><button type="button" id="handwriting-reload" class="button" hidden>放弃草稿，读取 PDF</button><button type="button" id="handwriting-save" class="button primary">保存便签</button></div>`;
    document.body.append(dialog);
    const $ = id => dialog.querySelector(`#handwriting-${id}`), surface = $('canvas');
    let current = null, board = { width: WIDTH, height: HEIGHT, strokes: [] }, version = null, source = 'none', dirty = false, boardDirty = false;
    let loading = false, saving = false, recognizing = false, uncertain = null, gesture = null, tool = 'pen', undo = [], redo = [], frame = null, controller = null;
    let draftBlocked = false, readFailed = false, draftError = false, persistPending = 0, pendingRecognition = null, updatedAt = 0, heldHandoff = null;
    const keyOf = item => item.draftKey;
    function status(message, error = false) { $('status').textContent = message; $('status').classList.toggle('inline-error', error); }
    function locked() { return loading || saving || recognizing || readFailed || draftBlocked || Boolean(uncertain); }
    function sync() {
      const lock = locked(); dialog.setAttribute('aria-busy', String(loading || saving || recognizing));
      for (const name of ['pen', 'eraser', 'color', 'width', 'transcript', 'auto']) $(name).disabled = lock;
      $('undo').disabled = lock || !undo.length; $('redo').disabled = lock || !redo.length;
      $('save').disabled = loading || saving || recognizing || readFailed || draftBlocked || !current || !board.strokes.length && !version;
      $('save').textContent = uncertain ? '重试保存' : saving ? '保存中…' : '保存便签';
      $('recognize').disabled = lock || !board.strokes.length || !available(); $('cancel-recognition').hidden = !recognizing;
      $('recognize').textContent = pendingRecognition ? '检查识别结果' : '重新识别';
      $('new-recognition').hidden = !pendingRecognition || recognizing; $('new-recognition').disabled = lock || !board.strokes.length || !available();
      $('export').disabled = loading || !board.strokes.length;
      $('reload').hidden = !uncertain && !draftBlocked; $('reload').disabled = loading || saving || recognizing;
      $('pen').setAttribute('aria-pressed', String(tool === 'pen')); $('eraser').setAttribute('aria-pressed', String(tool === 'eraser'));
      surface.dataset.tool = tool; surface.classList.toggle('is-locked', lock);
    }
    function paint() {
      surface.setAttribute('viewBox', `0 0 ${board.width} ${board.height}`);
      surface.style.aspectRatio = `${board.width} / ${board.height}`;
      surface.replaceChildren();
      for (const stroke of [...board.strokes, ...(gesture?.stroke ? [gesture.stroke] : [])]) {
        const line = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
        line.setAttribute('points', stroke.points.map(point => point.join(',')).join(' ')); line.setAttribute('fill', 'none');
        line.setAttribute('stroke', stroke.color); line.setAttribute('stroke-width', String(stroke.width)); line.setAttribute('stroke-linecap', 'round'); line.setAttribute('stroke-linejoin', 'round'); surface.append(line);
      }
    }
    function schedulePaint() { if (frame === null) frame = requestAnimationFrame(() => { frame = null; paint(); }); }
    function snapshot() { return { board: clone(board), transcript: $('transcript').value, transcription_source: source, expected_version: version, boardDirty, uncertain: uncertain ? { request_id: uncertain.request_id, expected_version: uncertain.expected_version } : null, recognition: pendingRecognition, updatedAt }; }
    async function persist() {
      if (!current || draftBlocked) return;
      draftChanged();
      if (!persistence) return;
      const key = keyOf(current), value = snapshot(); persistPending++;
      try { await persistence.put(key, value); draftError = false; } catch (error) { draftError = true; status(`草稿暂存失败：${error.message}。请保存到 PDF 或导出笔迹。`, true); } finally { persistPending--; }
    }
    function edit() { dirty = true; boardDirty = true; pendingRecognition = null; updatedAt = Date.now(); sync(); void persist(); }
    function pointOf(event) { const box = surface.getBoundingClientRect(); return [Math.min(board.width, Math.round(Math.max(0, Math.min(board.width, (event.clientX - box.left) * board.width / box.width)) * 100) / 100), Math.min(board.height, Math.round(Math.max(0, Math.min(board.height, (event.clientY - box.top) * board.height / box.height)) * 100) / 100)]; }
    function erase(point) { const before = board.strokes.length; board.strokes = board.strokes.filter(stroke => !stroke.points.some((next, index) => index && segmentDistance(point, stroke.points[index - 1], next) <= 8 + stroke.width / 2)); if (board.strokes.length !== before) { gesture.changed = true; schedulePaint(); } }
    function append(event) {
      if (!gesture) return;
      const events = event.getCoalescedEvents?.() || []; if (!events.length || events.at(-1) !== event) events.push(event);
      for (const sample of events) {
        const point = pointOf(sample);
        if (gesture.erase) { erase(point); continue; }
        const points = gesture.stroke.points, count = board.strokes.reduce((sum, stroke) => sum + stroke.points.length, 0);
        if (count + points.length >= MAX_POINTS) { status('便签采样点已到上限，请先保存。', true); break; }
        if (Math.hypot(point[0] - points.at(-1)[0], point[1] - points.at(-1)[1]) >= .35) points.push(point);
      }
      schedulePaint();
    }
    function finish(cancel = false) {
      if (!gesture) return;
      const old = gesture; gesture = null;
      try { if (surface.hasPointerCapture(old.id)) surface.releasePointerCapture(old.id); } catch { /* Already cancelled by the platform. */ }
      if (cancel) board.strokes = old.before;
      else if (old.stroke) { if (old.stroke.points.length === 1) old.stroke.points.push([...old.stroke.points[0]]); board.strokes.push(old.stroke); }
      if (!cancel && (old.stroke || old.changed)) { undo.push(old.before); if (undo.length > 12) undo.shift(); redo = []; edit(); }
      paint(); sync();
    }
    surface.addEventListener('pointerdown', event => {
      if (locked() || !current || gesture || event.pointerType === 'touch' || event.isPrimary === false || ![0, 2, 5].includes(event.button)) return;
      event.preventDefault(); const eraseMode = tool === 'eraser' || event.button === 2 || event.button === 5 || Boolean(event.buttons & 32);
      if (!eraseMode && (board.strokes.length >= MAX_STROKES || board.strokes.reduce((sum, stroke) => sum + stroke.points.length, 0) >= MAX_POINTS - 1)) { status('便签已到上限，请先保存。', true); return; }
      gesture = { id: event.pointerId, before: clone(board.strokes), erase: eraseMode, changed: false, ...(!eraseMode ? { stroke: { color: $('color').value, width: Number($('width').value), points: [pointOf(event)] } } : {}) };
      surface.setPointerCapture?.(event.pointerId); if (eraseMode) erase(pointOf(event)); schedulePaint();
    });
    surface.addEventListener('pointermove', event => { if (gesture?.id === event.pointerId) { event.preventDefault(); append(event); } });
    surface.addEventListener('pointerup', event => { if (gesture?.id === event.pointerId) { event.preventDefault(); append(event); finish(); } });
    for (const name of ['pointercancel', 'lostpointercapture']) surface.addEventListener(name, event => { if (gesture?.id === event.pointerId) finish(true); });
    surface.addEventListener('contextmenu', event => event.preventDefault());
    for (const name of ['pen', 'eraser']) $(name).addEventListener('click', () => { tool = name; sync(); });
    function history(back) { if (locked() || gesture) return; const from = back ? undo : redo, to = back ? redo : undo; if (!from.length) return; to.push(clone(board.strokes)); board.strokes = from.pop(); edit(); paint(); }
    $('undo').addEventListener('click', () => history(true)); $('redo').addEventListener('click', () => history(false));
    dialog.addEventListener('keydown', event => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z' && event.target.tagName !== 'TEXTAREA') { event.preventDefault(); history(!event.shiftKey); } });
    $('transcript').addEventListener('input', () => { source = 'edited'; dirty = true; updatedAt = Date.now(); void persist(); });
    $('auto').addEventListener('change', () => { void persistence?.put('reader:handwriting-preferences', { auto: $('auto').checked }).catch(error => status(`自动识别偏好未保存：${error.message}`, true)); });
    function payload() { return { id: current.id, annotation_id: current.annotation_id, board: clone(board), transcript: $('transcript').value, transcription_source: source, expected_version: version, request_id: crypto.randomUUID() }; }
    async function write() {
      const request = uncertain || payload(); uncertain = request; updatedAt = Date.now(); saving = true; sync(); await persist();
      try {
        const result = await api('handwriting_save', request); version = result.note.version; uncertain = null; dirty = false; updatedAt = Date.now();
        await persist();
        try { await changed(current.id, current.page); status('便签已保存到 PDF，原笔迹已保留。'); }
        catch (error) { status(`便签已保存到 PDF；阅读视图刷新失败：${error.message}`, true); }
        return result;
      } catch (error) { status(`保存未确认，笔迹保留。请重试同一次保存：${error.message}`, true); throw error; }
      finally { saving = false; sync(); }
    }
    function png() {
      const canvas = document.createElement('canvas'); canvas.width = WIDTH * 2; canvas.height = HEIGHT * 2;
      const ctx = canvas.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
      const scale = Math.min(canvas.width / board.width, canvas.height / board.height); ctx.translate((canvas.width - board.width * scale) / 2, (canvas.height - board.height * scale) / 2); ctx.scale(scale, scale); ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      for (const stroke of board.strokes) { ctx.strokeStyle = stroke.color; ctx.lineWidth = stroke.width; ctx.beginPath(); stroke.points.forEach(([x, y], index) => index ? ctx.lineTo(x, y) : ctx.moveTo(x, y)); ctx.stroke(); }
      return canvas.toDataURL('image/png').split(',')[1];
    }
    async function recognize() {
      if (!available()) { status('笔迹已保留；请在 DSH 中选择支持图片的模型后识别。'); return; }
      recognizing = true; controller = new AbortController(); sync(); status('正在识别手写文字… 原笔迹已保存。');
      const request = { id: current.id, annotation_id: current.annotation_id, image: png(), request_id: pendingRecognition?.request_id || crypto.randomUUID() };
      pendingRecognition = { request_id: request.request_id }; updatedAt = Date.now(); await persist();
      try {
        const result = await api('handwriting_recognize', request, { signal: controller.signal });
        $('transcript').value = result.text; source = 'model'; dirty = true; pendingRecognition = null; boardDirty = false;
        await write(); status('文字已自动保存 · AI 识别，请校对；原笔迹继续保留。');
      } catch (error) { if (error.retry_with_new_request === true) pendingRecognition = null; status(`原笔迹已保存，转文字未完成：${error.name === 'AbortError' ? '已停止等待；可以检查本次结果。' : error.message}${pendingRecognition ? ' 也可重新发起识别，这会再次调用模型。' : ''}`, true); await persist(); }
      finally { controller = null; recognizing = false; sync(); }
    }
    async function save(forceRecognition = false) {
      if (loading || saving || recognizing || !current || !board.strokes.length && !version) return;
      finish(); const shouldRecognize = board.strokes.length && (forceRecognition || ($('auto').checked && boardDirty && source !== 'edited'));
      try {
        await write();
        if (shouldRecognize) await recognize();
        else if (boardDirty && source === 'edited') status('笔迹和校对文字已保存。如需更新文字，可点「重新识别」。');
        boardDirty = false; await persist();
      } catch { /* write() retains the exact request for safe retry. */ }
    }
    $('save').addEventListener('click', () => void save()); $('recognize').addEventListener('click', () => void save(true));
    $('new-recognition').addEventListener('click', () => { if (locked()) return; pendingRecognition = null; void save(true); });
    $('cancel-recognition').addEventListener('click', () => controller?.abort());
    async function close() { if (saving || recognizing || loading) { status('正在处理便签，请稍候；识别时可点「停止等待」。'); return; } finish(true); await persist(); if (draftError && dirty) { status('草稿尚未暂存，请先保存到 PDF；也可导出笔迹留存。', true); return; } dialog.close(); draftChanged(); }
    $('close').addEventListener('click', () => void close()); dialog.addEventListener('cancel', event => { event.preventDefault(); void close(); });
    $('reload').addEventListener('click', async () => {
      if (loading || saving || recognizing || !current) return;
      const item = current, annotation = { id: current.annotation_id, page: current.page, text: $('quote').textContent };
      try { await api('handwriting_get', { id: item.id, annotation_id: item.annotation_id }); await persistence?.reconcile(keyOf(item), null); current = null; dialog.close(); await open(item, annotation); }
      catch (error) { status(error.message, true); }
    });
    $('export').addEventListener('click', () => {
      const svg = surface.cloneNode(true); svg.removeAttribute('id'); svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg'); svg.setAttribute('width', String(board.width)); svg.setAttribute('height', String(board.height));
      const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(svg)], { type: 'image/svg+xml' }));
      const link = document.createElement('a'); link.href = url; link.download = 'handwritten-note.svg'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
    async function open(item, annotation, handoff = null) {
      if (loading || saving || recognizing) return;
      if (dialog.open) await close();
      if (dialog.open) return;
      loading = true;
      heldHandoff = handoff;
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([item.id, annotation.id])));
      current = { id: item.id, annotation_id: annotation.id, page: annotation.page };
      current.draftKey = `reader:handwriting:${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2,'0')).join('')}`;
      draftBlocked = readFailed = draftError = false; board = { width: WIDTH, height: HEIGHT, strokes: [] }; version = null; source = 'none'; dirty = boardDirty = false; uncertain = pendingRecognition = null; undo = []; redo = []; updatedAt = Date.now();
      $('transcript').value = ''; $('anchor').textContent = `第 ${annotation.page} 页 · ${annotation.type === 'highlight' ? '高亮' : annotation.type === 'underline' ? '下划线' : '批注'}`;
      $('quote').textContent = annotation.text || annotation.comment || '这条批注的手写便签'; status('正在读取便签…'); paint(); sync(); dialog.showModal();
      try {
        const preference = await persistence?.get('reader:handwriting-preferences'); if (typeof preference?.auto === 'boolean') $('auto').checked = preference.auto;
        const result = await api('handwriting_get', { id: current.id, annotation_id: current.annotation_id }), note = result.note;
        if (note) { if (!validBoard(note.board)) throw new Error('PDF 中的笔迹格式无法读取'); board = clone(note.board); version = note.version; $('transcript').value = note.transcript || ''; source = note.transcription_source || 'none'; }
        let draft = await persistence?.get(keyOf(current));
        if (handoff?.id === current.id && handoff.annotation_id === current.annotation_id && Number.isSafeInteger(handoff.updatedAt) && handoff.updatedAt >= (draft?.updatedAt || 0)) draft = handoff;
        if (draft) {
          const validVersion = value => value === null || typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
          if (!validBoard(draft.board) || typeof draft.transcript !== 'string' || draft.transcript.length > 12000 || !['none', 'model', 'edited'].includes(draft.transcription_source) || !validVersion(draft.expected_version) || draft.uncertain && !validVersion(draft.uncertain.expected_version)) throw new Error('暂存草稿格式无法读取，已保留原记录');
          if (draft.expected_version === version || draft.uncertain) {
            const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value);
            if (draft.uncertain && !uuid(draft.uncertain.request_id) || draft.recognition && !uuid(draft.recognition.request_id)) throw new Error('草稿保存标识无法读取，原记录已保留');
            board = clone(draft.board); $('transcript').value = draft.transcript; source = draft.transcription_source; version = draft.expected_version; uncertain = draft.uncertain ? { ...payload(), ...draft.uncertain } : null; pendingRecognition = draft.recognition || null; boardDirty = draft.boardDirty === true; dirty = true; updatedAt = draft.updatedAt || Date.now();
            heldHandoff = null;
            status(uncertain ? '上次保存尚未确认，请点「重试保存」。' : '已恢复便签，可继续写画。');
          } else { draftBlocked = true; status('PDF 已有更新，当前显示 PDF 中的便签；旧草稿仍保留，未覆盖。', true); }
        } else status(available() ? '在小画板写下想法，保存后自动转文字。' : '可写画和保存；自动转文字需要 DSH 中支持图片的模型。');
      } catch (error) { draftBlocked = readFailed = true; status(error.message, true); }
      finally { loading = false; paint(); sync(); draftChanged(); }
    }
    window.addEventListener('beforeunload', event => { if (gesture || saving || recognizing || persistPending || dirty && (draftBlocked || draftError)) { event.preventDefault(); event.returnValue = ''; } });
    return { open, close, isOpen: () => dialog.open, handoff: () => heldHandoff || (dialog.open && current && !loading && !draftBlocked ? { id: current.id, annotation_id: current.annotation_id, page: current.page, ...snapshot() } : null) };
  }
  return { create, validBoard, segmentDistance };
})();
