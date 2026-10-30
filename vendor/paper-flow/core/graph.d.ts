import type { FlowGraph, FlowDrawing } from "../types";
declare const engine: {
  svg(graph: FlowGraph, options?: { title?: string | false }): FlowDrawing;
  layout(graph: FlowGraph): any;
  lint(graph: FlowGraph): { phase: string; path: string; message: string }[];
  match(a: FlowGraph, b: FlowGraph, overrides?: unknown[], options?: unknown): any;
  merge(a: FlowGraph, b: FlowGraph, report: any): FlowGraph;
  collapse(graph: FlowGraph): FlowGraph;
  [key: string]: any;
};
export default engine;
