import type { DeckLocale } from 'plaindeck/core'

let selected: DeckLocale | null = null
export function resolveDeckLocale(): DeckLocale { return selected ?? 'zh' }
export function peekDeckLocaleOverride(): DeckLocale | null { return selected }
export function rememberDeckLocale(locale: DeckLocale | null): void { selected = locale }
