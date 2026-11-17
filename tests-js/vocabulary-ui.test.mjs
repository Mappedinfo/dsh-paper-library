import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{JSDOM}=require(process.env.JSDOM_MODULE||'jsdom');
const script=await readFile(new URL('../web/encyclopedia.js',import.meta.url),'utf8');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(t,create,{source={paper_id:'synthetic',title:'Synthetic paper',page:2,quote:'A synthetic sentence.'},items=[],sync=()=>({hasMore:false}),searchUsage}={}){
 const dom=new JSDOM('',{url:'https://synthetic.invalid',runScripts:'outside-only'}),w=dom.window,calls=[],jumps=[];
 w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};w.HTMLDialogElement.prototype.close=function(){this.open=false;};w.confirm=()=>true;
 w.eval(script);const ui=w.PaperEncyclopedia.create({getSource:()=>source,toast:()=>{},openReference:ref=>jumps.push(ref),searchUsage,api:async(action,args)=>{calls.push({action,...args});if(action==='language_vocabulary_sync')return sync(args);if(action.endsWith('_list'))return {items,total:items.length};return create(args);}});
 t.after(()=>w.close());return {w,ui,calls,jumps,click:label=>[...w.document.querySelectorAll('button')].find(n=>n.textContent===label).click(),input:label=>[...w.document.querySelectorAll('label')].find(n=>n.firstChild.textContent===label).querySelector('input,textarea'),submit:()=>w.document.querySelector('.wiki-word-form').dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}))};
}
const result=args=>({id:'word',term:args.term,meaning:'合成的',meaning_source:'ai',status:'learning',encounters:[{paper_id:args.id,title:'Synthetic paper',page:args.page,source_sentence:args.source_sentence,sentence_translation:'一个合成句子。',author_background:args.author_background,model:{provider:'synthetic',model:'mock'}}]});
test('new word remains in vocabulary, sends source and displays bilingual encounter with source navigation',async t=>{
 const f=fixture(t,async args=>result(args));f.ui.show('words');await tick();f.click('从当前论文添加');
 assert.match(f.w.document.querySelector('.wiki-article h2').textContent,/从当前论文添加词条/);
 f.input('难词或短语').value='synthetic';assert.equal(f.input('PDF 页码').value,'2');f.submit();await tick();
 const req=f.calls.find(x=>x.action==='vocabulary_create');assert.equal(req.id,'synthetic');assert.equal(req.source_sentence,'A synthetic sentence.');assert.equal(req.author_background.kind,'unknown');
 assert.equal(f.w.document.querySelectorAll('.wiki-bilingual>div').length,2);assert.match(f.w.document.querySelector('.wiki-article').textContent,/作者语言背景未知/);f.click('Synthetic paper · 第 2 页');assert.equal(f.jumps[0].paperId,'synthetic');
 assert.equal(f.calls.some(x=>x.action==='encyclopedia_put'),false);
});
test('failed create retains inputs and request identity; changed inputs get a new identity',async t=>{
 const f=fixture(t,async()=>{throw Error('保存未完成');});f.ui.show('words');await tick();f.click('从当前论文添加');f.input('难词或短语').value='synthetic';
 f.submit();await tick();f.submit();await tick();let req=f.calls.filter(x=>x.action==='vocabulary_create');assert.equal(req[0].request_id,req[1].request_id);assert.equal(f.input('难词或短语').value,'synthetic');
 f.input('原句（保留原文，需包含上方词条）').value='Another synthetic sentence.';f.submit();await tick();req=f.calls.filter(x=>x.action==='vocabulary_create');assert.notEqual(req[1].request_id,req[2].request_id);
});
test('author background needs explicit evidence and labels it as user-supplied, not inferred',async t=>{
 const f=fixture(t,async args=>result(args));f.ui.show('words');await tick();f.click('从当前论文添加');f.input('难词或短语').value='synthetic';f.w.document.querySelector('[aria-label="作者语言背景"]').value='mixed';f.submit();await tick();assert.equal(f.calls.filter(x=>x.action==='vocabulary_create').length,0);
 f.input('核实依据（如作者自述或介绍链接）').value='Synthetic author self-description';f.submit();await tick();assert.match(f.w.document.querySelector('.wiki-article').textContent,/混合语言背景作者 · 用户注明/);
});
test('late create result cannot replace a different tab and duplicate submits send only once',async t=>{
 let release;const f=fixture(t,args=>new Promise(resolve=>release=()=>resolve(result(args))));f.ui.show('words');await tick();f.click('从当前论文添加');f.input('难词或短语').value='synthetic';f.submit();f.submit();assert.equal(f.calls.filter(x=>x.action==='vocabulary_create').length,1);
 f.click('百科');await tick();release();await tick();assert.match(f.w.document.querySelector('.wiki-article').textContent,/创建百科词条/);assert.equal(f.w.document.querySelector('.wiki-bilingual'),null);
});
test('new words can be saved independently while a paper is open or closed',async t=>{
 for(const source of [undefined,null]){
  const f=fixture(t,async args=>({id:'word',term:args.term,meaning:args.meaning,note:args.note,encounters:[]}),{source});
  f.ui.show('words');await tick();
  assert.equal([...f.w.document.querySelectorAll('button')].find(b=>b.textContent==='从当前论文添加').hidden,source===null);
  f.click('新建单词／词组');f.input('单词或词组').value='mixed use';
  f.input('备注（选填）').value='My interpretation';
  f.submit();await tick();
  assert.deepEqual(f.calls.find(x=>x.action==='vocabulary_create'),{action:'vocabulary_create',mode:'manual',term:'mixed use',meaning:'',note:'My interpretation'});
  assert.match(f.w.document.querySelector('.wiki-word-note').textContent,/My interpretation/);
 }
});
test('word notes can be edited and one paper can be detached without hiding other papers',async t=>{
 const full={id:'word',revision:'one',term:'mixed use',status:'mastered',meaning:'混合使用',meaning_source:'user',encounters:[
  {paper_id:'paper-one',title:'Paper One',page:2,source_sentence:'First synthetic usage'},
  {paper_id:'paper-two',title:'Paper Two',page:3,source_sentence:'Second synthetic usage'}
 ]};
 const f=fixture(t,async args=>args.detach_paper_id?{...full,note:'Note to keep',revision:'three',encounters:[full.encounters[1]]}:{...full,note:args.note,revision:'two'},{items:[full]});
 f.ui.show('words');await tick();f.click('添加备注');f.input('备注').value='Note to keep';f.submit();await tick();
 assert.equal(f.calls.at(-1).expected_revision,'one');f.click('mixed use');
 assert.match(f.w.document.querySelector('.wiki-word-note').textContent,/Note to keep/);
 f.click('解除论文关联');await tick();
 const detach=f.calls.at(-1);assert.equal(detach.detach_paper_id,'paper-one');assert.equal(detach.expected_revision,'two');
 const article=f.w.document.querySelector('.wiki-article');assert.doesNotMatch(article.textContent,/Paper One|First synthetic usage/);assert.match(article.textContent,/Note to keep.*Paper Two/s);
});
test('searching word usage opens whole-library search with only that word or phrase',async t=>{
 const uses=[],word={id:'word',term:'mixed use',note:'Private note',encounters:[]};
 const f=fixture(t,()=>{}, {items:[word],searchUsage: async term=>{uses.push(term);return true;}});
 f.ui.show('words');await tick();f.click('全库搜索用例');await tick();
 assert.deepEqual(uses,['mixed use']);assert.equal(f.w.document.querySelector('dialog').open,false);
});

test('AI explanation sends only the submitted public query, then shows inspectable inline references',async t=>{
 const word={id:'word',revision:'rev1',term:'mixed use',note:'Private note',encounters:[],meaning:'混合使用',meaning_source:'user'};
 const saved={...word,explanation:{
  definition:{text:'土地的多种用途共同出现。',citations:[1]},
  paragraphs:[{text:'可在城市规划语境下讨论。',citations:[1]}],
  sources:[{id:1,title:'Planning source',url:'https://example.edu/term',evidence:'snippet',excerpt:'Two uses co-occur.'}]
 }};
 const f=fixture(t,async()=>({status:'explained',word:saved}),{items:[word]});
 f.ui.show('words');await tick();f.click('AI 检索与解释');
 const input=f.input('公开检索词');assert.equal(input.value,'mixed use');input.value='mixed use planning';
 assert.equal(f.calls.some(call=>call.action==='vocabulary_explain'),false);
 f.submit();await tick();
 assert.deepEqual(f.calls.find(call=>call.action==='vocabulary_explain'),{action:'vocabulary_explain',
  id:'word',expected_revision:'rev1',query:'mixed use planning',public_search:true});
 const block=f.w.document.querySelector('.wiki-term-explanation');
 assert.equal(block.querySelector('.wiki-inline-citation').href,'https://example.edu/term');
 assert.match(block.textContent,/用途共同出现.*Planning source.*Two uses co-occur/s);
 assert.match(f.w.document.querySelector('.wiki-article').textContent,/混合使用.*Private note/s);
});

test('an inconclusive search returns to the word and reloads saved clues and query',async t=>{
 const word={id:'word',revision:'rev1',term:'mixed use',encounters:[]},items=[word];
 const f=fixture(t,async args=>{
  items[0]={...word,revision:'rev2',explanation_search:{status:'insufficient',query:args.query,
   sources:[{id:1,title:'Saved clue',url:'https://example.edu/term',evidence:'metadata'}]}};
  return {status:'insufficient',word:items[0]};
 },{items});
 f.ui.show('words');await tick();f.click('AI 检索与解释');
 f.input('公开检索词').value='mixed use urban planning';f.submit();await tick();
 assert.equal(f.w.document.querySelector('.wiki-word-form'),null);
 assert.match(f.w.document.querySelector('[role=status]').textContent,/已自动保存本次检索/);
 f.ui.close();f.ui.show('words');await tick();
 const report=f.w.document.querySelector('.wiki-term-search');
 assert.match(report.textContent,/mixed use urban planning.*资料|mixed use urban planning.*足以支持释义/s);
 assert.equal(report.querySelector('a').textContent,'Saved clue');
 f.click('重新检索与解释');assert.equal(f.input('公开检索词').value,'mixed use urban planning');
});

test('opening vocabulary repairs only the current paper in bounded batches before showing saved terms',async t=>{
 const f=fixture(t,()=>{}, {items:[{id:'directionality',term:'directionality',meaning:'方向性',encounters:[]}],sync:args=>({hasMore:args.offset===0,next_offset:args.offset+20})});
 f.ui.show('words');for(let i=0;i<10&&!f.w.document.querySelector('.wiki-index-item');i++)await new Promise(r=>setTimeout(r,5));
 const syncs=f.calls.filter(x=>x.action==='language_vocabulary_sync');assert.deepEqual(syncs.map(x=>x.offset),[0,20]);assert.ok(syncs.every(x=>x.id==='synthetic'&&x.limit===20));
 assert.equal(f.w.document.querySelector('.wiki-article h2').textContent,'directionality');assert.match(f.w.document.querySelector('.wiki-article').textContent,/方向性/);
 f.click('检索');await tick();assert.equal(f.calls.filter(x=>x.action==='language_vocabulary_sync').length,2);
});

test('repair failure stays visible and search retries; switching tabs stops later batches',async t=>{
 let fail=true;const f=fixture(t,()=>{}, {sync:()=>{if(fail)throw Error('synthetic storage unavailable');return {hasMore:false};}});
 f.ui.show('words');await tick();assert.match(f.w.document.querySelector('[role=status]').textContent,/补登记未完成/);
 fail=false;f.click('检索');await tick();assert.doesNotMatch(f.w.document.querySelector('[role=status]').textContent,/补登记未完成/);
 let release;const g=fixture(t,()=>{}, {sync:()=>new Promise(r=>release=r)});g.ui.show('words');await tick();g.click('百科');release({hasMore:true,next_offset:20});await tick();
 assert.equal(g.calls.filter(x=>x.action==='language_vocabulary_sync').length,1);assert.match(g.w.document.querySelector('.wiki-article').textContent,/创建百科词条/);
});

test('selecting public link research reveals the link field and saves the mode and result',async t=>{
 const word={id:'word',revision:'rev1',term:'Synthetic concept',note:'Private note',encounters:[]};
 const f=fixture(t,async args=>({status:'unavailable',word:{...word,revision:'rev2',explanation_search:{
  status:'unavailable',reason:'missing_key',query:args.query,research_mode:args.research_mode,public_url:args.public_url
 }}}),{items:[word]});
 f.ui.show('words');await tick();f.click('AI 检索与解释');
 const link=f.input('公开 HTTPS 链接'),select=f.w.document.querySelector('.wiki-word-form select');
 assert.equal(link.parentElement.hidden,true);
 select.value='link';select.dispatchEvent(new f.w.Event('change'));
 assert.equal(link.parentElement.hidden,false);assert.equal(link.required,true);
 link.value='https://example.edu/public';f.submit();await tick();
 assert.deepEqual(f.calls.at(-1),{action:'vocabulary_explain',id:'word',expected_revision:'rev1',query:'Synthetic concept',
  public_search:true,research_mode:'link',public_url:'https://example.edu/public'});
 assert.match(f.w.document.querySelector('.wiki-term-search').textContent,/DEEPSEEK_API_KEY/);
 assert.match(f.w.document.querySelector('[role=status]').textContent,/已自动保存本次检索/);
 f.click('重新检索与解释');
 assert.equal(f.w.document.querySelector('.wiki-word-form select').value,'link');
 assert.equal(f.input('公开 HTTPS 链接').value,'https://example.edu/public');
});
