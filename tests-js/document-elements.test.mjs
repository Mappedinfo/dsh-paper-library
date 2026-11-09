import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{JSDOM}=require(process.env.JSDOM_MODULE||'jsdom');
const sources=await Promise.all(['reading-panels.js','board-source.js','document-elements.js'].map(n=>readFile(new URL('../web/'+n,import.meta.url),'utf8')));
const settle=()=>new Promise(r=>setTimeout(r,15));
function setup(api,{liveIdle=false,sharedSearch=false}={}){const dom=new JSDOM('<main><section id="library"></section><div id="reader"></div></main><section id="annotations"></section><section id="chat"></section><dialog id="metadata"></dialog>',{runScripts:'outside-only',url:'http://localhost/'}),w=dom.window;
 w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};w.HTMLDialogElement.prototype.close=function(){this.open=false;this.dispatchEvent(new w.Event('close'));};w.HTMLDialogElement.prototype.show=function(){this.open=true;};
 for(const s of sources)w.eval(s);
 let paper={id:'paper-a',title:'Synthetic',pdf:true},ui;const doc=w.document,panels=w.PaperReadingPanels.create({root:doc.getElementById('reader'),libraryRoot:doc.getElementById('library'),annotationsRoot:doc.getElementById('annotations'),conversationRoot:doc.getElementById('chat'),metadataRoot:doc.getElementById('metadata'),onPanelChange:v=>ui?.sync(v)});
 const navigation=[],writes=[],errors=[];panels.paperChanged(paper);ui=w.PaperDocumentElements.create({sharedSearch,...(liveIdle?{}:{yieldWork:async()=>{}}),api,panels,getPaper:()=>paper,navigate:v=>navigation.push(v),annotated:(...v)=>writes.push(v),toast:(...v)=>errors.push(v)});
 return {w,doc,panels,ui,navigation,writes,errors,setPaper:value=>{paper=value;panels.paperChanged(value);},close:()=>{ui.dispose();panels.dispose();w.close();}};
}
const coverage={page_count:1,scanned_pages:[1],complete:true,next_page:null};
const element={id:'e1',kind:'formula',page:1,rect:[10,20,100,50],title:'Equation (1)',text:'y = a*x',context:'where x denotes input.'};
test('reading element tabs coexist with annotations, navigate original bounds and annotate only on request',async t=>{const calls=[];const env=setup(async(a,p)=>{calls.push([a,p]);if(a==='document_elements_list')return {elements:[element],total:1,coverage};if(a==='document_element_preview')return {mime_type:'image/png',image:'YWJj'};if(a==='document_element_annotate')return {annotation:{id:'note'}};throw Error(a);});t.after(env.close);
 env.panels.show('elements-formula');await settle();assert.equal(env.doc.getElementById('reading-sidebar-library').hidden,false);assert.equal(env.doc.getElementById('reading-sidebar-annotations').hidden,false);assert.equal(env.doc.getElementById('document-elements-formula').hidden,false);assert.equal(env.doc.getElementById('reading-side-panel').hidden,true);
 assert.equal(calls.some(([a])=>a==='document_element_annotate'),false);const card=env.doc.querySelector('.document-element-card');[...card.querySelectorAll('button')].find(e=>e.textContent==='第 1 页').click();assert.deepEqual(JSON.parse(JSON.stringify(env.navigation[0].rects)),[[10,20,100,50]]);
 [...card.querySelectorAll('button')].find(e=>e.textContent==='标注区域').click();await settle();assert.equal(env.writes.length,1);env.panels.showLibrary();assert.equal(env.doc.getElementById('document-elements-formula').hidden,true);assert.equal(env.doc.getElementById('reading-sidebar-library-content').hidden,false);
});
test('single paper scan resumes in bounded batches and finishes all pages without invoking AI',async t=>{let scanned=0;const calls=[];const env=setup(async(a,p)=>{calls.push([a,p]);if(a==='document_elements_scan'){assert.equal(p.limit,1);scanned=Math.min(9,scanned+1);return {coverage:{page_count:9,scanned_pages:Array.from({length:scanned},(_,i)=>i+1),complete:scanned===9}};}if(a==='document_elements_list')return {elements:[],total:0,coverage:{page_count:9,scanned_pages:Array.from({length:scanned},(_,i)=>i+1),complete:scanned===9}};throw Error(a);});t.after(env.close);env.panels.show('elements-table');await settle();assert.equal(scanned,9);assert.equal(calls.filter(([a])=>a==='document_elements_scan').length,9);assert.match(env.doc.querySelector('#document-elements-table .document-elements-status').textContent,/9 \/ 9.*扫描完成/);
});
test('late paper response cannot populate another paper or continue the old scan',async t=>{let resolveOld;const calls=[];const env=setup(async(a,p)=>{calls.push([a,p]);if(p.id==='paper-a')return new Promise(r=>{resolveOld=r;});return {elements:[],total:0,coverage};});t.after(env.close);env.panels.show('elements-figure');env.setPaper({id:'paper-b',title:'Other',pdf:true});await settle();resolveOld({elements:[{...element,title:'OLD'}],total:1,coverage:{complete:false}});await settle();assert.equal(env.doc.querySelector('#document-elements-figure').textContent.includes('OLD'),false);assert.equal(calls.some(([a,p])=>a==='document_elements_scan'&&p.id==='paper-a'),false);});
test('flowchart filtering and paginated lookup reach the worker',async t=>{const calls=[];const env=setup(async(a,p)=>{calls.push([a,p]);return {elements:Array.from({length:40},(_,i)=>({...element,id:'e'+i,kind:'figure'})),total:45,coverage};});t.after(env.close);env.panels.show('elements-figure');await settle();[...env.doc.querySelectorAll('#document-elements-figure button')].find(b=>b.textContent==='只看流程图').click();await settle();assert.equal(calls.at(-1)[1].subtype,'flowchart');env.doc.querySelector('#document-elements-figure [aria-label="下一页"]').click();await settle();assert.equal(calls.at(-1)[1].offset,40);assert.equal(calls.at(-1)[1].limit,40);});
test('failed preview is retryable, search does not mutate notes, and SVG renders loop edges as safe text',async t=>{let attempts=0;const env=setup(async a=>{if(a==='document_elements_list')return {elements:[element],total:1,coverage};if(a==='document_element_preview'){if(!attempts++)throw Error('temporary');return {mime_type:'image/png',image:'YWJj'};}throw Error(a);});t.after(env.close);env.panels.show('elements-formula');await settle();let btn=[...env.doc.querySelectorAll('#document-elements-formula button')].find(e=>e.textContent==='预览裁剪');btn.click();await settle();assert.equal(btn.textContent,'重试截图');btn.click();await settle();assert.equal(env.doc.querySelector('.document-element-image').hidden,false);
 const svg=env.w.PaperDocumentElements.flowSVG({nodes:[{id:'a',kind:'loop',label:'<script>alert(1)</script>'},{id:'b',kind:'step',label:'Update'}],edges:[{source:'a',target:'b',kind:'true',label:'是'},{source:'b',target:'a',kind:'back',label:'循环'}]});assert.equal(svg.querySelector('script'),null);assert.equal(svg.querySelectorAll('[data-edge-kind]').length,2);assert.match(svg.textContent,/<script>/);assert.equal(svg.querySelectorAll('[data-node-id]').length,2);
});


test('budget pause keeps indexed results and stops automatic retries',async t=>{let scans=0;const env=setup(async a=>{if(a==='document_elements_scan'){scans++;return {paused:true,budget_reason:'Index budget reached',coverage:{page_count:9,scanned_pages:[1],complete:false}};}return {elements:[element],total:1,coverage:{page_count:9,scanned_pages:[1],complete:false}};});t.after(env.close);env.panels.show('elements-formula');await settle();assert.equal(scans,1);assert.match(env.doc.querySelector('#document-elements-formula .document-elements-status').textContent,/Index budget reached/);assert.ok(env.doc.querySelector('.document-element-card'));});

test('decoded previews stay bounded and leaving the rail releases their sources',async t=>{const env=setup(async a=>a==='document_elements_list'?{elements:Array.from({length:14},(_,i)=>({...element,id:'e'+i})),total:14,coverage}:{mime_type:'image/png',image:'YWJj',width:640,height:640});t.after(env.close);env.panels.show('elements-formula');await settle();const previews=[...env.doc.querySelectorAll('#document-elements-formula button')].filter(b=>b.textContent==='预览裁剪');for(const btn of previews){btn.click();await settle();}assert.ok(env.doc.querySelectorAll('.document-element-image[src]').length<=7);env.panels.showLibrary();assert.equal(env.doc.querySelectorAll('.document-element-image[src]').length,0);});


test('automatic scanning waits for idle and stops between pages when the reader leaves',async t=>{let scans=0;const env=setup(async a=>{if(a==='document_elements_scan'){scans++;return {coverage:{page_count:2,scanned_pages:[1],complete:false}};}return {elements:[],total:0,coverage:{page_count:2,scanned_pages:[],complete:false}};},{liveIdle:true});t.after(env.close);Object.defineProperty(env.doc,'hidden',{value:false,configurable:true});env.panels.show('elements-formula');await new Promise(r=>setTimeout(r,700));assert.equal(scans,0);env.doc.dispatchEvent(new env.w.Event('wheel'));await new Promise(r=>setTimeout(r,850));assert.equal(scans,0);await new Promise(r=>setTimeout(r,650));assert.equal(scans,1);env.panels.showLibrary();await new Promise(r=>setTimeout(r,2100));assert.equal(scans,1);});


test('updated resource policy changes next scan batch',async t=>{const batches=[];const env=setup(async(a,p)=>{if(a==='document_elements_scan'){batches.push(p.limit);return {coverage,paused:false};}return {elements:[],total:0,coverage:{page_count:1,scanned_pages:[],complete:false}};});t.after(env.close);env.ui.applyResources({batch_pages:4,preview_bytes:64*1048576,preview_count:64,batch_gap_ms:500,idle_ms:1200});env.panels.show('elements-formula');await settle();assert.deepEqual(batches,[4]);});

test('resource pause on initial list stays visible and offers settings instead of retrying automatically',async t=>{let scans=0;const env=setup(async action=>{if(action==='document_elements_scan')scans++;return {elements:[],total:0,paused:true,stale:true,budget_reason:'磁盘空间不足：需要保留 512 MiB',coverage:{page_count:6,scanned_pages:[1],complete:false}};});t.after(env.close);env.panels.show('elements-formula');await settle();assert.equal(scans,0);assert.match(env.doc.querySelector('#document-elements-formula .document-elements-status').textContent,/磁盘空间不足.*512 MiB/);const adjust=[...env.doc.querySelectorAll('#document-elements-formula button')].find(b=>b.textContent==='调整资源设置');assert.equal(adjust.hidden,false);});

function deferred(){let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};}
test('scan batches append cards without replacing loaded previews, expanded text or current scroll',async t=>{
 const firstScan=deferred(),secondScan=deferred();let scanned=1,scans=0,previews=0;
 const env=setup(async action=>{
  if(action==='document_elements_list')return {elements:Array.from({length:scanned},(_,i)=>({...element,id:'e'+i,kind:'figure',page:i+1})),total:scanned,source_version:'content-1',coverage:{page_count:3,scanned_pages:Array.from({length:scanned},(_,i)=>i+1),complete:scanned===3}};
  if(action==='document_elements_scan'){const result=await (++scans===1?firstScan.promise:secondScan.promise);scanned=result;return {coverage:{page_count:3,scanned_pages:Array.from({length:scanned},(_,i)=>i+1),complete:scanned===3}};}
  if(action==='document_element_preview'){previews++;return {mime_type:'image/png',image:'YWJj',width:300,height:200};}
  throw Error(action);
 });t.after(env.close);env.panels.show('elements-figure');await settle();
 const list=env.doc.querySelector('#document-elements-figure .document-elements-list'),card=list.querySelector('article'),details=card.querySelector('details');details.open=true;
 [...card.querySelectorAll('button')].find(b=>b.textContent==='预览裁剪').click();await settle();const image=card.querySelector('img'),src=image.src;list.scrollTop=173;
 firstScan.resolve(2);await settle();assert.equal(list.querySelector('article'),card);assert.equal(card.querySelector('img'),image);assert.equal(image.src,src);assert.equal(details.open,true);assert.equal(list.scrollTop,173);assert.equal(list.querySelectorAll('article').length,2);assert.equal(previews,1);
 secondScan.resolve(3);await settle();assert.equal(list.querySelector('article'),card);assert.equal(list.querySelectorAll('article').length,3);assert.equal(image.src,src);assert.equal(previews,1);
});

test('refresh keeps content while waiting and accepts the same card’s in-flight preview',async t=>{
 const later=deferred(),preview=deferred();let lists=0;
 const result={elements:[element],total:1,source_version:'source-a',coverage};
 const env=setup(async action=>{if(action==='document_elements_list')return ++lists===1?result:later.promise;if(action==='document_element_preview')return preview.promise;throw Error(action);});t.after(env.close);
 env.panels.show('elements-formula');await settle();const list=env.doc.querySelector('.document-elements-list'),card=list.querySelector('article');[...card.querySelectorAll('button')].find(b=>b.textContent==='预览裁剪').click();
 const refreshing=env.ui.reload();assert.equal(list.querySelector('article'),card);list.scrollTop=241;
 preview.resolve({mime_type:'image/png',image:'YWJj'});await settle();assert.equal(card.querySelector('img').hidden,false);
 later.resolve(result);await refreshing;assert.equal(list.querySelector('article'),card);assert.equal(list.scrollTop,241);assert.equal(card.querySelector('img').hidden,false);
});

test('superseded search and removed-card previews cannot reappear in the filtered result',async t=>{
 const oldSearch=deferred(),oldPreview=deferred();let lists=0;
 const env=setup(async action=>{if(action==='document_elements_list'){lists++;if(lists===2)return oldSearch.promise;return {elements:lists===1?[element]:[{...element,id:'new',title:'Filtered equation'}],total:1,coverage};}if(action==='document_element_preview')return oldPreview.promise;throw Error(action);});t.after(env.close);
 env.panels.show('elements-formula');await settle();const list=env.doc.querySelector('.document-elements-list'),oldCard=list.querySelector('article');[...oldCard.querySelectorAll('button')].find(b=>b.textContent==='预览裁剪').click();const stale=env.ui.reload(true);await env.ui.reload(true);
 assert.equal(oldCard.isConnected,false);assert.match(list.textContent,/Filtered equation/);
 oldSearch.resolve({elements:[element],total:1,coverage});oldPreview.resolve({mime_type:'image/png',image:'YWJj'});await stale;await settle();assert.match(list.textContent,/Filtered equation/);assert.equal(oldCard.querySelector('img').hasAttribute('src'),false);assert.equal(list.querySelectorAll('img[src]').length,0);
});

 test('shared sidebar search reuses element query, hides duplicate field and resets on paper change',async t=>{const calls=[];const env=setup(async(a,p)=>{calls.push([a,p]);return {elements:[],total:0,coverage};},{sharedSearch:true});t.after(env.close);env.panels.show('elements-table');await settle();assert.equal(env.doc.querySelector('#document-elements-table input').hidden,true);env.ui.search('table','RMSE');await settle();assert.equal(calls.at(-1)[1].query,'RMSE');assert.equal(calls.at(-1)[1].offset,0);env.setPaper({id:'paper-b',title:'Other',pdf:true});await settle();assert.equal(calls.at(-1)[1].query,'');});
