import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { analysisInputOptions } from '../analysis-input.mjs'
import { questionGroups, makeReadingPrompt, parseReadingAnswers, compileReadingGraph, summarizeOptionCandidates } from '../reading-questions.mjs'
import { isFatalModelError, safeModelErrorMessage, safeTruncationDetails } from '../model-errors.mjs'

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const clone = value => JSON.parse(JSON.stringify(value))
const problem = message => Object.assign(new Error(message), { code: 'ANALYSIS_INVALID' })
const union = (a = [], b = []) => [...new Set([...a, ...b])]
export const questionKey = (id, requestId, batch, group) => `analysis.question:${hash([id, requestId])}:${batch}:${group}`

/** 回答与原始响应分开保存，避免一个 256 KiB 状态条目重复塞入引文。 */
async function saveResponse(store, record, parsed) {
  const key = record.key
  const raw = typeof parsed.raw === 'string' ? parsed.raw : ''
  const rawKeys = Array.from({ length: Math.ceil(raw.length / 16000) }, (_, index) => `${key}:raw:${index}`)
  const answerKeys = parsed.answers.map((_, index) => `${key}:answer:${index}`)
  // 先公布预期清单。中途断电或写失败时，读取端能报告缺片而不是隐藏已写响应。
  const manifest = await store.put(key, clone({ ...record.value, status: 'saving', answer_keys: answerKeys, raw_keys: rawKeys,
    raw_sha256: hash(raw), raw_truncated: parsed.raw_truncated === true }), record.revision)
  for (const [index, part] of rawKeys.entries()) {
    await store.put(part, { text: raw.slice(index * 16000, (index + 1) * 16000) }, 0)
  }
  for (const [index, answer] of parsed.answers.entries()) {
    const part = answerKeys[index]
    const { raw: omitted, ...validated } = answer
    await store.put(part, clone(validated), 0)
  }
  return manifest
}

export async function readQuestionGroup(store, key, includeRaw = false) {
  const value = (await store.get(key)).value
  if (!value) return null
  const answers = [], missingParts = []
  for (const answerKey of value.answer_keys || []) {
    const saved = (await store.get(answerKey)).value
    if (saved) answers.push(saved)
    else missingParts.push(answerKey)
  }
  let raw
  if (includeRaw) {
    raw = ''
    for (const rawKey of value.raw_keys || []) {
      const saved = (await store.get(rawKey)).value
      if (typeof saved?.text === 'string') raw += saved.text
      else missingParts.push(rawKey)
    }
    if (value.raw_sha256 && hash(raw) !== value.raw_sha256) missingParts.push('RAW_HASH_MISMATCH')
  }
  const { answer_keys, raw_keys, ...publicValue } = value
  return { ...publicValue, answers, ...(missingParts.length ? { status: 'partial', stored_status: value.status, missing_parts: missingParts } : {}),
    ...(includeRaw ? { raw, raw_complete: Boolean(value.raw_sha256) && !missingParts.length && !value.raw_truncated } : {}) }
}

export async function readQuestionBatch(store, batch, { includeRaw = false } = {}) {
  const results = []
  for (const key of batch.question_keys || []) {
    const saved = await readQuestionGroup(store, key, includeRaw)
    if (saved) results.push(saved)
  }
  return { batch_answers: results.flatMap(result => result.answers), question_results: results }
}

/** 全文按页批次顺序读取；题组间串行，单题失败不能抹掉其他回答。 */
export async function runQuestionAnalysis({ input, store, kernel, sourcePack, resolveModel, agent, signal, update, batchKey, readingNote, evidenceReview, modelTimeoutMs }) {
  const config = input.questionnaire_snapshot, groups = questionGroups(config, input), ids = groups.flat()
  const questionCoverage = { question_ids: ids, complete: false, full_questionnaire: ids.length === config.questions.length,
    by_question: Object.fromEntries(ids.map(id => [id, { expected_batches: 0, answered_batches: 0, failed_batches: [], unread_batches: [], valid_answers: 0 }])) }
  let coverage = { read_pages: [], completed_pages: [], blank_pages: [], truncated_pages: [], omitted_pages: [], no_extractable_text_pages: [], empty_markdown_pages: [], characters: 0, full_document: false }
  let cursor, version, expected, model, hasText = false, batchCount = 0, projectionFailures = 0
  const summary = { answers: 0, valid_answers: 0, invalid_answers: 0, other_answers: 0, projection_limitations: 0 }
  let visual, job = input
  const patch = async value => { job = await update(value); return job }
  const warnings = []
  for (let index = 0; ; index++) {
    signal.throwIfAborted()
    if (index >= 10000) throw problem('阅读批次数达到上限；已保存内容保留。')
    await patch({ status: 'reading', stage: `读取第 ${index + 1} 批` })
    const readSignal = AbortSignal.any([signal, AbortSignal.timeout(180000)])
    const pack = sourcePack(await kernel({ action: 'paper_analysis_batch', id: input.id, ...analysisInputOptions(input),
      ...(input.pages ? { pages: input.pages } : {}), ...(cursor ? { cursor } : {}), ...(version ? { file_version: version } : {}) }, readSignal), input.id, input)
    signal.throwIfAborted()
    if (expected && (pack.expected_modified !== expected || version && !isDeepStrictEqual(pack.file_version, version))) throw problem('读取期间文献资料或 PDF 已改变，已完成批次保留；请重新整理。')
    version = pack.file_version; expected = pack.expected_modified
    const imageInputs = pack.images.map(({ data, ...image }) => ({ ...image, bytes: Buffer.byteLength(data, 'base64') }))
    if (pack.visual_coverage) {
      pack.visual_coverage = { ...pack.visual_coverage, sent_pages: [] }
      visual = { ...pack.visual_coverage, sent_pages: visual?.sent_pages || [],
        rendered_pages: union(visual?.rendered_pages, pack.visual_coverage.rendered_pages), omitted_pages: union(visual?.omitted_pages, pack.visual_coverage.omitted_pages) }
    }
    await patch({ expected_modified: expected, ...(pack.preprocessing ? { preprocessing: pack.preprocessing } : {}), ...(visual ? { visual_coverage: visual } : {}) })
    const questionKeys = [], allAnswers = []
    let draft, compilation, saveError
    if (pack.sources.length) {
      hasText = true
      if (!model) {
        const route = await resolveModel(readSignal)
        signal.throwIfAborted()
        if (typeof route?.provider !== 'string' || !route.provider || typeof route.model !== 'string' || !route.model) throw problem('请为这次分析配置有效模型。')
        model = { provider: route.provider, model: route.model, ...(route.reasoningEffort ? { reasoningEffort: route.reasoningEffort } : {}) }
        await patch({ model })
      }
      for (const [groupIndex, questionIds] of groups.entries()) {
        signal.throwIfAborted()
        await patch({ status: 'generating', stage: `第 ${index + 1} 批 · ${questionIds.join('、')}` })
        const key = questionKey(input.id, input.request_id, index, groupIndex)
        const prompt = makeReadingPrompt(pack, questionIds, config)
        let groupRecord = await store.put(key, { status: 'generating', question_ids: questionIds, pages: pack.coverage.read_pages,
          source_ids: pack.source_ids, prompt_hash: hash(prompt), questionnaire_hash: config.hash }, 0)
        questionKeys.push(key)
        // 先保存题组入口。进程在请求途中退出时，仍可读取已经完成的组，不自动重放。
        await patch({ batch_index: index, active_question_keys: questionKeys })
        let parsed, requestError
        try {
          const callTimeout = Number.isSafeInteger(modelTimeoutMs) ? modelTimeoutMs
            : Number.isSafeInteger(agent.modelTimeoutMs) ? agent.modelTimeoutMs : 180000
          const callSignal = AbortSignal.any([signal, AbortSignal.timeout(callTimeout)])
          const raw = await agent({ prompt, ...model, signal: callSignal, ...(pack.images.length ? { images: pack.images } : {}),
            analysisContext: { id: input.id, request_id: input.request_id, stage: 'batch', batch_index: index, question_ids: questionIds,
              source_ids: [...pack.source_ids], pages: [...pack.coverage.read_pages] } })
          signal.throwIfAborted()
          if (visual) {
            pack.visual_coverage.sent_pages = pack.images.map(image => image.page)
            visual.sent_pages = union(visual.sent_pages, pack.visual_coverage.sent_pages)
          }
          parsed = parseReadingAnswers(raw, pack, questionIds, config)
        } catch (error) {
          if (signal.aborted) throw error
          const code = error.code || 'MODEL_REQUEST_FAILED'
          const details = safeTruncationDetails(error)
          requestError = { code, message: isFatalModelError({ code }) || code === 'DIRECT_MODEL_OUTPUT_TRUNCATED'
            ? safeModelErrorMessage(code) : String(error.message).slice(0, 1200), ...(details ? { details } : {}) }
          parsed = { answers: [], errors: [requestError], missing: questionIds, raw: '' }
        }
        groupRecord = await saveResponse(store, groupRecord, parsed)
        const complete = !parsed.errors.length && !parsed.missing.length && parsed.answers.length > 0
        groupRecord = await store.put(key, clone({ ...groupRecord.value, status: complete ? 'complete' : 'partial', errors: parsed.errors,
          missing: parsed.missing, ...(requestError ? { request_error: requestError } : {}) }), groupRecord.revision)
        allAnswers.push(...parsed.answers)
        for (const id of questionIds) {
          const row = questionCoverage.by_question[id], answers = parsed.answers.filter(answer => answer.question_id === id)
          row.expected_batches++
          row.valid_answers += answers.filter(answer => answer.valid).length
          const globalErrors = parsed.errors.some(error => !questionIds.includes(error.question_id))
          if (answers.length && answers.every(answer => answer.valid) && !globalErrors) row.answered_batches++
          else row.failed_batches.push(index)
        }
        summary.answers += parsed.answers.length
        summary.valid_answers += parsed.answers.filter(answer => answer.valid).length
        summary.invalid_answers += parsed.answers.filter(answer => !answer.valid).length
        summary.other_answers += parsed.answers.filter(answer => answer.valid && answer.choice === 'other').length
        await patch({ question_coverage: questionCoverage, question_summary: summary, ...(visual ? { visual_coverage: visual } : {}) })
        if (isFatalModelError(requestError) || requestError?.code === 'DIRECT_MODEL_OUTPUT_TRUNCATED') {
          throw Object.assign(problem(safeModelErrorMessage(requestError.code)), { code: requestError.code })
        }
        if (['ANALYSIS_CALL_BUDGET', 'DIRECT_MODEL_CALL_BUDGET', 'DIRECT_MODEL_BUDGET_EXHAUSTED'].includes(requestError?.code)) throw Object.assign(problem('模型调用预算已耗尽；已保存问题回答保留。'), { code: requestError.code })
      }
      const graph = compileReadingGraph(allAnswers, pack, config)
      compilation = graph.compilation
      if (compilation.truncated) {
        projectionFailures++
        if (warnings.length < 30) warnings.push(`第 ${index + 1} 批图谱达到预算上限；未投影的回答仍保留在问题记录中。`)
      }
      summary.projection_limitations += compilation.limitations.length + compilation.excluded_answers.filter(answer => !['neutral-scope-record-no-graph-claim', 'invalid-or-different-questionnaire'].includes(answer.reason)).length
      const { compilation: omitted, ...content } = graph
      if (!content.nodes.length) content.body = '本批阅读回答及未完成项保存在问题记录中；未生成肯定的图谱主张。'
      await patch({ status: 'committing', stage: `保存第 ${index + 1} 批问题回答` })
      try {
        draft = await kernel({ action: 'knowledge_draft_put', entity: { kind: 'paper', id: input.id }, mode: content.nodes.length ? 'graph' : 'note',
          ...content, source_ids: pack.source_ids, request_id: `analysis-${hash([input.id, input.request_id, index])}`, origin: 'llm', model }, signal)
      } catch (error) {
        if (signal.aborted) throw error
        projectionFailures++
        saveError = String(error.message).slice(0, 1200)
        if (warnings.length < 30) warnings.push(`第 ${index + 1} 批图谱未保存；问题回答保留：${saveError}`)
      }
    } else {
      for (const row of Object.values(questionCoverage.by_question)) { row.expected_batches++; row.unread_batches.push(index) }
    }
    const savedBatch = { source_ids: pack.source_ids, coverage: pack.coverage, draft_id: draft?.id ?? null, metadata: {}, field_sources: {},
      question_keys: questionKeys, compilation, ...(saveError ? { graph_error: saveError } : {}),
      ...(pack.preprocessing ? { preprocessing: pack.preprocessing } : {}), ...(pack.visual_coverage ? { visual_coverage: pack.visual_coverage, image_inputs: imageInputs } : {}) }
    await store.put(batchKey(input.id, input.request_id, index), clone(savedBatch), 0)
    const previous = coverage
    coverage = { ...pack.coverage, characters: previous.characters + (pack.coverage.characters || 0), full_document: false }
    for (const key of ['read_pages', 'completed_pages', 'blank_pages', 'no_extractable_text_pages', 'image_only_pages', 'empty_markdown_pages', 'truncated_pages', 'omitted_pages']) coverage[key] = union(previous[key], pack.coverage[key])
    batchCount = index + 1
    await patch({ coverage, source_ids: pack.source_ids, draft_id: draft?.id ?? null, batch_index: index, batch_coverage: pack.coverage,
      batch_count: batchCount, active_question_keys: [], question_coverage: questionCoverage, question_summary: summary, warnings })
    if (!pack.next_cursor) break
    if (cursor && (pack.next_cursor.index < cursor.index || pack.next_cursor.index === cursor.index && pack.next_cursor.offset <= cursor.offset)) throw problem('阅读游标未推进，已保存批次保留。')
    cursor = pack.next_cursor
  }
  if (!hasText) throw problem('所选范围没有可读取文字；扫描件需要先做 OCR。')
  const noGaps = ['blank_pages', 'truncated_pages', 'omitted_pages', 'no_extractable_text_pages', 'empty_markdown_pages'].every(key => !coverage[key].length)
  coverage.full_document = noGaps && coverage.completed_pages.length === coverage.page_count
  coverage.selected_scope_complete = noGaps && (input.pages ? input.pages.every(page => coverage.completed_pages.includes(page)) : coverage.full_document)
  questionCoverage.complete = Object.values(questionCoverage.by_question).every(row => row.expected_batches > 0 && row.answered_batches === row.expected_batches)
  await patch({ coverage, question_coverage: questionCoverage })
  for (const [enabled, generate, name, label] of [[input.notes !== false, readingNote, 'note', '精读笔记'], [input.review !== false, evidenceReview, 'review', '证据图谱评审']]) {
    signal.throwIfAborted()
    if (!enabled) continue
    try {
      const result = await generate(job, model, signal)
      if (!result) throw problem('没有可用的已保存材料。')
      await patch({ [`${name}_draft_id`]: result.id, [`${name}_coverage`]: result.coverage, ...(name === 'review' ? { review_profile: result.profile } : {}) })
    } catch (error) {
      if (signal.aborted) throw error
      if (isFatalModelError(error) || error?.code === 'DIRECT_MODEL_OUTPUT_TRUNCATED') throw error
      warnings.push(`${label}草稿未生成：${String(error.message).slice(0, 400)}`)
    }
  }
  const complete = questionCoverage.complete && coverage.selected_scope_complete && !projectionFailures &&
    (input.notes === false || !!job.note_draft_id && job.note_coverage?.partial === false) &&
    (input.review === false || !!job.review_draft_id && job.review_coverage?.partial === false)
  await patch({ status: complete ? 'complete' : 'partial', stage: complete ? '问题阅读完成' : '部分完成，请查看缺失问题与覆盖范围',
    analysis_complete: complete, warnings, completed_at: new Date().toISOString() })
}

export { summarizeOptionCandidates }
