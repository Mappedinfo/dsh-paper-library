import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { FlowGraph, FlowWorkspace } from '../../vendor/paper-flow/types'
import { TensorFigure } from './TensorFigure'
import { TensorDataInputs, type ObservedDimensions } from './TensorDataInputs'
import { FlowWindow } from '../../vendor/paper-flow/FlowWindow'
import { downloadFile } from '../../vendor/paper-flow/canvas.js'
import { eqTraceFlows, renderEqTraceFigure } from './eqtrace-figure.mjs'
import { readEqTraceSource } from './eqtrace-import.mjs'

type Source = { name: string; text: string }
export type GenerateEqTrace = (read: () => Promise<{ entry?: Source; model?: Source; class_name?: string }>, active: () => boolean) => Promise<string>

export function Figure({ flow, documentId }: { flow: FlowGraph; documentId: string }) {
  const [observed, setObserved] = useState<ObservedDimensions>({})
  const [detail, setDetail] = useState<'overview' | 'full'>('overview')
  const overview = flow.figure_overview != null && detail === 'overview'
  const rendered = useMemo(() => {
    try { return { svg: renderEqTraceFigure(flow, { detail }), error: '' } }
    catch (error) { return { svg: '', error: error instanceof Error ? error.message : String(error) } }
  }, [flow, detail])
  const width = Number(rendered.svg.match(/width="([0-9.]+)mm"/)?.[1] || 0)
  const height = Number(rendered.svg.match(/height="([0-9.]+)mm"/)?.[1] || 0)
  const diagnostics = Array.isArray(flow.diagnostics) ? flow.diagnostics : []
  return <>
    {flow.figure_overview != null && <label className="eqtrace-projection">图中显示 <select value={detail} onChange={event => setDetail(event.target.value as 'overview' | 'full')}>
      <option value="overview">源码阶段总览</option><option value="full">全部节点</option></select></label>}
    <TensorDataInputs flow={flow} onChange={setObserved}/>
    {rendered.error && <p role="alert">{rendered.error}</p>}
    {rendered.svg && <div className="eqtrace-figure-tools"><span>{overview ? `阶段总览 · 原流程 ${flow.nodes.length} 个节点` : `${flow.nodes.length} 个节点 · ${flow.edges.length} 条连接`} · {Math.round(width)} × {Math.round(height)} mm</span>
      <button type="button" onClick={() => downloadFile(`${documentId}-${flow.id}${overview ? '-overview' : ''}.svg`, rendered.svg, 'image/svg+xml')}>下载论文 SVG</button></div>}
    {width > 185 && <p>此图原宽 {Math.round(width)} mm，缩至 180 mm 时字号会按比例缩小。</p>}
    {!!diagnostics.length && <details><summary>{diagnostics.length} 条静态解析说明</summary><ul>{diagnostics.map((item, i) => <li key={i}>{String(item?.message || item?.code || item)} {typeof item?.evidence === 'string' && <code>{item.evidence}</code>}</li>)}</ul></details>}
    {rendered.svg && <>
      <p className="eqtrace-tensor-hint">悬停、聚焦或轻点节点可查看张量形状。</p>
      <TensorFigure key={detail} examples={flow.example_dimensions} meanings={flow.example_dimension_meanings} observed={observed} imported={flow.observed_dimensions} svg={rendered.svg} name={flow.name} nodes={overview ? (flow.figure_overview as FlowGraph).nodes : flow.nodes}/>
    </>}
  </>
}

export function EqTracePanel({ workspace, generate, sourceOnly = false }: { workspace: FlowWorkspace | null; generate?: GenerateEqTrace; sourceOnly?: boolean }) {
  const documents = workspace?.documents.filter(doc => eqTraceFlows(doc).length) || []
  const [selected, setSelected] = useState(''), [flowId, setFlowId] = useState('')
  const doc = documents.find(item => item.paper.id === selected) || documents.find(item => item.paper.id === workspace?.selection.left.documentId) || documents.at(-1)
  const flows: FlowGraph[] = doc ? eqTraceFlows(doc) : []
  const flow = flows.find(item => item.id === flowId) || flows.find(item => item.id === workspace?.selection.left.flowId) || flows[0]
  const [open, setOpen] = useState(false), [sourceForm, setSourceForm] = useState(false)
  const [entry, setEntry] = useState<File>(), [model, setModel] = useState<File>(), [className, setClassName] = useState('')
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const id = useId(), trigger = useRef<HTMLButtonElement>(null), ticket = useRef(0)
  useEffect(() => () => { ticket.current++ }, [])
  if (!generate && (sourceOnly || !doc)) return null
  const showForm = generate && (sourceOnly || sourceForm || !doc)
  function close() {
    ticket.current++; setBusy(false); setOpen(false); setEntry(undefined); setModel(undefined); setError('')
    trigger.current?.focus()
  }
  async function run() {
    if (!generate || (!entry && !model) || busy) return
    const serial = ++ticket.current, active = () => ticket.current === serial
    setBusy(true); setError('')
    try {
      const nextId = await generate(async () => {
        const [training, network] = await Promise.all([readEqTraceSource(entry), readEqTraceSource(model)])
        return { entry: training, model: network, class_name: className.trim() || undefined }
      }, active)
      if (!active()) return
      setSelected(nextId); setFlowId(''); setSourceForm(false)
      setEntry(undefined); setModel(undefined); setClassName('')
      if (sourceOnly) close()
    } catch (cause) { if (active()) setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { if (active()) setBusy(false) }
  }
  return <>
    <button ref={trigger} type="button" aria-controls={id} aria-expanded={open} onClick={() => setOpen(true)}>{sourceOnly ? '从源码生成' : doc ? 'EqTrace 论文插图' : 'EqTrace 代码成图'}</button>
    <FlowWindow id={id} kind="eqtrace" title="EqTrace 代码与论文插图" open={open}
      onClose={close}>
      {showForm ? <form className="eqtrace-form" onSubmit={event => { event.preventDefault(); void run() }}>
        <p>选择训练入口或模型定义，生成静态流程。两个角色可使用同一个文件。每个 .py 文件最多 256 KiB。</p>
        <label>训练入口<input type="file" accept=".py" disabled={busy} onChange={event => { setEntry(event.target.files?.[0]); setError('') }} /></label>
        <label>模型定义<input type="file" accept=".py" disabled={busy} onChange={event => { setModel(event.target.files?.[0]); setError('') }} /></label>
        <label>模型类或方法（可选）<input type="text" disabled={busy} value={className} placeholder="MyModel 或 MyModel.forward" onChange={event => setClassName(event.target.value)} /></label>
        <div><button type="submit" disabled={busy || (!model && !entry)}>{busy ? '正在解析…' : '生成流程'}</button>
        {sourceOnly ? <button type="button" disabled={busy} onClick={close}>取消</button> : doc && <button type="button" disabled={busy} onClick={() => { setSourceForm(false); setEntry(undefined); setModel(undefined) }}>返回插图</button>}</div>
        {error && <p className="board-flow-error" role="alert">{error}</p>}
      </form> : doc && flow && <>
        <div className="eqtrace-nav">
          {documents.length > 1 && <label>文档 <select value={doc.paper.id} onChange={event => { setSelected(event.target.value); setFlowId('') }}>{documents.map(item => <option key={item.paper.id} value={item.paper.id}>{item.paper.title} · {item.paper.id}</option>)}</select></label>}
          <div role="group" aria-label="论文插图">{flows.map(item => <button key={item.id} type="button" aria-pressed={flow.id === item.id} onClick={() => setFlowId(item.id)}>{item.id === 'network' ? '神经网络结构' : '训练流程'}</button>)}</div>
          {generate && <button type="button" onClick={() => { setSourceForm(true); setError('') }}>从源码生成</button>}
        </div>
        <Figure key={`${doc.paper.id}-${flow.id}`} flow={flow} documentId={doc.paper.id} />
      </>}
    </FlowWindow>
  </>
}
