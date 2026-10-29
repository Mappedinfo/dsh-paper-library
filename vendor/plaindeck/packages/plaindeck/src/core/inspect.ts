import type { DeckDocument } from './schema.js'

export interface DeckInspection {
  schemaVersion: string
  id: string
  title: string
  canvas: { width: number; height: number }
  footer?: DeckDocument['deck']['footer']
  theme: DeckDocument['theme']
  slides: Array<{
    index: number
    path: string
    id: string
    name: string
    layoutRef?: string
    elementCount: number
    elements: Array<{ id: string; type: string; text?: string; rows?: number; columns?: number }>
  }>
}

export function inspectDeck(document: DeckDocument): DeckInspection {
  return {
    schemaVersion: document.deck.schemaVersion,
    id: document.deck.id,
    title: document.deck.title,
    canvas: { ...document.deck.canvas },
    ...(document.deck.footer ? { footer: structuredClone(document.deck.footer) } : {}),
    theme: structuredClone(document.theme),
    slides: document.deck.slides.map((path, index) => {
      const slide = document.slides[path]
      return {
        index: index + 1,
        path,
        id: slide.id,
        name: slide.name ?? slide.id,
        layoutRef: slide.layoutRef,
        elementCount: slide.elements.length,
        elements: slide.elements.map(element => ({
          id: element.id,
          type: element.type,
          ...(('text' in element && typeof element.text === 'string') ? { text: element.text } : {}),
          ...(element.type === 'table' ? { text: element.cells[0]?.join(' | '), rows: element.cells.length - element.headerRows, columns: element.cells[0]?.length ?? 0 } : {}),
        })),
      }
    }),
  }
}
