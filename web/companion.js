'use strict';
window.PaperCompanion={create({api,persistence,getPaper,refreshAnnotations,beforeAsk,toast}){
  let available=false,disposed=false,paperId=null,enabled=false,writable=false,timer,busy=false,again=false,entries=[],savedKey='';
  let entriesRevision=0,savedReadsFailed=0,savingToggle=false;
  const submitting=new Set();
  const operationKey=(id,annotationId)=>JSON.stringify([id,annotationId]);
  const processing=value=>value&&!value.recoverable&&['queued','preparing','sending','accepted'].includes(value.status);
  const waiting=value=>processing(value)&&(value.status!=='queued'||value.manual||enabled);
  const make=(tag,text,cls)=>{const n=document.createElement(tag);n.textContent=text;if(cls)n.className=cls;return n;};
  const toggle=make('button','实时伴学','button subtle paper-switch');toggle.id='companion-toggle';toggle.type='button';toggle.hidden=true;
  toggle.setAttribute('role','switch');toggle.setAttribute('aria-checked','false');
  toggle.title='保存或修改有文字评论的批注后自动回复；弹窗选择「仅保存批注」时不提问。';document.getElementById('paper-tools').append(toggle);
  function show(){toggle.setAttribute('aria-checked',String(enabled));toggle.disabled=!writable||savingToggle;}
  toggle.addEventListener('click',async()=>{
    if(!writable||savingToggle)return;
    const requested=!enabled;savingToggle=true;show();
    try{await persistence.patch('preferences',{'auto-paper-conversation':requested});enabled=requested;++entriesRevision;void refresh();}
    catch(error){toast(error.message,true);}
    finally{savingToggle=false;show();}
  });
  function decorate(){
    const newest=new Map(entries.map(e=>[e.annotation_id,e]));
    for(const card of document.querySelectorAll('#annotation-list .annotation-card, #annotation-list .annotation-remark')){
      const id=paperId, annotationId=card.dataset.annotationId, value=newest.get(annotationId);
      card.querySelector(':scope > .companion-state')?.remove();
      let ask=card.querySelector(':scope > .annotation-actions')?.querySelector('.companion-ask');
      if(!available||!id||card.dataset.paperId!==id){ask?.remove();continue;}
      const key=operationKey(id,annotationId);
      if(!ask){
        ask=make('button','问 DSH','button subtle companion-ask');ask.type='button';
        ask.addEventListener('click',event=>{
          event.stopPropagation();
          if(ask.disabled||paperId!==id||getPaper()?.id!==id)return;
          const version=card.dataset.annotationVersion;
          void submit(id,annotationId,'companion_ask',{annotation_id:annotationId,...(version?{version}:{})});
        });
        card.querySelector(':scope > .annotation-actions')?.append(ask);
      }
      const hasText=card.dataset.companionText==='true';
      ask.title=hasText?'直接解读选文；有备注或问题时一并回答。回复保存为这条批注下的 AI 批注。':'写入批注文字或保存手写转录后可问 DSH';
      ask.disabled=!hasText||submitting.has(key)||Boolean(waiting(value)||value?.status==='failed'||value?.recoverable);
      if(!value&&!submitting.has(key))continue;
      const box=make('div','','companion-state small');box.setAttribute('role','status');
      const names={queued:value?.manual?'已排队，等待 DSH 回复':enabled?'等待伴学回复':'伴学已暂停',preparing:'正在准备材料',sending:'正在提交到 DSH',accepted:'等待 DSH 回复',saved:value?.manual?'AI 批注已保存':'伴学回复已保存',failed:value?.manual?'DSH 回复未完成':'伴学未完成',superseded:'已合并到新版本',cancelled:'已取消等待'};
      box.append(make('span',submitting.has(key)?'正在处理 DSH 请求…':names[value.status]||value.status));
      if(value?.error)box.append(make('p',value.error,'error'));
      for(const [action,label] of [['retry','重试'],['cancel','取消等待']]){
        if(!value)continue;
        if(action==='retry'&&value.status!=='failed'&&!value.recoverable)continue;
        if(action==='cancel'&&!['failed','queued'].includes(value.status))continue;
        const button=make('button',label,'button subtle');button.type='button';button.disabled=submitting.has(key);
        button.addEventListener('click',event=>{
          event.stopPropagation();
          if(paperId===id&&getPaper()?.id===id)void submit(id,annotationId,`companion_${action}`,{request_id:value.request_id});
        });
        box.append(button);
      }
      card.append(box);
    }
  }
  async function submit(id,annotationId,action,args){
    const key=operationKey(id,annotationId);
    if(disposed||!available||paperId!==id||submitting.has(key))return;
    submitting.add(key);decorate();
    try{
      if(action==='companion_ask'&&beforeAsk){const version=await beforeAsk(id,annotationId);if(version)args={...args,version};}
      const value=await api(action,{id,...args});
      if(disposed||!available||paperId!==id)return;
      ++entriesRevision;
      if(value?.request_id)entries=[...entries.filter(entry=>entry.request_id!==value.request_id),value];
      await refresh();
    }catch(error){if(!disposed&&paperId===id)toast(error.message,true);}
    finally{submitting.delete(key);if(!disposed&&paperId===id)decorate();}
  }
  async function refresh(){
    clearTimeout(timer);if(disposed||!available||!paperId||document.hidden)return;
    if(busy){again=true;return;}busy=true;const id=paperId,revision=entriesRevision;
    try{
      const result=await api('companion_status',{id});if(id!==paperId||disposed||!available)return;
      if(revision!==entriesRevision){again=true;return;}
      enabled=result.enabled;entries=result.entries||[];show();
      const key=JSON.stringify(entries.filter(v=>v.status==='saved').map(v=>v.request_id));
      if(key!==savedKey){
        const loaded=key==='[]'||await refreshAnnotations(id)!==false;
        if(id!==paperId||disposed)return;
        if(loaded){savedKey=key;savedReadsFailed=0;}
        else savedReadsFailed++;
      }
      if(id===paperId&&!disposed)decorate();
    }catch(error){if(id===paperId)toast(`伴学状态暂未读取：${error.message}`,true);}
    finally{
      busy=false;
      const immediate=again;again=false;
      if(!disposed&&available&&!document.hidden&&(immediate||entries.some(waiting)||savedReadsFailed>0&&savedReadsFailed<3))timer=setTimeout(()=>void refresh(),immediate?0:3000);
    }
  }
  function sync(){
    const paper=getPaper(),id=paper?.pdf&&!paper.archived?paper.id:null;
    toggle.hidden=!available||!id;
    if(id===paperId)return false;
    paperId=id;entries=[];savedKey='';savedReadsFailed=0;++entriesRevision;decorate();void refresh();return true;
  }
  const visibility=()=>{if(document.hidden)clearTimeout(timer);else void refresh();};document.addEventListener('visibilitychange',visibility);
  return {sync,decorate,refresh,available:()=>available&&!disposed,setAvailable(v){
    const wasAvailable=available;available=Boolean(v);
    if(!sync()&&available!==wasAvailable){decorate();if(available)void refresh();}
  },applyPreferences(value,canWrite){
    const requested=value['auto-paper-conversation']===true,changed=requested!==enabled;
    enabled=requested;writable=canWrite;show();
    if(changed){++entriesRevision;decorate();void refresh();}
  },dispose(){disposed=true;clearTimeout(timer);document.removeEventListener('visibilitychange',visibility);}};
}};
