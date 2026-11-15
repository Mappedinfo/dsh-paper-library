'use strict';

window.PaperScholars = (() => {
  function create({ root, api, openPaper, toast }) {
    const doc = root.ownerDocument;
    const el = (tag, text, className) => {
      const node = doc.createElement(tag);
      if (text !== undefined) node.textContent = text;
      if (className) node.className = className;
      return node;
    };
    const button = (text, run) => {
      const node = el('button', text, 'workspace-nav-button');
      node.type = 'button';
      node.addEventListener('click', run);
      return node;
    };
    const link = (text, href) => {
      const node = el('a', text);
      let url;
      try { url = new URL(href); } catch { return node; }
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return node;
      node.href = url.href;
      node.target = '_blank';
      node.rel = 'noopener noreferrer';
      return node;
    };
    const nameOf = item => item.native_name && item.native_name !== item.name ? `${item.native_name} / ${item.name}` : item.name;
    const dialog = el('dialog', undefined, 'scholar-dialog');
    const content = el('div');
    root.replaceChildren(content, dialog);
    let active = false, selected = null, generation = 0, saving = false;
    let catalogOffset = 0, paperOffset = 0, restoreFocus = null;
    const paperPage = 40, scholarPage = 30;
    dialog.addEventListener('close', () => {
      if (restoreFocus?.isConnected) restoreFocus.focus();
      else if (active) content.querySelector('h2')?.focus();
      restoreFocus = null;
    });

    function begin(title, actions = []) {
      const heading = el('h2', title);
      heading.tabIndex = -1;
      const header = el('header', undefined, 'scholar-header');
      header.append(heading, ...actions);
      content.replaceChildren(header);
    }
    function status(message, target = content) {
      const node = el('p', message, 'scholar-status');
      node.setAttribute('role', 'status');
      target.append(node);
      return node;
    }
    function table(caption, columns) {
      const wrap = el('div', undefined, 'scholar-table-wrap');
      const table = el('table', undefined, 'scholar-table');
      const head = el('thead'), headers = el('tr'), body = el('tbody');
      table.append(el('caption', caption), head, body);
      head.append(headers);
      for (const title of columns) {
        const th = el('th', title);
        th.scope = 'col';
        headers.append(th);
      }
      wrap.append(table);
      content.append(wrap);
      return body;
    }
    function row(body, values) {
      const tr = el('tr');
      for (const value of values) {
        const cell = el('td');
        if (value?.nodeType) cell.append(value);
        else cell.textContent = value ?? '—';
        tr.append(cell);
      }
      body.append(tr);
    }
    function pager(offset, size, hasMore, load) {
      if (!offset && !hasMore) return;
      const controls = el('div', undefined, 'scholar-controls');
      const back = button('上一页', () => load(Math.max(0, offset - size)));
      const next = button('下一页', () => load(offset + size));
      back.disabled = offset === 0;
      next.disabled = !hasMore;
      controls.append(back, next);
      content.append(controls);
    }

    async function loadCatalog(offset = 0) {
      selected = null;
      catalogOffset = offset;
      const owner = ++generation;
      begin('学者', [button('添加学者', () => editProfile()), button('刷新', () => void loadCatalog(offset))]);
      const pending = status('正在读取关注列表…');
      try {
        const page = await api('scholar_list', { offset });
        if (!active || owner !== generation) return;
        if (!page.items.length) { pending.textContent = '添加一位学者，开始整理其研究方向和论文。'; return; }
        pending.remove();
        const body = table(`学者目录 · ${page.total} 位`, ['姓名', '机构', '关注状态']);
        for (const item of page.items) {
          row(body, [button(item.name, () => void loadProfile(item.id)), item.organization || '—', item.followed ? '已关注' : '未关注']);
        }
        pager(offset, scholarPage, page.next_offset != null, value => void loadCatalog(value));
      } catch (error) { if (active && owner === generation) pending.textContent = error.message; }
    }

    async function loadProfile(id, offset = 0) {
      selected = id;
      paperOffset = offset;
      const owner = ++generation;
      begin('学者档案', [button('返回学者列表', () => void loadCatalog(catalogOffset))]);
      const pending = status('正在读取学者档案…');
      let entry;
      try {
        entry = await api('scholar_get', { id });
        if (!active || owner !== generation) return;
        renderProfile(entry);
        const pendingWorks = status('正在匹配本库题录…');
        try {
          const works = await api('scholar_publications', { id, offset });
          if (!active || owner !== generation) return;
          if (offset && !works.items.length) { void loadProfile(id, Math.max(0, offset - paperPage)); return; }
          pendingWorks.remove();
          renderPapers(entry, works, offset);
        } catch (error) {
          if (!active || owner !== generation) return;
          pendingWorks.textContent = `读取本库题录失败：${error.message}`;
          renderPapers(entry, null, offset);
        }
      } catch (error) { if (active && owner === generation) pending.textContent = error.message; }
    }

    function renderProfile(entry) {
      const item = entry.profile;
      const follow = button(item.followed ? '取消关注' : '关注', () => void update(entry, 'scholar_save', { patch: { followed: !item.followed } }));
      follow.setAttribute('aria-pressed', String(item.followed));
      begin(nameOf(item), [
        follow, button('编辑档案', () => editProfile(entry)),
        button('返回学者列表', () => void loadCatalog(catalogOffset)),
      ]);
      const info = table('学者档案', ['字段', '资料']);
      const affiliation = el('span');
      affiliation.append(item.organization_url ? link(item.organization, item.organization_url) : item.organization || '—');
      if (item.department) affiliation.append(` · ${item.department}`);
      row(info, ['机构', affiliation]);
      if (item.position) row(info, ['职称', item.position]);
      if (item.email_domain) row(info, ['邮箱域名', item.email_domain]);
      if (item.homepage) row(info, ['主页', link('打开学者主页', item.homepage)]);
      if (item.topics?.length) {
        const topics = el('span', undefined, 'scholar-topics');
        for (const topic of item.topics) topics.append(topic.url ? link(topic.name, topic.url) : el('span', topic.name));
        row(info, ['研究方向', topics]);
      }
      if (item.notes) row(info, ['分析笔记', el('div', item.notes, 'scholar-notes')]);
    }

    function renderPapers(entry, result, offset) {
      const item = entry.profile;
      const controls = el('div', undefined, 'scholar-controls');
      controls.append(button('添加代表作', () => editWork(entry)), button('重新匹配', () => void loadProfile(item.id, offset)));
      content.append(controls);
      const works = new Map(item.works.map(work => [work.doi, work]));
      const linked = new Set(result?.linked_dois || []);
      const external = offset === 0 || !result ? item.works.filter(work => !linked.has(work.doi)) : [];
      const records = [...(result?.items || []), ...external.sort((a, b) => (b.year || 0) - (a.year || 0))];
      if (records.length) {
        const body = table(result ? `论文 · 本库匹配 ${result.total} 篇` : '已登记代表作', ['论文', '年份', '出处', '关联依据', '操作']);
        for (const paper of records) {
          const work = works.get(paper.doi?.toLowerCase());
          const title = el('div');
          title.append(el('strong', paper.title));
          if (paper.authors?.length) title.append(el('div', paper.authors.join(' · '), 'scholar-muted'));
          if (work?.note) title.append(el('p', work.note, 'scholar-work-note'));
          const actions = el('div', undefined, 'scholar-row-actions');
          if (paper.id) actions.append(button(paper.pdf ? '打开文献' : '查看题录', () => void openPaper(paper)));
          if (work) actions.append(link('来源', work.source), button('编辑代表作', () => editWork(entry, work)));
          if (paper.match === 'candidate') {
            actions.append(button('确认作者', () => void review(entry, paper.id, 'confirmed')),
              button('排除', () => void review(entry, paper.id, 'excluded')));
          }
          if (paper.match === 'confirmed') actions.append(button('撤销确认', () => void review(entry, paper.id, null)));
          const match = { doi: 'DOI 已匹配', confirmed: '已确认', candidate: '同名待确认' }[paper.match] || '已登记 · 未关联在库文献';
          row(body, [title, work?.year || paper.year || '—', work?.venue || paper.venue || '—', match, actions]);
        }
      } else if (result) status('本库暂未匹配到论文。可添加有来源的代表作。');
      const excluded = item.reviewed.filter(review => review.match === 'excluded');
      if (excluded.length) {
        const details = el('details', undefined, 'scholar-excluded');
        details.append(el('summary', `已排除 ${excluded.length} 篇`));
        for (const paper of excluded) {
          const line = el('div', undefined, 'scholar-row-actions');
          line.append(el('span', paper.title), button('恢复候选', () => void review(entry, paper.id, null)));
          details.append(line);
        }
        content.append(details);
      }
      pager(offset, paperPage, result?.has_more, value => void loadProfile(item.id, value));
    }

    function review(entry, paperId, match) {
      return update(entry, 'scholar_review', { paper_id: paperId, match });
    }
    async function update(entry, action, params, formError) {
      if (saving) return;
      const owner = generation;
      const submit = dialog.querySelector('button[type=submit]');
      const inDialog = dialog.open && Boolean(formError);
      saving = true;
      if (submit && inDialog) submit.disabled = true;
      try {
        const saved = await api(action, { ...(entry ? { id: entry.profile.id, expected_revision: entry.revision } : {}), ...params });
        if (!active || owner !== generation) return;
        if (inDialog && dialog.open) dialog.close();
        void loadProfile(saved.profile.id, entry ? paperOffset : 0);
      } catch (error) {
        if (!active || owner !== generation) return;
        if (inDialog && dialog.open) formError.textContent = error.message;
        else toast(error.message, true);
      } finally {
        saving = false;
        if (submit) submit.disabled = false;
      }
    }
    function editor(title, specs, current, submit) {
      if (saving || dialog.open) return;
      const form = el('form', undefined, 'scholar-form');
      const heading = el('h2', title);
      heading.id = 'scholar-editor-title';
      dialog.setAttribute('aria-labelledby', heading.id);
      form.append(heading);
      const inputs = {};
      for (const [key, label, length, type = 'text', required = false] of specs) {
        const field = el('label', label);
        const input = el(type === 'multiline' ? 'textarea' : 'input');
        if (type !== 'multiline') input.type = type;
        input.maxLength = length;
        input.required = required;
        if (key === 'year') input.inputMode = 'numeric';
        input.value = current[key] ?? '';
        field.append(input);
        form.append(field);
        inputs[key] = input;
      }
      const error = status('', form);
      const controls = el('div', undefined, 'scholar-controls');
      const save = el('button', '保存', 'button primary');
      save.type = 'submit';
      controls.append(save, button('取消', () => { if (!saving) dialog.close(); }));
      form.append(controls);
      form.addEventListener('submit', event => {
        event.preventDefault();
        void submit(Object.fromEntries(Object.entries(inputs).map(([key, input]) => [key, input.value.trim()])), error);
      });
      dialog.replaceChildren(form);
      restoreFocus = doc.activeElement;
      dialog.showModal();
    }

    function editProfile(entry) {
      const item = entry?.profile || {};
      editor(entry ? '编辑学者档案' : '添加学者', [
        ['name', '姓名', 160, 'text', true], ['native_name', '中文姓名或本名', 160],
        ['aliases', '署名别名（每行一个）', 1200, 'multiline'],
        ['organization', '机构', 240], ['department', '院系或研究组', 240], ['position', '职称', 160],
        ['homepage', '主页', 2048, 'url'], ['organization_url', '机构来源链接', 2048, 'url'],
        ['email_domain', '邮箱域名', 253], ['topics', '研究方向（每行一个）', 1900, 'multiline'],
        ['notes', '分析笔记', 4000, 'multiline'],
      ], { ...item, aliases: item.aliases?.join('\n'), topics: item.topics?.map(topic => topic.name).join('\n') }, (patch, error) => {
        patch.aliases = patch.aliases.split('\n').map(value => value.trim()).filter(Boolean);
        patch.topics = patch.topics.split('\n').map(name => name.trim()).filter(Boolean).map(name => ({ name }));
        return update(entry, 'scholar_save', { patch }, error);
      });
    }
    function editWork(entry, work = {}) {
      editor(work.doi ? '编辑代表作' : '添加代表作', [
        ['title', '论文题名', 500, 'text', true], ['doi', 'DOI', 400, 'text', true],
        ['year', '发表年份', 4], ['venue', '出处', 300], ['source', '来源链接', 2048, 'url', true],
        ['note', '论文备注', 800, 'multiline'],
      ], work, (value, error) => {
        if (value.year && !/^\d{4}$/.test(value.year)) { error.textContent = '请输入四位发表年份。'; return; }
        return update(entry, 'scholar_work_save', { work: { ...value, year: value.year ? Number(value.year) : null }, ...(work.doi ? { previous_doi: work.doi } : {}) }, error);
      });
    }

    return {
      setVisible(visible) {
        root.hidden = !visible;
        if (active === visible) return;
        active = visible;
        if (visible) {
          if (selected) void loadProfile(selected, paperOffset);
          else void loadCatalog(catalogOffset);
        } else {
          generation++;
          if (dialog.open) dialog.close();
        }
      },
    };
  }
  return { create };
})();
