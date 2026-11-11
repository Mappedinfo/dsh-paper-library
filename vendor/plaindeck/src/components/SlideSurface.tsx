import { Image as ImageIcon } from 'lucide-react'
import { memo, useEffect, useLayoutEffect, useRef, useState, type PointerEvent } from 'react'
import { PlainDeckElementContent, PlainDeckFooter } from 'plaindeck/react'
import { PROJECT_PATHS, type DeckDocument, type Frame, type Slide, type SlideElement } from 'plaindeck/core'
import { elementFrameStyle, slideStyle } from 'plaindeck/render'
import { framePlacement, resizeFrame, snap } from '../core/geometry'
import { useEditor } from '../store'
import { getMessages } from '../i18n'
import { resolveAssetUrl } from '../storage/browserStorage'

interface SurfaceProps { slide: Slide; interactive?: boolean; zoom: number }

type ElementProps = {
  element: SlideElement
  slidePath: string
  frame: Frame
  canvas: DeckDocument['deck']['canvas']
  theme: DeckDocument['theme']
  directory: ReturnType<typeof useEditor.getState>['directory']
  interactive: boolean
  selected: boolean
  canResize: boolean
}

const ElementView = memo(function ElementView({ element, slidePath, frame, canvas, theme, directory, interactive, selected, canResize }: ElementProps) {
  const t = getMessages()
  const updateElement = useEditor.getState().updateElement
  const sourcePath = element.type === 'image' ? element.src : ''
  const [editing, setEditing] = useState(false)
  const editTarget = useRef<HTMLElement | null>(null)
  useLayoutEffect(() => {
    if (editing) editTarget.current?.focus()
    editTarget.current = null
  }, [editing])
  const [imageSrc, setImageSrc] = useState(() => sourcePath.startsWith(PROJECT_PATHS.assetsDir) ? '' : sourcePath)
  const placement = framePlacement(frame, canvas)

  // Local assets render via resolved object URLs; everything else renders the src directly.
  const localAsset = sourcePath.startsWith(PROJECT_PATHS.assetsDir) && Boolean(directory)
  const [imageSource, setImageSource] = useState<{ path: string; dir: typeof directory }>({ path: sourcePath, dir: directory })
  if (imageSource.path !== sourcePath || imageSource.dir !== directory) {
    setImageSource({ path: sourcePath, dir: directory })
    setImageSrc(localAsset ? '' : sourcePath)
  }
  useEffect(() => {
    if (!sourcePath || !sourcePath.startsWith(PROJECT_PATHS.assetsDir) || !directory) return
    let active = true
    resolveAssetUrl(directory, sourcePath).then(url => { if (active) setImageSrc(url) }).catch(() => { if (active) setImageSrc(sourcePath) })
    return () => { active = false }
  }, [directory, sourcePath])

  const style = elementFrameStyle({ ...element, frame } as SlideElement) as React.CSSProperties
  const outsideFragments: React.CSSProperties[] = []
  if (interactive && placement !== 'inside') {
    const leftWidth = Math.min(frame.w, Math.max(0, -frame.x))
    const rightStart = Math.max(0, canvas.width - frame.x)
    const rightWidth = Math.max(0, frame.w - rightStart)
    const middleLeft = Math.max(0, -frame.x)
    const middleRight = Math.min(frame.w, canvas.width - frame.x)
    const middleWidth = Math.max(0, middleRight - middleLeft)
    const topHeight = Math.min(frame.h, Math.max(0, -frame.y))
    const bottomStart = Math.max(0, canvas.height - frame.y)
    const bottomHeight = Math.max(0, frame.h - bottomStart)
    if (leftWidth) outsideFragments.push({ left: 0, top: 0, width: leftWidth, height: frame.h })
    if (rightWidth) outsideFragments.push({ left: rightStart, top: 0, width: rightWidth, height: frame.h })
    if (middleWidth && topHeight) outsideFragments.push({ left: middleLeft, top: 0, width: middleWidth, height: topHeight })
    if (middleWidth && bottomHeight) outsideFragments.push({ left: middleLeft, top: bottomStart, width: middleWidth, height: bottomHeight })
  }
  const currentText = element.type === 'text' || element.type === 'shape' ? element.text ?? '' : ''
  const content = element.type === 'image' && element.src !== 'placeholder:image' && !imageSrc
    ? <div className="image-loading"><ImageIcon /><span>{t.slideSurface.loadingLocalImage}</span></div>
    : <PlainDeckElementContent element={element} theme={theme} editable={interactive && editing} onTextCommit={text => { setEditing(false); if (useEditor.getState().activeSlidePath === slidePath && text !== currentText) updateElement(element.id, { text } as Partial<SlideElement>, element.type === 'shape' ? t.store.editShapeText : t.store.editText) }} onTableCellCommit={(row, column, text) => { if (useEditor.getState().activeSlidePath !== slidePath || element.type !== 'table' || element.cells[row][column] === text) return; const cells = element.cells.map(values => [...values]); cells[row][column] = text; updateElement(element.id, { cells } as Partial<SlideElement>, t.store.editTableCell) }} onImageError={event => event.currentTarget.classList.add('broken-image')} resolveAsset={() => imageSrc || sourcePath} placeholder={<><ImageIcon /><strong>IMAGE</strong><span>{t.slideSurface.imagePlaceholderHint}</span></>} />

  return <div className={`slide-element ${selected && interactive ? 'selected' : ''} ${interactive && placement !== 'inside' ? 'off-canvas' : ''}`} style={style} data-element-id={element.id} data-canvas-placement={placement} onBlur={event => { if (editing && !event.currentTarget.contains(event.relatedTarget as Node | null)) setEditing(false) }} onDoubleClick={e => { if (interactive && (element.type === 'text' || element.type === 'shape' || element.type === 'table')) { e.stopPropagation(); editTarget.current = (e.target as HTMLElement).closest<HTMLElement>('.table-cell') ?? e.currentTarget.querySelector<HTMLElement>('.editable-content'); setEditing(true) } }}>
    {content}
    {outsideFragments.map((fragment, index) => <i className="off-canvas-fragment" style={fragment} key={index} />)}
    {canResize && !editing && <button type="button" className="resize-handle" aria-label={t.slideSurface.resizeHandle} />}
  </div>
})

const emptySelection: string[] = []
type Gesture = {
  id: number
  x: number
  y: number
  path: string
  slide: Slide
  frames: Map<string, Frame>
  resize: boolean
  singleOnClick?: string
}

export const SlideSurface = memo(function SlideSurface({ slide, interactive = true, zoom }: SurfaceProps) {
  const deck = useEditor(state => state.document.deck)
  const theme = useEditor(state => state.document.theme)
  const directory = useEditor(state => state.directory)
  const selectedIds = useEditor(state => interactive ? state.selectedIds : emptySelection)
  const document = useEditor.getState().document
  const slidePath = deck.slides.find(path => document.slides[path]?.id === slide.id)
  const gesture = useRef<Gesture | null>(null)
  const [preview, setPreview] = useState<{ slide: Slide; frames: Map<string, Frame> } | null>(null)
  const canvas = deck.canvas
  if (!slidePath) return null

  function begin(event: PointerEvent<HTMLDivElement>) {
    if (!slidePath || !interactive || event.button !== 0 || gesture.current || (event.target as HTMLElement).isContentEditable) return
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-element-id]')
    const id = target?.dataset.elementId
    const editor = useEditor.getState()
    if (!target || !id) {
      if (!event.shiftKey) editor.select([])
      return
    }
    const resizeHandle = (event.target as HTMLElement).closest<HTMLElement>('.resize-handle')
    const selection = editor.selectedIds
    const alreadySelected = selection.includes(id)
    if (event.shiftKey && alreadySelected && !resizeHandle) {
      editor.select(selection.filter(item => item !== id))
      return
    }
    const next = alreadySelected ? selection : event.shiftKey ? [...selection, id] : [id]
    if (next !== selection) editor.select(next)
    const moving = new Set(resizeHandle ? [id] : next)
    const frames = new Map(slide.elements.filter(element => moving.has(element.id)).map(element => [element.id, element.frame]))
    gesture.current = {
      id: event.pointerId, x: event.clientX, y: event.clientY, path: slidePath, slide, frames,
      resize: Boolean(resizeHandle), singleOnClick: !event.shiftKey && !resizeHandle && next.length > 1 ? id : undefined,
    }
    const captureTarget = resizeHandle ?? (event.target as Element)
    captureTarget.setPointerCapture(event.pointerId)
  }

  function framesAt(event: PointerEvent, start: Gesture) {
    const dx = event.clientX - start.x, dy = event.clientY - start.y
    if (Math.hypot(dx, dy) < 3) return null
    const x = snap(dx / zoom), y = snap(dy / zoom)
    return new Map(Array.from(start.frames, ([id, frame]) => [
      id, start.resize ? resizeFrame(frame, dx / zoom, dy / zoom, canvas) : { ...frame, x: frame.x + x, y: frame.y + y },
    ]))
  }

  function move(event: PointerEvent) {
    const start = gesture.current
    if (!start || event.pointerId !== start.id) return
    const frames = framesAt(event, start)
    setPreview(frames && start.slide === slide ? { slide, frames } : null)
  }

  function end(event: PointerEvent, commit: boolean) {
    const start = gesture.current
    if (!start || event.pointerId !== start.id) return
    gesture.current = null
    setPreview(null)
    const editor = useEditor.getState()
    if (!commit || editor.activeSlidePath !== start.path || editor.document.slides[start.path] !== start.slide) return
    const frames = framesAt(event, start)
    if (frames) editor.updateFrames(start.path, frames, start.resize ? getMessages().store.resizeElement : getMessages().store.moveElement)
    else if (start.singleOnClick) editor.select([start.singleOnClick])
  }

  const selection = new Set(selectedIds)
  return <div className={`slide-surface ${interactive ? 'editor-surface' : 'output-surface'}`} style={{ ...(slideStyle(document, slidePath) as React.CSSProperties), position: 'absolute', left: 0, top: 0, overflow: interactive ? 'visible' : 'hidden', transform: `scale(${zoom})` }}
    onPointerDown={interactive ? begin : undefined} onPointerMove={interactive ? move : undefined}
    onPointerUp={interactive ? event => end(event, true) : undefined}
    onPointerCancel={interactive ? event => end(event, false) : undefined}
    onLostPointerCapture={interactive ? event => end(event, false) : undefined}>
    {slide.elements.map(element => {
      const selected = selection.has(element.id)
      return <ElementView key={element.id} element={element} slidePath={slidePath} interactive={interactive} theme={theme} canvas={canvas} directory={directory}
        frame={(preview?.slide === slide ? preview.frames.get(element.id) : undefined) ?? element.frame}
        selected={selected} canResize={selected && selection.size === 1} />
    })}
    <PlainDeckFooter document={document} slidePath={slidePath} />
  </div>
})
