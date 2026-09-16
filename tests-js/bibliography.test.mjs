import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { dispatch } from '../src/bridge.mjs';

const resolver = async () => [{ address: '93.184.215.14', family: 4 }];
const response = (text, statusCode = 200, headers = {}) => ({ statusCode, headers, body: Readable.from([Buffer.from(text)]), close() { this.body.destroy(); } });
const crossref = message => ({ resolver, transport: async ({ url }) => url.hostname === 'api.crossref.org' ? response(JSON.stringify({ message })) : response('') });

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'bibliography-build-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const library = join(directory, 'library');
  const complete = await dispatch({ action: 'create', metadata: { title: 'Reading metadata evidence', citekey: 'reader2026', DOI: '10.1234/metadata', author: [{ family: 'Reader', given: 'Alice' }], issued: { 'date-parts': [[2026]] } } }, { library });
  const sparse = await dispatch({ action: 'create', metadata: { title: 'Unverified draft', citekey: 'draft2026' } }, { library });
  const linked = await dispatch({ action: 'create', metadata: { title: 'Linked but no DOI', citekey: 'linked2026', URL: 'https://example.org/article' } }, { library });
  return { directory, library, complete, sparse, linked };
}

test('bibliography_build writes references.bib and a factual audit into exports', async t => {
  const f = await fixture(t);
  const result = await dispatch({ action: 'bibliography_build' }, { library: f.library });
  assert.equal(result.count, 3);
  assert.equal(result.conflicts, 0);
  assert.equal(result.doi_duplicates, 0);
  assert.equal(result.missing.doi, 2);
  assert.deepEqual(result.actionable, { lookup_by_url: 1, manual_only: 1 }, 'Missing-DOI records split into URL-lookup and manual-only');
  const bib = await readFile(result.bib_path, 'utf8');
  assert.match(bib, /reader2026/);
  assert.match(bib, /draft2026/);
  assert.match(bib, /Reading metadata evidence/);
  const audit = JSON.parse(await readFile(result.audit_path, 'utf8'));
  assert.equal(audit.schema, 'paper-library-bibliography-audit.v1');
  assert.equal(audit.totals.records, 3);
  assert.deepEqual(audit.actionable.lookup_by_url.ids, [f.linked.id]);
  assert.deepEqual(audit.actionable.manual_only.ids, [f.sparse.id]);
  assert.equal(audit.records.find(record => record.id === f.linked.id).has_url, true);
  assert.equal(audit.verification.requested, false);
  assert.equal(audit.bibliography.count, 3);
  const saved = await dispatch({ action: 'list', query: 'Reading', limit: 10 }, { library: f.library });
  assert.equal(saved.items.length, 1, 'Build never mutates catalog records');
});

test('explicit DOI verification compares fields and keeps conflicts explicit without writing back', async t => {
  const f = await fixture(t);
  const other = await dispatch({ action: 'create', metadata: { title: 'Second record', citekey: 'second2026', DOI: '10.9999/other' } }, { library: f.library });
  const conflicting = await dispatch({ action: 'create', metadata: { title: 'Locally corrected title', citekey: 'conflict2026', DOI: '10.7777/conflict', author: [{ family: 'Author', given: 'Local' }] } }, { library: f.library });
  const fetchOptions = crossref({ DOI: '10.1234/metadata', title: ['Reading metadata evidence'], author: [{ family: 'Reader', given: 'Alice' }], issued: { 'date-parts': [[2026]] } });
  // The second fixture DOI answers with a foreign registration; the third one
  // answers below with the same DOI but a different registered title.
  const mixed = { resolver, transport: async ({ url }) => {
    if (url.hostname !== 'api.crossref.org') return response('');
    const doi = decodeURIComponent(url.pathname.split('/works/')[1] || '');
    if (doi === '10.7777/conflict') return response(JSON.stringify({ message: { DOI: '10.7777/conflict', title: ['Registered different title'], author: [{ family: 'Author', given: 'Local' }] } }));
    return response(JSON.stringify({ message: { DOI: '10.1234/metadata', title: ['Reading metadata evidence'], author: [{ family: 'Reader', given: 'Alice' }], issued: { 'date-parts': [[2026]] } } }));
  } };
  const result = await dispatch({ action: 'bibliography_build', verify: true, verify_limit: 25 }, { library: f.library, fetchOptions: mixed });
  assert.equal(result.verification.checked, 3, 'Only records with a DOI are verified');
  const confirmed = result.verification.results.find(entry => entry.id === f.complete.id);
  assert.equal(confirmed.validation_status, 'provider-confirmed');
  assert.ok(confirmed.checked_at);
  const titleField = confirmed.fields.find(field => field.field === 'title');
  assert.equal(titleField.validation_status, 'match');
  const missing = result.verification.results.find(entry => entry.id === other.id);
  assert.equal(missing.validation_status, 'unavailable', 'A registration answering with a different DOI is never trusted');
  const clash = result.verification.results.find(entry => entry.id === conflicting.id);
  assert.equal(clash.validation_status, 'conflict');
  const clashTitle = clash.fields.find(field => field.field === 'title');
  assert.equal(clashTitle.validation_status, 'conflict');
  assert.equal(clashTitle.catalog, 'Locally corrected title');
  assert.equal(clashTitle.online, 'Registered different title');
  assert.equal(result.verification.provider_confirmed, 1);
  assert.equal(result.verification.conflict, 1);
  assert.equal(result.verification.unavailable, 1);
  const current = await dispatch({ action: 'get', id: other.id }, { library: f.library });
  assert.equal(current.title, 'Second record', 'Verification never writes catalog metadata');
});

test('verification honors its explicit bound and reports the remainder', async t => {
  const f = await fixture(t);
  await dispatch({ action: 'create', metadata: { title: 'Extra record', citekey: 'extra2026', DOI: '10.8888/extra' } }, { library: f.library });
  const result = await dispatch({ action: 'bibliography_build', verify: true, verify_limit: 1 }, { library: f.library, fetchOptions: crossref({ DOI: '10.1234/metadata', title: ['Reading metadata evidence'] }) });
  assert.equal(result.verification.checked, 1);
  assert.equal(result.verification.truncated, true);
  assert.equal(result.verification.remaining, 1);
  await assert.rejects(dispatch({ action: 'bibliography_build', verify: true, verify_limit: 0 }, { library: f.library }), /1–100/);
  await assert.rejects(dispatch({ action: 'bibliography_build', verify: true, verify_limit: 101 }, { library: f.library }), /1–100/);
});

test('empty and dataset-filtered builds keep their scope explicit', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'bibliography-empty-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await assert.rejects(dispatch({ action: 'bibliography_build' }, { library: join(directory, 'library') }), /为空/);
  const f = await fixture(t);
  await dispatch({ action: 'dataset_put', metadata: { title: 'Synthetic dataset' }, expected_revision: 0 }, { library: f.library });
  const withDatasets = await dispatch({ action: 'bibliography_build' }, { library: f.library });
  assert.equal(withDatasets.count, 4);
  assert.equal(withDatasets.kind, 'all');
  const papersOnly = await dispatch({ action: 'bibliography_build', include_datasets: false }, { library: f.library });
  assert.equal(papersOnly.count, 3);
  assert.equal(papersOnly.kind, 'paper');
  const audit = JSON.parse(await readFile(papersOnly.audit_path, 'utf8'));
  assert.equal(audit.totals.records, 3, 'Paper identity audit always covers exactly the paper catalog');
});
