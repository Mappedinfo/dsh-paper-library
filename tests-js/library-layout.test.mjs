import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFile } from 'node:fs/promises'

const html = await readFile(new URL('../web/index.html', import.meta.url), 'utf8')
const shell = await readFile(new URL('../web/reading-shell.js', import.meta.url), 'utf8')
const settings = await readFile(new URL('../web/settings.js', import.meta.url), 'utf8')

test('library organizer keeps one control for each existing action and describes LaTeX snapshots', () => {
  for (const id of ['project-select', 'project-new', 'project-edit', 'project-archive', 'board-shelf', 'latex-version-shelf', 'board-shelf-list', 'library-latex-versions', 'export-library', 'build-bibliography']) {
    assert.equal([...html.matchAll(new RegExp(`id="${id}"`, 'g'))].length, 1, id)
  }
  assert.match(html, /aria-controls="board-shelf-panel"/)
  assert.match(html, /aria-controls="latex-version-shelf-panel"/)
  assert.match(html, /每次成功手动编译保存源码、PDF 和自审快照/)
  assert.match(html, /生成 references\.bib/)
  assert.match(html, /检索文献、数据集与演示文稿/)
})

test('shelf toggles expose separate full-width panels using the original details nodes', () => {
  const source = shell.slice(shell.indexOf('    const organizerDisclosures='), shell.indexOf('    $(\'quick-import-form\')'))
  assert.ok(source.includes('.filter(Boolean)'))
  const ids = new Map()
  for (const id of ['board-shelf', 'latex-version-shelf', 'board-shelf-panel', 'latex-version-shelf-panel']) {
    ids.set(id, { open: false, hidden: false, events: {}, addEventListener(name, fn) { this.events[name] = fn } })
  }
  vm.runInNewContext(source, { $: id => ids.get(id) })
  assert.equal(ids.get('board-shelf-panel').hidden, true)
  const board = ids.get('board-shelf'); board.open = true; board.events.toggle()
  assert.equal(ids.get('board-shelf-panel').hidden, false)
  assert.equal(ids.get('latex-version-shelf-panel').hidden, true)
  const version = ids.get('latex-version-shelf'); version.open = true; version.events.toggle()
  board.open = false; board.events.toggle()
  assert.equal(ids.get('board-shelf-panel').hidden, true)
  assert.equal(ids.get('latex-version-shelf-panel').hidden, false)
})

test('settings moves the original export control and retains its click handler', () => {
  const ids = new Map()
  class Element {
    constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.events = {}; this.classList = { toggle() {} }; this.open = false; this.value = '' }
    set id(value) { this._id = value; ids.set(value, this) } get id() { return this._id }
    append(...nodes) { for (const n of nodes) { if (n.parentElement) n.parentElement.children = n.parentElement.children.filter(x => x !== n); n.parentElement = this; this.children.push(n) } }
    setAttribute(name, value) { this[name] = value }
    addEventListener(name, fn) { this.events[name] = fn }
    removeEventListener() {}
    showModal() { this.open = true } close() { this.open = false }
  }
  const bar = new Element('div'), oldParent = new Element('div'), body = new Element('body')
  const exportButton = new Element('button'); exportButton.id = 'export-library'; oldParent.append(exportButton)
  let clicks = 0; exportButton.addEventListener('click', () => clicks++)
  const document = { body, createElement: tag => new Element(tag), getElementById: id => ids.get(id), querySelector: () => bar, addEventListener() {}, removeEventListener() {} }
  const window = { parent: null, location: { origin: 'http://local' }, addEventListener() {}, removeEventListener() {} }; window.parent = window
  vm.runInNewContext(settings, { window, document, setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask })
  const ui = window.PaperLibrarySettings.create({ api: async () => ({}), getLibrary: () => '' })
  assert.equal(oldParent.children.length, 0)
  assert.equal(exportButton.parentElement.className, 'settings-maintenance')
  exportButton.events.click(); assert.equal(clicks, 1)
  ui.dispose()
})

test('handwriting status stays expandable and marks pending and failed records', () => {
  const source = shell.slice(shell.indexOf('    function queueChanged(records){'), shell.indexOf('    const backPosition='))
  const summary = { textContent: '', classList: { toggle() {} } }, menu = { hidden: false, dataset: {} }
  const panel = { replaceChildren() {}, append() {} }
  const node = () => ({ dataset: {}, setAttribute() {}, append() {} })
  const context = { queueSummary: summary, queueMenu: menu, queuePanel: panel, inkRecords: [], syncInk() {}, node, button: () => ({}), window: { PaperInkQueueClient: { label: value => value } } }
  vm.runInNewContext(`${source}; this.change = queueChanged`, context)
  context.change([{ paperId: 'synthetic', page: 1, status: 'saved' }]); assert.equal(menu.dataset.state, 'saved'); assert.equal(summary.textContent, '笔迹已保存')
  context.change([{ paperId: 'synthetic', page: 1, status: 'writing' }]); assert.equal(menu.dataset.state, 'pending')
  context.change([{ paperId: 'synthetic', page: 1, status: 'uncertain' }]); assert.equal(menu.dataset.state, 'error')
})
