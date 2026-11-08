import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{JSDOM}=require(process.env.JSDOM_MODULE||'jsdom');
const source=await readFile(new URL('../web/annotation-editor.js',import.meta.url),'utf8');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(t,api){
 const dom=new JSDOM('<div id="annotation-list"></div>',{url:'http://synthetic.invalid',runScripts:'outside-only'}),w=dom.window,calls=[];
 let visible,active='a';w.IntersectionObserver=class{constructor(fn){visible=fn;}observe(){}unobserve(){}disconnect(){}};
 w.eval(source);const ui=w.PaperAnnotationPreviews.create({getPaper:()=>({id:active}),api:(action,args)=>{calls.push({action,...args});return api(args);}});
 function render(notes){w.document.getElementById('annotation-list').innerHTML=notes.map(n=>`<article class="annotation-card" data-annotation-id="${n.id}"><div class="annotation-meta">Page</div></article>`).join('');ui.decorate(notes);}
 function reveal(){visible([...w.document.querySelectorAll('.annotation-region-preview')].map(target=>({target,isIntersecting:true})));}
 t.after(()=>dom.window.close());return {ui,w,calls,render,reveal,select:id=>active=id};
}
const result=args=>({annotation_id:args.annotation_id,page:args.page,width:100,height:80,mime_type:'image/png',image:'synthetic'});
test('rectangle previews are lazy and bounded to two simultaneous requests; other annotation types stay text-only',async t=>{
 const releases=[];const f=fixture(t,args=>new Promise(resolve=>releases.push(()=>resolve(result(args)))));
 f.render([{id:'a',type:'square',page:1},{id:'b',type:'square',page:2},{id:'c',type:'square',page:3},{id:'text',type:'underline',page:4}]);
 assert.equal(f.calls.length,0);assert.equal(f.w.document.querySelectorAll('.annotation-region-preview').length,3);f.reveal();assert.equal(f.calls.length,2);
 releases[0]();await tick();assert.equal(f.calls.length,3);releases[1]();releases[2]();await tick();assert.equal(f.w.document.querySelectorAll('img').length,3);
 const button=f.w.document.querySelector('.annotation-preview-open');assert.equal(button.dataset.noteAction,'page');assert.match(button.querySelector('img').alt,/矩形框内/);
});
test('rerender reuses current geometry preview and a changed annotation invalidates it',async t=>{
 const f=fixture(t,args=>Promise.resolve(result(args))),note={id:'a',type:'square',page:1,version:'v1'};
 f.render([note]);f.reveal();await tick();f.render([note]);f.reveal();await tick();assert.equal(f.calls.length,1);assert.equal(f.w.document.querySelectorAll('img').length,1);
 f.render([{...note,version:'v2'}]);f.reveal();await tick();assert.equal(f.calls.length,2);
});
test('preview errors have a retry button and stale paper responses cannot paint another paper',async t=>{
 let fail=true;const f=fixture(t,args=>fail?Promise.reject(Error('Offline')):Promise.resolve(result(args))),note={id:'a',type:'square',page:1};
 f.render([note]);f.reveal();await tick();assert.match(f.w.document.querySelector('.annotation-preview-status').textContent,/Offline/);assert.equal(f.w.document.querySelector('.annotation-preview-retry').hidden,false);
 fail=false;f.w.document.querySelector('.annotation-preview-retry').click();await tick();assert.equal(f.w.document.querySelectorAll('img').length,1);
 let release;const g=fixture(t,args=>new Promise(resolve=>{release=()=>resolve(result(args));}));g.render([note]);g.reveal();g.select('b');release();await tick();assert.equal(g.w.document.querySelectorAll('img').length,0);
});
