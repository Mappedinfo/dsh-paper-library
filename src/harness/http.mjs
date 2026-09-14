import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

/** Adapt the authenticated Harness HTTP carrier to the shared streaming Fetch handler. */
export function createNodeHandler(connection, fetchHandler) {
  return async (req, res) => {
    const rejection = connection.requestRejection(req)
    if (rejection !== undefined) {
      res.writeHead(rejection, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(rejection === 401 ? 'unauthorized' : 'forbidden')
      return
    }
    const abort = new AbortController()
    const onAborted = () => abort.abort(new Error('Client disconnected'))
    const onClose = () => { if (!res.writableEnded) onAborted() }
    req.once('aborted', onAborted)
    res.once('close', onClose)
    try {
      const method = req.method ?? 'GET'
      const scheme = req.socket?.encrypted ? 'https' : 'http'
      const request = new Request(new URL(req.url ?? '/', `${scheme}://${req.headers.host}`), {
        method,
        headers: Object.fromEntries(Object.entries(req.headers).filter(([, value]) => value !== undefined).map(([key, value]) => [key, Array.isArray(value) ? value.join(', ') : value])),
        signal: abort.signal,
        ...(method === 'GET' || method === 'HEAD' ? {} : { body: Readable.toWeb(req), duplex: 'half' }),
      })
      const response = await fetchHandler(request)
      res.writeHead(response.status, Object.fromEntries(response.headers))
      if (method === 'HEAD' || response.body === null) res.end()
      else await pipeline(Readable.fromWeb(response.body), res, { signal: abort.signal })
    } catch (error) {
      if (!res.headersSent && !res.destroyed) {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }))
      } else if (!res.destroyed) res.destroy(error instanceof Error ? error : undefined)
    } finally {
      req.off('aborted', onAborted)
      res.off('close', onClose)
    }
  }
}
