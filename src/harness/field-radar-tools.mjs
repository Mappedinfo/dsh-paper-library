/** Native tools share the browser's bounded store and model lifecycle. */
const text = (description, required = true) => ({ type: 'string', description, ...(required ? { required: true } : {}) })
export const FIELD_RADAR_TOOL_SPECS = [
  { name: 'library_field_radar', action: 'field_radar_tool', radar: true, title: 'Read research topics, match library papers, or retrieve a saved AI research-view draft', parameters: { operation: { type: 'string', required: true, enum: ['list', 'get', 'match', 'analysis_get'] }, input_json: text('JSON object <=128KiB. list:{offset?,limit?}; get:{id}; match:{papers:[{id,title,doi?}],offset?,limit?}; analysis_get:{id,request_id}. Metadata only, no PDFs or local paths.') } },
  { name: 'library_field_radar_import', action: 'field_radar_import', radar: true, mutate: true, title: 'Save an explicit source-backed research topic with revision checking; never modify papers', parameters: { input_json: text('JSON object <=128KiB: {document:{schema_version:1,topic:{id,title,question,scope?},sources:[],papers:[],scholars:[],claims:[]},expected_revision:0|hash}. IDs and source_ids required; preserve uncertainty, no invented dates or identities. Larger documents require UI import (1MiB).') } },
  { name: 'library_field_radar_analyze', action: 'field_radar_analyze', radar: true, mutate: true, title: 'Explicitly request one configured DSH model call to analyze saved topic evidence into a separate needs-review draft', parameters: { input_json: text('JSON object:{id,expected_revision,request_id}. Read topic first. Uses quota once; repeat request_id retrieves saved pending/failed/complete state, never auto-retries. No external fetch, PDF scan, schedule or topic overwrite.') } },
  { name: 'library_field_radar_render', action: 'field_radar_render', radar: true, mutate: true, title: 'Render a private research diagram without a browser or model call', parameters: { input_json: text('JSON: {id,expected_revision?,view?:overview|timeline|concepts|research-lines|scholars|frequency|publications|citations|geography,language?:zh|en,group_by?:task|subtopic|research_group,frequency_by?:task|method|dataset,format?:png|svg,width?:1200..2400,offset?:0,limit?:1..12,filters?:{query?,task?,year?}}. Saves immutable private image and source sidecar, returns a local path. Uses saved source-backed topic, no model quota.') } },
]
export function fieldRadarToolRequest(spec, args) {
  if (typeof args.input_json !== 'string' || Buffer.byteLength(JSON.stringify(args)) > 128 * 1024) throw new Error('Field Radar tool arguments must fit within 128 KiB')
  let value
  try { value = JSON.parse(args.input_json) } catch { throw new Error('Field Radar input_json must be valid JSON') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Field Radar input_json must be an object')
  const operation = spec.action === 'field_radar_tool' ? args.operation : spec.action.replace('field_radar_', '')
  const fields = { render: ['id','expected_revision','view','format','width','offset','limit','filters','group_by','frequency_by','language'], list: ['offset', 'limit'], get: ['id'], match: ['papers', 'offset', 'limit'], analysis_get: ['id', 'request_id'], import: ['document', 'expected_revision'], analyze: ['id', 'expected_revision', 'request_id'] }
  if (!fields[operation] || spec.action === 'field_radar_tool' && !spec.parameters.operation.enum.includes(operation)) throw new Error('Unsupported Field Radar operation')
  for (const key of Object.keys(value)) if (!fields[operation].includes(key)) throw new Error(`Unsupported Field Radar field: ${key}`)
  return { ...value, action: `field_radar_${operation}` }
}
export async function handleFieldRadarTool(options, request, signal) {
  const service = request.action === 'field_radar_render' ? options.fieldRadarExport : ['field_radar_analyze', 'field_radar_analysis_get'].includes(request.action) ? options.fieldRadarAnalysis : options.fieldRadar
  if (!service?.handle) throw new Error('Field Radar service is not available in this host')
  return service.handle(request, { signal })
}
