import { arxivID, normalizeDOI, publicORCID, readAuthorEmployments, resolveMetadata } from '../paper-fetch.mjs'

const text = (value, max = 160) => typeof value === 'string' ? value.trim().slice(0, max) : ''
const key = value => text(value, 1000).normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
const orcidOf = person => publicORCID(person.ORCID || person.orcid)
const namesOf = person => [person.literal, [person.given, person.family].filter(Boolean).join(' '),
  [person.family, person.given].filter(Boolean).join(' ')].map(value => text(value)).filter(Boolean)
const authorOf = person => ({
  name: namesOf(person)[0] || '',
  orcid: orcidOf(person),
  affiliations: (Array.isArray(person.affiliation) ? person.affiliation : [person.affiliation])
    .slice(0, 6).map(value => text(typeof value === 'string' ? value : value?.name, 260)).filter(Boolean),
})
const roster = item => Array.isArray(item?.author) ? item.author.filter(author => author && typeof author === 'object').flatMap(author => {
  const literal = typeof author.literal === 'string' ? author.literal.split(/[;；]/u).map(name => name.trim()).filter(Boolean) : []
  return literal.length > 1 ? literal.map(name => ({ literal: name })) : [author]
}) : []
const yearOf = item => Number.isInteger(item?.issued?.['date-parts']?.[0]?.[0]) ? item.issued['date-parts'][0][0] : null
const doiURL = doi => `https://doi.org/${doi.split('/').map(encodeURIComponent).join('/')}`
const profilesLimit = 4

function authorCandidates(persons, name) {
  const wanted = key(name)
  return persons.filter(person => namesOf(person).some(value => key(value) === wanted))
}

async function publicPaper(item, options) {
  let doi
  try { doi = normalizeDOI(item.DOI) } catch { /* No public DOI on this item. */ }
  const arxiv = arxivID(item.URL) || (/^arxiv$/i.test(item.archive || '') && arxivID(item.archive_location))
  const id = doi || arxiv
  if (!id) return { status: 'no_public_identifier' }
  const url = doi ? doiURL(doi) : `https://arxiv.org/abs/${arxiv}`
  const result = await resolveMetadata(id, { ...options, timeoutMs: 8500 })
  options.signal?.throwIfAborted()
  if (!result.metadata) return { status: 'unavailable', url }
  if (!key(item.title) || key(result.metadata.title) !== key(item.title)) return { status: 'title_mismatch', url }
  return { status: 'matched_paper', url, year: yearOf(result.metadata), metadata: result.metadata }
}

function localCandidate(record, person, validOrcid) {
  const author = authorOf(record.author)
  const sameOrcid = validOrcid && author.orcid === validOrcid
  const conflict = validOrcid && author.orcid && !sameOrcid
  const shared = person.affiliations.some(name => author.affiliations.some(value => key(value) === key(name)))
  const match = sameOrcid ? 'same_orcid' : conflict ? 'conflicting_orcid' : shared ? 'name_and_affiliation' : 'name_only'
  return { id: record.id, citekey: record.citekey, title: record.title, doi: record.doi,
    year: Number.isInteger(record.year) ? record.year : null, author, match }
}

export async function lookupPaperAuthors(input, { request, fetchOptions, signal } = {}) {
  if (typeof input.id !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(input.id)) throw new Error('请选择有效的文献。')
  if (input.public_lookup !== undefined && typeof input.public_lookup !== 'boolean') throw new Error('公开资料核对选项无效。')
  if (input.names !== undefined && (!Array.isArray(input.names) || input.names.length < 1 || input.names.length > 8 ||
    input.names.some(name => typeof name !== 'string' || name.length > 160 || !key(name)))) throw new Error('请输入 1–8 个完整人名，每个不超过 160 字符。')

  const item = await request({ action: 'get', id: input.id }, signal)
  const current = roster(item), options = { ...fetchOptions, signal }
  const checked = input.public_lookup ? await publicPaper(item, options) : { status: 'not_requested' }
  const { metadata: publication, ...public_source } = checked
  const registered = roster(publication)
  const proposed = input.names ?? (current.length ? current : registered).map(author => namesOf(author)[0]).filter(Boolean)
  const names = [...new Map(proposed.map(name => [key(name), name.trim()])).values()].slice(0, 8)
  const evidenceByName = names.map(name => ({
    name, anchored: authorCandidates(current, name), published: authorCandidates(registered, name),
  }))
  const localNames = evidenceByName.map(({ name, anchored, published }) => {
    const supplied = published.length === 1 ? published[0] : anchored.length === 1 ? anchored[0] : null
    return supplied ? namesOf(supplied)[0] : name
  })
  const local = names.length ? await request({ action: 'author_paper_candidates', id: item.id, names: localNames }, signal) : { groups: [] }
  const profiles = new Map()
  const people = local.groups.map((group, index) => {
    const { name, anchored, published } = evidenceByName[index]
    const ambiguous = anchored.length > 1 || published.length > 1
    const primary = anchored.length === 1 ? authorOf(anchored[0]) : null
    const evidence = published.length === 1 ? authorOf(published[0]) : null
    const conflict = primary?.orcid && evidence?.orcid && primary.orcid !== evidence.orcid
    const orcid = ambiguous || conflict ? null : evidence?.orcid || primary?.orcid || null
    const profileStatus = input.public_lookup && orcid ? 'not_checked_limit' : input.public_lookup ? 'no_confirmed_orcid' : 'not_requested'
    if (input.public_lookup && orcid && !profiles.has(orcid) && profiles.size < profilesLimit) {
      profiles.set(orcid, readAuthorEmployments(orcid, options))
    }
    const person = { affiliations: [...(primary?.affiliations || []), ...(evidence?.affiliations || [])] }
    return { name, identity: ambiguous || conflict ? 'ambiguous' : primary || evidence ? 'paper_author' : 'not_listed_on_paper',
      local_paper_authorship: anchored.map(authorOf).slice(0, 4),
      public_paper_authorship: published.map(authorOf).slice(0, 4),
      local_matches: group.items.map(record => localCandidate(record, person, orcid)),
      local_matches_truncated: group.truncated, orcid, profile_status: profileStatus }
  })
  await Promise.all(people.map(async person => {
    const read = profiles.get(person.orcid)
    if (!read) return
    person.orcid_employment = await read
    person.profile_status = person.orcid_employment.status
  }))
  return { paper: { id: item.id, title: text(item.title, 350), year: yearOf(item), citekey: item.citekey, has_pdf: Boolean(item.pdf) },
    public_source, people, author_list_truncated: !input.names && proposed.length > 8,
    evidence_scope: 'Paper affiliations are publication-time statements. A name or name and affiliation is a local candidate, not a verified identity. ORCID shows reported employment, not necessarily current or a research group. Check an official lab or institutional profile for current membership.' }
}
