import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { FlowCanvas, type FlowCanvasHandle } from "./FlowCanvas";
import { FlowCompare, FlowComparisonReport } from "./FlowCompare";
import { FlowLegend } from "./FlowLegend";
import { FlowWindow } from "./FlowWindow";
import {
  blankDraft,
  draftKey,
  flowKey,
  parseFlowInput,
  resolveFlow,
  serializeWorkspace,
  defaultComparison,
} from "./document.js";
import { combineSvg, compareFlows } from "./comparison.js";
import { downloadFile } from "./canvas.js";
import { createImportGuard } from "./import-guard.js";
import { selectionContexts } from "./selection-context.js";
import { isFlowFileDrag, selectFlowImportFile } from "./import-files.js";
import type {
  FlowDiagnostic,
  FlowDrawing,
  FlowEditDraft,
  FlowGraph,
  FlowNode,
  FlowParseResult,
  FlowRef,
  FlowServices,
  FlowWorkspace,
} from "./types";
import "./paperFlow.css";
export type PaperFlowWorkbenchHandle = {
  load(input: unknown): FlowParseResult;
  focus(ref: FlowRef, ids: string[]): void;
  snapshot(): FlowWorkspace;
  exitFullscreen(): void;
};
export type PaperFlowWorkbenchProps = {
  workspace: FlowWorkspace;
  onWorkspaceChange: (workspace: FlowWorkspace) => void;
  services?: FlowServices;
  renderNodeDetails?: (node: FlowNode, graph: FlowGraph, contexts: { ref: FlowRef; nodeIds: string[]; side: string }[]) => ReactNode;
  onNodeSelect?: (contexts: { ref: FlowRef; nodeIds: string[]; side: string }[]) => void;
  toolbar?: ReactNode;
};
const valueOf = (ref: FlowRef) => JSON.stringify(ref);
let workbenchSerial = 0;
const mergedKey = (w: FlowWorkspace) =>
  JSON.stringify([
    "@comparison",
    w.selection.left.documentId,
    w.selection.left.flowId,
    w.selection.right?.documentId,
    w.selection.right?.flowId,
    w.view.arrangement,
    w.view.treeLevels,
    w.view.detail,
    w.view.grouping,
    w.comparison,
  ]);
export const PaperFlowWorkbench = forwardRef<PaperFlowWorkbenchHandle, PaperFlowWorkbenchProps>(
  function PaperFlowWorkbench(
    { workspace: w, onWorkspaceChange, services, renderNodeDetails, onNodeSelect, toolbar },
    ref,
  ) {
    const [editable, setEditable] = useState(false),
      [diagnostics, setDiagnostics] = useState<FlowDiagnostic[]>([]),
      [message, setMessage] = useState(""),
      [detail, setDetail] = useState<{ node: FlowNode; graph: FlowGraph; contexts?: { ref: FlowRef; nodeIds: string[]; side: string }[] } | null>(null),
      [manual, setManual] = useState({
        kind: "node" as "node" | "group",
        a: "",
        b: "",
        reason: "",
      }),
      [fullscreen, setFullscreen] = useState(false),
      [pdfBusy, setPdfBusy] = useState(false),
      [dropActive, setDropActive] = useState(false),
      [fileState, setFileState] = useState<{ name: string; ticket?: { generation: number; workspace: FlowWorkspace } }>({ name: "" }),
      [windows, setWindows] = useState<{ legend: boolean; detailHelp: boolean; report: string | null; manual: string | null }>({ legend: false, detailHelp: false, report: null, manual: null });
    const drawings = useRef<Record<string, FlowDrawing>>({}),
      emptyDraft = useRef<FlowEditDraft>(blankDraft()).current,
      single = useRef<FlowCanvasHandle>(null),
      section = useRef<HTMLElement>(null),
      fileInput = useRef<HTMLInputElement>(null),
      dragDepth = useRef(0),
      pdfController = useRef<AbortController | null>(null);
    const windowPrefix = useRef(`paper-flow-popover-${++workbenchSerial}`).current;
    const legendTrigger = useRef<HTMLButtonElement>(null), reportTrigger = useRef<HTMLButtonElement>(null), manualTrigger = useRef<HTMLButtonElement>(null), detailHelpTrigger = useRef<HTMLButtonElement>(null);
    const importGuard = useRef(createImportGuard(w)).current;
    importGuard.observe(w);
    useEffect(() => {
      importGuard.activate();
      return () => { importGuard.dispose(); pdfController.current?.abort(); };
    }, [importGuard]);
    const left = resolveFlow(w, w.selection.left)!,
      right = w.selection.right ? resolveFlow(w, w.selection.right) : undefined;
    const selectionKey = JSON.stringify([w.selection.left, w.selection.right || null]);
    const previousSelection = useRef(selectionKey);
    const comparison = useMemo(() => right ? compareFlows(left, right, w.comparison) : null, [left, right, w.comparison]);
    useEffect(() => {
      if (previousSelection.current === selectionKey) return;
      previousSelection.current = selectionKey;
      setWindows((value) => ({ ...value, report: null, manual: null }));
      setManual({ kind: "node", a: "", b: "", reason: "" });
    }, [selectionKey]);
    const closeWindow = (name: "legend" | "detailHelp" | "report" | "manual") => {
      setWindows((value) => ({ ...value, [name]: name === "legend" || name === "detailHelp" ? false : null }));
      (name === "legend" ? legendTrigger : name === "detailHelp" ? detailHelpTrigger : name === "report" ? reportTrigger : manualTrigger).current?.focus();
    };
    function change(next: FlowWorkspace) {
      importGuard.invalidate();
      setDetail(null);
      setMessage("");
      drawings.current = {};
      onWorkspaceChange(next);
    }
    function load(input: unknown) {
      importGuard.invalidate();
      const parsed = parseFlowInput(input);
      setDiagnostics(parsed.diagnostics);
      if (parsed.ok) {
        change(parsed.value);
        setEditable(false);
      }
      return parsed;
    }
    async function importFiles(files: FileList | readonly File[] | null | undefined) {
      const ticket = importGuard.begin();
      try {
        const file = selectFlowImportFile(files);
        setDiagnostics([]);
        setFileState({ name: file.name || "JSON 文件", ticket });
        const text = await file.text();
        if (!importGuard.accepts(ticket)) return;
        const parsed = load(text);
        setFileState({ name: file.name || "JSON 文件" });
        if (parsed.ok) setMessage(`已导入 ${file.name || "JSON 文件"}`);
      } catch (error) {
        if (!importGuard.accepts(ticket)) return;
        setFileState({ name: "" });
        setDiagnostics([{ severity: "error", code: "file.import", path: "$", message: error instanceof Error ? error.message : "无法读取工作区文件" }]);
      }
    }
    const importing = !!fileState.ticket && importGuard.accepts(fileState.ticket);
    useImperativeHandle(ref, () => ({
      load,
      snapshot: () => structuredClone(w),
      exitFullscreen: () => setFullscreen(false),
      focus: (flowRef, ids) => {
        if (!resolveFlow(w, flowRef)) {
          setMessage("指定论文或流程不在当前工作区中。");
          return;
        }
        const leftMatch = flowKey(flowRef) === flowKey(w.selection.left),
          rightMatch = w.selection.right && flowKey(flowRef) === flowKey(w.selection.right);
        if (!leftMatch && !rightMatch)
          change({
            ...w,
            selection: { left: flowRef },
            comparison: defaultComparison(),
            view: { ...w.view, detail: "full" },
          });
        else if (w.view.detail !== "full") change({ ...w, view: { ...w.view, detail: "full" } });
        const graph = resolveFlow(w, flowRef),
          node = graph?.nodes.find((n) => ids.includes(n.id));
        if (node && graph) {
          const contexts = [{ ref: flowRef, nodeIds: ids.filter(id => graph.nodes.some(n => n.id === id)), side: rightMatch ? 'b' : 'a' }];
          setDetail({ node, graph, contexts }); onNodeSelect?.(contexts);
        }
        requestAnimationFrame(() => {
          const hosts = section.current?.querySelectorAll(".paper-flow-canvas");
          const host = hosts?.[rightMatch && w.view.mode === "parallel" ? 1 : 0];
          for (const el of host?.shadowRoot?.querySelectorAll<SVGGElement>(".node") || []) {
            const hit =
              ids.includes(el.dataset.nodeId || "") ||
              JSON.parse(el.dataset.nodeMembers || "[]").some((id: string) => ids.includes(id));
            el.classList.toggle("stage-target", hit);
            if (hit) el.scrollIntoView({ block: "center", inline: "center" });
          }
        });
      },
    }));
    function select(side: "left" | "right", value: string) {
      const selection = { ...w.selection };
      if (!value) delete selection.right;
      else selection[side] = JSON.parse(value);
      change({ ...w, selection, comparison: defaultComparison() });
      setManual({ kind: "node", a: "", b: "", reason: "" });
    }
    function draft(lane: "a" | "b" | "merged", value: FlowEditDraft) {
      importGuard.invalidate();
      const key =
        lane === "merged"
          ? mergedKey(w)
          : draftKey(lane === "a" ? w.selection.left : w.selection.right!, w.view);
      onWorkspaceChange({ ...w, drafts: { ...w.drafts, [key]: value } });
    }
    function nodeDetails(lane: "a" | "b" | "merged", id: string) {
      const graph = lane === "merged" ? comparison?.merged : lane === "b" ? right : left;
      const node =
        graph?.nodes.find((n) => n.id === id) ||
        drawings.current[lane]?.layout.nodes.find((n: any) => n.id === id || n.node.id === id)
          ?.node;
      const contexts = selectionContexts(w, lane, id, node, comparison?.merged);
      onNodeSelect?.(contexts);
      if (node && graph && !(right && windows.manual === selectionKey)) setDetail({ node, graph, contexts });
      if (lane !== "merged") setManual((m) => ({ ...m, [lane]: id }));
    }
    function svg() {
      const lanes = right ? (w.view.mode === "parallel" ? ["a", "b"] : ["merged"]) : ["a"];
      const images = lanes.map((lane) => drawings.current[lane]);
      if (images.some((d) => !d)) throw Error("画布尚未生成，请检查流程或稍后重试");
      return images.length === 1 ? images[0].svg : combineSvg(images);
    }
    async function pdf() {
      if (!services?.exportPdf) return;
      pdfController.current?.abort();
      pdfController.current = new AbortController();
      setPdfBusy(true);
      try {
        const blob = await services.exportPdf(svg(), pdfController.current.signal);
        if (!blob.type.startsWith("application/pdf")) throw Error("PDF服务未返回PDF文件");
        downloadFile("paper-flow.pdf", blob, "application/pdf");
        setMessage("PDF 已生成并下载");
      } catch (error) {
        setMessage(String(error));
      } finally {
        setPdfBusy(false);
      }
    }
    function addCorrespondence() {
      if (!manual.a || !manual.b || !manual.reason.trim()) {
        setMessage("请选择两侧步骤或分组，并填写对应理由。");
        return;
      }
      const comparison = {
        ...w.comparison,
        correspondences: [
          ...w.comparison.correspondences,
          { ...manual, id: `manual-${Date.now()}-${w.comparison.correspondences.length}` },
        ],
      };
      const parsed = parseFlowInput({ ...w, comparison });
      setDiagnostics(parsed.diagnostics);
      if (parsed.ok) {
        change(parsed.value);
        setManual((m) => ({ ...m, reason: "" }));
      }
    }
    const targets = (g: FlowGraph | undefined) =>
      manual.kind === "group" ? g?.paper_groups || [] : g?.nodes || [];
    const options = w.documents.flatMap((d) =>
      d.flows.map((g) => (
        <option
          key={flowKey({ documentId: d.paper.id, flowId: g.id })}
          value={valueOf({ documentId: d.paper.id, flowId: g.id })}
        >
          {d.paper.title} · {g.name}
        </option>
      )),
    );
    return (
      <section
        ref={section}
        className={`paper-flow-workbench${fullscreen ? " is-fullscreen" : ""}`}
        aria-label="通用论文流程工作台"
        onDragEnter={(event) => { event.preventDefault(); if (isFlowFileDrag(event.dataTransfer)) { dragDepth.current++; setDropActive(true); } }}
        onDragOver={(event) => { event.preventDefault(); if (isFlowFileDrag(event.dataTransfer)) { event.dataTransfer.dropEffect = "copy"; setDropActive(true); } }}
        onDragLeave={(event) => { event.preventDefault(); if (--dragDepth.current <= 0) { dragDepth.current = 0; setDropActive(false); } }}
        onDrop={(event) => { event.preventDefault(); event.stopPropagation(); dragDepth.current = 0; setDropActive(false); void importFiles(event.dataTransfer.files); }}
      >
        {dropActive && <div className="paper-flow-drop-target" role="status"><strong>松开以导入 JSON</strong><span>一次一个文件，最大 192 KiB</span></div>}
        <div className="paper-flow-toolbar">
          <label>
            论文／流程 A
            <select
              aria-label="论文与流程 A"
              value={valueOf(w.selection.left)}
              onChange={(e) => select("left", e.target.value)}
            >
              {options}
            </select>
          </label>
          <label>
            比较对象 B
            <select
              aria-label="论文与流程 B"
              value={w.selection.right ? valueOf(w.selection.right) : ""}
              onChange={(e) => select("right", e.target.value)}
            >
              <option value="">独立展示 · 不比较</option>
              {options}
            </select>
          </label>
          <div className="paper-flow-file">
            <button type="button" onClick={() => fileInput.current?.click()} title="选择一个 JSON 文件，或将文件拖到流程面板">导入 JSON</button>
            <input
              ref={fileInput}
              className="paper-flow-file-input"
              type="file"
              accept="application/json,.json"
              aria-label="导入论文或工作区 JSON"
              onChange={async (e) => {
                const files = Array.from(e.target.files || []);
                e.target.value = "";
                if (files.length) await importFiles(files);
              }}
            />
            <span className="paper-flow-file-name" role="status" title={fileState.name}>{importing ? `正在读取 ${fileState.name}…` : fileState.name || "或拖入面板"}</span>
          </div>
          <button
            type="button"
            className="paper-flow-save-workspace"
            title="下载当前工作区 JSON 备份；画板中的编辑另由宿主自动保存"
            onClick={() => {
              try {
                downloadFile(
                  "paper-flow-workspace.json",
                  serializeWorkspace(w),
                  "application/json",
                );
              } catch (e) {
                setMessage(String(e));
              }
            }}
          >
            保存工作区
          </button>
          {toolbar}
        </div>
        <div className="paper-flow-toolbar">
          <label>
            布局
            <select
              value={w.view.arrangement}
              onChange={(e) =>
                change({
                  ...w,
                  view: { ...w.view, arrangement: e.target.value as typeof w.view.arrangement },
                })
              }
            >
              <option value="trunks">自由树状 ↓</option>
              <option value="compact">原阶段混排 ↓</option>
              <option value="vertical">纵向展开</option>
            </select>
          </label>
          <label>
            层级
            <select
              value={w.view.treeLevels}
              onChange={(e) =>
                change({
                  ...w,
                  view: { ...w.view, treeLevels: e.target.value as typeof w.view.treeLevels },
                })
              }
            >
              <option value="expanded">展开模式</option>
              <option value="compact">紧凑模式</option>
            </select>
          </label>
          {right && (
            <>
              <label>
                比较
                <select
                  value={w.comparison.mode}
                  onChange={(e) =>
                    change({
                      ...w,
                      comparison: { ...w.comparison, mode: e.target.value as "strict" | "logical" },
                    })
                  }
                >
                  <option value="logical">逻辑匹配</option>
                  <option value="strict">严格匹配</option>
                </select>
              </label>
              <label>
                视图
                <select
                  value={w.view.mode}
                  onChange={(e) =>
                    change({
                      ...w,
                      view: { ...w.view, mode: e.target.value as "parallel" | "merged" },
                    })
                  }
                >
                  <option value="parallel">并排原图</option>
                  <option value="merged">合并差异图</option>
                </select>
              </label>
            </>
          )}
          <div className="paper-flow-detail-control">
          <button
            type="button"
            role="switch"
            aria-checked={w.view.detail === "full"}
            aria-label="完整细节"
            className="paper-flow-switch"
            onClick={() =>
              change({
                ...w,
                view: { ...w.view, detail: w.view.detail === "full" ? "overview" : "full" },
              })
            }
          >
            <span className="paper-flow-switch-track" aria-hidden="true"><span /></span>
            完整细节
          </button>
          <button ref={detailHelpTrigger} type="button" className="paper-flow-help" aria-label="完整细节与论文概览有什么区别"
            aria-expanded={windows.detailHelp} aria-controls={`${windowPrefix}-detail-help`}
            onClick={() => windows.detailHelp ? closeWindow("detailHelp") : setWindows((value) => ({ ...value, detailHelp: true }))}>?</button>
          </div>
          <button
            onClick={() => change({ ...w, view: { ...w.view, grouping: !w.view.grouping } })}
            aria-pressed={w.view.grouping}
          >
            总分框 · {w.view.grouping ? "开" : "关"}
          </button>
          <button onClick={() => change({ ...w, view: { ...w.view, zoom: "fit" } })}>适宽</button>
          <button
            onClick={() =>
              change({
                ...w,
                view: {
                  ...w.view,
                  zoom: Math.max(0.05, (typeof w.view.zoom === "number" ? w.view.zoom : 0.5) / 1.2),
                },
              })
            }
          >
            −
          </button>
          <span>{w.view.zoom === "fit" ? "适宽" : Math.round(w.view.zoom * 100) + "%"}</span>
          <button
            onClick={() =>
              change({
                ...w,
                view: {
                  ...w.view,
                  zoom: Math.min(4, (typeof w.view.zoom === "number" ? w.view.zoom : 0.5) * 1.2),
                },
              })
            }
          >
            ＋
          </button>
          <button onClick={() => setEditable(!editable)} aria-pressed={editable}>
            临时编辑 · {editable ? "开" : "关"}
          </button>
          <button
            onClick={() => change({ ...w, view: { ...w.view, hoverMotion: !w.view.hoverMotion } })}
            aria-pressed={w.view.hoverMotion}
          >
            方向动画 · {w.view.hoverMotion ? "开" : "关"}
          </button>
          <button ref={legendTrigger} type="button" className="paper-flow-popover-trigger"
            aria-expanded={windows.legend} aria-controls={`${windowPrefix}-legend`}
            onClick={() => windows.legend ? closeWindow("legend") : setWindows((value) => ({ ...value, legend: true }))}>图例</button>
          {right && <button ref={reportTrigger} type="button" className="paper-flow-popover-trigger"
            aria-expanded={windows.report === selectionKey} aria-controls={`${windowPrefix}-report`}
            onClick={() => windows.report === selectionKey ? closeWindow("report") : setWindows((value) => ({ ...value, report: selectionKey }))}>比较报告</button>}
          {right && <button ref={manualTrigger} type="button" className="paper-flow-popover-trigger"
            aria-expanded={windows.manual === selectionKey} aria-controls={`${windowPrefix}-manual`}
            onClick={() => { if (windows.manual === selectionKey) closeWindow("manual"); else { setDetail(null); setWindows((value) => ({ ...value, manual: selectionKey })); } }}>人工对应与排除</button>}
          <button onClick={() => setFullscreen(!fullscreen)}>
            {fullscreen ? "退出全屏" : "全屏"}
          </button>
          <button
            onClick={() => {
              try {
                downloadFile("paper-flow.svg", svg(), "image/svg+xml");
              } catch (e) {
                setMessage(String(e));
              }
            }}
          >
            SVG ↓
          </button>
          {services?.exportPdf && (
            <button disabled={pdfBusy} onClick={pdf}>
              {pdfBusy ? "PDF 生成中…" : "PDF ↓"}
            </button>
          )}
        </div>
        {message && <p role="status">{message}</p>}
        {diagnostics.length > 0 && (
          <div className="error-box" role="alert">
            <b>未载入：请修正以下数据</b>
            <ul>
              {diagnostics.map((d, i) => (
                <li key={i}>
                  {d.path}：{d.message}
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className="paper-flow-summaries">
          {[left, right]
            .filter((g): g is FlowGraph => !!g)
            .map((g, i) => (
              <div key={i}>
                <strong>
                  {i === 0 ? "A" : "B"} · {g.name}
                </strong>
                {typeof g.subtitle === "string" && <p>{g.subtitle}</p>}
                {!!(g.metric_text || g.reported_results) && (
                  <pre>
                    {typeof (g.metric_text || g.reported_results) === "string"
                      ? String(g.metric_text || g.reported_results)
                      : JSON.stringify(g.reported_results, null, 2)}
                  </pre>
                )}
              </div>
            ))}
        </div>
        {right ? (
          <FlowCompare
            a={left}
            b={right}
            spec={w.comparison}
            comparison={comparison || undefined}
            options={w.view}
            identityA={flowKey(w.selection.left)}
            identityB={flowKey(w.selection.right!)}
            draftA={w.drafts[draftKey(w.selection.left, w.view)] || emptyDraft}
            draftB={w.drafts[draftKey(w.selection.right!, w.view)] || emptyDraft}
            mergedDraft={w.drafts[mergedKey(w)] || emptyDraft}
            editable={editable}
            onEditingChange={setEditable}
            onDraftChange={draft}
            onNodeSelect={nodeDetails}
            onDrawing={(lane, d) => {
              drawings.current[lane] = d;
            }}
            onZoomChange={(zoom) => change({ ...w, view: { ...w.view, zoom } })}
          />
        ) : (
          <div className="paper-flow-single">
            <section aria-label={left.name}>
            <h3>{left.name}</h3>
            <FlowCanvas
              ref={single}
              identity={flowKey(w.selection.left)}
              graph={left}
              options={w.view}
              draft={w.drafts[draftKey(w.selection.left, w.view)] || emptyDraft}
              editable={editable}
              onEditingChange={setEditable}
              onDraftChange={(d) => draft("a", d)}
              onNodeSelect={(id) => nodeDetails("a", id)}
              onDrawing={(d) => {
                drawings.current.a = d;
              }}
              onZoomChange={(zoom) => change({ ...w, view: { ...w.view, zoom } })}
            />
            </section>
          </div>
        )}
        <FlowWindow id={`${windowPrefix}-legend`} kind="legend" title="图例" open={windows.legend} onClose={() => closeWindow("legend")}>
          <FlowLegend />
        </FlowWindow>
        <FlowWindow id={`${windowPrefix}-detail-help`} kind="detail-help" title="完整细节与论文概览" open={windows.detailHelp} onClose={() => closeWindow("detailHelp")}>
          <p><strong>完整细节：开启</strong>，逐个显示输入中声明的流程节点和关系，适合查看具体操作、产物与上下游。</p>
          <p><strong>完整细节：关闭</strong>，显示论文概览：仅将输入中显式声明的 <code>paper_groups</code> 分组合并为概览节点；未分组的步骤继续显示。未声明分组时，两种视图可能相同。</p>
          <p>这个开关只改变画布展示，不删除源数据，也不改变严格／逻辑比较使用的原始声明。两种视图分别保留自己的临时布局草稿。</p>
        </FlowWindow>
        {right && comparison && <FlowWindow id={`${windowPrefix}-report`} kind="report" title="比较报告" open={windows.report === selectionKey} onClose={() => closeWindow("report")}>
          <FlowComparisonReport report={comparison.report} />
        </FlowWindow>}
        {right && (
          <FlowWindow id={`${windowPrefix}-manual`} kind="manual" title="人工对应与排除" open={windows.manual === selectionKey} onClose={() => closeWindow("manual")}>
            <p>
              可点击两侧节点选取。规格不同的步骤保留各自内容；多步骤对应请先在 JSON 中声明分组。
            </p>
            <div className="paper-flow-toolbar">
              <label>
                对应对象
                <select
                  value={manual.kind}
                  onChange={(e) =>
                    setManual({
                      kind: e.target.value as "node" | "group",
                      a: "",
                      b: "",
                      reason: "",
                    })
                  }
                >
                  <option value="node">节点</option>
                  <option value="group">显式分组</option>
                </select>
              </label>
              {(
                [
                  ["a", left],
                  ["b", right],
                ] as const
              ).map(([lane, g]) => (
                <label key={lane}>
                  {lane.toUpperCase()}
                  <select
                    value={manual[lane]}
                    onChange={(e) => setManual({ ...manual, [lane]: e.target.value })}
                  >
                    <option value="">选择步骤</option>
                    {targets(g).map((n) => (
                      <option key={n.id} value={n.id}>
                        {n.label}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
              <label>
                对应理由
                <input
                  value={manual.reason}
                  onChange={(e) => setManual({ ...manual, reason: e.target.value })}
                />
              </label>
              <button onClick={addCorrespondence}>添加对应</button>
              {manual.kind === "node" && (
                <button
                  onClick={() => {
                    if (manual.a && manual.b)
                      change({
                        ...w,
                        comparison: {
                          ...w.comparison,
                          exclusions: [...w.comparison.exclusions, { a: manual.a, b: manual.b }],
                        },
                      });
                  }}
                >
                  排除此自动匹配
                </button>
              )}
            </div>
            <ul>
              {w.comparison.correspondences.map((p) => (
                <li key={p.id}>
                  {p.a} ↔ {p.b} · {p.reason}{" "}
                  <button
                    onClick={() =>
                      change({
                        ...w,
                        comparison: {
                          ...w.comparison,
                          correspondences: w.comparison.correspondences.filter(
                            (x) => x.id !== p.id,
                          ),
                        },
                      })
                    }
                  >
                    移除对应
                  </button>
                </li>
              ))}
              {w.comparison.exclusions.map((p, i) => (
                <li key={i}>
                  排除：{p.a} ↔ {p.b}{" "}
                  <button
                    onClick={() =>
                      change({
                        ...w,
                        comparison: {
                          ...w.comparison,
                          exclusions: w.comparison.exclusions.filter((_, j) => i !== j),
                        },
                      })
                    }
                  >
                    恢复自动判断
                  </button>
                </li>
              ))}
            </ul>
          </FlowWindow>
        )}
        {detail && (
          <aside className="paper-flow-details" aria-label="节点详情">
            <button onClick={() => setDetail(null)}>关闭详情 ×</button>
            <h3>{detail.node.label}</h3>
            <p>{detail.node.detail}</p>
            {renderNodeDetails?.(detail.node, detail.graph, detail.contexts || [])}
            <dl>
              <dt>来源</dt>
              <dd>{detail.node.evidence || "未提供来源说明"}</dd>
              <dt>操作、规格与端口</dt>
              <dd>
                <pre>{JSON.stringify(detail.node, null, 2)}</pre>
              </dd>
            </dl>
            <button
              onClick={() =>
                downloadFile(
                  "artifact-description.json",
                  JSON.stringify({ kind: "artifact-description", node: detail.node }, null, 2),
                  "application/json",
                )
              }
            >
              保存节点／产物说明
            </button>
          </aside>
        )}
      </section>
    );
  },
);
