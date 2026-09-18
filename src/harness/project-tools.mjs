/** Reading projects for the agent.
 *
 * A project groups papers and a paper may belong to several projects; the edge is the
 * catalog's `project_papers` table, so linking never copies a paper and archiving a project
 * never archives its papers. Requests are handed to the catalog through the normal dispatch
 * path, which is what keeps projects queryable next to the library they describe.
 */
const text = (description, required = false) => ({ type: 'string', description, ...(required ? { required: true } : {}) })
const operations = values => ({ type: 'string', enum: values, required: true })

export const PROJECT_TOOL_SPECS = [
  {
    name: 'library_projects', action: 'project_tool', title: 'Organise papers into reading projects', mutate: true,
    parameters: {
      operation: operations(['list', 'get', 'create', 'update', 'archive', 'restore', 'link', 'unlink', 'for_paper']),
      input_json: text('JSON object for the chosen operation. list: {query?,include_archived?,limit?,offset?}; get: {id}; create: {title,description?,tags?}; update: {id,title?,description?,tags?}; archive/restore: {id}; link: {id,paper_id,position?}; unlink: {id,paper_id}; for_paper: {paper_id}. A paper may belong to several projects and a project holds many papers; linking never copies or moves the paper, archiving a project keeps its papers, and an archived project must be restored before it can change.', true),
    },
  },
]

const OPERATIONS = new Set(PROJECT_TOOL_SPECS[0].parameters.operation.enum)

/** Parse the payload once; the catalog validates every field afterwards. */
export function projectToolRequest(spec, args) {
  const operation = args.operation
  if (!OPERATIONS.has(operation)) throw new Error('Unsupported project operation')
  if (typeof args.input_json !== 'string' || Buffer.byteLength(args.input_json, 'utf8') > 64 * 1024) throw new Error('Project input_json requires an object within 64 KiB')
  let value
  try { value = JSON.parse(args.input_json) } catch { throw new Error('input_json must be valid JSON') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('input_json must be an object')
  if (['action', 'library', 'python'].some(key => Object.hasOwn(value, key))) throw new Error('Project operation and configuration are owned by the host')
  return { ...value, action: `project_${operation}` }
}
