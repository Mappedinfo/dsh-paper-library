'use strict';
// 每条原生 PDF 批注独立编辑；草稿先存本地服务，保存成功后再清除。
window.PaperAnnotationEditor = { create({api,persistence,getPaper,getNotes,show,refresh,changed,toast,captionAvailable=()=>false}) {
  const papers=new Map(), delay=650;
  const captions=window.PaperAnnotationCaptions?.create({api,getPaper,getNotes,available:captionAvailable,saved:refresh});
  const previews=window.PaperAnnotationPreviews?.create({api,getPaper,onPreview:(box,note,result)=>captions?.decorate(box,note,result?.source_version)});
  // 仅窗口标识放在 sessionStorage；草稿正文仍保存到本地服务。
  // 不同窗口编辑同篇论文时，不争抢一个整篇草稿记录。
  let client=crypto.randomUUID();
  try{const saved=sessionStorage.getItem('paper-annotation-client');if(/^[a-f0-9-]{36}$/.test(saved||''))client=saved;else sessionStorage.setItem('paper-annotation-client',client);}catch{toast('窗口草稿标识暂不可保存，请在关闭前确认批注已写入 PDF。',true);}
  const key=id=>`annotation-edits:${id}:${client}`;
  const node=(tag,cls,text)=>{const n=document.createElement(tag);n.className=cls;if(text!==undefined)n.textContent=text;return n;};
  const clone=value=>JSON.parse(JSON.stringify(value));
  function paper(id) { if(!papers.has(id))papers.set(id,{id,rows:new Map(),loaded:false,loading:null});return papers.get(id); }
  function row(id,note,payload=null) {
    const p=paper(id);if(p.rows.has(note.id))return p.rows.get(note.id);
    const value={id,paper:p,note:clone(note),comment:note.comment||note.content||'',saved:note.comment||note.content||'',payload,revision:0,error:null,running:null,timer:null};
    p.rows.set(note.id,value);return value;
  }
  function dirty(r){return Boolean(r.payload)||r.comment!==r.saved;}
  async function load(id) {
    const p=paper(id);if(p.loaded)return p;if(p.loading)return p.loading;
    p.loading=(async()=>{
      const value=await persistence?.get(key(id));
      for(const draft of value?.drafts||[]) {
        if(!draft?.note?.id)continue;
        const current=p.rows.get(draft.note.id);if(current&&(dirty(current)||current.revision))continue;
        const r=row(id,draft.note,draft.payload||null);r.note=clone(draft.note);r.comment=draft.comment;r.saved=draft.saved;r.payload=draft.payload||null;r.conflict=Boolean(draft.conflict);if(r.ui)r.ui.input.value=r.comment;r.error='未保存草稿已恢复，请核对后重试保存。';
      }
      p.loaded=true;return p;
    })().finally(()=>{p.loading=null;});return p.loading;
  }
  function checkpoint(p) {
    const drafts=[...p.rows.values()].filter(dirty).map(r=>({note:r.note,comment:r.comment,saved:r.saved,payload:r.payload,conflict:r.conflict||false}));
    return persistence?.put(key(p.id),{drafts});
  }
  function paint(r) {
    if(!r.ui)return;
    const {status,retry,input,compare}=r.ui;
    status.textContent=r.error?`${dirty(r)?'未保存':'PDF 已保存，草稿同步未完成'}：${r.error}`:r.running?'保存中…':dirty(r)?'等待自动保存…':'已保存';
    status.classList.toggle('error',Boolean(r.error));retry.hidden=!r.error;retry.disabled=Boolean(r.running);compare.hidden=!r.error||Boolean(r.payload);compare.disabled=Boolean(r.running);
    const card=input.closest('.annotation-remark, .annotation-card');if(card){card.dataset.companionText=String(Boolean((r.note.text||'').trim()||r.comment.trim()||r.note.handwriting?.transcript||r.note.linked_ink?.transcript));if(r.note.version)card.dataset.annotationVersion=r.note.version;}
  }
  function schedule(r) {
    clearTimeout(r.timer);r.timer=setTimeout(()=>{r.timer=null;void save(r);},delay);
  }
  function editor(r) {
    if(r.ui)return r.ui.root;
    const root=node('div','annotation-inline-editor'),label=node('label','field','备注或问题'),input=node('textarea','annotation-inline-input');
    input.rows=3;input.maxLength=16000;input.value=r.comment;input.placeholder=r.note.text?'自动保存；可直接写下问题，再点「问 DSH」。':'自动保存；请描述图片细节或写下问题，再点「问 DSH」。';
    input.setAttribute('aria-label',`第 ${r.note.page} 页批注的备注或问题`);label.append(input);
    const footer=node('div','annotation-inline-status'),status=node('span','small muted'),retry=node('button','button subtle','重试保存');retry.type='button';status.setAttribute('role','status');
    retry.addEventListener('click',()=>void save(r));
    const compare=node('button','button subtle','核对 PDF 备注');compare.type='button';
    compare.addEventListener('click',async()=>{
      compare.disabled=true;
      try{
        const result=await api('annotations',{id:r.id}),latest=result.annotations.find(n=>n.id===r.note.id);
        if(!latest)throw Error('PDF 中未找到这条批注，当前草稿仍保留。');
        root.querySelector('.annotation-conflict')?.remove();
        const box=node('div','annotation-conflict'),text=node('p','small',`PDF 当前备注：${latest.comment||latest.content||'（空）'}`);
        const adopt=node('button','button subtle','采用 PDF 备注'),replace=node('button','button subtle','用我的备注保存');adopt.type=replace.type='button';
        adopt.addEventListener('click',async()=>{r.note=clone(latest);r.comment=r.saved=latest.comment||latest.content||'';r.conflict=false;r.error=null;input.value=r.comment;box.remove();try{await checkpoint(r.paper);}catch(e){r.error=e.message;}paint(r);changed?.();});
        replace.addEventListener('click',()=>{r.note=clone(latest);r.conflict=false;r.error=null;box.remove();void save(r);});
        box.append(text,adopt,replace);root.append(box);
      }catch(error){toast(error.message,true);}finally{compare.disabled=false;}
    });
    let composing=false;
    input.addEventListener('compositionstart',()=>{composing=true;clearTimeout(r.timer);});
    input.addEventListener('compositionend',()=>{composing=false;update();});
    function update(){r.comment=input.value;const revision=++r.revision;r.error=null;paint(r);changed?.();void load(r.id).then(()=>checkpoint(r.paper)).catch(error=>{if(r.revision===revision){r.error=error.message;paint(r);}});if(!composing)schedule(r);}
    input.addEventListener('input',update);
    input.addEventListener('blur',()=>{if(!composing&&dirty(r))void save(r);});
    footer.append(status,retry,compare);root.append(label,footer);r.ui={root,input,status,retry,compare};paint(r);return root;
  }
  async function save(r) {
    clearTimeout(r.timer);r.timer=null;
    if(r.running){await r.running;return r.error?false:dirty(r)?save(r):true;}
    if(!dirty(r)){if(r.error){try{await checkpoint(r.paper);r.error=null;}catch(error){r.error=error.message;paint(r);return false;}}paint(r);return true;}
    if(r.conflict){paint(r);return false;}
    r.error=null;
    r.running=(async()=>{
      try {
        await load(r.id);
        // Keep the immutable create request until its response is known. Text
        // typed during creation is applied afterwards as a separate update.
        while(dirty(r)) {
          await checkpoint(r.paper);
          const creating=Boolean(r.payload),comment=creating?r.payload.comment:r.comment;
          if(!creating&&!r.note.edit_version&&!r.note.version)throw Error('缺少批注版本，请核对 PDF 最新备注后再保存。');
          const result=creating?await api(r.payload.reply_id?'annotation_reply_create':'annotate',r.payload):await api('annotation_update',{id:r.id,annotation_id:r.note.id,comment,version:r.note.edit_version||r.note.version,companion_skip:true});
          if(!result?.annotation?.id)throw Error('保存结果缺少批注标识，请重试核对。');
          r.note=clone(result.annotation);r.saved=comment;r.payload=null;
          // A create retry may discover a note subsequently edited elsewhere.
          // Preserve that edit, and do not use its fresh version to overwrite it.
          if(creating&&result.duplicate&&(r.note.comment||'')!==comment){
            if(r.comment===comment){r.comment=r.saved=r.note.comment||'';if(r.ui)r.ui.input.value=r.comment;}
            else {r.note.version='';r.conflict=true;throw Error('批注已有其他修改，请先核对 PDF 当前备注；本次输入已保留。');}
          }
          paint(r);
        }
        await checkpoint(r.paper);
      }catch(error){r.error=error.message;return false;}
      try{await refresh(r.id,r.note,{reveal:false});}catch(error){toast(`批注已保存，页面暂未刷新：${error.message}`,true);}
      return true;
    })();paint(r);
    try{return await r.running;}finally{r.running=null;paint(r);changed?.();}
  }
  function mount(card,r) {
    const existing=card.querySelector(':scope > .annotation-comment');existing?.remove();
    const actions=card.querySelector(':scope > .annotation-actions'),ui=editor(r);if(ui.parentElement!==card)card.insertBefore(ui,actions||null);r.ui.root.querySelector('label').firstChild.textContent=`备注 ${card.dataset.remarkNumber||1}`;r.ui.input.setAttribute('aria-label',`第 ${r.note.page} 页备注 ${card.dataset.remarkNumber||1}`);paint(r);
  }
  function decorate() {
    const id=getPaper()?.id;if(!id)return;
    const p=paper(id),list=document.getElementById('annotation-list');if(!list)return;
    for(const card of list.querySelectorAll('.annotation-card, .annotation-remark')) {
      const note=getNotes().find(n=>n.id===card.dataset.annotationId);if(!note||note.ai_generated||note.kind==='ai-feedback'||note.type==='ai_feedback')continue;
      const r=row(id,note);
      if(!dirty(r)&&!r.running&&document.activeElement!==r.ui?.input){r.note=clone(note);r.comment=r.saved=note.comment||note.content||'';if(r.ui&&r.ui.input.value!==r.comment)r.ui.input.value=r.comment;}
      mount(card,r);
    }
    // Pending creates/edits stay reachable even on another page of the rail.
    for(const r of p.rows.values()) {
      if(!dirty(r)&&!r.error)continue;
      if([...list.querySelectorAll('.annotation-card, .annotation-remark')].some(c=>c.dataset.annotationId===r.note.id))continue;
      list.querySelector('.empty-state')?.remove();
      const card=node('article','annotation-card annotation-pending');card.dataset.annotationId=r.note.id;card.dataset.paperId=id;
      card.append(node('div','annotation-meta',`第 ${r.note.page} 页 · ${r.payload?'新批注':'待保存批注'}`));
      if(r.note.text)card.append(node('blockquote','annotation-quote',r.note.text));
      card.append(node('div','annotation-actions'));mount(card,r);const parent=r.note.reply_to&&[...list.querySelectorAll(':scope > .annotation-card')].find(c=>c.dataset.annotationId===r.note.reply_to);if(parent){card.classList.remove('annotation-card');card.classList.add('annotation-remark');card.dataset.remarkNumber=String(parent.querySelectorAll('.annotation-remark').length+2);parent.append(card);mount(card,r);}else list.prepend(card);
    }
    previews?.decorate(getNotes());
  }
  async function ready(id) {
    try{await load(id);if(getPaper()?.id===id)decorate();}catch(error){toast(`批注草稿暂未恢复：${error.message}`,true);}
  }
  function focus(id,annotationId) {
    if(getPaper()?.id!==id)return;show(annotationId);decorate();const r=paper(id).rows.get(annotationId);
    r?.ui?.root.scrollIntoView?.({block:'nearest'});r?.ui?.input.focus({preventScroll:true});
  }
  async function create(mode,{note=null,selection=null,color='#ffdb66',width=2,page,comment=''}={}) {
    const id=getPaper()?.id;if(!id)return false;
    if(mode==='edit'){const r=row(id,note);focus(id,note.id);return true;}
    const annotationId=crypto.randomUUID(),pageNumber=page||selection?.page||note?.page||1;
    const payload=mode==='reply'?{id,annotation_id:note.reply_to||note.id,reply_id:annotationId,comment,companion_skip:true}:{id,annotation_id:annotationId,page:pageNumber,type:mode,text:selection?.text||note?.text||'',rects:selection?.rects||note?.rects||[note?.rect||[20,20,40,40]],color,width,comment,author:'Reader',companion_skip:true};
    const r=row(id,{id:annotationId,page:pageNumber,type:mode==='reply'?'note':mode,text:payload.text||note?.text||'',comment,...(mode==='reply'?{kind:'reader-reply',reply_to:note.reply_to||note.id}:{})},payload);
    show();decorate();focus(id,annotationId);
    return save(r);
  }
  async function beforeAsk(id,annotationId) {
    const r=paper(id).rows.get(annotationId);
    if(r&&!await save(r))throw Error('请先重试保存这条批注，再问 DSH。');
    return r?.note.version;
  }
  let pendingRender=null,renderTimer=null;
  function deferRender(render){
    const active=document.activeElement,card=active?.closest?.('.annotation-card');
    if(active?.classList.contains('annotation-inline-input')&&card?.dataset.paperId===getPaper()?.id){pendingRender=render;return true;}
    pendingRender=null;return false;
  }
  document.addEventListener('focusout',event=>{
    if(!event.target?.classList.contains('annotation-inline-input')||!pendingRender)return;
    clearTimeout(renderTimer);renderTimer=setTimeout(()=>{renderTimer=null;const render=pendingRender;if(render&&!deferRender(render))render();},0);
  });
  function beforeRender(){const list=document.getElementById('annotation-list'),top=list?.scrollTop,left=list?.scrollLeft,active=document.activeElement,start=active?.selectionStart,end=active?.selectionEnd;return()=>{if(active?.classList.contains('annotation-inline-input')&&active.isConnected){active.focus({preventScroll:true});active.setSelectionRange(start,end);}if(list){list.scrollTop=top;list.scrollLeft=left;}};}
  function discard(id,annotationId){const p=paper(id),r=p.rows.get(annotationId);if(r){clearTimeout(r.timer);p.rows.delete(annotationId);void checkpoint(p).catch(e=>toast(e.message,true));}}
  function pending(){return [...papers.values()].flatMap(p=>[...p.rows.values()].filter(dirty).map(r=>({paper_id:r.id,annotation_id:r.note.id,comment:r.comment,payload:r.payload})));}
  window.addEventListener('beforeunload',event=>{if(pending().length){event.preventDefault();event.returnValue='';}});
  async function restoreDraft(id,note,comment){await load(id);const r=row(id,note);if(!dirty(r)){r.comment=comment;if(r.ui)r.ui.input.value=comment;await checkpoint(r.paper);}focus(id,note.id);}
  return {create,decorate,ready,focus,beforeAsk,beforeRender,deferRender,discard,pending,restoreDraft};
}};

// 矩形卡片只在进入视野后读取单个区域，最多并发两张，内存保留 16 张。
window.PaperAnnotationPreviews={create({api,getPaper,onPreview=()=>{}}){
  const cache=new Map(),pending=new Map();let active=0,queue=[];
  const observer=typeof IntersectionObserver==='function'?new IntersectionObserver(entries=>{for(const entry of entries)if(entry.isIntersecting){observer.unobserve(entry.target);entry.target.loadPreview?.();}},{rootMargin:'120px'}):null;
  function pump(){
    queue=queue.filter(job=>{if(job.targets.some(target=>target.isConnected))return true;pending.delete(job.key);return false;});
    while(active<2&&queue.length){const job=queue.shift();active++;
      void api('annotation_preview',{id:job.paperId,page:job.note.page,annotation_id:job.note.id,render_width:640}).then(result=>{
        if(result?.annotation_id!==job.note.id||result.page!==job.note.page||typeof result.image!=='string'||result.image.length>1400000||result.mime_type!=='image/png')throw Error('区域预览返回无效，请重试。');
        cache.delete(job.key);cache.set(job.key,{result,time:Date.now()});while(cache.size>16)cache.delete(cache.keys().next().value);
        for(const target of job.targets)if(target.isConnected&&getPaper()?.id===job.paperId)display(target,result);
      }).catch(error=>{for(const target of job.targets)if(target.isConnected&&getPaper()?.id===job.paperId){target.querySelector('.annotation-preview-status').textContent=`截图未加载：${error.message}`;target.querySelector('.annotation-preview-retry').hidden=false;}}).finally(()=>{pending.delete(job.key);active--;pump();});
    }
  }
  function display(box,result){
    const image=document.createElement('img');image.alt=`第 ${result.page} 页矩形框内的 PDF 内容`;image.width=result.width;image.height=result.height;image.decoding='async';image.src=`data:image/png;base64,${result.image}`;
    box.querySelector('.annotation-preview-open').replaceChildren(image);box.querySelector('.annotation-preview-status').textContent='';box.querySelector('.annotation-preview-retry').hidden=true;onPreview(box,box.previewNote,result);
  }
  function decorate(notes){
    observer?.disconnect();const paperId=getPaper()?.id;if(!paperId)return;
    for(const card of document.querySelectorAll('#annotation-list > .annotation-card')){
      const note=notes.find(n=>n.id===card.dataset.annotationId);if(note?.type!=='square'||card.querySelector('.annotation-region-preview'))continue;
      const box=document.createElement('div');box.className='annotation-region-preview';box.previewNote=note;
      const button=document.createElement('button');button.type='button';button.className='annotation-preview-open';button.dataset.noteAction='page';button.title='点击截图定位 PDF 中的矩形框';button.setAttribute('aria-label',`定位第 ${note.page} 页矩形框`);button.textContent='矩形区域预览';
      const status=document.createElement('span');status.className='annotation-preview-status small muted';status.setAttribute('role','status');status.textContent='等待加载截图…';
      const retry=document.createElement('button');retry.type='button';retry.className='button subtle annotation-preview-retry';retry.textContent='重试截图';retry.hidden=true;
      box.append(button,status,retry);card.querySelector('.annotation-meta')?.after(box);
      const key=JSON.stringify([paperId,note.id,note.version||note.edit_version,note.rects||note.rect]);
      box.loadPreview=()=>{
        if(!box.isConnected||getPaper()?.id!==paperId)return;
        const saved=cache.get(key);if(saved&&Date.now()-saved.time<60000){display(box,saved.result);return;}
        status.textContent='正在读取矩形截图…';retry.hidden=true;
        if(pending.has(key)){const targets=pending.get(key).targets;if(!targets.includes(box))targets.push(box);return;}
        const job={key,paperId,note,targets:[box]};pending.set(key,job);queue.push(job);pump();
      };
      retry.addEventListener('click',event=>{event.stopPropagation();box.loadPreview();});
    }
    for(const box of document.querySelectorAll('#annotation-list .annotation-region-preview'))if(!box.querySelector('img')){if(observer)observer.observe(box);else box.loadPreview?.();}
  }
  return {decorate};
}};

// 截图成功且进入视野后才生成说明；一次只请求一个区域，失败由用户重试。
window.PaperAnnotationCaptions={create({api,getPaper,getNotes,available,saved}){
  const records=new Map();let running=false;const queue=[];
  function paint(record){for(const box of record.boxes)if(box.isConnected){box.querySelector('.annotation-caption-status').textContent=record.status;const retry=box.querySelector('.annotation-caption-retry');retry.hidden=!record.error;retry.disabled=record.pending;}}
  async function pump(){
    if(running)return;
    const record=queue.shift();if(!record)return;
    if(getPaper()?.id!==record.paperId||!record.boxes.some(box=>box.isConnected)){record.pending=false;record.status='图像说明待生成';records.delete(record.key);pump();return;}
    running=true;record.status='正在生成图像说明…';paint(record);
    try{
      const result=await api('annotation_caption',{id:record.paperId,annotation_id:record.note.id,page:record.note.page,...(record.retry?{retry:true}:{})});
      if(!result?.saved||!result.annotation?.id)throw Error('图像说明尚未确认保存，请重试。');
      record.status='AI 图像说明已保存';record.error=false;
      if(getPaper()?.id===record.paperId)await saved(record.paperId,record.note);
    }catch(error){record.status=`图像说明未完成：${error.message}`;record.error=true;}
    finally{record.pending=false;paint(record);running=false;pump();}
  }
  function decorate(box,note,sourceVersion){
    if(!available()||!note||box.querySelector('.annotation-caption-status'))return;
    if(getNotes().some(n=>n.source_kind==='annotation-caption'&&(n.reply_to===note.id||n.annotation_ids?.includes(note.id))&&(!sourceVersion||n.source_message_id===sourceVersion)))return;
    const paperId=getPaper()?.id,key=JSON.stringify([paperId,note.id,note.page,note.rects||note.rect,sourceVersion]);
    const status=document.createElement('span');status.className='annotation-caption-status small muted';status.setAttribute('role','status');
    const retry=document.createElement('button');retry.type='button';retry.className='button subtle annotation-caption-retry';retry.textContent='重试图像说明';retry.hidden=true;box.append(status,retry);
    let record=records.get(key);if(!record){record={key,paperId,note,boxes:[],pending:true,error:false,status:'图像说明等待生成'};records.set(key,record);queue.push(record);}
    record.boxes=record.boxes.filter(b=>b.isConnected);record.boxes.push(box);paint(record);
    retry.addEventListener('click',event=>{event.stopPropagation();if(record.pending||getPaper()?.id!==paperId)return;record.pending=true;record.error=false;record.retry=true;record.status='图像说明等待生成';queue.push(record);paint(record);void pump();});
    void pump();
  }
  return {decorate};
}};
