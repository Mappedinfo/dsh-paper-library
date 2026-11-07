import { createHash } from 'node:crypto'
const normalize = value => value.normalize('NFKC').toLocaleLowerCase('und').replace(/\s+/g,' ').trim()
const text = (value,max,required=false) => {if(typeof value!=='string'||value.length>max||(required&&!value.trim()))throw Error('词条字段为空或超过长度限制。');return value.trim()}
const kinds = ['term','organization','abbreviation','person','concept']
/** 资料库内的人工词条；来源原文不作为释义，所有更新使用修订校验。 */
export function createEncyclopedia({store,dispatch,library,python}) {
  async function scan(query='') {
    const variants=[query];const phrase=query.match(/^(.*?)\s*[(（]([^()（）]+)[)）]$/);if(phrase)variants.push(...phrase.slice(1).map(normalize).filter(Boolean));
    const rows=[];let offset=0,truncated=false;
    while(offset<5000){const page=await store.list({prefix:'encyclopedia:',offset,limit:50});for(const record of page.records){const v=record.value;if(v&&!v.deleted&&(!query||variants.some(part=>normalize([v.term,...v.aliases,v.definition].join(' ')).includes(part))))rows.push({key:record.key,term:v.term,aliases:v.aliases});}if(!page.hasMore)break;if(!Number.isSafeInteger(page.next_offset)||page.next_offset<=offset)throw Error('词条分页异常。');offset=page.next_offset;truncated=offset>=5000;}
    return {rows,truncated};
  }
  return async input=>{
    if(input.action==='encyclopedia_list'){
      const query=normalize(text(input.query??'',200)),offset=input.offset??0,limit=input.limit??30;
      if(!Number.isSafeInteger(offset)||offset<0||offset>5000||!Number.isSafeInteger(limit)||limit<1||limit>50)throw Error('词条分页无效。');
      const {rows,truncated}=await scan(query);rows.sort((a,b)=>Number(normalize(b.term)===query||b.aliases.some(x=>normalize(x)===query))-Number(normalize(a.term)===query||a.aliases.some(x=>normalize(x)===query))||a.term.localeCompare(b.term));
      const items=[];for(const row of rows.slice(offset,offset+limit)){const record=await store.get(row.key);if(record.value&&!record.value.deleted)items.push({...record.value,revision:record.revision});}
      return {items,total:rows.length,offset,hasMore:offset+limit<rows.length,truncated};
    }
    if(input.action!=='encyclopedia_put')throw Error('未知词条操作。');
    const term=text(input.term,200,true),id=createHash('sha256').update(normalize(term)).digest('hex'),key=`encyclopedia:${id}`,current=await store.get(key);
    if(current.revision!==input.expected_revision)throw Object.assign(Error('词条已更新，请重新打开后保存。'),{code:'STATE_CONFLICT',status:409});
    const kind=input.kind??'term';if(!kinds.includes(kind))throw Error('词条类型无效。');
    if(!Array.isArray(input.aliases)||input.aliases.length>20)throw Error('别名最多 20 条。');
    const aliases=[...new Set(input.aliases.map(value=>text(value,200,true)))],definition=text(input.definition??'',12000);
    const sources=[...(current.value?.sources||[])];
    if(input.source){const source=input.source;if(typeof source.paper_id!=='string'||!/^[A-Za-z0-9_-]{1,160}$/.test(source.paper_id)||!Number.isSafeInteger(source.page)||source.page<1||source.page>2000)throw Error('词条来源无效。');
      const item=await dispatch({action:'get',id:source.paper_id},{library,python});
      const quote=text(source.quote,2000,true),annotation_id=source.annotation_id?text(source.annotation_id,160):null;
      if(!sources.some(s=>s.paper_id===item.id&&s.page===source.page&&s.quote===quote)){if(sources.length>=60)throw Error('词条来源已达到 60 条上限。');sources.push({paper_id:item.id,title:item.title,page:source.page,annotation_id,quote});}
    }
    const value={id,term,kind,aliases,definition,sources,author:'user',created_at:current.value?.created_at||new Date().toISOString(),updated_at:new Date().toISOString()};
    const saved=await store.put(key,value,current.revision);return {...value,revision:saved.revision};
  }
}
