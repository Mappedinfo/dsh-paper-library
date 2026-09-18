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

  function createStore(storage) {
    const read = () => {
      try {
        const raw = storage.getItem(KEY);
        if (!raw) return { schema: 1, records: [] };
        const parsed = JSON.parse(raw);
        if (!parsed || parsed.schema !== 1 || !Array.isArray(parsed.records)) throw new Error('unexpected shape');
        return parsed;
      } catch { return { schema: 1, records: [], corrupt: true }; }
    };
    const write = state => {
      const text = JSON.stringify({ schema: 1, records: state.records });
      if (text.length > MAX_BYTES) throw Object.assign(new Error('浏览器存储接近上限，请先导出 JSON 并删除不再需要的画板。'), { code: 'BOARD_TOO_LARGE', status: 413 });
      try { storage.setItem(KEY, text); }
      catch (error) { throw Object.assign(new Error('浏览器存储写入失败，可能已满或被禁用；请先导出 JSON。'), { code: 'BOARD_STORAGE', status: 507 }); }
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

    return {
      async handle(input) {
        const state = read();
        const action = input?.action;
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
        if (action === 'board_snapshot' || action === 'board_snapshot_get') throw Object.assign(new Error('独立画板不提供对话引用；请在 DSH 插件的文献库面板中使用「放入对话」。'), { code: 'BOARD_FORBIDDEN', status: 403 });
        throw Object.assign(new Error('不支持的画板操作。'), { code: 'BOARD_INVALID', status: 400 });
      },
      exportAll() {
        const state = read();
        return { schema: 'paper-library-whiteboard.v1', exported_at: stamp(), boards: live(state).map(record => record.board) };
      },
      importAll(payload) {
        const incoming = Array.isArray(payload?.boards) ? payload.boards : Array.isArray(payload) ? payload : null;
        if (!incoming) throw Object.assign(new Error('这个 JSON 不是画板导出文件。'), { code: 'BOARD_INVALID', status: 400 });
        const state = read();
        let added = 0, renamed = 0;
        for (const value of incoming.slice(0, MAX_BOARDS)) {
          if (!value || typeof value !== 'object' || !Array.isArray(value.nodes) || !Array.isArray(value.edges)) continue;
          const taken = live(state).some(record => record.board.id === value.id);
          const id = taken || !ID.test(String(value.id ?? '')) ? nowId('b') : String(value.id);
          if (taken) renamed++;
          state.records.push({ board: { ...value, schema: 1, id, title: String(value.title ?? '导入的画板').slice(0, 200), updated_at: stamp() }, revision: '' });
          added++;
        }
        if (!added) throw Object.assign(new Error('这个 JSON 里没有可导入的画板。'), { code: 'BOARD_INVALID', status: 400 });
        for (const record of state.records) if (!record.revision) record.revision = '';
        write(state);
        return { added, renamed };
      },
      capacity() {
        try { return { bytes: (storage.getItem(KEY) ?? '').length, corrupt: read().corrupt === true }; }
        catch { return { bytes: 0, unavailable: true }; }
      },
    };
  }

  function boot() {
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
    const panel = api.create({
      root,
      api: (action, payload) => store.handle({ action, ...payload }),
      toast,
      capabilities: { libraryPapers: false, conversation: false },
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

    document.getElementById('site-export-json').addEventListener('click', () => {
      const payload = store.exportAll();
      download(`paper-library-boards-${new Date().toISOString().slice(0, 10)}.json`, new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }));
      toast(`已导出 ${payload.boards.length} 张画板；这个文件就是你的长期备份。`);
    });
    const file = document.getElementById('site-import-file');
    document.getElementById('site-import-json').addEventListener('click', () => file.click());
    file.addEventListener('change', async () => {
      const chosen = file.files?.[0];
      file.value = '';
      if (!chosen) return;
      try {
        const payload = JSON.parse(await chosen.text());
        const result = store.importAll(payload);
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
      if (corrupt) { status.textContent = '本地存储内容无法识别，已按空画板继续；请勿覆盖后先导出。'; return; }
      status.textContent = `本地已用 ${Math.round(bytes / 1024)} KiB（上限约 ${Math.round(MAX_BYTES / 1024 / 1024)} MiB）；${boardList ? boardList.options.length : 0} 张画板。`;
    };
    setInterval(report, 5000);
    if (boardList) boardList.addEventListener('change', report);
    report();

    // Open the first board immediately: a drawing page should be drawable on arrival.
    panel.open().catch(error => toast(error.message || '无法打开画板', true));
    window.addEventListener('pagehide', () => panel.dispose());
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
