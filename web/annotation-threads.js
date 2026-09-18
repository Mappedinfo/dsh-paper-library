'use strict';
// Which AI reply belongs under which reader annotation.
//
// Per-annotation feedback is written back as one note per annotation, each with
// a single annotation id, so it nests under exactly that annotation. A combined
// answer (a legacy feedback note, or a conversation reply that discusses several
// chosen annotations) must not be copied under every source annotation: a
// combined feedback note is shown once, while a conversation reply keeps the
// documented shared label and appears under each source it cites.
window.PaperAnnotationThreads = (() => {
  const isAi = note => note.kind === 'ai-feedback' || note.type === 'ai_feedback' || note.ai_generated === true;

  /** Group saved annotations into reader notes plus their AI replies. */
  function threads(annotations) {
    const list = Array.isArray(annotations) ? annotations : [];
    const notes = list.filter(note => !isAi(note));
    const replies = new Map(notes.map(note => [note.id, []]));
    const unlinked = [];
    for (const reply of list.filter(isAi)) {
      const declared = (Array.isArray(reply.annotation_ids) && reply.annotation_ids.length ? reply.annotation_ids : [reply.reply_to])
        .filter(id => typeof id === 'string' && replies.has(id));
      // A conversation answer addresses every annotation the reader attached, so
      // it stays under each of them. Any other combined note is shown once.
      const shared = reply.source_kind === 'dsh-conversation';
      const parents = declared.length ? (shared ? declared : [declared[0]]) : [];
      if (!parents.length) unlinked.push(reply);
      else for (const id of parents) replies.get(id).push(reply);
    }
    return { notes, replies, unlinked };
  }

  return { threads, isAi };
})();
