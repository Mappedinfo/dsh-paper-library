import dagre from "./dagre.min.js";
import { nodeKind } from "./nodeKinds.js";
import { connectChildren } from "./grouping.js";
// Data lineage is a presentation of the original DAG, never a replacement for
// its matching, node IDs, declared relations or exported JSON evidence.
const id = (endpoint) => endpoint.split(":")[0];
const members = (n) => n.presentation_members || n.members || [n];
export function trunkRole(n) {
  const parts = n.presentation_members || n.members;
  if (parts?.length) {
    const roles = parts.map(trunkRole);
    return {
      branch: roles.every((p) => p.branch === roles[0].branch)
        ? roles[0].branch
        : n.default_branch || "default",
      control: roles.every((p) => p.control),
      technology: true,
      label: n.label,
    };
  }
  return {
    branch: n.presentation_branch || "default",
    control: !!n.trunk_control,
    technology: n.type === "method",
    label: n.trunk_output || n.label,
  };
}

// Keep one visible box per real step. An operation's documented output belongs
// in that step's details, not in an automatically invented second data node.
export function trunkPresentation(graph, classifier = trunkRole) {
  const roles = new Map(graph.nodes.map((n) => [n.id, classifier(n)]));
  return {
    ...graph,
    nodes: graph.nodes.map((n) => ({
      ...n,
      trunk_role: roles.get(n.id).control
        ? "control"
        : ["data", "representation", "output"].includes(nodeKind(n))
          ? "artifact"
          : "technology",
      trunk_branch: roles.get(n.id).branch,
    })),
    edges: graph.edges.map((e) => ({
      ...e,
      presentation_edges: e.presentation_edges || [e],
      trunk_relation:
        e.trunk_relation ||
        (roles.get(id(e.from)).control ||
        roles.get(id(e.to)).control
          ? "secondary"
          : "lineage"),
    })),
  };
}

export function layoutTrunks(source, measure, router, profile = {}) {
  const graph = trunkPresentation(source, profile.trunkRole),
    dag = new dagre.graphlib.Graph({ multigraph: true });
  dag.setGraph({
    rankdir: "TB",
    nodesep: 84,
    ranksep: 100,
    edgesep: 24,
    marginx: 48,
    marginy: 88,
    ranker: "network-simplex",
  });
  dag.setDefaultEdgeLabel(() => ({}));
  // Sources and siblings may share a level and spread sideways. Only actual
  // dependencies constrain ranks; stages and data families never add edges.
  const branchOrder = Object.fromEntries(
    (source.branch_order || profile.branches || []).map((id, i) => [id, i]),
  );
  for (const n of [...graph.nodes].sort(
    (a, b) =>
      (branchOrder[a.trunk_branch] || 0) - (branchOrder[b.trunk_branch] || 0) ||
      a.id.localeCompare(b.id),
  ))
    dag.setNode(n.id, { id: n.id, node: n, ...measure(n, source.trunk_detail) });
  for (const e of [...graph.edges].sort((a, b) => a.id.localeCompare(b.id)))
    dag.setEdge(
      id(e.from),
      id(e.to),
      {
        weight: e.trunk_relation === "lineage" ? 3 : 1,
        minlen: 1,
      },
      e.id,
    );
  dagre.layout(dag);
  const nodes = graph.nodes.map((n) => dag.node(n.id)),
    by = new Map(nodes.map((n) => [n.id, n])),
    gutter = 0; // Stage categories live in the directory, not a false horizontal axis.
  const compact = source.tree_levels === "compact";
  if (compact) {
    // Shortest dependency distance: a join goes just below its highest parent.
    // Other true dependencies may consequently return upward; never remove or
    // reverse a scientific edge to obtain a compact presentation.
    const incoming = new Map(nodes.map((n) => [n.id, 0])),
      children = new Map(nodes.map((n) => [n.id, []]));
    for (const edge of graph.edges) {
      incoming.set(id(edge.to), incoming.get(id(edge.to)) + 1);
      children.get(id(edge.from)).push(id(edge.to));
    }
    const queue = nodes
        .filter((n) => incoming.get(n.id) === 0)
        .map((n) => n.id)
        .sort(),
      ranks = new Map(queue.map((id) => [id, 0]));
    for (let i = 0; i < queue.length; i++)
      for (const child of children.get(queue[i]).sort()) {
        const next = ranks.get(queue[i]) + 1;
        if (!ranks.has(child) || next < ranks.get(child)) {
          ranks.set(child, next);
          queue.push(child);
        }
      }
    if (ranks.size !== nodes.length) throw Error("紧凑层级无法覆盖全部节点，请检查原图的依赖");
    const rows = new Map();
    for (const n of nodes) {
      n.tree_rank = ranks.get(n.id);
      if (!rows.has(n.tree_rank)) rows.set(n.tree_rank, []);
      rows.get(n.tree_rank).push(n);
    }
    let top = 88;
    for (const [, row] of [...rows].sort((a, b) => a[0] - b[0])) {
      const height = Math.max(...row.map((n) => n.height));
      row.sort((a, b) => a.x - b.x || a.id.localeCompare(b.id));
      const wanted = (row[0].x - row[0].width / 2 + row.at(-1).x + row.at(-1).width / 2) / 2;
      let left = 48;
      for (const n of row) {
        n.x = Math.max(n.x, left + n.width / 2);
        left = n.x + n.width / 2 + 84;
        n.y = top + height / 2;
      }
      const middle = (row[0].x - row[0].width / 2 + row.at(-1).x + row.at(-1).width / 2) / 2,
        shift = Math.min(middle - wanted, row[0].x - row[0].width / 2 - 48);
      for (const n of row) n.x -= shift;
      top += height + 100;
    }
  }
  const layout = {
    width: Math.max(1240, ...nodes.map((n) => n.x + n.width / 2 + 48)),
    height: Math.max(...nodes.map((n) => n.y + n.height / 2)) + 148,
    nodes,
    edges: [],
    stages: [],
    trunks: [],
    data_trunks: true,
    flow_tree: true,
    tree_levels: compact ? "compact" : "expanded",
    gutter,
  };
  // Use the same obstacle, terminal, rip-up, joint-direct and quality optimizer
  // as the other layouts. No node-specific routes or tree-only bypass.
  layout.edges = graph.edges.map((edge) => ({
    id: edge.id,
    edge,
    from: by.get(id(edge.from)),
    to: by.get(id(edge.to)),
  }));
  router.route(layout, graph);
  layout.routing.core_algorithm = layout.routing.algorithm;
  layout.routing.algorithm = "data-tree-top-down";
  layout.stages = (source.stages || []).map((s, index) => {
    const ns = nodes.filter((o) => o.node.stage === s.id);
    return {
      ...s,
      index,
      top: ns.length ? Math.min(...ns.map((o) => o.y - o.height / 2)) : 88,
      bottom: ns.length ? Math.max(...ns.map((o) => o.y + o.height / 2)) : 88,
      empty: !ns.length,
    };
  });
  // Optimize outer routes before opening portals to real inner child nodes.
  connectChildren(layout, router);
  return layout;
}

// Compress only paths between retained data landmarks. Original dependencies
// remain attached to every summary edge, including through hidden techniques.
export function overviewTrunks(graph, selector = (n) => n.overview_landmark !== false) {
  const keep = new Set(graph.nodes.filter(selector).map((n) => n.id));
  const incoming = new Map(graph.nodes.map((n) => [n.id, []]));
  for (const e of graph.edges) incoming.get(id(e.to)).push(e);
  const edges = [];
  function trace(endpoint, target, path, active) {
    const key = id(endpoint);
    if (keep.has(key)) {
      if (key !== target)
        edges.push({
          ...path.at(-1),
          id: "@overview_" + edges.length,
          from: endpoint,
          to: path[0].to,
          semantic: path.length > 1 ? "经中间处理步骤" : path[0].semantic,
          presentation_edges: path,
        });
      return;
    }
    if (active.has(key)) return;
    const seen = new Set(active);
    seen.add(key);
    for (const e of incoming.get(key) || []) trace(e.from, target, [...path, e], seen);
  }
  for (const n of graph.nodes.filter((n) => keep.has(n.id)))
    for (const e of incoming.get(n.id)) trace(e.from, n.id, [e], new Set());
  const unique = new Map();
  for (const e of edges) {
    const key = JSON.stringify([id(e.from), id(e.to), e.kind]);
    if (unique.has(key)) unique.get(key).presentation_edges.push(...e.presentation_edges);
    else unique.set(key, e);
  }
  return {
    ...graph,
    nodes: graph.nodes.filter((n) => keep.has(n.id)),
    edges: [...unique.values()],
    detail_grouping: false,
    presentation_layout: "trunks",
    trunk_overview: true,
    trunk_detail: "compact",
    swimlanes: undefined,
  };
}
