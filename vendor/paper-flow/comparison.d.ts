import type {
  FlowGraph,
  FlowViewOptions,
  FlowComparisonSpec,
  FlowDrawing,
  FlowEditDraft,
} from "./types";
export function prepareGraph(
  graph: FlowGraph,
  options: FlowViewOptions,
  draft?: FlowEditDraft,
): FlowGraph;
export function compareFlows(
  a: FlowGraph,
  b: FlowGraph,
  spec?: FlowComparisonSpec,
): { a: FlowGraph; b: FlowGraph; merged: FlowGraph; report: any };
export function namespaceSvg(svg: string, namespace: string): string;
export function combineSvg(drawings: FlowDrawing[]): string;
