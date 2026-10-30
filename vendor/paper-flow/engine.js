// Headless entry: no React, CSS, project adapter or browser state dependency.
export { default as flowEngine } from "./core/graph.js";
export {
  createWorkspace,
  parseFlowInput,
  serializeWorkspace,
  validateDocument,
  validateGraph,
  defaultView,
  defaultComparison,
} from "./document.js";
export { compareFlows, prepareGraph, combineSvg } from "./comparison.js";
