import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import JSZip from 'jszip'
import { createDeckTemplate } from '../../lib/plaindeck-core.mjs'

const core = fileURLToPath(new URL('../../vendor/plaindeck/packages/plaindeck/src/core/index.ts', import.meta.url))
const result = await build({ entryPoints: [fileURLToPath(new URL('./zip.ts', import.meta.url))], bundle: true, write: false, format: 'cjs', platform: 'node', target: 'node22', alias: { 'plaindeck/core': core } })
const module = { exports: {} }
new Function('require', 'module', 'exports', result.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports)
const { inspectZip } = module.exports

async function documentZip(template) {
  const document = createDeckTemplate(template, { lang: 'zh' }), zip = new JSZip()
  zip.file('deck.json', JSON.stringify(document.deck)); zip.file(document.deck.theme.replace(/^\.\//, ''), JSON.stringify(document.theme))
  for (const path of document.deck.slides) zip.file(path.replace(/^\.\//, ''), JSON.stringify(document.slides[path]))
  return { document, zip }
}
async function file(zip) { return new File([await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })], 'synthetic.zip', { type: 'application/zip' }) }

test('upstream paper-reading template ZIP with image placeholders imports without data loss', async () => {
  const { document, zip } = await documentZip('paper-reading')
  const imported = await inspectZip(await file(zip))
  assert.equal(imported.document.deck.slides.length, document.deck.slides.length)
  assert.equal(imported.assets.size, 0)
})
test('ZIP import rejects unsafe paths and files beyond the count and decompression budgets', async () => {
  const unsafe = await documentZip('blank'); unsafe.zip.file('../outside.txt', 'x')
  await assert.rejects(inspectZip(await file(unsafe.zip)), /不安全/)
  const tooMany = await documentZip('blank'); for (let index = 0; index < 201; index++) tooMany.zip.file(`extra/${index}.txt`, 'x')
  await assert.rejects(inspectZip(await file(tooMany.zip)), /200/)
  const bomb = await documentZip('blank'); bomb.zip.file('extra/a.txt', 'x'.repeat(8 * 1024 * 1024)); bomb.zip.file('extra/b.txt', 'x'.repeat(8 * 1024 * 1024))
  await assert.rejects(inspectZip(await file(bomb.zip)), /16 MiB/)
  await assert.rejects(inspectZip(new File([new Uint8Array(8 * 1024 * 1024 + 1)], 'large.zip')), /8 MiB/)
})
test('ZIP import refuses duplicate central-directory names', async () => {
  const { zip } = await documentZip('blank'); zip.file('extra/a.txt', 'a'); zip.file('extra/b.txt', 'b')
  const bytes = new Uint8Array(await (await file(zip)).arrayBuffer())
  const view = new DataView(bytes.buffer); const needle = new TextEncoder().encode('extra/b.txt')
  for (let index = 0; index < bytes.length - 46 - needle.length; index++) {
    if (view.getUint32(index, true) !== 0x02014b50 || !needle.every((value, j) => bytes[index + 46 + j] === value)) continue
    bytes[index + 46 + needle.length - 5] = 'a'.charCodeAt(0); break
  }
  await assert.rejects(inspectZip(new File([bytes], 'duplicate.zip')), /重复|冲突/)
})
test('ZIP import rejects a remote background before rendering and permits ordinary source text', async () => {
  const { document, zip } = await documentZip('paper-reading')
  document.theme.colors.background = 'url(https://example.com/leak)'
  zip.file(document.deck.theme.replace(/^\.\//, ''), JSON.stringify(document.theme))
  await assert.rejects(inspectZip(await file(zip)), /颜色或字体/)
})
test('ZIP import extracts embedded PNG into a managed asset candidate', async () => {
  const { document, zip } = await documentZip('paper-reading')
  const path = document.deck.slides.find(path => document.slides[path].elements.some(element => element.type === 'image'))
  assert.ok(path)
  const element = document.slides[path].elements.find(element => element.type === 'image')
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/8d4AAAAASUVORK5CYII='
  element.src = `data:image/png;base64,${png}`
  zip.file(path.replace(/^\.\//, ''), JSON.stringify(document.slides[path]))
  const result = await inspectZip(await file(zip))
  assert.equal(result.assets.get(element.src).mime, 'image/png')
  assert.deepEqual(result.assets.get(element.src).bytes.slice(0, 8), new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]))
})
