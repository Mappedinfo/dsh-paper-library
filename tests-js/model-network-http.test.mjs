import test from 'node:test'
import assert from 'node:assert/strict'
import { createFetchHandler } from '../src/http.mjs'
const post=(handler,input,origin='http://localhost')=>handler(new Request('http://localhost/api',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify(input)}))

test('network diagnostics pass the request signal; translation uses only a fixed synthetic sentence',async()=>{
 const calls=[]
 const handler=createFetchHandler({
   modelNetwork:{describe:async()=>({available:true}),probe:async(provider,signal)=>{calls.push({provider,signal});return{reachable:false,message:'synthetic timeout'}}},
   languageLearning:Object.assign(async()=>({}),{translateAbstract:async(input,options)=>{calls.push({input,signal:options.signal});return{text:'合成测试译文',model:{provider:'fixture',model:'synthetic'}}}}),
 })
 assert.equal((await post(handler,{action:'model_network_get'})).status,200)
 const probe=await post(handler,{action:'model_network_probe',provider:'deepseek'});assert.equal(probe.status,200);assert.equal(calls.at(-1).provider,'deepseek');assert.ok(calls.at(-1).signal instanceof AbortSignal)
 const translated=await post(handler,{action:'model_translation_probe',text:'untrusted private text',id:'forged-paper'});assert.equal(translated.status,200)
 assert.deepEqual(calls.at(-1).input,{text:'This study compares two methods.',target:'zh-CN'})
 assert.equal((await post(handler,{action:'model_translation_probe'},'https://evil.invalid')).status,403);assert.equal(calls.length,2)
})

test('standalone diagnostics report unavailable instead of using ambient credentials',async()=>{
 const handler=createFetchHandler()
 const available=await(await post(handler,{action:'model_network_get'})).json();assert.equal(available.result.available,false)
 for(const action of ['model_network_probe','model_translation_probe'])assert.equal((await post(handler,{action})).status,409)
})
