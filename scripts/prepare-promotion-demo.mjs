/** Prepare a synthetic, offline library for public screenshots.
 * Run: node scripts/prepare-promotion-demo.mjs
 * Only .local/promotion is used; no host, model, or existing library is opened.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dispatch } from '../src/bridge.mjs'

const project = dirname(dirname(fileURLToPath(import.meta.url)))
const root = join(project, '.local/promotion')
const source = join(root, 'source')
const library = join(root, 'library')
const marker = join(root, 'synthetic-demo.json')
const python = join(project, '.venv/bin/python')
const options = { library, python }
const identity = { kind: 'paper-library-public-synthetic-demo', version: 1 }
const quote = "A useful reading note connects the author's claim to its supporting evidence."
const comment = '演示批注：这段合成文字用于展示高亮与评论如何保存在 PDF 内，不构成真实论文的研究结论。'
const relationNote = '演示关系：这两份合成文档共享 evidence 标签；此处手动连接仅用于展示关系与依据记录，不代表真实引文或学术支持。'
const expectedKeys = ['DemoWang2026', 'DemoChen2026', 'DemoSmith2026']

async function directory(path) {
  await mkdir(path, { recursive: true })
  const info = await lstat(path)
  assert.ok(info.isDirectory() && !info.isSymbolicLink(), 'Demo directories must be ordinary local directories')
}

async function exists(path) {
  try { await lstat(path); return true }
  catch (error) { if (error.code === 'ENOENT') return false; throw error }
}

function selection(words, text) {
  const tokens = text.split(/\s+/)
  const start = words.findIndex((word, index) => tokens.every((token, offset) => words[index + offset]?.[4] === token))
  assert.ok(start >= 0, 'The synthetic passage must exist in the generated PDF')
  const lines = new Map()
  for (const word of words.slice(start, start + tokens.length)) {
    const key = `${word[5]}:${word[6]}`
    const prior = lines.get(key)
    lines.set(key, prior ? [Math.min(prior[0], word[0]), Math.min(prior[1], word[1]), Math.max(prior[2], word[2]), Math.max(prior[3], word[3])] : word.slice(0, 4))
  }
  return [...lines.values()]
}

async function prepare() {
  assert.equal(process.argv.length, 2, 'This script takes no arguments and always uses its isolated synthetic directory')
  await directory(join(project, '.local'))
  await directory(root)
  if (await exists(marker)) {
    assert.deepEqual(JSON.parse(await readFile(marker, 'utf8')), identity, 'Unrecognized demo ownership marker')
  } else {
    assert.deepEqual(await readdir(root), [], 'Refusing to use a nonempty directory without a synthetic-demo marker')
    await writeFile(marker, `${JSON.stringify(identity, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  }
  await directory(source)
  await directory(library)
  const exported = join(source, 'zotero-export.json')
  if (!await exists(exported)) {
    const generated = spawnSync(python, [join(project, 'scripts/create-demo.py'), '--output', source], {
      cwd: project, encoding: 'utf8', timeout: 30000,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    })
    assert.ok(!generated.error && generated.status === 0, 'Synthetic PDF generation failed; ensure uv sync has completed')
  }
  const fixture = JSON.parse(await readFile(exported, 'utf8'))
  assert.deepEqual(fixture.items.map(item => item.citationKey), expectedKeys, 'Unexpected synthetic export contents')
  for (const [index, item] of fixture.items.entries()) {
    assert.equal(item.publicationTitle, 'Synthetic Reading Examples')
    assert.equal(item.attachments.length, 1)
    assert.equal(item.attachments[0].path, join(source, `example-${index + 1}.pdf`))
    assert.ok((await lstat(item.attachments[0].path)).isFile(), 'Synthetic PDF must be a regular file')
  }

  // Metadata import copies fixture attachments through the normal local core path;
  // it cannot enter DOI resolution, online enrichment, or model generation.
  const before = await dispatch({ action: 'list', limit: 10 }, options)
  assert.ok(before.total <= 3 && before.items.every(item => expectedKeys.includes(item.citekey)), 'The isolated library contains unexpected records')
  const records = fixture.items.map(item => ({
    ...item,
    // These newly generated fixtures have no database-only Zotero annotations.
    // Completed attachments are left alone when this script is run again.
    attachments: before.items.some(existing => existing.citekey === item.citationKey && existing.pdf)
      ? [] : item.attachments.map(attachment => ({ ...attachment, annotations: [] })),
  }))
  const imported = await dispatch({ action: 'import', items: records }, options)
  assert.equal(imported.warnings.length, 0, `Synthetic import warnings: ${JSON.stringify(imported.warnings)}`)
  const listing = await dispatch({ action: 'list', limit: 10 }, options)
  assert.equal(listing.total, 3)
  assert.ok(listing.items.every(item => item.pdf && expectedKeys.includes(item.citekey)))
  const first = listing.items.find(item => item.citekey === expectedKeys[0])
  const second = listing.items.find(item => item.citekey === expectedKeys[1])
  let annotations = (await dispatch({ action: 'annotations', id: first.id }, options)).annotations
  if (!annotations.some(annotation => annotation.comment === comment && annotation.author === 'Paper Library demo')) {
    const page = await dispatch({ action: 'page', id: first.id, page: 1, scale: 0.8 }, options)
    await dispatch({ action: 'annotate', id: first.id, page: 1, type: 'highlight', rects: selection(page.words, quote), text: quote, comment, author: 'Paper Library demo', color: '#ffdb66' }, options)
  }
  const priorGraph = await dispatch({ action: 'graph', limit: 10 }, options)
  if (!priorGraph.edges.some(edge => edge.source === first.id && edge.target === second.id && edge.relation === 'related' && edge.note === relationNote)) {
    await dispatch({ action: 'link', source: first.id, target: second.id, relation: 'related', note: relationNote }, options)
  }
  annotations = (await dispatch({ action: 'annotations', id: first.id }, options)).annotations
  const graph = await dispatch({ action: 'graph', limit: 10 }, options)
  const demoAnnotations = annotations.filter(annotation => annotation.comment === comment && annotation.author === 'Paper Library demo')
  const demoRelations = graph.edges.filter(edge => edge.source === first.id && edge.target === second.id && edge.relation === 'related' && edge.note === relationNote)
  assert.equal(demoAnnotations.length, 1, 'Repeated runs must retain exactly one demonstration highlight')
  assert.equal(demoAnnotations[0].text, quote)
  assert.equal(demoRelations.length, 1, 'Repeated runs must retain exactly one demonstration relation')
  const receipt = {
    synthetic: true,
    library: relative(project, library),
    source: relative(project, source),
    records: listing.total,
    pdfs: listing.items.filter(item => item.pdf).length,
    demonstration_highlights: demoAnnotations.length,
    demonstration_relations: demoRelations.length,
    initial_paper_id: first.id,
    network_requests: 0,
    model_requests: 0,
  }
  await writeFile(join(root, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 })
  console.log(JSON.stringify(receipt, null, 2))
}

await prepare()
