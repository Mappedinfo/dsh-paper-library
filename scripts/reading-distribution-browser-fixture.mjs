/** Synthetic PDFs and isolated Chromium only; never attach to the user's browser. */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {Readable} from 'node:stream';
import {spawnSync} from 'node:child_process';
import {mkdtemp,mkdir,writeFile} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {core} from '../src/bridge.mjs';
import {createFetchHandler} from '../src/http.mjs';
import {createLocalStateStore} from '../src/local-state.mjs';
import {createPaperLibrarySettings} from '../src/harness/settings.mjs';
const project=dirname(dirname(fileURLToPath(import.meta.url)));await mkdir(join(project,'.local'),{recursive:true});
const run=await mkdtemp(join(project,'.local/reading-distribution-browser-')),library=join(run,'library'),python=join(project,'.venv/bin/python'),pdf=join(run,'synthetic.pdf');
const generated=spawnSync(python,['-c',`
import pymupdf as fitz,sys
from dsh_paper_library.ai_annotation_style import apply_ai_reading_style
doc=fitz.open()
for i in range(12):
 p=doc.new_page(width=595,height=842);p.insert_text((40,50),'Synthetic distribution page '+str(i+1))
 for j in range([1,2,8,11,4,0,0,0,3,5,1,0][i]):
  a=p.add_underline_annot(fitz.Rect(40,80+j*36,420,96+j*36));a.update()
 for j in range([0,0,0,0,1,2,10,9,3,0,0,0][i]):
  a=p.add_underline_annot(fitz.Rect(40,100+j*32,420,116+j*32));apply_ai_reading_style(doc,a)
doc.save(sys.argv[1]);doc.close()
`,pdf],{encoding:'utf8',env:{...process.env,PYTHONPATH:join(project,'src')}});assert.equal(generated.status,0,generated.stderr);
const [paper,unknown]=(await core({action:'import',items:[{id:'SyntheticReadingDistribution',title:'Synthetic reading distribution across twelve pages',attachments:[{path:pdf}]},{id:'SyntheticUnknown',title:'Synthetic paper without PDF'}]},{library,python})).items;
const store=createLocalStateStore({library,home:join(run,'home')}),settings=createPaperLibrarySettings({store});const initial=await settings.get();await settings.update({auto_analysis:false,auto_review:false,reading_distribution_enabled:true},initial.revision);
const handler=createFetchHandler({library,python,localState:store,settings}),calls=[],errors=[],checks=[];let browser;
const server=createServer(async(req,res)=>{try{const request=new Request(`http://${req.headers.host}${req.url}`,{method:req.method,headers:req.headers,...(!['GET','HEAD'].includes(req.method)?{body:Readable.toWeb(req),duplex:'half'}:{})});if(req.method==='POST'&&req.url==='/api')calls.push((await request.clone().json()).action);const response=await handler(request);res.writeHead(response.status,Object.fromEntries(response.headers));if(response.body)Readable.fromWeb(response.body).pipe(res);else res.end();}catch{res.writeHead(500);res.end('Synthetic fixture failed');}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${server.address().port}`,record=name=>{checks.push(name);console.log('PASS '+name);};
try{
 const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE}:{})});const page=await browser.newPage({viewport:{width:1450,height:920}});page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(/^https?:/.test(r.url())&&new URL(r.url()).origin!==origin)errors.push('external request');});
 await page.goto(origin);await page.waitForLoadState('networkidle');await page.locator('#workspace-library').click();
 const strip=page.locator(`#catalog-table [data-reading-distribution="${paper.id}"]`);await strip.locator('svg').first().waitFor();assert.equal(await strip.locator('svg').count(),2);assert.equal(await strip.evaluate(n=>n.parentElement.classList.contains('paper-organization-actions')),true);assert.match(await strip.getAttribute('aria-label'),/不代表阅读完成度或理解程度/);record('native PDF summary appears in requested title/tag row with two distinct lanes');
 assert.equal(await strip.locator('.reading-distribution-count').textContent(),'60 处');assert.match(await page.locator(`#catalog-table [data-reading-distribution="${unknown.id}"]`).textContent(),/未知/);record('measured counts and missing PDF are visibly distinct');
 for(const theme of ['light','dark'])for(const width of [1450,511]){await page.emulateMedia({colorScheme:theme});await page.setViewportSize({width,height:920});await page.locator('#catalog-table').evaluate(n=>{n.scrollLeft=0;});const size=await strip.evaluate(n=>({w:n.getBoundingClientRect().width,parent:n.parentElement.getBoundingClientRect().width,left:n.getBoundingClientRect().left,right:n.getBoundingClientRect().right,overflow:document.documentElement.scrollWidth>innerWidth+1}));assert.ok(size.w<=size.parent+1);assert.ok(size.left>=0&&size.right<=width,'strip must be visible without horizontally scrolling the table');assert.equal(size.overflow,false);await page.screenshot({path:join(run,`${theme}-${width}.png`)});}record('light dark wide and narrow isolated layouts stay contained');
 await page.setViewportSize({width:1450,height:920});await page.locator('#settings-open').click();await page.locator('#setting-reading_distribution_mode').selectOption('bands');await page.waitForFunction(()=>document.querySelector('.reading-distribution rect'));assert.equal(await strip.locator('path').count(),0);record('density switches to native-position bands immediately');
 await page.locator('#setting-reading_distribution_ai').uncheck();await page.waitForFunction(()=>document.querySelectorAll('#catalog-table .reading-distribution-track.is-ai').length===0);record('AI layer toggle hides only AI-style marks');
 await page.locator('#setting-reading_distribution_enabled').uncheck();await page.waitForFunction(()=>[...document.querySelectorAll('.reading-distribution')].every(n=>n.hidden));await page.locator('#library-settings').getByRole('button',{name:'关闭设置',exact:true}).click();await page.reload();await page.waitForLoadState('networkidle');assert.equal(await strip.isVisible(),false);record('off preference survives isolated page reload');
 await page.locator('#settings-open').click();await page.locator('#setting-reading_distribution_enabled').check();await page.locator('#setting-reading_distribution_ai').check();await page.locator('#setting-reading_distribution_mode').selectOption('density');await page.locator('#setting-reading_distribution_smoothing').selectOption('6');await page.locator('#library-settings').getByRole('button',{name:'关闭设置',exact:true}).click();await strip.locator('path').first().waitFor();record('re-enable and stronger fitting restore two cached lanes');
 await strip.focus();assert.ok(await strip.getAttribute('aria-label'));await page.locator('#refresh').click();await page.waitForLoadState('networkidle');await strip.locator('path').first().waitFor();assert.deepEqual(errors,[]);assert.equal(calls.some(a=>['annotate','annotation_update','annotation_style','annotation_delete','paper_analysis_enqueue'].includes(a)),false);record('refresh keyboard focus and zero PDF mutations or model calls');
 await writeFile(join(run,'receipt.json'),JSON.stringify({checks,errors,calls,synthetic:true,run},null,2));console.log(JSON.stringify({checks:checks.length,errors,run}));
}finally{await browser?.close();settings.dispose();await new Promise(resolve=>server.close(resolve));}
