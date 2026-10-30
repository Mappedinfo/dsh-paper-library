/** Bounds shared by the browser importer, pure parser and host persistence. */
export const FLOW_LIMITS = Object.freeze({
  workspaceBytes: 192 * 1024, documents: 10, flows: 20,
  nodesPerFlow: 100, edgesPerFlow: 200, nodesTotal: 400, edgesTotal: 800,
  drafts: 60, draftNodes: 400, draftEdges: 800, draftRelations: 200,
  draftEntriesTotal: 3000, depth: 32, values: 30000, textLength: 8192, textTotal: 120000,
})

const fail = (code, path, message) => ({ ok: false, diagnostics: [{ severity: 'error', code, path, message }] })
const bytes = value => new TextEncoder().encode(value).byteLength
const record = value => value && typeof value === 'object' && !Array.isArray(value)

/** Never invoke the graph parser/layout until input size and complexity fit. */
export function budgetFlowInput(input) {
  let raw = input
  if (typeof raw === 'string') {
    if (raw.length > FLOW_LIMITS.workspaceBytes || bytes(raw) > FLOW_LIMITS.workspaceBytes) return fail('budget.bytes', '$', '工作区超过 192 KiB 上限')
    try { raw = JSON.parse(raw) } catch { return fail('json.parse', '$', 'JSON 格式无效') }
  }
  let count = 0, text = 0
  const active = new WeakSet()
  function visit(value, depth) {
    if (++count > FLOW_LIMITS.values) throw Error('工作区包含过多数据项')
    if (depth > FLOW_LIMITS.depth) throw Error('工作区嵌套过深')
    if (typeof value === 'string') {
      if (value.length > FLOW_LIMITS.textLength) throw Error('单条文本超过长度上限')
      text += value.length
      if (text > FLOW_LIMITS.textTotal) throw Error('工作区文本总量超过上限')
      return
    }
    if (value === null || value === undefined || typeof value === 'boolean') return
    if (typeof value === 'number' && Number.isFinite(value)) return
    if (typeof value !== 'object') throw Error('工作区必须由有限的 JSON 数据组成')
    if (active.has(value)) throw Error('工作区不能包含循环引用')
    active.add(value)
    const keys = Object.keys(value)
    if (count + keys.length > FLOW_LIMITS.values) throw Error('工作区包含过多数据项')
    for (const key of keys) {
      if (['__proto__', 'prototype', 'constructor'].includes(key)) throw Error('工作区包含不允许的字段名')
      text += key.length
      if (key.length > FLOW_LIMITS.textLength || text > FLOW_LIMITS.textTotal) throw Error('工作区文本总量超过上限')
      visit(value[key], depth + 1)
    }
    active.delete(value)
  }
  try {
    visit(raw, 0)
    const serialized = JSON.stringify(raw)
    if (typeof serialized !== 'string' || bytes(serialized) > FLOW_LIMITS.workspaceBytes) return fail('budget.bytes', '$', '工作区超过 192 KiB 上限')
    // Parse back into ordinary JSON values and isolate the caller's object.
    raw = JSON.parse(serialized)
  } catch (error) { return fail('budget.structure', '$', error.message || '工作区数据无效') }
  const documents = raw?.kind === 'paper-flow-workspace' ? raw.documents
    : raw?.kind === 'paper-flow-document' ? [raw]
      : record(raw) && raw.a && raw.b && !raw.kind ? [{ flows: [raw.a, raw.b] }] : []
  if (Array.isArray(documents)) {
    if (documents.length > FLOW_LIMITS.documents) return fail('budget.documents', '$.documents', '文档数量超过上限')
    let flowCount = 0, nodeCount = 0, edgeCount = 0
    for (const doc of documents) for (const flow of Array.isArray(doc?.flows) ? doc.flows : []) {
      if (++flowCount > FLOW_LIMITS.flows) return fail('budget.flows', '$.documents', '流程数量超过上限')
      const nodes = Array.isArray(flow?.nodes) ? flow.nodes.length : 0, edges = Array.isArray(flow?.edges) ? flow.edges.length : 0
      if (nodes > FLOW_LIMITS.nodesPerFlow || edges > FLOW_LIMITS.edgesPerFlow) return fail('budget.flow', '$.documents', '单个流程的节点或连线超过上限')
      nodeCount += nodes; edgeCount += edges
      if (nodeCount > FLOW_LIMITS.nodesTotal || edgeCount > FLOW_LIMITS.edgesTotal) return fail('budget.graphs', '$.documents', '工作区节点或连线总量超过上限')
    }
  }
  if (record(raw?.drafts)) {
    const drafts = Object.values(raw.drafts)
    if (drafts.length > FLOW_LIMITS.drafts) return fail('budget.drafts', '$.drafts', '草稿数量超过上限')
    let total = 0
    for (const draft of drafts) {
      const nodes = record(draft?.nodes) ? Object.keys(draft.nodes).length : 0
      const edges = record(draft?.edges) ? Object.keys(draft.edges).length : 0
      const relations = Array.isArray(draft?.relations) ? draft.relations.length : 0
      if (nodes > FLOW_LIMITS.draftNodes || edges > FLOW_LIMITS.draftEdges || relations > FLOW_LIMITS.draftRelations) return fail('budget.draft', '$.drafts', '单个草稿的元素数量超过上限')
      total += nodes + edges + relations
      if (total > FLOW_LIMITS.draftEntriesTotal) return fail('budget.drafts', '$.drafts', '草稿元素总量超过上限')
    }
  }
  return { ok: true, value: raw, diagnostics: [] }
}
