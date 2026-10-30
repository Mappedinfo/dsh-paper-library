import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFetchHandler } from '../src/http.mjs';
import { createLocalStateStore } from '../src/local-state.mjs';
import { createBoardStore } from '../src/harness/board-store.mjs';
import { boardToolRequest, handleBoardRequest } from '../src/harness/board-tools.mjs';
import { registerLibraryTools, requestFromTool, TOOL_SPECS } from '../src/harness/tools.mjs';
import { resolveConfig } from '../src/harness/config.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'paper-board-api-'));
  const library = join(root, 'library'), home = join(root, 'dsh-home');
  await mkdir(library);
  t.after(() => rm(root, { recursive: true, force: true }));
  const localState = createLocalStateStore({ library, home });
  const options = { library, localStateHome: home, localState };
  return { library, home, options, localState, boards: createBoardStore({ localState }), handler: createFetchHandler(options) };
}

async function call(handler, input) {
  const response = await handler(new Request('http://127.0.0.1/api', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }));
  return { status: response.status, ...await response.json() };
}

const node = (id, extra = {}) => ({ id, kind: 'concept', x: 0, y: 0, text: extra.text ?? `节点 ${id}`, ...extra });
const board = (overrides = {}) => ({ title: 'HTTP 画板', nodes: [node('n-1'), node('n-2', { x: 300, y: 40 })], edges: [{ id: 'e-1', from: 'n-1', to: 'n-2' }], ...overrides });

test('the authenticated HTTP surface creates, reads, lists, snapshots and deletes a board', async t => {
  const f = await fixture(t);
  const status = await call(f.handler, { action: 'status' });
  assert.equal(status.result.whiteboard, true, 'the panel can detect the capability without probing');

  const associations = { papers: ['paper-unavailable'], projects: ['project-unavailable'], slides: ['pd-unavailable'] };
  const created = await call(f.handler, { action: 'board_create', board: board({ links: associations }) });
  assert.equal(created.status, 200);
  const id = created.result.board.id;
  assert.equal(created.result.board.origin, 'user', 'a browser write is a reader write');
  assert.equal(created.result.summary.node_count, 2);

  const read = await call(f.handler, { action: 'board_get', id });
  assert.equal(read.result.board.title, 'HTTP 画板');
  assert.match(read.result.outline, /节点 n-1/);
  assert.equal(read.result.revision, created.result.revision);
  assert.deepEqual(read.result.board.links, associations, 'associations are metadata and do not require a live catalog target');
  assert.equal(created.result.summary.linked_slides, 1);

  const listing = await call(f.handler, { action: 'board_list' });
  assert.equal(listing.result.boards.length, 1);
  assert.equal(listing.result.truncated, false);

  const frozen = await call(f.handler, { action: 'board_snapshot', id });
  assert.match(frozen.result.snapshot_id, /^[a-f0-9]{64}$/);
  assert.equal(frozen.result.board_id, id);
  assert.equal(frozen.result.label, '画板 HTTP 画板');

  // A stale save reports the conflict and preserves the stored board.
  const saved = await call(f.handler, { action: 'board_save', id, board: board({ title: 'HTTP 画板 v2', links: associations }), expected_revision: created.result.revision });
  assert.equal(saved.status, 200);
  const stale = await call(f.handler, { action: 'board_save', id, board: board({ title: '过期' }), expected_revision: created.result.revision });
  assert.equal(stale.status, 409);
  assert.equal(stale.code, 'STATE_CONFLICT');
  assert.equal((await call(f.handler, { action: 'board_get', id })).result.board.title, 'HTTP 画板 v2');
  assert.deepEqual((await call(f.handler, { action: 'board_get', id })).result.board.links, associations);

  const removed = await call(f.handler, { action: 'board_delete', id, expected_revision: saved.result.revision });
  assert.equal(removed.result.deleted, true);
  assert.equal((await call(f.handler, { action: 'board_get', id })).status, 404);
});

test('a browser cannot forge provenance, reach past its board namespace or skip the revision', async t => {
  const f = await fixture(t);
  // Board payloads claiming to be AI output are normalized to the caller's own provenance.
  const forged = await call(f.handler, { action: 'board_create', origin: 'llm', board: board({ origin: 'llm', status: 'needs-review' }) });
  assert.equal(forged.result.board.origin, 'user');
  assert.equal(forged.result.board.status, 'saved');
  const id = forged.result.board.id;
  assert.equal(forged.result.summary.ai_node_count, 0, 'nodes declared as llm output are still user content here');

  const noRevision = await call(f.handler, { action: 'board_save', id, board: board() });
  assert.equal(noRevision.status, 400);
  assert.match(noRevision.error, /expected_revision/);

  // A model write may not be requested over HTTP at all.
  assert.equal((await call(f.handler, { action: 'board_put', id })).status, 400);

  // The store's namespace is not exposed through the browser state API.
  for (const action of ['state_get', 'state_put']) {
    const denied = await call(f.handler, { action, key: `board:${id}`, value: { forged: true }, expected_revision: 0 });
    assert.equal(denied.status, 403, `${action} must not read or write board records directly`);
    assert.equal(denied.code, 'STATE_FORBIDDEN');
  }
});

test('the native tool reads and writes boards, and its writes are reviewable proposals', async t => {
  const f = await fixture(t);
  const tools = new Map();
  const ctx = {
    on: () => () => {},
    tools: { register: definition => { tools.set(definition.name, definition); return () => tools.delete(definition.name) } },
  };
  const dispose = registerLibraryTools(ctx, value => value, async request => request, { library: f.library, boards: f.boards }, resolveConfig({ library: f.library }));
  t.after(dispose);
  const tool = tools.get('library_board');
  assert.ok(tool, 'library_board is registered');
  const exec = args => tool.execute(args, { signal: new AbortController().signal });

  const empty = await exec({ operation: 'list', input_json: '{}' });
  assert.deepEqual(empty.boards, []);

  const generated = await exec({ operation: 'create', input_json: JSON.stringify({ title: 'AI 画板', nodes: [node('n-1'), { id: 'n-2', kind: 'paper', text: '阅读笔记', paper: { id: 'paper_a', title: 'A synthetic paper', year: 2025 } }], edges: [{ id: 'e-1', from: 'n-1', to: 'n-2', relation: 'explains' }] }) });
  assert.equal(generated.board.origin, 'llm');
  assert.equal(generated.board.status, 'needs-review');
  assert.equal(generated.summary.ai_node_count, 2, 'a generated board is entirely a proposal');
  assert.equal(generated.summary.ai_edge_count, 1);
  const id = generated.board.id;

  const read = await exec({ operation: 'get', input_json: JSON.stringify({ id }) });
  assert.equal(read.board.nodes.length, 2);
  assert.match(read.outline, /# 画板：AI 画板/);

  // The reader accepts the proposals explicitly; an auto-save alone would not.
  const savedByReader = await handleBoardRequest(f.boards, { action: 'board_save', id, board: { ...generated.board, title: '读者画板' }, expected_revision: generated.revision }, { writer: 'user' });
  assert.equal(savedByReader.board.status, 'saved');
  assert.equal(savedByReader.board.nodes[0].origin, 'llm', 'saving a board does not launder model proposals into reader content');
  const accepted = await handleBoardRequest(f.boards, { action: 'board_accept', id, expected_revision: savedByReader.revision }, { writer: 'user' });
  assert.equal(accepted.accepted, 3);
  assert.equal(accepted.summary.ai_node_count, 0);
  assert.equal(accepted.summary.ai_edge_count, 0);

  // The agent then edits one accepted node and adds one of its own.
  const updated = await exec({ operation: 'save', input_json: JSON.stringify({ id, expected_revision: accepted.revision, title: '读者画板', nodes: [...accepted.board.nodes.map(value => (value.id === 'n-1' ? { ...value, text: 'AI 改写' } : value)), node('n-3', { y: 200 })], edges: accepted.board.edges }) });
  const byId = new Map(updated.board.nodes.map(value => [value.id, value]));
  assert.equal(byId.get('n-3').origin, 'llm');
  assert.equal(byId.get('n-1').origin, 'llm', 'an edited node becomes a proposal again');
  assert.equal(byId.get('n-2').origin, 'user', 'the reader keeps authorship of untouched content');
  assert.equal(updated.board.origin, 'llm', 'the board still records that it was generated');

  const rejected = await call(f.handler, { action: 'board_accept', id, expected_revision: updated.revision });
  assert.equal(rejected.status, 200, 'the reader can accept over HTTP');
  assert.equal(rejected.result.summary.ai_node_count, 0);
  await assert.rejects(
    handleBoardRequest(f.boards, { action: 'board_accept', id, expected_revision: rejected.result.revision }, { writer: 'llm' }),
    error => error.code === 'BOARD_FORBIDDEN',
  );
  assert.equal((await call(f.handler, { action: 'board_get', id })).result.board.nodes.find(value => value.id === 'n-1').origin, 'user');

  await assert.rejects(exec({ operation: 'delete', input_json: JSON.stringify({ id }) }), /expected_revision/);
  const removed = await exec({ operation: 'delete', input_json: JSON.stringify({ id, expected_revision: rejected.result.revision }) });
  assert.equal(removed.deleted, true);

  // The tool cannot smuggle provenance or host internals through the payload.
  for (const payload of [{ origin: 'user' }, { action: 'board_create' }, { library: '/tmp/other' }, []]) {
    if (Array.isArray(payload)) assert.throws(() => boardToolRequest(TOOL_SPECS.find(spec => spec.name === 'library_board'), { operation: 'create', input_json: JSON.stringify(payload) }), /must be an object/);
    else assert.throws(() => boardToolRequest(TOOL_SPECS.find(spec => spec.name === 'library_board'), { operation: 'create', input_json: JSON.stringify(payload) }), /owned by the host/);
  }
  assert.throws(() => boardToolRequest(TOOL_SPECS.find(spec => spec.name === 'library_board'), { operation: 'rename', input_json: '{}' }), /Unsupported whiteboard operation/);
  assert.throws(() => boardToolRequest(TOOL_SPECS.find(spec => spec.name === 'library_board'), { operation: 'create', input_json: 'not json' }), /valid JSON/);
  assert.throws(() => requestFromTool(TOOL_SPECS.find(spec => spec.name === 'library_board'), { operation: 'create', input_json: `{"title":"${'x'.repeat(210 * 1024)}"}` }, {}), /210 KiB/);
  // The agent never creates conversation snapshots; only the reader does.
  await assert.rejects(handleBoardRequest(f.boards, { action: 'board_snapshot', id: 'b-000000000001' }, { writer: 'llm' }), error => error.code === 'BOARD_FORBIDDEN');
});

const flowDocument = () => ({
  schemaVersion: 1, kind: 'paper-flow-document', paper: { id: 'synthetic', title: 'HTTP 合成流程文档' },
  flows: [{ id: 'main', name: 'HTTP 合成流程', nodes: [
    { id: 'input', label: '明确输入', type: 'data', ports: { in: {}, out: { data: { type: 'sample' } } }, detail: '合成输入说明' },
    { id: 'operation', label: '明确步骤', type: 'method', ports: { in: { data: { type: 'sample' } }, out: {} }, evidence: '仅输入声明的合成依据' },
  ], edges: [{ id: 'relation', from: 'input:data', to: 'operation:data', label: '明确关系' }] }],
});

test('HTTP canvas and flow annotation CRUD persists targets with CAS and never changes source records', async t => {
  const f = await fixture(t);
  // These local-state operations remain usable with no Python executable, PDF or model backend.
  const handler = createFetchHandler({ ...f.options, python: join(f.home, 'worker-must-not-run') });
  const parent = (await call(handler, { action: 'board_create', board: board() })).result;
  const id = parent.board.id;
  const flow = await call(handler, { action: 'board_flow_save', id, workspace: flowDocument(), expected_revision: 0 });
  assert.equal(flow.status, 200);
  const originalBoard = (await call(handler, { action: 'board_get', id })).result;
  const originalFlow = (await call(handler, { action: 'board_flow_get', id })).result;
  const empty = await call(handler, { action: 'board_annotations_list', id });
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.result, { id, revision: 0, notes: [] });
  const target = { kind: 'board', node_ids: ['n-1'], x: 10.123, y: -5.789 };
  const canvas = await call(handler, { action: 'board_annotations_create', id, target, comment: '合成画布问题', label: '伪造标题', quote: '伪造原文', expected_revision: 0 });
  assert.equal(canvas.status, 200);
  assert.match(canvas.result.revision, /^[a-f0-9]{64}$/);
  assert.deepEqual(canvas.result.notes[0].target, { ...target, x: 10.12, y: -5.79 });
  assert.equal(canvas.result.notes[0].quote, '节点 n-1', 'source excerpts come from saved nodes, never caller-supplied labels');
  const flowTarget = { kind: 'flow', paper_id: 'synthetic', flow_id: 'main', node_ids: ['input', 'operation'] };
  const annotated = await call(handler, { action: 'board_annotations_create', id, target: flowTarget, comment: '合成流程问题', expected_revision: canvas.result.revision });
  assert.equal(annotated.status, 200);
  const note = annotated.result.notes[1];
  assert.deepEqual(note.target, flowTarget);
  assert.match(note.quote, /合成输入说明/);
  assert.match(note.quote, /仅输入声明的合成依据/);
  assert.equal(note.stale, false);
  const fresh = createFetchHandler({ library: f.library, localStateHome: f.home, python: join(f.home, 'worker-must-not-run') });
  assert.deepEqual((await call(fresh, { action: 'board_annotations_list', id })).result, annotated.result);
  const missingRevision = await call(fresh, { action: 'board_annotations_update', id, note_id: note.id, comment: '缺少修订' });
  assert.equal(missingRevision.status, 400);
  const conflict = await call(fresh, { action: 'board_annotations_update', id, note_id: note.id, comment: '过期修改', expected_revision: canvas.result.revision });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.code, 'STATE_CONFLICT');
  const edited = await call(fresh, { action: 'board_annotations_update', id, note_id: note.id, comment: '保存补充问题', expected_revision: annotated.result.revision });
  assert.equal(edited.status, 200);
  assert.equal(edited.result.notes[1].comment, '保存补充问题');
  assert.deepEqual(edited.result.notes[1].target, flowTarget);
  assert.equal((await call(fresh, { action: 'board_annotations_delete', id, note_id: note.id, expected_revision: annotated.result.revision })).status, 409);
  const removed = await call(fresh, { action: 'board_annotations_delete', id, note_id: note.id, expected_revision: edited.result.revision });
  assert.equal(removed.status, 200);
  assert.equal(removed.result.notes.length, 1);
  assert.deepEqual((await call(fresh, { action: 'board_get', id })).result, originalBoard);
  assert.deepEqual((await call(fresh, { action: 'board_flow_get', id })).result, originalFlow);
  assert.deepEqual(await readdir(f.library), [], 'no PDF, worker catalog, or derived library files were created');
});

test('HTTP annotations reject malformed/missing targets, preserve stale source snapshots and deny generic state bypasses', async t => {
  const f = await fixture(t);
  const parent = (await call(f.handler, { action: 'board_create', board: board() })).result;
  const id = parent.board.id;
  const saved = (await call(f.handler, { action: 'board_flow_save', id, workspace: flowDocument(), expected_revision: 0 })).result;
  const target = { kind: 'flow', paper_id: 'synthetic', flow_id: 'main', node_id: 'operation' };
  const annotated = (await call(f.handler, { action: 'board_annotations_create', id, target, comment: '保留问题', expected_revision: 0 })).result;
  for (const invalid of [
    { kind: 'flow', paper_id: 'synthetic' },
    { ...target, node_ids: ['operation'] },
    { kind: 'board', node_ids: ['n-1', 'n-1'] },
    { kind: 'board', x: 10 },
    { kind: 'board', arbitrary_source: '不得接受' },
  ]) {
    const rejected = await call(f.handler, { action: 'board_annotations_create', id, target: invalid, comment: '无效输入', expected_revision: annotated.revision });
    assert.equal(rejected.status, 400);
  }
  for (const missing of [{ kind: 'board', node_ids: ['not-present'] }, { ...target, node_id: 'not-present' }, { ...target, flow_id: 'not-present' }]) {
    const rejected = await call(f.handler, { action: 'board_annotations_create', id, target: missing, comment: '失效来源', expected_revision: annotated.revision });
    assert.equal(rejected.status, 409);
    assert.equal(rejected.code, 'BOARD_ANNOTATION_TARGET_MISSING');
  }
  for (const action of ['state_get', 'state_put']) {
    const denied = await call(f.handler, { action, key: `board-annotations:${id}`, value: { notes: [] }, expected_revision: 0 });
    assert.equal(denied.status, 403);
  }
  const changed = structuredClone(saved.workspace);
  changed.documents[0].flows[0].nodes.pop(); changed.documents[0].flows[0].edges = [];
  assert.equal((await call(f.handler, { action: 'board_flow_save', id, workspace: changed, expected_revision: saved.revision })).status, 200);
  const stale = (await call(f.handler, { action: 'board_annotations_list', id })).result;
  assert.equal(stale.notes.length, 1);
  assert.equal(stale.notes[0].stale, true);
  assert.deepEqual(stale.notes[0].target, target);
  assert.equal(stale.notes[0].quote, annotated.notes[0].quote, 'removed source does not rewrite the original quote');
  assert.equal(stale.revision, annotated.revision, 'read-time stale decoration is not a write');
  assert.deepEqual((await call(f.handler, { action: 'board_get', id })).result.board, parent.board);
});

test('HTTP serves shared annotation assets and freezes selected flow through the existing snapshot retrieval API', async t => {
  const f = await fixture(t);
  for (const name of ['board-annotations.js', 'board-annotations.css', 'board-bridge.js']) {
    const response = await f.handler(new Request(`http://127.0.0.1/${name}`));
    assert.equal(response.status, 200, name);
    assert.equal(await response.text(), await readFile(new URL(`../web/${name}`, import.meta.url), 'utf8'));
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.match(response.headers.get('content-type'), name.endsWith('.css') ? /text\/css/ : /javascript/);
  }
  const page = await f.handler(new Request('http://127.0.0.1/'));
  const html = await page.text();
  assert.match(html, /board-annotations\.js/);
  assert.match(html, /board-annotations\.css/);
  const parent = (await call(f.handler, { action: 'board_create', board: board() })).result;
  const id = parent.board.id;
  const flow = (await call(f.handler, { action: 'board_flow_save', id, workspace: flowDocument(), expected_revision: 0 })).result;
  const frozen = await call(f.handler, { action: 'board_flow_snapshot', id, paper_id: 'synthetic', flow_id: 'main', node_ids: ['operation'], expected_revision: flow.revision });
  assert.equal(frozen.status, 200);
  assert.match(frozen.result.text, /合成输入说明/);
  assert.match(frozen.result.text, /仅输入声明的合成依据/);
  assert.deepEqual(frozen.result.flow.node_ids, ['operation']);
  const readback = await call(f.handler, { action: 'board_snapshot_get', snapshot_id: frozen.result.snapshot_id });
  assert.equal(readback.status, 200);
  assert.equal(readback.result.text, frozen.result.text);
  const stale = await call(f.handler, { action: 'board_flow_snapshot', id, paper_id: 'synthetic', flow_id: 'main', node_id: 'operation', expected_revision: '0'.repeat(64) });
  assert.equal(stale.status, 409);
  const absent = await call(f.handler, { action: 'board_flow_snapshot', id, paper_id: 'synthetic', flow_id: 'missing', expected_revision: flow.revision });
  assert.equal(absent.status, 404);
  assert.deepEqual((await call(f.handler, { action: 'board_get', id })).result.board, parent.board);
});

test('HTTP corrupt flow sources fail visibly and cannot rewrite existing annotations or board content', async t => {
  const f = await fixture(t);
  const parent = (await call(f.handler, { action: 'board_create', board: board() })).result;
  const id = parent.board.id;
  const flow = (await call(f.handler, { action: 'board_flow_save', id, workspace: flowDocument(), expected_revision: 0 })).result;
  const annotated = await call(f.handler, { action: 'board_annotations_create', id, target: { kind: 'flow', paper_id: 'synthetic', flow_id: 'main', node_id: 'input' }, comment: '保留的合成批注', expected_revision: 0 });
  assert.equal(annotated.status, 200);
  const notesBefore = await f.localState.get(`board-annotations:${id}`);
  await f.localState.put(`board-flow:${id}`, { malformed: 'keep-original-for-recovery' }, flow.revision);
  const corruptBefore = await f.localState.get(`board-flow:${id}`);
  for (const input of [
    { action: 'board_annotations_list', id },
    { action: 'board_annotations_create', id, target: { kind: 'flow', paper_id: 'synthetic', flow_id: 'main', node_id: 'input' }, comment: '不能猜测失效来源', expected_revision: annotated.result.revision },
    { action: 'board_flow_snapshot', id, paper_id: 'synthetic', flow_id: 'main', expected_revision: corruptBefore.revision },
  ]) {
    const rejected = await call(f.handler, input);
    assert.equal(rejected.status, 500);
    assert.equal(rejected.code, 'BOARD_FLOW_CORRUPT');
  }
  assert.deepEqual(await f.localState.get(`board-flow:${id}`), corruptBefore);
  assert.deepEqual(await f.localState.get(`board-annotations:${id}`), notesBefore);
  assert.deepEqual((await call(f.handler, { action: 'board_get', id })).result.board, parent.board);
});
