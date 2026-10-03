/** Trusted Chromium pen/mouse/touch text-markup acceptance. Synthetic PDFs and
 * isolated local state only. This tests browser behavior, not physical Sidecar
 * latency, Safari delivery or iPadOS palm rejection. */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { core } from '../src/bridge.mjs';

const project = dirname(dirname(fileURLToPath(import.meta.url)));
await mkdir(join(project, '.local'), { recursive: true });
const run = await mkdtemp(join(project, '.local/pencil-markup-'));
const library = join(run, 'library'), python = join(project, '.venv/bin/python'), source = join(run, 'markup.pdf');
const checks = [], errors = [], external = [], writes = [], screenshots = [];
const record = name => { checks.push(name); console.log(`PASS ${name}`); };
const digest = async path => createHash('sha256').update(await readFile(path)).digest('hex');
const generated = spawnSync(python, ['-c', `
import pymupdf, sys
doc = pymupdf.open()
for rotation in (0, 90):
    page = doc.new_page(width=595, height=842)
    page.insert_textbox((48, 60, 547, 750), "Synthetic measurement text describes the urban study and its comparison across districts for the reader. " * 8, fontsize=11, lineheight=1.5)
    page.set_rotation(rotation)
page = doc.new_page(width=595, height=842)
page.insert_textbox((48, 60, 547, 450), "本研究比较了城市洪涝的实时预报方法，并讨论其在合成数据上的适用性。城市水文模型需要更细的时空分辨率，才能支撑街道尺度的预警与调度决策。", fontsize=11, fontname="china-s", lineheight=1.6)
doc.save(sys.argv[1]); doc.close()
`, source], { cwd: project, encoding: 'utf8' });
assert.equal(generated.status, 0, generated.stderr);
const originalHash = await digest(source);
const paper = (await core({ action: 'import', items: [{ id: 'SyntheticPencilText', title: 'Synthetic Pencil text selection', attachments: [{ path: source }] }] }, { library, python })).items[0];
const annotations = async () => (await core({ action: 'annotations', id: paper.id }, { library, python })).annotations;
let server, browser, page, startTimer, failure, events;
try {
  server = spawn(process.execPath, ['src/server.mjs', '--port', '0', '--library', library], { cwd: project, env: { ...process.env, DSH_HOME: join(run, 'home') }, stdio: ['ignore', 'pipe', 'pipe'] });
  const origin = await new Promise((resolve, reject) => {
    startTimer = setTimeout(() => reject(new Error('Server startup timed out')), 15000);
    server.stdout.on('data', data => { const match = data.toString().match(/http:\/\/127\.0\.0\.1:\d+/); if (match) resolve(match[0]); });
    server.on('error', reject); server.on('exit', code => reject(new Error(`Server exited ${code}`)));
  });
  clearTimeout(startTimer);
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1200, height: 1000 }, hasTouch: true });
  page = await context.newPage(); page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    if (/^https?:/.test(request.url()) && new URL(request.url()).origin !== origin) external.push(request.url());
    if (request.url().endsWith('/api')) { try { const body = request.postDataJSON(); if (body?.action === 'annotate') writes.push(body); } catch {} }
  });
  await page.addInitScript(() => {
    window.markupPointerEvents = [];
    document.addEventListener('pointerdown', event => {
      if (event.target.closest?.('#continuous-reader')) window.markupPointerEvents.push({ pointerId: event.pointerId, type: event.pointerType, trusted: event.isTrusted });
    }, true);
  });
  const cdp = await context.newCDPSession(page);
  const pen = (type, point) => cdp.send('Input.dispatchMouseEvent', { type, x: point.x, y: point.y, button: type === 'mouseMoved' ? 'none' : 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: type === 'mouseMoved' ? 0 : 1, pointerType: 'pen', force: type === 'mouseReleased' ? 0 : .6 });
  const ready = async number => {
    await page.waitForFunction(value => {
      const sheet = document.querySelector(`.pdr-sheet[data-pdf-page="${value}"]`), image = sheet?.querySelector('.pdr-page-image');
      return image?.complete && image.naturalWidth > 0 && sheet.querySelectorAll('.pdr-word').length > 0 && !autoMarkupBusy && !pdfReader.getSnapshot().inFlightPage;
    }, number);
  };
  const showPage = async number => { await page.evaluate(value => pdfReader.goTo(value), number); await ready(number); };
  const points = (number, first = 0, last = 3, fraction = .02) => page.evaluate(({ number, first, last, fraction }) => {
    const words = [...document.querySelectorAll(`.pdr-sheet[data-pdf-page="${number}"] .pdr-word`)];
    if (last < 0) last = words.length - 1;
    const a = words[first].getBoundingClientRect(), b = words[last].getBoundingClientRect();
    return { from: { x: a.left + a.width * fraction, y: a.top + a.height / 2 }, to: { x: b.right - b.width * fraction, y: b.top + b.height / 2 }, words: words.slice(first, last + 1).map(word => word.textContent), lines: new Set(words.slice(first, last + 1).map(word => Math.round(word.getBoundingClientRect().top))).size };
  }, { number, first, last, fraction });
  const drag = async (span, pointer = 'pen') => {
    if (pointer === 'mouse') { await page.mouse.move(span.from.x, span.from.y); await page.mouse.down(); await page.mouse.move(span.to.x, span.to.y, { steps: 18 }); await page.mouse.up(); }
    else {
      await pen('mousePressed', span.from);
      for (let index = 1; index <= 18; index++) await pen('mouseMoved', { x: span.from.x + (span.to.x - span.from.x) * index / 18, y: span.from.y + (span.to.y - span.from.y) * index / 18 });
      await pen('mouseReleased', span.to);
    }
  };
  const saveDrag = async (span, type = 'highlight', number = 1, pointer = 'pen') => {
    await page.locator(`#reader-tool-${type}`).click(); await ready(number);
    const response = page.waitForResponse(response => { try { return response.request().postDataJSON()?.action === 'annotate' && response.status() !== 429; } catch { return false; } });
    await drag(span, pointer); const saved = await response; assert.equal(saved.status(), 200, await saved.text());
    const value = await saved.json(); await ready(number); return value.result.annotation;
  };
  const unchanged = async (count, label) => {
    await page.waitForTimeout(100); assert.equal(writes.length, count, label); assert.equal(await page.locator('#annotation-dialog').isVisible(), false, label);
  };
  const shot = async name => { const path = join(run, `${name}.png`); await page.screenshot({ path }); screenshots.push(relative(project, path)); };
  await page.goto(origin); await page.waitForLoadState('networkidle');
  await page.waitForFunction(() => initializedReader && !restoringReader);
  await page.locator(`#paper-list .paper-card[data-id="${paper.id}"]`).click(); await ready(1);
  await page.locator('[data-tab="annotations"]').click(); await page.locator('#reader-mode-auto').click(); await ready(1);

  const partial = await points(1, 0, 3, .4), partialNote = await saveDrag(partial);
  assert.equal(partialNote.type, 'highlight'); assert.ok(!partialNote.text.startsWith('Synthetic')); assert.ok(!partialNote.text.endsWith('describes')); assert.match(partialNote.text, /measurement text/);
  assert.ok(partialNote.rects.length === 1); record('trusted-pen-highlight-keeps-partial-words-and-standard-text-rectangles');
  for (const [type, start] of [['underline', 5], ['strikeout', 11]]) {
    const saved = await saveDrag(await points(1, start, start + 3), type); assert.equal(saved.type, type); assert.ok(saved.text.length > 10 && saved.rects.length > 0);
  }
  record('trusted-pen-underline-and-strikeout-save-standard-pdf-markup');
  const multiline = await points(1, 0, 29), multilineNote = await saveDrag(multiline);
  assert.ok(multiline.lines >= 2); assert.equal(multilineNote.rects.length, multiline.lines); assert.ok(multiline.words.every(word => multilineNote.text.includes(word.trim()))); record('pen-multiline-selection-preserves-every-selected-line');
  const mouseNote = await saveDrag(await points(1, 1, 4, .35), 'highlight', 1, 'mouse');
  assert.ok(!mouseNote.text.startsWith('measurement')); assert.ok(mouseNote.text.includes('text describes')); record('sidecar-mouse-fallback-keeps-partial-word-text-markup');
  await shot('pencil-text-markup');

  // A click must retain the existing annotation-link action, without creating
  // another highlight or invoking text recognition.
  const tap = (await points(1, 0, 0, .7)).from, beforeTap = writes.length;
  await pen('mousePressed', tap); await pen('mouseReleased', tap);
  await page.locator('.pdr-annotation-flash').first().waitFor(); await unchanged(beforeTap, 'A tap links existing markup only'); record('pen-tap-on-saved-markup-links-without-adding-an-annotation');
  const span = await points(1, 2, 6), beforeCancel = writes.length;
  await pen('mousePressed', span.from); await pen('mouseMoved', span.to);
  await page.evaluate(() => {
    const event = window.markupPointerEvents.filter(value => value.type === 'pen').at(-1);
    document.getElementById('continuous-reader').dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, pointerType: 'pen', pointerId: event.pointerId }));
  });
  await pen('mouseReleased', span.to); await unchanged(beforeCancel, 'Cancelled drag saves nothing'); record('pointer-cancellation-clears-unfinished-text-selection');
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: span.from.x, y: span.from.y, id: 9 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: span.to.x, y: span.to.y, id: 9 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await unchanged(beforeCancel, 'Touch never creates markup'); record('trusted-touch-is-ignored-by-explicit-text-markup-tools');
  const outside = await page.locator('.pdr-sheet[data-pdf-page="1"]').boundingBox();
  await pen('mousePressed', span.from); await pen('mouseMoved', span.to); await pen('mouseReleased', { x: outside.x - 5, y: span.to.y });
  await unchanged(beforeCancel, 'Release outside the source page saves nothing'); record('releasing-outside-the-source-page-does-not-bind-wrong-page-text');
  await pen('mousePressed', span.from); await pen('mouseMoved', span.to); await page.evaluate(() => pdfReader.setTool('select')); await pen('mouseReleased', span.to);
  await unchanged(beforeCancel, 'A tool switch cancels the partial drag'); record('tool-switch-cancels-unfinished-pen-markup');

  await page.locator('#reader-tool-highlight').click();
  await pen('mousePressed', span.from); await pen('mouseMoved', span.to); await showPage(2); await pen('mouseReleased', span.to);
  await unchanged(beforeCancel, 'A page change cancels the partial drag'); record('page-change-cancels-unfinished-pen-markup');
  const rotatedNote = await saveDrag(await points(2, 0, 3), 'underline', 2);
  assert.equal(rotatedNote.page, 2); assert.equal(rotatedNote.type, 'underline'); assert.match(rotatedNote.text, /measurement text/); record('rotated-page-pen-markup-retains-text-and-page-binding');

  await page.locator('#reader-tool-highlight').click(); await showPage(3);
  const chinese = await points(3, 0, -1, .001), chineseNote = await saveDrag(chinese, 'highlight', 3);
  assert.equal(chineseNote.text, chinese.words.join('').trim()); assert.ok(!chineseNote.text.includes(' ')); await shot('pencil-cjk-markup'); record('trusted-pen-cjk-markup-keeps-original-characters-without-added-spaces');
  await page.locator('#reader-mode-ask').click();
  const beforeAsk = writes.length; await page.locator('#reader-tool-underline').click(); await drag(await points(3, 0, 0, .2));
  await page.locator('#annotation-dialog').waitFor(); assert.ok((await page.locator('#annotation-quote').innerText()).length > 0); assert.equal(writes.length, beforeAsk); await page.evaluate(() => document.getElementById('annotation-dialog').close()); record('pen-selection-respects-ask-mode-and-waits-for-explicit-save');

  assert.equal(await digest(source), originalHash); assert.equal((await annotations()).filter(note => note.type === 'ink').length, 0); record('text-markup-preserves-original-pdf-and-does-not-create-ink-objects');
  events = await page.evaluate(() => window.markupPointerEvents);
  for (const type of ['pen', 'mouse', 'touch']) assert.ok(events.some(event => event.type === type && event.trusted), `Trusted ${type} reached the reader`);
  assert.deepEqual(errors, []); assert.deepEqual(external, []); record('trusted-pointer-events-with-no-browser-errors-or-external-requests');
} catch (error) {
  failure = error; console.error(error); process.exitCode = 1;
  if (page) { await page.screenshot({ path: join(run, 'failure.png') }).catch(() => {}); events = await page.evaluate(() => window.markupPointerEvents).catch(() => []); }
} finally {
  clearTimeout(startTimer); await browser?.close();
  if (server && server.exitCode === null) await new Promise(resolve => { const timer = setTimeout(() => server.kill('SIGKILL'), 2500); server.once('exit', () => { clearTimeout(timer); resolve(); }); server.kill('SIGINT'); });
}
const report = { verified_at: new Date().toISOString(), run: relative(project, run), checks, screenshots, browser_errors: errors, external_requests: external.length, annotation_writes: writes.length, trusted_pointer_types: [...new Set((events || []).filter(event => event.trusted).map(event => event.type))], scope: 'Synthetic Chromium pen/mouse/touch text-markup behavior; physical Pencil/Sidecar and Safari not validated', ...(failure ? { error: failure.stack, writes, events } : {}) };
await writeFile(join(run, 'report.json'), JSON.stringify(report, null, 2) + '\n');
if (!failure) await writeFile(join(project, 'docs/validation/pencil-markup-browser.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ run: relative(project, run), checks: checks.length, errors, failed: !!failure }));
