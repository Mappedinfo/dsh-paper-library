/** 以现有明确关联组织文献、画板与写作项目；只投影元数据，不创建层级或扫描源码。 */
const KINDS = new Set(['paper', 'board', 'latex'])
export const WORKSPACE_NAV_LIMITS = Object.freeze({ page: 20, boardScan: 50, latexScan: 200, projects: 10, projectPapers: 40, concurrency: 4 })
const fail = message => Object.assign(new Error(message), { code: 'WORKSPACE_NAV_INVALID', status: 400 })
const name = value => typeof value === 'string' && value.trim() ? value.slice(0, 500) : ''
const identifier = value => {
  if (typeof value !== 'string' || !value.trim() || value.length > 200 || /[\x00-\x1f]/.test(value)) throw fail('内容标识为空或格式无效。')
  return value
}
const record = (kind, item, extra = {}) => ({ kind, id: item.id, title: name(item.title) || item.id, ...extra })
const allGroups = () => Object.fromEntries([...KINDS].map(kind => [kind, new Map()]))
const titleOrder = (a, b) => a.title.localeCompare(b.title, 'zh-CN') || a.id.localeCompare(b.id)
const paperBindings = board => {
  const found = new Map((board.links?.papers || []).map(id => [id, { id, relation: '明确关联文献' }]))
  for (const node of board.nodes || []) if (node.kind === 'paper' && typeof node.paper?.id === 'string' && !found.has(node.paper.id)) {
    found.set(node.paper.id, { id: node.paper.id, title: name(node.paper.title), relation: '画板中的文献节点' })
  }
  return found
}
async function boundedMap(items, run, signal) {
  const result = new Array(items.length)
  let cursor = 0
  await Promise.all(Array.from({ length: Math.min(WORKSPACE_NAV_LIMITS.concurrency, items.length) }, async () => {
    while (cursor < items.length) { signal?.throwIfAborted(); const index = cursor++; result[index] = await run(items[index], index) }
  }))
  return result
}
function inputPage(input) {
  const offset = input.offset ?? 0, limit = input.limit ?? WORKSPACE_NAV_LIMITS.page
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100000 || !Number.isSafeInteger(limit) || limit < 1 || limit > WORKSPACE_NAV_LIMITS.page) throw fail('分页要求 offset 0–100000、limit 1–20。')
  return { offset, limit }
}
function slice(items, { offset, limit }, incomplete = false) {
  return { items: items.slice(offset, offset + limit), total: incomplete ? null : items.length, known_total: items.length, offset, limit, has_more: offset + limit < items.length, truncated: incomplete }
}

export function createWorkspaceNavigation({ boards, request } = {}) {
  if (!boards?.list || !boards?.read || typeof request !== 'function') throw fail('工作区导航需要画板与目录元数据接口。')
  async function catalog(input, { signal } = {}) {
    const kind = input.kind, page = inputPage(input)
    if (!['board', 'latex'].includes(kind)) throw fail('内容目录只接受 board 或 latex。')
    const query = input.query ?? ''
    if (typeof query !== 'string' || query.length > 200) throw fail('检索词最多 200 个字符。')
    signal?.throwIfAborted()
    if (kind === 'latex') {
      const listed = await request({ action: 'latex_project_list', query, include_archived: false, ...page }, signal)
      const items = (listed.projects || []).map(item => record(kind, item, { reading_project_id: item.reading_project_id || null, missing: item.exists === false, main_path: name(item.main_path) || null }))
      return { kind, items, total: listed.total ?? null, known_total: listed.total ?? page.offset + items.length, ...page, has_more: Number.isSafeInteger(listed.total) ? page.offset + items.length < listed.total : listed.truncated === true, truncated: false, warnings: [] }
    }
    const listed = await boards.list(), q = query.trim().toLocaleLowerCase()
    const items = (listed.boards || []).filter(item => !q || `${item.title || ''} ${item.id}`.toLocaleLowerCase().includes(q)).map(item => record(kind, item, { node_count: item.node_count ?? null, edge_count: item.edge_count ?? null, linked_papers: item.linked_papers ?? null }))
    const partial = listed.truncated === true
    return { kind, ...slice(items, page, partial), warnings: partial ? ['画板目录超过当前 50 条读取窗口；此页不是完整目录。'] : [] }
  }

  async function related(input, { signal } = {}) {
    const kind = input.kind, id = identifier(input.id), page = inputPage(input)
    if (!KINDS.has(kind) || input.group_kind !== undefined && !KINDS.has(input.group_kind)) throw fail('内容类别必须为 paper、board 或 latex。')
    const groups = allGroups(), warnings = [], incomplete = { paper: false, board: false, latex: false }
    const add = (type, item) => { if (!(type === kind && item.id === id) && !groups[type].has(item.id)) groups[type].set(item.id, item) }
    const warn = message => { if (!warnings.includes(message)) warnings.push(message) }
    const attempt = async (label, run, affected) => {
      signal?.throwIfAborted()
      try { return await run() }
      catch (error) { signal?.throwIfAborted(); for (const type of affected) incomplete[type] = true; warn(`${label}暂不可用，相关内容尚未完整读取。`); return null }
    }
    const call = payload => { signal?.throwIfAborted(); return request(payload, signal) }
    const loadLatex = () => attempt('写作项目目录', () => call({ action: 'latex_project_list', include_archived: false, limit: WORKSPACE_NAV_LIMITS.latexScan, offset: 0 }), ['latex'])
    const loadBoards = async () => {
      if (kind === 'board') return []
      const listing = await attempt('画板目录', () => boards.list(), ['board'])
      if (!listing) return []
      if (listing.truncated) { incomplete.board = true; warn('画板关系仅覆盖当前 50 条目录窗口。') }
      return (await boundedMap((listing.boards || []).slice(0, WORKSPACE_NAV_LIMITS.boardScan), item => attempt('部分画板资料', () => boards.read(item.id), ['board']), signal)).filter(Boolean).map(value => value.board)
    }
    let focus, currentBoard, memberships = []
    if (kind === 'paper') {
      const [paper, member] = await Promise.all([
        attempt('当前文献资料', () => call({ action: 'get', id }), ['board', 'latex']),
        attempt('文献所属阅读项目', () => call({ action: 'project_for_paper', paper_id: id }), ['board', 'latex']),
      ])
      focus = record(kind, paper || { id }, paper ? {} : { missing: true })
      memberships = member?.projects || []
    } else if (kind === 'board') {
      const got = await attempt('当前画板资料', () => boards.read(id), ['paper', 'latex'])
      currentBoard = got?.board
      focus = record(kind, currentBoard || { id }, currentBoard ? {} : { missing: true })
    }
    const [latexResult, boardRecords] = await Promise.all([loadLatex(), loadBoards()])
    const latexProjects = latexResult?.projects || []
    if (latexResult && (latexResult.total > latexProjects.length || latexResult.truncated)) { incomplete.latex = true; warn('写作项目关系只覆盖当前 200 条目录窗口。') }
    let currentLatex
    if (kind === 'latex') {
      currentLatex = latexProjects.find(item => item.id === id)
      focus = record(kind, currentLatex || { id }, !currentLatex || currentLatex.exists === false ? { missing: true } : {})
      if (!currentLatex) { incomplete.paper = true; incomplete.board = true; warn('当前写作项目未在可读目录中找到，无法判断其关联内容。') }
    }
    if (kind === 'paper') {
      const memberIds = new Map(memberships.map(item => [item.id, item]))
      for (const board of boardRecords) {
        const binding = paperBindings(board).get(id), via = (board.links?.projects || []).find(value => memberIds.has(value))
        if (binding) add('board', record('board', board, { relation: binding.relation }))
        else if (via) add('board', record('board', board, { relation: `通过阅读项目：${name(memberIds.get(via).title) || via}`, via: { kind: 'project', id: via, title: name(memberIds.get(via).title) || via } }))
      }
      for (const project of latexProjects) if (memberIds.has(project.reading_project_id)) {
        const via = memberIds.get(project.reading_project_id)
        add('latex', record('latex', project, { relation: `通过阅读项目：${name(via.title) || via.id}`, via: { kind: 'project', id: via.id, title: name(via.title) || via.id }, missing: project.exists === false }))
      }
    } else {
      const projectIds = kind === 'board' ? currentBoard?.links?.projects || [] : currentLatex?.reading_project_id ? [currentLatex.reading_project_id] : []
      if (projectIds.length > WORKSPACE_NAV_LIMITS.projects) { incomplete.paper = true; warn('本次最多展开 10 个明确关联的阅读项目。') }
      const metadata = projectIds.length ? await attempt('关联阅读项目', () => call({ action: 'project_list', include_archived: false, limit: 200, offset: 0 }), ['paper']) : null
      const projectPages = await boundedMap(projectIds.slice(0, WORKSPACE_NAV_LIMITS.projects), async projectId => {
        const project = metadata?.projects?.find(item => item.id === projectId)
        if (!project) { incomplete.paper = true; warn('部分关联阅读项目已移除、归档或不在当前目录窗口中。'); return null }
        const papers = await attempt('阅读项目文献', () => call({ action: 'resource_list', kind: 'paper', project: projectId, limit: WORKSPACE_NAV_LIMITS.projectPapers, offset: 0 }), ['paper'])
        if (!papers) return null
        if (papers.total > (papers.items || []).length || papers.truncated) { incomplete.paper = true; warn('每个关联阅读项目仅展开前 40 篇文献。') }
        return { project, papers: papers.items || [] }
      }, signal)
      const projectMeta = new Map(projectPages.filter(Boolean).map(value => [value.project.id, value.project]))
      const direct = kind === 'board' && currentBoard ? paperBindings(currentBoard) : new Map()
      for (const value of direct.values()) add('paper', record('paper', value, { relation: value.relation, _resolve: true }))
      for (const page of projectPages.filter(Boolean)) for (const paper of page.papers) if (paper.resource_kind === undefined || paper.resource_kind === 'paper') {
        add('paper', record('paper', paper, { relation: `通过阅读项目：${name(page.project.title) || page.project.id}`, via: { kind: 'project', id: page.project.id, title: name(page.project.title) || page.project.id } }))
      }
      if (kind === 'board') for (const project of latexProjects) if (projectIds.includes(project.reading_project_id)) {
        const via = projectMeta.get(project.reading_project_id), title = name(via?.title) || project.reading_project_id
        add('latex', record('latex', project, { relation: `通过阅读项目：${title}`, via: { kind: 'project', id: project.reading_project_id, title }, missing: project.exists === false }))
      }
      if (kind === 'latex' && currentLatex?.reading_project_id) for (const board of boardRecords) if (board.links?.projects?.includes(currentLatex.reading_project_id)) {
        const via = projectMeta.get(currentLatex.reading_project_id), title = name(via?.title) || currentLatex.reading_project_id
        add('board', record('board', board, { relation: `通过阅读项目：${title}`, via: { kind: 'project', id: currentLatex.reading_project_id, title } }))
      }
    }
    const pages = Object.fromEntries([...KINDS].map(type => [type, slice([...groups[type].values()].sort(titleOrder), { ...page, offset: input.group_kind && input.group_kind !== type ? 0 : page.offset }, incomplete[type])]))
    // 只有当前页直接关联的文献才读取元资料，避免按画板节点数产生全库请求。
    pages.paper.items = await boundedMap(pages.paper.items, async item => {
      const { _resolve, ...visible } = item
      if (!_resolve) return visible
      const got = await attempt('部分关联文献', () => call({ action: 'get', id: item.id }), ['paper'])
      return got ? { ...visible, title: name(got.title) || visible.title } : { ...visible, missing: true }
    }, signal)
    if (incomplete.paper) { pages.paper.truncated = true; pages.paper.total = null }
    return { focus, groups: pages, warnings, truncated: Object.values(incomplete).some(Boolean) }
  }
  return { async handle(input, options = {}) {
    if (input?.action === 'workspace_catalog') return catalog(input, options)
    if (input?.action === 'workspace_related') return related(input, options)
    throw fail('不支持的工作区导航操作。')
  } }
}
