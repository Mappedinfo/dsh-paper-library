import { useCallback, useEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { PROJECT_PATHS, type DeckDocument } from 'plaindeck/core'
import { PlainDeckSlide } from 'plaindeck/react'
import { waitForPrintResources } from '../export/print'
import { useEditor } from '../store'
import { getCachedAssetUrl, resolveAssetUrl } from '../storage/browserStorage'

type Snapshot = { document: DeckDocument; asset: (src: string) => string }

export function usePrintDeck(enabled = true) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const current = useRef<Snapshot | null>(null)
  const preparing = useRef(false)
  const root = useRef<HTMLDivElement>(null)
  const clear = useCallback(() => { current.current = null; setSnapshot(null) }, [])
  const mount = useCallback((value: Snapshot) => {
    current.current = value
    flushSync(() => setSnapshot(value))
  }, [])

  useEffect(() => {
    if (!enabled) return
    const before = () => {
      if (current.current) return
      // The browser's own menu cannot wait on async preparation. Reuse loaded assets.
      const { document, directory } = useEditor.getState()
      mount({ document, asset: src => directory ? getCachedAssetUrl(directory, src) ?? src : src })
    }
    window.addEventListener('beforeprint', before)
    window.addEventListener('afterprint', clear)
    return () => {
      window.removeEventListener('beforeprint', before)
      window.removeEventListener('afterprint', clear)
    }
  }, [enabled, mount, clear])

  const print = useCallback(async () => {
    if (preparing.current || current.current || !enabled) return
    preparing.current = true
    try {
      const { document, directory } = useEditor.getState()
      const urls = new Map<string, string>()
      if (directory) {
        const pending = [...new Set(document.deck.slides.flatMap(path => document.slides[path].elements.flatMap(
          element => element.type === 'image' && element.src.startsWith(PROJECT_PATHS.assetsDir) ? [element.src] : [],
        )))]
        await Promise.all(Array.from({ length: Math.min(6, pending.length) }, async () => {
          for (let src = pending.pop(); src !== undefined; src = pending.pop()) {
            try { urls.set(src, await resolveAssetUrl(directory, src)) } catch { /* retain fallback for a missing asset */ }
          }
        }))
      }
      mount({ document, asset: src => urls.get(src) ?? src })
      if (root.current) await waitForPrintResources(root.current)
      window.print()
    } catch (error) {
      clear()
      throw error
    } finally { preparing.current = false }
  }, [enabled, mount, clear])

  const printDeck = snapshot && <div ref={root} className="print-deck" aria-hidden="true">
    <style media="print">{`@page { size: ${snapshot.document.deck.canvas.width}px ${snapshot.document.deck.canvas.height}px; margin: 0; }`}</style>
    {snapshot.document.deck.slides.map(slidePath => <div className="print-page" key={slidePath} style={snapshot.document.deck.canvas}>
      <PlainDeckSlide document={snapshot.document} slidePath={slidePath} resolveAsset={snapshot.asset} className="print-surface" style={{ overflow: 'hidden' }} />
    </div>)}
  </div>
  return { print, printDeck }
}
