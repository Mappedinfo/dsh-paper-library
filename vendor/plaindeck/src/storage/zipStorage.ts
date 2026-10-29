import type JSZip from 'jszip'
import { saveBlob } from '../export/download'
import { blobToDataUrl } from '../core/imageImport'
import type { DeckDocument } from 'plaindeck/core'
import { GITIGNORE_TEMPLATE, PROJECT_PATHS, SlideSchema, ThemeSchema, assertDocument, canonicalJson, migrateDeck } from 'plaindeck/core'
import { throwLocalized } from '../i18n/errors'
import { readAsset, themeCss, type DirectoryHandle } from './browserStorage'

// jszip is loaded on demand so ZIP export/import stays out of the startup bundle.
const loadJSZip = async (): Promise<typeof JSZip> => (await import('jszip')).default

const imageMimeByExtension: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', svg: 'image/svg+xml' }

export async function importZip(file: File | Uint8Array): Promise<DeckDocument> {
  const JSZip = await loadJSZip()
  const zip = await JSZip.loadAsync(file)
  const read = async (path: string) => {
    const entry = zip.file(path.replace(/^\.\//, ''))
    if (!entry) throwLocalized('zipMissingEntry', path)
    return JSON.parse(await entry.async('text'))
  }
  const deck = migrateDeck(await read(PROJECT_PATHS.deck))
  const theme = ThemeSchema.parse(await read(deck.theme))
  const slides = Object.fromEntries(await Promise.all(deck.slides.map(async path => [path, SlideSchema.parse(await read(path))])))
  const document = assertDocument({ deck, theme, slides })
  for (const slide of Object.values(document.slides)) {
    for (const element of slide.elements) {
      if (element.type !== 'image' || !element.src.startsWith(PROJECT_PATHS.assetsDir)) continue
      const entry = zip.file(element.src.replace(/^\.\//, ''))
      if (!entry) throwLocalized('zipMissingAsset', element.src)
      const extension = element.src.split('.').pop()?.toLowerCase() ?? ''
      element.src = await blobToDataUrl(new Blob([await entry.async('uint8array')], { type: imageMimeByExtension[extension] ?? 'application/octet-stream' }))
    }
  }
  return document
}

export async function createProjectZip(document: DeckDocument, read?: (path: string) => Promise<Blob | Uint8Array>): Promise<JSZip> {
  const JSZip = await loadJSZip()
  const zip = new JSZip()
  zip.file(PROJECT_PATHS.deck, canonicalJson(document.deck))
  zip.file(document.deck.theme.replace(/^\.\//, ''), canonicalJson(document.theme))
  zip.file(PROJECT_PATHS.themeCss, themeCss(document.theme))
  for (const path of document.deck.slides) zip.file(path.replace(/^\.\//, ''), canonicalJson(document.slides[path]))
  if (read) {
    const assets = new Set(Object.values(document.slides).flatMap(slide => slide.elements.filter(element => element.type === 'image' && element.src.startsWith(PROJECT_PATHS.assetsDir)).map(element => element.type === 'image' ? element.src : '')))
    for (const path of assets) if (path) zip.file(path.replace(/^\.\//, ''), await read(path))
  }
  zip.folder(PROJECT_PATHS.assetsDir.replace(/^\.\//, '')); zip.folder(PROJECT_PATHS.exportsDir)
  zip.file(PROJECT_PATHS.gitignore, GITIGNORE_TEMPLATE)
  return zip
}

export async function exportZip(document: DeckDocument, directory?: DirectoryHandle | null): Promise<void> {
  const zip = await createProjectZip(document, directory ? path => readAsset(directory, path) : undefined)
  saveBlob(await zip.generateAsync({ type: 'blob' }), `${document.deck.id}.zip`)
}
