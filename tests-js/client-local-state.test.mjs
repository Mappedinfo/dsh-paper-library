import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {webcrypto} from 'node:crypto';
const source=await readFile(new URL('../web/local-state.js',import.meta.url),'utf8');
const clone=value=>JSON.parse(JSON.stringify(value));
function server(){const records=new Map(),calls=[];let serial=0;return {records,calls,async api(action,args){calls.push({action,...clone(args)});const old=records.get(args.key)||{key:args.key,value:null,revision:0};if(action==='state_get')return clone(old);assert.equal(action,'state_put');if(args.expected_revision!==old.revision){const error=new Error('Conflict');error.status=409;throw error;}const result={key:args.key,value:clone(args.value),revision:(++serial).toString(16).padStart(64,'0')};records.set(args.key,result);return clone(result);}};}
function client(remote,{legacy=new Map(),api=remote.api}={}){const errors=[],events=[],window={crypto:webcrypto,localStorage:{getItem:key=>legacy.get(key)??null,removeItem:key=>legacy.delete(key),setItem(){throw new Error('Browser writes are forbidden');}}};vm.runInNewContext(source,{window,TextEncoder});const store=window.PaperLibraryLocalState.create({api,onError:(...args)=>errors.push(args)});store.subscribe(event=>events.push(event));return {store,errors,events};}
test('client durable values survive a new browser and working-cache eviction',async()=>{const remote=server(),a=client(remote);for(let i=0;i<40;i++)await a.store.put(`chat:paper-${i}`,{draft:`Question ${i}`});const b=client(remote);assert.deepEqual(clone(await b.store.get('chat:paper-0')),{draft:'Question 0'});assert.equal(remote.records.size,40);});
test('client same-key writes coalesce and patches preserve independent preference fields',async()=>{const remote=server(),a=client(remote);await a.store.get('preferences');await Promise.all([a.store.patch('preferences',{model:'synthetic/model'}),a.store.patch('preferences',{'reading-panel-side':'right'}),a.store.patch('preferences',{'auto-feedback':true})]);assert.deepEqual(clone(await a.store.get('preferences')),{model:'synthetic/model','reading-panel-side':'right','auto-feedback':true});const writes=remote.calls.filter(c=>c.action==='state_put');assert.ok(writes.length<=2);for(let i=1;i<writes.length;i++)assert.notEqual(writes[i].expected_revision,writes[i-1].expected_revision);});
test('client cross-browser conflicts retain exportable local text without overwriting remote state',async()=>{const remote=server(),a=client(remote),b=client(remote);await a.store.put('chat:paper-a',{draft:'Initial'});await b.store.get('chat:paper-a');await a.store.put('chat:paper-a',{draft:'Browser A'});await assert.rejects(b.store.put('chat:paper-a',{draft:'Browser B'}),/另一浏览器/);assert.equal(remote.records.get('chat:paper-a').value.draft,'Browser A');assert.equal((await b.store.get('chat:paper-a')).draft,'Browser B');assert.equal(b.store.status('chat:paper-a').status,'conflict');assert.equal(b.store.exportPending()[0].value.draft,'Browser B');await assert.rejects(b.store.flush(),/另一浏览器/);assert.equal(remote.records.get('chat:paper-a').value.draft,'Browser A');});
test('client lost responses are confirmed through exact readback without duplicating a write',async()=>{const remote=server();let lose=true;const a=client(remote,{api:async(action,args)=>{const result=await remote.api(action,args);if(action==='state_put'&&lose){lose=false;throw new Error('Lost response');}return result;}});await a.store.put('reader',{paperId:'paper-a'});assert.equal(remote.calls.filter(value=>value.action==='state_put').length,1);assert.equal(a.store.status('reader').status,'saved');});
test('client explicit retry saves retained failed writes and clears the failure status',async()=>{const remote=server();let offline=true;const a=client(remote,{api:async(action,args)=>{if(action==='state_put'&&offline)throw new Error('Offline');return remote.api(action,args);}});await assert.rejects(a.store.put('metadata:paper-a',{title:'Unsaved'}),/Offline/);assert.equal((await a.store.get('metadata:paper-a')).title,'Unsaved');offline=false;await a.store.retry('metadata:paper-a');assert.equal(a.store.status('metadata:paper-a').status,'saved');assert.equal(a.store.status('metadata:paper-a').error,null);});
test('first-read outages retain an exportable candidate and never overwrite previously unseen remote content',async()=>{const remote=server();let offline=true;const a=client(remote,{api:async(action,args)=>{if(offline)throw new Error('Disconnected');return remote.api(action,args);}});await assert.rejects(a.store.put('chat:paper-a',{draft:'Local candidate'}));assert.equal(a.store.exportPending()[0].value.draft,'Local candidate');await remote.api('state_put',{key:'chat:paper-a',value:{draft:'Existing remote'},expected_revision:0});offline=false;await assert.rejects(a.store.retry('chat:paper-a'),/另一浏览器/);assert.equal(remote.records.get('chat:paper-a').value.draft,'Existing remote');});
test('legacy migration verifies service writes before removing only known browser keys',async()=>{const remote=server(),legacy=new Map([['paper-library:synthetic:model','synthetic/model'],['paper-library:synthetic:paper-drafts-v2',JSON.stringify([['paper-a',{draft:'Old draft',annotationRefs:[]}]])],['paper-library:reading-panel-side:v1','right'],['unrelated-private-key','untouched']]);const a=client(remote,{legacy});const result=await a.store.migrateLegacy(()=>'synthetic');assert.equal(result.migrated,3);assert.deepEqual([...legacy.keys()],['unrelated-private-key']);assert.equal((await a.store.get('chat:paper-a')).draft,'Old draft');assert.equal((await a.store.get('preferences'))['reading-panel-side'],'right');});
test('legacy migration backs up conflicts on the service without resurrecting a cleared host draft',async()=>{for(const remoteValue of [{draft:'New host'},null]){const remote=server(),legacy=new Map([['paper-library:synthetic:paper-drafts-v2',JSON.stringify([['paper-a',{draft:'Old browser'}]])]]);await remote.api('state_put',{key:'chat:paper-a',value:remoteValue,expected_revision:0});const a=client(remote,{legacy});const result=await a.store.migrateLegacy('synthetic');assert.equal(result.retained,0);assert.equal(result.backedUp,1);assert.equal(legacy.size,0);assert.deepEqual(remote.records.get('chat:paper-a').value,remoteValue);const backup=[...remote.records.values()].find(record=>record.key.startsWith('migration:'));assert.deepEqual(backup.value.value,[['paper-a',{draft:'Old browser'}]]);assert.ok(a.errors.length);}});
test('client lifecycle flush covers a write submitted immediately before it',async()=>{const remote=server(),a=client(remote);const pending=a.store.put('reader',{paperId:'paper-a'});await a.store.flush({keepalive:true});assert.equal(remote.records.get('reader')?.value.paperId,'paper-a');await pending;});
test('legacy preferences respect a host tombstone and keep their old values in verified backups',async()=>{
  const remote=server(),legacy=new Map([['paper-library:synthetic:model','synthetic/old'],['paper-library:reading-panel-side:v1','right']]);
  await remote.api('state_put',{key:'preferences',value:null,expected_revision:0});const a=client(remote,{legacy});
  const result=await a.store.migrateLegacy('synthetic');assert.equal(result.backedUp,2);assert.equal(legacy.size,0);
  assert.equal(remote.records.get('preferences').value,null);assert.equal([...remote.records.keys()].filter(key=>key.startsWith('migration:')).length,2);
});
test('normal small writes already use keepalive and request sizing includes UTF-8 content',async()=>{
  const remote=server(),options=[],a=client(remote,{api:(action,args,opts)=>{if(action==='state_put')options.push(opts);return remote.api(action,args);}});
  await a.store.put('chat:small',{draft:'中文草稿'});await a.store.put('metadata:large',{title:'中'.repeat(21000)});
  assert.equal(options[0].keepalive,true);assert.equal(options[1].keepalive,false);
  await assert.rejects(a.store.put('metadata:oversize',{title:'中'.repeat(90000)}),/256 KiB/);
  assert.equal(remote.records.has('metadata:oversize'),false);
});

test('retry and flush recover read-only failures and clear their error status',async()=>{
 const remote=server();let offline=true;const a=client(remote,{api:async(action,args)=>{if(offline)throw Error('Temporary outage');return remote.api(action,args);}});
 await assert.rejects(a.store.get('workspace:last:main'));offline=false;await a.store.flush();assert.equal(a.store.status('workspace:last:main').status,'saved');
 offline=true;await assert.rejects(a.store.get('reader'));offline=false;await a.store.retry('reader');assert.equal(a.store.status('reader').status,'saved');
});

test('parallel drafts share the browser keepalive byte budget without dropping writes',async()=>{
 const remote=server();let release,notify,entered=0;const gate=new Promise(r=>release=r),both=new Promise(r=>notify=r),modes=[];
 const a=client(remote,{api:async(action,args,options)=>{if(action==='state_put'){modes.push(options.keepalive);if(++entered===2)notify();await gate;}return remote.api(action,args);}});
 const writes=[a.store.put('chat:a',{draft:'x'.repeat(35000)}),a.store.put('chat:b',{draft:'x'.repeat(35000)})];await both;release();await Promise.all(writes);
 assert.deepEqual(modes,[true,false]);assert.equal(remote.records.size,2);
});

test('default three-way merge retains independent browser fields and nested changes',async()=>{
 const remote=server(),a=client(remote),b=client(remote);
 await a.store.put('preferences',{palette:'neutral',reader:{zoom:100,side:'left'},keep:true});await b.store.get('preferences');
 await a.store.patch('preferences',{palette:'rose',reader:{zoom:125,side:'left'}});
 const result=await b.store.patch('preferences',{reader:{zoom:100,side:'right'}});
 assert.deepEqual(clone(result),{palette:'rose',reader:{zoom:125,side:'right'},keep:true});
 assert.deepEqual(remote.records.get('preferences').value,clone(result));assert.equal(b.errors.length,0);assert.equal(b.store.exportPending().length,0);
});
test('object additions and deletions merge without resurrecting deleted values or treating null as missing',async()=>{
 const remote=server(),a=client(remote),b=client(remote);
 await a.store.put('metadata:merge',{title:'Keep',obsolete:'Remove',nested:{old:1,keep:2},nullable:'old'});await b.store.get('metadata:merge');
 await a.store.put('metadata:merge',{title:'Keep',nested:{keep:2},nullable:'old',remote:'added'});
 const result=await b.store.put('metadata:merge',{title:'New',obsolete:'Remove',nested:{old:1,keep:2,local:3},nullable:null});
 assert.deepEqual(clone(result),{title:'New',nested:{keep:2,local:3},nullable:null,remote:'added'});
});
test('simultaneous initial records merge independent fields but not divergent text or arrays',async()=>{
 const remote=server(),a=client(remote),b=client(remote);await Promise.all([a.store.get('reader'),b.store.get('reader')]);
 await a.store.put('reader',{zoom:120});await b.store.put('reader',{layout:'double'});assert.deepEqual(remote.records.get('reader').value,{zoom:120,layout:'double'});
 for(const initial of [{text:'initial'},{items:['first']},{group:{value:1}}]){
  const key=`reader:test${remote.records.size}`,c=client(remote),d=client(remote);await c.store.put(key,initial);await d.store.get(key);
  const left=initial.text?{text:'left'}:initial.items?{items:['first','left']}:{group:null};
  const right=initial.text?{text:'right'}:initial.items?{items:['right','first']}:{group:{value:2}};
  await c.store.put(key,left);await assert.rejects(d.store.put(key,right),/未自动合并/);assert.deepEqual(remote.records.get(key).value,left);assert.deepEqual(clone(d.store.exportPending()[0].value),right);
 }
});
test('delete versus edit is a real conflict, while identical deletion is accepted without another write',async()=>{
 const remote=server(),a=client(remote),b=client(remote);await a.store.put('metadata:delete',{field:'old',keep:1});await b.store.get('metadata:delete');
 await a.store.put('metadata:delete',{keep:1});await assert.rejects(b.store.put('metadata:delete',{field:'edited',keep:1}),/未自动合并/);
 const c=client(remote),d=client(remote);await c.store.put('metadata:identical',{field:'old'});await d.store.get('metadata:identical');
 await c.store.put('metadata:identical',{});const before=remote.calls.filter(c=>c.action==='state_put').length;await d.store.put('metadata:identical',{});
 assert.equal(remote.calls.filter(c=>c.action==='state_put').length,before+1);assert.equal(d.store.status('metadata:identical').status,'saved');
});
test('new input during conflict readback participates in the merged retry and all waiting callers finish',async()=>{
 const remote=server();await remote.api('state_put',{key:'metadata:pending',value:{a:0,b:0,c:0},expected_revision:0});
 let release,entered;const gate=new Promise(r=>release=r),started=new Promise(r=>entered=r);let first=true;
 const a=client(remote,{api:async(action,args)=>{if(action==='state_put'&&first){first=false;entered();await gate;}return remote.api(action,args);}});await a.store.get('metadata:pending');
 const pending=a.store.patch('metadata:pending',{a:1});await started;
 const b=client(remote);await b.store.patch('metadata:pending',{b:2});const later=a.store.patch('metadata:pending',{c:3});release();await Promise.all([pending,later]);
 assert.deepEqual(remote.records.get('metadata:pending').value,{a:1,b:2,c:3});assert.equal(a.store.status('metadata:pending').status,'saved');
});
test('lost acknowledgement plus a later remote edit preserves newer local input from the same send',async()=>{
 const remote=server();await remote.api('state_put',{key:'reader:lost',value:{a:0,b:0},expected_revision:0});
 let release,entered;const gate=new Promise(r=>release=r),started=new Promise(r=>entered=r);let first=true;
 const a=client(remote,{api:async(action,args)=>{const result=await remote.api(action,args);if(action==='state_put'&&first){first=false;entered();await gate;throw Error('Lost reply');}return result;}});await a.store.get('reader:lost');
 const pending=a.store.patch('reader:lost',{a:1});await started;
 const b=client(remote);await b.store.patch('reader:lost',{b:2});const later=a.store.patch('reader:lost',{a:3});release();await Promise.all([pending,later]);
 assert.deepEqual(remote.records.get('reader:lost').value,{a:3,b:2});assert.equal(a.errors.length,0);
});
test('repeated concurrent revisions stop after a bounded retry budget and remain explicitly retryable',async()=>{
 const remote=server();await remote.api('state_put',{key:'reader:busy',value:{a:0,remote:0},expected_revision:0});let busy=true,count=0;
 const a=client(remote,{api:async(action,args)=>{if(action==='state_put'&&busy){const old=remote.records.get(args.key);await remote.api('state_put',{key:args.key,value:{...old.value,remote:++count},expected_revision:old.revision});}return remote.api(action,args);}});await a.store.get('reader:busy');
 await assert.rejects(a.store.patch('reader:busy',{a:1}),/自动合并已暂停/);assert.equal(count,4);assert.equal(a.store.status('reader:busy').dirty,true);assert.equal(a.store.exportPending()[0].value.a,1);
 busy=false;await a.store.retry('reader:busy');assert.deepEqual(remote.records.get('reader:busy').value,{a:1,remote:4});assert.equal(a.store.status('reader:busy').status,'saved');
});
test('merged records still obey the byte budget and special JSON keys cannot change prototypes',async()=>{
 const remote=server(),a=client(remote),b=client(remote);await a.store.put('metadata:large-merge',{});await b.store.get('metadata:large-merge');
 await a.store.put('metadata:large-merge',{remote:'r'.repeat(140000)});await assert.rejects(b.store.put('metadata:large-merge',{local:'l'.repeat(140000)}),/256 KiB/);
 assert.equal(remote.records.get('metadata:large-merge').value.local,undefined);assert.equal(b.store.exportPending()[0].value.local.length,140000);
 const c=client(remote),d=client(remote);await c.store.put('reader:keys',{});await d.store.get('reader:keys');await c.store.put('reader:keys',JSON.parse('{"__proto__":{"injected":true}}'));await d.store.put('reader:keys',{local:true});
 const value=remote.records.get('reader:keys').value;assert.equal(Object.hasOwn(value,'__proto__'),true);assert.deepEqual(value.__proto__,{injected:true});assert.equal({}.injected,undefined);assert.equal(value.local,true);
});
