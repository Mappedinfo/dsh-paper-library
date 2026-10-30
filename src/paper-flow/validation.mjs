import { parseFlowInput } from '../../vendor/paper-flow/document.js'
export { FLOW_LIMITS } from '../../vendor/paper-flow/budget.js'

/** Validate and normalize before any workspace reaches storage or the canvas. */
export function validateFlowWorkspace(input) {
  const result = parseFlowInput(input)
  if (!result.ok) {
    const error = new Error(result.diagnostics.map(item => `${item.path}: ${item.message}`).join('\n'))
    error.code = 'PAPER_FLOW_INVALID'
    error.diagnostics = result.diagnostics
    throw error
  }
  return result.value
}
