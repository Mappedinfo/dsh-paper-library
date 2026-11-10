'use strict';
// Shared paper identities link views; imported relation facts remain in their own snapshot.
window.PaperFieldRadarRelations={create({root,api,onOpenPaper,onSelection,onShowTable,context=null}){
 let data=null,linkage=null,lang='zh',kind='sankey',offset=0,alive=true,ticket=0,request=null,linked=true;
 let contextKey='',selectedRecords=null,visibleDimensions=null,currentDocument=null,svg='',selectionKey='',pendingPaper=null,snapshotRevision=null,snapshotDigest=null,loading=false;
 const choices=new Map(),el=(tag,text)=>{const n=document.createElement(tag);if(text!=null)n.textContent=text;return n;};
 const t=x=>typeof x==='string'?x:x?.[lang]??x?.en??x?.zh??'';
 const btn=(label,fn,id)=>{const b=el('button',label);b.type='button';b.className='button subtle';b.onclick=fn;if(id)b.id=id;return b;};
 const bar=el('div'),filters=el('div'),dimensions=el('fieldset'),status=el('p'),notice=el('p'),figure=el('div'),cards=el('div'),pages=el('div'),query=el('input'),language=el('select'),style=el('select'),scope=el('input'),spacing=el('select'),width=el('select');
 bar.className='radar-toolbar';filters.className='radar-filters';dimensions.className='radar-relations-dimensions';cards.className='radar-grid';figure.className='radar-relations-figure';figure.tabIndex=0;figure.setAttribute('aria-label','关系图，可横向滚动');status.setAttribute('role','status');query.type='search';query.placeholder='Paper ID / title';query.setAttribute('aria-label','Filter relations papers');
 for(const [v,label]of [['zh','中文 / Chinese'],['en','English']]){const o=el('option',label);o.value=v;language.append(o);}language.setAttribute('aria-label','Relations language');
 for(const [v,label]of [['sankey','Sankey / 桑基图'],['circular','Circular / 环形图']]){const o=el('option',label);o.value=v;style.append(o);}style.setAttribute('aria-label','Relations chart');
 scope.type='checkbox';scope.checked=true;scope.id='field-radar-relations-linked';const scopeLabel=el('label');scopeLabel.append(scope,document.createTextNode('联动当前主题与文献表'));
 for(const [v,label]of [['1','标准列距'],['1.4','宽列距'],['1.8','更宽列距']]){const o=el('option',label);o.value=v;spacing.append(o);}spacing.setAttribute('aria-label','桑基图列距');
 for(const [v,label]of [['fit','适应容器'],['1600','图宽 1600 px'],['2400','图宽 2400 px'],['3200','图宽 3200 px']]){const o=el('option',label);o.value=v;width.append(o);}width.setAttribute('aria-label','关系图显示宽度');width.value='1600';
 const clear=btn('Reset / 重置筛选',()=>{query.value='';choices.clear();selectedRecords=null;offset=0;controls();draw();},'field-radar-relations-clear');
 const exportSVG=btn('导出当前 SVG',()=>download(svg,'image/svg+xml','svg'),'field-radar-relations-svg');
 const exportJSON=btn('导出当前数据与依据',()=>download(JSON.stringify({document:currentDocument,relation_revision:snapshotRevision,relation_digest:snapshotDigest,linkage,selection:{topic_id:context?.id??null,topic_revision:context?.expected_revision??null,table_filters:context??null,linked,kind,language:lang,display_width:width.value,query:query.value,categories:Object.fromEntries(choices),selected_record_ids:selectedRecords,visible_dimensions:visibleDimensions,spacing:Number(spacing.value)},meaning:'Adjacent-dimension co-occurrence, not a unique end-to-end paper path.'},null,2),'application/json','json'),'field-radar-relations-json');
 bar.append(scopeLabel,language,style,query,spacing,width,clear,btn('Reload / 更新快照',()=>void load()),exportSVG,exportJSON);
 if(onShowTable)bar.append(btn('查看联动文献表',()=>onShowTable(),'field-radar-relations-table'));
 root.replaceChildren(bar,dimensions,filters,status,notice,figure,cards,pages);
 const safeURL=value=>{try{const u=new URL(value);return ['https:','http:'].includes(u.protocol)&&!u.username&&!u.password?u.href:null;}catch{return null;}};
 function link(value,label,parent){const href=safeURL(value);if(!href)return;const a=el('a',label);a.href=href;a.target='_blank';a.rel='noopener noreferrer';parent.append(a);}
 function download(value,type,extension){if(!value||!currentDocument)return;const url=URL.createObjectURL(new Blob([value],{type})),a=el('a');a.href=url;a.download='field-radar-relations.'+extension;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
 function emit(ids){const key=JSON.stringify(ids);if(key===selectionKey)return;selectionKey=key;onSelection?.(ids);}
 function mapping(){return new Map((linkage?.matches??[]).filter(m=>m.status==='matched').map(m=>[m.record_id,m.paper_id]));}
 function controls(){
  filters.replaceChildren();dimensions.replaceChildren(el('legend','展示维度列（至少两列，未勾选的列可恢复）'));
  for(const dim of data?.dimensions??[]){
   const label=el('label'),check=el('input');check.type='checkbox';check.checked=visibleDimensions.includes(dim.id);check.disabled=check.checked&&visibleDimensions.length<=2;check.dataset.dimension=dim.id;check.setAttribute('aria-label','显示维度 '+t(dim.label));check.onchange=()=>{visibleDimensions=data.dimensions.filter(d=>d.id===dim.id?check.checked:visibleDimensions.includes(d.id)).map(d=>d.id);controls();draw();};label.append(check,document.createTextNode(t(dim.label)));dimensions.append(label);
   const select=el('select'),all=el('option',t(dim.label)+(check.checked?'':'（隐藏列）'));all.value='';select.append(all);select.setAttribute('aria-label',t(dim.label));for(const c of dim.categories){const o=el('option',t(c.label));o.value=c.id;select.append(o);}select.value=choices.get(dim.id)||'';select.onchange=()=>{choices.set(dim.id,select.value);selectedRecords=null;offset=0;draw();};filters.append(select);
  }
 }
 let allowedPaperIds=null,tableCount=0;
 function matchedRows(){const q=query.value.toLocaleLowerCase(),map=mapping();return data.records.filter(r=>(!linked||!context?.id||map.has(r.id)&&allowedPaperIds?.has(map.get(r.id)))&&(r.id+' '+r.title+' '+(r.label??'')).toLocaleLowerCase().includes(q)&&[...choices].every(([dim,v])=>!v||r.values[dim]?.includes(v))&&(!selectedRecords||selectedRecords.includes(r.id)));}
 function draw(){
  if(!data||loading)return;const rows=matchedRows(),map=mapping();
  const active=Boolean(query.value||selectedRecords||[...choices.values()].some(Boolean));
  emit(linked&&context?.id&&active?[...new Set(rows.map(r=>map.get(r.id)).filter(Boolean))]:null);
  figure.replaceChildren();svg='';currentDocument=null;exportSVG.disabled=exportJSON.disabled=!rows.length;
  if(rows.length){
   const R=globalThis.PaperRadarRelationsRenderer;currentDocument=R.projectRelations(data,{record_ids:rows.map(r=>r.id),dimensions:visibleDimensions});
   svg=(kind==='sankey'?R.renderSankey:R.renderCircular)(currentDocument,R.computeRelations(currentDocument),lang,{width_scale:Number(spacing.value)});figure.innerHTML=svg;
   const node=figure.querySelector('svg');node.style.width=width.value==='fit'?'100%':width.value+'px';
   figure.querySelectorAll('.mark').forEach(mark=>{mark.setAttribute('tabindex','0');mark.setAttribute('role','button');mark.setAttribute('aria-label',mark.querySelector('title')?.textContent??'筛选关联论文');const choose=()=>{selectedRecords=mark.dataset.records.split(' ');offset=0;draw();};mark.addEventListener('click',choose);mark.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();choose();}});});
  }else figure.append(el('p',lang==='zh'?'当前筛选无关系记录；可清空筛选，或关闭联动查看完整原始快照。':'No records match. Clear filters or unlink to inspect the original snapshot.'));
  const coverage=linkage?.coverage;
  status.textContent=(lang==='zh'?'匹配论文：':'Matching papers: ')+rows.length+' / '+data.records.length+(linked&&context?.id?' · 文献表筛选 '+tableCount+' 篇 · 身份对应 '+(coverage?.matched_papers??0)+' / '+(coverage?.topic_papers??0)+' 篇':' · 独立快照');
  notice.textContent=lang==='zh'?'筛选后重新计算图宽和数量；每篇每列合计 1，多标签分摊。点击节点或色带筛选同一批论文，重置恢复。减少列后按新的相邻维度计算同现，不能沿全路径推断论文关系。两份原始数据和来源分别保留，分类不会变成已核验表格事实。':'Counts and widths are recomputed for the selection; each paper contributes 1 per column with fractional multilabel weights. Click a node or band to filter its papers. Hidden columns reconnect only adjacent co-occurrences, never unique paper paths. Original sources and verification states are retained.';
  if(linked&&coverage&&coverage.matched_records>coverage.matched_papers)notice.append(document.createTextNode(' 多条关系记录对应同一篇论文；图按关系记录计量，表按独立论文计数，不代表新增论文。'));
  if(linked&&coverage&&(coverage.ambiguous_records||coverage.unmatched_records||coverage.conflicting_records))notice.append(document.createTextNode(' 未参与联动：未匹配 '+coverage.unmatched_records+'、歧义 '+coverage.ambiguous_records+'、冲突 '+coverage.conflicting_records+' 条；关闭联动可查看原始记录。'));
  renderCards(rows,map);
 }
 function renderCards(rows,map){
  cards.replaceChildren();for(const r of rows.slice(offset,offset+20)){
   const c=el('article');c.className='radar-card';c.append(el('h3',r.id+' · '+r.title));link(r.url,lang==='zh'?'论文来源 ↗':'Paper source ↗',c);
   if(map.has(r.id)&&onShowTable)c.append(btn('在文献表查看此篇',()=>{focusPaper(map.get(r.id));onShowTable();}));
   for(const dim of data.dimensions){c.append(el('p',t(dim.label)+': '+r.values[dim.id].map(v=>t(dim.categories.find(x=>x.id===v).label)).join('; ')));const evidence=r.evidence?.[dim.id];if(evidence)c.append(el('p',t(evidence.note)+' · '+(evidence.locator??'')));}
   for(const edge of data.relationships??[])if(edge.from===r.id||edge.to===r.id)c.append(el('p',edge.from+' → '+edge.to+': '+t(edge.label)+' · '+(edge.locator??'')));
   const details=el('details');details.append(el('summary',lang==='zh'?'证据与本库':'Evidence and library'));
   const refs=[...new Set([...r.source_ids,...Object.values(r.evidence??{}).flatMap(e=>e.source_ids??[])])];
   for(const id of refs){const source=data.sources.find(s=>s.id===id);if(!source)continue;const p=el('p',id+' · '+(source.title??'')+' · '+(source.accessed_at??'Date unknown'));link(source.url,' ↗',p);if(source.local_paper_id)p.append(btn(lang==='zh'?'核对并打开本库文献':'Match and open library paper',async()=>{try{const res=await api('field_radar_match',{papers:[{id:r.id,title:r.title,local_paper_id:source.local_paper_id}],limit:1});if(!alive||root.hidden||root.closest('.field-radar')?.hidden)return;const m=res.matches?.[0];if(m?.status==='matched'&&m.candidates.length===1)await onOpenPaper(m.candidates[0].id);else status.textContent='匹配不唯一或不完整，请从文献库核对。';}catch(e){if(alive)status.textContent=e.message;}}));details.append(p);}c.append(details);cards.append(c);
  }
  pages.replaceChildren();if(offset>0)pages.append(btn('←',()=>{offset=Math.max(0,offset-20);renderCards(rows,map);}));if(offset+20<rows.length)pages.append(btn('→',()=>{offset+=20;renderCards(rows,map);}));
 }
 async function load(){
  const own=++ticket;loading=true;request?.abort();request=new AbortController();status.textContent='Loading relations…';exportSVG.disabled=exportJSON.disabled=true;
  // Old figures cannot keep selecting/exporting an obsolete topic while a new scope is loading.
  figure.replaceChildren();cards.replaceChildren();pages.replaceChildren();currentDocument=null;svg='';
  try{
   const args=context?.id?{id:context.id,expected_revision:context.expected_revision}:{};
   const result=await api('field_radar_relations_get',args,{signal:request.signal});if(!alive||own!==ticket)return;
   let table=null;if(linked&&context?.id){table=await api('field_radar_table',{...context,all:true,offset:0,limit:100},{signal:request.signal});if(!alive||own!==ticket)return;}
   const changed=data!==null&&JSON.stringify(data.dimensions)!==JSON.stringify(result.document?.dimensions);
   data=result.document;snapshotRevision=result.revision;snapshotDigest=result.digest??null;linkage=result.linkage??null;allowedPaperIds=table?new Set(table.rows.map(r=>r.paper_id)):null;tableCount=table?.total??0;
   loading=false;if(!data){dimensions.replaceChildren();filters.replaceChildren();emit(null);status.textContent='尚未导入关系快照 / No relations snapshot imported.';return;}
   if(!visibleDimensions||changed)visibleDimensions=data.dimensions.map(d=>d.id);
   if(changed){choices.clear();selectedRecords=null;}
   scope.disabled=!context?.id;scope.checked=linked&&Boolean(context?.id);offset=0;controls();if(pendingPaper){const id=pendingPaper;pendingPaper=null;focusPaper(id);}else draw();
  }catch(e){if(alive&&own===ticket){loading=false;data=null;linkage=null;allowedPaperIds=null;dimensions.replaceChildren();filters.replaceChildren();status.textContent='关系视图读取失败：'+e.message;figure.append(btn('重试读取',()=>void load()));}}
 }
 function updateContext(value){const key=JSON.stringify(value);if(key===contextKey)return;const changed=context?.id!==value?.id||context?.expected_revision!==value?.expected_revision;context=value;contextKey=key;if(changed){selectedRecords=null;pendingPaper=null;choices.clear();query.value='';emit(null);}void load();}
 language.onchange=()=>{lang=language.value;controls();draw();};style.onchange=()=>{kind=style.value;draw();};query.oninput=()=>{selectedRecords=null;offset=0;draw();};spacing.onchange=draw;width.onchange=draw;
 scope.onchange=()=>{linked=scope.checked;selectedRecords=null;emit(null);void load();};
 contextKey=JSON.stringify(context);void load();
 function focusPaper(id){if(!linked&&context?.id){linked=true;scope.checked=true;pendingPaper=id;void load();return true;}if(!data||loading){pendingPaper=id;if(!loading)void load();return true;}linked=true;scope.checked=true;const ids=(linkage?.matches??[]).filter(m=>m.status==='matched'&&m.paper_id===id).map(m=>m.record_id);if(!ids.length){status.textContent='此篇没有唯一对应的关系记录，未自动合并。';return false;}selectedRecords=ids;choices.clear();query.value='';offset=0;draw();return true;}
 return {updateContext,clear(){selectedRecords=null;choices.clear();query.value='';offset=0;if(data){controls();draw();}else emit(null);},focusPaper,destroy(){alive=false;ticket++;request?.abort();root.replaceChildren();}};
}};
