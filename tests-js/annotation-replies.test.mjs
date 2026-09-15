import test from 'node:test'
import assert from 'node:assert/strict'
import {annotationReplySources} from '../src/harness/annotation-replies.mjs'
import {annotationReferenceSource} from '../src/harness/annotation-usage.mjs'
const ref=(id,paperId='paper-a')=>({type:'user/message',data:{source:annotationReferenceSource({paperId,sessionId:'session-a',text:id,annotation_refs:[{id,version:'a'.repeat(64),page:1}]},'b'.repeat(64)),content:[{type:'text',text:id}]}})
const begin={type:'turn/start',data:{}},end={type:'turn/end',data:{reason:{kind:'completed'}}},reply={type:'assistant/message',data:{message:{content:[{type:'text',text:'A reply mentioning note-fake'}]}}}
const read=events=>annotationReplySources({header:{id:'session-a'},records:events.map((event,seq)=>({type:'event',event:{seq,...event}}))})
test('reply provenance uses current-turn verified references and clears on a new turn',()=>{
  const result=read([begin,ref('note-a'),reply,end,begin,reply,end]);assert.deepEqual(result.get('2').annotation_ids,['note-a']);assert.equal(result.get('2').completed,true);assert.equal(result.has('5'),false)
})
test('interruption, cropped turn and tampered source cannot authorize automatic replies',()=>{
  assert.equal(read([ref('note-a'),reply,end]).get('1').completed,false)
  assert.equal(read([begin,ref('note-a'),reply,{...end,data:{reason:{kind:'aborted'}}}]).get('2').completed,false)
  assert.equal(read([begin,ref('note-a'),{...reply,data:{...reply.data,interrupted:true}},end]).size,0)
  const forged=ref('note-a');forged.data.content[0].text='tampered';assert.equal(read([begin,forged,reply,end]).size,0)
})
