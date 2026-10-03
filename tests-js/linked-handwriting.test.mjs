import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {webcrypto} from 'node:crypto';

const source=await readFile(new URL('../web/linked-handwriting.js',import.meta.url),'utf8');
const intentKey='reader:linked-recognition-pending';
const copy=value=>value==null?value:JSON.parse(JSON.stringify(value));
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function until(predicate){const deadline=Date.now()+2000;while(!predicate()){assert.ok(Date.now()<deadline,'Expected asynchronous lifecycle transition');await new Promise(resolve=>setTimeout(resolve,1));}}
function deferred(){let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};}
function note(overrides={}){return {id:'parent-a',page:2,linked_ink:{version:'version-1',geometry_version:'geometry-1',transcript:'',transcription_source:'none',transcript_stale:false,
  annotations:[{id:'ink-a',page:2,width:2,color:'#2455a4',paths:[[[10,20],[30,40]]]}],...overrides}};}

// The canvas double only exercises control flow. Real geometry/image quality is
// covered by browser fixtures; these tests never send an image to a model.
function element(tag){return {tagName:tag,children:[],classList:{toggle(){}},setAttribute(){},addEventListener(){},append(...children){this.children.push(...children);},before(){},
  getContext:()=>({fillRect(){},beginPath(){},moveTo(){},lineTo(){},stroke(){}}),toDataURL:()=> 'data:image/png;base64,c3ludGhldGlj'};}
function fixture({records=new Map(),parent=note()}={}){
  const f={records,state:{active:{id:'paper-a'},annotations:[parent]},pending:false,draft:null,inking:false,tool:'underline',context:null,calls:[],writes:[],toasts:[],changes:[],beforePut:null,beforeModel:null,modelError:null};
  const context=vm.createContext({window:{},TextEncoder,crypto:webcrypto,setTimeout,clearTimeout,CSS:{escape:value=>value},
    document:{createElement:element,getElementById:()=>element('div'),body:element('body'),querySelectorAll:()=>[],querySelector:()=>null}});
  vm.runInContext(source,context);
  f.persistence={get:async key=>copy(records.get(key)??null),put:async(key,value)=>{f.writes.push([key,copy(value)]);await f.beforePut?.(key,value);records.set(key,copy(value));}};
  f.ui=context.window.PaperLinkedHandwriting.create({state:f.state,persistence:f.persistence,
    reader:()=>({getInkDraft:()=>f.draft,isInking:()=>f.inking,setInkContext:value=>{f.context=copy(value);}}),
    shell:()=>({tool:()=>({type:f.tool}),setTool:value=>{f.tool=value;}}),queue:()=>({hasPending:()=>f.pending,records:()=>[]}),
    api:async(action,args)=>{f.calls.push([action,copy(args)]);if(action==='handwriting_recognize'){await f.beforeModel?.();if(f.modelError)throw f.modelError;return {text:'合成识别文字'};}return {};},
    saveInk:()=>{f.draft=null;return true;},inkBusy:()=>false,inkUncertain:()=>false,navigate:async()=>{},changed:async(...args)=>{f.changes.push(args);},publish(){},available:()=>true,toast:(...args)=>f.toasts.push(args)});
  f.models=()=>f.calls.filter(([action])=>action==='handwriting_recognize');
  f.textWrites=()=>f.calls.filter(([action])=>action==='linked_handwriting_text');
  return f;
}

test('finish restores the prior tool before intent persistence or recognition completes',async()=>{
  const f=fixture(),durable=deferred(),model=deferred();
  await f.ui.toggle(f.state.active,f.state.annotations[0]);assert.equal(f.tool,'ink');
  f.draft={paperId:'paper-a',parentId:'parent-a',paths:[[[10,20],[30,40]]]};
  f.beforePut=key=>key===intentKey?durable.promise:null;f.beforeModel=()=>model.promise;
  try{
    const finished=f.ui.finish();
    assert.equal(f.ui.session(),null);assert.equal(f.tool,'underline');assert.equal(f.context,null);
    assert.equal(await finished,true);assert.equal(f.models().length,0);
    await until(()=>f.writes.some(([key])=>key===intentKey));assert.equal(f.records.has(intentKey),false);
    durable.resolve();await until(()=>f.models().length===1);
    assert.equal(f.tool,'underline');assert.equal(f.textWrites().length,0);
    assert.equal(f.records.get(intentKey)[0].attempted,true,'Persist the attempt before dispatching automatic recognition');
    model.resolve();await until(()=>f.changes.length===1);
    assert.deepEqual(f.records.get(intentKey),[]);assert.equal(f.textWrites()[0][1].expected_version,'version-1');
  }finally{durable.resolve();model.resolve();}
});

test('browsing old saved handwriting without a finish intent never invokes recognition',async()=>{
  const f=fixture();await f.ui.paperReady('paper-a');await f.ui.saved('paper-a','parent-a');await tick();
  assert.equal(f.models().length,0);assert.equal(f.textWrites().length,0);assert.equal(f.records.has(intentKey),false);
});

test('finished queued handwriting resumes recognition only after returning to a fresh paper snapshot',async()=>{
  const f=fixture();f.pending=true;await f.ui.toggle(f.state.active,f.state.annotations[0]);await f.ui.finish();
  await until(()=>f.records.get(intentKey)?.length===1);await tick();assert.equal(f.models().length,0);
  f.state.active={id:'paper-b'};f.pending=false;await f.ui.saved('paper-a','parent-a');await tick();assert.equal(f.models().length,0);
  // A new iframe restores the durable intent; state is replaced by the freshly
  // read native annotations before the app invokes paperReady.
  const fresh=note({version:'version-2',geometry_version:'geometry-2'}),restored=fixture({records:f.records,parent:fresh});
  await restored.ui.paperReady('paper-a');await until(()=>restored.changes.length===1);
  assert.equal(restored.models().length,1);assert.equal(restored.textWrites()[0][1].expected_version,'version-2');
  assert.deepEqual(restored.records.get(intentKey),[]);
});

test('failed automatic recognition stays attempted across reload and explicit retry keeps its request identity',async()=>{
  const records=new Map([[intentKey,[{paperId:'paper-a',parentId:'parent-a'}]]]),f=fixture({records});f.modelError=new Error('synthetic model unavailable');
  await f.ui.paperReady('paper-a');await until(()=>f.toasts.some(([message])=>message.includes('文字识别未完成')));
  assert.equal(f.models().length,1);assert.equal(records.get(intentKey)[0].attempted,true);
  await f.ui.paperReady('paper-a');await f.ui.saved('paper-a','parent-a');await tick();assert.equal(f.models().length,1);
  const restored=fixture({records});await restored.ui.paperReady('paper-a');await tick();assert.equal(restored.models().length,0);
  await restored.ui.recognize('paper-a',restored.state.annotations[0]);
  assert.equal(restored.models().length,1);assert.equal(restored.models()[0][1].request_id,f.models()[0][1].request_id);
  assert.equal(restored.textWrites().length,1);assert.deepEqual(records.get(intentKey),[]);
});

test('an existing edited transcript is preserved even when new strokes make it stale',async()=>{
  const records=new Map([[intentKey,[{paperId:'paper-a',parentId:'parent-a'}]]]),parent=note({transcript:'用户校对文字',transcription_source:'edited',transcript_stale:true}),f=fixture({records,parent});
  await f.ui.paperReady('paper-a');await until(()=>records.get(intentKey)?.length===0);
  assert.equal(f.models().length,0);assert.equal(f.textWrites().length,0);assert.equal(parent.linked_ink.transcript,'用户校对文字');
});

test('a restored unfinished draft prevents an older finish intent from recognizing saved strokes',async()=>{
  const records=new Map([[intentKey,[{paperId:'paper-a',parentId:'parent-a'}]]]),f=fixture({records});
  f.draft={paperId:'paper-a',parentId:'parent-a',page:2,paths:[[[40,50],[60,70]]]};
  await f.ui.paperReady('paper-a');await tick();assert.equal(f.models().length,0);assert.equal(records.get(intentKey).length,1);
});
