import { createHash } from 'node:crypto'

const MAX_IMAGES = 2
const MAX_IMAGE_BYTES = 1024 * 1024
const MAX_IMAGE_BYTES_TOTAL = 2 * 1024 * 1024
const MAX_IMAGE_EDGE = 1600

function invalid() {
  const error = new Error('MODEL_INPUT_IMAGES_INVALID')
  error.code = 'MODEL_INPUT_IMAGES_INVALID'
  error.status = 413
  return error
}

function crc32(bytes, start, end) {
  let crc = 0xffffffff
  for (let i = start; i < end; i++) {
    crc ^= bytes[i]
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function pngDimensions(bytes) {
  const signature = [137,80,78,71,13,10,26,10]
  if (bytes.length < 45 || signature.some((byte, i) => bytes[i] !== byte)) return null
  let offset = 8, dimensions = null, sawData = false, sawEnd = false
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset), type = bytes.toString('ascii', offset + 4, offset + 8)
    const dataStart = offset + 8, crcOffset = dataStart + length
    if (length > MAX_IMAGE_BYTES || crcOffset + 4 > bytes.length) return null
    if (type === 'IHDR') {
      if (dimensions || offset !== 8 || length !== 13) return null
      dimensions = { width: bytes.readUInt32BE(dataStart), height: bytes.readUInt32BE(dataStart + 4) }
    }
    if (type === 'IDAT' && length > 0) sawData = true
    if (bytes.readUInt32BE(crcOffset) !== crc32(bytes, offset + 4, crcOffset)) return null
    offset = crcOffset + 4
    if (type === 'IEND') { if (length !== 0 || offset !== bytes.length) return null; sawEnd = true; break }
  }
  return sawEnd && sawData ? dimensions : null
}

function jpegDimensions(bytes) {
  if (bytes.length < 12 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) return null
  const sof = new Set([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf])
  let offset = 2, dimensions = null, sawScan = false
  while (offset + 1 < bytes.length - 2) {
    if (bytes[offset] !== 0xff) return null
    while (offset < bytes.length && bytes[offset] === 0xff) offset++
    if (offset >= bytes.length) return null
    const marker = bytes[offset++]
    if (marker === 0xd9) break
    if (marker === 0xda) { sawScan = true; break }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0xd8) continue
    if (offset + 2 > bytes.length) return null
    const length = bytes.readUInt16BE(offset)
    if (length < 2 || offset + length > bytes.length) return null
    if (sof.has(marker)) {
      if (length < 8 || dimensions) return null
      dimensions = { height: bytes.readUInt16BE(offset + 3), width: bytes.readUInt16BE(offset + 5) }
    }
    offset += length
    if (marker === 0xda) { sawScan = true; break }
  }
  return dimensions && sawScan ? dimensions : null
}

/** Validate image snapshots at the trust boundary without accessing paths, providers, or credentials. */
export function validateAnalysisImages(images) {
  if (images === undefined) return []
  if (!Array.isArray(images) || images.length > MAX_IMAGES) throw invalid()
  if (images.length === 0) return []
  if (new Set(images.map(image => image?.page)).size !== images.length) throw invalid()
  let total = 0
  return images.map(image => {
    if (!image || typeof image !== 'object' || Array.isArray(image) ||
        !['image/png','image/jpeg'].includes(image.mime_type) || typeof image.data !== 'string' ||
        !Number.isSafeInteger(image.page) || image.page < 1 || image.page > 2000 ||
        !Number.isSafeInteger(image.width) || !Number.isSafeInteger(image.height) ||
        image.width < 1 || image.height < 1 || image.width > MAX_IMAGE_EDGE || image.height > MAX_IMAGE_EDGE ||
        !/^[a-f0-9]{64}$/i.test(image.sha256 ?? '')) throw invalid()
    const maxEncoded = Math.ceil(MAX_IMAGE_BYTES / 3) * 4
    if (!image.data.length || image.data.length > maxEncoded || image.data.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(image.data)) throw invalid()
    const bytes = Buffer.from(image.data, 'base64')
    if (!bytes.length || bytes.length > MAX_IMAGE_BYTES || bytes.toString('base64') !== image.data || (total += bytes.length) > MAX_IMAGE_BYTES_TOTAL) throw invalid()
    const dimensions = image.mime_type === 'image/png' ? pngDimensions(bytes) : jpegDimensions(bytes)
    if (!dimensions || dimensions.width !== image.width || dimensions.height !== image.height || dimensions.width > MAX_IMAGE_EDGE || dimensions.height > MAX_IMAGE_EDGE) throw invalid()
    const digest = createHash('sha256').update(bytes).digest('hex')
    if (digest.toLowerCase() !== image.sha256.toLowerCase()) throw invalid()
    return { mime_type: image.mime_type, data: image.data, page: image.page, width: image.width, height: image.height, sha256: digest }
  })
}
