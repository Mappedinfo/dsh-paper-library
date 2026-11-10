'use strict';
window.PaperOutline = (() => {
  function create({api,panels,getPaper,navigate}) {
    const root=document.createElement('section');root.id='paper-outline';root.className='paper-outline';
    const status=document.createElement('p');status.className='small';status.setAttribute('role','status');
    const scan=document.createElement('button');scan.type='button';scan.className='button subtle';
    const list=document.createElement('nav');list.setAttribute('aria-label','论文大纲');root.append(status,scan,list);
    let paperId=null,items=[],source='',next=1,total=0,epoch=0,loading=false,scanning=false,runner=null,disposed=false;
    function render(){
      scan.hidden=source!=='inferred';scan.disabled=loading||next>total||items.length>=1000||(!scanning&&runner===epoch);
      scan.textContent=scanning?'暂停识别':next>total?'识别完成':next>1?'继续识别章节':'识别章节标题';
      status.textContent=source==='bookmarks'?`PDF 书签 · ${items.length} 项`:source==='inferred'?`无可用书签 · 标题识别 ${next-1}/${total} 页 · 结果请对照原文`:loading?'正在读取大纲…':'请打开 PDF 查看大纲。';
    }
    function append(values){
      for(const item of values){if(items.length>=1000)break;items.push(item);const link=document.createElement('button');link.type='button';link.className='outline-entry';link.style.paddingInlineStart=`${12+(Math.min(item.level,8)-1)*14}px`;
        const title=document.createElement('span'),page=document.createElement('small');title.textContent=item.title;page.textContent=String(item.page);link.append(title,page);link.title=`第 ${item.page} 页 · ${item.title}`;
        const id=paperId;link.addEventListener('click',()=>{if(getPaper()?.id===id)void navigate({paperId:id,page:item.page,rects:item.rects||[]});});list.append(link);}
    }
    async function open(){
      const paper=getPaper();if(disposed||!paper?.pdf)return;
      if(paper.id===paperId&&(source||loading))return;
      const ticket=++epoch;paperId=paper.id;items=[];list.replaceChildren();source='';scanning=false;loading=true;render();
      try{const value=await api('paper_outline',{id:paperId});if(ticket!==epoch||disposed||getPaper()?.id!==paperId)return;
        source=value.items.length?'bookmarks':'inferred';total=value.page_count;next=1;append(value.items);loading=false;render();
        if(value.truncated)status.textContent+=' · 书签过多，仅显示前 1000 个节点中的有效目录';
      }catch(error){if(ticket===epoch){loading=false;render();status.textContent=`大纲未读取：${error.message}；重新打开此标签可重试。`;}}
    }
    async function run(){
      if(scanning){scanning=false;render();return;}if(runner===epoch)return;scanning=true;const ticket=epoch;runner=ticket;render();
      while(scanning&&!disposed&&ticket===epoch&&next<=total&&items.length<1000&&panels.visible('outline')&&getPaper()?.id===paperId){
        try{const value=await api('paper_outline',{id:paperId,page:next});if(ticket!==epoch||disposed||getPaper()?.id!==paperId)break;append(value.items);next++;render();}
        catch(error){if(ticket!==epoch)return;runner=null;scanning=false;render();status.textContent=`识别暂停于第 ${next} 页：${error.message}；可继续重试。`;return;}
        // Yield between pages; no all-document request or image rendering.
        await new Promise(resolve=>setTimeout(resolve,500));
      }
      if(ticket===epoch){runner=null;scanning=false;render();if(items.length>=1000)status.textContent+=' · 已达 1000 项，请使用文内搜索继续定位。';}
    }
    scan.addEventListener('click',()=>void run());
    panels.registerPanel({id:'outline',label:'大纲',element:root,reading:true,onShow:()=>void open()});render();
    return {sync(){if(getPaper()?.id!==paperId){++epoch;paperId=null;items=[];source='';loading=false;scanning=false;list.replaceChildren();render();}if(panels.visible('outline'))void open();else scanning=false;},dispose(){disposed=true;++epoch;scanning=false;}};
  }
  return {create};
})();
