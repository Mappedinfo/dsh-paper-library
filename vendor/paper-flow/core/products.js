// Only explicitly named, evidenced output ports get product cards. No generic
// "processing output" is invented, and scientific matching still uses the source DAG.
export function productPresentation(graph) {
  const nodes = [...graph.nodes],
    edges = graph.edges.map((e) => ({ ...e })),
    used = new Set(nodes.map((n) => n.id));
  for (const n of graph.nodes) {
    for (const [port, description] of Object.entries(n.display_outputs || {})) {
      const spec = n.ports?.out?.[port];
      if (!spec || !description.label) throw Error(`具名产物缺少有效端口或名称：${n.id}:${port}`);
      const id = `product_${n.id}__${port}`;
      if (used.has(id)) throw Error(`产物展示ID冲突：${id}`);
      used.add(id);
      const outgoing = edges.filter((e) => e.from === `${n.id}:${port}`),
        evidence = outgoing.flatMap((e) =>
          (e.presentation_edges || [e]).map((original) => ({ ...original })),
        ),
        owner = description.owner_id || n.id;
      nodes.push({
        id,
        semantic_key: `${n.semantic_key}.product.${port}`,
        type: description.kind || "representation",
        visual_kind: description.kind || "representation",
        label: description.label,
        state: "具名产物 · 展示展开",
        op: "named_port_product",
        config: { owner: n.id, port },
        stage: n.stage,
        source_stage: n.source_stage,
        ports: { in: { value: { ...spec } }, out: { [port]: { ...spec } } },
        status: n.status,
        equivalence: n.equivalence,
        impacted: n.impacted,
        data_trunk: n.data_trunk,
        presentation_branch: n.presentation_branch,
        trunk_control: !!description.control,
        product_owner: n.id,
        presentation_aliases: [owner],
        detail: description.detail || `「${n.label}」的具名输出；规格和来源见原步骤。`,
        evidence: n.evidence,
        source_ids: n.source_ids,
      });
      for (const edge of outgoing) {
        edge.presentation_edges = (edge.presentation_edges || [edge]).map((original) => ({
          ...original,
        }));
        edge.from = `${id}:${port}`;
      }
      const production = {
        id: `produce_${n.id}__${port}`,
        from: `${n.id}:${port}`,
        to: `${id}:value`,
        kind: "data",
        semantic: "named_output",
        label: "产出",
        status: n.status,
        auxiliary: true,
        trunk_relation: "technology",
      };
      edges.push({ ...production, presentation_edges: evidence.length ? evidence : [production] });
    }
  }
  return { ...graph, nodes, edges };
}
