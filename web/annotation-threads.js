'use strict';
// 原生 /IRT 回复归到同一处划线；每个 AI 回答只展示一次。
window.PaperAnnotationThreads = (() => {
  const isAi = note => note.kind === 'ai-feedback' || note.type === 'ai_feedback' || note.ai_generated === true;

  function timestamp(value) {
    if (typeof value !== 'string' || !value.trim()) return null;
    const pdf = /^(?:D:)?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?(?:Z|([+-])(\d{2})'?(\d{2})?'?)?$/.exec(value.trim());
    let date = value;
    if (pdf) {
      const [, year, month = '01', day = '01', hour = '00', minute = '00', second = '00', sign, offsetHour, offsetMinute = '00'] = pdf;
      const offset = sign ? `${sign}${offsetHour}:${offsetMinute}` : 'Z';
      date = `${year}-${month}-${day}T${hour}:${minute}:${second}${offset}`;
    }
    const time = Date.parse(date);
    return Number.isFinite(time) ? time : null;
  }

  function anchor(note) {
    let top = Infinity, left = Infinity;
    const rects = Array.isArray(note.rects) && note.rects.length ? note.rects : [note.rect];
    for (const rect of rects) {
      if (!Array.isArray(rect) || !Number.isFinite(rect[0]) || !Number.isFinite(rect[1])) continue;
      const [x, y] = rect;
      if (y < top || y === top && x < left) { top = y; left = x; }
    }
    return { page: Number.isInteger(note.page) && note.page > 0 ? note.page : Infinity, top, left };
  }

  function ordered(notes, order) {
    return notes.map(note => ({
      note, ...anchor(note),
      time: order === 'time' ? timestamp(note.created) ?? timestamp(note.modified) ?? timestamp(note.generated) ?? -Infinity : 0,
    })).sort((a, b) => (b.time - a.time) || (a.page - b.page) || (a.top - b.top) || (a.left - b.left))
      .map(({ note }) => note);
  }

  function threads(annotations, order = 'position') {
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
    return { notes: ordered(notes, order), remarks, roots, replies, unlinked: ordered(unlinked, order) };
  }
  return { threads, isAi };
})();
