import { createLatexProjectMemory } from '../latex-project-memory.mjs'
import { EditorState, Compartment, StateEffect, StateField } from '@codemirror/state'
import { Decoration, EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { StreamLanguage, syntaxHighlighting, HighlightStyle, bracketMatching } from '@codemirror/language'
import { searchKeymap, openSearchPanel } from '@codemirror/search'
import { autocompletion, completionKeymap } from '@codemirror/autocomplete'
import { stex } from '@codemirror/legacy-modes/mode/stex'
import { tags } from '@lezer/highlight'
import { visualEditing, visualField, setVisualMode, applyFormat } from './latex-visual-editor.mjs'

// These are suggestions, not a claim that a command is valid in every project.
const citeCommands = ['cite', 'citep', 'citet', 'parencite', 'textcite', 'autocite', 'footcite', 'supercite', 'smartcite', 'nocite']
const commands = ['documentclass', 'usepackage', 'begin', 'end', 'section', 'subsection', 'subsubsection', 'label', 'ref', 'eqref', ...citeCommands, 'textbf', 'textit', 'emph', 'footnote', 'include', 'input', 'includegraphics', 'caption', 'item', 'frac', 'sum']
function latexCompletion(context) {
  const word = context.matchBefore(/\\[A-Za-z]*/)
  if (!word || (!context.explicit && word.from === word.to)) return null
  return { from: word.from, options: commands.map(command => ({ label: `\\${command}`, type: 'keyword' })), validFor: /\\[A-Za-z]*/ }
}

const citationStart = new RegExp(String.raw`\\(?:${citeCommands.join('|')})\*?\s*(?:\[[^\]\r\n]*\]\s*){0,2}\{([^{}\r\n%]*)$`)
function citationRange(state, pos) {
  const line = state.doc.lineAt(pos)
  const before = line.text.slice(0, pos - line.from)
  if (/(?:^|[^\\])(?:\\\\)*%/.test(before)) return null
  const match = before.match(citationStart)
  if (!match) return null
  let command = match.index
  while (command > 0 && before[command - 1] === '\\') command--
  if ((match.index - command) % 2) return null
  const term = match[1].slice(match[1].lastIndexOf(',') + 1).trimStart()
  const after = line.text.slice(pos - line.from)
  const rest = after.match(/^[^\s{},%]*(?=\s*[,}])/)?.[0] || ''
  return { from: pos - term.length, to: pos + rest.length, query: term.trimEnd(),
    close: !/^\s*[,}]/.test(after.slice(rest.length)) }
}

function libraryCompletion(context, citation) {
  const range = citation && citationRange(context.state, context.pos)
  if (!range) return latexCompletion(context)
  if (range.query.length > 160) return null
  const controller = new AbortController()
  context.addEventListener('abort', () => controller.abort(), { onDocChange: true })
  return citation.search(range.query, controller.signal).then(items => {
    if (controller.signal.aborted || !items.length) return null
    return { from: range.from, filter: false, options: items.map(item => ({
      label: item.citekey, detail: [item.title, item.year].filter(Boolean).join(' · '),
      info: item.authors?.length ? item.authors.join(' · ') : undefined,
      section: 'Paper Library', type: 'text',
      apply(view) {
        const target = citationRange(view.state, view.state.selection.main.head)
        if (target) citation.pick(item, target)
      },
    })) }
  }).catch(() => null)
}

const theme = EditorView.theme({
  '&': { height: '100%', minWidth: '0', flex: '1', color: 'var(--latex-editor-ink, var(--ink))', backgroundColor: 'var(--latex-editor-background, var(--panel))', font: 'inherit' },
  '.cm-scroller': { overflow: 'auto', fontFamily: 'inherit', lineHeight: 'var(--latex-editor-line-height, 1.6)' },
  '.cm-content': { padding: '10px 0', caretColor: 'var(--latex-editor-ink, var(--ink))' },
  '.cm-line': { padding: '0 12px' },
  '.cm-gutters': { color: 'var(--latex-editor-muted, var(--muted))', backgroundColor: 'var(--latex-editor-gutter)', borderRight: '1px solid var(--line)' },
  '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'var(--latex-editor-active)' },
  '.cm-panels, .cm-tooltip': { color: 'var(--ink)', backgroundColor: 'var(--surface)', borderColor: 'var(--line)' },
  '.cm-panel.cm-search': {
    display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '5px 6px',
    padding: '7px 36px 7px 8px', font: '12px/1.4 var(--sans)',
  },
  '.cm-panel.cm-search .cm-button, .cm-panel.cm-search .cm-textfield': {
    minHeight: '26px', boxSizing: 'border-box', margin: '0', padding: '3px 7px',
    font: 'inherit', color: 'var(--ink)', backgroundColor: 'var(--panel)', backgroundImage: 'none',
    border: '1px solid var(--line)', borderRadius: '5px',
  },
  '.cm-panel.cm-search .cm-textfield': { minWidth: '5em', flex: '1 1 9em' },
  '.cm-panel.cm-search .cm-textfield::placeholder': { color: 'var(--muted)', opacity: '1' },
  '.cm-panel.cm-search button': { cursor: 'pointer' },
  '.cm-panel.cm-search .cm-button:hover, .cm-panel.cm-search .cm-button:active, .cm-panel.cm-search [name=close]:hover': {
    backgroundColor: 'var(--latex-active-bg)', backgroundImage: 'none',
  },
  '.cm-panel.cm-search label': { display: 'inline-flex', alignItems: 'center', gap: '4px', margin: '0', font: 'inherit' },
  '.cm-panel.cm-search input[type=checkbox]': { margin: '0', accentColor: 'var(--latex-active-marker)' },
  '.cm-panel.cm-search br': { flexBasis: '100%', height: '0' },
  '.cm-panel.cm-search [name=close]': {
    top: '7px', right: '6px', width: '26px', height: '26px', borderRadius: '5px',
    color: 'var(--ink)', fontSize: '17px',
  },
  '.cm-panel.cm-search :is(button, input):focus-visible': { outline: '2px solid var(--latex-active-marker)', outlineOffset: '1px' },
  '.cm-content .cm-searchMatch': { backgroundColor: 'color-mix(in srgb, var(--teal) 22%, transparent)' },
  '.cm-content .cm-searchMatch.cm-searchMatch-selected': {
    backgroundColor: 'color-mix(in srgb, var(--teal) 35%, transparent)', boxShadow: 'inset 0 -2px var(--teal)',
  },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: 'var(--teal)', color: 'var(--surface)' },
  '&.cm-focused': { outline: 'none' },
})
const highlighting = syntaxHighlighting(HighlightStyle.define([
  { tag: [tags.keyword, tags.controlKeyword, tags.tagName, tags.special(tags.variableName), tags.function(tags.variableName)], color: 'var(--latex-syntax-command)' },
  { tag: [tags.comment], color: 'var(--latex-editor-muted, var(--muted))', fontStyle: 'italic' },
  { tag: [tags.string, tags.special(tags.string)], color: 'var(--latex-syntax-string, var(--ink))' },
  { tag: [tags.number, tags.atom], color: 'var(--latex-syntax-atom)' },
]))

const setProjectSearchMarks = StateEffect.define()
const projectSearchMarks = StateField.define({
  create: () => Decoration.none,
  update(marks, transaction) {
    if (transaction.docChanged) marks = Decoration.none
    for (const effect of transaction.effects) if (effect.is(setProjectSearchMarks)) marks = effect.value
    return marks
  },
  provide: field => EditorView.decorations.from(field),
})

function annotationMarks(mapChanges = false) {
  const set = StateEffect.define()
  const field = StateField.define({
    create: () => Decoration.none,
    update(marks, transaction) {
      for (const effect of transaction.effects) if (effect.is(set)) return effect.value
      if (!transaction.docChanged) return marks
      if (!mapChanges) return Decoration.none
      transaction.changes.iterChangedRanges((from, to) => {
        marks = marks.update({ filterFrom: from, filterTo: to, filter: (start, end) => !(start < to && end > from) })
      })
      return marks.map(transaction.changes)
    },
    provide: state => EditorView.decorations.from(state),
  })
  return { set, field }
}
const spelling = annotationMarks(), review = annotationMarks(true)

/** Provide the workspace's existing textarea contract while CodeMirror owns input. */
function create(textarea, container, citation) {
  const editable = new Compartment()
  let disabled = false
  let silent = false
  let visual = false
  const canFormat = () => citation?.canFormat?.() !== false
  const extensions = [
    lineNumbers(), highlightActiveLine(), highlightActiveLineGutter(), history(), bracketMatching(), visualEditing(canFormat),
    StreamLanguage.define(stex), highlighting, theme, EditorView.lineWrapping, projectSearchMarks, spelling.field, review.field,
    EditorState.phrases.of({
      Find: '查找', Replace: '替换', next: '下一个', previous: '上一个', all: '全选匹配',
      'match case': '区分大小写', regexp: '正则表达式', 'by word': '全词匹配',
      replace: '替换', 'replace all': '全部替换', close: '关闭',
      'Go to line': '跳转到行', go: '跳转', 'current match': '当前匹配', 'on line': '位于行',
      'replaced match on line $': '已替换第 $ 行的匹配', 'replaced $ matches': '已替换 $ 处匹配',
      'No completions': '没有补全建议',
    }),
    autocompletion({ override: [context => libraryCompletion(context, citation)] }),
    keymap.of([...completionKeymap, ...searchKeymap, ...defaultKeymap, ...historyKeymap]),
    EditorView.contentAttributes.of({ 'aria-label': 'LaTeX 源文件内容', spellcheck: 'false' }),
    editable.of([EditorState.readOnly.of(false), EditorView.editable.of(true)]),
    EditorView.updateListener.of(update => {
      if (update.docChanged && !silent) textarea.dispatchEvent(new Event('input', { bubbles: true }))
      if ((update.selectionSet || update.docChanged) && !silent) textarea.dispatchEvent(new Event('select'))
    }),
  ]
  const newState = text => EditorState.create({ doc: text, extensions })
  const view = new EditorView({ state: newState(textarea.value), parent: container })
  const forwardScroll=()=>textarea.dispatchEvent(new Event('scroll'));
  view.scrollDOM.addEventListener('scroll',forwardScroll);
  textarea.hidden = true
  Object.defineProperties(textarea, {
    value: { configurable: true, get: () => view.state.doc.toString(), set: value => {
      // A newly loaded file must not inherit another file's undo history.
      silent = true
      try {
        view.setState(newState(String(value ?? '')))
        view.dispatch({ effects: editable.reconfigure([EditorState.readOnly.of(disabled), EditorView.editable.of(!disabled)]) })
        if (visual) setVisualMode(view, true)
      } finally { silent = false }
    } },
    selectionStart: { configurable: true, get: () => view.state.selection.main.from },
    selectionEnd: { configurable: true, get: () => view.state.selection.main.to },
    disabled: { configurable: true, get: () => disabled, set: value => {
      disabled = Boolean(value)
      view.dispatch({ effects: editable.reconfigure([EditorState.readOnly.of(disabled), EditorView.editable.of(!disabled)]) })
    } },
    scrollTop: { configurable: true, get: () => view.scrollDOM.scrollTop, set: value => { view.scrollDOM.scrollTop = value } },
    clientHeight: { configurable: true, get: () => view.scrollDOM.clientHeight },
  })
  textarea.focus = () => view.focus()
  textarea.setSelectionRange = (start, end) => {
    const limit = view.state.doc.length
    view.dispatch({ selection: { anchor: Math.max(0, Math.min(start, limit)), head: Math.max(0, Math.min(end, limit)) }, scrollIntoView: true })
  }
  function paint(layer, ranges, className) {
    const marks = ranges.filter(({ from, to }) => Number.isInteger(from) && Number.isInteger(to) && from >= 0 && to > from && to <= view.state.doc.length)
      .map(({ from, to, title, terminology }) => Decoration.mark({ class: terminology ? 'latex-terminology-mark' : className, attributes: { ...(title ? { title } : {}), ...(layer === spelling ? { 'data-latex-spell': String(from) } : {}) } }).range(from, to))
    if (!marks.length && view.state.field(layer.field) === Decoration.none) return
    view.dispatch({ effects: layer.set.of(Decoration.set(marks, true)) })
  }
  return { view, setMode(mode) { visual = mode === 'visual'; setVisualMode(view, visual) },
  format: kind => canFormat() && applyFormat(view, kind),
  visualStatus: () => ({ bounded: view.state.field(visualField).plan.bounded }),
  restorePosition({start,end,scrollTop}) {
    const limit=view.state.doc.length;
    view.dispatch({selection:{anchor:Math.max(0,Math.min(start,limit)),head:Math.max(0,Math.min(end,limit))}});
    view.scrollDOM.scrollTop=Math.max(0,scrollTop);
  }, requestMeasure: () => view.requestMeasure(), citationRange: () => citationRange(view.state, view.state.selection.main.head), cursorLine: () => view.state.doc.lineAt(view.state.selection.main.head).number, openSearch: () => openSearchPanel(view), setProjectSearchMatches(ranges) {
    const length = view.state.doc.length
    const marks = ranges.filter(({ from, to }) => Number.isInteger(from) && Number.isInteger(to) && from >= 0 && to > from && to <= length)
      .map(({ from, to, active }) => Decoration.mark({ class: active ? 'latex-search-source-hit active' : 'latex-search-source-hit' }).range(from, to))
    // A document update already clears this field before the input callback.
    if (!marks.length && view.state.field(projectSearchMarks) === Decoration.none) return
    view.dispatch({ effects: setProjectSearchMarks.of(Decoration.set(marks, true)) })
  }, setSpellingMarks: ranges => paint(spelling, ranges, 'latex-spelling-mark'),
  setReviewMarks: ranges => paint(review, ranges, 'latex-source-review-mark'),
  insert: (text, start, end) => {
    if (disabled) return false
    view.dispatch({ changes: { from: start, to: end, insert: text }, selection: { anchor: start + text.length }, scrollIntoView: true, userEvent: 'input' })
    view.focus()
    return true
  }, destroy: () => {view.scrollDOM.removeEventListener('scroll',forwardScroll);view.destroy()} }
}
window.PaperLatexEditor = { create, createProjectMemory: createLatexProjectMemory }
