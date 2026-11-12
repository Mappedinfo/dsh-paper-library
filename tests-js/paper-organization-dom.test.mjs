/** Synthetic catalog organization checks; no PDF or live library access. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
let JSDOM;try{({JSDOM}=require(process.env.JSDOM_MODULE||'jsdom'));}catch{}
const source=await readFile(new URL('../web/paper-organization.js',import.meta.url),'utf8');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const plain=value=>JSON.parse(JSON.stringify(value));
function fixture(api){
  const dom=new JSDOM('<div id="filters"></div><div id="rows"></div>',{runScripts:'outside-only',url:'http://synthetic.invalid/'}),{window}=dom;
  window.HTMLDialogElement.prototype.showModal=function(){this.open=true;};
  window.HTMLDialogElement.prototype.close=function(){this.open=false;this.dispatchEvent(new window.Event('close'));};
  window.eval(source);
  const calls=[],patches=[],errors=[],loads=[],state={offset:80,kind:'all',favorite:false,tag:'',archived:false,project:'project-a'};
  const ui=window.PaperOrganization.create({state,root:window.document.getElementById('filters'),api:async(action,args)=>{calls.push([action,plain(args)]);return api(action,args);},loadList:async()=>loads.push(plain(state)),onChanged:p=>patches.push(plain(p)),toast:(message)=>errors.push(message)});
  return {dom,window,document:window.document,ui,state,calls,patches,errors,loads};
}
test('favorite and tag chips filter together, reset pagination, and never open the paper', {skip:!JSDOM}, async()=>{
  const f=fixture(()=>({}));const {ui,document,state}=f;
  document.getElementById('rows').append(ui.actions({id:'a',tags:['Method/Neural'],manual_tags:['#Method/Neural','#Review'],favorite:false},{compact:true}));
  assert.equal(document.querySelectorAll('#rows .paper-tag-chip').length,2);
  document.querySelector('#catalog-favorite').click();assert.equal(state.favorite,true);assert.equal(state.offset,0);
  document.querySelector('#rows .paper-tag-chip').click();assert.equal(state.tag,'#Method/Neural');assert.equal(f.loads.at(-1).favorite,true);
  assert.equal(document.querySelector('#catalog-tag-clear').hidden,false);
  document.querySelector('#catalog-tag-clear').click();assert.equal(state.tag,'');assert.equal(state.favorite,true);
  assert.equal(f.calls.length,0);f.dom.window.close();
});
test('default tag roots filter or insert a prefix without adding a tag until saved', {skip:!JSDOM}, async()=>{
  const f=fixture(async(action,args)=>action==='get'?{id:'a',manual_tags:['#Original']}:action==='paper_tags_list'?{items:[],total:0}:{id:'a',manual_tags:args.tags});
  f.document.querySelector('#catalog-tag-picker').click();
  const roots=[...f.document.querySelectorAll('[aria-label="常用根标签"] button')];
  assert.deepEqual(roots.map(button=>button.textContent),['#发表团队','#发表学校','#发表学校所在国','#方法']);
  roots[2].click();
  assert.equal(f.state.tag,'#发表学校所在国');
  await f.ui.edit({id:'a'});
  const input=f.document.querySelector('textarea');
  const editorRoots=[...f.document.querySelectorAll('[aria-label="插入标签前缀"] button')];
  editorRoots[0].click();editorRoots[3].click();
  assert.equal(input.value,'#Original\n#方法/');
  const submit=()=>f.document.querySelector('form').dispatchEvent(new f.window.Event('submit',{cancelable:true}));
  submit();assert.match(f.document.querySelector('.error').textContent,/补全/);
  assert.equal(f.calls.some(([action])=>action==='paper_organization_update'),false);
  input.value+='SyntheticMethod';submit();await tick();
  f.document.getElementById('rows').append(f.ui.actions(f.patches[0]));
  assert.equal(f.document.querySelector('#rows .method-tag').textContent,'#方法/SyntheticMethod');
  f.dom.window.close();
});
test('tag search pages from server and discards stale responses', {skip:!JSDOM}, async()=>{
  let resolveFirst;let n=0;
  const f=fixture(async(action,args)=>{assert.equal(action,'paper_tags_list');if(++n===1)return new Promise(resolve=>resolveFirst=resolve);return {items:[{tag:'#New/Child',count:2}],total:1,next_offset:null};});
  const picker=f.document.querySelector('#catalog-tag-picker');picker.click();await tick();
  const input=f.document.querySelector('input');input.value='New';input.dispatchEvent(new f.window.Event('input'));
  resolveFirst({items:[{tag:'#Old',count:4}],total:1});await tick();assert.equal(f.document.querySelectorAll('.paper-tag-option').length,0);
  await new Promise(resolve=>setTimeout(resolve,220));
  assert.equal(f.document.querySelector('.paper-tag-option').textContent,'#New/Child · 2');
  f.window.dispatchEvent(new f.window.Event('resize'));assert.equal(picker.getAttribute('aria-expanded'),'true','Host pane resizing must preserve the open tag picker');
  assert.equal(f.calls.at(-1)[1].limit,30);assert.equal(f.calls.at(-1)[1].project,'project-a');
  f.document.querySelector('.paper-tag-option').click();assert.equal(f.state.tag,'#New/Child');assert.equal(picker.getAttribute('aria-expanded'),'false');f.dom.window.close();
});
test('manual tags preserve source tags, use latest revision, and retain the draft on failure', {skip:!JSDOM}, async()=>{
  let fail=true;
  const f=fixture(async action=>{if(action==='get')return {id:'a',title:'Synthetic paper',tags:['External'],manual_tags:['#Old'],organization_modified:'v2'};if(fail)throw new Error('资料已更新，请重新读取');return {id:'a',favorite:true,manual_tags:['#New/Sub'],organization_modified:'v3'};});
  await f.ui.edit({id:'a'});const input=f.document.querySelector('textarea'),dialog=f.document.querySelector('dialog');
  assert.equal(input.value,'#Old');assert.match(f.document.querySelector('.paper-tag-sources').textContent,/#External/);
  input.value='#New/Sub';f.document.querySelector('form').dispatchEvent(new f.window.Event('submit',{cancelable:true}));await tick();
  assert.equal(dialog.open,true);assert.equal(input.value,'#New/Sub');assert.match(f.document.querySelector('.error').textContent,/已更新/);
  assert.deepEqual(f.calls.at(-1),['paper_organization_update',{id:'a',tags:['#New/Sub'],expected_organization_modified:'v2'}]);
  fail=false;f.document.querySelector('form').dispatchEvent(new f.window.Event('submit',{cancelable:true}));await tick();
  assert.equal(dialog.open,false);assert.equal(f.patches.length,1);assert.equal(f.loads.length,1);f.dom.window.close();
});
test('favorite persistence does not overwrite tags and failure remains visible', {skip:!JSDOM}, async()=>{
  const f=fixture(async()=>{throw new Error('disk unavailable');});
  f.document.getElementById('rows').append(f.ui.actions({id:'a',favorite:false,tags:['#Tag']}));
  f.document.querySelector('.paper-favorite').click();f.document.querySelector('.paper-favorite').click();await tick();
  assert.deepEqual(f.calls,[['paper_organization_update',{id:'a',favorite:true}]]);
  assert.equal(f.patches.length,0);assert.equal(f.document.querySelector('.paper-favorite').disabled,false);assert.match(f.errors[0],/disk unavailable/);
  assert.equal(f.ui.actions({id:'dataset',resource_kind:'dataset'}).children.length,0);
  f.dom.window.close();
});

test('tag editor removes a manual and source tag, adds one, and saves them together', {skip:!JSDOM}, async()=>{
  const f=fixture(async(action,args)=>action==='get'?
    {id:'a',tags:['Source'],manual_tags:['#Old'],organization_modified:'v1'}:
    {id:'a',manual_tags:args.tags,hidden_source_tags:args.hidden_source_tags});
  await f.ui.edit({id:'a'});
  f.document.querySelector('[aria-label="删除手动标签 #Old"]').click();
  f.document.querySelector('[aria-label="移除资料标签 #Source"]').click();
  assert.ok(f.document.querySelector('[aria-label="恢复资料标签 #Source"]'));
  f.document.querySelector('textarea').value='#New';
  f.document.querySelector('form').dispatchEvent(new f.window.Event('submit',{cancelable:true}));
  await tick();
  assert.deepEqual(f.calls.at(-1),['paper_organization_update',{id:'a',tags:['#New'],expected_organization_modified:'v1',hidden_source_tags:['#Source']}]);
  f.document.getElementById('rows').append(f.ui.actions({tags:['Source','one','two','three'],...f.patches[0]}));
  assert.deepEqual([...f.document.querySelectorAll('#rows .paper-tag-chip')].map(b=>b.textContent),['#one','#two','#three','#New']);
  f.dom.window.close();
});
