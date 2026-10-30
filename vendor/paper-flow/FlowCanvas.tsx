import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { mountFlowCanvas } from "./canvas.js";
import style from "./workbench.css?inline";
import type { FlowDrawing, FlowEditDraft, FlowGraph, FlowViewOptions } from "./types";
export type FlowCanvasHandle = {
  drawing(): FlowDrawing | undefined;
  highlight(related: any): void;
  focus(ids: string[]): void;
};
export type FlowCanvasProps = {
  graph: FlowGraph;
  identity: string;
  options: FlowViewOptions;
  draft: FlowEditDraft;
  editable?: boolean;
  onEditingChange?: (enabled: boolean) => void;
  onDraftChange?: (draft: FlowEditDraft) => void;
  onNodeSelect?: (id: string) => void;
  onDrawing?: (drawing: FlowDrawing) => void;
  onHover?: (related: any, origin?: any) => void;
  onZoomChange?: (zoom: number) => void;
  onError?: (message: string) => void;
};
let instanceSerial = 0;
export const FlowCanvas = forwardRef<FlowCanvasHandle, FlowCanvasProps>(
  function FlowCanvas(props, ref) {
    const host = useRef<HTMLDivElement>(null),
      api = useRef<ReturnType<typeof mountFlowCanvas> | null>(null),
      latest = useRef(props);
    const previous = useRef<FlowCanvasProps | null>(null);
    const namespace = useRef("");
    if (!namespace.current) namespace.current = `flow-${++instanceSerial}`;
    latest.current = props;
    const parameters = () => ({
      ...latest.current,
      identity: namespace.current + "-" + latest.current.identity,
    });
    useImperativeHandle(
      ref,
      () => ({
        drawing: () => api.current?.drawing(),
        highlight: (r) => api.current?.highlight(r),
        focus: (ids) => api.current?.focus(ids),
      }),
      [],
    );
    useEffect(() => {
      if (!host.current) return;
      const root = host.current.shadowRoot || host.current.attachShadow({ mode: "open" });
      api.current = mountFlowCanvas(root, parameters());
      previous.current = props;
      const css = root.ownerDocument.createElement("style");
      css.textContent =
        style +
        `\n:host{display:block;--font-ui:14px;--font-caption:13px}.canvas{height:620px;min-height:300px;display:block;padding:0}.graph-wrap{height:100%;max-height:none;width:100%;border:0}.graph-content{min-width:max-content}.canvas-error{position:absolute;top:10px;left:12px;right:12px;background:white;color:#b42318;padding:12px;border:1px solid #b42318}`;
      root.prepend(css);
      return () => {
        api.current?.dispose();
        api.current = null;
      };
    }, []);
    useEffect(() => {
      if (previous.current !== props) {
        api.current?.update(parameters());
        previous.current = props;
      }
    }, [props.graph, props.identity, props.options, props.draft, props.editable]);
    return <div className="paper-flow-canvas" ref={host} />;
  },
);
