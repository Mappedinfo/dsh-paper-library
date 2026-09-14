import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

// Execute the shipped workbench without changing its implementation. This small
// DOM double checks state/data contracts; the browser fixture owns visual checks.
const source = await readFile(new URL('../web/workbench.js', import.meta.url), 'utf8');
const appSource = await readFile(new URL('../web/app.js', import.meta.url), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
const flush = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function environment({ respond, active = null } = {}) {
  const ids = new Map(), selectors = new Map(), requests = [], changes = [], toasts = [], loads = [], opens = [], selections = [];
  class Element {
    constructor(tag = 'div') {
      this.tagName = tag.toUpperCase(); this.children = []; this.dataset = {}; this.attributes = {}; this.listeners = new Map();
      this.textContent = ''; this.hidden = false; this.disabled = false; this.style = {}; this.open = false;
      const classes = new Set();
      this.classList = { add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name), toggle(name, on) { if (on === undefined) on = !classes.has(name); if (on) classes.add(name); else classes.delete(name); } };
    }
    set id(value) { this._id = value; ids.set(value, this); }
    get id() { return this._id; }
    set value(value) { this._value = String(value); }
    get value() { return this._value ?? (this.tagName === 'SELECT' ? this.children[0]?.value || '' : this.tagName === 'OPTION' ? this.textContent : ''); }
    get options() { return this.children; }
    get parentElement() { return this.parentNode; }
    append(...nodes) { for (const node of nodes) { node.remove?.(); node.parentNode = this; this.children.push(node); } }
    prepend(...nodes) { for (const node of [...nodes].reverse()) { node.remove?.(); node.parentNode = this; this.children.unshift(node); } }
    after(...nodes) { const parent = this.parentNode; if (!parent) return; const i = parent.children.indexOf(this); for (const node of nodes) node.remove?.(); parent.children.splice(i + 1, 0, ...nodes); for (const node of nodes) node.parentNode = parent; }
    before(...nodes) { const parent = this.parentNode; if (!parent) return; const i = parent.children.indexOf(this); parent.children.splice(i, 0, ...nodes); for (const node of nodes) node.parentNode = parent; }
    remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(n => n !== this); this.parentNode = null; }
    replaceWith(node) { this.before(node); this.remove(); }
    replaceChildren(...nodes) { for (const old of this.children) old.parentNode = null; this.children = []; this.append(...nodes); }
    setAttribute(key, value) { this.attributes[key] = String(value); }
    getAttribute(key) { return this.attributes[key] ?? null; }
    removeAttribute(key) { delete this.attributes[key]; }
    closest(selector) { if (selector === this.tagName.toLowerCase()) return this; return this.parentNode?.closest(selector) || null; }
    addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, []); this.listeners.get(type).push(fn); }
    async dispatch(type, args = {}) { const event = { preventDefault() {}, stopImmediatePropagation() { this.stopped = true; }, ...args }; for (const fn of this.listeners.get(type) || []) { await fn(event); if (event.stopped) break; } }
    matches(selector) { if (selector === '[data-rank-field]') return Boolean(this.dataset.rankField); return selector === this.tagName.toLowerCase(); }
    querySelectorAll(selector) { return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]); }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    showModal() { this.open = true; }
    close() { this.open = false; }
    focus() {}
  }
  const body = new Element('body');
  function element(id, tag = 'div') { if (!ids.has(id)) { const value = new Element(tag); value.id = id; body.append(value); } return ids.get(id); }
  function selector(value) { if (!selectors.has(value)) { const node = new Element(); selectors.set(value, node); body.append(node); } return selectors.get(value); }
  const form = element('metadata-form', 'form');
  const dialog = element('metadata-dialog', 'dialog'); dialog.append(new Element('h2'), form);
  for (const id of ['edit-title', 'edit-authors', 'edit-year', 'edit-citekey', 'edit-tags']) { const label = new Element('label'); label.append(element(id, id === 'edit-authors' ? 'textarea' : 'input')); form.append(label); }
  const submit = new Element('button'); submit.type = 'submit'; form.append(submit);
  for (const id of ['copy-apa','export-bib','download-pdf','metadata-open','attach-open']) selector('.paper-actions').append(element(id, id === 'download-pdf' ? 'a' : 'button'));
  const exportLabel = new Element('label'); exportLabel.append(element('export-notes', 'select')); body.append(exportLabel);
  const document = { body, getElementById: element, createElement: tag => new Element(tag), querySelector: selector, querySelectorAll: value => body.querySelectorAll(value) };
  const window = {};
  const state = { active, items: active ? [active] : [], sort: 'modified', order: 'desc', archived: false, offset: 0, limit: 40, tab: 'reader' };
  vm.runInNewContext(source, { window, document, structuredClone }, { filename: 'web/workbench.js' });
  const workbench = window.PaperWorkbench.create({ state,
    api: async (action, data) => { requests.push({ action, ...plain(data) }); return respond ? respond(action, data) : { id: data.id || 'created', ...data.metadata, pdf: false }; },
    loadList: async () => { loads.push(plain(state)); }, openPaper: async id => opens.push(id),
    selectPaper: item => { selections.push(item.id); state.active = item; }, changed: (...args) => changes.push(plain(args)),
    toast: (...args) => toasts.push(args),
  });
  return { workbench, state, element, selector, form, requests, changes, toasts, loads, opens, selections, window };
}

const original = () => ({ id: 'paper-a', title: 'Synthetic title', pdf: true, type: 'article-journal', citekey: 'Example2026',
  author: [{ family: 'Example', given: 'Alice', ORCID: 'synthetic-orcid', affiliation: [{ name: 'Synthetic University', ror: 'synthetic-ror', source: 'Synthetic title page' }] }],
  issued: { 'date-parts': [[2026, 9, 1]] }, publication_dates: { published: '2026-09-01', received: '2025-10', accepted: '2026-08-02' },
  journal_rankings: [{ system: 'JCR', year: 2025, category: 'Synthetic category', quartile: 'Q2', source: 'Synthetic fixture', verified_at: '2026-09-14' }],
});

test('metadata title edit preserves supplied affiliations, their provenance, full issued date and JCR verification', async () => {
  const paper = original(); const f = environment({ active: paper });
  f.workbench.edit(paper); f.element('edit-title').value = 'Revised title'; await f.form.dispatch('submit');
  const request = f.requests.find(r => r.action === 'update');
  assert.equal(request.id, paper.id);
  assert.deepEqual(request.metadata.author, paper.author);
  assert.deepEqual(request.metadata.issued, paper.issued);
  assert.deepEqual(request.metadata.journal_rankings, paper.journal_rankings);
  assert.deepEqual(request.metadata.publication_dates, paper.publication_dates);
  assert.equal(request.metadata.title, 'Revised title');
});

test('explicitly clearing an affiliation clears only that supplied affiliation', async () => {
  const paper = original(); const f = environment({ active: paper });
  f.workbench.edit(paper); f.element('edit-affiliations').value = ''; await f.form.dispatch('submit');
  const author = f.requests.find(r => r.action === 'update').metadata.author[0];
  assert.equal(author.ORCID, 'synthetic-orcid');
  assert.ok(!author.affiliation || author.affiliation.length === 0);
});

test('editing affiliations keeps same-name authors separate and preserves their own evidence', async () => {
  const paper = original();
  paper.author.push({ family: 'Example', given: 'Alice', ORCID: 'second-synthetic-orcid', affiliation: [{ name: 'Synthetic University', source: 'Different author evidence' }] });
  const f = environment({ active: paper }); f.workbench.edit(paper);
  f.element('edit-affiliations').value += '；Additional Synthetic Institute';
  await f.form.dispatch('submit');
  const author = f.requests.find(r => r.action === 'update').metadata.author;
  assert.equal(author[0].affiliation[0].source, 'Synthetic title page');
  assert.equal(author[1].affiliation[0].source, 'Different author evidence');
  assert.equal(author[1].ORCID, 'second-synthetic-orcid');
});

test('a pending metadata save cannot close or overwrite a newer editor draft', async () => {
  const done = deferred(); const paper = original(); const f = environment({ active: paper, respond: () => done.promise });
  f.workbench.edit(paper); f.element('edit-title').value = 'Saved A'; const saving = f.form.dispatch('submit');
  await flush(); const next = { ...original(), id: 'paper-b', title: 'Different paper' };
  f.workbench.edit(next); f.element('edit-title').value = 'Unsaved B';
  assert.equal(f.form.querySelectorAll('button').find(button => button.type === 'submit').disabled, false, 'B editor must have usable save controls');
  done.resolve({ ...paper, title: 'Saved A' }); await saving;
  assert.equal(f.element('metadata-dialog').open, true, 'A completion must not close B dialog');
  assert.equal(f.element('edit-title').value, 'Unsaved B');
  assert.equal(f.requests.length, 1); assert.equal(f.requests[0].id, 'paper-a');
});

test('a stale metadata lookup cannot reopen the editor after selecting a different paper', async () => {
  const lookup = deferred(); const paper = original(); const f = environment({ active: paper, respond: () => lookup.promise });
  const pending = f.element('metadata-enrich').dispatch('click'); await flush();
  f.state.active = { ...paper, id: 'paper-b', title: 'B' }; f.workbench.header();
  lookup.resolve({ item: { ...paper, title: 'Enriched A' } }); await pending;
  assert.equal(f.element('metadata-dialog').open, false);
  assert.equal(f.element('toolbar-paper').textContent, 'B');
  assert.equal(f.element('metadata-enrich').disabled, false);
});

test('table selection remains metadata-only and all tool labels follow the chosen record', async () => {
  const f = environment({ active: original() });
  const b = { ...original(), id: 'paper-b', title: 'Second paper', pdf: false };
  f.state.items.push(b); f.workbench.setTable(true);
  const row = f.element('catalog-table').querySelectorAll('tr').find(n => n.dataset.paperId === b.id);
  await row.querySelector('button').dispatch('click'); f.workbench.header();
  assert.deepEqual(f.selections, ['paper-b']); assert.deepEqual(f.opens, []); assert.deepEqual(f.requests, []);
  assert.equal(f.element('toolbar-paper').textContent, b.title);
  assert.equal(f.element('toolbar-reader').hidden, true);
  assert.equal(f.element('download-pdf').hidden, true);
  assert.equal(f.element('attach-open').hidden, false);
});

test('collapsing a table selection enters the chosen paper through the full reader initialization', async () => {
  const f = environment({ active: original() });
  const b = { ...original(), id: 'paper-b', title: 'Second paper', pdf: false };
  f.state.items.push(b); f.workbench.setTable(true);
  const row = f.element('catalog-table').querySelectorAll('tr').find(n => n.dataset.paperId === b.id);
  await row.querySelector('button').dispatch('click');
  await f.element('catalog-expand').dispatch('click');
  assert.deepEqual(f.opens, [b.id], 'Revealing old reader DOM under the selected title is not sufficient');
});

test('editing a JCR year does not carry forward the previous ranking verification date', async () => {
  const paper = original(); const f = environment({ active: paper });
  f.workbench.edit(paper);
  const year = f.element('ranking-rows').querySelectorAll('[data-rank-field]').find(input => input.dataset.rankField === 'year');
  year.value = '2026'; await f.form.dispatch('submit');
  const ranking = f.requests.find(r => r.action === 'update').metadata.journal_rankings[0];
  assert.equal(ranking.year, 2026);
  assert.ok(!ranking.verified_at, 'A changed report is not verified by the previous report date');
});

test('scope, table sorting and restore preserve query and only request metadata operations', async () => {
  const archived = { ...original(), archived: true };
  const f = environment({ active: archived }); f.state.query = 'Synthetic'; f.state.offset = 80;
  f.element('catalog-scope').value = 'archived'; await f.element('catalog-scope').dispatch('change');
  assert.equal(f.state.archived, true); assert.equal(f.state.offset, 0); assert.equal(f.state.query, 'Synthetic');
  f.element('catalog-sort').value = 'title'; await f.element('catalog-sort').dispatch('change');
  assert.equal(f.state.sort, 'title'); assert.equal(f.state.query, 'Synthetic');
  f.workbench.setTable(true); assert.equal(f.element('metadata-open').disabled, true);
  const restore = f.element('catalog-table').querySelectorAll('button').find(n => n.textContent === '恢复');
  await restore.dispatch('click');
  assert.deepEqual(f.requests, [{ action: 'restore', id: archived.id }]);
  assert.deepEqual(f.changes.at(-1), [null, archived.id]);
  assert.equal(f.loads.length, 3);
});

test('failed archive preserves selection and displays the server error', async () => {
  const paper = original(); const f = environment({ active: paper, respond: () => { throw new Error('Synthetic archive failure'); } });
  await f.element('catalog-archive').dispatch('click');
  assert.equal(f.state.active.id, paper.id); assert.equal(f.changes.length, 0); assert.equal(f.loads.length, 0);
  assert.match(f.toasts.at(-1)[0], /Synthetic archive failure/);
});

test('table selection cannot publish the previous reader chat draft under the selected catalogue paper', () => {
  // Run the actual bridge function with a selected metadata row while the prior
  // reader still owns its private draft. The table has not opened the new paper.
  const start = appSource.indexOf('function publishReaderState()');
  const end = appSource.indexOf('async function restoreReaderState()', start);
  assert.ok(start >= 0 && end > start);
  const messages = [];
  const context = { restoringReader: false, readerPaperId: 'reader-paper-a', state: { active: { id: 'selected-paper-b' }, page: 3, tab: 'conversation' },
    workbenchUI: { isTable: () => true }, paperChatUI: { draft: () => 'Private draft for previous paper A', context: () => ({ annotationRefs: [{ id: 'note-from-A' }] }) },
    window: { parent: { postMessage: message => messages.push(message) }, location: { origin: 'http://localhost:43121' } },
    $: () => ({ open: false }), Blob,
  };
  vm.runInNewContext(appSource.slice(start, end) + '\npublishReaderState();', context);
  assert.equal(messages.length, 0, 'Metadata-only selection must not relabel reader state');
  context.workbenchUI.isTable = () => false;
  vm.runInNewContext(appSource.slice(start, end) + '\npublishReaderState();', context);
  assert.equal(messages.length, 0, 'Hiding the table is not proof the new reader has initialized');
  context.readerPaperId = 'selected-paper-b';
  context.paperChatUI = { draft: () => 'Paper B draft', context: () => ({ annotationRefs: [] }) };
  vm.runInNewContext(appSource.slice(start, end) + '\npublishReaderState();', context);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].snapshot.paperId, 'selected-paper-b');
  assert.equal(messages[0].snapshot.chatDraft, 'Paper B draft');
});
