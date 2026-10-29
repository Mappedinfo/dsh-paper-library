import type { Frame } from 'plaindeck/core'
import { throwLocalized } from '../i18n/errors'

export const MAX_IMAGE_BYTES = 25 * 1024 * 1024
export const SUPPORTED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/svg+xml']

export function validateImageFile(file: File) {
  if (!SUPPORTED_IMAGE_TYPES.includes(file.type)) throwLocalized('unsupportedImageFormat', file.type || file.name)
  if (file.size > MAX_IMAGE_BYTES) throwLocalized('imageTooLarge', MAX_IMAGE_BYTES / 1024 / 1024, file.name)
}

export function fitImageFrame(
  image: { width: number; height: number },
  canvas: { width: number; height: number },
  point?: { x: number; y: number },
): Frame {
  const sourceWidth = Math.max(1, image.width); const sourceHeight = Math.max(1, image.height)
  const scale = Math.min(1, 720 / sourceWidth, 520 / sourceHeight, canvas.width / sourceWidth, canvas.height / sourceHeight)
  const width = Math.max(1, Math.round(sourceWidth * scale))
  const height = Math.max(1, Math.round(sourceHeight * scale))
  const center = point ?? { x: canvas.width / 2, y: canvas.height / 2 }
  return {
    x: Math.round(Math.max(0, Math.min(canvas.width - width, center.x - width / 2))),
    y: Math.round(Math.max(0, Math.min(canvas.height - height, center.y - height / 2))),
    w: width,
    h: height,
  }
}

export async function imageDimensions(file: File): Promise<{ width: number; height: number }> {
  if ('createImageBitmap' in globalThis) {
    try {
      const bitmap = await createImageBitmap(file); const size = { width: bitmap.width, height: bitmap.height }; bitmap.close(); return size
    } catch { /* SVG and some clipboard formats need the image-element fallback. */ }
  }
  const url = URL.createObjectURL(file)
  try {
    return await new Promise((resolve, reject) => {
      const image = new Image()
      image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight })
      image.onerror = () => reject(throwLocalized('unreadableImageSize', file.name))
      image.src = url
    })
  } finally { URL.revokeObjectURL(url) }
}

export async function blobToDataUrl(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer()); const chunks: string[] = []
  for (let index = 0; index < bytes.length; index += 0x8000) chunks.push(String.fromCharCode(...bytes.subarray(index, index + 0x8000)))
  return `data:${blob.type || 'application/octet-stream'};base64,${btoa(chunks.join(''))}`
}

export function imageFiles(items: FileList | File[]) {
  return Array.from(items).filter(file => SUPPORTED_IMAGE_TYPES.includes(file.type))
}

export function transferredImageFiles(transfer: DataTransfer) {
  const files = imageFiles(transfer.files)
  if (files.length) return files
  return Array.from(transfer.items).filter(item => item.kind === 'file' && SUPPORTED_IMAGE_TYPES.includes(item.type)).map(item => item.getAsFile()).filter((file): file is File => Boolean(file))
}

export function hasTransferredImages(transfer: DataTransfer) {
  return transferredImageFiles(transfer).length > 0 || Array.from(transfer.types).includes('Files')
}
