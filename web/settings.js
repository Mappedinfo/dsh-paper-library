'use strict';
window.PaperLibrarySettings = (() => {
  const fields = [
    ['auto_analysis', '新增或选中文献后自动整理', '新导入或选中且尚无整理记录的 PDF，按全文分批排队；会使用本篇模型额度。'],
    ['analysis_fill', '整理完成后补齐空缺资料', '有原文依据才补缺，保留已有资料；AI 填入内容仍待核对。'],
    ['auto_review', '整理完成后生成证据图谱评审草稿', '在精读笔记之后多一次受限模型调用，产出案例拆解、归因与联合覆盖审计的待审草稿；本地评审覆盖层由 reviewProfile 配置。'],
    ['auto-paper-conversation', '实时伴学：保存批注后自动回复', '有文字评论的新批注和修改会在主机排队，回复跟随原批注；使用本篇模型额度。历史批注不会批量重发。'],
  ];
  function create({api,persistence,onChange=()=>{},getLibrary=()=>'',getPaper=()=>null,onLanguageSettings}) {
    let snapshot=null,busy=false,refreshing=null,refreshAgain=false,disposed=false,timer=null,pendingPatch=null,visibleTimer=null,generation=0,readingPreferences=0,resourceDraft=null,resourceDraftRevision=null;
    const make=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n;};
    const trigger=make('button','button subtle','设置');trigger.id='settings-open';trigger.type='button';trigger.title='Paper Library 设置';
    (document.querySelector('#topbar-end')||document.querySelector('.topbar-actions')).append(trigger);
    const dialog=make('dialog','library-settings');dialog.id='library-settings';dialog.setAttribute('aria-labelledby','library-settings-title');
    const header=make('header'),title=make('strong','','Paper Library 设置');title.id='library-settings-title';
    const windowActions=make('div','settings-window-actions');
    const expand=make('button','button subtle','全页设置');expand.id='settings-expand';expand.type='button';
    const close=make('button','icon-button','×');close.type='button';close.setAttribute('aria-label','关闭设置');close.addEventListener('click',()=>dialog.close());
    windowActions.append(expand,close);header.append(title,windowActions);
    const description=make('p','settings-description','DSH 中的入口：设置 → Paper Library（也保留插件配置入口）。');
    const status=make('p','settings-status');status.id='settings-status';status.setAttribute('role','status');
    const controls=make('fieldset'),legend=make('legend','','阅读与自动化');controls.append(legend);
    const paletteControls=make('fieldset','settings-palettes'),paletteLegend=make('legend','','界面配色');paletteControls.append(paletteLegend);
    const paletteInputs=new Map();
    for(const [value,label,help] of [['jade','墨绿铜金','温暖纸面 · 墨绿操作'],['navy','深海蓝灰','清亮白底 · 海蓝操作'],['neutral','石墨中性','中性灰阶 · 专业克制'],['rose','樱粉柔光','柔粉纸面 · 玫瑰操作'],['apricot','杏橙暖光','奶杏纸面 · 暖橙操作'],['system','跟随 DSH','沿用宿主配色']]){
      const row=make('label','settings-palette'),input=make('input'),swatches=make('span','palette-swatches'),copy=make('span');
      row.setAttribute('data-palette-option',value);input.type='radio';input.name='paper-library-palette';input.value=value;input.id=`setting-palette-${value}`;swatches.setAttribute('aria-hidden','true');
      copy.append(make('strong','',label),make('small','',help));row.append(input,swatches,copy);paletteControls.append(row);paletteInputs.set(value,{input,row});input.addEventListener('change',()=>{if(input.checked)void save({ui_palette:value});});
    }
    paletteControls.append(make('p','palette-legend','阅读 · 墨绿　知识 · 紫色　写作 · 海蓝　演示 · 铜金。明暗随 DSH；PDF 批注保留原色。'));
    const resourceControls=make('fieldset','settings-resources');resourceControls.id='settings-resources';resourceControls.append(make('legend','','资源与性能'));
    const resourceProfile=make('select');resourceProfile.id='setting-resource_profile';resourceProfile.setAttribute('aria-label','资源档位');
    for(const [value,label]of [['eco','节能 · 256 MiB'],['balanced','均衡 · 512 MiB'],['performance','高性能 · 1024 MiB'],['custom','自定义']]){const option=make('option','',label);option.value=value;resourceProfile.append(option);}resourceControls.append(resourceProfile);
    const resourceHelp=make('p','small','处理内存目标用于分配预览缓存与 PDF 处理预算，不是整个 DSH／浏览器的内存硬上限。磁盘索引预算单独设置；保存后下一批生效。切换预设不覆盖已保存的自定义参数。');resourceControls.append(resourceHelp);
    const resourceGrid=make('div','settings-resource-grid'),resourceInputs=new Map();resourceControls.append(resourceGrid);
    const resourceSummary=make('p','small');resourceSummary.setAttribute('role','status');resourceControls.append(resourceSummary);
    const resourceApply=make('button','button','保存资源配置'),resourceReset=make('button','button subtle','恢复已保存');resourceApply.type=resourceReset.type='button';resourceControls.append(resourceApply,resourceReset);
    function editResources(patch){if(!resourceDraft){resourceDraft={...snapshot.value};resourceDraftRevision=snapshot.revision;}Object.assign(resourceDraft,patch);}
    function renderResources(){resourceControls.disabled=busy||!snapshot?.writable;const chosen=resourceDraft||snapshot?.value||{},profile=chosen.resource_profile||'balanced';resourceProfile.value=profile;
      const effective=profile==='custom'?chosen:(snapshot?.resource_profiles?.[profile]?.values||snapshot?.resource_policy?.values||{});
      for(const [key,rule]of Object.entries(snapshot?.resource_fields||{})){if(!resourceInputs.has(key)){const row=make('label','settings-resource-field'),input=make('input');input.type='number';input.id=`setting-${key}`;input.min=rule.minimum;input.max=rule.maximum;input.step='1';row.append(make('span','',rule.label),input);resourceGrid.append(row);resourceInputs.set(key,input);input.addEventListener('input',()=>editResources({resource_profile:'custom',[key]:Number(input.value)}));}const input=resourceInputs.get(key);input.disabled=profile!=='custom';if(document.activeElement!==input)input.value=effective[key]??rule.default;}
      resourceSummary.textContent=snapshot?.resource_warning?`配置需要调整：${snapshot.resource_warning}；当前暂用均衡档。`:`当前预览 ${effective.resource_preview_mb??48} MiB · 每批 ${effective.resource_batch_pages??2} 页 · 间隔 ${effective.resource_batch_gap_ms??1000} ms。前台优先，后台处理保持串行。`;
      if(resourceDraft&&snapshot&&resourceDraftRevision!==snapshot.revision)resourceSummary.textContent+=' 主机设置已更新，本窗口资源草稿仍保留；请核对后点击「恢复已保存」读取新值，再修改。';
    }
    resourceProfile.addEventListener('change',()=>{editResources({resource_profile:resourceProfile.value});renderResources();});
    resourceReset.addEventListener('click',async()=>{await refresh();if(snapshot){resourceDraft=null;resourceDraftRevision=null;renderResources();}});
    resourceApply.addEventListener('click',async()=>{const profile=resourceProfile.value,patch={resource_profile:profile};if(profile==='custom')for(const [key,input]of resourceInputs)patch[key]=Number(input.value);if(await save(patch,{expectedRevision:resourceDraftRevision??snapshot.revision,resource:true})){resourceDraft=null;resourceDraftRevision=null;renderResources();}});
    const inputs=new Map();
    const distributionDefaults={reading_distribution_enabled:true,reading_distribution_mode:'density',reading_distribution_ai:true,reading_distribution_smoothing:3};
    const distributionControls=make('fieldset');distributionControls.id='settings-reading-distribution';distributionControls.append(make('legend','','划线阅读轨迹'),make('p','small','按 PDF 位置展示原生标记分布，帮助回看划线集中处；不代表阅读完成率或理解程度。'));
    for(const [key,label,help]of [
      ['reading_distribution_enabled','显示阅读轨迹条带','浅薄荷色表示其他或未知来源的标记，不将其认定为人工划线。'],
      ['reading_distribution_ai','显示 AI 样式轨迹（蓝色虚线）','与其他标记分开显示；仅按原生蓝色虚线识别，样式不能证明来源。'],
    ]){const row=make('label','settings-option'),input=make('input'),copy=make('span');input.type='checkbox';input.setAttribute('role','switch');input.id=`setting-${key}`;const hint=make('small','',help);hint.id=`setting-${key}-hint`;input.setAttribute('aria-describedby',hint.id);copy.append(make('strong','',label),hint);row.append(input,copy);distributionControls.append(row);inputs.set(key,input);input.addEventListener('change',()=>void save({[key]:input.checked}));}
    const distributionMode=make('select');distributionMode.id='setting-reading_distribution_mode';distributionMode.setAttribute('aria-label','展示方式');distributionMode.setAttribute('aria-describedby','setting-reading_distribution_mode-hint');
    for(const[value,label]of [['density','平滑密度'],['bands','划线条带']]){const option=make('option','',label);option.value=value;distributionMode.append(option);}
    const modeRow=make('label','settings-side'),modeHint=make('p','small','平滑密度概括划线集中处，条带保留位置分布。');modeHint.id='setting-reading_distribution_mode-hint';modeRow.append(make('span','','展示方式'),distributionMode);distributionControls.append(modeRow,modeHint);inputs.set('reading_distribution_mode',distributionMode);distributionMode.addEventListener('change',()=>void save({reading_distribution_mode:distributionMode.value}));
    const smoothing=make('select');smoothing.id='setting-reading_distribution_smoothing';smoothing.setAttribute('aria-label','平滑范围');smoothing.setAttribute('aria-describedby','setting-reading_distribution_smoothing-hint');
    for(let value=1;value<=6;value++){const option=make('option','',`${value}${value===3?'（默认）':''}`);option.value=String(value);smoothing.append(option);}
    const smoothingRow=make('label','settings-side'),smoothingHint=make('p','small','1–6，值越大越平滑；仅影响密度展示，不改变原始标记。');smoothingHint.id='setting-reading_distribution_smoothing-hint';smoothingRow.append(make('span','','平滑范围'),smoothing);distributionControls.append(smoothingRow,smoothingHint);inputs.set('reading_distribution_smoothing',smoothing);smoothing.addEventListener('change',()=>void save({reading_distribution_smoothing:Number(smoothing.value)}));
    const fontRow=make('label','settings-side'),fontSize=make('select');fontSize.id='setting-annotation_font_size';fontSize.setAttribute('aria-label','批注字号');
    for(let size=12;size<=24;size++){const option=make('option','',`${size} px${size===14?'（默认）':''}`);option.value=String(size);fontSize.append(option);}
    fontRow.append(make('span','','批注字号'),fontSize);controls.append(fontRow,make('p','small','用于批注原文、备注与 AI 回复。修改后自动保存，下次打开仍生效。'));inputs.set('annotation_font_size',fontSize);fontSize.addEventListener('change',()=>void save({annotation_font_size:Number(fontSize.value)}));
    for(const [key,label,help] of fields){const row=make('label','settings-option'),input=make('input');input.type='checkbox';input.setAttribute('role','switch');input.id=`setting-${key}`;const copy=make('span');copy.append(make('strong','',label),make('small','',help));row.append(input,copy);controls.append(row);inputs.set(key,input);input.addEventListener('change',()=>void save({[key]:input.checked}));}
    const sideRow=make('label','settings-side'),side=make('select');side.id='setting-reading-panel-side';side.setAttribute('aria-label','阅读侧栏位置');for(const [value,label]of[['left','左侧'],['right','右侧']]){const option=make('option','',label);option.value=value;side.append(option);}sideRow.append(make('span','','阅读侧栏'),side);controls.append(sideRow);inputs.set('reading-panel-side',side);side.addEventListener('change',()=>void save({'reading-panel-side':side.value}));
    const syncRow=make('label','settings-option settings-text-field'),syncInput=make('input');syncInput.type='text';syncInput.id='setting-sync_config';syncInput.placeholder='/absolute/path/to/sync-service/config.json';syncInput.autocomplete='off';syncInput.spellcheck=false;
    const syncCopy=make('span');syncCopy.append(make('strong','','数据同步服务配置（可选）'),make('small','','指向另一个同步/备份插件自己的 JSON 配置；论文仓库只读其中的目录列表，把它当作外部文献源按符号链接纳入。留空表示不启用，插件不依赖它。'));
    syncRow.append(syncCopy,syncInput);controls.append(syncRow);inputs.set('sync_config',syncInput);
    syncInput.addEventListener('change',()=>void save({sync_config:syncInput.value.trim()}));
    const extraRow=make('label','settings-option settings-text-field'),extraInput=make('input');extraInput.type='text';extraInput.id='setting-external_sources';extraInput.placeholder='[{"id":"archive","root":"/Volumes/archive/papers"}]';extraInput.autocomplete='off';extraInput.spellcheck=false;
    const extraCopy=make('span');extraCopy.append(make('strong','','额外外部文献源'),make('small','','JSON 数组，每项 {id, root}；根目录写绝对路径。扫描只建符号链接，不改动源目录，第一次写批注时才复制进来。'));
    extraRow.append(extraCopy,extraInput);controls.append(extraRow);inputs.set('external_sources',extraInput);
    extraInput.addEventListener('change',()=>void save({external_sources:extraInput.value.trim()}));
    const storage=make('details','settings-storage'),summary=make('summary','','模型、外观与存储');storage.append(summary);
    const modelSettings=window.PaperSettingsModels?.create({api,container:storage});
    storage.addEventListener('toggle',()=>{if(storage.open)void modelSettings?.refresh();});
    storage.append(make('p','','明暗模式跟随 DSH；界面配色与批注字号可在上方调整。'));
    const languageSettings=make('button','button subtle','语言模型与提示词');languageSettings.id='settings-language';languageSettings.type='button';languageSettings.addEventListener('click',()=>{dialog.close();onLanguageSettings?.();});storage.append(languageSettings);
    const path=make('p','settings-path');storage.append(path,make('p','','文献、PDF、草稿和设置均保存在主机磁盘，不写入浏览器 localStorage。更换资料库目录需要修改部署配置，已有数据不会自动搬迁。'));
    const maintenance=make('section','settings-maintenance');maintenance.setAttribute('aria-label','导出与维护');
    maintenance.append(make('strong','','导出与维护'),make('p','','导出文献与数据集的 BibLaTeX 引用资料。演示文稿请在 Slides 工作台中导出。'));
    const exportLibrary=document.getElementById?.('export-library');if(exportLibrary)maintenance.append(exportLibrary);
    const footer=make('footer'),reload=make('button','button subtle','重新读取'),reset=make('button','button subtle','恢复默认');reload.type=reset.type='button';reload.addEventListener('click',()=>{void refresh();if(storage.open)void modelSettings?.refresh();});reset.addEventListener('click',()=>void save(null));footer.append(reload,reset);
    const layout=make('div','settings-layout'),body=make('div','settings-body'),sections=make('nav','settings-sections');
    sections.hidden=true;sections.setAttribute('aria-label','设置目录');
    for(const [label,section] of [
      ['界面配色',paletteControls],['划线阅读轨迹',distributionControls],
      ['资源与性能',resourceControls],['阅读与自动化',controls],
      ['模型、外观与存储',storage],['导出与维护',maintenance],
    ]){
      const jump=make('button','button subtle',label);jump.type='button';
      section.tabIndex=-1;
      jump.addEventListener('click',()=>{section.scrollIntoView?.({block:'start'});section.focus?.({preventScroll:true});});
      sections.append(jump);
    }
    body.append(description,status,languageSettings,paletteControls,distributionControls,resourceControls,controls,storage,maintenance);
    layout.append(sections,body);dialog.append(header,layout,footer);document.body.append(dialog);
    let fullPage=false;
    function setFullPage(value){
      fullPage=value;
      dialog.classList.toggle('is-expanded',value);
      sections.hidden=!value;
      expand.textContent=value?'还原弹窗':'全页设置';
    }
    expand.addEventListener('click',()=>setFullPage(!fullPage));
    dialog.addEventListener('cancel',event=>{if(fullPage){event.preventDefault();setFullPage(false);expand.focus?.();}});
    function say(text,error=false){status.textContent=text;status.classList.toggle('error',error);}
    function render(){
      renderResources();
      controls.disabled=busy||!snapshot?.writable;reset.disabled=busy||!snapshot?.writable;reload.disabled=busy;
      distributionControls.disabled=busy||!snapshot?.writable;
      const shown={...distributionDefaults,...snapshot?.value,...pendingPatch};
      paletteControls.disabled=busy||!snapshot?.writable;
      for(const [value,{input,row}]of paletteInputs){input.checked=value===(shown.ui_palette||'jade');row.classList.toggle('is-selected',input.checked);}
      for(const[key,input]of inputs){if(input.type==='text'&&document.activeElement===input)continue;if(input.type==='checkbox')input.checked=shown[key]===true;else if(input.tagName==='SELECT'||input===fontSize||input===distributionMode||input===smoothing)input.value=String(shown[key]??(key==='annotation_font_size'?14:'left'));else input.value=shown[key]??'';}
      path.textContent=`资料库：${getLibrary()||'正在读取…'}`;
      description.textContent=snapshot?.backend==='dsh'&&snapshot.available===false?'设置由 DSH 管理。请在 DSH 的 Paper Library 面板或「设置 → Paper Library」中修改。':snapshot?.backend==='local'?'独立运行：设置保存在本机。安装到 DSH 后，插件设置会接入 DSH 的统一设置。':'DSH 中的入口：设置 → Paper Library（也保留插件配置入口）。两个入口共享同一份主机设置。';
    }
    function drainRefresh(){if(refreshAgain&&!disposed&&!busy&&!refreshing){refreshAgain=false;queueMicrotask(()=>void refresh());}}
    async function syncPreferences(){readingPreferences++;try{await persistence?.get('preferences');}finally{readingPreferences--;}}
    async function refresh(){
      if(disposed)return;if(busy){refreshAgain=true;return;}if(refreshing){generation++;refreshAgain=true;return refreshing;}
      clearTimeout(timer);const ticket=generation;
      refreshing=(async()=>{try{const result=await api('settings_get');if(disposed||ticket!==generation)return;
        // Advance the legacy inline controls' CAS snapshot after a native edit.
        // Only preferences are touched; open note/chat drafts stay intact.
        await syncPreferences();if(disposed||ticket!==generation)return;snapshot=result;onChange(result.value||{},result);render();say(result.available===false?'当前页面未连接 DSH 设置服务。':'已与主机设置同步');
      }catch(error){if(!disposed&&ticket===generation){snapshot=null;onChange({},{writable:false,available:false});render();say(`设置读取失败：${error.message}`,true);}}finally{refreshing=null;drainRefresh();}})();return refreshing;
    }
    async function save(patch,{expectedRevision=snapshot?.revision,resource=false}={}){
      if(disposed||busy||!snapshot?.writable){render();return;}busy=true;generation++;clearTimeout(timer);pendingPatch=patch;render();say('正在保存…');
      try{const result=await api(patch?'settings_update':'settings_reset',{...(patch?{patch}:{}),expected_revision:expectedRevision});
        if(disposed)return;await syncPreferences();if(disposed)return;snapshot=result;onChange(result.value||{},result);
        const confirmed=patch?Object.entries(patch).every(([key,value])=>result.value?.[key]===value):[...inputs.keys()].every(key=>!Object.hasOwn(result.user||{},key));
        if(!confirmed)throw new Error('设置已被另一窗口更新');
        say(result.backend==='dsh'?'已保存到主机，DSH 设置同步生效':'已保存到本机');return true;
      }catch(error){if(!disposed)say(resource?`未保存：${error.message}。资源草稿仍保留；请核对后点击「恢复已保存」，再修改。`:`未保存：${error.message}。请重新读取后再修改。`,true);return false;}
      finally{busy=false;pendingPatch=null;if(!disposed)render();drainRefresh();}
    }
    const schedule=()=>{if(disposed)return;if(busy||refreshing){if(refreshing)generation++;refreshAgain=true;return;}clearTimeout(timer);timer=setTimeout(()=>void refresh(),50);};
    // Reading the CAS mirror emits "saved" itself; it is not a new Host
    // invalidation. Native/focus events still queue a trailing refresh while
    // either the document request or this mirror read is pending.
    const unsubscribe=persistence?.subscribe(event=>{if(!readingPreferences&&event.key==='preferences'&&event.status==='saved')schedule();});
    function receive(event){const v=event.data;if(window.parent===window||event.source!==window.parent||event.origin!==window.location.origin||v?.type!=='paper-library:settings-changed'||v.version!==1||v.namespace!=='paper-library'||!Number.isSafeInteger(v.revision))return;schedule();}
    const focus=()=>{if(!document.hidden)schedule();};window.addEventListener('message',receive);window.addEventListener('focus',focus);document.addEventListener('visibilitychange',focus);
    function showDialog(){
      if(!dialog.open){setFullPage(false);dialog.showModal();}
      clearInterval(visibleTimer);visibleTimer=setInterval(()=>{if(dialog.open&&!document.hidden)schedule();},3000);
    }
    trigger.addEventListener('click',()=>{showDialog();void refresh();if(storage.open)void modelSettings?.refresh();});
    dialog.addEventListener('close',()=>{if(!dialog.open){setFullPage(false);clearInterval(visibleTimer);visibleTimer=null;}});
    if(window.parent!==window)window.parent.postMessage({type:'paper-library:settings-ready',version:1},window.location.origin);
    render();
    return {refresh,async showResources(){showDialog();await refresh();resourceControls.scrollIntoView?.({block:'start'});resourceProfile.focus?.();},dispose(){disposed=true;clearTimeout(timer);clearInterval(visibleTimer);unsubscribe?.();window.removeEventListener('message',receive);window.removeEventListener('focus',focus);document.removeEventListener('visibilitychange',focus);}};
  }
  return {create};
})();
