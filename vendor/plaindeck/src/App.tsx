import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, Download, FileArchive, FileCode2, Printer, X } from 'lucide-react'
import { Toolbar } from './components/Toolbar'
import { SlideList } from './components/SlideList'
import { SlideSurface } from './components/SlideSurface'
import { CanvasViewport } from './components/CanvasViewport'
import { usePrintDeck } from './components/PrintDeck'
import { Inspector } from './components/Inspector'
import { StatusBar } from './components/StatusBar'
import { SlideNameEditor } from './components/SlideNameEditor'
import { SummaryCardsDialog } from './components/SummaryCardsDialog'
import { TableDialog } from './components/TableDialog'
import { PresentationGuide } from './components/PresentationGuide'
import { createSampleDocument } from './core/sample'
import { blobToDataUrl, fitImageFrame, hasTransferredImages, imageDimensions, imageFiles, transferredImageFiles, validateImageFile } from './core/imageImport'
import { createSaveLoop } from './core/saveLoop'
import { useEditor } from './store'
import { getMessages, useT } from './i18n'
import { errorText, throwLocalized } from './i18n/errors'
import { exportHtml } from './export/html'
import { exportZip, importZip } from './storage/zipStorage'
import { clearRecoveryFromOpfs, initializeProject, pickDirectory, projectFingerprint, readProject, restoreFromOpfs, snapshotToOpfs, verifyPermission, writeImageAsset, writeProject } from './storage/browserStorage'
import { resolveDirectoryBriefScope } from './storage/presentationBriefScope'

type ApplyUpdate = (reloadPage?: boolean) => Promise<void>

function Presentation({ onClose }: { onClose: () => void }) {
  const { document, activeSlidePath } = useEditor(); const t = getMessages(); const initial = Math.max(0, document.deck.slides.indexOf(activeSlidePath)); const [index, setIndex] = useState(initial)
  useEffect(() => { const key = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); if (['ArrowRight', 'ArrowDown', ' '].includes(event.key)) setIndex(i => Math.min(document.deck.slides.length - 1, i + 1)); if (['ArrowLeft', 'ArrowUp'].includes(event.key)) setIndex(i => Math.max(0, i - 1)) }; addEventListener('keydown', key); return () => removeEventListener('keydown', key) }, [document.deck.slides.length, onClose])
  const scale = Math.min(window.innerWidth / document.deck.canvas.width, window.innerHeight / document.deck.canvas.height) * .94
  return <div className="presentation" role="dialog" aria-label={t.presentation.dialogLabel}><button className="presentation-close" onClick={onClose}><X /> {t.presentation.exit}</button><div className="presentation-stage" style={{ width: document.deck.canvas.width * scale, height: document.deck.canvas.height * scale }}><SlideSurface slide={document.slides[document.deck.slides[index]]} interactive={false} zoom={scale} /></div><div className="presentation-nav"><button onClick={() => setIndex(i => Math.max(0, i - 1))}><ChevronLeft /></button><span>{index + 1} / {document.deck.slides.length}</span><button onClick={() => setIndex(i => Math.min(document.deck.slides.length - 1, i + 1))}><ChevronRight /></button></div></div>
}

function ExportDialog({ onClose, onPrint }: { onClose: () => void; onPrint: () => Promise<void> }) {
  const editor = useEditor(); const { document, directory } = editor
  const { t } = useT()
  const [busy, setBusy] = useState(false)
  const action = async (type: 'html' | 'zip' | 'pdf') => {
    if (busy) return
    setBusy(true)
    try { if (type === 'html') await exportHtml(document, directory); if (type === 'zip') await exportZip(document, directory); if (type === 'pdf') await onPrint(); onClose() }
    catch (error) { editor.setSaveState('error', errorText(error)) }
    finally { setBusy(false) }
  }
  return <div className="modal-backdrop" onMouseDown={onClose}><div className="export-dialog" onMouseDown={e => e.stopPropagation()}><div><span className="eyebrow">{t.exportDialog.eyebrow}</span><button onClick={onClose}><X /></button></div><h2>{t.exportDialog.title}</h2><p>{t.exportDialog.intro}</p><button className="export-choice" disabled={busy} onClick={() => action('html')}><FileCode2 /><span><strong>{t.exportDialog.htmlName}</strong><small>{t.exportDialog.htmlHint}</small></span><Download /></button><button className="export-choice" disabled={busy} onClick={() => action('pdf')}><Printer /><span><strong>{t.exportDialog.pdfName}</strong><small>{t.exportDialog.pdfHint}</small></span><Download /></button><button className="export-choice" disabled={busy} onClick={() => action('zip')}><FileArchive /><span><strong>{t.exportDialog.zipName}</strong><small>{t.exportDialog.zipHint}</small></span><Download /></button></div></div>
}

export default function App() {
  const [guiding, setGuiding] = useState(false)
  const state = useEditor(); const { t } = useT(); const [present, setPresent] = useState(false); const [exporting, setExporting] = useState(false); const [addingCards, setAddingCards] = useState(false); const [addingTable, setAddingTable] = useState(false); const [updateReady, setUpdateReady] = useState(false); const [draggingImage, setDraggingImage] = useState(false); const [imageNotice, setImageNotice] = useState(''); const [recovery, setRecovery] = useState<Awaited<ReturnType<typeof restoreFromOpfs>>>(null); const zipRef = useRef<HTMLInputElement>(null); const imageRef = useRef<HTMLInputElement>(null); const canvasRef = useRef<HTMLElement>(null); const applyUpdateRef = useRef<ApplyUpdate>(null)
  const { print, printDeck } = usePrintDeck()
  const insertImages = useCallback(async (files: File[], point?: { x: number; y: number }) => {
    if (!files.length) return
    try {
      for (const [index, file] of files.entries()) {
        validateImageFile(file)
        const editor = useEditor.getState(); const messages = getMessages(); const dimensions = await imageDimensions(file)
        let src: string
        if (editor.directory) {
          if (!await verifyPermission(editor.directory, true)) throwLocalized('imageWritePermission')
          src = await writeImageAsset(editor.directory, file)
        } else src = await blobToDataUrl(file)
        const offsetPoint = point ? { x: point.x + index * 28, y: point.y + index * 28 } : undefined
        editor.addImage(src, fitImageFrame(dimensions, editor.document.deck.canvas, offsetPoint), file.name || messages.app.pastedImageAlt)
        setImageNotice(editor.directory ? messages.app.savedToAssetNotice(src) : messages.app.savedInlineNotice)
      }
    } catch (error) { useEditor.getState().setSaveState('error', errorText(error)) }
  }, [])
  const canvasPoint = useCallback((clientX: number, clientY: number) => {
    const surface = canvasRef.current?.querySelector('.canvas-sized > .slide-surface')
    if (!(surface instanceof HTMLElement)) return undefined
    const rect = surface.getBoundingClientRect(); const canvas = useEditor.getState().document.deck.canvas
    return { x: (clientX - rect.left) * canvas.width / rect.width, y: (clientY - rect.top) * canvas.height / rect.height }
  }, [])
  const [saveLoop] = useState(() => createSaveLoop({
    hasPending: () => useEditor.getState().dirtyRevisions.size > 0,
    saveOnce: async () => {
      const current = useEditor.getState(); const captured = new Map(current.dirtyRevisions); const paths = new Set(captured.keys()); const document = structuredClone(current.document); const directory = current.directory
      current.setSaveState('saving')
      await snapshotToOpfs({ document, projectFingerprint: projectFingerprint(document, directory), revision: current.revision, persistedRevision: current.persistedRevision })
      if (directory) {
        if (!await verifyPermission(directory)) throwLocalized('directoryPermissionExpired')
        await writeProject(directory, document, paths)
      }
      useEditor.getState().clearDirty(captured)
      if (directory && !useEditor.getState().dirtyRevisions.size) await clearRecoveryFromOpfs()
    },
    onError: error => { useEditor.getState().setSaveState('error', errorText(error)) },
  }))
  const save = useCallback(() => saveLoop.request(), [saveLoop])

  useEffect(() => { if (state.saveState !== 'dirty') return; const timer = setTimeout(save, 700); return () => clearTimeout(timer) }, [state.document, state.saveState, save])
  useEffect(() => { const update = (event: Event) => { const applyUpdate = (event as CustomEvent<ApplyUpdate>).detail; if (typeof applyUpdate !== 'function') return; applyUpdateRef.current = applyUpdate; setUpdateReady(true) }; addEventListener('plaindeck-update', update); return () => removeEventListener('plaindeck-update', update) }, [])
  useEffect(() => { restoreFromOpfs().then(setRecovery).catch(() => undefined) }, [])
  useEffect(() => { if (!imageNotice) return; const timer = setTimeout(() => setImageNotice(''), 2600); return () => clearTimeout(timer) }, [imageNotice])
  useEffect(() => {
    const paste = (event: ClipboardEvent) => {
      if (guiding) return
      const target = event.target as HTMLElement
      if (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return
      const files = event.clipboardData ? transferredImageFiles(event.clipboardData) : []
      if (!files.length) return; event.preventDefault(); void insertImages(files)
    }
    addEventListener('paste', paste); return () => removeEventListener('paste', paste)
  }, [insertImages, guiding])
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.defaultPrevented || guiding || present || exporting || addingCards || addingTable) return
      if ((event.target as HTMLElement).isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes((event.target as HTMLElement).tagName)) return
      const editor = useEditor.getState(); const mod = event.metaKey || event.ctrlKey
      if (mod && event.key.toLowerCase() === 'z') { event.preventDefault(); if (event.shiftKey) editor.redo(); else editor.undo() }
      if (mod && event.key.toLowerCase() === 'y') { event.preventDefault(); editor.redo() }
      if (mod && event.key.toLowerCase() === 'd') { event.preventDefault(); editor.duplicateSelected() }
      if (mod && event.key.toLowerCase() === 'p') { event.preventDefault(); void print().catch(error => editor.setSaveState('error', errorText(error))); return }
      if (mod && event.key.toLowerCase() === 's') { event.preventDefault(); save() }
      if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); editor.removeSelected() }
      if (event.key.startsWith('Arrow') && editor.selectedIds.length && !mod && !event.altKey) {
        event.preventDefault()
        const amount = event.shiftKey ? 8 : 1
        editor.nudgeSelection(event.key === 'ArrowRight' ? amount : event.key === 'ArrowLeft' ? -amount : 0,
          event.key === 'ArrowDown' ? amount : event.key === 'ArrowUp' ? -amount : 0)
      }
    }
    addEventListener('keydown', key); return () => removeEventListener('keydown', key)
  }, [save, guiding, present, exporting, addingCards, addingTable, print])

  const openDirectory = async () => {
    try { const handle = await pickDirectory(); if (!await verifyPermission(handle, true)) throwLocalized('directoryWritePermission'); state.setSaveState('saving'); const document = await readProject(handle); state.setDocument(document, handle, await resolveDirectoryBriefScope(handle)); setRecovery(await restoreFromOpfs(projectFingerprint(document, handle))) }
    catch (error) { if ((error as DOMException).name !== 'AbortError') state.setSaveState('error', errorText(error)) }
  }
  const newProject = async () => {
    try { const handle = await pickDirectory(); if (!await verifyPermission(handle, true)) throwLocalized('directoryWritePermission'); const document = createSampleDocument(); await initializeProject(handle, document); await clearRecoveryFromOpfs(); setRecovery(null); state.setDocument(document, handle, await resolveDirectoryBriefScope(handle)) }
    catch (error) { if ((error as DOMException).name !== 'AbortError') state.setSaveState('error', errorText(error)) }
  }
  const loadZip = async (file?: File) => { if (!file) return; try { state.setDocument(await importZip(file), null) } catch (error) { state.setSaveState('error', errorText(error)) } }
  const activeSlide = state.document.slides[state.activeSlidePath]
  return <div className="app-shell">
    <Toolbar onOpen={openDirectory} onNew={newProject} onImportZip={() => zipRef.current?.click()} onAddImage={() => imageRef.current?.click()} onAddCards={() => setAddingCards(true)} onAddTable={() => setAddingTable(true)} onGuide={() => setGuiding(true)} onExport={() => setExporting(true)} onPresent={() => setPresent(true)} onSave={save} />
    <input ref={zipRef} hidden type="file" accept=".zip,application/zip" onChange={e => loadZip(e.target.files?.[0])} />
    <input ref={imageRef} hidden type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml" multiple onChange={e => { void insertImages(imageFiles(e.target.files ?? [])); e.currentTarget.value = '' }} />
    <main className="workspace"><SlideList /><section ref={canvasRef} className={`canvas-workspace ${draggingImage ? 'image-drop-active' : ''}`} onDragEnter={event => { if (hasTransferredImages(event.dataTransfer)) setDraggingImage(true) }} onDragOver={event => { if (hasTransferredImages(event.dataTransfer)) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy' } }} onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDraggingImage(false) }} onDrop={event => { const files = transferredImageFiles(event.dataTransfer); setDraggingImage(false); if (!files.length) return; event.preventDefault(); void insertImages(files, canvasPoint(event.clientX, event.clientY)) }}><div className="canvas-label"><span>ARTBOARD</span><SlideNameEditor key={state.activeSlidePath} name={activeSlide.name ?? activeSlide.id} onCommit={state.renameSlide} /></div><CanvasViewport shortcuts={!guiding && !present && !exporting && !addingCards && !addingTable} /><div className="image-drop-overlay"><strong>DROP IMAGE</strong><span>{t.canvas.dropOverlay}</span></div></section><Inspector /></main>
    <StatusBar />
    <PresentationGuide key={state.briefScope} open={guiding} onClose={() => setGuiding(false)} />
    {printDeck}
    {present && <Presentation onClose={() => setPresent(false)} />}{exporting && <ExportDialog onPrint={print} onClose={() => setExporting(false)} />}{addingCards && <SummaryCardsDialog onClose={() => setAddingCards(false)} />}{addingTable && <TableDialog onClose={() => setAddingTable(false)} />}
    {recovery && <div className="recovery-toast"><strong>{t.app.recoveryTitle}</strong><span>{new Date(recovery.savedAt).toLocaleString()}</span><div><button onClick={() => { setRecovery(null); void clearRecoveryFromOpfs() }}>{t.app.recoveryDiscard}</button><button onClick={() => { state.restoreDocument(recovery.document, recovery.revision); setRecovery(null) }}>{t.app.recoveryRestore}</button></div></div>}
    {imageNotice && <div className="image-toast" role="status">{imageNotice}</div>}
    {updateReady && <div className="update-toast">{t.app.updateReady}<button onClick={() => { const applyUpdate = applyUpdateRef.current; if (!applyUpdate) return; setUpdateReady(false); void applyUpdate(true).catch(() => setUpdateReady(true)) }}>{t.app.reload}</button></div>}
  </div>
}
