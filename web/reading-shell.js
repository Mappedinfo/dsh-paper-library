'use strict';

/** Contextual office-style ribbon. It moves existing controls, keeping their handlers. */
window.PaperReadingShell = (() => {
  const hints = {
    select: '拖选文字，可添加批注或放入论文对话。',
    highlight: '拖选要高亮的文字，再写下想法并保存。',
    underline: '拖选文字，保存为 PDF 下划线批注。',
    strikeout: '拖选文字，保存为 PDF 删除线批注。',
    note: '点击页面中的位置，添加一条便笺。',
    square: '拖框标记图片细节；可添加说明后保存为 PDF 矩形批注。',
    ink: '用笔或鼠标自由写画；点「完成笔画」继续阅读，保存为 PDF 原生笔迹。',
  };
  const MODES = { auto: '自动着色', ask: '勾选后提问' };
  const MODE_HINTS = {
    auto: { select: '拖选文字即按当前颜色直接着色，之后可在批注栏提问。', highlight: '拖选文字即高亮保存，不再弹出对话框。', underline: '拖选文字即保存下划线，不再弹出对话框。', strikeout: '拖选文字即保存删除线，不再弹出对话框。' },
    ask: { select: '拖选文字，可添加批注或放入论文对话。' },
  };
  function placeMenu(disclosure, panel) {
    if (!disclosure?.open || !panel) return;
    window.PaperFloatingWindows?.placeBelow(disclosure.querySelector('summary'), panel);
  }
  function create({state, workbench, panels, reader, navigate, toast, contextChanged, persistence, diagnostics, saveInk, returnToInk, beforeToolChange, locateAnnotations}) {
    const $ = id => document.getElementById(id);
    const node = (tag, text, className) => { const n=document.createElement(tag);if(text)n.textContent=text;if(className)n.className=className;return n; };
    const button = (id, text, action) => {const n=node('button',text,'button subtle');n.type='button';n.id=id;n.addEventListener('click',action);return n;};
    const top=document.querySelector('.topbar'), workspace=document.querySelector('.workspace');
    const menus=[];
    const placeMenus=()=>{for(const {disclosure,panel} of menus)placeMenu(disclosure,panel);};
    const bindMenu=(disclosure,panel)=>{
      if(!disclosure||!panel)return;
      const toggle=()=>{if(!disclosure.open)return;for(const other of menus)if(other.disclosure!==disclosure)other.disclosure.open=false;placeMenu(disclosure,panel);};
      disclosure.addEventListener('toggle',toggle);menus.push({disclosure,panel,toggle});
    };
    let context='reader', tool='select', color='#ffdb66', inkColor='#2455a4', inkWidth=2, mode='ask', markup='highlight', focused=false, saveLayoutTimer=null, penOnly=false, darkPdf=false, bionic=false, appearanceTouched=false;
    let inkBusy=false, inkError='', inkTitle='', linkedSession=null, linkedBusy=false, finishLinked=null, inkRecords=[];
    const applyTool=()=>reader()?.setTool(tool,['ink','square'].includes(tool)?{color:inkColor,width:inkWidth}:color);
    const ribbon=node('nav',null,'reader-ribbon');ribbon.setAttribute('aria-label','文献工作区');
    const projectActions=document.querySelector('.project-actions');
    projectActions?.addEventListener('click',event=>{if(event.target.closest('.project-actions-panel button'))projectActions.open=false;});
    bindMenu(projectActions,$('project-actions-panel'));
    const library=button('workspace-library','库',()=>{leaveFocus();$('catalog-expand').click();});
    library.title='展开或收起文献表格';ribbon.append(library);
    const tabs=document.querySelector('.tabs');for(const tab of [...tabs.children])ribbon.append(tab);tabs.remove();
    const citations=node('details',null,'citation-tools');citations.id='citation-tools';
    citations.append(node('summary','引用与导出'));
    citations.append($('toolbar-actions'));$('paper-tools').append(citations);
    bindMenu(citations,$('toolbar-actions'));
    citations.addEventListener('toggle',()=>{if(citations.open)status('对当前论文复制引用，或导出文件与已保存的批注。');});
    // Metadata and chat stay within reading; graph is the only other paper surface.
    $('metadata-open').textContent='资料详情';$('metadata-open').title='查看与编辑文献资料详情';
    ribbon.append($('metadata-open'));if($('paper-reveal'))ribbon.append($('paper-reveal'));
    const fullscreen=button('reader-fullscreen','全屏阅读 ⤢',()=>void toggleFullscreen());
    fullscreen.title='全屏阅读；Esc 返回';ribbon.append(fullscreen);
    top.insertBefore(ribbon,$('paper-tools'));
    const readerTools=$('toolbar-reader'), annotationTools=node('div',null,'annotation-tool-group'), libraryTools=node('div',null,'library-tool-group');
    annotationTools.id='toolbar-annotation';annotationTools.setAttribute('role','group');annotationTools.setAttribute('aria-label','PDF 批注工具');libraryTools.id='toolbar-library';
    for(const [type,label] of [['select','选择'],['ink','自由笔画'],['square','矩形框'],['highlight','高亮'],['underline','下划线'],['strikeout','删除线'],['note','便笺']]){
      const b=button(`reader-tool-${type}`,label,async()=>{if(beforeToolChange&&!await beforeToolChange(type))return;tool=type;context='annotations';if(['highlight','underline','strikeout'].includes(type)){markup=type;saveLayoutLater();}applyTool();sync();status(hintFor());});b.dataset.readerTool=type;annotationTools.append(b);
    }
    const colorLabel=node('label','颜色','reader-color');const input=node('input');input.type='color';input.id='reader-color';input.value=color;input.setAttribute('aria-label','批注颜色');
    // Layout preferences share one write queue: overlapping read-modify-write
    // patches race the revision and would surface as a save conflict banner.
    let layoutQueue=Promise.resolve();
    const patchLayout=value=>{layoutQueue=layoutQueue.then(()=>persistence?persistence.patch('reader:layout',value):null).catch(()=>{});return layoutQueue;};
    const saveLayout=()=>patchLayout({mode,color,markup,inkColor,inkWidth});
    const appearance=node('details',null,'reader-appearance');appearance.id='reader-appearance';
    const appearanceSummary=node('summary','阅读显示');appearanceSummary.setAttribute('aria-controls','reader-appearance-options');appearance.append(appearanceSummary);
    const appearanceOptions=node('div',null,'reader-pen-options');appearanceOptions.id='reader-appearance-options';
    const darkCheck=node('input'),bionicCheck=node('input');darkCheck.type=bionicCheck.type='checkbox';darkCheck.id='reader-dark-pdf';bionicCheck.id='reader-bionic';
    for(const [check,label] of [[darkCheck,'深色 PDF'],[bionicCheck,'仿生阅读（英文）']]){const row=node('label');row.append(check,document.createTextNode(label));appearanceOptions.append(row);}
    bionicCheck.title='加粗英文单词前半部分；扫描页需要可用文字层。';darkCheck.title='仅调整页面显示，图表颜色也会变化；关闭可查看原色。';
    appearance.append(appearanceOptions);ribbon.insertBefore(appearance,fullscreen);bindMenu(appearance,appearanceOptions);
    const applyAppearance=()=>{darkCheck.checked=darkPdf;bionicCheck.checked=bionic;reader()?.setReadingAppearance?.({darkPdf,bionic});};
    const changeAppearance=()=>{appearanceTouched=true;darkPdf=darkCheck.checked;bionic=bionicCheck.checked;applyAppearance();void patchLayout({darkPdf,bionic});};
    darkCheck.addEventListener('change',changeAppearance);bionicCheck.addEventListener('change',changeAppearance);

    const saveLayoutLater=()=>{if(saveLayoutTimer!==null)window.clearTimeout(saveLayoutTimer);saveLayoutTimer=window.setTimeout(()=>{saveLayoutTimer=null;saveLayout();},150);};
    const hintFor=()=>tool==='ink'&&reader()?.getInkContext?.()?'直接在本页写画，笔迹绑定当前批注；再点侧栏手写按钮返回常规标注。':(MODE_HINTS[mode]||{})[tool]||hints[tool]||'';
    input.addEventListener('input',()=>{if(['ink','square'].includes(tool))inkColor=input.value;else color=input.value;applyTool();saveLayout();sync();});colorLabel.append(input);
    const presetsMenu=node('details',null,'reader-color-presets-menu'),presetsSummary=node('summary','常用配色');presetsMenu.append(presetsSummary);
    const presetsPanel=node('div',null,'reader-pen-options');
    const presets=window.PaperAnnotationStyle?.palette(input.value,value=>{input.value=value;input.dispatchEvent(new Event('input',{bubbles:true}));});
    if(presets){presetsPanel.append(presets.element);presetsMenu.append(presetsPanel);bindMenu(presetsMenu,presetsPanel);presetsMenu.addEventListener('toggle',()=>{if(presetsMenu.open)presets.set(input.value);});input.addEventListener('input',()=>presets.set(input.value));}
    const widthLabel=node('label','粗细','reader-ink-width');const widthInput=node('select');widthInput.id='reader-ink-width';widthInput.setAttribute('aria-label','笔画与矩形边框粗细');
    for(const [value,label] of [[1,'细'],[2,'中'],[4,'粗']]){const option=node('option',label);option.value=String(value);widthInput.append(option);}widthInput.value=String(inkWidth);widthLabel.append(widthInput);
    widthInput.addEventListener('change',()=>{inkWidth=Number(widthInput.value);applyTool();saveLayout();});
    // Two reading habits: mark while reading (自动着色) or select then ask
    // (勾选后提问, the default). The choice, colour and markup type persist.
    const modeGroup=node('div',null,'reader-mode');modeGroup.id='reader-mode-group';modeGroup.setAttribute('role','group');modeGroup.setAttribute('aria-label','选文后的行为');
    modeGroup.append(node('span','选文后','reader-mode-label'));
    const modeButtons={};
    for(const [value,label] of Object.entries(MODES)){
      const b=button(`reader-mode-${value}`,label,()=>{mode=value;if(value==='auto'&&tool==='select')reader()?.setTool(tool,color);saveLayout();sync();status(hintFor());});
      b.setAttribute('aria-pressed',String(mode===value));modeButtons[value]=b;modeGroup.append(b);
    }
    const penSettings=node('details',null,'reader-pen-settings');penSettings.id='reader-pen-settings';
    const penSummary=node('summary','笔输入');penSummary.setAttribute('aria-controls','reader-pen-options');penSettings.append(penSummary);
    const penOptions=node('div',null,'reader-pen-options'),penLabel=node('label'),penCheck=node('input');penOptions.id='reader-pen-options';penCheck.type='checkbox';penCheck.id='reader-pen-only';penLabel.append(penCheck,document.createTextNode('仅用笔标注'));
    const inputKind=node('p','在页面上用笔或手指操作后显示识别结果。');inputKind.id='reader-input-kind';inputKind.setAttribute('role','status');
    penOptions.append(penLabel,inputKind,node('p','手写和划线标注时，手指拖动页面可滚动；选择和便笺仍可用鼠标操作。若 Pencil 被识别为鼠标兼容输入，请关闭「仅用笔标注」。'));penSettings.append(penOptions);
    if(diagnostics){const exportLog=button('reader-ink-diagnostics','导出手写诊断',async()=>{exportLog.disabled=true;try{const report=await diagnostics.exportReport(),url=URL.createObjectURL(new Blob([JSON.stringify(report,null,2)],{type:'application/json'})),a=document.createElement('a');a.href=url;a.download='handwriting-diagnostics.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);toast('手写诊断已导出，包含最近事件与笔数，不含正文或笔迹坐标。');}catch(error){toast(error.message,true);}finally{exportLog.disabled=false;}});penOptions.append(exportLog);}
    penCheck.addEventListener('change',()=>{penOnly=penCheck.checked;reader()?.setPenOnly?.(penOnly);void patchLayout({penOnly});status(hintFor());});
    function inputChanged(info){const labels={pen:'已识别：手写笔',touch:'已识别：触控',mouse:'收到：鼠标兼容输入',unknown:'输入类型未能识别'};inputKind.dataset.inputKind=info?.lastType||'';inputKind.textContent=labels[info?.lastType]||'在页面上用笔或手指操作后显示识别结果。';if(info?.seenPen&&info.lastType!=='pen')inputKind.textContent+=' · 已检测到手写笔';}
    bindMenu(penSettings,penOptions);
    penSettings.addEventListener('toggle',()=>{if(penSettings.open)inputChanged(reader()?.getInputInfo?.());});
    annotationTools.append(modeGroup,colorLabel);if(presets)annotationTools.append(presetsMenu);annotationTools.append(widthLabel,penSettings);
    // Fit-width default with free zoom: steppers, an explicit percentage and reset.
    let zoom=1, zoomSaveTimer=null;
    const zoomGroup=node('span',null,'reader-zoom');
    const zoomOut=button('reader-zoom-out','−',()=>setZoom(zoom/1.2));zoomOut.title='缩小';
    const percent=node('input');percent.id='reader-zoom-percent';percent.type='number';percent.min='25';percent.max='400';percent.step='5';percent.value='';percent.placeholder='全宽';percent.setAttribute('aria-label','PDF 缩放百分比，相对于全宽');percent.title='相对于全宽的缩放百分比（25–400）；全宽随阅读区域自动适配';
    const zoomIn=button('reader-zoom-in','＋',()=>setZoom(zoom*1.2));zoomIn.title='放大';
    const zoomFit=button('reader-zoom-fit','全宽',()=>{const applied=reader()?.fitToWidth();if(applied!==undefined)zoomChanged(applied);});zoomFit.title='适配当前阅读区域宽度';zoomFit.setAttribute('aria-pressed','true');
    const zoomPage=button('reader-zoom-page','整页',()=>{const applied=reader()?.fitPage();if(applied!==undefined)zoomChanged(applied);});zoomPage.title='完整显示当前页；双页布局适配整组页面';
    function showZoom(){const fit=Math.abs(zoom-1)<.001;percent.value=fit?'':String(Math.round(zoom*100));zoomFit.setAttribute('aria-pressed',String(fit));}
    function zoomChanged(value){if(!Number.isFinite(value))return;zoom=value;showZoom();if(zoomSaveTimer!==null)window.clearTimeout(zoomSaveTimer);if(persistence)zoomSaveTimer=window.setTimeout(()=>{zoomSaveTimer=null;void patchLayout({zoom});},250);}
    function setZoom(value){const applied=reader()?.setZoom(value);if(applied===undefined)return;zoomChanged(applied);}
    const commitZoom=()=>{if(percent.value.trim()){const value=Number(percent.value);if(Number.isFinite(value))setZoom(value/100);}showZoom();};
    percent.addEventListener('change',commitZoom);
    percent.addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();commitZoom();}});
    zoomGroup.append(zoomOut,percent,zoomIn);readerTools.append(zoomGroup);
    const layoutGroup=node('span',null,'reader-layout');layoutGroup.setAttribute('role','group');layoutGroup.setAttribute('aria-label','PDF 阅读布局');layoutGroup.append(zoomFit,zoomPage);
    const layoutButtons={};let layoutTouched=false;
    function selectLayout(value){reader()?.setLayout?.(value);for(const[key,b]of Object.entries(layoutButtons))b.setAttribute('aria-pressed',String(key===value));}
    for(const[value,label,icon]of [['single','单页','rectangle-vertical'],['spread','双页','columns-2']]){
      const b=button(`reader-layout-${value}`,label,async()=>{if(beforeToolChange&&!await beforeToolChange())return;layoutTouched=true;selectLayout(value);void patchLayout({readerLayout:value});});
      b.title=value==='spread'?'两页并排连续阅读':'单页连续阅读';window.PaperIcons?.decorate(b,icon);layoutButtons[value]=b;layoutGroup.append(b);
    }
    readerTools.append(layoutGroup);selectLayout(reader()?.getLayout?.()||'single');
    const locateNotes=button('reader-locate-annotations','定位本页批注',()=>locateAnnotations?.());locateNotes.title='滚动批注栏到当前 PDF 页；无批注时定位最近页';readerTools.append(locateNotes);
    if(persistence)void persistence.get('reader:layout').then(value=>{
      if(!layoutTouched&&['single','spread'].includes(value?.readerLayout))selectLayout(value.readerLayout);
      const saved=Number(value?.zoom);if(Number.isFinite(saved)&&saved!==1)setZoom(saved);
      if(typeof value?.color==='string'&&/^#[0-9a-f]{6}$/i.test(value.color))color=value.color;
      if(typeof value?.inkColor==='string'&&/^#[0-9a-f]{6}$/i.test(value.inkColor))inkColor=value.inkColor;
      if([1,2,4].includes(value?.inkWidth))inkWidth=value.inkWidth;
      if(!appearanceTouched){darkPdf=value?.darkPdf===true;bionic=value?.bionic===true;applyAppearance();}
      if(typeof value?.penOnly==='boolean'){penOnly=value.penOnly;penCheck.checked=penOnly;reader()?.setPenOnly?.(penOnly);}
      applyTool();
      if(typeof value?.markup==='string'&&['highlight','underline','strikeout'].includes(value.markup))markup=value.markup;
      if(typeof value?.mode==='string'&&Object.hasOwn(MODES,value.mode))mode=value.mode;
      sync();
    }).catch(()=>{});
    // One global import entry. Link intake belongs inside that same import surface.
    $('import-open').textContent='导入';libraryTools.append($('import-open'),$('build-bibliography'),$('metadata-enrich'));
    // The shelf disclosures keep their original IDs and toggle events. Their
    // content lives below the shared row so each expanded panel has full width.
    const organizerDisclosures=[['board-shelf','board-shelf-panel'],['latex-version-shelf','latex-version-shelf-panel']].map(([id,panelId])=>{
      const disclosure=$(id),panel=$(panelId);if(!disclosure||!panel)return null;const update=()=>{panel.hidden=!disclosure.open;};
      disclosure.addEventListener('toggle',update);update();return {disclosure,update};
    }).filter(Boolean);
    $('quick-import-form').hidden=true;
    const quick=$('quick-import-source');quick.disabled=true;
    $('paper-tools').append(libraryTools);
    // An unattached record has a direct recovery action on its empty reading surface.
    $('no-pdf').append($('attach-open'));
    $('previous-page').hidden=true;$('next-page').hidden=true;
    $('page-number').title='输入页码跳转，也可直接滚动阅读';
    const note=$('page-note');note.textContent='页便笺';annotationTools.append(note);
    const message=$('page-message');message.className='ribbon-status';message.setAttribute('role','status');message.setAttribute('aria-live','polite');
    const statusBar=node('div',null,'reader-status-bar');statusBar.id='reader-status-bar';$('paper-tools').after(annotationTools,statusBar);
    // Reserve one row for the whole handwriting session, including an empty
    // buffer between autosaves. Draft changes must never move the PDF beneath a pen.
    const inkBar=node('div',null,'reader-ink-draft');inkBar.id='reader-ink-draft';inkBar.hidden=true;
    const inkLabel=node('span',null,'reader-ink-summary');inkLabel.id='reader-ink-status';inkLabel.setAttribute('role','status');
    const inkReturn=button('reader-ink-return','返回',()=>void returnToInk?.());inkReturn.title='返回待存笔迹';inkReturn.setAttribute('aria-label','返回待存笔迹');
    const inkUndo=button('reader-ink-undo','撤销',()=>reader()?.undoInk());inkUndo.title='撤销一笔';inkUndo.setAttribute('aria-label','撤销一笔');
    const inkDiscard=button('reader-ink-discard','清除',()=>reader()?.clearInk());inkDiscard.setAttribute('aria-label','清除待存笔迹');
    const inkSave=button('reader-ink-save','完成笔画',()=>{if(linkedSession){void finishLinked?.();return;}if(saveInk?.()&&!reader()?.getInkContext?.()){tool='select';applyTool();sync();}});
    inkSave.classList.add('primary');inkBar.append(inkSave,inkReturn,inkUndo,inkDiscard,inkLabel);statusBar.append(inkBar,message);
    function syncInk(){
      const draft=reader()?.getInkDraft?.(),target=draft||linkedSession||reader()?.getInkContext?.()||{paperId:state.active?.id,page:state.page};
      const visible=tool==='ink'||Boolean(draft)||Boolean(linkedSession)||Boolean(reader()?.getInkContext?.());
      inkBar.hidden=!visible;document.body.classList.toggle('handwriting-tools-visible',visible);document.body.classList.toggle('has-ink-draft',Boolean(draft));
      const records=inkRecords.filter(job=>job.paperId===target.paperId&&job.page===target.page&&(job.parentId||null)===(target.parentId||null)),pending=records.filter(job=>job.status!=='saved');
      const failed=pending.some(job=>['stage_failed','uncertain'].includes(job.status));
      let progress=draft?`${draft.paths.length} 笔${draft.parentId?'待自动保存':'未保存'}`:failed?'保存待重试':pending.length?'后台保存中':records.length?'已保存，可继续写':'直接在 PDF 上写画';
      if(inkBusy)progress='正在保存…';else if(inkError&&draft)progress=inkError;
      inkLabel.textContent=`第 ${target.page||state.page||1} 页 · ${target.parentId?'批注手写':'自由手写'} · ${progress}`;
      if(draft&&draft.paperId===state.active?.id)inkTitle=state.active.title||'当前文献';else if(!draft)inkTitle='';
      inkLabel.title=[inkTitle,inkLabel.textContent].filter(Boolean).join(' · ');inkLabel.classList.toggle('error',failed||Boolean(inkError&&draft));
      for(const b of [inkReturn,inkUndo,inkDiscard])b.disabled=inkBusy||!draft;
      inkSave.disabled=linkedSession?linkedBusy:inkBusy;
      inkUndo.disabled=inkBusy||!draft||Boolean(inkError);
      inkDiscard.textContent=inkError?'放弃重试':'清除';
      inkDiscard.title=inkError?'仅移除草稿，已写入 PDF 的笔迹仍保留。':'清除待存笔迹，已保存的笔迹仍保留';
      input.disabled=tool==='ink'&&(inkBusy||Boolean(draft));widthInput.disabled=inkBusy||Boolean(draft);
      inkSave.textContent=inkError&&!linkedSession?'重试保存':linkedSession?'完成手写':'完成笔画';
      if(!draft)inkError='';
    }
    function linkedChanged(session,{ending=false,starting=false,finish}={}){linkedSession=session?{...session}:null;linkedBusy=ending||starting;finishLinked=finish;syncInk();}
    function inkChanged(){inkError='';syncInk();}
    function inkSaving(value,error=''){inkBusy=Boolean(value);inkError=error;inkBar.setAttribute('aria-busy',String(inkBusy));syncInk();}
    let inkQueue=null;
    const queueMenu=node('details',null,'ink-queue-menu');queueMenu.id='ink-queue-menu';queueMenu.hidden=true;
    const queueSummary=node('summary','笔迹');queueSummary.id='ink-queue-summary';queueSummary.setAttribute('aria-live','polite');queueMenu.append(queueSummary);
    const queuePanel=node('div',null,'ink-queue-panel');queuePanel.setAttribute('aria-label','手写保存进度');queueMenu.append(queuePanel);
    bindMenu(queueMenu,queuePanel);
    const ribbonStatus=node('div',null,'reader-ribbon-status');ribbonStatus.setAttribute('role','group');ribbonStatus.setAttribute('aria-label','保存状态');ribbonStatus.append(queueMenu);ribbon.append(ribbonStatus);
    function queueChanged(records){
      inkRecords=records;syncInk();
      const pending=records.filter(job=>job.status!=='saved');queueMenu.hidden=!records.length;queueSummary.textContent=pending.length?`笔迹 · ${pending.length} 待保存`:'笔迹已保存';
      const failed=pending.some(job=>['stage_failed','uncertain'].includes(job.status));
      queueMenu.dataset.state=failed?'error':pending.length?'pending':'saved';queueSummary.classList.toggle('error',failed);
      queuePanel.replaceChildren();
      const shown=pending.length?pending:records.slice(-1);
      for(const job of shown){const row=node('div',null,'ink-queue-item');row.dataset.inkId=job.annotation_id;
        const label=node('p',`第 ${job.page} 页 · ${window.PaperInkQueueClient.label(job.status)}`);label.setAttribute('role','status');row.append(label);
        if(job.error?.message)row.append(node('p',job.error.message,'small error'));
        if(['stage_failed','uncertain'].includes(job.status)){const retry=button('', '重试保存',async()=>{retry.disabled=true;try{await inkQueue?.retry(job.annotation_id);}catch(error){toast(error.message,true);}finally{retry.disabled=false;}});row.append(retry);}
        if(job.status!=='saved'){const exportInk=button('','导出笔迹',()=>{const url=URL.createObjectURL(new Blob([JSON.stringify(job,null,2)],{type:'application/json'})),a=document.createElement('a');a.href=url;a.download=`handwriting-${job.annotation_id}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);});row.append(exportInk);}queuePanel.append(row);
      }
      const refresh=button('','刷新保存状态',()=>void inkQueue?.refresh().catch(error=>toast(error.message,true)));queuePanel.append(refresh);
    }
    const backPosition=button('reader-return-position','返回刚才位置',async()=>{if(await reader()?.returnToReadingPosition()){const value=reader()?.getLayout();selectLayout(value);void patchLayout({readerLayout:value});}});backPosition.hidden=true;readerTools.append(backPosition);
    function focusChanged(info){backPosition.hidden=!info?.canReturn;if(info?.pending)status('正在定位…');else status('',false,{clearIf:'正在定位…'});}
    const beforeUnload=event=>{if(reader()?.getInkDraft?.()||reader()?.isInking?.()||inkQueue?.blocked()){event.preventDefault();event.returnValue='';}};
    window.addEventListener('beforeunload',beforeUnload);
    const header=document.querySelector('.paper-header');header.classList.add('reader-document-summary');
    // The same summary remains available next to editable fields, without taking PDF space.
    $('metadata-form').prepend(header);
    $('back-library').hidden=true;
    document.querySelector('.topbar-actions').append($('queue-toggle'));
    const intro=$('annotations-tab').querySelector('.section-toolbar');if(intro)intro.hidden=true;
    const chatIntro=$('conversation-tab').querySelector('.section-toolbar h3');if(chatIntro)chatIntro.textContent='论文对话';
    $('paper-chat-input').rows=3;
    function status(text,error=false,options={}){if(options.clearIf!==undefined&&message.textContent!==options.clearIf)return;message.textContent=text||hintFor();message.classList.toggle('error',error);}
    function sync(){
      const table=Boolean(workbench()?.isTable()), active=Boolean(state.active&&!state.active.archived&&state.active.resource_kind!=='dataset'), pdf=active&&Boolean(state.active.pdf);
      panels()?.setReadingActive?.(!table&&active&&state.tab!=='graph');
      if((table||state.active?.resource_kind==='dataset')&&focused)leaveFocus();
      const surface=table?'library':context;
      document.body.classList.toggle('library-mode',table);document.body.classList.toggle('has-paper',active);
      library.setAttribute('aria-pressed',String(table));
      citations.hidden=!active||!['library','reader','annotations'].includes(surface);if(citations.hidden)citations.open=false;
      for(const tab of ribbon.querySelectorAll('[data-tab]')){
        const isPanel=tab.dataset.tab==='annotations'||tab.dataset.tab==='conversation';
        const on=isPanel?!table&&state.tab!=='graph'&&panels()?.visible(tab.dataset.tab==='conversation'?'chat':'annotations'):!table&&state.tab===tab.dataset.tab;
        tab.disabled=!active;tab.classList.toggle('active',Boolean(on));tab.setAttribute('aria-pressed',String(Boolean(on)));
      }
      $('metadata-open').disabled=!active;$('metadata-open').setAttribute('aria-pressed',String(Boolean(panels()?.visible('metadata'))));
      appearance.hidden=!pdf;if(!pdf)appearance.open=false;
      fullscreen.disabled=!pdf;fullscreen.textContent=focused?'退出全屏 ⤡':'全屏阅读 ⤢';fullscreen.setAttribute('aria-pressed',String(focused));
      readerTools.hidden=table||!pdf||!['reader','annotations'].includes(surface);
      annotationTools.hidden=table||!pdf||surface!=='annotations';
      document.body.classList.toggle('annotation-tools-visible',!annotationTools.hidden);
      if(annotationTools.hidden){penSettings.open=false;presetsMenu.open=false;}
      $('toolbar-actions').hidden=false;libraryTools.hidden=surface!=='library'&&active;
      $('import-open').disabled=false;$('build-bibliography').disabled=false;
      $('metadata-enrich').disabled=!active;
      for(const b of annotationTools.querySelectorAll('[data-reader-tool]'))b.setAttribute('aria-pressed',String(b.dataset.readerTool===tool));
      for(const [value,b] of Object.entries(modeButtons))b.setAttribute('aria-pressed',String(mode===value));
      modeGroup.dataset.mode=mode;
      modeGroup.hidden=['ink','square'].includes(tool);widthLabel.hidden=!['ink','square'].includes(tool);
      input.value=['ink','square'].includes(tool)?inkColor:color;widthInput.value=String(inkWidth);syncInk();
      message.hidden=!active||table;
      if(surface==='graph')status('选择节点查看联系与来源；有页码的依据可返回 PDF。');
      else status(hintFor());
      placeMenus();
      contextChanged?.();
    }
    function setContext(value){context=value==='conversation'?'reader':value;sync();}
    function leaveFocus(){
      focused=false;document.body.classList.remove('reader-focused');
      if(document.fullscreenElement)void document.exitFullscreen().catch(()=>{});
    }
    async function toggleFullscreen(){
      if(focused){if(document.fullscreenElement)await document.exitFullscreen().catch(()=>{});focused=false;document.body.classList.remove('reader-focused');sync();reader()?.resize();return;}
      await navigate('reader');focused=true;document.body.classList.add('reader-focused');sync();
      try{if(document.documentElement.requestFullscreen)await document.documentElement.requestFullscreen();else status('已展开阅读区域。此窗口未提供系统全屏。');}
      catch{status('已展开阅读区域。此窗口未允许系统全屏，可用同一按钮退出。');}
      reader()?.resize();
    }
    const fullscreenChange=()=>{if(!document.fullscreenElement&&focused){focused=false;document.body.classList.remove('reader-focused');sync();reader()?.resize();}};
    const keydown=e=>{if(e.key==='Escape'&&focused&&!document.querySelector('dialog[open]:not(#metadata-dialog)')){void toggleFullscreen();}};
    const closeMenus=e=>{for(const {disclosure} of menus)if(disclosure.open&&!disclosure.contains(e.target))disclosure.open=false;};
    const menuKey=e=>{if(e.key!=='Escape')return;const active=menus.find(({disclosure})=>disclosure.open);if(!active)return;active.disclosure.open=false;active.disclosure.querySelector('summary').focus();e.stopImmediatePropagation();};
    document.addEventListener('click',closeMenus);document.addEventListener('keydown',menuKey,true);
    document.addEventListener('scroll',placeMenus,true);window.addEventListener('resize',placeMenus);
    const menuObserver=typeof ResizeObserver==='function'?new ResizeObserver(placeMenus):null;menuObserver?.observe(top);
    document.addEventListener('fullscreenchange',fullscreenChange);document.addEventListener('keydown',keydown);
    // Prevent a homepage link from discarding a question/metadata draft.
    document.querySelector('.brand').addEventListener('click',e=>{e.preventDefault();workbench()?.setTable(true);});
    sync();
    return {sync,setContext,status,leaveFocus,inkChanged,inkSaving,inputChanged,queueChanged,focusChanged,zoomChanged,linkedChanged,setInkQueue(value){inkQueue=value;},setTool(value){if(!Object.hasOwn(hints,value))return;tool=value;context='annotations';applyTool();sync();},tool:()=>({type:tool,color:['ink','square'].includes(tool)?inkColor:color,width:inkWidth,mode,markup}),mode:()=>mode,markup:()=>markup,isFocused:()=>focused,
      dispose(){if(zoomSaveTimer!==null)window.clearTimeout(zoomSaveTimer);for(const {disclosure,update} of organizerDisclosures)disclosure.removeEventListener('toggle',update);for(const {disclosure,toggle} of menus)disclosure.removeEventListener('toggle',toggle);menuObserver?.disconnect();window.removeEventListener('beforeunload',beforeUnload);window.removeEventListener('resize',placeMenus);document.removeEventListener('scroll',placeMenus,true);document.removeEventListener('click',closeMenus);document.removeEventListener('keydown',menuKey,true);document.removeEventListener('fullscreenchange',fullscreenChange);document.removeEventListener('keydown',keydown);}};
  }
  return {create};
})();
