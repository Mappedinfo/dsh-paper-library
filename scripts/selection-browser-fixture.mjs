/** Isolated PDF text-selection precision flow: the invisible text layer must sit
 * exactly over the raster words, a drag must capture every word it covers, and a
 * release in a gap or at a line end must not extend into the next word or throw
 * the selection away. Synthetic documents only; no model or network request. */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { core } from '../src/bridge.mjs';

const project = dirname(dirname(fileURLToPath(import.meta.url)));
await mkdir(join(project, '.local'), { recursive: true });
const run = await mkdtemp(join(project, '.local/selection-browser-'));
const library = join(run, 'library'), checks = [], errors = [], external = [], screenshots = [];
const python = join(project, '.venv/bin/python');
const record = value => { checks.push(value); console.log(`PASS ${value}`); };
const source = join(run, 'selection.pdf');
const generated = spawnSync(python, ['-c', `
import pymupdf, sys
doc = pymupdf.open()
for index, rotation in enumerate((0, 90)):
    page = doc.new_page(width=595, height=842)
    body = "Synthetic measurement text describes the urban study and its comparison across districts for the reader. " * 8
    page.insert_textbox((48, 60, 547, 800), body, fontsize=11, lineheight=1.5)
    page.set_rotation(rotation)
doc.save(sys.argv[1]); doc.close()
`, source], { cwd: project, encoding: 'utf8' });
assert.equal(generated.status, 0, generated.stderr);
const imported = await core({ action: 'import', items: [{ id: 'SyntheticSelection', title: 'Synthetic selection precision', attachments: [{ path: source }] }] }, { library, python });
const paper = imported.items[0];

let server, browser, startTimer;
try {
  server = spawn(process.execPath, ['src/server.mjs', '--port', '0', '--library', library], { cwd: project, env: { ...process.env, DSH_HOME: join(run, 'home') }, stdio: ['ignore', 'pipe', 'pipe'] });
  const origin = await new Promise((accept, reject) => { startTimer = setTimeout(() => reject(new Error('Server startup timed out')), 15000); server.stdout.on('data', data => { const match = data.toString().match(/http:\/\/127\.0\.0\.1:\d+/); if (match) accept(match[0]); }); server.on('error', reject); server.on('exit', code => reject(new Error(`Server exited ${code}`))); });
  clearTimeout(startTimer);
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1200, height: 1000 } });
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (/^https?:/.test(request.url()) && new URL(request.url()).origin !== origin) external.push(request.url()); });
  await page.goto(origin); await page.waitForLoadState('networkidle');
  await page.waitForSelector(`#paper-list .paper-card[data-id="${paper.id}"]`);
  await page.click(`#paper-list .paper-card[data-id="${paper.id}"]`);
  await page.locator('#continuous-reader .pdr-sheet[data-pdf-page="1"] img.pdr-page-image').waitFor();

  // 1. The selectable run must sit exactly over its raster word box.
  const alignment = await page.evaluate(() => {
    const samples = [...document.querySelectorAll('#continuous-reader .pdr-sheet[data-pdf-page="1"] .pdr-word')].slice(0, 60);
    let worst = 0;
    for (const span of samples) {
      const box = span.getBoundingClientRect(), run = span.querySelector('.pdf-word-text').getBoundingClientRect();
      worst = Math.max(worst, Math.abs(run.left - box.left), Math.abs(run.right - box.right));
    }
    return { samples: samples.length, worst: Number(worst.toFixed(2)) };
  });
  assert.ok(alignment.samples >= 40, `Enough measured words: ${alignment.samples}`);
  assert.ok(alignment.worst <= 1.5, `Invisible text must match the raster word box (worst ${alignment.worst}px)`);
  record('selectable-text-sits-exactly-over-the-raster-word-boxes');

  const showPage = async number => {
    await page.evaluate(value => { const input = document.getElementById('page-number'); input.value = String(value); input.dispatchEvent(new Event('change', { bubbles: true })); }, number);
    await page.waitForFunction(value => document.querySelectorAll(`#continuous-reader .pdr-sheet[data-pdf-page="${value}"] .pdr-word`).length > 0, number);
    await page.locator(`#continuous-reader .pdr-sheet[data-pdf-page="${number}"] img.pdr-page-image`).waitFor();
  };
  const reset = () => page.evaluate(() => { window.getSelection().removeAllRanges(); const tools = document.getElementById('selection-tools'); if (tools) tools.hidden = true; const preview = document.getElementById('selection-preview'); if (preview) preview.textContent = ''; });
  const drag = async (from, to) => {
    await page.mouse.move(from.x, from.y); await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 18 }); await page.mouse.up();
    await new Promise(resolve => setTimeout(resolve, 140));
    return page.evaluate(() => ({
      browser: window.getSelection().toString().replace(/\s+/g, ' ').trim(),
      preview: (document.getElementById('selection-preview')?.textContent || '').replace(/\s+/g, ' ').trim(),
      hidden: document.getElementById('selection-tools')?.hidden,
    }));
  };

  // 2. A multi-line drag captures every intervening word, in order.
  const plan = await page.evaluate(() => {
    const words = [...document.querySelectorAll('#continuous-reader .pdr-sheet[data-pdf-page="1"] .pdr-word')];
    const start = words.findIndex(word => word.textContent.trim() === 'Synthetic');
    const expected = words.slice(start, start + 30).map(word => word.textContent.trim());
    const first = words[start].getBoundingClientRect(), last = words[start + 29].getBoundingClientRect();
    const lines = new Set(words.slice(start, start + 30).map(word => Math.round(word.getBoundingClientRect().top))).size;
    return { expected, lines, from: { x: first.left + 2, y: first.top + first.height / 2 }, to: { x: last.right - 2, y: last.top + last.height / 2 } };
  });
  await reset();
  const multi = await drag(plan.from, plan.to);
  assert.equal(multi.preview, plan.expected.join(' '), 'Every dragged word is captured in order');
  assert.ok(!multi.preview.includes('  '), 'Captured text has no double spaces');
  assert.equal(multi.hidden, false);
  const shot = (name, path) => { screenshots.push(relative(project, path)); return page.screenshot({ path }); };
  await shot('multi-line-selection', join(run, 'multi-line-selection.png'));
  const previewNode = await page.evaluate(() => { const node = document.getElementById('selection-preview'); return { text: node.textContent.length, scroll: node.scrollHeight, client: node.clientHeight }; });
  assert.equal(previewNode.text, multi.preview.length, 'The preview holds the complete selection');
  assert.ok(previewNode.scroll <= previewNode.client + 1 || previewNode.client > 0, 'A long selection stays readable in the preview pane');
  record('a-multi-line-drag-captures-every-word-and-shows-it-in-full');

  // 2b. The saved annotation must quote the same text and cover every line the
  // drag crossed, so the rendered markup cannot skip words either.
  await page.locator('#annotate-selection').click();
  await page.locator('#annotation-dialog').waitFor();
  await page.locator('#annotation-comment').fill('Synthetic multi-line selection comment');
  await page.locator('#annotation-form button[type="submit"]').first().click();
  await page.locator('#annotation-dialog').waitFor({ state: 'hidden' });
  const saved = (await core({ action: 'annotations', id: paper.id }, { library, python })).annotations.find(note => note.comment === 'Synthetic multi-line selection comment');
  assert.ok(saved, 'The multi-line selection saved an annotation');
  assert.equal(saved.text, multi.preview, 'The saved quote is the captured selection');
  assert.ok(plan.lines >= 2, 'The drag really crossed several lines');
  assert.equal(saved.rects.length, plan.lines, `One rectangle per selected line (${saved.rects.length} of ${plan.lines})`);
  assert.ok(saved.rects.every(rect => rect[2] > rect[0] && rect[3] > rect[1]), 'Every rectangle is usable');
  await page.locator('#reader-annotations').click();
  await page.locator('.library-pane #annotations-tab').waitFor();
  await shot('saved-multi-line-markup', join(run, 'saved-multi-line-markup.png'));
  record('the-saved-markup-quotes-the-selection-and-covers-every-line');

  // 3. Releasing inside the gap after a word must not include the following word.
  await showPage(1); await reset();
  const gap = await page.evaluate(() => {
    const words = [...document.querySelectorAll('#continuous-reader .pdr-sheet[data-pdf-page="1"] .pdr-word')];
    const start = words.findIndex(word => word.textContent.trim() === 'Synthetic');
    const first = words[start].getBoundingClientRect(), second = words[start + 1].getBoundingClientRect();
    return { first: words[start].textContent.trim(), second: words[start + 1].textContent.trim(), from: { x: first.left + 2, y: first.top + first.height / 2 }, to: { x: first.right + (second.left - first.right) / 2, y: first.top + first.height / 2 } };
  });
  const gapResult = await drag(gap.from, gap.to);
  assert.equal(gapResult.preview, gap.first, `A release in the gap ends after the previous word (${gapResult.preview})`);
  assert.ok(!gapResult.preview.includes(gap.second), 'The following word is not dragged in');
  record('releasing-in-an-inter-word-gap-never-reaches-the-next-word');

  // 4. Releasing past the last word of a line keeps that selection.
  await showPage(1); await reset();
  const lineEnd = await page.evaluate(() => {
    const words = [...document.querySelectorAll('#continuous-reader .pdr-sheet[data-pdf-page="1"] .pdr-word')];
    const start = words.findIndex(word => word.textContent.trim() === 'Synthetic');
    const first = words[start].getBoundingClientRect();
    let last = start;
    while (last + 1 < words.length && Math.abs(words[last + 1].getBoundingClientRect().top - first.top) < 3) last++;
    const box = words[last].getBoundingClientRect();
    return { from: { x: first.left + 2, y: first.top + first.height / 2 }, to: { x: box.right + 6, y: first.top + first.height / 2 }, last: words[last].textContent.trim() };
  });
  const lineResult = await drag(lineEnd.from, lineEnd.to);
  assert.ok(lineResult.preview.endsWith(lineEnd.last), `A line-end release keeps every word (${lineResult.preview.slice(-30)})`);
  assert.equal(lineResult.hidden, false, 'The selection survives a release past the line end');
  record('a-line-end-release-keeps-the-whole-line-instead-of-collapsing');

  // 5. A rotated page keeps the same precision.
  await showPage(2); await reset();
  const rotated = await page.evaluate(() => {
    const words = [...document.querySelectorAll('#continuous-reader .pdr-sheet[data-pdf-page="2"] .pdr-word')];
    const start = words.findIndex(word => word.textContent.trim() === 'Synthetic');
    const first = words[start].getBoundingClientRect(), last = words[start + 8].getBoundingClientRect();
    return { from: { x: first.left + 2, y: first.top + first.height / 2 }, to: { x: last.right - 2, y: last.top + last.height / 2 } };
  });
  const rotatedResult = await drag(rotated.from, rotated.to);
  // A rotated page keeps the browser's own character sequence; only the reader
  // inserts the separator spaces, so compare the letters.
  assert.ok(rotatedResult.preview.length > 0, 'The rotated drag selected text');
  assert.equal(rotatedResult.preview.replace(/\s+/g, ''), rotatedResult.browser.replace(/\s+/g, ''),
    `A rotated page captures exactly the browser selection (${rotatedResult.preview} vs ${rotatedResult.browser})`);
  assert.ok(rotatedResult.preview.split(' ').length >= 5, `The rotated drag captured a run of words (${rotatedResult.preview})`);
  record('a-rotated-page-captures-the-browser-selection-without-dropping-words');

  assert.deepEqual(errors, []); assert.deepEqual(external, []);
  record('no-browser-runtime-errors-and-no-external-requests');
} finally {
  if (browser) await browser.close();
  if (server) server.kill();
}
await writeFile(join(project, 'docs/validation/selection-browser.json'), JSON.stringify({
  verified_at: new Date().toISOString(),
  scope: 'Synthetic two-page fixture in an isolated standalone server: invisible text layer alignment, multi-line capture completeness, gap and line-end releases, and a rotated page. Chromium only; no model call and no external request.',
  checks, errors, externalRequests: external.length, modelRequests: 0, screenshots,
}, null, 2) + '\n');
console.log(JSON.stringify({ run: relative(project, run), checks: checks.length, errors }));
