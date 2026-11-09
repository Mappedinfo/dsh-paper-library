import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{JSDOM}=require(process.env.JSDOM_MODULE||'jsdom');
const script=await readFile(new URL('../web/reader-search.js',import.meta.url),'utf8');
const tick=()=>new Promise(r=>setImmediate(r));
async function until(fn){for(let i=0;i<100;i++){if(fn())return;await tick();}assert.ok(fn(),'condition settled');}
function fixture(t,api){
 const w=new JSDOM('<header><div id="paper-tools"><div id="toolbar-reader"></div></div></header><section class="shared-reading-sidebar" data-sidebar-panel="annotations"><header class="reading-sidebar-header"><button id="reading-sidebar-side"></button></header></section>',{runScripts:'outside-only'}).window;
 w.setTimeout=fn=>setImmediate(fn);w.eval(script);let paper={id:'synthetic',pdf:true};const calls=[],revealed=[],filters=[];
 const ui=w.PaperReaderSearch.create({api:async(a,p)=>{calls.push([a,p]);return api(a,p);},getPaper:()=>paper,reader:()=>({revealRegion:v=>revealed.push(v)}),navigate:async()=>{},getElements:()=>({search:(...v)=>filters.push(v)}),onAnnotationSearch:q=>filters.push(['annotations',q]),onLibrarySearch:q=>filters.push(['library',q])});
 t.after(()=>{ui.dispose();w.close();});return {w,ui,calls,revealed,filters,setPaper(p){paper=p;ui.sync();},setScope(s){w.document.querySelector('.shared-reading-sidebar').dataset.sidebarPanel=s;ui.sync();},get:selector=>w.document.querySelector(selector),submit(selector){w.document.querySelector(selector).dispatchEvent(new w.Event('submit',{cancelable:true}));}};
}
const match=(page,n=0)=>({page,rects:[[10+n,20,30+n,40]]});
test('PDF search scans pages, navigates each match, handles blank pages and closes without leaving layout space',async t=>{
 const f=fixture(t,async(a,p)=>({page:p.page,page_count:3,matches:p.page===2?[]:[match(p.page)],next_offset:null,next_page:p.page<3?p.page+1:null,no_extractable_text:p.page===2}));
 f.get('#reader-find').click();assert.ok(f.w.document.body.classList.contains('pdf-search-open'));
 f.get('#pdf-search-row input').value='word';f.submit('#pdf-search-row');await until(()=>f.calls.length===3&&f.get('[aria-label="停止 PDF 搜索"]').hidden);
 assert.match(f.get('#pdf-search-row [role=status]').textContent,/1 \/ 2 个位置.*3 \/ 3 页.*1 页无可选文字/);assert.equal(f.revealed[0].page,1);
 f.get('[aria-label="下一个匹配位置"]').click();await tick();assert.equal(f.revealed.at(-1).page,3);
 f.get('[aria-label="上一个匹配位置"]').click();await tick();assert.equal(f.revealed.at(-1).page,1);
 f.get('[aria-label="关闭 PDF 搜索"]').click();assert.equal(f.get('#pdf-search-row').hidden,true);assert.equal(f.w.document.body.classList.contains('pdf-search-open'),false);
});
test('bounded batches continue inside a dense page without dropping remaining matches',async t=>{
 const f=fixture(t,async(a,p)=>{const count=Math.min(p.limit,205-p.offset);return{page:1,page_count:1,matches:Array.from({length:count},(_,i)=>match(1,p.offset+i)),next_offset:p.offset+count<205?p.offset+count:null,next_page:null};});
 f.get('#pdf-search-row input').value='a';f.submit('#pdf-search-row');await until(()=>f.calls.length===5&&f.get('[aria-label="停止 PDF 搜索"]').hidden);
 assert.match(f.get('#pdf-search-row [role=status]').textContent,/200 个位置（本批）/);
 f.get('[aria-label="继续搜索后续位置"]').click();await until(()=>f.calls.length===6&&f.get('[aria-label="停止 PDF 搜索"]').hidden);
 assert.equal(f.calls.at(-1)[1].offset,200);assert.match(f.get('#pdf-search-row [role=status]').textContent,/5 个位置/);assert.equal(f.get('[aria-label="继续搜索后续位置"]').hidden,true);
});
test('late results cannot replace new input or navigate a newly selected paper',async t=>{
 let resolve;const f=fixture(t,()=>new Promise(r=>resolve=r));f.get('#pdf-search-row input').value='old';f.submit('#pdf-search-row');
 f.setPaper({id:'another',pdf:true});resolve({page:1,page_count:1,matches:[match(1)],next_page:null,next_offset:null});await tick();assert.equal(f.revealed.length,0);assert.equal(f.get('#pdf-search-row').hidden,true);
});
test('scope magnifier shares one row, keeps separate queries and submits only current category',async t=>{
 const f=fixture(t,async()=>({}));f.get('#sidebar-search-toggle').click();const input=f.get('#sidebar-search-row input');input.value='remark';f.submit('#sidebar-search-row');
 f.setScope('elements-formula');assert.equal(input.value,'');assert.match(input.placeholder,/公式/);input.value='energy';f.submit('#sidebar-search-row');
 f.setScope('annotations');assert.equal(input.value,'remark');f.get('[aria-label="清除当前侧栏搜索"]').click();
 assert.deepEqual(f.filters.slice(-3),[['annotations','remark'],['formula','energy'],['annotations','']]);
 f.setScope('elements-figure');input.value='workflow';f.submit('#sidebar-search-row');assert.deepEqual(f.filters.at(-1),['figure','workflow']);
});
test('annotation search matches source, followup and AI reply while keeping the complete thread',t=>{
 const f=fixture(t,async()=>({}));const a={id:'a',text:'direction\u00adality'},b={id:'b',comment:'unrelated'},remark={id:'r',comment:'my second question'};
 const group={notes:[a,b],remarks:new Map([['a',[remark]]]),replies:new Map([['r',[{text:'AI explanation'}]]]),unlinked:[{text:'orphan result'}]};
 for(const query of ['directionality','second','explanation']){const filtered=f.w.PaperReaderSearch.filterThreads(group,query);assert.deepEqual(filtered.notes,[a]);assert.equal(filtered.remarks,group.remarks);assert.equal(filtered.replies,group.replies);}
 assert.equal(f.w.PaperReaderSearch.filterThreads(group,'missing').notes.length,0);
 assert.equal(f.w.PaperReaderSearch.filterThreads(group,'orphan').unlinked.length,1);
});
test('search errors stay visible and retry uses the failed page',async t=>{
 let fail=true;const f=fixture(t,async(a,p)=>{if(fail)throw Error('synthetic error');return{page:p.page,page_count:1,matches:[],next_offset:null,next_page:null};});
 f.get('#pdf-search-row input').value='test';f.submit('#pdf-search-row');await tick();assert.match(f.get('#pdf-search-row [role=status]').textContent,/synthetic error/);
 fail=false;f.get('[aria-label="继续搜索后续位置"]').click();await tick();assert.equal(f.calls.at(-1)[1].page,1);assert.match(f.get('#pdf-search-row [role=status]').textContent,/1 \/ 1 页/);
});

test('explicit page matching clears only the annotation filter and its visible field',async t=>{const f=fixture(t,async()=>({}));f.get('#sidebar-search-toggle').click();f.get('#sidebar-search-row input').value='word';f.submit('#sidebar-search-row');const group={notes:[{id:'a',text:'different'}],replies:new Map(),unlinked:[]};assert.equal(f.ui.filter(group).notes.length,0);f.ui.clearAnnotationFilter();assert.equal(f.get('#sidebar-search-row input').value,'');assert.equal(f.ui.filter(group).notes.length,1);});
