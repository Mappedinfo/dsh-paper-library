'use strict';
window.PaperAbstract = (() => {
  function create({api}){
    const node=(tag,text,cls)=>{const element=document.createElement(tag);if(text!==undefined)element.textContent=text;if(cls)element.className=cls;return element;};
    const button=(label,action)=>{const control=node('button',label,'button subtle');control.type='button';control.addEventListener('click',action);return control;};
    const dialog=node('dialog',undefined,'paper-abstract-dialog'), heading=node('header',undefined,'dialog-heading');
    const title=node('h2','文献摘要');title.id='paper-abstract-title';dialog.setAttribute('aria-labelledby',title.id);
    const close=button('关闭',()=>dialog.close());heading.append(title,close);
    const body=node('div',undefined,'paper-abstract-content');dialog.append(heading,body);document.body.append(dialog);
    let ticket=0;
    dialog.addEventListener('close',()=>{++ticket;});
    const sourceLabel=source=>source.kind==='pdf'?`PDF 第 ${source.page} 页 · 自动提取，待核对`:
      ({radar:'研究主题已存摘要',catalog:'文献资料已存摘要',doi:'DOI 对应的公开摘要'})[source.kind]||'已存摘要';
    const statusLabels={failed:'上次译文未完成。',pending:'译文正在生成，或上次生成状态尚未确认。',unavailable:'连接 DSH 模型后可自动翻译。'};
    function showTranslation(container,result,retry){
      container.replaceChildren();
      if(result.translation_status==='complete'&&result.translation){
        const value=result.translation, language=value.target_language==='en'?'英文':'简体中文';
        container.append(node('h3',`AI 译文 · ${language}`),node('p',[value.model?.provider,value.model?.model].filter(Boolean).join(' / '),'small muted'),node('p',value.text,'paper-abstract-text'));
        return;
      }
      container.append(node('p',statusLabels[result.translation_status]||'译文暂不可用。','small muted'));
      if(result.translation_status!=='unavailable')container.append(button('重试或查看译文',retry));
    }
    async function open(ref,displayTitle){
      const request=++ticket, active=()=>dialog.open&&ticket===request;
      title.textContent=displayTitle||'文献摘要';
      const status=node('p','正在读取摘要…','muted');status.setAttribute('role','status');body.replaceChildren(status);
      if(!dialog.open)dialog.showModal();
      try{
        const result=await api('paper_abstract_read',ref);
        if(!active())return;
        title.textContent=result.title||displayTitle||'文献摘要';
        if(!result.text){
          status.textContent=result.unreadable?'摘要来源暂不可读。可稍后重试。':'没有找到可确认的摘要原文。';
          if(result.unreadable)body.append(button('重试读取',()=>void open(ref,displayTitle)));
          return;
        }
        const source=node('section'), attribution=node('p',sourceLabel(result.source),'small muted');
        if(/^https?:\/\//i.test(result.source.url||'')){
          const link=node('a','查看来源');
          link.href=result.source.url;link.target='_blank';link.rel='noopener noreferrer';attribution.append(document.createTextNode(' · '),link);
        }
        source.append(node('h3','摘要原文'),attribution,node('p',result.text,'paper-abstract-text'));
        body.replaceChildren(source);
        if(result.truncated){body.append(node('p','摘要超过 8,000 字符，此处显示前 8,000 字符。','small muted'));return;}
        const translated=node('section');translated.setAttribute('aria-live','polite');body.append(translated);
        async function translate(retry=false){
          translated.replaceChildren(node('p','正在翻译摘要…','muted'));
          try{
            const response=await api('paper_abstract_translate',{...ref,source_hash:result.source_hash,target_language:result.target_language,retry});
            if(active())showTranslation(translated,response,()=>void translate(true));
          }catch(error){
            if(active())translated.replaceChildren(node('p',`翻译未完成：${error.message}`,'small muted'),button('重试翻译',()=>void translate(true)));
          }
        }
        if(result.translation_status==='ready')void translate();
        else showTranslation(translated,result,()=>void translate(true));
      }catch(error){
        if(active()){status.textContent=`摘要读取失败：${error.message}`;body.append(button('重试读取',()=>void open(ref,displayTitle)));}
      }
    }
    return {open};
  }
  return {create};
})();
