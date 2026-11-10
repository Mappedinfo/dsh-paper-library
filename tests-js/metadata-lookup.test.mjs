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

test('automatic DOI only commits the matching publication type and corroborated title',async t=>{
  const author=[{given:'Alice',family:'Reader'}], issued={'date-parts':[[2026]]};
  const f=await fixture(t,{type:'paper-conference','container-title':'Synthetic Proceedings',author,issued});
  const requests=[];
  const fetchOptions={resolver,transport:async({url})=>{
    requests.push(url.href);
    return response(JSON.stringify({message:{items:[
      {type:'posted-content',subtype:'preprint',title:[title],DOI:'10.1234/preprint',author,issued},
      {type:'proceedings-article',title:[title],DOI:'10.1234/conference',author,issued},
    ]}}));
  }};
  const result=await dispatch({action:'catalog_doi_lookup',id:f.item.id},{library:f.library,fetchOptions});
  assert.equal(result.DOI,'10.1234/conference');
  const saved=await core({action:'get',id:f.item.id},{library:f.library});
  assert.equal(saved.DOI,result.DOI);
  assert.equal(saved['container-title'],'Synthetic Proceedings');
  assert.equal(requests.length,1);
  const privateItem=await core({action:'create',metadata:{title:'Synthetic unpublished data',type:'article-journal'}},{library:f.library});
  assert.equal((await dispatch({action:'catalog_doi_lookup',id:privateItem.id},{library:f.library,fetchOptions})).status,'needs-source');
  assert.equal(requests.length,1);
});

test('preprint by identifier uses its registered DataCite DOI, and dataset version candidates are excluded',async t=>{
  const f=await fixture(t,{type:'article',archive:'arXiv',archive_location:'2601.01234'});
  const data=(doi,name,type,other={})=>({attributes:{doi,titles:[{title:name}],types:{resourceTypeGeneral:type},publicationYear:2026,publisher:'Synthetic Archive',...other}});
  const dataset=await core({action:'dataset_put',expected_revision:0,metadata:{title:'Synthetic public dataset',publisher:'Synthetic Archive',URL:'https://repository.example.org/dataset',issued:{'date-parts':[[2026]]}}},{library:f.library});
  const fetchOptions={resolver,transport:async({url})=>{
    if(url.pathname==='/works')return response(JSON.stringify({message:{items:[]}}));
    if(url.pathname==='/dois')return response(JSON.stringify({data:[
      data('10.1234/version','Synthetic public dataset','Dataset',{version:'1.0'}),
      data('10.1234/family','Synthetic public dataset','Dataset'),
    ]}));
    assert.match(url.href,/api\.datacite\.org\/dois\//);
    return response(JSON.stringify({data:data('10.48550/arXiv.2601.01234',title,'Preprint')}));
  }};
  assert.equal((await dispatch({action:'catalog_doi_lookup',id:f.item.id},{library:f.library,fetchOptions})).DOI,'10.48550/arxiv.2601.01234');
  assert.equal((await dispatch({action:'catalog_doi_lookup',id:dataset.id,kind:'dataset'},{library:f.library,fetchOptions})).DOI,'10.1234/family');
});

test('a typed DOI is saved only after the registered title and complete author list match',async t=>{
  const author=[{given:'Alice',family:'Reader'},{literal:'Kai Chen'}];
  const f=await fixture(t,{author,type:'article',abstract:'Keep manual abstract'});
  const request={action:'catalog_doi_lookup',id:f.item.id,doi:'https://doi.org/10.1234/METADATA'};
  const remote=[{given:'Kai',family:'Chen'},{given:'Alice',family:'Reader'}];
  const opts=fetchOptions=>({library:f.library,fetchOptions});
  for(const [message,titleMatches,authorsMatch] of [
    [{title:['Unrelated title'],author:remote},false,true],
    [{author:[remote[1],{given:'Other',family:'Person'}]},true,false],
    [{author:[remote[1]]},true,false],
  ]){
    const result=await dispatch(request,opts(crossrefFixture(message)));
    assert.equal(result.status,'mismatch');
    assert.equal(result.titleMatches,titleMatches);
    assert.equal(result.authorsMatch,authorsMatch);
  }
  await assert.rejects(dispatch(request,opts(crossrefFixture({author:[]}))),/公开题录缺少标题或作者/);
  await assert.rejects(dispatch(request,opts(crossrefFixture({DOI:undefined,author:remote}))),/未查到此 DOI/);
  const fetchOptions=crossrefFixture({title:['READING—metadata evidence'],author:remote,abstract:'Unrequested remote abstract'});
  await assert.rejects(dispatch({...request,doi:'https://example.org/article'},opts(fetchOptions)),/请输入有效的 DOI/);
  assert.equal(fetchOptions.requests.length,0);
  assert.ok(!(await core({action:'get',id:f.item.id},opts(fetchOptions))).DOI);
  assert.deepEqual(await dispatch(request,opts(fetchOptions)),{status:'saved',DOI:'10.1234/metadata'});
  const saved=await core({action:'get',id:f.item.id},opts(fetchOptions));
  assert.deepEqual(saved.author,author);assert.equal(saved.title,title);assert.equal(saved.abstract,'Keep manual abstract');
  assert.match(fetchOptions.requests[0],/api\.crossref\.org\/works\/10\.1234%2Fmetadata$/i);
  assert.ok(fetchOptions.requests.every(url=>!url.includes('query')));
});

test('a typed DOI verified against an old catalog revision cannot overwrite a concurrent edit',async t=>{
  const author=[{given:'Alice',family:'Reader'}],f=await fixture(t,{author});
  const fetchOptions={resolver,transport:async({url})=>{
    if(url.hostname!=='api.crossref.org')return response('');
    await core({action:'update',id:f.item.id,metadata:{title:'Concurrent title edit'}},{library:f.library});
    return response(JSON.stringify({message:{DOI:'10.1234/metadata',title:[title],author}}));
  }};
  await assert.rejects(dispatch({action:'catalog_doi_lookup',id:f.item.id,doi:'10.1234/metadata'},{library:f.library,fetchOptions}),/modified|changed|conflict/i);
  const latest=await core({action:'get',id:f.item.id},{library:f.library});
  assert.equal(latest.title,'Concurrent title edit');assert.ok(!latest.DOI);
});

test('manual DOI verification falls back to DataCite and matches split Han names',async t=>{
  const f=await fixture(t,{title:'合成 数据集',author:[{literal:'张三'}],type:'article'});
  const doi='10.1234/han-record';
  const fetchOptions={resolver,transport:async({url})=>{
    if(url.hostname==='api.crossref.org')return response('{}',404);
    assert.equal(url.hostname,'api.datacite.org');
    return response(JSON.stringify({data:{attributes:{doi,titles:[{title:'合成数据集'}],types:{resourceTypeGeneral:'Preprint'},creators:[{familyName:'张',givenName:'三'}]}}}));
  }};
  assert.deepEqual(await dispatch({action:'catalog_doi_lookup',id:f.item.id,doi:`doi:${doi}`},{library:f.library,fetchOptions}),{status:'saved',DOI:doi});
});

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
  await assert.rejects(dispatch({action:'metadata_lookup',id:f.item.id},{library:f.library,fetchOptions:{resolver,transport:async()=>response('{}')}}),/未取得可用文献资料/);
  await assert.rejects(dispatch({action:'metadata_lookup'},{library:f.library}),/请选择一篇文献/);
  const current=await dispatch({action:'update',id:f.item.id,metadata:{DOI:'10.1234/metadata'}},{library:f.library});
  await assert.rejects(dispatch({action:'metadata_lookup',id:f.item.id},{library:f.library,fetchOptions:crossrefFixture({DOI:'10.1234/different'},meta('citation_doi','10.1234/different'))}),/未取得可用文献资料.*核对题名、DOI/);
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

test('APA copy fills verified proceedings data and person names before rendering, without saving the draft', async t => {
  const f = await fixture(t, { type:'article', 'container-title':'Synthetic Proceedings', author:[{ literal:'Alice Reader' }] });
  const requests = [];
  const options = { library:f.library, fetchOptions:{ resolver, transport:async({url})=>{
    requests.push(url);
    return response(JSON.stringify({ message:{ items:[{
      DOI:'10.1234/metadata', type:'proceedings-article', title:[title], author:[{given:'Alice',family:'Reader'}],
      'container-title':['Synthetic Proceedings'], page:'22-29', publisher:'Demo Publisher', published:{'date-parts':[[2026]]},
    }] } }));
  } } };
  const result = await dispatch({ action:'cite', ids:[f.item.id], format:'apa', prepare_metadata:true }, options);
  assert.equal(result.prepared,true);
  assert.match(result.text,/Reader, A\. \(2026\)/);
  assert.match(result.text,/Synthetic Proceedings.*22–29/);
  assert.match(result.text,/https:\/\/doi.org\/10\.1234\/metadata/);
  assert.equal(requests.length,1);
  const current = await core({action:'get',id:f.item.id},{library:f.library});
  assert.equal(current.type,'article');assert.equal(current.DOI,undefined);assert.equal(current.page,undefined);
});

test('APA copy uses verified article numbers and withholds unresolved records', async t => {
  const f = await fixture(t, { type:'article-journal', DOI:'10.1234/metadata' });
  const request = { action:'cite', ids:[f.item.id], format:'apa', prepare_metadata:true };
  const fetchOptions = crossrefFixture({ type:'journal-article', author:[{given:'Alice',family:'Reader'}],
    'container-title':['Synthetic Journal'], volume:'2', issue:'1', 'article-number':'e42', published:{'date-parts':[[2026]]} });
  const ready = await dispatch(request, { library:f.library, fetchOptions });
  assert.match(ready.text,/Article e42/);
  const blocked = await dispatch(request, { library:f.library, fetchOptions:{ resolver, transport:async()=>response('',503) } });
  assert.equal(blocked.prepared,true);assert.ok(blocked.missing_fields.includes('页码或文章编号'));assert.equal(blocked.text,undefined);
});

test('APA copy does not send title-only private records to an online provider', async t => {
  const f = await fixture(t), requests = [];
  const result = await dispatch({ action:'cite', ids:[f.item.id], format:'apa', prepare_metadata:true }, {
    library:f.library, fetchOptions:{ resolver, transport:async({url})=>{requests.push(url);return response('');} },
  });
  assert.equal(result.text,undefined);assert.ok(result.missing_fields.includes('作者'));assert.equal(requests.length,0);
});

test('a saved PDF URL falls back to title lookup for both metadata and APA without downloading the PDF', async t => {
  const pdfURL = 'https://publisher.example/papers/example.pdf?download=1';
  const f = await fixture(t, { type:'paper-conference', URL:pdfURL, 'container-title':'Synthetic Proceedings' });
  const requests = [];
  const options = { library:f.library, fetchOptions:{ resolver, transport:async ({ url }) => {
    requests.push(url);
    return response(JSON.stringify({ message:{ items:[{
      DOI:'10.1234/preprint', type:'posted-content', title:[title],
    }, {
      DOI:'10.1234/proceedings', type:'proceedings-article', title:[title], 'container-title':['Synthetic Proceedings'],
      author:[{given:'Alice',family:'Reader'}], published:{'date-parts':[[2026]]}, page:'22-29',
    }] } }));
  } } };
  const draft = await dispatch({action:'metadata_lookup',id:f.item.id},options);
  assert.equal(draft.item.DOI,'10.1234/proceedings');assert.equal(draft.item.URL,pdfURL);
  const citation = await dispatch({action:'cite',ids:[f.item.id],format:'apa',prepare_metadata:true},options);
  assert.match(citation.text,/https:\/\/doi\.org\/10\.1234\/proceedings/);assert.doesNotMatch(citation.text,/\.pdf/);
  assert.equal(requests.length,2);assert.ok(requests.every(url=>url.hostname==='api.crossref.org'&&url.searchParams.get('query.title')===title));
  assert.equal((await core({action:'get',id:f.item.id},{library:f.library})).DOI,undefined);
});

test('DataCite can recover a publication DOI after Crossref misses, without substituting a preprint', async t => {
  const f = await fixture(t, { type:'article-journal', URL:'https://publisher.example/download.pdf', 'container-title':'Synthetic Journal',
    author:[{given:'Alice',family:'Reader'}], issued:{'date-parts':[[2026]]}, page:'9-17' });
  const datacite = (doi, type, extra={}) => ({ attributes:{ doi, titles:[{title}], types:{resourceTypeGeneral:type}, publicationYear:2026, ...extra } });
  const preprint = datacite('10.48550/arxiv.1234.56789','Preprint');
  const article = datacite('10.1234/datacite','JournalArticle', { relatedItems:[{relationType:'IsPublishedIn',titles:[{title:'Synthetic Journal'}], firstPage:'9', lastPage:'17', volume:'3', issue:'2'}] });
  const requests=[];
  const options = records => ({ library:f.library, fetchOptions:{resolver,transport:async({url})=>{
    requests.push(url.hostname);
    return response(JSON.stringify(url.hostname==='api.crossref.org'?{message:{items:[]}}:{data:records}));
  }} });
  const request={action:'cite',ids:[f.item.id],format:'apa',prepare_metadata:true};
  const ready=await dispatch(request,options([preprint,article]));
  assert.match(ready.text,/Synthetic Journal, 3\(2\), 9–17/);
  assert.match(ready.text,/https:\/\/doi\.org\/10\.1234\/datacite/);
  const blocked=await dispatch(request,options([preprint]));
  assert.equal(blocked.text,undefined);assert.deepEqual(blocked.missing_fields,['DOI 或已核对的出版页面']);
  assert.deepEqual(requests,['api.crossref.org','api.datacite.org','api.crossref.org','api.datacite.org']);
});

test('an opaque download URL identified as PDF is not copied as the citation URL', async t => {
  const f=await fixture(t,{type:'article-journal',URL:'https://publisher.example/download?id=1','container-title':'Synthetic Journal',
    author:[{family:'Reader'}],issued:{'date-parts':[[2026]]},volume:'1',issue:'2',page:'3-4'});
  const requests=[];
  const result=await dispatch({action:'cite',ids:[f.item.id],format:'apa',prepare_metadata:true},{library:f.library,fetchOptions:{resolver,transport:async({url})=>{
    requests.push(url.hostname);
    if(url.hostname==='publisher.example')return response('',200,{'content-type':'application/pdf'});
    return response('{}');
  }}});
  assert.equal(result.text,undefined);
  assert.deepEqual(result.missing_fields,['DOI 或已核对的出版页面']);
  assert.deepEqual(requests,['publisher.example','api.crossref.org','api.datacite.org']);
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

test('missing identifiers use exact title matches from free Crossref without writing catalog',async t=>{
 const f=await fixture(t,{author:[{family:'Reader'}]});let requests=0;
 const fetchOptions={resolver,transport:async ({url})=>{requests++;assert.match(String(url),/api\.crossref\.org\/works\?query.title=/);return response(JSON.stringify({message:{items:[{DOI:'10.1234/title',title:[title],author:[{family:'Reader',given:'Alice'}],published:{'date-parts':[[2024]]}}]}}));}};
 const result=await dispatch({action:'metadata_lookup',id:f.item.id},{library:f.library,fetchOptions});
 assert.equal(result.item.DOI,'10.1234/title');assert.equal(result.item.author[0].given,'Alice');assert.equal(requests,1);
 assert.equal((await core({action:'get',id:f.item.id},{library:f.library})).DOI,undefined);
});

test('ambiguous title candidates never select an arbitrary DOI',async t=>{
 const f=await fixture(t);
 const fetchOptions={resolver,transport:async()=>response(JSON.stringify({message:{items:[{DOI:'10.1234/a',title:[title]},{DOI:'10.1234/b',title:[title]}]}}))};
 await assert.rejects(dispatch({action:'metadata_lookup',id:f.item.id},{library:f.library,fetchOptions}),/多个 DOI/);
});

test('single-paper identifier probing reads synthetic PDF locally and preserves original bytes',async t=>{
 const f=await fixture(t);const path=join(f.directory,'synthetic-id.pdf');
 const generated=spawnSync(join(projectRoot,'.venv/bin/python'),['-c','import pymupdf,sys; d=pymupdf.open(); p=d.new_page(); p.insert_text((50,60),"Synthetic identifier probe\\narXiv:2006.11239\\n10.1234/synthetic-probe"); d.save(sys.argv[1]); d.close()',path],{encoding:'utf8'});assert.equal(generated.status,0,generated.stderr);
 const before=hash(await readFile(path));await dispatch({action:'attach',id:f.item.id,path},{library:f.library});
 const result=await core({action:'metadata_probe',id:f.item.id},{library:f.library});
 assert.equal(result.arxiv,'2006.11239');assert.equal(result.doi,'10.1234/synthetic-probe');assert.equal(hash(await readFile(path)),before);assert.equal(result.text,undefined);
});
