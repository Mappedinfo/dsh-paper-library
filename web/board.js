/* Literature whiteboard.
 *
 * A self-contained SVG canvas: no drawing library, no new dependency. Geometry and
 * model edits are pure functions over the plain board object the host stores, so
 * they are testable without a browser and the persisted shape stays identical to
 * what `board-store.mjs` validates. The panel only exists while its view is open.
 */
(function () {
  'use strict';
  const NS = 'http://www.w3.org/2000/svg';
  const LIMITS = Object.freeze({
    nodes: 400, edges: 800, undo: 50, text: 2000, title: 200, label: 200,
    zoomMin: 0.2, zoomMax: 4, coordinate: 1000000, saveDelay: 700, handle: 9, hit: 10,
  });
  const NODE_KINDS = Object.freeze(['text', 'note', 'concept', 'paper', 'rect', 'ellipse', 'diamond']);
  const SHAPE_TOOLS = Object.freeze(['text', 'note', 'rect', 'ellipse', 'diamond']);
  const KIND_LABEL = Object.freeze({ text: '文本', note: '便签', concept: '概念', paper: '文献', rect: '矩形', ellipse: '椭圆', diamond: '菱形' });
  const DEFAULT_SIZE = Object.freeze({ text: { w: 220, h: 64 }, note: { w: 220, h: 140 }, concept: { w: 200, h: 100 }, paper: { w: 260, h: 120 }, rect: { w: 220, h: 140 }, ellipse: { w: 200, h: 120 }, diamond: { w: 200, h: 120 } });
  const RELATIONS = Object.freeze({ related: '相关', supports: '支持', contradicts: '矛盾', cites: '引用', explains: '解释', extends: '扩展' });
  const RELATION_ORDER = Object.freeze(['related', 'supports', 'contradicts', 'cites', 'explains', 'extends']);
  const EDGE_KINDS = Object.freeze({ arrow: '箭头', line: '直线', elbow: '折线' });
  const COLORS = Object.freeze(['#4176e6', '#22864a', '#88520f', '#b0306a', '#6b4fd8', '#0f1115']);
  const TOOL_IDS = Object.freeze({ select: 'board-tool-select', pan: 'board-tool-pan', text: 'board-tool-text', note: 'board-tool-note', rect: 'board-tool-rect', ellipse: 'board-tool-ellipse', diamond: 'board-tool-diamond' });
  const TOOL_KEYS = Object.freeze({ v: 'select', h: 'pan', t: 'text', n: 'note', r: 'rect', o: 'ellipse', d: 'diamond' });

  const round = value => Math.round(value * 100) / 100;
  const round3 = value => Math.round(value * 1000) / 1000;
  const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
  const nonEmpty = (value, maximum, name) => {
    if (typeof value !== 'string' || !value.trim() || value.length > maximum) throw new Error(`${name}为空或超过 ${maximum} 个字符。`);
    return value;
  };
  let idSeed = 0;
  /** Ids stay within the host's [A-Za-z0-9_-]{1,60} identifier grammar. */
  function makeId(prefix) {
    idSeed = (idSeed + 1) % 100000;
    const random = Math.random().toString(36).slice(2, 10);
    return `${prefix}-${Date.now().toString(36)}${idSeed.toString(36)}${random}`.slice(0, 60);
  }
  const nodeBounds = node => ({ x: node.x, y: node.y, w: node.w, h: node.h, right: node.x + node.w, bottom: node.y + node.h, cx: node.x + node.w / 2, cy: node.y + node.h / 2 });
  const toScene = (point, view) => ({ x: (point.x - view.x) / view.zoom, y: (point.y - view.y) / view.zoom });
  const toScreen = (point, view) => ({ x: point.x * view.zoom + view.x, y: point.y * view.zoom + view.y });
  function applyZoom(view, factor, anchor) {
    const zoom = clamp(view.zoom * factor, LIMITS.zoomMin, LIMITS.zoomMax);
    if (zoom === view.zoom) return { ...view };
    const scale = zoom / view.zoom;
    return { zoom: round3(zoom), x: round(anchor.x - (anchor.x - view.x) * scale), y: round(anchor.y - (anchor.y - view.y) * scale) };
  }
  function boundsOf(nodes) {
    if (!nodes.length) return null;
    const xs = nodes.map(node => node.x), ys = nodes.map(node => node.y);
    const right = Math.max(...nodes.map(node => node.x + node.w)), bottom = Math.max(...nodes.map(node => node.y + node.h));
    const x = Math.min(...xs), y = Math.min(...ys);
    return { x, y, w: right - x, h: bottom - y };
  }
  /** Fit content into a viewport; an empty board keeps the origin centred. */
  function viewportFor(nodes, size, padding = 48) {
    const bounds = boundsOf(nodes);
    if (!bounds) return { x: round(size.width / 2), y: round(size.height / 2), zoom: 1 };
    const zoom = round3(clamp(Math.min((size.width - padding * 2) / Math.max(bounds.w, 1), (size.height - padding * 2) / Math.max(bounds.h, 1)), LIMITS.zoomMin, 1.4));
    return { x: round(size.width / 2 - (bounds.x + bounds.w / 2) * zoom), y: round(size.height / 2 - (bounds.y + bounds.h / 2) * zoom), zoom };
  }
  const insideBounds = (point, bounds) => point.x >= bounds.x && point.x <= bounds.right && point.y >= bounds.y && point.y <= bounds.bottom;
  /** Topmost node wins, matching the painting order. */
  function hitNode(nodes, point) {
    for (let index = nodes.length - 1; index >= 0; index--) if (insideBounds(point, nodeBounds(nodes[index]))) return nodes[index].id;
    return null;
  }
  function distanceToSegment(point, start, end) {
    const dx = end.x - start.x, dy = end.y - start.y, length = dx * dx + dy * dy;
    if (!length) return Math.hypot(point.x - start.x, point.y - start.y);
    const t = clamp(((point.x - start.x) * dx + (point.y - start.y) * dy) / length, 0, 1);
    return Math.hypot(point.x - (start.x + t * dx), point.y - (start.y + t * dy));
  }
  /** Clip a centre-to-centre segment to the node's border so arrowheads sit on the edge. */
  function anchorPoint(node, towards) {
    const bounds = nodeBounds(node), dx = towards.x - bounds.cx, dy = towards.y - bounds.cy;
    if (!dx && !dy) return { x: bounds.cx, y: bounds.cy };
    const scaleX = dx ? (bounds.w / 2) / Math.abs(dx) : Infinity, scaleY = dy ? (bounds.h / 2) / Math.abs(dy) : Infinity;
    const scale = Math.min(scaleX, scaleY);
    return { x: round(bounds.cx + dx * scale), y: round(bounds.cy + dy * scale) };
  }
  function edgeGeometry(from, to, kind) {
    const fromBounds = nodeBounds(from), toBounds = nodeBounds(to);
    const start = anchorPoint(from, { x: toBounds.cx, y: toBounds.cy }), end = anchorPoint(to, { x: fromBounds.cx, y: fromBounds.cy });
    const path = kind === 'elbow'
      ? `M ${start.x} ${start.y} H ${round((start.x + end.x) / 2)} V ${end.y} H ${end.x}`
      : `M ${start.x} ${start.y} L ${end.x} ${end.y}`;
    return { start, end, path, mid: { x: round((start.x + end.x) / 2), y: round((start.y + end.y) / 2) } };
  }
  function hitEdge(nodes, edges, point, tolerance = LIMITS.hit) {
    const byId = new Map(nodes.map(node => [node.id, node]));
    for (let index = edges.length - 1; index >= 0; index--) {
      const edge = edges[index], from = byId.get(edge.from), to = byId.get(edge.to);
      if (!from || !to) continue;
      const geometry = edgeGeometry(from, to, edge.kind);
      if (distanceToSegment(point, geometry.start, geometry.end) <= tolerance) return edge.id;
    }
    return null;
  }
  function rectsIntersect(a, b) { return a.x <= b.x + b.w && b.x <= a.x + a.w && a.y <= b.y + b.h && b.y <= a.y + a.h; }
  const normalizeRect = (start, end) => ({ x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), w: Math.abs(end.x - start.x), h: Math.abs(end.y - start.y) });
  function idsInRect(nodes, rect) { return nodes.filter(node => rectsIntersect(rect, nodeBounds(node))).map(node => node.id); }
  const verticalOrder = (byId, a, b) => (byId.get(a).y - byId.get(b).y) || (byId.get(a).x - byId.get(b).x) || (a < b ? -1 : a > b ? 1 : 0);

  /**
   * Deterministic tidy tree ("整理成树"): a leftmost root whose children grow rightwards,
   * one column per depth. Children keep their current top-to-bottom order, so the layout
   * respects the arrangement the reader made, and the same board always maps to the same
   * coordinates. Disconnected groups become further roots stacked below the first tree,
   * and a cycle can never recurse forever.
   */
  function tidyTree(nodes, edges, options = {}) {
    if (nodes.length < 2) return nodes.map(node => ({ ...node }));
    const gapX = options.gapX ?? 80, gapY = options.gapY ?? 36;
    const byId = new Map(nodes.map(node => [node.id, node]));
    const children = new Map(), hasParent = new Set();
    for (const edge of edges) {
      if (edge.from === edge.to || !byId.has(edge.from) || !byId.has(edge.to)) continue;
      // One parent per node keeps the result a tree; the extra relation is left untouched.
      if (hasParent.has(edge.to)) continue;
      if (!children.has(edge.from)) children.set(edge.from, []);
      children.get(edge.from).push(edge.to);
      hasParent.add(edge.to);
    }
    for (const list of children.values()) list.sort((a, b) => verticalOrder(byId, a, b));
    const ordered = nodes.map(node => node.id).sort((a, b) => verticalOrder(byId, a, b));
    const explicit = options.rootId && byId.has(options.rootId) ? options.rootId : null;
    const depth = new Map(), rows = new Map(), seen = new Set();
    let nextRow = 0;
    const assign = (id, level) => {
      seen.add(id);
      depth.set(id, level);
      const kids = (children.get(id) ?? []).filter(child => !seen.has(child));
      if (!kids.length) { rows.set(id, nextRow); return nextRow++; }
      const placed = kids.map(child => assign(child, level + 1));
      const row = (placed[0] + placed[placed.length - 1]) / 2;
      rows.set(id, row);
      return row;
    };
    const roots = [explicit ?? ordered.find(id => !hasParent.has(id)) ?? ordered[0]];
    for (const id of ordered) if (!seen.has(id) && !roots.includes(id)) roots.push(id);
    for (const root of roots) if (!seen.has(root)) assign(root, 0);
    const columnWidth = [];
    for (const [id, level] of depth) columnWidth[level] = Math.max(columnWidth[level] ?? 0, byId.get(id).w);
    const columnX = [];
    let cursor = 0;
    for (let level = 0; level < columnWidth.length; level++) { columnX[level] = cursor; cursor += columnWidth[level] + gapX; }
    const bounds = boundsOf(nodes), rowHeight = Math.max(...nodes.map(node => node.h)) + gapY;
    const originX = bounds ? bounds.x : 0, originY = bounds ? bounds.y : 0;
    return nodes.map(node => ({
      ...node,
      x: round(originX + columnX[depth.get(node.id)]),
      y: round(originY + rows.get(node.id) * rowHeight),
    }));
  }

  /** Stack additions under the existing content without disturbing it. */
  function placeInColumn(existing, additions, options = {}) {
    const gap = options.gap ?? 40;
    const bounds = boundsOf(existing);
    const x = bounds ? bounds.x : 0;
    let y = bounds ? bounds.y + bounds.h + gap : 0;
    return additions.map(node => {
      const placed = { ...node, x: round(x), y: round(y) };
      y += node.h + gap;
      return placed;
    });
  }

  /** A new mind map from catalog papers: one root question/theme with a node per paper. */
  function boardFromPapers(papers, title, { maxCharacters = 120 } = {}) {
    const trimmed = String(title ?? '').trim().slice(0, maxCharacters);
    if (!trimmed) throw new Error('请先写下这张画板的主题。');
    if (!papers.length) throw new Error('请先勾选至少一篇文献。');
    const root = createNode('concept', { x: 0, y: 0 }, trimmed);
    root.text = trimmed;
    const nodes = [root], edges = [];
    for (const paper of papers) {
      const node = paperNode(paper, { x: 0, y: 0 });
      nodes.push(node);
      edges.push({ id: makeId('e'), from: root.id, to: node.id, kind: 'arrow', relation: 'related', origin: 'user' });
    }
    return { schema: 1, title: trimmed, origin: 'user', status: 'saved', nodes: tidyTree(nodes, edges), edges };
  }

  const sizeFor = kind => DEFAULT_SIZE[kind] || DEFAULT_SIZE.text;
  function createNode(kind, point, text) {
    if (!NODE_KINDS.includes(kind)) throw new Error('不受支持的节点类型。');
    const size = sizeFor(kind);
    return { id: makeId('n'), kind, x: round(point.x - size.w / 2), y: round(point.y - size.h / 2), w: size.w, h: size.h, text: text ?? '', origin: 'user' };
  }
  const requireNode = (board, id) => {
    const node = board.nodes.find(value => value.id === id);
    if (!node) throw new Error('这个节点已不在画板中。');
    return node;
  };
  const replaceNode = (board, id, update) => ({ ...board, nodes: board.nodes.map(node => (node.id === id ? { ...node, ...update } : node)) });

  /** Pure model edits over the persisted board shape. */
  const model = {
    createNode,
    addNode(board, node) {
      if (!node || typeof node !== 'object' || !NODE_KINDS.includes(node.kind)) throw new Error('不受支持的节点类型。');
      if (typeof node.id !== 'string' || !node.id) throw new Error('节点缺少标识。');
      if (![node.x, node.y, node.w, node.h].every(Number.isFinite)) throw new Error('节点坐标无效。');
      if (board.nodes.length >= LIMITS.nodes) throw new Error(`画板最多 ${LIMITS.nodes} 个节点。`);
      return { ...board, nodes: [...board.nodes, node] };
    },
    addEdge(board, from, to, options = {}) {
      if (from === to) throw new Error('连线不能连接同一个节点。');
      requireNode(board, from); requireNode(board, to);
      if (board.edges.length >= LIMITS.edges) throw new Error(`画板最多 ${LIMITS.edges} 条连线。`);
      const existing = board.edges.find(edge => edge.from === from && edge.to === to);
      if (existing) return { board, edge: existing };
      const edge = { id: options.id ?? makeId('e'), from, to, kind: options.kind ?? 'arrow', origin: 'user' };
      if (options.relation) edge.relation = options.relation;
      if (options.label) edge.label = options.label;
      return { board: { ...board, edges: [...board.edges, edge] }, edge };
    },
    removeItems(board, ids) {
      const removed = new Set(ids);
      return {
        ...board,
        nodes: board.nodes.filter(node => !removed.has(node.id)),
        edges: board.edges.filter(edge => !removed.has(edge.id) && !removed.has(edge.from) && !removed.has(edge.to)),
      };
    },
    setNodeText(board, id, text) {
      if (typeof text !== 'string' || text.length > LIMITS.text) throw new Error(`节点文本超过 ${LIMITS.text} 个字符。`);
      return replaceNode(board, id, { text });
    },
    setNodeColor(board, id, color) { return replaceNode(board, id, { color }); },
    setNodeKind(board, id, kind) {
      if (!NODE_KINDS.includes(kind)) throw new Error('不受支持的节点类型。');
      const node = requireNode(board, id);
      if (kind !== 'paper' && node.paper) throw new Error('只有文献节点可以绑定文献。');
      if (kind === 'paper' && !node.paper) throw new Error('文献节点需要通过文献库添加。');
      return replaceNode(board, id, { kind });
    },
    resizeNode(board, id, w, h) {
      const node = requireNode(board, id);
      return replaceNode(board, id, { w: clamp(round(w), 40, LIMITS.coordinate - Math.abs(node.x)), h: clamp(round(h), 32, LIMITS.coordinate - Math.abs(node.y)) });
    },
    moveNodes(board, ids, dx, dy) {
      const moving = new Set(ids);
      return {
        ...board,
        nodes: board.nodes.map(node => (moving.has(node.id)
          ? { ...node, x: round(clamp(node.x + dx, -LIMITS.coordinate, LIMITS.coordinate)), y: round(clamp(node.y + dy, -LIMITS.coordinate, LIMITS.coordinate)) }
          : node)),
      };
    },
    setEdge(board, id, update) {
      if (!board.edges.some(edge => edge.id === id)) throw new Error('这条连线已不在画板中。');
      return { ...board, edges: board.edges.map(edge => (edge.id === id ? { ...edge, ...update } : edge)) };
    },
    /** Copy ids and their internal edges, offset so the copy is visible. */
    duplicate(board, ids, offset = 32) {
      const copied = new Set(ids.filter(id => board.nodes.some(node => node.id === id)));
      const mapping = new Map();
      const nodes = [];
      for (const node of board.nodes) {
        if (!copied.has(node.id)) continue;
        if (board.nodes.length + nodes.length >= LIMITS.nodes) throw new Error(`画板最多 ${LIMITS.nodes} 个节点。`);
        const id = makeId('n');
        mapping.set(node.id, id);
        nodes.push({ ...node, id, x: round(node.x + offset), y: round(node.y + offset), origin: 'user' });
      }
      if (!nodes.length) throw new Error('请先选中要复制的节点。');
      const edges = [];
      for (const edge of board.edges) {
        if (!mapping.has(edge.from) || !mapping.has(edge.to)) continue;
        if (board.edges.length + edges.length >= LIMITS.edges) break;
        edges.push({ ...edge, id: makeId('e'), from: mapping.get(edge.from), to: mapping.get(edge.to), origin: 'user' });
      }
      return { board: { ...board, nodes: [...board.nodes, ...nodes], edges: [...board.edges, ...edges] }, nodes, edges };
    },
  };

  function paperNode(paper, point) {
    const title = typeof paper.title === 'string' && paper.title.trim() ? paper.title.trim() : '（未命名文献）';
    const node = createNode('paper', point, title.slice(0, LIMITS.text));
    node.w = DEFAULT_SIZE.paper.w; node.h = DEFAULT_SIZE.paper.h;
    node.x = round(point.x - node.w / 2); node.y = round(point.y - node.h / 2);
    node.paper = { id: String(paper.id) };
    if (paper.title) node.paper.title = String(paper.title).slice(0, 500);
    const year = Number(paper.year);
    if (Number.isInteger(year) && year > 0 && year < 10000) node.paper.year = year;
    if (paper.citekey) node.paper.citekey = String(paper.citekey).slice(0, 200);
    return node;
  }

  /** The panel's own outline preview; the host freezes the authoritative copy. */
  function outline(board, maxCharacters = 24000) {
    const label = node => (node.text?.trim() || node.paper?.title?.trim() || node.paper?.id || node.id).replace(/\s+/gu, ' ');
    const byId = new Map(board.nodes.map(node => [node.id, label(node)]));
    const lines = [`# 画板：${board.title}`, `节点 ${board.nodes.length} · 连线 ${board.edges.length}`];
    for (const node of board.nodes) {
      let line = `- [${node.kind}] ${label(node)}`;
      if (node.paper) {
        const meta = [node.paper.year, node.paper.citekey].filter(Boolean).join(' · ');
        line += ` — 文献 ${node.paper.id}${meta ? `（${meta}）` : ''}`;
      }
      lines.push(line);
    }
    for (const edge of board.edges) lines.push(`- ${byId.get(edge.from)} --${edge.relation ?? edge.kind}--> ${byId.get(edge.to)}`);
    const text = lines.join('\n');
    if (text.length <= maxCharacters) return { text, truncated: false };
    return { text: `${text.slice(0, maxCharacters - 40)}\n（预览已截断，实际引用由宿主按预算生成）`, truncated: true };
  }

  const emptyBoard = () => ({ schema: 1, title: '未命名画板', origin: 'user', status: 'saved', view: { x: 0, y: 0, zoom: 1 }, nodes: [], edges: [] });

  function create(options = {}) {
    const root = options.root;
    const api = options.api;
    const toast = options.toast || (() => {});
    const onClose = options.onClose || (() => {});
    const onOpenPaper = options.onOpenPaper || null;
    const doc = root.ownerDocument || document;
    const $ = id => doc.getElementById(id);
    const stage = $('board-stage');
    let board = emptyBoard();
    let boardId = null;
    let revision = 0;
    let view = { x: 0, y: 0, zoom: 1 };
    let tool = 'select';
    let selection = new Set();
    let open = false;
    let history = [];
    let historyIndex = -1;
    let saveTimer = null;
    let pendingSave = false;
    let conflict = null;
    let drag = null;
    let editor = null;
    let spaceDown = false;
    let live = true;
    const nodeEls = new Map(), edgeEls = new Map();
    const boardList = $('board-select');

    const svgEl = (tag, attrs, text) => { const node = doc.createElementNS(NS, tag); for (const [key, value] of Object.entries(attrs || {})) node.setAttribute(key, String(value)); if (text !== undefined) node.textContent = text; return node; };
    const el = (tag, className, text) => { const node = doc.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; };
    const status = (message, kind = '') => { const node = $('board-status'); if (!node) return; node.textContent = message; node.classList.toggle('is-error', kind === 'error'); node.classList.toggle('is-saved', kind === 'saved'); };

    const defs = svgEl('defs');
    const marker = svgEl('marker', { id: 'board-arrowhead', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' });
    marker.append(svgEl('path', { d: 'M 0 0 L 10 5 L 0 10 z', fill: 'context-stroke' }));
    defs.append(marker);
    const viewport = svgEl('g');
    const edgeLayer = svgEl('g', { 'aria-label': '连线' });
    const nodeLayer = svgEl('g', { 'aria-label': '节点' });
    const marquee = svgEl('rect', { class: 'board-marquee', hidden: 'hidden', rx: 3 });
    viewport.append(edgeLayer, nodeLayer, marquee);
    const svg = svgEl('svg', { id: 'board-canvas', tabindex: '0', role: 'application', 'aria-label': '文献画板画布，使用方向键移动选中节点，Delete 删除' });
    svg.append(defs, viewport);
    const editorLayer = el('div', 'board-editor-layer');
    const empty = el('div', 'board-empty');
    empty.append(el('strong', null, '空白画板'), el('span', null, '选择形状后点击画布，或把文献拖进来。'));
    stage.replaceChildren(svg, editorLayer, empty);

    const byId = id => board.nodes.find(node => node.id === id);
    const selectedNodes = () => board.nodes.filter(node => selection.has(node.id));
    const surfaceSize = () => { const rect = stage.getBoundingClientRect?.(); return { width: Math.max(1, rect?.width || 800), height: Math.max(1, rect?.height || 520) }; };

    /** Apply the viewport transform and the matching grid offset. */
    function applyView() {
      viewport.setAttribute('transform', `translate(${view.x},${view.y}) scale(${view.zoom})`);
      stage.style.backgroundSize = `${round(24 * view.zoom)}px ${round(24 * view.zoom)}px`;
      stage.style.backgroundPosition = `${view.x}px ${view.y}px`;
      const label = $('board-zoom-label');
      if (label) label.textContent = `${Math.round(view.zoom * 100)}%`;
    }

    function shapeFor(node) {
      const bounds = nodeBounds(node);
      if (node.kind === 'ellipse') return svgEl('ellipse', { cx: bounds.cx, cy: bounds.cy, rx: bounds.w / 2, ry: bounds.h / 2 });
      if (node.kind === 'diamond') return svgEl('polygon', { points: `${bounds.cx},${bounds.y} ${bounds.right},${bounds.cy} ${bounds.cx},${bounds.bottom} ${bounds.x},${bounds.cy}` });
      return svgEl('rect', { x: bounds.x, y: bounds.y, width: bounds.w, height: bounds.h, rx: node.kind === 'text' ? 4 : 10 });
    }

    function renderNode(node) {
      const bounds = nodeBounds(node);
      const group = svgEl('g', { class: `board-node board-node-kind-${node.kind}${selection.has(node.id) ? ' is-selected' : ''}${node.origin === 'llm' ? ' is-ai' : ''}`, 'data-node': node.id, tabindex: '-1' });
      const shape = shapeFor(node);
      shape.setAttribute('class', 'board-node-shape');
      if (node.color) shape.setAttribute('stroke', node.color);
      group.append(shape);
      if (node.origin === 'llm') group.append(svgEl('text', { class: 'board-node-meta', x: bounds.x + 6, y: bounds.y - 4 }, 'AI 提议'));
      if (node.kind === 'paper' && node.paper) {
        group.append(svgEl('text', { class: 'board-node-meta', x: bounds.x + 10, y: bounds.y + 18 }, [node.paper.year, node.paper.citekey].filter(Boolean).join(' · ') || '文献'));
        const title = (node.text || node.paper.title || node.paper.id).slice(0, 90);
        group.append(svgEl('text', { class: 'board-node-text', x: bounds.x + 10, y: bounds.y + 40 }, title));
      } else {
        const lines = String(node.text || '').split('\n').slice(0, 6);
        lines.forEach((line, index) => group.append(svgEl('text', { class: 'board-node-text', x: bounds.x + 10, y: bounds.y + 24 + index * 17 }, line.slice(0, 60) || (index === 0 ? '（空）' : ''))));
      }
      if (selection.has(node.id)) {
        group.append(svgEl('rect', { class: 'board-node-handle', x: bounds.right - 5, y: bounds.bottom - 5, width: 10, height: 10, rx: 2, 'data-handle': 'resize' }));
        group.append(svgEl('circle', { class: 'board-node-handle', cx: bounds.right + 4, cy: bounds.cy, r: 5, 'data-handle': 'connect' }));
      }
      return group;
    }

    function renderEdge(edge) {
      const from = byId(edge.from), to = byId(edge.to);
      if (!from || !to) return null;
      const selected = selection.has(edge.id);
      const geometry = edgeGeometry(from, to, edge.kind);
      const group = svgEl('g', { class: `board-edge-group${selected ? ' is-selected' : ''}`, 'data-edge': edge.id });
      const hit = svgEl('path', { class: 'board-edge-hit', d: geometry.path });
      const path = svgEl('path', { class: `board-edge${selected ? ' is-selected' : ''}`, d: geometry.path, 'data-edge-path': edge.id });
      if (edge.origin === 'llm') path.setAttribute('stroke-dasharray', '6 4');
      if (edge.kind === 'arrow') path.setAttribute('marker-end', 'url(#board-arrowhead)');
      group.append(hit, path);
      if (edge.label) group.append(svgEl('text', { class: 'board-edge-label', x: geometry.mid.x, y: geometry.mid.y - 4 }, edge.label));
      groupEls(edge.id, { group, path });
      return group;
    }
    function groupEls(id, value) { edgeEls.set(id, value); }

    function render() {
      if (!live) return;
      applyView();
      edgeLayer.replaceChildren();
      nodeLayer.replaceChildren();
      edgeEls.clear(); nodeEls.clear();
      for (const edge of board.edges) { const group = renderEdge(edge); if (group) edgeLayer.append(group); }
      for (const node of board.nodes) { const group = renderNode(node); nodeEls.set(node.id, group); nodeLayer.append(group); }
      empty.hidden = board.nodes.length > 0;
      const undo = $('board-undo'), redo = $('board-redo');
      if (undo) undo.disabled = historyIndex <= 0;
      if (redo) redo.disabled = historyIndex >= history.length - 1;
      const del = $('board-delete');
      if (del) del.disabled = !boardId;
    }

    /** Fast path during a drag: move existing elements instead of rebuilding the tree. */
    function redrawGeometry() {
      if (!live) return;
      for (const node of board.nodes) {
        const group = nodeEls.get(node.id);
        if (!group) continue;
        const bounds = nodeBounds(node);
        const shape = group.firstChild;
        if (!shape) continue;
        if (node.kind === 'ellipse') { shape.setAttribute('cx', bounds.cx); shape.setAttribute('cy', bounds.cy); shape.setAttribute('rx', bounds.w / 2); shape.setAttribute('ry', bounds.h / 2); }
        else if (node.kind === 'diamond') shape.setAttribute('points', `${bounds.cx},${bounds.y} ${bounds.right},${bounds.cy} ${bounds.cx},${bounds.bottom} ${bounds.x},${bounds.cy}`);
        else { shape.setAttribute('x', bounds.x); shape.setAttribute('y', bounds.y); shape.setAttribute('width', bounds.w); shape.setAttribute('height', bounds.h); }
      }
      for (const edge of board.edges) {
        const record = edgeEls.get(edge.id), from = byId(edge.from), to = byId(edge.to);
        if (!record || !from || !to) continue;
        const geometry = edgeGeometry(from, to, edge.kind);
        record.path.setAttribute('d', geometry.path);
        const hit = record.group.firstChild;
        if (hit) hit.setAttribute('d', geometry.path);
        const label = record.group.lastChild;
        if (edge.label && label?.classList?.contains('board-edge-label')) { label.setAttribute('x', geometry.mid.x); label.setAttribute('y', geometry.mid.y - 4); }
      }
      applyView();
    }

    /** History holds whole-board snapshots: bounded, exact, and cheap to reason about. */
    function pushHistory() {
      const snapshot = JSON.stringify({ nodes: board.nodes, edges: board.edges });
      if (history[historyIndex] === snapshot) return;
      history = history.slice(0, historyIndex + 1);
      history.push(snapshot);
      if (history.length > LIMITS.undo) history.shift();
      historyIndex = history.length - 1;
    }
    function restoreHistory(index) {
      if (index < 0 || index >= history.length) return;
      const snapshot = JSON.parse(history[index]);
      board = { ...board, nodes: snapshot.nodes, edges: snapshot.edges };
      historyIndex = index;
      const valid = new Set([...board.nodes.map(node => node.id), ...board.edges.map(edge => edge.id)]);
      selection = new Set([...selection].filter(id => valid.has(id)));
      render(); scheduleSave();
    }
    const undo = () => { if (historyIndex > 0) restoreHistory(historyIndex - 1); };
    const redo = () => { if (historyIndex < history.length - 1) restoreHistory(historyIndex + 1); };

    function mutate(apply) {
      const previous = board;
      try { board = apply(board); } catch (error) { toast(error.message, true); return false; }
      if (board !== previous) { pushHistory(); render(); scheduleSave(); }
      return true;
    }

    function scheduleSave() {
      if (!live || !boardId) return;
      pendingSave = true;
      status('有未保存的改动');
      if (saveTimer !== null) clearTimeout(saveTimer);
      saveTimer = setTimeout(() => { saveTimer = null; void flush(); }, LIMITS.saveDelay);
    }

    /**
     * Saving is debounced, so anything that takes the board away — closing the view,
     * switching boards, unloading the page — must settle first. Otherwise an edit made
     * in the last debounce window would silently disappear.
     */
    async function settle({ keepalive = false } = {}) {
      if (saveTimer !== null) { clearTimeout(saveTimer); saveTimer = null; }
      if (!pendingSave) return;
      await flush({ keepalive });
    }

    async function flush({ keepalive = false } = {}) {
      if (!live || !boardId || !pendingSave) return;
      const payload = { ...board, view: { x: view.x, y: view.y, zoom: view.zoom } };
      pendingSave = false;
      status('正在保存…');
      try {
        const result = await api('board_save', { id: boardId, board: payload, expected_revision: revision }, keepalive ? { keepalive: true } : {});
        if (!live) return;
        revision = result.revision;
        board = result.board;
        conflict = null;
        renderConflict();
        status('已保存', 'saved');
        if (result.board.status !== board.status) render();
      } catch (error) {
        if (!live) return;
        if (error.code === 'STATE_CONFLICT') {
          conflict = { current: error.current ?? null };
          status('画板已在别处修改', 'error');
          renderConflict();
          return;
        }
        pendingSave = true;
        status(error.message || '保存失败', 'error');
        toast(error.message || '画板保存失败', true);
      }
    }

    function renderConflict() {
      const banner = $('board-conflict');
      if (!banner) return;
      banner.hidden = !conflict;
      if (conflict) {
        const note = $('board-conflict-note');
        if (note) note.textContent = '这个画板已在另一个窗口修改。你的改动仍在这里，没有被覆盖。';
      }
    }

    /** Conflict recovery keeps both sides: reload the stored board, or keep editing and save as new. */
    async function resolveConflict(choice) {
      if (!conflict) return;
      if (choice === 'reload') {
        conflict = null; renderConflict();
        await load(boardId);
        toast('已载入另一窗口保存的版本');
        return;
      }
      // Save the local board as a new record; nothing is discarded and nothing is overwritten.
      try {
        const result = await api('board_create', { board: { ...board, title: `${board.title}（本地副本）`.slice(0, LIMITS.title) } });
        if (!live) return;
        boardId = result.board.id; revision = result.revision; board = result.board;
        conflict = null; pendingSave = false; renderConflict(); render();
        await refreshList();
        status('已另存为新画板', 'saved');
      } catch (error) { toast(error.message || '另存失败', true); }
    }

    function select(ids, additive = false) {
      const next = additive ? new Set(selection) : new Set();
      for (const id of ids) { if (additive && next.has(id)) next.delete(id); else next.add(id); }
      selection = next;
      render();
      renderInspector();
    }

    function renderInspector() {
      const relation = $('board-relation');
      const label = $('board-edge-label-input');
      const color = $('board-color');
      const nodes = selectedNodes();
      const edges = board.edges.filter(edge => selection.has(edge.id));
      const single = nodes.length === 1 ? nodes[0] : null;
      if (relation) {
        relation.disabled = edges.length !== 1;
        if (edges.length === 1) relation.value = edges[0].relation ?? 'related';
        else if (!edges.length) relation.value = '';
      }
      if (label) {
        label.disabled = edges.length !== 1;
        label.value = edges.length === 1 ? (edges[0].label ?? '') : '';
      }
      if (color) {
        color.disabled = !single;
        color.value = single?.color ?? '';
      }
      const kind = $('board-kind');
      if (kind) { kind.disabled = !single; if (single) kind.value = single.kind; }
      const count = $('board-selection');
      if (count) count.textContent = nodes.length + edges.length ? `已选 ${nodes.length} 个节点 · ${edges.length} 条连线` : '未选择';
    }

    function deleteSelection() {
      if (!selection.size) return;
      mutate(current => model.removeItems(current, [...selection]));
      selection = new Set();
      render(); renderInspector();
    }

    function scenePointFromEvent(event) {
      const rect = stage.getBoundingClientRect();
      return toScene({ x: event.clientX - rect.left, y: event.clientY - rect.top }, view);
    }

    function startTextEdit(node) {
      closeTextEdit();
      const rect = stage.getBoundingClientRect();
      const screen = toScreen({ x: node.x, y: node.y }, view);
      const area = el('textarea', 'board-text-editor');
      area.value = node.kind === 'paper' ? String(node.text || '') : String(node.text || '');
      area.maxLength = LIMITS.text;
      area.setAttribute('aria-label', `编辑${KIND_LABEL[node.kind] || '节点'}文本`);
      area.style.left = `${screen.x}px`; area.style.top = `${screen.y}px`;
      area.style.width = `${Math.max(60, node.w * view.zoom)}px`; area.style.height = `${Math.max(40, node.h * view.zoom)}px`;
      const commit = () => {
        const value = area.value;
        closeTextEdit();
        mutate(current => model.setNodeText(current, node.id, value));
      };
      area.addEventListener('blur', commit);
      area.addEventListener('keydown', event => {
        if (event.key === 'Escape') { event.preventDefault(); closeTextEdit(); }
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); commit(); }
      });
      editor = { node: node.id, area };
      editorLayer.append(area);
      area.focus();
      area.select();
    }
    function closeTextEdit() {
      if (!editor) return;
      const area = editor.area;
      editor = null;
      area.remove();
    }

    function beginDrag(event) {
      const point = scenePointFromEvent(event);
      const mode = tool;
      if (mode === 'pan' || event.button === 1 || spaceDown) {
        drag = { kind: 'pan', startClient: { x: event.clientX, y: event.clientY }, startView: { ...view } };
        svg.classList.add('is-panning');
        return;
      }
      if (SHAPE_TOOLS.includes(mode)) {
        const node = createNode(mode, point, mode === 'text' ? '' : '');
        if (!mutate(current => model.addNode(current, node))) return;
        select([node.id]);
        startTextEdit(byId(node.id));
        setTool('select');
        return;
      }
      // Selection handles belong to the single selected node, checked geometrically.
      const single = selectedNodes().length === 1 ? selectedNodes()[0] : null;
      if (single) {
        const bounds = nodeBounds(single), tolerance = LIMITS.handle / view.zoom;
        if (Math.abs(point.x - bounds.right) <= tolerance && Math.abs(point.y - bounds.bottom) <= tolerance) {
          drag = { kind: 'resize', id: single.id, start: point, node: { ...single } };
          return;
        }
        if (Math.abs(point.x - (bounds.right + 4)) <= tolerance && Math.abs(point.y - bounds.cy) <= tolerance) {
          drag = { kind: 'connect', id: single.id, start: point };
          return;
        }
      }
      const nodeId = hitNode(board.nodes, point);
      if (nodeId) {
        if (event.shiftKey) { select([nodeId], true); return; }
        if (!selection.has(nodeId)) select([nodeId]);
        drag = { kind: 'move', start: point, ids: [...selection].filter(id => byId(id)), moved: false };
        return;
      }
      const edgeId = hitEdge(board.nodes, board.edges, point, LIMITS.hit / view.zoom);
      if (edgeId) { select([edgeId], event.shiftKey); return; }
      drag = { kind: 'marquee', start: point, additive: event.shiftKey };
      marquee.removeAttribute('hidden');
    }

    function continueDrag(event) {
      if (!drag) return;
      if (drag.kind === 'pan') {
        view = { ...view, x: round(drag.startView.x + (event.clientX - drag.startClient.x)), y: round(drag.startView.y + (event.clientY - drag.startClient.y)) };
        applyView();
        return;
      }
      const point = scenePointFromEvent(event);
      if (drag.kind === 'move') {
        const dx = point.x - drag.start.x, dy = point.y - drag.start.y;
        if (!dx && !dy) return;
        board = model.moveNodes(board, drag.ids, dx, dy);
        drag.start = point;
        drag.moved = true;
        redrawGeometry();
        return;
      }
      if (drag.kind === 'resize') {
        const node = byId(drag.id);
        if (!node) return;
        board = model.resizeNode(board, drag.id, drag.node.w + (point.x - drag.start.x), drag.node.h + (point.y - drag.start.y));
        redrawGeometry();
        return;
      }
      if (drag.kind === 'connect') {
        const target = hitNode(board.nodes, point);
        drag.target = target && target !== drag.id ? target : null;
        redrawGeometry();
        if (drag.target) {
          const from = byId(drag.id), to = byId(drag.target);
          if (from && to) edgeLayer.append(svgEl('path', { class: 'board-edge', d: edgeGeometry(from, to, 'arrow').path, 'stroke-dasharray': '4 4' }));
        }
        return;
      }
      if (drag.kind === 'marquee') {
        const rect = normalizeRect(drag.start, point);
        marquee.setAttribute('x', rect.x); marquee.setAttribute('y', rect.y);
        marquee.setAttribute('width', rect.w); marquee.setAttribute('height', rect.h);
        drag.rect = rect;
      }
    }

    function endDrag() {
      if (!drag) return;
      const finished = drag;
      drag = null;
      svg.classList.remove('is-panning');
      marquee.setAttribute('hidden', 'hidden');
      if (finished.kind === 'move') { if (finished.moved) { pushHistory(); scheduleSave(); } return; }
      if (finished.kind === 'resize') { pushHistory(); render(); scheduleSave(); return; }
      if (finished.kind === 'connect') {
        if (finished.target) {
          let created = null;
          if (mutate(current => { const result = model.addEdge(current, finished.id, finished.target); created = result.edge; return result.board; })) {
            if (created) select([created.id]);
          }
        }
        render();
        return;
      }
      if (finished.kind === 'marquee' && finished.rect) {
        const ids = idsInRect(board.nodes, finished.rect);
        select(ids, finished.additive);
      }
    }

    function onKeyDown(event) {
      if (!open) return;
      const target = event.target;
      const typing = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
      if (event.key === ' ') spaceDown = true;
      if (typing) return;
      const meta = event.metaKey || event.ctrlKey;
      if (event.key === 'Escape') { closeTextEdit(); select([]); return; }
      if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); deleteSelection(); return; }
      if (meta && event.key.toLowerCase() === 'z') { event.preventDefault(); if (event.shiftKey) redo(); else undo(); return; }
      if (meta && event.key.toLowerCase() === 'y') { event.preventDefault(); redo(); return; }
      if (meta && event.key.toLowerCase() === 'a') { event.preventDefault(); select(board.nodes.map(node => node.id)); return; }
      if (meta && event.key.toLowerCase() === 'd') { event.preventDefault(); duplicateSelection(); return; }
      if (meta && event.key.toLowerCase() === 's') { event.preventDefault(); void flush(); return; }
      if (event.key.startsWith('Arrow')) {
        event.preventDefault();
        const step = event.shiftKey ? 20 : 4;
        const dx = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0;
        const dy = event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0;
        const ids = [...selection].filter(id => byId(id));
        if (!ids.length) return;
        board = model.moveNodes(board, ids, dx, dy);
        render(); scheduleSave();
        return;
      }
      if (meta) return;
      const next = TOOL_KEYS[event.key.toLowerCase()];
      if (next) setTool(next);
    }
    const onKeyUp = event => { if (event.key === ' ') spaceDown = false; };

    function duplicateSelection() {
      const ids = [...selection].filter(id => byId(id));
      if (!ids.length) return;
      let created = [];
      if (!mutate(current => { const result = model.duplicate(current, ids); created = result.nodes.map(node => node.id); return result.board; })) return;
      select(created);
    }

    function setTool(next) {
      tool = next;
      for (const [name, id] of Object.entries(TOOL_IDS)) {
        const button = $(id);
        if (!button) continue;
        const active = name === next;
        button.setAttribute('aria-pressed', String(active));
        button.classList.toggle('is-active', active);
      }
      const drawing = SHAPE_TOOLS.includes(next);
      svg.classList.toggle('is-drawing', drawing);
      svg.classList.toggle('is-pan', next === 'pan');
    }

    async function refreshList() {
      if (!boardList) return { boards: [] };
      const result = await api('board_list', {});
      if (!live) return { boards: [] };
      boardList.replaceChildren();
      for (const summary of result.boards) {
        const option = el('option', null, summary.title);
        option.value = summary.id;
        boardList.append(option);
      }
      if (boardId) boardList.value = boardId;
      if (result.truncated) status(`画板较多，列表只显示部分（共 ${result.total}）`);
      return result;
    }

    async function load(id) {
      // Switching boards settles the outgoing board first; otherwise its last edit
      // would be written to the board being opened.
      if (boardId && boardId !== id) await settle();
      const result = await api('board_get', { id });
      if (!live) return;
      board = result.board;
      boardId = board.id;
      revision = result.revision;
      selection = new Set();
      history = [JSON.stringify({ nodes: board.nodes, edges: board.edges })];
      historyIndex = 0;
      conflict = null; pendingSave = false;
      renderConflict();
      const title = $('board-title');
      if (title) title.value = board.title;
      if (board.view) view = { x: board.view.x, y: board.view.y, zoom: board.view.zoom };
      else view = viewportFor(board.nodes, surfaceSize());
      render(); renderInspector();
      if (boardList) boardList.value = boardId;
      status('已载入');
    }

    async function openView() {
      open = true;
      root.hidden = false;
      doc.body.classList.add('board-mode');
      svg.focus?.();
      let result;
      try { result = await refreshList(); }
      catch (error) {
        if (!live) return;
        // A failed listing must not create a board: an empty view with a readable
        // retry path is honest, a silently fabricated board is not.
        status(error.message || '无法读取画板列表，请重试或新建画板。', 'error');
        return;
      }
      if (!live) return;
      if (!result.boards.length) {
        try {
          const created = await api('board_create', { board: { title: '我的文献画板', nodes: [], edges: [] } });
          if (!live) return;
          await refreshList();
          await load(created.board.id);
        } catch (error) { if (live) status(error.message || '新建画板失败', 'error'); }
        return;
      }
      const wanted = boardId && result.boards.some(summary => summary.id === boardId) ? boardId : result.boards[0].id;
      try { await load(wanted); }
      catch (error) { if (live) status(error.message || '无法打开这个画板', 'error'); }
    }

    async function closeView({ focus = true } = {}) {
      await settle({ keepalive: true });
      open = false;
      closeTextEdit();
      root.hidden = true;
      doc.body.classList.remove('board-mode');
      onClose({ focus });
    }

    function resize() {
      if (!open) return;
      applyView();
    }

    async function createBoard() {
      try {
        const result = await api('board_create', { board: { title: '未命名画板', nodes: [], edges: [] } });
        if (!live) return;
        await refreshList();
        await load(result.board.id);
        toast('已新建画板');
      } catch (error) { toast(error.message || '新建画板失败', true); }
    }

    async function deleteBoard() {
      if (!boardId) return;
      if (typeof doc.defaultView?.confirm === 'function' && !doc.defaultView.confirm(`删除画板「${board.title}」？画板记录会保留在本地状态目录，可由人工恢复。`)) return;
      // Deleting cancels the debounce instead of settling: a pending save would
      // otherwise write the board back and resurrect a record the reader removed.
      pendingSave = false;
      if (saveTimer !== null) { clearTimeout(saveTimer); saveTimer = null; }
      try {
        await api('board_delete', { id: boardId, expected_revision: revision });
        if (!live) return;
        boardId = null; revision = 0; board = emptyBoard(); selection = new Set(); view = { x: 0, y: 0, zoom: 1 };
        render(); renderInspector();
        // openView re-lists and either loads the next board or creates a fresh one.
        await openView();
        toast('画板已删除');
      } catch (error) { toast(error.message || '删除画板失败', true); }
    }

    function renameBoard(value) {
      const title = nonEmpty(value, LIMITS.title, '画板标题');
      board = { ...board, title };
      scheduleSave();
    }

    /** Fullscreen lets a narrow DSH sidebar grow into a real drawing surface. */
    async function toggleFullscreen() {
      const view = doc.defaultView;
      if (!view) return;
      if (doc.fullscreenElement) { await doc.exitFullscreen?.().catch(() => {}); return; }
      if (!root.requestFullscreen) { toast('当前环境不支持全屏，请展开侧栏或在浏览器中打开。', true); return; }
      try { await root.requestFullscreen({ navigationUI: 'hide' }); }
      catch { toast('浏览器未允许全屏；可展开侧栏继续使用画板。', true); }
    }

    function syncFullscreen() {
      const button = $('board-fullscreen');
      if (!button) return;
      const focused = Boolean(doc.fullscreenElement);
      button.setAttribute('aria-pressed', String(focused));
      button.textContent = focused ? '退出全屏 ⤡' : '全屏 ⤢';
    }

    /** Library integration: a dropped paper becomes a paper node at the drop point. */
    function addPaper(paper, clientPoint) {
      const point = clientPoint ? toScene(clientPoint, view) : { x: 0, y: 0 };
      const node = paperNode(paper, point);
      if (!mutate(current => model.addNode(current, node))) return null;
      select([node.id]);
      return node.id;
    }

    /** Add several papers at once, stacked under the existing content. */
    function addPapers(papers) {
      if (!papers?.length) return 0;
      const room = Math.max(0, LIMITS.nodes - board.nodes.length);
      const additions = placeInColumn(board.nodes, papers.slice(0, room).map(paper => paperNode(paper, { x: 0, y: 0 })));
      if (!additions.length) { toast(`画板最多 ${LIMITS.nodes} 个节点。`, true); return 0; }
      board = { ...board, nodes: [...board.nodes, ...additions] };
      pushHistory(); render(); scheduleSave();
      select(additions.map(node => node.id));
      return additions.length;
    }

    /** Build a new mind map from chosen papers; the host still owns validation and storage. */
    async function generateFromPapers(papers, title) {
      const draft = boardFromPapers(papers, title);
      const result = await api('board_create', { board: draft });
      if (!live) return null;
      await refreshList();
      await load(result.board.id);
      return result.board.id;
    }

    /**
     * Arrange the selection as a tidy tree, or the whole board when fewer than two
     * nodes are selected. Only the scope's own nodes move; unrelated content stays put.
     */
    function tidy() {
      const ids = new Set([...selection].filter(id => byId(id)));
      const scoped = ids.size > 1;
      const nodes = scoped ? board.nodes.filter(node => ids.has(node.id)) : board.nodes;
      if (nodes.length < 2) { toast('至少要有两个节点才能整理成树。', true); return 0; }
      const inScope = new Set(nodes.map(node => node.id));
      const edges = board.edges.filter(edge => inScope.has(edge.from) && inScope.has(edge.to));
      const arranged = new Map(tidyTree(nodes, edges).map(node => [node.id, node]));
      board = { ...board, nodes: board.nodes.map(node => arranged.get(node.id) ?? node) };
      pushHistory(); render(); scheduleSave();
      return nodes.length;
    }

    function bind() {
      svg.addEventListener('pointerdown', event => { event.preventDefault(); beginDrag(event); });
      svg.addEventListener('pointermove', continueDrag);
      svg.addEventListener('pointerup', endDrag);
      svg.addEventListener('pointercancel', endDrag);
      svg.addEventListener('dblclick', event => {
        const nodeId = hitNode(board.nodes, scenePointFromEvent(event));
        if (nodeId) {
          const node = byId(nodeId);
          if (node.kind === 'paper' && onOpenPaper && node.paper?.id) { onOpenPaper(node.paper.id); return; }
          select([nodeId]); startTextEdit(node);
        }
      });
      svg.addEventListener('wheel', event => {
        event.preventDefault();
        const rect = stage.getBoundingClientRect();
        const pointer = { x: event.clientX - rect.left, y: event.clientY - rect.top };
        if (event.ctrlKey || event.metaKey) view = applyZoom(view, event.deltaY < 0 ? 1.1 : 1 / 1.1, pointer);
        else view = { ...view, x: round(view.x - event.deltaX), y: round(view.y - event.deltaY) };
        applyView();
      }, { passive: false });
      const title = $('board-title');
      if (title) title.addEventListener('change', () => { try { renameBoard(title.value); } catch (error) { toast(error.message, true); title.value = board.title; } });
      const undoButton = $('board-undo'), redoButton = $('board-redo');
      if (undoButton) undoButton.addEventListener('click', undo);
      if (redoButton) redoButton.addEventListener('click', redo);
      const tidyButton = $('board-tidy');
      if (tidyButton) tidyButton.addEventListener('click', () => { const count = tidy(); if (count) toast(`已把 ${count} 个节点整理成树`); });
      const zoomIn = $('board-zoom-in'), zoomOut = $('board-zoom-out'), fit = $('board-fit');
      if (zoomIn) zoomIn.addEventListener('click', () => { const size = surfaceSize(); view = applyZoom(view, 1.2, { x: size.width / 2, y: size.height / 2 }); applyView(); });
      if (zoomOut) zoomOut.addEventListener('click', () => { const size = surfaceSize(); view = applyZoom(view, 1 / 1.2, { x: size.width / 2, y: size.height / 2 }); applyView(); });
      if (fit) fit.addEventListener('click', () => { view = viewportFor(board.nodes, surfaceSize()); applyView(); scheduleSave(); });
      for (const [name, id] of Object.entries(TOOL_IDS)) { const button = $(id); if (button) button.addEventListener('click', () => setTool(name)); }
      const addPaperButton = $('board-add-paper');
      if (addPaperButton) addPaperButton.addEventListener('click', () => { options.onRequestPapers?.(); });
      const newButton = $('board-new'), deleteButton = $('board-delete'), closeButton = $('board-close');
      if (newButton) newButton.addEventListener('click', () => void createBoard());
      if (deleteButton) deleteButton.addEventListener('click', () => void deleteBoard());
      if (closeButton) closeButton.addEventListener('click', () => closeView());
      const fullscreenButton = $('board-fullscreen');
      if (fullscreenButton) fullscreenButton.addEventListener('click', () => void toggleFullscreen());
      doc.addEventListener('fullscreenchange', syncFullscreen);
      syncFullscreen();
      if (boardList) boardList.addEventListener('change', () => { void load(boardList.value); });
      const reload = $('board-conflict-reload'), saveCopy = $('board-conflict-copy');
      if (reload) reload.addEventListener('click', () => void resolveConflict('reload'));
      if (saveCopy) saveCopy.addEventListener('click', () => void resolveConflict('copy'));
      const relation = $('board-relation'), edgeLabel = $('board-edge-label-input'), color = $('board-color'), kind = $('board-kind');
      if (relation) relation.addEventListener('change', () => { const edge = board.edges.find(value => selection.has(value.id)); if (edge) mutate(current => model.setEdge(current, edge.id, { relation: relation.value })); });
      if (edgeLabel) edgeLabel.addEventListener('change', () => { const edge = board.edges.find(value => selection.has(value.id)); if (edge) mutate(current => model.setEdge(current, edge.id, { label: edgeLabel.value.slice(0, LIMITS.label) })); });
      if (color) color.addEventListener('change', () => { const node = selectedNodes()[0]; if (node) mutate(current => model.setNodeColor(current, node.id, color.value || undefined)); });
      if (kind) kind.addEventListener('change', () => { const node = selectedNodes()[0]; if (node) mutate(current => model.setNodeKind(current, node.id, kind.value)); });
      const accept = $('board-accept-ai');
      if (accept) accept.addEventListener('click', async () => {
        try {
          const result = await api('board_accept', { id: boardId, expected_revision: revision });
          if (!live) return; board = result.board; revision = result.revision; render();
          toast(result.accepted ? `已接受 ${result.accepted} 处 AI 改动` : '没有待接受的 AI 改动');
        } catch (error) { toast(error.message || '接受失败', true); }
      });
      doc.addEventListener('keydown', onKeyDown);
      doc.addEventListener('keyup', onKeyUp);
      const dropTarget = stage;
      dropTarget.addEventListener('dragover', event => { if (!open) return; event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; });
      dropTarget.addEventListener('drop', event => {
        if (!open) return;
        event.preventDefault();
        const payload = event.dataTransfer?.getData('application/x-paper-library-paper');
        if (!payload) return;
        let paper = null;
        try { paper = JSON.parse(payload); } catch { paper = { id: payload }; }
        if (!paper?.id) return;
        const rect = stage.getBoundingClientRect();
        addPaper(paper, { x: event.clientX - rect.left, y: event.clientY - rect.top });
      });
      const emptyCreate = $('board-create-first');
      if (emptyCreate) emptyCreate.addEventListener('click', () => void createBoard());
      // The inspector only offers a shape change for a single node; paper nodes keep their binding.
    }

    /** Selects are filled from the exported constants so the UI cannot drift from the schema. */
    function fillSelects() {
      const kind = $('board-kind');
      if (kind) {
        kind.replaceChildren(el('option', null, '选择形状'));
        for (const value of NODE_KINDS) { if (value === 'paper') continue; const option = el('option', null, KIND_LABEL[value]); option.value = value; kind.append(option); }
        const paper = el('option', null, KIND_LABEL.paper); paper.value = 'paper'; kind.append(paper);
      }
      const color = $('board-color');
      if (color) {
        const none = el('option', null, '默认'); none.value = ''; color.append(none);
        for (const value of COLORS) { const option = el('option', null, value); option.value = value; color.append(option); }
      }
      const relation = $('board-relation');
      if (relation) {
        const none = el('option', null, '未指定'); none.value = ''; relation.append(none);
        for (const value of RELATION_ORDER) { const option = el('option', null, RELATIONS[value]); option.value = value; relation.append(option); }
      }
    }

    bind();
    fillSelects();
    setTool('select');
    render();

    return {
      open: openView, close: closeView, resize, load, refreshList, render,
      isOpen: () => open,
      board: () => board,
      selection: () => [...selection],
      flush,
      addPaper,
      addPapers,
      generateFromPapers,
      tidy,
      outline: (maximum) => outline({ ...board, title: board.title }, maximum),
      setTool,
      dispose() {
        closeTextEdit();
        if (saveTimer !== null) { clearTimeout(saveTimer); saveTimer = null; }
        // The page may be unloading: start a keepalive write before disabling the panel.
        if (pendingSave) void flush({ keepalive: true });
        live = false;
        doc.removeEventListener('keydown', onKeyDown);
        doc.removeEventListener('keyup', onKeyUp);
        doc.removeEventListener('fullscreenchange', syncFullscreen);
      },
    };
  }

  window.PaperBoard = Object.freeze({
    create, model, outline, createNode, paperNode, tidyTree, placeInColumn, boardFromPapers,
    LIMITS, NODE_KINDS, KIND_LABEL, RELATIONS, RELATION_ORDER, EDGE_KINDS, COLORS, DEFAULT_SIZE,
    geometry: { round, round3, clamp, nodeBounds, toScene, toScreen, applyZoom, boundsOf, viewportFor, hitNode, hitEdge, edgeGeometry, anchorPoint, distanceToSegment, normalizeRect, idsInRect },
  });
})();
