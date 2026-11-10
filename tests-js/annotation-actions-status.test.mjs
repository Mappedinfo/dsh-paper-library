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
  Object.assign(window,{state:{active:{id:'paper-a'},annotations:[],noteOffset:0},$:(id)=>document.getElementById(id),el:(tag,cls,text)=>{const e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined)e.textContent=text;return e;},readerSearchUI:null,linkedHandwritingUI:null,handwritingUI:null,companionUI:null,annotationTranslationAvailable:false,displayDate:()=>'',toast:(message)=>messages.push(message),paperChatUI:{available:()=>true,hasAnnotation:()=>false},wikiUI:{show(){}},openDialog:id=>document.getElementById(id).setAttribute('open','')});
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
 w.renderAnnotations();assert.equal(d.querySelectorAll('#annotation-list > .annotation-card').length,40);assert.equal(d.querySelectorAll('[data-annotation-id="root"] > .annotation-excerpt > .annotation-quote').length,1);
 const remark=d.querySelector('.annotation-remark');assert.equal(remark.dataset.remarkNumber,'2');const reply=remark.querySelector('.annotation-reply');assert.equal(reply.open,true);assert.equal(reply.querySelector('.annotation-reply-body').classList.contains('is-preview'),true);
 const expand=[...reply.querySelectorAll('button')].find(n=>n.textContent==='展开全文');expand.click();assert.equal(reply.querySelector('.annotation-reply-body').classList.contains('is-preview'),false);
 assert.equal(d.querySelector('#annotation-list .pagination'),null);assert.equal(pager.querySelector('.pagination').textContent,'‹1/2›');
 await w.handleNoteAction({target:pager.querySelector('[data-note-action="next"]')});assert.equal(w.state.noteOffset,40);assert.equal(d.querySelectorAll('#annotation-list > .annotation-card').length,1);domClose(f);
});

test('AI reply copies full text and selected reply text becomes a new remark on the same underline', {skip:!JSDOM}, async()=>{
 const f=fixture(),{window:w,document:d}=f,created=[];
 w.annotationEditor={beforeRender:()=>()=>{},decorate(){},create:async(...args)=>created.push(args)};
 w.state.annotations=[{id:'root',page:2,type:'underline',text:'Original source'},{id:'ai',page:2,kind:'ai-feedback',ai_generated:true,reply_to:'root',annotation_ids:['root'],comment:'First sentence.\nSecond sentence.'}];
 w.renderAnnotations();const reply=d.querySelector('.annotation-reply'),buttons=[...reply.querySelectorAll('button')];
 buttons.find(b=>b.textContent==='复制回复').click();await new Promise(r=>setImmediate(r));assert.deepEqual(f.copied,['First sentence.\nSecond sentence.']);
 const rendered=reply.querySelector('.annotation-reply-body'),range=d.createRange();range.setStart(rendered.firstChild,0);range.setEnd(rendered.firstChild,15);w.getSelection().addRange(range);
 buttons.find(b=>b.textContent==='引用并追问').click();assert.equal(created[0][0],'reply');assert.equal(created[0][1].note.id,'root');assert.match(created[0][1].comment,/> First sentence\./);assert.doesNotMatch(created[0][1].comment,/Second sentence/);
 assert.equal(d.querySelector('.annotation-quote').tagName,'P');assert.equal(d.querySelector('.annotation-excerpt [data-note-action="page"]').textContent,'定位');domClose(f);
});

test('annotation search filters whole threads before pagination and has a truthful empty result', {skip:!JSDOM},async()=>{const f=fixture();try{const w=f.window;w.eval(await readFile(new URL('../web/reader-search.js',import.meta.url),'utf8'));w.state.annotations=Array.from({length:45},(_,i)=>({id:'a'+i,page:1,type:'underline',text:'Source '+i,comment:i===44?'needle':'other'}));w.state.noteOffset=40;w.readerSearchUI={filter:g=>w.PaperReaderSearch.filterThreads(g,'needle')};w.renderAnnotations();assert.equal(w.state.noteOffset,0);assert.equal(f.document.querySelectorAll('.annotation-card').length,1);assert.equal(f.document.querySelector('.annotation-card').dataset.annotationId,'a44');w.readerSearchUI={filter:g=>w.PaperReaderSearch.filterThreads(g,'missing')};w.renderAnnotations();assert.match(f.document.getElementById('annotation-list').textContent,/没有匹配的批注/);assert.doesNotMatch(f.document.getElementById('annotation-list').textContent,/第一条批注/);}finally{f.dom.window.close();}});

test('locate current page clears filtering, opens the rail and crosses pagination without moving PDF', {skip:!JSDOM},()=>{
 const f=fixture(),w=f.window,d=f.document;try{
 let filtered=true,opened=false;const scrolls=[];
 w.HTMLElement.prototype.scrollIntoView=function(options){scrolls.push([this.dataset.annotationId,options.block]);};
 w.state.active.pdf=true;w.state.page=1;w.state.annotations=Array.from({length:45},(_,i)=>({id:'a'+i,page:i+1,type:'underline',text:'Source '+i}));
 w.pdfReader={getSnapshot:()=>({paperId:'paper-a',page:43}),goTo:()=>assert.fail('PDF must not navigate')};
 w.readingPanels={show:name=>{assert.equal(name,'annotations');opened=true;},visible:()=>opened};
 w.readerSearchUI={filter:g=>filtered?{...g,notes:g.notes.slice(0,1)}:g,clearAnnotationFilter:()=>{filtered=false;}};
 w.eval(source.slice(source.indexOf('let annotationLinkTimer ='),source.indexOf('async function handleNoteAction(')));
 w.locateCurrentPageAnnotations();assert.equal(opened,true);assert.equal(filtered,false);assert.equal(w.state.noteOffset,40);assert.deepEqual(scrolls,[['a42','start']]);assert.equal(d.querySelector('.is-linked').dataset.annotationId,'a42');assert.equal(w.state.page,1);
 }finally{w.close();}
});
test('locate nearest annotation prefers preceding page on a tie and reports absent page metadata', {skip:!JSDOM},()=>{
 const f=fixture(),w=f.window;try{
 w.HTMLElement.prototype.scrollIntoView=function(){};w.state.active.pdf=true;w.state.page=15;
 w.pdfReader={getSnapshot:()=>({paperId:'another-paper',page:3})};w.readingPanels={show(){},visible:()=>true};
 w.state.annotations=[{id:'later',page:17,type:'underline',text:'Later'},{id:'earlier',page:13,type:'underline',text:'Earlier'},{id:'bad',page:0,type:'note',comment:'No page'}];
 w.eval(source.slice(source.indexOf('let annotationLinkTimer ='),source.indexOf('async function handleNoteAction(')));
 w.locateCurrentPageAnnotations();assert.equal(f.document.querySelector('.is-linked').dataset.annotationId,'earlier');assert.match(f.messages.at(-1),/第 13 页.*最近/);
 w.state.annotations=[{id:'bad',page:0}];w.locateCurrentPageAnnotations();assert.match(f.messages.at(-1),/暂无可定位/);
 }finally{w.close();}
});

test('translation stays beside its source and expands from the excerpt heading', {skip:!JSDOM},async()=>{
 const f=fixture(),w=f.window,d=f.document;
 try{
  w.state.annotations=[{id:'root',page:1,type:'underline',text:'Source',edit_version:'a'.repeat(64),source:'paper-library'}, {id:'t',page:1,kind:'ai-feedback',source_kind:'annotation-translation',reply_to:'root',comment:'翻译：译文',model:'fixture'}];
  w.renderAnnotations();const card=d.querySelector('.annotation-card'),excerpt=card.querySelector('.annotation-excerpt'),translation=excerpt.querySelector('.annotation-translations');
  assert.equal(translation.hidden,true);assert.equal(card.querySelector(':scope > .annotation-reply'),null);
  const toggle=[...excerpt.querySelectorAll('button')].find(b=>b.textContent==='展开翻译');toggle.click();assert.equal(translation.hidden,false);assert.match(translation.textContent,/译文/);assert.equal(toggle.getAttribute('aria-expanded'),'true');
  assert.equal(excerpt.querySelector('[data-note-action=reselect]').textContent,'编辑原文范围');w.renderAnnotations();assert.equal(d.querySelector('.annotation-translations').hidden,false);
 }finally{f.dom.window.close();}
});

test('range handles update the draft without writing until the user saves', {skip:!JSDOM},async()=>{
 const f=fixture(),w=f.window,d=f.document,calls=[];
 try {
  let moveHandle, closed=0, failSave=true;
  w.annotationRangeEdit=null;
  w.state.annotations=[{id:'root',page:1,type:'underline',text:'Original',edit_version:'v',rects:[[1,2,3,4]]}];
  w.pdfReader={startRangeEdit:async(note,onChange)=>{assert.equal(note.id,'root');moveHandle=onChange;return true;},endRangeEdit:()=>closed++};
  w.switchTab=async()=>{};w.readingShell={setTool:()=>{}};
  w.api=async(action,args)=>{calls.push({action,args});if(failSave)throw Error('Temporary error');};w.loadAnnotations=async()=>{};w.refreshPage=async()=>{};w.clearSelection=()=>{w.state.selection=null};
  w.eval(source.slice(source.indexOf('async function handleNoteAction('),source.indexOf('function fileBase64('))
    + source.slice(source.indexOf('const rangeEditBar='),source.indexOf('outlineUI=window.PaperOutline')));
  w.renderAnnotations();
  w.annotationEditor={beforeAsk:async()=>undefined};
  const edit=d.querySelector('[data-note-action=reselect]'),bar=d.querySelector('.annotation-range-edit'),[save,cancel]=bar.querySelectorAll('button');
  await w.handleNoteAction({target:edit});
  assert.equal(bar.hidden,false);assert.equal(save.disabled,true);
  moveHandle({id:'paper-a',page:2,text:'Other',rects:[[1,2,3,4]]});assert.equal(save.disabled,true);
  moveHandle({id:'paper-a',page:1,text:'New source',rects:[[1,2,3,4]]});
  assert.equal(save.disabled,false);assert.equal(calls.length,0);
  save.click();await new Promise(r=>setImmediate(r));
  assert.equal(save.disabled,false);assert.match(f.messages.at(-1),/Temporary error/);
  failSave=false;save.click();await new Promise(r=>setImmediate(r));
  assert.equal(calls[1].action,'annotation_reselect');assert.equal(calls[1].args.expected_version,'v');assert.equal(calls[1].args.text,'New source');assert.equal(w.annotationRangeEdit,null);
  await w.handleNoteAction({target:edit});cancel.click();
  assert.equal(w.annotationRangeEdit,null);assert.equal(bar.hidden,true);assert.ok(closed);assert.equal(calls.length,2);
 } finally {f.dom.window.close();}
});

test('PDF range handles extend and shrink a saved selection with pointer input', {skip:!JSDOM}, async () => {
  const dom = new JSDOM('<div id="reader"></div>', { runScripts:'outside-only' });
  const w = dom.window, root = w.document.getElementById('reader');
  const rect = (left, top, right, bottom) => ({ left, top, right, bottom, width: right-left, height: bottom-top });
  Object.defineProperties(root, { clientWidth: { value: 424 }, clientHeight: { value: 400 } });
  w.ResizeObserver = class { observe() {} disconnect() {} };
  w.HTMLElement.prototype.getBoundingClientRect = function () {
    if (this.matches('.pdr-word')) return rect(...JSON.parse(this.dataset.rect));
    if (this.matches('.pdr-range-handle')) {
      const x = parseFloat(this.style.left) * 4, y = parseFloat(this.style.top) * 4;
      return this.matches('.pdr-range-start') ? rect(x-22,y-12,x,y+12) : rect(x,y-12,x+22,y+12);
    }
    return rect(0,0,400,400);
  };
  w.HTMLElement.prototype.setPointerCapture = function () {};
  w.Range.prototype.getClientRects = () => [];
  const words = [[20,40,50,50,'One'], [55,40,85,50,'Two'], [90,40,140,50,'Three']];
  const note = { id:'root', page:1, type:'underline', text:'Two', rects:[[55,40,85,50]] };
  const paper = { id:'paper-a', pdf:true }, changes = [];
  w.document.caretPositionFromPoint = x => {
    const index = x < 55 ? 0 : x < 90 ? 1 : 2;
    const offsetNode = root.querySelectorAll('.pdf-word-text')[index].firstChild;
    return { offsetNode, offset: x <= words[index][0] ? 0 : offsetNode.length };
  };
  w.eval(await readFile(new URL('../web/pdf-reader.js',import.meta.url),'utf8'));
  const reader = w.PaperPDFReader.create({ root, getPaper:()=>paper, api:async()=>({
    page:1, page_count:1, width:400, height:400, image:'', scale:1, words, annotations:[note],
    layout:{ page_count:1, pages:[{ page:1, width:400, height:400 }] },
  }) });
  try {
    await reader.open(paper);
    assert.equal(await reader.startRangeEdit(note,draft=>changes.push(draft?.text)),true);
    const [start,end] = root.querySelectorAll('.pdr-range-handle');
    const drag = (handle, from, to) => {
      for (const [type,clientX] of [['pointerdown',from],['pointermove',to],['pointerup',to]]) {
        const event = new w.MouseEvent(type,{bubbles:true,clientX,clientY:45});
        Object.defineProperty(event,'pointerId',{value:1});
        handle.dispatchEvent(event);
      }
    };
    drag(end,95,150);
    assert.equal(changes.at(-1),'Two Three');
    drag(start,45,8);
    assert.equal(changes.at(-1),'One Two Three');
    drag(end,150,95);
    assert.equal(changes.at(-1),'One Two');
    reader.endRangeEdit();
    assert.equal(root.querySelector('.pdr-range-edit'),null);
  } finally { reader.dispose(); dom.window.close(); }
});
