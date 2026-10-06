import { isFatalModelError } from '../model-errors.mjs'

export const NOTE_MATERIAL_BUDGET_BYTES = 24_000
export const NOTE_SOURCE_BUDGET_CHARACTERS = 24_000
export const NOTE_SOURCE_LIMIT = 40
const SOURCE_TYPES = new Set(['evidence', 'figure', 'formula'])
const bytes = value => Buffer.byteLength(JSON.stringify(value), 'utf8')
const unique = xs => [...new Set(xs)]
const counts = xs => Object.fromEntries([...new Set(xs)].sort().map(x => [x, xs.filter(y => y === x).length]))
const clip = (value, n) => [...String(value ?? '')].slice(0, n).join('')
const fatal = (error, signal) => signal?.aborted || isFatalModelError(error) || error?.code === 'DIRECT_MODEL_OUTPUT_TRUNCATED'

function candidateRows(batch) {
  const rows = []
  for (const [i, answer] of (batch.answers ?? []).entries()) {
    if (answer.valid !== true) continue
    const recordId = answer.id ?? `${answer.question_id ?? 'question'}:answer-${i}`
    for (const [j, ref] of (answer.evidence ?? []).entries()) if (ref?.source_id && ref?.quote) rows.push({
      candidate_id: `${batch.index}:answer:${recordId}:${j}`, batch_index: batch.index, kind: 'answer',
      record_id: recordId, question_id: answer.question_id ?? null, choice: answer.choice ?? null,
      judgment: clip(answer.judgment, 160), parent_source_id: ref.source_id, original_quote: ref.quote,
    })
  }
  for (const [i, node] of (batch.draft?.nodes ?? []).entries()) if (SOURCE_TYPES.has(node?.type) && node.source_id && node.quote) rows.push({
    candidate_id: `${batch.index}:node:${node.type}:${node.id ?? i}`, batch_index: batch.index, kind: 'graph_node',
    record_id: `${node.type}:${node.id ?? i}`, label: clip(node.label, 120), parent_source_id: node.source_id, original_quote: node.quote,
  })
  return rows
}

function neutralContextCandidates(batch) {
  if ((batch.answers ?? []).some(a => a.valid === true && !['not_reported', 'not_applicable'].includes(a.choice))) return []
  const id = (batch.source_ids ?? [])[0]
  return id ? [{ candidate_id: `${batch.index}:context:${id}`, batch_index: batch.index, kind: 'scope_context', parent_source_id: id, original_quote: null }] : []
}

function cardFor(batch) {
  const answers = batch.answers ?? []
  const valid = answers.filter(a => a.valid === true)
  const choices = {}
  for (const answer of valid) {
    const q = choices[answer.question_id] ??= { neutral: 0, by_choice: {} }
    if (['not_reported', 'not_applicable'].includes(answer.choice)) q.neutral++
    const value = answer.choice ?? 'unknown'
    q.by_choice[value] = (q.by_choice[value] ?? 0) + 1
  }
  const graph = batch.draft ?? {}
  const relation = r => ({ subject: clip(r.subject, 100), relation: clip(r.relation, 80), object: clip(r.object, 100), ...(r.surface ? { note: clip(r.surface, 100) } : {}) })
  const nodes = (graph.nodes ?? []).map(n => ({ id: n.id, type: n.type, label: clip(n.label, 120) }))
  const relations = [...(graph.edges ?? []), ...(graph.assertions ?? [])].map(relation)
  return {
    batch: batch.index + 1, read_pages: unique(batch.pages ?? []), source_ids: [],
    generated_summary: clip(graph.body, 500),
    ...(batch.preprocessing ? { source_representation: batch.preprocessing.representation, raw_pdf_verbatim: batch.preprocessing.raw_verbatim === true } : {}),
    ...(batch.visual_coverage ? { visual_sent_pages: batch.visual_coverage.sent_pages ?? [], visual_observations_require_review: true } : {}),
    question_groups: (batch.question_results ?? []).map(result => ({ question_ids: result.question_ids ?? [], status: result.status ?? 'unknown', missing: result.missing ?? [], errors: counts((result.errors ?? []).map(e => e?.code ?? 'UNKNOWN')) })),
    answers: valid.map(a => ({ id: a.id ?? `${a.question_id ?? 'question'}:answer-${answers.indexOf(a)}`, question_id: a.question_id, answer_status: 'valid', choice: a.choice, neutral: a.neutral === true, judgment: clip(a.judgment, 160), evidence: [] })),
    answer_counts: { total: answers.length, valid: valid.length, invalid: answers.length - valid.length, choices },
    nodes, relations,
    compilation: batch.compilation ? { truncated: batch.compilation.truncated === true, excluded: batch.compilation.excluded_answers?.length ?? 0 } : null,
    graph_error: batch.graph_error?.code ?? graph.graph_error?.code ?? null,
    omissions: { answer_details: 0, graph_records: 0, quote_refs: 0, unbound_quote_refs: 0 },
  }
}

function roundRobin(batches, rowsByBatch) {
  const out = [], max = Math.max(0, ...[...rowsByBatch.values()].map(rows => rows.length))
  for (let i = 0; i < max; i++) for (const batch of batches) if (rowsByBatch.get(batch.index)?.[i]) out.push(rowsByBatch.get(batch.index)[i])
  return out
}

export async function packNoteMaterial({ batches, totalBatches = batches.length, paperId, getSource, putExcerpt, signal,
  budgetBytes = NOTE_MATERIAL_BUDGET_BYTES, sourceBudgetCharacters = NOTE_SOURCE_BUDGET_CHARACTERS,
  maxSources = NOTE_SOURCE_LIMIT, maxQuoteCharacters = 240, coverage: inputCoverage = {}, questionCoverage } = {}) {
  if (!Array.isArray(batches) || typeof getSource !== 'function' || typeof putExcerpt !== 'function' ||
    !Number.isSafeInteger(budgetBytes) || budgetBytes < 1 || !Number.isSafeInteger(sourceBudgetCharacters) || sourceBudgetCharacters < 0 ||
    !Number.isSafeInteger(maxSources) || maxSources < 0 || !Number.isSafeInteger(maxQuoteCharacters) || maxQuoteCharacters < 1) throw new Error('NOTE_PACKING_INPUT_INVALID')
  const ordered = [...batches].sort((a, b) => a.index - b.index)
  const cards = new Map(ordered.map(b => [b.index, cardFor(b)]))
  const sourceCache = new Map(), excerptByQuote = new Map(), bindings = new Map(), materialSources = new Map()
  const verifiedParents = new Set()
  const diagnostics = { verified_parent_sources: 0, excerpt_sources_created: 0, fallback_parent_sources: 0, omitted_source_read_error: 0, omitted_source_identity: 0, omitted_quote_mismatch: 0, omitted_quote_out_of_page_scope: 0, omitted_source_budget: 0, omitted_excerpt_write_error: 0 }
  const selected = roundRobin(ordered, new Map(ordered.map(b => [b.index, [...candidateRows(b), ...neutralContextCandidates(b)]])))

  for (const row of selected) {
    signal?.throwIfAborted()
    const batch = ordered.find(b => b.index === row.batch_index)
    if (!batch?.source_ids?.includes(row.parent_source_id)) { diagnostics.omitted_source_identity++; continue }
    const quote = row.original_quote ? clip(row.original_quote, maxQuoteCharacters) : ''
    const quoteKey = JSON.stringify([row.parent_source_id, quote || null])
    if (excerptByQuote.has(quoteKey)) {
      const source = sourceCache.get(row.parent_source_id)
      const bound = excerptByQuote.get(quoteKey)
      if (source?.text && (!row.original_quote || source.text.includes(row.original_quote)) && (!batch.pages?.length || Number.isInteger(bound.page) && batch.pages.includes(bound.page))) {
        bindings.set(row.candidate_id, bound); continue
      }
      diagnostics.omitted_quote_out_of_page_scope++
      continue
    }
    let source = sourceCache.get(row.parent_source_id)
    if (!sourceCache.has(row.parent_source_id)) {
      try { source = await getSource(row.parent_source_id, signal); sourceCache.set(row.parent_source_id, source ?? null) }
      catch (error) { if (fatal(error, signal)) throw error; sourceCache.set(row.parent_source_id, null); diagnostics.omitted_source_read_error++; continue }
    }
    if (!source || source.id !== row.parent_source_id || source.entity?.kind !== 'paper' || source.entity.id !== paperId || typeof source.text !== 'string') { diagnostics.omitted_source_identity++; continue }
    const page = source.locator?.page
    if (batch.pages?.length && (!Number.isInteger(page) || !batch.pages.includes(page))) { diagnostics.omitted_quote_out_of_page_scope++; continue }
    let excerpt = quote
    if (!excerpt) excerpt = clip(source.text, Math.min(maxQuoteCharacters, 120))
    if (!excerpt || (row.original_quote && !source.text.includes(row.original_quote)) || (quote && !source.text.includes(quote))) { if (row.original_quote) diagnostics.omitted_quote_mismatch++; continue }
    let bound, charCount
    if (source.pdf_snapshot?.kind === 'selected-pdf-page') {
      charCount = [...excerpt].length
      if (materialSources.size >= maxSources || [...materialSources.values()].reduce((n, x) => n + x.characters, 0) + charCount > sourceBudgetCharacters) { diagnostics.omitted_source_budget++; continue }
      try {
        bound = await putExcerpt({ action: 'knowledge_source_put', entity: { kind: 'paper', id: paperId }, kind: 'source-note', parent_source_id: source.id, text: excerpt }, signal)
      } catch (error) { if (fatal(error, signal)) throw error; diagnostics.omitted_excerpt_write_error++; continue }
      const p = bound?.pdf_snapshot
      const points = [...String(source.text)]
      if (!bound?.id || bound.entity?.kind !== 'paper' || bound.entity.id !== paperId || bound.text !== excerpt || p?.kind !== 'selected-source-excerpt' ||
        p.parent_source_id !== source.id || p.parent_content_hash !== source.content_hash || p.full_document !== false || p.excerpt_only !== true ||
        !Number.isSafeInteger(p.parent_character_start) || !Number.isSafeInteger(p.parent_character_end) || p.parent_character_end - p.parent_character_start !== [...excerpt].length ||
        points.slice(p.parent_character_start, p.parent_character_end).join('') !== excerpt) { diagnostics.omitted_excerpt_write_error++; continue }
      diagnostics.excerpt_sources_created++
    } else if (!source.pdf_snapshot) {
      bound = source
      const alreadyBound = materialSources.has(source.id)
      charCount = alreadyBound ? 0 : [...source.text].length + [...String(source.comment ?? '')].length
      if ((!alreadyBound && materialSources.size >= maxSources) || [...materialSources.values()].reduce((n, x) => n + x.characters, 0) + charCount > sourceBudgetCharacters) { diagnostics.omitted_source_budget++; continue }
      if (!alreadyBound) diagnostics.fallback_parent_sources++
    } else { diagnostics.omitted_source_identity++; continue }
    verifiedParents.add(source.id)
    diagnostics.verified_parent_sources = verifiedParents.size
    const record = { source_id: bound.id, parent_source_id: source.id, page: source.locator?.page ?? null, quote: excerpt,
      scope_only: !quote, ...(bound.pdf_snapshot?.kind === 'selected-source-excerpt' ? { parent_character_start: bound.pdf_snapshot.parent_character_start, parent_character_end: bound.pdf_snapshot.parent_character_end } : {}) }
    if (!materialSources.has(bound.id)) materialSources.set(bound.id, { characters: charCount, parent_source_id: source.id })
    excerptByQuote.set(quoteKey, record); bindings.set(row.candidate_id, record)
  }

  const allRows = selected
  for (const batch of ordered) {
    const card = cards.get(batch.index)
    for (const row of allRows.filter(r => r.batch_index === batch.index)) {
      const binding = bindings.get(row.candidate_id)
      if (!binding) { card.omissions.quote_refs++; card.omissions.unbound_quote_refs++; continue }
      card.source_ids.push(binding.source_id)
      if (row.kind === 'scope_context') card.scope_context = { ...binding, label: 'context_only_not_evidence' }
      else {
        const truncated = row.original_quote && binding.quote !== row.original_quote
        if (row.kind === 'answer') {
          const answer = card.answers.find(a => a.id === row.record_id && a.question_id === row.question_id)
          answer?.evidence.push({ source_id: binding.source_id, page: binding.page, quote: binding.quote, ...(truncated ? { quote_truncated: true } : {}) })
        } else if (row.kind === 'graph_node') {
          const node = card.nodes.find(n => `${n.type}:${n.id}` === row.record_id)
          if (node) { node.source_id = binding.source_id; node.quote = binding.quote; if (truncated) node.quote_truncated = true }
        }
      }
    }
    card.source_ids = unique(card.source_ids)
    const answerRefs = card.answers.reduce((n, answer) => n + answer.evidence.length, 0)
    const graphRefs = card.nodes.filter(node => node.source_id).length
    card.answers = card.answers.filter(answer => ['not_reported', 'not_applicable'].includes(answer.choice) || answer.evidence.length > 0)
    const representedAnswerIds = new Set(card.answers.map(a => a.id))
    card.omissions.answer_details = Math.max(0, (batch.answers ?? []).filter(a => a.valid && !['not_reported', 'not_applicable'].includes(a.choice) && !representedAnswerIds.has(a.id)).length)
    const graph = batch.draft ?? {}
    const sourceNodes = (graph.nodes ?? []).filter(node => SOURCE_TYPES.has(node?.type))
    card.omissions.graph_records = Math.max(0, sourceNodes.length - graphRefs)
  }

  let material = ordered.map(b => cards.get(b.index))
  const reasons = []
  if (ordered.length < totalBatches) reasons.push('SAVED_BATCH_MISSING')
  if (ordered.some(b => b.graph_error || b.draft?.graph_error)) reasons.push('BATCH_GRAPH_ERROR')
  if (ordered.some(b => b.compilation?.truncated)) reasons.push('GRAPH_COMPILATION_TRUNCATED')
  if (ordered.some(b => b.question_results?.some(q => q.status !== 'complete'))) reasons.push('QUESTION_GROUP_INCOMPLETE')
  if (ordered.some(b => b.answers?.some(a => a.valid !== true))) reasons.push('INVALID_ANSWERS_OMITTED')
  const gapKeys = ['blank_pages', 'truncated_pages', 'omitted_pages', 'no_extractable_text_pages', 'empty_markdown_pages']
  if (gapKeys.some(key => inputCoverage?.[key]?.length) || questionCoverage?.complete === false) reasons.push('INPUT_COVERAGE_INCOMPLETE')
  if (diagnostics.omitted_source_read_error || diagnostics.omitted_source_identity || diagnostics.omitted_quote_mismatch || diagnostics.omitted_quote_out_of_page_scope || diagnostics.omitted_source_budget || diagnostics.omitted_excerpt_write_error) reasons.push('SOURCE_OR_QUOTE_OMITTED')
  if (material.some(c => c.omissions.quote_refs || c.omissions.graph_records || c.omissions.answer_details)) reasons.push('DETAILS_COMPACTED')

  const coverage = { version: 'balanced-excerpt-v2', budget_bytes: budgetBytes, source_budget_characters: sourceBudgetCharacters,
    source_limit: maxSources, sources: materialSources.size, source_characters: [...materialSources.values()].reduce((n, x) => n + x.characters, 0),
    batches_total: totalBatches, batches_available: ordered.length, batches_represented: material.length, batch_indices: material.map(c => c.batch),
    answers_total: ordered.reduce((n, b) => n + (b.answers?.length ?? 0), 0), valid_answers_total: ordered.reduce((n, b) => n + (b.answers ?? []).filter(a => a.valid).length, 0),
    graph_nodes_total: ordered.reduce((n, b) => n + (b.draft?.nodes?.length ?? 0), 0), graph_edges_total: ordered.reduce((n, b) => n + (b.draft?.edges?.length ?? 0), 0),
    graph_assertions_total: ordered.reduce((n, b) => n + (b.draft?.assertions?.length ?? 0), 0), verified_quotes: material.reduce((n, c) => n + c.answers.reduce((m, answer) => m + answer.evidence.length, 0) + c.nodes.filter(node => node.source_id).length, 0),
    omitted_quotes: material.reduce((n, c) => n + c.omissions.quote_refs, 0), source_diagnostics: diagnostics, partial_reasons: reasons, partial: reasons.length > 0, material_bytes: 0 }
  const clippedContent = ordered.some(b => (b.answers ?? []).some(a => clip(a.judgment, 160) !== String(a.judgment ?? '')) ||
    (b.draft?.body && clip(b.draft.body, 500) !== b.draft.body) || (b.draft?.nodes ?? []).some(n => clip(n.label, 120) !== String(n.label ?? '')) ||
    [...(b.draft?.edges ?? []), ...(b.draft?.assertions ?? [])].some(r => clip(r.subject, 100) !== String(r.subject ?? '') || clip(r.relation, 80) !== String(r.relation ?? '') || clip(r.object, 100) !== String(r.object ?? '') || clip(r.surface, 100) !== String(r.surface ?? '')))
  if (clippedContent || material.some(c => c.answers.some(answer => answer.evidence.some(ref => ref.quote_truncated)) || c.nodes.some(node => node.quote_truncated))) coverage.partial_reasons = unique([...coverage.partial_reasons, 'CONTENT_COMPACTED'])
  coverage.material_bytes = bytes({ batches: material, packing: coverage })
  while (coverage.material_bytes > budgetBytes) {
    const ranked = [...material].sort((a, b) => bytes({ card: b }) - bytes({ card: a }))
    let removed = false
    const evidenceCount = card => card.answers.reduce((n, answer) => n + answer.evidence.length, 0) + card.nodes.filter(node => node.source_id).length
    const protectedEvidenceCards = new Set(material.filter(card => evidenceCount(card)).map(card => card.batch))
    for (const card of ranked) {
      const answerWithExtraRef = card.answers.find(answer => answer.evidence.length > 1)
      if (answerWithExtraRef) { answerWithExtraRef.evidence.pop(); card.omissions.quote_refs++; removed = true; break }
      const answerWithRef = card.answers.find(answer => answer.evidence.length === 1)
      if (answerWithRef && !protectedEvidenceCards.has(card.batch)) { answerWithRef.evidence = []; card.omissions.quote_refs++; removed = true; break }
      const sourceNodes = card.nodes.filter(node => node.source_id)
      if (sourceNodes.length > 1 || (sourceNodes.length && !protectedEvidenceCards.has(card.batch))) {
        const node = sourceNodes.at(-1); delete node.source_id; delete node.quote; delete node.quote_truncated
        card.omissions.quote_refs++; removed = true; break
      }
      const answerWithoutRef = card.answers.find(answer => !answer.evidence.length)
      if (answerWithoutRef) { card.answers.splice(card.answers.indexOf(answerWithoutRef), 1); card.omissions.answer_details++; removed = true; break }
      if (card.answers.length > 1 && evidenceCount(card) > 1) {
        const answer = card.answers.pop(); card.omissions.answer_details++; card.omissions.quote_refs += answer.evidence.length; removed = true; break
      }
      if (card.relations.length) { card.relations.pop(); card.omissions.graph_records++; removed = true; break }
      const unsourcedNode = card.nodes.find(node => !node.source_id)
      if (unsourcedNode) { card.nodes.splice(card.nodes.indexOf(unsourcedNode), 1); card.omissions.graph_records++; removed = true; break }
      if (card.nodes.length > 1 && evidenceCount(card) > 1) { const node = card.nodes.pop(); card.omissions.graph_records++; card.omissions.quote_refs += node.source_id ? 1 : 0; removed = true; break }
      const longJudgment = card.answers.find(answer => [...answer.judgment].length > 48)
      if (longJudgment) { longJudgment.judgment = clip(longJudgment.judgment, 48); removed = true; break }
      const quoteRef = card.answers.flatMap(answer => answer.evidence).find(ref => [...ref.quote].length > 96)
      if (quoteRef) { quoteRef.quote = clip(quoteRef.quote, 96); quoteRef.quote_truncated = true; removed = true; break }
      const nodeQuote = card.nodes.find(node => node.quote && [...node.quote].length > 96)
      if (nodeQuote) { nodeQuote.quote = clip(nodeQuote.quote, 96); nodeQuote.quote_truncated = true; removed = true; break }
      if (card.generated_summary) { card.generated_summary = clip(card.generated_summary, Math.floor([...card.generated_summary].length / 2)); removed = true; break }
    }
    if (!removed) {
      const error = new Error('NOTE_MATERIAL_BUDGET_EXCEEDED'); error.code = 'NOTE_MATERIAL_BUDGET_EXCEEDED'; throw error
    }
    coverage.partial_reasons = unique([...coverage.partial_reasons, 'MATERIAL_BUDGET_COMPACTED'])
    for (const card of material) {
      card.source_ids = unique([...(card.scope_context?.source_id ? [card.scope_context.source_id] : []), ...card.answers.flatMap(answer => answer.evidence.map(ref => ref.source_id)), ...card.nodes.map(node => node.source_id).filter(Boolean)])
    }
    coverage.material_bytes = bytes({ batches: material, packing: coverage })
  }
  coverage.partial = coverage.partial_reasons.length > 0 || coverage.material_bytes > budgetBytes
  // Source IDs are derived from the final evidence, and never include orphaned bindings.
  const finalIds = unique(material.flatMap(c => [...c.source_ids]))
  const finalSourceIds = finalIds.filter(id => materialSources.has(id))
  for (const card of material) card.source_ids = unique([...(card.scope_context?.source_id ? [card.scope_context.source_id] : []), ...card.answers.flatMap(answer => answer.evidence.map(ref => ref.source_id)), ...card.nodes.map(node => node.source_id).filter(Boolean)]).filter(id => finalSourceIds.includes(id))
  const liveIds = new Set(material.flatMap(card => card.source_ids))
  const prunedIds = finalSourceIds.filter(id => liveIds.has(id))
  coverage.sources = prunedIds.length
  coverage.source_characters = prunedIds.reduce((n, id) => n + (materialSources.get(id)?.characters ?? 0), 0)
  coverage.verified_quotes = material.reduce((n, card) => n + card.answers.reduce((m, answer) => m + answer.evidence.length, 0) + card.nodes.filter(node => node.source_id).length, 0)
  coverage.omitted_quotes = Math.max(0, selected.filter(row => row.original_quote).length - coverage.verified_quotes)
  coverage.material_bytes = bytes({ batches: material, packing: coverage })
  if (coverage.material_bytes > budgetBytes) { const error = new Error('NOTE_MATERIAL_BUDGET_EXCEEDED'); error.code = 'NOTE_MATERIAL_BUDGET_EXCEEDED'; throw error }
  return { material, sourceIds: prunedIds, sourceCharacters: coverage.source_characters, partial: coverage.partial, coverage }
}
