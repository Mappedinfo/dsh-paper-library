#!/usr/bin/env node
// Read only already-saved candidate summaries from explicit analysis state.
import { constants } from 'node:fs'
import { chmod, lstat, open, realpath, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHeadlessAnalysis } from '../src/headless-analysis.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const VALID_ID = /^[A-Za-z0-9_-]{1,160}$/
const DEFAULT_BATCH_LIMIT = 2000
const DEFAULT_CANDIDATE_LIMIT = 10000
const DEFAULT_ORIGIN_LIMIT = 20000
const fail = code => Object.assign(new Error(code), { code })
const validQuestionId = value => /^q[1-6]$/.test(value ?? '')

async function readJson(path, maximum = 1024 * 1024) {
  let file
  try {
    file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
    const stat = await file.stat()
    if (!stat.isFile() || stat.size > maximum) throw fail('CANDIDATE_INPUT_INVALID')
    const buffer = Buffer.alloc(maximum + 1)
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
    if (bytesRead !== stat.size) throw fail('CANDIDATE_INPUT_INVALID')
    return JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'))
  } finally { await file?.close() }
}

function normalizedDescription(value) {
  return typeof value === 'string' ? value.trim().replace(/\s+/gu, ' ') : ''
}

/** Pure bounded merge for summaries fetched from saved batch state. */
export function mergeOptionCandidates(rows, { maxCandidates = DEFAULT_CANDIDATE_LIMIT, maxOrigins = DEFAULT_ORIGIN_LIMIT } = {}) {
  if (!Array.isArray(rows) || !Number.isSafeInteger(maxCandidates) || maxCandidates < 1 || maxCandidates > 10000 ||
    !Number.isSafeInteger(maxOrigins) || maxOrigins < 1 || maxOrigins > 100000) throw fail('CANDIDATE_INPUT_INVALID')
  const groups = new Map()
  let truncated = false, originCount = 0
  for (const row of rows) {
    const summary = row?.summary
    if (!summary || typeof summary !== 'object' || !/^[a-f0-9]{64}$/i.test(summary.questionnaire_hash ?? '') ||
      typeof summary.questionnaire_version !== 'string' || !summary.questionnaire_version || summary.questionnaire_version.length > 100 || !Array.isArray(summary.candidates)) continue
    truncated ||= summary.truncated === true
    for (const candidate of summary.candidates) {
      const description = normalizedDescription(candidate?.proposed_description)
      if (!description || description.length > 2000 || !validQuestionId(candidate.question_id) || !Number.isSafeInteger(candidate.count) || candidate.count < 1 || candidate.count > 10000) continue
      const key = JSON.stringify([summary.questionnaire_hash, candidate.question_id, description])
      let group = groups.get(key)
      if (!group) {
        if (groups.size >= maxCandidates) { truncated = true; continue }
        group = { questionnaire_version: summary.questionnaire_version, questionnaire_hash: summary.questionnaire_hash,
          question_id: candidate.question_id, proposed_description: description, count: 0, origins: [] }
        groups.set(key, group)
      }
      group.count += candidate.count
      if (originCount < maxOrigins) {
        group.origins.push({ paper_id: row.paper_id, request_id: row.request_id, batch_index: row.batch_index,
          answer_origins: Array.isArray(candidate.origins) ? candidate.origins.slice(0, 20).map(origin => ({
            answer_id: typeof origin?.answer_id === 'string' ? origin.answer_id.slice(0, 160) : null,
            source_ids: Array.isArray(origin?.source_ids) ? origin.source_ids.filter(id => typeof id === 'string').slice(0, 40).map(id => id.slice(0, 160)) : [],
          })) : [], origins_truncated: candidate.origins_truncated === true || (candidate.origins?.length ?? 0) > 20 })
        originCount++
      } else { group.origins_truncated = true; truncated = true }
    }
  }
  const candidates = [...groups.values()].sort((a, b) => JSON.stringify([a.questionnaire_hash,a.question_id,a.proposed_description])
    .localeCompare(JSON.stringify([b.questionnaire_hash,b.question_id,b.proposed_description])))
  const versions = new Map()
  for (const candidate of candidates) {
    const key = JSON.stringify([candidate.questionnaire_version, candidate.questionnaire_hash])
    if (!versions.has(key)) versions.set(key, { questionnaire_version: candidate.questionnaire_version,
      questionnaire_hash: candidate.questionnaire_hash, candidates: [] })
    versions.get(key).candidates.push(candidate)
  }
  return { candidates, versions: [...versions.values()], truncated }
}

function validateRequests(requests) {
  if (!Array.isArray(requests) || !requests.length || requests.length > 100) throw fail('CANDIDATE_REQUESTS_INVALID')
  const seen = new Set()
  for (const request of requests) {
    if (!request || Array.isArray(request) || typeof request !== 'object' || Object.keys(request).some(key => !['id','request_id'].includes(key)) ||
      !VALID_ID.test(request.id ?? '') || !VALID_ID.test(request.request_id ?? '')) throw fail('CANDIDATE_REQUESTS_INVALID')
    const key = JSON.stringify([request.id, request.request_id])
    if (seen.has(key)) throw fail('CANDIDATE_REQUESTS_INVALID')
    seen.add(key)
  }
  return requests
}

/** Read selected state only; this function never asks the model or accesses PDFs. */
export async function collectReadingOptionCandidates({ library, localStateHome, python, requests,
  maxBatches = DEFAULT_BATCH_LIMIT, maxCandidates = DEFAULT_CANDIDATE_LIMIT, maxOrigins = DEFAULT_ORIGIN_LIMIT,
  createAnalysis = createHeadlessAnalysis }) {
  if (typeof library !== 'string' || !isAbsolute(library) || typeof localStateHome !== 'string' || !isAbsolute(localStateHome) ||
    python !== undefined && (typeof python !== 'string' || !isAbsolute(python)) || !Number.isSafeInteger(maxBatches) || maxBatches < 1 || maxBatches > 10000 ||
    !Number.isSafeInteger(maxCandidates) || maxCandidates < 1 || maxCandidates > 10000 ||
    !Number.isSafeInteger(maxOrigins) || maxOrigins < 1 || maxOrigins > 100000) throw fail('CANDIDATE_INPUT_INVALID')
  const selected = validateRequests(requests), analysis = await createAnalysis({ library, localStateHome, python })
  const rows = [], papers = [], unavailable = [], incomplete = [], candidateKeys = new Set()
  let truncated = false, visitedBatches = 0
  try {
    for (const request of selected) {
      let record
      try { record = await analysis({ action: 'paper_analysis_get', id: request.id, request_id: request.request_id }) }
      catch (error) {
        papers.push({ id: request.id, request_id: request.request_id, status: 'unavailable', batch_count: 0, question_protocol: 'unknown' })
        unavailable.push({ paper_id: request.id, request_id: request.request_id, error_code: error.code ?? 'ANALYSIS_RECORD_UNAVAILABLE' })
        continue
      }
      const batchCount = Number.isSafeInteger(record?.batch_count) && record.batch_count > 0 ? record.batch_count : 0
      const hasQuestionnaire = typeof record?.questionnaire?.version === 'string' && record.questionnaire.version.length > 0 && record.questionnaire.version.length <= 100 &&
        /^[a-f0-9]{64}$/i.test(record.questionnaire?.hash ?? '')
      const missing = !record || record.status === 'idle'
      const legacy = record?.status === 'complete' && !hasQuestionnaire
      papers.push({ id: request.id, request_id: request.request_id, status: record?.status ?? 'unknown', batch_count: batchCount,
        question_protocol: missing ? 'missing' : hasQuestionnaire ? 'questionnaire' : legacy ? 'legacy' : 'unknown' })
      if (missing) { unavailable.push({ paper_id: request.id, request_id: request.request_id, error_code: 'ANALYSIS_RECORD_MISSING' }); continue }
      if (!hasQuestionnaire) {
        if (!legacy) incomplete.push({ paper_id: request.id, request_id: request.request_id, status: record.status, reason: 'QUESTIONNAIRE_SNAPSHOT_UNAVAILABLE' })
        continue
      }
      if (batchCount === 0) { incomplete.push({ paper_id: request.id, request_id: request.request_id, status: record.status, reason: 'NO_SAVED_BATCHES' }); continue }
      for (let batchIndex = 0; batchIndex < batchCount; batchIndex++) {
        if (visitedBatches >= maxBatches) { truncated = true; break }
        visitedBatches++
        try {
          const batch = await analysis({ action: 'paper_analysis_get', id: request.id, request_id: request.request_id, batch_index: batchIndex })
          const summary = batch?.option_candidates
          if (!summary || !/^[a-f0-9]{64}$/i.test(summary.questionnaire_hash ?? '') || typeof summary.questionnaire_version !== 'string' ||
            !summary.questionnaire_version || summary.questionnaire_version.length > 100 || !Array.isArray(summary.candidates)) {
            unavailable.push({ paper_id: request.id, request_id: request.request_id, batch_index: batchIndex, error_code: 'CANDIDATE_SUMMARY_UNAVAILABLE' })
            continue
          }
          if (summary?.truncated) truncated = true
          if (summary.candidates.length > 200) truncated = true
          for (const candidate of summary.candidates.slice(0, 200)) {
            const description = normalizedDescription(candidate?.proposed_description)
            const key = JSON.stringify([summary?.questionnaire_hash, candidate?.question_id, description])
            if (!candidateKeys.has(key) && candidateKeys.size >= maxCandidates) { truncated = true; continue }
            candidateKeys.add(key)
            if (rows.length >= maxOrigins) { truncated = true; continue }
            rows.push({ paper_id: request.id, request_id: request.request_id, batch_index: batchIndex, summary: {
              questionnaire_version: summary.questionnaire_version, questionnaire_hash: summary.questionnaire_hash,
              candidates: [candidate], truncated: summary.truncated === true,
            } })
          }
        } catch (error) { unavailable.push({ paper_id: request.id, request_id: request.request_id, batch_index: batchIndex, error_code: error.code ?? 'BATCH_UNAVAILABLE' }) }
      }
      if (truncated && visitedBatches >= maxBatches) break
    }
  } finally { analysis.dispose?.() }
  const merged = mergeOptionCandidates(rows, { maxCandidates, maxOrigins })
  return { schema: 1, created_at: new Date().toISOString(), requested_papers: selected.length, inspected_papers: papers.length,
    inspected_batches: visitedBatches, candidate_groups: merged.candidates.length, truncated: truncated || merged.truncated,
    papers, unavailable_records_or_batches: unavailable, incomplete_records: incomplete, versions: merged.versions, candidates: merged.candidates }
}

async function writeNewFile(path, report, library) {
  if (typeof path !== 'string' || !isAbsolute(path)) throw fail('CANDIDATE_OUTPUT_INVALID')
  const target = resolve(path), parent = await realpath(dirname(target)), libraryRoot = await realpath(library)
  const canonical = join(parent, target.slice(dirname(target).length + 1))
  if (canonical.startsWith(`${ROOT}/`) || canonical === ROOT || canonical === libraryRoot || canonical.startsWith(`${libraryRoot}/`)) throw fail('CANDIDATE_OUTPUT_UNSAFE')
  for (let cursor = parent;;cursor = dirname(cursor)) {
    try { await lstat(join(cursor, '.git')); throw fail('CANDIDATE_OUTPUT_IN_GIT') }
    catch (error) { if (error.code !== 'ENOENT') throw error }
    if (dirname(cursor) === cursor) break
  }
  try { await writeFile(canonical, JSON.stringify(report, null, 2) + '\n', { mode: 0o600, flag: 'wx' }) }
  catch (error) { throw fail(error.code === 'EEXIST' ? 'CANDIDATE_OUTPUT_EXISTS' : 'CANDIDATE_OUTPUT_INVALID') }
  await chmod(canonical, 0o600)
}

async function main() {
  const args = process.argv.slice(2), values = new Map()
  if (args.length % 2) throw fail('CANDIDATE_CLI_INVALID')
  for (let i=0;i<args.length;i+=2) {
    if (!['--library','--state-home','--python','--requests','--out','--max-batches','--max-candidates','--max-origins'].includes(args[i]) || values.has(args[i]) || !args[i+1]) throw fail('CANDIDATE_CLI_INVALID')
    values.set(args[i], args[i+1])
  }
  for (const key of ['--library','--state-home','--requests','--out']) if (!values.has(key)) throw fail('CANDIDATE_CLI_INVALID')
  const requests = await readJson(values.get('--requests'))
  const report = await collectReadingOptionCandidates({ library: values.get('--library'), localStateHome: values.get('--state-home'),
    python: values.get('--python'), requests,
    ...(values.has('--max-batches') ? { maxBatches: Number(values.get('--max-batches')) } : {}),
    ...(values.has('--max-candidates') ? { maxCandidates: Number(values.get('--max-candidates')) } : {}),
    ...(values.has('--max-origins') ? { maxOrigins: Number(values.get('--max-origins')) } : {}) })
  await writeNewFile(values.get('--out'), report, values.get('--library'))
  process.stdout.write(JSON.stringify({ requested_papers: report.requested_papers, inspected_batches: report.inspected_batches,
    candidate_groups: report.candidate_groups, truncated: report.truncated }) + '\n')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { process.stderr.write(`${error.code ?? 'CANDIDATE_EXPORT_FAILED'}\n`); process.exitCode = 1 })
}
