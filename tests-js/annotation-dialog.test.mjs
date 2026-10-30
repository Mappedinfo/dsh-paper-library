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
    companionUI: { refresh: () => calls.push('companion:refresh') },
    loadAnnotations: async id => { calls.push(`notes:${id}`); if (options.refreshFailure) throw Error('Synthetic refresh failure') },
    refreshPage: async page => calls.push(`page:${page}`), publishReaderState: () => calls.push('publish'),
    linkedHandwritingUI: { toggle: async () => calls.push('handwriting') },
    paperChatUI: { available: () => true, savedAnnotation: async (...args) => calls.push({ chat: args }) },
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
  assert.equal(f.calls.filter(call => call.chat).length, 1)
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
  const f = fixture({ api: () => new Promise(done => { resolve = done }) }), pending = f.submit('annotation-save-handwriting')
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
