/** Mermaid import/export: the subset we understand, what we deliberately ignore, and the
 *  contract that a parsed diagram is exactly what the host validator accepts. */
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { validateBoard } from '../src/harness/board-store.mjs';

const moduleSource = await readFile(new URL('../web/board-mermaid.js', import.meta.url), 'utf8');
const sourceModule = await readFile(new URL('../web/board-source.js', import.meta.url), 'utf8');
const context = { window: {} };
vm.createContext(context);
vm.runInContext(moduleSource, context);
vm.runInContext(sourceModule, context);
const mermaid = context.window.PaperBoardMermaid;
const source = context.window.PaperBoardSource;

const kinds = parsed => Object.fromEntries(Array.from(parsed.source.nodes, node => [node.id, node.kind]));
const textOf = (parsed, id) => parsed.source.nodes.find(node => node.id === id)?.text;
const links = parsed => Array.from(parsed.source.edges, edge => `${edge.from}${edge.arrow === 'both' ? '<->' : edge.kind === 'line' ? '---' : edge.dashed ? '-.->' : '-->'}${edge.to}${edge.label ? `:${edge.label}` : ''}`);

test('shapes, labels, link styles and the diagram direction all reach our model', () => {
  const parsed = mermaid.parse(`flowchart LR
  A[数据采集] --> B{质量合格?}
  B -- 是 --> C([入库])
  B -. 否 .-> D>重新采集]
  C -->|去重| E[(数据集)]
  C & D --> F((发布))
  E --- F
  G[[归档]]
  H[/报告/]
  A <--> G
  B o--o H
`);
  assert.deepEqual(Array.from(parsed.warnings, warning => warning.message), ['圆形端点按双向箭头导入'], 'only the circle-endpoint approximation is reported');
  assert.equal(parsed.direction, 'lr');
  assert.deepEqual({ ...parsed.layout }, { mode: 'layered', direction: 'lr' });
  assert.equal(parsed.counts.nodes, 8);
  assert.equal(parsed.counts.edges, 9, 'one link per statement, with `C & D --> F` expanded to two');
  assert.deepEqual(kinds(parsed), { A: 'rect', B: 'diamond', C: 'rect', D: 'note', E: 'rect', F: 'ellipse', G: 'rect', H: 'rect' });
  assert.equal(textOf(parsed, 'A'), '数据采集');
  assert.equal(textOf(parsed, 'B'), '质量合格?');
  assert.deepEqual(links(parsed).sort(), [
    'A-->B', 'A<->G', 'B-.->D:否', 'B-->C:是', 'B<->H', 'C-->E:去重', 'C-->F', 'D-->F', 'E---F',
  ].sort());
  // A diagram's direction becomes the layout direction; the default is top to bottom.
  assert.equal(mermaid.parse('graph TD\n  A --> B').direction, 'tb');
  assert.equal(mermaid.parse('flowchart BT\n  A --> B').direction, 'bt');
  assert.equal(mermaid.parse('flowchart\n  A --> B').direction, 'tb');
  assert.equal(mermaid.parse('flowchart LR\n  direction RL\n  A --> B').direction, 'rl');
});

test('labels survive quoting, entities and line breaks, and ids are made safe', () => {
  const parsed = mermaid.parse(`flowchart TD
  a["带 空格 &amp; 符号的标签"] --> b["第一行<br/>第二行"]
  c["引号 &quot; 内"] --> b
  "quoted id" --> a
  node_1 --> a
`);
  assert.deepEqual(Array.from(parsed.warnings, warning => warning.message), [], 'nothing in this sample needed guessing');
  assert.equal(textOf(parsed, 'a'), '带 空格 & 符号的标签');
  assert.equal(textOf(parsed, 'b'), '第一行\n第二行');
  assert.equal(textOf(parsed, 'c'), '引号 " 内');
  assert.equal(parsed.source.nodes.some(node => node.id === 'quoted_id'), true, 'a quoted id becomes addressable');
  for (const node of parsed.source.nodes) assert.match(node.id, /^[A-Za-z0-9_-]{1,60}$/);
  assert.equal(new Set(parsed.source.nodes.map(node => node.id)).size, parsed.source.nodes.length, 'ids stay unique');
});

test('a chain of nodes becomes one edge per hop, and identical links are merged', () => {
  const parsed = mermaid.parse(`flowchart LR
  A --> B --> C
  A & B --> D
  C --> D
  D --> E
  A -- same --> D
  A -- same --> D
`);
  assert.equal(parsed.counts.nodes, 5);
  assert.deepEqual(links(parsed).sort(), ['A-->B', 'A-->D:same', 'A-->D', 'B-->C', 'B-->D', 'C-->D', 'D-->E'].sort());
  assert.equal(parsed.counts.duplicates, 1, 'the repeated statement is merged');
  assert.equal(parsed.warnings.some(warning => /重复连线已合并/.test(warning.message)), true);
});

test('what we deliberately do not model is reported with its line instead of guessed', () => {
  const parsed = mermaid.parse(`%% 注释里没有节点 --> X
flowchart TD
  A --> B %% trailing comment
  subgraph 一组
    B --> C
  end
  B ~~~ C
  B ==> C
  classDef big fill:#f00
  style B stroke:#333
  click A callback
  linkStyle 0 stroke:#000
`);
  assert.deepEqual(kinds(parsed), { A: 'concept', B: 'concept', C: 'concept' }, 'a node with no shape wrapper is a plain concept, and subgraph members are kept and flattened');
  assert.deepEqual(links(parsed).sort(), ['A-->B', 'B-->C'].sort(), 'the invisible link is dropped, and the thick restatement of B -> C merges into one arrow');
  const messages = parsed.warnings.map(warning => warning.message).join(' | ');
  assert.match(messages, /subgraph 已展开/);
  assert.match(messages, /看不见的连线（~~~）已跳过/);
  assert.match(messages, /粗线（==>）按普通箭头导入/);
  assert.match(messages, /已忽略 classDef、style、click、linkStyle/);
  assert.equal(parsed.counts.subgraphs, 1);
  assert.equal(parsed.warnings.every(warning => Number.isInteger(warning.line) && warning.line >= 1), true, 'every warning names a line');
});

test('unreadable input reports the line and the reason instead of inventing a diagram', () => {
  assert.equal(mermaid.parse('').counts.nodes, 0);
  assert.match(mermaid.parse('').warnings.map(warning => warning.message).join(' '), /没有找到 flowchart 或 graph 头部/);
  const notMermaid = mermaid.parse('A --> B');
  assert.equal(notMermaid.counts.nodes, 0, 'a diagram without a header is refused, not guessed');
  assert.equal(notMermaid.warnings[0].line, 1);
  const broken = mermaid.parse('flowchart TD\n  A[missing closer --> B');
  assert.equal(broken.source.edges.length, 0);
  assert.equal(broken.warnings[0].line, 2);
  assert.match(broken.warnings[0].message, /没有对应的/);
  const garbage = mermaid.parse('flowchart TD\n  ??? !!!');
  assert.equal(garbage.source.nodes.length, 0);
  assert.equal(garbage.warnings[0].line, 2);
  assert.match(garbage.warnings[0].message, /无法解析/);
});

test('a parsed diagram passes the host validator and the same layout path as a source file', () => {
  const parsed = mermaid.parse(`flowchart LR
  A[采集] --> B{合格?}
  B -- 是 --> C([入库])
  B --> D[复采]
  D --> B
`);
  const converted = source.fromSource(parsed.source, { layout: { mode: parsed.layout.mode, direction: parsed.layout.direction } });
  // The host is the authority for what can be stored: a diagram is not allowed to invent a shape.
  const validated = validateBoard({ ...converted.board, style: converted.style }, { id: 'b-000000000009' });
  assert.equal(validated.nodes.length, 4);
  assert.equal(validated.edges.length, 4);
  assert.equal(validated.nodes.every(node => Number.isFinite(node.x) && Number.isFinite(node.y)), true, 'every imported node is placed');
  assert.equal(validated.edges.find(edge => edge.from === 'B' && edge.to === 'C').label, '是');
  assert.equal(validated.style.layout.direction, 'lr');
  // A cyclic flowchart still lays out, because the reader's own layout survives cycles.
  assert.ok(validated.nodes.find(node => node.id === 'B').x > validated.nodes.find(node => node.id === 'A').x, 'an LR diagram flows left to right');
});

test('exporting a board produces Mermaid that parses back to the same graph', () => {
  const board = {
    id: 'b-000000000010', style: { layout: { mode: 'layered', direction: 'lr' } },
    nodes: [
      { id: 'start', kind: 'rect', x: 0, y: 0, w: 200, h: 100, text: '开始' },
      { id: 'check', kind: 'diamond', x: 0, y: 200, w: 200, h: 100, text: '合格?\n再看一眼' },
      { id: 'ship', kind: 'ellipse', x: 0, y: 400, w: 200, h: 100, text: '发布 "正式"' },
      { id: 'note', kind: 'note', x: 0, y: 600, w: 200, h: 100, text: '备注' },
    ],
    edges: [
      { id: 'e-1', from: 'start', to: 'check', kind: 'arrow' },
      { id: 'e-2', from: 'check', to: 'ship', kind: 'arrow', label: '是' },
      { id: 'e-3', from: 'check', to: 'note', kind: 'arrow', dashed: true, arrow: 'both' },
      { id: 'e-4', from: 'ship', to: 'note', kind: 'line' },
    ],
  };
  const { text, warnings } = mermaid.format(board);
  assert.deepEqual([...warnings], [], 'a fully representable board exports without a complaint');
  assert.match(text, /^flowchart LR\n/);
  const back = mermaid.parse(text);
  assert.deepEqual([...back.warnings], []);
  assert.equal(back.source.schema, mermaid.SOURCE_SCHEMA, 'the parser emits our own source document');
  assert.deepEqual(kinds(back), { start: 'rect', check: 'diamond', ship: 'ellipse', note: 'note' });
  assert.equal(textOf(back, 'check'), '合格?\n再看一眼', 'a line break survives as <br/>');
  assert.equal(textOf(back, 'ship'), '发布 "正式"');
  assert.deepEqual(links(back).sort(), ['start-->check', 'check-->ship:是', 'check<->note', 'ship---note'].sort(), 'arrow, label, dashed-both and plain line all come back');
  assert.equal(back.direction, 'lr');
  // Exporting the same graph twice is stable text.
  assert.equal(mermaid.format(board).text, text);
});
