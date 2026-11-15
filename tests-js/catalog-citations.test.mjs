import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { Readable } from 'node:stream';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFetchHandler } from '../src/http.mjs';
import { lookupCitationCount } from '../src/paper-fetch.mjs';

const require = createRequire(import.meta.url);
let JSDOM;
try { ({ JSDOM } = require(process.env.JSDOM_MODULE || 'jsdom')); } catch {}
const resolver = async () => [{ address: '93.184.215.14', family: 4 }];
const response = (body = {}, statusCode = 200) => ({ statusCode, headers: { 'content-type': 'application/json' },
  body: Readable.from([Buffer.from(JSON.stringify(body))]), close() {} });

test('DOI citation lookups distinguish zero, alternate versions, missing results and source failures', async () => {
  const seen = [];
  const result = await lookupCitationCount('10.1234/Example', { resolver, async transport({ url }) {
    seen.push(url.hostname);
    assert.equal(url.searchParams.get('select'), 'id,doi,cited_by_count');
    return response({ id:'https://openalex.org/W123', doi:'https://doi.org/10.1234/example', cited_by_count:0 });
  } });
  assert.deepEqual(seen, ['api.openalex.org']);
  assert.equal(result.count, 0);
  assert.equal(result.source, 'OpenAlex');
  assert.equal(result.url, 'https://openalex.org/W123');

  const fallback = await lookupCitationCount('10.1234/preprint', { resolver, async transport({ url }) {
    if (url.hostname === 'api.openalex.org') {
      return response({ id:'https://openalex.org/W124', doi:'https://doi.org/10.1234/journal', cited_by_count:180 });
    }
    return response({ message:{ DOI:'10.1234/PREPRINT', 'is-referenced-by-count':3 } });
  } });
  assert.equal(fallback.count, 3);
  assert.equal(fallback.source, 'Crossref');
  assert.equal((await lookupCitationCount('10.1234/missing', { resolver, transport: async () => response({}, 404) })).status, 'not_found');
  assert.equal((await lookupCitationCount('10.1234/error', { resolver, transport: async () => response({}, 429) })).status, 'unavailable');
});

test('HTTP snapshots are reused after a restart and catalog reads do not look up private metadata', async t => {
  const root = await mkdtemp(join(tmpdir(), 'paper-citation-counts-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let calls = 0;
  const options = { library: join(root, 'library'), localStateHome: join(root, 'state'),
    fetchOptions: { resolver, async transport({ url }) {
      calls++;
      assert.equal(url.hostname, 'api.openalex.org');
      assert.match(decodeURIComponent(url.pathname), /10\.1234\/example$/);
      return response({ id:'https://openalex.org/W123', doi:'https://doi.org/10.1234/example', cited_by_count:17 });
    } } };
  let handler = createFetchHandler(options);
  const post = async (action, fields) => {
    const r = await handler(new Request('http://127.0.0.1/api', {
      method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ action, ...fields }),
    }));
    return r.json();
  };
  assert.equal((await handler(new Request('http://127.0.0.1/catalog-citations.js'))).status, 200);
  assert.equal((await post('create', { metadata:{ title:'Synthetic title', DOI:'10.1234/example' } })).ok, true);
  const before = await post('catalog_resource_list', { kind:'paper' });
  assert.equal(before.result.items[0].citation_lookup_doi, '10.1234/example');
  assert.equal(before.result.items[0].citation_needs_lookup, true);
  assert.equal(before.result.items[0].citation_snapshot, undefined);
  assert.equal(calls, 0);
  const count = await post('catalog_citation_counts', { dois:['10.1234/example', '10.1234/EXAMPLE'] });
  assert.equal(count.result.items.length, 1);
  assert.equal(count.result.items[0].count, 17);
  handler = createFetchHandler(options);
  const after = await post('catalog_resource_list', { kind:'paper' });
  assert.equal(after.result.items[0].citation_snapshot.count, 17);
  assert.equal(after.result.items[0].citation_snapshot.source, 'OpenAlex');
  assert.equal(after.result.items[0].citation_needs_lookup, false);
  assert.equal((await post('catalog_citation_counts', { dois:['10.1234/example'] })).result.items[0].count, 17);
  assert.equal((await post('catalog_citation_counts', { dois:['Synthetic hidden title'] })).ok, false);
  assert.equal(calls, 1);
});

test('citation sort uses the entire filtered scope before paginating, with known zero ahead of unknown', async t => {
  const root = await mkdtemp(join(tmpdir(), 'paper-citation-sort-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const handler = createFetchHandler({ library: join(root, 'library'), localStateHome: join(root, 'state'),
    fetchOptions: { resolver, transport: async () => response({ id:'https://openalex.org/W15',
      doi:'https://doi.org/10.48550/arxiv.2601.12345', cited_by_count:18 }) },
  });
  const post = async (action, fields) => {
    const r = await handler(new Request('http://127.0.0.1/api', {
      method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ action, ...fields }),
    }));
    const body = await r.json();
    assert.equal(body.ok, true, body.error);
    return body.result;
  };
  const unknown = await post('create', { metadata:{ title:'Synthetic unknown', citation_count:1000 } });
  const zero = await post('create', { metadata:{ title:'Synthetic zero', openalex:{ cited_by_count:0 } } });
  const preprint = await post('create', { metadata:{ title:'Synthetic preprint', URL:'https://arxiv.org/abs/2601.12345v2' } });
  await post('create', { metadata:{ title:'Synthetic outside', 'is-referenced-by-count':200 } });
  const { project } = await post('project_create', { title:'Synthetic project' });
  for (const item of [unknown, zero, preprint]) {
    await post('project_link', { id:project.id, paper_id:item.id });
    await post('paper_organization_update', { id:item.id, favorite:true, tags:['#method/synthetic'] });
  }
  await post('catalog_citation_counts', { dois:['10.48550/arxiv.2601.12345'] });
  const fields = { kind:'all', query:'Synthetic', project:project.id, favorite:true, tag:'#method', sort:'citations', limit:1 };
  const expected = [[preprint.id,18], [zero.id,0], [unknown.id,undefined]];
  for (const [offset, [id, count]] of expected.entries()) {
    const result = await post('catalog_resource_list', { ...fields, offset });
    assert.equal(result.order, 'desc');
    assert.equal(result.total, 3);
    assert.equal(result.items[0].id, id);
    assert.equal(result.items[0].citation_snapshot?.count, count);
  }
  const asc = await post('catalog_resource_list', { ...fields, order:'asc', limit:3 });
  assert.deepEqual(asc.items.map(item => item.id), [zero.id, preprint.id, unknown.id]);
});

test('metadata enrichment caches citation counts, and proposed DOIs enter the sort after saving the draft', async t => {
  const root = await mkdtemp(join(tmpdir(), 'paper-citation-enrich-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const doi = '10.1234/enrichment';
  const title = 'Synthetic paper for citation count enrichment';
  const paths = [];
  const metadata = { DOI:doi, title:[title], type:'journal-article', 'container-title':['Synthetic journal'],
    author:[{ family:'Example', given:'Reader' }] };
  const handler = createFetchHandler({ library:join(root,'library'), localStateHome:join(root,'state'),
    fetchOptions:{ resolver, async transport({ url }) {
      paths.push(url.hostname);
      if (url.hostname === 'api.crossref.org') {
        return url.pathname === '/works' ? response({ message:{ items:[metadata] } }) : response({ message:metadata });
      }
      if (url.hostname === 'api.openalex.org') return response({ id:'https://openalex.org/W17', doi:`https://doi.org/${doi}`, cited_by_count:25 });
      return response({}, 404);
    } },
  });
  const post = async (action, fields) => {
    const r = await handler(new Request('http://127.0.0.1/api', {
      method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ action, ...fields }),
    }));
    const body = await r.json();
    assert.equal(body.ok, true, body.error);
    return body.result;
  };
  const item = await post('create', { metadata:{ title, author:[{ family:'Example', given:'Reader' }] } });
  const result = await post('metadata_lookup', { id:item.id });
  assert.equal(result.item.DOI, doi);
  assert.equal(result.citation_snapshot.count, 25);
  assert.equal(result.citation_snapshot.source, 'OpenAlex');
  assert.ok(paths.includes('api.openalex.org'));
  const fields = { kind:'paper', sort:'citations' };
  assert.equal((await post('catalog_resource_list', fields)).items[0].citation_snapshot, undefined);
  const unchanged = await post('get', { id:item.id });
  assert.equal(unchanged.DOI, undefined);
  assert.equal(unchanged.modified, item.modified);
  await post('update', { id:item.id, metadata:{ DOI:doi }, expected_modified:item.modified });
  assert.equal((await post('catalog_resource_list', fields)).items[0].citation_snapshot.count, 25);
});

test('the table citation control loads when visible and updates the count and provider in place', { skip: !JSDOM }, async t => {
  const dom = new JSDOM('<table><thead><tr><th>引用量</th></tr></thead><tbody><tr><td></td></tr></tbody></table>', { runScripts:'outside-only' });
  t.after(() => dom.window.close());
  const { window } = dom, { document } = window;
  let observer;
  let header;
  window.IntersectionObserver = class {
    constructor(callback) { observer = callback; }
    observe(node) { header = node; }
    disconnect() {}
  };
  window.eval(await readFile(new URL('../web/catalog-citations.js', import.meta.url), 'utf8'));
  const queries = [];
  const ui = window.PaperCatalogCitations.create({ root: document.querySelector('table'),
    async api(action, payload) {
      queries.push([action, ...payload.dois]);
      return { items:[{ doi:'10.1234/example', status:'found', count:0, source:'OpenAlex',
        url:'https://openalex.org/W123', fetched_at:'2026-11-15T00:00:00Z' }] };
    }, toast: message => assert.fail(message) });
  const item = { citation_lookup_doi:'10.1234/example', citation_needs_lookup:true };
  const cell = ui.cell(item);
  document.querySelector('td').append(cell);
  ui.mountHeader(document.querySelector('th'));
  ui.connect();
  assert.equal(cell.textContent, '—');
  assert.deepEqual(queries, []);
  observer([{ target: header, isIntersecting:true }]);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(queries, [['catalog_citation_counts', item.citation_lookup_doi]]);
  assert.equal(cell.querySelector('a').textContent, '0');
  assert.equal(cell.querySelector('small').textContent, 'OpenAlex');
  assert.match(cell.title, /2026-11-15/);
  observer([{ target: header, isIntersecting:true }]);
  assert.equal(queries.length, 1);
});
