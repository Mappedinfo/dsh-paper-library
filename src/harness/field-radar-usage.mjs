/** Explicit usage coding, never inferred from titles, POI presence or geographic covariates. */
export const USAGE_TAGS=Object.freeze({spatial_aggregation:'区域／街区汇总',mean_aggregation:'明确取均值',building_binding:'绑定具体建筑',generation_condition:'生成条件',prediction_input:'预测输入',learned_representation:'学习表征',other:'其他用途'});
export const USAGE_STATES=Object.freeze({used:'使用',not_used:'明确未使用',not_found:'已查范围未发现',unknown:'未知'});
export const usageDraft=v=>v?.inference===true||['needs_review','inference','ai','draft'].includes(v?.status)||['needs_review','inference','draft'].includes(v?.review_status);
export function usageCell(raw={},parentDraft=false,parentConflict=false){
 const sourced=raw.source_ids?.length&&raw.evidence?.trim();
 const status=parentConflict||raw.status==='conflicting'?'conflicting':parentDraft||usageDraft(raw)?'needs_review':raw.status==='verified'&&sourced?'verified':raw.use_status==='unknown'||!raw.use_status?'unknown':'unverified';
 const use_status=raw.use_status??'unknown',tags=raw.handling_tags??[];
 const details=[['变量',raw.variables],['空间汇总',raw.spatial_aggregation],['建筑绑定',raw.building_binding],['条件／预测用途',raw.condition_role],['表征',raw.representation],['依据',raw.evidence],['PDF 页',raw.pages?.join(', ')]];
 return {text:[USAGE_STATES[use_status],...tags.map(t=>USAGE_TAGS[t]),...details.filter(([,v])=>v).map(([k,v])=>k+'：'+v)].join('；'),status,use_status,handling_tags:tags,source_ids:raw.source_ids??[],evidence:raw.evidence??'',pages:raw.pages??[]};
}
export function addUsageDimensions(relations,topic,linkage){
 if(!relations)return relations;
 const result=structuredClone(relations),matches=new Map(linkage.matches.filter(m=>m.status==='matched').map(m=>[m.record_id,m.paper_id])),papers=new Map(topic.document.papers.map(p=>[p.id,p]));
 const sourceMap=new Map(topic.document.sources.map((s,i)=>[s.id,'usage-source-'+i]));
 // Namespaced derived sources do not overwrite original relation provenance.
 const reserved=new Set(result.sources.map(s=>s.id));for(const [id,value] of sourceMap){let key=value;while(reserved.has(key))key+='x';reserved.add(key);sourceMap.set(id,key);}
 const usedSources=new Set(),dimension_ids={};
 for(const [key,label,code] of [['poi_usage','POI 使用／处理','POI'],['building_usage','建筑信息使用／处理','BLD']]){
  let dimensionId=key;while(result.dimensions.some(d=>d.id===dimensionId))dimensionId='derived_'+dimensionId;dimension_ids[key]=dimensionId;
  const categories=new Map();
  for(const r of result.records){const p=papers.get(matches.get(r.id)),c=p?.comparison??{},u=usageCell(c[key],usageDraft(p)||usageDraft(c),p?.status==='conflicting'||c.status==='conflicting');
   const base=u.use_status==='used'&&u.handling_tags.length?u.handling_tags:[u.use_status];
   const ids=base.map(tag=>{const id=tag+'-'+u.status;categories.set(id,{id,label:(USAGE_TAGS[tag]??USAGE_STATES[tag])+(u.status==='verified'?'':'〔'+({needs_review:'待核',conflicting:'冲突',unknown:'未知',unverified:'未核验'}[u.status])+'〕')});return id;});
   r.values[dimensionId]=ids;const source_ids=u.source_ids.map(s=>sourceMap.get(s)).filter(Boolean);source_ids.forEach(s=>usedSources.add(s));r.evidence??={};r.evidence[dimensionId]={note:u.text,locator:u.pages.length?'PDF pp. '+u.pages.join(', '):'已保存来源范围',source_ids,review_status:u.status,topic_paper_id:p?.id??null};
  }
  result.dimensions.push({id:dimensionId,label:dimensionId===key?label:label+'（主题分析）',code,categories:[...categories.values()],derived_from:'topic.comparison.'+key});
 }
 result.sources.push(...topic.document.sources.filter(s=>usedSources.has(sourceMap.get(s.id))).map(s=>({...s,id:sourceMap.get(s.id)})));
 result.usage_provenance={dimension_ids,topic_id:topic.document.topic.id,topic_revision:topic.revision,meaning:'Derived usage coding; original relation snapshot is unchanged. Unmatched topic papers remain in the table.'};
 return result;
}
