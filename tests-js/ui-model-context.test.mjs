import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// Execute the actual UI, only suppressing its automatic network bootstrap. This
// DOM double covers route controls and handlers; it is not a rendering test.
const source = await readFile(new URL('../web/app.js', import.meta.url), 'utf8');
assert.match(source, /\ninitialize\(\);\s*$/);
const testSource = source.replace(/\ninitialize\(\);\s*$/, '\n') + `
globalThis.testUI = { state, announceReady, currentHarnessRoute, manualModel,
  loadModels, renderModelRoute, requestFeedback, requestPage, restoreReaderState,
  saveAnnotation, setReaderRestore(value) { readerRestore = value; } };
`;

function environment({ standalone = false, models = [{ id: 'fallback-model', provider: 'fallback-provider' }], modelResponse, apiResponse } = {}) {
  const elements = new Map(), labels = new Map(), requests = [], messages = [], storage = new Map();
  class Element {
    constructor(tag = 'div') {
      this.tagName = tag.toUpperCase(); this.children = []; this.dataset = {}; this.style = {};
      this.hidden = false; this.disabled = false; this.textContent = ''; this.listeners = new Map();
      const classes = new Set();
      this.classList = { add: name => classes.add(name), remove: name => classes.delete(name), toggle: (name, enabled) => enabled ? classes.add(name) : classes.delete(name), contains: name => classes.has(name) };
    }
    set id(value) { this._id = value; elements.set(value, this); }
    get id() { return this._id; }
    set value(value) { this._value = String(value); }
    get value() { return this._value ?? (this.tagName === 'SELECT' ? this.firstElementChild?.value || '' : this.tagName === 'OPTION' ? this.textContent : ''); }
    get firstElementChild() { return this.children[0]; }
    append(...nodes) { for (const node of nodes) { if (node.tagName === 'FRAGMENT') this.append(...node.children); else { this.children.push(node); node.parentElement = this; } } }
    replaceChildren(...nodes) { this.children = []; this._value = undefined; this.append(...nodes); }
    closest(selector) { if (selector === 'label') { if (!labels.has(this)) labels.set(this, new Element('label')); return labels.get(this); } return this.parentElement || null; }
    addEventListener(type, listener) { if (!this.listeners.has(type)) this.listeners.set(type, []); this.listeners.get(type).push(listener); }
    dispatch(type, event = {}) { for (const listener of this.listeners.get(type) || []) listener(event); }
    before() {} after() {} setAttribute() {} removeAttribute() {} focus() {} select() {}
    showModal() { this.open = true; } close() { this.open = false; }
    querySelectorAll() { return []; }
  }
  function element(id) { if (!elements.has(id)) { const node = new Element(id === 'feedback-model' ? 'select' : 'div'); node.id = id; } return elements.get(id); }
  const document = {
    getElementById: element, createElement: tag => new Element(tag), createDocumentFragment: () => new Element('fragment'),
    querySelectorAll: () => [], querySelector: () => new Element(), addEventListener() {}, body: new Element('body'),
  };
  const parent = { postMessage: (data, origin) => messages.push({ data, origin }) };
  const listeners = new Map();
  const window = { location: { origin: 'http://localhost:3080' }, parent,
    addEventListener: (type, listener) => { listeners.set(type, listener); },
    getSelection: () => ({ removeAllRanges() {} }),
  };
  if (standalone) window.parent = window;
  const fetch = async (_url, options) => {
    const request = JSON.parse(options.body); requests.push(request);
    let result = apiResponse ? await apiResponse(request) : undefined;
    if (result === undefined) switch (request.action) {
      case 'models': result = modelResponse ? await modelResponse() : { models }; break;
      case 'ai_feedback': result = { saved: true }; break;
      case 'feedback': result = { feedback: [] }; break;
      case 'annotations': result = { annotations: [], truncated: false }; break;
      default: throw new Error(`Unexpected request during route test: ${request.action}`);
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, result }) };
  };
  const context = vm.createContext({ document, window, fetch, console,
    ResizeObserver: class { observe() {} },
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    setTimeout: () => 1, clearTimeout() {}, structuredClone, Blob,
  });
  vm.runInContext(testSource, context, { filename: 'web/app.js' });
  const ui = context.testUI;
  ui.state.active = { id: 'paper-a', pdf: false };
  const ready = { type: 'paper-library:context', version: 1, status: 'ready', sessionId: 'session-a', provider: 'current-provider', model: 'current-model', reasoningEffort: 'high' };
  function send(overrides = {}, eventOverrides = {}) { listeners.get('message')({ data: { ...ready, ...overrides }, source: parent, origin: window.location.origin, ...eventOverrides }); }
  return { ui, element, requests, messages, storage, send, parent, window, flush: () => new Promise(resolve => setImmediate(resolve)) };
}

test('the actual UI accepts only its same-origin parent and supported context version', () => {
  const fixture = environment();
  fixture.send({}, { source: {} });
  fixture.send({}, { origin: 'https://untrusted.invalid' });
  fixture.send({ version: 2 });
  assert.equal(fixture.ui.currentHarnessRoute(), null);
  assert.equal(fixture.ui.state.harnessContext, null);
  fixture.send();
  assert.equal(fixture.ui.currentHarnessRoute().id, 'current-model');
  assert.equal(fixture.ui.currentHarnessRoute().provider, 'current-provider');
  assert.equal(fixture.element('feedback-model').closest('label').hidden, true);
  assert.equal(fixture.element('current-harness-model').hidden, false);
  assert.equal(fixture.element('request-feedback').disabled, false);
  assert.equal(fixture.storage.size, 0, 'an inherited route must not become a manual preference');
  fixture.ui.announceReady();
  assert.equal(fixture.messages[0].data.type, 'paper-library:ready');
  assert.equal(fixture.messages[0].data.version, 1);
  assert.equal(fixture.messages[0].origin, fixture.window.location.origin);
});

test('a standalone page ignores context messages and does not choose the first listed model', async () => {
  const fixture = environment({ standalone: true });
  fixture.send();
  await fixture.ui.loadModels();
  assert.equal(fixture.ui.currentHarnessRoute(), null);
  assert.equal(fixture.ui.manualModel(), null);
  assert.equal(fixture.element('feedback-model').value, '');
  assert.equal(fixture.element('request-feedback').disabled, true);
  await fixture.ui.requestFeedback();
  assert.equal(fixture.requests.filter(request => request.action === 'ai_feedback').length, 0);
});

test('loading immediately clears the previous route and prevents automatic or manual AI calls', async () => {
  const fixture = environment();
  fixture.send();
  fixture.send({ status: 'loading', sessionId: 'session-b', provider: 'stale-provider', model: 'stale-model' });
  assert.equal(fixture.ui.currentHarnessRoute(), null);
  assert.equal(fixture.ui.state.harnessContext.provider, '');
  assert.equal(fixture.ui.state.harnessContext.model, '');
  assert.equal(fixture.element('request-feedback').disabled, true);
  assert.equal(fixture.element('current-harness-model-name').textContent.includes('current-model'), false);
  await fixture.ui.requestFeedback('paper-a', true);
  await fixture.ui.requestFeedback('paper-a', false);
  assert.equal(fixture.requests.length, 0, 'loading must not discover a substitute model or invoke AI');
});

test('unavailable context exposes fallback but only explicit selection enables an AI request', async () => {
  const fixture = environment();
  fixture.send();
  fixture.send({ status: 'unavailable', sessionId: null, provider: null, model: null });
  await fixture.flush();
  assert.equal(fixture.element('feedback-model').closest('label').hidden, false);
  assert.equal(fixture.ui.currentHarnessRoute(), null);
  assert.equal(fixture.ui.manualModel(), null);
  assert.equal(fixture.element('request-feedback').disabled, true);
  await fixture.ui.requestFeedback();
  assert.equal(fixture.requests.some(request => request.action === 'ai_feedback'), false);
  fixture.element('feedback-model').value = '0';
  fixture.element('feedback-model').dispatch('change');
  assert.equal(fixture.element('request-feedback').disabled, false);
  await fixture.ui.requestFeedback();
  const request = fixture.requests.find(value => value.action === 'ai_feedback');
  assert.equal(request.provider, 'fallback-provider');
  assert.equal(request.model, 'fallback-model');
  assert.equal(Object.hasOwn(request, 'session_id'), false, 'manual fallback cannot reuse the previous session route');
});

test('ready requests use the latest parent route snapshot including session and reasoning effort', async () => {
  const fixture = environment();
  fixture.send();
  await fixture.ui.requestFeedback();
  fixture.send({ sessionId: 'session-b', provider: 'second-provider', model: 'second-model', reasoningEffort: 'low' });
  await fixture.ui.requestFeedback();
  const requests = fixture.requests.filter(request => request.action === 'ai_feedback');
  assert.deepEqual(requests, [
    { action: 'ai_feedback', id: 'paper-a', provider: 'current-provider', model: 'current-model', session_id: 'session-a', reasoning_effort: 'high' },
    { action: 'ai_feedback', id: 'paper-a', provider: 'second-provider', model: 'second-model', session_id: 'session-b', reasoning_effort: 'low' },
  ]);
  assert.equal(fixture.requests.some(request => request.action === 'models'), false, 'known current routes never require a model-list fallback');
});

test('a late fallback response cannot overwrite a newer current-session route', async () => {
  let resolveModels;
  const pendingModels = new Promise(resolve => { resolveModels = resolve; });
  const fixture = environment({ modelResponse: () => pendingModels });
  const loading = fixture.ui.loadModels();
  fixture.send({ model: 'new-current-model', sessionId: 'new-session' });
  resolveModels({ models: [{ id: 'stale-fallback', provider: 'stale-provider' }] });
  await loading;
  assert.equal(fixture.ui.currentHarnessRoute().id, 'new-current-model');
  assert.equal(fixture.ui.state.models.length, 0);
  assert.equal(fixture.element('current-harness-model-name').textContent, 'current-provider / new-current-model');
  assert.equal(fixture.element('feedback-model').closest('label').hidden, true);
});

function deferred() {
  let resolve;
  const promise = new Promise(accept => { resolve = accept; });
  return { promise, resolve };
}
const pageResult = page => ({ page, page_count: 2, width: 400, height: 500, image: '', words: [] });

test('a queued page request stays pending until the requested PDF page has actually rendered', async t => {
  const first = deferred(), second = deferred();
  const fixture = environment({ apiResponse: request => request.action === 'page' ? (request.page === 1 ? first.promise : second.promise) : undefined });
  fixture.ui.state.active = { id: 'paper-a', pdf: true };
  fixture.ui.state.pageCount = 2;
  const rendering = fixture.ui.requestPage(1);
  let queuedFinished = false;
  const queued = fixture.ui.requestPage(2).then(() => { queuedFinished = true; });
  t.after(async () => { first.resolve(pageResult(1)); second.resolve(pageResult(2)); await rendering; await queued; });
  await fixture.flush();
  assert.equal(queuedFinished, false);
  first.resolve(pageResult(1)); await fixture.flush();
  assert.equal(queuedFinished, false, 'the old render finishing must not resolve the queued page prematurely');
  assert.equal(fixture.requests.filter(request => request.action === 'page').at(-1).page, 2);
  second.resolve(pageResult(2)); await queued;
  assert.equal(fixture.ui.state.page, 2);
  assert.equal(fixture.ui.state.pageRunning, false);
  assert.equal(fixture.ui.state.pagePromise, null);
});

for (const mode of ['note', 'highlight']) test(`restoring a ${mode} waits for the queued PDF page and saves to its original page`, async t => {
  const first = deferred(), second = deferred(); let firstRequested = false;
  const paper = { id: 'paper-a', pdf: true, title: 'Synthetic two-page paper', citekey: 'Fixture2026' };
  const fixture = environment({ apiResponse(request) {
    if (request.action === 'get') return paper;
    if (request.action === 'page') {
      if (request.page === 2) return second.promise;
      if (!firstRequested) { firstRequested = true; return first.promise; }
      return pageResult(request.page);
    }
    if (request.action === 'annotate') return { annotation: { id: 'saved-note', page: request.page, type: request.type, comment: request.comment } };
    return undefined;
  } });
  fixture.ui.state.active = paper;
  fixture.ui.state.pageCount = 2;
  const rendering = fixture.ui.requestPage(1);
  t.after(async () => { first.resolve(pageResult(1)); second.resolve(pageResult(2)); await rendering; });
  await fixture.flush();
  const selection = { page: 2, text: 'Text selected on page two.', rects: [[50, 80, 160, 95]] };
  fixture.ui.setReaderRestore({ paperId: 'paper-a', page: 2, tab: 'reader', chatDraft: '', annotationDraft: {
    id: 'paper-a', mode, page: 2, comment: 'This unsaved annotation belongs to page two.', ...(mode === 'highlight' ? { selection } : {}),
  } });
  let restored = false;
  const restoring = fixture.ui.restoreReaderState().then(() => { restored = true; });
  await fixture.flush();
  assert.equal(restored, false, 'restoration must wait for an already-running renderer');
  first.resolve(pageResult(1)); await fixture.flush();
  assert.equal(fixture.ui.state.page, 1);
  assert.equal(restored, false, 'restoration must still wait until page 2 is available');
  assert.equal(fixture.requests.filter(request => request.action === 'page').at(-1).page, 2);
  second.resolve(pageResult(2)); await restoring;
  assert.equal(fixture.ui.state.page, 2);
  assert.equal(fixture.ui.state.annotationDraft.page, 2);
  assert.equal(fixture.element('annotation-page-label').textContent, '第 2 页');
  assert.equal(fixture.element('annotation-comment').value, 'This unsaved annotation belongs to page two.');
  assert.equal(fixture.element('annotation-dialog').open, true);
  await fixture.ui.saveAnnotation({ preventDefault() {}, target: fixture.element('annotation-form') });
  const saved = fixture.requests.find(request => request.action === 'annotate');
  assert.equal(saved.id, 'paper-a');
  assert.equal(saved.page, 2);
  assert.equal(saved.comment, 'This unsaved annotation belongs to page two.');
  if (mode === 'highlight') {
    assert.deepEqual(saved.rects, selection.rects);
    assert.equal(saved.text, selection.text);
  }
});
