/** Modeless resource links use synthetic metadata and the existing optional DOM runtime. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);let JSDOM;
try{({JSDOM}=require(process.env.JSDOM_MODULE||'jsdom'));}catch{}
const source=await readFile(new URL('../web/resource-library.js',import.meta.url),'utf8');
const clone=value=>value===undefined?undefined:JSON.parse(JSON.stringify(value));
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function until(check){for(let index=0;index<40;index++){if(check())return;await tick();}assert.fail('Synthetic resource UI did not settle');}
const paperA={id:'paper-a',resource_kind:'paper',title:'Synthetic Paper A'},paperB={id:'paper-b',resource_kind:'paper',title:'Synthetic Paper B'};
const dataset={id:'dataset-a',resource_kind:'dataset',title:'Synthetic Dataset A',revision:1};
const relation={id:'relation-a',paper_id:paperA.id,dataset_id:dataset.id,paper_title:paperA.title,dataset_title:dataset.title,relation:'uses',review_status:'needs-review',revision:3,evidence:[{quote:'Synthetic source'}]};
function fixture({respond,put,get}={}){
  const dom=new JSDOM('<!doctype html><div class="workspace"><div class="detail-pane"></div></div><div id="paper-tools"></div><div class="reader-ribbon"><button id="reader-fullscreen"></button></div><div id="paper-detail"></div><div id="welcome"></div><div id="ribbon-language"></div><div id="ribbon-citations"></div><div id="metadata-open"></div><div id="toolbar-reader"></div><div id="toolbar-annotation"></div><div id="toolbar-actions"></div><div id="toolbar-library"></div><div id="toolbar-paper"></div><div id="page-message"></div><button id="unrelated">Other action</button>',{runScripts:'outside-only',url:'http://synthetic.invalid/'});
  const {window}=dom,document=window.document,calls=[],writes=[],notices=[],storage=new Map(),state={active:clone(paperA),openedId:paperA.id},opened=[];
  window.HTMLDialogElement.prototype.show=function(){this.open=true;this.dataset.modal='false';};window.HTMLDialogElement.prototype.showModal=function(){this.open=true;this.dataset.modal='true';};
  window.HTMLDialogElement.prototype.close=function(){if(!this.open)return;this.open=false;this.dispatchEvent(new window.Event('close'));};window.confirm=()=>true;
  window.eval(source);
  const api=async(action,args)=>{calls.push({action,args:clone(args)});const custom=respond?.(action,args);if(custom!==undefined)return await custom;
    if(action==='resource_list')return{items:args.kind==='paper'?[clone(paperA),clone(paperB)]:[clone(dataset),{...dataset,id:'dataset-b',title:'Synthetic Dataset B'}],total:2};
    if(action==='dataset_link_list')return{items:[clone(relation)],total:1};
    if(action==='paper_datasets_get')return{candidates:[],can_search:false};
    if(action==='dataset_release_list')return{items:[{id:'release-saved',version:'Synthetic saved version'}],total:1};
    if(action==='dataset_get')return{...dataset,id:args.id};
    if(action==='dataset_asset_list')return{items:[],total:0};
    if(action==='dataset_link_put')return{...relation,...args,revision:args.expected_revision+1};
    if(action==='dataset_link_delete')return{deleted:true};
    throw new Error(`Unexpected synthetic action: ${action}`);
  };
  const persistence={get:async key=>get?get(key,storage):clone(storage.get(key)||null),put:async(key,value)=>{writes.push({key,value:clone(value)});if(put)await put(key,value);storage.set(key,clone(value));}};
  let data, visible=false, entered=0;
  const catalog=document.createElement('div');document.body.append(catalog);
  const panels={registerPanel(panel){data=panel;document.body.append(panel.element);},show(){visible=true;data.onShow();return true;},visible:()=>visible};
  const ui=window.ResourceLibrary.create({state,api,persistence,panels,
    openDatasetCatalog:async()=>{entered++;ui.catalogActions(catalog);return true;},
    renderDatasetCatalog:()=>ui.catalogActions(catalog),toast:(...values)=>notices.push(values),loadList:async()=>{},openPaper:async id=>{opened.push(id);state.active={id};},workbench:()=>({isTable:()=>false,setTable(){}}),prepare(){},changed(){},knowledge:()=>null});
  const dialog=document.getElementById('resource-dialog'),field=name=>document.getElementById(`resource-field-${name}`),button=text=>[...dialog.querySelectorAll('button')].find(value=>value.textContent===text);
  const change=(name,value)=>{field(name).value=value;field(name).dispatchEvent(new window.Event('change',{bubbles:true}));};
  const submit=()=>dialog.querySelector('form').dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));
  return{dom,window,document,state,ui,dialog,field,button,change,submit,calls,writes,storage,notices,opened,catalog,data:data.element,entered:()=>entered};
}
const action=(root,label)=>[...root.querySelectorAll('button')].find(button=>button.textContent===label);
async function openNewLink(f){
  if(f.state.active?.id!==dataset.id)await f.ui.open(dataset.id);
  f.document.querySelector('#dataset-links > header button').click();
  await until(()=>f.field('paper_id'));
}

test('late paper data does not replace the newer paper sidebar',{skip:!JSDOM},async()=>{
  const pending=deferred();
  const f=fixture({respond:(name,args)=>name==='dataset_link_list'?(args.paper_id===paperA.id?pending.promise:{items:[],total:0}):undefined});
  try {
    f.ui.showPaperLinks();
    f.state.active=clone(paperB);
    f.ui.syncPaper();
    await until(()=>f.data.textContent.includes('尚未关联'));
    pending.resolve({items:[relation],total:1});
    await tick();
    assert.equal(f.data.querySelectorAll('.resource-row').length,0);
    assert.equal(f.dialog.open,false);
  }finally{f.dom.window.close();}
});

test('catalog binding retains its captured owner when another paper becomes active',{skip:!JSDOM},async()=>{
  const f=fixture();
  try{
    f.ui.showPaperLinks();
    action(f.data,'＋ 关联数据集').click();
    await until(()=>f.entered()===1);
    assert.match(f.catalog.textContent,/绑定到 Synthetic Paper A/);
    f.state.active=clone(paperB);
    const row=f.document.createElement('div');f.catalog.append(row);
    f.ui.catalogRow(row,dataset);
    action(row,'绑定').click();
    await until(()=>action(f.catalog,'保存绑定'));
    action(f.catalog,'保存绑定').click();
    await until(()=>f.catalog.textContent.includes('已保存绑定'));
    assert.equal(f.calls.find(call=>call.action==='dataset_link_put').args.paper_id,paperA.id);
    assert.equal(f.state.active.id,paperB.id);
    assert.equal(f.dialog.open,false);
  }finally{f.dom.window.close();}
});

test('dataset-owned link saving does not reopen its owner over a newer paper',{skip:!JSDOM},async()=>{
  const f=fixture();try{
    await f.ui.open(dataset.id);f.document.querySelector('#dataset-links > header button').click();await until(()=>f.field('paper_id'));f.change('paper_id',paperA.id);f.state.active=clone(paperB);f.submit();await until(()=>!f.dialog.open);
    const written=f.calls.find(call=>call.action==='dataset_link_put').args;assert.equal(written.dataset_id,dataset.id);assert.equal(written.paper_id,paperA.id);assert.equal(f.state.active.id,paperB.id);assert.equal(f.calls.filter(call=>call.action==='dataset_get').length,1);
  }finally{f.dom.window.close();}
});

test('late release results cannot replace a later choice in the catalog binding form',{skip:!JSDOM},async()=>{
  const release=deferred();
  const f=fixture({respond:(name,args)=>name==='dataset_release_list'?(args.id===dataset.id?release.promise:{items:[{id:'release-b',version:'Dataset B version'}],total:1}):undefined});
  try{
    f.ui.showPaperLinks();
    action(f.data,'＋ 关联数据集').click();
    await until(()=>f.entered()===1);
    const rows=[dataset,{id:'dataset-b',title:'Synthetic Dataset B'}].map(item=>{
      const row=f.document.createElement('div');f.ui.catalogRow(row,item);return row;
    });
    for(const row of rows)action(row,'绑定').click();
    await until(()=>f.catalog.textContent.includes('Dataset B version'));
    release.resolve({items:[{id:'release-a',version:'Older dataset version'}],total:1});
    await tick();
    assert.doesNotMatch(f.catalog.textContent,/Older dataset version/);
  }finally{f.dom.window.close();}
});

test('closing refuses to discard an unpersisted draft and restored release choices retain their identity',{skip:!JSDOM},async()=>{
  let fail=false;const f=fixture({put:async()=>{if(fail)throw new Error('Synthetic disk unavailable');}});
  f.storage.set(`resource-draft:link:${dataset.id}:new`,{base:{revision:0},values:{paper_id:paperA.id,release_id:'release-saved',quote:'Recovered synthetic note',relation:'uses',review_status:'needs-review'}});
  try{await openNewLink(f);await until(()=>f.field('release_id').value==='release-saved');assert.equal(f.field('quote').value,'Recovered synthetic note');fail=true;f.change('quote','Keep this synthetic draft');f.button('×').click();await until(()=>f.dialog.textContent.includes('草稿尚未暂存'));assert.equal(f.dialog.open,true);assert.equal(f.field('quote').value,'Keep this synthetic draft');
    fail=false;f.button('×').click();await until(()=>!f.dialog.open);assert.equal(f.storage.get(`resource-draft:link:${dataset.id}:new`).values.quote,'Keep this synthetic draft');await openNewLink(f);assert.equal(f.field('quote').value,'Keep this synthetic draft');
    fail=true;f.dialog.close();await until(()=>f.dialog.open);assert.equal(f.field('quote').value,'Keep this synthetic draft','A native close cannot erase an unsaved form');fail=false;f.submit();await until(()=>!f.dialog.open);assert.equal(f.calls.filter(call=>call.action==='dataset_link_put').length,1,'The recovered form remains usable for saving');
  }finally{f.dom.window.close();}
});

test('CAS conflicts retain inputs and require explicit revision adoption before a second save',{skip:!JSDOM},async()=>{
  let conflict=true;const f=fixture({respond:(action,args)=>{if(action==='dataset_link_put'&&conflict){conflict=false;throw Object.assign(new Error('Synthetic conflict'),{code:'STATE_CONFLICT',current:{...relation,revision:9}});}}});
  try{await openNewLink(f);f.change('paper_id',paperA.id);f.change('quote','My synthetic interpretation');f.submit();await until(()=>f.button('已核对差异，采用本窗口内容继续编辑'));
    assert.equal(f.field('quote').value,'My synthetic interpretation');f.button('已核对差异，采用本窗口内容继续编辑').click();f.submit();await until(()=>!f.dialog.open);const writes=f.calls.filter(call=>call.action==='dataset_link_put');assert.equal(writes.length,2);assert.equal(writes[1].args.expected_revision,9);assert.equal(writes[1].args.evidence[0].quote,'My synthetic interpretation');
  }finally{f.dom.window.close();}
});

test('saving blocks replacement of its own form and a draft cleanup retry never repeats the catalog write',{skip:!JSDOM},async()=>{
  const saved=deferred();let failClear=true;const f=fixture({respond:action=>action==='dataset_link_put'?saved.promise:undefined,put:async(_key,value)=>{if(value===null&&failClear){failClear=false;throw new Error('Synthetic cleanup unavailable');}}});
  try{await openNewLink(f);f.change('paper_id',paperA.id);f.change('quote','Saved once');f.submit();await until(()=>f.calls.some(call=>call.action==='dataset_link_put'));
    f.state.active=clone(paperB);f.ui.showPaperLinks();assert.equal(f.field('quote').value,'Saved once');assert.match(f.dialog.textContent,/绑定数据集：Synthetic Dataset A/);
    f.dialog.close();assert.equal(f.dialog.open,true,'Native close during save keeps the original form and completion identity');
    saved.resolve({...relation,revision:1});await until(()=>f.button('重试完成保存'));assert.equal(f.field('quote').disabled,true);f.submit();await until(()=>!f.dialog.open);assert.equal(f.calls.filter(call=>call.action==='dataset_link_put').length,1);assert.equal(f.state.active.id,paperB.id);
  }finally{f.dom.window.close();}
});

test('ordinary dataset metadata editing remains modal and relation deletion still requires confirmation',{skip:!JSDOM},async()=>{
  const f=fixture();try{await f.ui.edit(dataset);assert.equal(f.dialog.dataset.modal,'true');await f.ui.closeDialog();f.state.active=clone(paperA);f.ui.showPaperLinks();await until(()=>action(f.data,'删除关系'));let confirmations=0;f.window.confirm=()=>{confirmations++;return false;};action(f.data,'删除关系').click();await tick();assert.equal(confirmations,1);assert.equal(f.calls.some(call=>call.action==='dataset_link_delete'),false);
  }finally{f.dom.window.close();}
});
