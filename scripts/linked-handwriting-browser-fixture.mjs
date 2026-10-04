/** Inline linked handwriting acceptance with a real synthetic PDF backend and
 * trusted Chromium pen/mouse/touch input. No real model, private document or
 * physical Pencil/Sidecar claim. Run with PLAYWRIGHT_MODULE when not installed. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { core } from '../src/bridge.mjs';
import { createFetchHandler } from '../src/http.mjs';
import { createLocalStateStore } from '../src/local-state.mjs';

const project = dirname(dirname(fileURLToPath(import.meta.url)));
await mkdir(join(project, '.local'), { recursive: true });
const run = await mkdtemp(join(project, '.local/linked-handwriting-'));
const library = join(run, 'library'), python = join(project, '.venv/bin/python'), source = join(run, 'synthetic.pdf');
const checks = [], errors = [], external = [], screenshots = [], inkWrites = [], layoutSamples = {wide:[],narrow:[]};
const record = name => { checks.push(name); console.log(`PASS ${name}`); };
const hash = async path => createHash('sha256').update(await readFile(path)).digest('hex');
const until = async (read, message) => { const start=Date.now();while(Date.now()-start<20000){const value=await read();if(value)return value;await new Promise(resolve=>setTimeout(resolve,80));}throw new Error(message); };
const generated = spawnSync(python, ['-c', `import pymupdf,sys
doc=pymupdf.open()
for number in range(2):
    page=doc.new_page(width=595,height=842)
    page.insert_textbox((48,60,545,300),'Synthetic linked handwriting keeps the reader close to the selected text. '*9,fontsize=12,lineheight=1.45)
    if not number:
        note=page.add_text_annot((490,380),'External note with a legacy handwritten attachment'); note.update()
        doc.xref_set_key(note.xref,'NM',pymupdf.get_pdf_str('legacy-source'))
doc.save(sys.argv[1]); doc.close()`, source], { encoding: 'utf8' });
assert.equal(generated.status, 0, generated.stderr);
const originalHash = await hash(source);
const paper = (await core({ action: 'import', items: [{ id: 'SyntheticLinkedHandwriting', title: 'Synthetic inline handwriting', attachments: [{ path: source }] }] }, { library, python })).items[0];
const notes = async () => (await core({ action: 'annotations', id: paper.id }, { library, python })).annotations;
const legacyBoard = { width: 640, height: 360, strokes: [{ color: '#2455a4', width: 2, points: [[40,40],[80,100],[130,45]] }] };
const legacy = (await core({ action: 'handwriting_save', id: paper.id, annotation_id: 'legacy-source', board: legacyBoard, transcript: 'Preserved earlier note', transcription_source: 'edited', expected_version: null, request_id: randomUUID() }, { library, python })).note;
const localState = createLocalStateStore({ library, home: join(run, 'home') });
const handle = createFetchHandler({ library, python, localState });
let fault = null, lostAcks = 0, refused = 0, holdNextEnqueue = false, releaseEnqueue = null;
const server = createServer(async (req, res) => {
  try {
    const request = new Request(`http://${req.headers.host}${req.url}`, { method: req.method, headers: req.headers, ...(!['GET','HEAD'].includes(req.method) ? { body: Readable.toWeb(req), duplex: 'half' } : {}) });
    const input = req.method === 'POST' && req.url.endsWith('/api') ? await request.clone().json() : null;
    const linked = input?.action === 'ink_queue_enqueue' && input.batch?.parentId;
    if (linked) { const batch=input.batch;inkWrites.push({action:'annotate',id:batch.paperId,parent_id:batch.parentId,page:batch.page,type:'ink',annotation_id:batch.annotation_id,paths:structuredClone(batch.paths),width:batch.width,color:batch.color}); }
    if (linked && holdNextEnqueue) { holdNextEnqueue=false; await new Promise(resolve=>{releaseEnqueue=resolve;}); }
    if (linked && fault === 'refuse') { refused++; res.writeHead(503, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok:false,error:'Synthetic save temporarily unavailable' })); return; }
    const response = await handle(request);
    if (linked && fault === 'lose-ack' && response.status === 200) { fault = null; lostAcks++; await response.arrayBuffer(); res.writeHead(502, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok:false,error:'Synthetic save acknowledgement lost' })); return; }
    res.writeHead(response.status, Object.fromEntries(response.headers)); if (response.body) Readable.fromWeb(response.body).pipe(res); else res.end();
  } catch (error) { res.writeHead(500); res.end(`Fixture: ${error.message}`); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser, page, parent, failure, events = [];
try {
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width:1280, height:1100 }, hasTouch:true });
  page = await context.newPage(); page.setDefaultTimeout(20000);
  page.on('pageerror', error => errors.push(error.stack || error.message));
  page.on('dialog', dialog => dialog.type() === 'beforeunload' ? dialog.accept() : dialog.dismiss());
  page.on('request', request => { if (/^https?:/.test(request.url()) && new URL(request.url()).origin !== origin) external.push(request.url()); });
  await page.addInitScript(() => {
    window.linkedHandwritingEvents = [];
    document.addEventListener('pointerdown', event => { if (event.target.closest?.('#continuous-reader')) window.linkedHandwritingEvents.push({ type:event.pointerType,trusted:event.isTrusted }); }, true);
  });
  const cdp = await context.newCDPSession(page);
  const ready = async (number = 1) => page.waitForFunction(value => {
    const sheet = document.querySelector(`.pdr-sheet[data-pdf-page="${value}"]`), image = sheet?.querySelector('.pdr-page-image');
    return image?.complete && image.naturalWidth > 0 && sheet.querySelectorAll('.pdr-word').length > 0 && !autoMarkupBusy && !pdfReader.getSnapshot().inFlightPage;
  }, number);
  const card = () => page.locator(`.annotation-card[data-annotation-id="${parent.id}"]`);
  const toggle = () => card().locator('[data-note-action="handwriting"]');
  const active = async value => page.waitForFunction(({id,value})=>document.querySelector(`.annotation-card[data-annotation-id="${id}"] [data-note-action="handwriting"]`)?.getAttribute('aria-pressed')===String(value),{id:parent.id,value});
  const linked = async () => (await notes()).find(note => note.id === parent.id)?.linked_ink;
  const linkedCount = async () => (await linked())?.annotations?.length || 0;
  const pathCount = async expected => page.waitForFunction(value => document.querySelectorAll('#continuous-reader .pdr-ink-draft polyline').length === value, expected);
  const pen = (type, point) => cdp.send('Input.dispatchMouseEvent', { type, ...point, pointerType:'pen', button:type === 'mouseMoved' ? 'none' : 'left', buttons:type === 'mouseReleased' ? 0 : 1, clickCount:type === 'mouseMoved' ? 0 : 1, force:type === 'mouseReleased' ? 0 : .6 });
  const screenPoints = async (points, number = 1) => {
    const box = await page.locator(`.pdr-sheet[data-pdf-page="${number}"]`).boundingBox();
    assert.ok(box && box.width > 0); return points.map(([x,y]) => ({ x:box.x+x/595*box.width,y:box.y+y/842*box.height }));
  };
  const draw = async (points, pointer = 'pen', number = 1) => {
    const values = await screenPoints(points,number);
    if (pointer === 'mouse') { await page.mouse.move(values[0].x,values[0].y); await page.mouse.down(); for (const value of values.slice(1)) await page.mouse.move(value.x,value.y); await page.mouse.up(); }
    else { await pen('mousePressed',values[0]); for (const value of values.slice(1)) await pen('mouseMoved',value); await pen('mouseReleased',values.at(-1)); }
  };
  const span = async (first,last) => page.evaluate(({first,last}) => {
    const words = document.querySelectorAll('.pdr-sheet[data-pdf-page="1"] .pdr-word'), a=words[first].getBoundingClientRect(), b=words[last].getBoundingClientRect();
    return { from:{x:a.left+2,y:a.top+a.height/2},to:{x:b.right-2,y:b.top+b.height/2} };
  },{first,last});
  const dragText = async value => { await pen('mousePressed',value.from); for(let n=1;n<=12;n++)await pen('mouseMoved',{x:value.from.x+(value.to.x-value.from.x)*n/12,y:value.from.y+(value.to.y-value.from.y)*n/12}); await pen('mouseReleased',value.to); };
  const annotationReply = type => { const pending=page.waitForResponse(response => { try { const input=response.request().postDataJSON(); return (type==='ink'?input?.action==='ink_queue_enqueue':input?.action==='annotate'&&input.type===type) && response.status()!==429; } catch { return false; } }); pending.catch(()=>{}); return pending; };
  const saved = async responsePromise => { const response=await responsePromise; assert.equal(response.status(),200,await response.text()); const result=(await response.json()).result;if(result.job){const id=result.job.annotation_id;await page.waitForFunction(id=>inkQueue.records().find(job=>job.annotation_id===id)?.status==='saved',id);await page.waitForFunction(id=>state.annotations.some(note=>note.id===id),id);} await ready(); return result; };
  const shot = async name => { const path=join(run,`${name}.png`); await page.screenshot({path}); screenshots.push(relative(project,path)); };
  const target = async (locator,{fullRow=false,minHeight=44}={}) => {
    await locator.scrollIntoViewIfNeeded();
    const box=await locator.evaluate((button,{fullRow,minHeight})=>{
      const rect=button.getBoundingClientRect(),parent=button.parentElement.getBoundingClientRect(),style=getComputedStyle(button);
      const hit=[[.5,.5],[.15,.25],[.85,.75]].every(([x,y])=>button.contains(document.elementFromPoint(rect.left+rect.width*x,rect.top+rect.height*y)));
      return {height:rect.height,width:rect.width,rowWidth:parent.width,fontSize:parseFloat(style.fontSize),hit,inViewport:rect.left>=0&&rect.right<=innerWidth&&rect.top>=0&&rect.bottom<=innerHeight,fullRow,minHeight};
    },{fullRow,minHeight});
    assert.ok(box.height>=minHeight,JSON.stringify(box)); assert.ok(box.hit&&box.inViewport,JSON.stringify(box));
    if(fullRow){assert.ok(Math.abs(box.width-box.rowWidth)<=1,JSON.stringify(box));assert.ok(box.fontSize>=14,JSON.stringify(box));}
    return box;
  };
  const stableLayout = async (size, phase) => {
    const sample=await page.evaluate(()=>{
      const rect=node=>{const b=node.getBoundingClientRect();return {top:b.top,left:b.left,width:b.width,height:b.height,bottom:b.bottom,right:b.right};};
      const visible=node=>Boolean(node.getClientRects().length&&getComputedStyle(node).visibility!=='hidden');
      const bar=document.getElementById('reader-ink-draft'),reader=document.getElementById('continuous-reader');
      const buttons=[...bar.querySelectorAll('button')].filter(visible).map(button=>{const b=rect(button);return {...b,id:button.id,hit:button.contains(document.elementFromPoint(b.left+b.width/2,b.top+b.height/2))};});
      return {bar:rect(bar),reader:rect(reader),sheet:rect(document.querySelector('.pdr-sheet[data-pdf-page="1"]')),buttons,finishCount:[...bar.querySelectorAll('button')].filter(button=>visible(button)&&/^(完成手写|结束手写)$/.test(button.textContent.trim())).length,overflow:document.documentElement.scrollWidth>innerWidth};
    });
    assert.equal(sample.finishCount,1,`${size}/${phase}: only one visible Finish action in the handwriting row`);
    assert.ok(sample.bar.height>=44&&sample.bar.height<=52,`${size}/${phase}: a fixed single row ${JSON.stringify(sample.bar)}`);
    assert.ok(!sample.overflow,`${size}/${phase}: page overflow`);
    assert.ok(sample.buttons.some(button=>button.id==='reader-ink-save'));
    for(const button of sample.buttons){assert.ok(button.height>=44&&button.hit,`${size}/${phase}: ${JSON.stringify(button)}`);assert.ok(button.top>=sample.bar.top-.5&&button.bottom<=sample.bar.bottom+.5,`${size}/${phase}: button outside row`);}
    for(let i=1;i<sample.buttons.length;i++){const previous=sample.buttons[i-1],current=sample.buttons[i];assert.ok(Math.abs(previous.top+previous.height/2-current.top-current.height/2)<1,`${size}/${phase}: actions wrapped`);assert.ok(previous.right<=current.left+1,`${size}/${phase}: actions overlap`);}
    const baseline=layoutSamples[size][0];
    if(baseline)for(const [region,fields] of [['sheet',['top','width']],['reader',['top','height']],['bar',['top','height']]])for(const field of fields)assert.ok(Math.abs(sample[region][field]-baseline[region][field])<=1,`${size}/${phase}: ${region}.${field} shifted ${baseline[region][field]} -> ${sample[region][field]}`);
    layoutSamples[size].push({phase,bar:{top:sample.bar.top,height:sample.bar.height},reader:{top:sample.reader.top,height:sample.reader.height},sheet:{top:sample.sheet.top,width:sample.sheet.width},finish_count:sample.finishCount,minimum_button_height:Math.min(...sample.buttons.map(button=>button.height)),button_targets_unobstructed:sample.buttons.every(button=>button.hit),actions_single_row:true});return sample;
  };
  const open = async () => {
    events.push(...await page.evaluate(()=>window.linkedHandwritingEvents||[]).catch(()=>[]));
    await page.goto(origin); await page.waitForLoadState('networkidle'); await page.waitForFunction(()=>initializedReader&&!restoringReader);
    if(!await page.evaluate(id=>readerStateReady&&state.active?.id===id,paper.id))await page.locator(`.paper-card[data-id="${paper.id}"]`).click();
    await page.waitForFunction(id=>readerStateReady&&state.active?.id===id,paper.id); await ready(); await page.locator('#reading-sidebar-annotations').click();
  };
  await open(); await page.locator('#reader-mode-auto').click(); await page.locator('#reader-tool-highlight').click();
  const highlightReply=annotationReply('highlight'); await dragText(await span(0,4)); parent=(await saved(highlightReply)).annotation;
  assert.equal(parent.type,'highlight'); assert.ok(parent.text.includes('linked handwriting')); await card().waitFor(); record('trusted pen creates a standard text-bound highlight');
  await target(toggle(),{fullRow:true}); record('sidebar handwriting button spans its action row with an unobstructed 44-pixel target');

  await page.locator('#reader-tool-underline').click(); await toggle().click(); await active(true); await ready();
  assert.equal(await toggle().getAttribute('aria-pressed'),'true'); assert.equal(await page.locator('#handwriting-dialog').isVisible(),false);
  await target(toggle(),{fullRow:true}); await target(page.locator('#reader-ink-save')); record('active handwriting and finish controls retain unobstructed 44-pixel targets');
  await page.locator('#reader-ink-status').waitFor({state:'visible'}); record('sidebar handwriting toggle keeps PDF visible without a separate board');
  await stableLayout('wide','entered_without_strokes');
  const firstPath=[[55,270],[85,255],[115,270],[85,288],[55,270]];
  let response=annotationReply('ink');holdNextEnqueue=true;await draw(firstPath);await pathCount(1);await stableLayout('wide','first_stroke');
  await draw([[68,305],[90,320],[112,305]]);await pathCount(2);await stableLayout('wide','multiple_strokes');await shot('inline-linked-draft');
  await until(()=>releaseEnqueue,'wide autosave did not stage');await pathCount(0);await stableLayout('wide','autosave_pending');releaseEnqueue();releaseEnqueue=null;
  await saved(response);await pathCount(0);await stableLayout('wide','autosave_saved');
  assert.equal(await linkedCount(),1); assert.equal(inkWrites[0].parent_id,parent.id); assert.equal(inkWrites[0].page,parent.page);
  const firstSaved=(await linked()).annotations[0].paths[0]; for(const index of [0,firstSaved.length-1])for(let axis=0;axis<2;axis++)assert.ok(Math.abs(firstSaved[index][axis]-firstPath[index===0?0:firstPath.length-1][axis])<1);
  record('pause autosaves visible PDF circle as native ink bound to the highlight');
  const beforeOtherPage=inkWrites.length; await page.evaluate(()=>pdfReader.goTo(2)); await ready(2); await draw([[75,80],[110,105]],'pen',2); await pathCount(0); assert.equal(inkWrites.length,beforeOtherPage); await page.evaluate(()=>pdfReader.goTo(1)); await ready(); record('another page cannot acquire handwriting belonging to the selected highlight');
  const countBeforeTouch=inkWrites.length, [touchA,touchB]=await screenPoints([[180,290],[220,320]]);
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{...touchA,id:7}]}); await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{...touchB,id:7}]}); await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]}); await pathCount(0); assert.equal(inkWrites.length,countBeforeTouch); record('touch input does not create linked handwriting');
  response=annotationReply('ink'); await draw([[155,265],[175,285],[195,260]],'mouse'); await pathCount(1);await stableLayout('wide','next_stroke');record('desktop handwriting row and PDF geometry remain fixed through strokes and autosave');await toggle().click(); await saved(response); await pathCount(0);
  await active(false); assert.equal(await page.locator('#reader-tool-underline').getAttribute('aria-pressed'),'true'); assert.equal(await linkedCount(),2); record('same toggle flushes mouse-fallback strokes and restores the prior text tool');
  response=annotationReply('underline'); await dragText(await span(6,8)); const underline=(await saved(response)).annotation; assert.equal(underline.type,'underline'); assert.equal(underline.parent_id,undefined); record('normal text markup works immediately after leaving linked handwriting');

  await toggle().click(); await active(true); await ready(); fault='lose-ack'; const beforeLost=inkWrites.length; await draw([[240,275],[255,295],[275,270]]); await pathCount(1);
  await page.waitForFunction(()=>inkQueue.records().some(job=>job.status==='stage_failed')); await pathCount(0);
  assert.equal(lostAcks,1); await until(async()=>await linkedCount()===3,'accepted lost-ack batch did not complete on host'); assert.equal(inkWrites.length,beforeLost+1); const retryId=inkWrites.at(-1).annotation_id; assert.ok(retryId);
  const frozenBefore=await page.evaluate(()=>inkQueue.handoff());assert.ok(frozenBefore);await draw([[300,280],[335,300]]);await pathCount(0);assert.deepEqual(await page.evaluate(()=>inkQueue.handoff()),frozenBefore);assert.equal(await card().locator('.ink-preview-svg').getAttribute('data-stroke-count'),'4');record('unknown staging acknowledgement freezes exact linked batch and blocks unconfirmed new input');
  await page.waitForLoadState('networkidle'); await open(); await pathCount(0);
  await active(true);await page.waitForFunction(id=>!inkQueue.blocked()&&inkQueue.records().find(job=>job.annotation_id===id)?.status==='saved',retryId);
  assert.equal(await linkedCount(),3); assert.equal(inkWrites.at(-1).annotation_id,retryId); assert.equal(inkWrites.at(-1).parent_id,parent.id); record('reload reconciles original host identity and parent binding without duplicate ink');
  await page.locator('#reader-ink-save').click(); await active(false);

  await toggle().click(); await active(true); await ready(); fault='refuse'; const beforeRefusal=await linkedCount(); await draw([[330,270],[360,290],[390,270]]); await pathCount(1);
  await page.waitForFunction(()=>inkQueue.records().some(job=>job.status==='stage_failed')); await pathCount(0); assert.ok(refused>=1); assert.equal(await linkedCount(),beforeRefusal);
  const refusedBatch=await page.evaluate(()=>inkQueue.handoff());await toggle().click();await active(false);assert.deepEqual(await page.evaluate(()=>inkQueue.handoff()),refusedBatch);assert.equal(await card().locator('.ink-preview-svg').getAttribute('data-stroke-count'),'5');record('failed staging retains exact preview while finish immediately restores reading');
  fault=null;response=annotationReply('ink');await card().locator('[data-note-action="ink-retry"]').click();await saved(response);await pathCount(0);await active(false);assert.equal(await linkedCount(),4);
  record('explicit retry saves a refused batch without reopening or blocking reading');

  const legacyCard=page.locator('.annotation-card[data-annotation-id="legacy-source"]'); await legacyCard.locator('[data-note-action="handwriting-legacy"]').click();
  await page.locator('#handwriting-dialog').waitFor({state:'visible'}); await page.waitForFunction(()=>document.getElementById('handwriting-dialog').getAttribute('aria-busy')==='false');
  assert.equal(await page.locator('#handwriting-canvas polyline').count(),1); assert.equal(await page.locator('#handwriting-transcript').inputValue(),legacy.transcript); await page.locator('#handwriting-close').click();
  assert.deepEqual((await core({action:'handwriting_get',id:paper.id,annotation_id:'legacy-source'},{library,python})).note.board,legacyBoard); record('existing attachment-based note remains accessible and unchanged');
  const all=await notes(), nativeChildren=all.filter(note=>note.type==='ink'); assert.equal(nativeChildren.length,4); assert.equal(await page.locator('#annotation-list > .annotation-card').count(),all.filter(note=>!['handwriting-note','linked-handwriting','linked-handwriting-transcript'].includes(note.kind)).length);
  assert.equal(await page.locator('#annotation-list > .annotation-card').count(),3); record('linked ink belongs under its parent instead of creating independent sidebar cards');
  const exported=await core({action:'export_pdf',id:paper.id},{library,python});
  const native=spawnSync(python,['-c',`import json,pymupdf,sys
with pymupdf.open(sys.argv[1]) as doc:
    output=[]
    for page in doc:
        for a in page.annots() or []:
            if a.type[1]=='Ink':
                parent=page.load_annot(a.irt_xref) if a.irt_xref else None
                output.append({'subtype':doc.xref_get_key(a.xref,'Subtype')[1],'parent_id':parent.info.get('id') if parent else None,'paths':len(a.vertices)})
    print(json.dumps(output))`,exported.path],{encoding:'utf8'});
  assert.equal(native.status,0,native.stderr); const nativeValues=JSON.parse(native.stdout); assert.equal(nativeValues.length,4); assert.ok(nativeValues.every(value=>value.subtype==='/Ink'&&value.parent_id===parent.id&&value.paths>0));
  const freshLibrary=join(run,'fresh-library'), imported=(await core({action:'import',items:[{id:'SyntheticLinkedReopened',title:'Reopened linked PDF',attachments:[{path:exported.path}]}]},{library:freshLibrary,python})).items[0];
  const recovered=(await core({action:'annotations',id:imported.id},{library:freshLibrary,python})).annotations; assert.deepEqual(recovered.find(note=>note.id===parent.id).linked_ink,(await linked()));
  assert.equal(recovered.find(note=>note.id==='legacy-source').handwriting.transcript,legacy.transcript); record('export and fresh import recover native ink relationships and legacy attachment from PDF alone');
  await open(); assert.equal(await linkedCount(),4); assert.equal(await toggle().getAttribute('aria-pressed'),'false'); await shot('linked-handwriting-reopened'); record('confirmed linked strokes reopen in the reading page');
  await page.setViewportSize({width:600,height:960}); await ready(); await target(toggle(),{fullRow:true});
  await toggle().click(); await active(true); await ready(); await target(toggle(),{fullRow:true}); await target(page.locator('#reader-ink-save'));
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  assert.equal(await page.evaluate(()=>parseFloat(getComputedStyle(document.body).getPropertyValue('--workbench-height'))),164);
  await stableLayout('narrow','entered_without_strokes');holdNextEnqueue=true;response=annotationReply('ink');
  await draw([[45,150],[75,155]]);await pathCount(1);await stableLayout('narrow','first_stroke');
  await draw([[90,155],[105,168],[120,155]]);await pathCount(2);await stableLayout('narrow','multiple_strokes');
  await until(()=>releaseEnqueue,'narrow autosave did not stage');await pathCount(0);await stableLayout('narrow','autosave_pending');releaseEnqueue();releaseEnqueue=null;
  await saved(response);await pathCount(0);await stableLayout('narrow','autosave_saved');assert.equal(await linkedCount(),5);
  fault='refuse';await draw([[135,150],[155,165],[175,150]]);await pathCount(1);await stableLayout('narrow','next_stroke');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await page.waitForFunction(()=>inkQueue.records().some(job=>job.status==='stage_failed'));await pathCount(0);await stableLayout('narrow','autosave_failed');await target(page.locator('#reader-ink-save'));await page.locator('#ink-queue-summary').click();await target(page.locator('.ink-queue-panel').getByRole('button',{name:'重试保存'}));await page.locator('#ink-queue-summary').click();await shot('linked-handwriting-narrow-targets');
  record('600-pixel handwriting row and PDF geometry remain fixed before drawing through autosave and retry states');
  await page.emulateMedia({colorScheme:'dark'});await page.waitForFunction(()=>document.documentElement.dataset.theme==='dark'&&!document.documentElement.getAnimations({subtree:true}).some(animation=>animation.playState==='running'));
  const inactive=legacyCard.locator('[data-note-action="handwriting"]');await target(inactive,{fullRow:true});
  const contrast=await inactive.evaluate(button=>{const style=getComputedStyle(button),luminance=color=>{const rgb=color.match(/[\d.]+/g).slice(0,3).map(Number).map(value=>{const n=value/255;return n<=.04045?n/12.92:((n+.055)/1.055)**2.4;});return .2126*rgb[0]+.7152*rgb[1]+.0722*rgb[2];},a=luminance(style.color),b=luminance(style.backgroundColor);return (Math.max(a,b)+.05)/(Math.min(a,b)+.05);});assert.ok(contrast>=4.5,`Inactive handwriting contrast: ${contrast}`);
  await target(page.locator('#reader-ink-save'));await shot('linked-handwriting-narrow-dark');
  await page.locator('#reader-ink-save').click();await active(false);assert.ok(await page.evaluate(()=>inkQueue.handoff()));fault=null;
  assert.equal(await linkedCount(),5); record('600-pixel viewport keeps handwriting, finish and retained queue retry controls reachable');
  record('dark-theme inactive handwriting action preserves readable contrast and visible click targets');
  events.push(...await page.evaluate(()=>window.linkedHandwritingEvents)); for(const type of ['pen','mouse','touch'])assert.ok(events.some(event=>event.type===type&&event.trusted)); assert.equal(await hash(source),originalHash); assert.deepEqual(errors,[]); assert.deepEqual(external,[]); record('original bytes unchanged with no browser errors or external model requests');
} catch(error) { failure=error; if(page){await page.screenshot({path:join(run,'failure.png')}).catch(()=>{});await writeFile(join(run,'failure-state.json'),JSON.stringify(await page.evaluate(()=>({inkBusy:inkSaveBusy,inkUncertain:inkSaveUncertain,session:linkedHandwritingUI?.session(),draft:pdfReader?.getInkDraft(),body:document.body.innerText})).catch(()=>null),null,2));} }
finally { releaseEnqueue?.();await browser?.close(); await handle.disposeInkQueue?.(); await new Promise(resolve=>server.close(resolve)); }
const receipt={verified_at:new Date().toISOString(),complete:!failure,scope:'Synthetic Chromium inline handwriting linked to native PDF text annotations, using the real Python worker and durable host queue.',checks,layout_samples:layoutSamples,browser_errors:errors,external_requests:external.length,real_provider_calls:0,screenshots,ink_enqueue_requests:inkWrites.length,lost_staging_acknowledgements:lostAcks,refused_staging_requests:refused,trusted_pointer_types:[...new Set(events.filter(event=>event.trusted).map(event=>event.type))],limitations:['Physical Apple Pencil, Sidecar and Safari were not exercised.','Autosave staging acknowledgement is deliberately held while measuring pending-state geometry.','Reload recovery covers completed strokes acknowledged by host storage; abrupt termination of unfinished or unacknowledged writes is not guaranteed.','The final narrow-layout scenario leaves one refused staging batch recoverable in the isolated fixture library.','Fixed-width ink; no pressure or iPadOS palm rejection claim.'],...(failure?{error:failure.stack,ink_writes:inkWrites}:{})};
await writeFile(join(run,'receipt.json'),JSON.stringify(receipt,null,2)+'\n');
if(failure){console.error(`Linked handwriting diagnostics: ${relative(project,run)}`);throw failure;}
await writeFile(join(project,'docs/validation/linked-handwriting-browser.json'),JSON.stringify(receipt,null,2)+'\n');
console.log(JSON.stringify({run:relative(project,run),checks:checks.length,errors}));
