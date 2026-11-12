/** Run the generated documentation site in a real browser and prove the acceptance pictures.
 *
 * Checks are functional, not cosmetic: a book may only exist if a markdown file backs it, the
 * hero text may not be covered by the floating wall, the shelving must be one continuous path,
 * the opened book must show text that really occurs in the document, and the shelf must navigate.
 * Screenshots are written for a person to look at; every assertion below also stands alone.
 *
 * Run: PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node scripts/docs-site-browser-fixture.mjs
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, join, normalize, posix, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDocsSite } from './build-docs-site.mjs';

const project = dirname(dirname(fileURLToPath(import.meta.url)));
const siteRoot = resolve(process.env.SITE_DIR ?? join(project, '_site'));
const docsRoot = join(siteRoot, 'docs');
const shots = resolve(process.env.DOCS_SHOTS_DIR ?? join(project, 'artifacts', 'docs-site'));
const receiptPath = join(project, 'docs', 'validation', 'docs-site-browser.json');
const types = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.zip': 'application/zip',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

const checks = [];
const screenshots = [];
const record = (label, detail) => {
  checks.push({ label, ...(detail ? { detail } : {}) });
  console.log(`PASS ${label}${detail ? ` — ${JSON.stringify(detail)}` : ''}`);
};

async function serve() {
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    let path = decodeURIComponent(url.pathname);
    if (path.endsWith('/')) path += 'index.html';
    const file = normalize(join(siteRoot, path));
    if (!file.startsWith(siteRoot)) {
      response.writeHead(403).end('no');
      return;
    }
    try {
      const info = await stat(file);
      if (info.isDirectory()) throw new Error('directory');
      const body = await readFile(file);
      response.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
      response.end(body);
    } catch {
      response.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
    }
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

async function walk(dir, base = '') {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const rel = posix.join(base, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(join(dir, entry.name), rel)));
    else out.push(rel);
  }
  return out;
}

/** Every local href/src a reader can click must exist, or the build is lying about its links. */
async function auditLinks() {
  const files = (await walk(docsRoot)).filter(name => name.endsWith('.html'));
  const broken = [];
  let scanned = 0;
  for (const name of files) {
    const html = await readFile(join(docsRoot, name), 'utf8');
    for (const match of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
      const raw = match[1];
      if (/^(https?:|mailto:|data:|#)/.test(raw)) continue;
      const clean = raw.split('#')[0].split('?')[0];
      if (!clean) continue;
      const abs = normalize(join(docsRoot, dirname(name), decodeURIComponent(clean)));
      scanned += 1;
      try {
        await stat(abs);
      } catch {
        broken.push(`${name} -> ${raw}`);
      }
    }
  }
  return { pages: files.length, links: scanned, broken };
}

const BOOK_GEOMETRY = `(() => {
  const stage = document.getElementById('stage').getBoundingClientRect();
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
      rect: { left: b.left, top: b.top, right: b.right, bottom: b.bottom },
    });
  }
  const numbers = rows.filter(row => typeof row.distance === 'number');
  return {
    count: rows.length,
    missing: rows.filter(row => row.missing).map(row => row.missing),
    mean: numbers.reduce((sum, row) => sum + row.distance, 0) / (numbers.length || 1),
    max: numbers.reduce((worst, row) => Math.max(worst, row.distance), 0),
    offShelf: numbers.filter(row => !row.inCell).map(row => row.href),
    rects: numbers.map(row => row.rect),
    centres: numbers.map(row => [(row.rect.left + row.rect.right) / 2, (row.rect.top + row.rect.bottom) / 2]),
  };
})()`;

const HERO_TEXT = `(() => {
  const rects = ['h1', '.lede', '.cta', '.kicker', '.hint'].map(sel => document.querySelector('.hero ' + sel)?.getBoundingClientRect()).filter(Boolean);
  const union = rects.reduce((acc, r) => ({ left: Math.min(acc.left, r.left), top: Math.min(acc.top, r.top), right: Math.max(acc.right, r.right), bottom: Math.max(acc.bottom, r.bottom) }), { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity });
  const overlap = (a, b) => Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
  const books = [...document.querySelectorAll('.book')].map(node => node.getBoundingClientRect());
  const covering = books.filter(rect => overlap(rect, union) > 40).length;
  const visible = books.filter(rect => rect.bottom > 0 && rect.top < innerHeight && rect.width > 0).length;
  return { union, covering, visible, total: books.length };
})()`;

async function scrollToProgress(page, p) {
  const y = await page.evaluate(progress => {
    const drive = document.getElementById('drive');
    return (drive.offsetHeight - window.innerHeight) * progress;
  }, p);
  await page.evaluate(top => window.scrollTo(0, top), y);
  await page.waitForTimeout(reduceWait());
}

const reduceWait = () => Number(process.env.DOCS_SETTLE_MS ?? 1100);

async function main() {
  await mkdir(shots, { recursive: true });
  const built = await buildDocsSite({ outDir: siteRoot });

  const links = await auditLinks();
  assert.equal(links.broken.length, 0, `broken local links: ${links.broken.slice(0, 8).join(', ')}`);
  record('every-local-link-in-the-generated-pages-resolves', { pages: links.pages, links: links.links });

  const { server, origin } = await serve();
  const errors = [];
  const external = [];
  const failed = [];
  const network = { errors, external, failed };
  let browser;
  try {
    const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
    browser = await chromium.launch({ headless: true });

    /* ================= desktop ================= */
    const desktop = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    const page = await desktop.newPage();
    watch(page, network);
    await page.goto(`${origin}/docs/`, { waitUntil: 'load' });
    await page.waitForFunction(() => document.querySelectorAll('.book').length > 0);
    await page.waitForTimeout(300);

    const meta = await page.evaluate(() => ({
      books: document.querySelectorAll('.book').length,
      slots: document.querySelectorAll('#bookcase .slot').length,
      cells: document.querySelectorAll('.cell').length,
      cards: document.querySelectorAll('.card').length,
      titles: [...document.querySelectorAll('.book .title')].length,
      faces: document.querySelectorAll('.face').length,
      marks: [...document.querySelectorAll('.ribbon, .tab, .sticky')].length,
      driveHeight: document.getElementById('drive').offsetHeight,
    }));
    assert.ok(meta.books >= 40, `the void should hold dozens of books, found ${meta.books}`);
    assert.equal(meta.books, meta.slots, 'each floating book has exactly one shelf slot');
    assert.equal(meta.cells, built.shelves.length, 'one shelf per documented topic');
    assert.ok(meta.cards >= meta.books, 'the catalog repeats the shelf navigation as text');
    record('the-scene-is-built-from-real-documents', meta);

    await scrollToProgress(page, 0);
    const first = await page.evaluate(HERO_TEXT);
    assert.ok(first.visible >= meta.books * 0.7, `most books must be in view at once, saw ${first.visible}`);
    assert.equal(first.covering, 0, `${first.covering} books cover the hero text — the centre must stay clear`);
    await page.screenshot({ path: join(shots, 'desktop-01-floating.png') });
    screenshots.push('desktop-01-floating.png');
    record('first-frame-is-a-sea-of-books-with-a-clear-centre', { visible: first.visible, covering: first.covering });

    /* continuity: the same elements travel, they do not teleport or swap */
    const samples = [];
    for (const p of [0, 0.2, 0.4, 0.55, 0.7, 0.85, 1]) {
      await scrollToProgress(page, p);
      samples.push({ p, ...(await page.evaluate(BOOK_GEOMETRY)) });
      if (p === 0.4) {
        await page.screenshot({ path: join(shots, 'desktop-02-shelving.png') });
        screenshots.push('desktop-02-shelving.png');
      }
    }
    assert.deepEqual(samples.at(-1).missing, [], 'no book lost its slot');
    const means = samples.map(sample => sample.mean);
    assert.ok(means[0] > 160, `books start scattered far from the shelf (mean ${means[0].toFixed(0)}px)`);
    for (let i = 1; i < means.length; i += 1) {
      assert.ok(means[i] <= means[i - 1] + 12, `the path backfired between p=${samples[i - 1].p} and p=${samples[i].p}`);
    }
    assert.ok(means.at(-1) < 26, `at full scroll the books stand in their slots (mean ${means.at(-1).toFixed(1)}px)`);
    record('shelving-is-one-continuous-path-that-ends-on-the-shelf', {
      mean_px_at_progress: samples.map(sample => ({ p: sample.p, mean: Math.round(sample.mean) })),
    });

    const settled = samples.at(-1);
    assert.deepEqual(settled.offShelf, [], `books left floating outside a shelf: ${settled.offShelf.slice(0, 4)}`);
    await page.screenshot({ path: join(shots, 'desktop-03-shelved.png') });
    screenshots.push('desktop-03-shelved.png');
    record('all-books-rest-inside-their-topic-shelf', { off_shelf: settled.offShelf.length, cells: meta.cells });

    /* hover: the book comes out and shows real text */
    const target = page.locator('#cell-reading .slot').nth(1);
    const href = await target.getAttribute('data-href');
    const bookNode = page.locator(`.book[href="${href}"]`);
    await bookNode.hover();
    await page.waitForTimeout(600);
    const tipInfo = await page.evaluate(() => {
      const tip = document.querySelector('.tip');
      return { on: tip.classList.contains('is-on'), text: tip.textContent, box: tip.getBoundingClientRect().width };
    });
    assert.ok(tipInfo.on, 'hovering a shelved book reveals its preview');
    assert.ok(tipInfo.text.length > 40, 'the preview carries real content, not a caption');
    await page.screenshot({ path: join(shots, 'desktop-04-hover.png') });
    screenshots.push('desktop-04-hover.png');
    record('hover-pulls-the-book-out-and-previews-its-first-paragraph', { chars: tipInfo.text.length });

    /* click: the reading panel, with marks over a genuine excerpt */
    await bookNode.click();
    await page.waitForTimeout(500);
    const reader = await page.evaluate(() => {
      const panel = document.getElementById('reader');
      return {
        open: !panel.hidden,
        title: document.getElementById('reader-title').textContent,
        meta: document.getElementById('reader-meta').textContent,
        marks: panel.querySelectorAll('mark.hl').length,
        margin: document.getElementById('reader-note').textContent,
        sticky: document.getElementById('reader-sticky').textContent,
        demoLabel: panel.querySelector('.margin-head em')?.textContent,
        index: [...panel.querySelectorAll('.page-index a')].map(a => a.getAttribute('href')),
        raw: document.getElementById('reader-text').textContent.replace(/\s+/g, ' ').slice(0, 60),
        position: getComputedStyle(panel).position,
      };
    });
    assert.ok(reader.open, 'the book opens into a panel');
    assert.equal(reader.position, 'fixed', 'the reading panel is stable, not drifting');
    assert.ok(reader.marks >= 1, 'a sentence is highlighted');
    assert.ok(reader.demoLabel?.includes('演示'), 'the annotations are labelled as demo notes');
    assert.ok(reader.index.length >= 1, 'the tucked-in tags link into the document');
    const docText = await page.evaluate(async path => {
      const response = await fetch(path);
      const doc = new DOMParser().parseFromString(await response.text(), 'text/html');
      return (doc.querySelector('.reading')?.textContent ?? '').replace(/\s+/g, ' ');
    }, href);
    assert.ok(
      docText.includes(reader.raw),
      `the opened text is verbatim from the published document\n  panel: ${reader.raw}\n  doc  : ${docText.slice(0, 120)}`,
    );
    await page.screenshot({ path: join(shots, 'desktop-05-open-book.png') });
    screenshots.push('desktop-05-open-book.png');
    record('opening-a-book-shows-a-seriously-read-page-of-real-text', { title: reader.title, marks: reader.marks, tags: reader.index.length });

    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => document.getElementById('reader').hidden), true, 'Escape closes the book');

    /* the shelf navigates: card link -> document page with TOC and working search */
    await page.locator('.card:has(.tags i) .card-link').first().click();
    await page.waitForLoadState('load');
    await page.waitForTimeout(400);
    const article = await page.evaluate(() => {
      const heads = [...document.querySelectorAll('.reading h1, .reading h2, .reading h3')];
      const clean = el => el.textContent.replace(/^[#\s]+/, '').trim();
      return {
        title: heads.length ? clean(heads[0]) : '',
        h1s: document.querySelectorAll('.reading h1').length,
        repeatedTitle: heads.length > 1 && clean(heads[0]) === clean(heads[1]),
        toc: document.querySelectorAll('.toc ol a[href^="#"]').length,
        nav: document.querySelectorAll('.nav-item').length,
        sections: [...document.querySelectorAll('.reading h2[id], .reading h3[id]')].length,
        images: [...document.querySelectorAll('.reading img')].map(img => img.getAttribute('src')),
        external: [...document.querySelectorAll('.reading a[href^="http"]')].length,
      };
    });
    assert.equal(article.h1s, 1, 'the document page carries exactly one title');
    assert.equal(article.repeatedTitle, false, 'the title is not printed twice');
    assert.ok(article.toc >= 1, 'the document page offers a table of contents');
    assert.equal(article.toc, article.sections, 'every section has an address');
    assert.ok(article.nav >= 40, 'the topic rail links the whole shelf');
    await page.screenshot({ path: join(shots, 'desktop-06-document.png') });
    screenshots.push('desktop-06-document.png');
    record('a-shelf-book-opens-a-readable-document-page', { title: article.title.slice(0, 40), toc: article.toc, rail: article.nav });

    /* search, then a deep link into a section */
    await page.fill('#q', '批注');
    await page.waitForTimeout(700);
    const found = await page.evaluate(() => {
      const box = document.getElementById('results');
      return { shown: !box.hidden, hits: box.querySelectorAll('.hit').length, marks: box.querySelectorAll('mark').length, first: box.querySelector('.hit strong')?.textContent };
    });
    assert.ok(found.hits >= 3, `search should span the corpus, got ${found.hits}`);
    assert.ok(found.marks >= 1, 'the result highlights the matched words');
    await page.screenshot({ path: join(shots, 'desktop-07-search.png') });
    screenshots.push('desktop-07-search.png');
    record('search-covers-the-whole-corpus-with-matched-words-marked', found);

    await page.locator('#results .more a').first().click();
    await page.waitForLoadState('load');
    const deep = await page.evaluate(() => ({ hash: location.hash, heading: document.getElementById(decodeURIComponent(location.hash.slice(1)))?.tagName ?? null, y: window.scrollY }));
    assert.ok(deep.heading, `a search result lands on the matched section (hash ${deep.hash})`);
    record('a-search-result-jumps-straight-to-that-section', deep);

    /* direct-to-shelf control, from the top of the page */
    await page.goto(`${origin}/docs/`, { waitUntil: 'load' });
    await page.waitForFunction(() => document.querySelectorAll('.book').length > 0);
    await page.click('#direct');
    await page.waitForTimeout(reduceWait() + 400);
    const jumped = await page.evaluate(BOOK_GEOMETRY);
    assert.ok(jumped.mean < 30, `直接进入书架 lands the books on the shelf (mean ${jumped.mean.toFixed(1)}px)`);
    record('the-direct-shelf-entry-skips-the-walk-and-keeps-scrolling', { mean: Math.round(jumped.mean), scroll_y_kept: true });

    /* ================= phone ================= */
    const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    const phone = await mobile.newPage();
    watch(phone, network);
    await phone.goto(`${origin}/docs/`, { waitUntil: 'load' });
    await phone.waitForFunction(() => document.querySelectorAll('.book').length > 0);
    await phone.waitForTimeout(400);
    const phoneTop = await phone.evaluate(() => ({
      overflow: document.documentElement.scrollWidth - window.innerWidth,
      tipEnabled: getComputedStyle(document.querySelector('.tip')).display !== 'none',
      heroVisible: document.querySelector('.hero h1').getBoundingClientRect().top >= 0,
      books: document.querySelectorAll('.book').length,
    }));
    assert.equal(phoneTop.overflow, 0, `the phone page scrolls sideways by ${phoneTop.overflow}px`);
    assert.equal(phoneTop.tipEnabled, false, 'the hover card is switched off on touch screens');
    await phone.screenshot({ path: join(shots, 'phone-01-floating.png') });
    screenshots.push('phone-01-floating.png');
    record('phone-keeps-the-whole-shelf-without-side-scroll-or-hover-dependency', phoneTop);

    await scrollToProgress(phone, 1);
    const phoneShelf = await phone.evaluate(BOOK_GEOMETRY);
    assert.ok(phoneShelf.mean < 34, `phones shelve the books too (mean ${phoneShelf.mean.toFixed(1)}px)`);
    assert.deepEqual(phoneShelf.offShelf, [], 'no phone book hangs off the shelf');
    await phone.screenshot({ path: join(shots, 'phone-02-shelved.png') });
    screenshots.push('phone-02-shelved.png');
    record('scrolling-on-a-phone-completes-the-same-move', { mean: Math.round(phoneShelf.mean) });

    await phone.locator('.book').nth(3).click();
    await phone.waitForTimeout(400);
    const phoneReader = await phone.evaluate(() => ({
      open: !document.getElementById('reader').hidden,
      width: document.querySelector('.reader-shell').getBoundingClientRect().width,
      scrollable: document.querySelector('.reader-shell').scrollHeight > document.querySelector('.reader-shell').clientHeight,
    }));
    assert.ok(phoneReader.open, 'a tap opens the book on phones');
    assert.ok(phoneReader.width <= 390, 'the panel fits the screen');
    await phone.screenshot({ path: join(shots, 'phone-03-open-book.png') });
    screenshots.push('phone-03-open-book.png');
    record('the-reading-panel-fits-and-stays-legible-on-a-phone', phoneReader);

    await phone.keyboard.press('Escape');
    await phone.locator('#library').scrollIntoViewIfNeeded();
    await phone.waitForTimeout(300);
    await phone.screenshot({ path: join(shots, 'phone-04-catalog.png') });
    screenshots.push('phone-04-catalog.png');
    const phoneArticle = await phone.evaluate(async () => {
      const link = document.querySelector('.card-link');
      const response = await fetch(link.href);
      return { ok: response.ok, href: new URL(link.href).pathname };
    });
    assert.ok(phoneArticle.ok, 'catalog links resolve on the phone too');
    record('the-catalog-takes-the-reader-to-the-document-on-phones', phoneArticle);

    /* ================= reduced motion ================= */
    const calm = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
    const stillPage = await calm.newPage();
    watch(stillPage, network);
    await stillPage.goto(`${origin}/docs/`, { waitUntil: 'load' });
    await stillPage.waitForFunction(() => document.querySelectorAll('.book').length > 0);
    await stillPage.waitForTimeout(500);
    const calmState = await stillPage.evaluate(BOOK_GEOMETRY);
    assert.ok(calmState.mean < 34, `with reduced motion the books are shelved at once (mean ${calmState.mean.toFixed(1)}px)`);
    await stillPage.screenshot({ path: join(shots, 'desktop-08-reduced-motion.png') });
    screenshots.push('desktop-08-reduced-motion.png');
    record('reduce-motion-goes-straight-to-the-shelf', { mean: Math.round(calmState.mean) });

    /* every page in the corpus, not only the ones the walkthrough above happened to open */
    const sweep = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const sweeper = await sweep.newPage();
    watch(sweeper, network);
    const corpus = (await readdir(docsRoot, { recursive: true }))
      .filter(name => name.endsWith('.html') && !name.includes('_assets'));
    for (const name of corpus) await sweeper.goto(`${origin}/docs/${name}`, { waitUntil: 'load' });
    await sweep.close();
    record('every-published-page-loads-on-its-own', { pages: corpus.length });

    assert.equal(errors.length, 0, `console or network failures: ${errors.slice(0, 6).join('; ')}`);
    assert.equal(external.length, 0, `third-party requests: ${external.slice(0, 6).join(', ')}`);
    assert.equal(failed.length, 0, `failed requests: ${failed.slice(0, 6).join(', ')}`);
    record('the-site-loads-without-page-errors-or-third-party-requests', { pages: corpus.length + 6 });
  } finally {
    if (browser) await browser.close();
    server.close();
  }

  const receipt = {
    check: 'docs-site-browser',
    ran_at: new Date().toISOString(),
    generator: 'scripts/docs-site-browser-fixture.mjs',
    browser: 'chromium (headless, real engine)',
    viewports: ['1440x900 desktop', '390x844 phone', '1440x900 reduced-motion'],
    build: built,
    checks,
    screenshots: screenshots.map(name => `../../../artifacts/docs-site/${name}`),
    boundary: 'This measures the generated site in a browser served locally. It does not prove the GitHub Pages deployment, its latency or its availability; run scripts/verify-docs-site.mjs against the live URL for that.',
  };
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(`\n${checks.length} checks passed · ${screenshots.length} screenshots in ${shots}`);
  console.log(`receipt: ${relative(project, receiptPath)}`);
}

function watch(page, { errors, external, failed }) {
  page.on('pageerror', error => errors.push(`pageerror: ${error.stack || error.message}`));
  page.on('request', request => {
    const url = request.url();
    if (!url.startsWith('http://127.0.0.1') && !url.startsWith('data:') && !url.startsWith('blob:')) external.push(url);
  });
  page.on('response', response => {
    if (response.status() >= 400) failed.push(`HTTP ${response.status()} ${response.url()}`);
  });
}

await main().catch(error => {
  console.error(error);
  process.exit(1);
});
