#!/usr/bin/env node
// Read-only paired inspection of two saved paper-analysis runs.
import { constants } from 'node:fs'
import { open, mkdir, chmod, writeFile, realpath, lstat, readdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { isAbsolute, resolve, dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHeadlessAnalysis } from '../src/headless-analysis.mjs'
import { dispatch as defaultDispatch } from '../src/bridge.mjs'
import { hashResidentPdf } from './inspect-paper-analysis-batch.mjs'
import { analysisInputOptions } from '../src/analysis-input.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MAX_JSON = 8 * 1024 * 1024
const within = (a,b) => { const p=relative(a,b); return p==='' || p!=='..' && !p.startsWith(`..${process.platform==='win32'?'\\':'/'}`) && !isAbsolute(p) }
const safeError = e => /^[A-Z][A-Z0-9_]{1,100}$/.test(e?.code ?? '') ? e.code : 'INSPECTION_FAILED'

async function readJSON(path, max=MAX_JSON) {
  let h
  try { h=await open(path, constants.O_RDONLY|(constants.O_NOFOLLOW??0)|(constants.O_NONBLOCK??0)); const s=await h.stat()
    if(!s.isFile()||s.size>max) throw new Error('unsafe'); const b=Buffer.alloc(max+1),{bytesRead}=await h.read(b,0,b.length,0)
    const t=await h.stat(); if(bytesRead!==s.size||t.size!==s.size||t.ino!==s.ino||t.mtimeMs!==s.mtimeMs) throw new Error('changed')
    return JSON.parse(b.subarray(0,bytesRead).toString('utf8'))
  } finally { await h?.close() }
}
function planShape(plan) {
  return JSON.stringify({mode:plan.mode,notes:plan.notes,review:plan.review??false,...analysisInputOptions(plan),routes:[...(plan.routes??[])].map(r=>[...r.ids].sort()).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)))})
}
function byId(plan) { const out=new Map(); for(const r of plan.routes??[]) for(const id of r.ids??[]) { if(out.has(id)) throw new Error('DUPLICATE_PAPER_ID'); out.set(id,r.name) } return out }
function quoteRefs(batch) {
  const refs=[]
  for(const n of batch.draft?.nodes??[]) if(typeof n?.quote==='string'&&n.quote) refs.push({kind:'graph',node_id:n.id??null,source_id:n.source_id??null,quote:n.quote})
  for(const row of [...(batch.draft?.edges??[]),...(batch.draft?.assertions??[])]) if(typeof row?.quote==='string'&&row.quote) refs.push({kind:'graph_relation',source_id:row.source_id??null,quote:row.quote})
  return refs
}
async function exactCheck(refs, id, dispatch, library) {
  const cache=new Map(), out=[]
  for(const ref of refs) {
    if(typeof ref.source_id!=='string'||typeof ref.quote!=='string') { out.push({...ref,check:'unavailable'}); continue }
    try {
      if(!cache.has(ref.source_id)) cache.set(ref.source_id, await dispatch({action:'knowledge_source_get',id:ref.source_id},{library}))
      const src=cache.get(ref.source_id)
      out.push({...ref,check:src.entity?.kind==='paper'&&src.entity.id===id&&typeof src.text==='string'&&src.text.includes(ref.quote)?'exact_match':'mismatch'})
    } catch { out.push({...ref,check:'unavailable'}) }
  }
  return out
}
async function inspectPaper({id, route, plan, run, analysis, dispatch, library, selection}) {
  const manifest=run.manifest?.routes?.find(r=>r.name===route.name)
  const rid=manifest?.request_id ?? route.request_id
  const paperRequestId=rid ? `batch-${createHash('sha256').update(JSON.stringify([rid,id])).digest('hex')}` : null
  const item={id,request_id:paperRequestId,title:selection?.title??null,status:'unavailable',model:null,coverage:null,batches:[],metadata:{field_count:0,fields:[]},note:{status:null,body:null},warnings:[],error:null}
  if(!rid) { item.warnings.push('REQUEST_ID_MISSING'); return item }
  let record
  try { record=await analysis({action:'paper_analysis_get',id,request_id:paperRequestId}) }
  catch(e) { item.error=safeError(e); return item }
  item.status=record.status??'unknown'; item.model=record.model??manifest?.model??null; item.coverage=record.coverage??null
  item.metadata={field_count:Object.keys(record.metadata??{}).length,fields:Object.keys(record.metadata??{}),values:record.metadata??{},field_sources:record.field_sources??{}}
  item.metadata.quote_checks=await exactCheck(Object.entries(record.field_sources??{}).flatMap(([field,items])=>(Array.isArray(items)?items:[]).map(ref=>({kind:'metadata',field,source_id:ref?.source_id??null,quote:ref?.quote??null}))),id,dispatch,library)
  item.metadata.quote_count=item.metadata.quote_checks.length
  item.warnings=[...(record.warnings??[])]; item.error=record.error??null
  item.note_coverage=record.note_coverage??null
  for(let i=0;i<(record.batch_count??0);i++) {
    try {
      const batch=await analysis({action:'paper_analysis_get',id,request_id:paperRequestId,batch_index:i})
      const draft=batch.draft
      const refs=quoteRefs(batch)
      const batchSourceIds=batch.source_ids??[]
      const hasBatchMetadata=Object.hasOwn(batch,'batch_field_sources')&&batch.batch_field_sources&&typeof batch.batch_field_sources==='object'
      const metadataRefs=hasBatchMetadata?Object.entries(batch.batch_field_sources).flatMap(([field,items])=>(Array.isArray(items)?items:[])
        .map(ref=>({kind:'metadata',field,source_id:ref?.source_id??null,quote:ref?.quote??null}))):[]
      item.batches.push({index:i,coverage:batch.batch_coverage??batch.coverage??null,draft_id:draft?.id??batch.draft_id??null,
        source_ids:batchSourceIds,metadata_quote_status:hasBatchMetadata?'available':'unavailable_batch_projection',
        batch_metadata:batch.batch_metadata??null,batch_field_sources:batch.batch_field_sources??null,
        metadata_quote_checks:hasBatchMetadata?await exactCheck(metadataRefs,id,dispatch,library):[],
        metadata_quote_count:hasBatchMetadata?metadataRefs.length:null,
        node_count:draft?.nodes?.length??null,draft:draft??null,quote_checks:await exactCheck(refs,id,dispatch,library),metadata:batch.metadata??null,
        field_sources:batch.field_sources??null,quote_normalization:batch.batch_quote_normalization??batch.quote_normalization??null})
    } catch(e) { item.batches.push({index:i,error:safeError(e),quote_checks:[]}); item.warnings.push(`BATCH_${i}_UNAVAILABLE`) }
  }
  if(record.note_draft_id) try { const note=await dispatch({action:'knowledge_draft_get',id:record.note_draft_id},{library}); item.note={id:record.note_draft_id,status:note.status??null,body:note.body??null,title:note.title??null,partial:record.note_coverage?.full_document===false||record.note_coverage?.partial===true,coverage:record.note_coverage??null} }
  catch { item.note={status:'unavailable',body:null,partial:null,coverage:record.note_coverage??null}; item.warnings.push('NOTE_UNAVAILABLE') }
  else if(plan.notes===true) { item.note={status:'missing',body:null,partial:null,coverage:record.note_coverage??null}; item.warnings.push('NOTE_REQUIRED_MISSING') }
  else item.note={status:'not_required',body:null,partial:false,coverage:record.note_coverage??null}
  item.deliverable_complete=record.status==='complete'&&record.coverage?.full_document===true&&(!plan.notes||Boolean(record.note_draft_id)&&item.note.status!=='unavailable'&&item.note.status!=='missing'&&item.note.partial!==true)
  return item
}
async function readReceipts(runDir) {
  const dir=join(runDir,'responses'), result=[]
  let files=[]; try { files=(await readdir(dir)).filter(name=>/^\d{6}-[A-Za-z0-9_-]+\.json$/.test(name)).sort() } catch { return result }
  for(const name of files) try {
    const row=await readJSON(join(dir,name),1024*1024)
    let body; try { body=JSON.parse(row.response_body??'') } catch {}
    const usage=body?.usage??null
    const promptDetails=usage?.prompt_tokens_details??{}, completionDetails=usage?.completion_tokens_details??{}, outputDetails=usage?.output_tokens_details??{}
    const inputReported=usage?.input_tokens??usage?.prompt_tokens??null, outputReported=usage?.output_tokens??usage?.completion_tokens??null
    const cacheRead=usage?.cache_read_input_tokens??promptDetails.cached_tokens??usage?.cached_tokens??null
    const cacheWrite=usage?.cache_creation_input_tokens??usage?.cache_write_input_tokens??null
    const inputConvention=Number.isFinite(usage?.prompt_tokens)?'prompt_tokens_includes_cached_tokens':Number.isFinite(usage?.input_tokens)?'input_tokens_excludes_cached_tokens':'unknown'
    const inputIncludingCache=Number.isFinite(usage?.prompt_tokens)?usage.prompt_tokens:
      Number.isFinite(inputReported)&&Number.isFinite(cacheRead)&&Number.isFinite(cacheWrite)?inputReported+cacheRead+cacheWrite:null
    const inputExcludingCache=Number.isFinite(usage?.input_tokens)?usage.input_tokens:
      Number.isFinite(usage?.prompt_tokens)&&Number.isFinite(cacheRead)?Math.max(0,usage.prompt_tokens-cacheRead):null
    const thinking=completionDetails.reasoning_tokens??outputDetails.thinking_tokens??null
    const finishReason=body?.choices?.[0]?.finish_reason??null, stopReason=body?.stop_reason??null
    result.push({receipt_file:name,call_id:row.call_id??null,route:row.route??null,status:row.status??null,error_code:row.error_code??row.transport_error??null,
      started_at:row.started_at??null,finished_at:row.finished_at??null,latency_ms:Number.isFinite(Date.parse(row.finished_at)-Date.parse(row.started_at))?Date.parse(row.finished_at)-Date.parse(row.started_at):null,
      provider:row.provider??null,model:row.model??null,returned_model:row.returned_model??null,http_status:row.http_status??null,
      finish_reason:finishReason,stop_reason:stopReason,
      usage:{raw:usage,input_token_convention:inputConvention,input_tokens_reported:Number.isFinite(inputReported)?inputReported:null,
        input_tokens_including_cache:Number.isFinite(inputIncludingCache)?inputIncludingCache:null,input_tokens_excluding_cache:Number.isFinite(inputExcludingCache)?inputExcludingCache:null,
        cache_read_tokens:Number.isFinite(cacheRead)?cacheRead:null,cache_write_tokens:Number.isFinite(cacheWrite)?cacheWrite:null,
        output_tokens:Number.isFinite(outputReported)?outputReported:null,thinking_tokens:Number.isFinite(thinking)?thinking:null},analysis_context:row.analysis_context??null,
      prompt_sha256:row.prompt_sha256??null,prompt_bytes:row.prompt_bytes??null,response_body:row.response_body??null,
      input_sha256:row.input_sha256??null,image_inputs:row.image_inputs??[],
      response_body_encoding:row.response_body_encoding??null,response_body_truncated:row.response_body_truncated===true})
  } catch { result.push({receipt_file:name,status:'unreadable',error_code:'RECEIPT_UNAVAILABLE'}) }
  return result
}
function responseStats(receipts) {
  const sumKnown=key=>{const rows=receipts.filter(r=>Number.isFinite(r.usage?.[key]));return {known_sum:rows.length?rows.reduce((n,r)=>n+r.usage[key],0):null,known_calls:rows.length}}
  const tokenTotals=Object.fromEntries(['input_tokens_reported','input_tokens_including_cache','input_tokens_excluding_cache','cache_read_tokens','cache_write_tokens','output_tokens','thinking_tokens'].map(key=>[key,sumKnown(key)]))
  const reasons=key=>Object.fromEntries([...new Set(receipts.map(r=>r[key]).filter(v=>typeof v==='string'))].map(reason=>[reason,receipts.filter(r=>r[key]===reason).length]))
  return {calls:receipts.length,succeeded:receipts.filter(r=>r.status==='succeeded').length,failed:receipts.filter(r=>r.status==='failed').length,
    token_totals:tokenTotals,finish_reason_counts:reasons('finish_reason'),stop_reason_counts:reasons('stop_reason'),
    unavailable:receipts.filter(r=>r.status==='unreadable').length,latency_ms:receipts.map(r=>r.latency_ms).filter(Number.isFinite),receipt_files:receipts.map(r=>r.receipt_file)}
}
function quoteTotals(papers,side) {
  const refs=new Map()
  for(const p of papers) for(const row of [...(p[side].metadata?.quote_checks??[]),...p[side].batches.flatMap(b=>[...(b.metadata_quote_checks??[]),...(b.quote_checks??[])])]) {
    const key=JSON.stringify([row.kind,row.field??null,row.source_id??null,row.quote??null]); if(!refs.has(key)) refs.set(key,row)
  }
  const all=[...refs.values()]
  return {checked:all.length,exact_match:all.filter(x=>x.check==='exact_match').length,mismatch:all.filter(x=>x.check==='mismatch').length,unavailable:all.filter(x=>x.check==='unavailable').length}
}
function md(report) {
  const lines=['# 两次论文整理运行比较','','按论文 ID 配对；引文结果只表示保存的 quote 是否能在对应本地来源中精确找到，不代表语义正确性。','',
    '| 运行 | 请求成功/失败 | 输入总量（已知值） | 输入含缓存 | 输入不含缓存 | 缓存读/写 | 输出 | 思考 tokens |',
    '|---|---:|---:|---:|---:|---:|---:|---:|']
  for(const side of ['left','right']) { const s=report.usage_latency[side],t=s.token_totals,fmt=k=>`${t[k].known_sum??'未知'} (${t[k].known_calls})`
    lines.push(`| ${side} | ${s.succeeded}/${s.failed} | ${fmt('input_tokens_reported')} | ${fmt('input_tokens_including_cache')} | ${fmt('input_tokens_excluding_cache')} | ${fmt('cache_read_tokens')} / ${fmt('cache_write_tokens')} | ${fmt('output_tokens')} | ${fmt('thinking_tokens')} |`)
  }
  lines.push('')
  for(const side of ['left','right']) { const s=report.usage_latency[side]; lines.push(`停止原因 ${side}：finish_reason ${JSON.stringify(s.finish_reason_counts)}；stop_reason ${JSON.stringify(s.stop_reason_counts)}。`, '') }
  lines.push('', '输入 token 按提供商原始口径保留：prompt_tokens 已含缓存；Anthropic input_tokens 不含 cache read/write。未知的缓存或思考 token 保持未知。停止原因分布见 JSON 明细。','',
    '| Paper ID | 左状态/全文 | 右状态/全文 | 左批次/字段/note | 右批次/字段/note |', '|---|---|---|---|---|')
  for(const p of report.papers) lines.push(`| ${p.id} | ${p.left.status} / ${p.left.coverage?.full_document===true?'是':'否'} | ${p.right.status} / ${p.right.coverage?.full_document===true?'是':'否'} | ${p.left.batches.length} / ${p.left.metadata.field_count} / ${p.left.note.status??'—'} | ${p.right.batches.length} / ${p.right.metadata.field_count} / ${p.right.note.status??'—'} |`)
  lines.push('','模型字段是建议值；本报告不裁定内容真伪，也不估算费用。'); return lines.join('\n')+'\n'
}

export async function compareRuns({leftPlanPath,leftRunPath,rightPlanPath,rightRunPath,selectionPath,outPath,createAnalysis=createHeadlessAnalysis,dispatch=defaultDispatch}) {
  for(const p of [leftPlanPath,leftRunPath,rightPlanPath,rightRunPath,selectionPath,outPath]) if(typeof p!=='string'||!isAbsolute(p)) throw new Error('COMPARE_PATH_INVALID')
  const [lp, rp, sel, lr, rr]=await Promise.all([readJSON(leftPlanPath,1024*1024),readJSON(rightPlanPath,1024*1024),readJSON(selectionPath),readJSON(join(leftRunPath,'result.json')),readJSON(join(rightRunPath,'result.json'))])
  if(planShape(lp)!==planShape(rp)) throw new Error('RUN_OPTIONS_MISMATCH')
  const [leftLibrary,rightLibrary]=await Promise.all([realpath(lp.library),realpath(rp.library)])
  if(leftLibrary!==rightLibrary) throw new Error('LIBRARY_MISMATCH')
  const li=byId(lp),ri=byId(rp),si=new Map((sel.papers??[]).map(p=>[p.id,p]))
  if(li.size!==ri.size||[...li.keys()].some(id=>!ri.has(id))||li.size!==si.size||[...li.keys()].some(id=>!si.has(id))) throw new Error('PAPER_SET_MISMATCH')
  const selectionHash=new Map((sel.papers??[]).map(p=>[p.id,String(p.sha256??'').toLowerCase()]))
  const inputManifest=async dir=>{ try{return await readJSON(join(dir,'run-manifest.json'))}catch{return null} }
  const [lm,rm]=await Promise.all([inputManifest(leftRunPath),inputManifest(rightRunPath)])
  if(lm&&rm) for(const id of li.keys()) { const a=lm.routes.find(r=>r.ids.includes(id)),b=rm.routes.find(r=>r.ids.includes(id)); if(!a||!b) throw new Error('RUN_MANIFEST_INCOMPLETE') }
  if([...selectionHash.values()].some(h=>!/^[a-f0-9]{64}$/.test(h))) throw new Error('SELECTION_HASH_INVALID')
  const pdfChecks=new Map()
  for(const row of sel.papers) { const check=await hashResidentPdf(row); pdfChecks.set(row.id,check); if(check.status!=='match') throw new Error(`PDF_HASH_OR_RESIDENCY_MISMATCH:${check.status}`) }
  const project=await realpath(ROOT), requestedOut=resolve(outPath), parent=await realpath(dirname(requestedOut)), out=join(parent,requestedOut.split(/[\\/]/).at(-1))
  if(within(project,out)||within(leftLibrary,out)||within(rightLibrary,out)||within(resolve(leftRunPath),out)||within(resolve(rightRunPath),out)) throw new Error('COMPARE_OUTPUT_UNSAFE')
  for(let cursor=parent;;cursor=dirname(cursor)) { try { await lstat(join(cursor,'.git')); throw new Error('COMPARE_OUTPUT_IN_GIT') } catch(e) { if(e.message==='COMPARE_OUTPUT_IN_GIT') throw e; if(e.code!=='ENOENT') throw e } if(dirname(cursor)===cursor) break }
  await mkdir(out,{mode:0o700}); await chmod(out,0o700)
  const library=leftLibrary, analyses=[]
  analyses.push(await createAnalysis({library,python:lp.python,localStateHome:lp.localStateHome}))
  try { analyses.push(await createAnalysis({library:rightLibrary,python:rp.python,localStateHome:rp.localStateHome})) }
  catch(e) { analyses[0].dispose?.(); throw e }
  const [leftAnalysis,rightAnalysis]=analyses
  const [leftReceipts,rightReceipts]=await Promise.all([readReceipts(leftRunPath),readReceipts(rightRunPath)])
  const records=[]
  try {
    for(const id of li.keys()) {
      const lroute=lm?.routes?.find(r=>r.ids.includes(id))??{name:li.get(id),request_id:null}
      const rroute=rm?.routes?.find(r=>r.ids.includes(id))??{name:ri.get(id),request_id:null}
      const [left,right]=await Promise.all([inspectPaper({id,route:lroute,plan:lp,run:{...lr,manifest:lm},analysis:leftAnalysis,dispatch,library,selection:si.get(id)}),
        inspectPaper({id,route:rroute,plan:rp,run:{...rr,manifest:rm},analysis:rightAnalysis,dispatch,library,selection:si.get(id)})])
      left.model_calls=leftReceipts.filter(row=>row.analysis_context?.id===id&&row.analysis_context?.request_id===left.request_id)
      right.model_calls=rightReceipts.filter(row=>row.analysis_context?.id===id&&row.analysis_context?.request_id===right.request_id)
      records.push({id,sha256:selectionHash.get(id),pdf_current_check:pdfChecks.get(id),left,right})
    }
  } finally { for(const analysis of analyses) analysis.dispose?.() }
  const counts={papers:records.length}
  for(const side of ['left','right']) {
    counts[`${side}_full_document`]=records.filter(p=>p[side].coverage?.full_document===true).length
    counts[`${side}_needs_review_note`]=records.filter(p=>p[side].note?.status==='needs-review').length
    counts[`${side}_partial_note_coverage`]=records.filter(p=>p[side].note?.partial===true).length
    counts[`${side}_metadata_fields`]=records.reduce((n,p)=>n+(p[side].metadata?.field_count??0),0)
    counts[`${side}_warnings`]=records.reduce((n,p)=>n+(p[side].warnings?.length??0),0)
    counts[`${side}_errors`]=records.filter(p=>p[side].error||p[side].note?.status==='unavailable').length
  }
  const safeRoutes=routes=>Array.isArray(routes)?routes.map(r=>({name:r.name??null,status:r.status??null,error_code:r.error_code??null,error:r.error??null,counts:r.counts??null})):[]
  const report={schema:1,created_at:new Date().toISOString(),run_status:{left:lr.status??'unknown',right:rr.status??'unknown'},route_results:{left:safeRoutes(lr.routes),right:safeRoutes(rr.routes)},
    usage_latency:{left:responseStats(leftReceipts),right:responseStats(rightReceipts)},quote_exactmatch:{left:quoteTotals(records,'left'),right:quoteTotals(records,'right')},counts,papers:records}
  for(const row of records) for(const side of ['left','right']) if(row[side].note.body!==null) {
    const safeId=row.id.replace(/[^A-Za-z0-9_-]/g,'_')
    await writeFile(join(out,`${side}-note-${safeId}.md`),String(row[side].note.body),{mode:0o600,flag:'wx'})
    row[side].note.markdown_file=`${side}-note-${safeId}.md`
  }
  await writeFile(join(out,'comparison.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600,flag:'wx'})
  await writeFile(join(out,'summary.md'),md(report),{mode:0o600,flag:'wx'})
  return report
}

async function main(){const a=process.argv.slice(2),f=new Map();if(a.length%2)throw new Error('COMPARE_CLI_INVALID');for(let i=0;i<a.length;i+=2){if(!['--left-plan','--left-run','--right-plan','--right-run','--selection','--out'].includes(a[i])||f.has(a[i])||!a[i+1])throw new Error('COMPARE_CLI_INVALID');f.set(a[i],a[i+1])}if(f.size!==6)throw new Error('COMPARE_CLI_INVALID');const r=await compareRuns({leftPlanPath:f.get('--left-plan'),leftRunPath:f.get('--left-run'),rightPlanPath:f.get('--right-plan'),rightRunPath:f.get('--right-run'),selectionPath:f.get('--selection'),outPath:f.get('--out')});process.stdout.write(JSON.stringify(r.counts)+'\n')}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) main().catch(e=>{process.stderr.write(`${safeError(e)}\n`);process.exitCode=1})
