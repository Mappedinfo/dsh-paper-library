import { ChevronDown, ChevronUp, Copy, LayoutTemplate, Plus, Trash2, X } from 'lucide-react'
import { memo, useEffect, useRef, useState } from 'react'
import { layoutPresetsFor, type LayoutPresetId, type Slide } from 'plaindeck/core'
import { useEditor } from '../store'
import { useT } from '../i18n'
import { SlideSurface } from './SlideSurface'

function LayoutDiagram({ id }: { id: LayoutPresetId }) {
  return <div className={`layout-diagram layout-${id}`} aria-hidden="true">
    {id !== 'blank' && <i className="diagram-title" />}
    {id === 'title-body' && <><i className="diagram-accent" /><i className="diagram-copy" /><i className="diagram-copy short" /></>}
    {id === 'section' && <><i className="diagram-subtitle" /><i className="diagram-edge" /></>}
    {id === 'statement' && <><i className="diagram-statement" /><i className="diagram-index" /></>}
    {id === 'metric' && <><i className="diagram-metric" /><i className="diagram-metric-copy" /></>}
    {id === 'two-column' && <><i className="diagram-column left" /><i className="diagram-column right" /></>}
    {id === 'image-right' && <><i className="diagram-copy left" /><i className="diagram-image" /></>}
    {id === 'three-cards' && <div className="diagram-cards"><i /><i /><i /></div>}
    {id === 'process-flow' && <div className="diagram-cards"><i /><i /><i /><i /></div>}
    {id === 'decision-branch' && <><i className="diagram-copy left" /><i className="diagram-metric" /><i className="diagram-column right" /></>}
    {id === 'summary-cards' && <div className="diagram-summary-cards"><i /><i /><i /><i /></div>}
    {id === 'blank' && <span>+</span>}
  </div>
}

const SlideThumbnail = memo(function SlideThumbnail({ slide }: { slide: Slide }) {
  const canvas = useEditor(state => state.document.deck.canvas)
  const cropRef = useRef<HTMLDivElement>(null)
  const [nearViewport, setNearViewport] = useState(() => typeof IntersectionObserver === 'undefined')
  const [width, setWidth] = useState(0)
  useEffect(() => {
    const crop = cropRef.current
    if (!crop || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(([entry]) => setNearViewport(entry.isIntersecting), {
      root: crop.closest('.slide-list'),
      rootMargin: '100px 0px',
    })
    observer.observe(crop)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    const crop = cropRef.current
    if (!nearViewport || !crop) return
    setWidth(crop.clientWidth)
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width))
    observer.observe(crop)
    return () => observer.disconnect()
  }, [nearViewport])
  return <div ref={cropRef} className="thumb-crop" style={{ aspectRatio: `${canvas.width} / ${canvas.height}` }}>
    {nearViewport && width > 0 && <SlideSurface slide={slide} interactive={false} zoom={width / canvas.width} />}
  </div>
})

export function SlideList() {
  const [choosingLayout, setChoosingLayout] = useState(false)
  const document = useEditor(state => state.document)
  const activeSlidePath = useEditor(state => state.activeSlidePath)
  const { setActiveSlide, addSlide, duplicateSlide, deleteSlide, moveSlide } = useEditor.getState()
  const activeButton = useRef<HTMLButtonElement>(null)
  useEffect(() => { activeButton.current?.scrollIntoView?.({ block: 'nearest' }) }, [activeSlidePath])
  const { t, locale } = useT()
  return <aside className="slide-panel">
    <div className="panel-heading"><span>PAGES</span><strong>{String(document.deck.slides.length).padStart(2, '0')}</strong></div>
    <div className="slide-list">
      {document.deck.slides.map((path, index) => <button key={path} type="button" ref={path === activeSlidePath ? activeButton : undefined} aria-current={path === activeSlidePath ? 'page' : undefined} className={`slide-thumb ${path === activeSlidePath ? 'active' : ''}`} onClick={() => setActiveSlide(path)}>
        <span className="slide-number">{String(index + 1).padStart(3, '0')}</span>
        <SlideThumbnail slide={document.slides[path]} />
        <span className="slide-name">{document.slides[path].name ?? document.slides[path].id}</span>
      </button>)}
    </div>
    <div className="slide-actions">
      <button onClick={() => addSlide()} title={t.slideList.addBlank}><Plus /></button>
      <button onClick={() => setChoosingLayout(value => !value)} title={t.slideList.addFromLayout} aria-label={t.slideList.layoutButton}><LayoutTemplate /></button>
      <button onClick={duplicateSlide} title={t.slideList.duplicate}><Copy /></button>
      <button onClick={deleteSlide} title={t.slideList.remove} disabled={document.deck.slides.length <= 1}><Trash2 /></button>
      <span />
      <button onClick={() => moveSlide(-1)} title={t.slideList.moveUp}><ChevronUp /></button>
      <button onClick={() => moveSlide(1)} title={t.slideList.moveDown}><ChevronDown /></button>
    </div>
    {choosingLayout && <div className="layout-picker" role="dialog" aria-label={t.slideList.pickerLabel}>
      <div className="layout-picker-heading"><div><span>{t.slideList.pickerHeading}</span><strong>{t.slideList.pickerTitle}</strong></div><button onClick={() => setChoosingLayout(false)} aria-label={t.slideList.closePicker}><X /></button></div>
      <div className="layout-grid">{layoutPresetsFor(locale).map(preset => <button key={preset.id} onClick={() => { addSlide(preset.id); setChoosingLayout(false) }}>
        <LayoutDiagram id={preset.id} /><strong>{preset.name}</strong><small>{preset.description}</small>
      </button>)}</div>
    </div>}
  </aside>
}
