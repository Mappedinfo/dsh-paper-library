const copy = (value) => structuredClone(value);
export const defaultView = () => ({
  arrangement: "trunks",
  treeLevels: "expanded",
  detail: "full",
  grouping: true,
  zoom: "fit",
  hoverMotion: true,
  mode: "parallel",
});
export const defaultComparison = () => ({ mode: "logical", correspondences: [], exclusions: [] });
export function normalizeGraph(source) {
  const missing = source.stages?.length && source.nodes.some((n) => !n.stage);
  return {
    ...copy(source),
    stages: source.stages?.length
      ? [...copy(source.stages), ...(missing ? [{ id: "@unassigned", title: "未分阶段" }] : [])]
      : undefined,
    nodes: source.nodes.map((n) => ({
      ...copy(n),
      ...(missing && !n.stage ? { stage: "@unassigned" } : {}),
      state: n.state || "",
      config: copy(n.config || {}),
      detail: n.detail || "",
      evidence: n.evidence || "",
      op: n.op || "",
      semantic_key: n.semantic_key || "",
    })),
    edges: source.edges.map((e) => ({
      ...copy(e),
      kind: e.kind || "data",
      semantic: e.semantic || "",
    })),
  };
}
