/** Isolated synthetic headless browser; never connects to a user's browser or DSH. */
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {relationsFixture} from '../tests-js/fixtures/relations-synthetic.mjs';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const browser=await chromium.launch({headless:true});
try{
 const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.route('**/*',route=>route.abort());
 await page.setContent('<div class="topbar-actions"></div><main class="workspace"></main>');
 for(const name of ['field-radar-data.js','field-radar-relations-renderer.js','field-radar-relations.js','field-radar.js'])await page.addScriptTag({path:resolve('web',name)});
 const d=relationsFixture();for(let i=3;i<=24;i++)d.records.push({...structuredClone(d.records[0]),id:'p'+i,title:'Synthetic paper '+i});
 await page.evaluate(document=>{window.calls=[];window.radar=window.PaperFieldRadar.create({api:async(action)=>{window.calls.push(action);if(action==='field_radar_list')return {topics:[],next_offset:null};if(action==='field_radar_relations_get')return {document,revision:'synthetic'};throw Error('Unexpected API '+action);}});},d);
 await page.locator('#field-radar-open').click();await page.locator('#field-radar-tab-relations').click();await page.locator('#field-radar-relations svg').waitFor();assert.equal(await page.locator('#field-radar-relations .radar-card').count(),20);
 await page.locator('#field-radar-relations').getByRole('button',{name:'→',exact:true}).click();assert.equal(await page.locator('#field-radar-relations .radar-card').count(),4);
 await page.getByRole('searchbox',{name:'Filter relations papers'}).fill('paper two');assert.equal(await page.locator('#field-radar-relations .radar-card').count(),1);
 await page.getByRole('combobox',{name:'Relations language'}).selectOption('en');assert.equal(await page.locator('#field-radar-relations .radar-card').count(),1);assert.match(await page.locator('#field-radar-relations [role=status]').innerText(),/1 \/ 24/);
 await page.getByRole('combobox',{name:'Relations chart'}).selectOption('circular');assert.match(await page.locator('#field-radar-relations svg').textContent(),/One sector = one paper/);
 await page.locator('#field-radar-tab-overview').click();assert.equal(await page.locator('#field-radar-relations').isVisible(),false);await page.locator('#field-radar-tab-relations').click();assert.equal(await page.getByRole('searchbox',{name:'Filter relations papers'}).inputValue(),'paper two');
 assert.deepEqual(errors,[]);assert.deepEqual(await page.evaluate(()=>[...new Set(window.calls)]),['field_radar_list','field_radar_relations_get']);await page.evaluate(()=>window.radar.dispose());assert.equal(await page.locator('#field-radar').count(),0);
 console.log(JSON.stringify({passed:8,scope:'synthetic isolated native tab, pagination, search, bilingual retention, circular mode, tab retention, no model API, disposal',page_errors:errors}));
}finally{await browser.close();}
