/**
 * DSH questions and co-writing: the model is stubbed, the manuscript is real.
 *
 * Every check drives the shipped module against a real Python worker writing real
 * files, so the anchors, the CAS accept and the refusal paths are the ones the panel
 * and the agent actually use.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dispatch } from '../src/bridge.mjs'
import { createLatexAI } from '../src/harness/latex-ai.mjs'

const project = dirname(dirname(fileURLToPath(import.meta.url)))
const python = existsSync(join(project, '.venv', 'bin', 'python')) ? join(project, '.venv', 'bin', 'python') : undefined

const BODY = `\\documentclass[11pt]{article}
\\begin{document}
\\section{Introduction}
The neighbourhood effect is small.
\\end{document}
`

const inMemoryStore = () => {
  const values = new Map()
  return {
    async get(key) { const entry = values.get(key); return entry ? { value: entry.value, revision: entry.revision } : { value: null, revision: 0 } },
    async put(key, value, revision) {
      const entry = values.get(key)
      const current = entry ? entry.revision : 0
      if (revision !== undefined && revision !== current) throw Object.assign(new Error('conflict'), { code: 'STATE_CONFLICT' })
      values.set(key, { value, revision: current + 1 })
      return { value, revision: current + 1 }
    },
  }
}

async function fixture(replies) {
  const base = await mkdtemp(join(tmpdir(), 'latex-ai-'))
  const library = join(base, 'library')
  const folder = join(base, 'manuscript')
  await mkdir(folder, { recursive: true })
  await writeFile(join(folder, 'main.tex'), BODY)
  const created = await dispatch({ action: 'latex_project_create', root: folder, title: '手稿' }, { library, python })
  const prompts = []
  let index = 0
  const ai = async ({ prompt }) => { prompts.push(prompt); return replies[Math.min(index++, replies.length - 1)] }
  const module = createLatexAI({ store: inMemoryStore(), ai, config: { provider: 'stub', model: 'stub-1' }, dispatch, library, python })
  return { base, library, folder, project: created.project, call: (input, options) => module(input, options), prompts }
}

test('a question sends a bounded excerpt and keeps the answer, never the file', async () => {
  const { call, prompts, folder, project } = await fixture(['先确认这句话的主张边界，再补一句限定。'])
  const asked = await call({ action: 'latex_ai_ask', id: project.id, question: '这句话的 claim 边界是什么？' })
  assert.equal(asked.answer, '先确认这句话的主张边界，再补一句限定。')
  assert.equal(asked.model.provider, 'stub')
  assert.equal(asked.path, 'main.tex')
  assert.equal(asked.material.kind, 'file')
  assert.ok(prompts[0].includes('The neighbourhood effect is small.'))
  assert.ok(prompts[0].includes('不可信引用数据'))
  assert.equal(await readFile(join(folder, 'main.tex'), 'utf8'), BODY, 'asking must not touch the file')

  const status = await call({ action: 'latex_ai_status', id: project.id })
  assert.equal(status.entries.length, 1)
  assert.equal(status.entries[0].kind, 'ask')
  assert.equal(status.proposal, null)
  assert.equal(status.configured, true)
})

test('a selection is sent instead of the whole file, and a stale selection is refused', async () => {
  const { call, prompts, project } = await fixture(['answer'])
  const selection = 'The neighbourhood effect is small.'
  await call({ action: 'latex_ai_ask', id: project.id, selection, question: '改写这一句' })
  assert.ok(prompts[0].includes('作者选中的片段'))
  assert.ok(!prompts[0].includes('\\documentclass'), 'only the selection should travel')
  await assert.rejects(() => call({ action: 'latex_ai_ask', id: project.id, selection: 'not in the file', question: 'x' }), /选中的文字不在当前文件里/)
})

test('translation sends only the explicit unsaved draft selection and follows the host default', async () => {
  const { folder, project, library } = await fixture(['unused'])
  const calls = [], store = inMemoryStore()
  const handle = createLatexAI({ store, ai: async input => { calls.push(input); return '合成译文' }, getDefaultModel: () => ({ provider: 'host', model: 'default' }), models: async () => ({ models: [{ provider: 'host', id: 'mini' }] }), dispatch, library, python })
  const selection = 'Unsaved draft with \\cite{source} and $x=1$.'
  const result = await handle({ action: 'latex_ai_translate', id: project.id, path: 'main.tex', selection, target_language: 'zh-CN' })
  assert.equal(result.answer, '合成译文'); assert.deepEqual(result.model, { provider: 'host', model: 'default' })
  assert.equal(result.source, 'editor-selection'); assert.match(result.prompt_version, /^latex-translate-v1:/)
  assert.ok(calls[0].prompt.includes(JSON.stringify({ text: selection }))); assert.ok(!calls[0].prompt.includes('neighbourhood'))
  assert.equal(await readFile(join(folder, 'main.tex'), 'utf8'), BODY)
  const override = await handle({ action: 'latex_ai_translate', id: project.id, selection, target_language: 'zh-CN', model_override: { provider: 'host', model: 'mini' }, prompt: '保留缩写' })
  assert.equal(override.model.model, 'mini'); assert.match(calls[1].prompt, /保留缩写/)
  await assert.rejects(handle({ action: 'latex_ai_translate', id: project.id, selection, target_language: 'zh-CN', model_override: { provider: 'host', model: 'unknown' } }), error => error.code === 'LATEX_AI_MODEL_REQUIRED')
})

test('translation uses the language preference, auto-detects prose and honours an explicit target', async () => {
  const { folder, project, library } = await fixture(['unused'])
  const store = inMemoryStore(), prompts = []
  const handle = createLatexAI({ store, ai: async ({ prompt }) => { prompts.push(prompt); return '合成译文' }, getDefaultModel: () => ({ provider: 'host', model: 'stub' }), dispatch, library, python })
  async function check(selection, target, expected, automatic) {
    const request = { action: 'latex_ai_translate', id: project.id, selection, ...(target === undefined ? {} : { target_language: target }) }
    const result = await handle(request)
    assert.equal(result.target_language, expected)
    assert.equal(result.requested_target_language, automatic ? 'auto' : undefined)
    assert.match(prompts.at(-1), expected === 'en' ? /into English\./ : /into Simplified Chinese\./)
    assert.ok(prompts.at(-1).includes(JSON.stringify({ text: selection })), 'the model receives the original selection with LaTeX intact')
  }

  await check('这是一段中文。', undefined, 'en', true) // no saved target defaults to auto
  await check('A short English sentence.', undefined, 'zh-CN', true)
  await store.put('language.settings', { target_language: 'en' }, 0)
  await check('An English sentence.', undefined, 'en', false) // preference wins over detection
  await store.put('language.settings', { target_language: 'zh-CN' }, 1)
  await check('这是中文。', undefined, 'zh-CN', false)
  await check('中文内容。', 'auto', 'en', true) // explicit auto overrides the saved direction
  await check('English prose.', 'auto', 'zh-CN', true)
  await check('English prose.', 'en', 'en', false)
  await check('中文内容。', 'zh-CN', 'zh-CN', false)
  await check('The result follows \\cite{中文中文中文中文} and $\\text{中文中文中文}$.', 'auto', 'zh-CN', true)
  await check('这是中文说明。 \\cite{a-long-english-reference} $\\text{English math content}$', 'auto', 'en', true)
  assert.equal(await readFile(join(folder, 'main.tex'), 'utf8'), BODY, 'translation never writes the manuscript')
})

test('a proposal is kept as verified replacements and applied only on accept', async () => {
  const reply = JSON.stringify({
    summary: '把断言改成有边界的表述',
    replacements: [{ find: 'The neighbourhood effect is small.', replace: 'The neighbourhood effect is small in this sample (n=48).' }],
    notes: '样本量来自作者原文，未新增数据',
  })
  const { call, folder, project, library } = await fixture([reply])
  const proposed = await call({ action: 'latex_ai_propose', id: project.id, path: 'main.tex', instruction: '把结论写得有边界' })
  assert.equal(proposed.changed, true)
  assert.equal(proposed.proposal.status, 'pending')
  assert.equal(proposed.proposal.replacements.length, 1)
  assert.equal(proposed.proposal.revision, (await dispatch({ action: 'latex_read', id: project.id, path: 'main.tex' }, { library, python })).revision)
  assert.equal(await readFile(join(folder, 'main.tex'), 'utf8'), BODY, 'a proposal must not write')

  const pending = await call({ action: 'latex_ai_proposal', id: project.id })
  assert.equal(pending.proposal.id, proposed.proposal.id)
  assert.ok(!('proposed' in pending.proposal), 'the state record must not carry a second copy of the file')

  const accepted = await call({ action: 'latex_ai_accept', id: project.id, proposal_id: proposed.proposal.id })
  assert.equal(accepted.origin, 'ai:stub/stub-1')
  const onDisk = await readFile(join(folder, 'main.tex'), 'utf8')
  assert.ok(onDisk.includes('small in this sample (n=48).'))
  assert.equal((await call({ action: 'latex_ai_proposal', id: project.id })).proposal, null)
  const log = await call({ action: 'latex_ai_status', id: project.id })
  assert.deepEqual(log.entries.map(entry => entry.kind), ['accepted', 'proposal'])
})

test('a proposal is refused when an anchor is missing, ambiguous or oversized', async () => {
  const { call, project } = await fixture([JSON.stringify({ summary: 'x', replacements: [{ find: 'e', replace: 'E' }] })])
  // `Introduction` is unique, so an anchor that repeats is used instead.
  await assert.rejects(() => call({ action: 'latex_ai_propose', id: project.id, instruction: 'x' }), /无法安全替换/)
  const missing = await fixture([JSON.stringify({ summary: 'x', replacements: [{ find: 'not present', replace: 'y' }] })])
  await assert.rejects(() => missing.call({ action: 'latex_ai_propose', id: missing.project.id, instruction: 'x' }), /无法安全替换/)
  const broken = await fixture(['这不是 JSON'])
  await assert.rejects(() => broken.call({ action: 'latex_ai_propose', id: broken.project.id, instruction: 'x' }), /可解析的 JSON/)
  const tooMany = await fixture([JSON.stringify({ summary: 'x', replacements: Array.from({ length: 21 }, () => ({ find: 'a', replace: 'b' })) })])
  await assert.rejects(() => tooMany.call({ action: 'latex_ai_propose', id: tooMany.project.id, instruction: 'x' }), /超过 20 处改动/)
  const empty = await fixture([JSON.stringify({ summary: '无需改动', replacements: [] })])
  const nothing = await empty.call({ action: 'latex_ai_propose', id: empty.project.id, instruction: '什么也不用改' })
  assert.equal(nothing.changed, false)
  assert.equal((await empty.call({ action: 'latex_ai_proposal', id: empty.project.id })).proposal, null)
})

test('an accepted proposal never overwrites a file that moved on', async () => {
  const reply = JSON.stringify({ summary: '改动', replacements: [{ find: 'small.', replace: 'modest.' }] })
  const { call, project, library } = await fixture([reply])
  const proposed = await call({ action: 'latex_ai_propose', id: project.id, instruction: 'x' })
  const current = await dispatch({ action: 'latex_read', id: project.id, path: 'main.tex' }, { library, python })
  await dispatch({ action: 'latex_write', id: project.id, path: 'main.tex', content: current.content.replace('small.', 'tiny.'), expected_revision: current.revision, origin: 'reader' }, { library, python })
  const conflict = await call({ action: 'latex_ai_accept', id: project.id }).then(() => null, error => error)
  assert.equal(conflict.code, 'STATE_CONFLICT')
  assert.ok(conflict.current.content.includes('tiny.'))
  const kept = await call({ action: 'latex_ai_proposal', id: project.id })
  assert.equal(kept.proposal.id, proposed.proposal.id, 'a refused accept keeps the proposal for review')
  const discarded = await call({ action: 'latex_ai_discard', id: project.id })
  assert.equal(discarded.discarded, true)
  assert.equal((await call({ action: 'latex_ai_proposal', id: project.id })).proposal, null)
})

test('the model route comes from the request, the deployment, or a clear refusal', async () => {
  const configured = await fixture(['ok'])
  await assert.rejects(() => configured.call({ action: 'latex_ai_ask', id: configured.project.id, question: 'x', provider: 42 }), /模型提供方无效/)
  const answered = await configured.call({ action: 'latex_ai_ask', id: configured.project.id, question: 'x', provider: 'harness', model: 'k3' })
  assert.deepEqual(answered.model, { provider: 'harness', model: 'k3' })

  const unconfigured = await fixture(['ok'])
  const base = await mkdtemp(join(tmpdir(), 'latex-ai-noconfig-'))
  const library = join(base, 'library'), folder = join(base, 'manuscript')
  await mkdir(folder, { recursive: true })
  await writeFile(join(folder, 'main.tex'), BODY)
  const created = await dispatch({ action: 'latex_project_create', root: folder }, { library, python })
  const bare = createLatexAI({ store: inMemoryStore(), ai: async () => 'ok', config: {}, dispatch, library, python })
  await assert.rejects(() => bare({ action: 'latex_ai_ask', id: created.project.id, question: 'x' }), /请先在 LaTeX 面板选择 DSH 模型/)
  await assert.rejects(() => bare({ action: 'latex_ai_unknown', id: created.project.id }), /未知 LaTeX 协作操作/)
  await assert.rejects(() => unconfigured.call({ action: 'latex_ai_ask', id: 'nope', question: 'x' }), /项目标识无效/)
})
