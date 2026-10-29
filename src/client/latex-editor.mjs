import { EditorState, Compartment } from '@codemirror/state'
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { StreamLanguage, syntaxHighlighting, HighlightStyle, bracketMatching } from '@codemirror/language'
import { searchKeymap, openSearchPanel } from '@codemirror/search'
import { autocompletion, completionKeymap } from '@codemirror/autocomplete'
import { stex } from '@codemirror/legacy-modes/mode/stex'
import { tags } from '@lezer/highlight'

// These are suggestions, not a claim that a command is valid in every project.
const commands = ['documentclass', 'usepackage', 'begin', 'end', 'section', 'subsection', 'subsubsection', 'label', 'ref', 'eqref', 'cite', 'citep', 'citet', 'textbf', 'textit', 'emph', 'footnote', 'include', 'input', 'includegraphics', 'caption', 'item', 'frac', 'sum']
function latexCompletion(context) {
  const word = context.matchBefore(/\\[A-Za-z]*/)
  if (!word || (!context.explicit && word.from === word.to)) return null
  return { from: word.from, options: commands.map(command => ({ label: `\\${command}`, type: 'keyword' })), validFor: /\\[A-Za-z]*/ }
}

const theme = EditorView.theme({
  '&': { height: '100%', minWidth: '0', flex: '1', color: 'var(--ink)', backgroundColor: 'var(--panel)', font: 'inherit' },
  '.cm-scroller': { overflow: 'auto', fontFamily: 'inherit', lineHeight: '1.6' },
  '.cm-content': { padding: '10px 0', caretColor: 'var(--ink)' },
  '.cm-line': { padding: '0 12px' },
  '.cm-gutters': { color: 'var(--muted)', backgroundColor: 'var(--dsw-alias-interactive-bg-hover)', borderRight: '1px solid var(--line)' },
  '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'var(--dsw-alias-interactive-bg-hover)' },
  '.cm-panels, .cm-tooltip': { color: 'var(--ink)', backgroundColor: 'var(--surface)', borderColor: 'var(--line)' },
  '.cm-panel input, .cm-panel button': { color: 'var(--ink)', backgroundColor: 'var(--surface)', border: '1px solid var(--line)' },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: 'var(--teal)', color: 'var(--surface)' },
  '&.cm-focused': { outline: 'none' },
})
const highlighting = syntaxHighlighting(HighlightStyle.define([
  { tag: [tags.keyword, tags.controlKeyword, tags.tagName, tags.special(tags.variableName), tags.function(tags.variableName)], color: 'var(--latex-syntax-command)' },
  { tag: [tags.comment], color: 'var(--muted)', fontStyle: 'italic' },
  { tag: [tags.string, tags.special(tags.string)], color: 'var(--dsw-alias-state-warn-label, var(--ink))' },
  { tag: [tags.number, tags.atom], color: 'var(--latex-syntax-atom)' },
]))

/** Provide the workspace's existing textarea contract while CodeMirror owns input. */
function create(textarea, container) {
  const editable = new Compartment()
  let disabled = false
  let silent = false
  const extensions = [
    lineNumbers(), highlightActiveLine(), highlightActiveLineGutter(), history(), bracketMatching(),
    StreamLanguage.define(stex), highlighting, theme, EditorView.lineWrapping,
    EditorState.phrases.of({
      Find: '查找', Replace: '替换', next: '下一个', previous: '上一个', all: '全选匹配',
      'match case': '区分大小写', regexp: '正则表达式', 'by word': '全词匹配',
      replace: '替换', 'replace all': '全部替换', close: '关闭',
      'Go to line': '跳转到行', go: '跳转', 'current match': '当前匹配', 'on line': '位于行',
      'replaced match on line $': '已替换第 $ 行的匹配', 'replaced $ matches': '已替换 $ 处匹配',
      'No completions': '没有补全建议',
    }),
    autocompletion({ override: [latexCompletion] }),
    keymap.of([...completionKeymap, ...searchKeymap, ...defaultKeymap, ...historyKeymap]),
    EditorView.contentAttributes.of({ 'aria-label': 'LaTeX 源文件内容', spellcheck: 'false' }),
    editable.of([EditorState.readOnly.of(false), EditorView.editable.of(true)]),
    EditorView.updateListener.of(update => {
      if (update.docChanged && !silent) textarea.dispatchEvent(new Event('input', { bubbles: true }))
    }),
  ]
  const newState = text => EditorState.create({ doc: text, extensions })
  const view = new EditorView({ state: newState(textarea.value), parent: container })
  textarea.hidden = true
  Object.defineProperties(textarea, {
    value: { configurable: true, get: () => view.state.doc.toString(), set: value => {
      // A newly loaded file must not inherit another file's undo history.
      silent = true
      try {
        view.setState(newState(String(value ?? '')))
        view.dispatch({ effects: editable.reconfigure([EditorState.readOnly.of(disabled), EditorView.editable.of(!disabled)]) })
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
  return { view, openSearch: () => openSearchPanel(view), insert: (text, start, end) => {
    if (disabled) return false
    view.dispatch({ changes: { from: start, to: end, insert: text }, selection: { anchor: start + text.length }, scrollIntoView: true, userEvent: 'input' })
    view.focus()
    return true
  }, destroy: () => view.destroy() }
}
window.PaperLatexEditor = { create }
