/** Whiteboard surface shared by the authenticated HTTP API and the native agent tool.
 *
 * Both callers run the same store operations, so provenance is decided by the
 * caller and never by the payload: a browser request is always a user write,
 * and the tool is always a model write. A browser therefore cannot label its own
 * content as AI output, and the agent cannot label its content as the reader's.
 */
import { BOARD_LIMITS } from './board-store.mjs'

const text = (description, required = false) => ({ type: 'string', description, ...(required ? { required: true } : {}) })

export const BOARD_TOOL_SPECS = [
  {
    name: 'library_board', action: 'board_tool', title: 'Read and write literature whiteboards', mutate: true, board: true,
    parameters: {
      operation: { type: 'string', enum: ['list', 'get', 'create', 'save', 'delete'], required: true },
      input_json: text('JSON object for the chosen operation. list: {}; get: {id}; create: {title,nodes,edges,view?}; save: {id,expected_revision,title,nodes,edges,view?}; delete: {id,expected_revision}. save replaces the whole board, so it must include the existing nodes and edges you are not changing. Your own additions and edits stay marked as reviewable proposals until the reader accepts them. Node kinds are text|note|concept|paper|rect|ellipse|diamond; a paper node carries {paper:{id,title?,year?,citekey?}}. A whole board is at most 200 KiB, 400 nodes and 800 edges.', true),
    },
  },
]

const OPERATIONS = new Set(BOARD_TOOL_SPECS[0].parameters.operation.enum)

/** Parse the tool payload once; the store validates every field afterwards. */
export function boardToolRequest(spec, args) {
  const operation = args.operation
  if (!OPERATIONS.has(operation)) throw new Error('Unsupported whiteboard operation')
  if (typeof args.input_json !== 'string' || Buffer.byteLength(args.input_json, 'utf8') > 210 * 1024) throw new Error('Whiteboard input_json requires an object within 210 KiB')
  let value
  try { value = JSON.parse(args.input_json) } catch { throw new Error('input_json must be valid JSON') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('input_json must be an object')
  if (['action', 'library', 'python', 'origin'].some(key => Object.hasOwn(value, key))) throw new Error('Whiteboard operation and provenance are owned by the host')
  return { ...value, action: `board_${operation}` }
}

const asRevision = value => {
  if (value === 0) return 0
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw Object.assign(new Error('保存画板必须提供 expected_revision：首次为 0，随后使用读取到的版本。'), { code: 'BOARD_INVALID', status: 400 })
  return value
}

const BOARD_FIELDS = ['title', 'nodes', 'edges', 'view']

/**
 * Accept the panel's nested `board` object and the tool's flat payload, but never
 * both at once: an ambiguous payload could silently write a different board.
 * A missing board is only tolerable for a create, where a blank canvas is a real
 * request; a save without content would silently erase the reader's nodes.
 */
function boardFrom(input) {
  const flat = BOARD_FIELDS.filter(field => input[field] !== undefined)
  if (input.board !== undefined && flat.length) throw Object.assign(new Error('画板内容不能同时以 board 和顶层字段提供。'), { code: 'BOARD_INVALID', status: 400 })
  if (input.board !== undefined) {
    if (!input.board || typeof input.board !== 'object' || Array.isArray(input.board)) throw Object.assign(new Error('board 必须是对象。'), { code: 'BOARD_INVALID', status: 400 })
    return input.board
  }
  if (!flat.length) return undefined
  return Object.fromEntries(flat.map(field => [field, input[field]]))
}

/** One request path for both callers; `writer` is 'user' or 'llm'. */
export async function handleBoardRequest(store, input, { writer = 'user' } = {}) {
  const action = input?.action
  if (action === 'board_list') return store.list()
  if (action === 'board_get') return store.read(input.id)
  if (action === 'board_create') return store.create({ board: boardFrom(input) ?? {}, origin: writer })
  if (action === 'board_save') {
    const board = boardFrom(input)
    if (!board) throw Object.assign(new Error('保存画板必须提供完整画板内容（title、nodes、edges）。'), { code: 'BOARD_INVALID', status: 400 })
    const expectedRevision = asRevision(input.expected_revision)
    return store.save({ id: input.id, board, expectedRevision, origin: writer })
  }
  if (action === 'board_delete') return store.remove({ id: input.id, expectedRevision: asRevision(input.expected_revision) })
  if (action === 'board_accept') {
    // Accepting model proposals is the reader's own decision; the agent can never do it for them.
    if (writer !== 'user') throw Object.assign(new Error('只有读者本人可以接受画板上的 AI 改动。'), { code: 'BOARD_FORBIDDEN', status: 403 })
    return store.accept({ id: input.id, expectedRevision: asRevision(input.expected_revision), itemIds: input.item_ids })
  }
  if (action === 'board_snapshot') {
    // Only the reader freezes material for a conversation; the agent reads the outline directly.
    if (writer !== 'user') throw Object.assign(new Error('画板快照只能由读者本人创建。'), { code: 'BOARD_FORBIDDEN', status: 403 })
    const requested = input.max_characters
    if (requested !== undefined && (!Number.isSafeInteger(requested) || requested < 500 || requested > BOARD_LIMITS.snapshotCharacters)) {
      throw Object.assign(new Error(`画板引用预算必须在 500–${BOARD_LIMITS.snapshotCharacters} 字符之间。`), { code: 'BOARD_INVALID', status: 400 })
    }
    return store.snapshot({ id: input.id, maxCharacters: requested })
  }
  throw Object.assign(new Error('不支持的画板操作。'), { code: 'BOARD_INVALID', status: 400 })
}
