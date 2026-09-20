import { createElement, useEffect, useRef, useState } from 'react'
import { bindModelContext } from './model-context.mjs'
import { bindThemeContext } from './theme-context.mjs'
import { createConversationBridge } from './conversation-context.mjs'
import { createAnnotationReferences, draftAnnotationReferences } from './annotation-references.mjs'
import { createBoardReferences } from './board-references.mjs'
import { registerPaperLibrarySettings } from './settings.mjs'

const ID = '@mappedinfo/dsh-paper-library'
const NS = 'paperLibrary'
const referenceButtonStyle = {
  boxSizing: 'border-box', maxWidth: '100%', minWidth: 0, padding: '4px 8px',
  border: '1px solid var(--dsw-alias-border-l1, #d9dde2)', borderRadius: '7px',
  background: 'var(--dsw-alias-bg-base, transparent)', color: 'inherit',
  font: 'inherit', lineHeight: 1.4, whiteSpace: 'normal', overflowWrap: 'anywhere', cursor: 'pointer',
}
/** The whiteboard is a second entry of this plugin, not a second plugin: the same bundle
 *  registers two tab types, so the start page offers 文献库 and 画板 side by side and each
 *  opens its own tab. Its iframe asks the page for the board-only view. */
const CANVAS_ID = `${ID}/whiteboard`
const CANVAS_KIND = 'paper-library-whiteboard'
/** Coloured sheet glyphs for the start page's capsules, drawn at the seat's size. */
function LibraryGlyph({ size = 20, className }) {
  return createElement('svg', { width: size, height: size, viewBox: '0 0 24 24', className, fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true' },
    createElement('path', { d: 'M4 4.5A2.5 2.5 0 0 1 6.5 2H19v20H6.5A2.5 2.5 0 0 1 4 19.5z' }),
    createElement('path', { d: 'M4 17.5h15' }))
}
function CanvasGlyph({ size = 20, className }) {
  return createElement('svg', { width: size, height: size, viewBox: '0 0 24 24', className, fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true' },
    createElement('rect', { x: 2.5, y: 4, width: 8, height: 5.5, rx: 1.4 }),
    createElement('rect', { x: 13.5, y: 14.5, width: 8, height: 5.5, rx: 1.4 }),
    createElement('path', { d: 'M6.5 9.5v5a2 2 0 0 0 2 2h5' }))
}
export const name = 'paper-library-client'
export const inject = ['slots', 'locale', 'sidebarRightTabs', 'sidebarRight', 'modelDirectories', 'sessions', 'conversation', 'inputTriggers']

/** The reader exists only while its pane is visible; no background PDF renderer.
 *  `view` picks which of the plugin's two surfaces this pane shows: the library, or the
 *  whiteboard alone (`?view=board`, which the page opens focused on the canvas). */
export function LibraryPane({ useTabInfo, t, sessionId, directory, modelAvailable, conversationBridge, bindTheme, bindSettings, view = 'library' }) {
  const canvas = view === 'board'
  const { tab } = useTabInfo()
  const frame = useRef(null)
  useEffect(() => {
    if (!tab.visible || !frame.current?.contentWindow) return undefined
    return conversationBridge.attach(frame.current.contentWindow)
  }, [conversationBridge, tab.visible])
  useEffect(() => {
    if (!tab.visible || !frame.current?.contentWindow) return undefined
    return bindModelContext({ window, target: frame.current.contentWindow, sessionId, directory, available: modelAvailable })
  }, [sessionId, directory, modelAvailable, tab.visible])
  useEffect(() => {
    if (!tab.visible || !frame.current?.contentWindow) return undefined
    return bindTheme(frame.current.contentWindow)
  }, [bindTheme, tab.visible])
  useEffect(() => {
    if (!tab.visible || !frame.current?.contentWindow) return undefined
    return bindSettings(frame.current.contentWindow)
  }, [bindSettings, tab.visible])
  if (!tab.visible) return null
  return createElement('iframe', {
    ref: frame,
    title: t(canvas ? 'canvas.title' : 'title'),
    src: canvas ? '/api/paper-library/?view=board' : '/api/paper-library/',
    loading: 'lazy',
    referrerPolicy: 'same-origin',
    allow: 'clipboard-write; fullscreen',
    allowFullScreen: true,
    style: { width: '100%', height: '100%', minHeight: '480px', border: 0, background: 'var(--dsw-alias-bg-base, transparent)' },
  })
}

/** Observe an always-mounted composer extension seat without adding visual chrome. */
export function ConversationMount({ sessionId, conversationBridge }) {
  useEffect(() => conversationBridge.mountedSession(sessionId), [conversationBridge, sessionId])
  return null
}

/** Native dock is an additive seat; neither the input nor message renderer is replaced. */
export function AnnotationReferenceInspector({ sessionId, annotationReferences, useInput, t }) {
  const input = useInput(state => state)
  const [preview, setPreview] = useState(annotationReferences.getSnapshot())
  useEffect(() => annotationReferences.subscribe(() => setPreview(annotationReferences.getSnapshot())), [annotationReferences])
  const restored = draftAnnotationReferences(input.draft).filter(reference => !input.occurrences.some(occurrence => occurrence.ref === reference.ref))
  const shown = preview?.sessionId === sessionId ? preview : null
  if (!shown && !restored.length) return null
  const controls = restored.map((reference, index) => createElement('button', {
    type: 'button', key: reference.ref,
    onClick: () => { void annotationReferences.preview(sessionId, reference.ref) },
    style: referenceButtonStyle,
  }, `${t('reference.preview')} ${index + 1}`))
  if (shown) {
    controls.push(createElement('button', { type: 'button', key: 'close', onClick: () => annotationReferences.close(), style: { ...referenceButtonStyle, marginLeft: 'auto' } }, t('reference.close')))
  }
  const pages = shown?.snapshot ? [...new Set(shown.snapshot.annotation_refs.map(note => note.page).filter(page => Number.isSafeInteger(page) && page > 0 && page <= 2000))] : []
  return createElement('section', { 'aria-label': t('reference.title'), 'data-paper-reference-inspector': true, style: {
    boxSizing: 'border-box', flex: 'none', minWidth: 0, contain: 'inline-size',
    width: 'calc(100% - var(--dsh-composer-side-clearance, 16px) - var(--dsh-composer-side-clearance, 16px) - var(--dsh-composer-dock-inset, 8px) - var(--dsh-composer-dock-inset, 8px) - var(--dsh-composer-dock-inset, 8px) - var(--dsh-composer-dock-inset, 8px))',
    maxWidth: 'min(100%, var(--dsh-chat-content-width, 680px))', margin: '0 auto', padding: '10px 12px',
    overflow: 'hidden', overflowWrap: 'anywhere', fontSize: '12px', lineHeight: 1.5,
    border: '1px solid var(--dsw-alias-border-l1, #d9dde2)', borderRadius: '12px',
    background: 'var(--dsw-specific-tip, #f6f7f8)', color: 'inherit',
  } },
    createElement('div', { style: { display: 'flex', minWidth: 0, maxWidth: '100%', flexWrap: 'wrap', alignItems: 'center', gap: '6px' } }, ...controls),
    shown?.loading ? createElement('p', { role: 'status' }, t('reference.loading')) : null,
    shown?.error ? createElement('p', { role: 'alert' }, shown.error) : null,
    shown?.snapshot ? createElement('details', { open: true, style: { boxSizing: 'border-box', width: '100%', minWidth: 0, maxWidth: '100%', marginTop: '8px', overflow: 'hidden' } },
      createElement('summary', { style: { cursor: 'pointer', overflowWrap: 'anywhere', fontWeight: 500 } }, `${t('reference.frozen')} · ${shown.snapshot.annotation_refs.length} ${t('reference.notes')}`),
      createElement('div', { style: { display: 'flex', gap: '4px', flexWrap: 'wrap', padding: '6px 0' } },
        ...pages.slice(0, 12).map(page => createElement('button', {
          key: page, type: 'button', style: referenceButtonStyle, onClick: () => { void annotationReferences.openPage(page) },
        }, `${t('reference.page')} ${page}`)),
        pages.length > 12 ? createElement('span', null, `${t('reference.morePages')} ${pages.length - 12}`) : null),
      createElement('pre', { style: { boxSizing: 'border-box', minWidth: 0, width: '100%', maxWidth: '100%', margin: 0, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', wordBreak: 'break-word', font: 'inherit', maxHeight: 'min(200px, 30vh)', overflowY: 'auto', overflowX: 'hidden', padding: '8px 10px', border: '1px solid var(--dsw-alias-border-l1, #d9dde2)', borderRadius: '8px', background: 'var(--dsw-alias-bg-base, transparent)' } }, shown.snapshot.text),
    ) : null,
  )
}

/** Frozen board material is shown from its snapshot, never re-rendered from the live board. */
export function BoardReferenceInspector({ sessionId, boardReferences, t }) {
  const [preview, setPreview] = useState(boardReferences.getSnapshot())
  useEffect(() => boardReferences.subscribe(() => setPreview(boardReferences.getSnapshot())), [boardReferences])
  const shown = preview?.sessionId === sessionId ? preview : null
  if (!shown) return null
  const snapshot = shown.snapshot ?? null
  return createElement('section', { 'aria-label': t('board.title'), 'data-paper-board-reference': true, style: {
    boxSizing: 'border-box', flex: 'none', minWidth: 0, contain: 'inline-size',
    width: 'calc(100% - var(--dsh-composer-side-clearance, 16px) - var(--dsh-composer-side-clearance, 16px) - var(--dsh-composer-dock-inset, 8px) - var(--dsh-composer-dock-inset, 8px) - var(--dsh-composer-dock-inset, 8px) - var(--dsh-composer-dock-inset, 8px))',
    maxWidth: 'min(100%, var(--dsh-chat-content-width, 680px))', margin: '0 auto', padding: '10px 12px',
    overflow: 'hidden', overflowWrap: 'anywhere', fontSize: '12px', lineHeight: 1.5,
    border: '1px solid var(--dsw-alias-border-l1, #d9dde2)', borderRadius: '12px',
    background: 'var(--dsw-specific-tip, #f6f7f8)', color: 'inherit',
  } },
    createElement('div', { style: { display: 'flex', minWidth: 0, maxWidth: '100%', flexWrap: 'wrap', alignItems: 'center', gap: '6px' } },
      createElement('strong', { style: { fontWeight: 500 } }, snapshot ? `${t('board.frozen')} · ${snapshot.board_title}` : t('board.title')),
      createElement('button', { type: 'button', onClick: () => boardReferences.close(), style: { ...referenceButtonStyle, marginLeft: 'auto' } }, t('board.close'))),
    shown.loading ? createElement('p', { role: 'status' }, t('board.loading')) : null,
    shown.error ? createElement('p', { role: 'alert' }, shown.error) : null,
    snapshot ? createElement('pre', { style: { boxSizing: 'border-box', minWidth: 0, width: '100%', maxWidth: '100%', margin: '8px 0 0', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', wordBreak: 'break-word', font: 'inherit', maxHeight: 'min(260px, 36vh)', overflowY: 'auto', overflowX: 'hidden', padding: '8px 10px', border: '1px solid var(--dsw-alias-border-l1, #d9dde2)', borderRadius: '8px', background: 'var(--dsw-alias-bg-base, transparent)' } }, snapshot.text) : null,
  )
}

/** Add a Library entry to Harness's right-panel guide using its public tab registry. */
export function apply(ctx) {
  let conversationBridge
  let annotationReferences
  let boardReferences
  const { bind: bindSettings } = registerPaperLibrarySettings(ctx, window)
  const bindTheme = target => bindThemeContext({
    window, target,
    getTheme: () => ctx.get('theme')?.getTheme(),
    subscribe: listener => ctx.on('theme/change', listener),
  })
  ctx.effect(() => {
    annotationReferences = createAnnotationReferences({
      window,
      openPaper: request => conversationBridge.openReference(request),
      notify: (sessionId, message) => {
        const binding = ctx.sessions.binding(sessionId)
        if (binding) ctx.conversation.input.for(binding.ctx).notify('error', message)
      },
    })
    boardReferences = createBoardReferences({
      window,
      notify: (sessionId, message) => {
        const binding = ctx.sessions.binding(sessionId)
        if (binding) ctx.conversation.input.for(binding.ctx).notify('error', message)
      },
    })
    conversationBridge = createConversationBridge({
      window, ctx,
      rememberReference: annotationReferences.remember,
      rememberBoardReference: boardReferences.remember,
    })
    return () => { annotationReferences.dispose(); boardReferences.dispose(); conversationBridge.dispose() }
  }, 'paper-library: conversation bridge')
  ctx.effect(() => ctx.inputTriggers.registerSource(annotationReferences.source), 'paper-library: annotation references')
  ctx.effect(() => ctx.inputTriggers.registerSource(boardReferences.source), 'paper-library: board references')
  ctx.effect(() => ctx.locale.register(NS, {
    zh: { title: '文献库', description: '检索、引用、PDF 批注与论文对话', 'canvas.title': '画板', 'canvas.description': '自由画布、连线与自动排版；可关联论文与阅读项目', 'reference.title': '论文批注引用', 'reference.preview': '查看引用', 'reference.close': '收起', 'reference.loading': '正在读取引用快照…', 'reference.frozen': '发送材料快照', 'reference.notes': '条批注', 'reference.page': '第', 'reference.morePages': '其他页数：', 'board.title': '画板引用', 'board.close': '收起', 'board.loading': '正在读取画板快照…', 'board.frozen': '画板材料快照' },
    en: { title: 'Paper Library', description: 'Search, cite, annotate PDFs and discuss each paper', 'canvas.title': 'Whiteboard', 'canvas.description': 'A free canvas with connectors and automatic layout; link papers and reading projects', 'reference.title': 'Paper annotation references', 'reference.preview': 'Inspect reference', 'reference.close': 'Close', 'reference.loading': 'Loading reference snapshot…', 'reference.frozen': 'Frozen reference material', 'reference.notes': 'annotations', 'reference.page': 'Page', 'reference.morePages': 'More pages:', 'board.title': 'Whiteboard references', 'board.close': 'Close', 'board.loading': 'Loading whiteboard snapshot…', 'board.frozen': 'Frozen whiteboard material' },
  }), 'paper-library: locale')
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: ID,
    kind: 'paper-library',
    priority: 'extension',
    title: () => t('title'),
    guide: [{ order: 15, title: () => t('title'), description: () => t('description'), icon: LibraryGlyph }],
  }), 'paper-library: tab type')
  // The whiteboard is its own tab type of the same plugin: its own start-page capsule, its
  // own tab, and the same bridge bindings, so 「放入对话」 works from either surface.
  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: CANVAS_ID,
    kind: CANVAS_KIND,
    priority: 'extension',
    title: () => t('canvas.title'),
    guide: [{ order: 16, title: () => t('canvas.title'), description: () => t('canvas.description'), icon: CanvasGlyph }],
  }), 'paper-library: whiteboard tab type')
  const paneProps = sessionId => ({
    sessionId,
    conversationBridge,
    bindTheme,
    bindSettings,
    directory: ctx.modelDirectories.directoryFor(sessionId),
    modelAvailable: ctx.sessions.subagentAddress(sessionId) === undefined,
  })
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab',
    key: ID,
    locale: NS,
    inject: paneProps,
  }, props => createElement(LibraryPane, { ...props, t }))), 'paper-library: tab body')
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab',
    key: CANVAS_ID,
    locale: NS,
    inject: paneProps,
  }, props => createElement(LibraryPane, { ...props, t, view: 'board' }))), 'paper-library: whiteboard tab body')
  ctx.effect(() => ctx.slots.inject('conversation.input.overlay', () => ctx.slots.register({
    name: 'conversation.input.overlay',
    id: ID,
    inject: sessionId => ({ sessionId, conversationBridge }),
  }, props => createElement(ConversationMount, props))), 'paper-library: session navigation mount')
  ctx.effect(() => ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock',
    id: `${ID}/references`, order: 20,
    inject: sessionId => ({ sessionId, annotationReferences }),
  }, props => createElement(AnnotationReferenceInspector, { ...props, t }))), 'paper-library: reference inspector')
  ctx.effect(() => ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock',
    id: `${ID}/boards`, order: 21,
    inject: sessionId => ({ sessionId, boardReferences }),
  }, props => createElement(BoardReferenceInspector, { ...props, t }))), 'paper-library: board reference inspector')
}
