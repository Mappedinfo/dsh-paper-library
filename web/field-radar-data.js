/* Shared deterministic selection for UI, backend rendering and export. No DOM, I/O or model calls. */
(() => {
'use strict';
  const list = value => Array.isArray(value) ? value : value == null || value === '' ? [] : [value];
  const text = value => typeof value === 'string' || typeof value === 'number' ? String(value) : Array.isArray(value) ? value.map(text).filter(Boolean).join(' · ') : value && typeof value === 'object' ? value.name || value.label || value.summary || '' : '';
  function filteredPapers(document, { query = '', task = '', year = '' } = {}) {
    const q = query.trim().toLocaleLowerCase();
    return (document?.papers || []).filter(p => (!task || list(p.task).includes(task)) && (!year || String(p.year) === String(year)) && (!q || [p.title, text(p.authors), text(p.method), text(p.task), p.summary].join(' ').toLocaleLowerCase().includes(q)));
  }
  function filterResearchRecords(document,rows,filters={}){
    const papers=filteredPapers(document,{task:filters.task,year:filters.year}),searched=filteredPapers(document,filters),ids=new Set(papers.map(p=>p.id)),sources=new Set(papers.flatMap(p=>list(p.source_ids))),queryIds=new Set(searched.map(p=>p.id)),querySources=new Set(searched.flatMap(p=>list(p.source_ids))),q=(filters.query||'').trim().toLocaleLowerCase();
    const linked=(row,ids,sources)=>[...list(row.paper_ids),...list(row.source_paper_id),...list(row.target_paper_id),...list(row.contributions).map(c=>c.paper_id)].some(id=>ids.has(id))||list(row.source_ids).some(id=>sources.has(id));
    return list(rows).filter(row=>{const own=[row.name,row.title,row.label,row.definition,row.distinguishes_from,row.text,row.focus,row.question,row.institution,row.organization,row.place,row.time,text(row.aliases),text(row.research_interests)].filter(Boolean).join(' ').toLocaleLowerCase();return (!q||own.includes(q)||linked(row,queryIds,querySources))&&(!filters.task&&!filters.year||linked(row,ids,sources));});
  }
  function selectViewRows(document,view,filters={}){
    const papers=filteredPapers(document,filters);
    if(view==='overview')return papers;
    if(view==='timeline')return [...papers].sort((a,b)=>(b.year||0)-(a.year||0));
    if(view==='concepts')return filterResearchRecords(document,document.concepts,filters);
    if(view==='research-lines')return filterResearchRecords(document,document.research_lines||document.groups,filters);
    if(view==='scholars')return filterResearchRecords(document,document.scholars,filters);
    throw Error('Unsupported Field Radar view');
  }
  globalThis.PaperFieldRadarData=Object.freeze({list,text,filteredPapers,filterResearchRecords,selectViewRows});
})();
