import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const context = vm.createContext({ window: {} });
vm.runInContext(await readFile(new URL('../web/knowledge-graph.js', import.meta.url), 'utf8'), context);
const graph = context.window.PaperKnowledgeGraph;

test('knowledge graph exposes scientific and bibliographic objects with directional meanings', () => {
  for (const kind of ['paper', 'author', 'institution', 'method', 'dataset', 'claim', 'evidence']) assert.ok(graph.types[kind]);
  assert.equal(graph.relationLabel('supports'), '支持');
  assert.equal(graph.relationLabel('derived_from'), '源自');
  assert.equal(graph.relationLabel('affiliated_with'), '隶属于');
  assert.equal(graph.relationLabel('a future imported relation'), 'a future imported relation');
});

test('selected node relations preserve incoming and outgoing direction', () => {
  const edges = [{ source: 'evidence', target: 'claim', relation: 'supports' }, { source: 'claim', target: 'method', relation: 'uses' }, { source: 'paper', target: 'author', relation: 'authored_by' }];
  const selected = graph.scopedEdges({ edges }, 'claim');
  assert.deepEqual(JSON.parse(JSON.stringify(selected)), edges.slice(0, 2));
  assert.equal(graph.scopedEdges({ edges }, null), edges);
  assert.equal(graph.scopedEdges({ edges }, 'missing').length, 0);
});

test('evidence source remains distinguishable from reader interpretation and unknown page', () => {
  const value = graph.evidenceSummary({ page: 3, quote: '<b>Original observation</b>', note: 'Reader interpretation', source: 'Figure 2', annotation_id: 'source-note-7' });
  assert.equal(value, 'PDF 第 3 页\n原文：<b>Original observation</b>\n说明：Reader interpretation\n来源：Figure 2\n批注：source-note-7');
  assert.equal(graph.evidenceSummary({ page: null, note: 'No known page' }), '说明：No known page');
  assert.equal(graph.evidenceSummary({ page: 0 }), '尚未补充原文依据');
  assert.equal(graph.evidenceSummary(), '尚未补充原文依据');
});
