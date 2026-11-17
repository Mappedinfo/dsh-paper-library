'use strict';

window.PaperScholars = (() => {
  const kinds = { scholar: '学者', pi: 'PI', group: '课题组', collaboration: '合作群体', school: '院校', organization: '科研机构', lead: '待核线索' };
  const evidence = { verified: '已核验', publication: '发表时记录', needs_review: '待核验' };
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
    root.setAttribute('aria-label', '研究人员目录');
    root.replaceChildren(content, dialog);
    let active = false, selected = null, generation = 0, saving = false;
    let catalogOffset = 0, paperOffset = 0, restoreFocus = null, kindFilter = '', query = '', memberOrigin = null;
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
    function table(caption, columns, target = content) {
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
      target.append(wrap);
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
    function pager(offset, size, hasMore, load, target = content) {
      if (!offset && !hasMore) return;
      const controls = el('div', undefined, 'scholar-controls');
      const back = button('上一页', () => load(Math.max(0, offset - size)));
      const next = button('下一页', () => load(offset + size));
      back.disabled = offset === 0;
      next.disabled = !hasMore;
      controls.append(back, next);
      target.append(controls);
    }

    async function loadCatalog(offset = 0) {
      selected = null;
      memberOrigin = null;
      catalogOffset = offset;
      const owner = ++generation;
      const importButton = button('导入文献与领域研究', async () => {
        importButton.disabled = true;
        const message = status('正在导入已有资料…', controls);
        try {
          const { counts } = await api('scholar_import');
          if (!active || owner !== generation) return;
          toast(`已读取 ${counts.papers} 篇文献和 ${counts.topics} 个研究主题，导入 ${counts.group} 个课题组和 ${counts.collaboration} 个合作群体。`);
          void loadCatalog(0);
        } catch (error) { if (active && owner === generation) message.textContent = error.message; }
        finally { importButton.disabled = false; }
      });
      begin('研究人员', [button('添加档案', () => editProfile()), importButton, button('刷新', () => void loadCatalog(offset))]);
      const controls = el('form', undefined, 'scholar-controls');
      const type = el('select'), search = el('input'), submit = el('button', '搜索', 'workspace-nav-button');
      type.setAttribute('aria-label', '研究人员类别');
      for (const [value, label] of [['', '全部类型'], ...Object.entries(kinds)]) {
        const option = el('option', label); option.value = value; type.append(option);
      }
      type.value = kindFilter;
      search.type = 'search'; search.maxLength = 200; search.value = query;
      search.placeholder = '检索名称、院校或研究兴趣'; search.setAttribute('aria-label', search.placeholder);
      submit.type = 'submit';
      controls.append(type, search, submit); content.append(controls);
      controls.addEventListener('submit', event => { event.preventDefault(); query = search.value.trim(); void loadCatalog(0); });
      type.addEventListener('change', () => { kindFilter = type.value; query = search.value.trim(); void loadCatalog(0); });
      const pending = status('正在读取目录…');
      try {
        const page = await api('scholar_list', { offset, kind: kindFilter, query });
        if (!active || owner !== generation) return;
        if (!page.items.length) { pending.textContent = page.counts ? '当前筛选没有匹配记录。' : '可添加档案，或导入文献与领域研究中的资料。'; return; }
        pending.remove();
        const body = table(`研究人员目录 · ${page.total} 项`, ['名称', '类型', '所属机构', '发文量', '来源关联', '研究兴趣', '核验', '关注']);
        for (const item of page.items) {
          row(body, [button(item.name, () => void loadProfile(item.id)), kinds[item.kind], item.organization || '—',
            item.publication_count ?? '—', item.linked_publication_count, item.topics?.map(topic => topic.name).join(' · ') || '—',
            item.has_public_verification && item.evidence_status !== 'verified' ? 'AI 已检索 · 待复核' : evidence[item.evidence_status] || '—',
            item.followed ? '已关注' : '未关注']);
        }
        pager(offset, scholarPage, page.next_offset != null, value => void loadCatalog(value));
      } catch (error) { if (active && owner === generation) pending.textContent = error.message; }
    }

    function profileBackActions() {
      const actions = [];
      if (memberOrigin) actions.push(button('返回合作线', () => {
        const id = memberOrigin;
        memberOrigin = null;
        void loadProfile(id);
      }));
      actions.push(button('返回列表', () => void loadCatalog(catalogOffset)));
      return actions;
    }

    async function loadProfile(id, offset = 0) {
      selected = id;
      paperOffset = offset;
      const owner = ++generation;
      begin('研究档案', profileBackActions());
      const pending = status('正在读取档案…');
      let entry;
      try {
        entry = await api('scholar_get', { id });
        if (!active || owner !== generation) return;
        renderProfile(entry);
        if (entry.profile.linked_publication_count) {
          const sourceWorks = el('div');
          content.append(sourceWorks);
          void loadSourcePapers(id, 0, owner, sourceWorks);
        }
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
        ...(entry.can_verify ? [button('AI 公开核验', () => openVerification(entry))] : []),
        follow, button('编辑档案', () => editProfile(entry)),
        ...profileBackActions(),
      ]);
      if (item.public_verification) renderVerification(item.public_verification);
      if (item.member_rows?.length) {
        const members = table(`来源列出的成员 · ${item.member_rows.length} 人`, ['姓名', '档案类型', '档案中的职称／角色', '档案所列机构', '研究人员档案']);
        for (const member of item.member_rows) {
          const action = member.id ? button('查看档案', () => {
            memberOrigin = item.id;
            void loadProfile(member.id);
          }) : '暂无匹配档案';
          if (member.id) action.setAttribute('aria-label', `查看 ${member.name} 的档案`);
          row(members, [member.name, kinds[member.kind], member.position || '—', member.organization || '—', action]);
        }
      }
      const info = table('档案资料', ['字段', '资料']);
      row(info, ['类型', kinds[item.kind]]);
      if (item.roles?.includes('pi') && item.kind === 'lead') row(info, ['角色线索', 'PI 待核验']);
      if (item.evidence_status) row(info, ['核验状态', evidence[item.evidence_status]]);
      const affiliation = el('span');
      affiliation.append(item.organization_url ? link(item.organization, item.organization_url) : item.organization || '—');
      if (item.department) affiliation.append(` · ${item.department}`);
      row(info, ['机构', affiliation]);
      if (item.position) row(info, ['职称', item.position]);
      if (item.description) row(info, ['研究简介', item.description]);
      if (item.scope) row(info, ['研究范围', item.scope]);
      if (item.evidence_note) row(info, ['来源说明', item.evidence_note]);
      if (item.last_checked) row(info, ['来源核对日期', item.last_checked]);
      row(info, ['发文量', item.publication_count == null ? '—' : [item.publication_count, item.publication_count_source].filter(Boolean).join(' · ')]);
      if (item.linked_publication_count || item.source_work_count) row(info, ['来源收录', `${Math.max(item.linked_publication_count || 0, item.source_work_count || 0)} 篇`]);
      if (item.email_domain) row(info, ['邮箱域名', item.email_domain]);
      if (item.homepage) row(info, ['主页', link('打开学者主页', item.homepage)]);
      if (item.topics?.length) {
        const topics = el('span', undefined, 'scholar-topics');
        for (const topic of item.topics) topics.append(topic.url ? link(topic.name, topic.url) : el('span', topic.name));
        row(info, ['研究兴趣', topics]);
      }
      if (item.notes) row(info, ['分析笔记', el('div', item.notes, 'scholar-notes')]);
      if (item.sources?.length) {
        const details = el('details'), list = el('ul');
        details.append(el('summary', `来源 · ${item.source_count ?? item.sources.length}`));
        for (const source of item.sources) {
          const line = el('li');
          line.append(source.url ? link(source.label, source.url) : source.label);
          list.append(line);
        }
        details.append(list); row(info, ['来源', details]);
      }
    }

    function openVerification(entry) {
      if (content.querySelector('.scholar-verification-form')) return;
      const owner = generation, item = entry.profile;
      const form = el('form', undefined, 'scholar-verification-form');
      const query = el('input'); query.required = true; query.maxLength = 200;
      query.value = [item.name, item.organization].filter(Boolean).join(' ').slice(0, 200);
      const label = el('label', '公开检索词'); label.append(query);
      const run = el('button', '开始核验', 'workspace-nav-button'); run.type = 'submit';
      form.append(label, run, button('取消', () => form.remove()));
      const pending = status('DeepSeek 将使用此检索词搜索公开来源。', form);
      form.addEventListener('submit', async event => {
        event.preventDefault(); if (run.disabled) return;
        run.disabled = query.disabled = true;
        pending.textContent = '正在公开核验…';
        try {
          const result = await api('scholar_verify', { id: item.id, expected_revision: entry.revision, query: query.value.trim(), public_search: true });
          if (!active || owner !== generation || !form.isConnected) return;
          if (result.status === 'explained') { void loadProfile(item.id, paperOffset); return; }
          const reason = { missing_key: '请在 DSH 中配置 DEEPSEEK_API_KEY。', authentication: 'DeepSeek 未接受当前 API 密钥。',
            rate_limited: 'DeepSeek 请求达到限额，请稍后重试。', timeout: '公开核验超时，可重试。' }[result.reason];
          pending.textContent = reason || (result.status === 'insufficient' ? '证据不足，可加上公开机构名称以区分同名。' : '公开核验暂未完成，请重试。');
        } catch (error) { if (active && owner === generation) pending.textContent = error.message; }
        finally { run.disabled = query.disabled = false; }
      });
      content.firstElementChild.after(form); query.focus();
    }

    function renderVerification(value) {
      const { report } = value;
      const panel = el('section', undefined, 'scholar-verification');
      const refs = new Map(report.sources.map(source => [source.id, source]));
      panel.append(el('h3', 'AI 公开核验 · 待复核'),
        el('p', [value.query, value.checked_at.slice(0, 10)].join(' · '), 'scholar-status'));
      for (const claim of [report.definition, ...report.paragraphs]) {
        const line = el('p', claim.text);
        for (const id of claim.citations) {
          const source = refs.get(id);
          if (source) { const citation = link(`[${id}]`, source.url); citation.title = source.title; line.append(' ', citation); }
        }
        panel.append(line);
      }
      const sources = el('ul');
      for (const source of report.sources) {
        const row = el('li'); row.append(link(`[${source.id}] ${source.title}`, source.url)); sources.append(row);
      }
      panel.append(sources); content.append(panel);
    }

    async function loadSourcePapers(id, offset, owner, host) {
      host.replaceChildren();
      const pending = status('正在读取来源关联论文…', host);
      try {
        const page = await api('scholar_source_publications', { id, offset });
        if (!active || owner !== generation) return;
        pending.remove();
        const body = table(`来源关联论文 · ${page.total} 篇`, ['论文', '年份', '出处', '操作'], host);
        for (const paper of page.items) {
          const action = paper.id ? button('打开文献', () => void openPaper(paper)) : paper.url ? link('来源', paper.url) : '—';
          row(body, [paper.title, paper.year, paper.venue || '—', action]);
        }
        pager(offset, paperPage, page.has_more, value => void loadSourcePapers(id, value, owner, host), host);
      } catch (error) { if (active && owner === generation) pending.textContent = error.message; }
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
      } else if (result && !item.linked_publication_count) status('本库暂未匹配到论文。可添加有来源的代表作。');
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
        const input = el(type === 'multiline' ? 'textarea' : type === 'kind' ? 'select' : 'input');
        if (type === 'kind') {
          for (const [value, label] of Object.entries(kinds)) { const choice = el('option', label); choice.value = value; input.append(choice); }
        } else {
          if (type !== 'multiline') input.type = type;
          input.maxLength = length;
        }
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
      editor(entry ? '编辑研究档案' : '添加研究档案', [
        ['kind', '类型', 0, 'kind'], ['name', '名称', 160, 'text', true], ['native_name', '中文名或原名', 160],
        ['aliases', '署名别名（每行一个）', 1200, 'multiline'],
        ['organization', '所属机构', 240], ['department', '院系或研究组', 240], ['position', '职称或角色', 160],
        ['homepage', '主页', 2048, 'url'], ['organization_url', '机构来源链接', 2048, 'url'],
        ['email_domain', '邮箱域名', 253], ['topics', '研究兴趣（每行一个）', 7900, 'multiline'],
        ['publication_count', '发文量', 8], ['publication_count_source', '发文量来源或统计口径', 500],
        ['notes', '分析笔记', 4000, 'multiline'],
      ], { kind: 'scholar', ...item, aliases: item.aliases?.join('\n'), topics: item.topics?.map(topic => topic.name).join('\n') }, (patch, error) => {
        if (patch.publication_count && !/^\d+$/.test(patch.publication_count)) { error.textContent = '发文量须为非负整数。'; return; }
        patch.publication_count = patch.publication_count ? Number(patch.publication_count) : null;
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
