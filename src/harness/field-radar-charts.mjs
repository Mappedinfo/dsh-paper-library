import { projectFieldRadarAnalytics,validateRadarGeography } from './field-radar-analytics.mjs';
const colors=['#0c746b','#c17728','#536bbe','#ad4d75','#64944c','#a567b1','#247fa5','#8e7257','#7d8830','#b8604b','#65867c','#727889'];
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c])).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g,'');
const fit=(v,width,size)=>{let out='',used=0;for(const c of String(v??'')){const w=size*(/[\u0000-\u007f]/.test(c)?.57:1);if(used+w>width)return out+'…';out+=c;used+=w;}return out;};
const txt=(v,x,y,size=28,color='#203c49',anchor='start')=>`<text x="${x}" y="${y}" font-size="${size}" fill="${color}" text-anchor="${anchor}">${esc(anchor==='start'?fit(v,Math.max(60,1150-x),size):v)}</text>`;
const short=(v,n=44)=>[...String(v??'')].length>n?[...String(v)].slice(0,n-1).join('')+'…':String(v??'');
const unique=a=>[...new Set(a)];
export function renderRadarChart(record,settings){
 validateRadarGeography(record.document);
 const {view,width,offset,limit,group_by,frequency_by}=settings, a=projectFieldRadarAnalytics(record.document,settings), d=record.document, W=1200; let body=[],height=1200,records=[],total=0,count=0,has_more=false,available=true;
 const titles={frequency:'研究频次',publications:'发表年份 × 研究分类',citations:'已核验的引用关系',geography:'研究区与数据地图'},kind={task:'任务',subtopic:'小主题',research_group:'研究组',method:'方法标签 / 原文',dataset:'数据集'};
 const lines=(v,x,y,n=44,size=27,max=2)=>{let chars=[...String(v??'')],out='',line='',used=0,row=0;const width=Math.min(1150-x,n*size);for(let i=0;i<chars.length;i++){const c=chars[i],w=size*(/[\u0000-\u007f]/.test(c)?.57:1);if(used+w>width){out+=txt(line+(row===max-1?'…':''),x,y+row*(size+8),size);if(++row===max)return out;line='';used=0;}line+=c;used+=w;}if(line)out+=txt(line,x,y+row*(size+8),size);return out;};
 let detail='';
 if(view==='frequency'){
  total=a.frequency.length; records=a.frequency.slice(offset,offset+limit);count=records.length;has_more=offset+count<total;available=count>0; height=Math.max(1000,620+count*105); const max=Math.max(1,...a.frequency.map(r=>r.count));
  detail=`按${kind[frequency_by]}计数 · 同篇每类一次 · 多标签类别间可重复`;
  body.push(txt(`已收录 ${a.coverage.papers} 篇 · 缺少该字段 ${a.coverage.frequency_missing} 篇`,50,320,28),txt(`类别 ${count?offset+1:0}–${offset+count} / ${total}`,50,362,24,'#5b727b'));
  records.forEach((r,i)=>{const y=420+i*105;body.push(lines(r.name,50,y,35,26,2),`<rect x="670" y="${y-24}" width="450" height="38" rx="5" fill="#e5eceb"/><rect x="670" y="${y-24}" width="${450*r.count/max}" height="38" rx="5" fill="${colors[i%colors.length]}"/>`,txt(r.count,1140,y+5,29,'#203c49','end'));});
 }
 if(view==='publications'){
  total=a.publications.length;records=a.publications.slice(offset,offset+limit);count=records.length;has_more=offset+count<total;available=count>0;
  const allNames=unique(records.flatMap(r=>Object.keys(r.segments))), names=allNames.slice(0,11);if(allNames.length>11)names.push('其余类别'); const max=Math.max(1,...records.map(r=>r.count)),bw=Math.min(90,900/Math.max(1,count)),step=1000/Math.max(1,count);height=1340+Math.ceil(names.length/2)*68;
  detail=`按${kind[group_by]}堆叠 · 多标签论文均分权重，每篇总计 1`;
  body.push(txt(`有年份 ${a.coverage.papers-a.coverage.unknown_year} 篇 · 年份未知 ${a.coverage.unknown_year} · 未分类 ${a.coverage.unclassified}`,50,320,26));
  for(let k=0;k<=Math.min(max,5);k++){const v=max*k/Math.min(max,5),y=850-v/max*420;body.push(`<line x1="100" y1="${y}" x2="1140" y2="${y}" stroke="#d9e3e2"/>`,txt(Number(v.toFixed(1)),82,y+8,23,'#5b727b','end'));}
  records.forEach((r,i)=>{let y=850;const x=110+i*step+(step-bw)/2;names.forEach((name,j)=>{const val=name==='其余类别'?Object.entries(r.segments).filter(([n])=>!names.slice(0,-1).includes(n)).reduce((s,[,v])=>s+v,0):r.segments[name]||0;const h=val/max*420;y-=h;if(h)body.push(`<rect x="${x}" y="${y}" width="${bw}" height="${h}" fill="${colors[j]}"/>`);});body.push(txt(r.count,x+bw/2,y-14,28,'#203c49','middle'),txt(r.year,x+bw/2,890,25,'#203c49','middle'));});
  names.forEach((n,i)=>{const x=50+(i%2)*555,y=980+Math.floor(i/2)*68;body.push(`<rect x="${x}" y="${y-23}" width="22" height="22" rx="3" fill="${colors[i]}"/>`,txt(short(n,27),x+36,y,25));});
  body.push(txt('柱顶为论文数；分段为分摊篇数，不把主题分组冒充实验室归属。',50,1080+Math.ceil(names.length/2)*68,25,'#5b727b'));
 }
 if(view==='citations'){
  total=a.citations.edges.length;records=a.citations.edges.slice(offset,offset+limit);count=records.length;has_more=offset+count<total;available=count>0; const nodeIds=unique(records.flatMap(r=>[r.source_paper_id,r.target_paper_id]));height=Math.max(1450,1300+nodeIds.length*65);
  detail='箭头：引用论文 → 被引用论文 · 不代表领域完整引用网络';
  body.push(txt(`当前 ${a.coverage.papers} 篇 · 已核验 ${total} 条边 · 引用量已采集 ${a.coverage.citation_counts_known} 篇`,50,320,26));
  const points=new Map(nodeIds.map((id,i)=>{const theta=-Math.PI/2+i*Math.PI*2/nodeIds.length;return [id,{x:600+Math.cos(theta)*400,y:650+Math.sin(theta)*220,index:i}];}));
  body.push('<defs><marker id="arrow" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10Z" fill="#577b7d"/></marker></defs>');
  records.forEach(e=>{const s=points.get(e.source_paper_id),t=points.get(e.target_paper_id),len=Math.hypot(t.x-s.x,t.y-s.y),dx=(t.x-s.x)/len,dy=(t.y-s.y)/len;body.push(`<line x1="${s.x+dx*35}" y1="${s.y+dy*35}" x2="${t.x-dx*40}" y2="${t.y-dy*40}" stroke="#577b7d" stroke-width="4" marker-end="url(#arrow)"/>`);});
  nodeIds.forEach((id,i)=>{const p=points.get(id),paper=d.papers.find(p=>p.id===id);body.push(`<circle cx="${p.x}" cy="${p.y}" r="32" fill="${colors[i%colors.length]}"/>`,txt(i+1,p.x,p.y+11,30,'white','middle'),txt(short(id,23),p.x,p.y+65,25,'#203c49','middle'),txt(`${i+1}. ${paper.year??'?'} · ${short(paper.title,63)}`,50,1000+i*65,25));});
  if(!available)body.push(lines('未取得可核验的引用边。方法相似、共著或对照关系不会自动画成引用。',70,460,36,32,4));
 }
 if(view==='geography'){
  const rows=[...a.geography.areas.map(r=>({...r,layer:'study_area'})),...a.geography.observations.map(r=>({...r,layer:'observation'}))];total=rows.length;records=rows.slice(offset,offset+limit);count=records.length;has_more=offset+count<total;available=count>0;height=Math.max(1400,1200+count*70);
  detail=a.geography.observations.length?'来源空间数据与研究区 · 数值逐项注明指标与单位':'研究区标注模式 · 未取得原始轨迹或 OD 数值';
  body.push(txt(`覆盖 ${a.coverage.mapped_papers}/${a.coverage.papers} 篇 · 研究区 ${a.coverage.study_areas} · 数值记录 ${a.coverage.observations}`,50,320,27));
  const box={x:60,y:390,w:1080,h:480},project=p=>[box.x+(p[0]+180)/360*box.w,box.y+(90-p[1])/180*box.h];
  body.push(`<rect x="${box.x}" y="${box.y}" width="${box.w}" height="${box.h}" fill="#e7f0f3" stroke="#bdcdd0"/>`);
  for(let lon=-120;lon<=120;lon+=60){const[x]=project([lon,0]);body.push(`<line x1="${x}" y1="390" x2="${x}" y2="870" stroke="#cadbdf"/>`,txt(`${lon}°`,x,901,21,'#5b727b','middle'));}for(let lat=-60;lat<=60;lat+=30){const[,y]=project([0,lat]);body.push(`<line x1="60" y1="${y}" x2="1140" y2="${y}" stroke="#cadbdf"/>`,txt(`${lat}°`,54,y+6,20,'#5b727b','end'));}
  function draw(r,color,context=false){const g=r.geometry;const line=c=>c.map((p,i)=>{const[x,y]=project(p);return`${i?'L':'M'}${x.toFixed(2)},${y.toFixed(2)}`;}).join(' ');if(g.type==='Point'){const[x,y]=project(g.coordinates);return `<circle cx="${x}" cy="${y}" r="${context?4:9}" fill="${color}" stroke="white" stroke-width="2"/>`;}const path=g.type==='LineString'?line(g.coordinates):g.type==='Polygon'?g.coordinates.map(c=>line(c)+'Z').join(' '):g.coordinates.map(poly=>poly.map(c=>line(c)+'Z').join(' ')).join(' ');return`<path d="${path}" fill="${g.type==='LineString'?'none':context?'#d6dfda':color}" fill-opacity="${context?1:.36}" stroke="${context?'#a3b4ad':color}" stroke-width="${context?1:2.5}" fill-rule="evenodd"/>`;}
  body.push('<defs><clipPath id="mapclip"><rect x="60" y="390" width="1080" height="480"/></clipPath></defs><g clip-path="url(#mapclip)">');a.geography.context.forEach(r=>body.push(draw(r,'#d6dfda',true)));records.forEach((r,i)=>body.push(draw(r,colors[i%colors.length])));body.push('</g>');
  records.forEach((r,i)=>{const y=975+i*70;body.push(`<rect x="50" y="${y-23}" width="22" height="22" fill="${colors[i%colors.length]}"/>`,txt(`${i+1}. ${short(r.name,25)}${r.value!=null?' · '+r.value+' '+r.unit+' / '+r.metric:''}`,88,y,27),txt(short(r.precision,76),88,y+29,21,'#5b727b'));});
  if(!available)body.push(lines('没有带来源的空间几何。保留地名线索，不猜测坐标、研究边界或人口移动。',90,550,33,34,4));
 }
 if(!available&&!['geography','citations'].includes(view))body.push(txt('当前筛选暂无可绘制记录。',60,470,34));
 const allRefs=unique([...a.source_ids,...records.flatMap(r=>r.source_ids||[]),...(view==='geography'?a.geography.context.flatMap(r=>r.source_ids||[]):[])]),sources=d.sources.filter(s=>allRefs.includes(s.id));
 const footerY=height-140;const footWarning=view==='geography'?(a.geography.observations.length?'数值按原始指标/单位标注；未进行跨数据集可比性假设。':'点位是来源中的代表位置，不是采样边界；底图仅为选定背景，不表示研究覆盖。'):view==='citations'?'未画出的引用关系是未收录，不等于不存在。未知引用量不计为零。':view==='publications'?'收录选择会影响趋势；缺失年份和类别单独保留。':'频次表示收录论文关联数，不是领域影响力或数据样本规模。';
 const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${Math.round(height*width/W)}" viewBox="0 0 ${W} ${height}"><rect width="100%" height="100%" fill="#f4f7f6"/><g font-family="PingFang SC,Noto Sans CJK SC,Microsoft YaHei,sans-serif">${txt('PAPER LIBRARY · SOURCE-BACKED RESEARCH',50,55,24,'#0c746b')}${lines(d.topic.title,50,114,40,38,2)}${txt(titles[view],50,220,44)}${txt(detail,50,267,26,'#527078')}${body.join('')}${txt(short(footWarning,75),50,footerY,23,'#527078')}${txt(`保存版本 ${String(record.revision).slice(0,12)} · 来源 ${sources.length} · 数据保存 ${String(record.updated_at||'未知').slice(0,10)}`,50,footerY+40,22,'#527078')}${txt('完整记录、来源链接、筛选和核验日期保存在同名私有 JSON。',50,footerY+77,22,'#527078')}</g></svg>`;
 return {svg,height:Math.round(height*width/W),settings,total,count,has_more,source_ids:allRefs,records,sources,coverage:a.coverage,warnings:a.warnings,available,analytics:{...a,papers:undefined}};
}
