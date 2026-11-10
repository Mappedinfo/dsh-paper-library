/** Read-only identity bridge. Independent snapshots retain their original facts and evidence. */
const normalizeTitle = value => String(value || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const normalizeDOI = value => String(value || '').trim().replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '').replace(/^doi:\s*/i, '').toLowerCase();
function paperDOI(p) {
  const value=p.doi??p.DOI;
  if(value)return normalizeDOI(value);
  return /^https?:\/\/(?:dx\.)?doi\.org\//i.test(p.url||'')?normalizeDOI(p.url):'';
}
export function linkRadarRelations(relations, topicRecord) {
  const doc=topicRecord.document, papers=doc.papers;
  const matches=(relations?.records||[]).map(record=>{
    const rd=paperDOI(record),rt=normalizeTitle(record.title);
    // IDs from separate imports are not a shared namespace. An equal ID alone never joins.
    const doiCandidates=rd?papers.filter(p=>paperDOI(p)===rd):[];
    const titleCandidates=rt?papers.filter(p=>normalizeTitle(p.title)===rt):[];
    const candidates=doiCandidates.length?doiCandidates:titleCandidates;
    const compatible=candidates.filter(p=>!rd||!paperDOI(p)||paperDOI(p)===rd);
    const base={record_id:record.id,candidate_paper_ids:candidates.map(p=>p.id)};
    if(compatible.length===1&&candidates.length===1)return {...base,status:'matched',paper_id:compatible[0].id,match_basis:doiCandidates.length?'doi':'unique-title'};
    return {...base,status:candidates.length>1?'ambiguous':candidates.length?'conflicting':'unmatched'};
  });
  return {topic_id:doc.topic.id,topic_revision:topicRecord.revision,matches,coverage:{relation_records:matches.length,topic_papers:papers.length,matched_records:matches.filter(m=>m.status==='matched').length,matched_papers:new Set(matches.filter(m=>m.status==='matched').map(m=>m.paper_id)).size,ambiguous_records:matches.filter(m=>m.status==='ambiguous').length,unmatched_records:matches.filter(m=>m.status==='unmatched').length,conflicting_records:matches.filter(m=>m.status==='conflicting').length}};
}
