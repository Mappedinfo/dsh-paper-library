import test from 'node:test'
import assert from 'node:assert/strict'
import { visualPlan, formatEdit, texGroup } from '../src/client/latex-visual.mjs'

function apply(source, edit) {
  assert.ok(edit)
  for (const change of [...edit.changes].reverse()) source = source.slice(0, change.from) + change.insert + source.slice(change.to)
  return source
}
test('visual projection preserves nested formatting, Unicode offsets, headings and list labels', () => {
  const source = String.raw`\section{标题 😀}
Text \textbf{bold \emph{italic}} and \underline{under}.
\begin{enumerate}
\item First
\item Second
\end{enumerate}`
  const plan = visualPlan(source)
  assert.deepEqual(plan.wrappers.map(w => source.slice(w.start, w.end)), ['标题 😀', 'bold \\emph{italic}', 'italic', 'under'])
  assert.deepEqual(plan.nodes.filter(n => n.kind === 'label').map(n => n.text), ['1.', '2.'])
  assert.ok(plan.nodes.every(n => n.from >= 0 && (n.to === undefined || n.to <= source.length)))
})
test('raw environments, comments, unknown macros and unfinished groups retain their original source', () => {
  for (const source of [String.raw`% \textbf{example}`, String.raw`\custom{\textbf{not interpreted}}`, String.raw`\begin{verbatim}\textbf{example}\end{verbatim}`, String.raw`\textbf{unfinished`]) {
    assert.equal(visualPlan(source).wrappers.length, 0)
  }
  assert.equal(texGroup('{a{b}c}', 0).end, 6)
  assert.equal(texGroup('{a\\}b}', 0).end, 5)
  assert.equal(visualPlan('x'.repeat(1024 * 1024 + 1)).bounded, true)
  assert.equal(visualPlan(String.raw`\begin{verbatim}\begin{document}\end{verbatim}`).nodes.some(n => n.kind === 'preamble'), false)
})
test('preamble is collapsed only at an uncommented document boundary; formulas and citations have exact spans', () => {
  const source = String.raw`% \begin{document}
\documentclass{article}
\title{Title}
\begin{document}
\maketitle
Text $x^2$ \citep[see]{Synthetic2026}.
\[\frac{1}{2}\]
\end{document}`
  const nodes = visualPlan(source).nodes
  assert.equal(source.slice(nodes[0].from, nodes[0].to).endsWith('\\begin{document}'), true)
  assert.deepEqual(nodes.filter(n => n.kind === 'math').map(n => n.content), ['x^2', '\\frac{1}{2}'])
  assert.equal(nodes.find(n => n.kind === 'citation').text, '[Synthetic2026]')
  assert.equal(nodes.find(n => n.kind === 'title').text, 'Title')
})
test('formatting produces standard TeX and toggles enclosing nested formats without losing selection', () => {
  const source = 'Hello 😀 world', from = source.indexOf('world'), edit = formatEdit(source, from, source.length, 'bold')
  const bold = apply(source, edit)
  assert.equal(bold, 'Hello 😀 \\textbf{world}')
  const italic = formatEdit(bold, edit.selection.anchor, edit.selection.head, 'italic')
  assert.equal(apply(bold, italic), 'Hello 😀 \\textbf{\\emph{world}}')
  const toggle = formatEdit(bold, edit.selection.anchor, edit.selection.head, 'bold')
  assert.equal(apply(bold, toggle), source)
  assert.equal(source.slice(toggle.selection.anchor, toggle.selection.head), 'world')
  const empty = formatEdit('abc', 3, 3, 'italic')
  assert.equal(apply('abc', empty), 'abc\\emph{}'); assert.equal(empty.selection.anchor, empty.selection.head)
})
test('format actions refuse partial TeX, unbalanced selections and protected formulas or settings', () => {
  for (const [source, from, to] of [[String.raw`\textbf{abc}`, 2, 4], ['a {b}', 0, 3], ['$x+1$', 1, 2], [String.raw`\cite{key}`, 6, 8], [String.raw`\documentclass{article}\begin{document}Text`, 1, 3]]) {
    assert.equal(formatEdit(source, from, to, 'bold'), null)
  }
  assert.equal(apply('Body text', formatEdit('Body text', 2, 2, 'heading')), '\\section{Body text}')
})
