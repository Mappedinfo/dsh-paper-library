/* Literature whiteboard renderer.
 *
 * Draws a board object into an SVG tree and keeps the two element maps the panel needs for its
 * fast drag path. Every piece of state it reads — the board, the viewport, the selection, whether
 * the panel is still live — arrives as an accessor, because the panel replaces those values by
 * assignment while the renderer lives on; reading a captured copy would draw a stale board.
 *
 * The module is deliberately DOM-only: geometry comes from the injected `geometryFor`, which is
 * `board-source.js`'s single implementation, and the conversation bridge is not involved at all.
 */
(function () {
  'use strict';

  const NS = 'http://www.w3.org/2000/svg';

  /** Attribute-only DOM helper, shared with the panel so there is one element factory. */
  function createElements(doc) {
    const svgEl = (tag, attrs, text) => {
      const node = doc.createElementNS(NS, tag);
      for (const [key, value] of Object.entries(attrs || {})) node.setAttribute(key, String(value));
      if (text !== undefined) node.textContent = text;
      return node;
    };
    const el = (tag, className, text) => {
      const node = doc.createElement(tag);
      if (className) node.className = className;
      if (text !== undefined) node.textContent = text;
      return node;
    };
    return { svgEl, el };
  }

  /**
   * @param {object} options
   * @param {Document} options.doc
   * @param {object} options.dom        { stage, viewport, edgeLayer, nodeLayer, empty }
   * @param {() => object} options.board        the board being drawn
   * @param {() => object} options.view         { x, y, zoom }
   * @param {() => Set<string>} options.selection
   * @param {() => boolean} options.live
   * @param {() => string|null} options.connectFrom  the node a connect gesture started from
   * @param {() => object} options.sourceApi     board-source.js: sizes, style vocabulary, geometry
   * @param {(node: object) => object} options.nodeBounds
   * @param {(edge: object, from: object, to: object) => object} options.geometryFor
   * @param {(value: number) => number} options.round
   * @param {object} options.nodeRadius    the corner radius per node kind (the panel's own table)
   * @param {() => void} options.onRendered     panel chrome that follows a full render
   * @param {() => void} options.onViewApplied   panel overlay that must track the viewport (the
   *                                             inline text editor is a DOM element over the canvas)
   */
  function create(options) {
    const { doc, dom, board, view, selection, live, connectFrom, sourceApi, nodeBounds, geometryFor, round, nodeRadius, onRendered, onViewApplied } = options;
    const { stage, viewport, edgeLayer, nodeLayer, empty } = dom;
    const { svgEl } = createElements(doc);
    const el = id => doc.getElementById(id);
    const byId = id => board().nodes.find(node => node.id === id);
    /** The drawn elements, keyed by board id, so a drag moves nodes instead of rebuilding the tree. */
    const nodeEls = new Map(), edgeEls = new Map();

    /**
     * Apply the viewport transform and the matching grid offset.
     *
     * Skipped when nothing about the view changed: a node drag calls this on every pointer move,
     * and rewriting the transform of the group that holds the whole scene invalidates it — and with
     * it every child — for style and paint, on frames where the reader is moving a node, not the
     * canvas.
     */
    let appliedView = null;
    function applyView() {
      const current = view();
      const signature = `${current.x},${current.y},${current.zoom}`;
      if (signature === appliedView) return;
      appliedView = signature;
      attr(viewport, 'transform', `translate(${current.x},${current.y}) scale(${current.zoom})`);
      stage.style.backgroundSize = `${round(24 * current.zoom)}px ${round(24 * current.zoom)}px`;
      stage.style.backgroundPosition = `${current.x}px ${current.y}px`;
      const label = el('board-zoom-label');
      if (label) textOf(label, `${Math.round(current.zoom * 100)}%`);
      // Overlays positioned from scene coordinates have to be moved with the scene: the inline text
      // editor lives in a DOM layer over the canvas, so panning or zooming would otherwise leave it
      // behind at the old screen position — which reads as a second, disconnected text box.
      onViewApplied?.();
    }

    /** The shape is drawn in the node's own coordinates: the content group carries the
     *  position, so moving a node rewrites one transform instead of every child's geometry. */
    function shapeFor(node) {
      const w = node.w, h = node.h;
      if (node.kind === 'ellipse') return svgEl('ellipse', { cx: w / 2, cy: h / 2, rx: w / 2, ry: h / 2 });
      if (node.kind === 'diamond') return svgEl('polygon', { points: `${w / 2},0 ${w},${h / 2} ${w / 2},${h} 0,${h / 2}` });
      return svgEl('rect', { x: 0, y: 0, width: w, height: h, rx: nodeRadius[node.kind] ?? 10 });
    }
    /** The turned-up corner that makes a note read as paper rather than a box. */
    const noteFoldPath = (w, h) => { const size = Math.min(22, w / 4, h / 4); return { size, d: `M ${round(w - size)} ${round(h)} L ${round(w)} ${round(h - size)} L ${round(w)} ${round(h)} Z` }; };

    /**
     * Write an attribute only when it is actually different.
     *
     * The renderer reconciles in place, so most attributes it touches on a given pass already hold
     * the right value — three quarters of the writes in a plain re-render were no-ops. Skipping them
     * is what lets the browser keep its style, layout and paint work: a mutation schedule entry that
     * writes the same string still invalidates the element it was written to.
     */
    const attr = (element, name, value) => {
      const text = value === undefined || value === null ? null : String(value);
      if (text === null) { if (element.hasAttribute(name)) element.removeAttribute(name); return; }
      if (element.getAttribute(name) !== text) element.setAttribute(name, text);
    };

    /** Same rule for text: assigning an identical string still dirties the node. */
    const textOf = (element, value) => { const text = value === undefined || value === null ? '' : String(value); if (element.textContent !== text) element.textContent = text; };

    const nodeClass = node => `board-node board-node-kind-${node.kind}${selection().has(node.id) ? ' is-selected' : ''}${node.origin === 'llm' ? ' is-ai' : ''}${connectFrom() === node.id ? ' is-connect-source' : ''}`;

    /** Build one node's subtree. The shape is chosen here and never replaced afterwards. */
    function createNodeElement(node) {
      const group = svgEl('g', { class: nodeClass(node), 'data-node': node.id, tabindex: '-1' });
      const content = svgEl('g', { class: 'board-node-content' });
      const bounds = nodeBounds(node);
      attr(content, 'transform', `translate(${bounds.x},${bounds.y})`);
      const shape = shapeFor(node);
      shape.setAttribute('class', 'board-node-shape');
      content.append(shape);
      if (node.kind === 'note') content.append(svgEl('path', { class: 'board-node-fold', 'data-note-fold': '', d: noteFoldPath(node.w, node.h).d }));
      if (node.origin === 'llm') content.append(svgEl('text', { class: 'board-node-meta', x: 6, y: -4 }, 'AI 提议'));
      if (node.kind === 'paper' && node.paper) {
        content.append(svgEl('text', { class: 'board-node-meta board-node-paper-meta', x: 10, y: 18 }));
        content.append(svgEl('text', { class: 'board-node-text', x: 10, y: 40 }));
      } else {
        for (let index = 0; index < 6; index++) content.append(svgEl('text', { class: 'board-node-text', x: 10, y: 24 + index * 17, 'data-line': index }));
      }
      const resize = svgEl('rect', { class: 'board-node-handle', width: 10, height: 10, rx: 2, 'data-handle': 'resize', hidden: 'hidden' });
      const connect = svgEl('circle', { class: 'board-node-handle', r: 5, 'data-handle': 'connect', hidden: 'hidden' });
      content.append(resize, connect);
      group.append(content);
      return group;
    }

    /**
     * Bring an existing node subtree up to date. This is the whole point of the renderer keeping
     * its elements: a board of 150 nodes used to be thrown away and rebuilt — about 1,200 elements
     * created and 3,700 attributes written — for every selection, theme or save-status change.
     */
    function updateNodeElement(group, node) {
      const bounds = nodeBounds(node);
      const style = sourceApi().nodeStyle(board().style ?? {}, node);
      attr(group, 'class', nodeClass(node));
      const content = group.firstChild;
      content.setAttribute('transform', `translate(${bounds.x},${bounds.y})`);
      attr(group, 'data-font-size', style.fontSize ?? null);
      const shape = content.firstChild;
      const radius = nodeRadius[node.kind] ?? 10;
      if (node.kind === 'ellipse') {
        attr(shape, 'cx', bounds.w / 2); attr(shape, 'cy', bounds.h / 2);
        attr(shape, 'rx', bounds.w / 2); attr(shape, 'ry', bounds.h / 2);
      } else if (node.kind === 'diamond') {
        attr(shape, 'points', `${bounds.w / 2},0 ${bounds.w},${bounds.h / 2} ${bounds.w / 2},${bounds.h} 0,${bounds.h / 2}`);
      } else {
        attr(shape, 'width', bounds.w); attr(shape, 'height', bounds.h); attr(shape, 'rx', radius);
      }
      attr(shape, 'fill', style.fill ?? null);
      attr(shape, 'stroke', node.color ?? style.stroke ?? null);
      // The trailing texts are the labels; the fold path belongs to a note.
      const labels = [];
      for (const child of content.children) {
        if (child.classList?.contains('board-node-text') || child.classList?.contains('board-node-meta')) labels.push(child);
      }
      if (node.kind === 'paper' && node.paper) {
        const meta = labels.find(label => label.classList.contains('board-node-paper-meta'));
        const title = labels.find(label => label.classList.contains('board-node-text'));
        if (meta) textOf(meta, [node.paper.year, node.paper.citekey].filter(Boolean).join(' · ') || '文献');
        if (title) textOf(title, (node.text || node.paper.title || node.paper.id).slice(0, 90));
      } else {
        const lines = String(node.text || '').split('\n').slice(0, 6);
        const slots = labels.filter(label => label.getAttribute('data-line') !== null);
        slots.forEach((slot, index) => {
          const line = lines[index];
          textOf(slot, line === undefined ? '' : (line.slice(0, 60) || (index === 0 ? '（空）' : '')));
          attr(slot, 'hidden', line === undefined ? 'hidden' : null);
        });
      }
      const selected = selection().has(node.id);
      for (const child of content.children) {
        const handle = child.getAttribute?.('data-handle');
        if (handle === 'resize') { attr(child, 'hidden', selected ? null : 'hidden'); attr(child, 'x', bounds.w - 5); attr(child, 'y', bounds.h - 5); }
        else if (handle === 'connect') { attr(child, 'hidden', selected ? null : 'hidden'); attr(child, 'cx', bounds.w + 4); attr(child, 'cy', bounds.h / 2); }
        else if (child.getAttribute?.('data-note-fold') !== null) attr(child, 'd', noteFoldPath(bounds.w, bounds.h).d);
      }
    }

    /** Kept for callers that want a detached subtree (the panel's own renderNode export). */
    function renderNode(node) {
      const group = createNodeElement(node);
      updateNodeElement(group, node);
      return group;
    }

    function createEdgeElement(edge) {
      const group = svgEl('g', { class: 'board-edge-group', 'data-edge': edge.id });
      group.append(svgEl('path', { class: 'board-edge-hit' }), svgEl('path', { class: 'board-edge', 'data-edge-path': edge.id }));
      group.append(svgEl('text', { class: 'board-edge-label', hidden: 'hidden' }));
      return group;
    }

    function updateEdgeElement(group, edge) {
      const from = byId(edge.from), to = byId(edge.to);
      if (!from || !to) return false;
      const selected = selection().has(edge.id);
      const style = sourceApi().edgeStyle(board().style ?? {}, edge);
      const geometry = geometryFor(edge, from, to);
      attr(group, 'class', `board-edge-group${selected ? ' is-selected' : ''}`);
      const hit = group.children[0], path = group.children[1];
      attr(hit, 'd', geometry.path);
      attr(path, 'd', geometry.path);
      attr(path, 'stroke', style.stroke ?? null);
      attr(path, 'stroke-width', style.width ? String(style.width) : null);
      attr(path, 'stroke-dasharray', edge.origin === 'llm' || style.dashed ? '6 4' : null);
      attr(path, 'marker-end', style.arrow !== 'none' ? 'url(#board-arrowhead)' : null);
      attr(path, 'marker-start', style.arrow === 'both' ? 'url(#board-arrowhead)' : null);
      const label = group.children[2];
      attr(label, 'hidden', edge.label ? null : 'hidden');
      if (edge.label) { attr(label, 'x', geometry.mid.x); attr(label, 'y', geometry.mid.y - 4); textOf(label, edge.label); }
      // Bend points are the trailing children: one per waypoint, added and removed as they change.
      const handles = [];
      const waypoints = selected ? (edge.waypoints ?? []) : [];
      for (let index = 0; index < waypoints.length; index++) {
        let handle = group.children[3 + index];
        if (!handle) { handle = svgEl('circle', { class: 'board-waypoint', r: 5 }); group.append(handle); }
        attr(handle, 'cx', waypoints[index][0]);
        attr(handle, 'cy', waypoints[index][1]);
        attr(handle, 'data-waypoint', `${edge.id}:${index}`);
        handles.push(handle);
      }
      for (let index = group.children.length - 1; index >= 3 + waypoints.length; index--) group.children[index].remove();
      edgeEls.set(edge.id, { group, path, points: geometry.points, handles });
      return true;
    }

    function renderEdge(edge) {
      const group = createEdgeElement(edge);
      return updateEdgeElement(group, edge) ? group : null;
    }

    function render() {
      if (!live()) return;
      applyView();
      // Reconcile keyed by board id instead of rebuilding the layer: the elements a reader is
      // looking at keep their identity across a selection, a rename or a save-status change, so the
      // browser only restyles what actually moved. This is the SVG equivalent of the persistent
      // scene a canvas renderer keeps, and it is why `redrawGeometry` and `render` now agree about
      // what is on screen.
      reconcileNodes();
      reconcileEdges();
      empty.hidden = board().nodes.length > 0;
      onRendered();
    }

    /** Move an element only when its position in the paint order changed. */
    const placeAt = (layer, element, index) => {
      if (layer.children[index] !== element) layer.insertBefore(element, layer.children[index] ?? null);
    };

    function reconcileNodes() {
      const nodes = board().nodes;
      const seen = new Set();
      for (const [index, node] of nodes.entries()) {
        seen.add(node.id);
        let group = nodeEls.get(node.id);
        if (!group) { group = createNodeElement(node); nodeEls.set(node.id, group); }
        updateNodeElement(group, node);
        placeAt(nodeLayer, group, index);
      }
      for (const [id, group] of [...nodeEls]) {
        if (seen.has(id)) continue;
        group.remove();
        nodeEls.delete(id);
      }
    }

    function reconcileEdges() {
      const edges = board().edges;
      const seen = new Set();
      let index = 0;
      for (const edge of edges) {
        // An edge whose endpoints are gone is not drawn (the model drops those, but a render can
        // run against a board mid-edit), and it must not claim a slot in the paint order either.
        if (!byId(edge.from) || !byId(edge.to)) continue;
        seen.add(edge.id);
        let group = edgeEls.get(edge.id)?.group;
        if (!group) group = createEdgeElement(edge);
        if (!updateEdgeElement(group, edge)) { group.remove(); edgeEls.delete(edge.id); continue; }
        placeAt(edgeLayer, group, index++);
      }
      for (const [id, record] of [...edgeEls]) {
        if (seen.has(id)) continue;
        record.group.remove();
        edgeEls.delete(id);
      }
    }

    /**
     * Fast path during a gesture: rewrite the geometry of the elements that can have changed.
     *
     * `moved` is a Set of node ids the caller knows it touched (a drag moves one or a few). Without
     * it every node and edge is rewritten, which is what a layout pass needs but a single-node drag
     * does not: at 150 nodes that was ~1,500 attribute writes per pointer move, and an attribute
     * write schedules work even when the value is identical.
     */
    function redrawGeometry(moved = null) {
      if (!live()) return;
      const touches = moved ? new Set(moved) : null;
      for (const node of board().nodes) {
        if (touches && !touches.has(node.id)) continue;
        const group = nodeEls.get(node.id);
        if (!group) continue;
        const bounds = nodeBounds(node);
        // The content group is the node's position; the shape and the handles are local to it.
        const content = group.firstChild;
        if (!content) continue;
        attr(content, 'transform', `translate(${bounds.x},${bounds.y})`);
        const shape = content.firstChild;
        if (!shape) continue;
        if (node.kind === 'ellipse') { attr(shape, 'cx', bounds.w / 2); attr(shape, 'cy', bounds.h / 2); attr(shape, 'rx', bounds.w / 2); attr(shape, 'ry', bounds.h / 2); }
        else if (node.kind === 'diamond') attr(shape, 'points', `${bounds.w / 2},0 ${bounds.w},${bounds.h / 2} ${bounds.w / 2},${bounds.h} 0,${bounds.h / 2}`);
        else { attr(shape, 'width', bounds.w); attr(shape, 'height', bounds.h); }
        for (const child of content.children ?? []) {
          const handle = child.getAttribute?.('data-handle');
          if (handle === 'resize') { attr(child, 'x', bounds.w - 5); attr(child, 'y', bounds.h - 5); }
          else if (handle === 'connect') { attr(child, 'cx', bounds.w + 4); attr(child, 'cy', bounds.h / 2); }
          else if (child.getAttribute?.('data-note-fold') !== null && child.getAttribute?.('data-note-fold') !== undefined) attr(child, 'd', noteFoldPath(bounds.w, bounds.h).d);
        }
      }
      for (const edge of board().edges) {
        // Only an edge with a moved endpoint can have a new path.
        if (touches && !touches.has(edge.from) && !touches.has(edge.to)) continue;
        const record = edgeEls.get(edge.id), from = byId(edge.from), to = byId(edge.to);
        if (!record || !from || !to) continue;
        const geometry = geometryFor(edge, from, to);
        record.points = geometry.points;
        attr(record.path, 'd', geometry.path);
        const hit = record.group.firstChild;
        if (hit) attr(hit, 'd', geometry.path);
        const label = record.group.lastChild;
        if (edge.label && label?.classList?.contains('board-edge-label')) { attr(label, 'x', geometry.mid.x); attr(label, 'y', geometry.mid.y - 4); }
        for (const [index, handle] of (record.handles ?? []).entries()) {
          const point = (edge.waypoints ?? [])[index];
          if (!point) continue;
          attr(handle, 'cx', point[0]);
          attr(handle, 'cy', point[1]);
        }
      }
      applyView();
    }

    return {
      nodeEls,
      edgeEls,
      applyView,
      shapeFor,
      noteFoldPath,
      renderNode,
      renderEdge,
      render,
      redrawGeometry,
      nodeElement: id => nodeEls.get(id),
      edgeElement: id => edgeEls.get(id),
    };
  }

  window.PaperBoardRender = Object.freeze({ create, createElements });
})();
