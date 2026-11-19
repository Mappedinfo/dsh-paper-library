// Visual editing is a projection of the original text, never an HTML → TeX conversion.
const formats = { textbf: 'bold', textit: 'italic', emph: 'italic', underline: 'underline', texttt: 'code', textnormal: 'normal' }
const levels = { part: 1, chapter: 1, section: 2, subsection: 3, subsubsection: 4, paragraph: 5, subparagraph: 6 }
const citations = new Set(['cite', 'citep', 'citet', 'parencite', 'textcite', 'autocite', 'footcite', 'supercite', 'smartcite'])
const rawEnvironments = new Set(['verbatim', 'Verbatim', 'lstlisting', 'minted', 'tikzpicture', 'comment', 'filecontents', 'filecontents*'])
const mathEnvironments = new Set(['equation', 'equation*', 'align', 'align*', 'gather', 'gather*', 'displaymath'])
const escaped = (source, at) => { let n = 0; while (at > 0 && source[--at] === '\\') n++; return n % 2 === 1 }
export function texGroup(source, at, end = source.length, open = '{', close = '}') {
  if (source[at] !== open) return null
  let depth = 1
  for (let i = at + 1; i < end; i++) {
    if (escaped(source, i)) continue
    if (source[i] === '%') { const next = source.indexOf('\n', i); if (next < 0) return null; i = next; continue }
    if (source[i] === open) depth++
    if (source[i] === close && --depth === 0) return { from: at, start: at + 1, end: i, to: i + 1 }
  }
  return null
}
const space = (s, at, end) => { while (at < end && /\s/.test(s[at])) at++; return at }
function argument(s, at, end) {
  at = space(s, at, end)
  while (s[at] === '[') { const option = texGroup(s, at, end, '[', ']'); if (!option) return null; at = space(s, option.to, end) }
  return texGroup(s, at, end)
}
function closing(s, token, at, end) {
  for (let i = s.indexOf(token, at); i >= 0 && i < end; i = s.indexOf(token, i + token.length)) {
    if (!escaped(s, i)) return i
  }
  return -1
}

/** Bounded, conservative projection. Unknown commands and incomplete groups stay editable as source. */
export function visualPlan(source) {
  const nodes = [], wrappers = [], limit = 12000
  let bounded = source.length > 1024 * 1024
  if (bounded) return { nodes, wrappers, bounded }
  const add = node => { if (nodes.length < limit) nodes.push(node); else bounded = true }
  const hide = (from, to) => { if (to > from) add({ kind: 'hide', from, to }) }
  let body = 0
  // Find the document boundary through the same scanner so commented examples cannot hide real prose.
  const findBody = () => {
    for (let i = 0; i < source.length;) {
      if (source[i] === '%' && !escaped(source, i)) { i = source.indexOf('\n', i); if (i < 0) return 0; continue }
      if (source[i] !== '\\') { i++; continue }
      const command = /^\\([A-Za-z]+)\*?/.exec(source.slice(i, i + 80))
      if (!command) { i += 2; continue }
      const arg = argument(source, i + command[0].length, source.length)
      if (command[1] === 'begin' && arg && source.slice(arg.start, arg.end) === 'document') return arg.to
      if (command[1] === 'begin' && arg && rawEnvironments.has(source.slice(arg.start, arg.end))) {
        const close = `\\end{${source.slice(arg.start, arg.end)}}`, stop = source.indexOf(close, arg.to)
        if (stop < 0) return 0
        i = stop + close.length
      } else if (arg) {
        i = arg.to
        while (true) { const next = argument(source, i, source.length); if (!next) break; i = next.to }
      } else i += command[0].length
    }
    return 0
  }
  body = findBody()
  if (body) add({ kind: 'preamble', from: 0, to: body })
  function scan(start, end, depth = 0) {
    if (depth > 24) { bounded = true; return }
    const lists = []
    for (let i = start; i < end && !bounded;) {
      if (source[i] === '%' && !escaped(source, i)) {
        const next = source.indexOf('\n', i), to = next < 0 ? end : Math.min(next, end)
        add({ kind: 'mark', style: 'comment', from: i, to }); i = to; continue
      }
      const delimiter = source.startsWith('$$', i) ? '$$' : source[i] === '$' ? '$' : source.startsWith('\\(', i) ? '\\(' : source.startsWith('\\[', i) ? '\\[' : null
      if (delimiter && !escaped(source, i)) {
        const close = delimiter === '\\(' ? '\\)' : delimiter === '\\[' ? '\\]' : delimiter
        const to = closing(source, close, i + delimiter.length, end)
        if (to >= 0) { add({ kind: 'math', from: i, to: to + close.length, content: source.slice(i + delimiter.length, to), display: delimiter === '$$' || delimiter === '\\[' }); i = to + close.length; continue }
      }
      if (source[i] !== '\\') { i++; continue }
      const match = /^\\([A-Za-z]+)(\*)?/.exec(source.slice(i, i + 80))
      if (!match) {
        if (/[%&#_$ {}]/.test(source[i + 1] || '\0')) { hide(i, i + 1); i += 2 }
        else i += 2
        continue
      }
      const name = match[1], commandEnd = i + match[0].length, arg = argument(source, commandEnd, end)
      if ((name === 'begin' || name === 'end') && arg) {
        const env = source.slice(arg.start, arg.end)
        if (name === 'begin' && (rawEnvironments.has(env) || mathEnvironments.has(env))) {
          const close = `\\end{${env}}`, stop = source.indexOf(close, arg.to)
          if (stop < 0) { i = end; continue }
          if (mathEnvironments.has(env)) add({ kind: 'math', from: i, to: stop + close.length,
            content: /^(align|gather)/.test(env) ? `\\begin{${env.startsWith('align') ? 'aligned' : 'gathered'}}${source.slice(arg.to, stop)}\\end{${env.startsWith('align') ? 'aligned' : 'gathered'}}` : source.slice(arg.to, stop), display: true })
          i = stop + close.length; continue
        }
        if (['document', 'abstract', 'itemize', 'enumerate', 'quote', 'quotation', 'center'].includes(env)) {
          if (name === 'begin' && /^(itemize|enumerate)$/.test(env)) lists.push({ env, count: 0 })
          if (name === 'end' && lists.at(-1)?.env === env) lists.pop()
          if (name === 'begin' && env === 'abstract') add({ kind: 'label', from: i, to: arg.to, text: 'Abstract' })
          else hide(i, arg.to)
          i = arg.to; continue
        }
      }
      if (name === 'item' && lists.length) {
        const list = lists.at(-1); list.count++
        const optionAt = space(source, commandEnd, end), option = texGroup(source, optionAt, end, '[', ']')
        add({ kind: 'label', from: i, to: option?.to || commandEnd, text: option ? source.slice(option.start, option.end) : list.env === 'enumerate' ? `${list.count}.` : '•' })
        add({ kind: 'line', from: source.lastIndexOf('\n', i - 1) + 1, style: 'list' }); i = option?.to || commandEnd; continue
      }
      if (arg && (formats[name] || levels[name])) {
        const style = formats[name] || `heading-${levels[name]}`
        wrappers.push({ name, style, from: i, to: arg.to, start: arg.start, end: arg.end })
        hide(i, arg.start); hide(arg.end, arg.to)
        if (arg.end > arg.start) add({ kind: 'mark', from: arg.start, to: arg.end, style })
        if (levels[name]) add({ kind: 'line', from: source.lastIndexOf('\n', i - 1) + 1, style: 'heading' })
        scan(arg.start, arg.end, depth + 1); i = arg.to; continue
      }
      if (arg && citations.has(name)) { add({ kind: 'citation', from: i, to: arg.to, text: `[${source.slice(arg.start, arg.end)}]` }); i = arg.to; continue }
      if (name === 'maketitle') {
        const titleMatch = /\\title\s*\{/.exec(source.slice(0, body)), group = titleMatch && texGroup(source, titleMatch.index + titleMatch[0].length - 1)
        if (group) add({ kind: 'title', from: i, to: commandEnd, text: source.slice(group.start, group.end) })
        i = commandEnd; continue
      }
      // An unknown macro may interpret its arguments differently. Leave the whole invocation alone.
      i = arg?.to || commandEnd
      if (arg) { let next; while ((next = argument(source, i, end))) i = next.to }
    }
  }
  scan(body, source.length)
  return { nodes, wrappers, bounded }
}

/** One undoable source transaction for each formatting action, including toggling nested wrappers. */
export function formatEdit(source, from, to, kind) {
  const names = { bold: 'textbf', italic: 'emph', underline: 'underline', code: 'texttt', heading: 'section' }, name = names[kind]
  if (!name || from < 0 || to < from || to > source.length) return null
  const plan = visualPlan(source)
  if (plan.nodes.some(node => ['preamble', 'math', 'citation'].includes(node.kind) && from < node.to && to >= node.from)) return null
  const wrapper = plan.wrappers.filter(w => (w.style === kind || (kind === 'heading' && w.style.startsWith('heading-'))) &&
    ((w.start <= from && w.end >= to) || (w.from === from && w.to === to))).sort((a, b) => (a.to - a.from) - (b.to - b.from))[0]
  if (wrapper) return {
    changes: [{ from: wrapper.from, to: wrapper.start, insert: '' }, { from: wrapper.end, to: wrapper.to, insert: '' }],
    selection: { anchor: Math.max(wrapper.from, from - (wrapper.start - wrapper.from)), head: Math.min(wrapper.end, to) - (wrapper.start - wrapper.from) },
  }
  // Wrapping partial commands or unbalanced groups would corrupt the surrounding TeX.
  const selected = source.slice(from, to)
  let balance = 0
  for (let i = 0; i < selected.length; i++) {
    if (escaped(selected, i)) continue
    if (selected[i] === '%') return null
    if (selected[i] === '{') balance++
    if (selected[i] === '}' && --balance < 0) return null
  }
  if (balance || /\\[A-Za-z]*$/.test(source.slice(0, from)) || /^[A-Za-z]+/.test(source.slice(to)) && /\\[A-Za-z]+$/.test(source.slice(0, to))) return null
  if (kind === 'heading') {
    if (from === to) { from = source.lastIndexOf('\n', from - 1) + 1; const next = source.indexOf('\n', to); to = next < 0 ? source.length : next }
    if (source.slice(from, to).includes('\n')) return null
  }
  const prefix = `\\${name}{`
  return { changes: [{ from, to, insert: prefix + source.slice(from, to) + '}' }], selection: { anchor: from + prefix.length, head: to + prefix.length } }
}
