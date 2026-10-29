import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { extname, isAbsolute, relative, resolve } from 'node:path'
import type { DeckDocument } from '../core/schema.js'

import { PlainDeckError } from '../core/errors.js'
const mimeTypes: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
}

export interface PrepareAssetsOptions {
  projectPath?: string
  allowNetwork?: boolean
}

export async function prepareDocumentAssets(input: DeckDocument, options: PrepareAssetsOptions = {}) {
  const document = structuredClone(input)
  const warnings: string[] = []
  const root = resolve(options.projectPath ?? '.')
  for (const path of document.deck.slides) {
    for (const element of document.slides[path].elements) {
      if (element.type !== 'image' || element.src === 'placeholder:image' || element.src.startsWith('data:')) continue
      if (/^https?:\/\//i.test(element.src)) {
        if (!options.allowNetwork) {
          warnings.push(`已阻止外部图片：${element.src}`)
          element.src = 'placeholder:image'
        }
        continue
      }
      try {
        if (isAbsolute(element.src)) throw new PlainDeckError('asset-absolute-path-forbidden', { zh: '不允许绝对资源路径', en: 'Absolute asset paths are not allowed' })
        const assetPath = resolve(root, element.src.replace(/^\.\//, ''))
        const inside = relative(root, assetPath)
        if (inside.startsWith('..') || isAbsolute(inside)) throw new PlainDeckError('asset-path-escapes-root', { zh: '资源路径越界', en: 'The asset path escapes the project root' })
        const mime = mimeTypes[extname(assetPath).toLowerCase()]
        if (!mime) throw new PlainDeckError('unsupported-image-format', { zh: '不支持的图片格式', en: 'Unsupported image format' })
        element.src = `data:${mime};base64,${(await readFile(assetPath)).toString('base64')}`
      } catch (error) {
        warnings.push(`${element.src}：${error instanceof Error ? error.message : String(error)}`)
        element.src = 'placeholder:image'
      }
    }
  }
  return { document, warnings }
}

/**
 * Check that every local image referenced by the deck exists under root.
 * External (http/https/file) and data: sources are skipped; missing or
 * out-of-bounds paths are reported without mutation.
 */
export function checkDeckAssets(input: DeckDocument, root?: string): { missing: Array<{ src: string; slide: string }> } {
  const base = resolve(root ?? '.')
  const missing: Array<{ src: string; slide: string }> = []
  for (const slidePath of input.deck.slides) {
    for (const element of input.slides[slidePath].elements) {
      if (element.type !== 'image' || element.src === 'placeholder:image') continue
      if (/^(data:|https?:|file:)/i.test(element.src)) continue
      const assetPath = resolve(base, element.src.replace(/^\.\//, ''))
      const inside = relative(base, assetPath)
      if (inside.startsWith('..') || isAbsolute(inside) || !existsSync(assetPath)) {
        missing.push({ src: element.src, slide: slidePath })
      }
    }
  }
  return { missing }
}
