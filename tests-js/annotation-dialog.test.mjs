import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('../web/app.js', import.meta.url), 'utf8')
const section = source.slice(source.indexOf('let annotationSaveBusy = false;'), source.indexOf('/** Reader ↔ rail linking:'))
function fixture(options = {}) {
  const nodes = new Map(['annotation-dialog', 'annotation-form', 'annotation-comment', 'auto-feedback'].map(id => [id, { id, open: id === 'annotation-dialog', value: '', checked: false }]))
  nodes.get('annotation-comment').value = options.comment ?? 'Synthetic interpretation'
  const calls = [], errors = [], messages = []
  const state = { active: { id: 'paper-a', pdf: true }, selection: { id: 'paper-a' }, annotationDraft: { mode: options.mode || 'note', id: 'paper-a', page: 3, note: { id: 'note-a' }, color: '#3489cb' } }
  const context = {
    state, $: id => nodes.get(id), toast: (...args) => messages.push(args), readingShell: null,
    errorAt: (id, error) => errors.push([id, error?.message || null]),
    setBusy: (form, busy) => { form.busy = busy },
    closeDialog: id => { nodes.get(id).open = false; calls.push('close') },
    openDialog: id => { nodes.get(id).open = true; calls.push('open') },
    clearSelection: () => { state.selection = null; calls.push('clear') },
    api: async (action, payload) => { calls.push({ action, ...payload }); return options.api ? options.api(action, payload) : { annotation: { id: 'saved-a' } } },
    companionUI: { available: () => options.available !== false, refresh: () => calls.push('companion:refresh') },
    loadAnnotations: async id => { calls.push(`notes:${id}`); if (options.refreshFailure) throw Error('Synthetic refresh failure') },
    refreshPage: async page => calls.push(`page:${page}`), publishReaderState: () => calls.push('publish'),
    linkedHandwritingUI: { toggle: async () => calls.push('handwriting') },
    paperChatUI: { available: () => true, savedAnnotation: async (...args) => calls.push({ chat: args }), annotationsChanged: async id => calls.push({ catalog: id }) },
    requestFeedback: () => calls.push('feedback'),
  }
  vm.createContext(context); vm.runInContext(section, context)
  const submit = id => context.saveAnnotation({ preventDefault() {}, submitter: id ? { id } : null, target: nodes.get('annotation-form') })
  return { context, state, nodes, calls, errors, messages, submit }
}

test('outside dismissal saves a nonempty draft to its captured PDF and closes only after success', async () => {
  let resolve
  const f = fixture({ api: () => new Promise(done => { resolve = done }) })
  const pending = f.context.dismissAnnotation()
  assert.equal(f.nodes.get('annotation-dialog').open, true)
  assert.equal(f.nodes.get('annotation-comment').readOnly, true)
  assert.equal(f.calls[0].action, 'annotate')
  assert.equal(f.calls[0].id, 'paper-a')
  assert.equal(f.calls[0].page, 3)
  assert.equal(f.calls[0].comment, 'Synthetic interpretation')
  assert.equal(await f.context.dismissAnnotation(), false)
  assert.equal(await f.submit(), false)
  assert.equal(f.calls.filter(call => call.action === 'annotate').length, 1)
  resolve({ annotation: { id: 'saved-a' } })
  assert.equal(await pending, true)
  assert.equal(f.nodes.get('annotation-dialog').open, false)
  assert.equal(f.nodes.get('annotation-comment').readOnly, false)
  assert.equal(f.state.annotationDraft, null)
  assert.equal(f.calls.filter(call => call.chat).length, 0)
  assert.equal(f.calls.filter(call => call.catalog).length, 1)
  assert.equal(f.calls[0].companion_skip, true)
})

test('empty outside dismissal creates no record, including blank edited comments', async () => {
  for (const mode of ['note', 'highlight', 'edit']) {
    const f = fixture({ comment: ' \n\t ', mode })
    assert.equal(await f.context.dismissAnnotation(), true)
    assert.equal(f.nodes.get('annotation-dialog').open, false)
    assert.equal(f.calls.some(call => call.action), false)
    assert.equal(f.state.annotationDraft, null)
  }
})

test('failed outside saving keeps the same draft, text, window and selection available', async () => {
  const f = fixture({ api: () => { throw Error('Synthetic PDF save failure') } }), draft = f.state.annotationDraft
  assert.equal(await f.context.dismissAnnotation(), false)
  assert.equal(f.nodes.get('annotation-dialog').open, true)
  assert.equal(f.nodes.get('annotation-comment').value, 'Synthetic interpretation')
  assert.equal(f.nodes.get('annotation-comment').readOnly, false)
  assert.equal(f.state.annotationDraft, draft)
  assert.deepEqual(f.state.selection, { id: 'paper-a' })
  assert.match(f.errors.at(-1)[1], /PDF save failure/)
})

test('an edited annotation uses update and a refresh failure cannot recreate an already saved note', async () => {
  const f = fixture({ mode: 'edit', refreshFailure: true })
  assert.equal(await f.context.dismissAnnotation(), true)
  assert.equal(f.calls[0].action, 'annotation_update')
  assert.equal(f.calls[0].annotation_id, 'note-a')
  assert.equal(f.state.annotationDraft, null)
  assert.equal(f.nodes.get('annotation-dialog').open, false)
  assert.equal(await f.context.dismissAnnotation(), true)
  assert.equal(await f.submit(), false)
  assert.equal(f.calls.filter(call => call.action).length, 1)
  assert.match(f.messages.at(-1)[0], /已保存.*后续操作/)
})

test('a completion for an old paper cannot clear a new selection or activate handwriting/chat there', async () => {
  let resolve
  const f = fixture({ api: () => new Promise(done => { resolve = done }) }), pending = f.submit()
  f.state.active = { id: 'paper-b', pdf: true }; f.state.selection = { id: 'paper-b' }
  const newDraft = { mode: 'note', id: 'paper-b', page: 1 }; f.state.annotationDraft = newDraft
  resolve({ annotation: { id: 'saved-a' } })
  assert.equal(await pending, true)
  assert.equal(f.state.annotationDraft, newDraft)
  assert.deepEqual(f.state.selection, { id: 'paper-b' })
  assert.equal(f.nodes.get('annotation-dialog').open, true)
  assert.equal(f.calls.includes('handwriting'), false)
  assert.equal(f.calls.some(call => call.chat), false)
  assert.equal(f.calls.includes('notes:paper-a'), false)
})

test('generic backdrop handling routes only annotation to autosave and busy explicit closing is refused', () => {
  assert.match(source, /dialog\.id === 'annotation-dialog'\) void dismissAnnotation\(\); else dialog\.close\(\)/)
  assert.match(source, /dialog\.id === 'annotation-dialog' && annotationSaveBusy\) return; dialog\.close\(\)/)
  assert.match(source, /'cancel', event => \{ if \(annotationSaveBusy\) event\.preventDefault\(\)/)
})

test('rectangle comments preserve region, stroke width and color; an empty region does not launch companion AI', async () => {
  const f=fixture({mode:'square',comment:''});
  Object.assign(f.state.annotationDraft,{width:4,selection:{page:3,text:'',rects:[[12,24,100,140]]}});
  assert.equal(await f.submit(),true);
  const request=f.calls.find(call=>call.action==='annotate');
  assert.equal(request.type,'square');assert.deepEqual(request.rects,[[12,24,100,140]]);
  assert.equal(request.width,4);assert.equal(request.color,'#3489cb');assert.equal(request.text,'');assert.equal(request.companion_skip,true);
});

test('failed rectangle save retains geometry and comment for retry; cancelling an empty frame writes nothing', async () => {
  const f=fixture({mode:'square',api:()=>{throw Error('Synthetic write conflict')}});
  Object.assign(f.state.annotationDraft,{width:1,selection:{page:3,text:'',rects:[[12,24,100,140]]}});
  const draft=f.state.annotationDraft;assert.equal(await f.submit(),false);assert.equal(f.state.annotationDraft,draft);
  assert.equal(f.nodes.get('annotation-dialog').open,true);assert.equal(f.nodes.get('annotation-comment').value,'Synthetic interpretation');
  const empty=fixture({mode:'square',comment:''});assert.equal(await empty.context.dismissAnnotation(),true);assert.equal(empty.calls.some(c=>c.action),false);
});


test('save only skips host and standalone automatic AI even with a comment', async () => {
  for (const mode of ['note', 'edit']) {
    const f = fixture({ mode }); f.nodes.get('auto-feedback').checked = true;
    assert.equal(await f.submit(), true);
    assert.equal(f.calls[0].companion_skip, true);
    assert.equal(f.calls.some(call => call.action === 'companion_ask' || call.chat || call === 'feedback'), false);
  }
});

test('save and ask persists the question first, then admits exactly one request with saved identity', async () => {
  let resolve;
  const f = fixture({ api: action => action === 'annotate' ? new Promise(done => { resolve = done }) : { status:'queued' } });
  const pending = f.submit('annotation-save-ask');
  assert.equal(f.calls.some(call => call.action === 'companion_ask'), false);
  assert.equal(await f.submit('annotation-save-ask'), false);
  resolve({ annotation: { id:'new-note', version:'saved-version' } });
  assert.equal(await pending, true);
  const requests = f.calls.filter(call => call.action);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].comment, 'Synthetic interpretation');
  assert.equal(requests[0].companion_skip, true);
  assert.deepEqual(requests[1], { action:'companion_ask', id:'paper-a', annotation_id:'new-note', version:'saved-version' });
});

test('selected text can be asked without a question; an empty region needs a remark', async () => {
  const f = fixture({ mode:'underline', comment:'' });
  f.state.annotationDraft.selection = { text:'Synthetic quoted passage', rects:[[1,2,3,4]] };
  assert.equal(await f.submit('annotation-save-ask'), true);
  assert.equal(f.calls.filter(call => call.action === 'companion_ask').length, 1);
  const blank = fixture({ mode:'square', comment:'' });
  assert.equal(await blank.submit('annotation-save-ask'), false);
  assert.equal(blank.calls.length, 0);
  assert.equal(blank.nodes.get('annotation-dialog').open, true);
  assert.match(blank.errors.at(-1)[1], /备注或问题/);
});

test('save failure never asks; ask failure leaves the successful save closed without recreating it', async () => {
  const failedSave = fixture({ api: () => { throw Error('write conflict') } });
  assert.equal(await failedSave.submit('annotation-save-ask'), false);
  assert.equal(failedSave.calls.some(call => call.action === 'companion_ask'), false);
  const f = fixture({ api: action => { if (action === 'companion_ask') throw Error('connection failed'); return { annotation:{id:'saved-a'} }; } });
  assert.equal(await f.submit('annotation-save-ask'), true);
  assert.equal(f.nodes.get('annotation-dialog').open, false);
  assert.equal(f.state.annotationDraft, null);
  assert.equal(await f.submit('annotation-save-ask'), false);
  assert.equal(f.calls.filter(call => call.action === 'annotate').length, 1);
  assert.match(f.messages.find(([text]) => text.includes('提问未完成'))[0], /卡片重试/);
});

test('refresh failure cannot suppress an explicit ask, and paper switching preserves its captured source', async () => {
  const f = fixture({ refreshFailure:true });
  assert.equal(await f.submit('annotation-save-ask'), true);
  assert.equal(f.calls.filter(call => call.action === 'companion_ask').length, 1);
  let resolve;
  const switched = fixture({ api: action => action === 'annotate' ? new Promise(done => { resolve=done }) : {} });
  const pending = switched.submit('annotation-save-ask');
  switched.state.active = { id:'paper-b', pdf:true }; switched.state.selection = { id:'paper-b' };
  resolve({ annotation:{id:'saved-a'} }); await pending;
  assert.equal(switched.calls.find(call => call.action === 'companion_ask').id, 'paper-a');
  assert.deepEqual(switched.state.selection, { id:'paper-b' });
});

test('unavailable DSH keeps the draft untouched and the modal offers two unambiguous save actions', async () => {
  const f = fixture({ available:false });
  assert.equal(await f.submit('annotation-save-ask'), false);
  assert.equal(f.calls.length, 0);
  const html = await readFile(new URL('../web/index.html', import.meta.url), 'utf8');
  const modal = html.slice(html.indexOf('<dialog id="annotation-dialog"'), html.indexOf('</dialog>', html.indexOf('<dialog id="annotation-dialog"')));
  assert.match(modal, /仅保存批注/); assert.match(modal, /保存并问 DSH/);
  assert.doesNotMatch(modal, /保存并手写|保存并放入主对话/);
});

test('existing saved or failed requests report their real state instead of claiming a new send', async () => {
  for (const status of ['saved', 'failed']) {
    const f = fixture({ api: action => action === 'companion_ask' ? {status} : {annotation:{id:'saved-a'}} });
    assert.equal(await f.submit('annotation-save-ask'), true);
    assert.equal(f.calls.filter(call => call.action === 'companion_ask').length, 1);
    assert.equal(f.messages.some(([text]) => text.includes('已提交 DSH')), false);
    assert.equal(f.messages.some(([text]) => text.includes(status === 'saved' ? '已有 AI 回复' : '重试')), true);
  }
});
