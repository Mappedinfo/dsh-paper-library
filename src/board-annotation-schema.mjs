/** 画板与流程批注的通用、有界格式；不读取 PDF，也不推断流程语义。 */
export const BOARD_ANNOTATION_LIMITS = Object.freeze({ notes: 200, comment: 4000, quote: 2000, label: 300, bytes: 240 * 1024, selectedNodes: 40 })
const ID = /^[A-Za-z0-9_-]{1,60}$/
const REVISION = /^[a-f0-9]{64}$/
export const annotationError = (message, code = 'BOARD_ANNOTATION_INVALID', status = 400) => Object.assign(new Error(message), { code, status })
const object = (value, label, fields) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw annotationError(`${label}必须是对象。`)
  for (const key of Object.keys(value)) if (!fields.includes(key)) throw annotationError(`${label}包含不支持的字段 ${key}。`)
  return value
}
const text = (value, label, max, allowEmpty = false) => {
  if (typeof value !== 'string' || value.length > max || (!allowEmpty && !value.trim())) throw annotationError(`${label}为空或超过 ${max} 字符。`)
  return value
}
export const boardAnnotationId = value => {
  if (typeof value !== 'string' || !ID.test(value)) throw annotationError('画板或批注标识无效。')
  return value
}
export const boardAnnotationRevision = value => {
  if (value !== 0 && !(typeof value === 'string' && REVISION.test(value))) throw annotationError('批注写入必须提供 expected_revision，请先读取当前版本。')
  return value
}
export const boardAnnotationComment = value => text(value, '批注', BOARD_ANNOTATION_LIMITS.comment)
const refId = value => text(value, '流程标识', 200)
export function normalizeBoardAnnotationTarget(input) {
  object(input, '批注位置', ['kind', 'node_ids', 'x', 'y', 'paper_id', 'flow_id', 'node_id'])
  if (input.kind === 'board') {
    if (['paper_id','flow_id','node_id'].some(key => input[key] !== undefined)) throw annotationError('画板批注不能带有流程标识。')
    const target = { kind: 'board' }
    if (input.node_ids !== undefined) {
      if (!Array.isArray(input.node_ids) || input.node_ids.length > BOARD_ANNOTATION_LIMITS.selectedNodes) throw annotationError('一次最多批注 40 个画板节点。')
      target.node_ids = [...new Set(input.node_ids.map(boardAnnotationId))]
      if (target.node_ids.length !== input.node_ids.length) throw annotationError('批注节点不能重复。')
    }
    for (const key of ['x','y']) if (input[key] !== undefined) {
      if (!Number.isFinite(input[key]) || Math.abs(input[key]) > 1_000_000) throw annotationError('批注坐标超出画板范围。')
      target[key] = Math.round(input[key] * 100) / 100
    }
    if ((target.x === undefined) !== (target.y === undefined)) throw annotationError('批注位置需要同时提供横纵坐标。')
    return target
  }
  if (input.kind === 'flow') {
    if (['x','y'].some(key => input[key] !== undefined)) throw annotationError('流程批注不能带有画板坐标。')
    if (input.node_id !== undefined && input.node_ids !== undefined) throw annotationError('流程节点与节点组不能同时指定。')
    const target = { kind: 'flow', paper_id: refId(input.paper_id), flow_id: refId(input.flow_id), ...(input.node_id === undefined ? {} : { node_id: refId(input.node_id) }) }
    if (input.node_ids !== undefined) {
      if (!Array.isArray(input.node_ids) || !input.node_ids.length || input.node_ids.length > 100) throw annotationError('一次最多批注 100 个流程节点。')
      target.node_ids = [...new Set(input.node_ids.map(refId))]
      if (target.node_ids.length !== input.node_ids.length) throw annotationError('批注节点不能重复。')
    }
    return target
  }
  throw annotationError('批注位置必须是画板或流程。')
}
const bounded = (value, limit) => String(value ?? '').slice(0, limit)
/** 标题与摘录只取当前输入明确保存的文字。找不到目标时返回 stale，旧批注保留原快照。 */
export function boardAnnotationSource(target, { board, workspace } = {}) {
  target = normalizeBoardAnnotationTarget(target)
  if (target.kind === 'board') {
    const nodes = target.node_ids?.length ? target.node_ids.map(id => board?.nodes?.find(node => node.id === id)) : []
    const stale = !board || nodes.some(node => !node)
    return { stale, label: bounded(nodes.length ? nodes.map(node => node?.text || node?.paper?.title || node?.id || '已移除节点').join('、') : board?.title || '画板', BOARD_ANNOTATION_LIMITS.label), quote: bounded(nodes.map(node => node?.text || node?.paper?.title || '').filter(Boolean).join('\n\n'), BOARD_ANNOTATION_LIMITS.quote) }
  }
  const document = workspace?.documents?.find(item => item.paper?.id === target.paper_id)
  const flow = document?.flows?.find(item => item.id === target.flow_id)
  const ids = target.node_ids || (target.node_id === undefined ? [] : [target.node_id])
  const nodes = ids.map(id => flow?.nodes?.find(item => item.id === id))
  return { stale: !flow || nodes.some(node => !node), label: bounded(nodes.length ? nodes.map((node, i) => node?.label || ids[i]).join('、') : flow?.name || target.flow_id, BOARD_ANNOTATION_LIMITS.label), quote: bounded(nodes.length ? nodes.filter(Boolean).map(node => [node.label, node.detail, node.evidence].filter(item => typeof item === 'string' && item).join('\n\n')).join('\n\n') : [document?.paper?.title, flow?.name].filter(Boolean).join('\n'), BOARD_ANNOTATION_LIMITS.quote) }
}
export function normalizeBoardAnnotationRecord(input) {
  object(input, '画板批注记录', ['schema', 'notes'])
  if (input.schema !== 'paper-library-board-annotations.v1' || !Array.isArray(input.notes) || input.notes.length > BOARD_ANNOTATION_LIMITS.notes) throw annotationError('画板批注记录版本或数量无效。')
  const ids = new Set()
  const notes = input.notes.map(note => {
    object(note, '批注', ['id', 'target', 'comment', 'label', 'quote', 'created_at', 'updated_at'])
    const id = boardAnnotationId(note.id)
    if (ids.has(id)) throw annotationError('已保存批注标识重复。')
    ids.add(id)
    const result = { id, target: normalizeBoardAnnotationTarget(note.target), comment: boardAnnotationComment(note.comment), label: text(note.label, '批注来源标题', BOARD_ANNOTATION_LIMITS.label, true), quote: text(note.quote, '批注来源摘录', BOARD_ANNOTATION_LIMITS.quote, true) }
    for (const key of ['created_at','updated_at']) {
      if (typeof note[key] !== 'string' || note[key].length > 40 || !Number.isFinite(Date.parse(note[key]))) throw annotationError('批注时间无效。')
      result[key] = note[key]
    }
    return result
  })
  const record = { schema: 'paper-library-board-annotations.v1', notes }
  if (new TextEncoder().encode(JSON.stringify(record)).length > BOARD_ANNOTATION_LIMITS.bytes) throw annotationError('画板批注超过 240 KiB，请先导出并整理旧批注。', 'BOARD_ANNOTATION_TOO_LARGE', 413)
  return record
}
