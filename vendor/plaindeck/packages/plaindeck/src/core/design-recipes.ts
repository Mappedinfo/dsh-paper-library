import { PlainDeckError } from './errors.js'
import { z } from 'zod'
import generated from './generated/juya-design-recipes.json' with { type: 'json' }
import { ThemeSchema } from './schema.js'

export const DesignVariantSchema = z.enum(['minimal', 'editorial', 'brutal', 'glass', 'terminal', 'future', 'playful', 'organic', 'art', 'product'])

export const DesignRecipeSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  category: z.object({ id: z.string().min(1), name: z.string().min(1) }).strict(),
  icon: z.string().min(1),
  source: z.object({ file: z.string().min(1), sha256: z.string().regex(/^[\da-f]{64}$/) }).strict(),
  theme: ThemeSchema,
  card: z.object({
    variant: DesignVariantSchema,
    radius: z.number().nonnegative(),
    borderWidth: z.number().nonnegative(),
    gapScale: z.number().positive(),
  }).strict(),
}).strict()

const CatalogSchema = z.object({
  schemaVersion: z.literal('1'),
  source: z.object({ repository: z.string().url(), commit: z.string().regex(/^[\da-f]{40}$/), templateCount: z.number().int().positive() }).strict(),
  recipes: z.array(DesignRecipeSchema),
}).strict()

const catalog = CatalogSchema.parse(generated)
if (catalog.recipes.length !== catalog.source.templateCount) throw new PlainDeckError('recipe-source-mismatch', { zh: '设计配方目录数量与来源声明不一致。', en: 'The design recipe catalog count does not match its declared source.' })

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
  }
  return value
}

export type DesignVariant = z.infer<typeof DesignVariantSchema>
export type DesignRecipe = z.infer<typeof DesignRecipeSchema>

export const designRecipeSource = deepFreeze(catalog.source)
export const designRecipes: readonly DesignRecipe[] = deepFreeze(catalog.recipes)
export const designRecipeCategories = [...new Map(designRecipes.map(recipe => [recipe.category.id, recipe.category])).values()]

export function getDesignRecipe(id: string) {
  return designRecipes.find(recipe => recipe.id === id)
}

export function searchDesignRecipes(query = '', category?: string) {
  const normalized = query.trim().toLocaleLowerCase()
  return designRecipes.filter(recipe => {
    if (category && recipe.category.id !== category) return false
    if (!normalized) return true
    return `${recipe.id} ${recipe.name} ${recipe.description} ${recipe.category.name} ${recipe.card.variant}`.toLocaleLowerCase().includes(normalized)
  })
}
