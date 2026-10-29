/** Synthetic DOM regression; optionally reuse an installed jsdom via JSDOM_MODULE. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
let JSDOM;
try { ({ JSDOM } = require(process.env.JSDOM_MODULE || 'jsdom')); } catch {}
const source = await readFile(new URL('../web/knowledge-graph.js', import.meta.url), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
const statistics = () => ({ scope: 'active-library', total_papers: 47, years: { known: 45, missing: 2, items: [{ year: 2020, count: 45 }], other_count: 0 }, citations: { known_papers: 0, missing_papers: 47, sources: ['crossref', 'openalex', 'semantic-scholar'].map(id => ({ id, label: id, known: 0, missing: 47, buckets: ['0', '1–9', '10–49', '50–99', '100–499', '500+'].map(label => ({ label, count: 0 })) })) } });

test('global graph selects clearly, keeps keyboard and pan/zoom controls, and renders full-catalog unknown coverage', { skip: !JSDOM }, async () => {
  const dom = new JSDOM('<!doctype html><div id="graph"></div>', { runScripts: 'outside-only', url: 'http://synthetic.invalid/' });
  const { window } = dom, root = window.document.getElementById('graph'), calls = [];
  window.ResizeObserver = class { observe() {} disconnect() {} };
  window.eval(source);
  const nodes = Array.from({ length: 8 }, (_, index) => ({ id: `synthetic-${index}`, paper_id: `synthetic-${index}`, type: 'paper', label: `Synthetic saved paper ${index} with a complete descriptive name`, editable: false, provenance: 'catalog-metadata', evidence: {} }));
  const edges = [{ id: 'edge-a', source: nodes[0].id, target: nodes[1].id, relation: 'supports', evidence: {} }, { id: 'edge-b', source: nodes[2].id, target: nodes[3].id, relation: 'related', evidence: {} }];
  const reader = window.PaperKnowledgeGraph.create({ root, scope: 'library', getPaper: () => null, api: async (action, args) => {
    calls.push({ action, args: plain(args) });
    if (action === 'graph_statistics') return statistics();
    assert.equal(action, 'graph'); return { nodes, edges, truncated: true, scope: { paper_count: 40, total_papers: 47, next_offset: 40, previous_offset: null } };
  } });
  const canvas = root.querySelector('.kg-canvas'); Object.defineProperties(canvas, { clientWidth: { value: 800 }, clientHeight: { value: 440 } });
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 440 });
  let capture = null; canvas.setPointerCapture = id => { capture = id; }; canvas.hasPointerCapture = id => capture === id; canvas.releasePointerCapture = () => { capture = null; };
  await reader.load(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(root.querySelector('[data-kg="add-node"]').hidden, true); assert.equal(root.querySelector('[data-kg="add-edge"]').hidden, true);
  assert.match(root.querySelector('.kg-stat-total').textContent, /47/); assert.match(root.querySelector('.kg-stat-empty').textContent, /未采集.*未知不计为 0/);
  assert.equal(root.querySelectorAll('.kg-stat-chart').length, 1, 'Unknown citations have a message, not a zero-citation plot');
  assert.match(root.querySelector('.kg-stat-data table').textContent, /年份缺失2/);
  const initial = reader.getViewport().zoom;
  root.querySelector('[aria-label="放大图谱"]').click(); assert.ok(reader.getViewport().zoom > initial);
  const zoomed = reader.getViewport().zoom; root.querySelector('.kg-node').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  assert.equal(root.querySelectorAll('.kg-node.is-selected').length, 1); assert.equal(root.querySelector('.kg-node.is-selected').getAttribute('aria-pressed'), 'true');
  assert.equal(root.querySelectorAll('.kg-node.is-selected .kg-selection-ring').length, 1); assert.match(root.querySelector('.kg-selection-label').textContent, /已选：Synthetic/); assert.equal(reader.getViewport().zoom, zoomed);
  const selectedNode = root.querySelector('.kg-node.is-selected');
  assert.ok(window.PaperKnowledgeGraph.labelWidth(selectedNode.querySelector('.kg-node-label').textContent) <= 144);
  assert.ok(selectedNode.querySelector('title').textContent.endsWith(nodes[0].label)); assert.ok(selectedNode.getAttribute('aria-label').endsWith(nodes[0].label));
  assert.match(root.querySelector('.kg-inspector').textContent, /with a complete descriptive name/, 'Selected details retain the full supplied label');
  assert.equal(root.querySelectorAll('.kg-edge.is-selected').length, 1); assert.equal(root.querySelectorAll('.kg-edge.is-muted').length, 1);
  root.querySelector('[data-kg="fit"]').click(); assert.equal(reader.getViewport().zoom, 1);
  canvas.dispatchEvent(new window.KeyboardEvent('keydown', { key: '+', bubbles: true })); assert.equal(reader.getViewport().zoom, 1.25);
  const before = reader.getViewport(); canvas.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true })); assert.ok(reader.getViewport().x > before.x);
  function pointer(type, x, y) { const event = new window.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y }); Object.defineProperty(event, 'pointerId', { value: 7 }); canvas.dispatchEvent(event); }
  pointer('pointerdown', 100, 100); const dragStart = reader.getViewport(); pointer('pointermove', 50, 100); assert.ok(reader.getViewport().x > dragStart.x); pointer('pointerup', 50, 100); assert.equal(capture, null);
  await reader.load(null, 40); assert.equal(calls.filter(call => call.action === 'graph_statistics').length, 1, 'Catalog graph paging reuses the full-library snapshot');
  root.querySelector('.kg-node').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  const filter = root.querySelector('[data-kg="filter"]'); filter.value = 'method'; filter.dispatchEvent(new window.Event('change'));
  assert.equal(reader.selectedNode(), null); assert.equal(root.querySelectorAll('.kg-node').length, 0, 'A hidden type does not retain a misleading selected state');
  reader.clear(); assert.equal(root.querySelector('.kg-statistics').getAttribute('aria-busy'), 'false');
  dom.window.close();
});
