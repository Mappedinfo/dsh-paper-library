/** Read-only installation/idle check. Credentials and private catalog data never enter the receipt. */
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'

const flags = new Map()
for (let i = 2; i < process.argv.length; i += 2) flags.set(process.argv[i], process.argv[i + 1])
const log = flags.get('--log'), port = Number(flags.get('--port'))
assert.ok(log && Number.isInteger(port) && port > 0 && port < 65536, 'Usage: --log PRIVATE_HOST_LOG --port PORT [--require-idle true] [--require-chat true] [--require-references true] [--output RECEIPT]')
const text = await readFile(log, 'utf8')
const candidates = [...text.matchAll(/https?:\/\/[^\s]+/g)].map(match => match[0])
const address = candidates.reverse().map(value => { try { return new URL(value) } catch { return null } }).find(url => url?.protocol === 'http:' && url.hostname === '127.0.0.1' && Number(url.port) === port && url.searchParams.has('token'))
assert.ok(address, 'No matching loopback startup address in host log')
const exchange = await fetch(address, { redirect: 'manual', signal: AbortSignal.timeout(10000) })
assert.equal(exchange.status, 303, 'Host authentication exchange failed')
const cookie = exchange.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
assert.ok(cookie, 'Host did not issue a session cookie')
const headers = { Cookie: cookie, Origin: address.origin, 'Content-Type': 'application/json' }
const listResponse = await fetch(`${address.origin}/api/session/list`, { method: 'POST', headers, body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: 'session/list', payload: { args: { _request: {} } } }), signal: AbortSignal.timeout(10000) })
assert.equal(listResponse.status, 200)
const listing = await listResponse.json()
assert.equal(listing.result?.ok, true, 'Native session list unavailable')
assert.ok(Array.isArray(listing.result.value.items))
const running = listing.result.value.items.filter(item => item.running).length
if (flags.get('--require-idle') === 'true') assert.equal(running, 0, 'Active native conversations must finish before restarting')
const response = await fetch(`${address.origin}/api/paper-library/api`, { method: 'POST', headers, body: JSON.stringify({ action: 'status' }), signal: AbortSignal.timeout(10000) })
assert.equal(response.status, 200)
const status = await response.json()
assert.equal(status.ok, true, 'Installed library status unavailable')
const conversationCapability = status.result.paper_conversations === true
const annotationReferences = status.result.annotation_references === true
const workbench = status.result.catalog_management === true && status.result.typed_graph === true
const readingWorkspace = status.result.reading_workspace === true
if (flags.get('--require-reader') === 'true') {
  assert.equal(readingWorkspace, true, 'Restarted host lacks the continuous reading workspace')
  for (const file of ['pdf-reader.js','pdf-reader.css','reading-panels.js','reading-panels.css','reading-shell.js','reading-shell.css']) {
    const asset = await fetch(`${address.origin}/api/paper-library/${file}`, {headers,signal:AbortSignal.timeout(10000)})
    assert.equal(asset.status,200,`Missing reading asset: ${file}`)
  }
}
if (flags.get('--require-workbench') === 'true') {
  assert.equal(workbench, true, 'Restarted host lacks the catalog and typed graph capabilities')
  for (const file of ['workbench.js','workbench.css','knowledge-graph.js','knowledge-graph.css']) {
    const asset = await fetch(`${address.origin}/api/paper-library/${file}`, {headers,signal:AbortSignal.timeout(10000)})
    assert.equal(asset.status,200,`Missing workbench asset: ${file}`)
  }
}
if (flags.get('--require-chat') === 'true') assert.equal(conversationCapability, true, 'Restarted host lacks the paper-conversation capability')
if (flags.get('--require-references') === 'true') assert.equal(annotationReferences, true, 'Restarted host lacks the immutable annotation reference capability')
const staticResponse = await fetch(`${address.origin}/api/paper-library/paper-chat.js`, { headers, signal: AbortSignal.timeout(10000) })
if (flags.get('--require-chat') === 'true' || flags.get('--require-references') === 'true') {
  assert.equal(staticResponse.status, 200)
  const script = await staticResponse.text()
  assert.ok(script.includes('PaperLibraryChat'))
  if (flags.get('--require-references') === 'true') assert.ok(script.includes('chat_catalog') && script.includes('annotation_refs'))
}
const report = { verified_at: new Date().toISOString(), ok: true, authenticatedHost: true, nativeConversationsIdle: running === 0, libraryAvailable: true, paperConversations: conversationCapability, annotationReferences, workbench, readingWorkspace, chatScriptAvailable: staticResponse.status === 200, modelRequestsMade: 0, privateDocumentsRead: false }
if (flags.get('--output')) await writeFile(flags.get('--output'), JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify(report))
