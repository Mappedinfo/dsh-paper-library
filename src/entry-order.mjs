// 同一套排序用于百科与难词本；先排序再分页，避免仅重排当前页。
export function entryOrder(value='term_asc') {
  if(!['term_asc','term_desc','created_desc','created_asc','updated_desc','id'].includes(value))throw Error('词条排序方式无效。');
  const names=(a,b)=>String(a.term||'').localeCompare(String(b.term||''),'zh-CN',{sensitivity:'base',numeric:true})||String(a.id||a.key).localeCompare(String(b.id||b.key));
  return value==='id'?(a,b)=>String(a.id||a.key).localeCompare(String(b.id||b.key))
    :value==='term_asc'?names:value==='term_desc'?(a,b)=>-names(a,b)
    :(a,b)=>{const field=value==='updated_desc'?'updated_at':'created_at',direction=value==='created_asc'?1:-1;return direction*String(a[field]||'').localeCompare(String(b[field]||''))||names(a,b);};
}
