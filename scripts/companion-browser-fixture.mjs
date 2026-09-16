/** Real browser + host queue + portable synthetic PDF; deterministic adapter only. */
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {Readable} from 'node:stream'
import {spawnSync} from 'node:child_process'
import {randomUUID} from 'node:crypto'
import {mkdir,mkdtemp,writeFile} from 'node:fs/promises'
import {join,relative} from 'node:path'
import {core} from '../src/bridge.mjs'
import {createFetchHandler} from '../src/http.mjs'
import {createLocalStateStore} from '../src/local-state.mjs'
import {createPaperLibrarySettings} from '../src/harness/settings.mjs'
import {createCompanionQueue} from '../src/harness/companion-queue.mjs'
const project=process.cwd();await mkdir('.local',{recursive:true})
const run=await mkdtemp(join(project,'.local/companion-browser-')),library=join(run,'library'),python=join(project,'.venv/bin/python')
const source=join(run,'source.pdf'),made=spawnSync(python,['-c','import pymupdf,sys;d=pymupdf.open();p=d.new_page();p.insert_text((50,80),"A synthetic claim needs evidence.");d.save(sys.argv[1]);d.close()',source],{encoding:'utf8'});assert.equal(made.status,0,made.stderr)
const call=request=>core(request,{library,python}),paper=(await call({action:'import',path:source})).items[0]
const store=createLocalStateStore({library,home:join(run,'home')}),settings=createPaperLibrarySettings({store})
const snapshots=new Map(),feedback=[],checks=[],errors=[];let generations=0,companion
const chat=async r=>{
  if(r.action==='chat_catalog')return call({action:'annotation_catalog',id:r.id})
  if(r.action==='chat_context'){const snapshot_id=randomUUID();snapshots.set(snapshot_id,r);return{snapshot_id}}
  if(r.action==='chat_history')return{feedback}
  if(r.action==='chat_send'){
    const selected=snapshots.get(r.snapshot_id);generations++
    setTimeout(()=>{void (async()=>{
      const saved=await call({action:'save_conversation_feedback',id:r.id,text:'Synthetic companion: this is a source-bounded explanation, understanding remains unverified.',model:'fixture/companion',annotation_ids:selected.annotation_refs.map(v=>v.id),source_session_id:'fixture',source_message_id:r.request_id})
      const result={status:'saved',message_id:r.request_id,annotation_id:saved.annotation_id,source_snapshot_ids:[r.snapshot_id]};feedback.push(result);await companion.feedback(r.id,result)
    })().catch(e=>errors.push(e.message))},400)
    return{sessionId:'fixture',accepted:true}
  }
  throw Error(r.action)
}
companion=createCompanionQueue({store,settings,paperChat:chat,dispatch:call,library,python,delay:100})
const handler=createFetchHandler({library,python,localState:store,settings,companion,loopbackOnly:true})
const server=createServer(async(req,res)=>{try{const r=await handler(new Request(`http://${req.headers.host}${req.url}`,{method:req.method,headers:req.headers,...(!['GET','HEAD'].includes(req.method)?{body:Readable.toWeb(req),duplex:'half'}:{})}));res.writeHead(r.status,Object.fromEntries(r.headers));if(r.body)Readable.fromWeb(r.body).pipe(res);else res.end()}catch(e){res.writeHead(500);res.end(e.message)}})
await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`
let browser
try{
  const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');browser=await chromium.launch({headless:true})
  const context=await browser.newContext({viewport:{width:681,height:620},colorScheme:'dark'})
  await context.addInitScript(()=>{Storage.prototype.setItem=()=>{throw Error('No browser storage')}})
  let page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto(origin)
  await page.locator(`.paper-card[data-id="${paper.id}"]`).click();await page.locator('#companion-toggle').click()
  await page.waitForFunction(()=>document.querySelector('#companion-toggle').getAttribute('aria-pressed')==='true')
  const result=await page.evaluate(async id=>{const r=await fetch('/api',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'annotate',id,page:1,type:'note',comment:'What evidence supports this claim?'})});return r.json()},paper.id)
  assert.equal(result.result.companion.status,'queued');checks.push('toolbar-enables-shared-settings-and-human-save-enters-host-queue')
  await page.close();await new Promise(r=>setTimeout(r,1800))
  page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto(origin)
  await page.locator(`.paper-card[data-id="${paper.id}"]`).click();await page.locator('[data-tab="annotations"]').click()
  await page.locator('.annotation-reply').waitFor();await page.locator('.companion-state').filter({hasText:'伴学回复已保存'}).waitFor()
  assert.equal(generations,1);assert.equal(await page.locator('#annotation-list > .annotation-card').count(),1)
  checks.push('closed-browser-completes-and-fresh-reader-restores-linked-reply-and-status')
  await page.locator('.annotation-reply > summary').click();assert.match(await page.locator('.annotation-reply-body').textContent(),/understanding remains unverified/)
  for(const width of [511,681]){await page.setViewportSize({width,height:620});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);await page.screenshot({path:join(run,`dark-${width}.png`)})}
  checks.push('narrow-reader-displays-compact-toggle-and-source-linked-response')
  await page.locator('#companion-toggle').click();await page.waitForFunction(()=>document.querySelector('#companion-toggle').getAttribute('aria-pressed')==='false')
  const off=await page.evaluate(async id=>(await (await fetch('/api',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'annotate',id,page:1,type:'note',comment:'A paused companion question'})})).json()).result.companion.status,paper.id)
  assert.equal(off,'off');assert.equal(generations,1);checks.push('pausing-retains-human-note-without-model-call');assert.deepEqual(errors,[])
  await writeFile('docs/validation/companion-browser.json',JSON.stringify({verified_at:new Date().toISOString(),ok:true,checks,deterministicGenerations:generations,externalModelRequests:0,browserErrors:errors,screenshots:[511,681].map(w=>relative(project,join(run,`dark-${w}.png`))),limitations:['Synthetic adapter; native DSH completion is covered by paper-chat-harness.json.']},null,2)+'\n')
  console.log(JSON.stringify({ok:true,checks}))
}finally{companion.dispose();settings.dispose();await browser?.close();await new Promise(r=>server.close(r))}
