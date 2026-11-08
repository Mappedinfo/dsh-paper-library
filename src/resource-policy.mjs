// 资源档位的唯一数值来源。内存是处理目标，不是整个宿主/浏览器 RSS 硬限额。
export const RESOURCE_FIELDS = Object.freeze({
  resource_memory_mb: {label:'处理内存目标（MiB）', minimum:128, maximum:2048, default:512},
  resource_preview_mb: {label:'结构预览缓存（MiB）', minimum:4, maximum:256, default:48},
  resource_batch_pages: {label:'每批主页面', minimum:1, maximum:6, default:2},
  resource_batch_gap_ms: {label:'扫描批次间隔（毫秒）', minimum:250, maximum:10000, default:1000},
  resource_paper_index_mb: {label:'每篇结构索引（MiB，磁盘）', minimum:4, maximum:512, default:64},
  resource_library_index_mb: {label:'全库结构索引（MiB，磁盘）', minimum:64, maximum:8192, default:1024},
  resource_disk_reserve_mb: {label:'磁盘保留空间（MiB）', minimum:128, maximum:4096, default:512},
});
const values = (memory,preview,pages,gap,paper,library,reserve) => Object.fromEntries(Object.keys(RESOURCE_FIELDS).map((key,i)=>[key,[memory,preview,pages,gap,paper,library,reserve][i]]));
export const RESOURCE_PROFILES = Object.freeze({
  eco:{label:'节能 · 256 MiB',values:values(256,16,1,2000,16,256,256)},
  balanced:{label:'均衡 · 512 MiB',values:values(512,48,2,1000,64,1024,512)},
  performance:{label:'高性能 · 1024 MiB',values:values(1024,96,4,500,128,4096,1024)},
});
export const RESOURCE_DEFAULTS = Object.freeze({resource_profile:'balanced',...RESOURCE_PROFILES.balanced.values});
export function validateResourceSettings(value) {
  if(!['eco','balanced','performance','custom'].includes(value.resource_profile))throw new Error('请选择有效的资源档位。');
  for(const [key,rule]of Object.entries(RESOURCE_FIELDS))if(!Number.isSafeInteger(value[key])||value[key]<rule.minimum||value[key]>rule.maximum)throw new Error(`${rule.label}需要 ${rule.minimum}–${rule.maximum} 的整数。`);
  if(value.resource_profile==='custom'&&value.resource_preview_mb>value.resource_memory_mb/4)throw new Error('结构预览缓存不能超过处理内存目标的四分之一。');
  if(value.resource_profile==='custom'&&value.resource_paper_index_mb>value.resource_library_index_mb)throw new Error('每篇结构索引预算不能超过全库预算。');
  return value;
}
export function resolveResourcePolicy(settings={}) {
  const selected={...RESOURCE_DEFAULTS,...Object.fromEntries(Object.entries(settings).filter(([k])=>k in RESOURCE_DEFAULTS))};
  validateResourceSettings(selected);
  const v=selected.resource_profile==='custom'?selected:RESOURCE_PROFILES[selected.resource_profile].values;
  const MiB=1048576,memory=v.resource_memory_mb;
  return {profile:selected.resource_profile,values:{...v},memory_target_mb:memory,memory_hard_limit:false,
    preview_bytes:v.resource_preview_mb*MiB,preview_count:Math.min(96,Math.max(12,v.resource_preview_mb)),
    batch_pages:v.resource_batch_pages,batch_gap_ms:v.resource_batch_gap_ms,idle_ms:1200,
    worker_idle_ms:Math.min(750,Math.max(250,Math.round(v.resource_batch_gap_ms/2))),
    page_limit_bytes:Math.min(8,Math.max(2,memory/128))*MiB,
    index_limit_bytes:v.resource_paper_index_mb*MiB,library_index_limit_bytes:v.resource_library_index_mb*MiB,
    disk_reserve_bytes:v.resource_disk_reserve_mb*MiB,source_limit_bytes:memory/4*MiB,
    stream_limit_bytes:Math.max(4,memory/64)*MiB,decoded_limit_bytes:Math.max(8,memory/32)*MiB,
    image_pixels:memory*32768};
}
// 每个设置服务最多缓存一份快照；原生/本地设置通知立即失效，旧宿主最多滞后 2 秒。
const cached = new WeakMap();
export async function resourcePolicyFor(options={}) {
  if(!options.settings?.get)return resolveResourcePolicy(options.resourceSettings||{});
  const service=options.settings;let state=cached.get(service);
  if(!state){state={value:null,expires:0,pending:null,epoch:0};cached.set(service,state);service.subscribe?.(()=>{state.expires=0;state.value=null;state.pending=null;state.epoch++;});}
  if(state.value&&Date.now()<state.expires)return state.value;
  if(state.pending)return state.pending;
  const epoch=state.epoch;
  const pending=service.get().then(d=>{const policy=d.resource_policy||resolveResourcePolicy(d.value);if(state.epoch===epoch){state.value=policy;state.expires=Date.now()+2000;}return policy;});state.pending=pending;
  try{return await pending;}finally{if(state.pending===pending)state.pending=null;}
}
