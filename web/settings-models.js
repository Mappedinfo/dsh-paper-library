'use strict';
window.PaperSettingsModels = (() => {
  const name=model=>model?.provider&&model?.model?`${model.provider} / ${model.model}`:'未配置可用模型';
  function create({api,getPaper,container}) {
    const make=(tag,text)=>{const node=document.createElement(tag);if(text!==undefined)node.textContent=text;return node;};
    const root=make('section');root.className='settings-models';root.setAttribute('aria-label','实际使用的模型');
    const status=make('p');status.className='small';status.setAttribute('role','status');
    const paperInfo=make('p'),languageInfo=make('p');paperInfo.className=languageInfo.className='small';
    const paperSelect=make('select'),languageSelect=make('select');paperSelect.setAttribute('aria-label','当前论文模型');languageSelect.setAttribute('aria-label','翻译与润色模型');
    const paperSave=make('button','应用到本篇'),languageSave=make('button','保存语言模型'),reload=make('button','刷新模型');
    for(const button of [paperSave,languageSave,reload]){button.type='button';button.className='button subtle';}
    for(const [label,select,save,info]of [['本篇对话、伴学与后台整理',paperSelect,paperSave,paperInfo],['翻译与润色',languageSelect,languageSave,languageInfo]]){
      const row=make('label');row.append(make('strong',label),select);root.append(row,info,save);
    }
    root.append(reload,status);container.append(root);
    let record=null,selectedPaper=null,busy=false,ticket=0;
    function lock(value){busy=value;paperSelect.disabled=paperSave.disabled=value||!selectedPaper;languageSelect.disabled=languageSave.disabled=value||!record;reload.disabled=value;}
    function options(select,models,chosen,automatic){select.replaceChildren();if(automatic){const option=make('option','自动选择（实际模型见下方）');option.value='';select.append(option);}
      for(const item of models){const option=make('option',`${item.provider} / ${item.id}`);option.value=JSON.stringify({provider:item.provider,model:item.id});select.append(option);}
      const value=chosen?JSON.stringify({provider:chosen.provider,model:chosen.model}):'';
      if(value&&![...select.options].some(option=>option.value===value)){const option=make('option',`${name(chosen)}（当前不可用）`);option.value=value;option.disabled=true;select.append(option);}
      select.value=value;
    }
    function languageDescription(){const override=record?.value?.model;languageInfo.textContent=`翻译：${name(override||record?.translation_default_model)}；润色：${name(override||record?.default_model)}。手动指定后两项共用该模型，保存到资料库。`;}
    async function refresh(){if(busy)return;const token=++ticket;lock(true);status.textContent='正在读取实际模型…';selectedPaper=getPaper()?.id||null;
      try{record=await api('language_settings_get',{});if(token!==ticket)return;options(languageSelect,record.models||[],record.value?.model,true);languageDescription();
        if(selectedPaper){const id=selectedPaper,result=await api('chat_ensure',{id});if(token!==ticket)return;if(getPaper()?.id!==id)throw Error('当前论文已切换，请刷新模型。');options(paperSelect,record.models||[],result.model,false);paperInfo.textContent=`当前：${name(result.model)}。仅修改本篇，其他论文与 DSH 默认模型不变。`;}
        else{paperSelect.replaceChildren();paperInfo.textContent='请先选择一篇论文。';}status.textContent='';
      }catch(error){status.textContent=`读取未完成：${error.message}`;selectedPaper=null;}finally{if(token===ticket)lock(false);}
    }
    paperSave.addEventListener('click',async()=>{if(busy||!selectedPaper)return;const id=selectedPaper;if(getPaper()?.id!==id){status.textContent='当前论文已切换，请刷新模型。';return;}lock(true);
      try{const result=await api('chat_model_update',{id,model:JSON.parse(paperSelect.value)});paperInfo.textContent=`当前：${name(result.model)}。仅用于本篇。`;status.textContent='论文模型已保存，后续调用使用新模型。';}
      catch(error){status.textContent=`未保存：${error.message}`;}finally{lock(false);}
    });
    languageSave.addEventListener('click',async()=>{if(busy||!record)return;lock(true);
      try{const saved=await api('language_settings_update',{value:{...record.value,model:languageSelect.value?JSON.parse(languageSelect.value):null},expected_revision:record.revision});record={...record,...saved};languageDescription();status.textContent='语言模型已保存。';}
      catch(error){status.textContent=`未保存：${error.message}；请刷新模型后重试。`;}finally{lock(false);}
    });
    reload.addEventListener('click',()=>void refresh());lock(false);
    return {refresh};
  }
  return {create};
})();
