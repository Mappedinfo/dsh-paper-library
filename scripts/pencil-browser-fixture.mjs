/** Real Chromium Pencil/Ink interaction fixture. CDP supplies trusted pen,
 * mouse and touch events; pointercancel alone is a synthetic DOM event. The
 * isolated server and PDFs are synthetic. This does not validate Sidecar
 * hardware, Safari event delivery, pressure feel or palm rejection by iPadOS. */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { core } from '../src/bridge.mjs';

const project = dirname(dirname(fileURLToPath(import.meta.url)));
await mkdir(join(project, '.local'), { recursive: true });
const run = await mkdtemp(join(project, '.local/pencil-browser-'));
const library = join(run, 'library'), python = join(project, '.venv/bin/python');
const source = join(run, 'pencil.pdf');
const checks = [], errors = [], external = [], screenshots = [], writes = [];
const record = value => { checks.push(value); console.log(`PASS ${value}`); };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = async path => createHash('sha256').update(await readFile(path)).digest('hex');
const generated = spawnSync(python, ['-c', `
import pymupdf, sys
doc = pymupdf.open()
for rotation in (0, 90):
    page = doc.new_page(width=595, height=842)
    body = "Synthetic Pencil annotation text compares urban measurements across districts. " * 10
    page.insert_textbox((48, 60, 547, 400), body, fontsize=11, lineheight=1.5)
    if rotation == 0:
        note = page.add_text_annot((460, 450), "Synthetic external annotation must survive")
        note.set_info(title="External fixture reader")
        note.update()
    page.set_rotation(rotation)
doc.save(sys.argv[1]); doc.close()
`, source], { cwd: project, encoding: 'utf8' });
assert.equal(generated.status, 0, generated.stderr);
const originalHash = await hash(source);
const imported = await core({ action: 'import', items: [
  { id: 'SyntheticPencil', title: 'Synthetic Pencil annotations', attachments: [{ path: source }] },
  { id: 'SyntheticOtherPencil', title: 'Synthetic other document', attachments: [{ path: source }] },
] }, { library, python });
const paper = imported.items[0];
const otherPaper = imported.items[1];
const annotations = async () => (await core({ action: 'annotations', id: paper.id }, { library, python })).annotations;
const inks = async () => (await annotations()).filter(note => note.type === 'ink');

let server, browser, page, startTimer, failure;
try {
  server = spawn(process.execPath, ['src/server.mjs', '--port', '0', '--library', library], {
    cwd: project, env: { ...process.env, DSH_HOME: join(run, 'home') }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const origin = await new Promise((accept, reject) => {
    startTimer = setTimeout(() => reject(new Error('Server startup timed out')), 15000);
    server.stdout.on('data', data => { const match = data.toString().match(/http:\/\/127\.0\.0\.1:\d+/); if (match) accept(match[0]); });
    server.on('error', reject); server.on('exit', code => reject(new Error(`Server exited ${code}`)));
  });
  clearTimeout(startTimer);
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 1100 }, hasTouch: true });
  page = await context.newPage();
  page.setDefaultTimeout(12000);
  page.on('dialog', async dialog => { if (dialog.type() === 'beforeunload') await dialog.accept(); else await dialog.dismiss(); });
  page.on('pageerror', error => { errors.push(error.stack || error.message); console.error(error.stack || error.message); });
  page.on('request', request => {
    if (/^https?:/.test(request.url()) && new URL(request.url()).origin !== origin) external.push(request.url());
    if (request.url().endsWith('/api')) { try { const value = request.postDataJSON(); if (value?.action === 'ink_queue_enqueue') writes.push(value.batch); } catch {} }
  });
  await page.addInitScript(() => {
    window.pencilFixtureEvents = [];
    for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'lostpointercapture', 'pointerleave']) document.addEventListener(type, event => {
      if (event.target.closest?.('#continuous-reader')) window.pencilFixtureEvents.push({ type, pointerType: event.pointerType, pointerId: event.pointerId, trusted: event.isTrusted, pressure: event.pressure });
    }, true);
  });
  const cdp = await context.newCDPSession(page);
  const sheet = number => page.locator(`#continuous-reader .pdr-sheet[data-pdf-page="${number}"]`);
  const draftPaths = () => page.locator('#continuous-reader .pdr-ink-draft polyline');
  const pathCount = async count => page.waitForFunction(expected => document.querySelectorAll('#continuous-reader .pdr-ink-draft polyline').length === expected, count);
  const pick = async color => page.locator('#reader-color').evaluate((input, value) => { input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })); }, color);
  const ready = async number => {
    await sheet(number).locator('img.pdr-page-image').waitFor();
    await page.waitForFunction(value => {
      const image = document.querySelector(`#continuous-reader .pdr-sheet[data-pdf-page="${value}"] img.pdr-page-image`);
      return image?.complete && image.naturalWidth > 0;
    }, number);
  };
  const showPage = async number => {
    await page.evaluate(value => { const input = document.getElementById('page-number'); input.value = String(value); input.dispatchEvent(new Event('change', { bubbles: true })); }, number);
    await page.waitForLoadState('networkidle'); await ready(number);
  };
  const choosePaper = async id => {
    // Network-idle can occur between the asynchronous reader-state restore and
    // its next render. Wait for that existing lifecycle boundary before a real
    // click, otherwise the restored sidebar can hide the card mid-click.
    await page.waitForFunction(() => typeof initializedReader !== 'undefined' && initializedReader && !restoringReader);
    if (await page.evaluate(value => readerStateReady && state.active?.id === value && !workbenchUI?.isTable(), id)) return;
    const card = page.locator(`#paper-list .paper-card[data-id="${id}"]`);
    if (!await card.isVisible()) await page.locator('#reading-sidebar-library').click();
    await card.click();
    await page.waitForFunction(value => readerStateReady && !restoringReader && state.active?.id === value, id);
    await page.waitForLoadState('networkidle');
  };
  const showAnnotationTools = async () => {
    if (!await page.locator('#reader-tool-ink').isVisible()) await page.locator('#reading-sidebar-annotations').click();
    await page.locator('#reader-tool-ink').waitFor({ state: 'visible' });
  };
  const open = async () => {
    await page.goto(origin); await page.waitForLoadState('networkidle');
    await choosePaper(paper.id);
    await ready(1); await showAnnotationTools();
    await page.locator('#reader-tool-ink').waitFor({ state: 'visible' });
  };
  // Point conversion uses the rendered PDF sheet, independently of the reader's
  // conversion. Comparing the saved native Ink vertices tests the entire path.
  const screenPoints = async (points, number = 1) => {
    const box = await sheet(number).boundingBox();
    const [width, height] = number === 2 ? [842, 595] : [595, 842];
    return points.map(([x, y]) => ({ x: box.x + x / width * box.width, y: box.y + y / height * box.height }));
  };
  const penEvent = (type, point) => cdp.send('Input.dispatchMouseEvent', {
    type, x: point.x, y: point.y, button: type === 'mouseMoved' ? 'none' : 'left',
    buttons: type === 'mouseReleased' ? 0 : 1, clickCount: type === 'mouseMoved' ? 0 : 1,
    pointerType: 'pen', force: type === 'mouseReleased' ? 0 : .6, tiltX: 15, tiltY: -5,
  });
  const draw = async (points, { number = 1, pointer = 'pen' } = {}) => {
    const screen = await screenPoints(points, number);
    if (pointer === 'mouse') {
      await page.mouse.move(screen[0].x, screen[0].y); await page.mouse.down();
      for (const point of screen.slice(1)) await page.mouse.move(point.x, point.y);
      await page.mouse.up();
    } else {
      await penEvent('mousePressed', screen[0]);
      for (const point of screen.slice(1)) await penEvent('mouseMoved', point);
      await penEvent('mouseReleased', screen.at(-1));
    }
    await pause(60);
  };
  const save = async () => {
    const response = page.waitForResponse(response => {
      try { const request = response.request().postDataJSON(); return request?.action === 'ink_queue_enqueue' && response.status() !== 429; } catch { return false; }
    });
    await page.locator('#reader-ink-save').click();
    const completed = await response; assert.equal(completed.status(), 200, await completed.text());
    const accepted = (await completed.json()).result.job;
    await page.waitForFunction(id => inkQueue?.records().some(job=>job.annotation_id===id&&job.status==='saved'),accepted.annotation_id);
    await page.locator('#reader-ink-draft').waitFor({ state: 'hidden' });
    await page.waitForLoadState('networkidle');
    await ready(Number(await page.locator('#page-number').inputValue()));
  };
  const compareEndpoints = (actual, expected, label) => {
    assert.ok(Array.isArray(actual) && actual.length >= 2, `${label}: native Ink has a path`);
    for (const [index, target] of [[0, expected[0]], [actual.length - 1, expected.at(-1)]]) {
      assert.ok(Math.abs(actual[index][0] - target[0]) < 1 && Math.abs(actual[index][1] - target[1]) < 1,
        `${label}: expected ${target}, received ${actual[index]}`);
    }
  };
  const shot = async name => { const path = join(run, `${name}.png`); await page.screenshot({ path }); screenshots.push(relative(project, path)); };

  await open();
  await page.locator('#reader-tool-ink').click();
  await page.locator('#reader-ink-width').selectOption('2');
  const color = '#b52d36'; await pick(color);
  assert.equal(await page.locator('#reader-tool-ink').getAttribute('aria-pressed'), 'true');
  const first = [[55, 72], [80, 75], [110, 69], [145, 73]];
  await draw(first); await pathCount(1);
  assert.equal(await page.locator('#annotation-dialog').isVisible(), false);
  assert.equal(await page.evaluate(() => window.getSelection().toString()), '');
  assert.equal(writes.length, 0, 'Writing remains a draft until explicit save');
  const penEvents = await page.evaluate(() => window.pencilFixtureEvents.filter(event => event.pointerType === 'pen'));
  assert.ok(penEvents.some(event => event.type === 'pointerdown' && event.trusted && event.pressure > 0), 'Chromium delivered a trusted pen pointerdown with pressure');
  assert.ok(penEvents.some(event => event.type === 'pointermove' && event.trusted), 'Chromium delivered trusted pen movement');
  record('trusted-pen-draws-over-text-without-selecting-text-opening-a-note-or-autosaving');

  const beforeTouch = await draftPaths().first().getAttribute('points');
  const touch = await screenPoints([[200, 180], [220, 200]]);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...touch[0], radiusX: 12, radiusY: 12, force: .8, id: 1 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ ...touch[1], radiusX: 12, radiusY: 12, force: .8, id: 1 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await pathCount(1); assert.equal(await draftPaths().first().getAttribute('points'), beforeTouch);
  assert.ok(await page.evaluate(() => window.pencilFixtureEvents.some(event => event.pointerType === 'touch' && event.trusted)), 'The ignored touch came from Chromium input');
  record('trusted-touch-does-not-add-or-change-ink');

  const second = [[70, 120], [90, 135], [125, 115]];
  await draw(second); await pathCount(2);
  await page.locator('#reader-ink-undo').click(); await pathCount(1);
  assert.equal(await draftPaths().first().getAttribute('points'), beforeTouch, 'Undo preserves the preceding stroke');
  await draw(second); await pathCount(2);
  const mouse = [[60, 170], [90, 165], [135, 175]];
  await draw(mouse, { pointer: 'mouse' }); await pathCount(3);
  assert.ok(await page.evaluate(() => window.pencilFixtureEvents.some(event => event.pointerType === 'mouse' && event.trusted)), 'Mouse fallback uses actual browser input');
  record('multi-stroke-draft-supports-last-stroke-undo-and-trusted-mouse-fallback');

  const cancelledPoints = [[65, 220], [85, 232], [110, 225]];
  const cancel = await screenPoints(cancelledPoints);
  await penEvent('mousePressed', cancel[0]); await penEvent('mouseMoved', cancel[1]); await penEvent('mouseMoved', cancel[2]); await pathCount(4);
  await page.evaluate(() => {
    const last = window.pencilFixtureEvents.findLast(event => event.pointerType === 'pen' && event.type === 'pointerdown');
    document.getElementById('continuous-reader').dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, pointerId: last.pointerId, pointerType: 'pen' }));
  });
  await penEvent('mouseReleased', cancel[2]); await pathCount(4);
  assert.equal(await page.evaluate(() => pdfReader.isInking()), false);
  const cancelDraft = await page.evaluate(() => pdfReader.getInkDraft());
  assert.equal(cancelDraft.paths.length, 4); compareEndpoints(cancelDraft.paths[3], cancelledPoints, 'cancelled stroke');
  record('pointer-cancel-preserves-the-collected-stroke-and-finishes-the-gesture');

  const capturePoints = [[140, 220], [160, 237], [185, 220]], capture = await screenPoints(capturePoints);
  await penEvent('mousePressed', capture[0]); await penEvent('mouseMoved', capture[1]); await penEvent('mouseMoved', capture[2]);
  await page.evaluate(() => {
    const last = window.pencilFixtureEvents.findLast(event => event.pointerType === 'pen' && event.type === 'pointerdown');
    const root = document.getElementById('continuous-reader');
    if (!root.hasPointerCapture(last.pointerId)) throw new Error('Expected actual pointer capture');
    root.releasePointerCapture(last.pointerId);
  });
  await penEvent('mouseMoved', {...capture[2], x:capture[2].x+1});
  await page.waitForFunction(() => !pdfReader.isInking());
  await penEvent('mouseReleased', capture[2]); await pathCount(5);
  assert.ok(await page.evaluate(() => window.pencilFixtureEvents.some(event=>event.type==='lostpointercapture'&&event.pointerType==='pen'&&event.trusted)));
  compareEndpoints((await page.evaluate(() => pdfReader.getInkDraft())).paths[4], capturePoints, 'lost capture stroke');
  record('trusted-lost-pointer-capture-retains-collected-geometry');

  const leavePoints = [[220, 220], [240, 238], [265, 220]], leave = await screenPoints(leavePoints);
  // Simulate an environment that cannot acquire capture; the boundary event
  // itself still comes from trusted Chromium pen movement.
  await page.evaluate(() => { document.getElementById('continuous-reader').setPointerCapture = () => {}; });
  await penEvent('mousePressed', leave[0]); await penEvent('mouseMoved', leave[1]); await penEvent('mouseMoved', leave[2]);
  await penEvent('mouseMoved', {x:3,y:3}); await page.waitForFunction(() => !pdfReader.isInking());
  await penEvent('mouseReleased', {x:3,y:3});
  await page.evaluate(() => { delete document.getElementById('continuous-reader').setPointerCapture; });
  await pathCount(6); compareEndpoints((await page.evaluate(() => pdfReader.getInkDraft())).paths[5], leavePoints, 'uncaptured leave stroke');
  assert.ok(await page.evaluate(() => window.pencilFixtureEvents.some(event=>event.type==='pointerleave'&&event.pointerType==='pen'&&event.trusted)));
  record('leaving-the-reader-without-capture-retains-collected-geometry');
  const continuedPoints = [[300, 220], [325, 235], [350, 220]];
  await draw(continuedPoints); await pathCount(7);
  const preservedDraft = await page.evaluate(() => pdfReader.getInkDraft());
  assert.equal(preservedDraft.paths.length, 7);
  record('writing-continues-after-cancel-capture-loss-and-reader-leave');
  const diagnostics = await page.evaluate(async () => {
    for (let i=0;i<8;i++) await inkDiagnostics.flush();
    return api('ink_diagnostics_get');
  });
  for(const reason of ['pointercancel','lostpointercapture','pointerleave'])assert.ok(diagnostics.events.some(event=>event.event==='stroke_end'&&event.reason===reason&&event.strokes>0&&event.points>0),`Missing preserved-stroke diagnostic: ${reason}`);
  await page.locator('#reader-pen-settings > summary').click();
  const downloaded=page.waitForEvent('download');await page.locator('#reader-ink-diagnostics').click();
  const file=await downloaded,diagnosticPath=join(run,'handwriting-diagnostics.json');await file.saveAs(diagnosticPath);
  const diagnosticExport=JSON.parse(await readFile(diagnosticPath,'utf8'));
  assert.ok(diagnosticExport.host.events.length>0&&diagnosticExport.client.events.length>0);
  const allowed=new Set(['event','client','time','receivedAt','paperId','annotationId','page','strokes','points','revision','count','reason','status','pointerType']);
  for(const event of [...diagnosticExport.host.events,...diagnosticExport.client.events])for(const [key,value] of Object.entries(event)){assert.ok(allowed.has(key));assert.ok(!Array.isArray(value)&&typeof value!=='object');}
  assert.doesNotMatch(JSON.stringify(diagnosticExport),/Synthetic Pencil annotation text|Synthetic external annotation must survive/);
  await page.keyboard.press('Escape');
  record('handwriting-diagnostic-download-includes-host-and-client-transition-counts-without-text-or-geometry');
  await shot('multi-stroke-draft');

  await save();
  const saved = await inks(); assert.equal(saved.length, 1); assert.equal(saved[0].paths.length, 7);
  assert.equal(saved[0].width, 2);
  for (const [index, expected] of [first, second, mouse, cancelledPoints, capturePoints, leavePoints, continuedPoints].entries()) compareEndpoints(saved[0].paths[index], expected, `stroke ${index + 1}`);
  for (let stroke = 0; stroke < preservedDraft.paths.length; stroke++) {
    assert.equal(saved[0].paths[stroke].length, preservedDraft.paths[stroke].length);
    preservedDraft.paths[stroke].forEach((point, index) => point.forEach((value, axis) => assert.ok(Math.abs(value-saved[0].paths[stroke][index][axis])<.001)));
  }
  const expectedColor = color.slice(1).match(/../g).map(part => Number.parseInt(part, 16) / 255);
  assert.ok(saved[0].color.stroke.every((value, index) => Math.abs(value - expectedColor[index]) < .001));
  assert.ok((await annotations()).some(note => note.comment === 'Synthetic external annotation must survive'));
  assert.equal(await hash(source), originalHash, 'Imported source bytes are unchanged');
  record('explicit-save-writes-one-native-multi-stroke-ink-with-width-colour-and-page-coordinates');
  record('saving-preserves-external-annotations-and-the-imported-original');

  await page.locator('#reader-tool-ink').click();
  await draw([[65, 220], [100, 228]]); await pathCount(1);
  await page.locator('#reader-ink-discard').click(); await pathCount(0);
  assert.equal((await inks()).length, 1);
  record('discard-removes-only-the-unsaved-draft');

  await page.locator('#reader-ink-width').selectOption('4');
  const retryPoints = [[65, 230], [115, 235], [145, 223]];
  const persistedDraft = page.waitForResponse(response => {
    try { const request = response.request().postDataJSON(); return request?.action === 'state_put' && request.key === 'reader:ink-draft' && request.value?.draft?.paths?.length === 1; } catch { return false; }
  });
  await draw(retryPoints); await pathCount(1);
  assert.equal((await persistedDraft).status(), 200);
  await page.reload(); await page.waitForLoadState('networkidle');
  await choosePaper(paper.id); await ready(1); await showAnnotationTools();
  await pathCount(1);
  assert.equal(await page.locator('#reader-ink-draft').isVisible(), true);
  record('completed-strokes-survive-page-reload-through-host-local-draft-storage');

  await choosePaper(otherPaper.id); await ready(1); await pathCount(0);
  assert.equal(await page.locator('#reader-ink-draft').isVisible(), true, 'Origin draft actions remain available on another document');
  await page.locator('#reader-ink-return').click(); await ready(1); await pathCount(1);
  await choosePaper(otherPaper.id); await ready(1); await pathCount(0);
  record('switching-papers-retains-the-origin-draft-and-return-to-ink-restores-its-overlay');

  let rejected = 0;
  await page.route('**/api', async route => {
    const data = route.request().postDataJSON();
    if (rejected < 2 && data?.action === 'ink_queue_enqueue') {
      rejected++;
      // The first request never reaches staging. The second is durably accepted
      // and continues on the host, but its acknowledgment is lost to the reader.
      if (rejected === 2) {
        const committed = await route.fetch();
        if (committed.status() !== 200) { rejected--; await route.fulfill({response:committed}); return; }
      }
      await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({ok:false,error:'Synthetic staging unavailable; frozen ink retained.'})});
    } else await route.continue();
  });
  const originDraft=await page.evaluate(()=>pdfReader.getInkDraft());
  await page.locator('#reader-ink-save').click();
  await page.waitForFunction(()=>inkQueue?.records().some(job=>job.status==='stage_failed'));
  assert.equal(rejected,1);assert.equal((await inks()).length,1);
  assert.equal(await page.locator('#reader-ink-draft').isVisible(),false,'Completed input moves into the frozen queue');
  const frozen=await page.evaluate(()=>inkQueue.records().find(job=>job.status==='stage_failed'));
  assert.deepEqual(frozen.paths,originDraft.paths);assert.equal(frozen.paperId,paper.id);
  await choosePaper(paper.id);await ready(1);await showAnnotationTools();await page.locator('#reader-tool-ink').click();
  await draw([[65,290],[120,300]]);assert.equal(await page.evaluate(()=>pdfReader.getInkDraft()),null);
  assert.deepEqual((await page.evaluate(()=>inkQueue.records().find(job=>job.status==='stage_failed'))).paths,frozen.paths);
  await choosePaper(otherPaper.id);await ready(1);
  record('unconfirmed-staging-freezes-immutable-ink-while-reading-and-paper-switching-remain-available');
  const queueMenu=page.locator('#ink-queue-menu');
  if(!await queueMenu.evaluate(node=>node.open))await queueMenu.locator('summary').click();
  await queueMenu.locator(`[data-ink-id="${frozen.annotation_id}"]`).getByRole('button',{name:'重试保存'}).click();
  await page.waitForFunction(()=>inkQueue?.records().some(job=>job.status==='stage_failed'));
  assert.equal(rejected,2);
  for(let n=0;n<100&&(await inks()).length!==2;n++)await pause(50);
  assert.equal((await inks()).length,2,'Host writes continue after the enqueue acknowledgment is lost');
  await page.reload();await page.waitForLoadState('networkidle');await choosePaper(otherPaper.id);await ready(1);
  await page.waitForFunction(id=>!inkQueue?.blocked()&&inkQueue?.records().some(job=>job.annotation_id===id&&job.status==='saved'),frozen.annotation_id);
  const retried=await inks();assert.equal(retried.length,2);assert.equal(retried[1].width,4);
  compareEndpoints(retried[1].paths[0],retryPoints,'retried stroke');
  const attempts=writes.filter(write=>write.annotation_id===frozen.annotation_id);assert.ok(attempts.length>=2);
  assert.equal(new Set(attempts.map(write=>write.annotation_id)).size,1);
  assert.ok(attempts.every(write=>write.paperId===paper.id));
  assert.ok(attempts.every(write=>JSON.stringify(write.paths)===JSON.stringify(frozen.paths)));
  const otherNotes=(await core({action:'annotations',id:otherPaper.id},{library,python})).annotations;
  assert.equal(otherNotes.filter(note=>note.type==='ink').length,0);
  record('failed-staging-keeps-frozen-ink-and-lost-enqueue-acknowledgment-does-not-duplicate-native-ink');
  record('frozen-batch-reload-reconciles-the-original-request-and-unlocks-input-only-after-host-confirmation');
  record('staging-while-another-paper-is-active-still-writes-only-to-the-origin-pdf');
  await choosePaper(paper.id);await ready(1);await showAnnotationTools();await page.locator('#reader-tool-ink').click();

  const oldWidth = (await sheet(1).boundingBox()).width;
  await page.locator('#reader-zoom-percent').fill('150'); await page.locator('#reader-zoom-percent').press('Enter');
  await page.waitForFunction(width => document.querySelector('#continuous-reader .pdr-sheet[data-pdf-page="1"]').getBoundingClientRect().width > width * 1.4, oldWidth);
  await page.waitForLoadState('networkidle'); await ready(1); await showPage(1);
  const zoomPoints = [[55, 185], [90, 190], [140, 180]];
  await draw(zoomPoints); await pathCount(1); await shot('zoomed-draft'); await save();
  const zoomSaved = (await inks()).at(-1); compareEndpoints(zoomSaved.paths[0], zoomPoints, '150 percent stroke');
  record('zoomed-pen-stroke-saves-in-pdf-coordinates-within-one-point');

  await page.locator('#reader-tool-ink').click();
  await page.locator('#reader-zoom-fit').click(); await showPage(2);
  const rotatedPoints = [[60, 95], [95, 105], [130, 90]];
  await draw(rotatedPoints, { number: 2 }); await pathCount(1); await save();
  const rotatedSaved = (await inks()).find(note => note.page === 2);
  assert.ok(rotatedSaved); compareEndpoints(rotatedSaved.paths[0], rotatedPoints, 'rotated page stroke');
  record('rotated-page-ink-round-trips-in-the-displayed-coordinate-system');

  // A fresh catalog knows no application annotation rows: the PDF itself is
  // sufficient to recover every saved Ink path and its standard /Subtype.
  const exported = await core({ action: 'export_pdf', id: paper.id }, { library, python });
  const native = spawnSync(python, ['-c', `
import json, pymupdf, sys
with pymupdf.open(sys.argv[1]) as doc:
    values = []
    for page in doc:
        for annot in page.annots() or []:
            if annot.type[1] == 'Ink':
                values.append({'type': doc.xref_get_key(annot.xref, 'Subtype')[1], 'paths': len(annot.vertices), 'width': annot.border['width']})
    print(json.dumps(values))
`, exported.path], { cwd: project, encoding: 'utf8' });
  assert.equal(native.status, 0, native.stderr);
  const objects = JSON.parse(native.stdout); assert.equal(objects.length, 4);
  assert.ok(objects.every(value => value.type === '/Ink'));
  const freshLibrary = join(run, 'fresh-library');
  const fresh = await core({ action: 'import', items: [{ id: 'SyntheticPencilFresh', title: 'Synthetic Pencil reopened PDF', attachments: [{ path: exported.path }] }] }, { library: freshLibrary, python });
  const recovered = (await core({ action: 'annotations', id: fresh.items[0].id }, { library: freshLibrary, python })).annotations.filter(note => note.type === 'ink');
  assert.equal(recovered.length, 4); assert.deepEqual(recovered.map(note => note.paths), (await inks()).map(note => note.paths));
  record('exported-pdf-has-standard-ink-objects-and-a-fresh-catalog-recovers-all-paths');

  await page.reload(); await page.waitForLoadState('networkidle');
  await choosePaper(paper.id);
  await ready(1); await showAnnotationTools(); await showPage(1);
  await page.waitForFunction(() => document.querySelectorAll('#annotation-list .annotation-card').length >= 5);
  await page.locator('#reader-tool-select').click();
  const words = await page.evaluate(() => {
    const nodes = [...document.querySelectorAll('#continuous-reader .pdr-sheet[data-pdf-page="1"] .pdr-word')];
    const first = nodes[0].getBoundingClientRect(), last = nodes[2].getBoundingClientRect();
    return { from: { x: first.left + 2, y: first.top + first.height / 2 }, to: { x: last.right - 2, y: last.top + last.height / 2 } };
  });
  await page.mouse.move(words.from.x, words.from.y); await page.mouse.down(); await page.mouse.move(words.to.x, words.to.y, { steps: 12 }); await page.mouse.up();
  await page.waitForFunction(() => document.getElementById('selection-preview')?.textContent.includes('Synthetic'));
  await page.locator('#reader-tool-note').click();
  const [notePoint] = await screenPoints([[240, 280]]); await page.mouse.click(notePoint.x, notePoint.y);
  await page.locator('#annotation-dialog').waitFor({ state: 'visible' });
  await page.locator('#annotation-form .dialog-close').first().click();
  assert.equal((await inks()).length, 4);
  await shot('reopened-ink-and-existing-tools');
  record('reload-recovers-ink-and-existing-text-selection-and-note-tools-still-work');
  assert.deepEqual(errors, []); assert.deepEqual(external, []);
  record('no-browser-runtime-errors-model-calls-or-external-requests');
} catch (error) {
  failure = error;
  if (page) { try { const path = join(run, 'failure.png'); await page.screenshot({ path }); screenshots.push(relative(project, path)); } catch {} }
} finally {
  clearTimeout(startTimer);
  if (browser) await browser.close();
  if (server) server.kill();
}
const receipt = {
  verified_at: new Date().toISOString(), complete: !failure,
  scope: 'Synthetic standalone UI in real Chromium: trusted CDP pen and touch, real mouse input, explicit multi-stroke drafts, native PDF Ink persistence, original preservation, retry, zoom, rotation, fresh catalog recovery and existing tools.',
  limitations: ['No physical Apple Pencil, iPad, Sidecar or Safari session was exercised.', 'Pointer cancellation uses a synthetic DOM event; capture unavailability is simulated for the trusted pointerleave case. Other tested input events are trusted Chromium input.', 'Fixed PDF stroke widths; no pressure-sensitive rendering or hardware palm-rejection claim.', 'Acknowledged host-staged batches survive reader replacement and continue on the host; unfinished strokes or drafts lost before staging/handoff confirmation are not guaranteed to survive abrupt termination.'],
  checks, errors, externalRequests: external.length, modelRequests: 0, screenshots,
  ...(failure ? { failure: failure.stack } : {}),
};
await writeFile(join(run, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
if (failure) { console.error(`Pencil fixture diagnostics: ${relative(project, run)}`); throw failure; }
await writeFile(join(project, 'docs/validation/pencil-browser.json'), JSON.stringify(receipt, null, 2) + '\n');
console.log(JSON.stringify({ run: relative(project, run), checks: checks.length, errors }));
