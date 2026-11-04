import nspell from 'nspell'
import aff from 'dictionary-en/index.aff'
import dic from 'dictionary-en/index.dic'

// The dictionary is loaded locally and initialized only when spell checking is enabled.
let checker
const MAX_CHARACTERS = 200_000, MAX_WORDS = 5_000
const syntaxArguments = new Map([
  ...[
    'begin', 'end', 'label', 'ref', 'eqref', 'pageref', 'autoref', 'nameref', 'cref', 'Cref', 'vref', 'Vref', 'nocite', 'bibentry',
    'input', 'include', 'includeonly', 'includegraphics', 'graphicspath', 'usepackage', 'RequirePackage', 'documentclass', 'LoadClass',
    'bibliographystyle', 'bibliography', 'addbibresource', 'url', 'nolinkurl', 'path', 'href', 'hyperlink', 'hypertarget',
    'textcolor', 'color', 'pagecolor', 'hypersetup', 'lstset', 'pgfkeys', 'tikzset', 'newcounter',
    'newcommand', 'renewcommand', 'providecommand', 'DeclareRobustCommand',
  ].map(name => [name, 1]),
  ...['PassOptionsToPackage', 'PassOptionsToClass', 'setcounter', 'addtocounter', 'counterwithin', 'counterwithout',
    'setlength', 'addtolength', 'setkeys', 'colorlet', 'fontsize'].map(name => [name, 2]),
  ['definecolor', 3], ['hyperref', 0],
])
const environmentArguments = new Map([
  ['tabular', 1], ['tabular*', 2], ['tabularx', 2], ['longtable', 1], ['array', 1], ['minipage', 1],
  ['figure', 0], ['figure*', 0], ['table', 0], ['table*', 0],
])
const blank = value => value.replace(/[^\n]/g, ' ')

function groupEnd(source, start) {
  const opening = source[start], closing = opening === '{' ? '}' : ']'
  let depth = 1, braces = 0
  for (let index = start + 1; index < source.length; index++) {
    const char = source[index]
    if (char === '\\') { index++; continue }
    // Braced values in an option may themselves contain brackets.
    if (opening === '[' && char === '{') braces++
    if (opening === '[' && char === '}' && braces) braces--
    if (braces) continue
    if (char === opening) depth++
    if (char === closing && --depth === 0) return index + 1
  }
  return source.length
}

function maskCommands(source) {
  const tokens = /\\(?:([A-Za-z@]+)\*?|[^\n])/g, space = /\s*/y
  const pieces = []; let cursor = 0, token
  while ((token = tokens.exec(source))) {
    const name = token[1]
    let end = tokens.lastIndex, required = /^(?:auto|paren|text|foot|smart|super)?cite\w*$/i.test(name || '') ? 1 : syntaxArguments.get(name)
    let environment = name === 'begin', trailingOptions = name === 'hyperref' || name === 'newcounter'
    // Only consume arguments with a known syntactic meaning. The arguments of
    // headings, formatting commands and unknown macros can contain real prose.
    while (required || trailingOptions) {
      space.lastIndex = end; space.exec(source)
      const start = space.lastIndex, opening = source[start]
      if (opening === '[') { end = groupEnd(source, start); continue }
      if (opening !== '{' || !required) break
      end = groupEnd(source, start)
      if (environment) {
        const argumentsCount = environmentArguments.get(source.slice(start + 1, end - 1))
        required = argumentsCount || 0
        trailingOptions = argumentsCount !== undefined
        environment = false
      } else required--
    }
    pieces.push(source.slice(cursor, token.index), blank(source.slice(token.index, end)))
    cursor = tokens.lastIndex = end
  }
  pieces.push(source.slice(cursor))
  return pieces.join('')
}

export function checkSpelling(source, limit = 100) {
  if (typeof source !== 'string') return { items: [], truncated: false, checkedCharacters: 0, checkedWords: 0 }
  const clipped = source.length > MAX_CHARACTERS
  source = source.slice(0, MAX_CHARACTERS)
  limit = Math.min(100, Math.max(1, Number.isInteger(limit) ? limit : 100))
  checker ||= nspell(aff, dic)
  // Blank non-prose spans without shifting UTF-16 offsets used by the editor.
  const comments = []; let commentCursor = 0
  for (let index = source.indexOf('%'); index >= 0; index = source.indexOf('%', index + 1)) {
    let before = index - 1
    while (before >= 0 && source[before] === '\\') before--
    if ((index - before - 1) % 2) continue // An escaped percentage is prose, not a comment.
    const newline = source.indexOf('\n', index), end = newline < 0 ? source.length : newline
    comments.push(source.slice(commentCursor, index), blank(source.slice(index, end)))
    commentCursor = end; index = end
  }
  comments.push(source.slice(commentCursor)); source = comments.join('')
  const environment = /\\begin\{(equation\*?|align\*?|gather\*?|multline\*?|displaymath|math|verbatim\*?|lstlisting)\}/g
  const segments = []; let cursor = 0, match
  while ((match = environment.exec(source))) {
    if (match.index < cursor) continue
    segments.push(source.slice(cursor, match.index))
    const ending = `\\end{${match[1]}}`, close = source.indexOf(ending, environment.lastIndex)
    cursor = close < 0 ? source.length : close + ending.length
    segments.push(blank(source.slice(match.index, cursor)))
    environment.lastIndex = cursor
    if (close < 0) break
  }
  segments.push(source.slice(cursor))
  const mask = maskCommands(segments.join('').replace(/\\\[[\s\S]*?\\\]|\\\([\s\S]*?\\\)|\$\$[\s\S]*?\$\$|\$[^$\n]*\$/g, blank))
  const items = []; let checkedWords = 0
  for (const match of mask.matchAll(/\b[A-Za-z][A-Za-z']{2,}\b/g)) {
    if (checkedWords >= MAX_WORDS) return { items, truncated: true, checkedWords, checkedCharacters: match.index, limitReason: 'words' }
    checkedWords++
    const word = match[0]
    if (word.length > 80) continue // Long identifiers are not ordinary prose words.
    if (checker.correct(word)) continue
    items.push({ word, from: match.index, to: match.index + word.length })
    if (items.length >= limit) return { items, truncated: true, checkedWords, checkedCharacters: match.index + word.length, limitReason: 'results' }
  }
  return { items, truncated: clipped, checkedWords, checkedCharacters: source.length, ...(clipped ? { limitReason: 'characters' } : {}) }
}
