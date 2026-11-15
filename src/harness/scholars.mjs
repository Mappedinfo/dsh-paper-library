import { randomUUID } from 'node:crypto';
import { LocalStateError } from '../local-state.mjs';
import { normalizeDOI } from '../paper-fetch.mjs';
import { RESEARCH_TYPES, researchIdentity } from './research-directory.mjs';

const prefix = 'scholar:profile:';
const fields = {
  name: 160, native_name: 160, organization: 240, department: 240, position: 160,
  email_domain: 253, notes: 4000, publication_count_source: 500,
};
const identifier = /^[A-Za-z0-9_-]{1,160}$/;
const invalid = message => new LocalStateError(message, 'SCHOLAR_INVALID');
const list = (value, max) => {
  if (!Array.isArray(value) || value.length > max) throw invalid(`列表最多可保存 ${max} 项。`);
  return value;
};
function text(value, limit, label, required = false) {
  if (typeof value !== 'string' || value.length > limit || (required && !value.trim())) {
    throw invalid(`请填写有效的${label}，最多 ${limit} 字符。`);
  }
  return value.trim();
}
function publicLink(value) {
  const input = text(value, 2048, '来源链接', true);
  let url;
  try { url = new URL(input); } catch { throw invalid('请输入有效的网页链接。'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw invalid('请输入 HTTP 或 HTTPS 来源链接。');
  return url.href;
}
function identity(id) {
  if (typeof id !== 'string' || !identifier.test(id)) throw invalid('学者标识无效。');
  return prefix + id;
}
const label = profile => profile.native_name && profile.native_name !== profile.name
  ? `${profile.native_name} / ${profile.name}` : profile.name;
const matchText = value => String(value ?? '').normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');
const personNames = person => [person.name, person.native_name, ...(person.aliases || [])].map(matchText);

function memberRows(profile, people, importedById) {
  const explicit = (profile.member_profile_ids || []).map(id => {
    const identity = importedById.get(id);
    const exact = people.find(person => person.id === id);
    if (exact || !identity) return exact;
    const matches = people.filter(person => researchIdentity(person) === researchIdentity(identity));
    return matches.length === 1 ? matches[0] : identity;
  }).filter(Boolean);
  const local = profile.organization
    ? people.filter(person => matchText(person.organization) === matchText(profile.organization)) : [];
  const usedNames = new Set(), usedIds = new Set(), rows = [];
  function add(name, person) {
    if (person && usedIds.has(person.id)) return;
    if (person) usedIds.add(person.id);
    rows.push(person ? { name, id: person.id, kind: person.kind, organization: person.organization } : { name });
  }
  for (const name of profile.members || []) {
    const key = matchText(name);
    if (!key || usedNames.has(key)) continue;
    usedNames.add(key);
    const named = explicit.filter(person => personNames(person).includes(key));
    if (named.length) {
      for (const person of named) add(name, person);
      continue;
    }
    const matches = local.filter(person => personNames(person).includes(key));
    add(name, matches.length === 1 ? matches[0] : null);
  }
  for (const person of explicit) add(person.name, person);
  return rows.slice(0, 100);
}

function editProfile(previous, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw invalid('学者资料无效。');
  const profile = { ...previous };
  for (const [key, limit] of Object.entries(fields)) {
    if (Object.hasOwn(patch, key)) profile[key] = text(patch[key], limit, '资料');
  }
  if (!profile.name) throw invalid('请输入学者姓名。');
  if (Object.hasOwn(patch, 'kind')) {
    if (!RESEARCH_TYPES.includes(patch.kind)) throw invalid('研究人员类别无效。');
    profile.kind = patch.kind;
  }
  if (Object.hasOwn(patch, 'publication_count')) {
    const count = patch.publication_count;
    if (count !== null && (!Number.isSafeInteger(count) || count < 0 || count > 10000000)) throw invalid('发文量须为非负整数。');
    profile.publication_count = count;
  }
  if (profile.email_domain && !/^(?:[a-z\d](?:[a-z\d-]*[a-z\d])?\.)+[a-z]{2,}$/i.test(profile.email_domain)) {
    throw invalid('请输入有效的邮箱域名。');
  }
  if (Object.hasOwn(patch, 'aliases')) profile.aliases = [...new Set(list(patch.aliases, 8).map(name => text(name, 160, '姓名别名', true)))];
  if (Object.hasOwn(patch, 'homepage')) profile.homepage = patch.homepage ? publicLink(patch.homepage) : '';
  if (Object.hasOwn(patch, 'organization_url')) profile.organization_url = patch.organization_url ? publicLink(patch.organization_url) : '';
  if (Object.hasOwn(patch, 'topics')) {
    const topics = new Map((profile.topics || []).map(topic => [topic.name, topic]));
    for (const topic of list(patch.topics, 24)) {
      if (!topic || typeof topic !== 'object') throw invalid('研究方向无效。');
      const name = text(topic.name, 320, '研究方向', true);
      const url = Object.hasOwn(topic, 'url') ? (topic.url ? publicLink(topic.url) : '') : topics.get(name)?.url;
      topics.set(name, { name, ...(url ? { url } : {}) });
    }
    profile.topics = [...new Set(patch.topics.map(topic => topic.name.trim()))].map(name => topics.get(name));
  }
  if (Object.hasOwn(patch, 'followed')) {
    if (typeof patch.followed !== 'boolean') throw invalid('关注状态无效。');
    profile.followed = patch.followed;
  }
  return profile;
}

function publication(value) {
  if (!value || typeof value !== 'object') throw invalid('代表作资料无效。');
  let doi;
  try { doi = normalizeDOI(text(value.doi, 400, 'DOI', true)).toLowerCase(); }
  catch { throw invalid('请输入有效的 DOI。'); }
  const year = value.year ?? null;
  if (year !== null && (!Number.isSafeInteger(year) || year < 1000 || year > 9999)) throw invalid('发表年份无效。');
  return {
    doi, year,
    title: text(value.title, 500, '论文题名', true),
    venue: text(value.venue ?? '', 300, '出处'),
    source: publicLink(value.source),
    note: text(value.note ?? '', 800, '论文备注'),
  };
}

export function createScholars({ store, request, directory }) {
  const empty = { entries: [], entriesById: new Map(), publications: new Map() };
  const overlay = (imported, manual) => ({ kind: 'scholar', ...imported, ...manual });
  const pack = (profile, revision) => {
    const { publication_keys, member_profile_ids, ...rest } = profile;
    return { profile: { ...rest, linked_publication_count: publication_keys?.length ?? 0 }, revision };
  };
  async function read(id, data) {
    const record = await store.get(identity(id));
    const imported = data.entriesById.get(id) || (record.value && data.entries.find(item => researchIdentity(item) === researchIdentity(record.value)));
    if (!record.value && !imported) throw new LocalStateError('找不到该档案。', 'SCHOLAR_NOT_FOUND', 404);
    return { record, imported, profile: overlay(imported, record.value) };
  }
  async function directoryProfiles(data, signal) {
    const imported = new Map(data.entriesById), importedIdentities = new Map(data.entries.map(item => [researchIdentity(item), item]));
    const manual = [];
    for (let start = 0; start !== null;) {
      signal?.throwIfAborted();
      const page = await store.list({ prefix, offset: start, limit: 50 });
      for (const { value } of page.records) {
        const base = imported.get(value.id) || importedIdentities.get(researchIdentity(value));
        if (base) imported.delete(base.id);
        manual.push(overlay(base, value));
      }
      start = page.next_offset;
    }
    return [...manual, ...imported.values()];
  }
  return async function scholars(input, { signal } = {}) {
    if (input.action === 'scholar_import') return directory.refresh({ signal });
    const data = directory ? await directory.load() : empty;
    if (input.action === 'scholar_list') {
      const offset = input.offset ?? 0, kind = input.kind ?? '', query = text(input.query ?? '', 200, '检索词').normalize('NFKC').toLowerCase();
      if (!Number.isSafeInteger(offset) || offset < 0 || (kind && !RESEARCH_TYPES.includes(kind))) throw invalid('目录筛选参数无效。');
      const visible = (await directoryProfiles(data, signal)).filter(item => {
        if (kind && item.kind !== kind && !item.roles?.includes(kind)) return false;
        return !query || [item.name, item.native_name, item.organization, ...(item.aliases || []), ...(item.topics || []).map(topic => topic.name)]
          .some(value => typeof value === 'string' && value.normalize('NFKC').toLowerCase().includes(query));
      }).sort((a, b) => Number(b.followed) - Number(a.followed) || label(a).localeCompare(label(b), 'zh-CN') || a.id.localeCompare(b.id));
      const items = visible.slice(offset, offset + 30).map(value => ({
        id: value.id, name: label(value), organization: value.organization, followed: value.followed, kind: value.kind,
        publication_count: value.publication_count, linked_publication_count: value.publication_keys?.length ?? value.works.length,
        source_work_count: value.source_work_count, topics: value.topics?.slice(0, 3), evidence_status: value.evidence_status,
      }));
      return { items, total: visible.length, next_offset: offset + items.length < visible.length ? offset + items.length : null, counts: data.counts };
    }
    if (input.action === 'scholar_save' && input.id === undefined) {
      const id = randomUUID();
      const profile = editProfile({ id, kind: 'scholar', followed: true, works: [], reviewed: [] }, input.patch);
      return pack(profile, (await store.put(identity(id), profile, 0)).revision);
    }
    const { record, imported, profile } = await read(input.id, data);
    if (input.action === 'scholar_get') {
      const result = pack(profile, record.revision);
      if (profile.members?.length || profile.member_profile_ids?.length) {
        const people = (await directoryProfiles(data, signal)).filter(item => ['scholar', 'pi'].includes(item.kind));
        result.profile.member_rows = memberRows(profile, people, data.entriesById);
      }
      return result;
    }
    if (input.action === 'scholar_source_publications') {
      const offset = input.offset ?? 0;
      if (!Number.isSafeInteger(offset) || offset < 0) throw invalid('论文分页无效。');
      const keys = profile.publication_keys || [];
      const items = keys.slice(offset, offset + 40).map(key => data.publications.get(key)).filter(Boolean);
      return { items, total: keys.length, has_more: offset + items.length < keys.length };
    }
    if (input.action === 'scholar_publications') {
      return request({
        action: 'scholar_publications',
        names: ['scholar', 'pi'].includes(profile.kind) ? [...new Set([profile.name, profile.native_name, ...(profile.aliases || [])].filter(Boolean))] : [],
        dois: profile.works.map(work => work.doi),
        confirmed: profile.reviewed.filter(row => row.match === 'confirmed').map(row => row.id),
        excluded: profile.reviewed.filter(row => row.match === 'excluded').map(row => row.id),
        offset: input.offset ?? 0,
      }, signal);
    }
    const manual = record.value || { id: profile.id, name: profile.name, followed: profile.followed, works: [], reviewed: [] };
    let next;
    if (input.action === 'scholar_save') next = editProfile(manual, input.patch);
    else if (input.action === 'scholar_work_save') {
      const work = publication(input.work);
      if (input.previous_doi && input.previous_doi !== work.doi && profile.works.some(row => row.doi === work.doi)) throw invalid('已登记相同 DOI。');
      const others = profile.works.filter(row => row.doi !== work.doi && row.doi !== input.previous_doi);
      next = { ...manual, works: list([...others, work], 50) };
    } else if (input.action === 'scholar_review') {
      const { paper_id, match } = input;
      if (typeof paper_id !== 'string' || !identifier.test(paper_id) || !['confirmed', 'excluded', null].includes(match)) throw invalid('论文关联状态无效。');
      const reviewed = profile.reviewed.filter(row => row.id !== paper_id);
      if (match) {
        const { id, title, archived, resource_kind } = await request({ action: 'get', id: paper_id }, signal);
        if (id !== paper_id || archived || (resource_kind && resource_kind !== 'paper')) throw invalid('论文已不可用。');
        reviewed.push({ id, title: String(title || id).slice(0, 500), match });
      }
      next = { ...manual, reviewed: list(reviewed, 500) };
    } else throw invalid('学者操作无效。');
    const saved = await store.put(record.key, next, input.expected_revision);
    return pack(overlay(imported, saved.value), saved.revision);
  };
}
