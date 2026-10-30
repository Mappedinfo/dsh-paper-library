import engine from "./core/graph.js";
import { createDiagramEditor } from "./core/editorControls.js";
import { wireGraphHover } from "./core/hover.js";
import { namespaceSvg, prepareGraph } from "./comparison.js";
import { defaultView, blankDraft } from "./document.js";
export function downloadFile(name, data, type) {
  const blob = data instanceof Blob ? data : new Blob([data], { type }),
    url = URL.createObjectURL(blob),
    a = globalThis.document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
export function mountFlowCanvas(root, initial) {
  let props = initial,
    model,
    drawing,
    hover,
    events,
    disposed = false,
    scale = 1,
    drag,
    suppressClick = 0;
  root.innerHTML =
    '<div id="canvas" class="canvas"><div class="graph-wrap" data-lane="a" tabindex="0" role="region"><div class="graph-content"></div></div><p class="canvas-error" role="alert" hidden></p></div>';
  const view = root.querySelector(".graph-wrap"),
    content = root.querySelector(".graph-content"),
    error = root.querySelector(".canvas-error");
  const editor = createDiagramEditor({
    root,
    graph: engine,
    redraw: () => {
      props = { ...props, draft: editor.draft(model) };
      render(true);
      props.onDraftChange?.(structuredClone(props.draft));
    },
    details: (id) => props.onNodeSelect?.(id),
    onEnabledChange: (enabled) => props.onEditingChange?.(enabled),
    download: downloadFile,
  });
  function size(anchor) {
    const svg = content.querySelector("svg");
    if (!svg || !drawing) return;
    scale =
      props.options?.zoom === "fit"
        ? Math.max(0.02, (view.clientWidth - 32) / drawing.width)
        : Number(props.options?.zoom) || 1;
    content.style.padding = `${view.clientHeight / 2}px ${view.clientWidth / 2}px`;
    svg.style.width = drawing.width * scale + "px";
    svg.style.height = drawing.height * scale + "px";
    if (anchor) {
      view.scrollLeft = anchor.x * scale;
      view.scrollTop = anchor.y * scale;
    }
  }
  function render(preserve = false) {
    const options = { ...defaultView(), ...props.options };
    const anchor =
      drawing && preserve ? { x: view.scrollLeft / scale, y: view.scrollTop / scale } : null;
    events?.abort();
    events = new AbortController();
    drag = null;
    try {
      model = prepareGraph(props.graph, options, props.draft || blankDraft());
      model = { ...model, presentation_editor_lane: props.identity };
      editor.hydrate(model, props.draft || blankDraft());
      model = editor.decorate(model);
      drawing = engine.svg(model, { title: false });
      content.innerHTML = namespaceSvg(drawing.svg, props.identity);
      view.setAttribute("aria-label", props.graph.name);
      view.classList.toggle("hover-motion-off", options.hoverMotion === false);
      view.classList.remove("is-panning");
      error.hidden = true;
      editor.clearModels();
      editor.record("a", model, drawing);
      editor.wire();
      editor.setEnabled(!!props.editable);
      hover = wireGraphHover(view, model, events.signal, (related, origin) =>
        props.onHover?.(related, origin),
      );
      size(anchor);
      if (!preserve) {
        view.scrollLeft = view.clientWidth / 2;
        view.scrollTop = view.clientHeight / 2;
      }
      view.addEventListener(
        "click",
        (event) => {
          if (Date.now() < suppressClick) return;
          const artifact = event.target.closest(".artifact-inspect");
          if (artifact) {
            event.preventDefault();
            props.onNodeSelect?.(artifact.dataset.artifactAction);
            return;
          }
          const node = event.target.closest(".node"),
            edge = event.target.closest(".edge-interactive,.edge-label");
          if (node) {
            if (!editor.selectNode(node.dataset.layoutNodeId, "a", event.shiftKey))
              props.onNodeSelect?.(node.dataset.nodeId || node.dataset.layoutNodeId);
          } else if (edge) editor.selectEdge(edge.dataset.layoutEdgeId, "a");
        },
        { signal: events.signal },
      );
      view.addEventListener(
        "keydown",
        (event) => {
          if (event.key === "Enter" || event.key === " ") {
            const artifact = event.target.closest(".artifact-inspect");
            if (artifact) {
              event.preventDefault();
              props.onNodeSelect?.(artifact.dataset.artifactAction);
              return;
            }
            const node = event.target.closest(".node");
            if (node) {
              event.preventDefault();
              if (!editor.selectNode(node.dataset.layoutNodeId, "a", event.shiftKey))
                props.onNodeSelect?.(node.dataset.nodeId || node.dataset.layoutNodeId);
            }
          }
        },
        { signal: events.signal },
      );
      view.addEventListener(
        "pointerdown",
        (event) => {
          if (
            event.button !== 0 ||
            (event.shiftKey && editor.enabled) ||
            (editor.enabled &&
              event.target.closest(".node,.editor-anchor,.edge-interactive,.edge-label"))
          )
            return;
          drag = {
            id: event.pointerId,
            x: event.clientX,
            y: event.clientY,
            left: view.scrollLeft,
            top: view.scrollTop,
            moved: false,
          };
          view.setPointerCapture(event.pointerId);
        },
        { signal: events.signal },
      );
      view.addEventListener(
        "pointermove",
        (event) => {
          if (!drag || drag.id !== event.pointerId) return;
          const dx = event.clientX - drag.x,
            dy = event.clientY - drag.y;
          if (Math.hypot(dx, dy) > 3) drag.moved = true;
          if (drag.moved) {
            view.classList.add("is-panning");
            view.scrollLeft = drag.left - dx;
            view.scrollTop = drag.top - dy;
          }
        },
        { signal: events.signal },
      );
      for (const type of ["pointerup", "pointercancel", "lostpointercapture"])
        view.addEventListener(
          type,
          () => {
            if (drag?.moved) suppressClick = Date.now() + 150;
            drag = null;
            view.classList.remove("is-panning");
          },
          { signal: events.signal },
        );
      view.addEventListener(
        "wheel",
        (event) => {
          if (!(event.ctrlKey || event.metaKey)) return;
          event.preventDefault();
          const next = Math.max(0.05, Math.min(4, scale * (event.deltaY < 0 ? 1.1 : 1 / 1.1)));
          props.onZoomChange?.(next);
        },
        { passive: false, signal: events.signal },
      );
      props.onDrawing?.(drawing);
    } catch (reason) {
      error.hidden = false;
      error.textContent = reason.message;
      props.onError?.(reason.message);
    }
  }
  const resize = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => size()) : null;
  resize?.observe(view);
  render();
  return {
    update(next) {
      if (disposed) return;
      props = next;
      render(true);
    },
    drawing: () => drawing,
    highlight(related) {
      hover?.peer(related);
    },
    focus(ids) {
      for (const node of view.querySelectorAll(".node")) {
        const hit =
          ids.includes(node.dataset.nodeId) ||
          JSON.parse(node.dataset.nodeMembers || "[]").some((id) => ids.includes(id));
        node.classList.toggle("stage-target", hit);
        if (hit) node.scrollIntoView({ block: "center", inline: "center", behavior: "auto" });
      }
    },
    dispose() {
      disposed = true;
      events?.abort();
      editor.dispose();
      resize?.disconnect();
      root.replaceChildren();
    },
  };
}
