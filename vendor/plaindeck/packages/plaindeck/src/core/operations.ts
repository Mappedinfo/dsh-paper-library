import { z } from 'zod'
import { PlainDeckError } from './errors.js'
import { createLayoutElements, deriveThemeSurface, layoutPresetsFor } from './presets.js'
import { ElementSchema, FooterSchema, SlideMotionSchema, ThemeSchema, assertDocument, type DeckDocument, type SlideElement } from './schema.js'
import { applyDocumentTheme } from './theme.js'
import { createSummaryCardElements, SummaryCardContentSchema } from './summary-cards.js'
import { getDesignRecipe } from './design-recipes.js'
import { createTableSlideElements, TableContentSchema } from './tables.js'
import { PROJECT_PATHS } from './project-paths.js'
import type { DeckLocale } from './i18n.js'

const LayoutIdSchema = z.enum(['blank', 'title-body', 'section', 'statement', 'metric', 'two-column', 'image-right', 'three-cards', 'summary-cards', 'paper-figure', 'paper-table', 'versus', 'contributions', 'limits', 'closing', 'hook-statement', 'prose-panel', 'takeaway', 'process-flow', 'decision-branch'])
const SlidePathSchema = z.string().startsWith(PROJECT_PATHS.slidesDir).endsWith('.json')
const ColorPatchSchema = z.object({
  background: z.string().optional(), text: z.string().optional(), muted: z.string().optional(), accent: z.string().optional(), surface: z.string().optional(),
}).strict()

export const DeckOperationSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('set-element'), slide: SlidePathSchema, element: z.string().min(1), patch: z.record(z.string(), z.unknown()) }).strict(),
  z.object({ op: z.literal('add-element'), slide: SlidePathSchema, element: ElementSchema }).strict(),
  z.object({ op: z.literal('remove-element'), slide: SlidePathSchema, element: z.string().min(1) }).strict(),
  z.object({ op: z.literal('move-element'), slide: SlidePathSchema, element: z.string().min(1), before: z.string().min(1).optional(), after: z.string().min(1).optional() }).strict(),
  z.object({ op: z.literal('add-slide'), layout: LayoutIdSchema.default('blank'), name: z.string().min(1).optional(), after: SlidePathSchema.optional(), id: z.string().regex(/^[a-zA-Z0-9_-]+$/).optional() }).strict(),
  z.object({ op: z.literal('add-summary-slide'), content: SummaryCardContentSchema, style: z.string().min(1).optional(), name: z.string().min(1).optional(), after: SlidePathSchema.optional(), id: z.string().regex(/^[a-zA-Z0-9_-]+$/).optional() }).strict(),
  z.object({ op: z.literal('add-table-slide'), content: TableContentSchema, style: z.enum(['rules', 'grid', 'stripes']).default('rules'), name: z.string().min(1).optional(), after: SlidePathSchema.optional(), id: z.string().regex(/^[a-zA-Z0-9_-]+$/).optional() }).strict(),
  z.object({ op: z.literal('duplicate-slide'), slide: SlidePathSchema, id: z.string().regex(/^[a-zA-Z0-9_-]+$/).optional(), name: z.string().min(1).optional() }).strict(),
  z.object({ op: z.literal('rename-slide'), slide: SlidePathSchema, name: z.string().trim().min(1) }).strict(),
  z.object({ op: z.literal('set-slide-motion'), slide: SlidePathSchema, motion: SlideMotionSchema.nullable() }).strict(),
  z.object({ op: z.literal('move-slide'), slide: SlidePathSchema, before: SlidePathSchema.optional(), after: SlidePathSchema.optional() }).strict(),
  z.object({ op: z.literal('remove-slide'), slide: SlidePathSchema }).strict(),
  z.object({ op: z.literal('set-footer'), footer: FooterSchema.nullable() }).strict(),
  z.object({ op: z.literal('set-theme'), patch: ColorPatchSchema.optional(), theme: ThemeSchema.optional() }).strict(),
])

export const DeckOperationsSchema = z.array(DeckOperationSchema).min(1)
export type DeckOperation = z.infer<typeof DeckOperationSchema>

export interface ApplyOperationsOptions {
  /** Language for generated placeholder copy (e.g. `add-slide` layout placeholders). */
  locale?: DeckLocale
}

export interface ApplyOperationsResult {
  document: DeckDocument
  changedPaths: string[]
}

function requireSlide(document: DeckDocument, path: string) {
  const slide = document.slides[path]
  if (!slide || !document.deck.slides.includes(path)) throw new PlainDeckError('slide-not-found', { zh: `页面不存在：${path}`, en: `Slide not found: ${path}` })
  return slide
}

function uniqueSlidePath(document: DeckDocument, id: string) {
  let sequence = document.deck.slides.length + 1
  while (document.slides[`./slides/${String(sequence).padStart(3, '0')}-${id}.json`]) sequence += 1
  return `./slides/${String(sequence).padStart(3, '0')}-${id}.json`
}

function moveRelative(items: string[], item: string, before?: string, after?: string) {
  if ((before && after) || (!before && !after)) throw new PlainDeckError('move-requires-before-or-after', { zh: '移动操作必须且只能指定 before 或 after。', en: 'A move requires exactly one of before or after.' })
  const target = before ?? after!
  if (item === target) throw new PlainDeckError('move-target-self', { zh: '移动目标不能是自身。', en: 'The move target must not be the item itself.' })
  const from = items.indexOf(item); const targetBeforeMove = items.indexOf(target)
  if (from < 0) throw new PlainDeckError('move-item-not-found', { zh: `移动对象不存在：${item}`, en: `Item to move does not exist: ${item}` })
  if (targetBeforeMove < 0) throw new PlainDeckError('move-target-not-found', { zh: `移动目标不存在：${target}`, en: `Move target does not exist: ${target}` })
  items.splice(from, 1)
  const targetIndex = items.indexOf(target)
  items.splice(targetIndex + (after ? 1 : 0), 0, item)
}

export function applyOperations(input: DeckDocument, rawOperations: unknown, options: ApplyOperationsOptions = {}): ApplyOperationsResult {
  const operations = DeckOperationsSchema.parse(rawOperations)
  let document = structuredClone(input)
  const changed = new Set<string>()

  for (const operation of operations) {
    if (operation.op === 'set-element') {
      const slide = requireSlide(document, operation.slide)
      const index = slide.elements.findIndex(element => element.id === operation.element)
      if (index < 0) throw new PlainDeckError('element-not-found', { zh: `元素不存在：${operation.slide}#${operation.element}`, en: `Element not found: ${operation.slide}#${operation.element}` })
      if ('id' in operation.patch || 'type' in operation.patch) throw new PlainDeckError('set-element-id-type-immutable', { zh: 'set-element 不允许修改元素 id 或 type。', en: 'set-element cannot change the element id or type.' })
      const current = slide.elements[index]
      const patch = operation.patch as Partial<SlideElement>
      slide.elements[index] = {
        ...current,
        ...patch,
        frame: patch.frame ? { ...current.frame, ...patch.frame } : current.frame,
      } as SlideElement
      changed.add(operation.slide)
    } else if (operation.op === 'add-element') {
      const slide = requireSlide(document, operation.slide)
      if (slide.elements.some(element => element.id === operation.element.id)) throw new PlainDeckError('element-id-exists', { zh: `元素 ID 已存在：${operation.element.id}`, en: `Element ID already exists: ${operation.element.id}` })
      slide.elements.push(structuredClone(operation.element))
      changed.add(operation.slide)
    } else if (operation.op === 'remove-element') {
      const slide = requireSlide(document, operation.slide)
      const index = slide.elements.findIndex(element => element.id === operation.element)
      if (index < 0) throw new PlainDeckError('element-not-found', { zh: `元素不存在：${operation.slide}#${operation.element}`, en: `Element not found: ${operation.slide}#${operation.element}` })
      slide.elements.splice(index, 1)
      changed.add(operation.slide)
    } else if (operation.op === 'move-element') {
      const slide = requireSlide(document, operation.slide)
      const order = slide.elements.map(element => element.id)
      moveRelative(order, operation.element, operation.before, operation.after)
      const byId = new Map(slide.elements.map(element => [element.id, element]))
      slide.elements = order.map(id => byId.get(id)!)
      changed.add(operation.slide)
    } else if (operation.op === 'add-slide') {
      const id = operation.id ?? `slide-${globalThis.crypto.randomUUID().slice(0, 8)}`
      if (Object.values(document.slides).some(slide => slide.id === id)) throw new PlainDeckError('slide-id-exists', { zh: `页面 ID 已存在：${id}`, en: `Slide ID already exists: ${id}` })
      const path = uniqueSlidePath(document, id)
      const preset = layoutPresetsFor(options.locale ?? 'zh').find(item => item.id === operation.layout)
      if (!preset) throw new PlainDeckError('unknown-layout', { zh: `未知布局：${operation.layout}`, en: `Unknown layout: ${operation.layout}` })
      const afterIndex = operation.after ? document.deck.slides.indexOf(operation.after) : document.deck.slides.length - 1
      if (operation.after && afterIndex < 0) throw new PlainDeckError('slide-not-found', { zh: `页面不存在：${operation.after}`, en: `Slide not found: ${operation.after}` })
      document.deck.slides.splice(afterIndex + 1, 0, path)
      document.slides[path] = { id, name: operation.name ?? preset.name, layoutRef: operation.layout, elements: createLayoutElements(operation.layout, document.theme, undefined, options.locale) }
      changed.add(PROJECT_PATHS.deck); changed.add(path)
    } else if (operation.op === 'add-summary-slide') {
      const id = operation.id ?? `summary-${globalThis.crypto.randomUUID().slice(0, 8)}`
      if (Object.values(document.slides).some(slide => slide.id === id)) throw new PlainDeckError('slide-id-exists', { zh: `页面 ID 已存在：${id}`, en: `Slide ID already exists: ${id}` })
      const recipe = operation.style ? getDesignRecipe(operation.style) : undefined
      if (operation.style && !recipe) throw new PlainDeckError('unknown-design-recipe', { zh: `未知设计配方：${operation.style}`, en: `Unknown design recipe: ${operation.style}` })
      const slideTheme = recipe?.theme ?? document.theme
      const path = uniqueSlidePath(document, id)
      const afterIndex = operation.after ? document.deck.slides.indexOf(operation.after) : document.deck.slides.length - 1
      if (operation.after && afterIndex < 0) throw new PlainDeckError('slide-not-found', { zh: `页面不存在：${operation.after}`, en: `Slide not found: ${operation.after}` })
      document.deck.slides.splice(afterIndex + 1, 0, path)
      document.slides[path] = {
        id,
        name: operation.name ?? operation.content.title,
        layoutRef: recipe ? `summary-cards/${recipe.id}` : 'summary-cards',
        background: { color: slideTheme.colors.background },
        elements: createSummaryCardElements(operation.content, slideTheme, document.deck.canvas, recipe),
      }
      changed.add(PROJECT_PATHS.deck); changed.add(path)
    } else if (operation.op === 'add-table-slide') {
      const id = operation.id ?? `table-${globalThis.crypto.randomUUID().slice(0, 8)}`
      if (Object.values(document.slides).some(slide => slide.id === id)) throw new PlainDeckError('slide-id-exists', { zh: `页面 ID 已存在：${id}`, en: `Slide ID already exists: ${id}` })
      const path = uniqueSlidePath(document, id)
      const afterIndex = operation.after ? document.deck.slides.indexOf(operation.after) : document.deck.slides.length - 1
      if (operation.after && afterIndex < 0) throw new PlainDeckError('slide-not-found', { zh: `页面不存在：${operation.after}`, en: `Slide not found: ${operation.after}` })
      document.deck.slides.splice(afterIndex + 1, 0, path)
      document.slides[path] = {
        id,
        name: operation.name ?? operation.content.title,
        layoutRef: `table/${operation.style}`,
        background: { color: document.theme.colors.background },
        elements: createTableSlideElements(operation.content, document.theme, document.deck.canvas, operation.style),
      }
      changed.add(PROJECT_PATHS.deck); changed.add(path)
    } else if (operation.op === 'duplicate-slide') {
      const source = requireSlide(document, operation.slide)
      const id = operation.id ?? `${source.id}-${globalThis.crypto.randomUUID().slice(0, 8)}`
      if (Object.values(document.slides).some(slide => slide.id === id)) throw new PlainDeckError('slide-id-exists', { zh: `页面 ID 已存在：${id}`, en: `Slide ID already exists: ${id}` })
      const path = uniqueSlidePath(document, id)
      const copy = structuredClone(source); copy.id = id; copy.name = operation.name ?? `${source.name ?? source.id} copy`
      document.deck.slides.splice(document.deck.slides.indexOf(operation.slide) + 1, 0, path)
      document.slides[path] = copy
      changed.add(PROJECT_PATHS.deck); changed.add(path)
    } else if (operation.op === 'rename-slide') {
      requireSlide(document, operation.slide).name = operation.name.trim()
      changed.add(operation.slide)
    } else if (operation.op === 'set-slide-motion') {
      const slide = requireSlide(document, operation.slide)
      if (operation.motion) slide.motion = structuredClone(operation.motion)
      else delete slide.motion
      changed.add(operation.slide)
    } else if (operation.op === 'move-slide') {
      requireSlide(document, operation.slide)
      if (operation.before) requireSlide(document, operation.before)
      if (operation.after) requireSlide(document, operation.after)
      moveRelative(document.deck.slides, operation.slide, operation.before, operation.after)
      changed.add(PROJECT_PATHS.deck)
    } else if (operation.op === 'remove-slide') {
      if (document.deck.slides.length === 1) throw new PlainDeckError('cannot-delete-last-slide', { zh: '不能删除最后一页。', en: 'Cannot delete the last slide.' })
      requireSlide(document, operation.slide)
      document.deck.slides = document.deck.slides.filter(path => path !== operation.slide)
      delete document.slides[operation.slide]
      changed.add(PROJECT_PATHS.deck); changed.add(operation.slide)
    } else if (operation.op === 'set-footer') {
      if (operation.footer) document.deck.footer = structuredClone(operation.footer)
      else delete document.deck.footer
      changed.add(PROJECT_PATHS.deck)
    } else {
      if ((operation.patch && operation.theme) || (!operation.patch && !operation.theme)) throw new PlainDeckError('set-theme-exclusive', { zh: 'set-theme 必须且只能指定 patch 或 theme。', en: 'set-theme requires exactly one of patch or theme.' })
      let theme = operation.theme
      if (!theme) {
        const colors = { ...document.theme.colors, ...operation.patch }
        if (!operation.patch?.surface) colors.surface = deriveThemeSurface(colors.background, colors.text)
        theme = { ...document.theme, colors }
      }
      document = applyDocumentTheme(document, theme)
      changed.add(document.deck.theme)
      document.deck.slides.forEach(path => changed.add(path))
    }
  }

  return { document: assertDocument(document), changedPaths: [...changed] }
}
