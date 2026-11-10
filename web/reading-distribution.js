'use strict';
// Read-only, viewport-driven native mark summaries. No PDF text, pixels or model calls.
window.PaperReadingDistribution = (() => {
  const SIZE=96,TTL=60000,LIMIT=120;
  const make=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n;};
  const reasons={no_pdf:'没有 PDF',page_limit:'超过页数预算',annotation_limit:'超过批注预算',invalid_geometry:'部分位置无法识别',unreadable_pdf:'PDF 暂不可读',pdf_unavailable:'PDF 暂不可读',unsupported_pdf:'PDF 加密或格式不支持',invalid_pdf:'PDF 格式异常',empty_pdf:'PDF 没有页面',pdf_changed:'读取期间 PDF 已变化，请刷新重试',invalid_annotation:'部分批注位置无效',page_read_error:'部分页面无法读取',style_unavailable:'部分样式无法识别',repaired_pdf:'PDF 需要修复，结果可能不完整'};
  function smooth(bins,width=3){
    const sigma=Math.max(1,Math.min(6,Number(width)||3)),radius=Math.ceil(sigma*3),result=bins.map(()=>0);
    // Preserve mass at page/document edges rather than inventing marks outside the PDF.
    bins.forEach((count,i)=>{if(!count)return;let sum=0;for(let j=Math.max(0,i-radius);j<=Math.min(bins.length-1,i+radius);j++)sum+=Math.exp(-.5*((j-i)/sigma)**2);for(let j=Math.max(0,i-radius);j<=Math.min(bins.length-1,i+radius);j++)result[j]+=count*Math.exp(-.5*((j-i)/sigma)**2)/sum;});
    return result;
  }
  function values(result){
    if(!result||!['ready','partial','unknown'].includes(result.status)||result.bin_count!==SIZE)throw Error('划线分布格式不可识别');
    for(const key of ['other','ai_style'])if(!Array.isArray(result[key]?.bins)||result[key].bins.length!==SIZE||result[key].bins.some(n=>!Number.isFinite(n)||n<0))throw Error('划线位置数据无效');
    return result;
  }
  function geometry(result,{mode='density',smoothing=3,ai=true}={}){
    const total=Math.max(1,...['other','ai_style'].map(key=>result[key].bins.reduce((a,b)=>a+b,0)));
    const groups=['other',...(ai?['ai_style']:[])].map(key=>({key,bins:result[key].bins.map(n=>n/total)}));
    const lanes=groups.map(group=>({...group,weights:mode==='bands'?group.bins:smooth(group.bins,smoothing)}));
    const peak=Math.max(1e-12,...lanes.flatMap(group=>group.weights));
    return lanes.map(group=>({...group,levels:group.weights.map(n=>n/peak)}));
  }
  function create({api}){
    let enabled=false,mode='density',ai=true,smoothing=3,disposed=false,running=false,controller=null,epoch=0;
    const rows=new Map(),cache=new Map(),pending=[];
    const observer=typeof IntersectionObserver==='function'?new IntersectionObserver(entries=>{for(const e of entries){const row=rows.get(e.target);if(row){row.visible=e.isIntersecting;if(e.isIntersecting)enqueue(row);}}},{rootMargin:'40px'}):null;
    function prune(){for(const [element] of rows)if(!element.isConnected){observer?.unobserve(element);rows.delete(element);}}
    function current(row){const entry=cache.get(row.item.id);return entry&&entry.stamp===stamp(row.item)&&Date.now()-entry.time<TTL?entry:null;}
    const stamp=item=>`${item.modified||''}|${item.pdf||''}`;
    function put(row,value){cache.delete(row.item.id);cache.set(row.item.id,{stamp:stamp(row.item),time:Date.now(),value});while(cache.size>LIMIT)cache.delete(cache.keys().next().value);}
    function render(row,value){
      const box=row.element;box.hidden=!enabled;if(!enabled)return;
      box.replaceChildren();box.classList.toggle('is-unknown',!value||value.status==='unknown');
      let text='待读取',hint='仅在可见时读取原生 PDF 划线位置。';
      if(value?.status==='unknown'){text='未知';hint=value.error||reasons[value.reason]||'暂不能读取 PDF 划线分布';}
      else if(value){text=value.total_marks?`${value.status==='partial'?'≥':''}${value.total_marks} 处`:value.status==='partial'?'已查范围未见划线':'未发现划线';hint=`${value.status==='partial'?'部分读取，以下为已读取下限。':''}其他样式 ${value.other.annotation_count??'未知'} 处（${value.other.marked_pages??'未知'} 页）；AI 蓝虚线样式 ${value.ai_style.annotation_count??'未知'} 处（${value.ai_style.marked_pages??'未知'} 页）。PDF 共 ${value.page_count??'未知'} 页。${value.status==='partial'?`已扫描 ${value.coverage?.scanned_pages??'未知'} 页；${(value.reasons||[]).map(r=>reasons[r]||r).join('、')}。`:''}`;}
      const caption=make('span','reading-distribution-caption');caption.append(make('span','','划线分布'),make('span','reading-distribution-count',text));box.append(caption);
      const full=`${hint} 从左至右为 PDF 物理页与页内纵向位置。浅绿是其他划线（来源未确认），浅蓝虚线是 AI 样式（同款人工线也会匹配）。只表示标注分布，不代表阅读完成度或理解程度。${mode==='density'?'曲线为高斯平滑的相对集中度，两层共用本篇峰值；不比较跨文献强度。':'条带显示划线位置，两层共用本篇峰值；不比较跨文献强度。'}可在设置中调整。`;
      box.title=full;box.setAttribute('aria-label',`划线分布：${text}。${full}`);
      if(value&&value.status!=='unknown'){
        for(const lane of geometry(value,{mode,smoothing,ai})){
          const track=make('span',`reading-distribution-track ${lane.key==='ai_style'?'is-ai':'is-other'}`);track.setAttribute('aria-hidden','true');
          const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox','0 0 288 12');svg.setAttribute('preserveAspectRatio','none');
          if(mode==='density'&&lane.levels.some(n=>n>0)){
            const path=document.createElementNS(svg.namespaceURI,'path');const points=lane.levels.map((n,i)=>`${(i+.5)*3},${11-n*9}`).join(' L');path.setAttribute('d',`M0,11 L${points} L288,11 Z`);path.setAttribute('class','reading-distribution-density');svg.append(path);
          }else lane.levels.forEach((n,i)=>{if(!n)return;const rect=document.createElementNS(svg.namespaceURI,'rect');rect.setAttribute('x',String(i*3));rect.setAttribute('y','1');rect.setAttribute('width','3');rect.setAttribute('height','10');rect.setAttribute('opacity',String(.25+.75*Math.sqrt(n)));svg.append(rect);});
          track.append(svg);box.append(track);
        }
      }else{box.append(make('span','reading-distribution-placeholder'));}
    }
    function enqueue(row){
      if(disposed||!enabled||!row.visible||!row.element.isConnected||document.hidden)return;
      if(!row.item.pdf){const missing={status:'unknown',reason:'no_pdf'};put(row,missing);render(row,missing);return;}
      const found=current(row);if(found){render(row,found.value);return;}
      if(!pending.includes(row))pending.push(row);void pump();
    }
    async function pump(){
      if(running||disposed||!enabled||document.hidden)return;prune();
      let row;while(pending.length){const candidate=pending.shift();if(rows.has(candidate.element)&&candidate.visible&&!current(candidate)){row=candidate;break;}}
      if(!row)return;running=true;const ticket=epoch;controller=new AbortController();
      try{const result=values(await api('reading_distribution',{id:row.item.id},{signal:controller.signal}));if(ticket!==epoch||disposed)return;put(row,result);for(const candidate of rows.values())if(candidate.item.id===row.item.id)render(candidate,result);}
      catch(error){if(ticket===epoch&&!disposed&&error.name!=='AbortError'){const result={status:'unknown',error:`读取失败：${error.message}。可点文献库刷新重试。`};put(row,result);for(const candidate of rows.values())if(candidate.item.id===row.item.id)render(candidate,result);}}
      finally{running=false;controller=null;if(!disposed)queueMicrotask(()=>void pump());}
    }
    function mount(item){
      const element=make('span','reading-distribution');element.tabIndex=0;element.setAttribute('role','img');element.dataset.readingDistribution=item.id;
      const row={element,item:{...item},visible:false};rows.set(element,row);if(!item.pdf)put(row,{status:'unknown',reason:'no_pdf'});render(row,current(row)?.value);observer?.observe(element);
      // Prevent a focus/tooltip target in the tag row from opening/selecting a paper.
      element.addEventListener('click',event=>event.stopPropagation());
      queueMicrotask(()=>{prune();if(!observer&&element.isConnected){row.visible=true;enqueue(row);}});return element;
    }
    function applyPreferences(value={}){
      const next=value.reading_distribution_enabled!==false,changed=next!==enabled;enabled=next;mode=value.reading_distribution_mode==='bands'?'bands':'density';ai=value.reading_distribution_ai!==false;smoothing=Math.max(1,Math.min(6,Number(value.reading_distribution_smoothing)||3));
      if(changed&&!enabled){epoch++;pending.length=0;controller?.abort();}prune();for(const row of rows.values()){render(row,current(row)?.value);if(enabled)enqueue(row);}
    }
    function invalidate(id){epoch++;controller?.abort();if(id)cache.delete(id);else cache.clear();for(const row of rows.values()){if(!id||row.item.id===id)render(row);enqueue(row);}}
    function visible(){if(!document.hidden){prune();for(const row of rows.values())enqueue(row);}}
    document.addEventListener('visibilitychange',visible);window.addEventListener('focus',visible);
    return {mount,applyPreferences,invalidate,dispose(){disposed=true;epoch++;controller?.abort();pending.length=0;rows.clear();cache.clear();observer?.disconnect();document.removeEventListener('visibilitychange',visible);window.removeEventListener('focus',visible);}};
  }
  return {create,smooth,geometry,validate:values};
})();
