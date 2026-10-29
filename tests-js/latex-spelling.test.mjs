import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { build } from 'esbuild'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const require = createRequire(import.meta.url)
let localChecker
async function checker() {
  if (localChecker) return localChecker
  const dictionaryRoot = dirname(fileURLToPath(import.meta.resolve('dictionary-en')))
  const result = await build({ entryPoints: ['src/client/latex-spelling.mjs'], bundle: true, platform: 'node', format: 'cjs', write: false, loader: { '.aff': 'text', '.dic': 'text' }, alias: Object.fromEntries(['aff', 'dic'].map(extension => [`dictionary-en/index.${extension}`, join(dictionaryRoot, `index.${extension}`)])), logLevel: 'silent' })
  const module = { exports: {} }
  vm.runInNewContext(result.outputFiles[0].text, { module, exports: module.exports, require })
  return localChecker = module.exports.checkSpelling
}

test('bundled local English dictionary checks prose while skipping LaTeX commands, citations and maths', async () => {
  const checkSpelling = await checker()
  const source = '😀 This is an exampel in the systme. \\cite{nospellkey} $notaword$ % notaword\n\\begin{equation}notaword\\end{equation}\n\\section{A clear sentence}'
  const checked = checkSpelling(source)
  assert.deepEqual(Array.from(checked.items, item => item.word), ['exampel', 'systme'])
  for (const item of checked.items) assert.equal(source.slice(item.from, item.to), item.word)
  assert.equal(checked.truncated, false)
})

test('escaped percentages preserve prose and later real comments still stop checking', async () => {
  const checkSpelling = await checker(), source = '100\\% acheivement % hiddenmispeling\nclear \\\\% hiddenmispeling\n\\% sentense'
  const result = checkSpelling(source)
  assert.deepEqual(Array.from(result.items, item => item.word), ['acheivement', 'sentense'])
  for (const item of result.items) assert.equal(source.slice(item.from, item.to), item.word)
})

test('correct prose still stops at the word budget and large sources report incomplete coverage', async () => {
  const checkSpelling = await checker()
  const words = checkSpelling('sentence '.repeat(6000) + 'mispeling')
  assert.equal(words.truncated, true); assert.equal(words.limitReason, 'words'); assert.equal(words.checkedWords, 5000)
  assert.equal(words.items.length, 0); assert.ok(words.checkedCharacters < 54000)
  const characters = checkSpelling(' '.repeat(200001) + 'mispeling')
  assert.equal(characters.truncated, true); assert.equal(characters.limitReason, 'characters'); assert.equal(characters.checkedCharacters, 200000)
})

test('distributed dictionary runs independently when the enhanced editor is unavailable', async () => {
  const window = {}, source = await readFile(new URL('../lib/latex-spelling.js', import.meta.url), 'utf8')
  vm.runInNewContext(source, { window })
  const result = window.PaperLatexSpelling.checkSpelling('A mispelled sentence.')
  assert.equal(result.items[0].word, 'mispelled')
  assert.equal(window.PaperLatexEditor, undefined)
})
