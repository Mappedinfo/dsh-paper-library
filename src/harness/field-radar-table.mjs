/** Pure, bounded, evidence-aware slide comparison tables. No I/O or model calls.
 * comparison schema (all optional; never inferred from a method's name):
 * short_name/research_group/task_output/method: {value:string,status,source_ids,evidence?}.
 * datasets: [{name,source_ids,status,openness:{value:'open'|'restricted'|'closed'|'unknown',
 *   status,source_ids,evidence:string}}]. Dataset name evidence does not establish openness.
 * od_generation: {output_is_od:Fact<boolean>,target_history_at_inference:Fact<boolean>,
 *   training_history?:Fact<boolean>,evaluation_history?:Fact<boolean>,status?,inference?}.
 * Fact = {value,status:'verified'|'needs_review'|'unknown'|'conflicting',source_ids,evidence}.
 * An OD fact needs a boolean, direct sources, nonempty evidence and verified status.
 * target_history_at_inference includes partial OD, matrix completion and calibration inputs.
 * Training-phase history and evaluation-only truth do not count as inference inputs.
 * status/inference on the comparison or paper propagates to all its draft fields.
 */
import '../../web/field-radar-data.js';

export const FIELD_RADAR_TABLE_COLUMNS = Object.freeze([
  ['research_group','研究组'], ['short_name','论文简称'], ['task_output','具体解决／生成什么'],
  ['datasets','数据集与开放性'], ['method','方法'], ['year','年份'], ['od_generation','推理无需目标区域历史 OD？']
].map(([key,label]) => Object.freeze({key,label})));
const fail = (message,status=400) => Object.assign(new Error(message),{code:'FIELD_RADAR_TABLE',status});
const object = v => v && typeof v === 'object' && !Array.isArray(v);
const arr = v => Array.isArray(v) ? v : v == null ? [] : [v];
const words = v => typeof v === 'string' || typeof v === 'number' ? String(v) : Array.isArray(v) ? v.map(words).filter(Boolean).join('；') : object(v) ? words(v.value ?? v.name ?? v.label ?? v.summary) : '';
const unique = v => [...new Set(v)];
const refs = v => Array.isArray(v?.source_ids) ? unique(v.source_ids) : [];
const draft = v => v?.inference === true || ['needs_review','inference','ai','draft'].includes(v?.status) || ['needs_review','inference','draft'].includes(v?.review_status);
const conflict = v => v?.status === 'conflicting' || v?.conflicting === true;
const esc = v => String(v ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const badge = status => ({verified:'',needs_review:'〔AI 推断／待核〕',unverified:'〔未核验〕',unknown:'〔未知〕',conflicting:'〔证据冲突〕'}[status] || '〔未核验〕');
function settings(input) {
  if (!object(input)) throw fail('Table options must be an object');
  const {format='html',offset=0,limit=100,filters={}}=input;
  if (!['html','csv','tsv','markdown'].includes(format)) throw fail('Unsupported table format');
  if (!Number.isSafeInteger(offset)||offset<0||offset>10000||!Number.isSafeInteger(limit)||limit<1||limit>100) throw fail('Table pagination out of bounds');
  if (!object(filters)||Object.keys(filters).some(k=>!['query','task','year'].includes(k))||Object.values(filters).some(v=>typeof v!=='string'||v.length>500)) throw fail('Invalid table filters');
  return {format,offset,limit,filters:{...filters}};
}
/** Validate a comparison independently so the topic importer and AI parser can share it. */
export function validatePaperComparison(value, document, {forceReview=false}={}) {
  let json; try { json=JSON.stringify(value); } catch { throw fail('Comparison must be JSON'); }
  if (!json||Buffer.byteLength(json)>256*1024) throw fail('Comparison exceeds 256 KiB',413);
  const c=JSON.parse(json),known=new Set(arr(document?.sources).map(s=>s.id));
  const check=(v,keys)=>{if(!object(v)||Object.keys(v).some(k=>!keys.includes(k)))throw fail('Invalid comparison object or unknown field');};
  const string=(v,max=16000)=>{if(typeof v!=='string'||v.length>max)throw fail('Comparison field must be bounded text');};
  const common=(v)=>{if(v.status!==undefined&&!['verified','needs_review','unknown','conflicting','inference','draft','unverified'].includes(v.status))throw fail('Invalid comparison status');if(v.inference!==undefined&&typeof v.inference!=='boolean')throw fail('Invalid inference flag');if(v.source_ids!==undefined&&(!Array.isArray(v.source_ids)||v.source_ids.length>1000||v.source_ids.some(id=>typeof id!=='string'||!known.has(id))))throw fail('Comparison references unknown sources');if(v.evidence!==undefined)string(v.evidence);};
  const meta=['status','inference','source_ids','evidence'];
  const scalar=(v,type)=>{check(v,['value',...meta]);common(v);if(v.value!==undefined&&v.value!==null&&(type==='boolean'?typeof v.value!=='boolean':typeof v.value!=='string'))throw fail('Invalid comparison value');if(typeof v.value==='string')string(v.value);};
  check(c,['short_name','research_group','task_output','datasets','method','od_generation',...meta]);common(c);
  for(const key of ['short_name','research_group','task_output','method'])if(c[key]!==undefined)scalar(c[key],'string');
  if(c.datasets!==undefined){if(!Array.isArray(c.datasets)||c.datasets.length>100)throw fail('Invalid comparison datasets');for(const d of c.datasets){check(d,['name','openness',...meta]);common(d);string(d.name,2000);if(d.openness!==undefined){scalar(d.openness,'string');if(d.openness.value!=null&&!['open','restricted','closed','unknown'].includes(d.openness.value))throw fail('Invalid dataset openness');}}}
  if(c.od_generation!==undefined){const o=c.od_generation;check(o,['output_is_od','target_history_at_inference','training_history','evaluation_history',...meta]);common(o);for(const key of ['output_is_od','target_history_at_inference','training_history','evaluation_history'])if(o[key]!==undefined)scalar(o[key],'boolean');}
  if(forceReview){const walk=v=>{if(Array.isArray(v)){v.forEach(walk);return;}if(!object(v))return;for(const [k,x]of Object.entries(v))if(k!=='source_ids')walk(x);v.status='needs_review';v.inference=true;};walk(c);}
  return c;
}
function tableDocument(value) {
  let json;try{json=JSON.stringify(value);}catch{throw fail('Table document must be JSON');}
  if(!json||Buffer.byteLength(json)>1024*1024)throw fail('Table document exceeds 1 MiB',413);
  const d=JSON.parse(json);
  if(!object(d)||d.schema_version!==1||!object(d.topic)||typeof d.topic.title!=='string'||typeof d.topic.id!=='string'||!Array.isArray(d.papers)||d.papers.length>500||!Array.isArray(d.sources)||d.sources.length>1000)throw fail('Invalid table document');
  const validId=v=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$/.test(v);
  const ids=new Set();for(const s of d.sources){if(!object(s)||!validId(s.id)||ids.has(s.id)||typeof s.title!=='string'||typeof s.url!=='string')throw fail('Invalid table source');ids.add(s.id);let u;try{u=new URL(s.url);}catch{throw fail('Invalid source URL');}if(!['http:','https:'].includes(u.protocol)||u.username||u.password)throw fail('Unsafe source URL');}
  const paperIds=new Set();for(const p of d.papers){if(!object(p)||!validId(p.id)||paperIds.has(p.id)||typeof p.title!=='string'||!p.title.trim()||!Array.isArray(p.source_ids)||p.year!=null&&(!Number.isInteger(p.year)||p.year<1000||p.year>9999))throw fail('Invalid table paper');paperIds.add(p.id);if(p.comparison!==undefined)p.comparison=validatePaperComparison(p.comparison,d);}
  const queue=[{v:d,depth:0}];let count=0;while(queue.length){const {v,depth}=queue.pop();if(++count>50000||depth>24)throw fail('Table document nesting exceeds bounds');if(v&&typeof v==='object')for(const [k,x]of Object.entries(v)){if(['__proto__','constructor','prototype'].includes(k))throw fail('Unsafe document field');if(k==='source_ids'&&(!Array.isArray(x)||x.some(id=>!ids.has(id))))throw fail('Unknown table source');queue.push({v:x,depth:depth+1});}}
  return d;
}
function cell(text,status='unknown',source_ids=[],extra={}) { return {text,status,source_ids:unique(source_ids),...extra}; }
function field(raw,fallback,parentDraft) {
  if (!object(raw)||!words(raw.value)) return cell(fallback||'未记录',parentDraft?'needs_review':fallback?'unverified':'unknown');
  const status=conflict(raw)?'conflicting':parentDraft||draft(raw)?'needs_review':raw.status==='verified'&&refs(raw).length?'verified':'unverified';
  return cell(words(raw.value),status,refs(raw),{evidence:words(raw.evidence)});
}
function fact(raw,parentDraft) {
  const status=conflict(raw)?'conflicting':parentDraft||draft(raw)?'needs_review':object(raw)&&raw.status==='verified'&&typeof raw.value==='boolean'&&refs(raw).length&&typeof raw.evidence==='string'&&raw.evidence.trim()?'verified':'unknown';
  return {value:status==='verified'?raw.value:null,status,source_ids:refs(raw),evidence:words(raw?.evidence),reported_value:typeof raw?.value==='boolean'?raw.value:null};
}
function eligibility(raw,parentDraft) {
  const pending=parentDraft||draft(raw),output=fact(raw?.output_is_od,pending),history=fact(raw?.target_history_at_inference,pending);
  const conflicting=conflict(raw)||[output,history].some(v=>v.status==='conflicting');
  const unresolvedDraft=pending||[output,history].some(v=>v.status==='needs_review');
  // Even a negative result requires a sourced explicit fact; conflicting evidence never resolves itself.
  const value=conflicting||unresolvedDraft?'unknown':output.value===false||history.value===true?'no':output.value===true&&history.value===false?'yes':'unknown';
  const status=conflicting?'conflicting':pending||[output,history].some(v=>v.status==='needs_review')?'needs_review':value==='unknown'?'unknown':'verified';
  const reason=value==='yes'?'是：生成 OD 流，推理不输入目标区域历史 OD':value==='no'?(output.value===false?'否：输出不是 OD 流生成':'否：推理使用目标区域历史 OD（含部分 OD／补全／校准）'):'未知：需核对 OD 输出与推理输入的直接证据';
  const details=[['输出',output],['推理历史 OD',history]].filter(([,v])=>v.evidence).map(([label,v])=>`${label}证据：${v.evidence}`).join('；');
  return cell([reason,details].filter(Boolean).join('；'),status,unique([...output.source_ids,...history.source_ids]),{value,output_is_od:output,target_history_at_inference:history,training_history:fact(raw?.training_history,pending),evaluation_history:fact(raw?.evaluation_history,pending)});
}
function datasetCells(p,c,parentDraft) {
  const structured=Array.isArray(c.datasets),items=structured?c.datasets:arr(p.datasets??p.dataset);
  if (!items.length) return cell('未记录；数据开放性未知');
  const entries=items.map(item=>{
    const name=structured?field({value:words(item?.name),status:item?.status,inference:item?.inference,source_ids:refs(item)},'',parentDraft):cell(words(item)||'未记录','unverified');
    const o=structured&&object(item?.openness)?item.openness:{};
    const valid=['open','restricted','closed'].includes(o.value)&&o.status==='verified'&&refs(o).length&&typeof o.evidence==='string'&&o.evidence.trim()&&!parentDraft&&!draft(item)&&!draft(o)&&!conflict(o);
    const openness=cell(valid?({open:'公开获取',restricted:'受限获取',closed:'不公开'}[o.value]):'开放性未知',conflict(o)?'conflicting':parentDraft||draft(item)||draft(o)?'needs_review':valid?'verified':'unknown',refs(o),{value:valid?o.value:'unknown',evidence:words(o.evidence)});
    return {name,openness,text:`${name.text}${badge(name.status)}；${openness.text}${badge(openness.status)}${openness.evidence?`；开放性证据：${openness.evidence}`:''}`,source_ids:unique([...name.source_ids,...openness.source_ids])};
  });
  return cell(entries.map(v=>v.text).join('\n'),entries.every(v=>v.name.status==='verified'&&v.openness.status==='verified')?'verified':parentDraft?'needs_review':'unknown',entries.flatMap(v=>v.source_ids),{entries});
}
export function buildFieldRadarTable(record,input={}) {
  const options=settings(input);
  if (!record?.document) throw fail('Research topic not found',404);
  if (input.expected_revision!==undefined&&(typeof input.expected_revision!=='string'||input.expected_revision!==record.revision)) throw fail('研究主题已变化，请刷新后再导出。',409);
  const doc=tableDocument(record.document),papers=globalThis.PaperFieldRadarData.filteredPapers(doc,options.filters),records=papers.slice(options.offset,options.offset+options.limit);
  let tableBytes=0;
  const rows=records.map(p=>{
    const c=object(p.comparison)?p.comparison:{},pending=draft(p)||draft(c);
    let group=field(c.research_group,'',pending);
    if (!c.research_group) {
      const groups=arr(doc.research_groups).filter(g=>g?.status==='verified'&&!draft(g)&&!conflict(g)&&refs(g).length&&arr(g.paper_ids).includes(p.id)&&words(g.name));
      if (groups.length) group=cell(groups.map(g=>words(g.name)).join('；'),'verified',groups.flatMap(refs));
    }
    const cells={research_group:group,short_name:field(c.short_name,`${p.title}（全称；未记录简称）`,pending),task_output:field(c.task_output,[words(p.task),words(p.output??p.task_axes?.output)].filter(Boolean).join('；输出：'),pending),datasets:datasetCells(p,c,pending),method:field(c.method,words(p.method),pending),year:cell(p.year==null?'未知':String(p.year),p.year==null?'unknown':pending?'needs_review':'unverified'),od_generation:eligibility(conflict(c)||conflict(p)?{...c.od_generation,status:'conflicting'}:c.od_generation,pending)};
    // Paper-level citations provide context only, never promote unsupported cells to verified facts.
    const comparisonRefs=[];const collect=v=>{if(!v||typeof v!=='object')return;comparisonRefs.push(...refs(v));Object.values(v).forEach(x=>{if(x&&typeof x==='object')collect(x);});};collect(c);
    const source_ids=unique([...refs(p),...comparisonRefs,...Object.values(cells).flatMap(v=>v.source_ids)]);
    const values=FIELD_RADAR_TABLE_COLUMNS.map(({key})=>{const v=cells[key];return `${v.text}${badge(v.status)}${v.source_ids.length?` [${v.source_ids.join(', ')}]`:''}`;});
    tableBytes+=Buffer.byteLength(JSON.stringify({cells,values}));if(tableBytes>2*1024*1024)throw fail('Derived table exceeds 2 MiB; reduce page limit without truncating fields',413);
    return {paper_id:p.id,cells,values,source_ids,context_source_ids:refs(p),od_generation:cells.od_generation,evidence_scope:words(p.evidence_scope)||'仅已保存来源／摘录；不表示全文已读'};
  });
  const source_ids=unique(rows.flatMap(r=>r.source_ids)).sort(),coverage={papers:papers.length,exported:rows.length,od_yes:0,od_no:0,od_unknown:0,verified_cells:0,unknown_cells:0,needs_review_cells:0};
  for(const row of rows){coverage[`od_${row.od_generation.value}`]++;for(const c of Object.values(row.cells)){if(c.status==='verified')coverage.verified_cells++;else if(c.status==='needs_review')coverage.needs_review_cells++;else coverage.unknown_cells++;}}
  const has_more=options.offset+rows.length<papers.length;
  const warnings=['仅整理已收录证据，不代表完整领域；论文级来源不证明每个单元格。','训练阶段使用历史 OD 不排除该任务；评估真值不等于推理输入。未知和 AI 待核项不作为已核验结论。'];
  if(has_more||options.offset)warnings.push(`分页导出：当前 ${rows.length} / ${papers.length} 篇，offset=${options.offset}；未静默截断字段，请继续分页。`);
  return {columns:FIELD_RADAR_TABLE_COLUMNS.map(c=>({...c})),rows,records,sources:doc.sources.filter(s=>source_ids.includes(s.id)),source_ids,total:papers.length,count:rows.length,has_more,settings:options,warnings,coverage,topic_id:doc.topic.id,title:doc.topic.title,topic_revision:record.revision,data_updated_at:record.updated_at??null,evidence_scope:'已保存主题的来源／摘录；不意味着全文审阅或全领域覆盖'};
}
// Neutralize formula-leading values including leading whitespace/control characters.
const spreadsheet = v => /^[\s\u0000-\u001f]*[=+\-@]/u.test(v) ? `'${v}` : v;
const delimited = (v,sep) => {const s=spreadsheet(String(v));return s.includes(sep)||/["\r\n]/.test(s)?`"${s.replace(/"/g,'""')}"`:s;};
const markdown = v => esc(spreadsheet(String(v))).replace(/\\/g,'\\\\').replace(/\|/g,'\\|').replace(/\r?\n/g,'<br>').replace(/`/g,'&#96;');
export function renderFieldRadarTable(record,input={}) {
  const result=buildFieldRadarTable(record,input),{columns,rows,sources,settings}=result;
  const notes=[`主题：${result.title}；主题 ID：${result.topic_id}；版本：${result.topic_revision??'未知'}；保存时间：${result.data_updated_at??'未知'}`,`导出范围：${result.count} / ${result.total} 篇；offset=${settings.offset}；has_more=${result.has_more}`,...result.warnings,`证据范围：${result.evidence_scope}`, ...rows.map(r=>`论文 ${r.paper_id}；${r.evidence_scope}；论文级背景来源（不作逐格核验）：${r.context_source_ids.join(', ')||'未记录'}`),...sources.map(s=>`[${s.id}] ${s.title}；${s.url}；核验日期：${s.accessed_at||'未知'}；证据范围：${words(s.evidence_scope)||words(s.evidence_level)||'未记录'}`)];
  let content;
  if(settings.format==='html')content=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>${esc(result.title)}</title><style>body{font:14px system-ui,sans-serif;color:#172f3a;margin:24px}table{border-collapse:collapse;width:100%}th,td{border:1px solid #bcccd1;padding:9px;text-align:left;vertical-align:top;white-space:pre-wrap;overflow-wrap:anywhere}th{background:#edf4f4}li{white-space:pre-wrap}</style><h1>${esc(result.title)}</h1><table><thead><tr>${columns.map(c=>`<th>${esc(c.label)}</th>`).join('')}</tr></thead><tbody>${rows.map(r=>`<tr>${r.values.map(v=>`<td>${esc(spreadsheet(v))}</td>`).join('')}</tr>`).join('')}</tbody></table><p>${result.count} / ${result.total} 篇；offset=${settings.offset}；版本 ${esc(result.topic_revision??'未知')}</p><ol>${notes.map(v=>`<li>${esc(v)}</li>`).join('')}</ol></html>`;
  else if(settings.format==='markdown')content=[`| ${columns.map(c=>markdown(c.label)).join(' | ')} |`,`| ${columns.map(()=>'---').join(' | ')} |`,...rows.map(r=>`| ${r.values.map(markdown).join(' | ')} |`),'',...notes.map(v=>`- ${markdown(v)}`)].join('\n');
  else {const sep=settings.format==='csv'?',':'\t';content=[columns.map(c=>c.label),...rows.map(r=>r.values),[],...notes.map(v=>[v])].map(row=>row.map(v=>delimited(v,sep)).join(sep)).join('\r\n');}
  if(Buffer.byteLength(content)>10*1024*1024)throw fail('Rendered table exceeds 10 MiB; reduce page limit',413);
  const clipboard_tsv=[columns.map(c=>c.label),...rows.map(r=>r.values)].map(row=>row.map(v=>delimited(v,'\t')).join('\t')).join('\r\n');
  return {...result,content,clipboard_tsv,...(settings.format==='html'?{clipboard_html:content.match(/<table>[\s\S]*?<\/table>/)?.[0]}:{})};
}
