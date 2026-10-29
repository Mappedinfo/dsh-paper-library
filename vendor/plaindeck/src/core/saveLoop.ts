export interface SaveLoopOptions {
  hasPending(): boolean
  saveOnce(): Promise<void>
  onError(error: unknown): void
}

export function createSaveLoop(options: SaveLoopOptions) {
  let running: Promise<void> | null = null
  let requested = false

  const request = () => {
    requested = true
    if (running) return running
    running = (async () => {
      while (requested || options.hasPending()) {
        requested = false
        if (options.hasPending()) await options.saveOnce()
      }
    })().catch(options.onError).finally(() => { running = null })
    return running
  }

  return { request, isRunning: () => running !== null }
}
