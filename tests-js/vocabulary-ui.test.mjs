import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{JSDOM}=require(process.env.JSDOM_MODULE||'jsdom');
const script=await readFile(new URL('../web/encyclopedia.js',import.meta.url),'utf8');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(t,create,{source={paper_id:'synthetic',title:'Synthetic paper',page:2,quote:'A synthetic sentence.'},items=[]}={}){
 const dom=new JSDOM('',{url:'https://synthetic.invalid',runScripts:'outside-only'}),w=dom.window,calls=[],jumps=[];
 w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};w.HTMLDialogElement.prototype.close=function(){this.open=false;};w.confirm=()=>true;
 w.eval(script);const ui=w.PaperEncyclopedia.create({getSource:()=>source,toast:()=>{},openReference:ref=>jumps.push(ref),api:async(action,args)=>{calls.push({action,...args});if(action.endsWith('_list'))return {items,total:items.length};return create(args);}});
 t.after(()=>w.close());return {w,ui,calls,jumps,click:label=>[...w.document.querySelectorAll('button')].find(n=>n.textContent===label).click(),input:label=>[...w.document.querySelectorAll('label')].find(n=>n.firstChild.textContent===label).querySelector('input,textarea'),submit:()=>w.document.querySelector('.wiki-word-form').dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}))};
}
const result=args=>({id:'word',term:args.term,meaning:'合成的',meaning_source:'ai',status:'learning',encounters:[{paper_id:args.id,title:'Synthetic paper',page:args.page,source_sentence:args.source_sentence,sentence_translation:'一个合成句子。',author_background:args.author_background,model:{provider:'synthetic',model:'mock'}}]});
test('new word remains in vocabulary, sends source and displays bilingual encounter with source navigation',async t=>{
 const f=fixture(t,async args=>result(args));f.ui.show('words');await tick();f.click('新建词条');
 assert.match(f.w.document.querySelector('.wiki-article h2').textContent,/新建难词/);
 f.input('难词或短语').value='synthetic';assert.equal(f.input('PDF 页码').value,'2');f.submit();await tick();
 const req=f.calls.find(x=>x.action==='vocabulary_create');assert.equal(req.id,'synthetic');assert.equal(req.source_sentence,'A synthetic sentence.');assert.equal(req.author_background.kind,'unknown');
 assert.equal(f.w.document.querySelectorAll('.wiki-bilingual>div').length,2);assert.match(f.w.document.querySelector('.wiki-article').textContent,/作者语言背景未知/);f.click('Synthetic paper · 第 2 页');assert.equal(f.jumps[0].paperId,'synthetic');
 assert.equal(f.calls.some(x=>x.action==='encyclopedia_put'),false);
});
test('failed create retains inputs and request identity; changed inputs get a new identity',async t=>{
 const f=fixture(t,async()=>{throw Error('保存未完成');});f.ui.show('words');await tick();f.click('新建词条');f.input('难词或短语').value='synthetic';
 f.submit();await tick();f.submit();await tick();let req=f.calls.filter(x=>x.action==='vocabulary_create');assert.equal(req[0].request_id,req[1].request_id);assert.equal(f.input('难词或短语').value,'synthetic');
 f.input('原句（保留原文，需包含上方词条）').value='Another synthetic sentence.';f.submit();await tick();req=f.calls.filter(x=>x.action==='vocabulary_create');assert.notEqual(req[1].request_id,req[2].request_id);
});
test('author background needs explicit evidence and labels it as user-supplied, not inferred',async t=>{
 const f=fixture(t,async args=>result(args));f.ui.show('words');await tick();f.click('新建词条');f.input('难词或短语').value='synthetic';f.w.document.querySelector('[aria-label="作者语言背景"]').value='mixed';f.submit();await tick();assert.equal(f.calls.filter(x=>x.action==='vocabulary_create').length,0);
 f.input('核实依据（如作者自述或介绍链接）').value='Synthetic author self-description';f.submit();await tick();assert.match(f.w.document.querySelector('.wiki-article').textContent,/混合语言背景作者 · 用户注明/);
});
test('late create result cannot replace a different tab and duplicate submits send only once',async t=>{
 let release;const f=fixture(t,args=>new Promise(resolve=>release=()=>resolve(result(args))));f.ui.show('words');await tick();f.click('新建词条');f.input('难词或短语').value='synthetic';f.submit();f.submit();assert.equal(f.calls.filter(x=>x.action==='vocabulary_create').length,1);
 f.click('百科');await tick();release();await tick();assert.match(f.w.document.querySelector('.wiki-article').textContent,/创建百科词条/);assert.equal(f.w.document.querySelector('.wiki-bilingual'),null);
});
test('without a paper the UI requests a source rather than creating a fabricated association',async t=>{
 const f=fixture(t,()=>{}, {source:null});f.ui.show('words');await tick();f.click('新建词条');assert.match(f.w.document.querySelector('.wiki-article').textContent,/请先打开来源论文/);assert.equal(f.w.document.querySelector('.wiki-word-form'),null);
});
