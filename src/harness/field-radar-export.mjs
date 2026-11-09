/** Headless, source-backed diagrams. No browser, network, model or PDF work. */
import '../../web/field-radar-data.js';
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
  const lines = []; let line = '', used = 0; const chars = [...words(value).slice(0, 16000)];
  for (let i = 0; i < chars.length; i++) { const c = chars[i], amount = /[\u0000-\u007f]/.test(c) ? size * .61 : size;
    if (c === '\n' || used + amount > width) { lines.push(line); line = ''; used = 0; if (lines.length === maximum) { lines[maximum - 1] = lines[maximum - 1].slice(0, -1) + '…'; return lines; } if (c === '\n') continue; }
    line += c; used += amount;
  } if (line || !lines.length) lines.push(line); return lines;
}
function textBlock(value, x, y, width, size = 20, max = 5, color = '#253e4a') { return `<text fill="${color}" font-size="${size}">${wrapRadarText(value,width,size,max).map((s,i)=>`<tspan x="${x}" y="${y+i*size*1.4}">${esc(s)}</tspan>`).join('')}</text>`; }
function options(input) {
  const view = input.view ?? 'overview', format = input.format ?? 'png', width = input.width ?? 1600, offset = input.offset ?? 0, limit = input.limit ?? 6, filters = input.filters ?? {};
  if (!['overview','timeline','concepts','research-lines','scholars'].includes(view) || !['png','svg'].includes(format)) throw fail('Unsupported export view or format');
  if (!Number.isInteger(width) || width < 1200 || width > 2400 || !Number.isInteger(offset) || offset < 0 || offset > 10000 || !Number.isInteger(limit) || limit < 1 || limit > 12) throw fail('Export dimensions or pagination out of bounds');
  if (!filters || typeof filters !== 'object' || Array.isArray(filters) || Object.keys(filters).some(k => !['query','task','year'].includes(k)) || Object.values(filters).some(v => typeof v !== 'string' || v.length > 500)) throw fail('Invalid export filters');
  return { view, format, width, offset, limit, filters };
}
export function renderFieldRadarSVG(record, input = {}) {
  const settings = options(input), { view,width,offset,limit,filters } = settings, doc = record.document;
  if (!doc) throw fail('Research topic not found',404);
  if (input.expected_revision !== undefined && (typeof input.expected_revision !== 'string' || input.expected_revision !== record.revision)) throw fail('研究主题已变化，请刷新后再导出。',409);
  const papers = globalThis.PaperFieldRadarData.filteredPapers(doc,filters), selectedIds = new Set(papers.map(p=>p.id));
  const rows = globalThis.PaperFieldRadarData.selectViewRows(doc,view,filters);
  const page = rows.slice(offset,offset+limit), rowHeight = 290, height = 410 + Math.max(1,page.length)*rowHeight;
  const title = {overview:'问题 → 方法 → 证据',timeline:'收录作品时间线',concepts:'概念与区别', 'research-lines':'研究脉络',scholars:'学者与贡献'}[view];
  const svg = [`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="#f4f7f6"/><g font-family="PingFang SC,Noto Sans CJK SC,Microsoft YaHei,sans-serif">`,textBlock(doc.topic.title,48,58,width-96,32,2),textBlock(title,48,150,width-96,24,1,'#176d68'),textBlock(doc.topic.question,48,192,width-96,20,2),textBlock(`仅展示已收录证据，不代表完整领域。筛选 ${JSON.stringify(filters)} · ${page.length?offset+1:0}–${offset+page.length} / ${rows.length}`,48,264,width-96,17,2)];
  const refIds = new Set();
  function collect(v){if(!v||typeof v!=='object')return;for(const [k,c]of Object.entries(v)){if(k==='source_ids')arr(c).forEach(id=>refIds.add(id));else collect(c);}}
  if(view==='timeline' && page.length) svg.push(`<line x1="16" y1="334" x2="16" y2="${334+(page.length-1)*rowHeight}" stroke="#176d68" stroke-width="3"/>`);
  const col = (width-144)/3;
  page.forEach((row,i)=>{ collect(row); const y=310+i*rowHeight; if(view==='timeline')svg.push(`<circle cx="16" cy="${y+24}" r="7" fill="#b27b32"/>`); svg.push(`<rect x="32" y="${y}" width="${width-64}" height="270" rx="14" fill="white" stroke="#d8e3df"/>`);
    const label = `${row.year??(view==='timeline'?'年份未知':'')} ${row.name||row.title||row.label||row.id||row._kind||''}`.trim();
    svg.push(textBlock(label,48,y+34,width-96,22,2));
    let columns;
    if(view==='overview'||view==='timeline') columns=[['问题 / 任务',words(row.task)||words(row.definition)||'未记录'],['方法',words(row.method)||'未记录'],['证据 / 评价',words(row.evaluation)||words(row.datasets)||row.summary||'未记录']];
    else if(view==='scholars') columns=[['身份 / 单位',`${row.identity_status||'待核'} · ${words(row.organization)||words(row.institution)||'任职未知'} (${row.organization_as_of||'适用日期待核'})`],['贡献',arr(row.contributions).filter(c=>!filters.task&&!filters.year||selectedIds.has(c.paper_id)).map(c=>`${c.year||'?'} ${c.summary||c.title||c.paper_id}`).join(' · ')||'未记录'],['研究兴趣 / 影响',words(row.research_interests)||words(row.impact)||'未记录']];
    else if(view==='research-lines') columns=[['研究重点',words(row.focus)||words(row.question)||words(row.summary)||words(row.definition)||'未记录'],['时间 / 地点',`${words(row.time)||'时间未知'} · ${words(row.place)||words(row.organization)||'地点未知'}`],['数据 / 关联作品',words(row.datasets)||arr(row.paper_ids).map(id=>doc.papers.find(p=>p.id===id)?.title||id).join(' · ')||'未记录']];
    else columns=[['定义 / 问题',words(row.definition)||words(row.focus)||words(row.question)||words(row.summary)||words(row.text)||'未记录'],['区别 / 方法',words(row.distinguishes_from)||words(row.distinction)||words(row.difference)||words(row.method)||words(row.description)||words(row.contrast)||'未记录'],['关联作品 / 边界',arr(row.paper_ids).map(id=>doc.papers.find(p=>p.id===id)?.title||id).join(' · ')||words(row.scope)||'未记录']];
    columns.forEach(([heading,body],j)=>{ const x=48+j*(col+24); svg.push(textBlock(heading,x,y+101,col,17,1,'#176d68'),textBlock(body,x,y+130,col,18,4)); });
    svg.push(textBlock(`证据标记: ${[row.inference?'AI 推断':'',row.review_status,row.confidence||row.evidence_level||row.status||'待核 / 未标记'].filter(Boolean).join(' / ')} · ${row.evidence_scope||'不推断全文已读'} · 来源 ${arr(row.source_ids).map(id=>`${id} (${doc.sources.find(s=>s.id===id)?.accessed_at||'核验日期未知'})`).join(', ')||'未记录'}`,48,y+247,width-96,15,1));
  });
  if(!page.length)svg.push(textBlock('当前筛选没有可展示记录；缺失不等于研究不存在。',48,370,width-96,24,2));
  svg.push(textBlock(`数据保存: ${record.updated_at||'未知'} · 作品日期与来源核验日期不等于当前任职或兴趣。`,48,height-54,width-96,16,1),textBlock('长字段省略以 … 标记；完整来源与原记录保存在同名私有 JSON。',48,height-25,width-96,16,1),'</g></svg>');
  return {svg:svg.join(''),height,settings,total:rows.length,count:page.length,has_more:offset+page.length<rows.length,source_ids:[...refIds].sort(),records:page,sources:doc.sources.filter(s=>refIds.has(s.id))};
}
export function createFieldRadarExporter({ library, radar } = {}) {
  if(typeof library!=='string'||!library.trim()||!radar?.get)throw fail('Exporter requires a configured library and topic store');
  const root=resolve(library), folder=join(root,'.paper-library','field-radar-exports');
  async function directory(){const rootInfo=await lstat(root);if(!rootInfo.isDirectory()||rootInfo.isSymbolicLink())throw fail('Unsafe library directory');const canonical=await realpath(root);for(const p of [join(root,'.paper-library'),folder]){await mkdir(p,{mode:0o700}).catch(e=>{if(e.code!=='EEXIST')throw e;});const s=await lstat(p);if(!s.isDirectory()||s.isSymbolicLink()||!(await realpath(p)).startsWith(canonical+'/'))throw fail('Unsafe export directory');}return folder;}
  async function readFileSafe(path){const f=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);try{const s=await f.stat();if(!s.isFile()||s.nlink!==1||s.size>MAX)throw fail('Unsafe or oversized export');return await f.readFile();}finally{await f.close();}}
  async function writeOnce(path,bytes){if(bytes.length>MAX)throw fail('Export exceeds 10 MiB',413);try{const old=await readFileSafe(path);if(!old.equals(bytes))throw fail('Immutable export conflict');return;}catch(e){if(e.code!=='ENOENT')throw e;}const tmp=join(folder,`.${randomUUID()}.tmp`);let f;try{f=await open(tmp,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);await f.writeFile(bytes);await f.sync();await f.close();f=null;await directory();try { await link(tmp,path); } catch(e) { if(e.code!=='EEXIST')throw e; const existing=await readFileSafe(path); if(!existing.equals(bytes))throw fail('Immutable export conflict'); }}finally{await f?.close();await unlink(tmp).catch(e=>{if(e.code!=='ENOENT')throw e;});}}
  let busy=false;
  async function render(input){if(busy)throw fail('An export is already rendering',429);busy=true;try{options(input);const record=await radar.get(input.id), result=renderFieldRadarSVG(record,input);await directory();const {settings,height,total,count,has_more,source_ids}=result;let bytes=Buffer.from(result.svg);if(settings.format==='png'){const {default:sharp}=await import('sharp');bytes=await sharp(bytes,{limitInputPixels:2400*4000}).png().toBuffer();}const id=hash(Buffer.concat([bytes,Buffer.from(JSON.stringify({revision:record.revision,records:result.records,sources:result.sources}))]));const path=join(folder,`${id}.${settings.format}`),metaPath=join(folder,`${id}.${settings.format}.json`);let generated_at=new Date().toISOString();try{generated_at=JSON.parse((await readFileSafe(metaPath)).toString()).receipt.generated_at;}catch(e){if(e.code!=='ENOENT')throw e;}const receipt={id,topic_id:record.document.topic.id,view:settings.view,format:settings.format,width:settings.width,height,total,offset:settings.offset,count,has_more,topic_revision:record.revision,data_updated_at:record.updated_at,generated_at,source_ids,path};const metadata=Buffer.from(JSON.stringify({receipt,filters:settings.filters,records:result.records,sources:result.sources},null,2));await writeOnce(path,bytes);await writeOnce(metaPath,metadata);return receipt;}finally{busy=false;}}
  async function get(id,format){if(!/^[a-f0-9]{64}$/.test(id)||!['png','svg'].includes(format))throw fail('Invalid export identifier');await directory();const bytes=await readFileSafe(join(folder,`${id}.${format}`)),metadata=JSON.parse((await readFileSafe(join(folder,`${id}.${format}.json`))).toString());if(hash(Buffer.concat([bytes,Buffer.from(JSON.stringify({revision:metadata.receipt.topic_revision,records:metadata.records,sources:metadata.sources}))]))!==id)throw fail('Export integrity check failed',500);return {bytes,receipt:metadata.receipt,mime:format==='png'?'image/png':'image/svg+xml'};}
  return {render,get,handle(input){if(input.action==='field_radar_render')return render(input);throw fail('Unsupported export action');}};
}
