'use strict';
// Personal organization is separate from imported bibliographic tags.
window.PaperOrganization = (() => {
  const node = (tag, text, className) => { const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(className)n.className=className;return n; };
  const button = (text, action, className='button subtle') => { const b=node('button',text,className);b.type='button';b.addEventListener('click',action);return b; };
  const label = value => '#'+String(typeof value==='string'?value:value?.tag||value?.name||'').replace(/^#+/,'').split('/').map(s=>s.trim()).join('/');
  const tags = item => [...new Set([...(item.tags||[]),...(item.manual_tags||[])].map(label).filter(t=>t!=='#'))];
  const isPaper = item => item && (!item.resource_kind || item.resource_kind==='paper');
  function create({state,api,loadList,onChanged,toast,root}) {
    const busy=new Set();let ticket=0,tagOffset=0,tagNext=null,timer,editing=null,editTicket=0;
    const controls=node('div',undefined,'paper-organization-filters');
    const favorite=button('☆ 偏好论文',()=>{state.favorite=!state.favorite;apply();});favorite.id='catalog-favorite';
    const picker=node('details',undefined,'paper-tag-picker'),summary=node('summary','标签筛选');summary.title='搜索标签；选择父标签时包含所有子标签';
    const popup=node('div',undefined,'paper-tag-popup'),search=node('input');search.type='search';search.maxLength=200;search.placeholder='搜索 #标签/子标签';search.setAttribute('aria-label','搜索标签');
    const results=node('div',undefined,'paper-tag-results'),status=node('span',undefined,'small muted');status.setAttribute('role','status');
    const previous=button('上一页',()=>{tagOffset=Math.max(0,tagOffset-30);void loadTags();}),next=button('下一页',()=>{if(tagNext!==null){tagOffset=tagNext;void loadTags();}});
    const pager=node('div',undefined,'paper-tag-pager');pager.append(previous,status,next);
    const exact=button('按输入标签筛选',()=>filterTag(search.value));
    popup.append(search,exact,results,pager);picker.append(summary,popup);
    const active=button('',()=>filterTag(''),'button subtle active-tag-filter');active.id='catalog-tag-clear';
    controls.append(favorite,picker,active);root.append(controls);
    function sync(){favorite.textContent=state.favorite?'★ 偏好论文':'☆ 偏好论文';favorite.setAttribute('aria-pressed',String(Boolean(state.favorite)));active.hidden=!state.tag;active.textContent=state.tag?`${state.tag} ×`:'';active.title='清除标签筛选';}
    function apply(){state.offset=0;sync();void loadList();if(picker.open){tagOffset=0;void loadTags();}}
    function filterTag(value){state.tag=value.trim()?label(value.trim()):'';picker.open=false;apply();}
    async function loadTags(){
      const request=++ticket;previous.disabled=true;next.disabled=true;status.textContent='读取中…';results.replaceChildren();
      try{
        const result=await api('paper_tags_list',{query:search.value.trim(),offset:tagOffset,limit:30,archived:Boolean(state.archived),favorite:Boolean(state.favorite),...(state.project?{project:state.project}:{})});
        if(request!==ticket)return;
        for(const entry of result.items||[]){const b=button(`${entry.tag} · ${entry.count}`,()=>filterTag(entry.tag),'paper-tag-option');results.append(b);}
        tagNext=result.next_offset??null;previous.disabled=tagOffset===0;next.disabled=tagNext===null;
        status.textContent=result.total?`${tagOffset+1}–${tagOffset+(result.items||[]).length} / ${result.total}`:'没有匹配标签';
      }catch(error){if(request!==ticket)return;status.textContent='标签读取失败';results.append(button('重试',()=>void loadTags()));toast(error.message,true);}
    }
    picker.addEventListener('toggle',()=>{if(picker.open){const box=summary.getBoundingClientRect();popup.style.left=`${Math.max(8,Math.min(box.left,window.innerWidth-285))}px`;popup.style.top=`${Math.max(8,Math.min(box.bottom+6,window.innerHeight-390))}px`;tagOffset=0;void loadTags();}else{++ticket;clearTimeout(timer);}});
    document.addEventListener('pointerdown',event=>{if(picker.open&&!picker.contains(event.target))picker.open=false;});
    window.addEventListener('resize',()=>{picker.open=false;});
    search.addEventListener('input',()=>{++ticket;clearTimeout(timer);timer=setTimeout(()=>{tagOffset=0;void loadTags();},180);});
    search.addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();filterTag(search.value);}if(event.key==='Escape')picker.open=false;});
    const dialog=node('dialog',undefined,'paper-tag-editor');dialog.id='paper-tag-editor';dialog.setAttribute('aria-labelledby','paper-tag-editor-title');
    const heading=node('header'),title=node('h2','编辑标签');title.id='paper-tag-editor-title';const close=button('×',()=>dialog.close(),'icon-button');close.setAttribute('aria-label','关闭标签编辑');heading.append(title,close);
    const paperTitle=node('p',undefined,'small muted'),sourceTags=node('div',undefined,'paper-tag-sources'),form=node('form'),field=node('label','手动标签','field'),input=node('textarea');input.rows=4;input.maxLength=21000;input.placeholder='#方法/深度学习/Transformer\n#阅读/待复习';input.setAttribute('aria-label','手动标签');field.append(input);
    const hint=node('p','每行一个标签，也可用逗号分隔。父标签筛选包含全部子标签。','small muted'),error=node('p',undefined,'error');error.setAttribute('role','alert');
    const save=node('button','保存标签','button primary');save.type='submit';form.append(field,hint,error,save);dialog.append(heading,paperTitle,sourceTags,form);document.body.append(dialog);
    dialog.addEventListener('close',()=>{++editTicket;editing=null;});
    async function edit(item){
      const request=++editTicket;
      try{
        const current=await api('get',{id:item.id});if(request!==editTicket)return;
        editing=current;paperTitle.textContent=current.title||'未命名文献';input.value=(current.manual_tags||[]).join('\n');error.textContent='';save.disabled=false;input.disabled=false;
        sourceTags.replaceChildren();if(current.tags?.length){sourceTags.append(node('span','资料标签（来源保留）','small muted'));for(const tag of tags({tags:current.tags}))sourceTags.append(node('span',tag,'chip'));}
        if(!dialog.open)dialog.showModal();input.focus();
      }catch(e){if(request===editTicket)toast(`无法读取标签：${e.message}`,true);}
    }
    form.addEventListener('submit',async event=>{
      event.preventDefault();if(!editing||save.disabled)return;
      const item=editing,request=editTicket;save.disabled=true;input.disabled=true;error.textContent='';
      try{
        const patch=await api('paper_organization_update',{id:item.id,tags:input.value.split(/[,，\n]/).map(t=>t.trim()).filter(Boolean),expected_organization_modified:item.organization_modified??null});
        onChanged(patch);if(request===editTicket)dialog.close();await loadList();
      }catch(e){if(request===editTicket)error.textContent=e.message;else toast(e.message,true);}
      finally{if(request===editTicket){save.disabled=false;input.disabled=false;}}
    });
    async function toggle(item){
      if(busy.has(item.id))return;busy.add(item.id);refreshBusy(item.id,true);
      try{const patch=await api('paper_organization_update',{id:item.id,favorite:!item.favorite});onChanged(patch);await loadList();}
      catch(error){toast(`偏好未保存：${error.message}`,true);}
      finally{busy.delete(item.id);refreshBusy(item.id,false);}
    }
    function refreshBusy(id,value){for(const b of document.querySelectorAll('[data-organization-star]'))if(b.dataset.organizationStar===id)b.disabled=value;}
    function chip(tag){const b=button(tag,()=>filterTag(tag),'chip paper-tag-chip');b.title=`筛选 ${tag} 及其子标签`;return b;}
    function actions(item,{compact=false}={}){
      const row=node('div',undefined,'paper-organization-actions');if(!isPaper(item))return row;
      const star=button(item.favorite?'★':'☆',()=>void toggle(item),'paper-favorite');star.dataset.organizationStar=item.id;star.title=item.favorite?'取消偏好论文':'加入偏好论文';star.setAttribute('aria-label',star.title);star.setAttribute('aria-pressed',String(Boolean(item.favorite)));star.disabled=busy.has(item.id);
      if(!item.archived)row.append(star,button('标签',()=>void edit(item),'paper-tag-edit'));
      const values=tags(item);for(const tag of (compact?values.slice(0,3):values))row.append(chip(tag));
      if(compact&&values.length>3&&!item.archived)row.append(button(`+${values.length-3}`,()=>void edit(item),'paper-tag-edit'));
      return row;
    }
    sync();return {actions,edit,filterTag,sync};
  }
  return {create,tags};
})();
