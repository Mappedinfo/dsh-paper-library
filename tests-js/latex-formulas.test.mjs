import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../web/latex-formulas.js', import.meta.url), 'utf8');
function fixture(options = {}) {
  const ids = new Map();
  class Element {
    constructor(tag) { this.tagName = tag; this.children = []; this.events = new Map(); this.dataset = {}; this.classList = { toggle() {} }; this.value = ''; }
    set id(value) { this._id = value; ids.set(value, this); }
    set textContent(value) { this._text = value; this.children = []; }
    get textContent() { return this._text ?? this.children.map(node => node.textContent).join(''); }
    append(...nodes) { this._text = undefined; this.children.push(...nodes); }
    setAttribute() {}
    addEventListener(type, fn) { this.events.set(type, fn); }
  }
  const window = {}, document = { createElement: tag => new Element(tag) };
  vm.runInNewContext(source, { window, document });
  const host = new Element('section'), state = { id: 'synthetic-a' }, locations = [];
  const ui = window.PaperLatexFormulas.create({ host, api: async () => ({ files_checked: 0, formulas: [], issues: [], summary: {} }), getProject: () => state,
    onLocate: location => locations.push(location), ...options });
  return { ui, host, ids, state, locations };
}

test('formula checks require successful source saving and preserve pause reason', async () => {
  let calls = 0;
  const f = fixture({ beforeRefresh: async () => false, api: async () => { calls++; } });
  await f.ui.open();
  assert.equal(f.host.hidden, false);
  assert.equal(calls, 0);
  assert.match(f.ids.get('latex-formula-status').textContent, /尚未保存/);
  assert.equal(f.ids.get('latex-formula-refresh').disabled, false);
});

test('saved formulas expose bounded findings, source navigation and incomplete coverage', async () => {
  const f = fixture({ api: async () => ({ files_checked: 2, limited: true, summary: { formulas: 1, errors: 1, warnings: 0, issues: 1 },
    formulas: [{ id: 'f1', path: 'part.tex', line: 2, end_line: 3, kind: 'equation', source: '<script>$x$', labels: ['eq:x'] }],
    issues: [{ formula_id: 'f1', path: 'part.tex', line: 2, severity: 'error', message: '未闭合' }] }) });
  await f.ui.open();
  assert.match(f.ids.get('latex-formula-status').textContent, /覆盖不完整/);
  const card = f.ids.get('latex-formula-list').children[0];
  assert.equal(card.children[1].textContent, '<script>$x$');
  await card.children[2].events.get('click')();
  assert.equal(f.locations[0].path, 'part.tex'); assert.equal(f.locations[0].line, 2);
  f.ui.close(); assert.equal(f.host.hidden, true);
});

test('late checks and stale formula navigation do not cross project identities', async () => {
  let release;
  const deferred = new Promise(done => { release = done; });
  const f = fixture({ api: async () => deferred });
  const pending = f.ui.open();
  await new Promise(done => setImmediate(done));
  f.state.id = 'synthetic-b';
  release({ files_checked: 1, formulas: [{ id: 'old', path: 'private-old.tex', line: 1, end_line: 1, source: '$a$' }], issues: [], summary: {} });
  await pending;
  assert.equal(f.ui.testHooks.result(), null);
  assert.equal(f.ids.get('latex-formula-list').children.length, 0);
});

test('a failed recheck retains its previously reviewed source inventory', async () => {
  let fail = false;
  const f = fixture({ api: async () => { if (fail) throw new Error('offline'); return { formulas: [{ id: 'f', path: 'main.tex', line: 1, end_line: 1, source: '$a$' }], issues: [], summary: {} }; } });
  await f.ui.open(); fail = true; await f.ui.refresh();
  assert.equal(f.ids.get('latex-formula-list').children.length, 1);
  assert.match(f.ids.get('latex-formula-status').textContent, /已有结果保留/);
});
