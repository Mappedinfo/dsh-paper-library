import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import DOMPurify from 'dompurify'
import type { FlowNode } from '../../vendor/paper-flow/types'
import { nodeTensorPreview, tensorDimensionContext, bindTensorShape, boundAxisLabel, shapeSketch, tileCount } from './tensor-preview.mjs'
import type { ObservedDimensions } from './TensorDataInputs'

type TensorItem = { name: string; kind?: string; shape: (string | number)[] | null; note: string }
type DimensionProps = { examples?: unknown; meanings?: unknown; observed?: ObservedDimensions; imported?: unknown }
type DimensionContext = ReturnType<typeof tensorDimensionContext>
type Selected = { node: FlowNode; target: SVGGElement; pinned: boolean }
const svgTags = ['svg', 'g', 'title', 'desc', 'defs', 'marker', 'rect', 'path', 'text', 'tspan', 'line', 'circle', 'ellipse', 'polygon', 'polyline']
const svgAttrs = ['id', 'xmlns', 'viewBox', 'width', 'height', 'x', 'y', 'x1', 'x2', 'y1', 'y2', 'dx', 'dy', 'rx', 'ry', 'cx', 'cy', 'r', 'points', 'd', 'transform', 'text-anchor', 'dominant-baseline', 'font-size', 'font-weight', 'font-family', 'fill', 'fill-opacity', 'stroke', 'stroke-opacity', 'stroke-width', 'stroke-dasharray', 'stroke-linejoin', 'stroke-linecap', 'marker-end', 'markerWidth', 'markerHeight', 'refX', 'refY', 'orient', 'markerUnits', 'data-node', 'data-edge', 'data-x', 'data-y', 'data-shape', 'data-module']

function Shape({ item, context }: { item: TensorItem; context: DimensionContext }) {
  const original = shapeSketch(item.shape, item.kind)
  const bound = bindTensorShape(item.shape, context)
  const { kind, axes, prefix, open, label } = shapeSketch(bound.shape, item.kind)
  const axisLabel = (axis: unknown) => boundAxisLabel(axis, context)
  const sourceLabel = context.mode === 'actual' ? '实际输入' : '示例输入'
  const last = axes.at(-1), previous = axes.at(-2)
  const vector = kind === 'vector'
  const finiteSlices = !open && prefix.every((axis: unknown) => typeof axis === 'number')
  const planes = finiteSlices ? Math.min(3, prefix.reduce((size: number, axis: number) => size * axis, 1)) : 3
  const rows = vector ? 1 : tileCount(previous), columns = tileCount(last)
  return <li className="eqtrace-tensor-item" data-shape-kind={kind}>
    <div className="eqtrace-tensor-item-heading"><span>{item.name}</span><code>{original.label}</code></div>
    {bound.hasSymbols && bound.changed && <div className="eqtrace-tensor-substitution"><span>{sourceLabel}</span><code>→ {label}</code></div>}
    {kind === 'scalar' && <div className="eqtrace-tensor-scalar"><i aria-hidden="true" />标量 · 0 轴</div>}
    {kind === 'empty' && <div className="eqtrace-tensor-explain">含长度为 0 的轴</div>}
    {kind === 'open' && <div className="eqtrace-tensor-explain">前导轴数量未知</div>}
    {['vector', 'matrix', 'slices'].includes(kind) && <div className="eqtrace-tensor-sketch">
      <svg viewBox="0 0 82 47" aria-hidden="true" focusable="false">
        {kind === 'slices' && <g className="eqtrace-slice-planes">{planes >= 3 && <rect x="14" y="2" width="64" height="31" rx="2"/>}{planes >= 2 && <rect x="9" y="7" width="64" height="31" rx="2"/>}</g>}
        <g transform={vector ? 'translate(3 17)' : 'translate(3 12)'}>
          {Array.from({ length: rows * columns }, (_, i) => <rect key={i} x={i % columns * 64 / columns} y={Math.floor(i / columns) * 30 / rows} width={64 / columns} height={vector ? 11 : 30 / rows} className="eqtrace-tensor-cell"/>)}
        </g>
      </svg>
      <div>{open && <span>前导轴数未定</span>}
        {kind === 'slices' && prefix.length > 0 && <span>切片索引轴 · {original.prefix.map(axisLabel).join('，')}</span>}
        {vector ? <span>{open ? '末轴' : '向量轴'} · {axisLabel(original.axes.at(-1))}</span> : <><span>行轴 · {axisLabel(original.axes.at(-2))}</span><span>列轴 · {axisLabel(original.axes.at(-1))}</span></>}
      </div>
    </div>}
    {item.note && <div className="eqtrace-tensor-explain">{item.note}</div>}
  </li>
}

function Contents({ node, examples, meanings, observed, imported }: { node: FlowNode } & DimensionProps) {
  const tensor = nodeTensorPreview(node)
  const context = tensorDimensionContext(tensor, examples, meanings, observed, imported)
  const symbols = [...context.bindings.values()]
  const status = ({ inferred: '静态推导', partial: '部分已知', unknown: '形状未知', not_applicable: '不涉及张量' } as Record<string, string>)[tensor.status]
  const lists: [string, TensorItem[]][] = [['输入', tensor.inputs], ['输出', tensor.outputs], ['参数', tensor.parameters]]
  const hasShape = lists.some(([, items]) => items.some(item => Array.isArray(item.shape)))
  return <>
    <header><strong>{node.label}</strong><span>{status}</span></header>
    {!!symbols.length && <section className="eqtrace-dimension-bindings" aria-label="本节点的维度符号">
      <h4>{context.mode === 'actual' ? '实际输入' : symbols.some(s => s.value !== undefined) ? '示例输入' : '维度符号'}</h4>
      <ul>{symbols.map(s => <li key={s.name}><code>{s.name} = {s.value ?? '未指定'}</code>{s.meaning && <span>{s.meaning}</span>}{s.source && <small>{s.source}</small>}</li>)}</ul>
      {context.mode === 'actual' && <p>{symbols.some(s => s.source) ? (context.imported ? '轴值取自文档的实际输入记录，节点张量形状按源码推导。' : '轴值取自输入文件，节点张量形状按源码推导。') : '本节点的符号尚无实际输入尺寸。'}</p>}
    </section>}
    {tensor.status !== 'not_applicable' && lists.map(([label, items]) => !!items.length && <section key={label} aria-label={label}>
      <h4>{label}</h4><ul>{items.map((item, index) => <Shape key={index} item={item} context={context}/>)}</ul>
    </section>)}
    {tensor.note && <p>{tensor.note}</p>}
    {tensor.status === 'unknown' && !tensor.note && !lists.some(([, items]) => items.length) && <p>源码未提供可确定的张量形状。</p>}
    {hasShape && <footer>网格仅示意形状，无张量数值。</footer>}
  </>
}

/** 给本地渲染器的 SVG 副本接入节点交互；导出继续使用原始 SVG。 */
export function TensorFigure({ svg, name, nodes, examples, meanings, observed, imported }: { svg: string; name: string; nodes: FlowNode[] } & DimensionProps) {
  const surface = useRef<HTMLDivElement>(null), tip = useRef<HTMLDivElement>(null)
  const tooltipId = useId(), markerId = 'eqtrace-arrow-' + tooltipId.replace(/[^a-zA-Z0-9_-]/g, '')
  const [selected, setSelected] = useState<Selected | null>(null)
  const [portal, setPortal] = useState<HTMLElement | null>(null)
  const delay = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const byId = useMemo(() => new Map(nodes.map(n => [n.id, n])), [nodes])
  function cancelDelay() { clearTimeout(delay.current) }
  function dismissSoon() {
    cancelDelay()
    delay.current = setTimeout(() => setSelected(current => current?.pinned ? current : null), 160)
  }
  useLayoutEffect(() => {
    const host = surface.current
    if (!host) return
    // The controller only accepts SVG generated by renderEqTraceFigure. Keep an
    // SVG-only allowlist here as a second boundary before attaching live nodes.
    const fragment = DOMPurify.sanitize(svg, { ALLOWED_TAGS: svgTags, ALLOWED_ATTR: svgAttrs, ALLOW_DATA_ATTR: false, RETURN_DOM_FRAGMENT: true })
    const drawing = fragment.querySelector('svg')
    if (!drawing) return
    drawing.setAttribute('role', 'group')
    drawing.setAttribute('aria-label', name)
    const marker = drawing.querySelector('marker[id="arrow"]')
    marker?.setAttribute('id', markerId)
    drawing.querySelectorAll('[marker-end="url(#arrow)"]').forEach(path => path.setAttribute('marker-end', 'url(#' + markerId + ')'))
    for (const group of drawing.querySelectorAll<SVGGElement>('g[data-node]')) {
      const node = byId.get(group.getAttribute('data-node') || '')
      if (!node) continue
      group.setAttribute('tabindex', '0')
      group.setAttribute('role', 'button')
      group.setAttribute('aria-label', node.label + '，查看张量形状')
      group.querySelector('title')?.remove()
    }
    host.replaceChildren(drawing)
    setPortal(host.parentElement)
    setSelected(null)
    return () => { cancelDelay(); host.replaceChildren() }
  }, [svg, name, byId, markerId])

  useLayoutEffect(() => {
    if (!selected || !portal || !tip.current) return
    const target = selected.target, box = tip.current
    target.setAttribute('data-tensor-active', '')
    target.setAttribute('aria-describedby', tooltipId)
    function position() {
      if (!portal) return
      const root = portal.getBoundingClientRect(), node = target.getBoundingClientRect()
      const topEdge = Math.max(root.top, 0), leftEdge = Math.max(root.left, 0)
      const bottom = Math.min(root.bottom, window.innerHeight), right = Math.min(root.right, window.innerWidth)
      const gap = 6, clamp = (n: number, a: number, b: number) => Math.max(a, Math.min(n, b))
      box.style.maxHeight = Math.max(80, Math.min(350, bottom - topEdge - 18)) + 'px'
      const rect = box.getBoundingClientRect()
      const x = node.right + gap + rect.width <= right ? node.right + gap : node.left - gap - rect.width
      const y = node.top + rect.height <= bottom ? node.top : bottom - rect.height - gap
      box.style.left = clamp(x, leftEdge + gap, right - rect.width - gap) - root.left + 'px'
      box.style.top = clamp(y, topEdge + gap, bottom - rect.height - gap) - root.top + 'px'
    }
    position()
    const observer = new ResizeObserver(position)
    observer.observe(portal); observer.observe(box)
    window.addEventListener('scroll', position, true)
    window.addEventListener('resize', position)
    return () => { target.removeAttribute('data-tensor-active'); target.removeAttribute('aria-describedby'); observer.disconnect(); window.removeEventListener('scroll', position, true); window.removeEventListener('resize', position) }
  }, [selected, portal, tooltipId])

  useEffect(() => {
    if (!selected) return
    function outside(e: PointerEvent) {
      if (e.target instanceof Node && !surface.current?.contains(e.target) && !tip.current?.contains(e.target)) setSelected(null)
    }
    window.addEventListener('pointerdown', outside, true)
    return () => window.removeEventListener('pointerdown', outside, true)
  }, [selected])

  function hit(target: EventTarget | null) {
    if (!(target instanceof Element)) return null
    const group = target.closest<SVGGElement>('g[data-node]')
    const node = byId.get(group?.getAttribute('data-node') || '')
    return node && group && surface.current?.contains(group) ? { node, target: group } : null
  }
  function select(target: EventTarget | null, pin = false) {
    const found = hit(target)
    if (!found) return
    cancelDelay()
    setSelected(current => {
      if (pin && current?.pinned && current.target === found.target) return null
      if (!pin && current?.target === found.target) return current
      return { ...found, pinned: pin }
    })
  }
  return <div className="eqtrace-paper" data-eqtrace-tensor-figure=""
    onKeyDown={event => {
      if (event.key === 'Escape' && selected) { event.preventDefault(); event.stopPropagation(); setSelected(null) }
      else if (selected && tip.current && hit(event.target)?.target === selected.target && tip.current.scrollHeight > tip.current.clientHeight && ['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp'].includes(event.key)) {
        event.preventDefault()
        const distance = event.key.startsWith('Page') ? tip.current.clientHeight : 32
        tip.current.scrollBy({ top: event.key.endsWith('Down') ? distance : -distance })
      }
      else if (hit(event.target) && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); select(event.target, true) }
    }}>
    <div className="eqtrace-figure-surface" ref={surface}
      onPointerOver={event => { if (event.pointerType !== 'touch' && hit(event.relatedTarget)?.target !== hit(event.target)?.target) select(event.target) }}
      onPointerOut={event => { if (event.pointerType !== 'touch' && hit(event.target) && !hit(event.relatedTarget)) dismissSoon() }}
      onFocus={event => select(event.target)} onBlur={event => { if (!hit(event.relatedTarget)) dismissSoon() }}
      onClick={event => { if (hit(event.target)) select(event.target, true); else setSelected(null) }} />
    {selected && portal && createPortal(<div ref={tip} id={tooltipId} role="tooltip" className="eqtrace-tensor-tooltip" data-tensor-node={selected.node.id}
      onPointerEnter={cancelDelay} onPointerLeave={dismissSoon}><Contents node={selected.node} examples={examples} meanings={meanings} observed={observed} imported={imported}/></div>, portal)}
  </div>
}
