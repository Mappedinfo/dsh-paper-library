import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {core} from '../src/bridge.mjs';
import {createFetchHandler} from '../src/http.mjs';

test('native reader reply travels through HTTP and bridge, stays independently referenceable and does not auto-ask AI',async t=>{
 const root=await mkdtemp(join(tmpdir(),'native-remark-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const python=resolve('.venv/bin/python'),path=join(root,'synthetic.pdf'),options={library:join(root,'library'),localStateHome:join(root,'home'),python};
 execFileSync(python,['-c',`import pymupdf,sys
with pymupdf.open() as d:
 p=d.new_page();p.insert_text((50,80),'Synthetic source sentence.');d.save(sys.argv[1])`,path]);
 const original=await readFile(path),id=(await core({action:'import',path},options)).items[0].id;
 const parent=(await core({action:'annotate',id,page:1,type:'underline',rects:[[50,65,200,82]],text:'Synthetic source sentence.',comment:'Remark 1'},options)).annotation;
 const handler=createFetchHandler({...options,companion:{saved:()=>assert.fail('Saving a human reply must not call AI')}});
 const send=async payload=>{const response=await handler(new Request('http://localhost/api',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)}));const body=await response.json();assert.equal(body.ok,true,body.error);return body.result;};
 const input={action:'annotation_reply_create',id,annotation_id:parent.id,reply_id:randomUUID(),comment:'Remark 2',companion_skip:true};
 const first=await send(input),retry=await send(input);assert.equal(retry.duplicate,true);assert.equal(first.annotation.id,retry.annotation.id);assert.equal(first.annotation.reply_to,parent.id);
 const catalog=await send({action:'annotation_catalog',id,annotation_id:first.annotation.id});assert.equal(catalog.annotations[0].text,parent.text);
 const exact=await send({action:'annotation_context_exact',id,annotation_refs:[{id:first.annotation.id,version:catalog.annotations[0].version}]});assert.equal(exact.annotations[0].comment,'Remark 2');
 const notes=(await send({action:'annotations',id})).annotations;assert.equal(notes.filter(n=>n.type==='underline').length,1);assert.equal(notes.filter(n=>n.kind==='reader-reply').length,1);
 assert.deepEqual(await readFile(path),original);
});

test('rectangle screenshot reaches the Python worker through HTTP and retries without touching original PDF',async t=>{
 const root=await mkdtemp(join(tmpdir(),'native-preview-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const python=resolve('.venv/bin/python'),path=join(root,'synthetic.pdf'),options={library:join(root,'library'),localStateHome:join(root,'home'),python};
 execFileSync(python,['-c',`import pymupdf,sys
with pymupdf.open() as d:
 p=d.new_page();p.insert_text((50,80),'Synthetic figure.');d.save(sys.argv[1])`,path]);
 const original=await readFile(path),id=(await core({action:'import',path},options)).items[0].id;
 const note=(await core({action:'annotate',id,page:1,type:'square',rects:[[40,55,220,100]],comment:''},options)).annotation;
 const handler=createFetchHandler(options);
 for(let attempt=0;attempt<2;attempt++){
  const response=await handler(new Request('http://localhost/api',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'annotation_preview',id,page:1,annotation_id:note.id,render_width:480})}));
  const body=await response.json();assert.equal(body.ok,true,body.error);const result=body.result;
  assert.equal(result.annotation_id,note.id);assert.equal(result.mime_type,'image/png');assert.ok(result.width<=640);assert.ok(result.height<=640);assert.equal(Buffer.from(result.image,'base64').subarray(1,4).toString(),'PNG');
 }
 assert.deepEqual(await readFile(path),original);
});
