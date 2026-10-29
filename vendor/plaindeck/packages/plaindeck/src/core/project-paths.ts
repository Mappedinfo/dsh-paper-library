/**
 * On-disk layout constants for PlainDeck projects — single source of truth.
 * Consumers: schema defaults, save-plan, operations, templates, CLI, node IO,
 * web storage (browserStorage / zipStorage) and HTML export.
 */
export const PROJECT_PATHS = {
  deck: 'deck.json',
  theme: './theme.json',
  slidesDir: './slides/',
  assetsDir: './assets/',
  themeCss: 'theme.css',
  gitignore: '.gitignore',
  exportsDir: 'exports',
} as const

/** Regex for a valid slide file path inside the project. */
export const SLIDE_PATH_PATTERN = /^\.\/slides\/[^/]+\.json$/

/** .gitignore content written into new projects (web and CLI writers). */
export const GITIGNORE_TEMPLATE = 'exports/*\n!exports/.gitkeep\n.DS_Store\n'
