import { resolveLocale, type DeckLocale } from 'plaindeck/core'

const LOCALE_STORAGE_KEY = 'plaindeck.deck-locale'

function browserLocales(): string[] {
  if (typeof navigator === 'undefined') return []
  return [...(navigator.languages ?? []), navigator.language].filter(Boolean) as string[]
}

/** Preferred deck language: an explicit user override wins, otherwise follow the browser and fall back to English. */
export function resolveDeckLocale(): DeckLocale {
  try {
    const stored = globalThis.localStorage?.getItem(LOCALE_STORAGE_KEY)
    if (stored) return resolveLocale(stored)
  } catch { /* storage unavailable (private mode) */ }
  return resolveLocale(browserLocales())
}

/** The raw saved override without detection fallback (`null` = follow the browser). */
export function peekDeckLocaleOverride(): DeckLocale | null {
  try {
    const stored = globalThis.localStorage?.getItem(LOCALE_STORAGE_KEY)
    return stored ? resolveLocale(stored) : null
  } catch { return null }
}

export function rememberDeckLocale(locale: DeckLocale | null): void {
  try {
    if (locale) globalThis.localStorage?.setItem(LOCALE_STORAGE_KEY, locale)
    else globalThis.localStorage?.removeItem(LOCALE_STORAGE_KEY)
  } catch { /* storage unavailable (private mode) */ }
}
