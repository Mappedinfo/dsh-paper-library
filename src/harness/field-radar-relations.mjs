/** Bounded JSON imports; supplied HTML and JavaScript are never executed. */
import '../../web/field-radar-relations-renderer.js';
import { createHash } from 'node:crypto';
import { LocalStateConflictError } from '../local-state.mjs';
const hash = x => createHash('sha256').update(x).digest('hex');
const invalid = message => { throw Object.assign(new Error(message), {code:'FIELD_RADAR_RELATIONS_INVALID',status:400}); };
export const RELATIONS_MAX_BYTES = 1024 * 1024;
export function validateRelations(input) {
 const json=JSON.stringify(input);if(!json||Buffer.byteLength(json)>RELATIONS_MAX_BYTES)invalid('Relations JSON exceeds 1 MiB');
 const d=JSON.parse(json),queue=[{v:d,depth:0}];let count=0;
 while(queue.length){const {v,depth}=queue.pop();if(++count>40000||depth>20)invalid('Relations nesting limit');if(typeof v==='string'&&v.length>12000)invalid('Relations string limit');if(v&&typeof v==='object')for(const [k,x]of Object.entries(v)){if(['__proto__','constructor','prototype'].includes(k))invalid('Unsafe key');if(k==='color'&&!/^#[a-fA-F0-9]{6}$/.test(x))invalid('Color must be six-digit hex');if(k==='url'||k.endsWith('_url')){let u;try{u=new URL(x);}catch{invalid('Invalid source URL');}if(!['http:','https:'].includes(u.protocol)||u.username||u.password)invalid('Source URL must be HTTP(S) without credentials');}queue.push({v:x,depth:depth+1});}}
 if(!Array.isArray(d.dimensions)||d.dimensions.length<2||d.dimensions.length>6||!Array.isArray(d.records)||d.records.length<1||d.records.length>200||!Array.isArray(d.sources)||d.sources.length>1000||(d.relationships?.length??0)>500)invalid('Relations collection limit');
 const identifier=x=>{if(typeof x!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$/.test(x))invalid('Invalid relation identifier');};
 for(const row of [...d.dimensions,...d.records,...d.sources])identifier(row.id);
 for(const dim of d.dimensions){if(!Array.isArray(dim.categories)||!dim.categories.length||dim.categories.length>24)invalid('Category limit');for(const c of dim.categories)identifier(c.id);if(dim.code!=null&&!/^[A-Za-z0-9]{1,4}$/.test(dim.code))invalid('Invalid dimension code');}
 for(const r of d.records)if(typeof r.title!=='string'||!r.title.trim())invalid('Record title missing');
 if(d.config?.circular_order_by?.some(x=>!d.dimensions.some(dim=>dim.id===x)))invalid('Unknown sort dimension');
 let radius=775;for(const dim of d.dimensions){const multi=d.records.some(r=>Array.isArray(r.values?.[dim.id])&&r.values[dim.id].length>1);radius-=(multi?dim.categories.length*Math.max(13,Math.min(18,210/dim.categories.length)):44)+11;}if(radius<80)invalid('Too many circular tracks; narrow dimensions or categories');
 try{return globalThis.PaperRadarRelationsRenderer.validateInput(d);}catch(e){invalid(e.message);}
}
export function createRelationsStore(store){
 const key='field-radar-relations:current';
 async function get(){const m=await store.get(key);if(!m.value)return {document:null,revision:0};const {chunks,digest}=m.value;if(!Array.isArray(chunks)||chunks.length>12||!/^[a-f0-9]{64}$/.test(digest))invalid('Corrupt relations manifest');const parts=[];for(const chunk of chunks){if(!/^[a-f0-9]{64}$/.test(chunk))invalid('Corrupt chunk id');const r=await store.get('field-radar-relations-chunk:'+chunk);if(typeof r.value?.data!=='string'||r.value.data.length>160000||hash(r.value.data)!==chunk)invalid('Corrupt relations chunk');parts.push(Buffer.from(r.value.data,'base64'));}const bytes=Buffer.concat(parts);if(bytes.length>RELATIONS_MAX_BYTES||hash(bytes)!==digest)invalid('Corrupt relations digest');return {document:validateRelations(JSON.parse(bytes)),revision:m.revision,updated_at:m.updated_at,digest};}
 async function importDocument(input){const document=validateRelations(input.document),current=await store.get(key);if(current.revision!==input.expected_revision)throw new LocalStateConflictError({revision:current.revision});const bytes=Buffer.from(JSON.stringify(document)),digest=hash(bytes),chunks=[];for(let i=0;i<bytes.length;i+=120000){const data=bytes.subarray(i,i+120000).toString('base64'),chunk=hash(data),k='field-radar-relations-chunk:'+chunk;chunks.push(chunk);const old=await store.get(k);if(!old.value){try{await store.put(k,{data},0);}catch(e){if(e.code!=='STATE_CONFLICT'||(await store.get(k)).value?.data!==data)throw e;}}else if(old.value.data!==data)invalid('Chunk collision');}const saved=await store.put(key,{chunks,digest,records:document.records.length},input.expected_revision);return {revision:saved.revision,digest,records:document.records.length,updated_at:saved.updated_at};}
 return {get,importDocument};
}
