import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

const files = Object.freeze({
  knowledge: new URL('../prompts/analysis/knowledge.json', import.meta.url),
  note: new URL('../prompts/analysis/note.json', import.meta.url),
  review: new URL('../prompts/analysis/review.json', import.meta.url),
  metadata: new URL('../prompts/analysis/metadata.json', import.meta.url),
  coverage: new URL('../prompts/analysis/coverage.json', import.meta.url),
  agent: new URL('../prompts/analysis/agent.json', import.meta.url),
})
const loaded = new Map()

function asset(name) {
  if (!Object.hasOwn(files, name)) throw new Error(`Unknown bundled prompt template: ${name}`)
  if (loaded.has(name)) return loaded.get(name)
  const bytes = readFileSync(files[name])
  if (bytes.length > 64 * 1024) throw new Error(`Prompt template ${name} exceeds 64 KiB`)
  let value
  try { value = JSON.parse(bytes.toString('utf8')) } catch { throw new Error(`Prompt template ${name} is invalid JSON`) }
  const shaped = value && value.version === 1 && (name === 'agent' || typeof value.template === 'string' && value.template.trim())
    && (name !== 'review' || Array.isArray(value.sections) && value.sections.length > 0 && value.sections.every(section => typeof section === 'string' && section.trim()))
    && (name !== 'metadata' || typeof value.requirements === 'string' && value.requirements.trim() && typeof value.preprocessing_markdown === 'string' && typeof value.visual === 'string')
    && (['note', 'review'].includes(name) || !Object.hasOwn(value, 'completeness'))
    && (!['note', 'review'].includes(name) || value.completeness && typeof value.completeness.target === 'string' && typeof value.completeness.partial === 'string' && typeof value.completeness.complete === 'string' && typeof value.record_policy === 'string' && value.record_policy.trim())
    && (name !== 'review' || typeof value.profile_rule === 'string' && typeof value.overlay === 'string')
    && (name !== 'knowledge' || value.goals && typeof value.goals.note === 'string' && typeof value.goals.graph === 'string' && typeof value.node_preference_12 === 'string')
    && (name !== 'coverage' || typeof value.text_gaps === 'string' && typeof value.question_gaps === 'string')
    && (name !== 'agent' || typeof value.persona === 'string' && value.persona.trim())
  if (!shaped) throw new Error(`Prompt template ${name} has an unsupported version or shape`)
  const requiredTokens = {
    note: ['RECORD_POLICY', 'COMPLETENESS', 'TITLE_JSON', 'MATERIAL_JSON'],
    review: ['PROFILE_RULE', 'RECORD_POLICY', 'COMPLETENESS', 'OVERLAY', 'TITLE_JSON', 'MATERIAL_JSON'],
    metadata: ['SOURCES_JSON'], knowledge: ['GOAL', 'REQUEST_JSON', 'KNOWLEDGE_JSON'],
  }[name]
  if (requiredTokens && requiredTokens.some(token => !value.template.includes(`{{${token}}}`))) throw new Error(`Prompt template ${name} is missing a required placeholder`)
  if (name === 'metadata' && ['EXISTING_METADATA_JSON', 'GRAPH_BUDGET', 'ANALYSIS_JSON'].some(token => !value.requirements.includes(`{{${token}}}`))) throw new Error('Prompt template metadata requirements are incomplete')
  if (name === 'knowledge' && ['{{MAX_NODES}}', '{{MAX_RELATIONS}}', '{{PREFER_NODES}}'].some(token => !value.goals.graph.includes(token))) throw new Error('Prompt template knowledge graph goal is incomplete')
  const result = Object.freeze({ ...value, sha256: createHash('sha256').update(bytes).digest('hex') })
  loaded.set(name, result)
  return result
}

function render(name, values) {
  const template = asset(name).template
  const expected = new Set([...template.matchAll(/\{\{([A-Z0-9_]+)\}\}/g)].map(match => match[1]))
  for (const key of expected) if (!Object.hasOwn(values, key) || typeof values[key] !== 'string') throw new Error(`Missing prompt value ${key} for ${name}`)
  for (const key of Object.keys(values)) if (!expected.has(key)) throw new Error(`Unexpected prompt value ${key} for ${name}`)
  const result = template.replace(/\{\{([A-Z0-9_]+)\}\}/g, (_match, key) => values[key])
  return result
}
function expand(text, values) {
  const expected = new Set([...text.matchAll(/\{\{([A-Z0-9_]+)\}\}/g)].map(match => match[1]))
  for (const key of expected) if (!Object.hasOwn(values, key) || typeof values[key] !== 'string') throw new Error(`Missing prompt value ${key}`)
  for (const key of Object.keys(values)) if (!expected.has(key)) throw new Error(`Unexpected prompt value ${key}`)
  const result = text.replace(/\{\{([A-Z0-9_]+)\}\}/g, (_match, key) => values[key])
  return result
}
const json = value => JSON.stringify(value)
function completeness(name, partial, material, total, target) {
  const value = asset(name).completeness[partial ? 'partial' : 'complete']
  return partial ? expand(value, { MATERIAL_COUNT: String(material.length), TOTAL: String(total), TARGET: target }) : value
}

export const REVIEW_SECTIONS = Object.freeze([...asset('review').sections])

export function renderNotePrompt(title, material, partial, total) {
  const policy = asset('note').record_policy
  return render('note', { RECORD_POLICY: policy, COMPLETENESS: completeness('note', partial, material, total, asset('note').completeness.target), TITLE_JSON: json(String(title || '').slice(0, 500)), MATERIAL_JSON: json({ batches: material }) })
}

export function renderReviewPrompt(title, material, partial, total, profile) {
  const review = asset('review')
  const overlay = profile?.text ? expand(review.overlay, { PROFILE_TEXT: profile.text }) : ''
  return render('review', {
    PROFILE_RULE: profile?.text ? review.profile_rule : '', RECORD_POLICY: review.record_policy,
    COMPLETENESS: completeness('review', partial, material, total, review.completeness.target), OVERLAY: overlay,
    TITLE_JSON: json(String(title || '').slice(0, 500)), MATERIAL_JSON: json({ batches: material }),
  })
}

export function renderCoveragePrompt(job) {
  const coverage = job?.coverage || {}
  const missing = { no_extractable_text_pages: coverage.no_extractable_text_pages || [], empty_markdown_pages: coverage.empty_markdown_pages || [] }
  const questions = job?.question_coverage
  const textGaps = missing.no_extractable_text_pages.length || missing.empty_markdown_pages.length
    ? expand(asset('coverage').text_gaps, { MISSING_JSON: json(missing) }) : ''
  const questionGaps = questions !== undefined
    ? expand(asset('coverage').question_gaps, { QUESTION_JSON: json(questions) }) : ''
  return textGaps + questionGaps
}

export function renderMetadataPrompt(pack, input) {
  if (!Array.isArray(pack?.sources) || !input || typeof input !== 'object') throw new Error('Metadata prompt needs a validated pack and input')
  const values = {
    SOURCES_JSON: json({ sources: pack.sources.map(({ id, text, locator, content_hash }) => ({ id, text, locator, content_hash })) }),
    EXISTING_METADATA_JSON: json({ values: input.existingMetadata?.values || {}, present_fields: input.existingMetadata?.present_fields || [], omitted_fields: input.existingMetadata?.omitted_fields || [] }),
    GRAPH_BUDGET: input.graphBudget || 'Keep nodes, edges and assertions empty.',
    ANALYSIS_JSON: json(input.analysis || { id: input.id, source_ids: pack.source_ids, coverage: pack.coverage }),
  }
  const template = asset('metadata')
  const metadata = render('metadata', { SOURCES_JSON: values.SOURCES_JSON })
  const requirements = expand(template.requirements, {
    EXISTING_METADATA_JSON: values.EXISTING_METADATA_JSON,
    GRAPH_BUDGET: values.GRAPH_BUDGET,
    ANALYSIS_JSON: values.ANALYSIS_JSON,
  })
  const preprocessing = input.input_format === 'markdown' ? `\n${template.preprocessing_markdown}` : ''
  const imageInputs = Array.isArray(input.imageInputs) ? input.imageInputs : []
  const visual = imageInputs.length ? `\n${expand(template.visual, { IMAGE_INPUTS_JSON: json(imageInputs) })}` : ''
  return metadata + '\n' + requirements + preprocessing + visual
}

export function renderKnowledgePrompt(request, sources, { maxNodes = 20, maxRelations = 40 } = {}) {
  if (!request || !Array.isArray(sources) || !Number.isSafeInteger(maxNodes) || maxNodes < 1 || maxNodes > 80 || !Number.isSafeInteger(maxRelations) || maxRelations < 1 || maxRelations > 160) throw new Error('Knowledge prompt inputs are invalid')
  const goalTemplate = asset('knowledge').goals[request.mode === 'note' ? 'note' : 'graph']
  const goal = request.mode === 'note' ? goalTemplate : expand(goalTemplate, {
    MAX_NODES: String(maxNodes), MAX_RELATIONS: String(maxRelations),
    PREFER_NODES: maxNodes === 12 ? asset('knowledge').node_preference_12 : '',
  })
  return render('knowledge', { GOAL: goal, REQUEST_JSON: json({ entity: request.entity, instruction: request.instruction }), KNOWLEDGE_JSON: json({ mode: request.mode, entity: request.entity, sources: sources.map(({ id, entity, kind, text, locator, content_hash, verification, comment }) => ({ id, entity, kind, text, locator, content_hash, verification, comment })) }) })
}

export function promptTemplateManifest() {
  return Object.keys(files).map(name => {
    const value = asset(name)
    return { name, version: value.version, sha256: value.sha256 }
  })
}

export function renderAnalysisAgentPersona() {
  return asset('agent').persona
}
