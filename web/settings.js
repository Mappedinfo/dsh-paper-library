'use strict';
window.PaperLibrarySettings = (() => {
  const fields = [
    ['auto_analysis', '选中文献后自动整理', '只处理新选中的、尚无整理记录的 PDF；会使用本篇模型额度。'],
    ['analysis_fill', '整理完成后补齐空缺资料', '有原文依据才补缺，保留已有资料；AI 填入内容仍待核对。'],
    ['auto-paper-conversation', '保存批注后自动发送到论文对话', '新保存的批注会发送并使用模型额度。关闭时由你选择材料后发送。'],
  ];
  function create({api,persistence,onChange=()=>{},getLibrary=()=>''}) {
    let snapshot=null,busy=false,refreshing=null,refreshAgain=false,disposed=false,timer=null,pendingPatch=null,visibleTimer=null,generation=0,readingPreferences=0;
    const make=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n;};
    const trigger=make('button','button subtle','设置');trigger.id='settings-open';trigger.type='button';trigger.title='Paper Library 设置';
    document.querySelector('.topbar-actions').append(trigger);
    const dialog=make('dialog','library-settings');dialog.id='library-settings';dialog.setAttribute('aria-labelledby','library-settings-title');
    const header=make('header'),title=make('strong','','Paper Library 设置');title.id='library-settings-title';
    const close=make('button','icon-button','×');close.type='button';close.setAttribute('aria-label','关闭设置');close.addEventListener('click',()=>dialog.close());header.append(title,close);
    const description=make('p','settings-description','DSH 中的入口：设置 → 插件 → 插件配置 → Paper Library。');
    const status=make('p','settings-status');status.id='settings-status';status.setAttribute('role','status');
    const controls=make('fieldset'),legend=make('legend','','阅读与自动化');controls.append(legend);
    const inputs=new Map();
    for(const [key,label,help] of fields){const row=make('label','settings-option'),input=make('input');input.type='checkbox';input.id=`setting-${key}`;const copy=make('span');copy.append(make('strong','',label),make('small','',help));row.append(input,copy);controls.append(row);inputs.set(key,input);input.addEventListener('change',()=>void save({[key]:input.checked}));}
    const sideRow=make('label','settings-side'),side=make('select');side.id='setting-reading-panel-side';side.setAttribute('aria-label','阅读侧栏位置');for(const [value,label]of[['left','左侧'],['right','右侧']]){const option=make('option','',label);option.value=value;side.append(option);}sideRow.append(make('span','','阅读侧栏'),side);controls.append(sideRow);inputs.set('reading-panel-side',side);side.addEventListener('change',()=>void save({'reading-panel-side':side.value}));
    const storage=make('details','settings-storage'),summary=make('summary','','模型、外观与存储');storage.append(summary,make('p','','模型沿用每篇论文的 DSH 对话；主题与字号跟随 DSH 外观设置。'));
    const path=make('p','settings-path');storage.append(path,make('p','','文献、PDF、草稿和设置均保存在主机磁盘，不写入浏览器 localStorage。更换资料库目录需要修改部署配置，已有数据不会自动搬迁。'));
    const footer=make('footer'),reload=make('button','button subtle','重新读取'),reset=make('button','button subtle','恢复默认');reload.type=reset.type='button';reload.addEventListener('click',()=>void refresh());reset.addEventListener('click',()=>void save(null));footer.append(reload,reset);
    dialog.append(header,description,status,controls,storage,footer);document.body.append(dialog);
    function say(text,error=false){status.textContent=text;status.classList.toggle('error',error);}
    function render(){
      controls.disabled=busy||!snapshot?.writable;reset.disabled=busy||!snapshot?.writable;reload.disabled=busy;
      const shown={...snapshot?.value,...pendingPatch};
      for(const[key,input]of inputs){if(input.type==='checkbox')input.checked=shown[key]===true;else input.value=shown[key]||'left';}
      path.textContent=`资料库：${getLibrary()||'正在读取…'}`;
      description.textContent=snapshot?.backend==='dsh'&&snapshot.available===false?'设置由 DSH 管理。请在 DSH 的 Paper Library 面板或「设置 → 插件 → 插件配置」中修改。':snapshot?.backend==='local'?'独立运行：设置保存在本机。安装到 DSH 后，插件设置会接入 DSH 的统一设置。':'DSH 中的入口：设置 → 插件 → 插件配置 → Paper Library。两个入口共享同一份主机设置。';
    }
    function drainRefresh(){if(refreshAgain&&!disposed&&!busy&&!refreshing){refreshAgain=false;queueMicrotask(()=>void refresh());}}
    async function syncPreferences(){readingPreferences++;try{await persistence?.get('preferences');}finally{readingPreferences--;}}
    async function refresh(){
      if(disposed)return;if(busy){refreshAgain=true;return;}if(refreshing){generation++;refreshAgain=true;return refreshing;}
      clearTimeout(timer);const ticket=generation;
      refreshing=(async()=>{try{const result=await api('settings_get');if(disposed||ticket!==generation)return;
        // Advance the legacy inline controls' CAS snapshot after a native edit.
        // Only preferences are touched; open note/chat drafts stay intact.
        await syncPreferences();if(disposed||ticket!==generation)return;snapshot=result;onChange(result.value||{},result);render();say(result.available===false?'当前页面未连接 DSH 设置服务。':'已与主机设置同步');
      }catch(error){if(!disposed&&ticket===generation){snapshot=null;onChange({},{writable:false,available:false});render();say(`设置读取失败：${error.message}`,true);}}finally{refreshing=null;drainRefresh();}})();return refreshing;
    }
    async function save(patch){
      if(disposed||busy||!snapshot?.writable){render();return;}busy=true;generation++;clearTimeout(timer);pendingPatch=patch;render();say('正在保存…');
      try{const result=await api(patch?'settings_update':'settings_reset',{...(patch?{patch}:{}),expected_revision:snapshot.revision});
        if(disposed)return;await syncPreferences();if(disposed)return;snapshot=result;onChange(result.value||{},result);
        const confirmed=patch?Object.entries(patch).every(([key,value])=>result.value?.[key]===value):[...inputs.keys()].every(key=>!Object.hasOwn(result.user||{},key));
        if(!confirmed)throw new Error('设置已被另一窗口更新');
        say(result.backend==='dsh'?'已保存到主机，DSH 设置同步生效':'已保存到本机');
      }catch(error){if(!disposed)say(`未保存：${error.message}。请重新读取后再修改。`,true);}
      finally{busy=false;pendingPatch=null;if(!disposed)render();drainRefresh();}
    }
    const schedule=()=>{if(disposed)return;if(busy||refreshing){if(refreshing)generation++;refreshAgain=true;return;}clearTimeout(timer);timer=setTimeout(()=>void refresh(),50);};
    // Reading the CAS mirror emits "saved" itself; it is not a new Host
    // invalidation. Native/focus events still queue a trailing refresh while
    // either the document request or this mirror read is pending.
    const unsubscribe=persistence?.subscribe(event=>{if(!readingPreferences&&event.key==='preferences'&&event.status==='saved')schedule();});
    function receive(event){const v=event.data;if(window.parent===window||event.source!==window.parent||event.origin!==window.location.origin||v?.type!=='paper-library:settings-changed'||v.version!==1||v.namespace!=='paper-library'||!Number.isSafeInteger(v.revision))return;schedule();}
    const focus=()=>{if(!document.hidden)schedule();};window.addEventListener('message',receive);window.addEventListener('focus',focus);document.addEventListener('visibilitychange',focus);
    trigger.addEventListener('click',()=>{if(!dialog.open)dialog.showModal();void refresh();clearInterval(visibleTimer);visibleTimer=setInterval(()=>{if(dialog.open&&!document.hidden)schedule();},3000);});
    dialog.addEventListener('close',()=>{clearInterval(visibleTimer);visibleTimer=null;});
    if(window.parent!==window)window.parent.postMessage({type:'paper-library:settings-ready',version:1},window.location.origin);
    render();
    return {refresh,dispose(){disposed=true;clearTimeout(timer);clearInterval(visibleTimer);unsubscribe?.();window.removeEventListener('message',receive);window.removeEventListener('focus',focus);document.removeEventListener('visibilitychange',focus);}};
  }
  return {create};
})();
