'use strict';
// Dataset identities use the disk catalog. Only the selected item and one page of
// children are loaded; previews are requested explicitly and can be cancelled.
window.ResourceLibrary = (() => {
  const $=id=>document.getElementById(id);
  const node=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;};
  const button=(text,fn,id)=>{const n=node('button',text,'button subtle');n.type='button';if(id)n.id=id;n.addEventListener('click',fn);return n;};
  const choices=(values,selected='')=>{const n=node('select');for(const [value,label]of values){const o=node('option',label);o.value=value;n.append(o);}n.value=selected;return n;};
  const relations=[['mentions','提及'],['cites','引用'],['uses','实际使用'],['produces','发布'],['describes','介绍']];
  const statuses=[['needs-review','待核对'],['accepted','已核对'],['rejected','已否决']];
  const items=result=>result?.items||[];
  function create({state,api,persistence,toast,loadList,openPaper,workbench,readingShell,knowledge,prepare,changed,panels,requestPage,openDatasetCatalog,openDataset,refreshDatasetCatalog,renderDatasetCatalog,returnToPaper}) {
    let ticket=0,entity=null,previewController=null,dialogTicket=0,saveDraft=null,previewAsset=null,dialogOwner=null,dialogIntent=0,dialogSaving=false,closeFlight=null;
    const root=node('section',undefined,'resource-detail');root.id='dataset-detail';root.hidden=true;root.setAttribute('aria-label','数据集详情');document.querySelector('.detail-pane').append(root);
    const toolbar=node('div',undefined,'resource-toolbar');toolbar.id='toolbar-dataset';toolbar.hidden=true;$('paper-tools').append(toolbar);
    toolbar.append(button('编辑数据集',()=>edit(entity),'dataset-edit'),button('添加版本',()=>release(),'dataset-release-add'),button('连接文件',()=>asset(),'dataset-asset-add'),button('关联论文',()=>link(),'dataset-link-add'),button('复制 APA',()=>cite('apa'),'dataset-apa'),button('导出 BibLaTeX',()=>cite('biblatex'),'dataset-bib'),button('知识工作流',()=>knowledge()?.show(entity),'dataset-knowledge'));
    const linksButton=button('数据集',()=>showPaperLinks(),'paper-datasets');document.querySelector('.reader-ribbon').insertBefore(linksButton,$('reader-fullscreen'));
    const dialog=node('dialog',undefined,'resource-editor');dialog.id='resource-dialog';document.body.append(dialog);
    const ownerOf=value=>value?.id?{id:value.id,resource_kind:value.resource_kind==='dataset'?'dataset':'paper',title:String(value.title||value.id)}:null;
    function dialogError(message){let error=dialog.querySelector('.resource-dialog-error');if(!error){error=node('p',undefined,'inline-error resource-dialog-error');error.setAttribute('role','alert');dialog.append(error);}error.textContent=message;error.hidden=false;}
    function dialogHeader(title,owner){const header=node('header',undefined,'resource-dialog-heading'),copy=node('div');copy.append(node('h3',title));if(owner)copy.append(node('p',`绑定${owner.resource_kind==='dataset'?'数据集':'论文'}：${owner.title}`,'resource-dialog-owner'));header.append(copy,button('×',()=>void requestClose()));return header;}
    async function closeDialog(){
      if(closeFlight)return closeFlight;
      if(dialogSaving){dialogError('正在保存此记录，请稍候再关闭；其余界面仍可继续使用。');return false;}
      closeFlight=(async()=>{try{await saveDraft?.();saveDraft=null;++dialogTicket;dialogOwner=null;if(dialog.open)dialog.close();return true;}catch(error){dialogError(`草稿尚未暂存，当前内容已保留：${error.message}。请重试关闭或保存。`);return false;}})();
      try{return await closeFlight;}finally{closeFlight=null;}
    }
    function requestClose(){++dialogIntent;return closeDialog();}
    async function beginDialog(title,owner,{modeless=false,mode='form'}={}){
      const intent=++dialogIntent;if(!await closeDialog()||intent!==dialogIntent)return null;
      const seq=++dialogTicket;dialogOwner=owner;dialog.dataset.modeless=String(modeless);dialog.dataset.resourceMode=mode;dialog.replaceChildren(dialogHeader(title,owner),node('p','正在读取…','loading'));
      if(modeless)dialog.show();else dialog.showModal();return seq;
    }
    dialog.addEventListener('close',()=>{
      if(dialog.open)return;
      const reopen=()=>{if(dialog.open)return;try{if(dialog.dataset.modeless==='true')dialog.show();else dialog.showModal();}catch{}};
      // Native/programmatic close must not bypass an in-flight save or make
      // the component permanently busy after the visible form disappeared.
      if(dialogSaving){reopen();dialogError('正在保存此记录，请稍候再关闭；其余界面仍可继续使用。');return;}
      const seq=dialogTicket,remember=saveDraft;
      if(!remember){++dialogTicket;dialogOwner=null;return;}
      const task=Promise.resolve().then(()=>remember()).then(()=>{if(seq===dialogTicket){++dialogTicket;saveDraft=null;dialogOwner=null;}return true;},error=>{if(seq===dialogTicket){reopen();dialogError(`草稿尚未暂存，当前内容已保留：${error.message}。请重试关闭或保存。`);}return false;});
      closeFlight=task;void task.finally(()=>{if(closeFlight===task)closeFlight=null;});
    });
    dialog.addEventListener('cancel',event=>{event.preventDefault();void requestClose();});
    dialog.addEventListener('keydown',event=>{if(event.key==='Escape'&&!event.defaultPrevented){event.preventDefault();void requestClose();}});
    const label=(text,input)=>{const l=node('label',text,'field');input.setAttribute('aria-label',text);l.append(input);return l;};
    function sync(){const active=state.active?.resource_kind==='dataset';document.body.classList.toggle('has-dataset',active);toolbar.hidden=!active||workbench()?.isTable();linksButton.hidden=active;linksButton.disabled=!state.active||state.active.archived;for(const id of ['ribbon-language','ribbon-citations','metadata-open','reader-fullscreen'])if($(id))$(id).hidden=active;for(const n of document.querySelectorAll('[data-tab]'))n.hidden=active;if(active){$('toolbar-reader').hidden=true;$('toolbar-annotation').hidden=true;$('toolbar-actions').hidden=true;$('toolbar-library').hidden=!workbench()?.isTable();$('toolbar-paper').textContent=state.active.title||'数据集';$('page-message').hidden=true;}root.hidden=!active||workbench()?.isTable();}
    async function open(id,loaded){prepare();knowledge()?.hide();workbench()?.setTable(false);entity=null;state.active=null;const current=++ticket;$('paper-detail').hidden=true;$('welcome').hidden=true;root.hidden=false;root.replaceChildren(node('p','正在读取数据集…','loading'));document.querySelector('.workspace').classList.add('show-detail');try{const item=loaded||await api('dataset_get',{id});if(current!==ticket)return;entity=item;state.active=item;state.openedId=item.id;state.tab='dataset';render();changed();}catch(e){if(current===ticket){root.replaceChildren(node('p',e.message,'inline-error'),button('重试',()=>open(id)));}}}
    function hide(){++ticket;cancelPreview();root.hidden=true;toolbar.hidden=true;document.body.classList.remove('has-dataset');for(const id of ['ribbon-language','ribbon-citations','metadata-open','reader-fullscreen'])if($(id))$(id).hidden=false;for(const n of document.querySelectorAll('[data-tab]'))n.hidden=false;linksButton.hidden=false;}
    const pair=(list,k,value)=>{if(value===undefined||value===null||value==='')return;const row=node('div');row.append(node('dt',k),node('dd',Array.isArray(value)?value.join('；'):typeof value==='object'?JSON.stringify(value):String(value)));list.append(row);};
    function render(){if(!entity)return;root.replaceChildren();const head=node('header');head.append(node('span','数据集','resource-kind'),node('h2',entity.title||'未命名数据集'));const meta=node('dl',undefined,'resource-meta');for(const [label,key]of [['发布者','publisher'],['许可','license'],['DOI','DOI'],['引用键','citekey'],['覆盖区域','spatial_coverage'],['覆盖时间','temporal_coverage'],['入口','URL']])pair(meta,label,entity[key]);head.append(meta);if(entity.description||entity.abstract)head.append(node('p',entity.description||entity.abstract,'resource-description'));root.append(head);const tabs=node('nav',undefined,'resource-section-tabs');tabs.setAttribute('aria-label','数据集内容');for(const[key,title]of [['releases','版本'],['assets','文件与预览'],['links','关联论文']])tabs.append(button(title,()=>$(key==='links'?'dataset-links':`dataset-${key}`).scrollIntoView({block:'nearest'})));root.append(tabs);for(const[key,title,add]of [['releases','版本',()=>release()],['assets','文件与预览',()=>asset()],['links','关联论文',()=>link()]]){const section=node('section',undefined,'resource-section');section.id=`dataset-${key}`;const h=node('header');h.append(node('h3',title),button('＋ 添加',add));section.append(h);root.append(section);void renderChildren(key,0,section);}sync();}
    async function renderChildren(kind,offset,section){const id=entity?.id,seq=ticket;section.querySelectorAll('.resource-children').forEach(n=>n.remove());const list=node('div',undefined,'resource-children');list.append(node('p','正在读取…','small muted'));section.append(list);try{const result=await api(`dataset_${kind==='releases'?'release':kind==='assets'?'asset':'link'}_list`,{...(kind==='links'?{dataset_id:id}:{id}),offset,limit:20});if(seq!==ticket||id!==entity?.id)return;list.replaceChildren();for(const raw of items(result)){const item=kind==='releases'?{...raw,...raw.metadata}:raw;const row=node('article',undefined,'resource-row');if(kind==='releases'){row.append(node('strong',item.version||item.title||'版本未命名'),node('p',[item.DOI,item.citekey].filter(Boolean).join(' · '),'small muted'),button('编辑',()=>release(item)),button('复制该版本 APA',()=>cite('apa',item.id)),button('版本知识',()=>knowledge()?.show({...item,resource_kind:'release',title:item.title||item.version||entity.title})));}else if(kind==='assets'){row.append(node('strong',item.label||item.path?.split('/').at(-1)||item.url||item.id),node('p',[item.format,item.path||item.url,item.release_id?'已关联版本':'版本未指定'].filter(Boolean).join(' · '),'small muted'),button('编辑位置',()=>asset(item)));const preview=button('预览前 100 行',()=>showPreview(item),'preview-'+item.id);preview.disabled=!item.path;row.append(preview);}else renderLinkRow(row,item);list.append(row);}if(!items(result).length)list.append(node('p',kind==='links'?'尚未记录论文关系。提及或引用不等于实际使用。':kind==='assets'?'连接文件后可按需预览 CSV、TSV 或 JSONL。':'未指定版本时，关系会保留“版本未知”。','small muted'));const pager=node('div',undefined,'resource-pager');const previous=button('上一页',()=>renderChildren(kind,Math.max(0,offset-20),section));previous.disabled=!offset;const next=button('下一页',()=>renderChildren(kind,offset+20,section));next.disabled=offset+items(result).length>=result.total;pager.append(previous,node('span',`${result.total?offset+1:0}–${offset+items(result).length} / ${result.total||0}`),next);list.append(pager);}catch(e){list.replaceChildren(node('p',e.message,'inline-error'),button('重试',()=>renderChildren(kind,offset,section)));}}
    function renderLinkRow(row,item,owner=ownerOf(state.active)){
      if(!owner)return;const isDataset=owner.resource_kind==='dataset',target=isDataset?item.paper_id:item.dataset_id;
      row.append(button((isDataset?item.paper_title:item.dataset_title)||target,async()=>{if(await requestClose())return isDataset?openPaper(target):open(target);}),node('span',`${relations.find(value=>value[0]===item.relation)?.[1]||item.relation} · ${statuses.find(value=>value[0]===item.review_status)?.[1]||'待核对'}`,'resource-relation'));
      if(item.role||item.scope||item.release_id)row.append(node('p',[item.role,item.scope,item.release_id||'版本未知'].filter(Boolean).join(' · '),'small muted'));
      const evidence=Array.isArray(item.evidence)?item.evidence:[item.evidence];for(const value of evidence.filter(Boolean))row.append(node('blockquote',value.quote||value.text||value.note||JSON.stringify(value)));
      row.append(button('编辑关系',()=>link(item,owner)),button('删除关系',()=>confirmDelete(item,owner)));
    }
    async function confirmDelete(item,owner){
      if(!window.confirm('删除这条论文与数据集关系？两个条目及原文仍保留。'))return;
      try{
        await api('dataset_link_delete',{id:item.id,expected_revision:item.revision});
        if(owner?.resource_kind==='dataset'&&entity?.id===owner.id&&state.active?.id===owner.id)render();
        else if(state.active?.id===owner?.id&&panels?.visible('data'))await loadPaperData();
        toast('关系已删除');
      }catch(error){toast(error.message,true);}
    }
    async function form({title,key,base={},fields,submit,modeless=false,owner=null,preparedTicket=null}){
      const seq=preparedTicket??await beginDialog(title,owner,{modeless});
      if(seq===null||seq!==dialogTicket||!dialog.open)return;
      let saved;
      try{saved=await persistence?.get(`resource-draft:${key}`);}
      catch(error){if(seq===dialogTicket)dialogError(`无法读取本机草稿：${error.message}`);return;}
      if(seq!==dialogTicket||!dialog.open)return;
      const form=node('form'),heading=dialogHeader(title,owner),inputs={},initial=saved?.values||base;
      form.append(heading);
      for(const spec of fields){
        const selected=String(initial[spec.key]??spec.value??'');
        const options=spec.options?[...spec.options]:null;
        if(options&&selected&&!options.some(option=>String(option[0])===selected))options.push([selected,`${selected}（已保存，待核对）`]);
        const input=options?choices(options,selected):node(spec.multiline?'textarea':'input');
        if(!options){input.value=initial[spec.key]??spec.value??'';if(spec.multiline){input.rows=spec.rows||3;input.maxLength=spec.maxLength||12000;}else{input.type=spec.type||'text';input.maxLength=spec.maxLength||2000;}}
        input.name=spec.key;input.id=`resource-field-${spec.key}`;input.required=Boolean(spec.required);if(spec.placeholder)input.placeholder=spec.placeholder;inputs[spec.key]=input;form.append(label(spec.label,input));
      }
      const error=node('p',undefined,'inline-error resource-dialog-error');error.hidden=true;error.setAttribute('role','alert');form.append(error);
      const submitButton=node('button','保存','button primary');submitButton.type='submit';form.append(submitButton);dialog.replaceChildren(form);
      let expected=saved?.base||base,draftTail=Promise.resolve(),committed=false;
      const values=()=>Object.fromEntries(Object.entries(inputs).map(([key,input])=>[key,input.value]));
      saveDraft=()=>{const draft={base:expected,values:values()};const task=draftTail.catch(()=>{}).then(()=>persistence?.put(`resource-draft:${key}`,draft));draftTail=task;return task;};
      const remember=()=>void saveDraft?.()?.catch(cause=>{if(seq===dialogTicket){error.textContent=`草稿尚未暂存，当前内容仍保留：${cause.message}`;error.hidden=false;}});
      form.addEventListener('input',remember);form.addEventListener('change',remember);
      form.addEventListener('submit',async event=>{
        event.preventDefault();if(dialogSaving||seq!==dialogTicket)return;
        const data=values();dialogSaving=true;submitButton.disabled=true;for(const input of Object.values(inputs))input.disabled=true;error.hidden=true;
        try{
          if(!committed){await saveDraft?.();await submit(data,expected);committed=true;saveDraft=null;}
          await persistence?.put(`resource-draft:${key}`,null);
          if(seq===dialogTicket){dialogSaving=false;++dialogTicket;dialogOwner=null;dialog.close();}
          await loadList();void refreshDatasetCatalog?.();
        }catch(cause){if(seq===dialogTicket){
          error.textContent=committed?`记录已保存，但本机草稿清理尚未完成：${cause.message}。可重试完成保存，不会重复写入记录。`:cause.code==='STATE_CONFLICT'?`另一窗口已修改此记录；本机草稿仍保留。请关闭后重新核对记录。${cause.message}`:cause.message;error.hidden=false;
          if(!committed&&cause.code==='STATE_CONFLICT'&&cause.current){const latest=cause.current,review=node('details');review.append(node('summary','查看另一窗口当前保存的记录'),node('pre',JSON.stringify(latest,null,2),'knowledge-structured-record'));error.append(review,button('导出本窗口草稿',()=>download(JSON.stringify({base:expected,draft:values(),current:latest},null,2),'dataset-edit-conflict.json','application/json')),button('已核对差异，采用本窗口内容继续编辑',()=>{expected={...latest,...latest.metadata};remember();error.textContent='已采用最新版本作为保存基础；本窗口内容仍在表单中。点击保存提交已核对的修改。';}));}
        }}finally{if(seq===dialogTicket){dialogSaving=false;submitButton.disabled=false;submitButton.textContent=committed?'重试完成保存':'保存';for(const input of Object.values(inputs))input.disabled=committed;}}
      });
      return {form,inputs,initial,seq};
    }
    async function edit(item){return form({title:item?'编辑数据集':'登记数据集',key:`dataset:${item?.id||'new'}`,base:{...item,authors:(item?.author||[]).map(a=>a.literal||[a.family,a.given].filter(Boolean).join(', ')).join('\n'),year:item?.issued?.['date-parts']?.[0]?.[0]||'',revision:item?.revision||0},fields:[{key:'title',label:'名称',required:true},{key:'authors',label:'创建者（每行一个人或机构；人名可填 姓, 名）',multiline:true,rows:2},{key:'year',label:'发布年份',type:'number'},{key:'publisher',label:'发布者 / 机构'},{key:'description',label:'数据包含什么',multiline:true},{key:'URL',label:'官方入口',type:'url'},{key:'DOI',label:'数据集 DOI'},{key:'citekey',label:'引用键'},{key:'license',label:'许可'},{key:'spatial_coverage',label:'覆盖区域'},{key:'temporal_coverage',label:'覆盖时间'},{key:'registration_level',label:'登记程度',value:'L0',options:[['L0','L0 · 登记'],['L1','L1 · 建档'],['L2','L2 · 已用于研究并核验']]} ],submit:async(v,base)=>{const result=await api('dataset_put',{...(item?.id?{id:item.id}:{}),expected_revision:base.revision,metadata:{...Object.fromEntries(Object.entries(v).filter(([k])=>!['authors','year'].includes(k))),author:v.authors.split('\n').map(v=>v.trim()).filter(Boolean).map(v=>{const parts=v.split(',');return parts.length>1?{family:parts.shift().trim(),given:parts.join(',').trim()}:{literal:v};}),issued:String(v.year)===String(base.issued?.['date-parts']?.[0]?.[0]||'')?base.issued||{}:v.year?{'date-parts':[[Number(v.year)]]}:{}}});toast('数据集已保存');if(!binding)await open(result.id);}});}
    async function release(value){const id=entity?.id;if(!id)return;return form({title:value?'编辑数据版本':'添加数据版本',key:`release:${value?.id||id+':new'}`,base:{...value,...value?.metadata,revision:value?.revision||0},fields:[{key:'version',label:'版本 / 年份',required:true},{key:'title',label:'版本名称'},{key:'DOI',label:'版本 DOI'},{key:'URL',label:'版本入口',type:'url'},{key:'citekey',label:'版本引用键'}],submit:async(v,base)=>{await api('dataset_release_put',{id,...(value?.id?{release_id:value.id}:{}),metadata:Object.fromEntries(Object.entries(v).filter(([k,v])=>k!=='title'||v)),expected_revision:base.revision});toast('版本已保存');await open(id);}});}
    async function asset(value){const id=entity?.id;if(!id)return;let releases;try{releases=await api('dataset_release_list',{id,limit:100});}catch(e){toast(e.message,true);return;}return form({title:value?'编辑文件位置':'连接数据文件',key:`asset:${value?.id||id+':new'}`,base:{...value,revision:value?.revision||0},fields:[{key:'label',label:'名称'},{key:'path',label:'运行 DSH 的主机上的文件绝对路径',placeholder:'/path/to/data.csv'},{key:'url',label:'或记录远程文件入口',type:'url'},{key:'format',label:'格式',placeholder:'csv / tsv / jsonl'},{key:'release_id',label:'所属版本',options:[['','版本未指定'],...items(releases).map(r=>[r.id,r.metadata?.version||r.version||r.metadata?.title||r.title||r.id])]}],submit:async(v,base)=>{await api('dataset_asset_put',{id,...(value?.id?{asset_id:value.id}:{}),...v,expected_revision:base.revision});toast('文件位置已保存');await open(id);}});}
    async function link(value,ownerValue){
      const owner=ownerOf(ownerValue||state.active);if(!owner)return;
      const isDataset=owner.resource_kind==='dataset',targetKind=isDataset?'paper':'dataset',targetKey=isDataset?'paper_id':'dataset_id';
      const seq=await beginDialog('记录论文与数据集关系',owner,{modeless:true});if(seq===null)return;
      let found;try{found=await api('resource_list',{kind:targetKind,limit:20,offset:0,query:''});}catch(error){if(seq===dialogTicket)dialogError(error.message);return;}
      if(seq!==dialogTicket||!dialog.open)return;
      const ev=(Array.isArray(value?.evidence)?value.evidence[0]:value?.evidence)||{},base={...value,[targetKey]:value?.[targetKey]||'',revision:value?.revision||0,quote:ev.quote||ev.text||'',page:ev.page||'',evidence_url:ev.source_uri||ev.source||'',relation:value?.relation||'mentions',review_status:value?.review_status||'needs-review'};
      const targetOptions=[['','选择条目'],...items(found).map(item=>[item.id,item.title])];
      if(value?.[targetKey]&&!targetOptions.some(option=>option[0]===value[targetKey]))targetOptions.push([value[targetKey],value.paper_title||value.dataset_title||value[targetKey]]);
      const f=await form({title:'记录论文与数据集关系',key:`link:${value?.id||owner.id+':new'}`,base,owner,modeless:true,preparedTicket:seq,
        fields:[{key:'target_search',label:`检索${isDataset?'论文':'数据集'}`,placeholder:'输入题名，点击查找'},{key:targetKey,label:isDataset?'论文':'数据集',options:targetOptions,required:true},{key:'relation',label:'关系',options:relations},{key:'role',label:'用途 / 角色',placeholder:'训练、测试、基准、案例…'},{key:'scope',label:'使用范围 / 子集'},{key:'release_id',label:'数据版本',options:[['','版本未知']]},{key:'quote',label:'原文依据',multiline:true},{key:'page',label:'已知 PDF 页码',type:'number'},{key:'evidence_url',label:'依据链接',type:'url'},{key:'review_status',label:'核对状态',options:statuses}],
        submit:async(values,expected)=>{
          const oldEvidence=Array.isArray(expected.evidence)?expected.evidence:[expected.evidence||{}],evidence=[{...oldEvidence[0],quote:values.quote,page:values.page?Number(values.page):null,source_uri:values.evidence_url||''},...oldEvidence.slice(1)];
          await api('dataset_link_put',{...(value?.id?{id:value.id}:{}),paper_id:isDataset?values.paper_id:owner.id,dataset_id:isDataset?owner.id:values.dataset_id,release_id:values.release_id||null,relation:values.relation,role:values.role,scope:values.scope,evidence,review_status:values.review_status,origin:'user',expected_revision:expected.revision});
          toast('关系及依据已保存');if(isDataset&&state.active?.id===owner.id&&entity?.id===owner.id)render();
        }});
      if(!f||seq!==dialogTicket)return;
      let lookupTicket=0,releaseTicket=0,lastDataset=null;
      const current=()=>seq===dialogTicket&&dialog.open;
      const lookup=button('查找',async()=>{
        const request=++lookupTicket;
        try{
          const result=await api('resource_list',{kind:targetKind,query:f.inputs.target_search.value,limit:20,offset:0});if(!current()||request!==lookupTicket)return;
          const chosen=f.inputs[targetKey].value,chosenLabel=f.inputs[targetKey].selectedOptions[0]?.textContent||chosen;
          const options=[['','选择条目'],...items(result).map(item=>[item.id,item.title])];if(chosen&&!options.some(option=>option[0]===chosen))options.push([chosen,chosenLabel]);
          f.inputs[targetKey].replaceChildren(...choices(options,chosen).children);
        }catch(error){if(current()&&request===lookupTicket)dialogError(error.message);}
      });f.inputs.target_search.after(lookup);
      const loadReleases=async()=>{
        const dataset=isDataset?owner.id:f.inputs.dataset_id.value,request=++releaseTicket;
        const changed=lastDataset!==null&&lastDataset!==dataset;
        const chosen=lastDataset===null?f.initial.release_id||value?.release_id||'':lastDataset===dataset?f.inputs.release_id.value:'';lastDataset=dataset;
        if(changed)f.inputs.release_id.replaceChildren(...choices([['','版本未知']]).children);
        if(!dataset){f.inputs.release_id.replaceChildren(...choices([['','版本未知']]).children);return;}
        try{
          const list=await api('dataset_release_list',{id:dataset,limit:100});if(!current()||request!==releaseTicket||dataset!==(isDataset?owner.id:f.inputs.dataset_id.value))return;
          const options=[['','版本未知'],...items(list).map(item=>[item.id,item.metadata?.version||item.version||item.metadata?.title||item.title||item.id])];
          if(chosen&&!options.some(option=>option[0]===chosen))options.push([chosen,`${chosen}（已保存，待核对）`]);f.inputs.release_id.replaceChildren(...choices(options,chosen).children);
        }catch(error){if(current()&&request===releaseTicket)dialogError(error.message);}
      };
      f.inputs[targetKey].addEventListener('change',loadReleases);await loadReleases();
    }
    let paperDataTicket=0, paperDataOwner, binding, bindingForm;
    const dataPanel=node('section',undefined,'paper-data-panel');dataPanel.id='paper-data';
    const relationLabel=value=>relations.find(([key])=>key===value)?.[1]||value;
    const accessLabel={accessible:'可访问',restricted:'受限',unknown:'开放性待核'};
    const verificationLabel={verified:'标识已核验',reachable:'入口可达',unreachable:'入口不可达',restricted:'入口受限',unverified:'标识待核',not_cited:'原文未提供公开标识'};
    const releaseChoices=list=>[['','版本未知'],...items(list).map(item=>[item.id,item.metadata?.version||item.version||item.metadata?.title||item.title||item.id])];
    const pageButton=page=>button(`PDF 第 ${page} 页`,()=>requestPage?.(page));
    panels?.registerPanel({id:'data',label:'数据',element:dataPanel,reading:true,onShow:()=>void loadPaperData()});
    async function showPaperLinks(){
      const owner=ownerOf(state.active);
      if(!owner||owner.resource_kind==='dataset')return false;
      if(workbench()?.isTable()){
        await openPaper(owner.id);
        if(state.active?.id!==owner.id||workbench()?.isTable())return false;
      }
      return panels?.show('data');
    }
    function syncPaper(){
      if(panels?.visible('data')&&paperDataOwner!==state.active?.id)void loadPaperData();
    }
    function navigationChanged(value){
      if(value.section!=='dataset'&&binding){binding=null;bindingForm=null;}
    }
    async function enterCatalog(owner,candidate,match){
      const context={owner,candidate,match};
      binding=context;bindingForm=null;
      if(!await openDatasetCatalog?.()&&binding===context){binding=null;renderDatasetCatalog?.();}
    }
    function catalogActions(host){
      const action=button('＋ 新建数据集',()=>edit());
      if(!binding){host.replaceChildren(action);return;}
      const current=binding;
      host.replaceChildren(action,node('strong',`绑定到 ${current.owner.title}`),
        button('返回论文',()=>returnToPaper?.(current.owner)),button('结束绑定',()=>{binding=null;bindingForm=null;renderDatasetCatalog?.();}));
      if(current.candidate)host.append(node('p',`候选：${current.candidate.title}${current.candidate.version?` · ${current.candidate.version}`:''}`));
      if(current.match?.matches?.length)host.append(node('p',`可能匹配：${current.match.matches.map(item=>item.title).join('、')}`,'small muted'));
      if(bindingForm)host.append(bindingForm);
    }
    function catalogRow(row,item){
      if(binding)row.append(button('绑定',()=>void prepareBinding(item,binding)));
    }
    function evidenceFields(entry={}){
      const evidence=Array.isArray(entry.evidence)?entry.evidence:[],source=evidence[0]||{};
      const fields=[['role','用途',entry.role,200],['scope','使用或访问条件',entry.scope,4000],
        ['quote','原文摘录',source.quote,8000],['page','PDF 页码',source.page],['source_uri','公开入口',source.source_uri,2000]];
      const details=node('details',undefined,'dataset-binding-evidence');
      details.append(node('summary','证据与访问条件'));
      const inputs={};
      for(const [key,title,value,limit]of fields){
        const control=node(key==='quote'?'textarea':'input');control.value=value??'';
        if(limit)control.maxLength=limit;
        if(key==='page'){control.type='number';control.min=1;control.max=100000;}
        if(key==='source_uri')control.type='url';
        inputs[key]=control;details.append(label(title,control));
      }
      const review=choices(statuses,entry.review_status||'needs-review');
      details.append(label('核对状态',review));
      return {element:details,value:()=>{
        const read=key=>inputs[key].value.trim();
        return {role:read('role'),scope:read('scope'),review_status:review.value,
          evidence:[{...source,quote:read('quote'),page:read('page')?Number(read('page')):null,source_uri:read('source_uri')},...evidence.slice(1)]};
      }};
    }
    async function prepareBinding(item,context){
      if(!context||binding!==context)return;
      const panel=node('section',undefined,'dataset-binding-form');
      bindingForm=panel;
      renderDatasetCatalog?.();
      panel.append(node('strong',item.title),node('p','正在读取版本…','small muted'));
      try{
        const list=await api('dataset_release_list',{id:item.id,limit:100});
        if(binding!==context||bindingForm!==panel)return;
        const matchedRelease=context.match?.matches.find(value=>value.dataset_id===item.id)?.release_id||'';
        const release=choices(releaseChoices(list),matchedRelease);
        const relation=choices(relations,context.candidate?.relation||'mentions');
        relation.disabled=Boolean(context.candidate);
        const evidence=context.candidate?null:evidenceFields();
        const status=node('p','','small');status.setAttribute('role','status');
        const save=button('保存绑定',async()=>{
          if(binding!==context||bindingForm!==panel)return;
          save.disabled=true;
          try{
            if(context.candidate)await api('paper_datasets_confirm',{id:context.owner.id,candidate_id:context.candidate.id,dataset_id:item.id,release_id:release.value||null});
            else await api('dataset_link_put',{paper_id:context.owner.id,dataset_id:item.id,release_id:release.value||null,relation:relation.value,...evidence.value(),expected_revision:0});
            if(binding===context&&bindingForm===panel){
              status.textContent='已保存绑定';
              panel.replaceChildren(node('strong',item.title),status);
            }
            toast('数据集关系已保存');
          }catch(error){status.textContent=error.message;save.disabled=false;}
        });
        panel.replaceChildren(node('strong',item.title),label('版本',release),label('关系',relation),...(evidence?[evidence.element]:[]),save,status);
      }catch(error){if(binding===context&&bindingForm===panel)panel.replaceChildren(node('p',error.message,'inline-error'),button('重试',()=>prepareBinding(item,context)));}
    }
    async function editPaperLink(row,entry,owner){
      const list=await api('dataset_release_list',{id:entry.dataset_id,limit:100});
      if(!row.isConnected||state.active?.id!==owner.id)return;
      const release=choices(releaseChoices(list),entry.release_id||'');
      const relation=choices(relations,entry.relation);
      const evidence=evidenceFields(entry);
      const status=node('p','','small');status.setAttribute('role','status');
      const save=button('保存关系',async()=>{
        save.disabled=true;
        try{
          await api('dataset_link_put',{...entry,release_id:release.value||null,relation:relation.value,...evidence.value(),expected_revision:entry.revision});
          if(state.active?.id===owner.id)void loadPaperData();
        }catch(error){status.textContent=error.message;save.disabled=false;}
      });
      row.append(label('版本',release),label('关系',relation),evidence.element,save,status);
    }
    async function loadPaperData(offset=0){
      const owner=ownerOf(state.active),seq=++paperDataTicket;
      paperDataOwner=owner?.id;
      if(!owner||owner.resource_kind==='dataset'){dataPanel.replaceChildren();return;}
      const current=()=>seq===paperDataTicket&&state.active?.id===owner.id;
      const linked=node('section',undefined,'paper-data-section');
      const candidates=node('section',undefined,'paper-data-section');
      const list=node('div',undefined,'paper-data-results');
      const heading=node('header');
      heading.append(node('h3','已关联数据集'),button('＋ 关联数据集',()=>enterCatalog(owner)));
      linked.append(heading,list);
      dataPanel.replaceChildren(linked,candidates);
      list.append(node('p','正在读取…','small muted'));
      try{
        const result=await api('dataset_link_list',{paper_id:owner.id,limit:20,offset});
        if(!current())return;
        list.replaceChildren();
        for(const entry of items(result)){
          const row=node('article',undefined,'resource-row');
          const evidence=Array.isArray(entry.evidence)?entry.evidence:[entry.evidence];
          row.append(button(entry.dataset_title||entry.dataset_id,()=>openDataset?.({id:entry.dataset_id,title:entry.dataset_title})),
            node('span',`${relationLabel(entry.relation)} · ${statuses.find(([key])=>key===entry.review_status)?.[1]||'待核对'}`,'resource-relation'),
            node('p',[entry.release_version|| (entry.release_id?'已指定版本':'版本未知'),entry.role,entry.scope].filter(Boolean).join(' · '),'small muted'));
          for(const source of evidence.filter(Boolean)){
            if(source.quote)row.append(node('blockquote',source.quote));
            if(source.page)row.append(pageButton(source.page));
            if(source.source_uri)row.append(node('p',source.source_uri,'small muted'));
          }
          const editButton=button('编辑关系',async()=>{editButton.disabled=true;try{await editPaperLink(row,entry,owner);}catch(error){toast(error.message,true);editButton.disabled=false;}});
          row.append(editButton,button('删除关系',()=>confirmDelete(entry,owner)));
          list.append(row);
        }
        if(!items(result).length)list.append(node('p','尚未关联数据集。','small muted'));
        if(offset)list.append(button('上一页',()=>loadPaperData(Math.max(0,offset-20))));
        if(offset+items(result).length<result.total)list.append(button('下一页',()=>loadPaperData(offset+20)));
      }catch(error){if(current())list.replaceChildren(node('p',error.message,'inline-error'),button('重试',()=>loadPaperData(offset)));}
      if(!current())return;
      const head=node('header'),search=button('检索本文数据',async()=>{
        search.disabled=true;
        progress.textContent='正在读取 PDF 并核验公开标识…';
        try{
          const result=await api('paper_datasets_search',{id:owner.id});
          if(current()){progress.textContent='';renderCandidates(result);}
        }catch(error){if(current())progress.textContent=error.message;}
        finally{if(current())search.disabled=false;}
      });
      search.disabled=true;
      const progress=node('p','','small'),results=node('div',undefined,'paper-data-results');
      progress.setAttribute('role','status');
      head.append(node('h3','AI 检索候选'),search);
      candidates.append(head,progress,results);
      function renderCandidates(result){
        search.disabled=!result.can_search;
        results.replaceChildren();
        if(result.coverage){
          const cover=result.coverage;
          results.append(node('p',`扫描 ${cover.scanned_pages} / ${cover.page_count} 页 · ${cover.evidence_pages.length} 页送检${cover.partial?' · 覆盖不全':''}${cover.unreadable_pages?.length?` · ${cover.unreadable_pages.length} 页无可读文本`:''}`,'small muted'));
          if(result.discarded)results.append(node('p',`有 ${result.discarded} 条候选未通过证据核对。`,'small muted'));
        }
        if(!result.candidates?.length)results.append(node('p',result.coverage?'本次未找到有原文证据的数据集。':result.can_search?'点击「检索本文数据」读取 PDF 证据。':'AI 检索需要论文 PDF 与 DSH 模型。','small muted'));
        for(const candidate of result.candidates||[]){
          const card=node('article',undefined,'resource-row');
          const status=node('p','','small');status.setAttribute('role','status');
          const save=button(candidate.confirmed?'已入库':'核对并入库',async()=>{
            save.disabled=true;
            try{
              const match=await api('paper_datasets_matches',{id:owner.id,candidate_id:candidate.id});
              if(!current())return;
              if(match.requires_selection){await enterCatalog(owner,candidate,match);return;}
              await api('paper_datasets_confirm',{id:owner.id,candidate_id:candidate.id});
              if(current()){toast('数据集已入库并关联');void loadPaperData(offset);}
            }catch(error){if(current())status.textContent=error.message;}
            finally{if(current())save.disabled=false;}
          });
          save.disabled=Boolean(candidate.confirmed);
          card.append(node('strong',candidate.title),node('p',[relationLabel(candidate.relation),candidate.version||'版本未知',accessLabel[candidate.access],verificationLabel[candidate.verification]].filter(Boolean).join(' · '),'small muted'));
          if(candidate.role||candidate.conditions)card.append(node('p',[candidate.role,candidate.conditions].filter(Boolean).join(' · ')));
          if(candidate.identifier)card.append(node('p',candidate.identifier,'small muted'));
          if(candidate.public_title&&candidate.public_title!==candidate.title)card.append(node('p',`登记名称：${candidate.public_title}`,'small muted'));
          card.append(node('blockquote',candidate.quote),pageButton(candidate.page),save,status);
          results.append(card);
        }
      }
      try{
        const result=await api('paper_datasets_get',{id:owner.id});
        if(current())renderCandidates(result);
      }catch(error){if(current())progress.textContent=error.message;}
    }
    function cancelPreview(){previewController?.abort();previewController=null;previewAsset=null;root.querySelector('#dataset-preview')?.remove();}
    async function showPreview(item){cancelPreview();const id=entity.id,seq=ticket;previewAsset=item.id;previewController=new AbortController();const signal=previewController.signal;const pane=node('section',undefined,'resource-preview');pane.id='dataset-preview';pane.append(node('h3',`预览 · ${item.label||item.path?.split('/').at(-1)||item.id}`),button('关闭 / 取消',cancelPreview));const content=node('div');content.append(node('p','正在按预算读取文件开头…'));pane.append(content);$('dataset-assets').append(pane);try{const result=await api('dataset_asset_preview',{id,asset_id:item.id},{signal});if(signal.aborted||seq!==ticket||previewAsset!==item.id)return;if(result.status&&!['ready','partial'].includes(result.status)){content.replaceChildren(node('p',result.status==='missing'?'文件不在已登记位置，请编辑文件位置后重试。':result.status==='error'?'文件预览未能读取有效记录。':'该格式暂不支持表格预览。文件登记仍保留。','small muted'),...(result.warnings||[]).map(w=>node('p',w,'small muted')));return;}const table=node('table');const columns=result.columns||result.fields||[];const head=node('tr');for(const col of columns.slice(0,50))head.append(node('th',typeof col==='object'?col.name:col));table.append(head);for(const row of (result.rows||[]).slice(0,100)){const tr=node('tr');for(const [index,col]of columns.slice(0,50).entries()){const value=Array.isArray(row)?row[index]:row[typeof col==='object'?col.name:col];tr.append(node('td',typeof value==='object'?JSON.stringify(value):String(value??'')));}table.append(tr);}const scroll=node('div',undefined,'resource-table-scroll');scroll.append(table);content.replaceChildren(node('p',`仅显示文件开头 ${result.rows?.length||0} 行 · 最多 50 列；不是全量统计。`,'small muted'),scroll);for(const warning of result.warnings||[])content.append(node('p',warning,'small muted'));if(result.truncated||result.partial||result.status==='partial')content.append(node('p','已达到读取预算，部分内容未显示。','small muted'));}catch(e){if(!signal.aborted&&seq===ticket)content.replaceChildren(node('p',e.message,'inline-error'),button('重新读取',()=>showPreview(item)));}}
    async function cite(format,release_id){
      const current=entity;if(!current)return;
      try{
        const result=await api('dataset_cite',{id:current.id,...(release_id?{release_id}:{}),format}),content=result.text||result.biblatex||result.plain||String(result);
        if(format==='biblatex')download(content,`${current.citekey||current.id}.bib`,'application/x-bibtex');
        else{try{await navigator.clipboard.writeText(content);toast('APA 引用已复制');}catch{
          const owner=ownerOf(current),seq=await beginDialog('APA 引用',owner);if(seq===null)return;
          const textarea=node('textarea');textarea.rows=6;textarea.readOnly=true;textarea.value=content;dialog.replaceChildren(dialogHeader('APA 引用',owner),textarea,button('关闭',()=>void requestClose()));
        }}
      }catch(error){toast(error.message,true);}
    }
    async function archive(item){try{await api(item.archived?'dataset_restore':'dataset_archive',{id:item.id,expected_revision:item.revision});if(state.active?.id===item.id){hide();state.active=null;$('welcome').hidden=false;}await loadList();void refreshDatasetCatalog?.();changed();toast(item.archived?'数据集已恢复':'数据集已移入回收站');}catch(e){toast(e.message,true);}}
    return {open,hide,edit,archive,sync,showPaperLinks,syncPaper,navigationChanged,catalogActions,catalogRow,closeDialog:requestClose,dispose(){void saveDraft?.()?.catch(()=>{});cancelPreview();}};
  }
  function download(text,name,type='text/plain'){const url=URL.createObjectURL(new Blob([text],{type}));const a=node('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
  return {create,download};
})();
