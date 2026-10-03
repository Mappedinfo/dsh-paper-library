import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const context = { window: {}, module: { exports: {} } };
vm.runInNewContext(await readFile(new URL('../web/ink-preview.js', import.meta.url), 'utf8'), context);
const preview = context.module.exports;
const plain = value => JSON.parse(JSON.stringify(value));
const saved = (id, paths = [[[20, 30], [40, 50]]], extra = {}) => ({ id, page: 1, paths, width: 2, color: { stroke: [0.2, 0.4, 0.6] }, ...extra });
const pending = (id, paths, extra = {}) => ({ paperId: 'paper', parentId: 'parent', annotation_id: id, page: 1, paths, width: 2, color: '#123456', revision: 1, status: 'queued', ...extra });
const prepare = (annotations = [], batches = [], extra = {}) => preview.prepare({ annotations, pending: batches, paperId: 'paper', parentId: 'parent', ...extra });

class Element {
  constructor(namespace, tag) { this.namespaceURI = namespace; this.tagName = tag; this.attributes = {}; this.children = []; }
  setAttribute(key, value) { this.attributes[key] = value; }
  appendChild(child) { this.children.push(child); }
}
const document = { createElementNS: (namespace, tag) => new Element(namespace, tag) };

test('browser global and CommonJS expose the same immutable helper', () => {
  assert.equal(context.window.PaperInkPreview, preview);
  assert.equal(Object.isFrozen(preview), true);
  assert.equal(Object.isFrozen(preview.LIMITS), true);
});

test('confirmed PDF identity wins over retry batch, unrelated queues are excluded, repeated geometry is retained', () => {
  const paths = [[[20, 30], [40, 50]]];
  const model = prepare([saved('same'), saved('intentional-copy')], [pending('same', paths), pending('next', paths), pending('other-paper', paths, { paperId: 'other' }), pending('other-parent', paths, { parentId: 'other' })]);
  assert.deepEqual(plain(model.strokes.map(s => [s.annotationId, s.source])), [['same', 'saved'], ['intentional-copy', 'saved'], ['next', 'pending']]);
  assert.equal(model.invalidCount, 0);
  assert.equal(model.truncated, false);
});

test('preview copies geometry without changing either PDF projection or pending snapshot', () => {
  const annotation = saved('saved'), batch = pending('pending', [[[50, 50], [70, 70]]]);
  const originals = JSON.stringify([annotation, batch]);
  const model = prepare([annotation], [batch]);
  model.strokes[0].points[0][0] = 999;
  model.strokes[1].points.push([100, 100]);
  assert.equal(JSON.stringify([annotation, batch]), originals);
});

test('unrelated queue entries and duplicate acknowledgements do not consume the selected card capacity', () => {
  const annotations = Array.from({ length: 64 }, (_, i) => saved(`saved-${i}`));
  const batches = [...annotations.map(a => pending(a.id, a.paths)), ...Array.from({ length: 32 }, (_, i) => pending(`other-${i}`, [[[1, 2]]], { parentId: 'other' })), pending('new', [[[500, 500]]])];
  const model = prepare(annotations, batches);
  assert.equal(model.strokes.length, 65);
  assert.equal(model.truncated, false);
  assert.equal(model.strokes.at(-1).annotationId, 'new');
});

test('regions reflect spatial connectivity rather than autosave batches', () => {
  const a = [[10, 10], [30, 20]], b = [[40, 10], [60, 20]], distant = [[300, 400], [330, 420]];
  const joined = prepare([saved('a', [a, distant]), saved('b', [b])]);
  const split = prepare([saved('one', [distant, b, a])]);
  assert.equal(joined.regions.length, 2);
  assert.deepEqual(plain(joined.regions.map(r => [r.id, r.bounds, r.strokes.length])), plain(split.regions.map(r => [r.id, r.bounds, r.strokes.length])));
  assert.equal(joined.regions[0].strokes.length, 2);
  assert.equal(joined.regions[1].strokes.length, 1);
});

test('region ordering and identity remain stable after pending geometry becomes a saved annotation', () => {
  const a = saved('a', [[[10, 10], [30, 20]]]), b = saved('b', [[[300, 400], [330, 420]]]);
  const before = prepare([b], [pending('a', a.paths, { color: a.color })]);
  const after = prepare([a, b]);
  assert.deepEqual(plain(before.regions.map(r => [r.id, r.page, r.bounds])), plain(after.regions.map(r => [r.id, r.page, r.bounds])));
});

test('same coordinates on different pages never form one navigation region', () => {
  const model = prepare([saved('page2', undefined, { page: 2 }), saved('page1')]);
  assert.deepEqual(plain(model.regions.map(r => r.page)), [1, 2]);
  assert.deepEqual(plain(model.pages), [1, 2]);
});

test('bounds include pen radius and provide minimum clickable size for dots and thin lines', () => {
  const model = prepare([saved('line', [[[0, 0], [100, 0]]], { width: 8 }), saved('dot', [[[200, 200]]], { width: 0.5 })]);
  assert.deepEqual(plain(model.strokes[0].bounds), [-4, -6, 104, 6]);
  assert.deepEqual(plain(model.strokes[1].bounds), [194, 194, 206, 206]);
  assert.deepEqual(plain(preview.bounds(model.strokes)), [-4, -6, 206, 206]);
  assert.equal(preview.bounds([]), null);
});

test('RGB PDF colors and literal hex are retained; URL/markup colors cannot enter SVG attributes', () => {
  const model = prepare([saved('rgb'), saved('hex', undefined, { color: '#Aa22BB' }), saved('hostile', undefined, { color: 'url(https://example.invalid/leak)' })]);
  assert.deepEqual(plain(model.strokes.map(s => s.color)), ['#336699', '#aa22bb', '#2455a4']);
  const svg = preview.render(document, model, { label: '<script>text only</script>' });
  assert.equal(svg.attributes['aria-label'], '<script>text only</script>');
  assert.ok(svg.children.every(n => n.tagName === 'polyline' && /^#[\da-f]{6}$/.test(n.attributes.stroke)));
  assert.ok(svg.children.every(n => !Object.hasOwn(n.attributes, 'href')));
});

test('invalid and excessive geometry is explicit and does not produce NaN or unbounded SVG', () => {
  const model = prepare([saved('bad', [[[NaN, 2]], [[1, Infinity]], [[1e20, 2]], [[1, 2, 3]], []]), saved('badwidth', undefined, { width: -1 }), saved('good')]);
  assert.equal(model.invalidCount, 6);
  assert.equal(model.strokes.length, 1);
  const excess = prepare([saved('huge', [Array.from({ length: 9000 }, () => [0, 0])])]);
  assert.equal(excess.truncated, true);
  assert.equal(excess.pointCount, 0);
  assert.equal(preview.render(document, model).children.length, 1);
});

test('128 strokes and 8192 points remain complete and render fully; excess is marked', () => {
  const paths = Array.from({ length: 128 }, (_, i) => Array.from({ length: 64 }, (_, j) => [i, j]));
  const model = prepare([saved('full', paths)]);
  assert.equal(model.pointCount, 8192);
  assert.equal(model.strokes.length, 128);
  assert.equal(model.truncated, false);
  const svg = preview.render(document, model);
  assert.equal(svg.children.length, 128);
  assert.equal(svg.attributes['data-truncated'], 'false');
  const excess = prepare([saved('full', [...paths, [[300, 300]]])]);
  assert.equal(excess.strokes.length, 128);
  assert.equal(excess.truncated, true);
});

test('cache invalidates for changed geometry, pending revision/status and PDF geometry version', () => {
  const batch = pending('a', [[[1, 2], [3, 4]]]);
  const initial = prepare([], [batch], { geometryVersion: 'version-1' }).cacheKey;
  assert.equal(prepare([], [batch], { geometryVersion: 'version-1' }).cacheKey, initial);
  for (const changed of [{ ...batch, revision: 2 }, { ...batch, status: 'uncertain' }, { ...batch, paths: [[[1, 2], [5, 6]]] }]) assert.notEqual(prepare([], [changed], { geometryVersion: 'version-1' }).cacheKey, initial);
  assert.notEqual(prepare([], [batch], { geometryVersion: 'version-2' }).cacheKey, initial);
});

test('region-only SVG contains only that location and preserves colors and pen widths', () => {
  const model = prepare([saved('thin', [[[20, 20], [30, 30]]], { width: 1, color: '#123456' }), saved('wide', [[[300, 400], [330, 420]]], { width: 8, color: '#654321' })]);
  const svg = preview.render(document, model, { regionId: model.regions[1].id });
  assert.equal(svg.namespaceURI, 'http://www.w3.org/2000/svg');
  assert.equal(svg.attributes.role, 'img');
  assert.equal(svg.children.length, 1);
  assert.equal(svg.children[0].attributes.stroke, '#654321');
  assert.equal(svg.children[0].attributes['stroke-width'], '8');
  assert.ok(svg.attributes.viewBox.split(' ').map(Number).every(Number.isFinite));
  assert.equal(preview.render(document, model, { regionId: 'expired-region' }).children.length, 0);
});

test('SVG keeps the paint order of overlapping strokes with repeated styles', () => {
  const model = prepare([saved('first', undefined, { color: '#ff0000' }), saved('middle', undefined, { color: '#0000ff' }), saved('last', undefined, { color: '#ff0000' })]);
  const svg = preview.render(document, model);
  assert.deepEqual(svg.children.map(n => n.attributes.stroke), ['#ff0000', '#0000ff', '#ff0000']);
});

test('single-point and repeated-point strokes render as visible circles with true pen diameter', () => {
  const model = prepare([saved('dot', [[[5, 5]], [[10, 10], [10, 10]]], { width: 4 })]);
  const svg = preview.render(document, model);
  assert.deepEqual(svg.children.map(n => [n.tagName, n.attributes.r, n.attributes.fill]), [['circle', '2', '#336699'], ['circle', '2', '#336699']]);
});

test('multi-page fallback stacks page geometries instead of overlaying unrelated pages', () => {
  const model = prepare([saved('page1'), saved('page2', undefined, { page: 2 })]);
  const svg = preview.render(document, model);
  assert.equal(svg.children.length, 2);
  const ys = svg.children.map(n => Number(n.attributes.points.split(' ')[0].split(',')[1]));
  assert.ok(ys[1] > ys[0] + 20);
});

test('rendering an independently constructed oversized model stays bounded and signals partial output', () => {
  const stroke = prepare([saved('one')]).strokes[0];
  const svg = preview.render(document, { strokes: Array.from({ length: 1000 }, () => stroke) });
  assert.equal(svg.children.length, preview.LIMITS.strokes);
  assert.equal(svg.attributes['data-truncated'], 'true');
});
