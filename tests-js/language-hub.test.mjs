import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{JSDOM}=require(process.env.JSDOM_MODULE||'jsdom');
const sources=await Promise.all(['encyclopedia.js','settings-models.js','language-learning.js'].map(file=>readFile(new URL('../web/'+file,import.meta.url),'utf8')));
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(t){
 const dom=new JSDOM('',{url:'https://synthetic.invalid',runScripts:'outside-only'}),w=dom.window,doc=w.document,calls=[],writes=[],messages=[];
 let paper={id:'paper-a',title:'Synthetic paper'},selection={id:'paper-a',page:3,text:'A synthetic sentence.'};
 w.HTMLDialogElement.prototype.showModal=function(){this.open=true;this.dataset.testModal='true';};w.HTMLDialogElement.prototype.show=function(){this.open=true;this.dataset.testModal='false';};w.HTMLDialogElement.prototype.close=function(){this.open=false;this.dispatchEvent(new w.Event('close'));};w.confirm=()=>true;
 w.PaperFloatingWindows={attach(element){assert.equal(element.tagName,'DIALOG','Embedded language tools must not create another floating window');return {refresh(){}};}};
 for(const source of sources)w.eval(source);
 const api=async(action,args={})=>{calls.push({action,...args});
  if(action==='language_settings_get')return {revision:'settings-1',value:{target_language:'zh-CN'},models:[]};
  if(action==='language_settings_update')return {revision:'settings-2',value:args.value};
  if(action==='language_generate')return {id:'result-a',paper_id:args.id,page:args.page,mode:args.mode,source_text:args.text,result:'合成的译文。',status:'complete',vocabulary:[]};
  if(action==='vocabulary_create')return {id:'word-a',term:args.term,meaning:'合成的',status:'learning',encounters:[{paper_id:args.id,page:args.page,quote:args.source_sentence,sentence_translation:'一个合成句子。'}]};
  return {items:[],total:0};
 };
 const wiki=w.PaperEncyclopedia.create({api,toast:()=>{},openReference:()=>{},getSource:()=>({paper_id:paper.id,title:paper.title,page:selection.page,quote:selection.text})});
 const language=w.PaperLanguageLearning.create({api,embedded:true,onOpen:next=>wiki.openLanguage(next),onClose:()=>wiki.close(),openVocabulary:()=>wiki.show('words'),getPaper:()=>paper,getSelection:()=>selection,toast:value=>messages.push(value),persistence:{get:async()=>null,put:async(...args)=>writes.push(args),flush:async()=>{}}});
 wiki.attachLanguage(language);language.setAvailable(true);
 const click=label=>[...doc.querySelectorAll('button')].find(button=>button.textContent===label).click();
 t.after(()=>{language.dispose();w.close();});
 return {w,doc,wiki,language,calls,writes,messages,click,open:()=>language.paperChanged(paper)};
}
test('language and vocabulary share one large dialog and one header navigation',async t=>{
 const f=fixture(t);await f.open();f.wiki.show('language');await tick();
 const dialog=f.doc.querySelector('.wiki-dialog');assert.equal(dialog.open,true);assert.equal(f.doc.querySelectorAll('dialog').length,1);assert.equal(dialog.querySelector('#language-panel'),f.language.element);
 assert.equal(f.language.element.hidden,true);assert.equal(f.doc.querySelector('.wiki-layout').hidden,false);
 assert.ok(dialog.querySelector('header .wiki-language-tabs'));assert.ok(dialog.querySelector('header #language-settings-open'));
 assert.equal(f.doc.querySelector('.language-heading').hidden,true);assert.equal(f.doc.querySelector('#language-tab-words').textContent,'词条');
 f.click('翻译与表述');assert.equal(f.language.element.hidden,false);assert.equal(f.doc.querySelector('.wiki-layout').hidden,true);assert.equal(f.doc.querySelector('.wiki-search').hidden,true);
 f.click('百科');await tick();assert.equal(f.language.element.hidden,true);assert.equal(f.doc.querySelector('.wiki-language-tabs').hidden,true);assert.equal(f.doc.querySelector('.wiki-layout').hidden,false);
 f.click('语言与词条');assert.equal(f.language.element.hidden,false);assert.equal(f.language.snapshot().view,'work');
});
test('translation draft DOM and text survive vocabulary, encyclopedia, close and reopen',async t=>{
 const f=fixture(t);await f.open();f.language.show();const input=f.doc.getElementById('language-source');input.value='My unfinished expression.';input.dispatchEvent(new f.w.Event('input'));
 f.click('词条');await tick();f.click('百科');await tick();f.click('语言与词条');await tick();f.click('翻译与表述');
 assert.equal(f.doc.getElementById('language-source'),input);assert.equal(input.value,'My unfinished expression.');f.wiki.close();f.language.show();assert.equal(input.value,'My unfinished expression.');assert.ok(f.writes.some(([,v])=>v.text==='My unfinished expression.'));
 assert.equal(f.calls.some(call=>call.action==='language_generate'),false);
});
test('selection translation uses unified dialog, original paper and page then opens word index',async t=>{
 const f=fixture(t);await f.language.useSelection('translate');
 assert.equal(f.doc.querySelector('.wiki-dialog').open,true);assert.equal(f.doc.querySelectorAll('#language-panel').length,1);assert.equal(f.language.element.parentElement,f.doc.querySelector('.wiki-dialog'));
 const call=f.calls.find(call=>call.action==='language_generate');assert.equal(call.id,'paper-a');assert.equal(call.page,3);assert.equal(call.text,'A synthetic sentence.');assert.match(f.doc.getElementById('language-result').textContent,/合成的译文/);
 f.doc.getElementById('language-result-words').click();await tick();assert.equal(f.language.element.hidden,true);assert.equal(f.doc.querySelector('.wiki-layout').hidden,false);assert.ok(f.calls.some(call=>call.action==='vocabulary_list'));
});
test('shared settings button loads and saves original language settings without a second window',async t=>{
 const f=fixture(t);await f.open();f.wiki.show('language');await tick();f.doc.getElementById('language-settings-open').click();await tick();assert.equal(f.language.snapshot().view,'settings');assert.equal(f.doc.getElementById('language-settings').hidden,false);
 f.doc.getElementById('language-settings-translate').value='Keep abbreviations.';f.doc.getElementById('language-settings-save').click();await tick();const saved=f.calls.find(call=>call.action==='language_settings_update');assert.equal(saved.expected_revision,'settings-1');assert.equal(saved.value.translate_prompt,'Keep abbreviations.');assert.equal(f.doc.querySelectorAll('dialog').length,1);
});
test('new vocabulary still saves a bilingual paper association inside the unified workspace',async t=>{
 const f=fixture(t);await f.open();f.wiki.show('language');await tick();f.click('新建词条');const form=f.doc.querySelector('.wiki-word-form');form.querySelector('input').value='synthetic';form.dispatchEvent(new f.w.Event('submit',{cancelable:true}));await tick();
 const call=f.calls.find(call=>call.action==='vocabulary_create');assert.equal(call.id,'paper-a');assert.equal(call.page,3);assert.equal(call.source_sentence,'A synthetic sentence.');assert.equal(f.doc.querySelectorAll('.wiki-bilingual>div').length,2);
});
test('declining to discard an edited word prevents selection translation from silently generating',async t=>{
 const f=fixture(t);await f.open();f.wiki.show('language');await tick();f.click('新建词条');const form=f.doc.querySelector('.wiki-word-form');form.querySelector('input').dispatchEvent(new f.w.Event('input',{bubbles:true}));f.w.confirm=()=>false;
 await f.language.useSelection('translate');assert.equal(f.calls.some(call=>call.action==='language_generate'),false);assert.equal(f.doc.querySelector('.wiki-word-form'),form);assert.equal(f.language.element.hidden,true);
});


test('shared floating geometry cannot resurrect the embedded panel as a small independent window',async t=>{
 const f=fixture(t);await f.open();f.w.eval(await readFile(new URL('../web/floating-windows.js',import.meta.url),'utf8'));const manager=f.w.PaperFloatingWindows.start();
 try{f.language.show();await tick();assert.equal(f.w.PaperFloatingWindows.attach(f.language.element),null);assert.equal(f.language.element.querySelector('.paper-floating-grip'),null);assert.equal(f.language.element.style.position,'');assert.ok(f.doc.querySelector('.wiki-header>.paper-floating-grip'));}finally{manager.dispose();}
});

test('side window uses nonmodal presentation and preserves translation draft through docking',async t=>{
 const f=fixture(t);await f.open();f.language.show();const dialog=f.doc.querySelector('.wiki-dialog'),input=f.doc.getElementById('language-source'),toggle=f.doc.getElementById('wiki-dock');
 input.value='Unfinished expression to keep.';input.dispatchEvent(new f.w.Event('input'));
 assert.equal(dialog.dataset.testModal,'true');toggle.click();assert.equal(dialog.dataset.testModal,'false');assert.equal(dialog.getAttribute('aria-modal'),'false');assert.ok(dialog.classList.contains('wiki-docked'));assert.equal(toggle.textContent,'大窗口');assert.equal(f.doc.getElementById('language-source'),input);assert.equal(input.value,'Unfinished expression to keep.');
 toggle.click();assert.equal(dialog.dataset.testModal,'true');assert.equal(dialog.getAttribute('aria-modal'),'true');assert.equal(input.value,'Unfinished expression to keep.');assert.equal(f.calls.some(call=>call.action==='language_generate'),false);
});

test('docked mode survives close and selection translation; Escape closes without losing draft',async t=>{
 const f=fixture(t);await f.open();f.language.show();const dialog=f.doc.querySelector('.wiki-dialog');f.doc.getElementById('wiki-dock').click();
 f.doc.dispatchEvent(new f.w.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));assert.equal(dialog.open,false);await f.language.useSelection('translate');assert.equal(dialog.open,true);assert.equal(dialog.dataset.testModal,'false');assert.equal(f.calls.filter(call=>call.action==='language_generate').length,1);
 const formInput=f.doc.getElementById('language-source');formInput.value='A draft after translation';formInput.dispatchEvent(new f.w.Event('input'));f.doc.dispatchEvent(new f.w.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));f.language.show();assert.equal(formInput.value,'A draft after translation');
});

test('docking does not discard edited vocabulary and preserves its close confirmation',async t=>{
 const f=fixture(t);await f.open();f.wiki.show('language');await tick();f.click('新建词条');const form=f.doc.querySelector('.wiki-word-form'),input=form.querySelector('input');input.value='unsaved term';input.dispatchEvent(new f.w.Event('input',{bubbles:true}));f.w.confirm=()=>false;
 f.doc.getElementById('wiki-dock').click();assert.equal(f.doc.querySelector('.wiki-word-form'),form);assert.equal(input.value,'unsaved term');f.doc.dispatchEvent(new f.w.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));assert.equal(f.doc.querySelector('.wiki-dialog').open,true);
});

test('floating geometry is suspended in side mode and large-window placement remains available',async t=>{
 const f=fixture(t);await f.open();f.w.eval(await readFile(new URL('../web/floating-windows.js',import.meta.url),'utf8'));const manager=f.w.PaperFloatingWindows.start();
 try{f.language.show();await tick();const dialog=f.doc.querySelector('.wiki-dialog'),grip=dialog.querySelector('.paper-floating-grip');f.doc.getElementById('wiki-dock').click();await tick();assert.equal(grip.disabled,true);assert.equal(dialog.style.left,'');assert.equal(dialog.style.width,'');f.doc.getElementById('wiki-dock').click();await tick();assert.equal(grip.disabled,false);}finally{manager.dispose();}
});
