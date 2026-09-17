/** Actual Chromium acceptance against an isolated 24-page synthetic library.
 * Set PLAYWRIGHT_MODULE to an existing Playwright index.mjs; no model or real
 * library is used. --recon captures the initial rendered surface only.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { core } from '../src/bridge.mjs';

const project = dirname(dirname(fileURLToPath(import.meta.url)));
await mkdir(join(project, '.local'), { recursive: true });
const run = await mkdtemp(join(project, '.local/reader-browser-'));
const library = join(run, 'library'), source = join(run, 'source'), checks = [], screenshots = [];
const python = join(project, '.venv/bin/python');
const generated = spawnSync(python, ['scripts/create-reader-demo.py', '--output', source], { cwd: project, encoding: 'utf8' });
assert.equal(generated.status, 0, generated.stderr);
const sourcePath = join(source, 'continuous-reader-synthetic.pdf');
const digest = async path => createHash('sha256').update(await readFile(path)).digest('hex');
const originalHash = await digest(sourcePath);
const secondSourcePath = join(source, 'second-reader-synthetic.pdf'), secondOriginalHash = await digest(secondSourcePath);
const [paper, secondPaper] = (await core({ action: 'import', path: join(source, 'reader-export.json') }, { library, python })).items;
await core({ action: 'import', items: Array.from({ length: 44 }, (_, index) => ({
  id: `ReaderCatalog${index}`, title: `Synthetic reader catalog ${String(index).padStart(2, '0')}`,
  author: [{ family: 'Example', given: `Reader ${index}` }], issued: { 'date-parts': [[2000 + index % 25]] },
})) }, { library, python });
const record = value => { checks.push(value); console.log(`PASS ${value}`); };
const errors = [], apiCalls = [], pageRequests = new Set(), unexpectedRemote = [];
let server, browser, page, startTimer, maxInFlightPages = 0, injectPageFailure = null, injectedFailures = 0, serverLog = '';
let finalReport;

async function stopServer() {
  if (!server || server.exitCode !== null) return;
  await new Promise(resolve => {
    const timer = setTimeout(() => server.kill('SIGKILL'), 2500);
    server.once('exit', () => { clearTimeout(timer); resolve(); });
    server.kill('SIGINT');
  });
}

try {
  server = spawn(process.execPath, ['src/server.mjs', '--port', '0', '--library', library], { cwd: project, env:{...process.env,DSH_HOME:join(run,'home')}, stdio: ['ignore', 'pipe', 'pipe'] });
  const origin = await new Promise((accept, reject) => {
    startTimer = setTimeout(() => reject(new Error('Synthetic server startup timed out')), 15000);
    server.stdout.on('data', bytes => { serverLog += bytes.toString(); const match = serverLog.match(/http:\/\/127\.0\.0\.1:\d+/); if (match) accept(match[0]); });
    server.stderr.on('data', bytes => { serverLog += bytes.toString(); });
    server.on('error', reject); server.on('exit', code => reject(new Error(`Synthetic server exited ${code}`)));
  });
  clearTimeout(startTimer);
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 741, height: 597 }, acceptDownloads: true });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
  page = await context.newPage(); page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    if (/^https?:/.test(request.url()) && new URL(request.url()).origin !== origin) unexpectedRemote.push(request.url());
    if (request.url().endsWith('/api')) {
      try { const body = request.postDataJSON(); apiCalls.push(body); if (body.action === 'page') { pageRequests.add(request); maxInFlightPages = Math.max(maxInFlightPages, pageRequests.size); } } catch {}
    }
  });
  const finished = request => pageRequests.delete(request);
  page.on('requestfinished', finished); page.on('requestfailed', finished);
  await page.route('**/api', async route => {
    const body = route.request().postDataJSON();
    if (body.action === 'page' && body.page === injectPageFailure) {
      injectPageFailure = null; injectedFailures++;
      return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'Synthetic page failure for explicit retry' }) });
    }
    return route.continue();
  });
  await page.addInitScript(() => {
    window.readerFixtureMeasurements = { maxResidentImages: 0 };
    new MutationObserver(() => {
      window.readerFixtureMeasurements.maxResidentImages = Math.max(window.readerFixtureMeasurements.maxResidentImages, document.querySelectorAll('#continuous-reader .pdr-page-image[src]').length);
    }).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });
  });
  await page.goto(origin); await page.waitForLoadState('networkidle');
  await page.locator('#search').fill(paper.title);
  await page.locator(`.paper-card[data-id="${paper.id}"]`).click();
  const reader = page.locator('#continuous-reader');
  const sheet = number => page.locator(`#continuous-reader .pdr-sheet[data-pdf-page="${number}"]`);
  const ready = number => sheet(number).locator('img.pdr-page-image').waitFor();
  const waitPage = number => page.waitForFunction(value => document.getElementById('page-number').value === String(value), number);
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
  const screenshot = async name => { const path = join(run, `${name}.png`); await page.screenshot({ path }); screenshots.push(relative(project, path)); };
  const visiblePDF = async () => {
    assert.equal(await reader.isVisible(), true);
    const box = await reader.boundingBox(); assert.ok(box && box.width > 50 && box.height > 100);
    assert.ok(await reader.locator('.pdr-page-image[src]').count() > 0);
  };
  const jump = async number => {
    await page.locator('#page-number').fill(String(number)); await page.locator('#page-number').press('Enter');
    await page.locator('#page-number').blur(); await waitPage(number); await ready(number);
  };
  const scrollTo = async number => {
    const delta = await reader.evaluate((root, number) => {
      const target = root.querySelector(`.pdr-page-slot[data-pdf-page="${number}"]`);
      return target.getBoundingClientRect().top - root.getBoundingClientRect().top - 12;
    }, number);
    const box = await reader.boundingBox(); await page.mouse.move(box.x + box.width * .75, box.y + box.height * .5);
    await page.mouse.wheel(0, delta); await waitPage(number); await ready(number);
  };
  await ready(1); await waitPage(1); assert.equal(await reader.locator('.pdr-page-slot').count(), 24);
  await writeFile(join(run, 'initial-dom.txt'), await page.locator('body').innerText());
  await screenshot('reader-741');
  if (process.argv.includes('--recon')) {
    finalReport = { recon: true, run: relative(project, run), errors };
  } else {
    await visiblePDF(); assert.equal(await overflow(), false); record('24-mixed-size-rotated-pages-open-in-one-continuous-reader');
    await scrollTo(12); await scrollTo(24); await screenshot('scrolled-page-24'); record('actual-wheel-scroll-to-pages-12-and-24-updates-page-number');
    await jump(6); await jump(1); record('visible-page-number-control-jumps-forward-and-back');
    injectPageFailure = 17;
    await page.locator('#page-number').fill('17'); await page.locator('#page-number').press('Enter'); await page.locator('#page-number').blur();
    await page.locator('[data-retry-page="17"]').waitFor();
    assert.match(await sheet(17).innerText(), /Synthetic page failure/);
    await screenshot('page-error-before-retry');
    await page.locator('[data-retry-page="17"]').click(); await ready(17); await waitPage(17);
    assert.equal(await page.locator('#detail-error').isVisible(), false);
    assert.equal(await page.locator('[data-retry-page="17"]').count(), 0);
    assert.equal(injectedFailures, 1); record('failed-page-retains-placeholder-and-explicit-retry-clears-error-and-loads-that-page');
    await jump(1);
    await page.locator('[data-tab="annotations"]').click();
    if (await page.locator('.library-pane #annotations-tab').isVisible()) await page.locator('#reading-sidebar-library').click();
    const colors = { highlight: '#fed766', underline: '#2674ba', strikeout: '#c53b45', note: '#3a9365' };
    for (const type of ['highlight', 'underline', 'strikeout', 'note']) {
      await page.locator(`#reader-tool-${type}`).click();
      await page.locator('#reader-color').evaluate((input, value) => { input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })); }, colors[type]);
      await ready(1);
      if (type === 'note') {
        const box = await sheet(1).boundingBox(); await page.mouse.click(box.x + box.width * .78, box.y + box.height * .4);
      } else {
        const start = sheet(1).locator('.pdr-word').filter({ hasText: /^Evidence\s*$/ }).first();
        const end = sheet(1).locator('.pdr-word').filter({ hasText: /^sentence\s*$/ }).first();
        await start.scrollIntoViewIfNeeded(); const a = await start.boundingBox(), b = await end.boundingBox();
        assert.ok(a && b); await page.mouse.move(a.x + 1, a.y + a.height * .5); await page.mouse.down();
        await page.mouse.move(b.x + b.width - 1, b.y + b.height * .5, { steps: 12 }); await page.mouse.up();
      }
      await page.locator('#annotation-dialog').waitFor();
      await page.locator('#annotation-comment').fill(`Synthetic UI ${type} comment`);
      await page.locator('#annotation-form button[type="submit"]').first().click();
      await page.locator('#annotation-dialog').waitFor({ state: 'hidden' }); await ready(1);
      const saved = (await core({ action: 'annotations', id: paper.id }, { library, python })).annotations.find(note => note.comment === `Synthetic UI ${type} comment`);
      assert.ok(saved, `Missing saved UI ${type}`); assert.equal(saved.type, type);
      const rgb = colors[type].slice(1).match(/../g).map(value => Number.parseInt(value, 16) / 255);
      saved.color.stroke.forEach((value, index) => assert.ok(Math.abs(value - rgb[index]) < .001));
    }
    await screenshot('four-saved-markup-types'); record('mouse-selection-and-page-click-save-four-standard-native-pdf-types-with-chosen-colors');
    await page.locator('#reader-tool-select').click(); await page.locator('#reader-annotations').click();
    await page.locator('.library-pane #annotations-tab').waitFor(); assert.equal(await page.locator('#reading-side-panel').isVisible(), false); await visiblePDF();
    await page.locator('#reading-sidebar-side').click();
    assert.equal(await page.locator('#reading-workspace').getAttribute('data-reading-side'), 'right');
    await screenshot('annotations-sidebar-right');
    await page.locator('#reading-sidebar-side').click();
    assert.equal(await page.locator('#reading-workspace').getAttribute('data-reading-side'), 'left');
    await screenshot('annotations-sidebar-left');
    const noteCard = page.locator('#annotation-list .annotation-card').filter({ hasText: 'Synthetic existing page 12 note' });
    await noteCard.locator('[data-note-action="page"]').click(); await waitPage(12); await ready(12); await visiblePDF();
    record('annotation-sidebar-switches-left-right-and-note-click-returns-to-page-12');
    // Free rail width: drag the divider, keep the PDF fitted, persist the choice.
    const railWidth = () => page.locator('.library-pane.shared-reading-sidebar').evaluate(node => Math.round(node.getBoundingClientRect().width));
    const pageWidth = () => page.locator('.pdr-page-slot').first().evaluate(node => Math.round(node.getBoundingClientRect().width));
    const railBefore = await railWidth(), pageBefore = await pageWidth();
    const handle = page.locator('#reading-rail-resizer');
    assert.equal(await handle.isVisible(), true, 'The rail divider is visible while the shared rail is open');
    const handleBox = await handle.boundingBox();
    await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + 60); await page.mouse.down();
    await page.mouse.move(handleBox.x + 150, handleBox.y + 60, { steps: 6 }); await page.mouse.up();
    const railAfter = await railWidth();
    assert.ok(railAfter > railBefore + 80, `Dragged rail widened from ${railBefore} to ${railAfter}`);
    await page.waitForFunction(previous => Math.round(document.querySelector('.pdr-page-slot').getBoundingClientRect().width) < previous, pageBefore);
    const fittedAfterDrag = await pageWidth();
    assert.ok(fittedAfterDrag < pageBefore, 'The PDF re-fits the narrower document pane after the drag');
    const savedLayout = await page.evaluate(() => persistence.get('reader:layout'));
    assert.equal(Math.round(savedLayout.rail_width), railAfter, 'The chosen rail width is saved on the host');
    record('rail-divider-drags-to-a-free-width-refits-the-pdf-and-persists');
    // Free zoom: fit-width default, explicit percentage, real horizontal scroll.
    assert.equal(await page.locator('#reader-zoom-percent').inputValue(), '100');
    await page.locator('#reader-zoom-in').click();
    await page.waitForFunction(previous => Math.round(document.querySelector('.pdr-page-slot').getBoundingClientRect().width) > previous, fittedAfterDrag);
    const magnified = await pageWidth();
    assert.ok(magnified > fittedAfterDrag);
    assert.ok(await reader.evaluate(node => node.scrollWidth - node.clientWidth) > 0, 'Magnified pages scroll horizontally instead of clipping');
    await page.locator('#reader-zoom-percent').fill('250'); await page.locator('#reader-zoom-percent').press('Enter');
    await page.waitForFunction(() => document.getElementById('reader-zoom-percent').value === '250');
    await page.waitForFunction(previous => Math.round(document.querySelector('.pdr-page-slot').getBoundingClientRect().width) > previous, magnified);
    assert.equal((await page.evaluate(() => persistence.get('reader:layout'))).zoom, 2.5);
    const magnified250 = await pageWidth();
    await page.locator('#reader-zoom-fit').click();
    await page.waitForFunction(previous => Math.round(document.querySelector('.pdr-page-slot').getBoundingClientRect().width) < previous, magnified250);
    assert.equal(await reader.evaluate(node => node.scrollWidth - node.clientWidth), 0, '全宽 removes the horizontal overflow');
    await page.evaluate(() => persistence.flush());
    record('fit-width-default-arbitrary-percentage-zoom-and-reset');
    await page.reload(); await page.waitForLoadState('domcontentloaded');
    await page.locator('#continuous-reader .pdr-page-image[src]').first().waitFor({timeout:30000});
    await visiblePDF();
    if(!(await page.locator('.workspace').evaluate(node => node.classList.contains('shared-sidebar-open'))))await page.locator('#reader-annotations').click();
    await page.locator('.library-pane #annotations-tab').waitFor();
    assert.equal(await page.locator('#reader-zoom-percent').inputValue(), '100', 'Zoom is restored from the saved layout');
    assert.ok(Math.abs(await railWidth() - railAfter) < 3, 'The rail width is restored in a fresh page');
    record('saved-rail-width-and-zoom-survive-a-reload');
    // Reader ↔ rail linking in both directions, on real saved markup.
    const markup = (await core({ action: 'annotations', id: paper.id }, { library, python })).annotations.find(note => note.comment === 'Synthetic UI highlight comment');
    assert.ok(markup, 'The saved highlight is available for linking');
    const cardFor = id => page.locator(`#annotation-list > .annotation-card[data-annotation-id="${id}"]`);
    await jump(1); await ready(1);
    await cardFor(markup.id).click();
    await page.locator('.pdr-annotation-flash').first().waitFor();
    assert.equal(await cardFor(markup.id).evaluate(node => node.classList.contains('is-linked')), true);
    record('rail-card-click-reveals-and-flashes-the-matching-pdf-markup');
    const target = await page.evaluate(async ({ paperId, annotationId }) => {
      const call = async (action, args = {}) => (await (await fetch('./api', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, ...args }) })).json()).result;
      const notes = (await call('annotations', { id: paperId })).annotations;
      const note = notes.find(value => value.id === annotationId);
      if (!note) return { ok: false, reason: 'missing annotation' };
      const layout = await call('page_layout', { id: paperId });
      const sheet = document.querySelector(`.pdr-sheet[data-pdf-page="${note.page}"]`);
      if (!sheet) return { ok: false, reason: 'page not rendered' };
      const box = sheet.getBoundingClientRect(), geometry = layout.pages[note.page - 1], rect = note.rects[0];
      return { ok: true, x: box.left + (rect[0] + rect[2]) / 2 / geometry.width * box.width, y: box.top + (rect[1] + rect[3]) / 2 / geometry.height * box.height };
    }, { paperId: paper.id, annotationId: markup.id });
    assert.equal(target.ok, true, `Markup point unavailable: ${target.reason || ''}`);
    await page.mouse.click(target.x, target.y);
    await page.waitForFunction(id => document.querySelector(`#annotation-list > .annotation-card[data-annotation-id="${CSS.escape(id)}"]`)?.classList.contains('is-linked'), markup.id);
    assert.ok(await page.locator('.pdr-annotation-flash').count() > 0, 'Clicking markup also flashes it');
    record('clicking-pdf-markup-links-its-rail-card');
    await jump(12); await ready(12);
    await page.locator('#reading-sidebar-library').click();
    await page.locator('#metadata-open').click(); await page.locator('#metadata-dialog').waitFor();
    assert.equal(await page.locator('#metadata-dialog').evaluate(dialog => dialog.matches(':modal')), false);
    await visiblePDF(); await page.locator('#edit-title').fill(`${paper.title} edited in sidebar`);
    await screenshot('metadata-nonmodal-sidebar');
    await page.locator('#metadata-form button[type="submit"]').click();
    await page.locator('#metadata-dialog').waitFor({ state: 'hidden' }); await visiblePDF(); await waitPage(12);
    assert.equal((await core({ action: 'get', id: paper.id }, { library, python })).title, `${paper.title} edited in sidebar`);
    await page.locator('#metadata-open').click(); await page.locator('#metadata-dialog').waitFor();
    assert.equal(await page.locator('#edit-title').inputValue(), `${paper.title} edited in sidebar`);
    await page.getByRole('button', { name: '收起阅读侧栏', exact: true }).click(); await visiblePDF();
    record('metadata-sidebar-is-nonmodal-saves-record-and-closes-back-to-same-pdf-page');
    await page.locator('#reader-fullscreen').click();
    await page.waitForFunction(() => document.body.classList.contains('reader-focused')); await visiblePDF();
    await screenshot('fullscreen-741'); await page.locator('#reader-fullscreen').click();
    await page.waitForFunction(() => !document.body.classList.contains('reader-focused')); await visiblePDF();
    record('fullscreen-entry-and-exit-preserve-visible-pdf');
    await page.locator('#citation-tools > summary').click(); await page.locator('#copy-apa').click();
    await page.waitForFunction(() => !document.getElementById('copy-apa').disabled);
    assert.match(await page.evaluate(() => navigator.clipboard.readText()), /Synthetic continuous reader acceptance edited in sidebar/);
    const downloadPromise = page.waitForEvent('download'); await page.locator('#export-bib').click(); const download = await downloadPromise;
    assert.ok(download.suggestedFilename().endsWith('.bib')); const bibPath = join(run, 'synthetic.bib'); await download.saveAs(bibPath);
    assert.match(await readFile(bibPath, 'utf8'), /SyntheticReader2026/); record('contextual-citation-ribbon-copies-apa-and-downloads-biblatex');
    await page.locator('[data-tab="conversation"]').click(); await page.locator('#reading-chat-panel').waitFor(); await visiblePDF();
    const draft = 'Synthetic private draft retained when the floating conversation closes.';
    await page.locator('#paper-chat-input').fill(draft); await page.getByRole('button', { name: '关闭浮动对话', exact: true }).click();
    await page.locator('#reading-chat-panel').waitFor({ state: 'hidden' }); await visiblePDF();
    await page.locator('[data-tab="conversation"]').click(); await page.locator('#reading-chat-panel').waitFor();
    assert.equal(await page.locator('#paper-chat-input').inputValue(), draft);
    await screenshot('floating-chat-retained-draft');
    await page.locator('#reading-chat-collapse').click(); await visiblePDF(); await page.locator('#reading-chat-collapse').click();
    assert.equal(await page.locator('#paper-chat-input').inputValue(), draft);
    await page.getByRole('button', { name: '关闭浮动对话', exact: true }).click(); record('floating-conversation-keeps-pdf-visible-and-preserves-draft-on-close-and-collapse');
    for (const [width, height] of [[430, 800], [1400, 950], [741, 597]]) {
      await page.setViewportSize({ width, height }); await visiblePDF(); assert.equal(await overflow(), false);
      await page.waitForFunction(() => {
        const number = document.getElementById('page-number').value;
        const reader = document.getElementById('continuous-reader');
        const image = document.querySelector(`.pdr-sheet[data-pdf-page="${number}"] .pdr-page-image`);
        const expectedWidth = Math.min(1100, reader.clientWidth - 24);
        return image?.complete && Math.abs(image.getBoundingClientRect().width - expectedWidth) < 1 && image.naturalWidth >= expectedWidth * .95;
      });
      await screenshot(`reader-final-${width}`);
    }
    record('741-430-1400px-reader-viewports-have-no-document-horizontal-overflow');
    await page.locator('#reading-sidebar-annotations').click();
    await page.locator('.library-pane #annotations-tab').waitFor();
    const annotationReturnPage = await page.locator('#page-number').inputValue();
    await page.locator('#workspace-library').click(); await page.locator('#catalog-table table').waitFor();
    assert.equal(await page.locator('[data-tab="annotations"]').getAttribute('aria-pressed'), 'false');
    assert.equal(await page.locator('.library-pane #annotations-tab').isVisible(), false);
    await page.locator('[data-tab="annotations"]').click();
    await page.locator('#catalog-table').waitFor({ state: 'hidden' });
    await page.locator('.library-pane #annotations-tab').waitFor();
    assert.equal(await page.locator('#reading-side-panel').isVisible(), false);
    assert.equal(await page.locator('#page-number').inputValue(), annotationReturnPage);
    await visiblePDF();
    assert.equal(await page.locator('#annotation-list .annotation-card').count(), 5);
    await page.locator('#reading-sidebar-library').click();
    record('annotation-ribbon-reopens-preserved-shared-notes-from-expanded-table');
    await page.locator('#workspace-library').click(); await page.locator('#catalog-table table').waitFor();
    await page.locator('#search').fill('Synthetic reader catalog'); await page.locator('#list-range').filter({ hasText: '1–40 / 44' }).waitFor();
    await page.locator('#catalog-sort').selectOption('title'); await page.locator('#next-list').click();
    await page.locator('#list-range').filter({ hasText: '41–44 / 44' }).waitFor();
    await page.locator('#catalog-create').click(); await page.locator('#edit-title').waitFor();
    await page.waitForFunction(()=>!document.getElementById('metadata-form').inert);
    await page.locator('#edit-title').fill('Synthetic reader CRUD record'); await page.locator('#metadata-form button[type="submit"]').click();
    await page.locator('#metadata-dialog').waitFor({ state: 'hidden' });
    if (!(await page.locator('#catalog-table').isVisible())) await page.locator('#workspace-library').click();
    await page.locator('#search').fill('Synthetic reader CRUD');
    await page.locator('#catalog-table .table-title').filter({ hasText: 'Synthetic reader CRUD record' }).waitFor();
    let row = page.locator('#catalog-table tbody tr').first(); await row.getByRole('button', { name: '编辑', exact: true }).click();
    await page.waitForFunction(()=>!document.getElementById('metadata-form').inert);
    await page.locator('#edit-title').fill('Synthetic reader CRUD edited'); await page.locator('#metadata-form button[type="submit"]').click();
    await page.locator('#metadata-dialog').waitFor({ state: 'hidden' });
    if (!(await page.locator('#catalog-table').isVisible())) await page.locator('#workspace-library').click();
    await page.locator('#catalog-table .table-title').filter({ hasText: 'CRUD edited' }).waitFor();
    row = page.locator('#catalog-table tbody tr').first(); await row.getByRole('button', { name: '移入回收站', exact: true }).click();
    await page.locator('#list-range').filter({ hasText: '0 篇' }).waitFor(); await page.locator('#catalog-scope').selectOption('archived');
    await page.getByRole('button', { name: '恢复', exact: true }).click(); await page.locator('#list-range').filter({ hasText: '0 篇' }).waitFor();
    await page.locator('#catalog-scope').selectOption('active'); await page.locator('#catalog-table .table-title').filter({ hasText: 'CRUD edited' }).waitFor();
    assert.equal(await overflow(), false); await screenshot('catalog-final-741'); record('ribbon-library-entry-retains-pagination-create-edit-trash-and-restore');
    // A catalog title click now opens the reader directly; the table collapses.
    const selectCatalogPaper = async selected => {
      if (!(await page.locator('#catalog-table').isVisible())) await page.locator('#workspace-library').click();
      await page.locator('#search').fill(selected.title);
      const title = page.locator(`#catalog-table tr[data-paper-id="${selected.id}"] .table-title`);
      await title.waitFor();
      await title.click();
      await page.locator('#catalog-table').waitFor({ state: 'hidden' });
      await page.locator('#toolbar-paper').filter({ hasText: selected.title }).waitFor();
    };
    const assertReadingIdentity = async selected => {
      await page.locator('#catalog-table').waitFor({ state: 'hidden' });
      await reader.waitFor();
      const count = selected.id === secondPaper.id ? 2 : 24;
      await page.waitForFunction(count => {
        const root = document.getElementById('continuous-reader');
        const number = document.getElementById('page-number').value;
        const image = root.querySelector(`.pdr-sheet[data-pdf-page="${number}"] .pdr-page-image`);
        return root.querySelectorAll('.pdr-page-slot').length === count && image?.complete && image.getBoundingClientRect().height > 0;
      }, count);
      const currentPage = Number(await page.locator('#page-number').inputValue());
      await ready(currentPage); await visiblePDF();
      assert.match(await page.locator('#toolbar-paper').innerText(), new RegExp(selected.title));
      assert.equal(await reader.locator('.pdr-page-slot').count(), count);
      if (selected.id === secondPaper.id) await sheet(currentPage).locator('.pdr-word').filter({ hasText: 'SecondIdentityProof' }).waitFor();
      else await sheet(currentPage).locator('.pdr-word').filter({ hasText: /^Evidence\s*$/ }).first().waitFor();
      assert.equal(apiCalls.filter(call => call.action === 'page').at(-1).id, selected.id);
    };
    await selectCatalogPaper(paper); await assertReadingIdentity(paper);
    for (const entry of ['reader', 'fullscreen', 'library-collapse']) {
      await selectCatalogPaper(secondPaper);
      if (entry === 'fullscreen') await page.locator('#reader-fullscreen').click();
      if (entry === 'library-collapse') {
        await page.locator('#workspace-library').click(); await page.locator('#catalog-table').waitFor();
        await page.locator(`#catalog-table tr[data-paper-id="${secondPaper.id}"] .table-title`).click();
        await page.locator('#catalog-table').waitFor({ state: 'hidden' });
      }
      await assertReadingIdentity(secondPaper);
      if (entry === 'fullscreen') {
        await page.waitForFunction(() => document.body.classList.contains('reader-focused'));
        await page.locator('#workspace-library').click(); await page.locator('#catalog-table').waitFor();
        await page.waitForFunction(() => !document.body.classList.contains('reader-focused') && !document.fullscreenElement);
      }
      await screenshot(`cross-paper-${entry}`);
      await selectCatalogPaper(paper); await assertReadingIdentity(paper);
    }
    record('table-title-click-opens-correct-pdf-through-reading-fullscreen-and-library-collapse');
    record('fullscreen-to-library-exits-focus-and-displays-catalog');
    assert.equal(await digest(sourcePath), originalHash); record('synthetic-original-pdf-remains-byte-identical');
    assert.equal(await digest(secondSourcePath), secondOriginalHash);
    const peak = await page.evaluate(() => window.readerFixtureMeasurements.maxResidentImages);
    assert.ok(peak >= 1 && peak <= 3, `Resident image peak ${peak}`); assert.equal(maxInFlightPages, 1);
    record('continuous-reader-retains-at-most-three-images-and-one-page-request-in-flight');
    assert.equal(apiCalls.filter(call => call.action === 'ai_feedback' || call.action === 'chat_send').length, 0);
    assert.deepEqual(unexpectedRemote, []); assert.deepEqual(errors, []); record('no-model-requests-external-network-or-browser-runtime-errors');
    finalReport = { verified_at: new Date().toISOString(), checks, viewports: [[741, 597], [430, 800], [1400, 950]],
      page_count: 24, resident_image_peak: peak, max_in_flight_page_requests: maxInFlightPages, injected_page_failures: injectedFailures,
      browser_errors: errors, model_requests: 0, external_requests: 0, synthetic_original_unchanged: true,
      scope: 'Synthetic standalone UI behavior only; native model integration and long-session memory measured separately; no formal user validation', screenshots };
  }
} catch (error) {
  console.error(error); process.exitCode = 1;
  if (page) { await page.screenshot({ path: join(run, 'failure.png') }).catch(() => {}); await writeFile(join(run, 'failure-dom.txt'), await page.locator('body').innerText().catch(() => 'Unavailable')); }
  await writeFile(join(run, 'failure.json'), JSON.stringify({ error: error.stack, checks, errors, maxInFlightPages, apiCalls, unexpectedRemote }, null, 2));
} finally {
  clearTimeout(startTimer); await browser?.close(); await stopServer(); await writeFile(join(run, 'server.log'), serverLog);
}
if (finalReport && !process.exitCode) {
  if (!finalReport.recon) await writeFile(join(project, 'docs/validation/reader-browser.json'), JSON.stringify({ ...finalReport, isolated_server_stopped: true }, null, 2) + '\n');
  console.log(JSON.stringify({ run: relative(project, run), checks: checks.length, errors, recon: Boolean(finalReport.recon) }));
} else console.log(JSON.stringify({ run: relative(project, run), checks: checks.length, errors, failed: true }));
