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
   */
  function create(options) {
    const { doc, dom, board, view, selection, live, connectFrom, sourceApi, nodeBounds, geometryFor, round, nodeRadius, onRendered } = options;
    const { stage, viewport, edgeLayer, nodeLayer, empty } = dom;
    const { svgEl } = createElements(doc);
    const el = id => doc.getElementById(id);
    const byId = id => board().nodes.find(node => node.id === id);
    /** The drawn elements, keyed by board id, so a drag moves nodes instead of rebuilding the tree. */
    const nodeEls = new Map(), edgeEls = new Map();

    /** Apply the viewport transform and the matching grid offset. */
    function applyView() {
      viewport.setAttribute('transform', `translate(${view().x},${view().y}) scale(${view().zoom})`);
      stage.style.backgroundSize = `${round(24 * view().zoom)}px ${round(24 * view().zoom)}px`;
      stage.style.backgroundPosition = `${view().x}px ${view().y}px`;
      const label = el('board-zoom-label');
      if (label) label.textContent = `${Math.round(view().zoom * 100)}%`;
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

    function renderNode(node) {
      const bounds = nodeBounds(node);
      const style = sourceApi().nodeStyle(board().style ?? {}, node);
      const group = svgEl('g', { class: `board-node board-node-kind-${node.kind}${selection().has(node.id) ? ' is-selected' : ''}${node.origin === 'llm' ? ' is-ai' : ''}${connectFrom() === node.id ? ' is-connect-source' : ''}`, 'data-node': node.id, tabindex: '-1' });
      // Every child is drawn around the node's own origin, and the group is translated into
      // place. Dragging then moves the shape, its labels and its handles as one instead of
      // leaving the text behind until something forces a full render.
      const content = svgEl('g', { class: 'board-node-content', transform: `translate(${bounds.x},${bounds.y})` });
      const shape = shapeFor(node);
      shape.setAttribute('class', 'board-node-shape');
      if (style.fill) shape.setAttribute('fill', style.fill);
      if (node.color || style.stroke) shape.setAttribute('stroke', node.color ?? style.stroke);
      if (style.fontSize) group.setAttribute('data-font-size', String(style.fontSize));
      content.append(shape);
      if (node.kind === 'note') content.append(svgEl('path', { class: 'board-node-fold', 'data-note-fold': '', d: noteFoldPath(node.w, node.h).d }));
      if (node.origin === 'llm') content.append(svgEl('text', { class: 'board-node-meta', x: 6, y: -4 }, 'AI 提议'));
      if (node.kind === 'paper' && node.paper) {
        content.append(svgEl('text', { class: 'board-node-meta', x: 10, y: 18 }, [node.paper.year, node.paper.citekey].filter(Boolean).join(' · ') || '文献'));
        const title = (node.text || node.paper.title || node.paper.id).slice(0, 90);
        content.append(svgEl('text', { class: 'board-node-text', x: 10, y: 40 }, title));
      } else {
        const lines = String(node.text || '').split('\n').slice(0, 6);
        lines.forEach((line, index) => content.append(svgEl('text', { class: 'board-node-text', x: 10, y: 24 + index * 17 }, line.slice(0, 60) || (index === 0 ? '（空）' : ''))));
      }
      if (selection().has(node.id)) {
        content.append(svgEl('rect', { class: 'board-node-handle', x: bounds.w - 5, y: bounds.h - 5, width: 10, height: 10, rx: 2, 'data-handle': 'resize' }));
        content.append(svgEl('circle', { class: 'board-node-handle', cx: bounds.w + 4, cy: bounds.h / 2, r: 5, 'data-handle': 'connect' }));
      }
      group.append(content);
      return group;
    }

    function renderEdge(edge) {
      const from = byId(edge.from), to = byId(edge.to);
      if (!from || !to) return null;
      const selected = selection().has(edge.id);
      const style = sourceApi().edgeStyle(board().style ?? {}, edge);
      const geometry = geometryFor(edge, from, to);
      const group = svgEl('g', { class: `board-edge-group${selected ? ' is-selected' : ''}`, 'data-edge': edge.id });
      const hit = svgEl('path', { class: 'board-edge-hit', d: geometry.path });
      const path = svgEl('path', { class: `board-edge${selected ? ' is-selected' : ''}`, d: geometry.path, 'data-edge-path': edge.id });
      if (style.stroke) path.setAttribute('stroke', style.stroke);
      if (style.width) path.setAttribute('stroke-width', String(style.width));
      if (edge.origin === 'llm' || style.dashed) path.setAttribute('stroke-dasharray', '6 4');
      if (style.arrow !== 'none') path.setAttribute('marker-end', 'url(#board-arrowhead)');
      if (style.arrow === 'both') path.setAttribute('marker-start', 'url(#board-arrowhead)');
      group.append(hit, path);
      if (edge.label) group.append(svgEl('text', { class: 'board-edge-label', x: geometry.mid.x, y: geometry.mid.y - 4 }, edge.label));
      // A selected edge exposes its bend points, which are draggable and removable.
      const handles = [];
      if (selected) for (const [index, point] of (edge.waypoints ?? []).entries()) {
        const handle = svgEl('circle', { class: 'board-waypoint', cx: point[0], cy: point[1], r: 5, 'data-waypoint': `${edge.id}:${index}` });
        handles.push(handle);
        group.append(handle);
      }
      edgeEls.set(edge.id, { group, path, points: geometry.points, handles });
      return group;
    }

    function render() {
      if (!live()) return;
      applyView();
      edgeLayer.replaceChildren();
      nodeLayer.replaceChildren();
      edgeEls.clear(); nodeEls.clear();
      for (const edge of board().edges) { const group = renderEdge(edge); if (group) edgeLayer.append(group); }
      for (const node of board().nodes) { const group = renderNode(node); nodeEls.set(node.id, group); nodeLayer.append(group); }
      empty.hidden = board().nodes.length > 0;
      onRendered();
    }

    /** Fast path during a drag: move existing elements instead of rebuilding the tree. */
    function redrawGeometry() {
      if (!live()) return;
      for (const node of board().nodes) {
        const group = nodeEls.get(node.id);
        if (!group) continue;
        const bounds = nodeBounds(node);
        // The content group is the node's position; the shape and the handles are local to it.
        const content = group.firstChild;
        if (!content) continue;
        content.setAttribute('transform', `translate(${bounds.x},${bounds.y})`);
        const shape = content.firstChild;
        if (!shape) continue;
        if (node.kind === 'ellipse') { shape.setAttribute('cx', bounds.w / 2); shape.setAttribute('cy', bounds.h / 2); shape.setAttribute('rx', bounds.w / 2); shape.setAttribute('ry', bounds.h / 2); }
        else if (node.kind === 'diamond') shape.setAttribute('points', `${bounds.w / 2},0 ${bounds.w},${bounds.h / 2} ${bounds.w / 2},${bounds.h} 0,${bounds.h / 2}`);
        else { shape.setAttribute('width', bounds.w); shape.setAttribute('height', bounds.h); }
        for (const child of content.children ?? []) {
          const handle = child.getAttribute?.('data-handle');
          if (handle === 'resize') { child.setAttribute('x', bounds.w - 5); child.setAttribute('y', bounds.h - 5); }
          else if (handle === 'connect') { child.setAttribute('cx', bounds.w + 4); child.setAttribute('cy', bounds.h / 2); }
          else if (child.getAttribute?.('data-note-fold') !== null && child.getAttribute?.('data-note-fold') !== undefined) child.setAttribute('d', noteFoldPath(bounds.w, bounds.h).d);
        }
      }
      for (const edge of board().edges) {
        const record = edgeEls.get(edge.id), from = byId(edge.from), to = byId(edge.to);
        if (!record || !from || !to) continue;
        const geometry = geometryFor(edge, from, to);
        record.points = geometry.points;
        record.path.setAttribute('d', geometry.path);
        const hit = record.group.firstChild;
        if (hit) hit.setAttribute('d', geometry.path);
        const label = record.group.lastChild;
        if (edge.label && label?.classList?.contains('board-edge-label')) { label.setAttribute('x', geometry.mid.x); label.setAttribute('y', geometry.mid.y - 4); }
        for (const [index, handle] of (record.handles ?? []).entries()) {
          const point = (edge.waypoints ?? [])[index];
          if (!point) continue;
          handle.setAttribute('cx', point[0]);
          handle.setAttribute('cy', point[1]);
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
