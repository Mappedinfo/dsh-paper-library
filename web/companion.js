'use strict';
window.PaperCompanion={create({api,persistence,getPaper,refreshAnnotations,toast}){
  let available=false,disposed=false,paperId=null,enabled=false,writable=false,timer,busy=false,again=false,entries=[],savedKey='';
  const make=(tag,text,cls)=>{const n=document.createElement(tag);n.textContent=text;if(cls)n.className=cls;return n;};
  const toggle=make('button','实时伴学','button subtle');toggle.id='companion-toggle';toggle.type='button';toggle.hidden=true;
  toggle.title='保存或修改有文字评论的批注后自动回复；使用本篇 DSH 模型。';document.getElementById('paper-tools').append(toggle);
  function show(){toggle.setAttribute('aria-pressed',String(enabled));toggle.textContent=`实时伴学${enabled?' · 开':' · 关'}`;toggle.disabled=!writable;}
  toggle.addEventListener('click',async()=>{const requested=!enabled;toggle.disabled=true;try{await persistence.patch('preferences',{'auto-paper-conversation':requested});enabled=requested;show();void refresh();}catch(e){toast(e.message,true);show();}});
  function decorate(){
    const newest=new Map(entries.map(e=>[e.annotation_id,e]));
    for(const card of document.querySelectorAll('#annotation-list > .annotation-card')){
      card.querySelector('.companion-state')?.remove();const value=newest.get(card.dataset.annotationId);if(!value)continue;
      const box=make('div','','companion-state small');box.setAttribute('role','status');
      const names={queued:enabled?'等待伴学回复':'伴学已暂停',preparing:'正在准备材料',sending:'正在提交到 DSH',accepted:'等待 DSH 回复',saved:'伴学回复已保存',failed:'伴学未完成',superseded:'已合并到新版本',cancelled:'已取消等待'};
      box.append(make('span',names[value.status]||value.status));if(value.error)box.append(make('p',value.error,'error'));
      for(const [action,label] of [['retry','重试'],['cancel','取消等待']]){
        if(action==='retry'&&value.status!=='failed'&&!value.recoverable)continue;
        if(action==='cancel'&&!['failed','queued'].includes(value.status))continue;
        const button=make('button',label,'button subtle');button.type='button';button.onclick=async()=>{button.disabled=true;try{await api(`companion_${action}`,{id:paperId,request_id:value.request_id});await refresh();}catch(e){toast(e.message,true);button.disabled=false;}};box.append(button);
      }
      card.append(box);
    }
  }
  async function refresh(){
    clearTimeout(timer);if(disposed||!available||!paperId||document.hidden)return;
    if(busy){again=true;return;}busy=true;const id=paperId;
    try{
      const result=await api('companion_status',{id});if(id!==paperId||disposed)return;
      enabled=result.enabled;entries=result.entries||[];show();
      const key=JSON.stringify(entries.filter(v=>v.status==='saved').map(v=>v.request_id));
      if(key!==savedKey){savedKey=key;if(key!=='[]')await refreshAnnotations(id);}
      decorate();
    }catch(error){if(id===paperId)toast(`伴学状态暂未读取：${error.message}`,true);}
    finally{busy=false;if(!disposed&&!document.hidden&&(again||entries.some(v=>['queued','accepted','sending'].includes(v.status)))){again=false;timer=setTimeout(()=>void refresh(),3000);}}
  }
  function sync(){const id=getPaper()?.pdf?getPaper().id:null;toggle.hidden=!available||!id;if(id!==paperId){paperId=id;entries=[];savedKey='';void refresh();}}
  const visibility=()=>{if(document.hidden)clearTimeout(timer);else void refresh();};document.addEventListener('visibilitychange',visibility);
  return {sync,decorate,refresh,setAvailable(v){const wasAvailable=available;available=Boolean(v);sync();if(available&&!wasAvailable)void refresh();},applyPreferences(value,canWrite){enabled=value['auto-paper-conversation']===true;writable=canWrite;show();},dispose(){disposed=true;clearTimeout(timer);document.removeEventListener('visibilitychange',visibility);}};
}};
