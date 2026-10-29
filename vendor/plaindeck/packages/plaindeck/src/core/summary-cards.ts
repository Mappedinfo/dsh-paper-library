import { z } from 'zod'
import type { DesignRecipe, DesignVariant } from './design-recipes.js'
import type { SlideElement, Theme } from './schema.js'

import { PlainDeckError } from './errors.js'
export const SummaryCardSchema = z.object({
  title: z.string().trim().min(1).max(40),
  description: z.string().trim().min(1).max(320),
  icon: z.string().trim().min(1).max(80).optional(),
}).strict()

export const SummaryCardContentSchema = z.object({
  title: z.string().trim().min(1).max(120),
  cards: z.array(SummaryCardSchema).min(1).max(8),
}).strict()

export type SummaryCard = z.infer<typeof SummaryCardSchema>
export type SummaryCardContent = z.infer<typeof SummaryCardContentSchema>

const iconPattern = /^[a-z][a-z0-9_,-]{0,79}$/i

function stripFence(input: string) {
  const trimmed = input.trim()
  if (!trimmed.startsWith('```')) return trimmed
  const lines = trimmed.split('\n')
  if (lines.length < 3 || lines.at(-1)?.trim() !== '```') return trimmed
  return lines.slice(1, -1).join('\n').trim()
}

function plainText(input: string) {
  return input
    .replaceAll(/<\s*br\s*\/?\s*>/gi, '\n')
    .replaceAll(/<[^>]+>/g, '')
    .replaceAll(/\*\*(.*?)\*\*/g, '$1')
    .replaceAll(/__(.*?)__/g, '$1')
    .replaceAll(/`([^`]+)`/g, '$1')
    .replaceAll(/\s+/g, ' ')
    .trim()
}

export function parseSummaryCards(input: string): SummaryCardContent {
  const cleaned = stripFence(input).replaceAll(/\r\n?/g, '\n').trim()
  if (!cleaned) throw new PlainDeckError('cards-empty', { zh: '卡片内容为空。', en: 'Card content must not be empty.' })

  if (cleaned.startsWith('{')) {
    let value: unknown
    try { value = JSON.parse(cleaned) } catch { throw new PlainDeckError('cards-json-invalid', { zh: '卡片 JSON 无法解析。', en: 'The card JSON could not be parsed.' }) }
    if (!value || typeof value !== 'object') throw new PlainDeckError('cards-json-not-object', { zh: '卡片 JSON 必须是对象。', en: 'The card JSON must be an object.' })
    const raw = value as { title?: unknown; mainTitle?: unknown; cards?: unknown }
    const normalized = {
      title: typeof raw.title === 'string' ? raw.title : raw.mainTitle,
      cards: Array.isArray(raw.cards) ? raw.cards.map(card => {
        const item = card as { title?: unknown; description?: unknown; desc?: unknown; icon?: unknown }
        return {
          title: item.title,
          description: typeof item.description === 'string' ? plainText(item.description) : typeof item.desc === 'string' ? plainText(item.desc) : item.description,
          ...(typeof item.icon === 'string' && iconPattern.test(item.icon) ? { icon: item.icon } : {}),
        }
      }) : raw.cards,
    }
    return SummaryCardContentSchema.parse(normalized)
  }

  const lines = cleaned.split('\n')
  let title = ''
  const cards: SummaryCard[] = []
  let cardTitle = ''
  let body: string[] = []
  const push = () => {
    if (!cardTitle) return
    const compact = body.map(line => line.trim()).filter(Boolean)
    const candidate = compact.at(-1)
    const icon = compact.length > 1 && candidate && iconPattern.test(candidate) ? candidate : undefined
    const description = plainText((icon ? compact.slice(0, -1) : compact).join(' '))
    if (description) cards.push({ title: plainText(cardTitle), description, ...(icon ? { icon } : {}) })
  }
  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (line.startsWith('# ') && !line.startsWith('## ')) { if (!title) title = plainText(line.slice(2)); continue }
    if (line.startsWith('## ')) { push(); cardTitle = line.slice(3); body = []; continue }
    if (cardTitle && line) body.push(line)
  }
  push()
  return SummaryCardContentSchema.parse({ title, cards })
}

export function summaryCardsToMarkdown(content: SummaryCardContent) {
  const valid = SummaryCardContentSchema.parse(content)
  return `# ${valid.title}\n\n${valid.cards.map(card => `## ${card.title}\n${card.description}${card.icon ? `\n${card.icon}` : ''}`).join('\n\n')}`
}

const frame = (x: number, y: number, w: number, h: number) => ({ x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) })

function colorLuminance(value: string) {
  const match = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(value)
  if (!match) return undefined
  const channels = match.slice(1).map(part => {
    const channel = Number.parseInt(part, 16) / 255
    return channel <= .03928 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4
  })
  return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722
}

function contrastRatio(a: string, b: string) {
  const left = colorLuminance(a); const right = colorLuminance(b)
  if (left === undefined || right === undefined) return 0
  return (Math.max(left, right) + .05) / (Math.min(left, right) + .05)
}

function mostReadable(background: string, candidates: string[]) {
  return [...candidates].sort((a, b) => contrastRatio(b, background) - contrastRatio(a, background))[0]
}

export function createSummaryCardElements(content: SummaryCardContent, theme: Theme, canvas = { width: 1600, height: 900 }, recipe?: DesignRecipe): SlideElement[] {
  const valid = SummaryCardContentSchema.parse(content)
  const { width, height } = canvas
  const variant: DesignVariant = recipe?.card.variant ?? 'product'
  const marginX = Math.round(width * .05); const top = Math.round(height * .06)
  const contentWidth = width - marginX * 2
  const cardsTop = Math.round(height * .275); const cardsBottom = Math.round(height * .885)
  const count = valid.cards.length
  const columns = count === 1 ? 1 : count === 2 ? 2 : count === 3 ? 3 : count === 4 ? 2 : count <= 6 ? 3 : 4
  const rows = Math.ceil(count / columns); const gap = Math.round(width * .015 * (recipe?.card.gapScale ?? 1))
  const cardWidth = (contentWidth - gap * (columns - 1)) / columns
  const cardHeight = (cardsBottom - cardsTop - gap * (rows - 1)) / rows
  const compact = count >= 5
  const titleSize = compact ? 32 : count >= 3 ? 36 : 40; const bodySize = compact ? 24 : count >= 3 ? 26 : 30
  const elements: SlideElement[] = []

  if (variant === 'glass') elements.push(
    { id: 'style-glow-a', type: 'shape', frame: frame(width * .72, -height * .18, width * .42, width * .42), shape: 'ellipse', fill: theme.colors.accent, opacity: .14 },
    { id: 'style-glow-b', type: 'shape', frame: frame(-width * .12, height * .68, width * .34, width * .34), shape: 'ellipse', fill: theme.colors.muted, opacity: .12 },
  )
  if (variant === 'art') elements.push(
    { id: 'style-art-block', type: 'shape', frame: frame(width * .77, top - 82, width * .19, 150), shape: 'rectangle', fill: theme.colors.accent, rotation: -7, opacity: .9 },
    { id: 'style-art-dot', type: 'shape', frame: frame(width * .9, cardsBottom - 18, 90, 90), shape: 'ellipse', fill: theme.colors.text, opacity: .14 },
  )
  if (variant === 'future') elements.push(
    { id: 'style-future-line-top', type: 'line', frame: frame(marginX, top - 20, contentWidth, 3), color: theme.colors.accent, strokeWidth: 2 },
    { id: 'style-future-line-side', type: 'line', frame: frame(marginX - 22, cardsTop, 3, cardsBottom - cardsTop), color: theme.colors.accent, strokeWidth: 2 },
  )
  if (variant === 'brutal') elements.push({ id: 'style-brutal-banner', type: 'shape', frame: frame(0, 0, width, 18), shape: 'rectangle', fill: theme.colors.accent })
  if (variant === 'terminal') elements.push({ id: 'style-terminal-bar', type: 'shape', frame: frame(marginX, top - 16, contentWidth, 32), shape: 'rectangle', fill: theme.colors.text, text: `●  ●  ●    ${recipe?.id ?? 'plain'} / local`, textColor: theme.colors.background, fontSize: 12, fontFamily: theme.fonts.mono ?? theme.fonts.body, fontWeight: 700, align: 'left', verticalAlign: 'middle' })

  elements.push(
    { id: 'summary-kicker', type: 'text', frame: frame(marginX, top + (variant === 'terminal' ? 28 : 0), contentWidth, 34), text: recipe ? `${recipe.category.name.toUpperCase()} / ${recipe.name.toUpperCase()}` : 'BRIEF / STRUCTURED SUMMARY', fontSize: 17, fontFamily: theme.fonts.mono ?? theme.fonts.body, fontWeight: 800, color: theme.colors.accent, fit: 'shrink' },
    { id: 'summary-title', type: 'text', styleRef: 'slide-title', frame: frame(marginX, top + (variant === 'terminal' ? 70 : 50), contentWidth, 105), text: valid.title, fontSize: recipe?.theme.fontSizes.title ? Math.min(72, recipe.theme.fontSizes.title) : 58, fontFamily: theme.fonts.title, fontWeight: variant === 'minimal' ? 600 : 800, color: theme.colors.text, fit: 'shrink' },
  )
  if (variant === 'editorial' || variant === 'minimal') elements.push({ id: 'style-title-rule', type: 'line', frame: frame(marginX, cardsTop - 32, contentWidth, 3), color: variant === 'editorial' ? theme.colors.accent : theme.colors.text, strokeWidth: variant === 'editorial' ? 4 : 1 })

  valid.cards.forEach((card, index) => {
    const row = Math.floor(index / columns); const column = index % columns
    const x = marginX + column * (cardWidth + gap); const y = cardsTop + row * (cardHeight + gap)
    const primary = index === 0 && !['terminal', 'future', 'minimal', 'editorial'].includes(variant)
    const fill = primary ? theme.colors.accent : theme.colors.surface ?? theme.colors.background
    const foreground = primary ? mostReadable(fill, [theme.colors.background, theme.colors.text]) : theme.colors.text
    const muted = primary ? foreground : contrastRatio(theme.colors.muted, fill) >= 3 ? theme.colors.muted : theme.colors.text
    const radius = recipe?.card.radius ?? 22; const borderWidth = recipe?.card.borderWidth ?? 2
    const rotation = variant === 'playful' ? (index % 2 ? 1.2 : -1.2) : variant === 'art' ? (index % 3 - 1) * 1.1 : 0
    if (variant === 'brutal') elements.push({ id: `summary-card-${index + 1}-shadow`, type: 'shape', frame: frame(x + 10, y + 10, cardWidth, cardHeight), shape: 'rectangle', fill: theme.colors.text })
    elements.push(
      { id: `summary-card-${index + 1}`, type: 'shape', frame: frame(x, y, cardWidth, cardHeight), shape: radius ? 'rounded-rectangle' : 'rectangle', fill, stroke: primary ? undefined : (variant === 'future' || variant === 'terminal' ? theme.colors.accent : theme.colors.muted), strokeWidth: primary ? 0 : borderWidth, radius, rotation, opacity: variant === 'glass' ? .82 : undefined },
      { id: `summary-card-${index + 1}-index`, type: 'text', frame: frame(x + 26, y + 22, cardWidth - 52, 28), text: `${String(index + 1).padStart(2, '0')}${card.icon ? ` / ${card.icon.replaceAll('_', ' ').toUpperCase()}` : ''}`, fontSize: compact ? 13 : 15, fontFamily: theme.fonts.mono ?? theme.fonts.body, fontWeight: 800, color: primary ? foreground : theme.colors.accent, fit: 'shrink', rotation },
      { id: `summary-card-${index + 1}-title`, type: 'text', frame: frame(x + 26, y + 65, cardWidth - 52, compact ? 54 : 62), text: card.title, fontSize: titleSize, fontFamily: theme.fonts.title, fontWeight: variant === 'minimal' ? 600 : 800, color: foreground, fit: 'fill', rotation },
      { id: `summary-card-${index + 1}-body`, type: 'text', frame: frame(x + 26, y + (compact ? 124 : 138), cardWidth - 52, cardHeight - (compact ? 146 : 164)), text: card.description, fontSize: bodySize, fontFamily: theme.fonts.body, fontWeight: 500, color: muted, fit: 'fill', rotation },
    )
    if (variant === 'editorial') elements.push({ id: `summary-card-${index + 1}-rule`, type: 'shape', frame: frame(x, y, cardWidth, 8), shape: 'rectangle', fill: index % 2 ? theme.colors.text : theme.colors.accent })
    if (variant === 'future') elements.push({ id: `summary-card-${index + 1}-corner`, type: 'shape', frame: frame(x + cardWidth - 28, y, 28, 7), shape: 'rectangle', fill: theme.colors.accent })
  })
  return elements
}

export const exampleSummaryCards = `# 生成式 AI 正在改变什么

## 内容生成
模型可以根据指令生成文字、图像、音频与代码，把创作起点从空白页变成可编辑的初稿。
auto_awesome

## 工作方式
人负责目标、判断与取舍，AI 负责搜索、组合和快速试错；高质量结果依然需要验证。
handshake

## 核心限制
模型可能产生事实错误、偏见或版权风险，重要内容必须保留来源、复核与责任边界。
verified

## 实用原则
从明确任务开始，提供上下文与评价标准，小步迭代，并把最终决定留给人。
route`
