import { useEffect, useId, useRef, useState } from "react";
import type { FlowGraph } from "./types";

export function FlowTitles({ left, right }: { left: FlowGraph; right?: FlowGraph }) {
  const [open, setOpen] = useState<"A" | "B" | null>(null);
  const group = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const prefix = useId();

  useEffect(() => {
    if (!open || !group.current) return;
    const doc = group.current.ownerDocument;
    function dismissOutside(event: Event) {
      if (!group.current?.contains(event.target as Node)) setOpen(null);
    }
    function onEscape(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(null);
      trigger.current?.focus();
    }
    doc.addEventListener("pointerdown", dismissOutside, true);
    doc.addEventListener("focusin", dismissOutside);
    doc.addEventListener("keydown", onEscape, true);
    return () => {
      doc.removeEventListener("pointerdown", dismissOutside, true);
      doc.removeEventListener("focusin", dismissOutside);
      doc.removeEventListener("keydown", onEscape, true);
    };
  }, [open]);

  return <div className="paper-flow-titles" ref={group} role="group" aria-label="当前流程">
    {([["A", left], ["B", right]] as const).map(([side, graph]) => {
      if (!graph) return null;
      const subtitle = typeof graph.subtitle === "string" ? graph.subtitle.trim() : "";
      const results = graph.metric_text || graph.reported_results;
      const report = typeof results === "string" ? results.trim()
        : results == null || (typeof results === "object" && !Object.keys(results).length)
          ? "" : JSON.stringify(results, null, 2);
      const name = side + " · " + graph.name;
      const id = prefix + "-" + side;
      return <div className="paper-flow-title" key={side}>
        <span className="paper-flow-title-name" title={name}>{name}</span>
        {(subtitle || report) && <>
          <button type="button" className="paper-flow-info-button" aria-label={`查看 ${side} 流程说明`}
            title={`查看 ${side} 流程说明`} aria-controls={id} aria-expanded={open === side}
            onClick={event => { trigger.current = event.currentTarget; setOpen(open === side ? null : side); }}>i</button>
          <div id={id} className="paper-flow-info" role="region" aria-label={name + "的说明"} hidden={open !== side} tabIndex={0}>
            {subtitle && <p>{subtitle}</p>}
            {report && <pre>{report}</pre>}
          </div>
        </>}
      </div>;
    })}
  </div>;
}
