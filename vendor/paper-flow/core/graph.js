import dagre from "./dagre.min.js";
import { productPresentation } from "./products.js";
import { applyDraft, hasDraft } from "./editing.js";
import { nodeKind as defaultKind, nodeShape as defaultShape } from "./nodeKinds.js";
import { layoutTrunks } from "./trunks.js";
import routing from "./routing.js";
import svgMath from "./math-svg.min.js";
import { groupPresentation, childLayout, connectChildren } from "./grouping.js";
import { prefersStraight } from "./hints.js";
export const createGraph = function (dagre, R, S, profile = {}) {
  const nodeKind = profile.nodeKind || defaultKind;
  const shape = (n, ...args) => defaultShape({ ...n, visual_kind: nodeKind(n) }, ...args);
  ("use strict");
  const clone = (x) => JSON.parse(JSON.stringify(x));
  const canonical = (x) =>
    JSON.stringify(x, (_, v) =>
      v && typeof v === "object" && !Array.isArray(v)
        ? Object.fromEntries(
            Object.keys(v)
              .sort()
              .map((k) => [k, v[k]]),
          )
        : v,
    );
  const esc = (x) =>
    String(x ?? "").replace(
      /[&<>"']/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
    );
  const split = (x) => String(x).split(":");
  const sorted = (xs) => [...xs].sort((a, b) => String(a.id).localeCompare(String(b.id), "en"));
  function enabled(when, ctx) {
    if (when === undefined) return true;
    if (typeof when === "boolean") return when;
    if (typeof when === "string") {
      if (!(when in ctx)) throw Error("未知条件 " + when);
      return !!ctx[when];
    }
    if (when.all) return when.all.every((x) => enabled(x, ctx));
    if (when.any) return when.any.some((x) => enabled(x, ctx));
    if (when.not !== undefined) return !enabled(when.not, ctx);
    throw Error("条件必须是boolean、变量、all/any/not");
  }
  function resolve(x, ctx) {
    if (Array.isArray(x)) return x.map((v) => resolve(v, ctx));
    if (x && typeof x === "object")
      return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, resolve(v, ctx)]));
    if (typeof x === "string") {
      const exact = x.match(/^\$\{([^}]+)\}$/);
      if (exact) {
        if (!(exact[1] in ctx)) throw Error("未知变量 " + exact[1]);
        return clone(ctx[exact[1]]);
      }
      return x.replace(/\$\{([^}]+)\}/g, (_, k) => {
        if (!(k in ctx)) throw Error("未知变量 " + k);
        return typeof ctx[k] === "object" ? canonical(ctx[k]) : String(ctx[k]);
      });
    }
    return x;
  }
  function instantiate(spec, ctx) {
    const allIds = new Set(spec.nodes.map((n) => n.id));
    for (const e of spec.edges)
      if (!allIds.has(split(e.from)[0]) || !allIds.has(split(e.to)[0]))
        throw Error("模板连边目标不存在 " + e.id);
    const omitted = [],
      nodes = [];
    for (const raw of spec.nodes) {
      if (!enabled(raw.when, ctx) || raw.enabled === false) {
        omitted.push(raw.id);
        continue;
      }
      const n = clone(raw);
      delete n.when;
      nodes.push(resolve(n, ctx));
    }
    const ids = new Set(nodes.map((n) => n.id));
    const edges = [];
    for (const raw of spec.edges) {
      if (!enabled(raw.when, ctx) || raw.enabled === false) continue;
      if (!ids.has(split(raw.from)[0]) || !ids.has(split(raw.to)[0])) continue;
      const e = clone(raw);
      delete e.when;
      edges.push(resolve(e, ctx));
    }
    return {
      version: 2,
      id: ctx.id || "graph",
      name: ctx.name || spec.name,
      task_profile: spec.task_profile ? resolve(spec.task_profile, ctx) : undefined,
      nodes: sorted(nodes),
      edges: sorted(edges),
      omitted,
      teaching: false,
    };
  }
  function lint(g) {
    const errors = [],
      add = (path, message) => errors.push({ phase: "semantic", path, message });
    const ids = new Map(),
      eids = new Set();
    for (const [i, n] of g.nodes.entries()) {
      if (ids.has(n.id)) add(`nodes[${i}].id`, "重复节点ID " + n.id);
      ids.set(n.id, n);
      if (!n.ports?.in || !n.ports?.out) add(`nodes[${i}]`, "缺少端口");
      if (!["data", "method", "model", "representation", "output", "decision"].includes(n.type))
        add(`nodes[${i}].type`, "未知节点类型");
      if (n.type === "decision" && !n.condition)
        add(`nodes[${i}].condition`, "菱形必须声明真正条件，不能作装饰");
    }
    for (const n of g.nodes)
      if (n.label_math !== undefined) {
        if (!n.label_math || typeof n.label_math !== "object" || Array.isArray(n.label_math))
          add("nodes." + n.id + ".label_math", "图内数学必须按原始行号声明");
        else
          for (const [line, latex] of Object.entries(n.label_math)) {
            try {
              if (
                !/^(0|[1-9][0-9]*)$/.test(line) ||
                !String(n.label).split("\n")[Number(line)]?.trim()
              )
                throw Error("数学行缺少有效原始行号/可访问文本");
              S.render(latex);
            } catch (e) {
              add("nodes." + n.id + ".label_math." + line, e.message);
            }
          }
      }
    const stageOrder = new Map((g.stages || []).map((s, i) => [s.id, i]));
    if (g.stages) {
      if (stageOrder.size !== g.stages.length) add("stages", "重复阶段ID");
      for (const [i, n] of g.nodes.entries())
        if (!stageOrder.has(n.stage)) add(`nodes[${i}].stage`, "节点缺少有效阶段 " + n.stage);
    }
    const adj = new Map([...ids.keys()].map((k) => [k, []]));
    const incoming = new Map([...ids.keys()].map((k) => [k, []]));
    for (const [i, e] of g.edges.entries()) {
      if (eids.has(e.id)) add(`edges[${i}].id`, "重复连边ID");
      eids.add(e.id);
      const [a, ap] = split(e.from),
        [b, bp] = split(e.to),
        an = ids.get(a),
        bn = ids.get(b);
      if (!an || !bn) {
        add(`edges[${i}]`, "连边目标不存在 " + e.from + " → " + e.to);
        continue;
      }
      const ao = an.ports?.out?.[ap],
        bi = bn.ports?.in?.[bp];
      if (!ao || !bi) {
        add(`edges[${i}]`, "端口不存在或方向错误");
        continue;
      }
      if (ao.type !== bi.type)
        add(`edges[${i}]`, "端口数据类型不兼容 " + ao.type + " → " + bi.type);
      if (an.enabled === false || bn.enabled === false) add(`edges[${i}]`, "关闭节点仍有活动连边");
      adj.get(a).push(b);
      incoming.get(b).push(a);
    }
    const seen = new Set(),
      active = new Set();
    function visit(id) {
      if (active.has(id)) return true;
      if (seen.has(id)) return false;
      seen.add(id);
      active.add(id);
      for (const b of adj.get(id) || []) if (visit(b)) return true;
      active.delete(id);
      return false;
    }
    if ([...ids.keys()].some((id) => !seen.has(id) && visit(id)))
      add("edges", "存在循环；请将迭代过程封装为一个流程步骤");
    for (const n of g.nodes) {
      if (n.type === "decision") {
        const out = g.edges.filter((e) => split(e.from)[0] === n.id);
        if (out.length < 2 || out.some((e) => !e.condition))
          add("nodes." + n.id, "条件节点至少两个带condition的分支");
      }
    }
    return errors;
  }
  function collapse(g) {
    if (!g.paper_groups?.length) return clone(g);
    const nodeMap = new Map(g.nodes.map((n) => [n.id, n])),
      membership = new Map(),
      groupNodes = [];
    for (const definition of g.paper_groups) {
      const members = definition.members
        .filter((id) => nodeMap.has(id))
        .map((id) => nodeMap.get(id));
      if (!members.length) continue;
      for (const n of members) {
        if (membership.has(n.id)) throw Error("分组重复包含 " + n.id);
        membership.set(n.id, definition.id);
      }
      const roles = [...new Set(members.map((n) => n.role).filter(Boolean))];
      const memberStages = [...new Set(members.map((n) => n.stage).filter(Boolean))];
      if (profile.groupStagesStrict && memberStages.length > 1)
        throw Error("概览分组跨越阶段 " + definition.id);
      const grouped = {
        ...(members.every((n) => n.swimlane === members[0].swimlane)
          ? { swimlane: members[0].swimlane }
          : {}),
        logical: definition.logical ? clone(definition.logical) : undefined,
        stage: memberStages.length > 1 ? "@overview_mixed" : memberStages[0],
        id: definition.id,
        semantic_key: definition.semantic_key || "",
        type: definition.type || "method",
        label: definition.label,
        shape: definition.shape,
        op: "subgraph_group",
        state: members.some((n) => n.state.includes("未核实"))
          ? "未知/未核实"
          : members
              .map((n) => n.state)
              .filter((x, i, a) => a.indexOf(x) === i)
              .slice(0, 2)
              .join(" / "),
        config: {
          members: members
            .map((n) => ({ key: n.semantic_key, type: n.type, op: n.op, config: n.config }))
            .sort((a, b) => a.key.localeCompare(b.key, "en")),
        },
        ports: { in: {}, out: {} },
        members: clone(members),
        detail: members
          .map((n) => n.label.replaceAll("\n", " · ") + "：" + (n.detail || n.state))
          .join("\n"),
        evidence: [...new Set(members.map((n) => n.evidence).filter(Boolean))].join("; "),
      };
      if (roles.length === 1) grouped.role = roles[0];
      groupNodes.push(grouped);
    }
    const allNodes = [...g.nodes.filter((n) => !membership.has(n.id)).map(clone), ...groupNodes],
      byId = new Map(allNodes.map((n) => [n.id, n])),
      edges = [];
    for (const edge of g.edges) {
      const [a, ap] = split(edge.from),
        [b, bp] = split(edge.to),
        from = membership.get(a) || a,
        to = membership.get(b) || b;
      if (from === to) continue;
      const fp = membership.has(a) ? a + "__" + ap : ap,
        tp = membership.has(b) ? b + "__" + bp : bp;
      if (membership.has(a)) {
        const group = byId.get(from),
          original = nodeMap.get(a);
        group.ports.out[fp] = clone(original.ports.out[ap]);
        if (original.display_outputs?.[ap]) {
          group.display_outputs ||= {};
          group.display_outputs[fp] = { ...clone(original.display_outputs[ap]), owner_id: a };
        }
      }
      if (membership.has(b)) byId.get(to).ports.in[tp] = clone(nodeMap.get(b).ports.in[bp]);
      edges.push({ ...clone(edge), from: from + ":" + fp, to: to + ":" + tp });
    }
    return {
      ...clone(g),
      stages: g.stages && [
        ...g.stages,
        ...(groupNodes.some((n) => n.stage === "@overview_mixed")
          ? [{ id: "@overview_mixed", title: "跨阶段分组" }]
          : []),
      ],
      nodes: sorted(allNodes),
      edges: sorted(edges),
      paper_groups: undefined,
      collapsed: true,
    };
  }
  function logicalScope(n) {
    if (!n.logical) return null;
    const scope = clone(n.logical);
    if (Array.isArray(scope.compare_fields)) scope.compare_fields.sort();
    return scope;
  }
  function signature(n) {
    return canonical({
      logical_scope: logicalScope(n),
      stage: n.stage === "@unassigned" ? null : n.stage || null,
      type: n.type,
      semantic_key: n.semantic_key,
      role: n.role,
      op: n.op,
      config: n.config || {},
      ports: n.ports,
    });
  }
  function neighborhood(g, n) {
    const by = Object.fromEntries(g.nodes.map((n) => [n.id, n]));
    const neighbors = g.edges
        .filter((e) => split(e.from)[0] === n.id || split(e.to)[0] === n.id)
        .map((e) => {
          const [a, ap] = split(e.from),
            [b, bp] = split(e.to);
          const out = a === n.id, other = by[out ? b : a];
          const stage = stageEvidence(g, other);
          if (!strictReady(other) || (stage.present && !stage.valid) ||
            !portType(n, out ? "out" : "in", out ? ap : bp) ||
            !portType(other, out ? "in" : "out", out ? bp : ap) ||
            (e.kind && !known(e.kind)) || (e.semantic && !known(e.semantic))) return null;
          return {
            direction: out ? "out" : "in",
            selfPort: out ? ap : bp,
            otherPort: out ? bp : ap,
            semantic: e.semantic,
            kind: e.kind,
            otherKey: other.semantic_key,
            otherSignature: signature(other),
            otherStage: stage.present ? stage.definition : null,
          };
        });
    if (neighbors.some((item) => item === null)) return null;
    return canonical(neighbors.sort((a, b) => canonical(a).localeCompare(canonical(b), "en")));
  }
  function changes(a, b, path = "") {
    if (canonical(a) === canonical(b)) return [];
    if (
      a &&
      b &&
      typeof a === "object" &&
      typeof b === "object" &&
      !Array.isArray(a) &&
      !Array.isArray(b)
    )
      return [...new Set([...Object.keys(a), ...Object.keys(b)])]
        .sort()
        .flatMap((k) => changes(a[k], b[k], path ? path + "." + k : k));
    return [path || "value"];
  }
  const known = (value) => {
    if (typeof value === "string") return !!value.trim() && !/^(unknown|unverified|未知|未核实)$/i.test(value.trim());
    if (typeof value === "number") return Number.isFinite(value);
    if (typeof value === "boolean") return true;
    if (Array.isArray(value)) return value.length > 0 && value.every(known);
    if (value && typeof value === "object") return Object.keys(value).length > 0 && Object.values(value).every(known);
    return false;
  };
  const safePath = (path) => typeof path === "string" && path.split(".").every((part) =>
    !!part && !/[\s.\[\]]/u.test(part) && !["__proto__", "prototype", "constructor", "compare_fields"].includes(part));
  const readPath = (object, path) => path.split(".").reduce((value, part) =>
    value && typeof value === "object" && Object.hasOwn(value, part) ? value[part] : undefined, object);
  function leafPaths(value, prefix = "") {
    if (!value || typeof value !== "object" || Array.isArray(value) || !Object.keys(value).length) return prefix ? [prefix] : [];
    return Object.keys(value).sort().flatMap((key) => leafPaths(value[key], prefix ? prefix + "." + key : key));
  }
  function logicalDescriptor(n) {
    const l = n.logical;
    if (!l || typeof l.key !== "string" || typeof l.function !== "string" || !known(l.key) || !known(l.function)) return null;
    const explicit = Object.hasOwn(l, "compare_fields");
    if (explicit && (!Array.isArray(l.compare_fields) || !l.compare_fields.length || l.compare_fields.some((path) => !safePath(path)))) return null;
    // Functional port roles are compared separately as edges, unless explicitly selected.
    const selected = explicit ? [...new Set(l.compare_fields)].sort() : leafPaths(Object.fromEntries(Object.entries(l).filter(([key]) => key !== "compare_fields" && key !== "ports")));
    const paths = [...new Set(["key", "function", ...selected])].sort();
    if (paths.some((path) => !safePath(path) || !known(readPath(l, path)))) return null;
    return { strategy: explicit ? selected : null, paths, values: paths.map((path) => [path, readPath(l, path)]) };
  }
  const knownLogical = (n) => !!logicalDescriptor(n);
  function structuralRole(g, n) {
    const input = g.edges.some((e) => split(e.to)[0] === n.id),
      output = g.edges.some((e) => split(e.from)[0] === n.id);
    return input ? (output ? "transform" : "sink") : output ? "source" : "isolated";
  }
  function stageEvidence(g, n) {
    if (!n.stage || n.stage === "@unassigned") return { present: false };
    const definition = g.stages?.find((stage) => stage.id === n.stage);
    if (!definition || !known(definition)) return { present: true, valid: false };
    return { present: true, valid: true, definition };
  }
  function stagesCompatible(a, an, b, bn) {
    const left = stageEvidence(a, an), right = stageEvidence(b, bn);
    if (!left.present && !right.present) return true;
    return !!left.valid && !!right.valid && canonical(left.definition) === canonical(right.definition);
  }
  function logicalSignature(g, n) {
    const descriptor = logicalDescriptor(n);
    if (!descriptor) return null;
    const stage = stageEvidence(g, n);
    if (stage.present && !stage.valid) return null;
    return canonical({
      stage: stage.present ? stage.definition : null,
      type: n.type,
      strategy: descriptor.strategy,
      logical: descriptor.values,
      role: n.role || null,
      structure: structuralRole(g, n),
    });
  }
  function portType(n, direction, port) {
    const type = n.ports?.[direction]?.[port]?.type;
    return typeof type === "string" && known(type) ? type : null;
  }
  function explicitPortRole(n, direction, port) {
    const role = n.logical?.ports?.[direction]?.[port];
    return typeof role === "string" && known(role) ? role : null;
  }
  function portRole(n, direction, port) {
    const role = explicitPortRole(n, direction, port);
    if (role) return { kind: "role", value: role };
    const type = portType(n, direction, port);
    return type ? { kind: "port", name: port, type } : null;
  }
  function comparePorts(left, leftName, right, rightName, direction) {
    const leftRole = explicitPortRole(left, direction, leftName), rightRole = explicitPortRole(right, direction, rightName);
    const leftType = portType(left, direction, leftName), rightType = portType(right, direction, rightName);
    const physical = leftName === rightName && !!leftType && leftType === rightType;
    if (leftRole && rightRole) return leftRole === rightRole ? { physical, role: true, leftType, rightType } : null;
    return physical ? { physical: true, role: false, leftType, rightType } : null;
  }
  function logicalNeighborhood(g, n) {
    const by = new Map(g.nodes.map((n) => [n.id, n]));
    const neighbors = g.edges
        .filter((e) => split(e.from)[0] === n.id || split(e.to)[0] === n.id)
        .map((e) => {
          const [a, ap] = split(e.from),
            [b, bp] = split(e.to),
            out = a === n.id,
            other = by.get(out ? b : a);
          const self = portRole(n, out ? "out" : "in", out ? ap : bp);
          const stage = stageEvidence(g, other);
          const otherSignature = logicalSignature(g, other) || (strictReady(other) && (!stage.present || stage.valid)
            ? canonical([other.semantic_key, signature(other), stage.present ? stage.definition : null]) : null);
          if (!self || !otherSignature || (e.kind && !known(e.kind)) || (e.semantic && !known(e.semantic))) return null;
          return {
            direction: out ? "out" : "in",
            self,
            other: otherSignature,
            kind: e.kind,
            semantic: e.semantic,
          };
        });
    if (neighbors.some((item) => item === null)) return null;
    return canonical(neighbors.sort((a, b) => canonical(a).localeCompare(canonical(b), "en")));
  }
  function createsCycle(a, b, pairs, an, bn) {
    const pa = new Map(),
      pb = new Map();
    for (const [i, p] of [...pairs, { a: an.id, b: bn.id }].entries()) {
      pa.set(p.a, "shared:" + i);
      pb.set(p.b, "shared:" + i);
    }
    const adj = new Map();
    for (const [g, map, lane] of [
      [a, pa, "a"],
      [b, pb, "b"],
    ])
      for (const e of g.edges) {
        const from = map.get(split(e.from)[0]) || lane + ":" + split(e.from)[0],
          to = map.get(split(e.to)[0]) || lane + ":" + split(e.to)[0];
        if (!adj.has(from)) adj.set(from, []);
        adj.get(from).push(to);
      }
    const seen = new Set(),
      active = new Set();
    function visit(id) {
      if (active.has(id)) return true;
      if (seen.has(id)) return false;
      active.add(id);
      for (const to of adj.get(id) || []) if (visit(to)) return true;
      active.delete(id);
      seen.add(id);
      return false;
    }
    return [...adj.keys()].some(visit);
  }
  function specObject(n) {
    return {
      logical_scope: logicalScope(n),
      stage: n.stage === "@unassigned" ? undefined : n.stage,
      type: n.type,
      role: n.role,
      semantic_key: n.semantic_key,
      op: n.op,
      config: n.config,
      ports: n.ports,
      label: n.label,
      detail: n.detail,
      evidence: n.evidence,
      state: n.state,
    };
  }
  function specDifferences(a, b) {
    const aa = specObject(a),
      bb = specObject(b),
      read = (x, path) => path.split(".").reduce((v, k) => v?.[k], x);
    return changes(aa, bb).map((field) => ({
      field,
      a: read(aa, field) ?? "未提供",
      b: read(bb, field) ?? "未提供",
    }));
  }
  function strictReady(n, requireSemantic = true) {
    if (!known(n.op) || (requireSemantic && !known(n.semantic_key))) return false;
    for (const direction of ["in", "out"])
      for (const port of Object.values(n.ports?.[direction] || {}))
        if (typeof port?.type !== "string" || !known(port.type)) return false;
    if (n.stage && !known(n.stage) || n.role && !known(n.role)) return false;
    if (n.config && Object.keys(n.config).length && !known(n.config)) return false;
    if (n.logical) {
      const fields = Object.fromEntries(Object.entries(n.logical).filter(([key]) => key !== "compare_fields" && key !== "ports"));
      if (Object.keys(fields).length && !known(fields)) return false;
      for (const direction of ["in", "out"])
        for (const role of Object.values(n.logical.ports?.[direction] || {}))
          if (typeof role !== "string" || !known(role)) return false;
    }
    return true;
  }
  function basis(an, bn, equivalence, graphA, graphB) {
    const compared = ["type"], omitted = [];
    const declared = (key) => known(an[key]) && known(bn[key]);
    for (const key of ["semantic_key", "op", "role", "config"]) {
      if (equivalence === "strict" && declared(key)) compared.push(key);
      else if (equivalence === "logical" && key === "role" && declared(key)) compared.push(key);
      else omitted.push(key);
    }
    for (const key of ["label", "detail", "evidence", "state"]) if (known(an[key]) || known(bn[key])) omitted.push(key);
    if (stageEvidence(graphA, an).valid && stageEvidence(graphB, bn).valid) compared.push("stage.definition");
    else omitted.push("stage");
    if (equivalence === "strict") compared.push("ports");
    else { compared.push("structure"); omitted.push("ports"); }
    const l = an.logical || {}, r = bn.logical || {};
    const selected = equivalence === "logical" ? logicalDescriptor(an)?.paths || []
      : [...new Set([...leafPaths(l), ...leafPaths(r)])].filter((p) => p !== "compare_fields" && known(readPath(l, p)) && known(readPath(r, p)));
    compared.push(...selected.map((p) => "logical." + p));
    const declaredPaths = [...new Set([...leafPaths(l), ...leafPaths(r)])].filter((p) => p !== "compare_fields");
    for (const path of declaredPaths) if (!selected.includes(path) && !selected.some((p) => path.startsWith(p + "."))) omitted.push("logical." + path);
    return { comparedFields: [...new Set(compared)], notCompared: [...new Set(omitted)] };
  }
  function match(a, b, overrides = [], options = {}) {
    if (!Array.isArray(overrides)) {
      options = overrides;
      overrides = [];
    }
    const mode = options.mode || "strict";
    if (!["strict", "logical"].includes(mode)) throw Error("未知比较模式 " + mode);
    const failures = [...lint(a), ...lint(b)];
    if (failures.length) throw Error(JSON.stringify(failures));
    const usedA = new Set(),
      usedB = new Set(),
      pairs = [],
      notes = [],
      rejected = new Set();
    const add = (an, bn, reason, equivalence = "strict") => {
      if (options.exclusions?.some((p) => p.a === an.id && p.b === bn.id)) return;
      if (!stagesCompatible(a, an, b, bn)) return;
      if (equivalence === "logical" && createsCycle(a, b, pairs, an, bn)) {
        notes.push("逻辑候选合并会产生环，保守未匹配 " + an.id + " ↔ " + bn.id);
        rejected.add("a:" + an.id);
        rejected.add("b:" + bn.id);
        return;
      }
      usedA.add(an.id);
      usedB.add(bn.id);
      const evidence = basis(an, bn, equivalence, a, b), differences = specDifferences(an, bn);
      const substantiveDifference = differences.some((item) => !["label", "detail", "evidence", "state"].includes(item.field));
      pairs.push({
        a: an.id,
        b: bn.id,
        semantic_key: an.semantic_key,
        reason: `${reason}；比较依据：${evidence.comparedFields.join("、")}${differences.length ? "；其他声明有差异，分别保留" : ""}；不代表科学等价`,
        equivalence,
        local_equal: equivalence === "strict",
        logical_equal: equivalence === "logical" ? true : undefined,
        ...evidence,
        declaredDifferences: differences,
        spec_differences: differences,
        logical_contract: equivalence === "logical" ? clone(an.logical) : undefined,
        impacted: equivalence === "logical" && substantiveDifference,
        ...(equivalence === "logical" && substantiveDifference
          ? { impact_reason: "按所选逻辑字段对齐，其他声明分别保留" }
          : {}),
      });
    };
    for (const o of overrides) {
      const an = a.nodes.find((n) => n.id === o.a),
        bn = b.nodes.find((n) => n.id === o.b);
      if (!an || !bn || usedA.has(o.a) || usedB.has(o.b)) {
        notes.push("覆写无效或重复 " + canonical(o));
        continue;
      }
      if (strictReady(an, false) && strictReady(bn, false) && signature(an) === signature(bn)) add(an, bn, "用户显式覆写；已声明的操作签名一致");
      else if (
        mode === "logical" &&
        logicalSignature(a, an) &&
        logicalSignature(a, an) === logicalSignature(b, bn)
      )
        add(an, bn, "用户显式逻辑对齐；所声明的比较契约一致", "logical");
      else notes.push("覆写仅记录对齐，不合并不同操作/配置 " + o.a + " ↔ " + o.b);
    }
    const groups = new Map();
    for (const an of sorted(a.nodes)) {
      if (!strictReady(an)) continue;
      const key = an.semantic_key + "|" + signature(an);
      if (!groups.has(key)) groups.set(key, { a: [], b: [] });
      groups.get(key).a.push(an);
    }
    for (const bn of sorted(b.nodes)) {
      if (!strictReady(bn)) continue;
      const key = bn.semantic_key + "|" + signature(bn);
      if (!groups.has(key)) groups.set(key, { a: [], b: [] });
      groups.get(key).b.push(bn);
    }
    for (const g of groups.values()) {
      const aa = g.a.filter((n) => !usedA.has(n.id)),
        bb = g.b.filter((n) => !usedB.has(n.id));
      if (aa.length === 1 && bb.length === 1) {
        add(aa[0], bb[0], "已声明的操作签名一致");
        continue;
      }
      for (const an of aa) {
        const ns = neighborhood(a, an),
          ac = aa.filter((n) => neighborhood(a, n) === ns),
          bc = bb.filter((n) => !usedB.has(n.id) && neighborhood(b, n) === ns);
        if (ns !== null && ac.length === 1 && bc.length === 1)
          add(an, bc[0], "重复语义键经上下游端口与邻居签名消歧");
      }
    }
    if (mode === "logical") {
      const buckets = new Map();
      for (const [g, lane, used] of [
        [a, "a", usedA],
        [b, "b", usedB],
      ])
        for (const n of sorted(g.nodes)) {
          if (used.has(n.id)) continue;
          const key = logicalSignature(g, n);
          if (!key) continue;
          if (!buckets.has(key)) buckets.set(key, { a: [], b: [] });
          buckets.get(key)[lane].push(n);
        }
      for (const key of [...buckets.keys()].sort()) {
        const { a: aa, b: bb } = buckets.get(key);
        if (aa.length === 1 && bb.length === 1) {
          add(
            aa[0],
            bb[0],
            "按双方所选的已声明逻辑字段对齐",
            "logical",
          );
          continue;
        }
        for (const an of aa) {
          if (usedA.has(an.id)) continue;
          const ns = logicalNeighborhood(a, an),
            ac = aa.filter((n) => logicalNeighborhood(a, n) === ns),
            bc = bb.filter((n) => !usedB.has(n.id) && logicalNeighborhood(b, n) === ns);
          if (ns !== null && ac.length === 1 && bc.length === 1)
            add(an, bc[0], "逻辑契约一致；重复候选经上下游功能端口消歧", "logical");
        }
      }
    }
    const amap = new Map(pairs.map((p) => [p.a, p.b])),
      edgePairs = [],
      usedE = new Set(),
      byA = new Map(a.nodes.map((n) => [n.id, n])),
      byB = new Map(b.nodes.map((n) => [n.id, n]));
    const fieldStatus = (value) => {
      if (value == null || value === "" || (value && typeof value === "object" && !Object.keys(value).length)) return "missing";
      return known(value) ? "known" : "unknown";
    };
    const compareEdge = (ae, be) => {
      const [af, ap] = split(ae.from), [at, aq] = split(ae.to), [bf, bp] = split(be.from), [bt, bq] = split(be.to);
      if (amap.get(af) !== bf || amap.get(at) !== bt) return null;
      const from = comparePorts(byA.get(af), ap, byB.get(bf), bp, "out"), to = comparePorts(byA.get(at), aq, byB.get(bt), bq, "in");
      if (!from || !to || (mode === "strict" && (!from.physical || !to.physical))) return null;
      const comparedFields = ["from", "to", "direction"], notCompared = [], declaredDifferences = [];
      if (from.physical && to.physical) comparedFields.push("ports");
      else {
        if (!from.physical && !to.physical) comparedFields.push("logical.ports");
        else {
          comparedFields.push(from.physical ? "from.port/type" : "from.logical_role");
          comparedFields.push(to.physical ? "to.port/type" : "to.logical_role");
        }
        notCompared.push("ports");
        if (ap !== bp) declaredDifferences.push({ field: "from.port", a: ap, b: bp });
        if (aq !== bq) declaredDifferences.push({ field: "to.port", a: aq, b: bq });
        if (from.leftType !== from.rightType) declaredDifferences.push({ field: "from.type", a: from.leftType || "未提供", b: from.rightType || "未提供" });
        if (to.leftType !== to.rightType) declaredDifferences.push({ field: "to.type", a: to.leftType || "未提供", b: to.rightType || "未提供" });
      }
      for (const field of ["kind", "semantic", "config", "condition"]) {
        if (["kind", "semantic"].includes(field) && [ae[field], be[field]].some((value) => value != null && typeof value !== "string")) return null;
        const left = fieldStatus(ae[field]), right = fieldStatus(be[field]);
        if (left === "unknown" || right === "unknown" || left !== right) return null;
        if (left === "known") {
          if (canonical(ae[field]) !== canonical(be[field])) return null;
          comparedFields.push(field);
        } else notCompared.push(field);
      }
      // Without a declared relation kind, retain the original edges separately.
      if (notCompared.includes("kind")) return null;
      const excluded = new Set(["id", "from", "to", "kind", "semantic", "config", "condition"]);
      const read = (value, path) => path.split(".").reduce((current, key) => current?.[key], value);
      for (const field of [...new Set([...Object.keys(ae), ...Object.keys(be)])].sort()) {
        if (excluded.has(field)) continue;
        notCompared.push(field);
        for (const path of changes(ae[field], be[field], field)) declaredDifferences.push({
          field: path, a: read(ae, path) ?? "未提供", b: read(be, path) ?? "未提供",
        });
      }
      return { comparedFields, notCompared, declaredDifferences, physical: from.physical && to.physical };
    };
    for (const ae of sorted(a.edges)) {
      const candidates = b.edges.filter((be) => !usedE.has(be.id)).map((be) => ({ edge: be, basis: compareEdge(ae, be) })).filter((candidate) => candidate.basis);
      if (candidates.length === 1) {
        const { edge: be, basis: { physical: exact, comparedFields, notCompared, declaredDifferences } } = candidates[0];
        usedE.add(be.id);
        edgePairs.push({
          a: ae.id,
          b: be.id,
          equivalence: exact ? "strict" : "logical",
          comparedFields, notCompared, declaredDifferences, spec_differences: declaredDifferences,
          reason: `${exact ? "两端的端口名称与类型按声明对齐" : "两端按已声明端口依据对齐，原端口分别保留"}；比较依据：${comparedFields.join("、")}${declaredDifferences.length ? "；其他声明有差异，分别保留" : ""}；不代表科学等价`,
        });
      }
    }
    const commonAEdges = new Set(edgePairs.map((p) => p.a)),
      commonBEdges = new Set(edgePairs.map((p) => p.b));
    function exclusive(g, n, other, lane) {
      if (rejected.has(lane + ":" + n.id)) return "候选逻辑合并会产生环，保守未匹配";
      if (mode === "logical" && knownLogical(n)) {
        const candidates = other.nodes.filter((x) => x.logical?.key === n.logical.key);
        if (candidates.length) {
          if (logicalSignature(g, n) && candidates.some((x) => logicalSignature(other, x) === logicalSignature(g, n)))
            return "重复逻辑候选仍歧义，保守未匹配";
          return (
            "同逻辑键候选未通过所选字段、阶段或结构核对：" +
            changes(n.logical, candidates[0].logical).join(", ")
          );
        }
      }
      if (!known(n.semantic_key)) return "缺少明确可用的语义键或逻辑契约，保守未匹配";
      const candidates = other.nodes.filter((x) => x.semantic_key === n.semantic_key),
        prefix = mode === "logical" && !knownLogical(n) ? "缺少明确可用的逻辑契约，保留严格判断；" : "";
      if (!candidates.length) return prefix + "另一图无此语义节点";
      if (candidates.some((x) => signature(x) === signature(n)))
        return prefix + "同语义键候选未通过完整依据核对，保守未匹配";
      return (
        prefix + "同语义键候选的声明有差异：" + changes(specObject(n), specObject(candidates[0])).join(", ")
      );
    }
    return {
      matching_mode: mode,
      pairs: pairs.sort((x, y) => x.a.localeCompare(y.a, "en")),
      aOnly: sorted(a.nodes)
        .filter((n) => !usedA.has(n.id))
        .map((n) => ({ id: n.id, semantic_key: n.semantic_key, reason: exclusive(a, n, b, "a") })),
      bOnly: sorted(b.nodes)
        .filter((n) => !usedB.has(n.id))
        .map((n) => ({ id: n.id, semantic_key: n.semantic_key, reason: exclusive(b, n, a, "b") })),
      edgePairs,
      aOnlyEdges: sorted(a.edges)
        .filter((e) => !commonAEdges.has(e.id))
        .map((e) => ({ id: e.id, reason: "未能按已声明信息唯一对齐；保留两侧关系" })),
      bOnlyEdges: sorted(b.edges)
        .filter((e) => !commonBEdges.has(e.id))
        .map((e) => ({ id: e.id, reason: "未能按已声明信息唯一对齐；保留两侧关系" })),
      notes,
    };
  }
  function merge(a, b, r) {
    const nodes = [],
      edges = [],
      ma = new Map(),
      mb = new Map(),
      looseA = new Set(),
      looseB = new Set();
    for (const p of r.pairs) {
      const n = a.nodes.find((n) => n.id === p.a),
        other = b.nodes.find((n) => n.id === p.b),
        id = "shared_" + p.a,
        loose = p.equivalence === "logical";
      ma.set(p.a, id);
      mb.set(p.b, id);
      const merged = {
        ...clone(n),
        id,
        status: "shared",
        equivalence: p.equivalence,
        impacted: p.impacted,
        spec_differences: clone(p.spec_differences || []),
        source_ids: { a: p.a, b: p.b },
        other: clone(other),
        match_reason: p.reason,
      };
      if (loose) {
        looseA.add(p.a);
        looseB.add(p.b);
        merged.label =
          (n.logical.label || n.logical.key) +
          (n.logical.hint && other.logical.hint
            ? "\nA " + n.logical.hint + "\nB " + other.logical.hint
            : "");
        merged.logical_common = n.logical.label || n.logical.key;
        merged.comparison_parts = [
          { lane: "a", label: n.logical.hint || n.label },
          { lane: "b", label: other.logical.hint || other.label },
        ];
        merged.op = "logical_comparison";
        merged.logical_contract = clone(n.logical);
        delete merged.logical;
        merged.config = { a: clone(n.config), b: clone(other.config) };
        merged.ports = { in: {}, out: {} };
        delete merged.display_outputs;
        for (const [lane, original] of [
          ["a", n],
          ["b", other],
        ])
          for (const direction of ["in", "out"])
            for (const [port, value] of Object.entries(original.ports[direction])) {
              merged.ports[direction][lane + "__" + port] = clone(value);
              if (direction === "out" && original.display_outputs?.[port]) {
                merged.display_outputs ||= {};
                merged.display_outputs[lane + "__" + port] = clone(original.display_outputs[port]);
              }
            }
      }
      nodes.push(merged);
    }
    for (const [g, map, status] of [
      [a, ma, "a"],
      [b, mb, "b"],
    ])
      for (const n of g.nodes)
        if (!map.has(n.id)) {
          const id = status + "_" + n.id;
          map.set(n.id, id);
          nodes.push({ ...clone(n), id, status, source_ids: { [status]: n.id } });
        }
    const commonA = new Map(r.edgePairs.map((x) => [x.a, x])),
      commonB = new Map(r.edgePairs.map((x) => [x.b, x]));
    for (const [g, map, status, common, loose] of [
      [a, ma, "a", commonA, looseA],
      [b, mb, "b", commonB, looseB],
    ])
      for (const e of g.edges) {
        if (status === "b" && common.has(e.id)) continue;
        const [an, ap] = split(e.from),
          [bn, bp] = split(e.to),
          matched = common.get(e.id),
          other = status === "a" && matched ? b.edges.find((edge) => edge.id === matched.b) : undefined;
        edges.push({
          ...clone(e),
          id: status + "_" + e.id,
          from: map.get(an) + ":" + (loose.has(an) ? status + "__" : "") + ap,
          to: map.get(bn) + ":" + (loose.has(bn) ? status + "__" : "") + bp,
          status: common.has(e.id) ? "shared" : status,
          equivalence: common.get(e.id)?.equivalence,
          ...(other ? { other: clone(other), declaredDifferences: clone(matched.declaredDifferences || []), spec_differences: clone(matched.declaredDifferences || []), comparedFields: clone(matched.comparedFields || []), notCompared: clone(matched.notCompared || []), match_reason: matched.reason } : {}),
          source_ids: common.has(e.id)
            ? { a: common.get(e.id).a, b: common.get(e.id).b }
            : { [status]: e.id },
        });
      }
    return {
      version: 2,
      id: "comparison",
      name: "结构与规格对比",
      comparison_layout: "shared-center",
      collapsed: !!a.collapsed && !!b.collapsed,
      matching_mode: r.matching_mode,
      nodes: sorted(nodes),
      edges: sorted(edges),
      teaching: a.teaching || b.teaching,
      reference: a.reference || b.reference,
      reference_only: !!a.reference && !!b.reference,
      stages: clone(a.stages || b.stages || []),
      phase_schema: a.phase_schema === b.phase_schema ? a.phase_schema : undefined,
      stage_notes: { a: a.stage_notes || {}, b: b.stage_notes || {} },
      detail_grouping: !!a.detail_grouping || !!b.detail_grouping,
      detail_groups: [
        [a, ma, "a"],
        [b, mb, "b"],
      ].flatMap(([g, map, lane]) =>
        (g.detail_groups || []).map((group) => ({
          ...group,
          id: lane + "_" + group.id,
          members: group.members.map((id) => map.get(id)).filter(Boolean),
        })),
      ),
    };
  }

  function wrap(text, max = 5.5) {
    let rows = [];
    for (const line of String(text).split("\n")) {
      if (/^[A-Za-z0-9_-]{1,12}$/.test(line)) {
        rows.push(line);
        continue;
      }
      let row = "",
        len = 0;
      for (const ch of line) {
        const w = /[\x00-\xff]/.test(ch) ? 0.55 : 1;
        if (len + w > max) {
          rows.push(row);
          row = "";
          len = 0;
        }
        row += ch;
        len += w;
      }
      rows.push(row);
    }
    return rows;
  }
  function labelLayout(n, max, width) {
    const lines = [],
      mathRows = {},
      lineOffsets = [];
    let height = 0;
    for (const [i, line] of String(n.label).split("\n").entries()) {
      const latex = n.label_math?.[i];
      for (const row of latex ? [line] : wrap(line, max)) {
        const index = lines.length;
        lineOffsets.push(height);
        lines.push(row);
        if (latex) {
          const math = S.render(latex);
          mathRows[index] = { ...math, latex, alt: line };
          height += Math.max(37, math.height + 8);
          width = Math.max(width, math.width + 44);
        } else height += 37;
      }
    }
    return { width, height: Math.max(110, height + 45), lines, mathRows, lineOffsets };
  }
  function measure(n) {
    if (n.presentation_members) {
      const columns = Math.min(2, n.presentation_members.length),
        parts = n.presentation_members.map((node) => ({ ...measure(node), node, id: node.id })),
        cell = Math.max(...parts.map((p) => p.width), 244),
        lines = wrap(n.label, 9),
        noteLines = wrap(n.presentation_note || "", 13),
        headingOffset = Math.max(32, (n.presentation_inlets || 0) * 18 + 36),
        headH = headingOffset + lines.length * 37 + noteLines.length * 25 + 30,
        textWidth = (line, size) =>
          [...line].reduce((s, c) => s + (/[\x00-\xff]/.test(c) ? 0.55 : 1) * size, 0),
        headingWidth =
          Math.max(
            ...lines.map((line) => textWidth(line, 30)),
            ...noteLines.map((line) => textWidth(line, 20)),
          ) + 24,
        width = columns * cell + (columns - 1) * 88 + 128;
      let y = headH + 64;
      for (let i = 0; i < parts.length; i += columns) {
        const row = parts.slice(i, i + columns),
          height = Math.max(...row.map((p) => p.height));
        row.forEach((part, col) => {
          part.x = 64 + cell / 2 + col * (cell + 88);
          part.y = y + height / 2;
        });
        y += height + 88;
      }
      return {
        width,
        height: y - 24,
        lines,
        compound: {
          kind: "detail_group",
          children: parts,
          headH,
          headingWidth,
          headingOffset,
          noteLines,
        },
      };
    }
    if (!n.comparison_parts) return labelLayout(n, 5.5, 198);
    const lines = wrap(n.logical_common, 10),
      parts = n.comparison_parts.map((p) => ({ ...p, lines: wrap(p.label, 5.4) })),
      headH = lines.length * 37 + 24,
      partH = Math.max(110, ...parts.map((p) => p.lines.length * 35 + 49));
    return { width: 382, height: headH + partH + 101, lines, compound: { parts, headH, partH } };
  }
  const layoutCache = new Map();
  // Declared alternatives occupy explicit columns inside lifecycle bands. A lane
  // is a separate run/plan, not a tensor concatenation or a new scientific edge.
  function swimlaneStages(result, graph) {
    for (const n of result.nodes) if (!n.compound) Object.assign(n, labelLayout(n.node, 7, 244));
    const by = new Map(result.nodes.map((n) => [n.id, n])),
      parents = new Map(result.nodes.map((n) => [n.id, []]));
    for (const e of result.edges) parents.get(split(e.edge.to)[0]).push(split(e.edge.from)[0]);
    const definitions = (band) => graph.swimlanes.filter((lane) => lane.stages.includes(band.id));
    const cell = Math.max(244, ...result.nodes.map((n) => n.width)) + 112;
    const width = Math.max(
      1240,
      ...result.stages.map((band) => Math.max(2, definitions(band).length) * cell + 112),
    );
    let top = 24;
    result.swimlanes = [];
    for (const band of result.stages) {
      const defs = definitions(band),
        lanes = new Set(defs.map((d) => d.id)),
        rows = [];
      const ns = result.nodes
        .filter((n) => n.node.stage === band.id)
        .sort((a, b) => a.y - b.y || a.id.localeCompare(b.id));
      for (const n of ns) {
        const lane = lanes.has(n.node.swimlane) ? n.node.swimlane : null;
        let row = Math.max(
          0,
          ...parents
            .get(n.id)
            .map((id) => by.get(id))
            .filter((p) => p.compact_band === band.id)
            .map((p) => p.compact_row + 1),
        );
        while (
          rows[row] &&
          (rows[row].kind !== (lane ? "lanes" : "common") ||
            (lane
              ? rows[row].nodes.some((p) => p.node.swimlane === lane)
              : rows[row].nodes.length >= 2))
        )
          row++;
        if (!rows[row]) rows[row] = { kind: lane ? "lanes" : "common", nodes: [] };
        rows[row].nodes.push(n);
        n.compact_band = band.id;
        n.compact_row = row;
      }
      let y = top + (defs.length ? 94 : 52);
      for (const row of rows) {
        if (!row) {
          y += 104;
          continue;
        }
        const height = Math.max(...row.nodes.map((n) => n.height));
        row.nodes.forEach((n, index) => {
          const laneIndex = defs.findIndex((d) => d.id === n.node.swimlane);
          n.x =
            width / 2 +
            (laneIndex < 0
              ? index - (row.nodes.length - 1) / 2
              : laneIndex - (defs.length - 1) / 2) *
              cell;
          n.y = y + height / 2;
        });
        y += height + 104;
      }
      band.top = top;
      band.bottom = Math.max(top + 220, y - 104 + 52);
      band.empty = !ns.length;
      defs.forEach((lane, index) =>
        result.swimlanes.push({
          ...lane,
          stage: band.id,
          x: width / 2 + (index - (defs.length - 1) / 2) * cell,
          width: cell - 28,
        }),
      );
      top = band.bottom + 40;
    }
    result.width = width;
    result.height = top - 16;
    result.compact = true;
    return result;
  }
  // Fold each lifecycle band into short, alternating horizontal rows. The
  // topological order comes from Dagre; cross-lane parents constrain row numbers.
  // No stages, nodes or scientific edges are created by this presentation pass.
  function compactStages(result, graph) {
    const compare = graph.comparison_layout === "shared-center",
      lanes = compare ? ["a", "shared", "b"] : ["single"],
      lane = (n) => (compare ? n.node.status : "single"),
      gap = 112,
      margin = 56,
      laneGap = 144;
    for (const n of result.nodes) if (!n.compound) Object.assign(n, labelLayout(n.node, 7, 244));
    const bands = result.stages.length ? result.stages : [{ id: "@all", index: 0 }],
      by = new Map(result.nodes.map((n) => [n.id, n])),
      parents = new Map(result.nodes.map((n) => [n.id, []]));
    for (const e of result.edges) parents.get(split(e.edge.to)[0]).push(split(e.edge.from)[0]);
    const columnCounts = new Map(),
      widths = Object.fromEntries(lanes.map((k) => [k, 0]));
    for (const band of bands)
      for (const k of lanes) {
        const ns = result.nodes.filter(
            (n) => (!result.stages.length || n.node.stage === band.id) && lane(n) === k,
          ),
          cols = k === "shared" ? 1 : Math.min(ns.length, ns.length >= 8 ? 3 : 2);
        columnCounts.set(band.id + "|" + k, cols);
        const normal = ns.filter((n) => n.compound?.kind !== "detail_group"),
          w = Math.max(
            0,
            ...ns.filter((n) => n.compound?.kind === "detail_group").map((n) => n.width),
            normal.length ? Math.max(...normal.map((n) => n.width)) * cols + gap * (cols - 1) : 0,
          );
        widths[k] = Math.max(widths[k], w);
      }
    const sides = compare && !!(widths.a || widths.b),
      side = sides ? Math.max(widths.a, widths.b) : 0,
      shared = compare ? Math.max(198, widths.shared) : 0,
      contentWidth = compare
        ? Math.max(1240, side * 2 + shared + (sides ? laneGap * 2 : 0) + margin * 2)
        : Math.max(1240, widths.single + margin * 2),
      cx = contentWidth / 2;
    const centers = compare
      ? {
          a: cx - shared / 2 - laneGap - side / 2,
          shared: cx,
          b: cx + shared / 2 + laneGap + side / 2,
        }
      : { single: cx };
    let top = 24;
    for (const band of bands) {
      const ns = result.nodes
          .filter((n) => !result.stages.length || n.node.stage === band.id)
          .sort((a, b) => a.rank - b.rank || a.x - b.x || a.id.localeCompare(b.id, "en")),
        cursor = Object.fromEntries(lanes.map((k) => [k, 0])),
        rows = [];
      for (const n of ns) {
        const k = lane(n),
          cols = columnCounts.get(band.id + "|" + k),
          minRow = Math.max(
            0,
            ...parents
              .get(n.id)
              .map((id) => by.get(id))
              .filter((p) => p.compact_band === band.id)
              .map(
                (p) =>
                  p.compact_row +
                  (p.compound?.kind === "detail_group" || n.compound?.kind === "detail_group"
                    ? 1
                    : 0),
              ),
          );
        const grouped = n.compound?.kind === "detail_group",
          base = Math.max(cursor[k], minRow * cols),
          slot = grouped ? Math.ceil(base / cols) * cols : base,
          row = Math.floor(slot / cols),
          col = slot % cols;
        cursor[k] = slot + (grouped ? cols : 1);
        n.compact_band = band.id;
        n.compact_row = row;
        n.compact_col = row % 2 ? cols - 1 - col : col;
        if (!rows[row]) rows[row] = [];
        rows[row].push(n);
      }
      let y = top + 52;
      for (const row of rows) {
        if (!row) {
          y += 104;
          continue;
        }
        const h = Math.max(...row.map((n) => n.height));
        for (const n of row) {
          const k = lane(n),
            cols = columnCounts.get(band.id + "|" + k),
            cell = Math.max(
              198,
              ...ns
                .filter((p) => lane(p) === k && p.compound?.kind !== "detail_group")
                .map((p) => p.width),
            );
          n.x =
            n.compound?.kind === "detail_group"
              ? centers[k]
              : centers[k] + (n.compact_col - (cols - 1) / 2) * (cell + gap);
          n.y = y + h / 2;
        }
        y += h + 104;
      }
      band.top = top;
      band.bottom = Math.max(top + 220, y - 104 + 52);
      band.empty = !ns.length;
      top = band.bottom + 40;
    }
    result.width = contentWidth;
    result.height = top - 16;
    result.compact = true;
    // Orient/reorder a row toward its actual cross-lane inputs, rather than
    // forcing every phase to start at the left. Penalize routing through a box
    // before distance, so shared → A can naturally read right-to-left.
    const wires = result.edges.map((e) => [
        by.get(split(e.edge.from)[0]),
        by.get(split(e.edge.to)[0]),
      ]),
      groups = new Map();
    for (const n of result.nodes) {
      const key = n.compact_band + "|" + n.compact_row + "|" + lane(n);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(n);
    }
    const cost = () => {
      let value = 0;
      const lines = wires.map(([a, b]) => ({
        a: { x: a.x, y: a.y },
        b: { x: b.x, y: b.y },
        ids: [a.id, b.id],
      }));
      for (const s of lines) {
        value += Math.abs(s.a.x - s.b.x) + 0.05 * Math.abs(s.a.y - s.b.y);
        for (const n of result.nodes)
          if (
            !s.ids.includes(n.id) &&
            R.hit(s.a, s.b, {
              x: n.x - n.width / 2,
              y: n.y - n.height / 2,
              width: n.width,
              height: n.height,
            })
          )
            value += Math.abs(s.a.y - s.b.y) < 0.001 ? 200000 : 2000;
      }
      for (let i = 0; i < lines.length; i++)
        for (let j = i + 1; j < lines.length; j++)
          if (
            !lines[i].ids.some((id) => lines[j].ids.includes(id)) &&
            R.intersection(lines[i], lines[j])
          )
            value += 1000;
      return value;
    };
    let best = cost();
    for (let sweep = 0; sweep < 2; sweep++)
      for (const row of groups.values()) {
        row.sort((a, b) => a.x - b.x || a.id.localeCompare(b.id, "en"));
        for (let i = 0; i < row.length - 1; i++) {
          const a = row[i],
            b = row[i + 1];
          [a.x, b.x] = [b.x, a.x];
          const next = cost();
          if (next < best) {
            best = next;
            [a.compact_col, b.compact_col] = [b.compact_col, a.compact_col];
            [row[i], row[i + 1]] = [b, a];
          } else [a.x, b.x] = [b.x, a.x];
        }
      }
    if (compare)
      result.comparison_lanes = {
        center: cx,
        has_sides: sides,
        lanes: lanes.map((id) => ({
          id,
          center: centers[id],
          width: id === "shared" ? shared : side,
          left: centers[id] - (id === "shared" ? shared : side) / 2,
          right: centers[id] + (id === "shared" ? shared : side) / 2,
        })),
      };
    return result;
  }
  // Dagre owns ranks/stages. This horizontal constraint makes the comparison's
  // shared structure central without adding, deleting or reclassifying an edge.
  function centerShared(result) {
    const gap = 56,
      laneGap = 144,
      margin = 56,
      width = 198;
    const buckets = { a: [], shared: [], b: [] };
    for (const n of result.nodes) buckets[n.node.status].push(n);
    const rows = {},
      maxWidth = {};
    for (const lane of ["a", "shared", "b"]) {
      const groups = [];
      let row = null;
      for (const n of [...buckets[lane]].sort(
        (a, b) =>
          a.y - a.height / 2 - (b.y - b.height / 2) || a.x - b.x || a.id.localeCompare(b.id, "en"),
      )) {
        const top = n.y - n.height / 2,
          bottom = n.y + n.height / 2;
        if (!row || top >= row.bottom + gap) {
          row = { nodes: [], bottom };
          groups.push(row);
        }
        row.nodes.push(n);
        row.bottom = Math.max(row.bottom, bottom);
      }
      for (const group of groups) {
        group.nodes.sort((a, b) => a.x - b.x || a.id.localeCompare(b.id, "en"));
        group.lane = lane;
        group.gap = gap;
        group.width = group.nodes.reduce((s, n) => s + n.width, 0) + gap * (group.nodes.length - 1);
      }
      rows[lane] = groups;
      maxWidth[lane] = Math.max(0, ...groups.map((g) => g.width));
    }
    const sides = !!(buckets.a.length || buckets.b.length),
      sideWidth = sides ? Math.max(width, maxWidth.a, maxWidth.b) : 0,
      sharedWidth = Math.max(width, maxWidth.shared),
      between = sides ? laneGap : 0;
    const contentWidth = Math.max(
        result.stages.length ? 920 : 1240,
        sideWidth * 2 + between * 2 + sharedWidth + margin * 2,
      ),
      cx = contentWidth / 2;
    const centers = {
      a: cx - sharedWidth / 2 - between - sideWidth / 2,
      shared: cx,
      b: cx + sharedWidth / 2 + between + sideWidth / 2,
    };
    for (const lane of ["a", "shared", "b"])
      for (const row of rows[lane]) {
        let left = centers[lane] - row.width / 2;
        for (const n of row.nodes) {
          n.x = left + n.width / 2;
          left += n.width + gap;
        }
      }
    result.width = contentWidth;
    result.comparison_lanes = {
      center: cx,
      has_sides: sides,
      lanes: ["a", "shared", "b"].map((id) => ({
        id,
        center: centers[id],
        width: id === "shared" ? sharedWidth : sideWidth,
        left: centers[id] - (id === "shared" ? sharedWidth : sideWidth) / 2,
        right: centers[id] + (id === "shared" ? sharedWidth : sideWidth) / 2,
      })),
    };
    R.optimizeRows(result, Object.values(rows).flat(), centers);
    return result;
  }
  function automaticLayout(graph, routeEdges = true) {
    graph = productPresentation(groupPresentation(graph));
    if (graph.presentation_layout === "trunks") {
      const key = "trunks:" + canonical({ ...graph, aligned_width: undefined });
      if (layoutCache.has(key)) return clone(layoutCache.get(key));
      const l = layoutTrunks(
        graph,
        (n, detail) =>
          n.presentation_members || n.comparison_parts
            ? n.presentation_members && detail !== "full"
              ? labelLayout(n, 9, 300)
              : measure(n)
            : labelLayout(n, 9, 300),
        R,
        profile,
      );
      if (layoutCache.size > 180) layoutCache.clear();
      layoutCache.set(key, clone(l));
      return l;
    }
    const stages = graph.stages || [],
      key = canonical({
        stages,
        presentation_layout: graph.presentation_layout,
        collapsed: !!graph.collapsed,
        comparison_layout: graph.comparison_layout,
        preserve_draft_geometry: graph.preserve_draft_geometry,
        stage_heights: graph.stage_heights,
        swimlanes: graph.swimlanes,
        routeEdges,
        nodes: sorted(graph.nodes).map((n) => [
          n.id,
          n.label,
          n.label_math,
          n.stage,
          n.status,
          n.logical_common,
          n.comparison_parts,
          n.swimlane,
          n.fixed,
          n.layout,
          n.presentation_members,
          n.presentation_note,
        ]),
        edges: sorted(graph.edges).map((e) => [
          e.id,
          e.from,
          e.to,
          e.kind,
          e.status,
          e.from_member,
          e.to_member,
          e.to_members,
          e.presentation_edges,
          e.layout,
        ]),
      });
    if (layoutCache.has(key)) {
      const l = clone(layoutCache.get(key)),
        by = new Map(graph.nodes.map((n) => [n.id, n])),
        edges = new Map(graph.edges.map((e) => [e.id, e]));
      l.nodes.forEach((n) => (n.node = by.get(n.id)));
      l.edges.forEach((e) => (e.edge = edges.get(e.id)));
      return l;
    }
    const g = new dagre.graphlib.Graph({ multigraph: true });
    g.setGraph({
      rankdir: "TB",
      nodesep: 56,
      ranksep: 88,
      edgesep: 28,
      marginx: 64,
      marginy: 24,
      ranker: "network-simplex",
    });
    g.setDefaultEdgeLabel(() => ({}));
    for (const n of sorted(graph.nodes)) g.setNode(n.id, { ...measure(n), node: n });
    for (const e of sorted(graph.edges)) {
      const [from] = split(e.from),
        [to] = split(e.to);
      g.setEdge(from, to, { edge: e }, e.id);
    }
    // Invisible boundary anchors enforce lifecycle order without inventing scientific edges.
    for (const [i, stage] of stages.entries()) {
      const start = "@stage-start-" + stage.id,
        end = "@stage-end-" + stage.id;
      g.setNode(start, { width: 1, height: 0, virtual: true });
      g.setNode(end, { width: 1, height: 0, virtual: true });
      g.setEdge(
        start,
        end,
        { weight: 0, minlen: graph.nodes.some((n) => n.stage === stage.id) ? 1 : 2 },
        "@span-" + i,
      );
      if (i) g.setEdge("@stage-end-" + stages[i - 1].id, start, { weight: 0 }, "@next-" + i);
      for (const n of sorted(graph.nodes).filter((n) => n.stage === stage.id)) {
        g.setEdge(start, n.id, { weight: 0 }, "@enter-" + n.id);
        g.setEdge(n.id, end, { weight: 0 }, "@leave-" + n.id);
      }
    }
    dagre.layout(g);
    const stageBands = stages.map((stage, i) => ({
      ...stage,
      top: g.node("@stage-start-" + stage.id).y - 24,
      bottom: g.node("@stage-end-" + stage.id).y + 32,
      empty: !graph.nodes.some((n) => n.stage === stage.id),
      index: i,
    }));
    let result = {
      width: g.graph().width,
      height: g.graph().height,
      nodes: g
        .nodes()
        .filter((id) => !g.node(id).virtual)
        .map((id) => ({ id, ...g.node(id) })),
      edges: g
        .edges()
        .filter((e) => g.edge(e).edge)
        .map((e) => ({ id: e.name, ...g.edge(e) })),
      stages: stageBands,
    };
    if (graph.swimlanes?.length && graph.comparison_layout !== "shared-center") {
      result = swimlaneStages(result, graph);
    } else if (graph.presentation_layout === "compact") {
      const candidate = compactStages(clone(result), graph),
        by = new Map(candidate.nodes.map((n) => [n.id, n])),
        horizontal = candidate.edges.some((e) => {
          const a = by.get(split(e.edge.from)[0]),
            b = by.get(split(e.edge.to)[0]);
          return a.compact_band === b.compact_band && a.compact_row === b.compact_row;
        });
      if (horizontal || candidate.height < result.height) result = candidate;
      else if (graph.comparison_layout === "shared-center") result = centerShared(result);
    } else if (graph.comparison_layout === "shared-center") result = centerShared(result);
    if (graph.stage_heights && result.stages.length) {
      let top = 24;
      for (const band of result.stages) {
        const delta = top - band.top,
          height = Math.max(band.bottom - band.top, graph.stage_heights[band.id] || 0);
        for (const node of result.nodes) if (node.node.stage === band.id) node.y += delta;
        band.top = top;
        band.bottom = top + height;
        top = band.bottom + 40;
      }
      result.height = top - 16;
    }
    if (!routeEdges) {
      layoutCache.set(key, clone(result));
      return result;
    }
    result = R.route(result, graph);
    const gutter = stages.length ? 320 : 0;
    result.nodes.forEach((n) => (n.x += gutter));
    result.swimlanes?.forEach((lane) => (lane.x += gutter));
    result.edges.forEach((e) => e.points.forEach((p) => (p.x += gutter)));
    if (result.comparison_lanes) {
      result.comparison_lanes.center += gutter;
      for (const lane of result.comparison_lanes.lanes)
        for (const k of ["center", "left", "right"]) lane[k] += gutter;
    }
    for (const event of result.routing.events) event.x += gutter;
    for (const change of [
      ...(result.routing.node_alignments || []),
      ...(result.routing.quality_optimizer?.changes || []),
      ...(result.routing.quality_optimizer?.remaining || []),
      ...(result.routing.post_node_search?.changes || []),
    ])
      for (const k of ["from_x", "to_x"]) if (Number.isFinite(change[k])) change[k] += gutter;
    result.width += gutter;
    result.gutter = gutter;
    const endpoints = new Map(result.nodes.map((n) => [n.id, n]));
    for (const edge of result.edges) {
      edge.from = endpoints.get(split(edge.edge.from)[0]);
      edge.to = endpoints.get(split(edge.edge.to)[0]);
    }
    connectChildren(result, R);
    if (layoutCache.size > 180) layoutCache.clear();
    layoutCache.set(key, clone(result));
    return result;
  }
  function layout(graph, routeEdges = true) {
    const result = automaticLayout(
      { ...graph, preserve_draft_geometry: !!hasDraft(graph.presentation_edits), presentation_edits: undefined, presentation_editor_lane: undefined },
      routeEdges,
    );
    // Stage measurement has no routed terminals to which an edit can attach.
    return routeEdges ? applyDraft(result, graph.presentation_edits, R) : result;
  }
  const colors = {
    shared: { stroke: "#9c6b06", fill: "#fffdf5" },
    a: { stroke: "#0072b2", fill: "#ffffff" },
    b: { stroke: "#c23e4e", fill: "#ffffff" },
    single: { stroke: "#364e59", fill: "#ffffff" },
  };
  const safeStatus = (value) => Object.hasOwn(colors, value) ? value : "single";
  function comparisonHeaders(l, top, mode) {
    if (!l.comparison_lanes) return "";
    const { lanes, has_sides, center } = l.comparison_lanes;
    return `<g class="comparison-lanes" data-center="${center}" aria-label="对齐居中，A左B右">${lanes
      .filter((lane) => has_sides || lane.id === "shared")
      .map(
        (lane) =>
          `<g class="comparison-lane" data-lane="${esc(lane.id)}" data-left="${lane.left}" data-right="${lane.right}"><text x="${lane.center}" y="${top - 16}" text-anchor="middle" font-size="23" font-weight="600" style="fill:${colors[safeStatus(lane.id)].stroke}">${lane.id === "a" ? "A 未配对 · 左侧" : lane.id === "b" ? "B 未配对 · 右侧" : mode === "logical" ? "所选字段对齐 · 中央" : "签名对齐 · 中央"}</text></g>`,
      )
      .join("")}</g>`;
  }
  function mathLabel(m, x, y) {
    const box = m.viewBox.split(/\s+/).map(Number),
      scale = m.width / box[2];
    return `<g class="node-math" transform="translate(${x} ${y}) scale(${scale}) translate(${-box[0]} ${-box[1]})" role="img" aria-label="${esc(m.alt)}" data-latex="${esc(m.latex)}" style="color:#20323d"><title>${esc(m.alt + " · " + m.latex)}</title>${m.body}</g>`;
  }
  function nodeContent(obj, n, x, y, c, status) {
    const badge =
      n.equivalence === "logical"
        ? (n.spec_differences?.length ? "逻辑对齐 · 声明有差异" : "逻辑对齐 · 所选字段一致")
        : n.equivalence === "strict"
          ? (n.spec_differences?.length ? "签名对齐 · 声明有差异" : "签名字段一致")
          : status === "a"
            ? "A 未配对 · " + n.state.slice(0, 6)
            : status === "b"
              ? "B 未配对 · " + n.state.slice(0, 6)
              : n.state.slice(0, 10);
    if (!obj.compound)
      return `<g class="outline" stroke="${c.stroke}" fill="${c.fill}" ${status === "a" || status === "b" ? 'stroke-dasharray="8 5"' : ""}>${shape(n, x, y, obj.width, obj.height)}</g>${obj.lines
        .map((line, i) => {
          const m = obj.mathRows?.[i],
            offset = obj.lineOffsets?.[i] ?? i * 37;
          return m
            ? mathLabel(
                m,
                obj.x - m.width / 2,
                y + 16 + offset + (Math.max(37, m.height + 8) - m.height) / 2,
              )
            : `<text class="node-label" x="${obj.x}" y="${y + 39 + offset}" text-anchor="middle">${esc(line)}</text>`;
        })
        .join(
          "",
        )}<text class="node-status" x="${obj.x}" y="${y + obj.height - 13}" text-anchor="middle" style="fill:${c.stroke}">${esc(badge)}</text>`;
    const { headH, partH, parts } = obj.compound,
      childY = y + headH + 48,
      childW = (obj.width - 56) / 2,
      headerBottom = y + 14 + headH;
    let text = `<g class="outline" stroke="${c.stroke}" fill="white"><rect x="${x}" y="${y}" width="${obj.width}" height="${obj.height}" rx="10"/></g><g stroke="${c.stroke}" fill="${c.fill}" stroke-width="2">${shape(n, x + 18, y + 14, obj.width - 36, headH)}</g>${obj.lines.map((line, i) => `<text class="node-label" x="${obj.x}" y="${y + 53 + i * 37}" text-anchor="middle">${esc(line)}</text>`).join("")}<path d="M${obj.x} ${headerBottom} V${childY - 13} M${x + 18 + childW / 2} ${childY} V${childY - 13} H${x + obj.width - 18 - childW / 2} V${childY}" fill="none" stroke="${c.stroke}" stroke-width="2"/>`;
    for (const [i, p] of parts.entries()) {
      const px = x + 18 + i * (childW + 20),
        pc = colors[safeStatus(p.lane)];
      text += `<g class="comparison-part ${esc(p.lane)}" data-node-part="${esc(p.lane)}" role="button" tabindex="0" aria-label="${esc(String(p.lane).toUpperCase())}原声明：${esc(p.label)}"><g fill="${pc.fill}" stroke="${pc.stroke}" stroke-width="2" stroke-dasharray="8 5">${nodeKind(n) === "model" ? shape(n, px, childY, childW, partH) : `<rect x="${px}" y="${childY}" width="${childW}" height="${partH}" rx="5"/>`}</g><text x="${px + childW / 2}" y="${childY + 24}" text-anchor="middle" font-size="20" font-weight="700" style="fill:${pc.stroke}">${esc(String(p.lane).toUpperCase())} · 原声明</text>${p.lines.map((line, j) => `<text class="variant-label" x="${px + childW / 2}" y="${childY + 55 + j * 35}" text-anchor="middle" font-size="30">${esc(line)}</text>`).join("")}</g>`;
    }
    return (
      text +
      `<text class="node-status" x="${obj.x}" y="${y + obj.height - 13}" text-anchor="middle" style="fill:${c.stroke}">${esc(badge)}</text>`
    );
  }
  function displayEdges(graph, l) {
    const groups = new Map();
    for (const ed of [...l.edges, ...(l.group_branches || [])]) {
      const e = ed.edge,
        key =
          graph.collapsed && !e.draft
            ? canonical([split(e.from)[0], split(e.to)[0], e.status || "single", e.kind])
            : ed.id;
      if (!groups.has(key))
        groups.set(key, {
          ...ed,
          edge: e.presentation_edges?.[0] || e,
          trunk_relation: e.trunk_relation,
          bundle: [],
        });
      groups.get(key).bundle.push(...(e.presentation_edges || [e]));
    }
    return [...groups.values()];
  }
  function edgeContent(graph, l, top, W) {
    const routes = displayEdges(graph, l),
      obstacles = l.nodes.flatMap((n) =>
        n.compound?.kind === "detail_group"
          ? [
              ...childLayout(n),
              {
                id: n.id + "_heading",
                x: n.x,
                y:
                  n.y -
                  n.height / 2 +
                  n.compound.headingOffset +
                  28 +
                  (n.compound.headH - n.compound.headingOffset - 28) / 2,
                width: n.compound.headingWidth,
                height: n.compound.headH - n.compound.headingOffset - 28,
              },
            ]
          : [n],
      ),
      jump = R.bridges(routes, obstacles),
      boxes = obstacles.map((n) => ({
        x: n.x - n.width / 2 - 8,
        y: n.y - n.height / 2 + top - 8,
        width: n.width + 16,
        height: n.height + 16,
      })),
      labels = [],
      overlays = [],
      allSegments = routes.flatMap((r) =>
        R.segments(r.points).map((s) => ({
          ...s,
          id: r.id,
          a: { x: s.a.x, y: s.a.y + top },
          b: { x: s.b.x, y: s.b.y + top },
        })),
      );
    let out = "";
    const labelJobs = [];
    for (const ed of routes) {
      const e = ed.edge,
        status = safeStatus(e.status),
        c = colors[status],
        draw = R.path(ed.points, jump.assigned.get(ed.id), top),
        members = ed.bundle.map((e) => e.id),
        title = ed.bundle
          .map((e) => (e.label || e.semantic || "关系") + "：" + e.from + " → " + e.to + " · " + (e.kind || "未声明"))
          .join("\n"),
        attributes = `data-layout-edge-id="${esc(ed.id)}" data-edge-id="${esc(e.id)}" data-edge-members="${esc(JSON.stringify(members))}" tabindex="0" role="button" aria-label="${esc(title)}"`,
        line = { solid: "none", dashed: "8 5", dotted: "2 6" }[ed.manual_style],
        manualStyle = line
          ? ` style="stroke-dasharray:${line};stroke-linecap:${ed.manual_style === "dotted" ? "round" : "butt"}"`
          : "";
      out += `<g class="edge-interactive" ${attributes}><title>${esc(title)}</title><path class="edge ${status} ${esc(ed.trunk_relation || "")}" data-edge-id="${esc(e.id)}" data-from="${esc(e.from)}" data-to="${esc(e.to)}" data-axis="${esc(ed.axis || "vertical")}" data-from-side="${esc(ed.sides?.start || "bottom")}" data-to-side="${esc(ed.sides?.end || "top")}" d="${draw.d}" stroke="${c.stroke}" ${manualStyle} ${status === "a" || status === "b" ? 'stroke-dasharray="8 5"' : ""} ${ed.arrow === false ? "" : `marker-end="url(#arrow-${status})"`}/><path class="edge-hit" d="${draw.d}" stroke="transparent" stroke-width="16" fill="none"/></g>`;
      for (const bridge of draw.overlays)
        overlays.push({ ...bridge, status, color: c.stroke, id: ed.id, members, manualStyle });
      const label =
        ed.bundle.length > 1
          ? ed.bundle.length + "路关系"
          : e.label || profile.edgeLabels?.[e.kind] || graph.edge_labels?.[e.kind];
      if (label && !ed.auxiliary)
        labelJobs.push({
          ed,
          label,
          c,
          attributes,
          priority:
            prefersStraight(e)
              ? -1
              : ed.bundle.length > 1
                ? 0
                : 1,
        });
    }
    // Bridges paint after every wire, so their white casing also clears a wire
    // drawn later. They are visual overpasses, never junctions or new graph edges.
    for (const bridge of overlays)
      out += `<g class="wire-jump" data-over-edge="${esc(bridge.id)}" data-edge-members="${esc(JSON.stringify(bridge.members))}" pointer-events="none"><path d="${bridge.d}" fill="none" stroke="white" stroke-width="5.5" stroke-linecap="round" vector-effect="non-scaling-stroke"/><path d="${bridge.d}" fill="none" stroke="${bridge.color}" stroke-width="2.1" vector-effect="non-scaling-stroke" ${bridge.manualStyle || ""} ${bridge.status === "a" || bridge.status === "b" ? 'stroke-dasharray="8 5"' : ""}/></g>`;
    for (const { ed, label, c, attributes } of labelJobs.sort(
      (a, b) => a.priority - b.priority || a.ed.id.localeCompare(b.ed.id, "en"),
    )) {
      const short =
          ed.edge.short_label ||
          profile.edgeShortLabels?.[ed.edge.kind] ||
          graph.edge_short_labels?.[ed.edge.kind],
        choices = [label, ...(ed.bundle.length === 1 && short && short !== label ? [short] : [])];
      let pos = null,
        shown = label,
        width = 0;
      let height = 26;
      for (const candidate of choices) {
        shown = candidate;
        width = Math.max(
          candidate === label ? 68 : 44,
          [...candidate].reduce((s, ch) => s + (/[\x00-\xff]/.test(ch) ? 9 : 17), 0) + 16,
        );
        const segs = allSegments
          .filter((s) => s.id === ed.id)
          .sort((a, b) => b.length - a.length || a.i - b.i);
        for (const seg of segs) {
          if (pos) break;
          const horizontal = Math.abs(seg.a.y - seg.b.y) < 0.001;
          if (seg.length < (horizontal ? width + 18 : height + 22)) continue;
          for (const t of [0.5, 0.25, 0.75, 0.125, 0.875]) {
            if (pos) break;
            const x = seg.a.x + (seg.b.x - seg.a.x) * t,
              y = seg.a.y + (seg.b.y - seg.a.y) * t;
            for (const sign of [1, -1]) {
              const px = x + (horizontal ? 0 : sign * (width / 2 + 9)),
                py = y + (horizontal ? sign * (height / 2 + 8) : 0),
                r = { x: px - width / 2, y: py - height / 2, width, height };
              if (
                r.x < (l.gutter || 0) + 8 ||
                r.x + width > W - 10 ||
                [...boxes, ...labels].some(
                  (b) =>
                    r.x < b.x + b.width &&
                    r.x + r.width > b.x &&
                    r.y < b.y + b.height &&
                    r.y + r.height > b.y,
                )
              )
                continue;
              if (
                allSegments.some(
                  (s) =>
                    s.id !== ed.id &&
                    R.hit(s.a, s.b, {
                      x: r.x - 4,
                      y: r.y - 4,
                      width: width + 8,
                      height: height + 8,
                    }),
                ) ||
                overlays.some(
                  (b) =>
                    b.x > r.x - 12 &&
                    b.x < r.x + width + 12 &&
                    b.y > r.y - 12 &&
                    b.y < r.y + height + 12,
                )
              )
                continue;
              const leader = {
                x: Math.max(r.x, Math.min(r.x + r.width, x)),
                y: Math.max(r.y, Math.min(r.y + r.height, y)),
              };
              if (
                allSegments.some(
                  (s) => s.id !== ed.id && R.intersection(s, { a: leader, b: { x, y } }),
                )
              )
                continue;
              pos = { x: px, y: py, r, anchor: { x, y }, leader };
              break;
            }
          }
        }
        if (pos) break;
      }
      // A straight input can sit between several parallel wires. Keep its
      // complete label in a narrow stacked callout on its own track instead
      // of dropping it or putting the words across a neighboring wire.
      if (!pos) {
        const rows = wrap(label, 2);
        width = 44;
        height = rows.length * 18 + 10;
        for (const seg of allSegments.filter(
          (s) => s.id === ed.id && Math.abs(s.a.x - s.b.x) < 0.001 && s.length >= height + 16,
        )) {
          const px = seg.a.x,
            py = (seg.a.y + seg.b.y) / 2,
            r = { x: px - width / 2, y: py - height / 2, width, height };
          if (
            r.x < (l.gutter || 0) + 8 ||
            r.x + width > W - 10 ||
            overlays.some(
              (b) =>
                b.x > r.x - 12 &&
                b.x < r.x + width + 12 &&
                b.y > r.y - 12 &&
                b.y < r.y + height + 12,
            ) ||
            [...boxes, ...labels].some(
              (b) =>
                r.x < b.x + b.width &&
                r.x + width > b.x &&
                r.y < b.y + b.height &&
                r.y + height > b.y,
            ) ||
            allSegments.some(
              (s) =>
                s.id !== ed.id &&
                R.hit(s.a, s.b, { x: r.x - 4, y: r.y - 4, width: width + 8, height: height + 8 }),
            )
          )
            continue;
          const anchor = { x: px, y: r.y + height + 4 },
            leader = { x: px, y: r.y + height };
          if (
            allSegments.some((s) => s.id !== ed.id && R.intersection(s, { a: leader, b: anchor }))
          )
            continue;
          pos = { x: px, y: py, r, anchor, leader, rows };
          break;
        }
      }
      if (pos) {
        labels.push(pos.r);
        out += `<g class="edge-label" ${attributes}><title>${esc(label)}</title><path class="label-leader" d="M${pos.leader.x} ${pos.leader.y} L${pos.anchor.x} ${pos.anchor.y}" stroke="${c.stroke}" stroke-width="1.2" fill="none" vector-effect="non-scaling-stroke" pointer-events="none"/><circle class="label-anchor" cx="${pos.anchor.x}" cy="${pos.anchor.y}" r="4" fill="white" stroke="${c.stroke}" stroke-width="1.2" vector-effect="non-scaling-stroke" pointer-events="none"/><rect x="${pos.r.x}" y="${pos.r.y}" width="${width}" height="${height}" rx="3" fill="white" opacity=".98"/>${pos.rows ? pos.rows.map((row, i) => `<text x="${pos.x}" y="${pos.r.y + 19 + i * 18}" font-size="15" text-anchor="middle" style="fill:${c.stroke}">${esc(row)}</text>`).join("") : `<text x="${pos.x}" y="${pos.y + 6}" font-size="17" text-anchor="middle" style="fill:${c.stroke}">${esc(shown)}</text>`}</g>`;
      }
    }
    return { content: out, bridges: overlays.length, unbridged: jump.missed };
  }
  function svg(graph, options = {}) {
    const l = layout(graph),
      inputs = new Set(
        l.nodes
          .filter(
            (n) =>
              nodeKind(n.node) === "data" && !l.edges.some((e) => split(e.edge.to)[0] === n.id),
          )
          .map((n) => n.id),
      ),
      top = (options.title === false ? 10 : 72) + (l.comparison_lanes ? 44 : 0),
      foot = 28,
      W = Math.max(l.width, graph.aligned_width || 0, 1240),
      H = l.height + top + foot,
      physical = Math.max(183, (7.5 * 25.4 * W) / (30 * 72));
    let out = `<svg xmlns="http://www.w3.org/2000/svg" width="${physical.toFixed(3)}mm" height="${((physical * H) / W).toFixed(3)}mm" viewBox="0 0 ${W} ${H}" data-layout-top="${top}" role="img" aria-label="${esc(options.title || graph.name)}"><title>${esc(options.title || graph.name)}</title><style>text{font-family:Arial,'Noto Sans CJK SC','PingFang SC','Arial Unicode MS',sans-serif;fill:#1e2e34} .node,.edge-interactive,.edge-label{cursor:pointer} .node:focus,.edge-interactive:focus,.comparison-part:focus{outline:none;filter:drop-shadow(0 0 3px #0072b2)} .node .outline{stroke-width:2} .edge{stroke-width:2.1;fill:none;vector-effect:non-scaling-stroke} .edge.secondary{stroke-dasharray:3 7} .node.artifact .outline{stroke-width:2.8} .node.technology .outline{stroke-width:1.5} .node.control .outline{stroke-dasharray:3 5} .node-label{font-size:30px;font-weight:500} .node-status{font-size:18px} </style><rect width="100%" height="100%" fill="white"/><defs>${Object.entries(
      colors,
    )
      .map(
        ([k, c]) =>
          `<marker id="arrow-${k}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0 L10 5 L0 10Z" fill="${c.stroke}"/></marker>`,
      )
      .join("")}</defs>`;
    if (options.title !== false)
      out += `<text x="30" y="29" font-size="23" font-weight="600">${esc(options.title || graph.name)}</text><text x="30" y="53" font-size="13">${esc(graph.subtitle || profile.subtitle?.(graph) || "")}</text>`;
    if (l.flow_tree) {
      out += `<g class="data-trunk-headings"><text x="${l.gutter + 30}" y="${top + 30}" font-size="22">${l.tree_levels === "compact" ? "紧凑层级 · 依赖按箭头读取（含回接）" : "流程 ↓ · 分支与汇合"}</text></g>`;
    } else if (l.data_trunks) {
      out += `<g class="data-trunk-headings">${l.trunks.map((lane) => `<text x="${(lane.left + lane.right) / 2}" y="${top + 30}" text-anchor="middle" font-size="25" font-weight="600">${esc(lane.title)}</text><text x="${lane.x}" y="${top + 62}" text-anchor="middle" font-size="20">流程 ↓</text><line x1="${lane.x}" y1="${top + 80}" x2="${lane.x}" y2="${l.height + top}" stroke="#cbd1d8" stroke-width="1"/>`).join("")}</g>`;
    }
    for (const band of l.stages || []) {
      if (l.flow_tree) continue;
      if (l.data_trunks) {
        if (!band.empty)
          out += `<g class="stage-marker" data-stage-id="${esc(band.id)}" data-stage-top="${band.top + top}"><text x="18" y="${band.top + top + 20}" font-size="20">${esc(band.title)}</text><line x1="20" y1="${band.top + top + 30}" x2="135" y2="${band.top + top + 30}" stroke="#68717c"/></g>`;
        continue;
      }
      const y = band.top + top,
        h = band.bottom - band.top;
      out += `<g class="stage-band" data-stage-id="${esc(band.id)}" data-stage-top="${y}" data-stage-bottom="${band.bottom + top}"><rect x="6" y="${y}" width="${W - 12}" height="${h}" fill="${band.focus ? "#fffdf5" : "#ffffff"}" stroke="#d8e1e6"/><line x1="300" y1="${y + 12}" x2="300" y2="${y + h - 12}" stroke="${band.focus ? "#d99a32" : "#d7e0e6"}" stroke-width="${band.focus ? 3 : 1}"/><text x="27" y="${y + 30}" font-size="19" fill="#6d8290">${esc(band.section || "")} 阶段 ${String(band.index + 1).padStart(2, "0")}</text><text x="27" y="${y + 72}" font-size="29" font-weight="600">${esc(band.title)}</text>${wrap(
        band.caption,
        11,
      )
        .map((line, i) => `<text x="27" y="${y + 111 + i * 25}" font-size="20">${esc(line)}</text>`)
        .join(
          "",
        )}${band.empty ? `<text x="${l.gutter + 28}" y="${y + 76}" font-size="23" fill="#7b8e98">${graph.phase_schema ? "原流程未单列此阶段步骤" : "该流程没有此阶段的独立操作"}</text>` : ""}</g>`;
    }
    out += comparisonHeaders(l, top, graph.matching_mode);
    for (const lane of l.swimlanes || []) {
      const band = l.stages.find((b) => b.id === lane.stage),
        y = band.top + top;
      out += `<g class="experiment-swimlane" data-swimlane="${esc(lane.id)}" data-stage-id="${esc(lane.stage)}"><rect x="${lane.x - lane.width / 2}" y="${y + 8}" width="${lane.width}" height="${band.bottom - band.top - 16}" rx="6" fill="none" stroke="#9bafb9" stroke-dasharray="6 5"/><text x="${lane.x}" y="${y + 34}" text-anchor="middle" font-size="22" font-weight="600">${esc(lane.title)}</text><text x="${lane.x}" y="${y + 60}" text-anchor="middle" font-size="17">${esc(lane.note)}</text></g>`;
    }
    for (const obj of l.nodes)
      if (obj.compound?.kind === "detail_group") {
        const x = obj.x - obj.width / 2,
          y = obj.y - obj.height / 2 + top,
          c = colors[safeStatus(obj.node.status)];
        out += `<g class="dependency-group" data-layout-node-id="${esc(obj.id)}" data-group-id="${esc(obj.id)}" data-node-members="${esc(JSON.stringify(obj.node.presentation_members.map((n) => n.id)))}" tabindex="0" role="group" aria-label="${esc(obj.node.label)}"><rect x="${x}" y="${y}" width="${obj.width}" height="${obj.height}" rx="10" fill="white" stroke="${c.stroke}" stroke-width="2.5"/>${obj.lines.map((line, i) => `<text x="${obj.x}" y="${y + obj.compound.headingOffset + 55 + i * 37}" text-anchor="middle" font-size="30" font-weight="600">${esc(line)}</text>`).join("")}${obj.compound.noteLines.map((line, i) => `<text x="${obj.x}" y="${y + obj.compound.headingOffset + 48 + obj.lines.length * 37 + i * 25}" text-anchor="middle" font-size="20">${esc(line)}</text>`).join("")}</g>`;
      }
    const connections = edgeContent(graph, l, top, W);
    out += connections.content;
    for (const obj of l.nodes.flatMap((n) =>
      n.compound?.kind === "detail_group"
        ? childLayout(n).map((child) => ({ ...child, layout_owner: n.id }))
        : [n],
    )) {
      const n = obj.node,
        status = safeStatus(n.status),
        c = {
          ...colors[status],
          fill: n.product_owner ? "#eee4fa" : inputs.has(obj.id) ? "#fff3c4" : colors[status].fill,
        },
        x = obj.x - obj.width / 2,
        y = obj.y - obj.height / 2 + top;
      const aliases = n.presentation_aliases || n.presentation_members?.map((m) => m.id) || [],
        detailIds = aliases.length ? aliases : [n.id],
        displayId = n.presentation_aliases?.[0] || n.id;
      out += `<g class="node ${status} ${esc(n.trunk_role || "")}" data-input-resource="${inputs.has(obj.id)}" data-product-resource="${!!n.product_owner}" data-layout-node-id="${esc(obj.layout_owner || obj.id)}" data-detail-ids="${esc(JSON.stringify(detailIds))}" data-node-members="${esc(JSON.stringify(aliases))}" data-artifact-id="${n.presentation_aliases ? esc(n.id) : ""}" data-node-id="${esc(displayId)}" data-visual-kind="${esc(nodeKind(n))}" data-semantic-key="${esc(n.semantic_key)}" data-stage="${esc(n.stage || "")}" data-swimlane="${esc(n.swimlane || "")}" data-equivalence="${esc(n.equivalence || "")}" data-impacted="${!!n.impacted}" tabindex="0" role="button" aria-label="${esc(n.label)}"><title>${esc(n.detail || n.semantic_key)}</title>${nodeContent(obj, n, x, y, c, status)}${n.product_owner ? `<g class="artifact-inspect" data-artifact-action="${esc(n.id)}" tabindex="0" role="button" aria-label="查看或保存${esc(n.label)}的产物说明"><title>查看产物规格、来源并保存说明；产物是否生成需核对来源</title><rect x="${x + 14}" y="${y + obj.height - 35}" width="25" height="25" rx="4" fill="#f8f4fc" stroke="#745094"/><path d="M${x + 21} ${y + obj.height - 30} h10 v15 h-10z M${x + 24} ${y + obj.height - 26} h4 M${x + 24} ${y + obj.height - 22} h4" fill="none" stroke="#745094" stroke-width="1.5"/></g>` : ""}${inputs.has(obj.id) ? `<g class="input-resource-badge"><rect x="${obj.x - 48}" y="${y - 23}" width="96" height="21" rx="4" fill="#fff3c4" stroke="#ad7c00"/><text x="${obj.x}" y="${y - 7}" text-anchor="middle" font-size="15" style="fill:#161616">输入资源</text></g>` : ""}</g>`;
    }
    out += "</svg>";
    return {
      svg: out,
      layout: l,
      visible_edges: displayEdges(graph, l).filter((e) => !e.auxiliary).length,
      routing: { ...l.routing, bridges: connections.bridges, unbridged: connections.unbridged },
      width: W,
      height: H,
      physical_width_mm: physical,
      print_font_pt: (30 * physical * 72) / 25.4 / W,
    };
  }
  function mermaid(g) {
    g = productPresentation(g);
    const shapes = {
      data: ["[/", "/]"],
      method: ["[", "]"],
      model: ["[[", "]]"],
      representation: ["([", "])"],
      output: ["{{", "}}"],
      decision: ["{", "}"],
    };
    let out = "flowchart TB\n";
    const emit = (n) => {
      const [a, b] = n.shape === "database" ? ["[(", ")]"] : shapes[nodeKind(n)];
      return `    ${n.id}${a}"${n.label.replaceAll("\n", " · ").replaceAll('"', "'")}"${b}\n`;
    };
    if (g.stages?.length) {
      for (const [i, stage] of g.stages.entries()) {
        out += `  subgraph phase_${stage.id}["${i + 1} · ${stage.title}"]\n`;
        for (const n of sorted(g.nodes).filter((n) => n.stage === stage.id)) out += emit(n);
        out += "  end\n";
      }
    } else for (const n of sorted(g.nodes)) out += emit(n);
    for (const e of sorted(g.edges))
      out += `  ${split(e.from)[0]} -->|"${e.kind || "未声明"}: ${e.semantic || ""}"| ${split(e.to)[0]}\n`;
    return out;
  }
  function alignStageLayouts(a, b) {
    if (a.presentation_layout === "trunks" || b.presentation_layout === "trunks") {
      const width = Math.max(layout(a).width, layout(b).width);
      return { a: { ...a, aligned_width: width }, b: { ...b, aligned_width: width } };
    }
    if (!a.phase_schema || a.phase_schema !== b.phase_schema) return { a, b };
    const natural = [layout(a, false), layout(b, false)],
      stage_heights = {};
    for (const result of natural)
      for (const band of result.stages)
        stage_heights[band.id] = Math.max(stage_heights[band.id] || 0, band.bottom - band.top);
    const pair = { a: { ...a, stage_heights }, b: { ...b, stage_heights } };
    const width = Math.max(layout(pair.a).width, layout(pair.b).width);
    pair.a.aligned_width = pair.b.aligned_width = width;
    return pair;
  }
  return {
    canonical,
    instantiate,
    lint,
    signature,
    logicalSignature,
    match,
    merge,
    collapse,
    layout,
    alignStageLayouts,
    displayEdges,
    svg,
    mermaid,
    changes,
    split,
  };
};
export default createGraph(dagre, routing, svgMath);
