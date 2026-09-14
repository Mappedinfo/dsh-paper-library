import { resolve } from 'node:path'

const string = (description, required = false) => ({ type: 'string', description, ...(required ? { required: true } : {}) })
const ids = { type: 'array', items: { type: 'string' } }
const output = { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] }

/** Small schemas keep scope explicit and avoid exposing core write/feedback internals. */
export const TOOL_SPECS = [
  { name: 'library_search', action: 'list', title: 'Search papers', parameters: { query: string('Title, author, tag, DOI or indexed text'), limit: { type: 'number' }, offset: { type: 'number' } } },
  { name: 'library_get', action: 'get', title: 'Read paper metadata', parameters: { id: string('Library paper ID', true) } },
  { name: 'library_import', action: 'import', title: 'Import papers', mutate: true, parameters: { path: string('Local PDF, CSL JSON, Zotero JSON, RIS or BibTeX path; originals remain unchanged'), doi: string('DOI to resolve through Crossref') } },
  { name: 'library_cite', action: 'cite', title: 'Format citations', parameters: { ids: { ...ids, required: true }, format: { type: 'string', enum: ['apa', 'biblatex', 'csl-json'], required: true } } },
  { name: 'library_annotations', action: 'annotations', title: 'Read PDF annotations', parameters: { id: string('Library paper ID', true) } },
  { name: 'library_annotate', action: 'annotate', title: 'Annotate managed PDF', mutate: true, parameters: { id: string('Library paper ID', true), page: { type: 'number', required: true }, type: { type: 'string', enum: ['highlight', 'note'], required: true }, rects: { type: 'array', items: { type: 'array', items: { type: 'number' } }, required: true }, text: string('Exact quoted passage'), comment: string('Reader comment'), author: string('Annotation author'), color: string('Hex RGB annotation color') } },
  { name: 'library_graph', action: 'graph', title: 'Read literature graph', parameters: { id: string('Optional focus paper ID'), limit: { type: 'number' } } },
  { name: 'library_link', action: 'link', title: 'Connect papers', mutate: true, parameters: { source: string('Source paper ID', true), target: string('Target paper ID', true), relation: { type: 'string', enum: ['related', 'supports', 'contradicts', 'cites'], required: true }, note: string('Reason and provenance for the relationship') } },
  { name: 'library_feedback', action: 'ai_feedback', title: 'Request annotation feedback', mutate: true, parameters: { id: string('Library paper ID', true), annotation_ids: ids, provider: string('Configured Harness provider; defaults to calling agent route'), model: string('Configured model; defaults to calling agent route'), reasoning_effort: string('Optional provider-owned effort; defaults to current conversation effort when following its route') } },
]

/** Pick only declared tool arguments, including on programmatic direct calls. */
export function requestFromTool(spec, args, exec) {
  const request = { action: spec.action }
  for (const key of Object.keys(spec.parameters)) if (args[key] !== undefined) request[key] = args[key]
  if (request.path !== undefined) request.path = resolve(exec.agent?.session?.header?.cwd ?? process.cwd(), request.path)
  return request
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
          if (spec.action === 'import' && Number(Boolean(request.path)) + Number(Boolean(request.doi)) !== 1) throw new Error('Specify exactly one local path or DOI')
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
