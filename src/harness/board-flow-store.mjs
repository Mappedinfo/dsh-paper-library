/** 画板的独立 paperFlow 工作区；节点画板、源文件与引用快照各自保持原格式。 */

import { createHash } from 'node:crypto'
import { BOARD_SNAPSHOT_PREFIX } from './board-store.mjs'
import { flowContextSelection, renderFlowContext } from './flow-context.mjs'

export const BOARD_FLOW_KEY_PREFIX = 'board-flow:'
export const BOARD_FLOW_LIMITS = Object.freeze({ workspaceBytes: 192 * 1024 })

const ID = /^[A-Za-z0-9_-]{1,60}$/
const REVISION = /^[a-f0-9]{64}$/
const failure = (message, code = 'BOARD_FLOW_INVALID', status = 400) => Object.assign(new Error(message), { code, status })

function boardId(value) {
  if (typeof value !== 'string' || !ID.test(value)) throw failure('工作区的画板标识必须是 1–60 位字母、数字、短横线或下划线。')
  return value
}

function revision(value) {
  if (value !== 0 && !(typeof value === 'string' && REVISION.test(value))) throw failure('保存工作区必须提供 expected_revision：首次为 0，随后使用读取到的版本。')
  return value
}

function checkBytes(value) {
  let text
  try { text = JSON.stringify(value) }
  catch { throw failure('paperFlow 工作区必须是可序列化的 JSON 对象。') }
  if (typeof text !== 'string') throw failure('paperFlow 工作区必须是 JSON 对象。')
  if (Buffer.byteLength(text, 'utf8') > BOARD_FLOW_LIMITS.workspaceBytes) throw failure('paperFlow 工作区超过 192 KiB，请拆分或导出后精简。', 'BOARD_FLOW_TOO_LARGE', 413)
}

async function normalizedWorkspace(value) {
  checkBytes(value)
  // 普通画板或空工作区读取不加载 paperFlow 的解析与布局依赖。
  const { validateFlowWorkspace } = await import('../paper-flow/validation.mjs')
  let workspace
  try { workspace = validateFlowWorkspace(value) }
  catch (error) {
    throw Object.assign(failure(error.message || 'paperFlow 工作区格式无效。'), { ...(error.diagnostics ? { diagnostics: error.diagnostics } : {}) })
  }
  // 解析器规范化可能扩展输入；按实际将落盘的 UTF-8 内容再检查一次。
  checkBytes(workspace)
  return workspace
}

export function createBoardFlowStore({ localState, boards }) {
  if (!localState || typeof localState.get !== 'function' || typeof localState.put !== 'function' || !boards || typeof boards.read !== 'function') {
    throw failure('paperFlow 需要画板与本机状态存储。', 'BOARD_FLOW_STORE_MISSING', 500)
  }

  async function get(id) {
    id = boardId(id)
    await boards.read(id)
    const record = await localState.get(`${BOARD_FLOW_KEY_PREFIX}${id}`)
    if (record.revision === 0) return { id, workspace: null, revision: 0 }
    let workspace
    try { workspace = await normalizedWorkspace(record.value) }
    catch { throw failure('已保存的 paperFlow 工作区格式损坏，原记录已保留，请人工检查或恢复备份。', 'BOARD_FLOW_CORRUPT', 500) }
    return { id, workspace, revision: record.revision }
  }

  async function save({ id, workspace, expectedRevision }) {
    id = boardId(id)
    revision(expectedRevision)
    await boards.read(id)
    const value = await normalizedWorkspace(workspace)
    // 父板检查和工作区写入是两条记录；并发删除父板时保留 sidecar，绝不级联删除。
    const written = await localState.put(`${BOARD_FLOW_KEY_PREFIX}${id}`, value, expectedRevision)
    return { id, workspace: written.value, revision: written.revision }
  }

  /** 保存已核对版本的有界材料，复用画板引用的不可变快照与校验路径。 */
  async function snapshot(input) {
    const id = boardId(input.id)
    revision(input.expected_revision)
    const selection = flowContextSelection(input)
    const record = await get(id)
    if (!record.workspace) throw failure('尚无已保存的流程工作区。', 'BOARD_FLOW_TARGET_MISSING', 404)
    if (record.revision !== input.expected_revision) throw failure('流程已在别处修改，请重新读取后再放入对话。', 'STATE_CONFLICT', 409)
    const parent = await boards.read(id)
    const outline = renderFlowContext(record.workspace, selection)
    const content = {
      schema: 1, board_id: id, board_title: parent.board.title, board_updated_at: parent.board.updated_at ?? null,
      flow: { paper_id: selection.paper_id, flow_id: selection.flow_id, node_ids: outline.selected, revision: record.revision },
      characters: outline.text.length, truncated: outline.truncated, omitted: outline.omitted,
      partial: outline.partial, included: outline.included, totals: outline.totals, text: outline.text,
    }
    const snapshot_id = createHash('sha256').update(JSON.stringify(content)).digest('hex')
    const key = BOARD_SNAPSHOT_PREFIX + snapshot_id
    let stored = await localState.get(key)
    if (!stored.value) {
      try { stored = await localState.put(key, content, 0) }
      catch (error) {
        if (error?.code !== 'STATE_CONFLICT') throw error
        stored = await localState.get(key)
        if (!stored.value) throw error
      }
    }
    return { ...stored.value, snapshot_id, frozen_at: stored.updated_at ?? null, label: '流程材料' }
  }

  return { get, save, snapshot }
}
