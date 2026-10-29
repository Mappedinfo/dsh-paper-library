import { resolveFooterSlot } from '../core/footer.js'
import { DEFAULT_TYPE_SCALE } from '../core/typography.js'
import type { DeckDocument, SlideElement } from '../core/schema.js'

import { PlainDeckError } from '../core/errors.js'
export type PresentationStyle = Record<string, string | number | undefined>

// CJK unified + extension + fullwidth forms + CJK punctuation (、。！？「」 are full-width 1em in CJK fonts)
const wideGlyph = /[぀-ヿ㐀-䶿一-鿿豈-﫿︰-﹏＀-￯\u3000-\u303f]/

/** Estimate rendered text width in px without a layout engine: CJK ≈ 1em, whitespace ≈ 0.32em, latin ≈ 0.6em (deliberately generous — over-shrinking beats clipping). */
export function estimateTextWidth(text: string, fontSize: number, fontWeight = 400, letterSpacing = 0): number {
  // Proportional latin: uppercase/digits render wider than lowercase; bold
  // inflates them further. 0.62 / 0.72 stays slightly conservative so the
  // line-count estimate never misses a wrap (clipping is worse than a small
  // shrink). CJK stays exactly 1em and CJK punctuation 1em (full-width).
  const latinFactor = fontWeight >= 700 ? 0.72 : 0.62
  let width = 0
  for (const char of text) {
    if (wideGlyph.test(char)) width += fontSize + letterSpacing
    else if (/\s/.test(char)) width += fontSize * 0.32 + letterSpacing
    else width += fontSize * latinFactor + letterSpacing
  }
  return width
}

const MIN_SHRINK_FONT_SIZE = 12

/** Reduce font size until the estimated wrapped text fits the frame; returns the original size when it already fits. */
export function shrinkFontToFit(text: string, frame: { w: number; h: number }, fontSize: number, lineHeight: number, fontWeight = 400, letterSpacing = 0): number {
  let size = fontSize
  while (size > MIN_SHRINK_FONT_SIZE) {
    const lines = text.split('\n').reduce((count, paragraph) => count + Math.max(1, Math.ceil(estimateTextWidth(paragraph, size, fontWeight, letterSpacing) / frame.w)), 0)
    if (lines * size * lineHeight <= frame.h) return size
    size = Math.max(MIN_SHRINK_FONT_SIZE, Math.floor(size * 0.9))
  }
  return size
}

/**
 * Readable floor for fill-fit sizing: templates should never produce
 * microscope text on dense pages.
 */
export const MIN_FILL_FONT_SIZE = 16

export interface FitTextOptions {
  /** Readable floor; defaults to MIN_FILL_FONT_SIZE. */
  minSize?: number
  /** Growth cap; defaults to fontSize (shrink-only) or fontSize * 1.5 (grow). */
  maxSize?: number
  /** Allow growing above the design size so the template is properly filled. */
  grow?: boolean
  /** Limited size choices: snap the adopted size to the largest member at or below the ideal. */
  scale?: number[]
  /** Height safety factor applied to the fit check; defaults to 0.88. */
  heightSafety?: number
}

/**
 * Compute the largest font size in [minSize, maxSize] whose estimated wrapped
 * text fits the frame. With `grow` the text is scaled up to fill the box
 * instead of staying at a hardcoded size; without it this is a precise
 * shrink-only fit. With `scale`, the adopted size snaps down to a limited set
 * of allowed sizes so same-type components stay coherent across pages.
 */
export function fitTextSize(text: string, frame: { w: number; h: number }, fontSize: number, lineHeight: number, fontWeight = 400, letterSpacing = 0, options: FitTextOptions = {}): number {
  const minSize = options.minSize ?? MIN_FILL_FONT_SIZE
  const maxSize = Math.max(minSize, options.maxSize ?? (options.grow ? fontSize * 1.5 : fontSize))
  // Conservative height margin: the width estimate is heuristic (latin/digits
  // render wider than the flat factor in proportional fonts), so a filled box
  // must keep ~12% headroom or the real text clips at the frame edge.
  const heightSafety = options.heightSafety ?? 0.88
  const fits = (size: number) => {
    const lines = text.split('\n').reduce((count, paragraph) => count + Math.max(1, Math.ceil(estimateTextWidth(paragraph, size, fontWeight, letterSpacing) / frame.w)), 0)
    return lines * size * lineHeight <= frame.h * heightSafety
  }
  let lo = minSize
  let hi = maxSize
  let best = minSize
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2)
    if (fits(mid)) { best = mid; lo = mid + 1 } else { hi = mid - 1 }
  }
  if (options.scale && options.scale.length > 0) {
    const snapped = options.scale.filter((size) => size <= best && size >= minSize).sort((a, b) => b - a)[0]
    if (snapped !== undefined) return snapped
  }
  return best
}

/**
 * Unify same-type components within one slide to a single adopted size:
 * elements whose ids share a pattern (trailing numbers and -rule/-number
 * suffixes stripped) are treated as one component group, and the group's
 * size is driven by its longest member. Writing that single size into each
 * member's `scale` forces the renderer to adopt it everywhere on the page.
 * Cross-page coherence comes from the type scale itself.
 */
export function unifyComponentTypeSizes(elements: SlideElement[], options: { scale?: number[] } = {}): void {
  const scale = options.scale ?? DEFAULT_TYPE_SCALE
  const groupKey = (element: SlideElement) =>
    element.id.replace(/-(?:\d+)$/g, '').replace(/-(?:rule|number)$/g, '')
  const groups = new Map<string, SlideElement[]>()
  for (const element of elements) {
    if (element.type !== 'text' || element.fit !== 'fill') continue
    const key = groupKey(element)
    const members = groups.get(key)
    if (members) members.push(element)
    else groups.set(key, [element])
  }
  for (const members of groups.values()) {
    if (members.length < 2) continue
    let shared = Infinity
    for (const member of members) {
      if (member.type !== 'text') continue
      const ideal = fitTextSize(
        member.text, member.frame, member.fontSize ?? 24, member.lineHeight ?? 1.3,
        member.fontWeight ?? 400, member.letterSpacing ?? 0,
        { grow: true, scale },
      )
      shared = Math.min(shared, ideal)
    }
    if (Number.isFinite(shared)) {
      for (const member of members) {
        if (member.type === 'text') member.scale = [shared]
      }
    }
  }
}

export interface ExpandTextFramesOptions {
  /** Hard lower bound for any vertical extension (e.g. the caption-safe zone). */
  maxBottom: number
  /** Hard right bound for any horizontal extension. */
  maxRight: number
  /** Minimum gap kept to the next element; defaults to 8. */
  gap?: number
}

/**
 * Restrained text-box auto-extension: when a fill/shrink text element is near
 * its frame limit (estimated wrapped height >= 85% or width >= 90%), extend
 * the frame in the free direction — down by at most one line, right by the
 * estimated surplus — without touching the next element or the hard bounds.
 * This gives real-vs-estimate headroom (the width estimate is heuristic) so
 * dense text stops clipping at the box edge.
 */
export function expandTextFrames(elements: SlideElement[], options: ExpandTextFramesOptions): void {
  const gap = options.gap ?? 8
  for (const element of elements) {
    if (element.type !== 'text' || !(element.fit === 'fill' || element.fit === 'shrink')) continue
    const frame = element.frame
    const size = element.fontSize ?? 28
    const lineHeight = element.lineHeight ?? 1.3
    const weight = element.fontWeight ?? 400
    const ls = element.letterSpacing ?? 0
    const paragraphs = element.text.split('\n')
    const estHeight = paragraphs.reduce((sum, paragraph) => sum + Math.max(1, Math.ceil(estimateTextWidth(paragraph, size, weight, ls) / frame.w)), 0) * size * lineHeight
    const maxLineWidth = Math.max(...paragraphs.map((paragraph) => estimateTextWidth(paragraph, size, weight, ls)))
    const tightH = estHeight >= frame.h * 0.85
    const tightW = maxLineWidth >= frame.w * 0.9
    if (!tightH && !tightW) continue
    let topLimit = options.maxBottom
    let leftLimit = options.maxRight
    for (const other of elements) {
      if (other === element) continue
      if (other.frame.y >= frame.y + frame.h) topLimit = Math.min(topLimit, other.frame.y)
      if (other.frame.x >= frame.x + frame.w) leftLimit = Math.min(leftLimit, other.frame.x)
    }
    if (tightH) {
      const extend = Math.min(size * lineHeight, topLimit - (frame.y + frame.h) - gap)
      if (extend > 0) element.frame = { ...frame, h: Math.round(frame.h + extend) }
    }
    if (tightW) {
      const extend = Math.min(maxLineWidth - frame.w + 4, leftLimit - (frame.x + frame.w) - gap)
      if (extend > 0) element.frame = { ...frame, w: Math.round(frame.w + extend) }
    }
  }
}

export interface TextFitIssue {
  elementId: string
  code: 'overflow_at_min' | 'below_readable' | 'tight_near_cap'
  fontSize: number
  message: string
}

export interface DiagnoseTextFitOptions {
  /** Readable floor; defaults to MIN_FILL_FONT_SIZE. */
  minSize?: number
  /** Below this adopted size the element is flagged below_readable; defaults to 28. */
  readableSize?: number
  /** Height safety factor matching fitTextSize; defaults to 0.88. */
  heightSafety?: number
}

/**
 * Content-layout balance diagnostics for fill-fitted text. Returns issues
 * the author should resolve by reorganizing content:
 * - overflow_at_min: even the readable floor size does not fit the frame
 *   (the text will clip); split the scene or switch layout.
 * - below_readable: the adopted size is squeezed below the comfortable body
 *   size; trim the text or split the page.
 * - tight_near_cap: the estimated height nearly fills the frame after
 *   expansion; content is at the layout's capacity.
 */
export function diagnoseTextFit(elements: SlideElement[], options: DiagnoseTextFitOptions = {}): TextFitIssue[] {
  const minSize = options.minSize ?? MIN_FILL_FONT_SIZE
  const readableSize = options.readableSize ?? 28
  const heightSafety = options.heightSafety ?? 0.88
  const issues: TextFitIssue[] = []
  for (const element of elements) {
    if (element.type !== 'text' || element.fit !== 'fill') continue
    const frame = element.frame
    const size = element.fontSize ?? 28
    // 与 textContentStyle 的渲染一致：元素未显式设置时缺省 1.12
    const lineHeight = element.lineHeight ?? 1.12
    const weight = element.fontWeight ?? 400
    const ls = element.letterSpacing ?? 0
    const estHeight = (s: number) => {
      const lines = element.text.split('\n').reduce((count, paragraph) => count + Math.max(1, Math.ceil(estimateTextWidth(paragraph, s, weight, ls) / frame.w)), 0)
      return lines * s * lineHeight
    }
    const capacity = frame.h * heightSafety
    if (estHeight(minSize) > capacity) {
      issues.push({ elementId: element.id, code: 'overflow_at_min', fontSize: minSize, message: 'text does not fit even at the minimum readable size; split the scene or switch layout' })
      continue
    }
    const adopted = fitTextSize(element.text, frame, size, lineHeight, weight, ls, { grow: true, minSize })
    if (adopted < readableSize) {
      issues.push({ elementId: element.id, code: 'below_readable', fontSize: adopted, message: `adopted size ${adopted}px is below the ${readableSize}px comfortable body size; trim the text or split the page` })
    } else if (estHeight(adopted) >= capacity * 0.95) {
      // 单行标题填满短盒是设计常态；只在多行正文接近容量时提示作者留余量。
      const adoptedLines = element.text.split('\n').reduce((count, paragraph) => count + Math.max(1, Math.ceil(estimateTextWidth(paragraph, adopted, weight, ls) / frame.w)), 0)
      if (adoptedLines >= 2) {
        issues.push({ elementId: element.id, code: 'tight_near_cap', fontSize: adopted, message: `estimated height fills ${Math.round((estHeight(adopted) / capacity) * 100)}% of the frame; content is at the layout's capacity` })
      }
    }
  }
  return issues
}

export function horizontalAlignment(align?: 'left' | 'center' | 'right') {
  return align === 'center' ? 'center' : align === 'right' ? 'flex-end' : 'flex-start'
}

export function verticalAlignment(align?: 'top' | 'middle' | 'bottom') {
  return align === 'bottom' ? 'flex-end' : align === 'middle' ? 'center' : 'flex-start'
}

export function resolveSlideBackground(document: DeckDocument, path: string) {
  const background = document.slides[path]?.background
  if (background?.color) return background.color
  const token = background?.token?.replace(/^color\./, '') as keyof DeckDocument['theme']['colors'] | undefined
  return token && token in document.theme.colors ? document.theme.colors[token] : document.theme.colors.background
}

export function elementFrameStyle(element: SlideElement): PresentationStyle {
  return {
    position: 'absolute',
    left: element.frame.x,
    top: element.frame.y,
    width: element.frame.w,
    height: element.frame.h,
    opacity: element.opacity ?? 1,
    transform: `rotate(${element.rotation ?? 0}deg)`,
    transformOrigin: 'center',
    zIndex: element.zIndex ?? 'auto',
    boxSizing: 'border-box',
  }
}

export function textContentStyle(element: Extract<SlideElement, { type: 'text' }>, theme: DeckDocument['theme']): PresentationStyle {
  const title = element.styleRef === 'slide-title'
  const lineHeight = element.lineHeight ?? 1.12
  const fontWeight = element.fontWeight ?? (title ? 700 : 400)
  let fontSize = element.fontSize ?? (title ? theme.fontSizes.title : theme.fontSizes.body)
  if (element.fit === 'shrink') fontSize = shrinkFontToFit(element.text, element.frame, fontSize, lineHeight, fontWeight, element.letterSpacing)
  else if (element.fit === 'fill') fontSize = fitTextSize(element.text, element.frame, fontSize, lineHeight, fontWeight, element.letterSpacing, {grow: true, scale: element.scale ?? theme.typeScale ?? DEFAULT_TYPE_SCALE})
  return {
    width: '100%', height: '100%', display: 'flex',
    fontFamily: element.fontFamily ?? (title ? theme.fonts.title : theme.fonts.body),
    fontSize,
    fontWeight,
    color: element.color ?? theme.colors.text,
    textAlign: element.align ?? 'left',
    justifyContent: horizontalAlignment(element.align),
    alignItems: verticalAlignment(element.verticalAlign),
    letterSpacing: element.letterSpacing,
    whiteSpace: 'pre-wrap', lineHeight, overflow: 'hidden', boxSizing: 'border-box',
  }
}

export function imageContentStyle(element: Extract<SlideElement, { type: 'image' }>): PresentationStyle {
  return { width: '100%', height: '100%', display: 'block', objectFit: element.fit === 'stretch' ? 'fill' : element.fit }
}

export function shapeContentStyle(element: Extract<SlideElement, { type: 'shape' }>): PresentationStyle {
  return {
    width: '100%', height: '100%', display: 'block', boxSizing: 'border-box', overflow: 'hidden',
    background: element.fill,
    borderColor: element.stroke ?? 'transparent',
    borderWidth: element.strokeWidth ?? 0,
    borderStyle: 'solid',
    borderRadius: element.shape === 'ellipse' ? '50%' : element.radius ?? 0,
  }
}

export function shapeLabelStyle(element: Extract<SlideElement, { type: 'shape' }>, theme: DeckDocument['theme']): PresentationStyle {
  return {
    display: 'flex', width: '100%', height: '100%', padding: 24, boxSizing: 'border-box',
    alignItems: verticalAlignment(element.verticalAlign ?? 'middle'),
    justifyContent: horizontalAlignment(element.align),
    fontFamily: element.fontFamily ?? theme.fonts.body,
    fontSize: element.fontSize ?? theme.fontSizes.body,
    fontWeight: element.fontWeight ?? 400,
    color: element.textColor ?? theme.colors.text,
    textAlign: element.align ?? 'left', whiteSpace: 'pre-wrap', lineHeight: 1.16, overflow: 'hidden',
  }
}

export function lineContentStyle(element: Extract<SlideElement, { type: 'line' }>): PresentationStyle {
  return {
    position: 'absolute', left: 0, right: 0, top: '50%', height: 0,
    color: element.color,
    borderTopWidth: element.strokeWidth,
    borderTopStyle: element.dash ? 'dashed' : 'solid',
    borderTopColor: element.color,
  }
}

export function tableColumnWidths(element: Extract<SlideElement, { type: 'table' }>): string[] {
  const columns = element.cells[0]?.length ?? 0
  const weights = element.columnWidths ?? Array.from({ length: columns }, () => 1)
  const total = weights.reduce((sum, value) => sum + value, 0) || 1
  return weights.map(value => `${value / total * 100}%`)
}

export function tableContentStyle(element: Extract<SlideElement, { type: 'table' }>, theme: DeckDocument['theme']): PresentationStyle {
  const ruleColor = element.ruleColor ?? theme.colors.muted
  const ruleWidth = element.ruleWidth ?? 2
  return {
    width: '100%', height: '100%', tableLayout: 'fixed', borderCollapse: 'collapse', borderSpacing: 0,
    fontFamily: element.fontFamily ?? theme.fonts.body,
    fontSize: element.fontSize ?? Math.max(16, theme.fontSizes.body * 0.82),
    lineHeight: 1.25, color: element.textColor ?? theme.colors.text,
    borderTop: element.style === 'grid' ? undefined : `${ruleWidth * 1.5}px solid ${element.accentColor ?? theme.colors.accent}`,
    borderBottom: element.style === 'grid' ? undefined : `${ruleWidth * 1.5}px solid ${ruleColor}`,
  }
}

export function tableCellStyle(element: Extract<SlideElement, { type: 'table' }>, theme: DeckDocument['theme'], rowIndex: number, columnIndex: number): PresentationStyle {
  const header = rowIndex < element.headerRows
  const lastHeader = rowIndex === element.headerRows - 1
  const highlighted = element.highlightRows?.includes(rowIndex) ?? false
  const ruleColor = element.ruleColor ?? theme.colors.muted
  const accent = element.accentColor ?? theme.colors.accent
  const ruleWidth = element.ruleWidth ?? 2
  const style: PresentationStyle = {
    padding: element.cellPadding ?? 18,
    textAlign: element.alignments?.[columnIndex] ?? (columnIndex === 0 ? 'left' : 'right'),
    verticalAlign: 'middle', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', boxSizing: 'border-box',
    fontWeight: header || columnIndex === 0 ? 700 : 400,
    color: header ? element.headerTextColor ?? element.textColor ?? theme.colors.text : element.textColor ?? theme.colors.text,
    background: header ? element.headerFill ?? theme.colors.surface ?? theme.colors.background
      : highlighted || (element.style === 'stripes' && (rowIndex - element.headerRows) % 2 === 1) ? element.stripeFill ?? theme.colors.surface ?? theme.colors.background : 'transparent',
    outline: 'none',
  }
  if (element.style === 'grid') {
    style.border = `${ruleWidth}px solid ${ruleColor}`
  } else {
    style.borderLeft = 'none'; style.borderRight = 'none'; style.borderTop = 'none'
    style.borderBottom = lastHeader ? `${ruleWidth * 1.5}px solid ${accent}` : `${Math.max(1, ruleWidth * 0.5)}px solid ${ruleColor}`
  }
  if (highlighted && columnIndex === 0) style.boxShadow = `inset ${Math.max(4, ruleWidth * 2)}px 0 ${accent}`
  return style
}

export function slideStyle(document: DeckDocument, path: string): PresentationStyle {
  return {
    position: 'relative', width: document.deck.canvas.width, height: document.deck.canvas.height,
    overflow: 'hidden', flex: 'none', boxSizing: 'border-box',
    background: resolveSlideBackground(document, path),
    color: document.theme.colors.text,
    fontFamily: document.theme.fonts.body,
  }
}

export function footerPresentation(document: DeckDocument, path: string, date?: Date | string) {
  const footer = document.deck.footer
  if (!footer) return null
  const slide = document.slides[path]
  if (!slide) throw new PlainDeckError('slide-not-found', { zh: `页面不存在：${path}`, en: `Slide not found: ${path}` })
  const context = {
    pageNumber: document.deck.slides.indexOf(path) + 1,
    pageCount: document.deck.slides.length,
    deckTitle: document.deck.title,
    slideName: slide.name ?? slide.id,
    date,
  }
  const values = [footer.left, footer.center, footer.right].map(slot => resolveFooterSlot(slot, context)) as [string, string, string]
  if (values.every(value => !value)) return null
  const style: PresentationStyle = {
    position: 'absolute', left: document.theme.spacing.page, right: document.theme.spacing.page, bottom: 24,
    zIndex: 2147483647, display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 24,
    fontFamily: document.theme.fonts.body, fontSize: footer.fontSize ?? document.theme.fontSizes.caption,
    lineHeight: 1, color: footer.color ?? document.theme.colors.muted, pointerEvents: 'none',
  }
  return { values, style }
}
