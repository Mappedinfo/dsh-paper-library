'use strict';
// 搜索按需启动；PDF 按页读取，侧栏复用各目录的检索，不加载整库。
window.PaperReaderSearch = (() => {
  const normalize = value => String(value || '').normalize('NFKC').replace(/\u00ad/g,'').replace(/(\w)-\s*\n\s*(?=\w)/g,'$1').replace(/\s+/g,' ').toLocaleLowerCase().trim();
  // AI 阅读仅按后端从 PDF 原生颜色与虚线读回的布尔值筛选，与回复等来源分类独立。
  function annotationSource(note) {
    if(note.source_kind==='annotation-translation')return 'translation';
    if(note.source_kind==='annotation-caption')return 'caption';
    if(note.kind==='ai-feedback'||note.type==='ai_feedback'||note.ai_generated===true)return 'reply';
    return 'other';
  }
  function filterThreads(group, query, {source='all',match='all'}={}) {
    const terms=[...new Set(normalize(query).split(/[\s,，;；]+/).filter(Boolean))];
    if(!terms.length&&source==='all')return group;
    const text=note=>[note.text,note.comment,note.content,note.author,note.subject,note.model,note.handwriting?.transcript,note.linked_ink?.transcript,
      ...(note.tags||[]).map(tag=>`#${tag}`)].filter(Boolean).join(' ');
    const matches=entries=>{
      const selected=source==='all'?entries:entries.filter(note=>source==='reading'?note.ai_reading_style===true:annotationSource(note)===source);
      if(!selected.length)return false;
      const haystack=normalize(selected.map(text).join(' '));
      return !terms.length||(match==='any'?terms.some(term=>haystack.includes(term)):terms.every(term=>haystack.includes(term)));
    };
    const related=note=>[note,...(group.replies.get(note.id)||[])];
    return {...group,notes:group.notes.filter(note=>matches([...related(note),...(group.remarks?.get(note.id)||[]).flatMap(related)])),unlinked:group.unlinked.filter(note=>matches([note]))};
  }
  function create({api,getPaper,reader,navigate,panels,getElements,onAnnotationSearch,onAnnotationNavigate,onLibrarySearch}) {
    const $=id=>document.getElementById(id), make=(tag,text)=>{const e=document.createElement(tag);if(text)e.textContent=text;return e;};
    const button=(text,label,fn)=>{const e=make('button',text);e.type='button';e.className='button subtle';e.setAttribute('aria-label',label);e.title=label;e.addEventListener('click',fn);return e;};
    const magnify=()=>{const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('width','16');svg.setAttribute('height','16');svg.setAttribute('aria-hidden','true');svg.innerHTML='<circle cx="10" cy="10" r="6" fill="none" stroke="currentColor" stroke-width="2"/><path d="m15 15 6 6" stroke="currentColor" stroke-width="2"/>';return svg;};
    let paperId=null,scope='library',expanded=false,disposed=false,ticket=0,busy=false,hits=[],index=-1,cursor=null,scanned=0,total=0,noText=0,searchQuery='';
    let annotationSourceFilter='all',annotationMatch='all',annotationMatches=[],annotationIndex=-1;
    const queries=new Map(),labels={library:'文献库',annotations:'批注', 'elements-formula':'公式','elements-figure':'图片','elements-table':'表格','elements-algorithm':'算法'};
    const rail=document.querySelector('.shared-reading-sidebar'),header=rail?.querySelector('.reading-sidebar-header');
    const scopeToggle=button('','搜索当前侧栏',()=>{expanded=!expanded;sync();if(expanded)scopeInput.focus();});scopeToggle.id='sidebar-search-toggle';scopeToggle.append(magnify());scopeToggle.setAttribute('aria-controls','sidebar-search-row');
    const scopeForm=make('form');scopeForm.id='sidebar-search-row';scopeForm.className='reader-search-row';scopeForm.hidden=true;
    const scopeInput=make('input');scopeInput.type='search';scopeInput.maxLength=200;
    const scopeSubmit=make('button','搜索');scopeSubmit.type='submit';scopeSubmit.className='button subtle';
    const closeScope=button('×','关闭侧栏搜索并清除筛选',()=>{
      expanded=false;
      scopeInput.value='';
      if(scope==='annotations'){annotationSourceFilter='all';annotationMatch='all';}
      submitScope();
      scopeToggle.focus();
    });
    scopeForm.append(scopeInput,scopeSubmit,closeScope);
    const annotationOptions=make('span');annotationOptions.className='annotation-search-options';
    const sourceSelect=make('select');sourceSelect.id='annotation-search-source';sourceSelect.setAttribute('aria-label','批注来源');
    for(const [value,label] of [['all','全部批注'],['reading','AI 阅读（蓝色虚线）'],['reply','AI 回复'],['translation','AI 翻译'],['caption','AI 图像说明']]){const option=make('option',label);option.value=value;sourceSelect.append(option);}
    sourceSelect.title='AI 阅读按 PDF 原生蓝色（#2F80ED）与真实虚线同时匹配（新建为 3、2 pt），不看作者或文字；人工使用相同样式也会命中。旧批注不自动改写，关键词可另选。';
    const matchSelect=make('select');matchSelect.id='annotation-search-match';matchSelect.setAttribute('aria-label','多关键词匹配方式');
    for(const [value,label] of [['all','全部关键词'],['any','任一关键词']]){const option=make('option',label);option.value=value;matchSelect.append(option);}
    matchSelect.title='多个关键词用空格、逗号或分号分隔';annotationOptions.append(sourceSelect,matchSelect);scopeForm.append(annotationOptions);
    sourceSelect.addEventListener('change',()=>{annotationSourceFilter=sourceSelect.value;submitScope();});
    matchSelect.addEventListener('change',()=>{annotationMatch=matchSelect.value;submitScope();});
    const annotationNav=make('span');annotationNav.className='annotation-search-options';
    const annotationPrevious=button('↑','上一个搜索批注',()=>moveAnnotation(-1)),annotationNext=button('↓','下一个搜索批注',()=>moveAnnotation(1));
    const annotationCount=make('span');annotationCount.className='small';annotationCount.setAttribute('role','status');
    annotationNav.append(annotationPrevious,annotationCount,annotationNext);scopeForm.append(annotationNav);
    function updateAnnotationNav(){
      annotationNav.hidden=scope!=='annotations'||(!queries.get('annotations')&&annotationSourceFilter==='all');
      annotationPrevious.disabled=annotationNext.disabled=!annotationMatches.length;
      annotationCount.textContent=`${annotationIndex<0?0:annotationIndex+1} / ${annotationMatches.length} 条`;
    }
    function moveAnnotation(delta){
      if(!annotationMatches.length)return;
      annotationIndex=annotationIndex<0?(delta>0?0:annotationMatches.length-1):(annotationIndex+delta+annotationMatches.length)%annotationMatches.length;
      updateAnnotationNav();onAnnotationNavigate?.(annotationMatches[annotationIndex]);
    }
    if(header){header.insertBefore(scopeToggle,$('reading-sidebar-side'));header.after(scopeForm);}
    function submitScope(){annotationIndex=-1;annotationMatches=[];queries.set(scope,scopeInput.value.trim());if(scope==='annotations')onAnnotationSearch(scopeInput.value.trim());else if(scope==='library')onLibrarySearch(scopeInput.value.trim());else getElements()?.search(scope.replace('elements-',''),scopeInput.value.trim());sync();}
    scopeForm.addEventListener('submit',event=>{event.preventDefault();submitScope();});
    scopeInput.addEventListener('input',()=>{if(!scopeInput.value)submitScope();});
    scopeInput.addEventListener('keydown',event=>{if(event.key==='Escape'){expanded=false;sync();scopeToggle.focus();}});

    const pdfToggle=button('文内搜索','搜索当前 PDF（⌘/Ctrl F）',()=>pdfForm.hidden?showPDF():hidePDF());pdfToggle.id='reader-find';pdfToggle.prepend(magnify());pdfToggle.setAttribute('aria-controls','pdf-search-row');
    $('toolbar-reader')?.append(pdfToggle);
    const pdfForm=make('form');pdfForm.id='pdf-search-row';pdfForm.className='reader-search-row pdf-search-row';pdfForm.hidden=true;
    const input=make('input');input.type='search';input.placeholder='搜索当前 PDF 文字';input.setAttribute('aria-label','搜索当前 PDF 文字');input.maxLength=200;
    const submit=make('button','搜索');submit.type='submit';submit.className='button subtle';
    function searchSwitch(label, offLabel = label) {
      const control = button(offLabel, label, () => {
        const enabled = control.getAttribute('aria-checked') !== 'true';
        control.setAttribute('aria-checked', String(enabled));
        control.textContent = enabled ? label : offLabel;
        if (input.value.trim()) start();
      });
      control.classList.add('paper-switch');
      control.setAttribute('role', 'switch');
      control.setAttribute('aria-checked', 'false');
      return control;
    }
    const match = searchSwitch('完整词匹配', '部分匹配');
    const matchCase = searchSwitch('区分大小写');
    let searchMatch='partial',searchCase=false;
    const previous=button('‹','上一个匹配位置',()=>move(-1)),next=button('›','下一个匹配位置',()=>move(1));
    const continueSearch=()=>{if(cursor&&!busy){replaceHits();void run();}};
    let searchRequest=null, sourceVersion;
    function cancelSearch(){++ticket;searchRequest?.abort();searchRequest=null;busy=false;}
    const stopSearch=()=>{cancelSearch();update();};
    const more=button('继续','继续搜索后续位置',continueSearch);
    const stop=button('停止','停止 PDF 搜索',stopSearch);
    const close=button('×','关闭 PDF 搜索',hidePDF);
    const status=make('span');status.className='small';status.setAttribute('role','status');status.setAttribute('aria-live','polite');
    pdfForm.append(input,match,matchCase,submit,previous,next,more,stop,status,close);$('paper-tools')?.after(pdfForm);
    const resultsPanel=make('section');resultsPanel.id='pdf-search-panel';resultsPanel.className='pdf-search-panel';resultsPanel.hidden=true;
    const resultsForm=make('form');resultsForm.className='reader-search-row';
    const resultsInput=make('input');resultsInput.type='search';resultsInput.placeholder=input.placeholder;resultsInput.maxLength=input.maxLength;
    resultsInput.setAttribute('aria-label','在侧栏搜索当前 PDF 文字');
    const resultsSubmit=make('button','搜索');resultsSubmit.type='submit';resultsSubmit.className='button subtle';resultsForm.append(resultsInput,resultsSubmit);
    const resultsActions=make('div');resultsActions.className='pdf-search-actions';
    const resultsStatus=make('span');resultsStatus.setAttribute('role','status');
    const resultsPrevious=button('↑','上一个匹配位置（侧栏）',()=>move(-1));
    const resultsNext=button('↓','下一个匹配位置（侧栏）',()=>move(1));
    const resultsMore=button('继续','继续搜索后续位置（侧栏）',continueSearch);
    const resultsStop=button('停止','停止 PDF 搜索（侧栏）',stopSearch);
    resultsActions.append(resultsStatus,resultsPrevious,resultsNext,resultsMore,resultsStop);
    const resultsList=make('ol');resultsList.className='pdf-search-results';
    resultsPanel.append(resultsForm,resultsActions,resultsList);
    panels?.registerPanel({id:'pdf-search',label:'文内搜索',element:resultsPanel,reading:true});
    let activeResult, searchMessage='', precedingSection=null;
    function replaceHits(){hits=[];index=-1;activeResult=null;resultsList.replaceChildren();}
    function update(){
      previous.disabled=next.disabled=resultsPrevious.disabled=resultsNext.disabled=!hits.length;
      more.hidden=resultsMore.hidden=busy||!cursor;
      stop.hidden=resultsStop.hidden=!busy;
      const progress=`${hits.length?index+1:0} / ${hits.length} 个位置${cursor?'（本批）':''} · ${busy?'搜索中 · ':''}${scanned} / ${total} 页${noText?' · '+noText+' 页无可选文字':''}`;
      status.textContent=searchMessage||progress;
      resultsStatus.textContent=searchMessage||(!getPaper()?.pdf?'当前文献没有 PDF。':!searchQuery?'输入文字，查找当前 PDF。':!busy&&!hits.length&&!cursor?`未找到匹配位置 · ${progress}`:progress);
      resultsInput.disabled=resultsSubmit.disabled=!getPaper()?.pdf;
      for(let position=resultsList.children.length;position<hits.length;position++){
        const {page,snippet,section}=hits[position];
        const location=`第 ${page} 页${section ? ` · ${section.title}` : ''}`;
        const row=make('li'), control=button('',`${location}，匹配位置 ${position+1}`,()=>selectHit(position));
        const metadata=make('span',location);metadata.className='pdf-search-result-location';
        control.append(metadata,make('span',snippet||searchQuery));
        row.append(control);resultsList.append(row);
      }
      const selected=resultsList.children[index]?.firstElementChild;
      if(selected!==activeResult){
        activeResult?.removeAttribute('aria-current');
        selected?.setAttribute('aria-current','true');
        if(!resultsPanel.hidden)selected?.scrollIntoView?.({block:'nearest'});
        activeResult=selected;
      }
    }
    async function reveal(){const hit=hits[index],id=paperId,runId=ticket;if(!hit)return;try{await navigate();if(!disposed&&runId===ticket&&getPaper()?.id===id&&hits[index]===hit)await reader()?.revealRegion({paperId:id,page:hit.page,rects:hit.rects,focusId:'pdf-search'});}catch(error){if(!disposed&&runId===ticket&&getPaper()?.id===id&&hits[index]===hit){searchMessage='定位未完成：'+error.message;update();}}}
    function selectHit(position){index=position;searchMessage='';update();void reveal();}
    function move(delta){if(hits.length)selectHit((index+delta+hits.length)%hits.length);}
    async function run(){
      const runId=++ticket,id=paperId,controller=new AbortController();
      searchRequest=controller;busy=true;searchMessage='';update();
      try{
        while(cursor&&hits.length<200){
          const response=await api('paper_text_find',{
            id,query:searchQuery,match:searchMatch,case_sensitive:searchCase,page:cursor.page,offset:cursor.offset,
            page_limit:16,limit:Math.min(40,200-hits.length),include_sections:true,expected_version:sourceVersion,
          },{signal:controller.signal});
          if(disposed||runId!==ticket||getPaper()?.id!==id)return;
          sourceVersion=response.source_version;
          total=response.page_count;
          for(const result of response.page_results ?? [response]){
            const context=result.section_context;
            if(context?.before?.page>(precedingSection?.page||0))precedingSection=context.before;
            hits.push(...result.matches.map(hit=>Object.hasOwn(hit,'section')?{...hit,section:hit.section||precedingSection}:hit));
            if(result.next_offset!=null)cursor={page:result.page,offset:result.next_offset};
            else{
              precedingSection=context?.last||precedingSection;
              scanned=result.page;if(result.no_extractable_text)noText++;cursor=result.next_page?{page:result.next_page,offset:0}:null;
            }
          }
          if(index<0&&hits.length){index=0;void reveal();}update();
        }
      }catch(error){
        if(runId!==ticket)return;
        if(error.message.includes('PAPER_RETRIEVAL_CHANGED')){
          replaceHits();cursor=null;scanned=total=noText=0;
          searchMessage='PDF 已更新，请重新搜索。';
        }else searchMessage='搜索未完成：'+error.message;
      }finally{
        if(runId===ticket){searchRequest=null;busy=false;update();}
      }
    }
    function start(){
      if(!getPaper()?.pdf)return;
      cancelSearch();replaceHits();scanned=0;total=0;noText=0;searchMessage='';precedingSection=null;sourceVersion=undefined;
      resultsInput.value=input.value;searchQuery=input.value.trim();
      searchMatch=match.getAttribute('aria-checked')==='true'?'whole':'partial';searchCase=matchCase.getAttribute('aria-checked')==='true';
      cursor=searchQuery?{page:1,offset:0}:null;
      if(cursor){if(!panels?.visible('pdf-search'))panels?.show('pdf-search');void run();}else update();
    }
    pdfForm.addEventListener('submit',event=>{event.preventDefault();start();});
    resultsForm.addEventListener('submit',event=>{event.preventDefault();input.value=resultsInput.value;start();});
    for(const [field,other] of [[input,resultsInput],[resultsInput,input]])field.addEventListener('input',()=>{
      other.value=field.value;cancelSearch();cursor=null;replaceHits();searchQuery='';precedingSection=null;scanned=total=noText=0;
      searchMessage=field.value?'按 Enter 搜索':'';update();
    });
    input.addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();close.click();}else if(event.key==='Enter'&&searchQuery===input.value.trim()&&hits.length){event.preventDefault();move(event.shiftKey?-1:1);}});
    function hidePDF(){if(!panels)cancelSearch();pdfForm.hidden=true;document.body.classList.remove('pdf-search-open');pdfToggle.setAttribute('aria-expanded','false');update();pdfToggle.focus();}
    function showPDF(){sync();if(pdfToggle.disabled)return;pdfForm.hidden=false;document.body.classList.add('pdf-search-open');pdfToggle.setAttribute('aria-expanded','true');input.focus();input.select();}
    const keydown=event=>{if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='f'&&!event.altKey&&!event.target.closest('input,textarea,[contenteditable=true]')&&!document.querySelector('dialog[open]')){sync();if(!pdfToggle.disabled){event.preventDefault();showPDF();}}};document.addEventListener('keydown',keydown);
    function sync(){const paper=getPaper(),id=paper?.id||null;if(id!==paperId){paperId=id;cancelSearch();replaceHits();cursor=null;input.value=resultsInput.value='';searchMessage=searchQuery='';precedingSection=null;scanned=total=noText=0;pdfForm.hidden=true;queries.clear();annotationSourceFilter='all';annotationMatch='all';annotationMatches=[];annotationIndex=-1;scopeInput.value='';onAnnotationSearch('');}
      pdfToggle.disabled=!paper?.pdf||Boolean($('toolbar-reader')?.hidden);if(pdfToggle.disabled)pdfForm.hidden=true;document.body.classList.toggle('pdf-search-open',!pdfForm.hidden);pdfToggle.setAttribute('aria-expanded',String(!pdfForm.hidden));
      const nextScope=rail?.dataset.sidebarPanel||'library';if(nextScope!==scope){scope=nextScope;scopeInput.value=queries.get(scope)||'';}
      const supported=Boolean(labels[scope]);scopeToggle.hidden=!supported;scopeToggle.setAttribute('aria-expanded',String(expanded));scopeToggle.classList.toggle('active',Boolean(queries.get(scope))||(scope==='annotations'&&annotationSourceFilter!=='all'));scopeForm.hidden=!expanded||!supported||Boolean(header?.hidden);
      updateAnnotationNav();annotationOptions.hidden=scope!=='annotations';sourceSelect.value=annotationSourceFilter;matchSelect.value=annotationMatch;
      scopeInput.placeholder=`搜索${labels[scope]||''}${scope==='annotations'?'原文、备注、回复和标签':''}`;scopeInput.setAttribute('aria-label',scopeInput.placeholder);
      update();
    }
    sync();return {sync,showPDF,clearAnnotationFilter(){queries.delete('annotations');annotationSourceFilter='all';annotationMatch='all';if(scope==='annotations')scopeInput.value='';sync();},filter:group=>{const result=filterThreads(group,queries.get('annotations'),{source:annotationSourceFilter,match:annotationMatch});const selected=annotationMatches[annotationIndex]?.id;annotationMatches=[...result.notes.map((note,index)=>({id:note.id,offset:Math.floor(index/40)*40})),...result.unlinked.map(note=>({id:note.id,offset:0}))];annotationIndex=selected?annotationMatches.findIndex(note=>note.id===selected):-1;updateAnnotationNav();return result;},dispose(){disposed=true;cancelSearch();document.removeEventListener('keydown',keydown);document.body.classList.remove('pdf-search-open');scopeToggle.remove();scopeForm.remove();pdfToggle.remove();pdfForm.remove();}};
  }
  return {create,filterThreads};
})();
