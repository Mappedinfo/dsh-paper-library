import test from 'node:test'
import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFetchHandler } from '../src/http.mjs'
import { handleBoardRequest } from '../src/harness/board-tools.mjs'

const store = { read: async id => { assert.equal(id, 'board') } }
const request = fields => handleBoardRequest(store, { action: 'board_flow_eqtrace', id: 'board', ...fields })

test('已选源码经随包解析器和画板校验生成双图，全程不运行用户代码', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'eqtrace-guard-'))
  try {
    const marker = join(dir, 'executed')
    const model = { name: 'network.py', text: `from pathlib import Path
Path(${JSON.stringify(marker)}).touch()
from torch import nn
class Net(nn.Module):
    def __init__(self):
        super().__init__()
        self.head = nn.Linear(8, 1)
    def forward(self, x):
        return self.head(x)
` }
    const entry = { name: 'experiment.py', text: `def train(batches, model, optimizer, criterion):
    for x, y in batches:
        loss = criterion(model(x), y)
        loss.backward()
        optimizer.step()
` }
    const doc = await request({ entry, model, class_name: 'Net' })
    assert.deepEqual(doc.flows.map(g => g.id), ['network', 'training'])
    assert.ok(doc.flows[0].nodes.some(n => n.config?.parameters?.in_features === 8))
    assert.ok(doc.flows[1].nodes.some(n => n.op === 'backward'))
    assert.deepEqual(doc.paper.sources, ['experiment.py', 'network.py'])
    await assert.rejects(access(marker), { code: 'ENOENT' })
    await assert.rejects(request({ model, class_name: 'Missing' }), /Missing/)
  } finally {
    await rm(dir, { force: true, recursive: true })
  }
})

test('拒绝任意宿主路径、同名冲突和非读者调用', async () => {
  await assert.rejects(request({ model: { name: '../source.py', text: 'pass' } }), /文件名/)
  await assert.rejects(request({ entry: { name: 'm.py', text: 'a' }, model: { name: 'm.py', text: 'b' } }), /同名/)
  await assert.rejects(handleBoardRequest(store, { action: 'board_flow_eqtrace', id: 'board' }, { writer: 'llm' }), /读者/)
})

test('本机 API 从同一份源码生成双图并按原工作区格式保存和读回', async t => {
  const root = await mkdtemp(join(tmpdir(), 'paper-library-figures-'))
  const library = join(root, 'library')
  await mkdir(library)
  const handler = createFetchHandler({ library, localStateHome: join(root, 'home') })
  t.after(async () => { handler.disposeInkQueue(); await rm(root, { recursive: true, force: true }) })
  async function post(action, fields) {
    const response = await handler(new Request('http://127.0.0.1/api', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, ...fields }),
    }))
    const data = await response.json()
    assert.equal(response.status, 200, data.error)
    return data.result
  }
  const parent = await post('board_create', { title: '合成实验', nodes: [], edges: [] })
  const id = parent.board.id
  const entry = { name: 'experiment.py', text: `from torch import nn
class Net(nn.Module):
    def forward(self, x):
        return x + x
def train(net, inputs, optimizer):
    loss = net(inputs).sum()
    loss.backward()
    optimizer.step()
` }
  const doc = await post('board_flow_eqtrace', { id, entry })
  assert.deepEqual(doc.flows.map(f => f.id), ['network', 'training'])
  const saved = await post('board_flow_save', { id, workspace: doc, expected_revision: 0 })
  const restored = await post('board_flow_get', { id })
  assert.deepEqual(saved, restored)
  assert.deepEqual(restored.workspace.documents[0].flows, doc.flows)
})
