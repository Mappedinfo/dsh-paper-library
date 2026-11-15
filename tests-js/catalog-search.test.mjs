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
  const [, tooLarge] = await post({ query: 'a'.repeat(4097) });
  assert.match(tooLarge.error, /全文搜索请求过大/);
});

test('the catalog form switches scopes, pages through results and routes a hit to the reader', { skip: !JSDOM }, async t => {
  const html = await readFile(new URL('../web/index.html', import.meta.url), 'utf8');
  const dom = new JSDOM(html, { runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const { window } = dom;
  const get = part => window.document.getElementById(`catalog-search-${part}`);
  const dialog = get('dialog'), input = window.document.getElementById('search'), scope = get('scope');
  dialog.showModal = () => { dialog.open = true; };
  dialog.close = () => { dialog.open = false; dialog.dispatchEvent(new window.Event('close')); };
  window.eval(await readFile(new URL('../web/catalog-search.js', import.meta.url), 'utf8'));
  let project = null, metadata = 0;
  const calls = [], opened = [], cursor = { index: 0, page: 41 };
  const hit = page => ({ paper_id: 'synthetic', title: '<b>Synthetic</b>', snippet: '<img> evidence', page });
  const ui = window.PaperCatalogSearch.create({
    project: () => project,
    searchMetadata: () => { metadata++; },
    prepare: async () => true,
    navigate: async value => { opened.push(value); return true; },
    toast: message => assert.fail(message),
    async api(action, request) {
      calls.push({ action, ...request });
      const first = calls.length === 1;
      return { matches: first ? Array.from({ length: 40 }, (_, index) => hit(index + 1)) : [hit(41)],
        next_cursor: first ? cursor : null, scanned_pages: first ? 40 : 1, no_text_pages: 0,
        skipped_pages: 0, unreadable_pdfs: 0, without_pdf: 0, pdf_count: 1, pdfs_completed: first ? 0 : 1 };
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
  assert.equal(get('results').childElementCount, 40);
  assert.equal(get('results').querySelector('b, img'), null);
  get('more').click();
  await settle();
  assert.deepEqual(calls[1].cursor, cursor);
  assert.equal(get('results').childElementCount, 1);
  assert.match(get('status').textContent, /搜索结束.*41 个命中页/);
  get('results').querySelector('button').click();
  await settle();
  assert.deepEqual(opened, [hit(41)]);
  assert.equal(dialog.open, false);

  change('library');
  submit();
  await settle();
  assert.equal(calls[2].project_id, null);
  assert.equal(calls[2].cursor, null);
  dialog.close();
  ui.setMetadataQuery('title search');
  assert.equal(scope.value, 'metadata');
  assert.equal(input.value, 'title search');
  assert.equal(metadata, 2);
});
