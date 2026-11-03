import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('../web/app.js', import.meta.url), 'utf8')
const plain = value => JSON.parse(JSON.stringify(value))
function balanced(start) {
  const open = source.indexOf('{', start); let depth = 0
  for (let end = open; end < source.length; end++) { if (source[end] === '{') depth++; else if (source[end] === '}' && --depth === 0) return source.slice(start, end + 1) }
  throw Error('Unclosed function in test source')
}
function functionSource(name) { const found = source.indexOf(`function ${name}(`); if (found < 0) throw Error(`Missing ${name}`); return balanced(source.slice(Math.max(0, found - 6), found) === 'async ' ? found - 6 : found) }
function fixture(options = {}) {
  const calls = [], contexts = [], tables = [], visible = [], alerts = []
  let boardOpen = options.boardOpen ?? false, latexOpen = options.latexOpen ?? false
  let boardCurrent = { kind: 'board', id: 'board-source', title: 'Source board' }, latexCurrent = { kind: 'latex', id: 'latex-source', title: 'Source draft' }
  const elements = new Map(['workspace-navigation-area', 'workspace-navigation-home', 'library-literature-content', 'workspace-versions'].map(id => [id, { id, hidden: false, dataset: {}, parentNode: null }]))
  const home = elements.get('workspace-navigation-home'), area = elements.get('workspace-navigation-area'), writing = { prepend: node => { calls.push('nav:writing'); node.parentNode = writing } }, library = { dataset: {} }
  home.parentNode = { id: 'home-parent' }; home.after = node => { calls.push('nav:home'); node.parentNode = home.parentNode }; area.parentNode = home.parentNode
  const state = { active: options.active ?? { id: 'paper-source' }, project: 'old-reading-project', itemTicket: 0, pageTicket: 0 }
  const context = {
    readerStateReady: true, title: item => item.title || item.id, workspaceNavigationTransition: false, restoringReader: false, restoringInkDraft: false, inkSaveBusy: false, annotationSaveBusy: options.annotationBusy || false, state,
    dismissAnnotation: async () => options.dismissAnnotation !== false,
    selectProject: async id => { calls.push(`project:select:${id}`); state.project = id },
    $: id => elements.get(id), document: { fullscreenElement: options.fullscreen ? {} : null, exitFullscreen: async () => { calls.push('fullscreen:exit') }, querySelector: selector => selector === '.library-pane' ? library : selector === '#latex-view .latex-topbar' ? writing : null },
    toast: message => alerts.push(message), pdfReader: { isInking: () => options.inking || false }, handwritingUI: { isOpen: () => false },
    linkedHandwritingUI: { session: () => options.linked ? { id: 'linked' } : null, finish: async () => { calls.push('ink:finish'); return options.finishInk !== false } },
    publishReaderState: () => { calls.push('reader:publish'); return options.publish !== false },
    paperChatUI: { saveDraft: async () => { calls.push('chat:save'); if (options.chatFailure) throw Error('synthetic chat save failure') } },
    persistence: { flush: async () => { calls.push('state:flush'); if (options.saveFailure) throw Error('synthetic persistence conflict') } },
    resourceUI: { hide: () => calls.push('resource:hide') }, knowledgeUI: { hide: () => calls.push('knowledge:hide') },
    workbenchUI: { setTable: value => tables.push(value) }, readingPanels: { showLibrary: () => visible.push('library') },
    workspaceNavigationUI: { state: () => ({ current: options.current ?? null }), setCurrent: (...args) => contexts.push(plain(args)) },
    libraryLatexVersions: { clear: () => calls.push('versions:clear') },
    api: async (action, args) => { calls.push({ action, ...plain(args) }); if (options.apiFailure) throw Error('synthetic missing target'); if (options.api) return options.api(action, args); const record = { id: args.id }; return action === 'board_get' ? { board: record } : ['latex_project_get','project_get'].includes(action) ? { project: record } : record },
    openPaper: async id => { calls.push(`paper:open:${id}`); if (options.openFailure) return; state.active = { id: options.wrongId ? 'wrong-target' : id }; return 7 },
    boardUI: { isOpen: () => boardOpen, current: () => boardCurrent, open: async input => { calls.push({ boardOpen: plain(input) }); if (options.openFailure) return false; boardOpen = true; boardCurrent = { kind: 'board', id: options.wrongId ? 'wrong-target' : input.id }; return true }, close: async () => { calls.push('board:close'); if (options.boardConflict) return false; boardOpen = false; return true } },
    latexUI: { isOpen: () => latexOpen, current: () => options.emptyLatex ? null : latexCurrent, open: async id => { calls.push(`latex:open:${id}`); if (options.openFailure) return false; latexOpen = true; latexCurrent = { kind: 'latex', id: options.wrongId ? 'wrong-target' : id }; return true }, close: async () => { calls.push('latex:close'); if (!options.latexConflict) latexOpen = false } },
  }
  vm.createContext(context)
  for (const name of ['readerSurfaceActive', 'cancelReaderOpening', 'publishPaperWorkspace', 'placeWorkspaceNavigation', 'applyWorkspaceNavigation', 'workspaceContextChanged', 'prepareWorkspaceNavigation', 'closeWorkspaceSurfaces', 'openWorkspaceRoot', 'openWorkspaceTarget']) vm.runInContext(functionSource(name), context)
  return { context, calls, contexts, tables, visible, alerts, elements, area, home, writing, library, state }
}

test('an unavailable exact target is checked before closing the current source surface', async () => {
  for (const options of [{ apiFailure: true }, { api: () => ({ project: { id: 'wrong' } }) }, { api: () => ({ project: { id: 'latex-destination', archived: true } }) }, { api: () => ({ project: { id: 'latex-destination', exists: false } }) }]) {
    const f = fixture({ boardOpen: true, ...options })
    await assert.rejects(f.context.openWorkspaceTarget({ kind: 'latex', id: 'latex-destination' }))
    assert.equal(f.calls.includes('board:close'), false)
    assert.equal(f.context.boardUI.current().id, 'board-source')
    assert.deepEqual(f.tables, [])
    assert.equal(f.context.workspaceNavigationTransition, false)
  }
  const nonPaper = fixture({ boardOpen: true, api: () => ({ id: 'dataset', resource_kind: 'dataset' }) })
  await assert.rejects(nonPaper.context.openWorkspaceTarget({ kind: 'paper', id: 'dataset' }))
  assert.equal(nonPaper.calls.includes('board:close'), false)
})

test('canvas-note and writer-save conflicts keep navigation on the source surface', async () => {
  const board = fixture({ boardOpen: true, boardConflict: true })
  assert.equal(await board.context.openWorkspaceTarget({ kind: 'latex', id: 'destination' }), false)
  assert.equal(board.context.boardUI.isOpen(), true)
  assert.equal(board.calls.some(value => typeof value === 'string' && value.startsWith('latex:open')), false)
  assert.deepEqual(board.tables, [])
  assert.equal(await board.context.openWorkspaceRoot('paper'), false)
  assert.deepEqual(board.tables, [])
  const writer = fixture({ latexOpen: true, latexConflict: true })
  assert.equal(await writer.context.openWorkspaceTarget({ kind: 'board', id: 'destination' }), false)
  assert.equal(writer.context.latexUI.isOpen(), true)
  assert.equal(writer.calls.some(value => value?.boardOpen), false)
})

test('same-kind preferred selection stays in its writer and success requires the exact current ID', async () => {
  const latex = fixture({ latexOpen: true })
  assert.equal(await latex.context.openWorkspaceTarget({ kind: 'latex', id: 'next-draft' }), true)
  assert.deepEqual(latex.calls, ['latex:open:next-draft'])
  const board = fixture({ boardOpen: true })
  assert.equal(await board.context.openWorkspaceTarget({ kind: 'board', id: 'next-board' }), true)
  assert.deepEqual(board.calls, [{ boardOpen: { id: 'next-board' } }])
  for (const kind of ['board', 'latex', 'paper']) {
    const f = fixture({ wrongId: true })
    assert.equal(await f.context.openWorkspaceTarget({ kind, id: 'destination' }), false)
    assert.equal(f.context.workspaceNavigationTransition, false)
  }
  const failed = fixture({ latexOpen: true, openFailure: true })
  assert.equal(await failed.context.openWorkspaceTarget({ kind: 'latex', id: 'destination' }), false)
  assert.equal(failed.calls.includes('latex:close'), false)
})

test('reader preflight preserves ink sessions and refuses failed draft persistence before navigating', async () => {
  const saving = fixture({ annotationBusy: true })
  assert.equal(await saving.context.prepareWorkspaceNavigation(), false)
  assert.deepEqual(saving.calls, [])
  const unsaved = fixture({ dismissAnnotation: false })
  assert.equal(await unsaved.context.prepareWorkspaceNavigation(), false)
  assert.deepEqual(unsaved.calls, [])
  const ink = fixture({ inking: true })
  assert.equal(await ink.context.prepareWorkspaceNavigation(), false)
  assert.deepEqual(ink.calls, [])
  assert.match(ink.alerts[0], /笔迹/)
  const linked = fixture({ linked: true, finishInk: false })
  assert.equal(await linked.context.prepareWorkspaceNavigation(), false)
  assert.deepEqual(linked.calls, ['ink:finish'])
  const persistence = fixture({ saveFailure: true })
  await assert.rejects(persistence.context.prepareWorkspaceNavigation(), /conflict/)
  assert.deepEqual(persistence.calls, ['reader:publish', 'chat:save', 'state:flush'])
  assert.deepEqual(persistence.tables, [])
  const refused = fixture({ publish: false })
  assert.equal(await refused.context.prepareWorkspaceNavigation(), false)
  assert.deepEqual(refused.calls, ['reader:publish'])
})

test('reading projects open their exact membership scope and missing projects retain the source surface', async () => {
  const f = fixture({ boardOpen: true })
  assert.equal(await f.context.openWorkspaceTarget({ kind: 'project', id: 'reading-topic' }), true)
  assert.equal(f.state.project, 'reading-topic')
  assert.deepEqual(f.calls[0], { action: 'project_get', id: 'reading-topic' })
  assert.ok(f.calls.indexOf('board:close') < f.calls.indexOf('project:select:reading-topic'))
  assert.deepEqual(f.tables, [true])
  const missing = fixture({ boardOpen: true, api: () => ({ project: { id: 'another' } }) })
  await assert.rejects(missing.context.openWorkspaceTarget({ kind: 'project', id: 'missing' }))
  assert.equal(missing.calls.includes('board:close'), false)
})

test('context callbacks avoid feedback loops and blank writers keep their category without closing', () => {
  const same = fixture({ boardOpen: true, current: { kind: 'board', id: 'board-source', title: 'Source board' } })
  same.context.workspaceContextChanged({ kind: 'board', id: 'board-source', title: 'Source board' })
  assert.deepEqual(same.contexts, [])
  assert.deepEqual(same.tables, [])
  const writing = fixture({ latexOpen: true, emptyLatex: true })
  writing.context.workspaceContextChanged(null)
  assert.deepEqual(writing.contexts, [[null, { section: 'latex' }]])
  assert.equal(writing.area.parentNode, writing.writing)
  assert.equal(writing.calls.includes('latex:close'), false)
  const busy = fixture({ latexOpen: true }); busy.context.workspaceNavigationTransition = true
  busy.context.workspaceContextChanged({ kind: 'paper', id: 'old', title: 'Late old callback' })
  assert.deepEqual(busy.contexts, [])
  const normal = fixture({ boardOpen: true }); normal.context.workspaceContextChanged({ kind: 'board', id: 'board-source', title: 'Source board' })
  assert.deepEqual(normal.contexts, [[{ kind: 'board', id: 'board-source', title: 'Source board' }]])
  assert.deepEqual(normal.tables, [false])
  assert.deepEqual(normal.visible, ['library'])
})

test('project-scoped versions are cleared on focus changes and never fall back to an old reading project', async () => {
  const f = fixture({ current: { kind: 'paper', id: 'paper-source', title: 'Paper' } }), versions = f.elements.get('workspace-versions')
  versions.dataset.projectId = 'old-draft'; versions.open = true
  f.context.applyWorkspaceNavigation({ section: 'latex', current: { kind: 'latex', id: 'new-draft' } })
  assert.equal(versions.hidden, false)
  assert.equal(versions.open, false)
  assert.equal(versions.dataset.projectId, 'new-draft')
  assert.equal(f.calls.includes('versions:clear'), true)
  f.context.applyWorkspaceNavigation({ section: 'paper', current: { kind: 'paper', id: 'paper-source' } })
  assert.equal(versions.hidden, true)
  assert.equal(versions.dataset.projectId, '')
  const marker = source.indexOf('scope:()=>{const target=workspaceNavigationUI'), scopeText = balanced(marker + 'scope:'.length)
  const scope = vm.runInContext(`(${scopeText})`, f.context)
  assert.equal(scope(), null)
  f.context.workspaceNavigationUI.state = () => ({ current: { kind: 'latex', id: 'selected-draft' } })
  assert.deepEqual(plain(scope()), { id: 'selected-draft' })
  f.context.workspaceNavigationUI.state = () => ({ current: null })
  assert.equal(scope(), null)
})


test('visible writing owns context over delayed paper metadata and closing-surface notifications', () => {
  const f = fixture({ latexOpen: true })
  f.context.publishPaperWorkspace({ id: 'old-paper', title: 'Late metadata' })
  assert.deepEqual(f.contexts, [])
  f.context.workspaceContextChanged({ kind: 'paper', id: 'old-paper', title: 'Late metadata' })
  assert.deepEqual(f.contexts, [[{ kind: 'latex', id: 'latex-source', title: 'Source draft' }]])
  assert.equal(f.state.itemTicket, 1, 'entering writing invalidates the old paper request')
  assert.equal(f.state.pageTicket, 1)
  assert.equal(f.context.readerStateReady, false)
  const stale = fixture()
  stale.context.workspaceContextChanged({ kind: 'latex', id: 'closed-draft', title: 'Closed' })
  assert.deepEqual(stale.contexts, [], 'closed surfaces cannot claim active navigation')
  const canvas = fixture({ boardOpen: true })
  canvas.context.publishPaperWorkspace({ id: 'old-paper' })
  assert.deepEqual(canvas.contexts, [])
})

test('accepted root navigation cancels old paper reads while a refused surface close preserves them', async () => {
  const accepted = fixture()
  assert.equal(await accepted.context.openWorkspaceRoot('latex'), true)
  assert.equal(accepted.state.itemTicket, 1)
  assert.equal(accepted.state.pageTicket, 1)
  const blocked = fixture({ latexOpen: true, latexConflict: true })
  assert.equal(await blocked.context.openWorkspaceRoot('paper'), false)
  assert.equal(blocked.state.itemTicket, 0)
  assert.equal(blocked.state.pageTicket, 0)
})
