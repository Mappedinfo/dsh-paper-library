import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('../web/ink-queue-client.js',import.meta.url),'utf8');
const plain=value=>JSON.parse(JSON.stringify(value));
const draft=()=>({paperId:'paper-a',parentId:'highlight-a',page:1,revision:3,width:2,color:'#2455a4',paths:[[[10,20],[30,40]]]});
const id='edbab15a-4c52-4253-b53f-7784cd8b5a96';
function environment(options={}){
  const context=vm.createContext({window:{},TextEncoder,queueMicrotask,setTimeout,clearTimeout});vm.runInContext(source,context);
  let remote=[],listResponse=null,fail=false;const writes=[],requests=[],changes=[],saved=[],errors=[];
  const client=context.window.PaperInkQueueClient.create({persistence:{put:async(key,value)=>{writes.push(plain(value));if(options.storageFailure)throw new Error('staging disk unavailable');}},api:async(action,args)=>{
    requests.push([action,plain(args||{})]);if(action==='ink_queue_list')return listResponse||{jobs:remote};if(fail)throw new Error('lost response');
    if(options.api)return options.api(action,args);
    const job={batch:args.batch,annotation_id:args.batch.annotation_id,status:'queued'};remote=[job];return {job};
  },onChange:value=>changes.push(plain(value)),onAccepted:options.onAccepted,onSaved:value=>saved.push(plain(value)),onError:error=>errors.push(error.message)});
  return {client,writes,requests,changes,saved,errors,setRemote:value=>{remote=value;listResponse=null;},setListResponse:value=>{listResponse=value;},fail:value=>{fail=value;}};
}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
test('freeze returns synchronously with detached preview and handoff before staging or PDF work',async()=>{
  let release;const gate=new Promise(resolve=>{release=resolve;});const e=environment({api:async(action,args)=>{await gate;return {job:{annotation_id:id,batch:args.batch,status:'writing'}};}});
  try{const value=draft();assert.equal(e.client.freeze(value,id,{updatedAt:100}),true);value.paths[0][0][0]=999;
    assert.equal(e.requests.length,0);assert.equal(e.client.records()[0].status,'staging');assert.equal(e.client.handoff().draft.paths[0][0][0],10);
    assert.throws(()=>e.client.freeze(draft(),'another-id'),/尚未暂存/);await tick();assert.equal(e.client.blocked(),true);
    release();await tick();assert.equal(e.client.blocked(),false);assert.equal(e.client.handoff(),null);assert.equal(e.client.records()[0].status,'writing');assert.equal(e.saved.length,0);
  }finally{e.client.dispose();}
});
test('lost enqueue acknowledgement retries exactly the original identity and paths',async()=>{
  const e=environment();try{e.fail(true);e.client.freeze(draft(),id,{updatedAt:100});await tick();assert.equal(e.client.records()[0].status,'stage_failed');
    e.fail(false);await e.client.retry(id);assert.deepEqual(e.requests[1],e.requests[0]);assert.equal(e.client.blocked(),false);
  }finally{e.client.dispose();}
});
test('host readback recovers lost staging acknowledgement and reports saved once',async()=>{
  let cleaned=0;const e=environment({onAccepted:()=>{cleaned++;}});try{e.fail(true);e.client.freeze(draft(),id);await tick();
    const batch=e.requests[0][1].batch;e.setRemote([{annotation_id:id,batch,status:'saved'}]);await e.client.refresh();await tick();
    assert.equal(cleaned,1);assert.equal(e.client.blocked(),false);assert.equal(e.saved.length,1);await e.client.refresh();await tick();assert.equal(e.saved.length,1);
  }finally{e.client.dispose();}
});
test('host identity conflict does not release original memory or handoff',async()=>{
  const e=environment();try{e.fail(true);e.client.freeze(draft(),id);await tick();const batch=e.requests[0][1].batch;batch.paths[0][0][0]=321;
    e.setRemote([{annotation_id:id,batch,status:'queued'}]);await assert.rejects(e.client.refresh(),/冲突/);assert.equal(e.client.blocked(),true);assert.equal(e.client.handoff().draft.paths[0][0][0],10);
  }finally{e.client.dispose();}
});
test('storage failure never dispatches PDF queue and retains exportable frozen geometry',async()=>{
  const e=environment({storageFailure:true});try{e.client.freeze(draft(),id);await tick();assert.equal(e.requests.length,0);assert.equal(e.client.records()[0].status,'stage_failed');assert.deepEqual(plain(e.client.handoff().draft),draft());}finally{e.client.dispose();}
});
test('saved receipt and a new batch have separate immutable identities and pending state',async()=>{
  const e=environment();try{e.client.freeze(draft(),id);await tick();const batch=e.requests[0][1].batch;e.setRemote([{annotation_id:id,batch,status:'saved'}]);await e.client.refresh();await tick();
    assert.equal(e.client.hasPending('paper-a','highlight-a'),false);e.client.freeze({...draft(),revision:4},'43198fdf-7a31-48ba-8c3f-639f830798ac');assert.equal(e.client.hasPending('paper-a','highlight-a'),true);assert.equal(e.client.records().length,2);await tick();
  }finally{e.client.dispose();}
});

test('enqueue response and readback share one acceptance cleanup without releasing or erasing newer input',async()=>{
  let releaseEnqueue;const cleanups=[];let sent;
  const e=environment({onAccepted:()=>new Promise(resolve=>cleanups.push(resolve)),api:async(action,args)=>{sent=plain(args.batch);await new Promise(resolve=>{releaseEnqueue=resolve;});return {job:{annotation_id:id,batch:sent,status:'queued'}};}});
  try{
    e.client.freeze(draft(),id);await tick();e.setRemote([{annotation_id:id,batch:sent,status:'queued'}]);
    const readback=e.client.refresh();await tick();releaseEnqueue();await tick();
    assert.equal(cleanups.length,1,'Both confirmations must await the same cleanup');assert.equal(e.client.blocked(),true);
    cleanups[0]();await readback;await tick();assert.equal(e.client.blocked(),false);
    const nextId='43198fdf-7a31-48ba-8c3f-639f830798ac';e.client.freeze({...draft(),revision:4},nextId);await tick();
    assert.equal(e.client.blocked(),true);assert.equal(e.client.handoff().annotation_id,nextId);
  }finally{e.client.dispose();}
});

test('readback may accept A while its enqueue HTTP response is delayed and B still stages independently',async()=>{
  const releases=new Map(),sent=new Map(),cleaned=[];
  const e=environment({onAccepted:value=>cleaned.push(value.annotation_id),api:async(action,args)=>{const batch=plain(args.batch);sent.set(batch.annotation_id,batch);await new Promise(resolve=>releases.set(batch.annotation_id,resolve));return {job:{annotation_id:batch.annotation_id,batch,status:'queued'}};}});
  try{
    e.client.freeze(draft(),id);await tick();e.setRemote([{annotation_id:id,batch:sent.get(id),status:'saved'}]);await e.client.refresh();await tick();
    const nextId='43198fdf-7a31-48ba-8c3f-639f830798ac';e.client.freeze({...draft(),revision:4},nextId);await tick();
    assert.equal(sent.has(nextId),true,'A delayed response must not absorb B staging');
    releases.get(id)();await tick();assert.equal(e.client.handoff().annotation_id,nextId);assert.equal(e.client.blocked(),true);
    assert.equal(e.client.records().find(value=>value.annotation_id===id).status,'saved','Late queued acknowledgment cannot downgrade a saved receipt');
    releases.get(nextId)();await tick();assert.equal(e.client.blocked(),false);assert.deepEqual(cleaned,[id,nextId]);
  }finally{e.client.dispose();}
});

test('app handoff restoration keeps the frozen request revision while the reader revision advances',async()=>{
  const readerSource=await readFile(new URL('../web/pdf-reader.js',import.meta.url),'utf8'),appSource=await readFile(new URL('../web/app.js',import.meta.url),'utf8');
  const ctx=vm.createContext({window:{},TextEncoder,queueMicrotask,setTimeout,clearTimeout});vm.runInContext(readerSource,ctx);vm.runInContext(source,ctx);
  const buffer=ctx.window.PaperPDFReader.createInkBuffer();for(let i=0;i<5;i++)buffer.clear();
  const errors=[],writes=[],requests=[],remote={...draft(),annotation_id:id,attempted:false};
  Object.assign(ctx,{restoringInkDraft:false,inkDraftStorageBlocked:false,inkSaveUncertain:false,inkSaveBusy:false,restoringReader:false,inkDraftUpdatedAt:0,inkSaveIdentity:null,pendingInkHandoff:null,
    pdfReader:{clearInk:value=>buffer.clear(value),restoreInkDraft:value=>buffer.restore(value),getInkDraft:()=>buffer.snapshot(),setInkEnabled:()=>{},isInking:()=>false},readingShell:{inkChanged(){},inkSaving(){}},linkedHandwritingUI:{restore:async()=>{}},
    persistence:{put:async(key,value)=>{writes.push(plain(value));}},publishReaderState(){},toast:message=>errors.push(message)});
  ctx.inkQueue=ctx.window.PaperInkQueueClient.create({persistence:ctx.persistence,api:async(action,args)=>{requests.push(plain(args.batch));return {job:{annotation_id:id,batch:remote,status:'queued'}};},onError:error=>errors.push(error.message)});
  const adopt=appSource.slice(appSource.indexOf('async function adoptInkHandoff('),appSource.indexOf('\nfunction inkDraftChanged('));
  const save=appSource.slice(appSource.indexOf('function saveInkDraft('),appSource.indexOf('\nasync function returnToInkDraft('));vm.runInContext(adopt+'\n'+save,ctx);
  try{
    await ctx.adoptInkHandoff({draft:draft(),annotation_id:id,attempted:false,frozen:true,updatedAt:100});await tick();
    assert.equal(requests.length,1);assert.equal(requests[0].revision,3,'Send the frozen host revision, never the reader clear/undo token');
    assert.equal(writes[0].draft.revision,3,'Persist the same request across another reload');
    assert.equal(ctx.inkQueue.blocked(),false);assert.equal(buffer.snapshot(),null);assert.deepEqual(errors,[]);
  }finally{ctx.inkQueue.dispose();}
});

test('truncated geometry preserves pending jobs and lightweight saved receipts retain their exact paths',async()=>{
  const e=environment();try{
    e.client.freeze(draft(),id);await tick();
    e.setListResponse({jobs:[],truncated:true});await e.client.refresh();
    assert.equal(e.client.records()[0].status,'queued');assert.equal(e.client.hasPending('paper-a','highlight-a'),true);
    e.setListResponse({jobs:[],receipts:[{annotation_id:id,paperId:'paper-a',status:'saved',updatedAt:200}],truncated:true});
    await e.client.refresh();await tick();
    assert.equal(e.client.records()[0].status,'saved');assert.deepEqual(plain(e.client.records()[0].paths),draft().paths);
    assert.equal(e.client.hasPending('paper-a','highlight-a'),false);assert.equal(e.saved.length,1);
    await e.client.refresh();await tick();assert.equal(e.saved.length,1);
  }finally{e.client.dispose();}
});

test('a receipt without the frozen body cannot acknowledge an uncertain enqueue',async()=>{
  let cleaned=0;const e=environment({onAccepted:()=>{cleaned++;}});try{
    e.fail(true);e.client.freeze(draft(),id,{updatedAt:100});await tick();const frozen=plain(e.client.handoff());
    e.setListResponse({jobs:[],receipts:[{annotation_id:id,paperId:'paper-a',status:'saved',updatedAt:200}],truncated:true});
    await e.client.refresh();await tick();
    assert.equal(e.client.blocked(),true,'Only full immutable readback can release the original handoff');
    assert.deepEqual(plain(e.client.handoff()),frozen);assert.equal(cleaned,0);
    assert.equal(e.client.records()[0].status,'stage_failed');assert.equal(e.saved.length,0,'A receipt summary must not announce unverified geometry as saved');
    e.fail(false);await e.client.retry(id);await tick();
    assert.equal(e.client.blocked(),false);assert.equal(cleaned,1);
    const enqueues=e.requests.filter(([action])=>action==='ink_queue_enqueue');assert.deepEqual(enqueues[1],enqueues[0]);
  }finally{e.client.dispose();}
});

test('complete omission retains a pending batch as uncertain and surfaces host list errors',async()=>{
  const e=environment();try{
    e.client.freeze(draft(),id);await tick();
    e.setListResponse({jobs:[],receipts:[],truncated:false,error:{message:'manifest changed during readback'}});
    await e.client.refresh();const retained=e.client.records()[0];
    assert.equal(retained.annotation_id,id);assert.equal(retained.status,'uncertain');assert.deepEqual(plain(retained.paths),draft().paths);
    assert.equal(e.client.hasPending('paper-a','highlight-a'),true);assert.match(e.errors.at(-1),/manifest changed during readback/);
  }finally{e.client.dispose();}
});

test('iframe handoff publishes the frozen request revision without mutating the reader undo token',async()=>{
  const appSource=await readFile(new URL('../web/app.js',import.meta.url),'utf8');
  const start=appSource.indexOf('function publishReaderState()'),end=appSource.indexOf('async function restoreReaderState()',start);
  assert.ok(start>=0&&end>start);const messages=[],current={...draft(),revision:9};
  const context={state:{active:{id:'paper-a'},page:1,tab:'reader'},restoringReader:false,readerPaperId:'paper-a',workbenchUI:null,paperChatUI:null,readingPanels:null,
    handwritingUI:null,linkedHandwritingUI:null,pdfReader:{getInkDraft:()=>current},inkSaveIdentity:{paperId:'paper-a',revision:9,requestRevision:3,id},inkSaveUncertain:false,inkDraftUpdatedAt:100,
    inkQueue:null,pendingInkHandoff:null,persistence:null,readerStateReady:false,$:()=>({open:false}),Blob,
    window:{parent:{postMessage:value=>messages.push(plain(value))},location:{origin:'http://localhost:43121'}}};
  vm.runInNewContext(appSource.slice(start,end)+'\npublishReaderState();',context);
  assert.equal(messages.length,1);assert.equal(messages[0].snapshot.inkDraftRecord.draft.revision,3);
  assert.equal(messages[0].snapshot.inkDraftRecord.annotation_id,id);assert.equal(current.revision,9);
});

test('queue status updates cannot reopen input during asynchronous handoff restoration',async()=>{
  const appSource=await readFile(new URL('../web/app.js',import.meta.url),'utf8');
  const start=appSource.indexOf('inkQueue=window.PaperInkQueueClient?.create('),end=appSource.indexOf('\nlinkedHandwritingUI=',start);
  assert.ok(start>=0&&end>start);const enabled=[];let options;
  const context={window:{PaperInkQueueClient:{create:value=>{options=value;return {blocked:()=>false};}}},api(){},persistence:null,inkQueue:null,
    restoringInkDraft:true,inkSaveUncertain:false,pendingInkHandoff:null,pdfReader:{setInkEnabled:value=>enabled.push(value),setInkOverlays(){}},readingShell:{queueChanged(){}},
    state:{active:null},publishReaderState(){}};
  vm.runInNewContext(appSource.slice(start,end),context);options.onChange([]);
  assert.equal(enabled.at(-1),false,'Restoration holds the input lock until its durable write completes');
  context.restoringInkDraft=false;options.onChange([]);assert.equal(enabled.at(-1),true);
});

test('saved queue notifications wait for fresh annotations before considering automatic recognition',async()=>{
  const appSource=await readFile(new URL('../web/app.js',import.meta.url),'utf8');
  const start=appSource.indexOf('inkQueue=window.PaperInkQueueClient?.create('),end=appSource.indexOf('\nlinkedHandwritingUI=',start);
  const recognized=[],errors=[];let releaseAnnotations,remote=[];
  const annotationsGate=new Promise(resolve=>{releaseAnnotations=resolve;});
  const context=vm.createContext({window:{},TextEncoder,queueMicrotask,setTimeout,clearTimeout});vm.runInContext(source,context);
  const paperReady=()=>{if(!context.inkQueue.hasPending('paper-a','highlight-a'))recognized.push(context.state.annotationVersion);};
  Object.assign(context,{inkQueue:null,api:async(action,args)=>{if(action==='ink_queue_list')return {jobs:remote};const job={annotation_id:id,batch:args.batch,status:'queued'};remote=[job];return {job};},persistence:{put:async()=>{}},
    state:{active:{id:'paper-a'},annotationVersion:'before-save'},restoringInkDraft:false,restoringReader:false,inkSaveUncertain:false,inkDraftStorageBlocked:false,pendingInkHandoff:null,inkDraftUpdatedAt:0,
    pdfReader:{setInkEnabled(){},setInkOverlays(){},refresh(){}},readingShell:{queueChanged(){}},paperChatUI:null,renderAnnotations(){},publishReaderState(){},toast:message=>errors.push(message),
    linkedHandwritingUI:{paperReady,saved(){}},loadAnnotations:async()=>{await annotationsGate;context.state.annotationVersion='after-save';paperReady();return true;}});
  vm.runInContext(appSource.slice(start,end),context);
  try{
    context.inkQueue.freeze(draft(),id);await tick();remote=remote.map(job=>({...job,status:'saved'}));
    await context.inkQueue.refresh();await tick();
    assert.deepEqual(recognized,[],'A saved queue receipt is not proof that the annotation snapshot has refreshed');
    releaseAnnotations();await tick();assert.deepEqual(recognized,['after-save']);assert.deepEqual(errors,[]);
  }finally{releaseAnnotations();context.inkQueue.dispose();}
});
