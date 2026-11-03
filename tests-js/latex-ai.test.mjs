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
import { createLatexResearch } from '../src/harness/latex-research.mjs'

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

async function fixture(replies, run) {
  const base = await mkdtemp(join(tmpdir(), 'latex-ai-'))
  const library = join(base, 'library')
  const folder = join(base, 'manuscript')
  await mkdir(folder, { recursive: true })
  await writeFile(join(folder, 'main.tex'), BODY)
  const created = await dispatch({ action: 'latex_project_create', root: folder, title: '手稿' }, { library, python })
  const prompts = []
  let index = 0
  const ai = async ({ prompt }) => { prompts.push(prompt); return replies[Math.min(index++, replies.length - 1)] }
  const research = run && createLatexResearch({ run, dispatch, library, python })
  const module = createLatexAI({ store: inMemoryStore(), ai, research, config: { provider: 'stub', model: 'stub-1' }, dispatch, library, python })
  return { base, library, folder, project: created.project, call: (input, options) => module(input, options), prompts }
}

test('a saved note can retrieve evidence beyond main.tex without copying tool excerpts to its history', async () => {
  const sentence = 'SYNTHETIC_CHAPTER_EVIDENCE remains in its own file.'
  const f = await fixture([], async ({ executeTool, prompt }) => {
    assert.match(prompt, /REVIEW_NOTE_JSON/)
    assert.ok(!prompt.includes(sentence))
    const found = await executeTool('search_project', { query: 'SYNTHETIC_CHAPTER_EVIDENCE' })
    assert.deepEqual(found.matches.map(item => [item.path, item.line]), [['chapters/results.tex', 2]])
    const opened = await executeTool('read_project_file', { path: found.matches[0].path, start_line: 2, lines: 2 })
    assert.match(opened.content, /SYNTHETIC_CHAPTER_EVIDENCE/)
    return { text: `依据结果章节 [${opened.source_id}]。`, trace: [{ name: 'search_project', status: 'ok', round: 1 }, { name: 'read_project_file', status: 'ok', round: 2 }], rounds: 3, calls: 2, usedTools: true, truncated: false }
  })
  await mkdir(join(f.folder, 'chapters'))
  await writeFile(join(f.folder, 'chapters', 'results.tex'), `\\section{Synthetic results}\n${sentence}\n`)
  const note = await sourceNote(f)
  const result = await f.call({ action: 'latex_ai_ask', id: f.project.id, review_note: { id: note.id, version: note.version }, question: '请检查另一章节。', retrieval: { project: true, public_queries: [] } })
  assert.deepEqual(f.prompts, [])
  const source = result.retrieval.sources.find(item => item.path === 'chapters/results.tex')
  assert.ok(source.revision)
  assert.match(result.answer, /\[F\d+\]/)
  assert.equal(source.line, 2)
  const history = (await f.call({ action: 'latex_ai_status', id: f.project.id })).entries
  assert.equal(history[0].review_note.id, note.id)
  assert.deepEqual(history[0].retrieval.sources, result.retrieval.sources)
  assert.doesNotMatch(JSON.stringify(history), /SYNTHETIC_CHAPTER_EVIDENCE/)
  assert.equal(await readFile(join(f.folder, 'main.tex'), 'utf8'), BODY)
  assert.equal(await readFile(join(f.folder, 'chapters', 'results.tex'), 'utf8'), `\\section{Synthetic results}\n${sentence}\n`)
})

test('a retrieved file is evidence, never a new proposal target', async () => {
  const f = await fixture([], async ({ executeTool }) => {
    const source = await executeTool('read_project_file', { path: 'chapter.tex' })
    assert.match(source.content, /Synthetic chapter only/)
    return { text: JSON.stringify({ summary: `基于 [${source.source_id}]`, replacements: [{ find: 'Synthetic chapter only', replace: 'Other text' }] }), trace: [], rounds: 2, calls: 1, usedTools: true }
  })
  await writeFile(join(f.folder, 'chapter.tex'), 'Synthetic chapter only\n')
  await assert.rejects(f.call({ action: 'latex_ai_propose', id: f.project.id, path: 'main.tex', instruction: '核对内容', retrieval: { project: true, public_queries: [] } }), error => error.code === 'LATEX_AI_ANCHOR')
  assert.equal((await f.call({ action: 'latex_ai_status', id: f.project.id })).proposal, null)
  assert.equal(await readFile(join(f.folder, 'chapter.tex'), 'utf8'), 'Synthetic chapter only\n')
})

test('cancelled retrieval saves neither a late response nor a pending proposal', async () => {
  const abort = new AbortController()
  const f = await fixture([], async ({ executeTool, signal }) => {
    await executeTool('read_project_file', { path: 'main.tex' })
    abort.abort(new Error('Synthetic cancel'))
    assert.equal(signal.aborted, true)
    return { text: 'late reply', trace: [], usedTools: true }
  })
  await assert.rejects(f.call({ action: 'latex_ai_ask', id: f.project.id, question: '请核对。', retrieval: { project: true, public_queries: [] } }, { signal: abort.signal }), /Synthetic cancel/)
  const status = await f.call({ action: 'latex_ai_status', id: f.project.id })
  assert.deepEqual(status.entries, [])
  assert.equal(status.proposal, null)
})

async function sourceNote(f, path = 'main.tex') {
  const file = await dispatch({ action: 'latex_read', id: f.project.id, path }, { library: f.library, python })
  const quote = 'The neighbourhood effect is small.', start = file.content.indexOf(quote)
  return (await dispatch({ action: 'latex_review_put', id: f.project.id, anchor: { kind: 'source', path, revision: file.revision, start, end: start + quote.length, text: quote }, comment: '请说明该结论是否需要范围限定。' }, { library: f.library, python })).annotation
}

test('review questions use authoritative saved note context and retain only its identity in the bounded log', async () => {
  const f = await fixture(['合成回复']), note = await sourceNote(f)
  const selected = { id: note.id, version: note.version, quote: 'FORGED_QUOTE', comment: 'FORGED_COMMENT' }
  const result = await f.call({ action: 'latex_ai_ask', id: f.project.id, review_note: selected, question: '请回答这条批注。' })
  assert.deepEqual(result.review_note, { id: note.id, version: note.version, kind: 'source', stale: false })
  assert.equal(result.entry.answer, result.answer)
  assert.ok(f.prompts[0].includes(note.comment)); assert.ok(f.prompts[0].includes('REVIEW_NOTE_JSON:'))
  assert.ok(!f.prompts[0].includes('FORGED_'))
  const log = (await f.call({ action: 'latex_ai_status', id: f.project.id })).entries
  assert.deepEqual(log[0].review_note, result.review_note)
  assert.equal(log[0].review_note.quote, undefined)
  assert.equal(await readFile(join(f.folder, 'main.tex'), 'utf8'), BODY)
  assert.equal((await dispatch({ action: 'latex_review_list', id: f.project.id }, { library: f.library, python })).annotations[0].status, 'open')
})

test('source-note proposals target the declared source file and still require explicit acceptance', async () => {
  const reply = JSON.stringify({ summary: '限定表述', replacements: [{ find: 'small.', replace: 'modest.' }] })
  const f = await fixture([reply]); await writeFile(join(f.folder, 'chapter.tex'), BODY)
  const note = await sourceNote(f, 'chapter.tex')
  const result = await f.call({ action: 'latex_ai_propose', id: f.project.id, review_note: { id: note.id, version: note.version }, instruction: '按该批注提出必要修改。' })
  assert.equal(result.proposal.path, 'chapter.tex')
  assert.deepEqual(result.proposal.review_note, result.entry.review_note)
  assert.equal(await readFile(join(f.folder, 'chapter.tex'), 'utf8'), BODY)
  await f.call({ action: 'latex_ai_accept', id: f.project.id, proposal_id: result.proposal.id })
  assert.ok((await readFile(join(f.folder, 'chapter.tex'), 'utf8')).includes('modest.'))
  assert.equal(await readFile(join(f.folder, 'main.tex'), 'utf8'), BODY)
  const log = (await f.call({ action: 'latex_ai_status', id: f.project.id })).entries
  assert.equal(log[0].kind, 'accepted'); assert.equal(log[0].review_note.id, note.id)
})

test('a note proposal with no changes keeps a related result without creating pending edits', async () => {
  const f = await fixture([JSON.stringify({ summary: '无需改动', replacements: [] })]), note = await sourceNote(f)
  const result = await f.call({ action: 'latex_ai_propose', id: f.project.id, review_note: { id: note.id, version: note.version }, instruction: '核对本条批注。' })
  assert.equal(result.changed, false); assert.equal(result.proposal.status, 'empty')
  assert.equal(result.entry.replacements, 0); assert.equal(result.entry.review_note.id, note.id)
  const status = await f.call({ action: 'latex_ai_status', id: f.project.id })
  assert.equal(status.proposal, null); assert.equal(status.entries[0].review_note.id, note.id)
  assert.equal(await readFile(join(f.folder, 'main.tex'), 'utf8'), BODY)
})

test('stale discard cannot drop a newer proposal and completed actions return their related entries', async () => {
  const reply = summary => JSON.stringify({ summary, replacements: [{ find: 'small.', replace: 'modest.' }] })
  const f = await fixture([reply('第一份'), reply('第二份'), reply('第三份')]), note = await sourceNote(f)
  const request = { action: 'latex_ai_propose', id: f.project.id, review_note: { id: note.id, version: note.version }, instruction: '核对并修改。' }
  const first = await f.call(request), second = await f.call(request)
  await assert.rejects(f.call({ action: 'latex_ai_discard', id: f.project.id, proposal_id: first.proposal.id }), error => error.code === 'LATEX_AI_STALE_PROPOSAL')
  assert.equal((await f.call({ action: 'latex_ai_proposal', id: f.project.id })).proposal.id, second.proposal.id)
  const discarded = await f.call({ action: 'latex_ai_discard', id: f.project.id, proposal_id: second.proposal.id })
  assert.equal(discarded.entry.kind, 'discarded'); assert.equal(discarded.entry.review_note.id, note.id)
  const third = await f.call(request)
  const accepted = await f.call({ action: 'latex_ai_accept', id: f.project.id, proposal_id: third.proposal.id })
  assert.equal(accepted.entry.kind, 'accepted'); assert.equal(accepted.entry.review_note.id, note.id)
  assert.equal(accepted.entry.revision, accepted.revision)
})

test('missing, changed, conflicting-selection and wrong-path note references fail before a model call', async () => {
  const f = await fixture(['unused']), note = await sourceNote(f)
  const base = { action: 'latex_ai_ask', id: f.project.id, question: 'x' }
  for (const fields of [
    { review_note: { id: 'source:missing', version: note.version } },
    { review_note: { id: note.id, version: 'old-version' } },
    { review_note: { id: note.id, version: note.version }, selection: 'The neighbourhood effect is small.' },
    { review_note: { id: note.id, version: note.version }, path: 'other.tex' },
  ]) await assert.rejects(f.call({ ...base, ...fields }))
  assert.equal(f.prompts.length, 0)
  assert.deepEqual((await f.call({ action: 'latex_ai_status', id: f.project.id })).entries, [])
})

test('stale source quotes remain explicit historical references rather than current source anchors', async () => {
  const f = await fixture(['合成回复']), note = await sourceNote(f)
  await writeFile(join(f.folder, 'main.tex'), BODY.replace('small.', 'tiny.'))
  const result = await f.call({ action: 'latex_ai_ask', id: f.project.id, review_note: { id: note.id, version: note.version }, question: '核对旧批注。' })
  assert.equal(result.review_note.stale, true)
  assert.match(f.prompts[0], /历史材料/); assert.match(f.prompts[0], /effect is tiny/)
  assert.ok(f.prompts[0].includes('"quote":"The neighbourhood effect is small."'))
})

test('a note edited while the model runs rejects the late proposal without saving a log or replacement', async () => {
  let release
  const delayed = new Promise(resolve => { release = resolve })
  const f = await fixture([delayed]), note = await sourceNote(f)
  const pending = f.call({ action: 'latex_ai_propose', id: f.project.id, review_note: { id: note.id, version: note.version }, instruction: '按批注改写。' })
  for (let i = 0; i < 100 && !f.prompts.length; i++) await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(f.prompts.length, 1)
  await dispatch({ action: 'latex_review_put', id: f.project.id, note_id: note.id, expected_version: note.version, comment: '另一窗口的新要求。' }, { library: f.library, python })
  release(JSON.stringify({ summary: '修改', replacements: [{ find: 'small.', replace: 'modest.' }] }))
  await assert.rejects(pending, error => error.code === 'LATEX_AI_NOTE_STALE')
  const result = await f.call({ action: 'latex_ai_status', id: f.project.id })
  assert.equal(result.proposal, null); assert.deepEqual(result.entries, [])
  assert.equal(await readFile(join(f.folder, 'main.tex'), 'utf8'), BODY)
})

test('PDF-note context requires an explicit source target, never infers a mapping and stays bounded', async () => {
  const store = inMemoryStore(), prompts = []
  const note = { id: 'pdf:synthetic:note', version: 'saved-version', stale: true, status: 'open', anchor: { kind: 'pdf', page: 2, pdf_version: 'old-build' }, text: 'Q'.repeat(9000), comment: 'C'.repeat(9000) }
  const handler = createLatexAI({ store, config: { provider: 'stub', model: 'stub' }, ai: async ({ prompt }) => { prompts.push(prompt); return 'reply' }, dispatch: async request => {
    if (request.action === 'latex_project_get') return { project: { id: 'paper', title: '合成项目', root: '/synthetic', main_path: 'main.tex', binding_generation: 0 } }
    if (request.action === 'latex_review_list') return { annotations: [note] }
    if (request.action === 'latex_read') return { path: request.path, revision: 'source-revision', content: BODY }
    throw Error('Unexpected action')
  } })
  const request = { action: 'latex_ai_ask', id: 'paper', review_note: { id: note.id, version: note.version }, question: '问题' }
  await assert.rejects(handler(request), error => error.code === 'LATEX_AI_NOTE_PATH')
  assert.equal(prompts.length, 0)
  const result = await handler({ ...request, path: 'chapter.tex' })
  assert.equal(result.path, 'chapter.tex'); assert.equal(result.review_note.kind, 'pdf')
  const snapshot = JSON.parse(prompts[0].split('REVIEW_NOTE_JSON:\n')[1].split('\n\n作者的问题：')[0])
  assert.equal(snapshot.quote.length, 8000); assert.equal(snapshot.comment.length, 8000)
  assert.equal(snapshot.quote_truncated, true); assert.equal(snapshot.comment_truncated, true)
  assert.deepEqual(snapshot.anchor, { kind: 'pdf', page: 2, pdf_version: 'old-build' })
  assert.match(prompts[0], /PDF 页码不提供当前源码位置映射/)
})

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

test('a proposal cannot be accepted after the project binding changes and returns', async () => {
  const reply = JSON.stringify({ summary: '改动', replacements: [{ find: 'small.', replace: 'modest.' }] })
  const { call, project, library, folder } = await fixture([reply])
  const proposed = await call({ action: 'latex_ai_propose', id: project.id, instruction: 'x', expected_binding_generation: 0 })
  await writeFile(join(folder, 'other.tex'), BODY)
  const other = (await dispatch({ action: 'latex_project_update', id: project.id, main_path: 'other.tex', expected_binding_generation: 0 }, { library, python })).project
  const returned = (await dispatch({ action: 'latex_project_update', id: project.id, main_path: 'main.tex', expected_binding_generation: other.binding_generation }, { library, python })).project
  assert.equal(returned.binding_generation, 2)
  await assert.rejects(() => call({ action: 'latex_ai_accept', id: project.id, proposal_id: proposed.proposal.id, expected_binding_generation: 2 }), /没有待确认的提案/)
  assert.equal(await readFile(join(folder, 'main.tex'), 'utf8'), BODY)
})

test('a delayed proposal cannot replace one for a newly selected entry', async () => {
  const reply = JSON.stringify({ summary: '改动', replacements: [{ find: 'small.', replace: 'modest.' }] })
  let release
  const delayed = new Promise(resolve => { release = resolve })
  const { call, project, library, folder, prompts } = await fixture([delayed, reply])
  const old = call({ action: 'latex_ai_propose', id: project.id, instruction: 'old', expected_binding_generation: 0 })
  for (let i = 0; i < 100 && !prompts.length; i++) await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(prompts.length, 1)
  await writeFile(join(folder, 'other.tex'), BODY)
  const changed = (await dispatch({ action: 'latex_project_update', id: project.id, main_path: 'other.tex', expected_binding_generation: 0 }, { library, python })).project
  const current = await call({ action: 'latex_ai_propose', id: project.id, instruction: 'new', expected_binding_generation: changed.binding_generation })
  release(reply)
  await assert.rejects(old, /绑定已变化/)
  const pending = await call({ action: 'latex_ai_proposal', id: project.id, expected_binding_generation: changed.binding_generation })
  assert.equal(pending.proposal.id, current.proposal.id)
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
  await assert.rejects(() => bare({ action: 'latex_ai_ask', id: created.project.id, question: 'x' }), /请先在 LaTeX 设置中选择 DSH 模型/)
  await assert.rejects(() => bare({ action: 'latex_ai_unknown', id: created.project.id }), /未知 LaTeX 协作操作/)
  await assert.rejects(() => unconfigured.call({ action: 'latex_ai_ask', id: 'nope', question: 'x' }), /项目标识无效/)
})
