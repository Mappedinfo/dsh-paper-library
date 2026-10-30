import engine from "./core/graph.js";
import { normalizeGraph, defaultComparison } from "./model.js";
import { highlightedGraph } from "./core/export.js";

const canonical = (value) => JSON.stringify(value, (_, item) =>
  item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item);

// Stage IDs are local to each graph. Preserve conflicting definitions in the
// merged presentation instead of displaying one graph under the other's title.
function separateStageDefinitions(a, b) {
  const ids = (g) => new Set([...(g.stages || []).map((s) => s.id), ...g.nodes.map((n) => n.stage).filter(Boolean)]);
  const aIds = ids(a), bIds = ids(b), occupied = new Set([...aIds, ...bIds]);
  const conflicts = [...aIds].filter((id) => bIds.has(id) &&
    canonical(a.stages?.find((s) => s.id === id)) !== canonical(b.stages?.find((s) => s.id === id)));
  if (!conflicts.length) return { a, b, notes: [] };
  const project = (g, lane) => {
    const mapping = new Map();
    for (const [index, id] of conflicts.entries()) {
      let next = `@comparison-${lane}-stage-${index}`;
      while (occupied.has(next)) next += "_";
      occupied.add(next);
      mapping.set(id, next);
    }
    const remap = (id) => mapping.get(id) || id;
    const remapKeys = (object) => object && Object.fromEntries(Object.entries(object).map(([key, value]) => [remap(key), value]));
    return {
      ...g,
      stages: [
        ...(g.stages || []).map((s) => mapping.has(s.id)
          ? { ...s, id: remap(s.id), comparison_stage_source: { lane, id: s.id, declared: true } } : s),
        ...conflicts.filter((id) => !g.stages?.some((s) => s.id === id)).map((id) => ({
          id: remap(id), title: `${lane.toUpperCase()} · ${id}（未声明定义）`,
          comparison_stage_source: { lane, id, declared: false },
        })),
      ],
      nodes: g.nodes.map((n) => ({ ...n, ...(n.stage ? { stage: remap(n.stage) } : {}) })),
      paper_groups: g.paper_groups?.map((group) => ({ ...group, ...(group.stage ? { stage: remap(group.stage) } : {}) })),
      detail_groups: g.detail_groups?.map((group) => ({ ...group, ...(group.stage ? { stage: remap(group.stage) } : {}) })),
      swimlanes: g.swimlanes?.map((lane) => ({ ...lane, stages: lane.stages?.map(remap) })),
      stage_notes: remapKeys(g.stage_notes),
      stage_heights: remapKeys(g.stage_heights),
    };
  };
  return { a: project(a, "a"), b: project(b, "b"), notes: conflicts.map((id) => `阶段 ${id} 的定义未同时声明或不一致；合并图分别保留两侧阶段，未推断对应关系`) };
}
export function prepareGraph(source, view, draft) {
  const raw = normalizeGraph(source),
    g = view.detail === "overview" ? engine.collapse(raw) : raw;
  return {
    ...g,
    standalone: !g.nodes.some((n) => ["a", "b", "shared"].includes(n.status)),
    presentation_layout: view.arrangement,
    tree_levels: view.treeLevels,
    detail_grouping: view.grouping,
    presentation_edits: draft,
  };
}
export function compareFlows(left, right, spec = defaultComparison()) {
  let a = normalizeGraph(left),
    b = normalizeGraph(right);
  const mapping = spec.stageMap;
  if (mapping) {
    const occupied = new Set([...mapping.stages, ...(a.stages || []), ...(b.stages || [])].map((s) => s.id));
    const project = (g, lane) => {
      const retained = new Map();
      for (const s of g.stages || []) {
        if (s.id === "@unassigned" || Object.hasOwn(mapping[lane], s.id)) continue;
        let id = `@unmapped-${lane}-stage-${retained.size}`;
        while (occupied.has(id)) id += "_";
        occupied.add(id);
        retained.set(s.id, id);
      }
      const remap = (id) => id && id !== "@unassigned" ? mapping[lane][id] || retained.get(id) || id : undefined;
      return normalizeGraph({
        ...g,
        stages: [...mapping.stages, ...(g.stages || []).filter((s) => retained.has(s.id)).map((s) => ({
          ...s, id: retained.get(s.id), comparison_stage_source: { lane, id: s.id, declared: true },
        }))],
        nodes: g.nodes.map((n) => ({
          ...n,
          ...(n.stage && n.stage !== "@unassigned" ? { source_stage: n.source_stage || {
            id: n.stage,
            title: g.stages?.find((s) => s.id === n.stage)?.title || n.stage,
          } } : {}),
          stage: remap(n.stage),
        })),
        paper_groups: g.paper_groups?.map((group) => ({ ...group, stage: remap(group.stage) })),
        detail_groups: g.detail_groups?.map((group) => ({ ...group, stage: remap(group.stage) })),
        swimlanes: g.swimlanes?.map((s) => ({ ...s, stages: s.stages?.map(remap).filter(Boolean) })),
      });
    };
    a = project(a, "a");
    b = project(b, "b");
  }
  const report = engine.match(a, b, [], { mode: spec.mode, exclusions: spec.exclusions });
  const correspondence = (spec.correspondences || []).map((p) => ({
    ...p,
    equivalence: "correspondence",
    mergeable: false,
  }));
  const renderReport = (pairs) => ({
    ...report,
    pairs,
    edgePairs: report.edgePairs.filter((p) => {
      const e = a.edges.find((e) => e.id === p.a);
      return (
        pairs.some((p) => p.a === e.from.split(":")[0]) &&
        pairs.some((p) => p.a === e.to.split(":")[0])
      );
    }),
  });
  let safe = [];
  for (const pair of report.pairs) {
    const trial = engine.merge(a, b, renderReport([...safe, pair]));
    if (engine.lint({ ...trial, stages: undefined }).some((e) => e.message.includes("循环")))
      report.notes.push(`合并 ${pair.a} ↔ ${pair.b} 会产生回路，合并图保留两侧步骤`);
    else safe.push(pair);
  }
  const presentation = mapping ? { a, b, notes: [] } : separateStageDefinitions(a, b);
  report.notes.push(...presentation.notes);
  let merged = engine.merge(presentation.a, presentation.b, renderReport(safe));
  merged = normalizeGraph({
    ...merged,
    stages: [
      ...(presentation.a.stages || []),
      ...(presentation.b.stages || []).filter((s) => !presentation.a.stages?.some((t) => t.id === s.id)),
    ],
  });
  return {
    a: highlightedGraph(a, "a", report),
    b: highlightedGraph(b, "b", report),
    merged,
    report: { ...report, correspondences: correspondence },
  };
}
// Namespaced fragments compose independently rendered canvases without marker collisions.
export function namespaceSvg(svg, namespace) {
  const prefix = namespace.replace(/[^a-zA-Z0-9_-]/g, "_") + "-";
  return svg
    .replace(/ id="([^"]+)"/g, (_, id) => ` id="${prefix}${id}"`)
    .replace(/url\(#([^)]+)\)/g, (_, id) => `url(#${prefix}${id})`);
}
export function combineSvg(drawings) {
  const gap = 36,
    width = drawings.reduce((sum, d) => sum + d.width, 0) + gap * (drawings.length - 1),
    height = Math.max(...drawings.map((d) => d.height));
  let x = 0;
  const content = drawings
    .map((d, i) => {
      const svg = namespaceSvg(d.svg, `lane${i}`),
        part = svg.slice(svg.indexOf(">") + 1, svg.lastIndexOf("</svg>"));
      const result = `<svg x="${x}" y="0" width="${d.width}" height="${d.height}" viewBox="0 0 ${d.width} ${d.height}">${part}</svg>`;
      x += d.width + gap;
      return result;
    })
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="400mm" height="${(400 * height) / width}mm" role="img" aria-label="论文流程比较"><rect width="100%" height="100%" fill="white"/>${content}</svg>`;
}
