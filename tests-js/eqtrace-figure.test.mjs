import test from 'node:test'
import assert from 'node:assert/strict'
import { parseFlowInput } from '../vendor/paper-flow/document.js'
import { renderEqTraceFigure } from '../src/paper-flow/eqtrace-figure.mjs'
import { addEqTraceDocument, readEqTraceSource, SOURCE_BYTE_LIMIT } from '../src/paper-flow/eqtrace-import.mjs'

const node = (id, label = id) => ({ id, label, type: 'method', ports: { in: { x: { type: 'tensor' } }, out: { y: { type: 'tensor' } } } })
const edge = (a, b, kind = 'data') => ({ id: `${a}-${b}`, from: `${a}:y`, to: `${b}:x`, kind })
const graph = () => ({ id: 'network', name: 'Branch & merge', nodes: ['a', 'b', 'c', 'd'].map(id => node(id)), edges: [edge('a', 'b'), edge('b', 'c'), edge('c', 'd')] })
const document = flow => ({ schemaVersion: 1, kind: 'paper-flow-document', paper: { id: 'eqtrace-test', title: 'Synthetic' }, flows: [flow] })
const overviewNode = (id, ...members) => ({ ...node(id), config: { members } })

test('publication figure retains all skip paths and evidenced widths, without script, raster or private file paths', () => {
  const f = graph()
  f.nodes[1] = { ...node('b', 'Linear <8>'), type: 'model', op: 'torch.nn.Linear', evidence: '/private/source.py:3', config: { parameters: { in_features: 8, out_features: 16 } } }
  f.nodes[2].label = '<script>alert(1)</script>'
  f.edges.push(edge('a', 'd', 'candidate'))
  const svg = renderEqTraceFigure(f)
  assert.equal((svg.match(/data-node=/gu) || []).length, 4)
  assert.equal((svg.match(/data-edge=/gu) || []).length, 4)
  assert.match(svg, /8 → 16/u)
  assert.match(svg, /Candidate connection/u)
  assert.match(svg, /&lt;script/u)
  assert.doesNotMatch(svg, /<script|<image|<foreignObject|private\/source|NaN/u)
  assert.equal(renderEqTraceFigure(f), svg)
})

test('training figure preserves distinctions between source order, iteration and explicit alternate control paths', () => {
  const f = graph()
  f.id = 'training'
  f.edges = [edge('a', 'b', 'source-order'), edge('b', 'c', 'iteration'), edge('c', 'd', 'last-iteration'), edge('b', 'd', 'zero-iterations')]
  const svg = renderEqTraceFigure(f)
  for (const s of ['Source order within a block', 'iterate', 'loop exit', 'zero iterations']) assert.ok(svg.includes(s), s)
})

test('declared overview follows real source paths through omitted nodes and never creates a shortcut through another displayed group', () => {
  const f = graph()
  f.figure_overview = { id: 'overview', name: 'Overview', nodes: [overviewNode('x', 'a'), overviewNode('y', 'c'), overviewNode('z', 'd')], edges: [edge('x', 'y'), edge('y', 'z')] }
  assert.equal(parseFlowInput(document(f)).ok, true)
  assert.match(renderEqTraceFigure(f), /Source-derived stage overview/u)
  assert.equal((renderEqTraceFigure(f).match(/data-node=/gu) || []).length, 3)
  assert.equal((renderEqTraceFigure(f, { detail: 'full' }).match(/data-node=/gu) || []).length, 4)
  f.figure_overview.edges.push(edge('x', 'z'))
  assert.equal(parseFlowInput(document(f)).diagnostics[0].code, 'overview.path')
  assert.throws(() => renderEqTraceFigure(f), /阶段总览/u)
  f.figure_overview.edges.pop()
  f.figure_overview.nodes[1].config.members = ['a']
  assert.equal(parseFlowInput(document(f)).diagnostics[0].code, 'overview.members')
  f.figure_overview.nodes[1].config.members = ['missing']
  assert.equal(parseFlowInput(document(f)).diagnostics[0].code, 'overview.members')
  f.figure_overview.figure_overview = {}
  assert.equal(parseFlowInput(document(f)).diagnostics[0].code, 'overview.shape')
})

test('reimported documents preserve other documents, duplicate identities, comparison and saved drawing options', () => {
  const source = document(graph())
  const saved = addEqTraceDocument(null, source).workspace
  saved.view.zoom = .8
  saved.selection.right = { ...saved.selection.left }
  const same = addEqTraceDocument(saved, source)
  assert.equal(same.workspace.documents.length, 1)
  const changed = structuredClone(source)
  changed.flows[0].nodes[0].label = 'Changed'
  const added = addEqTraceDocument(saved, changed)
  assert.equal(added.documentId, 'eqtrace-test-2')
  assert.deepEqual(added.workspace.selection, saved.selection)
  assert.deepEqual(added.workspace.view, saved.view)
  assert.equal(saved.documents[0].flows[0].nodes[0].label, 'a')
  assert.equal(addEqTraceDocument(added.workspace, changed).workspace.documents.length, 2)
})

test('source selection checks the extension and size before reading the file', async () => {
  const text = async () => 'pass'
  assert.deepEqual(await readEqTraceSource({ name: 'train.py', size: 4, text }), { name: 'train.py', text: 'pass' })
  for (const [name, size] of [['source.txt', 4], ['source.py', SOURCE_BYTE_LIMIT + 1]]) {
    await assert.rejects(readEqTraceSource({ name, size, text() { assert.fail('unexpected read') } }), /请选择|超过/u)
  }
})

test('export bounds include negative-coordinate detours, their bends and arrow margins', () => {
  const ids = ['0', '1', '2', '3', '4']
  const f = { id: 'network', name: 'Synthetic parallel skips', nodes: ids.map(id => node(id, 'Step ' + id)),
    edges: ['01', '03', '04', '12', '14', '23', '24', '34'].map(([a, b]) => edge(a, b)) }
  const svg = renderEqTraceFigure(f)
  const [, width, height] = svg.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/u).map(Number)
  const [, offsetX, offsetY] = svg.match(/<g transform="translate\(([-\d.]+) ([-\d.]+)\)">/u).map(Number)
  const paths = [...svg.matchAll(/<path d="(M[-\d.LQ ]+)" fill="none"/gu)]
  assert.equal(paths.length, f.edges.length)
  const points = paths.flatMap(match => {
    const coordinates = match[1].match(/-?[\d.]+/gu).map(Number)
    return coordinates.flatMap((x, i) => i % 2 ? [] : [[x, coordinates[i + 1]]])
  })
  assert.ok(points.some(([x, y]) => x < -11 || y < -9), 'synthetic case exercises a detour beyond a fixed-size margin')
  for (const [x, y] of points) {
    assert.ok(x + offsetX >= 7 && x + offsetX <= width - 7)
    assert.ok(y + offsetY >= 7 && y + offsetY <= height - 7)
  }
})

test('reference-style network keeps true parallel towers, input labels, module boundaries and vector arrows', () => {
  const nodes = ['left', 'right', 'la', 'lb', 'ra', 'sum', 'rb', 'out'].map(id => node(id))
  for (const ix of [0, 1]) Object.assign(nodes[ix], { type: 'data', op: 'input' })
  Object.assign(nodes[2], { type: 'model', op: 'torch.nn.MultiheadAttention', config: { attribute: 'encoder.attention' } })
  Object.assign(nodes[3], { type: 'model', op: 'torch.nn.LayerNorm', config: { attribute: 'encoder.norm' } })
  Object.assign(nodes[4], { type: 'model', op: 'torch.nn.Linear', config: { attribute: 'decoder.projection' } })
  Object.assign(nodes[5], { op: 'Add' })
  Object.assign(nodes[6], { type: 'model', op: 'torch.nn.LayerNorm', config: { attribute: 'decoder.norm' } })
  Object.assign(nodes[7], { type: 'output', op: 'return' })
  const edges = [['left', 'la'], ['right', 'ra'], ['la', 'lb'], ['lb', 'sum'], ['ra', 'sum'], ['sum', 'rb'], ['rb', 'out']].map(([a,b]) => edge(a,b))
  const svg = renderEqTraceFigure({ id: 'network', name: 'Test.forward', nodes, edges })
  const positions = new Map([...svg.matchAll(/<g data-node="([^"]+)" data-shape="([^"]+)" data-x="([-\d.]+)" data-y="([-\d.]+)"/gu)].map(([,id,shape,x,y])=>[id,{shape,x:+x,y:+y}]))
  assert.match(svg, /data-module="encoder"/u); assert.match(svg, /data-module="decoder"/u)
  assert.equal(positions.get('sum').shape, 'operator'); assert.equal(positions.get('left').shape, 'terminal')
  assert.equal(positions.get('la').shape, 'attention'); assert.equal(positions.get('rb').shape, 'normalization')
  assert.ok(positions.get('la').x < positions.get('ra').x)
  for (const e of edges) assert.ok(positions.get(e.from.split(':')[0]).y > positions.get(e.to.split(':')[0]).y)
  assert.equal((svg.match(/<polygon points=/gu) || []).length, edges.length)
  assert.doesNotMatch(svg, /N×|Positional encoding/iu)
})

test('the training view reads from the entry at the bottom to output at the top, keeping branch bypasses', () => {
  const f = graph(); f.id = 'training'
  f.edges.push(edge('a','d','zero-iterations'))
  const svg = renderEqTraceFigure(f)
  const positions = [...svg.matchAll(/data-node="([a-d])"[^>]*data-y="([-\d.]+)"/gu)].map(([,id,y]) => [id,+y])
  assert.deepEqual(positions.sort((a,b)=>b[1]-a[1]).map(p=>p[0]), ['a','b','c','d'])
  assert.match(svg, /zero iterations/u)
  assert.equal((svg.match(/<polygon points=/gu) || []).length, 4)
})
