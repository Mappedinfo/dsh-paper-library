import { createDeckTemplate, getThemePreset, type DeckDocument, type DeckLocale } from 'plaindeck/core'
import { resolveDeckLocale } from './language'

export const defaultTheme = getThemePreset('nature-editorial')!.theme

export function createSampleDocument(lang: DeckLocale = resolveDeckLocale()): DeckDocument {
  return createDeckTemplate('nature-methods', { id: 'plaindeck-nature-methods', theme: 'nature-editorial', lang })
}
