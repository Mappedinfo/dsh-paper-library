import dagre from '../../vendor/paper-flow/core/dagre.min.js'

const idOf = port => port.split(':')[0]
const key = node => node.id

/** 只按显式分组、模块属性路径、循环包含关系与函数名识别边界。 */
function moduleGroups(flow, source, boxes) {
  const rows = [], full = new Map(source.nodes.map(n => [n.id, n]))
  function add(label, ids, whole = false) {
    const members = new Set(ids)
    if (members.size < 2 || rows.some(g => g.members.size === members.size && [...members].every(id => g.members.has(id)))) return
    rows.push({ label, members, whole })
  }
  function project(members) {
    const ids = new Set(members)
    return flow.nodes.filter(n => (n.config?.members || [n.id]).every(id => ids.has(id))).map(key)
  }
  for (const group of source.paper_groups || []) add(group.label, project(group.members))
  for (const stage of source.stages || []) add(stage.title, project(source.nodes.filter(n => n.stage === stage.id).map(key)))
  const modules = new Map()
  for (const node of source.nodes) {
    const parts = node.config?.attribute?.split('.') || []
    for (let i = 1; i < Math.min(parts.length, 4); i++) {
      const prefix = parts.slice(0, i).join('.')
      if (!modules.has(prefix)) modules.set(prefix, [])
      modules.get(prefix).push(node.id)
    }
    const parent = full.get(node.config?.enclosing_node)
    if (parent?.op === 'loop' && node.op !== 'loop_exit') {
      const label = 'loop:' + parent.id
      if (!modules.has(label)) modules.set(label, [])
      modules.get(label).push(node.id)
    }
  }
  // Add、切片等无属性名的中间算子，仅在其最近下游归于同一模块且上游含本模块时纳入。
  const next = new Map(source.nodes.map(n => [n.id, []])), prev = new Map(source.nodes.map(n => [n.id, []]))
  for (const edge of source.edges) {
    const a = idOf(edge.from), b = idOf(edge.to)
    next.get(a)?.push(b); prev.get(b)?.push(a)
  }
  function anchors(id, direction) {
    const queue = [...direction.get(id)], seen = new Set(), result = []
    for (let i = 0; i < queue.length; i++) {
      const other = queue[i]
      if (seen.has(other)) continue
      seen.add(other)
      const n = full.get(other)
      if (n.config?.attribute || n.type === 'data' || n.type === 'output') result.push(other)
      else queue.push(...direction.get(other))
    }
    return result
  }
  const operators = source.nodes.filter(n => !n.config?.attribute && ['method', 'representation'].includes(n.type) && n.config?.resolution !== 'unresolved')
  const nearest = new Map(operators.map(n => [n.id, { before: anchors(n.id, prev), after: anchors(n.id, next) }]))
  for (const [label, members] of modules) {
    if (label.startsWith('loop:')) continue
    const module = new Set(members)
    for (const [id, { before, after }] of nearest)
      if (after.length && after.every(n => module.has(n)) && before.some(n => module.has(n))) members.push(id)
  }
  for (const [label, members] of modules) add(label.startsWith('loop:') ? 'Loop body' : label, project(members))
  if (source.id === 'network' && /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+$/u.test(source.name)) {
    add(source.name, boxes.filter(box => !box.terminal).map(box => box.node.id), true)
  }
  // 只让互斥或严格嵌套的集合参与排版；相交的另一分类仍在完整流程里可查。
  const groups = []
  for (const row of rows.sort((a, b) => a.members.size - b.members.size)) {
    if (groups.some(g => [...g.members].some(id => row.members.has(id)) && ![...g.members].every(id => row.members.has(id)))) continue
    groups.push(row)
  }
  return groups
}

function labelBox(edge, wrap, length) {
  const lines = wrap(edge.label || '', 11, 98)
  return { edge, lines, width: lines.length ? Math.max(...lines.map(line => length(line, 11))) + 8 : 0, height: lines.length * 14, labelpos: 'c' }
}

// 对确有贯穿全部节点的主链，主链竖直向上，跨层数据及控制连接走独立的侧边通道。
function stackLayout(boxes, edges) {
  if (edges.length > boxes.length + 3) return null
  const items = new Map(boxes.map(box => [box.node.id, { box, degree: 0, after: [] }]))
  for (const edge of edges) {
    const a = items.get(idOf(edge.edge.from)), b = items.get(idOf(edge.edge.to))
    if (!a || !b) throw Error('流程边引用未知节点。')
    a.after.push({ b, edge }); b.degree++
  }
  const queue = [...items.values()].filter(item => !item.degree), order = []
  while (queue.length === 1) {
    const item = queue.pop()
    item.rank = order.length; order.push(item)
    for (const { b } of item.after) if (--b.degree === 0) queue.push(b)
  }
  if (order.length !== items.size) return null
  const mains = [], skips = []
  for (const a of order) for (const { b, edge } of a.after) {
    if (b.rank === a.rank + 1 && !mains[a.rank]) mains[a.rank] = edge
    else skips.push(edge)
  }
  if (skips.length > 4 || mains.length !== Math.max(0, boxes.length - 1)) return null
  const bodyWidth = Math.max(0, ...boxes.filter(n => !n.symbol && !n.terminal).map(n => n.width))
  for (const n of boxes) if (!n.symbol && !n.terminal) n.width = bodyWidth
  let base = 0
  for (let i = order.length - 1; i >= 0; i--) {
    const box = order[i].box
    box.x = 0; box.y = base + box.height / 2
    base += box.height + Math.max(32, (mains[i - 1]?.height || 0) + 16)
  }
  for (const e of mains) {
    const a = items.get(idOf(e.edge.from)).box, b = items.get(idOf(e.edge.to)).box
    e.points = [{ x: 0, y: a.y - a.height / 2 }, { x: 0, y: b.y + b.height / 2 }]
    e.x = e.width / 2 + 6; e.y = (e.points[0].y + e.points[1].y) / 2
  }
  let lane = Math.max(...boxes.map(n => n.width / 2)) + 26
  for (const e of skips) {
    const a = items.get(idOf(e.edge.from)).box, b = items.get(idOf(e.edge.to)).box
    const side = e.edge.kind === 'data' || e.edge.kind === 'candidate' ? -1 : 1
    e.points = [{ x: side * a.width / 2, y: a.y }, { x: side * lane, y: a.y }, { x: side * lane, y: b.y }, { x: side * b.width / 2, y: b.y }]
    e.x = side * (lane + e.width / 2 + 5); e.y = (a.y + b.y) / 2
    lane += 16 + e.width
  }
  return { nodes: boxes, edges }
}

// 两个及以上有源码归属的独立模块可以各占一列。纵向位置取真实依赖的最早层级。
function moduleLanes(boxes, edges, groups) {
  const candidates = groups.filter(g => !g.whole && !groups.some(p => !p.whole && p.members.size > g.members.size && [...g.members].every(id => p.members.has(id))))
  if (candidates.length < 2 || candidates.length > 4) return null
  const nodes = new Map(boxes.map(box => [box.node.id, { box, id: box.node.id, before: [], after: [], rank: 0 }]))
  for (const e of edges) { const a = nodes.get(idOf(e.edge.from)), b = nodes.get(idOf(e.edge.to)); a.after.push(b); b.before.push(a) }
  const reachable = new Map()
  for (const n of nodes.values()) {
    const work = [...n.after], found = new Set()
    for (let i = 0; i < work.length; i++) {
      const next = work[i]
      if (found.has(next.id)) continue
      found.add(next.id); work.push(...next.after)
    }
    reachable.set(n.id, found)
  }
  // 依次串联的子模块仍按主链向上绘制；并排需存在两侧互不依赖的实际步骤。
  for (let i = 0; i < candidates.length; i++) for (const peer of candidates.slice(i + 1)) {
    if (![...candidates[i].members].some(a => [...peer.members].some(b => !reachable.get(a).has(b) && !reachable.get(b).has(a)))) return null
  }
  const fixed = new Map()
  candidates.forEach((g, lane) => { for (const id of g.members) fixed.set(id, lane) })
  function nearest(node, direction) {
    const lanes = new Set(), children = [...node[direction]], seen = new Set()
    for (let i = 0; i < children.length; i++) {
      const child = children[i]
      if (seen.has(child)) continue
      seen.add(child)
      if (fixed.has(child.id)) lanes.add(fixed.get(child.id))
      else children.push(...child[direction])
    }
    return lanes
  }
  const safeOrder = candidates.map((g, i) => ({ lane: i, first: Math.min(...[...g.members].map(id => boxes.findIndex(n => n.node.id === id))) })).sort((a, b) => a.first - b.first)
  const laneOrder = new Map(safeOrder.map((v, i) => [v.lane, i]))
  for (const n of nodes.values()) {
    const downstream = fixed.has(n.id) ? new Set([fixed.get(n.id)]) : nearest(n, 'after')
    const owners = downstream.size ? downstream : nearest(n, 'before')
    n.lane = owners.size ? Math.min(...[...owners].map(o => laneOrder.get(o))) : 0
    n.shared = !n.before.length && owners.size > 1
    n.remaining = n.before.length
  }
  for (const group of candidates) {
    const blocks = [...group.members].map(id => nodes.get(id).box).filter(n => !n.symbol && !n.terminal)
    const bodyWidth = Math.max(0, ...blocks.map(n => n.width))
    for (const block of blocks) block.width = bodyWidth
  }
  const queue = [...nodes.values()].filter(n => !n.remaining)
  for (let i = 0; i < queue.length; i++) {
    const a = queue[i]
    for (const b of a.after) { b.rank = Math.max(b.rank, a.rank + 1); if (--b.remaining === 0) queue.push(b) }
  }
  if (queue.length !== boxes.length) return null
  const rows = [], lanes = candidates.map(() => ({ width: 132, x: 0 }))
  for (const n of queue) {
    rows[n.rank] ||= { height: 0, slots: lanes.map(() => []) }
    const r = rows[n.rank]
    r.height = Math.max(r.height, n.box.height); r.slots[n.lane].push(n)
  }
  const rowWidth = items => items.reduce((sum, n) => sum + n.box.width, 0) + Math.max(0, items.length - 1) * 24
  for (const r of rows) r.slots.forEach((ns, i) => { lanes[i].width = Math.max(lanes[i].width, rowWidth(ns)) })
  let x = 0
  for (const lane of lanes) { lane.x = x + lane.width / 2; x += lane.width + 92 }
  let y = 0
  for (const r of rows.slice().reverse()) {
    r.y = y + r.height / 2; y += r.height + 26
    r.slots.forEach((items, i) => {
      let left = lanes[i].x - rowWidth(items) / 2
      for (const n of items) { n.box.y = r.y; n.box.x = left + n.box.width / 2; left += n.box.width + 24 }
    })
    const all = r.slots.flat()
    if (all.length === 1 && all[0].shared) all[0].box.x = (lanes[0].x + lanes.at(-1).x) / 2
  }
  // 跨模块边的两个端点对齐已知的依赖层级，其间各列的留白均匀分配。
  for (let lane = 0; lane < lanes.length; lane++) {
    const occupied = rows.map((row, rank) => ({ rank, boxes: row.slots[lane] })).filter(r => r.boxes.length)
    const anchors = occupied.map((r, i) => i === 0 || i === occupied.length - 1 ||
      r.boxes.some(n => n.before.concat(n.after).some(other => other.lane !== lane)))
    let start = 0
    for (let i = 1; i < occupied.length; i++) {
      if (!anchors[i]) continue
      const block = occupied.slice(start, i + 1)
      const h = block.map(r => Math.max(...r.boxes.map(n => n.box.height)))
      let top = block.at(-1).boxes[0].box.y - h.at(-1) / 2
      const span = block[0].boxes[0].box.y + h[0] / 2 - top
      const gap = (span - h.reduce((a, b) => a + b, 0)) / (block.length - 1)
      for (let j = block.length - 1; j >= 0; j--) {
        for (const n of block[j].boxes) n.box.y = top + h[j] / 2
        top += h[j] + gap
      }
      start = i
    }
  }
  const tracks = new Map()
  function track(name, a, b) {
    if (!tracks.has(name)) tracks.set(name, [])
    const rails = tracks.get(name)
    let i = rails.findIndex(intervals => intervals.every(([lo, hi]) => hi < a || lo > b))
    if (i < 0) { i = rails.length; rails.push([]) }
    rails[i].push([a, b]); return i
  }
  const at = (x, y) => ({ x, y })
  for (const e of edges) {
    const a = nodes.get(idOf(e.edge.from)), b = nodes.get(idOf(e.edge.to)), p = a.box, q = b.box
    const start = at(p.x, p.y - p.height / 2), end = at(q.x, q.y + q.height / 2)
    if (a.shared) {
      const mid = start.y - 9
      e.points = [start, at(start.x, mid), at(end.x, mid), end]
    } else if (a.lane !== b.lane) {
      const sign = Math.sign(q.x - p.x) || 1
      start.x = p.x + sign * p.width / 2; start.y = p.y
      end.x = q.x - sign * q.width / 2; end.y = q.y
      const gap = lanes[Math.min(a.lane, b.lane)]
      const rail = gap.x + gap.width / 2 + 30 + 8 * track('bridge-' + Math.min(a.lane, b.lane), a.rank, b.rank)
      e.points = [start, at(rail, start.y), at(rail, end.y), end]
    } else if (b.rank > a.rank + 1) {
      const sign = a.lane === 0 ? -1 : 1, lane = lanes[a.lane]
      const rail = lane.x + sign * (lane.width / 2 + 22 + 10 * track('side-' + a.lane, a.rank, b.rank))
      start.x = p.x + sign * p.width / 2; start.y = p.y
      end.x = q.x + sign * q.width / 2; end.y = q.y
      e.points = [start, at(rail, start.y), at(rail, end.y), end]
    } else if (Math.abs(p.x - q.x) < 1) {
      e.points = [start, end]
    } else {
      const middle = (start.y + end.y) / 2
      e.points = [start, at(start.x, middle), at(end.x, middle), end]
    }
    const point = e.points[Math.floor((e.points.length - 1) / 2)]
    e.x = point.x + e.width / 2 + 5; e.y = (start.y + end.y) / 2
  }
  return { nodes: boxes, edges }
}

function distributedLayout(boxes, edges, groups) {
  const g = new dagre.graphlib.Graph({ multigraph: true, compound: true })
  g.setGraph({ rankdir: 'BT', ranksep: 30, nodesep: 35, edgesep: 12, marginx: 8, marginy: 8 })
  g.setDefaultEdgeLabel(() => ({}))
  const ids = new Map(boxes.map((n, i) => [n.node.id, String(i)]))
  boxes.forEach(n => g.setNode(ids.get(n.node.id), n))
  groups.forEach((group, i) => {
    const gId = 'module-' + i
    g.setNode(gId, { label: group.label })
    for (const id of group.members) if (!g.parent(ids.get(id))) g.setParent(ids.get(id), gId)
    groups.slice(0, i).forEach((sub, j) => {
      if (!g.parent('module-' + j) && [...sub.members].every(id => group.members.has(id))) g.setParent('module-' + j, gId)
    })
  })
  edges.forEach((e, i) => {
    const a = ids.get(idOf(e.edge.from)), b = ids.get(idOf(e.edge.to))
    if (a === undefined || b === undefined) throw Error('流程边引用未知节点。')
    g.setEdge(a, b, e, String(i))
  })
  dagre.layout(g)
  // 在圆形运算节点处，将矩形包围盒上的交点投影回圆周。
  for (const e of edges) for (const [port, j] of [[e.edge.from, 0], [e.edge.to, e.points.length - 1]]) {
    const n = g.node(ids.get(idOf(port)))
    if (!n.symbol) continue
    const p = e.points[j], dx = p.x - n.x, dy = p.y - n.y, norm = Math.hypot(dx, dy)
    if (norm) e.points[j] = { x: n.x + n.width * dx / (2 * norm), y: n.y + n.height * dy / (2 * norm) }
  }
  return { nodes: boxes, edges }
}

function boundaries(graph, groups) {
  const placed = []
  for (const group of groups) {
    const parts = graph.nodes.filter(n => group.members.has(n.node.id)).map(n => ({ x: n.x, y: n.y, width: n.width, height: n.height }))
    const children = placed.filter(g => [...g.members].every(id => group.members.has(id)))
    parts.push(...children)
    for (const e of graph.edges) {
      if (!group.members.has(idOf(e.edge.from)) || !group.members.has(idOf(e.edge.to))) continue
      parts.push(...e.points.map(p => ({ ...p, width: 0, height: 0 })))
      if (e.lines.length) parts.push(e)
    }
    const pad = group.whole ? 16 : 12
    const left = Math.min(...parts.map(p => p.x - p.width / 2)) - pad, right = Math.max(...parts.map(p => p.x + p.width / 2)) + pad
    const top = Math.min(...parts.map(p => p.y - p.height / 2)) - pad - (group.whole ? 0 : 9), bottom = Math.max(...parts.map(p => p.y + p.height / 2)) + pad
    // 仅在框内没有非成员时绘出边界，避免把其他分支误归此组。
    if (graph.nodes.some(n => !group.members.has(n.node.id) && n.x + n.width / 2 > left && n.x - n.width / 2 < right && n.y + n.height / 2 > top && n.y - n.height / 2 < bottom)) continue
    placed.push({ ...group, x: (left + right) / 2, y: (top + bottom) / 2, width: right - left, height: bottom - top })
  }
  return placed.reverse()
}

export function architectureLayout(flow, source, nodeBox, wrap, length) {
  const original = new Map(source.nodes.map(n => [n.id, n]))
  const nodes = flow.nodes.map(node => {
    const member = node.config?.members?.length === 1 && original.get(node.config.members[0])
    return nodeBox(member ? { ...node, op: member.op, config: { ...member.config, ...node.config } } : node)
  }), edges = flow.edges.map(e => labelBox(e, wrap, length))
  const groups = moduleGroups(flow, source, nodes)
  const parallel = moduleLanes(nodes, edges, groups)
  const layoutGroups = parallel ? groups.filter(g => !g.whole) : groups
  const drawing = parallel || stackLayout(nodes, edges) || distributedLayout(nodes, edges, layoutGroups.filter(g => !g.whole))
  return { ...drawing, groups: boundaries(drawing, layoutGroups) }
}
