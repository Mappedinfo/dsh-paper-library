import test from 'node:test'
import assert from 'node:assert/strict'
import engine from '../vendor/paper-flow/core/graph.js'
import { compareFlows, prepareGraph } from '../vendor/paper-flow/comparison.js'

const makeGraph = name => ({
  id: name, name,
  nodes: [
    { id: 'source', label: 'Synthetic input', type: 'data', semantic_key: 'input', ports: { in: {}, out: { value: { type: 'text' } } } },
    { id: 'step', label: 'Synthetic step', type: 'method', semantic_key: 'step', ports: { in: { value: { type: 'text' } }, out: {} } },
  ],
  edges: [{ id: 'link', from: 'source:value', to: 'step:value', kind: 'data', label: 'Synthetic relation' }],
})

test('standalone and comparison SVGs omit footer and keep graph content within the shortened canvas', () => {
  const left = makeGraph('Synthetic A'), right = makeGraph('Synthetic B')
  const merged = compareFlows(left, right).merged
  for (const graph of [left, merged]) for (const detail of ['full', 'overview']) for (const treeLevels of ['expanded', 'compact']) {
    const prepared = prepareGraph(graph, { detail, arrangement: 'trunks', treeLevels, grouping: true })
    for (const title of [true, false]) {
      const rendered = engine.svg(prepared, { title })
      const top = (title ? 72 : 10) + (rendered.layout.comparison_lanes ? 44 : 0)
      assert.equal(rendered.height, rendered.layout.height + top + 28)
      assert.match(rendered.svg, /Synthetic input/)
      assert.match(rendered.svg, /Synthetic step/)
      assert.match(rendered.svg, /class="input-resource-badge"/)
      assert.match(rendered.svg, /data-edge-id=/)
      assert.match(rendered.svg, /<\/svg>$/)
      assert.doesNotMatch(rendered.svg, /节点形状图例|浅金底＝|浅紫底＝|小桥表示|临时展示草稿/)
      for (const node of rendered.layout.nodes) assert.ok(node.y + node.height / 2 + top <= rendered.height, `node ${node.id} exceeds canvas`)
    }
  }
})
