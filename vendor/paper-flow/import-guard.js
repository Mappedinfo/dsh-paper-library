/** Reject late file reads after another import, workspace change or unmount. */
export function createImportGuard(initialWorkspace) {
  let workspace = initialWorkspace, generation = 0, alive = true
  return {
    observe(next) { if (next !== workspace) { workspace = next; generation++ } },
    invalidate() { generation++ },
    begin() { generation++; return { generation, workspace } },
    accepts(ticket) { return alive && ticket.generation === generation && ticket.workspace === workspace },
    activate() { alive = true },
    dispose() { alive = false; generation++ },
  }
}
