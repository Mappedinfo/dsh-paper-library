import {createHash} from 'node:crypto'

const hash=value=>createHash('sha256').update(value).digest('hex')
const key='analysis.queue:v1'
const resultKey=id=>`analysis.queue-result:${hash(id)}`
const fail=(message,code='ANALYSIS_INVALID')=>Object.assign(new Error(message),{code,status:409})
const valid=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,160}$/.test(value)&&!value.startsWith('dataset_')

/** Durable, bounded-parallel admission for explicit import events and selected papers.
 * Recovery reads only this queue. It never searches the catalog for missing work.
 * An uncertain interrupted generation is removed from the queue without replay.
 * Several papers may run at once up to the analysis service's own concurrency
 * limit; reading batches within one paper remain serial.
 */
export function createQueuedPaperAnalysis({analysis,store,settings}) {
  let disposed=false,draining=false,timer,tail=Promise.resolve()
  const inFlight=new Set()
  const locked=fn=>{const value=tail.then(fn);tail=value.catch(()=>{});return value}
  async function entries(){return (await store.get(key)).value?.entries||[]}
  async function change(fn){
    for(let attempt=0;;attempt++){
      const record=await store.get(key),next=fn(record.value?.entries||[])
      if(next.length>2000||Buffer.byteLength(JSON.stringify(next))>200000)throw fail('自动整理队列已满；文献已保存，可稍后手动整理。','ANALYSIS_QUEUE_FULL')
      try{return await store.put(key,{entries:next},record.revision)}catch(error){if(error.code!=='STATE_CONFLICT'||attempt>=2)throw error}
    }
  }
  async function result(id){return (await store.get(resultKey(id))).value}
  async function remember(id,value){const old=await store.get(resultKey(id));await store.put(resultKey(id),value,old.revision)}
  const queued=(item,position)=>({id:item.id,request_id:item.request_id,status:'queued',stage:`等待自动整理 · 队列第 ${position+1} 篇`})
  function wake(delay=0){if(disposed||draining)return;if(timer){if(delay>0)return;clearTimeout(timer);timer=null}timer=setTimeout(()=>{timer=null;void drain()},delay);timer.unref?.()}
  async function enqueue(input){
    if(!valid(input.id)||!valid(input.request_id))throw fail('文献或请求标识无效。')
    if(input.pages!==undefined&&(!Array.isArray(input.pages)||!input.pages.length||input.pages.length>2000||new Set(input.pages).size!==input.pages.length||input.pages.some(p=>!Number.isInteger(p)||p<1||p>2000)))throw fail('请指定有效且不重复的 PDF 页码。')
    if(input.source_session_id!==undefined&&(typeof input.source_session_id!=='string'||input.source_session_id.length>200||/[\x00-\x1f]/.test(input.source_session_id)))throw fail('来源对话标识无效。')
    if(input.apply_metadata!==undefined&&typeof input.apply_metadata!=='boolean')throw fail('补齐资料选项无效。')
    const previous=await analysis({action:'paper_analysis_get',id:input.id})
    if(previous.status!=='idle')return previous
    const saved=await result(input.id);if(saved)return saved
    const preferences=await settings.get()
    if(!preferences.available||preferences.value?.auto_analysis!==true)return {id:input.id,status:'idle',stage:'自动整理已关闭'}
    const item={id:input.id,request_id:input.request_id,...(input.pages?{pages:input.pages}:{}),...(input.source_session_id?{source_session_id:input.source_session_id}:{}),apply_metadata:input.apply_metadata??preferences.value.analysis_fill===true}
    const items=await locked(async()=>{const current=await entries();if(current.some(v=>v.id===input.id))return current;return (await change(values=>values.some(v=>v.id===item.id)?values:[...values,item])).value.entries})
    wake();const index=items.findIndex(v=>v.id===input.id);return queued(items[index],index)
  }
  async function drain(){
    if(disposed||draining)return;draining=true
    try{
      while(!disposed){
        const preferences=await settings.get()
        if(!preferences.available||preferences.value?.auto_analysis!==true)break
        const available=typeof analysis.slots==='function'?analysis.slots():analysis.busy()?0:1
        if(available<=0){wakeLater=true;break}
        const first=(await entries()).find(item=>!inFlight.has(item.id));if(!first)break
        inFlight.add(first.id)
        // Each admission settles independently; completion wakes the next drain.
        void settle(first,preferences).finally(()=>{inFlight.delete(first.id);wake()})
      }
    }catch{wakeLater=true}finally{draining=false;if(wakeLater){wakeLater=false;wake(1500)}}
  }
  async function settle(first,preferences){
    let remove=false
    try{
      // Use current fill choice, while keeping the accepted page selection.
      const response=await locked(async()=>{
        if(!(await entries()).some(item=>item.id===first.id&&item.request_id===first.request_id))return null
        return analysis({action:'paper_analysis_start',...first,reuse:true,apply_metadata:preferences.value.analysis_fill===true})
      })
      if(!response)return
      await analysis.wait(first.id,response.request_id||first.request_id)
      if(disposed)return
      remove=true
    }catch(error){
      if(error.code==='ANALYSIS_BUSY'){wakeLater=true;return}
      await remember(first.id,{id:first.id,request_id:first.request_id,status:'failed',stage:'自动整理未完成',error:String(error.message).slice(0,1200)})
      remove=true
    }finally{
      if(remove)await locked(()=>change(values=>values.filter(item=>item.id!==first.id)))
    }
  }
  let wakeLater=false
  const unsubscribe=settings.subscribe?.(()=>wake())
  const ready=Promise.resolve().then(()=>{wake()})
  async function handle(input){
    if(input?.action==='paper_analysis_start'&&input.reuse===true)return enqueue(input)
    if(input?.action==='paper_analysis_get'&&valid(input.id)){
      const actual=await analysis(input);if(actual.status!=='idle')return actual
      const values=await entries(),position=values.findIndex(v=>v.id===input.id&&(input.request_id===undefined||v.request_id===input.request_id))
      const saved=await result(input.id)
      return position>=0?queued(values[position],position):saved&&(input.request_id===undefined||saved.request_id===input.request_id)?saved:actual
    }
    if(['paper_analysis_cancel','paper_analysis_start'].includes(input?.action)&&valid(input.id)){
      let removed
      await locked(()=>change(values=>values.filter(item=>{
        const matches=item.id===input.id&&(input.action!=='paper_analysis_cancel'||input.request_id===undefined||item.request_id===input.request_id)
        if(matches)removed=item
        return !matches
      })))
      if(input.action==='paper_analysis_cancel'){
        const actual=await analysis({action:'paper_analysis_get',id:input.id,...(input.request_id?{request_id:input.request_id}:{})})
        if(actual.status==='idle'&&removed){const cancelled={id:input.id,request_id:removed.request_id,status:'cancelled',stage:'已取消排队'};await remember(input.id,cancelled);return cancelled}
      }else{const old=await store.get(resultKey(input.id));if(old.value)await store.put(resultKey(input.id),null,old.revision)}
    }
    return analysis(input)
  }
  handle.imported=async items=>{
    const outcomes=[]
    for(const item of items||[])if(valid(item?.id)&&item.pdf&&!item.archived){
      try{outcomes.push(await enqueue({id:item.id,request_id:`import-${hash(item.id).slice(0,32)}`}))}
      catch(error){outcomes.push({id:item.id,status:'failed',error:String(error.message).slice(0,1200)})}
    }
    return outcomes
  }
  handle.ready=ready
  handle.dispose=()=>{disposed=true;clearTimeout(timer);unsubscribe?.();analysis.dispose()}
  return handle
}
