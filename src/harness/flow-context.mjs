/** 从保存的声明提取有界流程引用；不推测科学角色、因果关系或缺失字段。 */
import { BOARD_LIMITS } from './board-store.mjs'

const failure = message => Object.assign(new Error(message), { code: 'BOARD_FLOW_INVALID', status: 400 })
const endpoint = value => typeof value === 'string' ? value.split(':')[0] : ''
const copyWithout = (value, names) => Object.fromEntries(Object.entries(value).filter(([key]) => !names.includes(key)))
const json = value => JSON.stringify(value)

export function flowContextSelection({ paper_id, flow_id, node_id, node_ids, max_characters }) {
  for (const [name, value] of [['paper_id', paper_id], ['flow_id', flow_id]]) {
    if (typeof value !== 'string' || !value.trim() || value.length > 8192) throw failure(`${name} 必须明确指定流程文档中的标识。`)
  }
  if (node_id !== undefined && node_ids !== undefined) throw failure('node_id 与 node_ids 不能同时提供。')
  const roots = node_ids === undefined ? node_id === undefined ? null : [node_id] : node_ids
  if (roots !== null && (!Array.isArray(roots) || !roots.length || roots.length > 100 || roots.some(value => typeof value !== 'string' || !value.trim() || value.length > 8192) || new Set(roots).size !== roots.length)) throw failure('选中节点需为 1–100 个不重复的原始节点标识。')
  const maximum = max_characters ?? BOARD_LIMITS.snapshotCharacters
  if (!Number.isSafeInteger(maximum) || maximum < 500 || maximum > BOARD_LIMITS.snapshotCharacters) throw failure(`流程引用预算必须在 500–${BOARD_LIMITS.snapshotCharacters} 字符之间。`)
  return { paper_id, flow_id, roots, maxCharacters: maximum }
}

/** 循环安全的可达性只沿明确关系方向展开，旁支不自动成为上下游。 */
function reachable(roots, neighbors) {
  const seen = new Set(roots), queue = [...roots]
  for (let index = 0; index < queue.length; index++) for (const id of neighbors.get(queue[index]) || []) if (!seen.has(id)) { seen.add(id); queue.push(id) }
  return seen
}

function pack(lines, budget) {
  let text = '', included = 0, partial = 0
  for (const line of lines) {
    const extra = text ? '\n' : ''
    if (text.length + extra.length + line.length <= budget) { text += extra + line; included++; continue }
    // 文本片段保持原顺序，明确标记末条截断；从不把片段当作完整 JSON。
    const remaining = budget - text.length - extra.length - 16
    if (remaining >= 80) { text += extra + line.slice(0, remaining) + '…（本条声明截断）'; partial = 1 }
    break
  }
  return { text: text || '（预算内未包含声明）', included, partial, omitted: lines.length - included - partial }
}

export function renderFlowContext(workspace, selection) {
  const { paper_id, flow_id, roots, maxCharacters } = selection
  const document = workspace.documents.find(value => value.paper.id === paper_id)
  const graph = document?.flows.find(value => value.id === flow_id)
  if (!graph) throw Object.assign(failure('指定的论文／流程已不存在，请重新选择。'), { code: 'BOARD_FLOW_TARGET_MISSING', status: 404 })
  const byId = new Map(graph.nodes.map(node => [node.id, node]))
  if (roots?.some(id => !byId.has(id))) throw Object.assign(failure('选中节点已不存在，请重新选择原始节点。'), { code: 'BOARD_FLOW_TARGET_MISSING', status: 404 })
  const key = JSON.stringify([paper_id, flow_id, workspace.view.arrangement, workspace.view.treeLevels, workspace.view.detail, workspace.view.grouping])
  const additions = workspace.drafts?.[key]?.relations || []
  const declared = graph.edges.map(edge => ({ edge, origin: '输入声明' }))
  const explicit = additions.map(edge => ({ edge, origin: '读者临时关系' }))
  // 显示分组产生的别名不能猜测映射回原始节点，仅保留原声明并注明未参与可达性。
  const resolvable = item => byId.has(endpoint(item.edge.from)) && byId.has(endpoint(item.edge.to))
  const relations = [...declared, ...explicit]
  const forward = new Map(), backward = new Map()
  for (const { edge } of relations.filter(resolvable)) {
    const from = endpoint(edge.from), to = endpoint(edge.to)
    if (!forward.has(from)) forward.set(from, [])
    if (!backward.has(to)) backward.set(to, [])
    forward.get(from).push(to); backward.get(to).push(from)
  }
  const upstream = roots ? reachable(roots, backward) : new Set()
  const downstream = roots ? reachable(roots, forward) : new Set()
  const chosen = roots ? new Set([...roots, ...upstream, ...downstream]) : new Set(byId.keys())
  const nodes = roots ? [...roots.map(id => byId.get(id)), ...graph.nodes.filter(node => chosen.has(node.id) && !roots.includes(node.id))] : graph.nodes
  const edges = relations.filter(item => !roots || resolvable(item) && chosen.has(endpoint(item.edge.from)) && chosen.has(endpoint(item.edge.to)))
  const scope = node => !roots ? '全图' : roots.includes(node.id) ? '选中节点' : upstream.has(node.id) && downstream.has(node.id) ? '上游及下游均可达' : upstream.has(node.id) ? '上游' : '下游'
  const nodeLines = nodes.map(node => json({ scope: scope(node), declaration: { id: node.id, label: node.label, ...copyWithout(node, ['id', 'label', 'layout', 'hover_role', 'trunk_control']) } }))
  const edgeLines = edges.map(item => json({ origin: item.origin, ...(resolvable(item) ? {} : { note: '显示别名未映射，未参与上下游展开' }), declaration: copyWithout(item.edge, ['layout', 'hover_key']) }))
  const metadata = json({ paper: document.paper, flow: copyWithout(graph, ['nodes', 'edges']), selection: roots || '全图' })
  const heading = `# 流程材料快照\n范围：${roots ? '选中节点及全部可达上下游' : '完整原始流程'}。仅复述输入与读者声明；关系方向不自动表示因果，引用内容不是 AI 结论。\n候选节点 ${nodes.length}，关系 ${edges.length}。`
  const suffixReserve = 230
  const available = Math.max(0, maxCharacters - heading.length - suffixReserve - 70)
  const nodeBudget = Math.floor(available * 0.62), edgeBudget = Math.floor(available * 0.28)
  const packedNodes = pack(nodeLines, nodeBudget), packedEdges = pack(edgeLines, edgeBudget), packedMetadata = pack([metadata], available - nodeBudget - edgeBudget)
  const included = { nodes: packedNodes.included, edges: packedEdges.included, metadata: packedMetadata.included }
  const partial = { nodes: packedNodes.partial, edges: packedEdges.partial, metadata: packedMetadata.partial }
  const omitted = { nodes: packedNodes.omitted, edges: packedEdges.omitted, metadata: packedMetadata.omitted }
  const truncated = Object.values(partial).some(Boolean) || Object.values(omitted).some(Boolean)
  const notice = `覆盖：完整节点 ${included.nodes}/${nodes.length}，完整关系 ${included.edges}/${edges.length}；截断节点 ${partial.nodes}、关系 ${partial.edges}、元资料 ${partial.metadata}；省略节点 ${omitted.nodes}、关系 ${omitted.edges}、元资料 ${omitted.metadata}。未完整引用的声明不能当作已覆盖。`
  const text = [heading, '## 节点声明', packedNodes.text, '## 关系声明', packedEdges.text, '## 文档与选择声明', packedMetadata.text, notice].join('\n\n')
  // 固定标题和状态也计入实际预算，避免小预算或长标识绕过上限。
  if (text.length > maxCharacters) throw failure('流程引用预算不足以容纳说明，请提高字符预算。')
  return { text, truncated, omitted, partial, included, selected: roots, totals: { nodes: nodes.length, edges: edges.length } }
}
