'use strict';

/** Contextual office-style ribbon. It moves existing controls, keeping their handlers. */
window.PaperReadingShell = (() => {
  const hints = {
    select: '拖选文字，可添加批注或放入论文对话。',
    highlight: '拖选要高亮的文字，再写下想法并保存。',
    underline: '拖选文字，保存为 PDF 下划线批注。',
    strikeout: '拖选文字，保存为 PDF 删除线批注。',
    note: '点击页面中的位置，添加一条便笺。',
  };
  const MODES = { auto: '自动着色', ask: '勾选后提问' };
  const MODE_HINTS = {
    auto: { select: '拖选文字即按当前颜色直接着色，之后可在批注栏提问。', highlight: '拖选文字即高亮保存，不再弹出对话框。', underline: '拖选文字即保存下划线，不再弹出对话框。', strikeout: '拖选文字即保存删除线，不再弹出对话框。' },
    ask: { select: '拖选文字，可添加批注或放入论文对话。' },
  };
  function create({state, workbench, panels, reader, navigate, toast, contextChanged, persistence}) {
    const $ = id => document.getElementById(id);
    const node = (tag, text, className) => { const n=document.createElement(tag);if(text)n.textContent=text;if(className)n.className=className;return n; };
    const button = (id, text, action) => {const n=node('button',text,'button subtle');n.type='button';n.id=id;n.addEventListener('click',action);return n;};
    const top=document.querySelector('.topbar'), workspace=document.querySelector('.workspace');
    let context='reader', tool='select', color='#ffdb66', mode='ask', markup='highlight', focused=false, saveLayoutTimer=null;
    const ribbon=node('nav',null,'reader-ribbon');ribbon.setAttribute('aria-label','文献工作区');
    const library=button('workspace-library','库',()=>{leaveFocus();$('catalog-expand').click();});
    library.title='展开或收起文献表格';ribbon.append(library);
    const tabs=document.querySelector('.tabs');for(const tab of [...tabs.children])ribbon.append(tab);tabs.remove();
    const citations=node('details',null,'citation-tools');citations.id='citation-tools';
    citations.append(node('summary','引用与导出'));
    citations.append($('toolbar-actions'));$('paper-tools').append(citations);
    citations.addEventListener('toggle',()=>{if(citations.open)status('对当前论文复制引用，或导出文件与已保存的批注。');});
    // Metadata and chat stay within reading; graph is the only other paper surface.
    $('metadata-open').textContent='资料';$('metadata-open').title='在侧栏快速编辑文献资料';
    ribbon.append($('metadata-open'));
    const fullscreen=button('reader-fullscreen','全屏阅读 ⤢',()=>void toggleFullscreen());
    fullscreen.title='全屏阅读；Esc 返回';ribbon.append(fullscreen);
    top.insertBefore(ribbon,$('paper-tools'));
    const readerTools=$('toolbar-reader'), annotationTools=node('div',null,'annotation-tool-group'), libraryTools=node('div',null,'library-tool-group');
    annotationTools.id='toolbar-annotation';libraryTools.id='toolbar-library';
    for(const [type,label] of [['select','选择'],['highlight','高亮'],['underline','下划线'],['strikeout','删除线'],['note','便笺']]){
      const b=button(`reader-tool-${type}`,label,()=>{tool=type;context='annotations';if(['highlight','underline','strikeout'].includes(type)){markup=type;saveLayoutLater();}reader()?.setTool(tool,color);sync();status(hintFor());});b.dataset.readerTool=type;annotationTools.append(b);
    }
    const colorLabel=node('label','颜色','reader-color');const input=node('input');input.type='color';input.id='reader-color';input.value=color;input.setAttribute('aria-label','批注颜色');
    // Layout preferences share one write queue: overlapping read-modify-write
    // patches race the revision and would surface as a save conflict banner.
    let layoutQueue=Promise.resolve();
    const patchLayout=value=>{layoutQueue=layoutQueue.then(()=>persistence?persistence.patch('reader:layout',value):null).catch(()=>{});return layoutQueue;};
    const saveLayout=()=>patchLayout({mode,color,markup});
    const saveLayoutLater=()=>{if(saveLayoutTimer!==null)window.clearTimeout(saveLayoutTimer);saveLayoutTimer=window.setTimeout(()=>{saveLayoutTimer=null;saveLayout();},150);};
    const hintFor=()=>(MODE_HINTS[mode]||{})[tool]||hints[tool]||'';
    input.addEventListener('input',()=>{color=input.value;reader()?.setTool(tool,color);saveLayout();sync();});colorLabel.append(input);
    // Two reading habits: mark while reading (自动着色) or select then ask
    // (勾选后提问, the default). The choice, colour and markup type persist.
    const modeGroup=node('div',null,'reader-mode');modeGroup.id='reader-mode-group';modeGroup.setAttribute('role','group');modeGroup.setAttribute('aria-label','选文后的行为');
    modeGroup.append(node('span','选文后','reader-mode-label'));
    const modeButtons={};
    for(const [value,label] of Object.entries(MODES)){
      const b=button(`reader-mode-${value}`,label,()=>{mode=value;if(value==='auto'&&tool==='select')reader()?.setTool(tool,color);saveLayout();sync();status(hintFor());});
      b.setAttribute('aria-pressed',String(mode===value));modeButtons[value]=b;modeGroup.append(b);
    }
    annotationTools.append(modeGroup,colorLabel);
    const sidebar=button('reader-annotations','批注栏',()=>{panels()?.toggle('annotations');sync();});readerTools.append(sidebar);
    // Fit-width default with free zoom: steppers, an explicit percentage and reset.
    let zoom=1;
    const zoomGroup=node('span',null,'reader-zoom');
    const zoomOut=button('reader-zoom-out','−',()=>setZoom(zoom/1.2));zoomOut.title='缩小';
    const percent=node('input');percent.id='reader-zoom-percent';percent.type='number';percent.min='25';percent.max='400';percent.step='5';percent.value='100';percent.setAttribute('aria-label','PDF 缩放百分比');percent.title='缩放百分比（25–400）';
    const zoomIn=button('reader-zoom-in','＋',()=>setZoom(zoom*1.2));zoomIn.title='放大';
    const zoomFit=button('reader-zoom-fit','全宽',()=>setZoom(1));zoomFit.title='恢复全宽自适应';
    function setZoom(value){const applied=reader()?.setZoom(value);if(applied===undefined)return;zoom=applied;percent.value=String(Math.round(zoom*100));if(persistence)void patchLayout({zoom});}
    const commitZoom=()=>{const value=Number(percent.value);if(Number.isFinite(value))setZoom(value/100);percent.value=String(Math.round(zoom*100));};
    percent.addEventListener('change',commitZoom);
    percent.addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();commitZoom();}});
    zoomGroup.append(zoomOut,percent,zoomIn,zoomFit);readerTools.append(zoomGroup);
    if(persistence)void persistence.get('reader:layout').then(value=>{
      const saved=Number(value?.zoom);if(Number.isFinite(saved)&&saved!==1)setZoom(saved);
      if(typeof value?.color==='string'&&/^#[0-9a-f]{6}$/i.test(value.color)){color=value.color;input.value=color;reader()?.setTool(tool,color);}
      if(typeof value?.markup==='string'&&['highlight','underline','strikeout'].includes(value.markup))markup=value.markup;
      if(typeof value?.mode==='string'&&Object.hasOwn(MODES,value.mode))mode=value.mode;
      sync();
    }).catch(()=>{});
    // One global import entry. Link intake belongs inside that same import surface.
    $('import-open').textContent='＋ 导入';libraryTools.append($('import-open'),$('export-library'),$('build-bibliography'),$('metadata-enrich'),$('catalog-archive'));
    $('quick-import-form').hidden=true;
    const quick=$('quick-import-source');quick.disabled=true;
    $('paper-tools').append(annotationTools,libraryTools);
    // An unattached record has a direct recovery action on its empty reading surface.
    $('no-pdf').append($('attach-open'));
    $('previous-page').hidden=true;$('next-page').hidden=true;
    $('page-number').title='输入页码跳转，也可直接滚动阅读';
    const note=$('page-note');note.textContent='页便笺';annotationTools.append(note);
    const message=$('page-message');message.className='ribbon-status';message.setAttribute('role','status');message.setAttribute('aria-live','polite');
    $('paper-tools').after(message);
    const header=document.querySelector('.paper-header');header.classList.add('reader-document-summary');
    // The same summary remains available next to editable fields, without taking PDF space.
    $('metadata-form').prepend(header);
    $('back-library').hidden=true;
    document.querySelector('.topbar-actions').append($('queue-toggle'));
    const intro=$('annotations-tab').querySelector('.section-toolbar');if(intro)intro.hidden=true;
    const chatIntro=$('conversation-tab').querySelector('.section-toolbar h3');if(chatIntro)chatIntro.textContent='论文对话';
    $('paper-chat-input').rows=3;
    function status(text, error=false){message.textContent=text||hints[tool];message.classList.toggle('error',error);}
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
      fullscreen.disabled=!pdf;fullscreen.textContent=focused?'退出全屏 ⤡':'全屏阅读 ⤢';fullscreen.setAttribute('aria-pressed',String(focused));
      readerTools.hidden=table||!pdf||!['reader','annotations'].includes(surface);
      annotationTools.hidden=table||!pdf||surface!=='annotations';
      $('toolbar-actions').hidden=false;libraryTools.hidden=surface!=='library'&&active;
      $('import-open').disabled=false;$('export-library').disabled=false;$('build-bibliography').disabled=false;
      $('metadata-enrich').disabled=!active;$('catalog-archive').disabled=!active;
      for(const b of annotationTools.querySelectorAll('[data-reader-tool]'))b.setAttribute('aria-pressed',String(b.dataset.readerTool===tool));
      for(const [value,b] of Object.entries(modeButtons))b.setAttribute('aria-pressed',String(mode===value));
      modeGroup.dataset.mode=mode;
      sidebar.setAttribute('aria-pressed',String(Boolean(panels()?.visible('annotations'))));
      message.hidden=!active||table;
      if(surface==='graph')status('选择节点查看联系与来源；有页码的依据可返回 PDF。');
      else status(hintFor());
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
    const closeCitations=e=>{if(citations.open&&!citations.contains(e.target))citations.open=false;};
    const citationKey=e=>{if(e.key==='Escape'&&citations.open){citations.open=false;citations.querySelector('summary').focus();e.stopImmediatePropagation();}};
    document.addEventListener('click',closeCitations);document.addEventListener('keydown',citationKey,true);
    document.addEventListener('fullscreenchange',fullscreenChange);document.addEventListener('keydown',keydown);
    // Prevent a homepage link from discarding a question/metadata draft.
    document.querySelector('.brand').addEventListener('click',e=>{e.preventDefault();workbench()?.setTable(true);});
    sync();
    return {sync,setContext,status,leaveFocus,tool:()=>({type:tool,color,mode,markup}),mode:()=>mode,markup:()=>markup,isFocused:()=>focused,
      dispose(){document.removeEventListener('fullscreenchange',fullscreenChange);document.removeEventListener('keydown',keydown);document.removeEventListener('click',closeCitations);document.removeEventListener('keydown',citationKey,true);}};
  }
  return {create};
})();
