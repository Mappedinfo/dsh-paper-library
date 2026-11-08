'use strict';
// 每条原生 PDF 批注独立编辑；草稿先存本地服务，保存成功后再清除。
window.PaperAnnotationEditor = { create({api,persistence,getPaper,getNotes,show,refresh,changed,toast}) {
  const papers=new Map(), delay=650;
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
    const card=input.closest('.annotation-card');if(card){card.dataset.companionText=String(Boolean((r.note.text||'').trim()||r.comment.trim()||r.note.handwriting?.transcript||r.note.linked_ink?.transcript));if(r.note.version)card.dataset.annotationVersion=r.note.version;}
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
          const result=creating?await api('annotate',r.payload):await api('annotation_update',{id:r.id,annotation_id:r.note.id,comment,version:r.note.edit_version||r.note.version,companion_skip:true});
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
      try{await refresh(r.id,r.note,{reveal:document.activeElement?.closest('.annotation-card')?.dataset.annotationId===r.note.id});}catch(error){toast(`批注已保存，页面暂未刷新：${error.message}`,true);}
      return true;
    })();paint(r);
    try{return await r.running;}finally{r.running=null;paint(r);changed?.();}
  }
  function mount(card,r) {
    const existing=card.querySelector(':scope > .annotation-comment');existing?.remove();
    const actions=card.querySelector(':scope > .annotation-actions');card.insertBefore(editor(r),actions||null);paint(r);
  }
  function decorate() {
    const id=getPaper()?.id;if(!id)return;
    const p=paper(id),list=document.getElementById('annotation-list');if(!list)return;
    for(const card of list.querySelectorAll(':scope > .annotation-card')) {
      const note=getNotes().find(n=>n.id===card.dataset.annotationId);if(!note||note.ai_generated||note.kind==='ai-feedback'||note.type==='ai_feedback')continue;
      const r=row(id,note);
      if(!dirty(r)&&!r.running){r.note=clone(note);r.comment=r.saved=note.comment||note.content||'';if(r.ui)r.ui.input.value=r.comment;}
      mount(card,r);
    }
    // Pending creates/edits stay reachable even on another page of the rail.
    for(const r of p.rows.values()) {
      if(!dirty(r)&&!r.error)continue;
      if([...list.querySelectorAll(':scope > .annotation-card')].some(c=>c.dataset.annotationId===r.note.id))continue;
      list.querySelector('.empty-state')?.remove();
      const card=node('article','annotation-card annotation-pending');card.dataset.annotationId=r.note.id;card.dataset.paperId=id;
      card.append(node('div','annotation-meta',`第 ${r.note.page} 页 · ${r.payload?'新批注':'待保存批注'}`));
      if(r.note.text)card.append(node('blockquote','annotation-quote',r.note.text));
      card.append(node('div','annotation-actions'));mount(card,r);list.prepend(card);
    }
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
    const payload={id,annotation_id:annotationId,page:pageNumber,type:mode,text:selection?.text||note?.text||'',rects:selection?.rects||note?.rects||[note?.rect||[20,20,40,40]],color,width,comment,author:'Reader',companion_skip:true};
    const r=row(id,{id:annotationId,page:pageNumber,type:mode,text:payload.text,comment},payload);
    show();decorate();focus(id,annotationId);
    return save(r);
  }
  async function beforeAsk(id,annotationId) {
    const r=paper(id).rows.get(annotationId);
    if(r&&!await save(r))throw Error('请先重试保存这条批注，再问 DSH。');
    return r?.note.version;
  }
  function beforeRender(){const active=document.activeElement;if(!active?.classList.contains('annotation-inline-input'))return()=>{};const start=active.selectionStart,end=active.selectionEnd;return()=>{if(active.isConnected){active.focus({preventScroll:true});active.setSelectionRange(start,end);}};}
  function discard(id,annotationId){const p=paper(id),r=p.rows.get(annotationId);if(r){clearTimeout(r.timer);p.rows.delete(annotationId);void checkpoint(p).catch(e=>toast(e.message,true));}}
  function pending(){return [...papers.values()].flatMap(p=>[...p.rows.values()].filter(dirty).map(r=>({paper_id:r.id,annotation_id:r.note.id,comment:r.comment,payload:r.payload})));}
  window.addEventListener('beforeunload',event=>{if(pending().length){event.preventDefault();event.returnValue='';}});
  async function restoreDraft(id,note,comment){await load(id);const r=row(id,note);if(!dirty(r)){r.comment=comment;if(r.ui)r.ui.input.value=comment;await checkpoint(r.paper);}focus(id,note.id);}
  return {create,decorate,ready,focus,beforeAsk,beforeRender,discard,pending,restoreDraft};
}};
