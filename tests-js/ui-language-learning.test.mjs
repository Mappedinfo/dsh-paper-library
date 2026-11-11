import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import {resolveTranslationTarget} from '../src/harness/language-learning.mjs'
import { readFile } from 'node:fs/promises'
const scripts = await Promise.all(['settings-models.js','language-learning.js'].map(name=>readFile(new URL(`../web/${name}`,import.meta.url),'utf8')))
const clone = value => JSON.parse(JSON.stringify(value))
const tick = () => new Promise(resolve => setImmediate(resolve))
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
function fixture({ get, put, respond } = {}) {
  const elements = new Map(), requests = [], writes = [], storage = new Map(), toasts = [], chats = []
  const floating = { attached: [], calls: [] }
  let currentPaper = null, selection = null, serial = 0
  class Element {
    constructor(tag = 'div') { this.tagName = tag.toUpperCase(); this.children = []; this.listeners = new Map(); this.value = ''; this.hidden = false; this.disabled = false; this.dataset = {}; this.style = {}; this.classList = { toggle() {} } }
    set id(value) { this._id = value; if (value) elements.set(value, this) } get id() { return this._id }
    set textContent(value) { this.text = String(value); this.children = [] } get textContent() { return this.text || '' }
    append(...nodes) { for (const node of nodes) { this.children.push(node); node.parentElement = this } }
    replaceChildren(...nodes) { this.children = []; this.append(...nodes) }
    replaceWith(node) { const parent = this.parentElement; parent.children.splice(parent.children.indexOf(this), 1, node); node.parentElement = parent }
    get selectedOptions() { return this.children.flatMap(node=>node.tagName==='OPTGROUP'?node.children:[node]).filter(node=>node.value===this.value) }
    setAttribute() {} focus() {}
    getBoundingClientRect() { return { left: parseFloat(this.style.left) || 16, top: parseFloat(this.style.top) || 16, width: parseFloat(this.style.width) || 420, height: parseFloat(this.style.height) || 590 } }
    addEventListener(type, fn) { const listeners = this.listeners.get(type) || []; listeners.push(fn); this.listeners.set(type, listeners) }
    async dispatch(type, args = {}) { for (const fn of this.listeners.get(type) || []) await fn({ preventDefault() {}, currentTarget: this, ...args }) }
  }
  const element = id => { if (!elements.has(id)) { const node = new Element(); node.id = id } return elements.get(id) }
  const document = { body: new Element('body'), createElement: tag => new Element(tag), getElementById: element }
  const window = { innerWidth: 1000, innerHeight: 800, crypto: { randomUUID: () => `request-${++serial}` }, PaperFloatingWindows: { attach(panel, options) {
    floating.attached.push({ panel, options })
    return { restore() { floating.calls.push('restore') }, save() { floating.calls.push('save') }, dispose() { floating.calls.push('dispose') } }
  } } }
  for(const script of scripts)vm.runInNewContext(script, { window, document, setTimeout, clearTimeout, navigator: { clipboard: { writeText: async () => {} } }, URL, Blob }, { filename: 'web/language-learning.js' })
  const result = args => ({ id: `result-${args.request_id}`, request_id: args.request_id, paper_id: args.id, page: args.page || null, mode: args.mode, source_text: args.text, result: 'Synthetic translated result', explanation: 'Synthetic explanation', model: { provider: 'dsh', model: 'current' }, vocabulary: [], status: 'complete' })
  const ui = window.PaperLanguageLearning.create({
    api: async (action, args) => { requests.push({ action, ...clone(args) }); const value = respond?.(action, args, result); if (value !== undefined) return value; return action === 'language_generate' ? result(args) : { items: [], total: 0 } },
    persistence: { get: async key => get ? get(key) : clone(storage.get(key) || null), put: async (key, value) => { writes.push({ key, value: clone(value) }); if (put) await put(key, value); storage.set(key, clone(value)) }, flush: async () => {} },
    getPaper: () => currentPaper, getSelection: () => selection, toast: text => toasts.push(text), prepareChat: (...args) => chats.push(args),
  })
  ui.setAvailable(true)
  return { previewTarget:window.PaperLanguageLearning.previewTranslationTarget,ui, element, requests, writes, storage, toasts, chats, result, floating,
    actions(action) { return requests.filter(row => row.action === action) },
    async open(id) { currentPaper = { id, title: id }; return ui.paperChanged(currentPaper) },
    setCurrent(id) { currentPaper = id ? { id, title: id } : null; ui.sync() },
    select(text = 'Selected PDF source.', page = 2) { selection = { id: currentPaper.id, text, page } },
    async type(text) { element('language-source').value = text; await element('language-source').dispatch('input') },
    async click(id) { await element(id).dispatch('click'); await tick() },
    async settle() { for (let i = 0; i < 20 && ui.snapshot().busy; i++) await tick() },
  }
}

test('language window connects to the shared geometry controller and releases it on disposal', async () => {
  const f = fixture()
  assert.equal(f.floating.attached.length, 1)
  assert.equal(f.floating.attached[0].panel, f.element('language-panel'))
  assert.equal(f.floating.attached[0].options.key, 'reader:language-window')
  assert.equal(typeof f.floating.attached[0].options.persistence.get, 'function')
  f.ui.show(); f.ui.showSettings(); await tick()
  assert.deepEqual(f.floating.calls, ['restore', 'restore'])
  f.ui.dispose()
  assert.deepEqual(f.floating.calls, ['restore', 'restore', 'save', 'dispose'])
})

test('settings show configured routes and save prompts with the loaded revision', async () => {
  const f = fixture({ respond: (action, args) => {
    if (action === 'language_settings_get') return { revision: 'rev-1', value: { model: null, translate_prompt: '旧翻译提示', polish_prompt: '', target_language: 'en' }, default_model: { provider: 'host', model: 'default' }, models: [{ provider: 'host', id: 'chosen', name: 'Chosen' }, { provider: 'other', id: 'second', name: 'Second' }, { provider: 'host', id: 'third', name: 'Third' }] }
    if (action === 'language_settings_update') return { revision: 'rev-2', value: args.value }
  } });
  f.ui.showSettings(); await tick();
  assert.equal(f.ui.snapshot().view, 'settings');
  const groups = f.element('language-settings-model').children.filter(child => child.tagName === 'OPTGROUP')
  assert.deepEqual(groups.map(group => group.label), ['host', 'other'])
  assert.deepEqual(groups.map(group => group.children.length), [2, 1])
  assert.equal(f.element('language-settings-target').value, 'en')
  f.element('language-settings-model').value = groups[0].children[0].value;f.element('language-settings-translate').value = '保留术语';f.element('language-settings-polish').value = '简洁表达';
  await f.click('language-settings-save');
  const saved = f.requests.find(row => row.action === 'language_settings_update');
  assert.deepEqual(saved.value, { model: { provider: 'host', model: 'chosen' }, target_language: 'en', translate_prompt: '保留术语', polish_prompt: '简洁表达' });
  assert.equal(saved.expected_revision, 'rev-1');
})

test('translation follows the latest saved global target on each operation and defaults old settings to auto', async () => {
  let target = 'en'
  const f = fixture({ respond: action => action === 'language_settings_get' ? { value: target ? { target_language: target } : {} } : undefined })
  await f.open('paper-a'); await f.type('Synthetic source.')
  assert.equal(f.element('language-target').value, '')
  for (const direction of ['en', 'zh-CN', null]) {
    target = direction
    await f.click('language-translate'); await f.settle()
  }
  assert.deepEqual(f.actions('language_generate').map(row => row.target_language), ['en', 'zh-CN', 'auto'])
  assert.equal(f.actions('language_settings_get').length, 3)
})

test('manual direction overrides global settings without a settings request', async () => {
  const f = fixture()
  await f.open('paper-a'); await f.type('Synthetic source.')
  for (const target of ['auto', 'en', 'zh-CN']) {
    f.element('language-target').value = target; await f.element('language-target').dispatch('change')
    await f.click('language-translate'); await f.settle()
  }
  assert.deepEqual(f.actions('language_generate').map(row => row.target_language), ['auto', 'en', 'zh-CN'])
  assert.equal(f.actions('language_settings_get').length, 0)
})

test('late global-target read cannot submit the previous paper after navigation', async () => {
  const pending = deferred(), f = fixture({ respond: action => action === 'language_settings_get' ? pending.promise : undefined })
  await f.open('paper-a'); await f.type('Synthetic A source.')
  await f.click('language-translate')
  await f.open('paper-b'); await f.type('Synthetic B draft.')
  pending.resolve({ value: { target_language: 'en' } }); await f.settle()
  assert.equal(f.actions('language_generate').length, 0)
  assert.equal(f.element('language-source').value, 'Synthetic B draft.')
})

test('restoring an unfinished automatic translation retries with the original direction and request identity', async () => {
  for (const status of ['pending', 'committing']) {
    const f = fixture({ respond: action => action === 'language_history' ? { items: [{ status, mode: 'translate', source_text: '中文原文', page: 2, target_language: 'en', requested_target_language: 'auto', request_id: 'old-request', created_at: '2026-01-01T00:00:00Z' }], total: 1 } : undefined })
    await f.open('paper-a'); f.ui.show('history'); await tick()
    await f.element('language-history-list').children[0].dispatch('click')
    await f.click('language-translate'); await f.settle()
    const retried = f.actions('language_generate')[0]
    assert.equal(retried.target_language, 'auto')
    assert.equal(retried.request_id, 'old-request')
  }
})

test('global-target read failure preserves the draft and never sends a generation', async () => {
  const f = fixture({ respond: action => { if (action === 'language_settings_get') throw new Error('Synthetic settings unavailable') } })
  await f.open('paper-a'); await f.type('Synthetic draft.')
  await f.click('language-translate'); await f.settle()
  assert.equal(f.actions('language_generate').length, 0)
  assert.equal(f.element('language-source').value, 'Synthetic draft.')
  assert.match(f.element('language-status').textContent, /Synthetic settings unavailable/)
})

test('settings conflict keeps the unsaved prompts available to copy', async () => {
  const f = fixture({ respond: action => {
    if(action==='language_settings_get')return {revision:'rev-1',value:{model:null,translate_prompt:'',polish_prompt:''},models:[]};
    if(action==='language_settings_update')throw Object.assign(new Error('changed elsewhere'),{code:'STATE_CONFLICT'});
  } });
  f.ui.showSettings();await tick();f.element('language-settings-polish').value='Unsaved guidance';
  await f.click('language-settings-save');
  assert.equal(f.element('language-settings-polish').value,'Unsaved guidance');
  assert.match(f.element('language-status').textContent,/本窗口内容仍保留/);
})

test('selection action waits for the shared paper draft read and cannot be overwritten by its late response', async () => {
  const load = deferred(); let reads = 0
  const f = fixture({ get: () => { reads++; return load.promise } })
  const opening = f.open('paper-a'); f.select(); const translating = f.ui.useSelection('translate')
  assert.equal(f.element('language-source').disabled, true); assert.equal(f.requests.length, 0)
  load.resolve({ text: 'Previous durable draft.', target_language: 'en' }); await opening; await translating
  assert.equal(reads, 1); assert.equal(f.actions('language_generate')[0].text, 'Selected PDF source.'); assert.equal(f.actions('language_generate')[0].page, 2)
  assert.equal(f.element('language-source').value, 'Selected PDF source.')
})

test('request identity write is awaited before the model request begins', async () => {
  const durable = deferred(); const f = fixture({ put: () => durable.promise })
  await f.open('paper-a'); await f.type('Text to translate.'); await f.click('language-translate')
  assert.equal(f.actions('language_generate').length, 0); durable.resolve(); await f.settle()
  assert.equal(f.actions('language_generate').length, 1); assert.equal(f.actions('language_generate')[0].request_id, f.writes.find(row => row.value.failed_request)?.value.failed_request.request_id)
})

test('editing while generation runs preserves new draft and does not render the stale result as current', async () => {
  const generated = deferred(); let args; const f = fixture({ respond: (action, input) => { if (action === 'language_generate') { args = input; return generated.promise } } })
  await f.open('paper-a'); await f.type('Original request.'); await f.click('language-translate'); await f.type('New unsent draft.')
  generated.resolve(f.result(args)); await f.settle()
  assert.equal(f.element('language-source').value, 'New unsent draft.'); assert.equal(f.ui.snapshot().lastResultId, undefined)
  assert.equal(f.storage.get('language-draft:paper-a').failed_request, null); assert.equal(f.toasts.length, 1)
})

test('A to B to A navigation invalidates the previous generation response', async () => {
  const generated = deferred(); let args; const f = fixture({ respond: (action, input) => { if (action === 'language_generate') { args = input; return generated.promise } } })
  await f.open('paper-a'); await f.type('Original A source.'); await f.click('language-translate')
  await f.open('paper-b'); await f.type('B draft.'); await f.open('paper-a'); await f.type('New A draft.')
  generated.resolve(f.result(args)); await f.settle()
  assert.equal(f.element('language-source').value, 'New A draft.'); assert.equal(f.ui.snapshot().lastResultId, undefined)
  assert.equal(f.storage.get('language-draft:paper-b').text, 'B draft.')
})

test('uncertain network retry keeps request identity but terminal failure permits a new explicit invocation', async () => {
  let count = 0
  const f = fixture({ respond: action => {
    if (action !== 'language_generate') return
    if (++count === 1) throw new Error('Synthetic lost response')
    if (count === 2) throw Object.assign(new Error('Synthetic terminal failure'), { code: 'LANGUAGE_FAILED', retry_with_new_request: true })
  } })
  await f.open('paper-a'); await f.type('Retry source.')
  for (let i = 0; i < 3; i++) { await f.click('language-translate'); await f.settle() }
  const calls = f.actions('language_generate')
  assert.equal(calls[0].request_id, calls[1].request_id); assert.notEqual(calls[1].request_id, calls[2].request_id)
})

test('late history response cannot overwrite another active view status', async () => {
  const history = deferred(), f = fixture({ respond: action => action === 'language_history' ? history.promise : undefined })
  await f.open('paper-a'); f.ui.show('history'); f.ui.show('work'); f.element('language-status').textContent = 'Current status'
  history.resolve({ items: [], total: 0 }); await tick()
  assert.equal(f.element('language-status').textContent, 'Current status')
})

test('paper authority prevents stale generation and sending another paper result into current chat', async () => {
  const f = fixture(); await f.open('paper-a'); await f.type('Source A.'); await f.click('language-translate'); await f.settle()
  f.setCurrent('paper-b'); assert.equal(f.element('language-translate').disabled, true)
  await f.click('language-discuss'); await f.click('language-translate')
  assert.equal(f.chats.length, 0); assert.equal(f.actions('language_generate').length, 1)
  f.setCurrent('paper-a'); await f.click('language-discuss')
  assert.equal(f.chats[0][1].paperId, 'paper-a')
})


test('follow mode shows resolved target and updates with input without per-keystroke requests',async()=>{
 let target='auto';const f=fixture({respond:action=>action==='language_settings_get'?{value:{target_language:target}}:undefined});
 await f.open('paper-a');f.ui.show();await tick();assert.match(f.element('language-target-current').textContent,/输入后识别/);
 await f.type('An English sentence.');assert.match(f.element('language-target-current').textContent,/检测目标：中文/);
 await f.type('这是一段中文原句。');assert.match(f.element('language-target-current').textContent,/检测目标：英文/);assert.equal(f.actions('language_settings_get').length,1);
 target='en';f.ui.show();await tick();await f.type('English stays here.');assert.match(f.element('language-target-current').textContent,/当前目标：英文/);
 f.element('language-target').value='zh-CN';await f.element('language-target').dispatch('change');assert.match(f.element('language-target-current').textContent,/当前目标：中文/);
 f.ui.dispose();
});
test('target preview matches server script rules including mixed text and formula markup',()=>{
 const f=fixture();for(const text of ['English prose.','中文论文里的表达。','This 模型 uses Transformer embeddings.','日本語のテキストです。','한국어 문장입니다.','\\cite{中文标签} A method with $x+y$.',''])for(const target of ['auto','zh-CN','en'])assert.equal(f.previewTarget(text,target),resolveTranslationTarget(text,target));f.ui.dispose();
});
test('polish direction is persisted and sent only for polish, changing direction uses a new request',async()=>{
 const f=fixture();await f.open('paper-a');await f.type('A synthetic expression.');await f.click('language-direction-concise');await f.click('language-polish');await f.settle();
 const first=f.actions('language_generate')[0];assert.equal(first.polish_direction,'concise');assert.equal(f.writes.at(-1).value.polish_direction,'concise');
 await f.click('language-direction-academic');await f.click('language-polish');await f.settle();const second=f.actions('language_generate')[1];assert.equal(second.polish_direction,'academic');assert.notEqual(first.request_id,second.request_id);
 await f.click('language-translate');await f.settle();assert.equal(Object.hasOwn(f.actions('language_generate')[2],'polish_direction'),false);
 await f.open('paper-b');await f.open('paper-a');await f.click('language-polish');await f.settle();assert.equal(f.actions('language_generate')[3].polish_direction,'academic');f.ui.dispose();
});
test('unavailable followed settings are shown as unknown without guessing a target',async()=>{
 const f=fixture({respond:action=>{if(action==='language_settings_get')throw Error('offline');}});await f.open('paper-a');await f.type('English text.');f.ui.show();await tick();assert.match(f.element('language-target-current').textContent,/待读取/);assert.equal(f.actions('language_generate').length,0);f.ui.dispose();
});
