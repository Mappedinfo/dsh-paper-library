import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{JSDOM}=require(process.env.JSDOM_MODULE||'jsdom');
const source=await readFile(new URL('../web/annotation-editor.js',import.meta.url),'utf8');
const companion=await readFile(new URL('../web/companion.js',import.meta.url),'utf8');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(t,{request,stored}={}){
 const dom=new JSDOM('<div id="paper-tools"></div><div id="annotation-list"></div>',{url:'http://synthetic.invalid',runScripts:'outside-only'}),w=dom.window;
 const notes=[],calls=[],saved=[],messages=[],timers=new Map();let active={id:'paper-a',pdf:true},next=0,editor,ui;
 w.setTimeout=fn=>{timers.set(++next,fn);return next;};w.clearTimeout=id=>timers.delete(id);
 w.eval(source);w.eval(companion);
 function render(){if(editor?.deferRender(render))return;const restore=editor?.beforeRender(),list=w.document.getElementById('annotation-list');list.replaceChildren();for(const note of notes){const card=w.document.createElement('article');card.className='annotation-card';card.dataset.paperId=active.id;card.dataset.annotationId=note.id;card.innerHTML='<div class="annotation-actions"></div>';const parent=note.reply_to&&[...list.children].find(n=>n.dataset.annotationId===note.reply_to);if(parent){card.className='annotation-remark';card.dataset.remarkNumber=String(parent.querySelectorAll('.annotation-remark').length+2);parent.append(card);}else list.append(card);}editor?.decorate();restore?.();ui?.decorate();}
 async function api(action,args){calls.push({action,...JSON.parse(JSON.stringify(args))});const custom=await request?.(action,args);if(custom!==undefined)return custom;
 if(action==='companion_status')return {entries:[],enabled:false};if(action==='companion_ask')return {request_id:'req',status:'queued',manual:true,annotation_id:args.annotation_id};
 if(action==='annotation_reply_create'){const parent=notes.find(n=>n.id===args.annotation_id);return {annotation:{id:args.reply_id,page:parent.page,type:'note',kind:'reader-reply',reply_to:parent.id,text:parent.text,comment:args.comment,version:'reply-created'}};}
 const old=notes.find(n=>n.id===args.annotation_id);return {annotation:{...(old||{id:args.annotation_id,page:args.page,type:args.type,text:args.text}),comment:args.comment,version:`v${calls.length}`}};
 }
 editor=w.PaperAnnotationEditor.create({api,persistence:{get:async()=>stored,put:async(key,value)=>saved.push(JSON.parse(JSON.stringify({key,value})))},getPaper:()=>active,getNotes:()=>notes,show:()=>{},changed:()=>ui?.decorate(),refresh:async(id,note)=>{if(id!==active.id)return;const index=notes.findIndex(n=>n.id===note.id);if(index>=0)notes[index]=note;else notes.push(note);render();},toast:(...args)=>messages.push(args)});
 ui=w.PaperCompanion.create({api,getPaper:()=>active,refreshAnnotations:async()=>true,beforeAsk:editor.beforeAsk,toast:(...args)=>messages.push(args)});ui.setAvailable(true);
 t.after(()=>{ui.dispose();dom.window.close();});
 return {w,editor,ui,notes,calls,saved,messages,render,timers,select:id=>{active={id,pdf:true};ui.sync();},async input(id,text){const r=w.document.querySelector(`[data-annotation-id="${id}"] textarea`);r.value=text;r.dispatchEvent(new w.Event('input'));return r;},async flush(){for(const [id,fn] of [...timers]){timers.delete(id);fn();}await tick();await tick();}};
}
test('rectangle release creates a native note automatically without a modal and retains an independent editor',async t=>{
 const f=fixture(t);assert.equal(await f.editor.create('square',{page:8,selection:{page:8,rects:[[1,2,30,40]]},color:'#112233',width:4}),true);
 const create=f.calls.find(c=>c.action==='annotate');assert.equal(create.type,'square');assert.equal(create.comment,'');assert.equal(create.companion_skip,true);assert.equal(create.width,4);
 assert.match(create.annotation_id,/^[a-f0-9-]{36}$/);assert.equal(f.w.document.querySelectorAll('textarea').length,1);assert.equal(f.w.document.querySelectorAll('dialog').length,0);
 const input=f.w.document.querySelector('textarea'),heading=f.w.document.querySelector('.annotation-inline-heading');
 assert.equal(heading.querySelector('label').control,input);assert.equal(heading.querySelector('[role="status"]').textContent,'已保存');
 assert.equal(f.calls.some(c=>c.action==='companion_ask'),false);assert.equal(f.saved.at(-1).value.drafts.length,0);
});
test('same passage supports separate notes, independent inputs and one selected ask with the latest saved version',async t=>{
 const f=fixture(t);const selection={page:1,text:'Synthetic shared quotation',rects:[[1,2,30,40]]};
 await Promise.all([f.editor.create('underline',{selection}),f.editor.create('underline',{selection})]);
 assert.equal(f.notes.length,2);assert.notEqual(f.notes[0].id,f.notes[1].id);
 const [a,b]=f.notes;await f.input(a.id,'Question A');await f.input(b.id,'Question B');
 f.w.document.querySelector(`[data-annotation-id="${a.id}"] .companion-ask`).click();await tick();await tick();
 const asks=f.calls.filter(c=>c.action==='companion_ask');assert.equal(asks.length,1);assert.equal(asks[0].annotation_id,a.id);
 const update=f.calls.find(c=>c.action==='annotation_update');assert.equal(update.comment,'Question A');assert.equal(update.companion_skip,true);assert.equal(asks[0].version,f.notes.find(n=>n.id===a.id).version);
 assert.equal(f.w.document.querySelector(`[data-annotation-id="${b.id}"] textarea`).value,'Question B');
});
test('typing while a create is pending never changes its retry body and saves the later text separately',async t=>{
 let release;const f=fixture(t,{request:action=>action==='annotate'?new Promise(resolve=>{release=resolve;}):undefined});
 const pending=f.editor.create('square',{page:2});await tick();const create=f.calls.find(c=>c.action==='annotate');
 await f.input(create.annotation_id,'New question');release({annotation:{id:create.annotation_id,page:2,type:'square',text:'',comment:'',version:'created'}});
 assert.equal(await pending,true);const update=f.calls.find(c=>c.action==='annotation_update');assert.equal(update.comment,'New question');assert.equal(update.version,'created');assert.equal(create.comment,'');
});
test('uncertain create retries the same ID and payload, with the input and geometry retained',async t=>{
 let fail=true;const f=fixture(t,{request:action=>{if(action==='annotate'&&fail)throw Error('response lost');}});
 assert.equal(await f.editor.create('square',{page:3,selection:{rects:[[1,2,30,40]]}}),false);
 const original=f.calls.find(c=>c.action==='annotate');await f.input(original.annotation_id,'Retained question');
 fail=false;await f.editor.beforeAsk('paper-a',original.annotation_id);
 const creates=f.calls.filter(c=>c.action==='annotate');assert.equal(creates.length,2);assert.deepEqual(creates[0],creates[1]);
 assert.equal(f.notes[0].comment,'Retained question');
});
test('failed saving blocks DSH and leaves only that draft retryable',async t=>{
 let fail=false;const f=fixture(t,{request:action=>{if(action==='annotation_update'&&fail)throw Error('version conflict');}});
 await f.editor.create('underline',{selection:{page:1,text:'Quote',rects:[[1,2,3,4]]}});fail=true;await f.input(f.notes[0].id,'Keep this question');
 f.w.document.querySelector('.companion-ask').click();await tick();await tick();
 assert.equal(f.calls.some(c=>c.action==='companion_ask'),false);assert.match(f.w.document.querySelector('.annotation-inline-status').textContent,/version conflict/);
 assert.equal(f.editor.pending()[0].comment,'Keep this question');assert.equal(f.w.document.querySelector('textarea').value,'Keep this question');
});
test('durable drafts restore over clean card values and never submit themselves to AI',async t=>{
 const note={id:'existing',page:4,type:'underline',text:'Quote',comment:'PDF value',version:'base'};
 const f=fixture(t,{stored:{drafts:[{note,comment:'Unsaved question',saved:'PDF value',payload:null}]}});f.notes.push(note);f.render();await f.editor.ready('paper-a');
 assert.equal(f.w.document.querySelector('textarea').value,'Unsaved question');assert.equal(f.editor.pending().length,1);assert.equal(f.calls.some(c=>c.action==='annotate'||c.action==='companion_ask'),false);
 await f.editor.beforeAsk('paper-a',note.id);assert.equal(f.calls.find(c=>c.action==='annotation_update').comment,'Unsaved question');
});
test('rerender preserves focused textarea and caret; switching papers keeps the captured save destination',async t=>{
 const f=fixture(t);await f.editor.create('note',{page:2,comment:'Original'});const note=f.notes[0],input=await f.input(note.id,'Changed');input.focus();input.setSelectionRange(2,4);f.render();assert.equal(f.w.document.activeElement,input);assert.equal(input.selectionStart,2);
 f.select('paper-b');await f.editor.beforeAsk('paper-a',note.id);assert.equal(f.calls.find(c=>c.action==='annotation_update').id,'paper-a');
});

test('restored draft retains its old version and conflict resolution requires an explicit comparison',async t=>{
 const original={id:'conflicted',page:1,type:'note',text:'',comment:'Old',version:'old'},latest={...original,comment:'Remote',version:'new'};
 let conflict=true;
 const f=fixture(t,{stored:{drafts:[{note:original,comment:'Mine',saved:'Old',payload:null}]},request:(action,args)=>{if(action==='annotations')return {annotations:[latest]};if(action==='annotation_update'&&conflict)throw Error('ANNOTATION_STALE');}});
 f.notes.push(latest);f.render();await f.editor.ready('paper-a');await assert.rejects(f.editor.beforeAsk('paper-a',original.id));
 assert.equal(f.calls.find(c=>c.action==='annotation_update').version,'old');
 const compare=[...f.w.document.querySelectorAll('button')].find(b=>b.textContent==='核对 PDF 备注');compare.click();await tick();assert.match(f.w.document.querySelector('.annotation-conflict').textContent,/Remote/);
 conflict=false;[...f.w.document.querySelectorAll('button')].find(b=>b.textContent==='用我的备注保存').click();await tick();await tick();
 assert.equal(f.calls.filter(c=>c.action==='annotation_update').at(-1).version,'new');assert.equal(f.notes[0].comment,'Mine');
});
test('long comments use the independent editing version and restored pending creates keep immutable identities',async t=>{
 const note={id:'long',page:1,type:'note',text:'',comment:'Long note',edit_version:'edit-hash'};
 const f=fixture(t);f.notes.push(note);f.render();await f.input(note.id,'Edited long note');await f.editor.beforeAsk('paper-a',note.id);
 assert.equal(f.calls.find(c=>c.action==='annotation_update').version,'edit-hash');
});

test('new remarks use native reply creation and nested independent asks flush only their own input',async t=>{
 const f=fixture(t);await f.editor.create('underline',{selection:{page:3,text:'Shared quote',rects:[[1,2,30,40]]}});const root=f.notes[0];
 await f.editor.create('reply',{note:root,page:root.page});await f.editor.create('reply',{note:root,page:root.page});
 assert.equal(f.calls.filter(c=>c.action==='annotate').length,1);assert.equal(f.calls.filter(c=>c.action==='annotation_reply_create').length,2);
 assert.equal(f.w.document.querySelectorAll('#annotation-list > .annotation-card').length,1);const remarks=f.w.document.querySelectorAll('.annotation-remark');assert.equal(remarks.length,2);assert.match(remarks[0].querySelector('label').textContent,/备注 2/);
 const reply=f.notes[1];await f.input(reply.id,'Follow up two');remarks[0].querySelector('.companion-ask').click();await tick();await tick();
 const asked=f.calls.filter(c=>c.action==='companion_ask');assert.equal(asked.length,1);assert.equal(asked[0].annotation_id,reply.id);assert.equal(f.notes.find(n=>n.id===reply.id).comment,'Follow up two');assert.equal(root.comment,'');
});

test('autosave and background rerenders keep the editing card connected, preserve IME and do not steal later focus',async t=>{
 const f=fixture(t);await f.editor.create('note',{page:9,comment:'Original'});
 const note=f.notes[0],input=await f.input(note.id,'正在输入新问题');input.focus();input.setSelectionRange(2,4);
 const list=f.w.document.getElementById('annotation-list'),card=input.closest('.annotation-card');list.scrollTop=240;
 let blurs=0;input.addEventListener('blur',()=>blurs++);
 input.dispatchEvent(new f.w.CompositionEvent('compositionstart'));
 f.render();f.editor.decorate();f.render();
 assert.equal(input.closest('.annotation-card'),card);assert.equal(card.isConnected,true);
 assert.equal(f.w.document.activeElement,input);assert.equal(input.selectionStart,2);assert.equal(blurs,0);assert.equal(list.scrollTop,240);
 input.dispatchEvent(new f.w.CompositionEvent('compositionend'));await f.flush();
 assert.equal(f.w.document.activeElement,input);assert.equal(input.closest('.annotation-card'),card);assert.equal(blurs,0);
 assert.equal(f.notes.find(n=>n.id===note.id).comment,'正在输入新问题');
 const other=f.w.document.createElement('input');f.w.document.body.append(other);other.focus();await f.flush();
 assert.equal(f.w.document.activeElement,other,'A completed save must not refocus its old textarea');
 assert.equal(list.scrollTop,240);assert.equal(list.querySelector('textarea').value,'正在输入新问题');
 assert.equal(card.isConnected,false,'Deferred updates render once editing ends');
});

test('empty remark remains collapsed until opened and nonempty remark remains visible',async t=>{
 const f=fixture(t);const empty={id:'blank',page:1,text:'Source',comment:'',version:'v'};f.notes.push(empty);f.render();
 const card=f.w.document.querySelector('[data-annotation-id="blank"]'),input=card.querySelector('textarea'),toggle=card.querySelector('.annotation-remark-expand');
 assert.equal(input.hidden,true);assert.equal(toggle.textContent,'添加备注');toggle.click();assert.equal(input.hidden,false);assert.equal(f.w.document.activeElement,input);
 input.value='A question';input.dispatchEvent(new f.w.Event('input',{bubbles:true}));assert.equal(input.hidden,false);
});
