import { useMemo, useRef } from "react";
import { FlowCanvas, type FlowCanvasHandle } from "./FlowCanvas";
import { compareFlows } from "./comparison.js";
import engine from "./core/graph.js";
import { comparisonPeers } from "./core/hover.js";
import type {
  FlowComparisonSpec,
  FlowDrawing,
  FlowEditDraft,
  FlowGraph,
  FlowViewOptions,
} from "./types";
export type FlowCompareProps = {
  a: FlowGraph;
  b: FlowGraph;
  identityA: string;
  identityB: string;
  options: FlowViewOptions;
  spec: FlowComparisonSpec;
  comparison?: ReturnType<typeof compareFlows>;
  draftA: FlowEditDraft;
  draftB: FlowEditDraft;
  mergedDraft: FlowEditDraft;
  editable?: boolean;
  onEditingChange?: (enabled: boolean) => void;
  onDraftChange: (lane: "a" | "b" | "merged", draft: FlowEditDraft) => void;
  onNodeSelect: (lane: "a" | "b" | "merged", id: string) => void;
  onDrawing: (lane: "a" | "b" | "merged", drawing: FlowDrawing) => void;
  onZoomChange: (zoom: number) => void;
};
export function FlowCompare(props: FlowCompareProps) {
  const a = useRef<FlowCanvasHandle>(null),
    b = useRef<FlowCanvasHandle>(null);
  const current = useMemo(
    () => props.comparison || compareFlows(props.a, props.b, props.spec),
    [props.a, props.b, props.spec, props.comparison],
  );
  const peer = useMemo(() => {
    const manual = current.report.correspondences.flatMap((p: any) =>
      p.kind === "node"
        ? [p]
        : [
            p,
            ...(current.a.paper_groups?.find((g) => g.id === p.a)?.members || []).flatMap((a) =>
              (current.b.paper_groups?.find((g) => g.id === p.b)?.members || []).map((b) => ({
                a,
                b,
              })),
            ),
          ],
    );
    return comparisonPeers({
      ...current,
      r: { ...current.report, pairs: [...current.report.pairs, ...manual] },
    });
  }, [current]);
  const aligned = useMemo(
    () =>
      props.spec.stageMap
        ? engine.alignStageLayouts(
            {
              ...current.a,
              phase_schema: "paper-flow.explicit",
              presentation_layout: props.options.arrangement,
            },
            {
              ...current.b,
              phase_schema: "paper-flow.explicit",
              presentation_layout: props.options.arrangement,
            },
          )
        : { a: current.a, b: current.b },
    [current, props.spec.stageMap, props.options.arrangement],
  );
  const hover = (lane: "a" | "b", related: any) => {
    (lane === "a" ? b : a).current?.highlight(related ? peer(lane, related) : null);
  };
  const drawing = (
    lane: "a" | "b" | "merged",
    graph: FlowGraph,
    draft: FlowEditDraft,
    identity: string,
    ref?: React.Ref<FlowCanvasHandle>,
  ) => (
    <FlowCanvas
      ref={ref}
      graph={graph}
      identity={identity}
      options={props.options}
      draft={draft}
      editable={props.editable}
      onEditingChange={props.onEditingChange}
      onDraftChange={(d) => props.onDraftChange(lane, d)}
      onNodeSelect={(id) => props.onNodeSelect(lane, id)}
      onDrawing={(d) => props.onDrawing(lane, d)}
      onHover={(r) => lane !== "merged" && hover(lane, r)}
      onZoomChange={props.onZoomChange}
    />
  );
  return (
    <>
      <div className={props.options.mode === "parallel" ? "paper-flow-pair" : "paper-flow-single"}>
        {props.options.mode === "parallel" ? (
          <>
            <section aria-label="论文 A">
              <h3>A · {props.a.name}</h3>
              {drawing("a", aligned.a, props.draftA, props.identityA, a)}
            </section>
            <section aria-label="论文 B">
              <h3>B · {props.b.name}</h3>
              {drawing("b", aligned.b, props.draftB, props.identityB, b)}
            </section>
          </>
        ) : (
          <section>
            <h3>流程结构与规格比较</h3>
            {drawing(
              "merged",
              current.merged,
              props.mergedDraft,
              props.identityA + props.identityB,
            )}
          </section>
        )}
      </div>
    </>
  );
}

/** Report content can be shown without changing or remounting either canvas. */
export function FlowComparisonReport({ report }: { report: ReturnType<typeof compareFlows>["report"] }) {
  return (
      <div className="paper-flow-report-content">
        <p>规则匹配 {report.pairs.length} 项 · 人工对应 {report.correspondences.length} 项</p>
        <p>比较仅依据输入声明；匹配项列出所用字段，其余声明分别保留。字段对应不证明科学等价或结果可直接排名。</p>
        <ul>
          {report.pairs.map((p: any) => (
            <li key={p.a + "/" + p.b}>
              {p.a} ↔ {p.b}：{p.reason}
              <details>
                <summary>比较依据与范围</summary>
                <p>已比较：{p.comparedFields?.join("、") || "无"}</p>
                <p>未作为匹配依据：{p.notCompared?.join("、") || "无"}</p>
              </details>
              {p.spec_differences.length > 0 && (
                <details>
                  <summary>具体规格差异</summary>
                  <pre>{JSON.stringify(p.spec_differences, null, 2)}</pre>
                </details>
              )}
            </li>
          ))}
          {report.correspondences.map((p: any) => (
            <li key={p.id}>
              {p.a} ↔ {p.b}：人工对应 · {p.reason}
            </li>
          ))}
          {[
            ...report.aOnly.map((p: any) => ({ ...p, lane: "A" })),
            ...report.bOnly.map((p: any) => ({ ...p, lane: "B" })),
          ].map((p: any) => (
            <li key={p.lane + p.id}>
              {p.lane} · {p.id}：{p.reason}
            </li>
          ))}
          {report.notes.map((n: string, i: number) => (
            <li key={i}>{n}</li>
          ))}
        </ul>
        {report.edgePairs.length > 0 && (
          <details>
            <summary>匹配关系 · {report.edgePairs.length}</summary>
            <ul>
              {report.edgePairs.map((p: any) => (
                <li key={p.a + "/" + p.b}>
                  {p.a} ↔ {p.b}：{p.reason}
                  <p>未作为匹配依据：{p.notCompared?.join("、") || "无"}</p>
                  {p.declaredDifferences?.length > 0 && (
                    <pre>{JSON.stringify(p.declaredDifferences, null, 2)}</pre>
                  )}
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
  );
}
