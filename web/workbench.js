'use strict';
// Metadata-only table and editor. Pagination is owned by the disk catalog;
// clicking a title opens the reader (a metadata-only record shows its no-PDF
// surface without fetching pages), while plain row selection stays read-only.
window.PaperWorkbench = (() => {
  const $ = id => document.getElementById(id);
  const node = (tag, text, className) => { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; if (className) n.className = className; return n; };
  const name = a => a.literal || [a.given, a.family].filter(Boolean).join(' ');
  const institutions = item => [...new Set((item.author || []).flatMap(a => (a.affiliation || []).map(v => typeof v === 'string' ? v : v.name)).filter(Boolean))];
  const ranking = item => (item.journal_rankings || []).map(r => `${r.year} ${r.quartile} · ${r.category}`).join('；');
  const columns = [['title','标题'],['author','作者'],['year','年份'],['journal','期刊 / 出处'],['jcr','JCR'],['citekey','引用键'],[null,'DOI'],[null,'单位'],[null,'发表 / 收稿 / 接收'],[null,'类型 / 文件']];
  function create({state,api,loadList,openPaper,selectPaper,changed,tableChanged,toast,el,resource,openMetadataPanel,closeMetadataPanel,persistence}) {
    let table = false, editing = null, revision = 0, readingId = null;
    let editorVisible=false, initialFields=null, initialRankings=null, restoring=false, selectingForEdit=false, loadingEditId=null, drafts=new Map();
    const draftFields=['title','authors','year','citekey','tags','type','journal','doi','url','published','online','print','received','accepted','affiliations'];
    const metadataKeys=['id','title','author','issued','type','citekey','tags','container-title','DOI','URL','publication_dates','journal_rankings'];
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
    for (const id of ['copy-apa','export-bib','download-pdf','metadata-open','attach-open']) $('toolbar-actions').append($(id));
    $('toolbar-actions').append(button('补全资料','metadata-enrich',enrich));
    $('toolbar-actions').append($('export-notes').closest('label'));
    $('toolbar-reader').append(document.querySelector('.page-controls'),$('page-note'));
    $('paper-tools').prepend($('toolbar-reader'));
    document.querySelector('.paper-actions').remove();
    document.querySelector('.reader-toolbar').remove();
    const metadata = node('dl',undefined,'paper-metadata'); metadata.id='paper-metadata'; $('paper-authors').after(metadata);
    const file = node('details',undefined,'paper-file-disclosure'); file.append(node('summary','文件与解析信息'),$('paper-file-meta')); $('paper-tags').after(file);
    const expand=button('展开表格 ⤢','catalog-expand',()=>{const selected=state.active;if(table&&selected&&!selected.archived&&(selected.id!==readingId||(selected.pdf&&!state.pageData))){void openPaper(selected.id);}else setTable(!table);}); expand.setAttribute('aria-expanded','false');expand.setAttribute('aria-label','展开表格');expand.title='展开表格';document.querySelector('.shelf-actions').prepend(expand);
    const controls=node('div',undefined,'catalog-controls');
    const scope=node('select'); scope.id='catalog-scope'; scope.setAttribute('aria-label','文献范围');
    for(const [value,label] of [['active','在库条目'],['archived','回收站']]) { const o=node('option',label);o.value=value;scope.append(o); }
    scope.addEventListener('change',()=>{state.archived=scope.value==='archived';state.offset=0;expand.disabled=state.archived;if(state.archived)setTable(true);void loadList();});
    const sort=node('select');sort.id='catalog-sort';sort.setAttribute('aria-label','文献排序');
    for(const [value,label] of [['modified','最近修改'],['created','最近导入'],...columns.filter(c=>c[0])]) { const o=node('option',label);o.value=value;sort.append(o); }
    sort.addEventListener('change',()=>sortBy(sort.value,state.order));
    const order=button('降序 ↓','catalog-order',()=>sortBy(state.sort,state.order==='asc'?'desc':'asc'));
    const kind=node('select');kind.id='catalog-kind';kind.setAttribute('aria-label','条目类型');for(const [value,label] of [['all','全部类型'],['paper','文献'],['dataset','数据集']]){const option=node('option',label);option.value=value;kind.append(option);}kind.addEventListener('change',()=>{state.kind=kind.value;state.offset=0;void loadList();});
    controls.append(kind,scope,sort,order,button('＋ 文献','catalog-create',()=>edit(null)),button('＋ 数据集','dataset-create',()=>resource()?.edit()));
    document.querySelector('.list-heading').replaceWith(controls);
    // Existing list status ID remains available to the shared paginator.
    const summary=node('span',undefined,'small muted');summary.id='search-summary';controls.after(summary);
    const archive=button('移入回收站','catalog-archive',()=>archivePaper(state.active),'button');
    $('toolbar-actions').append(archive);
    const oldForm=$('metadata-form');
    oldForm.addEventListener('submit',save);
    oldForm.addEventListener('input',dirty);oldForm.addEventListener('change',dirty);
    $('metadata-dialog').addEventListener('close',()=>metadataVisibility(false));
    $('metadata-dialog').querySelector('h2').id='metadata-dialog-title';
    const extra=node('div',undefined,'metadata-extra');
    const fields=[['journal','期刊 / 出处'],['doi','DOI'],['url','论文链接'],['published','发表日期'],['online','在线发表'],['print','印刷发表'],['received','收稿日期'],['accepted','接收日期']];
    for(const [id,label] of fields) { const field=node('label',label,'field');const input=node('input');input.id=`edit-${id}`;if(['published','online','print','received','accepted'].includes(id)){input.placeholder='YYYY 或 YYYY-MM 或 YYYY-MM-DD';input.pattern='[0-9]{4}(-[0-9]{2}(-[0-9]{2})?)?';}field.append(input);extra.append(field); }
    const typeLabel=node('label','文献类型','field');const type=node('select');type.id='edit-type';for(const [v,t] of [['article-journal','期刊论文'],['paper-conference','会议论文'],['book','图书'],['chapter','章节'],['thesis','学位论文'],['report','报告'],['document','文献']]) {const o=node('option',t);o.value=v;type.append(o);}typeLabel.append(type);extra.prepend(typeLabel);
    const affiliationLabel=node('label','作者单位','field full-width');
    const affiliation=node('textarea');affiliation.id='edit-affiliations';affiliation.rows=3;affiliation.placeholder='作者序号 | 单位；另一单位\n1 | University of Example';
    affiliationLabel.append(node('span','每行填写一位作者，序号对应上方作者顺序。留空表示未提供。'),affiliation);extra.append(affiliationLabel);
    const ranks=node('section',undefined,'ranking-editor full-width');ranks.append(node('h3','JCR 分区'),node('p','每条分区需注明报告年份、学科和来源。缺失时留空。','small muted'));const rows=node('div');rows.id='ranking-rows';ranks.append(rows,button('＋ 添加分区','ranking-add',()=>{addRanking();dirty();}));extra.append(ranks);
    $('edit-tags').closest('label').after(extra);
    function addRanking(value={}) {
      const row=node('div',undefined,'ranking-row');
      for(const [key,label] of [['year','报告年份'],['quartile','分区'],['category','学科'],['source','来源 URL 或书目']]) {const labelNode=node('label',label,'field');const input=node(key==='quartile'?'select':'input');input.dataset.rankField=key;input.setAttribute('aria-label',label);if(key==='quartile')for(const v of ['Q1','Q2','Q3','Q4']){const o=node('option',v);o.value=v;input.append(o);} if(key==='year'){input.type='number';input.min='1900';input.max='9999';}input.value=value[key]||'';input.required=true;labelNode.append(input);row.append(labelNode);}
      row.dataset.original=JSON.stringify(value);row.append(button('移除',null,()=>{row.remove();dirty();}));$('ranking-rows').append(row);return row;
    }
    function sortBy(key,dir) {state.sort=key||'modified';state.order=dir||'desc';state.offset=0;sort.value=state.sort;order.textContent=state.order==='asc'?'升序 ↑':'降序 ↓';void loadList();}
    function setTable(value) {if(value&&!table)readingId=state.active?.id;table=value;tableChanged?.(table);document.querySelector('.workspace').classList.toggle('catalog-expanded',table);$('catalog-table').hidden=!table;$('paper-list').hidden=table;expand.textContent=table?'收起表格 ⤡':'展开表格 ⤢';expand.setAttribute('aria-label',table?'收起表格':'展开表格');expand.title=table?'收起表格':'展开表格';expand.setAttribute('aria-expanded',String(table));render();header();}
    function render() {
      hideCellPreview();
      if(!table)return;
      const grid=node('table');grid.setAttribute('aria-label','文献与数据集资料表');const widths=node('colgroup');for(const field of ['title','author','year','journal','jcr','citekey','doi','institution','dates','kind','actions']){const col=node('col');col.className=`catalog-column-${field}`;widths.append(col);}grid.append(widths);const head=node('thead');const headerRow=node('tr');
      for(const [key,label] of columns){const th=node('th');th.scope='col';if(key){th.setAttribute('aria-sort',state.sort===key?(state.order==='asc'?'ascending':'descending'):'none');th.append(button(`${label}${state.sort===key?(state.order==='asc'?' ↑':' ↓'):''}`,null,()=>sortBy(key,state.sort===key&&state.order==='asc'?'desc':'asc')));}else th.textContent=label;headerRow.append(th);}headerRow.append(node('th','操作'));head.append(headerRow);grid.append(head);
      const body=node('tbody');for(const item of state.items){const row=node('tr',undefined,state.active?.id===item.id?'selected':'');row.dataset.paperId=item.id;
        const dates=item.publication_dates||{};const values=[item.title,(item.author||[]).map(name).join(' · '),item.issued?.['date-parts']?.[0]?.[0],item.resource_kind==='dataset'?item.publisher:item['container-title'],ranking(item),item.citekey,item.DOI,institutions(item).join('；'),[dates.published||dates.online||dates.print,dates.received,dates.accepted].map(v=>v||'—').join(' / '),item.resource_kind==='dataset'?'数据集':item.pdf?'PDF':'文献'];
        values.forEach((value,i)=>{const td=node('td'),text=String(value||'—');if(i===0){const b=button(value||'未命名文献',null,()=>{if(item.resource_kind==='dataset'){selectPaper(item);return;}setTable(false);void openPaper(item.id);}, 'table-title');b.setAttribute('aria-pressed',String(state.active?.id===item.id));b.title=b.textContent;td.append(b);}else{const textNode=node('span',text,'table-cell-text');textNode.title=text;td.append(textNode);}row.append(td);});
        const actions=node('td',undefined,'table-row-actions');if(state.archived)actions.append(button('恢复',null,()=>archivePaper(item)));else actions.append(button(item.resource_kind==='dataset'?'浏览':'阅读',null,()=>{setTable(false);void openPaper(item.id);}),button('编辑',null,()=>item.resource_kind==='dataset'?resource()?.edit(item):edit(item)),button('移入回收站',null,()=>archivePaper(item)));row.append(actions);body.append(row);
      }grid.append(body);$('catalog-table').replaceChildren(grid);if(!state.items.length)$('catalog-table').append(node('p',state.archived?'回收站为空。':'没有匹配的文献。','empty-state'));
    }
    function header() {
      const item=state.active;const enabled=Boolean(item&&!item.archived);
      document.querySelectorAll('[data-tab]').forEach(n=>n.disabled=!enabled);
      $('toolbar-paper').textContent=item?item.title:'选择一篇文献';$('toolbar-paper').title=item?.title||'';
      for(const n of $('toolbar-actions').querySelectorAll('button'))n.disabled=!enabled;
      $('download-pdf').hidden=!enabled||!item.pdf;
      $('export-notes').disabled=!enabled||!item.pdf;
      $('toolbar-reader').hidden=!enabled||!item.pdf||table||state.tab!=='reader';
      $('attach-open').hidden=!enabled||Boolean(item.pdf);
      if(!item){metadata.replaceChildren();return;}
      const dates=item.publication_dates||{};const publication=dates.published||dates.online||dates.print;const preprint=String(item.archive||'').toLowerCase()==='arxiv';const pairs=[['单位',institutions(item).join('；')||'未提供'],[!publication&&preprint?'预印本提交':'发表',publication||String(item.issued?.['date-parts']?.[0]?.join('-')||'未提供')],['收稿',dates.received||'未提供'],['接收',dates.accepted||'未提供'],['JCR',ranking(item)||'未提供'],['DOI',item.DOI||'未提供']];
      metadata.replaceChildren();for(const [label,value] of pairs){const d=node('div');const dd=node('dd',value);if(label==='JCR'&&item.journal_rankings?.length)dd.title=item.journal_rankings.map(r=>`${r.year} ${r.category} ${r.quartile} · ${r.source}`).join('\n');d.append(node('dt',label),dd);metadata.append(d);}
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
      const typeValue=item?.type||'article-journal';if(![...type.options].some(o=>o.value===typeValue)){const o=node('option',typeValue);o.value=typeValue;type.append(o);}type.value=typeValue;
      $('edit-journal').value=item?.['container-title']||'';$('edit-doi').value=item?.DOI||'';$('edit-url').value=item?.URL||'';
      for(const k of ['published','online','print','received','accepted'])$(`edit-${k}`).value=item?.publication_dates?.[k]||'';
      $('edit-affiliations').value=(item?.author||[]).map((a,i)=>{const names=(a.affiliation||[]).map(v=>typeof v==='string'?v:v.name).filter(Boolean);return names.length?`${i+1} | ${names.join('；')}`:'';}).filter(Boolean).join('\n');
      editing._affiliationsText=$('edit-affiliations').value;
      editing._authorsText=$('edit-authors').value;editing._yearText=$('edit-year').value;
      $('ranking-rows').replaceChildren();for(const r of item?.journal_rankings||[])addRanking(r);
      initialFields=formFields();initialRankings=formRankings();
      if(saved){
        for(const key of draftFields)if(saved.fields[key]!==undefined&&(!lookup||saved.fields[key]!==saved.initialFields[key]))$(`edit-${key}`).value=saved.fields[key];
        if(!lookup||JSON.stringify(saved.rankings)!==JSON.stringify(saved.initialRankings)){
          $('ranking-rows').replaceChildren();for(const value of saved.rankings){const row=addRanking(value.original);for(const input of row.querySelectorAll('[data-rank-field]'))input.value=value.fields[input.dataset.rankField]??'';}
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
        const journal_rankings=[...$('ranking-rows').children].map(row=>{const original=JSON.parse(row.dataset.original);const r={...original,system:'JCR'};for(const input of row.querySelectorAll('[data-rank-field]'))r[input.dataset.rankField]=input.dataset.rankField==='year'?Number(input.value):input.value.trim();if(['year','quartile','category','source'].some(k=>r[k]!==original[k]))delete r.verified_at;return r;});
        const publication_dates={};for(const k of ['published','online','print','received','accepted']){const v=$(`edit-${k}`).value.trim();if(v)publication_dates[k]=v;}
        const metadata={title:$('edit-title').value.trim(),author,type:type.value,issued:$('edit-year').value===editing._yearText?editing.issued||{}:$('edit-year').value?{'date-parts':[[Number($('edit-year').value)]]}:{},citekey:$('edit-citekey').value.trim(),tags:$('edit-tags').value.split(/[,，]/).map(t=>t.trim()).filter(Boolean),'container-title':$('edit-journal').value.trim(),DOI:$('edit-doi').value.trim(),URL:$('edit-url').value.trim(),publication_dates,journal_rankings};
        const result=await api(editId?'update':'create',{...(editId?{id:editId}:{}),metadata});
        if(JSON.stringify(drafts.get(savedDraftKey))===submittedDraft){drafts.delete(savedDraftKey);persistDraft(savedDraftKey,null);}
        if(editRevision===revision){editing=null;editorVisible=false;if(closeMetadataPanel)closeMetadataPanel();else $('metadata-dialog').close();}changed(result);await loadList();toast('文献资料已保存');
      }catch(e){if(editRevision===revision){$('metadata-error').textContent=e.message;$('metadata-error').hidden=false;}else toast(e.message,true);}finally{if(editRevision===revision)buttons.forEach(b=>b.disabled=false);}
    }
    async function archivePaper(item) {
      if(!item)return;if(item.resource_kind==='dataset')return resource()?.archive(item);const restoring=Boolean(item.archived);
      try{await api(restoring?'restore':'archive',{id:item.id});changed(null,item.id);if(state.items.length===1&&state.offset)state.offset=Math.max(0,state.offset-state.limit);await loadList();toast(restoring?'文献已恢复':'已移入回收站，可在文献范围中恢复；PDF 和批注保留。');}catch(e){toast(e.message,true);}
    }
    async function enrich() {
      const item=state.active;if(!item||!rememberDraft())return;const id=item.id;const token=++revision;$('metadata-enrich').disabled=true;$('metadata-enrich').textContent='正在查找…';
      try{const result=await api('metadata_lookup',{id});if(token!==revision||state.active?.id!==id)return;if(!await edit(result.item,{lookup:true}))return;toast('已将可核验资料填入编辑表单，请核对后保存。');if(result.warnings?.length){$('metadata-error').textContent=result.warnings.join('；');$('metadata-error').hidden=false;}}
      catch(e){toast(e.message,true);}finally{$('metadata-enrich').textContent='补全资料';header();}
    }
    header();return {render,header,edit,setTable,isTable:()=>table,setPanelHost,paperChanged,metadataVisibility};
  }
  return {create,institutions,ranking};
})();
