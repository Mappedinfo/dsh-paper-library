/** Table-cell containment and compact search acceptance. Synthetic records only. */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {Readable} from 'node:stream';
import {mkdir,mkdtemp,writeFile} from 'node:fs/promises';
import {dirname,join,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {core} from '../src/bridge.mjs';
import {createFetchHandler} from '../src/http.mjs';
import {createLocalStateStore} from '../src/local-state.mjs';

const project=dirname(dirname(fileURLToPath(import.meta.url)));
await mkdir(join(project,'.local'),{recursive:true});
const run=await mkdtemp(join(project,'.local/catalog-layout-browser-'));
const library=join(run,'library'),home=join(run,'home'),python=join(project,'.venv/bin/python');
const longTitle='Synthetic catalog containment: How exceptionally long research titles remain readable while columns for authors, publication dates and dataset identities stay aligned in a narrow research workspace';
const authors=Array.from({length:12},(_,i)=>({given:`Synthetic author ${i}`,family:'Demonstration',affiliation:[{name:'A deliberately long synthetic research institute used only for layout validation'}]}));
const [paper]=(await core({action:'import',items:[{id:'CatalogContainment',title:longTitle,author:authors,'container-title':'Synthetic Journal of Detailed UI Acceptance and Repeatable Local Workflows',issued:{'date-parts':[[2026]]},DOI:'10.1234/synthetic-catalog-layout',citationKey:'SyntheticLongCatalogKey2026'},{id:'CatalogOther',title:'A short synthetic title',author:[{family:'Fixture'}]}]},{library,python})).items;
await core({action:'dataset_put',expected_revision:0,metadata:{title:'Synthetic dataset for compact catalog checks',author:[{literal:'Synthetic data creator'}],publisher:'An intentionally long synthetic publishing organization',registration_level:'L0'}},{library,python});
const localState=createLocalStateStore({library,home});
const handler=createFetchHandler({library,python,localState,loopbackOnly:true});
const server=createServer(async(req,res)=>{try{const request=new Request(`http://${req.headers.host}${req.url}`,{method:req.method,headers:req.headers,...(!['GET','HEAD'].includes(req.method)?{body:Readable.toWeb(req),duplex:'half'}:{})});const reply=await handler(request);res.writeHead(reply.status,Object.fromEntries(reply.headers));if(reply.body)Readable.fromWeb(reply.body).pipe(res);else res.end();}catch(error){res.writeHead(500);res.end(error.message);}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`;
const checks=[],measurements=[],screenshots=[],errors=[],external=[],calls=[];
const record=label=>{checks.push(label);console.log(`PASS ${label}`);};
let browser;
try{
  const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');browser=await chromium.launch({headless:true});
  for(const theme of ['light','dark']){
    const context=await browser.newContext({viewport:{width:511,height:518},colorScheme:theme});const page=await context.newPage();page.setDefaultTimeout(20000);
    await page.addInitScript(()=>{Storage.prototype.setItem=function(){throw new Error('Catalog fixture forbids browser storage writes');};});
    page.on('pageerror',error=>errors.push(error.message));page.on('request',request=>{if(/^https?:/.test(request.url())&&new URL(request.url()).origin!==origin)external.push(request.url());if(request.url().endsWith('/api'))calls.push(request.postDataJSON()?.action);});
    await page.goto(origin);await page.waitForLoadState('networkidle');await page.locator('#workspace-library').click();await page.locator('#catalog-table tbody tr').first().waitFor();
    for(const [width,height] of [[511,518],[681,518],[1400,950]]){
      await page.setViewportSize({width,height});
      await page.locator('#catalog-table').evaluate(n=>{n.scrollLeft=0;});
      const measured=await page.evaluate(()=>{
        const bounds=n=>{const r=n.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height};};
        const table=document.getElementById('catalog-table'),heading=document.querySelector('.pane-heading'),search=document.getElementById('search');
        return {heading:bounds(heading),search:bounds(search.closest('label')),inputFont:getComputedStyle(search).fontSize,searchInHeading:heading.contains(search),documentOverflow:document.documentElement.scrollWidth>innerWidth+1,tableWidth:table.clientWidth,tableScrollWidth:table.scrollWidth,
          rows:[...table.querySelectorAll('tbody tr')].map(row=>({height:row.getBoundingClientRect().height,cells:[...row.querySelectorAll('td')].map(td=>({cell:bounds(td),text:td.querySelector('.table-title,.table-cell-text')?bounds(td.firstElementChild):null}))}))};
      });
      measurements.push({theme,width,height,...measured});
      assert.equal(measured.searchInHeading,true);assert.equal(measured.documentOverflow,false);assert.ok(measured.search.height<=30);assert.ok(measured.heading.height<=48);assert.ok(measured.search.top>=measured.heading.top&&measured.search.bottom<=measured.heading.bottom);assert.ok(Number.parseFloat(measured.inputFont)<=12);
      for(const row of measured.rows){assert.ok(row.height<=64,`${theme} ${width}px row height ${row.height}`);for(const {cell,text}of row.cells)if(text){assert.ok(text.left>=cell.left&&text.right<=cell.right+.5,'cell text escapes horizontal bounds');assert.ok(text.height<=35,'cell text exceeds two compact lines');}}
      const title=page.locator(`tr[data-paper-id="${paper.id}"] .table-title`);await title.focus();await page.locator('#catalog-cell-preview').waitFor();assert.equal(await page.locator('#catalog-cell-preview').textContent(),longTitle);const popup=await page.locator('#catalog-cell-preview').boundingBox();assert.ok(popup.x>=0&&popup.x+popup.width<=width&&popup.y>=0&&popup.y+popup.height<=height);await title.press('Escape');assert.equal(await page.locator('#catalog-cell-preview').isVisible(),false);
      await title.blur();await title.hover();await page.locator('#catalog-cell-preview').waitFor();assert.equal(await page.locator('#catalog-cell-preview').textContent(),longTitle);await page.locator('#search').hover();await page.locator('#catalog-cell-preview').waitFor({state:'hidden'});
      const screenshot=join(run,`${theme}-compact-catalog-${width}.png`);await page.screenshot({path:screenshot});screenshots.push(relative(project,screenshot));
      await page.locator('#catalog-table').evaluate(n=>{n.scrollLeft=n.scrollWidth;});assert.equal(await page.locator('#search').isVisible(),true);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);await page.locator('#catalog-table').evaluate(n=>{n.scrollLeft=0;});
      record(`${theme}-${width}px-table-clips-each-cell-with-compact-heading-and-complete-title-on-hover-or-focus`);
    }
    await page.keyboard.press('Control+k');assert.equal(await page.locator('#search').evaluate(n=>n===document.activeElement),true);await page.locator('#search').fill('Synthetic catalog containment');await page.waitForFunction(()=>document.querySelectorAll('#catalog-table tbody tr').length===1);assert.equal(await page.locator('#catalog-table tbody tr').getAttribute('data-paper-id'),paper.id);
    await page.locator('#catalog-expand').click();assert.equal(await page.locator('#search').inputValue(),'Synthetic catalog containment');await page.locator(`.paper-card[data-id="${paper.id}"]`).waitFor();await page.locator('#catalog-expand').click();await page.locator('#catalog-table tbody tr').waitFor();assert.equal(await page.locator('#search').inputValue(),'Synthetic catalog containment');
    await page.locator('#search').fill('');await page.locator('#catalog-kind').selectOption('dataset');await page.waitForFunction(()=>document.querySelectorAll('#catalog-table tbody tr').length===1&&document.querySelector('#catalog-table tbody tr').textContent.includes('数据集'));record(`${theme}-keyboard-search-filters-and-retains-query-across-list-table-switches-and-dataset-filter`);
    await context.close();
  }
  assert.deepEqual(errors,[]);assert.deepEqual(external,[]);assert.equal(calls.some(action=>/^(page|annotations|feedback|language|knowledge_generate|paper_chat)/.test(action||'')),false);record('metadata-only-catalog-with-zero-pdf-model-external-requests-or-browser-storage-writes');
  await writeFile(join(project,'docs/validation/catalog-layout-browser.json'),JSON.stringify({verified_at:new Date().toISOString(),checks,measurements,viewports:[[511,518],[681,518],[1400,950]],themes:['light','dark'],row_height_limit:64,search_height_limit:30,heading_height_limit:48,model_requests:0,pdf_requests:0,external_requests:0,browser_errors:errors,local_storage_writes:0,screenshots,scope:'Actual Chromium with synthetic metadata, isolated host disk storage, explicit text bounds and full-title hover/focus checks. Not formal user validation.'},null,2)+'\n');
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
