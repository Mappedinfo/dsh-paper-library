import { randomUUID } from 'node:crypto';
import { LocalStateError } from '../local-state.mjs';
import { normalizeDOI } from '../paper-fetch.mjs';

const prefix = 'scholar:profile:';
const fields = {
  name: 160, native_name: 160, organization: 240, department: 240, position: 160,
  email_domain: 253, notes: 4000,
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

function editProfile(previous, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw invalid('学者资料无效。');
  const profile = { ...previous };
  for (const [key, limit] of Object.entries(fields)) {
    if (Object.hasOwn(patch, key)) profile[key] = text(patch[key], limit, '资料');
  }
  if (!profile.name) throw invalid('请输入学者姓名。');
  if (profile.email_domain && !/^(?:[a-z\d](?:[a-z\d-]*[a-z\d])?\.)+[a-z]{2,}$/i.test(profile.email_domain)) {
    throw invalid('请输入有效的邮箱域名。');
  }
  if (Object.hasOwn(patch, 'aliases')) profile.aliases = [...new Set(list(patch.aliases, 8).map(name => text(name, 160, '姓名别名', true)))];
  if (Object.hasOwn(patch, 'homepage')) profile.homepage = patch.homepage ? publicLink(patch.homepage) : '';
  if (Object.hasOwn(patch, 'organization_url')) profile.organization_url = patch.organization_url ? publicLink(patch.organization_url) : '';
  if (Object.hasOwn(patch, 'topics')) {
    const topics = new Map((profile.topics || []).map(topic => [topic.name, topic]));
    for (const topic of list(patch.topics, 16)) {
      if (!topic || typeof topic !== 'object') throw invalid('研究方向无效。');
      const name = text(topic.name, 120, '研究方向', true);
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

export function createScholars({ store, request }) {
  const pack = record => ({ profile: record.value, revision: record.revision });
  async function read(id) {
    const record = await store.get(identity(id));
    if (!record.value) throw new LocalStateError('找不到该学者。', 'SCHOLAR_NOT_FOUND', 404);
    return record;
  }
  return async function scholars(input, { signal } = {}) {
    if (input.action === 'scholar_list') {
      const page = await store.list({ prefix, offset: input.offset ?? 0, limit: 30 });
      const items = page.records.map(({ value }) => ({
        id: value.id, name: label(value), organization: value.organization, followed: value.followed,
      }));
      return { items, total: page.total, next_offset: page.next_offset };
    }
    if (input.action === 'scholar_save' && input.id === undefined) {
      const id = randomUUID();
      const profile = editProfile({ id, followed: true, works: [], reviewed: [] }, input.patch);
      return pack(await store.put(identity(id), profile, 0));
    }
    const record = await read(input.id);
    const profile = record.value;
    if (input.action === 'scholar_get') return pack(record);
    if (input.action === 'scholar_publications') {
      return request({
        action: 'scholar_publications',
        names: [...new Set([profile.name, profile.native_name, ...(profile.aliases || [])].filter(Boolean))],
        dois: profile.works.map(work => work.doi),
        confirmed: profile.reviewed.filter(row => row.match === 'confirmed').map(row => row.id),
        excluded: profile.reviewed.filter(row => row.match === 'excluded').map(row => row.id),
        offset: input.offset ?? 0,
      }, signal);
    }
    let next;
    if (input.action === 'scholar_save') next = editProfile(profile, input.patch);
    else if (input.action === 'scholar_work_save') {
      const work = publication(input.work);
      if (input.previous_doi && input.previous_doi !== work.doi && profile.works.some(row => row.doi === work.doi)) throw invalid('已登记相同 DOI。');
      const others = profile.works.filter(row => row.doi !== work.doi && row.doi !== input.previous_doi);
      next = { ...profile, works: list([...others, work], 50) };
    } else if (input.action === 'scholar_review') {
      const { paper_id, match } = input;
      if (typeof paper_id !== 'string' || !identifier.test(paper_id) || !['confirmed', 'excluded', null].includes(match)) throw invalid('论文关联状态无效。');
      const reviewed = profile.reviewed.filter(row => row.id !== paper_id);
      if (match) {
        const { id, title, archived, resource_kind } = await request({ action: 'get', id: paper_id }, signal);
        if (id !== paper_id || archived || (resource_kind && resource_kind !== 'paper')) throw invalid('论文已不可用。');
        reviewed.push({ id, title: String(title || id).slice(0, 500), match });
      }
      next = { ...profile, reviewed: list(reviewed, 500) };
    } else throw invalid('学者操作无效。');
    return pack(await store.put(record.key, next, input.expected_revision));
  };
}
