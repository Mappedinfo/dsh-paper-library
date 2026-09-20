/** Verify the published whiteboard, not just the workflow that produced it.
 *
 * Reads the live GitHub Pages URL: every asset must be served, and a real browser must be
 * able to draw, reload from browser storage, arrange and export a PNG on the deployed site.
 * This is a functional check of the public service; it is not a load test, an availability
 * guarantee or a statement about the host's own security.
 */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const project = dirname(dirname(fileURLToPath(import.meta.url)));
const site = (process.env.SITE_URL ?? 'https://mappedinfo.github.io/dsh-paper-library/').replace(/\/?$/, '/');
const checks = [];
const record = label => { checks.push(label); console.log(`PASS ${label}`); };

const assets = ['', 'board.js', 'board.css', 'theme.css', 'standalone.js', 'board-source.js', 'board-mermaid.js'];
for (const asset of assets) {
  const response = await fetch(`${site}${asset}`, { redirect: 'follow' });
  assert.equal(response.status, 200, `${asset || '(root)'} must be served`);
  const body = await response.text();
  assert.ok(body.length > 200, `${asset || '(root)'} must not be an empty placeholder`);
  if (asset === 'board.js') assert.ok(body.includes('PaperBoard'), 'the deployed canvas is the real one');
  if (asset === '') assert.ok(body.includes('id="board-stage"'), 'the deployed page carries the board markup');
}
record('every-published-asset-is-served-and-carries-the-real-canvas');

let browser;
const errors = [], external = [];
try {
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 }, acceptDownloads: true });
  page.on('pageerror', error => errors.push(error.message));
  page.on('response', response => { if (response.status() >= 400) errors.push(`HTTP ${response.status()} ${response.url()}`); });
  page.on('request', request => { if (!request.url().startsWith(site) && !request.url().startsWith('data:') && !request.url().startsWith('blob:')) external.push(request.url()); });
  await page.goto(site);
  await page.waitForLoadState('networkidle');
  await page.locator('#board-stage').waitFor();
  await page.waitForFunction(() => document.querySelectorAll('#board-select option').length >= 1);
  assert.equal(await page.locator('#board-view').isVisible(), true);
  assert.equal(await page.locator('#board-add-paper').isVisible(), false, 'the public page does not offer a library it cannot reach');
  assert.equal(await page.locator('#board-send').isVisible(), false, 'the public page does not offer a composer it cannot reach');
  record('the-live-page-opens-a-drawable-board-with-host-only-controls-hidden');

  const box = await page.locator('#board-stage').boundingBox();
  await page.locator('#board-tool-note').click();
  await page.mouse.click(box.x + 260, box.y + 200);
  await page.locator('.board-text-editor').waitFor();
  await page.locator('.board-text-editor').fill(`线上验证 ${new Date().toISOString().slice(0, 16)}`);
  await page.keyboard.press('Control+Enter');
  await page.waitForFunction(() => document.querySelectorAll('.board-node').length >= 1);
  await page.waitForFunction(() => /已保存/.test(document.getElementById('board-status')?.textContent || ''));
  const stored = await page.evaluate(() => JSON.parse(window.localStorage.getItem('paper-library-whiteboard.v1') ?? '{"records":[]}').records.filter(record => record.board?.deleted !== true).length);
  assert.ok(stored >= 1, 'the deployed page persisted the drawing into browser storage');
  record('drawing-on-the-live-site-persists-and-reports-saved');

  await page.reload();
  await page.waitForLoadState('networkidle');
  await page.waitForFunction(() => document.querySelectorAll('.board-node').length >= 1);
  record('a-reload-of-the-live-site-restores-the-drawing');

  // The toolbar is menus: 整理成树 lives in the layout panel.
  await page.locator('#board-layout-open').click();
  await page.waitForFunction(() => document.getElementById('board-layout-panel')?.classList.contains('is-open'));
  await page.locator('#board-tidy').click();
  await page.waitForFunction(() => /整理成树/.test(document.getElementById('toast')?.textContent || ''));
  const [png] = await Promise.all([page.waitForEvent('download'), page.locator('#site-export-png').click()]);
  const body = await readFile(await png.path());
  assert.equal(body.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.ok(body.length > 3000, `the exported PNG carries the drawing (${body.length} bytes)`);
  record('tidy-arranging-and-png-export-work-on-the-live-site');

  // A board that lives in the repository as a readable source file renders from its URL.
  const visitor = await browser.newPage({ viewport: { width: 1280, height: 820 } });
  visitor.on('pageerror', error => errors.push(error.message));
  visitor.on('request', request => { if (!request.url().startsWith(site) && !request.url().startsWith('data:') && !request.url().startsWith('blob:')) external.push(request.url()); });
  await visitor.goto(`${site}?src=boards/example.json`);
  await visitor.locator('#board-stage').waitFor();
  await visitor.waitForFunction(() => document.querySelectorAll('.board-node').length === 5);
  assert.match(await visitor.locator('#site-storage-status').innerText(), /已从源文件导入/);
  assert.equal(await visitor.locator('[data-edge-path]').count(), 4);
  await visitor.close();
  record('the-published-example-source-file-renders-from-its-url');

  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  record('no-failed-requests-no-page-errors-and-no-third-party-requests');
} finally {
  if (browser) await browser.close();
}

await writeFile(join(project, 'docs/validation/board-pages-live.json'), JSON.stringify({
  verified_at: new Date().toISOString(),
  url: site,
  scope: 'The deployed GitHub Pages site, read over the public network and exercised in real Chromium: asset delivery, draw/persist/reload, tidy-tree arranging, PNG export, hidden host-only controls, and no third-party requests or page errors. Browser storage on the visitor is convenience, not a durable store. This does not measure availability, latency, capacity or the host\'s security posture.',
  checks, checks_count: checks.length,
}, null, 2) + '\n');
console.log(JSON.stringify({ site, checks: checks.length, errors, external }));
