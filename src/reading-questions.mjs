/** 人工问题库与纯阅读协议；不调用模型、不读取资料库、不写回元数据。 */
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

const DIRECTORY = new URL('../prompts/reading/', import.meta.url)
const QUESTION_IDS = ['q1', 'q2', 'q3', 'q4', 'q5', 'q6']
const SOURCE_TYPES = new Set(['evidence', 'figure', 'formula'])
const NODE_TYPES = new Set(['claim', 'gap', 'question', 'method', 'dataset', 'metric', 'task', 'observation', ...SOURCE_TYPES])
const RELATIONS = new Set(['reports', 'supports', 'qualifies', 'contradicts', 'identifies'])
// v1 作业快照没有端点合同，仍按原映射读取；新题库把同一合同写入可编辑资产。
const LEGACY_ENDPOINTS = freeze({
  method_data: { subject_type: 'method', object_type: 'dataset', relation: null, direction: 'none' },
  method_result: { subject_type: 'method', object_type: 'observation', relation: 'produced_by', direction: 'object-to-subject' },
  data_result: { subject_type: 'dataset', object_type: 'observation', relation: 'observed_on', direction: 'object-to-subject' },
  metric_result: { subject_type: 'metric', object_type: 'observation', relation: 'measured_by', direction: 'object-to-subject' },
  task_result: { subject_type: 'task', object_type: 'observation', relation: 'for_task', direction: 'object-to-subject' },
})
const fail = message => Object.assign(new Error(message), { code: 'READING_PROTOCOL_INVALID', status: 400 })
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const digest = value => createHash('sha256').update(typeof value === 'string' ? value : canonical(value)).digest('hex')
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (isObject(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value) }
  return value
}
function text(value, max = 4000) { return typeof value === 'string' && value.length <= max && !value.includes('\0') && !!value.trim() }
function endpointProjection(question, option) {
  return question.id === 'q5' ? option.graph?.endpoints ?? LEGACY_ENDPOINTS[option.id] : undefined
}
function promptProjection(question, option) {
  if (option.neutral) return { graph_claim: false }
  const type = option.graph.node_type
  const hasStatement = !SOURCE_TYPES.has(type) && type !== 'question'
  return {
    node_type: type,
    ...(hasStatement ? { evidence_target_type: type === 'gap' ? 'gap' : 'claim',
      evidence_relation: ['claim', 'gap'].includes(type) ? option.graph.relation ?? 'reports' : 'reports' } : {}),
    ...(option.graph.source_status ? { source_status: option.graph.source_status } : {}),
    ...(endpointProjection(question, option) ? { endpoints: endpointProjection(question, option) } : {}),
  }
}

/** 每次启动读取当前人工版本；运行中持有冻结对象与内容哈希，避免中途改题。 */
export function loadQuestionnaire(directory = DIRECTORY) {
  const read = name => {
    const raw = readFileSync(new URL(name, directory), 'utf8')
    if (Buffer.byteLength(raw) > 64000) throw fail(`问题配置过大：${name}`)
    return JSON.parse(raw)
  }
  const protocol = read('protocol.json'), questions = QUESTION_IDS.map(id => read(`${id}.json`))
  if (!text(protocol.version, 100) || !Array.isArray(protocol.rules) || !protocol.rules.length || protocol.rules.some(rule => !text(rule)) || !isObject(protocol.templates)) throw fail('阅读协议缺少版本或规则。')
  if (protocol.codebook_required !== undefined && typeof protocol.codebook_required !== 'boolean') throw fail('codebook_required 必须是布尔值。')
  for (const key of ['intro', 'questions_heading', 'rules_heading', 'output_heading', 'sources_heading', 'sources_end', 'scope_label', 'source_label']) {
    if (!text(protocol.templates[key], 500)) throw fail(`阅读协议缺少模板：${key}`)
  }
  const bounds = { max_answers: 48, max_evidence_per_answer: 8, max_quote_characters: 4000, max_judgment_characters: 4000, max_response_bytes: 200000 }
  for (const [key, maximum] of Object.entries(bounds)) if (!Number.isInteger(protocol.limits?.[key]) || protocol.limits[key] < 1 || protocol.limits[key] > maximum) throw fail(`阅读协议预算无效：${key}`)
  if (!Array.isArray(protocol.common_options) || !['other', 'not_reported', 'not_applicable'].every(id => protocol.common_options.some(option => option.id === id))) throw fail('公共选项必须包含其他、未报告与不适用。')
  for (const [index, question] of questions.entries()) {
    if (question.id !== QUESTION_IDS[index] || !text(question.question) || !text(question.title, 100) || !text(question.guidance) || !Array.isArray(question.options) || !question.options.length || question.options.length > 20) throw fail('问题定义无效。')
    const ids = new Set()
    for (const option of [...question.options, ...protocol.common_options]) {
      if (!isObject(option) || !/^[a-z][a-z_]*$/.test(option.id) || ids.has(option.id) || !text(option.label, 500)) throw fail(`问题 ${question.id} 的选项标识无效或重复。`)
      ids.add(option.id)
      if (['not_reported', 'not_applicable'].includes(option.id) !== (option.neutral === true)) throw fail('仅未报告和不适用选项可免除证据要求。')
      if (!option.neutral && (!NODE_TYPES.has(option.graph?.node_type) || option.graph?.relation && !RELATIONS.has(option.graph.relation))) throw fail(`问题 ${question.id} 的图谱映射无效。`)
      if (option.graph?.source_status && (!['author-stated', 'inferred'].includes(option.graph.source_status) || !['gap', 'question'].includes(option.graph.node_type))) throw fail('问题来源归属无效。')
      if (option.id === 'other' && option.requires_judgment !== true) throw fail('其他选项必须要求判断内容。')
      if (protocol.codebook_required || option.coding !== undefined) {
        if (!isObject(option.coding) || Object.keys(option.coding).some(key => !['definition', 'include_when', 'exclude_when'].includes(key)) ||
          ['definition', 'include_when', 'exclude_when'].some(key => !text(option.coding[key], 1500))) throw fail(`问题 ${question.id} 的编码手册缺少定义、适用或排除条件。`)
      }
      if (option.graph?.endpoints !== undefined) {
        if (question.id !== 'q5' || option.graph.node_type !== 'claim' || option.graph.relation !== 'reports' ||
          !Object.values(LEGACY_ENDPOINTS).some(value => canonical(value) === canonical(option.graph.endpoints)) ||
          LEGACY_ENDPOINTS[option.id] && canonical(option.graph.endpoints) !== canonical(LEGACY_ENDPOINTS[option.id])) throw fail(`问题 ${question.id} 的关系端点类型或方向不受支持。`)
      }
      if (protocol.codebook_required && question.id === 'q5' && LEGACY_ENDPOINTS[option.id] && !option.graph?.endpoints) throw fail('q5 编码手册必须包含关系端点合同。')
    }
    if (protocol.codebook_required || question.examples !== undefined) {
      if (!Array.isArray(question.examples) || !question.examples.length || question.examples.length > 3 || question.examples.some(example =>
        !isObject(example) || Object.keys(example).some(key => !['source_text', 'choice', 'judgment', 'reason', 'subject', 'object'].includes(key)) ||
        !ids.has(example.choice) || ['source_text', 'judgment', 'reason'].some(key => !text(example[key], 1500)) ||
        (example.subject !== undefined || example.object !== undefined) && (question.id !== 'q5' || !text(example.subject, 500) || !text(example.object, 500) ||
          !example.source_text.includes(example.subject) || !example.source_text.includes(example.object)))) throw fail(`问题 ${question.id} 的合成编码示例无效。`)
    }
  }
  const config = { version: protocol.version, protocol, questions }
  questionGroups(config)
  return freeze({ ...config, hash: digest(config) })
}

export function questionGroups(config, options = {}) {
  const available = config.questions.map(question => question.id)
  const selected = options.question_ids ?? available
  if (!Array.isArray(selected) || !selected.length || selected.length > available.length || new Set(selected).size !== selected.length || selected.some(id => !available.includes(id))) throw fail('question_ids 必须是非空、不重复的已知问题列表。')
  const mode = options.question_mode ?? 'grouped'
  if (!['grouped', 'separate'].includes(mode)) throw fail('question_mode 只能是 grouped 或 separate。')
  const defaults = config.protocol.default_groups
  if (!Array.isArray(defaults) || defaults.some(group => !Array.isArray(group) || !group.length || group.length > 2) || canonical(defaults.flat().toSorted()) !== canonical(available.toSorted())) throw fail('默认分组必须恰好覆盖所有问题，每组至多两个。')
  return mode === 'separate' ? selected.map(id => [id]) : defaults.map(group => group.filter(id => selected.includes(id))).filter(group => group.length)
}

function selectedQuestions(config, ids) {
  questionGroups(config, { question_ids: ids })
  return ids.map(id => config.questions.find(question => question.id === id))
}
function sourceMap(pack) {
  if (!Array.isArray(pack.sources) || !pack.sources.length || pack.sources.length > 40 || pack.sources.some(source => !text(source.id, 200) || typeof source.text !== 'string' || source.text.includes('\0')) || new Set(pack.sources.map(source => source.id)).size !== pack.sources.length || pack.sources.reduce((sum, source) => sum + source.text.length, 0) > 24000) throw fail('阅读来源缺失、重复或超出 24,000 字符预算。')
  if (pack.source_ids && (!Array.isArray(pack.source_ids) || canonical([...pack.source_ids].sort()) !== canonical(pack.sources.map(source => source.id).sort()))) throw fail('阅读来源列表与快照不一致。')
  const aliases = new Map(pack.sources.map((source, index) => [`S${index + 1}`, source]))
  const byId = new Map(pack.sources.map(source => [source.id, source]))
  return { aliases, byId }
}

export function makeReadingPrompt(pack, questionIds, config = loadQuestionnaire()) {
  const { aliases } = sourceMap(pack), { templates, rules } = config.protocol
  const questions = selectedQuestions(config, questionIds).map(question => ({
    question_id: question.id, question: question.question, guidance: question.guidance,
    options: [...question.options, ...config.protocol.common_options].map(option => ({ choice: option.id, meaning: option.label,
      ...(option.coding ? { coding: option.coding } : {}), projection: promptProjection(question, option) })),
    ...(question.examples ? { coding_examples: question.examples } : {}),
  }))
  // 不传递整个 paper 对象：它可能带私人自定义字段或完整元数据。
  const scope = { pages: pack.sources.map(source => source.locator?.page ?? null), scope: 'only-provided-pages',
    representation: pack.preprocessing?.representation ?? 'extracted-text', raw_pdf_verbatim: pack.preprocessing?.raw_verbatim === true }
  const sources = [...aliases].map(([alias, source]) => `${templates.source_label} ${alias} | page=${source.locator?.page ?? 'unknown'}\n${source.text}\n`).join('\n')
  const renderedRules = rules.join('\n').replaceAll('{{max_answers}}', String(config.protocol.limits.max_answers))
  const example = JSON.stringify(config.protocol.output_example).replaceAll('{{question_id}}', questions[0].question_id).replaceAll('{{choice}}', questions[0].options[0].choice)
  return `${templates.intro}\n${templates.scope_label}: ${JSON.stringify(scope)}\n${templates.rules_heading}:\n${renderedRules}\n${templates.questions_heading}:\n${JSON.stringify(questions, null, 2)}\n${templates.output_heading}:\n${example}\n${templates.sources_heading}\n${sources}\n${templates.sources_end}`
}

function collapsed(text) {
  let value = '', starts = [], ends = []
  for (const match of text.matchAll(/\s+|\S/gu)) {
    const part = /^\s/u.test(match[0]) ? ' ' : match[0]
    value += part
    for (let index = 0; index < part.length; index++) { starts.push(match.index); ends.push(match.index + match[0].length) }
  }
  return { value, starts, ends }
}
function uniqueIndex(text, quote) {
  const index = text.indexOf(quote)
  return index >= 0 && text.indexOf(quote, index + 1) < 0 ? index : -1
}
/** 只恢复唯一空白匹配，不改字符、标点、断词或 Markdown。偏移使用 JS UTF-16。 */
function locateQuote(source, submitted, cache) {
  let start = uniqueIndex(source.text, submitted)
  if (start >= 0) return { quote: submitted, start_utf16: start, end_utf16: start + submitted.length, match: 'exact' }
  // 字面片段重复时不猜页内位置，即使折叠空白后碰巧变成唯一也不允许。
  if (source.text.includes(submitted)) return null
  if (!cache.has(source.id)) cache.set(source.id, collapsed(source.text))
  const mapped = cache.get(source.id), normalized = submitted.replace(/\s+/gu, ' ')
  const index = uniqueIndex(mapped.value, normalized)
  if (index < 0) return null
  start = mapped.starts[index]
  const end = mapped.ends[index + normalized.length - 1]
  if (start === undefined || end === undefined) return null
  const quote = source.text.slice(start, end)
  if (quote.replace(/\s+/gu, ' ') !== normalized) return null
  return { quote, start_utf16: start, end_utf16: end, match: 'unique-whitespace' }
}

/** 单条失败保留诊断；不让一个无效字段抹掉其他已定位的阅读回答。 */
export function parseReadingAnswers(raw, pack, questionIds, config = loadQuestionnaire()) {
  const { aliases, byId } = sourceMap(pack), requested = selectedQuestions(config, questionIds), limits = config.protocol.limits
  const output = { answers: [], errors: [], missing: [], raw, question_ids: [...questionIds], questionnaire_version: config.version, questionnaire_hash: config.hash }
  let parsed
  try {
    if (typeof raw !== 'string' || Buffer.byteLength(raw) > limits.max_response_bytes) throw fail('回答不是字符串或超出响应预算。')
    const match = raw.trim().match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i)
    parsed = JSON.parse(match ? match[1] : raw)
    if (!isObject(parsed) || !Array.isArray(parsed.answers)) throw fail('回答必须包含 answers 数组。')
  } catch (error) {
    output.errors.push({ code: 'INVALID_RESPONSE', message: error.code ? error.message : '回答不是完整 JSON 对象。' })
    output.missing = [...questionIds]
    if (typeof raw === 'string' && Buffer.byteLength(raw) > limits.max_response_bytes) { output.raw = raw.slice(0, limits.max_response_bytes / 4); output.raw_truncated = true }
    return output
  }
  if (Object.keys(parsed).some(key => key !== 'answers')) output.errors.push({ code: 'UNEXPECTED_RESPONSE_FIELDS', message: 'answers 以外的字段未被采用。' })
  if (parsed.answers.length > limits.max_answers) output.errors.push({ code: 'ANSWER_LIMIT', message: `只校验前 ${limits.max_answers} 条回答；原始响应完整保留。`, omitted: parsed.answers.length - limits.max_answers })
  const cache = new Map(), seen = new Set()
  for (const [index, item] of parsed.answers.slice(0, limits.max_answers).entries()) {
    const record = { id: `ra-${digest([config.hash, pack.sources.map(source => [source.id, source.content_hash ?? digest(source.text)]), item]).slice(0, 24)}`,
      question_id: item?.question_id, choice: item?.choice, judgment: '', evidence: [], status: 'needs-review', valid: false, errors: [], raw: item,
      questionnaire_version: config.version, questionnaire_hash: config.hash,
      scope: { source_ids: pack.sources.map(source => source.id), pages: pack.sources.map(source => source.locator?.page ?? null), full_document: false } }
    const invalid = (code, message) => record.errors.push({ code, message })
    const question = requested.find(question => question.id === item?.question_id)
    if (!isObject(item)) invalid('INVALID_ANSWER', '回答必须是对象。')
    if (!question) invalid('UNKNOWN_QUESTION', '回答引用了未请求的问题。')
    const option = question && [...question.options, ...config.protocol.common_options].find(option => option.id === item?.choice)
    if (!option) invalid('UNKNOWN_CHOICE', '选项不在当前问题的选项表中。')
    if (isObject(item) && Object.keys(item).some(key => !['question_id', 'choice', 'judgment', 'free_text', 'evidence', 'subject', 'object'].includes(key))) invalid('UNEXPECTED_ANSWER_FIELDS', '回答包含协议之外的字段。')
    const judgment = item?.judgment ?? item?.free_text ?? ''
    if (typeof judgment !== 'string' || judgment.length > limits.max_judgment_characters || judgment.includes('\0')) invalid('INVALID_JUDGMENT', '判断不是文本或超出长度限制。')
    else record.judgment = judgment.trim()
    if (item?.judgment !== undefined && item?.free_text !== undefined && item.judgment !== item.free_text) invalid('CONFLICTING_JUDGMENT', 'judgment 与 free_text 内容冲突。')
    if ((option?.requires_judgment || item?.question_id === 'q4' && !option?.neutral) && !record.judgment) invalid('JUDGMENT_REQUIRED', '此选项必须说明具体判断。')
    if (item?.evidence !== undefined && !Array.isArray(item.evidence)) invalid('INVALID_EVIDENCE', 'evidence 必须是数组。')
    const refs = Array.isArray(item?.evidence) ? item.evidence : []
    if (refs.length > limits.max_evidence_per_answer) invalid('EVIDENCE_LIMIT', '单条回答的证据数超出限制。')
    for (const ref of refs.slice(0, limits.max_evidence_per_answer)) {
      const source = aliases.get(ref?.source_id) ?? byId.get(ref?.source_id)
      if (!isObject(ref) || Object.keys(ref).some(key => !['source_id', 'quote'].includes(key)) || !source || !text(ref.quote, limits.max_quote_characters)) { invalid('INVALID_SOURCE', '证据缺少当前来源或有效引文。'); continue }
      const match = locateQuote(source, ref.quote, cache)
      if (!match || match.quote.length > limits.max_quote_characters) { invalid('QUOTE_NOT_LOCATED', '引文不是当前来源内唯一且预算内的原文或空白等价片段。'); continue }
      record.evidence.push({ source_id: source.id, page: source.locator?.page ?? null, submitted_quote: ref.quote, ...match,
        source_content_hash: source.content_hash ?? digest(source.text), representation: pack.preprocessing?.representation ?? 'extracted-text',
        raw_pdf_verbatim: pack.preprocessing?.raw_verbatim === true })
    }
    if (!option?.neutral && !record.evidence.length) invalid('EVIDENCE_REQUIRED', '肯定回答至少需要一条可定位的证据。')
    if (item?.subject !== undefined || item?.object !== undefined) {
      if (item?.question_id !== 'q5' || !text(item.subject, 500) || !text(item.object, 2000)) invalid('INVALID_ENDPOINTS', '仅 q5 可同时提供有界 subject 和 object。')
      else {
        const index = record.evidence.findIndex(ref => [item.subject, item.object].every(label => ref.quote.replace(/\s+/gu, ' ').includes(label.replace(/\s+/gu, ' '))))
        if (index < 0) invalid('ENDPOINT_NOT_IN_EVIDENCE', '关系两端必须原样出现在本回答的同一条已定位证据中。')
        else { record.subject = item.subject; record.object = item.object; record.relation_evidence_index = index }
      }
    }
    if (seen.has(record.id)) invalid('DUPLICATE_ANSWER', '重复的同一回答。')
    seen.add(record.id)
    record.valid = !record.errors.length
    record.neutral = option?.neutral === true
    output.answers.push(record)
    if (record.errors.length) output.errors.push({ code: 'ANSWER_INVALID', index, answer_id: record.id, question_id: record.question_id, errors: record.errors })
  }
  output.missing = questionIds.filter(id => !output.answers.some(answer => answer.question_id === id))
  for (const id of output.missing) output.errors.push({ code: 'MISSING_QUESTION', question_id: id, message: '请求的问题没有回答。' })
  return output
}

/** 固定类型投影；图谱预算按完整回答裁切，并返回每个未投影回答的原因。 */
export function compileReadingGraph(input, pack, config = loadQuestionnaire()) {
  const answers = Array.isArray(input) ? input : input.answers
  if (!Array.isArray(answers)) throw fail('编译需要已校验的阅读回答。')
  const { byId } = sourceMap(pack)
  const graph = { title: '阅读问题与证据草稿', body: '', nodes: [], edges: [], assertions: [],
    compilation: { questionnaire_version: config.version, questionnaire_hash: config.hash, included_answer_ids: [], excluded_answers: [], limitations: [], truncated: false } }
  const included = new Set(), nodeKeys = new Set(), relationKeys = new Set(), body = []
  for (const answer of answers) {
    const reject = reason => graph.compilation.excluded_answers.push({ answer_id: answer?.id ?? null, reason })
    if (!answer?.valid || answer.questionnaire_hash !== config.hash) { reject('invalid-or-different-questionnaire'); continue }
    if (answer.neutral) { reject('neutral-scope-record-no-graph-claim'); continue }
    if (included.has(answer.id)) continue
    const question = config.questions.find(question => question.id === answer.question_id)
    const option = question && [...question.options, ...config.protocol.common_options].find(option => option.id === answer.choice)
    if (!option || !answer.evidence?.length || answer.evidence.some(ref => !byId.has(ref.source_id) || byId.get(ref.source_id).text.slice(ref.start_utf16, ref.end_utf16) !== ref.quote)) { reject('evidence-no-longer-matches-selected-source'); continue }
    const label = answer.judgment || answer.evidence[0].quote
    const fields = { question_id: answer.question_id, choice: answer.choice, answer_id: answer.id, questionnaire_version: config.version, questionnaire_hash: config.hash }
    const local = { nodes: [], edges: [], assertions: [] }
    const key = digest(answer.id).slice(0, 20)
    const node = (type, name, suffix, extra = {}) => {
      const value = { id: `rq-${key}-${suffix}`, type, label: name, fields: { ...fields }, ...extra }
      local.nodes.push(value)
      return `${type}:${value.id}`
    }
    const sourceType = SOURCE_TYPES.has(option.graph.node_type) ? option.graph.node_type : 'evidence'
    const evidence = answer.evidence.map((ref, index) => node(sourceType, sourceType === 'evidence' ? `来源片段 ${index + 1}` : label,
      `source-${index + 1}`, { source_id: ref.source_id, quote: ref.quote,
        fields: { ...fields, page: ref.page, start_utf: ref.start_utf16, end_utf: ref.end_utf16, source_representation: ref.representation, raw_pdf_verbatim: ref.raw_pdf_verbatim } }))
    const assertion = (target, relation = 'reports') => evidence.forEach((subject, index) => local.assertions.push({ subject, object: target, relation,
      source_id: answer.evidence[index].source_id, surface: `待审阅的 ${answer.question_id} 阅读判断；引文存在不等于判断已成立。` }))
    const type = option.graph.node_type
    if (!SOURCE_TYPES.has(type)) {
      const target = node(type, label, 'judgment', {
        ...(type === 'observation' ? { source_node: evidence[0] } : {}),
        ...(option.graph.source_status ? { source_status: option.graph.source_status } : {}),
        fields: { ...fields, evidence_node: evidence[0] },
      })
      if (['claim', 'gap'].includes(type)) assertion(target, option.graph.relation)
      else if (type !== 'question') {
        const claim = node('claim', label, 'reported-statement', { fields: { ...fields, extracted_node: target } })
        assertion(claim, 'reports')
      }
      if (answer.question_id === 'q5') {
        const mapping = endpointProjection(question, option)
        if (answer.subject && answer.object && mapping?.direction === 'object-to-subject') {
          const relationIndex = answer.relation_evidence_index ?? 0
          const entity = node(mapping.subject_type, answer.subject, 'relation-subject')
          const observation = node(mapping.object_type, answer.object, 'relation-result', { source_node: evidence[relationIndex] })
          local.edges.push({ subject: observation, object: entity, relation: mapping.relation, source_id: answer.evidence[relationIndex].source_id, surface: label })
        } else {
          if (answer.subject && answer.object && mapping?.direction === 'none') {
            node(mapping.subject_type, answer.subject, 'relation-subject')
            node(mapping.object_type, answer.object, 'relation-object')
          }
          graph.compilation.limitations.push({ answer_id: answer.id, code: answer.subject && answer.object ? 'NO_SAFE_TYPED_RELATION' : 'RELATION_ENDPOINTS_NOT_PROVIDED',
            message: '关系判断及证据已保留；现有图谱类型或明确端点不足，未猜测实体连线。' })
        }
      }
    }
    const nextBody = [...body, `${question.id} · ${question.title} · ${option.label}\n${label}`].join('\n\n')
    if (graph.nodes.length + local.nodes.length > 80 || graph.edges.length + local.edges.length > 160 || graph.assertions.length + local.assertions.length > 80 || Buffer.byteLength(nextBody) > 48000 || Buffer.byteLength(JSON.stringify({ nodes: [...graph.nodes, ...local.nodes], edges: [...graph.edges, ...local.edges], assertions: [...graph.assertions, ...local.assertions], body: nextBody })) > 160000) {
      graph.compilation.truncated = true; reject('graph-budget-whole-answer-omitted'); continue
    }
    for (const item of local.nodes) {
      const id = `${item.type}:${item.id}`
      if (!nodeKeys.has(id)) { graph.nodes.push(item); nodeKeys.add(id) }
    }
    for (const category of ['edges', 'assertions']) for (const item of local[category]) {
      const id = canonical([category, item.subject, item.object, item.relation])
      if (!relationKeys.has(id)) { graph[category].push(item); relationKeys.add(id) }
    }
    included.add(answer.id); graph.compilation.included_answer_ids.push(answer.id)
    body.push(`${question.id} · ${question.title} · ${option.label}\n${label}`)
  }
  graph.body = body.join('\n\n')
  return graph
}

/** 仅做本地候选汇总；来源保留，生效问题库只能由人工修改。 */
export function summarizeOptionCandidates(answerRecords, config = loadQuestionnaire()) {
  if (!Array.isArray(answerRecords) || answerRecords.length > 10000) throw fail('候选汇总只接受至多 10,000 条显式阅读记录。')
  const candidates = new Map(), origins = new Set()
  let inspected = 0, truncated = false
  for (const answer of answerRecords) {
    inspected++
    if (!answer?.valid || answer.choice !== 'other' || answer.questionnaire_hash !== config.hash || !text(answer.judgment, config.protocol.limits.max_judgment_characters) || origins.has(answer.id)) continue
    origins.add(answer.id)
    const normalized = answer.judgment.trim().replace(/\s+/gu, ' '), key = canonical([answer.question_id, normalized])
    if (!candidates.has(key)) {
      if (candidates.size >= 200) { truncated = true; continue }
      candidates.set(key, { question_id: answer.question_id, proposed_description: normalized, count: 0, origins: [], status: 'needs-human-review' })
    }
    const candidate = candidates.get(key)
    candidate.count++
    if (candidate.origins.length < 20) candidate.origins.push({ answer_id: answer.id, source_ids: answer.evidence.map(ref => ref.source_id), questionnaire_hash: answer.questionnaire_hash })
    else candidate.origins_truncated = true
  }
  return { questionnaire_version: config.version, questionnaire_hash: config.hash, inspected, candidates: [...candidates.values()], truncated, active_config_changed: false }
}
