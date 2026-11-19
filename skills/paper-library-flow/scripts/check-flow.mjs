import { readFileSync, statSync } from 'node:fs'
import { extname } from 'node:path'
import { FLOW_LIMITS, validateFlowWorkspace } from '../../../src/paper-flow/validation.mjs'
import { eqTraceFlows, renderEqTraceFigure } from '../../../src/paper-flow/eqtrace-figure.mjs'
import { nodeTensorPreview } from '../../../src/paper-flow/tensor-preview.mjs'

// 使用同一套导入、渲染与张量预览规则，只输出摘要和源码定位。
function loadFlows(file) {
  if (extname(file).toLowerCase() !== '.json') throw Error('请选择 .json 文件。')
  const stat = statSync(file)
  if (!stat.isFile()) throw Error('请选择普通文件。')
  const limit = FLOW_LIMITS.workspaceBytes
  if (stat.size > limit) throw Error(`JSON 超过画板的 ${limit / 1024} KiB 限额。`)
  const bytes = readFileSync(file)
  if (bytes.length > limit) throw Error('读取时文件超过画板限额。')
  let raw
  try { raw = JSON.parse(bytes.toString('utf8')) }
  catch { throw Error('JSON 语法无效。') }
  if (raw?.kind !== 'paper-flow-document' || raw.schemaVersion !== 1) {
    throw Error('需要 EqTrace 导出的 schemaVersion 1 的 paper-flow-document。')
  }
  const [document] = validateFlowWorkspace(raw).documents
  const flows = eqTraceFlows(document)
  if (!flows.length || flows.length !== document.flows.length) {
    throw Error('画板未能把文档中的每一幅图识别为 EqTrace 网络图或训练图。')
  }
  return flows
}

function report(flow) {
  const modes = flow.figure_overview ? ['full', 'overview'] : ['full']
  for (const detail of modes) {
    const svg = renderEqTraceFigure(flow, { detail })
    const graph = detail === 'full' ? flow : flow.figure_overview
    const drawnNodes = (svg.match(/<g data-node="/gu) || []).length
    if (!drawnNodes || drawnNodes !== graph.nodes.length) throw Error(`${flow.id} 的 ${detail} 视图未画出全部节点。`)
  }
  const diagnostics = Array.isArray(flow.diagnostics) ? flow.diagnostics : []
  const unresolved = flow.nodes.filter(node => node.op === 'unresolved' || node.config?.resolution === 'unresolved')
  const incomplete = flow.nodes.filter(node => ['unknown', 'partial'].includes(nodeTensorPreview(node).status))
  console.log(`${flow.id} · ${flow.nodes.length} 个节点，${flow.edges.length} 条边，已渲染 ${modes.join(' / ')}`)
  console.log(`  静态诊断 ${diagnostics.length} 条，未解析操作 ${unresolved.length} 个，形状未知或部分已知 ${incomplete.length} 个节点`)
  for (const item of diagnostics.slice(0, 3)) {
    console.log('  诊断', brief(item?.code), brief(item?.evidence), brief(item?.message))
  }
  for (const node of [...new Set([...unresolved, ...incomplete])].slice(0, 3)) {
    console.log('  节点', brief(node.id), brief(node.evidence), nodeTensorPreview(node).status)
  }
}

function brief(value) {
  return typeof value === 'string' ? value.replace(/[\s\p{Cc}]+/gu, ' ').trim().slice(0, 180) : ''
}

try {
  if (process.argv.length !== 3) throw Error('用法：node check-flow.mjs <流程.json>')
  for (const flow of loadFlows(process.argv[2])) report(flow)
} catch (error) {
  console.error('核验失败：' + brief(error.message))
  process.exitCode = 1
}
