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
    const human = list.filter(note => !isAi(note) && !['handwriting-note','linked-handwriting','linked-handwriting-transcript','paper-remark'].includes(note.kind));
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

window.PaperRemark = (() => {
  const view = 'paper-remark';
  const make = (tag, text, className) => {
    const node = document.createElement(tag);
    if (text) node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  function button(text, click) {
    const node = make('button', text, 'button subtle');
    node.type = 'button';
    node.addEventListener('click', click);
    return node;
  }

  function create({api, toast, onSaved, locate}) {
    const cache = new Map(), cells = new Map(), pending = new Set();
    let reading = false, expandedPaper, draft;
    const dialog = make('dialog', '', 'paper-remark-editor');
    const form = make('form'), title = make('h2','文献备注'), paperTitle = make('p','','small muted');
    title.id = 'paper-remark-title';
    dialog.setAttribute('aria-labelledby', title.id);
    const label = make('label','备注与评价','field'), input = make('textarea');
    input.rows = 7; input.maxLength = 6000; input.placeholder = '记录你的评价或阅读要点';
    label.append(input);
    const latest = make('blockquote','','paper-remark-current'), status = make('p','','small');
    status.setAttribute('role', 'status');
    const actions = make('div','','dialog-actions');
    const close = button('取消', () => dialog.close());
    const reload = button('读取当前版本', () => readEditor(draft, draft?.remark !== undefined));
    const save = make('button','保存备注','button primary');
    save.type = 'submit';
    actions.append(reload,close,save);
    form.append(title,paperTitle,label,latest,status,actions);
    dialog.append(form); document.body.append(dialog);
    dialog.addEventListener('cancel', event => { if (draft?.saving) event.preventDefault(); });
    dialog.addEventListener('close', () => { if (!dialog.open) draft = null; });

    const read = async (ids) => (await api('annotations',{view,ids})).items;
    function paint(row, remark) {
      row.control.textContent = remark?.comment?.trim() ? remark.comment.trim().slice(0, 180) : '＋ 备注';
      row.control.setAttribute('aria-label', `${remark?.comment ? '编辑' : '添加'}文献备注 · ${row.item.title}`);
      row.control.title = remark?.comment?.trim().slice(0, 500) || '添加备注与评价';
    }
    function remember(item, remark) {
      cache.delete(item.id);
      cache.set(item.id,{modified:item.modified,remark});
      if (cache.size > 256) cache.delete(cache.keys().next().value);
      const row = cells.get(item.id);
      if (row) paint(row,remark);
    }
    async function flushPreviews() {
      if (reading) return;
      const batch = [...pending].slice(0,12);
      if (!batch.length) return;
      for (const row of batch) pending.delete(row);
      const baseline = new Map(batch.map(row=>[row.item.id,cache.get(row.item.id)]));
      reading = true;
      try {
        const results = await read(batch.map(row=>row.item.id));
        for (const result of results) {
          const row = cells.get(result.id);
          if (!row || row !== batch.find(candidate=>candidate.item.id===result.id)) continue;
          if (!result.error && cache.get(result.id) === baseline.get(result.id)) remember(row.item,result.remark);
        }
      } catch { /* Opening the editor retries and shows any read failure. */ }
      finally { reading = false; queueMicrotask(flushPreviews); }
    }
    const observed = new WeakMap();
    const observer = typeof IntersectionObserver === 'function' ? new IntersectionObserver(entries=>{
      for (const entry of entries) {
        const row = observed.get(entry.target);
        if (!entry.isIntersecting || !row || cells.get(row.item.id)!==row) continue;
        observer.unobserve(entry.target);
        pending.add(row);
      }
      queueMicrotask(flushPreviews);
    }) : null;

    async function readEditor(current, keepText = false) {
      if (!current) return;
      reload.hidden = true;
      save.disabled = input.disabled = true;
      status.textContent = '正在读取第一页的便笺…';
      try {
        const [result] = await read([current.item.id]);
        if (draft!==current || !dialog.open) return;
        if (!result || result.error) throw Error(result?.error || '未能读取文献备注。');
        current.remark = result.remark;
        remember(current.item, current.remark);
        if (keepText) {
          latest.hidden = false;
          latest.textContent = `PDF 中的当前备注\n${current.remark?.comment || '（空）'}`;
        } else input.value = current.remark?.comment || '';
        save.disabled = input.disabled = false;
        status.textContent = keepText ? '请核对上面的当前版本，再保存你的草稿。' : '';
        input.focus();
      } catch (error) {
        if (draft!==current || !dialog.open) return;
        status.textContent = error.message;
        reload.hidden = false;
      }
    }
    function openEditor(item) {
      if (dialog.open) return;
      draft = {item};
      paperTitle.textContent = item.title;
      input.value = ''; latest.hidden = true; close.disabled = false;
      dialog.showModal();
      void readEditor(draft);
    }
    form.addEventListener('submit', async event=>{
      event.preventDefault();
      const current = draft;
      if (!current || save.disabled || current.saving) return;
      current.saving = true;
      save.disabled = close.disabled = input.disabled = true;
      status.textContent = '正在保存到 PDF…';
      try {
        const {remark} = await api('annotation_update',{view,id:current.item.id,comment:input.value,
          expected_version:current.remark?.version ?? null,companion_skip:true});
        remember(current.item,remark);
        dialog.close();
        toast('文献备注已保存');
        Promise.resolve().then(()=>onSaved(current.item.id)).catch(error=>toast(error.message,true));
      } catch (error) {
        status.textContent = error.message;
        input.disabled = close.disabled = false;
        save.disabled = error.code === 'PAPER_REMARK_CONFLICT';
        reload.hidden = !save.disabled;
      } finally { current.saving = false; }
    });
    return {
      cell(item) {
        if (!item.pdf || item.archived || (item.resource_kind && item.resource_kind!=='paper')) return make('span','—','muted');
        const control = button('',()=>openEditor(item)), row = {item,control};
        control.classList.add('catalog-remark-preview');
        cells.set(item.id,row); observed.set(control,row);
        const cached = cache.get(item.id);
        paint(row,cached && cached.modified===item.modified ? cached.remark : null);
        return control;
      },
      connectTable(root) {
        observer?.disconnect(); pending.clear();
        for (const [id,row] of cells) {
          if (!root?.contains(row.control)) cells.delete(id);
          else if (!cache.has(id) || cache.get(id).modified!==row.item.modified) observer?.observe(row.control);
        }
      },
      sidebar(item, remark) {
        const panel = make('details','','paper-remark-card');
        panel.dataset.paperRemark = item.id;
        panel.open = expandedPaper===item.id;
        panel.addEventListener('toggle',()=>{
          if (panel.isConnected) expandedPaper = panel.open ? item.id : undefined;
        });
        const heading = make('summary','文献备注');
        heading.append(make('span',remark?.comment?'第 1 页':'未填写','small muted'));
        const content = make('p',remark?.comment || '添加你的评价或阅读要点。','paper-remark-content');
        const actions = make('div','','annotation-actions');
        actions.append(button(remark?.comment?'编辑备注':'添加备注',()=>openEditor(item)));
        if (remark) actions.append(button('定位第一页',()=>locate(item,remark)));
        panel.append(heading,content,actions);
        return panel;
      },
    };
  }
  return {create};
})();
