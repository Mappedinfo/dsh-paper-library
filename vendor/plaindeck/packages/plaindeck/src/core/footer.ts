import type { FooterSlot } from './schema.js'

export interface FooterContext {
  pageNumber: number
  pageCount: number
  deckTitle: string
  slideName: string
  date?: Date | string
}

export function formatFooterDate(value: Date | string = new Date()): string {
  if (typeof value === 'string') return value
  const year = value.getFullYear()
  const month = String(value.getMonth() + 1).padStart(2, '0')
  const day = String(value.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function resolveFooterSlot(slot: FooterSlot, context: FooterContext): string {
  if (slot.type === 'none') return ''
  if (slot.type === 'text') return slot.text
  if (slot.type === 'date') return formatFooterDate(context.date)
  if (slot.type === 'page') return String(context.pageNumber)
  if (slot.type === 'page-count') return String(context.pageCount)
  if (slot.type === 'page-of-count') return `${context.pageNumber} / ${context.pageCount}`
  if (slot.type === 'deck-title') return context.deckTitle
  return context.slideName
}
