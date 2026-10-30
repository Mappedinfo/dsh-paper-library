/** 读者批注独立保存在画板 sidecar；不写源图、PDF 或模型提案。可在浏览器复用。 */
import { BOARD_ANNOTATION_LIMITS, annotationError, boardAnnotationId, boardAnnotationRevision, boardAnnotationComment, normalizeBoardAnnotationTarget, normalizeBoardAnnotationRecord, boardAnnotationSource } from '../board-annotation-schema.mjs'
export { BOARD_ANNOTATION_LIMITS }
export const BOARD_ANNOTATION_KEY_PREFIX = 'board-annotations:'
const empty = () => ({ schema: 'paper-library-board-annotations.v1', notes: [] })
export function createBoardAnnotationStore({ localState, boards, flowStore } = {}) {
  if (!localState?.get || !localState?.put || !boards?.read) throw annotationError('画板批注需要画板和本机状态存储。', 'BOARD_ANNOTATION_STORE_MISSING', 500)
  async function read(id) {
    id = boardAnnotationId(id)
    const parent = await boards.read(id)
    const record = await localState.get(`${BOARD_ANNOTATION_KEY_PREFIX}${id}`)
    let value
    try { value = record.revision === 0 ? empty() : normalizeBoardAnnotationRecord(record.value) }
    catch { throw annotationError('已保存的画板批注损坏，原记录仍保留，请先备份再检查。', 'BOARD_ANNOTATION_CORRUPT', 500) }
    return { id, parent, value, revision: record.revision }
  }
  async function source(target, parent, id) {
    const workspace = target.kind === 'flow' ? (await flowStore?.get(id))?.workspace : undefined
    return boardAnnotationSource(target, { board: parent.board, workspace })
  }
  async function decorate(record, notes) {
    const workspace = notes.some(note => note.target.kind === 'flow') ? (await flowStore?.get(record.id))?.workspace : undefined
    return notes.map(note => ({ ...note, stale: boardAnnotationSource(note.target, { board: record.parent.board, workspace }).stale }))
  }
  async function list(id) {
    const record = await read(id)
    return { id: record.id, revision: record.revision, notes: await decorate(record, record.value.notes) }
  }
  async function write(record, expectedRevision, notes) {
    boardAnnotationRevision(expectedRevision)
    const value = normalizeBoardAnnotationRecord({ schema: 'paper-library-board-annotations.v1', notes })
    const visibleNotes = await decorate(record, value.notes)
    const saved = await localState.put(`${BOARD_ANNOTATION_KEY_PREFIX}${record.id}`, value, expectedRevision)
    return { id: record.id, revision: saved.revision, notes: visibleNotes }
  }
  async function create({ id, target, comment, expectedRevision }) {
    boardAnnotationRevision(expectedRevision)
    target = normalizeBoardAnnotationTarget(target); comment = boardAnnotationComment(comment)
    const record = await read(id)
    if (record.value.notes.length >= BOARD_ANNOTATION_LIMITS.notes) throw annotationError('每张画板最多保留 200 条批注。')
    const resolved = await source(target, record.parent, record.id)
    if (resolved.stale) throw annotationError('批注目标已移除或尚未保存，请保存画板／流程后重新选中。', 'BOARD_ANNOTATION_TARGET_MISSING', 409)
    const now = new Date().toISOString()
    return write(record, expectedRevision, [...record.value.notes, { id: `note-${globalThis.crypto.randomUUID()}`, target, comment, label: resolved.label, quote: resolved.quote, created_at: now, updated_at: now }])
  }
  async function update({ id, noteId, comment, expectedRevision }) {
    boardAnnotationRevision(expectedRevision); noteId = boardAnnotationId(noteId); comment = boardAnnotationComment(comment)
    const record = await read(id)
    if (!record.value.notes.some(note => note.id === noteId)) throw annotationError('批注已移除，请重新读取。', 'BOARD_ANNOTATION_NOT_FOUND', 404)
    return write(record, expectedRevision, record.value.notes.map(note => note.id === noteId ? { ...note, comment, updated_at: new Date().toISOString() } : note))
  }
  async function remove({ id, noteId, expectedRevision }) {
    boardAnnotationRevision(expectedRevision); noteId = boardAnnotationId(noteId)
    const record = await read(id)
    if (!record.value.notes.some(note => note.id === noteId)) throw annotationError('批注已移除，请重新读取。', 'BOARD_ANNOTATION_NOT_FOUND', 404)
    return write(record, expectedRevision, record.value.notes.filter(note => note.id !== noteId))
  }
  return { list, create, update, remove }
}
export async function handleBoardAnnotationRequest(store, input, { writer = 'user' } = {}) {
  if (writer !== 'user') throw annotationError('画板批注只允许读者本人操作。', 'BOARD_FORBIDDEN', 403)
  if (!store) throw annotationError('画板批注存储尚未连接。', 'BOARD_ANNOTATION_STORE_MISSING', 500)
  if (input.action === 'board_annotations_list') return store.list(input.id)
  const common = { id: input.id, expectedRevision: input.expected_revision }
  if (input.action === 'board_annotations_create') return store.create({ ...common, target: input.target, comment: input.comment })
  if (input.action === 'board_annotations_update') return store.update({ ...common, noteId: input.note_id, comment: input.comment })
  if (input.action === 'board_annotations_delete') return store.remove({ ...common, noteId: input.note_id })
  throw annotationError('不支持的画板批注操作。')
}
