import {
  createDraftHistory,
  emptyDraft,
  hasDraft,
  describeAnchor,
  connectionPoint,
  projectAnchor,
  anchorPoint,
  mergeEdit,
  previewEdit,
  connectionPath,
  bendPatch,
  segmentPatch,
  alignmentPatch,
  nodesInRect,
  reflowDraft,
} from "./editing.js";
import routing from "./routing.js";

const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
const faceNames = { top: "上", right: "右", bottom: "下", left: "左" };
// Session-local editing of the existing SVG. No source DSL or matching mutation.
export function createDiagramEditor({
  root,
  graph: G,
  redraw,
  details,
  download,
  onEnabledChange,
}) {
  const histories = new Map(),
    models = new Map();
  let enabled = false,
    selection = null,
    activeLane = "",
    controller,
    message = "",
    serial = 0,
    ignoreClickUntil = 0,
    cancelDrag,
    boxSelect = false;
  const key = (g) =>
    G.canonical([
      g.id,
      g.presentation_editor_lane,
      g.presentation_layout,
      g.tree_levels,
      g.stage_heights,
      g.swimlanes,
      !!g.collapsed,
      !!g.detail_grouping,
      g.trunk_detail,
      g.nodes.map((n) => [n.id, G.signature(n), n.label, n.role, n.visual_kind, n.trunk_control]),
      g.edges.map((e) => [e.id, e.from, e.to, e.kind, e.semantic]),
    ]);
  const history = (g) => {
    const k = key(g);
    if (!histories.has(k)) histories.set(k, createDraftHistory());
    return histories.get(k);
  };
  const decorate = (g, lane = g.presentation_editor_lane || "") => {
    const view = { ...g, presentation_editor_lane: lane };
    return { ...view, presentation_edits: history(view).value };
  };
  const active = () => models.get(activeLane) || models.values().next().value;
  function change(mutator) {
    const model = active();
    if (!model) return;
    const h = history(model.graph),
      next = h.value;
    try {
      mutator(next);
      G.svg({ ...model.graph, presentation_edits: next });
      h.commit(next);
      message = "";
      redraw();
    } catch (error) {
      message = error.message;
      panel();
    }
  }
  const selectedNode = () => active()?.drawing.layout.nodes.find((n) => n.id === selection?.id);
  const selectedNodes = () =>
    selection?.kind === "node"
      ? (active()?.drawing.layout.nodes || []).filter((n) =>
          (selection.ids || [selection.id]).includes(n.id),
        )
      : [];
  function selectedEdge() {
    const edges = active()?.drawing.layout.edges || [];
    return (
      edges.find((e) => e.id === selection?.id) ||
      edges.find((e) => selection?.id?.startsWith(e.id + "__"))
    );
  }
  function select(kind, id, lane, additive = false, pointer = false) {
    if (!enabled) return false;
    if (!pointer && Date.now() < ignoreClickUntil) return true;
    const previous =
      activeLane === lane && selection?.kind === "node" ? selection.ids || [selection.id] : [];
    activeLane = lane;
    const ids =
      kind === "node"
        ? additive
          ? previous.includes(id)
            ? previous.filter((n) => n !== id)
            : [...previous, id]
          : previous.includes(id)
            ? previous
            : [id]
        : [];
    selection =
      kind === "node"
        ? ids.length
          ? { kind, id: ids.includes(id) ? id : ids[0], ids }
          : null
        : { kind, id };
    message = "";
    panel();
    return true;
  }
  function markSelection() {
    for (const el of root.querySelectorAll("[data-layout-node-id],[data-layout-edge-id]"))
      el.classList.toggle(
        "editor-selected",
        enabled &&
          el.closest(".graph-wrap")?.dataset.lane === activeLane &&
          (selection?.kind === "node"
            ? (selection.ids || [selection.id]).includes(el.dataset.layoutNodeId)
            : !!selection && el.dataset.layoutEdgeId === selection.id),
      );
  }
  function handles(layout = active()?.drawing.layout) {
    root.querySelectorAll(".editor-handles").forEach((el) => el.remove());
    if (!enabled || selection?.kind !== "edge" || !layout) return;
    const edge = layout.edges.find((e) => e.id === selectedEdge()?.id),
      view = [...root.querySelectorAll(".graph-wrap")].find((v) => v.dataset.lane === activeLane),
      svg = view?.querySelector("svg");
    if (!edge || !svg) return;
    const top = Number(svg.dataset.layoutTop || 0),
      ctm = svg.getScreenCTM(),
      scale = Math.max(0.05, Math.hypot(ctm?.a || 1, ctm?.b || 0)),
      layer = root.ownerDocument.createElementNS("http://www.w3.org/2000/svg", "g");
    layer.setAttribute("class", "editor-handles");
    // These controls exist only in the live DOM, never in G.svg/export output.
    layer.innerHTML = ["start", "end"]
      .map((end) => {
        const point = connectionPoint(edge, end),
          title = end === "start" ? "起点" : "终点",
          fixed = !!history(active().graph).value.edges[edge.id]?.[end]?.fixed;
        return `<g class="editor-anchor ${end}" data-editor-anchor="${end}" data-editor-edge="${esc(edge.id)}" tabindex="0" role="button" aria-label="拖动${title}连接点到节点边界；方向键微调"><title>拖动${title}连接点到节点任一边界；松开后固定</title><circle class="anchor-hit" cx="${point.x}" cy="${point.y + top}" r="${15 / scale}"/><circle class="anchor-grip" cx="${point.x}" cy="${point.y + top}" r="${6 / scale}"/><text x="${point.x + 10 / scale}" y="${point.y + top - 10 / scale}" font-size="${12 / scale}">${title}${fixed ? " · 固定" : ""}</text></g>`;
      })
      .join("");
    const path = connectionPath(edge);
    const grip = (point, attr, title, square) =>
      `<g class="editor-anchor editor-bend" data-editor-${attr} data-editor-edge="${esc(edge.id)}" tabindex="0" role="button" aria-label="${title}"><title>${title}</title><circle class="anchor-hit" cx="${point.x}" cy="${point.y + top}" r="${13 / scale}"/>${square ? `<rect class="anchor-grip" x="${point.x - 4 / scale}" y="${point.y + top - 4 / scale}" width="${8 / scale}" height="${8 / scale}"/>` : `<circle class="anchor-grip" cx="${point.x}" cy="${point.y + top}" r="${4 / scale}"/>`}</g>`;
    path.slice(1, -1).forEach((p, i) => {
      layer.innerHTML += grip(p, `bend="${i + 1}"`, "拖动转折点；方向键微调", true);
    });
    path.slice(0, -1).forEach((p, i) => {
      const q = path[i + 1];
      if (Math.hypot(p.x - q.x, p.y - q.y) * scale > 45)
        layer.innerHTML += grip(
          { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 },
          `segment="${i}"`,
          "拖动线段中点移动通道或增加转折",
          false,
        );
    });
    svg.append(layer);
  }
  function panel() {
    root.querySelector(".diagram-editor")?.remove();
    const button = root.querySelector("#edit-diagram");
    if (button) {
      button.classList.toggle("active", enabled);
      button.setAttribute("aria-pressed", String(enabled));
    }
    root.querySelector("#canvas")?.classList.toggle("editing-diagram", enabled);
    markSelection();
    const model = active();
    handles();
    if (!enabled || !model) return;
    const h = history(model.graph),
      draft = h.value,
      chosen = selectedNodes(),
      node = chosen.length === 1 && selectedNode(),
      edge = selection?.kind === "edge" && selectedEdge();
    const options = (chosen) =>
      model.drawing.layout.nodes
        .map(
          (n) =>
            `<option value="${esc(n.id)}" ${n.id === chosen ? "selected" : ""}>${esc(n.node.label.replaceAll("\n", " · "))}</option>`,
        )
        .join("");
    const endpoint = (end, title) => {
      const n = end === "start" ? edge.from : edge.to,
        point = connectionPoint(edge, end),
        value = describeAnchor(n, point, edge.sides[end]),
        fixed = !!draft.edges[edge.id]?.[end]?.fixed;
      return `<fieldset><legend>${title}连接点</legend><label>边界<select id="edit-${end}-side">${Object.entries(
        faceNames,
      )
        .map(([v, t]) => `<option value="${v}" ${v === value.side ? "selected" : ""}>${t}</option>`)
        .join(
          "",
        )}</select></label><label>位置 %<input id="edit-${end}-offset" type="number" min="0" max="100" step="1" value="${Math.round(value.offset * 100)}"></label><label class="edit-check"><input id="edit-${end}-fixed" type="checkbox" ${fixed ? "checked" : ""}>固定连接点</label></fieldset>`;
    };
    const el = root.ownerDocument.createElement("aside");
    el.className = "diagram-editor";
    el.innerHTML = `<details open><summary>临时编辑${activeLane ? " · " + esc(String(activeLane).toUpperCase()) : ""}</summary><div class="editor-body"><p>Shift点击多选；Shift拖动空白处框选，或开启框选工具。选中后可整体拖动与对齐。连线端点、方形转折点和圆形线段中点均可拖动，松开固定；Esc取消。刷新恢复原图。</p><div class="editor-actions"><button data-edit="undo" ${h.canUndo ? "" : "disabled"}>撤销</button><button data-edit="redo" ${h.canRedo ? "" : "disabled"}>重做</button><button data-edit="box" aria-pressed="${boxSelect}">框选${boxSelect ? " · 开" : ""}</button><button data-edit="clear">清空选择</button><button data-edit="auto">重排未固定</button><button data-edit="reset" ${hasDraft(draft) ? "" : "disabled"}>恢复原图</button></div>
    ${
      chosen.length > 1
        ? `<h4>已选 ${chosen.length} 个节点</h4><div class="editor-actions">${[
            ["left", "左对齐"],
            ["center", "水平居中"],
            ["right", "右对齐"],
            ["top", "顶对齐"],
            ["middle", "垂直居中"],
            ["bottom", "底对齐"],
          ]
            .map(([mode, label]) => `<button data-edit="align-${mode}">${label}</button>`)
            .join("")}</div>`
        : ""
    }
    ${node ? `<h4>${esc(node.node.label.replaceAll("\n", " · "))}</h4><div class="editor-position"><label>X<input id="edit-x" type="number" value="${Math.round(node.x)}"></label><label>Y<input id="edit-y" type="number" value="${Math.round(node.y)}"></label><button data-edit="position">移动</button></div><label class="edit-check"><input id="edit-pin" type="checkbox" ${draft.nodes[node.id]?.fixed ? "checked" : ""}>固定节点位置（重排时保留）</label>${node.compound?.kind === "detail_group" ? "<p>当前移动所属总框；关闭设置中的总分框后可分别移动子节点。</p>" : ""}<button data-edit="details">原节点详情</button>` : ""}
    ${
      edge
        ? `<h4>${esc(edge.edge.label || edge.edge.semantic || edge.id)}</h4><label>线型<select id="edit-line">${[
            ["auto", "原线型"],
            ["solid", "实线"],
            ["dashed", "虚线"],
            ["dotted", "点线"],
          ]
            .map(
              ([v, t]) =>
                `<option value="${v}" ${(draft.edges[edge.id]?.line || "auto") === v ? "selected" : ""}>${t}</option>`,
            )
            .join(
              "",
            )}</select></label>${endpoint("start", "起点")}${endpoint("end", "终点")}<p>方形点拖动转折，线段中点拖出新转折。中间转折固定在画布；修改边界或位置会固定连接点。</p><button data-edit="auto-bends">恢复自动转折</button><button data-edit="edge-reset">${edge.draft_relation ? "删除临时关系" : "恢复该连线"}</button>`
        : ""
    }
    <details class="editor-new"><summary>＋ 新建临时关系</summary><label>起点<select id="edit-from">${options(node?.id)}</select></label><label>终点<select id="edit-to">${options(model.drawing.layout.nodes.find((n) => n.id !== (node?.id || model.drawing.layout.nodes[0]?.id))?.id)}</select></label><label>名称<input id="edit-label" maxlength="160" value="自定义关系"></label><button data-edit="create">添加关系</button><p>临时关系仅作展示，不参与原实验匹配或训练。</p></details><div class="editor-actions"><button data-edit="save">下载编辑草稿</button><button data-edit="close">结束编辑</button></div><p class="editor-status" role="status">${esc(message)}</p></div></details>`;
    root.querySelector("#canvas").append(el);
    const find = (id) => el.querySelector(id);
    el.querySelectorAll("[data-edit]").forEach(
      (b) =>
        (b.onclick = () => {
          const action = b.dataset.edit;
          if (action === "box") {
            boxSelect = !boxSelect;
            panel();
            return;
          }
          if (action === "clear") {
            selection = null;
            panel();
            return;
          }
          if (action.startsWith("align-")) {
            change((d) => mergeEdit(d, alignmentPatch(chosen, action.slice(6))));
            return;
          }
          if (action === "auto-bends") {
            change((d) => {
              if (d.edges[edge.id]) delete d.edges[edge.id].route;
            });
            return;
          }
          if (action === "close") {
            cancelDrag?.();
            enabled = false;
            onEnabledChange?.(false);
            panel();
            return;
          }
          if (action === "undo" || action === "redo") {
            h[action]();
            message = "";
            redraw();
            return;
          }
          if (action === "details") {
            details(node.node.presentation_aliases?.[0] || node.id, activeLane);
            return;
          }
          if (action === "save") {
            download(
              "flow-edit-draft.json",
              JSON.stringify({ version: 1, graph_key: key(model.graph), draft }, null, 2),
              "application/json",
            );
            return;
          }
          if (action === "reset") {
            change((d) => Object.assign(d, emptyDraft()));
            return;
          }
          if (action === "auto") {
            change((d) => Object.assign(d, reflowDraft(d)));
            return;
          }
          if (action === "position") {
            change((d) => {
              d.nodes[node.id] = {
                x: Number(find("#edit-x").value),
                y: Number(find("#edit-y").value),
                fixed: !!d.nodes[node.id]?.fixed,
              };
            });
            return;
          }
          if (action === "edge-reset") {
            change((d) => {
              delete d.edges[edge.id];
              if (edge.draft_relation) d.relations = d.relations.filter((r) => r.id !== edge.id);
            });
            return;
          }
          if (action === "create") {
            const from = find("#edit-from").value,
              to = find("#edit-to").value,
              label = find("#edit-label").value;
            let id;
            do {
              id = "@draft_" + ++serial;
            } while (draft.relations.some((r) => r.id === id));
            change((d) => {
              d.relations.push({ id, from, to, label });
            });
            selection = { kind: "edge", id };
            panel();
          }
        }),
    );
    find("#edit-pin")?.addEventListener("change", (e) =>
      change((d) => {
        d.nodes[node.id] = { x: node.x, y: node.y, fixed: e.target.checked };
      }),
    );
    find("#edit-line")?.addEventListener("change", (e) =>
      change((d) => {
        d.edges[edge.id] = { ...d.edges[edge.id], line: e.target.value };
      }),
    );
    for (const end of ["start", "end"])
      for (const field of ["side", "offset", "fixed"])
        find(`#edit-${end}-${field}`)?.addEventListener("change", () => {
          const anchor = {
            side: find(`#edit-${end}-side`).value,
            offset: Number(find(`#edit-${end}-offset`).value) / 100,
            fixed: field === "fixed" ? find(`#edit-${end}-fixed`).checked : true,
          };
          change((d) => {
            d.edges[edge.id] = { ...d.edges[edge.id], [end]: anchor };
          });
        });
  }
  function wire() {
    cancelDrag?.();
    if (!models.has(activeLane)) activeLane = models.keys().next().value || "";
    controller?.abort();
    controller = new AbortController();
    const signal = controller.signal;
    for (const view of root.querySelectorAll(".graph-wrap")) {
      let drag, frame;
      const local = (e) => {
        const svg = view.querySelector("svg"),
          p = svg.createSVGPoint();
        p.x = e.clientX;
        p.y = e.clientY;
        const q = p.matrixTransform(svg.getScreenCTM().inverse());
        return { x: q.x, y: q.y - Number(svg.dataset.layoutTop || 0) };
      };
      const restore = (done) => {
        done.box?.remove();
        for (const [el, attrs] of done.originals)
          for (const [name, value] of attrs)
            if (value === null) el.removeAttribute(name);
            else el.setAttribute(name, value);
        view.classList.remove("editor-dragging", "editor-preview-invalid");
      };
      const attribute = (done, el, name, value) => {
        if (!done.originals.has(el)) done.originals.set(el, new Map());
        const attrs = done.originals.get(el);
        if (!attrs.has(name)) attrs.set(name, el.getAttribute(name));
        el.setAttribute(name, value);
      };
      const preview = () => {
        frame = null;
        if (!drag?.moved) return;
        if (drag.kind === "marquee") {
          const svg = view.querySelector("svg"),
            top = Number(svg.dataset.layoutTop || 0),
            a = drag.origin,
            b = drag.point;
          if (!drag.box) {
            drag.box = root.ownerDocument.createElementNS("http://www.w3.org/2000/svg", "rect");
            drag.box.setAttribute("class", "editor-marquee");
            svg.append(drag.box);
          }
          for (const [attr, value] of Object.entries({
            x: Math.min(a.x, b.x),
            y: Math.min(a.y, b.y) + top,
            width: Math.abs(a.x - b.x),
            height: Math.abs(a.y - b.y),
          }))
            drag.box.setAttribute(attr, value);
          const ids = [
            ...new Set([...drag.additive, ...nodesInRect(drag.model.drawing.layout.nodes, a, b)]),
          ];
          selection = ids.length ? { kind: "node", id: ids[0], ids } : null;
          markSelection();
          return;
        }
        const status = root.querySelector(".editor-status");
        try {
          const layout = previewEdit(drag.model.drawing.layout, drag.patch, routing),
            paths = new Map(G.displayEdges(drag.model.graph, layout).map((e) => [e.id, e])),
            top = Number(view.querySelector("svg").dataset.layoutTop || 0);
          if (drag.kind === "node") {
            for (const el of view.querySelectorAll("[data-layout-node-id]"))
              if (drag.patch.nodes[el.dataset.layoutNodeId]) {
                const node = layout.nodes.find((n) => n.id === el.dataset.layoutNodeId),
                  previous = drag.model.drawing.layout.nodes.find((n) => n.id === node.id);
                attribute(
                  drag,
                  el,
                  "transform",
                  `translate(${node.x - previous.x} ${node.y - previous.y})`,
                );
              }
          }
          for (const el of view.querySelectorAll(".edge-interactive")) {
            const route = paths.get(el.dataset.layoutEdgeId);
            if (!route) continue;
            const d = routing.path(route.points, [], top).d;
            for (const path of el.querySelectorAll(".edge,.edge-hit"))
              attribute(drag, path, "d", d);
          }
          view.classList.add("editor-dragging");
          view.classList.remove("editor-preview-invalid");
          handles(layout);
          if (status) status.textContent = "实时预览 · 松开应用；Esc取消";
        } catch (error) {
          view.classList.add("editor-preview-invalid");
          if (status) status.textContent = error.message + "；当前保留上一个可用预览，Esc取消";
        }
      };
      const finish = (e) => {
        if (!drag || (e && drag.id !== e.pointerId)) return;
        if (frame != null) cancelAnimationFrame(frame);
        frame = null;
        if (drag.kind === "marquee" && drag.moved && e?.type === "pointerup") preview();
        const done = drag;
        drag = null;
        cancelDrag = null;
        if (frame != null) cancelAnimationFrame(frame);
        frame = null;
        e?.preventDefault();
        e?.stopPropagation();
        restore(done);
        if (!done.moved && done.kind === "node" && e?.type === "pointerup")
          selection = { kind: "node", id: done.node.id, ids: [done.node.id] };
        if (done.kind === "marquee" && e?.type !== "pointerup") {
          selection = done.before;
          activeLane = done.beforeLane;
        }
        if (view.hasPointerCapture(done.id)) view.releasePointerCapture(done.id);
        if (done.moved) ignoreClickUntil = Date.now() + 350;
        if (done.moved && done.kind !== "marquee" && e?.type === "pointerup")
          change((d) => mergeEdit(d, done.patch));
        else panel();
      };
      view.addEventListener(
        "pointerdown",
        (e) => {
          if (!enabled || e.button !== 0 || e.ctrlKey || e.isPrimary === false) return;
          if (e.target.closest("[data-artifact-action]")) return;
          const handle =
              e.target.closest("[data-editor-anchor]") ||
              e.target.closest("[data-editor-bend]") ||
              e.target.closest("[data-editor-segment]"),
            target = e.target.closest("[data-layout-node-id]");
          const marquee =
            !handle &&
            !target &&
            (e.shiftKey || boxSelect) &&
            !e.target.closest("[data-layout-edge-id]");
          if (!handle && !target && !marquee) return;
          cancelDrag?.();
          e.preventDefault();
          e.stopPropagation();
          const before = selection,
            beforeLane = activeLane,
            additive =
              activeLane === view.dataset.lane && e.shiftKey && selection?.kind === "node"
                ? selection.ids || [selection.id]
                : [];
          if (activeLane !== view.dataset.lane) selection = null;
          activeLane = view.dataset.lane;
          if (marquee) {
            drag = {
              id: e.pointerId,
              kind: "marquee",
              model: active(),
              origin: local(e),
              client: { x: e.clientX, y: e.clientY },
              before,
              beforeLane,
              additive,
              originals: new Map(),
              moved: false,
            };
            cancelDrag = () => finish();
            view.setPointerCapture(e.pointerId);
            return;
          }
          const model = active(),
            edge =
              handle && model?.drawing.layout.edges.find((r) => r.id === handle.dataset.editorEdge),
            end = handle?.dataset.editorAnchor,
            node = handle
              ? edge?.[end === "start" ? "from" : "to"]
              : model?.drawing.layout.nodes.find((n) => n.id === target.dataset.layoutNodeId);
          if (!node) return;
          if (!handle && e.shiftKey) {
            select("node", node.id, activeLane, true, true);
            ignoreClickUntil = Date.now() + 350;
            return;
          }
          if (!handle) select("node", node.id, activeLane, false, true);
          drag = {
            id: e.pointerId,
            kind: handle
              ? handle.dataset.editorBend !== undefined
                ? "bend"
                : handle.dataset.editorSegment !== undefined
                  ? "segment"
                  : "anchor"
              : "node",
            model,
            node,
            edge,
            end,
            index: handle?.dataset.editorBend ?? handle?.dataset.editorSegment,
            nodes: handle ? [] : selectedNodes(),
            origin: local(e),
            client: { x: e.clientX, y: e.clientY },
            originals: new Map(),
            moved: false,
          };
          cancelDrag = () => finish();
          if (handle) selection = { kind: "edge", id: edge.id };
          panel();
          view.setPointerCapture(e.pointerId);
        },
        { capture: true, signal },
      );
      view.addEventListener(
        "pointermove",
        (e) => {
          if (!drag || drag.id !== e.pointerId) return;
          e.preventDefault();
          e.stopPropagation();
          const p = local(e),
            dx = p.x - drag.origin.x,
            dy = p.y - drag.origin.y;
          if (Math.hypot(e.clientX - drag.client.x, e.clientY - drag.client.y) < 3 && !drag.moved)
            return;
          drag.moved = true;
          if (drag.kind === "marquee") {
            drag.point = p;
            if (frame == null) frame = requestAnimationFrame(preview);
            return;
          }
          const mx = Math.min(
              ...drag.nodes.map((n) => 50000 - n.x),
              Math.max(dx, ...drag.nodes.map((n) => n.width / 2 + 40 - n.x)),
            ),
            my = Math.min(
              ...drag.nodes.map((n) => 50000 - n.y),
              Math.max(dy, ...drag.nodes.map((n) => n.height / 2 + 40 - n.y)),
            );
          drag.patch =
            drag.kind === "node"
              ? {
                  nodes: Object.fromEntries(
                    drag.nodes.map((n) => [
                      n.id,
                      {
                        x: Math.min(50000, n.x + mx),
                        y: Math.min(50000, n.y + my),
                        fixed: !!n.draft_fixed,
                      },
                    ]),
                  ),
                }
              : drag.kind === "bend"
                ? bendPatch(drag.edge, drag.index, p)
                : drag.kind === "segment"
                  ? segmentPatch(drag.edge, drag.index, p)
                  : { edges: { [drag.edge.id]: { [drag.end]: projectAnchor(drag.node, p) } } };
          if (drag.kind === "node")
            for (const edge of drag.model.drawing.layout.edges)
              if (
                edge.manual_route &&
                drag.patch.nodes[edge.from.id] &&
                drag.patch.nodes[edge.to.id]
              ) {
                drag.patch.edges ||= {};
                drag.patch.edges[edge.id] = {
                  route: edge.manual_route.map((p) => ({ x: p.x + mx, y: p.y + my })),
                };
              }
          if (frame == null) frame = requestAnimationFrame(preview);
        },
        { capture: true, signal },
      );
      for (const type of ["pointerup", "pointercancel", "lostpointercapture"])
        view.addEventListener(type, finish, { capture: true, signal });
      view.addEventListener(
        "wheel",
        () => {
          if (enabled && !drag) requestAnimationFrame(() => handles());
        },
        { passive: true, signal },
      );
    }
    root.addEventListener(
      "keydown",
      (e) => {
        if (enabled && e.key === "Escape" && cancelDrag) {
          e.preventDefault();
          e.stopPropagation();
          cancelDrag();
          return;
        }
        const handle = e.target.closest("[data-editor-anchor]");
        const turn =
          e.target.closest("[data-editor-bend]") || e.target.closest("[data-editor-segment]");
        if (
          enabled &&
          turn &&
          ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)
        ) {
          e.preventDefault();
          e.stopPropagation();
          activeLane = turn.closest(".graph-wrap").dataset.lane;
          selection = { kind: "edge", id: turn.dataset.editorEdge };
          const edge = selectedEdge(),
            path = connectionPath(edge),
            bend = turn.dataset.editorBend,
            index = Number(bend ?? turn.dataset.editorSegment),
            point =
              bend !== undefined
                ? { ...path[index] }
                : {
                    x: (path[index].x + path[index + 1].x) / 2,
                    y: (path[index].y + path[index + 1].y) / 2,
                  },
            step = e.shiftKey ? 20 : 5;
          point[e.key === "ArrowLeft" || e.key === "ArrowRight" ? "x" : "y"] +=
            e.key === "ArrowLeft" || e.key === "ArrowUp" ? -step : step;
          change((d) =>
            mergeEdit(
              d,
              bend !== undefined ? bendPatch(edge, index, point) : segmentPatch(edge, index, point),
            ),
          );
          root
            .querySelector(
              bend !== undefined
                ? `[data-editor-bend="${index}"]`
                : `[data-editor-segment="${index}"]`,
            )
            ?.focus({ preventScroll: true });
          return;
        }
        if (
          enabled &&
          handle &&
          ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)
        ) {
          e.preventDefault();
          e.stopPropagation();
          activeLane = handle.closest(".graph-wrap").dataset.lane;
          selection = { kind: "edge", id: handle.dataset.editorEdge };
          const edge = selectedEdge(),
            end = handle.dataset.editorAnchor,
            node = end === "start" ? edge.from : edge.to,
            anchor = describeAnchor(node, connectionPoint(edge, end), edge.sides[end]);
          anchor.offset = Math.max(
            0,
            Math.min(
              1,
              anchor.offset +
                (e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 1) * (e.shiftKey ? 0.1 : 0.01),
            ),
          );
          const patch = {
            edges: {
              [edge.id]: { [end]: describeAnchor(node, anchorPoint(node, anchor), anchor.side) },
            },
          };
          change((d) => mergeEdit(d, patch));
          root
            .querySelector(`.editor-anchor[data-editor-anchor="${end}"]`)
            ?.focus({ preventScroll: true });
          return;
        }
        if (
          !enabled ||
          !(e.ctrlKey || e.metaKey) ||
          e.key.toLowerCase() !== "z" ||
          e.target.closest("input,select,textarea")
        )
          return;
        e.preventDefault();
        const h = active() && history(active().graph);
        if (h) {
          h[e.shiftKey ? "redo" : "undo"]();
          redraw();
        }
      },
      { signal },
    );
    if (selection?.kind === "node") {
      const ids = selectedNodes().map((n) => n.id);
      selection = ids.length ? { kind: "node", id: ids[0], ids } : null;
    } else if (selection && !selectedEdge()) selection = null;
    panel();
  }
  return {
    hydrate(g, draft) {
      const k = key(g);
      if (draft && JSON.stringify(history(g).value) !== JSON.stringify(draft)) {
        const h = createDraftHistory();
        h.commit(draft);
        histories.set(k, h);
      }
    },
    draft: (g) => history(g).value,
    setEnabled(next) {
      if (enabled !== next) {
        cancelDrag?.();
        enabled = next;
        panel();
      }
    },
    decorate,
    get enabled() {
      return enabled;
    },
    toggle() {
      cancelDrag?.();
      enabled = !enabled;
      message = "";
      panel();
    },
    reset() {
      cancelDrag?.();
      histories.clear();
      selection = null;
      message = "";
    },
    clearModels() {
      models.clear();
    },
    record(lane, g, drawing) {
      models.set(lane, { graph: g, drawing });
    },
    selectNode: (id, lane, additive) => select("node", id, lane, additive),
    selectEdge: (id, lane) => select("edge", id, lane),
    wire,
    dispose() {
      cancelDrag?.();
      controller?.abort();
      histories.clear();
      models.clear();
    },
  };
}
