import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalStateStore } from '../src/local-state.mjs';
import {
  BOARD_KEY_PREFIX, BOARD_SNAPSHOT_PREFIX, createBoardStore, renderBoardOutline, validateBoard,
} from '../src/harness/board-store.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'paper-board-'));
  const library = join(root, 'library'), home = join(root, 'home');
  await mkdir(library);
  t.after(() => rm(root, { recursive: true, force: true }));
  const localState = createLocalStateStore({ library, home });
  const hash = createHash('sha256').update(await realpath(library)).digest('hex');
  return { root, localState, store: createBoardStore({ localState }), stateDirectory: join(home, 'paper-library', hash, 'state') };
}

const paperNode = (id, overrides = {}) => ({
  id, kind: 'paper', x: 0, y: 0, w: 240, h: 120, text: 'Reading notes',
  paper: { id: 'paper_a', title: 'A synthetic paper', year: 2025, citekey: 'synth2025' }, ...overrides,
});

function board(overrides = {}) {
  return {
    id: 'b-000000000001',
    title: '合成画板', nodes: [paperNode('n-1'), { id: 'n-2', kind: 'concept', x: 320, y: 0, text: '概念节点' }],
    edges: [{ id: 'e-1', from: 'n-1', to: 'n-2', kind: 'arrow', relation: 'explains' }], ...overrides,
  };
}

test('a board round-trips through the real store with a stable summary and no model involved', async t => {
  const f = await fixture(t);
  const created = await f.store.create({ board: board() });
  assert.match(created.board.id, /^b-[a-f0-9]{12}$/);
  assert.equal(created.board.schema, 1);
  assert.equal(created.board.origin, 'user');
  assert.equal(created.board.status, 'saved');
  assert.equal(created.summary.node_count, 2);
  assert.equal(created.summary.edge_count, 1);
  assert.equal(created.summary.paper_count, 1);
  assert.equal(created.summary.ai_node_count, 0);

  const read = await f.store.read(created.board.id);
  assert.deepEqual(read.board, created.board, 'reading returns exactly what was stored');
  assert.equal(read.revision, created.revision);
  assert.match(read.outline, /# 画板：合成画板/);
  assert.match(read.outline, /\[paper\] Reading notes — 文献 paper_a（2025 · synth2025）/);
  assert.match(read.outline, /Reading notes --explains--> 概念节点/);

  const listing = await f.store.list();
  assert.equal(listing.boards.length, 1);
  assert.equal(listing.truncated, false);
  assert.deepEqual(listing.boards[0], created.summary);

  // An edge may ask for a shallower attachment, down to the 30° floor.
  const relaxed = await f.store.create({ board: board({ edges: [{ id: 'e-1', from: 'n-1', to: 'n-2', kind: 'arrow', angle: 45 }] }) });
  assert.equal(relaxed.board.edges[0].angle, 45);
  const perpendicular = await f.store.create({ board: board({ edges: [{ id: 'e-1', from: 'n-1', to: 'n-2', kind: 'arrow', angle: 90 }] }) });
  assert.equal('angle' in perpendicular.board.edges[0], false, 'perpendicular is the default and is not stored');
});

test('board validation rejects dangling, duplicated, oversized and unsupported shapes', () => {
  const cases = [
    [board({ edges: [{ id: 'e-1', from: 'n-1', to: 'n-404' }] }), /端点不在本次画板中/],
    [board({ edges: [{ id: 'e-1', from: 'n-1', to: 'n-2', angle: 20 }] }), /夹角必须是 30–90 的整数/],
    [board({ edges: [{ id: 'e-1', from: 'n-1', to: 'n-2', angle: 45.5 }] }), /夹角必须是 30–90 的整数/],
    [board({ edges: [{ id: 'e-1', from: 'n-1', to: 'n-2', angle: '90' }] }), /夹角必须是 30–90 的整数/],
    [board({ nodes: [paperNode('n-1'), paperNode('n-1', { x: 10 })] }), /重复/],
    [board({ nodes: [{ id: 'n-1', kind: 'paper', text: 'x' }] }), /缺少文献标识/],
    [board({ nodes: [{ id: 'n-1', kind: 'concept', text: 'x', paper: { id: 'paper_a' } }] }), /只有 paper 类型可以绑定文献/],
    [board({ nodes: [{ id: 'n-1', kind: 'concept', text: 'x', color: 'red' }] }), /#rrggbb/],
    [board({ nodes: [{ id: 'n-1', kind: 'concept', text: 'x', x: 1e9 }] }), /坐标范围/],
    [board({ nodes: [{ id: 'n-1', kind: 'swimlane', text: 'x' }] }), /类型不受支持/],
    [board({ nodes: [{ id: 'n-1', kind: 'concept', text: 'x', extra: 1 }] }), /不支持的字段/],
    [board({ nodes: [{ id: 'n-1', kind: 'concept', text: 'x' }], edges: [{ id: 'e-1', from: 'n-1', to: 'n-1' }] }), /不能连接同一个节点/],
    [board({ schema: 2 }), /结构版本不受支持/],
    [board({ nodes: Array.from({ length: 401 }, (_, index) => ({ id: `n-${index}`, kind: 'concept', text: 'x' })) }), /最多 400 个节点/],
    [board({ nodes: [{ id: 'n-1', kind: 'concept', text: 'x'.repeat(2001) }] }), /节点文本/],
    [board({ nodes: [{ id: 'n-1', kind: 'concept', text: 'x', origin: 'robot' }] }), /只能是 user 或 llm/],
  ];
  for (const [value, expected] of cases) assert.throws(() => validateBoard(value), expected);
  // A near-limit board is still accepted; the bound is a limit, not an off-by-one.
  assert.equal(validateBoard(board({ nodes: Array.from({ length: 400 }, (_, index) => ({ id: `n-${index}`, kind: 'concept', text: 'x' })) })).nodes.length, 400);
});

test('saving is revision-checked and a stale writer never overwrites the stored board', async t => {
  const f = await fixture(t);
  const created = await f.store.create({ board: board() });
  const first = await f.store.save({ id: created.board.id, board: board({ title: '第一版' }), expectedRevision: created.revision });
  assert.equal(first.board.title, '第一版');
  assert.notEqual(first.revision, created.revision);

  await assert.rejects(
    f.store.save({ id: created.board.id, board: board({ title: '过期写入' }), expectedRevision: created.revision }),
    error => error.code === 'STATE_CONFLICT' && error.status === 409,
  );
  assert.equal((await f.store.read(created.board.id)).board.title, '第一版', 'the saved board wins over a stale write');

  // The host stamps identity and timestamps, so a caller cannot rewrite them.
  const renamed = await f.store.save({ id: created.board.id, board: board({ title: '第二版', id: 'b-forged', created_at: '1999-01-01T00:00:00.000Z' }), expectedRevision: first.revision });
  assert.equal(renamed.board.id, created.board.id);
  assert.equal(renamed.board.created_at, created.board.created_at);
  assert.ok(Date.parse(renamed.board.updated_at) >= Date.parse(created.board.created_at));
});

test('deleting a board tombstones the record, hides it from listing and keeps it recoverable', async t => {
  const f = await fixture(t);
  const created = await f.store.create({ board: board() });
  const removed = await f.store.remove({ id: created.board.id, expectedRevision: created.revision });
  assert.equal(removed.deleted, true);

  await assert.rejects(f.store.read(created.board.id), error => error.code === 'BOARD_NOT_FOUND' && error.status === 404);
  assert.deepEqual((await f.store.list()).boards, [], 'a deleted board is not listed');
  const onDisk = JSON.parse(await readFile(join(f.stateDirectory, `${BOARD_KEY_PREFIX}${created.board.id}`.replaceAll(':', '~') + '.json'), 'utf8'));
  assert.equal(onDisk.value.deleted, true, 'the record is retained for manual recovery');
  assert.equal(onDisk.value.title, '合成画板');
  await assert.rejects(f.store.remove({ id: created.board.id, expectedRevision: created.revision }), error => error.code === 'BOARD_NOT_FOUND');
});

test('listing reports its own bounded window instead of claiming completeness', async () => {
  const records = Array.from({ length: 12 }, (_, index) => ({ key: `board:b-${index}`, value: { id: `b-${index}`, title: 't', origin: 'user', status: 'saved', nodes: [], edges: [] }, revision: 'a'.repeat(64) }));
  const calls = [];
  const store = createBoardStore({ localState: {
    get: async () => ({ value: null }),
    put: async () => { throw new Error('unused'); },
    list: async input => { calls.push(input); return { records, total: 80, offset: 0, limit: input.limit, next_offset: 12, hasMore: true, truncated: true }; },
  } });
  const listing = await store.list();
  assert.equal(calls[0].prefix, BOARD_KEY_PREFIX);
  assert.equal(calls[0].limit, 50, 'the store window is the declared listing bound');
  assert.equal(listing.boards.length, 12);
  assert.equal(listing.total, 80);
  assert.equal(listing.scanned, 12);
  assert.equal(listing.truncated, true, 'a larger archive is reported, never presented as the whole set');
});

test('a board reference freezes immutable material that an edited board never rewrites', async t => {
  const f = await fixture(t);
  const created = await f.store.create({ board: board() });
  const frozen = await f.store.snapshot({ id: created.board.id });
  assert.match(frozen.snapshot_id, /^[a-f0-9]{64}$/);
  assert.equal(frozen.board_id, created.board.id);
  assert.equal(frozen.truncated, false);
  assert.equal(frozen.characters, frozen.text.length);
  assert.equal(frozen.label, '画板 合成画板');

  // Frozen material is content-addressed and byte-stable across repeated sends.
  const again = await f.store.snapshot({ id: created.board.id });
  assert.equal(again.snapshot_id, frozen.snapshot_id);

  await f.store.save({ id: created.board.id, board: board({ title: '改名后的画板' }), expectedRevision: created.revision });
  const loaded = await f.store.snapshotLoad(frozen.snapshot_id);
  assert.equal(loaded.board_title, '合成画板');
  assert.equal(loaded.text, frozen.text, 'editing a board never rewrites material already sent');
  await assert.rejects(f.store.snapshotLoad('b'.repeat(64)), error => error.code === 'BOARD_SNAPSHOT_MISSING');
  await assert.rejects(f.store.snapshotLoad('not-a-hash'), error => error.code === 'BOARD_INVALID');

  // A tampered record is detected by recomputing the digest, not trusted.
  const key = `${BOARD_SNAPSHOT_PREFIX}${frozen.snapshot_id}`;
  const current = await f.localState.get(key);
  await f.localState.put(key, { ...current.value, text: 'tampered' }, current.revision);
  await assert.rejects(f.store.snapshotLoad(frozen.snapshot_id), error => error.code === 'BOARD_SNAPSHOT_CORRUPT');
});

test('an agent write is marked as a reviewable proposal without relabelling the reader\'s own nodes', async t => {
  const f = await fixture(t);
  const created = await f.store.create({ board: board() });

  // The agent edits one existing node and adds one of its own.
  const edited = board({
    nodes: [paperNode('n-1', { text: 'AI 改写的阅读笔记' }), { id: 'n-2', kind: 'concept', x: 320, y: 0, text: '概念节点' }, { id: 'n-3', kind: 'concept', x: 0, y: 200, text: 'AI 新增概念' }],
  });
  const written = await f.store.save({ id: created.board.id, board: edited, expectedRevision: created.revision, origin: 'llm' });
  const byId = new Map(written.board.nodes.map(node => [node.id, node]));
  assert.equal(byId.get('n-1').origin, 'llm', 'an edited node becomes a proposal');
  assert.equal(byId.get('n-3').origin, 'llm', 'a new node is a proposal');
  assert.equal(byId.get('n-2').origin, 'user', 'an untouched node keeps the reader\'s provenance');
  assert.equal(written.board.origin, 'user', 'the board still belongs to the reader');
  assert.equal(written.board.status, 'saved', 'one proposal does not put the reader\'s whole board in review');
  assert.equal(written.summary.ai_node_count, 2);

  // A board the agent creates is itself pending review until the reader saves it.
  const generated = await f.store.create({ board: board({ title: 'AI 生成画板', nodes: [paperNode('n-1'), paperNode('n-2', { x: 320 })], edges: [] }), origin: 'llm' });
  assert.equal(generated.board.origin, 'llm');
  assert.equal(generated.board.status, 'needs-review');
  assert.equal(generated.summary.ai_node_count, 2);
  const accepted = await f.store.save({ id: generated.board.id, board: generated.board, expectedRevision: generated.revision });
  assert.equal(accepted.board.status, 'saved');
  assert.equal(accepted.board.origin, 'llm', 'accepting review does not rewrite who generated the board');
});

test('a shape with no text and no paper is content, and reads by kind in the outline', async t => {
  // It used to be refused ("既没有文本也没有文献"), which made the panel delete the shape when the
  // reader clicked away — the wrong trade for a rectangle someone drew to hold a place.
  const f = await fixture(t);
  const created = await f.store.create({ board: board({ nodes: [
    { id: 'n-empty', kind: 'rect', x: 0, y: 0, w: 200, h: 120, text: '' },
    { id: 'n-named', kind: 'concept', x: 300, y: 0, text: '有名字' },
  ], edges: [] }) });
  assert.equal(created.board.nodes.length, 2, 'the unnamed shape is stored');
  assert.equal(created.board.nodes[0].text, '', 'with no invented text');
  // The outline is what the model reads, so an unnamed shape is named by its kind, not by its id.
  const outline = renderBoardOutline(created.board).text;
  assert.match(outline, /\[rect\] （空矩形）/);
  assert.equal(outline.includes('n-empty'), false, 'the opaque id is not used as a name');
  // An edge to it is still a real relation, which is the point of keeping the shape.
  const linked = await f.store.save({ id: created.board.id, board: { ...created.board, edges: [{ id: 'e-1', from: 'n-named', to: 'n-empty', kind: 'arrow' }] }, expectedRevision: created.revision });
  assert.equal(linked.board.edges.length, 1);
  assert.match(renderBoardOutline(linked.board).text, /有名字 --arrow--> （空矩形）/);
});

test('the outline is deterministic and states its own truncation', async t => {
  const f = await fixture(t);
  const created = await f.store.create({ board: board() });
  assert.equal(renderBoardOutline(created.board).text, renderBoardOutline(created.board).text);
  const bounded = renderBoardOutline(created.board, { maxCharacters: 150 });
  assert.equal(bounded.truncated, true);
  assert.match(bounded.text, /已按 150 字符预算截断：省略 \d+ 个节点、\d+ 条连线/);
  assert.ok(bounded.text.length <= 400, 'a truncated rendering stays near its budget');
  const large = await f.store.create({ board: board({ nodes: Array.from({ length: 120 }, (_, index) => ({ id: `n-${index}`, kind: 'concept', x: index * 10, y: 0, text: `节点 ${index} ${'x'.repeat(200)}` })), edges: [] }) });
  const frozen = await f.store.snapshot({ id: large.board.id });
  assert.equal(frozen.truncated, true);
  assert.ok(frozen.omitted.nodes > 0);
  assert.equal(frozen.characters, frozen.text.length);
});
