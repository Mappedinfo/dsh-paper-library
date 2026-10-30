import { createWorkspace } from '../../vendor/paper-flow/document.js'

/** Neutral examples contain no project or research material. */
export function starterWorkspace(example = false) {
  const nodes = example
    ? [{ id: 'input', label: '输入材料', type: 'data', ports: { in: {}, out: { output: { type: 'data' } } } }, { id: 'analysis', label: '分析步骤', type: 'method', ports: { in: { input: { type: 'data' } }, out: {} } }]
    : [{ id: 'step', label: '新步骤', type: 'method', ports: { in: {}, out: {} } }]
  const document = { schemaVersion: 1, kind: 'paper-flow-document', paper: { id: 'local-flow', title: example ? '教学示例' : '未命名流程' }, flows: [{ id: 'flow', name: example ? '示例流程' : '新流程', nodes, edges: example ? [{ id: 'edge', from: 'input:output', to: 'analysis:input' }] : [] }] }
  return createWorkspace([document])
}
