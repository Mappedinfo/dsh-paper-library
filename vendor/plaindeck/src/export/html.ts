import type { DeckDocument } from 'plaindeck/core'
import { PROJECT_PATHS } from 'plaindeck/core'
import { renderHtml } from 'plaindeck/render'
import { saveBlob } from './download'
import { blobToDataUrl } from '../core/imageImport'
import { readAsset, type DirectoryHandle } from '../storage/browserStorage'

export async function embedLocalImages(document: DeckDocument, read: (path: string) => Promise<Blob>): Promise<DeckDocument> {
  const portable = structuredClone(document)
  for (const slide of Object.values(portable.slides)) for (const element of slide.elements) {
    if (element.type === 'image' && element.src.startsWith(PROJECT_PATHS.assetsDir)) element.src = await blobToDataUrl(await read(element.src))
  }
  return portable
}

export async function exportHtml(document: DeckDocument, directory?: DirectoryHandle | null): Promise<void> {
  const portable = directory ? await embedLocalImages(document, path => readAsset(directory, path)) : document
  saveBlob(new Blob([renderHtml(portable)], { type: 'text/html' }), `${document.deck.id}.html`)
}
