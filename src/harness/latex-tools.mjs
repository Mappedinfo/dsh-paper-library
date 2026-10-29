/** LaTeX projects for the agent: a real folder with a manuscript, its PDF and history.
 *
 * Reading operations never touch the folder beyond bounded file reads. Editing
 * operations are separated so the native approval pipeline can treat a build or a
 * write differently from a listing; every path arrives as a project-relative string
 * and the worker resolves it inside that project root.
 */
const text = (description, required = false) => ({ type: 'string', description, ...(required ? { required: true } : {}) })
const operations = values => ({ type: 'string', enum: values, required: true })

const READ_OPERATIONS = ['project_list', 'project_get', 'version_list', 'version_get', 'version_pdf_pages', 'version_pdf_page', 'version_read', 'version_review', 'tree', 'table_import', 'formula_check', 'outline', 'media_preview', 'review_list', 'review_export', 'read', 'lint', 'pdf_pages', 'pdf_page', 'history', 'diff', 'compare', 'synctex_edit', 'synctex_view']
const EDIT_OPERATIONS = ['project_create', 'project_update', 'project_archive', 'project_restore', 'project_link_reading', 'write', 'asset_import', 'compile', 'clean', 'review_put', 'review_delete']

export const LATEX_TOOL_SPECS = [
  {
    name: 'library_latex',
    action: 'latex_tool',
    title: 'Read a LaTeX project folder',
    parameters: {
      operation: operations(READ_OPERATIONS),
      input_json: text('JSON object for the chosen operation. project_list: {query?,include_archived?,limit?,offset?}; project_get: {id}; version_list: {id?,reading_project_id?,limit?,offset?}; version_get/version_review: {version_id}; version_read: {version_id,path}; version_pdf_pages: {version_id,review_pdf_version?}; version_pdf_page: {version_id,review_pdf_version?,page?,scale?}. Saved versions keep source, compiled PDF and review snapshots in the library; prior PDF review copies remain distinct when their anchors are stale. review_list: {id} returns current-entry source/native-PDF notes with stale flags; review_export: {id,format?:json|markdown|pdf}; table_import: {data_base64,sheet?} reads one bounded XLSX worksheet as values without formula evaluation (8 MiB upload, 100 rows/30 columns/2000 cells); formula_check: {id} extracts saved formulas and local structural diagnostics without a model call; tree/outline: {id}; media_preview: {id,path,page?,scale?} returns one bounded inert PNG or an explicit unsupported reason; outline follows static input/include in source order, reports unresolved paths and source line positions; read: {id,path?} (path defaults to the main file); lint: {id,mode?:"editing"|"submission",main_path?,paths?} checks saved source placeholders; editing marks warn and submission can return ok:false without blocking saving or building; pdf_pages: {id}; pdf_page: {id,page?,scale?}; history: {id,path?,limit?}; diff: {id,path?,from_revision?,to_revision?}; compare: {a,b,path?}; synctex_edit: {id,page,x,y} maps PDF to source; synctex_view: {id,path,line,column?} maps source to PDF.', true),
    },
  },
  {
    name: 'library_latex_edit',
    action: 'latex_tool',
    title: 'Edit or build a LaTeX project folder',
    mutate: true,
    parameters: {
      operation: operations(EDIT_OPERATIONS),
      input_json: text('JSON object for the chosen operation. project_create: {root,title?,main_path?,create_missing?}; project_update: {id,title?,main_path?}; project_link_reading: {id,reading_project_id} associates an existing reading project; project_archive/project_restore/clean: {id}; asset_import: {id,name,data_base64} validates PNG/JPEG and writes a collision-safe file under figures/ without replacing originals; write: {id,path,content,expected_revision?,origin?} is revision-checked and keeps bounded text history; compile: {id,engine?,timeout_seconds?,save_version?} runs local latexmk and reports errors; save_version:true saves a successful manual build with source and review snapshots, or returns version_error when this fails. review_put: {id,anchor?,comment?,status?:open|resolved,note_id?,expected_version?,request_id?,type?:note|highlight|underline|strikeout}; source anchors use {kind:source,path,revision,start,end,text} with Unicode codepoint offsets; PDF anchors use {kind:pdf,pdf_version,page,rects,text}; old anchors never move automatically; clean removes only known build side files.', true),
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
