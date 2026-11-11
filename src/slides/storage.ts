import type { Theme } from 'plaindeck/core'
import { api, decode, encode } from './api'

/** The original components need an asset handle; it points only to this library project. */
export interface DirectoryHandle { id: string; name: string }
const urls = new WeakMap<DirectoryHandle, Map<string, string>>()
const allowed = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024

export async function readAsset(root: DirectoryHandle, path: string): Promise<Blob> {
  const result = await api<{ mime: string; content_base64: string }>('slides_asset_get', { id: root.id, path })
  if (!allowed.has(result.mime)) throw new Error('不支持的图片格式。')
  return new Blob([decode(result.content_base64)], { type: result.mime })
}
export function getCachedAssetUrl(root: DirectoryHandle, path: string): string | undefined {
  return urls.get(root)?.get(path)
}
export async function resolveAssetUrl(root: DirectoryHandle, path: string): Promise<string> {
  const existing = getCachedAssetUrl(root, path)
  if (existing) return existing
  const url = URL.createObjectURL(await readAsset(root, path))
  const cache = urls.get(root) ?? new Map<string, string>(); cache.set(path, url); urls.set(root, cache)
  return url
}
export function releaseAssets(root: DirectoryHandle | null | undefined): void {
  if (!root) return
  for (const url of urls.get(root)?.values() ?? []) URL.revokeObjectURL(url)
  urls.delete(root)
}
export async function writeImageAsset(root: DirectoryHandle, file: File): Promise<string> {
  if (!allowed.has(file.type)) throw new Error('仅支持 PNG、JPEG、WebP 和 GIF；SVG 暂不支持。')
  if (file.size > MAX_IMAGE_BYTES) throw new Error('图片超过 8 MiB。')
  const result = await api<{ path: string }>('slides_asset_put', { id: root.id, name: file.name, mime: file.type, content_base64: encode(new Uint8Array(await file.arrayBuffer())) })
  const cache = urls.get(root) ?? new Map<string, string>(); cache.set(result.path, URL.createObjectURL(file)); urls.set(root, cache)
  return result.path
}
export function themeCss(theme: Theme): string {
  return `:root {\n  --font-title: ${JSON.stringify(theme.fonts.title)};\n  --font-body: ${JSON.stringify(theme.fonts.body)};\n  --size-title: ${theme.fontSizes.title}px;\n  --size-body: ${theme.fontSizes.body}px;\n  --color-background: ${theme.colors.background};\n  --color-text: ${theme.colors.text};\n  --color-muted: ${theme.colors.muted};\n  --color-accent: ${theme.colors.accent};\n}\n`
}
