import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const script = await readFile(new URL('../web/latex-search.js', import.meta.url), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture({ search, reveal }) {
  const ids = new Map();
  class Element {
    constructor(tag) {
      this.tag = tag;
      this.children = [];
      this.listeners = {};
      this.attributes = {};
      this.value = '';
      this.classList = { toggle() {} };
    }
    set id(value) { ids.set(value, this); }
    set textContent(value) { this.text = value; this.children = []; }
    get textContent() { return this.text || this.children.map(child => child.textContent).join(''); }
    setAttribute(key, value) { this.attributes[key] = value; }
    append(...nodes) { this.children.push(...nodes); }
    addEventListener(name, listener) { this.listeners[name] = listener; }
    focus() {}
    fire(name, args = {}) { this.listeners[name]?.({ preventDefault() {}, stopPropagation() {}, ...args }); }
  }
  const window = {};
  vm.runInNewContext(script, { window, document: { createElement: tag => new Element(tag) }, AbortController });
  const toolbar = new Element('header'), topbar = new Element('div');
  const ui = window.PaperLatexSearch.create({ toolbar, topbar, search, reveal });
  const get = suffix => ids.get(suffix ? `latex-workspace-search-${suffix}` : 'latex-workspace-search');
  const form = get().children[0];
  return { ui, get, form };
}

test('workspace search reveals the first match and navigates each returned batch', async () => {
  const requests = [], revealed = [];
  const cursor = { page: 4 };
  const initial = [{ label: '第 2 页', page: 2 }, { label: '第 3 页', page: 3 }];
  const later = { label: '第 6 页', page: 6 };
  const { ui, get, form } = fixture({
    search: async (scope, query, options) => {
      requests.push([scope, query, options.cursor]);
      return options.cursor ? { matches: [later] } : { matches: initial, next_cursor: cursor };
    },
    reveal: async (scope, hit, isCurrent) => { assert.equal(isCurrent(), true); revealed.push([scope, hit]); },
  });
  assert.equal(get().hidden, true);
  get('open').fire('click');
  get('query').value = '  needle  ';
  form.fire('submit');
  await tick();
  assert.equal(ui.results('pdf').active, initial[0]);
  assert.equal(get('results').children[1].textContent, initial[1].label);
  get('next').fire('click');
  await tick();
  assert.equal(ui.results('pdf').active, initial[1]);
  get('results').value = '0';
  get('results').fire('change');
  await tick();
  assert.equal(ui.results('pdf').active, initial[0]);
  get('more').fire('click');
  await tick();
  assert.equal(ui.results('pdf').active, later);
  assert.equal(get('more').hidden, true);
  assert.deepEqual(requests, [['pdf', 'needle', undefined], ['pdf', 'needle', cursor]]);
  assert.deepEqual(revealed, [['pdf', initial[0]], ['pdf', initial[1]], ['pdf', initial[0]], ['pdf', later]]);
});

test('scope changes and closing cancel lookups and invalidate outstanding reveal callbacks', async () => {
  const requests = [], guards = [];
  const { ui, get, form } = fixture({
    search: (scope, query, { signal }) => new Promise(resolve => requests.push({ scope, signal, resolve })),
    reveal: (scope, hit, isCurrent) => { guards.push(isCurrent); return new Promise(() => {}); },
  });
  get('open').fire('click');
  get('query').value = 'needle';
  form.fire('submit');
  get('scope').value = 'source';
  get('scope').fire('change');
  assert.equal(get('folder'), undefined);
  assert.equal(get('query').placeholder, '搜索所有章节');
  assert.equal(requests[0].signal.aborted, true);
  requests[0].resolve({ matches: [{ label: 'stale PDF' }] });
  form.fire('submit');
  const source = { label: 'chapter.tex:4' };
  requests[1].resolve({ matches: [source, { label: 'chapter.tex:5' }] });
  await tick();
  assert.equal(ui.results('source').active, source);
  assert.equal(ui.results('pdf').active, null);
  assert.equal(guards.length, 1);
  ui.reset('pdf');
  assert.equal(guards[0](), true);
  get('next').fire('click');
  assert.equal(guards[0](), false);
  assert.equal(guards[1](), true);
  ui.close();
  assert.equal(guards[1](), false);
  assert.equal(get().hidden, true);
  assert.equal(ui.results('source').matches.length, 0);
});
