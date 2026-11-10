import { createHash } from 'node:crypto'

const hash=value=>createHash('sha256').update(value).digest('hex')
const text=value=>typeof value==='string'?value.trim():''
const doi=value=>text(value).replace(/^https?:\/\/(?:dx\.)?doi\.org\/|^doi:\s*/i,'').toLowerCase()
const identity=value=>text(value).normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu,'')
const MAX_TEXT=8000
const failure=(message,status=400)=>Object.assign(Error(message),{status})
const stableId=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$/.test(value)

function reference(input){
  if(!stableId(input.id))throw failure('请选择有效的文献。')
  if(input.topic_id===undefined)return {id:input.id}
  if(!stableId(input.topic_id)||typeof input.expected_revision!=='string'||!input.expected_revision||input.expected_revision.length>200)
    throw failure('请刷新研究主题后再读取摘要。')
  return {id:input.id,topic_id:input.topic_id,expected_revision:input.expected_revision}
}

/** The browser chooses one record. Only source text read by this service can reach translation. */
export function createPaperAbstracts({store,radar,request,extract,lookup,language,canTranslate}){
  const readings=new Map(), previews=new Map(), translations=new Map()
  const result=(title,original,source)=>({title,text:original.slice(0,MAX_TEXT),source,truncated:original.length>MAX_TEXT})
  async function resolve(ref,signal){
    let paper,local
    if(ref.topic_id){
      const record=await radar.get(ref.topic_id)
      if(record.revision!==ref.expected_revision)throw failure('研究主题已更新，请刷新后重新读取摘要。',409)
      paper=record.document?.papers?.find(row=>row.id===ref.id)
      if(!paper)throw failure('主题中没有这篇文献。',404)
      if(text(paper.abstract))return result(paper.title,text(paper.abstract),{kind:'radar'})
      const title=identity(paper.title), identifier=doi(paper.doi), refs=new Set(paper.source_ids)
      const candidates=record.document.sources.filter(source=>{
        if(!refs.has(source.id)||!text(source.abstract))return false
        const raw=doi(source.doi||source.url), sourceDoi=raw.startsWith('10.')?raw:''
        if(identifier&&sourceDoi)return identifier===sourceDoi
        return title.length>=8&&identity(source.title)===title
      })
      if(candidates.length&&new Set(candidates.map(source=>text(source.abstract))).size===1)
        return result(paper.title,text(candidates[0].abstract),{kind:'radar',url:candidates[0].url})
      const matched=await radar.handle({action:'field_radar_match',limit:1,papers:[{
        id:paper.id,title:paper.title,...(text(paper.doi)?{doi:paper.doi}:{}),...(stableId(paper.local_paper_id)?{local_paper_id:paper.local_paper_id}:{})
      }]},{signal})
      const match=matched.matches?.[0]
      if(match?.status==='matched'&&match.candidates?.length===1)local=await request({action:'get',id:match.candidates[0].id},signal)
    }else{
      local=await request({action:'get',id:ref.id},signal)
      paper=local
    }
    if(text(local?.abstract))return result(paper.title,text(local.abstract),{kind:'catalog'})
    let unreadable=false
    if(local?.pdf){
      try{
        const found=await extract(local.id,signal)
        if(text(found.text))return result(paper.title,text(found.text),{kind:'pdf',page:found.page})
      }catch(error){signal?.throwIfAborted();unreadable=true}
    }
    const identifier=doi(paper.doi||local?.DOI)
    if(/^10\.\d{4,9}\/\S+$/u.test(identifier)&&identifier.length<=512){
      const response=await lookup(identifier,signal), metadata=response.metadata
      if(doi(metadata?.DOI)===identifier&&text(metadata?.abstract))
        return result(paper.title,text(metadata.abstract),{kind:'doi',url:`https://doi.org/${identifier}`})
      unreadable ||= Boolean(response.warnings?.length)
    }
    return {title:paper.title,text:null,unreadable}
  }
  async function read(ref,signal){
    const id=JSON.stringify(ref)
    if(readings.has(id))return readings.get(id)
    if(readings.size>=4)throw failure('摘要读取繁忙，请稍后重试。',429)
    const run=resolve(ref,signal).finally(()=>readings.delete(id))
    readings.set(id,run)
    return run
  }
  const stateKey=(digest,target)=>`abstract.translation:${hash(JSON.stringify([1,digest,target]))}`
  function status(record,key){
    if(record?.status==='complete')return 'complete'
    if(translations.has(key))return 'ready'
    if(record?.status==='failed')return 'failed'
    if(record?.status==='pending')return 'pending'
    return canTranslate?'ready':'unavailable'
  }
  async function view(ref,source){
    if(!source.text||source.truncated)return source
    const source_hash=hash(source.text), target=await language.abstractTarget(source.text)
    const key=stateKey(source_hash,target), saved=(await store.get(key)).value
    previews.set(JSON.stringify([ref,source_hash]),{source,until:Date.now()+5*60_000})
    while(previews.size>24)previews.delete(previews.keys().next().value)
    return {...source,source_hash,target_language:target,translation_status:status(saved,key),...(saved?.status==='complete'?{translation:saved.translation}:{})}
  }
  return async (input,{signal}={})=>{
    const ref=reference(input)
    if(input.action==='paper_abstract_read')return view(ref,await read(ref,signal))
    if(typeof input.source_hash!=='string'||!/^[a-f0-9]{64}$/.test(input.source_hash))throw failure('请重新读取摘要原文。')
    const previous=previews.get(JSON.stringify([ref,input.source_hash]))
    const source=previous?.until>Date.now()?previous.source:await read(ref,signal)
    if(!source.text||source.truncated||hash(source.text)!==input.source_hash)throw failure('摘要已变化，请重新读取。',409)
    const target=await language.abstractTarget(source.text)
    if(target!==input.target_language)throw failure('翻译语言已变化，请重新打开摘要。',409)
    const key=stateKey(input.source_hash,target)
    if(translations.has(key))return translations.get(key)
    const run=async()=>{
      let current=await store.get(key)
      if(current.value?.status==='complete')return {translation_status:'complete',translation:current.value.translation}
      if(!canTranslate)return {translation_status:'unavailable'}
      if(current.value?.status==='failed'&&input.retry!==true)return {translation_status:'failed'}
      if(current.value?.status==='pending'){
        const aged=Date.now()-Date.parse(current.updated_at)>180_000
        if(!aged||input.retry!==true)return {translation_status:'pending'}
      }
      try{current=await store.put(key,{status:'pending'},current.revision)}
      catch(error){
        if(error.code==='STATE_CONFLICT')return {translation_status:'pending'}
        throw error
      }
      try{
        const translation=await language.translateAbstract({text:source.text,target},{signal})
        await store.put(key,{status:'complete',translation},current.revision)
        return {translation_status:'complete',translation}
      }catch(error){
        // A retry is a new explicit request. Opening another window cannot
        // start another model call for a failed or uncertain attempt.
        await store.put(key,{status:'failed'},current.revision)
        throw error
      }
    }
    if(translations.size>=2)throw failure('摘要翻译正在处理其他文献，请稍后重试。',429)
    const flight=run().finally(()=>translations.delete(key))
    translations.set(key,flight)
    return flight
  }
}
