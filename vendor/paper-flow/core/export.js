import graph from "./graph.js";

export function highlightedGraph(g, lane, report) {
  const matches = new Map(report.pairs.map((p) => [p[lane], p]));
  const edges = new Set(report.edgePairs.map((e) => e[lane]));
  return {
    ...g,
    nodes: g.nodes.map((n) => ({
      ...n,
      status: matches.has(n.id) ? "shared" : lane,
      impacted: !!matches.get(n.id)?.impacted,
      equivalence: matches.get(n.id)?.equivalence,
    })),
    edges: g.edges.map((e) => ({ ...e, status: edges.has(e.id) ? "shared" : lane })),
  };
}

// Export the same view the user sees, including both lanes in parallel mode.
export function exportDiagram(current, state) {
  if (state.mode !== "parallel") {
    const selected =
      state.mode === "single-a"
        ? current.a
        : state.mode === "single-b"
          ? current.b
          : current.merged;
    return graph.svg(selected, { title: selected.name || current.title }).svg;
  }
  const gap = 36;
  const lanes = ["a", "b"].map((lane) => {
    const svg = graph.svg(highlightedGraph(current[lane], lane, current.r), {
      title: lane.toUpperCase() + " · " + current[lane].name,
    }).svg;
    const [, width, height] = svg.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/);
    // Marker IDs must remain unique in the composed, self-contained SVG.
    const content = svg
      .slice(svg.indexOf(">") + 1, svg.lastIndexOf("</svg>"))
      .replace(/ id="([^"]+)"/g, ` id="${lane}-$1"`)
      .replace(/url\(#([^)]+)\)/g, `url(#${lane}-$1)`);
    return { width: Number(width), height: Number(height), content };
  });
  const width = lanes[0].width + gap + lanes[1].width;
  const height = Math.max(...lanes.map((lane) => lane.height));
  return `<svg xmlns="http://www.w3.org/2000/svg" width="400mm" height="${(400 * height) / width}mm" viewBox="0 0 ${width} ${height}" role="img" aria-label="A/B 并排流程对照"><title>A/B 并排流程对照</title><rect width="100%" height="100%" fill="white"/>${lanes.map((lane, i) => `<svg x="${i ? lanes[0].width + gap : 0}" y="0" width="${lane.width}" height="${lane.height}" viewBox="0 0 ${lane.width} ${lane.height}">${lane.content}</svg>`).join("")}</svg>`;
}
