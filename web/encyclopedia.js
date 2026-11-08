'use strict';
window.PaperEncyclopedia={create({api,toast,openReference,getSource=()=>null}){
  const node=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;};
  const button=(label,action)=>{const b=node('button',label,'button subtle');b.type='button';b.addEventListener('click',action);return b;};
  const dialog=node('dialog',undefined,'wiki-dialog');dialog.setAttribute('aria-label','阅读百科与语言词条');
  const header=node('header',undefined,'wiki-header'),close=button('关闭',()=>leave());header.append(close);
  const tabs=node('nav',undefined,'wiki-tabs');tabs.setAttribute('aria-label','词条分类');header.prepend(tabs);
  let language=null,languageView='words';
  let mode='encyclopedia',query='',sort='updated_desc',offset=0,ticket=0,selected=null,pendingSource=null,dirty=false;
  const queryInput=node('input');queryInput.type='search';queryInput.placeholder='检索词条、别名与释义';queryInput.setAttribute('aria-label','检索词条');
  const search=node('form',undefined,'wiki-search');const submit=button('检索',()=>{query=queryInput.value.trim();offset=0;void load();});search.append(queryInput,submit,button('新建词条',()=>edit(null)));search.addEventListener('submit',event=>{event.preventDefault();query=queryInput.value.trim();offset=0;void load();});
  const sortControl=node('select');sortControl.setAttribute('aria-label','词条排序');for(const [value,label]of [['updated_desc','最近更新'],['created_desc','最新添加'],['created_asc','最早添加'],['term_asc','字母 A–Z'],['term_desc','字母 Z–A']]){const option=node('option',label);option.value=value;sortControl.append(option);}sortControl.value=sort;sortControl.addEventListener('change',()=>{sort=sortControl.value;offset=0;void load();});search.append(sortControl);
  const layout=node('div',undefined,'wiki-layout'),index=node('aside',undefined,'wiki-index'),article=node('article',undefined,'wiki-article'),status=node('p','', 'small muted');status.setAttribute('role','status');layout.append(index,article);dialog.append(header,search,status,layout);document.body.append(dialog);
  const tabButtons={};for(const [value,label]of [['encyclopedia','百科'],['words','语言与词条']]){tabButtons[value]=button(label,()=>showSection(value==='words'&&language?'language':value));tabs.append(tabButtons[value]);}
  function discard(){if(dirty&&!window.confirm('词条尚未保存，放弃本次编辑？'))return false;dirty=false;return true;}
  function leave(){if(!discard())return;++ticket;language?.hide();dialog.close();}
  function present(){
    const lexical=mode!=='language',inLanguage=mode!=='encyclopedia';
    search.hidden=status.hidden=layout.hidden=!lexical;
    dialog.classList.toggle('wiki-language-active',inLanguage);
    for(const [key,b]of Object.entries(tabButtons))b.setAttribute('aria-pressed',String(key==='words'?inLanguage:!inLanguage));
    if(language){language.navigation.hidden=!inLanguage;language.settingsButton.hidden=!inLanguage;
      if(mode!=='language')language.hide();
      for(const name of ['work','history','words'])document.getElementById(`language-tab-${name}`).setAttribute('aria-pressed',String(inLanguage&&name===languageView));
    }
    if(!dialog.open)dialog.showModal();
  }
  function showSection(next='encyclopedia',phrase='',source=null){
    if(next==='language'&&language&&languageView!=='words'){language.show(languageView);return;}
    if(!discard())return;
    mode=next==='language'?'words':next;if(mode==='words')languageView='words';
    query=phrase;queryInput.value=query;pendingSource=source||(mode==='words'?getSource():null);offset=0;present();void load();
  }
  function openLanguage(next){if(!discard())return false;++ticket;mode='language';languageView=next;present();return true;}
  function attachLanguage(value){
    language=value;dialog.append(language.element);header.insertBefore(language.navigation,close);header.insertBefore(language.settingsButton,close);
    language.navigation.classList.add('wiki-language-tabs');language.navigation.hidden=true;language.settingsButton.hidden=true;
    document.getElementById('language-tab-words').textContent='词条';
    language.element.querySelector('.language-heading').hidden=true;
    const context=node('div',undefined,'language-context-row');context.append(document.getElementById('language-paper'),document.getElementById('language-status'));language.element.insertBefore(context,language.element.firstChild);
  }
  dialog.addEventListener('cancel',event=>{event.preventDefault();leave();});
  function markup(text){const root=node('div',undefined,'wiki-prose');for(const line of String(text||'尚未填写释义。').split('\n')){const p=node(line.startsWith('## ')?'h3':'p');let end=0;const raw=line.replace(/^## /,'');for(const match of raw.matchAll(/\[\[([^\]\n]{1,200})\]\]/g)){p.append(document.createTextNode(raw.slice(end,match.index)),button(match[1],()=>{if(!discard())return;query=match[1];queryInput.value=query;offset=0;void load();}));end=match.index+match[0].length;}p.append(document.createTextNode(raw.slice(end)));root.append(p);}return root;}
  async function load(){if(!discard())return;const seq=++ticket;status.textContent='正在读取词条…';for(const [key,b]of Object.entries(tabButtons))b.setAttribute('aria-pressed',String(key===mode));
    try{const result=await api(mode==='words'?'vocabulary_list':'encyclopedia_list',{query,sort,offset,limit:30});if(seq!==ticket)return;index.replaceChildren();const items=result.items||[];for(const item of items){const b=button(item.term,()=>{if(discard())show(item);});b.classList.add('wiki-index-item');index.append(b);}const pager=node('div',undefined,'wiki-pagination');const prev=button('上一页',()=>{offset=Math.max(0,offset-30);void load();}),next=button('下一页',()=>{offset+=30;void load();});prev.disabled=offset===0;next.disabled=!result.hasMore;pager.append(prev,next);index.append(pager);status.textContent=`${result.total} 个词条${result.truncated?' · 达到读取上限，请缩小检索范围':''}`;if(items.length)show(items[0]);else{selected=null;article.replaceChildren(node('h2',query||'积累阅读中的概念'),node('p',mode==='words'?'可新建难词，自动翻译词义与原句，并关联来源论文。':'还没有匹配词条。可从批注中的短语创建，或手动整理概念、人物与机构。'),button(mode==='words'?'新建难词':'创建百科词条',()=>edit(null)));}}
    catch(error){if(seq===ticket)status.textContent=error.message;}}
  function sources(root,items){
    const section=node('section',undefined,'wiki-sources');section.append(node('h3','文献来源'));
    if(!items.length)section.append(node('p','尚未关联文献。'));
    for(const source of items){
      const block=node('div',undefined,'wiki-source');
      block.append(button(`${source.title||'来源文献'}${source.page?' · 第 '+source.page+' 页':''}`,()=>void openReference({paperId:source.paper_id,page:source.page})));
      const pair=node('div',undefined,'wiki-bilingual');
      for(const [label,text]of [['原句',source.quote||source.source_sentence||''],['译文 · AI 待核对',source.sentence_translation||'尚无原句译文']]){
        const column=node('div');column.append(node('strong',label),node('blockquote',text));pair.append(column);
      }
      if(source.meaning)block.append(node('p',`词义 · ${source.meaning}`));block.append(pair);if(source.source_provenance==='user_supplied'||source.source_kind==='user_supplied')block.append(node('p','原句由用户选取或填写，尚未逐字核验。','small muted'));
      const background=source.author_background||{},labels={chinese:'中文语言背景作者',non_chinese:'非中文语言背景作者',mixed:'混合语言背景作者'};
      block.append(node('p',labels[background.kind]?`${labels[background.kind]} · 用户注明；依据：${background.evidence||'未提供'}`:'作者语言背景未知 · 不根据姓名或文章语言推断','small muted'));
      if(source.model)block.append(node('p',`AI 译文 · ${source.model.provider}/${source.model.model}`,'small muted'));
      section.append(block);
    }
    root.append(section);
  }
  function show(item){++ticket;selected=item;article.replaceChildren(node('h2',item.term));if(mode==='words'){article.append(node('p',`${item.meaning_source==='user'?'人工释义':'AI 释义 · 待核对'} · ${item.status==='mastered'?'已掌握':'待学习'}`,'small muted'),markup(item.meaning));sources(article,item.encounters||[]);article.append(button('补充原句与译文',()=>{query=item.term;edit(null);}),button('编辑释义',()=>edit(item)),button(item.status==='mastered'?'重新学习':'标记已掌握',async()=>{try{await api('vocabulary_update',{id:item.id,expected_revision:item.revision,status:item.status==='mastered'?'learning':'mastered'});await load();}catch(e){status.textContent=e.message;}}));return;}
    const labels={term:'术语',organization:'机构',abbreviation:'缩写',person:'人物',concept:'概念'};article.append(node('p',`${labels[item.kind]||'词条'} · 人工整理${item.aliases?.length?' · '+item.aliases.join(' / '):''}`,'small muted'),markup(item.definition),button('编辑词条',()=>edit(item)));if(pendingSource)article.append(button('将当前批注加入来源',async()=>{try{const saved=await api('encyclopedia_put',{...item,expected_revision:item.revision,source:pendingSource});pendingSource=null;show(saved);status.textContent='已关联当前批注。';}catch(e){status.textContent=e.message;}}));sources(article,item.sources||[]);}
  function edit(item){if(!discard())return;if(mode==='words'&&!item){createWord();return;}++ticket;const word=mode==='words'&&item;article.replaceChildren(node('h2',word?'编辑释义':item?'编辑词条':'新建百科词条'));const form=node('form'),field=(label,value,max,textarea=false)=>{const l=node('label',label,'field'),input=node(textarea?'textarea':'input');input.value=value||'';input.maxLength=max;if(textarea)input.rows=12;l.append(input);form.append(l);return input;};const term=field('词条',item?.term||query,200);term.readOnly=Boolean(item);const aliases=word?null:field('别名与缩写（每行一个）',item?.aliases?.join('\n')||'',4000,true);if(aliases)aliases.rows=2;
    const kind=node('select');if(!word){kind.setAttribute('aria-label','词条类型');for(const [value,label]of [['term','术语'],['concept','概念'],['organization','机构'],['abbreviation','缩写'],['person','人物']]){const option=node('option',label);option.value=value;kind.append(option);}kind.value=item?.kind||'term';form.append(kind);}
    const definition=field(word?'释义':'内容（可用 [[词条名]] 建立内部链接）',word?item.meaning:item?.definition,word?2000:12000,true);form.addEventListener('input',()=>dirty=true);const save=node('button','保存','button primary');save.type='submit';form.append(save);if(pendingSource&&!word)form.append(node('p',`来源：${pendingSource.title||'当前文献'} · 第 ${pendingSource.page} 页`,'small muted'));
    form.addEventListener('submit',async event=>{event.preventDefault();save.disabled=true;try{const saved=await api(word?'vocabulary_update':'encyclopedia_put',word?{id:item.id,expected_revision:item.revision,meaning:definition.value}:{term:term.value,kind:kind.value,aliases:aliases.value.split('\n').map(x=>x.trim()).filter(Boolean),definition:definition.value,expected_revision:item?.revision??0,...(pendingSource?{source:pendingSource}:{})});dirty=false;pendingSource=null;status.textContent='词条已保存。';show(saved);}catch(e){status.textContent=e.message;}finally{save.disabled=false;}});article.append(form);}
  function createWord(){
    const seq=++ticket,source=pendingSource||getSource();
    article.replaceChildren(node('h2','新建难词'));
    if(!source?.paper_id){article.append(node('p','请先打开来源论文，再新建难词以关联原句。'));return;}
    const form=node('form',undefined,'wiki-word-form');
    const field=(label,value,max,textarea=false)=>{const wrap=node('label',label,'field'),input=node(textarea?'textarea':'input');input.value=value||'';input.maxLength=max;input.required=true;if(textarea)input.rows=4;wrap.append(input);form.append(wrap);return input;};
    form.append(node('p',`来源：${source.title||'当前论文'}`,'small muted'));
    const term=field('难词或短语',query,80),page=field('PDF 页码',String(source.page||1),4);page.type='number';page.min='1';page.max='2000';
    const sentence=field('原句（保留原文，需包含上方词条）',source.quote||'',1000,true);
    const detail=node('details'),summary=node('summary','作者语言背景（默认未知）');detail.append(summary);
    const background=node('select');background.setAttribute('aria-label','作者语言背景');
    for(const [value,label]of [['unknown','未知'],['chinese','中文语言背景作者'],['non_chinese','非中文语言背景作者'],['mixed','混合语言背景作者']]){const option=node('option',label);option.value=value;background.append(option);}
    const evidenceLabel=node('label','核实依据（如作者自述或介绍链接）','field'),evidence=node('input');evidence.maxLength=1000;evidenceLabel.append(evidence);
    detail.append(background,evidenceLabel,node('p','语言背景不等于国籍；请勿根据姓名、单位或论文语言判断。','small muted'));form.append(detail);
    const save=node('button','自动翻译并保存','button primary');save.type='submit';form.append(save);article.append(form);
    let request=null,fingerprint='',busy=false;
    form.addEventListener('input',()=>dirty=true);
    form.addEventListener('submit',async event=>{
      event.preventDefault();if(busy)return;
      if(background.value!=='unknown'&&!evidence.value.trim()){status.textContent='请填写作者语言背景的核实依据，或保持未知。';return;}
      const payload={id:source.paper_id,page:Number(page.value),term:term.value.trim(),source_sentence:sentence.value.trim(),author_background:{kind:background.value,evidence:evidence.value.trim()}};
      const next=JSON.stringify(payload);if(next!==fingerprint||!request){request=window.crypto.randomUUID();fingerprint=next;}
      busy=true;save.disabled=true;for(const input of form.querySelectorAll('input,textarea,select'))input.disabled=true;
      status.textContent='正在翻译词条与原句…';
      try{
        const saved=await api('vocabulary_create',{...payload,request_id:request});
        if(seq!==ticket){toast('难词已保存，可在难词本查看。');return;}
        dirty=false;pendingSource=null;status.textContent='难词与原句译文已保存 · AI 译文待核对';show(saved);
      }catch(error){if(seq===ticket){status.textContent=error.message;if(error.retry_with_new_request)request=null;}}
      finally{busy=false;save.disabled=false;for(const input of form.querySelectorAll('input,textarea,select'))input.disabled=false;}
    });
  }
  return {show:showSection,openLanguage,attachLanguage,close:leave};
}};
