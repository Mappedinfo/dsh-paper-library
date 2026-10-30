export type FlowNodeKind = "data" | "method" | "model" | "representation" | "output" | "decision";
export type FlowPort = { type: string; [key: string]: unknown };
export type FlowNode = {
  id: string;
  label: string;
  type: FlowNodeKind | string;
  ports: { in: Record<string, FlowPort>; out: Record<string, FlowPort> };
  op?: string;
  semantic_key?: string;
  hover_role?: string;
  trunk_control?: boolean;
  stage?: string;
  layout?: { optimizePosition?: boolean; [key: string]: unknown };
  config?: Record<string, unknown>;
  detail?: string;
  evidence?: string;
  logical?: {
    key: string;
    function: string;
    constraints?: Record<string, unknown>;
    compare_fields?: string[];
    [key: string]: unknown;
  };
  [key: string]: unknown;
};
export type FlowEdge = {
  id: string;
  from: string;
  to: string;
  kind?: string;
  semantic?: string;
  label?: string;
  hover_key?: string;
  layout?: { preferStraight?: boolean; [key: string]: unknown };
  [key: string]: unknown;
};
export type FlowGroup = { id: string; label: string; members: string[]; logical?: FlowNode['logical']; [key: string]: unknown };
export type FlowGraph = {
  id: string;
  name: string;
  nodes: FlowNode[];
  edges: FlowEdge[];
  stages?: { id: string; title: string; [key: string]: unknown }[];
  paper_groups?: FlowGroup[];
  detail_groups?: FlowGroup[];
  [key: string]: unknown;
};
export type PaperFlowDocument = {
  schemaVersion: 1;
  kind: "paper-flow-document";
  paper: {
    id: string;
    title: string;
    citation?: string;
    url?: string;
    sources?: string[];
    [key: string]: unknown;
  };
  flows: FlowGraph[];
};
export type FlowRef = { documentId: string; flowId: string };
export type FlowViewOptions = {
  arrangement: "trunks" | "compact" | "vertical";
  treeLevels: "expanded" | "compact";
  detail: "full" | "overview";
  grouping: boolean;
  zoom: "fit" | number;
  hoverMotion: boolean;
  mode: "parallel" | "merged";
};
export type FlowAnchor = {
  side: "top" | "right" | "bottom" | "left";
  offset: number;
  fixed?: boolean;
};
export type FlowEditDraft = {
  nodes: Record<string, { x: number; y: number; fixed?: boolean }>;
  edges: Record<
    string,
    {
      line?: "auto" | "solid" | "dashed" | "dotted";
      start?: FlowAnchor;
      end?: FlowAnchor;
      route?: { x: number; y: number }[];
    }
  >;
  relations: FlowEdge[];
};
export type FlowCorrespondence = {
  id: string;
  a: string;
  b: string;
  reason: string;
  kind: "node" | "group";
};
export type FlowComparisonSpec = {
  mode: "strict" | "logical";
  correspondences: FlowCorrespondence[];
  exclusions: { a: string; b: string }[];
  stageMap?: {
    a: Record<string, string>;
    b: Record<string, string>;
    stages: { id: string; title: string }[];
  };
};
export type FlowWorkspace = {
  schemaVersion: 1;
  kind: "paper-flow-workspace";
  documents: PaperFlowDocument[];
  selection: { left: FlowRef; right?: FlowRef };
  view: FlowViewOptions;
  comparison: FlowComparisonSpec;
  drafts: Record<string, FlowEditDraft>;
};
export type FlowDiagnostic = {
  severity: "error" | "warning";
  code: string;
  path: string;
  message: string;
};
export type FlowParseResult =
  | { ok: true; value: FlowWorkspace; diagnostics: FlowDiagnostic[] }
  | { ok: false; diagnostics: FlowDiagnostic[] };
export type FlowDrawing = { svg: string; width: number; height: number; layout: any; routing: any };
export type FlowServices = { exportPdf?: (svg: string, signal: AbortSignal) => Promise<Blob> };
