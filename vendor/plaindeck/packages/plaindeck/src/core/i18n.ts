/** Supported deck content languages. */
export type DeckLocale = 'en' | 'zh'

/**
 * Resolve BCP-47 language tags (e.g. `navigator.languages`) to a supported deck
 * locale. Chinese variants map to `zh`; everything else — including an empty or
 * unmatched list — falls back to English.
 */
export function resolveLocale(tags?: string | string[] | null): DeckLocale {
  const list = Array.isArray(tags) ? tags : tags ? [tags] : []
  for (const tag of list) {
    const normalized = String(tag).trim().toLowerCase()
    if (normalized.startsWith('zh')) return 'zh'
    if (normalized.startsWith('en')) return 'en'
  }
  return 'en'
}
