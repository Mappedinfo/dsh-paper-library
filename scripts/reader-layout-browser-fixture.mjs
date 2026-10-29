/** Desktop integration using synthetic PDFs, local metadata and a model double. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { core, dispatch } from '../src/bridge.mjs';
import { createFetchHandler } from '../src/http.mjs';
import { createLocalStateStore } from '../src/local-state.mjs';
import { createLanguageLearning } from '../src/harness/language-learning.mjs';

const project = dirname(dirname(fileURLToPath(import.meta.url)));
await mkdir(join(project, '.local'), { recursive: true });
const run = await mkdtemp(join(project, '.local/reader-layout-'));
const library = join(run, 'library'), python = join(project, '.venv/bin/python'), pdf = join(run, 'synthetic.pdf');
const generated = spawnSync(python, ['-c', `
import pymupdf,sys
doc=pymupdf.open()
for i in range(5):
    page=doc.new_page(width=595,height=842)
    page.insert_textbox((60,60,535,750), ('Synthetic page %s contains source text for reading and annotation. ' % (i+1))*12, fontsize=12)
doc.save(sys.argv[1]);doc.close()
`, pdf], { encoding: 'utf8' });
assert.equal(generated.status, 0, generated.stderr);
await core({ action: 'import', items: Array.from({ length: 44 }, (_, i) => ({ id: `SyntheticGraph${i}`, title: `Synthetic graph paper ${i}` })) }, { library, python });
const paper = (await core({ action: 'import', items: [{ id: 'SyntheticSpread', title: 'Synthetic spread reader', attachments: [{ path: pdf }] }] }, { library, python })).items[0];
const store = createLocalStateStore({ library, home: join(run, 'home') });
let aiCalls = 0;
const languageLearning = createLanguageLearning({ store, dispatch, library, python,
  getDefaultModel: () => ({ provider: 'synthetic', model: 'default-model' }),
  models: async () => ({ models: [{ provider: 'synthetic', id: 'default-model', name: 'Synthetic default' }] }),
  ai: async () => { aiCalls++; return JSON.stringify({ result: 'Synthetic response', explanation: '', vocabulary: [] }); },
});
const handle = createFetchHandler({ library, python, localState: store, languageLearning });
const actions = [], errors = [], checks = [];
let heldFirst = false, browser;
const server = createServer(async (req, res) => {
  try {
    const request = new Request(`http://${req.headers.host}${req.url}`, { method: req.method, headers: req.headers,
      ...(!['GET', 'HEAD'].includes(req.method) ? { body: Readable.toWeb(req), duplex: 'half' } : {}) });
    if (req.method === 'POST' && req.url === '/api') {
      const input = await request.clone().json(); actions.push(input);
      if (input.action === 'page' && input.include_layout && !heldFirst) { heldFirst = true; await new Promise(resolve => setTimeout(resolve, 650)); }
    }
    const response = await handle(request);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body) Readable.fromWeb(response.body).pipe(res); else res.end();
  } catch { if (!res.headersSent) res.writeHead(500); res.end('Synthetic fixture request failed'); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const record = name => { checks.push(name); console.log(`PASS ${name}`); };
try {
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1512, height: 982 } });
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (/^https?:/.test(request.url()) && new URL(request.url()).origin !== origin) errors.push('external request'); });
  await page.goto(origin); await page.waitForLoadState('networkidle');

  await page.locator('#library-graph-open').click();
  await page.locator('#library-graph-content .kg-status').filter({ hasText: '/ 45' }).waitFor();
  await page.getByRole('button', { name: '下一批文献', exact: true }).click();
  await page.locator('#library-graph-content .kg-status').filter({ hasText: '41–45 / 45' }).waitFor();
  assert.equal(await page.locator('#library-graph-content [data-kg="add-node"]').isVisible(), false);
  await page.locator('#library-graph-dialog').getByRole('button', { name: '关闭', exact: true }).click();
  record('global graph opens without a paper, pages the catalog, and stays read-only');

  await page.locator(`#paper-list .paper-card[data-id="${paper.id}"]`).click();
  await page.locator('#continuous-reader[aria-busy="true"] .pdr-spinner').waitFor();
  await page.locator('#continuous-reader .pdr-page-image').first().waitFor();
  assert.equal(actions.filter(input => input.action === 'page_layout').length, 0);
  assert.equal(actions.filter(input => input.action === 'page' && input.include_layout).length, 1);
  record('first screen shows a spinner and uses one combined page request');

  await page.locator('#reader-layout-spread').click();
  await page.locator('#continuous-reader[data-layout="spread"] .pdr-spread').first().waitFor();
  await page.locator('.pdr-sheet[data-pdf-page="2"] .pdr-word').first().waitFor();
  const pair = await page.evaluate(() => [...document.querySelectorAll('.pdr-spread:first-child .pdr-page-slot')].map(node => { const b = node.getBoundingClientRect(); return { top: b.top, left: b.left }; }));
  assert.equal(pair.length, 2); assert.ok(Math.abs(pair[0].top - pair[1].top) < 2); assert.ok(pair[1].left > pair[0].left);
  const words = page.locator('.pdr-sheet[data-pdf-page="2"] .pdr-word');
  const first = await words.nth(0).boundingBox(), third = await words.nth(2).boundingBox();
  await page.mouse.move(first.x + 2, first.y + first.height / 2); await page.mouse.down();
  await page.mouse.move(third.x + third.width - 2, third.y + third.height / 2, { steps: 12 }); await page.mouse.up();
  await page.waitForFunction(() => state.selection?.page === 2 && state.selection.rects.length > 0);
  await page.locator('#clear-selection').click();
  await page.locator('#page-number').fill('5'); await page.locator('#page-number').press('Enter');
  await page.locator('.pdr-sheet[data-pdf-page="5"] .pdr-page-image').waitFor();
  assert.equal(await page.locator('.pdr-spread').last().locator('.pdr-page-slot').count(), 1);
  assert.ok(await page.locator('.pdr-sheet[data-loaded="true"]').count() <= 4);
  await page.screenshot({ path: join(run, 'spread-1512.png') });
  record('two-page layout preserves right-page selection, odd last page and four-page budget');

  await page.locator('#reader-layout-single').click();
  await page.locator('#continuous-reader[data-layout="single"]').waitFor();
  assert.ok(await page.locator('.pdr-sheet[data-loaded="true"]').count() <= 3);
  await page.locator('#settings-open').click(); await page.locator('.settings-storage').evaluate(node => { node.open = true; });
  await page.locator('#settings-language').click();
  await page.locator('#language-settings-model option').first().waitFor({ state: 'attached' });
  assert.match(await page.locator('#language-settings-model').innerText(), /default-model/);
  const before = await page.locator('#language-panel').boundingBox(), drag = await page.locator('#language-drag').boundingBox();
  await page.mouse.move(drag.x + drag.width / 2, drag.y + drag.height / 2); await page.mouse.down();
  await page.mouse.move(drag.x - 150, drag.y - 80, { steps: 10 }); await page.mouse.up();
  const after = await page.locator('#language-panel').boundingBox(); assert.ok(after.x < before.x - 50);
  record('single-page budget restores and global settings open a draggable language window');

  await page.goto(`${origin}/slides.html`); await page.locator('.slides-create').waitFor();
  const back = page.getByRole('button', { name: '返回文献库', exact: true }); assert.equal(await back.locator('svg').count(), 1);
  await page.screenshot({ path: join(run, 'slides-chooser-1512.png') });
  await page.locator('.slides-create input').fill('Synthetic slides integration');
  await page.getByRole('button', { name: '新建', exact: true }).click(); await page.locator('.app-shell .toolbar').waitFor();
  assert.equal(await page.getByRole('button', { name: '返回文献库', exact: true }).locator('svg').count(), 1);
  record('Slides chooser and editor share an arrow return button and create a local project');
  assert.deepEqual(errors, []); assert.equal(aiCalls, 0);
  record('no browser errors, external requests or model calls');
} finally {
  await browser?.close(); await handle.disposeInkQueue(); await new Promise(resolve => server.close(resolve));
}
await writeFile(join(run, 'report.json'), JSON.stringify({ checks, errors, aiCalls, scope: 'Synthetic desktop behavior checks; not provider quality or private-library validation' }, null, 2));
console.log(JSON.stringify({ run, checks: checks.length, errors }));
