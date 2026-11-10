const directoryURL = 'https://raw.githubusercontent.com/haozhou-wong/ccf-recommended-list-2026-markdown/main/data/ccf-2026.json';
const officialURL = 'https://www.ccf.org.cn/Academic_Evaluation/By_category/';
const maxBytes = 512 * 1024;
const day = 86_400_000;
let cache;

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

async function downloadDirectory() {
  const response = await fetch(directoryURL, {
    signal: AbortSignal.timeout(8000), redirect: 'error', headers: { Accept: 'application/json' },
  });
  if (!response.ok || !response.body) throw new Error('CCF 目录暂时无法读取。');
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > maxBytes) throw new Error('CCF 目录大小超过预期。');
    chunks.push(chunk);
  }
  const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
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

export async function lookupVenueRanking(request) {
  const venue = typeof request.venue === 'string' ? request.venue.trim() : '';
  if (!venue || venue.length > 500) throw new Error('请填写 1–500 字的会议或期刊名称。');
  if (!cache || Date.now() >= cache.expires) {
    cache = { expires: Date.now() + day, result: downloadDirectory().catch(error => {
      cache = undefined;
      throw error;
    }) };
  }
  const directory = await cache.result;
  return { system: 'CCF', year: 2026, source: officialURL, matches: matchCcfDirectory(directory, venue, request.type) };
}
