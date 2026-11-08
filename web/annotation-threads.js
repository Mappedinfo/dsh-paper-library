'use strict';
// 原生 /IRT 回复归到同一处划线；每个 AI 回答只展示一次。
window.PaperAnnotationThreads = (() => {
  const isAi = note => note.kind === 'ai-feedback' || note.type === 'ai_feedback' || note.ai_generated === true;
  function threads(annotations) {
    const list = Array.isArray(annotations) ? annotations : [];
    const human = list.filter(note => !isAi(note) && !['handwriting-note','linked-handwriting','linked-handwriting-transcript'].includes(note.kind));
    const byId=new Map(human.map(note=>[note.id,note])), roots=new Map();
    for(const note of human){
      let root=note;const seen=new Set([note.id]);
      while(byId.has(root.reply_to)&&!seen.has(root.reply_to)){root=byId.get(root.reply_to);seen.add(root.id);}
      roots.set(note.id,root.id);
    }
    const notes=human.filter(note=>roots.get(note.id)===note.id),remarks=new Map(notes.map(note=>[note.id,[]]));
    for(const note of human)if(roots.get(note.id)!==note.id){if(remarks.has(roots.get(note.id)))remarks.get(roots.get(note.id)).push(note);else {notes.push(note);remarks.set(note.id,[]);roots.set(note.id,note.id);}}
    const replies = new Map(human.map(note => [note.id, []])), unlinked = [];
    for (const reply of list.filter(isAi)) {
      const declared = (Array.isArray(reply.annotation_ids) && reply.annotation_ids.length ? reply.annotation_ids : [reply.reply_to]).filter(id => replies.has(id));
      const anchor = replies.has(reply.reply_to) ? reply.reply_to : declared[0];
      if (!anchor) unlinked.push(reply);else replies.get(anchor).push(reply);
    }
    return { notes, remarks, roots, replies, unlinked };
  }
  return { threads, isAi };
})();
