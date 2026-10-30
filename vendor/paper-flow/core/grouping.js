import { boundaryPoint } from "./nodeKinds.js";
const nodeId = (endpoint) => endpoint.split(":")[0];
const stable = (x) =>
  JSON.stringify(x, (_, v) =>
    v && !Array.isArray(v) && typeof v === "object"
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, v[k]]),
        )
      : v,
  );

// A presentation quotient only. Matching, details, JSON and hover keep the source graph.
export function groupPresentation(graph) {
  if (!graph.detail_grouping || graph.collapsed) return graph;
  const by = new Map(graph.nodes.map((n) => [n.id, n])),
    logicalEdges = [...graph.edges].sort((a, b) => a.id.localeCompare(b.id, "en")),
    owner = new Map(),
    groups = [];
  const incoming = (id) => logicalEdges.filter((e) => nodeId(e.to) === id);
  const outgoing = (id) => logicalEdges.filter((e) => nodeId(e.from) === id);
  const type = (e, direction) => {
    const endpoint = direction === "out" ? e.from : e.to;
    const [id, port] = endpoint.split(":");
    return by.get(id).ports[direction][port]?.type;
  };
  const canGroup = (members, id) => {
    if (members.length < 2 || members.some((n) => owner.has(n.id))) return false;
    if (members.some((n) => n.stage !== members[0].stage || n.status !== members[0].status))
      return false;
    // Contraction must not swallow a dependency or create a cycle between groups.
    const map = new Map(owner);
    members.forEach((n) => map.set(n.id, id));
    const edges = new Map([...by.keys()].map((n) => [map.get(n) || n, new Set()]));
    for (const e of logicalEdges) {
      const a = map.get(nodeId(e.from)) || nodeId(e.from),
        b = map.get(nodeId(e.to)) || nodeId(e.to);
      if (a === b) return false;
      edges.get(a).add(b);
    }
    const visiting = new Set(),
      done = new Set();
    const visit = (n) => {
      if (visiting.has(n)) return false;
      if (done.has(n)) return true;
      visiting.add(n);
      for (const next of edges.get(n)) if (!visit(next)) return false;
      visiting.delete(n);
      done.add(n);
      return true;
    };
    return [...edges.keys()].every(visit);
  };
  const add = (definition) => {
    const members = [...new Set(definition.members)].map((id) => by.get(id)).filter(Boolean);
    const id = "@detail_" + definition.id;
    if (by.has(id) || !canGroup(members, id)) return;
    members.forEach((n) => owner.set(n.id, id));
    groups.push({ ...definition, id, members });
  };
  for (const definition of graph.detail_groups || []) add(definition);
  const candidates = new Map();
  for (const n of [...graph.nodes].sort((a, b) => a.id.localeCompare(b.id, "en"))) {
    if (owner.has(n.id)) continue;
    const ins = incoming(n.id),
      outs = outgoing(n.id);
    if (!ins.length || !outs.length) continue;
    const signature = stable([
      n.stage,
      n.status,
      ins.map((e) => [e.from, e.kind, e.semantic, e.config, type(e, "in")]).sort(),
      outs.map((e) => [nodeId(e.to), e.kind, e.semantic, e.config, type(e, "out")]).sort(),
    ]);
    if (!candidates.has(signature)) candidates.set(signature, []);
    candidates.get(signature).push(n.id);
  }
  for (const members of candidates.values())
    if (members.length > 1)
      add({
        id: "parallel_" + [...members].sort().join("__"),
        label: "共同输入与输出",
        note: "并列步骤 · 子项独立保留",
        members,
      });
  if (!groups.length) return graph;
  const groupBy = new Map(groups.map((g) => [g.id, g]));
  const nodes = graph.nodes.filter((n) => !owner.has(n.id)).map((n) => ({ ...n }));
  for (const g of groups)
    nodes.push({
      id: g.id,
      label: g.label,
      state: "分项保留",
      semantic_key: g.id,
      op: "presentation_group",
      type: "method",
      stage: g.members[0].stage,
      status: g.members[0].status,
      ...(g.members.every((n) => n.role === g.members[0].role) ? { role: g.members[0].role } : {}),
      ports: { in: {}, out: {} },
      config: {},
      presentation_members: g.members,
      presentation_note: g.note || "共同连接到总框 · 专用连接到子框",
    });
  const viewBy = new Map(nodes.map((n) => [n.id, n])),
    buckets = new Map(),
    result = [];
  for (const e of logicalEdges) {
    const a = owner.get(nodeId(e.from)) || nodeId(e.from),
      b = owner.get(nodeId(e.to)) || nodeId(e.to);
    const key = stable([
      a,
      b,
      owner.has(nodeId(e.from)) ? null : e.from,
      owner.has(nodeId(e.to)) || owner.has(nodeId(e.from)) ? null : e.to,
      e.kind,
      e.status,
      type(e, "out"),
      type(e, "in"),
    ]);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(e);
  }
  const covers = (es, end, g) =>
    g && g.members.every((n) => es.some((e) => nodeId(e[end]) === n.id));
  const emit = (es, wholeFrom = false, wholeTo = false) => {
    const first = es[0],
      a = owner.get(nodeId(first.from)),
      b = owner.get(nodeId(first.to)),
      index = result.length;
    const fp = "view_out_" + index,
      tp = "view_in_" + index;
    if (a) viewBy.get(a).ports.out[fp] = { type: type(first, "out") };
    if (b) viewBy.get(b).ports.in[tp] = { type: type(first, "in") };
    result.push({
      ...first,
      from: a ? a + ":" + fp : first.from,
      to: b ? b + ":" + tp : first.to,
      presentation_edges: es,
      from_member: a && !wholeFrom ? nodeId(first.from) : undefined,
      to_member: b && !wholeTo ? nodeId(first.to) : undefined,
    });
  };
  for (const es of buckets.values()) {
    const ga = groupBy.get(owner.get(nodeId(es[0].from))),
      gb = groupBy.get(owner.get(nodeId(es[0].to)));
    const pairs = new Set(es.map((e) => stable([nodeId(e.from), nodeId(e.to)])));
    if (
      ga &&
      gb &&
      covers(es, "from", ga) &&
      covers(es, "to", gb) &&
      pairs.size === ga.members.length * gb.members.length
    ) {
      emit(es, true, true);
      continue;
    }
    let pending = [...es];
    for (const [direction, group, opposite] of [
      ["to", gb, "from"],
      ["from", ga, "to"],
    ]) {
      if (!group) continue;
      const subsets = new Map();
      for (const e of pending) {
        const key = opposite === "to" ? nodeId(e[opposite]) : e[opposite];
        if (!subsets.has(key)) subsets.set(key, []);
        subsets.get(key).push(e);
      }
      const used = new Set();
      for (const part of subsets.values())
        if (covers(part, direction, group)) {
          emit(part, direction === "from", direction === "to");
          part.forEach((e) => used.add(e.id));
        }
      pending = pending.filter((e) => !used.has(e.id));
    }
    for (const e of pending) emit([e]);
  }
  // Partial fan-out still shares one outside wire. Its exact destination subset
  // is retained for branches inside the parent; it must not imply every child.
  const fans = new Map();
  for (const e of result)
    if (groupBy.has(nodeId(e.to)) && e.to_member) {
      const original = e.presentation_edges[0],
        key = stable([
          nodeId(e.from),
          e.from_member,
          nodeId(e.to),
          e.kind,
          e.status,
          type(original, "out"),
          type(original, "in"),
        ]);
      if (!fans.has(key)) fans.set(key, []);
      fans.get(key).push(e);
    }
  const replaced = new Map(),
    removed = new Set();
  for (const fan of fans.values())
    if (fan.length > 1) {
      const first = fan[0],
        members = [...new Set(fan.map((e) => e.to_member))],
        all = groupBy.get(nodeId(first.to)).members.every((n) => members.includes(n.id));
      replaced.set(first.id, {
        ...first,
        presentation_edges: fan.flatMap((e) => e.presentation_edges),
        to_member: members.length === 1 ? members[0] : undefined,
        to_members: !all && members.length > 1 ? members : undefined,
      });
      fan.slice(1).forEach((e) => removed.add(e.id));
    }
  const edges = result.filter((e) => !removed.has(e.id)).map((e) => replaced.get(e.id) || e);
  for (const n of nodes.filter((n) => n.presentation_members))
    n.presentation_inlets = edges
      .filter((e) => nodeId(e.to) === n.id)
      .reduce((count, e) => count + (e.to_members?.length || (e.to_member ? 1 : 0)), 0);
  return { ...graph, nodes, edges, swimlanes: undefined, detail_grouping: false };
}

export function childLayout(parent) {
  return (parent.compound?.children || []).map((child) => ({
    ...child,
    x: parent.x - parent.width / 2 + child.x,
    y: parent.y - parent.height / 2 + child.y,
    parent_group: parent.id,
  }));
}

// The outside router treats each total box as an obstacle. Only a member-specific
// wire continues into its box, along gutters that do not pass through another child.
export function connectChildren(layout, router) {
  for (const parent of layout.nodes.filter((n) => n.compound?.kind === "detail_group")) {
    const left = parent.x - parent.width / 2,
      top = parent.y - parent.height / 2,
      children = parent.compound.children,
      header = {
        id: parent.id + "_heading",
        x: parent.width / 2,
        y:
          parent.compound.headingOffset +
          28 +
          (parent.compound.headH - parent.compound.headingOffset - 28) / 2,
        width: parent.compound.headingWidth,
        height: parent.compound.headH - parent.compound.headingOffset - 28,
      },
      local = { width: parent.width, height: parent.height, nodes: [...children, header] },
      jobs = [];
    for (const route of layout.edges)
      for (const [end, field, endpoint] of [
        ["start", "from_member", "from"],
        ["end", "to_member", "to"],
      ])
        if (nodeId(route.edge[endpoint]) === parent.id && route.edge[field])
          jobs.push({ route, end, child: children.find((n) => n.id === route.edge[field]) });
    for (const route of layout.edges)
      if (nodeId(route.edge.to) === parent.id)
        for (const member of route.edge.to_members || [])
          jobs.push({ route, end: "end", child: children.find((n) => n.id === member), fan: true });
    let reserved = [];
    const incoming = jobs.filter((j) => j.end === "end"),
      usedTracks = new Set(),
      buses = new Map();
    for (const job of incoming.filter((j) => j.fan && (j.route.sides?.end || "top") === "top"))
      if (!buses.has(job.route.id)) {
        const level = 12 + incoming.indexOf(job) * 18;
        buses.set(job.route.id, { route: job.route, level, tracks: [] });
        reserved.push(
          ...router.segments([
            { x: 16, y: level },
            { x: parent.width - 16, y: level },
          ]),
        );
      }
    for (const job of jobs) {
      const { route, end, child } = job;
      const outerSide = route.sides?.[end] || (end === "start" ? "bottom" : "top");
      if (outerSide !== (end === "start" ? "bottom" : "top")) {
        const siblings = jobs.filter((j) => j.child.id === child.id && j.end === end),
          rank = siblings.indexOf(job),
          step = Math.min(28, (child.width - 52) / Math.max(1, siblings.length - 1)),
          inner = boundaryPoint(
            child,
            end === "start" ? "bottom" : "top",
            child.x + (rank - (siblings.length - 1) / 2) * step,
          ),
          point = end === "start" ? route.points[0] : route.points.at(-1),
          outer = { x: point.x - left, y: point.y - top },
          portal = { id: parent.id + "_portal_" + route.id + end, ...outer, width: 0, height: 0 },
          opposite = { top: "bottom", bottom: "top", left: "right", right: "left" },
          r = {
            id: route.id + ":" + end,
            from: end === "start" ? child : portal,
            to: end === "start" ? portal : child,
            start: end === "start" ? inner : outer,
            end: end === "start" ? outer : inner,
            sides: {
              start: end === "start" ? "bottom" : opposite[outerSide],
              end: end === "start" ? opposite[outerSide] : "top",
            },
          },
          body = router.anchoredRoute(r, local, reserved),
          world = body.map((p) => ({ x: p.x + left, y: p.y + top }));
        reserved.push(...router.segments(body));
        if (job.fan) {
          const members = route.edge.presentation_edges.filter((e) => nodeId(e.to) === child.id);
          layout.group_branches ||= [];
          layout.group_branches.push({
            id: route.id + "__branch_" + child.id,
            edge: { ...members[0], presentation_edges: members },
            points: world,
            auxiliary: true,
            parent_group: parent.id,
          });
          route.arrow = false;
        } else {
          route.group_portals = { ...route.group_portals, [end]: { ...point } };
          route.points =
            end === "start"
              ? [...world.slice(0, -1), ...route.points]
              : [...route.points.slice(0, -1), ...world];
        }
        continue;
      }
      const siblings = jobs.filter((j) => j.child.id === child.id && j.end === end),
        rank = siblings.indexOf(job),
        step = Math.min(28, (child.width - 52) / Math.max(1, siblings.length - 1)),
        inner = {
          x: child.x + (rank - (siblings.length - 1) / 2) * step,
          y: child.y + ((end === "start" ? 1 : -1) * child.height) / 2,
        },
        point = end === "start" ? route.points[0] : route.points.at(-1),
        outer = { x: point.x - left, y: point.y - top },
        portal = { id: parent.id + "_portal_" + route.id + end, ...outer, width: 0, height: 0 },
        level = job.fan ? buses.get(route.id).level : 12 + incoming.indexOf(job) * 18,
        tracks = [
          16,
          32,
          48,
          64,
          parent.width - 16,
          parent.width - 32,
          parent.width - 48,
          parent.width - 64,
        ]
          .filter((x) => !usedTracks.has(x))
          .sort((a, b) => Math.abs(a - child.x) - Math.abs(b - child.x) || a - b),
        entry = end === "end" ? { x: tracks[0] ?? 16, y: level } : outer,
        prefix = end === "end" ? [outer, { x: outer.x, y: level }, entry] : [],
        r = {
          id: route.id + ":" + end,
          start: end === "start" ? inner : entry,
          end: end === "start" ? outer : inner,
          from: end === "start" ? child : portal,
          to: end === "start" ? portal : child,
          axis: "vertical",
        },
        body = router.fixedRoute(r, local, reserved),
        inside = end === "end" && !job.fan ? [...prefix.slice(0, -1), ...body] : body;
      if (end === "end") usedTracks.add(entry.x);
      reserved.push(...router.segments(inside));
      const world = inside.map((p) => ({ x: p.x + left, y: p.y + top }));
      if (job.fan) {
        const members = route.edge.presentation_edges.filter((e) => nodeId(e.to) === child.id);
        buses.get(route.id).tracks.push(entry.x);
        layout.group_branches ||= [];
        layout.group_branches.push({
          id: route.id + "__branch_" + child.id,
          edge: { ...members[0], presentation_edges: members },
          points: world,
          axis: "vertical",
          sides: { start: "bottom", end: "top" },
          auxiliary: true,
          parent_group: parent.id,
        });
        continue;
      }
      route.group_portals = { ...route.group_portals, [end]: { ...point } };
      route.points =
        end === "start"
          ? [...world.slice(0, -1), ...route.points]
          : [...route.points.slice(0, -1), ...world];
    }
    for (const bus of buses.values()) {
      const outer = bus.route.points.at(-1),
        join = { x: outer.x, y: top + bus.level },
        xs = [...bus.tracks.map((x) => x + left), join.x];
      layout.group_branches.push(
        {
          id: bus.route.id + "__stem",
          edge: bus.route.edge,
          points: [{ ...outer }, join],
          auxiliary: true,
          arrow: false,
          parent_group: parent.id,
        },
        {
          id: bus.route.id + "__bus",
          edge: bus.route.edge,
          points: [
            { x: Math.min(...xs), y: join.y },
            { x: Math.max(...xs), y: join.y },
          ],
          auxiliary: true,
          arrow: false,
          parent_group: parent.id,
        },
      );
    }
  }
  return layout;
}
