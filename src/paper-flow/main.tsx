/// <reference path="./inline-css.d.ts" />
import { Component, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { PaperFlowWorkbench } from '../../vendor/paper-flow/index'
import type { FlowWorkspace } from '../../vendor/paper-flow/types'
import { createFlowController } from './controller.mjs'
import { starterWorkspace } from './starter.mjs'
import { bindFlowUnloadGuard } from './unload.mjs'
import { FLOW_LIMITS, validateFlowWorkspace } from './validation.mjs'
import './host.css'

type HostOptions = { root: HTMLElement; api(action: string, args: object): Promise<any>; toast(message: string, error?: boolean): void; onClose(): void; prepareReturnToDsh?: () => Promise<boolean> }
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

function Panel({ controller, close, subscribe, prepareReturnToDsh }: { controller: ReturnType<typeof createFlowController>; close(): Promise<boolean>; subscribe(listener: (value: FlowState) => void): () => void; prepareReturnToDsh?: () => Promise<boolean> }) {
  const [view, setView] = useState<FlowState>(() => controller.state() as FlowState)
  const hostTools = useRef<HTMLDivElement>(null)
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
  const choose = async (file: File | undefined) => {
    if (!file) return
    const owner = controller.token()
    try {
      if (file.size > FLOW_LIMITS.workspaceBytes) throw Error('JSON 超过工作区大小上限。')
      const contents = await file.text()
      if (!controller.current(owner, true)) return
      controller.applyExternal(validateFlowWorkspace(contents), owner)
    } catch (error: any) { if (controller.current(owner, true)) window.alert(`无法导入：${error.message || error}`) }
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
    <div className="board-flow-content" inert={view.loading || undefined}>
      {view.workspace ? <FlowErrorBoundary recoveryKey={`${view.id}:${view.version}`}><PaperFlowWorkbench key={`${view.id}:${view.epoch}`} workspace={view.workspace} onWorkspaceChange={(next: FlowWorkspace) => controller.edit(next, { id: view.id, epoch: view.epoch, version: view.version })} /></FlowErrorBoundary> : <div className="board-flow-empty">
        <h2>开始整理流程</h2><p>新建一份流程、导入已有 JSON，或先打开不含研究资料的教学示例。</p>
        <div><button type="button" onClick={() => controller.edit(starterWorkspace())}>新建流程</button><label className="board-flow-import">导入 JSON<input type="file" accept=".json,application/json" onChange={event => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; void choose(file) }} /></label><button type="button" onClick={() => controller.edit(starterWorkspace(true))}>打开教学示例</button></div>
      </div>}
    </div>
  </section>
}

function create({ root, api, toast, onClose, prepareReturnToDsh }: HostOptions) {
  const react = createRoot(root)
  const listeners = new Set<(value: FlowState) => void>()
  const subscribe = (listener: (value: FlowState) => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
  const controller = createFlowController({ api, validate: validateFlowWorkspace, onChange: (detail: FlowState) => listeners.forEach(listener => listener(detail)) })
  const unbindUnload = bindFlowUnloadGuard({ window, state: controller.state })
  let visible = false, disposed = false
  async function prepareLeave() {
    if (disposed) return false
    const views = [...root.querySelectorAll<HTMLElement>('.paper-flow-canvas')].map(node => node.shadowRoot?.querySelector<HTMLElement>('.graph-wrap')).filter(Boolean) as HTMLElement[]
    for (const view of views) view.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, composed: true }))
    if (views.length) await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
    const ok = await controller.prepareLeave(); if (!ok) toast('流程草稿尚未保存，请先重试或备份。', true); return ok
  }
  async function close() { if (!visible || !await prepareLeave()) return false; controller.invalidatePending(); visible = false; root.hidden = true; onClose(); return true }
  react.render(<Panel controller={controller} close={close} subscribe={subscribe} prepareReturnToDsh={prepareReturnToDsh} />)
  root.hidden = true
  return {
    async open(options: OpenOptions) { if (disposed) return false; const current = controller.state(); if (visible && (current.id !== options.id || !current.dirty && !current.blocked && !current.invalid) && !await prepareLeave()) return false; const ok = await controller.open(options); if (!ok) { toast(controller.state().error || '流程工作区尚未保存或读取失败。', true); return false } visible = true; root.hidden = false; return true },
    prepareLeave, close, isOpen: () => visible,
    dispose() { if (disposed) return; disposed = true; unbindUnload(); controller.dispose(); react.unmount(); root.hidden = true },
  }
}

;(window as any).PaperBoardFlow = Object.freeze({ create, validateFlowWorkspace })
