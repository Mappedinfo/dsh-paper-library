/** Deterministic, evidence-preserving corpus statistics. No remote lookups or inferred geocoding. */
import '../../web/field-radar-data.js';
const list = v => Array.isArray(v) ? v : v == null || v === '' ? [] : [v];
const unique = v => [...new Set(v)];
const label = v => typeof v === 'string' ? v.trim() : v && typeof v === 'object' ? String(v.name || v.title || v.label || '').trim() : '';
const sourceIds = (v, known) => unique(list(v).filter(x => known.has(x)));
export const ANALYTIC_VIEWS = ['frequency','publications','citations','geography'];
export function validateRadarGeography(doc) {
  let positions = 0;
  const visit = (coords, depth) => {
    if (!Array.isArray(coords) || !coords.length) throw Error('Geographic coordinates must be nonempty arrays');
    if (!depth) { if (coords.length !== 2 || !coords.every(Number.isFinite) || Math.abs(coords[0]) > 180 || Math.abs(coords[1]) > 90) throw Error('Geography requires finite WGS84 longitude/latitude'); if (++positions > 12000) throw Error('Geography exceeds 12000 positions'); return; }
    for (const c of coords) visit(c, depth - 1);
  };
  for (const key of ['study_areas','geo_observations','map_context']) {
    if (doc[key] == null) continue;
    if (!Array.isArray(doc[key]) || doc[key].length > 500) throw Error(`${key} must contain at most 500 records`);
    const ids = new Set();
    for (const row of doc[key]) {
      if (!row || typeof row.id !== 'string' || ids.has(row.id) || !row.id || !label(row)) throw Error('Geography requires unique IDs and names'); ids.add(row.id);
      if (!Array.isArray(row.source_ids) || !row.source_ids.length) throw Error('Geography requires source_ids');
      if (key !== 'map_context' && (!Array.isArray(row.paper_ids) || !row.paper_ids.length)) throw Error('Study geography requires paper_ids');
      if (typeof row.precision !== 'string' || !row.precision.trim()) throw Error('Geography requires explicit spatial precision');
      const g = row.geometry, depth = {Point:0,LineString:1,Polygon:2,MultiPolygon:3}[g?.type];
      if (depth === undefined) throw Error('Unsupported geographic geometry');
      visit(g.coordinates, depth);
      if (g.type === 'LineString' && g.coordinates.length < 2) throw Error('LineString requires two positions');
      const polygons = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
      for (const polygon of polygons) for (const ring of polygon) {
        if (ring.length < 4 || JSON.stringify(ring[0]) !== JSON.stringify(ring.at(-1))) throw Error('Polygon rings must be closed');
        if (ring.some((p,i)=>i&&Math.abs(p[0]-ring[i-1][0])>180)) throw Error('Split antimeridian polygons before import');
      }
      if(g.type==='LineString'&&g.coordinates.some((p,i)=>i&&Math.abs(p[0]-g.coordinates[i-1][0])>180))throw Error('Split antimeridian lines before import');
      if (row.value != null && (!Number.isFinite(row.value) || typeof row.metric !== 'string' || !row.metric.trim() || typeof row.unit !== 'string' || !row.unit.trim())) throw Error('Map values require finite numbers, metric and unit');
      if (key === 'geo_observations' && row.value == null) throw Error('Observations require measured values');
    }
  }
}
export function projectFieldRadarAnalytics(doc, { filters = {}, group_by = 'subtopic', frequency_by = 'task',view } = {}) {
  const papers = globalThis.PaperFieldRadarData.filteredPapers(doc, filters), paperIds = new Set(papers.map(p => p.id)), knownSources = new Set((doc.sources || []).map(s => s.id));
  const warnings = ['统计范围仅为当前主题与筛选，不代表完整领域；未知值不当作零。'];
  const warn=(scope,message)=>{if(!view||view===scope)warnings.push(message);};
  const grouped = new Map(), frequencyMissing = [];
  for (const p of papers) {
    const raw = frequency_by === 'dataset' ? p.datasets ?? p.dataset : frequency_by === 'method' ? p.method_tags ?? p.method : p.task;
    const labels = unique(list(raw).map(label).filter(Boolean));
    if (!labels.length) frequencyMissing.push(p.id);
    for (const name of labels) { if (!grouped.has(name)) grouped.set(name, { name, paper_ids:[], source_ids:[] }); const row = grouped.get(name); row.paper_ids.push(p.id); row.source_ids.push(...sourceIds(p.source_ids,knownSources)); }
  }
  const frequency = [...grouped.values()].map(r => ({...r,count:r.paper_ids.length,source_ids:unique(r.source_ids)})).sort((a,b)=>b.count-a.count||a.name.localeCompare(b.name));
  const groups = group_by === 'task' ? [] : group_by === 'research_group' ? list(doc.research_groups).filter(g=>g.status==='verified' && sourceIds(g.source_ids,knownSources).length) : list(doc.groups).length ? doc.groups : list(doc.research_lines);
  const years = new Map(), groupSources = new Set(), missingGroupIds = [], memberships = [];
  for (const p of papers) {
    let names = group_by === 'task' ? unique(list(p.task).map(label).filter(Boolean)) : unique(groups.filter(g=>list(g.paper_ids).includes(p.id)).map(g=>{sourceIds(g.source_ids,knownSources).forEach(x=>groupSources.add(x));return label(g);}).filter(Boolean));
    if (!names.length) { names = ['未分类 / 未核验']; missingGroupIds.push(p.id); }
    const year = p.year ?? '未知年份'; if (!years.has(year)) years.set(year,{year,paper_ids:[],segments:{},memberships:[]}); const row=years.get(year); row.paper_ids.push(p.id);
    for (const name of names) { row.segments[name]=(row.segments[name]||0)+1/names.length; row.memberships.push({paper_id:p.id,category:name,weight:1/names.length}); memberships.push({paper_id:p.id,year,category:name,weight:1/names.length}); }
  }
  const publications = [...years.values()].sort((a,b)=>a.year==='未知年份'?1:b.year==='未知年份'?-1:a.year-b.year).map(r=>({...r,count:r.paper_ids.length}));
  const candidates = [...list(doc.citations), ...list(doc.relationships).filter(r=>r.relation==='explicitly_cites_as_background'&&(r.status==='verified'||r.confidence==='high')).map(r=>({...r,status:'verified',evidence_kind:'explicit_saved_citation'}))];
  const edges = [], seen = new Set(); let excludedCitations=0;
  for (const e of candidates) {
    if (!paperIds.has(e.source_paper_id) || !paperIds.has(e.target_paper_id)) continue;
    if (e.status!=='verified' || !sourceIds(e.source_ids,knownSources).length || e.source_paper_id===e.target_paper_id) { excludedCitations++;continue; }
    const key=e.source_paper_id+'\0'+e.target_paper_id; if(seen.has(key))continue;seen.add(key); edges.push({...e,source_ids:sourceIds(e.source_ids,knownSources)});
  }
  const citationCounts = papers.flatMap(p => list(p.citation_metrics).filter(m=>Number.isSafeInteger(m.count)&&m.count>=0&&typeof m.provider==='string'&&m.provider&&sourceIds(m.source_ids,knownSources).length&&typeof m.as_of==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(m.as_of)&&Number.isFinite(Date.parse(m.as_of))&&new Date(m.as_of).toISOString().slice(0,10)===m.as_of).map(m=>({...m,paper_id:p.id,title:p.title})));
  const linked = row => list(row.paper_ids).some(id=>paperIds.has(id));
  const areas=list(doc.study_areas).filter(linked), observations=list(doc.geo_observations).filter(linked), context=list(doc.map_context);
  const mappedIds=new Set([...areas,...observations].flatMap(r=>list(r.paper_ids)).filter(id=>paperIds.has(id)));
  const placeMentions=papers.flatMap(p=>list(p.datasets).filter(d=>d&&typeof d==='object'&&d.place).map(d=>({paper_id:p.id,dataset:d.name||'',place:d.place,source_ids:sourceIds(d.source_ids||p.source_ids,knownSources)})));
  if (!edges.length) warn('citations','没有已核验的有向引用边；共著、任务相似、方法对照不代替引用。');
  if (!citationCounts.length) warn('citations','未收录带提供方与日期的引用量，不绘制虚构排名。');
  if (!areas.length && !observations.length) warn('geography','没有已核验的坐标或边界；地名文字不足以绘图，需补充有来源的空间资料。');
  else if (!observations.length) warn('geography','仅显示有来源的研究区域或代表点；未取得原始移动数据，不代表轨迹、流量或精确采样边界。');
  if (group_by==='research_group' && missingGroupIds.length) warn('publications','研究组只使用明确核验的成员/作品归属；主题分组与共同作者不自动当作研究组。');
  return { papers, source_ids:unique([...papers.flatMap(p=>sourceIds(p.source_ids,knownSources)),...groupSources]), frequency, publications, citations:{nodes:papers,edges,counts:citationCounts}, geography:{areas,observations,context,place_mentions:placeMentions}, coverage:{papers:papers.length,corpus_papers:doc.papers.length,frequency_missing:frequencyMissing.length,unknown_year:papers.filter(p=>p.year==null).length,unclassified:missingGroupIds.length,citation_edges:edges.length,citation_counts_known:unique(citationCounts.map(c=>c.paper_id)).length,citation_candidates_excluded:excludedCitations,mapped_papers:mappedIds.size,study_areas:areas.length,observations:observations.length,place_mentions:placeMentions.length}, warnings, memberships };
}
