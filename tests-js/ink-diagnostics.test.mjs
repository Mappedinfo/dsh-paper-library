import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createInkDiagnostics} from '../src/ink-diagnostics.mjs';
import {createLocalStateStore} from '../src/local-state.mjs';
import {createFetchHandler} from '../src/http.mjs';

const clientSource=await readFile(new URL('../web/ink-diagnostics.js',import.meta.url),'utf8');
const plain=value=>JSON.parse(JSON.stringify(value));
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const event=(extra={})=>({event:'stroke_end',paperId:'01234567-89ab-cdef-0123-456789abcdef',annotationId:randomUUID(),page:1,strokes:2,points:15,pointerType:'pen',...extra});
async function fixture(t){
  const root=await mkdtemp(join(tmpdir(),'ink-diagnostics-')),library=join(root,'library');await mkdir(library);
  const store=createLocalStateStore({library,home:join(root,'home')});
  t.after(()=>rm(root,{recursive:true,force:true}));return {root,library,store,diagnostics:createInkDiagnostics({store})};
}
const append=(diagnostics,events)=>diagnostics.handle({action:'ink_diagnostics_append',events});
const get=diagnostics=>diagnostics.handle({action:'ink_diagnostics_get'});
function browser(api,options={}){
  const timers=new Set();
  const context=vm.createContext({window:{crypto:{randomUUID}},Date,Promise,
    setTimeout:(fn,ms)=>{const timer=setTimeout(()=>{timers.delete(timer);fn();},ms);timers.add(timer);return timer;},
    clearTimeout:timer=>{timers.delete(timer);clearTimeout(timer);}});
  vm.runInContext(clientSource,context);
  return {client:context.window.PaperInkDiagnostics.create({api,...options}),timers};
}

test('host diagnostics accepts only event metadata and never stores text, geometry or arbitrary values',async t=>{
  const f=await fixture(t),value=event({client:randomUUID(),time:10,reason:'pointer_cancel',status:'saved',revision:3,count:4,
    text:'PRIVATE_SOURCE_TEXT',paths:[[[123,456]]],board:{transcript:'PRIVATE_SOURCE_TEXT'},receivedAt:1});
  assert.deepEqual(await append(f.diagnostics,[value,{event:'not_an_event',text:'PRIVATE_SOURCE_TEXT'},event({paperId:'PRIVATE_SOURCE_TEXT',annotationId:{text:'PRIVATE_SOURCE_TEXT'},reason:'private body text',status:['PRIVATE_SOURCE_TEXT'],points:NaN,page:-1,strokes:1.5,count:10000001,pointerType:'PRIVATE_SOURCE_TEXT'})]),{accepted:2});
  const record=await f.store.get('ink-diagnostics:recent'),data=JSON.stringify(record.value);
  assert.ok(!data.includes('PRIVATE_SOURCE_TEXT'));assert.ok(!data.includes('paths'));assert.ok(!data.includes('board'));
  assert.equal(record.value.events[0].reason,'pointer_cancel');assert.notEqual(record.value.events[0].receivedAt,1);
  assert.deepEqual(Object.keys(record.value.events[1]).sort(),['event','receivedAt']);
  await assert.rejects(append(f.diagnostics,Array.from({length:33},()=>event())),/32/);
  await assert.rejects(append(f.diagnostics,{}),/32/);
});

test('host ring retains only the most recent 256 events and sanitizes existing records on read',async t=>{
  const f=await fixture(t);
  for(let group=0;group<9;group++)await append(f.diagnostics,Array.from({length:32},(_,i)=>event({count:group*32+i})));
  const report=await get(f.diagnostics);assert.equal(report.events.length,256);assert.equal(report.events[0].count,32);assert.equal(report.events.at(-1).count,287);
  const record=await f.store.get('ink-diagnostics:recent');record.value.events.at(-1).text='PRIVATE_OLD_FIELD';record.value.events.at(-1).paths=[[[4,5]]];
  await f.store.put(record.key,record.value,record.revision);
  assert.ok(!JSON.stringify(await get(f.diagnostics)).includes('PRIVATE_OLD_FIELD'));
  await append(f.diagnostics,[event({count:288})]);const stored=await f.store.get(record.key);
  assert.ok(!JSON.stringify(stored.value).includes('PRIVATE_OLD_FIELD'));assert.equal(stored.value.events.length,256);
});

test('independent host writers merge through CAS without overwriting diagnostic events',async t=>{
  const f=await fixture(t),other=createInkDiagnostics({store:f.store});
  const values=Array.from({length:16},(_,count)=>event({count}));
  await Promise.all(values.map((value,index)=>append(index%2?other:f.diagnostics,[value])));
  const report=await get(f.diagnostics);assert.equal(report.events.length,16);
  assert.deepEqual(report.events.map(value=>value.count).sort((a,b)=>a-b),Array.from({length:16},(_,i)=>i));
});

test('HTTP exposes diagnostic append/get while protecting the private state namespace',async t=>{
  const f=await fixture(t),handler=createFetchHandler({library:f.library,localState:f.store});
  t.after(()=>handler.disposeInkQueue());
  const send=input=>handler(new Request('http://localhost/api',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input)}));
  const appended=await send({action:'ink_diagnostics_append',events:[event({text:'PRIVATE_HTTP_BODY'})]});assert.equal(appended.status,200);
  assert.equal((await appended.json()).result.accepted,1);
  const response=await send({action:'ink_diagnostics_get'});assert.equal(response.status,200);
  const report=(await response.json()).result;assert.equal(report.events.length,1);assert.ok(!JSON.stringify(report).includes('PRIVATE_HTTP_BODY'));
  assert.equal((await send({action:'ink_diagnostics_append',events:Array.from({length:33},()=>event())})).status,400);
  assert.equal((await send({action:'state_put',key:'ink-diagnostics:recent',value:null,expected_revision:0})).status,403);
  const asset=await handler(new Request('http://localhost/ink-diagnostics.js'));assert.equal(asset.status,200);assert.match(await asset.text(),/PaperInkDiagnostics/);
});

test('browser logging is synchronous and failure preserves bounded sanitized local history for export',async()=>{
  const calls=[],e=browser(async(action,args)=>{calls.push({action,args:plain(args||{})});throw new Error('Host disconnected');});
  try{
    for(let count=0;count<400;count++)assert.equal(e.client.record(event({count,text:'PRIVATE_CLIENT_TEXT',paths:[[1,2]],reason:'private body text',paperId:{text:'PRIVATE_CLIENT_TEXT'}})),undefined);
    assert.equal(calls.length,0,'record does no network work on the drawing path');
    await e.client.flush();assert.equal(calls[0].args.events.length,32);
    const report=await e.client.exportReport();assert.equal(report.host,null);assert.equal(report.client.hostAvailable,false);
    assert.equal(report.client.events.length,256);assert.equal(report.client.events[0].count,144);assert.equal(report.client.events.at(-1).count,399);
    assert.equal(report.client.pending,128);assert.ok(!JSON.stringify(report).includes('PRIVATE_CLIENT_TEXT'));assert.ok(!JSON.stringify(report).includes('paths'));assert.ok(!JSON.stringify(report).includes('private body text'));
    report.client.events[0].count=999999;
    assert.equal((await e.client.exportReport()).client.events[0].count,144,'Export cannot mutate the retained local ring');
    assert.deepEqual(calls[0].args.events,calls[1].args.events,'A failed flush retries the same bounded events');
  }finally{e.client.dispose();}
});

test('a stalled flush never blocks recording or bounded local export, and disposal cannot restart its timer',async()=>{
  let release;const gate=new Promise(resolve=>{release=resolve;}),calls=[];
  const e=browser(async(action,args)=>{calls.push({action,args});if(action==='ink_diagnostics_append')await gate;return action==='ink_diagnostics_get'?{schema:1,events:[]}:{accepted:1};},{exportTimeoutMs:15});
  try{
    e.client.record(event({count:1}));const flushing=e.client.flush();await tick();e.client.record(event({count:2}));
    const report=await e.client.exportReport();assert.equal(report.host,null);assert.equal(report.client.hostAvailable,false);assert.equal(report.client.events.length,2);assert.equal(report.client.pending,2);
    e.client.dispose();release();await flushing;await tick();assert.equal(e.timers.size,0,'An in-flight completion cannot schedule after disposal');
    assert.doesNotThrow(()=>e.client.record(null));
  }finally{release();e.client.dispose();}
});

test('successful browser export includes the host ring and clears acknowledged pending events',async()=>{
  const remote=[],e=browser(async(action,args)=>{if(action==='ink_diagnostics_append'){remote.push(...plain(args.events));return {accepted:args.events.length};}return {schema:1,limit:256,events:remote};});
  try{
    e.client.record(event({count:1}));e.client.record({event:'unknown',text:'PRIVATE'});
    const report=await e.client.exportReport();assert.equal(report.host.events.length,1);assert.equal(report.client.events.length,1);assert.equal(report.client.pending,0);assert.equal(report.client.hostAvailable,true);
  }finally{e.client.dispose();}
});

test('browser export recovers availability after a failed read without requiring another stroke',async()=>{
  let failed=true;const e=browser(async()=>{if(failed)throw new Error('Read disconnected');return {schema:1,events:[]};});
  try{
    assert.equal((await e.client.exportReport()).client.hostAvailable,false);failed=false;
    assert.equal((await e.client.exportReport()).client.hostAvailable,true);
  }finally{e.client.dispose();}
});
