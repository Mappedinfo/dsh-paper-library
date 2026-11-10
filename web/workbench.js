'use strict';
// Metadata-only table and editor. Pagination is owned by the disk catalog;
// clicking a title opens the reader (a metadata-only record shows its no-PDF
// surface without fetching pages), while plain row selection stays read-only.
window.PaperWorkbench = (() => {
  const $ = id => document.getElementById(id);
  const node = (tag, text, className) => { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; if (className) n.className = className; return n; };
  const name = a => {
    if(a.literal)return a.literal;
    const family=String(a.family||'').trim(),given=String(a.given||'').trim();
    if(/^[\p{Script=Han}]+$/u.test(family)&&(!given||/^[\p{Script=Han}]+$/u.test(given)))return family+given;
    return [given,a['non-dropping-particle'],family,a.suffix].filter(Boolean).join(' ');
  };
  const incompleteAuthor = item => item.parse?.field_sources?.author==='synced-filename'&&(item.author||[]).some(a=>!a.literal&&!a.given&&/^[\p{Script=Latin}'’-]+$/u.test(a.family||''));
  const institutions = item => [...new Set((item.author || []).flatMap(a => (a.affiliation || []).map(v => typeof v === 'string' ? v : v.name)).filter(Boolean))];
  const gradeScales = {CCF:['A','B','C'],ICORE:['A*','A','B','C']};
  const quartiles = ['Q1','Q2','Q3','Q4'];
  const ranking = item => [...(item.journal_rankings || [])].sort((a,b)=>a.system.localeCompare(b.system)||b.year-a.year)
    .map(r => `${r.system} ${r.quartile||r.grade} · ${r.year} ${r.category}`).join('；');
  const types = {'article-journal':'期刊论文','paper-conference':'会议论文',preprint:'预印本',manuscript:'未发表稿件',book:'图书',chapter:'书籍章节',thesis:'学位论文',report:'报告',dataset:'数据集',speech:'演讲 / 报告',patent:'专利',standard:'标准','article-newspaper':'报纸文章','article-magazine':'杂志文章','post-weblog':'博客文章',webpage:'网页',article:'文章',document:'文档'};
  const typeOf = item => item.resource_kind==='slides'?'presentation':item.resource_kind==='dataset'?'dataset':
    item.type==='article'&&(/^preprint$/i.test(item.genre||'')||/^arxiv$/i.test(item.archive||''))?'preprint':item.type;
  const fileType = item => item.resource_kind==='slides'?'PlainDeck':item.pdf?'PDF':
    item.storage_formats?.length?item.storage_formats.slice(0,3).map(format=>/^[a-z0-9]+$/i.test(format)?format.toUpperCase():format).join(' / ')+(item.storage_formats.length>3?'…':''):'无附件';
  const columns = [['title','标题'],['author','作者'],['year','年份'],['journal','期刊 / 出处'],['ranking','文章分区'],['citekey','引用键'],[null,'DOI'],[null,'单位'],[null,'发表 / 收稿 / 接收'],[null,'文献类型'],[null,'文件格式']];
  function create({state,api,loadList,openPaper,selectPaper,changed,tableChanged,toast,el,resource,organization,openMetadataPanel,closeMetadataPanel,persistence,enableAutomaticDoi,openAbstract}) {
    let table = false, editing = null, revision = 0, readingId = null;
    let editorVisible=false, initialFields=null, initialRankings=null, restoring=false, selectingForEdit=false, loadingEditId=null, drafts=new Map();
    const draftFields=['title','authors','year','citekey','tags','type','journal','volume','issue','page','publisher','doi','url','published','online','print','received','accepted','affiliations'];
    const metadataKeys=['id','title','author','issued','type','genre','archive','citekey','tags','container-title','volume','issue','page','publisher','DOI','URL','publication_dates','journal_rankings'];
    const draftLimit=256*1024, draftCount=12;
    const draftId=item=>item?.id||'@new';
    const stateKey=id=>`metadata:${id==='@new'?'new':id}`;
    const validDraft=value=>value?.base&&value?.fields&&value?.initialFields&&Array.isArray(value.rankings)&&Array.isArray(value.initialRankings)?value:null;
    function persistDraft(key,value){if(persistence)void persistence.put(stateKey(key),value).catch(error=>toast(`资料草稿尚未保存到本地服务：${error.message}`,true));}
    function formFields(){return Object.fromEntries(draftFields.map(key=>[key,$(`edit-${key}`).value]));}
    function formRankings(){return [...$('ranking-rows').children].map(row=>({original:JSON.parse(row.dataset.original),fields:Object.fromEntries([...row.querySelectorAll('[data-rank-field]')].map(input=>[input.dataset.rankField,input.value]))}));}
    function snapshotDraft(){return {base:Object.fromEntries(metadataKeys.filter(key=>editing[key]!==undefined).map(key=>[key,structuredClone(editing[key])])),fields:formFields(),rankings:formRankings(),initialFields,initialRankings};}
    function rememberDraft() {
      if(!editing||restoring)return true;
      const key=draftId(editing),draft=snapshotDraft();
      if(window.PaperLibraryLocalState.byteLength([[key,draft]])>draftLimit){toast('这份资料草稿超过 256 KiB，请先保存或缩短内容，再切换资料。',true);return false;}
      drafts.delete(key);drafts.set(key,draft);
      persistDraft(key,draft);
      // Only the working cache is bounded. Every paper has its own durable file.
      while(drafts.size>draftCount||window.PaperLibraryLocalState.byteLength([...drafts])>draftLimit)drafts.delete(drafts.keys().next().value);
      return true;
    }
    function dirty(){if(restoring||!editing)return;revision++;rememberDraft();}
    function setEditorLoading(value){oldForm.inert=value;oldForm.setAttribute('aria-busy',String(value));for(const input of oldForm.querySelectorAll('input, textarea, select, button'))input.disabled=value;}
    function metadataVisibility(value){const next=Boolean(value);if(editorVisible&&!next){rememberDraft();revision++;loadingEditId=null;setEditorLoading(false);}editorVisible=next;}
    function setPanelHost(value={}){openMetadataPanel=value.openMetadataPanel;closeMetadataPanel=value.closeMetadataPanel;}
    function paperChanged(item){if(selectingForEdit)return;const loadingChanged=loadingEditId!==null&&loadingEditId!==draftId(item);if(loadingChanged){revision++;loadingEditId=null;setEditorLoading(false);}if(editorVisible&&(loadingChanged||editing&&draftId(item)!==draftId(editing)))return edit(item);}
    const button = (text, id, fn, className='button subtle') => { const b=node('button',text,className); b.type='button'; if(id)b.id=id; b.addEventListener('click',fn); return b; };
    const cellPreview=node('div',undefined,'catalog-cell-preview');cellPreview.id='catalog-cell-preview';cellPreview.setAttribute('role','tooltip');cellPreview.hidden=true;document.body.append(cellPreview);
    let previewTarget=null;
    function hideCellPreview(){previewTarget?.removeAttribute('aria-describedby');previewTarget=null;cellPreview.hidden=true;}
    function showCellPreview(target){
      const text=target?.closest?.('.table-title, .table-cell-text');
      if(!text||!$('catalog-table').contains(text)||text.scrollHeight<=text.clientHeight+1&&text.scrollWidth<=text.clientWidth+1){hideCellPreview();return;}
      hideCellPreview();previewTarget=text;cellPreview.textContent=text.textContent;cellPreview.hidden=false;text.setAttribute('aria-describedby',cellPreview.id);
      const box=text.getBoundingClientRect(),preview=cellPreview.getBoundingClientRect();
      cellPreview.style.left=`${Math.max(8,Math.min(box.left,innerWidth-preview.width-8))}px`;
      cellPreview.style.top=`${box.bottom+preview.height+8<innerHeight?box.bottom+5:Math.max(8,box.top-preview.height-5)}px`;
    }
    $('catalog-table').addEventListener('pointerover',e=>showCellPreview(e.target));
    $('catalog-table').addEventListener('pointerout',e=>{if(!e.target.contains(e.relatedTarget)&&previewTarget!==document.activeElement)hideCellPreview();});
    $('catalog-table').addEventListener('focusin',e=>showCellPreview(e.target));
    $('catalog-table').addEventListener('focusout',hideCellPreview);
    $('catalog-table').addEventListener('scroll',hideCellPreview,{passive:true});
    $('catalog-table').addEventListener('keydown',e=>{if(e.key==='Escape')hideCellPreview();});
    window.addEventListener('resize',hideCellPreview);
    const brand=document.querySelector('.brand'), brandGroup=node('div',undefined,'brand-group');brand.before(brandGroup);brandGroup.append(brand,$('toolbar-paper'));
    // Move the existing controls, retaining their event handlers and IDs.
    // Board controls for the current paper travel with the other per-paper actions; the
    // container below is removed, so anything not moved here would disappear at boot.
    for (const id of ['copy-apa','export-bib','download-pdf','open-in-pane','metadata-open','attach-open']) $('toolbar-actions').append($(id));
    $('toolbar-actions').append(button('补全资料','metadata-enrich',enrich));$('metadata-enrich').title='选中文献后，按标识符或题名查询 Crossref / arXiv；PDF 正文不上传。';
    $('toolbar-actions').append($('export-notes').closest('label'));
    $('toolbar-reader').append(document.querySelector('.page-controls'),$('page-note'));
    $('paper-tools').prepend($('toolbar-reader'));
    document.querySelector('.paper-actions').remove();
    document.querySelector('.reader-toolbar').remove();
    const metadata = node('dl',undefined,'paper-metadata'); metadata.id='paper-metadata'; $('paper-authors').after(metadata);
    const file = node('details',undefined,'paper-file-disclosure'); file.append(node('summary','文件与解析信息'),$('paper-file-meta')); $('paper-tags').after(file);
    const expand=button('展开表格','catalog-expand',()=>{const selected=state.active;if(table&&selected&&!selected.archived&&(selected.id!==readingId||(selected.pdf&&!state.pageData))){void openPaper(selected.id);}else setTable(!table);}); expand.setAttribute('aria-expanded','false');expand.setAttribute('aria-label','展开表格');expand.title='展开表格';document.querySelector('.shelf-actions').prepend(expand);
    const controls=node('div',undefined,'catalog-controls');
    const scope=node('select'); scope.id='catalog-scope'; scope.setAttribute('aria-label','文献范围');
    for(const [value,label] of [['active','在库条目'],['archived','回收站']]) { const o=node('option',label);o.value=value;scope.append(o); }
    scope.addEventListener('change',()=>{state.archived=scope.value==='archived';state.offset=0;expand.disabled=state.archived;if(state.archived)setTable(true);void loadList();});
    const sort=node('select');sort.id='catalog-sort';sort.setAttribute('aria-label','文献排序');
    for(const [value,label] of [['modified','最近修改'],['created','最近导入'],...columns.filter(c=>c[0])]) { const o=node('option',label);o.value=value;sort.append(o); }
    sort.addEventListener('change',()=>sortBy(sort.value,state.order));
    const order=button('降序 ↓','catalog-order',()=>sortBy(state.sort,state.order==='asc'?'desc':'asc'));
    const kind=node('select');kind.id='catalog-kind';kind.setAttribute('aria-label','条目类型');for(const [value,label] of [['all','全部类型'],['paper','文献'],['dataset','数据集'],['slides','演示文稿']]){const option=node('option',label);option.value=value;kind.append(option);}kind.addEventListener('change',()=>{state.kind=kind.value;state.offset=0;void loadList();});
    const projectFilter=document.querySelector('.library-filterbar > .library-organizer-row');
    if(projectFilter)controls.append(projectFilter);
    controls.append(kind,scope,sort,order,button('＋ 文献','catalog-create',()=>edit(null)),button('＋ 数据集','dataset-create',()=>resource()?.edit()));
    document.querySelector('.list-heading').replaceWith(controls);
    // Existing list status ID remains available to the shared paginator.
    const summary=node('span',undefined,'small muted');summary.id='search-summary';(controls.closest('.library-filterbar')||controls).after(summary);
    const archive=button('移入回收站','catalog-archive',()=>{const item=selectedItem();if(item&&item.resource_kind!=='slides')return archivePaper(item);},'button');
    const selectedItem=()=>state.catalogSlideId?state.items.find(item=>item.id===state.catalogSlideId):state.items.find(item=>item.id===state.active?.id);
    const read=button('阅读','catalog-read',()=>{const item=selectedItem();if(!item||item.archived)return;if(item.resource_kind==='slides')return selectPaper(item);setTable(false);void openPaper(item.id);});
    const editSelected=button('编辑','catalog-edit',()=>{const item=selectedItem();if(item&&!item.archived&&item.resource_kind!=='slides')edit(item);});
    const isPaper=item=>item&&(!item.resource_kind||item.resource_kind==='paper');
    function showAbstract(item){if(isPaper(item)&&!item.archived)void openAbstract?.({id:item.id},item.title);}
    const abstractSelected=button('摘要','catalog-abstract',()=>showAbstract(selectedItem()));
    const abstractCurrent=button('摘要','paper-abstract',()=>showAbstract(state.active));
    for(const control of [abstractSelected,abstractCurrent])control.setAttribute('aria-haspopup','dialog');
    const editTags=button('管理标签','catalog-manage-tags',()=>{const item=selectedItem();if(isPaper(item)&&!item.archived)void organization?.()?.edit(item);});
    editTags.setAttribute('aria-haspopup','dialog');
    const findRank=button('查出处评级','catalog-venue-rank',()=>{const item=selectedItem();if(isPaper(item)&&!item.archived)openVenueRanking(item);});
    findRank.setAttribute('aria-haspopup','dialog');
    let revealing=false;
    async function reveal(item){if(!item?.pdf||item.archived||revealing)return;revealing=true;syncCatalogActions();try{await api('paper_reveal',{id:item.id});toast('已在运行 DSH 的主机上打开 PDF 所在文件夹。');}catch(error){toast(error.message,true);}finally{revealing=false;syncCatalogActions();}}
    const revealSelected=button('所在文件夹','catalog-reveal',()=>reveal(selectedItem()));
    const revealCurrent=button('所在文件夹','paper-reveal',()=>reveal(state.catalogSlideId?null:state.active));
    revealSelected.title=revealCurrent.title='在运行 DSH 的主机上显示 PDF；macOS 使用 Finder';
    $('toolbar-reader').append(revealCurrent);
    const selectedActions=node('span',undefined,'catalog-selection-actions');selectedActions.setAttribute('role','group');selectedActions.setAttribute('aria-label','选中条目的操作');selectedActions.append(read,editSelected);
    if(openAbstract){selectedActions.append(abstractSelected);$('toolbar-actions').append(abstractCurrent);}
    selectedActions.append(editTags,findRank,revealSelected,archive);controls.append(selectedActions);
    function syncCatalogActions(){const item=selectedItem(),valid=Boolean(item),live=valid&&!item.archived,slide=item?.resource_kind==='slides';read.disabled=!live;read.textContent=slide?'打开':item?.resource_kind==='dataset'?'浏览':'阅读';editSelected.disabled=!live||slide;findRank.disabled=!live||!isPaper(item);abstractSelected.disabled=findRank.disabled;editTags.disabled=findRank.disabled||!organization?.();revealSelected.disabled=!live||!item.pdf||revealing;archive.disabled=!valid||slide;archive.textContent=item?.archived?'恢复':'移入回收站';revealCurrent.disabled=!state.active?.pdf||state.active?.archived||Boolean(state.catalogSlideId)||revealing;}
    syncCatalogActions();
    const rankDialog=node('dialog',undefined,'paper-tag-editor');
    rankDialog.setAttribute('aria-labelledby','venue-rank-title');
    const rankHeading=node('header'),rankTitle=node('h2','查出处评级');
    rankTitle.id='venue-rank-title';
    const closeRank=button('关闭',null,()=>rankDialog.close());
    rankHeading.append(rankTitle,closeRank);
    const rankForm=node('form'),rankField=node('label','会议或期刊名称 / ISSN','field'),rankInput=node('input');
    rankInput.required=true;rankInput.maxLength=500;rankField.append(rankInput);
    const searchOjr=node('button','查开放分区','button primary');searchOjr.type='submit';
    const searchCcf=node('button','查 CCF','button');searchCcf.type='submit';
    const rankStatus=node('p',undefined,'small');rankStatus.setAttribute('role','status');
    const rankResults=node('ul',undefined,'venue-rank-results');
    const rankSources=node('p',undefined,'venue-rank-sources small');
    for(const [label,url] of [['OpenJournalRank','https://openjournalrank.com/en/methodology/'],['CCF 目录','https://www.ccf.org.cn/Academic_Evaluation/By_category/'],['ICORE 会议评级','https://icore.dsi.uclm.es/'],['SCImago SJR','https://www.scimagojr.com/'],['Clarivate JCR（需订阅）','https://jcr.clarivate.com/jcr/home']]){
      const link=node('a',label);link.href=url;link.target='_blank';link.rel='noopener noreferrer';rankSources.append(link);
    }
    rankForm.append(rankField,searchOjr,searchCcf,rankStatus,rankResults);
    rankDialog.append(rankHeading,rankForm,rankSources,node('p','开放分区采用 OpenJournalRank 子领域的报告年份。可在资料中同时登记不同评级体系。','small muted'));
    document.body.append(rankDialog);
    let rankRequest=0,rankItem=null,rankSystem='OJR';
    const rankBusy=value=>{searchOjr.disabled=value;searchCcf.disabled=value;};
    rankDialog.addEventListener('close',()=>{++rankRequest;});
    function openVenueRanking(item){
      rankItem=item;
      rankSystem=item.type==='paper-conference'?'CCF':'OJR';
      rankInput.value=item['event-title']||item['container-title']||'';
      rankInput.value||=(Array.isArray(item.ISSN)?item.ISSN[0]:item.ISSN)||'';
      rankStatus.textContent='';rankResults.replaceChildren();rankBusy(false);
      rankDialog.showModal();
      rankInput.focus();
      if(rankInput.value.trim())void searchVenueRanking(rankSystem);
    }
    async function searchVenueRanking(system){
      const request=++rankRequest,venue=rankInput.value.trim(),item=rankItem;
      rankSystem=system;rankBusy(true);rankStatus.textContent=`正在查 ${system}…`;rankResults.replaceChildren();
      try{
        const originalVenue=item['event-title']||item['container-title']||'';
        const result=await api('venue_ranking_lookup',{venue,system,...(venue===originalVenue?{type:item.type,...(item.ISSN?{issn:item.ISSN}:{})}:{})});
        if(request!==rankRequest)return;
        const matches=result.matches||[];
        rankStatus.textContent=matches.length?`${system} · ${matches.length} 条候选，请核对出处后填入资料。`:
          system==='OJR'?'OpenJournalRank 未找到子领域分区，可试期刊全称或 ISSN。':'CCF 未匹配，可试会议或期刊的全称、官方简称。';
        for(const value of matches){
          const record={system,year:value.year||result.year,category:value.category,source:value.source||result.source,
            ...(system==='CCF'?{grade:value.rank}:{quartile:value.quartile}),...(value.release?{release:value.release}:{}),verified_at:new Date().toISOString()};
          const line=node('li',`${system} ${record.quartile||record.grade} · ${record.year} · ${value.kind==='conference'?'会议':'期刊'} · ${value.category} · ${value.name}${value.acronym?` (${value.acronym})`:''}`);
          if(value.release)line.append(node('small',` · 版本 ${value.release}`));
          const source=node('a','来源');source.href=record.source;source.target='_blank';source.rel='noopener noreferrer';line.append(source);
          line.append(button('填入资料',null,async()=>{
            rankDialog.close();
            if(!await edit(item))return;
            const exists=formRankings().some(({fields})=>fields.system===record.system&&Number(fields.year)===record.year&&fields.category===record.category&&fields.quartile===(record.quartile||record.grade));
            if(!exists){addRanking(record);dirty();}
            $('ranking-rows').scrollIntoView?.({block:'nearest'});
          }));
          rankResults.append(line);
        }
      }catch(error){if(request===rankRequest)rankStatus.textContent=`${system} 查询失败：${error.message}`;}
      finally{if(request===rankRequest)rankBusy(false);}
    }
    rankForm.addEventListener('submit',event=>{event.preventDefault();void searchVenueRanking(event.submitter===searchCcf?'CCF':event.submitter===searchOjr?'OJR':rankSystem);});
    rankInput.addEventListener('input',()=>{++rankRequest;rankStatus.textContent='';rankResults.replaceChildren();rankBusy(false);});
    const oldForm=$('metadata-form');
    oldForm.addEventListener('submit',save);
    oldForm.addEventListener('input',dirty);oldForm.addEventListener('change',dirty);
    $('metadata-dialog').addEventListener('close',()=>metadataVisibility(false));
    $('metadata-dialog').querySelector('h2').id='metadata-dialog-title';
    const extra=node('div',undefined,'metadata-extra');
    const fields=[['journal','期刊 / 出处'],['volume','卷'],['issue','期'],['page','页码'],['publisher','出版社'],['doi','DOI'],['url','论文链接'],['published','发表日期'],['online','在线发表'],['print','印刷发表'],['received','收稿日期'],['accepted','接收日期']];
    for(const [id,label] of fields) { const field=node('label',label,'field');const input=node('input');input.id=`edit-${id}`;if(['published','online','print','received','accepted'].includes(id)){input.placeholder='YYYY 或 YYYY-MM 或 YYYY-MM-DD';input.pattern='[0-9]{4}(-[0-9]{2}(-[0-9]{2})?)?';}field.append(input);extra.append(field); }
    const typeLabel=node('label','文献类型','field');const type=node('select');type.id='edit-type';for(const [v,t] of Object.entries(types)) {if(v==='dataset')continue;const o=node('option',t);o.value=v;type.append(o);}typeLabel.append(type);extra.prepend(typeLabel);
    const affiliationLabel=node('label','作者单位','field full-width');
    const affiliation=node('textarea');affiliation.id='edit-affiliations';affiliation.rows=3;affiliation.placeholder='作者序号 | 单位；另一单位\n1 | University of Example';
    affiliationLabel.append(node('span','每行填写一位作者，序号对应上方作者顺序。留空表示未提供。'),affiliation);extra.append(affiliationLabel);
    const ranks=node('section',undefined,'ranking-editor full-width');ranks.append(node('h3','文章分区'),node('p','每条记录填写评级体系、报告年份、学科和来源。','small muted'));const rows=node('div');rows.id='ranking-rows';ranks.append(rows,button('＋ 添加分区','ranking-add',()=>{addRanking();dirty();}));extra.append(ranks);
    $('edit-tags').closest('label').after(extra);
    function addRanking(value={},draft={}) {
      const row=node('div',undefined,'ranking-row');
      const fields={};
      for(const [key,label] of [['system','评级体系'],['year','报告年份'],['quartile','分区或等级'],['category','学科'],['source','来源 URL 或书目']]){
        const labelNode=node('label',label,'field'),input=node(['system','quartile'].includes(key)?'select':'input');
        input.dataset.rankField=key;input.setAttribute('aria-label',label);input.required=true;fields[key]=input;
        if(key==='year'){input.type='number';input.min='1900';input.max='9999';}
        labelNode.append(input);row.append(labelNode);
      }
      for(const system of ['JCR','OJR','SJR','CiteScore','CCF','ICORE']){const option=node('option',system);option.value=system;fields.system.append(option);}
      function scale(selected=''){
        const labels=gradeScales[fields.system.value]||quartiles;
        fields.quartile.replaceChildren(...labels.map(label=>{const option=node('option',label);option.value=label;return option;}));
        fields.quartile.value=labels.includes(selected)?selected:'';
      }
      fields.system.value=draft.system??value.system??'JCR';
      scale(draft.quartile??value.quartile??value.grade);
      fields.system.addEventListener('change',()=>scale(fields.quartile.value));
      for(const key of ['year','category','source'])fields[key].value=draft[key]??value[key]??'';
      row.dataset.original=JSON.stringify(value);row.append(button('移除',null,()=>{row.remove();dirty();}));$('ranking-rows').append(row);return row;
    }
    function sortBy(key,dir) {state.sort=key||'modified';state.order=dir||'desc';state.offset=0;sort.value=state.sort;order.textContent=state.order==='asc'?'升序 ↑':'降序 ↓';void loadList();}
    function setTable(value) {if(value&&!table)readingId=state.active?.id;table=value;tableChanged?.(table);document.querySelector('.workspace').classList.toggle('catalog-expanded',table);$('catalog-table').hidden=!table;$('paper-list').hidden=table;expand.textContent=table?'收起表格':'展开表格';expand.setAttribute('aria-label',table?'收起表格':'展开表格');expand.title=table?'收起表格':'展开表格';expand.setAttribute('aria-expanded',String(table));render();header();}
    const canEnterDoi=item=>item&&!item.archived&&!item.DOI&&(isPaper(item)||item.resource_kind==='dataset');
    const doiEligible=item=>canEnterDoi(item)&&['article-journal','paper-conference','preprint','dataset'].includes(typeOf(item));
    const doiAttempts=new Map();
    const doiKey=item=>JSON.stringify([item.id,item.modified,item.revision]);
    let doiBusy=false;
    const doiDialog=node('dialog',undefined,'paper-tag-editor');doiDialog.id='catalog-doi-dialog';
    const doiHeading=node('header'),doiTitle=node('h2','输入 DOI');doiTitle.id='catalog-doi-title';doiDialog.setAttribute('aria-labelledby',doiTitle.id);
    const closeDoi=button('关闭',null,()=>doiDialog.close());doiHeading.append(doiTitle,closeDoi);
    const doiIdentity=node('p',undefined,'catalog-doi-identity'),doiAuthors=node('p',undefined,'small muted');
    const doiForm=node('form'),doiLabel=node('label','DOI 或 doi.org 链接','field'),doiInput=node('input');
    doiInput.id='catalog-doi-input';doiInput.required=true;doiInput.maxLength=2048;doiInput.spellcheck=false;doiInput.autocapitalize='off';doiInput.placeholder='10.… 或 https://doi.org/…';doiLabel.append(doiInput);
    const doiSubmit=node('button','核对并保存','button primary');doiSubmit.type='submit';
    const doiStatus=node('p',undefined,'small');doiStatus.id='catalog-doi-status';doiStatus.setAttribute('role','status');
    doiForm.append(doiLabel,doiSubmit,doiStatus);doiDialog.append(doiHeading,doiIdentity,doiAuthors,doiForm);document.body.append(doiDialog);
    let doiItem=null,verifyingDoi=false;
    doiDialog.addEventListener('cancel',event=>{if(verifyingDoi)event.preventDefault();});
    function enterDoi(item){
      if(!canEnterDoi(item)||verifyingDoi)return;
      doiItem=item;doiInput.value='';doiStatus.textContent='标题和作者均匹配后保存。';
      doiIdentity.textContent=item.title;doiAuthors.textContent=(item.author||[]).map(name).join(' · ')||'当前条目缺少作者';
      if(!doiDialog.open)doiDialog.showModal();doiInput.focus();
    }
    async function showSavedDoi(item,doi){
      for(const entry of [state.active,...state.items])if(entry?.id===item.id&&!entry.DOI)entry.DOI=doi;
      await loadList();
    }
    doiForm.addEventListener('submit',async event=>{
      event.preventDefault();
      const item=doiItem,doi=doiInput.value.trim();
      if(!item||!doi||verifyingDoi)return;
      verifyingDoi=true;doiInput.disabled=doiSubmit.disabled=closeDoi.disabled=true;doiStatus.textContent='正在核对登记标题和作者…';
      try{
        const result=await api('catalog_doi_lookup',{id:item.id,kind:item.resource_kind,doi});
        if(result.status==='mismatch'){
          const fields=[!result.titleMatches?'标题':'',!result.authorsMatch?'作者':''].filter(Boolean).join('和');
          doiStatus.textContent=`登记${fields}与库内资料不一致。\n登记标题：${result.registered.title}\n登记作者：${result.registered.author.map(name).join(' · ')}`;
          return;
        }
        if(result.status!=='saved'||!result.DOI)throw Error('未能确认此 DOI，请核对后重试。');
        await showSavedDoi(item,result.DOI);doiDialog.close();toast(`已核对并保存 DOI：${result.DOI}`);
      }catch(error){doiStatus.textContent=error.code==='STATE_CONFLICT'?'核对期间条目资料已更新。请刷新文献列表后重新核对。':error.message;}
      finally{verifyingDoi=false;doiInput.disabled=doiSubmit.disabled=closeDoi.disabled=false;render();header();}
    });
    async function findDoi(item,manual=false){
      if(doiBusy||!doiEligible(item))return;
      const key=doiKey(item);
      doiBusy=true;doiAttempts.set(key,'查找中…');render();
      try{
        const result=await api('catalog_doi_lookup',{id:item.id,kind:item.resource_kind,manual});
        if(result.status==='saved'&&result.DOI)await showSavedDoi(item,result.DOI);
        else doiAttempts.set(key,({'needs-source':'查找 DOI','not-found':'未找到 · 重试',ambiguous:'多个结果 · 重试',unverified:'待核对 · 重试',skipped:'查找 DOI'})[result.status]||'查找 DOI');
      }catch(error){doiAttempts.set(key,'查找失败 · 重试');if(manual)toast(error.message,true);}
      finally{
        doiBusy=false;
        while(doiAttempts.size>256)doiAttempts.delete(doiAttempts.keys().next().value);
        render();header();
      }
    }
    function render() {
      hideCellPreview();
      syncCatalogActions();
      const selected=selectedItem();
      if(enableAutomaticDoi?.()&&!doiBusy&&!doiDialog.open&&doiEligible(selected)&&!doiAttempts.has(doiKey(selected)))queueMicrotask(()=>{
        const latest=selectedItem();
        if(enableAutomaticDoi()&&!doiDialog.open&&doiEligible(latest)&&!doiAttempts.has(doiKey(latest)))void findDoi(latest);
      });
      if(!table)return;
      const grid=node('table');grid.setAttribute('aria-label','文献、数据集与演示文稿资料表');const widths=node('colgroup');for(const field of ['title','author','year','journal','jcr','citekey','doi','institution','dates','kind','storage']){const col=node('col');col.className=`catalog-column-${field}`;widths.append(col);}grid.append(widths);const head=node('thead');const headerRow=node('tr');
      for(const [key,label] of columns){const th=node('th');th.scope='col';if(key){th.setAttribute('aria-sort',state.sort===key?(state.order==='asc'?'ascending':'descending'):'none');th.append(button(`${label}${state.sort===key?(state.order==='asc'?' ↑':' ↓'):''}`,null,()=>sortBy(key,state.sort===key&&state.order==='asc'?'desc':'asc')));}else th.textContent=label;headerRow.append(th);}head.append(headerRow);grid.append(head);
      const body=node('tbody');for(const item of state.items){const selected=state.active?.id===item.id||state.catalogSlideId===item.id;const row=node('tr',undefined,selected?'selected':'');row.dataset.paperId=item.id;row.tabIndex=0;row.setAttribute('aria-selected',String(selected));const choose=()=>selectPaper(item);row.addEventListener('click',e=>{if(!e.target.closest('button,a,input,select,textarea'))choose();});row.addEventListener('keydown',e=>{if(e.target===row&&(e.key==='Enter'||e.key===' ')){e.preventDefault();choose();}});
        const dates=item.publication_dates||{},kind=typeOf(item);const values=[item.title,(item.author||[]).map(name).join(' · '),item.issued?.['date-parts']?.[0]?.[0],item.resource_kind==='dataset'?item.publisher:item['container-title'],ranking(item),item.citekey,item.DOI,institutions(item).join('；'),[dates.published||dates.online||dates.print,dates.received,dates.accepted].map(v=>v||'—').join(' / '),kind==='presentation'?'演示文稿':types[kind]||kind,fileType(item)];
        values.forEach((value,i)=>{const td=node('td'),text=String(value||'—');if(i===0){const b=button(value||'未命名条目',null,()=>selectPaper(item), 'table-title');b.setAttribute('aria-pressed',String(selected));b.title=b.textContent;td.append(b);}else if(i===2&&!value&&isPaper(item)&&!item.archived){const addYear=button('填年份',null,async()=>{if(await edit(item))$('edit-year').focus();},'button subtle catalog-add-year');addYear.setAttribute('aria-label',`填写年份：${item.title}`);td.append(addYear);}else if(i===6&&canEnterDoi(item)){
          const controls=node('div',undefined,'catalog-doi-actions');
          if(doiEligible(item)){const search=button(doiAttempts.get(doiKey(item))||'查找 DOI',null,()=>void findDoi(item,true));search.title='使用题名或公开标识到 DOI 注册库核对';search.disabled=doiBusy;controls.append(search);}
          const enter=button('输入 DOI',null,()=>enterDoi(item));enter.setAttribute('aria-haspopup','dialog');controls.append(enter);td.append(controls);
        }else{const textNode=node('span',text,'table-cell-text');textNode.title=text;td.append(textNode);}row.append(td);});
        body.append(row);
        const actions=isPaper(item)?organization?.()?.actions(item):null;
        if(actions?.children.length){
          row.classList.add('has-catalog-tags');
          const tagsRow=node('tr',undefined,selected?'catalog-tags-row selected':'catalog-tags-row');
          const cell=node('td');cell.colSpan=columns.length;cell.append(actions);tagsRow.append(cell);body.append(tagsRow);
          tagsRow.addEventListener('click',e=>{if(!e.target.closest('button'))choose();});
        }
      }grid.append(body);$('catalog-table').replaceChildren(grid);if(!state.items.length)$('catalog-table').append(node('p',state.archived?'回收站为空。':state.project&&state.kind==='slides'?'演示文稿不属于阅读项目；切回全部条目查看。':'没有匹配的条目。','empty-state'));
    }
    function header() {
      syncCatalogActions();
      const item=state.active;const enabled=Boolean(item&&!item.archived&&!state.catalogSlideId);
      document.querySelectorAll('[data-tab]').forEach(n=>n.disabled=!enabled);
      $('toolbar-paper').textContent=state.catalogSlideTitle||(item?[item.title,item.issued?.['date-parts']?.[0]?.[0]].filter(Boolean).join(' · '):'选择一篇文献');const copy=$('toolbar-copy-apa');if(copy)copy.hidden=!enabled;$('toolbar-paper').title=state.catalogSlideTitle||item?.title||'';
      for(const n of $('toolbar-actions').querySelectorAll('button'))n.disabled=!enabled;
      abstractCurrent.disabled=!enabled||!isPaper(item);
      $('download-pdf').hidden=!enabled||!item.pdf;
      $('export-notes').disabled=!enabled||!item.pdf;
      $('toolbar-reader').hidden=!enabled||!item.pdf||table||state.tab!=='reader';
      $('attach-open').hidden=!enabled||Boolean(item.pdf);
      if(!item){metadata.replaceChildren();return;}
      const dates=item.publication_dates||{};const publication=dates.published||dates.online||dates.print;const preprint=String(item.archive||'').toLowerCase()==='arxiv';const pairs=[['单位',institutions(item).join('；')||'未提供'],[item.type==='manuscript'?'稿件日期':!publication&&preprint?'预印本提交':'发表',publication||String(item.issued?.['date-parts']?.[0]?.join('-')||'未提供')],['收稿',dates.received||'未提供'],['接收',dates.accepted||'未提供'],['文章分区',ranking(item)||'未提供'],['DOI',item.DOI||'未提供']];
      metadata.replaceChildren();for(const [label,value] of pairs){const d=node('div');const dd=node('dd',value);if(label==='文章分区'&&item.journal_rankings?.length)dd.title=item.journal_rankings.map(r=>`${r.system} ${r.year} ${r.category} ${r.quartile||r.grade} · ${r.source}`).join('\n');d.append(node('dt',label),dd);metadata.append(d);}
      file.hidden=!item.pdf_filename&&!item.parse?.needs_review;
    }
    function edit(item=state.active,{lookup=false}={}) {
      if(item?.resource_kind==='dataset')return resource()?.edit(item);
      if(!rememberDraft())return false;
      if(!persistence)return renderEditor(item,drafts.get(draftId(item)),lookup);
      const ticket=++revision;loadingEditId=draftId(item);setEditorLoading(true);editorVisible=true;$('metadata-dialog-title').textContent='正在读取资料草稿…';
      if(openMetadataPanel)openMetadataPanel();else if(!$('metadata-dialog').open)$('metadata-dialog').showModal();
      return persistence.get(stateKey(draftId(item))).then(value=>{
        if(ticket!==revision)return false;loadingEditId=null;setEditorLoading(false);
        return renderEditor(item,validDraft(value),lookup);
      }).catch(error=>{if(ticket===revision){loadingEditId=null;setEditorLoading(false);editorVisible=false;if(closeMetadataPanel)closeMetadataPanel();else $('metadata-dialog').close();toast(`无法读取资料草稿，已有内容仍保留：${error.message}`,true);}return false;});
    }
    function renderEditor(item,saved,lookup) {
      $('metadata-author-candidates')?.remove();
      // Row editing selects metadata only. Its summary and toolbar must describe
      // the same record that Save will update, even if another PDF was open.
      if(item?.id&&state.active?.id!==item.id&&selectPaper){
        selectingForEdit=true;try{selectPaper(item);}finally{selectingForEdit=false;}
      }
      const summary=document.querySelector('.paper-header');if(summary)summary.hidden=!item?.id;
      if(saved&&!lookup)item=saved.base;
      restoring=true;
      editing=structuredClone(item||{});revision++;$('metadata-dialog-title').textContent=editing.id?'编辑文献资料':'新建文献条目';
      oldForm.querySelectorAll('button').forEach(b=>b.disabled=false);
      $('edit-title').value=item?.title||'';$('edit-authors').value=(item?.author||[]).map(a=>a.literal||[a.family,a.given].filter(Boolean).join(', ')).join('\n');
      $('edit-year').value=item?.issued?.['date-parts']?.[0]?.[0]||'';$('edit-citekey').value=item?.citekey||'';$('edit-tags').value=(item?.tags||[]).map(t=>typeof t==='string'?t:t.tag).filter(Boolean).join(', ');
      const typeValue=item?typeOf(item)||'document':'article-journal';if(![...type.options].some(o=>o.value===typeValue)){const o=node('option',typeValue);o.value=typeValue;type.append(o);}type.value=typeValue;
      $('edit-journal').value=item?.['container-title']||'';$('edit-doi').value=item?.DOI||'';$('edit-url').value=item?.URL||'';
      for(const key of ['volume','issue','page','publisher'])$(`edit-${key}`).value=item?.[key]||'';
      for(const k of ['published','online','print','received','accepted'])$(`edit-${k}`).value=item?.publication_dates?.[k]||'';
      $('edit-affiliations').value=(item?.author||[]).map((a,i)=>{const names=(a.affiliation||[]).map(v=>typeof v==='string'?v:v.name).filter(Boolean);return names.length?`${i+1} | ${names.join('；')}`:'';}).filter(Boolean).join('\n');
      editing._affiliationsText=$('edit-affiliations').value;
      editing._authorsText=$('edit-authors').value;editing._yearText=$('edit-year').value;
      $('ranking-rows').replaceChildren();for(const r of item?.journal_rankings||[])addRanking(r);
      initialFields=formFields();initialRankings=formRankings();
      if(saved){
        for(const key of draftFields)if(saved.fields[key]!==undefined&&(!lookup||saved.fields[key]!==saved.initialFields[key]))$(`edit-${key}`).value=saved.fields[key];
        if(!lookup||JSON.stringify(saved.rankings)!==JSON.stringify(saved.initialRankings)){
          $('ranking-rows').replaceChildren();for(const value of saved.rankings)addRanking(value.original,value.fields);
        }
        if(!lookup){initialFields=saved.initialFields;initialRankings=saved.initialRankings;}
      }
      restoring=false;editorVisible=true;$('metadata-error').hidden=true;
      if(openMetadataPanel)openMetadataPanel();else if(!$('metadata-dialog').open)$('metadata-dialog').showModal();
      return true;
    }
    async function save(event) {
      event.preventDefault();event.stopImmediatePropagation();if(!editing)return;rememberDraft();const editRevision=revision;const editId=editing.id;const savedDraftKey=draftId(editing),submittedDraft=JSON.stringify(snapshotDraft());const buttons=[...oldForm.querySelectorAll('button')];buttons.forEach(b=>b.disabled=true);
      try {
        const lines=$('edit-authors').value.split('\n').map(l=>l.trim()).filter(Boolean);
        const author=$('edit-authors').value===editing._authorsText?structuredClone(editing.author||[]):lines.map(l=>{const p=l.split(',');return p.length>1?{family:p.shift().trim(),given:p.join(',').trim()}:{literal:l};});
        if($('edit-authors').value!==editing._authorsText||$('edit-affiliations').value!==editing._affiliationsText){
          for(const a of author)delete a.affiliation;
          const seen=new Set();for(const line of $('edit-affiliations').value.split('\n').filter(l=>l.trim())){const m=/^\s*(\d+)\s*\|\s*(.+)$/.exec(line);if(!m||!author[Number(m[1])-1]||seen.has(Number(m[1])))throw new Error('单位请填写「作者序号 | 单位」，每位作者一行，多个单位以分号分隔。');seen.add(Number(m[1]));const a=author[Number(m[1])-1];const matches=(editing.author||[]).filter(v=>name(v)===name(a));const previous=$('edit-authors').value===editing._authorsText?editing.author?.[Number(m[1])-1]:matches.length===1?matches[0]:null;a.affiliation=m[2].split(/[;；]/).map(v=>v.trim()).filter(Boolean).map(value=>structuredClone((previous?.affiliation||[]).find(v=>v.name===value)||{name:value}));}
        }
        const journal_rankings=formRankings().map(({original,fields})=>{
          const field=gradeScales[fields.system]?'grade':'quartile';
          const record={system:fields.system,year:Number(fields.year),category:fields.category.trim(),source:fields.source.trim(),[field]:fields.quartile};
          if(Object.keys(record).every(key=>record[key]===original[key])){
            if(original.verified_at)record.verified_at=original.verified_at;
            if(original.release)record.release=original.release;
          }
          return record;
        });
        const publication_dates={};for(const k of ['published','online','print','received','accepted']){const v=$(`edit-${k}`).value.trim();if(v)publication_dates[k]=v;}
        const metadata={title:$('edit-title').value.trim(),author,type:type.value,issued:$('edit-year').value===editing._yearText?editing.issued||{}:$('edit-year').value?{'date-parts':[[Number($('edit-year').value)]]}:{},citekey:$('edit-citekey').value.trim(),tags:$('edit-tags').value.split(/[,，]/).map(t=>t.trim()).filter(Boolean),'container-title':$('edit-journal').value.trim(),DOI:$('edit-doi').value.trim(),URL:$('edit-url').value.trim(),publication_dates,journal_rankings};
        for(const key of ['volume','issue','page','publisher'])metadata[key]=$(`edit-${key}`).value.trim();
        if(type.value==='preprint'){metadata.type='article';metadata.genre='Preprint';}
        else if(/^preprint$/i.test(editing.genre||''))metadata.genre='';
        if(!metadata.DOI&&!editing.DOI&&(!editId||type.value===typeOf(editing)))delete metadata.DOI;
        const result=await api(editId?'update':'create',{...(editId?{id:editId}:{}),metadata});
        if(JSON.stringify(drafts.get(savedDraftKey))===submittedDraft){drafts.delete(savedDraftKey);persistDraft(savedDraftKey,null);}
        if(editRevision===revision){editing=null;editorVisible=false;if(closeMetadataPanel)closeMetadataPanel();else $('metadata-dialog').close();}changed(result);await loadList();toast('文献资料已保存');
      }catch(e){if(editRevision===revision){$('metadata-error').textContent=e.message;$('metadata-error').hidden=false;}else toast(e.message,true);}finally{if(editRevision===revision)buttons.forEach(b=>b.disabled=false);}
    }
    async function archivePaper(item) {
      if(!item||item.resource_kind==='slides')return;if(item.resource_kind==='dataset')return resource()?.archive(item);const restoring=Boolean(item.archived);
      try{await api(restoring?'restore':'archive',{id:item.id});changed(null,item.id);if(state.items.length===1&&state.offset)state.offset=Math.max(0,state.offset-state.limit);await loadList();toast(restoring?'文献已恢复':'已移入回收站，可在文献范围中恢复；PDF 和批注保留。');}catch(e){toast(e.message,true);}
    }
    async function enrich() {
      const item=state.active;if(!item||!rememberDraft())return;const id=item.id;const token=++revision;$('metadata-enrich').disabled=true;$('metadata-enrich').textContent='正在查找…';
      try{const result=await api('metadata_lookup',{id});if(token!==revision||state.active?.id!==id)return;const draft=result.author_candidates?.length?{...result.item,author:result.author_candidates}:result.item;if(!await edit(draft,{lookup:true}))return;
            toast('已将可核验资料填入编辑表单，请核对后保存。');if(result.warnings?.length){$('metadata-error').textContent=result.warnings.join('；');$('metadata-error').hidden=false;}}
      catch(e){toast(e.message,true);}finally{$('metadata-enrich').textContent='补全资料';header();}
    }
    header();return {render,header,edit,setTable,isTable:()=>table,setPanelHost,paperChanged,metadataVisibility};
  }
  return {create,institutions,ranking,authorName:name,incompleteAuthor};
})();
