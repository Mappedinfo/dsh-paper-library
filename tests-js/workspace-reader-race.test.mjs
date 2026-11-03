import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFile } from 'node:fs/promises'

const app = await readFile(new URL('../web/app.js', import.meta.url), 'utf8')
const readers = app.slice(app.indexOf('function readerSurfaceActive()'), app.indexOf('async function openResource('))
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const turn = () => new Promise(resolve => setImmediate(resolve))
function fixture(options = {}) {
  const calls = [], nodes = new Map(), source = { id: 'paper-a', title: 'Synthetic paper', pdf: false }
  let writerOpen = options.writerOpen === true, boardOpen = options.boardOpen === true
  const get = id => {
    if (!nodes.has(id)) nodes.set(id, { hidden: false, textContent: '', classList: { add() {} }, replaceChildren() {} })
    return nodes.get(id)
  }
  const context = {
    state: { active: { id: 'old-paper' }, itemTicket: 0, pageTicket: 0 },
    readerStateReady: true, readerPaperId: 'old-paper', restoringReader: false,
    workspaceNavigationTransition: false,
    workspaceNavigationUI: { state: () => ({ section: options.section || 'paper' }), setCurrent: value => calls.push(['context', value.kind, value.id]) },
    latexUI: { isOpen: () => writerOpen, close: async () => { calls.push(['close-writer']); if (!options.refuseClose) writerOpen = false } },
    boardUI: { isOpen: () => boardOpen, close: async () => { calls.push(['close-board']); boardOpen = false; return true } },
    linkedHandwritingUI: null, resourceUI: null, knowledgeUI: null, languageUI: null,
    workbenchUI: { setTable: value => calls.push(['table', value]), header() {}, paperChanged() {} },
    paperChatUI: { visible() {}, paperOpened: () => options.chat?.promise },
    readingPanels: { paperChanged() {} }, knowledgeGraphUI: { clear() {} },
    $: get, document: { querySelector: () => ({ classList: { add() {} } }) },
    api: async (action, input) => { calls.push(['api', action, input.id]); return options.metadata ? options.metadata.promise : source },
    persistence: { get: async () => { calls.push(['read-state']); return options.saved?.promise } },
    publishReaderState() {}, clearPage: () => calls.push(['clear-page']), errorAt() {},
    renderPaperHeader() {}, renderList() {}, renderAnnotations() {},
    loadAnnotations: id => calls.push(['annotations', id]), loadFeedback: id => calls.push(['feedback', id]),
    switchTab: async tab => calls.push(['tab', tab]), applyReaderSnapshot: async () => calls.push(['apply-snapshot']),
    title: value => value.title || value.id,
  }
  vm.createContext(context); vm.runInContext(readers, context)
  return { context, calls, source, writer: value => { writerOpen = value }, board: value => { boardOpen = value } }
}

test('a delayed paper metadata response cannot take over an opened writer or board', async () => {
  for (const kind of ['writer', 'board']) {
    const metadata = deferred(), f = fixture({ metadata }), pending = f.context.openPaper('paper-a')
    f[kind](true)
    metadata.resolve(f.source)
    assert.equal(await pending, undefined)
    assert.equal(f.context.state.active, null)
    assert.equal(f.calls.some(call => ['context', 'tab', 'read-state'].includes(call[0])), false)
  }
})

test('saved-reader and chat restoration finishing after writing opens do not switch its navigation', async () => {
  for (const stage of ['saved', 'chat']) {
    const gate = deferred(), f = fixture({ [stage]: gate }), pending = f.context.openPaper('paper-a')
    await turn()
    f.writer(true)
    gate.resolve(stage === 'saved' ? { paperId: 'paper-a', page: 2 } : null)
    assert.equal(await pending, undefined)
    assert.equal(f.calls.some(call => call[0] === 'context' || call[0] === 'apply-snapshot'), false)
    if (stage === 'saved') assert.equal(f.calls.some(call => call[0] === 'tab'), false)
  }
})

test('accepted category navigation cancels a pending paper even while no editor is open', async () => {
  const metadata = deferred(), f = fixture({ metadata }), pending = f.context.openPaper('paper-a')
  f.context.cancelReaderOpening()
  metadata.resolve(f.source)
  assert.equal(await pending, undefined)
  assert.equal(f.calls.some(call => call[0] === 'context' || call[0] === 'tab'), false)
})

test('background paper restoration never closes writing, canvas or the chosen category', async () => {
  for (const options of [{ writerOpen: true }, { boardOpen: true }, { section: 'latex' }, { section: 'project' }]) {
    const f = fixture(options)
    assert.equal(await f.context.openPaper('paper-a', { background: true }), undefined)
    assert.deepEqual(f.calls, [])
  }
})

test('deliberately opening a paper uses the writer save guard and reaches the exact paper on success', async () => {
  const blocked = fixture({ writerOpen: true, refuseClose: true })
  assert.equal(await blocked.context.openPaper('paper-a'), undefined)
  assert.deepEqual(blocked.calls, [['close-writer']])
  const f = fixture({ writerOpen: true, section: 'latex' })
  assert.equal(await f.context.openPaper('paper-a'), 1)
  assert.deepEqual(f.calls[0], ['close-writer'])
  assert.deepEqual(f.calls.at(-1), ['context', 'paper', 'paper-a'])
})
