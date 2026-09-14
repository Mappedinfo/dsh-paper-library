import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
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
