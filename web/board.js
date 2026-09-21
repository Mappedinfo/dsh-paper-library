  const NS = 'http://www.w3.org/2000/svg';
  /** The source module owns the format vocabulary, the layout and the edge geometry. The panel
   *  is meaningless without it, so a missing module is a loud error rather than a second
   *  implementation kept in step by hand. */
  const sourceApi = () => {
    const api = window.PaperBoardSource;
    if (!api) throw new Error('画板需要 board-source.js：几何与源文件格式由它提供。');
    return api;
  };
  const source = () => window.PaperBoardSource ?? null;
  const LIMITS = Object.freeze({
    ...sourceApi().LIMITS,
    undo: 50, zoomMin: 0.2, zoomMax: 4, saveDelay: 700, handle: 9, hit: 10,
  });
  // Vocabulary: types, limits, sizes and the edge angle come from the source module (the single
  // owner); everything below is presentation the panel alone cares about.
  const NODE_KINDS = Object.freeze([...sourceApi().NODE_KINDS]);
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
  const SHAPE_TOOLS = Object.freeze(['text', 'note', 'rect', 'ellipse', 'diamond']);
  const KIND_LABEL = Object.freeze({ text: '文本', note: '便签', concept: '概念', paper: '文献', rect: '矩形', ellipse: '椭圆', diamond: '菱形' });
  /** A rectangle or a sticky note has square corners; only the container kinds are rounded. */
  const DEFAULT_SIZE = Object.freeze({ ...sourceApi().DEFAULT_SIZE });
  const NODE_RADIUS = Object.freeze({ text: 4, note: 0, rect: 0, concept: 10, paper: 10 });
  const RELATIONS = Object.freeze({ related: '相关', supports: '支持', contradicts: '矛盾', cites: '引用', explains: '解释', extends: '扩展' });
  const RELATION_ORDER = Object.freeze([...sourceApi().RELATIONS]);
  const EDGE_KINDS = Object.freeze({ arrow: '箭头', line: '直线', elbow: '折线' });
  const COLORS = Object.freeze(['#4176e6', '#22864a', '#88520f', '#b0306a', '#6b4fd8', '#0f1115']);
  const TOOL_IDS = Object.freeze({ select: 'board-tool-select', pan: 'board-tool-pan', text: 'board-tool-text', note: 'board-tool-note', rect: 'board-tool-rect', ellipse: 'board-tool-ellipse', diamond: 'board-tool-diamond', connect: 'board-tool-connect' });
  const TOOL_KEYS = Object.freeze({ v: 'select', h: 'pan', t: 'text', n: 'note', r: 'rect', o: 'ellipse', d: 'diamond', c: 'connect' });

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
  // Geometry is delegated: `board-source.js` owns the one implementation, and the keys the
  // tests and the PNG export use stay the same.
  const EDGE_ANGLE = sourceApi().EDGE_ANGLE;
  const { edgeAngle, anchorPoint, anchorAtAngle, incidenceAt, distanceToSegment, edgeGeometry } = sourceApi();

  function hitEdge(nodes, edges, point, tolerance = LIMITS.hit) {
    const byId = new Map(nodes.map(node => [node.id, node]));
    for (let index = edges.length - 1; index >= 0; index--) {
      const edge = edges[index], from = byId.get(edge.from), to = byId.get(edge.to);
      if (!from || !to) continue;
      if (edgeHitDistance(edge, from, to, point) <= tolerance) return edge.id;
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

  /** New edges follow the panel's current line style, so a preference sticks while drawing. */
  const edgeDefaults = () => ({ kind: pendingEdgeKind, angle: pendingEdgeAngle });
  let pendingEdgeKind = 'arrow';
  let pendingEdgeAngle = EDGE_ANGLE.default;
  /** Sizes come from the source module; an unknown kind falls back to the text box. */
  const sizeFor = kind => sourceApi().DEFAULT_SIZE[kind] ?? sourceApi().DEFAULT_SIZE.text;
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
      if (options.angle !== undefined && edgeAngle(options.angle) !== EDGE_ANGLE.default) edge.angle = edgeAngle(options.angle);
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
    const label = node => (node.text?.trim() || node.paper?.title?.trim() || node.paper?.id || `（空${KIND_LABEL[node.kind] ?? '形状'}）`).replace(/\s+/gu, ' ');
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

  /** One place decides how an edge is shaped, styled and hit-tested. It is the source module's
   *  implementation, so the drawn output and the exported PNG can never disagree. */
  function geometryFor(edge, from, to) {
    const api = sourceApi();
    // `points` is the drawn shape (elbow corners included); `userPoints` is what the reader
    // placed, which is what a bend-point drag must edit.
    const userPoints = api.edgePoints(from, to, edge.waypoints ?? [], edge.angle);
    const points = api.edgeRenderPoints(from, to, edge.kind ?? 'arrow', edge.waypoints ?? [], edge.angle);
    return { start: points[0], end: points[points.length - 1], points, userPoints, path: api.edgePath(points, edge.kind ?? 'arrow'), mid: api.edgeMidpoint(points) };
  }

  function edgeHitDistance(edge, from, to, point) {
    const geometry = geometryFor(edge, from, to);
    return sourceApi().distanceToPoints(geometry.points, point);
  }

  const EDGE_STROKE = { arrow: '#6b7268' };


  /**
   * Draw a board onto a 2D canvas for a still export. This deliberately paints from the
   * model instead of serializing the live SVG: the page's stylesheet, theme variables and
   * fonts never leak into the file, and the result is identical wherever it runs.
   */
  function renderToCanvas(board, canvas, options = {}) {
    const scale = options.scale ?? 2, padding = options.padding ?? 40;
    const palette = { background: '#ffffff', nodeFill: '#ffffff', nodeStroke: '#b9c3b6', paperFill: '#edf3fe', paperStroke: '#4176e6', noteFill: '#fdf6e8', ink: '#0f1115', muted: '#61666b', edge: '#6b7268', ...(options.palette ?? {}) };
    const bounds = boundsOf(board.nodes) ?? { x: 0, y: 0, w: 640, h: 360 };
    const width = Math.round((bounds.w + padding * 2) * scale), height = Math.round((bounds.h + padding * 2) * scale);
    canvas.width = Math.max(1, width);
    canvas.height = Math.max(1, height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('当前环境不支持画布导出。');
    ctx.save();
    ctx.scale(scale, scale);
    ctx.fillStyle = palette.background;
    ctx.fillRect(0, 0, width / scale, height / scale);
    ctx.translate(padding - bounds.x, padding - bounds.y);
    const byId = new Map(board.nodes.map(node => [node.id, node]));
    const wrap = (text, perLine, lines) => {
      const value = String(text ?? '');
      const rows = [];
      let row = '';
      for (const character of value) {
        row += character;
        if (row.length >= perLine || character === '\n') { rows.push(row.replace(/\n$/, '')); row = ''; }
        if (rows.length >= lines) break;
      }
      if (row && rows.length < lines) rows.push(row);
      if (rows.join('').length < value.replace(/\n/g, '').length && rows.length) rows[rows.length - 1] = `${rows[rows.length - 1].slice(0, Math.max(0, perLine - 1))}…`;
      return rows;
    };
    // Edges first so nodes cover their ends.
    for (const edge of board.edges) {
      const from = byId.get(edge.from), to = byId.get(edge.to);
      if (!from || !to) continue;
      const geometry = edgeGeometry(from, to, edge.kind, edge.angle);
      ctx.strokeStyle = edge.origin === 'llm' ? palette.muted : palette.edge;
      ctx.lineWidth = 1.6;
      if (edge.origin === 'llm') ctx.setLineDash([6, 4]); else ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(geometry.start.x, geometry.start.y);
      ctx.lineTo(geometry.end.x, geometry.end.y);
      ctx.stroke();
      ctx.setLineDash([]);
      if (edge.kind === 'arrow') {
        const angle = Math.atan2(geometry.end.y - geometry.start.y, geometry.end.x - geometry.start.x), size = 9;
        ctx.fillStyle = palette.edge;
        ctx.beginPath();
        ctx.moveTo(geometry.end.x, geometry.end.y);
        ctx.lineTo(geometry.end.x - size * Math.cos(angle - Math.PI / 7), geometry.end.y - size * Math.sin(angle - Math.PI / 7));
        ctx.lineTo(geometry.end.x - size * Math.cos(angle + Math.PI / 7), geometry.end.y - size * Math.sin(angle + Math.PI / 7));
        ctx.closePath();
        ctx.fill();
      }
      if (edge.label) {
        ctx.fillStyle = palette.muted;
        ctx.font = '11px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(String(edge.label).slice(0, 40), geometry.mid.x, geometry.mid.y - 5);
        ctx.textAlign = 'left';
      }
    }
    for (const node of board.nodes) {
      const b = nodeBounds(node);
      const isPaper = node.kind === 'paper';
      ctx.fillStyle = isPaper ? palette.paperFill : node.kind === 'note' ? palette.noteFill : palette.nodeFill;
      ctx.strokeStyle = node.color ?? (isPaper ? palette.paperStroke : palette.nodeStroke);
      ctx.lineWidth = node.origin === 'llm' ? 1.2 : 1.5;
      if (node.origin === 'llm') ctx.setLineDash([5, 3]); else ctx.setLineDash([]);
      ctx.beginPath();
      if (node.kind === 'ellipse') ctx.ellipse(b.cx, b.cy, b.w / 2, b.h / 2, 0, 0, Math.PI * 2);
      else if (node.kind === 'diamond') { ctx.moveTo(b.cx, b.y); ctx.lineTo(b.right, b.cy); ctx.lineTo(b.cx, b.bottom); ctx.lineTo(b.x, b.cy); ctx.closePath(); }
      else if (node.kind === 'text') ctx.rect(b.x, b.y, b.w, b.h);
      else { const radius = NODE_RADIUS[node.kind] ?? 10; ctx.moveTo(b.x + radius, b.y); ctx.arcTo(b.right, b.y, b.right, b.bottom, radius); ctx.arcTo(b.right, b.bottom, b.x, b.bottom, radius); ctx.arcTo(b.x, b.bottom, b.x, b.y, radius); ctx.arcTo(b.x, b.y, b.right, b.y, radius); ctx.closePath(); }
      ctx.fill();
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = palette.ink;
      ctx.font = '13px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
      const inner = Math.max(4, b.w - 20), perLine = Math.max(4, Math.floor(inner / 13));
      if (isPaper && node.paper) {
        ctx.fillStyle = palette.muted;
        ctx.font = '11px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
        ctx.fillText(String([node.paper.year, node.paper.citekey].filter(Boolean).join(' · ') || '文献').slice(0, 60), b.x + 10, b.y + 18);
        ctx.fillStyle = palette.ink;
        ctx.font = '13px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
        wrap(node.text || node.paper.title || node.paper.id, perLine, 4).forEach((line, index) => ctx.fillText(line, b.x + 10, b.y + 42 + index * 17));
      } else {
        wrap(node.text, perLine, 6).forEach((line, index) => ctx.fillText(line, b.x + 10, b.y + 24 + index * 17));
      }
    }
    ctx.restore();
    return canvas;
  }

  /**
   * One knowledge-graph node becomes one board node. A paper-typed graph node keeps its
   * paper binding; anything else becomes a concept/text node carrying only the label the
   * graph already showed, so the board never invents metadata the graph did not have.
   */
  function nodeFromGraphPayload(payload) {
    if (!payload || typeof payload !== 'object') throw new Error('这个图节点没有可加入画板的内容。');
    const label = String(payload.label ?? '').trim().slice(0, LIMITS.text);
    if (!label) throw new Error('这个图节点没有可加入画板的名称。');
    if (payload.paper?.id) return paperNode({ id: payload.paper.id, title: payload.paper.title ?? label, year: payload.paper.year, citekey: payload.paper.citekey }, { x: 0, y: 0 });
    const kind = ['note', 'concept', 'text'].includes(payload.kind) ? payload.kind : 'concept';
    return createNode(kind, { x: 0, y: 0 }, label);
  }

  function create(options = {}) {
    const root = options.root;
    const api = options.api;
    const toast = options.toast || (() => {});
    const onClose = options.onClose || (() => {});
    const onOpenPaper = options.onOpenPaper || null;
    // A static host has no library and no composer; those controls are hidden rather than faked.
    const capabilities = { libraryPapers: true, conversation: true, projects: false, ...(options.capabilities ?? {}) };
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
    /** False until a board record has actually loaded. The canvas is interactive as soon as the
     *  view opens, and the first listing may still be waiting out the server's admission retry, so
     *  without this guard a shape drawn in that window lands on an unsaved board that the load
     *  then replaces — the reader's work would disappear with no warning. */
    let ready = false;
    let history = [];
    let historyIndex = -1;
    let saveTimer = null;
    let pendingSave = false;
    let conflict = null;
    let drag = null;
    let connectFrom = null;
    let editor = null;
    let spaceDown = false;
    let live = true;
    const boardList = $('board-select');
    let boardSummaries = [];

    /** One element factory for the whole board surface: the panel and board-render.js draw the
     *  same DOM, so they build it the same way. */
    const renderApi = () => {
      const api = window.PaperBoardRender;
      if (!api) throw new Error('画板需要 board-render.js：绘制由它负责。');
      return api;
    };
    const { svgEl, el } = renderApi().createElements(doc);
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

    // ── Conversation bridge ────────────────────────────────────────────────────────
    // The iframe asks the host client plugin to place a reference chip in the composer.
    // It sends identity only; the frozen material stays in the host's snapshot store.
    const bridgeApi = () => {
      const api = window.PaperBoardBridge;
      if (!api) throw new Error('画板需要 board-bridge.js：放入对话由它和主对话通信。');
      return api;
    };
    /** Created before the message listener is bound and only once: a listener that looks up a
     *  later-created instance would drop every answer that arrives before the first send. */
    function createBridge() {
      return bridgeApi().create({
        doc,
        api: () => api,
        capabilities: () => capabilities,
        boardId: () => boardId,
        live: () => live,
        board: () => board,
        conflict: () => Boolean(conflict),
        flush: () => flush(),
        sessionId: () => options.getSessionId?.() ?? null,
        toast: (message, error = false) => toast(message, error),
      });
    }
    const bridge = createBridge();
    const onBridgeResult = event => bridge.onResult(event);

    /** Freeze what the reader sees, then ask the host to place its chip in the draft. */
    const sendToConversation = () => bridge.send();

    /** The drawing surface itself: shape, edge and viewport painting lives in board-render.js,
     *  which reads the panel's state through accessors so it always draws the current board. */
    const painter = renderApi().create({
      doc,
      dom: { stage, viewport, edgeLayer, nodeLayer, empty },
      board: () => board,
      view: () => view,
      selection: () => selection,
      live: () => live,
      connectFrom: () => connectFrom,
      sourceApi,
      nodeBounds,
      geometryFor,
      round,
      nodeRadius: NODE_RADIUS,
      // Panel chrome that follows a full render: the undo/redo and delete controls and the
      // empty-state hint are the shell's business, not the renderer's.
      // The inline editor is a DOM overlay, so it follows the scene explicitly.
      onViewApplied: () => syncTextEditor(),
      onRendered: () => {
        const undo = $('board-undo'), redo = $('board-redo');
        if (undo) undo.disabled = historyIndex <= 0;
        if (redo) redo.disabled = historyIndex >= history.length - 1;
        const del = $('board-delete');
        if (del) del.disabled = !boardId;
      },
    });
    const { applyView, renderNode, renderEdge, render, redrawGeometry, noteFoldPath } = painter;

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
      // A node being typed into is empty until the edit commits; writing it now would be
      // rejected (or would drop the node under the reader's cursor). The commit re-arms this.
      if (editor) { if (saveTimer !== null) { clearTimeout(saveTimer); saveTimer = null; } return; }
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
      // `boardId` is absent until the first record loads, so an edit made during that window has
      // nowhere to go; saying so beats pretending it was stored.
      if (!live || !boardId) { pendingSave = false; if (live) status('画板尚未读取完成，这次改动没有保存。', 'error'); return; }
      if (!pendingSave) return;
      // Held back until the open edit commits: the node being typed into is empty right now.
      if (editor) return;
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
        // The host reports node problems by position; select that node so the reader can fix it —
        // but repeat the host's own reason rather than assuming what it is. The only node-level
        // rejection there used to be was an empty node, and that is no longer a rejection at all.
        const named = /第 (\d+) 个节点/.exec(error.message ?? '');
        const target = named ? board.nodes[Number(named[1]) - 1] : null;
        if (target) {
          select([target.id]);
          render(); renderInspector();
          const reason = error.message || '这个节点无法保存。';
          status(reason, 'error');
          toast(`已选中出错的那个节点：${reason}`, true);
          return;
        }
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
      renderLinks();
      syncInspector();
      const relation = $('board-relation');
      const label = $('board-edge-label-input');
      const color = $('board-color');
      const edgeKind = $('board-edge-kind');
      const edgeArrow = $('board-edge-arrow');
      const edgeDashed = $('board-edge-dashed');
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
      if (edgeKind) { edgeKind.disabled = edges.length !== 1; if (edges.length === 1) edgeKind.value = edges[0].kind ?? 'arrow'; }
      if (edgeArrow) { edgeArrow.disabled = edges.length !== 1; if (edges.length === 1) edgeArrow.value = edges[0].arrow ?? 'forward'; }
      if (edgeDashed) { edgeDashed.disabled = edges.length !== 1; edgeDashed.checked = edges.length === 1 && edges[0].dashed === true; }
      const edgeAngleSelect = $('board-edge-angle');
      if (edgeAngleSelect) { edgeAngleSelect.disabled = edges.length !== 1; if (edges.length === 1) edgeAngleSelect.value = String(edgeAngle(edges[0].angle)); }
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

    /** Place the inline editor over its node at the current zoom and pan. */
    function placeTextEditor(area, node) {
      const screen = toScreen({ x: node.x, y: node.y }, view);
      area.style.left = `${screen.x}px`; area.style.top = `${screen.y}px`;
      area.style.width = `${Math.max(60, node.w * view.zoom)}px`; area.style.height = `${Math.max(40, node.h * view.zoom)}px`;
    }
    /** Keep an open editor over its node; panning and zooming move the scene, not the DOM layer. */
    function syncTextEditor() {
      if (!editor) return;
      const node = byId(editor.node);
      if (!node) { closeTextEdit(); return; }
      placeTextEditor(editor.area, node);
    }

    function startTextEdit(node) {
      closeTextEdit();
      const area = el('textarea', 'board-text-editor');
      area.value = String(node.text || '');
      area.maxLength = LIMITS.text;
      area.setAttribute('aria-label', `编辑${KIND_LABEL[node.kind] || '节点'}文本`);
      placeTextEditor(area, node);
      // An unnamed shape is content: a reader who draws a rectangle to hold a place should keep it,
      // so leaving the editor empty stores the shape instead of discarding it. The canvas shows
      // 「（空）」 in it and the outline names it by kind, so nothing is pretending to have text.
      const commit = () => {
        const value = area.value;
        closeTextEdit();
        if (!byId(node.id)) return;
        mutate(current => model.setNodeText(current, node.id, value));
      };
      area.addEventListener('blur', commit);
      area.addEventListener('keydown', event => {
        if (event.key === 'Escape') { event.preventDefault(); commit(); }
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); commit(); }
      });
      editor = { node: node.id, area, commit };
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
    /** The toolbar's menus: one open at a time, closed by Escape or a click outside. */
    const MENU_IDS = Object.freeze([['board-files-open', 'board-files'], ['board-layout-open', 'board-layout-panel'], ['board-project-open', 'board-project-panel'], ['board-menu-open', 'board-menu']]);
    const menuEntries = () => MENU_IDS.map(([trigger, panel]) => ({ trigger: $(trigger), panel: $(panel) })).filter(entry => entry.trigger && entry.panel);
    function syncMenus() {
      for (const { trigger, panel } of menuEntries()) trigger.setAttribute('aria-expanded', String(panel.classList.contains('is-open')));
    }
    function closeMenus(keep) {
      for (const { panel } of menuEntries()) if (panel !== keep) panel.classList.remove('is-open');
      syncMenus();
    }
    /** Node and link settings only exist while something is selected. */
    function syncInspector() {
      const inspector = $('board-inspector');
      if (!inspector) return;
      const nodes = selectedNodes().length, edges = board.edges.filter(edge => selection.has(edge.id)).length;
      const nodeRow = $('board-inspector-node'), edgeRow = $('board-inspector-edge');
      if (nodeRow) nodeRow.hidden = nodes !== 1;
      if (edgeRow) edgeRow.hidden = edges !== 1;
      inspector.classList.toggle('is-open', nodes === 1 || edges === 1);
    }

    /** Finish an open edit before the board is written or closed; nothing is left half-typed. */
    function commitTextEdit() {
      if (editor) editor.commit();
    }

    function beginDrag(event) {
      const point = scenePointFromEvent(event);
      const mode = tool;
      if (mode === 'pan' || event.button === 1 || spaceDown) {
        drag = { kind: 'pan', startClient: { x: event.clientX, y: event.clientY }, startView: { ...view } };
        svg.classList.add('is-panning');
        return;
      }
      if (mode === 'connect') {
        const target = hitNode(board.nodes, point);
        if (!target) { connectFrom = null; render(); return; }
        if (!connectFrom) { connectFrom = target; select([target]); render(); return; }
        if (connectFrom === target) { toast('连线需要两个不同的节点。', true); connectFrom = null; render(); return; }
        const from = connectFrom;
        connectFrom = null;
        let created = null;
        if (mutate(current => { const result = model.addEdge(current, from, target, { kind: edgeDefaults(current).kind, angle: edgeDefaults(current).angle }); created = result.edge; return result.board; })) {
          // The new edge becomes the selection, and the tool returns to selection so the
          // reader can immediately style it or drag a bend point into it.
          if (created) select([created.id]);
          setTool('select');
        }
        render();
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
      // A selected edge owns its bend points: a handle drags it, Alt+click removes it, and
      // dragging anywhere else on the line inserts a new one at that leg.
      const selectedEdge = board.edges.find(edge => selection.has(edge.id));
      if (selectedEdge) {
        const from = byId(selectedEdge.from), to = byId(selectedEdge.to);
        if (from && to) {
          const geometry = geometryFor(selectedEdge, from, to);
          const near = Math.max(LIMITS.handle, (source()?.LIMITS ? LIMITS.hit : LIMITS.hit) ) / view.zoom;
          const handleIndex = (selectedEdge.waypoints ?? []).findIndex(entry => Math.hypot(point.x - entry[0], point.y - entry[1]) <= near);
          if (handleIndex >= 0 && event.altKey) {
            const next = (selectedEdge.waypoints ?? []).filter((_, index) => index !== handleIndex);
            mutate(current => model.setEdge(current, selectedEdge.id, { waypoints: next.length ? next : undefined }));
            return;
          }
          if (handleIndex >= 0) { drag = { kind: 'waypoint', edgeId: selectedEdge.id, index: handleIndex, points: geometry.userPoints }; return; }
          const api = source();
          const distance = api ? api.distanceToPoints(geometry.points, point) : distanceToSegment(point, geometry.start, geometry.end);
          if (distance <= LIMITS.hit / view.zoom && (selectedEdge.waypoints ?? []).length < (api?.LIMITS.waypoints ?? LIMITS.waypoints)) {
            drag = { kind: 'waypoint', edgeId: selectedEdge.id, index: -1, points: geometry.userPoints };
            return;
          }
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
        redrawGeometry(drag.ids);
        return;
      }
      if (drag.kind === 'resize') {
        const node = byId(drag.id);
        if (!node) return;
        board = model.resizeNode(board, drag.id, drag.node.w + (point.x - drag.start.x), drag.node.h + (point.y - drag.start.y));
        redrawGeometry([drag.id]);
        return;
      }
      if (drag.kind === 'connect') {
        const target = hitNode(board.nodes, point);
        drag.target = target && target !== drag.id ? target : null;
        // Nothing on the board has moved yet — this gesture only draws its own preview below — so
        // there is no geometry to redraw here.
        // One preview element per gesture, moved by rewriting its `d`. Appending a fresh path on
        // every pointer move left one orphaned node per event for the whole drag: the layer held
        // dozens of identical dashed paths, all of them repainted by the browser.
        const from = byId(drag.id), to = drag.target ? byId(drag.target) : null;
        if (!to) { drag.preview?.remove(); drag.preview = null; return; }
        if (!drag.preview) {
          drag.preview = svgEl('path', { class: 'board-edge board-edge-preview', 'data-edge-preview': drag.id, 'stroke-dasharray': '4 4' });
          edgeLayer.append(drag.preview);
        }
        drag.preview.setAttribute('d', edgeGeometry(from, to, 'arrow').path);
        return;
      }
      if (drag.kind === 'waypoint') {
        const edge = board.edges.find(value => value.id === drag.edgeId);
        if (!edge) return;
        const from = byId(edge.from), to = byId(edge.to);
        if (!from || !to) return;
        const api = source();
        const geometry = geometryFor(edge, from, to);
        try {
          const moved = api ? api.dragWaypoint(edge, geometry.userPoints, point, drag.index) : { waypoints: [[point.x, point.y]], index: 0 };
          if (api) drag.index = moved.index;
          // A click without movement must not touch the board: re-rendering here would
          // replace the handle under the pointer and swallow a double-click on it.
          if (JSON.stringify(moved.waypoints) === JSON.stringify(edge.waypoints ?? [])) return;
          drag.moved = true;
          board = model.setEdge(board, edge.id, { waypoints: moved.waypoints });
          // Only this edge's path can change; its endpoints have not moved.
          redrawGeometry([edge.from, edge.to]);
        } catch (error) { toast(error.message, true); cancelDrag(); }
        return;
      }
      if (drag.kind === 'marquee') {
        const rect = normalizeRect(drag.start, point);
        marquee.setAttribute('x', rect.x); marquee.setAttribute('y', rect.y);
        marquee.setAttribute('width', rect.w); marquee.setAttribute('height', rect.h);
        drag.rect = rect;
      }
    }

    /** End the current gesture everywhere, so a transient preview can never outlive it. */
    function cancelDrag() {
      drag?.preview?.remove();
      drag = null;
      svg.classList.remove('is-panning');
      marquee.setAttribute('hidden', 'hidden');
    }

    function endDrag() {
      if (!drag) return;
      const finished = drag;
      cancelDrag();
      if (finished.kind === 'move') { if (finished.moved) { pushHistory(); scheduleSave(); } return; }
      if (finished.kind === 'resize') { pushHistory(); render(); scheduleSave(); return; }
      if (finished.kind === 'waypoint') { if (finished.moved) { pushHistory(); render(); scheduleSave(); } return; }
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
      if (event.key === 'Escape') {
        if (doc.body.classList.contains('board-focused')) { setFocus(false); return; }
        closeTextEdit(); connectFrom = null; select([]); render();
        return;
      }
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

    /** The drawing tools are meaningless until a record has loaded, so they are plainly disabled
     *  rather than silently mutating a board that is about to be replaced. */
    function applyReady() {
      for (const id of Object.values(TOOL_IDS)) {
        const button = $(id);
        if (button) button.disabled = !ready;
      }
      stage.classList.toggle('is-loading', !ready);
    }

    function setTool(next) {
      // The click has already happened; refusing here means the reader gets a reason instead of
      // an edit that the pending load would discard.
      if (!ready && next !== 'select' && next !== 'pan') { status('画板还在读取，请稍候再绘制。'); return; }
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
      boardSummaries = result.boards;
      if (boardId) boardList.value = boardId;
      renderFileList(boardSummaries);
      if (result.truncated) status(`画板较多，列表只显示部分（共 ${result.total}）`);
      return result;
    }

    /** The board's own file list: every record with its size, open or delete. */
    function renderFileList(boards) {
      const list = $('board-file-list'), label = $('board-files-label');
      const current = boards.find(summary => summary.id === boardId);
      if (label) label.textContent = current?.title || board?.title || '未命名画板';
      if (!list) return;
      list.replaceChildren();
      if (!boards.length) { list.append(el('p', 'small muted', '还没有画板。')); return; }
      for (const summary of boards) {
        const row = el('div', 'board-file-row');
        row.classList.toggle('is-current', summary.id === boardId);
        row.append(el('strong', null, summary.title || '未命名画板'), el('small', null, `${summary.node_count ?? 0} 节点 · ${summary.edge_count ?? 0} 连线`));
        const open = el('button', 'button subtle', summary.id === boardId ? '当前' : '打开');
        open.type = 'button';
        open.disabled = summary.id === boardId;
        open.addEventListener('click', () => { closeMenus(null); void load(summary.id); });
        const remove = el('button', 'button subtle', '删除');
        remove.type = 'button';
        remove.title = '删除这张画板；记录会保留在本地状态目录，可由人工恢复';
        remove.addEventListener('click', () => { pendingDelete = summary.id; void deleteBoard(summary.id); });
        row.append(open, remove);
        list.append(row);
      }
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
      if (boardList) boardList.value = boardId;
      // The file list marks the open board and the trigger shows its name.
      renderFileList(boardSummaries);
      selection = new Set();
      history = [JSON.stringify({ nodes: board.nodes, edges: board.edges })];
      historyIndex = 0;
      conflict = null; pendingSave = false;
      renderConflict();
      const title = $('board-title');
      if (title) title.value = board.title;
      if (board.view) view = { x: board.view.x, y: board.view.y, zoom: board.view.zoom };
      else view = viewportFor(board.nodes, surfaceSize());
      render(); renderInspector(); writeLayoutControls(layoutBlock());
      if (boardList) boardList.value = boardId;
      ready = true;
      applyReady();
      status('已载入');
    }

    async function openView() {
      open = true;
      root.hidden = false;
      doc.body.classList.add('board-mode');
      // Painting is refused until a record has loaded, so the reader never draws on a board that
      // the pending listing is about to replace.
      ready = false;
      applyReady();
      status('正在读取画板…');
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
      // The record is on screen but the caller may have failed; the tools stay off until it is.
      applyReady();
    }

    async function closeView({ focus = true } = {}) {
      // A gesture in flight must not leave its preview behind in a view that is closing.
      cancelDrag();
      commitTextEdit();
      await settle({ keepalive: true });
      open = false;
      closeTextEdit();
      root.hidden = true;
      setFocus(false);
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

    async function deleteBoard(target = boardId) {
      if (!target) return;
      const name = target === boardId ? board.title : (boardSummaries.find(summary => summary.id === target)?.title ?? target);
      if (typeof doc.defaultView?.confirm === 'function' && !doc.defaultView.confirm(`删除画板「${name}」？画板记录会保留在本地状态目录，可由人工恢复。`)) return;
      // Deleting another record leaves the open one alone.
      if (target !== boardId) {
        try {
          const got = await api('board_get', { id: target });
          await api('board_delete', { id: target, expected_revision: got.revision });
          if (!live) return;
          await refreshList();
          toast('画板已删除');
        } catch (error) { toast(error.message || '删除画板失败', true); }
        return;
      }
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
      boardSummaries = boardSummaries.map(summary => (summary.id === boardId ? { ...summary, title } : summary));
      renderFileList(boardSummaries);
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

    /** Pure canvas: hide the app chrome so nothing but the board is on screen. */
    function setFocus(on) {
      doc.body.classList.toggle('board-focused', Boolean(on));
      const button = $('board-focus');
      if (button) {
        button.setAttribute('aria-pressed', String(Boolean(on)));
        button.textContent = on ? '退出专注 ⤡' : '专注 ⤢';
      }
      if (on) applyView();
    }

    function syncFullscreen() {
      const button = $('board-fullscreen');
      if (!button) return;
      const focused = Boolean(doc.fullscreenElement);
      button.setAttribute('aria-pressed', String(focused));
      button.textContent = focused ? '退出全屏 ⤡' : '全屏 ⤢';
    }

    // ── Presentation, automatic layout and the readable source ────────────────────
    const styleBlock = () => board.style ?? {};
    const layoutBlock = () => ({ mode: 'tree', direction: 'lr', gapX: 80, gapY: 36, ...(styleBlock().layout ?? {}) });
    const pinnedIds = () => new Set(Object.keys(styleBlock().layout?.pins ?? {}));
    const selectedNodeIds = () => [...selection].filter(id => byId(id));

    function readLayoutControls() {
      const mode = $('board-layout-mode')?.value ?? 'tree';
      const direction = $('board-layout-direction')?.value ?? 'lr';
      const gapX = Number($('board-layout-gap-x')?.value) || 80;
      const gapY = Number($('board-layout-gap-y')?.value) || 36;
      return { mode, direction, gapX, gapY };
    }

    function writeLayoutControls(layout) {
      if ($('board-layout-mode')) $('board-layout-mode').value = layout.mode ?? 'tree';
      if ($('board-layout-direction')) $('board-layout-direction').value = layout.direction ?? 'lr';
      if ($('board-layout-gap-x')) $('board-layout-gap-x').value = String(layout.gapX ?? 80);
      if ($('board-layout-gap-y')) $('board-layout-gap-y').value = String(layout.gapY ?? 36);
      layoutStatus();
    }

    function layoutStatus(extra = '') {
      const node = $('board-layout-status');
      if (!node) return;
      const pinned = pinnedIds().size;
      node.textContent = extra || `${pinned ? `已钉住 ${pinned} 个节点 · ` : ''}${board.nodes.length} 节点 / ${board.edges.length} 连线`;
    }

    /** Layout the scope, leaving pinned nodes exactly where the reader parked them. */
    function applyLayout() {
      const api = source();
      if (!api) { toast('这个页面没有加载排版模块。', true); return 0; }
      const ids = selectedNodeIds();
      const scoped = ids.length > 1;
      const pinned = pinnedIds();
      const scope = (scoped ? board.nodes.filter(node => ids.includes(node.id)) : board.nodes).filter(node => !pinned.has(node.id));
      if (scope.length < 2) {
        toast(pinned.size ? '可排版的节点不足两个：已钉住的节点不参与自动排版。' : '至少要有两个节点才能自动排版。', true);
        return 0;
      }
      const inScope = new Set(scope.map(node => node.id));
      const edges = board.edges.filter(edge => inScope.has(edge.from) && inScope.has(edge.to));
      const { mode, direction, gapX, gapY } = readLayoutControls();
      const arranged = new Map(api.layout(scope, edges, { mode, direction, gapX, gapY }).map(node => [node.id, node]));
      board = {
        ...board,
        nodes: board.nodes.map(node => arranged.get(node.id) ?? node),
        style: { ...styleBlock(), layout: { ...(styleBlock().layout ?? {}), mode, direction, gapX, gapY, ...(pinned.size ? { pins: styleBlock().layout.pins } : {}) } },
      };
      pushHistory(); render(); scheduleSave();
      layoutStatus(`已按${mode === 'radial' ? '放射思维导图' : mode === 'layered' ? '分层图' : '分层树'}（${direction}）排布 ${scope.length} 个节点`);
      return scope.length;
    }

    /** Pins are the escape hatch for deliberate placement: the layout never moves them. */
    function setPinned(ids, on) {
      if (!ids.length) { toast('请先选中要钉住（或取消钉住）的节点。', true); return 0; }
      const pins = { ...(styleBlock().layout?.pins ?? {}) };
      let changed = 0;
      for (const id of ids) {
        const node = byId(id);
        if (!node) continue;
        if (on && !pins[id]) { pins[id] = [node.x, node.y]; changed++; }
        else if (!on && pins[id]) { delete pins[id]; changed++; }
      }
      if (!changed) { toast(on ? '选中的节点已经钉住了。' : '选中的节点没有钉住。'); return 0; }
      const layout = { ...(styleBlock().layout ?? {}) };
      if (Object.keys(pins).length) layout.pins = pins; else delete layout.pins;
      board = { ...board, style: { ...styleBlock(), layout } };
      pushHistory(); scheduleSave(); layoutStatus();
      toast(on ? `已钉住 ${changed} 个节点：它们不再参与自动排版。` : `已取消钉住 ${changed} 个节点。`);
      return changed;
    }

    const sourceTexts = () => {
      const api = source();
      if (!api) return null;
      const layout = readLayoutControls();
      const { source: content, style } = api.toSource({ ...board, title: board.title }, layout);
      return { content: JSON.stringify(content, null, 2), style: JSON.stringify(style, null, 2) };
    };

    function applySourceTexts(contentText, styleText) {
      const api = source();
      if (!api) throw new Error('这个页面没有加载源文件模块。');
      if (!contentText.trim()) throw new Error('内容源文件是空的。');
      let content, style = {};
      try { content = JSON.parse(contentText); } catch (error) { throw new Error(`内容源文件不是合法 JSON：${error.message}`); }
      if (styleText.trim()) { try { style = JSON.parse(styleText); } catch (error) { throw new Error(`样式文件不是合法 JSON：${error.message}`); } }
      const converted = api.fromSource(content, style);
      board = {
        ...board,
        title: converted.board.title,
        nodes: converted.board.nodes,
        edges: converted.board.edges,
        style: Object.keys(converted.style).length > 1 || Object.keys(converted.style).length ? converted.style : undefined,
      };
      selection = new Set();
      pushHistory(); render(); renderInspector();
      writeLayoutControls({ mode: converted.mode, direction: converted.direction, ...(converted.style.layout ?? {}) });
      scheduleSave();
      return { nodes: board.nodes.length, edges: board.edges.length };
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

    /**
     * Add one knowledge-graph node to the current board. The graph lives in the same
     * column as the board, so this is the reachable path rather than a drag; it works
     * with the board closed by reading and writing the record through the host.
     */
    async function addGraphNode(payload) {
      let node;
      try { node = nodeFromGraphPayload(payload); }
      catch (error) { toast(error.message, true); return false; }
      try {
        if (boardId) await settle();
        let target = boardId, current = boardId ? { board, revision } : null;
        if (!target) {
          const list = await api('board_list', {});
          if (list.boards.length) {
            const got = await api('board_get', { id: list.boards[0].id });
            target = got.board.id; current = { board: got.board, revision: got.revision };
          } else {
            const created = await api('board_create', { board: { title: '我的文献画板', nodes: [], edges: [] } });
            target = created.board.id; current = { board: created.board, revision: created.revision };
          }
        }
        if (current.board.nodes.length >= LIMITS.nodes) throw new Error(`画板最多 ${LIMITS.nodes} 个节点。`);
        const placed = placeInColumn(current.board.nodes, [node])[0];
        const saved = await api('board_save', { id: target, board: { ...current.board, nodes: [...current.board.nodes, placed] }, expected_revision: current.revision });
        if (!live) return false;
        if (open && target === boardId) { board = saved.board; revision = saved.revision; render(); }
        else if (open) await load(target);
        toast('已把这个节点加入画板');
        return true;
      } catch (error) { toast(error.message || '加入画板失败', true); return false; }
    }

    /**
     * Links are associative and many-to-many: a board may sit under several papers and
     * reading projects at once, and unlinking never touches the board's content.
     */
    const LINKS = { papers: 50, projects: 20 };
    function links() {
      return { papers: [...(board.links?.papers ?? [])], projects: [...(board.links?.projects ?? [])] };
    }

    function setLink(kind, id, on) {
      if (id === undefined || id === null || id === '') { toast('先选择要关联的对象。', true); return false; }
      if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,60}$/.test(id)) { toast('关联标识无效。', true); return false; }
      const current = links();
      const list = current[kind] ?? [];
      const has = list.includes(id);
      if (on === has) { toast(on ? '已经关联过了。' : '没有关联这一项。'); return false; }
      const next = on ? [...list, id] : list.filter(value => value !== id);
      if (next.length > LINKS[kind]) { toast(`一张画板最多关联 ${LINKS[kind]} 个${kind === 'papers' ? '论文' : '项目'}。`, true); return false; }
      const merged = { ...links(), [kind]: next };
      const linksValue = {};
      if (merged.papers.length) linksValue.papers = merged.papers;
      if (merged.projects.length) linksValue.projects = merged.projects;
      mutate(currentBoard => ({ ...currentBoard, links: Object.keys(linksValue).length ? linksValue : undefined }));
      renderLinks();
      return true;
    }

    /** The project list belongs to the catalog; the panel only offers what it is given.
     *  The panel is built before the catalog has said whether it has projects at all, so the
     *  controls are revealed here as well as hidden during the initial bind. */
    function syncProjectControls() {
      const hidden = !capabilities.projects;
      for (const id of ['board-project-select', 'board-link-project', 'board-unlink-project']) { const control = $(id); if (control) control.hidden = hidden; }
    }

    function setProjects(list) {
      const select = $('board-project-select');
      capabilities.projects = Array.isArray(list);
      syncProjectControls();
      if (!select) return;
      select.replaceChildren();
      for (const entry of list ?? []) {
        const option = el('option', null, entry.title);
        option.value = entry.id;
        select.append(option);
      }
      const empty = !select.options?.length;
      const linkButton = $('board-link-project'), unlinkButton = $('board-unlink-project');
      if (linkButton) linkButton.disabled = empty;
      if (unlinkButton) unlinkButton.disabled = empty;
      if (!select.options?.length) {
        const placeholder = el('option', null, '还没有阅读项目');
        placeholder.value = '';
        select.append(placeholder);
      }
    }

    function renderLinks() {
      const node = $('board-links');
      if (!node) return;
      const { papers, projects } = links();
      const parts = [];
      if (papers.length) parts.push(`关联论文 ${papers.length}`);
      if (projects.length) parts.push(`关联项目 ${projects.length}`);
      node.textContent = parts.length ? parts.join(' · ') : '未关联任何论文或项目';
      const active = options.getActivePaperId?.();
      const linkButton = $('board-link-paper');
      if (linkButton) linkButton.disabled = !active || papers.includes(active);
      const unlinkButton = $('board-unlink-paper');
      if (unlinkButton) unlinkButton.disabled = !active || !papers.includes(active);
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
        const at = scenePointFromEvent(event);
        // Double-clicking a bend point removes it: Alt-click works too, but a canvas needs a
        // gesture a reader can discover without being told.
        const selectedEdge = board.edges.find(edge => selection.has(edge.id));
        if (selectedEdge && (selectedEdge.waypoints ?? []).length) {
          const reach = LIMITS.handle / view.zoom;
          const index = selectedEdge.waypoints.findIndex(point => Math.hypot(at.x - point[0], at.y - point[1]) <= reach);
          if (index >= 0) {
            const next = selectedEdge.waypoints.filter((_, position) => position !== index);
            mutate(current => model.setEdge(current, selectedEdge.id, { waypoints: next.length ? next : undefined }));
            render();
            return;
          }
        }
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
      const sendButton = $('board-send');
      if (sendButton) sendButton.addEventListener('click', () => void sendToConversation());
      bridge.listen();
      const zoomIn = $('board-zoom-in'), zoomOut = $('board-zoom-out'), fit = $('board-fit');
      if (zoomIn) zoomIn.addEventListener('click', () => { const size = surfaceSize(); view = applyZoom(view, 1.2, { x: size.width / 2, y: size.height / 2 }); applyView(); });
      if (zoomOut) zoomOut.addEventListener('click', () => { const size = surfaceSize(); view = applyZoom(view, 1 / 1.2, { x: size.width / 2, y: size.height / 2 }); applyView(); });
      if (fit) fit.addEventListener('click', () => { view = viewportFor(board.nodes, surfaceSize()); applyView(); scheduleSave(); });
      for (const [name, id] of Object.entries(TOOL_IDS)) { const button = $(id); if (button) button.addEventListener('click', () => setTool(name)); }
      const addPaperButton = $('board-add-paper');
      if (addPaperButton) addPaperButton.addEventListener('click', () => { options.onRequestPapers?.(); });
      for (const button of doc.querySelectorAll?.('#board-source-dialog .dialog-close') ?? []) button.addEventListener('click', () => sourceDialog?.close?.());
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
      // Edge appearance, automatic layout, pins and the readable source file.
      const editSelectedEdge = update => { const edge = board.edges.find(value => selection.has(value.id)); if (edge) mutate(current => model.setEdge(current, edge.id, update)); };
      const edgeKind = $('board-edge-kind'), edgeArrow = $('board-edge-arrow'), edgeDashed = $('board-edge-dashed'), edgeAngleSelect = $('board-edge-angle');
      if (edgeKind) edgeKind.addEventListener('change', () => { pendingEdgeKind = edgeKind.value; editSelectedEdge({ kind: edgeKind.value }); });
      if (edgeAngleSelect) edgeAngleSelect.addEventListener('change', () => { const value = edgeAngle(edgeAngleSelect.value); pendingEdgeAngle = value; editSelectedEdge({ angle: value === EDGE_ANGLE.default ? undefined : value }); });
      if (edgeArrow) edgeArrow.addEventListener('change', () => editSelectedEdge({ arrow: edgeArrow.value === 'forward' ? undefined : edgeArrow.value }));
      if (edgeDashed) edgeDashed.addEventListener('change', () => editSelectedEdge({ dashed: edgeDashed.checked ? true : undefined }));
      const layoutApply = $('board-layout-apply');
      if (layoutApply) layoutApply.addEventListener('click', () => { applyLayout(); });
      const pinButton = $('board-layout-pin'), unpinButton = $('board-layout-unpin');
      if (pinButton) pinButton.addEventListener('click', () => setPinned(selectedNodeIds(), true));
      if (unpinButton) unpinButton.addEventListener('click', () => setPinned(selectedNodeIds(), false));
      const linkButton = $('board-link-paper'), unlinkButton = $('board-unlink-paper');
      if (linkButton) linkButton.addEventListener('click', () => { const id = options.getActivePaperId?.(); if (id) setLink('papers', id, true); else toast('先在文献库里打开一篇论文。', true); });
      if (unlinkButton) unlinkButton.addEventListener('click', () => { const id = options.getActivePaperId?.(); if (id) setLink('papers', id, false); });
      const focusButton = $('board-focus');
      if (focusButton) focusButton.addEventListener('click', () => setFocus(!doc.body.classList.contains('board-focused')));
      const sourceDialog = $('board-source-dialog');
      const sourceStatus = (message, error = false) => {
        const node = $('board-source-status');
        if (!node) return;
        node.textContent = message;
        node.classList.toggle('is-error', Boolean(error));
      };
      const fillSourceFields = () => {
        const texts = sourceTexts();
        if (!texts) { sourceStatus('这个页面没有加载源文件模块。', true); return null; }
        if ($('board-source-content')) $('board-source-content').value = texts.content;
        if ($('board-source-style')) $('board-source-style').value = texts.style;
        return texts;
      };
      const mermaid = () => window.PaperBoardMermaid ?? null;
      const sourceOpen = $('board-source-open');
      if (sourceOpen) sourceOpen.addEventListener('click', () => {
        if (!$('board-source-content')?.value.trim()) fillSourceFields();
        sourceStatus('内容文件不含坐标：位置来自排版与固定位置。');
        sourceDialog?.showModal?.();
      });
      // Mermaid is a third way into the same source path: parse it into the two boxes, and let
      // the existing 「校验并应用」 be the only thing that touches the board.
      const mermaidStatus = (message, error = false) => {
        const node = $('board-mermaid-status');
        if (!node) return;
        node.textContent = message;
        node.classList.toggle('is-error', Boolean(error));
      };
      const mermaidOpen = $('board-mermaid-open');
      if (mermaidOpen) mermaidOpen.addEventListener('click', () => {
        if (!$('board-source-content')?.value.trim()) fillSourceFields();
        sourceDialog?.showModal?.();
        mermaidStatus('粘贴 Mermaid flowchart，点「解析为源文件」，再点「校验并应用」。');
        $('board-mermaid-text')?.focus?.();
      });
      const mermaidParse = $('board-mermaid-parse');
      if (mermaidParse) mermaidParse.addEventListener('click', () => {
        const api = mermaid();
        const text = $('board-mermaid-text')?.value ?? '';
        if (!api) { mermaidStatus('这个页面没有加载 Mermaid 模块。', true); return; }
        if (!text.trim()) { mermaidStatus('先粘贴一段 Mermaid flowchart。', true); return; }
        const parsed = api.parse(text, { title: board.title ? `${board.title} · Mermaid` : 'Mermaid 导入' });
        if (!parsed.source.nodes.length) {
          const first = parsed.warnings[0];
          mermaidStatus(first ? `第 ${first.line} 行：${first.message}` : '没有解析出节点。', true);
          return;
        }
        const style = { schema: source()?.STYLE_SCHEMA, layout: { mode: parsed.layout.mode, direction: parsed.layout.direction } };
        $('board-source-content').value = JSON.stringify(parsed.source, null, 2);
        $('board-source-style').value = JSON.stringify(style, null, 2);
        const notes = parsed.warnings.map(warning => `第 ${warning.line} 行：${warning.message}`);
        mermaidStatus(`解析出 ${parsed.counts.nodes} 个节点、${parsed.counts.edges} 条连线（${parsed.direction.toUpperCase()} 方向）。点「校验并应用」写入画板。${notes.length ? ` ⚠ ${notes.join('；')}` : ''}`, false);
      });
      const mermaidGenerate = $('board-mermaid-generate');
      if (mermaidGenerate) mermaidGenerate.addEventListener('click', () => {
        const api = mermaid();
        if (!api) { mermaidStatus('这个页面没有加载 Mermaid 模块。', true); return; }
        if (!board.nodes.length) { mermaidStatus('当前画板还没有节点。', true); return; }
        const written = api.format(board);
        if ($('board-mermaid-text')) $('board-mermaid-text').value = written.text;
        mermaidStatus(`已写出 ${board.nodes.length} 个节点、${board.edges.length} 条连线${written.warnings.length ? `（${written.warnings.join('；')}）` : ''}。`);
      });
      const sourceGenerate = $('board-source-generate');
      if (sourceGenerate) sourceGenerate.addEventListener('click', () => { if (fillSourceFields()) sourceStatus('已按当前画布重写两个文件。'); });
      const sourceApply = $('board-source-apply');
      if (sourceApply) sourceApply.addEventListener('click', () => {
        try {
          const result = applySourceTexts($('board-source-content')?.value ?? '', $('board-source-style')?.value ?? '');
          sourceStatus(`已应用：${result.nodes} 个节点、${result.edges} 条连线。`);
        } catch (error) { sourceStatus(error.message, true); }
      });
      const downloadText = (name, text) => {
        const view = doc.defaultView;
        if (!view?.Blob || !view.URL?.createObjectURL) { sourceStatus('这个环境不支持下载文件。', true); return; }
        const url = view.URL.createObjectURL(new view.Blob([text], { type: 'application/json' }));
        const link = doc.createElement('a');
        link.href = url; link.download = name;
        doc.body.append(link); link.click(); link.remove();
        view.setTimeout?.(() => view.URL.revokeObjectURL(url), 1000);
      };
      const sourceDownload = $('board-source-download');
      if (sourceDownload) sourceDownload.addEventListener('click', () => {
        const texts = $('board-source-content')?.value.trim() ? { content: $('board-source-content').value, style: $('board-source-style')?.value ?? '{}' } : fillSourceFields();
        if (!texts) return;
        const slug = String(board.title ?? 'board').replace(/[\\/:*?"<>|\s]+/g, '-').slice(0, 60) || 'board';
        downloadText(`${slug}.json`, texts.content);
        downloadText(`${slug}.style.json`, texts.style);
        sourceStatus('已下载内容文件与样式文件；把它们放进仓库即可用 URL 直接加载。');
      });
      const sourceFile = $('board-source-file');
      const sourceUpload = $('board-source-upload');
      if (sourceUpload && sourceFile) sourceUpload.addEventListener('click', () => sourceFile.click());
      if (sourceFile) sourceFile.addEventListener('change', async () => {
        const files = [...(sourceFile.files ?? [])];
        sourceFile.value = '';
        if (!files.length) return;
        try {
          for (const file of files) {
            const body = await file.text();
            JSON.parse(body);
            if (/style/i.test(file.name)) { if ($('board-source-style')) $('board-source-style').value = body; }
            else if ($('board-source-content')) $('board-source-content').value = body;
          }
          sourceStatus('已读入文件；点「校验并应用」才会改动画布。');
        } catch (error) { sourceStatus(`文件不是合法 JSON：${error.message}`, true); }
      });
      const emptyCreate = $('board-create-first');
      if (emptyCreate) emptyCreate.addEventListener('click', () => void createBoard());
      // Every secondary group is one menu: the trigger toggles a panel that drops over the
      // canvas, and only one is open at a time.
      for (const { trigger, panel } of menuEntries()) {
        trigger.addEventListener('click', event => {
          event.stopPropagation?.();
          const open = !panel.classList.contains('is-open');
          closeMenus(open ? panel : null);
          panel.classList.toggle('is-open', open);
          syncMenus();
        });
      }
      doc.addEventListener('click', event => { if (!event.target?.closest?.('.board-bar')) closeMenus(null); });
      // The inspector only offers a shape change for a single node; paper nodes keep their binding.
      if (!capabilities.libraryPapers) for (const id of ['board-add-paper']) { const control = $(id); if (control) control.hidden = true; }
      if (!capabilities.conversation) for (const id of ['board-send']) { const control = $(id); if (control) control.hidden = true; }
      if (!capabilities.projects) syncProjectControls();
      const linkProject = $('board-link-project'), unlinkProject = $('board-unlink-project');
      if (linkProject) linkProject.addEventListener('click', () => setLink('projects', $('board-project-select')?.value, true));
      if (unlinkProject) unlinkProject.addEventListener('click', () => setLink('projects', $('board-project-select')?.value, false));
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
      links, setLink, setFocus, setProjects,
      open: openView, close: closeView, resize, load, refreshList, render,
      isOpen: () => open,
      board: () => board,
      selection: () => [...selection],
      flush,
      addPaper,
      addPapers,
      generateFromPapers,
      addGraphNode,
      tidy,
      applyLayout,
      setPinned,
      sourceTexts,
      applySourceTexts,
      layoutBlock,
      sendToConversation,
      // The conversation bridge is exposed for tests and for hosts that want to observe the
      // postMessage handshake; the panel itself only ever calls `send`.
      conversation: { send: sendToConversation, pending: () => bridge.pendingCount(), onResult: event => bridge.onResult(event) },
      outline: (maximum) => outline({ ...board, title: board.title }, maximum),
      setTool,
      dispose() {
        cancelDrag();
        commitTextEdit();
        closeTextEdit();
        if (saveTimer !== null) { clearTimeout(saveTimer); saveTimer = null; }
        // The page may be unloading: start a keepalive write before disabling the panel.
        if (pendingSave) void flush({ keepalive: true });
        live = false;
        bridge.dispose();
        doc.removeEventListener('keydown', onKeyDown);
        doc.removeEventListener('keyup', onKeyUp);
        doc.removeEventListener('fullscreenchange', syncFullscreen);
      },
    };
  }

  window.PaperBoard = Object.freeze({
    create, model, outline, renderToCanvas, createNode, paperNode, nodeFromGraphPayload, tidyTree, placeInColumn, boardFromPapers,
    LIMITS, NODE_KINDS, KIND_LABEL, RELATIONS, RELATION_ORDER, EDGE_KINDS, EDGE_ANGLE, COLORS, DEFAULT_SIZE,
    geometry: { round, round3, clamp, EDGE_ANGLE, nodeBounds, toScene, toScreen, applyZoom, boundsOf, viewportFor, hitNode, hitEdge, edgeGeometry, anchorPoint, anchorAtAngle, incidenceAt, edgeAngle, distanceToSegment, normalizeRect, idsInRect },
  });
})();
