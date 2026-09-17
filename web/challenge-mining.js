'use strict';
// Research challenge mining runs over an explicitly selected corpus:
// P1 scans sections and trigger sentences with no model, P2 extracts per-paper
// difficulty records through the isolated host subagent, P3 aggregates saved
// records into reviewable themes and exports them. Nothing is auto-accepted.
window.ChallengeMining = (() => {
  const $ = id => document.getElementById(id);
  const node = (tag, text, cls) => { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; if (cls) n.className = cls; return n; };
  const button = (id, text, fn, cls = 'button subtle') => { const n = node('button', text, cls); n.id = id; n.type = 'button'; n.addEventListener('click', fn); return n; };
  const activeStates = new Set(['queued', 'reading', 'generating', 'committing']);
  const MAX_CORPUS = 50;
  const MAX_THEMES = 40;

  function create({ state, api, toast }) {
    let available = false, busy = false, epoch = 0, timer = null, disposed = false;
    let scan = null, themes = null, scope = null, extract = null, suggest = null, workingId = null, merging = false;
    const selected = new Set();

    const trigger = button('challenge-open', '研究难点', () => toggle());
    const actions = document.querySelector('.shelf-actions');
    if (actions) actions.insertBefore(trigger, $('refresh')); else document.body.append(trigger);
    const panel = node('section', undefined, 'challenge-panel');
    panel.id = 'challenge-panel'; panel.hidden = true; panel.setAttribute('aria-label', '跨文献研究难点挖掘');
    panel.innerHTML = '<header><div><p class="eyebrow">RESEARCH CHALLENGE MINING</p><strong>研究难点</strong></div><button id="challenge-close" type="button" class="icon-button" aria-label="关闭研究难点面板">×</button></header>'
      + '<p class="small muted">先显式选择语料。P1 小节与触发句扫描完全离线；P2 抽取使用所选论文的 DSH 模型额度并保存为待核对草稿；P3 只聚合已保存记录，主题一律待审阅。</p>'
      + '<div class="challenge-corpus"><div class="challenge-corpus-head"><strong>1 · 选择语料</strong><span id="challenge-count" class="small muted"></span></div>'
      + '<div class="challenge-corpus-actions"><button id="challenge-select-all" class="button subtle" type="button">全选当前列表</button><button id="challenge-select-none" class="button subtle" type="button">清空</button><button id="challenge-refresh" class="button subtle" type="button">读取当前列表</button></div>'
      + '<div id="challenge-items" class="challenge-items"></div></div>'
      + '<div class="challenge-actions"><button id="challenge-scan" class="button" type="button">扫描候选段落（无模型）</button><button id="challenge-extract" class="button subtle" type="button">逐篇抽取难点（模型）</button><button id="challenge-extract-cancel" class="button subtle" type="button" hidden>取消抽取</button><button id="challenge-aggregate" class="button subtle" type="button">聚合主题（无模型）</button><button id="challenge-suggest" class="button subtle" type="button">模型合并建议（可选）</button><button id="challenge-export" class="button subtle" type="button">导出 CSV / Markdown / BibTeX</button></div>'
      + '<p id="challenge-status" role="status"></p><div id="challenge-result"></div>';
    document.body.append(panel);
    $('challenge-close').addEventListener('click', () => { panel.hidden = true; });
    $('challenge-select-all').addEventListener('click', () => { for (const item of selectable()) if (selected.size < MAX_CORPUS) selected.add(item.id); renderCorpus(); });
    $('challenge-select-none').addEventListener('click', () => { selected.clear(); renderCorpus(); });
    $('challenge-refresh').addEventListener('click', () => refreshCorpus());
    $('challenge-scan').addEventListener('click', () => void runScan());
    $('challenge-extract').addEventListener('click', () => void runExtract());
    $('challenge-extract-cancel').addEventListener('click', () => void cancelExtract());
    $('challenge-aggregate').addEventListener('click', () => void runThemes());
    $('challenge-suggest').addEventListener('click', () => void runSuggest());
    $('challenge-export').addEventListener('click', () => void runExport());

    const ids = () => [...selected];
    const selectable = () => (state.items || []).filter(item => item && item.id && !item.archived && item.resource_kind !== 'dataset' && item.pdf);
    function status(text, error = false) { const n = $('challenge-status'); n.textContent = text; n.classList.toggle('error', error); }
    function refreshControls() {
      const count = selected.size;
      trigger.disabled = false;
      trigger.textContent = themes?.themes?.length ? `研究难点 · ${themes.themes.length}` : '研究难点';
      $('challenge-count').textContent = `已选 ${count} / 最多 ${MAX_CORPUS} 篇（当前列表 ${selectable().length} 篇可扫描）`;
      const idle = !busy && !activeStates.has(extract?.status);
      $('challenge-scan').disabled = !count || !idle;
      $('challenge-extract').disabled = !count || !idle || !available;
      $('challenge-extract').textContent = count === 1 ? '抽取这篇难点（模型）' : `抽取第 1 篇难点（模型 · 已选 ${count} 篇）`;
      $('challenge-extract-cancel').hidden = !activeStates.has(extract?.status);
      $('challenge-aggregate').disabled = !count || !idle;
      $('challenge-suggest').disabled = !scope || (themes?.themes?.length || 0) < 2 || !idle || !available;
      $('challenge-export').disabled = !scope || !idle;
      $('challenge-scan').textContent = scan ? '重新扫描候选段落' : '扫描候选段落（无模型）';
    }
    function renderCorpus() {
      const list = $('challenge-items'); list.replaceChildren();
      const items = selectable();
      if (!items.length) { list.append(node('p', '当前列表没有可扫描的文献（需要已关联 PDF 的条目）。', 'small muted')); refreshControls(); return; }
      for (const item of items) {
        const row = node('label', undefined, 'challenge-item'), check = node('input');
        check.type = 'checkbox'; check.checked = selected.has(item.id);
        check.setAttribute('aria-label', `选择 ${item.title || item.id}`);
        check.addEventListener('change', () => {
          if (check.checked && selected.size >= MAX_CORPUS) { check.checked = false; status(`一次最多扫描 ${MAX_CORPUS} 篇；请先缩小语料。`, true); return; }
          if (check.checked) selected.add(item.id); else selected.delete(item.id);
          refreshControls();
        });
        const content = node('span');
        content.append(node('strong', item.title || item.id));
        content.append(node('small', [item.citekey, item.year, item.pdf_filename].filter(Boolean).join(' · ') || item.id));
        row.append(check, content); list.append(row);
      }
      refreshControls();
    }
    function refreshCorpus() {
      const known = new Set(selectable().map(item => item.id));
      for (const id of [...selected]) if (!known.has(id)) selected.delete(id);
      renderCorpus();
      status(selectable().length ? '已按当前列表更新可选文献。' : '当前列表没有可选文献。', !selectable().length);
    }
    function render() {
      const result = $('challenge-result'); result.replaceChildren();
      if (scan) {
        const box = node('section', undefined, 'challenge-section'); box.append(node('h3', 'P1 · 候选段落（无模型）'));
        box.append(node('p', `扫描 ${scan.scope.scanned} 篇 · 候选 ${scan.totals?.candidates ?? scan.papers.reduce((total, paper) => total + paper.candidates.length, 0)} 条 · 零模型调用。`, 'small muted'));
        for (const paper of scan.papers) {
          const detail = node('details');
          detail.append(node('summary', `${paper.title || paper.id} · ${paper.candidates.length} 条候选 · 小节 ${paper.sections_used.join('、') || '未识别'}`));
          for (const candidate of paper.candidates.slice(0, 12)) detail.append(node('blockquote', `${candidate.quote}`), node('p', `第 ${candidate.page} 页 · 命中 ${candidate.rules.join('、')}`, 'small muted'));
          if (paper.skipped || paper.reason) detail.append(node('p', paper.reason || '这篇论文没有可用小节。', 'small muted'));
          box.append(detail);
        }
        for (const skipped of scan.scope.skipped || []) box.append(node('p', `${skipped.id}：${skipped.reason}`, 'small muted'));
        result.append(box);
      }
      if (extract) {
        const box = node('section', undefined, 'challenge-section'); box.append(node('h3', 'P2 · 难点抽取（模型，待核对）'));
        box.append(node('p', [extract.stage, extract.error, ...(extract.warnings || [])].filter(Boolean).join(' · ') || extract.status, 'small muted'));
        if (extract.model) box.append(node('p', `${extract.model.provider} / ${extract.model.model}`, 'small muted'));
        if (extract.draft) { const detail = node('details'); detail.open = true; detail.append(node('summary', extract.draft.title || '难点草稿'), node('p', `${extract.draft.status} · 节点 ${extract.draft.nodes?.length || 0} · 关系 ${(extract.draft.edges?.length || 0) + (extract.draft.assertions?.length || 0)}`, 'small muted')); for (const value of extract.draft.nodes || []) { const row = node('article', undefined, 'challenge-record'); row.append(node('strong', value.label), node('span', `${value.type}${value.source_status ? ` · ${value.source_status}` : ''}`, 'small muted')); if (value.quote) row.append(node('blockquote', value.quote)); detail.append(row); } box.append(detail); }
        else if (extract.error) box.append(node('p', '失败或中断不会重放模型调用；可重新开始一次新的抽取。', 'small muted'));
        result.append(box);
      }
      if (themes) {
        const box = node('section', undefined, 'challenge-section'); box.append(node('h3', 'P3 · 主题草稿（待审阅）'));
        box.append(node('p', `聚合 ${themes.scope.scanned} 篇 · 难点记录 ${themes.totals.records} 条 · 主题 ${themes.totals.themes} 个 · 零模型调用。`, 'small muted'));
        if (!themes.themes.length) box.append(node('p', '没有可聚合的难点记录：请先抽取并核对单篇难点草稿。', 'small muted'));
        for (const theme of themes.themes) {
          const row = node('article', undefined, 'challenge-theme');
          row.append(node('strong', theme.label));
          row.append(node('p', `覆盖 ${theme.paper_count} 篇 / ${theme.record_count} 条记录 · 年份 ${theme.years.min ?? '—'}–${theme.years.max ?? '—'} · 证据 ${theme.evidence_count} 条 · ${theme.status === 'accepted' ? '已核对' : theme.status === 'merged' ? '已合并' : theme.status === 'rejected' ? '已否决' : '待核对'}`, 'small muted'));
          row.append(node('p', `source_status：author-stated ${theme.source_status['author-stated']} · reviewed-stated ${theme.source_status['reviewed-stated']} · inferred ${theme.source_status.inferred}`, 'small muted'));
          if (theme.variants?.length) row.append(node('p', `归一化变体：${theme.variants.join('；')}`, 'small muted'));
          for (const paper of theme.papers.slice(0, 10)) for (const quote of (paper.quotes || []).slice(0, 3)) row.append(node('blockquote', `[@${paper.citekey}${quote.page ? ` p.${quote.page}` : ''}] ${quote.quote ?? '（缺少逐字引用）'}`));
          if (theme.status === 'needs-review') row.append(button(`challenge-accept-${theme.id}`, '核对后接受', () => void review(theme, 'accepted')), button(`challenge-reject-${theme.id}`, '否决', () => void review(theme, 'rejected')));
          box.append(row);
        }
        const suggestions = themes.merge_suggestions || [];
        if (suggestions.length) {
          const merge = node('details'); merge.open = true; merge.append(node('summary', `待确认的合并建议 · ${suggestions.length}`));
          for (const suggestion of suggestions) {
            const byId = new Map(themes.themes.map(theme => [theme.id, theme]));
            const left = byId.get(suggestion.left), right = byId.get(suggestion.right);
            const row = node('div', undefined, 'challenge-suggestion');
            row.append(node('p', `${left?.label || suggestion.left} ↔ ${right?.label || suggestion.right}（相似度 ${suggestion.jaccard}）`, 'small muted'));
            row.append(button(`challenge-merge-${suggestion.left}-${suggestion.right}`, '合并这两个主题', () => void mergeThemes([left, right])));
            merge.append(row);
          }
          box.append(merge);
        }
        result.append(box);
      }
      if (suggest) {
        const box = node('section', undefined, 'challenge-section'); box.append(node('h3', 'P3 · 模型合并建议（待人工确认）'));
        box.append(node('p', `${suggest.status} · ${suggest.stage || ''}${suggest.error ? ` · ${suggest.error}` : ''}`, 'small muted'));
        if (suggest.model) box.append(node('p', `${suggest.model.provider} / ${suggest.model.model}`, 'small muted'));
        for (const group of suggest.groups || []) {
          const row = node('div', undefined, 'challenge-suggestion');
          row.append(node('strong', group.label), node('p', group.reason || '模型未给出理由', 'small muted'));
          row.append(node('p', group.members.join(' · '), 'small muted'));
          const byId = new Map((themes?.themes || []).map(theme => [theme.id, theme]));
          const members = group.members.map(id => byId.get(id)).filter(Boolean);
          row.append(button(`challenge-merge-group-${group.key}`, '合并这一组', () => void mergeThemes(members)));
          box.append(row);
        }
        if (suggest.status === 'complete' && !(suggest.groups || []).length) box.append(node('p', '模型没有提出合并建议；主题保持独立。', 'small muted'));
        result.append(box);
      }
      refreshControls();
    }
    function schedulePoll() {
      clearTimeout(timer);
      if (disposed || document.hidden || !activeStates.has(extract?.status) || !workingId) return;
      timer = setTimeout(() => void pollExtract(), 1500);
    }
    async function pollExtract() {
      const ticket = epoch, id = workingId, requestId = extract.request_id;
      try {
        const value = await api('challenge_extract_get', { id, request_id: requestId });
        if (ticket !== epoch || id !== workingId || value.request_id !== requestId) return;
        extract = value; render(); schedulePoll();
        if (value.status === 'complete') status('难点草稿已生成（AI 生成 · 待核对）；可在知识工作流中审阅。');
        else if (['failed', 'cancelled', 'interrupted'].includes(value.status)) status(value.error || value.stage || '抽取已停止', true);
      } catch (error) { if (ticket === epoch) status(error.message, true); }
    }
    async function runScan() {
      if (busy || !ids().length) return;
      busy = true; refreshControls(); status('正在扫描小节与触发句（无模型）…');
      try { const value = await api('challenge_scan', { ids: ids() }); scan = value; extract = null; render(); status(`候选段落已生成：${value.papers.reduce((total, paper) => total + paper.candidates.length, 0)} 条，零模型调用。`); }
      catch (error) { status(error.message, true); }
      finally { busy = false; refreshControls(); }
    }
    async function runExtract() {
      if (!available) { status('抽取难点需要 DSH 后台子代理；请从 DSH 面板打开本插件。', true); return; }
      if (ids().length !== 1) { status('P2 一次只抽取一篇：请只勾选一篇文献（其余文献可复制同一请求后逐篇运行）。', true); return; }
      const ticket = epoch, id = ids()[0];
      workingId = id; status('正在排队抽取难点（使用这篇论文的 DSH 模型额度）…');
      try {
        const value = await api('challenge_extract_start', { id, request_id: crypto.randomUUID(), ...(state.harnessContext?.sessionId ? { source_session_id: state.harnessContext.sessionId } : {}) });
        if (ticket !== epoch) return;
        extract = value; render(); schedulePoll();
      } catch (error) { if (ticket === epoch) status(error.message, true); }
    }
    async function cancelExtract() {
      if (!workingId || !extract) return;
      try { const value = await api('challenge_extract_cancel', { id: workingId, request_id: extract.request_id }); extract = value; render(); }
      catch (error) { status(error.message, true); }
    }
    async function runThemes({ quiet = false } = {}) {
      if (busy || !ids().length) return;
      busy = true; refreshControls(); if (!quiet) status('正在聚合已保存的难点草稿（无模型）…');
      try {
        const value = await api('challenge_themes', { ids: ids() });
        themes = value; scope = value.scope.hash; render();
        if (!quiet) status(value.totals.themes ? `聚合出 ${value.totals.themes} 个主题（待核对）；覆盖 ${value.totals.records} 条难点记录。` : '没有已核对的难点记录可聚合；请先在知识工作流中接受单篇难点草稿。', !value.totals.themes);
      } catch (error) { status(error.message, true); }
      finally { busy = false; refreshControls(); }
    }
    async function review(theme, decision) {
      try {
        const value = await api('challenge_theme_review', { id: theme.id, decision, reviewed_by: 'user', expected_revision: theme.revision });
        await runThemes({ quiet: true });
        status(decision === 'accepted' ? `主题已接受（修订 ${value.revision}），可导出。` : '主题已否决，记录保留。');
      } catch (error) { status(`主题未更新：${error.message}`, true); }
    }
    async function mergeThemes(members) {
      if (merging) return;
      const usable = (members || []).filter(Boolean);
      if (usable.length < 2) { status('至少需要两个可合并的主题。', true); return; }
      merging = true; refreshControls();
      try {
        const value = await api('challenge_theme_merge', { theme_ids: usable.map(theme => theme.id), expected_revisions: usable.map(theme => theme.revision), reviewed_by: 'user' });
        await runThemes({ quiet: true });
        status(`已合并为「${value.label}」（待核对，覆盖 ${value.paper_count} 篇）。`);
      } catch (error) { status(`合并未完成：${error.message}`, true); }
      finally { merging = false; refreshControls(); }
    }
    async function runSuggest() {
      if (!available) { status('模型合并建议需要 DSH 后台子代理。', true); return; }
      if (!themes?.themes?.length || !scope) { status('先生成主题草稿。', true); return; }
      const candidates = themes.themes.filter(theme => theme.status === 'needs-review').slice(0, MAX_THEMES);
      if (candidates.length < 2) { status('至少需要两个待核对主题才能比较。', true); return; }
      const anchor = ids()[0];
      busy = true; refreshControls(); status('正在用所选论文的模型比较主题标签…');
      try {
        const value = await api('challenge_theme_suggest_start', { id: anchor, scope, request_id: crypto.randomUUID(), theme_ids: candidates.map(theme => theme.id) });
        suggest = value; render(); scheduleSuggestPoll();
      } catch (error) { status(error.message, true); }
      finally { busy = false; refreshControls(); }
    }
    function scheduleSuggestPoll() {
      clearTimeout(timer);
      if (disposed || document.hidden || !['queued', 'reading', 'generating'].includes(suggest?.status)) return;
      timer = setTimeout(async () => {
        try { suggest = await api('challenge_theme_suggest_get', { scope, request_id: suggest.request_id }); render(); status(suggest.status === 'complete' ? `模型提出 ${(suggest.groups || []).length} 组合并建议（待人工确认）。` : suggest.error || suggest.stage || '', Boolean(suggest.error)); }
        catch (error) { status(error.message, true); }
        scheduleSuggestPoll();
      }, 1500);
    }
    async function runExport() {
      if (!scope) { status('先生成主题草稿。', true); return; }
      busy = true; refreshControls(); status('正在写入 exports/ …');
      try {
        const value = await api('challenge_export', { ids: ids(), scope, ...(themes?.merge_suggestions?.length ? { merge_suggestions: themes.merge_suggestions } : {}) });
        const box = node('section', undefined, 'challenge-section');
        box.append(node('h3', '导出完成'), node('p', `主题 ${value.themes} 个 · 记录行 ${value.rows} 行 · 引用 ${value.citekeys.length} 篇`, 'small muted'));
        for (const file of Object.values(value.files || {})) box.append(node('p', `${file.path}（${file.bytes} 字节）`, 'small muted'));
        box.append(node('p', '只有已接受的主题进入导出；needs-review 主题需勾选包含才会写入。', 'small muted'));
        $('challenge-result').append(box);
        status('已写入文献库 exports/ 目录。');
      } catch (error) { status(`导出未完成：${error.message}`, true); }
      finally { busy = false; refreshControls(); }
    }
    async function open() {
      panel.hidden = false; ++epoch; renderCorpus(); render();
      if (!scan && !themes) status('选择语料后先运行 P1 扫描；P2 与 P3 需要已保存的难点草稿。');
    }
    function toggle() { if (panel.hidden) void open(); else panel.hidden = true; }
    function sync() { if (!panel.hidden) refreshCorpus(); refreshControls(); }
    function setAvailable(value) { available = Boolean(value); refreshControls(); }
    const visibility = () => { if (!document.hidden && !panel.hidden) sync(); };
    document.addEventListener('visibilitychange', visibility);
    renderCorpus();
    return {
      open, toggle, sync, setAvailable,
      get visible() { return !panel.hidden; },
      dispose() { disposed = true; clearTimeout(timer); document.removeEventListener('visibilitychange', visibility); panel.remove(); trigger.remove(); },
    };
  }
  return { create };
})();
