'use strict';
window.PaperOutline = (() => {
  function create({api,panels,getPaper,navigate,getPage=()=>1}) {
    const root=document.createElement('section');root.id='paper-outline';root.className='paper-outline';
    const status=document.createElement('p');status.className='small';status.setAttribute('role','status');
    const scan=document.createElement('button');scan.type='button';scan.className='button subtle';
    const modes=document.createElement('div');modes.className='outline-modes';modes.setAttribute('role','group');modes.setAttribute('aria-label','PDF 导航视图');
    const outlineButton=document.createElement('button'),thumbButton=document.createElement('button');
    outlineButton.type=thumbButton.type='button';outlineButton.textContent='大纲';thumbButton.textContent='页面缩略图';
    outlineButton.className=thumbButton.className='button subtle';
    window.PaperIcons?.decorate(outlineButton,'book-open');
    window.PaperIcons?.decorate(thumbButton,'layout-dashboard');
    modes.append(outlineButton,thumbButton);
    const list=document.createElement('nav');list.setAttribute('aria-label','论文大纲');
    const tree=document.createElement('ul');tree.className='outline-tree';list.append(tree);
    const thumbNav=document.createElement('div'),prev=document.createElement('button'),nextThumb=document.createElement('button'),thumbStatus=document.createElement('span');prev.type=nextThumb.type='button';prev.textContent='上一组';nextThumb.textContent='下一组';thumbNav.append(prev,thumbStatus,nextThumb);thumbNav.hidden=true;const thumbs=document.createElement('div');thumbs.className='outline-thumbnails';thumbs.hidden=true;root.append(modes,status,scan,list,thumbNav,thumbs);
    let mode='outline',currentPage=getPage(),observer=null,thumbStart=1,thumbRunning=0,thumbQueue=[],thumbGeneration=0,currentPump=null;
    function setMode(value){mode=value;list.hidden=value!=='outline';thumbs.hidden=value!=='thumbnails';thumbNav.hidden=value!=='thumbnails';outlineButton.setAttribute('aria-pressed',String(value==='outline'));thumbButton.setAttribute('aria-pressed',String(value==='thumbnails'));render();if(value==='thumbnails')buildThumbnails();}
    outlineButton.addEventListener('click',()=>setMode('outline'));thumbButton.addEventListener('click',()=>setMode('thumbnails'));
    let activeEntry=null;
    function highlight(){
      let current=null;
      for(const entry of entries){
        if(!Number.isInteger(entry.item.page)||entry.item.page>currentPage)continue;
        if(!current||entry.item.page>current.item.page||
          (entry.item.page===current.item.page&&entry.depth<current.depth))current=entry;
      }
      for(let branch=current?.parent;branch;branch=branch.parent)if(branch.children.hidden)current=branch;
      if(current===activeEntry)return;
      activeEntry?.link.removeAttribute('aria-current');
      current?.link.setAttribute('aria-current','location');
      activeEntry=current;
    }
    function buildThumbnails(){if(thumbs.childElementCount||!total)return;const id=paperId,ticket=epoch,generation=++thumbGeneration;thumbQueue=[];prev.disabled=thumbStart<=1;nextThumb.disabled=thumbStart+50>total;thumbStatus.textContent=` ${thumbStart}–${Math.min(total,thumbStart+49)} / ${total} 页 `;
      function pump(){while(thumbRunning<2&&thumbQueue.length){const box=thumbQueue.shift();thumbRunning++;void api('paper_visual_read',{id,page:Number(box.dataset.page),max_edge:512}).then(result=>{if(ticket!==epoch||generation!==thumbGeneration||paperId!==id||!box.isConnected)return;const image=document.createElement('img');image.alt=`第 ${box.dataset.page} 页缩略图`;image.src=`data:image/png;base64,${result.image}`;box.prepend(image);}).catch(()=>{box.title='缩略图加载失败，重新打开论文可重试';}).finally(()=>{thumbRunning--;currentPump?.();});}}
      currentPump=pump;
      observer=typeof IntersectionObserver==='function'?new IntersectionObserver(entries=>{for(const entry of entries)if(entry.isIntersecting){observer.unobserve(entry.target);thumbQueue.push(entry.target);pump();}},{root:root,rootMargin:'200px'}):null;
      for(let page=thumbStart;page<=Math.min(total,thumbStart+49);page++){const box=document.createElement('button');box.type='button';box.dataset.page=String(page);box.textContent=`第 ${page} 页`;box.addEventListener('click',()=>{if(getPaper()?.id===id)void navigate({paperId:id,page,rects:[]});});thumbs.append(box);if(observer)observer.observe(box);else if(page<thumbStart+10){thumbQueue.push(box);pump();}}
    }
    let paperId=null,source='',next=1,total=0,epoch=0,loading=false,scanning=false,runner=null,disposed=false;
    const entries=[], ancestors=[], bookmarks=new Map();
    function clearOutline(){entries.length=0;ancestors.length=0;activeEntry=null;bookmarks.clear();tree.replaceChildren();}
    function render(){
      scan.hidden=mode!=='outline'||source!=='inferred';scan.disabled=loading||next>total||entries.length>=1000||(!scanning&&runner===epoch);
      scan.textContent=scanning?'暂停识别':next>total?'识别完成':next>1?'继续识别章节':'识别章节标题';
      status.hidden=mode!=='outline';
      status.textContent=source==='bookmarks'?`PDF 书签 · ${entries.length} 项`:source==='inferred'?`无可用书签 · 标题识别 ${next-1}/${total} 页 · 结果请对照原文`:loading?'正在读取大纲…':'请打开 PDF 查看大纲。';
    }
    function childList(parent){
      if(parent.children)return parent.children;
      const children=document.createElement('ul');children.className='outline-branch';
      children.id=`outline-branch-${parent.index}`;
      const toggle=document.createElement('button');toggle.type='button';toggle.className='outline-disclosure';
      toggle.setAttribute('aria-controls',children.id);
      window.PaperIcons?.decorate(toggle,'chevron-down');
      function syncToggle(){
        const label=`${children.hidden?'展开':'折叠'} ${parent.item.title}`;
        toggle.setAttribute('aria-expanded',String(!children.hidden));
        toggle.setAttribute('aria-label',label);toggle.title=label;
      }
      toggle.addEventListener('click',()=>{children.hidden=!children.hidden;syncToggle();highlight();});
      syncToggle();
      parent.row.prepend(toggle);parent.node.append(children);
      parent.children=children;
      return children;
    }
    function append(values){
      for(const item of values){
        if(entries.length>=1000)break;
        while(ancestors.length&&ancestors.at(-1).item.level>=item.level)ancestors.pop();
        const parent=item.id?bookmarks.get(item.parent_id):ancestors.at(-1);
        const jumpable=Number.isInteger(item.page);
        const node=document.createElement('li'),row=document.createElement('div'),link=document.createElement(jumpable?'button':'span');
        row.className='outline-row';if(jumpable)link.type='button';link.className='outline-entry';
        const title=document.createElement('span'),page=document.createElement('small');
        title.textContent=item.title;page.textContent=jumpable?String(item.page):'';
        link.append(title,page);link.title=jumpable?`第 ${item.page} 页 · ${item.title}`:item.title;
        const id=paperId;
        if(jumpable)link.addEventListener('click',()=>{if(getPaper()?.id===id)void navigate({paperId:id,page:item.page,rects:item.rects||[]});});
        row.append(link);node.append(row);(parent?childList(parent):tree).append(node);
        const entry={item,parent,node,row,link,index:entries.length,depth:parent?parent.depth+1:0};
        entries.push(entry);
        if(item.id)bookmarks.set(item.id,entry);else ancestors.push(entry);
      }
      currentPage=getPage();highlight();
    }
    function changeThumbs(delta){observer?.disconnect();thumbStart=Math.max(1,Math.min(total,thumbStart+delta));thumbs.replaceChildren();buildThumbnails();}
    prev.addEventListener('click',()=>changeThumbs(-50));nextThumb.addEventListener('click',()=>changeThumbs(50));
    async function open(){
      const paper=getPaper();if(disposed||!paper?.pdf)return;
      if(paper.id===paperId&&(source||loading))return;
      const ticket=++epoch;paperId=paper.id;clearOutline();source='';scanning=false;loading=true;render();
      try{const value=await api('paper_outline',{id:paperId});if(ticket!==epoch||disposed||getPaper()?.id!==paperId)return;
        source=value.items.length?'bookmarks':'inferred';total=value.page_count;next=1;append(value.items);loading=false;render();if(mode==='thumbnails')buildThumbnails();
        if(value.truncated)status.textContent+=' · 书签过多，仅显示前 1000 个节点中的有效目录';
      }catch(error){if(ticket===epoch){loading=false;render();status.textContent=`大纲未读取：${error.message}；重新打开此标签可重试。`;}}
    }
    async function run(){
      if(scanning){scanning=false;render();return;}if(runner===epoch)return;scanning=true;const ticket=epoch;runner=ticket;render();
      while(scanning&&!disposed&&ticket===epoch&&next<=total&&entries.length<1000&&panels.visible('outline')&&getPaper()?.id===paperId){
        try{const value=await api('paper_outline',{id:paperId,page:next});if(ticket!==epoch||disposed||getPaper()?.id!==paperId)break;append(value.items);next++;render();}
        catch(error){if(ticket!==epoch)return;runner=null;scanning=false;render();status.textContent=`识别暂停于第 ${next} 页：${error.message}；可继续重试。`;return;}
        // Yield between pages; no all-document request or image rendering.
        await new Promise(resolve=>setTimeout(resolve,500));
      }
      if(ticket===epoch){runner=null;scanning=false;render();if(entries.length>=1000)status.textContent+=' · 已达 1000 项，请使用文内搜索继续定位。';}
    }
    scan.addEventListener('click',()=>void run());
    panels.registerPanel({id:'outline',label:'大纲',element:root,reading:true,onShow:()=>void open()});render();
    setMode('outline');return {setPage(page){currentPage=page;highlight();},sync(){if(getPaper()?.id!==paperId){++epoch;paperId=null;clearOutline();source='';total=0;loading=false;scanning=false;observer?.disconnect();thumbGeneration++;thumbQueue=[];thumbStart=1;thumbs.replaceChildren();render();}if(panels.visible('outline'))void open();else scanning=false;},dispose(){disposed=true;++epoch;scanning=false;observer?.disconnect();}};
  }
  return {create};
})();
