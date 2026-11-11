import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent } from 'react'
import { Scan, ScanLine } from 'lucide-react'
import { useEditor, ZOOM_MAX, ZOOM_MIN } from '../store'
import { clamp } from '../core/geometry'
import { useT } from '../i18n'
import { SlideSurface } from './SlideSurface'

const origin = { x: 0, y: 0 }

export function CanvasViewport({ shortcuts = true }: { shortcuts?: boolean }) {
  const slide = useEditor(state => state.document.slides[state.activeSlidePath])
  const canvas = useEditor(state => state.document.deck.canvas)
  const scope = useEditor(state => state.briefScope)
  const zoom = useEditor(state => state.zoom)
  const hasSelection = useEditor(state => state.selectedIds.length > 0)
  const { t } = useT()
  const scroller = useRef<HTMLDivElement>(null)
  const surface = useRef<HTMLDivElement>(null)
  const pan = useRef<{ id: number; x: number; y: number; left: number; top: number } | null>(null)
  const anchor = useRef<{ x: number; y: number } | null>(null)
  const [offset, setOffset] = useState(origin)
  const [space, setSpace] = useState(false)
  const [panning, setPanning] = useState(false)
  const autoFit = useRef(true)

  const focusView = useCallback((selection: boolean) => {
    const view = scroller.current
    if (!view) return
    const state = useEditor.getState()
    const { width, height } = state.document.deck.canvas
    const pad = getComputedStyle(view)
    const availableWidth = view.clientWidth - parseFloat(pad.paddingLeft) - parseFloat(pad.paddingRight)
    const availableHeight = view.clientHeight - parseFloat(pad.paddingTop) - parseFloat(pad.paddingBottom)
    if (availableWidth <= 0 || availableHeight <= 0) return

    if (!selection) {
      autoFit.current = true
      anchor.current = null
      setOffset(origin)
      view.scrollTo(0, 0)
      state.setZoom(Math.min(availableWidth / width, availableHeight / height, .9))
      return
    }
    const selected = new Set(state.selectedIds)
    const frames = state.document.slides[state.activeSlidePath].elements.filter(element => selected.has(element.id)).map(element => element.frame)
    if (!frames.length) return
    const left = Math.min(...frames.map(frame => frame.x))
    const top = Math.min(...frames.map(frame => frame.y))
    const right = Math.max(...frames.map(frame => frame.x + frame.w))
    const bottom = Math.max(...frames.map(frame => frame.y + frame.h))
    autoFit.current = false
    anchor.current = { x: (left + right) / 2, y: (top + bottom) / 2 }
    const next = clamp(Math.min(availableWidth / (right - left), availableHeight / (bottom - top)), ZOOM_MIN, ZOOM_MAX)
    if (state.zoom === next) {
      const rect = surface.current?.getBoundingClientRect()
      const viewport = view.getBoundingClientRect()
      if (rect) {
        const x = viewport.left + view.clientWidth / 2 - rect.left - anchor.current.x * next
        const y = viewport.top + view.clientHeight / 2 - rect.top - anchor.current.y * next
        setOffset(previous => ({ x: previous.x + x, y: previous.y + y }))
      }
      anchor.current = null
    } else state.setZoom(next)
  }, [])

  useLayoutEffect(() => {
    const view = scroller.current
    const rect = surface.current?.getBoundingClientRect()
    if (!anchor.current || !view || !rect) return
    const viewport = view.getBoundingClientRect()
    const { x, y } = anchor.current
    anchor.current = null
    setOffset(previous => ({
      x: previous.x + viewport.left + view.clientWidth / 2 - rect.left - x * zoom,
      y: previous.y + viewport.top + view.clientHeight / 2 - rect.top - y * zoom,
    }))
  }, [zoom])

  useEffect(() => {
    const view = scroller.current
    if (!view) return
    focusView(false)
    const observer = new ResizeObserver(() => { if (autoFit.current) focusView(false) })
    observer.observe(view)
    return () => observer.disconnect()
  }, [scope, canvas.width, canvas.height, focusView])

  useEffect(() => {
    const stop = () => {
      pan.current = null
      setSpace(false)
      setPanning(false)
    }
    if (!shortcuts) { stop(); return }
    const down = (event: KeyboardEvent) => {
      const target = event.target
      if (event.defaultPrevented || !(target instanceof HTMLElement) ||
        target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]')) return
      if (event.code === 'Space' && (!target.closest('button, a') || scroller.current?.matches(':hover')) && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault()
        setSpace(true)
      }
      if (event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey && ['Digit1', 'Digit2'].includes(event.code)) {
        event.preventDefault()
        focusView(event.code === 'Digit2')
      }
    }
    const up = (event: KeyboardEvent) => { if (event.code === 'Space') setSpace(false) }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', stop)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', stop)
    }
  }, [focusView, shortcuts])

  function startPan(event: PointerEvent<HTMLDivElement>) {
    if (!shortcuts || (!space && event.button !== 1) || (event.button !== 0 && event.button !== 1)) return
    event.preventDefault()
    event.stopPropagation()
    autoFit.current = false
    pan.current = { id: event.pointerId, x: event.clientX, y: event.clientY, left: offset.x, top: offset.y }
    event.currentTarget.setPointerCapture(event.pointerId)
    setPanning(true)
  }
  function movePan(event: PointerEvent<HTMLDivElement>) {
    const start = pan.current
    if (start?.id !== event.pointerId) return
    setOffset({ x: start.left + event.clientX - start.x, y: start.top + event.clientY - start.y })
  }
  function endPan(event: PointerEvent<HTMLDivElement>) {
    if (pan.current?.id !== event.pointerId) return
    pan.current = null
    setPanning(false)
  }

  return <>
    <div ref={scroller} className="canvas-scroller" data-pan={panning ? 'active' : space ? 'ready' : undefined}
      onPointerDownCapture={startPan} onPointerMove={movePan} onPointerUp={endPan} onPointerCancel={endPan} onLostPointerCapture={endPan}
      onDoubleClick={event => { if (event.currentTarget === event.target) focusView(false) }}>
      <div ref={surface} className="canvas-sized" style={{ width: canvas.width * zoom, height: canvas.height * zoom, translate: `${offset.x}px ${offset.y}px` }}>
        <SlideSurface key={slide.id} slide={slide} zoom={zoom} />
      </div>
    </div>
    <div className="canvas-view-tools" role="group" aria-label={t.canvas.viewTools}>
      <button type="button" onClick={() => focusView(false)} title={`${t.canvas.fitPage} (⇧1)`} aria-label={t.canvas.fitPage}><Scan /></button>
      <button type="button" disabled={!hasSelection} onClick={() => focusView(true)} title={`${t.canvas.fitSelection} (⇧2)`} aria-label={t.canvas.fitSelection}><ScanLine /></button>
    </div>
  </>
}
