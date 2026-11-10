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
test('UI uses safe text cells, explicit scope invalidation, rich clipboard and page-limited export',async()=>{const source=await readFile(new URL('../web/field-radar.js',import.meta.url),'utf8');for(const text of ["['table', '文献对照表']","navigator.clipboard.write([new ClipboardItem","'text/html'","'text/plain'","scope!==tableScope()","result.rows","row.values","make('td',value)","limit:20","导出本页"])assert.ok(source.includes(text),text);assert.ok(!/innerHTML\s*=/.test(source));});

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
