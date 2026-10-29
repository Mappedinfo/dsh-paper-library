import type { DeckDocument } from 'plaindeck/core'
import { PLACEHOLDER_IMAGE_SRC } from '../../vendor/plaindeck/src/core/placeholder'
import { assertSafeSlideStyles } from '../slides-safety.mjs'

export function assertSafeStyles(document: DeckDocument): void {
  assertSafeSlideStyles(document)
}

export function assertSafeDocument(document: DeckDocument): void {
  assertSafeStyles(document)
  for (const slide of Object.values(document.slides)) for (const element of slide.elements) {
    if (element.type !== 'image') continue
    const src = element.src
    if (src === 'placeholder:image' || src === PLACEHOLDER_IMAGE_SRC || /^\.\/assets\/[a-f0-9]{64}\.(?:png|jpg|webp|gif)$/.test(src)) continue
    if (/^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]*={0,2}$/.test(src) && src.length <= 11_184_850) continue
    throw new Error('演示包含外部图片或不支持的图片格式，已停止打开。')
  }
}
