'use strict';
// Reading overlays move the existing controls; their listeners, drafts and
// native-conversation state stay owned by the original reader components.
window.PaperReadingPanels = (() => {
  const names = new Set(['annotations','metadata','chat']);
  function create({root,annotationsRoot,conversationRoot,metadataRoot,onChatVisibility,onPanelChange,toast}) {
    if (!root || !annotationsRoot || !conversationRoot || !metadataRoot) throw new Error('Reading panels require the workspace and three existing content roots');
    let sidebar = null, side = 'left', chatOpen = false, collapsed = false, paper = null, disposed = false, lastChatVisible = false;
    const listeners = [], originals = [annotationsRoot,conversationRoot,metadataRoot].map(element=>({element,parent:element.parentNode,next:element.nextSibling,hidden:element.hidden,open:element.open}));
    const make = (tag,className,text) => {const element=document.createElement(tag);element.className=className;if(text!==undefined)element.textContent=text;return element;};
    const listen = (element,event,fn) => {element.addEventListener(event,fn);listeners.push(()=>element.removeEventListener(event,fn));};
    const button = (label,fn,className='reading-panel-button') => {const element=make('button',className,label);element.type='button';listen(element,'click',fn);return element;};
    const aside=make('aside','reading-side-panel');aside.id='reading-side-panel';aside.setAttribute('aria-label','阅读侧栏');
    const asideHeader=make('header','reading-panel-header'), asideTitle=make('strong','reading-panel-title','批注');
    const move=button('移至右侧',()=>setSide(side==='left'?'right':'left'));move.id='reading-panel-side';
    const asideClose=button('×',()=>close(sidebar));asideClose.setAttribute('aria-label','收起阅读侧栏');
    const asideBody=make('div','reading-panel-body');asideHeader.append(asideTitle,move,asideClose);asideBody.append(annotationsRoot,metadataRoot);aside.append(asideHeader,asideBody);
    const chat=make('aside','reading-chat-panel');chat.id='reading-chat-panel';chat.setAttribute('aria-label','浮动论文对话');
    const chatHeader=make('header','reading-panel-header'),chatTitle=make('strong','reading-panel-title','论文对话');
    const collapse=button('收起',()=>{collapsed=!collapsed;render();});collapse.id='reading-chat-collapse';collapse.setAttribute('aria-controls','reading-chat-content');
    const chatClose=button('×',()=>close('chat'));chatClose.setAttribute('aria-label','关闭浮动对话');
    const chatBody=make('div','reading-chat-content');chatBody.id='reading-chat-content';chatBody.append(conversationRoot);chatHeader.append(chatTitle,collapse,chatClose);chat.append(chatHeader,chatBody);
    root.classList.add('paper-reading-workspace');root.append(aside,chat);
    // The catalogue can hide the reader while editing one of its rows. Keep the
    // same nonmodal form reachable there without creating a second editor.
    const globalHost=make('div','paper-reading-workspace reading-panels-global-host');globalHost.hidden=true;document.body.append(globalHost);
    annotationsRoot.classList.add('reading-annotations-content');metadataRoot.classList.add('reading-metadata-content');conversationRoot.classList.add('reading-conversation-content');
    try {const saved=window.localStorage?.getItem('paper-library:reading-panel-side:v1');if(saved==='left'||saved==='right')side=saved;} catch {}
    function notify() {
      const visible=chatOpen&&!collapsed;
      if(visible!==lastChatVisible){lastChatVisible=visible;onChatVisibility?.(visible);}
      onPanelChange?.({side,sidebar,chat:visible,chatOpen,chatCollapsed:chatOpen&&collapsed});
    }
    function render(emit=true) {
      if(disposed)return;
      root.dataset.readingSide=side;root.classList.toggle('has-reading-sidebar',Boolean(sidebar));
      placeSidebar();
      aside.hidden=!sidebar;asideTitle.textContent=sidebar==='metadata'?'文献资料':'批注';
      move.textContent=side==='left'?'移至右侧':'移至左侧';
      annotationsRoot.hidden=sidebar!=='annotations';metadataRoot.hidden=sidebar!=='metadata';
      if(metadataRoot.tagName==='DIALOG') {
        if(sidebar==='metadata'&&!metadataRoot.open)metadataRoot.show();
        else if(sidebar!=='metadata'&&metadataRoot.open)metadataRoot.close();
      }
      chat.hidden=!chatOpen;chatBody.hidden=collapsed;conversationRoot.hidden=!chatOpen||collapsed;
      chat.classList.toggle('is-collapsed',collapsed);collapse.textContent=collapsed?'展开':'收起';collapse.setAttribute('aria-expanded',String(!collapsed));
      chatTitle.textContent=paper?.title?`论文对话 · ${paper.title}`:'论文对话';chatTitle.title=paper?.title||'';
      if(emit)notify();
    }
    function placeSidebar() {
      const global=sidebar==='metadata'&&typeof root.getClientRects==='function'&&root.getClientRects().length===0;
      globalHost.dataset.readingSide=side;globalHost.hidden=!global;
      const host=global?globalHost:root;if(aside.parentNode!==host)host.append(aside);
    }
    function known(name) {if(!names.has(name))throw new Error('Unknown reading panel');}
    function show(name) {
      known(name);if(disposed)return false;
      if(name!=='metadata'&&(!paper||paper.archived)){toast?.('请先打开一篇可阅读的文献。',true);return false;}
      if(name==='chat'){chatOpen=true;collapsed=false;}else sidebar=name;
      render();return true;
    }
    function close(name) {
      if(name===null||name===undefined||disposed)return;
      known(name);if(name==='chat')chatOpen=false;else if(sidebar===name)sidebar=null;else return;
      render();
    }
    function visible(name) {known(name);return !disposed&&(name==='chat'?chatOpen&&!collapsed:sidebar===name);}
    function toggle(name) {return visible(name)?close(name):show(name);}
    function setSide(value) {
      if(!['left','right'].includes(value))throw new Error('Reading sidebar side must be left or right');
      if(disposed)return;side=value;try{window.localStorage?.setItem('paper-library:reading-panel-side:v1',side);}catch{}render();
    }
    function paperChanged(value) {
      paper=value&&typeof value.id==='string'?{id:value.id,title:String(value.title||'').slice(0,500),archived:Boolean(value.archived)}:null;
      if(!paper||paper.archived){sidebar=null;chatOpen=false;}
      render();
    }
    const resize = () => {if(disposed)return;root.classList.toggle('reading-panels-roomy',root.clientWidth>=880);placeSidebar();};
    const observer=typeof window.ResizeObserver==='function'?new window.ResizeObserver(resize):null;
    observer?.observe(root);listen(window,'resize',resize);resize();
    listen(metadataRoot,'close',()=>{if(sidebar==='metadata')close('metadata');});
    for(const panel of [aside,chat])listen(panel,'keydown',event=>{if(event.key==='Escape'&&!event.defaultPrevented){event.preventDefault();close(panel===chat?'chat':sidebar);}});
    render(false);
    return {toggle,show,close,setSide,paperChanged,visible,dispose(){
      if(disposed)return;disposed=true;observer?.disconnect();for(const off of listeners)off();
      if(lastChatVisible)onChatVisibility?.(false);
      for(const {element,parent,next,hidden,open} of originals){
        if(element.tagName==='DIALOG'&&element.open&&!open)element.close();
        if(parent){if(next?.parentNode===parent)parent.insertBefore(element,next);else parent.append(element);}
        element.hidden=hidden;
      }
      annotationsRoot.classList.remove('reading-annotations-content');metadataRoot.classList.remove('reading-metadata-content');conversationRoot.classList.remove('reading-conversation-content');
      aside.remove();chat.remove();globalHost.remove();root.classList.remove('paper-reading-workspace','has-reading-sidebar','reading-panels-roomy');delete root.dataset.readingSide;
    }};
  }
  return {create};
})();
