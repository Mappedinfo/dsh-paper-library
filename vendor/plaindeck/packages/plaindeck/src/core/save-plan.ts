import { PlainDeckError } from './errors.js'
import { assertDocument, type DeckDocument } from './schema.js'
import { canonicalJson } from './serializer.js'
import { PROJECT_PATHS, SLIDE_PATH_PATTERN } from './project-paths.js'

export interface SavePlanWrite {
  path: string
  content: string
}

export interface SavePlan {
  targets: string[]
  writes: SavePlanWrite[]
  deletions: string[]
}

export function createSavePlan(input: DeckDocument, changedPaths?: Iterable<string>): SavePlan {
  const document = assertDocument(input)
  const targets = [...new Set(changedPaths ?? [PROJECT_PATHS.deck, document.deck.theme, ...document.deck.slides])]
  const currentPaths = new Set([PROJECT_PATHS.deck, document.deck.theme, ...document.deck.slides])

  for (const target of targets) {
    if (!currentPaths.has(target) && !(SLIDE_PATH_PATTERN.test(target) && !document.slides[target])) {
      throw new PlainDeckError('unknown-save-path', { zh: `不允许写入未知项目路径：${target}`, en: `Refusing to write unknown project path: ${target}` })
    }
  }

  const contentTargets = targets.filter(path => path !== PROJECT_PATHS.deck && currentPaths.has(path))
  const writes = contentTargets.map(path => ({
    path,
    content: canonicalJson(path === document.deck.theme ? document.theme : document.slides[path]),
  }))
  if (targets.includes(PROJECT_PATHS.deck)) writes.push({ path: PROJECT_PATHS.deck, content: canonicalJson(document.deck) })

  return {
    targets,
    writes,
    deletions: targets.filter(path => SLIDE_PATH_PATTERN.test(path) && !document.slides[path]),
  }
}
