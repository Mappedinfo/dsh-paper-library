/** Explicit operations for the unified library; review remains a user UI action. */
const text = (description, required = false) => ({type:'string',description,...(required?{required:true}:{})})
const operations = values => ({type:'string',enum:values,required:true})
export const RESOURCE_TOOL_SPECS = [
  {name:'library_resources',action:'resource_list',title:'Search papers and datasets',parameters:{kind:{type:'string',enum:['all','paper','dataset']},query:text('Name, identifier, publisher or metadata'),limit:{type:'integer'},offset:{type:'integer'},sort:{type:'string',enum:['title','created','modified','citekey']},order:{type:'string',enum:['asc','desc']},archived:{type:'boolean'}}},
  {name:'library_dataset',action:'dataset_tool',title:'Manage dataset records and explicit file previews',mutate:true,parameters:{operation:operations(['get','put','release_get','release_put','release_list','link_put','link_list','asset_put','asset_list','asset_preview','cite']),input_json:text('JSON object for the chosen operation. put: {metadata:{title,URL?,license?,description?},expected_revision:0}; get: {id}; link_put: {paper_id,dataset_id,relation,role?,evidence?,expected_revision:0}; preview: {id,asset_id}. Updates require the current revision. No automatic downloads.',true)}},
  {name:'library_knowledge',action:'knowledge_tool',title:'Save selected evidence and propose reviewable knowledge',mutate:true,parameters:{operation:operations(['source_put','source_get','source_check','source_list','draft_put','draft_get','draft_list','note_get','note_list','export']),input_json:text('JSON object. Entity is {kind:paper|dataset|release,id}. source_put takes entity,kind,text or annotation_ref; draft_put takes entity,source_ids,mode and note title/body or typed nodes/edges/assertions. All model proposals await user review; this tool cannot accept drafts. Reads/exports require explicit IDs or entity scope.',true)}},
]

export function resourceToolRequest(spec, args) {
  const operation = args.operation
  if (!spec.parameters.operation.enum.includes(operation)) throw new Error('Unsupported library operation')
  if (typeof args.input_json !== 'string' || Buffer.byteLength(args.input_json,'utf8') > 128 * 1024) throw new Error('Library input_json requires an object within 128 KiB')
  let value
  try { value = JSON.parse(args.input_json) } catch { throw new Error('input_json must be valid JSON') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('input_json must be an object')
  if (['action','library','python'].some(key=>Object.hasOwn(value,key))) throw new Error('Library operation and configuration are owned by the host')
  const request = {...value,action:`${spec.action === 'dataset_tool' ? 'dataset' : 'knowledge'}_${operation}`}
  if (request.action === 'dataset_link_put') { request.origin='ai'; request.review_status='needs-review' }
  if (request.action === 'knowledge_draft_put') { request.origin='llm'; request.status='needs-review' }
  return request
}
