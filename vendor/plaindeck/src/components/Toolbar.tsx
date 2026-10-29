import { BookOpen, Box, Download, FilePlus2, FolderOpen, Image, Languages, LayoutDashboard, Minus, MousePointer2, Play, Redo2, Save, Square, Table2, Type, Undo2 } from 'lucide-react'
import type { DeckLocale } from 'plaindeck/core'
import { useEditor } from '../store'
import { createSampleDocument } from '../core/sample'
import { peekDeckLocaleOverride } from '../core/language'
import { setLocale, useT } from '../i18n'
import { version as plainDeckVersion } from '../../packages/plaindeck/package.json'

interface Props { onOpen: () => void; onNew: () => void; onImportZip: () => void; onAddImage: () => void; onAddCards: () => void; onAddTable: () => void; onGuide: () => void; onExport: () => void; onPresent: () => void; onSave: () => void }
const ToolButton = ({ label, children, onClick, disabled, accent = false }: { label: string; children: React.ReactNode; onClick?: () => void; disabled?: boolean; accent?: boolean }) => <button className={`tool-button ${accent ? 'accent' : ''}`} title={label} aria-label={label} onClick={onClick} disabled={disabled}>{children}</button>

/** Cycle auto (browser-detected) → English → Chinese → auto. */
function nextManualLocale(override: DeckLocale | null): DeckLocale | null {
  if (!override) return 'en'
  return override === 'en' ? 'zh' : null
}

export function Toolbar({ onOpen, onNew, onImportZip, onAddImage, onAddCards, onAddTable, onGuide, onExport, onPresent, onSave }: Props) {
  const { addElement, undo, redo, past, future, selectedIds, reorderLayer } = useEditor()
  const { t, locale } = useT()
  const override = peekDeckLocaleOverride()
  const cycleLanguage = () => {
    const target = nextManualLocale(peekDeckLocaleOverride()) // auto → en → zh → auto
    if (target === override && target !== null) return
    setLocale(target)
    const editor = useEditor.getState()
    // A pristine sample deck follows the language switch immediately.
    if (editor.briefScope === 'sample' && !editor.directory && !editor.dirtyRevisions.size && !editor.past.length) editor.setDocument(createSampleDocument(target ?? undefined), null, editor.briefScope)
  }
  return <header className="toolbar">
    <div className="brand"><span className="brand-mark">P/D</span><span>PlainDeck</span><small title="PlainDeck core version">v{plainDeckVersion}</small></div>
    <div className="tool-group project-tools">
      <ToolButton label={t.toolbar.newProject} onClick={onNew}><FilePlus2 /></ToolButton>
      <ToolButton label={t.toolbar.openDirectory} onClick={onOpen}><FolderOpen /></ToolButton>
      <button className="zip-import" onClick={onImportZip}>{t.toolbar.importZip}</button>
      <ToolButton label={t.toolbar.saveNow} onClick={onSave}><Save /></ToolButton>
    </div>
    <div className="tool-divider" />
    <div className="tool-group">
      <ToolButton label={t.toolbar.selectTool}><MousePointer2 /></ToolButton>
      <ToolButton label={t.toolbar.addText} onClick={() => addElement('text')}><Type /></ToolButton>
      <ToolButton label={t.toolbar.insertImage} onClick={onAddImage}><Image /></ToolButton>
      <ToolButton label={t.toolbar.addSummaryCards} onClick={onAddCards}><LayoutDashboard /></ToolButton>
      <ToolButton label={t.toolbar.addNativeTable} onClick={onAddTable}><Table2 /></ToolButton>
      <ToolButton label={t.toolbar.addRectangle} onClick={() => addElement('shape')}><Square /></ToolButton>
      <ToolButton label={t.toolbar.addLine} onClick={() => addElement('line')}><Minus /></ToolButton>
    </div>
    <div className="tool-divider" />
    <div className="tool-group">
      <ToolButton label={t.toolbar.undo} onClick={undo} disabled={!past.length}><Undo2 /></ToolButton>
      <ToolButton label={t.toolbar.redo} onClick={redo} disabled={!future.length}><Redo2 /></ToolButton>
      <ToolButton label={t.toolbar.layerBackward} onClick={() => reorderLayer(-1)} disabled={selectedIds.length !== 1}><Box className="layer-back" /></ToolButton>
      <ToolButton label={t.toolbar.layerForward} onClick={() => reorderLayer(1)} disabled={selectedIds.length !== 1}><Box /></ToolButton>
    </div>
    <div className="toolbar-spacer" />
    <button className="guide-action" onClick={onGuide} aria-haspopup="dialog"><BookOpen /> <span>{t.toolbar.presentationGuide}</span></button>
    <button className="language-toggle" data-auto={!override} onClick={cycleLanguage} title={`${t.toolbar.language} · ${override ?? t.toolbar.languageAuto}`} aria-label={`${t.toolbar.language} · ${locale}`}>
      <Languages /> <strong>{locale === 'zh' ? t.toolbar.languageZh : t.toolbar.languageEn}</strong>
    </button>
    <button className="text-action" onClick={onExport}><Download /> {t.toolbar.export}</button>
    <button className="present-action" onClick={onPresent}><Play fill="currentColor" /> {t.toolbar.present}</button>
  </header>
}
