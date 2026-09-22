/** draw.io import/export: the format as the official server writes it, the compressed form draw.io
 *  itself saves, and the contract that an imported file is exactly what the host validator accepts. */
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import zlib from 'node:zlib';
import { readFile } from 'node:fs/promises';
import { validateBoard } from '../src/harness/board-store.mjs';

const drawioSource = await readFile(new URL('../web/board-drawio.js', import.meta.url), 'utf8');
const sourceModule = await readFile(new URL('../web/board-source.js', import.meta.url), 'utf8');
const context = { window: {} };
vm.createContext(context);
vm.runInContext(sourceModule, context);
vm.runInContext(drawioSource, context);
const drawio = context.window.PaperBoardDrawio;
const boardSource = context.window.PaperBoardSource;

/** The host-side half of the compressed form: base64 → raw DEFLATE → percent-decoded XML. */
const inflate = base64 => decodeURIComponent(zlib.inflateRawSync(Buffer.from(String(base64).trim(), 'base64')).toString('utf8'));
const deflate = xml => Buffer.from(zlib.deflateRawSync(encodeURIComponent(xml))).toString('base64');
const WINDOW = { inflate };
/** The module runs in a vm realm, so its arrays and objects have their own prototypes. */
const plain = value => JSON.parse(JSON.stringify(value));

/** What the official draw.io MCP server writes through its `set_page` tool. */
const THEIR_FILE = `<mxfile host="app.diagrams.net"><diagram id="page-1" name="Page-1"><mxGraphModel dx="800" dy="600" grid="1" gridSize="10"><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="2" value="城市感知" style="rounded=1;whiteSpace=wrap;html=1;" vertex="1" parent="1"><mxGeometry x="120" y="80" width="160" height="60" as="geometry"/></mxCell><mxCell id="3" value="多源数据" style="rounded=0;whiteSpace=wrap;html=1;" vertex="1" parent="1"><mxGeometry x="400" y="240" width="160" height="60" as="geometry"/></mxCell><mxCell id="4" style="edgeStyle=orthogonalEdgeStyle;rounded=0;html=1;" edge="1" parent="1" source="2" target="3"><mxGeometry relative="1" as="geometry"/></mxCell></root></mxGraphModel></diagram></mxfile>`;

test('a file written by the official draw.io MCP server imports as our source document', async () => {
  const parsed = await drawio.parse(THEIR_FILE, WINDOW);
  assert.deepEqual(plain(parsed.counts), { nodes: 2, edges: 1, pages: 1 });
  assert.equal(parsed.source.schema, 'paper-library-board.v1');
  assert.equal(parsed.source.title, 'Page-1');
  assert.deepEqual(plain(parsed.source.nodes.map(node => [node.id, node.kind, node.text])), [
    ['2', 'concept', '城市感知'],
    ['3', 'rect', '多源数据'],
  ]);
  // Geometry survives: the position becomes a pin, the size a per-node override.
  assert.deepEqual(plain(parsed.source.nodes[0].pin), [120, 80]);
  assert.deepEqual(plain(parsed.style.node.byId['2']), { w: 160, h: 60 });
  assert.deepEqual(plain(parsed.style.layout.pins['3']), [400, 240]);
  // draw.io's orthogonal edge routing is our elbow.
  assert.equal(parsed.source.edges[0].kind, 'elbow');
  assert.deepEqual(plain(parsed.warnings), [], 'nothing about this file is guessed at or dropped');
});

test('a compressed page decodes, and the missing inflater is reported instead of guessed', async () => {
  const model = '<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="a" value="节点 A" style="rounded=1;" vertex="1" parent="1"><mxGeometry x="40" y="60" width="160" height="60" as="geometry"/></mxCell></root></mxGraphModel>';
  const file = `<mxfile><diagram id="p" name="压缩页">${deflate(model)}</diagram></mxfile>`;
  const parsed = await drawio.parse(file, WINDOW);
  assert.equal(parsed.source.title, '压缩页');
  assert.deepEqual(plain(parsed.source.nodes[0]), { id: 'a', kind: 'concept', text: '节点 A', pin: [40, 60] });
  assert.equal(parsed.pages[0].compressed, true);

  // Without an inflater the answer is a readable refusal, not a silent empty board.
  await assert.rejects(() => drawio.parse(file, {}), /需要宿主提供解压能力/);
  // A corrupt payload is reported as such.
  await assert.rejects(
    () => drawio.parse('<mxfile><diagram id="p">not-base64-at-all!!</diagram></mxfile>', WINDOW),
    /解压后的内容不是 XML|incorrect header|invalid/i,
  );
});

test('pages are addressable, and a document with no page is refused', async () => {
  const page = name => `<diagram id="${name}" name="${name}"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="n-${name}" value="${name}" vertex="1" parent="1"><mxGeometry x="0" y="0" width="100" height="40" as="geometry"/></mxCell></root></mxGraphModel></diagram>`;
  const file = `<mxfile>${page('one')}${page('two')}</mxfile>`;
  const list = await drawio.parse(file, WINDOW);
  assert.deepEqual(plain(list.pages.map(entry => entry.name)), ['one', 'two']);
  assert.equal(list.counts.pages, 2);
  assert.equal(list.source.nodes[0].id, 'n-one', 'the first page is the default');
  assert.equal((await drawio.parse(file, { ...WINDOW, page: 1 })).source.nodes[0].id, 'n-two', 'by index');
  assert.equal((await drawio.parse(file, { ...WINDOW, page: 'two' })).source.nodes[0].id, 'n-two', 'by name');
  await assert.rejects(() => drawio.parse(file, { ...WINDOW, page: 9 }), /找不到第 9 页/);
  await assert.rejects(() => drawio.parse('<html><body>nope</body></html>', WINDOW), /既没有 <mxfile> 的页，也没有 <mxGraphModel>/);
  await assert.rejects(() => drawio.parse('   ', WINDOW), /内容是空的/);
});

test('what draw.io has no concept of is carried in our own style keys, so a round trip is exact', async () => {
  const board = {
    schema: 1, title: '往返', origin: 'user', status: 'saved',
    nodes: [
      { id: 'n-a', kind: 'note', x: 40, y: 60, w: 220, h: 140, text: '便签 A\n第二行', origin: 'user' },
      { id: 'n-b', kind: 'paper', x: 400, y: 60, w: 260, h: 120, text: 'Paper A', origin: 'user', paper: { id: 'paper_a', title: 'Paper A', year: 2026, citekey: 'wang2026' } },
      { id: 'n-c', kind: 'diamond', x: 40, y: 300, w: 200, h: 120, text: '菱形', origin: 'user', color: '#4176e6' },
    ],
    edges: [
      { id: 'e-1', from: 'n-a', to: 'n-b', kind: 'arrow', relation: 'explains', label: '解释', origin: 'user' },
      { id: 'e-2', from: 'n-b', to: 'n-c', kind: 'elbow', arrow: 'both', dashed: true, angle: 45, origin: 'user', waypoints: [[500, 240], [520, 260]] },
      { id: 'e-3', from: 'n-c', to: 'n-a', kind: 'line', arrow: 'none', origin: 'user' },
    ],
  };
  const { xml, counts } = drawio.toDrawio(board);
  assert.deepEqual(plain(counts), { nodes: 3, edges: 3 });
  assert.match(xml, /^<mxfile host="app\.diagrams\.net"/);
  assert.match(xml, /<diagram id="page-1" name="往返">/);
  assert.match(xml, /&#10;/, 'a multi-line label is written the way draw.io writes it');

  const parsed = await drawio.parse(xml, WINDOW);
  assert.deepEqual(plain(parsed.warnings), []);
  assert.deepEqual(plain(parsed.source.nodes.map(node => [node.id, node.kind, node.text])), [
    ['n-a', 'note', '便签 A\n第二行'],
    ['n-b', 'paper', 'Paper A'],
    ['n-c', 'diamond', '菱形'],
  ]);
  assert.deepEqual(plain(parsed.source.nodes.map(node => node.pin)), [[40, 60], [400, 60], [40, 300]], 'every position survives');
  assert.equal(parsed.source.nodes[1].paper, 'paper_a', 'the catalog binding survives');
  assert.equal(parsed.source.nodes[1].year, 2026);
  assert.equal(parsed.source.nodes[1].citekey, 'wang2026');
  assert.equal(parsed.source.nodes[2].color, '#4176e6');
  // The source document has no edge-id field (the board model assigns `s-e1`…), so a draw.io
  // edge cell id legitimately does not survive the trip; everything it *can* carry does.
  assert.deepEqual(plain(parsed.source.edges[0]), { from: 'n-a', to: 'n-b', relation: 'explains', label: '解释' });
  assert.equal(parsed.source.edges[1].kind, 'elbow');
  assert.equal(parsed.source.edges[1].arrow, 'both');
  assert.equal(parsed.source.edges[1].dashed, true);
  assert.equal(parsed.source.edges[1].angle, 45, 'the edge angle is ours to keep');
  assert.deepEqual(plain(parsed.source.edges[1].waypoints), [[500, 240], [520, 260]]);
  assert.equal(parsed.source.edges[2].kind, 'line');
  assert.equal(parsed.source.edges[2].arrow, 'none');

  // The file we write is a file we accept, and it is exactly what the host validator accepts.
  const stored = validateBoard({ ...boardSource.fromSource(parsed.source, parsed.style).board, id: 'b-round-trip' });
  assert.equal(stored.nodes.length, 3);
  assert.equal(stored.edges.length, 3);
  assert.deepEqual(plain(stored.nodes.map(node => [node.x, node.y, node.w, node.h])), [
    [40, 60, 220, 140], [400, 60, 260, 120], [40, 300, 200, 120],
  ], 'positions and sizes survive our own export and the host validator');
  assert.equal(stored.nodes[1].paper.id, 'paper_a');
  assert.equal(stored.edges[0].relation, 'explains');
  assert.equal(stored.edges[1].arrow, 'both');
  assert.deepEqual(plain(stored.edges[1].waypoints), [[500, 240], [520, 260]]);
});

test('an AI proposal is still marked as one after a trip through draw.io', async () => {
  const board = {
    schema: 1, title: '提议', origin: 'user', status: 'saved',
    nodes: [
      { id: 'n-1', kind: 'rect', x: 0, y: 0, w: 120, h: 60, text: '读过的', origin: 'user' },
      { id: 'n-2', kind: 'concept', x: 200, y: 0, w: 120, h: 60, text: '机器提议的', origin: 'llm' },
    ],
    edges: [
      { id: 'e-1', from: 'n-1', to: 'n-2', kind: 'arrow', origin: 'llm' },
      { id: 'e-2', from: 'n-2', to: 'n-1', kind: 'arrow', origin: 'user' },
    ],
  };
  const parsed = await drawio.parse(drawio.toDrawio(board).xml, WINDOW);
  assert.deepEqual(plain(parsed.source.nodes.map(node => [node.id, node.proposed === true])), [['n-1', false], ['n-2', true]]);
  assert.deepEqual(plain(parsed.source.edges.map(edge => edge.proposed === true)), [true, false]);
  // The host's validator keeps the mark, so accepting or rejecting a proposal stays possible.
  const stored = validateBoard({ ...boardSource.fromSource(parsed.source, parsed.style).board, id: 'b-proposed' });
  assert.deepEqual(plain(stored.nodes.map(node => [node.id, node.origin])), [['n-1', 'user'], ['n-2', 'llm']]);
  assert.deepEqual(plain(stored.edges.map(edge => edge.origin)), ['llm', 'user']);
});

test('an imported file is exactly what the host validator accepts, and it renders', async () => {
  const parsed = await drawio.parse(THEIR_FILE, WINDOW);
  // `fromSource` is the one conversion the panel also uses: source document in, board out.
  const converted = boardSource.fromSource(parsed.source, parsed.style);
  // The host's own validator is the authority; a file we import must pass it unmodified.
  const stored = validateBoard({ ...converted.board, id: 'b-imported' });
  assert.equal(stored.nodes.length, 2);
  assert.equal(stored.edges.length, 1);
  assert.deepEqual(plain(stored.nodes.map(node => [node.x, node.y])), [[120, 80], [400, 240]], 'the pinned positions survive validation');
  assert.deepEqual(plain(stored.nodes.map(node => [node.w, node.h])), [[160, 60], [160, 60]], 'and so do the imported sizes');
});

test('anything the format carries that we do not model is reported, never invented', async () => {
  const file = `<mxfile><diagram id="p" name="告警"><mxGraphModel><root>
    <mxCell id="0"/><mxCell id="1" parent="0"/>
    <mxCell id="ok" value="好" vertex="1" parent="1"><mxGeometry x="10" y="10" width="100" height="40" as="geometry"/></mxCell>
    <mxCell id="swim" value="" style="shape=swimlane;" vertex="1" parent="1"><mxGeometry x="0" y="0" width="400" height="200" as="geometry"/></mxCell>
    <mxCell id="stencil" value="图标" style="shape=mxgraph.aws4.lambda;" vertex="1" parent="1"><mxGeometry x="200" y="10" width="60" height="60" as="geometry"/></mxCell>
    <mxCell id="graphic" value="" vertex="1" parent="1"/>
    <mxCell id="bad id!" value="坏" vertex="1" parent="1"><mxGeometry x="0" y="0" width="10" height="10" as="geometry"/></mxCell>
    <mxCell id="edge-away" value="" edge="1" parent="1" source="ok" target="missing"><mxGeometry relative="1" as="geometry"/></mxCell>
  </root></mxGraphModel></diagram></mxfile>`;
  const parsed = await drawio.parse(file, WINDOW);
  const text = parsed.warnings.join('\n');
  assert.match(text, /图形库形状 mxgraph\.aws4\.lambda 不是本画板的形状/, 'a stencil is named, not silently drawn as a box');
  assert.match(text, /形状 swimlane 按矩形导入/);
  assert.match(text, /没有几何信息/, 'a cell with no geometry says so');
  assert.match(text, /不符合本画板的命名规则/, 'an unusable id is refused with its line');
  assert.match(text, /端点不在这一页里/, 'a dangling edge is dropped and reported');
  assert.match(text, /第 \d+ 行/, 'and every complaint names its line');
  assert.equal(parsed.source.edges.length, 0, 'nothing dangling reaches the board');
  assert.equal(parsed.source.nodes.length, 4);
});

test('export refuses what draw.io cannot hold instead of writing a broken file', () => {
  assert.throws(() => drawio.toDrawio({ nodes: [{ id: 'bad id!', kind: 'rect', x: 0, y: 0, w: 10, h: 10 }], edges: [] }), /不符合 draw\.io 单元格的命名规则/);
  assert.throws(() => drawio.toDrawio({ nodes: [{ id: 'a', kind: 'rect', x: 0, y: 0, w: 10, h: 10 }], edges: [{ id: 'e', from: 'a', to: 'gone' }] }), /端点 gone 不在画板里/);
  // Two cells cannot share one id in draw.io, and renaming one silently would change the file.
  assert.throws(() => drawio.toDrawio({ nodes: [{ id: 'a', kind: 'rect', x: 0, y: 0, w: 10, h: 10 }], edges: [{ id: 'a', from: 'a', to: 'a' }] }), /标识 a 重复/);
  assert.throws(() => drawio.toDrawio(null), /需要一块画板/);
  // An edge from a source document has no id yet; exporting invents one instead of failing.
  const fromSource = drawio.toDrawio({ title: '无 id', nodes: [{ id: 'a', kind: 'rect', x: 0, y: 0, w: 10, h: 10 }, { id: 'e-1', kind: 'rect', x: 40, y: 0, w: 10, h: 10 }], edges: [{ from: 'a', to: 'e-1' }, { from: 'e-1', to: 'a' }] });
  assert.match(fromSource.xml, /<mxCell id="e-2"/, 'the generated id steps over a node that already holds it');
  assert.match(fromSource.xml, /<mxCell id="e-3"/);
  // A board with no edges or nodes is still a valid document.
  const empty = drawio.toDrawio({ title: '空', nodes: [], edges: [] });
  assert.match(empty.xml, /<mxCell id="1" parent="0" \/>/);
  assert.equal(empty.bounds, null);
});
