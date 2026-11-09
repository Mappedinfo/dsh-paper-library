'use strict';
// On-demand, single-paper reading index. The worker owns extraction and source checks.
window.PaperDocumentElements = (() => {
  const kinds={formula:'公式',figure:'图片',table:'表格',algorithm:'算法'};
  const node=(tag,cls,text)=>{const el=document.createElement(tag);el.className=cls||'';if(text!==undefined)el.textContent=text;return el;};
  const button=(text,fn)=>{const el=node('button','button subtle',text);el.type='button';el.addEventListener('click',fn);return el;};
  let serial=0;
  function flowSVG(flow) {
    const layout=window.PaperBoardSource;
    if(!layout)throw new Error('流程图组件未加载，请刷新后重试。');
    const NS='http://www.w3.org/2000/svg',make=(tag,attrs,text)=>{const el=document.createElementNS(NS,tag);for(const [k,v] of Object.entries(attrs||{}))el.setAttribute(k,String(v));if(text!==undefined)el.textContent=text;return el;};
    const edges=(flow.edges||[]).map(e=>({...e,from:e.source,to:e.target}));
    const nodes=layout.layout((flow.nodes||[]).map(n=>({...n,x:0,y:0,w:270,h:96})),edges.filter(e=>e.kind!=='back'),{mode:'tree',direction:'tb',gapX:75,gapY:80});
    if(!nodes.length)throw new Error('没有可绘制的步骤，请核对原文。');
    const byId=new Map(nodes.map(n=>[n.id,n])),width=Math.max(...nodes.map(n=>n.x+n.w))+130,height=Math.max(...nodes.map(n=>n.y+n.h))+60;
    const svg=make('svg',{viewBox:`-30 -30 ${width+30} ${height+30}`,width,height,role:'img','aria-label':'由伪代码构建的流程图'}),markerId=`algorithm-arrow-${++serial}`;
    const defs=make('defs'),marker=make('marker',{id:markerId,viewBox:'0 0 10 10',refX:9,refY:5,markerWidth:7,markerHeight:7,orient:'auto-start-reverse'});marker.append(make('path',{d:'M 0 0 L 10 5 L 0 10 z',fill:'#526b82'}));defs.append(marker);svg.append(defs);
    let backLane=0;
    for(const e of edges){const a=byId.get(e.from),b=byId.get(e.to);if(!a||!b)continue;let d,mid;
      if(b.y<=a.y){const x=Math.max(a.x+a.w,b.x+b.w)+32+(backLane++%4)*18;d=`M ${a.x+a.w} ${a.y+a.h/2} H ${x} V ${b.y+b.h/2} H ${b.x+b.w}`;mid={x:x+4,y:(a.y+b.y)/2+40};}
      else{const geo=layout.edgeGeometry(a,b,'elbow');d=geo.path;mid=geo.mid;}
      svg.append(make('path',{d,fill:'none',stroke:'#526b82','stroke-width':1.7,'marker-end':`url(#${markerId})`,'data-edge-kind':e.kind||'next'}));
      if(e.label)svg.append(make('text',{x:mid.x+5,y:mid.y-5,fill:'#274e68','font-size':12},e.label));
    }
    for(const n of nodes){const g=make('g',{'data-node-id':n.id});const branch=['if','loop','decision','condition'].includes(n.kind);
      g.append(branch?make('polygon',{points:`${n.x+n.w/2},${n.y} ${n.x+n.w},${n.y+n.h/2} ${n.x+n.w/2},${n.y+n.h} ${n.x},${n.y+n.h/2}`,fill:'#edf4fa',stroke:'#526b82'}):make('rect',{x:n.x,y:n.y,width:n.w,height:n.h,rx:['start','end'].includes(n.kind)?32:7,fill:'#f8fafc',stroke:'#526b82'}));
      g.append(make('title',{},n.source_text||n.label));const text=make('text',{x:n.x+n.w/2,y:n.y+29,'text-anchor':'middle',fill:'#172c3b','font-size':12});
      const words=Array.from(n.label||n.kind||''),lines=[];while(words.length&&lines.length<4)lines.push(words.splice(0,branch?23:34).join(''));if(words.length)lines[lines.length-1]+='…';
      lines.forEach((line,i)=>text.append(make('tspan',{x:n.x+n.w/2,dy:i?16:0},line)));g.append(text);svg.append(g);
    }
    return svg;
  }
  function create({api,panels,getPaper,navigate,annotated,toast,yieldWork,openSettings,sharedSearch=false}) {
    let active=null,disposed=false,ticket=0,previewCount=0,lastInput=Date.now(),lastBatch=0;const views=new Map(),papers=new Map(),previewQueue=[],images=[];
    let resources={preview_bytes:12*1048576,preview_count:12,batch_pages:1,batch_gap_ms:2000,idle_ms:1200};
    const touch=()=>{lastInput=Date.now();};
    for(const event of ['pointerdown','keydown','wheel'])document.addEventListener(event,touch,{capture:true,passive:true});
    const canRun=id=>!disposed&&getPaper()?.id===id&&active&&panels.visible(`elements-${active}`)&&(!document.hidden||Boolean(yieldWork));
    async function waitIdle(id,r){if(yieldWork){await yieldWork();return canRun(id)&&!r.paused;}while(canRun(id)&&!r.paused){const delay=Math.max(resources.idle_ms-(Date.now()-lastInput),resources.batch_gap_ms-(Date.now()-lastBatch));if(delay<=0)return true;r.waiting=true;status(views.get(active),r);await new Promise(resolve=>setTimeout(resolve,Math.min(delay,250)));}return false;}
    const visibility=()=>{if(!document.hidden&&active){const id=getPaper()?.id;if(id&&!record(id).paused&&!record(id).coverage?.complete)void start(id);}};document.addEventListener('visibilitychange',visibility);
    function releaseImages(){for(const entry of images)entry.release();images.length=0;}
    function releaseCard(item){item.alive=false;item.observer?.disconnect();observers.delete(item.observer);for(let i=previewQueue.length-1;i>=0;i--)if(previewQueue[i].owner===item)previewQueue.splice(i,1);for(let i=images.length-1;i>=0;i--)if(images[i].owner===item){images[i].release();images.splice(i,1);}}
    function clearView(v){for(const item of v.cards.values())releaseCard(item);v.cards.clear();v.aux.clear();v.list.replaceChildren();v.elements=[];}
    function activate(kind){if(active!==kind){for(const v of views.values())clearView(v);previewQueue.length=0;++ticket;}active=kind;}
    function retainImage(entry){images.push(entry);let bytes=images.reduce((sum,item)=>sum+item.bytes,0);while(images.length>resources.preview_count||bytes>resources.preview_bytes){const old=images.shift();bytes-=old.bytes;old.release();}}

    const valid=(run,id)=>!disposed&&run===ticket&&getPaper()?.id===id;
    function record(id){if(!papers.has(id)){if(papers.size>=8){const removable=[...papers].find(([,r])=>!r.running);if(removable)papers.delete(removable[0]);}papers.set(id,{running:false,paused:false,coverage:null,notice:'',waiting:false,usage:null});}return papers.get(id);}
    function status(v,r){const c=r.coverage;v.status.textContent=r.notice||(r.waiting?'等待阅读操作空闲，低优先级提取 · ':'')+(c?`${c.scanned_pages?.length??c.scanned_pages??0} / ${c.page_count} 页${c.complete?' · 扫描完成，候选内容请对照原文':r.running?' · 按页提取中':' · 尚未扫描完'}`:'读取文献索引…');if(r.usage)v.status.title=`派生索引 ${(r.usage.index_bytes/1048576).toFixed(1)} / ${(r.usage.index_limit_bytes/1048576).toFixed(0)} MiB；预览缓存最多 ${(resources.preview_bytes/1048576).toFixed(0)} MiB。`;v.scan.textContent=r.running?'暂停扫描':c?.complete?'重新检查':'继续扫描';v.scan.disabled=false;if(v.clear)v.clear.disabled=r.running;if(v.adjust)v.adjust.hidden=!r.paused;}
    for(const [kind,label] of Object.entries(kinds)){
      const root=node('section','document-elements-panel');root.id=`document-elements-${kind}`;
      const toolbar=node('form','document-elements-toolbar'),input=node('input');input.type='search';input.placeholder=`检索${label}与原文`;input.setAttribute('aria-label',`检索${label}`);
      const search=button('检索',()=>void reload(true)),scan=button('继续扫描',()=>{const id=getPaper()?.id;if(!id)return;const r=record(id);if(r.running){r.paused=true;r.notice='将在当前页批次完成后暂停';status(views.get(kind),r);}else{r.paused=false;r.notice='';void start(id);}});
      const management=node('details','document-element-management');management.append(node('summary','','管理'));const clear=button('清除此篇提取索引',async()=>{const id=getPaper()?.id;if(!id||record(id).running)return;clear.disabled=true;try{await api('document_elements_clear',{id});if(getPaper()?.id===id){const r=record(id);r.paused=true;r.coverage=null;r.notice='提取索引已清除；原文和批注保留，可点继续扫描重建。';await reload(true);}}catch(error){toast?.(error.message,true);}finally{clear.disabled=false;}});management.append(clear);input.hidden=search.hidden=sharedSearch;toolbar.append(input,search,scan,management);toolbar.addEventListener('submit',e=>{e.preventDefault();void reload(true);});
      const adjust=button('调整资源设置',()=>openSettings?.());adjust.hidden=true;root.append(adjust);
      const stat=node('p','small document-elements-status');stat.setAttribute('role','status');const pager=node('div','pagination'),count=node('span');
      const previous=button('←',()=>{const v=views.get(kind);v.offset=Math.max(0,v.offset-40);void reload();}),next=button('→',()=>{views.get(kind).offset+=40;void reload();});previous.setAttribute('aria-label','上一页');next.setAttribute('aria-label','下一页');pager.append(previous,count,next);
      const list=node('div','document-elements-list');root.append(toolbar,stat,adjust,pager,list);
      const view={kind,root,input,scan,clear,adjust,status:stat,list,previous,next,count,offset:0,flowOnly:false,cards:new Map(),aux:new Map()};views.set(kind,view);
      if(kind==='figure'){const filter=button('只看流程图',()=>{view.flowOnly=!view.flowOnly;filter.setAttribute('aria-pressed',String(view.flowOnly));void reload(true);});filter.setAttribute('aria-pressed','false');toolbar.append(filter);
        const mark=button('标注本页流程图',async()=>{const id=getPaper()?.id;if(!id)return;const candidates=(view.elements||[]).filter(e=>e.subtype==='flowchart'&&e.method!=='caption-only');if(!candidates.length){toast?.('本页没有已定位区域的流程图。');return;}mark.disabled=true;let count=0;try{for(const e of candidates){if(disposed||getPaper()?.id!==id)break;const result=await api('document_element_annotate',{id,element_id:e.id});count++;if(getPaper()?.id===id)await annotated?.(id,e.page,result);}if(getPaper()?.id===id)toast?.(`已标注 ${count} 个流程图区域。`);}catch(error){toast?.(`已标注 ${count} 个区域，后续未完成：${error.message}`,true);}finally{mark.disabled=false;}});toolbar.append(mark);
      }
      panels.registerPanel({id:`elements-${kind}`,label,element:root,reading:true,onShow:()=>{if(active!==kind){activate(kind);void open();}}});
    }
    async function open(){const id=getPaper()?.id;if(!id||disposed)return;for(const v of views.values())if(v.paperId!==id){clearView(v);v.paperId=id;v.offset=0;v.input.value='';}const r=record(id);await reload();if(getPaper()?.id===id&&!r.paused&&!r.coverage?.complete)void start(id);}
    // 按来源身份协调当前页；扫描进度变化不卸载已显示的卡片或图片。
    function reconcile(v,elements,id,sourceVersion,result){
      const wanted=new Set(elements.map(e=>e.id));
      for(const [key,item]of v.cards)if(!wanted.has(key)){releaseCard(item);item.root.remove();v.cards.delete(key);}
      const nodes=[];
      for(const e of elements){const signature=JSON.stringify([sourceVersion,e]);let item=v.cards.get(e.id);
        if(item&&item.signature!==signature){releaseCard(item);item.root.remove();v.cards.delete(e.id);item=null;}
        if(!item){item=card(e,id,v);item.signature=signature;v.cards.set(e.id,item);}nodes.push(item.root);
      }
      const auxiliary=(key,value,build)=>{const signature=JSON.stringify(value);let item=v.aux.get(key);if(!item||item.signature!==signature){const root=build();if(item?.root.tagName==='DETAILS')root.open=item.root.open;item={signature,root};v.aux.set(key,item);}nodes.push(item.root);};
      if(!elements.length)auxiliary('empty',Boolean(result.coverage?.complete),()=>node('p','small',result.coverage?.complete?'未识别到匹配内容。扫描页、复杂排版或无编号公式可能需要在 PDF 中手动框选。':'尚无匹配内容；扫描完成后会自动更新。'));
      if(result.page_warnings?.length)auxiliary('page-warnings',result.page_warnings,()=>{const details=node('details','document-element-warnings');details.append(node('summary','','提取范围与遗漏提示'));for(const page of result.page_warnings){const important=page.warnings.filter(w=>!w.startsWith('版面规则提取候选'));if(important.length)details.append(node('p','small','第 '+page.page+' 页：'+important.join(' ')));}details.append(node('p','small','版面规则提取候选；无编号公式、扫描页和复杂跨栏内容可能遗漏，请核对原页。'));return details;});
      if(result.warnings?.length)auxiliary('warnings',result.warnings,()=>node('p','small',result.warnings.join(' ')));
      const keep=new Set(nodes);for(const child of [...v.list.children])if(!keep.has(child))child.remove();
      for(const [key,item]of v.aux)if(!keep.has(item.root))v.aux.delete(key);
      for(let i=0;i<nodes.length;i++)if(v.list.children[i]!==nodes[i])v.list.insertBefore(nodes[i],v.list.children[i]||null);
    }
    async function reload(reset=false){const v=views.get(active),id=getPaper()?.id;if(!v||!id||disposed)return;const run=++ticket;if(reset)v.offset=0;if(v.paperId!==id){clearView(v);v.paperId=id;v.offset=0;}status(v,record(id));
      try{const result=await api('document_elements_list',{id,kind:v.kind,query:v.input.value,offset:v.offset,limit:40,...(v.flowOnly?{subtype:'flowchart'}:{})});if(!valid(run,id)||active!==v.kind)return;
        const r=record(id);r.coverage=result.coverage;r.usage=result.usage;if(result.paused){r.paused=true;r.notice='扫描已暂停：'+(result.budget_reason||'已达到资源预算');}status(v,r);if(result.stale&&!result.paused)v.status.textContent='PDF 内容或提取版本已改变，将重新提取；旧结果暂不使用。';
        const elements=result.elements||[],total=result.total??elements.length;v.count.textContent=total?(v.offset+1)+'–'+(v.offset+elements.length)+' / '+total:'0 项';v.previous.disabled=v.offset===0;v.next.disabled=v.offset+elements.length>=total;
        // 在响应到达时读取位置，保留等待期间用户自己滚动后的最新位置。
        const scroll=reset?0:v.list.scrollTop;v.elements=elements;reconcile(v,elements,id,result.source_version,result);v.list.scrollTop=scroll;
      }catch(error){if(valid(run,id)){record(id).notice='读取失败：'+error.message;status(v,record(id));}}
    }
    async function start(id){const r=record(id);if(r.running||disposed)return;r.running=true;r.paused=false;r.notice='';let previous='';
      try{do{if(!await waitIdle(id,r))break;r.waiting=false;status(views.get(active),r);
        const result=await api('document_elements_scan',{id,limit:resources.batch_pages});lastBatch=Date.now();r.coverage=result.coverage;r.usage=result.usage;if(result.paused){r.paused=true;r.notice=`扫描已暂停：${result.budget_reason||'已达到资源预算'}`;}
        if(disposed||getPaper()?.id!==id)break;
        await reload();if(result.coverage?.complete)break;
        const key=JSON.stringify(result.coverage);if(key===previous)throw new Error('扫描没有继续前进，请重试或检查 PDF。');previous=key;
      }while(!r.paused);
      }catch(error){r.paused=true;r.notice=`扫描暂停：${error.message}`;}
      finally{r.running=false;r.waiting=false;if(r.paused&&!r.notice)r.notice='已暂停，已提取内容保留';if(!disposed&&getPaper()?.id===id&&views.has(active))status(views.get(active),r);}
    }
    function enqueue(fn,owner){if(previewQueue.length>=40||previewQueue.some(job=>job.owner===owner))return;const job=()=>fn();job.owner=owner;previewQueue.push(job);pump();}
    function pump(){while(!disposed&&previewCount<1&&previewQueue.length){const job=previewQueue.shift();previewCount++;void job().finally(()=>{previewCount--;pump();});}}
    function card(e,id,v){const item={alive:true},current=()=>!disposed&&item.alive&&active===v.kind&&getPaper()?.id===id&&v.paperId===id;const root=node('article','document-element-card'),heading=node('header'),title=node('strong','',e.title||kinds[e.kind]),page=button(`第 ${e.page} 页`,()=>void navigate({paperId:id,page:e.page,rects:[e.rect],focusId:e.id}));heading.append(title,page);root.append(heading);for(const segment of (e.source_segments||[]).slice(1)){root.append(button(`续页 ${segment.page}`,()=>void navigate({paperId:id,page:segment.page,rects:[segment.rect],focusId:e.id})));}
      if(e.subtype==='flowchart')root.append(node('span','small','流程图候选 · 根据图题识别'));
      const image=node('img','document-element-image');image.alt=e.title||kinds[e.kind];image.hidden=true;image.addEventListener('click',()=>void navigate({paperId:id,page:e.page,rects:[e.rect],focusId:e.id}));
      const state=node('p','small'),preview=button('预览裁剪',()=>enqueue(loadPreview,item));root.append(image,state,preview);let loaded=false,loading=false;
      async function loadPreview(){if(!current()||loaded||loading)return;loading=true;preview.disabled=true;state.textContent='正在读取区域…';try{const result=await api('document_element_preview',{id,element_id:e.id,render_width:480});if(!current())return;if(result.mime_type!=='image/png'||typeof result.image!=='string')throw new Error('未返回有效的区域图像');image.src=result.image.startsWith('data:')?result.image:`data:image/png;base64,${result.image}`;image.hidden=false;loaded=true;preview.hidden=true;state.textContent='';retainImage({owner:item,bytes:Math.max(1,Number(result.width)||480)*Math.max(1,Number(result.height)||640)*4,release:()=>{image.removeAttribute('src');image.hidden=true;loaded=false;preview.hidden=false;preview.textContent='预览裁剪';}});}catch(error){if(current()){state.textContent=`截图未加载：${error.message}`;preview.textContent='重试截图';}}finally{loading=false;preview.disabled=false;}}
      if(typeof IntersectionObserver==='function'){const observer=new IntersectionObserver(entries=>{if(entries.some(x=>x.isIntersecting)){observer.disconnect();observers.delete(observer);enqueue(loadPreview,item);}}, {root:v.list,rootMargin:'100px'});item.observer=observer;observer.observe(root);observers.add(observer);}
      const caption=e.kind==='figure'?e.caption||e.text:e.text||e.caption;if(caption){const details=node('details');details.open=e.kind==='formula';details.append(node('summary','',e.kind==='formula'?'公式原文':'原文与图题'),node('pre','document-element-text',caption));root.append(details);}
      if(e.rows?.length){const table=node('table','document-element-table');for(const row of e.rows){const tr=node('tr');for(const value of row)tr.append(node('td','',value));table.append(tr);}const scroll=node('div','document-element-table-scroll');scroll.append(table);root.append(scroll);if(e.rows_truncated)root.append(node('p','small','表格预览已截取；点击页码查看完整原表。'));}
      if(e.context){const details=node('details');details.open=e.kind==='formula';details.append(node('summary','','邻近定义与说明（原文）'),node('p','document-element-text',e.context));root.append(details);}
      if(e.warnings?.length)root.append(node('p','small',e.warnings.join(' ')));
      const actions=node('div','document-element-actions'),annotate=button('标注区域',async()=>{if(getPaper()?.id!==id)return;annotate.disabled=true;try{const result=await api('document_element_annotate',{id,element_id:e.id});if(getPaper()?.id===id){await annotated?.(id,e.page,result);annotate.textContent='已标注';}}catch(error){if(getPaper()?.id===id)toast?.(`区域未标注：${error.message}`,true);}finally{annotate.disabled=false;}});actions.append(annotate);
      if(e.kind==='algorithm')actions.append(button('构建流程图',async()=>{const btn=actions.lastChild;btn.disabled=true;try{const result=await api('document_element_flow',{id,element_id:e.id});if(current())showFlow(e,result.flow);}catch(error){if(current())toast?.(error.message,true);}finally{btn.disabled=false;}}));root.append(actions);item.root=root;return item;
    }
    const observers=new Set();
    function showFlow(e,flow){const dialog=node('dialog','document-flow-dialog'),header=node('header'),close=button('关闭',()=>dialog.close());header.append(node('strong','',e.title||'算法流程图'),close);const status=node('p','small',`${flow.complete?'已识别控制结构':'部分流程，请核对原文'} · ${flow.nodes.length} 个步骤。 ${(flow.warnings||[]).join(' ')}`),viewport=node('div','document-flow-viewport');viewport.append(flowSVG(flow));const source=node('details');source.append(node('summary','','伪代码原文'),node('pre','document-element-text',e.text||''));dialog.append(header,status,viewport,source);document.body.append(dialog);dialog.addEventListener('close',()=>dialog.remove(),{once:true});dialog.showModal();}
    function sync(value){const kind=value?.sidebar?.replace(/^elements-/,'');if(kinds[kind]){if(active!==kind||views.get(kind).paperId!==getPaper()?.id){activate(kind);void open();}}else{activate(null);}}
    return {search(kind,query){const v=views.get(kind);if(!v)return;v.input.value=query;v.offset=0;if(active===kind)void reload(true);},applyResources(policy){if(!policy)return;resources={...resources,...policy};let bytes=images.reduce((n,e)=>n+e.bytes,0);while(images.length>resources.preview_count||bytes>resources.preview_bytes){const entry=images.shift();bytes-=entry.bytes;entry.release();}if(active&&getPaper()?.id)status(views.get(active),record(getPaper().id));},sync,selected:()=>active,restore:kind=>{if(kinds[kind])panels.show(`elements-${kind}`);},reload,dispose(){disposed=true;for(const event of ['pointerdown','keydown','wheel'])document.removeEventListener(event,touch,{capture:true});document.removeEventListener('visibilitychange',visibility);for(const v of views.values())clearView(v);releaseImages();++ticket;previewQueue.length=0;for(const o of observers)o.disconnect();observers.clear();for(const r of papers.values())r.paused=true;document.querySelectorAll('.document-flow-dialog').forEach(d=>d.remove());}};
  }
  return Object.freeze({create,flowSVG});
})();
