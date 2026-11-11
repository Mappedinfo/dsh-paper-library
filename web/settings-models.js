'use strict';
window.PaperSettingsModels = (() => {
  const name=model=>model?.provider&&model?.model?`${model.model} · ${model.provider}`:'未配置可用模型';
  const make=(tag,text)=>{const node=document.createElement(tag);if(text!==undefined)node.textContent=text;return node;};
  const key=model=>model?JSON.stringify({provider:model.provider,model:model.model}):'';
  const appendOption=(host,value,label,disabled=false)=>{
    const option=make('option',label);option.value=value;option.disabled=disabled;host.append(option);
  };
  function fillModels(select,models,chosen,automatic){
    select.replaceChildren();
    appendOption(select,'',automatic);
    const groups=new Map();
    for(const item of models){
      if(!groups.has(item.provider)){
        const group=make('optgroup');group.label=item.provider_name||item.provider;groups.set(item.provider,group);select.append(group);
      }
      appendOption(groups.get(item.provider),key({provider:item.provider,model:item.id}),item.name||item.id);
    }
    const value=key(chosen);
    if(value&&!models.some(item=>item.provider===chosen.provider&&item.id===chosen.model))appendOption(select,value,`${name(chosen)}（当前不可用）`,true);
    select.value=value;
  }
  const chosen=select=>select.value?JSON.parse(select.value):null;

  function create({api,container}) {
    const root=make('section');root.className='settings-models';root.setAttribute('aria-label','模型设置');
    const status=make('p');status.setAttribute('role','status');
    const paperInfo=make('p'),languageInfo=make('p');paperInfo.className=languageInfo.className='settings-model-effective';
    const paperSelect=make('select'),effort=make('select'),languageSelect=make('select');
    const effortStatus=make('p');effortStatus.className='small';effortStatus.setAttribute('role','status');
    const paperSave=make('button','保存全局模型'),languageSave=make('button','保存语言模型'),reload=make('button','刷新模型');
    for(const button of [paperSave,languageSave,reload]){button.type='button';button.className='button subtle';}
    const field=(label,select)=>{const row=make('label');select.setAttribute('aria-label',label);row.append(make('strong',label),select);return row;};
    root.append(field('全局对话、伴学与后台整理模型',paperSelect),field('推理强度',effort),effortStatus,paperInfo,paperSave,
      field('翻译与润色模型',languageSelect),languageInfo,languageSave,reload,status);
    container.append(root);
    let paper=null,language=null,busy=false,effortTicket=0,effortBusy=false,effortUnavailable=false;
    function updateControls(){
      paperSelect.disabled=busy||!paper?.writable;
      effort.disabled=paperSelect.disabled||effortBusy||!paperSelect.value||effort.options.length<=1;
      paperSave.disabled=paperSelect.disabled||effortBusy||effortUnavailable||Boolean(paperSelect.selectedOptions[0]?.disabled)||Boolean(effort.selectedOptions[0]?.disabled);
      languageSelect.disabled=busy||!language;
      languageSave.disabled=languageSelect.disabled||Boolean(languageSelect.selectedOptions[0]?.disabled);
      reload.disabled=busy;
    }
    function describePaper(){
      const route=paper?.effective_model;
      const level=paper?.effective_effort_label||route?.reasoningEffort;
      paperInfo.textContent=`当前生效：${name(route)}${level?` · ${level}`:''}。${paper?.warning?' '+paper.warning:''}`;
    }
    function describeLanguage(){
      const override=language?.value?.model;
      languageInfo.replaceChildren(make('span',`翻译：${name(override||language?.translation_default_model)}`),make('span',`润色：${name(override||language?.default_model)}`));
    }
    async function loadEfforts(saved=''){
      const token=++effortTicket, route=chosen(paperSelect);
      effort.replaceChildren();appendOption(effort,'','模型默认');effortStatus.textContent='';
      effortUnavailable=false;effortBusy=!!route;updateControls();
      if(!route)return;
      try{
        const result=await api('paper_model_efforts',{model:route});
        if(token!==effortTicket)return;
        const options=result.efforts||[];
        const defaultOption=options.find(item=>item.id===result.defaultEffort);
        if(defaultOption)effort.options[0].textContent=`模型默认（${defaultOption.name||defaultOption.id}）`;
        for(const option of options)appendOption(effort,option.id,option.name||option.id);
        if(saved&&!options.some(item=>item.id===saved)){
          appendOption(effort,saved,`${saved}（当前不可用）`,true);effortStatus.textContent='已保存的推理强度当前不可用，请选择模型默认或其他档位。';
        }
        effort.value=saved;
        if(!result.efforts?.length&&!saved)effortStatus.textContent='宿主未为此模型提供可选推理档位。';
      }catch(error){
        if(token!==effortTicket)return;
        effortUnavailable=true;effortStatus.textContent=error.message;
      }finally{if(token===effortTicket){effortBusy=false;updateControls();}}
    }
    async function refresh(){
      if(busy)return;
      busy=true;updateControls();status.textContent='正在读取模型…';
      try{
        paper=await api('paper_model_get',{});
        fillModels(paperSelect,paper.models||[],paper.value?.model,'跟随 DSH 默认模型');describePaper();
        language=await api('language_settings_get',{});
        fillModels(languageSelect,language.models||[],language.value?.model,'自动选择');describeLanguage();
        await loadEfforts(paper.value?.model?.reasoningEffort||'');status.textContent='';
      }catch(error){status.textContent=error.message;}finally{busy=false;updateControls();}
    }
    paperSelect.addEventListener('change',()=>void loadEfforts());
    effort.addEventListener('change',updateControls);
    languageSelect.addEventListener('change',updateControls);
    paperSave.addEventListener('click',async()=>{
      if(paperSave.disabled)return;
      const model=chosen(paperSelect),reasoningEffort=effort.value;
      busy=true;updateControls();
      try{
        paper=await api('paper_model_update',{expected_revision:paper.revision,model:model&&{...model,...(reasoningEffort?{reasoningEffort}:{})}});
        describePaper();status.textContent='资料库全局模型已保存，后续任务使用新设置。';
      }catch(error){status.textContent=error.message;}finally{busy=false;updateControls();}
    });
    languageSave.addEventListener('click',async()=>{
      if(languageSave.disabled)return;
      busy=true;updateControls();
      try{
        const saved=await api('language_settings_update',{value:{...language.value,model:chosen(languageSelect)},expected_revision:language.revision});
        language={...language,...saved};describeLanguage();status.textContent='语言模型已保存。';
      }catch(error){status.textContent=error.message;}finally{busy=false;updateControls();}
    });
    reload.addEventListener('click',()=>void refresh());updateControls();
    return {refresh};
  }
  return {create,fillModels,chosen,name};
})();
