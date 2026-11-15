import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFetchHandler } from '../src/http.mjs';

const require = createRequire(import.meta.url);
let JSDOM;
try { ({ JSDOM } = require(process.env.JSDOM_MODULE || 'jsdom')); } catch {}

test('catalog text search is reachable through the HTTP worker', async t => {
  const library = await mkdtemp(join(tmpdir(), 'paper-catalog-search-'));
  t.after(() => rm(library, { recursive: true, force: true }));
  const handler = createFetchHandler({ library, localStateHome: join(library, 'state') });
  const asset = await handler(new Request('http://127.0.0.1/catalog-search.js'));
  assert.equal(asset.status, 200);
  assert.match(await asset.text(), /window\.PaperCatalogSearch/);
  const post = async fields => {
    const response = await handler(new Request('http://127.0.0.1/api', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'catalog_text_search', query: 'synthetic phrase', ...fields }),
    }));
    return [response.status, await response.json()];
  };
  const [status, payload] = await post();
  assert.equal(status, 200, payload.error);
  assert.deepEqual(payload.result.matches, []);
  assert.equal(payload.result.next_cursor, null);
  const result = await post({ action: 'catalog_search_prepare', query: undefined });
  assert.equal(result[0], 200, result[1].error);
  assert.equal(result[1].result.pdfs_pending, 0);
  const [, tooLarge] = await post({ query: 'a'.repeat(4097) });
  assert.match(tooLarge.error, /全文搜索请求过大/);
});

test('catalog searches group page excerpts inline, preserve results during reading, and leave the regular listing intact', { skip: !JSDOM }, async t => {
  const html = await readFile(new URL('../web/index.html', import.meta.url), 'utf8');
  const dom = new JSDOM(html, { runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const { window } = dom;
  const get = part => window.document.getElementById(`catalog-search-${part}`);
  const view = get('view'), catalog = window.document.getElementById('library-literature-content');
  const input = window.document.getElementById('search'), scope = get('scope');
  const ordinary = window.document.getElementById('paper-list');
  ordinary.textContent = 'Existing metadata result';
  window.eval(await readFile(new URL('../web/catalog-search.js', import.meta.url), 'utf8'));
  let project = null, metadata = 0, warmed = false;
  const calls = [], opened = [], cursor = { scope: 'synthetic-cursor', offset: 40 };
  const hit = page => ({ paper_id: page === 2 ? 'another-paper' : 'synthetic',
    title: page === 2 ? 'Another synthetic paper' : '<b>Synthetic</b>',
    snippet: '🗺 <img> evidence', match_start: 8, match_end: 16, page });
  const ui = window.PaperCatalogSearch.create({
    project: () => project,
    searchMetadata: () => { metadata++; },
    prepare: async () => true,
    navigate: async value => { opened.push(value); return true; },
    toast: message => assert.fail(message),
    async api(action, request) {
      calls.push({ action, ...request });
      const coverage = { indexed_pages: 41, no_text_pages: 0, skipped_pages: 0,
        unreadable_pdfs: 0, without_pdf: 0, pdf_count: 1, pdfs_completed: 1, pdfs_pending: 0 };
      if (action === 'catalog_search_prepare') { warmed = true; return coverage; }
      if (!warmed && request.project_id === null) return { ...coverage, matches: [], next_cursor: null,
        indexed_pages: 0, pdfs_completed: 0, pdfs_pending: 1 };
      const first = request.project_id && !request.cursor;
      return { ...coverage, matches: first ? Array.from({ length: 40 }, (_, index) => hit(index + 1)) : [hit(41)],
        next_cursor: first ? cursor : null };
    },
  });
  const change = value => { scope.value = value; scope.dispatchEvent(new window.Event('change')); };
  const submit = () => get('form').dispatchEvent(new window.Event('submit', { cancelable: true }));
  const settle = () => new Promise(resolve => setImmediate(resolve));
  input.value = 'synthetic phrase';
  input.dispatchEvent(new window.Event('input'));
  assert.equal(metadata, 1);
  assert.equal(get('project').disabled, true);
  project = { id: 'p-synthetic', title: 'Synthetic project' };
  ui.syncProject();
  change('project');
  submit();
  await settle();
  assert.equal(calls[0].action, 'catalog_text_search');
  assert.equal(calls[0].project_id, project.id);
  assert.equal(view.parentElement, catalog);
  assert.equal(view.closest('dialog'), null);
  assert.equal(view.hidden, false);
  assert.equal(catalog.hasAttribute('data-catalog-text-results'), true);
  assert.equal(get('results').childElementCount, 2);
  assert.equal(get('results').querySelectorAll('.catalog-search-hit').length, 40);
  assert.equal(get('results').querySelector('mark').textContent, 'evidence');
  assert.equal(get('results').querySelector('b, img'), null);
  get('more').click();
  await settle();
  assert.deepEqual(calls[1].cursor, cursor);
  assert.equal(get('results').childElementCount, 1);
  assert.match(get('status').textContent, /命中页 41.*41 页可搜索/);
  get('results').querySelector('.catalog-search-hit').click();
  await settle();
  assert.deepEqual(opened, [hit(41)]);
  assert.equal(view.hidden, false);
  get('previous').click();
  await settle();
  assert.equal(calls[2].cursor, null);
  assert.equal(get('results').childElementCount, 2);

  change('library');
  submit();
  await settle();
  assert.equal(calls[3].project_id, null);
  assert.equal(calls[3].cursor, null);
  assert.equal(get('results').childElementCount, 0);
  assert.match(get('status').textContent, /1 篇待索引/);
  get('prepare').click();
  await settle();
  assert.equal(calls[4].action, 'catalog_search_prepare');
  assert.equal(calls[5].action, 'catalog_text_search');
  assert.equal(get('results').childElementCount, 1);
  input.value = '';
  input.dispatchEvent(new window.Event('input'));
  assert.equal(view.hidden, true);
  assert.equal(ordinary.textContent, 'Existing metadata result');
  assert.equal(get('submit').textContent, '准备索引');
  submit();
  await settle();
  assert.equal(calls[6].action, 'catalog_search_prepare');
  assert.match(get('status').textContent, /^索引已就绪/);
  get('clear').click();
  assert.equal(catalog.hasAttribute('data-catalog-text-results'), false);
  ui.setMetadataQuery('title search');
  assert.equal(scope.value, 'metadata');
  assert.equal(input.value, 'title search');
  assert.equal(metadata, 2);
});

test('changing the project cancels an inline query and rejects late results', { skip: !JSDOM }, async t => {
  const dom = new JSDOM(await readFile(new URL('../web/index.html', import.meta.url), 'utf8'), { runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const { window } = dom;
  window.eval(await readFile(new URL('../web/catalog-search.js', import.meta.url), 'utf8'));
  const get = id => window.document.getElementById(id);
  let project = { id: 'p-one' }, release, signal;
  const ui = window.PaperCatalogSearch.create({
    project: () => project,
    api: (_action, _request, options) => {
      signal = options.signal;
      return new Promise(resolve => { release = resolve; });
    },
  });
  ui.syncProject();
  get('catalog-search-scope').value = 'project';
  get('search').value = 'phrase';
  get('catalog-search-form').dispatchEvent(new window.Event('submit', { cancelable: true }));
  assert.ok(signal);
  project = { id: 'p-two' };
  ui.syncProject();
  assert.equal(signal.aborted, true);
  release({ matches: [{ paper_id: 'stale', page: 1, snippet: 'stale', title: 'Stale' }] });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(get('catalog-search-view').hidden, true);
  assert.equal(get('catalog-search-results').childElementCount, 0);
});
