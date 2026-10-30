import graph from "./graph.js";

// One-hop dependencies only: hovering a neighbour must not trace the whole pipeline.
export function graphNeighborhood(g, target) {
  const seeds = new Set(target.nodes?.length ? target.nodes : target.node ? [target.node] : []),
    nodes = new Set(seeds),
    edges = new Set(target.edges || []),
    upstream = new Set(),
    downstream = new Set(),
    incoming = new Set(),
    outgoing = new Set();
  if (seeds.size)
    for (const edge of g.edges)
      if (seeds.has(graph.split(edge.from)[0]) || seeds.has(graph.split(edge.to)[0]))
        edges.add(edge.id);
  for (const edge of g.edges)
    if (edges.has(edge.id)) {
      const from = graph.split(edge.from)[0],
        to = graph.split(edge.to)[0];
      nodes.add(from);
      nodes.add(to);
      if (!seeds.size || seeds.has(to)) {
        if (!seeds.has(from)) upstream.add(from);
        incoming.add(edge.id);
      }
      if (!seeds.size || seeds.has(from)) {
        if (!seeds.has(to)) downstream.add(to);
        outgoing.add(edge.id);
      }
    }
  return { nodes, edges, upstream, downstream, incoming, outgoing };
}

export function wireGraphHover(view, g, signal, onChange = () => {}) {
  const items = [
    ...view.querySelectorAll(".node,.dependency-group,.edge-interactive,.edge-label,.wire-jump"),
  ].map((element) => ({
    element,
    node: element.dataset.nodeId,
    nodes: element.dataset.nodeMembers ? JSON.parse(element.dataset.nodeMembers) : [],
    edges: element.dataset.edgeMembers
      ? JSON.parse(element.dataset.edgeMembers)
      : element.dataset.overEdge
        ? [element.dataset.overEdge]
        : [],
  }));
  let hovered = null,
    focused = null,
    active = null;
  const marked = new Set(),
    flows = new Set();
  const clear = () => {
    for (const el of marked)
      el.classList.remove("hover-related", "hover-origin", "hover-upstream", "hover-downstream");
    marked.clear();
    for (const el of flows) el.remove();
    flows.clear();
  };
  const animate = (item, direction) => {
    const path =
      item.element.querySelector?.(".edge") ||
      (item.element.dataset.overEdge && item.element.querySelector?.("path:last-child"));
    if (!path) return;
    const flow = path.ownerDocument.createElementNS("http://www.w3.org/2000/svg", "path");
    for (const [key, value] of Object.entries({
      class: `hover-flow hover-flow-${direction}`,
      d: path.getAttribute("d"),
      fill: "none",
      "aria-hidden": "true",
      "pointer-events": "none",
      "vector-effect": "non-scaling-stroke",
    }))
      flow.setAttribute(key, value);
    item.element.append(flow);
    flows.add(flow);
  };
  const find = (element) => {
    const hit = element?.closest?.(".node,.dependency-group,.edge-interactive,.edge-label");
    return hit && view.contains(hit) ? hit : null;
  };
  const refresh = () => {
    const target =
      view.classList.contains("is-panning") || view.classList.contains("editor-dragging")
        ? null
        : hovered || (focused?.matches(":focus-visible") ? focused : null);
    if (target === active) return;
    clear();
    active = target;
    if (!target) {
      onChange(null);
      return;
    }
    const origin = {
        node: target.dataset.nodeId,
        nodes: target.dataset.nodeMembers ? JSON.parse(target.dataset.nodeMembers) : undefined,
        edges: target.dataset.edgeMembers ? JSON.parse(target.dataset.edgeMembers) : [],
      },
      related = graphNeighborhood(g, origin);
    for (const item of items)
      if (
        related.nodes.has(item.node) ||
        item.nodes.some((id) => related.nodes.has(id)) ||
        item.edges.some((id) => related.edges.has(id))
      ) {
        item.element.classList.add("hover-related");
        const up =
            related.upstream.has(item.node) ||
            item.nodes.some((id) => related.upstream.has(id)) ||
            item.edges.some((id) => related.incoming.has(id)),
          down =
            related.downstream.has(item.node) ||
            item.nodes.some((id) => related.downstream.has(id)) ||
            item.edges.some((id) => related.outgoing.has(id));
        if (up) item.element.classList.add("hover-upstream");
        if (down) item.element.classList.add("hover-downstream");
        if (item.edges.length && (up || down)) animate(item, down ? "downstream" : "upstream");
        marked.add(item.element);
      }
    target.classList.add("hover-origin");
    marked.add(target);
    onChange(related, origin);
  };
  for (const [type, property, from] of [
    ["pointerover", "hover", "target"],
    ["pointerout", "hover", "relatedTarget"],
    ["focusin", "focus", "target"],
    ["focusout", "focus", "relatedTarget"],
  ])
    view.addEventListener(
      type,
      (event) => {
        if (property === "hover") hovered = find(event[from]);
        else focused = find(event[from]);
        refresh();
      },
      { signal },
    );
  view.addEventListener(
    "pointerleave",
    () => {
      hovered = null;
      refresh();
    },
    { signal },
  );
  view.addEventListener("pointermove", refresh, { signal });
  view.addEventListener(
    "pointerdown",
    () => {
      hovered = null;
      focused = null;
      refresh();
    },
    { capture: true, signal },
  );
  const peers = new Set();
  const peer = (related) => {
    for (const element of peers) element.classList.remove("hover-peer");
    peers.clear();
    if (!related) return;
    for (const item of items)
      if (
        related.nodes.has(item.node) ||
        item.nodes.some((id) => related.nodes.has(id)) ||
        item.edges.some((id) => related.edges.has(id))
      ) {
        item.element.classList.add("hover-peer");
        peers.add(item.element);
      }
  };
  signal.addEventListener(
    "abort",
    () => {
      clear();
      peer(null);
      onChange(null);
    },
    { once: true },
  );
  return { peer };
}

// Functional references for hover only. These never enter G.match or its counts:
// for example validation selection and paper test-based selection remain different.
const nodeKeys = (node) =>
  new Set(
    [node, ...(node.members || [])].flatMap((n) =>
      [
        n.semantic_key && "semantic:" + n.semantic_key,
        n.logical?.key && "logical:" + n.logical.key,
        n.hover_role && "function:" + n.hover_role,
      ].filter(Boolean),
    ),
  );

export function comparisonPeers(current) {
  const index = {
    a: { nodes: new Map(), edges: new Map() },
    b: { nodes: new Map(), edges: new Map() },
  };
  const add = (type, a, b) => {
    for (const [lane, from, to] of [
      ["a", a, b],
      ["b", b, a],
    ]) {
      if (!index[lane][type].has(from)) index[lane][type].set(from, new Set());
      index[lane][type].get(from).add(to);
    }
  };
  for (const pair of current.r.pairs) add("nodes", pair.a, pair.b);
  for (const pair of current.r.edgePairs) add("edges", pair.a, pair.b);
  const keys = new Map([...current.a.nodes, ...current.b.nodes].map((n) => [n, nodeKeys(n)]));
  for (const a of current.a.nodes)
    for (const b of current.b.nodes)
      if (a.stage === b.stage && [...keys.get(a)].some((key) => keys.get(b).has(key)))
        add("nodes", a.id, b.id);
  const edgeKind = (e, g) => {
    if (e.kind.includes("target") || e.kind === "reference_test_selection") return e.kind;
    const role = (endpoint) => g.nodes.find((n) => n.id === graph.split(endpoint)[0])?.hover_role;
    const a = role(e.from),
      b = role(e.to);
    if (a === "task_fit" && b === "parameter_selection") return "fitted_parameters";
    if (a === "parameter_selection" && b === "model_forward") return "selected_parameters";
    if (a === "model_forward" && b === "prediction") return "prediction_output";
    return e.kind;
  };
  for (const a of current.a.edges)
    for (const b of current.b.edges)
      if (
        index.a.nodes.get(graph.split(a.from)[0])?.has(graph.split(b.from)[0]) &&
        index.a.nodes.get(graph.split(a.to)[0])?.has(graph.split(b.to)[0]) &&
        edgeKind(a, current.a) === edgeKind(b, current.b)
      )
        add("edges", a.id, b.id);
  return (lane, related) => {
    const target = lane === "a" ? current.b : current.a,
      nodes = new Set(),
      edges = new Set();
    for (const type of ["nodes", "edges"])
      for (const id of related[type])
        for (const peer of index[lane][type].get(id) || [])
          (type === "nodes" ? nodes : edges).add(peer);
    for (const edge of target.edges)
      if (edges.has(edge.id)) {
        nodes.add(graph.split(edge.from)[0]);
        nodes.add(graph.split(edge.to)[0]);
      }
    return { nodes, edges };
  };
}

export function wireComparisonHover(views, current, mode, signal) {
  const project = comparisonPeers(current),
    apis = new Map();
  let owner = null;
  for (const view of views) {
    const lane = view.dataset.lane,
      g = current[lane] || current.merged;
    apis.set(
      view,
      wireGraphHover(view, g, signal, (related, origin) => {
        if (!related) {
          if (owner === view) {
            for (const api of apis.values()) api.peer(null);
            owner = null;
          }
          return;
        }
        owner = view;
        for (const api of apis.values()) api.peer(null);
        if (mode === "parallel") {
          const other = views.find((v) => v.dataset.lane === (lane === "a" ? "b" : "a"));
          if (other) apis.get(other).peer(project(lane, related));
        } else if (mode === "merged") {
          const originNodes = g.nodes.filter(
              (n) => n.id === origin.node || origin.nodes?.includes(n.id),
            ),
            originEdges = g.edges.filter((e) => origin.edges.includes(e.id)),
            lanes = new Set(
              [...originNodes, ...originEdges].flatMap((x) => Object.keys(x.source_ids || {})),
            ),
            peers = { nodes: new Set(), edges: new Set() };
          for (const source of lanes) {
            const opposite = source === "a" ? "b" : "a";
            const sourceSet = Object.fromEntries(
              ["nodes", "edges"].map((type) => [
                type,
                new Set(
                  g[type]
                    .filter((x) => related[type].has(x.id))
                    .map((x) => x.source_ids?.[source])
                    .filter(Boolean),
                ),
              ]),
            );
            const projected = project(source, sourceSet);
            for (const type of ["nodes", "edges"])
              for (const x of g[type])
                if (projected[type].has(x.source_ids?.[opposite])) peers[type].add(x.id);
          }
          apis.get(view).peer(peers);
        }
      }),
    );
  }
}
