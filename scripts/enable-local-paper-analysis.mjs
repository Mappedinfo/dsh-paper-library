/** Explicit local setup: enable import/selection analysis and fill-only metadata.
 * Uses the authenticated native settings API and its revision fence. Credentials
 * remain in memory; the optional receipt contains only these two choices.
 */
import assert from 'node:assert/strict'
import {readFile,writeFile} from 'node:fs/promises'

const flags=new Map()
for(let i=2;i<process.argv.length;i+=2)flags.set(process.argv[i],process.argv[i+1])
const port=Number(flags.get('--port')),log=flags.get('--log')
assert.ok(log&&Number.isInteger(port)&&port>0&&port<65536,'Usage: --log PRIVATE_HOST_LOG --port PORT [--output RECEIPT]')
const contents=await readFile(log,'utf8')
const address=[...contents.matchAll(/https?:\/\/[^\s]+/g)].reverse().map(match=>{try{return new URL(match[0])}catch{return null}}).find(url=>url?.protocol==='http:'&&url.hostname==='127.0.0.1'&&Number(url.port)===port&&url.searchParams.has('token'))
assert.ok(address,'No matching loopback startup address in host log')
const exchange=await fetch(address,{redirect:'manual',signal:AbortSignal.timeout(10000)})
assert.equal(exchange.status,303,'Host authentication exchange failed')
const cookie=exchange.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ')
assert.ok(cookie,'Host did not issue a session cookie')
const headers={Cookie:cookie,Origin:address.origin,'Content-Type':'application/json'}
async function api(input){
  const response=await fetch(`${address.origin}/api/paper-library/api`,{method:'POST',headers,body:JSON.stringify(input),signal:AbortSignal.timeout(10000)})
  assert.equal(response.status,200,'Native settings operation failed; inspect the host before retrying')
  const data=await response.json();assert.equal(data.ok,true,'Native settings operation was rejected')
  return data.result
}
const before=await api({action:'settings_get'})
assert.equal(before.namespace,'paper-library');assert.equal(before.backend,'dsh');assert.equal(before.available,true);assert.equal(before.writable,true)
const patch={auto_analysis:true,analysis_fill:true}
const changed=Object.keys(patch).some(key=>before.value[key]!==patch[key])
if(changed)await api({action:'settings_update',patch,expected_revision:before.revision})
const after=await api({action:'settings_get'})
for(const [key,value]of Object.entries(patch))assert.equal(after.value[key],value)
for(const [key,value]of Object.entries(before.value))if(!(key in patch))assert.deepEqual(after.value[key],value,'An unrelated preference changed concurrently; inspect before retrying')
const report={verified_at:new Date().toISOString(),ok:true,backend:'dsh',changed,auto_analysis:after.value.auto_analysis,analysis_fill:after.value.analysis_fill,otherPreferencesPreserved:true,privateDocumentsRead:false,modelRequestsMadeByScript:0}
if(flags.get('--output'))await writeFile(flags.get('--output'),JSON.stringify(report,null,2)+'\n')
console.log(JSON.stringify(report))
