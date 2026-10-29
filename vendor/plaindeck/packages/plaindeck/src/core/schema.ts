import { z } from 'zod'
import { BRAND_ACCENT } from './brand.js'
import { PROJECT_PATHS } from './project-paths.js'
import { PlainDeckError } from './errors.js'

export const FrameSchema = z.object({
  x: z.number().int(), y: z.number().int(), w: z.number().int().positive(), h: z.number().int().positive(),
})

export const ElementAnimationSchema = z.object({
  enter: z.enum(['none', 'fade', 'fade-up', 'fade-down', 'fade-left', 'fade-right', 'scale']),
  delayFrames: z.number().int().nonnegative().optional(),
  durationFrames: z.number().int().positive().optional(),
}).strict()

export const CameraMotionSchema = z.object({
  fromScale: z.number().positive(),
  toScale: z.number().positive(),
  delayFrames: z.number().int().nonnegative().optional(),
  durationFrames: z.number().int().positive().optional(),
}).strict()

export const SlideMotionSchema = z.object({ camera: CameraMotionSchema.optional() }).strict()

const ElementBase = z.object({
  id: z.string().min(1),
  frame: FrameSchema,
  opacity: z.number().min(0).max(1).optional(),
  rotation: z.number().optional(),
  zIndex: z.number().int().optional(),
  animation: ElementAnimationSchema.optional(),
})

export const TextElementSchema = ElementBase.extend({
  type: z.literal('text'),
  text: z.string(),
  styleRef: z.string().optional(),
  align: z.enum(['left', 'center', 'right']).optional(),
  verticalAlign: z.enum(['top', 'middle', 'bottom']).optional(),
  fit: z.enum(['none', 'shrink', 'fill', 'clip']).optional(),
  // Optional per-element allowed size set; fill-fit snaps to the largest
  // member at or below the ideal instead of the theme typeScale.
  scale: z.array(z.number()).min(1).optional(),
  fontSize: z.number().positive().optional(),
  fontFamily: z.string().min(1).optional(),
  color: z.string().optional(),
  fontWeight: z.number().int().min(100).max(900).optional(),
  lineHeight: z.number().positive().optional(),
  letterSpacing: z.number().optional(),
})

export const ImageElementSchema = ElementBase.extend({
  type: z.literal('image'),
  src: z.string().min(1),
  fit: z.enum(['contain', 'cover', 'stretch']).default('contain'),
  alt: z.string().optional(),
})

export const ShapeElementSchema = ElementBase.extend({
  type: z.literal('shape'),
  shape: z.enum(['rectangle', 'rounded-rectangle', 'ellipse']).default('rectangle'),
  fill: z.string().default(BRAND_ACCENT),
  stroke: z.string().optional(),
  strokeWidth: z.number().nonnegative().optional(),
  radius: z.number().nonnegative().optional(),
  text: z.string().optional(),
  textColor: z.string().optional(),
  fontSize: z.number().positive().optional(),
  fontFamily: z.string().min(1).optional(),
  fontWeight: z.number().int().min(100).max(900).optional(),
  align: z.enum(['left', 'center', 'right']).optional(),
  verticalAlign: z.enum(['top', 'middle', 'bottom']).optional(),
})

export const LineElementSchema = ElementBase.extend({
  type: z.literal('line'),
  color: z.string().default('#1F211D'),
  strokeWidth: z.number().positive().default(4),
  dash: z.boolean().optional(),
  arrowEnd: z.boolean().optional(),
})

const TableElementBaseSchema = ElementBase.extend({
  type: z.literal('table'),
  cells: z.array(z.array(z.string()).min(1)).min(1).max(50),
  headerRows: z.number().int().nonnegative().default(1),
  columnWidths: z.array(z.number().positive()).optional(),
  alignments: z.array(z.enum(['left', 'center', 'right'])).optional(),
  style: z.enum(['rules', 'grid', 'stripes']).default('rules'),
  fontSize: z.number().positive().optional(),
  fontFamily: z.string().min(1).optional(),
  textColor: z.string().optional(),
  headerTextColor: z.string().optional(),
  headerFill: z.string().optional(),
  stripeFill: z.string().optional(),
  ruleColor: z.string().optional(),
  accentColor: z.string().optional(),
  ruleWidth: z.number().positive().optional(),
  cellPadding: z.number().nonnegative().optional(),
  highlightRows: z.array(z.number().int().nonnegative()).optional(),
})

const validateTableElement = (element: z.infer<typeof TableElementBaseSchema>, context: z.RefinementCtx) => {
  const columns = element.cells[0]?.length ?? 0
  element.cells.forEach((row, index) => {
    if (row.length !== columns) context.addIssue({ code: 'custom', path: ['cells', index], message: `表格第 ${index + 1} 行有 ${row.length} 列，第一行有 ${columns} 列。` })
  })
  if (element.headerRows > element.cells.length) context.addIssue({ code: 'custom', path: ['headerRows'], message: '表头行数不能超过总行数。' })
  if (element.columnWidths && element.columnWidths.length !== columns) context.addIssue({ code: 'custom', path: ['columnWidths'], message: '列宽数量必须与表格列数一致。' })
  if (element.alignments && element.alignments.length !== columns) context.addIssue({ code: 'custom', path: ['alignments'], message: '对齐方式数量必须与表格列数一致。' })
  element.highlightRows?.forEach((row, index) => {
    if (row >= element.cells.length) context.addIssue({ code: 'custom', path: ['highlightRows', index], message: '高亮行索引超出表格范围。' })
  })
}

export const TableElementSchema = TableElementBaseSchema.superRefine(validateTableElement)

export const ElementSchema = z.discriminatedUnion('type', [
  TextElementSchema, ImageElementSchema, ShapeElementSchema, LineElementSchema, TableElementBaseSchema,
]).superRefine((element, context) => { if (element.type === 'table') validateTableElement(element, context) })

export const SlideSchema = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  layoutRef: z.string().optional(),
  background: z.object({ token: z.string().optional(), color: z.string().optional() }).optional(),
  motion: SlideMotionSchema.optional(),
  elements: z.array(ElementSchema),
})

export const ThemeSchema = z.object({
  fonts: z.object({ title: z.string(), body: z.string(), mono: z.string().optional() }),
  fontSizes: z.object({ title: z.number(), heading: z.number(), body: z.number(), caption: z.number() }),
  colors: z.object({ background: z.string(), text: z.string(), muted: z.string(), accent: z.string(), surface: z.string().optional() }),
  spacing: z.object({ page: z.number(), small: z.number(), medium: z.number(), large: z.number() }),
  // Limited font-size choices for the whole deck: fill-fit sizing snaps the
  // adopted size to the nearest step at or below the ideal, so same-type
  // components render coherently across pages instead of drifting per slide.
  typeScale: z.array(z.number()).min(1).optional(),
})

export const FooterSlotSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('none') }).strict(),
  z.object({ type: z.literal('text'), text: z.string() }).strict(),
  z.object({ type: z.literal('date') }).strict(),
  z.object({ type: z.literal('page') }).strict(),
  z.object({ type: z.literal('page-count') }).strict(),
  z.object({ type: z.literal('page-of-count') }).strict(),
  z.object({ type: z.literal('deck-title') }).strict(),
  z.object({ type: z.literal('slide-name') }).strict(),
])

export const FooterSchema = z.object({
  left: FooterSlotSchema,
  center: FooterSlotSchema,
  right: FooterSlotSchema,
  fontSize: z.number().positive().optional(),
  color: z.string().optional(),
}).strict()

export const DeckSchema = z.object({
  schemaVersion: z.literal('0.1'),
  id: z.string().min(1),
  title: z.string().min(1),
  canvas: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }),
  theme: z.string().default(PROJECT_PATHS.theme),
  footer: FooterSchema.optional(),
  slides: z.array(z.string()).min(1),
})

export type Frame = z.infer<typeof FrameSchema>
export type ElementAnimation = z.infer<typeof ElementAnimationSchema>
export type CameraMotion = z.infer<typeof CameraMotionSchema>
export type SlideMotion = z.infer<typeof SlideMotionSchema>
export type SlideElement = z.infer<typeof ElementSchema>
export type Slide = z.infer<typeof SlideSchema>
export type Theme = z.infer<typeof ThemeSchema>
export type FooterSlot = z.infer<typeof FooterSlotSchema>
export type DeckFooter = z.infer<typeof FooterSchema>
export type Deck = z.infer<typeof DeckSchema>

export interface DeckDocument { deck: Deck; slides: Record<string, Slide>; theme: Theme }

export function assertDocument(input: unknown): DeckDocument {
  const raw = input as DeckDocument
  const deck = DeckSchema.parse(raw.deck)
  const theme = ThemeSchema.parse(raw.theme)
  const slides = Object.fromEntries(Object.entries(raw.slides).map(([path, slide]) => [path, SlideSchema.parse(slide)]))
  for (const path of deck.slides) if (!slides[path]) throw new PlainDeckError('slide-file-missing', { zh: `页面文件缺失：${path}`, en: `Slide file missing from the deck: ${path}` })
  return { deck, slides, theme }
}
