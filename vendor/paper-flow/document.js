import { defaultView, defaultComparison, normalizeGraph } from "./model.js";
export { defaultView, defaultComparison, normalizeGraph } from "./model.js";
import { compareFlows, prepareGraph } from "./comparison.js";
import engine from "./core/graph.js";
import { emptyDraft } from "./core/editing.js";
import { budgetFlowInput } from "./budget.js";
const copy = (value) => structuredClone(value);
const object = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const text = (v) => typeof v === "string" && !!v.trim();
export const flowKey = (ref) => JSON.stringify([ref.documentId, ref.flowId]);
export const draftKey = (ref, view) =>
  JSON.stringify([
    ref.documentId,
    ref.flowId,
    view.arrangement,
    view.treeLevels,
    view.detail,
    view.grouping,
  ]);
export function resolveFlow(workspace, ref) {
  return workspace.documents
    .find((d) => d.paper.id === ref?.documentId)
    ?.flows.find((g) => g.id === ref?.flowId);
}
export function createWorkspace(documents, selection) {
  const first = documents[0];
  if (!first?.flows.length) throw Error("至少需要一份含流程的论文文档");
  return {
    schemaVersion: 1,
    kind: "paper-flow-workspace",
    documents: copy(documents),
    selection: selection || { left: { documentId: first.paper.id, flowId: first.flows[0].id } },
    view: defaultView(),
    comparison: defaultComparison(),
    drafts: {},
  };
}
export function validateGraph(g, path = "graph") {
  const diagnostics = [];
  const add = (code, p, message) => diagnostics.push({ severity: "error", code, path: p, message });
  if (
    !object(g) ||
    !text(g.id) ||
    !text(g.name) ||
    !Array.isArray(g.nodes) ||
    !g.nodes.length ||
    !Array.isArray(g.edges)
  ) {
    add("graph.shape", path, "流程需包含 id、name、非空 nodes 和 edges 数组");
    return diagnostics;
  }
  const nodeIds = new Set(),
    edgeIds = new Set();
  for (const [i, n] of g.nodes.entries()) {
    const p = `${path}.nodes[${i}]`;
    if (
      !object(n) ||
      !text(n.id) ||
      n.id.includes(":") ||
      !text(n.label) ||
      !["data", "method", "model", "representation", "output", "decision"].includes(n.type) ||
      !object(n.ports?.in) ||
      !object(n.ports?.out)
    ) {
      add("node.shape", p, "节点需有无冒号的 id、label、类型及 in/out 端口");
      continue;
    }
    if (nodeIds.has(n.id)) add("node.duplicate", p + ".id", "重复节点 ID");
    nodeIds.add(n.id);
    for (const key of ["op", "semantic_key", "detail", "evidence"])
      if (n[key] !== undefined && typeof n[key] !== "string")
        add("node.field", p + "." + key, "需为文本");
    if (n.config !== undefined && !object(n.config))
      add("node.config", p + ".config", "config 需为对象");
    if (
      n.logical !== undefined &&
      (!object(n.logical) || !text(n.logical.key) || !text(n.logical.function))
    )
      add("node.logical", p + ".logical", "比较契约需声明 key 和 function");
    if (n.display_outputs !== undefined) {
      if (!object(n.display_outputs))
        add("product.shape", p + ".display_outputs", "具名产物需为端口到说明的对象");
      else
        for (const [port, description] of Object.entries(n.display_outputs))
          if (!n.ports.out[port] || !object(description) || !text(description.label))
            add(
              "product.port",
              p + ".display_outputs." + port,
              "具名产物需引用存在的输出端口并声明名称",
            );
    }
    for (const direction of ["in", "out"])
      for (const [key, port] of Object.entries(n.ports[direction]))
        if (!text(key) || key.includes(":") || !object(port) || !text(port.type))
          add(
            "port.shape",
            p + ".ports." + direction + "." + key,
            "端口名称不得含冒号，并需声明 type",
          );
  }
  for (const [i, e] of g.edges.entries()) {
    const p = `${path}.edges[${i}]`;
    if (
      !object(e) ||
      !text(e.id) ||
      !text(e.from) ||
      !text(e.to) ||
      e.from.split(":").length !== 2 ||
      e.to.split(":").length !== 2
    ) {
      add("edge.shape", p, "关系需有 id 和 node:port 格式的 from/to");
      continue;
    }
    for (const key of ["kind", "semantic", "label"])
      if (e[key] !== undefined && typeof e[key] !== "string")
        add("edge.field", p + "." + key, "需为文本");
    if (e.trunk_relation !== undefined && !["lineage", "secondary", "technology"].includes(e.trunk_relation))
      add("edge.field", p + ".trunk_relation", "关系样式无效");
    if (edgeIds.has(e.id)) add("edge.duplicate", p + ".id", "重复关系 ID");
    edgeIds.add(e.id);
  }
  if (
    g.stages !== undefined &&
    (!Array.isArray(g.stages) || g.stages.some((s) => !object(s) || !text(s.id) || !text(s.title)))
  )
    add("stage.shape", path + ".stages", "阶段需包含 id 和 title");
  for (const key of ["paper_groups", "detail_groups"]) {
    if (g[key] !== undefined && !Array.isArray(g[key])) {
      add("group.shape", path + "." + key, "分组需为数组");
      continue;
    }
    const groups = new Set(),
      used = new Set();
    for (const [i, group] of (g[key] || []).entries()) {
      const p = `${path}.${key}[${i}]`;
      if (
        !object(group) ||
        !text(group.id) ||
        !text(group.label) ||
        !Array.isArray(group.members) ||
        !group.members.length
      ) {
        add("group.shape", p, "分组需有 id、label 和非空 members");
        continue;
      }
      if (groups.has(group.id) || nodeIds.has(group.id))
        add("group.duplicate", p + ".id", "分组 ID 重复或与节点冲突");
      groups.add(group.id);
      for (const member of group.members) {
        if (!nodeIds.has(member)) add("group.member", p + ".members", "分组成员不存在：" + member);
        if (used.has(member))
          add("group.overlap", p + ".members", "成员重复或属于重叠分组：" + member);
        used.add(member);
      }
    }
  }
  if (!diagnostics.length) {
    const normalized = normalizeGraph(g);
    for (const d of engine.lint(normalized)) add("graph.structure", path + "." + d.path, d.message);
    if (!diagnostics.length && g.paper_groups?.length)
      try {
        for (const d of engine.lint(engine.collapse(normalized)))
          add("group.structure", path + ".paper_groups", d.message);
      } catch (e) {
        add("group.structure", path + ".paper_groups", e.message);
      }
  }
  return diagnostics;
}
export function validateDocument(d, path = "document") {
  const diagnostics = [];
  const err = (code, p, message) => diagnostics.push({ severity: "error", code, path: p, message });
  if (
    !object(d) ||
    d.schemaVersion !== 1 ||
    d.kind !== "paper-flow-document" ||
    !object(d.paper) ||
    !text(d.paper.id) ||
    !text(d.paper.title) ||
    !Array.isArray(d.flows) ||
    !d.flows.length
  ) {
    err(
      "document.shape",
      path,
      "需要 schemaVersion:1、paper-flow-document、paper.id/title 以及非空 flows",
    );
    return diagnostics;
  }
  if (
    d.paper.sources !== undefined &&
    (!Array.isArray(d.paper.sources) || d.paper.sources.some((v) => typeof v !== "string"))
  )
    err("paper.sources", path + ".paper.sources", "来源需为文本数组");
  const ids = new Set();
  d.flows.forEach((g, i) => {
    if (ids.has(g?.id)) err("flow.duplicate", `${path}.flows[${i}].id`, "重复流程 ID");
    ids.add(g?.id);
    diagnostics.push(...validateGraph(g, `${path}.flows[${i}]`));
  });
  return diagnostics;
}
function validateDraft(d, path, graph) {
  const errors = [],
    add = (message) => errors.push({ severity: "error", code: "draft.shape", path, message });
  if (!object(d) || !object(d.nodes) || !object(d.edges) || !Array.isArray(d.relations)) {
    add("草稿需包含 nodes、edges、relations");
    return errors;
  }
  for (const [id, n] of Object.entries(d.nodes))
    if (!object(n) || ![n.x, n.y].every((v) => Number.isFinite(v) && v >= 0 && v <= 50000))
      add("节点坐标必须在0–50000范围内：" + id);
  for (const [id, e] of Object.entries(d.edges)) {
    if (!object(e)) {
      add("无效关系草稿：" + id);
      continue;
    }
    if (e.line !== undefined && !["auto", "solid", "dashed", "dotted"].includes(e.line))
      add("无效线型：" + id);
    for (const end of ["start", "end"])
      if (
        e[end] !== undefined &&
        (!object(e[end]) ||
          !["top", "right", "bottom", "left"].includes(e[end].side) ||
          !Number.isFinite(e[end].offset) ||
          e[end].offset < 0 ||
          e[end].offset > 1)
      )
        add("无效接点：" + id);
    if (
      e.route !== undefined &&
      (!Array.isArray(e.route) ||
        e.route.length < 2 ||
        e.route.length > 80 ||
        e.route.some(
          (p) => !object(p) || ![p.x, p.y].every((v) => Number.isFinite(v) && v >= 0 && v <= 50000),
        ))
    )
      add("无效转折路径：" + id);
  }
  for (const relation of d.relations)
    if (!object(relation) || ![relation.id, relation.from, relation.to].every(text))
      add("临时关系缺少 id/from/to");
  if (graph && !errors.length)
    try {
      engine.svg({ ...graph, presentation_edits: d }, { title: false });
    } catch (e) {
      add(e.message);
    }
  return errors;
}
function parseFlowInputBounded(input) {
  const diagnostics = [];
  const add = (code, path, message) => diagnostics.push({ severity: "error", code, path, message });
  const bounded = budgetFlowInput(input);
  if (!bounded.ok) return bounded;
  let raw = bounded.value;
  // Old pairs remain importable; no Paper1 data or stage alignment is injected.
  if (object(raw) && raw.a && raw.b && !raw.kind) {
    diagnostics.push(...validateGraph(raw.a, "$.a"), ...validateGraph(raw.b, "$.b"));
    if (diagnostics.length) return { ok: false, diagnostics };
    raw = createWorkspace(
      [raw.a, raw.b].map((g, i) => ({
        schemaVersion: 1,
        kind: "paper-flow-document",
        paper: { id: `import-${i}`, title: g.name || `图${i + 1}` },
        flows: [g],
      })),
      {
        left: { documentId: "import-0", flowId: raw.a.id },
        right: { documentId: "import-1", flowId: raw.b.id },
      },
    );
  }
  if (raw?.kind === "paper-flow-document") {
    diagnostics.push(...validateDocument(raw));
    if (diagnostics.length) return { ok: false, diagnostics };
    raw = createWorkspace([raw]);
  }
  if (
    !object(raw) ||
    raw.schemaVersion !== 1 ||
    raw.kind !== "paper-flow-workspace" ||
    !Array.isArray(raw.documents) ||
    !raw.documents.length
  ) {
    add("workspace.shape", "$", "需要版本1的论文文档或工作区");
    return { ok: false, diagnostics };
  }
  const docIds = new Set();
  raw.documents.forEach((d, i) => {
    diagnostics.push(...validateDocument(d, `$.documents[${i}]`));
    if (docIds.has(d?.paper?.id))
      add("document.duplicate", `$.documents[${i}].paper.id`, "重复论文 ID");
    docIds.add(d?.paper?.id);
  });
  if (diagnostics.length) return { ok: false, diagnostics };
  for (const key of ["view", "comparison", "drafts"])
    if (raw[key] !== undefined && !object(raw[key])) add("workspace.field", "$." + key, "需为对象");
  if (diagnostics.length) return { ok: false, diagnostics };
  const value = {
    ...raw,
    view: { ...defaultView(), ...raw.view },
    comparison: { ...defaultComparison(), ...raw.comparison },
    drafts: raw.drafts || {},
  };
  for (const side of ["left", "right"]) {
    const ref = value.selection?.[side];
    if (side === "left" || ref !== undefined)
      if (!object(ref) || !resolveFlow(value, ref))
        add("selection.missing", "$.selection." + side, "论文或流程不存在");
  }
  if (diagnostics.length) return { ok: false, diagnostics };
  const v = value.view;
  if (
    !["trunks", "compact", "vertical"].includes(v.arrangement) ||
    !["expanded", "compact"].includes(v.treeLevels) ||
    !["full", "overview"].includes(v.detail) ||
    !["parallel", "merged"].includes(v.mode) ||
    !(v.zoom === "fit" || (Number.isFinite(v.zoom) && v.zoom > 0 && v.zoom <= 4)) ||
    typeof v.grouping !== "boolean" ||
    typeof v.hoverMotion !== "boolean"
  )
    add("view.shape", "$.view", "无效显示配置");
  const c = value.comparison;
  if (
    !["strict", "logical"].includes(c.mode) ||
    !Array.isArray(c.correspondences) ||
    !Array.isArray(c.exclusions)
  ) {
    add("comparison.shape", "$.comparison", "无效比较配置");
  } else {
    const a = resolveFlow(value, value.selection.left),
      b = resolveFlow(value, value.selection.right);
    const exists = (g, id, kind) =>
      kind === "group"
        ? (g?.paper_groups || []).some((n) => n.id === id)
        : g?.nodes.some((n) => n.id === id);
    const ids = new Set(),
      usedA = new Set(),
      usedB = new Set();
    for (const [i, p] of c.correspondences.entries())
      if (
        !object(p) ||
        !text(p.id) ||
        ids.has(p.id) ||
        usedA.has(p.kind + ":" + p.a) ||
        usedB.has(p.kind + ":" + p.b) ||
        !text(p.reason) ||
        !["node", "group"].includes(p.kind) ||
        !exists(a, p.a, p.kind) ||
        !exists(b, p.b, p.kind)
      )
        add(
          "comparison.correspondence",
          `$.comparison.correspondences[${i}]`,
          "对应需有唯一ID、两侧有效节点或分组、类型及理由",
        );
      else {
        ids.add(p.id);
        usedA.add(p.kind + ":" + p.a);
        usedB.add(p.kind + ":" + p.b);
      }
    for (const [i, p] of c.exclusions.entries())
      if (!object(p) || !exists(a, p.a, "node") || !exists(b, p.b, "node"))
        add("comparison.exclusion", `$.comparison.exclusions[${i}]`, "排除项引用无效节点");
    if (c.stageMap) {
      const m = c.stageMap;
      if (
        !object(m) ||
        !object(m.a) ||
        !object(m.b) ||
        !Array.isArray(m.stages) ||
        m.stages.some((s) => !object(s) || !text(s.id) || !text(s.title)) ||
        new Set(m.stages.map((s) => s.id)).size !== m.stages.length
      )
        add("comparison.stages", "$.comparison.stageMap", "阶段映射需包含 a/b 映射及有效共同阶段");
      else
        for (const [lane, g] of [
          ["a", a],
          ["b", b],
        ])
          for (const [from, to] of Object.entries(m[lane]))
            if (!g?.stages?.some((s) => s.id === from) || !m.stages.some((s) => s.id === to))
              add("comparison.stages", "$.comparison.stageMap." + lane, "映射引用不存在的阶段");
    }
  }
  if (!diagnostics.length && value.selection.right)
    try {
      compareFlows(
        resolveFlow(value, value.selection.left),
        resolveFlow(value, value.selection.right),
        c,
      );
    } catch (e) {
      add("comparison.invalid", "$.comparison", e.message);
    }
  if (!object(value.drafts)) add("drafts.shape", "$.drafts", "草稿需为对象");
  else
    for (const [key, draft] of Object.entries(value.drafts)) {
      let identity;
      try {
        identity = JSON.parse(key);
      } catch {
        identity = null;
      }
      const merged = Array.isArray(identity) && identity[0] === "@comparison";
      const g =
        Array.isArray(identity) &&
        resolveFlow(value, {
          documentId: identity[merged ? 1 : 0],
          flowId: identity[merged ? 2 : 1],
        });
      const other = merged && resolveFlow(value, { documentId: identity[3], flowId: identity[4] });
      if (!g || (merged && !other))
        add("draft.reference", "$.drafts." + key, "草稿未指向工作区中的流程");
      else {
        try {
          const offset = merged ? 5 : 2,
            view = {
              ...defaultView(),
              arrangement: identity[offset],
              treeLevels: identity[offset + 1],
              detail: identity[offset + 2],
              grouping: identity[offset + 3],
            };
          if (
            !["trunks", "compact", "vertical"].includes(view.arrangement) ||
            !["expanded", "compact"].includes(view.treeLevels) ||
            !["full", "overview"].includes(view.detail) ||
            typeof view.grouping !== "boolean"
          )
            throw Error("草稿键缺少有效的布局与粒度");
          const source = merged
            ? compareFlows(g, other, identity[9] || value.comparison).merged
            : g;
          diagnostics.push(...validateDraft(draft, "$.drafts." + key, prepareGraph(source, view)));
        } catch (e) {
          add("draft.geometry", "$.drafts." + key, e.message);
        }
      }
    }
  if (diagnostics.length) return { ok: false, diagnostics };
  const normalized = budgetFlowInput(value);
  return normalized.ok ? { ok: true, value: normalized.value, diagnostics } : normalized;
}
export function parseFlowInput(input) {
  try { return parseFlowInputBounded(input); }
  catch (error) {
    return { ok: false, diagnostics: [{ severity: "error", code: "workspace.invalid", path: "$", message: String(error?.message || "工作区数据无效").slice(0, 512) }] };
  }
}
export function serializeWorkspace(workspace) {
  const result = parseFlowInput(workspace);
  if (!result.ok) throw Error(result.diagnostics.map((d) => `${d.path}: ${d.message}`).join("\n"));
  return JSON.stringify(result.value, null, 2);
}
export const blankDraft = emptyDraft;
