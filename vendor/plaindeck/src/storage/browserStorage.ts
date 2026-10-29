import type { DeckDocument, Slide, Theme } from 'plaindeck/core'
import { DeckSchema, SlideSchema, ThemeSchema, assertDocument, canonicalJson, createSavePlan, GITIGNORE_TEMPLATE, migrateDeck, PROJECT_PATHS } from 'plaindeck/core'
import { getLocale } from '../i18n'
import { throwLocalized } from '../i18n/errors'

export type DirectoryHandle = FileSystemDirectoryHandle
const baselines = new WeakMap<DirectoryHandle, Map<string, string>>()
const assetUrls = new WeakMap<DirectoryHandle, Map<string, string>>()

type PermissionStateValue = 'granted' | 'denied' | 'prompt'
type WritableDirectoryHandle = FileSystemDirectoryHandle & {
  queryPermission(options: { mode: 'readwrite' }): Promise<PermissionStateValue>
  requestPermission(options: { mode: 'readwrite' }): Promise<PermissionStateValue>
}

async function fileHandle(root: DirectoryHandle, path: string, create = false): Promise<FileSystemFileHandle> {
  const parts = path.replace(/^\.\//, '').split('/')
  const name = parts.pop()
  if (!name) throwLocalized('invalidPath', path)
  let directory = root
  for (const part of parts) directory = await directory.getDirectoryHandle(part, { create })
  return directory.getFileHandle(name, { create })
}

async function readText(root: DirectoryHandle, path: string): Promise<string> {
  const handle = await fileHandle(root, path)
  return (await handle.getFile()).text()
}

async function pathExists(root: DirectoryHandle, path: string): Promise<boolean> {
  try { await fileHandle(root, path); return true } catch (error) {
    if ((error as DOMException).name === 'NotFoundError') return false
    throw error
  }
}

async function removePath(root: DirectoryHandle, path: string): Promise<void> {
  const parts = path.replace(/^\.\//, '').split('/')
  const name = parts.pop()
  if (!name) throwLocalized('invalidPath', path)
  let directory = root
  for (const part of parts) directory = await directory.getDirectoryHandle(part)
  await directory.removeEntry(name)
}

export async function readAsset(root: DirectoryHandle, path: string): Promise<Blob> {
  return (await fileHandle(root, path)).getFile()
}

export async function resolveAssetUrl(root: DirectoryHandle, path: string): Promise<string> {
  const cached = assetUrls.get(root)?.get(path)
  if (cached) return cached
  const url = URL.createObjectURL(await readAsset(root, path))
  const urls = assetUrls.get(root) ?? new Map<string, string>(); urls.set(path, url); assetUrls.set(root, urls)
  return url
}

export async function writeImageAsset(root: DirectoryHandle, file: File): Promise<string> {
  const extensionByType: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/svg+xml': 'svg' }
  const extension = extensionByType[file.type] ?? file.name.match(/\.([a-zA-Z0-9]+)$/)?.[1]?.toLowerCase() ?? 'image'
  const base = file.name.replace(/\.[^.]+$/, '').normalize('NFKD').replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'image'
  const path = `${PROJECT_PATHS.assetsDir}${base}-${crypto.randomUUID().slice(0, 8)}.${extension}`
  const handle = await fileHandle(root, path, true); const writable = await handle.createWritable(); await writable.write(file); await writable.close()
  const urls = assetUrls.get(root) ?? new Map<string, string>(); urls.set(path, URL.createObjectURL(file)); assetUrls.set(root, urls)
  return path
}

export async function readProject(root: DirectoryHandle): Promise<DeckDocument> {
  const baseline = new Map<string, string>()
  const deckText = await readText(root, PROJECT_PATHS.deck); baseline.set(PROJECT_PATHS.deck, deckText)
  const deck = migrateDeck(JSON.parse(deckText))
  const themeText = await readText(root, deck.theme); baseline.set(deck.theme, themeText)
  const theme = ThemeSchema.parse(JSON.parse(themeText))
  const slides: Record<string, Slide> = {}
  for (const path of deck.slides) { const text = await readText(root, path); baseline.set(path, text); slides[path] = SlideSchema.parse(JSON.parse(text)) }
  baselines.set(root, baseline)
  return assertDocument({ deck: DeckSchema.parse(deck), slides, theme })
}

export async function writeText(root: DirectoryHandle, path: string, content: string): Promise<void> {
  const handle = await fileHandle(root, path, true)
  const writable = await handle.createWritable()
  await writable.write(content)
  await writable.close()
}

async function writeChecked(root: DirectoryHandle, path: string, content: string): Promise<void> {
  const baseline = baselines.get(root)
  const expected = baseline?.get(path)
  if (expected !== undefined) {
    let current: string
    try { current = await readText(root, path) } catch { throwLocalized('deletedExternallyOverwrite', path) }
    if (current !== expected) throwLocalized('modifiedExternallySave', path)
  } else if (await pathExists(root, path)) throwLocalized('targetExistsOverwrite', path)
  await writeText(root, path, content)
  const next = baselines.get(root) ?? new Map<string, string>(); next.set(path, content); baselines.set(root, next)
}

async function removeChecked(root: DirectoryHandle, path: string): Promise<void> {
  const baseline = baselines.get(root)
  const expected = baseline?.get(path)
  if (!await pathExists(root, path)) { baseline?.delete(path); return }
  if (expected === undefined) throwLocalized('notInBaselineDelete', path)
  const current = await readText(root, path)
  if (current !== expected) throwLocalized('modifiedExternallyDelete', path)
  await removePath(root, path)
  baseline?.delete(path)
}

export async function writeProject(root: DirectoryHandle, document: DeckDocument, paths?: Set<string>): Promise<void> {
  const plan = createSavePlan(document, paths)
  for (const write of plan.writes) await writeChecked(root, write.path, write.content)
  for (const path of plan.deletions) await removeChecked(root, path)
  if (!paths) {
    await root.getDirectoryHandle(PROJECT_PATHS.assetsDir.replace(/^\.\//, ''), { create: true })
    await root.getDirectoryHandle(PROJECT_PATHS.exportsDir, { create: true })
    await writeChecked(root, PROJECT_PATHS.themeCss, themeCss(document.theme))
    await writeChecked(root, PROJECT_PATHS.gitignore, GITIGNORE_TEMPLATE)
  }
}

export function projectInitializationPaths(document: DeckDocument): string[] {
  const checked = assertDocument(document)
  return [PROJECT_PATHS.deck, checked.deck.theme, ...checked.deck.slides, PROJECT_PATHS.themeCss, PROJECT_PATHS.gitignore]
}

export async function initializeProject(root: DirectoryHandle, document: DeckDocument): Promise<void> {
  const collisions: string[] = []
  for (const path of projectInitializationPaths(document)) if (await pathExists(root, path)) collisions.push(path)
  if (collisions.length) throwLocalized('directoryConflicts', collisions.join(getLocale() === 'zh' ? '、' : ', '))
  baselines.set(root, new Map())
  await writeProject(root, document)
}

export function themeCss(theme: Theme): string {
  return `:root {\n  --font-title: ${JSON.stringify(theme.fonts.title)};\n  --font-body: ${JSON.stringify(theme.fonts.body)};\n  --size-title: ${theme.fontSizes.title}px;\n  --size-body: ${theme.fontSizes.body}px;\n  --color-background: ${theme.colors.background};\n  --color-text: ${theme.colors.text};\n  --color-muted: ${theme.colors.muted};\n  --color-accent: ${theme.colors.accent};\n}\n\n.slide-title {\n  font-family: var(--font-title);\n  font-size: var(--size-title);\n  font-weight: 700;\n  line-height: 1.08;\n  color: var(--color-text);\n}\n`
}

export async function pickDirectory(): Promise<DirectoryHandle> {
  if (!('showDirectoryPicker' in window)) throwLocalized('directoryApiUnsupported')
  return window.showDirectoryPicker({ mode: 'readwrite' })
}

export async function verifyPermission(handle: DirectoryHandle, request = false): Promise<boolean> {
  const writable = handle as WritableDirectoryHandle
  const options = { mode: 'readwrite' } as const
  if (await writable.queryPermission(options) === 'granted') return true
  return request && await writable.requestPermission(options) === 'granted'
}

export interface RecoverySnapshot {
  savedAt: string
  projectFingerprint: string
  revision: number
  persistedRevision: number
  document: DeckDocument
}

export function projectFingerprint(document: DeckDocument, directory: DirectoryHandle | null = null): string {
  return `${directory?.name ?? 'demo'}:${document.deck.id}`
}

export async function snapshotToOpfs(snapshot: Omit<RecoverySnapshot, 'savedAt'>): Promise<void> {
  if (!navigator.storage?.getDirectory) return
  const root = await navigator.storage.getDirectory()
  const handle = await root.getFileHandle('plaindeck-recovery.json', { create: true })
  const writable = await handle.createWritable()
  await writable.write(canonicalJson({ ...snapshot, savedAt: new Date().toISOString() }))
  await writable.close()
}

export async function clearRecoveryFromOpfs(): Promise<void> {
  if (!navigator.storage?.getDirectory) return
  const root = await navigator.storage.getDirectory()
  try { await root.removeEntry('plaindeck-recovery.json') } catch (error) {
    if ((error as DOMException).name !== 'NotFoundError') throw error
  }
}

export async function restoreFromOpfs(expectedFingerprint?: string): Promise<RecoverySnapshot | null> {
  try {
    const root = await navigator.storage.getDirectory()
    const handle = await root.getFileHandle('plaindeck-recovery.json')
    const parsed = JSON.parse(await (await handle.getFile()).text()) as Partial<RecoverySnapshot>
    if (!parsed.savedAt || !parsed.projectFingerprint || typeof parsed.revision !== 'number' || typeof parsed.persistedRevision !== 'number') return null
    if (parsed.revision <= parsed.persistedRevision || expectedFingerprint && parsed.projectFingerprint !== expectedFingerprint) return null
    return { ...parsed, document: assertDocument(parsed.document) } as RecoverySnapshot
  } catch { return null }
}

declare global {
  interface Window { showDirectoryPicker(options?: { mode?: 'read' | 'readwrite' }): Promise<FileSystemDirectoryHandle> }
}
