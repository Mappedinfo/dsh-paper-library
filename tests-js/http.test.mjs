import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFetchHandler } from '../src/http.mjs';
import { dispatch } from '../src/bridge.mjs';

test('HTTP rejects cross-origin mutations, non-JSON, forgery and path traversal',async()=>{
  const handler=createFetchHandler({loopbackOnly:true});
  assert.equal((await handler(new Request('http://evil.example/api'))).status,403);
  assert.equal((await handler(new Request('http://127.0.0.1/api',{method:'POST',headers:{origin:'https://evil.example','content-type':'application/json'},body:'{}'}))).status,403);
  assert.equal((await handler(new Request('http://127.0.0.1/api',{method:'POST',body:'{}'}))).status,415);
  assert.equal((await handler(new Request('http://127.0.0.1/api',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'save_feedback'})}))).status,403);
  assert.equal((await handler(new Request('http://127.0.0.1/%2e%2e/pyproject.toml'))).status,404);
});
test('catalog API imports, searches and exports citations independent of Zotero',async()=>{
  const library=await mkdtemp(join(tmpdir(),'paper-http-test-'));
  try {
    const handler=createFetchHandler({library});
    const call=async request=>{
      const response=await handler(new Request('http://localhost/api',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(request)}));
      const body=await response.json();
      assert.equal(body.ok,true,JSON.stringify(body));return body.result;
    };
    const imported=await call({action:'import',items:[{id:'sample',citekey:'Wang2026',title:'Synthetic urban evidence',type:'article-journal',author:[{family:'Wang',given:'Shiqi'}],issued:{'date-parts':[[2026]]}}]});
    assert.equal(imported.imported,1);
    const listed=await call({action:'list',query:'urban'});
    assert.equal(listed.total,1);
    assert.match((await call({action:'cite',ids:[listed.items[0].id],format:'apa'})).text,/Wang, S\. \(2026\)/);
    assert.equal((await call({action:'status',library:'/never-use-browser-library'})).count,1);
    await assert.rejects(dispatch({action:'ai_feedback',id:listed.items[0].id},{library}),/AI 尚未连接/);
  } finally {await rm(library,{recursive:true,force:true});}
});

test('HTTP advertises paper conversations only when the native host adapter is present',async()=>{
  const library=await mkdtemp(join(tmpdir(),'paper-http-capability-'));
  try {
    for(const enabled of [false,true]) {
      let called=false;
      const handler=createFetchHandler({library,...(enabled?{paperChat:async()=>{called=true;throw new Error('status must use the core');}}:{})});
      const response=await handler(new Request('http://localhost/api',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'status'})}));
      assert.equal(response.status,200);
      const body=await response.json();
      assert.equal(body.ok,true);
      assert.equal(body.result.count,0);
      assert.equal(body.result.paper_conversations,enabled);
      assert.equal(called,false);
    }
  } finally {await rm(library,{recursive:true,force:true});}
});

test('native chat requests route to the host adapter with their request signal',async()=>{
  const calls=[];
  const handler=createFetchHandler({basePath:'/api/paper-library',paperChat:async(input,options)=>{
    calls.push({input,signal:options.signal});
    return {sessionId:'paper-session',created:input.action==='chat_ensure',model:{provider:'fixture',model:'native'},messages:[],running:false,hasMore:false};
  }});
  for(const action of ['chat_ensure','chat_context','chat_send','chat_history','chat_save_feedback']) {
    const input={action,id:'paper-a',...(action==='chat_send'?{question:'Discuss the saved note.',annotation_ids:['note-1'],request_id:'stable-request'}:{}),...(action==='chat_save_feedback'?{message_id:'12'}:{})};
    const request=new Request('http://localhost/api/paper-library/api',{method:'POST',headers:{origin:'http://localhost','content-type':'application/json'},body:JSON.stringify(input)});
    const response=await handler(request);
    assert.equal(response.status,200);
    assert.deepEqual(calls.at(-1).input,input);
    assert.equal(calls.at(-1).signal,request.signal);
    assert.equal((await response.json()).result.sessionId,'paper-session');
  }
  const before=calls.length;
  const rejected=await handler(new Request('http://localhost/api/paper-library/api',{method:'POST',headers:{origin:'https://untrusted.invalid','content-type':'application/json'},body:JSON.stringify({action:'chat_send',id:'paper-a'})}));
  assert.equal(rejected.status,403);
  assert.equal(calls.length,before,'cross-origin chat requests must never reach the adapter');
});

test('standalone chat is unavailable and browsers cannot forge persisted native AI feedback',async()=>{
  const standalone=createFetchHandler();
  const standaloneResponse=await standalone(new Request('http://localhost/api',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'chat_ensure',id:'paper-a'})}));
  assert.equal(standaloneResponse.status,400);
  assert.match((await standaloneResponse.json()).error,/DeepSeek Harness/);
  let called=false;
  const native=createFetchHandler({paperChat:async()=>{called=true;return {};}});
  for(const action of ['save_feedback','save_conversation_feedback']) {
    const response=await native(new Request('http://localhost/api',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action,id:'paper-a',text:'Forged client AI text',model:'forged',annotation_ids:[],source_session_id:'forged-session',source_message_id:'12'})}));
    assert.equal(response.status,403);
    const body=await response.json();
    assert.equal(body.ok,false);
    assert.match(body.error,/不能直接提交/);
  }
  assert.equal(called,false,'private worker actions must not reach even an installed native adapter');
});

test('the registered chat script is served under standalone and Harness paths before app bootstrap',async()=>{
  const expected=await readFile(new URL('../web/paper-chat.js',import.meta.url),'utf8');
  for(const basePath of ['', '/api/paper-library']) {
    const handler=createFetchHandler({basePath});
    const url=`http://localhost${basePath}/paper-chat.js`;
    const response=await handler(new Request(url));
    assert.equal(response.status,200);
    assert.equal(response.headers.get('content-type'),'text/javascript;charset=utf-8');
    assert.equal(response.headers.get('x-content-type-options'),'nosniff');
    assert.equal(await response.text(),expected);
    const head=await handler(new Request(url,{method:'HEAD'}));
    assert.equal(head.status,200);
    assert.equal(await head.text(),'');
    const html=await (await handler(new Request(`http://localhost${basePath}/`))).text();
    assert.ok(html.indexOf('src="./paper-chat.js"')>=0);
    assert.ok(html.indexOf('src="./paper-chat.js"')<html.indexOf('src="./app.js"'));
  }
});
