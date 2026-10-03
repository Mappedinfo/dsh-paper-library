/** Real host queue and synthetic PDF acceptance for finish / preview / locate.
 * The injected delay and lost acknowledgement are fault tests, not model mocks
 * or performance claims about physical Pencil, Sidecar, or another computer. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { core } from '../src/bridge.mjs';
import { createFetchHandler } from '../src/http.mjs';
import { createLocalStateStore } from '../src/local-state.mjs';
import { createInkQueue } from '../src/ink-queue.mjs';

const project=dirname(dirname(fileURLToPath(import.meta.url)));
await mkdir(join(project,'.local'),{recursive:true});
const run=await mkdtemp(join(project,'.local/handwriting-flow-')),library=join(run,'library'),python=join(project,'.venv/bin/python'),source=join(run,'synthetic.pdf');
const checks=[],errors=[],external=[],screenshots=[],writes=[],metrics={};
const record=name=>{checks.push(name);console.log(`PASS ${name}`);};
const hash=async path=>createHash('sha256').update(await readFile(path)).digest('hex');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const made=spawnSync(python,['-c',`import pymupdf,sys
doc=pymupdf.open()
for number in range(3):
    page=doc.new_page(width=595,height=842)
    page.insert_textbox((48,60,545,300),'Synthetic handwriting preserves its annotation while saving in the background. '*10,fontsize=12,lineheight=1.45)
    if number==1:
        annotation=page.add_highlight_annot(pymupdf.Rect(48,60,280,75));annotation.set_info(content='Second annotation for independent handwriting');annotation.update()
        doc.xref_set_key(annotation.xref,'NM',pymupdf.get_pdf_str('page-two-source'))
doc.save(sys.argv[1]);doc.close()`,source],{encoding:'utf8'});
assert.equal(made.status,0,made.stderr);
const originalHash=await hash(source);
const paper=(await core({action:'import',items:[{id:'SyntheticHandwritingFlow',title:'Synthetic handwriting reading flow',attachments:[{path:source}]}]},{library,python})).items[0];
const notes=async()=>(await core({action:'annotations',id:paper.id},{library,python})).annotations;
const localState=createLocalStateStore({library,home:join(run,'home')});
let nextFault=null,releaseHold=null,lostAcknowledgements=0,refuseAnnotationReads=0,refusedAnnotationReads=0;
const hostQueue=createInkQueue({store:localState,library,python,autoStart:false,dispatch:async(input,options)=>{
  if(input.action!=='annotate'||input.type!=='ink')return core(input,options);
  const fault=nextFault;nextFault=null;const entry={request:structuredClone(input),startedAt:Date.now(),fault:fault?.kind||null};writes.push(entry);
  if(fault?.kind==='delay')await delay(2000);
  if(fault?.kind==='hold')await new Promise(resolve=>{releaseHold=resolve;});
  const result=await core(input,options);entry.committedAt=Date.now();
  if(fault?.kind==='lose-ack'){lostAcknowledgements++;throw new Error('Synthetic acknowledgement lost after PDF commit');}
  return result;
}});
const handle=createFetchHandler({library,python,localState,inkQueue:hostQueue});
const server=createServer(async(req,res)=>{try{
  const request=new Request(`http://${req.headers.host}${req.url}`,{method:req.method,headers:req.headers,...(!['GET','HEAD'].includes(req.method)?{body:Readable.toWeb(req),duplex:'half'}:{})});
  const input=req.method==='POST'&&req.url.endsWith('/api')?await request.clone().json():null;
  if(input?.action==='annotations'&&refuseAnnotationReads>0){refuseAnnotationReads--;refusedAnnotationReads++;res.writeHead(503,{'Content-Type':'application/json'});res.end(JSON.stringify({ok:false,error:'Synthetic temporary annotation read failure'}));return;}
  const response=await handle(request);res.writeHead(response.status,Object.fromEntries(response.headers));if(response.body)Readable.fromWeb(response.body).pipe(res);else res.end();
}catch(error){res.writeHead(500);res.end(`Fixture: ${error.message}`);}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${server.address().port}`;
const until=async(fn,message)=>{const start=Date.now();while(Date.now()-start<20000){const value=await fn();if(value)return value;await delay(70);}throw new Error(message);};
const hostJobs=async()=>(await hostQueue.list({id:paper.id})).jobs;
let browser,context,page,cdp,parent,failure,environment,events=[];
try{
  const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');browser=await chromium.launch({headless:true});environment={browser:browser.version(),node:process.version,platform:process.platform,architecture:process.arch,viewport:{width:1280,height:1100},headless:true};
  context=await browser.newContext({viewport:{width:1280,height:1100},hasTouch:true});
  await context.addInitScript(()=>{
    window.handwritingFlowEvents=[];window.handwritingFinishFrames=[];
    document.addEventListener('pointerdown',event=>{if(event.target.closest?.('#continuous-reader'))window.handwritingFlowEvents.push({type:event.pointerType,trusted:event.isTrusted});},true);
    document.addEventListener('click',event=>{if(!event.target.closest?.('#linked-handwriting-finish'))return;const start=performance.now(),parent=linkedHandwritingUI?.session()?.parentId,selector=`.annotation-card[data-annotation-id="${parent}"] .ink-preview-svg`,before=Number(document.querySelector(selector)?.getAttribute('data-stroke-count')||0),added=pdfReader?.getInkDraft()?.paths.length||0;requestAnimationFrame(()=>window.handwritingFinishFrames.push({elapsed:performance.now()-start,tool:readingShell?.tool().type,sessionHidden:document.getElementById('linked-handwriting-session')?.hidden,previewCount:document.querySelectorAll('.ink-preview-svg').length,parentPreviewStrokes:Number(document.querySelector(selector)?.getAttribute('data-stroke-count')||0),expectedStrokes:before+added,queue:inkQueue?.records().map(j=>({id:j.annotation_id,status:j.status}))}));},true);
  });
  async function newPage(){page=await context.newPage();page.setDefaultTimeout(20000);page.on('pageerror',error=>errors.push(error.stack||error.message));page.on('dialog',dialog=>dialog.type()==='beforeunload'?dialog.accept():dialog.dismiss());page.on('request',request=>{if(/^https?:/.test(request.url())&&new URL(request.url()).origin!==origin)external.push(request.url());});cdp=await context.newCDPSession(page);}
  await newPage();
  const ready=async(number=1)=>page.waitForFunction(value=>{const sheet=document.querySelector(`.pdr-sheet[data-pdf-page="${value}"]`),image=sheet?.querySelector('.pdr-page-image');return image?.complete&&image.naturalWidth>0&&sheet.querySelectorAll('.pdr-word').length>0&&!autoMarkupBusy&&!pdfReader.getSnapshot().inFlightPage;},number);
  const open=async()=>{await page.goto(origin);await page.waitForLoadState('networkidle');await page.waitForFunction(()=>initializedReader&&!restoringReader);if(!await page.evaluate(id=>readerStateReady&&state.active?.id===id,paper.id))await page.locator(`.paper-card[data-id="${paper.id}"]`).click();await page.waitForFunction(id=>readerStateReady&&state.active?.id===id,paper.id);await page.locator('#reading-sidebar-annotations').click();};
  const card=id=>page.locator(`.annotation-card[data-annotation-id="${id}"]`);
  const toggle=id=>card(id).locator('[data-note-action="handwriting"]');
  const active=async(id,value)=>page.waitForFunction(({id,value})=>document.querySelector(`.annotation-card[data-annotation-id="${id}"] [data-note-action="handwriting"]`)?.getAttribute('aria-pressed')===String(value),{id,value});
  const pen=(type,point)=>cdp.send('Input.dispatchMouseEvent',{type,...point,pointerType:'pen',button:type==='mouseMoved'?'none':'left',buttons:type==='mouseReleased'?0:1,clickCount:type==='mouseMoved'?0:1,force:type==='mouseReleased'?0:.6});
  const points=async(values,number=1)=>{const box=await page.locator(`.pdr-sheet[data-pdf-page="${number}"]`).boundingBox();assert.ok(box?.width>0);return values.map(([x,y])=>({x:box.x+x/595*box.width,y:box.y+y/842*box.height}));};
  const draw=async(values,number=1)=>{const positions=await points(values,number);await pen('mousePressed',positions[0]);for(const p of positions.slice(1))await pen('mouseMoved',p);await pen('mouseReleased',positions.at(-1));};
  const go=async(number)=>{await page.evaluate(number=>pdfReader.goTo(number),number);await ready(number);};
  const paths=async(n)=>page.waitForFunction(n=>pdfReader.getInkDraft()?.paths.length===n,n);
  const reply=type=>{const value=page.waitForResponse(response=>{try{const input=response.request().postDataJSON();return input.action==='annotate'&&input.type===type&&response.status()!==429;}catch{return false;}});value.catch(()=>{});return value;};
  const markup=async(first,last)=>{const range=await page.evaluate(({first,last})=>{const words=document.querySelectorAll('.pdr-sheet[data-pdf-page="1"] .pdr-word'),a=words[first].getBoundingClientRect(),b=words[last].getBoundingClientRect();return {from:{x:a.left+2,y:a.top+a.height/2},to:{x:b.right-2,y:b.top+b.height/2}};},{first,last});await pen('mousePressed',range.from);for(let n=1;n<=12;n++)await pen('mouseMoved',{x:range.from.x+(range.to.x-range.from.x)*n/12,y:range.from.y+(range.to.y-range.from.y)*n/12});await pen('mouseReleased',range.to);};
  const settled=async id=>{await until(async()=>{const jobs=await hostJobs();return jobs.find(j=>j.annotation_id===id&&j.status==='saved');},`save ${id} did not finish`);await page.evaluate(()=>inkQueue.refresh());await page.waitForFunction(id=>inkQueue.records().find(j=>j.annotation_id===id)?.status==='saved',id);};
  const shot=async name=>{const path=join(run,`${name}.png`);await page.screenshot({path});screenshots.push(relative(project,path));};
  await open();await go(1);await page.locator('#reader-mode-auto').click();await page.locator('#reader-tool-highlight').click();
  let response=reply('highlight');await markup(0,4);let result=await response;assert.equal(result.status(),200);parent=(await result.json()).result.annotation;await card(parent.id).waitFor();record('trusted pen creates the parent highlight on a synthetic PDF');

  await page.locator('#reader-tool-underline').click();await toggle(parent.id).click();await active(parent.id,true);await ready();nextFault={kind:'delay'};
  await draw([[55,245],[95,232],[125,260]]);await draw([[335,455],[360,475],[395,450]]);await paths(2);
  await page.locator('#linked-handwriting-finish').click();await active(parent.id,false);
  const immediate=await page.evaluate(()=>({tool:readingShell.tool().type,jobs:inkQueue.records(),draft:pdfReader.getInkDraft(),frames:window.handwritingFinishFrames}));
  assert.equal(immediate.tool,'underline');assert.equal(immediate.draft,null);assert.equal(immediate.jobs.length,1);assert.notEqual(immediate.jobs[0].status,'saved');
  const firstId=immediate.jobs[0].annotation_id;await card(parent.id).locator('.ink-preview-svg').waitFor();assert.equal(await card(parent.id).locator('.ink-preview-svg').getAttribute('data-stroke-count'),'2');
  await page.waitForFunction(()=>window.handwritingFinishFrames.length>0);metrics.finish_first_paint=await page.evaluate(()=>window.handwritingFinishFrames[0]);assert.equal(metrics.finish_first_paint.tool,'underline');assert.equal(metrics.finish_first_paint.sessionHidden,true);assert.equal(metrics.finish_first_paint.parentPreviewStrokes,metrics.finish_first_paint.expectedStrokes);assert.ok(metrics.finish_first_paint.previewCount>0);assert.ok(metrics.finish_first_paint.elapsed<500,JSON.stringify(metrics.finish_first_paint));
  assert.equal(writes[0]?.committedAt,undefined);record('finish restores the previous tool and paints pending preview before a deliberately delayed PDF write');
  await go(1);response=reply('underline');await markup(6,8);result=await response;assert.equal(result.status(),200);assert.equal((await result.json()).result.annotation.type,'underline');record('normal text markup works while the host saves frozen handwriting');
  await until(async()=>!(await page.evaluate(()=>inkQueue.blocked())),'host staging was not acknowledged');
  await toggle('page-two-source').click();await active('page-two-source',true);await ready(2);await draw([[75,245],[100,275],[125,242]],2);await paths(1);await page.locator('#linked-handwriting-finish').click();await active('page-two-source',false);
  const frozen=await page.evaluate(()=>inkQueue.records());assert.equal(frozen.find(j=>j.annotation_id===firstId).parentId,parent.id);assert.equal(frozen.find(j=>j.annotation_id===firstId).paths.length,2);const second=frozen.find(j=>j.parentId==='page-two-source');assert.ok(second);assert.equal(second.paths.length,1);assert.equal(second.page,2);
  await settled(firstId);await settled(second.annotation_id);assert.ok(writes[0].committedAt-writes[0].startedAt>=2000);metrics.injected_write_ms=writes[0].committedAt-writes[0].startedAt;
  await until(async()=>await card(parent.id).locator('.ink-preview-svg').getAttribute('data-stroke-count')==='2','saved preview duplicated pending geometry');record('new annotation strokes retain their own parent and page while saved identities prevent preview duplication');

  await go(3);const returnBefore=await page.locator('#continuous-reader').evaluate(node=>({top:node.scrollTop,left:node.scrollLeft}));
  await card(parent.id).locator('.linked-ink-preview').click();await page.locator('.pdr-annotation-flash[data-focus-kind="ink"]').first().waitFor();await ready(1);
  const focus=await page.locator('.pdr-annotation-flash').evaluateAll(nodes=>nodes.map(node=>({top:parseFloat(node.style.top),left:parseFloat(node.style.left),kind:node.dataset.focusKind,page:node.closest('.pdr-sheet').dataset.pdfPage})));
  assert.equal(focus.length,2);assert.ok(focus.every(v=>v.kind==='ink'&&v.page==='1'));assert.ok(Math.abs(focus[0].top-focus[1].top)>10);record('preview navigation focuses actual handwriting regions on a previously offscreen page');
  await page.locator('#reader-return-position').click();const returned=await page.locator('#continuous-reader').evaluate(node=>({top:node.scrollTop,left:node.scrollLeft}));assert.ok(Math.abs(returned.top-returnBefore.top)<3,JSON.stringify({returnBefore,returned}));record('return restores the prior PDF reading position');
  await card(parent.id).locator('[data-note-action="page"]').first().click();await page.locator('.pdr-annotation-flash[data-focus-kind="quote"]').first().waitFor();const quoteTop=await page.locator('.pdr-annotation-flash').first().evaluate(node=>parseFloat(node.style.top));assert.ok(quoteTop<15);record('original quote action uses the source highlight rather than handwriting bounds');
  const regions=card(parent.id).locator('.linked-ink-regions [data-note-action="linked-ink"]');assert.equal(await regions.count(),2);
  await regions.nth(1).click();await page.waitForFunction(()=>document.querySelectorAll('.pdr-annotation-flash[data-focus-kind="ink"]').length===1);const regionTop=await page.locator('.pdr-annotation-flash').evaluate(node=>parseFloat(node.style.top));assert.ok(regionTop>45);const focusStarted=Date.now();await page.waitForFunction(()=>{const node=document.querySelector('.pdr-annotation-flash[data-focus-kind="ink"]');return node&&Number(getComputedStyle(node).opacity)>=.9;});await shot('handwriting-region-focused');await page.locator('.pdr-annotation-flash').waitFor({state:'hidden'});metrics.focus_lifetime_observed_ms=Date.now()-focusStarted;assert.ok(metrics.focus_lifetime_observed_ms>=1300&&metrics.focus_lifetime_observed_ms<3000);record('spatial region selector focuses only its own strokes and the transient outline clears');
  await regions.first().click();await page.locator('.pdr-annotation-flash').waitFor();await page.locator('#continuous-reader').hover();await page.mouse.wheel(0,80);await page.locator('.pdr-annotation-flash').waitFor({state:'hidden'});record('manual scrolling cancels temporary focus without changing PDF annotations');

  await go(1);await toggle(parent.id).click();await active(parent.id,true);await ready();nextFault={kind:'hold'};await draw([[170,245],[195,268],[225,242]]);await page.locator('#linked-handwriting-finish').click();await active(parent.id,false);
  await until(()=>releaseHold,'host background write never started');const held=(await hostJobs()).find(j=>j.status==='writing');assert.ok(held);events.push(...await page.evaluate(()=>window.handwritingFlowEvents));await page.reload();await page.waitForFunction(()=>initializedReader&&!restoringReader);await page.evaluate(()=>inkQueue.refresh());assert.equal(await page.evaluate(id=>inkQueue.records().find(j=>j.annotation_id===id)?.status,held.annotation_id),'writing');record('reload recovers a host-acknowledged pending batch without creating a second identity');
  await page.close();releaseHold();releaseHold=null;await until(async()=>(await hostJobs()).find(j=>j.annotation_id===held.annotation_id)?.status==='saved','host job depended on the closed browser page');await newPage();await open();await go(1);await page.evaluate(()=>inkQueue.refresh());await card(parent.id).locator('.ink-preview-svg').waitFor();assert.equal(await card(parent.id).locator('.ink-preview-svg').getAttribute('data-stroke-count'),'3');assert.equal(writes.filter(w=>w.request.annotation_id===held.annotation_id).length,1);record('host finishes acknowledged handwriting after the browser page is destroyed');

  const priorTool=await page.evaluate(()=>readingShell.tool().type);await toggle(parent.id).click();await active(parent.id,true);await ready();nextFault={kind:'lose-ack'};await draw([[245,240],[265,265],[280,240]]);await page.locator('#linked-handwriting-finish').click();await active(parent.id,false);
  const uncertain=await until(async()=>(await hostJobs()).find(j=>j.status==='uncertain'),'lost acknowledgement did not remain recoverable');assert.equal(lostAcknowledgements,1);await page.evaluate(()=>inkQueue.refresh());await card(parent.id).locator('[data-note-action="ink-retry"]').waitFor();assert.equal(await page.evaluate(()=>readingShell.tool().type),priorTool);assert.equal((await notes()).find(n=>n.id===parent.id).linked_ink.annotations.length,3);
  await page.reload();await page.waitForFunction(()=>initializedReader&&!restoringReader);await open();await go(1);await page.evaluate(()=>inkQueue.refresh());assert.equal(await card(parent.id).locator('.ink-preview-svg').getAttribute('data-stroke-count'),'4');
  await card(parent.id).locator(`[data-note-action="ink-retry"][data-ink-id="${uncertain.annotation_id}"]`).click();await settled(uncertain.annotation_id);const attempts=writes.filter(w=>w.request.annotation_id===uncertain.annotation_id);assert.equal(attempts.length,2);assert.deepEqual(attempts[0].request,attempts[1].request);assert.equal((await notes()).find(n=>n.id===parent.id).linked_ink.annotations.length,3);assert.equal(await card(parent.id).locator('.ink-preview-svg').getAttribute('data-stroke-count'),'4');record('lost PDF acknowledgement survives reload and retries the same immutable identity without duplicate ink');

  await go(1);await toggle(parent.id).click();await active(parent.id,true);nextFault={kind:'hold'};await draw([[300,270],[325,292],[345,268]]);await page.locator('#linked-handwriting-finish').click();await active(parent.id,false);await until(()=>releaseHold,'raster test write never started');const background=(await hostJobs()).find(j=>j.status==='writing');assert.ok(background);
  await until(async()=>!(await page.evaluate(()=>inkQueue.blocked())),'raster test staging not acknowledged');await toggle(parent.id).click();await active(parent.id,true);await ready();
  const liveImage=await page.locator('.pdr-sheet[data-pdf-page="1"] .pdr-page-image').elementHandle(),gesture=await points([[365,268],[385,288],[405,268]]);
  await pen('mousePressed',gesture[0]);await pen('mouseMoved',gesture[1]);assert.equal(await page.evaluate(()=>pdfReader.isInking()),true);
  const refreshedNotes=page.waitForResponse(response=>{try{return response.request().postDataJSON().action==='annotations'&&response.status()===200;}catch{return false;}});refreshedNotes.catch(()=>{});
  releaseHold();releaseHold=null;await settled(background.annotation_id);await refreshedNotes;await page.waitForTimeout(250);
  assert.equal(await page.evaluate(()=>pdfReader.isInking()),true);assert.equal(await liveImage.evaluate(node=>node.isConnected&&document.querySelector('.pdr-sheet[data-pdf-page="1"] .pdr-page-image')===node),true);
  await pen('mouseMoved',gesture[2]);await pen('mouseReleased',gesture[2]);await paths(1);const uninterrupted=await page.evaluate(()=>pdfReader.getInkDraft());assert.ok(Math.abs(uninterrupted.paths[0].at(-1)[0]-405)<1);const knownIds=new Set((await hostJobs()).map(j=>j.annotation_id));await page.locator('#linked-handwriting-finish').click();await active(parent.id,false);const continued=await until(async()=>(await hostJobs()).find(j=>!knownIds.has(j.annotation_id)),'continued stroke was not staged');await settled(continued.annotation_id);record('same-page background save keeps the current raster and does not interrupt an active pen stroke');

  const samples=[];
  for(let i=0;i<10;i++){
    await go(1);await toggle(parent.id).click();await active(parent.id,true);await ready();await draw([[55+i*4,325],[73+i*4,337],[90+i*4,325]]);await paths(1);
    const prior=await page.evaluate(()=>({frames:window.handwritingFinishFrames.length,ids:inkQueue.records().map(j=>j.annotation_id)}));await page.locator('#linked-handwriting-finish').click();await active(parent.id,false);await page.waitForFunction(count=>window.handwritingFinishFrames.length>count,prior.frames);
    const sample=await page.evaluate(index=>window.handwritingFinishFrames[index],prior.frames);assert.equal(sample.sessionHidden,true);assert.notEqual(sample.tool,'ink');assert.equal(sample.parentPreviewStrokes,sample.expectedStrokes);assert.ok(sample.previewCount>0);samples.push(sample.elapsed);
    const batch=await page.evaluate(ids=>inkQueue.records().find(j=>!ids.includes(j.annotation_id)),prior.ids);assert.ok(batch);await settled(batch.annotation_id);
  }
  const sorted=[...samples].sort((a,b)=>a-b);metrics.finish_warm_page={samples_ms:samples,count:samples.length,p50_ms:sorted[Math.ceil(samples.length*.5)-1],p95_ms:sorted[Math.ceil(samples.length*.95)-1],max_ms:sorted.at(-1),definition:'Trusted click on Finish to the next requestAnimationFrame with restored tool, hidden session and visible preview; same loaded PDF page, ten real saves.'};record('ten warm-page finishes restore the tool and preview at the next measured paint');

  const exported=await core({action:'export_pdf',id:paper.id},{library,python}),freshLibrary=join(run,'reimport-library');
  const imported=(await core({action:'import',items:[{id:'ReopenedHandwritingFlow',title:'Reopened synthetic handwriting flow',attachments:[{path:exported.path}]}]},{library:freshLibrary,python})).items[0];
  const recovered=(await core({action:'annotations',id:imported.id},{library:freshLibrary,python})).annotations;assert.deepEqual(recovered.find(n=>n.id===parent.id).linked_ink,(await notes()).find(n=>n.id===parent.id).linked_ink);assert.equal(recovered.find(n=>n.id==='page-two-source').linked_ink.annotations.length,1);record('fresh PDF import recovers every saved stroke and its parent without queue state');
  await page.waitForLoadState('networkidle');const railBefore={cards:await page.locator('#annotation-list > .annotation-card').count(),strokes:await card(parent.id).locator('.ink-preview-svg').getAttribute('data-stroke-count')};refuseAnnotationReads=1;assert.equal(await page.evaluate(id=>loadAnnotations(id),paper.id),false);assert.equal(refusedAnnotationReads,1);assert.equal(await page.locator('#annotation-list > .annotation-card').count(),railBefore.cards);assert.equal(await card(parent.id).locator('.ink-preview-svg').getAttribute('data-stroke-count'),railBefore.strokes);assert.equal(await toggle(parent.id).isVisible(),true);await shot('handwriting-flow-read-error');assert.equal(await page.evaluate(id=>loadAnnotations(id),paper.id),true);await page.locator('#toast').waitFor({state:'hidden'});record('temporary annotation-read failure preserves existing cards and ink preview until a successful refresh');
  await page.setViewportSize({width:1280,height:600});await card(parent.id).locator('.annotation-quote').scrollIntoViewIfNeeded();await page.evaluate(()=>renderAnnotations());
  const offscreen=card('page-two-source').locator('.linked-ink-preview'),offscreenBox=await offscreen.boundingBox();assert.ok(offscreenBox.y>=600,JSON.stringify(offscreenBox));assert.equal(await offscreen.locator('svg').count(),0);await offscreen.scrollIntoViewIfNeeded();await offscreen.locator('svg').waitFor();assert.equal(await offscreen.locator('svg').getAttribute('data-stroke-count'),'1');await page.setViewportSize({width:1280,height:1100});await card(parent.id).locator('.annotation-quote').scrollIntoViewIfNeeded();await go(1);record('offscreen cards defer SVG generation until their preview enters the viewport');
  await shot('handwriting-flow-saved');await page.setViewportSize({width:600,height:960});await go(1);await card(parent.id).locator('.linked-ink-preview').scrollIntoViewIfNeeded();
  const hit=await card(parent.id).locator('.linked-ink-preview').evaluate(node=>{const b=node.getBoundingClientRect();return {height:b.height,left:b.left,right:b.right,visible:node.contains(document.elementFromPoint(b.left+b.width/2,b.top+b.height/2)),overflow:document.documentElement.scrollWidth>innerWidth};});assert.ok(hit.height>=44&&hit.visible&&!hit.overflow&&hit.left>=0&&hit.right<=600,JSON.stringify(hit));
  const quoteLayout=async()=>card(parent.id).locator('.annotation-quote').evaluate(node=>{const style=getComputedStyle(node),luminance=color=>{const rgb=color.match(/[\d.]+/g).slice(0,3).map(Number).map(value=>{const n=value/255;return n<=.04045?n/12.92:((n+.055)/1.055)**2.4;});return .2126*rgb[0]+.7152*rgb[1]+.0722*rgb[2];},a=luminance(style.color),b=luminance(style.backgroundColor);return {scrollWidth:node.scrollWidth,clientWidth:node.clientWidth,whiteSpace:style.whiteSpace,contrast:(Math.max(a,b)+.05)/(Math.min(a,b)+.05)};});
  metrics.quote_light=await quoteLayout();assert.ok(metrics.quote_light.scrollWidth<=metrics.quote_light.clientWidth+1&&metrics.quote_light.whiteSpace!=='nowrap'&&metrics.quote_light.contrast>=4.5,JSON.stringify(metrics.quote_light));await shot('handwriting-flow-narrow');await page.emulateMedia({colorScheme:'dark'});await page.waitForFunction(()=>document.documentElement.dataset.theme==='dark');metrics.quote_dark=await quoteLayout();assert.ok(metrics.quote_dark.scrollWidth<=metrics.quote_dark.clientWidth+1&&metrics.quote_dark.contrast>=4.5,JSON.stringify(metrics.quote_dark));await shot('handwriting-flow-narrow-dark');record('narrow light and dark layouts keep quote text wrapped and readable with a reachable handwriting preview');
  events.push(...await page.evaluate(()=>window.handwritingFlowEvents));assert.ok(events.some(e=>e.type==='pen'&&e.trusted));assert.equal(await hash(source),originalHash);assert.deepEqual(errors,[]);assert.deepEqual(external,[]);record('original file remains unchanged with trusted pen input and no browser errors or external requests');
}catch(error){failure=error;if(page&&!page.isClosed()){await page.screenshot({path:join(run,'failure.png')}).catch(()=>{});await writeFile(join(run,'failure-state.json'),JSON.stringify(await page.evaluate(()=>({session:linkedHandwritingUI?.session(),draft:pdfReader?.getInkDraft(),queue:inkQueue?.records(),body:document.body.innerText})).catch(()=>null),null,2));}}
finally{releaseHold?.();await browser?.close();await hostQueue.dispose();await new Promise(resolve=>server.close(resolve));}
const receipt={verified_at:new Date().toISOString(),complete:!failure,scope:'Synthetic PDF with real native annotation writes, host durable queue and trusted Chromium pen input.',environment,checks,metrics,browser_errors:errors,external_requests:external.length,real_provider_calls:0,screenshots,lost_acknowledgements:lostAcknowledgements,refused_annotation_reads:refusedAnnotationReads,native_write_attempts:writes.length,limitations:['No physical Pencil, iPadOS, Sidecar, Safari or Electron was exercised.','The 2-second PDF write delay and lost acknowledgement are deliberately injected. Warm-page p95 uses ten headless-browser samples on this machine; it is not a general production performance guarantee. Pen-motion frame latency was not measured.','Recovery covers completed batches acknowledged by host storage; an unacknowledged or incomplete pen stroke is outside this guarantee.'],...(failure?{error:failure.stack,writes}:{})};
await writeFile(join(run,'receipt.json'),JSON.stringify(receipt,null,2)+'\n');if(failure){console.error(`Handwriting flow diagnostics: ${relative(project,run)}`);throw failure;}
await writeFile(join(project,'docs/validation/handwriting-flow-browser.json'),JSON.stringify(receipt,null,2)+'\n');console.log(JSON.stringify({run:relative(project,run),checks:checks.length,errors}));
