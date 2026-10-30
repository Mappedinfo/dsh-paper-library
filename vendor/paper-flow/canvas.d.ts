import type { FlowCanvasProps } from "./FlowCanvas";
import type { FlowDrawing } from "./types";
export function downloadFile(name: string, data: string | Blob, type: string): void;
export function mountFlowCanvas(
  root: ShadowRoot,
  initial: FlowCanvasProps,
): {
  update(props: FlowCanvasProps): void;
  drawing(): FlowDrawing | undefined;
  highlight(related: any): void;
  focus(ids: string[]): void;
  dispose(): void;
};
