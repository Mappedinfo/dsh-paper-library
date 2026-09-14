'use strict';
// Durable state belongs to the local service. This client holds only a bounded
// working set and never resolves a cross-browser conflict by overwriting it.
window.PaperLibraryLocalState = (() => {
  const LIMIT=256*1024, WORKING_KEYS=32;
  const copy=value=>value===undefined?null:JSON.parse(JSON.stringify(value));
  const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
  const byteLength=value=>new TextEncoder().encode(JSON.stringify(value)).byteLength;
  function create({api,onError}) {
    const entries=new Map(),listeners=new Set();
    function emit(entry,status,error=null){entry.status=status;entry.error=error;for(const fn of listeners)fn({key:entry.key,status,error});if(error)onError?.(error,{key:entry.key,status});}
    function trim(){for(const [key,entry] of entries){if(entries.size<=WORKING_KEYS)break;if(!entry.dirty&&!entry.running&&!entry.loading)entries.delete(key);}}
    function entryFor(key){
      if(typeof key!=='string'||!key||key.length>240)throw new Error('本地状态名称无效');
      let entry=entries.get(key);
      if(!entry){trim();if(entries.size>=WORKING_KEYS&&[...entries.values()].every(v=>v.dirty||v.running||v.loading))throw new Error('有过多草稿等待保存，请先恢复本地服务连接。');entry={key,value:null,revision:0,loaded:false,loading:null,running:null,dirty:false,sequence:0,waiters:[],status:'idle',error:null};}
      entries.delete(key);entries.set(key,entry);return entry;
    }
    function validate(record,key){if(!record||record.key!==key||!(record.revision===0||typeof record.revision==='string'&&/^[a-f0-9]{64}$/.test(record.revision))||!Object.hasOwn(record,'value'))throw new Error('本地服务返回了无效的状态记录');return record;}
    async function load(entry,refresh=false){
      if(entry.dirty)return entry;
      if(entry.loading){await entry.loading;return entry;}
      if(entry.loaded&&!refresh)return entry;
      const sequence=entry.sequence;
      entry.loading=(async()=>{try{const record=validate(await api('state_get',{key:entry.key}),entry.key);if(sequence===entry.sequence&&!entry.dirty){entry.value=copy(record.value);entry.revision=record.revision;entry.loaded=true;emit(entry,'saved');}}catch(error){emit(entry,'error',error);throw error;}finally{entry.loading=null;trim();}})();
      await entry.loading;return entry;
    }
    function settle(entry,through,error){const rest=[];for(const waiter of entry.waiters){if(waiter.sequence<=through){if(error)waiter.reject(error);else waiter.resolve(copy(entry.value));}else rest.push(waiter);}entry.waiters=rest;}
    function conflict(entry){const error=new Error('另一浏览器已修改这份资料。本窗口的未保存内容仍保留，请先复制并核对修改后再重试。');error.code='STATE_CONFLICT';entry.conflict=true;emit(entry,'conflict',error);return error;}
    function run(entry){
      if(entry.running||!entry.dirty||entry.conflict)return entry.running||Promise.resolve();
      entry.running=Promise.resolve().then(async()=>{
        if(!entry.loaded){
          try{const remote=validate(await api('state_get',{key:entry.key}),entry.key);if(remote.value!==null&&!equal(remote.value,entry.value)){settle(entry,Infinity,conflict(entry));return;}entry.revision=remote.revision;entry.loaded=true;if(equal(remote.value,entry.value)){entry.dirty=false;settle(entry,Infinity,null);emit(entry,'saved');return;}}
          catch(error){emit(entry,'error',error);settle(entry,Infinity,error);return;}
        }
        while(entry.dirty&&!entry.conflict){
          const value=copy(entry.value),sequence=entry.sequence,expected=entry.revision;let record;
          // Set keepalive before dispatch: pagehide cannot retrofit an in-flight
          // ordinary fetch. Larger writes need the page to remain connected.
          const payload={key:entry.key,value,expected_revision:expected};
          try{record=validate(await api('state_put',payload,{keepalive:byteLength(payload)<60000}),entry.key);if(!equal(record.value,value))throw new Error('本地服务未确认这次保存');}
          catch(error){
            // A response can be lost after an atomic write. Read back once before
            // retrying the same revision; different remote content is a conflict.
            let remote;try{remote=validate(await api('state_get',{key:entry.key}),entry.key);}catch{}
            if(remote&&remote.revision!==expected&&equal(remote.value,value))record=remote;
            else{const isConflict=remote&&remote.revision!==expected||error.status===409||/CONFLICT/i.test(error.code||'');const failure=isConflict?conflict(entry):error;if(!isConflict)emit(entry,'error',failure);settle(entry,Infinity,failure);return;}
          }
          entry.revision=record.revision;entry.loaded=true;entry.dirty=entry.sequence>sequence;settle(entry,sequence,null);emit(entry,entry.dirty?'pending':'saved');
        }
      }).finally(()=>{entry.running=null;trim();if(entry.dirty&&!entry.error&&!entry.conflict)void run(entry);});
      return entry.running;
    }
    async function update(key,value,merge){
      const entry=entryFor(key);
      try{await load(entry);}catch(error){const pending=merge?{...(entry.value||{}),...copy(value)}:copy(value);if(byteLength(pending)>LIMIT)throw new Error('这份草稿超过 256 KiB，请缩短内容后保存。');entry.value=pending;entry.dirty=true;++entry.sequence;emit(entry,'error',error);throw error;}
      const next=merge?{...(entry.value&&typeof entry.value==='object'&&!Array.isArray(entry.value)?entry.value:{}),...copy(value)}:copy(value);
      if(byteLength(next)>LIMIT)throw new Error('这份草稿超过 256 KiB，请缩短内容后保存。');
      if(equal(entry.value,next)&&!entry.dirty)return copy(entry.value);
      entry.value=next;entry.dirty=true;const sequence=++entry.sequence;
      if(entry.conflict){const error=conflict(entry);throw error;}
      emit(entry,'pending');const pending=new Promise((resolve,reject)=>entry.waiters.push({sequence,resolve,reject}));void run(entry);return pending;
    }
    async function get(key){const entry=entryFor(key);await load(entry,true);return copy(entry.value);}
    async function flush(_options={}){
      await Promise.all([...entries.values()].map(async entry=>{if(entry.loading)await entry.loading;if(entry.dirty&&!entry.conflict)await run(entry);if(entry.error)throw entry.error;}));
    }
    async function migrateLegacy(getLibrary){
      let legacy;try{legacy=window.localStorage;}catch{return {migrated:0,backedUp:0,retained:0};}if(!legacy)return {migrated:0,backedUp:0,retained:0};
      const library=typeof getLibrary==='function'?getLibrary():getLibrary,base=`paper-library:${library||'default'}:`,report={migrated:0,backedUp:0,retained:0};
      const read=key=>{try{return legacy.getItem(key);}catch{return null;}};
      async function move(key,value){const existing=await get(key);if(existing!==null&&!equal(existing,value)||existing===null&&entries.get(key)?.revision!==0)return false;if(existing===null)await update(key,value,false);return equal(await get(key),value);}
      async function remove(key,verified){
        if(!verified){
          const raw=read(key);if(raw===null)return;
          let value;try{value=JSON.parse(raw);}catch{value=raw;}
          const bytes=await window.crypto.subtle.digest('SHA-256',new TextEncoder().encode(key+'\n'+raw));
          const backupKey='migration:'+Array.from(new Uint8Array(bytes),byte=>byte.toString(16).padStart(2,'0')).join('');
          if(!await move(backupKey,{source_key:key,value,conflict:true})){report.retained++;return;}
          report.backedUp++;
        }
        try{legacy.removeItem(key);report.migrated++;}catch{report.retained++;}
      }
      for(const [suffix,field,parse] of [['auto-feedback','auto-feedback',v=>v==='true'],['model','model',v=>v],['auto-paper-conversation','auto-paper-conversation',v=>v==='true']]){
        const oldKey=base+suffix,raw=read(oldKey);if(raw===null)continue;
        try{const saved=await get('preferences'),prefs=saved||{},value=parse(raw);if(saved===null&&entries.get('preferences')?.revision!==0||Object.hasOwn(prefs,field)&&!equal(prefs[field],value)){await remove(oldKey,false);continue;}await update('preferences',{[field]:value},true);await remove(oldKey,equal((await get('preferences'))?.[field],value));}catch{report.retained++;}
      }
      const sideKey='paper-library:reading-panel-side:v1',side=read(sideKey);
      if(side==='left'||side==='right')try{const saved=await get('preferences'),prefs=saved||{};if(saved===null&&entries.get('preferences')?.revision!==0||prefs['reading-panel-side']!==undefined&&prefs['reading-panel-side']!==side)await remove(sideKey,false);else{await update('preferences',{'reading-panel-side':side},true);await remove(sideKey,(await get('preferences'))?.['reading-panel-side']===side);}}catch{report.retained++;}
      for(const [suffix,prefix] of [['paper-drafts-v2','chat:'],['metadata-drafts-v1','metadata:']]){
        const oldKey=base+suffix,raw=read(oldKey);if(raw===null)continue;
        try{if(raw.length*2>LIMIT)throw new Error('旧草稿过大');const list=JSON.parse(raw);if(!Array.isArray(list)||list.length>12)throw new Error('旧草稿格式无效');let all=true;for(const entry of list){if(!Array.isArray(entry)||typeof entry[0]!=='string'||entry[0].length>160||!entry[1]||typeof entry[1]!=='object')throw new Error('旧草稿格式无效');if(!await move(prefix+(entry[0]==='@new'?'new':entry[0]),entry[1]))all=false;}await remove(oldKey,all);}catch{report.retained++;}
      }
      if(report.backedUp)onError?.(new Error(`${report.backedUp} 份旧浏览器数据与现有资料不同，已单独备份到本地服务，可导出旧草稿核对。`),{status:'migration-backup',count:report.backedUp});
      if(report.retained)onError?.(new Error('部分旧浏览器草稿与本地服务内容不同或未能迁移，已保留原数据；请核对后再清理。'),{status:'migration-retained'});
      return report;
    }
    return {get,put:(key,value)=>update(key,value,false),patch:(key,value)=>update(key,value,true),flush,migrateLegacy,
      exportPending:()=>[...entries.values()].filter(entry=>entry.dirty).map(entry=>({key:entry.key,value:copy(entry.value),...(entry.error?{error:entry.error.message}:{})})),
      subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);},status:key=>{const entry=entries.get(key);return entry?{status:entry.status,error:entry.error,dirty:entry.dirty}:{status:'idle',dirty:false};},
      async retry(key){const entry=entryFor(key);if(entry.conflict)throw entry.error;if(entry.dirty)await run(entry);if(entry.error)throw entry.error;return copy(entry.value);},
      // The caller must explicitly choose a reconciled value before invoking this.
      async reconcile(key,value){const entry=entryFor(key);if(entry.running)await entry.running;const remote=validate(await api('state_get',{key}),key);entry.revision=remote.revision;entry.conflict=false;entry.error=null;entry.loaded=true;return update(key,value,false);},
    };
  }
  return {create,byteLength};
})();
