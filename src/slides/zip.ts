import JSZip from 'jszip'
import { PROJECT_PATHS, SlideSchema, ThemeSchema, assertDocument, migrateDeck, type DeckDocument } from 'plaindeck/core'
import { PLACEHOLDER_IMAGE_SRC } from '../../vendor/plaindeck/src/core/placeholder'
import { assertSafeStyles } from './safety'

const MAX_INPUT = 8 * 1024 * 1024
const MAX_UNPACKED = 16 * 1024 * 1024
const MAX_FILE = 8 * 1024 * 1024
const MAX_FILES = 200
const mimeByExt: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' }
type Inflater = { on(event: string, handler: (...args: any[]) => void): Inflater; pause(): void; resume(): void }

/** Check the central directory before JSZip allocates one object per entry. */
function checkZipDirectory(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let end = -1
  for (let index = bytes.length - 22, lower = Math.max(0, bytes.length - 65557); index >= lower; index--) {
    if (view.getUint32(index, true) === 0x06054b50 && index + 22 + view.getUint16(index + 20, true) === bytes.length) { end = index; break }
  }
  if (end < 0) throw new Error('ZIP 目录无效。')
  const count = view.getUint16(end + 10, true), diskCount = view.getUint16(end + 8, true)
  const start = view.getUint32(end + 16, true), size = view.getUint32(end + 12, true)
  if (view.getUint16(end + 4, true) || view.getUint16(end + 6, true) || count !== diskCount || count === 0xffff || start === 0xffffffff || size === 0xffffffff || start + size !== end) throw new Error('不支持分卷或 ZIP64 格式。')
  if (count > MAX_FILES * 2) throw new Error('ZIP 条目数超过限制。')
  let cursor = start, files = 0, unpacked = 0
  const names = new Set<string>()
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > end || view.getUint32(cursor, true) !== 0x02014b50) throw new Error('ZIP 目录无效。')
    const nameLength = view.getUint16(cursor + 28, true), extraLength = view.getUint16(cursor + 30, true), commentLength = view.getUint16(cursor + 32, true)
    const next = cursor + 46 + nameLength + extraLength + commentLength
    if (!nameLength || next > end) throw new Error('ZIP 目录无效。')
    const name = Array.from(bytes.subarray(cursor + 46, cursor + 46 + nameLength)).join(',')
    if (names.has(name)) throw new Error('ZIP 含有重复或冲突的文件路径。')
    names.add(name)
    const size = view.getUint32(cursor + 24, true)
    if (size === 0xffffffff || size > MAX_FILE) throw new Error('ZIP 单个文件超过 8 MiB。')
    unpacked += size; if (unpacked > MAX_UNPACKED) throw new Error('ZIP 解压内容超过 16 MiB。')
    if (bytes[cursor + 46 + nameLength - 1] !== 0x2f && ++files > MAX_FILES) throw new Error('ZIP 文件数超过 200。')
    cursor = next
  }
  if (cursor !== end) throw new Error('ZIP 目录无效。')
  return files
}

/** Read incrementally and stop on the actual inflated-byte limit, not only ZIP metadata. */
async function boundedRead(entry: JSZip.JSZipObject, budget: { used: number }): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const parts: Uint8Array[] = []; let size = 0, finished = false
    const stream = (entry as unknown as { internalStream(type: 'uint8array'): Inflater }).internalStream('uint8array')
    stream.on('data', (chunk: Uint8Array) => {
      if (finished) return
      size += chunk.length; budget.used += chunk.length
      if (size > MAX_FILE || budget.used > MAX_UNPACKED) {
        finished = true; stream.pause(); reject(new Error('ZIP 解压内容超过大小限制。')); return
      }
      parts.push(chunk)
    })
    stream.on('error', (error: Error) => { if (!finished) { finished = true; reject(error) } })
    stream.on('end', () => {
      if (finished) return
      finished = true; const bytes = new Uint8Array(size); let index = 0
      for (const part of parts) { bytes.set(part, index); index += part.length }
      resolve(bytes)
    })
    stream.resume()
  })
}

export async function inspectZip(file: File): Promise<{ document: DeckDocument; assets: Map<string, { mime: string; bytes: Uint8Array }> }> {
  if (file.size > MAX_INPUT) throw new Error('ZIP 文件超过 8 MiB。')
  const bytes = new Uint8Array(await file.arrayBuffer())
  const expectedFiles = checkZipDirectory(bytes)
  const zip = await JSZip.loadAsync(bytes)
  const entries = Object.values(zip.files).filter(entry => !entry.dir)
  if (entries.length !== expectedFiles) throw new Error('ZIP 含有重复或冲突的文件路径。')
  if (entries.length > MAX_FILES) throw new Error('ZIP 文件数超过 200。')
  let declared = 0
  for (const entry of entries) {
    const original = (entry as any).unsafeOriginalName ?? entry.name
    if (original !== entry.name || original.startsWith('/') || original.includes('\\') || original.split('/').includes('..')) throw new Error('ZIP 包含不安全的文件路径。')
    declared += Number((entry as any)._data?.uncompressedSize ?? 0)
    if (declared > MAX_UNPACKED) throw new Error('ZIP 解压内容超过 16 MiB。')
  }
  const budget = { used: 0 }; const cache = new Map<string, Uint8Array>()
  const read = async (path: string) => {
    const name = path.replace(/^\.\//, '')
    if (cache.has(name)) return cache.get(name)!
    const entry = zip.file(name); if (!entry) throw new Error(`ZIP 缺少 ${name}。`)
    const bytes = await boundedRead(entry, budget); cache.set(name, bytes); return bytes
  }
  const json = async (path: string) => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await read(path)))
  const deck = migrateDeck(await json(PROJECT_PATHS.deck))
  if (deck.slides.length > 100) throw new Error('演示文稿超过 100 页。')
  const theme = ThemeSchema.parse(await json(deck.theme))
  const slides = Object.fromEntries(await Promise.all(deck.slides.map(async path => [path, SlideSchema.parse(await json(path))])))
  const document = assertDocument({ deck, theme, slides })
  assertSafeStyles(document)
  const assets = new Map<string, { mime: string; bytes: Uint8Array }>()
  for (const slide of Object.values(document.slides)) for (const element of slide.elements) {
    if (element.type !== 'image' || element.src === PLACEHOLDER_IMAGE_SRC || element.src === 'placeholder:image') continue
    const inline = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(element.src)
    if (inline) {
      if (!assets.has(element.src)) {
        let binary: string
        try { binary = atob(inline[2]) } catch { throw new Error('嵌入图片的编码无效。') }
        if (!binary.length || binary.length > MAX_FILE) throw new Error('嵌入图片超过 8 MiB。')
        const bytes = Uint8Array.from(binary, character => character.charCodeAt(0))
        assets.set(element.src, { mime: inline[1], bytes })
      }
      continue
    }
    if (!element.src.startsWith(PROJECT_PATHS.assetsDir)) throw new Error('ZIP 图片必须是包内 PNG、JPEG、WebP 或 GIF 文件。')
    const extension = element.src.split('.').pop()?.toLowerCase() ?? ''
    const mime = mimeByExt[extension]; if (!mime) throw new Error('ZIP 中的图片格式不支持；SVG 暂不支持。')
    if (!assets.has(element.src)) assets.set(element.src, { mime, bytes: await read(element.src) })
  }
  if (new TextEncoder().encode(JSON.stringify(document)).length > MAX_INPUT) throw new Error('演示文稿超过 8 MiB。')
  return { document, assets }
}
