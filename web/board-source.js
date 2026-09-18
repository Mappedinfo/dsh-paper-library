/* Whiteboard source, layout and edge geometry.
 *
 * Three pure layers, deliberately free of the DOM so both hosts and the tests can use
 * them directly:
 *
 *   1. edge geometry  — a path through reader-placed waypoints, for arrow/line/elbow.
 *   2. layout         — deterministic tree / radial / layered placement, with pins.
 *   3. source codec   — a readable content file plus a `.style.json` sidecar.
 *
 * The content file is written for humans and models: short ids, stable key order, no
 * pixel coordinates (those come from the layout), and no defaults. Everything about how
 * it looks or where a node is deliberately parked lives in the sidecar instead.
 */
(function () {
  'use strict';

  const SOURCE_SCHEMA = 'paper-library-board.v1';
  const STYLE_SCHEMA = 'paper-library-board-style.v1';
  const NODE_KINDS = ['text', 'note', 'concept', 'paper', 'rect', 'ellipse', 'diamond'];
  const EDGE_KINDS = ['arrow', 'line', 'elbow'];
  const RELATIONS = ['related', 'supports', 'contradicts', 'cites', 'explains', 'extends'];
  const ARROWS = ['forward', 'none', 'both'];
  const MODES = ['tree', 'radial', 'layered'];
  const DIRECTIONS = ['lr', 'tb', 'rl', 'bt'];
  const LIMITS = { nodes: 400, edges: 800, text: 2000, label: 200, title: 200, waypoints: 8, gapMin: 8, gapMax: 400, coordinate: 1000000 };
  const COLORS = /^#[0-9a-fA-F]{6}$/;

  const fail = message => { throw new Error(message); };
  const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  const closed = (value, name, allowed) => {
    if (!isObject(value)) fail(`${name}必须是对象。`);
    for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`${name}包含不支持的字段 ${key}。`);
    return value;
  };
  const text = (value, name, maximum, required = false) => {
    if (value === undefined && !required) return undefined;
    if (typeof value !== 'string' || value.length > maximum || (required && !value.trim())) fail(`${name}${required ? '为空或' : ''}超过 ${maximum} 个字符。`);
    return value;
  };
  const identifier = (value, name) => {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,60}$/.test(value)) fail(`${name}必须是 1–60 位字母、数字、短横线或下划线。`);
    return value;
  };
  const tint = (value, name) => {
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || !COLORS.test(value)) fail(`${name}必须是 #rrggbb 颜色。`);
    return value.toLowerCase();
  };
  const amount = (value, name, low, high) => {
    if (!Number.isFinite(value) || value < low || value > high) fail(`${name}必须在 ${low}–${high} 之间。`);
    return Math.round(value * 10) / 10;
  };
  const coordinate = (value, name) => {
    if (!Number.isFinite(value) || Math.abs(value) > LIMITS.coordinate) fail(`${name}超出画板坐标范围。`);
    return Math.round(value * 100) / 100;
  };

  // ── Edge geometry ─────────────────────────────────────────────────────────────

  const nodeBoundsOf = node => ({ x: node.x, y: node.y, w: node.w, h: node.h, right: node.x + node.w, bottom: node.y + node.h, cx: node.x + node.w / 2, cy: node.y + node.h / 2 });
  const round = value => Math.round(value * 100) / 100;

  /** Clip a centre-to-centre segment to a node's border, so arrowheads sit on the edge. */
  function anchorPoint(node, towards) {
    const bounds = nodeBoundsOf(node), dx = towards.x - bounds.cx, dy = towards.y - bounds.cy;
    if (!dx && !dy) return { x: bounds.cx, y: bounds.cy };
    const scaleX = dx ? (bounds.w / 2) / Math.abs(dx) : Infinity, scaleY = dy ? (bounds.h / 2) / Math.abs(dy) : Infinity;
    const scale = Math.min(scaleX, scaleY);
    return { x: round(bounds.cx + dx * scale), y: round(bounds.cy + dy * scale) };
  }

  const asPoint = value => ({ x: value[0] ?? value.x, y: value[1] ?? value.y });

  /**
   * The polyline an edge actually follows. Waypoints are reader-placed absolute points, so
   * a line can be routed around a node; the first and last legs are clipped to the shapes.
   */
  function edgePoints(from, to, waypoints = []) {
    const middle = waypoints.map(asPoint);
    const first = middle[0] ?? { x: nodeBoundsOf(to).cx, y: nodeBoundsOf(to).cy };
    const last = middle[middle.length - 1] ?? { x: nodeBoundsOf(from).cx, y: nodeBoundsOf(from).cy };
    return [anchorPoint(from, first), ...middle.map(point => ({ x: round(point.x), y: round(point.y) })), anchorPoint(to, last)];
  }

  /**
   * The polyline actually drawn. An elbow path inserts the orthogonal corner between two
   * points, so hit-testing, label placement and dragging all measure the shape on screen
   * instead of an invisible straight line between its ends.
   */
  function edgeRenderPoints(from, to, kind, waypoints = []) {
    const points = edgePoints(from, to, waypoints);
    if (kind !== 'elbow' || points.length < 2) return points;
    const out = [points[0]];
    for (let index = 1; index < points.length; index++) {
      const previous = points[index - 1], point = points[index];
      if (previous.y !== point.y && previous.x !== point.x) out.push({ x: point.x, y: previous.y });
      out.push(point);
    }
    return out;
  }

  function edgePath(points, kind) {
    if (!points.length) return '';
    if (kind !== 'elbow') return points.map((point, index) => `${index ? 'L' : 'M'} ${point.x} ${point.y}`).join(' ');
    // Orthogonal routing: alternate horizontal and vertical legs between consecutive points.
    let path = `M ${points[0].x} ${points[0].y}`;
    for (let index = 1; index < points.length; index++) {
      const previous = points[index - 1], point = points[index];
      if (previous.y === point.y) path += ` H ${point.x}`;
      else if (previous.x === point.x) path += ` V ${point.y}`;
      else path += ` H ${point.x} V ${point.y}`;
    }
    return path;
  }

  /** Point on the polyline at half its total length, used for labels. */
  function edgeMidpoint(points) {
    if (points.length < 2) return points[0] ?? { x: 0, y: 0 };
    const lengths = [];
    let total = 0;
    for (let index = 1; index < points.length; index++) {
      const length = Math.hypot(points[index].x - points[index - 1].x, points[index].y - points[index - 1].y);
      lengths.push(length); total += length;
    }
    let travelled = total / 2;
    for (let index = 1; index < points.length; index++) {
      const length = lengths[index - 1];
      if (travelled <= length || index === points.length - 1) {
        const ratio = length ? travelled / length : 0;
        return { x: round(points[index - 1].x + (points[index].x - points[index - 1].x) * ratio), y: round(points[index - 1].y + (points[index].y - points[index - 1].y) * ratio) };
      }
      travelled -= length;
    }
    return points[points.length - 1];
  }

  function distanceToSegment(point, start, end) {
    const dx = end.x - start.x, dy = end.y - start.y, length = dx * dx + dy * dy;
    if (!length) return Math.hypot(point.x - start.x, point.y - start.y);
    const t = Math.min(1, Math.max(0, ((point.x - start.x) * dx + (point.y - start.y) * dy) / length));
    return Math.hypot(point.x - (start.x + t * dx), point.y - (start.y + t * dy));
  }

  function distanceToPoints(points, point) {
    let best = Infinity;
    for (let index = 1; index < points.length; index++) best = Math.min(best, distanceToSegment(point, points[index - 1], points[index]));
    return best;
  }

  /** Which leg a point is nearest, so a drag can insert or move the right waypoint. */
  function nearestLeg(points, point) {
    let best = { index: 0, distance: Infinity, at: points[0] ?? { x: 0, y: 0 } };
    for (let index = 1; index < points.length; index++) {
      const start = points[index - 1], end = points[index];
      const dx = end.x - start.x, dy = end.y - start.y, length = dx * dx + dy * dy;
      const t = length ? Math.min(1, Math.max(0, ((point.x - start.x) * dx + (point.y - start.y) * dy) / length)) : 0;
      const at = { x: round(start.x + t * dx), y: round(start.y + t * dy) };
      const distance = Math.hypot(point.x - at.x, point.y - at.y);
      if (distance < best.distance) best = { index, distance, at };
    }
    return best;
  }

  /**
   * Dragging a leg inserts a waypoint there (or moves the one already owning that leg),
   * bounded by the host's per-edge waypoint limit.
   */
  function dragWaypoint(edge, points, point, waypointIndex) {
    const waypoints = (edge.waypoints ?? []).map(value => Array.isArray(value) ? [...value] : [value.x, value.y]);
    const target = [round(point.x), round(point.y)];
    if (Number.isInteger(waypointIndex) && waypointIndex >= 0 && waypointIndex < waypoints.length) {
      waypoints[waypointIndex] = target;
      return { waypoints, index: waypointIndex, inserted: false };
    }
    const leg = nearestLeg(points, point);
    // Legs are indexed from 1; internal legs 1..n-1 own an existing waypoint.
    const inserted = Math.max(0, Math.min(waypoints.length, leg.index - 1));
    if (waypoints.length >= LIMITS.waypoints && leg.index - 1 >= waypoints.length) fail(`一条连线最多 ${LIMITS.waypoints} 个拐点。`);
    waypoints.splice(inserted, 0, target);
    return { waypoints, index: inserted, inserted: true };
  }

  // ── Layout ────────────────────────────────────────────────────────────────────

  const boundsOf = nodes => {
    if (!nodes.length) return null;
    const x = Math.min(...nodes.map(node => node.x)), y = Math.min(...nodes.map(node => node.y));
    const right = Math.max(...nodes.map(node => node.x + node.w)), bottom = Math.max(...nodes.map(node => node.y + node.h));
    return { x, y, w: right - x, h: bottom - y };
  };
  const verticalOrder = (byId, a, b) => (byId.get(a).y - byId.get(b).y) || (byId.get(a).x - byId.get(b).x) || (a < b ? -1 : a > b ? 1 : 0);

  /**
   * Directed forest: at most one parent per node, cycles cannot recurse forever.
   * `order` decides sibling order — the tree keeps the reader's vertical arrangement,
   * while radial uses the stable board order so arranging twice cannot swap nodes.
   */
  function forest(nodes, edges, rootId, order) {
    const byId = new Map(nodes.map(node => [node.id, node]));
    const compare = order ?? ((a, b) => verticalOrder(byId, a, b));
    const children = new Map(), hasParent = new Set();
    for (const edge of edges) {
      if (edge.from === edge.to || !byId.has(edge.from) || !byId.has(edge.to) || hasParent.has(edge.to)) continue;
      if (!children.has(edge.from)) children.set(edge.from, []);
      children.get(edge.from).push(edge.to);
      hasParent.add(edge.to);
    }
    for (const list of children.values()) list.sort(compare);
    const ordered = nodes.map(node => node.id).sort(compare);
    const explicit = rootId && byId.has(rootId) ? rootId : null;
    const roots = [explicit ?? ordered.find(id => !hasParent.has(id)) ?? ordered[0]];
    for (const id of ordered) if (!roots.includes(id)) roots.push(id);
    return { byId, children, ordered, roots };
  }

  /** Depth-first sizes, so radial and layered placement can reserve room for a subtree. */
  function subtreeSizes(roots, children) {
    const size = new Map(), seen = new Set();
    const walk = id => {
      if (seen.has(id)) return 0;
      seen.add(id);
      let total = 1;
      for (const child of children.get(id) ?? []) if (!seen.has(child)) total += walk(child);
      size.set(id, total);
      return total;
    };
    for (const root of roots) if (!seen.has(root)) walk(root);
    return size;
  }

  function treeLayout(nodes, edges, options) {
    const { gapX, gapY } = options, { byId, children, ordered, roots } = forest(nodes, edges, options.rootId);
    const depth = new Map(), rows = new Map(), seen = new Set();
    let nextRow = 0;
    const assign = (id, level) => {
      seen.add(id); depth.set(id, level);
      const kids = (children.get(id) ?? []).filter(child => !seen.has(child));
      if (!kids.length) { rows.set(id, nextRow); return nextRow++; }
      const placed = kids.map(child => assign(child, level + 1));
      const row = (placed[0] + placed[placed.length - 1]) / 2;
      rows.set(id, row);
      return row;
    };
    for (const root of roots) if (!seen.has(root)) assign(root, 0);
    for (const id of ordered) if (!seen.has(id)) assign(id, depth.size ? Math.max(...depth.values()) + 1 : 0);
    const columnWidth = [];
    for (const [id, level] of depth) columnWidth[level] = Math.max(columnWidth[level] ?? 0, byId.get(id).w);
    const columnX = [];
    let cursor = 0;
    for (let level = 0; level < columnWidth.length; level++) { columnX[level] = cursor; cursor += columnWidth[level] + gapX; }
    const rowHeight = Math.max(...nodes.map(node => node.h)) + gapY;
    const bounds = boundsOf(nodes);
    const originX = bounds ? bounds.x : 0, originY = bounds ? bounds.y : 0;
    const rowCount = Math.max(...nodes.map(node => rows.get(node.id)));
    return new Map(nodes.map(node => [node.id, {
      x: round(originX + columnX[depth.get(node.id)]),
      // Growing upwards reverses the row axis, so flip it back to keep the reader's order.
      y: round(originY + (options.flipRows ? (rowCount - rows.get(node.id)) : rows.get(node.id)) * rowHeight),
    }]));
  }

  function radialLayout(nodes, edges, options) {
    const { gapX, gapY } = options;
    const stable = new Map(nodes.map((node, index) => [node.id, index]));
    const { byId, children, roots } = forest(nodes, edges, options.rootId, (a, b) => stable.get(a) - stable.get(b));
    const size = subtreeSizes(roots, children);
    const ring = Math.max(140, Math.max(...nodes.map(node => node.h)) + gapY * 2);
    // Local coordinates come from the structure alone — no input bounding box, no current
    // position — which is what lets the same board be arranged repeatedly without drift.
    const positions = new Map(), placed = new Set();
    for (const [index, root] of roots.entries()) {
      if (placed.has(root)) continue;
      const offsetX = index === 0 ? 0 : ring * 1.6 * index;
      positions.set(root, { x: round(offsetX - byId.get(root).w / 2), y: round(-byId.get(root).h / 2) });
      placed.add(root);
      const total = Math.max(1, size.get(root) ?? 1) - 1;
      const spreadChildren = (id, startAngle, endAngle, depth) => {
        const kids = (children.get(id) ?? []).filter(child => !placed.has(child));
        if (!kids.length) return;
        const radius = ring * depth;
        let cursor = startAngle;
        for (const kid of kids) {
          const share = total ? ((size.get(kid) ?? 1) / total) * (endAngle - startAngle) : (endAngle - startAngle) / kids.length;
          const angle = cursor + share / 2;
          positions.set(kid, {
            x: round(offsetX + Math.cos(angle) * radius * 1.7 - byId.get(kid).w / 2),
            y: round(Math.sin(angle) * radius - byId.get(kid).h / 2),
          });
          placed.add(kid);
          spreadChildren(kid, cursor, cursor + share, depth + 1);
          cursor += share;
        }
      };
      spreadChildren(root, -Math.PI / 2, Math.PI * 1.5, 1);
    }
    for (const node of nodes) if (!placed.has(node.id)) positions.set(node.id, { x: node.x, y: node.y });
    return positions;
  }

  /** Longest-path layering, barycenter ordering, then a compact column/row placement. */
  function layeredLayout(nodes, edges, options) {
    const { gapX, gapY } = options;
    const byId = new Map(nodes.map(node => [node.id, node]));
    const parents = new Map(nodes.map(node => [node.id, []]));
    const children = new Map(nodes.map(node => [node.id, []]));
    for (const edge of edges) {
      if (edge.from === edge.to || !byId.has(edge.from) || !byId.has(edge.to)) continue;
      children.get(edge.from).push(edge.to);
      parents.get(edge.to).push(edge.from);
    }
    const layer = new Map();
    const resolve = (id, trail) => {
      if (layer.has(id)) return layer.get(id);
      if (trail.has(id)) return 0; // A cycle contributes no further depth.
      trail.add(id);
      const incoming = parents.get(id) ?? [];
      const value = incoming.length ? Math.max(...incoming.map(parent => resolve(parent, trail))) + 1 : 0;
      trail.delete(id);
      layer.set(id, value);
      return value;
    };
    for (const node of nodes) resolve(node.id, new Set());
    const layers = [];
    for (const node of nodes) {
      const index = layer.get(node.id);
      if (!layers[index]) layers[index] = [];
      layers[index].push(node.id);
    }
    // Order each layer near its parents; a couple of sweeps is enough. Ties break on the
    // node's position in the board, never on its current coordinates: arranging an already
    // arranged board must not swap two siblings back and forth.
    const stable = new Map(nodes.map((node, index) => [node.id, index]));
    for (let sweep = 0; sweep < 2; sweep++) {
      for (let index = 1; index < layers.length; index++) {
        const order = new Map(layers[index - 1].map((id, position) => [id, position]));
        layers[index] = [...(layers[index] ?? [])].sort((a, b) => {
          const centre = id => {
            const incoming = (parents.get(id) ?? []).map(parent => order.get(parent)).filter(value => value !== undefined);
            return incoming.length ? incoming.reduce((sum, value) => sum + value, 0) / incoming.length : Number.POSITIVE_INFINITY;
          };
          return (centre(a) - centre(b)) || (stable.get(a) - stable.get(b));
        });
      }
    }
    const columnWidth = layers.map(ids => Math.max(...ids.map(id => byId.get(id).w), 0));
    const columnX = [];
    let cursor = 0;
    for (const width of columnWidth) { columnX.push(cursor); cursor += width + gapX; }
    const rowHeight = Math.max(...nodes.map(node => node.h)) + gapY;
    const bounds = boundsOf(nodes);
    const originX = bounds ? bounds.x : 0, originY = bounds ? bounds.y : 0;
    const positions = new Map();
    for (const [index, ids] of layers.entries()) for (const [row, id] of (ids ?? []).entries()) positions.set(id, { x: round(originX + columnX[index]), y: round(originY + row * rowHeight) });
    return positions;
  }

  const rotate = (point, node, direction) => {
    switch (direction) {
      case 'tb': return { x: point.x, y: point.y };
      case 'bt': return { x: -point.x - node.w, y: -point.y - node.h };
      case 'rl': return { x: -point.x - node.w, y: point.y };
      default: return point;
    }
  };

  /**
   * Deterministic placement for the whole board or a scope. Pins are applied last and win,
   * which is how "special positions" survive every automatic layout.
   */
  function layout(nodes, edges, options = {}) {
    if (nodes.length < 2) return nodes.map(node => ({ ...node }));
    const mode = MODES.includes(options.mode) ? options.mode : 'tree';
    const direction = DIRECTIONS.includes(options.direction) ? options.direction : 'lr';
    const gapX = Math.min(LIMITS.gapMax, Math.max(LIMITS.gapMin, Number(options.gapX) || 80));
    const gapY = Math.min(LIMITS.gapMax, Math.max(LIMITS.gapMin, Number(options.gapY) || 36));
    const scope = new Set(nodes.map(node => node.id));
    const local = edges.filter(edge => scope.has(edge.from) && scope.has(edge.to));
    const positions = mode === 'radial' ? radialLayout(nodes, local, { gapX, gapY, rootId: options.rootId })
      : mode === 'layered' ? layeredLayout(nodes, local, { gapX, gapY })
      : treeLayout(nodes, local, { gapX, gapY, rootId: options.rootId, flipRows: direction === 'bt' });
    const bounds = boundsOf(nodes);
    const originX = bounds ? bounds.x : 0, originY = bounds ? bounds.y : 0;
    // Rotate in local space, then anchor the result's own bounding box at (0,0). Without
    // this, re-applying a centred layout (radial) would shift the whole drawing every time.
    const spaced = nodes.map(node => {
      const placed = positions.get(node.id) ?? { x: node.x, y: node.y };
      return { node, point: { x: round(placed.x), y: round(placed.y) } };
    });
    const baseX = Math.min(...spaced.map(item => item.point.x)), baseY = Math.min(...spaced.map(item => item.point.y));
    const oriented = spaced.map(({ node, point }) => ({ node, point: mode === 'tree' ? rotate({ x: point.x - baseX, y: point.y - baseY }, node, direction) : { x: point.x - baseX, y: point.y - baseY } }));
    const minX = Math.min(...oriented.map(item => item.point.x)), minY = Math.min(...oriented.map(item => item.point.y));
    return oriented.map(({ node, point }) => ({ ...node, x: round(originX + point.x - minX), y: round(originY + point.y - minY) }));
  }

  // ── Source codec ──────────────────────────────────────────────────────────────

  const shortId = (value, index) => `n${index + 1}`;

  /**
   * Export a board as a readable content file plus a style sidecar. Auto-generated ids are
   * shortened so the file reads like outline text; an author-chosen id is kept as it is.
   * Coordinates are never written unless the node is pinned (or pinManual asks for it).
   */
  function toSource(board, options = {}) {
    const nodes = board.nodes ?? [], edges = board.edges ?? [];
    const mapping = new Map();
    const used = new Set(nodes.map(node => node.id));
    nodes.forEach((node, index) => {
      const generated = /^n-[0-9a-z]{4,}$/.test(node.id);
      let candidate = generated ? shortId(node.id, index) : node.id;
      while (used.has(candidate) && candidate !== node.id) candidate = `${candidate}_`;
      used.add(candidate);
      mapping.set(node.id, candidate);
    });
    const pins = { ...(board.style?.layout?.pins ?? {}) };
    if (options.pinManual) for (const node of nodes) if (!pins[node.id]) pins[node.id] = [node.x, node.y];
    const source = { schema: SOURCE_SCHEMA, title: String(board.title ?? '未命名画板').slice(0, LIMITS.title) };
    const style = board.style ? JSON.parse(JSON.stringify(board.style)) : {};
    const mode = options.mode ?? style.layout?.mode ?? 'tree';
    const direction = options.direction ?? style.layout?.direction ?? 'lr';
    const gapX = options.gapX ?? style.layout?.gapX ?? 80;
    const gapY = options.gapY ?? style.layout?.gapY ?? 36;
    if (mode !== 'tree' || direction !== 'lr') source.layout = `${mode}-${direction}`;
    if (board.links?.papers?.length) source.papers = [...board.links.papers];
    if (board.links?.projects?.length) source.projects = [...board.links.projects];
    source.nodes = nodes.map(node => {
      const entry = { id: mapping.get(node.id), kind: node.kind };
      if (node.text) entry.text = node.text;
      if (node.paper) {
        entry.paper = node.paper.id;
        if (node.paper.title && node.paper.title !== node.text) entry.paperTitle = node.paper.title;
        if (node.paper.year) entry.year = node.paper.year;
        if (node.paper.citekey) entry.citekey = node.paper.citekey;
      }
      if (node.origin === 'llm') entry.proposed = true;
      if (node.color) entry.color = node.color;
      if (pins[node.id]) entry.pin = [node.x, node.y];
      return entry;
    });
    source.edges = edges.map(edge => {
      const entry = { from: mapping.get(edge.from), to: mapping.get(edge.to) };
      if (edge.relation) entry.relation = edge.relation;
      if (edge.label) entry.label = edge.label;
      if (edge.kind && edge.kind !== 'arrow') entry.kind = edge.kind;
      if (edge.arrow && edge.arrow !== 'forward') entry.arrow = edge.arrow;
      if (edge.dashed) entry.dashed = true;
      if (edge.waypoints?.length) entry.waypoints = edge.waypoints.map(point => [round(point[0]), round(point[1])]);
      if (edge.origin === 'llm') entry.proposed = true;
      return entry;
    });
    const layoutBlock = { ...(style.layout ?? {}) };
    layoutBlock.pins = Object.fromEntries(Object.entries(pins).map(([id, point]) => [mapping.get(id) ?? id, point]));
    if (!Object.keys(layoutBlock.pins).length) delete layoutBlock.pins;
    style.layout = { mode, direction, gapX, gapY, ...layoutBlock };
    return { source, style: { schema: STYLE_SCHEMA, ...style }, mapping };
  }

  function validateSource(value) {
    closed(value, '画板源文件', ['schema', 'title', 'layout', 'nodes', 'edges', 'note', 'papers', 'projects']);
    if (value.schema !== undefined && value.schema !== SOURCE_SCHEMA) fail(`画板源文件版本不受支持（需要 ${SOURCE_SCHEMA}）。`);
    const source = { schema: SOURCE_SCHEMA, title: text(value.title, '标题', LIMITS.title)?.trim() || '未命名画板' };
    if (value.layout !== undefined) {
      if (typeof value.layout !== 'string' || !value.layout.split('-').every(part => [...MODES, ...DIRECTIONS].includes(part))) fail('layout 需要形如 tree-lr、radial 或 layered-tb。');
      source.layout = value.layout;
    }
    // The board file also records where it sits: under papers and reading projects. The
    // links are associative only — the file itself stays one file.
    for (const [key, label, maximum] of [['papers', '论文', 50], ['projects', '项目', 20]]) {
      const list = value[key];
      if (list === undefined) continue;
      if (!Array.isArray(list) || list.length > maximum) fail(`${label}关联最多 ${maximum} 项。`);
      const seen = new Set();
      source[key] = list.map((entry, index) => {
        const id = identifier(entry, `第 ${index + 1} 个${label}标识`);
        if (seen.has(id)) fail(`${label}关联标识 ${id} 重复。`);
        seen.add(id);
        return id;
      });
      if (!source[key].length) delete source[key];
    }
    if (!Array.isArray(value.nodes) || !value.nodes.length || value.nodes.length > LIMITS.nodes) fail(`nodes 必须是 1–${LIMITS.nodes} 项。`);
    const ids = new Set();
    source.nodes = value.nodes.map((entry, index) => {
      closed(entry, `第 ${index + 1} 个节点`, ['id', 'kind', 'text', 'paper', 'paperTitle', 'year', 'citekey', 'proposed', 'color', 'pin']);
      const node = { id: identifier(entry.id, `第 ${index + 1} 个节点标识`), kind: entry.kind ?? 'concept' };
      if (!NODE_KINDS.includes(node.kind)) fail(`第 ${index + 1} 个节点类型不受支持。`);
      const body = text(entry.text, '节点文本', LIMITS.text);
      if (body) node.text = body;
      if (entry.paper !== undefined) {
        node.paper = identifier(entry.paper, `第 ${index + 1} 个节点的文献标识`);
        // Optional fields stay absent rather than becoming explicit undefined, so a
        // normalised file compares equal to the file it came from.
        const paperTitle = text(entry.paperTitle, '文献标题', 500);
        if (paperTitle) node.paperTitle = paperTitle;
        if (entry.year !== undefined) {
          if (!Number.isInteger(entry.year) || entry.year < 1 || entry.year > 9999) fail('文献年份无效。');
          node.year = entry.year;
        }
        const citekey = text(entry.citekey, '引用键', 200);
        if (citekey) node.citekey = citekey;
      }
      if (entry.proposed === true) node.proposed = true;
      const color = tint(entry.color, '节点颜色');
      if (color) node.color = color;
      if (entry.pin !== undefined) {
        if (!Array.isArray(entry.pin) || entry.pin.length !== 2) fail(`节点 ${node.id} 的 pin 必须是 [x,y]。`);
        node.pin = [coordinate(entry.pin[0], '固定位置横坐标'), coordinate(entry.pin[1], '固定位置纵坐标')];
      }
      if (node.paper) node.kind = 'paper';
      ids.add(node.id);
      return node;
    });
    if (ids.size !== source.nodes.length) fail('节点标识重复。');
    const edges = value.edges ?? [];
    if (!Array.isArray(edges) || edges.length > LIMITS.edges) fail(`edges 最多 ${LIMITS.edges} 条。`);
    source.edges = edges.map((entry, index) => {
      closed(entry, `第 ${index + 1} 条连线`, ['from', 'to', 'relation', 'label', 'kind', 'arrow', 'dashed', 'waypoints', 'proposed']);
      const edge = { from: identifier(entry.from, `第 ${index + 1} 条连线起点`), to: identifier(entry.to, `第 ${index + 1} 条连线终点`) };
      if (edge.from === edge.to) fail(`第 ${index + 1} 条连线不能连接同一个节点。`);
      if (!ids.has(edge.from) || !ids.has(edge.to)) fail(`第 ${index + 1} 条连线的端点不在本次画板中。`);
      if (entry.relation !== undefined) {
        if (!RELATIONS.includes(entry.relation)) fail(`第 ${index + 1} 条连线的关系词不受支持。`);
        edge.relation = entry.relation;
      }
      const label = text(entry.label, '连线标签', LIMITS.label);
      if (label) edge.label = label;
      if (entry.kind !== undefined) {
        if (!EDGE_KINDS.includes(entry.kind)) fail(`第 ${index + 1} 条连线类型不受支持。`);
        edge.kind = entry.kind;
      }
      if (entry.arrow !== undefined) {
        if (!ARROWS.includes(entry.arrow)) fail(`第 ${index + 1} 条连线的箭头样式不受支持。`);
        edge.arrow = entry.arrow;
      }
      if (entry.dashed === true) edge.dashed = true;
      if (entry.proposed === true) edge.proposed = true;
      if (entry.waypoints !== undefined) {
        if (!Array.isArray(entry.waypoints) || entry.waypoints.length > LIMITS.waypoints) fail(`第 ${index + 1} 条连线最多 ${LIMITS.waypoints} 个拐点。`);
        edge.waypoints = entry.waypoints.map((point, order) => {
          if (!Array.isArray(point) || point.length !== 2) fail(`第 ${index + 1} 条连线的第 ${order + 1} 个拐点必须是 [x,y]。`);
          return [coordinate(point[0], '拐点横坐标'), coordinate(point[1], '拐点纵坐标')];
        });
      }
      return edge;
    });
    return source;
  }

  function validateStyle(value) {
    if (value === undefined || value === null) return {};
    closed(value, '样式文件', ['schema', 'theme', 'node', 'edge', 'layout']);
    if (value.schema !== undefined && value.schema !== STYLE_SCHEMA) fail(`样式文件版本不受支持（需要 ${STYLE_SCHEMA}）。`);
    const style = {};
    if (value.theme !== undefined) {
      closed(value.theme, '主题', ['background', 'ink', 'muted', 'edge']);
      style.theme = {};
      for (const key of ['background', 'ink', 'muted', 'edge']) {
        const color = tint(value.theme[key], `主题颜色 ${key}`);
        if (color) style.theme[key] = color;
      }
    }
    const styleEntry = (entry, name, keys) => {
      closed(entry, name, keys);
      const out = {};
      for (const key of ['fill', 'stroke']) {
        if (entry[key] === undefined) continue;
        const color = tint(entry[key], `${name}的${key === 'fill' ? '填充色' : '描边色'}`);
        if (color) out[key] = color;
      }
      const labels = { w: '宽度', h: '高度', fontSize: '字号', width: '线宽' };
      for (const [key, low, high] of [['w', 40, 2000], ['h', 32, 2000], ['fontSize', 9, 32], ['width', 0.5, 8]]) {
        if (entry[key] === undefined) continue;
        if (!Number.isFinite(entry[key]) || entry[key] < low || entry[key] > high) fail(`${name}的${labels[key]}必须在 ${low}–${high} 之间。`);
        out[key] = Math.round(entry[key] * 10) / 10;
      }
      if (entry.arrow !== undefined) {
        if (!ARROWS.includes(entry.arrow)) fail(`${name}的箭头样式不受支持。`);
        out.arrow = entry.arrow;
      }
      if (entry.dashed === true) out.dashed = true;
      return out;
    };
    if (value.node !== undefined) {
      closed(value.node, '节点样式', ['byKind', 'byId']);
      style.node = {};
      if (value.node.byKind !== undefined) {
        closed(value.node.byKind, '按类型样式', NODE_KINDS);
        style.node.byKind = {};
        for (const kind of NODE_KINDS) if (value.node.byKind[kind] !== undefined) style.node.byKind[kind] = styleEntry(value.node.byKind[kind], `类型 ${kind}`, ['fill', 'stroke', 'w', 'h', 'fontSize']);
      }
      if (value.node.byId !== undefined) {
        if (!isObject(value.node.byId)) fail('按节点样式必须是对象。');
        style.node.byId = {};
        for (const [id, entry] of Object.entries(value.node.byId)) style.node.byId[identifier(id, '节点标识')] = styleEntry(entry, `节点 ${id}`, ['fill', 'stroke', 'w', 'h', 'fontSize']);
      }
    }
    if (value.edge !== undefined) {
      closed(value.edge, '连线样式', ['byDefault', 'byRelation']);
      style.edge = {};
      if (value.edge.byDefault !== undefined) style.edge.byDefault = styleEntry(value.edge.byDefault, '默认连线', ['stroke', 'width', 'arrow', 'dashed']);
      if (value.edge.byRelation !== undefined) {
        closed(value.edge.byRelation, '按关系样式', RELATIONS);
        style.edge.byRelation = {};
        for (const relation of RELATIONS) if (value.edge.byRelation[relation] !== undefined) style.edge.byRelation[relation] = styleEntry(value.edge.byRelation[relation], `关系 ${relation}`, ['stroke', 'width', 'arrow', 'dashed']);
      }
    }
    if (value.layout !== undefined) {
      closed(value.layout, '排版设置', ['mode', 'direction', 'gapX', 'gapY', 'pins']);
      const layout = {};
      if (value.layout.mode !== undefined) {
        if (!MODES.includes(value.layout.mode)) fail('排版方式只能是 tree、radial 或 layered。');
        layout.mode = value.layout.mode;
      }
      if (value.layout.direction !== undefined) {
        if (!DIRECTIONS.includes(value.layout.direction)) fail('排版方向只能是 lr、tb、rl 或 bt。');
        layout.direction = value.layout.direction;
      }
      for (const key of ['gapX', 'gapY']) if (value.layout[key] !== undefined) layout[key] = amount(value.layout[key], key === 'gapX' ? '水平间距' : '垂直间距', LIMITS.gapMin, LIMITS.gapMax);
      if (value.layout.pins !== undefined) {
        if (!isObject(value.layout.pins)) fail('固定位置必须是对象。');
        layout.pins = {};
        for (const [id, point] of Object.entries(value.layout.pins)) {
          if (!Array.isArray(point) || point.length !== 2) fail(`节点 ${id} 的固定位置必须是 [x,y]。`);
          layout.pins[identifier(id, '固定位置节点标识')] = [coordinate(point[0], '固定位置横坐标'), coordinate(point[1], '固定位置纵坐标')];
        }
      }
      style.layout = layout;
    }
    return style;
  }

  /**
   * Build a canvas board from a content file plus its sidecar. Sizes come from the style,
   * positions from the layout, and pins win — so a hand-written file renders the same way
   * every time without carrying any pixel coordinates.
   */
  function fromSource(rawSource, rawStyle, options = {}) {
    const source = validateSource(rawSource);
    const style = validateStyle(rawStyle);
    const api = typeof window !== 'undefined' ? window.PaperBoard : undefined;
    const defaults = { text: { w: 220, h: 64 }, note: { w: 220, h: 140 }, concept: { w: 200, h: 100 }, paper: { w: 260, h: 120 }, rect: { w: 220, h: 140 }, ellipse: { w: 200, h: 120 }, diamond: { w: 200, h: 120 } };
    const sizeFor = kind => (api?.DEFAULT_SIZE ?? defaults)[kind] ?? defaults.text;
    // Source ids are already valid board identifiers, and keeping them verbatim is what
    // makes board → source → board stable instead of growing a prefix on every pass.
    const idFor = id => `${options.prefix ?? ''}${id}`.slice(0, 60);
    const layoutParts = (source.layout ?? 'tree-lr').split('-');
    const mode = style.layout?.mode ?? layoutParts[0] ?? 'tree';
    const direction = style.layout?.direction ?? layoutParts[1] ?? 'lr';
    const nodes = source.nodes.map(entry => {
      const kind = entry.paper ? 'paper' : entry.kind;
      const base = sizeFor(kind);
      const overrides = { ...(style.node?.byKind?.[kind] ?? {}), ...(style.node?.byId?.[entry.id] ?? {}) };
      const node = { id: idFor(entry.id), kind, x: 0, y: 0, w: overrides.w ?? base.w, h: overrides.h ?? base.h, text: entry.text ?? '', origin: entry.proposed ? 'llm' : 'user' };
      // Only reader-facing content and the per-node stroke live on the node; fills stay in
      // the style block, which is what the renderer reads anyway.
      if (entry.color) node.color = entry.color;
      if (entry.paper) {
        node.paper = { id: entry.paper };
        if (entry.paperTitle) node.paper.title = entry.paperTitle;
        if (entry.year) node.paper.year = entry.year;
        if (entry.citekey) node.paper.citekey = entry.citekey;
        if (!node.text) node.text = entry.paperTitle ?? entry.paper;
      }
      return node;
    });
    const edges = source.edges.map((entry, index) => {
      const kind = entry.kind ?? 'arrow';
      const edge = { id: `${options.prefix ?? 's-'}e${index + 1}`.slice(0, 60), from: idFor(entry.from), to: idFor(entry.to), kind: EDGE_KINDS.includes(kind) ? kind : 'arrow', origin: entry.proposed ? 'llm' : 'user' };
      if (entry.relation) edge.relation = entry.relation;
      if (entry.label) edge.label = entry.label;
      if (entry.arrow) edge.arrow = entry.arrow;
      if (entry.dashed) edge.dashed = true;
      if (entry.waypoints) edge.waypoints = entry.waypoints.map(point => [...point]);
      return edge;
    });
    // Nodes with a pin keep that exact position; everything else is laid out.
    const pinned = new Set(Object.keys(style.layout?.pins ?? {}).map(idFor));
    const free = nodes.filter(node => !pinned.has(node.id));
    const placed = layout(free.length ? free : [], edges, { mode, direction, gapX: style.layout?.gapX, gapY: style.layout?.gapY });
    const positions = new Map(placed.map(node => [node.id, node]));
    const laid = nodes.map(node => positions.get(node.id) ?? node);
    const pins = style.layout?.pins ?? {};
    const links = {};
    if (source.papers?.length) links.papers = [...source.papers];
    if (source.projects?.length) links.projects = [...source.projects];
    return {
      board: {
        schema: 1,
        title: source.title,
        ...(Object.keys(links).length ? { links } : {}),
        origin: 'user',
        status: 'saved',
        nodes: laid.map(node => {
          const pin = pins[Object.keys(pins).find(id => idFor(id) === node.id)];
          return pin ? { ...node, x: coordinate(pin[0], '固定位置横坐标'), y: coordinate(pin[1], '固定位置纵坐标') } : node;
        }),
        edges,
        view: { x: 0, y: 0, zoom: 1 },
      },
      style,
      mapping: new Map(source.nodes.map(entry => [entry.id, idFor(entry.id)])),
      mode,
      direction,
    };
  }

  /** Presentation for one node/edge, resolved from the sidecar with sensible fallbacks. */
  function nodeStyle(style, node) {
    const merged = { ...(style?.node?.byKind?.[node.kind] ?? {}), ...(style?.node?.byId?.[node.id] ?? {}) };
    return { fill: merged.fill ?? node.fill, stroke: merged.stroke ?? node.color, w: merged.w, h: merged.h, fontSize: merged.fontSize };
  }

  function edgeStyle(style, edge) {
    const merged = { ...(style?.edge?.byDefault ?? {}), ...(edge.relation ? style?.edge?.byRelation?.[edge.relation] ?? {} : {}) };
    return {
      stroke: merged.stroke ?? edge.stroke,
      width: merged.width,
      arrow: merged.arrow ?? edge.arrow ?? 'forward',
      dashed: merged.dashed ?? edge.dashed === true,
      kind: edge.kind ?? 'arrow',
    };
  }

  window.PaperBoardSource = Object.freeze({
    SOURCE_SCHEMA, STYLE_SCHEMA, LIMITS, MODES, DIRECTIONS, NODE_KINDS, EDGE_KINDS, RELATIONS, ARROWS,
    anchorPoint, edgePoints, edgeRenderPoints, edgePath, edgeMidpoint, distanceToPoints, nearestLeg, dragWaypoint,
    layout, nodeStyle, edgeStyle, toSource, fromSource, validateSource, validateStyle,
  });
})();
