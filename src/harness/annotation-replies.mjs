import {loggedAnnotationReference} from './annotation-usage.mjs'

/** Associate replies with logged references in their own turn, never by prose.
 * A cropped tail without a turn boundary cannot authorize automatic PDF writes.
 */
export function annotationReplySources(snapshot) {
  const replies=new Map(),references=new Map()
  let inTurn=false,turnReplies=[]
  for(const row of snapshot.records){
    if(row.type!=='event')continue
    const event=row.event
    if(event.type==='turn/start'){references.clear();turnReplies=[];inTurn=true;continue}
    if(event.type==='user/message'&&event.data.source?.kind==='user'&&!inTurn)references.clear()
    const source=loggedAnnotationReference(event,snapshot.header?.id)
    if(source){if(references.size<4||references.has(source.snapshot_id))references.set(source.snapshot_id,source);continue}
    if(event.type==='assistant/message'&&event.data.interrupted!==true){
      const groups=[...references.values()],ids=[...new Set(groups.flatMap(source=>source.annotation_refs.map(ref=>ref.id)))]
      if(ids.length&&ids.length<=1000&&new Set(groups.map(source=>source.paperId)).size===1){
        const reply={paperId:groups[0].paperId,annotation_ids:ids,source_snapshot_ids:groups.map(source=>source.snapshot_id),completed:false}
        replies.set(String(event.seq),reply);turnReplies.push(reply)
      }
    }
    if(event.type==='turn/end'){
      if(inTurn&&event.data.reason?.kind==='completed')for(const reply of turnReplies)reply.completed=true
      references.clear();turnReplies=[];inTurn=false
    }
  }
  return replies
}
