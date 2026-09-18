import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../web/board.js', import.meta.url), 'utf8');

class ClassList {
  constructor() { this.values = new Set(); }
  add(...names) { for (const name of names) if (name) this.values.add(name); }
  remove(...names) { for (const name of names) this.values.delete(name); }
  contains(name) { return this.values.has(name); }
  toggle(name, on) { const next = on === undefined ? !this.values.has(name) : Boolean(on); if (next) this.values.add(name); else this.values.delete(name); return next; }
}

/** Minimal DOM/SVG stand-in: enough for the panel, with no browser and no network. */
function environment(ids = []) {
  const registry = new Map();
  const doc = { defaultView: { confirm: () => true } };
  class Element {
    constructor(tag = 'div', ns = null) {
      this.tagName = String(tag).toUpperCase(); this.namespaceURI = ns; this.children = []; this.parentNode = null;
      this.attributes = {}; this.style = {}; this.dataset = {}; this.events = new Map(); this.classList = new ClassList();
      this.textContent = ''; this.value = ''; this.hidden = false; this.disabled = false; this.ownerDocument = doc;
    }
    set className(value) { this._className = value; this.classList = new ClassList(); for (const name of String(value || '').split(/\s+/)) if (name) this.classList.add(name); }
    get className() { return this._className || ''; }
    set id(value) { this._id = value; registry.set(value, this); }
    get id() { return this._id; }
    append(...nodes) { for (const node of nodes) { if (!node) continue; if (node.parentNode) node.parentNode.children = node.parentNode.children.filter(child => child !== node); node.parentNode = this; this.children.push(node); } }
    appendChild(node) { this.append(node); return node; }
    replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
    remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this); this.parentNode = null; }
    setAttribute(key, value) { this.attributes[key] = String(value); if (key === 'hidden') this.hidden = true; }
    removeAttribute(key) { delete this.attributes[key]; if (key === 'hidden') this.hidden = false; }
    getAttribute(key) { return this.attributes[key] ?? null; }
    addEventListener(type, handler) { if (!this.events.has(type)) this.events.set(type, new Set()); this.events.get(type).add(handler); }
    removeEventListener(type, handler) { this.events.get(type)?.delete(handler); }
    dispatch(type, extra = {}) {
      const event = { target: this, shiftKey: false, metaKey: false, ctrlKey: false, button: 0, preventDefault() { this.defaultPrevented = true; }, ...extra };
      for (const handler of [...(this.events.get(type) || [])]) handler(event);
      return event;
    }
    focus() {} select() {}
    get firstChild() { return this.children[0] || null; }
    get lastChild() { return this.children[this.children.length - 1] || null; }
    getBoundingClientRect() { return { left: 0, top: 0, width: 800, height: 520 }; }
  }
  doc.createElement = tag => new Element(tag);
  doc.createElementNS = (ns, tag) => new Element(tag, ns);
  doc.body = new Element('body');
  doc.addEventListener = (type, handler) => { doc.body.addEventListener(type, handler); };
  doc.removeEventListener = (type, handler) => { doc.body.removeEventListener(type, handler); };
  doc.getElementById = id => registry.get(id) || null;
  for (const id of ids) { const node = new Element('div'); node.id = id; }
  return { doc, registry, Element };
}

function loadPanel({ api, confirm = true, capabilities, canvas } = {}) {
  const ids = [
    'board-stage', 'board-select', 'board-status', 'board-zoom-label', 'board-zoom-in', 'board-zoom-out', 'board-fit',
    'board-undo', 'board-redo', 'board-delete', 'board-title', 'board-new', 'board-close', 'board-add-paper', 'board-send', 'board-tidy', 'board-fullscreen',
    'board-conflict', 'board-conflict-note', 'board-conflict-reload', 'board-conflict-copy', 'board-accept-ai',
    'board-relation', 'board-edge-label-input', 'board-color', 'board-kind', 'board-selection',
    'board-tool-select', 'board-tool-pan', 'board-tool-text', 'board-tool-note', 'board-tool-rect', 'board-tool-ellipse', 'board-tool-diamond',
  ];
  const { doc, registry, Element } = environment(ids);
  doc.defaultView.confirm = () => confirm;
  const root = new Element('section');
  root.ownerDocument = doc;
  const calls = [];
  const messages = [];
  const timers = [];
  let timersId = 0;
  const context = {
    window: {},
    document: doc,
    setTimeout: (fn, ms) => { const id = ++timersId; timers.push({ id, fn, ms }); return id; },
    clearTimeout: id => { const index = timers.findIndex(timer => timer.id === id); if (index >= 0) timers.splice(index, 1); },
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  const board = context.window.PaperBoard;
  if (canvas) { const original = Element.prototype; original.__canvas = canvas; }
  const panel = board.create({ root, api: api || (async () => ({})), toast: (message) => messages.push(message), ...(capabilities ? { capabilities } : {}) });
  const stage = registry.get('board-stage');
  const svg = stage.children[0];
  return {
    board, panel, doc, registry, root, stage, svg, calls, messages,
    async runTimers() { const pending = timers.splice(0, timers.length); for (const timer of pending) await timer.fn(); await new Promise(resolve => setImmediate(resolve)); },
    pendingTimers: () => timers.length,
  };
}

const state = [];
const apiStub = (overrides = {}) => async (action, payload, options) => {
  state.push({ action, payload, options });
  if (overrides[action]) return overrides[action](payload);
  if (action === 'board_list') return { boards: [], scanned: 0, total: 0, truncated: false };
  if (action === 'board_create') { const board = { schema: 1, id: 'b-created', title: payload.board.title, origin: 'user', status: 'saved', view: { x: 0, y: 0, zoom: 1 }, nodes: payload.board.nodes ?? [], edges: payload.board.edges ?? [] }; return { board, revision: 'a'.repeat(64), summary: {} }; }
  if (action === 'board_get') return { board: { schema: 1, id: payload.id, title: '画板', origin: 'user', status: 'saved', view: { x: 0, y: 0, zoom: 1 }, nodes: [], edges: [] }, revision: 'b'.repeat(64), outline: '' };
  if (action === 'board_save') return { board: payload.board, revision: 'c'.repeat(64), summary: {} };
  return {};
};

test('canvas geometry keeps hits, anchors and zoom stable without a browser', () => {
  const { board } = loadPanel();
  const { hitNode, hitEdge, edgeGeometry, anchorPoint, viewportFor, applyZoom, toScene, toScreen, idsInRect, nodeBounds } = board.geometry;
  const nodes = [
    { id: 'n-1', kind: 'rect', x: 0, y: 0, w: 100, h: 60, text: 'a' },
    { id: 'n-2', kind: 'rect', x: 50, y: 20, w: 100, h: 60, text: 'b' },
  ];
  assert.equal(hitNode(nodes, { x: 60, y: 30 }), 'n-2', 'the topmost node wins');
  assert.equal(hitNode(nodes, { x: 10, y: 10 }), 'n-1');
  assert.equal(hitNode(nodes, { x: 400, y: 400 }), null);
  const edges = [{ id: 'e-1', from: 'n-1', to: 'n-2', kind: 'arrow' }];
  assert.equal(hitEdge(nodes, edges, { x: 75, y: 40 }, 6), 'e-1');
  assert.equal(hitEdge(nodes, edges, { x: 300, y: 400 }, 6), null);
  // Border anchors sit on the shape edge, never at the centre.
  const left = anchorPoint(nodes[0], { x: -100, y: 30 });
  assert.equal(left.x, 0);
  assert.equal(edgeGeometry(nodes[0], nodes[1], 'elbow').path, 'M 100 50 H 75 V 30 H 50');
  assert.equal(edgeGeometry(nodes[0], nodes[1], 'arrow').path, 'M 100 50 L 50 30');
  // Screen and scene conversions are exact inverses (spread: the vm realm has its own prototypes).
  const view = { x: 120, y: -40, zoom: 1.5 };
  assert.deepEqual({ ...toScreen(toScene({ x: 300, y: 200 }, view), view) }, { x: 300, y: 200 });
  // Zooming around an anchor keeps that anchor fixed.
  const zoomed = applyZoom(view, 2, { x: 300, y: 200 });
  const after = toScreen(toScene({ x: 300, y: 200 }, view), zoomed);
  assert.ok(Math.abs(after.x - 300) < 0.05 && Math.abs(after.y - 200) < 0.05);
  assert.equal(applyZoom({ x: 0, y: 0, zoom: 4 }, 4, { x: 0, y: 0 }).zoom, 4, 'zoom stays inside its bound');
  // Fit centres the content and never exceeds the readable zoom.
  const fitted = viewportFor(nodes, { width: 800, height: 520 });
  assert.ok(fitted.zoom > 0 && fitted.zoom <= 1.4);
  const centre = toScreen({ x: 75, y: 40 }, fitted);
  assert.ok(Math.abs(centre.x - 400) < 1 && Math.abs(centre.y - 260) < 1);
  assert.deepEqual({ ...viewportFor([], { width: 800, height: 520 }) }, { x: 400, y: 260, zoom: 1 });
  assert.deepEqual([...idsInRect(nodes, { x: 0, y: 0, w: 60, h: 40 })], ['n-1', 'n-2'], 'an overlapping marquee takes both');
  assert.deepEqual([...idsInRect(nodes, { x: 0, y: 0, w: 40, h: 15 })], ['n-1']);
  assert.deepEqual([...idsInRect(nodes, { x: 900, y: 900, w: 10, h: 10 })], []);
  assert.deepEqual({ ...nodeBounds(nodes[1]) }, { x: 50, y: 20, w: 100, h: 60, right: 150, bottom: 80, cx: 100, cy: 50 });
});

test('model edits enforce the host bounds and never invent connections', () => {
  const { board } = loadPanel();
  const { model, createNode, LIMITS } = board;
  let current = { schema: 1, title: 't', origin: 'user', status: 'saved', nodes: [], edges: [] };
  const a = createNode('concept', { x: 0, y: 0 }, 'a');
  const b = createNode('note', { x: 300, y: 0 }, 'b');
  current = model.addNode(model.addNode(current, a), b);
  assert.equal(current.nodes.length, 2);
  const added = model.addEdge(current, a.id, b.id, { relation: 'supports' });
  assert.equal(added.edge.relation, 'supports');
  assert.equal(added.edge.origin, 'user');
  current = added.board;
  // A duplicate pair reuses the existing edge instead of stacking a second one.
  const again = model.addEdge(current, a.id, b.id);
  assert.equal(again.board.edges.length, 1);
  assert.equal(again.edge.id, added.edge.id);
  assert.throws(() => model.addEdge(current, a.id, a.id), /同一个节点/);
  assert.throws(() => model.addEdge(current, a.id, 'n-missing'), /已不在画板中/);
  // Deleting a node cascades to its edges; deleting an edge leaves both nodes.
  const withoutNode = model.removeItems(current, [a.id]);
  assert.equal(withoutNode.nodes.length, 1);
  assert.equal(withoutNode.edges.length, 0);
  const withoutEdge = model.removeItems(current, [added.edge.id]);
  assert.equal(withoutEdge.nodes.length, 2);
  assert.equal(withoutEdge.edges.length, 0);
  // Text and geometry stay inside the persisted bounds.
  assert.throws(() => model.setNodeText(current, a.id, 'x'.repeat(LIMITS.text + 1)), /超过/);
  assert.equal(model.setNodeText(current, a.id, '').nodes[0].text, '');
  assert.equal(model.resizeNode(current, a.id, 10, 10).nodes[0].w, 40, 'a node keeps a usable minimum size');
  const moved = model.moveNodes(current, [a.id], 5, 7).nodes[0];
  assert.equal(moved.x, a.x + 5);
  assert.equal(moved.y, a.y + 7);
  assert.equal(model.moveNodes(current, [a.id], 1e9, 0).nodes[0].x, LIMITS.coordinate);
  // Duplication copies internal edges only, and offsets the copies.
  const duplicated = model.duplicate(current, [a.id, b.id]);
  assert.equal(duplicated.board.nodes.length, 4);
  assert.equal(duplicated.board.edges.length, 2);
  assert.equal(duplicated.nodes[0].x, a.x + 32);
  assert.equal(duplicated.board.nodes.filter(node => node.origin === 'llm').length, 0);
  assert.throws(() => model.duplicate(current, ['n-missing']), /先选中/);
  // Collection limits are enforced before a write, not truncated silently.
  const full = { ...current, nodes: Array.from({ length: LIMITS.nodes }, (_, index) => ({ id: `n-${index}`, kind: 'concept', x: 0, y: 0, w: 10, h: 10, text: 'x' })), edges: [] };
  assert.throws(() => model.addNode(full, createNode('concept', { x: 0, y: 0 }, 'y')), /最多 400 个节点/);
  const busy = { ...current, edges: Array.from({ length: LIMITS.edges }, (_, index) => ({ id: `e-${index}`, from: a.id, to: b.id, kind: 'arrow' })) };
  assert.throws(() => model.addEdge(busy, a.id, b.id), /最多 800 条连线/);
  assert.throws(() => model.addNode(current, { ...a, id: 'n-forged', kind: 'swimlane' }), /不受支持/);
});

test('a paper node keeps only catalog-fetched metadata and never invents a title', () => {
  const { board } = loadPanel();
  const node = board.paperNode({ id: 'paper_a', title: 'Synthetic paper', year: 2025, citekey: 'synth2025' }, { x: 100, y: 100 });
  assert.equal(node.kind, 'paper');
  assert.deepEqual({ ...node.paper }, { id: 'paper_a', title: 'Synthetic paper', year: 2025, citekey: 'synth2025' });
  assert.equal(node.text, 'Synthetic paper');
  assert.equal(node.x, 100 - node.w / 2, 'the node is centred on the drop point');
  assert.equal(node.origin, 'user');
  const bare = board.paperNode({ id: 'paper_b' }, { x: 0, y: 0 });
  assert.deepEqual({ ...bare.paper }, { id: 'paper_b' });
  assert.equal(bare.text, '（未命名文献）');
  assert.equal('year' in bare.paper, false, 'a missing year is omitted, not guessed');
  const odd = board.paperNode({ id: 'paper_c', year: 'not-a-year', citekey: 'x'.repeat(400) }, { x: 0, y: 0 });
  assert.equal('year' in odd.paper, false);
  assert.equal(odd.paper.citekey.length, 200);
});

test('the outline preview is deterministic and states its own truncation', () => {
  const { board } = loadPanel();
  const paper = board.paperNode({ id: 'paper_a', title: 'Paper A', year: 2025 }, { x: 0, y: 0 });
  const concept = { id: 'n-2', kind: 'concept', x: 300, y: 0, text: '概念' };
  const value = { schema: 1, title: '综述结构', origin: 'user', status: 'saved', nodes: [paper, concept], edges: [{ id: 'e-1', from: paper.id, to: concept.id, relation: 'explains' }] };
  const first = board.outline(value);
  assert.equal(first.truncated, false);
  assert.match(first.text, /# 画板：综述结构/);
  assert.match(first.text, /文献 paper_a（2025）/);
  assert.match(first.text, /Paper A --explains--> 概念/);
  assert.equal(first.text, board.outline(value).text, 'the preview is stable for one board');
  const small = board.outline(value, 60);
  assert.equal(small.truncated, true);
  assert.match(small.text, /预览已截断/);
  assert.ok(small.text.length < 120);
});

test('the panel creates a board on first open, persists an edit and reports its state', async () => {
  state.length = 0;
  const harness = loadPanel({ api: apiStub() });
  await harness.panel.open();
  assert.deepEqual(state.map(call => call.action), ['board_list', 'board_create', 'board_list', 'board_get']);
  assert.equal(harness.panel.isOpen(), true);
  assert.equal(harness.doc.body.classList.contains('board-mode'), true);

  // Drawing a node persists it after the debounce, with the loaded revision.
  harness.panel.setTool('note');
  harness.svg.dispatch('pointerdown', { clientX: 100, clientY: 100 });
  const drawn = harness.panel.board();
  assert.equal(drawn.nodes.length, 1);
  assert.equal(drawn.nodes[0].kind, 'note');
  assert.equal(harness.pendingTimers() > 0, true, 'a save is scheduled rather than sent per event');
  await harness.runTimers();
  const save = state.filter(call => call.action === 'board_save').at(-1);
  assert.equal(save.payload.expected_revision, 'b'.repeat(64));
  assert.equal(save.payload.board.nodes.length, 1);
  assert.equal(harness.registry.get('board-status').textContent, '已保存');
  assert.equal(harness.registry.get('board-status').classList.contains('is-saved'), true);
});

test('a conflicting save keeps both sides and offers recovery instead of overwriting', async () => {
  state.length = 0;
  const conflict = Object.assign(new Error('画板已在另一窗口更新'), { code: 'STATE_CONFLICT' });
  const harness = loadPanel({ api: apiStub({ board_save: () => { throw conflict; }, board_get: payload => ({ board: { schema: 1, id: payload.id, title: '别处保存的标题', origin: 'user', status: 'saved', nodes: [], edges: [] }, revision: 'd'.repeat(64), outline: '' }) }) });
  await harness.panel.open();
  harness.panel.setTool('rect');
  harness.svg.dispatch('pointerdown', { clientX: 200, clientY: 120 });
  await harness.runTimers();
  assert.equal(harness.registry.get('board-conflict').hidden, false, 'the conflict is shown, not swallowed');
  assert.match(harness.registry.get('board-conflict-note').textContent, /没有被覆盖/);
  assert.equal(harness.registry.get('board-status').classList.contains('is-error'), true);

  // "Load the saved version" adopts the other window's board.
  harness.registry.get('board-conflict-reload').dispatch('click');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(harness.registry.get('board-conflict').hidden, true);
  assert.equal(harness.panel.board().title, '别处保存的标题');

  // "Save as a new board" preserves the local edit under a new record.
  harness.panel.setTool('note');
  harness.svg.dispatch('pointerdown', { clientX: 260, clientY: 160 });
  await harness.runTimers();
  assert.equal(harness.registry.get('board-conflict').hidden, false);
  state.length = 0;
  harness.registry.get('board-conflict-copy').dispatch('click');
  await new Promise(resolve => setImmediate(resolve));
  const created = state.find(call => call.action === 'board_create');
  assert.ok(created, 'the local board is saved as a new record');
  assert.match(created.payload.board.title, /本地副本/);
  assert.equal(created.payload.board.nodes.length > 0, true, 'no edit is discarded');
});

test('tidy-tree arranging is deterministic, respects the reader\'s order and survives cycles', () => {
  const { board } = loadPanel();
  const { tidyTree, placeInColumn, boardFromPapers } = board;
  const node = (id, x, y, w = 200, h = 100) => ({ id, kind: 'concept', x, y, w, h, text: id });
  const nodes = [node('root', 400, 300), node('b', 100, 500), node('a', 100, 200), node('leaf', 700, 900)];
  const edges = [
    { id: 'e1', from: 'root', to: 'a', kind: 'arrow' },
    { id: 'e2', from: 'root', to: 'b', kind: 'arrow' },
    { id: 'e3', from: 'a', to: 'leaf', kind: 'arrow' },
  ];
  const arranged = tidyTree(nodes, edges);
  const at = id => arranged.find(value => value.id === id);
  // The root with no incoming edge is leftmost; every child sits right of its parent.
  assert.equal(at('root').x < at('a').x, true);
  assert.equal(at('a').x < at('leaf').x, true);
  assert.equal(at('a').x, at('b').x, 'one column per depth');
  // Children keep the reader's vertical order (a above b) and parent rows sit between them.
  assert.equal(at('a').y < at('b').y, true);
  assert.equal(at('root').y, (at('a').y + at('b').y) / 2);
  assert.equal(at('a').y, at('leaf').y, 'a single child shares its parent\'s row');
  // Deterministic and origin-preserving: the top-left of the content does not jump.
  assert.deepEqual(arranged.map(value => [value.id, value.x, value.y]), tidyTree(nodes, edges).map(value => [value.id, value.x, value.y]));
  assert.equal(Math.min(...arranged.map(value => value.x)), 100, 'the tree lands where the content already was');
  assert.equal(Math.min(...arranged.map(value => value.y)), 200);
  // Column spacing accounts for the widest node of each depth.
  const wide = tidyTree([node('root', 0, 0, 500, 100), node('kid', 0, 200, 100, 100)], [{ id: 'e', from: 'root', to: 'kid', kind: 'arrow' }]);
  assert.equal(wide.find(value => value.id === 'kid').x, 580);

  // An explicit root is honoured, extra parents are ignored, and an unrelated group stacks below.
  const explicit = tidyTree([node('b', 0, 0), node('a', 0, 300)], [{ id: 'e', from: 'a', to: 'b', kind: 'arrow' }], { rootId: 'a' });
  assert.equal(explicit.find(value => value.id === 'a').x < explicit.find(value => value.id === 'b').x, true);
  const twoParents = tidyTree([node('r', 0, 0), node('x', 0, 200), node('y', 0, 400)], [{ id: 'e1', from: 'r', to: 'y', kind: 'arrow' }, { id: 'e2', from: 'x', to: 'y', kind: 'arrow' }]);
  assert.equal(twoParents.find(value => value.id === 'y').x > twoParents.find(value => value.id === 'r').x, true, 'y keeps its first parent');
  // A cycle is arranged, never recursed into forever.
  const cyclic = tidyTree([node('p', 0, 0), node('q', 0, 200)], [{ id: 'e1', from: 'p', to: 'q', kind: 'arrow' }, { id: 'e2', from: 'q', to: 'p', kind: 'arrow' }]);
  assert.equal(cyclic.length, 2);
  assert.equal(tidyTree([node('solo', 5, 7)], []).length, 1);

  // New papers stack under the existing content instead of landing on top of it.
  const existing = [node('keep', 100, 100, 200, 100)];
  const placed = placeInColumn(existing, [node('new', 0, 0, 200, 100), node('newer', 0, 0, 200, 60)]);
  assert.equal(placed[0].x, 100);
  assert.equal(placed[0].y, 240);
  assert.equal(placed[1].y, 380);

  // A generated board is a real root-plus-papers mind map, already arranged.
  const generated = boardFromPapers([{ id: 'paper_a', title: 'Paper A', year: 2025 }, { id: 'paper_b', title: 'Paper B' }], ' 技术路线 ');
  assert.equal(generated.title, '技术路线');
  assert.equal(generated.nodes.length, 3);
  assert.equal(generated.edges.length, 2);
  assert.equal(generated.edges.every(edge => edge.relation === 'related' && edge.origin === 'user'), true);
  const root = generated.nodes.find(value => value.kind === 'concept');
  assert.equal(root.text, '技术路线');
  assert.equal(generated.nodes.filter(value => value.kind === 'paper').every(value => value.x > root.x), true, 'papers grow right of the theme');
  assert.throws(() => boardFromPapers([], 'x'), /至少一篇文献/);
  assert.throws(() => boardFromPapers([{ id: 'paper_a' }], '   '), /主题/);
});

test('the tidy control arranges the board, persists it and declines a single node', async () => {
  state.length = 0;
  const harness = loadPanel({ api: apiStub() });
  await harness.panel.open();
  assert.equal(harness.panel.addPapers([{ id: 'paper_a', title: '论文 A' }, { id: 'paper_b', title: '论文 B' }]), 2);
  await harness.runTimers();
  assert.equal(harness.panel.board().nodes.length, 2);
  assert.equal(harness.panel.selection().length, 2, 'the added papers are the scope');
  assert.equal(harness.panel.tidy(), 2);
  await harness.runTimers();
  assert.equal(state.filter(call => call.action === 'board_save').length >= 2, true, 'arranging reaches the host');
  // An empty board has nothing to arrange, and still says so instead of failing.
  await harness.panel.load('b-empty');
  assert.equal(harness.panel.board().nodes.length, 0);
  assert.equal(harness.panel.tidy(), 0);
  assert.equal(harness.messages.some(message => /至少要有两个节点/.test(message)), true);
});

test('still exports paint from the model, so the file never depends on page styles', () => {
  const calls = [];
  const context = new Proxy({}, {
    get: (_target, key) => {
      if (['fillStyle', 'strokeStyle', 'lineWidth', 'font', 'textAlign'].includes(key)) return '';
      if (['save', 'restore', 'translate', 'scale', 'beginPath', 'moveTo', 'lineTo', 'arc', 'arcTo', 'rect', 'ellipse', 'closePath', 'fill', 'stroke', 'fillRect', 'fillText', 'setLineDash'].includes(key)) return (...args) => calls.push([key, ...args]);
      return undefined;
    },
    set: () => true,
  });
  const canvasStub = { width: 0, height: 0, getContext: () => context };
  const { board } = loadPanel();
  const nodes = [
    { id: 'n-1', kind: 'note', x: 0, y: 0, w: 220, h: 140, text: '导出节点一', origin: 'user' },
    { id: 'n-2', kind: 'paper', x: 400, y: 40, w: 260, h: 120, text: 'Paper A', origin: 'user', paper: { id: 'paper_a', title: 'Paper A', year: 2025, citekey: 'k2025' } },
    { id: 'n-3', kind: 'ellipse', x: 0, y: 300, w: 160, h: 90, text: 'AI 提议', origin: 'llm' },
  ];
  const value = { schema: 1, title: '导出画板', origin: 'user', status: 'saved', nodes, edges: [{ id: 'e-1', from: 'n-1', to: 'n-2', kind: 'arrow', relation: 'explains', label: '解释' }] };
  board.renderToCanvas(value, canvasStub, { scale: 2, padding: 40 });
  // The bitmap covers the content plus padding, at the requested density.
  assert.equal(canvasStub.width, Math.round((400 + 260 + 80) * 2));
  assert.equal(canvasStub.height, Math.round((300 + 90 + 80) * 2));
  const kinds = calls.map(call => call[0]);
  // Three node bodies plus the arrowhead.
  assert.equal(kinds.filter(kind => kind === 'fill').length >= 3, true, 'every node is painted');
  assert.equal(kinds.filter(kind => kind === 'stroke').length >= 4, true, 'edges and node outlines are painted');
  assert.equal(calls.some(call => call[0] === 'ellipse'), true, 'an ellipse node keeps its shape');
  assert.equal(calls.some(call => call[0] === 'setLineDash' && Array.isArray(call[1]) && call[1].length === 2), true, 'an AI proposal keeps its dashed outline');
  assert.equal(calls.filter(call => call[0] === 'fillText').some(call => /2025/.test(String(call[1]))), true, 'paper metadata is drawn');
  assert.equal(calls.some(call => call[0] === 'fillText' && call[1] === '解释'), true, 'edge labels are drawn');
  assert.throws(() => board.renderToCanvas(value, { getContext: () => null }), /不支持画布导出/);
});

test('a host without a library or composer hides those controls instead of faking them', async () => {
  const harness = loadPanel({ api: apiStub(), capabilities: { libraryPapers: false, conversation: false } });
  assert.equal(harness.registry.get('board-add-paper').hidden, true);
  assert.equal(harness.registry.get('board-send').hidden, true);
  // The hidden reference control must also refuse programmatically, not just visually.
  assert.equal(await harness.panel.sendToConversation(), false);
  assert.equal(harness.messages.some(message => /DSH/.test(message)), false, 'a hidden control does not nag');

  const full = loadPanel({ api: apiStub() });
  assert.equal(full.registry.get('board-add-paper').hidden, false);
  assert.equal(full.registry.get('board-send').hidden, false);
});

test('a knowledge-graph node joins the board without inventing metadata', async () => {
  const { board } = loadPanel();
  const { nodeFromGraphPayload } = board;
  const concept = nodeFromGraphPayload({ type: 'method', label: '合成方法', kind: 'concept' });
  assert.equal(concept.kind, 'concept');
  assert.equal(concept.text, '合成方法');
  assert.equal(concept.origin, 'user');
  assert.equal('paper' in concept, false, 'a non-paper graph node becomes a plain concept node');
  const paper = nodeFromGraphPayload({ type: 'paper', label: 'Synthetic paper', paper: { id: 'paper_a', title: 'Synthetic paper', year: 2025, citekey: 'synth2025' } });
  assert.equal(paper.kind, 'paper');
  assert.deepEqual({ ...paper.paper }, { id: 'paper_a', title: 'Synthetic paper', year: 2025, citekey: 'synth2025' });
  // Only a real paper binding survives; a label alone never becomes a paper node.
  assert.equal(nodeFromGraphPayload({ type: 'paper', label: 'Some title' }).kind, 'concept');
  assert.throws(() => nodeFromGraphPayload({ label: '   ' }), /名称/);
  assert.throws(() => nodeFromGraphPayload(null), /内容/);
});

test('adding a graph node works with the board closed and reports host failures', async () => {
  state.length = 0;
  const harness = loadPanel({ api: apiStub() });
  // No board is open yet: the path lists, finds nothing, creates one, then appends.
  assert.equal(await harness.panel.addGraphNode({ label: '合成方法' }), true);
  assert.equal(state[0].action, 'board_list');
  assert.equal(state.some(call => call.action === 'board_create'), true);
  const saved = state.filter(call => call.action === 'board_save').at(-1);
  assert.equal(saved.payload.board.nodes.length, 1);
  assert.equal(saved.payload.board.nodes[0].text, '合成方法');
  assert.equal(harness.panel.isOpen(), false, 'the board view stays closed');

  state.length = 0;
  const failing = loadPanel({ api: apiStub({ board_list: () => { throw new Error('已有请求正在处理，请稍后重试。'); } }) });
  assert.equal(await failing.panel.addGraphNode({ label: '合成方法' }), false);
  assert.equal(failing.messages.some(message => /稍后重试/.test(message)), true, 'a host failure is reported, not swallowed');
});

test('a failed listing reports itself, never fabricates a board, and recovers on retry', async () => {
  state.length = 0;
  let failing = true;
  const harness = loadPanel({
    api: async (action, payload) => {
      state.push({ action, payload });
      if (failing && action === 'board_list') throw new Error('已有请求正在处理，请稍后重试。');
      if (action === 'board_list') return { boards: [], scanned: 0, total: 0, truncated: false };
      if (action === 'board_create') return { board: { schema: 1, id: 'b-retry', title: payload.board.title, origin: 'user', status: 'saved', view: { x: 0, y: 0, zoom: 1 }, nodes: [], edges: [] }, revision: 'e'.repeat(64), summary: {} };
      if (action === 'board_get') return { board: { schema: 1, id: payload.id, title: '重试后的画板', origin: 'user', status: 'saved', nodes: [], edges: [] }, revision: 'f'.repeat(64), outline: '' };
      return {};
    },
  });
  await harness.panel.open();
  assert.deepEqual(state.map(call => call.action), ['board_list'], 'no board is created when the listing itself failed');
  assert.equal(harness.registry.get('board-status').classList.contains('is-error'), true);
  assert.match(harness.registry.get('board-status').textContent, /稍后重试/);
  assert.equal(harness.panel.isOpen(), true, 'the view stays usable so the reader can retry');
  assert.equal(harness.panel.board().nodes.length, 0);

  // An explicit retry recovers instead of leaving a permanently blank view.
  failing = false;
  harness.registry.get('board-new').dispatch('click');
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(state.some(call => call.action === 'board_create'), true);
  assert.equal(harness.panel.board().title, '重试后的画板');
  assert.equal(harness.registry.get('board-status').classList.contains('is-error'), false);
});

test('tools, undo/redo and deletion behave through the panel surface', async () => {
  state.length = 0;
  const harness = loadPanel({ api: apiStub() });
  await harness.panel.open();
  harness.panel.setTool('rect');
  assert.equal(harness.registry.get('board-tool-rect').getAttribute('aria-pressed'), 'true');
  assert.equal(harness.registry.get('board-tool-select').getAttribute('aria-pressed'), 'false');

  // Placing a shape returns to the selection tool, so a follow-up click cannot
  // create a second node while the inline text editor is still open.
  harness.svg.dispatch('pointerdown', { clientX: 60, clientY: 60 });
  assert.equal(harness.registry.get('board-tool-select').getAttribute('aria-pressed'), 'true');
  assert.equal(harness.panel.board().nodes.length, 1);
  assert.equal(harness.panel.selection().length, 1, 'the newest node is the selection');
  harness.panel.setTool('note');
  harness.svg.dispatch('pointerdown', { clientX: 520, clientY: 300 });
  assert.equal(harness.panel.board().nodes.length, 2);
  assert.equal(harness.panel.board().nodes[1].kind, 'note');

  harness.registry.get('board-undo').dispatch('click');
  assert.equal(harness.panel.board().nodes.length, 1);
  harness.registry.get('board-redo').dispatch('click');
  assert.equal(harness.panel.board().nodes.length, 2);
  harness.registry.get('board-delete').dispatch('click');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(state.some(call => call.action === 'board_delete'), true, 'deleting asks the host to tombstone the record');
  assert.equal(harness.panel.isOpen(), true, 'deleting the last board leaves a usable view rather than a blank one');
  assert.equal(harness.panel.board().nodes.length, 0, 'the replacement board starts empty');
  await harness.runTimers();
  await harness.panel.close();
  assert.equal(harness.doc.body.classList.contains('board-mode'), false);
});

test('leaving the board settles a pending debounced edit instead of dropping it', async () => {
  state.length = 0;
  const harness = loadPanel({ api: apiStub() });
  await harness.panel.open();
  harness.panel.setTool('note');
  harness.svg.dispatch('pointerdown', { clientX: 140, clientY: 140 });
  assert.equal(harness.pendingTimers() > 0, true, 'the edit is still only scheduled');
  assert.equal(state.some(call => call.action === 'board_save'), false);
  await harness.panel.close();
  const saved = state.filter(call => call.action === 'board_save');
  assert.equal(saved.length, 1, 'closing the board writes the pending edit first');
  assert.equal(saved[0].payload.board.nodes.length, 1);
  assert.equal(saved[0].payload.expected_revision, 'b'.repeat(64));
  assert.equal(saved[0].options.keepalive, true, 'the write survives the page going away');
  assert.equal(harness.pendingTimers(), 0, 'the debounce timer is not left behind');

  // Switching boards settles the outgoing board before loading the next one.
  state.length = 0;
  const switching = loadPanel({ api: apiStub({ board_list: () => ({ boards: [{ id: 'b-one', title: '一', node_count: 0, edge_count: 0 }], scanned: 1, total: 1, truncated: false }), board_get: payload => ({ board: { schema: 1, id: payload.id, title: '一', origin: 'user', status: 'saved', nodes: [], edges: [] }, revision: 'b'.repeat(64), outline: '' }) }) });
  await switching.panel.open();
  switching.panel.setTool('rect');
  switching.svg.dispatch('pointerdown', { clientX: 200, clientY: 200 });
  state.length = 0;
  await switching.panel.load('b-two');
  assert.equal(state[0].action, 'board_save', 'the outgoing board is saved before another is opened');
  assert.equal(state[1].action, 'board_get');
});
