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

const englishPhrase = /^[A-Za-z][A-Za-z0-9' -]{1,79}$/
const chinesePhrase = /^\p{Script=Han}{2,32}$/u

export function buildGlossary(rows) {
  const words = new Map(), chinese = new Map()
  for (const entry of rows || []) {
    const term = entry.term?.trim(), meaning = entry.meaning?.trim()
    if (!term || !meaning) continue
    const english = englishPhrase.test(term) ? [term] : meaning.split(/[;；/、,，]/).map(value => value.trim()).filter(value => englishPhrase.test(value))
    for (const phrase of english) {
      for (const word of phrase.match(/[A-Za-z][A-Za-z']{2,}/g) || []) {
        const key = word.toLowerCase()
        if (!words.has(key)) words.set(key, { word, phrase, meaning: phrase === term ? meaning : term })
      }
      const source = phrase === term ? meaning : term
      if (!chinesePhrase.test(source)) continue
      const group = chinese.get(source[0]) || new Map()
      const candidates = group.get(source) || []
      if (candidates.length < 4 && !candidates.includes(phrase)) candidates.push(phrase)
      group.set(source, candidates)
      chinese.set(source[0], group)
    }
  }
  const matchers = new Map()
  for (const [first, group] of chinese) matchers.set(first, {
    pattern: new RegExp([...group.keys()].sort((a, b) => b.length - a.length).join('|'), 'y'),
    group,
  })
  return { words, matchers }
}

function distance(a, b) {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i), twoBack
  for (let i = 1; i <= a.length; i++) {
    const next = [i]
    for (let j = 1; j <= b.length; j++) {
      let cost = Math.min(next[j - 1] + 1, previous[j] + 1, previous[j - 1] + Number(a[i - 1] !== b[j - 1]))
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) cost = Math.min(cost, twoBack[j - 2] + 1)
      next.push(cost)
    }
    twoBack = previous; previous = next
  }
  return previous[b.length]
}

export function spellingSuggestions(item, glossary) {
  if (item.terminology) return { terms: item.terms, suggestions: [] }
  const word = item.word.toLowerCase(), cutoff = word.length >= 7 ? 2 : 1
  const matches = []
  for (const [key, entry] of glossary?.words || []) {
    if (Math.abs(key.length - word.length) > cutoff) continue
    const score = distance(word, key)
    if (score <= cutoff) matches.push({ score, label: `${entry.phrase}（${entry.meaning}）` })
  }
  matches.sort((a, b) => a.score - b.score || a.label.localeCompare(b.label))
  checker ||= nspell(aff, dic)
  return { terms: [...new Set(matches.map(match => match.label))].slice(0, 5), suggestions: checker.suggest(item.word).slice(0, 6) }
}

function terminologyHits(source, glossary, max) {
  const hits = []
  if (!glossary?.matchers.size) return hits
  for (let index = 0; index < source.length && hits.length < max; index++) {
    const matcher = glossary.matchers.get(source[index])
    if (!matcher) continue
    matcher.pattern.lastIndex = index
    const found = matcher.pattern.exec(source)?.[0]
    if (!found) continue
    hits.push({ word: found, from: index, to: index + found.length, terminology: true, terms: matcher.group.get(found) })
    index += found.length - 1
  }
  return hits
}

export function checkSpelling(source, limit = 100, glossary) {
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
  const finish = (truncated, checkedCharacters, limitReason) => ({
    items, terminology: terminologyHits(mask.slice(0, checkedCharacters), glossary, limit),
    truncated, checkedWords, checkedCharacters, ...(limitReason ? { limitReason } : {}),
  })
  for (const match of mask.matchAll(/\b[A-Za-z][A-Za-z']{2,}\b/g)) {
    if (checkedWords >= MAX_WORDS) return finish(true, match.index, 'words')
    checkedWords++
    const word = match[0]
    if (word.length > 80) continue // Long identifiers are not ordinary prose words.
    if (checker.correct(word) || glossary?.words.has(word.toLowerCase())) continue
    items.push({ word, from: match.index, to: match.index + word.length })
    if (items.length >= limit) return finish(true, match.index + word.length, 'results')
  }
  return finish(clipped, source.length, clipped ? 'characters' : undefined)
}
