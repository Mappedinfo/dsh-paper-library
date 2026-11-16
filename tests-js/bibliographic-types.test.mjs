import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {dispatch} from '../src/bridge.mjs';
import {apaCopyReadiness, cite, parseBibtex} from '../src/citations.mjs';
import {importPDF} from '../src/import-pdf.mjs';
import {zoteroItemToMetadata} from '../src/translation-server.mjs';

test('manuals export as native BibTeX entries while CSL keeps its report subtype', async () => {
  const [manual] = await parseBibtex('@manual{SyntheticGuide, title={Synthetic Guide}, author={Example, Alice}, organization={Example University}, year={2025}}');
  assert.equal(manual.type, 'report');
  assert.equal(manual.genre, 'Manual');
  assert.deepEqual(apaCopyReadiness(manual), { missing: [], lookup: false });
  assert.match((await cite([manual], 'apa')).text, /Synthetic guide/i);
  const report = {id:'SyntheticReport',type:'report',genre:'Technical report',title:'Synthetic Technical Report'};
  const bib = await cite([manual,report], 'biblatex');
  assert.match(bib.text, /@manual\{SyntheticGuide,/);
  assert.match(bib.text, /organization = \{Example University\}/);
  assert.match(bib.text, /@report\{SyntheticReport,/);
  const [imported] = await parseBibtex(bib.text);
  assert.equal(imported.genre, 'Manual');
  assert.equal(imported.publisher, 'Example University');
  assert.deepEqual(imported.issued, manual.issued);
  const csl = JSON.parse((await cite([manual], 'csl-json')).text)[0];
  assert.equal(csl.type, 'report');
  assert.equal(csl.genre, 'Manual');
  assert.equal(csl.DOI, undefined);
  assert.deepEqual(zoteroItemToMetadata({itemType:'report',reportType:'Manual',institution:'Example University'}),
    {type:'report',genre:'Manual',publisher:'Example University'});
});

test('the DOI marker suppresses registration and title-based lookup', async t => {
  const library = await mkdtemp(join(tmpdir(), 'paper-doi-status-'));
  t.after(() => rm(library, {recursive:true, force:true}));
  const options = {library, fetchOptions:{fetch:()=>{throw Error('unexpected network request');}}};
  const item = await dispatch({action:'create', metadata:{
    type:'article-journal',title:'Synthetic journal title',doi_status:'not-applicable',
  }}, options);
  const result = await dispatch({action:'catalog_doi_lookup',id:item.id,manual:true}, options);
  assert.deepEqual(result, {status:'skipped'});
  await assert.rejects(dispatch({action:'metadata_lookup',id:item.id}, options), /资料详情/);
});

test('reimporting a portable no-DOI manual skips metadata discovery', async () => {
  const metadata={title:'Synthetic Guide',type:'report',genre:'Manual',doi_status:'not-applicable'};
  const calls=[];
  let network=0;
  const result=await importPDF('/synthetic.pdf',{fetchOptions:{fetch:()=>{network++;throw Error('unexpected network request');}}},
    async request=>{
      calls.push(request.action);
      if(request.action==='inspect_pdf')return {metadata,doi_candidates:['10.1234/cited-work'],
        parse:{portable_metadata:true,field_sources:{title:'embedded-csl'}}};
      return {items:[metadata],warnings:[]};
    });
  assert.deepEqual(calls,['inspect_pdf','import']);
  assert.equal(network,0);
  assert.equal(result.items[0].doi_status,'not-applicable');
});
