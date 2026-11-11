/** Synthetic isolated Chromium only. Does not touch the user's browser or library. */
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {relationsFixture} from '../tests-js/fixtures/relations-synthetic.mjs';
import {linkRadarRelations} from '../src/harness/field-radar-linkage.mjs';
import {createFieldRadarExporter} from '../src/harness/field-radar-export.mjs';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const relation=relationsFixture();relation.dimensions.splice(1,0,{id:'method',label:{zh:'方法主类',en:'Method'},categories:[{id:'m',label:'Synthetic method'}]});for(const r of relation.records)r.values.method=['m'];
const document={schema_version:1,topic:{id:'synthetic',title:'Synthetic linked topic',question:'Synthetic only'},sources:relation.sources,papers:[...relation.records.map(r=>({id:r.id,title:r.title,year:2025,method:r.id==='p1'?'alpha':'beta',source_ids:['s1']})),{id:'outside',title:'Synthetic paper outside graph',year:2024,source_ids:['s1']}],scholars:[],claims:[]};
const record={document,revision:'topic-rev'},exporter=createFieldRadarExporter({library:'/unused-synthetic',radar:{get:async()=>record}}),calls=[];let failTable=false,delayNext=false,release=null;
const browser=await chromium.launch({headless:true});
try{
 const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.route('**/*',r=>r.abort());
 await page.exposeFunction('radarApi',async(action,args)=>{calls.push({action,args});if(action==='field_radar_list')return {topics:[{topic:document.topic}]};if(action==='field_radar_get')return record;if(action==='field_radar_relations_get')return {document:relation,revision:'relation-rev',digest:'synthetic-digest',...(args?.id?{linkage:linkRadarRelations(relation,record)}:{})};if(action==='field_radar_table'){if(failTable)throw Error('Synthetic request failure');const result=await exporter.tablePreview(args);if(delayNext){delayNext=false;await new Promise(resolve=>{release=resolve;});}return result;}if(action==='field_radar_analysis_latest')return {};throw Error('Unexpected '+action);});
 await page.setContent('<div class="topbar-actions"></div><main class="workspace"></main>');
 for(const name of ['field-radar-data.js','field-radar-relations-renderer.js','field-radar-relations.js','field-radar.js'])await page.addScriptTag({path:resolve('web',name)});
 await page.addStyleTag({path:resolve('web/field-radar.css')});
 await page.evaluate(()=>window.radar=window.PaperFieldRadar.create({api:(a,v)=>window.radarApi(a,v)}));
 await page.locator('#field-radar-open').click();await page.locator('#field-radar-tab-table').click();await page.waitForFunction(()=>document.querySelectorAll('.radar-literature-table tbody tr:not(.radar-literature-evidence)').length===3);
 await page.locator('#field-radar-table-relations').click();await page.locator('#field-radar-relations svg').waitFor();assert.match(await page.locator('#field-radar-relations [role=status]').textContent(),/2 \/ 2.*2 \/ 3/);
 // Table column filters recompute the graph; clear retains input DOM and restores records.
 const columnFilters=page.locator('#field-radar-column-filters');assert.equal(await columnFilters.evaluate(el=>el.open),false);await columnFilters.locator('summary').press('Enter');
 const method=page.locator('#field-radar-table-filter-method');await method.fill('alpha');await page.waitForFunction(()=>document.querySelectorAll('#field-radar-relations .radar-card').length===1);assert.match(await page.locator('#field-radar-relations svg').textContent(),/1 篇独立作品/);
 await method.fill('');await page.waitForFunction(()=>document.querySelectorAll('#field-radar-relations .radar-card').length===2);
 await page.getByRole('checkbox',{name:'显示维度 方法主类',exact:true}).uncheck();assert.equal(await page.locator('.radar-relations-dimensions input:checked').count(),2);assert.equal(await page.locator('.radar-relations-dimensions input:disabled').count(),2);assert.match(await page.locator('#field-radar-relations svg').textContent(),/2维桑基图/);
 await page.getByRole('combobox',{name:'桑基图列距',exact:true}).selectOption('1.8');assert.equal(await page.locator('#field-radar-relations svg').getAttribute('width'),'5040');await page.getByRole('combobox',{name:'关系图显示宽度',exact:true}).selectOption('2400');assert.equal(await page.locator('#field-radar-relations svg').evaluate(n=>n.style.width),'2400px');
 // SVG and data downloads describe exactly the current dimensions and snapshot revisions.
 const svgDownload=page.waitForEvent('download');await page.locator('#field-radar-relations-svg').click();const svgFile=await svgDownload;assert.match(await readFile(await svgFile.path(),'utf8'),/width="5040"/);
 const jsonDownload=page.waitForEvent('download');await page.locator('#field-radar-relations-json').click();const jsonFile=await jsonDownload,receipt=JSON.parse(await readFile(await jsonFile.path(),'utf8'));assert.equal(receipt.relation_revision,'relation-rev');assert.equal(receipt.selection.kind,'sankey');assert.deepEqual(receipt.selection.visible_dimensions,['task','year']);assert.equal(receipt.document.records.length,2);
 // A node/edge selection becomes the table paper-ID restriction, including copied/exported args.
 await page.locator('#field-radar-relations .mark[data-records="p1"]').first().click();await page.locator('#field-radar-relations-table').click();await page.waitForFunction(()=>document.querySelectorAll('.radar-literature-table tbody tr:not(.radar-literature-evidence)').length===1);assert.deepEqual(calls.filter(x=>x.action==='field_radar_table').at(-1).args.paper_ids,['p1']);
 await page.locator('#field-radar-table-clear-relations').click();await page.waitForFunction(()=>document.querySelectorAll('.radar-literature-table tbody tr:not(.radar-literature-evidence)').length===3);
 // Independent snapshot -> per-paper table navigation must turn linkage back on.
 await page.locator('#field-radar-table-relations').click();await page.locator('#field-radar-relations-linked').uncheck();await page.waitForFunction(()=>document.querySelector('#field-radar-relations [role=status]').textContent.includes('独立快照'));
 await page.locator('#field-radar-relations .radar-card').first().getByRole('button',{name:'在文献表查看此篇'}).click();await page.waitForFunction(()=>document.querySelectorAll('.radar-literature-table tbody tr:not(.radar-literature-evidence)').length===1);assert.deepEqual(calls.filter(x=>x.action==='field_radar_table').at(-1).args.paper_ids,['p1']);
 await page.locator('#field-radar-table-clear-relations').click();await page.waitForFunction(()=>document.querySelectorAll('.radar-literature-table tbody tr:not(.radar-literature-evidence)').length===3);
 // Unmatched table paper remains present and cannot be silently merged into graph.
 await page.locator('.radar-literature-evidence').last().getByRole('button',{name:'在桑基图定位此篇'}).click();assert.match(await page.locator('#field-radar-relations [role=status]').textContent(),/没有唯一对应/);
 await method.fill('no-synthetic-match');await page.waitForFunction(()=>document.querySelector('#field-radar-relations').textContent.includes('当前筛选无关系记录'));assert.equal(await page.locator('#field-radar-relations-svg').isDisabled(),true);assert.equal(await page.locator('#field-radar-relations svg').count(),0);
 await method.fill('');await page.locator('#field-radar-relations svg').waitFor();await page.getByRole('combobox',{name:'Relations chart',exact:true}).selectOption('circular');assert.match(await page.locator('#field-radar-relations svg').textContent(),/一个扇区 = 一篇论文/);
 // An older filtered result cannot replace a newer request; failures cannot resurrect old graphs.
 delayNext=true;await method.fill('alpha');await page.waitForTimeout(100);assert.ok(release);await method.fill('beta');await page.waitForFunction(()=>document.querySelectorAll('#field-radar-relations .radar-card').length===1&&document.querySelector('#field-radar-relations .radar-card h3').textContent.includes('paper two'));release();await page.waitForTimeout(100);assert.match(await page.locator('#field-radar-relations .radar-card h3').textContent(),/paper two/);
 failTable=true;await method.fill('failure');await page.waitForFunction(()=>document.querySelector('#field-radar-relations [role=status]').textContent.includes('读取失败'));await page.getByRole('combobox',{name:'Relations language',exact:true}).selectOption('en');assert.equal(await page.locator('#field-radar-relations svg').count(),0);assert.equal(await page.locator('#field-radar-relations-json').isDisabled(),true);failTable=false;await method.fill('');await page.locator('#field-radar-relations svg').waitFor();
 assert.deepEqual(errors,[]);await page.evaluate(()=>window.radar.dispose());console.log(JSON.stringify({passed:20,scope:'shared identity, unmatched preservation, table/graph filtering, node navigation, independent relink, column removal, width, empty result, circular projection, errors/disposal',page_errors:errors}));
}finally{await browser.close();}
