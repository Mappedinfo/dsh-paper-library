const apiUrl = new URL('api', location.href)

export async function downloadPptx(id: string, document: unknown) {
  const response = await fetch(apiUrl, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'slides_export_pptx', id, document }),
  })
  if (!response.ok) {
    const data = await response.json()
    throw new Error(typeof data.error === 'string' ? data.error : `请求失败 (${response.status})`)
  }
  const encoded = response.headers.get('Content-Disposition')?.match(/filename\*=UTF-8''([^;]+)/)?.[1]
  return {
    blob: await response.blob(), filename: encoded ? decodeURIComponent(encoded) : 'presentation.pptx',
    warnings: response.headers.get('X-PlainDeck-Export-Warnings')?.split(',').filter(Boolean) ?? [],
  }
}

export async function api<T = any>(action: string, input: Record<string, unknown> = {}): Promise<T> {
  const response = await fetch(apiUrl, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, ...input }),
  })
  const data = await response.json()
  if (!response.ok || !data.ok) {
    const error = new Error(typeof data.error === 'string' ? data.error : data.error?.message || `请求失败 (${response.status})`)
    Object.assign(error, { code: data.code, current: data.current, status: response.status })
    throw error
  }
  return data.result as T
}

export function encode(bytes: Uint8Array): string {
  const chunks: string[] = []
  for (let index = 0; index < bytes.length; index += 0x8000) chunks.push(String.fromCharCode(...bytes.subarray(index, index + 0x8000)))
  return btoa(chunks.join(''))
}

export function decode(value: string): Uint8Array {
  const data = atob(value); const bytes = new Uint8Array(data.length)
  for (let index = 0; index < data.length; index++) bytes[index] = data.charCodeAt(index)
  return bytes
}
