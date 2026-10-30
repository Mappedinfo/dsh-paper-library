import { useEffect, useRef } from "react";
import type { ReactNode } from "react";

type FloatingAPI = { refresh?: () => void; dispose?: () => void };
type FloatingHost = Window & { PaperFloatingWindows?: { attach(element: HTMLElement): FloatingAPI | null } };

/** A non-modal window stays inside the workbench so host theme/fullscreen apply. */
export function FlowWindow({ open, id, title, kind, onClose, children }: {
  open: boolean; id: string; title: string; kind: string; onClose: () => void; children: ReactNode;
}) {
  const panel = useRef<HTMLElement>(null);
  const titleId = `${id}-title`;
  useEffect(() => {
    if (!open || !panel.current) return;
    const controller = (window as FloatingHost).PaperFloatingWindows?.attach(panel.current);
    controller?.refresh?.();
    panel.current.focus();
    return () => controller?.dispose?.();
  }, [open]);
  if (!open) return null;
  return <section ref={panel} id={id} role="dialog" aria-modal="false" aria-labelledby={titleId} data-floating-min-layer="1502"
    tabIndex={-1} className={`paper-flow-popover paper-flow-popover-${kind}`}
    onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); } }}>
    <header className="paper-flow-popover-header"><strong id={titleId}>{title}</strong>
      <button type="button" onClick={onClose} aria-label={`关闭${title}`}>×</button>
    </header>
    <div className="paper-flow-popover-body">{children}</div>
  </section>;
}
