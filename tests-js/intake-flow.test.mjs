import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { core, dispatch, projectRoot } from '../src/bridge.mjs';
import { createFetchHandler } from '../src/http.mjs';
import { bibliographicMetadata, metadataMatchesPDF } from '../src/import-pdf.mjs';

async function fixture(run) {
  const directory=await mkdtemp(join(tmpdir(),'paper-intake-'));
  try {
    const generated=spawnSync(join(projectRoot,'.venv/bin/python'),['scripts/create-demo.py','--output',join(directory,'source')],{cwd:projectRoot,encoding:'utf8'});
    assert.equal(generated.status,0,generated.stderr);
    await run({directory,path:join(directory,'source','example-1.pdf'),library:join(directory,'library')});
  } finally {await rm(directory,{recursive:true,force:true});}
}
const hash = buffer => createHash('sha256').update(buffer).digest('hex');
function transportFor(pdf, html) {
  const requests=[];
  return {requests,resolver:async()=>[{address:'93.184.216.34',family:4}],transport:async({url})=>{
    requests.push(url.href);
    const body=url.pathname==='/article'?Buffer.from(html):pdf;
    return {statusCode:200,headers:{'content-type':url.pathname==='/article'?'text/html':'application/pdf','content-length':String(body.length)},body:Readable.from([body]),close(){}};
  }};
}

test('raw streamed PDF upload parses, names and saves a portable copy without changing the source',()=>fixture(async({path,library})=>{
  const original=hash(await readFile(path));
  const handler=createFetchHandler({library});
  const response=await handler(new Request('http://localhost/upload?filename=dragged.pdf',{method:'POST',headers:{'content-type':'application/pdf',origin:'http://localhost'},body:Readable.toWeb(createReadStream(path,{highWaterMark:1024})),duplex:'half'}));
  const payload=await response.json();
  assert.equal(payload.ok,true,JSON.stringify(payload));
  const item=payload.result.items[0];
  assert.equal(item.pdf,true);assert.equal(item.title,'Reading urban change');
  assert.match(item.pdf_filename,/Reading-urban-change--[a-f0-9]{8}\.pdf$/);
  assert.ok(item.parse.pages_inspected<=3);
  assert.equal(hash(await readFile(path)),original);
  const download=await handler(new Request(`http://localhost/pdf/${item.id}`));
  assert.equal(download.status,200);assert.match(download.headers.get('content-disposition'),/Reading-urban-change/);
  assert.equal(Buffer.from(await download.arrayBuffer()).subarray(0,5).toString(),'%PDF-');
  const again=await dispatch({action:'import',path},{library});
  assert.equal(again.duplicates,1);assert.equal(again.items[0].id,item.id);
}));

test('a public article link downloads, verifies identity and retains acquisition provenance',()=>fixture(async({path,library})=>{
  const transport=transportFor(await readFile(path),'<meta name="citation_title" content="Reading urban change"><meta name="citation_author" content="Shiqi Wang"><meta name="citation_publication_date" content="2026"><meta name="citation_pdf_url" content="/paper.pdf">');
  const result=await dispatch({action:'import',url:'https://papers.example/article'},{library,fetchOptions:transport});
  assert.equal(result.items[0].pdf,true);
  assert.match(result.items[0].pdf_filename,/2026-Reading-urban-change/);
  assert.equal(result.acquisition.status,'downloaded');
  assert.equal(result.items[0].acquisition.source_url,'https://papers.example/paper.pdf');
  assert.equal(result.items[0].acquisition.validation,'pdf_parser');
  assert.deepEqual(transport.requests,['https://papers.example/article','https://papers.example/paper.pdf']);
}));

test('metadata-only landing pages remain explicit and malformed PDF bytes do not create a paper',()=>fixture(async({path,library})=>{
  const transport=transportFor(await readFile(path),'<meta name="citation_title" content="Metadata only paper">');
  const result=await dispatch({action:'import',url:'https://papers.example/article'},{library,fetchOptions:transport});
  assert.equal(result.acquisition.status,'metadata_only');assert.equal(result.items[0].pdf,false);
  assert.ok(result.warnings.some(warning=>warning.includes('尚未获得可读 PDF')));
  const broken=transportFor(Buffer.from('%PDF-this is not a readable document'),'');
  await assert.rejects(dispatch({action:'import',url:'https://papers.example/broken.pdf'},{library,fetchOptions:broken}));
  assert.equal((await core({action:'status'},{library})).count,1);
}));

test('upload limits and same-origin checks apply before processing a document',async()=>{
  const handler=createFetchHandler();
  const post=(headers,filename='x.pdf')=>handler(new Request(`http://localhost/upload?filename=${filename}`,{method:'POST',headers,body:'x'}));
  assert.equal((await post({'content-type':'application/pdf',origin:'https://untrusted.example'})).status,403);
  assert.equal((await post({'content-type':'text/html'})).status,415);
  assert.equal((await post({'content-type':'application/pdf','content-length':String(250*1024*1024+1)})).status,413);
  assert.equal((await post({'content-type':'application/pdf'},'x.html')).status,400);
  const blocked=await handler(new Request('http://localhost/api',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'inspect_pdf',path:'/untrusted.pdf'})}));
  assert.equal(blocked.status,403);
});

test('metadata enrichment rejects unrelated titles and source-controlled filesystem fields',()=>{
  assert.equal(metadataMatchesPDF({title:'A completely unrelated reference'},{metadata:{title:'Reading urban change'},parse:{text_excerpt:'Reading urban change'}}),false);
  assert.equal(metadataMatchesPDF({title:'Reading urban change'},{metadata:{title:'Reading urban change'},parse:{text_excerpt:''}}),true);
  assert.deepEqual(bibliographicMetadata({title:'A title',attachments:[{path:'/private/file.pdf'}],parse:{needs_review:false},path:'/private/file.pdf',metadata_verified:true}),{title:'A title'});
});

test('parallel JSON intake is rejected before another body is read and releases admission after failure',async()=>{
  const handler=createFetchHandler();
  const controllers=[];
  const start=()=>handler(new Request('http://localhost/api',{method:'POST',headers:{'content-type':'application/json'},body:new ReadableStream({start(controller){controllers.push(controller);}}),duplex:'half'}));
  const first=start(), second=start();
  const third=await start();
  assert.equal(third.status,429);
  for(const controller of controllers) controller.close();
  assert.equal((await first).status,400);assert.equal((await second).status,400);
  const next=await handler(new Request('http://localhost/api',{method:'POST',headers:{'content-type':'application/json'},body:'null'}));
  assert.equal(next.status,400);assert.match((await next.json()).error,/JSON 对象/);
});

test('queued imports enforce an aggregate payload budget and release it on cancellation',async()=>{
  const body='A'.repeat(12*1024*1024);
  const signal=AbortSignal.abort();
  const requests=Array.from({length:5},()=>dispatch({action:'import',content_base64:body,filename:'large.json'},{signal}));
  const results=await Promise.allSettled(requests);
  assert.ok(results.some(result=>result.status==='rejected' && result.reason.message.includes('内存预算已满')));
  const next=await Promise.allSettled([dispatch({action:'import',content_base64:body,filename:'large.json'},{signal})]);
  assert.equal(next[0].status,'rejected');
  assert.doesNotMatch(next[0].reason.message,/内存预算/);
});
