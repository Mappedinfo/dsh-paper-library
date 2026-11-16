import { createHash } from 'node:crypto';
import { LocalStateError } from '../local-state.mjs';

export const RESEARCH_TYPES = Object.freeze(['scholar', 'pi', 'group', 'collaboration', 'school', 'organization', 'lead']);
const manifestKey = 'research-directory:current';
const digest = value => createHash('sha256').update(value).digest('hex');
const clean = (value, width = 240) => typeof value === 'string' ? value.trim().slice(0, width) : '';
const normalized = value => clean(value, 500).normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const array = value => Array.isArray(value) ? value : [];
const known = value => clean(value) && !/^(?:—|-|未知|未核|待核|不详|unknown|unverified|n\/?a)(?:[。.]|$)/i.test(value.trim());
const verified = value => ['verified', 'verified-metadata', 'verified-official'].includes(value);
const personType = value => value === 'scholar' || value === 'pi';
const orgType = name => /\b(?:university|college|polytechnic|universit[éeà])\b|大学|學院|学院/i.test(name) ? 'school' : 'organization';
const labName = name => /\b(?:lab(?:orator(?:y|ies))?|research (?:group|team))\b|实验室|實驗室|课题组|研究组/i.test(name);
const leader = value => /\b(?:principal investigator|lab director|group leader|lab head|PI)\b|\bdirector of\b.{0,90}\b(?:lab|laboratory)\b|课题组负责人|实验室主任|首席研究员/i.test(clean(value));
const collaborationName = name => /合作|协作|署名|研究线|发表团队|collaboration|coauthorship|research line/i.test(name);
const validDOI = value => /^10\.\d{4,9}\//i.test(value);

function publicURL(value) {
  try {
    const href = new URL(value);
    return ['http:', 'https:'].includes(href.protocol) && !href.username && !href.password && href.href.length <= 2048 ? href.href : '';
  } catch { return ''; }
}
const unique = values => [...new Set(values.filter(Boolean))];
const affiliation = value => clean(typeof value === 'string' ? value : value?.name || value?.label);
const displayName = person => clean(person?.literal || [person?.given, person?.family].filter(Boolean).join(' '), 160);
const invalid = (message, status = 400) => new LocalStateError(message, 'RESEARCH_DIRECTORY_INVALID', status);
const ref = (value, fallback) => typeof value === 'string' ? { label: clean(value, 500) } :
  { label: clean(value?.title || value?.label, 500) || fallback, url: publicURL(value?.url || value?.href) };

export function researchIdentity(profile) {
  const kind = personType(profile.kind || 'scholar') ? 'person' : profile.kind;
  return JSON.stringify([kind, normalized(profile.name), normalized(profile.organization)]);
}

function buildDirectory(catalog, documents, snapshot, relations) {
  const profiles = new Map(), publications = new Map(), localDois = new Map();
  const catalogById = new Map(catalog.map(paper => [paper.id, paper]));
  const libraryRef = { label: '文献库题录 · 发表时署名' };
  function work(input) {
    const title = clean(input.title, 500), doi = clean(input.DOI || input.doi, 400).replace(/^https?:\/\/doi\.org\//i, '').toLowerCase();
    const local = catalogById.get(clean(input.local_paper_id, 160));
    const localDOI = clean(local?.DOI, 400).toLowerCase();
    const declaredMatches = local && (doi && localDOI ? doi === localDOI : normalized(local.title) === normalized(title));
    const localId = declaredMatches ? local.id : localDois.get(doi);
    const authors = array(input.author || input.authors).map(value => typeof value === 'string' ? clean(value, 160) : displayName(value)).filter(Boolean).slice(0, 20);
    const venue = clean(input['container-title'] || input.venue, 300);
    const url = publicURL(input.URL || input.url) || (validDOI(doi) ? 'https://doi.org/' + doi : '');
    const key = localId ? 'local:' + localId : validDOI(doi) ? 'doi:' + doi : 'bib:' +
      digest(JSON.stringify([normalized(title), input.year || '', normalized(authors[0]), normalized(venue), url]));
    if (!title) return '';
    if (!publications.has(key)) {
      const year = input.issued?.['date-parts']?.[0]?.[0] ?? input.year;
      publications.set(key, { ...(localId ? { id: localId } : {}), title, ...(validDOI(doi) ? { doi } : {}),
        year: Number.isSafeInteger(year) ? year : null, venue, url, pdf: input.pdf === true, authors });
    }
    return key;
  }
  function add(value, { sources = [], works = [], status = 'needs_review', context = '', legacyKind = value.kind } = {}) {
    const name = clean(value.name, 160), organization = clean(value.organization);
    if (!known(name)) return;
    const identity = researchIdentity({ kind: legacyKind, name, organization });
    const id = 'research-' + digest(identity).slice(0, 28);
    let item = profiles.get(id);
    if (!item) {
      item = { id, kind: value.kind, name, organization, aliases: [], topics: [], members: [], roles: [], sources: [], evidence_status: status,
        ...(legacyKind !== value.kind ? { legacy_kind: legacyKind } : {}),
        citations: new Set(), references: new Map(), followed: false, works: [], reviewed: [] };
      profiles.set(id, item);
    }
    if (value.kind === 'pi') item.kind = 'pi';
    if (status === 'verified' || item.evidence_status !== 'verified' && status === 'publication') item.evidence_status = status;
    for (const key of ['native_name', 'position', 'department', 'homepage']) if (!item[key] && value[key]) item[key] = clean(value[key], key === 'homepage' ? 2048 : 240);
    for (const key of ['description', 'scope', 'evidence_note', 'last_checked']) {
      const text = clean(value[key], 1200);
      if (text && !item[key]) item[key] = text;
    }
    if (Number.isSafeInteger(value.publication_count) && value.publication_count >= 0 && item.publication_count == null) {
      item.publication_count = value.publication_count;
      item.publication_count_source = clean(value.publication_count_source);
    }
    if (value.followed) item.followed = true;
    item.aliases = unique([...item.aliases, ...array(value.aliases).map(alias => clean(alias, 160))]).slice(0, 8);
    if (Number.isSafeInteger(value.source_work_count)) item.source_work_count = Math.max(item.source_work_count || 0, value.source_work_count);
    item.roles = unique([...item.roles, ...array(value.roles)]);
    item.members = unique([...item.members, ...array(value.members).map(member => clean(typeof member === 'string' ? member : member?.name, 160))]);
    if (value.memberIds?.length) item.member_profile_ids = unique([...(item.member_profile_ids || []), ...value.memberIds]).slice(0, 100);
    for (const candidate of array(value.topics)) {
      const text = clean(typeof candidate === 'string' ? candidate : candidate?.name || candidate?.label || candidate?.topic, 320);
      if (text && !item.topics.some(topic => topic.name === text)) item.topics.push({ name: text });
    }
    for (const source of sources.map(source => ref(source, context)).filter(source => source.label)) {
      const locator = clean(source.url ? '' : context, 500);
      const key = JSON.stringify([source.label, source.url || '', locator]);
      if (!item.references.has(key)) item.references.set(key, { ...source, ...(locator ? { context: locator } : {}) });
    }
    for (const key of works) if (key) item.citations.add(key);
    return item;
  }
  for (const paper of catalog) {
    const doi = clean(paper.DOI, 400).toLowerCase();
    if (validDOI(doi)) {
      if (localDois.has(doi)) localDois.set(doi, null);
      else localDois.set(doi, paper.id);
    }
  }
  function addAffiliation(raw, works, sources, status) {
    const name = affiliation(raw);
    if (!known(name)) return;
    // Preserve the supplied affiliation as evidence. An explicit lab component
    // may also have an independently named parent university in the same string.
    const segments = name.split(/[,，;；]/).map(part => part.trim()).filter(Boolean);
    const school = segments.find(part => orgType(part) === 'school');
    const labs = segments.filter(part => labName(part) && orgType(part) !== 'school');
    for (const lab of labs) add({ kind: 'group', name: lab, organization: school }, { works, sources, status });
    if (school) add({ kind: 'school', name: school }, { works, sources, status });
    else if (!labs.length) add({ kind: orgType(name), name }, { works, sources, status });
  }
  for (const paper of catalog) {
    const key = work({ ...paper, local_paper_id: paper.id });
    for (const person of array(paper.author)) {
      for (const unit of array(person?.affiliation)) addAffiliation(unit, [key], [libraryRef], 'publication');
    }
    for (const unit of array(paper.institutions || paper.affiliations)) addAffiliation(unit, [key], [libraryRef], 'publication');
  }
  for (const document of documents) {
    const context = clean(document.topic?.title, 500) || '领域研究';
    const sourceIndex = new Map(array(document.sources).map(source => [source.id, source]));
    const evidence = row => [{ label: '领域研究 · ' + context }, ...array(row?.source_ids).map(id => sourceIndex.get(id)).filter(Boolean)];
    const groupTitle = row => clean(row.name || row.label || row.title, 160);
    function groupKind(row) {
      const name = groupTitle(row);
      const hasLab = labName(name) || known(row.official_lab_name || row.official_group_name)
        || array(row.source_ids).some(id => {
          const source = sourceIndex.get(id);
          const title = normalized(source?.title);
          return source?.kind === 'team_homepage' && title && normalized(name).endsWith(title);
        });
      return !row.not_a_verified_current_lab && !collaborationName(name) && hasLab ? 'group' : 'collaboration';
    }
    const byPaper = new Map(array(document.papers).map(paper => [paper.id, work(paper)]));
    const paperRefs = row => array(row?.paper_ids).map(id => byPaper.get(id)).filter(Boolean);
    const tracked = new Set(array(document.tracking_list).flatMap(row => array(row.scholar_ids)));
    const trackedGroups = new Set(array(document.tracking_list).map(row => row.research_group_id));
    const scholars = new Map();
    for (const row of array(document.scholars)) {
      const role = clean(row.current_role || row.current_title || row.role);
      const topics = Array.isArray(row.research_interests) ? row.research_interests : [row.research_interests];
      const organization = affiliation(row.current_institution || row.current_organization || row.organization || row.organization_at_publication);
      const person = add({ kind: leader(role) ? 'pi' : 'scholar', name: row.name, native_name: row.name_zh, position: role,
        organization, aliases: row.aliases, topics, followed: tracked.has(row.id), publication_count: row.publication_count,
        evidence_note: row.identity_note, last_checked: row.current_affiliation_verified_on,
        publication_count_source: row.publication_count_source || context },
      { sources: evidence(row), works: array(row.contributions).map(item => byPaper.get(item.paper_id)), status: verified(row.identity_status) ? 'verified' : 'needs_review', context });
      if (person) scholars.set(row.id, person.id);
    }
    const groups = new Map();
    for (const row of [...array(document.research_lines), ...array(document.groups), ...array(document.research_groups)]) {
      if (!row || row.relationship_type === 'analyst_primary_task_category') continue;
      if (row.name || row.label || row.title) {
        const id = row.id || row.name || row.label || row.title;
        const previous = groups.get(id);
        groups.set(id, { ...previous, ...row, members: [...array(previous?.members), ...array(row.members)],
          scholar_ids: unique([...array(previous?.scholar_ids), ...array(row.scholar_ids)]) });
      }
    }
    for (const row of groups.values()) {
      const kind = groupKind(row);
      add({ kind, name: groupTitle(row), organization: affiliation(row.institution),
        members: row.members, memberIds: row.scholar_ids.map(id => scholars.get(id)).filter(Boolean),
        topics: [row.research_question, ...array(row.research_interests)], followed: trackedGroups.has(row.id),
        description: row.summary, scope: typeof row.task_boundaries === 'string' ? row.task_boundaries : array(row.task_boundaries).filter(value => typeof value === 'string').join(' · '),
        evidence_note: row.group_name_note, last_checked: row.last_checked },
      { sources: evidence(row), works: paperRefs(row), status: kind === 'group' && verified(row.status) ? 'verified' : 'needs_review', context, legacyKind: 'group' });
    }
    for (const row of array(document.organizations).filter(Boolean)) {
      const name = affiliation(row);
      add({ kind: orgType(name), name }, { sources: evidence(row), works: paperRefs(row), status: verified(row.status) ? 'verified' : 'publication', context });
    }
    for (const paper of array(document.papers)) {
      const works = [byPaper.get(paper.id)];
      for (const unit of array(paper.institutions)) addAffiliation(unit, works, evidence(paper), 'publication');
      const group = paper.comparison?.research_group;
      if (known(group?.value)) {
        const pendingPI = /假定\s*PI|\bPI\s*待核/i.test(group.value);
        const matched = [...groups.values()].find(row => normalized(groupTitle(row)) === normalized(group.value));
        const legacyKind = matched || verified(group.status) && labName(group.value) ? 'group' : 'lead';
        const kind = matched ? groupKind(matched) : collaborationName(group.value) && !pendingPI ? 'collaboration' : legacyKind;
        add({ kind, name: group.value, organization: affiliation(matched?.institution), roles: pendingPI ? ['pi'] : [] },
          { sources: [...evidence(paper), ...evidence(group)], works, status: verified(group.status) && kind === 'group' ? 'verified' : 'needs_review', context, legacyKind });
      }
    }
  }
  if (relations) {
    const groups = array(relations.dimensions).find(dimension => dimension.id === 'group');
    const sources = new Map(array(relations.sources).map(source => [source.id, source]));
    const evidence = new Map();
    for (const row of array(relations.records)) for (const id of array(row.values?.group)) {
      if (!evidence.has(id)) evidence.set(id, { works: [], sources: [{ label: '领域研究 · 关系图组别' }] });
      const item = evidence.get(id);
      item.works.push(work({ ...row, title: row.title || row.label?.zh || row.label?.en }));
      item.sources.push(...array(row.source_ids).map(key => sources.get(key)).filter(Boolean));
    }
    for (const row of array(groups?.categories)) {
      if (row.id === 'other') continue;
      const name = typeof row.label === 'string' ? row.label : row.label?.zh || row.label?.en;
      const item = evidence.get(row.id);
      if (item) add({ kind: 'collaboration', name }, { ...item, status: 'needs_review', context: '关系图组别', legacyKind: 'lead' });
    }
  }
  if (snapshot) {
    const snapshotRef = { label: '领域研究 · 跟踪名单快照' };
    const snapshotWorks = array(snapshot.works);
    const trackedWorks = new Map(snapshotWorks.filter(Boolean).map(row => [row.id, row]));
    for (const person of array(snapshot.people).filter(Boolean)) {
      const organization = affiliation(person.unit);
      const sourceRows = [snapshotRef, ...array(person.urls).map(value => typeof value === 'string' ? { url: value, label: '跟踪来源' } : value)];
      const sampled = [...new Set(array(person.works).map(row => typeof row === 'object' ? row?.id : row))]
        .map(id => typeof id === 'number' ? snapshotWorks[id] : trackedWorks.get(id)).filter(Boolean);
      const works = sampled.map(work);
      add({ kind: 'scholar', name: person.name, aliases: person.aliases, organization, topics: [person.subfield || person.area],
        source_work_count: new Set(works.filter(Boolean)).size }, { sources: sourceRows, works, status: person.identityVerified === true ? 'verified' : 'needs_review' });
      const group = clean(person.group, 160);
      const kind = labName(group) && !collaborationName(group) ? 'group' : 'collaboration';
      add({ kind, name: group, members: [person.name], organization, topics: [person.subfield || person.area] },
        { sources: sourceRows, works: [], status: 'needs_review', legacyKind: 'group' });
    }
  }
  const entries = [...profiles.values()].map(({ citations, references, ...item }) => ({
    ...item, publication_keys: [...citations], source_count: references.size, sources: [...references.values()].slice(0, 32),
    topics: item.topics.slice(0, 24), members: item.members.slice(0, 100),
  }));
  const used = new Set(entries.flatMap(item => item.publication_keys));
  return { entries, publications: [...publications].filter(([key]) => used.has(key)) };
}

export function createResearchDirectory({ store, request, radar }) {
  let cached, inFlight;
  async function load() {
    const manifest = await store.get(manifestKey);
    if (cached?.revision === manifest.revision) return cached;
    if (!manifest.value) return { revision: 0, entries: [], entriesById: new Map(), publications: new Map() };
    const { chunks, counts } = manifest.value;
    const entries = [], publications = new Map();
    for (const key of chunks) {
      const page = (await store.get('research-directory:chunk:' + key)).value;
      if (!page || digest(JSON.stringify(page)) !== key) throw invalid('研究人员目录读取不完整，请重新导入。', 500);
      for (const entry of page.entries || []) entries.push(entry);
      for (const [id, publication] of page.publications || []) publications.set(id, publication);
    }
    cached = { revision: manifest.revision, counts, entries, entriesById: new Map(entries.map(item => [item.id, item])), publications };
    return cached;
  }

  async function importDirectory({ signal } = {}) {
    const original = await store.get(manifestKey), catalog = [], documents = [];
    for (let offset = 0; ; ) {
      signal?.throwIfAborted();
      const page = await request({ action: 'resource_list', kind: 'paper', sort: 'created', order: 'asc', offset, limit: 150 }, signal);
      if (page.total > 10000) throw invalid('文献库超过一次导入的 10000 篇上限。', 413);
      catalog.push(...page.items);
      offset += page.items.length;
      if (offset >= page.total) break;
      if (!page.items.length) throw invalid('文献目录分页未完成，请重试。', 409);
    }
    let snapshot, relations;
    if (radar) {
      for (let offset = 0; offset !== null;) {
        signal?.throwIfAborted();
        const page = await radar.handle({ action: 'field_radar_list', offset, limit: 50 }, { signal });
        for (const { topic } of page.topics) {
          signal?.throwIfAborted();
          const { document } = await radar.get(topic.id);
          if (document) documents.push(document);
        }
        offset = page.next_offset;
      }
      snapshot = (await radar.handle({ action: 'field_radar_snapshot_get' }, { signal })).snapshot;
      relations = (await radar.handle({ action: 'field_radar_relations_get' }, { signal })).document;
    }
    const data = buildDirectory(catalog, documents, snapshot, relations), chunks = [];
    for (const [type, rows] of Object.entries(data)) {
      let part = [], bytes = 0;
      async function save() {
        if (!part.length) return;
        signal?.throwIfAborted();
        const page = { [type]: part }, key = digest(JSON.stringify(page));
        const name = 'research-directory:chunk:' + key;
        if ((await store.get(name)).revision === 0) {
          try { await store.put(name, page, 0); }
          catch (error) {
            if (error.code !== 'STATE_CONFLICT' || digest(JSON.stringify((await store.get(name)).value)) !== key) throw error;
          }
        }
        chunks.push(key);
        part = [];
        bytes = 0;
      }
      for (const row of rows) {
        const size = Buffer.byteLength(JSON.stringify(row)) + 1;
        if (size > 230000) throw invalid('单条研究人员档案超过导入上限。', 413);
        if (bytes + size > 180000) await save();
        part.push(row); bytes += size;
      }
      await save();
    }
    const counts = { papers: catalog.length, topics: documents.length, snapshot_people: array(snapshot?.people).length,
      ...Object.fromEntries(RESEARCH_TYPES.map(type => [type, data.entries.filter(entry => entry.kind === type).length])) };
    if (JSON.stringify(original.value?.chunks) !== JSON.stringify(chunks) || JSON.stringify(original.value?.counts) !== JSON.stringify(counts)) {
      signal?.throwIfAborted();
      await store.put(manifestKey, { chunks, counts }, original.revision);
    }
    return { counts };
  }

  return { load, refresh(options) {
    if (!inFlight) inFlight = importDirectory(options).finally(() => { inFlight = null; });
    return inFlight;
  } };
}
