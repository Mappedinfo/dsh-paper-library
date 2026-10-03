/** Trusted Chromium input-policy checks over a synthetic PDF and real worker.
 * CDP pen/touch does not establish iPadOS27, Sidecar, Safari or hardware palm
 * rejection behavior. No private documents or external/model requests. */
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

const project=dirname(dirname(fileURLToPath(import.meta.url)));
await mkdir(join(project,'.local'),{recursive:true});
const run=await mkdtemp(join(project,'.local/pencil-touch-')),library=join(run,'library'),python=join(project,'.venv/bin/python'),source=join(run,'synthetic.pdf');
const checks=[],errors=[],external=[],screenshots=[],writes=[];
const record=name=>{checks.push(name);console.log(`PASS ${name}`);};
const hash=async path=>createHash('sha256').update(await readFile(path)).digest('hex');
const made=spawnSync(python,['-c',`import pymupdf,sys
doc=pymupdf.open()
for number in range(4):
    page=doc.new_page(width=595,height=842)
    page.insert_textbox((48,60,545,320),'Synthetic Pencil handwriting and touch navigation remain separate. '*10,fontsize=12,lineheight=1.5)
doc.save(sys.argv[1]);doc.close()`,source],{encoding:'utf8'});
assert.equal(made.status,0,made.stderr);const originalHash=await hash(source);
const paper=(await core({action:'import',items:[{id:'SyntheticPencilTouch',title:'Synthetic Pencil and touch input',attachments:[{path:source}]}]},{library,python})).items[0];
const annotations=async()=>(await core({action:'annotations',id:paper.id},{library,python})).annotations;
const handle=createFetchHandler({library,python,localState:createLocalStateStore({library,home:join(run,'home')})});
const server=createServer(async(req,res)=>{try{
  const request=new Request(`http://${req.headers.host}${req.url}`,{method:req.method,headers:req.headers,...(!['GET','HEAD'].includes(req.method)?{body:Readable.toWeb(req),duplex:'half'}:{})});
  const response=await handle(request);res.writeHead(response.status,Object.fromEntries(response.headers));if(response.body)Readable.fromWeb(response.body).pipe(res);else res.end();
}catch(error){res.writeHead(500);res.end(`Fixture: ${error.message}`);}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${server.address().port}`;
let browser,page,failure,events=[],inputInfo;
try{
  const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');browser=await chromium.launch({headless:true});
  const context=await browser.newContext({viewport:{width:1280,height:1100},hasTouch:true});page=await context.newPage();page.setDefaultTimeout(20000);
  page.on('pageerror',error=>errors.push(error.stack||error.message));page.on('dialog',dialog=>dialog.type()==='beforeunload'?dialog.accept():dialog.dismiss());
  page.on('request',request=>{if(/^https?:/.test(request.url())&&new URL(request.url()).origin!==origin)external.push(request.url());if(request.url().endsWith('/api'))try{const value=request.postDataJSON();if(value.action==='annotate')writes.push(value);}catch{}});
  await page.addInitScript(()=>{window.pencilTouchEvents=[];for(const type of ['pointerdown','pointermove','pointerup','pointercancel'])document.addEventListener(type,event=>{if(event.target.closest?.('#continuous-reader'))window.pencilTouchEvents.push({event:type,type:event.pointerType,id:event.pointerId,trusted:event.isTrusted});},true);});
  const cdp=await context.newCDPSession(page),reader=page.locator('#continuous-reader');
  const ready=async(number=1)=>page.waitForFunction(value=>{const sheet=document.querySelector(`.pdr-sheet[data-pdf-page="${value}"]`),image=sheet?.querySelector('.pdr-page-image');return image?.complete&&image.naturalWidth>0&&sheet.querySelectorAll('.pdr-word').length>0&&!autoMarkupBusy&&!pdfReader.getSnapshot().inFlightPage;},number);
  const goFirst=async()=>{await page.evaluate(()=>pdfReader.goTo(1));await ready();};
  const paths=async number=>page.waitForFunction(value=>document.querySelectorAll('.pdr-ink-draft polyline').length===value,number);
  const position=()=>reader.evaluate(root=>({top:root.scrollTop,left:root.scrollLeft}));
  const points=async values=>{const box=await page.locator('.pdr-sheet[data-pdf-page="1"]').boundingBox();return values.map(([x,y])=>({x:box.x+x/595*box.width,y:box.y+y/842*box.height}));};
  const pen=(type,point)=>cdp.send('Input.dispatchMouseEvent',{type,...point,pointerType:'pen',button:type==='mouseMoved'?'none':'left',buttons:type==='mouseReleased'?0:1,clickCount:type==='mouseMoved'?0:1,force:type==='mouseReleased'?0:.55});
  const draw=async(values,kind='pen')=>{const mapped=await points(values);if(kind==='mouse'){await page.mouse.move(mapped[0].x,mapped[0].y);await page.mouse.down();for(const point of mapped.slice(1))await page.mouse.move(point.x,point.y);await page.mouse.up();}else{await pen('mousePressed',mapped[0]);for(const point of mapped.slice(1))await pen('mouseMoved',point);await pen('mouseReleased',mapped.at(-1));}};
  const touch=async(type,point)=>cdp.send('Input.dispatchTouchEvent',{type,touchPoints:point?[{...point,id:8,radiusX:10,radiusY:10}]:[]});
  const touchDrag=async(from,to,{cancel=false}={})=>{await touch('touchStart',from);for(let step=1;step<=8;step++)await touch('touchMove',{x:from.x+(to.x-from.x)*step/8,y:from.y+(to.y-from.y)*step/8});await touch(cancel?'touchCancel':'touchEnd');};
  const reply=type=>{const pending=page.waitForResponse(response=>{try{const value=response.request().postDataJSON();return value.action==='annotate'&&value.type===type&&response.status()!==429;}catch{return false;}});pending.catch(()=>{});return pending;};
  const shot=async name=>{const path=join(run,`${name}.png`);await page.screenshot({path});screenshots.push(relative(project,path));};
  const settings=async show=>{if(await page.locator('#reader-pen-only').isVisible()!==show)await page.locator('#reader-pen-settings > summary').click();await page.locator('#reader-pen-only').waitFor({state:show?'visible':'hidden'});};
  await page.goto(origin);await page.waitForLoadState('networkidle');await page.waitForFunction(()=>initializedReader&&!restoringReader);await page.locator(`.paper-card[data-id="${paper.id}"]`).click();await ready();await page.locator('#reading-sidebar-annotations').click();await page.locator('#reader-mode-auto').click();await page.locator('#reader-tool-highlight').click();
  assert.equal(await page.locator('#reader-pen-only').isChecked(),false);
  const range=await page.evaluate(()=>{const words=document.querySelectorAll('.pdr-sheet[data-pdf-page="1"] .pdr-word'),a=words[0].getBoundingClientRect(),b=words[3].getBoundingClientRect();return {from:{x:a.left+2,y:a.top+a.height/2},to:{x:b.right-2,y:b.top+b.height/2}};});
  let response=reply('highlight');await pen('mousePressed',range.from);for(let step=1;step<=12;step++)await pen('mouseMoved',{x:range.from.x+(range.to.x-range.from.x)*step/12,y:range.from.y+(range.to.y-range.from.y)*step/12});await pen('mouseReleased',range.to);
  assert.equal((await response).status(),200);await ready();assert.equal((await annotations()).filter(note=>note.type==='highlight').length,1);record('trusted pen still creates text-bound PDF highlights');

  const rootBox=await reader.boundingBox(),beforeMarkupPan=await position(),writeCount=writes.length;
  await touchDrag({x:rootBox.x+rootBox.width*.6,y:rootBox.y+600},{x:rootBox.x+rootBox.width*.6,y:rootBox.y+300});
  assert.ok((await position()).top>beforeMarkupPan.top+150);assert.equal(writes.length,writeCount);assert.equal(await page.locator('#annotation-dialog').isVisible(),false);record('touch drag scrolls in text-markup mode without creating annotations');
  await goFirst();await page.locator('#reader-tool-ink').click();await draw([[50,280],[80,270],[105,285]]);await paths(1);
  await settings(true);assert.equal(await page.locator('#reader-input-kind').isVisible(),true);assert.match(await page.locator('#reader-input-kind').textContent(),/已识别：手写笔/);inputInfo=await page.evaluate(()=>pdfReader.getInputInfo());assert.equal(inputInfo.seenPen,true);assert.equal(inputInfo.lastType,'pen');await settings(false);record('trusted pen starts ink and reports actual received pen input');
  const inkPanBefore=await position(),draftBefore=await page.evaluate(()=>pdfReader.getInkDraft());
  await touchDrag({x:rootBox.x+rootBox.width*.65,y:rootBox.y+570},{x:rootBox.x+rootBox.width*.65,y:rootBox.y+320});
  assert.ok((await position()).top>inkPanBefore.top+120);assert.deepEqual(await page.evaluate(()=>pdfReader.getInkDraft()),draftBefore);assert.equal(writes.length,writeCount);record('touch scrolls an ink page while preserving every completed pen stroke');
  await goFirst();await page.locator('#reader-zoom-percent').fill('150');await page.locator('#reader-zoom-percent').press('Enter');await ready();
  const zoomBox=await reader.boundingBox(),beforeHorizontal=await position();await touchDrag({x:zoomBox.x+zoomBox.width*.75,y:zoomBox.y+320},{x:zoomBox.x+zoomBox.width*.45,y:zoomBox.y+320});
  assert.ok((await position()).left>beforeHorizontal.left+100);await paths(1);assert.equal(writes.length,writeCount);record('touch pans horizontally on a zoomed PDF without drawing');
  const beforeCancel=await position();await touchDrag({x:zoomBox.x+zoomBox.width*.5,y:zoomBox.y+470},{x:zoomBox.x+zoomBox.width*.5,y:zoomBox.y+370},{cancel:true});assert.ok((await position()).top>beforeCancel.top+30);
  await touchDrag({x:zoomBox.x+zoomBox.width*.5,y:zoomBox.y+470},{x:zoomBox.x+zoomBox.width*.5,y:zoomBox.y+400});await paths(1);assert.equal(writes.length,writeCount);record('cancelled touch pan releases cleanly and the next gesture remains usable');
  await page.locator('#reader-zoom-fit').click();await goFirst();

  const palmBefore=await position(),palmPoints=await points([[160,275],[190,290],[220,270]]),palmBox=await reader.boundingBox();
  await pen('mousePressed',palmPoints[0]);await pen('mouseMoved',palmPoints[1]);
  await touchDrag({x:palmBox.x+palmBox.width*.7,y:palmBox.y+480},{x:palmBox.x+palmBox.width*.7,y:palmBox.y+350});
  await pen('mouseMoved',palmPoints[2]);await pen('mouseReleased',palmPoints[2]);await paths(2);
  const palmAfter=await position();assert.ok(Math.abs(palmAfter.top-palmBefore.top)<2&&Math.abs(palmAfter.left-palmBefore.left)<2);
  const palmDraft=await page.evaluate(()=>pdfReader.getInkDraft()),lastPath=palmDraft.paths.at(-1);assert.ok(Math.abs(lastPath.at(-1)[0]-220)<1&&Math.abs(lastPath.at(-1)[1]-270)<1);record('touch during an active pen stroke neither scrolls nor interrupts the stroke');

  await settings(true);await page.locator('#reader-pen-only').check();assert.equal((await page.evaluate(()=>pdfReader.getInputInfo())).penOnly,true);await settings(false);
  await draw([[260,280],[280,300]],'mouse');await paths(2);assert.deepEqual(await page.evaluate(()=>pdfReader.getInkDraft()),palmDraft);
  assert.match(await page.locator('#page-message').textContent(),/仅用笔标注已开启/);assert.equal(await page.locator('#page-message').evaluate(node=>node.classList.contains('error')),true);
  await draw([[260,280],[280,300]],'pen');await paths(3);assert.equal(await page.locator('#page-message').evaluate(node=>node.classList.contains('error')),false);assert.doesNotMatch(await page.locator('#page-message').textContent(),/仅用笔标注已开启/);record('pen-only option refuses mouse drawing while continuing to accept a pen');
  await draw([[310,280],[320,300]],'mouse');await paths(3);assert.match(await page.locator('#page-message').textContent(),/仅用笔标注已开启/);
  await settings(true);await page.locator('#reader-pen-only').uncheck();assert.equal(await page.locator('#page-message').evaluate(node=>node.classList.contains('error')),false);assert.doesNotMatch(await page.locator('#page-message').textContent(),/仅用笔标注已开启/);await settings(false);record('policy rejection message clears after accepted pen input and after changing the setting');
  await draw([[330,280],[350,295]],'mouse');await paths(4);inputInfo=await page.evaluate(()=>pdfReader.getInputInfo());assert.equal(inputInfo.penOnly,false);assert.equal(inputInfo.lastType,'mouse');
  await settings(true);assert.match(await page.locator('#reader-input-kind').textContent(),/鼠标兼容输入/);await shot('pencil-touch-compatibility');await settings(false);record('turning pen-only off restores Sidecar-style mouse fallback');
  response=reply('ink');await page.locator('#reader-ink-save').click();assert.equal((await response).status(),200);await paths(0);await ready();
  const finalNotes=await annotations();assert.equal(finalNotes.length,2);const ink=finalNotes.find(note=>note.type==='ink');assert.equal(ink.paths.length,4);record('native PDF save contains only the four intentional strokes and one highlight');
  events.push(...await page.evaluate(()=>window.pencilTouchEvents));
  await settings(true);const preferenceSaved=page.waitForResponse(response=>{try{const body=response.request().postDataJSON();return body.action==='state_put'&&body.key==='reader:layout'&&body.value.penOnly===true&&response.status()!==429;}catch{return false;}});preferenceSaved.catch(()=>{});
  await page.locator('#reader-pen-only').check();assert.equal((await preferenceSaved).status(),200);await settings(false);await page.reload();await page.waitForFunction(()=>initializedReader&&!restoringReader);
  await page.waitForFunction(id=>readerStateReady&&state.active?.id===id&&pdfReader.getInputInfo().penOnly===true,paper.id);await ready();await paths(0);assert.equal(await page.locator('#reader-pen-only').isChecked(),true);
  assert.deepEqual((await annotations()).find(note=>note.type==='ink').paths,ink.paths);record('pen-only preference survives reload while confirmed PDF handwriting remains intact');
  await page.locator('#reading-sidebar-annotations').click();await settings(true);await page.keyboard.press('Escape');await page.locator('#reader-pen-only').waitFor({state:'hidden'});await settings(true);await page.mouse.click(3,3);await page.locator('#reader-pen-only').waitFor({state:'hidden'});record('input settings close with Escape and an outside click');
  await page.setViewportSize({width:600,height:960});await ready();await settings(true);
  const menu=await page.locator('#reader-pen-options').evaluate(panel=>{const rect=panel.getBoundingClientRect(),label=panel.querySelector('label'),button=label.getBoundingClientRect();return {left:rect.left,right:rect.right,top:rect.top,bottom:rect.bottom,width:innerWidth,height:innerHeight,labelHeight:button.height,labelHit:label.contains(document.elementFromPoint(button.left+button.width*.5,button.top+button.height*.5)),panelHit:panel.contains(document.elementFromPoint(rect.right-8,rect.bottom-8)),overflow:document.documentElement.scrollWidth>innerWidth};});
  assert.ok(menu.left>=0&&menu.right<=menu.width&&menu.top>=0&&menu.bottom<=menu.height,JSON.stringify(menu));assert.ok(menu.labelHeight>=44&&menu.labelHit&&menu.panelHit&&!menu.overflow,JSON.stringify(menu));await shot('pencil-input-settings-narrow');await settings(false);record('600-pixel input menu remains unclipped with a visible 44-pixel checkbox-label target');
  events.push(...await page.evaluate(()=>window.pencilTouchEvents));for(const type of ['pen','mouse','touch'])assert.ok(events.some(event=>event.type===type&&event.trusted));
  assert.equal(await hash(source),originalHash);assert.deepEqual(errors,[]);assert.deepEqual(external,[]);record('original PDF unchanged with trusted input and no browser errors or external requests');
}catch(error){failure=error;if(page){await page.screenshot({path:join(run,'failure.png')}).catch(()=>{});events=await page.evaluate(()=>window.pencilTouchEvents||[]).catch(()=>[]);}}
finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
const receipt={verified_at:new Date().toISOString(),complete:!failure,scope:'Synthetic PDF in Chromium using trusted CDP pen/touch and real mouse events; tests input classification, scrolling, coexistence and optional pen-only policy.',checks,browser_errors:errors,external_requests:external.length,real_provider_calls:0,annotation_requests:writes.length,trusted_pointer_types:[...new Set(events.filter(event=>event.trusted).map(event=>event.type))],input_info:inputInfo,screenshots,limitations:['No physical Apple Pencil, iPadOS27, Sidecar, Safari or Electron build was exercised.','Browser-reported pointer types are verified; this does not identify the physical device or prove operating-system palm rejection.'],...(failure?{error:failure.stack,events}:{})};
await writeFile(join(run,'receipt.json'),JSON.stringify(receipt,null,2)+'\n');if(failure){console.error(`Pencil touch diagnostics: ${relative(project,run)}`);throw failure;}
await writeFile(join(project,'docs/validation/pencil-touch-browser.json'),JSON.stringify(receipt,null,2)+'\n');console.log(JSON.stringify({run:relative(project,run),checks:checks.length,errors}));
