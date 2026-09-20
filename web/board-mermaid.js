/**
 * Mermaid import and export for the whiteboard.
 *
 * Deliberately our own parser: the `mermaid` package ships a renderer (and dagre) that the
 * whiteboard does not need, and this plugin adds no runtime dependency. What is understood is
 * exactly what is written below; anything else is reported with its line number instead of
 * being guessed, and `%%` comments, `classDef`, `style`, `linkStyle`, `click` and `subgraph`
 * wrappers are accepted and ignored (subgraphs are flattened, and that is reported).
 *
 * The output is the whiteboard's own readable source document, so a parsed diagram goes through
 * the same path as a hand-written `board.json`: `fromSource` sizes the nodes, the host validator
 * checks it, and the existing 「校验并应用」 applies it.
 */
(function () {
  'use strict';

  const SOURCE_SCHEMA = 'paper-library-board.v1';
  const MERMAID_SCHEMA = 'paper-library-mermaid.v1';
  const LIMITS = Object.freeze({ nodes: 400, edges: 800, text: 2000, statements: 2000 });

  /** Shape wrappers, longest opener first so `([x])` wins over `(x)` and `[x]`. */
  const SHAPES = Object.freeze([
    ['([', '])', 'rect'], ['[[', ']]', 'rect'], ['[(', ')]', 'rect'],
    ['((', '))', 'ellipse'], ['{{', '}}', 'diamond'],
    ['[/', '/]', 'rect'], ['[\\', '\\]', 'rect'],
    ['[', ']', 'rect'], ['(', ')', 'rect'], ['{', '}', 'diamond'], ['>', ']', 'note'],
  ]);
  const DIRECTIONS = Object.freeze({ TB: 'tb', TD: 'tb', BT: 'bt', LR: 'lr', RL: 'rl' });
  /** Statements that carry styling or interaction we do not model; ignoring them is honest. */
  const IGNORED = /^(classDef|class|style|linkStyle|click|link\b|accTitle|accDescr|%%\{)/;

  const entity = value => value
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"').replace(/&#39;/gi, "'").replace(/&hellip;/gi, '…')
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)));

  /** Mermaid labels: quotes are wrapper punctuation, `<br/>` is a line break, entities are text. */
  function cleanLabel(value) {
    let text = String(value ?? '').trim();
    if ((text.startsWith('"') && text.endsWith('"') && text.length > 1) || (text.startsWith("'") && text.endsWith("'") && text.length > 1)) text = text.slice(1, -1);
    return entity(text).replace(/<br\s*\/?\s*>/gi, '\n').replace(/<[^>]+>/g, '').trim();
  }

  /** The identifier grammar our source files accept, kept stable across a round trip. */
  function safeId(raw, taken) {
    let id = String(raw ?? '').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 60) || 'node';
    if (taken.has(id)) { let index = 2; while (taken.has(`${id}_${index}`)) index += 1; id = `${id}_${index}`; }
    return id;
  }

  /** Index of the closer that matches the opener at `text[0]`, or -1. Quotes are skipped. */
  function closingIndex(text, open, close) {
    let depth = 0;
    for (let index = 0; index < text.length; index += 1) {
      const character = text[index];
      if (character === '"') { const end = text.indexOf('"', index + 1); if (end < 0) return -1; index = end; continue; }
      if (text.startsWith(open, index)) { depth += 1; index += open.length - 1; continue; }
      if (text.startsWith(close, index)) { depth -= 1; if (!depth) return index; index += close.length - 1; }
    }
    return -1;
  }

  /** One node reference: an id, an optional shape wrapper, and its label. */
  function readNode(text, at) {
    const match = /^\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_][A-Za-z0-9_-]*))/.exec(text.slice(at));
    if (!match) return null;
    const raw = match[1] ?? match[2] ?? match[3];
    let end = at + match[0].length;
    const rest = text.slice(end);
    for (const [open, close, kind] of SHAPES) {
      if (!rest.startsWith(open)) continue;
      const index = closingIndex(rest, open, close);
      if (index < 0) return { error: `节点 ${raw} 的 ${open} 没有对应的 ${close}` };
      return { raw, kind, label: cleanLabel(rest.slice(open.length, index)), end: end + index + close.length };
    }
    return { raw, kind: null, label: null, end };
  }

  /**
   * One link operator, including the label forms `-- text -->`, `-. text .->`, `== text ==>`
   * and the `-->|text|` form. Returns how the edge is drawn in our model.
   */
  function readOperator(text, at) {
    const raw = text.slice(at);
    const rest = raw.replace(/^\s+/, '');
    const offset = raw.length - rest.length;
    let index = 0, left = false, circle = false;
    if (rest.startsWith('<')) { left = true; index = 1; }
    // Mermaid's circle and cross endpoints: `o--o`, `x--x`, `o-->`, `--x`.
    if ((rest[index] === 'o' || rest[index] === 'x') && (rest[index + 1] === '-' || rest[index + 1] === '=')) { circle = true; left = circle; index += 1; }
    let family;
    if (rest.startsWith('-.', index)) { family = 'dotted'; index += 2; }
    else if (rest.startsWith('~~~', index)) { family = 'invisible'; index += 3; }
    else if (rest.startsWith('==', index)) { family = 'thick'; index += 2; if (rest[index] === '=') index += 1; }
    else if (rest.startsWith('--', index)) { family = 'normal'; index += 2; if (rest[index] === '-') index += 1; }
    else return null;
    // The embedded label form: `-- text -->`, `-. text .->`, `== text ==>`.
    let label = '';
    if (family !== 'invisible') {
      const embedded = /^\s*([^-=~>|][^-=~|]*?)\s*(?=--|\.-|==|>|\|)/.exec(rest.slice(index));
      if (embedded) { label = cleanLabel(embedded[1]); index += embedded[0].length; }
    }
    let arrow = 'none', dashed = family === 'dotted';
    if (rest.startsWith('-->', index) || rest.startsWith('==>', index) || rest.startsWith('.->', index)) { index += 3; arrow = 'forward'; }
    else if (rest.startsWith('->', index)) { index += 2; arrow = 'forward'; }
    else if (rest.startsWith('.-', index) || rest.startsWith('--', index) || rest.startsWith('==', index)) index += 2;
    else if (rest[index] === '>') { index += 1; arrow = 'forward'; }
    else if (rest[index] === 'o' || rest[index] === 'x') { circle = true; arrow = 'circle'; index += 1; }
    const pipe = /^\s*\|([^|]*)\|/.exec(rest.slice(index));
    if (pipe) { label = cleanLabel(pipe[1]) || label; index += pipe[0].length; }
    if (left) arrow = 'both';
    if (family === 'invisible') return { family, arrow: 'none', dashed: false, label, invisible: true, end: at + offset + index };
    return { family, arrow, dashed, label, invisible: false, end: at + offset + index, thick: family === 'thick', circle };
  }

  /** Statements are `nodes (link nodes)+`; `&` groups several nodes on either side. */
  function parseStatement(text, add, warn, line) {
    let index = 0;
    const groups = [], operators = [];
    while (index < text.length) {
      const group = [];
      for (;;) {
        const node = readNode(text, index);
        if (!node) break;
        if (node.error) { warn(line, node.error); return; }
        group.push(node);
        index = node.end;
        const amp = /^\s*&\s*/.exec(text.slice(index));
        if (!amp) break;
        index += amp[0].length;
      }
      if (!group.length) { const rest = text.slice(index).trim(); if (rest) warn(line, `无法解析「${rest.slice(0, 40)}」`); return; }
      for (const node of group) add(node, line);
      groups.push(group);
      const operator = readOperator(text, index);
      if (!operator) { const rest = text.slice(index).trim(); if (rest) warn(line, `无法解析连线「${rest.slice(0, 40)}」`); break; }
      operators.push(operator);
      index = operator.end;
    }
    operators.forEach((operator, link) => {
      if (operator.invisible) { warn(line, '看不见的连线（~~~）已跳过'); return; }
      if (operator.thick) warn(line, '粗线（==>）按普通箭头导入');
      if (operator.circle) warn(line, '圆形端点按双向箭头导入');
      for (const from of groups[link] ?? []) for (const to of groups[link + 1] ?? []) add(null, line, { from: from.raw, to: to.raw, ...operator });
    });
  }

  /**
   * Parse Mermaid text into the whiteboard's readable source document.
   * @param text - the pasted diagram.
   * @param options - `{ title }`.
   * @returns `{ source, direction, layout, warnings, counts }`; warnings carry a line number.
   */
  function parse(text, options = {}) {
    const warnings = [];
    const warn = (line, message) => { if (warnings.length < 20) warnings.push({ line, message }); };
    const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
    const nodes = new Map(), edges = [];
    let direction = 'tb', header = null, subgraphs = 0, ignored = new Set();
    const add = (node, line, edge) => {
      if (edge) {
        if (edges.length >= LIMITS.edges) { warn(line, `连线超过 ${LIMITS.edges} 条，其余已忽略`); return; }
        edges.push(edge);
        return;
      }
      if (!nodes.has(node.raw)) {
        if (nodes.size >= LIMITS.nodes) { warn(line, `节点超过 ${LIMITS.nodes} 个，其余已忽略`); return; }
        nodes.set(node.raw, { kind: node.kind, label: node.label });
        return;
      }
      const known = nodes.get(node.raw);
      if (node.kind) known.kind = node.kind;
      if (node.label !== null && node.label !== undefined && node.label !== '') known.label = node.label;
    };
    lines.forEach((raw, index) => {
      const line = index + 1;
      // `%%` comments run to the end of the line, but a `%%` inside a quoted label does not.
      let statement = raw;
      for (let at = statement.indexOf('%%'); at >= 0; at = statement.indexOf('%%', at + 2)) {
        const before = statement.slice(0, at);
        if ((before.match(/"/g) ?? []).length % 2 === 0) { statement = before; break; }
      }
      statement = statement.replace(/;+\s*$/, '').trim();
      if (!statement) return;
      if (header === null) {
        const first = /^(flowchart|graph)\s+(TB|TD|BT|LR|RL)?/i.exec(statement);
        if (first) { header = first[1].toLowerCase(); direction = DIRECTIONS[(first[2] ?? 'TB').toUpperCase()]; const rest = statement.slice(first[0].length).trim(); if (!rest) return; statement = rest; }
        else if (/^mindmap/i.test(statement)) { warn(line, '只看懂 flowchart / graph：mindmap 请先用缩进转成连线'); return; }
        else { warn(line, '第一行必须是 flowchart 或 graph（可带方向）'); return; }
      }
      if (/^subgraph\b/i.test(statement)) { subgraphs += 1; return; }
      if (/^end$/i.test(statement)) return;
      if (/^direction\s+(TB|TD|BT|LR|RL)$/i.test(statement)) { direction = DIRECTIONS[statement.split(/\s+/)[1].toUpperCase()]; return; }
      if (IGNORED.test(statement)) { ignored.add(statement.split(/[\s(]/)[0]); return; }
      parseStatement(statement, add, warn, line);
    });
    if (header === null) warn(1, '没有找到 flowchart 或 graph 头部');
    if (subgraphs) warn(1, `subgraph 已展开（${subgraphs} 个），分组不会被保留`);
    if (ignored.size) warn(1, `已忽略 ${[...ignored].join('、')}`);
    // Two statements can describe the same link (`C & D --> F` plus `D --> F`); our canvas
    // draws parallel edges on top of each other, so identical links are merged and reported.
    const seen = new Set();
    const deduped = [];
    let duplicates = 0;
    for (const edge of edges) {
      const key = `${edge.from}>${edge.to}:${edge.kind}:${edge.arrow ?? ''}:${edge.dashed ? 1 : 0}:${edge.label ?? ''}`;
      if (seen.has(key)) { duplicates += 1; continue; }
      seen.add(key);
      deduped.push(edge);
    }
    if (duplicates) warn(1, `${duplicates} 条重复连线已合并`);
    const taken = new Set();
    const idFor = new Map();
    for (const raw of nodes.keys()) { const id = safeId(raw, taken); taken.add(id); idFor.set(raw, id); }
    const source = {
      schema: SOURCE_SCHEMA,
      title: String(options.title ?? 'Mermaid 导入').slice(0, 200),
      nodes: [...nodes.entries()].map(([raw, node]) => ({ id: idFor.get(raw), kind: node.kind ?? 'concept', text: String(node.label ?? raw).slice(0, LIMITS.text) })),
      edges: deduped.map(edge => {
        const shaped = { from: idFor.get(edge.from), to: idFor.get(edge.to) };
        shaped.kind = edge.arrow === 'none' ? 'line' : 'arrow';
        if (edge.arrow === 'both') shaped.arrow = 'both';
        if (edge.dashed) shaped.dashed = true;
        if (edge.label) shaped.label = edge.label.slice(0, 200);
        return shaped;
      }).filter(edge => edge.from && edge.to && edge.from !== edge.to),
    };
    return {
      schema: MERMAID_SCHEMA,
      source,
      direction,
      layout: { mode: 'layered', direction },
      warnings,
      counts: { nodes: source.nodes.length, edges: source.edges.length, subgraphs, ignored: [...ignored], duplicates },
    };
  }

  /** A Mermaid label that survives a round trip: quotes, newlines and statement characters. */
  function labelFor(text) {
    // Escape first, then add `<br/>`: the other order would escape the line break it just made.
    const escaped = String(text ?? '').replace(/["<>[\]{}()|]/g, character => ({ '"': '&quot;', '<': '&lt;', '>': '&gt;' })[character] ?? `&#${character.charCodeAt(0)};`);
    const value = escaped.replace(/\n/g, '<br/>');
    // Quote only when the label would otherwise break the statement; CJK reads better bare.
    const unsafe = !value.length || value.trim() !== value || /["<>[\]{}()|&;]/.test(value);
    return unsafe ? `"${value}"` : value;
  }

  /**
   * Write a board as Mermaid text, so a canvas can be pasted into a README.
   * @param board - the stored board record.
   * @returns `{ text, warnings }`.
   */
  function format(board) {
    const warnings = [];
    const shape = node => node.kind === 'ellipse' ? [`((`, `))`] : node.kind === 'diamond' ? ['{', '}'] : node.kind === 'note' ? ['>', ']'] : ['[', ']'];
    const lines = [`flowchart ${({ tb: 'TD', bt: 'BT', lr: 'LR', rl: 'RL' })[board.style?.layout?.direction ?? 'tb'] ?? 'TD'}`];
    const idFor = new Map();
    const taken = new Set();
    for (const node of board.nodes) { const id = safeId(node.id, taken); taken.add(id); idFor.set(node.id, id); }
    for (const node of board.nodes) {
      const [open, close] = shape(node);
      const text = labelFor(node.text || node.paper?.title || node.id);
      lines.push(`  ${idFor.get(node.id)}${open}${text}${close}`);
    }
    for (const edge of board.edges) {
      const from = idFor.get(edge.from), to = idFor.get(edge.to);
      if (!from || !to) { warnings.push(`连线 ${edge.id} 的端点在节点表中缺失，已跳过`); continue; }
      const label = edge.label ?? (edge.relation && edge.relation !== 'related' ? edge.relation : '');
      const arrow = edge.arrow === 'both' ? 'both' : edge.arrow === 'none' || edge.kind === 'line' ? 'none' : 'forward';
      const middle = label ? `|${String(label).replace(/\|/g, '&#124;')}|` : '';
      const link = arrow === 'none' ? (edge.dashed ? '-.-' : '---') : arrow === 'both' ? (edge.dashed ? '<-.->' : '<-->') : (edge.dashed ? '-.->' : '-->');
      lines.push(`  ${from} ${link}${middle} ${to}`);
      if (edge.kind === 'elbow' && edge.waypoints?.length) warnings.push(`连线 ${edge.id} 的拐点无法表达，已按直线导出`);
    }
    return { text: `${lines.join('\n')}\n`, warnings };
  }

  const api = { MERMAID_SCHEMA, SOURCE_SCHEMA, LIMITS, DIRECTIONS, parse, format, cleanLabel, safeId };
  if (typeof window !== 'undefined') window.PaperBoardMermaid = Object.freeze(api);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
