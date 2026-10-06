import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { prepareReadingPack } from '../scripts/prepare-paper-reading-pack.mjs'
import { dispatch } from '../src/bridge.mjs'

const run = promisify(execFile)
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'reading-pack-test-'))
  const library = join(root, 'library')
  await mkdir(library)
  t.after(() => rm(root, { recursive: true, force: true }))
  const python = resolve('.venv/bin/python')
  const { stdout } = await run('uv', ['run', '--offline', '--no-project', '--python', python, 'python', '-B', '-c', `
import json, sys
from pathlib import Path
import pymupdf as fitz
from dsh_paper_library.core import Library
root = Path(sys.argv[1])
original = root / 'synthetic.pdf'
with fitz.open() as doc:
    for number in range(1, 3):
        page = doc.new_page(width=500, height=700)
        page.insert_text((40, 60), f'Synthetic reading-pack page {number}.')
        page.insert_text((40, 95), 'A second fixture sentence for Markdown output.')
    doc.save(original)
library = Library(root / 'library')
try:
    item = library.create({'title': 'Synthetic reading pack fixture'})
    item = library.attach(item['id'], str(original))
    print(json.dumps({'id': item['id'], 'original': str(original), 'managed': str(library.pdf_path(item['id']))}))
finally:
    library.close()
`, root], { env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONPATH: resolve('src') }, maxBuffer: 1024 * 1024 })
  const paper = JSON.parse(stdout)
  const before = await Promise.all([paper.original, paper.managed].map(path => readFile(path).then(sha256)))
  const workerCalls = []
  const worker = async (request, options) => {
    workerCalls.push(structuredClone(request))
    return dispatch(request, options)
  }
  return { root, library, python, paper, before, workerCalls, worker }
}

test('real local worker exports cached raw text, Markdown and optional separate page PNGs with verified hashes', { timeout: 60000 }, async t => {
  const f = await fixture(t)
  const out = join(f.root, 'private-pack')
  const { manifest } = await prepareReadingPack({ id: f.paper.id, pages: [1, 2], library: f.library, out, python: f.python, images: true }, { worker: f.worker })
  assert.equal(manifest.status, 'complete')
  assert.equal(manifest.model_calls, 0)
  assert.equal(manifest.network_requests, 0)
  assert.equal(manifest.original_pdf_modified, false)
  assert.deepEqual(manifest.pages.map(page => page.page).sort(), [1, 2])
  assert.ok(manifest.files.some(file => file.path === 'source.md'))
  for (const page of [1, 2]) {
    const row = manifest.pages.find(item => item.page === page)
    const raw = await readFile(join(out, row.raw_file))
    const markdown = await readFile(join(out, row.markdown_file))
    assert.equal(sha256(raw), row.raw_text_sha256)
    assert.equal(sha256(markdown), row.markdown_sha256)
    assert.match(raw.toString(), /Synthetic reading-pack page/)
    assert.match(markdown.toString(), /Synthetic reading-pack page/)
    const image = manifest.files.find(file => file.path === `page-${page}.png`)
    const png = await readFile(join(out, image.path))
    assert.equal(sha256(png), image.sha256)
    assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
    assert.ok(image.bytes <= 1024 * 1024)
    assert.ok(Math.max(image.width, image.height) <= 1600)
  }
  const source = await readFile(join(out, 'source.md'))
  const savedManifest = JSON.parse(await readFile(join(out, 'manifest.json'), 'utf8'))
  assert.equal(sha256(source), savedManifest.files.find(file => file.path === 'source.md').sha256)
  assert.match(source.toString(), /PDF page 1/)
  assert.match(source.toString(), /PDF page 2/)
  assert.equal(f.workerCalls.every(call => call.action === 'paper_analysis_batch' && call.input_format === 'markdown' && call.include_images === true), true)
  assert.deepEqual(await Promise.all([f.paper.original, f.paper.managed].map(path => readFile(path).then(sha256))), f.before)
})

test('image rendering is opt-in and existing output paths are never overwritten', { timeout: 60000 }, async t => {
  const f = await fixture(t)
  const out = join(f.root, 'markdown-only')
  const { manifest } = await prepareReadingPack({ id: f.paper.id, pages: [1], library: f.library, out, python: f.python }, { worker: f.worker })
  assert.equal(manifest.include_images, false)
  assert.equal(manifest.files.some(file => file.path.endsWith('.png')), false)
  assert.equal(f.workerCalls[0].include_images, false)
  await assert.rejects(prepareReadingPack({ id: f.paper.id, pages: [1], library: f.library, out, python: f.python }, { worker: f.worker }))
  assert.equal(f.workerCalls.length, 1, 'existing output must fail before another PDF read')
})

test('rejects output inside the library or a Git worktree before worker access', async t => {
  const f = await fixture(t)
  await assert.rejects(prepareReadingPack({ id: f.paper.id, pages: [1], library: f.library, out: join(f.library, 'library-report'), python: f.python }, { worker: f.worker }), { code: 'READING_PACK_OUTPUT_IN_LIBRARY' })
  const repository = join(f.root, 'synthetic-repository')
  await mkdir(repository)
  await writeFile(join(repository, '.git'), 'synthetic worktree marker')
  await assert.rejects(prepareReadingPack({ id: f.paper.id, pages: [1], library: f.library, out: join(repository, 'private-output'), python: f.python }, { worker: f.worker }), { code: 'READING_PACK_OUTPUT_IN_GIT' })
  assert.equal(f.workerCalls.length, 0)
})

test('rejects invalid page selections before creating output or reading the PDF', async t => {
  const f = await fixture(t)
  for (const pages of [[], [0], [1, 1], [1.5], [2001], [1, 2, 3, 4, 5, 6, 7, 8, 9]]) {
    const out = join(f.root, `invalid-${pages.length}-${String(pages[0])}`)
    await assert.rejects(prepareReadingPack({ id: f.paper.id, pages, library: f.library, out, python: f.python }, { worker: f.worker }), { code: 'READING_PACK_INPUT_INVALID' })
  }
  assert.equal(f.workerCalls.length, 0)
  assert.deepEqual((await readdir(f.root)).filter(name => name.startsWith('invalid-')), [])
})
