import { useSyncExternalStore } from 'react'
import type { DeckLocale } from 'plaindeck/core'
import { rememberDeckLocale, resolveDeckLocale } from '../core/language'
import type { Messages } from './messages.en'
import { en } from './messages.en'
import { zh } from './messages.zh'

export type { Messages }

const dictionaries: Record<DeckLocale, Messages> = { en, zh }

let locale: DeckLocale = resolveDeckLocale()
let version = 0
const listeners = new Set<() => void>()

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Current UI/deck locale without entering React. Safe for non-component code. */
export function getLocale(): DeckLocale {
  return locale
}

export function getMessages(): Messages {
  return dictionaries[locale]
}

/**
 * Switch the editor language. `null` clears any saved override and returns to
 * browser detection; a concrete locale is remembered for future visits.
 */
export function setLocale(next: DeckLocale | null): void {
  rememberDeckLocale(next)
  const resolved = next ?? resolveDeckLocale()
  if (resolved === locale) return
  locale = resolved
  version += 1
  listeners.forEach(listener => listener())
}

function getSnapshot() {
  return version
}

/** Reactive dictionary access: re-renders when the locale changes. */
export function useT(): { t: Messages; locale: DeckLocale } {
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  return { t: dictionaries[locale], locale }
}
