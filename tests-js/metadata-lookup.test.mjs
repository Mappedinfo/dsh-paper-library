import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { core, dispatch, projectRoot } from '../src/bridge.mjs';

const title = 'Reading metadata evidence';
const resolver = async () => [{address:'93.184.215.14',family:4}];
const response = (text,statusCode=200,headers={}) => ({statusCode,headers,body:Readable.from([Buffer.from(text)]),close(){this.body.destroy();}});
const meta = (name,value) => `<meta name="${name}" content="${value}">`;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

async function fixture(t,metadata={}) {
  const directory = await mkdtemp(join(tmpdir(),'metadata-lookup-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const library = join(directory,'library');
  const item = await dispatch({action:'create',metadata:{title,...metadata}},{library});
  return {directory,library,item};
}

function crossrefFixture(message,html='') {
  const requests=[];
  return {requests,resolver,transport:async({url})=>{
    requests.push(url.href);
    return url.hostname === 'api.crossref.org'
      ? response(JSON.stringify({message:{DOI:'10.1234/metadata',title:[title],...message}}))
      : response(html);
  }};
}

test('metadata_lookup returns a review draft, preserves manual fields and JCR, and never changes a managed PDF or catalog item',async t=>{
  const ranking={system:'JCR',year:2025,category:'Example category',quartile:'Q2',source:'Licensed user export'};
  const f=await fixture(t,{DOI:'10.1234/metadata',title:'Manually corrected title',abstract:'Manual abstract',citekey:'keep-key',URL:'https://manual.example/article',
    author:[{given:'Alice',family:'Reader'},{given:'Bob',family:'Writer',affiliation:[{name:'Manual Institute'}]}],
    publication_dates:{published:'2026',accepted:'2025-11-01'},journal_rankings:[ranking],tags:['manual-tag']});
  const generated=spawnSync(join(projectRoot,'.venv/bin/python'),['scripts/create-demo.py','--output',join(f.directory,'source')],{cwd:projectRoot,encoding:'utf8'});
  assert.equal(generated.status,0,generated.stderr);
  await dispatch({action:'attach',id:f.item.id,path:join(f.directory,'source','example-1.pdf')},{library:f.library});
  const current=await core({action:'get',id:f.item.id},{library:f.library});
  const exported=await core({action:'export_pdf',id:f.item.id},{library:f.library});
  const pdfBefore=hash(await readFile(exported.path));
  const filesBefore=await readdir(f.library,{recursive:true});
  const fetchOptions=crossrefFixture({author:[
    {given:'Bob',family:'Writer',affiliation:[{name:'Remote Bob Institute'}]},
    {given:'Alice',family:'Reader',affiliation:[{name:'Alice Institute'}]},
  ],abstract:'Remote abstract',publisher:'Example Publisher',
  published:{'date-parts':[[2026,9,1]]},'published-online':{'date-parts':[[2026,8,1]]},accepted:{'date-parts':[[2025,12,1]]}},
  meta('citation_doi','10.1234/metadata')+meta('citation_date_received','2025-03-02')+meta('citation_pdf_url','/never.pdf'));
  const result=await dispatch({action:'metadata_lookup',id:f.item.id,metadata:{title:'Untrusted override'},url:'https://untrusted.example',library:'/ignored'},{library:f.library,fetchOptions});
  assert.equal(result.item.title,current.title);
  assert.equal(result.item.abstract,'Manual abstract');
  assert.equal(result.item.id,current.id);
  assert.equal(result.item.citekey,'keep-key');
  assert.equal(result.item.URL,'https://manual.example/article');
  assert.deepEqual(result.item.tags,['manual-tag']);
  assert.deepEqual(result.item.journal_rankings,[ranking]);
  assert.deepEqual(result.item.author,[{given:'Alice',family:'Reader',affiliation:[{name:'Alice Institute'}]},{given:'Bob',family:'Writer',affiliation:[{name:'Manual Institute'}]}]);
  assert.deepEqual(result.item.publication_dates,{published:'2026',accepted:'2025-11-01',online:'2026-08-01',received:'2025-03-02'});
  assert.equal(result.item.publisher,'Example Publisher');
  assert.equal(result.provenance.kind,'metadata-refresh');
  assert.deepEqual(await core({action:'get',id:f.item.id},{library:f.library}),current);
  assert.equal(hash(await readFile(exported.path)),pdfBefore);
  assert.deepEqual(await readdir(f.library,{recursive:true}),filesBefore);
  assert.ok(fetchOptions.requests.every(url=>!url.includes('/never.pdf')));
});

test('a record without DOI requires normalized exact title before proposing missing fields',async t=>{
  const f=await fixture(t,{title:'Reading: Metadata Evidence!',URL:'https://publisher.example/article'});
  const fetchOptions={resolver,transport:async()=>response(meta('citation_title','READING metadata evidence')+meta('citation_author','Alice Reader')+meta('citation_date_received','2025-01'))};
  const result=await dispatch({action:'metadata_lookup',id:f.item.id},{library:f.library,fetchOptions});
  assert.equal(result.item.title,'Reading: Metadata Evidence!');
  assert.deepEqual(result.item.author,[{literal:'Alice Reader'}]);
  assert.deepEqual(result.item.publication_dates,{received:'2025-01'});
  assert.equal((await core({action:'get',id:f.item.id},{library:f.library})).author,undefined);
  await assert.rejects(dispatch({action:'metadata_lookup',id:f.item.id},{library:f.library,fetchOptions:{resolver,transport:async()=>response(meta('citation_title','A different paper'))}}),/题名.*不能准确匹配/);
});

test('lookup refuses missing identifiers, unavailable metadata and mismatched DOI without catalog mutation',async t=>{
  const f=await fixture(t);
  await assert.rejects(dispatch({action:'metadata_lookup',id:f.item.id},{library:f.library}),/填写并保存 DOI/);
  await assert.rejects(dispatch({action:'metadata_lookup'},{library:f.library}),/请选择一篇文献/);
  const current=await dispatch({action:'update',id:f.item.id,metadata:{DOI:'10.1234/metadata'}},{library:f.library});
  await assert.rejects(dispatch({action:'metadata_lookup',id:f.item.id},{library:f.library,fetchOptions:crossrefFixture({DOI:'10.1234/different'},meta('citation_doi','10.1234/different'))}),/未取得可用文献资料.*核对 DOI/);
  await assert.rejects(dispatch({action:'metadata_lookup',id:f.item.id},{library:f.library,fetchOptions:{resolver,transport:async()=>response('',503)}}),/未取得可用文献资料.*手工编辑/);
  assert.deepEqual(await core({action:'get',id:f.item.id},{library:f.library}),current);
});

test('author enrichment requires unique exact names and preserves all existing author fields and order',async t=>{
  const authors=[{given:'Alice',family:'Reader',suffix:'Jr.'},{literal:'Repeated Name'},{literal:'Repeated Name'},{literal:'Single Match',ORCID:'manual-orcid'},{literal:'Different Person'}];
  const f=await fixture(t,{DOI:'10.1234/metadata',author:authors});
  const remote=[{given:'Alice',family:'Reader',affiliation:[{name:'Not Junior'}]},{name:'Repeated Name',affiliation:[{name:'Ambiguous Institute'}]},{name:'Single Match',affiliation:[{name:'Matching Institute'}]},{name:'Unrelated Person',affiliation:[{name:'Wrong Institute'}]}];
  const result=await dispatch({action:'metadata_lookup',id:f.item.id},{library:f.library,fetchOptions:crossrefFixture({author:remote})});
  assert.deepEqual(result.item.author,[authors[0],authors[1],authors[2],{...authors[3],affiliation:[{name:'Matching Institute'}]},authors[4]]);
  assert.deepEqual((await core({action:'get',id:f.item.id},{library:f.library})).author,authors);
});

test('lookup respects manual edits made while the metadata request is in flight and refuses an identity change',async t=>{
  const f=await fixture(t,{DOI:'10.1234/metadata'});
  const options={library:f.library,fetchOptions:{resolver,transport:async({url})=>{
    if(url.hostname==='api.crossref.org') {
      await dispatch({action:'update',id:f.item.id,metadata:{abstract:'Concurrent manual edit'}},{library:f.library});
      return response(JSON.stringify({message:{DOI:'10.1234/metadata',title:[title],abstract:'Remote abstract',publisher:'Example publisher'}}));
    }
    return response('');
  }}};
  const result=await dispatch({action:'metadata_lookup',id:f.item.id},options);
  assert.equal(result.item.abstract,'Concurrent manual edit');
  assert.equal(result.item.publisher,'Example publisher');
  options.fetchOptions.transport=async({url})=>{
    if(url.hostname==='api.crossref.org') {
      await dispatch({action:'update',id:f.item.id,metadata:{DOI:'10.1234/changed'}},{library:f.library});
      return response(JSON.stringify({message:{DOI:'10.1234/metadata',title:[title]}}));
    }
    return response('');
  };
  await assert.rejects(dispatch({action:'metadata_lookup',id:f.item.id},options),/DOI.*发生变化/);
});

test('bridge exposes manual create, archive and restore while protecting archived records from lookup',async t=>{
  const f=await fixture(t,{DOI:'10.1234/metadata'});
  assert.equal(f.item.pdf,false);
  const archived=await dispatch({action:'archive',id:f.item.id},{library:f.library});
  assert.equal(archived.archived,true);
  let calls=0;
  await assert.rejects(dispatch({action:'metadata_lookup',id:f.item.id},{library:f.library,fetchOptions:{resolver,transport:async()=>{calls++;return response('');}}}),/archived/);
  assert.equal(calls,0);
  const restored=await dispatch({action:'restore',id:f.item.id},{library:f.library});
  assert.equal(restored.archived,false);
  assert.equal(restored.id,f.item.id);
});

test('bridge graph mutation allowlist reaches bounded core operations and preserves graph ownership',async t=>{
  const f=await fixture(t);
  const node=await dispatch({action:'graph_node_put',id:f.item.id,type:'concept',label:'Example concept'},{library:f.library});
  const edge=await dispatch({action:'graph_edge_put',id:f.item.id,source:f.item.id,target:node.id,relation:'explains',evidence:{note:'Reader assertion'}},{library:f.library});
  assert.ok(node.id.startsWith('node:'));
  assert.ok(edge.id.startsWith('edge:'));
  const removedEdge=await dispatch({action:'graph_edge_delete',id:f.item.id,edge_id:edge.id},{library:f.library});
  assert.equal(removedEdge.deleted,true);
  const removedNode=await dispatch({action:'graph_node_delete',id:f.item.id,node_id:node.id},{library:f.library});
  assert.equal(removedNode.deleted,true);
  await assert.rejects(dispatch({action:'graph_node_put',id:f.item.id,type:'unknown',label:'Invalid'},{library:f.library}),/Unsupported graph node type/);
  await assert.rejects(dispatch({action:'untrusted_action',id:f.item.id},{library:f.library}),/未知文献操作/);
});
