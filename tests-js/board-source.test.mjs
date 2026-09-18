import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { validateBoard } from '../src/harness/board-store.mjs';

const moduleSource = await readFile(new URL('../web/board-source.js', import.meta.url), 'utf8');
const context = { window: {} };
vm.createContext(context);
vm.runInContext(moduleSource, context);
const source = context.window.PaperBoardSource;

const sample = () => ({
  schema: source.SOURCE_SCHEMA,
  title: '城市感知的技术路线',
  nodes: [
    { id: 'root', kind: 'concept', text: '城市感知' },
    { id: 'a', kind: 'note', text: '多源数据融合' },
    { id: 'b', kind: 'paper', paper: 'paper_a', paperTitle: 'Paper A', year: 2026, citekey: 'wang2026' },
    { id: 'parked', kind: 'concept', text: '固定位置', pin: [900, 120] },
  ],
  edges: [{ from: 'root', to: 'a', relation: 'explains' }, { from: 'root', to: 'b', kind: 'elbow', dashed: true, arrow: 'both' }, { from: 'a', to: 'parked', waypoints: [[600, 300]] }],
});

test('the source and style validators refuse malformed files with readable reasons', () => {
  const cases = [
    [() => source.validateSource({ schema: 'nope', nodes: [] }), /版本不受支持/],
    [() => source.validateSource({ nodes: [] }), /1–400 项/],
    [() => source.validateSource({ nodes: [{ id: 'a', kind: 'swimlane', text: 'x' }] }), /类型不受支持/],
    [() => source.validateSource({ nodes: [{ id: 'a', kind: 'note', text: 'x' }, { id: 'a', kind: 'note', text: 'y' }] }), /标识重复/],
    [() => source.validateSource({ nodes: [{ id: 'a', kind: 'note', text: 'x' }], edges: [{ from: 'a', to: 'a' }] }), /同一个节点/],
    [() => source.validateSource({ nodes: [{ id: 'a', kind: 'note', text: 'x' }], edges: [{ from: 'a', to: 'ghost' }] }), /端点不在/],
    [() => source.validateSource({ nodes: [{ id: 'a', kind: 'note', text: 'x' }], edges: [{ from: 'a', to: 'a' }], extra: 1 }), /不支持的字段/],
    [() => source.validateSource({ nodes: [{ id: 'a', kind: 'note', text: 'x', pin: [1] }] }), /pin 必须是/],
    [() => source.validateSource({ nodes: [{ id: 'a', kind: 'note', text: 'x' }], edges: [{ from: 'a', to: 'a', waypoints: Array.from({ length: 9 }, () => [0, 0]) }] }), /同一个节点|最多 8 个拐点/],
    [() => source.validateStyle({ node: { byKind: { note: { w: 10 } } } }), /宽度必须在/],
    [() => source.validateStyle({ layout: { mode: 'spiral' } }), /排版方式/],
    [() => source.validateStyle({ layout: { pins: { a: [1, 2, 3] } } }), /固定位置必须是/],
    [() => source.validateStyle({ edge: { byRelation: { invents: {} } } }), /不支持的字段/],
    [() => source.validateStyle({ node: { byKind: { note: { fill: 'red' } } } }), /#rrggbb/],
  ];
  for (const [run, expected] of cases) assert.throws(run, expected);
  // The permissive shapes are still accepted.
  assert.equal(source.validateStyle(undefined).layout, undefined);
  assert.equal(Object.keys(source.validateStyle({})).length, 0);
  assert.equal(source.validateSource({ nodes: [{ id: 'only', kind: 'note', text: 'x' }] }).nodes.length, 1);
});

test('a generated board is exactly what the host accepts, so both validators agree', () => {
  const converted = source.fromSource(sample(), {
    schema: source.STYLE_SCHEMA,
    theme: { background: '#ffffff' },
    node: { byKind: { paper: { fill: '#eef4ff', w: 300 } }, byId: { parked: { fontSize: 15 } } },
    edge: { byRelation: { explains: { stroke: '#4176e6', width: 2 } } },
    layout: { mode: 'layered', direction: 'tb', gapX: 120, gapY: 40, pins: { parked: [900, 120] } },
  });
  // The host validator is the authority for what can be stored; it must accept everything,
  // style block included — this is the contract that keeps both validators aligned.
  const validated = validateBoard({ ...converted.board, style: converted.style }, { id: 'b-000000000001' });
  assert.equal(validated.nodes.length, 4);
  assert.equal(validated.edges.length, 3);
  assert.equal(validated.nodes.find(node => node.id === 'b').w, 300, 'sidecar sizing survives host validation');
  assert.deepEqual(validated.edges.find(edge => edge.from === 'root' && edge.to === 'b').waypoints, undefined);
  assert.deepEqual(validated.edges.find(edge => edge.from === 'a').waypoints, [[600, 300]], 'waypoints survive host validation');
  assert.equal(validated.edges.find(edge => edge.to === 'b').dashed, true);
  assert.equal(validated.edges.find(edge => edge.to === 'b').arrow, 'both');
  assert.equal(validated.edges.find(edge => edge.to === 'b').kind, 'elbow');
  assert.deepEqual(validated.style.layout.pins, { parked: [900, 120] });
  assert.equal(validated.style.node.byKind.paper.fill, '#eef4ff', 'fills travel in the style block, never on the node');
  assert.equal(validated.style.edge.byRelation.explains.stroke, '#4176e6');
  assert.equal(validated.style.layout.mode, 'layered');
  // A stored sidecar with its version marker survives a host round trip.
  const withSchema = validateBoard({ ...converted.board, style: { schema: source.STYLE_SCHEMA, ...converted.style } }, { id: 'b-000000000002' });
  assert.equal(withSchema.style.schema, source.STYLE_SCHEMA);
  // Links travel in the same file and survive the host validator.
  const linked = validateBoard({ ...source.fromSource({ ...sample(), papers: ['paper_a', 'paper_b'], projects: ['proj-1'] }, {}).board, style: undefined }, { id: 'b-000000000003' });
  assert.deepEqual({ ...linked.links, papers: [...linked.links.papers], projects: [...linked.links.projects] }, { papers: ['paper_a', 'paper_b'], projects: ['proj-1'] });
  assert.equal(linked.links.papers.length, 2, 'one board may sit under several papers');
  const stripped = validateBoard({ ...converted.board, links: { papers: ['paper_a'], projects: [] } }, { id: 'b-000000000004' });
  assert.deepEqual({ ...stripped.links, papers: [...stripped.links.papers] }, { papers: ['paper_a'] }, 'an empty list is dropped, not stored as an empty array');
  assert.throws(() => source.validateSource({ ...sample(), papers: ['a', 'a'] }), /重复/);
  assert.throws(() => source.validateSource({ ...sample(), projects: Array.from({ length: 21 }, (_, index) => `p${index}`) }), /最多 20 项/);
  assert.throws(() => validateBoard({ ...converted.board, links: { papers: ['not an id'] } }, { id: 'b-000000000005' }), /必须是 1–60 位/);

  // And an exported source validates against its own reader.
  const { source: content, style } = source.toSource(converted.board, {});
  assert.deepEqual(source.validateSource(content), content);
  assert.equal(source.validateStyle(style).schema, undefined);
  // Every node/edge the source module emits is addressable by the host's id grammar.
  for (const node of converted.board.nodes) assert.match(node.id, /^[A-Za-z0-9_-]{1,60}$/);
  for (const edge of converted.board.edges) assert.match(edge.id, /^[A-Za-z0-9_-]{1,60}$/);
});

test('layout modes are deterministic, order-stable and honour pins', () => {
  const nodes = [
    { id: 'root', kind: 'concept', x: 0, y: 0, w: 200, h: 100, text: '根' },
    { id: 'a', kind: 'note', x: 0, y: 200, w: 220, h: 140, text: 'A' },
    { id: 'b', kind: 'note', x: 0, y: 400, w: 220, h: 140, text: 'B' },
    { id: 'c', kind: 'note', x: 0, y: 600, w: 220, h: 140, text: 'C' },
  ];
  const edges = [{ id: 'e1', from: 'root', to: 'a', kind: 'arrow' }, { id: 'e2', from: 'root', to: 'b', kind: 'arrow' }, { id: 'e3', from: 'a', to: 'c', kind: 'arrow' }];
  const signature = value => value.map(node => `${node.id}:${node.x},${node.y}`).join('|');
  for (const mode of ['tree', 'radial', 'layered']) {
    const once = source.layout(nodes, edges, { mode, direction: 'lr' });
    const twice = source.layout(once, edges, { mode, direction: 'lr' });
    assert.equal(signature(twice), signature(once), `${mode} must be idempotent`);
    for (const direction of ['lr', 'tb', 'rl', 'bt']) {
      const run = source.layout(nodes, edges, { mode, direction });
      assert.equal(run.length, 4);
      assert.equal(run.some(node => !Number.isFinite(node.x) || !Number.isFinite(node.y)), false);
    }
  }
  // The tree keeps the reader's vertical order; radial and layered use the stable board order.
  const tree = source.layout(nodes, edges, { mode: 'tree' });
  assert.ok(tree.find(node => node.id === 'a').y < tree.find(node => node.id === 'b').y, 'tree siblings keep their order');
  const reversed = [nodes[0], nodes[2], nodes[1], nodes[3]];
  const radial = source.layout(reversed, edges, { mode: 'radial' });
  const radialAgain = source.layout(radial, edges, { mode: 'radial' });
  assert.equal(signature(radialAgain), signature(radial), 'radial stays put when applied twice');
  // Spacing is honoured rather than ignored.
  const tight = source.layout(nodes, edges, { mode: 'tree', gapX: 20, gapY: 10 });
  const wide = source.layout(nodes, edges, { mode: 'tree', gapX: 300, gapY: 200 });
  const span = value => Math.max(...value.map(node => node.x)) - Math.min(...value.map(node => node.x));
  assert.ok(span(wide) > span(tight));
});

test('edge geometry follows waypoints for every line kind and measures the real path', () => {
  const from = { id: 'a', kind: 'note', x: 0, y: 0, w: 200, h: 100, text: 'A' };
  const to = { id: 'b', kind: 'note', x: 600, y: 300, w: 200, h: 100, text: 'B' };
  const straight = source.edgePoints(from, to, []);
  assert.equal(straight.length, 2);
  assert.equal(source.edgePath(straight, 'arrow'), `M ${straight[0].x} ${straight[0].y} L ${straight[1].x} ${straight[1].y}`);
  assert.equal(source.edgePath(straight, 'elbow').includes('V'), true, 'elbow routing is orthogonal');
  // The drawn shape of an elbow includes its corner, so hit-testing measures the line on
  // screen rather than an invisible straight line between the endpoints.
  const corner = source.edgeRenderPoints(from, to, 'elbow', []);
  assert.equal(corner.length, 3);
  assert.equal(corner[1].y, corner[0].y);
  assert.equal(corner[1].x, corner[2].x);
  assert.equal(source.edgeRenderPoints(from, to, 'arrow', []).length, 2);
  const cornerMid = source.edgeMidpoint(corner);
  assert.ok(source.distanceToPoints(corner, cornerMid) < 0.01, 'the elbow midpoint lies on the drawn path');
  const bent = source.edgePoints(from, to, [[300, 40], [500, 260]]);
  assert.equal(bent.length, 4);
  assert.deepEqual([bent[1].x, bent[1].y], [300, 40]);
  assert.deepEqual([bent[2].x, bent[2].y], [500, 260]);
  // The first and last points sit on the shapes, not at their centres.
  // The anchor sits on one of the shape's edges, never at its centre.
  assert.equal([0, 200].includes(bent[0].x) || [0, 100].includes(bent[0].y), true);
  assert.equal(source.edgePath(bent, 'arrow').split('L').length, 4);
  // A point off the line is far; a point on it is not.
  assert.ok(source.distanceToPoints(straight, { x: 300, y: 300 }) > 100);
  const mid = source.edgeMidpoint(straight);
  assert.ok(source.distanceToPoints(straight, mid) < 0.01);
  // Dragging near a leg inserts a waypoint there and the limit is enforced.
  const inserted = source.dragWaypoint({ waypoints: [] }, straight, { x: mid.x, y: mid.y });
  assert.equal(inserted.inserted, true);
  assert.equal(inserted.waypoints.length, 1);
  const moved = source.dragWaypoint({ waypoints: inserted.waypoints }, straight, { x: 10, y: 20 }, 0);
  assert.equal(moved.inserted, false);
  assert.deepEqual([...moved.waypoints[0]], [10, 20]);
  const full = { waypoints: Array.from({ length: source.LIMITS.waypoints }, (_, index) => [index, index]) };
  const many = source.edgePoints(from, to, full.waypoints);
  assert.throws(() => source.dragWaypoint(full, many, { x: mid.x, y: mid.y }), /最多 8 个拐点/);
});

test('presentation resolution prefers the most specific override', () => {
  const style = {
    node: { byKind: { paper: { fill: '#eef4ff', stroke: '#4176e6' } }, byId: { p1: { fill: '#ffe9ec', fontSize: 15 } } },
    edge: { byDefault: { stroke: '#999999', width: 1 }, byRelation: { contradicts: { stroke: '#b0306a', dashed: true, arrow: 'both' } } },
  };
  // Spread: values from the module's vm realm carry their own prototypes.
  assert.deepEqual({ ...source.nodeStyle(style, { id: 'p1', kind: 'paper' }) }, { fill: '#ffe9ec', stroke: '#4176e6', w: undefined, h: undefined, fontSize: 15 });
  assert.deepEqual({ ...source.nodeStyle(style, { id: 'p2', kind: 'paper' }) }, { fill: '#eef4ff', stroke: '#4176e6', w: undefined, h: undefined, fontSize: undefined });
  assert.deepEqual({ ...source.nodeStyle(style, { id: 'n1', kind: 'note' }) }, { fill: undefined, stroke: undefined, w: undefined, h: undefined, fontSize: undefined });
  // A relation override replaces only the fields it names; the default width stays.
  assert.deepEqual({ ...source.edgeStyle(style, { relation: 'contradicts' }) }, { stroke: '#b0306a', width: 1, arrow: 'both', dashed: true, kind: 'arrow' });
  assert.deepEqual({ ...source.edgeStyle(style, { relation: 'cites', kind: 'elbow' }) }, { stroke: '#999999', width: 1, arrow: 'forward', dashed: false, kind: 'elbow' });
  assert.deepEqual({ ...source.edgeStyle(undefined, { kind: 'line', dashed: true, arrow: 'none' }) }, { stroke: undefined, width: undefined, arrow: 'none', dashed: true, kind: 'line' });
});
