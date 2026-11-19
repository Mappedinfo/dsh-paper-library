import { validateFlowWorkspace } from './validation.mjs'
import { eqTraceFlows } from './eqtrace-figure.mjs'

export const SOURCE_BYTE_LIMIT = 256 * 1024

export async function readEqTraceSource(file) {
  if (!file) return undefined
  if (!/\.py$/iu.test(file.name)) throw Error('请选择 Python 源文件（.py）。')
  if (file.size > SOURCE_BYTE_LIMIT) throw Error(`${file.name} 超过单文件 256 KiB 限制。`)
  return { name: file.name, text: await file.text() }
}

export function addEqTraceDocument(existing, document) {
  if (document?.kind !== 'paper-flow-document' || !eqTraceFlows(document).length) throw Error('需要含网络结构或训练流程的 EqTrace 流程文档。')
  const imported = validateFlowWorkspace(document)
  if (!existing) return { workspace: imported, documentId: document.paper.id }
  const id = document.paper.id, documents = [...existing.documents]
  let suffix = 1, newId = id
  for (;;) {
    const other = documents.find(item => item.paper.id === newId)
    if (!other) {
      documents.push({ ...document, paper: { ...document.paper, id: newId } })
      break
    }
    const normalized = { ...other, paper: { ...other.paper, id } }
    if (JSON.stringify(normalized) === JSON.stringify(document)) break
    newId = `${id}-${++suffix}`
  }
  const selection = existing.selection.right ? existing.selection : { left: { documentId: newId, flowId: imported.selection.left.flowId } }
  return { workspace: validateFlowWorkspace({ ...existing, documents, selection }), documentId: newId }
}
