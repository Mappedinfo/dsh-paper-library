/** Synthetic annotation actions and persistent warning presentation. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
let JSDOM;try{({JSDOM}=require(process.env.JSDOM_MODULE||'jsdom'));}catch{}
const source=await readFile(new URL('../web/app.js',import.meta.url),'utf8');
const html=await readFile(new URL('../web/index.html',import.meta.url),'utf8');
const css=await readFile(new URL('../web/style.css',import.meta.url),'utf8');
const localCss=await readFile(new URL('../web/language-learning.css',import.meta.url),'utf8');
function fixture(){
  const dom=new JSDOM(html,{runScripts:'outside-only',url:'http://synthetic.invalid/'}),{window}=dom,document=window.document;
  const copied=[],messages=[];
  Object.assign(window,{state:{active:{id:'paper-a'},annotations:[],noteOffset:0},$:(id)=>document.getElementById(id),el:(tag,cls,text)=>{const e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined)e.textContent=text;return e;},linkedHandwritingUI:null,handwritingUI:null,companionUI:null,annotationTranslationAvailable:false,displayDate:()=>'',toast:(message)=>messages.push(message),paperChatUI:{available:()=>true,hasAnnotation:()=>false},wikiUI:{show(){}},openDialog:id=>document.getElementById(id).setAttribute('open','')});
  Object.defineProperty(window.navigator,'clipboard',{configurable:true,value:{writeText:async text=>copied.push(text)}});
  window.eval(source.slice(source.indexOf('function annotationThreads('),source.indexOf('/** 自动着色')));
  window.eval(source.slice(source.indexOf('async function handleNoteAction('),source.indexOf('function fileBase64(')));
  window.eval(source.slice(source.indexOf('async function copyText('),source.indexOf('async function cite(')));
  return {dom,window,document,copied,messages};
}
test('copy source stays beside delete and copies only exact PDF text; missing source stays disabled', {skip:!JSDOM}, async()=>{
  const f=fixture(),{window,document}=f;
  window.state.annotations=[{id:'a',page:1,type:'underline',text:'  Original PDF text.\nSecond line. ',comment:'Private interpretation'},{id:'b',page:2,type:'note',text:'',comment:'Comment without a source quotation'}];
  window.renderAnnotations();
  const card=document.querySelector('[data-annotation-id="a"]'),button=card.querySelector('[data-note-action="copy-source"]');
  assert.equal(button.previousElementSibling.dataset.noteAction,'delete');
  assert.deepEqual([...card.querySelector('.annotation-primary-actions').children].map(b=>b.textContent),['手写','编辑']);
  await window.handleNoteAction({target:button});assert.deepEqual(f.copied,['  Original PDF text.\nSecond line. ']);
  const missing=document.querySelector('[data-annotation-id="b"] [data-note-action="copy-source"]');assert.equal(missing.disabled,true);assert.match(missing.title,/没有选中/);
  await window.handleNoteAction({target:missing});assert.equal(f.copied.length,1);
  const discuss=card.querySelector('[data-note-action="discuss"]');assert.equal(discuss.textContent,'选作提问材料');assert.equal(discuss.getAttribute('aria-pressed'),'false');assert.match(discuss.title,/不会发送消息/);
  window.paperChatUI.hasAnnotation=()=>true;window.renderAnnotations();assert.equal(document.querySelector('[data-note-action="discuss"]').getAttribute('aria-pressed'),'true');
  domClose(f);
});
test('clipboard failure offers the same original text in the existing manual copy dialog', {skip:!JSDOM},async()=>{
  const f=fixture();f.window.navigator.clipboard.writeText=async()=>{throw Error('Denied')};
  f.window.state.annotations=[{id:'a',page:1,type:'underline',text:'Exact source',comment:'Never copy me'}];f.window.renderAnnotations();
  await f.window.handleNoteAction({target:f.document.querySelector('[data-note-action="copy-source"]')});
  assert.equal(f.document.getElementById('copy-fallback').value,'Exact source');assert.equal(f.document.getElementById('text-dialog-title').textContent,'批注原文');assert.equal(f.document.getElementById('text-dialog').open,true);assert.equal(f.messages.length,0);domClose(f);
});
test('toast and unsaved warning share a stacked region; pending retries retain the warning until confirmed saved', {skip:!JSDOM},async()=>{
  const f=fixture(),{window,document}=f;let notify,flushes=0;
  window.persistence={subscribe:fn=>{notify=fn},flush:async()=>{flushes++},exportPending:()=>[{key:'draft',value:'Unchanged draft'}]};
  window.eval(source.slice(source.indexOf('if(persistence){\n  let legacyOffset'),source.indexOf("window.addEventListener('pagehide'")));
  const warning=document.getElementById('local-save-status'),toast=document.getElementById('toast'),region=document.getElementById('notification-region');
  assert.equal(warning.parentElement,region);assert.equal(toast.parentElement,region);assert.equal(region.children[0],toast);assert.equal(region.children[1],warning);
  notify({key:'draft',status:'error',error:Error('Offline')});assert.equal(warning.hidden,false);assert.match(warning.textContent,/Offline/);
  notify({key:'draft',status:'pending'});assert.equal(warning.hidden,false);assert.match(warning.textContent,/Offline/);
  warning.querySelector('button').click();assert.equal(flushes,1);assert.equal(warning.hidden,false);
  notify({key:'draft',status:'saved'});assert.equal(warning.hidden,true);
  assert.match(css,/\.notification-region\s*\{[^}]*display:\s*flex;[^}]*flex-direction:\s*column;/);assert.match(css,/\.toast\s*\{\s*position:\s*static;/);assert.match(localCss,/\.local-save-status\{position:static;/);domClose(f);
});
function domClose(f){f.dom.window.close();}

test('human remarks render below one quote; AI replies preview six lines and pager lives in the header host',async()=>{
 const f=fixture(),{window:w,document:d}=f;
 w.eval(await readFile(new URL('../web/annotation-threads.js',import.meta.url),'utf8'));
 const pager=d.createElement('div');pager.id='annotation-pagination';d.body.prepend(pager);
 w.state.annotations=[{id:'root',type:'underline',text:'Same original',page:1},{id:'r2',kind:'reader-reply',reply_to:'root',text:'Same original',comment:'Follow up',page:1},{id:'ai',kind:'ai-feedback',reply_to:'r2',comment:'Long answer\n'.repeat(20),page:1},...Array.from({length:40},(_,i)=>({id:`other${i}`,type:'underline',page:2,text:'Other original'}))];
 w.renderAnnotations();assert.equal(d.querySelectorAll('#annotation-list > .annotation-card').length,40);assert.equal(d.querySelectorAll('[data-annotation-id="root"] > .annotation-quote').length,1);
 const remark=d.querySelector('.annotation-remark');assert.equal(remark.dataset.remarkNumber,'2');const reply=remark.querySelector('.annotation-reply');assert.equal(reply.open,true);assert.equal(reply.querySelector('.annotation-reply-body').classList.contains('is-preview'),true);
 const expand=[...reply.querySelectorAll('button')].find(n=>n.textContent==='展开全文');expand.click();assert.equal(reply.querySelector('.annotation-reply-body').classList.contains('is-preview'),false);
 assert.equal(d.querySelector('#annotation-list .pagination'),null);assert.equal(pager.querySelector('.pagination').textContent,'‹1/2›');
 await w.handleNoteAction({target:pager.querySelector('[data-note-action="next"]')});assert.equal(w.state.noteOffset,40);assert.equal(d.querySelectorAll('#annotation-list > .annotation-card').length,1);domClose(f);
});
