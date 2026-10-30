/** 画板的独立 paperFlow 工作区；节点画板、源文件与引用快照各自保持原格式。 */

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

  return { get, save }
}
