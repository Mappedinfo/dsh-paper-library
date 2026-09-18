import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalStateStore } from '../src/local-state.mjs';
import { createBoardStore } from '../src/harness/board-store.mjs';
import {
  boardReferenceBodyHash, boardReferenceSource, boardReferenceToken, loggedBoardReference,
  parseBoardReference, prepareBoardReferenceMessages,
} from '../src/harness/board-references.mjs';
import {
  boardReferenceInsert, boardReferenceToken as clientToken, createBoardReferences, draftBoardReferences,
} from '../src/client/board-references.mjs';
import { appendConversationDraft, createConversationBridge } from '../src/client/conversation-context.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'paper-board-ref-'));
  const library = join(root, 'library');
  await mkdir(library);
  t.after(() => rm(root, { recursive: true, force: true }));
  const localState = createLocalStateStore({ library, home: join(root, 'home') });
  const boards = createBoardStore({ localState });
  const created = await boards.create({ board: { title: '技术路线', nodes: [{ id: 'n-1', kind: 'concept', x: 0, y: 0, w: 200, h: 100, text: '城市感知' }, { id: 'n-2', kind: 'paper', x: 300, y: 0, w: 260, h: 120, text: 'A synthetic paper', paper: { id: 'paper_a', title: 'A synthetic paper', year: 2025 } }], edges: [{ id: 'e-1', from: 'n-1', to: 'n-2', relation: 'explains' }] } });
  const frozen = await boards.snapshot({ id: created.board.id });
  return { boards, board: created.board, frozen };
}

const userMessage = text => ({ source: { kind: 'user' }, content: [{ type: 'text', text }] });
const textOf = message => message.content.filter(block => block.type === 'text').map(block => block.text).join('\n');

test('the host expands a board token into frozen material with plugin provenance', async t => {
  const f = await fixture(t);
  const token = boardReferenceToken(f.board.id, f.frozen.snapshot_id);
  assert.match(token, /^\[\[paper-library-board:v1:b-[a-f0-9]{12}:[a-f0-9]{64}\]\]$/);
  assert.deepEqual(parseBoardReference(token), { boardId: f.board.id, snapshot_id: f.frozen.snapshot_id, ref: token });
  assert.equal(parseBoardReference('[[paper-library-board:v1:nope:short]]'), null);
  assert.deepEqual(parseBoardReference(null), null);
  assert.throws(() => boardReferenceToken('bad id', f.frozen.snapshot_id), /画板引用标识无效/);
  assert.throws(() => boardReferenceToken(f.board.id, 'not-a-hash'), /快照无效/);

  const prepared = await prepareBoardReferenceMessages([userMessage(`请比较这些方向：\n${token}`)], { boards: f.boards });
  assert.equal(prepared.length, 2, 'the draft plus one material message');
  assert.equal(textOf(prepared[0]), '请比较这些方向：\n〔引用画板 技术路线〕');
  assert.equal(prepared[0].content[0].text.includes('[[paper-library-board:'), false, 'no raw token survives into the model context');
  const source = prepared[1].source;
  assert.deepEqual(source.kind, 'plugin');
  assert.equal(source.plugin, 'Paper Library');
  assert.equal(source.paperLibraryBoard.board_id, f.board.id);
  assert.equal(source.paperLibraryBoard.snapshot_id, f.frozen.snapshot_id);
  assert.equal(source.paperLibraryBoard.body_hash, boardReferenceBodyHash(f.frozen.text));
  assert.equal(textOf(prepared[1]), f.frozen.text, 'the model receives the frozen outline, not the draft text');
  // The provenance is verifiable from the logged message alone.
  const logged = loggedBoardReference({ type: 'user/message', data: { source, content: prepared[1].content } });
  assert.equal(logged.board_title, '技术路线');
  assert.equal(loggedBoardReference({ type: 'user/message', data: { source, content: [{ type: 'text', text: 'tampered' }] } }), null);
});

test('a board reference is bounded and every malformed shape fails loudly', async t => {
  const f = await fixture(t);
  const token = boardReferenceToken(f.board.id, f.frozen.snapshot_id);
  const other = await f.boards.create({ board: { title: '另一张', nodes: [{ id: 'n-1', kind: 'concept', x: 0, y: 0, w: 100, h: 60, text: 'x' }], edges: [] } });
  const otherFrozen = await f.boards.snapshot({ id: other.board.id });

  // Untouched messages and non-user messages pass straight through.
  const assistant = { source: { kind: 'assistant' }, content: [{ type: 'text', text: token }] };
  const plain = userMessage('没有引用');
  const untouched = await prepareBoardReferenceMessages([assistant, plain], { boards: f.boards });
  assert.deepEqual(untouched, [assistant, plain]);

  await assert.rejects(prepareBoardReferenceMessages([userMessage(`前面 [[paper-library-board:v1:${f.board.id}:truncated`)], { boards: f.boards }), /画板引用格式无效/);
  await assert.rejects(prepareBoardReferenceMessages([userMessage(`引用 [[paper-library-board:v1:${f.board.id}:${'a'.repeat(64)}]]`)], { boards: f.boards }), /已不存在/);
  // Identity that disagrees with the snapshot is refused rather than silently resolved.
  await assert.rejects(prepareBoardReferenceMessages([userMessage(`引用 ${clientToken('b-otherboard', f.frozen.snapshot_id)}`)], { boards: f.boards }), /与快照不一致/);
  // The character budget is enforced before anything is assembled.
  await assert.rejects(prepareBoardReferenceMessages([userMessage(`引用 ${token}`)], { boards: f.boards, maxCharacters: 5 }), /超过 5 字符预算/);
  // At most four groups per turn: five distinct snapshots are refused.
  const others = [];
  for (let index = 0; index < 4; index++) {
    const extra = await f.boards.create({ board: { title: `画板 ${index}`, nodes: [{ id: 'n-1', kind: 'concept', x: 0, y: 0, w: 100, h: 60, text: `x${index}` }], edges: [] } });
    others.push(await f.boards.snapshot({ id: extra.board.id }));
  }
  const five = [f.frozen, ...others].map(snapshot => clientToken(snapshot.board_id, snapshot.snapshot_id));
  await assert.rejects(prepareBoardReferenceMessages([userMessage(five.join('\n'))], { boards: f.boards }), /最多引用 4 张画板/);
  // A host without board storage cannot resolve a reference.
  await assert.rejects(prepareBoardReferenceMessages([userMessage(token)], {}), /需要本机的画板存储/);
  // Two references in one turn fit the budget and both arrive as separate material.
  const two = await prepareBoardReferenceMessages([userMessage(`比较 ${token} 与 ${clientToken(other.board.id, otherFrozen.snapshot_id)}`)], { boards: f.boards });
  assert.equal(two.length, 3);
  assert.equal(two.filter(message => message.source?.paperLibraryBoard).length, 2);
  assert.match(textOf(two[0]), /〔引用画板 技术路线〕/);
  assert.match(textOf(two[0]), /〔引用画板 另一张〕/);
});

test('the chip codec carries identity only and its preview reads the frozen snapshot', async t => {
  const f = await fixture(t);
  const token = clientToken(f.board.id, f.frozen.snapshot_id);
  assert.throws(() => boardReferenceInsert({ ref: 'nonsense', label: 'x', clipboardText: 'nonsense' }), /无效/);
  assert.throws(() => boardReferenceInsert({ ref: token, label: '  ', clipboardText: token }), /无效/);
  assert.throws(() => boardReferenceInsert({ ref: token, label: 'x', clipboardText: 'other' }), /无效/);
  const insert = boardReferenceInsert({ ref: token, label: '画板：技术路线', clipboardText: token });
  assert.deepEqual(insert, { source: 'paper-library-boards', ref: token, label: '画板：技术路线', clipboardText: token });

  const draft = `引用画板：技术路线\n${token}`;
  assert.deepEqual(draftBoardReferences(draft), [{ boardId: f.board.id, snapshot_id: f.frozen.snapshot_id, ref: token }]);
  assert.deepEqual(draftBoardReferences('no reference'), []);
  assert.equal(draftBoardReferences(`${token} ${token}`).length, 1, 'a repeated token is one identity');
  assert.equal(draftBoardReferences(null).length, 0);

  const requests = [];
  const window = {
    fetch: async (url, options) => {
      requests.push(JSON.parse(options.body));
      return { ok: true, headers: { get: () => null }, text: async () => JSON.stringify({ ok: true, result: { ...f.frozen } }) };
    },
  };
  const references = createBoardReferences({ window });
  try {
    // The `@` menu only offers identities this session actually placed.
    assert.deepEqual(await references.source.candidates({ sessionId: 's-1' }, { query: '', signal: new AbortController().signal }), []);
    references.remember('s-1', { ref: token, label: '画板：技术路线', clipboardText: token });
    const candidates = await references.source.candidates({ sessionId: 's-1' }, { query: '路线', signal: new AbortController().signal });
    assert.deepEqual(candidates, [{ name: '画板：技术路线', value: token }]);
    assert.deepEqual(await references.source.candidates({ sessionId: 's-2' }, { query: '', signal: new AbortController().signal }), [], 'another session sees nothing');
    assert.deepEqual(references.source.onPick({ session: { sessionId: 's-1' }, candidate: { value: token } }), { insert: { source: 'paper-library-boards', ref: token, label: '画板：技术路线', clipboardText: token } });
    assert.equal(references.source.onPick({ session: { sessionId: 's-2' }, candidate: { value: token } }), undefined);
    assert.equal(await references.source.codec.serialize(token, new AbortController().signal), token);
    assert.equal(references.source.codec.clipboardText(token), token);
    await assert.rejects(references.source.codec.serialize('nope', new AbortController().signal), /无效/);

    assert.equal(references.source.openReference({ sessionId: 's-1' }, { ref: token }), true);
    assert.equal(references.source.openReference({ sessionId: 's-1' }, { ref: 'nope' }), false);
    for (let i = 0; i < 8 && !references.getSnapshot()?.snapshot; i++) await Promise.resolve();
    assert.equal(references.getSnapshot().snapshot.text, f.frozen.text);
    assert.deepEqual(requests, [{ action: 'board_snapshot_get', snapshot_id: f.frozen.snapshot_id }], 'preview reads the frozen record only');
    assert.equal(references.source.order, 30);
    assert.equal(references.source.name, 'paper-library-boards');

    // A snapshot that disagrees with the chip identity is reported, never displayed.
    const mismatched = createBoardReferences({ window: { fetch: async () => ({ ok: true, headers: { get: () => null }, text: async () => JSON.stringify({ ok: true, result: { ...f.frozen, board_id: 'b-other' } }) }) } });
    try {
      mismatched.remember('s-1', { ref: token, label: 'x', clipboardText: token });
      await mismatched.preview('s-1', token);
      assert.match(mismatched.getSnapshot().error, /不一致/);
    } finally { mismatched.dispose(); }
  } finally { references.dispose(); }
});

test('the bridge places a board chip in the composer without sending anything', async () => {
  const listeners = new Set(), frames = new Map(), timers = new Map(), messages = [], operations = [], edits = [];
  let sequence = 0, current = 'session-1';
  const remembered = [];
  const state = { draft: '', phase: 'plain', occurrences: [], attachmentIds: [], draftRev: 1 };
  const window = {
    location: { origin: 'http://localhost:3080' },
    addEventListener: (_, listener) => listeners.add(listener),
    removeEventListener: (_, listener) => listeners.delete(listener),
    requestAnimationFrame: fn => { frames.set(++sequence, fn); return sequence },
    cancelAnimationFrame: id => frames.delete(id),
    setTimeout: fn => { timers.set(++sequence, fn); return sequence },
    clearTimeout: id => timers.delete(id),
  };
  const scope = { bail: (subject, name, request) => { edits.push({ name, request }); return true } };
  const ctx = {
    sessions: {
      refresh: async () => { operations.push('refresh') },
      binding: () => ({ ctx: scope, session: { getSnapshot: () => ({ removed: false }) } }),
      open: id => { current = id; operations.push(`open:${id}`) },
      subagentAddress: () => undefined,
      list: { getSnapshot: () => ({ current }) },
    },
    conversation: {
      input: { for: () => ({ state: { getSnapshot: () => state }, notify: () => {} }) },
      blocks: { storeFor: () => ({ getSnapshot: () => undefined }) },
    },
    sidebarRight: { openTab: () => operations.push('tab') },
  };
  const bridge = createConversationBridge({ window, ctx, rememberBoardReference: (sessionId, reference) => remembered.push({ sessionId, reference }) });
  const target = { postMessage: (value, origin) => messages.push({ value, origin }) };
  const detach = bridge.attach(target);
  const frame = () => { for (const [id, fn] of [...frames]) { frames.delete(id); fn() } };
  const action = (action, extra = {}) => {
    for (const listener of listeners) listener({ source: target, origin: window.location.origin, data: { type: 'paper-library:conversation-action', version: 1, requestId: 'r-1', action, sessionId: 'session-1', ...extra } });
  };
  try {
    // The composer seat for the target session must be mounted, as in a real sidebar.
    bridge.mountedSession('session-1');
    action('board_draft', { board_id: 'b-0123456789ab', snapshot_id: 'c'.repeat(64), title: '技术路线' });
    await new Promise(resolve => setImmediate(resolve));
    frame();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(operations.filter(value => value.startsWith('open:')), ['open:session-1']);
    assert.equal(remembered.length, 1, 'the chip is remembered for the @ menu');
    assert.equal(remembered[0].reference.label, '画板：技术路线');
    const inserted = edits.find(edit => edit.name === 'slash/input-insert-text');
    assert.match(inserted.request.text, /^引用画板：技术路线\n\[\[paper-library-board:v1:b-0123456789ab:c{64}\]\]$/);
    const chip = edits.find(edit => edit.name === 'slash/input-insert-reference');
    assert.equal(chip.request.reference.source, 'paper-library-boards');
    assert.equal(chip.request.reference.ref, `[[paper-library-board:v1:b-0123456789ab:${'c'.repeat(64)}]]`);
    assert.equal(operations.includes('open:session-1'), true);
    // Nothing is sent: the bridge only prepares a draft.
    assert.equal(operations.some(value => value.startsWith('send')), false);

    // Forged or malformed payloads are refused before any input edit.
    edits.length = 0;
    action('board_draft', { board_id: 'not a board', snapshot_id: 'c'.repeat(64), title: 'x' });
    action('board_draft', { board_id: 'b-0123456789ab', snapshot_id: 'short', title: 'x' });
    action('board_draft', { board_id: 'b-0123456789ab', snapshot_id: 'c'.repeat(64), title: '   ' });
    action('board_draft', { board_id: 'b-0123456789ab', snapshot_id: 'c'.repeat(64), title: 'x'.repeat(201) });
    await new Promise(resolve => setImmediate(resolve));
    frame();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(edits, [], 'an invalid board reference never reaches the composer');
  } finally { detach(); bridge.dispose(); }
});

test('the annotation chip path is unchanged by the shared draft writer', async () => {
  const edits = [];
  const scope = { bail: (subject, name, request) => { edits.push({ name, request }); return true } };
  const state = { draft: 'existing note', phase: 'plain', occurrences: [], draftRev: 7 };
  const ctx = {
    sessions: {
      binding: () => ({ ctx: scope, session: { getSnapshot: () => ({ removed: false }) } }),
      subagentAddress: () => undefined,
    },
    conversation: { input: { for: () => ({ state: { getSnapshot: () => state }, notify: () => {} }) }, blocks: { storeFor: () => ({ getSnapshot: () => undefined }) } },
  };
  const ref = `[[paper-library-ref:v1:paper_a:${'d'.repeat(64)}]]`;
  const applied = appendConversationDraft(ctx, 'session-1', `问题\n${ref}`, { ref, label: '批注 2 条', clipboardText: ref });
  assert.equal(applied, true);
  assert.equal(edits[0].name, 'slash/input-insert-text');
  // Only the appended block travels: the existing draft is already in the composer,
  // which is why the span starts at its end.
  assert.equal(edits[0].request.text, `\n\n问题\n${ref}`);
  assert.equal(edits[0].request.span.start, 'existing note'.length);
  const chip = edits.find(edit => edit.name === 'slash/input-insert-reference');
  assert.equal(chip.request.reference.source, 'paper-library-annotations');
  assert.equal(chip.request.reference.ref, ref);
});
