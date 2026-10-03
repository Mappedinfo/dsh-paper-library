/** Synthetic PDF + actual Chromium pen events, real worker/storage and bounded
 * recognition service with a deterministic model double. No private documents,
 * real provider requests or device-quality claims. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { core, dispatch } from '../src/bridge.mjs';
import { createFetchHandler } from '../src/http.mjs';
import { createLocalStateStore } from '../src/local-state.mjs';
import { createHandwriting } from '../src/harness/handwriting.mjs';
const project = dirname(dirname(fileURLToPath(import.meta.url)));
await mkdir(join(project, '.local'), { recursive: true });
const run = await mkdtemp(join(project, '.local/handwriting-browser-')), library = join(run, 'library'), python = join(project, '.venv/bin/python'), source = join(run, 'synthetic.pdf');
const made = spawnSync(python, ['-c', `import pymupdf,sys
doc=pymupdf.open(); page=doc.new_page(width=595,height=842)
page.insert_textbox((48,60,540,300), 'Synthetic handwriting notes stay attached to standard text annotations. '*8, fontsize=12)
note=page.add_text_annot((500,350),'External note survives'); note.update()
doc.xref_set_key(note.xref,'NM',pymupdf.get_pdf_str('阅读批注/1'))
doc.save(sys.argv[1]); doc.close()`, source], { encoding: 'utf8' });
assert.equal(made.status, 0, made.stderr);
const hash = async path => createHash('sha256').update(await readFile(path)).digest('hex'), originalHash = await hash(source);
const paper = (await core({ action: 'import', items: [{ id: 'SyntheticHandwriting', title: 'Synthetic handwritten notes', attachments: [{ path: source }] }] }, { library, python })).items[0];
const parent = (await core({ action: 'annotate', id: paper.id, page: 1, type: 'highlight', text: 'Synthetic handwriting notes', rects: [[48,60,220,77]], comment: '', author: 'Synthetic reader' }, { library, python })).annotation;
// Existing attachment notes remain editable through the legacy-note entry.
for(const annotation_id of [parent.id,'阅读批注/1'])await core({action:'handwriting_save',id:paper.id,annotation_id,board:{width:640,height:360,strokes:[]},transcript:'',transcription_source:'none',expected_version:null,request_id:randomUUID()},{library,python});
const localState = createLocalStateStore({ library, home: join(run, 'home') });
let modelCalls = 0, failModel = false, rejectDraftWrites = false, rejectedDraftWrites = 0;
const handwriting = createHandwriting({ store: localState, dispatch, library, python,
  paperChat: async () => ({ sessionId: 'synthetic-session', model: { provider: 'fixture', model: 'fixture-vision' } }),
  ai: async request => { modelCalls++; assert.ok(request.images?.[0]?.data?.startsWith('iVBOR')); if (failModel) throw new Error('Synthetic recognition unavailable'); return '需要核对这个假设'; },
});
const handle = createFetchHandler({ library, python, localState, handwriting });
const server = createServer(async (req, res) => {
  try { const request = new Request(`http://${req.headers.host}${req.url}`, { method: req.method, headers: req.headers, ...(!['GET','HEAD'].includes(req.method) ? { body: Readable.toWeb(req), duplex: 'half' } : {}) });
    if (rejectDraftWrites && req.method === 'POST' && req.url.endsWith('/api')) { const value = await request.clone().json(); if (value.action === 'state_put' && value.key?.startsWith('reader:handwriting:')) { rejectedDraftWrites++; res.writeHead(503,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:'Synthetic draft storage unavailable'})); return; } }
    const response = await handle(request); res.writeHead(response.status, Object.fromEntries(response.headers)); if (response.body) Readable.fromWeb(response.body).pipe(res); else res.end(); }
  catch { res.writeHead(500); res.end('fixture error'); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`, checks = [], errors = [], external = [], screenshots = [];
const record = name => { checks.push(name); console.log(`PASS ${name}`); };
let browser, page, failure;
try {
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright'); browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 1100 }, hasTouch: true }); page = await context.newPage(); page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message)); page.on('dialog', dialog => dialog.type()==='beforeunload'?dialog.accept():dialog.dismiss()); page.on('request', request => { if (/^https?:/.test(request.url()) && new URL(request.url()).origin !== origin) external.push(request.url()); });
  const cdp = await context.newCDPSession(page);
  const card = () => page.locator(`.annotation-card[data-annotation-id="${parent.id}"]`);
  const note = async () => (await core({ action: 'handwriting_get', id: paper.id, annotation_id: parent.id }, { library, python })).note;
  const waitIdle = () => page.waitForFunction(() => document.getElementById('handwriting-dialog').getAttribute('aria-busy') === 'false');
  async function open() {
    await page.goto(origin); await page.waitForFunction(() => typeof initializedReader !== 'undefined' && initializedReader && !restoringReader);
    if (!await page.evaluate(id => state.active?.id === id && readerStateReady, paper.id)) await page.locator(`[data-id="${paper.id}"].paper-card`).click();
    await page.waitForFunction(id => state.active?.id === id && readerStateReady, paper.id); await page.locator('#reading-sidebar-annotations').click();
    await card().locator('[data-note-action=handwriting-legacy]').click(); await waitIdle();
  }
  async function stroke(points, options = {}) {
    const box = await page.locator('#handwriting-canvas').boundingBox(), mapped = points.map(([x,y]) => ({ x: box.x + x / 640 * box.width, y: box.y + y / 360 * box.height }));
    const send = (type, point) => cdp.send('Input.dispatchMouseEvent', { type, ...point, pointerType: options.mouse ? 'mouse' : 'pen', button: type === 'mouseReleased' ? 'left' : 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: type === 'mousePressed' ? 1 : 0, force: type === 'mouseReleased' ? 0 : .5 });
    await send('mousePressed', mapped[0]); for (const point of mapped.slice(1)) await send('mouseMoved', point); await send('mouseReleased', mapped.at(-1));
  }
  const count = async n => page.waitForFunction(expected => document.querySelectorAll('#handwriting-canvas polyline').length === expected, n);
  await open(); await stroke([[60,55],[60,90],[60,125]]); await stroke([[60,90],[105,90]]); await stroke([[105,55],[105,90],[105,125]]); await count(3);
  record('legacy attachment editor preserves pen input on an existing note');
  await page.locator('#handwriting-undo').click(); await count(2); await page.locator('#handwriting-redo').click(); await count(3);
  await page.locator('#handwriting-eraser').click(); await stroke([[57,60],[60,65]]); await count(2); await page.locator('#handwriting-undo').click(); await count(3); await page.locator('#handwriting-pen').click();
  record('stroke eraser undo and redo retain original paths');
  const box = await page.locator('#handwriting-canvas').boundingBox(); await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:box.x+200,y:box.y+80}]}); await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]}); await count(3);
  record('touch does not create handwriting');
  await page.locator('#handwriting-save').click(); await waitIdle();
  assert.equal((await note()).board.strokes.length,3); assert.equal((await note()).transcript,'需要核对这个假设'); assert.equal((await note()).transcription_source,'model'); assert.equal(modelCalls,1);
  record('save preserves native attachment first then automatically stores distinct recognition text');
  await page.screenshot({path:join(run,'handwriting-recognized.png')}); screenshots.push('handwriting-recognized.png');
  await page.locator('#handwriting-transcript').fill('校对后的想法，保留手绘图'); await page.locator('#handwriting-save').click(); await waitIdle(); assert.equal((await note()).transcription_source,'edited'); assert.equal(modelCalls,1);
  record('manual correction saves without another model call or replacing original strokes');
  await page.locator('#handwriting-close').click(); assert.equal(await card().locator('.annotation-handwriting').count(),1); assert.equal(await page.locator('.annotation-card').count(),2); await card().locator('[data-note-action=handwriting-legacy]').click(); await waitIdle();
  await stroke([[180,60],[220,90],[180,120]],{mouse:true}); await count(4); await page.locator('#handwriting-close').click();
  await open(); await count(4); assert.equal(await page.locator('#handwriting-transcript').inputValue(),'校对后的想法，保留手绘图');
  record('host draft restores unsaved mouse-fallback strokes after reload');
  let lost=false;
  await page.route('**/api',async route=>{const request=route.request().postDataJSON();if(request.action==='handwriting_save'&&!lost){lost=true;await route.fetch();await route.fulfill({status:502,contentType:'application/json',body:JSON.stringify({ok:false,error:'Synthetic lost acknowledgement'})});}else await route.continue();});
  await page.locator('#handwriting-save').click(); await waitIdle(); assert.equal(await page.locator('#handwriting-save').textContent(),'重试保存'); assert.equal(await page.locator('#handwriting-pen').isDisabled(),true);
  await page.unroute('**/api'); await page.locator('#handwriting-save').click(); await waitIdle(); assert.equal((await note()).board.strokes.length,4);
  const all=(await core({action:'annotations',id:paper.id},{library,python})).annotations; assert.equal(all.filter(a=>a.kind==='handwriting-note'&&a.parent_id===parent.id).length,1);
  record('lost save acknowledgement locks draft and exact retry creates no duplicate attachment');
  failModel=true; await page.locator('#handwriting-recognize').click(); await waitIdle(); assert.match(await page.locator('#handwriting-status').textContent(),/转文字未完成/); assert.equal((await note()).transcript,'校对后的想法，保留手绘图'); assert.equal((await note()).board.strokes.length,4);
  record('recognition failure preserves saved handwriting and corrected text');
  failModel=false; await page.locator('#handwriting-recognize').click(); await waitIdle(); assert.equal((await note()).transcript,'需要核对这个假设');
  record('explicit recognition retry recovers after a definite model failure');
  rejectDraftWrites=true;
  await stroke([[280,70],[290,85],[300,70]]); await count(5);
  const handed = await page.evaluate(() => handwritingUI.handoff()); assert.equal(handed.board.strokes.length,5);
  await page.reload(); await open(); await count(4); assert.ok(rejectedDraftWrites>0); rejectDraftWrites=false;
  await page.evaluate(async value => { await handwritingUI.close(); await applyReaderSnapshot({paperId:state.active.id,page:state.page,tab:'annotations',handwritingDraft:value}); }, handed); await waitIdle(); await count(5);
  record('parent handoff restores final strokes when host draft write never reached storage');
  await page.keyboard.press('Control+k'); assert.equal(await page.locator('#handwriting-dialog').isVisible(),true);
  record('library shortcut cannot bypass the open handwriting editor');
  await page.locator('#handwriting-close').click();
  // The new Save-and-handwrite path is covered by linked-handwriting-browser-fixture.
  await page.locator('.annotation-card[data-annotation-id="阅读批注/1"] [data-note-action=handwriting-legacy]').click(); await waitIdle(); await stroke([[80,80],[130,120]]); await page.locator('#handwriting-save').click(); await waitIdle();
  assert.equal((await core({action:'handwriting_get',id:paper.id,annotation_id:'阅读批注/1'},{library,python})).note.board.strokes.length,1); await page.locator('#handwriting-close').click();
  record('external Unicode annotation identities retain working draft and PDF saves');
  await card().locator('[data-note-action=handwriting-legacy]').click(); await waitIdle(); await page.setViewportSize({width:600,height:960}); await page.emulateMedia({colorScheme:'dark'});
  // Background colors transition for 120ms while foreground text updates at
  // once. Inspect settled contrast, not a misleading intermediate screenshot.
  await page.waitForFunction(() => {
    if (document.documentElement.dataset.theme !== 'dark' || document.getElementById('handwriting-dialog').getAnimations({subtree:true}).some(animation => animation.playState === 'running')) return false;
    const luminance = color => { const values = color.match(/[\d.]+/g).slice(0,3).map(Number).map(value => { const n = value/255; return n <= .04045 ? n/12.92 : ((n+.055)/1.055)**2.4; }); return .2126*values[0]+.7152*values[1]+.0722*values[2]; };
    return ['handwriting-pen','handwriting-eraser','handwriting-save','handwriting-export'].every(id => { const style = getComputedStyle(document.getElementById(id)), a=luminance(style.color), b=luminance(style.backgroundColor); return (Math.max(a,b)+.05)/(Math.min(a,b)+.05)>=4.5; });
  });
  await page.screenshot({path:join(run,'handwriting-narrow-dark.png')}); screenshots.push('handwriting-narrow-dark.png');
  assert.ok(await page.locator('#handwriting-canvas').isVisible()); assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  record('miniature board remains usable at narrow width and in dark theme');
  await page.locator('#handwriting-close').click();await page.setViewportSize({width:1280,height:1100});
  await card().locator('[data-note-action=handwriting]').click();
  await page.waitForFunction(()=>pdfReader.getInkContext()?.parentId);
  // A viewport change queues ResizeObserver and raster work; draw only after
  // that real reader transition settles, as in the dedicated pointer fixture.
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  await page.waitForFunction(()=>!pdfReader.getSnapshot().inFlightPage&&document.querySelector('.pdr-page-image')?.complete);
  async function inlineStroke(){const bounds=await page.locator('.pdr-sheet[data-pdf-page="1"]').boundingBox();assert.ok(bounds);await cdp.send('Input.dispatchMouseEvent',{type:'mousePressed',x:bounds.x+80,y:bounds.y+210,pointerType:'pen',button:'left',buttons:1,clickCount:1,force:.5});await cdp.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:bounds.x+130,y:bounds.y+240,pointerType:'pen',button:'left',buttons:1,force:.5});await cdp.send('Input.dispatchMouseEvent',{type:'mouseReleased',x:bounds.x+170,y:bounds.y+210,pointerType:'pen',button:'left',buttons:0});}
  await inlineStroke();assert.equal(await page.evaluate(()=>pdfReader.getInkDraft()?.paths.length),1);const callsBeforeInline=modelCalls;await card().locator('[data-note-action=handwriting]').click();
  await page.waitForFunction(id=>state.annotations.find(n=>n.id===id)?.linked_ink?.transcript==='需要核对这个假设',parent.id);
  assert.equal(modelCalls,callsBeforeInline+1);assert.equal(await page.locator('#handwriting-dialog').isVisible(),false);
  record('inline PDF handwriting exit automatically recognizes linked strokes without opening a board');
  await card().locator('.linked-handwriting-summary summary').click();let correction=card().locator('[aria-label="校对手写识别文字"]');await correction.fill('校对关联文字');
  await page.evaluate(()=>loadAnnotations(state.active.id));await card().locator('.linked-handwriting-summary summary').click();await page.waitForFunction(()=>document.querySelector('[aria-label="校对手写识别文字"]')?.value==='校对关联文字');
  record('unsaved linked transcription correction survives annotation refresh');
  let correctionLost=false;await page.route('**/api',async route=>{const request=route.request().postDataJSON();if(request.action==='linked_handwriting_text'&&request.transcription_source==='edited'&&!correctionLost){correctionLost=true;await route.fetch();await route.fulfill({status:502,contentType:'application/json',body:JSON.stringify({ok:false,error:'Synthetic correction lost acknowledgement'})});}else await route.continue();});
  await card().getByRole('button',{name:'保存校对',exact:true}).click();await card().getByRole('button',{name:'重试保存校对',exact:true}).waitFor();assert.equal(await correction.isDisabled(),true);
  await page.unroute('**/api');await card().getByRole('button',{name:'重试保存校对',exact:true}).click();await page.waitForFunction(id=>state.annotations.find(n=>n.id===id)?.linked_ink?.transcription_source==='edited',parent.id);
  assert.equal(modelCalls,callsBeforeInline+1);assert.equal((await note()).board.strokes.length,4);
  record('lost correction acknowledgement retries exact text without another model call or changing legacy strokes');
  await card().locator('.linked-handwriting-summary summary').click();await correction.fill('冲突后仍保留的校对');
  await core({action:'annotate',id:paper.id,page:1,type:'ink',parent_id:parent.id,annotation_id:randomUUID(),paths:[[[200,350],[240,380]]],width:2,color:'#2455a4',author:'Concurrent synthetic reader'},{library,python});
  await card().getByRole('button',{name:'保存校对',exact:true}).click();await card().getByRole('button',{name:'读取新版本并保留校对',exact:true}).waitFor();assert.equal(await correction.inputValue(),'冲突后仍保留的校对');assert.equal(await correction.isDisabled(),false);
  await card().getByRole('button',{name:'读取新版本并保留校对',exact:true}).click();await card().getByRole('button',{name:'保存校对',exact:true}).click();await page.waitForFunction(id=>state.annotations.find(n=>n.id===id)?.linked_ink?.transcript==='冲突后仍保留的校对',parent.id);
  record('definite transcript version conflict preserves editable text and explicit rebase saves against current strokes');
  await card().locator('.linked-handwriting-summary summary').click();await correction.fill('保存中不能被新卡片丢弃');
  let releaseCorrection;const correctionGate=new Promise(resolve=>{releaseCorrection=resolve;});let correctionInFlight=false;
  await page.route('**/api',async route=>{const request=route.request().postDataJSON();if(request.action==='linked_handwriting_text'&&request.transcription_source==='edited'){const response=await route.fetch();correctionInFlight=true;await correctionGate;await route.fulfill({response});}else await route.continue();});
  await card().getByRole('button',{name:'保存校对',exact:true}).click();for(let i=0;i<100&&!correctionInFlight;i++)await new Promise(resolve=>setTimeout(resolve,30));assert.ok(correctionInFlight);
  await page.evaluate(()=>loadAnnotations(state.active.id));await card().locator('.linked-handwriting-summary summary').click();await page.waitForFunction(()=>document.querySelector('[aria-label="校对手写识别文字"]')?.value==='保存中不能被新卡片丢弃');assert.equal(await correction.isDisabled(),true);assert.equal(await card().getByRole('button',{name:'放弃校对草稿',exact:true}).isDisabled(),true);
  releaseCorrection();await page.waitForFunction(()=>![...document.querySelectorAll('.linked-handwriting-summary button')].some(button=>button.textContent.includes('正在保存校对')));await page.unroute('**/api');
  record('in-flight correction remains locked across card rerender and cannot discard a newer draft');
  assert.equal(await hash(source),originalHash); assert.equal(errors.length,0,errors.join('\n')); assert.deepEqual(external,[]);
  record('original unchanged with no browser errors or external requests');
} catch(error){failure=error;if(page)await page.screenshot({path:join(run,'failure.png')}).catch(()=>{});}
finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
const receipt={verified_at:new Date().toISOString(),scope:'Synthetic native PDF handwriting attachments, Chromium pen/mouse and deterministic recognition; excludes real model quality and physical Pencil/Sidecar',checks:checks.map(id=>({id,status:'pass'})),browser_errors:errors,external_requests:external.length,model_calls:modelCalls,real_provider_calls:0,screenshots:screenshots.map(path=>`${relative(project,run)}/${path}`),...(failure?{error:failure.message}:{})};
await writeFile(join(run,'receipt.json'),JSON.stringify(receipt,null,2)+'\n');
if(failure)throw failure;
await writeFile(join(project,'docs/validation/handwriting-browser.json'),JSON.stringify(receipt,null,2)+'\n');
console.log(JSON.stringify({checks:checks.length,run:relative(project,run),model_calls:modelCalls}));
