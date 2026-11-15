import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFetchHandler } from '../src/http.mjs';

const require = createRequire(import.meta.url);
let JSDOM;
try { ({ JSDOM } = require(process.env.JSDOM_MODULE || 'jsdom')); } catch {}

test('the web handler serves the tag editor and routes suggestion and update requests', async t => {
  const root = await mkdtemp(join(tmpdir(), 'paper-annotation-tags-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const handler = createFetchHandler({ library: join(root, 'library'), localStateHome: join(root, 'state') });
  const asset = await handler(new Request('http://127.0.0.1/annotation-tags.js'));
  assert.equal(asset.status, 200);
  assert.match(await asset.text(), /PaperAnnotationTags/);
  const post = async input => (await handler(new Request('http://127.0.0.1/api', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
  }))).json();
  assert.deepEqual(await post({ action: 'annotation_tag_suggestions', query: 'synthetic' }),
    { ok: true, result: { tags: [] } });
  const update = await post({ action: 'annotation_tags_update', id: 'synthetic', annotation_id: 'note', page: 0, tags: [], expected_tags: [] });
  assert.match(update.error, /批注页码/);
});

test('the tag editor suggests earlier labels, adds and removes draft tags, and saves a merged retry', { skip: !JSDOM }, async t => {
  const dom = new JSDOM('<body></body>', { runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const { window } = dom, { document } = window;
  window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  window.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new window.Event('close')); };
  let resize;
  window.ResizeObserver = class {
    constructor(callback) { resize = callback; }
    observe() {}
    disconnect() {}
  };
  window.eval(await readFile(new URL('../web/annotation-tags.js', import.meta.url), 'utf8'));
  const calls = [], saved = [];
  let updates = 0;
  const ui = window.PaperAnnotationTags.create({
    el(tag, cls, text) {
      const node = document.createElement(tag);
      if (cls) node.className = cls;
      if (text) node.textContent = text;
      return node;
    },
    async api(action, payload) {
      calls.push([action, payload]);
      if (action === 'annotation_tag_suggestions') return { tags: ['城市感知', 'Earlier label'] };
      if (++updates === 1) throw Object.assign(new Error('conflict'), { code: 'STATE_CONFLICT', current: { tags: ['Existing', 'Other window'] } });
      return { tags: payload.tags };
    },
    onSaved: id => saved.push(id),
  });
  const note = { id: 'annotation', page: 2, tags: ['Existing'] };
  ui.editButton(note, 'paper').click();
  const dialog = document.querySelector('dialog'), input = dialog.querySelector('input');
  input.value = '城市';
  input.dispatchEvent(new window.Event('input'));
  await new Promise(resolve => setTimeout(resolve, 180));
  assert.equal(calls.at(-1)[0], 'annotation_tag_suggestions');
  assert.equal(calls.at(-1)[1].query, '城市');
  const options = dialog.querySelector('[aria-label="已有标签建议"]');
  options.querySelector('button').click();
  dialog.querySelector('[aria-label="移除标签 Existing"]').click();
  const submit = () => dialog.querySelector('form').dispatchEvent(new window.Event('submit', { cancelable: true }));
  const settle = () => new Promise(resolve => setImmediate(resolve));
  input.value = 'New label';
  submit();
  await settle();
  assert.match(dialog.querySelector('[role="alert"]').textContent, /再次保存/);
  assert.equal(dialog.open, true);
  submit();
  await settle();
  const payload = calls.filter(([action]) => action === 'annotation_tags_update').at(-1)[1];
  assert.deepEqual(Array.from(payload.tags), ['Other window', '城市感知', 'New label']);
  assert.deepEqual(Array.from(payload.expected_tags), ['Existing', 'Other window']);
  assert.equal(payload.annotation_id, 'annotation');
  assert.deepEqual(saved, ['paper']);
  assert.equal(dialog.open, false);

  const strip = ui.strip({ tags: ['One', '<img>'] });
  const chips = strip.querySelector('.annotation-tag-list'), toggle = strip.querySelector('button');
  Object.defineProperty(chips, 'scrollHeight', { get: () => 48 });
  Object.defineProperty(chips, 'clientHeight', { get: () => 24 });
  resize([{ target: strip }]);
  assert.equal(toggle.hidden, false);
  assert.equal(chips.querySelector('img'), null);
  toggle.click();
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  assert.ok(strip.classList.contains('is-expanded'));
  toggle.click();
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
});
