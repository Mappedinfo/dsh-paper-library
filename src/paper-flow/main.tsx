/// <reference path="./inline-css.d.ts" />
import { Component, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { PaperFlowWorkbench } from '../../vendor/paper-flow/index'
import type { FlowWorkspace, FlowRef } from '../../vendor/paper-flow/types'
import type { PaperFlowWorkbenchHandle } from '../../vendor/paper-flow/PaperFlowWorkbench'
import { createFlowController } from './controller.mjs'
import { starterWorkspace } from './starter.mjs'
import { bindFlowUnloadGuard } from './unload.mjs'
import { validateFlowWorkspace } from './validation.mjs'
import { isFlowFileDrag, selectFlowImportFile } from '../../vendor/paper-flow/import-files.js'
import { createBoardAnnotationStore, handleBoardAnnotationRequest } from '../harness/board-annotations.mjs'
import { normalizeBoardAnnotationRecord } from '../board-annotation-schema.mjs'
import './host.css'

type FlowTarget = { kind: 'flow'; paper_id: string; flow_id: string; node_id?: string; node_ids?: string[] }
type HostOptions = { root: HTMLElement; api(action: string, args: object): Promise<any>; toast(message: string, error?: boolean): void; onClose(): void; prepareReturnToDsh?: () => Promise<boolean>; sendSnapshot?: (snapshot: any, sessionId: string) => Promise<boolean>; getSessionId?: () => string | null; onCanvasContext?: (context: any) => void; onAnnotations?: (context: any) => void }
type OpenOptions = { id: string; title: string; seed?: unknown }
type FlowState = { id: string | null; title: string; workspace: FlowWorkspace | null; revision: unknown; version: number; epoch: number; dirty: boolean; saving: boolean; blocked: boolean; invalid: boolean; error: string; loading: boolean }

class FlowErrorBoundary extends Component<{ children: ReactNode; recoveryKey: string }, { error: boolean }> {
  state = { error: false }
  static getDerivedStateFromError() { return { error: true } }
  componentDidUpdate(previous: Readonly<{ children: ReactNode; recoveryKey: string }>) { if (this.state.error && previous.recoveryKey !== this.props.recoveryKey) this.setState({ error: false }) }
  render() { return this.state.error ? <p className="board-flow-render-error" role="alert">流程暂时无法显示，当前草稿仍保留。请备份 JSON 或重新读取。</p> : this.props.children }
}

function backup(workspace: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(workspace, null, 2)], { type: 'application/json' }))
  const link = document.createElement('a'); link.href = url; link.download = 'paper-flow-draft.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 0)
}

function Panel({ controller, close, subscribe, prepareReturnToDsh, workbench, send, context, annotate, canSend }: { controller: ReturnType<typeof createFlowController>; close(): Promise<boolean>; subscribe(listener: (value: FlowState) => void): () => void; prepareReturnToDsh?: () => Promise<boolean>; workbench: React.RefObject<PaperFlowWorkbenchHandle | null>; send(ref: FlowRef, ids?: string[]): Promise<void>; context(target: FlowTarget): void; annotate(target: FlowTarget): Promise<void>; canSend: boolean }) {
  const [view, setView] = useState<FlowState>(() => controller.state() as FlowState)
  const hostTools = useRef<HTMLDivElement>(null)
  const emptyFileInput = useRef<HTMLInputElement>(null), importSerial = useRef(0), dragDepth = useRef(0)
  const [emptyImport, setEmptyImport] = useState({ name: '', loading: false, error: '' }), [dropActive, setDropActive] = useState(false)
  const target = (ref: FlowRef, ids?: string[]): FlowTarget => ({ kind: 'flow', paper_id: ref.documentId, flow_id: ref.flowId, ...(ids?.length === 1 ? { node_id: ids[0] } : ids?.length ? { node_ids: ids } : {}) })
  useEffect(() => { if (view.workspace) context(target(view.workspace.selection.left)) }, [view.id, view.epoch, view.workspace?.selection.left.documentId, view.workspace?.selection.left.flowId])
  useEffect(() => () => { importSerial.current++ }, [])
  useEffect(() => { importSerial.current++; dragDepth.current = 0; setDropActive(false); setEmptyImport({ name: '', loading: false, error: '' }) }, [view.id, view.epoch])
  useEffect(() => {
    setView(controller.state() as FlowState)
    return subscribe(next => setView(previous => previous.epoch === next.epoch && previous.version === next.version ? { ...next, workspace: previous.workspace } : next))
  }, [controller, subscribe])
  useEffect(() => {
    if (!prepareReturnToDsh || !hostTools.current) return
    const button = (window as any).PaperReturnToDsh?.create({ host: hostTools.current, prepare: prepareReturnToDsh })
    return () => button?.remove()
  }, [prepareReturnToDsh, view.id, !!view.workspace])
  const status = view.loading ? '正在读取…' : view.saving ? '正在保存…' : view.invalid ? '草稿待修正' : view.blocked ? '保存未完成' : view.dirty ? '等待保存' : '已保存'
  const choose = async (files: readonly File[]) => {
    const owner = controller.token(), serial = ++importSerial.current
    const current = () => serial === importSerial.current && controller.current(owner, true)
    try {
      const file = selectFlowImportFile(files)
      setEmptyImport({ name: file.name || 'JSON 文件', loading: true, error: '' })
      const contents = await file.text()
      if (!current()) return
      controller.applyExternal(validateFlowWorkspace(contents), owner)
      setEmptyImport({ name: file.name || 'JSON 文件', loading: false, error: '' })
    } catch (error: any) { if (current()) setEmptyImport({ name: '', loading: false, error: `无法导入：${error.message || error}` }) }
  }
  const reload = async () => {
    if ((view.dirty || view.blocked || view.invalid) && !window.confirm('重新读取将丢弃当前未保存草稿。请先备份；确定继续吗？')) return
    await controller.reload()
  }
  const header = <header className="board-flow-header">
      <button type="button" onClick={() => void close()}>← 返回画板</button>
      <strong title={view.title}>{view.title || '流程工作区'}</strong><span className={`board-flow-status${view.blocked || view.invalid ? ' is-error' : ''}`} role="status">{status}</span>
      <div className="board-flow-actions board-flow-host-tools" ref={hostTools}>
        <button type="button" disabled={!view.dirty || view.loading || view.invalid || view.blocked} onClick={() => void controller.flush()}>保存</button>
        {(view.blocked || view.invalid) && <button type="button" disabled={view.loading || view.invalid} onClick={() => void controller.flush({ retry: true })}>重试保存</button>}
        <button type="button" disabled={!view.workspace} onClick={() => backup(view.workspace)}>备份 JSON</button>
        <button type="button" disabled={view.loading || view.saving} onClick={() => void reload()}>重新读取</button>
      </div>
      {view.error && <p className="board-flow-error" role="alert">{view.error} {view.dirty && '草稿仍在当前页面，可备份后重试。'}</p>}
    </header>
  return <section className="board-flow-host" aria-label="流程工作区">
    {header}
    <div className="board-flow-content" inert={view.loading || undefined}
      onDragEnter={event => { if (view.workspace) return; event.preventDefault(); if (isFlowFileDrag(event.dataTransfer)) { dragDepth.current++; setDropActive(true) } }}
      onDragOver={event => { if (view.workspace) return; event.preventDefault(); if (isFlowFileDrag(event.dataTransfer)) { event.dataTransfer.dropEffect = 'copy'; setDropActive(true) } }}
      onDragLeave={event => { if (view.workspace) return; event.preventDefault(); if (--dragDepth.current <= 0) { dragDepth.current = 0; setDropActive(false) } }}
      onDrop={event => { if (view.workspace) return; event.preventDefault(); event.stopPropagation(); dragDepth.current = 0; setDropActive(false); void choose(Array.from(event.dataTransfer.files)) }}>
      {!view.workspace && dropActive && <div className="paper-flow-drop-target" role="status"><strong>松开以导入 JSON</strong><span>一次一个文件，最大 192 KiB</span></div>}
      {view.workspace ? <FlowErrorBoundary recoveryKey={`${view.id}:${view.version}`}><PaperFlowWorkbench ref={workbench} key={`${view.id}:${view.epoch}`} workspace={view.workspace} onWorkspaceChange={(next: FlowWorkspace) => controller.edit(next, { id: view.id, epoch: view.epoch, version: view.version })}
        toolbar={<>{canSend && <button type="button" onClick={() => void send(view.workspace!.selection.left)}>流程放入 DSH</button>}<button type="button" onClick={() => void annotate(target(view.workspace!.selection.left))}>流程批注</button></>}
        onNodeSelect={contexts => { if (contexts[0]) context(target(contexts[0].ref, contexts[0].nodeIds)) }}
        renderNodeDetails={(_node, _graph, contexts) => <div className="board-flow-node-actions">{contexts.map(value => <div key={value.side}>
          {contexts.length > 1 && <strong>{value.side.toUpperCase()} 侧原流程</strong>}
          {canSend && <button type="button" onClick={() => void send(value.ref, value.nodeIds)}>节点与上下游放入 DSH</button>}
          <button type="button" onClick={() => void annotate(target(value.ref, value.nodeIds))}>批注此节点{value.nodeIds.length > 1 ? `组（${value.nodeIds.length}）` : ''}</button>
        </div>)}</div>} /></FlowErrorBoundary> : <div className="board-flow-empty">
        <h2>开始整理流程</h2><p>新建一份流程、导入已有 JSON，或先打开不含研究资料的教学示例。也可以将一个 JSON 文件直接拖入面板（最大 192 KiB）。</p>
        <div><button type="button" onClick={() => controller.edit(starterWorkspace())}>新建流程</button><button type="button" onClick={() => emptyFileInput.current?.click()}>导入 JSON</button><input className="board-flow-import-input" ref={emptyFileInput} type="file" accept=".json,application/json" aria-label="导入流程 JSON" onChange={event => { const files = Array.from(event.currentTarget.files || []); event.currentTarget.value = ''; if (files.length) void choose(files) }} /><button type="button" onClick={() => controller.edit(starterWorkspace(true))}>打开教学示例</button></div>
        {emptyImport.loading && <p role="status">正在读取 {emptyImport.name}…</p>}{emptyImport.error && <p className="board-flow-error" role="alert">{emptyImport.error}</p>}
      </div>}
    </div>
  </section>
}

function create({ root, api, toast, onClose, prepareReturnToDsh, sendSnapshot, getSessionId, onCanvasContext, onAnnotations }: HostOptions) {
  const react = createRoot(root)
  const listeners = new Set<(value: FlowState) => void>()
  const subscribe = (listener: (value: FlowState) => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
  const controller = createFlowController({ api, validate: validateFlowWorkspace, onChange: (detail: FlowState) => listeners.forEach(listener => listener(detail)) })
  const unbindUnload = bindFlowUnloadGuard({ window, state: controller.state })
  let visible = false, disposed = false
  const workbench = { current: null as PaperFlowWorkbenchHandle | null }
  const context = (target: FlowTarget) => { if (!disposed) onCanvasContext?.({ id: controller.state().id, target }) }
  async function annotate(target: FlowTarget) {
    const owner = controller.token()
    if (!await prepareLeave() || !controller.current(owner, true)) return
    workbench.current?.exitFullscreen()
    onAnnotations?.({ id: owner.id, target })
  }
  async function send(ref: FlowRef, ids?: string[]) {
    const owner = controller.token(), sessionId = getSessionId?.()
    if (!sessionId || !sendSnapshot) { toast('当前 DSH 会话尚未就绪，请从 DSH 打开后重试。', true); return }
    try {
      if (!await prepareLeave() || !controller.current(owner, true)) return
      const saved = controller.state()
      const frozen = await api('board_flow_snapshot', { id: owner.id, paper_id: ref.documentId, flow_id: ref.flowId, ...(ids?.length ? { node_ids: ids } : {}), expected_revision: saved.revision })
      if (!visible || !controller.current(owner, true) || getSessionId?.() !== sessionId) { toast('页面或会话已切换，请在当前流程中重新加入引用。', true); return }
      await sendSnapshot(frozen, sessionId)
    } catch (error: any) { toast(error.message || '流程引用未完成，草稿仍保留。', true) }
  }
  async function prepareLeave() {
    if (disposed) return false
    const views = [...root.querySelectorAll<HTMLElement>('.paper-flow-canvas')].map(node => node.shadowRoot?.querySelector<HTMLElement>('.graph-wrap')).filter(Boolean) as HTMLElement[]
    for (const view of views) view.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, composed: true }))
    if (views.length) await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
    const ok = await controller.prepareLeave(); if (!ok) toast('流程草稿尚未保存，请先重试或备份。', true); return ok
  }
  async function close() { if (!visible || !await prepareLeave()) return false; controller.invalidatePending(); visible = false; root.hidden = true; onClose(); return true }
  react.render(<Panel controller={controller} close={close} subscribe={subscribe} prepareReturnToDsh={prepareReturnToDsh} workbench={workbench} send={send} context={context} annotate={annotate} canSend={!!sendSnapshot} />)
  root.hidden = true
  return {
    async open(options: OpenOptions) { if (disposed) return false; const current = controller.state(); if (visible && (current.id !== options.id || !current.dirty && !current.blocked && !current.invalid) && !await prepareLeave()) return false; const ok = await controller.open(options); if (!ok) { toast(controller.state().error || '流程工作区尚未保存或读取失败。', true); return false } visible = true; root.hidden = false; return true },
    prepareLeave, close, isOpen: () => visible,
    focus(target: FlowTarget) { if (!visible || disposed) return false; workbench.current?.focus({ documentId: target.paper_id, flowId: target.flow_id }, target.node_ids || (target.node_id ? [target.node_id] : [])); return true },
    dispose() { if (disposed) return; disposed = true; unbindUnload(); controller.dispose(); react.unmount(); root.hidden = true },
  }
}

;(window as any).PaperBoardFlow = Object.freeze({ create, validateFlowWorkspace, createBoardAnnotationStore, handleBoardAnnotationRequest, normalizeBoardAnnotationRecord })
