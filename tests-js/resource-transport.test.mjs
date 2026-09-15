import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dispatch } from '../src/bridge.mjs';
import { createFetchHandler } from '../src/http.mjs';
import { resourceToolRequest, RESOURCE_TOOL_SPECS } from '../src/harness/resource-tools.mjs';

test('resource transport preserves dataset revisions, release citations and bounded local preview', async () => {
  const root=await mkdtemp(join(tmpdir(),'library-resources-'));
  const options={library:join(root,'library'),localStateHome:join(root,'home')};
  try {
    const paper=await dispatch({action:'create',metadata:{title:'Synthetic test paper'}},options);
    const item=await dispatch({action:'dataset_put',expected_revision:0,metadata:{title:'Synthetic trips',citekey:'syntheticTrips',author:[{literal:'Synthetic Lab'}],issued:{'date-parts':[[2025]]}}},options);
    assert.equal(item.resource_kind,'dataset');
    const release=await dispatch({action:'dataset_release_put',id:item.id,expected_revision:0,metadata:{version:'2.1',citekey:'syntheticTripsV21',title:'Synthetic trips',author:[{literal:'Synthetic Lab'}],issued:{'date-parts':[[2026]]}}},options);
    const citation=await dispatch({action:'dataset_cite',id:item.id,release_id:release.id,format:'biblatex'},options);
    assert.match(citation.text,/@dataset\{syntheticTripsV21/);
    assert.match(citation.text,/2\.1/);
    const link=await dispatch({action:'dataset_link_put',paper_id:paper.id,dataset_id:item.id,release_id:release.id,relation:'uses',role:'test',review_status:'needs-review',origin:'user',expected_revision:0,evidence:{quote:'Synthetic source',page:null}},options);
    assert.equal((await dispatch({action:'dataset_link_list',dataset_id:item.id},options)).items[0].id,link.id);
    assert.equal((await dispatch({action:'dataset_link_list',paper_id:paper.id},options)).items[0].release_id,release.id);
    const listing=await dispatch({action:'resource_list',kind:'all'},options);
    assert.equal(listing.total,2);
    const exported=await dispatch({action:'export_library',format:'csl-json'},options);
    assert.equal(exported.count,3);
    const csl=JSON.parse(exported.text);
    assert.equal(csl.filter(item=>item.resource_kind==='release').length,1);
    const copyOptions={...options,library:join(root,'copy')};
    const imported=await dispatch({action:'import',items:csl},copyOptions);
    assert.equal(imported.imported,3);
    const datasets=(await dispatch({action:'resource_list',kind:'dataset'},copyOptions)).items;
    assert.equal(datasets.length,1);
    assert.equal((await dispatch({action:'dataset_release_list',id:datasets[0].id},copyOptions)).total,1);
    const bib=await dispatch({action:'export_library',format:'biblatex'},options);
    assert.match(bib.text,/@dataset\{syntheticTripsV21/);
    const bibPath=join(root,'metadata.bib');await writeFile(bibPath,bib.text);
    const bibOptions={...options,library:join(root,'bib-copy')};
    await dispatch({action:'import',path:bibPath},bibOptions);
    assert.equal((await dispatch({action:'resource_list',kind:'dataset'},bibOptions)).total,2);
    const path=join(root,'sample.csv'); await writeFile(path,'id,value\n1,2\n2,3\n');
    const asset=await dispatch({action:'dataset_asset_put',id:item.id,path,expected_revision:0},options);
    const preview=await dispatch({action:'dataset_asset_preview',id:item.id,asset_id:asset.id},options);
    assert.ok(Buffer.byteLength(JSON.stringify(preview))<=512*1024);
    const handle=createFetchHandler(options);
    const response=await handle(new Request('http://localhost/api',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'dataset_put',id:item.id,metadata:{title:'Stale overwrite'},expected_revision:0})}));
    const payload=await response.json();
    assert.equal(response.status,409); assert.equal(payload.code,'STATE_CONFLICT');
    assert.equal(payload.current.id,item.id);
    const disabled=await handle(new Request('http://localhost/api',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'knowledge_generate'})}));
    assert.equal(disabled.status,409);
  } finally { await rm(root,{recursive:true,force:true}); }
});

test('model tools cannot accept knowledge proposals or promote dataset usage to verified', () => {
  const datasets=RESOURCE_TOOL_SPECS.find(s=>s.name==='library_dataset');
  const knowledge=RESOURCE_TOOL_SPECS.find(s=>s.name==='library_knowledge');
  const link=resourceToolRequest(datasets,{operation:'link_put',input_json:JSON.stringify({origin:'user',review_status:'accepted'})});
  assert.equal(link.origin,'ai'); assert.equal(link.review_status,'needs-review');
  const draft=resourceToolRequest(knowledge,{operation:'draft_put',input_json:JSON.stringify({origin:'user',status:'accepted',coding_confidence:'high'})});
  assert.equal(draft.origin,'llm'); assert.equal(draft.status,'needs-review');
  assert.throws(()=>resourceToolRequest(knowledge,{operation:'draft_review',input_json:'{}'}),/Unsupported/);
  assert.throws(()=>resourceToolRequest(knowledge,{operation:'source_put',input_json:'{"library":"/elsewhere"}'}),/owned by the host/);
});
