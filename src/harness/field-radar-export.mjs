/** Headless, source-backed diagrams. No browser, network, model or PDF work. */
import '../../web/field-radar-data.js';
import { renderFieldRadarTable, validatePaperComparison } from './field-radar-table.mjs';
import { ANALYTIC_VIEWS } from './field-radar-analytics.mjs';
import { createRadarLocale } from './field-radar-i18n.mjs';
import { renderRadarChart } from './field-radar-charts.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, link, unlink, realpath } from 'node:fs/promises';
import { resolve, join } from 'node:path';
const MAX = 10 * 1024 * 1024;
const fail = (message, status = 400) => Object.assign(new Error(message), { code: 'FIELD_RADAR_EXPORT', status });
const hash = value => createHash('sha256').update(value).digest('hex');
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c])).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
const arr = value => Array.isArray(value) ? value : value == null ? [] : [value];
const words = value => typeof value === 'object' && value !== null ? (Array.isArray(value) ? value.map(words).join(' · ') : Object.entries(value).filter(([k]) => !k.endsWith('_ids')).map(([k,v]) => `${k}: ${words(v)}`).join(' · ')) : String(value ?? '');
export function wrapRadarText(value, width, size = 20, maximum = 5) {
  const tokens=words(value).slice(0,16000).match(/[A-Za-z0-9][A-Za-z0-9'’–—-]*|\n|[^\S\n]+|[^\s]/gu)||[],rows=[];let line='',used=0;
  const measure=t=>[...t].reduce((sum,c)=>sum+size*(/[\u0000-\u007f]/.test(c)?.61:1),0);
  for(const token of tokens){if(token==='\n'){rows.push(line);line='';used=0;continue;}const w=measure(token);if(used+w>width&&line){rows.push(line.trimEnd());line='';used=0;}if(w>width){for(const c of token){const cw=measure(c);if(used+cw>width&&line){rows.push(line);line='';used=0;}line+=c;used+=cw;}}else if(line||token.trim()){line+=token;used+=w;}}
  if(line||!rows.length)rows.push(line.trimEnd());return rows.slice(0,maximum).map((row,i)=>i===maximum-1&&rows.length>maximum?row.slice(0,-1)+'…':row);
}
function textBlock(value, x, y, width, size = 20, max = 5, color = '#253e4a') { return `<text fill="${color}" font-size="${size}">${wrapRadarText(value,width,size,max).map((s,i)=>`<tspan x="${x}" y="${y+i*size*1.4}">${esc(s)}</tspan>`).join('')}</text>`; }
function options(input) {
  const view = input.view ?? 'overview', format = input.format ?? 'png', width = input.width ?? 1600, offset = input.offset ?? 0, limit = input.limit ?? 6, filters = input.filters ?? {};
  if (!['overview','timeline','concepts','research-lines','scholars',...ANALYTIC_VIEWS].includes(view) || !['png','svg'].includes(format)) throw fail('Unsupported export view or format');
  if (!Number.isInteger(width) || width < 1200 || width > 2400 || !Number.isInteger(offset) || offset < 0 || offset > 10000 || !Number.isInteger(limit) || limit < 1 || limit > 12) throw fail('Export dimensions or pagination out of bounds');
  if (!filters || typeof filters !== 'object' || Array.isArray(filters) || Object.keys(filters).some(k => !['query','task','year'].includes(k)) || Object.values(filters).some(v => typeof v !== 'string' || v.length > 500)) throw fail('Invalid export filters');
  const group_by=input.group_by??'subtopic',frequency_by=input.frequency_by??'task',language=input.language??'zh';
  if(!['zh','en'].includes(language))throw fail('Unsupported chart language; use zh or en');
  if(!['task','subtopic','research_group'].includes(group_by)||!['task','method','dataset'].includes(frequency_by))throw fail('Invalid chart grouping');
  return { view, format, width, offset, limit, filters,group_by,frequency_by,language };
}
export function renderFieldRadarSVG(record, input = {}) {
  const settings = options(input), { view,width,offset,limit,filters } = settings, doc = record.document;
  if (!doc) throw fail('Research topic not found',404);
  if (input.expected_revision !== undefined && (typeof input.expected_revision !== 'string' || input.expected_revision !== record.revision)) throw fail('研究主题已变化，请刷新后再导出。',409);
  if(ANALYTIC_VIEWS.includes(view))return renderRadarChart(record,settings);
  const locale=createRadarLocale(doc,settings.language),{ui,content}=locale;
  const block=(value,...args)=>textBlock(content(value),...args);
  const papers = globalThis.PaperFieldRadarData.filteredPapers(doc,filters), selectedIds = new Set(papers.map(p=>p.id));
  const rows = globalThis.PaperFieldRadarData.selectViewRows(doc,view,filters);
  const page = rows.slice(offset,offset+limit), rowHeight = 290, height = 410 + Math.max(1,page.length)*rowHeight;
  const title = {overview:ui('问题 → 方法 → 证据','Questions → methods → evidence'),timeline:ui('收录作品时间线','Included publication timeline'),concepts:ui('概念与区别','Concepts and distinctions'), 'research-lines':ui('研究脉络','Research lines'),scholars:ui('学者与贡献','Researchers and contributions')}[view];
  const svg = [`<svg xmlns="http://www.w3.org/2000/svg" lang="${settings.language}" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="#f4f7f6"/><g font-family="PingFang SC,Noto Sans CJK SC,Microsoft YaHei,sans-serif">`,block(content(doc.topic.title,doc.topic.id),48,58,width-96,32,2),block(title,48,150,width-96,24,1,'#176d68'),block(content(doc.topic.question,'Research question: translation unavailable'),48,192,width-96,20,2),block(`${ui('仅展示已收录证据，不代表完整领域。筛选','Included evidence only, not the complete field. Filters')} ${content(JSON.stringify(filters),'See original filters in JSON')} · ${page.length?offset+1:0}–${offset+page.length} / ${rows.length}`,48,264,width-96,17,2)];
  const refIds = new Set();
  function collect(v){if(!v||typeof v!=='object')return;for(const [k,c]of Object.entries(v)){if(k==='source_ids')arr(c).forEach(id=>refIds.add(id));else collect(c);}}
  if(view==='timeline' && page.length) svg.push(`<line x1="16" y1="334" x2="16" y2="${334+(page.length-1)*rowHeight}" stroke="#176d68" stroke-width="3"/>`);
  const col = (width-144)/3;
  page.forEach((row,i)=>{ collect(row); const y=310+i*rowHeight; if(view==='timeline')svg.push(`<circle cx="16" cy="${y+24}" r="7" fill="#b27b32"/>`); svg.push(`<rect x="32" y="${y}" width="${width-64}" height="270" rx="14" fill="white" stroke="#d8e3df"/>`);
    const label = `${row.year??(view==='timeline'?ui('年份未知','Year unknown'):'')} ${content(row.name||row.title||row.label||row.id||row._kind||'',row.id||'Record')}`.trim();
    svg.push(block(label,48,y+34,width-96,22,2));
    let columns;
    if(view==='overview'||view==='timeline') columns=[[ui('问题 / 任务','Question / task'),content(row.task)||content(row.definition)||ui('未记录','Not recorded')],[ui('方法','Method'),content(row.method)||ui('未记录','Not recorded')],[ui('证据 / 评价','Evidence / evaluation'),content(row.evaluation)||content(row.datasets)||row.summary||ui('未记录','Not recorded')]];
    else if(view==='scholars') columns=[[ui('身份 / 单位','Identity / organization'),`${row.identity_status||ui('待核','Needs review')} · ${content(row.organization)||content(row.institution)||ui('任职未知','Affiliation unknown')} (${row.organization_as_of||ui('适用日期待核','Applicable date unverified')})`],[ui('贡献','Contributions'),arr(row.contributions).filter(c=>!filters.task&&!filters.year||selectedIds.has(c.paper_id)).map(c=>`${c.year||'?'} ${content(c.summary||c.title||c.paper_id,c.paper_id||'Contribution')}`).join(' · ')||ui('未记录','Not recorded')],[ui('研究兴趣 / 影响','Research interests / impact'),content(row.research_interests)||content(row.impact)||ui('未记录','Not recorded')]];
    else if(view==='research-lines') columns=[[ui('研究重点','Research focus'),content(row.focus)||content(row.question)||content(row.summary)||content(row.definition)||ui('未记录','Not recorded')],[ui('时间 / 地点','Time / place'),`${content(row.time)||ui('时间未知','Time unknown')} · ${content(row.place)||content(row.organization)||ui('地点未知','Place unknown')}`],[ui('数据 / 关联作品','Data / linked papers'),content(row.datasets)||arr(row.paper_ids).map(id=>content(doc.papers.find(p=>p.id===id)?.title||id,id)).join(' · ')||ui('未记录','Not recorded')]];
    else columns=[[ui('定义 / 问题','Definition / question'),content(row.definition)||content(row.focus)||content(row.question)||content(row.summary)||content(row.text)||ui('未记录','Not recorded')],[ui('区别 / 方法','Distinction / method'),content(row.distinguishes_from)||content(row.distinction)||content(row.difference)||content(row.method)||content(row.description)||content(row.contrast)||ui('未记录','Not recorded')],[ui('关联作品 / 边界','Linked papers / scope'),arr(row.paper_ids).map(id=>content(doc.papers.find(p=>p.id===id)?.title||id,id)).join(' · ')||content(row.scope)||ui('未记录','Not recorded')]];
    columns.forEach(([heading,body],j)=>{ const x=48+j*(col+24); svg.push(block(heading,x,y+101,col,17,1,'#176d68'),block(body,x,y+130,col,18,4)); });
    svg.push(block(`${ui('证据标记','Evidence status')}: ${[row.inference?ui('AI 推断','AI inference'):'',content(row.review_status),content(row.confidence||row.evidence_level||row.status)||ui('待核 / 未标记','Needs review / unmarked')].filter(Boolean).join(' / ')} · ${content(row.evidence_scope)||ui('不推断全文已读','No full-text review implied')} · ${ui('来源','Sources')} ${arr(row.source_ids).map(id=>`${id} (${doc.sources.find(s=>s.id===id)?.accessed_at||ui('核验日期未知','Verification date unknown')})`).join(', ')||ui('未记录','Not recorded')}`,48,y+247,width-96,15,1));
  });
  if(!page.length)svg.push(block(ui('当前筛选没有可展示记录；缺失不等于研究不存在。','No records match these filters; absence does not mean the research does not exist.'),48,370,width-96,24,2));
  svg.push(block(`${ui('数据保存','Data saved')}: ${record.updated_at||ui('未知','Unknown')} · ${ui('作品日期与来源核验日期不等于当前任职或兴趣。','Publication and verification dates do not establish current affiliations or interests.')}`,48,height-54,width-96,16,1),block(ui('长字段省略以 … 标记；完整来源与原记录保存在同名私有 JSON。','Truncated fields use …; complete sources and original records remain in the private JSON sidecar.'),48,height-25,width-96,16,1),'</g></svg>');
  return {svg:svg.join(''),height,settings,total:rows.length,count:page.length,has_more:offset+page.length<rows.length,source_ids:[...refIds].sort(),records:page,sources:doc.sources.filter(s=>refIds.has(s.id)),translation:locale.report(),warnings:[locale.warning()].filter(Boolean)};
}
export function createFieldRadarExporter({ library, radar, getAnalysis } = {}) {
  if(typeof library!=='string'||!library.trim()||!radar?.get)throw fail('Exporter requires a configured library and topic store');
  const root=resolve(library), folder=join(root,'.paper-library','field-radar-exports');
  async function directory(){const rootInfo=await lstat(root);if(!rootInfo.isDirectory()||rootInfo.isSymbolicLink())throw fail('Unsafe library directory');const canonical=await realpath(root);for(const p of [join(root,'.paper-library'),folder]){await mkdir(p,{mode:0o700}).catch(e=>{if(e.code!=='EEXIST')throw e;});const s=await lstat(p);if(!s.isDirectory()||s.isSymbolicLink()||!(await realpath(p)).startsWith(canonical+'/'))throw fail('Unsafe export directory');}return folder;}
  async function readFileSafe(path){const f=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);try{const s=await f.stat();if(!s.isFile()||s.nlink!==1||s.size>MAX)throw fail('Unsafe or oversized export');return await f.readFile();}finally{await f.close();}}
  async function writeOnce(path,bytes){if(bytes.length>MAX)throw fail('Export exceeds 10 MiB',413);try{const old=await readFileSafe(path);if(!old.equals(bytes))throw fail('Immutable export conflict');return;}catch(e){if(e.code!=='ENOENT')throw e;}const tmp=join(folder,`.${randomUUID()}.tmp`);let f;try{f=await open(tmp,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);await f.writeFile(bytes);await f.sync();await f.close();f=null;await directory();try { await link(tmp,path); } catch(e) { if(e.code!=='EEXIST')throw e; const existing=await readFileSafe(path); if(!existing.equals(bytes))throw fail('Immutable export conflict'); }}finally{await f?.close();await unlink(tmp).catch(e=>{if(e.code!=='ENOENT')throw e;});}}
  let busy=false;
  async function render(input){if(busy)throw fail('An export is already rendering',429);busy=true;try{options(input);const record=await radar.get(input.id), result=renderFieldRadarSVG(record,input);await directory();const {settings,height,total,count,has_more,source_ids}=result;let bytes=Buffer.from(result.svg);if(settings.format==='png'){const {default:sharp}=await import('sharp');bytes=await sharp(bytes,{limitInputPixels:2400*6000}).png().toBuffer();}const id=hash(Buffer.concat([bytes,Buffer.from(JSON.stringify({revision:record.revision,settings,records:result.records,sources:result.sources,...(result.analytics?{analytics:result.analytics}:{})}))]));const path=join(folder,`${id}.${settings.format}`),metaPath=join(folder,`${id}.${settings.format}.json`);let generated_at=new Date().toISOString();try{generated_at=JSON.parse((await readFileSafe(metaPath)).toString()).receipt.generated_at;}catch(e){if(e.code!=='ENOENT')throw e;}const receipt={id,topic_id:record.document.topic.id,view:settings.view,format:settings.format,width:settings.width,height,total,offset:settings.offset,count,has_more,topic_revision:record.revision,data_updated_at:record.updated_at,generated_at,source_ids,path,language:settings.language,...(result.translation?{translation:result.translation}:{}),warnings:result.warnings||[],...(result.coverage?{coverage:result.coverage,warnings:result.warnings,available:result.available,group_by:settings.group_by,frequency_by:settings.frequency_by}:{})};const metadata=Buffer.from(JSON.stringify({receipt,export_settings:settings,filters:settings.filters,records:result.records,sources:result.sources,...(result.analytics?{analytics:result.analytics}:{})},null,2));await writeOnce(path,bytes);await writeOnce(metaPath,metadata);return receipt;}finally{busy=false;}}
  async function get(id,format){if(!/^[a-f0-9]{64}$/.test(id)||!['png','svg','html','tsv','csv','markdown'].includes(format))throw fail('Invalid export identifier');await directory();const bytes=await readFileSafe(join(folder,`${id}.${format}`)),metadata=JSON.parse((await readFileSafe(join(folder,`${id}.${format}.json`))).toString());if(hash(Buffer.concat([bytes,Buffer.from(JSON.stringify({revision:metadata.receipt.topic_revision,...(metadata.export_settings?{settings:metadata.export_settings}:{}),records:metadata.records,sources:metadata.sources,...(metadata.analytics?{analytics:metadata.analytics}:{})}))]))!==id)throw fail('Export integrity check failed',500);return {bytes,receipt:metadata.receipt,mime:({png:'image/png',svg:'image/svg+xml',html:'text/html; charset=utf-8',tsv:'text/tab-separated-values; charset=utf-8',csv:'text/csv; charset=utf-8',markdown:'text/markdown; charset=utf-8'})[format]};}
  async function tableRecord(input) {
    const record=await radar.get(input.id);
    if(!record.document)throw fail('Research topic not found',404);
    if(input.expected_revision!==undefined&&input.expected_revision!==record.revision)throw fail('研究主题已变化，请刷新后再整理。',409);
    if(input.analysis_request_id!==undefined){
      if(typeof input.analysis_request_id!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$/.test(input.analysis_request_id)||!getAnalysis)throw fail('Saved analysis is unavailable');
      const analysis=await getAnalysis({action:'field_radar_analysis_get',id:input.id,request_id:input.analysis_request_id});
      if(analysis.status!=='complete'||analysis.topic_id!==input.id||analysis.topic_revision!==record.revision)throw fail('AI 表格草稿尚未完成或基于旧主题版本；请核对后选择。',409);
      if(!analysis.draft?.paper_comparisons?.length)throw fail('此分析尚无结构化文献表草稿；原结果保留，可明确重新分析。',409);
      const comparisons=new Map(analysis.draft.paper_comparisons.map(row=>[row.paper_id,validatePaperComparison(row.comparison,record.document,{forceReview:true})]));
      return {...record,document:{...record.document,papers:record.document.papers.map(p=>comparisons.has(p.id)?{...p,comparison:comparisons.get(p.id)}:p)}};
    }
    return record;
  }
  async function tablePreview(input) {
    const record=await tableRecord(input), result=renderFieldRadarTable(record,{...input,format:'html'});
    const plain=renderFieldRadarTable(record,{...input,format:'tsv'});
    return {...result,topic_id:record.document.topic.id,topic_revision:record.revision,analysis_request_id:input.analysis_request_id??null,html:result.content,tsv:plain.content};
  }
  async function tableExport(input) {
    if(busy)throw fail('An export is already rendering',429);busy=true;
    try {
      const record=await tableRecord(input),result=renderFieldRadarTable(record,input),settings={...result.settings,view:'literature-table',...(input.analysis_request_id?{analysis_request_id:input.analysis_request_id}:{})};
      await directory();
      const bytes=Buffer.from(result.content),id=hash(Buffer.concat([bytes,Buffer.from(JSON.stringify({revision:record.revision,settings,records:result.records,sources:result.sources}))]));
      const path=join(folder,`${id}.${settings.format}`),metaPath=`${path}.json`;
      let generated_at=new Date().toISOString();try{generated_at=JSON.parse((await readFileSafe(metaPath)).toString()).receipt.generated_at;}catch(e){if(e.code!=='ENOENT')throw e;}
      const receipt={id,topic_id:record.document.topic.id,view:settings.view,format:settings.format,total:result.total,offset:settings.offset,count:result.count,has_more:result.has_more,topic_revision:record.revision,data_updated_at:record.updated_at,generated_at,source_ids:result.source_ids,path,warnings:result.warnings,coverage:result.coverage,analysis_request_id:input.analysis_request_id??null,...(settings.paper_ids!==undefined?{paper_ids:settings.paper_ids}:{})};
      const metadata=Buffer.from(JSON.stringify({receipt,export_settings:settings,filters:settings.filters,records:result.records,sources:result.sources,columns:result.columns,rows:result.rows},null,2));
      await writeOnce(path,bytes);await writeOnce(metaPath,metadata);return receipt;
    }finally{busy=false;}
  }
  return {render,get,tablePreview,tableExport,handle(input){if(input.action==='field_radar_render')return render(input);if(input.action==='field_radar_table')return tablePreview(input);if(input.action==='field_radar_table_export')return tableExport(input);throw fail('Unsupported export action');}};
}
