import { createElement, useEffect, useRef } from 'react'
import { bindModelContext } from './model-context.mjs'
import { createConversationBridge } from './conversation-context.mjs'

const ID = '@mappedinfo/dsh-paper-library'
const NS = 'paperLibrary'
export const name = 'paper-library-client'
export const inject = ['slots', 'locale', 'sidebarRightTabs', 'sidebarRight', 'modelDirectories', 'sessions', 'conversation']

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
    allow: 'clipboard-write',
    style: { width: '100%', height: '100%', minHeight: '480px', border: 0, background: '#f5f4ef' },
  })
}

/** Observe an always-mounted composer extension seat without adding visual chrome. */
export function ConversationMount({ sessionId, conversationBridge }) {
  useEffect(() => conversationBridge.mountedSession(sessionId), [conversationBridge, sessionId])
  return null
}

/** Add a Library entry to Harness's right-panel guide using its public tab registry. */
export function apply(ctx) {
  let conversationBridge
  ctx.effect(() => {
    conversationBridge = createConversationBridge({ window, ctx })
    return () => conversationBridge.dispose()
  }, 'paper-library: conversation bridge')
  ctx.effect(() => ctx.locale.register(NS, {
    zh: { title: '文献库', description: '检索、引用、PDF 批注与论文对话' },
    en: { title: 'Paper Library', description: 'Search, cite, annotate PDFs and discuss each paper' },
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
}
