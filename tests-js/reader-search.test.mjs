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
 f.get('#reader-find').click();assert.equal(f.get('#pdf-search-row').hidden,true);assert.equal(f.w.document.body.classList.contains('pdf-search-open'),false);
 f.get('#reader-find').click();assert.equal(f.get('#pdf-search-row').hidden,false);assert.equal(f.get('#pdf-search-row input').value,'word');
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

test('AI reading filters only the strict native-style readback, never text or source declarations',t=>{
 const f=fixture(t,async()=>({})),filter=f.w.PaperReaderSearch.filterThreads;
 const reading={id:'reading',ai_reading_style:true,color:{stroke:[47/255,128/255,237/255]},border:{style:'D',dashes:[3,2]},author:'Reader',text:'Attention',comment:'Loss definition'};
 const sameHumanStyle={id:'human-style',ai_reading_style:true,author:'Human reader',comment:'direction\u00adality'};
 const excluded=[
  {id:'body-spoof',comment:'AI 自主阅读 attention loss #2F80ED dashed [3,2]'},
  {id:'author-spoof',author:'AI 自主阅读',comment:'attention loss'},
  {id:'subject-spoof',subject:'AI close reading',comment:'attention loss'},
  ...['autonomous-reading','ai-reading','paper-analysis'].map(source_kind=>({id:source_kind,source_kind,comment:'attention loss'})),
  {id:'solid-blue',ai_reading_style:false,color:{stroke:[47/255,128/255,237/255]},border:{style:'S',dashes:[]},author:'AI 自主阅读'},
  {id:'other-color-dashed',ai_reading_style:false,color:{stroke:[1,0,0]},border:{style:'D',dashes:[3,2]},subject:'AI close reading'},
  {id:'unverified-style',color:{stroke:[47/255,128/255,237/255]},border:{style:'D',dashes:[3,2]}},
  ...['true',1,{},[]].map((ai_reading_style,index)=>({id:`nonboolean-${index}`,ai_reading_style})),
 ];
 const group={notes:[...excluded,reading,sameHumanStyle],replies:new Map(),unlinked:[]};
 assert.deepEqual(filter(group,'',{source:'reading'}).notes,[reading,sameHumanStyle]);
 assert.deepEqual(filter(group,'attention，loss',{source:'reading'}).notes,[reading]);
 assert.deepEqual(filter(group,'directionality',{source:'reading'}).notes,[sameHumanStyle]);
 assert.equal(filter(group,'attention absent',{source:'reading'}).notes.length,0);
 assert.deepEqual(filter(group,'attention;absent',{source:'reading',match:'any'}).notes,[reading]);
 assert.ok(filter(group,'AI 自主阅读').notes.includes(excluded[0]),'keyword search remains independently available for old unstyled annotations');
});
test('native-style reading keeps whole discussions and does not replace other AI categories',t=>{
 const f=fixture(t,async()=>({})),filter=f.w.PaperReaderSearch.filterThreads;
 const reading={id:'reading',ai_reading_style:true,comment:'source passage'},human={id:'human',comment:'human passage'};
 const remark={id:'remark',comment:'followup'},reply={id:'reply',kind:'ai-feedback',comment:'native reply'};
 const styledReply={id:'styled-reply',ai_reading_style:true,kind:'ai-feedback',comment:'answer'};
 const translation={id:'translation',ai_reading_style:true,kind:'ai-feedback',source_kind:'annotation-translation',comment:'translation'};
 const caption={id:'caption',ai_reading_style:true,kind:'ai-feedback',source_kind:'annotation-caption',comment:'caption'};
 const orphan={id:'orphan',ai_reading_style:true,comment:'independent'};
 const group={notes:[reading,human],remarks:new Map([['reading',[remark]]]),replies:new Map([['reading',[reply,translation]],['remark',[caption]],['human',[styledReply]]]),unlinked:[orphan]};
 const result=filter(group,'',{source:'reading'});
 assert.deepEqual(result.notes,[reading,human]);assert.deepEqual(result.unlinked,[orphan]);
 assert.equal(result.remarks,group.remarks);assert.equal(result.replies,group.replies);
 assert.deepEqual(filter(group,'source passage',{source:'reading'}).notes,[reading]);
 assert.equal(filter(group,'native reply',{source:'reading'}).notes.length,0,'keywords narrow the selected style rather than changing its classification');
 assert.deepEqual(filter(group,'answer',{source:'reply'}).notes,[human]);
 assert.deepEqual(filter(group,'translation',{source:'translation'}).notes,[reading]);
 assert.deepEqual(filter(group,'caption',{source:'caption'}).notes,[reading]);
 assert.equal(filter(group,'translation',{source:'reply'}).notes.length,0);
});
test('native reply grouping passes the root style through and keeps its replies after filtering',async t=>{
 const f=fixture(t,async()=>({}));f.w.eval(await readFile(new URL('../web/annotation-threads.js',import.meta.url),'utf8'));
 const root={id:'root',type:'underline',ai_reading_style:true,comment:'source'};
 const remark={id:'remark',kind:'reader-reply',reply_to:'root',comment:'question'};
 const reply={id:'reply',kind:'ai-feedback',reply_to:'remark',comment:'answer'};
 const group=f.w.PaperAnnotationThreads.threads([root,remark,reply,{id:'other',comment:'unrelated'}]);
 const result=f.w.PaperReaderSearch.filterThreads(group,'',{source:'reading'});
 assert.deepEqual(Array.from(result.notes),[root]);assert.equal(result.remarks,group.remarks);assert.equal(result.replies,group.replies);
 assert.deepEqual(Array.from(result.remarks.get('root')),[remark]);assert.deepEqual(Array.from(result.replies.get('remark')),[reply]);
 assert.equal(result.roots.get('remark'),'root');assert.equal(result.unlinked.length,0);
});
test('source filter searches only matching AI content and retains whole parent discussion',t=>{
 const f=fixture(t,async()=>({})),filter=f.w.PaperReaderSearch.filterThreads;
 const parent={id:'a',comment:'human-only'},remark={id:'r',comment:'followup'},reply={id:'reply',kind:'ai-feedback',comment:'mechanism'},translation={kind:'ai-feedback',source_kind:'annotation-translation',comment:'方向性'};
 const group={notes:[parent],remarks:new Map([['a',[remark]]]),replies:new Map([['a',[translation]],['r',[reply]]]),unlinked:[{kind:'ai-feedback',ai_reading_style:true,comment:'independent'}]};
 const result=filter(group,'mechanism',{source:'reply'});assert.deepEqual(result.notes,[parent]);assert.equal(result.replies,group.replies);assert.equal(result.remarks,group.remarks);
 assert.equal(filter(group,'human-only',{source:'reply'}).notes.length,0);
 assert.equal(filter(group,'方向性',{source:'reply'}).notes.length,0);
 assert.deepEqual(filter(group,'方向性',{source:'translation'}).notes,[parent]);
 assert.equal(filter(group,'independent',{source:'reading'}).unlinked.length,1);
 assert.deepEqual(filter(group,'human-only mechanism').notes,[parent]);
});
test('source controls reset pagination callback, survive scope switches and clear with paper or page matching',t=>{
 const f=fixture(t,async()=>({}));f.get('#sidebar-search-toggle').click();
 const source=f.get('#annotation-search-source'),mode=f.get('#annotation-search-match');
 assert.equal(source.querySelector('[value=reading]').textContent,'AI 阅读（蓝色虚线）');assert.match(source.title,/#2F80ED/);assert.match(source.title,/3、2 pt/);assert.match(source.title,/不看作者或文字/);assert.match(source.title,/人工使用相同样式也会命中/);assert.match(source.title,/旧批注不自动改写/);
 source.value='reading';source.dispatchEvent(new f.w.Event('change'));mode.value='any';mode.dispatchEvent(new f.w.Event('change'));
 assert.deepEqual(f.filters.at(-1),['annotations','']);assert.equal(f.get('#sidebar-search-toggle').classList.contains('active'),true);
 const group={notes:[{id:'a',ai_reading_style:true,comment:'alpha'},{id:'b',comment:'alpha'}],replies:new Map(),unlinked:[]};
 f.get('#sidebar-search-row input').value='alpha beta';f.submit('#sidebar-search-row');assert.equal(f.ui.filter(group).notes.length,1);
 f.setScope('elements-formula');assert.equal(source.parentElement.hidden,true);f.setScope('annotations');assert.equal(source.value,'reading');assert.equal(mode.value,'any');
 f.ui.clearAnnotationFilter();assert.equal(source.value,'all');assert.equal(f.ui.filter(group).notes.length,2);
 source.value='reading';source.dispatchEvent(new f.w.Event('change'));f.get('[aria-label="清除当前侧栏搜索"]').click();assert.equal(source.value,'all');
 source.value='reading';source.dispatchEvent(new f.w.Event('change'));f.setPaper({id:'second',pdf:true});assert.equal(source.value,'all');assert.equal(mode.value,'all');assert.equal(f.calls.length,0);
});

test('annotation result navigation crosses pages, wraps and resets after edits or paper changes',t=>{
 const f=fixture(t,async()=>({})),moves=[];
 // Use a fresh control with a navigation callback; no PDF requests are needed.
 f.ui.dispose();
 const ui=f.w.PaperReaderSearch.create({api:async()=>{throw Error('unexpected API');},getPaper:()=>({id:'nav',pdf:true}),reader:()=>null,navigate:()=>{},getElements:()=>null,onAnnotationSearch:()=>{},onAnnotationNavigate:hit=>moves.push(hit),onLibrarySearch:()=>{}});
 f.get('#sidebar-search-toggle').click();f.get('#sidebar-search-row input').value='reading';f.submit('#sidebar-search-row');
 const group={notes:Array.from({length:43},(_,i)=>({id:`n${i}`,text:'reading'})),replies:new Map(),unlinked:[{id:'orphan',text:'reading'}]};
 ui.filter(group);const next=f.get('[aria-label="下一个搜索批注"]'),prev=f.get('[aria-label="上一个搜索批注"]');
 assert.match(f.get('#sidebar-search-row [role=status]').textContent,/0 \/ 44/);
 for(let i=0;i<41;i++){next.click();ui.filter(group);}
 assert.equal(moves.at(-1).id,'n40');assert.equal(moves.at(-1).offset,40);assert.match(f.get('#sidebar-search-row [role=status]').textContent,/41 \/ 44/);
 next.click();next.click();next.click();assert.equal(moves.at(-1).id,'orphan');next.click();assert.equal(moves.at(-1).id,'n0');prev.click();assert.equal(moves.at(-1).id,'orphan');
 ui.filter({...group,unlinked:[]});assert.match(f.get('#sidebar-search-row [role=status]').textContent,/0 \/ 43/);
 f.get('#sidebar-search-row input').value='missing';f.submit('#sidebar-search-row');ui.filter(group);assert.equal(next.disabled,true);assert.equal(prev.disabled,true);
 f.get('[aria-label="清除当前侧栏搜索"]').click();ui.filter(group);assert.equal(next.parentElement.hidden,true);assert.equal(f.revealed.length,0);ui.dispose();
});

test('PDF search switches apply their states immediately and can toggle back', async t => {
 const f=fixture(t,async()=>({page:1,page_count:1,matches:[],next_page:null,next_offset:null}));
 f.get('#reader-find').click();
 const whole=f.get('[role=switch][aria-label="完整词匹配"]'), matchCase=f.get('[role=switch][aria-label="区分大小写"]');
 assert.equal(whole.textContent,'部分匹配');
 f.get('#pdf-search-row input[type=search]').value='Cat';
 whole.click();await until(()=>f.calls.length===1);
 assert.equal(whole.textContent,'完整词匹配');assert.equal(f.calls[0][1].match,'whole');assert.equal(f.calls[0][1].case_sensitive,false);
 matchCase.click();await until(()=>f.calls.length===2);
 assert.equal(f.calls[1][1].match,'whole');assert.equal(f.calls[1][1].case_sensitive,true);
 whole.click();matchCase.click();await until(()=>f.calls.length===4);
 assert.equal(f.calls[3][1].match,'partial');assert.equal(f.calls[3][1].case_sensitive,false);
});
