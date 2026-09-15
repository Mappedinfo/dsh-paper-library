/** Portable reply grouping and contextual export tools, using synthetic PDFs. */
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {Readable} from 'node:stream'
import {spawnSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {mkdir,mkdtemp,readFile,writeFile} from 'node:fs/promises'
import {dirname,join,relative} from 'node:path'
import {fileURLToPath} from 'node:url'
import {core} from '../src/bridge.mjs'
import {createFetchHandler} from '../src/http.mjs'
import {createLocalStateStore} from '../src/local-state.mjs'
const project=dirname(dirname(fileURLToPath(import.meta.url)))
await mkdir(join(project,'.local'),{recursive:true})
const run=await mkdtemp(join(project,'.local/annotation-replies-browser-')),library=join(run,'library'),home=join(run,'home'),python=join(project,'.venv/bin/python'),original=join(run,'original.pdf')
const made=spawnSync(python,['-c','import pymupdf,sys; d=pymupdf.open(); p=d.new_page(); p.insert_text((50,80),"Synthetic annotation reply acceptance"); d.save(sys.argv[1]); d.close()',original],{encoding:'utf8'})
assert.equal(made.status,0,made.stderr)
const digest=async()=>createHash('sha256').update(await readFile(original)).digest('hex'),originalHash=await digest()
const call=request=>core(request,{library,python})
const paper=(await call({action:'import',path:original})).items[0]
const notes=[]
for(const comment of ['Why does this result follow?','How does the method use this evidence?'])notes.push((await call({action:'annotate',id:paper.id,page:1,type:'note',comment})).annotation)
for(const [index,ids]of [[1,[notes[0].id]],[2,notes.map(note=>note.id)],[3,[]]])await call({action:'save_conversation_feedback',id:paper.id,text:`Synthetic AI reply ${index}. Evidence remains subject to review.`,model:'synthetic/reply-reader',annotation_ids:ids,source_session_id:'synthetic-session',source_message_id:String(index)})
const handler=createFetchHandler({library,python,localState:createLocalStateStore({library,home}),loopbackOnly:true})
const server=createServer(async(req,res)=>{try{const reply=await handler(new Request(`http://${req.headers.host}${req.url}`,{method:req.method,headers:req.headers,...(!['GET','HEAD'].includes(req.method)?{body:Readable.toWeb(req),duplex:'half'}:{})}));res.writeHead(reply.status,Object.fromEntries(reply.headers));if(reply.body)Readable.fromWeb(reply.body).pipe(res);else res.end()}catch(error){res.writeHead(500);res.end(error.message)}})
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
const origin=`http://127.0.0.1:${server.address().port}`,checks=[],screenshots=[],errors=[],external=[]
const record=name=>{checks.push(name);console.log(`PASS ${name}`)}
let browser
try{
  const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');browser=await chromium.launch({headless:true})
  for(const theme of ['light','dark']){
    const context=await browser.newContext({viewport:{width:511,height:518},colorScheme:theme,permissions:['clipboard-read','clipboard-write']})
    await context.addInitScript(()=>{Storage.prototype.setItem=()=>{throw Error('Browser storage is forbidden')}})
    const page=await context.newPage();page.setDefaultTimeout(15000)
    page.on('pageerror',error=>errors.push(error.message));page.on('request',request=>{if(/^https?:/.test(request.url())&&new URL(request.url()).origin!==origin)external.push(request.url())})
    await page.goto(origin);await page.waitForLoadState('networkidle');await page.locator(`.paper-card[data-id="${paper.id}"]`).click();await page.locator('[data-tab="annotations"]').click()
    await page.waitForFunction(()=>document.getElementById('annotation-count').textContent==='2')
    assert.equal(await page.locator('#annotation-list > .annotation-card').count(),2)
    const first=page.locator(`#annotation-list > [data-annotation-id="${notes[0].id}"]`),second=page.locator(`#annotation-list > [data-annotation-id="${notes[1].id}"]`)
    assert.equal(await first.locator('.annotation-reply').count(),2);assert.equal(await second.locator('.annotation-reply').count(),1)
    assert.equal(await page.locator('.annotation-unlinked .annotation-reply').count(),1)
    await first.locator('.annotation-reply > summary').first().click();assert.match(await first.locator('.annotation-reply-body').first().textContent(),/Synthetic AI reply 1/)
    assert.equal(await page.locator('.reader-ribbon #ribbon-citations').count(),0)
    assert.equal(await page.locator('#paper-tools #citation-tools').count(),1)
    const before=await page.locator('#continuous-reader').evaluate(n=>n.scrollTop)
    await page.locator('#citation-tools > summary').click();await page.locator('#copy-apa').click();await page.waitForFunction(()=>!document.getElementById('copy-apa').disabled)
    assert.ok((await page.evaluate(()=>navigator.clipboard.readText())).length>0)
    assert.equal(await page.locator('#continuous-reader').evaluate(n=>n.scrollTop),before)
    await page.keyboard.press('Escape');assert.equal(await page.locator('#citation-tools').evaluate(n=>n.open),false)
    record(`${theme}-replies-nest-under-exact-notes-with-shared-reply-label-and-unlinked-recovery`)
    for(const width of [511,681]){
      await page.setViewportSize({width,height:518});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false)
      const screenshot=join(run,`${theme}-${width}.png`);await page.screenshot({path:screenshot});screenshots.push(relative(project,screenshot))
    }
    await page.locator('#workspace-library').click();await page.locator('#citation-tools > summary').click();await page.locator('#copy-apa').waitFor()
    const menu=await page.locator('#toolbar-actions').boundingBox();assert.ok(menu.x>=0&&menu.x+menu.width<=681)
    await page.keyboard.press('Escape');record(`${theme}-library-and-reader-export-menu-preserve-mode-page-position-and-keyboard-close`)
    await context.close()
  }
  assert.equal(await digest(),originalHash);assert.deepEqual(errors,[]);assert.deepEqual(external,[])
  record('fresh-browser-restores-pdf-linked-replies-without-browser-storage-or-model-requests')
  await writeFile(join(project,'docs/validation/annotation-replies-browser.json'),JSON.stringify({verified_at:new Date().toISOString(),ok:true,checks,screenshots,themes:['light','dark'],viewports:[511,681],modelRequests:0,externalRequests:0,browserErrors:errors,sourcePdfUnchanged:true,limitations:['Synthetic browser rendering and disk recovery; automatic native model completion is tested separately.']},null,2)+'\n')
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve))}
