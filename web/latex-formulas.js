'use strict';
/** Saved-source formula inventory. Local syntax checks never claim a proof. */
window.PaperLatexFormulas = (() => {
  function create({ host, api, getProject, onLocate, beforeRefresh = async () => true }) {
    const make = (tag, cls, text) => { const node = document.createElement(tag); if (cls) node.className = cls; if (text !== undefined) node.textContent = text; return node; };
    let sequence = 0, disposed = false, projectId = null, result = null;
    host.hidden = true; host.setAttribute('aria-label', '公式提取与检查');
    const head = make('div', 'latex-formula-head');
    const title = make('strong', '', '公式检查');
    const refreshButton = make('button', 'button subtle', '重新提取'); refreshButton.type = 'button'; refreshButton.id = 'latex-formula-refresh';
    const closeButton = make('button', 'button subtle', '关闭'); closeButton.type = 'button'; closeButton.id = 'latex-formula-close';
    head.append(title, refreshButton, closeButton);
    const boundary = make('p', 'small muted', '从已保存的项目 .tex 文件提取公式，检查分隔符、花括号与公式引用；不展开宏、不判断数学推导是否正确。未参与编译的 .tex 文件也会列入。');
    const status = make('p', 'latex-formula-status'); status.id = 'latex-formula-status'; status.setAttribute('role', 'status');
    const filter = make('select'); filter.id = 'latex-formula-filter'; filter.setAttribute('aria-label', '公式列表筛选');
    for (const [value, text] of [['all', '全部公式'], ['issues', '只看待核对']]) { const option = make('option', '', text); option.value = value; filter.append(option); }
    const issues = make('div', 'latex-formula-issues'); issues.id = 'latex-formula-issues';
    const list = make('div', 'latex-formula-list'); list.id = 'latex-formula-list';
    host.append(head, boundary, status, filter, issues, list);
    function say(text, error = false) { status.textContent = text; status.classList.toggle('error', error); }
    function locate(value) {
      return async () => {
        if (projectId !== getProject()?.id) { clear(); say('项目已切换，请重新提取当前项目的公式。'); return; }
        try { await onLocate({ path: value.path, line: value.line }); }
        catch (error) { say(`暂时无法定位：${error.message}。当前源码草稿已保留。`, true); }
      };
    }
    function render() {
      issues.textContent = ''; list.textContent = '';
      if (!result) return;
      if (result.issues?.length) {
        const group = make('details', 'latex-formula-findings'); group.open = true;
        group.append(make('summary', '', `待核对项（${result.summary?.issues ?? result.issues.length}）`));
        for (const issue of result.issues) {
          const row = make('div', `latex-formula-issue ${issue.severity === 'error' ? 'error' : ''}`);
          const button = make('button', 'button subtle', `${issue.path}:${issue.line}`); button.type = 'button'; button.addEventListener('click', locate(issue));
          row.append(button, make('span', '', `${issue.severity === 'error' ? '错误' : '提示'} · ${issue.message}`)); group.append(row);
        }
        issues.append(group);
      }
      for (const formula of result.formulas || []) {
        const findings = (result.issues || []).filter(issue => issue.formula_id === formula.id || (issue.path === formula.path && issue.line >= formula.line && issue.line <= formula.end_line));
        if (filter.value === 'issues' && !findings.length) continue;
        const card = make('details', 'latex-formula-card'); card.dataset.formulaId = formula.id;
        const summary = make('summary', '', `${formula.path}:${formula.line} · ${formula.kind}${formula.labels?.length ? ` · ${formula.labels.join(', ')}` : ''}${findings.length ? ` · ${findings.length} 项待核对` : ''}`);
        const source = make('pre', 'latex-formula-source', formula.source);
        const button = make('button', 'button subtle', '定位源码'); button.type = 'button'; button.addEventListener('click', locate(formula));
        card.append(summary, source, button);
        if (formula.source_truncated) card.append(make('small', 'muted', '此公式较长，仅展示前段；点击定位查看完整源码。'));
        list.append(card);
      }
      if (!list.children.length) list.append(make('p', 'muted', filter.value === 'issues' ? '没有符合当前筛选的公式；独立的引用提示见上方。' : '未提取到常见的行内或独立公式。宏生成的公式需要编译后人工核对。'));
    }
    async function refresh() {
      const ticket = ++sequence;
      refreshButton.disabled = true; say('保存当前编辑并提取公式…');
      try {
        if (await beforeRefresh() === false) { if (ticket === sequence) say('当前源码尚未保存，检查已暂停。请先处理保存失败或冲突。', true); return; }
        if (disposed || ticket !== sequence) return;
        const id = getProject()?.id;
        if (!id) { clear(); say('先选择一个 LaTeX 项目。'); return; }
        if (projectId !== id) { result = null; issues.textContent = ''; list.textContent = ''; }
        projectId = id;
        const value = await api('latex_formula_check', { id });
        if (disposed || ticket !== sequence || getProject()?.id !== id) return;
        result = value; render();
        const summary = value.summary || {};
        say(`${value.files_checked || 0} 个源文件 · ${summary.formulas || 0} 个公式 · ${summary.errors || 0} 个错误 · ${summary.warnings || 0} 个提示${value.limited ? ' · 达到检查或显示上限，覆盖不完整' : ''}。${!summary.errors && !summary.warnings ? '未发现静态问题；仍需核对符号含义与推导。' : ''}`, Boolean(summary.errors));
      } catch (error) { if (!disposed && ticket === sequence) say(`公式检查未完成：${error.message}。可重新提取；已有结果保留。`, true); }
      finally { if (ticket === sequence) refreshButton.disabled = false; }
    }
    function clear() { result = null; projectId = null; issues.textContent = ''; list.textContent = ''; }
    refreshButton.addEventListener('click', () => void refresh());
    closeButton.addEventListener('click', () => { host.hidden = true; });
    filter.addEventListener('change', render);
    return { open: () => { host.hidden = false; return refresh(); }, close: () => { host.hidden = true; }, refresh, clear,
      destroy: () => { disposed = true; ++sequence; host.textContent = ''; },
      testHooks: { result: () => result } };
  }
  return { create };
})();
