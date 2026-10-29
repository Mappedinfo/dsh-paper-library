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

test('global graph loads a bounded catalog window without requiring an active paper', async () => {
  const text=await readFile(new URL('../web/knowledge-graph.js',import.meta.url),'utf8');
  const load=text.slice(text.indexOf('    async function load('),text.indexOf('    function closeEditor('));
  const calls=[],messages=[];
  const scope={libraryScope:true,revision:0,paperId:null,selected:null,edgePage:0,graph:{},getPaper:()=>null,closeEditor(){},render(){},loadStatistics(){},status:value=>messages.push(value),catalogPrevious:{},catalogNext:{},
    api:async(action,args)=>{calls.push({action,...args});return {nodes:[],edges:[],scope:{paper_count:5,total_papers:45,previous_offset:0,next_offset:null},truncated:true};}};
  vm.createContext(scope);vm.runInContext(load,scope);await scope.load(null,40);
  assert.deepEqual(calls,[{action:'graph',offset:40,limit:100}]);
  assert.equal(scope.catalogPrevious.disabled,false);assert.equal(scope.catalogNext.disabled,true);
  assert.match(messages.at(-1),/41–45 \/ 45/);
});

test('late paper graph results cannot replace another paper', async () => {
  const text=await readFile(new URL('../web/knowledge-graph.js',import.meta.url),'utf8');
  const load=text.slice(text.indexOf('    async function load('),text.indexOf('    function closeEditor('));
  let resolve;const response=new Promise(yes=>resolve=yes),current={id:'first'};
  const scope={libraryScope:false,revision:0,paperId:null,selected:null,edgePage:0,graph:{},getPaper:()=>current,closeEditor(){},render(){},status(){},catalogPrevious:{},catalogNext:{},api:()=>response};
  vm.createContext(scope);vm.runInContext(load,scope);const pending=scope.load(current);current.id='second';resolve({nodes:[{id:'first'}],edges:[]});await pending;
  assert.equal(scope.graph.nodes.length,0);
});

test('graph viewport keeps zoom anchors, accessible pan bounds and its aspect ratio through resizing', () => {
  const viewport = graph.createViewport({ width: 1000, height: 1000 }, { width: 800, height: 400 });
  assert.deepEqual(JSON.parse(JSON.stringify(viewport.snapshot())), { x: -500, y: 0, width: 2000, height: 1000, zoom: 1 });
  viewport.setZoom(2); const before = viewport.snapshot(); viewport.setZoom(4, { x: 0, y: 0 });
  assert.equal(viewport.snapshot().x, before.x); assert.equal(viewport.snapshot().y, before.y);
  viewport.pan(1e10, -1e10); const bounded = viewport.snapshot();
  assert.ok(bounded.x < 1500 && bounded.y > -1500);
  viewport.setZoom(100); assert.equal(viewport.snapshot().zoom, 8);
  viewport.pan(1e10, 1e10); const edge = viewport.snapshot(); assert.ok(edge.x < 1000 && edge.y < 1000, 'The graph bounds cannot be panned fully outside the viewport');
  viewport.setZoom(-100); assert.equal(viewport.snapshot().zoom, .5);
  viewport.setZoom(2, { x: NaN, y: Infinity }); assert.ok(Object.values(viewport.snapshot()).every(Number.isFinite));
  viewport.resize({ width: 1200, height: 800 }); assert.equal(viewport.snapshot().width / viewport.snapshot().height, 1.5);
  viewport.fit(); assert.equal(viewport.snapshot().zoom, 1);
  const fitted = JSON.parse(JSON.stringify(viewport.snapshot())); viewport.pan(NaN, 2); viewport.setZoom(Infinity);
  assert.deepEqual(JSON.parse(JSON.stringify(viewport.snapshot())), fitted);
});

const emptyStatistics = total => ({ scope: 'active-library', total_papers: total, years: { known: 0, missing: total, items: [], other_count: 0 }, citations: { known_papers: 0, missing_papers: total, sources: ['crossref', 'openalex', 'semantic-scholar'].map(id => ({ id, label: id, known: 0, missing: total, buckets: ['0', '1–9', '10–49', '50–99', '100–499', '500+'].map(label => ({ label, count: 0 })) })) } });
test('statistics keep unknown years and citation snapshots separate instead of zero-filling missing metadata', () => {
  const value = emptyStatistics(47); assert.equal(graph.statisticsOf(value), value);
  value.years = { known: 45, missing: 2, items: [{ year: 2020, count: 45 }], other_count: 0 };
  value.citations.known_papers = 1; value.citations.missing_papers = 46;
  for (const source of value.citations.sources.slice(0, 2)) { source.known = 1; source.missing = 46; source.buckets[0].count = 1; }
  assert.equal(graph.statisticsOf(value).citations.known_papers, 1, 'Two providers may describe the same paper');
  const malformed = structuredClone(value); malformed.years.missing = 0; assert.throws(() => graph.statisticsOf(malformed), /不完整/);
  const inflated = structuredClone(value); inflated.citations.sources[0].buckets[0].count = 2; assert.throws(() => graph.statisticsOf(inflated), /不完整/);
  const bool = structuredClone(value); bool.total_papers = true; assert.throws(() => graph.statisticsOf(bool), /不完整/);
  const excess = emptyStatistics(0); excess.years.items = Array.from({ length: 201 }, (_, i) => ({ year: 1800 + i, count: 1 })); assert.throws(() => graph.statisticsOf(excess), /不完整/);
});

test('statistics requests share work, reject stale snapshots and retain last data on refresh failure', async () => {
  const text = await readFile(new URL('../web/knowledge-graph.js', import.meta.url), 'utf8'), start = text.indexOf('    async function loadStatistics('), end = text.indexOf('    function evidenceContent(', start);
  const requests = [], messages = [], busy = [];
  const scope = vm.createContext({ libraryScope: true, statistics: null, statisticsFlight: null, statisticsRevision: 0, statisticsOf: graph.statisticsOf,
    statisticsPanel: { setAttribute: (key, value) => busy.push([key, value]) }, renderStatistics: (...args) => messages.push(args),
    api: () => new Promise((resolve, reject) => requests.push({ resolve, reject })) });
  vm.runInContext(text.slice(start, end), scope);
  const first = scope.loadStatistics(), duplicate = scope.loadStatistics(); assert.equal(requests.length, 1);
  scope.statisticsRevision++; scope.statisticsFlight = null;
  const next = scope.loadStatistics(); requests[0].resolve(emptyStatistics(2)); await first; await duplicate; assert.equal(scope.statistics, null);
  requests[1].resolve(emptyStatistics(47)); await next; assert.equal(scope.statistics.total_papers, 47);
  const retry = scope.loadStatistics(true); requests[2].reject(new Error('Synthetic offline metadata')); await retry;
  assert.equal(scope.statistics.total_papers, 47); assert.match(messages.at(-1)[0], /保留上次统计/); assert.equal(messages.at(-1)[1], true);
  assert.deepEqual(busy.at(-1), ['aria-busy', 'false']);
});

test('diagram labels keep a conservative 144px width across Chinese, Latin and wide glyphs', () => {
  for (const full of ['这是用于检查相邻图谱节点名称是否重叠的合成中文标签', 'Synthetic representation learning comparison', 'WWWWWWWWWWWWWWWWWWWW', '𝐀𝐁𝐂𝐃𝐄𝐅𝐆𝐇𝐈𝐉𝐊𝐋𝐌', '城市 A01 与跨语言 evidence']) {
    const label = graph.shortLabel(full);
    assert.ok(graph.labelWidth(label) <= 144, `${label} remains inside the label budget`);
    assert.ok(label.endsWith('…')); assert.ok(full.startsWith(label.slice(0, -1)), 'Truncation never reorders or invents the supplied name');
  }
  assert.equal(graph.shortLabel('合成标题'), '合成标题');
  assert.equal(graph.shortLabel('Short title'), 'Short title');
  assert.equal(graph.shortLabel('e\u0301'), 'e\u0301', 'Combining marks do not consume a second character width');
});
