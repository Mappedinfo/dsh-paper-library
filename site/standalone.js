/* Independent whiteboard host.
 *
 * The canvas itself is `web/board.js`, shared verbatim with the DSH plugin; this file is
 * the only thing that differs: a browser-local store implementing the same action
 * contract the plugin's host provides, plus JSON and PNG export. There is no server, no
 * model and no network request; the page is a drawing surface that happens to live on a
 * static host.
 *
 * Storage honesty: browser storage is convenient, not durable. It can be cleared by the
 * browser or the user, so export matters — the footer says so, and the store reports its
 * own capacity instead of failing silently.
 */
(function () {
  'use strict';
  const KEY = 'paper-library-whiteboard.v1';
  const MAX_BOARDS = 40;
  const MAX_BYTES = 4 * 1024 * 1024;
  const FLOW_BYTES = 192 * 1024;
  const ID = /^[A-Za-z0-9_-]{1,60}$/;

  const board = () => window.PaperBoard;
  const nowId = prefix => {
    const bytes = new Uint8Array(6);
    (window.crypto ?? {}).getRandomValues?.(bytes);
    const hex = [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
    return `${prefix}-${hex || Math.random().toString(16).slice(2, 14)}`;
  };
  const stamp = () => new Date().toISOString();

  async function digest(text) {
    const subtle = window.crypto?.subtle;
    if (subtle) {
      const bytes = await subtle.digest('SHA-256', new TextEncoder().encode(text));
      return [...new Uint8Array(bytes)].map(value => value.toString(16).padStart(2, '0')).join('');
    }
    // Deterministic fallback for a host without WebCrypto: identity, not security.
    let hash = 2166136261;
    for (let index = 0; index < text.length; index++) { hash ^= text.charCodeAt(index); hash = Math.imul(hash, 16777619); }
    return (hash >>> 0).toString(16).padStart(8, '0').repeat(8);
  }

  const conflict = current => Object.assign(new Error('这个画板已在另一个标签页里改过。你的改动仍在这里，可另存为新画板。'), { code: 'STATE_CONFLICT', current });

  function createStore(storage, options = {}) {
    const validateFlow = options.validateFlow || (async value => {
      const api = await window.PaperBoardFlowLoader?.load();
      if (!api?.validateFlowWorkspace) throw new Error('paperFlow 校验器尚未加载，请稍后重试。');
      return api.validateFlowWorkspace(value);
    });
    let pending = Promise.resolve();
    const locked = task => {
      const run = () => {
        const locks = options.locks ?? window.navigator?.locks;
        return locks?.request ? locks.request(KEY, { mode: 'exclusive' }, task) : task();
      };
      const result = pending.then(run, run);
      pending = result.catch(() => {});
      return result;
    };
    const read = () => {
      let raw = null;
      try {
        raw = storage.getItem(KEY);
        if (!raw) return { schema: 1, records: [], _raw: raw };
        const parsed = JSON.parse(raw);
        if (!parsed || parsed.schema !== 1 || !Array.isArray(parsed.records) || ['flow_workspaces', 'board_annotations'].some(key => parsed[key] !== undefined && (!parsed[key] || typeof parsed[key] !== 'object' || Array.isArray(parsed[key])))) throw new Error('unexpected shape');
        return { ...parsed, _raw: raw };
      } catch { return { schema: 1, records: [], corrupt: true, _raw: raw }; }
    };
    const write = state => {
      if (state.corrupt) throw Object.assign(new Error('本地存储格式损坏，原内容已保留，请先检查备份。'), { code: 'STATE_CORRUPT', status: 500 });
      const text = JSON.stringify({ schema: 1, records: state.records, ...(state.flow_workspaces ? { flow_workspaces: state.flow_workspaces } : {}), ...(state.board_annotations ? { board_annotations: state.board_annotations } : {}) });
      if (text.length > MAX_BYTES) throw Object.assign(new Error('浏览器存储接近上限，请先导出 JSON 并删除不再需要的画板。'), { code: 'BOARD_TOO_LARGE', status: 413 });
      // 无 Web Locks 的浏览器至少在所有异步工作后复读；这不冒充跨标签事务。
      if (storage.getItem(KEY) !== state._raw) throw conflict({ value: null, revision: null });
      try { storage.setItem(KEY, text); }
      catch (error) { throw Object.assign(new Error('浏览器存储写入失败，可能已满或被禁用；请先导出 JSON。'), { code: 'BOARD_STORAGE', status: 507 }); }
      state._raw = text;
    };
    const live = state => state.records.filter(record => record?.board && record.board.deleted !== true);
    const find = (state, id) => state.records.find(record => record.board?.id === id && record.board.deleted !== true);
    const summary = value => board().outline ? {
      id: value.board.id, title: value.board.title, origin: value.board.origin, status: value.board.status,
      created_at: value.board.created_at ?? null, updated_at: value.board.updated_at ?? null,
      node_count: value.board.nodes.length, edge_count: value.board.edges.length,
      paper_count: value.board.nodes.filter(node => node.paper).length,
      ai_node_count: value.board.nodes.filter(node => node.origin === 'llm').length,
      ai_edge_count: value.board.edges.filter(edge => edge.origin === 'llm').length,
    } : null;

    async function save(state, record) {
      record.revision = await digest(JSON.stringify(record.board));
      write(state);
      return record;
    }

    const flowFailure = (message, code = 'BOARD_FLOW_INVALID', status = 400) => Object.assign(new Error(message), { code, status });
    const flowParent = (state, id) => {
      if (typeof id !== 'string' || !ID.test(id)) throw flowFailure('工作区的画板标识无效。');
      if (state.corrupt) throw flowFailure('本地存储格式损坏，原内容已保留。', 'STATE_CORRUPT', 500);
      if (!find(state, id)) throw flowFailure('工作区所属画板不存在或已删除。', 'BOARD_NOT_FOUND', 404);
    };
    const checkFlowBytes = value => {
      let text;
      try { text = JSON.stringify(value); } catch { throw flowFailure('工作区必须是可序列化的 JSON 对象。'); }
      if (typeof text !== 'string') throw flowFailure('工作区必须是 JSON 对象。');
      if (new TextEncoder().encode(text).byteLength > FLOW_BYTES) throw flowFailure('paperFlow 工作区超过 192 KiB，请拆分或导出后精简。', 'BOARD_FLOW_TOO_LARGE', 413);
    };
    const normalizedFlow = async value => {
      checkFlowBytes(value);
      let workspace;
      try { workspace = await validateFlow(value); }
      catch (error) { throw flowFailure(error.message || 'paperFlow 工作区格式无效。'); }
      checkFlowBytes(workspace);
      return workspace;
    };
    const flowRecord = (state, id) => {
      if (!Object.hasOwn(state.flow_workspaces ?? {}, id)) return null;
      const record = state.flow_workspaces[id];
      if (!record || typeof record !== 'object' || Array.isArray(record) || !Object.hasOwn(record, 'workspace') || typeof record.revision !== 'string' || !/^[a-f0-9]{64}$/.test(record.revision)) throw flowFailure('已保存工作区的记录格式损坏，原内容已保留。', 'BOARD_FLOW_CORRUPT', 500);
      return record;
    };

    async function handle(input) {
        const state = read();
        const action = input?.action;
        if (typeof action === 'string' && action.startsWith('board_annotations_')) {
          const engine = options.annotationEngine || await window.PaperBoardFlowLoader?.load();
          if (!engine?.createBoardAnnotationStore) throw flowFailure('批注组件尚未加载，请稍后重试。');
          const localState = {
            async get(key) {
              const id = key.slice('board-annotations:'.length), latest = read(); flowParent(latest, id);
              if (!Object.hasOwn(latest.board_annotations || {}, id)) return { value: null, revision: 0 };
              const record = latest.board_annotations[id];
              if (!record || !Object.hasOwn(record, 'value') || typeof record.revision !== 'string' || !/^[a-f0-9]{64}$/.test(record.revision)) throw flowFailure('已保存的画板批注记录损坏，原内容仍保留。', 'BOARD_ANNOTATION_CORRUPT', 500);
              return record;
            },
            async put(key, value, expected) {
              const id = key.slice('board-annotations:'.length), latest = read(); flowParent(latest, id);
              const record = latest.board_annotations?.[id];
              if ((record?.revision ?? 0) !== expected) throw conflict(record || { value: null, revision: 0 });
              const revision = await digest(JSON.stringify({ value, nonce: nowId('note'), at: stamp() }));
              latest.board_annotations = { ...(latest.board_annotations || {}), [id]: { value, revision } }; write(latest);
              return { value, revision };
            },
          };
          const annotations = engine.createBoardAnnotationStore({ localState, boards: { read: id => handle({ action: 'board_get', id }) }, flowStore: { get: id => handle({ action: 'board_flow_get', id }) } });
          return engine.handleBoardAnnotationRequest(annotations, input);
        }
        if (action === 'board_flow_get' || action === 'board_flow_save') {
          flowParent(state, input.id);
          const record = flowRecord(state, input.id);
          if (action === 'board_flow_get') {
            if (!record) return { id: input.id, workspace: null, revision: 0 };
            let workspace;
            try { workspace = await normalizedFlow(record.workspace); }
            catch { throw flowFailure('已保存的工作区格式损坏，原记录已保留。', 'BOARD_FLOW_CORRUPT', 500); }
            flowParent(read(), input.id);
            return { id: input.id, workspace, revision: record.revision };
          }
          const expected = input.expected_revision;
          if (expected !== 0 && !(typeof expected === 'string' && /^[a-f0-9]{64}$/.test(expected))) throw flowFailure('保存工作区必须提供 expected_revision。');
          if (expected !== (record?.revision ?? 0)) throw conflict({ value: record?.workspace ?? null, revision: record?.revision ?? 0 });
          const workspace = await normalizedFlow(input.workspace);
          const revision = await digest(JSON.stringify({ workspace, nonce: nowId('flow'), at: stamp() }));
          state.flow_workspaces = { ...(state.flow_workspaces ?? {}), [input.id]: { workspace, revision } };
          write(state);
          return { id: input.id, workspace, revision };
        }
        if (action === 'board_list') {
          const boards = live(state).map(summary).filter(Boolean);
          return { boards, scanned: state.records.length, total: state.records.length, truncated: false };
        }
        if (action === 'board_get') {
          const record = find(state, input.id);
          if (!record) throw Object.assign(new Error(`画板 ${input.id} 不存在或已删除。`), { code: 'BOARD_NOT_FOUND', status: 404 });
          return { board: record.board, revision: record.revision, outline: board().outline(record.board).text };
        }
        if (action === 'board_create') {
          if (live(state).length >= MAX_BOARDS) throw Object.assign(new Error(`独立模式最多保存 ${MAX_BOARDS} 张画板；请导出 JSON 后删除一些。`), { code: 'BOARD_TOO_LARGE', status: 413 });
          const id = nowId('b');
          const value = board().model ? { ...input.board, schema: 1, id, origin: 'user', status: 'saved', created_at: stamp(), updated_at: stamp() } : null;
          const record = { board: value, revision: '' };
          state.records.push(record);
          await save(state, record);
          return { board: record.board, revision: record.revision, summary: summary(record) };
        }
        if (action === 'board_save') {
          const record = find(state, input.id);
          if (!record) throw Object.assign(new Error(`画板 ${input.id} 不存在或已删除。`), { code: 'BOARD_NOT_FOUND', status: 404 });
          if (input.expected_revision !== record.revision) throw conflict({ value: record.board, revision: record.revision });
          record.board = { ...input.board, id: record.board.id, created_at: record.board.created_at, updated_at: stamp() };
          await save(state, record);
          return { board: record.board, revision: record.revision, summary: summary(record) };
        }
        if (action === 'board_delete') {
          const record = find(state, input.id);
          if (!record) throw Object.assign(new Error(`画板 ${input.id} 不存在或已删除。`), { code: 'BOARD_NOT_FOUND', status: 404 });
          if (input.expected_revision !== record.revision) throw conflict({ value: record.board, revision: record.revision });
          record.board = { id: record.board.id, title: record.board.title, deleted: true, deleted_at: stamp() };
          await save(state, record);
          return { id: input.id, deleted: true, revision: record.revision };
        }
        if (action === 'board_accept') {
          const record = find(state, input.id);
          if (!record) throw Object.assign(new Error(`画板 ${input.id} 不存在或已删除。`), { code: 'BOARD_NOT_FOUND', status: 404 });
          if (input.expected_revision !== record.revision) throw conflict({ value: record.board, revision: record.revision });
          const wanted = Array.isArray(input.item_ids) ? new Set(input.item_ids) : null;
          const flip = items => items.map(item => (item.origin === 'llm' && (!wanted || wanted.has(item.id)) ? { ...item, origin: 'user' } : item));
          const before = record.board;
          record.board = { ...before, nodes: flip(before.nodes), edges: flip(before.edges), updated_at: stamp() };
          const accepted = record.board.nodes.filter((node, index) => node.origin !== before.nodes[index].origin).length
            + record.board.edges.filter((edge, index) => edge.origin !== before.edges[index].origin).length;
          await save(state, record);
          return { board: record.board, revision: record.revision, summary: summary(record), accepted };
        }
        // The standalone page has no composer, so it never freezes material for one.
        if (action === 'board_snapshot' || action === 'board_snapshot_get' || action === 'board_flow_snapshot') throw Object.assign(new Error('独立画板不提供对话引用；请在 DSH 插件的文献库面板中使用「放入对话」。'), { code: 'BOARD_FORBIDDEN', status: 403 });
        throw Object.assign(new Error('不支持的画板操作。'), { code: 'BOARD_INVALID', status: 400 });
    }

    return {
      handle(input) {
        return ['board_create', 'board_save', 'board_delete', 'board_accept', 'board_flow_save', 'board_annotations_create', 'board_annotations_update', 'board_annotations_delete'].includes(input?.action) ? locked(() => handle(input)) : handle(input);
      },
      exportAll() {
        const state = read();
        const active = live(state);
        return { schema: 'paper-library-whiteboard.v1', exported_at: stamp(), boards: active.map(record => record.board),
          flow_workspaces: Object.fromEntries(active.filter(record => flowRecord(state, record.board.id)).map(record => [record.board.id, flowRecord(state, record.board.id).workspace])),
          board_annotations: Object.fromEntries(active.filter(record => state.board_annotations?.[record.board.id]).map(record => [record.board.id, state.board_annotations[record.board.id].value])) };
      },
      importAll(payload) { return locked(async () => {
        const incoming = Array.isArray(payload?.boards) ? payload.boards : Array.isArray(payload) ? payload : null;
        if (!incoming) throw Object.assign(new Error('这个 JSON 不是画板导出文件。'), { code: 'BOARD_INVALID', status: 400 });
        if (incoming.length > MAX_BOARDS) throw Object.assign(new Error(`备份超过 ${MAX_BOARDS} 张画板上限，未写入任何内容。`), { code: 'BOARD_TOO_LARGE', status: 413 });
        const state = read();
        const incomingFlows = payload?.flow_workspaces ?? {};
        const incomingNotes = payload?.board_annotations ?? {};
        if (!incomingNotes || typeof incomingNotes !== 'object' || Array.isArray(incomingNotes) || Object.keys(incomingNotes).length > MAX_BOARDS) throw flowFailure('备份中的批注映射无效。');
        if (!incomingFlows || typeof incomingFlows !== 'object' || Array.isArray(incomingFlows) || Object.keys(incomingFlows).length > MAX_BOARDS) throw flowFailure('备份中的工作区映射无效。');
        const importedIds = new Map();
        let added = 0, renamed = 0;
        for (const value of incoming.slice(0, MAX_BOARDS)) {
          if (!value || typeof value !== 'object' || !Array.isArray(value.nodes) || !Array.isArray(value.edges)) continue;
          if (live(state).length >= MAX_BOARDS) throw Object.assign(new Error(`独立模式最多保存 ${MAX_BOARDS} 张画板，请先导出并清理。`), { code: 'BOARD_TOO_LARGE', status: 413 });
          const taken = state.records.some(record => record.board?.id === value.id);
          if (importedIds.has(value.id) && (Object.hasOwn(incomingFlows, value.id) || Object.hasOwn(incomingNotes, value.id))) throw flowFailure('备份包含重复画板标识，无法确定工作区或批注归属。');
          const id = taken || !ID.test(String(value.id ?? '')) ? nowId('b') : String(value.id);
          if (taken) renamed++;
          const valueCopy = { ...value, schema: 1, id, title: String(value.title ?? '导入的画板').slice(0, 200), updated_at: stamp() };
          state.records.push({ board: valueCopy, revision: await digest(JSON.stringify(valueCopy)) });
          importedIds.set(value.id, id);
          added++;
        }
        if (!added) throw Object.assign(new Error('这个 JSON 里没有可导入的画板。'), { code: 'BOARD_INVALID', status: 400 });
        for (const [oldId, value] of Object.entries(incomingFlows)) {
          if (!ID.test(oldId) || !importedIds.has(oldId)) throw flowFailure('备份工作区没有对应的画板，未写入任何内容。');
          const workspace = await normalizedFlow(value);
          const revision = await digest(JSON.stringify({ workspace, nonce: nowId('flow'), at: stamp() }));
          state.flow_workspaces = { ...(state.flow_workspaces ?? {}), [importedIds.get(oldId)]: { workspace, revision } };
        }
        if (Object.keys(incomingNotes).length) {
          const engine = options.annotationEngine || await window.PaperBoardFlowLoader?.load();
          if (!engine?.normalizeBoardAnnotationRecord) throw flowFailure('批注校验器尚未加载，未导入任何内容。');
          for (const [oldId, value] of Object.entries(incomingNotes)) {
            if (!ID.test(oldId) || !importedIds.has(oldId)) throw flowFailure('备份批注没有对应的画板，未写入任何内容。');
            const normalized = engine.normalizeBoardAnnotationRecord(value), revision = await digest(JSON.stringify({ normalized, nonce: nowId('note'), at: stamp() }));
            state.board_annotations = { ...(state.board_annotations || {}), [importedIds.get(oldId)]: { value: normalized, revision } };
          }
        }
        write(state);
        return { added, renamed };
      }); },
      capacity() {
        try { return { bytes: (storage.getItem(KEY) ?? '').length, corrupt: read().corrupt === true }; }
        catch { return { bytes: 0, unavailable: true }; }
      },
    };
  }

  async function boot() {
    const api = window.PaperBoard;
    const root = document.getElementById('board-view');
    if (!api || !root) return;
    const toastNode = document.getElementById('toast');
    let toastTimer = null;
    const toast = (message, error = false) => {
      if (!toastNode) return;
      toastNode.textContent = message;
      toastNode.hidden = false;
      toastNode.classList.toggle('error', Boolean(error));
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => { toastNode.hidden = true; }, 3600);
    };
    let storage;
    try { storage = window.localStorage; storage.setItem(`${KEY}.probe`, '1'); storage.removeItem(`${KEY}.probe`); }
    catch { document.getElementById('site-storage-status').textContent = '浏览器禁用了本地存储：这次改动无法保存，请改用导出文件。'; }
    const store = createStore(storage ?? { getItem: () => null, setItem: () => { throw new Error('storage disabled'); }, removeItem: () => {} });
    const boardList = document.getElementById('board-select');
    let noteContext = null, noteUI, panel;
    const noteWindow = document.createElement('section'); noteWindow.className = 'board-standalone-notes'; noteWindow.hidden = true; noteWindow.setAttribute('aria-label', '画板与流程批注'); noteWindow.setAttribute('data-floating-min-layer', '1503');
    const noteHeader = document.createElement('header'), noteTitle = document.createElement('strong'), noteClose = document.createElement('button'), noteBody = document.createElement('div');
    noteTitle.textContent = '画板与流程批注'; noteClose.textContent = '×'; noteClose.type = 'button'; noteClose.setAttribute('aria-label', '关闭画板批注');
    noteClose.addEventListener('click', () => { if (noteUI?.prepareLeave()) noteWindow.hidden = true; }); noteHeader.append(noteTitle, noteClose); noteWindow.append(noteHeader, noteBody); root.append(noteWindow);
    const floatingNotes = window.PaperFloatingWindows?.attach(noteWindow);
    const updateContext = value => { noteContext = value; if (value) noteUI?.updateTarget(value.target); };
    const openNotes = async value => {
      if (!value || !await panel.prepareLeave({ annotations: false })) return;
      updateContext(value);
      if (await noteUI?.open(value.target)) { noteWindow.hidden = false; floatingNotes?.refresh(); }
    };
    noteUI = window.PaperBoardAnnotations?.create({ root: noteBody, api: async (action, payload) => {
      if (action === 'board_annotations_create' && (!await panel.prepareLeave({ annotations: false }) || noteContext?.id !== payload.id)) throw Error('画板尚未保存或已切换，批注文字仍保留。');
      return store.handle({ action, ...payload });
    }, boardId: () => noteContext?.id, target: () => noteContext?.target, toast, onFocus: async target => {
      if (target.kind === 'flow') { if (!await panel.openFlow()) return; } else if (panel.isFlowOpen()) { if (!await panel.closeFlow()) return; }
      panel.focusAnnotation(target);
    } });
    window.addEventListener('beforeunload', event => { if (noteUI?.hasDraft()) { event.preventDefault(); event.returnValue = ''; } });
    panel = api.create({
      root,
      api: (action, payload) => store.handle({ action, ...payload }),
      toast,
      capabilities: { libraryPapers: false, conversation: false },
      onCanvasContext: updateContext, onAnnotations: value => void openNotes(value), prepareAnnotationsLeave: () => noteUI?.prepareLeave() ?? true,
    });

    const download = (name, blob) => {
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = name;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    };
    const slug = () => String(panel.board()?.title ?? 'board').replace(/[\\/:*?"<>|\s]+/g, '-').slice(0, 60) || 'board';

    document.getElementById('site-export-json').addEventListener('click', async () => {
      try {
        if (await panel.prepareLeave() === false) { toast('还有未保存或冲突的改动，请先处理；可从流程窗口导出当前草稿。', true); return; }
        const payload = store.exportAll();
        download(`paper-library-boards-${new Date().toISOString().slice(0, 10)}.json`, new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }));
        toast(`已导出 ${payload.boards.length} 张画板及已保存流程；这个文件就是你的长期备份。`);
      } catch (error) { toast(error.message || '备份导出失败，当前内容已保留。', true); }
    });
    const file = document.getElementById('site-import-file');
    document.getElementById('site-import-json').addEventListener('click', () => file.click());
    file.addEventListener('change', async () => {
      const chosen = file.files?.[0];
      file.value = '';
      if (!chosen) return;
      try {
        if (await panel.prepareLeave() === false) { toast('请先处理当前画板的未保存改动或冲突。', true); return; }
        const payload = JSON.parse(await chosen.text());
        const result = await store.importAll(payload);
        await panel.refreshList();
        const first = (await store.handle({ action: 'board_list' })).boards.at(-1);
        if (first) await panel.load(first.id);
        toast(`已导入 ${result.added} 张画板${result.renamed ? `，其中 ${result.renamed} 张因标识重复另存为新画板` : ''}。`);
      } catch (error) { toast(error.message || '导入失败', true); }
    });
    document.getElementById('site-export-png').addEventListener('click', () => {
      try {
        const canvas = document.createElement('canvas');
        api.renderToCanvas(panel.board(), canvas);
        canvas.toBlob(blob => {
          if (!blob) { toast('这个浏览器无法生成 PNG。', true); return; }
          download(`${slug()}.png`, blob);
          toast('已导出当前画板的 PNG。');
        }, 'image/png');
      } catch (error) { toast(error.message || 'PNG 导出失败', true); }
    });

    const report = () => {
      if (!storage || storage.getItem === undefined) return;
      const { bytes, corrupt, unavailable } = store.capacity();
      const status = document.getElementById('site-storage-status');
      if (!status) return;
      if (unavailable) { status.textContent = '浏览器存储不可用，改动不会保存。'; return; }
      if (corrupt) { status.textContent = '本地存储内容无法识别，原内容已保留，写入已停止；请检查或恢复备份。'; return; }
      status.textContent = `本地已用 ${Math.round(bytes / 1024)} KiB（上限约 ${Math.round(MAX_BYTES / 1024 / 1024)} MiB）；${boardList ? boardList.options.length : 0} 张画板。`;
    };
    setInterval(report, 5000);
    if (boardList) boardList.addEventListener('change', report);
    report();

    /**
     * `?src=boards/foo.json` renders a board that lives in the repository as text. The file
     * is a source of truth, not a remote: it is imported once into local storage (an
     * identical board is reused instead of duplicated), and everything afterwards is the
     * reader's own editable copy.
     */
    async function loadFromUrl() {
      const params = new URLSearchParams(window.location.search);
      const src = params.get('src');
      if (!src || !/^[\w./-]+\.json$/.test(src) || src.startsWith('/') || src.includes('..')) return false;
      const content = await (await fetch(src, { cache: 'no-store' })).json();
      let style = null;
      const styleUrl = params.get('style') ?? src.replace(/\.json$/, '.style.json');
      try {
        const response = await fetch(styleUrl, { cache: 'no-store' });
        if (response.ok) style = await response.json();
      } catch { style = null; }
      const converted = window.PaperBoardSource?.fromSource(content, style ?? {});
      if (!converted) throw new Error('这个页面没有加载源文件模块。');
      const signature = JSON.stringify(converted.board.nodes.map(node => [node.text, node.x, node.y])) + JSON.stringify(converted.board.edges.map(edge => [edge.from, edge.to]));
      const existing = await store.handle({ action: 'board_list' });
      for (const summary of existing.boards) {
        const record = await store.handle({ action: 'board_get', id: summary.id });
        const same = JSON.stringify(record.board.nodes.map(node => [node.text, node.x, node.y])) + JSON.stringify(record.board.edges.map(edge => [edge.from, edge.to]));
        if (same === signature) { await panel.refreshList(); await panel.load(summary.id); status(`已打开本地副本：${src}`); return true; }
      }
      panel.applySourceTexts(JSON.stringify(content, null, 2), style ? JSON.stringify(style, null, 2) : '{}');
      await panel.flush();
      status(`已从源文件导入并由本机保存：${src}`);
      return true;
    }

    const status = message => {
      const node = document.getElementById('site-storage-status');
      if (node) node.textContent = message;
    };

    // Open the first board immediately: a drawing page should be drawable on arrival.
    await panel.open().catch(error => toast(error.message || '无法打开画板', true));
    if (new URLSearchParams(window.location.search).has('src')) {
      try { await loadFromUrl(); }
      catch (error) { toast(error.message || '无法读取 src 指向的源文件', true); }
    }
    window.addEventListener('pagehide', () => panel.dispose());
  }

  window.PaperBoardStandalone = Object.freeze({ createStore });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => void boot());
  else void boot();
})();
