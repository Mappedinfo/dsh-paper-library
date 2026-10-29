/** Synthetic 1512×982 Retina reader checks; real Chromium wheel/touch/pen input. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { core } from '../src/bridge.mjs';
import { createFetchHandler } from '../src/http.mjs';
import { createLocalStateStore } from '../src/local-state.mjs';

const project = dirname(dirname(fileURLToPath(import.meta.url)));
await mkdir(join(project, '.local'), { recursive: true });
const run = await mkdtemp(join(project, '.local/reader-zoom-')), library = join(run, 'library'), python = join(project, '.venv/bin/python'), source = join(run, 'synthetic.pdf');
const generated = spawnSync(python, ['-c', `import pymupdf,sys
with pymupdf.open() as doc:
 for number in range(5):
  page=doc.new_page(width=595,height=842)
  page.insert_textbox((48,60,545,600),'Synthetic sharp text and accurate PDF coordinates. '*35,fontsize=11)
 doc.save(sys.argv[1])`, source], { encoding: 'utf8' });
assert.equal(generated.status, 0, generated.stderr);
const paper = (await core({ action: 'import', items: [{ id: 'SyntheticReaderZoom', title: 'Synthetic Retina zoom', attachments: [{ path: source }] }] }, { library, python })).items[0];
const handle = createFetchHandler({ library, python, localState: createLocalStateStore({ library, home: join(run, 'home') }) });
const checks = [], errors = [], requests = []; let inFlight = 0, maximumInFlight = 0;
const server = createServer(async (req, res) => {
  let raster = false;
  try {
    const request = new Request(`http://${req.headers.host}${req.url}`, { method: req.method, headers: req.headers, ...(!['GET', 'HEAD'].includes(req.method) ? { body: Readable.toWeb(req), duplex: 'half' } : {}) });
    if (req.method === 'POST' && req.url === '/api') { const input = await request.clone().json(); requests.push(input); if (input.action === 'page') { raster = true; maximumInFlight = Math.max(maximumInFlight, ++inFlight); } }
    const response = await handle(request); res.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body) Readable.fromWeb(response.body).pipe(res); else res.end();
  } catch { if (!res.headersSent) res.writeHead(500); res.end('Synthetic reader fixture failed'); }
  finally { if (raster) inFlight--; }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const origin = `http://127.0.0.1:${server.address().port}`;
const record = value => { checks.push(value); console.log(`PASS ${value}`); };
let browser;
try {
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright'); browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1512, height: 982 }, deviceScaleFactor: 2, hasTouch: true }), page = await context.newPage(); page.setDefaultTimeout(20000);
  page.on('pageerror', error => errors.push(error.message)); page.on('request', request => { if (/^https?:/.test(request.url()) && new URL(request.url()).origin !== origin) errors.push('external request'); });
  await page.addInitScript(() => { window.zoomInputs = []; for (const type of ['wheel', 'pointerdown']) document.addEventListener(type, e => { if (e.target.closest?.('#continuous-reader')) window.zoomInputs.push({ type, pointerType: e.pointerType, ctrl: e.ctrlKey, trusted: e.isTrusted }); }, true); });
  const cdp = await context.newCDPSession(page), root = page.locator('#continuous-reader');
  const ready = async (number = 1) => page.waitForFunction(p => { const img = document.querySelector(`.pdr-sheet[data-pdf-page="${p}"] img`); return img?.complete && img.naturalWidth && !pdfReader.getSnapshot().inFlightPage; }, number);
  const zoom = () => page.evaluate(() => pdfReader.getZoom());
  const geometry = (number = 1) => page.locator(`.pdr-sheet[data-pdf-page="${number}"]`).evaluate(sheet => { const b = sheet.getBoundingClientRect(), img = sheet.querySelector('img'); return { x: b.x, y: b.y, width: b.width, height: b.height, pixels: img?.naturalWidth }; });
  const at = async (point, number = 1) => { const b = await geometry(number); return { x: (point.x - b.x) / b.width, y: (point.y - b.y) / b.height }; };
  const closeTo = (a, b) => { assert.ok(Math.abs(a.x - b.x) < .004, JSON.stringify({ a, b })); assert.ok(Math.abs(a.y - b.y) < .004, JSON.stringify({ a, b })); };
  const wheel = (point, deltaY, modifiers = 2) => cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', ...point, deltaX: 0, deltaY, modifiers });
  const touches = (type, values = []) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: values.map((p, i) => ({ ...p, id: i + 1, radiusX: 8, radiusY: 8 })) });
  const pinch = async (point, ratio) => { await touches('touchStart', [{ x: point.x - 90, y: point.y }, { x: point.x + 90, y: point.y }]); for (let i = 1; i <= 12; i++) { const d = 90 * (1 + (ratio - 1) * i / 12); await touches('touchMove', [{ x: point.x - d, y: point.y }, { x: point.x + d, y: point.y }]); } await touches('touchEnd'); };
  await page.goto(origin, { waitUntil: 'networkidle' }); await page.waitForFunction(() => initializedReader && !restoringReader); await page.locator(`.paper-card[data-id="${paper.id}"]`).click(); await ready();
  const first = await geometry(); assert.ok(first.pixels / first.width >= 1.95, JSON.stringify(first));
  assert.ok(requests.find(r => r.action === 'page' && r.include_layout).render_width > 2000);
  record('Retina fit-width raster supplies two image pixels per CSS pixel');

  await root.evaluate(node => { node.scrollTop = 160; }); const box = await root.boundingBox(), point = { x: box.x + box.width * .6, y: box.y + 280 }, before = await at(point);
  await wheel(point, -60); await page.waitForFunction(() => pdfReader.getZoom() > 1.2); closeTo(before, await at(point));
  await page.waitForFunction(() => document.querySelector('.pdr-sheet[data-pdf-page="1"] img')?.naturalWidth > 2600); await ready();
  assert.equal(await page.locator('#reader-zoom-percent').inputValue(), String(Math.round(await zoom() * 100)));
  const enlarged = await geometry(); assert.ok(enlarged.pixels > first.pixels); assert.ok(enlarged.pixels / enlarged.width > 1.9);
  assert.equal(await page.evaluate(() => visualViewport.scale), 1); record('trusted Ctrl-wheel pinch zooms only the PDF, keeps its anchor and refreshes a sharp raster');
  const oldZoom = await zoom(), oldTop = await root.evaluate(node => node.scrollTop); await wheel(point, 130, 0); await page.waitForFunction(top => document.querySelector('#continuous-reader').scrollTop > top + 40, oldTop); assert.equal(await zoom(), oldZoom);
  record('ordinary two-finger scrolling remains scrolling');

  await page.locator('#reader-zoom-fit').click(); await page.evaluate(() => pdfReader.goTo(1)); await ready(); await root.evaluate(node => { node.scrollTop = 120; });
  const touchPoint = { x: box.x + box.width * .55, y: box.y + 290 }, touchBefore = await at(touchPoint);
  await pinch(touchPoint, 1.35); await page.waitForFunction(() => pdfReader.getZoom() >= 1.33); closeTo(touchBefore, await at(touchPoint)); await ready();
  assert.equal(await page.locator('#annotation-dialog').isVisible(), false); assert.equal(await page.evaluate(() => pdfReader.getInkDraft()), null);
  const pinchZoom = await zoom(); await touches('touchStart', [{ x: touchPoint.x, y: touchPoint.y }]); await touches('touchMove', [{ x: touchPoint.x, y: touchPoint.y - 100 }]); await touches('touchCancel'); assert.equal(await zoom(), pinchZoom);
  record('trusted two-touch pinch preserves source position and a subsequent single touch pans without annotation');

  await page.locator('#reader-layout-spread').click(); await page.locator('#reader-zoom-fit').click(); await page.evaluate(() => pdfReader.goTo(2)); await ready(2);
  const right = await geometry(2), rightPoint = { x: right.x + right.width * .45, y: Math.max(box.y + 220, right.y + 160) }, rightBefore = await at(rightPoint, 2);
  await wheel(rightPoint, -35); await page.waitForFunction(() => pdfReader.getZoom() > 1.1); closeTo(rightBefore, await at(rightPoint, 2));
  await ready(2); assert.ok((await page.evaluate(() => pdfReader.getSnapshot().residentPages.length)) <= 4);
  record('spread zoom anchors the right page and keeps the four-page residency budget');

  await page.locator('#reader-layout-single').click(); await page.locator('#reader-zoom-fit').click(); await page.evaluate(() => pdfReader.goTo(1)); await ready();
  await page.evaluate(() => pdfReader.setTool('ink')); const penBox = await geometry(), a = { x: penBox.x + 100, y: penBox.y + 220 }, b = { x: a.x + 35, y: a.y + 20 }, heldZoom = await zoom();
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...a, pointerType: 'pen', button: 'left', buttons: 1, force: .5 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...b, pointerType: 'pen', buttons: 1, force: .5 });
  await pinch(touchPoint, 1.3); await wheel(touchPoint, -50); assert.equal(await zoom(), heldZoom);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...b, pointerType: 'pen', button: 'left', buttons: 0, force: 0 });
  const ink = await page.evaluate(() => pdfReader.getInkDraft()); assert.equal(ink.paths.length, 1);
  const last = ink.paths[0].at(-1); assert.ok(Math.abs(last[0] - 135 / penBox.width * 595) < 1); assert.ok(Math.abs(last[1] - 240 / penBox.height * 842) < 1);
  record('touch and wheel gestures cannot resize or interrupt an active pen stroke');
  await page.evaluate(() => { pdfReader.clearInk(); pdfReader.setTool('select'); });
  await page.evaluate(point => {
    const root = document.querySelector('#continuous-reader');
    for (const [type, scale] of [['gesturestart', 1], ['gesturechange', 1.2], ['gestureend', 1.2]]) { const event = new Event(type, { bubbles: true, cancelable: true }); Object.assign(event, { scale, clientX: point.x, clientY: point.y }); root.dispatchEvent(event); }
  }, point);
  assert.ok(Math.abs(await zoom() - 1.2) < .02);
  record('WebKit gesture handlers apply the same zoom route (synthetic event compatibility check)');
  await page.locator('#reader-zoom-fit').click(); await ready();
  await page.screenshot({ path: join(run, 'reader-retina-1512.png') });
  assert.equal(maximumInFlight, 1); assert.equal(requests.filter(r => r.action === 'annotate').length, 0); assert.deepEqual(errors, []);
  const inputs = await page.evaluate(() => window.zoomInputs); assert.ok(inputs.some(e => e.type === 'wheel' && e.ctrl && e.trusted)); assert.ok(inputs.some(e => e.pointerType === 'touch' && e.trusted));
  record('raster work remains serial with trusted input, no PDF writes, browser errors or external requests');
} finally { await browser?.close(); await handle.disposeInkQueue(); await new Promise(resolve => server.close(resolve)); }
await writeFile(join(run, 'report.json'), JSON.stringify({ checks, errors, maximumInFlight, realModelCalls: 0 }, null, 2));
console.log(JSON.stringify({ run, checks: checks.length, errors }));
