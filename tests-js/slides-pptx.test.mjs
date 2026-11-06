import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import JSZip from 'jszip'
import sharp from 'sharp'
import { createFetchHandler } from '../src/http.mjs'
import { registerLibraryTools } from '../src/harness/tools.mjs'

test('PlainDeck exports editable PowerPoint through HTTP, CLI and the registered DSH tool', async t => {
  const root = await mkdtemp(join(tmpdir(), 'paper-slides-pptx-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const library = join(root, 'library')
  const handler = createFetchHandler({ library, localStateHome: join(root, 'state'), basePath: '/api/paper-library' })
  const post = input => handler(new Request('http://localhost/api/paper-library/api', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input),
  }))
  const json = async input => {
    const response = await post(input)
    const body = await response.json()
    assert.equal(response.status, 200, body.error)
    return body.result
  }
  const { project: { id }, document, revision } = await json({ action: 'slides_create', title: '合成汇报', template: 'blank' })
  const content_base64 = (await sharp({ create: { width: 30, height: 10, channels: 3, background: '#6E92B8' } }).webp().toBuffer()).toString('base64')
  const asset = await json({ action: 'slides_asset_put', id, mime: 'image/webp', content_base64 })
  const savedPath = document.deck.slides[0]
  const secondPath = './slides/002.json'
  document.deck.slides.push(secondPath)
  document.deck.footer = { left: { type: 'none' }, center: { type: 'page-of-count' }, right: { type: 'none' } }
  document.slides[savedPath].elements = [
    { type: 'text', id: 'title', text: '可编辑文字 & evidence', styleRef: 'slide-title', frame: { x: 70, y: 60, w: 1000, h: 100 }, zIndex: 2, animation: { enter: 'fade' } },
    { type: 'shape', id: 'card', text: '原生卡片', shape: 'rounded-rectangle', radius: 32, fill: 'rgb(221 235 248)', frame: { x: 70, y: 160, w: 320, h: 100 }, zIndex: 1 },
    { type: 'line', id: 'connector', arrowEnd: true, dash: true, frame: { x: 390, y: 170, w: 120, h: 20 } },
    { type: 'image', id: 'asset', src: asset.path, alt: '图像替代文字', fit: 'cover', frame: { x: 700, y: 180, w: 300, h: 300 } },
    { type: 'table', id: 'native-table', cells: [['方法', '结果'], ['A', '73%']], headerRows: 1, style: 'grid', frame: { x: 70, y: 350, w: 530, h: 180 } },
  ]
  document.slides[secondPath] = { id: 's2', name: 'Second', elements: [{ type: 'text', id: 'second', text: 'Second page', frame: { x: 70, y: 60, w: 800, h: 100 } }] }
  const saved = await json({ action: 'slides_save', id, document, expected_revision: revision })

  const tools = new Map()
  const ctx = { tools: { register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name) } } }
  t.after(registerLibraryTools(ctx, tool => tool, () => assert.fail('PPTX must not use the Python worker'), { library }, {}))
  const exec = { signal: new AbortController().signal }
  const projects = await tools.get('library_slides_list').execute({}, exec)
  assert.equal(projects.projects[0].id, id)
  const tool = tools.get('library_slides_export_pptx')
  const result = await tool.execute({ id, expected_revision: saved.revision }, exec)
  assert.equal(result.path, join(await realpath(library), 'slides', id, 'exports', 'presentation.pptx'))
  assert.equal(result.slide_count, 2)
  assert.deepEqual(result.warnings, ['static_motion'])
  const bytes = await readFile(result.path)
  assert.equal(result.size, bytes.length)
  const zip = await JSZip.loadAsync(bytes)
  const first = await zip.file('ppt/slides/slide1.xml').async('string')
  assert.match(first, /可编辑文字 &amp; evidence/)
  assert.match(first, /<a:ea typeface="PingFang SC"/)
  const shapeIds = Array.from(first.matchAll(/<p:cNvPr id="(\d+)"/g), match => match[1])
  assert.equal(new Set(shapeIds).size, shapeIds.length)
  assert.match(first, /<a:prstGeom prst="roundRect">/)
  assert.match(first, /<a:tailEnd type="triangle"/)
  assert.match(first, /<a:tbl>.*<a:t>73%<\/a:t>/s)
  assert.match(first, /<p:pic>.*<a:srcRect l="33333" r="33333"/s)
  assert.ok(first.indexOf('name="card"') < first.indexOf('name="title"'))
  assert.match(await zip.file('ppt/slides/slide2.xml').async('string'), /Second page/)
  assert.equal(Object.keys(zip.files).filter(path => /^ppt\/media\/[^/]+\.png$/.test(path)).length, 1)
  await assert.rejects(tool.execute({ id, expected_revision: revision }, exec), { code: 'STATE_CONFLICT' })
  assert.deepEqual(await readFile(result.path), bytes)

  const cli = spawnSync(process.execPath, [fileURLToPath(new URL('../src/cli.mjs', import.meta.url)), '--library', library], {
    input: JSON.stringify({ action: 'slides_export_pptx', id, expected_revision: saved.revision }), encoding: 'utf8', timeout: 5000,
  })
  assert.equal(cli.status, 0, cli.stdout || cli.stderr)
  const cliResult = JSON.parse(cli.stdout).result
  assert.equal(cliResult.path, result.path)
  assert.equal(cliResult.revision, saved.revision)
  const persisted = await readFile(cliResult.path)

  document.deck.title = '未保存草稿'
  document.slides[savedPath].elements[0].text = 'Draft only'
  const download = await post({ action: 'slides_export_pptx', id, document })
  assert.equal(download.status, 200)
  assert.equal(download.headers.get('Content-Type'), 'application/vnd.openxmlformats-officedocument.presentationml.presentation')
  assert.match(download.headers.get('Content-Disposition'), new RegExp(encodeURIComponent('未保存草稿.pptx')))
  assert.equal(download.headers.get('X-PlainDeck-Export-Warnings'), 'static_motion')
  const draftZip = await JSZip.loadAsync(await download.arrayBuffer())
  assert.match(await draftZip.file('ppt/slides/slide1.xml').async('string'), /Draft only/)
  assert.equal((await json({ action: 'slides_get', id })).revision, saved.revision)

  document.slides[savedPath].elements.find(element => element.type === 'image').src = 'https://invalid.example/a.png'
  const blocked = await post({ action: 'slides_export_pptx', id, document })
  assert.equal(blocked.status, 400)
  assert.deepEqual(await readFile(result.path), persisted)
})
