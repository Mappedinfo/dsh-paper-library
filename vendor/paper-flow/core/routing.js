import { boundaryPoint, faceRange, dataSkew } from "./nodeKinds.js";
import { prefersStraight, mayOptimizePosition } from "./hints.js";
const createRouting = function () {
  "use strict";
  const EPS = 1e-5,
    SPACE = 28,
    CLEAR = 18,
    STUB = 28;
  const nodeId = (port) => port.split(":")[0],
    cmp = (a, b) => String(a).localeCompare(String(b), "en");
  const distance = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
  const segmentMemo = new WeakMap();
  const segments = (points) => {
    if (!segmentMemo.has(points))
      segmentMemo.set(
        points,
        points
          .slice(1)
          .map((b, i) => ({ a: points[i], b, i, length: distance(points[i], b) }))
          .filter((s) => s.length > EPS),
      );
    return segmentMemo.get(points);
  };
  const unique = (xs) =>
    [...new Set(xs.map((x) => Math.round(x * 1000) / 1000))].sort((a, b) => a - b);
  function simplify(points) {
    const out = [];
    for (const p of points) {
      if (out.length && distance(out.at(-1), p) < EPS) continue;
      while (out.length > 1) {
        const a = out.at(-2),
          b = out.at(-1);
        if (
          (Math.abs(a.x - b.x) < EPS && Math.abs(b.x - p.x) < EPS) ||
          (Math.abs(a.y - b.y) < EPS && Math.abs(b.y - p.y) < EPS)
        )
          out.pop();
        else break;
      }
      out.push({ x: p.x, y: p.y });
    }
    return out;
  }
  function rect(n, margin = 0) {
    if (margin === CLEAR && n.compound?.kind === "detail_group") margin += 12;
    return {
      id: n.id,
      x: n.x - n.width / 2 - margin,
      y: n.y - n.height / 2 - margin,
      width: n.width + 2 * margin,
      height: n.height + 2 * margin,
    };
  }
  function hit(a, b, r) {
    let lo = 0,
      hi = 1;
    for (const [v, d, min, max] of [
      [a.x, b.x - a.x, r.x, r.x + r.width],
      [a.y, b.y - a.y, r.y, r.y + r.height],
    ]) {
      if (Math.abs(d) < EPS) {
        if (v <= min + EPS || v >= max - EPS) return false;
      } else {
        let t = (min - v) / d,
          u = (max - v) / d;
        if (t > u) [t, u] = [u, t];
        lo = Math.max(lo, t);
        hi = Math.min(hi, u);
        if (lo >= hi - EPS) return false;
      }
    }
    return hi > EPS && lo < 1 - EPS;
  }
  function intersection(s, t) {
    const dx = s.b.x - s.a.x,
      dy = s.b.y - s.a.y,
      ex = t.b.x - t.a.x,
      ey = t.b.y - t.a.y,
      den = dx * ey - dy * ex;
    if (Math.abs(den) < EPS) return null;
    const rx = t.a.x - s.a.x,
      ry = t.a.y - s.a.y,
      a = (rx * ey - ry * ex) / den,
      b = (rx * dy - ry * dx) / den;
    if (a < -EPS || a > 1 + EPS || b < -EPS || b > 1 + EPS) return null;
    return { x: s.a.x + a * dx, y: s.a.y + a * dy };
  }
  function parallel(s, t) {
    const sh = Math.abs(s.a.y - s.b.y) < EPS,
      sv = Math.abs(s.a.x - s.b.x) < EPS,
      th = Math.abs(t.a.y - t.b.y) < EPS,
      tv = Math.abs(t.a.x - t.b.x) < EPS;
    if (!((sh && th) || (sv && tv))) return null;
    const overlap = sh
      ? Math.min(Math.max(s.a.x, s.b.x), Math.max(t.a.x, t.b.x)) -
        Math.max(Math.min(s.a.x, s.b.x), Math.min(t.a.x, t.b.x))
      : Math.min(Math.max(s.a.y, s.b.y), Math.max(t.a.y, t.b.y)) -
        Math.max(Math.min(s.a.y, s.b.y), Math.min(t.a.y, t.b.y));
    return overlap > EPS
      ? { gap: sh ? Math.abs(s.a.y - t.a.y) : Math.abs(s.a.x - t.a.x), overlap }
      : null;
  }
  const eventMemo = new WeakMap();
  function pairEvents(a, b) {
    let cache = eventMemo.get(a.points);
    if (!cache) {
      cache = new WeakMap();
      eventMemo.set(a.points, cache);
    }
    if (cache.has(b.points)) return cache.get(b.points);
    const crossings = [],
      seen = new Set();
    let near = 0,
      overlap = 0;
    for (const s of segments(a.points))
      for (const t of segments(b.points)) {
        const p = intersection(s, t);
        if (p) {
          const atTerminal = (route) =>
            distance(p, route.points[0]) < EPS || distance(p, route.points.at(-1)) < EPS;
          if (atTerminal(a) && atTerminal(b)) continue;
          const key = p.x.toFixed(3) + "," + p.y.toFixed(3);
          if (!seen.has(key)) {
            seen.add(key);
            crossings.push({ ...p, a: a.id, b: b.id, ai: s.i, bi: t.i });
          }
        }
        const q = parallel(s, t);
        if (q && q.overlap >= 60 && q.gap < SPACE - EPS) {
          near++;
          overlap += q.overlap;
        }
      }
    const result = { crossings, near, overlap };
    cache.set(b.points, result);
    return result;
  }
  // A balanced fan is a presentation preference, enabled by free-tree views.
  // Topology, obstacle clearance, crossing count and crowded tracks stay hard
  // constraints. Different node names use exactly the same geometric rule.
  function balancedPort(routes, route, end) {
    if (!route.balance_terminals) return null;
    const node = end === "start" ? route.from : route.to;
    if (!node || node.compound) return null;
    const fan = routes.filter((r) => (end === "start" ? r.from : r.to)?.id === node.id);
    if (!fan.length || (fan.length === 1 && end !== "start")) return null;
    const neighbor = (r) => (end === "start" ? r.to : r.from),
      peers = fan.map(neighbor);
    let face;
    if (peers.every((n) => n.y + n.height / 2 < node.y - node.height / 2)) face = "top";
    else if (peers.every((n) => n.y - n.height / 2 > node.y + node.height / 2)) face = "bottom";
    else if (peers.every((n) => n.x + n.width / 2 < node.x - node.width / 2)) face = "left";
    else if (peers.every((n) => n.x - n.width / 2 > node.x + node.width / 2)) face = "right";
    else return null;
    const vertical = face === "top" || face === "bottom",
      dimension = vertical ? node.width : node.height,
      axis = vertical ? "x" : "y",
      ordered = [...fan].sort((a, b) => neighbor(a)[axis] - neighbor(b)[axis] || cmp(a.id, b.id)),
      step = Math.min(SPACE, (dimension - 2 * CLEAR) / Math.max(1, fan.length - 1)),
      value = node[axis] + (ordered.indexOf(route) - (fan.length - 1) / 2) * step;
    return {
      face,
      point: boundaryPoint(node, face, value),
    };
  }
  function terminalBalance(routes) {
    let error = 0;
    for (const route of routes)
      for (const end of ["start", "end"]) {
        const preferred = balancedPort(routes, route, end);
        if (preferred)
          error +=
            distance(route.points[end === "start" ? 0 : route.points.length - 1], preferred.point) *
            (end === "start" && routes.filter((r) => r.from.id === route.from.id).length === 1
              ? 0.2
              : 1);
      }
    return error;
  }
  // Coordinate first elbows on the same physical face, including the mirrored
  // last elbows of an input fan. Straight connections have no elbow to align.
  function bendFans(routes) {
    const groups = new Map();
    for (const r of [...routes].sort((a, b) => cmp(a.id, b.id))) {
      if (!r.balance_terminals || r.manual_route || r.points.length < 3) continue;
      for (const end of ["start", "end"]) {
        const side = r.sides[end],
          points = end === "start" ? r.points : [...r.points].reverse(),
          node = end === "start" ? r.from : r.to;
        if (!outward(points, side)) continue;
        const axis = side === "top" || side === "bottom" ? "y" : "x",
          cross = axis === "x" ? "y" : "x";
        if (
          Math.abs(points[1][axis] - points[2][axis]) > EPS ||
          Math.abs(points[1][cross] - points[2][cross]) < EPS
        )
          continue;
        const key = JSON.stringify([node.id, end, side]);
        if (!groups.has(key)) groups.set(key, { node, end, side, axis, members: [] });
        groups.get(key).members.push({ route: r, points });
      }
    }
    return [...groups.values()].filter((g) => g.members.length > 1);
  }
  function bendBalance(routes) {
    return bendFans(routes).reduce((sum, fan) => {
      const levels = fan.members.map((m) => m.points[1][fan.axis]);
      return sum + Math.max(...levels) - Math.min(...levels);
    }, 0);
  }
  function analyze(routes) {
    const crossings = [];
    let closeParallel = 0,
      closeParallelLength = 0,
      length = 0,
      bends = 0;
    for (const r of routes) {
      length += segments(r.points).reduce((s, e) => s + e.length, 0);
      bends += Math.max(0, r.points.length - 2);
    }
    for (let i = 0; i < routes.length; i++)
      for (let j = i + 1; j < routes.length; j++) {
        const q = pairEvents(routes[i], routes[j]);
        crossings.push(...q.crossings);
        closeParallel += q.near;
        closeParallelLength += q.overlap;
      }
    return {
      crossings: crossings.length,
      close_parallel: closeParallel,
      close_parallel_length: Math.round(closeParallelLength),
      length: Math.round(length),
      bends,
      events: crossings,
      ...(routes.some((r) => r.balance_terminals)
        ? { terminal_balance: terminalBalance(routes), fan_bend_spread: bendBalance(routes) }
        : {}),
    };
  }

  // Reorder only nodes whose vertical extents share a row inside one comparison
  // lane. Shared nodes stay in the center lane; stage ranks never change.
  function optimizeRows(layout, rows, centers) {
    const by = new Map(layout.nodes.map((n) => [n.id, n])),
      edges = layout.edges.map((e) => [nodeId(e.edge.from), nodeId(e.edge.to)]);
    const assign = (row) => {
      let left = centers[row.lane] - row.width / 2;
      for (const n of row.nodes) {
        n.x = left + n.width / 2;
        left += n.width + row.gap;
      }
    };
    const cost = () => {
      let n = 0;
      const lines = edges.map(([a, b]) => ({
        a: { x: by.get(a).x, y: by.get(a).y + by.get(a).height / 2 },
        b: { x: by.get(b).x, y: by.get(b).y - by.get(b).height / 2 },
        ids: [a, b],
      }));
      for (let i = 0; i < lines.length; i++)
        for (let j = i + 1; j < lines.length; j++) {
          if (lines[i].ids.some((id) => lines[j].ids.includes(id))) continue;
          if (intersection(lines[i], lines[j])) n += 10000;
        }
      return n + lines.reduce((s, l) => s + Math.abs(l.a.x - l.b.x), 0);
    };
    let best = cost();
    for (let sweep = 0; sweep < 3; sweep++)
      for (const row of sweep % 2 ? [...rows].reverse() : rows) {
        if (row.nodes.length < 2 || row.nodes.some((n) => n.fixed || n.node?.fixed || n.node?.layout?.optimizePosition === false)) continue;
        for (let i = 0; i < row.nodes.length - 1; i++) {
          [row.nodes[i], row.nodes[i + 1]] = [row.nodes[i + 1], row.nodes[i]];
          assign(row);
          const c = cost();
          if (c < best - EPS) best = c;
          else {
            [row.nodes[i], row.nodes[i + 1]] = [row.nodes[i + 1], row.nodes[i]];
            assign(row);
          }
        }
      }
  }
  function groupEdges(graph, layout) {
    const groups = new Map();
    for (const ed of [...layout.edges].sort((a, b) => cmp(a.id, b.id))) {
      const e = ed.edge,
        key = graph.collapsed
          ? JSON.stringify([nodeId(e.from), nodeId(e.to), e.status || "single", e.kind])
          : ed.id;
      if (!groups.has(key)) groups.set(key, { id: ed.id, edge: e, members: [] });
      groups.get(key).members.push(ed);
    }
    return [...groups.values()];
  }
  const faceKey = (r, end) =>
    (end === "start" ? r.from : r.to).id +
    "|" +
    (r.sides?.[end] || (end === "start" ? "bottom" : "top"));
  function terminals(layout, routes) {
    const by = new Map(layout.nodes.map((n) => [n.id, n])),
      out = new Map(),
      inc = new Map(),
      lane = { a: 0, shared: 1, single: 1, b: 2 };
    for (const r of routes) {
      r.from = by.get(nodeId(r.edge.from));
      r.to = by.get(nodeId(r.edge.to));
      r.axis =
        layout.compact &&
        r.from.compound?.kind !== "detail_group" &&
        r.to.compound?.kind !== "detail_group" &&
        r.from.compact_band === r.to.compact_band &&
        r.from.compact_row === r.to.compact_row
          ? "horizontal"
          : "vertical";
      if (layout.tree_levels === "compact") {
        if (Math.abs(r.from.y - r.to.y) < EPS) r.axis = "horizontal";
        else if (r.to.y < r.from.y) r.axis = "upward";
      }
      r.direction = r.to.x > r.from.x ? 1 : -1;
      r.sides =
        r.axis === "horizontal"
          ? { start: r.direction > 0 ? "right" : "left", end: r.direction > 0 ? "left" : "right" }
          : r.axis === "upward"
            ? { start: "top", end: "bottom" }
            : { start: "bottom", end: "top" };
      for (const [map, end] of [
        [out, "start"],
        [inc, "end"],
      ]) {
        const id = faceKey(r, end);
        if (!map.has(id)) map.set(id, []);
        map.get(id).push(r);
      }
    }
    for (const [map, key, opposite] of [
      [out, "start", "to"],
      [inc, "end", "from"],
    ])
      for (const list of map.values()) {
        const horizontal = ["left", "right"].includes(list[0].sides[key]),
          coord = horizontal ? "y" : "x";
        list.sort(
          (a, b) =>
            a[opposite][coord] - b[opposite][coord] ||
            lane[a.edge.status || "single"] - lane[b.edge.status || "single"] ||
            (horizontal ? a[opposite].x - b[opposite].x : a[opposite].y - b[opposite].y) ||
            cmp(a.id, b.id),
        );
        const n = key === "start" ? list[0].from : list[0].to,
          step = Math.min(
            SPACE,
            ((horizontal ? n.height : n.width) - 52) / Math.max(1, list.length - 1),
          );
        const occupied = [];
        list.sort(
          (a, b) =>
            Number(!!a.edge[key === "start" ? "from_member" : "to_member"]) -
            Number(!!b.edge[key === "start" ? "from_member" : "to_member"]),
        );
        list.forEach((r, i) => {
          const offset = (i - (list.length - 1) / 2) * step,
            side = r.sides[key];
          if (n.compound?.kind === "detail_group") {
            if (horizontal) {
              r[key] = boundaryPoint(n, side, n.y + offset);
              return;
            }
            const member = r.edge[key === "start" ? "from_member" : "to_member"],
              child = n.compound.children.find((c) => c.id === member),
              preferred = child
                ? n.x -
                  n.width / 2 +
                  child.x +
                  (child.x < n.width / 2 ? -1 : 1) * (child.width / 2 - 26)
                : n.x + offset,
              lo = n.x - n.width / 2 + 26,
              hi = n.x + n.width / 2 - 26,
              candidates = unique([
                preferred,
                n.x,
                ...Array.from(
                  { length: Math.ceil((hi - lo) / SPACE) + 1 },
                  (_, j) => lo + j * SPACE,
                ),
              ])
                .filter(
                  (x) =>
                    x >= lo &&
                    x <= hi &&
                    occupied.every((p) => Math.abs(p - x) >= SPACE - EPS) &&
                    !(
                      ((child && key === "end") || (key === "start" && side === "top")) &&
                      Math.abs(x - n.x) < n.compound.headingWidth / 2 + CLEAR
                    ),
                )
                .sort((a, b) => Math.abs(a - preferred) - Math.abs(b - preferred) || a - b);
            const x = candidates[0] ?? preferred;
            occupied.push(x);
            r[key] = boundaryPoint(n, side, x);
            return;
          }
          r[key] = boundaryPoint(n, side, n[coord] + offset);
        });
      }
    for (const r of routes)
      for (const point of [r.start, r.end]) {
        point.x = Math.round(point.x * 1000) / 1000;
        point.y = Math.round(point.y * 1000) / 1000;
      }
    return by;
  }
  const obstacleMemo = new WeakMap(),
    penaltyMemo = new WeakMap();
  const segmentKey = (s) => [s.a.x, s.a.y, s.b.x, s.b.y].join(",");
  function valid(points, r, boxes) {
    const ss = segments(points);
    let memo = obstacleMemo.get(boxes);
    if (!memo) {
      memo = new Map();
      obstacleMemo.set(boxes, memo);
    }
    return ss.every((s, i) => {
      const exempt = [...(i === 0 ? [r.from.id] : []), ...(i === ss.length - 1 ? [r.to.id] : [])],
        key = exempt.join(",") + "|" + segmentKey(s);
      if (!memo.has(key))
        memo.set(key, !boxes.some((b) => !exempt.includes(b.id) && hit(s.a, s.b, b)));
      return memo.get(key);
    });
  }
  function routeCost(points, reserved) {
    const ss = segments(points);
    let score = ss.reduce((s, e) => s + e.length, 0) + Math.max(0, ss.length - 1) * 25;
    if (!reserved.length) return score;
    let memo = penaltyMemo.get(reserved);
    if (!memo) {
      memo = new Map();
      penaltyMemo.set(reserved, memo);
    }
    for (const a of ss) {
      const key = segmentKey(a);
      if (!memo.has(key)) {
        let penalty = 0;
        for (const b of reserved) {
          const q = parallel(a, b);
          if (q && q.gap < SPACE - EPS)
            penalty +=
              q.overlap *
              (q.gap < 1 ? 80 : (q.gap < 20 ? 50 : 18) * Math.pow(1 - q.gap / SPACE, 2));
          const p = intersection(a, b);
          if (p) {
            penalty += 900;
            const endDistance = Math.min(
              distance(p, a.a),
              distance(p, a.b),
              distance(p, b.a),
              distance(p, b.b),
            );
            if (endDistance < 15) penalty += 350;
          }
        }
        memo.set(key, penalty);
      }
      score += memo.get(key);
    }
    return score;
  }
  function candidateRoutes(r, layout, boxes, reserved) {
    const s = r.start,
      t = r.end,
      dy = t.y - s.y,
      xs = unique([
        s.x,
        t.x,
        16,
        layout.width - 16,
        ...layout.nodes.flatMap((n) => [
          n.x - n.width / 2 - CLEAR - 2,
          n.x + n.width / 2 + CLEAR + 2,
          n.x,
        ]),
        ...reserved
          .filter((e) => Math.abs(e.a.x - e.b.x) < EPS)
          .flatMap((e) => [e.a.x - SPACE, e.a.x + SPACE]),
      ]).filter((x) => x >= 12 && x <= layout.width - 12);
    const exit = unique([
        s.y + STUB,
        s.y + STUB + SPACE,
        s.y + STUB + 2 * SPACE,
        ...boxes
          .filter((b) => b.y < s.y && b.y + b.height > s.y && b.y + b.height < s.y + 180)
          .map((b) => b.y + b.height + 2),
      ]).filter((y) => y < t.y - 12),
      entry = unique([
        t.y - STUB,
        t.y - STUB - SPACE,
        t.y - STUB - 2 * SPACE,
        ...boxes
          .filter((b) => b.y < t.y && b.y + b.height > t.y && b.y > t.y - 180)
          .map((b) => b.y - 2),
      ]).filter((y) => y > s.y + 12);
    const candidates = [],
      seen = new Set();
    function add(p) {
      p = simplify(p);
      const k = JSON.stringify(p);
      if (seen.has(k)) return;
      seen.add(k);
      if (valid(p, r, boxes)) candidates.push(p);
    }
    if (Math.abs(s.x - t.x) < EPS) add([s, t]);
    for (const y of unique([(s.y + t.y) / 2, ...exit, ...entry]))
      if (y > s.y + 12 && y < t.y - 12) add([s, { x: s.x, y }, { x: t.x, y }, t]);
    if (dy > 2 * STUB)
      for (const x of xs)
        for (const y1 of exit)
          for (const y2 of entry) {
            if (y1 <= y2)
              add([s, { x: s.x, y: y1 }, { x, y: y1 }, { x, y: y2 }, { x: t.x, y: y2 }, t]);
          }
    return candidates;
  }
  // Visibility-grid A* is a fallback for local node arrangements requiring more
  // than one vertical corridor. Both node obstacles and existing wires cost.
  function search(r, layout, boxes, reserved, anchored = false) {
    const a = anchored ? normal[r.sides.start] : { x: 0, y: 1 },
      b = anchored ? normal[r.sides.end] : { x: 0, y: -1 },
      startStub =
        STUB +
        (anchored && r.from.compound?.kind === "detail_group" ? 12 : 0) +
        (anchored && ["left", "right"].includes(r.sides.start) ? dataSkew(r.from) : 0),
      endStub =
        STUB +
        (anchored && r.to.compound?.kind === "detail_group" ? 12 : 0) +
        (anchored && ["left", "right"].includes(r.sides.end) ? dataSkew(r.to) : 0),
      s = { x: r.start.x + a.x * startStub, y: r.start.y + a.y * startStub },
      t = { x: r.end.x + b.x * endStub, y: r.end.y + b.y * endStub };
    const xs = unique([
        s.x,
        t.x,
        12,
        layout.width - 12,
        ...boxes.flatMap((b) => [b.x - 2, b.x + b.width + 2]),
        ...reserved
          .filter((e) => Math.abs(e.a.x - e.b.x) < EPS)
          .flatMap((e) => [e.a.x - SPACE, e.a.x + SPACE]),
      ]).filter((x) => x >= 8 && x <= layout.width - 8),
      ys = unique([
        s.y,
        t.y,
        ...boxes.flatMap((b) => [b.y - 2, b.y + b.height + 2]),
        ...(anchored
          ? [
              12,
              layout.height - 12,
              ...reserved
                .filter((e) => Math.abs(e.a.y - e.b.y) < EPS)
                .flatMap((e) => [e.a.y - SPACE, e.a.y + SPACE]),
            ]
          : []),
      ]).filter((y) =>
        anchored ? y >= 8 && y <= layout.height - 8 : y >= s.y - EPS && y <= t.y + EPS,
      );
    const si = xs.indexOf(Math.round(s.x * 1000) / 1000),
      sj = ys.indexOf(Math.round(s.y * 1000) / 1000),
      ti = xs.indexOf(Math.round(t.x * 1000) / 1000),
      tj = ys.indexOf(Math.round(t.y * 1000) / 1000);
    const heap = [];
    function push(v) {
      heap.push(v);
      let i = heap.length - 1;
      while (i) {
        const p = (i - 1) >> 1;
        if (heap[p].f <= v.f) break;
        heap[i] = heap[p];
        i = p;
      }
      heap[i] = v;
    }
    function pop() {
      const first = heap[0],
        last = heap.pop();
      if (heap.length) {
        let i = 0;
        while (i * 2 + 1 < heap.length) {
          let c = i * 2 + 1;
          if (c + 1 < heap.length && heap[c + 1].f < heap[c].f) c++;
          if (heap[c].f >= last.f) break;
          heap[i] = heap[c];
          i = c;
        }
        heap[i] = last;
      }
      return first;
    }
    const costs = new Map(),
      parents = new Map();
    const key = si + "," + sj + ",0";
    push({ i: si, j: sj, dir: 0, g: 0, f: distance(s, t), key });
    costs.set(key, 0);
    let goal;
    while (heap.length) {
      const n = pop();
      if (n.g !== costs.get(n.key)) continue;
      if (n.i === ti && n.j === tj) {
        goal = n;
        break;
      }
      for (const [di, dj, dir] of [
        [0, 1, 1],
        ...(anchored ? [[0, -1, 1]] : []),
        [1, 0, 2],
        [-1, 0, 2],
      ]) {
        const i = n.i + di,
          j = n.j + dj;
        if (i < 0 || j < 0 || i >= xs.length || j >= ys.length) continue;
        const a = { x: xs[n.i], y: ys[n.j] },
          b = { x: xs[i], y: ys[j] };
        if (boxes.some((r) => hit(a, b, r))) continue;
        const cost = n.g + routeCost([a, b], reserved) + (n.dir && n.dir !== dir ? 25 : 0),
          k = i + "," + j + "," + dir;
        if (cost >= (costs.get(k) ?? Infinity)) continue;
        costs.set(k, cost);
        parents.set(k, n);
        push({ i, j, dir, g: cost, f: cost + distance(b, t), key: k });
      }
    }
    if (!goal) throw Error("连线通道不足：" + r.id);
    const points = [];
    for (let n = goal; n; n = parents.get(n.key)) points.push({ x: xs[n.i], y: ys[n.j] });
    points.reverse();
    return simplify([r.start, ...points, r.end]);
  }
  // Reuse the obstacle-aware orthogonal planner in a per-edge coordinate frame.
  // Horizontal arrows enter side faces; transpose/reflection supports both L→R
  // and R→L without imposing a global left-to-right scientific ordering.
  function planningFrame(r, layout, boxes, reserved) {
    if (r.axis === "upward") {
      const transform = (p) => ({ x: p.x, y: layout.height - p.y }),
        nodes = layout.nodes.map((n) => ({ ...n, ...transform(n) })),
        by = new Map(nodes.map((n) => [n.id, n]));
      return {
        r: {
          ...r,
          from: by.get(r.from.id),
          to: by.get(r.to.id),
          start: transform(r.start),
          end: transform(r.end),
        },
        layout: { ...layout, nodes },
        boxes: nodes.map((n) => rect(n, CLEAR)),
        reserved: reserved.map((s) => ({ ...s, a: transform(s.a), b: transform(s.b) })),
        restore: (p) => p.map(transform),
      };
    }
    if (r.axis !== "horizontal") return { r, layout, boxes, reserved, restore: (p) => p };
    const transform = (p) => ({ x: p.y, y: r.direction > 0 ? p.x : layout.width - p.x }),
      restore = (p) => p.map((q) => ({ x: r.direction > 0 ? q.y : layout.width - q.y, y: q.x })),
      nodes = layout.nodes.map((n) => ({
        ...n,
        ...transform(n),
        width: n.height,
        height: n.width,
      })),
      by = new Map(nodes.map((n) => [n.id, n]));
    return {
      r: {
        ...r,
        from: by.get(r.from.id),
        to: by.get(r.to.id),
        start: transform(r.start),
        end: transform(r.end),
      },
      layout: { ...layout, width: layout.height, height: layout.width, nodes },
      boxes: nodes.map((n) => rect(n, CLEAR)),
      reserved: reserved.map((s) => ({ ...s, a: transform(s.a), b: transform(s.b) })),
      restore,
    };
  }
  function optionsFor(r, layout, boxes, reserved) {
    const f = planningFrame(r, layout, boxes, reserved);
    return candidateRoutes(f.r, f.layout, f.boxes, f.reserved).map(f.restore);
  }
  function fallbackFor(r, layout, boxes, reserved) {
    const f = planningFrame(r, layout, boxes, reserved);
    return f.restore(search(f.r, f.layout, f.boxes, f.reserved));
  }
  function fixedRoute(r, layout, reserved = []) {
    const boxes = layout.nodes.map((n) => rect(n, CLEAR));
    const candidates = optionsFor(r, layout, boxes, reserved).filter((p) =>
      p.every((v) => v.x >= 0 && v.x <= layout.width && v.y >= 0 && v.y <= layout.height),
    );
    candidates.sort((a, b) => routeCost(a, reserved) - routeCost(b, reserved));
    return candidates[0] || fallbackFor(r, layout, boxes, reserved);
  }
  function anchoredRoute(r, layout, reserved = []) {
    const boxes = layout.nodes.map((n) => rect(n, CLEAR)),
      points = search(r, layout, boxes, reserved, true);
    if (
      !valid(points, r, boxes) ||
      !outward(points, r.sides.start) ||
      !outward([...points].reverse(), r.sides.end)
    )
      throw Error("连接点通道被遮挡：" + r.id);
    return points;
  }
  function manualRoute(r, layout, route) {
    if (
      !Array.isArray(route) ||
      route.length < 2 ||
      route.length > 80 ||
      route.some(
        (p) =>
          !Number.isFinite(p.x) ||
          !Number.isFinite(p.y) ||
          p.x < 0 ||
          p.y < 0 ||
          p.x > 50000 ||
          p.y > 50000,
      )
    )
      throw Error("转折路径需包含2–80个有效画布坐标");
    const points = route.map((p) => ({ ...p }));
    points[0] = { ...r.start };
    points[points.length - 1] = { ...r.end };
    // Fixed middle bends stay in canvas coordinates; when a node moves, add a
    // short orthogonal join at its endpoint rather than moving those bends.
    for (const end of ["start", "end"]) {
      if (end === "end") points.reverse();
      const a = points[0],
        b = points[1],
        side = r.sides[end];
      if (Math.abs(a.x - b.x) > EPS && Math.abs(a.y - b.y) > EPS)
        points.splice(
          1,
          0,
          ["top", "bottom"].includes(side) ? { x: a.x, y: b.y } : { x: b.x, y: a.y },
        );
      if (end === "end") points.reverse();
    }
    const result = simplify(points),
      boxes = layout.nodes.map((n) => rect(n, CLEAR));
    if (
      result.some(
        (p, i) =>
          i && Math.abs(p.x - result[i - 1].x) > EPS && Math.abs(p.y - result[i - 1].y) > EPS,
      ) ||
      !valid(result, r, boxes) ||
      !outward(result, r.sides.start) ||
      !outward([...result].reverse(), r.sides.end)
    )
      throw Error("转折路径穿过节点或反向接入，请拖到空白通道");
    return result;
  }
  // Destination order is only an initial guess: obstacles can make the actual
  // corridors run in the opposite order. Exchange adjacent terminal slots AND
  // their escape levels after routing, retaining each edge's own corridor and
  // remote endpoint. This untangles a fan without merely hiding it with bridges.
  function optimizePorts(routes, nodes) {
    const boxes = nodes.map((n) => rect(n, CLEAR));
    let quality = analyze(routes),
      accepted = 0;
    const better = (q) =>
      q.crossings < quality.crossings && q.close_parallel_length <= quality.close_parallel_length;
    for (let sweep = 0; sweep < 2; sweep++)
      for (const end of ["start", "end"]) {
        const groups = new Map();
        for (const r of routes) {
          if (
            r.axis === "horizontal" ||
            (r.sides &&
              ((end === "start" && r.sides.start !== "bottom") ||
                (end === "end" && r.sides.end !== "top")))
          )
            continue;
          const id = faceKey(r, end);
          if (!groups.has(id)) groups.set(id, []);
          groups.get(id).push(r);
        }
        for (const id of [...groups.keys()].sort(cmp)) {
          const list = groups
            .get(id)
            .sort(
              (a, b) =>
                a.points[end === "start" ? 0 : a.points.length - 1].x -
                  b.points[end === "start" ? 0 : b.points.length - 1].x || cmp(a.id, b.id),
            );
          for (let i = 0; i < list.length - 1; i++) {
            const a = list[i],
              b = list[i + 1],
              original = [a.points, b.points],
              oriented = original.map((p) => (end === "start" ? p : [...p].reverse()));
            if (
              oriented.some(
                (p) =>
                  p.length < 4 ||
                  Math.abs(p[0].x - p[1].x) > EPS ||
                  Math.abs(p[1].y - p[2].y) > EPS ||
                  Math.abs(p[1].x - p[2].x) < EPS,
              )
            )
              continue;
            let best = null,
              bestQuality = quality;
            for (const [swapX, swapLevel] of [
              [true, true],
              [true, false],
              [false, true],
            ]) {
              if (
                swapLevel &&
                oriented.some((p, k) => {
                  const y = oriented[1 - k][1].y;
                  return (y - p[0].y) * (p[3].y - y) < -EPS;
                })
              )
                continue;
              const candidate = oriented.map((p, k) => {
                const other = oriented[1 - k],
                  x = swapX ? other[0].x : p[0].x,
                  y = swapLevel ? other[1].y : p[1].y;
                return simplify([{ x, y: p[0].y }, { x, y }, { x: p[2].x, y }, ...p.slice(3)]);
              });
              const paths = candidate.map((p) => (end === "start" ? p : p.reverse()));
              if (!valid(paths[0], a, boxes) || !valid(paths[1], b, boxes)) continue;
              a.points = paths[0];
              b.points = paths[1];
              const q = analyze(routes);
              if (
                better(q) &&
                (q.crossings < bestQuality.crossings ||
                  (q.crossings === bestQuality.crossings &&
                    q.close_parallel_length < bestQuality.close_parallel_length))
              ) {
                best = paths;
                bestQuality = q;
              }
            }
            [a.points, b.points] = best || original;
            if (best) {
              quality = bestQuality;
              accepted++;
              for (const r of [a, b]) {
                r.start = { ...r.points[0] };
                r.end = { ...r.points.at(-1) };
              }
              list.sort((a, b) => a[end].x - b[end].x || cmp(a.id, b.id));
            }
          }
        }
      }
    return accepted;
  }
  // Port slots may slide together along a node face. A clear vertical connection
  // should not keep a dogleg merely because initial inlet/outlet centers differ.
  // Keep fan order/spacing, lock existing straight edges, and only remove bends
  // when neither crossings nor close-parallel overlap gets worse.
  function straighten(routes, nodes) {
    const boxes = nodes.map((n) => rect(n, CLEAR)),
      out = new Map(),
      inc = new Map();
    let quality = analyze(routes),
      accepted = 0;
    for (const r of routes) {
      if (
        r.axis === "horizontal" ||
        (r.sides?.start || "bottom") !== "bottom" ||
        (r.sides?.end || "top") !== "top"
      )
        continue;
      for (const [map, end] of [
        [out, "start"],
        [inc, "end"],
      ]) {
        const id = faceKey(r, end);
        if (!map.has(id)) map.set(id, []);
        map.get(id).push(r);
      }
    }
    const move = (points, end, dx) => {
      const p = (end === "start" ? points : [...points].reverse()).map((p) => ({ ...p }));
      if (p.length < 3 || Math.abs(p[0].x - p[1].x) > EPS || Math.abs(p[1].y - p[2].y) > EPS)
        return null;
      p[0].x += dx;
      p[1].x += dx;
      const q = simplify(p);
      return end === "start" ? q : q.reverse();
    };
    for (const r of [...routes].sort(
      (a, b) => a.end.y - a.start.y - (b.end.y - b.start.y) || cmp(a.id, b.id),
    )) {
      if (
        r.axis === "horizontal" ||
        r.points.length === 2 ||
        (r.sides?.start || "bottom") !== "bottom" ||
        (r.sides?.end || "top") !== "top"
      )
        continue;
      const source = out.get(faceKey(r, "start")),
        target = inc.get(faceKey(r, "end")),
        s = r.points[0],
        t = r.points.at(-1),
        groups = [
          [source, "start", r.from, s.x],
          [target, "end", r.to, t.x],
        ],
        affected = [...new Set([...source, ...target])],
        original = new Map(affected.map((e) => [e, e.points]));
      let lo = -Infinity,
        hi = Infinity;
      for (const [list, end, n, x] of groups) {
        const slots = list.map((e) => e.points[end === "start" ? 0 : e.points.length - 1].x);
        const range = faceRange(n, end === "start" ? "bottom" : "top", 26);
        lo = Math.max(lo, x + range[0] - Math.min(...slots));
        hi = Math.min(hi, x + range[1] - Math.max(...slots));
      }
      if (lo > hi + EPS) continue;
      const clamp = (x) => Math.max(lo, Math.min(hi, x)),
        anchors = unique([s.x, t.x, (s.x + t.x) / 2, r.from.x, r.to.x, lo, hi].map(clamp));
      let best = null,
        bestQuality = quality;
      for (const x of anchors) {
        const paths = new Map(original);
        let feasible = true;
        for (const [list, end, n, oldX] of groups) {
          const dx = x - oldX;
          if (Math.abs(dx) < EPS) continue;
          for (const e of list) {
            if (e === r) continue;
            const p = move(paths.get(e), end, dx);
            if (!p) {
              feasible = false;
              break;
            }
            paths.set(e, p);
          }
          if (!feasible) break;
        }
        if (!feasible) continue;
        paths.set(r, [
          { x, y: s.y },
          { x, y: t.y },
        ]);
        if ([...paths].some(([e, p]) => !valid(p, e, boxes))) continue;
        for (const [e, p] of paths) e.points = p;
        const q = analyze(routes);
        if (
          q.crossings <= quality.crossings &&
          q.close_parallel_length <= quality.close_parallel_length &&
          q.bends < quality.bends &&
          (q.bends < bestQuality.bends ||
            (q.bends === bestQuality.bends &&
              (q.crossings < bestQuality.crossings ||
                (q.crossings === bestQuality.crossings && q.length < bestQuality.length))))
        ) {
          best = new Map(paths);
          bestQuality = q;
        }
        for (const [e, p] of original) e.points = p;
      }
      if (best) {
        for (const [e, p] of best) {
          e.points = p;
          e.start = { ...p[0] };
          e.end = { ...p.at(-1) };
        }
        quality = bestQuality;
        accepted++;
      }
    }
    return accepted;
  }

  // Presentation quality is separate from DSL correctness. Use the same finite
  // neighborhood for repair and lint: reattach a terminal to a free face/slot,
  // or slide an otherwise isolated compact row within its original lane.
  const normal = {
    top: { x: 0, y: -1 },
    bottom: { x: 0, y: 1 },
    left: { x: -1, y: 0 },
    right: { x: 1, y: 0 },
  };
  const qualityScore = (q) =>
    q.crossings * 2000 +
    q.close_parallel_length * 8 +
    q.bends * 40 +
    q.length +
    (q.terminal_balance || 0) * 2;
  const improves = (q, old) =>
    q.crossings <= old.crossings &&
    q.close_parallel_length <= old.close_parallel_length &&
    qualityScore(q) < qualityScore(old) - EPS;
  function deltaQuality(routes, changed, before) {
    const q = { ...before, events: undefined };
    let length = 0,
      bends = 0,
      crossings = 0,
      near = 0,
      overlap = 0;
    for (const [r, old] of changed) {
      const now = r.points;
      length +=
        segments(now).reduce((s, e) => s + e.length, 0) -
        segments(old).reduce((s, e) => s + e.length, 0);
      bends += now.length - old.length;
    }
    for (let i = 0; i < routes.length; i++)
      for (let j = i + 1; j < routes.length; j++) {
        const a = routes[i],
          b = routes[j];
        if (!changed.has(a) && !changed.has(b)) continue;
        const now = pairEvents(a, b),
          old = pairEvents(
            { ...a, points: changed.get(a) || a.points },
            { ...b, points: changed.get(b) || b.points },
          );
        crossings += now.crossings.length - old.crossings.length;
        near += now.near - old.near;
        overlap += now.overlap - old.overlap;
      }
    q.length = Math.round(before.length + length);
    q.bends += bends;
    q.crossings += crossings;
    q.close_parallel += near;
    q.close_parallel_length = Math.round(before.close_parallel_length + overlap);
    if (routes.some((r) => r.balance_terminals)) {
      q.terminal_balance = terminalBalance(routes);
      q.fan_bend_spread = bendBalance(routes);
    }
    return q;
  }
  function outward(points, side) {
    if (points.length < 2) return false;
    const d = normal[side],
      a = points[0],
      b = points[1];
    return d.x
      ? Math.abs(a.y - b.y) < EPS && (b.x - a.x) * d.x > EPS
      : Math.abs(a.x - b.x) < EPS && (b.y - a.y) * d.y > EPS;
  }
  function slots(r, end, side, routes) {
    const n = end === "start" ? r.from : r.to,
      vertical = side === "top" || side === "bottom",
      coord = vertical ? "x" : "y",
      dimension = vertical ? n.width : n.height,
      center = n[coord],
      preferred = balancedPort(routes, r, end),
      [lo, hi] = faceRange(n, side, 26),
      occupied = [];
    for (const other of routes)
      for (const key of ["start", "end"])
        if (
          other !== r &&
          (key === "start" ? other.from : other.to).id === n.id &&
          other.sides[key] === side
        )
          occupied.push(other.points[key === "start" ? 0 : other.points.length - 1][coord]);
    return unique([
      ...(preferred?.face === side ? [preferred.point[coord]] : []),
      r.points[end === "start" ? 0 : r.points.length - 1][coord],
      center,
      ...[-2, -1, 1, 2].map((k) => center + k * SPACE),
      lo,
      hi,
      ...occupied.flatMap((x) => [x - SPACE, x + SPACE]),
    ])
      .filter(
        (v) =>
          v >= lo - EPS &&
          v <= hi + EPS &&
          !(
            n.compound?.kind === "detail_group" &&
            end === "end" &&
            r.edge.to_member &&
            Math.abs(v - n.x) < n.compound.headingWidth / 2 + CLEAR
          ) &&
          occupied.every((x) => Math.abs(x - v) >= SPACE - EPS),
      )
      .map((v) => boundaryPoint(n, side, v));
  }
  function grafts(points, port, side) {
    const escape = { x: port.x + normal[side].x * STUB, y: port.y + normal[side].y * STUB },
      out = [],
      seen = new Set();
    const add = (p) => {
      p = simplify(p);
      const key = JSON.stringify(p);
      if (!seen.has(key) && outward(p, side)) {
        seen.add(key);
        out.push(p);
      }
    };
    // Preserve the remote corridor and its endpoint. Only the local prefix is
    // replaced; a candidate may bypass several obsolete bends, never a node.
    for (let j = 1; j < points.length; j++) {
      const t = points[j],
        tail = points.slice(j + 1);
      add([port, escape, { x: t.x, y: escape.y }, t, ...tail]);
      add([port, escape, { x: escape.x, y: t.y }, t, ...tail]);
    }
    return out;
  }
  function fanBendImprovement(routes, nodes, quality, first = false) {
    const boxes = nodes.map((n) => rect(n, CLEAR));
    let best = null,
      bestQ = quality;
    for (const fan of bendFans(routes)) {
      const { axis, side, end } = fan,
        sign = normal[side][axis],
        levels = unique([
          ...fan.members.map((m) => m.points[1][axis]),
          ...fan.members.map((m) => m.points[0][axis] + sign * STUB),
          ...boxes.flatMap((b) => (axis === "x" ? [b.x, b.x + b.width] : [b.y, b.y + b.height])),
        ]);
      for (const level of levels) {
        const paths = new Map();
        for (const { route, points } of fan.members) {
          if ((level - points[0][axis]) * sign < CLEAR - EPS) break;
          if (Math.abs(points[1][axis] - level) < EPS) {
            paths.set(route, route.points);
            continue;
          }
          // A three-point path ends on this elbow's cross-track. Its remote
          // port is fixed; let the other branches align to it instead.
          if (points.length === 3) break;
          if ((points[3][axis] - level) * (points[3][axis] - points[2][axis]) < -EPS) break;
          const p = points.map((p) => ({ ...p }));
          p[1][axis] = p[2][axis] = level;
          const path = simplify(end === "start" ? p : p.reverse());
          if (
            !outward(path, route.sides.start) ||
            !outward([...path].reverse(), route.sides.end) ||
            !valid(path, route, boxes)
          )
            break;
          paths.set(route, path);
        }
        if (paths.size !== fan.members.length) continue;
        const old = new Map([...paths].map(([r]) => [r, r.points]));
        for (const [r, path] of paths) r.points = path;
        const q = deltaQuality(routes, old, quality);
        for (const [r, path] of old) r.points = path;
        // Coordinate a whole fan without paying for extra elbows, longer
        // detours or more crossings. Other repairs keep their own objective;
        // they must not add a cosmetic zigzag to improve this preference.
        if (
          q.crossings <= bestQ.crossings &&
          q.close_parallel_length <= bestQ.close_parallel_length &&
          q.bends <= bestQ.bends &&
          q.length <= bestQ.length &&
          q.fan_bend_spread < bestQ.fan_bend_spread - EPS
        ) {
          bestQ = q;
          best = {
            kind: "fan-bend-align",
            node: fan.node.id,
            end,
            side,
            level,
            paths: [...paths].map(([r, path]) => [r.id, path]),
            before: quality,
            after: q,
          };
          if (first) return best;
        }
      }
    }
    return best;
  }
  function applyFanBend(routes, change) {
    for (const [id, points] of change.paths) {
      const r = routes.find((r) => r.id === id);
      r.points = points;
      r.start = { ...points[0] };
      r.end = { ...points.at(-1) };
    }
  }
  function endpointImprovement(routes, nodes, quality, first = false, only = null) {
    const boxes = nodes.map((n) => rect(n, CLEAR));
    let best = null,
      bestQ = quality;
    const order = [...routes].sort((a, b) => cmp(a.id, b.id));
    for (const r of order) {
      if (r.points.length === 2 || (only && r.id !== only.id)) continue;
      for (const end of ["start", "end"]) {
        if (r.manual_route || r.locked_ends?.[end]) continue;
        if (only?.end && only.end !== end) continue;
        const oriented = end === "start" ? r.points : [...r.points].reverse(),
          old = r.points,
          n = end === "start" ? r.from : r.to,
          sides =
            n.compound?.kind === "detail_group"
              ? [end === "start" ? "bottom" : "top"]
              : end === "start"
                ? ["bottom", "left", "right"]
                : ["top", "left", "right"];
        for (const side of sides)
          for (const port of slots(r, end, side, routes))
            for (const p of grafts(oriented, port, side)) {
              const path = end === "start" ? p : [...p].reverse(),
                otherSide = r.sides[end === "start" ? "end" : "start"];
              if (
                !outward(end === "start" ? [...path].reverse() : path, otherSide) ||
                !valid(path, r, boxes)
              )
                continue;
              r.points = path;
              const q = deltaQuality(routes, new Map([[r, old]]), quality);
              r.points = old;
              if (improves(q, bestQ)) {
                bestQ = q;
                best = {
                  kind: "terminal-reattach",
                  edge: r.id,
                  node: (end === "start" ? r.from : r.to).id,
                  end,
                  from_side: r.sides[end],
                  side,
                  points: path,
                  before: quality,
                  after: q,
                };
                if (first) return best;
              }
            }
      }
    }
    return best;
  }
  function applyEndpoint(routes, change) {
    const r = routes.find((r) => r.id === change.edge);
    r.points = change.points;
    r.start = { ...r.points[0] };
    r.end = { ...r.points.at(-1) };
    r.sides = { ...r.sides, [change.end]: change.side };
    r.axis =
      r.sides.start === "bottom" && r.sides.end === "top"
        ? "vertical"
        : ["left", "right"].includes(r.sides.start) &&
            ["left", "right"].includes(r.sides.end) &&
            Math.abs(r.start.y - r.end.y) < EPS
          ? "horizontal"
          : "mixed";
  }
  // A one-terminal graft cannot discover a straight edge when BOTH attachment
  // faces/slots must move. Search the common face interval explicitly, retaining
  // each semantic port and checking spacing against every other physical port.
  function directImprovement(routes, nodes, quality, first = false, only = null) {
    const boxes = nodes.map((n) => rect(n, CLEAR));
    let best = null,
      bestQ = quality;
    for (const r of [...routes].sort((a, b) => cmp(a.id, b.id))) {
      if (
        r.manual_route ||
        (r.locked_ends && (r.from.compound || r.to.compound)) ||
        (r.points.length === 2 && !r.balance_terminals) ||
        (only && r.id !== only)
      )
        continue;
      const frames = [];
      if (r.to.y - r.to.height / 2 > r.from.y + r.from.height / 2 + EPS)
        frames.push({
          axis: "vertical",
          coord: "x",
          dimension: "width",
          sides: { start: "bottom", end: "top" },
        });
      if (r.to.y + r.to.height / 2 < r.from.y - r.from.height / 2 - EPS)
        frames.push({
          axis: "upward",
          coord: "x",
          dimension: "width",
          sides: { start: "top", end: "bottom" },
        });
      if (
        !r.from.compound?.kind &&
        !r.to.compound?.kind &&
        r.to.x - r.to.width / 2 > r.from.x + r.from.width / 2 + EPS
      )
        frames.push({
          axis: "horizontal",
          coord: "y",
          dimension: "height",
          sides: { start: "right", end: "left" },
        });
      if (
        !r.from.compound?.kind &&
        !r.to.compound?.kind &&
        r.to.x + r.to.width / 2 < r.from.x - r.from.width / 2 - EPS
      )
        frames.push({
          axis: "horizontal",
          coord: "y",
          dimension: "height",
          sides: { start: "left", end: "right" },
        });
      for (const f of frames) {
        // CLEAR keeps the attachment away from rounded/sloping corners while
        // allowing two 28-unit-spaced arrows in a 66-unit face overlap.
        const a = faceRange(r.from, f.sides.start, CLEAR),
          b = faceRange(r.to, f.sides.end, CLEAR),
          lo = Math.max(a[0], b[0]),
          hi = Math.min(a[1], b[1]);
        if (lo > hi + EPS) continue;
        const occupied = [];
        for (const end of ["start", "end"]) {
          const n = end === "start" ? r.from : r.to;
          for (const other of routes)
            if (other !== r)
              for (const key of ["start", "end"])
                if (
                  (key === "start" ? other.from : other.to).id === n.id &&
                  other.sides[key] === f.sides[end]
                )
                  occupied.push(
                    other.points[key === "start" ? 0 : other.points.length - 1][f.coord],
                  );
        }
        const anchors = unique([
          lo,
          hi,
          r.from[f.coord],
          r.to[f.coord],
          r.points[0][f.coord],
          r.points.at(-1)[f.coord],
          (lo + hi) / 2,
          ...occupied.flatMap((x) => [x - SPACE, x + SPACE]),
          ...boxes.flatMap((b) => (f.coord === "x" ? [b.x, b.x + b.width] : [b.y, b.y + b.height])),
        ]).filter(
          (x) =>
            x >= lo - EPS && x <= hi + EPS && occupied.every((p) => Math.abs(x - p) >= SPACE - EPS),
        );
        for (const x of anchors) {
          const path = [
            boundaryPoint(r.from, f.sides.start, x),
            boundaryPoint(r.to, f.sides.end, x),
          ];
          if (
            ["start", "end"].some(
              (end) =>
                r.locked_ends?.[end] &&
                (r.sides[end] !== f.sides[end] ||
                  distance(
                    path[end === "start" ? 0 : 1],
                    r.points[end === "start" ? 0 : r.points.length - 1],
                  ) > EPS),
            )
          )
            continue;
          if (!valid(path, r, boxes)) continue;
          const old = r.points;
          r.points = path;
          const q = deltaQuality(routes, new Map([[r, old]]), quality);
          r.points = old;
          if (improves(q, bestQ)) {
            bestQ = q;
            best = {
              kind: "direct-connection",
              node: r.from.id,
              to_node: r.to.id,
              edge: r.id,
              from_sides: { ...r.sides },
              sides: f.sides,
              axis: f.axis,
              points: path,
              before: quality,
              after: q,
            };
            if (first) return best;
          }
        }
      }
    }
    return best;
  }
  function applyDirect(routes, change) {
    const r = routes.find((r) => r.id === change.edge);
    r.points = change.points;
    r.start = { ...r.points[0] };
    r.end = { ...r.points.at(-1) };
    r.sides = { ...change.sides };
    r.axis = change.axis;
  }
  function simplifyDraft(layout) {
    let quality = analyze(layout.edges);
    for (let i = 0; i < layout.edges.length; i++) {
      const change = directImprovement(layout.edges, layout.nodes, quality, true);
      if (!change) break;
      applyDirect(layout.edges, change);
      quality = analyze(layout.edges);
    }
  }
  function trackImprovement(routes, nodes, quality, first = false, bounds = null) {
    const boxes = nodes.map((n) => rect(n, CLEAR));
    let best = null,
      bestQ = quality;
    for (const r of [...routes].sort((a, b) => cmp(a.id, b.id))) {
      if (r.manual_route) continue;
      const old = r.points,
        rest = routes.filter((e) => e !== r).flatMap((e) => segments(e.points));
      for (const segment of segments(old)) {
        if (
          segment.i === 0 ||
          segment.i === old.length - 2 ||
          !rest.some((s) => {
            const q = parallel(segment, s);
            return q && q.gap < SPACE - EPS && q.overlap >= 60;
          })
        )
          continue;
        const vertical = Math.abs(segment.a.x - segment.b.x) < EPS,
          coord = vertical ? "x" : "y",
          values = unique([
            segment.a[coord] - SPACE,
            segment.a[coord] + SPACE,
            ...rest
              .filter((s) =>
                vertical ? Math.abs(s.a.x - s.b.x) < EPS : Math.abs(s.a.y - s.b.y) < EPS,
              )
              .flatMap((s) => [s.a[coord] - SPACE, s.a[coord] + SPACE]),
          ]).filter(
            (x) =>
              x >= 12 &&
              x <=
                (bounds
                  ? (vertical ? bounds.width + SPACE : bounds.height) - 12
                  : vertical
                    ? Math.max(...routes.flatMap((r) => r.points.map((p) => p.x)))
                    : Math.max(...routes.flatMap((r) => r.points.map((p) => p.y)))),
          );
        for (const value of values) {
          const p = old.map((p) => ({ ...p }));
          p[segment.i][coord] = value;
          p[segment.i + 1][coord] = value;
          const path = simplify(p);
          if (
            !outward(path, r.sides.start) ||
            !outward([...path].reverse(), r.sides.end) ||
            !valid(path, r, boxes)
          )
            continue;
          r.points = path;
          const q = deltaQuality(routes, new Map([[r, old]]), quality);
          r.points = old;
          if (improves(q, bestQ)) {
            bestQ = q;
            best = {
              kind: "track-separate",
              node: r.from.id,
              edge: r.id,
              side: r.sides.start,
              end: "start",
              points: path,
              before: quality,
              after: q,
            };
            if (first) return best;
          }
        }
      }
    }
    return best;
  }
  const nodeCandidateBudget = (layout) => layout.nodes.length > 40 ? 12 : 36;
  function nodeCandidates(layout, routes) {
    if (!layout.compact && !layout.flow_tree) return [];
    const legacy = layout.conservative_node_search || layout.preserve_draft_geometry,
      candidates = [], budget = legacy ? Infinity : nodeCandidateBudget(layout),
      scores = new Map(routes.map((r) => [r.id, Math.max(0, r.points.length - 2)]));
    if (!legacy) for (let i = 0; i < routes.length; i++) for (let j = i + 1; j < routes.length; j++) {
      const q = pairEvents(routes[i], routes[j]), weight = q.crossings.length * 1000000 + q.overlap * 100;
      if (weight) for (const r of [routes[i], routes[j]]) scores.set(r.id, scores.get(r.id) + weight);
    }
    const priority = (n) => routes.reduce((total, r) => total + (r.to === n ? 2 : r.from === n ? 1 : 0) * scores.get(r.id), 0);
    for (const n of [...layout.nodes].sort((a, b) => (legacy ? 0 : priority(b) - priority(a)) || a.y - b.y || cmp(a.id, b.id))) {
      if (legacy && layout.flow_tree && !mayOptimizePosition(n.node)) continue;
      if (
        n.fixed || n.node?.fixed || n.node?.layout?.optimizePosition === false || (!legacy && n.compound) ||
        n.node?.swimlane ||
        ((!layout.flow_tree || layout.comparison_lanes) && n.node?.status === "shared") ||
        (layout.compact &&
          layout.nodes.some(
            (p) =>
              p !== n &&
              p.compact_band === n.compact_band &&
              p.compact_row === n.compact_row &&
              p.node?.status === n.node?.status,
          ))
      )
        continue;
      const adjacent = routes.filter((r) => r.from === n || r.to === n),
        neighbors = adjacent.map((r) => (r.from === n ? r.to : r.from)),
        lane = layout.comparison_lanes?.lanes.find((l) => l.id === n.node?.status),
        peers = layout.nodes.filter((p) => p !== n && Math.abs(n.y - p.y) < (n.height + p.height) / 2 + CLEAR),
        lo = Math.max(lane ? lane.left + n.width / 2 : 56 + n.width / 2, ...(legacy ? [] : peers.filter((p) => p.x < n.x).map((p) => p.x + (n.width + p.width) / 2 + CLEAR))),
        hi = Math.min(lane ? lane.right - n.width / 2 : layout.width - 56 - n.width / 2, ...(legacy ? [] : peers.filter((p) => p.x >= n.x).map((p) => p.x - (n.width + p.width) / 2 - CLEAR)));
      if (!adjacent.length || adjacent.some((r) => r.manual_route || (r.from === n && r.locked_ends?.start) || (r.to === n && r.locked_ends?.end)) || (!legacy && adjacent.every((r) => r.points.length === 2 && !scores.get(r.id)))) continue;
      const parents = adjacent.filter((r) => r.to === n).map((r) => r.from.x);
      if (legacy && layout.flow_tree && parents.length < 2) continue;
      const ordered = [...parents].sort((a, b) => a - b),
        middle = ordered.length
          ? (ordered[Math.floor((ordered.length - 1) / 2)] +
              ordered[Math.floor(ordered.length / 2)]) /
            2
          : n.x,
        anchors = legacy
          ? unique([...neighbors.map((p) => p.x), middle])
          : unique([...neighbors.map((p) => p.x), middle, n.x - SPACE, n.x + SPACE,
              n.x - Math.max(SPACE, n.width / 2 - SPACE), n.x + Math.max(SPACE, n.width / 2 - SPACE)])
            .sort((a, b) => Math.abs(a - n.x) - Math.abs(b - n.x) || a - b).slice(0, 8);
      for (const x of anchors)
        if (
          Math.abs(x - n.x) > EPS &&
          x >= lo - EPS &&
          x <= hi + EPS &&
          !layout.nodes.some(
            (p) =>
              p !== n &&
              Math.abs(x - p.x) < (n.width + p.width) / 2 + CLEAR &&
              Math.abs(n.y - p.y) < (n.height + p.height) / 2 + CLEAR,
          )
        )
          candidates.push({ n, x });
      if (candidates.length >= budget) break;
    }
    return candidates.slice(0, budget);
  }
  // A downstream move can require both physical ports and the intermediate
  // horizontal channel to change together. Bound the samples on each face and
  // in the gap; the semantic endpoints remain the original edge endpoints.
  function jointCorridors(r, path, routes, boxes) {
    if (r.sides.start !== "bottom" || r.sides.end !== "top" || r.from.compound || r.to.compound || r.locked_ends?.start || r.locked_ends?.end) return [];
    const sampleSlots = (end, otherX) => {
      const node = end === "start" ? r.from : r.to,
        side = end === "start" ? "bottom" : "top",
        [lo, hi] = faceRange(node, side, 26),
        existing = path[end === "start" ? 0 : path.length - 1],
        available = slots(r, end, side, routes),
        occupied = routes.flatMap((other) => ["start", "end"].filter((key) =>
          other !== r && (key === "start" ? other.from : other.to) === node && other.sides[key] === side,
        ).map((key) => other.points[key === "start" ? 0 : other.points.length - 1].x));
      const otherNode = end === "start" ? r.to : r.from,
        [otherLo, otherHi] = faceRange(otherNode, end === "start" ? "top" : "bottom", 26),
        sharedLo = Math.max(lo, otherLo), sharedHi = Math.min(hi, otherHi),
        shared = sharedLo <= sharedHi ? (sharedLo + sharedHi) / 2 : otherX;
      for (const value of [lo + (hi - lo) / 4, lo + 3 * (hi - lo) / 4, otherX, shared])
        if (value >= lo - EPS && value <= hi + EPS && occupied.every((x) => Math.abs(x - value) >= SPACE - EPS)) available.push(boundaryPoint(node, side, value));
      const wishes = [existing.x, otherX, shared, lo + (hi - lo) / 4, lo + 3 * (hi - lo) / 4], result = [];
      for (const wish of wishes) {
        const best = [...available].sort((a, b) => Math.abs(a.x - wish) - Math.abs(b.x - wish) || a.x - b.x)[0];
        if (best && !result.some((p) => distance(p, best) < EPS)) result.push(best);
      }
      return result.slice(0, 5);
    };
    const start = sampleSlots("start", path.at(-1).x), end = sampleSlots("end", path[0].x), result = [];
    for (const s of start) for (const t of end) {
      if (t.y - s.y < 2 * CLEAR) continue;
      const ys = unique([(s.y + t.y) / 2, s.y + STUB, t.y - STUB, s.y + (t.y - s.y) / 4, s.y + 3 * (t.y - s.y) / 4]);
      for (const y of ys) {
        if (y <= s.y + EPS || y >= t.y - EPS) continue;
        const candidate = simplify([s, { x: s.x, y }, { x: t.x, y }, t]);
        if (valid(candidate, r, boxes) && outward(candidate, "bottom") && outward([...candidate].reverse(), "top")) result.push(candidate);
      }
    }
    return result;
  }
  function nodeImprovement(layout, routes, quality, first = false) {
    let best = null,
      bestQ = quality;
    for (const { n, x } of nodeCandidates(layout, routes)) {
      const oldX = n.x,
        dx = x - oldX,
        affected = routes.filter((r) => r.from === n || r.to === n),
        saved = new Map(affected.map((r) => [r, r.points]));
      n.x = x;
      const boxes = layout.nodes.map((n) => rect(n, CLEAR));
      if (routes.some((r) => !affected.includes(r) && !valid(r.points, r, boxes))) {
        n.x = oldX;
        continue;
      }
      let feasible = true;
      for (const r of affected) {
        let p = saved.get(r);
        for (const end of ["start", "end"])
          if ((end === "start" ? r.from : r.to) === n) {
            const oriented = end === "start" ? p : [...p].reverse(),
              port = { ...oriented[0], x: oriented[0].x + dx },
              side = r.sides[end],
              rest = routes.filter((e) => e !== r).flatMap((e) => segments(e.points));
            let chosen = null,
              cost = Infinity;
            for (const candidate of grafts(oriented, port, side)) {
              const path = end === "start" ? candidate : [...candidate].reverse();
              if (
                !valid(path, r, boxes) ||
                !outward(path, r.sides.start) ||
                !outward([...path].reverse(), r.sides.end)
              )
                continue;
              const c = routeCost(path, rest);
              if (c < cost - EPS) {
                cost = c;
                chosen = path;
              }
            }
            if (!chosen) {
              if (!layout.conservative_node_search && !layout.preserve_draft_geometry && end === "end" && r.sides.start === "bottom" && side === "top" && !r.locked_ends?.start && !r.locked_ends?.end) {
                const placeholder = [...oriented];
                placeholder[0] = port;
                chosen = placeholder.reverse();
              } else {
                feasible = false;
                break;
              }
            }
            p = chosen;
          }
        if (!feasible) break;
        // Jointly reattach an upstream physical output after moving a downstream
        // node. Keep semantic port identities unchanged; only geometry varies.
        if (!layout.conservative_node_search && !layout.preserve_draft_geometry && r.to === n && r.from !== n && !r.manual_route && !r.locked_ends?.start) {
          r.points = p;
          const rest = routes.filter((e) => e !== r).flatMap((e) => segments(e.points)),
            side = r.sides.start,
            coord = side === "top" || side === "bottom" ? "x" : "y",
            target = p.at(-1)[coord],
            options = slots(r, "start", side, routes)
              .sort((a, b) => Math.abs(a[coord] - target) - Math.abs(b[coord] - target) || a[coord] - b[coord])
              .slice(0, 3);
          let cost = valid(p, r, boxes) && outward(p, r.sides.start) && outward([...p].reverse(), r.sides.end) ? routeCost(p, rest) : Infinity, chosen = p;
          for (const port of options) for (const path of grafts(p, port, side)) {
            if (!valid(path, r, boxes) || !outward([...path].reverse(), r.sides.end)) continue;
            const c = routeCost(path, rest);
            if (c < cost - EPS) { chosen = path; cost = c; }
          }
          // Other incident routes not yet visited will move with the node;
          // expose their translated endpoints while checking occupied slots.
          const pending = affected.filter((other) => other !== r && other.points === saved.get(other)).map((other) => {
            const old = other.points, points = old.map((point) => ({ ...point }));
            if (other.from === n) points[0].x += dx;
            if (other.to === n) points[points.length - 1].x += dx;
            other.points = points;
            return [other, old];
          });
          for (const path of jointCorridors(r, p, routes, boxes)) {
            const c = routeCost(path, rest);
            if (c < cost - EPS) { chosen = path; cost = c; }
          }
          for (const [other, old] of pending) other.points = old;
          if (!Number.isFinite(cost)) { feasible = false; break; }
          p = chosen;
        }
        r.points = p;
      }
      if (feasible) {
        const q = deltaQuality(routes, saved, quality);
        if (improves(q, bestQ)) {
          bestQ = q;
          best = {
            kind: "node-align",
            node: n.id,
            from_x: oldX,
            x,
            paths: new Map(affected.map((r) => [r.id, r.points])),
            before: quality,
            after: q,
          };
        }
      }
      n.x = oldX;
      for (const [r, p] of saved) r.points = p;
      if (best && first) return best;
    }
    return best;
  }
  function applyNode(layout, routes, change) {
    layout.nodes.find((n) => n.id === change.node).x = change.x;
    for (const [id, p] of change.paths) {
      const r = routes.find((r) => r.id === id);
      r.points = p;
      r.start = { ...p[0] };
      r.end = { ...p.at(-1) };
    }
  }
  function qualityRoutes(layout, graph) {
    const by = new Map(layout.nodes.map((n) => [n.id, n]));
    return groupEdges(graph, layout)
      .map((r) => ({
        ...r,
        from: by.get(nodeId(r.edge.from)),
        to: by.get(nodeId(r.edge.to)),
        points: r.members[0].points.map((p) => ({ ...p })),
        sides: { ...r.members[0].sides },
        axis: r.members[0].axis,
        manual_route: r.members[0].manual_route,
        locked_ends: r.members[0].locked_ends,
        balance_terminals: !!layout.flow_tree,
      }))
      .map((r) => ({ ...r, start: r.points[0], end: r.points.at(-1) }));
  }
  function syncRoutes(layout, routes) {
    for (const r of routes)
      for (const ed of r.members) {
        ed.points = r.points.map((p) => ({ ...p }));
        ed.start = { ...ed.points[0] };
        ed.end = { ...ed.points.at(-1) };
        ed.axis = r.axis;
        ed.sides = { ...r.sides };
      }
  }
  function issue(change) {
    const {
      kind,
      node,
      to_node,
      edge,
      end,
      from_side,
      side,
      from_sides,
      sides,
      from_x,
      x,
      level,
      before,
      after,
    } = change;
    return {
      rule:
        kind === "direct-connection"
          ? "avoidable-direct-connection"
          : kind === "node-align"
            ? "avoidable-row-offset"
            : kind === "fan-bend-align"
              ? "uncoordinated-fan-bends"
              : kind === "track-separate"
                ? "crowded-track"
                : "avoidable-terminal-detour",
      node,
      to_node,
      edge,
      end,
      from_side,
      to_side: side,
      from_sides,
      to_sides: sides,
      from_x,
      to_x: x,
      bend_level: level,
      before: {
        crossings: before.crossings,
        close_parallel_length: before.close_parallel_length,
        bends: before.bends,
        length: before.length,
        ...(before.fan_bend_spread !== undefined
          ? { fan_bend_spread: before.fan_bend_spread }
          : {}),
      },
      after: {
        crossings: after.crossings,
        close_parallel_length: after.close_parallel_length,
        bends: after.bends,
        length: after.length,
        ...(after.fan_bend_spread !== undefined ? { fan_bend_spread: after.fan_bend_spread } : {}),
      },
    };
  }
  function qualityLint(layout, graph) {
    if (!layout.compact && !layout.flow_tree) return [];
    const routes = qualityRoutes(layout, graph),
      quality = analyze(routes),
      direct = directImprovement(routes, layout.nodes, quality, true),
      terminal = endpointImprovement(routes, layout.nodes, quality, true),
      fan = fanBendImprovement(routes, layout.nodes, quality, true),
      node = nodeImprovement(layout, routes, quality, true),
      track = trackImprovement(routes, layout.nodes, quality, true, layout);
    return [
      ...[direct, terminal, fan, node, track].filter(Boolean).map(issue),
      ...alignmentLint(layout),
    ];
  }
  function optimizeQuality(layout, graph) {
    const routes = qualityRoutes(layout, graph),
      changes = [];
    let quality = analyze(routes),
      sweeps = 0;
    const sweepLimit = Math.max(3, Math.min(12, routes.length + 1));
    // Revisit the complete neighborhood after changes: fixing one terminal can
    // expose a new direct or terminal repair at the other end. Stop on stability,
    // with an explicit work bound and remaining-issue report for dense graphs.
    for (; sweeps < sweepLimit; sweeps++) {
      let count = 0;
      for (const r of [...routes].sort((a, b) => cmp(a.id, b.id))) {
        const chosen = directImprovement(routes, layout.nodes, quality, false, r.id);
        if (!chosen) continue;
        applyDirect(routes, chosen);
        quality = analyze(routes);
        changes.push(issue({ ...chosen, after: quality }));
        count++;
      }
      for (const r of [...routes].sort((a, b) => cmp(a.id, b.id)))
        for (const end of ["start", "end"]) {
          const chosen = endpointImprovement(routes, layout.nodes, quality, false, {
            id: r.id,
            end,
          });
          if (!chosen) continue;
          applyEndpoint(routes, chosen);
          quality = analyze(routes);
          changes.push(issue({ ...chosen, after: quality }));
          count++;
        }
      const track = trackImprovement(routes, layout.nodes, quality, false, layout);
      if (track) {
        applyEndpoint(routes, track);
        quality = analyze(routes);
        changes.push(issue({ ...track, after: quality }));
        count++;
      }
      const node = nodeImprovement(layout, routes, quality);
      if (node) {
        applyNode(layout, routes, node);
        quality = analyze(routes);
        changes.push(issue({ ...node, after: quality }));
        count++;
      }
      if (!count) break;
    }
    // Close the new direct-connection neighborhood after terminal/node changes.
    // Each accepted edge becomes a locked two-point path, so at most |E| repairs.
    for (let i = 0; i < routes.length; i++) {
      const chosen = directImprovement(routes, layout.nodes, quality, true);
      if (!chosen) break;
      applyDirect(routes, chosen);
      quality = analyze(routes);
      changes.push(issue({ ...chosen, after: quality }));
    }
    // Finish with joint fan repairs, after per-edge shortening has stabilized.
    // Every accepted move strictly lowers the total elbow spread, so opposite
    // ends cannot oscillate; the work bound and lint report remain explicit.
    for (let i = 0; i < routes.length; i++) {
      const fan = fanBendImprovement(routes, layout.nodes, quality);
      if (!fan) break;
      applyFanBend(routes, fan);
      quality = analyze(routes);
      changes.push(issue({ ...fan, after: quality }));
    }
    syncRoutes(layout, routes);
    layout.width = Math.max(layout.width, ...routes.flatMap((r) => r.points.map((p) => p.x + 24)));
    const lint = qualityLint(layout, graph);
    layout.routing = {
      ...layout.routing,
      algorithm: "orthogonal-clearance-v5",
      quality_optimizer: {
        sweeps: Math.min(sweeps + 1, sweepLimit),
        sweep_limit: sweepLimit,
        direct_repair_budget: routes.length,
        fan_repair_budget: routes.length,
        node_candidate_budget_per_sweep: layout.conservative_node_search || layout.preserve_draft_geometry ? null : nodeCandidateBudget(layout),
        changes,
        remaining: lint,
      },
      ...analyze(routes),
    };
    return layout;
  }
  function routeOnce(layout, graph, longFirst = false) {
    const routes = groupEdges(graph, layout);
    terminals(layout, routes);
    const boxes = layout.nodes.map((n) => rect(n, CLEAR)),
      span = (r) => (r.axis === "horizontal" ? Math.abs(r.end.x - r.start.x) : r.end.y - r.start.y);
    routes.sort(
      (a, b) =>
        (span(a) - span(b)) * (longFirst ? -1 : 1) ||
        Math.abs(a.end.x - a.start.x) - Math.abs(b.end.x - b.start.x) ||
        cmp(a.id, b.id),
    );
    let reserved = [];
    for (const r of routes) {
      const options = optionsFor(r, layout, boxes, reserved);
      let best = null,
        cost = Infinity;
      for (const p of options) {
        const c = routeCost(p, reserved);
        if (c < cost - EPS) {
          cost = c;
          best = p;
        }
      }
      r.points =
        best ||
        (layout.tree_levels === "compact"
          ? anchoredRoute(r, layout, reserved)
          : fallbackFor(r, layout, boxes, reserved));
      reserved = reserved.concat(segments(r.points));
    }
    // One bounded rip-up pass: reconsider the congested routes against the whole
    // drawing rather than preserving the arbitrary first routed edge's priority.
    const congested = [...routes]
      .map((r) => ({
        r,
        weight: routes.reduce(
          (s, b) =>
            b === r ? s : s + pairEvents(r, b).crossings.length * 100 + pairEvents(r, b).near * 30,
          0,
        ),
      }))
      .filter((x) => x.weight > 0)
      .sort((a, b) => b.weight - a.weight || cmp(a.r.id, b.r.id));
    for (const { r } of congested) {
      const rest = routes.filter((x) => x !== r).flatMap((x) => segments(x.points)),
        old = routeCost(r.points, rest);
      let best = r.points,
        cost = old;
      for (const p of optionsFor(r, layout, boxes, rest)) {
        const c = routeCost(p, rest);
        if (c < cost - EPS) {
          cost = c;
          best = p;
        }
      }
      r.points = best;
    }
    const portSwaps = optimizePorts(routes, layout.nodes),
      straightened = straighten(routes, layout.nodes);
    for (const r of routes)
      for (const ed of r.members) {
        ed.points = r.points.map((p) => ({ ...p }));
        ed.rerouted = true;
        ed.axis = r.axis;
        ed.sides = r.sides;
      }
    layout.routing = {
      algorithm: "orthogonal-clearance-v3",
      track_spacing: SPACE,
      node_clearance: CLEAR,
      port_swaps: portSwaps,
      straightened,
      ...analyze(routes),
    };
    return layout;
  }
  function alignCompactRows(layout) {
    if (!layout.compact) return [];
    const by = new Map(layout.nodes.map((n) => [n.id, n])),
      changes = [];
    for (const n of [...layout.nodes].sort((a, b) => a.y - b.y || cmp(a.id, b.id))) {
      if (
        n.fixed || n.node?.fixed || n.node?.layout?.optimizePosition === false ||
        n.node?.swimlane ||
        n.node?.status === "shared" ||
        layout.nodes.some(
          (p) =>
            p !== n &&
            p.compact_band === n.compact_band &&
            p.compact_row === n.compact_row &&
            p.node?.status === n.node?.status,
        )
      )
        continue;
      const parents = layout.edges
          .filter((e) => nodeId(e.edge.to) === n.id)
          .map((e) => by.get(nodeId(e.edge.from)))
          .filter((p) => p.node?.status === n.node?.status && p.y < n.y),
        anchors = unique(parents.map((p) => p.x));
      if (!anchors.length) continue;
      const values = parents.map((p) => p.x).sort((a, b) => a - b),
        x = values[Math.floor((values.length - 1) / 2)],
        lane = layout.comparison_lanes?.lanes.find((l) => l.id === n.node?.status),
        lo = lane ? lane.left + n.width / 2 : 56 + n.width / 2,
        hi = lane ? lane.right - n.width / 2 : layout.width - 56 - n.width / 2,
        cost = (x) => parents.reduce((s, p) => s + Math.abs(p.x - x), 0);
      if (
        x < lo - EPS ||
        x > hi + EPS ||
        cost(x) >= cost(n.x) - EPS ||
        layout.nodes.some(
          (p) =>
            p !== n &&
            Math.abs(x - p.x) < (n.width + p.width) / 2 + CLEAR &&
            Math.abs(n.y - p.y) < (n.height + p.height) / 2 + CLEAR,
        )
      )
        continue;
      changes.push({ rule: "parent-median-alignment", node: n.id, from_x: n.x, to_x: x });
      n.x = x;
    }
    return changes;
  }
  function alignmentLint(layout) {
    const candidate = { ...layout, nodes: layout.nodes.map((n) => ({ ...n })) };
    return alignCompactRows(candidate).map((c) => ({
      ...c,
      rule: "row-input-misalignment",
      requires_rerouting: true,
      scope:
        "Parent-center distance decreases inside the original lane; reroute before comparing full wire quality.",
    }));
  }
  function alignHintedSpines(layout, graph) {
    if (!layout.flow_tree || layout.tree_levels === "compact") return [];
    const changes = [],
      jobs = layout.edges.filter((r) => prefersStraight(r.edge));
    for (const edge of jobs) {
      if (
        edge.points.length < 3 ||
        edge.from.compound ||
        edge.to.compound ||
        edge.to.fixed || edge.to.node?.fixed || edge.to.node?.layout?.optimizePosition === false ||
        edge.to.node?.swimlane || layout.comparison_lanes ||
        edge.from.y >= edge.to.y
      )
        continue;
      const n = edge.to,
        x = edge.points[0].x - (edge.points.at(-1).x - n.x),
        oldX = n.x;
      if (
        Math.abs(x - oldX) < SPACE ||
        x - n.width / 2 < 56 ||
        x + n.width / 2 > layout.width - 56 ||
        layout.nodes.some(
          (p) =>
            p !== n &&
            Math.abs(p.x - x) < (p.width + n.width) / 2 + CLEAR &&
            Math.abs(p.y - n.y) < (p.height + n.height) / 2 + CLEAR,
        )
      )
        continue;
      const saved = {
          nodes: layout.nodes.map((p) => ({ node: p, x: p.x })),
          edges: layout.edges.map((r) => ({ ...r })),
          routing: layout.routing,
        },
        before = analyze(layout.edges);
      n.x = x;
      try {
        routeOnce(layout, graph);
        optimizeQuality(layout, graph);
        const after = analyze(layout.edges);
        if (
          after.crossings > before.crossings ||
          after.close_parallel_length > before.close_parallel_length ||
          after.bends >= before.bends ||
          after.length > before.length
        )
          throw Error("no improvement");
        changes.push({
          rule: "hinted-straight-spine",
          node: n.id,
          from_x: oldX,
          to_x: x,
          before: { bends: before.bends, crossings: before.crossings },
          after: { bends: after.bends, crossings: after.crossings },
        });
      } catch {
        for (const p of saved.nodes) p.node.x = p.x;
        layout.edges.forEach((r, i) => Object.assign(r, saved.edges[i]));
        layout.routing = saved.routing;
      }
    }
    return changes;
  }
  function fanCentroids(layout) {
    const by = new Map(layout.nodes.map((n) => [n.id, n]));
    return layout.nodes
      .map((n) => {
        const ids = [
            ...new Set(
              layout.edges
                .filter((e) => nodeId(e.edge.from) === n.id)
                .map((e) => nodeId(e.edge.to)),
            ),
          ].filter((id) => by.has(id) && id !== n.id),
          children = ids.map((id) => by.get(id)),
          mean = children.length ? children.reduce((s, p) => s + p.x, 0) / children.length : n.x,
          span = children.length
            ? Math.max(...children.map((p) => p.x)) - Math.min(...children.map((p) => p.x))
            : 0;
        return {
          node: n.id,
          children: ids,
          x: n.x,
          mean,
          error: Math.abs(n.x - mean),
          tolerance: Math.max(SPACE, Math.min(SPACE * 2, span * 0.04)),
        };
      })
      .filter((f) => f.children.length > 1);
  }
  function balanceFans(layout, graph) {
    if (!layout.flow_tree) return [];
    const original = fanCentroids(layout),
      error = (fs) => fs.reduce((s, f) => s + Math.max(0, f.error - f.tolerance), 0),
      saved = {
        nodes: layout.nodes.map((n) => ({ node: n, x: n.x })),
        edges: layout.edges.map((r) => ({ ...r })),
        routing: layout.routing,
      },
      before = analyze(layout.edges),
      proposals = [];
    // One bounded batch, with a feasible interval that preserves peer order.
    // No fan equality becomes a new graph constraint or changes a rank.
    for (const f of [...original].sort(
      (a, b) =>
        layout.nodes.find((n) => n.id === b.node).y - layout.nodes.find((n) => n.id === a.node).y ||
        cmp(a.node, b.node),
    )) {
      if (f.error <= f.tolerance) continue;
      const n = layout.nodes.find((n) => n.id === f.node),
        lane = layout.comparison_lanes?.lanes.find((l) => l.id === n.node?.status);
      if (n.fixed || n.node?.fixed || n.node?.layout?.optimizePosition === false || n.node?.swimlane || n.compound || n.node?.status === "shared") continue;
      let lo = (lane?.left || 56) + n.width / 2,
        hi = (lane?.right || layout.width - 56) - n.width / 2;
      for (const p of layout.nodes.filter(
        (p) => p !== n && Math.abs(p.y - n.y) < (p.height + n.height) / 2 + CLEAR,
      )) {
        if (p.x < n.x) lo = Math.max(lo, p.x + (p.width + n.width) / 2 + CLEAR);
        else hi = Math.min(hi, p.x - (p.width + n.width) / 2 - CLEAR);
      }
      if (lo > hi) continue;
      const target =
          f.children.reduce((s, id) => s + layout.nodes.find((p) => p.id === id).x, 0) /
          f.children.length,
        x = Math.max(lo, Math.min(hi, target));
      if (Math.abs(x - n.x) < SPACE) continue;
      proposals.push({ rule: "fan-centroid-preference", node: n.id, from_x: n.x, to_x: x });
      n.x = x;
    }
    let accepted = false,
      reason = "已在容差内或被同层节点限制";
    if (proposals.length) {
      try {
        routeOnce(layout, graph);
        optimizeQuality(layout, graph);
        const after = analyze(layout.edges),
          next = fanCentroids(layout),
          oldError = error(original),
          newError = error(next),
          preserved = saved.edges.every(
            (r, i) => r.points.length !== 2 || layout.edges[i].points.length === 2,
          ),
          preservedFans = original.every(
            (f) =>
              f.error > f.tolerance ||
              next.some((p) => p.node === f.node && p.error <= p.tolerance),
          );
        accepted =
          newError < oldError &&
          after.crossings <= before.crossings &&
          after.close_parallel_length <= before.close_parallel_length &&
          after.bends <= before.bends &&
          preserved &&
          preservedFans &&
          after.length <= before.length * 1.03 &&
          after.length + 0.6 * newError < before.length + 0.6 * oldError;
        reason = accepted
          ? "重心偏好改善且通过完整路由检查"
          : "重心偏好让位于直连、避障、交叉或线长预算";
      } catch {
        reason = "候选通道不可行，保留原布局";
      }
    }
    if (!accepted) {
      for (const p of saved.nodes) p.node.x = p.x;
      layout.edges.forEach((r, i) => Object.assign(r, saved.edges[i]));
      layout.routing = saved.routing;
    }
    const after = analyze(layout.edges),
      parents = fanCentroids(layout);
    layout.routing.fan_balance = {
      soft: true,
      accepted,
      reason,
      parents,
      before: {
        error: error(original),
        crossings: before.crossings,
        bends: before.bends,
        length: before.length,
      },
      after: {
        error: error(parents),
        crossings: after.crossings,
        bends: after.bends,
        length: after.length,
      },
    };
    return accepted
      ? proposals.map((p) => ({ ...p, to_x: layout.nodes.find((n) => n.id === p.node).x }))
      : [];
  }
  function route(layout, graph) {
    layout.preserve_draft_geometry = !!graph.preserve_draft_geometry;
    // Finish the existing routing lifecycle before exploring the wider local
    // neighborhood. No later reroute may invalidate the baseline comparison.
    layout.conservative_node_search = true;
    const alignments = alignCompactRows(layout);
    routeOnce(layout, graph);
    if (layout.nodes.length <= 25) {
      const first = layout.edges.map((e) => ({ points: e.points, axis: e.axis, sides: e.sides })),
        quality = layout.routing;
      routeOnce(layout, graph, true);
      const alternate = layout.routing;
      if (
        alternate.crossings > quality.crossings ||
        alternate.close_parallel_length > quality.close_parallel_length ||
        (alternate.crossings === quality.crossings &&
          alternate.close_parallel_length === quality.close_parallel_length &&
          alternate.length >= quality.length)
      ) {
        layout.edges.forEach((e, i) => Object.assign(e, first[i]));
        layout.routing = quality;
      } else layout.routing.order = "long-first";
    }
    if (layout.compact || layout.flow_tree) optimizeQuality(layout, graph);
    const spines = alignHintedSpines(layout, graph);
    const fans = balanceFans(layout, graph);
    layout.routing.node_alignments = [...alignments, ...spines, ...fans];
    layout.conservative_node_search = false;
    if (!layout.preserve_draft_geometry && (layout.compact || layout.flow_tree)) {
      const routes = qualityRoutes(layout, graph), before = analyze(routes),
        positions = layout.nodes.map((node) => ({ node, x: node.x })), changes = [];
      let after = before, accepted = false;
      try {
        for (let i = 0; i < 3; i++) {
          const change = nodeImprovement(layout, routes, after);
          if (!change) break;
          applyNode(layout, routes, change);
          after = analyze(routes);
          changes.push(issue({ ...change, after }));
        }
        accepted = changes.length > 0 && improves(after, before);
      } catch {
        accepted = false;
      }
      if (accepted) {
        syncRoutes(layout, routes);
        layout.routing = { ...layout.routing, ...after };
      } else {
        for (const saved of positions) saved.node.x = saved.x;
        after = before;
      }
      layout.routing.post_node_search = {
        accepted, candidate_budget_per_pass: nodeCandidateBudget(layout), pass_limit: 3,
        before: { crossings: before.crossings, close_parallel_length: before.close_parallel_length, bends: before.bends, length: before.length },
        after: { crossings: after.crossings, close_parallel_length: after.close_parallel_length, bends: after.bends, length: after.length },
        changes: accepted ? changes : [],
      };
    } else layout.routing.post_node_search = { accepted: false, skipped: layout.preserve_draft_geometry ? "draft" : "layout" };
    delete layout.conservative_node_search;
    return layout;
  }
  function bridges(routes, nodes = []) {
    const events = analyze(routes).events,
      by = new Map(routes.map((r) => [r.id, r])),
      assigned = new Map(routes.map((r) => [r.id, []])),
      seen = new Set();
    let missed = 0;
    for (const cross of events) {
      const a = by.get(cross.a),
        b = by.get(cross.b),
        options = [];
      for (const r of [a, b])
        for (const seg of segments(r.points)) {
          if (!hitPoint(cross, seg)) continue;
          const room = Math.min(distance(cross, seg.a), distance(cross, seg.b));
          if (room >= 5) options.push({ r, seg, room });
        }
      options.sort(
        (a, b) =>
          (Math.abs(a.seg.a.y - a.seg.b.y) < EPS ? -1 : 1) -
            (Math.abs(b.seg.a.y - b.seg.b.y) < EPS ? -1 : 1) ||
          b.room - a.room ||
          cmp(a.r.id, b.r.id),
      );
      const option = options.find(({ r, seg, room }) => {
        const radius = Math.min(9, room - 1),
          horizontal = Math.abs(seg.a.y - seg.b.y) < EPS,
          area = {
            x: cross.x - radius - 3,
            y: cross.y - radius - 3,
            width: radius * 2 + 6,
            height: radius * 2 + 6,
          };
        return (
          !nodes.some((n) => {
            const b = rect(n, 3);
            return (
              area.x < b.x + b.width &&
              area.x + area.width > b.x &&
              area.y < b.y + b.height &&
              area.y + area.height > b.y
            );
          }) && !assigned.get(r.id).some((p) => distance(p, cross) < radius * 2 + 4)
        );
      });
      if (!option) {
        missed++;
        continue;
      }
      const { r, seg, room } = option,
        key = r.id + "|" + cross.x.toFixed(3) + "," + cross.y.toFixed(3);
      if (seen.has(key)) continue;
      seen.add(key);
      assigned.get(r.id).push({ ...cross, segment: seg.i, radius: Math.min(9, room - 1) });
    }
    return { assigned, missed, crossings: events.length };
  }
  function hitPoint(p, s) {
    return (
      Math.abs((p.x - s.a.x) * (s.b.y - s.a.y) - (p.y - s.a.y) * (s.b.x - s.a.x)) < EPS &&
      p.x >= Math.min(s.a.x, s.b.x) - EPS &&
      p.x <= Math.max(s.a.x, s.b.x) + EPS &&
      p.y >= Math.min(s.a.y, s.b.y) - EPS &&
      p.y <= Math.max(s.a.y, s.b.y) + EPS
    );
  }
  function path(points, jumps = [], offsetY = 0) {
    const f = (n) => Number(n.toFixed(3)),
      P = (p) => f(p.x) + " " + f(p.y + offsetY);
    let out = "M" + P(points[0]),
      overlays = [];
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1],
        b = points[i],
        horizontal = Math.abs(a.y - b.y) < EPS,
        sign = horizontal ? Math.sign(b.x - a.x) : Math.sign(b.y - a.y),
        events = jumps
          .filter((j) => j.segment === i - 1)
          .sort((u, v) => distance(a, u) - distance(a, v));
      for (const j of events) {
        const r = j.radius,
          start = { x: j.x - (horizontal ? sign * r : 0), y: j.y - (horizontal ? 0 : sign * r) },
          end = { x: j.x + (horizontal ? sign * r : 0), y: j.y + (horizontal ? 0 : sign * r) },
          control = horizontal ? { x: j.x, y: j.y - r * 1.7 } : { x: j.x + r * 1.7, y: j.y },
          curve = "Q" + P(control) + " " + P(end);
        out += " L" + P(start) + " " + curve;
        overlays.push({ d: "M" + P(start) + " " + curve, x: j.x, y: j.y + offsetY, radius: r });
      }
      out += " L" + P(b);
    }
    return { d: out, overlays };
  }
  return {
    route,
    fixedRoute,
    anchoredRoute,
    manualRoute,
    simplifyDraft,
    fanCentroids,
    analyze,
    optimizeRows,
    optimizePorts,
    straighten,
    optimizeQuality,
    qualityLint,
    alignmentLint,
    qualityScore,
    directImprovement,
    jointCorridors,
    bridges,
    path,
    segments,
    hit,
    parallel,
    intersection,
    SPACE,
  };
};
export default createRouting();
