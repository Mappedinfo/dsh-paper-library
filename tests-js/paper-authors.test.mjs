import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { dispatch } from '../src/bridge.mjs'

const orcid = '0000-0002-1825-0097'
const otherOrcid = '0000-0002-1694-233X'
const doi = '10.1234/author-evidence'
const author = { given: 'Alice', family: 'Reader', affiliation: ['Synthetic University'] }
const response = (value, statusCode = 200) => ({
  statusCode,
  headers: {},
  body: Readable.from([JSON.stringify(value)]),
  close() { this.body.destroy() },
})

test('author lookup keeps similarly named library records distinct and queries only public identifiers', async t => {
  const library = await mkdtemp(join(tmpdir(), 'paper-authors-'))
  t.after(() => rm(library, { recursive: true, force: true }))
  const create = (title, person, extra = {}) => dispatch(
    { action: 'create', metadata: { title, author: [person], ...extra } }, { library },
  )
  const anchor = await create('Synthetic author evidence', author, { DOI: doi })
  const same = await create('Matched work', { ...author, ORCID: orcid })
  const conflict = await create('Different researcher', { ...author, ORCID: otherOrcid })
  const nameOnly = await create('Legacy literal list', { literal: 'Bob Sample；Alice Reader' })
  const archived = await create('Archived work', { ...author, ORCID: orcid })
  await dispatch({ action: 'archive', id: archived.id }, { library })
  const requests = []
  let publicTitle = anchor.title
  const fetchOptions = {
    resolver: async () => [{ address: '93.184.215.14', family: 4 }],
    transport: async ({ url }) => {
      requests.push(url.href)
      if (url.hostname === 'api.crossref.org') return response({ message: {
        DOI: doi, title: [publicTitle], type: 'journal-article', author: [{ ...author, ORCID: `https://orcid.org/${orcid}` }],
      } })
      if (url.hostname === 'pub.orcid.org') return response({ 'affiliation-group': [{ summaries: [{
        'employment-summary': {
          organization: { name: 'Synthetic University' }, 'department-name': 'Geography', 'role-title': 'Researcher',
          'start-date': { year: { value: '2019' } }, 'end-date': { year: { value: '2023' } },
          source: { 'source-name': { value: 'Synthetic University' } },
        },
      }] }] })
      return response({}, 404)
    },
  }
  const lookup = input => dispatch({ action: 'paper_authors_lookup', id: anchor.id, ...input }, { library, fetchOptions })
  const result = await lookup({ names: ['Reader Alice', 'Unlisted Person'], public_lookup: true })
  assert.equal(result.public_source.status, 'matched_paper')
  const [alice, unlisted] = result.people
  assert.equal(alice.identity, 'paper_author')
  assert.equal(alice.orcid, orcid)
  assert.deepEqual(alice.public_paper_authorship[0].affiliations, ['Synthetic University'])
  assert.deepEqual(alice.orcid_employment.records, [{
    organization: 'Synthetic University', department: 'Geography', role: 'Researcher',
    start_date: '2019', end_date: '2023', asserted_by: 'Synthetic University',
  }])
  assert.deepEqual(Object.fromEntries(alice.local_matches.map(v => [v.id, v.match])), {
    [same.id]: 'same_orcid', [conflict.id]: 'conflicting_orcid', [nameOnly.id]: 'name_only',
  })
  assert.equal(alice.local_matches.find(v => v.id === nameOnly.id).author.name, 'Alice Reader')
  assert.equal(unlisted.identity, 'not_listed_on_paper')
  assert.deepEqual(requests, [
    `https://api.crossref.org/works/${encodeURIComponent(doi)}`,
    `https://doi.org/${doi}`,
    `https://pub.orcid.org/v3.0/${orcid}/employments`,
  ])
  requests.length = 0
  const local = await lookup()
  assert.equal(local.public_source.status, 'not_requested')
  assert.deepEqual(requests, [])
  publicTitle = 'Unrelated public record'
  const mismatched = await lookup({ public_lookup: true })
  assert.equal(mismatched.public_source.status, 'title_mismatch')
  assert.equal(mismatched.people[0].orcid, null)
  assert.equal(requests.some(url => url.includes('orcid.org')), false)
})
