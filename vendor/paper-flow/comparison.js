import engine from "./core/graph.js";
import { normalizeGraph, defaultComparison } from "./model.js";
import { highlightedGraph } from "./core/export.js";
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
    const project = (g, lane) => ({
      ...g,
      stages: mapping.stages,
      nodes: g.nodes.map((n) => ({
        ...n,
        source_stage: n.source_stage || {
          id: n.stage,
          title: g.stages?.find((s) => s.id === n.stage)?.title || n.stage,
        },
        stage: n.stage ? mapping[lane][n.stage] || n.stage : undefined,
      })),
    });
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
  let merged = engine.merge(a, b, renderReport(safe));
  merged = {
    ...merged,
    stages: [
      ...(a.stages || []),
      ...(b.stages || []).filter((s) => !a.stages?.some((t) => t.id === s.id)),
    ],
  };
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
