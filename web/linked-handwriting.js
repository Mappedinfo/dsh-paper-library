'use strict';

/** A handwriting session belongs to one saved annotation, on the PDF itself. */
window.PaperLinkedHandwriting = (() => {
  function create({api,persistence,reader,shell,state,toast,saveInk,inkBusy,inkUncertain,queue,navigate,changed,publish,available}) {
    let session=null, ending=false, starting=false, timer=null;
    const jobs=new Map(), messages=new Map(), corrections=new Map(), correctionLoads=new Map(), correctionJobs=new Set(), correctionViews=new Map();
    const node=(tag,text)=>{const n=document.createElement(tag);if(text)n.textContent=text;return n;};
    const bar=node('div');bar.id='linked-handwriting-session';bar.className='linked-handwriting-session';bar.hidden=true;
    const status=node('span');status.id='linked-handwriting-status';status.setAttribute('role','status');
    const finishButton=node('button','完成手写');finishButton.id='linked-handwriting-finish';finishButton.className='button primary';
    finishButton.addEventListener('click',()=>void finish());bar.append(status,finishButton);document.getElementById('reader-ink-draft').before(bar);
    const identity=(id,parent)=>JSON.stringify([id,parent]);
    const recognitionIntents=new Map();let intentLoad=null,intentWrites=Promise.resolve();
    const intentKey='reader:linked-recognition-pending';
    function loadIntents(){if(!intentLoad)intentLoad=(async()=>{for(const item of await persistence?.get(intentKey)||[])if(typeof item.paperId==='string'&&typeof item.parentId==='string')recognitionIntents.set(identity(item.paperId,item.parentId),item);})().catch(error=>{intentLoad=null;throw error;});return intentLoad;}
    function writeIntents(){const value=[...recognitionIntents.values()];intentWrites=intentWrites.catch(()=>{}).then(()=>persistence?.put(intentKey,value));return intentWrites;}
    async function planRecognition(value){
      try{await loadIntents();const token=identity(value.paperId,value.parentId);if(recognitionIntents.size>=64&&!recognitionIntents.has(token)){toast('待识别批注较多，请从卡片手动转文字；原笔迹仍会保存。');return;}recognitionIntents.set(token,{paperId:value.paperId,parentId:value.parentId});await writeIntents();await saved(value.paperId,value.parentId);}
      catch(error){toast(`自动识别安排未能暂存，可从卡片转文字：${error.message}`,true);}
    }
    async function keyFor(id,parent){const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(identity(id,parent)));return `reader:linked-recognition:${[...new Uint8Array(bytes)].map(n=>n.toString(16).padStart(2,'0')).join('')}`;}
    function active(id,parent){return session?.paperId===id&&session.parentId===parent;}
    function sync(){
      bar.hidden=!session;finishButton.disabled=ending;
      if(session)status.textContent=`正在给第 ${session.page} 页的批注手写 · 直接在 PDF 上写画，停笔自动保存`;
      document.body.classList.toggle('linked-handwriting-active',Boolean(session));
      for(const card of document.querySelectorAll('#annotation-list > .annotation-card')){
        const on=active(state.active?.id,card.dataset.annotationId),button=card.querySelector('[data-note-action="handwriting"]');
        card.classList.toggle('is-handwriting',on);
        if(button){button.setAttribute('aria-pressed',String(on));button.textContent=on?'完成手写':'手写';button.disabled=ending||starting;}
      }
    }
    function remember(){publish?.();void persistence?.put('reader:linked-handwriting',session?{...session}:null).catch(error=>toast(`手写模式未能暂存：${error.message}`,true));sync();}
    function schedule(){
      clearTimeout(timer);timer=null;
      const draft=reader()?.getInkDraft();
      if(!draft?.parentId||inkUncertain())return;
      timer=setTimeout(async()=>{timer=null;if(reader()?.isInking()||inkBusy()){schedule();return;}await saveInk();},1500);
    }
    async function toggle(item,note){
      if(!item?.id||!note?.id||ending||starting)return;
      if(active(item.id,note.id)){await finish();return;}
      if(session&&!await finish())return;
      if(inkBusy()){toast('上一份笔迹正在暂存，确认后即可继续手写；仍可继续阅读。');return;}
      const draft=reader()?.getInkDraft();
      if(draft&&(draft.paperId!==item.id||draft.parentId!==note.id)){toast('请先保存或取消当前笔迹，再给这条批注手写。',true);return;}
      const previous=shell()?.tool().type||'highlight';
      starting=true;sync();
      try{
        await navigate(note.page);
        reader().setInkContext({paperId:item.id,page:note.page,parentId:note.id});
        session={paperId:item.id,page:note.page,parentId:note.id,previousTool:previous==='ink'?'highlight':previous};
        shell()?.setTool('ink');remember();
      }catch(error){toast(error.message,true);}finally{starting=false;sync();}
    }
    async function finish(){
      if(!session)return true;if(ending)return false;
      ending=true;sync();clearTimeout(timer);
      const original={...session};
      try{
        if(reader()?.isInking()){toast('请先抬笔，再结束手写。');return false;}
        if(reader()?.getInkDraft()&&!saveInk())return false;
        reader()?.setInkContext(null);session=null;shell()?.setTool(original.previousTool);remember();
        const note=state.active?.id===original.paperId?state.annotations.find(n=>n.id===original.parentId):null;
        void planRecognition(original);
        return true;
      }finally{ending=false;sync();}
    }
    async function restore(value){
      if(value===false){session=null;reader()?.setInkContext(null);shell()?.setTool('ink');sync();return;}
      const draft=reader()?.getInkDraft();
      const restored=value||await persistence?.get('reader:linked-handwriting');
      const candidate=draft?.parentId?{paperId:draft.paperId,page:draft.page,parentId:draft.parentId,previousTool:restored?.parentId===draft.parentId?restored.previousTool:'highlight'}:restored;
      if(!candidate||typeof candidate.paperId!=='string'||typeof candidate.parentId!=='string'||!Number.isInteger(candidate.page))return;
      try{reader()?.setInkContext(candidate);session={...candidate,previousTool:['select','highlight','underline','strikeout','note'].includes(candidate.previousTool)?candidate.previousTool:'highlight'};shell()?.setTool('ink');sync();schedule();}
      catch(error){toast(`关联手写待恢复：${error.message}`,true);}
    }
    function recognitionImage(group){
      if(group.truncated||!group.annotations?.length)throw new Error('笔迹未能完整读取，暂不识别；原笔迹仍保存在 PDF。');
      const strokes=group.annotations.flatMap(a=>(a.paths||[]).map(points=>({points,width:a.width,color:a.color})));
      let left=Infinity,top=Infinity,right=-Infinity,bottom=-Infinity;
      for(const stroke of strokes)for(const [x,y] of stroke.points){left=Math.min(left,x);top=Math.min(top,y);right=Math.max(right,x);bottom=Math.max(bottom,y);}
      if(!Number.isFinite(left))throw new Error('没有可识别的手写笔迹。');
      const canvas=document.createElement('canvas');canvas.width=1280;canvas.height=720;const ctx=canvas.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,1280,720);
      const scale=Math.min(1200/Math.max(20,right-left),640/Math.max(20,bottom-top),4),ox=(1280-(right-left)*scale)/2,oy=(720-(bottom-top)*scale)/2;
      ctx.lineCap='round';ctx.lineJoin='round';
      for(const stroke of strokes){const color=stroke.color?.stroke||stroke.color;ctx.strokeStyle=Array.isArray(color)?`rgb(${color.map(v=>Math.round(v*255)).join(',')})`:typeof color==='string'?color:'#2455a4';ctx.lineWidth=(stroke.width||2)*scale;ctx.beginPath();stroke.points.forEach(([x,y],i)=>ctx[i?'lineTo':'moveTo'](ox+(x-left)*scale,oy+(y-top)*scale));ctx.stroke();}
      return canvas.toDataURL('image/png').split(',')[1];
    }
    function setMessage(id,parent,text){messages.set(identity(id,parent),text);const escaped=CSS.escape(parent);const card=document.querySelector(`#annotation-list > [data-annotation-id="${escaped}"]`);if(card&&state.active?.id===id){let p=card.querySelector('.linked-recognition-status');if(!p){p=node('p');p.className='small muted linked-recognition-status';p.setAttribute('role','status');card.append(p);}p.textContent=text;}}
    async function recognize(id,note,{fresh=false,automatic=false}={}){
      const identityKey=identity(id,note.id);if(jobs.has(identityKey))return;
      if(queue?.()?.hasPending(id,note.id)||active(id,note.id)){setMessage(id,note.id,'笔迹保存后即可转文字；原笔迹一直保留。');return;}
      if(!available()){toast('转文字需要在论文对话中选择支持图片的模型；原笔迹已保存。',true);return;}
      jobs.set(identityKey,true);setMessage(id,note.id,'正在识别手写，原笔迹已保存…');
      try{
        await loadIntents();if(automatic){const intent=recognitionIntents.get(identityKey);if(!intent||intent.attempted)return;recognitionIntents.set(identityKey,{...intent,attempted:true});await writeIntents();}
        const key=await keyFor(id,note.id),group=note.linked_ink;if(!group)throw new Error('请先保存手写笔迹。');
        let request=await persistence?.get(key);
        if(request&&request.geometry_version!==group.geometry_version&&!fresh)throw new Error('笔迹已有变化。请点「重新识别」为当前笔迹发起新请求。');
        if(!request||fresh){request={request_id:crypto.randomUUID(),geometry_version:group.geometry_version,expected_version:group.version,save_request_id:crypto.randomUUID()};await persistence?.put(key,request);}
        if(!Object.hasOwn(request,'transcript')){const result=await api('handwriting_recognize',{id,annotation_id:note.id,image:recognitionImage(group),request_id:request.request_id});request={...request,transcript:result.text};await persistence?.put(key,request);}
        await api('linked_handwriting_text',{id,parent_id:note.id,transcript:request.transcript,transcription_source:'model',expected_version:request.expected_version,request_id:request.save_request_id});
        await persistence?.put(key,null);recognitionIntents.delete(identityKey);await writeIntents();setMessage(id,note.id,'手写已转为文字，可展开校对；原笔迹仍保留。');await changed(id,note.page);
      }catch(error){setMessage(id,note.id,`识别未完成：${error.message} 原笔迹仍保留。`);toast('手写已保存；文字识别未完成，可在批注下重试。',true);}
      finally{jobs.delete(identityKey);}
    }
    const previews=new Map(),lazyPreviews=new Map();
    const previewObserver=typeof IntersectionObserver==='function'?new IntersectionObserver(entries=>{for(const entry of entries)if(entry.isIntersecting)paintPreview(entry.target);}):null;
    function paintPreview(target){const render=lazyPreviews.get(target);if(!render)return;lazyPreviews.delete(target);previewObserver?.unobserve(target);render();}
    function beforeRender(){previewObserver?.disconnect();lazyPreviews.clear();}
    function afterRender(){for(const target of lazyPreviews.keys()){const box=target.getBoundingClientRect();if(target.getClientRects().length&&box.bottom>0&&box.top<innerHeight&&box.right>0&&box.left<innerWidth)paintPreview(target);else previewObserver?.observe(target);}}
    function preview(note){return window.PaperInkPreview?.prepare({annotations:note.linked_ink?.annotations||[],pending:queue?.()?.records()||[],paperId:state.active?.id,parentId:note.id,geometryVersion:note.linked_ink?.geometry_version});}
    async function reveal(note,regionId){
      const model=preview(note);if(!model?.regions.length)return;
      const region=model.regions.find(value=>value.id===regionId);
      const targets=region?[region]:model.regions.filter(value=>value.page===note.page);
      if(!targets.length)return;
      await reader()?.revealRegion({paperId:state.active.id,page:targets[0].page,rects:targets.map(value=>value.bounds),kind:'ink',focusId:`${note.id}:${regionId||'all'}`});
    }
    async function saved(id,parent){
      await loadIntents().catch(()=>{});
      const token=identity(id,parent);if(!recognitionIntents.has(token)||recognitionIntents.get(token).attempted)return;
      if(!parent||state.active?.id!==id||active(id,parent)||queue?.()?.hasPending(id,parent))return;
      const draft=reader()?.getInkDraft();if(draft?.paperId===id&&draft.parentId===parent)return;
      const note=state.annotations.find(value=>value.id===parent),group=note?.linked_ink;
      if(group&&(group.transcription_source==='edited'||group.transcript&&!group.transcript_stale)){recognitionIntents.delete(token);void writeIntents().catch(()=>{});return;}
      if(group&&available())void recognize(id,note,{automatic:true});
    }
    async function paperReady(id){await loadIntents().catch(()=>{});for(const item of recognitionIntents.values())if(item.paperId===id)void saved(id,item.parentId);}
    function decorate(card,note){
      const group=note.linked_ink,pending=(queue?.()?.records()||[]).filter(job=>job.paperId===state.active?.id&&job.parentId===note.id);
      if(!group&&!pending.length)return;
      const section=node('div');section.className='annotation-handwriting linked-handwriting-summary';
      const unsettled=pending.filter(job=>job.status!=='saved');
      const summary=node('p',unsettled.length?window.PaperInkQueueClient.label(unsettled[0].status):'已保存到 PDF');summary.className='small linked-ink-save-status';summary.setAttribute('role','status');section.append(summary);
      if(group?.annotations?.length||pending.length){
        const button=node('button');button.type='button';button.className='linked-ink-preview';button.dataset.noteAction='linked-ink';button.setAttribute('aria-label','查看笔迹，定位到 PDF 中的手写位置');button.append(node('span','查看笔迹 ↗'));section.append(button);
        lazyPreviews.set(button,()=>{const model=preview(note);if(!model?.strokes.length)return;
        let cached=previews.get(model.cacheKey);if(!cached){cached=window.PaperInkPreview.render(document,model,{label:'关联手写原笔迹'});previews.set(model.cacheKey,cached);while(previews.size>40)previews.delete(previews.keys().next().value);}
        button.replaceChildren(cached.cloneNode(true),node('span','查看笔迹 ↗'));
        if(model.regions.length>1){const regions=node('div');regions.className='linked-ink-regions';model.regions.forEach((region,index)=>{const b=node('button',`笔迹 ${index+1}`);b.className='button subtle';b.dataset.noteAction='linked-ink';b.dataset.regionId=region.id;regions.append(b);});button.after(regions);}
        if(model.truncated||model.invalidCount)button.after(node('p','预览未能完整显示，请在 PDF 中查看原笔迹。'));
        });
      }
      for(const job of unsettled.filter(job=>['stage_failed','uncertain'].includes(job.status))){const b=node('button','重试保存');b.className='button subtle';b.dataset.noteAction='ink-retry';b.dataset.inkId=job.annotation_id;section.append(b);if(job.error?.message)section.append(node('p',job.error.message));}
      if(group?.transcript){const label=group.transcription_source==='model'?'AI 识别待校对':'已校对文字';section.append(node('p',`${label}${group.transcript_stale?' · 有新增笔迹，文字待更新':''}`),node('p',group.transcript));}
      const actions=node('div');actions.className='annotation-actions';
      const recognizeButton=node('button','转文字 / 重试');recognizeButton.className='button subtle';recognizeButton.dataset.noteAction='linked-recognize';actions.append(recognizeButton);
      const fresh=node('button','重新识别');fresh.className='button subtle';fresh.dataset.noteAction='linked-recognize-new';fresh.title='对当前全部关联笔迹发起一次新的识别，可能产生模型调用费用';actions.append(fresh);section.append(actions);
      recognizeButton.disabled=fresh.disabled=!group||Boolean(unsettled.length);
      if(group?.transcript)correctionEditor(section,note,state.active.id);
      const message=messages.get(identity(state.active?.id,note.id));if(message){const p=node('p',message);p.className='small muted linked-recognition-status';section.append(p);}card.append(section);
    }
    function correctionEditor(section,note,id){
      const token=identity(id,note.id),details=node('details'),summary=node('summary','校对文字'),input=node('textarea');
      input.maxLength=12000;input.setAttribute('aria-label','校对手写识别文字');input.disabled=true;
      const save=node('button','保存校对'),discard=node('button','放弃校对草稿'),rebase=node('button','读取新版本并保留校对');
      for(const b of [save,discard,rebase]){b.className='button subtle';b.type='button';b.disabled=true;}rebase.hidden=true;
      const hint=node('p');hint.className='small muted';hint.setAttribute('role','status');
      details.append(summary,input,save,discard,rebase,hint);section.append(details);
      let key;
      const sync=()=>{const draft=corrections.get(token),busy=correctionJobs.has(token);input.value=draft?.text??note.linked_ink.transcript;input.disabled=busy||Boolean(draft?.request);save.disabled=busy||!draft||Boolean(draft?.conflict);discard.disabled=busy||!draft;rebase.disabled=busy;rebase.hidden=!draft?.conflict;save.textContent=busy?'正在保存校对…':draft?.request?'重试保存校对':'保存校对';hint.textContent=draft?.conflict?'笔迹或文字已更新。你的校对草稿保留；请先读取新版本，核对后再保存。':draft?.request?'上次保存尚待确认，重试会使用同一份文字。':draft&&Object.hasOwn(draft,'current_transcript')?`PDF 当前文字：${draft.current_transcript}\n请核对上方校对稿，再保存。`:draft?'校对草稿已暂存，原识别文字未被替换。':'';};
      correctionViews.set(token,sync);
      const update=()=>correctionViews.get(token)?.();
      const ready=(async()=>{key=(await keyFor(id,note.id)).replace('linked-recognition','linked-correction');if(!correctionLoads.has(token))correctionLoads.set(token,(async()=>{const stored=await persistence?.get(key);if(stored&&!corrections.has(token))corrections.set(token,stored);})());await correctionLoads.get(token);sync();})();
      ready.catch(error=>{hint.textContent=`校对草稿未能读取：${error.message}`;});
      input.addEventListener('input',()=>{const prior=corrections.get(token);if(correctionJobs.has(token)||prior?.request)return;const draft={text:input.value,expected_version:prior?.expected_version||note.linked_ink.version,...(prior?.conflict?{conflict:true}:{})};corrections.set(token,draft);save.disabled=Boolean(draft.conflict);discard.disabled=false;hint.textContent='正在暂存校对…';void persistence?.put(key,draft).then(()=>{hint.textContent='校对草稿已暂存，原识别文字未被替换。';}).catch(error=>{hint.textContent=`草稿暂存未完成：${error.message}`;});});
      save.addEventListener('click',async()=>{
        await ready;const draft=corrections.get(token);if(!draft||draft.conflict||correctionJobs.has(token))return;
        correctionJobs.add(token);const request=draft.request||{id,parent_id:note.id,transcript:draft.text,transcription_source:'edited',expected_version:draft.expected_version,request_id:crypto.randomUUID()};corrections.set(token,{...draft,request});update();
        try{await persistence?.put(key,corrections.get(token));await api('linked_handwriting_text',request);if(corrections.get(token)?.request?.request_id===request.request_id){await persistence?.put(key,null);corrections.delete(token);}await changed(id,note.page);}
        catch(error){if(error.code==='STATE_CONFLICT'){const retained={text:draft.text,expected_version:draft.expected_version,conflict:true};corrections.set(token,retained);await persistence?.put(key,retained).catch(()=>{});}toast(error.message,true);}
        finally{correctionJobs.delete(token);update();}
      });
      discard.addEventListener('click',async()=>{await ready;if(correctionJobs.has(token))return;correctionJobs.add(token);update();try{await persistence?.put(key,null);corrections.delete(token);}catch(error){toast(error.message,true);}finally{correctionJobs.delete(token);update();}});
      rebase.addEventListener('click',async()=>{await ready;if(correctionJobs.has(token))return;correctionJobs.add(token);update();try{const current=(await api('annotations',{id})).annotations.find(value=>value.id===note.id)?.linked_ink;if(!current)throw new Error('原批注已不存在，校对草稿仍保留。');const draft={text:corrections.get(token).text,expected_version:current.version,current_transcript:current.transcript};await persistence?.put(key,draft);corrections.set(token,draft);hint.textContent='已读取最新版本，请核对文字后保存。';}catch(error){toast(error.message,true);}finally{correctionJobs.delete(token);update();}});
    }
    return {toggle,finish,restore,sync,decorate,beforeRender,afterRender,reveal,saved,paperReady,recognize,active,session:()=>session?{...session}:null,draftChanged:schedule};
  }
  return {create};
})();
