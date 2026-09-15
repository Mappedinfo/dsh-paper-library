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
  return { directory, library, complete, sparse };
}

test('bibliography_build writes references.bib and a factual audit into exports', async t => {
  const f = await fixture(t);
  const result = await dispatch({ action: 'bibliography_build' }, { library: f.library });
  assert.equal(result.count, 2);
  assert.equal(result.conflicts, 0);
  assert.equal(result.doi_duplicates, 0);
  assert.equal(result.missing.doi, 1);
  const bib = await readFile(result.bib_path, 'utf8');
  assert.match(bib, /reader2026/);
  assert.match(bib, /draft2026/);
  assert.match(bib, /Reading metadata evidence/);
  const audit = JSON.parse(await readFile(result.audit_path, 'utf8'));
  assert.equal(audit.schema, 'paper-library-bibliography-audit.v1');
  assert.equal(audit.totals.records, 2);
  assert.equal(audit.verification.requested, false);
  assert.equal(audit.bibliography.count, 2);
  const saved = await dispatch({ action: 'list', query: 'Reading', limit: 10 }, { library: f.library });
  assert.equal(saved.items.length, 1, 'Build never mutates catalog records');
});

test('explicit DOI verification compares online registration without writing back', async t => {
  const f = await fixture(t);
  const other = await dispatch({ action: 'create', metadata: { title: 'Second record', citekey: 'second2026', DOI: '10.9999/other' } }, { library: f.library });
  const fetchOptions = crossref({ DOI: '10.1234/metadata', title: ['Reading metadata evidence'] });
  const result = await dispatch({ action: 'bibliography_build', verify: true, verify_limit: 25 }, { library: f.library, fetchOptions });
  assert.equal(result.verification.checked, 2, 'Only records with a DOI are verified');
  const match = result.verification.results.find(entry => entry.id === f.complete.id);
  assert.equal(match.status, 'match');
  const missing = result.verification.results.find(entry => entry.id === other.id);
  assert.equal(missing.status, 'unavailable', 'A registration answering with a different DOI is never trusted');
  assert.equal(result.verification.matched, 1);
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
  assert.equal(withDatasets.count, 3);
  assert.equal(withDatasets.kind, 'all');
  const papersOnly = await dispatch({ action: 'bibliography_build', include_datasets: false }, { library: f.library });
  assert.equal(papersOnly.count, 2);
  assert.equal(papersOnly.kind, 'paper');
  const audit = JSON.parse(await readFile(papersOnly.audit_path, 'utf8'));
  assert.equal(audit.totals.records, 2, 'Paper identity audit always covers exactly the paper catalog');
});
