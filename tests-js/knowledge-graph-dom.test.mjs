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
  assert.equal(initial, 1, 'initial graph fits every node instead of clipping the focused paper');
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

test('paper focus highlights its nodes in the global graph; clearing focus and citation mode have visible effects', { skip: !JSDOM }, async () => {
  const dom = new JSDOM('<div id="graph"></div>', {runScripts:'outside-only',url:'http://synthetic.invalid/'});
  const {window}=dom,root=window.document.getElementById('graph'),calls=[];
  window.eval(source);
  const nodes=[{id:'a',paper_id:'a',type:'paper',label:'Paper A'},{id:'b',paper_id:'b',type:'paper',label:'Paper B'},{id:'author',paper_id:'a',type:'author',label:'Synthetic Author'},{id:'c',paper_id:'c',type:'paper',label:'Paper C'}];
  const edges=[{id:'author-edge',paper_id:'a',source:'a',target:'author',relation:'authored_by'},{id:'citation',paper_id:'a',source:'a',target:'b',relation:'cites'}];
  const ui=window.PaperKnowledgeGraph.create({root,scope:'library',getPaper:()=>null,api:async(action,args)=>{if(action==='graph_statistics')return statistics();calls.push(plain(args));return {nodes,edges,scope:{paper_count:3,total_papers:3}};}});
  await ui.focusPaper('a');
  assert.equal(calls[0].focus_id,'a');
  assert.equal(root.querySelectorAll('.kg-node.is-muted').length,1);
  assert.equal(root.querySelectorAll('.kg-node.is-highlighted').length,3);
  assert.equal(root.querySelector('[data-kg="reset"]').disabled,false);
  root.querySelector('[data-kg="reset"]').click();
  assert.equal(root.querySelectorAll('.kg-node.is-muted').length,0);
  assert.equal(root.querySelector('[data-kg="reset"]').disabled,true);
  const mode=root.querySelector('[data-kg="mode"]');mode.value='citations';mode.dispatchEvent(new window.Event('change'));
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(calls.at(-1).view,'citations');assert.equal(root.querySelectorAll('.kg-node').length,3);assert.equal(root.querySelectorAll('.kg-edge').length,1);
  assert.equal(root.querySelectorAll('.kg-relation').length,1);assert.match(root.querySelector('.kg-relation').textContent,/引用/);
  dom.window.close();
});

test('paper graph exposes explicit full-text analysis and passes its identity to the global view', {skip:!JSDOM}, async()=>{
  const dom=new JSDOM('<div id="graph"></div>',{runScripts:'outside-only'}),{window}=dom,root=window.document.getElementById('graph');window.eval(source);
  let analyzed=0,opened;
  const ui=window.PaperKnowledgeGraph.create({root,getPaper:()=>({id:'paper-a'}),api:async()=>({nodes:[],edges:[]}),onAnalyze:async()=>{analyzed++;},onOpenLibrary:value=>{opened=plain(value);}});
  await ui.load();root.querySelector('[data-kg="analyze"]').click();await new Promise(resolve=>setImmediate(resolve));assert.equal(analyzed,1);
  [...root.querySelectorAll('button')].find(b=>b.textContent==='查看全库图谱').click();assert.deepEqual(opened,{focus_id:'paper-a'});
  dom.window.close();
});

test('explicit PDF bibliography extraction opens a nonempty citation graph and external targets retain evidence navigation', {skip:!JSDOM}, async()=>{
  const dom=new JSDOM('<div id="graph"></div>',{runScripts:'outside-only',url:'http://synthetic.invalid/'});
  const {window}=dom,root=window.document.getElementById('graph'),calls=[],opened=[],pages=[];
  window.eval(source); let extracted=false;
  const paper={id:'paper',title:'Synthetic source',pdf:true};
  const ui=window.PaperKnowledgeGraph.create({root,getPaper:()=>paper,openPaper:id=>opened.push(id),navigatePage:page=>pages.push(page),toast(){},api:async(action,args)=>{
    calls.push({action,...plain(args)});
    if(action==='graph_references_get')return extracted?{parser_version:2,stale:false}:null;
    if(action==='graph_references_extract'){extracted=true;return {count:1,graph_count:1,reference_pages:[2]};}
    return {nodes:[{id:'paper',type:'paper',label:'Source'},...(extracted?[{id:'reference:one',paper_id:'paper',type:'paper',label:'[1] Synthetic cited study.',external_reference:true,provenance:'pdf-reference',evidence:{page:2,quote:'[1] Synthetic cited study.'}}]:[])],edges:extracted?[{id:'cite1',source:'paper',target:'reference:one',relation:'cites',provenance:'pdf-reference',evidence:{page:2,quote:'[1] Synthetic cited study.'}}]:[],scope:{}};
  }});
  await ui.load(paper);root.querySelector('[data-kg="extract-references"]').click();
  for(let i=0;i<6;i++)await new Promise(resolve=>setImmediate(resolve));
  assert.equal(calls.filter(c=>c.action==='graph_references_extract').length,1);
  assert.equal(calls.at(-1).view,'citations');
  assert.equal(root.querySelectorAll('.kg-edge').length,1);
  root.querySelector('[data-node-id="reference:one"]').dispatchEvent(new window.KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
  const inspector=root.querySelector('.kg-inspector');
  assert.match(inspector.textContent,/来自 PDF 参考文献原文/);assert.match(inspector.textContent,/尚未匹配库内条目/);
  assert.equal([...inspector.querySelectorAll('button')].some(b=>b.textContent==='打开文献'),false);
  [...inspector.querySelectorAll('button')].find(b=>b.textContent==='返回 PDF 第 2 页').click();assert.deepEqual(pages,[2]);assert.deepEqual(opened,[]);
  dom.window.close();
});

const settle = async () => { for(let i=0;i<4;i++)await new Promise(resolve=>setImmediate(resolve)); };
function readingFixture(window){
 const paper={id:'paper-full',title:'Synthetic complete analysis',pdf:true},calls=[],pages=[];
 const totals={request_id:'saved-snapshot',total_answers:25,valid_answers:24,invalid_answers:1,questions:[{id:'q_method',title:'研究方法',total:25,valid:24,invalid:1}]};
 const question={id:'question:q_method',type:'question',label:'研究方法',description:'25 项判断',provenance:'analysis-group',reading_target:{question_id:'q_method'}};
 const response=args=>{
  if(args.answer_id)return {reading:{...totals,level:'answer',question_id:args.question_id,answer_id:args.answer_id,batch_index:args.batch_index,limitations:[{message:'此项关系类型未确定，不猜测连线。'}]},nodes:[{id:'answer:24',type:'claim',label:'最后一项完整判断',description:'完整保留：合成方法的条件和限制。',provenance:'analysis-answer'},{id:'evidence:last',type:'evidence',label:'原文证据',provenance:'analysis-answer',evidence:{page:9,quote:'Synthetic final evidence.'}}],edges:[{id:'support',source:'evidence:last',target:'answer:24',relation:'supports',provenance:'analysis-answer',evidence:{page:9,quote:'Synthetic final evidence.'}}]};
  if(args.question_id){const offset=args.offset||0,entries=Array.from({length:Math.min(12,25-offset)},(_,i)=>({id:`answer:${offset+i}`,type:'claim',label:`第 ${offset+i+1} 项`,description:`第 ${offset+i+1} 项完整判断与条件，不会被节点缩略文字隐藏。`,valid:offset+i!==24,neutral:offset+i===0,provenance:'analysis-answer',evidence:{page:9},reading_target:{question_id:args.question_id,answer_id:`answer-${offset+i}`,batch_index:1}}));return {reading:{...totals,level:'question',question_id:args.question_id,offset,limit:12,total:25,next_offset:offset+12<25?offset+12:null,previous_offset:offset?Math.max(0,offset-12):null},nodes:[question,...entries],edges:entries.map((entry,i)=>({id:`edge-${i}`,source:question.id,target:entry.id,relation:'contains'}))};}
  return {reading:{...totals,level:'overview'},nodes:[{id:paper.id,type:'paper',label:paper.title},question],edges:[{id:'group',source:paper.id,target:question.id,relation:'contains'}]};
 };
 return {paper,calls,pages,response,api:async(action,args)=>{calls.push({action,...plain(args)});assert.equal(action,'paper_analysis_graph');return response(args);}};
}

test('full reading graph browses every judgment through bounded pages and keeps snapshot, evidence and return navigation', {skip:!JSDOM},async()=>{
 const dom=new JSDOM('<div id="graph"></div>',{runScripts:'outside-only'}),{window}=dom,root=window.document.getElementById('graph');window.eval(source);
 const f=readingFixture(window),ui=window.PaperKnowledgeGraph.create({root,getPaper:()=>f.paper,api:f.api,navigatePage:page=>f.pages.push(page)});
 const canvas=root.querySelector('.kg-canvas');Object.defineProperties(canvas,{clientWidth:{value:1040},clientHeight:{get(){return canvas.classList.contains('is-reading-detail')?300:420;}}});
 await ui.load();assert.equal(root.querySelector('[data-kg="mode"]').value,'reading');assert.match(root.querySelector('[data-kg="status"]').textContent,/全文 25 项判断/);
 assert.equal(root.querySelector('[data-kg="add-node"]').hidden,true);assert.equal(root.querySelector('[data-kg="filter"]').parentElement.hidden,true);assert.equal(root.querySelector('[data-node-id="question:q_method"]').classList.contains('is-ai-draft'),true);
 root.querySelector('[data-question-id="q_method"]').click();await settle();
 assert.equal(root.querySelectorAll('.kg-reading-answer').length,12);assert.match(root.querySelector('.kg-reading-answer').textContent,/完整判断与条件/);assert.match(root.querySelector('.kg-reading-answer').textContent,/未报告／不适用/);
 assert.equal(f.calls.at(-1).request_id,'saved-snapshot');
 const button=text=>[...root.querySelectorAll('button')].find(b=>b.textContent===text);
 button('下一页判断').click();await settle();assert.equal(f.calls.at(-1).offset,12);
 button('下一页判断').click();await settle();assert.equal(f.calls.at(-1).offset,24);assert.equal(root.querySelectorAll('.kg-reading-answer').length,1);assert.equal(button('下一页判断').disabled,true);assert.match(root.querySelector('.kg-reading-answer').textContent,/未通过原文／结构检查/);
 root.querySelector('.kg-reading-answer button').click();await settle();assert.equal(f.calls.at(-1).answer_id,'answer-24');assert.equal(f.calls.at(-1).batch_index,1);
 assert.equal(root.querySelectorAll('.kg-node').length,2);assert.equal(canvas.classList.contains('is-reading-detail'),true);const detailView=ui.getViewport();assert.ok(detailView.width>=canvas.clientWidth&&detailView.height>=canvas.clientHeight,'fit must not enlarge small detail labels beyond their normal SVG size');assert.equal(detailView.zoom,1);const positions=[...canvas.querySelectorAll('.kg-node')].map(n=>n.getAttribute('transform'));assert.deepEqual(positions,['translate(430,138)','translate(610,138)']);assert.match(root.querySelector('.kg-reading-source').textContent,/Synthetic final evidence/);assert.match(root.querySelector('.kg-reading-list').textContent,/不猜测连线/);
 button('返回 PDF 第 9 页').click();assert.deepEqual(f.pages,[9]);
 button('研究方法').click();await settle();assert.equal(f.calls.at(-1).offset,24);assert.equal(f.calls.at(-1).answer_id,undefined);
 button('问题总览').click();await settle();assert.equal(f.calls.at(-1).question_id,undefined);assert.equal(f.calls.at(-1).request_id,'saved-snapshot');
 button('刷新全文图谱').click();await settle();assert.equal(f.calls.at(-1).request_id,undefined);
 dom.window.close();
});

test('full graph protects paper and mode switches from stale requests and offers a bounded retry', {skip:!JSDOM},async()=>{
 const dom=new JSDOM('<div id="graph"></div>',{runScripts:'outside-only'}),{window}=dom,root=window.document.getElementById('graph');window.eval(source);
 const f=readingFixture(window);let current=f.paper,release,fail=false,hold=false;
 const ui=window.PaperKnowledgeGraph.create({root,getPaper:()=>current,api:async(action,args)=>{f.calls.push({action,...plain(args)});if(action==='graph')return {nodes:[{id:'reference',type:'paper',label:'Citation view'}],edges:[]};if(hold)await new Promise(resolve=>release=resolve);if(fail)throw new Error('Synthetic snapshot unavailable');return {...f.response(args),reading:{...f.response(args).reading,request_id:args.id==='paper-b'?'snapshot-b':'saved-snapshot'}};}});
 await ui.load();hold=true;root.querySelector('[data-question-id="q_method"]').click();await settle();
 const mode=root.querySelector('[data-kg="mode"]');mode.value='citations';mode.dispatchEvent(new window.Event('change'));await settle();release();hold=false;await settle();assert.match(root.querySelector('.kg-node').textContent,/Citation/);assert.equal(root.querySelector('.kg-reading-nav').hidden,true);
 await ui.showReading();await settle();assert.equal(mode.value,'reading');assert.equal(f.calls.at(-1).request_id,undefined);
 hold=true;root.querySelector('[data-question-id="q_method"]').click();await settle();const releaseOld=release;current={id:'paper-b',pdf:true};hold=false;await ui.load(current);releaseOld();await settle();assert.equal(f.calls.at(-1).id,'paper-b');assert.equal(f.calls.at(-1).request_id,undefined);assert.match(root.querySelector('[data-kg="status"]').textContent,/全文 25 项判断/);
 fail=true;await ui.reload();assert.match(root.querySelector('[data-kg="status"]').textContent,/读取失败/);const retry=[...root.querySelectorAll('button')].find(b=>b.textContent==='重试读取图谱');assert.equal(retry.hidden,false);fail=false;retry.click();await settle();assert.equal(retry.hidden,true);assert.match(root.querySelector('[data-kg="status"]').textContent,/全文 25 项判断/);
 dom.window.close();
});

test('source-free judgments and inferred attribution stay readable without invented evidence', {skip:!JSDOM},async()=>{
 const dom=new JSDOM('<div id="graph"></div>',{runScripts:'outside-only'}),{window}=dom,root=window.document.getElementById('graph');window.eval(source);
 const f=readingFixture(window),text='这是一条完整的中性判断，不能因为没有肯定证据就把判断正文隐藏。';
 const api=async(_action,args)=>{if(args.answer_id)return {nodes:[{id:'neutral',type:'question',label:text}],edges:[],reading:{level:'answer',request_id:'saved-snapshot',question_id:'q_method',questions:[],total_answers:1,valid_answers:1,answer:{judgment:text,source_status:'inferred'},limitations:['未报告，不生成肯定事实。']}};return f.response(args)};
 const ui=window.PaperKnowledgeGraph.create({root,getPaper:()=>f.paper,api});await ui.load();root.querySelector('[data-question-id="q_method"]').click();await settle();root.querySelector('.kg-reading-answer button').click();await settle();
 assert.ok(root.querySelector('.kg-reading-list').textContent.includes(text));assert.match(root.querySelector('.kg-reading-list').textContent,/尚非作者报告事实/);assert.equal(root.querySelectorAll('.kg-reading-source').length,0);dom.window.close();
});


test('opening citation mode automatically builds missing author-year references and reuses a current snapshot', {skip:!JSDOM}, async()=>{
  const dom=new JSDOM('<div id="graph"></div>',{runScripts:'outside-only',url:'http://synthetic.invalid/'}),w=dom.window,root=w.document.getElementById('graph');w.eval(source);
  let stored=false;const calls=[],paper={id:'paper',title:'Synthetic',pdf:true};const ui=w.PaperKnowledgeGraph.create({root,getPaper:()=>paper,toast(){},api:async(action,args)=>{calls.push(action);if(action==='graph_references_get')return stored?{parser_version:2,stale:false}:null;if(action==='graph_references_extract'){stored=true;return {count:2,graph_count:2,reference_pages:[2]};}return {nodes:[{id:'paper',type:'paper',label:'Source'},{id:'ref',type:'paper',label:'Adams, A., 2020. A synthetic study.'}],edges:stored?[{id:'c1',source:'paper',target:'ref',relation:'cites',evidence:{page:2}}]:[],scope:{}};}});
  await ui.load(paper);const mode=root.querySelector('[data-kg="mode"]');mode.value='citations';mode.dispatchEvent(new w.Event('change'));for(let i=0;i<6;i++)await new Promise(r=>setImmediate(r));assert.equal(calls.filter(a=>a==='graph_references_extract').length,1);assert.equal(root.querySelectorAll('.kg-edge').length,1);await ui.reload();assert.equal(calls.filter(a=>a==='graph_references_extract').length,1);dom.window.close();
});
