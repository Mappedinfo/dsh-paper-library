'use strict';

/** Reading language tools. Results and vocabulary live on the host; this view holds one page. */
window.PaperLanguageLearning = {
  create({ api, persistence, getPaper, getSelection, toast, openReference, prepareChat, beforeOpen }) {
    const $ = id => document.getElementById(id);
    const make = (tag, text, cls) => { const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n; };
    const button = (id,text,fn) => {const b=make('button',text,'button subtle');b.id=id;b.type='button';b.addEventListener('click',fn);return b;};
    const panel=make('section',undefined,'language-panel');panel.id='language-panel';panel.hidden=true;panel.setAttribute('aria-label','翻译、表述与难词');
    panel.innerHTML=`<header class="language-heading"><div><strong>读懂，也学会表达</strong><p id="language-paper" class="small muted"></p></div><button id="language-close" class="icon-button" type="button" aria-label="关闭语言工具">×</button></header>
      <nav class="language-tabs" aria-label="语言工具"><button id="language-tab-work" class="button subtle" type="button">翻译与表述</button><button id="language-tab-history" class="button subtle" type="button">本篇记录</button><button id="language-tab-words" class="button subtle" type="button">难词本</button></nav>
      <p id="language-status" class="language-status" role="status"></p>
      <div id="language-work"><label class="field">选文或你的草稿<textarea id="language-source" rows="4" maxlength="8000" placeholder="拖选论文中的文字，或在这里输入要翻译、优化的表达。"></textarea></label><div class="language-actions"><label>译成 <select id="language-target"><option value="zh-CN">中文</option><option value="en">英文</option></select></label><button id="language-translate" class="button primary" type="button">直接翻译</button><button id="language-polish" class="button" type="button">优化表述</button></div><p class="small muted">使用本篇论文当前的 DSH 模型。运行后结果落盘，并自动积累选文中的难词；会使用模型额度。</p><div id="language-result"></div></div>
      <div id="language-history" hidden><div id="language-history-list"></div><div class="language-pagination"><button id="language-history-prev" class="button subtle" type="button">上一页</button><span id="language-history-range"></span><button id="language-history-next" class="button subtle" type="button">下一页</button></div></div>
      <div id="language-words" hidden><div class="language-word-filters"><input id="vocabulary-query" type="search" placeholder="检索词语、释义" aria-label="检索难词"><select id="vocabulary-status" aria-label="学习状态"><option value="">全部</option><option value="learning">待学习</option><option value="mastered">已掌握</option></select><button id="vocabulary-refresh" class="button subtle" type="button">刷新</button></div><p class="small muted">从翻译与表述优化中自动积累。AI 释义待核对；掌握程度由你标记。</p><div id="vocabulary-list"></div><div class="language-pagination"><button id="vocabulary-prev" class="button subtle" type="button">上一页</button><span id="vocabulary-range"></span><button id="vocabulary-next" class="button subtle" type="button">下一页</button></div><div class="language-actions"><button id="vocabulary-export-json" class="button subtle" type="button">导出 JSON</button><button id="vocabulary-export-csv" class="button subtle" type="button">导出 CSV</button></div></div>`;
    document.body.append(panel);
    let available=false,paperId=null,loadTicket=0,viewTicket=0,view='work',busy=false,draftReady=false,sourcePage=null,lastResult=null,historyOffset=0,wordOffset=0,failedRequest=null,loadPromise=null,draftRevision=0,disposed=false;
    const status=(text,error=false)=>{$('language-status').textContent=text||'';$('language-status').classList.toggle('error',error);};
    const selected = ()=>{const s=getSelection();return s?.id===getPaper()?.id&&s.text ? s : null;};
    const draftValue=()=>({text:$('language-source').value,target_language:$('language-target').value,page:sourcePage,failed_request:failedRequest});
    function remember(){if(persistence&&paperId&&draftReady)return persistence.put(`language-draft:${paperId}`,draftValue()).catch(()=>{});return Promise.resolve();}
    function controls(){for(const id of ['language-translate','language-polish'])$(id).disabled=busy||!available||!paperId||!draftReady||paperId!==getPaper()?.id;$('language-target').disabled=busy||!draftReady;$('language-source').disabled=!draftReady||!paperId;}
    function show(next='work'){beforeOpen?.();++viewTicket;panel.hidden=false;view=next;for(const name of ['work','history','words']){$(`language-${name}`).hidden=name!==next;$(`language-tab-${name}`).setAttribute('aria-pressed',String(name===next));}if(next==='history')void history();if(next==='words')void words();controls();}
    function paperChanged(item){
      if(paperId===item?.id){$('language-paper').textContent=item?.title||'先打开一篇论文';if(loadPromise)return loadPromise;if(draftReady)return Promise.resolve();}
      remember();paperId=item?.id||null;const ticket=++loadTicket;++viewTicket;++draftRevision;draftReady=false;sourcePage=null;failedRequest=null;lastResult=null;historyOffset=0;
      $('language-paper').textContent=item?.title||'先打开一篇论文';$('language-source').value='';$('language-result').replaceChildren();$('language-history-list').replaceChildren();status('');controls();
      if(!paperId){loadPromise=null;return Promise.resolve();}
      loadPromise=(async()=>{
        try{const saved=await persistence?.get(`language-draft:${paperId}`);if(ticket!==loadTicket)return;if(saved&&typeof saved.text==='string'&&saved.text.length<=8000){$('language-source').value=saved.text;$('language-target').value=saved.target_language==='en'?'en':'zh-CN';sourcePage=Number.isInteger(saved.page)&&saved.page>0&&saved.page<=2000?saved.page:null;failedRequest=saved.failed_request||null;}draftReady=true;}
        catch(error){if(ticket===loadTicket){status(`草稿读取失败：${error.message}`,true);$('language-status').append(button('language-retry-draft','重新读取草稿',()=>void paperChanged(getPaper())));}}
        finally{if(ticket===loadTicket){loadPromise=null;controls();}}
        if(ticket===loadTicket&&!panel.hidden&&view==='history')void history();
      })();return loadPromise;
    }
    async function useSelection(mode){
      const item=getPaper();await paperChanged(item);if(item?.id!==paperId||item?.id!==getPaper()?.id)return;show();const s=selected();
      if(s&&draftReady){$('language-source').value=s.text;sourcePage=s.page;failedRequest=null;++draftRevision;remember();await generate(mode);}
      else{status('先在 PDF 中选择文字，或在下方输入内容。');$('language-source').focus();}
    }
    async function generate(mode){
      if(busy)return;const text=$('language-source').value.trim();if(!paperId||paperId!==getPaper()?.id||!text){status('请先打开对应论文并输入或选择要处理的文字。',true);return;}
      if(!available){status('请从 DSH 文献库面板打开，使用这篇论文的模型。',true);return;}
      if(!draftReady){status('草稿尚未读取完成，请稍后重试。',true);return;}
      const id=paperId,target_language=$('language-target').value,ticket=loadTicket,revision=draftRevision;
      const payload={id,mode,text,target_language,...(sourcePage?{page:sourcePage}:{})};
      const fingerprint=JSON.stringify(payload);const request_id=failedRequest?.fingerprint===fingerprint?failedRequest.request_id:window.crypto.randomUUID();
      failedRequest={fingerprint,request_id};const saved=remember();busy=true;controls();status(mode==='translate'?'正在翻译并整理难词…':'正在优化表述并整理难词…');
      try{
        await saved;await persistence?.flush();
        const result=await api('language_generate',{...payload,request_id});
        if(disposed||id!==paperId||ticket!==loadTicket||revision!==draftRevision){toast('语言处理已完成，结果已保存在原论文的记录中。');return;}
        failedRequest=null;remember();renderResult(result);status('结果与难词已保存在本机。');
      }catch(error){if(!disposed&&id===paperId&&ticket===loadTicket&&revision===draftRevision){if(error.code==='LANGUAGE_FAILED'||error.retry_with_new_request===true){failedRequest=null;remember();}status(`${error.message} 可点击同一操作重试。`,true);if(error.code==='LANGUAGE_PENDING'){$('language-status').append(button('language-new-attempt','重新发起（将再次调用模型）',()=>{failedRequest=null;remember();status('已准备新请求，点击翻译或优化表述后再次调用模型。');}));}}}
      finally{busy=false;controls();}
    }
    function renderResult(record){
      if(record.status!=='complete'){status('该记录尚未完整保存，请从本篇记录恢复。',true);return;}lastResult=record;const root=$('language-result');root.replaceChildren();
      const head=make('header',undefined,'language-result-heading');head.append(make('strong',record.mode==='polish'?'优化后的表述':'译文'),make('span','AI 生成 · 已保存','small muted'));root.append(head,make('p',record.result||'','language-answer'));
      if(record.explanation){const notes=make('details');notes.append(make('summary','表达说明'),make('p',record.explanation,'language-answer'));root.append(notes);}
      const source=make('details');source.append(make('summary','对应原文'),make('p',record.source_text||'','language-answer'));root.append(source);
      const model=record.model;root.append(make('p',`${record.page?`第 ${record.page} 页 · `:''}${model?`${model.provider} / ${model.model||model.id}`:''}`,'small muted'));
      if(record.vocabulary?.length){const vocab=make('div',undefined,'language-found-words');for(const word of record.vocabulary)vocab.append(make('span',typeof word==='string'?word:word.term,'chip'));root.append(vocab);}
      const actions=make('div',undefined,'language-actions');actions.append(button('language-copy','复制结果',()=>void copy(record.result||'')),button('language-discuss','带入论文对话',()=>{if(record.paper_id!==getPaper()?.id||record.paper_id!==paperId){status('请先回到这条结果对应的论文。',true);return;}const text=[record.mode==='polish'?'请根据下面的表述优化结果继续讨论。':'请根据下面的翻译结果继续讨论。',`原文：${record.source_text}`,`AI 结果：${record.result}`].join('\n\n');if(text.length>4000){status('内容超过对话草稿长度，请复制所需片段后放入论文对话。',true);return;}void Promise.resolve(prepareChat?.(text,{paperId:record.paper_id,page:record.page})).catch(error=>status(error.message,true));}),button('language-result-words','查看难词',()=>show('words')));root.append(actions);
    }
    async function copy(value){try{await navigator.clipboard.writeText(value);toast('已复制');}catch{status('复制不可用，请直接选择结果文字复制。',true);}}
    function pagination(kind,result,offset){const rows=result.items||result.records||[];const hasNext=result.hasMore??result.has_more??((result.next_offset!=null)||(rows.length===20&&result.total>offset+rows.length));$(`${kind}-prev`).disabled=offset===0;$(`${kind}-next`).disabled=!hasNext;$(`${kind}-range`).textContent=rows.length?`${offset+1}–${offset+rows.length}${Number.isInteger(result.total)?` / ${result.total}`:''}`:'0';return rows;}
    async function history(){
      const ticket=++viewTicket,id=paperId;if(!id){status('先打开一篇论文。');return;}
      try{
        const result=await api('language_history',{id,offset:historyOffset,limit:20});if(ticket!==viewTicket||id!==paperId||view!=='history'||panel.hidden)return;
        const rows=pagination('language-history',result,historyOffset),root=$('language-history-list');root.replaceChildren();
        if(!rows.length)root.append(make('p','还没有语言处理记录。选择一段文字开始。','language-empty'));
        for(const row of rows){
          const value=row.value||row,complete=value.status==='complete';
          const b=button('',`${value.mode==='polish'?'表述优化':'翻译'} · ${complete?'已完成':value.status==='committing'?'待完成保存':value.status==='failed'?'生成未完成':'生成状态待确认'} · ${value.page?`第 ${value.page} 页 · `:''}${new Date(value.created_at).toLocaleDateString('zh-CN')}`,()=>{
            show('work');
            if(complete){renderResult(value);return;}
            if($('language-source').value.trim()&&$('language-source').value.trim()!==value.source_text){status('当前仍有其他文字草稿，请先完成或清空后再恢复这条记录。',true);return;}
            $('language-source').value=value.source_text;sourcePage=value.page||null;++draftRevision;$('language-target').value=value.target_language==='en'?'en':'zh-CN';
            const payload={id:paperId,mode:value.mode,text:value.source_text,target_language:$('language-target').value,...(sourcePage?{page:sourcePage}:{})};
            failedRequest=value.status!=='failed'&&value.request_id?{request_id:value.request_id,fingerprint:JSON.stringify(payload)}:null;remember();
            $('language-result').replaceChildren();status(value.status==='committing'?'点击同一操作继续保存，复用已有模型结果。':'原文已恢复。再次点击操作会核对请求状态或发起新请求。');
          });b.className='language-history-row';b.append(make('span',(value.source_text||'').slice(0,170)),make('p',(complete?value.result:value.error||'点击恢复原文与处理状态').slice(0,190)));root.append(b);
        }
        status(result.truncated?'记录达到本次读取上限。':'记录保存在运行 DSH 的本机。');
      }catch(error){if(ticket===viewTicket)status(error.message,true);}
    }
    const filter=()=>({query:$('vocabulary-query').value.trim(),...($('vocabulary-status').value?{status:$('vocabulary-status').value}:{})});
    async function words(){if(panel.hidden||view!=='words')return;const ticket=++viewTicket;try{const result=await api('vocabulary_list',{...filter(),offset:wordOffset,limit:20});if(ticket!==viewTicket)return;const rows=pagination('vocabulary',result,wordOffset);const root=$('vocabulary-list');root.replaceChildren();if(!rows.length)root.append(make('p','这里会积累阅读中遇到的难词。翻译或优化一段文字后再来查看。','language-empty'));for(const raw of rows){const word=raw.value?{...raw.value,revision:raw.revision}:raw;root.append(wordCard(word));}status(result.truncated?'难词记录达到本次读取上限，请缩小检索范围。':'');}catch(error){if(ticket===viewTicket)status(error.message,true);}}
    function wordCard(word){
      const card=make('article',undefined,'vocabulary-card');card.dataset.wordId=word.id;const head=make('header');head.append(make('strong',word.term),make('span',word.status==='mastered'?'已掌握':'待学习','chip'));card.append(head,make('p',word.meaning||''));
      const occurrences=word.encounters||word.occurrences||word.sources||[];const source=occurrences.at(-1)||word;const sentence=source.source_sentence||source.sentence||word.source_sentence;
      if(sentence)card.append(make('blockquote',sentence));
      const actions=make('div',undefined,'language-actions');
      const update=async patch=>{try{await api('vocabulary_update',{id:word.id,expected_revision:word.revision,...patch});await words();}catch(error){status(error.message,true);}};
      actions.append(button('',word.status==='mastered'?'重新学习':'标记已掌握',()=>void update({status:word.status==='mastered'?'learning':'mastered'})));
      if(source.paper_id&&source.page)actions.append(button('','回到原文 ↗',()=>void openReference({paperId:source.paper_id,page:source.page})));
      const details=make('details');details.append(make('summary','编辑释义'));const input=make('textarea');input.value=word.meaning||'';input.maxLength=2000;input.rows=3;input.setAttribute('aria-label',`${word.term} 的释义`);details.append(input,button('','保存释义',()=>void update({meaning:input.value})));card.append(actions,details);
      const remove=button('','删除',()=>{const confirm=button('','确认删除此词',async()=>{try{await api('vocabulary_delete',{id:word.id,expected_revision:word.revision});await words();}catch(error){status(error.message,true);}});remove.replaceWith(confirm);});actions.append(remove);return card;
    }
    async function exportWords(format){try{const result=await api('vocabulary_export',{...filter(),format});const content=result.content??result.text??JSON.stringify(result.items??result,null,2);const url=URL.createObjectURL(new Blob([typeof content==='string'?content:JSON.stringify(content,null,2)],{type:format==='csv'?'text/csv;charset=utf-8':'application/json'}));const a=make('a');a.href=url;a.download=`paper-library-vocabulary.${format}`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);if(result.truncated)status('导出达到本次上限，请缩小检索范围后继续。');}catch(error){status(error.message,true);}}
    $('language-close').addEventListener('click',()=>{remember();++viewTicket;panel.hidden=true;});
    for(const next of ['work','history','words'])$(`language-tab-${next}`).addEventListener('click',()=>show(next));
    $('language-translate').addEventListener('click',()=>void generate('translate'));$('language-polish').addEventListener('click',()=>void generate('polish'));
    $('language-source').addEventListener('input',()=>{sourcePage=null;failedRequest=null;++draftRevision;remember();});$('language-target').addEventListener('change',()=>{failedRequest=null;++draftRevision;remember();});
    for(const [kind,load]of [['language-history',history],['vocabulary',words]])for(const [direction,delta]of [['prev',-20],['next',20]])$(`${kind}-${direction}`).addEventListener('click',()=>{if(kind==='language-history')historyOffset=Math.max(0,historyOffset+delta);else wordOffset=Math.max(0,wordOffset+delta);void load();});
    let searchTimer;$('vocabulary-query').addEventListener('input',()=>{clearTimeout(searchTimer);searchTimer=setTimeout(()=>{wordOffset=0;void words();},250);});$('vocabulary-status').addEventListener('change',()=>{wordOffset=0;void words();});$('vocabulary-refresh').addEventListener('click',()=>void words());for(const format of ['json','csv'])$(`vocabulary-export-${format}`).addEventListener('click',()=>void exportWords(format));
    return {paperChanged,useSelection,show,close(){remember();++viewTicket;panel.hidden=true;},setAvailable(value){available=Boolean(value);controls();},sync(){controls();for(const id of ['language-selection-translate','language-selection-polish','ribbon-language'])if($(id))$(id).disabled=!getPaper();},dispose(){remember();disposed=true;clearTimeout(searchTimer);++loadTicket;++viewTicket;},snapshot:()=>({paperId,view,busy,lastResultId:lastResult?.id})};
  },
};
