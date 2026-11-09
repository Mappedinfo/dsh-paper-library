'use strict';
window.PaperAnnotationStyle = (() => {
  const colors = [['#ffdb66','金黄'],['#ed9c51','橙色'],['#df718b','玫瑰'],['#c85454','朱红'],['#569976','绿色'],['#49a5ad','青色'],['#447dc4','蓝色'],['#9274bd','紫色'],['#687382','灰色']];
  const node=(tag,text,cls)=>{const n=document.createElement(tag);if(text)n.textContent=text;if(cls)n.className=cls;return n;};
  function palette(value,onChange){
    const group=node('div',null,'annotation-color-presets');group.setAttribute('role','group');group.setAttribute('aria-label','常用批注颜色');
    for(const [color,name]of colors){const b=node('button',null,'annotation-color-swatch');b.type='button';b.style.setProperty('--swatch',color);b.title=name;b.setAttribute('aria-label',name);b.dataset.color=color;b.addEventListener('click',()=>{set(color);onChange(color);});group.append(b);}
    function set(color){for(const b of group.children)b.setAttribute('aria-pressed',String(b.dataset.color===color.toLowerCase()));}
    set(value);return {element:group,set};
  }
  function editor({note,paperId,api,onSaved}){
    if(!note.style_version||note.handwriting||!['underline','strikeout','square','ink','highlight','note'].includes(note.type))return null;
    const detail=node('details',null,'annotation-style-menu'),summary=node('summary','样式','button subtle'),panel=node('div',null,'annotation-style-panel');
    summary.setAttribute('aria-label','修改这条 PDF 批注的颜色与线型');detail.append(summary,panel);
    const rgb=note.color?.stroke||[1,.86,.4],input=node('input');input.type='color';input.value='#'+rgb.map(v=>Math.round(Math.max(0,Math.min(1,v))*255).toString(16).padStart(2,'0')).join('');input.setAttribute('aria-label','自定义批注颜色');
    const presets=palette(input.value,color=>{input.value=color;});input.addEventListener('input',()=>presets.set(input.value));
    const label=node('label','自定义颜色');label.append(input);panel.append(presets.element,label);
    const line=node('select');line.setAttribute('aria-label','批注线型');
    const supportsLine=['underline','strikeout','square','ink'].includes(note.type);
    if(supportsLine){for(const [value,text]of [['solid','实线'],['dashed','虚线'],['dotted','点线']]){const option=node('option',text);option.value=value;line.append(option);}line.value=note.line_style||'solid';const row=node('label','线型');row.append(line);panel.append(row);}
    const status=node('p',null,'small'),save=node('button','保存样式','button');save.type='button';status.setAttribute('role','status');panel.append(save,status);
    let version=note.style_version;
    save.addEventListener('click',async()=>{
      save.disabled=true;status.textContent='正在保存…';
      try{const result=await api('annotation_style',{id:paperId,annotation_id:note.id,color:input.value,...(supportsLine?{line_style:line.value}:{}),expected_version:version});version=result.annotation.style_version;status.textContent='已保存到 PDF';detail.open=false;await onSaved(result.annotation);}
      catch(error){status.textContent=error.message;detail.open=true;}
      finally{save.disabled=false;}
    });
    detail.addEventListener('toggle',()=>{if(detail.open){const rect=summary.getBoundingClientRect();panel.style.left=Math.max(8,Math.min(rect.left,window.innerWidth-252))+'px';panel.style.top=Math.max(8,Math.min(rect.bottom+4,window.innerHeight-235))+'px';}});
    panel.addEventListener('keydown',event=>{if(event.key==='Escape'){event.stopPropagation();detail.open=false;summary.focus();}});
    return detail;
  }
  return {palette,editor};
})();
