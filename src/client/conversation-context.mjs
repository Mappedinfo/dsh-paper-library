import { annotationReferenceInsert, parseAnnotationReference } from './annotation-references.mjs'
import { boardReferenceInsert, boardReferenceToken } from './board-references.mjs'

const VERSION = 1
const ACTION = 'paper-library:conversation-action'
const RESULT = 'paper-library:conversation-result'
const SNAPSHOT_LIMIT = 256 * 1024
const TEXT_LIMIT = 64 * 1024
const NAVIGATION_TIMEOUT = 8000

function boundedString(value, limit, optional = false) {
  if (optional && value === undefined) return undefined
  if (typeof value !== 'string' || value.length > limit) throw new Error('阅读状态中的文本格式或长度不受支持')
  return value
}

function pageNumber(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 2000) throw new Error('阅读状态中的页码无效')
  return value
}

/** Keep only reader-owned text and coordinates; rendered PDF pages never enter this cache. */
export function readerSnapshot(value) {
  if (!value || typeof value !== 'object') throw new Error('阅读状态无效')
  const snapshot = {
    paperId: value.paperId === null ? null : boundedString(value.paperId, 200),
    page: pageNumber(value.page),
    tab: ['reader', 'annotations', 'conversation', 'graph'].includes(value.tab) ? value.tab : 'reader',
    chatDraft: boundedString(value.chatDraft ?? '', TEXT_LIMIT),
  }
  if (value.panels != null) {
    const panels = value.panels
    if (!panels || typeof panels !== 'object' || !['left', 'right'].includes(panels.side)) throw new Error('阅读侧栏位置无效')
    snapshot.panels = {side: panels.side, annotations: panels.annotations === true, metadata: panels.metadata === true, chat: panels.chat === true}
  }
  if (value.readerSelection != null) {
    const selection=value.readerSelection
    if (!Array.isArray(selection.rects) || selection.rects.length > 200) throw new Error('阅读选区过大')
    const rects=selection.rects.map(rect=>{
      if(!Array.isArray(rect)||rect.length!==4||rect.some(number=>!Number.isFinite(number)))throw new Error('阅读选区坐标无效')
      return [...rect]
    })
    snapshot.readerSelection={page:pageNumber(selection.page),text:boundedString(selection.text,20000),rects}
  }
  if (value.chatContext != null) {
    const context = value.chatContext
    if (context.annotationRefs !== undefined) {
      if (!Array.isArray(context.annotationRefs) || context.annotationRefs.length > 1000) throw new Error('对话引用最多保留 1000 条批注')
      snapshot.chatContext = { annotationRefs: context.annotationRefs.map(ref => {
        if (!ref || !/^[a-f0-9]{64}$/.test(ref.version)) throw new Error('批注引用版本无效')
        return { id: boundedString(ref.id, 160), version: ref.version }
      }) }
    } else {
      // Previous installed readers can still restore their IDs until they refresh.
      if (!Array.isArray(context.annotationIds) || context.annotationIds.length > 1000) throw new Error('对话引用最多保留 1000 条批注')
      snapshot.chatContext = { annotationIds: context.annotationIds.map(id => boundedString(id, 160)) }
    }
    if (context.selection != null) snapshot.chatContext.selection = {
      page: pageNumber(context.selection.page),
      text: boundedString(context.selection.text, 8000),
    }
  }
  if (value.annotationDraft != null) {
    const draft = value.annotationDraft
    if (!['note', 'highlight', 'underline', 'strikeout', 'edit'].includes(draft.mode)) throw new Error('批注草稿类型无效')
    snapshot.annotationDraft = {
      mode: draft.mode,
      id: boundedString(draft.id, 200),
      page: pageNumber(draft.page),
      comment: boundedString(draft.comment ?? '', TEXT_LIMIT),
    }
    if (draft.color !== undefined) {
      if (typeof draft.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(draft.color)) throw new Error('批注草稿颜色无效')
      snapshot.annotationDraft.color = draft.color
    }
    if (draft.quote !== undefined) snapshot.annotationDraft.quote = boundedString(draft.quote, TEXT_LIMIT)
    if (draft.note) {
      const note = { id: boundedString(draft.note.id, 200), page: pageNumber(draft.note.page) }
      for (const key of ['text', 'comment', 'content']) {
        const text = boundedString(draft.note[key], TEXT_LIMIT, true)
        if (text !== undefined) note[key] = text
      }
      snapshot.annotationDraft.note = note
    }
    if (draft.selection) {
      const selection = draft.selection
      if (!Array.isArray(selection.rects) || selection.rects.length > 256) throw new Error('批注选区过大')
      const rects = selection.rects.map(rect => {
        if (!Array.isArray(rect) || rect.length !== 4 || rect.some(number => !Number.isFinite(number))) throw new Error('批注选区坐标无效')
        return [...rect]
      })
      snapshot.annotationDraft.selection = { page: pageNumber(selection.page), text: boundedString(selection.text, TEXT_LIMIT), rects }
    }
  }
  if (new TextEncoder().encode(JSON.stringify(snapshot)).length > SNAPSHOT_LIMIT) throw new Error('阅读草稿超过 256 KiB，无法暂存')
  return snapshot
}

/** Append through Harness's public span edit so existing reference chips and attachments survive. */
export function appendConversationDraft(ctx, sessionId, text, reference, toInsert = annotationReferenceInsert) {
  if (typeof text !== 'string' || !text.trim() || text.length > TEXT_LIMIT) throw new Error('批注文本为空或超过 65,536 个字符')
  const insert = reference === undefined ? undefined : toInsert(reference)
  const referenceOffset = insert ? text.indexOf(insert.ref) : -1
  if (insert && (referenceOffset < 0 || text.indexOf(insert.ref, referenceOffset + insert.ref.length) !== -1)) throw new Error('草稿必须包含一次完整批注引用')
  const binding = ctx.sessions.binding(sessionId)
  if (!binding || binding.session.getSnapshot().removed) throw new Error('这篇论文的 DSH 对话不可用，请重新打开文献')
  if (ctx.sessions.subagentAddress(sessionId) !== undefined) throw new Error('子代理对话不支持接收阅读草稿')
  const input = ctx.conversation.input.for(binding.ctx)
  const state = input.state.getSnapshot()
  if (state.phase !== 'plain') throw new Error('主对话输入框正在处理命令或提交，请完成后再粘贴批注；现有草稿已保留')
  const block = ctx.conversation.blocks.storeFor(sessionId).getSnapshot()
  if (block) throw new Error(`主对话输入框暂不可用：${block.reason}`)
  // InputState uses clipboard coordinates; a structured chip occupies one detect character.
  const end = state.draft.length - state.occurrences.reduce((sum, occurrence) => sum + occurrence.length - 1, 0)
  // Cordis requires the dispatch subject as well as the scoped method receiver;
  // omitting it broadcasts to other mounted Session input listeners.
  const applied = binding.ctx.bail(binding.ctx, 'slash/input-insert-text', {
    text: `${state.draft ? '\n\n' : ''}${text}`,
    span: { start: end, end, draftRev: state.draftRev },
  })
  if (applied !== true) throw new Error('主对话草稿刚刚发生变化，请重试；现有内容已保留')
  if (insert) {
    const next = input.state.getSnapshot()
    const start = end + (state.draft ? 2 : 0) + referenceOffset
    const inserted = binding.ctx.bail(binding.ctx, 'slash/input-insert-reference', {
      reference: insert,
      span: { start, end: start + insert.ref.length, draftRev: next.draftRev },
    })
    // A plain canonical token is still a complete, Host-resolvable draft. Do not
    // reappend it after a decoration race or destroy the user's other inputs.
    if (inserted !== true) input.notify?.('info', '批注引用已保留为文本，可直接发送；点击引用预览可查看材料')
    return inserted === true
  }
  return true
}

/** Root-owned frame bridge survives the right Sidebar's session-keyed remount. */
export function createConversationBridge({ window, ctx, rememberReference = () => {}, rememberBoardReference = () => {} }) {
  const origin = window.location.origin
  const frames = new Map()
  const mounted = new Map()
  let snapshot = null
  let active = true
  let navigation = null
  let frameTimer = null
  let terminalRelay = null
  let pendingReference = null
  const post = (target, data) => { if (active) target.postMessage({ ...data, version: VERSION }, origin) }

  function relayReference() {
    if (!pendingReference) return
    const target = [...frames].reverse().find(([, frame]) => frame.ready)?.[0]
    if (!target) return
    post(target, { type: 'paper-library:reference-open', ...pendingReference })
    pendingReference = null
  }

  function relayResult(target) {
    if (!terminalRelay) return
    const result = terminalRelay
    terminalRelay = null
    post(target, result)
  }

  function finishNavigation(error) {
    const pending = navigation
    if (!pending) return
    navigation = null
    window.clearTimeout(pending.timer)
    if (frameTimer !== null) { window.cancelAnimationFrame(frameTimer); frameTimer = null }
    if (error) pending.reject(error)
    else pending.resolve()
  }

  function scheduleOpen() {
    if (!active || !navigation || frameTimer !== null || !mounted.has(navigation.sessionId)) return
    const pending = navigation
    frameTimer = window.requestAnimationFrame(() => {
      frameTimer = null
      if (navigation !== pending || !active) return
      if (ctx.sessions.list.getSnapshot().current !== pending.sessionId) {
        finishNavigation(new Error('你已切换到其他对话，文献库导航已取消'))
        return
      }
      try {
        // Sidebar's own passive mount effect has published its current service binding by this frame.
        ctx.sidebarRight.openTab('paper-library')
        // Waiting for the composer mount also lets Harness restore its persisted draft first.
        if (pending.text !== undefined) appendConversationDraft(ctx, pending.sessionId, pending.text, pending.reference, pending.toInsert)
        relayReference()
        finishNavigation()
      } catch (error) {
        finishNavigation(error)
      }
    })
  }

  function openSession(sessionId, text, reference, toInsert) {
    if (navigation) throw new Error('正在打开论文对话，请稍后重试')
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => finishNavigation(new Error('论文对话已切换，但文献库面板未能重新打开；请从右侧栏打开文献库')), NAVIGATION_TIMEOUT)
      navigation = { sessionId, text, reference, toInsert, resolve, reject, timer }
      try {
        ctx.sessions.open(sessionId)
        scheduleOpen()
      } catch (error) { finishNavigation(error) }
    })
  }

  async function perform(data) {
    if (data.action === 'refresh') { await ctx.sessions.refresh(); return }
    if (!['open', 'draft', 'board_draft'].includes(data.action)) throw new Error('不支持的论文对话操作')
    if (typeof data.sessionId !== 'string' || !data.sessionId || data.sessionId.length > 200) throw new Error('论文对话标识无效')
    await ctx.sessions.refresh()
    if (!active) throw new Error('文献库已关闭')
    const binding = ctx.sessions.binding(data.sessionId)
    if (!binding || binding.session.getSnapshot().removed) throw new Error('论文对话不存在，请重新打开文献')
    if (navigation) throw new Error('正在打开论文对话，请稍后重试')
    if (data.action === 'board_draft') {
      // The reader freezes the board first; this side only carries its identity into the draft.
      if (typeof data.board_id !== 'string' || !/^[A-Za-z0-9_-]{1,60}$/.test(data.board_id)) throw new Error('画板标识无效')
      if (typeof data.snapshot_id !== 'string' || !/^[a-f0-9]{64}$/.test(data.snapshot_id)) throw new Error('画板引用快照无效')
      if (typeof data.title !== 'string' || !data.title.trim() || data.title.length > 200) throw new Error('画板标题无效')
      const title = data.title.trim()
      const ref = boardReferenceToken(data.board_id, data.snapshot_id)
      const reference = { ref, label: `画板：${title}`, clipboardText: ref }
      rememberBoardReference(data.sessionId, reference)
      return openSession(data.sessionId, `引用画板：${title}\n${ref}`, reference, boardReferenceInsert)
    }
    const text = data.reference ? data.draft_text : data.text
    if (data.action === 'draft' && (typeof text !== 'string' || !text.trim() || text.length > TEXT_LIMIT)) throw new Error('批注文本为空或超过 65,536 个字符')
    const reference = data.action === 'draft' && data.reference ? annotationReferenceInsert(data.reference) : undefined
    if (reference) {
      if (parseAnnotationReference(reference.ref).snapshot_id !== data.snapshot_id) throw new Error('批注引用快照不一致')
      rememberReference(data.sessionId, reference)
    }
    await openSession(data.sessionId, data.action === 'draft' ? text : undefined, reference)
  }

  function onMessage(event) {
    if (!active || event.origin !== origin || event.data?.version !== VERSION) return
    const frame = frames.get(event.source)
    if (!frame) return
    const data = event.data
    if (data.type === 'paper-library:ready') {
      if (frame.ready) return
      frame.ready = true
      if (snapshot) post(event.source, { type: 'paper-library:restore', snapshot })
      relayResult(event.source)
      relayReference()
      return
    }
    if (data.type === 'paper-library:reader-state') {
      try { snapshot = readerSnapshot(data.snapshot) }
      catch (error) { post(event.source, { type: 'paper-library:reader-state-error', error: error.message }) }
      return
    }
    if (data.type !== ACTION || typeof data.requestId !== 'string' || !data.requestId || data.requestId.length > 128) return
    const prior = frame.requests.get(data.requestId)
    if (prior) { if (prior.result) post(event.source, prior.result); return }
    if ([...frame.requests.values()].filter(request => !request.result).length >= 4) {
      post(event.source, { type: RESULT, requestId: data.requestId, ok: false, error: '对话操作过于频繁，请等待当前操作完成' })
      return
    }
    while (frame.requests.size >= 32) {
      const settled = [...frame.requests].find(([, request]) => request.result)
      if (!settled) break
      frame.requests.delete(settled[0])
    }
    const request = { result: null }
    frame.requests.set(data.requestId, request)
    void perform(data).then(() => ({ type: RESULT, requestId: data.requestId, ok: true }), error => ({
      type: RESULT, requestId: data.requestId, ok: false, error: (error instanceof Error ? error.message : String(error)).slice(0, 2000),
    })).then(result => {
      if (!active) return
      request.result = result
      post(event.source, result)
      if (!frames.has(event.source) && ['open', 'draft', 'board_draft'].includes(data.action)) {
        terminalRelay = { ...result, relay: true, sessionId: data.sessionId }
        const recipient = [...frames].reverse().find(([, candidate]) => candidate.ready)?.[0]
        if (recipient) relayResult(recipient)
      }
    })
  }
  window.addEventListener('message', onMessage)

  return {
    /** Reveal a page after a user explicitly opens an immutable reference. */
    async openReference({ sessionId, paperId, page, snapshot_id }) {
      boundedString(paperId, 200); pageNumber(page)
      if (!/^[a-f0-9]{64}$/.test(snapshot_id)) throw new Error('批注引用快照无效')
      if (ctx.sessions.list.getSnapshot().current !== sessionId) throw new Error('你已切换到其他对话，请在原对话重新打开引用')
      pendingReference = { paperId, page, snapshot_id }
      try { await openSession(sessionId) }
      catch (error) { pendingReference = null; throw error }
    },
    /** Authorize exactly one generated iframe's WindowProxy until its pane unmounts. */
    attach(target) {
      const record = { ready: false, requests: new Map() }
      frames.set(target, record)
      return () => { if (frames.get(target) === record) frames.delete(target) }
    },
    /** Consume pending navigation after the target session's composer seat mounts. */
    mountedSession(sessionId) {
      const token = {}
      mounted.set(sessionId, token)
      scheduleOpen()
      return () => { if (mounted.get(sessionId) === token) mounted.delete(sessionId) }
    },
    dispose() {
      if (!active) return
      active = false
      window.removeEventListener('message', onMessage)
      finishNavigation(new Error('文献库插件已卸载'))
      frames.clear(); mounted.clear(); snapshot = null; terminalRelay = null; pendingReference = null
    },
  }
}
