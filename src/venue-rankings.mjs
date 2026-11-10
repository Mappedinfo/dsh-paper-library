const directoryURL = 'https://raw.githubusercontent.com/haozhou-wong/ccf-recommended-list-2026-markdown/main/data/ccf-2026.json';
const officialURL = 'https://www.ccf.org.cn/Academic_Evaluation/By_category/';
const ojrOrigin = 'https://openjournalrank.com';
const maxBytes = 512 * 1024;
const day = 86_400_000;
let cache;
const ojrFiles = new Map();

function venueKey(value) {
  return value.normalize('NFKC').toLowerCase().replace(/&/g, ' and ')
    .replace(/^proceedings\s+of\s+(?:the\s+)?/, '')
    .replace(/^\d+(?:st|nd|rd|th)\s+/, '')
    .replace(/(?:\s+\(?(?:19|20)\d{2}\)?|\s*['’\-]\d{2})$/u, '')
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

export function matchCcfDirectory(directory, venue, type) {
  const key = venueKey(venue);
  const sections = type === 'article-journal' ? ['journals'] :
    type === 'paper-conference' ? ['conferences'] : ['journals', 'conferences'];
  const matches = [];
  for (const domain of directory.domains) {
    for (const section of sections) {
      for (const rank of ['A', 'B', 'C']) {
        for (const entry of domain[section][rank]) {
          if (key && [entry.abbr, entry.full_name].some(value => venueKey(value) === key)) {
            matches.push({
              name: entry.full_name, acronym: entry.abbr, rank,
              kind: section === 'journals' ? 'journal' : 'conference',
              category: domain.name,
            });
          }
        }
      }
    }
  }
  return matches.slice(0, 12);
}

async function readDirectoryJson(url, label, limit = maxBytes) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(8000), redirect: 'error', headers: { Accept: 'application/json' },
  });
  if (!response.ok || !response.body) throw new Error(`${label}暂时无法读取。`);
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > limit) throw new Error(`${label}大小超过预期。`);
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function downloadDirectory() {
  const data = await readDirectoryJson(directoryURL, 'CCF 目录');
  const validText = value => typeof value === 'string' && value.length <= 500;
  const validEntries = entries => Array.isArray(entries) && entries.length <= 300 &&
    entries.every(entry => validText(entry?.abbr) && validText(entry?.full_name));
  if (data?.metadata?.year !== 2026 || !Array.isArray(data.domains) || data.domains.length !== 10 ||
      !data.domains.every(domain => validText(domain?.name) && ['journals', 'conferences'].every(section =>
        ['A', 'B', 'C'].every(rank => validEntries(domain[section]?.[rank]))))) {
    throw new Error('CCF 目录结构已变化，请查看官方目录。');
  }
  return data;
}

function ojrFile(path) {
  const existing = ojrFiles.get(path);
  if (existing && Date.now() < existing.expires) return existing.promise;
  if (ojrFiles.size >= 24) ojrFiles.delete(ojrFiles.keys().next().value);
  const promise = readDirectoryJson(ojrOrigin + path, 'OpenJournalRank 目录', 1024 * 1024)
    .catch(error => {
      if (ojrFiles.get(path)?.promise === promise) ojrFiles.delete(path);
      throw error;
    });
  ojrFiles.set(path, { expires: Date.now() + day, promise });
  return promise;
}

const journalName = name => String(name || '').normalize('NFKD').replace(/\p{M}/gu, '')
  .toLowerCase().replace(/&/g, ' and ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const journalId = entry => Array.isArray(entry) && /^S[1-9]\d{0,15}$/.test(entry[0]) && typeof entry[1] === 'string';
const normalizeIssn = value => String(value || '').trim().toUpperCase().replace(/^(\d{4})-?(\d{3}[\dX])$/, '$1-$2');

async function openJournalCandidates(venue, issn) {
  const manifest = await ojrFile('/search/manifest.json');
  if (manifest?.version !== 1 || !Array.isArray(manifest.keys) || !Array.isArray(manifest.issn))
    throw new Error('OpenJournalRank 搜索目录结构已变化。');
  const codes = [...new Set([...issn, venue].map(normalizeIssn).filter(value => /^\d{4}-\d{3}[\dX]$/.test(value)))].slice(0, 2);
  const byIssn = (await Promise.all(codes.filter(code => manifest.issn.includes(code.slice(0, 3))).map(async code => {
    const shard = await ojrFile(`/search/issn/${code.slice(0, 3)}.json`);
    return shard.e?.[code];
  }))).filter(journalId);
  if (byIssn.length) return byIssn;
  const name = journalName(venue);
  if (!name || codes.includes(normalizeIssn(venue))) return [];
  const stop = new Set([...(Array.isArray(manifest.stop) ? manifest.stop : []), 'journal', 'research', 'international']);
  const keys = new Set(manifest.keys.filter(value => typeof value === 'string' && /^[a-z0-9]{2,40}$/.test(value)));
  const shards = [];
  for (const word of name.split(' ').filter(value => !stop.has(value)).sort((a, b) => b.length - a.length)) {
    const key = [...keys].filter(value => word.startsWith(value)).sort((a, b) => b.length - a.length)[0];
    if (key && !shards.includes(key)) shards.push(key);
    if (shards.length === 2) break;
  }
  const files = await Promise.all(shards.map(key => ojrFile(`/search/t/${key}.json`)));
  const entries = files.flatMap(file => Array.isArray(file.e) ? file.e : []).filter(journalId);
  const exact = entries.filter(entry => [entry[1], entry[8]].some(value => journalName(value) === name));
  return exact.length ? exact : entries.filter(entry => name.length >= 12 && journalName(entry[1]).startsWith(name + ' '));
}

async function lookupOpenJournalRank(venue, issn) {
  const candidates = await openJournalCandidates(venue, Array.isArray(issn) ? issn.slice(0, 2) : [issn]);
  const entries = [...new Map(candidates.map(entry => [entry[0], entry])).values()].slice(0, 5);
  const matches = [];
  if (entries.length) {
    const taxonomy = await ojrFile('/i18n/en.json');
    for (const entry of entries) {
      const id = entry[0], data = await ojrFile(`/data/journals/${id}.json`);
      const quartile = data?.ranks?.subfield?.quartile;
      const category = taxonomy.categories?.find(value => value.level === 'subfield' && value.id === data?.subfield)?.name;
      if (data?.id !== id || !Number.isInteger(data.year) || data.year < 1900 || data.year > 9999 ||
          typeof data.title !== 'string' || typeof category !== 'string' || ![1, 2, 3, 4].includes(quartile)) continue;
      matches.push({name:data.title, kind:'journal', system:'OJR', quartile:`Q${quartile}`, year:data.year, category,
        source:`${ojrOrigin}/en/journals/${id}/`, release:typeof data.release === 'string' ? data.release : ''});
    }
  }
  return {system:'OJR',source:`${ojrOrigin}/en/methodology/`,matches};
}

export async function lookupVenueRanking(request) {
  const venue = typeof request.venue === 'string' ? request.venue.trim() : '';
  if (!venue || venue.length > 500) throw new Error('请填写 1–500 字的会议或期刊名称。');
  if (request.system === 'OJR') return lookupOpenJournalRank(venue, request.issn);
  if (!cache || Date.now() >= cache.expires) {
    cache = { expires: Date.now() + day, result: downloadDirectory().catch(error => {
      cache = undefined;
      throw error;
    }) };
  }
  const directory = await cache.result;
  return { system: 'CCF', year: 2026, source: officialURL, matches: matchCcfDirectory(directory, venue, request.type) };
}
