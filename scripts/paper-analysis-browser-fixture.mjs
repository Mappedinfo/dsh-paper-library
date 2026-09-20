/** Actual browser + host disk job lifecycle; deterministic selected-material adapter.
 * Native subagent isolation is tested separately by paper-analysis-harness-smoke. */
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {Readable} from 'node:stream'
import {spawnSync} from 'node:child_process'
import {mkdir,mkdtemp,writeFile} from 'node:fs/promises'
import {dirname,join,relative} from 'node:path'
import {fileURLToPath} from 'node:url'
import {core,dispatch} from '../src/bridge.mjs'
import {createFetchHandler} from '../src/http.mjs'
import {createLocalStateStore} from '../src/local-state.mjs'
import {createPaperAnalysis} from '../src/harness/paper-analysis.mjs'
import {createQueuedPaperAnalysis} from '../src/harness/paper-analysis-queue.mjs'
import {createPaperLibrarySettings} from '../src/harness/settings.mjs'
const project=dirname(dirname(fileURLToPath(import.meta.url)))
await mkdir(join(project,'.local'),{recursive:true})
const run=await mkdtemp(join(project,'.local/paper-analysis-browser-')),library=join(run,'library'),home=join(run,'home'),source=join(run,'source'),python=join(project,'.venv/bin/python')
const generated=spawnSync(python,['scripts/create-reader-demo.py','--output',source],{cwd:project,encoding:'utf8'});assert.equal(generated.status,0,generated.stderr)
const [paper]=(await core({action:'import',path:join(source,'reader-export.json')},{library,python})).items
const store=createLocalStateStore({library,home}),route={provider:'synthetic-provider',model:'selected-paper-model'}
let calls=0,hold=false,sent=0
const paperChat=async input=>{
  if(input.action==='chat_ensure')return{sessionId:`synthetic-${input.id}`,model:route}
  if(input.action==='chat_catalog')return{annotations:[],total:0}
  if(input.action==='chat_history')return{messages:[],status:'idle',model:route}
  sent++;throw new Error('Browser fixture may prepare, never send a main conversation')
}
const agent=async({prompt,signal})=>{
  calls++
  if(hold)await new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}))
  if(prompt.includes('REVIEW_METHOD: evidence-atlas'))return JSON.stringify({title:'证据图谱评审：浏览器夹具',body:'# 证据图谱评审：浏览器夹具\n## 1. 快速判定\n条件性评价。\n## 2. 案例拆解\n案例 C1（八维，未报告字段留空）。\n## 3. 状态矩阵\n| 案例 | 需求 | 状态 |\n| C1 | 精度 | unknown |\n## 4. 归因\nreported_result：夹具证据。\n## 5. 联合覆盖\n无联合声称。\n## 6. 形容词\n精准：需指标与参照。\n## 7. 本文最多能声称\nreported_result：夹具批次。\n## 8. 本文不能声称\nunknown：泛化。\n## 9. 修改清单\nP0 补基线。'})
  if(prompt.includes('READING_RECORDS_JSON:\n'))return JSON.stringify({title:'合成精读笔记',body:'## 一句话概括\n浏览器夹具笔记，不构成学术判断。'})
  const selected=JSON.parse(prompt.split('LIBRARY_KNOWLEDGE_JSON:\n')[1].split('\nAdditionally return metadata')[0]),s=selected.sources[0],quote=s.text.slice(0,100)
  return JSON.stringify({title:'Synthetic selected-paper graph',body:'Only selected pages were inspected.',nodes:[{id:'excerpt',type:'evidence',label:'Selected passage',source_id:s.id,quote},{id:'claim',type:'claim',label:'Synthetic bounded claim'},{id:'unselected',type:'method',label:'Unselected method sentinel'}],edges:[],assertions:[{subject:'evidence:excerpt',object:'claim:claim',relation:'supports',surface:'Synthetic source-backed relation'}],metadata:{abstract:quote},field_sources:{abstract:[{source_id:s.id,quote}]}})
}
await store.put('preferences',{auto_analysis:false,analysis_fill:false},0)
const settings=createPaperLibrarySettings({store})
const analysis=createQueuedPaperAnalysis({store,settings,analysis:createPaperAnalysis({store,dispatch,paperChat,agent,library,python})})
const handler=createFetchHandler({library,python,localState:store,paperChat,paperAnalysis:analysis,settings,onImported:items=>analysis.imported(items),loopbackOnly:true})
const server=createServer(async(req,res)=>{try{const request=new Request(`http://${req.headers.host}${req.url}`,{method:req.method,headers:req.headers,...(!['GET','HEAD'].includes(req.method)?{body:Readable.toWeb(req),duplex:'half'}:{})});const reply=await handler(request);res.writeHead(reply.status,Object.fromEntries(reply.headers));if(reply.body)Readable.fromWeb(reply.body).pipe(res);else res.end()}catch(error){res.writeHead(500);res.end(error.message)}})
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
const origin=`http://127.0.0.1:${server.address().port}`,checks=[],errors=[],external=[],screenshots=[]
let browser
const record=name=>{checks.push(name);console.log(`PASS ${name}`)}
try{
  const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');browser=await chromium.launch({headless:true})
  async function newPage(){const ctx=await browser.newContext({viewport:{width:900,height:760}});const page=await ctx.newPage();page.setDefaultTimeout(20000);page.on('pageerror',error=>errors.push(error.message));page.on('request',req=>{if(/^https?:/.test(req.url())&&new URL(req.url()).origin!==origin)external.push(req.url())});await page.addInitScript(()=>{Storage.prototype.setItem=()=>{throw new Error('Browser Storage writes forbidden')}});await page.goto(origin);await page.waitForLoadState('networkidle');return page}
  let page=await newPage()
  await page.locator(`.paper-card[data-id="${paper.id}"]`).click();await page.locator('.pdr-page-image').first().waitFor()
  await page.locator('#paper-analysis-open').click();assert.equal(await page.locator('#analysis-auto').isChecked(),false);assert.equal(calls,0)
  await page.locator('#analysis-pages').fill('1,1');await page.locator('#analysis-start').click();await page.waitForFunction(()=>document.getElementById('analysis-status').textContent.includes('不能重复'));assert.equal(calls,0)
  record('explicit-opt-out-and-invalid-page-range-never-start-model')
  await page.locator('#analysis-pages').fill('2');await page.locator('#analysis-start').click();await page.locator('#analysis-result .analysis-node').first().waitFor();assert.equal(calls,3);assert.match(await page.locator('#analysis-result').innerText(),/PDF 页：2/);assert.match(await page.locator('#analysis-result').innerText(),/精读笔记草稿已生成/);assert.match(await page.locator('#analysis-result').innerText(),/证据图谱评审草稿已生成/)
  const job=await analysis({action:'paper_analysis_get',id:paper.id});assert.equal(job.status,'complete');assert.equal(job.draft.status,'needs-review');assert.deepEqual(job.coverage.read_pages,[2]);assert.equal(sent,0)
  record('background-selected-page-job-saves-pending-sourced-graph-without-main-chat-message')
  await page.locator('#analysis-apply').click();await page.waitForFunction(()=>document.getElementById('analysis-result').textContent.includes('已补齐'));assert.ok((await core({action:'get',id:paper.id},{library,python})).abstract)
  record('explicit-metadata-fill-persists-in-managed-paper-with-pending-provenance')
  await page.locator('#analysis-result input[aria-label="选择 Selected passage"]').check();await page.locator('#analysis-result input[aria-label="选择 Synthetic bounded claim"]').check();await page.locator('#analysis-to-chat').click();await page.locator('#paper-analysis-panel').waitFor({state:'hidden'});assert.match(await page.locator('#paper-chat-input').inputValue(),/尚未核对/);assert.match(await page.locator('#paper-chat-input').inputValue(),/Selected passage/);assert.doesNotMatch(await page.locator('#paper-chat-input').inputValue(),/Unselected method sentinel/);assert.equal(sent,0);await page.evaluate(()=>persistence.flush())
  record('only-checked-result-nodes-enter-durable-paper-chat-draft-with-no-send')
  await page.context().close();page=await newPage();await page.locator(`.paper-card[data-id="${paper.id}"]`).click();await page.locator('.pdr-page-image').first().waitFor();await page.locator('#paper-analysis-open').click();await page.locator('.analysis-node').first().waitFor();assert.equal(calls,3)
  for(const width of [511,681,1400]){await page.setViewportSize({width,height:760});assert.equal(await page.locator('#paper-analysis-panel').evaluate(n=>n.getBoundingClientRect().right<=innerWidth&&n.scrollWidth<=n.clientWidth+1),true)}
  const shot=join(run,'analysis-result-511.png');await page.setViewportSize({width:511,height:518});await page.screenshot({path:shot});screenshots.push(relative(project,shot));assert.equal(await page.locator('#analysis-pages').inputValue(),'2')
  assert.equal(await page.locator('#analysis-result input[aria-label="选择 Selected passage"]').isChecked(),true)
  assert.equal(await page.locator('#analysis-result input[aria-label="选择 Unselected method sentinel"]').isChecked(),false)
  record('second-browser-restores-result-and-pages-without-model-replay-and-panel-fits-511-681-1400')
  await page.locator('#paper-analysis-open').click();hold=true;await page.locator('#analysis-start').click();await page.waitForFunction(()=>document.getElementById('analysis-status').textContent.includes('子代理'));await page.locator('#analysis-cancel').click();await page.waitForFunction(()=>document.getElementById('analysis-status').textContent.includes('取消'));assert.equal(calls,4,'The cancelled run starts one generation and never reaches note or review');hold=false
  record('explicit-cancel-stops-background-job-and-retains-previous-draft')
  await page.locator('#analysis-auto').check();await page.evaluate(()=>persistence.flush());assert.equal((await store.get('preferences')).value.auto_analysis,true);assert.equal(calls,4);await page.locator('#analysis-auto').uncheck();await page.evaluate(()=>persistence.flush())
  record('automatic-selection-setting-is-host-owned-and-does-not-replay-interrupted-work')
  const fullPdf=join(run,'full-paper.pdf')
  const generatedFull=spawnSync(python,['-c','import pymupdf,sys\ndoc=pymupdf.open()\nfor i in range(13):\n page=doc.new_page();page.insert_text((40,70),f"Synthetic full paper page {i+1}. Exact bounded source.")\ndoc.save(sys.argv[1]);doc.close()',fullPdf],{cwd:project,encoding:'utf8'})
  assert.equal(generatedFull.status,0,generatedFull.stderr)
  await settings.reset((await settings.get()).revision)
  const importedResponse=await page.request.post(`${origin}/api`,{headers:{Origin:origin},data:{action:'import',path:fullPdf}})
  const imported=(await importedResponse.json()).result;assert.equal(imported.analysis_queue[0].status,'queued')
  const fullPaper=imported.items[0],beforeFull=4
  await page.context().close()
  const deadline=Date.now()+30000;let fullJob
  while(Date.now()<deadline){fullJob=await analysis({action:'paper_analysis_get',id:fullPaper.id});if(['complete','failed'].includes(fullJob.status))break;await new Promise(resolve=>setTimeout(resolve,100))}
  assert.equal(fullJob.status,'complete',JSON.stringify(fullJob));assert.equal(fullJob.batch_count,2);assert.equal(fullJob.coverage.full_document,true);assert.ok(fullJob.note_draft_id);assert.ok(fullJob.review_draft_id,'The full run also saves the evidence-atlas draft');assert.equal(calls,beforeFull+4)
  assert.ok(fullJob.metadata_result.applied_fields.includes('abstract'))
  record('imported-pdf-finishes-all-thirteen-pages-in-two-batches-with-browser-closed-and-automatic-metadata-fill')
  page=await newPage();await page.locator(`.paper-card[data-id="${fullPaper.id}"]`).click();await page.locator('.pdr-page-image').first().waitFor();await page.locator('#paper-analysis-open').click()
  assert.equal(await page.locator('#analysis-auto').isChecked(),true);assert.equal(await page.locator('#analysis-fill').isChecked(),true);assert.equal(await page.locator('#analysis-auto-review').isChecked(),true)
  assert.match(await page.locator('#analysis-pages').getAttribute('placeholder'),/全部/)
  await page.locator('#analysis-batch').selectOption('0');await page.waitForFunction(()=>document.getElementById('analysis-result').textContent.includes('本批 PDF 页：1, 2'))
  await page.locator('#analysis-result input[aria-label="选择 Selected passage"]').check();await page.evaluate(()=>persistence.flush())
  await page.setViewportSize({width:511,height:518});const fullShot=join(run,'full-analysis-511.png');await page.screenshot({path:fullShot});screenshots.push(relative(project,fullShot))
  assert.equal(await page.locator('#paper-analysis-panel').evaluate(n=>n.scrollWidth<=n.clientWidth+1),true)
  await page.context().close();page=await newPage();await page.locator(`.paper-card[data-id="${fullPaper.id}"]`).click();await page.locator('.pdr-page-image').first().waitFor();await page.locator('#paper-analysis-open').click()
  await page.waitForFunction(()=>document.getElementById('analysis-batch')?.value==='0')
  assert.equal(await page.locator('#analysis-result input[aria-label="选择 Selected passage"]').isChecked(),true);assert.equal(calls,beforeFull+4)
  record('enabled-defaults-full-scope-batch-switching-and-selected-batch-restoration-work-at-511px')
  assert.deepEqual(errors,[]);assert.deepEqual(external,[]);assert.equal(sent,0)
  const report={verified_at:new Date().toISOString(),ok:true,checks,errors,external,deterministic_generations:calls,main_messages_sent:sent,browser_storage_writes:0,screenshots,scope:'Actual Chromium + disk-backed source/job/metadata APIs with deterministic model adapter. Native subagent lifecycle checked separately; no real provider or private documents.'}
  await writeFile(join(project,'docs/validation/paper-analysis-browser.json'),JSON.stringify(report,null,2)+'\n');console.log(`REPORT ${relative(project,run)}`)
}catch(error){if(browser)for(const page of browser.contexts().flatMap(c=>c.pages())){await page.screenshot({path:join(run,`failure-${Date.now()}.png`)});console.error((await page.locator('body').innerText()).slice(-5000))}throw error}
finally{analysis.dispose();await browser?.close();await new Promise(resolve=>server.close(resolve))}
