import { useEffect, useId, useRef, useState } from 'react'
import { CloudOff, GitBranch, Github, Images, Minus, MoreHorizontal, Palette, Plus } from 'lucide-react'
import { useEditor, ZOOM_MAX, ZOOM_MIN, ZOOM_STEP } from '../store'
import { useT } from '../i18n'
import './StatusBar.css'

export function StatusBar() {
  const { document, zoom, setZoom, saveState, directory, error } = useEditor()
  const { t } = useT()
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [errorExpanded, setErrorExpanded] = useState(false)
  const detailsRef = useRef<HTMLDivElement>(null)
  const detailsButtonRef = useRef<HTMLButtonElement>(null)
  const detailsId = useId()
  useEffect(() => {
    if (!detailsOpen) return
    const onPointerDown = (event: PointerEvent) => {
      if (!detailsRef.current?.contains(event.target as Node)) setDetailsOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setDetailsOpen(false)
      detailsButtonRef.current?.focus()
    }
    window.document.addEventListener('pointerdown', onPointerDown)
    window.document.addEventListener('keydown', onKeyDown)
    return () => {
      window.document.removeEventListener('pointerdown', onPointerDown)
      window.document.removeEventListener('keydown', onKeyDown)
    }
  }, [detailsOpen])
  const label = saveState === 'saving' ? t.statusBar.saving : saveState === 'saved' ? t.statusBar.saved : saveState === 'dirty' ? t.statusBar.dirty : saveState === 'error' ? t.statusBar.error : t.statusBar.demo
  return <footer className="statusbar">
    <span className={`save-pill ${saveState}`} role="status" title={label}><i /><span>{label}</span></span>
    <div className="status-details" ref={detailsRef} data-open={detailsOpen} onBlurCapture={event => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDetailsOpen(false)
    }}>
      <button className="status-more" ref={detailsButtonRef} type="button" aria-label={t.statusBar.moreAria} title={t.statusBar.moreAria} aria-expanded={detailsOpen} aria-controls={detailsId} onClick={() => setDetailsOpen(open => !open)}><MoreHorizontal /></button>
      <div className="status-information" id={detailsId} role="group" aria-label={t.statusBar.moreAria}>
        <span><GitBranch /> {directory ? 'LOCAL DIRECTORY' : 'MEMORY / ZIP'}</span>
        <span><CloudOff /> LOCAL-FIRST</span>
        <a className="source-link" href="https://github.com/Mappedinfo/PlainDeck" target="_blank" rel="noreferrer" aria-label={t.statusBar.githubAria} title={t.statusBar.githubTitle}><Github /> SOURCE</a>
        <a className="source-link" href={`${import.meta.env.BASE_URL}renders/`} target="_blank" rel="noreferrer" aria-label={t.statusBar.samplesAria} title={t.statusBar.samplesTitle}><Images /> SAMPLES</a>
        <a className="source-link palette-lab-link" href="https://mappedinfo.github.io/palette-lab/" target="_blank" rel="noreferrer" aria-label={t.statusBar.paletteAria} title={t.statusBar.paletteTitle}><Palette /> PALETTE LAB</a>
        <span className="status-dimensions">{document.deck.canvas.width} × {document.deck.canvas.height}</span>
      </div>
    </div>
    <div className="status-zoom" role="group" aria-label={t.statusBar.zoomAria}>
      <button type="button" aria-label={t.statusBar.zoomOutAria} title={t.statusBar.zoomOutAria} disabled={zoom <= ZOOM_MIN} onClick={() => setZoom(zoom - ZOOM_STEP)}><Minus /></button>
      <input aria-label={t.statusBar.zoomAria} type="range" min={ZOOM_MIN * 100} max={ZOOM_MAX * 100} step={1} value={zoom * 100} onChange={e => setZoom(Number(e.target.value) / 100)} />
      <button type="button" aria-label={t.statusBar.zoomInAria} title={t.statusBar.zoomInAria} disabled={zoom >= ZOOM_MAX} onClick={() => setZoom(zoom + ZOOM_STEP)}><Plus /></button>
      <strong>{Math.round(zoom * 100)}%</strong>
    </div>
    {error && <button type="button" className="status-error" title={error} aria-expanded={errorExpanded} aria-label={`${t.statusBar.errorDetailsAria}: ${error}`} onClick={() => setErrorExpanded(expanded => !expanded)}>{error}</button>}
  </footer>
}
