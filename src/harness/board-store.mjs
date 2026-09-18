/** Literature whiteboard records.
 *
 * A board is one private host record (`board:<id>`) in the existing local state
 * store, so it inherits that store's 256 KiB record cap, revision-checked
 * writes, atomic replacement and private directory. Listing reads a bounded
 * window of records and reports its own truncation instead of pretending to be
 * complete. No model, worker or network access is involved in this module.
 *
 * Reference snapshots (`board-ref:<hash>`) freeze exactly the material a user
 * sent to a conversation; an edited board never rewrites an existing snapshot.
 */
import { createHash, randomUUID } from 'node:crypto'

export const BOARD_KEY_PREFIX = 'board:'
export const BOARD_SNAPSHOT_PREFIX = 'board-ref:'
export const BOARD_LIMITS = Object.freeze({
  listing: 50, nodes: 400, edges: 800, titleCharacters: 200, textCharacters: 2000,
  labelCharacters: 200, relations: 6, coordinate: 1_000_000, zoomMin: 0.2, zoomMax: 4,
  snapshotCharacters: 24_000, searchCharacters: 400,
})

const ID = /^[A-Za-z0-9_-]{1,60}$/
const HASH = /^[a-f0-9]{64}$/
const COLOR = /^#[0-9a-fA-F]{6}$/
const NODE_KINDS = new Set(['text', 'note', 'concept', 'paper', 'rect', 'ellipse', 'diamond'])
const EDGE_KINDS = new Set(['arrow', 'line', 'elbow'])
const RELATIONS = new Set(['related', 'supports', 'contradicts', 'cites', 'explains', 'extends'])
const ORIGINS = new Set(['user', 'llm'])
const NODE_FIELDS = new Set(['id', 'kind', 'x', 'y', 'w', 'h', 'text', 'color', 'paper', 'origin'])
const EDGE_FIELDS = new Set(['id', 'from', 'to', 'label', 'kind', 'relation', 'origin'])
const PAPER_FIELDS = new Set(['id', 'title', 'year', 'citekey'])
const BOARD_FIELDS = new Set(['schema', 'id', 'title', 'created_at', 'updated_at', 'origin', 'status', 'view', 'nodes', 'edges'])

export function boardError(message, code = 'BOARD_INVALID', status = 400) {
  return Object.assign(new Error(message), { code, status })
}

const identifier = (value, name) => {
  if (typeof value !== 'string' || !ID.test(value)) throw boardError(`${name}必须是 1–60 位字母、数字、短横线或下划线。`)
  return value
}

function boundedText(value, name, maximum, required = true) {
  if (value === undefined && !required) return undefined
  if (typeof value !== 'string' || value.length > maximum || (required && !value.trim())) {
    throw boardError(required ? `${name}为空或超过 ${maximum} 个字符。` : `${name}超过 ${maximum} 个字符。`)
  }
  return value
}

function coordinate(value, name) {
  if (!Number.isFinite(value) || Math.abs(value) > BOARD_LIMITS.coordinate) throw boardError(`${name}超出画板坐标范围。`)
  return Math.round(value * 100) / 100
}

function colour(value, name) {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !COLOR.test(value)) throw boardError(`${name}必须是 #rrggbb 颜色。`)
  return value.toLowerCase()
}

function origin(value, name) {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !ORIGINS.has(value)) throw boardError(`${name}只能是 user 或 llm。`)
  return value
}

function closedObject(value, name, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw boardError(`${name}必须是对象。`)
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw boardError(`${name}包含不支持的字段 ${key}。`)
  return value
}

function normalizePaper(value) {
  if (value === undefined) return undefined
  closedObject(value, '文献节点资料', PAPER_FIELDS)
  const paper = { id: identifier(value.id, '文献标识') }
  if (value.title !== undefined) paper.title = boundedText(value.title, '文献标题', 500)
  if (value.year !== undefined) {
    if (!Number.isInteger(value.year) || value.year < 1 || value.year > 9999) throw boardError('文献年份无效。')
    paper.year = value.year
  }
  if (value.citekey !== undefined) paper.citekey = boundedText(value.citekey, '引用键', 200)
  return paper
}

function normalizeNode(value, index) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw boardError(`第 ${index + 1} 个节点无效。`)
  closedObject(value, `第 ${index + 1} 个节点`, NODE_FIELDS)
  const kind = value.kind ?? 'text'
  if (!NODE_KINDS.has(kind)) throw boardError(`第 ${index + 1} 个节点类型不受支持。`)
  const node = {
    id: identifier(value.id, `第 ${index + 1} 个节点标识`),
    kind,
    x: coordinate(value.x ?? 0, `第 ${index + 1} 个节点横坐标`),
    y: coordinate(value.y ?? 0, `第 ${index + 1} 个节点纵坐标`),
    w: Math.max(40, coordinate(value.w ?? 240, `第 ${index + 1} 个节点宽度`)),
    h: Math.max(32, coordinate(value.h ?? 120, `第 ${index + 1} 个节点高度`)),
    text: boundedText(value.text ?? '', '节点文本', BOARD_LIMITS.textCharacters, false),
    origin: origin(value.origin, `第 ${index + 1} 个节点来源`) ?? 'user',
  }
  const tint = colour(value.color, `第 ${index + 1} 个节点颜色`)
  if (tint) node.color = tint
  if (kind === 'paper' && value.paper === undefined) throw boardError(`第 ${index + 1} 个文献节点缺少文献标识。`)
  const paper = normalizePaper(value.paper)
  if (paper) node.paper = paper
  if (kind !== 'paper' && paper) throw boardError(`第 ${index + 1} 个节点只有 paper 类型可以绑定文献。`)
  if (!node.text && !node.paper) throw boardError(`第 ${index + 1} 个节点既没有文本也没有文献。`)
  return node
}

function normalizeEdge(value, index, nodeIds) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw boardError(`第 ${index + 1} 条连线无效。`)
  closedObject(value, `第 ${index + 1} 条连线`, EDGE_FIELDS)
  const kind = value.kind ?? 'arrow'
  if (!EDGE_KINDS.has(kind)) throw boardError(`第 ${index + 1} 条连线类型不受支持。`)
  const from = identifier(value.from, `第 ${index + 1} 条连线起点`)
  const to = identifier(value.to, `第 ${index + 1} 条连线终点`)
  if (from === to) throw boardError(`第 ${index + 1} 条连线不能连接同一个节点。`)
  if (!nodeIds.has(from) || !nodeIds.has(to)) throw boardError(`第 ${index + 1} 条连线的端点不在本次画板中。`)
  const relation = value.relation
  if (relation !== undefined && !RELATIONS.has(relation)) throw boardError(`第 ${index + 1} 条连线的关系词不受支持。`)
  const edge = { id: identifier(value.id, `第 ${index + 1} 条连线标识`), from, to, kind, origin: origin(value.origin, `第 ${index + 1} 条连线来源`) ?? 'user' }
  if (relation !== undefined) edge.relation = relation
  const label = boundedText(value.label, '连线标签', BOARD_LIMITS.labelCharacters, false)
  if (label) edge.label = label
  return edge
}

function duplicate(ids, name) {
  const seen = new Set()
  for (const id of ids) {
    if (seen.has(id)) throw boardError(`${name}标识 ${id} 重复。`)
    seen.add(id)
  }
  return seen
}

/** Validate and normalize one board; returns a deep copy with no extra fields. */
export function validateBoard(value, { id, origin: forcedOrigin } = {}) {
  closedObject(value, '画板', BOARD_FIELDS)
  if (value.schema !== undefined && value.schema !== 1) throw boardError('画板结构版本不受支持。')
  const nodes = value.nodes ?? []
  const edges = value.edges ?? []
  if (!Array.isArray(nodes) || nodes.length > BOARD_LIMITS.nodes) throw boardError(`画板最多 ${BOARD_LIMITS.nodes} 个节点。`)
  if (!Array.isArray(edges) || edges.length > BOARD_LIMITS.edges) throw boardError(`画板最多 ${BOARD_LIMITS.edges} 条连线。`)
  const board = {
    schema: 1,
    id: identifier(id ?? value.id, '画板标识'),
    title: boundedText(value.title ?? '未命名画板', '画板标题', BOARD_LIMITS.titleCharacters),
    origin: origin(forcedOrigin ?? value.origin, '画板来源') ?? 'user',
    status: value.status === 'needs-review' ? 'needs-review' : 'saved',
    nodes: nodes.map(normalizeNode),
    edges: [],
  }
  const nodeIds = duplicate(board.nodes.map(node => node.id), '节点')
  board.edges = edges.map((edge, index) => normalizeEdge(edge, index, nodeIds))
  duplicate(board.edges.map(edge => edge.id), '连线')
  if (value.created_at !== undefined) {
    if (typeof value.created_at !== 'string' || !Number.isFinite(Date.parse(value.created_at))) throw boardError('画板创建时间无效。')
    board.created_at = value.created_at
  }
  if (value.updated_at !== undefined) {
    if (typeof value.updated_at !== 'string' || !Number.isFinite(Date.parse(value.updated_at))) throw boardError('画板更新时间无效。')
    board.updated_at = value.updated_at
  }
  if (value.view !== undefined) {
    closedObject(value.view, '画板视图', new Set(['x', 'y', 'zoom']))
    const zoom = value.view.zoom ?? 1
    if (!Number.isFinite(zoom) || zoom < BOARD_LIMITS.zoomMin || zoom > BOARD_LIMITS.zoomMax) throw boardError(`画板缩放必须在 ${BOARD_LIMITS.zoomMin}–${BOARD_LIMITS.zoomMax} 之间。`)
    board.view = { x: coordinate(value.view.x ?? 0, '画板视图横坐标'), y: coordinate(value.view.y ?? 0, '画板视图纵坐标'), zoom: Math.round(zoom * 1000) / 1000 }
  }
  if (Buffer.byteLength(JSON.stringify(board), 'utf8') > 200 * 1024) throw boardError('画板内容接近单条状态上限，请拆分画板。', 'BOARD_TOO_LARGE', 413)
  return board
}

const nodeLabel = node => (node.text?.trim() || node.paper?.title?.trim() || node.paper?.id || node.id).replace(/\s+/gu, ' ')

/** Deterministic, human-readable rendering used for snapshots and agent reads. */
export function renderBoardOutline(board, { maxCharacters = BOARD_LIMITS.snapshotCharacters } = {}) {
  if (board.schema !== 1) throw boardError('画板结构版本不受支持。')
  const header = [`# 画板：${board.title}`, `节点 ${board.nodes.length} · 连线 ${board.edges.length}${board.updated_at ? ` · 更新 ${board.updated_at}` : ''}`]
  const nodeLines = board.nodes.map(node => {
    const parts = [`- [${node.kind}] ${nodeLabel(node)}`]
    if (node.paper) {
      const meta = [node.paper.year, node.paper.citekey].filter(Boolean).join(' · ')
      parts.push(`文献 ${node.paper.id}${meta ? `（${meta}）` : ''}`)
    }
    if (node.paper && node.text && node.paper.title && node.text.trim() !== node.paper.title.trim()) parts.push(`标题 ${node.paper.title}`)
    return parts.join(' — ')
  })
  const byId = new Map(board.nodes.map(node => [node.id, nodeLabel(node)]))
  const edgeLines = board.edges.map(edge => `- ${byId.get(edge.from)} --${edge.relation ?? edge.kind}--> ${byId.get(edge.to)}${edge.label ? `（${edge.label}）` : ''}`)
  const sections = [header.join('\n'), '## 节点', nodeLines.join('\n'), '## 关系', edgeLines.length ? edgeLines.join('\n') : '（无连线）']
  const full = sections.join('\n\n')
  if (full.length <= maxCharacters) return { text: full, truncated: false, omitted: { nodes: 0, edges: 0 } }
  // Drop whole lines from the end, never mid-line, and always state what is missing.
  const keptNodes = [], keptEdges = []
  let used = 0, nodeCursor = 0, edgeCursor = 0
  const budget = Math.max(0, maxCharacters - 120)
  for (const line of header) { used += line.length + 1 }
  for (const line of nodeLines) { if (used + line.length + 1 > budget) break; used += line.length + 1; keptNodes.push(line); nodeCursor++ }
  for (const line of edgeLines) { if (used + line.length + 1 > budget) break; used += line.length + 1; keptEdges.push(line); edgeCursor++ }
  const omitted = { nodes: nodeLines.length - nodeCursor, edges: edgeLines.length - edgeCursor }
  const notice = `（已按 ${maxCharacters} 字符预算截断：省略 ${omitted.nodes} 个节点、${omitted.edges} 条连线，未包含的内容未参与本次引用）`
  const text = [header.join('\n'), '## 节点', keptNodes.join('\n') || '（未包含节点）', '## 关系', keptEdges.join('\n') || '（未包含连线）', notice].join('\n\n')
  return { text, truncated: true, omitted }
}

const digest = value => createHash('sha256').update(value).digest('hex')
const stamp = () => new Date().toISOString()
const newId = prefix => `${prefix}-${randomUUID().replaceAll('-', '').slice(0, 12)}`

export function newBoardId() { return newId('b') }
export function newNodeId() { return newId('n') }
export function newEdgeId() { return newId('e') }

/** Read-only projection shared by the panel, the HTTP surface and the agent tool. */
export function boardSummary(board) {
  return {
    id: board.id, title: board.title, origin: board.origin, status: board.status,
    created_at: board.created_at ?? null, updated_at: board.updated_at ?? null,
    node_count: board.nodes.length, edge_count: board.edges.length,
    paper_count: board.nodes.filter(node => node.paper).length,
    ai_node_count: board.nodes.filter(node => node.origin === 'llm').length,
    ai_edge_count: board.edges.filter(edge => edge.origin === 'llm').length,
  }
}

/** Boards plus snapshots over the configured local state store. */
export function createBoardStore({ localState }) {
  if (!localState || typeof localState.get !== 'function' || typeof localState.put !== 'function' || typeof localState.list !== 'function') {
    throw boardError('画板需要本地状态存储。', 'BOARD_STORE_MISSING', 500)
  }
  const boardKey = id => `${BOARD_KEY_PREFIX}${identifier(id, '画板标识')}`
  const snapshotKey = id => `${BOARD_SNAPSHOT_PREFIX}${id}`

  const notFound = id => boardError(`画板 ${id} 不存在或已删除。`, 'BOARD_NOT_FOUND', 404)

  async function readRecord(id) {
    const record = await localState.get(boardKey(id))
    if (!record.value || record.value.deleted === true) throw notFound(id)
    return record
  }

  async function list() {
    const page = await localState.list({ prefix: BOARD_KEY_PREFIX, offset: 0, limit: BOARD_LIMITS.listing })
    const boards = page.records.filter(record => record.value && record.value.deleted !== true).map(record => boardSummary(record.value))
    return {
      boards, scanned: page.records.length, total: page.total,
      // The store's own window is the bound; a larger archive is reported, never silently dropped.
      truncated: page.hasMore === true || page.records.length < page.total,
    }
  }

  async function read(id) {
    const record = await readRecord(id)
    return { board: record.value, revision: record.revision, outline: renderBoardOutline(record.value).text }
  }

  const withoutOrigin = item => JSON.stringify({ ...item, origin: undefined })

  /**
   * Mark only what the model actually touched. A node or edge that is byte-identical
   * to the stored one keeps its previous provenance, so an agent editing one node
   * cannot relabel the reader's own work as an AI proposal.
   */
  function markProposals(board, previous) {
    const priorNodes = new Map((previous?.nodes ?? []).map(node => [node.id, node]))
    const priorEdges = new Map((previous?.edges ?? []).map(edge => [edge.id, edge]))
    const proposal = (item, prior) => (!prior || withoutOrigin(prior) !== withoutOrigin(item) ? 'llm' : prior.origin)
    return {
      ...board,
      nodes: board.nodes.map(node => ({ ...node, origin: proposal(node, priorNodes.get(node.id)) })),
      edges: board.edges.map(edge => ({ ...edge, origin: proposal(edge, priorEdges.get(edge.id)) })),
    }
  }

  async function create({ board, origin: writer = 'user' }) {
    const id = newBoardId()
    const normalized = validateBoard({ ...board, id }, { id, origin: writer })
    const stored = writer === 'llm'
      ? { ...markProposals(normalized, null), created_at: stamp(), updated_at: stamp(), status: 'needs-review' }
      : { ...normalized, created_at: stamp(), updated_at: stamp(), status: 'saved' }
    const written = await localState.put(boardKey(id), stored, 0)
    return { board: written.value, revision: written.revision, summary: boardSummary(written.value) }
  }

  async function save({ id, board, expectedRevision, origin: writer = 'user' }) {
    const record = await readRecord(id)
    // The board keeps the origin it was created with; a reader save ends board-level review
    // but item-level proposals survive until `accept`, so an auto-save cannot launder them.
    const merged = validateBoard({ ...board, id: record.value.id, created_at: record.value.created_at }, { id: record.value.id, origin: record.value.origin })
    const at = stamp()
    const stored = writer === 'llm'
      ? { ...markProposals(merged, record.value), updated_at: at, status: record.value.status }
      : { ...merged, created_at: record.value.created_at, updated_at: at, status: 'saved' }
    const written = await localState.put(boardKey(id), stored, expectedRevision)
    return { board: written.value, revision: written.revision, summary: boardSummary(written.value) }
  }

  /**
   * Explicit review action: accepting is a reader decision, never a side effect of
   * saving. A debounced auto-save must not silently convert model proposals into
   * the reader's own content, so `save` keeps item provenance and this flips it.
   */
  async function accept({ id, expectedRevision, itemIds }) {
    const record = await readRecord(id)
    let filter = null
    if (itemIds !== undefined) {
      if (!Array.isArray(itemIds) || itemIds.length > BOARD_LIMITS.nodes + BOARD_LIMITS.edges) throw boardError('接受改动的标识列表无效。')
      filter = new Set(itemIds.map(value => identifier(value, '接受改动的标识')))
    }
    const known = new Set([...record.value.nodes.map(node => node.id), ...record.value.edges.map(edge => edge.id)])
    const unknown = filter ? [...filter].filter(value => !known.has(value)) : []
    if (unknown.length) throw boardError(`画板中不存在这些标识：${unknown.slice(0, 5).join('、')}。`, 'BOARD_NOT_FOUND', 404)
    const apply = items => items.map(item => (item.origin === 'llm' && (!filter || filter.has(item.id)) ? { ...item, origin: 'user' } : item))
    const stored = { ...record.value, nodes: apply(record.value.nodes), edges: apply(record.value.edges), updated_at: stamp() }
    const written = await localState.put(boardKey(id), stored, expectedRevision)
    return {
      board: written.value, revision: written.revision, summary: boardSummary(written.value),
      accepted: stored.nodes.filter((node, index) => node.origin !== record.value.nodes[index].origin).length
        + stored.edges.filter((edge, index) => edge.origin !== record.value.edges[index].origin).length,
    }
  }

  /** Tombstone rather than unlink: the record stays recoverable by hand. */
  async function remove({ id, expectedRevision }) {
    const record = await readRecord(id)
    const written = await localState.put(boardKey(id), { id: record.value.id, title: record.value.title, deleted: true, deleted_at: stamp() }, expectedRevision)
    return { id: record.value.id, deleted: true, revision: written.revision }
  }

  /** Hashed content stays free of wall-clock fields so the same board revision always maps to one snapshot. */
  function snapshotContent(board, maxCharacters) {
    const outline = renderBoardOutline(board, { maxCharacters })
    const content = {
      schema: 1, board_id: board.id, board_title: board.title, board_updated_at: board.updated_at ?? null,
      characters: outline.text.length, truncated: outline.truncated, omitted: outline.omitted,
      text: outline.text,
    }
    return { content, snapshot_id: digest(JSON.stringify(content)) }
  }

  /** Freeze the material a user is sending; repeated sends stay idempotent. */
  async function snapshot({ id, maxCharacters }) {
    const record = await readRecord(id)
    const { content, snapshot_id } = snapshotContent(record.value, maxCharacters ?? BOARD_LIMITS.snapshotCharacters)
    let stored = await localState.get(snapshotKey(snapshot_id))
    if (!stored.value) {
      try { stored = await localState.put(snapshotKey(snapshot_id), content, 0) }
      catch (error) {
        // A concurrent identical send is the same immutable snapshot, not a conflict.
        if (error?.code !== 'STATE_CONFLICT') throw error
        stored = await localState.get(snapshotKey(snapshot_id))
        if (!stored.value) throw error
      }
    }
    return { ...stored.value, snapshot_id, frozen_at: stored.updated_at ?? null, label: `画板 ${record.value.title}` }
  }

  async function snapshotLoad(snapshotId) {
    if (typeof snapshotId !== 'string' || !HASH.test(snapshotId)) throw boardError('画板引用标识无效。')
    const record = await localState.get(snapshotKey(snapshotId))
    if (!record.value) throw boardError('这份画板引用已不存在，请从画板重新加入。', 'BOARD_SNAPSHOT_MISSING', 404)
    const { snapshot_id: _ignored, ...content } = record.value
    if (digest(JSON.stringify(content)) !== snapshotId) throw boardError('画板引用内容校验失败，已保留原记录。', 'BOARD_SNAPSHOT_CORRUPT', 500)
    return record.value
  }

  return { list, read, create, save, accept, remove, snapshot, snapshotLoad, renderBoardOutline, validateBoard }
}
