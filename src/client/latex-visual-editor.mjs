import { StateEffect, StateField } from '@codemirror/state'
import { Decoration, EditorView, WidgetType, keymap } from '@codemirror/view'
import { isolateHistory } from '@codemirror/commands'
import katex from 'katex'
import { visualPlan, formatEdit } from './latex-visual.mjs'

const setVisual = StateEffect.define()
const mathCache = new Map()
class SourceWidget extends WidgetType {
  constructor(node) { super(); this.node = node }
  eq(other) { return JSON.stringify(this.node) === JSON.stringify(other.node) }
  toDOM(view) {
    const node = this.node, dom = document.createElement('span')
    dom.className = `latex-visual-widget latex-visual-${node.kind}`
    dom.tabIndex = 0; dom.setAttribute('role', 'button')
    dom.title = node.kind === 'preamble' ? '点击编辑文档设置；离开后重新收起' : '点击编辑对应 LaTeX 源码'
    dom.setAttribute('aria-label', node.kind === 'math' ? `编辑公式：${node.content}` : dom.title)
    if (node.kind === 'math' && node.content.length <= 6000) {
      const key = `${node.display}:${node.content}`
      let rendered = mathCache.get(key)
      if (rendered === undefined) {
        try { rendered = katex.renderToString(node.content, { displayMode: node.display, output: 'mathml', trust: false, strict: 'error', throwOnError: true, maxExpand: 100, maxSize: 10 }) }
        catch { rendered = null }
        if (mathCache.size >= 100) mathCache.delete(mathCache.keys().next().value)
        mathCache.set(key, rendered)
      }
      if (rendered) dom.innerHTML = rendered // KaTeX generates MathML with trusted commands disabled.
      else { dom.textContent = view.state.sliceDoc(node.from, node.to); dom.classList.add('latex-visual-raw'); dom.title = '此公式暂不能预览，点击编辑源码' }
    } else dom.textContent = node.kind === 'preamble' ? '文档设置 · 点击编辑源码' : node.text || view.state.sliceDoc(node.from, node.to)
    const edit = event => {
      event.preventDefault()
      view.dispatch({ selection: { anchor: node.from + (node.kind === 'preamble' ? 0 : 1) }, scrollIntoView: true })
      view.focus()
    }
    dom.addEventListener('mousedown', edit)
    dom.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') edit(event) })
    return dom
  }
  ignoreEvent() { return true }
}
const touches = (selection, node) => selection.ranges.some(r => r.empty ? r.head >= node.from && r.head < node.to : r.from < node.to && r.to > node.from)
function decorations(plan, state, enabled) {
  if (!enabled) return { marks: Decoration.none, atomic: Decoration.none }
  const marks = [], atomic = []
  for (const node of plan.nodes) {
    if (node.kind === 'mark') marks.push(Decoration.mark({ class: `latex-visual-${node.style}` }).range(node.from, node.to))
    else if (node.kind === 'line') marks.push(Decoration.line({ class: `latex-visual-line-${node.style}` }).range(node.from))
    else if (node.kind === 'hide') {
      const range = Decoration.replace({ inclusive: false }).range(node.from, node.to)
      marks.push(range); atomic.push(range)
    } else if (node.kind === 'label') {
      const range = Decoration.replace({ widget: new SourceWidget(node), inclusive: false }).range(node.from, node.to)
      // Labels remain visible while typing the associated prose.
      if (!touches(state.selection, node)) { marks.push(range); atomic.push(range) }
    } else if (!touches(state.selection, node)) {
      const range = Decoration.replace({ widget: new SourceWidget(node), inclusive: false }).range(node.from, node.to)
      marks.push(range); atomic.push(range)
    }
  }
  return { marks: Decoration.set(marks, true), atomic: Decoration.set(atomic, true) }
}
export const visualField = StateField.define({
  create(state) { return { enabled: false, plan: visualPlan(state.doc.toString()), marks: Decoration.none, atomic: Decoration.none } },
  update(value, tr) {
    let enabled = value.enabled
    for (const effect of tr.effects) if (effect.is(setVisual)) enabled = effect.value
    if (!tr.docChanged && !tr.selection && enabled === value.enabled) return value
    const plan = tr.docChanged ? visualPlan(tr.state.doc.toString()) : value.plan
    return { enabled, plan, ...decorations(plan, tr.state, enabled) }
  },
  provide: field => [EditorView.decorations.from(field, value => value.marks),
    EditorView.atomicRanges.of(view => view.state.field(field).atomic),
    EditorView.editorAttributes.from(field, value => ({ class: value.enabled ? 'latex-visual-editor' : '' }))],
})
export function setVisualMode(view, enabled) {
  const state = view.state, preamble = state.field(visualField).plan.nodes.find(n => n.kind === 'preamble')
  const selection = enabled && state.selection.main.empty && preamble && state.selection.main.head < preamble.to ? { anchor: preamble.to } : undefined
  view.dispatch({ effects: setVisual.of(enabled), ...(selection ? { selection } : {}) })
  view.requestMeasure()
}
export function applyFormat(view, kind) {
  if (view.state.readOnly || view.state.selection.ranges.length !== 1) return false
  const { from, to } = view.state.selection.main, edit = formatEdit(view.state.doc.toString(), from, to, kind)
  if (!edit) return false
  view.dispatch({ ...edit, scrollIntoView: true, userEvent: 'input.format', annotations: isolateHistory.of('full') }); view.focus(); return true
}
function unwrapBoundary(view, backward) {
  const state = view.state, visual = state.field(visualField)
  if (state.readOnly || !visual.enabled || !state.selection.main.empty) return false
  const pos = state.selection.main.head
  const wrapper = visual.plan.wrappers.filter(w => backward ? w.start === pos : w.end === pos).sort((a, b) => (a.to - a.from) - (b.to - b.from))[0]
  if (!wrapper) return false
  view.dispatch({ changes: [{ from: wrapper.from, to: wrapper.start, insert: '' }, { from: wrapper.end, to: wrapper.to, insert: '' }],
    selection: { anchor: pos - (wrapper.start - wrapper.from) }, userEvent: 'delete.format', annotations: isolateHistory.of('full') })
  return true
}
export const visualEditing = (canFormat = () => true) => [visualField, keymap.of([
  ...[['Mod-b', 'bold'], ['Mod-i', 'italic'], ['Mod-u', 'underline']].map(([key, kind]) => ({ key, preventDefault: true, run: view => canFormat() && applyFormat(view, kind) })),
  { key: 'Backspace', run: view => unwrapBoundary(view, true) }, { key: 'Delete', run: view => unwrapBoundary(view, false) },
])]
