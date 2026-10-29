/**
 * Generic typography best practices shared across deck generators:
 * a bounded type scale, prose-to-structure helpers, and per-page component
 * size unification. Domain-specific policy (density contracts, caption safe
 * zones, topic kickers) stays in the consuming workflow; these utilities are
 * format-level.
 */

/** Limited font-size choices for a whole deck: fill-fit snaps the adopted size to the nearest step at or below the ideal. */
export const DEFAULT_TYPE_SCALE = [16, 18, 20, 22, 24, 28, 32, 36, 40, 44, 48, 52, 56, 64, 72, 84, 96]

/** Split dense prose into a lead sentence + support sentences so long-form pages get typographic hierarchy. */
export function splitLeadSupport(body: string): { lead: string; support: string } {
  const sentences = String(body ?? '').match(/[^。！？!?]+[。！？!?]?/g)
    ?.map((sentence) => sentence.trim())
    .filter(Boolean) ?? []
  if (sentences.length <= 1) return { lead: sentences[0] ?? '', support: '' }
  // support 按句号逐句分行：每句一行（\n），渲染端 pre-wrap 保留换行。
  // 这样长正文以可读的行列表呈现，而不是被压成一段小字。
  return { lead: sentences[0], support: sentences.slice(1).join('\n') }
}

/** Split a body into numbered takeaway clauses on ；/; separators. */
export function splitClauses(body: string): string[] {
  return String(body ?? '')
    .split(/[；;]/)
    .map((clause) => clause.trim().replace(/。$/, ''))
    .filter(Boolean)
}
