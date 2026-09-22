/**
 * draw.io (`.drawio` / mxGraph XML) import and export for the whiteboard.
 *
 * This is our own implementation of the format, written after reading how the official draw.io
 * MCP tool server handles the same files (`jgraph/drawio-mcp`, Apache-2.0): a `.drawio` file is
 * `<mxfile>` holding one `<diagram>` per page, and a page body is either plain `<mxGraphModel>`
 * XML or draw.io's compressed form — `encodeURIComponent(xml)` → raw DEFLATE → base64. Both forms
 * are read here, and only the plain form is written, because our whole project keeps its on-disk
 * artefacts readable and diffable.
 *
 * Nothing is guessed: what is understood is the mapping below, everything else is reported as a
 * warning with its line number. Importing produces the whiteboard's **own readable source document
 * plus style sidecar** — the same shape the whiteboard already edits, validates and applies — so a
 * `.drawio` file travels the existing 「校验并应用」 path instead of a second write path.
 *
 * Geometry maps onto what our source format already carries: `x`/`y` become the node's `pin`
 * (a pinned position), `width`/`height` become a size override in `style.node.byId`, and edge bend
 * points become `waypoints`.
 *
 * The compressed form needs an inflater, which the host supplies (`inflate`): the browser passes
 * one built on `DecompressionStream`, the tests one built on `node:zlib`. That keeps this module
 * free of any dependency and free of the DOM.
 */
(function () {
  'use strict';

  const SOURCE_SCHEMA = 'paper-library-board.v1';
  const STYLE_SCHEMA = 'paper-library-board-style.v1';
  /** Keys we add to a draw.io style so a round trip through draw.io cannot lose what draw.io has
   *  no concept of: our node kinds, the catalog binding, the relation word and the edge angle.
   *  Unknown style keys are preserved verbatim by draw.io, which is what makes that work. */
  const KEYS = Object.freeze({ kind: 'plbKind', paper: 'plbPaper', paperTitle: 'plbPaperTitle', paperYear: 'plbPaperYear', paperCitekey: 'plbPaperCitekey', relation: 'plbRelation', angle: 'plbAngle', proposed: 'plbProposed' });
  const LIMITS = Object.freeze({ nodes: 400, edges: 800, text: 2000, label: 200, waypoints: 8, pages: 200, characters: 8 * 1024 * 1024 });
  const NODE_KINDS = Object.freeze(['text', 'note', 'concept', 'paper', 'rect', 'ellipse', 'diamond']);
  const EDGE_KINDS = Object.freeze(['arrow', 'line', 'elbow']);
  const ARROWS = Object.freeze(['forward', 'none', 'both']);
  const RELATIONS = Object.freeze(['related', 'supports', 'contradicts', 'cites', 'explains', 'extends']);

  const fail = message => { throw new Error(message); };
  const identifier = value => /^[A-Za-z0-9_-]{1,60}$/.test(String(value ?? ''));

  // ── XML ───────────────────────────────────────────────────────────────────────────────────────
  /**
   * A tag scanner, not a general XML parser: mxGraph documents are flat and regular (elements,
   * attributes, text, self-closing tags), and the whiteboard adds no XML dependency. Offsets are
   * kept so every complaint can name the line it came from.
   */
  function scan(xml) {
    const tags = [];
    for (let index = 0; index < xml.length; index++) {
      if (xml[index] !== '<') continue;
      if (xml.startsWith('<!--', index)) { const end = xml.indexOf('-->', index + 4); index = end < 0 ? xml.length : end + 2; continue; }
      if (xml.startsWith('<![CDATA[', index)) { const end = xml.indexOf(']]>', index + 9); index = end < 0 ? xml.length : end + 2; continue; }
      if (xml.startsWith('<?', index) || xml.startsWith('<!', index)) { const end = xml.indexOf('>', index); index = end < 0 ? xml.length : end; continue; }
      const end = xml.indexOf('>', index);
      if (end < 0) break;
      const raw = xml.slice(index + 1, end);
      const closing = raw.startsWith('/');
      const selfClosing = raw.endsWith('/');
      const body = raw.replace(/^\//, '').replace(/\/$/, '');
      const name = (body.match(/^[^\s]+/) ?? [''])[0];
      const attributes = {};
      for (const match of body.matchAll(/([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*"([^"]*)"/g)) attributes[match[1]] = decodeEntities(match[2]);
      tags.push({ name, attributes, closing, selfClosing, offset: index });
      index = end;
    }
    return tags;
  }

  const ENTITIES = Object.freeze({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' });
  /** draw.io writes multi-line labels as `&#10;`, so numeric references have to be decoded too. */
  function decodeEntities(value) {
    return String(value).replace(/&(#x?[0-9A-Fa-f]+|[A-Za-z]+);/g, (whole, entity) => {
      if (entity[0] === '#') {
        const code = entity[1] === 'x' || entity[1] === 'X' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
      }
      return ENTITIES[entity] ?? whole;
    });
  }
  const escapeXml = value => String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
    .replace(/\n/g, '&#10;');

  const lineOf = (xml, offset) => xml.slice(0, offset).split('\n').length;

  // ── styles ────────────────────────────────────────────────────────────────────────────────────
  /** `rounded=1;whiteSpace=wrap;html=1;` → a plain object. Later keys win, as draw.io behaves. */
  function parseStyle(raw) {
    const style = {};
    for (const part of String(raw ?? '').split(';')) {
      if (!part) continue;
      const equals = part.indexOf('=');
      if (equals < 0) style[part.trim()] = '1';
      else style[part.slice(0, equals).trim()] = part.slice(equals + 1);
    }
    return style;
  }

  /** The kind we draw for a draw.io style. Our own key wins, so a round trip is exact. */
  function kindOf(style, warnings, where) {
    if (style[KEYS.kind]) {
      if (NODE_KINDS.includes(style[KEYS.kind])) return style[KEYS.kind];
      warnings.push(`${where}：未知的形状标记 ${style[KEYS.kind]}，按矩形导入。`);
      return 'rect';
    }
    const shape = style.shape ?? '';
    if (shape === 'note' || shape.startsWith('note')) return 'note';
    if (shape === 'ellipse') return 'ellipse';
    if (shape === 'rhombus') return 'diamond';
    if (shape === 'text') return 'text';
    if (shape && shape.startsWith('mxgraph.')) { warnings.push(`${where}：图形库形状 ${shape} 不是本画板的形状，按矩形导入。`); return 'rect'; }
    if (shape && !['rectangle', 'rect', 'process', 'cylinder', 'cloud', 'actor', 'document'].includes(shape)) warnings.push(`${where}：形状 ${shape} 按矩形导入。`);
    if (style.text === '1' && style.fillColor === 'none' && style.strokeColor === 'none') return 'text';
    if (style.rounded === '1') return 'concept';
    return 'rect';
  }

  const edgeKindOf = style => {
    if (EDGE_KINDS.includes(style[KEYS.kind])) return style[KEYS.kind];
    if (style.edgeStyle === 'orthogonalEdgeStyle' || style.edgeStyle === 'elbowEdgeStyle') return 'elbow';
    if (style.endArrow === 'none' && style.startArrow === 'none') return 'line';
    return 'arrow';
  };
  const arrowOf = style => {
    const end = style.endArrow ?? 'classic';
    const start = style.startArrow ?? 'none';
    if (end === 'none' && start !== 'none') return 'both';
    if (end === 'none' && start === 'none') return 'none';
    return start !== 'none' ? 'both' : 'forward';
  };

  /** Our node/edge → the draw.io style string that draws it, plus the keys only we read. */
  function nodeStyleOf(node, colors) {
    const parts = ['whiteSpace=wrap', 'html=1'];
    if (node.kind === 'note') parts.unshift('shape=note', 'boundedLbl=1');
    else if (node.kind === 'ellipse') parts.unshift('shape=ellipse', 'perimeter=ellipsePerimeter');
    else if (node.kind === 'diamond') parts.unshift('shape=rhombus', 'perimeter=rhombusPerimeter');
    else if (node.kind === 'text') parts.unshift('text', 'strokeColor=none', 'fillColor=none', 'align=left', 'verticalAlign=top');
    else if (node.kind === 'concept' || node.kind === 'paper') parts.unshift('rounded=1', 'arcSize=12');
    else parts.unshift('rounded=0');
    if (node.color) parts.push(`strokeColor=${node.color}`);
    else if (colors?.[node.kind]) parts.push(`strokeColor=${colors[node.kind]}`);
    parts.push(`${KEYS.kind}=${node.kind}`);
    // The live board says `origin: 'llm'`, the source document says `proposed: true`; either way
    // a machine-written element stays marked after a trip through draw.io.
    if (node.proposed === true || node.origin === 'llm') parts.push(`${KEYS.proposed}=1`);
    if (node.paper) {
      parts.push(`${KEYS.paper}=${node.paper.id}`);
      if (node.paper.title) parts.push(`${KEYS.paperTitle}=${node.paper.title.replace(/[;=]/g, ' ')}`);
      if (node.paper.year) parts.push(`${KEYS.paperYear}=${node.paper.year}`);
      if (node.paper.citekey) parts.push(`${KEYS.paperCitekey}=${node.paper.citekey.replace(/[;=]/g, ' ')}`);
    }
    return parts.join(';') + ';';
  }

  function edgeStyleOf(edge) {
    const parts = [];
    const kind = edge.kind ?? 'arrow';
    if (kind === 'elbow') parts.push('edgeStyle=orthogonalEdgeStyle', 'rounded=0', 'jettySize=auto', 'orthogonalLoop=1');
    else if (kind === 'line') parts.push('edgeStyle=none');
    else parts.push('edgeStyle=none');
    const arrow = edge.arrow ?? 'forward';
    parts.push(`endArrow=${arrow === 'none' ? 'none' : 'classic'}`);
    if (arrow === 'both') parts.push('startArrow=classic');
    if (edge.dashed) parts.push('dashed=1');
    parts.push(`${KEYS.kind}=${kind}`);
    if (edge.relation) parts.push(`${KEYS.relation}=${edge.relation}`);
    if (edge.proposed === true || edge.origin === 'llm') parts.push(`${KEYS.proposed}=1`);
    if (edge.angle && edge.angle !== 90) parts.push(`${KEYS.angle}=${edge.angle}`);
    return parts.join(';') + ';';
  }

  // ── pages ─────────────────────────────────────────────────────────────────────────────────────
  const compressed = body => { const trimmed = String(body).trim(); return trimmed.length > 0 && !trimmed.startsWith('<'); };

  /** Page bodies in document order. A bare `<mxGraphModel>` counts as a single unnamed page. */
  function pages(xml) {
    const tags = scan(xml);
    const found = [];
    for (let index = 0; index < tags.length; index++) {
      const tag = tags[index];
      if (tag.name !== 'diagram' || tag.closing) continue;
      if (tag.selfClosing) { found.push({ index: found.length, id: tag.attributes.id ?? null, name: tag.attributes.name ?? null, body: '', offset: tag.offset }); continue; }
      const close = tags.findIndex((candidate, position) => position > index && candidate.name === 'diagram' && candidate.closing);
      if (close < 0) fail('文件里的 <diagram> 没有结束标签。');
      const start = xml.indexOf('>', tag.offset) + 1;
      const body = xml.slice(start, tags[close].offset);
      found.push({ index: found.length, id: tag.attributes.id ?? null, name: tag.attributes.name ?? null, body, offset: tag.offset });
      index = close;
    }
    if (found.length) return found;
    const model = tags.find(tag => tag.name === 'mxGraphModel' && !tag.closing);
    if (model) return [{ index: 0, id: null, name: null, body: xml, offset: model.offset }];
    fail('这不像 draw.io 文件：既没有 <mxfile> 的页，也没有 <mxGraphModel>。');
  }

  // ── import ────────────────────────────────────────────────────────────────────────────────────
  /**
   * `parse(xml, { inflate, page })` → `{ source, style, warnings, counts, pages }`.
   *
   * `inflate(base64)` resolves the decoded page XML and is required only for compressed pages:
   * the browser passes a `DecompressionStream('deflate-raw')` implementation and the tests a
   * `zlib.inflateRawSync` one, so this module needs neither the DOM nor a dependency.
   */
  async function parse(xml, options = {}) {
    if (typeof xml !== 'string' || !xml.trim()) fail('draw.io 内容是空的。');
    if (xml.length > LIMITS.characters) fail(`draw.io 文件超过 ${LIMITS.characters} 个字符。`);
    const list = pages(xml);
    if (list.length > LIMITS.pages) fail(`draw.io 文件包含 ${list.length} 页，超过 ${LIMITS.pages} 页。`);
    const wanted = options.page ?? 0;
    const page = typeof wanted === 'number'
      ? list[wanted]
      : list.find(entry => entry.id === wanted || entry.name === wanted);
    if (!page) fail(`找不到第 ${wanted} 页（共 ${list.length} 页）。`);

    let body = page.body;
    if (compressed(body)) {
      if (typeof options.inflate !== 'function') fail('这一页是 draw.io 的压缩格式，需要宿主提供解压能力（inflate）。');
      body = await options.inflate(body.trim());
      if (typeof body !== 'string' || !body.trim().startsWith('<')) fail('解压后的内容不是 XML。');
    }

    const warnings = [];
    const tags = scan(body);
    const nodes = [], edges = [], sizes = {}, pins = {};
    const ids = new Set();
    const where = offset => `第 ${lineOf(body, offset)} 行`;

    for (let index = 0; index < tags.length; index++) {
      const tag = tags[index];
      if (tag.name !== 'mxCell' || tag.closing) continue;
      const attributes = tag.attributes;
      const rawId = attributes.id;
      const isVertex = attributes.vertex === '1';
      const isEdge = attributes.edge === '1';
      if (!isVertex && !isEdge) continue;
      if (!identifier(rawId)) { warnings.push(`${where(tag.offset)}：单元格 ${rawId ?? '(无 id)'} 的标识不符合本画板的命名规则，已跳过。`); continue; }
      if (ids.has(rawId)) { warnings.push(`${where(tag.offset)}：标识 ${rawId} 重复，已跳过后一个。`); continue; }
      // A cell's geometry is its own immediate child — either self-closing or wrapping
      // <mxPoint>s. Searching further ahead would let a cell that has no geometry take a later
      // cell's, and a self-closing cell has no children at all.
      const geometryStart = tag.selfClosing || tags[index + 1]?.name !== 'mxGeometry' ? -1 : index + 1;
      const geometry = geometryStart < 0 ? null : tags[geometryStart];
      const geometryEnd = !geometry || geometry.selfClosing ? geometryStart : tags.findIndex((candidate, position) => position > geometryStart && candidate.name === 'mxGeometry' && candidate.closing);
      const inner = !geometry || geometry.selfClosing || geometryEnd < 0 ? [] : tags.slice(geometryStart + 1, geometryEnd);
      const style = parseStyle(attributes.style);

      if (isVertex) {
        if (nodes.length >= LIMITS.nodes) { warnings.push(`${where(tag.offset)}：超过 ${LIMITS.nodes} 个节点，已跳过其余节点。`); break; }
        const kind = kindOf(style, warnings, where(tag.offset));
        const text = String(attributes.value ?? '').slice(0, LIMITS.text);
        const entry = { id: rawId, kind };
        if (text) entry.text = text;
        if (style[KEYS.paper]) { entry.paper = style[KEYS.paper]; entry.kind = 'paper'; if (text) entry.paperTitle = text; }
        if (style[KEYS.paperYear] && /^\d+$/.test(style[KEYS.paperYear])) entry.year = Number(style[KEYS.paperYear]);
        if (style[KEYS.paperCitekey]) entry.citekey = style[KEYS.paperCitekey];
        if (style[KEYS.proposed] === '1') entry.proposed = true;
        const stroke = style.strokeColor && /^#[0-9a-fA-F]{6}$/.test(style.strokeColor) ? style.strokeColor.toLowerCase() : null;
        if (stroke) entry.color = stroke;
        const x = Number(geometry?.attributes.x), y = Number(geometry?.attributes.y);
        const w = Number(geometry?.attributes.width), h = Number(geometry?.attributes.height);
        if (Number.isFinite(x) && Number.isFinite(y) && (x !== 0 || y !== 0)) entry.pin = [round(x), round(y)];
        else if (Number.isFinite(x) && Number.isFinite(y)) entry.pin = [0, 0];
        if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) sizes[rawId] = { w: round(w), h: round(h) };
        if (!geometry) warnings.push(`${where(tag.offset)}：节点 ${rawId} 没有几何信息，将使用默认尺寸。`);
        nodes.push(entry);
        ids.add(rawId);
        continue;
      }

      if (edges.length >= LIMITS.edges) { warnings.push(`${where(tag.offset)}：超过 ${LIMITS.edges} 条连线，已跳过其余连线。`); break; }
      const from = attributes.source, to = attributes.target;
      if (!identifier(from) || !identifier(to)) { warnings.push(`${where(tag.offset)}：连线 ${rawId} 的端点不是本画板的节点，已跳过。`); continue; }
      const entry = { from, to };
      const kind = edgeKindOf(style);
      if (kind !== 'arrow') entry.kind = kind;
      const arrow = arrowOf(style);
      if (arrow !== 'forward') entry.arrow = arrow;
      if (style.dashed === '1') entry.dashed = true;
      if (style[KEYS.relation] && RELATIONS.includes(style[KEYS.relation])) entry.relation = style[KEYS.relation];
      if (style[KEYS.proposed] === '1') entry.proposed = true;
      const angle = Number(style[KEYS.angle]);
      if (Number.isFinite(angle) && angle >= 30 && angle <= 90 && Number.isInteger(angle) && angle !== 90) entry.angle = angle;
      const label = String(attributes.value ?? '').slice(0, LIMITS.label);
      if (label) entry.label = label;
      const points = inner.filter(candidate => candidate.name === 'mxPoint')
        .map(point => [round(Number(point.attributes.x)), round(Number(point.attributes.y))])
        .filter(point => point.every(Number.isFinite));
      if (points.length) {
        if (points.length > LIMITS.waypoints) { warnings.push(`${where(tag.offset)}：连线 ${rawId} 有 ${points.length} 个拐点，只保留前 ${LIMITS.waypoints} 个。`); }
        entry.waypoints = points.slice(0, LIMITS.waypoints);
      }
      edges.push(entry);
      ids.add(rawId);
      index = geometryEnd > index ? geometryEnd : index;
    }

    const known = new Set(nodes.map(node => node.id));
    const kept = edges.filter(edge => {
      if (known.has(edge.from) && known.has(edge.to)) return true;
      warnings.push(`连线 ${edge.from} → ${edge.to} 的端点不在这一页里，已跳过。`);
      return false;
    });
    if (!nodes.length) warnings.push('这一页没有任何节点。');

    const source = { schema: SOURCE_SCHEMA, title: String(page.name ?? 'draw.io 导入').slice(0, 200), nodes, edges: kept };
    const style = { schema: STYLE_SCHEMA };
    if (Object.keys(sizes).length) style.node = { byId: sizes };
    if (Object.keys(sizes).length) style.layout = { mode: 'tree', direction: 'lr', pins };
    // A page whose nodes are all pinned has no free nodes to arrange; keeping the pins is what
    // preserves the layout the reader drew in draw.io.
    for (const node of nodes) if (node.pin) pins[node.id] = node.pin;
    if (!Object.keys(pins).length) delete style.layout;

    return { source, style, warnings, pages: list.map(entry => ({ index: entry.index, id: entry.id, name: entry.name, compressed: compressed(entry.body) })), counts: { nodes: nodes.length, edges: kept.length, pages: list.length } };
  }

  const round = value => Math.round(value * 100) / 100;

  // ── export ────────────────────────────────────────────────────────────────────────────────────
  /**
   * `toDrawio(board, options)` → a one-page `.drawio` document (plain XML, never compressed).
   *
   * Node ids are reused verbatim — both formats already require the same identifier grammar — so a
   * board that came from draw.io goes back with its cell ids intact and stays diffable. Edge cell
   * ids are ours to invent when the board came from a source document, which carries no edge ids.
   */
  function toDrawio(board, options = {}) {
    if (!board || typeof board !== 'object') fail('需要一块画板才能导出。');
    const nodes = Array.isArray(board.nodes) ? board.nodes : [];
    const edges = Array.isArray(board.edges) ? board.edges : [];
    if (nodes.length > LIMITS.nodes) fail(`画板节点超过 ${LIMITS.nodes} 个，无法导出为 draw.io。`);
    if (edges.length > LIMITS.edges) fail(`画板连线超过 ${LIMITS.edges} 条，无法导出为 draw.io。`);
    const title = String(board.title ?? '未命名画板').slice(0, 200);
    const bounds = boundsOf(nodes);
    const diagramId = options.diagramId ?? 'page-1';
    // draw.io identifies every cell, so ids have to be unique across nodes and edges alike, and
    // `0`/`1` are the two cells draw.io itself owns. A collision is refused, never renamed: a
    // silently changed cell id would change the file's identity on the next import.
    const taken = new Set(['0', '1']);
    const known = new Set();
    for (const node of nodes) {
      if (!identifier(node.id)) fail(`节点标识 ${node.id} 不符合 draw.io 单元格的命名规则。`);
      if (taken.has(node.id)) fail(`标识 ${node.id} 重复，无法导出为 draw.io。`);
      taken.add(node.id);
      known.add(node.id);
    }
    const freeEdgeId = () => { let index = 1; while (taken.has(`e-${index}`)) index += 1; return `e-${index}`; };
    const lines = [];
    lines.push('<mxfile host="app.diagrams.net" agent="dsh-paper-library">');
    lines.push(`  <diagram id="${escapeXml(diagramId)}" name="${escapeXml(title)}">`);
    lines.push('    <mxGraphModel dx="1100" dy="800" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="1169" pageHeight="826" math="0" shadow="0">');
    lines.push('      <root>');
    lines.push('        <mxCell id="0" />');
    lines.push('        <mxCell id="1" parent="0" />');
    for (const node of nodes) {
      const style = nodeStyleOf(node, options.colors);
      lines.push(`        <mxCell id="${escapeXml(node.id)}" value="${escapeXml(node.text ?? '')}" style="${escapeXml(style)}" vertex="1" parent="1">`);
      lines.push(`          <mxGeometry x="${round(node.x ?? 0)}" y="${round(node.y ?? 0)}" width="${round(node.w ?? 120)}" height="${round(node.h ?? 60)}" as="geometry" />`);
      lines.push('        </mxCell>');
    }
    for (const [position, edge] of edges.entries()) {
      let id = '';
      if (edge.id !== undefined && edge.id !== null && edge.id !== '') {
        if (!identifier(edge.id)) fail(`连线标识 ${edge.id} 不符合 draw.io 单元格的命名规则。`);
        if (taken.has(edge.id)) fail(`标识 ${edge.id} 重复，无法导出为 draw.io。`);
        id = edge.id;
      } else id = freeEdgeId();
      taken.add(id);
      for (const endpoint of [edge.from, edge.to]) {
        if (!identifier(endpoint)) fail(`连线 ${id} 的端点标识 ${endpoint} 不符合 draw.io 单元格的命名规则。`);
        if (!known.has(endpoint)) fail(`连线 ${id} 的端点 ${endpoint} 不在画板里，无法导出为 draw.io。`);
      }
      const style = edgeStyleOf(edge);
      const label = edge.label ?? '';
      const waypoints = edge.waypoints ?? [];
      if (!waypoints.length) {
        lines.push(`        <mxCell id="${escapeXml(id)}" value="${escapeXml(label)}" style="${escapeXml(style)}" edge="1" parent="1" source="${escapeXml(edge.from)}" target="${escapeXml(edge.to)}">`);
        lines.push('          <mxGeometry relative="1" as="geometry" />');
        lines.push('        </mxCell>');
        continue;
      }
      lines.push(`        <mxCell id="${escapeXml(id)}" value="${escapeXml(label)}" style="${escapeXml(style)}" edge="1" parent="1" source="${escapeXml(edge.from)}" target="${escapeXml(edge.to)}">`);
      lines.push('          <mxGeometry relative="1" as="geometry">');
      lines.push('            <Array as="points">');
      for (const point of waypoints.slice(0, LIMITS.waypoints)) {
        lines.push(`              <mxPoint x="${round(point[0])}" y="${round(point[1])}" />`);
      }
      lines.push('            </Array>');
      lines.push('          </mxGeometry>');
      lines.push('        </mxCell>');
    }
    lines.push('      </root>');
    lines.push('    </mxGraphModel>');
    lines.push('  </diagram>');
    lines.push('</mxfile>');
    return { xml: lines.join('\n') + '\n', counts: { nodes: nodes.length, edges: edges.length }, bounds };
  }

  function boundsOf(nodes) {
    if (!nodes.length) return null;
    const x = Math.min(...nodes.map(node => Number(node.x ?? 0)));
    const y = Math.min(...nodes.map(node => Number(node.y ?? 0)));
    const right = Math.max(...nodes.map(node => Number(node.x ?? 0) + Number(node.w ?? 0)));
    const bottom = Math.max(...nodes.map(node => Number(node.y ?? 0) + Number(node.h ?? 0)));
    return { x: round(x), y: round(y), w: round(right - x), h: round(bottom - y) };
  }

  /** Browser inflater: draw.io's compressed page is base64 → raw DEFLATE → percent-encoded XML. */
  async function browserInflate(base64) {
    if (typeof DecompressionStream !== 'function') fail('这个浏览器不支持解压 draw.io 的压缩页。');
    const binary = atob(String(base64));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    const text = await new Response(stream).text();
    try { return decodeURIComponent(text); } catch { return text; }
  }

  const api = { SOURCE_SCHEMA, STYLE_SCHEMA, KEYS, LIMITS, parse, toDrawio, parseStyle, kindOf, edgeKindOf, arrowOf, scan, decodeEntities, escapeXml, browserInflate };
  if (typeof window !== 'undefined') window.PaperBoardDrawio = Object.freeze(api);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
