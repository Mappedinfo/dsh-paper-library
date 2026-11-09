/* Full existing Field Radar reader, embedded in Paper Library. No network/model calls. */
(() => {
const TEMPLATE = "\n<header><div class=\"topline\"><div><div class=\"brand\">FIELD RADAR / 学者雷达</div><h1>谁在做，何时做，最近有什么证据？</h1><p class=\"muted\">先找到人，再看作品、来源和影响。固定名单的本地阅读视图。</p></div><div class=\"meta\" data-radar-id=\"dates\"></div></div>\n<nav aria-label=\"雷达视图\"><button data-tab=\"people\" aria-selected=\"true\">学者与时间</button><button data-tab=\"groups\" aria-selected=\"false\">机构与分组</button><button data-tab=\"review\" aria-selected=\"false\">待核线索</button><button data-tab=\"sources\" aria-selected=\"false\">数据与覆盖</button></nav></header>\n<main><section class=\"stats\" data-radar-id=\"stats\" aria-label=\"快照覆盖\"></section><div data-radar-id=\"stale\"></div>\n<section data-radar-id=\"search-area\"><div class=\"filters\">\n<label>搜人、主题或作品<input data-radar-id=\"query\" type=\"search\" placeholder=\"例如：mobility、城市、digital twin、Yang Yue\"></label>\n<label>导航领域（分类建议）<select data-radar-id=\"area\"><option value=\"\">全部领域</option></select></label>\n<label>机构（名单记录）<select data-radar-id=\"unit\"><option value=\"\">全部机构</option></select></label>\n<label>论文主题（OpenAlex 自动分类）<select data-radar-id=\"topic\"><option value=\"\">全部论文主题</option></select></label>\n</div><div class=\"filter-foot\"><label>身份<select data-radar-id=\"identity\"><option value=\"\">全部</option><option value=\"verified\">至少一源已核实</option><option value=\"pending\">没有已核实身份</option></select></label><label>“近期”窗口<select data-radar-id=\"recent\"><option value=\"3\">近3个日历年</option><option value=\"1\">本年</option><option value=\"5\">近5个日历年</option></select></label><label>发表信号<select data-radar-id=\"activity\"><option value=\"\">全部</option><option value=\"recent\">近期有记录</option><option value=\"unknown\">近期未见 / 未覆盖</option></select></label><button data-radar-id=\"reset\">清空筛选</button><span data-radar-id=\"count\" class=\"count meta\" aria-live=\"polite\"></span></div>\n</section>\n<section data-radar-id=\"people\" class=\"view\"><div class=\"notice\">论文、主题标签和机构记录是查找线索。近期论文不等于已确认当前研究兴趣；网页没读到也不等于停止研究。</div><div class=\"split\"><section class=\"panel list-panel\"><div data-radar-id=\"people-list\"></div></section><aside class=\"panel detail\" data-radar-id=\"detail\" aria-label=\"学者证据详情\"></aside></div></section>\n<section data-radar-id=\"groups\" class=\"view hidden\"><div class=\"panel\"><h2>从机构和画像分组找人</h2><p class=\"muted\">机构按固定名单记录归组，不代表历史任职时间。课题组来自已有综述映射，尚未逐项核对现任成员；共同发表不用于推定团队关系。</p><div class=\"link-row\"><button data-radar-id=\"group-mode-unit\" aria-pressed=\"true\">名单机构</button><button data-radar-id=\"group-mode-team\" aria-pressed=\"false\">画像分组 · 待核现任</button></div></div><div data-radar-id=\"group-grid\" class=\"group-grid\"></div></section>\n<section data-radar-id=\"review\" class=\"view hidden\"><div class=\"panel\"><h2>先查证，再纳入判断</h2><p class=\"muted\">本页的身份候选、自动主题和网页变化都不会自动升级为当前兴趣或团队成员证明。下面按当前学者筛选显示。</p><div data-radar-id=\"review-list\"></div></div></section>\n<section data-radar-id=\"sources\" class=\"view hidden\"><div class=\"panel\"><h2>这个视图覆盖了什么？</h2><div data-radar-id=\"coverage\"></div></div><div class=\"panel\"><h2>原始入口与更新时间</h2><p class=\"muted\">本页只编译已有文件，无联网、无数据库写入。本地来源保留路径供核对，不能由网页直接打开；网页证据可打开，论文可回到当前文献库检索。</p><div data-radar-id=\"source-list\"></div></div></section>\n<footer><div data-radar-id=\"footer-links\" class=\"link-row\"></div><p>离线可读 · 刷新页面不会抓取新资料。更新需显式重新导入已有本地快照。排名、手工综述与原始画像保持各自来源。</p></footer>\n</main>";
/* Offline Field Radar. Pure functions exported for lightweight Node tests. */
'use strict';
const Radar = (() => {
  const text = value => String(value ?? '');
  const h = value => text(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const norm = value => text(value).normalize('NFKD').replace(/\p{M}/gu,'').toLowerCase();
  function worksFor(person, data, topic='') {
    return person.works.map(i => data.works[i]).filter(Boolean).filter(w => !topic || (w.topic === topic && w.score !== null && w.score >= data.method.topicScoreThreshold));
  }
  function signal(person, data, topic='', years=3) {
    const works = worksFor(person, data, topic);
    const first = works.length ? Math.min(...works.map(w => w.year)) : null;
    const last = works.length ? Math.max(...works.map(w => w.year)) : null;
    const since = +data.snapshot.slice(0,4) - years + 1;
    const recent = works.filter(w => w.year >= since);
    return {works, first, last, recent, since, kind: recent.length ? 'recent' : works.length ? 'older' : 'uncovered'};
  }
  function filterPeople(data, state) {
    const tokens = norm(state.query).split(/\s+/).filter(Boolean);
    return data.people.filter(p => {
      if (state.area && p.area !== state.area || state.unit && p.unit !== state.unit) return false;
      if (state.identity === 'verified' && !p.identityVerified || state.identity === 'pending' && p.identityVerified) return false;
      const s = signal(p,data,state.topic,Number(state.recent || 3));
      if (state.topic && !s.works.length) return false;
      if (state.activity === 'recent' && !s.recent.length || state.activity === 'unknown' && s.recent.length) return false;
      const hay = norm([p.name,p.aliases,p.unit,p.group,p.area,p.subfield,...p.works.map(i => [data.works[i].title,data.works[i].topic].join(' '))].join(' '));
      return tokens.every(t => hay.includes(t));
    }).sort((a,b) => a.name.localeCompare(b.name,'zh-CN'));
  }
  function groupPeople(people,key) {
    const map = new Map();
    people.forEach(p => {const name = p[key] || (key === 'group' ? '尚无画像分组' : '机构未记录'); if (!map.has(name)) map.set(name,[]); map.get(name).push(p);});
    return [...map.entries()].sort((a,b) => b[1].length-a[1].length || a[0].localeCompare(b[0]));
  }
  function histogram(works, from, to) {
    return Array.from({length:to-from+1},(_,i) => ({year:from+i,count:works.filter(w => w.year===from+i).length}));
  }
  function availableTopics(data) {
    const assigned = new Set(data.people.flatMap(p => p.works));
    return [...new Set([...assigned].map(i => data.works[i]).filter(w => w && w.topic && w.score !== null && w.score >= data.method.topicScoreThreshold).map(w => w.topic))];
  }
  function safeURL(url) { try { const u = new URL(text(url)); return ['http:','https:'].includes(u.protocol) && !u.username && !u.password ? u.href : ''; } catch { return ''; } }
  return {h,norm,worksFor,signal,filterPeople,groupPeople,histogram,availableTopics,safeURL};
})();
function create({root, data: DATA, onOpenPaper, onSearchPaper}) {
  if (!root || !DATA || !Array.isArray(DATA.people) || !Array.isArray(DATA.works)) throw new Error('缺少完整雷达快照');
  root.classList.add('field-radar-legacy');
  root.innerHTML = TEMPLATE;
  const abort = new AbortController();
  const listen = (el,type,fn) => el.addEventListener(type,fn,{signal:abort.signal});
  let paperPage = 0;
  const paperSize = 25;
  const {h,signal,filterPeople,groupPeople,histogram,safeURL} = Radar;
  const $ = id => root.querySelector(`[data-radar-id="${id}"]`);
  const n = value => value !== null && value !== undefined && value !== '' ? Number(value).toLocaleString('en-US') : '—';
  const state = {query:'',area:'',unit:'',topic:'',identity:'',recent:'3',activity:''};
  let selected = null, tab = 'people', groupMode = 'unit';
  const link = (url,label) => safeURL(url) ? `<a href="${h(url)}" target="_blank" rel="noopener noreferrer">${h(label)}</a>` : h(label);
  const localLink = (url,label) => safeURL(url) ? link(url,label) : `<span class="source-path">${h(label)}${url ? ' · '+h(url) : ''}</span>`;
  const status = p => p.identityVerified ? '<span class="badge ok">索引身份已核实</span>' : '<span class="badge warn">身份待核</span>';
  const signalLabel = s => s.kind === 'recent' ? `近期 ${n(s.recent.length)} 篇记录` : s.kind === 'older' ? '近期未见记录' : '论文计量未覆盖';
  const signalBadge = s => `<span class="badge ${s.kind === 'recent'?'ok':'warn'}">${h(signalLabel(s))}</span>`;
  function options(id,values){$(id).insertAdjacentHTML('beforeend', [...new Set(values.filter(Boolean))].sort((a,b)=>a.localeCompare(b,'zh-CN')).map(v=>`<option value="${h(v)}">${h(v)}</option>`).join(''));}
  options('area',DATA.people.map(p=>p.area)); options('unit',DATA.people.map(p=>p.unit));
  options('topic',Radar.availableTopics(DATA));
  $('dates').innerHTML = `计量快照 ${h(DATA.snapshot)}<br>追踪运行 ${h(DATA.trackingRun)}<br>本地编译 ${h(DATA.generated.slice(0,10))}`;
  $('stats').innerHTML = [[DATA.audit.roster,'固定名单'],[`${DATA.audit.identityVerified}/${DATA.audit.roster}`,'至少一源身份已核实'],[`${DATA.audit.openalex}/${DATA.audit.roster}`,'OpenAlex 计量覆盖'],[DATA.health.page_failures,'本次网页读取失败'],[DATA.health.published_this_week,'追踪器标为本周发表']].map(([a,b])=>`<div class="stat"><b>${h(a)}</b><span>${h(b)}</span></div>`).join('');
  const age = Math.floor((Date.now()-Date.parse(DATA.snapshot+'T00:00:00Z'))/86400000);
  $('stale').innerHTML = [...DATA.warnings,...(age>14?[`当前是 ${new Date().toISOString().slice(0,10)}，这份快照已有 ${age} 天。所有“近期”判断以 ${DATA.snapshot} 为止。`]:[])].map(t=>`<div class="notice">${h(t)}</div>`).join('');
  $('footer-links').innerHTML = localLink(DATA.links.ranking,'打开原有同领域排名')+localLink(DATA.links.weekly,'查看本次动态周报')+localLink('README.md','使用方法与限制');
  function spark(s){const end=+DATA.snapshot.slice(0,4), bins=histogram(s.works,end-9,end),max=Math.max(1,...bins.map(b=>b.count));return `<div class="spark" role="img" aria-label="${h(bins.map(b=>b.year+'年'+b.count+'条').join('，'))}">${bins.map(b=>`<i style="height:${Math.max(2,b.count/max*24)}px" title="${b.year}: ${b.count}条"></i>`).join('')}</div>`;}
  function chart(s){if(!s.works.length)return '<div class="empty">没有可绘制的已收录论文年份。请检查其他论文源与画像。</div>'; const end=+DATA.snapshot.slice(0,4), start=Math.max(s.first,end-14),bins=histogram(s.works,start,end),max=Math.max(1,...bins.map(b=>b.count)); return `<div class="chart" role="img" aria-label="${h(bins.map(b=>b.year+'年'+b.count+'条').join('，'))}">${bins.map(b=>`<div class="bar-wrap"><div class="bar" title="${b.year}: ${b.count}条" style="height:${Math.max(1,b.count/max*110)}px"></div><span class="year-label">${b.year}</span></div>`).join('')}</div><p class="meta">最近15年内的可见记录；只计已收录成果，空柱不证明实际零发表。</p>`;}
  function renderPeople(people){
    $('people-list').innerHTML = people.length ? `<table><thead><tr><th>学者 / 导航方向</th><th>何时有记录？</th></tr></thead><tbody>${people.map(p=>{const s=signal(p,DATA,state.topic,+state.recent);return `<tr class="${selected===p.id?'selected':''}"><td><button class="name-button" data-person="${h(p.id)}" aria-pressed="${selected===p.id}">${h(p.name)}</button><div class="meta">${h(p.unit)}</div><div class="meta">${h(p.subfield||'方向未记录')} · 分类建议</div>${status(p)}</td><td>${signalBadge(s)}<div class="meta">${s.first?`${s.first}—${s.last} · ${n(s.works.length)}条`:'暂无可见论文时间范围'}</div>${spark(s)}</td></tr>`;}).join('')}</tbody></table>` : '<div class="empty">没有匹配项。试试英文主题或较短关键词，也可清空筛选。没有命中不代表该领域无人研究。</div>';
  }
  function papers(list, limit=8){return list.slice(0,limit).map(w=>`<div class="paper"><div class="paper-title">${link(w.url,w.title)}</div><button class="native-paper" data-radar-paper="${DATA.works.indexOf(w)}">在文献库中查找</button><div class="meta">${h(w.date||w.year+'（仅年份）')} · ${h(w.type)} · 快照引用 ${n(w.cites)}</div><div class="meta">${h(w.topic||'无自动主题')} ${w.topic?`· ${w.score===null?'分类分数缺失':'分类分数 '+w.score.toFixed(2)}`:''}</div>${w.raw?`<div class="meta">${localLink(w.raw,'查看快照原记录')}</div>`:''}</div>`).join('');}
  function renderDetail(){
    const p=DATA.people.find(p=>p.id===selected);
    if(!p){$('detail').innerHTML='<div class="empty">选择一位学者查看时间、论文和来源。</div>';return;}
    const s=signal(p,DATA,state.topic,+state.recent), all=s.works.slice().sort((a,b)=>b.year-a.year||(b.date||'').localeCompare(a.date||'')||a.title.localeCompare(b.title));
    const failedPages=p.pageChecks.filter(c=>c.status==='failed').length;
    const ok=p.sourceChecks.filter(c=>c.status.startsWith('success')).length;
    const bad=p.sourceChecks.filter(c=>!c.status.startsWith('success')).length;
    const rank=p.ranks.filter(r=>state.topic?r.topic_name===state.topic:r.local_impact_rank).sort((a,b)=>+b.paper_count-+a.paper_count);
    const global=p.global.find(g=>g.period==='singleyear_2025');
    $('detail').innerHTML = `<div class="kicker">${state.topic?'所选自动主题':'全部已收录论文'}</div><h2>${h(p.name)}</h2><p>${h(p.unit)} ${status(p)}</p><p class="meta">${h(({research:'研究',mixed:'研究＋实践',practice:'实践，论文不代表主要影响'})[p.track]||'轨道待核')}</p><div class="link-row">${localLink(p.dossier,'打开原画像')} ${p.urls.slice(0,3).map((u,i)=>link(u,'来源 '+(i+1))).join(' ')}</div>
    <div class="facts"><div class="fact"><strong>${s.first?`${s.first}—${s.last}`:'未知'}</strong><small>已收录记录区间，不是入行或离场时间</small></div><div class="fact"><strong>${n(s.recent.length)}</strong><small>${s.since}—${DATA.snapshot} 可见论文</small></div></div>
    <p>${signalBadge(s)}</p><p class="meta">“还感兴趣吗”仍需当前项目或官方个人页的具体内容佐证。此视图没有自动确认当前兴趣。</p>
    ${chart(s)}
    <h3>最近的发表记录</h3>${all.length?papers(all.slice(paperPage*paperSize,(paperPage+1)*paperSize),paperSize):'<div class="empty">该计量源未覆盖。身份表和周报中的其他来源仍可查，不将缺失记作停研。</div>'}
    ${all.length>paperSize?`<div class="paper-navigation"><button data-radar-page="-1" ${paperPage===0?'disabled':''}>上一页</button><span>${paperPage+1} / ${Math.ceil(all.length/paperSize)} · 共 ${all.length} 条</span><button data-radar-page="1" ${(paperPage+1)*paperSize>=all.length?'disabled':''}>下一页</button></div>`:''}
    <h3>影响：在相近范围内比较</h3><p class="meta">按现有 ${DATA.method.publicationWindow.join('—')} 年同主题论文比较；不随“近期”窗口变化，不合成跨领域总分。</p>
    ${rank.length?rank.slice(0,3).map(r=>`<div class="paper"><strong>${h(r.topic_name)}</strong><div>${n(r.paper_count)}篇 · 归一指标覆盖 ${r.normalized_coverage?(+r.normalized_coverage*100).toFixed(0)+'%':'未知'}</div><div class="meta">${r.local_impact_rank?`名单同主题引用表现 ${h(r.local_impact_rank)} / ${h(r.impact_peers)}`:'未达到现有可比门槛'} · 论文百分位中位数 ${r.median_work_percentile?(+r.median_work_percentile*100).toFixed(1):'—'}</div></div>`).join(''):'<p class="muted">当前筛选下没有可用同主题排名。实践、教学与项目影响另查，不按零处理。</p>'}
    ${global?.match_status==='matched'?`<p class="meta">全球原表 2025 单年口径：${h(global.subfield)}，名次 ${n(global.global_subfield_rank)} / ${n(global.subfield_population)}。按去自引 c-score；不是当前所选主题或本年的排名。</p>`:'<p class="meta">全球原表位置未确认，不推算。</p>'}
    <p>${localLink(DATA.links.ranking,'打开完整指标、同行分母与全球原表')}</p>
    <h3>方向与分组线索</h3><p>${h(p.area)} / ${h(p.subfield)} <span class="badge warn">自动分类建议</span></p><p class="meta">${h(p.excerpt||'没有画像摘录')}</p><p class="meta">${h(p.uncertainty)} 分类生成于 ${h(p.classificationDate.slice(0,10)||'未知')}。</p><p>${p.group?h(p.group)+' <span class="badge warn">画像分组，待核现任</span>':'尚无画像分组记录'}</p>${p.groupSource?`<p class="meta">${localLink(p.groupSource,'原有人工综述映射')} · 没有可用的成员起止日期。</p>`:''}
    <h3>本次来源覆盖</h3><p>论文源 ${ok} 次成功 / ${bad} 次失败或不完整；网页 ${p.pageChecks.length-failedPages} 次成功 / ${failedPages} 次失败。</p><p class="meta">读取成功只说明抓取状态，不表示内容已证明当前兴趣或任职。</p>
    <details><summary>核对身份、来源状态与待审更新</summary>${identityRows(p)}${checks(p)}${updateRows(p)}</details>`;
  }
  function identityRows(p){return `<h3>索引身份</h3>${p.identities.length?p.identities.map(i=>`<div class="queue-item"><strong>${h(i.source)} · ${h(i.author_id)}</strong> <span class="badge ${i.status==='verified'?'ok':'warn'}">${i.status==='verified'?'已核实':'候选待消歧'}</span><div class="meta">记录日期 ${h(i.verified_at)} · ${h(i.notes)}</div><div class="meta">${i.evidence_urls.split(';').filter(safeURL).map(u=>link(u,'核实依据')).join(' · ')}</div></div>`).join(''):'<p>没有身份记录。</p>'}`;}
  function checks(p){return `<h3>读取状态</h3>${p.sourceChecks.map(c=>`<div class="meta">${h(c.source)} / ${h(c.status)}${c.error?' / '+h(c.error):''}</div>`).join('')}${p.pageChecks.map(c=>`<div class="queue-item">${link(c.url,c.url)}<div class="meta ${c.status==='failed'?'status-bad':''}">${h(c.status)} ${h(c.error)}</div></div>`).join('')}`;}
  function updateRows(p){return `<h3>本次变化</h3>${p.updates.length?p.updates.map(u=>`<div class="queue-item">${link(u.url,u.title)}<div class="meta">${h(u.date)} · ${h(u.category)} · ${h(u.notes)}</div></div>`).join(''):'<p class="meta">本次没有追踪器通知；不代表没有变化。</p>'}`;}
  function renderGroups(people){$('group-grid').innerHTML=groupPeople(people,groupMode).map(([name,members])=>`<article class="group-card"><h3>${h(name)}</h3><p>${members.length}位固定名单成员 ${groupMode==='group'?'<span class="badge warn">映射，非现任验证</span>':''}</p>${members.map(p=>`<p><button class="name-button" data-person="${h(p.id)}">${h(p.name)}</button><br><span class="meta">${h(p.subfield)} · ${h(signalLabel(signal(p,DATA,state.topic,+state.recent)))}</span></p>`).join('')}</article>`).join('')||'<div class="empty">当前筛选没有机构或分组。</div>';}
  function renderReview(people){const blocked=people.filter(p=>!p.identityVerified),candidate=people.filter(p=>p.identities.some(i=>i.status!=='verified')),changed=people.filter(p=>p.updates.length),failed=people.filter(p=>p.pageChecks.some(c=>c.status==='failed'));$('review-list').innerHTML=`<h3>${blocked.length}位没有已核实索引身份</h3>${blocked.length?blocked.map(p=>`<p><button class="name-button" data-person="${h(p.id)}">${h(p.name)}</button> · ${h(p.unit)}</p>`).join(''):'<p>当前筛选没有此类缺口。</p>'}<details><summary>${candidate.length}位仍有其他待消歧索引候选</summary>${candidate.map(p=>`<h3>${h(p.name)}</h3>${identityRows({...p,identities:p.identities.filter(i=>i.status!=='verified')})}`).join('')}</details><h3>${changed.length}位有新发表、旧作回填或网页变化</h3>${changed.map(p=>`<details><summary>${h(p.name)} · ${p.updates.length}项</summary>${updateRows(p)}</details>`).join('')||'<p>当前筛选无更新通知。</p>'}<details><summary>${failed.length}位有网页读取失败</summary>${failed.map(p=>`<h3>${h(p.name)}</h3>${checks({...p,sourceChecks:[],pageChecks:p.pageChecks.filter(c=>c.status==='failed')})}`).join('')}</details><div class="notice">“published_this_week”是既有追踪器的元数据核验结果；同名作者或异常跨领域成果仍需逐篇复查。网页变化没有在本轮阅读确认，自动主题也未进行人工语义审核。</div>`;}
  function renderSources(){const a=DATA.audit,health=DATA.health;$('coverage').innerHTML=`<p>固定名单 ${a.roster}人，${a.units}个机构标签，${a.groups}个非空画像分组。它是选择性名单，不是整个领域普查。</p><p>追踪状态：<strong>${h(health.status)}</strong>。${health.publication_source_successes}/${health.publication_source_checks}次论文源检查成功，${health.page_successes}/${health.unique_pages_checked}个网页成功。</p><p>时间图来自 ${a.openalex}人的 OpenAlex 快照。原有 ${n(a.rawWorks)}条作品记录，按成果类型、未来日期、撤稿和缺失年份筛选后为 ${n(a.eligibleWorks)}条；显示 ${n(a.displayAssignments)}条去重的人—作品关联，隔离 ${a.excludedAssignments}条已有待审作者归属。最早收录 ${a.yearMin}年，最新 ${a.yearMax}年；并非完整职业史。</p><p>原台账共 ${n(a.ledgerWorks)}项。其回填、版本冲突及其他来源没有自动混进本图；可在原台账与周报查阅。</p><div class="notice">全体 ${a.roster-a.openalex}人没有本图的 OpenAlex 计量，其中 ${a.roster-a.identityVerified}人没有任何已核实索引身份。两种“缺失”不同。已核实作者档案也不保证其每篇作品归属无误。</div><details><summary>筛选与解释</summary><ul><li>图中保留 article、conference-paper、review、book、book-chapter、data-paper、software-paper；预印本等仍留在原台账。按每位学者的 DOI（没有 DOI 则作品ID）去重。</li><li>未来：${n(a.exclusions.future||0)}；撤稿：${n(a.exclusions.retracted||0)}；其他成果类型：${n(a.exclusions.non_paper_type||0)}；缺年份：${n(a.exclusions.missing_year||0)}。排除顺序互斥。</li><li>主题筛选使用 OpenAlex 自动主题且分类分数≥${DATA.method.topicScoreThreshold}；这是既有审阅阈值，不是正确率。低分仍能在作品详情看到。</li><li>主题时间图范围比原排名宽；原排名固定使用 ${DATA.method.publicationWindow.join('—')}年、至少 ${DATA.method.minimumPapers}篇及其既有覆盖门槛。</li><li>首次可见年份不等于开始研究年份；最新记录不等于退出时间。机构、画像分组、共著与当前兴趣各自需要来源。</li><li>没有推断团队现任成员、当前研究兴趣、完整机构任职史或领域总体影响力。</li><li>这是源数据阅读视图，不是新的科学分析；复用原快照的统计与图件。机构是类别，不含地理坐标或空间测量。</li></ul>${localLink(DATA.links.method,'查看原排名方法')}</details>`;$('source-list').innerHTML=`<div class="wide-scroll"><table><thead><tr><th>读取的文件</th><th>文件修改时间（UTC，不代表内容核验时间）</th></tr></thead><tbody>${DATA.manifest.map(s=>`<tr><td class="meta">${localLink(s.href,s.name)}</td><td class="meta">${h(s.modified)}</td></tr>`).join('')}</tbody></table></div>`;}
  function setTab(name){tab=name;root.querySelectorAll('nav [data-tab]').forEach(b=>b.setAttribute('aria-selected',String(b.dataset.tab===tab)));root.querySelectorAll('.view').forEach(v=>v.classList.toggle('hidden',v.dataset.radarId!==tab));$('search-area').classList.toggle('hidden',tab==='sources');}
  function render(){const people=filterPeople(DATA,state);if(!people.some(p=>p.id===selected))selected=people[0]?.id||null;$('count').textContent=`${people.length} / ${DATA.people.length}人 · 近期窗口 ${+DATA.snapshot.slice(0,4)-Number(state.recent)+1}—${DATA.snapshot}`;renderPeople(people);renderDetail();renderGroups(people);renderReview(people);}
  Object.keys(state).forEach(id=>listen($(id),id==='query'?'input':'change',()=>{state[id]=$(id).value;paperPage=0;render();}));
  listen($('reset'),'click',()=>{Object.keys(state).forEach(id=>{state[id]=id==='recent'?'3':'';$(id).value=state[id];});paperPage=0;render();});
  listen(root.querySelector('nav'),'click',e=>{const b=e.target.closest('[data-tab]');if(b)setTab(b.dataset.tab);});
  listen(root,'click',e=>{
    const person=e.target.closest('[data-person]');
    if(person){selected=person.dataset.person;paperPage=0;setTab('people');renderPeople(filterPeople(DATA,state));renderDetail();$('detail').scrollTop=0;}
    const page=e.target.closest('[data-radar-page]');
    if(page && !page.disabled){paperPage=Math.max(0,paperPage+Number(page.dataset.radarPage));renderDetail();}
    const button=e.target.closest('[data-radar-paper]');
    if(button){const w=DATA.works[Number(button.dataset.radarPaper)];if(w){const doi=w.doi || (safeURL(w.url).startsWith('https://doi.org/') ? new URL(w.url).pathname.slice(1) : ''); const callback=onSearchPaper || onOpenPaper; if(callback) callback({title:w.title,doi,url:safeURL(w.url)});}}
  });
  ['unit','team'].forEach(mode=>listen($('group-mode-'+mode),'click',()=>{groupMode=mode==='team'?'group':'unit';$('group-mode-unit').setAttribute('aria-pressed',String(groupMode==='unit'));$('group-mode-team').setAttribute('aria-pressed',String(groupMode==='group'));renderGroups(filterPeople(DATA,state));}));
  renderSources();render();
  return {render, destroy(){abort.abort();root.replaceChildren();root.classList.remove('field-radar-legacy');}};
}
globalThis.PaperFieldRadarLegacy = Object.freeze({create, ...Radar});
})();
