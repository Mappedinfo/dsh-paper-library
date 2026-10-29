import type { DeckDocument, Theme } from './schema.js'
import { deriveThemeSurface } from './presets.js'

const colorRoles = ['background', 'text', 'muted', 'accent', 'surface'] as const

/** Return a cloned document with theme-bound colors remapped to a new theme. */
export function applyDocumentTheme(input: DeckDocument, nextTheme: Theme): DeckDocument {
  const document = structuredClone(input)
  const previous = input.theme.colors
  const pairs: Array<[string | undefined, string | undefined]> = colorRoles.map(key => [previous[key], nextTheme.colors[key]])
  pairs.push(
    [previous.surface ?? deriveThemeSurface(previous.background, previous.text), nextTheme.colors.surface ?? deriveThemeSurface(nextTheme.colors.background, nextTheme.colors.text)],
  )
  const replace = (value?: string) => {
    if (!value) return value
    const match = pairs.find(([from]) => from?.toLowerCase() === value.toLowerCase())
    return match?.[1] ?? value
  }

  for (const slide of Object.values(document.slides)) {
    if (slide.background?.color) slide.background.color = replace(slide.background.color)
    for (const element of slide.elements) {
      if (element.type === 'text') element.color = replace(element.color)
      else if (element.type === 'shape') {
        element.fill = replace(element.fill) ?? element.fill
        element.stroke = replace(element.stroke)
        element.textColor = replace(element.textColor)
      } else if (element.type === 'line') element.color = replace(element.color) ?? element.color
      else if (element.type === 'table') {
        element.textColor = replace(element.textColor)
        element.headerTextColor = replace(element.headerTextColor)
        element.headerFill = replace(element.headerFill)
        element.stripeFill = replace(element.stripeFill)
        element.ruleColor = replace(element.ruleColor)
        element.accentColor = replace(element.accentColor)
      }
    }
  }
  document.theme = structuredClone(nextTheme)
  return document
}
