/** Isolated markup-mode flow: 勾选后提问 (ask) and 自动着色 (auto), plus the
 * colour contract between the picker, the live selection wash, the saved PDF
 * annotation and the rail flash. Synthetic PDF only; no model or network call. */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { core } from '../src/bridge.mjs';

const project = dirname(dirname(fileURLToPath(import.meta.url)));
await mkdir(join(project, '.local'), { recursive: true });
const run = await mkdtemp(join(project, '.local/markup-mode-'));
const library = join(run, 'library'), checks = [], errors = [], external = [], screenshots = [];
const python = join(project, '.venv/bin/python');
const record = value => { checks.push(value); console.log(`PASS ${value}`); };
const generated = spawnSync(python, ['-c', `
import pymupdf, sys
doc = pymupdf.open()
page = doc.new_page(width=595, height=842)
body = "Synthetic measurement text describes the urban study and its comparison across districts for the reader. " * 8
page.insert_textbox((48, 60, 547, 800), body, fontsize=11, lineheight=1.5)
doc.save(sys.argv[1]); doc.close()
`, join(run, 'markup.pdf')], { cwd: project, encoding: 'utf8' });
assert.equal(generated.status, 0, generated.stderr);
const imported = await core({ action: 'import', items: [{ id: 'SyntheticMarkupMode', title: 'Synthetic markup modes', attachments: [{ path: join(run, 'markup.pdf') }] }] }, { library, python });
const paper = imported.items[0];

let server, browser, startTimer;
try {
  server = spawn(process.execPath, ['src/server.mjs', '--port', '0', '--library', library], { cwd: project, env: { ...process.env, DSH_HOME: join(run, 'home') }, stdio: ['ignore', 'pipe', 'pipe'] });
  const origin = await new Promise((accept, reject) => { startTimer = setTimeout(() => reject(new Error('Server startup timed out')), 15000); server.stdout.on('data', data => { const match = data.toString().match(/http:\/\/127\.0\.0\.1:\d+/); if (match) accept(match[0]); }); server.on('error', reject); server.on('exit', code => reject(new Error(`Server exited ${code}`))); });
  clearTimeout(startTimer);
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1200, height: 1000 } });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  let pageRenders = 0;
  page.on('request', request => {
    if (/^https?:/.test(request.url()) && new URL(request.url()).origin !== origin) external.push(request.url());
    if (request.url().endsWith('/api')) { try { if (request.postDataJSON()?.action === 'page') pageRenders++; } catch {} }
  });
  // A saved markup refreshes its page raster; wait for that install so the next
  // interaction talks to the current sheet.
  const settleRaster = async since => {
    const deadline = Date.now() + 15000;
    while (pageRenders <= since && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
    await new Promise(resolve => setTimeout(resolve, 250));
  };
  const open = async () => {
    await page.goto(origin); await page.waitForLoadState('networkidle');
    await page.waitForSelector(`#paper-list .paper-card[data-id="${paper.id}"]`);
    await page.click(`#paper-list .paper-card[data-id="${paper.id}"]`);
    await page.locator('#continuous-reader .pdr-sheet[data-pdf-page="1"] img.pdr-page-image').waitFor();
    // Markup tools and the mode switch live on the annotation surface.
    await page.click('[data-tab="annotations"]');
    await page.locator('#reader-tool-highlight').waitFor({ state: 'visible' });
  };
  await open();

  // Default mode is 勾选后提问.
  assert.equal(await page.locator('#reader-mode-group').getAttribute('data-mode'), 'ask');
  assert.equal(await page.locator('#reader-mode-ask').getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('#reader-mode-auto').getAttribute('aria-pressed'), 'false');
  record('the-reader-defaults-to-select-then-ask');

  const pick = async color => page.locator('#reader-color').evaluate((input, value) => { input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })); }, color);
  const ensurePage = async number => {
    await page.evaluate(value => { const input = document.getElementById('page-number'); input.value = String(value); input.dispatchEvent(new Event('change', { bubbles: true })); }, number);
    await page.waitForFunction(value => document.querySelectorAll(`#continuous-reader .pdr-sheet[data-pdf-page="${value}"] .pdr-word`).length > 0, number);
  };
  const dragWords = async (fromIndex, count) => {
    await ensurePage(1);
    const box = await page.evaluate(([start, length]) => {
      const words = [...document.querySelectorAll('#continuous-reader .pdr-sheet[data-pdf-page="1"] .pdr-word')];
      const first = words[start].getBoundingClientRect(), last = words[start + length - 1].getBoundingClientRect();
      return { from: { x: first.left + 2, y: first.top + first.height / 2 }, to: { x: last.right - 2, y: last.top + last.height / 2 } };
    }, [fromIndex, count]);
    await page.mouse.move(box.from.x, box.from.y); await page.mouse.down();
    await page.mouse.move(box.to.x, box.to.y, { steps: 14 }); await page.mouse.up();
    await new Promise(resolve => setTimeout(resolve, 160));
    return { mid: { x: (box.from.x + box.to.x) / 2, y: box.from.y } };
  };
  const saved = async comment => (await core({ action: 'annotations', id: paper.id }, { library, python })).annotations.filter(note => note.comment === comment);
  const rgbOf = value => value.slice(1).match(/../g).map(part => Number.parseInt(part, 16) / 255);

  // 勾选后提问: a markup drag opens the dialog, and the saved colour is the picked one.
  const askColor = '#2674ba';
  await pick(askColor);
  await page.locator('#reader-tool-highlight').click();
  const askRender = pageRenders;
  await dragWords(0, 4);
  await page.locator('#annotation-dialog').waitFor();
  assert.match(await page.locator('#annotation-quote').innerText(), /Synthetic measurement text/, 'The dialog quotes the selection');
  await page.locator('#annotation-comment').fill('Ask mode question');
  await page.locator('#annotation-form button[type="submit"]').first().click();
  await page.locator('#annotation-dialog').waitFor({ state: 'hidden' });
  await settleRaster(askRender);
  const asked = (await saved('Ask mode question'))[0];
  assert.ok(asked, 'Ask mode saved the annotation');
  assert.ok(asked.color.stroke.every((value, index) => Math.abs(value - rgbOf(askColor)[index]) < .001), 'The saved colour is the picked colour');
  record('ask-mode-opens-the-dialog-and-saves-the-picked-colour');

  // 自动着色: the same drag colours immediately, with no dialog.
  await page.locator('#reader-mode-auto').click();
  assert.equal(await page.locator('#reader-mode-group').getAttribute('data-mode'), 'auto');
  const autoColor = '#3a9365';
  await pick(autoColor);
  await page.locator('#reader-tool-select').click();
  const autoRender = pageRenders;
  const autoDrag = await dragWords(6, 5);
  await settleRaster(autoRender);
  assert.equal(await page.locator('#annotation-dialog').isVisible(), false, 'Auto mode never opens the dialog');
  const auto = (await core({ action: 'annotations', id: paper.id }, { library, python })).annotations.filter(note => note.kind !== 'ai-feedback' && note.comment === '' && Math.abs(note.color.stroke[1] - rgbOf(autoColor)[1]) < .001);
  assert.equal(auto.length, 1, `Auto mode wrote exactly one natural annotation (${auto.length})`);
  assert.equal(auto[0].text, 'study and its comparison across', 'Auto mode stored the dragged quote');
  assert.equal(auto[0].type, 'highlight');
  assert.ok(auto[0].rects.length >= 1);
  await page.evaluate(() => document.getElementById('annotation-dialog')?.close());
  record('auto-mode-colours-on-selection-with-no-dialog');

  // Colour contract: the selection wash uses the picker colour and the rail flash
  // uses the annotation's own colour (never a fixed UI colour).
  const wash = await page.evaluate(() => getComputedStyle(document.getElementById('continuous-reader')).getPropertyValue('--pdr-selection').trim());
  assert.equal(wash, 'rgba(58, 147, 101, 0.5)', `The live selection wash follows the picker (${wash})`);
  // Clicking saved markup in the PDF flashes it in its own colour.
  await page.evaluate(() => window.getSelection()?.removeAllRanges());
  await page.mouse.click(autoDrag.mid.x, autoDrag.mid.y);
  await page.locator('.pdr-annotation-flash').first().waitFor();
  const flash = await page.evaluate(() => { const node = document.querySelector('.pdr-annotation-flash'); const style = getComputedStyle(node); return { background: style.backgroundColor, border: style.borderColor }; });
  assert.equal(flash.background, 'rgba(58, 147, 101, 0.38)', `The rail flash uses the annotation colour (${flash.background})`);
  assert.equal(flash.border, 'rgb(58, 147, 101)', 'The flash border matches the annotation colour too');
  record('selection-wash-and-rail-flash-follow-the-real-colour');

  // Mode and colour persist for the next reading session.
  await page.reload(); await page.waitForLoadState('networkidle');
  await page.waitForSelector(`#paper-list .paper-card[data-id="${paper.id}"]`);
  await page.click(`#paper-list .paper-card[data-id="${paper.id}"]`);
  await page.click('[data-tab="annotations"]');
  await page.locator('#reader-mode-group').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#reader-mode-group').getAttribute('data-mode'), 'auto');
  assert.equal(await page.locator('#reader-color').inputValue(), autoColor);
  assert.equal(await page.locator('#reader-mode-auto').getAttribute('aria-pressed'), 'true');
  record('mode-and-colour-survive-a-reload');

  // Switching back to 勾选后提问 restores the dialog behaviour.
  await page.locator('#reader-mode-ask').click();
  await page.locator('#reader-tool-highlight').click();
  await dragWords(0, 3);
  await page.locator('#annotation-dialog').waitFor();
  await page.locator('#annotation-form .dialog-close').first().click();
  await page.locator('#annotation-dialog').waitFor({ state: 'hidden' });
  record('switching-back-restores-select-then-ask');

  const shots = join(run, 'auto-highlight.png');
  await page.screenshot({ path: shots }); screenshots.push(relative(project, shots));
  assert.deepEqual(errors, []); assert.deepEqual(external, []);
  record('no-browser-runtime-errors-and-no-external-requests');
} finally {
  if (browser) await browser.close();
  if (server) server.kill();
}
await writeFile(join(project, 'docs/validation/markup-mode-browser.json'), JSON.stringify({
  verified_at: new Date().toISOString(),
  scope: 'Synthetic standalone UI: ask/auto markup modes, picker-to-PDF colour contract, rail flash colour and persisted layout. Chromium only; no model call or external request.',
  checks, errors, externalRequests: external.length, modelRequests: 0, screenshots,
}, null, 2) + '\n');
console.log(JSON.stringify({ run: relative(project, run), checks: checks.length, errors }));
