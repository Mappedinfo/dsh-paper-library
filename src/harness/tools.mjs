import { resolve } from 'node:path'
import { RESOURCE_TOOL_SPECS, resourceToolRequest } from './resource-tools.mjs'

const string = (description, required = false) => ({ type: 'string', description, ...(required ? { required: true } : {}) })
const ids = { type: 'array', items: { type: 'string' } }
const output = { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] }
const choice = (values, description, required = false) => ({ type: 'string', enum: values, description, ...(required ? { required: true } : {}) })
const object = (properties, description, required = false) => ({ type: 'object', properties, additionalProperties: false, description, ...(required ? { required: true } : {}) })
const person = object({ family: string('Family name'), given: string('Given name'), literal: string('Institutional or literal author name'), ORCID: string('Supplied ORCID identifier'), affiliation: { type: 'array', items: object({ name: string('Supplied institution name', true), ror: string('Supplied ROR identifier'), source: string('Metadata source') }, 'Supplied affiliation') } }, 'Supplied author metadata; do not infer missing names or affiliations')
const metadata = object({
  title: string('Paper title'), type: string('CSL document type'), citekey: string('Unique writing citation key'),
  DOI: string('Verified DOI'), URL: string('Source URL'), abstract: string('Supplied abstract'),
  author: { type: 'array', items: person }, editor: { type: 'array', items: person },
  'container-title': string('Journal or proceedings title'), publisher: string('Publisher'), volume: string('Volume'), issue: string('Issue'), page: string('Published page range'),
  issued: object({ 'date-parts': { type: 'array', items: { type: 'array', items: { type: 'integer' } } } }, 'CSL year, optional month/day; do not invent unknown dates'),
  tags: { type: 'array', items: { type: 'string' } },
  publication_dates: object(Object.fromEntries(['published', 'online', 'print', 'received', 'accepted'].map(key => [key, string('Known YYYY, YYYY-MM or YYYY-MM-DD')])), 'Only known publication and manuscript dates'),
  journal_rankings: { type: 'array', items: object({ system: choice(['JCR'], 'Ranking system', true), year: { type: 'integer', required: true }, category: string('JCR subject category', true), quartile: choice(['Q1', 'Q2', 'Q3', 'Q4'], 'Reported category/year quartile', true), source: string('Evidence source', true), verified_at: string('Verification date YYYY-MM-DD') }, 'Evidence-backed JCR category/year record') },
}, 'Structured bibliographic metadata only; no paths, library settings or runtime state', true)
const evidence = object({ page: { oneOf: [{ type: 'integer' }, { type: 'null' }], description: 'Known one-based PDF page, otherwise null or omitted' }, quote: string('Exact supplied quote, at most 4000 characters'), note: string('Reader interpretation, at most 2000 characters'), source: string('Source URL or location, at most 1000 characters'), annotation_id: string('Known PDF annotation ID, at most 200 characters') }, 'Explicit provenance; missing evidence stays empty')
const graphTypes = ['method', 'dataset', 'claim', 'evidence', 'concept', 'author', 'institution']
const graphRelations = ['supports', 'contradicts', 'uses', 'evaluates', 'derived_from', 'explains', 'extends', 'cites', 'related', 'authored_by', 'affiliated_with', 'published_by']

/** Small schemas keep scope explicit and avoid exposing core write/feedback internals. */
export const TOOL_SPECS = [
  ...RESOURCE_TOOL_SPECS,
  { name: 'library_search', action: 'list', title: 'Search papers', parameters: { query: string('Title, author, tag, DOI or indexed text'), limit: { type: 'integer', description: '1–200 records; default 40' }, offset: { type: 'integer', description: 'Pagination offset, 0–10000000' }, sort: choice(['title', 'author', 'year', 'journal', 'modified', 'created', 'citekey', 'jcr'], 'Catalog sort; JCR uses latest reported year and its worst supplied category quartile'), order: choice(['asc', 'desc'], 'Requires a sort field'), archived: { type: 'boolean', description: 'Read trash instead of active papers; default false' } } },
  { name: 'library_get', action: 'get', title: 'Read paper metadata', parameters: { id: string('Library paper ID', true), include_archived: { type: 'boolean', description: 'Inspect archived metadata; does not restore or open the PDF' } } },
  { name: 'library_create', action: 'create', title: 'Create paper metadata', mutate: true, parameters: { metadata: { ...metadata, properties: { ...metadata.properties, title: string('Paper title', true) } } } },
  { name: 'library_update', action: 'update', title: 'Update paper metadata', mutate: true, parameters: { id: string('Library paper ID', true), metadata } },
  { name: 'library_archive', action: 'archive', title: 'Move paper to trash', mutate: true, parameters: { id: string('Library paper ID; retains managed PDF and records for restoration', true) } },
  { name: 'library_restore', action: 'restore', title: 'Restore paper from trash', mutate: true, parameters: { id: string('Archived library paper ID', true) } },
  { name: 'library_import', action: 'import', title: 'Fetch and import papers', mutate: true, parameters: { path: string('Local PDF, CSL JSON, Zotero JSON, RIS or BibTeX path; originals remain unchanged'), doi: string('DOI to resolve and download when publicly available'), url: string('Public PDF/article URL or arXiv ID; downloads, parses and renames the managed copy') } },
  { name: 'library_cite', action: 'cite', title: 'Format citations', parameters: { ids: { ...ids, required: true }, format: { type: 'string', enum: ['apa', 'biblatex', 'csl-json'], required: true } } },
  { name: 'library_annotations', action: 'annotations', title: 'Read PDF annotations', parameters: { id: string('Library paper ID', true) } },
  { name: 'library_annotate', action: 'annotate', title: 'Annotate managed PDF', mutate: true, parameters: { id: string('Library paper ID', true), page: { type: 'number', required: true }, type: { type: 'string', enum: ['highlight', 'underline', 'strikeout', 'note'], required: true }, rects: { type: 'array', items: { type: 'array', items: { type: 'number' } }, required: true }, text: string('Exact quoted passage'), comment: string('Reader comment'), author: string('Annotation author'), color: string('Hex RGB annotation color') } },
  { name: 'library_graph', action: 'graph', title: 'Read literature graph', parameters: { id: string('Optional focus paper ID; prefer one paper to avoid partial global coverage'), limit: { type: 'integer', description: '1–200 nodes; result reports partial coverage' } } },
  { name: 'library_graph_node_put', action: 'graph_node_put', title: 'Create or edit knowledge node', mutate: true, parameters: { id: string('Owning library paper ID', true), node_id: string('Existing editable node ID to update; omit to create'), type: choice(graphTypes, 'Reader-authored object type', true), label: string('Node name, at most 500 characters', true), description: string('Description, at most 4000 characters'), evidence } },
  { name: 'library_graph_node_delete', action: 'graph_node_delete', title: 'Delete knowledge node and its relationships', mutate: true, parameters: { id: string('Owning library paper ID', true), node_id: string('Editable node ID; associated graph edges are also removed', true) } },
  { name: 'library_graph_edge_put', action: 'graph_edge_put', title: 'Create or edit directed knowledge relation', mutate: true, parameters: { id: string('Owning library paper ID', true), edge_id: string('Existing editable edge ID to update; omit to create'), source: string('Source node ID from this paper graph', true), target: string('Target node ID from this paper graph', true), relation: choice(graphRelations, 'Direction is source → relation → target; no inferred scientific claims', true), evidence } },
  { name: 'library_graph_edge_delete', action: 'graph_edge_delete', title: 'Delete knowledge relationship', mutate: true, parameters: { id: string('Owning library paper ID', true), edge_id: string('Editable relation ID', true) } },
  { name: 'library_link', action: 'link', title: 'Connect papers', mutate: true, parameters: { source: string('Source paper ID', true), target: string('Target paper ID', true), relation: { type: 'string', enum: ['related', 'supports', 'contradicts', 'cites'], required: true }, note: string('Reason and provenance for the relationship') } },
  { name: 'library_feedback', action: 'ai_feedback', title: 'Request annotation feedback', mutate: true, parameters: { id: string('Library paper ID', true), annotation_ids: ids, provider: string('Configured Harness provider; defaults to calling agent route'), model: string('Configured model; defaults to calling agent route'), reasoning_effort: string('Optional provider-owned effort; defaults to current conversation effort when following its route') } },
]

/** Pick only declared tool arguments, including on programmatic direct calls. */
export function requestFromTool(spec, args, exec) {
  if (spec.action === 'dataset_tool' || spec.action === 'knowledge_tool') {
    const request = resourceToolRequest(spec, args)
    if (request.path !== undefined) request.path = resolve(exec.agent?.session?.header?.cwd ?? process.cwd(), request.path)
    return request
  }
  const request = { action: spec.action }
  for (const key of Object.keys(spec.parameters)) if (args[key] !== undefined) request[key] = args[key]
  // The official schema DSL has closed objects but no maxLength/maxItems
  // keywords. Bound the selected payload before dispatch; core validates field
  // lengths and collection limits. Also enforce closed nested objects on direct
  // programmatic calls that do not pass through the Harness schema validator.
  if (Buffer.byteLength(JSON.stringify(request), 'utf8') > 128 * 1024) throw new Error('Paper Library tool arguments exceed the 128 KiB request budget')
  for (const key of ['metadata', 'evidence']) if (request[key] !== undefined) validateStructured(spec.parameters[key], request[key], key)
  if (request.path !== undefined) request.path = resolve(exec.agent?.session?.header?.cwd ?? process.cwd(), request.path)
  return request
}

function validateStructured(schema, value, path) {
  if (!schema) throw new Error(`Unsupported structured field ${path}`)
  if (schema.oneOf) {
    for (const branch of schema.oneOf) { try { validateStructured(branch, value, path); return } catch {} }
    throw new Error(`${path} has an invalid value type`)
  }
  if (schema.type === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path} must be an object`)
    for (const [key, child] of Object.entries(schema.properties || {})) if (child.required && value[key] === undefined) throw new Error(`${path}.${key} is required`)
    for (const key of Object.keys(value)) {
      if (!Object.hasOwn(schema.properties || {}, key)) throw new Error(`${path}.${key} is not a supported bibliographic or evidence field`)
      validateStructured(schema.properties[key], value[key], `${path}.${key}`)
    }
  } else if (schema.type === 'array') {
    if (!Array.isArray(value) || value.length > 300) throw new Error(`${path} must be an array of at most 300 entries`)
    for (const entry of value) validateStructured(schema.items, entry, `${path}[]`)
  } else if (schema.type === 'null' ? value !== null : schema.type === 'integer' ? !Number.isInteger(value) : typeof value !== schema.type) throw new Error(`${path} has an invalid value type`)
  if (schema.enum && !schema.enum.includes(value)) throw new Error(`${path} has an unsupported value`)
}

/** Register tools through the normal Harness policy/approval pipeline. */
export function registerLibraryTools(ctx, defineTool, dispatch, options, config) {
  const disposers = []
  try {
    if (config.requireToolApproval) {
      const mutations = new Set(TOOL_SPECS.filter(spec => spec.mutate).map(spec => spec.name))
      disposers.push(ctx.on('tools/pre-execute', async (exec, next) => {
        const decision = await next()
        if (decision.kind !== 'allow' || !mutations.has(exec.name)) return decision
        return { kind: 'ask', reason: exec.name === 'library_feedback' ? 'Send the selected annotation context to the chosen model and save its labelled feedback in the managed library.' : 'Apply the requested change to the managed paper library. Imported source files remain unchanged.' }
      }))
    }
    for (const spec of TOOL_SPECS) {
      disposers.push(ctx.tools.register(defineTool({
        name: spec.name,
        description: `${spec.title} in the independent Paper Library. Pages are one-based; rectangles use PDF points. Library configuration cannot be changed through tool arguments.`,
        parameters: spec.parameters,
        output,
        // The shared catalog and managed PDF writer serialize all operations.
        isConcurrencySafe: () => false,
        execute: async (args, exec) => {
          exec.signal.throwIfAborted()
          const request = requestFromTool(spec, args, exec)
          if (spec.action === 'import' && Number(Boolean(request.path)) + Number(Boolean(request.doi)) + Number(Boolean(request.url)) !== 1) throw new Error('Specify exactly one local path, DOI or paper URL')
          const selected = exec.agent?.options
          const route = selected?.provider && selected?.model ? selected : config
          return dispatch(request, {
            ...options,
            signal: exec.signal,
            provider: route.provider,
            model: route.model,
            reasoningEffort: request.provider === undefined && request.model === undefined ? route.reasoningEffort : undefined,
          })
        },
        presentCall: args => ({ card: 'generic', title: spec.title, kind: spec.mutate ? 'other' : 'read', ...(args.path ? { locations: [{ path: args.path }] } : {}) }),
      })))
    }
  } catch (error) {
    for (const dispose of disposers.reverse()) dispose()
    throw error
  }
  return () => { for (const dispose of disposers.reverse()) dispose() }
}
