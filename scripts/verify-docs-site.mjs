/** Gate the documentation site before it is published.
 *
 * Reads the built tree in _site/docs and the markdown it came from, and checks the things a
 * browser run cannot see from one page at a time: that every book on the wall is a real document,
 * that the site's searchable text is the documents' own words, that no asset request leaves the
 * site, that the demo annotations say so, and that nothing private or machine-local was copied in.
 * It is a publication gate over generated files, not a claim about the live service.
 */
import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const project = dirname(dirname(fileURLToPath(import.meta.url)));
const site = join(project, '_site');
const docs = join(site, 'docs');
const checks = [];
const record = label => { checks.push(label); console.log(`PASS ${label}`); };

const collapse = text => String(text).replace(/\s+/g, ' ').trim();
// The same words have to be comparable in markdown and in rendered HTML, so link labels replace
// the label+URL pair and the markup characters that never reach the page are dropped — including
// the angle brackets an autolink is written with and rendered as the bare URL.
const stripMarkdown = text => collapse(String(text)
  .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
  .replace(/[#*<>`]/g, ' '));
const walk = async dir => {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walk(path));
    else out.push(path);
  }
  return out;
};

const landingPath = join(docs, 'index.html');
const htmlFiles = (await walk(site)).filter(path => path.endsWith('.html'));
const docPages = htmlFiles.filter(path => path.startsWith(docs) && !path.includes('_assets') && path !== landingPath);

const index = JSON.parse(await readFile(join(docs, '_assets/search.json'), 'utf8'));
assert.equal(index.entries.length, index.count, 'the search index counts its own entries');
for (const entry of index.entries) {
  const target = resolve(docs, entry.href);
  assert.ok(docPages.includes(target), `${entry.href} is a page that exists`);
}
assert.equal(docPages.length, index.entries.length, 'every source document became exactly one page');
record('every-source-document-becomes-one-page-and-the-index-covers-all-of-them');

/* one title per page, and never the same words twice in a row */
for (const path of docPages) {
  const html = await readFile(path, 'utf8');
  const reading = html.slice(html.indexOf('<main class="reading"'));
  const heads = [...reading.matchAll(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/g)]
    .map(match => collapse(match[2].replace(/<[^>]+>/g, '')));
  assert.equal(reading.match(/<h1/g)?.length, 1, `${path} carries exactly one h1`);
  assert.ok(heads[0] && heads[0].length > 1, `${path} opens on a title`);
  assert.notEqual(heads[1], heads[0], `${path} does not print its title twice`);
}
record('each-document-page-carries-one-title-and-never-repeats-it');

/* the wall of books is the corpus, with its own names */
const landing = await readFile(landingPath, 'utf8');
const books = JSON.parse(landing.match(/<script type="application\/json" id="books">([\s\S]*?)<\/script>/)[1]);
const shelfMeta = JSON.parse(landing.match(/<script type="application\/json" id="shelfmeta">([\s\S]*?)<\/script>/)[1]);
assert.equal(books.length, index.entries.length, 'one book per document floats in the scene');
const indexTitles = new Set(index.entries.map(entry => entry.title));
for (const book of books) {
  assert.ok(indexTitles.has(book.title), `the cover "${book.title}" names a real document`);
  assert.ok(resolve(docs, book.href) && docPages.includes(resolve(docs, book.href)), `${book.href} is a page`);
  assert.ok(shelfMeta.some(shelf => shelf.id === book.shelf), `${book.title} sits on a known shelf`);
  assert.ok(!/^(演示|示例)/.test(book.read), `${book.title} opens on real text, not an invented paragraph`);
}
record('every-book-on-the-wall-is-named-and-addressed-by-a-real-document');

/* the searchable text and the opened-book quote come from the markdown itself */
const markdown = [...(await walk(join(project, 'docs'))).filter(path => path.endsWith('.md')),
  join(project, 'README.md'), join(project, 'README.en.md')];
const corpus = [];
for (const path of markdown) corpus.push({ file: path, text: stripMarkdown(await readFile(path, 'utf8')) });
for (const entry of index.entries) {
  const probe = stripMarkdown(entry.body).slice(0, 24);
  assert.ok(probe.length >= 12, `${entry.href} has searchable text`);
  assert.ok(corpus.some(source => source.text.includes(probe)), `${entry.href} is indexed by its own words`);
}
for (const book of books) {
  const probe = stripMarkdown(book.read).slice(0, 20);
  assert.ok(corpus.some(source => source.text.includes(probe)), `${book.title} opens with a sentence the document really has`);
}
record('the-index-and-the-opened-books-quote-the-documents-own-sentences');

/* nothing the browser has to fetch leaves the site, and nothing local or private came along */
const PAGES_ROOT = 'https://mappedinfo.github.io/dsh-paper-library/';
for (const path of htmlFiles) {
  const html = await readFile(path, 'utf8');
  for (const [tag] of [...html.matchAll(/<(?:img|script|link|source)\b[^>]*>/g)]) {
    const url = (tag.match(/(?:src|href)="([^"]+)"/) ?? [])[1] ?? '';
    if (!url || /^(data|blob):/.test(url)) continue;
    if (/^(https?:)?\/\//.test(url)) {
      assert.ok(url.startsWith(PAGES_ROOT), `${path} asks ${url} from another server`);
    }
  }
  for (const url of [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map(match => match[1])) {
    if (!url || /^(?:[a-z]+:)?\/\//.test(url) || url.startsWith('#') || /^(data|blob|mailto):/.test(url)) continue;
    const file = url.split('#')[0].split('?')[0];
    if (file) assert.ok(await exists(resolve(dirname(path), file)), `${path} points at a missing ${url}`);
  }
  // A documented API path such as /api/users/0 is not a home directory; require a real filesystem root.
  assert.ok(!/(^|[\s"'(])\/(?:Users|home)\/[A-Za-z0-9._-]+\//i.test(html) && !/Library\/Application Support/i.test(html),
    `${path} carries no machine-local path`);
}
async function exists(path) {
  try { await readFile(path); return true; } catch { return false; }
}
record('no-asset-is-loaded-from-outside-the-site-and-no-private-path-was-copied-in');

/* the demo boundary is stated where a reader will meet it */
const landingCss = await readFile(join(docs, '_assets/landing.css'), 'utf8');
assert.match(landing, /演示笔记/, 'the margin note is labelled as a demo');
assert.match(landing, /正文摘自真实文档/, 'the reader is told which words are real');
assert.match(landing, /直接进入书架/, 'the shelf entry does not depend on scrolling');
assert.match(landingCss, /prefers-reduced-motion/, 'the scene answers the reduced-motion setting');
record('the-landing-page-labels-demo-notes-and-offers-a-non-animated-way-in');

/* the Pages pipeline really publishes this tree */
const workflow = await readFile(join(project, '.github/workflows/pages.yml'), 'utf8');
assert.match(workflow, /scripts\/build-docs-site\.mjs/, 'the workflow builds the docs site');
assert.match(workflow, /path:\s*_site/, 'the workflow uploads the built site');
assert.match(workflow, /actions\/deploy-pages/, 'the workflow deploys with the official Pages action');
record('the-pages-workflow-builds-and-publishes-the-generated-site');

await writeFile(join(project, 'docs/validation/docs-site-static.json'), JSON.stringify({
  verified_at: new Date().toISOString(),
  scope: 'The generated _site tree checked against the repository markdown it was built from: page and index coverage, one title per page, book covers that name real documents, indexed and quoted sentences that exist in the sources, no third-party asset request, no machine-local or library path, the demo-note labelling, and the Pages workflow wiring. This is a publication gate over files on disk; it says nothing about the live service, which the browser checks cover.',
  pages: docPages.length, books: books.length, markdown_sources: markdown.length,
  checks, checks_count: checks.length,
}, null, 2) + '\n');
console.log(JSON.stringify({ pages: docPages.length, books: books.length, markdown_sources: markdown.length, checks: checks.length }));
