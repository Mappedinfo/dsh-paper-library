import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFetchHandler } from '../src/http.mjs';
import { createHash } from 'node:crypto';
import { createLocalStateStore } from '../src/local-state.mjs';

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

test('research directory imports affiliations and topic groups with sources and retains edits on refresh', async t => {
  const root = await mkdtemp(join(tmpdir(), 'research-directory-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const options = { library: join(root, 'library'), localStateHome: join(root, 'state') };
  const handle = createFetchHandler(options);
  async function call(action, args = {}) {
    const response = await handle(new Request('http://localhost/api', { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, ...args }) }));
    const payload = await response.json();
    assert.equal(response.status, 200, JSON.stringify(payload));
    return payload.result;
  }

  const paper = await call('create', { metadata: { title: 'Synthetic study', DOI: '10.1234/synthetic-group',
    author: [{ given: 'Jane', family: 'Synthetic', affiliation: [{ name: 'Mobility Lab, Example University' }] }] } });
  const evidence = { id: 'source', title: 'Synthetic lab source', url: 'https://example.com/lab' };
  const document = {
    schema_version: 1, topic: { id: 'synthetic-topic', title: 'Synthetic topic', question: 'Example?' },
    sources: [evidence], claims: [],
    scholars: [
      { id: 'jane', name: 'Jane Synthetic', current_role: 'Professor and Director of Mobility Lab', organization: 'Example University',
        source_ids: ['source'], research_interests: ['Mobility'], contributions: [{ paper_id: 'work', source_ids: ['source'] }] },
      { id: 'partner', name: 'Alex Synthetic', organization: 'Partner University', source_ids: ['source'], contributions: [] },
      { id: 'another-jane', name: 'Jane Synthetic', organization: 'Different University', source_ids: ['source'], contributions: [] },
      { id: 'name-only', name: 'Unmatched Synthetic', organization: 'Different University', source_ids: ['source'], contributions: [] },
    ],
    papers: [{ id: 'work', title: paper.title, doi: '10.1234/synthetic-group', local_paper_id: paper.id, source_ids: ['source'],
      comparison: { research_group: { value: 'Other Author（通讯作者，假定 PI；组归属待核）', status: 'needs_review', source_ids: ['source'] } } }],
    groups: [
      { id: 'theme', title: 'Topic bucket', relationship_type: 'analyst_primary_task_category', not_a_verified_current_lab: true, source_ids: ['source'] },
      { id: 'lab', name: 'Mobility Lab', members: ['Jane Synthetic'], source_ids: ['source'] },
    ],
    research_lines: [{ id: 'coauthored-work', name: 'Network generation', status: 'evidence_based_topic_line_not_current_team',
      members: ['Unmatched Synthetic'], paper_ids: ['work'], source_ids: ['source'] }],
    research_groups: [{ id: 'lab', name: 'Mobility Lab', institution: 'Example University',
      members: ['jane synthetic', 'Unmatched Synthetic'], scholar_ids: ['jane', 'partner'],
      paper_ids: ['work'], source_ids: ['source'], status: 'verified' }],
  };
  await call('field_radar_import', { document, expected_revision: 0 });
  const snapshotDirectory = join(options.library, '.paper-library');
  await mkdir(snapshotDirectory, {recursive:true});
  await writeFile(join(snapshotDirectory, 'field-radar-snapshot.json'), JSON.stringify({
    people: [{ name: 'Jane Synthetic', unit: 'Example University', group: 'Mobility Lab', works: [0], identityVerified: true }],
    works: [{ id: 'synthetic-work', title: paper.title, doi: '10.1234/synthetic-group' }],
  }));
  const legacyId = 'research-' + createHash('sha256').update(JSON.stringify(['group', 'networkgeneration', ''])).digest('hex').slice(0, 28);
  const store = createLocalStateStore({ library: options.library, home: options.localStateHome });
  await store.put('scholar:profile:' + legacyId, { id: legacyId, kind: 'group', name: 'Network generation',
    followed: true, notes: 'Existing group note', works: [], reviewed: [] }, 0);
  const { counts } = await call('scholar_import');
  assert.equal(counts.papers, 1);
  assert.equal(counts.topics, 1);
  assert.equal(counts.group, 1);
  assert.equal(counts.collaboration, 1);
  assert.equal(counts.school, 1);
  assert.equal(counts.snapshot_people, 1);
  const groups = await call('scholar_list', { kind: 'group' });
  const id = groups.items[0].id;
  assert.equal(groups.total, 1);
  assert.equal(groups.items[0].linked_publication_count, 1);
  const collaborators = await call('scholar_list', { kind: 'collaboration' });
  assert.deepEqual(collaborators.items.map(row => [row.id, row.kind, row.followed]), [[legacyId, 'collaboration', true]]);
  const collaboration = (await call('scholar_get', { id: legacyId })).profile;
  assert.equal(collaboration.notes, 'Existing group note');
  assert.deepEqual(collaboration.member_rows, [{ name: 'Unmatched Synthetic' }]);
  assert.equal((await call('scholar_source_publications', { id: legacyId })).items[0].id, paper.id);
  const imported = await call('scholar_get', { id });
  const { member_rows: members } = imported.profile;
  assert.deepEqual(members.map(row => row.name), ['Jane Synthetic', 'Unmatched Synthetic', 'Alex Synthetic']);
  assert.equal(members[0].organization, 'Example University');
  assert.equal(members[0].kind, 'pi');
  assert.equal(members[0].position, 'Professor and Director of Mobility Lab');
  assert.ok(members[0].id);
  assert.deepEqual(members[1], { name: 'Unmatched Synthetic' });
  assert.equal(members[2].organization, 'Partner University');
  assert.equal((await call('scholar_get', { id: members[2].id })).profile.name, 'Alex Synthetic');
  assert.ok(imported.profile.sources.some(source => source.url === evidence.url));
  const sourcePapers = await call('scholar_source_publications', { id });
  assert.equal(sourcePapers.items[0].id, paper.id);
  const types = (await call('scholar_list', { kind: 'pi' })).items.map(row => row.kind);
  assert.deepEqual([...types].sort(), ['lead', 'pi']);
  const person = (await call('scholar_list', { kind: 'pi', query: 'Jane' })).items[0];
  assert.equal((await call('scholar_get', { id: person.id })).profile.source_work_count, 1);
  assert.equal((await call('scholar_list', { query: 'Topic bucket' })).total, 0);
  await call('scholar_save', { id, expected_revision: imported.revision, patch: {
    followed: true, notes: 'Private synthetic note', publication_count: 18, publication_count_source: 'Synthetic CV',
  } });
  await call('scholar_import');
  const restored = (await call('scholar_get', { id })).profile;
  assert.equal(restored.publication_count, 18);
  assert.equal(restored.notes, 'Private synthetic note');
  assert.equal(restored.followed, true);
  assert.equal(restored.linked_publication_count, 1);
  assert.deepEqual(restored.member_rows, members);
});
