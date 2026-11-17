'use strict';
window.PaperEncyclopedia={create({api,toast,openReference,searchUsage,getSource=()=>null}){
  const node=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;};
  const button=(label,action)=>{const b=node('button',label,'button subtle');b.type='button';b.addEventListener('click',action);return b;};
  const dialog=node('dialog',undefined,'wiki-dialog');dialog.setAttribute('aria-label','阅读百科与语言词条');
  const header=node('header',undefined,'wiki-header'),close=button('关闭',()=>leave());header.append(close);
  const heading=node('div',undefined,'wiki-header-main'),status=node('p','','wiki-status small muted');
  status.setAttribute('role','status');
  const tabs=node('nav',undefined,'wiki-tabs');tabs.setAttribute('aria-label','词条分类');heading.append(tabs,status);header.prepend(heading);
  function setStatus(message){status.textContent=message;status.title=message;}
  let docked=false;
  const syncedPapers=new Set();
  const listedWords=new Map();
  const dock=button('侧边窗',()=>setDocked(!docked));dock.id='wiki-dock';dock.setAttribute('aria-pressed','false');dock.title='切换为侧边窗，继续在 PDF 中选取文字';header.prepend(dock);
  let language=null,languageView='words';
  let mode='encyclopedia',query='',sort='updated_desc',offset=0,ticket=0,selected=null,pendingSource=null,dirty=false;
  const queryInput=node('input');queryInput.type='search';queryInput.placeholder='检索词条、别名与释义';queryInput.setAttribute('aria-label','检索词条');
  const search=node('form',undefined,'wiki-search');const submit=button('检索',()=>{query=queryInput.value.trim();offset=0;void load();});
  const add=button('新建词条',()=>edit(null)),addFromPaper=button('从当前论文添加',()=>createWord());
  search.append(queryInput,submit,add,addFromPaper);search.addEventListener('submit',event=>{event.preventDefault();query=queryInput.value.trim();offset=0;void load();});
  const sortControl=node('select');sortControl.setAttribute('aria-label','词条排序');
  for(const [value,label]of [['updated_desc','最近更新'],['created_desc','最新加入'],['created_asc','最早加入'],['term_asc','字母 A–Z'],['term_desc','字母 Z–A']]){
    const option=node('option',label);option.value=value;sortControl.append(option);
  }
  sortControl.value=sort;
  sortControl.addEventListener('change',()=>{
    if(!discard()){sortControl.value=sort;return;}
    sort=sortControl.value;offset=0;void load(selected);
  });
  const layout=node('div',undefined,'wiki-layout'),sidebar=node('aside',undefined,'wiki-index');
  const index=node('div',undefined,'wiki-index-list'),article=node('article',undefined,'wiki-article');
  const sortLabel=node('label','排序','wiki-index-sort');sortLabel.append(sortControl);
  sidebar.append(sortLabel,index);layout.append(sidebar,article);dialog.append(header,search,layout);document.body.append(dialog);
  const tabButtons={};for(const [value,label]of [['encyclopedia','百科'],['words','语言与词条']]){tabButtons[value]=button(label,()=>showSection(value==='words'&&language?'language':value));tabs.append(tabButtons[value]);}
  function discard(){if(dirty&&!window.confirm('词条尚未保存，放弃本次编辑？'))return false;dirty=false;return true;}
  function leave(){if(!discard())return;++ticket;language?.hide();dialog.close();}
  function dockPosition(){if(docked){const bottom=document.querySelector('.topbar')?.getBoundingClientRect().bottom||8;dialog.style.setProperty('--wiki-dock-top',`${Math.max(8,Math.min(bottom+8,window.innerHeight-240))}px`);}}
  function openWindow(){dialog.setAttribute('aria-modal',String(!docked));dockPosition();if(!dialog.open){if(docked)dialog.show();else dialog.showModal();}}
  function setDocked(value){
    docked=value;const wasOpen=dialog.open;if(wasOpen)dialog.close();
    dialog.classList.toggle('wiki-docked',docked);dock.textContent=docked?'大窗口':'侧边窗';dock.setAttribute('aria-pressed',String(docked));dock.title=docked?'切回大窗口':'切换为侧边窗，继续在 PDF 中选取文字';
    if(wasOpen)openWindow();window.PaperFloatingWindows?.attach(dialog)?.refresh();dock.focus({preventScroll:true});
  }
  window.addEventListener('resize',dockPosition);
  document.addEventListener('keydown',event=>{if(!docked||!dialog.open||event.defaultPrevented||event.key!=='Escape')return;const targetDialog=event.target.closest?.('dialog');if(targetDialog&&targetDialog!==dialog)return;event.preventDefault();leave();});
  function present(){
    const lexical=mode!=='language',inLanguage=mode!=='encyclopedia';
    search.hidden=status.hidden=layout.hidden=!lexical;
    add.textContent=mode==='words'?'新建单词／词组':'新建词条';
    addFromPaper.hidden=mode!=='words'||!(pendingSource||getSource())?.paper_id;
    queryInput.placeholder=mode==='words'?'检索词条、释义与备注':'检索词条、别名与释义';
    dialog.classList.toggle('wiki-language-active',inLanguage);
    for(const [key,b]of Object.entries(tabButtons))b.setAttribute('aria-pressed',String(key==='words'?inLanguage:!inLanguage));
    if(language){language.navigation.hidden=!inLanguage;language.settingsButton.hidden=!inLanguage;
      if(mode!=='language')language.hide();
      for(const name of ['work','history','words'])document.getElementById(`language-tab-${name}`).setAttribute('aria-pressed',String(inLanguage&&name===languageView));
    }
    openWindow();
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
  async function load(preferred=null){if(!discard())return;const seq=++ticket;setStatus('正在读取词条…');for(const [key,b]of Object.entries(tabButtons))b.setAttribute('aria-pressed',String(key===mode));
    try{
      let syncWarning='';
      const paperId=mode==='words'?getSource()?.paper_id:null;
      if(paperId&&!syncedPapers.has(paperId)){
        try{
          let cursor=0;
          while(seq===ticket&&dialog.open){
            setStatus(`正在登记本篇已有译文… ${cursor} 条已检查`);
            const batch=await api('language_vocabulary_sync',{id:paperId,offset:cursor,limit:20});
            if(seq!==ticket||!dialog.open)return;
            if(batch.truncated){syncWarning=' · 部分旧译文超出本次补登记范围';break;}
            if(!batch.hasMore){syncedPapers.add(paperId);break;}
            if(!Number.isSafeInteger(batch.next_offset)||batch.next_offset<=cursor)throw Error('译文登记未取得进展');
            cursor=batch.next_offset;await new Promise(resolve=>setTimeout(resolve,0));
          }
        }catch(error){syncWarning=` · 旧译文补登记未完成：${error.message}；可点检索重试`;}
      }
      if(seq!==ticket||!dialog.open)return;
      const result=await api(mode==='words'?'vocabulary_list':'encyclopedia_list',{query,sort,offset,limit:30});
      if(seq!==ticket)return;
      index.replaceChildren();
      index.scrollTop=0;
      listedWords.clear();
      const items=result.items||[];
      for(const item of items){
        if(mode==='words')listedWords.set(item.id,item);
        const b=button(item.term,()=>{if(discard())show(listedWords.get(item.id)||item);});
        b.classList.add('wiki-index-item');index.append(b);
      }
      const pager=node('div',undefined,'wiki-pagination');const prev=button('上一页',()=>{offset=Math.max(0,offset-30);void load();}),next=button('下一页',()=>{offset+=30;void load();});prev.disabled=offset===0;next.disabled=!result.hasMore;pager.append(prev,next);index.append(pager);
      setStatus(`${result.total} 个词条${result.truncated?' · 达到读取上限，请缩小检索范围':''}${syncWarning}`);
      const item=preferred ? items.find(entry=>entry.id===preferred.id)||preferred : items[0];
      if(item)show(item);
      else {selected=null;article.replaceChildren(node('p','还没有匹配词条。'),button(mode==='words'?'新建单词或词组':'创建百科词条',()=>edit(null)));}
    }
    catch(error){if(seq===ticket)setStatus(error.message);}}
  function sources(root,items,word=null){
    const section=node('section',undefined,'wiki-sources');section.append(node('h3','文献来源'));
    if(!items.length)section.append(node('p','尚未关联文献。'));
    const shownPapers=new Set();
    function sourceActions(source){
      const row=node('div',undefined,'wiki-source-actions');
      if(source.paper_id)row.append(button(`${source.title||'来源文献'}${source.page?' · 第 '+source.page+' 页':''}`,()=>void openReference({paperId:source.paper_id,page:source.page})));
      if(word&&source.paper_id&&!shownPapers.has(source.paper_id)){
        shownPapers.add(source.paper_id);
        const detach=button('解除论文关联',()=>{
          if(window.confirm(`解除「${word.term}」与「${source.title||'这篇论文'}」的关联？这篇论文在词条里的原句与译文也会移除。`)){
            void updateWord(word,{detach_paper_id:source.paper_id},'已解除论文关联。',detach);
          }
        });
        row.append(detach);
      }
      return row;
    }
    for(const source of items){
      const block=node('div',undefined,'wiki-source');
      block.append(sourceActions(source));
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
    const older=(word?.linked_papers||[]).filter(source=>!shownPapers.has(source.paper_id));
    if(older.length){
      const detail=node('details');detail.append(node('summary',`其他关联论文（${older.length}）`));
      for(const source of older)detail.append(sourceActions(source));
      section.append(detail);
    }
    root.append(section);
  }
  async function updateWord(item,patch,message,control){
    const owner=ticket;
    control.disabled=true;
    try{
      const saved=await api('vocabulary_update',{id:item.id,expected_revision:item.revision,...patch});
      if(owner!==ticket)return;
      dirty=false;show(saved);setStatus(message);
    }catch(error){if(owner===ticket)setStatus(error.message);}
    finally{control.disabled=false;}
  }
  function citationLink(source,label){
    try{
      const url=new URL(source.url);
      if(!['http:','https:'].includes(url.protocol)||url.username||url.password)return null;
      const link=node('a',label);
      link.href=url.href;link.target='_blank';link.rel='noopener noreferrer';link.title=source.title;
      return link;
    }catch{return null;}
  }
  function renderCitations(root,sources,heading){
    if(!sources?.length)return;
    root.append(node('h4',heading));
    const list=node('ul',undefined,'wiki-term-citations');
    for(const source of sources){
      const link=citationLink(source,source.title);
      if(!link)continue;
      const entry=node('li'),kind={abstract:'摘要',snippet:'网页搜索摘录',
        metadata:source.provider==='deepseek-native'?'DeepSeek 搜索结果':'题录',webpage:'DeepSeek 已阅读网页'}[source.evidence];
      entry.append(node('span',`[${source.id}] `),link);
      const details=[source.authors?.join('、'),source.year,kind].filter(Boolean).join(' · ');
      if(details)entry.append(node('p',details,'small muted'));
      if(source.excerpt){const detail=node('details');detail.append(node('summary','查看检索片段'),node('blockquote',source.excerpt));entry.append(detail);}
      list.append(entry);
    }
    root.append(list);
  }
  function renderExplanation(value){
    const block=node('section',undefined,'wiki-word-note wiki-term-explanation');
    const evidence=value.link_summary?'DeepSeek 网页解读 · 待核对'
      :value.native?'DeepSeek 联网引用 · 待核对':'依据摘要与网页检索片段 · 待核对';
    block.append(node('h3','AI 检索释义'),node('p',evidence,'small muted'));
    const refs=new Map(value.sources.map(source=>[source.id,source]));
    for(const section of [value.definition,...value.paragraphs]){
      const content=node('div',undefined,'paper-markdown');
      if(window.PaperMarkdown){
        window.PaperMarkdown.render(content,section.text);
        // Only links from this explanation's checked sources are actionable.
        for(const link of content.querySelectorAll('a'))link.replaceWith(...link.childNodes);
      }else content.append(node('p',section.text));
      const line=content.lastElementChild?.tagName==='P'?content.lastElementChild:node('p');
      for(const id of section.citations){
        const source=refs.get(id),link=source&&citationLink(source,`[${id}]`);
        if(link){link.className='wiki-inline-citation';line.append(' ',link);}
      }
      if(!line.parentElement&&line.hasChildNodes())content.append(line);
      block.append(content);
    }
    renderCitations(block,value.sources,value.link_summary?'阅读来源':'参考来源');
    article.append(block);
  }
  function explanationStatus(attempt){
    const message={
      missing_key:'DeepSeek 联网工具需要配置 DEEPSEEK_API_KEY。',
      authentication:'DeepSeek 未接受当前 API 密钥。',
      rate_limited:'DeepSeek 联网请求达到限额，可稍后重试。',
      timeout:'检索或生成用时过长，已保存本次尝试。',
      provider_refusal:'DeepSeek 未生成释义，可调整检索词。',
      model_unavailable:'用于生成释义的模型暂不可用。',
    }[attempt.reason];
    if(message)return message;
    if(attempt.status==='generation_failed')return attempt.reason==='invalid_citations'
      ? '模型返回的引用未通过校验，可重新生成。'
      : '此次释义生成失败，可重试。';
    if(attempt.status==='unavailable')return '公开检索暂不可用，可稍后重试。';
    return attempt.research_mode==='link'?'公开链接未返回可支持释义的引用，可更换来源。':'没有找到足以支持释义的片段，可调整检索词再试。';
  }
  function renderSearchAttempt(attempt){
    if(!attempt||attempt.status==='explained')return;
    const block=node('section',undefined,'wiki-word-note wiki-term-search');
    block.append(node('h3','最近一次检索'),node('p',attempt.query),node('p',explanationStatus(attempt),'small muted'));
    const link=attempt.public_url&&citationLink({url:attempt.public_url,title:'公开链接'},attempt.public_url);
    if(link)block.append(link);
    renderCitations(block,attempt.sources,'已保存的检索线索');
    article.append(block);
  }
  function explainWord(item){
    if(!discard())return;
    const owner=++ticket,form=node('form',undefined,'wiki-word-form');
    const query=wordField(form,'公开检索词',item.explanation_search?.query||item.explanation?.query||item.term,200);
    query.required=true;
    const modes=node('fieldset',undefined,'wiki-research-modes');
    modes.append(node('legend','检索方式'));
    const choices=[
      ['standard','联网检索','适合日常查证。优先用 DeepSeek 搜索，服务不可用或证据不足时，改查 DSH 网页检索与 Crossref、arXiv 学术索引。'],
      ['deep','DeepSeek 深度检索','适合需要多步核对的问题。DeepSeek 会搜索、打开网页并在页内查找证据，可能耗时更长。需配置 DeepSeek API 密钥。'],
      ['link','阅读公开链接','适合已有明确来源的情况。DeepSeek 根据你提供的公开 HTTPS 网页生成释义。需配置 DeepSeek API 密钥。'],
    ];
    const savedMode=item.explanation_search?.research_mode;
    const selected=choices.some(([value])=>value===savedMode)?savedMode:'standard';
    for(const [value,title,description] of choices){
      const label=node('label',undefined,'wiki-research-mode'),option=node('input'),content=node('span');
      option.type='radio';option.name='research_mode';option.value=value;option.checked=value===selected;
      const heading=node('strong',title),detail=node('span',description,'wiki-research-mode-description');
      heading.id=`wiki-research-${value}-name`;detail.id=`wiki-research-${value}-description`;
      option.setAttribute('aria-labelledby',heading.id);option.setAttribute('aria-describedby',detail.id);
      content.append(heading,detail);label.append(option,content);modes.append(label);
    }
    form.append(modes);
    const link=wordField(form,'公开 HTTPS 链接',item.explanation_search?.public_url,2048);
    link.type='url';
    const currentMode=()=>modes.querySelector(':checked').value;
    function updateMode(){
      const readingLink=currentMode()==='link';
      link.required=readingLink;link.disabled=run.disabled||!readingLink;link.parentElement.hidden=!readingLink;
    }
    form.append(node('p','检索词会发送给公开检索服务。阅读公开链接时，DeepSeek 也会收到所填网址。','small muted'));
    const actions=node('div',undefined,'wiki-source-actions'),run=node('button','检索、生成并保存','button primary');
    run.type='submit';actions.append(run,button('取消',()=>show(item)));form.append(actions);
    modes.addEventListener('change',updateMode);updateMode();
    form.addEventListener('submit',async event=>{
      event.preventDefault();if(run.disabled)return;
      const mode=currentMode();
      run.disabled=query.disabled=modes.disabled=link.disabled=true;
      setStatus('正在公开检索，完成后会自动保存…');
      try{
        const result=await api('vocabulary_explain',{id:item.id,expected_revision:item.revision,query:query.value.trim(),public_search:true,
          ...(mode!=='standard'?{research_mode:mode}:{}),...(mode==='link'?{public_url:link.value.trim()}:{})});
        if(owner!==ticket)return;
        show(result.word);
        setStatus(result.status==='explained'?'已自动保存释义和引用。':'已自动保存本次检索。');
      }catch(error){if(owner===ticket)setStatus(error.message);}
      finally{run.disabled=query.disabled=modes.disabled=false;updateMode();}
    });
    article.replaceChildren(node('h2',item.term),node('h3','AI 检索与解释'),form);
    query.focus();
  }
  function showWord(item){
    const provenance=item.meaning?(item.meaning_source==='user'?'人工释义':'AI 释义 · 待核对'):'尚无释义';
    article.append(node('p',`${provenance} · ${item.status==='mastered'?'已掌握':'待学习'}`,'small muted'));
    if(item.meaning&&(item.meaning_source==='user'||item.meaning!==item.explanation?.definition?.text))article.append(markup(item.meaning));
    const controls=node('div',undefined,'wiki-source-actions');
    controls.append(button(item.explanation||item.explanation_search?'重新检索与解释':'AI 检索与解释',()=>explainWord(item)));
    const mastery=button(item.status==='mastered'?'重新学习':'标记已掌握',()=>void updateWord(item,{status:item.status==='mastered'?'learning':'mastered'},'已更新学习状态。',mastery));
    const usage=button('全库搜索用例',async()=>{
      const owner=ticket;usage.disabled=true;
      try{
        if(await searchUsage(item.term)){if(owner===ticket)leave();}
        else if(owner===ticket)setStatus('未能切换到全文检索。');
      }catch(error){if(owner===ticket)setStatus(error.message);}
      finally{usage.disabled=false;}
    });
    if(searchUsage)controls.append(usage);
    const attach=button('补充原句与译文',()=>createWord(item));
    attach.disabled=!(pendingSource||getSource())?.paper_id;
    controls.append(button('编辑释义',()=>editWord(item,'meaning')),attach,mastery);
    const note=node('section',undefined,'wiki-word-note'),head=node('div',undefined,'wiki-source-actions');
    head.append(node('h3','备注'),button(item.note?'编辑备注':'添加备注',()=>editWord(item,'note')));
    note.append(head);
    if(item.note)note.append(node('p',item.note));
    article.append(controls);
    if(item.explanation)renderExplanation(item.explanation);
    renderSearchAttempt(item.explanation_search);
    article.append(note);sources(article,item.encounters||[],item);
  }
  function show(item){++ticket;selected=item;article.replaceChildren(node('h2',item.term));if(mode==='words'){listedWords.set(item.id,item);showWord(item);return;}
    const labels={term:'术语',organization:'机构',abbreviation:'缩写',person:'人物',concept:'概念'};article.append(node('p',`${labels[item.kind]||'词条'} · 人工整理${item.aliases?.length?' · '+item.aliases.join(' / '):''}`,'small muted'),markup(item.definition),button('编辑词条',()=>edit(item)));if(pendingSource)article.append(button('将当前批注加入来源',async()=>{try{const saved=await api('encyclopedia_put',{...item,expected_revision:item.revision,source:pendingSource});pendingSource=null;show(saved);setStatus('已关联当前批注。');}catch(e){setStatus(e.message);}}));sources(article,item.sources||[]);}
  function edit(item){if(mode==='words'){editWord(item);return;}if(!discard())return;++ticket;article.replaceChildren(node('h2',item?'编辑词条':'新建百科词条'));const form=node('form'),field=(label,value,max,textarea=false)=>{const l=node('label',label,'field'),input=node(textarea?'textarea':'input');input.value=value||'';input.maxLength=max;if(textarea)input.rows=12;l.append(input);form.append(l);return input;};const term=field('词条',item?.term||query,200);term.readOnly=Boolean(item);const aliases=field('别名与缩写（每行一个）',item?.aliases?.join('\n')||'',4000,true);aliases.rows=2;
    const kind=node('select');kind.setAttribute('aria-label','词条类型');for(const [value,label]of [['term','术语'],['concept','概念'],['organization','机构'],['abbreviation','缩写'],['person','人物']]){const option=node('option',label);option.value=value;kind.append(option);}kind.value=item?.kind||'term';form.append(kind);
    const definition=field('内容（可用 [[词条名]] 建立内部链接）',item?.definition,12000,true);form.addEventListener('input',()=>dirty=true);const save=node('button','保存','button primary');save.type='submit';form.append(save);if(pendingSource)form.append(node('p',`来源：${pendingSource.title||'当前文献'} · 第 ${pendingSource.page} 页`,'small muted'));
    form.addEventListener('submit',async event=>{event.preventDefault();save.disabled=true;try{const saved=await api('encyclopedia_put',{term:term.value,kind:kind.value,aliases:aliases.value.split('\n').map(x=>x.trim()).filter(Boolean),definition:definition.value,expected_revision:item?.revision??0,...(pendingSource?{source:pendingSource}:{})});dirty=false;pendingSource=null;setStatus('词条已保存。');show(saved);}catch(e){setStatus(e.message);}finally{save.disabled=false;}});article.append(form);}
  function editWord(item=null,field='meaning'){
    if(!discard())return;
    const owner=++ticket,previous=selected;
    const heading=item?(field==='note'?'编辑备注':'编辑释义'):'新建单词／词组';
    const form=node('form',undefined,'wiki-word-form');
    const term=wordField(form,'单词或词组',item?.term||(query.length<=80?query:''),80);
    term.required=true;term.readOnly=Boolean(item);
    const meaning=!item||field==='meaning'?wordField(form,item?'释义':'释义（选填）',item?.meaning,2000,4):null;
    const note=!item||field==='note'?wordField(form,item?'备注':'备注（选填）',item?.note,4000,4):null;
    if(item&&meaning)meaning.required=true;
    const save=node('button','保存','button primary');save.type='submit';
    const cancel=button('取消',()=>{if(discard()){if(previous)show(previous);else void load();}});
    const controls=node('div',undefined,'wiki-source-actions');controls.append(save,cancel);form.append(controls);
    form.addEventListener('input',()=>dirty=true);
    form.addEventListener('submit',async event=>{
      event.preventDefault();if(save.disabled)return;
      const inputs=[term,meaning,note].filter(Boolean);
      for(const input of inputs)input.disabled=true;
      try{
        if(item){await updateWord(item,{[field]:(note||meaning).value},field==='note'?'备注已保存。':'释义已保存。',save);return;}
        save.disabled=true;
        const saved=await api('vocabulary_create',{mode:'manual',term:term.value,meaning:meaning.value,note:note.value});
        if(owner!==ticket)return;
        dirty=false;show(saved);await load(saved);
      }catch(error){if(owner===ticket)setStatus(error.message);}
      finally{save.disabled=false;for(const input of inputs)input.disabled=false;}
    });
    article.replaceChildren(node('h2',heading),form);(item?note||meaning:term).focus();
  }
  function wordField(form,label,value,max,rows=0){
    const wrap=node('label',label,'field'),input=node(rows?'textarea':'input');
    input.value=value||'';input.maxLength=max;if(rows)input.rows=rows;
    wrap.append(input);form.append(wrap);return input;
  }
  function createWord(item=null){
    if(!discard())return;
    const seq=++ticket,source=pendingSource||getSource();
    article.replaceChildren(node('h2',item?'补充原句与译文':'从当前论文添加词条'));
    if(!source?.paper_id){article.append(node('p','请先打开来源论文，再新建难词以关联原句。'));return;}
    const form=node('form',undefined,'wiki-word-form');
    const field=(label,value,max,rows)=>{const input=wordField(form,label,value,max,rows);input.required=true;return input;};
    form.append(node('p',`来源：${source.title||'当前论文'}`,'small muted'));
    const term=field('难词或短语',item?.term||query,80),page=field('PDF 页码',String(source.page||1),4);page.type='number';page.min='1';page.max='2000';
    term.readOnly=Boolean(item);
    const sentence=field('原句（保留原文，需包含上方词条）',source.quote||'',1000,4);
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
      if(background.value!=='unknown'&&!evidence.value.trim()){setStatus('请填写作者语言背景的核实依据，或保持未知。');return;}
      const payload={id:source.paper_id,page:Number(page.value),term:term.value.trim(),source_sentence:sentence.value.trim(),author_background:{kind:background.value,evidence:evidence.value.trim()}};
      const next=JSON.stringify(payload);if(next!==fingerprint||!request){request=window.crypto.randomUUID();fingerprint=next;}
      busy=true;save.disabled=true;for(const input of form.querySelectorAll('input,textarea,select'))input.disabled=true;
      setStatus('正在翻译词条与原句…');
      try{
        const saved=await api('vocabulary_create',{...payload,request_id:request});
        if(seq!==ticket){toast('难词已保存，可在难词本查看。');return;}
        dirty=false;pendingSource=null;setStatus('难词与原句译文已保存 · AI 译文待核对');show(saved);
      }catch(error){if(seq===ticket){setStatus(error.message);if(error.retry_with_new_request)request=null;}}
      finally{busy=false;save.disabled=false;for(const input of form.querySelectorAll('input,textarea,select'))input.disabled=false;}
    });
  }
  return {show:showSection,openLanguage,attachLanguage,close:leave};
}};
