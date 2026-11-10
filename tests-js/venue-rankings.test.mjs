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

test('OpenJournalRank resolves journal title or ISSN and returns a sourced subfield quartile', async t => {
  const calls = [];
  const journal = ['S1234','Synthetic Transport Journal','3210','US',1,1,2,'1234-5679',''];
  const files = {
    '/search/manifest.json':{version:1,keys:['tra'],issn:['123'],stop:['synthetic']},
    '/search/t/tra.json':{e:[journal,['S2345','Other Transport Journal']]},
    '/search/issn/123.json':{e:{'1234-5679':journal}},
    '/i18n/en.json':{categories:[{id:'3210',level:'subfield',name:'Synthetic category'}]},
    '/data/journals/S1234.json':{id:'S1234',title:journal[1],year:2025,subfield:'3210',release:'2025.2',ranks:{subfield:{quartile:2},global:{quartile:1}}},
  };
  t.mock.method(globalThis, 'fetch', async url => {
    const parsed = new URL(url);
    assert.equal(parsed.origin,'https://openjournalrank.com');
    assert.equal(parsed.search,'');
    calls.push(parsed.pathname);
    assert.ok(files[parsed.pathname],parsed.pathname);
    return Response.json(files[parsed.pathname]);
  });
  const title = await lookupVenueRanking({system:'OJR',venue:journal[1]});
  const issn = await lookupVenueRanking({system:'OJR',venue:'12345679'});
  assert.deepEqual(title.matches,issn.matches);
  assert.deepEqual(title.matches[0],{name:journal[1],kind:'journal',system:'OJR',quartile:'Q2',year:2025,
    category:'Synthetic category',source:'https://openjournalrank.com/en/journals/S1234/',release:'2025.2'});
  assert.equal(calls.filter(path=>path==='/data/journals/S1234.json').length,1);
});
