import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { JSDOM } from 'jsdom'
import { fileURLToPath } from 'node:url'

const bundle = await build({ stdin: { contents: `import './src/client/latex-editor.mjs'; import {undo,redo} from '@codemirror/commands'; import {visualField} from './src/client/latex-visual-editor.mjs'; window.__test={undo,redo,visualField};`, resolveDir: fileURLToPath(new URL('../', import.meta.url)) }, bundle: true, write: false, format: 'iife', platform: 'browser' })
function fixture(t, source, options) {
  const dom = new JSDOM('<!doctype html><textarea></textarea><div id="editor"></div>', { runScripts: 'outside-only', pretendToBeVisual: true })
  const { window } = dom
  window.Range.prototype.getClientRects = () => []
  window.Range.prototype.getBoundingClientRect = () => ({ left: 0, right: 0, top: 0, bottom: 0 })
  window.eval(bundle.outputFiles[0].text)
  const textarea = window.document.querySelector('textarea'); textarea.value = source
  const editor = window.PaperLatexEditor.create(textarea, window.document.getElementById('editor'), options)
  t.after(() => { editor.destroy(); dom.window.close() })
  return { window, textarea, editor, view: editor.view, ...window.__test }
}
test('real CodeMirror renders editable visual text and math while toggling leaves source and undo intact', t => {
  const source = String.raw`\section{Introduction}
Plain \textbf{bold} and \emph{italic}, $x^2$ and \cite{Synthetic2026}.`
  const f = fixture(t, source), { view, editor, textarea } = f
  textarea.setSelectionRange(source.indexOf('Plain'), source.indexOf('Plain'))
  let inputs = 0; textarea.addEventListener('input', () => inputs++)
  editor.setMode('visual')
  assert.equal(textarea.value, source); assert.equal(inputs, 0)
  assert.ok(view.dom.classList.contains('latex-visual-editor'))
  assert.equal(view.dom.querySelector('.latex-visual-bold').textContent, 'bold')
  assert.ok(view.dom.querySelector('math')); assert.equal(view.dom.querySelector('.latex-visual-citation').textContent, '[Synthetic2026]')
  const from = source.indexOf('Plain'); textarea.setSelectionRange(from, from + 5)
  assert.equal(editor.format('bold'), true)
  assert.equal(inputs, 1); assert.ok(textarea.value.includes('\\textbf{Plain}'))
  editor.setMode('source'); assert.equal(f.undo(view), true); assert.equal(textarea.value, source)
  assert.equal(f.redo(view), true); assert.ok(textarea.value.includes('\\textbf{Plain}'))
  editor.setMode('visual'); assert.equal(view.state.field(f.visualField).enabled, true)
  editor.insert('writing', from + 8, from + 13)
  assert.ok(textarea.value.includes('\\textbf{writing}')); assert.equal(view.dom.querySelector('.latex-visual-bold').textContent, 'writing')
})
test('math clicks reveal editable source; unsafe or unsupported TeX remains text with no active HTML', t => {
  const source = String.raw`Text $\frac{a}{b}$ and $\href{javascript:alert(1)}{bad}$ and $\unknownFormula{a}$ and \custom{keep}.`
  const f = fixture(t, source); f.textarea.setSelectionRange(0, 0); f.editor.setMode('visual')
  assert.ok(f.view.dom.querySelector('math'))
  assert.equal([...f.view.dom.querySelectorAll('.latex-visual-widget')].some(node => node.querySelector('a, img, script')), false)
  assert.ok(f.view.dom.querySelector('.latex-visual-raw'))
  f.view.dom.querySelector('.latex-visual-math').dispatchEvent(new f.window.MouseEvent('mousedown', { bubbles: true, cancelable: true }))
  assert.equal(f.textarea.selectionStart, source.indexOf('$') + 1)
  assert.equal(f.view.dom.querySelectorAll('.latex-visual-math').length, 2)
  assert.equal(f.textarea.value, source)
})
test('preamble opens on demand, switching files keeps visual mode, and disabled editors cannot format', t => {
  const source = String.raw`\documentclass{article}
\begin{document}
\section{Body}
Text.
\end{document}`
  const f = fixture(t, source); f.editor.setMode('visual')
  assert.ok(f.view.dom.querySelector('.latex-visual-preamble'))
  f.view.dom.querySelector('.latex-visual-preamble').dispatchEvent(new f.window.MouseEvent('mousedown', { bubbles: true, cancelable: true }))
  assert.equal(f.textarea.selectionStart, 0); assert.equal(f.view.dom.querySelector('.latex-visual-preamble'), null)
  f.textarea.value = String.raw`\textbf{Other file}`
  assert.ok(f.view.dom.classList.contains('latex-visual-editor')); assert.equal(f.view.dom.querySelector('.latex-visual-bold').textContent, 'Other file')
  f.textarea.disabled = true; assert.equal(f.editor.format('italic'), false)
  f.textarea.disabled = false; assert.equal(f.editor.format('italic'), true)
})
test('keyboard shortcuts format text and boundary deletion unwraps without leaving broken groups', t => {
  const f = fixture(t, 'Writing'), { textarea, view } = f
  f.editor.setMode('visual'); textarea.setSelectionRange(0, 7)
  view.contentDOM.dispatchEvent(new f.window.KeyboardEvent('keydown', { key: 'b', code: 'KeyB', ctrlKey: true, bubbles: true, cancelable: true }))
  assert.equal(textarea.value, '\\textbf{Writing}')
  textarea.setSelectionRange(8, 8)
  view.contentDOM.dispatchEvent(new f.window.KeyboardEvent('keydown', { key: 'Backspace', code: 'Backspace', bubbles: true, cancelable: true }))
  assert.equal(textarea.value, 'Writing')
  assert.equal(f.undo(view), true); assert.equal(textarea.value, '\\textbf{Writing}')
})

test('workspace guards can disable formatting shortcuts for non-TeX files or a blocked file switch', t => {
  const f = fixture(t, 'Synthetic bibliography', { canFormat: () => false })
  f.textarea.setSelectionRange(0, 9)
  assert.equal(f.editor.format('bold'), false)
  f.view.contentDOM.dispatchEvent(new f.window.KeyboardEvent('keydown', { key: 'i', code: 'KeyI', ctrlKey: true, bubbles: true, cancelable: true }))
  assert.equal(f.textarea.value, 'Synthetic bibliography')
})
