'use strict';
// 搜索按需启动；PDF 按页读取，侧栏复用各目录的检索，不加载整库。
window.PaperReaderSearch = (() => {
  const normalize = value => String(value || '').normalize('NFKC').replace(/\u00ad/g,'').replace(/(\w)-\s*\n\s*(?=\w)/g,'$1').replace(/\s+/g,' ').toLocaleLowerCase().trim();
  function filterThreads(group, query) {
    const needle=normalize(query);if(!needle)return group;
    const matches=note=>normalize([note.text,note.comment,note.content,note.handwriting?.transcript,note.linked_ink?.transcript].filter(Boolean).join(' ')).includes(needle);
    const related=note=>matches(note)||(group.replies.get(note.id)||[]).some(matches);
    return {...group,notes:group.notes.filter(note=>related(note)||(group.remarks?.get(note.id)||[]).some(related)),unlinked:group.unlinked.filter(matches)};
  }
  function create({api,getPaper,reader,navigate,getElements,onAnnotationSearch,onLibrarySearch}) {
    const $=id=>document.getElementById(id), make=(tag,text)=>{const e=document.createElement(tag);if(text)e.textContent=text;return e;};
    const button=(text,label,fn)=>{const e=make('button',text);e.type='button';e.className='button subtle';e.setAttribute('aria-label',label);e.title=label;e.addEventListener('click',fn);return e;};
    const magnify=()=>{const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('width','16');svg.setAttribute('height','16');svg.setAttribute('aria-hidden','true');svg.innerHTML='<circle cx="10" cy="10" r="6" fill="none" stroke="currentColor" stroke-width="2"/><path d="m15 15 6 6" stroke="currentColor" stroke-width="2"/>';return svg;};
    let paperId=null,scope='library',expanded=false,disposed=false,ticket=0,busy=false,hits=[],index=-1,cursor=null,scanned=0,total=0,noText=0,searchQuery='';
    const queries=new Map(),labels={library:'文献库',annotations:'批注', 'elements-formula':'公式','elements-figure':'图片','elements-table':'表格','elements-algorithm':'算法'};
    const rail=document.querySelector('.shared-reading-sidebar'),header=rail?.querySelector('.reading-sidebar-header');
    const scopeToggle=button('','搜索当前侧栏',()=>{expanded=!expanded;sync();if(expanded)scopeInput.focus();});scopeToggle.id='sidebar-search-toggle';scopeToggle.append(magnify());scopeToggle.setAttribute('aria-controls','sidebar-search-row');
    const scopeForm=make('form');scopeForm.id='sidebar-search-row';scopeForm.className='reader-search-row';scopeForm.hidden=true;
    const scopeInput=make('input');scopeInput.type='search';scopeInput.maxLength=200;
    const scopeSubmit=make('button','搜索');scopeSubmit.type='submit';scopeSubmit.className='button subtle';
    const clearScope=button('×','清除当前侧栏搜索',()=>{scopeInput.value='';submitScope();scopeInput.focus();});scopeForm.append(scopeInput,scopeSubmit,clearScope);
    if(header){header.insertBefore(scopeToggle,$('reading-sidebar-side'));header.after(scopeForm);}
    function submitScope(){queries.set(scope,scopeInput.value.trim());if(scope==='annotations')onAnnotationSearch(scopeInput.value.trim());else if(scope==='library')onLibrarySearch(scopeInput.value.trim());else getElements()?.search(scope.replace('elements-',''),scopeInput.value.trim());}
    scopeForm.addEventListener('submit',event=>{event.preventDefault();submitScope();});
    scopeInput.addEventListener('input',()=>{if(!scopeInput.value)submitScope();});
    scopeInput.addEventListener('keydown',event=>{if(event.key==='Escape'){expanded=false;sync();scopeToggle.focus();}});

    const pdfToggle=button('文内搜索','搜索当前 PDF（⌘/Ctrl F）',()=>showPDF());pdfToggle.id='reader-find';pdfToggle.prepend(magnify());pdfToggle.setAttribute('aria-controls','pdf-search-row');
    $('toolbar-reader')?.append(pdfToggle);
    const pdfForm=make('form');pdfForm.id='pdf-search-row';pdfForm.className='reader-search-row pdf-search-row';pdfForm.hidden=true;
    const input=make('input');input.type='search';input.placeholder='搜索当前 PDF 文字';input.setAttribute('aria-label','搜索当前 PDF 文字');input.maxLength=200;
    const submit=make('button','搜索');submit.type='submit';submit.className='button subtle';
    const previous=button('‹','上一个匹配位置',()=>move(-1)),next=button('›','下一个匹配位置',()=>move(1));
    const more=button('继续','继续搜索后续位置',()=>{if(cursor&&!busy){hits=[];index=-1;void run();}});
    const stop=button('停止','停止 PDF 搜索',()=>{++ticket;busy=false;update();});
    const close=button('×','关闭 PDF 搜索',()=>{++ticket;busy=false;pdfForm.hidden=true;document.body.classList.remove('pdf-search-open');pdfToggle.setAttribute('aria-expanded','false');pdfToggle.focus();});
    const status=make('span');status.className='small';status.setAttribute('role','status');status.setAttribute('aria-live','polite');
    pdfForm.append(input,submit,previous,next,more,stop,status,close);$('paper-tools')?.after(pdfForm);
    function update(){previous.disabled=!hits.length;next.disabled=!hits.length;more.hidden=busy||!cursor;stop.hidden=!busy;status.textContent=`${hits.length?index+1:0} / ${hits.length} 个位置${cursor?'（本批）':''} · ${busy?'搜索中 · ':''}${scanned} / ${total} 页${noText?' · '+noText+' 页无可选文字':''}`;}
    async function reveal(){const hit=hits[index],id=paperId;if(!hit)return;try{await navigate();if(!disposed&&getPaper()?.id===id&&hits[index]===hit)await reader()?.revealRegion({paperId:id,page:hit.page,rects:hit.rects,focusId:'pdf-search'});}catch(error){if(!disposed&&getPaper()?.id===id&&hits[index]===hit)status.textContent='定位未完成：'+error.message;}}
    function move(delta){if(!hits.length)return;index=(index+delta+hits.length)%hits.length;update();void reveal();}
    async function run(){const runId=++ticket,id=paperId;busy=true;update();
      try{while(cursor&&hits.length<200){
        const result=await api('paper_text_find',{id,query:searchQuery,page:cursor.page,offset:cursor.offset,limit:Math.min(40,200-hits.length)});
        if(disposed||runId!==ticket||getPaper()?.id!==id)return;
        total=result.page_count;hits.push(...result.matches);
        if(result.next_offset!=null)cursor={page:result.page,offset:result.next_offset};else{scanned=result.page;if(result.no_extractable_text)noText++;cursor=result.next_page?{page:result.next_page,offset:0}:null;}
        if(index<0&&hits.length){index=0;void reveal();}update();
        if(cursor&&hits.length<200)await new Promise(resolve=>setTimeout(resolve,60));
        if(disposed||runId!==ticket||getPaper()?.id!==id)return;
      }}catch(error){if(runId===ticket){busy=false;update();status.textContent='搜索未完成：'+error.message;return;}}
      finally{if(runId===ticket){busy=false;stop.hidden=true;more.hidden=!cursor;}}
      if(runId===ticket)update();
    }
    function start(){++ticket;busy=false;hits=[];index=-1;scanned=0;total=0;noText=0;searchQuery=input.value.trim();cursor=searchQuery?{page:1,offset:0}:null;update();if(cursor)void run();}
    pdfForm.addEventListener('submit',event=>{event.preventDefault();start();});
    input.addEventListener('input',()=>{++ticket;busy=false;cursor=null;hits=[];index=-1;update();status.textContent=input.value?'按 Enter 搜索':'输入要查找的文字';});
    input.addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();close.click();}else if(event.key==='Enter'&&searchQuery===input.value.trim()&&hits.length){event.preventDefault();move(event.shiftKey?-1:1);}});
    function showPDF(){sync();if(pdfToggle.disabled)return;pdfForm.hidden=false;document.body.classList.add('pdf-search-open');pdfToggle.setAttribute('aria-expanded','true');input.focus();input.select();}
    const keydown=event=>{if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='f'&&!event.altKey&&!event.target.closest('input,textarea,[contenteditable=true]')&&!document.querySelector('dialog[open]')){sync();if(!pdfToggle.disabled){event.preventDefault();showPDF();}}};document.addEventListener('keydown',keydown);
    function sync(){const paper=getPaper(),id=paper?.id||null;if(id!==paperId){paperId=id;++ticket;busy=false;hits=[];index=-1;cursor=null;input.value='';pdfForm.hidden=true;queries.clear();scopeInput.value='';onAnnotationSearch('');update();}
      pdfToggle.disabled=!paper?.pdf||Boolean($('toolbar-reader')?.hidden);if(pdfToggle.disabled&&!pdfForm.hidden){++ticket;busy=false;pdfForm.hidden=true;}document.body.classList.toggle('pdf-search-open',!pdfForm.hidden);pdfToggle.setAttribute('aria-expanded',String(!pdfForm.hidden));
      const nextScope=rail?.dataset.sidebarPanel||'library';if(nextScope!==scope){scope=nextScope;scopeInput.value=queries.get(scope)||'';}
      const supported=Boolean(labels[scope]);scopeToggle.hidden=!supported;scopeToggle.setAttribute('aria-expanded',String(expanded));scopeToggle.classList.toggle('active',Boolean(queries.get(scope)));scopeForm.hidden=!expanded||!supported||Boolean(header?.hidden);
      scopeInput.placeholder=`搜索${labels[scope]||''}${scope==='annotations'?'原文、备注与回复':''}`;scopeInput.setAttribute('aria-label',scopeInput.placeholder);
    }
    sync();return {sync,filter:group=>filterThreads(group,queries.get('annotations')),dispose(){disposed=true;++ticket;document.removeEventListener('keydown',keydown);document.body.classList.remove('pdf-search-open');scopeToggle.remove();scopeForm.remove();pdfToggle.remove();pdfForm.remove();}};
  }
  return {create,filterThreads};
})();
