import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// Run the shipped classic script unchanged. This double tests asynchronous UI
// behavior and the host contract; it does not claim browser rendering coverage.
const source = await readFile(new URL('../web/paper-chat.js', import.meta.url), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
const flush = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

function environment({ api: respond, created = false } = {}) {
  const elements = new Map(), listeners = new Map(), documentListeners = new Map(), timers = new Map();
  const requests = [], posts = [], toasts = [], saved = [], snapshots = [], storage = new Map();
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
  const context = vm.createContext({ window, document,
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    setTimeout: (callback, delay) => { const id = ++timerSerial; timers.set(id, { callback, delay }); return id; },
    clearTimeout: id => timers.delete(id),
  });
  vm.runInContext(source, context, { filename: 'web/paper-chat.js' });
  function defaultResponse(action, args) {
    if (action === 'chat_ensure') return { sessionId: `session-${args.id}`, created };
    if (action === 'chat_history') return { sessionId: `session-${args.id}`, model: { provider: 'test', model: args.id }, messages: [], running: false, hasMore: false };
    if (action === 'chat_send') return { sessionId: `session-${args.id}`, accepted: true };
    if (action === 'chat_save_feedback') return { sessionId: `session-${args.id}`, messageId: args.message_id, saved: { duplicate: false } };
    if (action === 'chat_context') return { text: 'Host-derived paper and annotation context.' };
    throw new Error(`Unexpected paper-chat action: ${action}`);
  }
  const chat = window.PaperLibraryChat.create({
    api: async (action, args) => {
      requests.push({ action, ...plain(args) });
      const value = respond?.(action, args, defaultResponse);
      return value === undefined ? defaultResponse(action, args) : value;
    },
    toast: (text, error) => toasts.push({ text, error }), getPaper: () => currentPaper,
    getContext: () => ({ sessionId: 'composer-session' }), getAnnotations: () => [],
    navigate() {}, changed() { snapshots.push({ paperId: currentPaper?.id, draft: chat.draft() }); }, savedFeedback: async id => saved.push(id), getLibrary: () => 'synthetic-test-library',
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
  return { chat, open, element, requests, posts, toasts, saved, snapshots, timers, bridgeResult, advance, all,
    visibility(value) { document.visibilityState = value; documentListeners.get('visibilitychange')?.(); },
  };
}

test('opening a paper creates its native session without sending a message or invoking feedback', async t => {
  const fixture = environment({ created: true }); t.after(() => fixture.chat.dispose());
  await fixture.open('paper-a');
  assert.deepEqual(fixture.requests, [{ action: 'chat_ensure', id: 'paper-a', source_session_id: 'composer-session' }]);
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
  fixture.chat.restoreDraft('A new question typed while that retry is pending.');
  retry.resolve({ accepted: true }); await flush();
  assert.equal(fixture.chat.draft(), 'A new question typed while that retry is pending.');
  assert.equal(fixture.element('paper-chat-send').disabled, false);
});

test('a second saved note during an automatic send reports it was not sent and preserves the draft and paper', async t => {
  const sending = deferred();
  const fixture = environment({ api: action => action === 'chat_send' ? sending.promise : undefined });
  t.after(() => fixture.chat.dispose());
  await fixture.open('paper-a');
  fixture.element('paper-chat-auto').checked = true;
  fixture.chat.restoreDraft('Keep my unsent question about A.');
  fixture.chat.useAnnotation({ id: 'draft-context' });
  const first = fixture.chat.savedAnnotation('paper-a', 'saved-note-1'); await flush();
  await fixture.chat.savedAnnotation('paper-a', 'saved-note-2');
  assert.equal(fixture.requests.filter(request => request.action === 'chat_send').length, 1);
  assert.deepEqual(fixture.requests.find(request => request.action === 'chat_send').annotation_ids, ['saved-note-1']);
  assert.match(fixture.toasts.at(-1).text, /批注已保存，尚未发送/);
  assert.match(fixture.toasts.at(-1).text, /在论文对话中讨论/);
  assert.equal(fixture.chat.draft(), 'Keep my unsent question about A.');
  assert.deepEqual(plain(fixture.chat.context()), { annotationIds: ['draft-context'] });
  // Completing A's outstanding send after navigating must not touch B or flush
  // an undisclosed queue of A annotations into B's conversation.
  await fixture.open('paper-b');
  fixture.chat.restoreDraft('A separate unsent question about B.');
  sending.resolve({ accepted: true }); await first;
  assert.equal(fixture.chat.draft(), 'A separate unsent question about B.');
  assert.deepEqual(plain(fixture.chat.context()), { annotationIds: [] });
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
