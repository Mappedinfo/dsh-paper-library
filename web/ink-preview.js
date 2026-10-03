/** Bounded, derived views of PDF ink and its immutable pending save batches.
 * PDF geometry remains authoritative. This module never persists annotations. */
(function () {
  'use strict';

  const LIMITS = Object.freeze({ objects: 72, scannedObjects: 256, strokes: 128, points: 8192, coordinate: 1000000, regionGap: 24, minBounds: 12 });
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  const identity = value => typeof value === 'string' && value.length > 0 && value.length <= 512 ? value : null;
  const validPage = value => Number.isSafeInteger(value) && value > 0 && value <= 100000;

  function color(value) {
    const input = value && typeof value === 'object' && !Array.isArray(value) ? value.stroke : value;
    if (typeof input === 'string' && /^#[\da-f]{6}$/i.test(input)) return input.toLowerCase();
    if (Array.isArray(input) && input.length === 3 && input.every(v => finite(v) && v >= 0 && v <= 1)) {
      return '#' + input.map(v => Math.round(v * 255).toString(16).padStart(2, '0')).join('');
    }
    return '#2455a4';
  }

  function pointBounds(points, width) {
    let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
    for (const [x, y] of points) { left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y); }
    const radius = width / 2;
    left -= radius; top -= radius; right += radius; bottom += radius;
    const dx = Math.max(0, LIMITS.minBounds - (right - left)) / 2;
    const dy = Math.max(0, LIMITS.minBounds - (bottom - top)) / 2;
    return [left - dx, top - dy, right + dx, bottom + dy];
  }

  function bounds(strokes) {
    if (!Array.isArray(strokes) || !strokes.length) return null;
    let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
    for (const stroke of strokes.slice(0, LIMITS.strokes)) {
      const rect = stroke.bounds;
      if (!Array.isArray(rect) || rect.length !== 4 || !rect.every(finite)) continue;
      left = Math.min(left, rect[0]); top = Math.min(top, rect[1]); right = Math.max(right, rect[2]); bottom = Math.max(bottom, rect[3]);
    }
    return finite(left) ? [left, top, right, bottom] : null;
  }

  // Derived cache/region keys, not security or persistence identities.
  function hash(text) {
    let value = 2166136261;
    for (let i = 0; i < text.length; i++) value = Math.imul(value ^ text.charCodeAt(i), 16777619);
    return (value >>> 0).toString(36);
  }

  function strokeKey(stroke) {
    return JSON.stringify([stroke.page, stroke.width, stroke.color, stroke.points]);
  }

  function regions(strokes) {
    const parents = strokes.map((_, index) => index);
    const find = index => { while (parents[index] !== index) { parents[index] = parents[parents[index]]; index = parents[index]; } return index; };
    // At most 128 strokes: bounded pairwise connectivity gives the same result
    // for any input order and does not inherit autosave batch boundaries.
    for (let i = 0; i < strokes.length; i++) for (let j = i + 1; j < strokes.length; j++) {
      if (strokes[i].page !== strokes[j].page) continue;
      const a = strokes[i].bounds, b = strokes[j].bounds;
      const dx = Math.max(0, a[0] - b[2], b[0] - a[2]), dy = Math.max(0, a[1] - b[3], b[1] - a[3]);
      if (Math.hypot(dx, dy) <= LIMITS.regionGap) parents[find(j)] = find(i);
    }
    const groups = new Map();
    strokes.forEach((stroke, index) => { const id = find(index); if (!groups.has(id)) groups.set(id, []); groups.get(id).push(stroke); });
    return [...groups.values()].map(values => ({
      id: `ink-region-${values[0].page}-${hash(values.map(strokeKey).sort().join('|'))}`,
      page: values[0].page, bounds: bounds(values), strokes: values,
    })).sort((a, b) => a.page - b.page || a.bounds[1] - b.bounds[1] || a.bounds[0] - b.bounds[0] || a.id.localeCompare(b.id));
  }

  function prepare({ annotations = [], pending = [], paperId, parentId, geometryVersion = '' } = {}) {
    const strokes = [], seen = new Set(), revisions = [];
    let pointCount = 0, objectCount = 0, scannedObjects = 0, invalidCount = 0, truncated = false;
    const add = (value, source) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) { invalidCount++; return; }
      if (source === 'pending' && (paperId !== undefined && value.paperId !== paperId || parentId !== undefined && value.parentId !== parentId)) return;
      if (source === 'saved' && parentId !== undefined && value.parent_id !== undefined && value.parent_id !== parentId) return;
      const annotationId = identity(source === 'saved' ? value.id : value.annotation_id);
      if (annotationId && seen.has(annotationId)) return;
      if (objectCount >= LIMITS.objects) { truncated = true; return; }
      objectCount++;
      const width = value.width === undefined ? 2 : value.width;
      if (!validPage(value.page) || !finite(width) || width < 0.5 || width > 16 || !Array.isArray(value.paths)) { invalidCount++; return; }
      if (source === 'pending') revisions.push([annotationId, value.revision, value.status]);
      const safeColor = color(value.color);
      for (let index = 0; index < value.paths.length; index++) {
        if (strokes.length >= LIMITS.strokes || index >= LIMITS.strokes) { truncated = true; break; }
        const points = value.paths[index];
        if (!Array.isArray(points) || !points.length) { invalidCount++; continue; }
        if (points.length > LIMITS.points || pointCount + points.length > LIMITS.points) { truncated = true; continue; }
        if (!points.every(p => Array.isArray(p) && p.length === 2 && p.every(v => finite(v) && Math.abs(v) <= LIMITS.coordinate))) { invalidCount++; continue; }
        const copied = points.map(p => [p[0], p[1]]);
        if (annotationId) seen.add(annotationId);
        strokes.push({ annotationId, page: value.page, points: copied, width, color: safeColor, source,
          status: source === 'saved' ? 'saved' : String(value.status || 'queued').slice(0, 32), bounds: pointBounds(copied, width) });
        pointCount += copied.length;
      }
    };
    for (const [values, source] of [[annotations, 'saved'], [pending, 'pending']]) {
      if (!Array.isArray(values)) { invalidCount++; continue; }
      for (let i = 0; i < values.length; i++) {
        if (scannedObjects >= LIMITS.scannedObjects) { truncated = true; break; }
        scannedObjects++; add(values[i], source);
      }
    }
    const grouped = regions(strokes);
    // Geometry is included as well as revisions: a stale/missing producer version
    // cannot make a new stroke reuse an obsolete preview.
    const key = hash(JSON.stringify([paperId, parentId, String(geometryVersion).slice(0, 512), revisions,
      strokes.map(s => [s.annotationId, s.source, s.status, strokeKey(s)]), truncated, invalidCount]));
    return { strokes, regions: grouped, bounds: bounds(strokes), pages: [...new Set(strokes.map(s => s.page))].sort((a, b) => a - b),
      cacheKey: `ink-preview-${key}`, pointCount, truncated, invalidCount };
  }

  function render(document, model, { regionId = null, label = '关联手写笔迹' } = {}) {
    if (!document || typeof document.createElementNS !== 'function') throw new TypeError('An SVG-capable document is required.');
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'ink-preview-svg'); svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', String(label).slice(0, 160)); svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    svg.setAttribute('width', '100%'); svg.setAttribute('height', '120');
    svg.setAttribute('fill', 'none'); svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round');
    const selected = regionId == null ? model?.strokes : model?.regions?.find(r => r.id === regionId)?.strokes;
    // Revalidate at the rendering boundary as the public helper can also be
    // called with a previously cached or independently constructed model.
    const styles = [];
    let previousStyle;
    for (const stroke of (Array.isArray(selected) ? selected : []).slice(0, LIMITS.strokes)) {
      if (!stroke || typeof stroke !== 'object') continue;
      const safeColor = color(stroke.color), key = JSON.stringify([stroke.page, stroke.width, safeColor]);
      if (key !== previousStyle) styles.push({ page: stroke.page, width: stroke.width, color: safeColor, paths: [] });
      styles.at(-1).paths.push(stroke.points); previousStyle = key;
    }
    const checked = prepare({ annotations: styles });
    const values = checked.strokes;
    const pages = checked.pages, offsets = new Map();
    let top = 8, width = 24;
    for (const page of pages) {
      const rect = bounds(values.filter(s => s.page === page));
      offsets.set(page, { x: 8 - rect[0], y: top - rect[1] });
      width = Math.max(width, rect[2] - rect[0] + 16); top += rect[3] - rect[1] + 16;
    }
    svg.setAttribute('viewBox', `0 0 ${width} ${Math.max(24, top)}`);
    svg.setAttribute('data-truncated', String(Boolean(model?.truncated || checked.truncated || Array.isArray(selected) && selected.length > LIMITS.strokes)));
    svg.setAttribute('data-stroke-count', String(values.length));
    for (const stroke of values) {
      const offset = offsets.get(stroke.page), first = stroke.points[0];
      const dot = stroke.points.every(p => p[0] === first[0] && p[1] === first[1]);
      const path = document.createElementNS(SVG_NS, dot ? 'circle' : 'polyline');
      if (dot) {
        path.setAttribute('cx', String(first[0] + offset.x)); path.setAttribute('cy', String(first[1] + offset.y));
        path.setAttribute('r', String(stroke.width / 2)); path.setAttribute('fill', stroke.color);
      } else {
        path.setAttribute('points', stroke.points.map(p => `${p[0] + offset.x},${p[1] + offset.y}`).join(' '));
        path.setAttribute('stroke', stroke.color); path.setAttribute('stroke-width', String(stroke.width));
      }
      path.setAttribute('data-page', String(stroke.page)); svg.appendChild(path);
    }
    return svg;
  }

  const api = Object.freeze({ LIMITS, prepare, render, bounds });
  if (typeof window !== 'undefined') window.PaperInkPreview = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
