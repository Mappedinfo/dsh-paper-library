export async function waitForPrintResources(root: ParentNode = document): Promise<void> {
  // A slow or missing image must not keep the export dialog waiting indefinitely.
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      (async () => {
        await document.fonts?.ready
        await Promise.all([...root.querySelectorAll('img')].map(image => image.decode?.().catch(() => undefined)))
      })(),
      new Promise<void>(resolve => { timer = setTimeout(resolve, 8000) }),
    ])
  } finally { clearTimeout(timer) }
}
