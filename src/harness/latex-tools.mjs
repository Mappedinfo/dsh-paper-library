/** LaTeX projects for the agent: a real folder with a manuscript, its PDF and history.
 *
 * Reading operations never touch the folder beyond bounded file reads. Editing
 * operations are separated so the native approval pipeline can treat a build or a
 * write differently from a listing; every path arrives as a project-relative string
 * and the worker resolves it inside that project root.
 */
const text = (description, required = false) => ({ type: 'string', description, ...(required ? { required: true } : {}) })
const operations = values => ({ type: 'string', enum: values, required: true })

const READ_OPERATIONS = ['project_list', 'project_get', 'tree', 'read', 'pdf_pages', 'pdf_page', 'history', 'diff', 'compare']
const EDIT_OPERATIONS = ['project_create', 'project_update', 'project_archive', 'project_restore', 'write', 'compile', 'clean']

export const LATEX_TOOL_SPECS = [
  {
    name: 'library_latex',
    action: 'latex_tool',
    title: 'Read a LaTeX project folder',
    parameters: {
      operation: operations(READ_OPERATIONS),
      input_json: text('JSON object for the chosen operation. project_list: {query?,include_archived?,limit?,offset?}; project_get: {id}; tree: {id}; read: {id,path?} (path defaults to the main file); pdf_pages: {id}; pdf_page: {id,page?,scale?}; history: {id,path?,limit?}; diff: {id,path?,from_revision?,to_revision?} where a revision is a history id, "current" or "previous"; compare: {a,b,path?} diffs the same project-relative file across two folders. A project is a folder holding the .tex sources and the PDF they build to; nothing is copied into the library.', true),
    },
  },
  {
    name: 'library_latex_edit',
    action: 'latex_tool',
    title: 'Edit or build a LaTeX project folder',
    mutate: true,
    parameters: {
      operation: operations(EDIT_OPERATIONS),
      input_json: text('JSON object for the chosen operation. project_create: {root,title?,main_path?,create_missing?} where root is an absolute existing folder outside the managed library; project_update: {id,title?,main_path?}; project_archive/project_restore/clean: {id}; write: {id,path,content,expected_revision?,origin?} which is rejected with STATE_CONFLICT when the file changed since expected_revision, keeps a bounded text history and never writes outside the project; compile: {id,engine?,timeout_seconds?} runs the local latexmk in the folder (engines xelatex, pdflatex, lualatex) and reports exit code, parsed errors and the log tail; clean removes only known build side files, never sources or PDFs.', true),
    },
  },
]

const READ = new Set(READ_OPERATIONS)
const EDIT = new Set(EDIT_OPERATIONS)

/** Parse the payload once; the worker validates every field afterwards. */
export function latexToolRequest(spec, args) {
  const operation = args.operation
  if (!READ.has(operation) && !EDIT.has(operation)) throw new Error('Unsupported LaTeX operation')
  if (spec.name === 'library_latex' && !READ.has(operation)) throw new Error('Use library_latex_edit for changes')
  if (spec.name === 'library_latex_edit' && !EDIT.has(operation)) throw new Error('Use library_latex for reads')
  if (typeof args.input_json !== 'string' || Buffer.byteLength(args.input_json, 'utf8') > 128 * 1024) throw new Error('LaTeX input_json requires an object within 128 KiB')
  let value
  try { value = JSON.parse(args.input_json) } catch { throw new Error('input_json must be valid JSON') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('input_json must be an object')
  if (['action', 'library', 'python'].some(key => Object.hasOwn(value, key))) throw new Error('LaTeX operation and configuration are owned by the host')
  return { ...value, action: `latex_${operation}` }
}
