'use strict';
// Personal organization is separate from imported bibliographic tags.
window.PaperOrganization = (() => {
  const node = (tag, text, className) => { const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(className)n.className=className;return n; };
  const button = (text, action, className='button subtle') => { const b=node('button',text,className);b.type='button';b.addEventListener('click',action);return b; };
  const label = value => '#'+String(typeof value==='string'?value:value?.tag||value?.name||'').replace(/^#+/,'').split('/').map(s=>s.trim()).join('/');
  const sourceLabels = item => [...new Set((item.tags||[]).map(label).filter(t=>t!=='#'))];
  const tags = item => [...new Set([...sourceLabels(item).filter(tag=>!item.hidden_source_tags?.includes(tag)),...(item.manual_tags||[]).map(label)].filter(t=>t!=='#'))];
  const isPaper = item => item && (!item.resource_kind || item.resource_kind==='paper');
  function create({state,api,loadList,onChanged,toast,root}) {
    const distribution=window.PaperReadingDistribution?.create({api});
    const busy=new Set();let pickerOpen=false,ticket=0,tagOffset=0,tagNext=null,timer,editing=null,editTicket=0,hiddenSources=new Set();
    const controls=node('div',undefined,'paper-organization-filters');
    const favorite=button('☆ 偏好论文',()=>{state.favorite=!state.favorite;apply();});favorite.id='catalog-favorite';
    const picker=node('div',undefined,'paper-tag-picker'),summary=button('标签筛选',()=>setPickerOpen(!pickerOpen));summary.id='catalog-tag-picker';summary.setAttribute('aria-expanded','false');summary.setAttribute('aria-controls','paper-tag-popup');summary.title='搜索标签；选择父标签时包含所有子标签';
    const popup=node('div',undefined,'paper-tag-popup'),search=node('input');search.type='search';search.maxLength=200;search.placeholder='搜索 #标签/子标签';search.setAttribute('aria-label','搜索标签');
    popup.id='paper-tag-popup';popup.hidden=true;
    const results=node('div',undefined,'paper-tag-results'),status=node('span',undefined,'small muted');status.setAttribute('role','status');
    const previous=button('上一页',()=>{tagOffset=Math.max(0,tagOffset-30);void loadTags();}),next=button('下一页',()=>{if(tagNext!==null){tagOffset=tagNext;void loadTags();}});
    const pager=node('div',undefined,'paper-tag-pager');pager.append(previous,status,next);
    const exact=button('按输入标签筛选',()=>filterTag(search.value));
    popup.append(search,exact,results,pager);picker.append(summary,popup);
    const active=button('',()=>filterTag(''),'button subtle active-tag-filter');active.id='catalog-tag-clear';
    controls.append(favorite,picker,active);root.append(controls);
    function sync(){favorite.textContent=state.favorite?'★ 偏好论文':'☆ 偏好论文';favorite.setAttribute('aria-pressed',String(Boolean(state.favorite)));active.hidden=!state.tag;active.textContent=state.tag?`${state.tag} ×`:'';active.title='清除标签筛选';}
    function apply(){state.offset=0;sync();void loadList();if(pickerOpen){tagOffset=0;void loadTags();}}
    function filterTag(value){state.tag=value.trim()?label(value.trim()):'';setPickerOpen(false);apply();}
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
    function placePicker(){if(!pickerOpen)return;const box=summary.getBoundingClientRect();popup.style.left=`${Math.max(8,Math.min(box.left,window.innerWidth-285))}px`;popup.style.top=`${Math.max(8,Math.min(box.bottom+6,window.innerHeight-390))}px`;}
    function setPickerOpen(value){if(pickerOpen===value)return;pickerOpen=value;popup.hidden=!value;summary.setAttribute('aria-expanded',String(value));if(value){placePicker();tagOffset=0;void loadTags();}else{++ticket;clearTimeout(timer);}}
    document.addEventListener('pointerdown',event=>{if(pickerOpen&&!picker.contains(event.target))setPickerOpen(false);});
    picker.addEventListener('keydown',event=>{if(event.key==='Escape'){setPickerOpen(false);summary.focus();}});
    // 宿主分栏与阅读页面会触发 iframe resize，保留正在操作的标签菜单。
    window.addEventListener('resize',placePicker);
    search.addEventListener('input',()=>{++ticket;clearTimeout(timer);timer=setTimeout(()=>{tagOffset=0;void loadTags();},180);});
    search.addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();filterTag(search.value);}if(event.key==='Escape')setPickerOpen(false);});
    const dialog=node('dialog',undefined,'paper-tag-editor');dialog.id='paper-tag-editor';dialog.setAttribute('aria-labelledby','paper-tag-editor-title');
    const heading=node('header'),title=node('h2','管理标签');title.id='paper-tag-editor-title';const close=button('×',()=>dialog.close(),'icon-button');close.setAttribute('aria-label','关闭标签编辑');heading.append(title,close);
    const paperTitle=node('p',undefined,'small muted'),sourceTags=node('div',undefined,'paper-tag-sources'),manualTags=node('div',undefined,'paper-tag-sources'),form=node('form'),field=node('label','手动标签','field'),input=node('textarea');input.rows=4;input.maxLength=21000;input.placeholder='#方法/深度学习/Transformer\n#阅读/待复习';input.setAttribute('aria-label','手动标签');field.append(input);
    const hint=node('p','在下方输入手动标签，每行一个，也可用逗号分隔。资料标签移除后仍可恢复。','small muted'),error=node('p',undefined,'error');error.setAttribute('role','alert');
    const save=node('button','保存标签','button primary');save.type='submit';form.append(sourceTags,manualTags,hint,field,error,save);dialog.append(heading,paperTitle,form);document.body.append(dialog);
    dialog.addEventListener('close',()=>{++editTicket;editing=null;});
    const manualValues=()=>input.value.split('\n').flatMap(line=>{
      const value=line.trim();
      return editing?.manual_tags?.includes(value)?[value]:value.split(/[,，]/).map(tag=>tag.trim()).filter(Boolean);
    });
    function renderEditorTags(){
      sourceTags.replaceChildren();
      manualTags.replaceChildren();
      const sources=sourceLabels(editing);
      if(sources.length)sourceTags.append(node('span','资料标签','small muted'));
      for(const tag of sources){
        const hidden=hiddenSources.has(tag);
        const toggle=button(hidden?`恢复 ${tag}`:`${tag} ×`,()=>{
          if(hidden)hiddenSources.delete(tag);
          else{hiddenSources.add(tag);input.value=manualValues().filter(value=>label(value)!==tag).join('\n');}
          renderEditorTags();
          [...sourceTags.querySelectorAll('button')].find(b=>b.dataset.tag===tag)?.focus();
        },'paper-tag-chip');
        toggle.dataset.tag=tag;toggle.setAttribute('aria-label',`${hidden?'恢复':'移除'}资料标签 ${tag}`);sourceTags.append(toggle);
      }
      const values=[...new Set(manualValues().map(label).filter(tag=>tag!=='#'))];
      if(values.length)manualTags.append(node('span','手动标签','small muted'));
      for(const tag of values){
        const remove=button(`${tag} ×`,()=>{
          input.value=manualValues().filter(value=>label(value)!==tag).join('\n');
          renderEditorTags();input.focus();
        },'paper-tag-chip');
        remove.setAttribute('aria-label',`删除手动标签 ${tag}`);manualTags.append(remove);
      }
    }
    input.addEventListener('input',()=>{if(editing)renderEditorTags();});
    async function edit(item){
      const request=++editTicket;
      try{
        const current=await api('get',{id:item.id});if(request!==editTicket)return;
        editing=current;paperTitle.textContent=current.title||'未命名文献';input.value=(current.manual_tags||[]).join('\n');error.textContent='';save.disabled=false;input.disabled=false;
        hiddenSources=new Set(current.hidden_source_tags||[]);renderEditorTags();
        if(!dialog.open)dialog.showModal();input.focus();
      }catch(e){if(request===editTicket)toast(`无法读取标签：${e.message}`,true);}
    }
    form.addEventListener('submit',async event=>{
      event.preventDefault();if(!editing||save.disabled)return;
      const item=editing,request=editTicket;save.disabled=true;input.disabled=true;error.textContent='';
      const tagButtons=[...form.querySelectorAll('.paper-tag-chip')];tagButtons.forEach(b=>b.disabled=true);
      try{
        const hidden=[...hiddenSources].sort();
        const patch=await api('paper_organization_update',{id:item.id,tags:manualValues(),expected_organization_modified:item.organization_modified??null,
          ...(JSON.stringify(hidden)!==JSON.stringify([...(item.hidden_source_tags||[])].sort())?{hidden_source_tags:hidden}:{})});
        onChanged(patch);if(request===editTicket)dialog.close();await loadList();
      }catch(e){if(request===editTicket)error.textContent=e.message;else toast(e.message,true);}
      finally{if(request===editTicket){save.disabled=false;input.disabled=false;tagButtons.forEach(b=>b.disabled=false);}}
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
      if(distribution&&!item.archived)row.append(distribution.mount(item));
      const values=tags(item);for(const tag of (compact?values.slice(0,3):values))row.append(chip(tag));
      if(compact&&values.length>3&&!item.archived)row.append(button(`+${values.length-3}`,()=>void edit(item),'paper-tag-edit'));
      return row;
    }
    sync();return {actions,edit,filterTag,sync,applyPreferences:value=>distribution?.applyPreferences(value),invalidateDistribution:id=>distribution?.invalidate(id),dispose:()=>distribution?.dispose()};
  }
  return {create,tags};
})();
