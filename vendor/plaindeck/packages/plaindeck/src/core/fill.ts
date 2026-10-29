import { BASE_CANVAS, createLayoutElements } from './presets.js'
import { estimateTextWidth } from '../render/presentation.js'
import type { SlideElement, Theme } from './schema.js'

export interface PaperFigureContent {
  kicker?: string
  figLabel?: string
  title?: string
  caption?: string
  notesLabel?: string
  notes?: string[]
  image?: { src: string; alt?: string }
}

const setTextEl = (elements: SlideElement[], id: string, text: string | undefined, patch: Record<string, unknown> = {}) => {
  const element = elements.find((candidate) => candidate.id === id)
  if (element && element.type === 'text' && text != null) Object.assign(element, { text, ...patch })
}

/**
 * Fill the paper-figure preset with real content. The preset is authored on
 * the 1600×900 design base and scaled to the target canvas inside
 * createLayoutElements, so every element frame handled here is already in
 * canvas coordinates. Callers must never set preset frames themselves —
 * alignment between the notes column, rail, and caption is owned here.
 * Unused note slots are dropped; a single note extends down the rail so
 * long KEY POINT text keeps a readable size.
 */
export function fillPaperFigure(content: PaperFigureContent, theme: Theme, canvas = BASE_CANVAS): SlideElement[] {
  const elements = createLayoutElements('paper-figure', theme, canvas)
  setTextEl(elements, 'kicker', content.kicker)
  setTextEl(elements, 'fig-label', content.figLabel)
  setTextEl(elements, 'title', content.title, { fit: 'fill' })
  setTextEl(elements, 'caption', content.caption, { fit: 'fill' })
  setTextEl(elements, 'notes-label', content.notesLabel)
  const notes = content.notes ?? []
  const dropped: string[] = []
  for (let index = 0; index < 3; index += 1) {
    const numberId = `note-${index + 1}-number`
    const textId = `note-${index + 1}`
    if (index < notes.length) {
      setTextEl(elements, textId, notes[index], { fit: 'fill' })
    } else {
      dropped.push(numberId, textId)
    }
  }
  const remaining = elements.filter((element) => !dropped.includes(element.id))
  if (notes.length === 1) {
    const note = remaining.find((element) => element.id === 'note-1')
    const rail = remaining.find((element) => element.id === 'rail-rule')
    if (note && rail && note.type === 'text') {
      const bottom = rail.frame.y + rail.frame.h
      note.frame = { ...note.frame, h: Math.max(note.frame.h, bottom - note.frame.y - 16) }
    }
  }
  if (content.image) {
    const figure = remaining.find((element) => element.id === 'figure')
    if (figure && figure.type === 'image') Object.assign(figure, { src: content.image.src, alt: content.image.alt ?? '' })
  }
  return remaining
}

export interface GhostContent { id?: string; label?: string }

/**
 * Phantom page-number decoration: a huge mono numeral in the surface color,
 * present as a visual anchor but never competing with the text.
 */
export function designGhostNumber(options: GhostContent & { frame: { x: number; y: number; w: number; h: number }; fontSize: number; align?: 'left' | 'center' | 'right'; color?: string; verticalAlign?: 'top' | 'middle' | 'bottom' }): SlideElement {
  return {
    id: options.id ?? 'ghost', type: 'text', frame: options.frame, text: options.label ?? '01',
    fontSize: options.fontSize, fontWeight: 800, fontFamily: 'mono', align: options.align ?? 'right',
    color: options.color ?? '#000000', verticalAlign: options.verticalAlign,
  }
}


const dropEmptyProse = (elements: SlideElement[], content: StatementContent) => {
  const drop = (id: string) => {
    const index = elements.findIndex((element) => element.id === id)
    if (index >= 0) elements.splice(index, 1)
  }
  if (!content.lead) drop('lead')
  if (!content.support) drop('support')
  return elements
}
export interface StatementContent {
  kicker?: string
  title?: string
  lead?: string
  support?: string
  ghost?: GhostContent
}

const setFrameY = (element: SlideElement | undefined, y: number) => {
  if (element && element.type === 'text') element.frame = { ...element.frame, y }
}

/**
 * Fill the hook-statement preset (oversized statement page). The rule and
 * body positions adapt to the title's line count, measured with the same
 * width estimate the renderer uses for fill sizing.
 */
export function fillHookStatement(content: StatementContent, theme: Theme, canvas = BASE_CANVAS): SlideElement[] {
  const elements = createLayoutElements('hook-statement', theme, canvas)
  setTextEl(elements, 'kicker', content.kicker)
  setTextEl(elements, 'heading', content.title)
  setTextEl(elements, 'lead', content.lead, { fit: 'fill' })
  setTextEl(elements, 'support', content.support, { fit: 'fill' })
  if (content.ghost?.label) {
    const ghost = elements.find((element) => element.id === 'ghost')
    if (ghost && ghost.type === 'text') {
      ghost.text = content.ghost.label
      if (content.ghost.id) ghost.id = content.ghost.id
    }
  } else {
    const ghostIndex = elements.findIndex((element) => element.id === 'ghost')
    if (ghostIndex >= 0) elements.splice(ghostIndex, 1)
  }
  dropEmptyProse(elements, content)
  const heading = elements.find((element) => element.id === 'heading')
  const rule = elements.find((element) => element.id === 'heading-rule')
  if (heading && rule && heading.type === 'text' && rule.type === 'line') {
    const twoLine = estimateTextWidth(content.title ?? '', heading.fontSize ?? 66, heading.fontWeight ?? 800) > heading.frame.w
    if (twoLine) {
      rule.frame = { ...rule.frame, y: rule.frame.y + 84 }
      heading.frame = { ...heading.frame, h: 190 }
    }
    const lead = elements.find((element) => element.id === 'lead')
    const support = elements.find((element) => element.id === 'support')
    if (lead && support) {
      setFrameY(lead, rule.frame.y + 62)
      lead.frame = { ...lead.frame, h: content.support ? 140 : 320 }
      setFrameY(support, rule.frame.y + 62 + 158)
      // 正文用满页面底部空间：30px×1.6 下约 6 行，长正文保持可读字号
      support.frame = { ...support.frame, h: Math.max(176, Math.round(900 - (support.frame.y + 84))) }
    }
  }
  return elements
}

export type ProsePanelContent = StatementContent

/**
 * Fill the prose-panel preset: heading, hairline, a surface card holding the
 * lead sentence, an accent rule, and the support sentences; phantom number
 * centered on the right. The lead-rule only exists when both lead and
 * support are present.
 */
export function fillProsePanel(content: ProsePanelContent, theme: Theme, canvas = BASE_CANVAS): SlideElement[] {
  const elements = createLayoutElements('prose-panel', theme, canvas)
  setTextEl(elements, 'kicker', content.kicker)
  setTextEl(elements, 'heading', content.title)
  setTextEl(elements, 'lead', content.lead, { fit: 'fill' })
  setTextEl(elements, 'support', content.support, { fit: 'fill' })
  if (content.ghost?.label) {
    const ghost = elements.find((element) => element.id === 'ghost')
    if (ghost && ghost.type === 'text') {
      ghost.text = content.ghost.label
      if (content.ghost.id) ghost.id = content.ghost.id
    }
  } else {
    const ghostIndex = elements.findIndex((element) => element.id === 'ghost')
    if (ghostIndex >= 0) elements.splice(ghostIndex, 1)
  }
  dropEmptyProse(elements, content)
  const lead = elements.find((element) => element.id === 'lead')
  const support = elements.find((element) => element.id === 'support')
  if (lead && lead.type === 'text' && !content.support) lead.frame = { ...lead.frame, h: 360 }
  // 双段正文：support 存在时，把 lead 压到一行高、support 用满卡片剩余空间，
  // 保证长正文以可读字号完整展示而不是被压到 16px。
  if (lead && support && lead.type === 'text' && support.type === 'text') {
    const panel = elements.find((element) => element.id === 'prose-panel')
    if (panel && panel.type === 'shape') {
      const bottom = panel.frame.y + panel.frame.h - 24
      const rule = elements.find((element) => element.id === 'lead-rule')
      if (rule && rule.type === 'line') {
        support.frame = { ...support.frame, y: rule.frame.y + 26, h: Math.max(120, Math.round(bottom - (rule.frame.y + 26))) }
        const leadLines = Math.max(1, Math.ceil(estimateTextWidth(content.lead ?? '', lead.fontSize ?? 36, lead.fontWeight ?? 700) / (lead.frame.w * 0.98)))
        lead.frame = { ...lead.frame, h: Math.min(150, Math.round((leadLines * (lead.fontSize ?? 36) * (lead.lineHeight ?? 1.45)) + 12)) }
      }
    }
  }
  // lead-rule 只在引导句与支撑句同时存在时保留
  if (lead && support) return elements
  return elements.filter((element) => element.id !== 'lead-rule')
}

export interface TakeawayContent {
  kicker?: string
  title?: string
  quote?: string
  clauses: string[]
  attribution?: string
  endLabel?: string
}

/**
 * Fill the takeaway preset: heading + optional quote, then the body clauses
 * (split on ；by the caller) as numbered rows that adapt height to the count
 * and center vertically between the header and the bottom rule.
 */
export function fillTakeaway(content: TakeawayContent, theme: Theme, canvas = BASE_CANVAS): SlideElement[] {
  const elements = createLayoutElements('takeaway', theme, canvas)
  setTextEl(elements, 'kicker', content.kicker)
  setTextEl(elements, 'heading', content.title)
  const quote = elements.find((element) => element.id === 'quote')
  if (quote && quote.type === 'text') {
    if (content.quote) quote.text = content.quote
    else elements.splice(elements.indexOf(quote), 1)
  }
  const endRule = elements.find((element) => element.id === 'end-rule')
  const attributionEl = elements.find((element) => element.id === 'attribution')
  if (attributionEl && attributionEl.type === 'text') {
    if (content.attribution) attributionEl.text = content.attribution
    else elements.splice(elements.indexOf(attributionEl), 1)
  }
  const endEl = elements.find((element) => element.id === 'end')
  if (endEl && endEl.type === 'text') endEl.text = content.endLabel ?? 'END'

  let clauses = content.clauses
  if (clauses.length > 4) clauses = [...clauses.slice(0, 3), clauses.slice(3).join('；')]
  if (clauses.length === 0) return elements

  const headingRule = elements.find((element) => element.id === 'heading-rule')
  const quoteY = quote?.frame.y ?? null
  const quoteH = quote?.frame.h ?? 0
  const rowsZoneTop = quoteY != null && content.quote ? quoteY + quoteH + 26 : (headingRule?.frame.y ?? 0) + 44
  const rowsZoneBottom = (endRule?.frame.y ?? 852) - 16
  const zoneH = rowsZoneBottom - rowsZoneTop
  const rowH = Math.min(200, Math.floor(zoneH / clauses.length))
  const blockTop = rowsZoneTop + Math.max(0, Math.floor((zoneH - rowH * clauses.length) / 2))
  const clauseSize = clauses.length <= 2 ? 34 : clauses.length === 3 ? 31 : 30
  const rows: SlideElement[] = []
  clauses.forEach((clause, index) => {
    const y = blockTop + index * rowH
    rows.push(
      { id: `takeaway-${index + 1}-number`, type: 'text', frame: { x: 120, y: y + 10, w: 100, h: 48 }, text: `0${index + 1}`, fontSize: 30, fontWeight: 800, fontFamily: 'mono', color: theme.colors.accent },
      { id: `takeaway-${index + 1}`, type: 'text', frame: { x: 260, y: y + 4, w: 1480, h: rowH - 20 }, text: clause, fontSize: clauseSize, fontWeight: 600, color: theme.colors.text, lineHeight: 1.5, fit: 'fill' },
    )
    if (index < clauses.length - 1) {
      rows.push({ id: `takeaway-rule-${index + 1}`, type: 'line', frame: { x: 260, y: y + rowH - 10, w: 1480, h: 2 }, color: theme.colors.surface ?? theme.colors.background, strokeWidth: 2, opacity: 0.6 })
    }
  })
  // rows go before the end-rule element
  const endRuleIndex = elements.findIndex((element) => element.id === 'end-rule')
  elements.splice(endRuleIndex, 0, ...rows)
  return elements
}
