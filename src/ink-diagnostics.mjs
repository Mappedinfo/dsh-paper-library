/** Bounded local event history. Never store document text, paths or pen geometry. */
const KEY = 'ink-diagnostics:recent', LIMIT = 256;
const EVENTS = new Set(['stroke_start','stroke_end','stroke_cancel','input_blocked','draft_clear','draft_restore','overlay_update','overlay_retire','page_install','page_defer','draft_changed','batch_freeze','batch_accepted','batch_saved','queue_status','queue_error']);
const NUMBERS = ['page','strokes','points','revision','count'];
const IDS = ['paperId','annotationId'];
function sanitize(event) {
  if (!event || !EVENTS.has(event.event)) return null;
  const result = {event:event.event};
  if (typeof event.client === 'string' && /^[a-f0-9-]{8,64}$/.test(event.client)) result.client=event.client;
  for (const key of IDS) if (typeof event[key] === 'string' && /^[a-f0-9-]{8,64}$/.test(event[key])) result[key]=event[key];
  for (const key of NUMBERS) if (Number.isSafeInteger(event[key]) && event[key]>=0 && event[key]<=10000000) result[key]=event[key];
  for (const key of ['reason','status']) if (typeof event[key] === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(event[key])) result[key]=event[key];
  if (['pen','mouse','touch','unknown'].includes(event.pointerType)) result.pointerType=event.pointerType;
  if (Number.isSafeInteger(event.time) && event.time>0) result.time=event.time;
  return result;
}
function storedEvents(value) {
  return (Array.isArray(value?.events)?value.events:[]).slice(-LIMIT).map(event=>{
    const clean=sanitize(event);if(!clean)return null;
    if(Number.isSafeInteger(event.receivedAt)&&event.receivedAt>0)clean.receivedAt=event.receivedAt;
    return clean;
  }).filter(Boolean);
}
export function createInkDiagnostics({store}) {
  let serial=Promise.resolve();
  async function append(events) {
    if (!Array.isArray(events) || events.length>32) throw Object.assign(new Error('手写诊断每次最多 32 条事件。'),{status:400});
    const receivedAt=Date.now(), clean=events.map(sanitize).filter(Boolean).map(event=>({...event,receivedAt}));
    if (!clean.length) return {accepted:0};
    for (let attempt=0;attempt<4;attempt++) {
      const record=await store.get(KEY), previous=storedEvents(record.value);
      const next={schema:1,events:[...previous,...clean].slice(-LIMIT)};
      try {await store.put(KEY,next,record.revision);return {accepted:clean.length};}
      catch(error){if(error.code!=='STATE_CONFLICT'||attempt===3)throw error;}
    }
  }
  return {
    handle(input) {
      if(input.action==='ink_diagnostics_get')return store.get(KEY).then(record=>({schema:1,limit:LIMIT,events:storedEvents(record.value)}));
      if(input.action!=='ink_diagnostics_append')throw new Error('未知手写诊断操作。');
      const pending=serial.catch(()=>{}).then(()=>append(input.events));serial=pending;return pending;
    }
  };
}
