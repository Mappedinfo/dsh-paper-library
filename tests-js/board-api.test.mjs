import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
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

  const created = await call(f.handler, { action: 'board_create', board: board() });
  assert.equal(created.status, 200);
  const id = created.result.board.id;
  assert.equal(created.result.board.origin, 'user', 'a browser write is a reader write');
  assert.equal(created.result.summary.node_count, 2);

  const read = await call(f.handler, { action: 'board_get', id });
  assert.equal(read.result.board.title, 'HTTP 画板');
  assert.match(read.result.outline, /节点 n-1/);
  assert.equal(read.result.revision, created.result.revision);

  const listing = await call(f.handler, { action: 'board_list' });
  assert.equal(listing.result.boards.length, 1);
  assert.equal(listing.result.truncated, false);

  const frozen = await call(f.handler, { action: 'board_snapshot', id });
  assert.match(frozen.result.snapshot_id, /^[a-f0-9]{64}$/);
  assert.equal(frozen.result.board_id, id);
  assert.equal(frozen.result.label, '画板 HTTP 画板');

  // A stale save reports the conflict and preserves the stored board.
  const saved = await call(f.handler, { action: 'board_save', id, board: board({ title: 'HTTP 画板 v2' }), expected_revision: created.result.revision });
  assert.equal(saved.status, 200);
  const stale = await call(f.handler, { action: 'board_save', id, board: board({ title: '过期' }), expected_revision: created.result.revision });
  assert.equal(stale.status, 409);
  assert.equal(stale.code, 'STATE_CONFLICT');
  assert.equal((await call(f.handler, { action: 'board_get', id })).result.board.title, 'HTTP 画板 v2');

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
