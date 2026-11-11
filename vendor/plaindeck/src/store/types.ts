import type { DeckDocument, DeckFooter, LayoutPresetId, SlideElement, SlideMotion, SummaryCardContent, TableContent, TableStyle, Theme } from 'plaindeck/core'
import { alignmentPatch } from '../core/geometry'
import type { DirectoryHandle } from '../storage/browserStorage'

/** Canvas zoom limits — single source for the editor zoom range and steps. */
export const ZOOM_INITIAL = .58
export const ZOOM_MIN = .01
export const ZOOM_MAX = 1.25
export const ZOOM_STEP = .05

export type SaveState = 'demo' | 'dirty' | 'saving' | 'saved' | 'error'

export interface Snapshot { document: DeckDocument; label: string }

export interface EditorState {
  document: DeckDocument
  activeSlidePath: string
  selectedIds: string[]
  zoom: number
  saveState: SaveState
  error: string | null
  directory: DirectoryHandle | null
  briefScope: string
  dirtyPaths: Set<string>
  dirtyRevisions: Map<string, number>
  revision: number
  persistedRevision: number
  past: Snapshot[]
  future: Snapshot[]
  setDocument(document: DeckDocument, directory?: DirectoryHandle | null, briefScope?: string): void
  restoreDocument(document: DeckDocument, revision?: number): void
  setActiveSlide(path: string): void
  renameSlide(name: string): void
  select(ids: string[]): void
  setZoom(zoom: number): void
  setSaveState(state: SaveState, error?: string | null): void
  updateFrames(path: string, frames: ReadonlyMap<string, SlideElement['frame']>, label: string): void
  nudgeSelection(dx: number, dy: number): void
  moveLayer(id: string, anchor: string, position: 'before' | 'after'): void
  updateElement(id: string, patch: Partial<SlideElement>, label?: string): void
  addElement(type: SlideElement['type']): void
  addImage(src: string, frame: SlideElement['frame'], alt?: string): string
  removeSelected(): void
  duplicateSelected(): void
  addSlide(layoutId?: LayoutPresetId): void
  addSummarySlide(content: SummaryCardContent, style?: string): void
  addTableSlide(content: TableContent, style?: TableStyle): void
  duplicateSlide(): void
  deleteSlide(): void
  moveSlide(direction: -1 | 1): void
  reorderLayer(direction: -1 | 1): void
  alignSelected(mode: Parameters<typeof alignmentPatch>[1]): void
  updateTheme(patch: Partial<Theme['colors']>): void
  applyTheme(theme: Theme): void
  updateFooter(footer: DeckFooter | null): void
  updateSlideMotion(motion: SlideMotion | null): void
  commitDocument(document: DeckDocument, label: string, dirtyPaths: string[]): void
  undo(): void
  redo(): void
  clearDirty(revisions: Map<string, number>): void
}

export const clone = <T,>(value: T): T => structuredClone(value)
export const uid = (prefix: string) => `${prefix}-${crypto.randomUUID().slice(0, 8)}`
