#!/usr/bin/env node
// 只预处理显式选定的本地页；不调用模型，不访问网络，不修改 PDF。
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, realpath, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { dispatch } from '../src/bridge.mjs'
import { validateAnalysisImages } from '../src/model-input-images.mjs'

const hash = data => createHash('sha256').update(data).digest('hex')
const fail = code => Object.assign(new Error(code), { code })
const within = (root, path) => { const part = relative(root, path); return !part || part !== '..' && !part.startsWith('../') && !isAbsolute(part) }

async function outputDirectory(path, library) {
  if (typeof path !== 'string' || !isAbsolute(path)) throw fail('READING_PACK_OUTPUT_INVALID')
  const target = resolve(path), parent = await realpath(dirname(target)), out = join(parent, relative(dirname(target), target))
  if (within(library, out)) throw fail('READING_PACK_OUTPUT_IN_LIBRARY')
  for (let cursor = parent;; cursor = dirname(cursor)) {
    try { await lstat(join(cursor, '.git')); throw fail('READING_PACK_OUTPUT_IN_GIT') }
    catch (error) { if (error.code !== 'ENOENT') throw error }
    if (cursor === dirname(cursor)) break
  }
  await mkdir(out, { mode: 0o700 }) // 必须是新目录；失败时保留已产出的可检查文件。
  return out
}

async function cachedText(library, reference, expected) {
  if (typeof reference !== 'string' || !/^derived\/pdf-analysis\/[a-f0-9]{64}\/(raw\.txt|page\.md)$/.test(reference)) throw fail('READING_PACK_CACHE_INVALID')
  const path = join(library, reference)
  if (await realpath(path) !== path) throw fail('READING_PACK_CACHE_INVALID')
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size > 16 * 1024 * 1024) throw fail('READING_PACK_CACHE_INVALID')
    const data = await handle.readFile()
    if (data.length !== info.size || hash(data) !== expected) throw fail('READING_PACK_CACHE_CHANGED')
    return data
  } finally { await handle.close() }
}

export async function prepareReadingPack(options, { worker = dispatch } = {}) {
  const { id, pages, images = false, python } = options
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(id || '') || !Array.isArray(pages) || !pages.length || pages.length > 8 ||
      new Set(pages).size !== pages.length || pages.some(page => !Number.isInteger(page) || page < 1 || page > 2000) ||
      typeof images !== 'boolean' || typeof options.library !== 'string' || !isAbsolute(options.library)) throw fail('READING_PACK_INPUT_INVALID')
  const library = await realpath(options.library), out = await outputDirectory(options.out, library)
  const save = (name, data) => writeFile(join(out, name), data, { mode: 0o600, flag: 'wx' })
  const manifest = { schema: 1, status: 'preparing', id, requested_pages: pages, include_images: images,
    created_at: new Date().toISOString(), original_pdf_modified: false, network_requests: 0, model_calls: 0,
    representation: 'normalized-markdown', raw_pdf_verbatim: false, ocr: false, annotations_included: false,
    pages: [], batches: [], files: [] }
  let cursor, version, chunks = [], sourceBytes = 0
  try {
    for (let index = 0; index < 64; index++) {
      const pack = await worker({ action: 'paper_analysis_batch', id, pages, input_format: 'markdown', include_images: images,
        ...(cursor ? { cursor } : {}), ...(version ? { file_version: version } : {}) }, { library, python })
      if (pack.paper?.id !== id || pack.preprocessing?.representation !== 'normalized-markdown' || pack.preprocessing.raw_verbatim !== false) throw fail('READING_PACK_SOURCE_INVALID')
      version = pack.file_version
      manifest.file_version = version
      manifest.preprocessing = { ...pack.preprocessing, pages: undefined }
      manifest.batches.push({ index, source_ids: pack.source_ids, coverage: pack.coverage, visual_coverage: pack.visual_coverage })
      for (const source of pack.sources) {
        if (!pages.includes(source.locator?.page) || source.entity?.id !== id || typeof source.text !== 'string') throw fail('READING_PACK_SOURCE_INVALID')
        sourceBytes += Buffer.byteLength(source.text)
        if (sourceBytes > 512 * 1024) throw fail('READING_PACK_TEXT_LIMIT')
        chunks.push(`<!-- PDF page ${source.locator.page}; source ${source.id} -->\n${source.text}`)
      }
      for (const page of pack.preprocessing.pages) {
        if (!pages.includes(page.page)) throw fail('READING_PACK_SOURCE_INVALID')
        if (manifest.pages.some(saved => saved.page === page.page)) continue
        const raw = await cachedText(library, page.cache_files.raw_text, page.raw_text_sha256)
        const markdown = await cachedText(library, page.cache_files.markdown, page.markdown_sha256)
        const rawFile = `raw-page-${page.page}.txt`, markdownFile = `page-${page.page}.md`
        await save(rawFile, raw); await save(markdownFile, markdown)
        manifest.pages.push({ ...page, raw_file: rawFile, markdown_file: markdownFile })
        manifest.files.push({ path: rawFile, sha256: hash(raw), bytes: raw.length }, { path: markdownFile, sha256: hash(markdown), bytes: markdown.length })
      }
      for (const image of validateAnalysisImages(pack.images)) {
        if (!images || !pages.includes(image.page)) throw fail('READING_PACK_IMAGE_INVALID')
        const name = `page-${image.page}.png`
        if (manifest.files.some(file => file.path === name)) continue
        const data = Buffer.from(image.data, 'base64')
        await save(name, data)
        manifest.files.push({ path: name, sha256: image.sha256, bytes: data.length, width: image.width, height: image.height, page: image.page })
      }
      if (!pack.next_cursor) {
        const markdown = `<!-- Derived Markdown; quotations refer to the saved representation, not literal PDF extraction. -->\n\n${chunks.join('\n\n')}\n`
        await save('source.md', markdown)
        manifest.files.push({ path: 'source.md', sha256: hash(markdown), bytes: Buffer.byteLength(markdown) })
        manifest.status = 'complete'
        await save('manifest.json', JSON.stringify(manifest, null, 2) + '\n')
        return { out, manifest }
      }
      if (cursor && (pack.next_cursor.index < cursor.index || pack.next_cursor.index === cursor.index && pack.next_cursor.offset <= cursor.offset)) throw fail('READING_PACK_CURSOR_STALLED')
      cursor = pack.next_cursor
    }
    throw fail('READING_PACK_BATCH_LIMIT')
  } catch (error) {
    manifest.status = 'failed'; manifest.error = /^[A-Z][A-Z0-9_]+$/.test(error.code || '') ? error.code : 'READING_PACK_FAILED'
    await save('failure.json', JSON.stringify(manifest, null, 2) + '\n').catch(() => {})
    throw error
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2)
    if (args.includes('--help')) console.log('node scripts/prepare-paper-reading-pack.mjs --library /private/library --id paper-id --pages 1,2 --out /private/new-pack [--images] [--python /path/python]\n只读本地 PDF，最多 8 个显式页；输出可审阅 Markdown、原始提取、可选页面图片及清单；不调用模型。')
    else {
      const options = {}
      for (let index = 0; index < args.length; index++) {
        const flag = args[index]
        if (flag === '--images' && !options.images) { options.images = true; continue }
        if (!['--library', '--id', '--pages', '--out', '--python'].includes(flag) || Object.hasOwn(options, flag.slice(2)) || !args[index + 1] || args[index + 1].startsWith('--')) throw fail('READING_PACK_INPUT_INVALID')
        options[flag.slice(2)] = args[++index]
      }
      options.pages = options.pages?.split(',').map(Number)
      const result = await prepareReadingPack(options)
      console.log(JSON.stringify({ ok: true, out: result.out, pages: result.manifest.pages.length, images: result.manifest.include_images }))
    }
  } catch (error) { console.error(JSON.stringify({ ok: false, code: error.code || 'READING_PACK_FAILED' })); process.exitCode = 1 }
}
