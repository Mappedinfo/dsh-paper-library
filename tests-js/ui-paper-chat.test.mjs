import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// Run the shipped classic script unchanged. This double tests asynchronous UI
// behavior and the host contract; it does not claim browser rendering coverage.
const source = await readFile(new URL('../web/paper-chat.js', import.meta.url), 'utf8');
const localStateSource = await readFile(new URL('../web/local-state.js', import.meta.url), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
const flush = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

function environment({ api: respond, created = false, notes = [], storage: persistedStorage, readState } = {}) {
  const elements = new Map(), listeners = new Map(), documentListeners = new Map(), timers = new Map();
  const requests = [], posts = [], toasts = [], saved = [], snapshots = [], navigations = [], storage = persistedStorage || new Map();
  let serial = 0, timerSerial = 0, currentPaper = null;
  class Element {
    constructor(tag = 'div') {
      this.tagName = tag.toUpperCase(); this.children = []; this.listeners = new Map();
      this.value = ''; this.textContent = ''; this.hidden = false; this.disabled = false; this.checked = false;
      const classes = new Set();
      this.classList = { toggle: (name, enabled) => enabled ? classes.add(name) : classes.delete(name), contains: name => classes.has(name) };
    }
    get childNodes() { return this.children; }
    append(...nodes) {
      for (const node of nodes) {
        if (node.tagName === 'FRAGMENT') this.append(...node.children);
        else { this.children.push(node); node.parentElement = this; }
      }
    }
    replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
    addEventListener(type, handler) { if (!this.listeners.has(type)) this.listeners.set(type, []); this.listeners.get(type).push(handler); }
    dispatch(type, event = {}) { return Promise.all((this.listeners.get(type) || []).map(handler => handler({ preventDefault() {}, ...event }))); }
    focus() {}
  }
  const element = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  const document = {
    visibilityState: 'visible', getElementById: element, createElement: tag => new Element(tag), createDocumentFragment: () => new Element('fragment'),
    addEventListener: (type, handler) => documentListeners.set(type, handler),
  };
  const parent = { postMessage: (data, origin) => posts.push({ data: plain(data), origin }) };
  const window = { parent, location: { origin: 'http://localhost:3080' }, crypto: { randomUUID: () => `request-${++serial}` }, addEventListener: (type, handler) => listeners.set(type, handler) };
  const context = vm.createContext({ window, document,TextEncoder,
    localStorage: { getItem(){throw new Error('Use server persistence');}, setItem(){throw new Error('Browser writes are forbidden');} },
    setTimeout: (callback, delay) => { const id = ++timerSerial; timers.set(id, { callback, delay }); return id; },
    clearTimeout: id => timers.delete(id),
  });
  vm.runInContext(localStateSource,context);
  vm.runInContext(source, context, { filename: 'web/paper-chat.js' });
  function defaultResponse(action, args) {
    if (action === 'chat_ensure') return { sessionId: `session-${args.id}`, created };
    if (action === 'chat_catalog') return { annotations: notes.map(note => ({ status: 'new', page: 1, version: `version-${note.id}`, ...note })), total: notes.length, truncated: false };
    if (action === 'chat_history') return { sessionId: `session-${args.id}`, model: { provider: 'test', model: args.id }, messages: [], running: false, hasMore: false };
    if (action === 'chat_send') return { sessionId: `session-${args.id}`, accepted: true };
    if (action === 'chat_save_feedback') return { sessionId: `session-${args.id}`, messageId: args.message_id, saved: { duplicate: false } };
    if (action === 'chat_context') return { snapshot_id: `snapshot-${++serial}`, text: 'Host-derived paper and annotation context.', draft_text: '[paper-reference]\n\nQuestion', reference: { ref: 'paper-reference', label: '批注引用', clipboardText: 'paper-reference' } };
    throw new Error(`Unexpected paper-chat action: ${action}`);
  }
  const chat = window.PaperLibraryChat.create({
    persistence:{get:async key=>{const pending=readState?.(key);return pending===undefined?(storage.has(key)?plain(storage.get(key)):null):pending;},put:async(key,value)=>{storage.set(key,plain(value));return value;},patch:async(key,value)=>{storage.set(key,{...storage.get(key),...plain(value)});}},
    api: async (action, args) => {
      requests.push({ action, ...plain(args) });
      const value = respond?.(action, args, defaultResponse);
      return value === undefined ? defaultResponse(action, args) : value;
    },
    toast: (text, error) => toasts.push({ text, error }), getPaper: () => currentPaper,
    getContext: () => ({ sessionId: 'composer-session' }), getAnnotations: () => [],
    navigate() {}, navigateReference: (id, page) => navigations.push({ id, page }), changed() { snapshots.push({ paperId: currentPaper?.id, draft: chat.draft() }); }, savedFeedback: async id => saved.push(id), getLibrary: () => 'synthetic-test-library',
  });
  chat.setAvailable(true);
  const open = item => { currentPaper = typeof item === 'string' ? { id: item, pdf: true } : item; return chat.paperOpened(currentPaper); };
  const bridgeResult = (request, overrides = {}, eventOverrides = {}) => listeners.get('message')({
    source: parent, origin: window.location.origin,
    data: { type: 'paper-library:conversation-result', version: 1, requestId: request.requestId, ok: true, ...overrides }, ...eventOverrides,
  });
  const advance = async delay => {
    const due = [...timers.entries()].filter(([, timer]) => timer.delay === delay);
    for (const [id, timer] of due) { if (timers.delete(id)) timer.callback(); }
    await flush();
  };
  const all = node => [node, ...node.children.flatMap(all)];
  return { chat, open, element, requests, posts, toasts, saved, snapshots, timers, bridgeResult, advance, all, storage, navigations,
    visibility(value) { document.visibilityState = value; documentListeners.get('visibilitychange')?.(); },
  };
}

test('late preference restoration cannot reenable automatic sends after a newer native settings change', async t => {
  const gate=deferred(),note={id:'note-a',text:'A saved synthetic note'};
  const fixture=environment({notes:[note],storage:new Map([['preferences',{'auto-paper-conversation':true}]]),readState:key=>key==='chat:paper-a'?gate.promise:undefined});
  t.after(()=>fixture.chat.dispose());
  const opening=fixture.open('paper-a');await flush();fixture.chat.applyPreferences({'auto-paper-conversation':false});gate.resolve(null);await opening;
  assert.equal(fixture.element('paper-chat-auto').checked,false);
  await fixture.chat.savedAnnotation('paper-a','note-a');assert.equal(fixture.requests.some(r=>r.action==='chat_send'),false);
  fixture.chat.applyPreferences({'auto-paper-conversation':true},false);await fixture.open('paper-b');
  assert.equal(fixture.element('paper-chat-auto').checked,false);assert.equal(fixture.element('paper-chat-auto').disabled,true);
});

test('opening a paper creates its native session without sending a message or invoking feedback', async t => {
  const fixture = environment({ created: true }); t.after(() => fixture.chat.dispose());
  await fixture.open('paper-a');
  assert.deepEqual(fixture.requests, [{ action: 'chat_ensure', id: 'paper-a', source_session_id: 'composer-session' }, { action: 'chat_catalog', id: 'paper-a' }]);
  assert.match(fixture.element('paper-chat-status').textContent, /尚未调用模型/);
  assert.equal(fixture.element('paper-chat-send').disabled, false);
  assert.equal(fixture.posts.length, 1);
  assert.equal(fixture.posts[0].data.action, 'refresh');
  fixture.bridgeResult(fixture.posts[0].data);
});

test('a late ensure response for paper A cannot replace paper B session or its current draft', async t => {
  const first = deferred();
  const fixture = environment({ api: (action, args) => action === 'chat_ensure' && args.id === 'paper-a' ? first.promise : undefined });
  t.after(() => fixture.chat.dispose());
  const openingA = fixture.open('paper-a');
  await fixture.open('paper-b');
  fixture.chat.restoreDraft('Keep this question about B.');
  first.resolve({ sessionId: 'stale-session-a', created: true });
  await openingA;
  assert.equal(fixture.chat.draft(), 'Keep this question about B.');
  const openingMain = fixture.element('paper-chat-open').dispatch('click');
  await flush();
  assert.equal(fixture.posts.length, 1, 'stale creation must not trigger a refresh action');
  assert.equal(fixture.posts[0].data.sessionId, 'session-paper-b');
  fixture.bridgeResult(fixture.posts[0].data);
  await openingMain;
  assert.equal(fixture.requests.some(request => request.action === 'chat_send'), false);
});

test('switching papers never publishes the previous chat draft under the new paper identity', async t => {
  const fixture = environment(); t.after(() => fixture.chat.dispose());
  await fixture.open('paper-a');
  fixture.chat.restoreDraft('Private draft for paper A.');
  fixture.snapshots.length = 0;
  // Like app.js, open() updates the outer active paper before notifying chat.
  await fixture.open('paper-b');
  assert.equal(fixture.chat.draft(), '');
  assert.equal(fixture.snapshots.some(value => value.paperId === 'paper-b' && value.draft === 'Private draft for paper A.'), false);
  fixture.chat.restoreDraft('Different draft for paper B.');
  assert.deepEqual(fixture.snapshots.at(-1), { paperId: 'paper-b', draft: 'Different draft for paper B.' });
  fixture.snapshots.length = 0;
  await fixture.open('paper-a');
  assert.equal(fixture.chat.draft(), 'Private draft for paper A.', 'switching papers must still retain each local draft');
  assert.equal(fixture.snapshots.some(value => value.paperId === 'paper-a' && value.draft === 'Different draft for paper B.'), false);
});

test('an uncertain send reuses its request ID and a successful retry preserves a newer draft', async t => {
  const retry = deferred(); let attempts = 0;
  const fixture = environment({ api(action) {
    if (action !== 'chat_send') return undefined;
    if (++attempts === 1) throw new Error('Connection lost after dispatch');
    return retry.promise;
  } });
  t.after(() => fixture.chat.dispose());
  await fixture.open('paper-a');
  fixture.chat.restoreDraft('Explain this paragraph.');
  await fixture.element('paper-chat-form').dispatch('submit'); await flush();
  assert.equal(fixture.chat.draft(), 'Explain this paragraph.');
  assert.match(fixture.element('paper-chat-status').textContent, /再次发送相同内容/);
  await fixture.element('paper-chat-form').dispatch('submit'); await flush();
  const sends = fixture.requests.filter(request => request.action === 'chat_send');
  assert.equal(sends.length, 2);
  assert.equal(sends[0].request_id, sends[1].request_id);
  assert.equal(sends[0].snapshot_id, sends[1].snapshot_id);
  assert.equal(fixture.requests.filter(request => request.action === 'chat_context').length, 1, 'uncertain retry cannot re-read a changed PDF');
  fixture.chat.restoreDraft('A new question typed while that retry is pending.');
  retry.resolve({ accepted: true }); await flush();
  assert.equal(fixture.chat.draft(), 'A new question typed while that retry is pending.');
  assert.equal(fixture.element('paper-chat-send').disabled, false);
});

test('a second saved note during an automatic send reports it was not sent and preserves the draft and paper', async t => {
  const sending = deferred();
  const fixture = environment({ notes: [{ id: 'draft-context' }, { id: 'saved-note-1' }, { id: 'saved-note-2' }], api: action => action === 'chat_send' ? sending.promise : undefined });
  t.after(() => fixture.chat.dispose());
  await fixture.open('paper-a');
  fixture.element('paper-chat-auto').checked = true;
  fixture.chat.restoreDraft('Keep my unsent question about A.');
  await fixture.chat.useAnnotation({ id: 'draft-context' });
  const first = fixture.chat.savedAnnotation('paper-a', 'saved-note-1'); await flush();
  await fixture.chat.savedAnnotation('paper-a', 'saved-note-2');
  assert.equal(fixture.requests.filter(request => request.action === 'chat_send').length, 1);
  assert.deepEqual(fixture.requests.find(request => request.action === 'chat_context').annotation_refs, [{ id: 'saved-note-1', version: 'version-saved-note-1' }]);
  assert.match(fixture.toasts.at(-1).text, /批注已保存，尚未发送/);
  assert.match(fixture.toasts.at(-1).text, /加入本次引用/);
  assert.equal(fixture.chat.draft(), 'Keep my unsent question about A.');
  assert.deepEqual(plain(fixture.chat.context()), { annotationRefs: [{ id: 'draft-context', version: 'version-draft-context' }] });
  // Completing A's outstanding send after navigating must not touch B or flush
  // an undisclosed queue of A annotations into B's conversation.
  await fixture.open('paper-b');
  fixture.chat.restoreDraft('A separate unsent question about B.');
  sending.resolve({ accepted: true }); await first;
  assert.equal(fixture.chat.draft(), 'A separate unsent question about B.');
  assert.deepEqual(plain(fixture.chat.context()), { annotationRefs: [] });
  assert.equal(fixture.requests.filter(request => request.action === 'chat_send').length, 1);
  await fixture.open('paper-a');
  assert.equal(fixture.chat.draft(), 'Keep my unsent question about A.');
});

test('hiding the pane cancels polling and an in-flight history response cannot restart it', async t => {
  const firstHistory = deferred(); let histories = 0;
  const fixture = environment({ api: action => action === 'chat_history' && ++histories === 1 ? firstHistory.promise : undefined });
  t.after(() => fixture.chat.dispose());
  fixture.chat.visible(true);
  const opening = fixture.open('paper-a'); await flush();
  assert.equal(histories, 1);
  fixture.chat.visible(false);
  firstHistory.resolve({ messages: [], running: false }); await opening;
  assert.equal([...fixture.timers.values()].filter(timer => timer.delay === 4000).length, 0);
  await fixture.advance(4000); assert.equal(histories, 1);
  fixture.chat.visible(true); await flush();
  assert.equal(histories, 2);
  assert.equal([...fixture.timers.values()].filter(timer => timer.delay === 4000).length, 1);
  fixture.chat.visible(false);
  await fixture.advance(4000); assert.equal(histories, 2);
  fixture.chat.visible(true); await flush();
  fixture.visibility('hidden');
  await fixture.advance(4000); assert.equal(histories, 3, 'a hidden document must stop the visible pane polling too');
});

test('unchanged history preserves message DOM and reading position while model and outcome status update', async t => {
  let result = { messages: [{ id: '12', role: 'assistant', text: 'A host-truncated excerpt.', truncated: true }], model: { provider: 'test', model: 'first' }, running: false, hasMore: true };
  const fixture = environment({ api: action => action === 'chat_history' ? { ...result, messages: result.messages.map(message => ({ ...message })) } : undefined });
  t.after(() => fixture.chat.dispose());
  const list = fixture.element('paper-chat-messages');
  list.scrollHeight = 1000; list.clientHeight = 200;
  fixture.chat.visible(true); await fixture.open('paper-a');
  const card = list.children[0];
  const button = fixture.all(card).find(node => node.tagName === 'BUTTON');
  button.disabled = true;
  list.scrollTop = 120;
  assert.ok(fixture.all(card).some(node => node.tagName === 'SMALL' && /主对话中完整阅读/.test(node.textContent)));
  assert.match(fixture.element('paper-chat-history-note').textContent, /完整历史保留在 DSH/);
  result = { ...result, model: { provider: 'test', model: 'second' }, outcome: 'error' };
  await fixture.advance(4000);
  assert.equal(list.children[0], card, 'equivalent message data must not replace DOM on every poll');
  assert.equal(button.disabled, true, 'polling must preserve an in-flight PDF-save control');
  assert.equal(list.scrollTop, 120, 'polling must not reset the reader to the latest message');
  assert.match(fixture.element('paper-chat-model').textContent, /test \/ second/);
  assert.match(fixture.element('paper-chat-status').textContent, /停止或未完成/);
  assert.equal(fixture.element('paper-chat-status').classList.contains('error'), true);
  result = { ...result, outcome: 'completed', hasMore: false };
  await fixture.advance(4000);
  assert.equal(list.children[0], card);
  assert.equal(fixture.element('paper-chat-history-note').textContent, '');
  assert.match(fixture.element('paper-chat-status').textContent, /与 DSH 主对话同步/);
  assert.equal(fixture.element('paper-chat-status').classList.contains('error'), false);
});

test('main-conversation bridge accepts only the matching same-origin parent response', async t => {
  const fixture = environment(); t.after(() => fixture.chat.dispose());
  await fixture.open('paper-a');
  let settled = false;
  const opening = fixture.element('paper-chat-open').dispatch('click').then(() => { settled = true; });
  await flush();
  const post = fixture.posts[0];
  assert.equal(post.origin, 'http://localhost:3080');
  assert.equal(post.data.action, 'open');
  fixture.bridgeResult(post.data, {}, { source: {} });
  fixture.bridgeResult(post.data, {}, { origin: 'https://untrusted.invalid' });
  fixture.bridgeResult(post.data, { version: 2 });
  fixture.bridgeResult(post.data, { type: 'other:conversation-result' });
  fixture.bridgeResult(post.data, { requestId: 'unrelated-request' });
  await flush(); assert.equal(settled, false);
  assert.equal([...fixture.timers.values()].filter(timer => timer.delay === 20000).length, 1);
  fixture.bridgeResult(post.data); await opening;
  assert.equal(settled, true);
  assert.equal([...fixture.timers.values()].filter(timer => timer.delay === 20000).length, 0);
});

test('saving a real assistant message sends only its stable ID and never client-supplied AI text', async t => {
  const messages = [
    { id: '11', role: 'user', text: 'Question about this paper.' },
    { id: '12', role: 'assistant', text: 'Assistant reply as shown by the host.', interrupted: false },
  ];
  const fixture = environment({ api: action => action === 'chat_history' ? { messages, running: false, hasMore: false } : undefined });
  t.after(() => fixture.chat.dispose());
  fixture.chat.visible(true); await fixture.open('paper-a');
  const buttons = fixture.all(fixture.element('paper-chat-messages')).filter(node => node.tagName === 'BUTTON');
  assert.equal(buttons.length, 1);
  fixture.element('paper-chat-messages').children[1].children[1].textContent = 'Tampered client-visible text';
  await buttons[0].dispatch('click');
  await buttons[0].dispatch('click');
  assert.deepEqual(fixture.requests.filter(request => request.action === 'chat_save_feedback'), [
    { action: 'chat_save_feedback', id: 'paper-a', message_id: '12' },
    { action: 'chat_save_feedback', id: 'paper-a', message_id: '12' },
  ]);
  assert.deepEqual(fixture.saved, ['paper-a', 'paper-a']);
});

test('partial and interrupted assistant messages have no PDF-save control', async t => {
  const fixture = environment({ api: action => action === 'chat_history' ? { messages: [
    { id: '12', role: 'assistant', text: 'Interrupted response', interrupted: true },
    { id: '13', role: 'assistant', text: 'Streaming response', partial: true },
    { role: 'assistant', text: 'Response without a stable event ID' },
  ], running: false } : undefined });
  t.after(() => fixture.chat.dispose());
  fixture.chat.visible(true); await fixture.open('paper-a');
  assert.equal(fixture.all(fixture.element('paper-chat-messages')).filter(node => node.tagName === 'BUTTON').length, 0);
});

test('adding another saved note does not mutate a mixed selection or replace selected PDF text', async t => {
  const notes = Array.from({ length: 5 }, (_, index) => ({ id: `note-${index + 1}`, page: index + 1 }));
  const fixture = environment({ notes }); t.after(() => fixture.chat.dispose());
  await fixture.open('paper-a');
  await fixture.chat.useAnnotation(notes[0]); await fixture.chat.useAnnotation(notes[3]);
  fixture.chat.useSelection({ page: 7, text: 'A temporary passage.' });
  notes.push({ id: 'note-6', page: 6 });
  await fixture.chat.savedAnnotation('paper-a', 'note-6');
  assert.deepEqual(plain(fixture.chat.context()), { annotationRefs: [
    { id: 'note-1', version: 'version-note-1' }, { id: 'note-4', version: 'version-note-4' },
  ], selection: { page: 7, text: 'A temporary passage.' } });
  assert.equal(fixture.element('paper-chat-new-suggestion').hidden, false);
  assert.equal(fixture.requests.some(request => request.action === 'chat_send'), false);
  await fixture.element('paper-chat-add-new').dispatch('click');
  assert.equal(fixture.chat.context().annotationRefs.length, 3);
  await fixture.chat.useAnnotation(notes[0]);
  assert.deepEqual(plain(fixture.chat.context().annotationRefs.map(ref => ref.id)), ['note-4', 'note-6']);
});

test('all means all 65 user notes while the searchable drawer renders at most twenty rows', async t => {
  const notes = Array.from({ length: 65 }, (_, index) => ({ id: `note-${index + 1}`, page: index % 3 + 1, comment: `question ${index + 1}` }));
  notes.push({ id: 'ai-reply', kind: 'ai-feedback' });
  const fixture = environment({ notes }); t.after(() => fixture.chat.dispose());
  await fixture.open('paper-a'); await fixture.element('paper-chat-all').dispatch('click');
  assert.equal(fixture.chat.context().annotationRefs.length, 65);
  await fixture.element('paper-chat-context-label').dispatch('click');
  assert.equal(fixture.element('paper-reference-list').children.length, 20);
  await fixture.element('paper-reference-next').dispatch('click');
  assert.match(fixture.element('paper-reference-page-label').textContent, /21–40 \/ 65/);
  fixture.element('paper-reference-search').value = 'question 65'; await fixture.element('paper-reference-search').dispatch('input');
  assert.equal(fixture.element('paper-reference-list').children.length, 1);
  assert.equal(fixture.chat.context().annotationRefs.length, 65, 'searching does not clear selections');
  fixture.chat.restoreDraft('Compare every note.'); await fixture.element('paper-chat-form').dispatch('submit'); await flush();
  assert.equal(fixture.requests.find(request => request.action === 'chat_context').annotation_refs.length, 65);
  const send = fixture.requests.find(request => request.action === 'chat_send');
  assert.deepEqual(Object.keys(send).sort(), ['action', 'id', 'request_id', 'snapshot_id']);
});

test('an incomplete annotation catalog cannot be submitted as all notes', async t => {
  const fixture = environment({ api: action => action === 'chat_catalog' ? { annotations: [{ id: 'visible', version: 'v1', status: 'new', page: 1 }], total: 1001, truncated: true } : undefined });
  t.after(() => fixture.chat.dispose()); await fixture.open('paper-a');
  assert.equal(fixture.element('paper-chat-all').disabled, true);
  await fixture.element('paper-chat-all').dispatch('click');
  assert.equal(fixture.chat.context().annotationRefs.length, 0);
  assert.match(fixture.element('paper-chat-status').textContent, /不能把其中一部分称为全部/);
});

test('an edited or deleted draft reference stays frozen until adopted or removed', async t => {
  const notes = [{ id: 'note-1', version: 'v1', page: 2 }, { id: 'note-2', version: 'v1', page: 3 }];
  const fixture = environment({ notes }); t.after(() => fixture.chat.dispose()); await fixture.open('paper-a');
  await fixture.element('paper-chat-all').dispatch('click');
  notes[0].version = 'v2'; notes[0].comment = 'Revised question'; notes.splice(1, 1);
  await fixture.chat.annotationsChanged('paper-a');
  assert.equal(fixture.chat.context().annotationRefs[0].version, 'v1');
  assert.match(fixture.element('paper-chat-coverage').textContent, /2 条已选批注已更新或删除/);
  await fixture.element('paper-chat-context-label').dispatch('click');
  const adopt = fixture.all(fixture.element('paper-reference-list')).find(node => node.tagName === 'BUTTON' && node.textContent === '采用当前版本');
  await adopt.dispatch('click');
  assert.equal(fixture.chat.context().annotationRefs[0].version, 'v2');
  assert.equal(fixture.chat.context().annotationRefs[1].id, 'note-2', 'deleted reference remains visible for explicit removal');
  const boxes = fixture.all(fixture.element('paper-reference-list')).filter(node => node.tagName === 'INPUT');
  boxes[1].checked = false; await boxes[1].dispatch('change');
  assert.equal(fixture.chat.context().annotationRefs.length, 1);
});

test('send state follows committed usage and never reparses the PDF during history polling', async t => {
  let usage = {};
  const fixture = environment({ notes: [{ id: 'note-1', version: 'v1' }], api: action => action === 'chat_history' ? { messages: [], annotation_usage: usage, usage_revision: JSON.stringify(usage) } : undefined });
  t.after(() => fixture.chat.dispose()); fixture.chat.visible(true); await fixture.open('paper-a');
  await fixture.element('paper-chat-all').dispatch('click');
  await fixture.element('paper-chat-form').dispatch('submit'); await flush();
  assert.equal(fixture.element('paper-chat-new').textContent, '新增与更新 1', 'queue acceptance does not mark a note sent');
  usage = { 'note-1': 'v1' }; await fixture.advance(4000);
  assert.equal(fixture.element('paper-chat-new').textContent, '新增与更新 0');
  assert.equal(fixture.requests.filter(request => request.action === 'chat_catalog').length, 1);
});

test('annotation IDs matching Object prototype names remain new without an own usage entry', async t => {
  const fixture = environment({ notes: [{ id: 'constructor', version: 'v1' }, { id: 'toString', version: 'v1' }], api: action => action === 'chat_history' ? { messages: [], annotation_usage: {}, usage_revision: 'empty' } : undefined });
  t.after(() => fixture.chat.dispose()); fixture.chat.visible(true); await fixture.open('paper-a');
  await fixture.element('paper-chat-choose').dispatch('click');
  const statuses = fixture.all(fixture.element('paper-reference-list')).filter(node => node.tagName === 'STRONG').map(node => node.textContent);
  assert.equal(statuses.length, 2); assert.ok(statuses.every(text => text.includes('未发送')));
});

test('draft selections and frozen uncertain requests survive a fresh reader instance', async t => {
  const notes = [{ id: 'note-1', version: 'v1' }];
  const first = environment({ notes, api: action => action === 'chat_send' ? Promise.reject(new Error('Connection lost after admission')) : undefined });
  t.after(() => first.chat.dispose()); await first.open('paper-a');
  await first.element('paper-chat-all').dispatch('click'); first.chat.restoreDraft('A durable question.');
  await first.element('paper-chat-form').dispatch('submit'); await flush();
  const firstSend = first.requests.find(request => request.action === 'chat_send');
  const second = environment({ notes, storage: first.storage }); t.after(() => second.chat.dispose()); await second.open('paper-a');
  assert.equal(second.chat.draft(), 'A durable question.');
  assert.deepEqual(plain(second.chat.context().annotationRefs), [{ id: 'note-1', version: 'v1' }]);
  await second.element('paper-chat-form').dispatch('submit'); await flush();
  assert.equal(second.requests.some(request => request.action === 'chat_context'), false);
  assert.equal(second.requests.find(request => request.action === 'chat_send').snapshot_id, firstSend.snapshot_id);
  assert.equal(second.requests.find(request => request.action === 'chat_send').request_id, firstSend.request_id);
});

test('over-budget context errors preserve the complete selection and do not dispatch a partial prompt', async t => {
  const notes = Array.from({ length: 80 }, (_, index) => ({ id: `note-${index}` }));
  const fixture = environment({ notes, api: action => action === 'chat_context' ? Promise.reject(new Error('Selected 80 notes exceed the 48000 character budget. Reduce your selection.')) : undefined });
  t.after(() => fixture.chat.dispose()); await fixture.open('paper-a'); await fixture.element('paper-chat-all').dispatch('click');
  fixture.chat.restoreDraft('Consider all of these.'); await fixture.element('paper-chat-form').dispatch('submit'); await flush();
  assert.equal(fixture.chat.context().annotationRefs.length, 80);
  assert.equal(fixture.chat.draft(), 'Consider all of these.');
  assert.equal(fixture.requests.some(request => request.action === 'chat_send'), false);
  assert.match(fixture.element('paper-chat-status').textContent, /80 notes exceed/);
});

test('main draft carries the frozen native reference and does not advance usage', async t => {
  const fixture = environment({ notes: [{ id: 'note-1' }] }); t.after(() => fixture.chat.dispose()); await fixture.open('paper-a');
  await fixture.element('paper-chat-all').dispatch('click'); fixture.chat.restoreDraft('Draft this question.');
  const sending = fixture.element('paper-chat-draft').dispatch('click'); await flush();
  const post = fixture.posts.at(-1).data;
  assert.equal(post.action, 'draft'); assert.ok(post.snapshot_id); assert.equal(post.reference.ref, 'paper-reference');
  assert.equal(post.draft_text, '[paper-reference]\n\nQuestion');
  fixture.bridgeResult(post); await sending;
  assert.equal(fixture.chat.draft(), 'Draft this question.');
  assert.equal(fixture.chat.context().annotationRefs.length, 1);
  assert.equal(fixture.requests.some(request => request.action === 'chat_send'), false);
  assert.equal(fixture.element('paper-chat-new').textContent, '新增与更新 1');
});

test('ambiguous PDF identities are visible but cannot enter a reference set', async t => {
  const notes = [{ id: 'duplicate', version: 'v1', identity_reliable: false, identity_source: 'duplicate-pdf-nm' }, { id: 'fallback', version: 'v1', identity_reliable: false, identity_source: 'external-xref' }];
  const fixture = environment({ notes }); t.after(() => fixture.chat.dispose()); await fixture.open('paper-a');
  assert.equal(fixture.element('paper-chat-all').disabled, true);
  await fixture.element('paper-chat-all').dispatch('click');
  assert.equal(fixture.chat.context().annotationRefs.length, 0);
  await fixture.element('paper-chat-choose').dispatch('click');
  const boxes = fixture.all(fixture.element('paper-reference-list')).filter(node => node.tagName === 'INPUT');
  assert.equal(boxes[0].disabled, true); assert.equal(boxes[1].disabled, false);
  await fixture.chat.useAnnotation(notes[1]);
  assert.equal(fixture.chat.context().annotationRefs[0].id, 'fallback');
  assert.match(fixture.element('paper-reference-read-status').textContent, /重复标识/);
});

test('history reference previews load on demand and page links return to the source', async t => {
  const fixture = environment({ api(action) {
    if (action === 'chat_history') return { messages: [{ id: 'user-1', role: 'user', text: 'Question', references: [{ snapshot_id: 'snapshot-1', paperId: 'paper-a', count: 2, pages: [2, 3] }] }] };
    if (action === 'chat_reference') return { text: 'The exact saved content, unchanged after later PDF edits.', annotation_refs: [{ id: 'note-1', version: 'v1', page: 2 }, { id: 'note-2', version: 'v1', page: 3 }] };
  } });
  t.after(() => fixture.chat.dispose()); fixture.chat.visible(true); await fixture.open('paper-a');
  assert.equal(fixture.requests.some(request => request.action === 'chat_reference'), false);
  const button = fixture.all(fixture.element('paper-chat-messages')).find(node => node.tagName === 'BUTTON');
  await button.dispatch('click');
  assert.equal(fixture.requests.filter(request => request.action === 'chat_reference').length, 1);
  const sourceLink = fixture.all(fixture.element('paper-chat-messages')).find(node => node.tagName === 'BUTTON' && node.textContent === '返回第 3 页');
  await sourceLink.dispatch('click'); assert.deepEqual(fixture.navigations, [{ id: 'paper-a', page: 3 }]);
  await button.dispatch('click');
  assert.equal(fixture.all(fixture.element('paper-chat-messages')).some(node => node.textContent.includes('exact saved content')), false, 'collapsing releases the full snapshot body');
});
