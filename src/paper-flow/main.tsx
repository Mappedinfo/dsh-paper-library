/// <reference path="./inline-css.d.ts" />
import { Component, useEffect, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { PaperFlowWorkbench } from '../../vendor/paper-flow/index'
import type { FlowWorkspace, FlowRef, FlowGraph } from '../../vendor/paper-flow/types'
import type { PaperFlowWorkbenchHandle } from '../../vendor/paper-flow/PaperFlowWorkbench'
import { createFlowController } from './controller.mjs'
import { starterWorkspace } from './starter.mjs'
import { bindFlowUnloadGuard } from './unload.mjs'
import { validateFlowWorkspace } from './validation.mjs'
import { isFlowFileDrag, selectFlowImportFile } from '../../vendor/paper-flow/import-files.js'
import { createBoardAnnotationStore, handleBoardAnnotationRequest } from '../harness/board-annotations.mjs'
import { normalizeBoardAnnotationRecord } from '../board-annotation-schema.mjs'
import { EqTraceSourceForm, Figure, type GenerateEqTrace } from './EqTracePanel'
import { addEqTraceDocument } from './eqtrace-import.mjs'
import { eqTraceFlows } from './eqtrace-figure.mjs'
import attentionExample from '../../examples/eqtrace-attention.json'
import './host.css'

type FlowTarget = { kind: 'flow'; paper_id: string; flow_id: string; node_id?: string; node_ids?: string[] }
type HostOptions = { root: HTMLElement; canGenerateEqTrace?: boolean; api(action: string, args: object): Promise<any>; toast(message: string, error?: boolean): void; onClose(): void; prepareReturnToDsh?: () => Promise<boolean>; sendSnapshot?: (snapshot: any, sessionId: string) => Promise<boolean>; getSessionId?: () => string | null; onCanvasContext?: (context: any) => void; onAnnotations?: (context: any) => void }
type WorkbenchRef = React.RefObject<PaperFlowWorkbenchHandle | null> & { revealEditor?: () => void }
type Dock = 'compare' | 'code'
type DockProps = { panel: Dock | null; togglePanel(which: Dock): void; dismissPanel(): void }
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

function Panel({ controller, close, subscribe, prepareReturnToDsh, workbench, send, context, annotate, canSend, generate, panel, togglePanel, dismissPanel }: DockProps & { controller: ReturnType<typeof createFlowController>; close(): Promise<boolean>; subscribe(listener: (value: FlowState) => void): () => void; prepareReturnToDsh?: () => Promise<boolean>; workbench: WorkbenchRef; send(ref: FlowRef, ids?: string[]): Promise<void>; context(target: FlowTarget): void; annotate(target: FlowTarget): Promise<void>; canSend: boolean; generate?: GenerateEqTrace }) {
  const [view, setView] = useState<FlowState>(() => controller.state() as FlowState)
  const hostTools = useRef<HTMLDivElement>(null)
  const emptyFileInput = useRef<HTMLInputElement>(null), importSerial = useRef(0), dragDepth = useRef(0)
  const [emptyImport, setEmptyImport] = useState({ name: '', loading: false, error: '' }), [dropActive, setDropActive] = useState(false)
  const [editorKey, setEditorKey] = useState('')
  const [preview, setPreview] = useState<(Pick<FlowState, 'id' | 'epoch' | 'version'> & { example: boolean; ref: FlowRef }) | null>(null)
  const [comparisonHost, setComparisonHost] = useState<HTMLDivElement | null>(null)
  const [dataHost, setDataHost] = useState<HTMLDivElement | null>(null)
  const [controlsHost, setControlsHost] = useState<HTMLDivElement | null>(null)
  const [titlesHost, setTitlesHost] = useState<HTMLDivElement | null>(null)
  const [figureControls, setFigureControls] = useState<HTMLDivElement | null>(null)
  const [fullscreenHost, setFullscreenHost] = useState<HTMLElement | null>(null)
  const activeDoc = view.workspace?.documents.find(doc => doc.paper.id === view.workspace?.selection.left.documentId)
  const documentKey = JSON.stringify([view.id, view.epoch, activeDoc?.paper.id])
  const activeFigure = activeDoc && eqTraceFlows(activeDoc).find((f: FlowGraph) => f.id === view.workspace?.selection.left.flowId)
  const previewRef = preview && preview.id === view.id && preview.epoch === view.epoch ? preview : null
  const previewDoc = previewRef?.example ? attentionExample : view.workspace?.documents.find(doc => doc.paper.id === previewRef?.ref.documentId)
  const previewFigure = previewRef && previewDoc ? eqTraceFlows(previewDoc).find((f: FlowGraph) => f.id === previewRef.ref.flowId) : null
  const baseFigure = !view.workspace?.selection.right && editorKey !== documentKey ? activeFigure : undefined
  const figure = previewFigure || baseFigure
  const displayedDoc = previewFigure ? previewDoc : activeDoc
  const figures: FlowGraph[] = displayedDoc ? eqTraceFlows(displayedDoc) : []
  const paperVisible = Boolean(figure)
  const exampleOpen = Boolean(previewRef?.example)
  const emptyBoard = (state: FlowState) => !!state.id && state.workspace === null && !state.loading && !state.error && !state.dirty && !state.blocked && !state.invalid
  const canAddExample = exampleOpen && previewRef?.version === view.version && emptyBoard(view)
  function addExample() {
    if (canAddExample && previewRef && controller.current(previewRef, true) && emptyBoard(controller.state() as FlowState)
      && controller.applyExternal(validateFlowWorkspace(attentionExample), previewRef)) setPreview(null)
  }
  function openFigure(ref: FlowRef, example = false) {
    setPreview({ ...controller.token(), ref, example })
  }
  function openDocument(id: string) {
    const workspace = controller.state().workspace as FlowWorkspace | null
    const doc = workspace?.documents.find(item => item.paper.id === id)
    const first = doc && eqTraceFlows(doc)[0]
    if (!first || !workspace) return
    const { left, right } = workspace.selection
    if (!right && left.documentId === id && left.flowId === first.id) {
      setEditorKey('')
      setPreview(null)
    } else {
      openFigure({ documentId: id, flowId: first.id })
    }
  }
  useEffect(() => {
    workbench.revealEditor = () => { setPreview(null); setEditorKey(documentKey) }
    return () => { delete workbench.revealEditor }
  }, [workbench, documentKey])
  const target = (ref: FlowRef, ids?: string[]): FlowTarget => ({ kind: 'flow', paper_id: ref.documentId, flow_id: ref.flowId, ...(ids?.length === 1 ? { node_id: ids[0] } : ids?.length ? { node_ids: ids } : {}) })
  useEffect(() => { if (view.workspace) context(target(view.workspace.selection.left)) }, [view.id, view.epoch, view.workspace?.selection.left.documentId, view.workspace?.selection.left.flowId])
  useEffect(() => () => { importSerial.current++ }, [])
  useEffect(() => { importSerial.current++; dragDepth.current = 0; setDropActive(false); setEmptyImport({ name: '', loading: false, error: '' }) }, [view.id, view.epoch, view.version])
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
      const parsed = JSON.parse(contents)
      const incoming = view.workspace && parsed?.kind === 'paper-flow-document' && eqTraceFlows(parsed).length
        ? addEqTraceDocument(view.workspace, parsed).workspace : validateFlowWorkspace(parsed)
      if (controller.applyExternal(incoming, owner)) setPreview(null)
      setEmptyImport({ name: file.name || 'JSON 文件', loading: false, error: '' })
    } catch (error: any) { if (current()) setEmptyImport({ name: '', loading: false, error: `无法导入：${error.message || error}` }) }
  }
  const reload = async () => {
    if ((view.dirty || view.blocked || view.invalid) && !window.confirm('重新读取将丢弃当前未保存草稿。请先备份；确定继续吗？')) return
    await controller.reload()
  }
  const dockNames = { compare: '比较', code: '代码与数据' }
  const eqDocuments = view.workspace?.documents.filter(doc => eqTraceFlows(doc).length) || []
  const header = <header className="board-flow-header">
      <button type="button" onClick={() => void close()}>← 返回画板</button>
      <strong title={view.title}>{view.title || '流程工作区'}</strong>
      <div className="board-flow-titles" ref={setTitlesHost} hidden={!view.workspace || paperVisible || view.loading} />
      <span className={`board-flow-status${view.blocked || view.invalid ? ' is-error' : ''}`} role="status">{status}</span>
      <div className="board-flow-local-panels" role="group" aria-label="流程侧栏">
        {(['compare','code'] as const).map(id => <button type="button" key={id} data-panel-toggle={id}
          aria-expanded={panel === id} aria-controls={`paper-flow-${id}-panel`} onClick={() => togglePanel(id)}>{dockNames[id]}</button>)}
      </div>
      <div className="board-flow-actions board-flow-host-tools" ref={hostTools}>
        {activeFigure && !previewRef && !view.workspace?.selection.right && <button type="button" onClick={() => setEditorKey(paperVisible ? documentKey : '')}>{paperVisible ? '编辑流程' : '查看论文插图'}</button>}
        {previewRef && <button type="button" onClick={() => setPreview(null)}>返回原流程</button>}
        {!exampleOpen && <button type="button" onClick={() => openFigure({ documentId: attentionExample.paper.id, flowId: 'network' }, true)}>编码器–解码器示例</button>}
        {canAddExample && <button type="button" onClick={addExample}>将示例加入空画板</button>}
        <button type="button" disabled={!view.dirty || view.loading || view.invalid || view.blocked} onClick={() => void controller.flush()}>保存</button>
        {(view.blocked || view.invalid) && <button type="button" disabled={view.loading || view.invalid} onClick={() => void controller.flush({ retry: true })}>重试保存</button>}
        <button type="button" disabled={!view.workspace} onClick={() => backup(view.workspace)}>备份 JSON</button>
        <button type="button" disabled={view.loading || view.saving} onClick={() => void reload()}>重新读取</button>
      </div>
      {view.error && <p className="board-flow-error" role="alert">{view.error} {view.dirty && '草稿仍在当前页面，可备份后重试。'}</p>}
      {emptyImport.loading && <p className="board-flow-import-status" role="status">正在读取 {emptyImport.name}…</p>}
      {emptyImport.error && <p className="board-flow-error" role="alert">{emptyImport.error}</p>}
      <div className="board-flow-control-strip" role="group" aria-label="流程图控制" inert={view.loading || undefined} ref={setControlsHost} hidden={!view.workspace || paperVisible} />
      <div className="board-flow-control-strip eqtrace-controls" role="group" aria-label="插图控制" inert={view.loading || undefined} hidden={!paperVisible}>
        {figure && displayedDoc && <nav className="eqtrace-nav" aria-label="选择论文插图"><strong>{displayedDoc.paper.title}</strong>
          {figures.length > 1 && figures.map(item => <button key={item.id} type="button" aria-pressed={item.id === figure.id}
            onClick={() => {
              const ref = { documentId: displayedDoc.paper.id, flowId: item.id }
              if (previewRef) openFigure(ref, previewRef.example)
              else if (view.workspace) controller.edit({ ...view.workspace, selection: { left: ref } })
            }}>{item.id === 'network' ? '网络结构' : '训练流程'}</button>)}
        </nav>}
        <div className="eqtrace-figure-commands" ref={setFigureControls} />
      </div>
    </header>
  function closeDockOnEscape(event: ReactKeyboardEvent<HTMLElement>) {
    if (event.key !== 'Escape' || event.defaultPrevented) return
    event.preventDefault()
    event.stopPropagation()
    dismissPanel()
  }
  function dockHeader(id: Dock) {
    return <header className="board-flow-sidebar-header"><h2 id={`paper-flow-${id}-title`}>{dockNames[id]}</h2>
      <button type="button" aria-label={`收起${dockNames[id]}侧栏`} onClick={dismissPanel}>×</button></header>
  }
  return <section className="board-flow-host" aria-label="流程工作区" ref={setFullscreenHost}>
    {header}
    <input className="board-flow-import-input" ref={emptyFileInput} type="file" accept=".json,application/json" aria-label="导入流程 JSON" onChange={event => { const files = Array.from(event.currentTarget.files || []); event.currentTarget.value = ''; if (files.length) void choose(files) }} />
    <div className="board-flow-layout" inert={view.loading || undefined}>
    <div className="board-flow-content" data-paper-view={paperVisible || undefined}
      onDragEnter={event => { if (view.workspace && !paperVisible) return; event.preventDefault(); if (isFlowFileDrag(event.dataTransfer)) { dragDepth.current++; setDropActive(true) } }}
      onDragOver={event => { if (view.workspace && !paperVisible) return; event.preventDefault(); if (isFlowFileDrag(event.dataTransfer)) { event.dataTransfer.dropEffect = 'copy'; setDropActive(true) } }}
      onDragLeave={event => { if (view.workspace && !paperVisible) return; event.preventDefault(); if (--dragDepth.current <= 0) { dragDepth.current = 0; setDropActive(false) } }}
      onDrop={event => { if (view.workspace && !paperVisible) return; event.preventDefault(); event.stopPropagation(); dragDepth.current = 0; setDropActive(false); void choose(Array.from(event.dataTransfer.files)) }}>
      {(!view.workspace || paperVisible) && dropActive && <div className="paper-flow-drop-target" role="status"><strong>松开以导入 JSON</strong><span>一次一个文件，最大 192 KiB</span></div>}
      {baseFigure && activeDoc && <section className="eqtrace-main" aria-label="交互式论文插图" hidden={!!previewFigure}>
        <Figure key={JSON.stringify([view.id, view.epoch, activeDoc.paper.id, baseFigure.id])} flow={baseFigure} documentId={activeDoc.paper.id}
          dataHost={previewFigure ? null : dataHost} controlsHost={previewFigure ? null : figureControls} />
      </section>}
      {previewFigure && previewDoc && <section className="eqtrace-main" aria-label={exampleOpen ? '编码器–解码器示例' : '交互式论文插图'}>
        <Figure key={JSON.stringify([view.id, view.epoch, exampleOpen, previewDoc.paper.id, previewFigure.id])} flow={previewFigure} documentId={previewDoc.paper.id}
          dataHost={dataHost} controlsHost={figureControls} />
      </section>}
      {view.workspace ? <FlowErrorBoundary recoveryKey={`${view.id}:${view.version}`}><PaperFlowWorkbench ref={workbench} key={`${view.id}:${view.epoch}`} workspace={view.workspace}
        comparisonHost={comparisonHost} controlsHost={controlsHost} fullscreenHost={fullscreenHost}
        titlesHost={paperVisible || view.loading ? null : titlesHost}
        onWorkspaceChange={(next: FlowWorkspace) => {
          if (controller.edit(next, { id: view.id, epoch: view.epoch, version: view.version })) setPreview(null)
        }}
        prepareImport={(raw, parsed) => {
          const imported = typeof raw === 'string' ? JSON.parse(raw) : raw
          return imported?.kind === 'paper-flow-document' && eqTraceFlows(imported).length
            ? addEqTraceDocument(view.workspace, imported).workspace : parsed
        }}
        toolbar={<>{canSend && <button type="button" onClick={() => void send(view.workspace!.selection.left)}>流程放入 DSH</button>}<button type="button" onClick={() => void annotate(target(view.workspace!.selection.left))}>流程批注</button></>}
        onNodeSelect={contexts => { if (contexts[0]) context(target(contexts[0].ref, contexts[0].nodeIds)) }}
        renderNodeDetails={(_node, _graph, contexts) => <div className="board-flow-node-actions">{contexts.map(value => <div key={value.side}>
          {contexts.length > 1 && <strong>{value.side.toUpperCase()} 侧原流程</strong>}
          {canSend && <button type="button" onClick={() => void send(value.ref, value.nodeIds)}>节点与上下游放入 DSH</button>}
          <button type="button" onClick={() => void annotate(target(value.ref, value.nodeIds))}>批注此节点{value.nodeIds.length > 1 ? `组（${value.nodeIds.length}）` : ''}</button>
        </div>)}</div>} /></FlowErrorBoundary> : !paperVisible && <div className="board-flow-empty">
        <h2>开始整理流程</h2><p>导入流程或 EqTrace JSON 查看流程与论文插图，也可以从空白流程或教学示例开始。拖入的 JSON 文件最大 192 KiB。</p>
        <div><button type="button" onClick={() => controller.edit(starterWorkspace())}>新建流程</button><button type="button" onClick={() => emptyFileInput.current?.click()}>导入 JSON</button><button type="button" onClick={() => controller.edit(starterWorkspace(true))}>打开教学示例</button></div>
      </div>}
    </div>
    <aside className="board-flow-sidebar" id="paper-flow-compare-panel" aria-labelledby="paper-flow-compare-title" hidden={panel !== 'compare'}
      onKeyDown={closeDockOnEscape}
      onDragOver={event => { if (isFlowFileDrag(event.dataTransfer)) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy' } }}
      onDrop={event => {
        event.preventDefault()
        event.stopPropagation()
        const files = Array.from(event.dataTransfer.files)
        if (workbench.current) void workbench.current.importFiles(files)
        else void choose(files)
      }}>
      {dockHeader('compare')}
      <div className="board-flow-compare-fields" ref={setComparisonHost}/>
      {!view.workspace && <div className="board-flow-sidebar-section"><p>导入流程后可选择 A 和 B。</p>
        <button type="button" onClick={() => emptyFileInput.current?.click()}>导入 JSON</button></div>}
    </aside>
    <aside className="board-flow-sidebar" id="paper-flow-code-panel" aria-labelledby="paper-flow-code-title" hidden={panel !== 'code'}
      onKeyDown={closeDockOnEscape}>
      {dockHeader('code')}
      <div ref={setDataHost} className="board-flow-data-fields" />
      {generate && <section className="board-flow-sidebar-section"><h3>从源码生成</h3>
        <EqTraceSourceForm key={`${view.id}:${view.epoch}`} generate={generate} onGenerated={openDocument}/></section>}
      {eqDocuments.length > 0 && <label className="board-flow-sidebar-section">已有插图
        <select aria-label="选择 EqTrace 文档" value={figure && !exampleOpen ? displayedDoc?.paper.id : ''} onChange={e => openDocument(e.target.value)}>
          <option value="" disabled>选择文档</option>{eqDocuments.map(doc => <option key={doc.paper.id} value={doc.paper.id}>{doc.paper.title} · {doc.paper.id}</option>)}
        </select></label>}
      {!figure && <p className="board-flow-sidebar-note">打开网络插图后，可在这里关联实际输入。</p>}
    </aside>
    </div>
  </section>
}

function create({ root, api, toast, onClose, canGenerateEqTrace, prepareReturnToDsh, sendSnapshot, getSessionId, onCanvasContext, onAnnotations }: HostOptions) {
  const react = createRoot(root)
  const listeners = new Set<(value: FlowState) => void>()
  const subscribe = (listener: (value: FlowState) => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
  const controller = createFlowController({ api, validate: validateFlowWorkspace, onChange: (detail: FlowState) => listeners.forEach(listener => listener(detail)) })
  const unbindUnload = bindFlowUnloadGuard({ window, state: controller.state })
  let visible = false, disposed = false
  const workbench: WorkbenchRef = { current: null as PaperFlowWorkbenchHandle | null }
  const context = (target: FlowTarget) => { if (!disposed) onCanvasContext?.({ id: controller.state().id, target }) }
  const generate: GenerateEqTrace = async (read, active) => {
    const owner = controller.token()
    const check = () => {
      if (!active() || !visible || !controller.current(owner, true)) throw Error('工作区已切换或修改，请在当前画板重新生成。')
    }
    check()
    const files = await read()
    check()
    const document = await api('board_flow_eqtrace', { id: owner.id, ...files })
    check()
    const added = addEqTraceDocument(controller.state().workspace, document)
    if (!controller.applyExternal(added.workspace, owner)) throw Error('生成结果未载入，当前工作区已保留。')
    return added.documentId
  }
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
  const doc = root.ownerDocument
  let panel: Dock | null = null
  function publishPanels() {
    doc.dispatchEvent(new CustomEvent('paper-flow-panels-state', { detail: { open: visible, panel } }))
  }
  function renderPanel() {
    react.render(<Panel controller={controller} close={close} subscribe={subscribe} prepareReturnToDsh={prepareReturnToDsh}
      workbench={workbench} send={send} generate={canGenerateEqTrace ? generate : undefined} context={context} annotate={annotate}
      canSend={!!sendSnapshot} panel={panel} togglePanel={togglePanel} dismissPanel={dismissPanel} />)
  }
  function togglePanel(which: Dock) {
    if (!visible || disposed) return
    panel = panel === which ? null : which
    renderPanel()
    publishPanels()
  }
  function dismissPanel() {
    if (!panel) return
    const prev = panel
    togglePanel(prev)
    const native = doc.getElementById(`paper-flow-${prev}-toggle`)
    const trigger = native?.getClientRects().length ? native : root.querySelector<HTMLElement>(`[data-panel-toggle="${prev}"]`)
    trigger?.focus()
  }
  function fromToolbar(event: Event) {
    const which = (event as CustomEvent).detail?.panel
    if (which === 'compare' || which === 'code') togglePanel(which)
  }
  doc.addEventListener('paper-flow-panel-toggle', fromToolbar)
  async function close() {
    if (!visible || !await prepareLeave()) return false
    workbench.current?.exitFullscreen()
    controller.invalidatePending()
    visible = false; panel = null; root.hidden = true
    renderPanel(); publishPanels(); onClose()
    return true
  }
  renderPanel()
  root.hidden = true
  return {
    async open(options: OpenOptions) {
      if (disposed) return false
      const current = controller.state()
      if (visible && (current.id !== options.id || !current.dirty && !current.blocked && !current.invalid) && !await prepareLeave()) return false
      const ok = await controller.open(options)
      if (!ok) { toast(controller.state().error || '流程工作区尚未保存或读取失败。', true); return false }
      if (!visible || current.id !== options.id) panel = null
      visible = true; root.hidden = false; renderPanel(); publishPanels()
      return true
    },
    prepareLeave, close, isOpen: () => visible,
    focus(target: FlowTarget) { if (!visible || disposed) return false; workbench.revealEditor?.(); workbench.current?.focus({ documentId: target.paper_id, flowId: target.flow_id }, target.node_ids || (target.node_id ? [target.node_id] : [])); return true },
    dispose() {
      if (disposed) return
      disposed = true; visible = false; panel = null
      doc.removeEventListener('paper-flow-panel-toggle', fromToolbar)
      publishPanels(); unbindUnload(); controller.dispose(); react.unmount(); root.hidden = true
    },
  }
}

;(window as any).PaperBoardFlow = Object.freeze({ create, validateFlowWorkspace, createBoardAnnotationStore, handleBoardAnnotationRequest, normalizeBoardAnnotationRecord })
