import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../web/challenge-mining.js', import.meta.url), 'utf8');

let ids = new Map();

class Element {
  constructor(tag = 'div') { this.tagName = tag.toUpperCase(); this.children = []; this.value = ''; this.hidden = false; this.dataset = {}; this.attributes = {}; this.events = new Map(); this.textContent = ''; const classes = new Set(); this.classList = { add: (...names) => names.forEach(name => classes.add(name)), remove: (...names) => names.forEach(name => classes.delete(name)), contains: name => classes.has(name), toggle: (name, on) => { if (on === undefined) on = !classes.has(name); if (on) classes.add(name); else classes.delete(name); return on; } }; }
  set id(value) { this._id = value; ids.set(value, this); } get id() { return this._id; }
  set innerHTML(value) { this._html = value; for (const match of value.matchAll(/id="([^"]+)"/g)) { const created = new Element('div'); created.id = match[1]; this.children.push(created); } }
  get innerHTML() { return this._html || ''; }
  set className(value) { this._className = value; this.classList.add(...String(value).split(/\s+/).filter(Boolean)); } get className() { return this._className; }
  replaceChildren(...nodes) { for (const child of this.children) child.parentNode = null; this.children = []; this.append(...nodes); }
  append(...nodes) { for (const n of nodes) { if (n.parentNode) n.remove(); n.parentNode = this; this.children.push(n); } }
  appendChild(n) { this.append(n); return n; }
  insertBefore(n, next) { const index = this.children.indexOf(next); if (index < 0) this.children.push(n); else this.children.splice(index, 0, n); n.parentNode = this; return n; }
  remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(n => n !== this); this.parentNode = null; }
  addEventListener(type, fn) { if (!this.events.has(type)) this.events.set(type, new Set()); this.events.get(type).add(fn); }
  removeEventListener(type, fn) { this.events.get(type)?.delete(fn); }
  dispatch(type, args = {}) { const event = { target: this, preventDefault() { this.defaultPrevented = true; }, ...args }; for (const fn of this.events.get(type) || []) fn(event); return event; }
  setAttribute(key, value) { this.attributes[key] = String(value); } getAttribute(key) { return this.attributes[key] ?? null; }
  click() { if (!this.disabled) this.dispatch('click'); }
  querySelector() { return null; }
  /** Depth-first lookup by id, mirroring how the module reaches its own nodes. */
  find(id) { if (this._id === id) return this; for (const child of this.children) { const found = child.find?.(id); if (found) return found; } return null; }
}

function environment({ items = [], status = {}, results = {} } = {}) {
  ids = new Map();
  const calls = [], toasts = [], timers = [];
  const body = new Element('body'), shelf = new Element('div'), refresh = new Element('button');
  shelf.className = 'shelf-actions'; refresh.id = 'refresh'; body.append(shelf);
  const state = { items, harnessContext: { sessionId: 'session-a' } };
  const api = async (action, payload) => {
    calls.push({ action, payload: JSON.parse(JSON.stringify(payload ?? null)) });
    const handler = results[action];
    if (typeof handler === 'function') return handler(payload);
    if (handler instanceof Error) throw handler;
    if (handler === undefined) throw new Error(`Unexpected ${action}`);
    return handler;
  };
  const document = { body, hidden: false, createElement: tag => new Element(tag), querySelector: selector => (selector === '.shelf-actions' ? shelf : null), getElementById: id => body.find(id), addEventListener() {}, removeEventListener() {} };
  const window = { document };
  vm.runInNewContext(source, { window, document, crypto: { randomUUID: () => 'request-1' }, setTimeout: (fn) => { timers.push(fn); return timers.length; }, clearTimeout() {} }, { filename: 'web/challenge-mining.js' });
  const ui = window.ChallengeMining.create({ state, api, toast: (...args) => toasts.push(args) });
  return { ui, body, shelf, ids, calls, toasts, timers, get: id => body.find(id), status: () => body.find('challenge-status').textContent, result: () => body.find('challenge-result') };
}

function allText(element) { return [element.textContent || '', ...(element.children || []).map(allText)].join(' '); }

const paper = (id, extra = {}) => ({ id, title: `Synthetic ${id}`, citekey: `${id}2026`, pdf: true, pdf_filename: `${id}.pdf`, ...extra });

test('the panel only mines an explicit corpus and reports P1 receipts without a model call', async () => {
  const f = environment({ items: [paper('paper-a'), paper('paper-b'), paper('sheet', { resource_kind: 'dataset' }), paper('paper-c', { pdf: false })], results: {
    challenge_scan: payload => ({ schema: 'paper-library-challenge-candidates.v1', model_calls: 0, scope: { requested: payload.ids.length, scanned: payload.ids.length, skipped: [] }, papers: payload.ids.map(id => ({ id, title: `Synthetic ${id}`, sections_used: ['discussion'], candidates: [{ page: 4, quote: 'A key limitation is synthetic coverage.', rules: ['en-limitation'] }] })) }),
  } });
  assert.equal(f.shelf.find('challenge-open').textContent, '研究难点');
  assert.equal(f.get('challenge-panel').hidden, true);
  f.get('challenge-open').click();
  assert.equal(f.get('challenge-panel').hidden, false);
  assert.equal(f.get('challenge-items').children.length, 2, 'Datasets and PDF-less records are not selectable');
  assert.match(f.status(), /先运行 P1 扫描/);
  f.get('challenge-scan').click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.length, 0, 'An empty corpus never reaches the host');
  const boxes = f.get('challenge-items').children;
  boxes[0].children[0].checked = true; boxes[0].children[0].dispatch('change');
  f.get('challenge-scan').click();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.calls.at(-1).payload.ids, ['paper-a']);
  assert.match(allText(f.result()), /P1 · 候选段落/);
  assert.match(f.status(), /1 条/);
});

test('P2 refuses a multi-paper corpus, then polls one isolated extraction', async () => {
  const f = environment({ items: [paper('paper-a'), paper('paper-b')], results: {
    challenge_extract_start: { status: 'queued', request_id: 'request-1', stage: '已排队' },
    challenge_extract_get: { status: 'complete', request_id: 'request-1', stage: '抽取完成', draft_id: 'kd-1', model: { provider: 'synthetic', model: 'challenge-model' }, draft: { title: '研究难点', status: 'needs-review', nodes: [{ type: 'gap', id: 'coverage', label: '合成评测只覆盖一个城市', source_status: 'author-stated', quote: 'A key limitation is synthetic coverage.' }], edges: [], assertions: [] } },
    challenge_extract_cancel: { status: 'cancelled', request_id: 'request-1' },
  } });
  f.get('challenge-open').click();
  const boxes = f.get('challenge-items').children;
  for (const box of boxes) { box.children[0].checked = true; box.children[0].dispatch('change'); }
  f.ui.setAvailable(false);
  assert.equal(f.get('challenge-extract').disabled, true, 'Extraction stays disabled without the host subagent');
  assert.equal(f.calls.length, 0);
  f.ui.setAvailable(true);
  f.get('challenge-extract').click();
  await new Promise(resolve => setImmediate(resolve));
  assert.match(f.status(), /一次只抽取一篇/);
  assert.equal(f.calls.length, 0);
  boxes[1].children[0].checked = false; boxes[1].children[0].dispatch('change');
  f.get('challenge-extract').click();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.calls.at(-1), { action: 'challenge_extract_start', payload: { id: 'paper-a', request_id: 'request-1', source_session_id: 'session-a' } });
  assert.equal(f.timers.length, 1, 'Polling is scheduled once');
  f.timers[0]();
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  assert.match(f.status(), /难点草稿已生成/);
  assert.match(allText(f.result()), /P2 · 难点抽取/);
});

test('P3 keeps themes pending review, merges with revisions and exports only after acceptance', async () => {
  const theme = (id, label, extra = {}) => ({ id, key: label.toLowerCase(), label, variants: [], paper_count: 1, record_count: 1, years: { min: 2026, max: 2026, histogram: { 2026: 1 } }, source_status: { 'author-stated': 1, 'reviewed-stated': 0, inferred: 0 }, evidence_count: 1, quotes: [{ page: 2, quote: 'A key limitation is synthetic coverage.' }], papers: [{ paper_id: 'paper-a', citekey: 'paper-a2026', year: 2026, node_id: 'gap:coverage', label, source_status: 'author-stated', draft_id: 'kd-1', draft_status: 'accepted', quotes: [{ page: 2, quote: 'A key limitation is synthetic coverage.' }] }], status: 'needs-review', revision: 1, ...extra });
  const themesPayload = { scope: { hash: 'a'.repeat(64), scanned: 1, skipped: [], include: 'accepted' }, totals: { records: 2, themes: 2, persisted: 2 }, merge_suggestions: [{ left: 'ct-' + 'a'.repeat(24), right: 'ct-' + 'b'.repeat(24), jaccard: 0.75, labels: ['one', 'two'] }], themes: [theme('ct-' + 'a'.repeat(24), '合成评测只覆盖一个城市'), theme('ct-' + 'b'.repeat(24), 'Synthetic evaluation covers a single city')], model_calls: 0 };
  const f = environment({ items: [paper('paper-a')], results: {
    challenge_themes: themesPayload,
    challenge_theme_review: payload => ({ ...themesPayload.themes[0], status: payload.decision, revision: 2 }),
    challenge_theme_merge: payload => ({ ...themesPayload.themes[0], id: 'ct-' + 'c'.repeat(24), label: '单一城市评测', merged_from: payload.theme_ids, paper_count: 2, revision: 1 }),
    challenge_export: { schema: 'paper-library-challenge-export.v1', scope: 'a'.repeat(64), themes: 1, rows: 2, citekeys: ['paper-a2026'], files: { 'challenges.csv': { path: '/synthetic/library/exports/challenges.csv', bytes: 120 } } },
  } });
  f.ui.setAvailable(true);
  f.get('challenge-open').click();
  const box = f.get('challenge-items').children[0]; box.children[0].checked = true; box.children[0].dispatch('change');
  f.get('challenge-aggregate').click();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(f.calls.at(-1), { action: 'challenge_themes', payload: { ids: ['paper-a'] } });
  assert.match(f.status(), /2 个主题（待核对）/);
  const rendered = () => allText(f.result());
  assert.match(rendered(), /待核对/, 'Themes are shown as pending review');
  assert.match(rendered(), /author-stated 1/, 'Coverage counters are rendered');
  const acceptButton = f.body.find(`challenge-accept-ct-${'a'.repeat(24)}`);
  acceptButton.click();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(f.calls.at(-2), { action: 'challenge_theme_review', payload: { id: 'ct-' + 'a'.repeat(24), decision: 'accepted', reviewed_by: 'user', expected_revision: 1 } });
  const mergeButton = f.body.find(`challenge-merge-ct-${'a'.repeat(24)}-ct-${'b'.repeat(24)}`);
  mergeButton.click();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(f.calls.at(-2), { action: 'challenge_theme_merge', payload: { theme_ids: ['ct-' + 'a'.repeat(24), 'ct-' + 'b'.repeat(24)], expected_revisions: [1, 1], reviewed_by: 'user' } });
  assert.match(f.status(), /已合并为「单一城市评测」/);
  f.get('challenge-export').click();
  await new Promise(resolve => setTimeout(resolve, 0));
  const exportCall = f.calls.at(-1);
  assert.equal(exportCall.action, 'challenge_export');
  assert.deepEqual(exportCall.payload.ids, ['paper-a']);
  assert.equal(exportCall.payload.scope, 'a'.repeat(64));
  assert.equal(exportCall.payload.merge_suggestions.length, 1);
  assert.match(f.status(), /已写入文献库 exports\//);
});

test('model merge suggestions stay optional, bounded and pending review', async () => {
  const themesPayload = { scope: { hash: 'b'.repeat(64), scanned: 1, skipped: [], include: 'accepted' }, totals: { records: 2, themes: 2, persisted: 2 }, merge_suggestions: [], themes: [{ id: 'ct-' + 'a'.repeat(24), key: 'one', label: 'one', variants: [], paper_count: 1, record_count: 1, years: { min: 2026, max: 2026, histogram: { 2026: 1 } }, source_status: { 'author-stated': 1, 'reviewed-stated': 0, inferred: 0 }, evidence_count: 0, quotes: [], papers: [], status: 'needs-review', revision: 1 }, { id: 'ct-' + 'b'.repeat(24), key: 'two', label: 'two', variants: [], paper_count: 1, record_count: 1, years: { min: 2026, max: 2026, histogram: { 2026: 1 } }, source_status: { 'author-stated': 1, 'reviewed-stated': 0, inferred: 0 }, evidence_count: 0, quotes: [], papers: [], status: 'needs-review', revision: 1 }], model_calls: 0 };
  const f = environment({ items: [paper('paper-a')], results: {
    challenge_themes: themesPayload,
    challenge_theme_suggest_start: { status: 'queued', request_id: 'request-1', scope: 'b'.repeat(64), theme_count: 2, groups: [] },
    challenge_theme_suggest_get: { status: 'complete', request_id: 'request-1', scope: 'b'.repeat(64), theme_count: 2, model: { provider: 'synthetic', model: 'merge-model' }, groups: [{ key: 'single-city', label: '单一城市评测', members: ['ct-' + 'a'.repeat(24), 'ct-' + 'b'.repeat(24)], reason: 'Same evaluation target', status: 'needs-review' }] },
  } });
  f.ui.setAvailable(false);
  f.get('challenge-open').click();
  const box = f.get('challenge-items').children[0]; box.children[0].checked = true; box.children[0].dispatch('change');
  f.get('challenge-aggregate').click();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(f.get('challenge-suggest').disabled, true, 'Model suggestions stay disabled without the host subagent');
  const before = f.calls.length;
  f.ui.setAvailable(true);
  f.get('challenge-suggest').click();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(f.calls.length, before + 1);
  assert.equal(f.calls.at(-1).action, 'challenge_theme_suggest_start');
  assert.deepEqual(f.calls.at(-1).payload.theme_ids, ['ct-' + 'a'.repeat(24), 'ct-' + 'b'.repeat(24)]);
  f.timers.at(-1)();
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  assert.match(f.status(), /提出 1 组合并建议（待人工确认）/);
  assert.match(allText(f.result()), /Same evaluation target/);
  assert.match(allText(f.result()), /待人工确认/);
  const mergeGroup = f.body.find('challenge-merge-group-single-city');
  assert.ok(mergeGroup, 'Each suggested group offers an explicit merge');
  mergeGroup.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.at(-1).action, 'challenge_theme_merge', 'Applying a model suggestion still uses the reviewed merge path');
  assert.deepEqual(f.calls.at(-1).payload.expected_revisions, [1, 1]);
});

test('P4 review controls check structure, compare a checklist and write the packet', async () => {
  const theme = { id: 'ct-' + 'a'.repeat(24), key: 'single city', label: '合成评测只覆盖一个城市', variants: [], paper_count: 1, record_count: 1, years: { min: 2026, max: 2026, histogram: { 2026: 1 } }, source_status: { 'author-stated': 1, 'reviewed-stated': 0, inferred: 0 }, evidence_count: 1, quotes: [{ page: 2, quote: 'A key limitation is synthetic coverage.' }], papers: [{ paper_id: 'paper-a', citekey: 'paper-a2026', year: 2026, node_id: 'gap:coverage', label: '合成评测只覆盖一个城市', source_status: 'author-stated', draft_id: 'kd-1', draft_status: 'accepted', quotes: [{ page: 2, quote: 'A key limitation is synthetic coverage.' }] }], status: 'needs-review', revision: 1 };
  const themesPayload = { scope: { hash: 'd'.repeat(64), scanned: 1, skipped: [], include: 'accepted' }, totals: { records: 1, themes: 1, persisted: 1 }, merge_suggestions: [], themes: [theme], model_calls: 0 };
  const comparisonPayload = { id: 'cc-' + 'b'.repeat(24), scope: 'd'.repeat(64), checklist: { source: '我的清单 (pasted text)', date: '2026-09-17', origin: 'user-text', entries: ['synthetic coverage'] }, counts: { entries: 1, covered: 1, partial: 0, gaps: 0, themes: 1, unmatched_themes: 0 }, entries: [{ entry: 'synthetic coverage', status: 'covered', best_overlap: 0.6, matches: [{ theme_id: theme.id, label: theme.label, status: 'needs-review', overlap: 0.6 }] }], themes: [], gaps: [], unmatched_themes: [], manual_review_note: '匹配只比较词面重叠；κ 一类结论必须由人独立完成。', model_calls: 0 };
  const f = environment({ items: [paper('paper-a')], results: {
    challenge_themes: themesPayload,
    challenge_theme_check: { schema: 'paper-library-challenge-theme-check.v1', scope: 'd'.repeat(64), themes: 1, counts: { error: 0, warning: 1, info: 1 }, by_status: { 'needs-review': 1 }, findings: [{ theme_id: theme.id, label: theme.label, status: 'needs-review', code: 'theme-single-paper', severity: 'warning', message: '主题只覆盖 1 篇文献，尚不构成跨篇结论。' }], truncated: false, model_calls: 0 },
    challenge_comparison: comparisonPayload,
    challenge_review_packet: { schema: 'paper-library-challenge-review-packet.v1', scope: 'd'.repeat(64), themes: 1, counts: { error: 0, warning: 1, info: 1 }, comparison: comparisonPayload.id, files: { 'challenges-review-packet.md': { path: '/synthetic/library/exports/challenges-review-packet.md', bytes: 2048 } }, model_calls: 0 },
  } });
  f.ui.setAvailable(true);
  f.get('challenge-open').click();
  const box = f.get('challenge-items').children[0]; box.children[0].checked = true; box.children[0].dispatch('change');
  f.get('challenge-aggregate').click();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(f.get('challenge-comparison').disabled, false, 'Review controls unlock once a scope exists');
  f.get('challenge-check').click();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(f.calls.at(-1), { action: 'challenge_theme_check', payload: { scope: 'd'.repeat(64) } });
  assert.match(f.status(), /1 警告 · 1 提示/);
  assert.match(allText(f.result()), /theme-single-paper/);
  f.get('challenge-checklist').value = '# 我的清单\n- synthetic coverage\n';
  f.get('challenge-checklist-label').value = '我的清单';
  f.get('challenge-comparison').click();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(f.calls.at(-1).action, 'challenge_comparison');
  assert.deepEqual(f.calls.at(-1).payload.ids, ['paper-a']);
  assert.equal(f.calls.at(-1).payload.checklist_text, '# 我的清单\n- synthetic coverage', 'Checklist text is trimmed before it is sent');
  assert.equal(f.calls.at(-1).payload.checklist_label, '我的清单');
  assert.match(f.status(), /覆盖 1/);
  assert.match(allText(f.result()), /κ/);
  f.get('challenge-packet').click();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(f.calls.at(-1).action, 'challenge_review_packet');
  assert.equal(f.calls.at(-1).payload.comparison_id, comparisonPayload.id);
  assert.match(f.status(), /评审包已写入 exports\//);
  assert.match(allText(f.result()), /challenges-review-packet\.md/);
});
