import { architectureLayout } from './eqtrace-architecture.mjs'
import { parseFlowInput } from '../../vendor/paper-flow/document.js'

const ink = '#161616'
const font = 'Helvetica, Arial, Noto Sans CJK SC, sans-serif'
const palette = {
  embedding: '#f9dce2', attention: '#ffe4b8', projection: '#dedff3', normalization: '#f4efb8',
  transform: '#cbeaf4', activation: '#e2efce', control: '#f1edce', parameter: '#ecdfef', unknown: '#f1f1f1',
}

const xml = value => String(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/gu, '').replace(/[&<>"']/gu, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[ch])
const px = n => Number(n.toFixed(2))
const length = (text, size) => [...text].reduce((sum, c) => sum + (/[^\x00-\xff]/u.test(c) ? 1.02 : /[MW@%]/u.test(c) ? .94 : /[A-Z]/u.test(c) ? .76 : /[il .,:;!'|]/u.test(c) ? .32 : .62) * size, 0)
function wrap(text, size, maxWidth) {
  const lines = []
  for (const paragraph of String(text).split(/\r?\n/u)) {
    let line = ''
    for (const token of paragraph.match(/\s+|[A-Za-z0-9_]+|[^\sA-Za-z0-9_]/gu) || []) {
      if (line.trim() && length(line + token, size) > maxWidth) { lines.push(line.trim()); line = '' }
      if (!line && !token.trim()) continue
      for (const char of token) {
        if (line && length(line + char, size) > maxWidth) { lines.push(line.trim()); line = '' }
        line += char
      }
    }
    if (line.trim()) lines.push(line.trim())
  }
  return lines
}

function textLines(lines, x, y, leading, attributes) {
  return lines.map((line, i) => `<text x="${px(x)}" y="${px(y + i * leading)}" ${attributes}>${xml(line)}</text>`).join('')
}

function operationNote(node) {
  const op = typeof node.op === 'string' ? node.op.split('.').at(-1) : ''
  const parameters = node.config?.parameters || {}
  const pairs = [['in_features', 'out_features'], ['in_channels', 'out_channels'], ['input_size', 'hidden_size'], ['num_embeddings', 'embedding_dim']]
  const dimensions = pairs.find(([a, b]) => parameters[a] != null && parameters[b] != null)
  const value = v => Array.isArray(v) ? v.join('×') : String(v)
  const notes = []
  if (node.type === 'model' && op && !/^[a-z_]+$/u.test(op) && !node.label.toLowerCase().includes(op.toLowerCase())) notes.push(op)
  if (dimensions) notes.push(dimensions.map(key => value(parameters[key])).join(' → '))
  if (parameters.kernel_size != null) notes.push(`k=${value(parameters.kernel_size)}`)
  if (parameters.stride != null) notes.push(`s=${value(parameters.stride)}`)
  return notes.join(' · ')
}

function nodeBox(node) {
  const op = (node.op || '').split('.').at(-1), attribute = node.config?.attribute || ''
  const unresolved = node.config?.resolution === 'unresolved' || op === 'unresolved'
  const symbols = { Add: '+', add: '+', Mult: '×', mul: '×', Sub: '−', sub: '−' }
  const symbol = (!node.config?.members || node.config.members.length === 1) && Object.hasOwn(symbols, op) ? symbols[op] : ''
  const terminal = ['input', 'return', 'definition'].includes(op) && !unresolved
  let label = node.label, note = '', role = 'transform'
  const parts = node.label.split(' · ')
  if (node.type === 'model' && attribute && op) {
    label = op === 'MultiheadAttention' ? 'Multi-head attention' : op === 'LayerNorm' ? 'Layer norm' : op === 'Embedding' ? 'Embedding' : op
    const identifier = attribute.split('.').at(-1)
    if (op === 'MultiheadAttention' && ['self_attention', 'cross_attention'].includes(identifier))
      label = identifier === 'cross_attention' ? 'Cross-attention' : 'Self-attention'
    if (node.config.parameters?.num_heads != null) note = `${node.config.parameters.num_heads} heads`
    else note = operationNote(node)
    if (op === 'Embedding') note = [attribute.replace(/_/gu, ' '), note].filter(Boolean).join(' · ')
  } else if (parts.length > 1 && !node.config?.members) {
    label = parts[0]; note = parts.slice(1).join(' · ')
  } else if (label.startsWith('torch.') && !unresolved) {
    label = label.split('.').at(-1)
  }
  if (!note && node.config?.parameters) note = operationNote(node)
  if (/attention/iu.test(op)) role = 'attention'
  else if (/embed/iu.test(op)) role = 'embedding'
  else if (/norm/iu.test(op)) role = 'normalization'
  else if (/^(linear|projection)$/iu.test(op)) role = 'projection'
  else if (/softmax|relu|gelu|sigmoid|tanh/iu.test(op)) role = 'activation'
  else if (unresolved) role = 'unknown'
  else if (node.type === 'decision' || /checks?|guard|loop|branch|wait|exit/iu.test(op)) role = 'control'
  else if (/optim|grad|backward/iu.test(op)) role = 'projection'
  else if (/loss|score|save/iu.test(op)) role = 'activation'
  else if (node.type === 'data' && !terminal) role = 'parameter'
  if (symbol) return { node, symbol, terminal: false, role, unresolved, width: 24, height: 24, lines: [], detail: [] }
  const lines = wrap(label, 16, 170), detail = wrap(note, 12, 170)
  const width = Math.ceil(Math.max(terminal ? 65 : 126, ...lines.map(s => length(s, 16) + 22), ...detail.map(s => length(s, 12) + 22)))
  return { node, role, terminal, unresolved, lines, detail, width, height: (terminal ? 8 : 13) + lines.length * 19 + detail.length * 15 }
}

function drawNode(box) {
  const { x, y, width, height, lines, detail, role, terminal, symbol, unresolved, node } = box
  const left = px(x - width / 2), top = px(y - height / 2)
  const shape = symbol ? `<circle cx="${px(x)}" cy="${px(y)}" r="${width / 2}" fill="white" stroke="${ink}" stroke-width="1.9"/><text x="${px(x)}" y="${px(y + 6)}" text-anchor="middle" font-size="21" fill="${ink}">${xml(symbol)}</text>` :
    `<rect x="${left}" y="${top}" width="${width}" height="${height}" rx="4" fill="${terminal ? '#fff' : palette[role]}"${terminal ? ' fill-opacity="0"' : ''} stroke="${terminal ? 'none' : ink}" stroke-width="1.85"${unresolved ? ' stroke-dasharray="4 3"' : ''}/>${textLines(lines, x, top + (terminal ? 18 : 22), 19, `font-size="16" text-anchor="middle" fill="${ink}"`)}${textLines(detail, x, top + 21 + lines.length * 19 - 3, 15, 'font-size="12" text-anchor="middle" fill="#343434"')}`
  return `<g data-node="${xml(node.id)}" data-shape="${symbol ? 'operator' : terminal ? 'terminal' : role}" data-x="${px(x)}" data-y="${px(y)}"><title>${xml(node.label)}</title>${shape}</g>`
}

// Dagre 的 graph.width/height 只反映部分几何；长跨边的折点可能落在负坐标。
function fitDrawing(drawing) {
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity
  function include(x, y, width = 0, height = 0) {
    left = Math.min(left, x - width / 2); right = Math.max(right, x + width / 2)
    top = Math.min(top, y - height / 2); bottom = Math.max(bottom, y + height / 2)
  }
  for (const box of [...drawing.nodes, ...drawing.groups]) include(box.x, box.y, box.width, box.height)
  for (const edge of drawing.edges) {
    for (const point of edge.points) include(point.x, point.y)
    if (edge.lines.length) include(edge.x, edge.y, edge.width, edge.height)
  }
  const pad = 8
  return { ...drawing, width: right - left + 2 * pad, height: bottom - top + 2 * pad,
    shiftX: pad - left, shiftY: pad - top }
}

function edgeGeometry(points) {
  // 侧连接用圆角折线，三角箭头直接写入矢量文件，兼容不渲染 marker 的预览器。
  const clean = points.filter((p, i) => !i || Math.hypot(p.x - points[i - 1].x, p.y - points[i - 1].y) > .03)
  const pos = p => `${px(p.x)} ${px(p.y)}`
  if (clean.length < 2) return { path: '', arrow: '' }
  let path = `M${pos(clean[0])}`
  for (let i = 1; i < clean.length - 1; i++) {
    const a = clean[i - 1], b = clean[i], c = clean[i + 1]
    const u = Math.hypot(a.x - b.x, a.y - b.y), v = Math.hypot(c.x - b.x, c.y - b.y)
    const r = Math.min(6, u / 3, v / 3)
    const near = (n, len) => ({ x: b.x + (n.x - b.x) * r / len, y: b.y + (n.y - b.y) * r / len })
    path += ` L${pos(near(a, u))} Q${pos(b)} ${pos(near(c, v))}`
  }
  const end = clean.at(-1), before = clean.at(-2)
  const distance = Math.hypot(end.x - before.x, end.y - before.y)
  const dx = (end.x - before.x) / distance, dy = (end.y - before.y) / distance
  const tip = { x: end.x - dx * .7, y: end.y - dy * .7 }
  const back = { x: tip.x - 7 * dx, y: tip.y - 7 * dy }
  const left = { x: back.x - 3.6 * dy, y: back.y + 3.6 * dx }, right = { x: back.x + 3.6 * dy, y: back.y - 3.6 * dx }
  return { path: path + ` L${pos(end)}`, arrow: `${pos(tip)} ${pos(left)} ${pos(right)}` }
}

export function eqTraceFlows(document) {
  if (!document?.paper?.id?.startsWith('eqtrace-')) return []
  return document.flows.filter(flow => flow.id === 'network' || flow.id === 'training')
}

/** 从已校验的单个流程生成独立 SVG；本机脚本、预览和论文导出使用同一实现。 */
export function renderEqTraceFigure(source, { detail = 'overview' } = {}) {
  const overview = detail !== 'full' && source.figure_overview != null
  const flow = overview ? source.figure_overview : source
  if (overview) {
    const checked = parseFlowInput({ schemaVersion: 1, kind: 'paper-flow-document', paper: { id: 'projection', title: 'Stage overview' }, flows: [source] })
    if (!checked.ok) throw Error(`阶段总览无法绘制：${checked.diagnostics[0].message}`)
  }
  if (!flow.nodes.length) throw Error('此流程尚无可绘制节点。')
  const relations = { enter: 'enter', iteration: 'iterate', 'zero-iterations': 'zero iterations', 'last-iteration': 'loop exit', 'condition-true': 'true', 'condition-false': 'false', 'after-launch': 'after launch', 'exception-candidate': 'possible exception' }
  const graph = fitDrawing(architectureLayout({ ...flow, edges: flow.edges.map(edge => ({ ...edge, label: edge.label || (Object.hasOwn(relations, edge.kind) ? relations[edge.kind] : '') })) }, source, nodeBox, wrap, length))
  const styles = new Map([
    ['source-order', { label: 'Source order within a block', color: ink, dash: '' }],
    ['zero-iterations', { label: 'Bypass loop', color: '#474747', dash: '4 3' }],
    ['exception-candidate', { label: 'Possible exception', color: '#474747', dash: '4 3' }],
    ['contains', { label: 'Block containment', color: ink, dash: '1.5 3' }],
    ['candidate', { label: 'Candidate connection', color: '#474747', dash: '5 4' }],
    ['data', { label: 'Data dependency', color: ink, dash: '' }],
  ])
  const declared = new Set(graph.edges.map(({ edge }) => edge.kind))
  const keys = [...styles.keys()].filter(key => declared.has(key))
  const legendRows = keys.some(key => key !== 'data') ? keys.map(key => styles.get(key)) : []
  const legendWidth = Math.max(0, ...legendRows.map(item => length(item.label, 11) + 60))
  const caption = overview ? `Source-derived stage overview · ${flow.nodes.length} groups / ${source.nodes.length} source nodes` : ''
  const captionHeight = caption ? 21 : 0
  const width = Math.ceil(Math.max(graph.width + 22, legendWidth, length(caption, 11) + 22)), height = Math.ceil(graph.height + 18 + captionHeight + legendRows.length * 17)
  const edges = graph.edges.map(({ edge, points, x, y, lines, width: w, height: h }) => {
    const { path, arrow } = edgeGeometry(points)
    const style = styles.get(edge.kind) || { color: ink, dash: '' }
    const dash = style.dash ? ` stroke-dasharray="${style.dash}"` : ''
    const label = lines.length ? `<rect x="${px(x - w / 2)}" y="${px(y - h / 2)}" width="${px(w)}" height="${h}" fill="white"/>${textLines(lines, x, y - h / 2 + 11, 14, 'text-anchor="middle" font-size="11" fill="#42525b"')}` : ''
    return `<g data-edge="${xml(edge.id)}"><title>${xml(edge.label || edge.kind || '依赖')}</title><path d="${path}" fill="none" stroke="${style.color}" stroke-width="1.65" stroke-linejoin="round" ${dash}/><polygon points="${arrow}" fill="${style.color}"/>${label}</g>`
  }).join('')
  function groupLabel(g) {
    const label = g.label.split('.').at(-1).replace(/_/gu, ' ')
    if (length(label, 10) <= g.width - 12) return label
    return wrap(label, 10, g.width - 24)[0] + '…'
  }
  const groups = graph.groups.map(g => `<g data-module="${xml(g.label)}"><title>${xml(g.label)}</title><rect x="${px(g.x - g.width / 2)}" y="${px(g.y - g.height / 2)}" width="${px(g.width)}" height="${px(g.height)}" rx="12" fill="${g.whole ? '#f5f5f5' : '#eeeeee'}" stroke="#373737" stroke-width="${g.whole ? 1.6 : 1.35}"/>${g.whole ? '' : `<text x="${px(g.x - g.width / 2 + 6)}" y="${px(g.y - g.height / 2 + 12)}" font-size="10" fill="#484848">${xml(groupLabel(g))}</text>`}</g>`).join('')
  const legend = legendRows.map(({ color, dash, label }, i) => {
    const y = px(graph.height + captionHeight + 23 + i * 17)
    return `<path d="M14 ${y}h25" stroke="${color}" stroke-width="1.4"${dash ? ` stroke-dasharray="${dash}"` : ''}/><text x="46" y="${y + 4}" font-size="11" fill="#42525b">${xml(label)}</text>`
  }).join('')
  // 复杂拓扑保留足够的物理画幅；缩小到版心时可在宿主看到尺寸与缩放提示。
  const paperWidth = Math.max(56, Math.min(180, width * .265), width * .22)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${px(paperWidth)}mm" height="${px(paperWidth * height / width)}mm" viewBox="0 0 ${width} ${height}" role="img" font-family="${font}"><title>${xml(flow.name)}</title><rect width="${width}" height="${height}" fill="#fff"/>${caption ? `<text x="17" y="17" font-size="11" fill="#42525b">${xml(caption)}</text>` : ''}<g transform="translate(${px((width - graph.width) / 2 + graph.shiftX)} ${px(9 + captionHeight + graph.shiftY)})">${groups}${edges}${graph.nodes.map(drawNode).join('')}</g>${legend}</svg>`
}
