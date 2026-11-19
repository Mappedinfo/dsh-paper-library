import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { FlowGraph } from '../../vendor/paper-flow/types'
import { TensorFigure } from './TensorFigure'
import { TensorDataInputs, type ObservedDimensions } from './TensorDataInputs'
import { downloadFile } from '../../vendor/paper-flow/canvas.js'
import { renderEqTraceFigure } from './eqtrace-figure.mjs'
import { readEqTraceSource } from './eqtrace-import.mjs'

type Source = { name: string; text: string }
export type GenerateEqTrace = (read: () => Promise<{ entry?: Source; model?: Source; class_name?: string }>, active: () => boolean) => Promise<string>
type FigureProps = { flow: FlowGraph; documentId: string; dataHost?: HTMLElement | null; controlsHost?: HTMLElement | null }

export function Figure(props: FigureProps) {
  return <FigureView key={JSON.stringify([props.documentId, props.flow.id])} {...props}/>
}

function FigureView({ flow, documentId, dataHost, controlsHost }: FigureProps) {
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
  const controls = <>
    {flow.figure_overview != null && <label className="eqtrace-projection">图中显示 <select value={detail} onChange={event => setDetail(event.target.value as 'overview' | 'full')}>
      <option value="overview">源码阶段总览</option><option value="full">全部节点</option></select></label>}
    {rendered.svg && <div className="eqtrace-figure-tools"><span>{overview ? `阶段总览 · 原流程 ${flow.nodes.length} 个节点` : `${flow.nodes.length} 个节点 · ${flow.edges.length} 条连接`} · {Math.round(width)} × {Math.round(height)} mm</span>
      <button type="button" onClick={() => downloadFile(`${documentId}-${flow.id}${overview ? '-overview' : ''}.svg`, rendered.svg, 'image/svg+xml')}>下载论文 SVG</button></div>}
    {!!diagnostics.length && <details><summary>{diagnostics.length} 条静态解析说明</summary><ul>{diagnostics.map((item, i) => <li key={i}>{String(item?.message || item?.code || item)} {typeof item?.evidence === 'string' && <code>{item.evidence}</code>}</li>)}</ul></details>}
  </>
  return <>
    {controlsHost ? createPortal(controls, controlsHost) : controls}
    <TensorDataInputs flow={flow} onChange={setObserved} host={dataHost}/>
    {rendered.error && <p role="alert">{rendered.error}</p>}
    {width > 185 && <p>此图原宽 {Math.round(width)} mm，缩至 180 mm 时字号会按比例缩小。</p>}
    {rendered.svg && <>
      <p className="eqtrace-tensor-hint">悬停、聚焦或轻点节点可查看张量形状。</p>
      <TensorFigure key={detail} examples={flow.example_dimensions} meanings={flow.example_dimension_meanings} observed={observed} imported={flow.observed_dimensions} svg={rendered.svg} name={flow.name} nodes={overview ? (flow.figure_overview as FlowGraph).nodes : flow.nodes}/>
    </>}
  </>
}

export function EqTraceSourceForm({ generate, onGenerated }: {
  generate: GenerateEqTrace
  onGenerated?: (documentId: string) => void
}) {
  const [entry, setEntry] = useState<File>(), [model, setModel] = useState<File>()
  const [className, setClassName] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const form = useRef<HTMLFormElement>(null), ticket = useRef(0)
  useEffect(() => () => { ticket.current++ }, [])

  async function run() {
    if ((!entry && !model) || busy) return
    const serial = ++ticket.current, active = () => ticket.current === serial
    setBusy(true); setError('')
    try {
      const nextId = await generate(async () => {
        const [training, network] = await Promise.all([readEqTraceSource(entry), readEqTraceSource(model)])
        return { entry: training, model: network, class_name: className.trim() || undefined }
      }, active)
      if (!active()) return
      form.current?.reset()
      setEntry(undefined); setModel(undefined); setClassName('')
      onGenerated?.(nextId)
    } catch (cause) { if (active()) setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { if (active()) setBusy(false) }
  }

  return <form ref={form} className="eqtrace-form" onSubmit={event => { event.preventDefault(); void run() }}>
    <p>选择训练入口或模型定义，生成静态流程。两个角色可使用同一个文件。每个 .py 文件最多 256 KiB。</p>
    <label>训练入口<input type="file" accept=".py" disabled={busy} onChange={event => { setEntry(event.target.files?.[0]); setError('') }} /></label>
    <label>模型定义<input type="file" accept=".py" disabled={busy} onChange={event => { setModel(event.target.files?.[0]); setError('') }} /></label>
    <label>模型类或方法（可选）<input type="text" disabled={busy} value={className} placeholder="MyModel 或 MyModel.forward" onChange={event => setClassName(event.target.value)} /></label>
    <button type="submit" disabled={busy || (!model && !entry)}>{busy ? '正在解析…' : '生成流程'}</button>
    {error && <p className="board-flow-error" role="alert">{error}</p>}
  </form>
}
