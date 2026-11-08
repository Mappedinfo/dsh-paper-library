import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFetchHandler } from '../src/http.mjs'
import { catalogResources } from '../src/catalog-resources.mjs'

test('catalog organization client is served through the static allowlist', async () => {
  const handler = createFetchHandler()
  const response = await handler(new Request('http://localhost/paper-organization.js'))
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type'), /javascript/)
  assert.match(await response.text(), /window\.PaperOrganization/)
})

test('scopes that exclude slides never read their metadata', async () => {
  let scanned = false
  const resourceList = async input => ({ items: [], total: 0, offset: input.offset, limit: input.limit, counts: {} })
  const slidesList = async () => { scanned = true; throw new Error('synthetic broken slide metadata') }
  for (const input of [{ kind: 'paper' }, { kind: 'dataset' }, { kind: 'all', archived: true }, { kind: 'all', project: 'p-synthetic' }, { kind: 'slides', archived: true }, { kind: 'slides', project: 'p-synthetic' }, {kind:'all',favorite:true}, {kind:'all',tag:'#method'}, {kind:'slides',favorite:true}, {kind:'slides',tag:'#method'}]) {
    const result = await catalogResources(input, { resourceList, slidesList })
    assert.equal(result.total, 0)
    assert.equal(scanned, false)
    assert.equal(result.counts.slides, undefined, 'unread counts are not reported as zero')
  }
  await assert.rejects(catalogResources({ kind: 'all' }, { resourceList, slidesList }), error => {
    assert.match(error.message, /synthetic broken slide metadata/)
    assert.match(error.message, /切换“文献”或“数据集”/)
    return true
  })
})

test('mixed timestamp ordering preserves Python microseconds against JS milliseconds', async () => {
  const paper = { id: 'paper', title: 'Paper', resource_kind: 'paper', modified: '2026-10-29T00:00:00.123999+00:00' }
  const slidesList = async () => ({ projects: [{ id: 'pd-' + 'a'.repeat(32), title: 'Talk', slide_count: 1, updated_at: '2026-10-29T00:00:00.123Z' }] })
  const resourceList = async ({ offset, limit }) => ({ items: [paper].slice(offset, offset + limit), total: 1, active_count: 1, counts: {} })
  const result = await catalogResources({ kind: 'all', sort: 'modified', order: 'desc' }, { resourceList, slidesList })
  assert.deepEqual(result.items.map(item => item.resource_kind), ['paper', 'slides'])
})

test('catalog merges synthetic papers, datasets and presentations before sorting and paging', async t => {
  const root = await mkdtemp(join(tmpdir(), 'paper-catalog-slides-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const options = { library: join(root, 'library'), localStateHome: join(root, 'state') }
  const handler = createFetchHandler(options)
  const call = async (input, target = handler) => {
    const response = await target(new Request('http://localhost/api', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }))
    const body = await response.json()
    assert.equal(body.ok, true, `${input.action}: ${JSON.stringify(body)}`)
    return body.result
  }
  await call({ action: 'import', items: [{ id: 'synthetic-paper', title: 'B paper', type: 'article-journal' }] })
  await call({ action: 'dataset_put', metadata: { title: 'D dataset' }, expected_revision: 0 })
  const a = (await call({ action: 'slides_create', title: 'A talk', template: 'blank' })).project
  await call({ action: 'slides_create', title: 'C talk', template: 'blank' })
  for (const [order, expected] of [['asc', ['A talk', 'B paper', 'C talk', 'D dataset']], ['desc', ['D dataset', 'C talk', 'B paper', 'A talk']]]) {
    const titles = []
    for (let offset = 0; offset < 4; offset++) {
      const page = await call({ action: 'catalog_resource_list', kind: 'all', sort: 'title', order, offset, limit: 1 })
      assert.equal(page.total, 4); assert.equal(page.active_count, 4)
      titles.push(page.items[0].title)
    }
    assert.deepEqual(titles, expected)
  }
  const found = await call({ action: 'catalog_resource_list', kind: 'slides', query: 'A talk' })
  assert.deepEqual(found.items.map(item => item.id), [a.id])
  assert.equal((await call({ action: 'resource_list', kind: 'all' })).total, 2)
  const paper = (await call({action:'resource_list',kind:'paper'})).items[0]
  const organized = await call({action:'paper_organization_update',id:paper.id,favorite:true,tags:['#method/deep/model'],expected_organization_modified:null})
  assert.deepEqual(organized.manual_tags, ['#method/deep/model'])
  assert.equal((await call({action:'get',id:paper.id})).favorite,true)
  for(const filter of [{favorite:true}, {tag:'#method'}, {tag:'#method/deep',favorite:true}]) {
    const result = await call({action:'catalog_resource_list',kind:'all',...filter})
    assert.equal(result.total,1)
    assert.equal(result.items[0].id,paper.id)
    assert.equal((await call({action:'catalog_resource_list',kind:'slides',...filter})).total,0)
  }
  assert.deepEqual((await call({action:'paper_tags_list',query:'method'})).items.map(value=>value.tag),['#method','#method/deep','#method/deep/model'])
  assert.equal((await call({ action: 'catalog_resource_list', kind: 'slides', archived: true })).total, 0)
  const project = (await call({ action: 'project_create', title: 'Synthetic reading project' })).project
  assert.equal((await call({ action: 'catalog_resource_list', kind: 'slides', project: project.id })).total, 0)
  assert.equal((await call({ action: 'catalog_resource_list', kind: 'all', project: project.id })).total, 0)
  const noPython = createFetchHandler({ ...options, python: '/nonexistent/python' })
  assert.equal((await call({ action: 'catalog_resource_list', kind: 'slides' }, noPython)).total, 2)
})
