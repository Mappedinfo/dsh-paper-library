import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {linkRadarRelations} from '../src/harness/field-radar-linkage.mjs';
import {createFieldRadarStore} from '../src/harness/field-radar.mjs';
import {renderFieldRadarTable} from '../src/harness/field-radar-table.mjs';
import {createFieldRadarExporter} from '../src/harness/field-radar-export.mjs';
import {FIELD_RADAR_TOOL_SPECS,fieldRadarToolRequest} from '../src/harness/field-radar-tools.mjs';
import {relationsFixture} from './fixtures/relations-synthetic.mjs';
const paper=(id,title,doi)=>({id,title,doi,source_ids:['s']});
const topic=()=>({document:{schema_version:1,topic:{id:'topic',title:'Synthetic',question:'Synthetic?'},papers:[paper('p1','One','10.1234/one'),paper('p2','Two')],sources:[{id:'s',title:'Synthetic source',url:'https://example.org'}],scholars:[],claims:[]},revision:'r1'});
test('identity bridge uses DOI or unique exact normalized title, never independently scoped IDs',()=>{
 const t=topic();t.document.papers.push(paper('p3','Duplicate'),paper('p4','Duplicate'),paper('p5','Conflict','10.1234/right'));
 const r={records:[paper('r1','Changed title','https://doi.org/10.1234/ONE'),paper('r2','TWO!'),paper('p1','Unrelated'),paper('r4','Duplicate'),paper('r5','Conflict','10.1234/wrong')]};
 const before=JSON.stringify({r,t});const result=linkRadarRelations(r,t);
 assert.deepEqual(result.matches.map(m=>m.status),['matched','matched','unmatched','ambiguous','conflicting']);assert.deepEqual(result.matches.slice(0,2).map(m=>m.paper_id),['p1','p2']);assert.equal(result.coverage.matched_papers,2);assert.equal(JSON.stringify({r,t}),before);
});
test('duplicate DOI and duplicate titles stay ambiguous, even when an ID happens to match',()=>{const t=topic();t.document.papers.push(paper('other','Other','10.1234/one'));const result=linkRadarRelations({records:[paper('p1','One','10.1234/one')]},t);assert.equal(result.matches[0].status,'ambiguous');assert.equal(result.matches[0].paper_id,undefined);assert.equal(result.coverage.matched_papers,0);assert.equal(linkRadarRelations(null,t).coverage.relation_records,0);});
test('relations API optionally returns a version-checked linkage without changing either snapshot',async()=>{
 const values=new Map();let rev=0;const store={async get(k){return structuredClone(values.get(k)||{value:null,revision:0});},async put(k,value,expected){assert.equal((values.get(k)||{revision:0}).revision,expected);const result={value,revision:String(++rev)};values.set(k,structuredClone(result));return result;},async list(){return {records:[],total:0};}};
 const service=createFieldRadarStore({store}),t=topic(),r=relationsFixture();t.document.papers[0].title=r.records[0].title;
 const saved=await service.handle({action:'field_radar_import',document:t.document,expected_revision:0});await service.handle({action:'field_radar_relations_import',document:r,expected_revision:0});const before=JSON.stringify([...values]);
 const raw=await service.handle({action:'field_radar_relations_get'}),linked=await service.handle({action:'field_radar_relations_get',id:'topic',expected_revision:saved.revision});assert.equal(raw.linkage,undefined);assert.deepEqual(raw.document,linked.document);assert.equal(linked.linkage.topic_revision,saved.revision);assert.equal(linked.linkage.matches[0].paper_id,'p1');await assert.rejects(service.handle({action:'field_radar_relations_get',id:'topic',expected_revision:'stale'}),e=>e.status===409);assert.equal(JSON.stringify([...values]),before);
});
test('paper selection intersects table filters before paging, with explicit empty and invalid selections',()=>{const t=topic();for(const options of [{paper_ids:[]},{paper_ids:['p1'],filters:{query:'Two'}}])assert.equal(renderFieldRadarTable(t,{...options,all:true}).count,0);assert.equal(renderFieldRadarTable(t,{paper_ids:['p2'],all:true}).rows[0].paper_id,'p2');for(const paper_ids of [null,'p1',['unknown'],['p1','p1'],Array(501).fill('p1'),['../p1']])assert.throws(()=>renderFieldRadarTable(t,{paper_ids}));assert.equal(renderFieldRadarTable(t).count,2);});
test('selected IDs survive native routes, content, export receipt and immutable evidence sidecar',async t=>{const library=await mkdtemp(join(tmpdir(),'radar-linkage-'));t.after(()=>rm(library,{force:true,recursive:true}));const exporter=createFieldRadarExporter({library,radar:{get:async()=>topic()}});for(const format of ['html','csv','tsv','markdown']){const spec=FIELD_RADAR_TOOL_SPECS.find(x=>x.action==='field_radar_table_export');const request=fieldRadarToolRequest(spec,{input_json:JSON.stringify({id:'topic',paper_ids:['p2'],format,all:true})});const receipt=await exporter.tableExport(request),side=JSON.parse(await readFile(receipt.path+'.json','utf8'));assert.equal(receipt.count,1);assert.deepEqual(receipt.paper_ids,['p2']);assert.deepEqual(side.export_settings.paper_ids,['p2']);assert.equal(side.rows[0].paper_id,'p2');assert.ok((await exporter.get(receipt.id,format)).bytes.length);}});
