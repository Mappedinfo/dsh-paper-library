#!/usr/bin/env node
// Read-only, bounded diagnostics for a saved paper-analysis run.
import { constants } from 'node:fs'
import { open, mkdir, chmod, writeFile, realpath, lstat, readdir } from 'node:fs/promises'
import { resolve, dirname, join, relative, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { createHeadlessAnalysis } from '../src/headless-analysis.mjs'
import { dispatch as defaultDispatch } from '../src/bridge.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MAX_JSON = 8 * 1024 * 1024
const MAX_LAYER_BYTES = 2 * 1024 * 1024
const MAX_UNWRAPS = 8
const SOURCE_NODE_TYPES = new Set(['evidence', 'figure', 'formula'])
const QUOTE_CATEGORIES = ['exact', 'unique-whitespace-equivalent', 'not-found', 'source-id-wrong', 'missing']

const within = (a, b) => {
  const p = relative(a, b)
  return p === '' || (p !== '..' && !p.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(p))
}
const safeError = e => /^[A-Z][A-Z0-9_]{1,100}$/.test(e?.code ?? '') ? e.code : 'DIAGNOSIS_FAILED'

async function readJSON(path, max = MAX_JSON) {
  let handle
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
    const initial = await handle.stat()
    if (!initial.isFile() || initial.size > max) throw new Error('unsafe')
    const buffer = Buffer.alloc(max + 1)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    const final = await handle.stat()
    if (bytesRead !== initial.size || final.size !== initial.size || final.ino !== initial.ino || final.mtimeMs !== initial.mtimeMs) throw new Error('changed')
    return JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'))
  } finally {
    await handle?.close()
  }
}

// This is only for JSON-string layers introduced by audit serialization. It does
// not certify the decoded model payload as a valid object; parseModel does that.
function unwrapAuditStringLayers(value) {
  let current = value
  let layers = 0
  for (; layers < MAX_UNWRAPS && typeof current === 'string'; layers++) {
    const text = current.trim()
    if (!text || Buffer.byteLength(text) > MAX_LAYER_BYTES) break
    try {
      const next = JSON.parse(text)
      if (typeof next !== 'string') {
        current = next
        layers++
        break
      }
      current = next
    } catch {
      break
    }
  }
  return { value: current, layers, limit_reached: layers >= MAX_UNWRAPS && typeof current === 'string' }
}

function contentText(content) {
  if (typeof content === 'string') {
    const decoded = unwrapAuditStringLayers(content)
    if (typeof decoded.value === 'string') return { text: decoded.value, audit_unwrap_layers: decoded.layers, unwrap_limit_reached: decoded.limit_reached }
    return { text: JSON.stringify(decoded.value), audit_unwrap_layers: decoded.layers, unwrap_limit_reached: decoded.limit_reached }
  }
  if (Array.isArray(content)) {
    const parts = content.map(block => typeof block === 'string' ? block : typeof block?.text === 'string' ? block.text : '').filter(Boolean)
    return { text: parts.join('\n'), audit_unwrap_layers: 0, unwrap_limit_reached: false }
  }
  return { text: '', audit_unwrap_layers: 0, unwrap_limit_reached: false }
}

function responseEnvelope(raw) {
  const decoded = unwrapAuditStringLayers(raw)
  const body = decoded.value
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { body: null, text: '', audit_unwrap_layers: decoded.layers, unwrap_limit_reached: decoded.limit_reached, model_payload_wrapped: false }
  }
  let extracted = { text: '', audit_unwrap_layers: 0, unwrap_limit_reached: false }
  const choice = body.choices?.[0]
  if (choice) extracted = contentText(choice.message?.content ?? choice.text)
  if (!extracted.text && Array.isArray(body.content)) extracted = contentText(body.content)
  if (!extracted.text && typeof body.output === 'string') extracted = contentText(body.output)
  if (!extracted.text && Array.isArray(body.output)) extracted = contentText(body.output)
  return {
    body,
    text: extracted.text,
    audit_unwrap_layers: decoded.layers + extracted.audit_unwrap_layers,
    unwrap_limit_reached: decoded.limit_reached || extracted.unwrap_limit_reached,
    model_payload_wrapped: extracted.audit_unwrap_layers > 0,
  }
}

function stripFence(text) {
  const trimmed = text.trim()
  const match = trimmed.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i)
  return match ? match[1] : trimmed
}

function parseModel(text) {
  const clean = stripFence(text)
  const fenced = clean !== text.trim()
  try {
    const value = JSON.parse(clean)
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { value: null, syntax: { kind: 'root_not_object', position: null }, fenced }
    }
    return { value, syntax: null, fenced }
  } catch (error) {
    const message = String(error.message)
    const position = message.match(/position (\d+)/i)?.[1]
    const index = position === undefined ? null : Number(position)
    let kind = /unexpected end/i.test(message) ? 'unexpected_end' : /unexpected token/i.test(message) ? 'unexpected_token' : 'invalid_json'
    if (index !== null && clean.slice(0, index).trim()) {
      try {
        JSON.parse(clean.slice(0, index).trim())
        if (clean.slice(index).trim()) kind = 'trailing_content_after_json'
      } catch {}
    }
    const trimmed = text.trimStart()
    const opener = trimmed.match(/^```(?:json)?\s*\n/i)
    if (opener) {
      let cursor = opener[0].length
      while ((cursor = trimmed.indexOf('\n```', cursor)) !== -1) {
        const candidateText = trimmed.slice(opener[0].length, cursor)
        try {
          const candidate = JSON.parse(candidateText)
          if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
            const suffix = trimmed.slice(cursor + 4)
            return {
              value: null,
              syntax: {
                kind: suffix.trim() ? 'valid_json_fence_with_trailing_text' : 'json_fence_not_supported',
                position: text.length - trimmed.length,
                embedded_json_valid: true,
                leading_chars: text.length - trimmed.length,
                trailing_chars: suffix.length,
              },
              fenced: true,
            }
          }
        } catch {}
        cursor += 4
      }
    }
    return {
      value: null,
      syntax: {
        kind,
        position: index,
      },
      fenced,
    }
  }
}

// Mirrors unique-whitespace-match-v1: collapse whitespace only; preserve all
// other code points and preserve leading/trailing quote whitespace.
const collapseWhitespace = value => value.replace(/\s+/gu, ' ')

function occurrences(haystack, needle) {
  if (!needle) return 0
  let count = 0
  let at = 0
  while ((at = haystack.indexOf(needle, at)) !== -1) {
    count++
    at += Math.max(1, needle.length)
  }
  return count
}

function quoteCheck(ref, sources, expectedPaper) {
  if (typeof ref.source_id !== 'string' || !ref.source_id || typeof ref.quote !== 'string' || !ref.quote) {
    return { category: 'missing', paper_match: null }
  }
  const source = sources.get(ref.source_id)
  if (!source) return { category: 'source-id-wrong', paper_match: null }
  const paperMatch = source.entity?.kind === 'paper' && source.entity?.id === expectedPaper
  if (!paperMatch) return { category: 'source-id-wrong', paper_match: false }
  const text = typeof source.text === 'string' ? source.text : ''
  if (text.includes(ref.quote)) return { category: 'exact', paper_match: true }
  const normalizedQuote = collapseWhitespace(ref.quote)
  const normalizedText = collapseWhitespace(text)
  const count = occurrences(normalizedText, normalizedQuote)
  if (count === 1) return { category: 'unique-whitespace-equivalent', paper_match: true }
  return count === 0
    ? { category: 'not-found', paper_match: true }
    : { category: 'not-found', paper_match: true, normalized_occurrences: count }
}

function structure(value) {
  const issues = []
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { nodes: 0, types: {}, metadata_fields: [], quote_locations: { top_level: 0, fields: 0 }, issues: ['root_not_object'] }
  }
  const graph = value.graph && typeof value.graph === 'object' && !Array.isArray(value.graph) ? value.graph : value
  const nodes = Array.isArray(graph.nodes) ? graph.nodes : []
  const types = {}
  let topLevelQuotes = 0
  let fieldQuotes = 0
  for (const [index, node] of nodes.entries()) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) {
      issues.push(`node_${index}_not_object`)
      continue
    }
    types[node.type ?? '(missing)'] = (types[node.type ?? '(missing)'] ?? 0) + 1
    if (typeof node.quote === 'string' && node.quote) topLevelQuotes++
    if (node.fields && typeof node.fields === 'object' && !Array.isArray(node.fields)) {
      if (Object.hasOwn(node.fields, 'quote')) {
        fieldQuotes++
        issues.push(`node_${index}_quote_inside_fields`)
      }
    } else if (node.fields !== undefined) issues.push(`node_${index}_fields_not_object`)
    if (!node.type) issues.push(`node_${index}_type_missing`)
    if (SOURCE_NODE_TYPES.has(node.type) && !(typeof node.quote === 'string' && node.quote)) issues.push(`node_${index}_evidence_quote_missing`)
  }
  for (const key of ['edges', 'assertions']) if (graph[key] !== undefined && !Array.isArray(graph[key])) issues.push(`${key}_not_array`)
  if (!Array.isArray(graph.nodes)) issues.push('nodes_not_array')
  const metadata = value.metadata && typeof value.metadata === 'object' && !Array.isArray(value.metadata) ? Object.keys(value.metadata) : []
  return {
    nodes: nodes.length,
    types,
    metadata_fields: metadata,
    quote_locations: { top_level: topLevelQuotes, fields: fieldQuotes },
    issues: [...new Set(issues)],
  }
}

function quoteRefs(value) {
  const refs = []
  const graph = value?.graph && typeof value.graph === 'object' && !Array.isArray(value.graph) ? value.graph : value
  for (const [index, node] of (Array.isArray(graph?.nodes) ? graph.nodes : []).entries()) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) continue
    if (typeof node.quote === 'string' && node.quote) {
      refs.push({ group: 'graph', location: 'top_level', required: SOURCE_NODE_TYPES.has(node.type), source_id: node.source_id ?? null, quote: node.quote, node_id: node.id ?? null })
    } else if (SOURCE_NODE_TYPES.has(node.type)) {
      refs.push({ group: 'graph', location: 'top_level', required: true, source_id: node.source_id ?? null, quote: null, node_id: node.id ?? `node-${index}` })
    }
    if (node.fields && typeof node.fields === 'object' && !Array.isArray(node.fields) && Object.hasOwn(node.fields, 'quote')) {
      refs.push({ group: 'graph', location: 'fields', required: false, source_id: node.source_id ?? node.fields.source_id ?? null, quote: typeof node.fields.quote === 'string' ? node.fields.quote : null, node_id: node.id ?? null })
    }
  }
  for (const key of ['edges', 'assertions']) {
    for (const [index, relation] of (Array.isArray(graph?.[key]) ? graph[key] : []).entries()) {
      if (relation && typeof relation === 'object' && (Object.hasOwn(relation, 'quote') || Object.hasOwn(relation, 'source_id'))) {
        if (typeof relation.quote === 'string' && relation.quote) {
          refs.push({ group: 'graph', location: key, required: false, source_id: relation.source_id ?? null, quote: relation.quote, relation_index: index })
        }
      }
    }
  }
  const fieldSources = value?.field_sources
  if (fieldSources && typeof fieldSources === 'object' && !Array.isArray(fieldSources)) {
    for (const [field, entries] of Object.entries(fieldSources)) {
      const rows = Array.isArray(entries) ? entries : [entries]
      for (const [index, row] of rows.entries()) {
        if (!row || typeof row !== 'object' || Array.isArray(row)) {
          refs.push({ group: 'metadata', location: 'field_sources', required: true, field, source_id: null, quote: null, reference_index: index })
          continue
        }
        refs.push({ group: 'metadata', location: 'field_sources', required: true, field, source_id: row.source_id ?? null, quote: typeof row.quote === 'string' ? row.quote : null, reference_index: index })
      }
    }
  }
  for (const field of Object.keys(value?.metadata && typeof value.metadata === 'object' && !Array.isArray(value.metadata) ? value.metadata : {})) {
    if (!Object.hasOwn(fieldSources ?? {}, field)) {
      refs.push({ group: 'metadata', location: 'field_sources', required: true, field, source_id: null, quote: null, reference_index: 0 })
    } else if (Array.isArray(fieldSources[field]) && fieldSources[field].length === 0) {
      refs.push({ group: 'metadata', location: 'field_sources', required: true, field, source_id: null, quote: null, reference_index: 0 })
    }
  }
  return refs
}

function safeQuoteResult(ref, sources, expectedPaper, allowedSourceIds) {
  if (typeof ref.source_id === 'string' && ref.source_id && !allowedSourceIds.has(ref.source_id)) {
    return { ...ref, ...{ category: 'source-id-wrong', paper_match: false, source_allowed: false } }
  }
  return { ...ref, ...quoteCheck(ref, sources, expectedPaper), source_allowed: ref.source_id ? allowedSourceIds.has(ref.source_id) : false }
}

function countQuotes(rows) {
  return Object.fromEntries(QUOTE_CATEGORIES.map(category => [category, rows.filter(row => row.category === category).length]))
}

async function readReceipts(runDir) {
  let files = []
  try {
    files = (await readdir(join(runDir, 'responses'))).filter(name => /^\d{6}-[\w-]+\.json$/.test(name)).sort()
  } catch {
    return []
  }
  const rows = []
  for (const name of files) {
    try {
      const receipt = await readJSON(join(runDir, 'responses', name), 1024 * 1024)
      const envelope = responseEnvelope(receipt.response_body)
      const parsed = envelope.text.trim() ? parseModel(envelope.text) : { value: null, syntax: null, fenced: false }
      const usage = envelope.body?.usage ?? {}
      const details = usage.completion_tokens_details ?? usage.output_tokens_details ?? {}
      rows.push({
        receipt_file: name,
        call_id: receipt.call_id ?? null,
        status: receipt.status ?? null,
        error_code: receipt.error_code ?? receipt.transport_error ?? null,
        http_status: receipt.http_status ?? null,
        analysis_context: receipt.analysis_context ?? null,
        stage: receipt.analysis_context?.stage ?? null,
        paper_id: receipt.analysis_context?.id ?? null,
        batch_index: receipt.analysis_context?.batch_index ?? null,
        requested_model: receipt.model ?? null,
        returned_model: receipt.returned_model ?? envelope.body?.model ?? null,
        finish_reason: envelope.body?.choices?.[0]?.finish_reason ?? envelope.body?.stop_reason ?? null,
        output_tokens: usage.output_tokens ?? usage.completion_tokens ?? null,
        thinking_tokens: details.reasoning_tokens ?? details.thinking_tokens ?? null,
        output_bytes: Buffer.byteLength(envelope.text),
        output_chars: envelope.text.length,
        likely_8192_truncation: envelope.body?.choices?.[0]?.finish_reason === 'length' || usage.output_tokens === 8192 || usage.completion_tokens === 8192,
        audit_unwrap_layers: envelope.audit_unwrap_layers,
        audit_unwrap_limit_reached: envelope.unwrap_limit_reached,
        model_payload_wrapped: envelope.model_payload_wrapped,
        model_json_valid_after_audit_unwrap: parsed.value !== null,
        model_json_boundary: 'Validity is assessed on the text recovered from the audited receipt wrapper; a valid recovered object does not prove whether the provider emitted that text directly or an audit layer stringified it.',
        fenced_json: parsed.fenced,
        parse_error: parsed.syntax,
        shape: parsed.value ? structure(parsed.value) : null,
        refs: parsed.value ? quoteRefs(parsed.value) : [],
        declared_source_ids: Array.isArray(receipt.analysis_context?.source_ids) ? receipt.analysis_context.source_ids : [],
      })
    } catch {
      rows.push({ receipt_file: name, status: 'unreadable', error_code: 'RECEIPT_UNAVAILABLE', refs: [], declared_source_ids: [] })
    }
  }
  return rows
}

async function inspectOutput({ planPath, runDir, outDir, supersedes = null, createAnalysis, dispatch }) {
  for (const path of [planPath, runDir, outDir]) if (!isAbsolute(path)) throw new Error('DIAG_PATH_INVALID')
  const [plan, progress, manifest] = await Promise.all([
    readJSON(planPath, 1024 * 1024),
    readJSON(join(runDir, 'progress.json')),
    readJSON(join(runDir, 'run-manifest.json')),
  ])
  const project = await realpath(ROOT)
  const requestedOut = resolve(outDir)
  const parent = await realpath(dirname(requestedOut))
  const output = join(parent, requestedOut.split(/[\\/]/).at(-1))
  for (const protectedPath of [project, resolve(plan.library), resolve(runDir)]) {
    if (within(protectedPath, output)) throw new Error('DIAG_OUTPUT_UNSAFE')
  }
  for (let cursor = parent; ; cursor = dirname(cursor)) {
    try {
      await lstat(join(cursor, '.git'))
      throw new Error('DIAG_OUTPUT_IN_GIT')
    } catch (error) {
      if (error.message === 'DIAG_OUTPUT_IN_GIT') throw error
      if (error.code !== 'ENOENT') throw error
    }
    if (dirname(cursor) === cursor) break
  }
  await mkdir(output, { mode: 0o700 })
  await chmod(output, 0o700)

  const analysis = await createAnalysis({ library: plan.library, python: plan.python, localStateHome: plan.localStateHome })
  const calls = await readReceipts(runDir)
  const progressById = new Map((progress.papers ?? []).map(row => [row.id, row]))
  const callsByPaper = new Map()
  for (const call of calls) {
    if (!call.paper_id) continue
    const list = callsByPaper.get(call.paper_id) ?? []
    list.push(call)
    callsByPaper.set(call.paper_id, list)
  }
  const sourceCache = new Map()
  const papers = []

  try {
    for (const route of plan.routes ?? []) {
      for (const id of route.ids ?? []) {
        const progressRow = progressById.get(id)
        const manifestRoute = manifest.routes?.find(row => row.name === route.name)
        const requestId = manifestRoute?.request_id
          ? `batch-${createHash('sha256').update(JSON.stringify([manifestRoute.request_id, id])).digest('hex')}`
          : null
        let record = null
        let readError = null
        if (requestId) {
          try {
            record = await analysis({ action: 'paper_analysis_get', id, request_id: requestId })
          } catch (error) {
            readError = safeError(error)
          }
        }
        const paperCalls = callsByPaper.get(id) ?? []
        const paperQuoteRows = []
        const batches = []
        for (const call of paperCalls) {
          const allowedSourceIds = new Set(call.declared_source_ids)
          const callQuoteRows = []
          for (const ref of call.refs ?? []) {
            if (typeof ref.quote !== 'string' || !ref.quote || typeof ref.source_id !== 'string' || !ref.source_id || !allowedSourceIds.has(ref.source_id)) continue
            if (!sourceCache.has(ref.source_id)) {
              try {
                sourceCache.set(ref.source_id, await dispatch({ action: 'knowledge_source_get', id: ref.source_id }, { library: plan.library, python: plan.python }))
              } catch {
                sourceCache.set(ref.source_id, null)
              }
            }
            const result = safeQuoteResult(ref, sourceCache, id, allowedSourceIds)
            callQuoteRows.push(result)
            paperQuoteRows.push(result)
          }
          for (const ref of (call.refs ?? []).filter(row => typeof row.quote !== 'string' || !row.quote || !row.source_id || !allowedSourceIds.has(row.source_id))) {
            const result = safeQuoteResult(ref, sourceCache, id, allowedSourceIds)
            callQuoteRows.push(result)
            paperQuoteRows.push(result)
          }
          call.quote_checks = callQuoteRows
          const requiredQuoteRows = callQuoteRows.filter(row => row.required)
          const additionalQuoteRows = callQuoteRows.filter(row => !row.required)
          batches.push({
            batch_index: call.batch_index,
            call_id: call.call_id,
            status: call.status,
            error_code: call.error_code,
            structure: call.shape,
            quote_counts: countQuotes(requiredQuoteRows),
            graph_quote_counts: countQuotes(requiredQuoteRows.filter(row => row.group === 'graph')),
            metadata_quote_counts: countQuotes(requiredQuoteRows.filter(row => row.group === 'metadata')),
            additional_quote_counts: countQuotes(additionalQuoteRows),
            quote_checks: callQuoteRows.map(({ quote, ...row }) => row),
          })
        }
        const distinctBatches = new Set(paperCalls.filter(call => Number.isInteger(call.batch_index)).map(call => call.batch_index)).size
        papers.push({
          id,
          route: route.name,
          job_status: record?.status ?? progressRow?.status ?? 'unavailable',
          job_error: record?.error ?? progressRow?.error ?? readError,
          batch_count: record?.batch_count ?? progressRow?.batch_count ?? distinctBatches,
          job_warnings: record?.warnings ?? progressRow?.warnings ?? null,
          quote_counts: countQuotes(paperQuoteRows.filter(row => row.required)),
          graph_quote_counts: countQuotes(paperQuoteRows.filter(row => row.required && row.group === 'graph')),
          metadata_quote_counts: countQuotes(paperQuoteRows.filter(row => row.required && row.group === 'metadata')),
          additional_quote_counts: countQuotes(paperQuoteRows.filter(row => !row.required)),
          calls: paperCalls.map(call => ({
            receipt_file: call.receipt_file,
            call_id: call.call_id,
            stage: call.stage,
            batch_index: call.batch_index,
            status: call.status,
            error_code: call.error_code,
            requested_model: call.requested_model,
            returned_model: call.returned_model,
            finish_reason: call.finish_reason,
            output_tokens: call.output_tokens,
            thinking_tokens: call.thinking_tokens,
            output_bytes: call.output_bytes,
            output_chars: call.output_chars,
            likely_8192_truncation: call.likely_8192_truncation,
            audit_unwrap_layers: call.audit_unwrap_layers,
            model_payload_wrapped: call.model_payload_wrapped,
            model_json_valid_after_audit_unwrap: call.model_json_valid_after_audit_unwrap,
            model_json_boundary: call.model_json_boundary,
            fenced_json: call.fenced_json,
            parse_error: call.parse_error,
            structure: call.shape,
            quote_counts: countQuotes((call.quote_checks ?? []).filter(row => row.required)),
            graph_quote_counts: countQuotes((call.quote_checks ?? []).filter(row => row.required && row.group === 'graph')),
            metadata_quote_counts: countQuotes((call.quote_checks ?? []).filter(row => row.required && row.group === 'metadata')),
            additional_quote_counts: countQuotes((call.quote_checks ?? []).filter(row => !row.required)),
            quote_checks: (call.quote_checks ?? []).map(({ quote, ...row }) => row),
          })),
          batches,
        })
      }
    }
  } finally {
    analysis.dispose?.()
  }

  const allQuoteRows = calls.flatMap(call => call.quote_checks ?? [])
  const requiredQuoteRows = allQuoteRows.filter(row => row.required)
  const report = {
    schema: 3,
    created_at: new Date().toISOString(),
    supersedes,
    run_status: progress.status ?? null,
    route: progress.routes?.[0] ?? null,
    paper_count: papers.length,
    call_count: calls.length,
    quote_totals: countQuotes(requiredQuoteRows),
    graph_quote_totals: countQuotes(requiredQuoteRows.filter(row => row.group === 'graph')),
    metadata_quote_totals: countQuotes(requiredQuoteRows.filter(row => row.group === 'metadata')),
    additional_quote_totals: countQuotes(allQuoteRows.filter(row => !row.required)),
    papers,
    calls: calls.map(({ refs, ...call }) => ({
      ...call,
      quote_checks: (call.quote_checks ?? []).map(({ quote, ...row }) => row),
    })),
    limitations: [
      '诊断器只做轻量结构检查，不替代生产 graph validator / draft_lint。',
      '主引用统计仅包括生产要求精确核验的 evidence/figure/formula 顶层 quote 与 metadata field_sources；其余字段和关系引文列在 additional_quote_totals。',
      '来源只会在 receipt.analysis_context.source_ids 明确允许后读取；模型额外输出的 source_id 不会触发来源读取。',
      '审计包装可有界恢复；恢复出的 JSON 对象有效不证明提供商原始响应就是对象，边界保留在每次调用记录中。',
      '回执中不存在的原始模型思考内容不可恢复；思考 token 仅报告 usage 字段。',
      '8192 截断是根据 finish_reason/token 数推断，不能仅凭输出长度证实。',
    ],
  }
  await writeFile(join(output, 'summary.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
  const lines = [
    '# 论文分析运行失败诊断',
    '',
    '此报告来自只读回执与 job 查询；模型输出只用于诊断解析，没有改写原始材料。',
    '',
    `运行状态：${report.run_status}；论文：${papers.length}；模型调用：${calls.length}。`,
    `引用统计：${JSON.stringify(report.quote_totals)}。`,
    ...(supersedes ? [`替代报告：${supersedes}。`] : []),
    '',
    '| Paper ID | Job | Error | batches | calls |',
    '|---|---|---|---:|---:|',
  ]
  for (const paper of papers) lines.push(`| ${paper.id} | ${paper.job_status} | ${paper.job_error ?? '—'} | ${paper.batch_count} | ${paper.calls.length} |`)
  lines.push('', '本工具的结构问题清单仅用于定位常见故障，不代表完整生产验证。JSON 中保留每次调用的结构错误、语法位置和引用类别。', '')
  await writeFile(join(output, 'summary.md'), lines.join('\n'), { mode: 0o600, flag: 'wx' })
  return report
}

export async function diagnostic(options) {
  return inspectOutput({ createAnalysis: createHeadlessAnalysis, dispatch: defaultDispatch, ...options })
}

async function main() {
  const args = process.argv.slice(2)
  const values = new Map()
  if (args.length !== 6 && args.length !== 8) throw new Error('DIAG_CLI_INVALID')
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index]
    if (!['--plan', '--run', '--out', '--supersedes'].includes(flag) || values.has(flag) || !args[index + 1]) throw new Error('DIAG_CLI_INVALID')
    values.set(flag, args[index + 1])
  }
  if (!values.has('--plan') || !values.has('--run') || !values.has('--out') || values.size !== args.length / 2) throw new Error('DIAG_CLI_INVALID')
  const report = await diagnostic({ planPath: values.get('--plan'), runDir: values.get('--run'), outDir: values.get('--out'), supersedes: values.get('--supersedes') ?? null })
  process.stdout.write(`${JSON.stringify({ run_status: report.run_status, paper_count: report.paper_count, call_count: report.call_count, quote_totals: report.quote_totals })}\n`)
}

export { contentText, unwrapAuditStringLayers as decode, parseModel, quoteCheck, quoteRefs, responseEnvelope, structure }

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    process.stderr.write(`${safeError(error)}\n`)
    process.exitCode = 1
  })
}
