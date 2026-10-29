import type { StoreApi } from 'zustand'
import { clone, type EditorState } from './types'

/** History + persistence bookkeeping: commits mark dirty revisions; undo/redo swap snapshots. */
export function createHistorySlice(set: StoreApi<EditorState>['setState']) {
  return {
    commitDocument(document: EditorState['document'], label: string, paths: string[]) {
      set(state => {
        const revision = state.revision + 1
        const dirtyRevisions = new Map(state.dirtyRevisions); paths.forEach(path => dirtyRevisions.set(path, revision))
        return {
          document, revision, saveState: 'dirty' as const, future: [],
          past: [...state.past, { document: clone(state.document), label }].slice(-100),
          dirtyPaths: new Set(dirtyRevisions.keys()), dirtyRevisions,
        }
      })
    },
    undo() {
      set(state => {
        const entry = state.past.at(-1); if (!entry) return state
        const revision = state.revision + 1; const paths = ['deck.json', entry.document.deck.theme, ...new Set([...state.document.deck.slides, ...entry.document.deck.slides])]
        const dirtyRevisions = new Map(state.dirtyRevisions); paths.forEach(path => dirtyRevisions.set(path, revision))
        return { document: clone(entry.document), revision, past: state.past.slice(0, -1), future: [{ document: clone(state.document), label: entry.label }, ...state.future].slice(0, 100), dirtyPaths: new Set(dirtyRevisions.keys()), dirtyRevisions, saveState: 'dirty' as const }
      })
    },
    redo() {
      set(state => {
        const entry = state.future[0]; if (!entry) return state
        const revision = state.revision + 1; const paths = ['deck.json', entry.document.deck.theme, ...new Set([...state.document.deck.slides, ...entry.document.deck.slides])]
        const dirtyRevisions = new Map(state.dirtyRevisions); paths.forEach(path => dirtyRevisions.set(path, revision))
        return { document: clone(entry.document), revision, future: state.future.slice(1), past: [...state.past, { document: clone(state.document), label: entry.label }].slice(-100), dirtyPaths: new Set(dirtyRevisions.keys()), dirtyRevisions, saveState: 'dirty' as const }
      })
    },
    clearDirty(captured: Map<string, number>) {
      set(state => {
        const dirtyRevisions = new Map(state.dirtyRevisions)
        captured.forEach((revision, path) => { if (dirtyRevisions.get(path) === revision) dirtyRevisions.delete(path) })
        const dirtyPaths = new Set(dirtyRevisions.keys()); const saved = dirtyPaths.size === 0
        return { dirtyPaths, dirtyRevisions, persistedRevision: saved ? state.revision : state.persistedRevision, saveState: saved ? state.directory ? 'saved' as const : 'demo' as const : 'dirty' as const }
      })
    },
  }
}

export type HistorySlice = ReturnType<typeof createHistorySlice>
