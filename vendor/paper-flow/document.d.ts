import type {
  PaperFlowDocument,
  FlowRef,
  FlowViewOptions,
  FlowComparisonSpec,
  FlowGraph,
  FlowWorkspace,
  FlowParseResult,
  FlowDiagnostic,
  FlowEditDraft,
} from "./types";
export function defaultView(): FlowViewOptions;
export function defaultComparison(): FlowComparisonSpec;
export function flowKey(ref: FlowRef): string;
export function draftKey(ref: FlowRef, view: FlowViewOptions): string;
export function resolveFlow(workspace: FlowWorkspace, ref?: FlowRef): FlowGraph | undefined;
export function normalizeGraph(graph: FlowGraph): FlowGraph;
export function createWorkspace(
  documents: PaperFlowDocument[],
  selection?: FlowWorkspace["selection"],
): FlowWorkspace;
export function validateGraph(graph: unknown, path?: string): FlowDiagnostic[];
export function validateDocument(document: unknown, path?: string): FlowDiagnostic[];
export function parseFlowInput(input: unknown): FlowParseResult;
export function serializeWorkspace(workspace: FlowWorkspace): string;
export function blankDraft(): FlowEditDraft;
