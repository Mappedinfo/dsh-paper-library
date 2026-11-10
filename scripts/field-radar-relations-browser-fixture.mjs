/** Isolated synthetic headless browser; never connects to a user's browser or DSH. */
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {relationsFixture} from '../tests-js/fixtures/relations-synthetic.mjs';
import {addUsageDimensions} from '../src/harness/field-radar-usage.mjs';
import {linkRadarRelations} from '../src/harness/field-radar-linkage.mjs';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const browser=await chromium.launch({headless:true});
try{
 const page=await browser.newPage({viewport:{width:1512,height:982}}),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.route('**/*',route=>route.abort());
 await page.setContent('<div class="topbar-actions"></div><main class="workspace"></main>');
 for(const name of ['field-radar-data.js','field-radar-relations-renderer.js','field-radar-relations.js','field-radar.js'])await page.addScriptTag({path:resolve('web',name)});
 for(const name of ['style.css','theme.css','field-radar.css'])await page.addStyleTag({path:resolve('web',name)});
 const original=relationsFixture();
 original.sources.push({id:'edge-only',title:'Relationship evidence',url:'https://example.org/edge'});
 original.relationships[0].source_ids=['edge-only'];
 original.records[0].evidence={task:{note:{zh:'原始证据；原句保持完整。',en:'Original evidence in English.'},locator:'PDF physical page 3',source_ids:['s1']}};
 for(let i=3;i<=67;i++)original.records.push({...structuredClone(original.records[0]),id:'p'+i,title:'Synthetic paper '+i+' '+('UnbrokenTitle'.repeat(i===42?14:1))});
 const use_statuses=['used','not_used','not_found','unknown'], statuses=['needs_review','verified','conflicting','unknown'];
 const papers=original.records.map((r,i)=>({id:r.id,title:r.title,source_ids:['s1'],comparison:{poi_usage:{use_status:use_statuses[i%4],status:statuses[i%4],...(i%4===0?{variables:'Density；a semicolon inside one field.',spatial_aggregation:'Block counts',handling_tags:['spatial_aggregation','prediction_input'],pages:[4,9]}:{}),source_ids:['s1'],evidence:'Synthetic evidence '+r.id}}}));
 const topic={revision:'topic-rev',document:{topic:{id:'synthetic'},papers,sources:original.sources}};
 const d=addUsageDimensions(original,topic,linkRadarRelations(original,topic));
 await page.evaluate(document=>{window.calls=[];window.radar=window.PaperFieldRadar.create({api:async(action)=>{window.calls.push(action);if(action==='field_radar_list')return {topics:[],next_offset:null};if(action==='field_radar_relations_get')return {document,revision:'synthetic'};throw Error('Unexpected API '+action);}});},d);
 await page.locator('#field-radar-open').click();await page.locator('#field-radar-tab-relations').click();await page.locator('#field-radar-relations svg').waitFor();assert.equal(await page.locator('#field-radar-relations .radar-card').count(),20);
 const cards=page.locator('#field-radar-relations .radar-relation-card');
 const first=cards.first();const details=first.locator('details');
 assert.equal(await details.evaluate(n=>n.open),false);
 assert.equal(await first.locator('[data-dimension=task] .radar-relation-chip').count(),2);
 assert.equal(await first.locator('[data-dimension=task] .radar-relation-swatch').count(),2);
 await details.locator('summary').click();
 assert.match(await details.innerText(),/PDF 第 3 页/);
 assert.match(await details.innerText(),/PDF 第 4, 9 页/);
 assert.match(await details.innerText(),/Density；a semicolon inside one field\./);
 assert.match(await details.innerText(),/原始证据；原句保持完整。/);
 assert.equal(await details.getByRole('link',{name:/Relationship evidence/}).getAttribute('href'),'https://example.org/edge');
 const colors=()=>first.evaluate(card=>[getComputedStyle(card).backgroundColor,getComputedStyle(card.querySelector('h3')).color]);
 await page.emulateMedia({colorScheme:'light'});const light=await colors();
 await page.emulateMedia({colorScheme:'dark'});const dark=await colors();
 assert.notDeepEqual(dark,light);assert.notEqual(dark[0],dark[1]);
 await page.setViewportSize({width:690,height:793});
 assert.equal(await first.evaluate(card=>card.scrollWidth<=card.clientWidth+1),true);
 assert.match(await details.innerText(),/PDF 第 4, 9 页/);
 await page.setViewportSize({width:1512,height:982});
 await details.locator('summary').click();
 const seen=[];
 for(let offset=0;offset<d.records.length;offset+=20){
  assert.equal(await cards.count(),Math.min(20,d.records.length-offset));
  const rendered=await cards.evaluateAll(nodes=>nodes.map(card=>({id:card.dataset.recordId,title:card.querySelector('h3').textContent,dimensions:card.querySelectorAll('.radar-relation-dimensions dt').length,
   use:card.querySelector('[data-dimension=poi_usage] dd [data-status]').dataset.status,review:card.querySelector('[data-dimension=poi_usage] dd').textContent,fits:card.scrollWidth<=card.clientWidth+1})));
  for(const [i,card]of rendered.entries()){
   const index=offset+i,expected=d.records[index];assert.equal(card.id,expected.id);assert.equal(card.title,expected.title);assert.equal(card.dimensions,d.dimensions.length);assert.equal(card.use,use_statuses[index%4]);assert.match(card.review,[/待核.*区域／街区汇总.*预测输入/,/明确未使用.*已核验/,/已查范围未发现.*冲突/,/未知/][index%4]);assert.equal(card.fits,true);seen.push(card.id);
  }
  if(offset+20<d.records.length)await page.getByRole('button',{name:'下一页',exact:true}).click();
 }
 assert.equal(new Set(seen).size,67);assert.equal(await page.locator('.radar-pager span').textContent(),'61–67 / 67');
 await page.getByRole('searchbox',{name:'Filter relations papers'}).fill('paper two');assert.equal(await page.locator('#field-radar-relations .radar-card').count(),1);
 await page.getByRole('combobox',{name:'Relations language'}).selectOption('en');assert.equal(await page.locator('#field-radar-relations .radar-card').count(),1);assert.match(await page.locator('#field-radar-relations [role=status]').innerText(),/1 \/ 67/);
 assert.match(await cards.first().locator('[data-dimension=poi_usage]').innerText(),/Explicitly not used.*Verified/s);
 await page.getByRole('combobox',{name:'Relations chart'}).selectOption('circular');assert.match(await page.locator('#field-radar-relations svg').textContent(),/One sector = one paper/);
 await page.locator('#field-radar-tab-overview').click();assert.equal(await page.locator('#field-radar-relations').isVisible(),false);await page.locator('#field-radar-tab-relations').click();assert.equal(await page.getByRole('searchbox',{name:'Filter relations papers'}).inputValue(),'paper two');
 assert.deepEqual(errors,[]);assert.deepEqual(await page.evaluate(()=>[...new Set(window.calls)]),['field_radar_list','field_radar_relations_get']);await page.evaluate(()=>window.radar.dispose());assert.equal(await page.locator('#field-radar').count(),0);
 console.log(JSON.stringify({cards_checked:seen.length,scope:'synthetic native tab, all card pages, usage and review states, legacy evidence, edge-only source, search, bilingual retention, circular mode, tab retention, no model API, disposal',page_errors:errors}));
}finally{await browser.close();}
