import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFetchHandler } from '../src/http.mjs';

test('scholar profiles persist and distinguish DOI evidence, confirmed authors and name matches', async t => {
  const root = await mkdtemp(join(tmpdir(), 'paper-scholars-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const options = { library: join(root, 'library'), localStateHome: join(root, 'state') };
  let handle = createFetchHandler(options);
  async function call(action, args = {}, expected = 200) {
    const response = await handle(new Request('http://localhost/api', { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, ...args }) }));
    const body = await response.json();
    assert.equal(response.status, expected, JSON.stringify(body));
    return body.result;
  }

  const create = (title, author, DOI) => call('create', { metadata: { title, author: [author], DOI } });
  const verified = await create('Synthetic evidence', { literal: 'Different seed' }, '10.1234/synthetic');
  const nameOnly = await create('Synthetic candidate', { literal: 'Other Author； Doe, Jane' });
  const archived = await create('Synthetic archive', { given: 'Jane', family: 'Doe' });
  const unrelated = await create('Synthetic initial', { given: 'J.', family: 'Doe' });
  await call('archive', { id: archived.id });
  assert.deepEqual((await call('scholar_list')).items, []);
  await call('scholar_save', { patch: { name: 'Jane Doe', homepage: 'javascript:alert(1)' } }, 400);
  const entry = await call('scholar_save', { patch: {
    name: 'Jane Doe', native_name: '合成姓名', aliases: ['Doe Jane'],
    organization: 'Example University', homepage: 'https://example.com/profile',
    topics: [{ name: 'Synthetic topic', url: 'https://example.com/topic' }],
  } });
  const id = entry.profile.id;
  assert.equal(entry.profile.followed, true);
  handle = createFetchHandler(options);
  assert.equal((await call('scholar_list')).items[0].id, id);
  assert.equal((await call('scholar_get', { id })).revision, entry.revision);

  const work = { doi: 'https://doi.org/10.1234/SYNTHETIC', title: 'Synthetic evidence', source: 'https://example.com/article' };
  const saved = await call('scholar_work_save', { id, expected_revision: entry.revision, work });
  assert.equal(saved.profile.works[0].doi, '10.1234/synthetic');
  const match = () => call('scholar_publications', { id });
  let panel = await match();
  assert.deepEqual(panel.items.map(row => [row.id, row.match]), [[verified.id, 'doi'], [nameOnly.id, 'candidate']]);
  assert.deepEqual(panel.linked_dois, ['10.1234/synthetic']);
  assert.equal(panel.items.some(row => row.id === unrelated.id || row.id === archived.id), false);
  const reviewed = await call('scholar_review', { id, expected_revision: saved.revision, paper_id: nameOnly.id, match: 'confirmed' });
  panel = await match();
  assert.equal(panel.items.find(row => row.id === nameOnly.id).match, 'confirmed');
  await call('scholar_save', { id, expected_revision: saved.revision, patch: { followed: false } }, 409);
  const excluded = await call('scholar_review', { id, expected_revision: reviewed.revision, paper_id: nameOnly.id, match: 'excluded' });
  assert.deepEqual((await match()).items.map(row => row.id), [verified.id]);
  const restored = await call('scholar_review', { id, expected_revision: excluded.revision, paper_id: nameOnly.id, match: null });
  const edited = await call('scholar_save', { id, expected_revision: restored.revision, patch: {
    followed: false, topics: [{ name: 'Synthetic topic' }], notes: 'Analysis notes',
  } });
  assert.equal(edited.profile.topics[0].url, 'https://example.com/topic');
  assert.equal((await call('scholar_list')).items[0].followed, false);
  assert.equal((await match()).items.find(row => row.id === nameOnly.id).match, 'candidate');
  assert.equal((await call('get', { id: verified.id })).title, 'Synthetic evidence');
});

test('the scholar feature is mounted and served by the normal library surface', async () => {
  const handler = createFetchHandler({ basePath: '/library' });
  const html = await handler(new Request('http://localhost/library/'));
  assert.equal(html.status, 200);
  const markup = await html.text();
  assert.match(markup, /id="library-scholars"/);
  for (const file of ['scholars.js', 'scholars.css']) {
    assert.ok(markup.includes(`./${file}`));
    assert.equal((await handler(new Request(`http://localhost/library/${file}`))).status, 200);
  }
});
