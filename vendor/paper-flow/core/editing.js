import { connectChildren } from "./grouping.js";
import { boundaryPoint, faceRange } from "./nodeKinds.js";

const copy = (v) => JSON.parse(JSON.stringify(v));
export const emptyDraft = () => ({ nodes: {}, edges: {}, relations: [] });
export function reflowDraft(draft) {
  return {
    ...copy(draft),
    nodes: Object.fromEntries(Object.entries(draft.nodes).filter(([, n]) => n.fixed)),
  };
}
export function createDraftHistory() {
  let value = emptyDraft(),
    past = [],
    future = [];
  return {
    get value() {
      return copy(value);
    },
    get canUndo() {
      return past.length > 0;
    },
    get canRedo() {
      return future.length > 0;
    },
    commit(next) {
      if (JSON.stringify(next) === JSON.stringify(value)) return;
      past.push(value);
      if (past.length > 50) past.shift();
      value = copy(next);
      future = [];
    },
    undo() {
      if (past.length) {
        future.push(value);
        value = past.pop();
      }
    },
    redo() {
      if (future.length) {
        past.push(value);
        value = future.pop();
      }
    },
  };
}
export const hasDraft = (d) =>
  !!d &&
  (Object.keys(d.nodes || {}).length || Object.keys(d.edges || {}).length || d.relations?.length);
const sides = new Set(["top", "right", "bottom", "left"]);
export function anchorPoint(node, anchor) {
  if (
    !sides.has(anchor.side) ||
    !Number.isFinite(anchor.offset) ||
    anchor.offset < 0 ||
    anchor.offset > 1
  )
    throw Error("连接点需指定边界及0–100%的位置");
  const vertical = anchor.side === "top" || anchor.side === "bottom",
    axis = vertical ? "x" : "y",
    size = vertical ? node.width : node.height,
    // Keep attachments away from a sloping/rounded corner.
    offset = Math.max(18 / size, Math.min(1 - 18 / size, anchor.offset));
  const point = boundaryPoint(node, anchor.side, node[axis] + (offset - 0.5) * size);
  return { x: Math.round(point.x * 1000) / 1000, y: Math.round(point.y * 1000) / 1000 };
}
export function describeAnchor(node, point, side) {
  const vertical = side === "top" || side === "bottom",
    axis = vertical ? "x" : "y",
    size = vertical ? node.width : node.height;
  return {
    side,
    offset: Math.max(0, Math.min(1, (point[axis] - node[axis]) / size + 0.5)),
    fixed: true,
  };
}
export const connectionPoint = (edge, end) =>
  edge.group_portals?.[end] || (end === "start" ? edge.points[0] : edge.points.at(-1));
export function connectionPath(edge) {
  const first = edge.group_portals?.start
      ? edge.points.findIndex((p) => same(p, edge.group_portals.start))
      : 0,
    last = edge.group_portals?.end
      ? edge.points.findLastIndex((p) => same(p, edge.group_portals.end))
      : edge.points.length - 1;
  return edge.points.slice(first, last + 1).map((p) => ({ ...p }));
}
export function bendPatch(edge, index, pointer) {
  const route = connectionPath(edge),
    i = Number(index),
    a = route[i - 1],
    p = route[i],
    b = route[i + 1];
  if (!a || !b) throw Error("只能拖动路径内部的转折点");
  const incomingVertical = Math.abs(a.x - p.x) < 0.001,
    outgoingVertical = Math.abs(b.x - p.x) < 0.001;
  const q = { ...pointer };
  if (i === 1) q[incomingVertical ? "x" : "y"] = a[incomingVertical ? "x" : "y"];
  if (i === route.length - 2) q[outgoingVertical ? "x" : "y"] = b[outgoingVertical ? "x" : "y"];
  if (i > 1) a[incomingVertical ? "x" : "y"] = q[incomingVertical ? "x" : "y"];
  if (i < route.length - 2) b[outgoingVertical ? "x" : "y"] = q[outgoingVertical ? "x" : "y"];
  route[i] = q;
  return {
    edges: {
      [edge.id]: {
        route,
        start: describeAnchor(edge.from, connectionPoint(edge, "start"), edge.sides.start),
        end: describeAnchor(edge.to, connectionPoint(edge, "end"), edge.sides.end),
      },
    },
  };
}
export function segmentPatch(edge, index, pointer) {
  const route = connectionPath(edge),
    i = Number(index),
    a = route[i],
    b = route[i + 1];
  if (!a || !b) throw Error("未找到要移动的线段");
  const vertical = Math.abs(a.x - b.x) < 0.001,
    axis = vertical ? "x" : "y";
  if (i > 0 && i < route.length - 2) {
    a[axis] = pointer[axis];
    b[axis] = pointer[axis];
  } else {
    const p = { x: a.x + (b.x - a.x) * 0.3, y: a.y + (b.y - a.y) * 0.3 },
      q = { x: a.x + (b.x - a.x) * 0.7, y: a.y + (b.y - a.y) * 0.7 };
    route.splice(i + 1, 0, p, { ...p, [axis]: pointer[axis] }, { ...q, [axis]: pointer[axis] }, q);
  }
  return {
    edges: {
      [edge.id]: {
        route,
        start: describeAnchor(edge.from, connectionPoint(edge, "start"), edge.sides.start),
        end: describeAnchor(edge.to, connectionPoint(edge, "end"), edge.sides.end),
      },
    },
  };
}
export function alignmentPatch(nodes, mode) {
  if (nodes.length < 2) throw Error("请先选择至少两个节点");
  const axis = ["left", "center", "right"].includes(mode) ? "x" : "y",
    size = axis === "x" ? "width" : "height",
    lo = Math.min(...nodes.map((n) => n[axis] - n[size] / 2)),
    hi = Math.max(...nodes.map((n) => n[axis] + n[size] / 2));
  if (!["left", "center", "right", "top", "middle", "bottom"].includes(mode))
    throw Error("未知对齐方式");
  return {
    nodes: Object.fromEntries(
      nodes.map((n) => [
        n.id,
        {
          x: n.x,
          y: n.y,
          fixed: !!n.draft_fixed,
          [axis]: ["left", "top"].includes(mode)
            ? lo + n[size] / 2
            : ["right", "bottom"].includes(mode)
              ? hi - n[size] / 2
              : (lo + hi) / 2,
        },
      ]),
    ),
  };
}
export function nodesInRect(nodes, a, b) {
  const left = Math.min(a.x, b.x),
    right = Math.max(a.x, b.x),
    top = Math.min(a.y, b.y),
    bottom = Math.max(a.y, b.y);
  return nodes
    .filter(
      (n) =>
        n.x - n.width / 2 >= left &&
        n.x + n.width / 2 <= right &&
        n.y - n.height / 2 >= top &&
        n.y + n.height / 2 <= bottom,
    )
    .map((n) => n.id);
}
// Project a pointer onto the nearest real face, including sloping data cards.
// The stored anchor uses the same side/ratio contract as the precision panel.
export function projectAnchor(node, pointer) {
  let best;
  for (const side of sides) {
    const [lo, hi] = faceRange(node, side),
      a = boundaryPoint(node, side, lo),
      b = boundaryPoint(node, side, hi),
      dx = b.x - a.x,
      dy = b.y - a.y,
      t = Math.max(
        0,
        Math.min(1, ((pointer.x - a.x) * dx + (pointer.y - a.y) * dy) / (dx * dx + dy * dy || 1)),
      ),
      point = { x: a.x + dx * t, y: a.y + dy * t },
      distance = Math.hypot(pointer.x - point.x, pointer.y - point.y);
    if (!best || distance < best.distance)
      best = { distance, anchor: describeAnchor(node, point, side) };
  }
  return best.anchor;
}
export function mergeEdit(draft, patch) {
  for (const [id, position] of Object.entries(patch.nodes || {}))
    draft.nodes[id] = { ...draft.nodes[id], ...position };
  for (const [id, style] of Object.entries(patch.edges || {}))
    draft.edges[id] = { ...draft.edges[id], ...style };
}
// Preview the already displayed layout directly: no Dagre pass, SVG generation,
// cache entry or history commit per pointer event. Release still validates the
// complete draft through the ordinary renderer.
export function previewEdit(layout, patch, router) {
  const draft = emptyDraft();
  for (const edge of layout.edges)
    if (edge.manual_route || (edge.manual_style && edge.manual_style !== "auto"))
      draft.edges[edge.id] = {
        line: edge.manual_style,
        ...(edge.manual_route ? { route: edge.manual_route } : {}),
      };
  mergeEdit(draft, patch);
  return applyDraft(copy(layout), draft, router);
}
const same = (a, b) => Math.abs(a.x - b.x) < 0.01 && Math.abs(a.y - b.y) < 0.01;
// The draft is applied AFTER scientific matching and automatic layout. Source
// nodes/ports/edges stay immutable, including when a presentation arrow cycles.
export function applyDraft(layout, draft, router) {
  if (!hasDraft(draft)) return layout;
  const old = new Map(layout.nodes.map((n) => [n.id, { ...n }])),
    by = new Map(layout.nodes.map((n) => [n.id, n])),
    moved = new Set();
  for (const [id, position] of Object.entries(draft.nodes || {})) {
    const node = by.get(id);
    if (!node) throw Error("未找到要移动的可见节点：" + id);
    if (
      ![position.x, position.y].every(Number.isFinite) ||
      position.x < node.width / 2 + 40 ||
      position.y < node.height / 2 + 40 ||
      position.x > 50000 ||
      position.y > 50000
    )
      throw Error("节点位置需在画布内，并为边界连接点留出空间");
    node.x = Math.round(position.x * 1000) / 1000;
    node.y = Math.round(position.y * 1000) / 1000;
    node.draft_fixed = !!position.fixed;
    moved.add(id);
  }
  for (const id of moved) {
    const n = by.get(id);
    if (
      layout.nodes.some(
        (p) =>
          p.id !== id &&
          Math.abs(p.x - n.x) < (p.width + n.width) / 2 + 12 &&
          Math.abs(p.y - n.y) < (p.height + n.height) / 2 + 12,
      )
    )
      throw Error("位置与其他节点重叠，请移到空白处");
  }
  // Reopen outer group portals before moving/rerouting total boxes, then let
  // the existing group router reconnect the actual inner children.
  for (const r of layout.edges) {
    if (r.group_portals) {
      const first = r.group_portals.start
          ? r.points.findIndex((p) => same(p, r.group_portals.start))
          : 0,
        last = r.group_portals.end
          ? r.points.findLastIndex((p) => same(p, r.group_portals.end))
          : r.points.length - 1;
      r.points = r.points.slice(first, last + 1);
      delete r.group_portals;
    }
  }
  delete layout.group_branches;
  for (const r of layout.edges) {
    r.from = by.get(r.from.id);
    r.to = by.get(r.to.id);
  }
  layout.width = Math.max(layout.width, ...layout.nodes.map((n) => n.x + n.width / 2 + 80));
  layout.height = Math.max(layout.height, ...layout.nodes.map((n) => n.y + n.height / 2 + 80));
  const used = new Set(layout.edges.map((e) => e.id));
  for (const relation of draft.relations || []) {
    const from = by.get(relation.from),
      to = by.get(relation.to);
    if (!from || !to || from === to || used.has(relation.id))
      throw Error("临时关系需连接两个不同的可见节点，且ID不能重复");
    used.add(relation.id);
    const edge = {
      id: relation.id,
      from: from.id + ":draft",
      to: to.id + ":draft",
      kind: "draft",
      semantic: "presentation_draft",
      label: "临时关系 · " + String(relation.label || "自定义").slice(0, 160),
      draft: true,
    };
    const horizontal = Math.abs(to.x - from.x) > Math.abs(to.y - from.y),
      start = horizontal ? (to.x > from.x ? "right" : "left") : to.y > from.y ? "bottom" : "top",
      end = { right: "left", left: "right", bottom: "top", top: "bottom" }[start];
    layout.edges.push({
      id: edge.id,
      edge,
      from,
      to,
      sides: { start, end },
      points: [
        anchorPoint(from, { side: start, offset: 0.5 }),
        anchorPoint(to, { side: end, offset: 0.5 }),
      ],
      draft_relation: true,
    });
  }
  const crossesMoved = (r) =>
    [...moved].some((id) => {
      const n = by.get(id);
      return (
        id !== r.from.id &&
        id !== r.to.id &&
        router.segments(r.points).some((s) =>
          router.hit(s.a, s.b, {
            x: n.x - n.width / 2 - 18,
            y: n.y - n.height / 2 - 18,
            width: n.width + 36,
            height: n.height + 36,
          }),
        )
      );
    });
  for (const r of layout.edges) {
    const style = draft.edges?.[r.id] || {},
      anchors = {};
    for (const [end, node] of [
      ["start", r.from],
      ["end", r.to],
    ]) {
      const point = end === "start" ? r.points[0] : r.points.at(-1),
        preferred = style[end];
      anchors[end] = preferred?.fixed
        ? preferred
        : describeAnchor(old.get(node.id) || node, point, r.sides[end]);
    }
    if (
      moved.has(r.from.id) ||
      moved.has(r.to.id) ||
      style.start?.fixed ||
      style.end?.fixed ||
      style.route ||
      r.draft_relation ||
      crossesMoved(r)
    ) {
      r.start = anchorPoint(r.from, anchors.start);
      r.end = anchorPoint(r.to, anchors.end);
      r.sides = { start: anchors.start.side, end: anchors.end.side };
      const reserved = layout.edges
        .filter((e) => e !== r && !e.draft_relation)
        .flatMap((e) => router.segments(e.points));
      r.points = style.route
        ? router.manualRoute(r, layout, style.route)
        : router.anchoredRoute(r, layout, reserved);
      r.axis = "mixed";
    }
    r.manual_route = style.route || null;
    r.locked_ends = { start: !!style.start?.fixed, end: !!style.end?.fixed };
    if (style.line && !["auto", "solid", "dashed", "dotted"].includes(style.line))
      throw Error("未知线型");
    r.manual_style = style.line || (r.draft_relation ? "dashed" : "auto");
  }
  router.simplifyDraft(layout);
  connectChildren(layout, router);
  for (const branch of layout.group_branches || []) {
    const owner = layout.edges.find((e) => branch.id.startsWith(e.id + "__"));
    if (owner) branch.manual_style = owner.manual_style;
  }
  layout.draft = {
    nodes: Object.keys(draft.nodes || {}).length,
    relations: (draft.relations || []).length,
    edges: Object.keys(draft.edges || {}).length,
  };
  layout.routing = {
    ...layout.routing,
    ...router.analyze(layout.edges),
    ...(layout.flow_tree
      ? {
          fan_balance: {
            soft: true,
            manual: true,
            reason: "手动位置优先，仅报告当前重心偏差",
            parents: router.fanCentroids(layout),
          },
        }
      : {}),
    presentation_draft: true,
    automatic_baseline_optimizer: layout.routing.quality_optimizer,
    node_alignments: [],
    quality_optimizer: { changes: [], remaining: [], manual_constraints: true },
  };
  return layout;
}
