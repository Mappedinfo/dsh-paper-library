/** 收藏与续写位置只保存导航元数据；源码历史仍由 LaTeX 项目自身维护。 */
const INDEX = 'reader:latex-projects:index', PREFIX = 'reader:latex-projects:session:'
const fail = message => Object.assign(new Error(message), { code: 'LATEX_MEMORY_INVALID', status: 400 })
const text = (value, max, name) => { if (typeof value !== 'string' || value.length > max) throw fail(`${name}无效。`); return value }
const idOf = value => { if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(value)) throw fail('项目标识无效。'); return value }
function integer(value, min, max, name) { if (!Number.isSafeInteger(value) || value < min || value > max) throw fail(`${name}无效。`); return value }
const indexOf = value => ({ favorites: Array.isArray(value?.favorites) ? value.favorites.slice(0,200) : [], recent: Array.isArray(value?.recent) ? value.recent.slice(0,50) : [] })
function sessionOf(value) {
  const path = text(value.path, 4096, '相对文件路径')
  if (!path || path.startsWith('/') || /(^|[\\/])\.\.([\\/]|$)|[\x00-\x1f]/.test(path)) throw fail('续写文件必须位于当前项目内。')
  const zoom = value.zoom ?? 1
  if (![1,1.25,1.5,2,3,4].includes(zoom)) throw fail('PDF 缩放无效。')
  const layout = value.layout ?? 'split'
  if (!['source','split','pdf'].includes(layout)) throw fail('编辑布局无效。')
  return { root: text(value.root ?? '',4096,'项目位置'), binding_generation: integer(value.binding_generation ?? 0,0,1e9,'项目位置版本'), path,
    revision: text(value.revision ?? '',200,'源码版本'),
    selection_start: integer(value.selection_start ?? 0,0,10000000,'光标位置'), selection_end: integer(value.selection_end ?? 0,0,10000000,'选区位置'),
    line: integer(value.line ?? 1,1,10000000,'行号'), column: integer(value.column ?? 0,0,10000000,'列号'),
    scroll_top: integer(Math.round(value.scroll_top ?? 0),0,100000000,'滚动位置'),
    pdf_page: integer(value.pdf_page ?? 1,1,100000,'PDF 页码'), zoom, layout }
}
export function createLatexProjectMemory({ store }) {
  async function mutate(key, update) {
    for (let attempt=0; attempt<4; attempt++) {
      const record = await store.get(key), value = update(record.value)
      try { return await store.put(key,value,record.revision) }
      catch(error) { if(error.code!=='STATE_CONFLICT'||attempt===3)throw error }
    }
  }
  async function handle(input) {
    if(input.action==='latex_memory_get') {
      const index=indexOf((await store.get(INDEX)).value)
      return { ...index, last_project:index.recent[0]?.id || null, ...(input.id ? { session:(await store.get(PREFIX+idOf(input.id))).value } : {}) }
    }
    const id=idOf(input.id), title=text(input.title ?? id,300,'项目标题'), now=new Date().toISOString()
    if(input.action==='latex_favorite_set') {
      if(typeof input.favorite!=='boolean')throw fail('收藏状态无效。')
      const saved=await mutate(INDEX,value=>{
        const index=indexOf(value), favorites=index.favorites.filter(item=>item.id!==id)
        if(input.favorite){if(favorites.length>=200)throw fail('最多收藏 200 个项目，请先整理收藏。');favorites.unshift({id,title,added_at:now})}
        return {...index,favorites}
      })
      return {...saved.value,last_project:saved.value.recent[0]?.id || null}
    }
    if(input.action==='latex_memory_save') {
      const incoming=sessionOf(input), saved=await mutate(PREFIX+id,previous=>({...incoming,updated_at:now,
        saved_at:input.source_saved===true ? now : (previous?.root===incoming.root&&previous?.binding_generation===incoming.binding_generation?previous.saved_at:null) || null }))
      const updated=await mutate(INDEX,value=>{
        const index=indexOf(value)
        return {...index,recent:[{id,title,file:incoming.path.split('/').at(-1).slice(0,200),updated_at:now,saved_at:saved.value.saved_at},...index.recent.filter(item=>item.id!==id)].slice(0,50)}
      })
      return { ...updated.value, last_project:id, session:saved.value }
    }
    throw fail('未知的项目续写操作。')
  }
  return handle
}
