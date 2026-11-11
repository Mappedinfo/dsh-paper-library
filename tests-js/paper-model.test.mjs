import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPaperModel } from '../src/harness/paper-model.mjs'
import { createLocalStateStore } from '../src/local-state.mjs'
import { paperSessionId } from '../src/harness/paper-chat.mjs'

test('paper routes are global, pinned at admission, and applied to native paper turns only', async t => {
  const root = await mkdtemp(join(tmpdir(), 'paper-model-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const library = await realpath(await mkdir(join(root, 'library'), { recursive: true }))
  const store = createLocalStateStore({ library, home: join(root, 'home') })
  const host = { provider: 'host', model: 'default' }
  const revised = { provider: 'host', model: 'preferred', reasoningEffort: 'high' }
  let efforts = [{ id: 'high', name: '高' }]
  const llm = {
    resolveModelInfo: async () => ({ reasoning: { efforts } }),
    resolveCallConfig: async () => ({}),
  }
  const dependencies = { store, library, llm, getDefault: () => host,
    models: async () => ({ models: [{ id: 'preferred', provider: 'host' }, { id: 'default', provider: 'host' }] }) }
  const model = createPaperModel(dependencies)
  await model.ready
  const listeners = new Map()
  model.install({ on: (event, callback) => listeners.set(event, callback) })
  const select = []
  const agent = id => ({ session: { id, header: { cwd: library } }, model: { select: route => select.push([id, route]) } })
  const oldPaper = agent(paperSessionId(library, 'old'))
  const newPaper = agent(paperSessionId(library, 'new'))
  const other = agent('native-conversation')
  const inserted = (agent, message) => listeners.get('agent/inbox/inserted')({ agent, message })
  const claim = (agent, message, turn = 1) => listeners.get('agent/inbox/claimed')({ agent, message, turn })

  const before = await model.handle({ action: 'paper_model_get' })
  assert.deepEqual(before.effective_model, host)
  const queued = {}
  inserted(oldPaper, queued)
  await assert.rejects(model.handle({ action: 'paper_model_update', expected_revision: 0, model: { ...revised, reasoningEffort: 'unavailable' } }), /推理强度当前不可用/)
  const saved = await model.handle({ action: 'paper_model_update', expected_revision: 0, model: revised })
  assert.match(saved.revision, /^[a-f0-9]{64}$/)
  assert.deepEqual(await model.resolve(), revised)

  const newTurn = {}, laterInput = {}, ordinary = {}
  inserted(oldPaper, laterInput)
  inserted(newPaper, newTurn)
  inserted(other, ordinary)
  claim(oldPaper, queued)
  claim(oldPaper, laterInput)
  claim(newPaper, newTurn)
  claim(other, ordinary)
  assert.deepEqual(select, [[oldPaper.session.id, host], [newPaper.session.id, revised]])

  const plugin = {}
  await model.admit(oldPaper.session.id, host, async () => { await Promise.resolve(); inserted(oldPaper, plugin) })
  claim(oldPaper, plugin, 2)
  assert.deepEqual(select.at(-1), [oldPaper.session.id, host])
  const next = {}
  inserted(oldPaper, next)
  claim(oldPaper, next, 3)
  assert.deepEqual(select.at(-1), [oldPaper.session.id, revised])

  const reopened = createPaperModel(dependencies)
  await reopened.ready
  assert.deepEqual(reopened.current(), revised)
  efforts = []
  assert.match((await model.handle({ action: 'paper_model_get' })).warning, /推理强度当前不可用/)
  await assert.rejects(model.resolve(), /推理强度当前不可用/)
  const reset = await model.handle({ action: 'paper_model_update', expected_revision: saved.revision, model: null })
  assert.deepEqual(reset.effective_model, host)
})
