import { createElement, useEffect, useRef, useState } from 'react'
import { bindModelContext } from './model-context.mjs'
import { createConversationBridge } from './conversation-context.mjs'
import { createAnnotationReferences, draftAnnotationReferences } from './annotation-references.mjs'

const ID = '@mappedinfo/dsh-paper-library'
const NS = 'paperLibrary'
const referenceButtonStyle = {
  boxSizing: 'border-box', maxWidth: '100%', minWidth: 0, padding: '4px 8px',
  border: '1px solid var(--dsw-alias-border-l1, #d9dde2)', borderRadius: '7px',
  background: 'var(--dsw-alias-bg-base, transparent)', color: 'inherit',
  font: 'inherit', lineHeight: 1.4, whiteSpace: 'normal', overflowWrap: 'anywhere', cursor: 'pointer',
}
export const name = 'paper-library-client'
export const inject = ['slots', 'locale', 'sidebarRightTabs', 'sidebarRight', 'modelDirectories', 'sessions', 'conversation', 'inputTriggers']

/** The reader exists only while its pane is visible; no background PDF renderer. */
export function LibraryPane({ useTabInfo, t, sessionId, directory, modelAvailable, conversationBridge }) {
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
  if (!tab.visible) return null
  return createElement('iframe', {
    ref: frame,
    title: t('title'),
    src: '/api/paper-library/',
    loading: 'lazy',
    referrerPolicy: 'same-origin',
    allow: 'clipboard-write; fullscreen',
    allowFullScreen: true,
    style: { width: '100%', height: '100%', minHeight: '480px', border: 0, background: '#f5f4ef' },
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

/** Add a Library entry to Harness's right-panel guide using its public tab registry. */
export function apply(ctx) {
  let conversationBridge
  let annotationReferences
  ctx.effect(() => {
    annotationReferences = createAnnotationReferences({
      window,
      openPaper: request => conversationBridge.openReference(request),
      notify: (sessionId, message) => {
        const binding = ctx.sessions.binding(sessionId)
        if (binding) ctx.conversation.input.for(binding.ctx).notify('error', message)
      },
    })
    conversationBridge = createConversationBridge({ window, ctx, rememberReference: annotationReferences.remember })
    return () => { annotationReferences.dispose(); conversationBridge.dispose() }
  }, 'paper-library: conversation bridge')
  ctx.effect(() => ctx.inputTriggers.registerSource(annotationReferences.source), 'paper-library: annotation references')
  ctx.effect(() => ctx.locale.register(NS, {
    zh: { title: '文献库', description: '检索、引用、PDF 批注与论文对话', 'reference.title': '论文批注引用', 'reference.preview': '查看引用', 'reference.close': '收起', 'reference.loading': '正在读取引用快照…', 'reference.frozen': '发送材料快照', 'reference.notes': '条批注', 'reference.page': '第', 'reference.morePages': '其他页数：' },
    en: { title: 'Paper Library', description: 'Search, cite, annotate PDFs and discuss each paper', 'reference.title': 'Paper annotation references', 'reference.preview': 'Inspect reference', 'reference.close': 'Close', 'reference.loading': 'Loading reference snapshot…', 'reference.frozen': 'Frozen reference material', 'reference.notes': 'annotations', 'reference.page': 'Page', 'reference.morePages': 'More pages:' },
  }), 'paper-library: locale')
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: ID,
    kind: 'paper-library',
    priority: 'extension',
    title: () => t('title'),
    guide: [{ order: 15, title: () => t('title'), description: () => t('description') }],
  }), 'paper-library: tab type')
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab',
    key: ID,
    locale: NS,
    inject: sessionId => ({
      sessionId,
      conversationBridge,
      directory: ctx.modelDirectories.directoryFor(sessionId),
      modelAvailable: ctx.sessions.subagentAddress(sessionId) === undefined,
    }),
  }, props => createElement(LibraryPane, { ...props, t }))), 'paper-library: tab body')
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
}
