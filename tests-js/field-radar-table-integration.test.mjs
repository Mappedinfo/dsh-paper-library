import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createRequire} from 'node:module';
import {createFieldRadarExporter} from '../src/harness/field-radar-export.mjs';
import {parseRadarAnalysis,radarAnalysisPrompt} from '../src/harness/field-radar-analysis.mjs';
import {validateFieldRadarDocument} from '../src/harness/field-radar.mjs';
import {FIELD_RADAR_TOOL_SPECS,fieldRadarToolRequest,handleFieldRadarTool} from '../src/harness/field-radar-tools.mjs';
import {createFetchHandler} from '../src/http.mjs';
const fact=value=>({value,status:'verified',source_ids:['s1'],evidence:'Synthetic explicit evidence.'});
const document=()=>({schema_version:1,topic:{id:'synthetic',title:'Synthetic OD comparison',question:'Can inference omit target-area OD?'},sources:[{id:'s1',title:'Synthetic source',url:'https://example.org/synthetic',evidence_level:'synthetic'}],papers:[{id:'p1',title:'Synthetic full paper title',year:2025,source_ids:['s1'],task:'generation',method:'Synthetic method',comparison:{short_name:fact('SYN'),task_output:fact('Generate inter-region OD flows'),datasets:[{name:'Synthetic data',status:'verified',source_ids:['s1'],openness:{...fact('open')}}],od_generation:{output_is_od:fact(true),target_history_at_inference:fact(false),training_history:fact(true)}}}],scholars:[],claims:[]});
const record=()=>({document:document(),revision:'revision-1',updated_at:'2026-11-10'});
const analysis=()=>({status:'complete',topic_id:'synthetic',topic_revision:'revision-1',draft:{paper_comparisons:[{paper_id:'p1',comparison:document().papers[0].comparison}]}});
async function fixture(t){const library=await mkdtemp(join(tmpdir(),'radar-table-synthetic-'));t.after(()=>rm(library,{recursive:true,force:true}));const radar={get:async()=>record()};const exporter=createFieldRadarExporter({library,radar,getAnalysis:async()=>analysis()});return {library,radar,exporter};}
test('table preview is read-only and all persisted formats share evidence, revision and integrity',async t=>{const f=await fixture(t);const preview=await f.exporter.tablePreview({id:'synthetic',expected_revision:'revision-1'});assert.equal(preview.rows[0].values.length,7);assert.match(preview.html,/<table/);assert.match(preview.tsv,/SYN/);assert.equal(preview.topic_revision,'revision-1');assert.equal(preview.path,undefined);for(const format of ['html','tsv','csv','markdown']){const r=await f.exporter.tableExport({id:'synthetic',expected_revision:'revision-1',format});assert.equal(r.count,1);assert.equal(r.view,'literature-table');const loaded=await f.exporter.get(r.id,format);assert.ok(loaded.bytes.length);const side=JSON.parse(await readFile(r.path+'.json','utf8'));assert.equal(side.rows[0].values.length,7);assert.equal(side.records[0].comparison.od_generation.training_history.value,true);assert.deepEqual(await f.exporter.tableExport({id:'synthetic',format}),r);await writeFile(r.path,'tamper');await assert.rejects(f.exporter.get(r.id,format),/integrity/);}});
test('saved AI table is opt-in, current-version only, and never upgrades assertions to verified',async t=>{const f=await fixture(t);assert.equal((await f.exporter.tablePreview({id:'synthetic'})).rows[0].od_generation.value,'yes');const ai=await f.exporter.tablePreview({id:'synthetic',analysis_request_id:'request-1'});assert.equal(ai.rows[0].od_generation.value,'unknown');assert.match(ai.tsv,/待核/);assert.equal(ai.analysis_request_id,'request-1');for(const value of [{...analysis(),topic_revision:'stale'},{...analysis(),status:'pending'},{...analysis(),topic_id:'other'},{...analysis(),draft:{}}]){const exporter=createFieldRadarExporter({library:f.library,radar:f.radar,getAnalysis:async()=>value});await assert.rejects(exporter.tablePreview({id:'synthetic',analysis_request_id:'request-1'}),e=>e.status===409);}await assert.rejects(f.exporter.tablePreview({id:'synthetic',expected_revision:'old'}),e=>e.status===409);});
test('native table routes are closed, preview read-only, export under mutation approval',async t=>{const f=await fixture(t);for(const suffix of ['table','table_export']){const spec=FIELD_RADAR_TOOL_SPECS.find(s=>s.name==='library_field_radar_'+suffix);assert.equal(Boolean(spec.mutate),suffix==='table_export');const request=fieldRadarToolRequest(spec,{input_json:'{"id":"synthetic"}'});const result=await handleFieldRadarTool({fieldRadarExport:f.exporter},request);assert.equal(result.count,1);assert.throws(()=>fieldRadarToolRequest(spec,{input_json:'{"id":"synthetic","path":"/private"}'}));}});
test('HTTP exposes controlled table previews and download URLs, never local paths',async t=>{const f=await fixture(t),handler=createFetchHandler({library:f.library,fieldRadar:f.radar,fieldRadarExport:f.exporter});const call=async input=>(await handler(new Request('http://localhost/api',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input)}))).json();const p=await call({action:'field_radar_table',id:'synthetic'});assert.equal(p.ok,true);assert.equal(p.result.path,undefined);for(const format of ['html','tsv','csv','markdown']){const response=await call({action:'field_radar_table_export',id:'synthetic',format});assert.equal(response.ok,true,JSON.stringify(response));assert.equal(response.result.path,undefined);const url='http://localhost'+response.result.download_url;const download=await handler(new Request(url));assert.equal(download.status,200);assert.match(download.headers.get('content-disposition'),/^attachment/);assert.match(download.headers.get('content-security-policy'),/sandbox/);assert.equal((await handler(new Request(url,{headers:{origin:'https://evil.example'}}))).status,403);}});
test('analysis parser accepts optional sourced comparisons but forces review and rejects invented identities',()=>{const value={title:'Synthetic draft',summary:'Limited evidence',concepts:[],distinctions:[],research_lines:[],relations:[],gaps:[],paper_comparisons:analysis().draft.paper_comparisons};const parsed=parseRadarAnalysis(JSON.stringify(value),document());assert.equal(parsed.paper_comparisons[0].comparison.od_generation.output_is_od.status,'needs_review');assert.equal(parsed.paper_comparisons[0].comparison.inference,true);for(const rows of [[{paper_id:'invented',comparison:{}}],[...value.paper_comparisons,...value.paper_comparisons],[{paper_id:'p1',comparison:{short_name:{...fact('SYN'),source_ids:['invented']}}}]])assert.throws(()=>parseRadarAnalysis(JSON.stringify({...value,paper_comparisons:rows}),document()));});
test('prompt preserves structured inputs and asks for inference-stage evidence rather than name heuristics',()=>{const doc=document();doc.papers[0].datasets=[{name:'Kept dataset'}];doc.papers[0].task_axes={output:'Kept output'};doc.papers[0].local_paper_id='private-native-id';const prompt=radarAnalysisPrompt(doc);for(const word of ['Kept dataset','Kept output','target_history_at_inference','paper_comparisons','评估真值不等于推理输入'])assert.ok(prompt.includes(word));assert.ok(!prompt.includes('private-native-id'));});
test('topic import rejects invalid comparison structure and dangling cell evidence',()=>{const doc=document();assert.equal(validateFieldRadarDocument(doc).papers[0].comparison.short_name.value,'SYN');doc.papers[0].comparison.method={...fact('X'),source_ids:['invented']};assert.throws(()=>validateFieldRadarDocument(doc));});
test('UI uses safe text cells, explicit scope invalidation, rich clipboard and explicit full-result export',async()=>{const source=await readFile(new URL('../web/field-radar.js',import.meta.url),'utf8');for(const text of ["['table', '文献对照表']","navigator.clipboard.write([new ClipboardItem","'text/html'","'text/plain'","scope!==tableScope()","result.rows","row.values","make('td',value)","tableSize='all'","导出全部筛选结果","column_filters","sort_by"])assert.ok(source.includes(text),text);assert.ok(!/innerHTML\s*=/.test(source));});

const require = createRequire(import.meta.url);
let JSDOM;
try { ({JSDOM} = require(process.env.JSDOM_MODULE || 'jsdom')); } catch {}
test('literature table auto-loads current scope, expands evidence, and can retry a failed page', {skip:!JSDOM}, async t=>{
  const f=await fixture(t);
  const preview=await f.exporter.tablePreview({id:'synthetic'});
  const dom=new JSDOM('<header class="topbar-actions"></header><main class="workspace"></main>',{runScripts:'outside-only',url:'http://synthetic.invalid'});
  const w=dom.window;
  t.after(()=>dom.window.close());
  for(const name of ['field-radar-data.js','field-radar.js'])w.eval(await readFile(new URL('../web/'+name,import.meta.url),'utf8'));
  const timers=new Map(), calls=[];
  let sequence=0, resolveFirst, failPage=true;
  w.setTimeout=fn=>{timers.set(++sequence,fn);return sequence;};
  w.clearTimeout=id=>timers.delete(id);
  const nextLoad=()=>{assert.equal(timers.size,1);const [id,fn]=timers.entries().next().value;timers.delete(id);return fn();};
  const ui=w.PaperFieldRadar.create({api:async(action,args,options)=>{
    if(action==='field_radar_list')return {topics:[{topic:document().topic}]};
    if(action==='field_radar_get')return record();
    assert.equal(action,'field_radar_table');
    calls.push({args,signal:options.signal});
    if(calls.length===1)return new Promise(resolve=>{resolveFirst=resolve;});
    if(args.offset&&failPage)throw Error('Synthetic read failure');
    return {...preview,total:21,rows:preview.rows.map(row=>({...row,values:[args.filters.query||'Initial',...row.values.slice(1)]}))};
  }});
  await ui.open();
  w.document.querySelector('#field-radar-tab-table').click();
  assert.equal(w.document.querySelector('#field-radar-table-prepare'),null);
  const first=nextLoad();
  const query=w.document.querySelector('#field-radar-query');
  for(const value of ['intermediate','current filter']){query.value=value;query.dispatchEvent(new w.Event('input'));}
  assert.equal(calls[0].signal.aborted,true);
  await nextLoad();
  resolveFirst(preview);await first;
  assert.deepEqual(calls.map(call=>call.args.filters.query),['','current filter']);
  const content=w.document.querySelector('#field-radar-content');
  assert.equal(content.querySelector('tbody td').textContent,'current filter');
  assert.equal(content.querySelector('.radar-literature-evidence details').open,true);
  assert.equal(content.querySelector('.radar-sources').open,true);
  assert.match(content.querySelector('.radar-literature-evidence').textContent,/Synthetic source/);
  const pageSize=w.document.querySelector('#field-radar-table-size');pageSize.value='20';pageSize.dispatchEvent(new w.Event('change'));await nextLoad();
  content.querySelector('.radar-pager button:last-child').click();
  await nextLoad();
  assert.equal(calls.at(-1).args.offset,20);
  assert.equal(timers.size,0);
  assert.match(content.textContent,/Synthetic read failure/);
  failPage=false;
  [...content.querySelectorAll('button')].find(b=>b.textContent==='重试读取').click();
  await nextLoad();
  assert.ok(content.querySelector('.radar-literature-table'));
  ui.dispose();
});

test('clipboard copies only the seven-column grid; full exports retain evidence notes',async t=>{const f=await fixture(t),r=await f.exporter.tablePreview({id:'synthetic'});assert.ok(r.clipboard_html.startsWith('<table>'));assert.ok(!r.clipboard_html.includes('<h1>'));assert.equal(r.clipboard_tsv.split('\r\n').length,2);assert.ok(r.tsv.split('\r\n').length>2);});
test('legacy singular dataset and explicit output fields remain visible in reused tables',async t=>{const f=await fixture(t),r=record();delete r.document.papers[0].comparison;r.document.papers[0].dataset='Legacy dataset';r.document.papers[0].task_axes={output:'Explicit synthetic flow matrix'};const exporter=createFieldRadarExporter({library:f.library,radar:{get:async()=>r}});const table=await exporter.tablePreview({id:'synthetic'});assert.match(table.tsv,/Legacy dataset/);assert.match(table.tsv,/Explicit synthetic flow matrix/);});

test('derived table budget rejects repeated large shared group labels instead of allocating an unbounded response',async t=>{const f=await fixture(t),r=record();r.document.papers=Array.from({length:30},(_,i)=>({...r.document.papers[0],id:'p'+i}));r.document.research_groups=[{id:'g1',name:'G'.repeat(100000),status:'verified',source_ids:['s1'],paper_ids:r.document.papers.map(p=>p.id)}];const exporter=createFieldRadarExporter({library:f.library,radar:{get:async()=>r}});await assert.rejects(exporter.tablePreview({id:'synthetic'}),e=>e.status===413);});


test('native and HTTP full exports preserve all filtered rows, column settings and sorted evidence sidecars',async t=>{
  const f=await fixture(t),r=record();r.document.papers=Array.from({length:105},(_,i)=>({...r.document.papers[0],id:'p'+i,year:1900+i,comparison:{...r.document.papers[0].comparison,short_name:fact('SYN '+i),research_group:fact(i%2?'Odd':'Even')}}));
  const exporter=createFieldRadarExporter({library:f.library,radar:{get:async()=>r}}),handler=createFetchHandler({library:f.library,fieldRadarExport:exporter});
  for(const format of ['html','tsv','csv','markdown']){
    const spec=FIELD_RADAR_TOOL_SPECS.find(s=>s.name==='library_field_radar_table_export'),args={id:'synthetic',all:true,format,column_filters:{research_group:'even'},sort_by:'year',sort_direction:'desc'};
    const request=fieldRadarToolRequest(spec,{input_json:JSON.stringify(args)}),receipt=await handleFieldRadarTool({fieldRadarExport:exporter},request);assert.equal(receipt.count,53);assert.equal(receipt.total,53);assert.equal(receipt.has_more,false);
    const side=JSON.parse(await readFile(receipt.path+'.json','utf8'));assert.equal(side.records[0].id,'p104');assert.equal(side.records.at(-1).id,'p0');assert.equal(side.rows.length,53);assert.deepEqual(side.export_settings.column_filters,args.column_filters);assert.equal(side.export_settings.all,true);
    const response=await handler(new Request('http://localhost/api',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'field_radar_table',...args})})),body=await response.json();assert.equal(body.ok,true);assert.equal(body.result.count,53);assert.equal(body.result.records[0].id,'p104');
  }
});
test('one AI analysis still has a 20-paper budget while saved tables show more',()=>{
  const doc=document();doc.papers=Array.from({length:21},(_,i)=>({...doc.papers[0],id:'p'+i}));const draft={title:'Synthetic',summary:'Synthetic',concepts:[],distinctions:[],research_lines:[],relations:[],gaps:[],paper_comparisons:doc.papers.map(p=>({paper_id:p.id,comparison:{}}))};assert.throws(()=>parseRadarAnalysis(JSON.stringify(draft),doc),/最多 20 篇/);
});
test('all-paper UI keeps column input focus, filters before pages, sorts, and exports or copies the full selection', {skip:!JSDOM}, async t=>{
  const f=await fixture(t),r=record();r.document.papers=Array.from({length:69},(_,i)=>({...r.document.papers[0],id:'p'+i,year:2000+i,comparison:{...r.document.papers[0].comparison,short_name:fact('SYN '+i),research_group:fact(i<40?'First Lab':'Target Lab')}}));
  const exporter=createFieldRadarExporter({library:f.library,radar:{get:async()=>r}});
  const dom=new JSDOM('<header class="topbar-actions"></header><main class="workspace"></main>',{runScripts:'outside-only',url:'http://synthetic.invalid'}),w=dom.window;t.after(()=>w.close());
  for(const name of ['field-radar-data.js','field-radar.js'])w.eval(await readFile(new URL('../web/'+name,import.meta.url),'utf8'));
  const timers=new Map(),calls=[],copies=[];let seq=0;w.setTimeout=fn=>{timers.set(++seq,fn);return seq;};w.clearTimeout=id=>timers.delete(id);
  const flush=async()=>{assert.equal(timers.size,1);const [id,fn]=timers.entries().next().value;timers.delete(id);await fn();};
  w.Blob=Blob;w.ClipboardItem=class{constructor(values){this.values=values;}};Object.defineProperty(w.navigator,'clipboard',{value:{write:async items=>{copies.push(await (await items[0].values['text/plain']).text());}}});w.HTMLAnchorElement.prototype.click=function(){};
  const ui=w.PaperFieldRadar.create({api:async(action,args)=>{calls.push({action,args});if(action==='field_radar_list')return {topics:[{topic:r.document.topic}]};if(action==='field_radar_get')return r;if(action==='field_radar_table')return exporter.tablePreview(args);if(action==='field_radar_table_export')return {count:29,total:29,download_url:'/field-radar-export/synthetic.tsv'};throw Error('Unexpected '+action);}});
  await ui.open();w.document.querySelector('#field-radar-tab-table').click();await flush();
  const rows=()=>w.document.querySelectorAll('.radar-literature-table tbody tr:not(.radar-literature-evidence)');assert.equal(rows().length,69);assert.equal(w.document.querySelector('.radar-pager'),null);assert.equal(calls.at(-1).args.all,true);
  const size=w.document.querySelector('#field-radar-table-size');size.value='20';size.dispatchEvent(new w.Event('change'));await flush();assert.equal(rows().length,20);
  const input=w.document.querySelector('#field-radar-table-filter-research_group');input.focus();input.value='Target';input.dispatchEvent(new w.Event('input'));assert.equal(w.document.activeElement,input);await flush();assert.equal(w.document.activeElement,input);assert.equal(rows().length,20);assert.match(rows()[0].textContent,/SYN 40/);assert.match(w.document.querySelector('.radar-pager').textContent,/1–20 \/ 29/);
  w.document.querySelectorAll('th button')[5].click();await flush();w.document.querySelectorAll('th button')[5].click();await flush();assert.match(rows()[0].textContent,/SYN 68/);assert.equal(w.document.querySelectorAll('th')[5].getAttribute('aria-sort'),'descending');
  w.document.querySelector('#field-radar-table-copy').click();w.document.querySelector('#field-radar-table-copy').click();await new Promise(resolve=>setImmediate(resolve));assert.equal(copies.length,1);assert.equal(copies[0].split('\r\n').length,30);assert.equal(calls.at(-1).args.all,true);assert.equal(calls.at(-1).args.offset,0);
  w.document.querySelector('#field-radar-table-tsv').click();await new Promise(resolve=>setImmediate(resolve));assert.equal(calls.at(-1).action,'field_radar_table_export');assert.equal(calls.at(-1).args.all,true);assert.equal(calls.at(-1).args.column_filters.research_group,'Target');
  const scope=w.document.querySelector('#field-radar-table-export-scope');scope.value='page';scope.dispatchEvent(new w.Event('change'));w.document.querySelector('#field-radar-table-copy').click();await new Promise(resolve=>setImmediate(resolve));assert.equal(copies.at(-1).split('\r\n').length,21);
  input.value='missing';input.dispatchEvent(new w.Event('input'));await flush();assert.equal(rows().length,0);assert.match(w.document.querySelector('#field-radar-content').textContent,/没有匹配/);assert.equal(w.document.querySelector('#field-radar-table-filter-research_group'),input);
  w.document.querySelector('#field-radar-table-clear').click();await flush();assert.equal(input.value,'');assert.equal(rows().length,20);assert.equal(calls.at(-1).args.sort_by,'');
  size.value='50';size.dispatchEvent(new w.Event('change'));await flush();w.document.querySelector('.radar-pager button:last-child').click();await flush();assert.equal(rows().length,19);assert.equal(calls.at(-1).args.offset,50);
  size.value='all';size.dispatchEvent(new w.Event('change'));await flush();assert.equal(rows().length,69);assert.equal(calls.at(-1).args.offset,0);
  w.document.querySelector('#field-radar-close').click();assert.equal(timers.size,0);await ui.open();assert.equal(rows().length,69);ui.dispose();
});
