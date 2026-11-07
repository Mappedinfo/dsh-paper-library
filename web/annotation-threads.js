'use strict';
// Which AI reply belongs under which reader annotation.
//
// 每个回答只展示一次；完整引用列表仍保留在 PDF 元数据中。
window.PaperAnnotationThreads = (() => {
  const isAi = note => note.kind === 'ai-feedback' || note.type === 'ai_feedback' || note.ai_generated === true;

  /** Group saved annotations into reader notes plus their AI replies. */
  function threads(annotations) {
    const list = Array.isArray(annotations) ? annotations : [];
    const notes = list.filter(note => !isAi(note) && !['handwriting-note','linked-handwriting','linked-handwriting-transcript'].includes(note.kind));
    const replies = new Map(notes.map(note => [note.id, []]));
    const unlinked = [];
    for (const reply of list.filter(isAi)) {
      const declared = (Array.isArray(reply.annotation_ids) && reply.annotation_ids.length ? reply.annotation_ids : [reply.reply_to])
        .filter(id => typeof id === 'string' && replies.has(id));
      const anchor = replies.has(reply.reply_to) ? reply.reply_to : declared[0];
      const parents = anchor ? [anchor] : [];
      if (!parents.length) unlinked.push(reply);
      else for (const id of parents) replies.get(id).push(reply);
    }
    return { notes, replies, unlinked };
  }

  return { threads, isAi };
})();
