import { AlignCenter, AlignLeft, AlignRight, ArrowDown, ArrowDownToLine, ArrowLeftToLine, ArrowRightToLine, ArrowUp, ArrowUpToLine, GripVertical, Image, LocateFixed, Minus, Search, Square, Table2, Type } from 'lucide-react'
import { parseTableCells, tableCellsToTsv, themePresetsFor, type DeckFooter, type ElementAnimation, type FooterSlot, type SlideElement, type TableStyle } from 'plaindeck/core'
import { useEffect, useRef, useState, type DragEvent } from 'react'
import { centerFrame, framePlacement } from '../core/geometry'
import { useEditor } from '../store'
import { useT } from '../i18n'

function Numeric({ label, value, min, step, onChange }: { label: string; value: number; min?: number; step?: number; onChange: (value: number) => void }) {
  const [draft, setDraft] = useState(String(value))
  const [draftSource, setDraftSource] = useState(value)
  if (draftSource !== value) { setDraftSource(value); setDraft(String(value)) }
  const commit = () => {
    const next = Number(draft)
    if (draft.trim() && Number.isFinite(next) && (min === undefined || next >= min)) onChange(next)
    else setDraft(String(value))
  }
  return <label className="field compact"><span>{label}</span><input type="number" min={min} step={step} value={draft} onChange={event => setDraft(event.target.value)} onBlur={commit} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); if (event.key === 'Escape') { setDraft(String(value)); event.currentTarget.blur() } }} /></label>
}

function DraftTextarea({ value, rows, label, placeholder, onCommit }: { value: string; rows: number; label: string; placeholder?: string; onCommit: (value: string) => void }) {
  const [draft, setDraft] = useState(value)
  const [draftSource, setDraftSource] = useState(value)
  if (draftSource !== value) { setDraftSource(value); setDraft(value) }
  return <label className="field"><span>{label}</span><textarea rows={rows} value={draft} placeholder={placeholder} onChange={event => setDraft(event.target.value)} onBlur={() => { if (draft !== value) onCommit(draft) }} /></label>
}

function TableGridEditor({ element, onCommit }: { element: Extract<SlideElement, { type: 'table' }>; onCommit: (cells: string[][]) => void }) {
  const value = tableCellsToTsv(element.cells)
  const [draft, setDraft] = useState(value); const [error, setError] = useState('')
  const [draftSource, setDraftSource] = useState(value)
  const { t } = useT()
  if (draftSource !== value) { setDraftSource(value); setDraft(value); setError('') }
  const commit = () => {
    if (draft === value) return
    try { const cells = parseTableCells(draft); onCommit(cells); setError('') }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
  }
  return <><label className="field"><span>{t.inspector.cellHelper}</span><textarea rows={8} value={draft} spellCheck={false} onChange={event => setDraft(event.target.value)} onBlur={commit} /></label>{error && <p className="table-grid-error">{error}</p>}</>
}

function ElementIcon({ type }: { type: SlideElement['type'] }) {
  if (type === 'text') return <Type />
  if (type === 'image') return <Image />
  if (type === 'shape') return <Square />
  if (type === 'table') return <Table2 />
  return <Minus />
}

const defaultFooter: DeckFooter = {
  left: { type: 'slide-name' },
  center: { type: 'date' },
  right: { type: 'page-of-count' },
}

function slotForType(type: FooterSlot['type'], current: FooterSlot): FooterSlot {
  return type === 'text' ? { type, text: current.type === 'text' ? current.text : '' } : { type } as FooterSlot
}

function footerSlots(t: ReturnType<typeof useT>['t']): Array<{ type: FooterSlot['type']; label: string }> {
  const s = t.inspector.footerSlots
  return [
    { type: 'none', label: s.none }, { type: 'text', label: s.text }, { type: 'date', label: s.date },
    { type: 'page', label: s.page }, { type: 'page-count', label: s.pageCount },
    { type: 'page-of-count', label: s.pageOfCount }, { type: 'deck-title', label: s.deckTitle },
    { type: 'slide-name', label: s.slideName },
  ]
}

function entranceEntries(t: ReturnType<typeof useT>['t']): Array<{ value: ElementAnimation['enter']; label: string }> {
  const a = t.inspector
  return [
    { value: 'none', label: a.entranceNone }, { value: 'fade', label: a.entranceFade }, { value: 'fade-up', label: a.entranceFadeUp },
    { value: 'fade-down', label: a.entranceFadeDown }, { value: 'fade-left', label: a.entranceFadeLeft },
    { value: 'fade-right', label: a.entranceFadeRight }, { value: 'scale', label: a.entranceScale },
  ]
}

function FooterEditor() {
  const state = useEditor(); const footer = state.document.deck.footer
  const updateSlot = (position: 'left' | 'center' | 'right', slot: FooterSlot) => footer && state.updateFooter({ ...footer, [position]: slot })
  const { t } = useT()
  const sideLabels = { left: t.common.left, center: t.common.center, right: t.common.right }
  const options = footerSlots(t)
  return <section className="footer-editor"><div className="section-heading"><h3>{t.inspector.footerHeading}</h3><label className="footer-toggle"><input type="checkbox" checked={Boolean(footer)} onChange={event => state.updateFooter(event.target.checked ? defaultFooter : null)} /><span>{footer ? t.common.enabled : t.common.disabled}</span></label></div>
    {footer ? <><div className="footer-slot-list">{(['left', 'center', 'right'] as const).map(position => { const slot = footer[position]; const label = sideLabels[position]; return <div className="footer-slot" key={position}><span>{label}</span><select aria-label={t.inspector.footerSideAria(label)} value={slot.type} onChange={event => updateSlot(position, slotForType(event.target.value as FooterSlot['type'], slot))}>{options.map(option => <option value={option.type} key={option.type}>{option.label}</option>)}</select>{slot.type === 'text' && <input key={slot.text} aria-label={t.inspector.footerTextAria(label)} defaultValue={slot.text} placeholder={t.inspector.footerTextInputPlaceholder} onBlur={event => { if (event.target.value !== slot.text) updateSlot(position, { type: 'text', text: event.target.value }) }} />}</div> })}</div><div className="footer-style"><Numeric label={t.inspector.footerFontSize} min={1} value={footer.fontSize ?? state.document.theme.fontSizes.caption} onChange={fontSize => state.updateFooter({ ...footer, fontSize })} /><label className="footer-color"><input aria-label={t.inspector.footerColorAria} type="color" value={footer.color ?? state.document.theme.colors.muted} onChange={event => state.updateFooter({ ...footer, color: event.target.value })} /><span>{t.common.color}</span></label></div><p className="element-index-hint">{t.inspector.footerDateHint}</p></> : <p className="element-index-hint">{t.inspector.footerIntro}</p>}
  </section>
}

export function Inspector() {
  const state = useEditor(); const slide = state.document.slides[state.activeSlidePath]
  const { t, locale } = useT()
  const [elementQuery, setElementQuery] = useState('')
  const layerList = useRef<HTMLDivElement>(null)
  const dragged = useRef<{ id: string; path: string } | null>(null)
  const [dropTarget, setDropTarget] = useState<{ id: string; above: boolean } | null>(null)
  const lastSelected = state.selectedIds.at(-1)
  useEffect(() => {
    const list = layerList.current
    const row = list && Array.from(list.children).find(child => (child as HTMLElement).dataset.layerId === lastSelected)
    if (!list || !row) return
    const bounds = list.getBoundingClientRect(), item = row.getBoundingClientRect()
    if (item.top < bounds.top) list.scrollTop += item.top - bounds.top
    else if (item.bottom > bounds.bottom) list.scrollTop += item.bottom - bounds.bottom
  }, [lastSelected, state.activeSlidePath])
  function layerDrop(event: DragEvent<HTMLDivElement>, id: string, commit: boolean) {
    const source = dragged.current
    if (!source || source.path !== state.activeSlidePath || source.id === id) { setDropTarget(null); return }
    event.preventDefault()
    const rect = event.currentTarget.getBoundingClientRect()
    const above = event.clientY < rect.top + rect.height / 2
    if (!commit) {
      event.dataTransfer.dropEffect = 'move'
      setDropTarget(previous => previous?.id === id && previous.above === above ? previous : { id, above })
    } else {
      state.moveLayer(source.id, id, above ? 'after' : 'before')
      dragged.current = null
      setDropTarget(null)
    }
  }
  const [querySource, setQuerySource] = useState(state.activeSlidePath)
  if (querySource !== state.activeSlidePath) { setQuerySource(state.activeSlidePath); setElementQuery('') }
  const selected = slide.elements.filter(element => state.selectedIds.includes(element.id)); const element = selected.length === 1 ? selected[0] : null
  const typeNames = t.store.typeNames
  const typeNameFor = (type: SlideElement['type']) => ({ text: typeNames.text, image: typeNames.image, shape: typeNames.shape, line: typeNames.line, table: typeNames.table })[type]
  const elementName = (item: SlideElement) => {
    const value = item.type === 'text' ? item.text : item.type === 'shape' ? item.text : item.type === 'image' ? item.alt : item.type === 'table' ? item.cells[0]?.join(' / ') : ''
    return value?.trim().replace(/\s+/g, ' ').slice(0, 28) || `${typeNameFor(item.type)} · ${item.id}`
  }
  const visibleElements = slide.elements.filter(item => `${item.id} ${typeNameFor(item.type)} ${elementName(item)}`.toLowerCase().includes(elementQuery.trim().toLowerCase())).reverse()
  const layerIndex = element ? slide.elements.indexOf(element) : -1
  const patch = (value: Partial<SlideElement>, label?: string) => element && state.updateElement(element.id, value, label)
  return <aside className="inspector">
    <div className="panel-heading"><span>INSPECTOR</span><strong>{selected.length ? `${selected.length} SELECTED` : 'PAGE'}</strong></div>
    <section className="element-index">
      <div className="section-heading"><h3>{t.inspector.elementsHeading}</h3><span>{slide.elements.length}</span>
        <div className="layer-order">
          <button type="button" aria-label={t.inspector.layerUp} title={t.inspector.layerUp} disabled={layerIndex < 0 || layerIndex === slide.elements.length - 1} onClick={() => state.reorderLayer(1)}><ArrowUp /></button>
          <button type="button" aria-label={t.inspector.layerDown} title={t.inspector.layerDown} disabled={layerIndex <= 0} onClick={() => state.reorderLayer(-1)}><ArrowDown /></button>
        </div>
      </div>
      <label className="element-search"><Search /><input aria-label={t.inspector.filterElements} value={elementQuery} onChange={event => setElementQuery(event.target.value)} placeholder={t.inspector.filterPlaceholder} /></label>
      <div className="element-list" ref={layerList} onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropTarget(null) }}>
        {visibleElements.map(item => {
          const placement = framePlacement(item.frame, state.document.deck.canvas)
          const placementLabel = t.inspector.placementNames[placement]
          const name = elementName(item), active = state.selectedIds.includes(item.id)
          return <div className={`element-row ${active ? 'active' : ''}`} key={item.id} data-layer-id={item.id} data-drop={dropTarget?.id === item.id ? (dropTarget.above ? 'above' : 'below') : undefined}
            onDragOver={event => layerDrop(event, item.id, false)} onDrop={event => layerDrop(event, item.id, true)}>
            <span className="layer-grip" draggable title={t.inspector.dragLayer} aria-hidden="true"
              onDragStart={event => { dragged.current = { id: item.id, path: state.activeSlidePath }; event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', item.id) }}
              onDragEnd={() => { dragged.current = null; setDropTarget(null) }}><GripVertical /></span>
            <button type="button" className="element-select" aria-pressed={active} onClick={event => state.select(event.shiftKey ? active ? state.selectedIds.filter(id => id !== item.id) : [...state.selectedIds, item.id] : [item.id])} title={t.inspector.selectElement(name)}><ElementIcon type={item.type} /><span><strong>{name}</strong><small className={placement}>{typeNameFor(item.type)} · {placementLabel}</small></span></button>
            <button type="button" className="element-center" aria-label={t.inspector.centerElementAria(name)} title={t.inspector.centerElementTitle} onClick={() => { state.select([item.id]); state.updateElement(item.id, { frame: centerFrame(item.frame, state.document.deck.canvas) } as Partial<SlideElement>, t.store.centerOnCanvas) }}><LocateFixed /></button>
          </div>
        })}
        {!visibleElements.length && <p className="element-empty">{t.inspector.noMatchingElements}</p>}
      </div><p className="element-index-hint">{t.inspector.elementsHint}</p>
    </section>
    <FooterEditor />
    {!element && selected.length === 0 && <>
      <section><h3>DOCUMENT</h3><label className="field"><span>{t.inspector.documentTitle}</span><input value={state.document.deck.title} readOnly /></label><div className="metric-grid"><div><span>WIDTH</span><strong>{state.document.deck.canvas.width}</strong></div><div><span>HEIGHT</span><strong>{state.document.deck.canvas.height}</strong></div></div></section>
      <section><div className="section-heading"><h3>{t.inspector.cameraHeading}</h3><label className="footer-toggle"><input type="checkbox" checked={Boolean(slide.motion?.camera)} onChange={event => state.updateSlideMotion(event.target.checked ? { camera: { fromScale: 1, toScale: 1.045, durationFrames: 180 } } : null)} /><span>{slide.motion?.camera ? t.inspector.cameraEnabled : t.inspector.cameraStatic}</span></label></div>{slide.motion?.camera && <div className="four-grid"><Numeric label={t.inspector.cameraFromScale} min={.1} step={.01} value={slide.motion.camera.fromScale} onChange={fromScale => state.updateSlideMotion({ camera: { ...slide.motion!.camera!, fromScale } })} /><Numeric label={t.inspector.cameraToScale} min={.1} step={.01} value={slide.motion.camera.toScale} onChange={toScale => state.updateSlideMotion({ camera: { ...slide.motion!.camera!, toScale } })} /><Numeric label={t.inspector.cameraDelayFrames} min={0} value={slide.motion.camera.delayFrames ?? 0} onChange={delayFrames => state.updateSlideMotion({ camera: { ...slide.motion!.camera!, delayFrames } })} /><Numeric label={t.inspector.cameraDurationFrames} min={1} value={slide.motion.camera.durationFrames ?? 180} onChange={durationFrames => state.updateSlideMotion({ camera: { ...slide.motion!.camera!, durationFrames } })} /></div>}<p className="element-index-hint">{t.inspector.cameraHint}</p></section>
      <section><h3>COLOR STYLES</h3><div className="theme-presets">{themePresetsFor(locale).map(preset => { const active = Object.entries(preset.colors).every(([key, value]) => state.document.theme.colors[key as keyof typeof preset.colors] === value); return <button key={preset.id} className={active ? 'active' : ''} onClick={() => state.applyTheme(preset.theme)} title={preset.description}><span className="theme-swatches">{Object.values(preset.colors).map(color => <i key={color} style={{ background: color }} />)}</span><strong>{preset.name}</strong><small>{preset.description}</small></button> })}</div><a className="palette-lab-link" href="https://mappedinfo.github.io/palette-lab/" target="_blank" rel="noreferrer" title={t.inspector.paletteLabLinkTitle}>{t.inspector.paletteLabLinkText}</a></section>
      <section><h3>CUSTOM COLORS</h3>{(['background', 'text', 'muted', 'accent'] as const).map(key => <label className="color-field" key={key}><input type="color" value={state.document.theme.colors[key]} onChange={e => state.updateTheme({ [key]: e.target.value })} /><span>{key}</span><code>{state.document.theme.colors[key]}</code></label>)}</section>
      <section className="hint-card"><span>QUICK START</span><p>{t.inspector.quickStart}</p></section>
    </>}
      {selected.length > 1 && <section><h3>ALIGNMENT</h3><div className="icon-grid">{([['left', ArrowLeftToLine], ['center', AlignCenter], ['right', ArrowRightToLine], ['top', ArrowUpToLine], ['middle', AlignCenter], ['bottom', ArrowDownToLine]] as const).map(([mode, Icon]) => <button key={mode} onClick={() => state.alignSelected(mode)} title={t.store.align(mode)}><Icon /></button>)}</div><p className="muted-copy">{t.inspector.selectedCount(selected.length)}</p></section>}
    {element && <>
      <section><h3>POSITION</h3><div className="four-grid"><Numeric label="X" value={element.frame.x} onChange={x => patch({ frame: { ...element.frame, x } } as Partial<SlideElement>)} /><Numeric label="Y" value={element.frame.y} onChange={y => patch({ frame: { ...element.frame, y } } as Partial<SlideElement>)} /><Numeric label="W" min={1} value={element.frame.w} onChange={w => patch({ frame: { ...element.frame, w } } as Partial<SlideElement>)} /><Numeric label="H" min={1} value={element.frame.h} onChange={h => patch({ frame: { ...element.frame, h } } as Partial<SlideElement>)} /></div></section>
      <section><h3>{t.inspector.animationHeading}</h3><label className="field"><span>{t.inspector.animationMethod}</span><select aria-label={t.inspector.animationSelectAria} value={element.animation?.enter ?? 'none'} onChange={event => { const enter = event.target.value as ElementAnimation['enter']; patch({ animation: enter === 'none' ? undefined : { enter, delayFrames: element.animation?.delayFrames ?? 0, durationFrames: element.animation?.durationFrames ?? 18 } } as Partial<SlideElement>, t.store.updateAnimation) }}>{entranceEntries(t).map(option => <option value={option.value} key={option.value}>{option.label}</option>)}</select></label>{element.animation && element.animation.enter !== 'none' && <div className="metric-grid"><Numeric label={t.inspector.animationDelayFrames} min={0} value={element.animation.delayFrames ?? 0} onChange={delayFrames => patch({ animation: { ...element.animation!, delayFrames } } as Partial<SlideElement>, t.store.updateAnimationDelay)} /><Numeric label={t.inspector.animationDurationFrames} min={1} value={element.animation.durationFrames ?? 18} onChange={durationFrames => patch({ animation: { ...element.animation!, durationFrames } } as Partial<SlideElement>, t.store.updateAnimationDuration)} /></div>}<p className="element-index-hint">{t.inspector.animationHint}</p></section>
      {element.type === 'text' && <section><h3>TYPOGRAPHY</h3><Numeric label="SIZE" min={1} value={element.fontSize ?? state.document.theme.fontSizes.body} onChange={fontSize => patch({ fontSize } as Partial<SlideElement>)} /><DraftTextarea label={t.inspector.typographyContent} rows={5} value={element.text} onCommit={text => patch({ text } as Partial<SlideElement>, t.store.editText)} /><div className="icon-grid three"><button onClick={() => patch({ align: 'left' } as Partial<SlideElement>)}><AlignLeft /></button><button onClick={() => patch({ align: 'center' } as Partial<SlideElement>)}><AlignCenter /></button><button onClick={() => patch({ align: 'right' } as Partial<SlideElement>)}><AlignRight /></button></div></section>}
      {element.type === 'shape' && <><section><h3>SHAPE TEXT</h3><DraftTextarea label={t.inspector.shapeTextContent} rows={4} value={element.text ?? ''} placeholder={t.inspector.shapeTextPlaceholder} onCommit={text => patch({ text } as Partial<SlideElement>, t.store.editShapeText)} /><Numeric label="SIZE" min={1} value={element.fontSize ?? state.document.theme.fontSizes.body} onChange={fontSize => patch({ fontSize } as Partial<SlideElement>)} /><label className="color-field"><input type="color" value={element.textColor ?? state.document.theme.colors.text} onChange={e => patch({ textColor: e.target.value } as Partial<SlideElement>)} /><span>text</span><code>{element.textColor ?? state.document.theme.colors.text}</code></label><div className="icon-grid three"><button onClick={() => patch({ align: 'left' } as Partial<SlideElement>)} title={t.inspector.alignLeft}><AlignLeft /></button><button onClick={() => patch({ align: 'center' } as Partial<SlideElement>)} title={t.inspector.alignCenter}><AlignCenter /></button><button onClick={() => patch({ align: 'right' } as Partial<SlideElement>)} title={t.inspector.alignRight}><AlignRight /></button></div></section><section><h3>APPEARANCE</h3><label className="color-field"><input type="color" value={element.fill} onChange={e => patch({ fill: e.target.value } as Partial<SlideElement>)} /><span>fill</span><code>{element.fill}</code></label><Numeric label="RADIUS" min={0} value={element.radius ?? 0} onChange={radius => patch({ radius } as Partial<SlideElement>)} /></section></>}
      {element.type === 'image' && <section><h3>IMAGE</h3><label className="field"><span>{t.inspector.imageSrc}</span><input value={element.src} onChange={e => patch({ src: e.target.value } as Partial<SlideElement>)} /></label><label className="field"><span>{t.inspector.imageFit}</span><select value={element.fit} onChange={e => patch({ fit: e.target.value as 'contain' | 'cover' | 'stretch' } as Partial<SlideElement>)}><option>contain</option><option>cover</option><option>stretch</option></select></label></section>}
      {element.type === 'table' && <><section><h3>TABLE DATA</h3><TableGridEditor element={element} onCommit={cells => patch({ cells } as Partial<SlideElement>, t.store.bulkEditTable)} /><p className="element-index-hint">{t.inspector.tableDataHint}</p></section><section><h3>TABLE STYLE</h3><label className="field"><span>{t.inspector.tableStyle}</span><select value={element.style} onChange={event => patch({ style: event.target.value as TableStyle } as Partial<SlideElement>, t.store.updateTableStyle)}><option value="rules">Nature rules</option><option value="grid">Compact grid</option><option value="stripes">Quiet stripes</option></select></label><Numeric label={t.inspector.footerFontSize} min={1} value={element.fontSize ?? state.document.theme.fontSizes.body} onChange={fontSize => patch({ fontSize } as Partial<SlideElement>)} /><Numeric label={t.inspector.tableCellPadding} min={0} value={element.cellPadding ?? 18} onChange={cellPadding => patch({ cellPadding } as Partial<SlideElement>)} /><Numeric label={t.inspector.tableHeaderRows} min={0} value={element.headerRows} onChange={headerRows => patch({ headerRows: Math.min(headerRows, element.cells.length) } as Partial<SlideElement>)} /><label className="color-field"><input type="color" value={element.accentColor ?? state.document.theme.colors.accent} onChange={event => patch({ accentColor: event.target.value } as Partial<SlideElement>)} /><span>accent</span><code>{element.accentColor ?? state.document.theme.colors.accent}</code></label></section></>}
      {element.type === 'line' && <section><h3>LINE</h3><Numeric label="WIDTH" min={1} value={element.strokeWidth} onChange={strokeWidth => patch({ strokeWidth } as Partial<SlideElement>)} /><label className="check-field"><input type="checkbox" checked={element.dash ?? false} onChange={e => patch({ dash: e.target.checked } as Partial<SlideElement>)} />{t.inspector.lineDash}</label></section>}
    </>}
  </aside>
}
