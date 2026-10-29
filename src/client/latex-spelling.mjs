import nspell from 'nspell'
import aff from 'dictionary-en/index.aff'
import dic from 'dictionary-en/index.dic'

// The dictionary is loaded locally and initialized only when spell checking is enabled.
let checker
const MAX_CHARACTERS = 200_000, MAX_WORDS = 5_000
export function checkSpelling(source, limit = 100) {
  if (typeof source !== 'string') return { items: [], truncated: false, checkedCharacters: 0, checkedWords: 0 }
  const clipped = source.length > MAX_CHARACTERS
  source = source.slice(0, MAX_CHARACTERS)
  limit = Math.min(100, Math.max(1, Number.isInteger(limit) ? limit : 100))
  checker ||= nspell(aff, dic)
  // Blank non-prose spans without shifting UTF-16 offsets used by the editor.
  const blank = value => value.replace(/[^\n]/g, ' ')
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
  const mask = segments.join('').replace(/\\\[[\s\S]*?\\\]|\\\([\s\S]*?\\\)|\$\$[\s\S]*?\$\$|\$[^$\n]*\$|\\(?:begin|end|label|ref|eqref|cite\w*|input|include|includegraphics|usepackage|documentclass|url|href)\s*(?:\[[^\]]*\])?\s*\{[^}]*\}|\\[A-Za-z@]+\*?/g, blank)
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
