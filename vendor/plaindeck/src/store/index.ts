import { create } from 'zustand'
import { applyOperations, layoutPresetsFor, type DeckOperation, type SlideElement } from 'plaindeck/core'
import { createSampleDocument } from '../core/sample'
import { resolveDeckLocale } from '../core/language'
import { PLACEHOLDER_IMAGE_SRC } from '../core/placeholder'
import { alignmentPatch } from '../core/geometry'
import { getMessages } from '../i18n'
import { clone, uid, ZOOM_INITIAL, ZOOM_MAX, ZOOM_MIN, ZOOM_STEP, type EditorState } from './types'
import { createHistorySlice } from './history'

export { ZOOM_INITIAL, ZOOM_MIN, ZOOM_MAX, ZOOM_STEP }
export type { EditorState, SaveState, Snapshot } from './types'

const deckLocale = resolveDeckLocale()
const initialDocument = createSampleDocument(deckLocale)

function commitOperations(state: EditorState, operations: DeckOperation[], label: string) {
  const result = applyOperations(state.document, operations, { locale: deckLocale })
  state.commitDocument(result.document, label, result.changedPaths)
  return result
}

export const useEditor = create<EditorState>((set, get) => ({
  document: initialDocument, activeSlidePath: initialDocument.deck.slides[0], selectedIds: [], zoom: ZOOM_INITIAL,
  saveState: 'demo', error: null, directory: null, briefScope: 'sample', dirtyPaths: new Set(), dirtyRevisions: new Map(), revision: 0, persistedRevision: 0, past: [], future: [],
  setDocument: (document, directory = null, briefScope = crypto.randomUUID()) => set({ document, directory, briefScope, activeSlidePath: document.deck.slides[0], selectedIds: [], past: [], future: [], dirtyPaths: new Set(), dirtyRevisions: new Map(), revision: 0, persistedRevision: 0, saveState: directory ? 'saved' : 'demo', error: null }),
  restoreDocument: (document, revision = 1) => {
    const paths = ['deck.json', document.deck.theme, ...document.deck.slides]
    set({ document, directory: null, briefScope: crypto.randomUUID(), activeSlidePath: document.deck.slides[0], selectedIds: [], past: [], future: [], dirtyPaths: new Set(paths), dirtyRevisions: new Map(paths.map(path => [path, revision])), revision, persistedRevision: 0, saveState: 'dirty', error: null })
  },
  setActiveSlide: activeSlidePath => set({ activeSlidePath, selectedIds: [] }),
  select: selectedIds => set({ selectedIds }),
  setZoom: zoom => set({ zoom: Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom)) }),
  setSaveState: (saveState, error = null) => set({ saveState, error }),
  ...createHistorySlice(set),

  renameSlide: name => {
    const state = get(); const next = name.trim(); const slide = state.document.slides[state.activeSlidePath]
    if (!next || next === (slide.name ?? slide.id)) return
    commitOperations(state, [{ op: 'rename-slide', slide: state.activeSlidePath, name: next }], getMessages().store.renameSlide)
  },
  updateElement: (id, patch, label) => {
    const state = get(); const slide = state.document.slides[state.activeSlidePath]
    if (!slide.elements.some(element => element.id === id)) return
    commitOperations(state, [{ op: 'set-element', slide: state.activeSlidePath, element: id, patch }], label ?? getMessages().store.editElement)
  },
  addElement: type => {
    const state = get(); const labels = getMessages().store
    let element: SlideElement
    if (type === 'text') element = { id: uid('text'), type, frame: { x: 160, y: 160, w: 600, h: 120 }, text: labels.addTextPlaceholder, fontSize: 36 }
    else if (type === 'image') element = { id: uid('image'), type, frame: { x: 200, y: 200, w: 560, h: 360 }, src: PLACEHOLDER_IMAGE_SRC, fit: 'cover', alt: 'placeholder' }
    else if (type === 'shape') element = { id: uid('shape'), type, frame: { x: 240, y: 220, w: 420, h: 240 }, shape: 'rounded-rectangle', fill: state.document.theme.colors.accent, radius: 24, text: labels.addShapePlaceholder, textColor: state.document.theme.colors.background, fontSize: 30, fontWeight: 700, align: 'center', verticalAlign: 'middle' }
    else if (type === 'table') element = { id: uid('table'), type, frame: { x: 120, y: 220, w: 1360, h: 440 }, cells: [labels.tableSample.header, labels.tableSample.baseline, labels.tableSample.ours], headerRows: 1, columnWidths: [1.5, 1.2, 1], alignments: ['left', 'left', 'right'], style: 'rules', fontSize: 23, headerFill: state.document.theme.colors.surface, stripeFill: state.document.theme.colors.surface, ruleColor: state.document.theme.colors.muted, accentColor: state.document.theme.colors.accent, ruleWidth: 2, cellPadding: 18 }
    else element = { id: uid('line'), type, frame: { x: 240, y: 360, w: 560, h: 8 }, color: state.document.theme.colors.text, strokeWidth: 4 }
    commitOperations(state, [{ op: 'add-element', slide: state.activeSlidePath, element }], `${labels.addTypePrefix} ${labels.typeNames[type]}`); set({ selectedIds: [element.id] })
  },
  addImage: (src, frame, alt = '') => {
    const state = get(); const id = uid('image')
    const element: SlideElement = { id, type: 'image', frame, src, fit: 'contain', alt }
    commitOperations(state, [{ op: 'add-element', slide: state.activeSlidePath, element }], getMessages().store.addLocalImage); set({ selectedIds: [id] }); return id
  },
  removeSelected: () => {
    const state = get(); if (!state.selectedIds.length) return
    commitOperations(state, state.selectedIds.map(element => ({ op: 'remove-element', slide: state.activeSlidePath, element })), getMessages().store.removeElements); set({ selectedIds: [] })
  },
  duplicateSelected: () => {
    const state = get(); const slide = state.document.slides[state.activeSlidePath]; const ids: string[] = []
    const operations = slide.elements.filter(element => state.selectedIds.includes(element.id)).map(element => {
      const copy = clone(element); copy.id = uid(element.type); copy.frame.x += 32; copy.frame.y += 32; ids.push(copy.id)
      return { op: 'add-element', slide: state.activeSlidePath, element: copy } as const
    })
    if (!operations.length) return; commitOperations(state, operations, getMessages().store.duplicateElements); set({ selectedIds: ids })
  },
  addSlide: (layoutId = 'blank') => {
    const state = get(); const id = uid('slide'); const labels = getMessages().store
    const presetName = layoutPresetsFor(resolveDeckLocale()).find(preset => preset.id === layoutId)?.name ?? labels.blankPageName
    const result = commitOperations(state, [{ op: 'add-slide', id, layout: layoutId, name: presetName }], labels.newSlide(presetName))
    const path = result.changedPaths.find(item => item.startsWith('./slides/')); if (path) set({ activeSlidePath: path, selectedIds: [] })
  },
  addSummarySlide: (content, style) => {
    const state = get(); const id = uid('summary')
    const result = commitOperations(state, [{ op: 'add-summary-slide', id, content, style, name: content.title, after: state.activeSlidePath }], getMessages().store.summaryFromContent)
    const path = result.changedPaths.find(item => item.startsWith('./slides/')); if (path) set({ activeSlidePath: path, selectedIds: [] })
  },
  addTableSlide: (content, style = 'rules') => {
    const state = get(); const id = uid('table')
    const result = commitOperations(state, [{ op: 'add-table-slide', id, content, style, name: content.title, after: state.activeSlidePath }], getMessages().store.tableFromData)
    const path = result.changedPaths.find(item => item.startsWith('./slides/')); if (path) set({ activeSlidePath: path, selectedIds: ['table'] })
  },
  duplicateSlide: () => {
    const state = get(); const source = state.document.slides[state.activeSlidePath]; const id = uid(source.id)
    const result = commitOperations(state, [{ op: 'duplicate-slide', slide: state.activeSlidePath, id, name: `${source.name ?? source.id} copy` }], getMessages().store.duplicateSlide)
    const path = result.changedPaths.find(item => item.startsWith('./slides/')); if (path) set({ activeSlidePath: path, selectedIds: [] })
  },
  deleteSlide: () => {
    const state = get(); if (state.document.deck.slides.length <= 1) return; const index = state.document.deck.slides.indexOf(state.activeSlidePath)
    const result = commitOperations(state, [{ op: 'remove-slide', slide: state.activeSlidePath }], getMessages().store.deleteSlide)
    set({ activeSlidePath: result.document.deck.slides[Math.max(0, index - 1)], selectedIds: [] })
  },
  moveSlide: direction => {
    const state = get(); const paths = state.document.deck.slides; const index = paths.indexOf(state.activeSlidePath); const next = Math.max(0, Math.min(paths.length - 1, index + direction)); if (next === index) return
    const placement = direction < 0 ? { before: paths[next] } : { after: paths[next] }
    commitOperations(state, [{ op: 'move-slide', slide: state.activeSlidePath, ...placement }], getMessages().store.reorderPages)
  },
  reorderLayer: direction => {
    const state = get(); if (state.selectedIds.length !== 1) return; const elements = state.document.slides[state.activeSlidePath].elements; const index = elements.findIndex(element => element.id === state.selectedIds[0]); const next = Math.max(0, Math.min(elements.length - 1, index + direction)); if (index < 0 || next === index) return
    const placement = direction < 0 ? { before: elements[next].id } : { after: elements[next].id }
    const labels = getMessages().store
    commitOperations(state, [{ op: 'move-element', slide: state.activeSlidePath, element: state.selectedIds[0], ...placement }], direction > 0 ? labels.layerForward : labels.layerBackward)
  },
  alignSelected: mode => {
    const state = get(); const slide = state.document.slides[state.activeSlidePath]
    const selected = slide.elements.filter(element => state.selectedIds.includes(element.id)); if (selected.length < 2) return
    const patches = alignmentPatch(selected.map(element => element.frame), mode)
    const operations = selected.map((element, index) => ({ op: 'set-element', slide: state.activeSlidePath, element: element.id, patch: { frame: { ...element.frame, ...patches[index] } } }) as const)
    commitOperations(state, operations, getMessages().store.align(mode))
  },
  updateTheme: patch => { const state = get(); commitOperations(state, [{ op: 'set-theme', patch }], getMessages().store.updateTheme) },
  applyTheme: theme => { const state = get(); commitOperations(state, [{ op: 'set-theme', theme }], getMessages().store.applyTheme) },
  updateFooter: footer => { const state = get(); commitOperations(state, [{ op: 'set-footer', footer }], getMessages().store.updateFooter) },
  updateSlideMotion: motion => { const state = get(); commitOperations(state, [{ op: 'set-slide-motion', slide: state.activeSlidePath, motion }], getMessages().store.updateCamera) },
}))
