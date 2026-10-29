import { PlainDeckError } from './errors.js'
import { DeckSchema, type Deck } from './schema.js'

export interface Migration { from: string; to: string; migrate: (input: unknown) => unknown }
export const migrations: Migration[] = []

export function migrateDeck(input: unknown): Deck {
  let current = input as Record<string, unknown>
  const seen = new Set<string>()
  while (current.schemaVersion !== '0.1') {
    const version = String(current.schemaVersion ?? 'unknown')
    if (seen.has(version)) throw new PlainDeckError('migration-loop', { zh: `迁移循环：${version}`, en: `Migration loop at version ${version}` })
    seen.add(version)
    const migration = migrations.find(item => item.from === version)
    if (!migration) throw new PlainDeckError('unsupported-schema-version', { zh: `不支持的 schema 版本：${version}`, en: `Unsupported schema version: ${version}` })
    current = migration.migrate(current) as Record<string, unknown>
  }
  return DeckSchema.parse(current)
}
