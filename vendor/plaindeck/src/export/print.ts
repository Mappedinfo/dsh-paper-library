export async function waitForPrintResources(root: ParentNode = document): Promise<void> {
  await document.fonts?.ready
  const images = [...root.querySelectorAll('img')]
  await Promise.all(images.map(async image => {
    if (!image.complete) await new Promise<void>(resolve => {
      image.addEventListener('load', () => resolve(), { once: true })
      image.addEventListener('error', () => resolve(), { once: true })
    })
    try { await image.decode() } catch { /* print the available fallback instead of hanging */ }
  }))
}
