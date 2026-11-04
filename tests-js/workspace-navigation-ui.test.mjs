import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('../web/workspace-navigation.js', import.meta.url), 'utf8')
const plain = value => JSON.parse(JSON.stringify(value))
const wait = () => new Promise(resolve => setTimeout(resolve, 0))
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const item = (kind, id, title = id) => ({ kind, id, title })
const page = (items = [], extra = {}) => ({ items, offset: 0, limit: 20, total: items.length, known_total: items.length, has_more: false, truncated: false, ...extra })
const related = (focus, groups = {}, extra = {}) => ({ focus, groups: { paper: page(), board: page(), latex: page(), ...groups }, warnings: [], ...extra })
function fixture(options = {}) {
  const calls = [], changes = [], roots = [], warnings = [], navigated = []
  class Element {
    constructor(tag) { this.tagName = tag.toUpperCase(); this.ownerDocument = document; this.children = []; this.dataset = {}; this.attributes = {}; this.events = new Map(); this.hidden = false; this.disabled = false; this.value = ''; this.textContent = ''; this.style = { removeProperty(name) { delete this[name]; } }; this.classes = new Set(); this.classList = { add: value => this.classes.add(value), toggle: (value, on) => { if (on === undefined) on = !this.classes.has(value); if (on) this.classes.add(value); else this.classes.delete(value); return on }, contains: value => this.classes.has(value) } }
    set className(value) { this.classes = new Set(value.split(/\s+/).filter(Boolean)) } get className() { return [...this.classes].join(' ') }
    append(...nodes) { for (const node of nodes) { if (node.parentNode) node.parentNode.children = node.parentNode.children.filter(value => value !== node); node.parentNode = this; this.children.push(node) } }
    insertBefore(node, next) { this.append(node); this.children.pop(); this.children.splice(this.children.indexOf(next), 0, node) }
    replaceChildren(...nodes) { for (const node of this.children) node.parentNode = null; this.children = []; this.append(...nodes) }
    setAttribute(key, value) { this.attributes[key] = String(value) } getAttribute(key) { return this.attributes[key] ?? null } removeAttribute(key) { delete this.attributes[key] }
    addEventListener(name, fn) { if (!this.events.has(name)) this.events.set(name, new Set()); this.events.get(name).add(fn) } removeEventListener(name, fn) { this.events.get(name)?.delete(fn) }
    dispatch(name, properties = {}) { const event = { target: this, preventDefault() { this.defaultPrevented = true }, ...properties }; for (const listener of this.events.get(name) || []) listener(event); return event }
    click() { if (!this.disabled) this.dispatch('click') }
    focus() { document.activeElement = this }
    contains(node) { return node === this || this.children.some(child => child.contains(node)) }
  }
  const document = { createElement: tag => new Element(tag), events: new Map(), addEventListener: Element.prototype.addEventListener, removeEventListener: Element.prototype.removeEventListener, dispatch: Element.prototype.dispatch, dispatchEvent(event) { return this.dispatch(event.type, event) } }, root = new Element('div'), catalogRoot = new Element('div'), relatedRoot = new Element('div')
  const positions = [], window = { events: new Map(), addEventListener: Element.prototype.addEventListener, removeEventListener: Element.prototype.removeEventListener, dispatch: Element.prototype.dispatch, CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail } }, PaperFloatingWindows: { placeBelow(trigger, panel) { positions.push({ trigger, panel }); panel.style.position = 'fixed'; } } }
  const actionsHome = new Element('div'), actions = new Element('details'); actions.hidden = true; actionsHome.append(actions)
  const searchHome = new Element('div'), paperSearch = new Element('label'), paperInput = new Element('input'); paperInput.value = '原文献检索'; paperSearch.append(paperInput); searchHome.append(paperSearch);
  vm.runInNewContext(source, { window, document })
  const api = async (action, args) => { calls.push({ action, ...plain(args) }); return options.api ? options.api(action, args) : action === 'workspace_catalog' ? page([item(args.kind, 'synthetic-a')], { offset: args.offset }) : related({ kind: args.kind, id: args.id }) }
  const nav = window.PaperWorkspaceNavigation.create({ root, catalogRoot, relatedRoot, api, paperSearch, actions, onCreateProject: options.onCreateProject, onChange: value => changes.push(plain(value)), onRootChange: async value => { roots.push(value); return options.onRootChange?.(value) }, onNavigate: async value => { navigated.push(plain(value)); return options.onNavigate?.(value) }, prepare: options.prepare, toast: message => warnings.push(message) })
  const all = start => [start, ...start.children.flatMap(all)]
  const find = (className, start = root) => all(start).find(node => node.classes.has(className))
  const findAll = (className, start = root) => all(start).filter(node => node.classes.has(className))
  const text = start => all(start).map(node => node.textContent).filter(Boolean).join(' ')
  return { nav, document, window, positions, actions, actionsHome, paperSearch, paperInput, searchHome, root, catalogRoot, relatedRoot, calls, changes, roots, warnings, navigated, all, find, findAll, text }
}

test('four entrances are distinct and a refused root switch leaves the original view untouched', async () => {
  let allowed = false
  const f = fixture({ prepare: async () => allowed })
  assert.deepEqual(f.findAll('workspace-root-button').map(node => node.textContent), ['文献', '画板', 'LaTeX 写作', '阅读项目'])
  assert.equal(f.catalogRoot.hidden, true)
  assert.equal(f.relatedRoot.hidden, true)
  assert.equal(f.findAll('workspace-root-button')[0].getAttribute('aria-current'), 'page')
  assert.equal(await f.nav.selectRoot('board'), false)
  assert.equal(f.nav.state().section, 'paper')
  assert.equal(f.calls.length, 0)
  assert.equal(f.roots.length, 0)
  allowed = true
  assert.equal(await f.nav.selectRoot('board'), true)
  await wait()
  assert.equal(f.catalogRoot.hidden, false)
  assert.equal(f.relatedRoot.hidden, true)
  assert.deepEqual(f.calls[0], { action: 'workspace_catalog', kind: 'board', query: '', offset: 0, limit: 20 })
  assert.match(f.text(f.catalogRoot), /synthetic-a/)
})

test('catalog query and paging use bounded native requests and old responses cannot change another root', async () => {
  const old = deferred()
  const f = fixture({ api: async (action, args) => args.kind === 'board' && !args.query ? old.promise : page([item(args.kind, args.query || 'latex-item')], { offset: args.offset, total: 30, has_more: args.offset === 0 }) })
  await f.nav.selectRoot('board')
  await f.nav.selectRoot('latex')
  await wait()
  old.resolve(page([item('board', 'late-old-board')]))
  await wait()
  assert.equal(f.nav.state().section, 'latex')
  assert.doesNotMatch(f.text(f.catalogRoot), /late-old-board/)
  const search = f.all(f.find('workspace-catalog-search')).find(node => node.tagName === 'INPUT'), form = search.parentNode
  search.value = 'synthetic query'; form.dispatch('submit'); await wait()
  assert.equal(f.calls.at(-1).query, 'synthetic query')
  const next = f.findAll('workspace-nav-button', f.catalogRoot).find(node => node.textContent === '下一页 →')
  next.click(); await wait()
  assert.equal(f.calls.at(-1).offset, 20)
  assert.equal(f.calls.at(-1).limit, 20)
  assert.match(f.text(f.catalogRoot), /synthetic query/)
})

test('a catalog response preserves text typed into the search field while loading', async () => {
  const pending = deferred(), f = fixture({ api: () => pending.promise })
  await f.nav.selectRoot('board')
  const search = f.all(f.find('workspace-catalog-search')).find(node => node.tagName === 'INPUT')
  search.value = 'not submitted yet'; search.dispatch('input')
  pending.resolve(page([item('board', 'first-response')]))
  await wait()
  assert.equal(search.value, 'not submitted yet')
  assert.equal(f.calls[0].query, '')
  search.parentNode.dispatch('submit'); await wait()
  assert.equal(f.calls.at(-1).query, 'not submitted yet')
})

test('related children navigate reciprocally, preserve authoritative titles and trim repeated breadcrumb cycles', async () => {
  let nav
  const a = item('paper', 'paper-a', 'Paper A'), b = item('board', 'board-a', 'Board A'), c = item('latex', 'latex-a', 'Draft A')
  const f = fixture({ onNavigate: value => { nav.setCurrent({ ...value, title: `${value.title} loaded` }); return true }, api: async (_action, args) => related(item(args.kind, args.id), { board: page([b]), latex: page([c]), paper: page([a]) }) })
  nav = f.nav
  nav.setCurrent(a); await wait()
  assert.equal(f.catalogRoot.hidden, true)
  assert.equal(f.relatedRoot.hidden, true)
  assert.equal(f.calls.length, 0, 'current context alone does not read relation metadata')
  f.find('workspace-related-toggle').click(); await wait()
  assert.equal(f.relatedRoot.hidden, false)
  assert.equal(f.find('workspace-related', f.relatedRoot).open, true, 'related content is available only inside the requested popover')
  await nav.navigate(b); await wait()
  assert.equal(nav.state().current.title, 'Board A loaded')
  assert.deepEqual(plain(nav.state().trail).map(value => value.id), ['paper-a', 'board-a'])
  await nav.navigate(c); await wait()
  assert.deepEqual(plain(nav.state().trail).map(value => value.id), ['paper-a', 'board-a', 'latex-a'])
  await nav.navigate(a); await wait()
  assert.deepEqual(plain(nav.state().trail).map(value => value.id), ['paper-a'])
  assert.equal(f.find('workspace-current-title').getAttribute('aria-current'), 'page')
})

test('a failed item navigation preserves current selection and does not request another related graph', async () => {
  const f = fixture({ onNavigate: () => false })
  f.nav.setCurrent(item('paper', 'original')); await wait()
  const before = f.calls.length
  assert.equal(await f.nav.navigate(item('board', 'rejected')), false)
  assert.equal(f.nav.state().current.id, 'original')
  assert.equal(f.calls.length, before)
  assert.equal(f.findAll('workspace-root-button').every(node => !node.disabled), true)
})

test('external context changes isolate late related reads and repeated contexts do not refetch', async () => {
  const old = deferred()
  const f = fixture({ api: async (_action, args) => args.id === 'first' ? old.promise : related(item(args.kind, args.id), { board: page([item('board', 'current-child')]) }) })
  f.nav.setCurrent(item('paper', 'first')); f.find('workspace-related-toggle').click(); f.nav.setCurrent(item('paper', 'second')); f.find('workspace-related-toggle').click(); await wait()
  old.resolve(related(item('paper', 'first'), { board: page([item('board', 'old-child')]) })); await wait()
  assert.match(f.text(f.relatedRoot), /current-child/)
  assert.doesNotMatch(f.text(f.relatedRoot), /old-child/)
  const before = f.calls.length; f.nav.setCurrent(item('paper', 'second')); await wait(); assert.equal(f.calls.length, before)
  f.nav.setCurrent(null, { section: 'latex' })
  assert.equal(f.nav.state().current, null)
  assert.equal(f.nav.state().section, 'latex')
  assert.equal(f.relatedRoot.hidden, true)
})

test('writing settings can host the original path, relations and versions controls', async () => {
  const f = fixture()
  const nav = f.find('workspace-navigation'), actions = f.find('workspace-nav-actions')
  const settings = f.document.createElement('div')
  f.nav.setCurrent(item('latex', 'draft'))
  f.actions.hidden = false
  const related = f.find('workspace-related-toggle')
  related.click(); await wait()
  assert.equal(f.relatedRoot.hidden, false)
  f.nav.mountActions(settings)
  assert.equal(f.find('workspace-nav-actions'), undefined)
  assert.equal(actions.parentNode, settings)
  assert.equal(f.actions.parentNode, actions)
  assert.equal(f.relatedRoot.hidden, true, 'moving the controls dismisses a popup anchored to their old position')
  related.click(); await wait()
  assert.equal(f.relatedRoot.hidden, false)
  f.nav.mountActions()
  assert.equal(f.relatedRoot.hidden, true)
  assert.equal(actions.parentNode, nav)
})

test('group pagination changes only its requested group and partial counts stay explicitly lower bounds', async () => {
  const focus = item('paper', 'a')
  const f = fixture({ api: async (_action, args) => related(focus, {
    board: page([item('board', args.offset ? 'board-next' : 'board-first')], { offset: args.offset, total: null, known_total: 25, has_more: !args.offset, truncated: true }),
    latex: page([item('latex', args.group_kind ? 'not-the-requested-group' : 'keep-this-draft')]),
  }, { truncated: true, warnings: ['目录仍有未读取的部分。'] }) })
  f.nav.setCurrent(focus); f.find('workspace-related-toggle').click(); await wait()
  assert.match(f.text(f.relatedRoot), /至少 25/)
  const next = f.findAll('workspace-nav-button', f.relatedRoot).find(node => node.textContent === '下一页 →' && !node.disabled)
  next.click(); await wait()
  assert.equal(f.calls.at(-1).group_kind, 'board')
  assert.equal(f.calls.at(-1).offset, 20)
  assert.match(f.text(f.relatedRoot), /board-next/)
  assert.match(f.text(f.relatedRoot), /keep-this-draft/)
  assert.doesNotMatch(f.text(f.relatedRoot), /not-the-requested-group/)
})

test('missing children remain visible but unavailable and source text stays inert', async () => {
  const label = '<script>synthetic()</script>'
  const f = fixture({ api: async (_action, args) => related(item(args.kind, args.id), { board: page([{ ...item('board', 'missing-board', label), missing: true, relation: '显式关联', via: { title: '<b>project</b>' } }]) }) })
  f.nav.setCurrent(item('paper', 'p')); f.find('workspace-related-toggle').click(); await wait()
  const open = f.findAll('workspace-object-open', f.relatedRoot)[0]
  assert.equal(open.disabled, true)
  assert.equal(open.textContent, label)
  assert.match(f.text(f.relatedRoot), /原内容已不可用/)
  assert.equal(f.all(f.relatedRoot).some(node => ['SCRIPT', 'B'].includes(node.tagName)), false)
  open.click(); await wait(); assert.equal(f.navigated.length, 0)
})

test('a reading-project relation describes its existing via title once', async () => {
  const f = fixture({ api: async (_action, args) => related(item(args.kind, args.id), { latex: page([{ ...item('latex', 'draft'), relation: '通过阅读项目：合成主题', via: { title: '合成主题' } }]) }) })
  f.nav.setCurrent(item('paper', 'p')); f.find('workspace-related-toggle').click(); await wait()
  const copy = f.find('workspace-object-relation', f.relatedRoot).textContent
  assert.equal(copy, '通过阅读项目：合成主题')
})

test('failed refresh preserves the current children and malformed categories never replace them', async () => {
  let fail = false
  const f = fixture({ api: async (_action, args) => { if (fail) return related(item(args.kind, args.id), { board: page([item('latex', 'wrong-category')]) }); return related(item(args.kind, args.id), { board: page([item('board', 'retained')]) }) } })
  f.nav.setCurrent(item('paper', 'p')); f.find('workspace-related-toggle').click(); await wait(); fail = true
  assert.equal(await f.nav.refresh(), false)
  assert.match(f.text(f.relatedRoot), /retained/)
  assert.match(f.text(f.relatedRoot), /已有列表保留/)
  assert.doesNotMatch(f.text(f.relatedRoot), /wrong-category/)
})

test('breadcrumb history is bounded and disposing suppresses all pending results', async () => {
  const f = fixture()
  for (let index = 0; index < 12; index++) await f.nav.navigate(item(index % 2 ? 'board' : 'paper', `synthetic-${index}`))
  assert.equal(f.nav.state().trail.length, 8)
  const pending = deferred(), g = fixture({ api: () => pending.promise })
  g.nav.setCurrent(item('paper', 'p')); g.find('workspace-related-toggle').click(); g.nav.dispose()
  pending.resolve(related(item('paper', 'p'), { board: page([item('board', 'late')]) })); await wait()
  assert.equal(g.root.children.length, 0)
  assert.equal(g.catalogRoot.children.length, 0)
  assert.equal(g.relatedRoot.children.length, 0)
  assert.equal(await g.nav.navigate(item('board', 'no-after-dispose')), false)
})


test('navigation reuses the original paper search and preserves its state across category changes', async () => {
  const f = fixture(), originalInput=f.paperInput
  let inputs=0; originalInput.addEventListener('input',()=>inputs++)
  assert.equal(f.paperSearch.parentNode,f.find('workspace-nav-search'))
  assert.equal(f.paperSearch.hidden,false); assert.equal(f.find('workspace-catalog-search').hidden,true)
  await f.nav.selectRoot('board'); await wait()
  assert.equal(f.paperSearch.hidden,true); assert.equal(f.find('workspace-catalog-search').hidden,false)
  assert.equal(f.find('workspace-catalog-search').parentNode,f.find('workspace-nav-search'))
  assert.equal(f.all(f.catalogRoot).some(node=>node.tagName==='INPUT'),false)
  await f.nav.selectRoot('paper'); await wait()
  assert.equal(f.paperSearch.hidden,false); assert.equal(f.paperInput,originalInput); assert.equal(f.paperInput.value,'原文献检索')
  f.paperInput.dispatch('input'); assert.equal(inputs,1)
  f.nav.setCurrent(item('paper','p')); await wait(); assert.equal(f.paperSearch.hidden,false)
  f.nav.dispose(); assert.equal(f.paperSearch.parentNode,f.searchHome); assert.equal(f.paperSearch.hidden,false)
})

test('reading projects have their own list, native create action and expanded linked content', async () => {
  let created=0
  const f=fixture({onCreateProject:()=>created++,api: async(action,args)=>action==='workspace_catalog'?page([{...item('project','reading','合成阅读项目'),paper_count:2,description:'学习方法练习'}]):related(item('project','reading'),{paper:page([item('paper','member')]),board:page([item('board','b')]),latex:page([item('latex','l')])})})
  assert.equal(await f.nav.selectRoot('project'),true); await wait()
  assert.deepEqual(f.calls[0],{action:'workspace_catalog',kind:'project',query:'',offset:0,limit:20})
  assert.match(f.text(f.catalogRoot),/2 篇文献/); assert.match(f.text(f.catalogRoot),/LaTeX 写作是单独的写作项目/)
  const create=f.findAll('workspace-nav-button',f.catalogRoot).find(node=>node.textContent==='新建阅读项目'); assert.equal(create.hidden,false); create.click(); assert.equal(created,1)
  await f.nav.navigate(item('project','reading','合成阅读项目')); await wait()
  assert.equal(f.nav.state().section,'project'); assert.equal(f.catalogRoot.hidden,true)
  assert.equal(f.find('workspace-related',f.relatedRoot).open,true)
  assert.match(f.text(f.relatedRoot),/项目内容/); assert.match(f.text(f.relatedRoot),/member/); assert.match(f.text(f.relatedRoot),/LaTeX 写作/)
  assert.equal(f.find('workspace-nav-search').hidden,true)
})

test('paths and relations open on demand without adding permanent rows or reading unopened metadata', async () => {
  const f = fixture()
  f.nav.setCurrent(item('latex', 'draft', 'A long project title'))
  await wait()
  assert.equal(f.calls.length, 0)
  assert.equal(f.relatedRoot.hidden, true)
  assert.equal(f.find('workspace-path-popup').hidden, true)
  assert.equal(f.find('workspace-breadcrumbs').parentNode, f.find('workspace-path-popup'))
  assert.equal(f.actions.parentNode, f.find('workspace-nav-actions'))
  f.find('workspace-path-toggle').click()
  assert.equal(f.find('workspace-path-popup').hidden, false)
  assert.equal(f.find('workspace-path-toggle').getAttribute('aria-expanded'), 'true')
  assert.equal(f.calls.length, 0, 'opening a saved navigation path needs no metadata read')
  assert.equal(f.positions.at(-1).trigger, f.find('workspace-path-toggle'))
  f.find('workspace-related-toggle').click(); await wait()
  assert.equal(f.find('workspace-path-popup').hidden, true)
  assert.equal(f.relatedRoot.hidden, false)
  assert.equal(f.calls.filter(call => call.action === 'workspace_related').length, 1)
  f.nav.closePopovers()
  f.find('workspace-related-toggle').click(); await wait()
  assert.equal(f.calls.filter(call => call.action === 'workspace_related').length, 1, 'reopening keeps the bounded relation page')
  f.nav.dispose()
  assert.equal(f.actions.parentNode, f.actionsHome)
})

test('popover close controls, outside clicks, Escape and another workspace action preserve content and restore focus', async () => {
  const f = fixture()
  f.nav.setCurrent(item('paper', 'p'))
  f.find('workspace-related-toggle').click(); await wait()
  const before = f.calls.length
  f.document.dispatch('click', { target: f.find('workspace-related-body', f.relatedRoot) })
  assert.equal(f.relatedRoot.hidden, false, 'a click inside the requested panel must not dismiss it')
  f.document.dispatch('click', { target: f.paperInput })
  assert.equal(f.relatedRoot.hidden, true)
  f.find('workspace-related-toggle').click()
  const event = f.document.dispatch('keydown', { key: 'Escape' })
  assert.equal(event.defaultPrevented, true)
  assert.equal(f.document.activeElement, f.find('workspace-related-toggle'))
  assert.equal(f.relatedRoot.hidden, true)
  f.find('workspace-path-toggle').click()
  f.document.dispatchEvent(new f.window.CustomEvent('paper-library:workspace-popup', { detail: { id: 'workspace-version-popup' } }))
  assert.equal(f.find('workspace-path-popup').hidden, true)
  f.find('workspace-path-toggle').click()
  f.find('workspace-popup-close', f.find('workspace-path-popup')).click()
  assert.equal(f.document.activeElement, f.find('workspace-path-toggle'))
  assert.equal(f.find('workspace-path-popup').hidden, true)
  assert.equal(f.calls.length, before, 'dismissing information never navigates, reloads or loses its current page')
})

test('a relation popup closes on context changes while a selected reading project keeps its primary list', async () => {
  const f = fixture()
  f.nav.setCurrent(item('board', 'b')); f.find('workspace-related-toggle').click(); await wait()
  assert.equal(f.relatedRoot.style.position, 'fixed')
  f.nav.setCurrent(item('project', 'topic')); await wait()
  assert.equal(f.relatedRoot.hidden, false)
  assert.equal(f.relatedRoot.style.position, undefined)
  assert.equal(f.find('workspace-related-toggle').hidden, true)
  assert.equal(f.relatedRoot.classes.has('workspace-popup'), false)
  assert.equal(f.nav.state().current.id, 'topic')
  f.find('workspace-path-toggle').click()
  f.nav.closePopovers()
  assert.equal(f.relatedRoot.hidden, false, 'closing the path does not hide project membership content')
})
