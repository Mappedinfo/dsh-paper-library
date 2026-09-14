import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { bibliographicMetadata, importPDF, metadataMatchesPDF } from '../src/import-pdf.mjs';

function inspection(title, doi='10.1234/paper') {
  return {metadata:{title},doi_candidates:[doi],parse:{portable_metadata:false,field_sources:{title:'pdf-info'},text_excerpt:`${title}\nReferences\nAn unrelated cited title`}};
}
function harness(inspected, metadata, statusCode=200) {
  const requests=[];
  return {
    requests,
    core: async request => {
      requests.push(request);
      if (request.action === 'inspect_pdf') return inspected;
      assert.equal(request.action,'import');
      return {items:[{...request.metadata,pdf:true}],warnings:[]};
    },
    options:{fetchOptions:{resolver:async()=>[{address:'93.184.215.14',family:4}],transport:async()=>({statusCode,headers:{},body:Readable.from([Buffer.from(JSON.stringify({message:metadata}))]),close(){}})}},
  };
}

test('identity requires the actual parsed title, not a cited title, filename or partial word overlap',()=>{
  const paper=inspection('Study of urban mobility');
  assert.equal(metadataMatchesPDF({title:'An unrelated cited title'},paper),false);
  assert.equal(metadataMatchesPDF({title:'STUDY OF URBAN MOBILITY'},paper),true);
  assert.equal(metadataMatchesPDF({title:'Study of urban mobility'}, {...paper,parse:{...paper.parse,field_sources:{title:'filename-fallback'}}}),false);
  assert.equal(metadataMatchesPDF({title:'A comprehensive study of urban mobility patterns'},inspection('A comprehensive study of urban mobility patterns failed')),false);
});

test('matching local DOI enrichment preserves Crossref receipt and separates parser from identity validation',async()=>{
  const fixture=harness(inspection('Study of urban mobility'),{DOI:'10.1234/paper',title:['Study of urban mobility'],type:'journal-article',author:[{family:'Reader',given:'A.'}],published:{'date-parts':[[2026]]}});
  const result=await importPDF('/tmp/source.pdf',fixture.options,fixture.core);
  const saved=fixture.requests.find(request=>request.action==='import');
  assert.equal(saved.metadata_verified,true);
  assert.equal(saved.metadata_source,'crossref');
  assert.equal(saved.metadata.DOI,'10.1234/paper');
  assert.equal(saved.metadata.acquisition.validation,'pdf_parser');
  assert.deepEqual(saved.metadata.acquisition.metadata_identity,{status:'title_match',method:'parsed_title'});
  assert.equal(saved.metadata.acquisition.enrichment.target,'10.1234/paper');
  assert.deepEqual(saved.metadata.acquisition.enrichment.requests.map(value=>({url:value.url,status:value.status})),[{url:'https://api.crossref.org/works/10.1234%2Fpaper',status:200}]);
  assert.equal(saved.metadata.acquisition.enrichment.status,'resolved');
  assert.equal(result.items[0].acquisition.enrichment.requests.length,1);
});

test('cited DOI with a nonmatching title retains only provenance and reports review need',async()=>{
  const fixture=harness(inspection('Study of urban mobility'),{DOI:'10.1234/paper',title:['An unrelated cited title']});
  const result=await importPDF('/tmp/source.pdf',fixture.options,fixture.core);
  const saved=fixture.requests.find(request=>request.action==='import');
  assert.equal(saved.metadata_verified,false);
  assert.deepEqual(Object.keys(saved.metadata),['acquisition']);
  assert.equal(saved.metadata.acquisition.metadata_identity.status,'unmatched');
  assert.equal(saved.metadata.acquisition.enrichment.status,'resolved');
  assert.match(result.warnings.join(' '),/未确认在线题名/);
});

test('failed enrichment preserves source warning and request status without verifying metadata',async()=>{
  const fixture=harness(inspection('Study of urban mobility'),{},503);
  const result=await importPDF('/tmp/source.pdf',fixture.options,fixture.core);
  const saved=fixture.requests.find(request=>request.action==='import');
  assert.equal(saved.metadata_verified,false);
  assert.equal(saved.metadata.acquisition.enrichment.status,'unavailable');
  assert.equal(saved.metadata.acquisition.enrichment.requests[0].status,503);
  assert.match(saved.metadata.acquisition.enrichment.warnings.join(' '),/HTTP 503/);
  assert.match(result.warnings.join(' '),/HTTP 503/);
});

test('remote PDF parsing is recorded separately when landing identity does not match',async()=>{
  const fixture=harness(inspection('Study of urban mobility'),{});
  const provenance={target:'https://papers.example/article',source_url:'https://papers.example/paper.pdf',requests:[{url:'https://papers.example/paper.pdf',status:200}],validation:'pdf_signature_only'};
  const result=await importPDF('/tmp/source.pdf',fixture.options,fixture.core,{status:'downloaded',metadata:{title:'An unrelated cited title'},provenance});
  const saved=fixture.requests.find(request=>request.action==='import');
  assert.equal(saved.metadata_verified,false);
  assert.equal(saved.metadata.acquisition.validation,'pdf_parser');
  assert.equal(saved.metadata.acquisition.metadata_identity.status,'unmatched');
  assert.equal(result.acquisition.provenance.metadata_identity.status,'unmatched');
  assert.equal(provenance.validation,'pdf_signature_only');
});

test('bibliographic whitelist retains arXiv version fields and excludes source-controlled state',()=>{
  assert.deepEqual(bibliographicMetadata({archive:'arXiv',archive_location:'2401.01234v2',title:'Versioned paper',metadata_verified:true,acquisition:{validation:'trusted'},attachments:[{path:'/secret.pdf'}]}),{title:'Versioned paper',archive:'arXiv',archive_location:'2401.01234v2'});
});
