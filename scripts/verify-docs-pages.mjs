/** Check the documentation site as GitHub Pages serves it.
 *
 * The other two receipts prove the build on this machine. This one reads the deployed URL, so a
 * stale artifact, a path that only works because a local server happened to mount `/docs/`, or an
 * asset the workflow forgot to upload fails here instead of in front of a reader.
 *
 * Run: PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node scripts/verify-docs-pages.mjs
 *      SITE_URL=https://<owner>.github.io/<repo>/ to point it somewhere else.
 */
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const project = dirname(dirname(fileURLToPath(import.meta.url)));
const site = (process.env.SITE_URL ?? 'https://mappedinfo.github.io/dsh-paper-library/').replace(/\/?$/, '/');
const docs = `${site}docs/`;
const settle = Number(process.env.DOCS_SETTLE_MS ?? 1500);
const checks = [];
const observations = {};
const record = (label, detail = {}) => { checks.push(label); Object.assign(observations, detail); console.log(`PASS ${label} — ${JSON.stringify(detail)}`); };

/** Where a floating book has to end up: the centre of its own shelf slot, inside its shelf cell. */
const BOOK_GEOMETRY = `(() => {
  const slots = [...document.querySelectorAll('#bookcase .slot')];
  const rows = [];
  for (const slot of slots) {
    const book = document.querySelector('.book[data-slot="' + CSS.escape(slot.dataset.href) + '"]')
      || [...document.querySelectorAll('.book')].find(node => decodeURIComponent(node.getAttribute('href')) === decodeURIComponent(slot.dataset.href));
    if (!book) { rows.push({ missing: slot.dataset.href }); continue; }
    const s = slot.getBoundingClientRect();
    const b = book.getBoundingClientRect();
    const cell = slot.closest('.cell').getBoundingClientRect();
    rows.push({
      href: slot.dataset.href,
      distance: Math.hypot((b.left + b.width / 2) - (s.left + s.width / 2), (b.top + b.height / 2) - (s.top + s.height / 2)),
      inCell: b.left >= cell.left - 10 && b.right <= cell.right + 10 && b.bottom <= cell.bottom + 16 && b.top >= cell.top - 40,
    });
  }
  const numbers = rows.filter(row => typeof row.distance === 'number');
  return {
    missing: rows.filter(row => row.missing).map(row => row.missing),
    mean: numbers.reduce((sum, row) => sum + row.distance, 0) / (numbers.length || 1),
    offShelf: numbers.filter(row => !row.inCell).map(row => row.href),
  };
})()`;

const get = async url => {
  const response = await fetch(url, { cache: 'no-store' });
  return { status: response.status, body: await response.text() };
};

/* ================= the files the deployment serves ================= */
const index = JSON.parse((await get(`${docs}_assets/search.json`)).body);
assert.ok(Array.isArray(index.entries) && index.entries.length >= 40, `the live index should cover the corpus, found ${index.entries?.length}`);
const served = [];
for (const entry of index.entries) {
  const page = await get(new URL(entry.href, docs));
  if (page.status !== 200 || !page.body.includes('<h1')) served.push(`${entry.href} → ${page.status}`);
}
assert.deepEqual(served, [], `pages GitHub Pages does not serve: ${served.slice(0, 6).join(', ')}`);
const landing = await get(docs);
assert.equal(landing.status, 200, 'the landing page is served');
assert.ok(landing.body.includes('id="bookcase"'), 'the deployed landing carries the shelf scaffolding, not a placeholder');
const manifest = JSON.parse(/<script type="application\/json" id="books">([\s\S]*?)<\/script>/.exec(landing.body)[1]);
assert.equal(manifest.length, index.entries.length, 'the deployed book manifest matches the deployed index');
record('every-indexed-page-and-the-landing-are-served-by-github-pages', { live_pages: index.entries.length, live_books: manifest.length });

let browser;
const errors = [], external = [], failed = [];
const watch = page => {
  page.on('pageerror', error => errors.push(`pageerror: ${error.message}`));
  page.on('request', request => {
    const url = request.url();
    if (!url.startsWith(site) && !url.startsWith('data:') && !url.startsWith('blob:')) external.push(url);
  });
  page.on('response', response => { if (response.status() >= 400) failed.push(`HTTP ${response.status()} ${response.url()}`); });
};

try {
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
  browser = await chromium.launch({ headless: true });

  /* ================= the scene, over the public network ================= */
  const desktop = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await desktop.newPage();
  watch(page);
  await page.goto(docs, { waitUntil: 'load' });
  await page.waitForFunction(() => document.querySelectorAll('.book').length > 0);
  await page.waitForTimeout(500);

  const meta = await page.evaluate(() => ({
    books: document.querySelectorAll('.book').length,
    slots: document.querySelectorAll('#bookcase .slot').length,
    cells: document.querySelectorAll('.cell').length,
  }));
  const shelves = new Set(index.entries.map(entry => entry.shelf)).size;
  assert.equal(meta.books, index.entries.length, 'every indexed document floats as a book on the live site');
  assert.equal(meta.books, meta.slots, 'each live book has exactly one shelf slot');
  assert.equal(meta.cells, shelves, 'one shelf per documented topic on the live site');
  record('the-live-scene-is-built-from-the-live-index', { ...meta, shelves });

  const tall = await page.evaluate(() => {
    const drive = document.getElementById('drive');
    window.scrollTo(0, (drive.offsetHeight - window.innerHeight) * 1);
    return drive.offsetHeight - window.innerHeight;
  });
  assert.ok(tall > 1000, `the deployed page should be tall enough to walk, measured ${tall}px`);
  await page.waitForTimeout(settle);
  const y = await page.evaluate(() => window.scrollY);
  assert.ok(y > tall * 0.9, `the live page holds the scroll position (reached ${Math.round(y)} of ${tall}px)`);
  const shelved = await page.evaluate(BOOK_GEOMETRY);
  assert.deepEqual(shelved.missing, [], 'no live book lost its slot');
  assert.ok(shelved.mean < 30, `live books stand in their slots (mean ${shelved.mean.toFixed(1)}px)`);
  assert.deepEqual(shelved.offShelf, [], `books hanging off a live shelf: ${shelved.offShelf.slice(0, 4).join(', ')}`);
  record('scrolling-on-the-live-site-shelves-every-book', { scroll_y: Math.round(y), mean: Math.round(shelved.mean) });

  /* opening one must show the words the deployed document has, not the ones on this disk */
  const href = await page.locator('#cell-reading .slot').nth(1).getAttribute('data-href');
  const book = page.locator(`.book[href="${href}"]`);
  await book.click();
  await page.waitForTimeout(600);
  const reader = await page.evaluate(() => ({
    open: !document.getElementById('reader').hidden,
    marks: document.querySelectorAll('#reader mark.hl').length,
    demoLabel: document.querySelector('#reader .margin-head em')?.textContent,
    raw: document.getElementById('reader-text').textContent.replace(/\s+/g, ' ').slice(0, 60),
  }));
  assert.ok(reader.open, 'a live book opens into the reading panel');
  assert.ok(reader.marks >= 1, 'the live panel highlights a sentence');
  assert.ok(reader.demoLabel?.includes('演示'), 'the live annotations are still labelled as demo notes');
  const deployed = await get(new URL(href, docs));
  assert.equal(deployed.status, 200, `the document behind the opened book is served: ${href}`);
  const published = deployed.body.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  assert.ok(published.includes(reader.raw), `the opened text is not verbatim from the deployed document\n  panel: ${reader.raw}\n  doc  : ${published.slice(0, 120)}`);
  record('a-live-book-opens-on-words-the-deployed-document-really-has', { href, marks: reader.marks });

  /* search and a section deep link, both against the deployed index, from a document page */
  await page.goto(String(new URL(href, docs)), { waitUntil: 'load' });
  await page.locator('#q').waitFor();
  await page.fill('#q', '批注');
  await page.waitForTimeout(1200);
  const found = await page.evaluate(() => {
    const box = document.getElementById('results');
    return { hits: box.querySelectorAll('.hit').length, marks: box.querySelectorAll('mark').length };
  });
  assert.ok(found.hits >= 3, `live search should span the corpus, got ${found.hits}`);
  assert.ok(found.marks >= 1, 'live results mark the matched words');
  await page.locator('#results .more a').first().click();
  await page.waitForLoadState('load');
  const deep = await page.evaluate(() => ({
    hash: location.hash,
    heading: document.getElementById(decodeURIComponent(location.hash.slice(1)))?.tagName ?? null,
  }));
  assert.ok(deep.heading, `a live search result lands on the matched section (hash ${deep.hash})`);
  record('live-search-marks-hits-and-jumps-to-that-section', { ...found, heading: deep.heading });

  /* a phone reading it in the open */
  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const phone = await mobile.newPage();
  watch(phone);
  await phone.goto(docs, { waitUntil: 'load' });
  await phone.waitForFunction(() => document.querySelectorAll('.book').length > 0);
  await phone.waitForTimeout(500);
  const phoneTop = await phone.evaluate(() => ({
    overflow: document.documentElement.scrollWidth - window.innerWidth,
    books: document.querySelectorAll('.book').length,
  }));
  assert.equal(phoneTop.overflow, 0, `the live phone page scrolls sideways by ${phoneTop.overflow}px`);
  await phone.evaluate(() => {
    const drive = document.getElementById('drive');
    window.scrollTo(0, (drive.offsetHeight - window.innerHeight) * 1);
  });
  await phone.waitForTimeout(settle);
  const phoneShelf = await phone.evaluate(BOOK_GEOMETRY);
  assert.ok(phoneShelf.mean < 34, `phones shelve the books on the live site too (mean ${phoneShelf.mean.toFixed(1)}px)`);
  record('a-phone-loads-and-shelves-the-live-site-without-side-scroll', { ...phoneTop, mean: Math.round(phoneShelf.mean) });

  assert.deepEqual(errors, [], `page errors on the live site: ${errors.slice(0, 3).join(' | ')}`);
  assert.deepEqual(external, [], `the live site asks a third-party server: ${[...new Set(external)].slice(0, 4).join(', ')}`);
  assert.deepEqual(failed, [], `failed requests on the live site: ${failed.slice(0, 4).join(', ')}`);
  record('the-live-site-asks-nothing-outside-github-pages-and-fails-nothing', { requests_outside_pages: 0, failed: 0 });
} finally {
  await browser?.close();
}

await writeFile(join(project, 'docs', 'validation', 'docs-site-live.json'), JSON.stringify({
  verified_at: new Date().toISOString(),
  site,
  scope: 'The deployed GitHub Pages documentation site, read over the public network in real Chromium: every indexed page served, the live scene built from the live index, shelving completing, an opened book quoting the deployed document verbatim, search and section deep links, a phone layout, and no request outside Pages or failed response. It is a functional check of the public service, not an availability, latency or security measurement.',
  checks, checks_count: checks.length, ...observations,
}, null, 2) + '\n');
console.log(`receipt: docs/validation/docs-site-live.json (${checks.length} checks)`);
