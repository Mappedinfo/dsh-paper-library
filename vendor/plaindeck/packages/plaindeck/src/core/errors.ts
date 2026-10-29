import type { DeckLocale } from './i18n.js'

/** A user-facing sentence per supported locale; zh is the canonical `.message`. */
export interface LocalizedMessage {
  zh: string
  en: string
}

/**
 * Structured deck error carrying a stable machine-readable `code` plus both
 * locale strings, so Agent/MCP consumers can branch on the code or pick a
 * language while existing callers keep reading Chinese `error.message`.
 */
export class PlainDeckError extends Error {
  readonly code: string
  readonly localized: Readonly<LocalizedMessage>

  constructor(code: string, message: LocalizedMessage, options?: { cause?: unknown }) {
    super(message.zh, options)
    this.name = 'PlainDeckError'
    this.code = code
    this.localized = message
  }

  /** The sentence for one locale. */
  for(locale: DeckLocale): string {
    return this.localized[locale]
  }
}

/** Human text for any caught value; localizes plaindeck errors when requested. */
export function errorMessage(error: unknown, locale?: DeckLocale): string {
  if (locale && error instanceof PlainDeckError) return error.for(locale)
  if (error instanceof Error) return error.message
  return String(error)
}
