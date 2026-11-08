import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{JSDOM}=require(process.env.JSDOM_MODULE||'jsdom');
const source=await readFile(new URL('../web/annotation-editor.js',import.meta.url),'utf8');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(t,api){
 const dom=new JSDOM('<main></main>',{runScripts:'outside-only',url:'http://test.invalid'}),w=dom.window;let paper='a',enabled=true,notes=[];const saved=[];w.eval(source);
 const ui=w.PaperAnnotationCaptions.create({api,getPaper:()=>({id:paper}),getNotes:()=>notes,available:()=>enabled,saved:async(...args)=>saved.push(args)});
 const box=(note,version)=>{const element=w.document.createElement('div');w.document.querySelector('main').append(element);ui.decorate(element,note,version);return element;};
 t.after(()=>w.close());return {box,saved,paper:id=>paper=id,enabled:value=>enabled=value,notes:value=>notes=value};
}
test('captions use one concurrent request, deduplicate rerenders and skip existing native captions',async t=>{
 const calls=[],releases=[];const f=fixture(t,(action,args)=>{calls.push({action,...args});return new Promise(resolve=>releases.push(()=>resolve({saved:true,annotation:{id:'caption'}})));});
 const note={id:'n1',type:'square',page:1,rect:[1,2,30,40]};
 f.box(note);f.box(note);f.box({...note,id:'n2'});assert.equal(calls.length,1);assert.equal(calls[0].action,'annotation_caption');
 releases.shift()();await tick();assert.equal(calls.length,2);releases.shift()();await tick();assert.equal(f.saved.length,2);
 f.box(note);assert.equal(calls.length,2);
 f.notes([{id:'stored',source_kind:'annotation-caption',reply_to:'n3'}]);const stored=f.box({...note,id:'n3'});assert.equal(stored.children.length,0);
 f.enabled(false);f.box({...note,id:'n4'});assert.equal(calls.length,2);
});
test('caption failures require explicit retry and switching papers drops queued work and stale refresh',async t=>{
 const calls=[];let fail=true;
 const f=fixture(t,async(action,args)=>{calls.push(args);if(fail)throw Error('No vision');return {saved:true,annotation:{id:'reply'}};});
 const box=f.box({id:'n',type:'square',page:1});await tick();assert.match(box.textContent,/No vision/);assert.equal(calls.length,1);
 fail=false;box.querySelector('button').click();await tick();assert.equal(calls.length,2);assert.equal(calls[1].retry,true);assert.equal(f.saved.length,1);
 let release;const g=fixture(t,()=>new Promise(resolve=>release=resolve));g.box({id:'n1',page:1});g.box({id:'n2',page:1});g.paper('other');release({saved:true,annotation:{id:'reply'}});await tick();assert.equal(g.saved.length,0);
});

test('an old native caption does not suppress generation for a changed crop snapshot',async t=>{
 const calls=[];const f=fixture(t,async(action,args)=>{calls.push(args);return {saved:true,annotation:{id:'new'}};});
 f.notes([{id:'old',source_kind:'annotation-caption',reply_to:'n',source_message_id:'old-snapshot'}]);
 const note={id:'n',page:1,type:'square'};
 const unchanged=f.box(note,'old-snapshot');assert.equal(unchanged.children.length,0);
 f.box(note,'new-snapshot');await tick();assert.equal(calls.length,1);
});
