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
  const scope={libraryScope:true,revision:0,paperId:null,selected:null,edgePage:0,graph:{},getPaper:()=>null,closeEditor(){},render(){},status:value=>messages.push(value),catalogPrevious:{},catalogNext:{},
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
