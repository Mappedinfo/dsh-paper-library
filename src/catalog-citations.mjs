import { setTimeout as delay } from 'node:timers/promises';
import { arxivID, lookupCitationCount, normalizeDOI } from './paper-fetch.mjs';

const key = 'catalog:citation-counts';
const day = 86_400_000;
const maxBytes = 200 * 1024;

function doiOf(value) {
  try { return typeof value === 'string' ? normalizeDOI(value).toLowerCase() : null; }
  catch { return null; }
}

function identifier(item) {
  const doi = doiOf(item.DOI);
  if (doi) return doi;
  const arxiv = (/^arxiv$/i.test(item.archive || '') && arxivID(item.archive_location)) || arxivID(item.URL);
  return arxiv ? `10.48550/arxiv.${arxiv.replace(/v\d+$/i, '').toLowerCase()}` : null;
}

const validCount = value => Number.isSafeInteger(value) && value >= 0;
const fresh = value => value && Date.now() - Date.parse(value.fetched_at) < (value.status === 'found' ? 7 : 1) * day;

function savedSnapshot(item) {
  for (const [source, count, record] of [
    ['OpenAlex', item.openalex?.cited_by_count, item.openalex],
    ['Crossref', item.crossref?.['is-referenced-by-count'] ?? item['is-referenced-by-count'], item.crossref],
    ['Semantic Scholar', item.semantic_scholar?.citationCount, item.semantic_scholar],
  ]) {
    if (validCount(count)) {
      const fetched = record?.fetched_at ?? record?.as_of;
      return { status: 'found', count, source, fetched_at: typeof fetched === 'string' ? fetched : null };
    }
  }
  return null;
}

function records(record) {
  return new Map(Array.isArray(record?.value) ? record.value.map(value => [value.doi, value]) : []);
}

export function createCatalogCitations({ store, fetchOptions = {} }) {
  let nextLookup = 0;
  const flights = new Map();

  async function lookup(doi) {
    const start = Math.max(nextLookup, Date.now());
    nextLookup = start + 300;
    if (start > Date.now()) await delay(start - Date.now());
    return lookupCitationCount(doi, fetchOptions);
  }

  async function remember(updates) {
    if (!updates.length) return;
    for (let attempt = 0; attempt < 4; attempt++) {
      const current = await store.get(key);
      const values = records(current);
      for (const item of updates) {
        const previous = values.get(item.doi);
        if (previous?.status === 'found' && item.status !== 'found') continue;
        if (previous?.fetched_at > item.fetched_at) continue;
        values.delete(item.doi);
        values.set(item.doi, item);
      }
      const entries = [...values.values()].reverse(), kept = [];
      let bytes = 2;
      for (const entry of entries) {
        bytes += Buffer.byteLength(JSON.stringify(entry), 'utf8') + 1;
        if (bytes > maxBytes) break;
        kept.push(entry);
      }
      try {
        await store.put(key, kept.reverse(), current.revision);
        return;
      } catch (error) {
        if (error.code !== 'STATE_CONFLICT' || attempt === 3) throw error;
      }
    }
  }

  async function hydrate(result) {
    const items = result.items || [];
    if (!items.some(item => !item.resource_kind || item.resource_kind === 'paper')) return result;
    const values = records(await store.get(key).catch(() => null));
    return { ...result, items: items.map(item => {
      if (item.resource_kind && item.resource_kind !== 'paper') return item;
      const doi = identifier(item);
      const cached = values.get(doi);
      const snapshot = cached?.status === 'found' ? cached : savedSnapshot(item) || cached;
      return { ...item, ...(doi ? { citation_lookup_doi: doi, citation_needs_lookup: !fresh(cached) } : {}),
        ...(snapshot ? { citation_snapshot: snapshot } : {}) };
    }) };
  }

  async function refresh(input, { signal } = {}) {
    if (!Array.isArray(input.dois) || input.dois.length < 1 || input.dois.length > 8 || input.dois.some(value => !doiOf(value))) {
      throw new Error('请提供 1–8 个有效 DOI 查询引用量。');
    }
    const keys = [...new Set(input.dois.map(doiOf))];
    const values = records(await store.get(key));
    const updates = [];
    const items = await Promise.all(keys.map(async doi => {
      signal?.throwIfAborted();
      const existing = values.get(doi);
      if (fresh(existing)) return existing;
      // Keyless traffic is paced across simultaneous catalog requests. Joining
      // another window's request never makes either caller own its cancellation.
      let flight = flights.get(doi);
      if (!flight) {
        flight = lookup(doi).finally(() => flights.delete(doi));
        flights.set(doi, flight);
      }
      const result = await flight;
      if (result.status !== 'unavailable') updates.push(result);
      return result.status !== 'found' && existing?.status === 'found' ? existing : result;
    }));
    signal?.throwIfAborted();
    await remember(updates);
    return { items };
  }

  return { hydrate, refresh };
}
