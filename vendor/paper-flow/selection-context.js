/** Resolve visible groups and comparison aliases only through declared membership. */
export function selectionContexts(workspace, lane, id, visibleNode, visibleGraph) {
  const refs = lane === 'merged' ? [['a', workspace.selection.left], ['b', workspace.selection.right]]
    : [[lane, lane === 'b' ? workspace.selection.right : workspace.selection.left]];
  return refs.flatMap(([side, ref]) => {
    if (!ref) return [];
    const graph = workspace.documents.find(d => d.paper.id === ref.documentId)?.flows.find(g => g.id === ref.flowId);
    if (!graph) return [];
    const ids = new Set(graph.nodes.map(n => n.id)), selected = new Set();
    const add = (value, depth = 0, source = lane !== 'merged') => {
      if (!value || depth > 8) return;
      if (typeof value === 'string') {
        if (!source) {
          const declared = [...(visibleGraph?.nodes || []), ...(visibleGraph?.detail_groups || []), ...(visibleGraph?.paper_groups || [])].find(n => n.id === value);
          if (declared) add(declared, depth + 1, false);
          return;
        }
        if (ids.has(value)) selected.add(value);
        const group = [...(graph.detail_groups || []), ...(graph.paper_groups || [])].find(g => g.id === value);
        for (const member of group?.members || []) add(member, depth + 1, true);
        return;
      }
      if (!source) {
        if (typeof value.source_ids?.[side] === 'string') add(value.source_ids[side], depth + 1, true);
      } else add(value.id, depth + 1, true);
      for (const member of [
        ...(Array.isArray(value.presentation_members) ? value.presentation_members : []),
        ...(Array.isArray(value.members) ? value.members : []),
      ]) add(member, depth + 1, source);
    };
    if (lane !== 'merged') add(id);
    if (visibleNode) add(visibleNode);
    else if (lane === 'merged') add(id);
    return selected.size ? [{ ref, nodeIds: [...selected], side }] : [];
  });
}
