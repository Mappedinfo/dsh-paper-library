import type { Messages } from './messages.en'
import { getLocale, getMessages } from './index'

/**
 * Error thrown by editor modules with a dictionary key plus interpolation
 * params; the user-facing sentence is resolved in the active locale at render
 * time, so switching languages also translates pending error toasts.
 */
export class LocalizedError extends Error {
  constructor(readonly messageKey: keyof Messages['errors'], readonly params: unknown[] = []) {
    super(String(messageKey))
    this.name = 'LocalizedError'
  }

  /** Resolve to a human-readable sentence, preferring the current UI locale. */
  text(): string {
    const template: unknown = getMessages().errors[this.messageKey]
    return typeof template === 'function' ? (template as (...args: unknown[]) => string)(...this.params) : this.message
  }
}

/** Best-effort localized text for any caught value (editor + plaindeck core errors). */
export function errorText(error: unknown): string {
  if (error instanceof LocalizedError) return error.text()
  // Duck-typed PlainDeckError from plaindeck/core carries { zh, en } sentences.
  const localized = (error as { localized?: { zh?: string; en?: string } } | null)?.localized
  if (localized && typeof localized[getLocale()] === 'string') return localized[getLocale()] as string
  return error instanceof Error ? error.message : String(error)
}

export function throwLocalized(key: keyof Messages['errors'], ...params: unknown[]): never {
  throw new LocalizedError(key, params)
}
