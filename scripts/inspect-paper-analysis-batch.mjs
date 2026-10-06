#!/usr/bin/env node
// Read-only verifier for one completed private paper-analysis run.
import { createHash, randomUUID } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { lstat, open, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile as execFileCallback } from 'node:child_process'
import { promisify } from 'node:util'
import { createHeadlessAnalysis } from '../src/headless-analysis.mjs'
import { dispatch as defaultDispatch } from '../src/bridge.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MAX_INPUT = 8 * 1024 * 1024
const MAX_PDF_BYTES = 512 * 1024 * 1024
const execFile = promisify(execFileCallback)
const sha256 = value => createHash('sha256').update(value).digest('hex')
const shortHash = value => sha256(JSON.stringify(value))
const inside = (parent, child) => {
  const part = relative(parent, child)
  return part === '' || part !== '..' && !part.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(part)
}
const safeError = error => /^[A-Z][A-Z0-9_]{1,100}$/.test(error?.code ?? '') ? error.code : 'INSPECTION_FAILED'

async function readJSON(path, maxBytes = MAX_INPUT) {
  let handle
  try {
    handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0))
    const before = await handle.stat()
    if (!before.isFile() || before.size > maxBytes || (before.mode & fsConstants.S_IFMT) !== fsConstants.S_IFREG) throw new Error('unsafe')
    const buffer = Buffer.alloc(maxBytes + 1)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    const after = await handle.stat()
    if (bytesRead !== before.size || bytesRead > maxBytes || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error('changed')
    return JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'))
  } finally { await handle?.close() }
}

async function checkDataLess(path) {
  const source = 'import json, os, stat, sys; s=os.stat(sys.argv[1]); print(json.dumps({"flags": int(getattr(s, "st_flags", 0)), "dataless": bool(int(getattr(s, "st_flags", 0)) & int(getattr(stat, "UF_DATALESS", 0x40000000))) }))'
  const { stdout } = await execFile('uv', ['run', '--offline', '--no-project', 'python', '-B', '-c', source, path],
    { timeout: 15000, maxBuffer: 4096, windowsHide: true })
  const value = JSON.parse(stdout.trim())
  if (typeof value.dataless !== 'boolean') throw new Error('resident_check_invalid')
  return value.dataless
}

export async function hashResidentPdf(entry) {
  if (typeof entry.path !== 'string' || !isAbsolute(entry.path) || !/^[a-f0-9]{64}$/i.test(entry.sha256 ?? '')) return { status: 'invalid_selection' }
  let handle
  try {
    if (await checkDataLess(entry.path)) return { status: 'dataless' }
    const before = await lstat(entry.path, { bigint: true })
    if (!before.isFile() || before.isSymbolicLink()) return { status: 'not_regular' }
    if (before.size > BigInt(MAX_PDF_BYTES)) return { status: 'too_large', size: Number(before.size) }
    handle = await open(entry.path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0))
    const opened = await handle.stat({ bigint: true })
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) return { status: 'changed_before_read' }
    const digest = createHash('sha256'), buffer = Buffer.alloc(1024 * 1024)
    let position = 0
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position)
      if (!bytesRead) break
      digest.update(buffer.subarray(0, bytesRead)); position += bytesRead
    }
    const after = await handle.stat({ bigint: true }), pathAfter = await lstat(entry.path, { bigint: true })
    const same = stat => stat.dev === before.dev && stat.ino === before.ino && stat.size === before.size && stat.mtimeNs === before.mtimeNs && stat.ctimeNs === before.ctimeNs
    if (!same(after) || !same(pathAfter) || BigInt(position) !== before.size) return { status: 'changed_during_read', size: position }
    const actual = digest.digest('hex')
    const matches = actual.toLowerCase() === entry.sha256.toLowerCase()
    return { status: matches ? 'match' : 'hash_mismatch', matches, expected_sha256: entry.sha256.toLowerCase(), actual_sha256: actual,
      size: position, size_matches: entry.size === undefined ? null : BigInt(entry.size) === before.size,
      mtime_ns_matches: entry.mtime_ns === undefined ? null : String(entry.mtime_ns) === String(before.mtimeNs) }
  } catch (error) { return { status: error?.code === 'ENOENT' ? 'missing' : 'unreadable', error_code: safeError(error) } }
  finally { await handle?.close().catch(() => {}) }
}

async function writePrivate(path, text) {
  const dir = dirname(path), temp = join(dir, `.${randomUUID()}.tmp`)
  try {
    await writeFile(temp, text, { mode: 0o600, flag: 'wx' })
    await rename(temp, path)
  } finally { await rm(temp, { force: true }).catch(() => {}) }
}

async function assertOutsideGitWorktree(path) {
  for (let cursor = path;; cursor = dirname(cursor)) {
    try { await lstat(join(cursor, '.git')); throw new Error('INSPECT_OUTPUT_IN_GIT') }
    catch (error) { if (error.message === 'INSPECT_OUTPUT_IN_GIT') throw error; if (error.code !== 'ENOENT') throw error }
    if (dirname(cursor) === cursor) return
  }
}

function pagesComplete(coverage, selection) {
  const requested = coverage?.requested_pages?.length ? coverage.requested_pages : selection?.pages
  if (Array.isArray(requested) && requested.length) {
    const done = new Set(coverage?.completed_pages ?? [])
    return requested.every(page => done.has(page))
  }
  return coverage?.full_document === true
}

function questionCoverageComplete(coverage) {
  if (!coverage || coverage.complete !== true || !Array.isArray(coverage.question_ids) || !coverage.question_ids.length ||
    !coverage.by_question || typeof coverage.by_question !== 'object' || Array.isArray(coverage.by_question)) return false
  return coverage.question_ids.every(id => {
    const row = coverage.by_question[id]
    return row && Number.isSafeInteger(row.expected_batches) && row.expected_batches > 0 && row.answered_batches === row.expected_batches &&
      Array.isArray(row.failed_batches) && row.failed_batches.length === 0 && Array.isArray(row.unread_batches) && row.unread_batches.length === 0
  })
}

function questionState(record) {
  if (!record.questionnaire) return { protocol: 'legacy', status: 'legacy', analysis_complete: null, coverage: null }
  const coverage = record.question_coverage ?? null
  if (record.status === 'partial' || record.analysis_complete === false || coverage?.complete === false) return {
    protocol: 'questionnaire', status: 'partial', analysis_complete: typeof record.analysis_complete === 'boolean' ? record.analysis_complete : null, coverage,
  }
  if (record.analysis_complete !== true || !questionCoverageComplete(coverage)) return {
    protocol: 'questionnaire', status: 'unknown', analysis_complete: typeof record.analysis_complete === 'boolean' ? record.analysis_complete : null, coverage,
  }
  return { protocol: 'questionnaire', status: 'complete', analysis_complete: true, coverage }
}

async function inspectPaper({ analysis, dispatch, library, row, selection, notesRequired = false, skipRecord = false }) {
  const paper = { id: row.id, request_id: row.request_id ?? null, title: selection?.title ?? null,
    status: row.status ?? 'unknown', error: row.error ?? null, error_code: row.error_code ?? null,
    warnings: Array.isArray(row.warnings) ? row.warnings : [], inspection_warnings: [], pdf: await hashResidentPdf(selection ?? {}),
    coverage: null, batch_count: 0, visible_draft_count: 0, last_batch_node_count: 0, note_needs_review: null,
    metadata_suggestion_field_count: 0, evidence_quote_check: { checked: 0, matched: 0, mismatched: 0, unavailable: 0 } }
  if (skipRecord || typeof row.request_id !== 'string' || !row.request_id) {
    paper.inspection_warnings.push(skipRecord ? 'RESULT_ROW_MISSING' : 'REQUEST_ID_MISSING')
    paper.coverage_class = 'failed'
    return paper
  }
  let record
  try {
    record = await analysis({ action: 'paper_analysis_get', id: row.id, request_id: row.request_id })
  } catch (error) {
    paper.record_error = safeError(error)
    paper.inspection_warnings.push('ANALYSIS_RECORD_UNAVAILABLE')
    paper.coverage_class = 'failed'
    return paper
  }
  paper.status = record.status ?? paper.status
  const questions = questionState(record)
  paper.question_protocol = questions.protocol
  paper.question_status = questions.status
  paper.analysis_complete = questions.analysis_complete
  paper.question_coverage = questions.coverage
  paper.error = record.error ?? paper.error
  paper.coverage = record.coverage ? {
    page_count: record.coverage.page_count ?? null,
    read_pages: record.coverage.read_pages ?? [], completed_pages: record.coverage.completed_pages ?? [],
    blank_pages: record.coverage.blank_pages ?? [], truncated_pages: record.coverage.truncated_pages ?? [],
    omitted_pages: record.coverage.omitted_pages ?? [], full_document: record.coverage.full_document === true,
    requested_pages: record.coverage.requested_pages ?? selection?.pages ?? null,
  } : null
  paper.batch_count = record.batch_count ?? 0
  paper.metadata_suggestion_field_count = Object.keys(record.metadata ?? {}).length
  paper.visible_draft_count = [record.draft_id, record.note_draft_id, record.review_draft_id].filter(Boolean).length
  if (record.status === 'failed' || record.status === 'cancelled') paper.coverage_class = 'failed'
  else if (record.status === 'partial' || questions.status === 'partial') paper.coverage_class = 'partial'
  else if (record.status !== 'complete' || questions.status === 'unknown') paper.coverage_class = 'unknown'
  else paper.coverage_class = 'partial'
  if (record.status === 'complete' && !pagesComplete(record.coverage, { pages: selection?.pages })) paper.inspection_warnings.push('COVERAGE_INCOMPLETE')
  if (record.status === 'complete' && record.warnings?.length) paper.inspection_warnings.push('RUN_WARNINGS')
  if (record.status === 'complete' && paper.pdf.status !== 'match') paper.inspection_warnings.push(`PDF_${paper.pdf.status.toUpperCase()}`)

  if (record.note_draft_id) {
    try {
      const note = await dispatch({ action: 'knowledge_draft_get', id: record.note_draft_id }, { library })
      paper.note_needs_review = note.status === 'needs-review'
      if (notesRequired && !paper.note_needs_review) paper.inspection_warnings.push('NOTE_NOT_NEEDS_REVIEW')
    } catch { paper.note_needs_review = false; paper.note_read_error = 'KNOWLEDGE_DRAFT_UNAVAILABLE'; if (notesRequired) paper.inspection_warnings.push('NOTE_UNAVAILABLE') }
  } else if (notesRequired && record.status === 'complete') {
    paper.inspection_warnings.push('NOTE_MISSING')
  }

  if (record.batch_count > 0) {
    try {
      const last = await analysis({ action: 'paper_analysis_get', id: row.id, request_id: row.request_id, batch_index: record.batch_count - 1 })
      const draft = last.draft
      if (draft && Array.isArray(draft.nodes)) {
        paper.last_batch_node_count = draft.nodes.length
        const refs = draft.nodes.filter(node => typeof node.source_id === 'string' && typeof node.quote === 'string' && node.quote.length)
        const unique = new Map()
        for (const ref of refs) {
          const key = `${ref.source_id}\0${ref.quote}`
          if (!unique.has(key)) unique.set(key, ref)
        }
        for (const ref of unique.values()) {
          paper.evidence_quote_check.checked++
          try {
            const source = await dispatch({ action: 'knowledge_source_get', id: ref.source_id }, { library })
            if (source.entity?.kind === 'paper' && source.entity.id === row.id && typeof source.text === 'string' && source.text.includes(ref.quote)) paper.evidence_quote_check.matched++
            else paper.evidence_quote_check.mismatched++
          } catch { paper.evidence_quote_check.unavailable++ }
        }
      } else paper.inspection_warnings.push('LAST_BATCH_DRAFT_UNAVAILABLE')
    } catch { paper.last_batch_read_error = 'ANALYSIS_BATCH_UNAVAILABLE'; paper.inspection_warnings.push('LAST_BATCH_UNAVAILABLE') }
  }
  if (record.status === 'complete' && paper.evidence_quote_check.mismatched) paper.inspection_warnings.push('EVIDENCE_QUOTE_MISMATCH')
  if (record.status === 'complete' && paper.evidence_quote_check.unavailable) paper.inspection_warnings.push('EVIDENCE_SOURCE_UNAVAILABLE')
  if (record.status === 'complete' && paper.coverage_class !== 'unknown') paper.coverage_class = paper.inspection_warnings.length ? 'partial' : 'success'
  return paper
}

function summaryMarkdown(report) {
  const lines = ['# 批量论文整理检查', '', `运行状态：${report.run_status}；检查时间：${report.inspected_at}`, '',
    `覆盖统计：成功 ${report.counts.success} 篇，部分覆盖 ${report.counts.partial} 篇，失败 ${report.counts.failed} 篇${report.counts.unknown ? `，状态未知 ${report.counts.unknown} 篇` : ''}（共 ${report.counts.total} 篇）。`,
    `本机 PDF：哈希匹配 ${report.pdf_counts.match}，不匹配 ${report.pdf_counts.hash_mismatch}，其他异常 ${report.pdf_counts.other}。`, '',
    '| 文献 | 状态 | 问题覆盖 | 页覆盖 | 批次 | 草稿/节点 | 笔记待审 | 元数据建议字段数 | 引文校验 |',
    '|---|---|---|---:|---:|---:|---|---:|---:|']
  for (const item of report.papers) {
    const coverage = item.coverage ? `${item.coverage.completed_pages.length}/${item.coverage.requested_pages?.length ?? item.coverage.page_count ?? '?'}${item.coverage.full_document ? '（全文）' : ''}` : '—'
    const evidence = item.evidence_quote_check
    lines.push(`| ${escapeCell(item.title || item.id)} | ${item.coverage_class} / ${item.status} | ${item.question_status ?? '—'} | ${coverage} | ${item.batch_count} | ${item.visible_draft_count}/${item.last_batch_node_count} | ${item.note_needs_review === null ? '—' : item.note_needs_review ? '是' : '否'} | ${item.metadata_suggestion_field_count} | ${evidence.matched}/${evidence.checked} |`)
  }
  lines.push('', '模型建议值未作为核验事实输出；本报告只统计字段数量和检查保存引文是否能在对应来源中找到。')
  return lines.join('\n') + '\n'
}
function escapeCell(value) { return String(value).replaceAll('|', '\\|').replace(/[\r\n]+/g, ' ') }

export async function inspectBatch({ planPath, runPath, selectionPath, createAnalysis = createHeadlessAnalysis, dispatch = defaultDispatch }) {
  const planFile = resolve(planPath), run = resolve(runPath), selectionFile = resolve(selectionPath)
  if (![planFile, run, selectionFile].every(isAbsolute)) throw new Error('INSPECT_PATH_INVALID')
  const [plan, runnerResult, selected] = await Promise.all([
    readJSON(planFile, 1024 * 1024), readJSON(join(run, 'result.json'), MAX_INPUT), readJSON(selectionFile, MAX_INPUT),
  ])
  if (typeof plan.library !== 'string' || !isAbsolute(plan.library) || !Array.isArray(selected.papers) || !Array.isArray(runnerResult.routes)) throw new Error('INSPECT_INPUT_INVALID')
  const library = await realpath(plan.library), project = await realpath(ROOT), canonicalRun = await realpath(run)
  if (inside(project, canonicalRun) || inside(library, canonicalRun)) throw new Error('INSPECT_OUTPUT_UNSAFE')
  await assertOutsideGitWorktree(canonicalRun)
  const selectionById = new Map(selected.papers.map(item => [item.id, item]))
  const resultRoutes = new Map(runnerResult.routes.map(route => [route.name, route]))
  const analysis = await createAnalysis({ library: plan.library, python: plan.python, localStateHome: plan.localStateHome })
  try {
    const papers = []
    for (const plannedRoute of plan.routes ?? []) {
      const route = resultRoutes.get(plannedRoute.name)
      const rows = new Map((route?.results ?? []).map(row => [row.id, row]))
      const routeRequestId = plan.request_id ? `route-${shortHash([plan.request_id, plannedRoute.name])}` : null
      for (const id of plannedRoute.ids ?? []) {
        const existing = rows.get(id)
        const requestId = existing?.request_id ?? (routeRequestId ? `batch-${shortHash([routeRequestId, id])}` : null)
        const absent = !existing
        const row = existing ? { ...existing, request_id: requestId } : {
          id, request_id: requestId,
          status: route?.status === 'failed' || !route ? 'failed' : 'not_started',
          error: route?.error ?? null, error_code: route?.error_code ?? (route ? 'RESULT_ROW_MISSING' : 'ROUTE_RESULT_MISSING'),
        }
        papers.push(await inspectPaper({ analysis, dispatch, library: plan.library, row,
          selection: selectionById.get(id), notesRequired: plan.notes === true, skipRecord: absent || !requestId }))
      }
    }
    const counts = { total: papers.length, success: papers.filter(item => item.coverage_class === 'success').length,
      partial: papers.filter(item => item.coverage_class === 'partial').length, failed: papers.filter(item => item.coverage_class === 'failed').length,
      ...(papers.some(item => item.coverage_class === 'unknown') ? { unknown: papers.filter(item => item.coverage_class === 'unknown').length } : {}) }
    const pdfCounts = { match: papers.filter(item => item.pdf.status === 'match').length,
      hash_mismatch: papers.filter(item => item.pdf.status === 'hash_mismatch').length,
      other: papers.filter(item => !['match', 'hash_mismatch'].includes(item.pdf.status)).length }
    const report = { schema: 1, run_status: runnerResult.status ?? 'unknown', request_id: runnerResult.request_id ?? null,
      inspected_at: new Date().toISOString(), counts, pdf_counts: pdfCounts,
      routes: (plan.routes ?? []).map(planned => {
        const route = resultRoutes.get(planned.name)
        return { name: planned.name, status: route?.status ?? 'missing', error_code: route?.error_code ?? null,
          error: route?.error ?? null, usage: route?.usage ?? null }
      }),
      calls: Number.isSafeInteger(runnerResult.calls) ? runnerResult.calls : null, papers }
    await writePrivate(join(canonicalRun, 'inspect.json'), JSON.stringify(report, null, 2) + '\n')
    await writePrivate(join(canonicalRun, 'summary.md'), summaryMarkdown(report))
    return report
  } finally { analysis.dispose?.() }
}

async function main() {
  const args = process.argv.slice(2), flags = new Map()
  for (let i = 0; i < args.length; i += 2) {
    if (!['--plan', '--run', '--selection'].includes(args[i]) || flags.has(args[i]) || !args[i + 1]) throw new Error('INSPECT_CLI_INVALID')
    flags.set(args[i], args[i + 1])
  }
  if (flags.size !== 3) throw new Error('INSPECT_CLI_INVALID')
  const result = await inspectBatch({ planPath: flags.get('--plan'), runPath: flags.get('--run'), selectionPath: flags.get('--selection') })
  process.stdout.write(JSON.stringify({ counts: result.counts, pdf_counts: result.pdf_counts, calls: result.calls }) + '\n')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { process.stderr.write(`${safeError(error)}\n`); process.exitCode = 1 })
}
