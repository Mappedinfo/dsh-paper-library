import { useCallback, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { createPortal } from 'react-dom'
import { ArrowLeft, ArrowRight, FilePlus2, FolderOpen, Presentation as PresentationIcon, Upload, RefreshCw } from 'lucide-react'
import type { DeckDocument } from 'plaindeck/core'
import { Toolbar } from '../../vendor/plaindeck/src/components/Toolbar'
import { SlideList } from '../../vendor/plaindeck/src/components/SlideList'
import { SlideSurface } from '../../vendor/plaindeck/src/components/SlideSurface'
import { Inspector } from '../../vendor/plaindeck/src/components/Inspector'
import { StatusBar } from '../../vendor/plaindeck/src/components/StatusBar'
import { SlideNameEditor } from '../../vendor/plaindeck/src/components/SlideNameEditor'
import { SummaryCardsDialog } from '../../vendor/plaindeck/src/components/SummaryCardsDialog'
import { TableDialog } from '../../vendor/plaindeck/src/components/TableDialog'
import { imageDimensions, fitImageFrame, transferredImageFiles, hasTransferredImages } from '../../vendor/plaindeck/src/core/imageImport'
import { moveFrame } from '../../vendor/plaindeck/src/core/geometry'
import { useEditor } from '../../vendor/plaindeck/src/store'
import { useT } from '../../vendor/plaindeck/src/i18n'
import { exportHtml } from '../../vendor/plaindeck/src/export/html'
import { saveBlob } from '../../vendor/plaindeck/src/export/download'
import { waitForPrintResources } from '../../vendor/plaindeck/src/export/print'
import { createProjectZip } from '../../vendor/plaindeck/src/storage/zipStorage'
import { api, downloadPptx } from './api'
import { Guide } from './Guide'
import { readAsset, releaseAssets, writeImageAsset, MAX_IMAGE_BYTES, type DirectoryHandle } from './storage'
import { inspectZip } from './zip'
import { assertSafeDocument } from './safety'
import { createTransitionGuard } from './transition'
import '../../vendor/plaindeck/src/styles/app.css'
import './slides.css'

type Project = { id: string; title: string; slide_count: number; updated_at: string }
type Loaded = { project: Project; document: DeckDocument; revision: string | number }
type Active = { id: string; revision: string | number; handle: DirectoryHandle }
const types = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
const pptxWarnings: Record<string, string> = {
  static_motion: '动画和镜头使用静态画面', table_rotation: '表格保留为水平布局',
  color_fallback: '无法解析的颜色使用默认值', footer_space: '页脚空间不足，已省略页脚',
  image_first_frame: '动态图像转换时仅保留首帧',
}
const templates = [
  { id: 'blank', label: '空白', detail: '从一张封面开始，自由组织内容。', pages: 1 },
  { id: 'paper-reading', label: '论文阅读', detail: '围绕问题、贡献、证据与局限展开。', pages: 8 },
  { id: 'nature-methods', label: '方法汇报', detail: '依次呈现问题、流程、图表与结论。', pages: 7 },
  { id: 'data-story', label: '数据叙事', detail: '用关键数字和对照组织判断。', pages: 6 },
  { id: 'course-lecture', label: '课程', detail: '从学习目标到概念、例证与回顾。', pages: 6 },
  { id: 'flowchart', label: '流程', detail: '用流程、分支、回环和清单解释过程。', pages: 5 },
  { id: 'pitch', label: '项目提案', detail: '说明问题、方案、证据与下一步。', pages: 5 },
  { id: 'showcase', label: '展示', detail: '用于介绍、报告与作品展示的叙事骨架。', pages: 5 },
] as const

function BackToLibrary({ onClick }: { onClick(): void }) {
  return <button type="button" className="slides-back" onClick={onClick}><ArrowLeft size={16} aria-hidden="true" />返回文献库</button>
}
function BackToDsh({ onClick, disabled = false }: { onClick(): void; disabled?: boolean }) {
  if (window.parent === window && !location.pathname.startsWith('/api/paper-library/')) return null
  return <button type="button" className="slides-back" disabled={disabled} onClick={onClick}><ArrowLeft size={16} aria-hidden="true" />返回 DSH</button>
}

function projectDate(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'short', day: 'numeric' }).format(date)
}

function Presentation({ onClose, onDsh, busy }: { onClose(): void; onDsh(): void; busy: boolean }) {
  const { document: deck, activeSlidePath } = useEditor()
  const [index, setIndex] = useState(Math.max(0, deck.deck.slides.indexOf(activeSlidePath)))
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
      if (['ArrowRight', 'ArrowDown', ' '].includes(event.key)) { event.preventDefault(); setIndex(i => Math.min(deck.deck.slides.length - 1, i + 1)) }
      if (['ArrowLeft', 'ArrowUp'].includes(event.key)) { event.preventDefault(); setIndex(i => Math.max(0, i - 1)) }
    }
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key)
  }, [deck.deck.slides.length, onClose])
  const zoom = Math.min(window.innerWidth / deck.deck.canvas.width, window.innerHeight / deck.deck.canvas.height) * .94
  return <div className="presentation" role="dialog" aria-label="放映"><div className="presentation-controls"><BackToDsh onClick={onDsh} disabled={busy} /><button className="presentation-close" onClick={onClose}>退出放映</button></div><div className="presentation-stage" style={{ width: deck.deck.canvas.width * zoom, height: deck.deck.canvas.height * zoom }}><SlideSurface slide={deck.slides[deck.deck.slides[index]]} interactive={false} zoom={zoom} /></div><div className="presentation-nav"><button onClick={() => setIndex(i => Math.max(0, i - 1))}>上一页</button><span>{index + 1} / {deck.deck.slides.length}</span><button onClick={() => setIndex(i => Math.min(deck.deck.slides.length - 1, i + 1))}>下一页</button></div></div>
}

function ToolbarContext({ title, onLibrary, onDsh, busy }: { title: string; onLibrary(): void; onDsh(): void; busy: boolean }) {
  const [host, setHost] = useState<Element | null>(null)
  const { locale } = useT()
  useEffect(() => {
    setHost(document.querySelector('.toolbar-spacer'))
    const buttons = document.querySelectorAll<HTMLButtonElement>('.toolbar .project-tools .tool-button')
    const labels = locale === 'zh' ? ['新建演示文稿', '打开演示项目'] : ['New presentation', 'Open presentation']
    for (let index = 0; index < 2; index++) if (buttons[index]) { buttons[index].title = labels[index]; buttons[index].setAttribute('aria-label', labels[index]) }
  }, [locale])
  return host ? createPortal(<div className="slides-toolbar-context"><span title={title}>{title}</span><BackToLibrary onClick={onLibrary} /><BackToDsh onClick={onDsh} disabled={busy} /></div>, host) : null
}

function App() {
  const state = useEditor()
  const [projects, setProjects] = useState<Project[]>([]), [offset, setOffset] = useState<number | null>(null)
  const [chooser, setChooser] = useState(true), [title, setTitle] = useState(''), [template, setTemplate] = useState('blank')
  const [message, setMessage] = useState('读取演示文稿…'), [busy, setBusy] = useState(false)
  const [listLoading, setListLoading] = useState(true), [listError, setListError] = useState('')
  const [guiding, setGuiding] = useState(false), [present, setPresent] = useState(false), [exporting, setExporting] = useState(false)
  const [exportBusy, setExportBusy] = useState(false), [exportError, setExportError] = useState('')
  const [cards, setCards] = useState(false), [table, setTable] = useState(false), [dragging, setDragging] = useState(false)
  const active = useRef<Active | null>(null), saving = useRef<Promise<boolean> | null>(null), blocked = useRef(false), assetBusy = useRef(false), briefDirty = useRef(false), heldZip = useRef<File | null>(null)
  const transition = useRef(createTransitionGuard<Active | null>())
  const imageRef = useRef<HTMLInputElement>(null), zipRef = useRef<HTMLInputElement>(null), canvasRef = useRef<HTMLElement>(null)

  async function list(next: number | null = null) {
    setListLoading(true); setListError('')
    try {
      const result = await api<{ projects: Project[]; next_offset: number | null }>('slides_list', { offset: next ?? 0, limit: 50 })
      setProjects(current => next == null ? result.projects : [...current, ...result.projects]); setOffset(result.next_offset ?? null); setMessage('')
    } catch (error: any) { setListError(error.message || '无法读取项目列表'); setMessage('') }
    finally { setListLoading(false) }
  }
  useEffect(() => {
    const project = new URLSearchParams(location.search).get('project')
    void (async () => { await list(); if (project && /^pd-[a-f0-9]{32}$/.test(project)) await openProject(project) })()
    const navigate = (event: MessageEvent) => {
      if (event.origin !== location.origin || event.source !== window.parent || event.data?.type !== 'paper-library:open-slide-project' || typeof event.data.id !== 'string' || !/^pd-[a-f0-9]{32}$/.test(event.data.id)) return
      if (active.current?.id === event.data.id) return
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
      queueMicrotask(() => void openProject(event.data.id))
    }
    window.addEventListener('message', navigate)
    return () => window.removeEventListener('message', navigate)
  }, [])
  useEffect(() => {
    const protect = (event: BeforeUnloadEvent) => {
      if (useEditor.getState().dirtyRevisions.size || saving.current || assetBusy.current || briefDirty.current) { event.preventDefault(); event.returnValue = '' }
    }
    window.addEventListener('beforeunload', protect); return () => window.removeEventListener('beforeunload', protect)
  }, [])

  const save = useCallback((retry = false): Promise<boolean> => {
    if (saving.current) return saving.current
    if (blocked.current && !retry) return Promise.resolve(false)
    if (retry) blocked.current = false
    saving.current = (async () => {
      while (true) {
        const current = useEditor.getState(), selected = active.current
        if (!selected) return false
        if (!current.dirtyRevisions.size) return true
        const id = selected.id, expected = selected.revision, captured = new Map(current.dirtyRevisions), document = structuredClone(current.document)
        current.setSaveState('saving')
        try {
          assertSafeDocument(document)
          const result = await api<{ project: Project; revision: string | number }>('slides_save', { id, document, expected_revision: expected })
          if (active.current !== selected) return false
          selected.revision = result.revision
          useEditor.getState().clearDirty(captured)
          setProjects(list => list.map(item => item.id === id ? result.project : item))
        } catch (error: any) {
          if (active.current === selected) {
            blocked.current = true
            const conflict = error.code === 'STATE_CONFLICT' ? '其他窗口已修改此项目。' : ''
            useEditor.getState().setSaveState('error', `${conflict}${error.message}；本窗口草稿保留，可重试或导出。`)
          }
          return false
        }
      }
    })().finally(() => { saving.current = null })
    return saving.current
  }, [])
  useEffect(() => {
    if (state.saveState !== 'dirty' || blocked.current || !active.current) return
    const timer = setTimeout(() => void save(), 700); return () => clearTimeout(timer)
  }, [state.document, state.saveState, save])

  async function canSwitch(): Promise<boolean> {
    if (assetBusy.current) { setMessage('请等待当前图片操作完成。'); return false }
    if (briefDirty.current) { setMessage('请先保存制作简报，或在指导窗口导出草稿后重试。'); return false }
    if (!active.current) return true
    if (saving.current && !await saving.current) { setMessage('草稿尚未保存；请重试或导出。'); return false }
    if (useEditor.getState().dirtyRevisions.size) {
      if (blocked.current || !await save()) { setMessage('草稿尚未保存；请先重试或导出。'); return false }
    }
    return true
  }
  function reserveSwitch(): boolean {
    if (assetBusy.current || !transition.current.reserve()) { setMessage('请等待当前操作完成。'); return false }
    setBusy(true); return true
  }
  function endSwitch() { transition.current.release(); setBusy(false) }
  function unchanged(owner: Active | null, revision: number): boolean {
    const current = useEditor.getState()
    return transition.current.matches({ owner, revision, clean: true }, { owner: active.current, revision: current.revision, clean: !current.dirtyRevisions.size && !briefDirty.current })
  }
  function install(value: Loaded) {
    assertSafeDocument(value.document)
    const previous = active.current?.handle
    const handle = { id: value.project.id, name: value.project.title }
    active.current = { id: value.project.id, revision: value.revision, handle }
    blocked.current = false; briefDirty.current = false
    useEditor.getState().setDocument(value.document, handle as any, value.project.id)
    releaseAssets(previous); setChooser(false); setGuiding(false); setMessage('')
  }
  async function openProject(id: string) {
    if (!reserveSwitch()) return
    try {
      if (!await canSwitch()) return
      const owner = active.current, revision = useEditor.getState().revision
      const value = await api<Loaded>('slides_get', { id })
      if (!unchanged(owner, revision)) { setMessage('当前草稿在打开期间发生变化，已保留；请保存后重试。'); return }
      install(value)
    } catch (error: any) { setMessage(`打开失败：${error.message}`) }
    finally { endSwitch() }
  }
  async function create() {
    if (!reserveSwitch()) return
    try {
      if (!await canSwitch()) return
      const owner = active.current, revision = useEditor.getState().revision
      const value = await api<Loaded>('slides_create', { title: title.trim() || '未命名演示文稿', template })
      setProjects(list => [value.project, ...list])
      if (!unchanged(owner, revision)) { setMessage('新项目已建立，当前草稿在等待期间发生变化；请保存后从列表打开。'); return }
      install(value)
    }
    catch (error: any) { setMessage(`新建失败：${error.message}`) }
    finally { endSwitch() }
  }
  async function importZip(file: File | null) {
    if (!file || !reserveSwitch()) return
    try {
      if (!await canSwitch()) return
      const owner = active.current, revision = useEditor.getState().revision
      heldZip.current = file
      const incoming = await inspectZip(file)
      const created = await api<Loaded>('slides_create', { title: incoming.document.deck.title || '导入的演示文稿', template: 'blank' })
      setProjects(list => [created.project, ...list])
      const handle = { id: created.project.id, name: created.project.title }
      try {
        const mapping = new Map<string, string>()
        for (const [path, asset] of incoming.assets) mapping.set(path, await writeImageAsset(handle, new File([asset.bytes], path.startsWith('data:') ? 'embedded-image' : path.split('/').pop() || 'image', { type: asset.mime })))
        for (const slide of Object.values(incoming.document.slides)) for (const element of slide.elements) if (element.type === 'image' && mapping.has(element.src)) element.src = mapping.get(element.src)!
        if (!unchanged(owner, revision)) { releaseAssets(handle); setMessage('当前草稿在导入期间发生变化，已保留；原 ZIP 可重试。'); return }
        install({ ...created, document: incoming.document }); releaseAssets(handle)
        const paths = ['deck.json', incoming.document.deck.theme, ...incoming.document.deck.slides]
        useEditor.setState({ dirtyPaths: new Set(paths), dirtyRevisions: new Map(paths.map(path => [path, 1])), revision: 1, saveState: 'dirty' })
        if (!await save(true)) setMessage('导入内容尚未保存；草稿保留，可重试或导出。')
        else { heldZip.current = null; setMessage('ZIP 已导入。') }
      } catch (error) { releaseAssets(handle); throw error }
    } catch (error: any) { setMessage(`导入失败：${error.message}。原 ZIP 保留，可重试。`) }
    finally { endSwitch() }
  }

  const insertImages = useCallback(async (files: File[], point?: { x: number; y: number }) => {
    const selected = active.current
    if (!selected || !files.length || assetBusy.current) return
    assetBusy.current = true; setBusy(true)
    try {
      for (const [index, file] of files.entries()) {
        if (!types.has(file.type)) throw new Error('仅支持 PNG、JPEG、WebP 和 GIF；SVG 暂不支持。')
        if (file.size > MAX_IMAGE_BYTES) throw new Error('图片超过 8 MiB。')
        const dimensions = await imageDimensions(file), src = await writeImageAsset(selected.handle, file)
        if (active.current !== selected) return
        const editor = useEditor.getState(), target = point ? { x: point.x + index * 28, y: point.y + index * 28 } : undefined
        editor.addImage(src, fitImageFrame(dimensions, editor.document.deck.canvas, target), file.name || '图片')
      }
    } catch (error: any) { useEditor.getState().setSaveState('error', `图片未插入：${error.message}`) }
    finally { assetBusy.current = false; setBusy(false) }
  }, [])
  const fitCanvas = useCallback(() => {
    const scroller = canvasRef.current?.querySelector<HTMLElement>('.canvas-scroller')
    if (!scroller) return
    const canvas = useEditor.getState().document.deck.canvas, padding = getComputedStyle(scroller)
    const width = scroller.clientWidth - parseFloat(padding.paddingLeft) - parseFloat(padding.paddingRight), height = scroller.clientHeight - parseFloat(padding.paddingTop) - parseFloat(padding.paddingBottom)
    if (width > 0 && height > 0) useEditor.getState().setZoom(Math.min(width / canvas.width, height / canvas.height, .9))
  }, [])
  useEffect(() => {
    if (chooser || !active.current) return
    const observer = new ResizeObserver(fitCanvas); if (canvasRef.current) observer.observe(canvasRef.current); fitCanvas(); return () => observer.disconnect()
  }, [chooser, fitCanvas, state.document.deck.canvas.width, state.document.deck.canvas.height])
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (chooser || guiding || present || exporting) return
      const target = event.target as HTMLElement, mod = event.metaKey || event.ctrlKey
      if (mod && event.key.toLowerCase() === 's') { event.preventDefault(); void save(true); return }
      if (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return
      const editor = useEditor.getState()
      if (mod && event.key.toLowerCase() === 'z') { event.preventDefault(); event.shiftKey ? editor.redo() : editor.undo() }
      if (mod && event.key.toLowerCase() === 'y') { event.preventDefault(); editor.redo() }
      if (mod && event.key.toLowerCase() === 'd') { event.preventDefault(); editor.duplicateSelected() }
      if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); editor.removeSelected() }
      if (event.key.startsWith('Arrow') && editor.selectedIds.length === 1) {
        const element = editor.document.slides[editor.activeSlidePath].elements.find(item => item.id === editor.selectedIds[0]); if (!element) return
        event.preventDefault(); const amount = event.shiftKey ? 8 : 1
        const dx = event.key === 'ArrowRight' ? amount : event.key === 'ArrowLeft' ? -amount : 0, dy = event.key === 'ArrowDown' ? amount : event.key === 'ArrowUp' ? -amount : 0
        editor.updateElement(element.id, { frame: moveFrame(element.frame, dx, dy, editor.document.deck.canvas, 1) } as never, '移动元素')
      }
    }
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key)
  }, [chooser, guiding, present, exporting, save])
  useEffect(() => {
    const paste = (event: ClipboardEvent) => {
      if (chooser || guiding || !event.clipboardData) return
      const target = event.target as HTMLElement
      if (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return
      const files = transferredImageFiles(event.clipboardData); if (!files.length) return
      event.preventDefault(); void insertImages(files)
    }
    window.addEventListener('paste', paste); return () => window.removeEventListener('paste', paste)
  }, [chooser, guiding, insertImages])

  function openExport() {
    setExportError('')
    setExporting(true)
  }
  async function exportFile(format: 'html' | 'zip' | 'pdf' | 'pptx') {
    const selected = active.current; if (!selected || exportBusy) return
    setExportBusy(true)
    setExportError('')
    try {
      const document = useEditor.getState().document
      assertSafeDocument(document)
      if (format === 'html') await exportHtml(document, selected.handle as any)
      if (format === 'zip') { const zip = await createProjectZip(document, path => readAsset(selected.handle, path)); saveBlob(await zip.generateAsync({ type: 'blob' }), `${document.deck.id}.zip`) }
      if (format === 'pdf') { await waitForPrintResources(globalThis.document.querySelector('.print-deck') ?? globalThis.document); window.print() }
      if (format === 'pptx') {
        const { blob, filename, warnings } = await downloadPptx(selected.id, document)
        saveBlob(blob, filename)
        if (warnings.length) setMessage(`PPTX 已下载。${warnings.map(code => pptxWarnings[code] ?? code).join('；')}。`)
      }
      setExporting(false)
    } catch (error: any) { setExportError(`导出失败：${error.message}`) }
    finally { setExportBusy(false) }
  }
  const openChooser = async () => {
    if (!reserveSwitch()) return
    try { if (await canSwitch()) { setChooser(true); await list() } } finally { endSwitch() }
  }
  const openLibrary = async () => {
    if (!reserveSwitch()) return
    try { if (await canSwitch()) location.assign(new URL('./', location.href).href) } finally { endSwitch() }
  }
  const returnToDsh = async () => {
    const embedded = window.parent !== window
    if (!embedded && !location.pathname.startsWith('/api/paper-library/') || !reserveSwitch()) return
    try {
      if (!await canSwitch()) { setPresent(false); return }
      if (document.fullscreenElement) await document.exitFullscreen()
      if (embedded) window.parent.postMessage({ type: 'paper-library:return-to-dsh', version: 1 }, location.origin)
      else location.assign('/')
    } catch (error: any) { setPresent(false); setMessage(`无法返回 DSH：${error.message || error}。草稿仍在当前页面。`) }
    finally { endSwitch() }
  }
  const reloadLatest = async () => {
    if (!active.current || saving.current || assetBusy.current) return
    if (!window.confirm('将放弃本窗口未保存的演示草稿，重新读取资料库中的版本。是否继续？')) return
    if (!reserveSwitch()) return
    const owner = active.current, revision = useEditor.getState().revision
    try {
      const value = await api<Loaded>('slides_get', { id: owner.id })
      if (active.current !== owner || useEditor.getState().revision !== revision || briefDirty.current) { setMessage('读取期间草稿发生变化，已保留。'); return }
      install(value)
    } catch (error: any) { useEditor.getState().setSaveState('error', `重新读取失败：${error.message}；草稿保留。`) }
    finally { endSwitch() }
  }
  const slide = state.document.slides[state.activeSlidePath]
  const selectedTemplate = templates.find(item => item.id === template) || templates[0]
  const canvasPoint = (event: React.DragEvent) => {
    const surface = canvasRef.current?.querySelector<HTMLElement>('.canvas-sized > .slide-surface')
    if (!surface) return undefined
    const rect = surface.getBoundingClientRect(), canvas = useEditor.getState().document.deck.canvas
    return { x: (event.clientX - rect.left) * canvas.width / rect.width, y: (event.clientY - rect.top) * canvas.height / rect.height }
  }
  return <>
    {chooser ? <main className="slides-chooser" inert={busy || undefined}>
      <header className="slides-chooser-header"><div className="slides-chooser-identity"><span className="slides-chooser-mark"><PresentationIcon size={19} aria-hidden="true" /></span><div><h1>演示文稿</h1><p>创建新项目，或继续编辑已有演示。</p></div></div><div className="slides-chooser-navigation">{active.current && <button type="button" disabled={busy} onClick={() => setChooser(false)}>返回编辑</button>}<BackToLibrary onClick={() => void openLibrary()} /><BackToDsh onClick={() => void returnToDsh()} disabled={busy} /></div></header>
      {message && !listLoading && <p className="slides-chooser-message" role="status">{message}</p>}
      <div className="slides-chooser-grid">
        <section className="slides-create" aria-labelledby="slides-create-title"><div className="slides-section-heading"><div><h2 id="slides-create-title">新建演示文稿</h2><p>选择适合内容的起点，之后都可以编辑。</p></div><FilePlus2 size={19} aria-hidden="true" /></div>
          <label>名称 <input value={title} onChange={event => setTitle(event.target.value)} placeholder="未命名演示文稿" /></label>
          <label>模板 <select value={template} onChange={event => setTemplate(event.target.value)}>{templates.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
          <div className="slides-template-preview"><div className="slides-template-thumbnail" aria-hidden="true"><span /><strong /><i /><i /></div><div><strong>{selectedTemplate.label}</strong><p>{selectedTemplate.detail}</p><small>{selectedTemplate.pages} 页起稿</small></div></div>
          <div className="slides-create-actions"><button type="button" className="slides-primary" disabled={busy} onClick={() => void create()}><FilePlus2 size={16} aria-hidden="true" />新建</button><button type="button" disabled={busy} onClick={() => zipRef.current?.click()}><Upload size={16} aria-hidden="true" />导入 ZIP</button>{heldZip.current && <button type="button" disabled={busy} onClick={() => void importZip(heldZip.current)}>重试导入</button>}</div>
        </section>
        <section className="slides-recent" aria-labelledby="slides-projects-title"><div className="slides-section-heading"><div><h2 id="slides-projects-title">已有项目</h2><p>{projects.length ? `已加载 ${projects.length} 个项目` : '打开保存在当前资料库中的演示文稿。'}</p></div><FolderOpen size={19} aria-hidden="true" /></div>
          {listLoading && <p className="slides-list-state" role="status">正在读取项目…</p>}
          {listError && <div className="slides-list-state slides-list-error" role="alert"><span>读取失败：{listError}</span><button type="button" disabled={busy} onClick={() => void list()}><RefreshCw size={15} aria-hidden="true" />重新读取</button></div>}
          <ul className="slides-projects">{projects.map(project => <li key={project.id}><button type="button" disabled={busy} onClick={() => void openProject(project.id)}><span className="slides-project-icon"><PresentationIcon size={17} aria-hidden="true" /></span><span className="slides-project-copy"><strong>{project.title}</strong><small>{project.slide_count} 页 · 更新于 {projectDate(project.updated_at)}</small></span><ArrowRight size={16} aria-hidden="true" /></button></li>)}</ul>
          {offset !== null && <button type="button" className="slides-more" disabled={busy || listLoading} onClick={() => void list(offset)}>加载更多</button>}
          {!projects.length && !listLoading && !listError && <div className="slides-list-state slides-empty"><PresentationIcon size={20} aria-hidden="true" /><p>还没有演示文稿。<br />在左侧选择模板新建，或导入 ZIP。</p></div>}
        </section>
      </div>
    </main> : <div className="app-shell" inert={busy || undefined}>
      <Toolbar onOpen={() => void openChooser()} onNew={() => void openChooser()} onImportZip={() => zipRef.current?.click()} onAddImage={() => imageRef.current?.click()} onAddCards={() => setCards(true)} onAddTable={() => setTable(true)} onGuide={() => setGuiding(true)} onExport={openExport} onPresent={() => setPresent(true)} onSave={() => void save(true)} />
      <ToolbarContext title={state.document.deck.title} onLibrary={() => void openLibrary()} onDsh={() => void returnToDsh()} busy={busy} />
      {message && <div className="slides-navigation-notice" role="status"><span>{message}</span><button type="button" aria-label="关闭提示" onClick={() => setMessage('')}>×</button></div>}
      <main className="workspace"><SlideList /><section ref={canvasRef} className={`canvas-workspace ${dragging ? 'image-drop-active' : ''}`} onDragEnter={event => { if (hasTransferredImages(event.dataTransfer)) setDragging(true) }} onDragOver={event => { if (hasTransferredImages(event.dataTransfer)) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy' } }} onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false) }} onDrop={event => { const files = transferredImageFiles(event.dataTransfer); setDragging(false); if (files.length) { event.preventDefault(); void insertImages(files, canvasPoint(event)) } }}>
        <div className="canvas-label"><span>画布</span><SlideNameEditor key={state.activeSlidePath} name={slide.name ?? slide.id} onCommit={state.renameSlide} /></div><div className="canvas-scroller"><div className="canvas-sized" style={{ width: state.document.deck.canvas.width * state.zoom, height: state.document.deck.canvas.height * state.zoom }}><SlideSurface slide={slide} zoom={state.zoom} /></div></div><div className="image-drop-overlay"><strong>添加图片</strong><span>将图片拖到画布</span></div></section><Inspector /></main>
      <StatusBar />
      {state.saveState === 'error' && <div className="slides-save-warning" role="alert"><span>{state.error}</span><button onClick={() => void save(true)}>重试保存</button><button onClick={openExport}>导出草稿</button>{state.dirtyRevisions.size > 0 && <button onClick={() => void reloadLatest()}>放弃草稿并重新读取</button>}</div>}
      <div className="print-deck">{state.document.deck.slides.map(path => <div className="print-page" key={path}><SlideSurface slide={state.document.slides[path]} interactive={false} zoom={1} /></div>)}</div>
    </div>}
    <input ref={zipRef} hidden type="file" accept=".zip,application/zip" onChange={event => { const file = event.target.files?.[0] ?? null; event.currentTarget.value = ''; void importZip(file) }} />
    <input ref={imageRef} hidden type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple onChange={event => { const files = Array.from(event.target.files ?? []); event.currentTarget.value = ''; void insertImages(files) }} />
    {guiding && active.current && <Guide projectId={active.current.id} onClose={() => setGuiding(false)} onDirty={value => { briefDirty.current = value }} />}
    {present && <Presentation onClose={() => setPresent(false)} onDsh={() => void returnToDsh()} busy={busy} />}
    {cards && <SummaryCardsDialog onClose={() => setCards(false)} />}{table && <TableDialog onClose={() => setTable(false)} />}
    {exporting && <div className="slides-overlay"><section className="slides-dialog" role="dialog" aria-modal="true" aria-label="导出">
      <h2>导出</h2><p>导出包含当前草稿。PDF 通过系统打印保存。</p>
      <button disabled={exportBusy} onClick={() => void exportFile('pptx')}>PowerPoint（.pptx）</button>
      <button disabled={exportBusy} onClick={() => void exportFile('html')}>HTML</button>
      <button disabled={exportBusy} onClick={() => void exportFile('zip')}>ZIP 项目</button>
      <button disabled={exportBusy} onClick={() => void exportFile('pdf')}>打印为 PDF</button>
      <button disabled={exportBusy} onClick={() => setExporting(false)}>关闭</button>
      {exportBusy && <p role="status">正在准备导出…</p>}{exportError && <p role="alert">{exportError}</p>}
    </section></div>}
  </>
}

const root = document.getElementById('root')
if (root) createRoot(root).render(<App />)
