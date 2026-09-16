import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { dispatch } from '../src/bridge.mjs';
import { resolveConfig } from '../src/harness/config.mjs';
import { createTranslationServerClient, translationServerUrl, zoteroItemToMetadata } from '../src/translation-server.mjs';

const zoteroItem = {
  itemType: 'journalArticle',
  title: 'A deterministic translator result',
  creators: [{ creatorType: 'author', firstName: 'Ada', lastName: 'Reader' }, { creatorType: 'editor', firstName: 'E', lastName: 'ditor' }],
  DOI: '10.1234/sidecar',
  url: 'https://example.org/article',
  publicationTitle: 'Journal of Synthetic Records',
  publisher: 'Example Press',
  volume: '12', issue: '3', pages: '1-9',
  date: '2026-03-02',
  abstractNote: 'Synthetic abstract.',
  ISSN: '1234-5678',
};

test('translationServer config accepts loopback http only', () => {
  assert.equal(translationServerUrl(undefined), undefined);
  assert.equal(translationServerUrl('http://127.0.0.1:1969'), 'http://127.0.0.1:1969');
  assert.equal(translationServerUrl('http://localhost:1969/'), 'http://localhost:1969');
  for (const bad of ['https://127.0.0.1:1969', 'http://example.com', 'http://192.168.1.10', 'http://user:pass@127.0.0.1:1969', 'http://127.0.0.1:1969/search', 'not-a-url']) {
    assert.throws(() => translationServerUrl(bad), /回环|无效/);
  }
  assert.throws(() => resolveConfig({ library: '/tmp/x', translationServer: 'http://example.com' }), /回环/);
});

test('zoteroItemToMetadata maps known fields and never invents', () => {
  const metadata = zoteroItemToMetadata(zoteroItem);
  assert.equal(metadata.title, 'A deterministic translator result');
  assert.equal(metadata.type, 'article-journal');
  assert.deepEqual(metadata.author, [{ family: 'Reader', given: 'Ada' }]);
  assert.equal(metadata.DOI, '10.1234/sidecar');
  assert.equal(metadata['container-title'], 'Journal of Synthetic Records');
  assert.deepEqual(metadata.issued, { 'date-parts': [[2026, 3, 2]] });
  assert.equal(metadata.page, '1-9');
  assert.equal(zoteroItemToMetadata({ itemType: 'journalArticle' }).title, undefined, 'Missing values stay absent');
  assert.deepEqual(zoteroItemToMetadata(null), {});
  assert.equal(zoteroItemToMetadata({ title: 'T', date: 'not a date' }).issued, undefined, 'Unparsable dates are not guessed');
});

async function fixture(t, metadata) {
  const directory = await mkdtemp(join(tmpdir(), 'translation-server-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const library = join(directory, 'library');
  const item = await dispatch({ action: 'create', metadata }, { library });
  return { directory, library, item };
}

const failingFetch = { resolver: async () => [{ address: '93.184.215.14', family: 4 }], transport: async () => ({ statusCode: 503, headers: {}, body: Readable.from(['']), close() {} }) };
const sidecar = (items) => ({
  url: 'http://127.0.0.1:1969',
  transport: async ({ url, body }) => ({ statusCode: 200, text: JSON.stringify(items.map(item => ({ ...item, __endpoint: url, __body: body }))) }),
});

test('identifier lookup falls back to the sidecar and keeps identity gates', async t => {
  const f = await fixture(t, { title: 'A deterministic translator result', citekey: 'keep-key', DOI: '10.1234/sidecar' });
  const result = await dispatch({ action: 'metadata_lookup', id: f.item.id }, { library: f.library, fetchOptions: failingFetch, translationServer: sidecar([zoteroItem]) });
  assert.equal(result.item.title, 'A deterministic translator result');
  assert.equal(result.item.citekey, 'keep-key', 'Citation keys are never rewritten');
  assert.deepEqual(result.item.author, [{ family: 'Reader', given: 'Ada' }]);
  assert.equal(result.provenance.provider, 'translation-server');
  const current = await dispatch({ action: 'get', id: f.item.id }, { library: f.library });
  assert.equal(current.abstract, undefined, 'A lookup drafts metadata; it never writes the catalog');
});

test('foreign identity from the sidecar is discarded', async t => {
  const f = await fixture(t, { title: 'A deterministic translator result', citekey: 'keep-key-2', DOI: '10.1234/sidecar' });
  await assert.rejects(
    dispatch({ action: 'metadata_lookup', id: f.item.id }, { library: f.library, fetchOptions: failingFetch, translationServer: sidecar([{ ...zoteroItem, DOI: '10.9999/other', title: 'A different paper entirely' }]) }),
    /未取得可用文献资料/,
  );
});

test('URL targets use /web with the exact-title gate; unconfigured stays primary-only', async t => {
  const f = await fixture(t, { title: 'A deterministic translator result', citekey: 'keep-key-3', URL: 'https://example.org/article' });
  const result = await dispatch({ action: 'metadata_lookup', id: f.item.id }, { library: f.library, fetchOptions: failingFetch, translationServer: sidecar([{ ...zoteroItem, DOI: undefined }]) });
  assert.equal(result.provenance.provider, 'translation-server');
  assert.equal(result.item.DOI, undefined, 'Absent identifiers stay absent');
  const plain = await fixture(t, { title: 'A deterministic translator result', citekey: 'keep-key-4', URL: 'https://example.org/article' });
  await assert.rejects(dispatch({ action: 'metadata_lookup', id: plain.item.id }, { library: plain.library, fetchOptions: failingFetch }), /未取得可用文献资料/);
});

test('client rejects non-identifier payloads before any request', async () => {
  const calls = [];
  const client = createTranslationServerClient({ url: 'http://127.0.0.1:1969', transport: async (...args) => { calls.push(args); return { statusCode: 200, text: '[]' } } });
  await assert.rejects(client.lookup(''), /标识符或链接/);
  await assert.rejects(client.lookup('just some free text'), /仅用于/);
  assert.equal(calls.length, 0, 'Invalid payloads never reach the sidecar');
  assert.deepEqual(await client.lookup('10.1234/sidecar'), []);
});
