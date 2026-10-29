import { ZodError } from 'zod'
import { assertDocument, type DeckDocument } from './schema.js'

export interface ValidationIssue {
  code: string
  path: Array<string | number>
  message: string
}

export type ValidationResult =
  | { valid: true; document: DeckDocument; issues: [] }
  | { valid: false; issues: ValidationIssue[] }

export function validateDeck(input: unknown): ValidationResult {
  try {
    return { valid: true, document: assertDocument(input), issues: [] }
  } catch (error) {
    if (error instanceof ZodError) {
      return {
        valid: false,
        issues: error.issues.map(issue => ({ code: issue.code, path: issue.path.map(segment => typeof segment === 'symbol' ? String(segment) : segment), message: issue.message })),
      }
    }
    return {
      valid: false,
      issues: [{ code: 'document_error', path: [], message: error instanceof Error ? error.message : String(error) }],
    }
  }
}
