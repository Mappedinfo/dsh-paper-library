import test from 'node:test';
import assert from 'node:assert/strict';
import { lookupVenueRanking, matchCcfDirectory } from '../src/venue-rankings.mjs';

const directory = {
  metadata: { year: 2026 },
  domains: Array.from({ length: 10 }, (_, index) => ({
    name: `Synthetic category ${index}`,
    journals: { A: index ? [] : [{ abbr: 'SYN', full_name: 'Synthetic Journal' }], B: [], C: [] },
    conferences: { A: [], B: index ? [] : [{ abbr: 'SYN', full_name: 'Synthetic International Conference' }], C: [] },
  })),
};

test('matches exact venue names or acronyms without accepting workshops', () => {
  assert.deepEqual(matchCcfDirectory(directory, 'Proceedings of the 12th SYN 2026', 'paper-conference').map(row => row.rank), ['B']);
  assert.deepEqual(matchCcfDirectory(directory, 'Synthetic Journal').map(row => row.kind), ['journal']);
  assert.equal(matchCcfDirectory(directory, 'SYN').length, 2);
  assert.deepEqual(matchCcfDirectory(directory, 'SYN Workshop'), []);
});

test('on-demand ranking fetch shares a bounded fixed public request and can retry a failure', async t => {
  const urls = [];
  t.mock.method(globalThis, 'fetch', async url => {
    urls.push(url);
    return urls.length === 1 ? new Response('unavailable', { status: 503 }) : Response.json(directory);
  });
  await assert.rejects(lookupVenueRanking({ venue: 'SYN' }), /暂时无法读取/);
  const [conference, journal] = await Promise.all([
    lookupVenueRanking({ venue: 'Synthetic International Conference' }),
    lookupVenueRanking({ venue: 'Synthetic Journal' }),
  ]);
  assert.equal(conference.year, 2026);
  assert.equal(conference.matches[0].rank, 'B');
  assert.equal(journal.matches[0].rank, 'A');
  assert.equal(urls.length, 2);
  assert.equal(urls[0], urls[1]);
  assert.equal(new URL(urls[0]).search, '');
  assert.ok(!urls[0].includes('Synthetic'));
});
