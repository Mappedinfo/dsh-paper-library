import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{JSDOM}=require(process.env.JSDOM_MODULE||'jsdom');
const [html,script,local]=await Promise.all(['../web/index.html','../web/paper-chat.js','../web/local-state.js'].map(path=>readFile(new URL(path,import.meta.url),'utf8')));
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function fixture(t,{beforeSend,failSend=false}={}){
 const dom=new JSDOM(html,{url:'https://synthetic.invalid',runScripts:'outside-only'}),w=dom.window,requests=[],toasts=[],saved=new Map();let paper={id:'a',pdf:true},serial=0;
 const notes=[1,2,3].map(n=>({id:`note-${n}`,page:n,version:`v${n}`,text:`Synthetic note ${n}`,status:'new'}));
 w.eval(local);w.eval(script);
 const ui=w.PaperLibraryChat.create({api:async(action,args)=>{requests.push({action,...JSON.parse(JSON.stringify(args))});switch(action){case'chat_ensure':return{sessionId:`session-${args.id}`};case'chat_catalog':return{annotations:notes,total:notes.length};case'chat_context':return{snapshot_id:`s${++serial}`};case'chat_send':if(failSend)throw Error('Synthetic send failure');return{accepted:true};case'chat_history':return{messages:[],running:false};default:throw Error(action);}},getPaper:()=>paper,getContext:()=>({}),getAnnotations:()=>notes,navigate:()=>{},navigateReference:()=>{},changed:()=>{},savedFeedback:()=>{},toast:message=>toasts.push(message),persistence:{get:async key=>saved.get(key)||null,put:async(key,value)=>saved.set(key,value)},beforeSendAnnotations:beforeSend});
 ui.setAvailable(true);await ui.paperOpened(paper);
 const render=ids=>{const list=w.document.getElementById('annotation-list');list.replaceChildren(...ids.map(id=>{const card=w.document.createElement('article');card.className='annotation-card';card.dataset.annotationId=id;card.dataset.paperId=paper.id;return card;}));ui.decorateAnnotations();};
 const select=id=>{const box=w.document.querySelector(`[data-annotation-id="${id}"] input`);box.checked=true;box.dispatchEvent(new w.Event('change',{bubbles:true}));};
 const start=async()=>{w.document.getElementById('discuss-all-notes').click();await tick();};
 t.after(()=>{ui.dispose();w.close();});return{w,ui,requests,toasts,notes,render,select,start,switchPaper:async id=>{paper={id,pdf:true};await ui.paperOpened(paper);}};
}
test('batch checkboxes retain choices across rail pages, refresh versions and submit one request',async t=>{
 let saves;const f=await fixture(t,{beforeSend:async(id,ids)=>{saves={id,ids};f.notes[0].version='v1-edited';}});
 f.render(['note-1','note-2']);await f.start();f.select('note-1');f.render(['note-3']);f.select('note-3');f.render(['note-1']);
 assert.equal(f.w.document.querySelector('.annotation-bulk-check input').checked,true);assert.equal(f.w.document.getElementById('discuss-all-notes').textContent,'提问（2）');assert.equal(f.requests.some(r=>r.action==='chat_send'),false);
 f.ui.restoreContext({...f.ui.context(),selection:{page:9,text:'Unrelated temporary selection'}});f.ui.restoreDraft('Explain these two notes.');await f.start();
 const context=f.requests.find(r=>r.action==='chat_context');assert.deepEqual(context.annotation_refs,[{id:'note-1',version:'v1-edited'},{id:'note-3',version:'v3'}]);assert.equal(context.question,'Explain these two notes.');assert.equal(context.selection,undefined);assert.deepEqual(JSON.parse(JSON.stringify(saves)),{id:'a',ids:['note-1','note-3']});
 assert.equal(f.requests.filter(r=>r.action==='chat_send').length,1);assert.equal(f.w.document.getElementById('discuss-all-notes').textContent,'开始选取提问批注');assert.equal(f.ui.draft(),'');assert.equal(f.ui.context().selection.text,'Unrelated temporary selection');
});
test('bulk send failure preserves question and checked references; retry reuses frozen request identity',async t=>{
 const f=await fixture(t,{failSend:true});f.render(['note-1']);await f.start();f.select('note-1');f.ui.restoreDraft('Keep this question');await f.start();await f.start();
 assert.equal(f.ui.draft(),'Keep this question');assert.equal(f.w.document.querySelector('.annotation-bulk-check input').checked,true);const sends=f.requests.filter(r=>r.action==='chat_send');assert.equal(sends.length,2);assert.equal(sends[0].request_id,sends[1].request_id);assert.equal(sends[0].snapshot_id,sends[1].snapshot_id);
});
test('batch submission rejects a deleted selected note without sending a partial request',async t=>{
 const f=await fixture(t);f.render(['note-1','note-2']);await f.start();f.select('note-1');f.select('note-2');f.notes.shift();await f.start();
 assert.equal(f.requests.some(r=>r.action==='chat_send'),false);assert.equal(f.ui.context().annotationRefs.length,2);assert.match(f.toasts.at(-1),/已删除/);
});
test('switching paper during preflight does not send old references or clear a new draft',async t=>{
 let release;const gate=new Promise(resolve=>release=resolve),f=await fixture(t,{beforeSend:()=>gate});f.render(['note-1']);await f.start();f.select('note-1');f.w.document.getElementById('discuss-all-notes').click();await tick();await f.switchPaper('b');f.ui.restoreDraft('Paper B');release();await tick();assert.equal(f.requests.some(r=>r.action==='chat_send'),false);assert.equal(f.ui.draft(),'Paper B');
});
test('select current rail page is bounded to visible cards and duplicate submit is blocked',async t=>{
 let release;const gate=new Promise(resolve=>release=resolve),f=await fixture(t,{beforeSend:()=>gate});f.render(['note-1','note-2']);await f.start();f.w.document.getElementById('annotation-bulk-page').click();await tick();assert.equal(f.ui.context().annotationRefs.length,2);
 f.w.document.getElementById('discuss-all-notes').click();f.w.document.getElementById('discuss-all-notes').click();release();await tick();assert.equal(f.requests.filter(r=>r.action==='chat_send').length,1);
});
