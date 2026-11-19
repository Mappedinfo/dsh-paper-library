import dagre from '../../vendor/paper-flow/core/dagre.min.js'
import { parseFlowInput } from '../../vendor/paper-flow/document.js'

const ink = '#263741'
const font = 'Arial, Helvetica, Noto Sans CJK SC, sans-serif'
const styles = {
  data: ['Input', '#f2f7f9', '#486978'],
  representation: ['Representation', '#eef5f6', '#456a71'],
  model: ['Layer', '#e5f1ef', '#275f59'],
  method: ['Operation', '#fff', '#53636c'],
  decision: ['Decision', '#fbf1e1', '#856137'],
  output: ['Output', '#eaf1f7', '#42627e'],
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
  return `<text ${attributes}>${lines.map((line, i) => `<tspan x="${px(x)}" y="${px(y + i * leading)}">${xml(line)}</tspan>`).join('')}</text>`
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
  const style = [...(styles[node.type] || styles.method)]
  if (node.config?.members) style[0] = 'Stage'
  else if (node.type === 'model' && node.op === 'forward') style[0] = 'Model'
  const lines = wrap(node.label, 15, 170)
  const detail = wrap(operationNote(node), 11, 170)
  const width = Math.max(113, ...lines.map(line => length(line, 15) + 26), ...detail.map(line => length(line, 11) + 26))
  return { width: Math.ceil(width), height: 36 + lines.length * 19 + detail.length * 14, lines, detail, style, node }
}

function drawNode(box) {
  const { x, y, width, height, lines, detail, style, node } = box
  const left = px(x - width / 2), top = px(y - height / 2)
  const unresolved = node.config?.resolution === 'unresolved'
  const type = unresolved ? `${style[0]} · unresolved` : style[0]
  return `<g data-node="${xml(node.id)}"><title>${xml(node.label)}</title><rect x="${left}" y="${top}" width="${width}" height="${height}" rx="4" fill="${style[1]}" stroke="${style[2]}" stroke-width="${node.type === 'model' ? 1.6 : 1.15}"${unresolved ? ' stroke-dasharray="5 3"' : ''}/><text x="${left + 12}" y="${top + 16}" font-size="10" font-weight="600" fill="${style[2]}">${xml(type)}</text>${textLines(lines, left + 12, top + 37, 19, `font-size="15" font-weight="600" fill="${ink}"`)}${textLines(detail, left + 12, top + 36 + lines.length * 19, 14, 'font-size="11" fill="#495965"')}</g>`
}

function layoutGraph(flow, direction) {
  const graph = new dagre.graphlib.Graph({ multigraph: true })
  graph.setGraph({ rankdir: direction, ranksep: 32, nodesep: 24, edgesep: 14, marginx: 7, marginy: 7 })
  graph.setDefaultEdgeLabel(() => ({}))
  const ids = new Map(flow.nodes.map((node, i) => [node.id, String(i)]))
  flow.nodes.forEach(node => graph.setNode(ids.get(node.id), nodeBox(node)))
  flow.edges.forEach((edge, i) => {
    const lines = wrap(edge.label || '', 11, 95)
    const a = ids.get(edge.from.split(':')[0]), b = ids.get(edge.to.split(':')[0])
    if (a === undefined || b === undefined) throw Error('流程边引用未知节点。')
    graph.setEdge(a, b, { edge, lines, width: lines.length ? Math.max(...lines.map(line => length(line, 11))) + 8 : 0, height: lines.length * 14, labelpos: 'c' }, String(i))
  })
  dagre.layout(graph)
  return { ...graph.graph(), nodes: graph.nodes().map(id => graph.node(id)), edges: graph.edges().map(id => graph.edge(id)) }
}

// 存在唯一拓扑序且相邻步骤由原边连接时，可把主路径折成两三行。额外连接使用独立通道。
function foldChain(flow) {
  if (flow.nodes.length < 4 || flow.edges.length > flow.nodes.length + 2) return null
  const records = new Map(flow.nodes.map(node => [node.id, { ...nodeBox(node), incoming: 0, outgoing: [] }]))
  for (const edge of flow.edges) {
    const source = records.get(edge.from.split(':')[0]), target = records.get(edge.to.split(':')[0])
    if (!source || !target) return null
    source.outgoing.push({ edge, target }); target.incoming++
  }
  const nodes = [], ready = [...records.values()].filter(n => n.incoming === 0)
  while (ready.length === 1) {
    const current = ready.pop()
    current.index = nodes.length; nodes.push(current)
    for (const { target } of current.outgoing) if (--target.incoming === 0) ready.push(target)
  }
  if (nodes.length !== records.size) return null
  const main = [], extra = []
  for (const a of nodes) for (const { edge, target: b } of a.outgoing) {
    const row = { a, b, edge, lines: wrap(edge.label || '', 11, 86) }
    row.width = row.lines.length ? Math.max(...row.lines.map(text => length(text, 11))) + 8 : 0
    row.height = row.lines.length * 14
    if (b.index === a.index + 1 && !main[a.index]) main[a.index] = row
    else extra.push(row)
  }
  if (extra.length > 3 || main.length !== nodes.length - 1 || !Array.from(main).every(Boolean)) return null
  const cellWidth = Math.max(...nodes.map(n => n.width))
  const gapX = Math.max(32, ...main.map(e => e.width + 12))
  const gapY = Math.max(32, ...main.map(e => e.height + 16)) + extra.length * 15
  const gutter = extra.length ? 15 + extra.length * 9 : 7
  const paperColumns = Math.max(2, Math.floor((840 - 2 * gutter + gapX) / (cellWidth + gapX)))
  const columns = Math.min(4, paperColumns, Math.ceil(Math.sqrt(nodes.length * 1.35)))
  const width = 2 * gutter + columns * cellWidth + (columns - 1) * gapX
  let height = extra.length ? gapY : 7
  for (let i = 0; i < nodes.length; i += columns) {
    const row = nodes.slice(i, i + columns), backward = Math.floor(i / columns) % 2 === 1
    const h = Math.max(...row.map(n => n.height))
    row.forEach((n, j) => {
      const col = backward ? columns - 1 - j : j
      n.x = gutter + cellWidth / 2 + col * (cellWidth + gapX)
      n.y = height + h / 2; n.rowTop = height; n.rowBottom = height + h
    })
    height += h + (i + columns < nodes.length ? gapY : 7)
  }
  for (const e of main) {
    const { a, b } = e, sign = Math.sign(b.x - a.x)
    e.points = sign ? [{ x: a.x + sign * a.width / 2, y: a.y }, { x: b.x - sign * b.width / 2, y: b.y }] : [{ x: a.x, y: a.y + a.height / 2 }, { x: b.x, y: b.y - b.height / 2 }]
    e.x = (e.points[0].x + e.points[1].x) / 2; e.y = (e.points[0].y + e.points[1].y) / 2
  }
  extra.forEach((e, i) => {
    const { a, b } = e, gap = 12 + i * 15 + e.height / 2
    const sameRow = a.rowTop === b.rowTop, adjacentRow = b.index < (Math.floor(a.index / columns) + 2) * columns
    const start = { x: a.x - a.width / 5, y: a.y + (sameRow ? -1 : 1) * a.height / 2 }
    const end = { x: b.x + b.width / 5, y: b.y - b.height / 2 }
    const track = sameRow ? a.rowTop - gap : a.rowBottom + gap
    if (sameRow || adjacentRow) {
      e.points = [start, { x: start.x, y: track }, { x: end.x, y: track }, end]
      e.x = (start.x + end.x) / 2; e.y = track
    } else {
      const rail = 5 + i * 9, approach = b.rowTop - gap
      e.points = [start, { x: start.x, y: track }, { x: rail, y: track }, { x: rail, y: approach }, { x: end.x, y: approach }, end]
      e.x = (rail + end.x) / 2; e.y = approach
    }
  })
  return { nodes, edges: [...main, ...extra], width, height }
}

// Dagre 的 graph.width/height 只反映部分几何；长跨边的折点可能落在负坐标。
function fitDrawing(drawing) {
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity
  function include(x, y, width = 0, height = 0) {
    left = Math.min(left, x - width / 2); right = Math.max(right, x + width / 2)
    top = Math.min(top, y - height / 2); bottom = Math.max(bottom, y + height / 2)
  }
  for (const node of drawing.nodes) include(node.x, node.y, node.width, node.height)
  for (const edge of drawing.edges) {
    for (const point of edge.points) include(point.x, point.y)
    if (edge.lines.length) include(edge.x, edge.y, edge.width, edge.height)
  }
  const pad = 8
  return { ...drawing, width: right - left + 2 * pad, height: bottom - top + 2 * pad,
    shiftX: pad - left, shiftY: pad - top }
}

function balancedLayout(flow) {
  const folded = foldChain(flow)
  if (folded) return fitDrawing(folded)
  const portrait = fitDrawing(layoutGraph(flow, 'TB')), landscape = fitDrawing(layoutGraph(flow, 'LR'))
  const score = layout => Math.max(layout.width, layout.height * 1.45)
  return score(portrait) <= score(landscape) ? portrait : landscape
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
  const graph = balancedLayout({ ...flow, edges: flow.edges.map(edge => ({ ...edge, label: edge.label || (Object.hasOwn(relations, edge.kind) ? relations[edge.kind] : '') })) })
  const styles = new Map([
    ['source-order', { label: 'Source order within a block', color: '#476580', dash: '6 3' }],
    ['zero-iterations', { label: 'Bypass loop', color: '#795c38', dash: '4 3' }],
    ['exception-candidate', { label: 'Possible exception', color: '#795c38', dash: '4 3' }],
    ['contains', { label: 'Block containment', color: '#586b53', dash: '1.5 3' }],
    ['candidate', { label: 'Candidate connection', color: '#795c38', dash: '5 4' }],
    ['data', { label: 'Data dependency', color: '#52636b', dash: '' }],
  ])
  const declared = new Set(graph.edges.map(({ edge }) => edge.kind))
  const keys = [...styles.keys()].filter(key => declared.has(key))
  const legendRows = keys.some(key => key !== 'data') ? keys.map(key => styles.get(key)) : []
  const legendWidth = Math.max(0, ...legendRows.map(item => length(item.label, 11) + 60))
  const caption = overview ? `Source-derived stage overview · ${flow.nodes.length} groups / ${source.nodes.length} source nodes` : ''
  const captionHeight = caption ? 21 : 0
  const width = Math.ceil(Math.max(graph.width + 22, legendWidth, length(caption, 11) + 22)), height = Math.ceil(graph.height + 18 + captionHeight + legendRows.length * 17)
  const edges = graph.edges.map(({ edge, points, x, y, lines, width: w, height: h }) => {
    const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${px(p.x)} ${px(p.y)}`).join(' ')
    const style = styles.get(edge.kind) || { color: '#52636b', dash: '' }
    const dash = style.dash ? ` stroke-dasharray="${style.dash}"` : ''
    const label = lines.length ? `<rect x="${px(x - w / 2)}" y="${px(y - h / 2)}" width="${px(w)}" height="${h}" fill="white"/>${textLines(lines, x, y - h / 2 + 11, 14, 'text-anchor="middle" font-size="11" fill="#42525b"')}` : ''
    return `<g data-edge="${xml(edge.id)}"><title>${xml(edge.label || edge.kind || '依赖')}</title><path d="${path}" fill="none" stroke="${style.color}" stroke-width="1.4" stroke-linejoin="round" marker-end="url(#arrow)"${dash}/>${label}</g>`
  }).join('')
  const legend = legendRows.map(({ color, dash, label }, i) => {
    const y = px(graph.height + captionHeight + 23 + i * 17)
    return `<path d="M14 ${y}h25" stroke="${color}" stroke-width="1.4"${dash ? ` stroke-dasharray="${dash}"` : ''}/><text x="46" y="${y + 4}" font-size="11" fill="#42525b">${xml(label)}</text>`
  }).join('')
  // 复杂拓扑保留足够的物理画幅；缩小到版心时可在宿主看到尺寸与缩放提示。
  const paperWidth = Math.max(56, Math.min(180, width * .265), width * .22)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${px(paperWidth)}mm" height="${px(paperWidth * height / width)}mm" viewBox="0 0 ${width} ${height}" role="img" font-family="${font}"><title>${xml(flow.name)}</title><defs><marker id="arrow" markerWidth="7" markerHeight="7" refX="6.5" refY="3.5" orient="auto" markerUnits="userSpaceOnUse"><path d="M0 0L7 3.5L0 7Z" fill="#52636b"/></marker></defs><rect width="100%" height="100%" fill="#fff"/>${caption ? `<text x="17" y="17" font-size="11" fill="#42525b">${xml(caption)}</text>` : ''}<g transform="translate(${px(11 + graph.shiftX)} ${px(9 + captionHeight + graph.shiftY)})">${edges}${graph.nodes.map(drawNode).join('')}</g>${legend}</svg>`
}
