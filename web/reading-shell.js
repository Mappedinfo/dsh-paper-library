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
  function create({state, workbench, panels, reader, navigate, toast}) {
    const $ = id => document.getElementById(id);
    const node = (tag, text, className) => { const n=document.createElement(tag);if(text)n.textContent=text;if(className)n.className=className;return n; };
    const button = (id, text, action) => {const n=node('button',text,'button subtle');n.type='button';n.id=id;n.addEventListener('click',action);return n;};
    const top=document.querySelector('.topbar'), workspace=document.querySelector('.workspace');
    let context='reader', tool='select', color='#ffdb66', focused=false;
    const ribbon=node('nav',null,'reader-ribbon');ribbon.setAttribute('aria-label','文献工作区');
    const library=button('workspace-library','文献库',()=>{leaveFocus();$('catalog-expand').click();});
    library.title='展开或收起文献表格';ribbon.append(library);
    const tabs=document.querySelector('.tabs');for(const tab of [...tabs.children])ribbon.append(tab);tabs.remove();
    const citations=button('ribbon-citations','引用与导出',()=>{context='citations';sync();});ribbon.append(citations);
    // Metadata and chat stay within reading; graph is the only other paper surface.
    $('metadata-open').textContent='资料';$('metadata-open').title='在侧栏快速编辑文献资料';
    ribbon.append($('metadata-open'));
    const fullscreen=button('reader-fullscreen','全屏阅读 ⤢',()=>void toggleFullscreen());
    fullscreen.title='全屏阅读；Esc 返回';ribbon.append(fullscreen);
    top.insertBefore(ribbon,$('paper-tools'));
    const readerTools=$('toolbar-reader'), annotationTools=node('div',null,'annotation-tool-group'), libraryTools=node('div',null,'library-tool-group');
    annotationTools.id='toolbar-annotation';libraryTools.id='toolbar-library';
    for(const [type,label] of [['select','选择'],['highlight','高亮'],['underline','下划线'],['strikeout','删除线'],['note','便笺']]){
      const b=button(`reader-tool-${type}`,label,()=>{tool=type;context='annotations';reader()?.setTool(tool,color);sync();status(hints[tool]);});b.dataset.readerTool=type;annotationTools.append(b);
    }
    const colorLabel=node('label','颜色','reader-color');const input=node('input');input.type='color';input.id='reader-color';input.value=color;input.setAttribute('aria-label','批注颜色');
    input.addEventListener('input',()=>{color=input.value;reader()?.setTool(tool,color);});colorLabel.append(input);annotationTools.append(colorLabel);
    const sidebar=button('reader-annotations','批注栏',()=>{panels()?.toggle('annotations');sync();});readerTools.append(sidebar);
    // One global import entry. Link intake belongs inside that same import surface.
    $('import-open').textContent='＋ 导入';libraryTools.append($('import-open'),$('export-library'),$('metadata-enrich'),$('catalog-archive'));
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
      const table=Boolean(workbench()?.isTable()), active=Boolean(state.active&&!state.active.archived), pdf=active&&Boolean(state.active.pdf);
      panels()?.setReadingActive?.(!table&&active&&state.tab!=='graph');
      if(table&&focused)leaveFocus();
      const mode=table?'library':context;
      document.body.classList.toggle('library-mode',table);document.body.classList.toggle('has-paper',active);
      library.setAttribute('aria-pressed',String(table));
      citations.setAttribute('aria-pressed',String(!table&&context==='citations'));citations.disabled=!active;
      for(const tab of ribbon.querySelectorAll('[data-tab]')){
        const isPanel=tab.dataset.tab==='annotations'||tab.dataset.tab==='conversation';
        const on=isPanel?!table&&state.tab!=='graph'&&panels()?.visible(tab.dataset.tab==='conversation'?'chat':'annotations'):!table&&state.tab===tab.dataset.tab;
        tab.disabled=!active;tab.classList.toggle('active',Boolean(on));tab.setAttribute('aria-pressed',String(Boolean(on)));
      }
      $('metadata-open').disabled=!active;$('metadata-open').setAttribute('aria-pressed',String(Boolean(panels()?.visible('metadata'))));
      fullscreen.disabled=!pdf;fullscreen.textContent=focused?'退出全屏 ⤡':'全屏阅读 ⤢';fullscreen.setAttribute('aria-pressed',String(focused));
      readerTools.hidden=table||!pdf||!['reader','annotations'].includes(mode);
      annotationTools.hidden=table||!pdf||mode!=='annotations';
      $('toolbar-actions').hidden=mode!=='citations';libraryTools.hidden=mode!=='library'&&active;
      $('import-open').disabled=false;$('export-library').disabled=false;
      $('metadata-enrich').disabled=!active;$('catalog-archive').disabled=!active;
      for(const b of annotationTools.querySelectorAll('[data-reader-tool]'))b.setAttribute('aria-pressed',String(b.dataset.readerTool===tool));
      sidebar.setAttribute('aria-pressed',String(Boolean(panels()?.visible('annotations'))));
      message.hidden=!active||table;
      if(mode==='graph')status('选择节点查看联系与来源；有页码的依据可返回 PDF。');
      else if(mode==='citations')status('对当前论文复制引用，或导出文件与已保存的批注。');
      else status(hints[tool]);
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
    document.addEventListener('fullscreenchange',fullscreenChange);document.addEventListener('keydown',keydown);
    // Prevent a homepage link from discarding a question/metadata draft.
    document.querySelector('.brand').addEventListener('click',e=>{e.preventDefault();workbench()?.setTable(true);});
    sync();
    return {sync,setContext,status,leaveFocus,tool:()=>({type:tool,color}),isFocused:()=>focused,
      dispose(){document.removeEventListener('fullscreenchange',fullscreenChange);document.removeEventListener('keydown',keydown);}};
  }
  return {create};
})();
