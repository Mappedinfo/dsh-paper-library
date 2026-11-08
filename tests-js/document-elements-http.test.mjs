import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {core} from '../src/bridge.mjs';
import {createFetchHandler} from '../src/http.mjs';

test('document reading actions run through HTTP → bridge → worker with real synthetic crops, flow and citation edges',async t=>{
 const root=await mkdtemp(join(tmpdir(),'document-elements-http-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const python=resolve('.venv/bin/python'),path=join(root,'synthetic.pdf'),options={library:join(root,'library'),localStateHome:join(root,'home'),python};
 execFileSync(python,['-c',`import pymupdf,sys
with pymupdf.open() as d:
 p=d.new_page();p.draw_rect(pymupdf.Rect(50,60,250,180),color=(0,0,1));p.insert_text((50,200),'Figure 1. Workflow for synthetic records')
 p.insert_text((50,260),'y = a*x + b (1)');p.insert_text((50,280),'where x denotes input and b denotes bias.')
 p.insert_text((50,350),'Algorithm 1. Process records')
 for i,s in enumerate(['1 Initialize count', '2 for each record do','3 Update count','4 end for','5 return count']):p.insert_text((50,380+18*i),s)
 p=d.new_page();p.insert_text((50,60),'References');p.insert_text((50,100),'Adams, A., and Brown, B., 2020. A synthetic method. Journal of Examples, 1, 1-5.');p.insert_text((50,130),'Chen, C., et al., 2021. Testing systems. Example Journal, 2, 3-7.')
 d.save(sys.argv[1])`,path]);
 const original=await readFile(path),id=(await core({action:'import',path},options)).items[0].id;
 const handler=createFetchHandler({...options,companion:{saved:()=>assert.fail('Extraction must not call AI')}});
 const send=async payload=>{const response=await handler(new Request('http://localhost/api',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...payload,id})}));const body=await response.json();assert.equal(body.ok,true,body.error);return body.result;};
 const scan=await send({action:'document_elements_scan',limit:4});assert.equal(scan.coverage.complete,true);
 const list=await send({action:'document_elements_list',kind:'figure',subtype:'flowchart'});assert.equal(list.total,1);const figure=list.elements[0];
 const preview=await send({action:'document_element_preview',element_id:figure.id});assert.equal(preview.mime_type,'image/png');assert.equal(Buffer.from(preview.image,'base64').subarray(1,4).toString(),'PNG');
 const marked=await send({action:'document_element_annotate',element_id:figure.id});assert.ok(marked.annotation.id);assert.equal((await send({action:'document_element_annotate',element_id:figure.id})).reused,true);
 const algorithm=(await send({action:'document_elements_list',kind:'algorithm'})).elements[0];const flow=await send({action:'document_element_flow',element_id:algorithm.id});assert.ok(flow.flow.nodes.length>=5);assert.ok(flow.flow.edges.some(e=>e.kind==='back'));
 const formulas=await send({action:'document_elements_list',kind:'formula'});assert.ok(formulas.elements.some(e=>e.context.includes('denotes')));
 const refs=await send({action:'graph_references_extract'});assert.equal(refs.graph_count,2);const graph=await send({action:'graph',view:'citations',limit:100});assert.equal(graph.edges.filter(e=>e.relation==='cites').length,2);
 assert.equal((await send({action:'graph_references_get'})).stale,false);assert.deepEqual(await readFile(path),original);
 assert.ok(scan.usage.index_bytes>0);const beforeClear=await send({action:'annotations'});const cleared=await send({action:'document_elements_clear'});assert.equal(cleared.usage.index_bytes,0);assert.equal((await send({action:'document_elements_list'})).total,0);assert.deepEqual(await send({action:'annotations'}),beforeClear);assert.deepEqual(await readFile(path),original);
 const missing=await handler(new Request('http://localhost/document-elements.js'));assert.equal(missing.status,200);assert.match(await missing.text(),/PaperDocumentElements/);
});

test('HTTP settings control real worker batches and ignore forged request policy',async t=>{
 const root=await mkdtemp(join(tmpdir(),'resource-policy-http-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const python=resolve('.venv/bin/python'),path=join(root,'synthetic.pdf'),options={library:join(root,'library'),localStateHome:join(root,'home'),python};
 execFileSync(python,['-c',`import pymupdf,sys
with pymupdf.open() as d:
 for i in range(6):
  p=d.new_page();p.insert_text((50,60),'y = x + 1 (1)')
 d.save(sys.argv[1])`,path]);
 const id=(await core({action:'import',path},options)).items[0].id,handler=createFetchHandler(options);
 const send=async payload=>{const response=await handler(new Request('http://localhost/api',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...payload,id})}));const body=await response.json();assert.equal(body.ok,true,body.error);return body.result;};
 let settings=await send({action:'settings_get'});
 assert.equal(settings.resource_policy.memory_target_mb,512);
 settings=await send({action:'settings_update',patch:{resource_profile:'eco'},expected_revision:settings.revision});
 const first=await send({action:'document_elements_scan',limit:6,_resource_policy:{batch_pages:6,memory_target_mb:2048}});
 assert.deepEqual(first.scanned_batch,[1]);assert.equal(first.usage.memory_target_mb,256);assert.equal(first.usage.page_limit_bytes,2*1048576);
 await send({action:'settings_update',patch:{resource_profile:'performance'},expected_revision:settings.revision});
 const next=await send({action:'document_elements_scan',limit:6});
 assert.deepEqual(next.scanned_batch,[2,3,4,5]);assert.deepEqual(next.coverage.scanned_pages,[1,2,3,4,5]);assert.equal(next.usage.memory_target_mb,1024);assert.equal(next.usage.page_limit_bytes,8*1048576);
});
