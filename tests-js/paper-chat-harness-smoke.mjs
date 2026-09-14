import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { access, mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { core } from '../src/bridge.mjs'

const project = dirname(dirname(fileURLToPath(import.meta.url)))
const harness = resolve(process.env.DSH_CHECKOUT ?? join(project, '../../deepseek-ai/deepseek-harness'))
const home = resolve(process.env.DSH_TEST_HOME ?? join(project, '.local/paper-chat-test-home'))
const profile = process.env.DSH_TEST_PROFILE ?? 'paper-chat-test'
const homeRelative = relative(join(project, '.local'), home)
assert.ok(homeRelative && !homeRelative.startsWith('..') && !homeRelative.startsWith('/'), 'The smoke must use a dedicated home inside the ignored project .local directory')
assert.match(profile, /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/)
await access(join(home, 'profiles', profile, 'package.json'))
const run = join(home, 'runs', randomUUID())
const source = join(run, 'source')
const library = join(run, 'library')
const python = join(project, '.venv/bin/python')
const reply = 'Synthetic reading reply: the saved annotation is on PDF page 2. This fixture makes no scientific claim.'
const provider = 'paper-library-native-chat-fixture'
const model = 'deterministic-reader'
const reportPath = join(project, 'docs/validation/paper-chat-harness.json')
const checks = []
let child, startupTimer, hostLogs = '', errorLogs = ''

async function stopHost() {
  if (!child || child.exitCode !== null) return
  await new Promise(resolveStop => {
    const kill = setTimeout(() => { child.kill('SIGKILL') }, 3000)
    child.once('exit', () => { clearTimeout(kill); resolveStop() })
    child.kill('SIGINT')
  })
}

try {
  await mkdir(run, { recursive: true })
  const generated = spawnSync(python, ['scripts/create-demo.py', '--output', source], { cwd: project, encoding: 'utf8' })
  assert.equal(generated.status, 0, generated.stderr)
  const imported = await core({ action: 'import', path: join(source, 'zotero-export.json') }, { library, python })
  assert.ok(imported.items.length >= 2)
  const [paper, second] = imported.items
  const annotation = await core({ action: 'annotate', id: paper.id, page: 2, type: 'note', rects: [[30, 30, 50, 50]], comment: 'Synthetic page-two question: what evidence supports this interpretation?', author: 'Fixture reader' }, { library, python })
  const annotationId = annotation.annotation.id
  checks.push('fresh-synthetic-library-and-native-page-two-annotation')

  // Whitelist only runtime necessities; no model keys or provider configuration enter the child environment.
  const environment = Object.fromEntries(['PATH', 'HOME', 'SHELL', 'LANG', 'LC_ALL', 'TMPDIR'].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]))
  Object.assign(environment, { DSH_HOME: home, DSH_PAPER_LIBRARY_DIR: library })
  child = spawn(process.execPath, [join(harness, 'apps/cli/lib/bin.js'), '--profile', profile, '--patch', join(project, 'tests-js/fixtures/harness-chat/cordis.patch.yml'), '--port', '0', '--no-open'], { cwd: run, env: environment, stdio: ['ignore', 'pipe', 'pipe'] })
  const authenticatedUrl = await new Promise((accept, reject) => {
    startupTimer = setTimeout(() => reject(new Error('Harness did not announce readiness within 40 seconds')), 40000)
    child.stdout.on('data', bytes => {
      hostLogs = (hostLogs + bytes.toString()).slice(-24000)
      const match = hostLogs.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+)/)
      if (match) accept(match[1])
    })
    child.stderr.on('data', bytes => { errorLogs = (errorLogs + bytes.toString()).slice(-24000) })
    child.on('error', reject)
    child.on('exit', code => reject(new Error(`Fixture host exited with status ${code}`)))
  })
  clearTimeout(startupTimer)
  const origin = new URL(authenticatedUrl).origin
  const exchange = await fetch(authenticatedUrl, { redirect: 'manual' })
  assert.equal(exchange.status, 303)
  const cookie = exchange.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
  assert.ok(cookie)
  const headers = { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' }
  const api = async input => {
    const response = await fetch(`${origin}/api/paper-library/api`, { method: 'POST', headers, body: JSON.stringify(input), signal: AbortSignal.timeout(20000) })
    const body = await response.json()
    assert.equal(response.status, 200, JSON.stringify(body))
    assert.equal(body.ok, true, JSON.stringify(body))
    return body.result
  }
  const observe = async ids => {
    const url = new URL('/api/paper-chat-fixture', origin)
    for (const id of ids) url.searchParams.append('session', id)
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(5000) })
    assert.equal(response.status, 200)
    return response.json()
  }
  const rpc = async (method, request) => {
    const args = method === 'session/list' ? { _request: request } : { request }
    const response = await fetch(`${origin}/api/${method}`, { method: 'POST', headers, body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload: { args } }), signal: AbortSignal.timeout(10000) })
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.result?.ok, true, JSON.stringify(body))
    return body.result.value
  }

  const unauthenticated = await fetch(`${origin}/api/paper-library/api`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'chat_ensure', id: paper.id }) })
  assert.equal(unauthenticated.status, 401)
  assert.equal((await fetch(`${origin}/api/paper-chat-fixture`)).status, 401)
  checks.push('unauthenticated-chat-and-fixture-observation-refused')
  const ensured = await api({ action: 'chat_ensure', id: paper.id })
  assert.equal(ensured.created, true)
  assert.equal(ensured.model.provider, provider)
  assert.equal(ensured.model.model, model)
  const repeated = await api({ action: 'chat_ensure', id: paper.id })
  assert.equal(repeated.sessionId, ensured.sessionId)
  assert.equal(repeated.created, false)
  const other = await api({ action: 'chat_ensure', id: second.id })
  assert.notEqual(other.sessionId, ensured.sessionId)
  assert.equal(other.created, true)
  checks.push('same-paper-reuses-session-and-two-papers-remain-distinct')
  const cold = await observe([ensured.sessionId, other.sessionId])
  assert.deepEqual(cold.observations, [{ sessionLoaded: false, agentLoaded: false }, { sessionLoaded: false, agentLoaded: false }])
  assert.equal(cold.generations, 0)
  const nativeList = await rpc('session/list', {})
  for (const paperConversation of [ensured, other]) {
    const row = nativeList.items.find(row => row.sessionId === paperConversation.sessionId)
    assert.ok(row, 'Cold paper conversation is visible to the native session catalog')
    const cachedTitle = row.projections?.values?.title
    assert.equal(typeof cachedTitle === 'string' ? cachedTitle : cachedTitle?.title, paperConversation.title)
    assert.equal(row.blank, true, 'Creating a reading conversation must not invent a user turn')
  }
  checks.push('cold-sessions-native-visible-without-agent-or-model-generation')

  const catalog = await api({ action: 'chat_catalog', id: paper.id })
  const originalNote = catalog.annotations.find(note => note.id === annotationId)
  assert.equal(originalNote.status, 'new')
  const context = await api({ action: 'chat_context', id: paper.id, annotation_refs: [{ id: annotationId, version: originalNote.version }], question: 'Explain this saved page-two note.' })
  assert.deepEqual(context.annotation_ids, [annotationId])
  assert.match(context.text, /第 2 页 · 批注/)
  assert.equal(context.text.includes('SOURCE_DATA'), false)
  assert.match(context.text, /Synthetic page-two question/)
  checks.push('native-annotation-context-retains-real-page-and-identity')
  assert.ok(context.snapshot_id && context.draft_text.includes(context.reference.ref))
  assert.equal((await api({ action: 'chat_catalog', id: paper.id })).annotations.find(note => note.id === annotationId).status, 'new')
  await core({ action: 'annotation_update', id: paper.id, annotation_id: annotationId, comment: 'UPDATED synthetic question saved after snapshot preparation.' }, { library, python })
  const frozen = await api({ action: 'chat_reference', id: paper.id, snapshot_id: context.snapshot_id })
  assert.equal(frozen.text, context.text)
  assert.equal(frozen.text.includes('UPDATED'), false)
  checks.push('draft-preparation-does-not-mark-sent-and-later-pdf-edit-cannot-change-snapshot')
  const question = { action: 'chat_send', id: paper.id, snapshot_id: context.snapshot_id, request_id: 'native-reading-request-1' }
  const accepted = await api(question)
  assert.equal(accepted.accepted, true)
  const deadline = Date.now() + 20000
  let history, answer
  do {
    history = await api({ action: 'chat_history', id: paper.id })
    answer = history.messages.find(message => message.role === 'assistant' && message.text === reply)
    if (answer && !history.running) break
    await new Promise(resolveDelay => setTimeout(resolveDelay, 150))
  } while (Date.now() < deadline)
  assert.ok(answer, 'The native agent must commit an ordinary deterministic assistant reply')
  assert.equal(history.running, false)
  assert.equal(history.outcome, 'completed')
  assert.ok(history.messages.some(message => message.role === 'user' && message.text.includes('Synthetic page-two question')))
  assert.equal(answer.model.provider, provider)
  assert.equal(answer.model.model, model)
  const active = await observe([ensured.sessionId, other.sessionId])
  assert.deepEqual(active.observations, [{ sessionLoaded: true, agentLoaded: true }, { sessionLoaded: false, agentLoaded: false }])
  assert.equal(active.generations, 1)
  assert.ok(active.references.some(reference => reference.snapshotId === context.snapshot_id && reference.text.includes('Synthetic page-two question') && !reference.text.includes('UPDATED')))
  assert.equal(history.annotation_usage[annotationId], originalNote.version)
  assert.equal((await api({ action: 'chat_catalog', id: paper.id })).annotations.find(note => note.id === annotationId).status, 'updated')
  assert.ok(history.messages.some(message => message.references?.some(reference => reference.snapshot_id === context.snapshot_id)))
  checks.push('model-receives-exact-frozen-source-and-logged-usage-distinguishes-updated-version')
  checks.push('native-prompt-adopts-cold-session-and-commits-assistant-history')
  checks.push('reading-one-paper-does-not-activate-other-paper-agents')

  const retried = await api(question)
  assert.equal(retried.accepted, true)
  assert.equal(retried.requestId, accepted.requestId)
  history = await api({ action: 'chat_history', id: paper.id })
  assert.equal(history.messages.filter(message => message.role === 'user').length, 1)
  assert.equal(history.messages.filter(message => message.role === 'assistant').length, 1)
  assert.equal((await observe([ensured.sessionId])).generations, 1)
  checks.push('same-request-retry-does-not-duplicate-user-turn-or-generation')

  const saved = await api({ action: 'chat_save_feedback', id: paper.id, message_id: answer.id, text: 'This browser-supplied text must never replace the native reply.' })
  assert.equal(saved.saved.duplicate, false)
  const savedAgain = await api({ action: 'chat_save_feedback', id: paper.id, message_id: answer.id })
  assert.equal(savedAgain.saved.duplicate, true)
  assert.equal(savedAgain.saved.annotation_id, saved.saved.annotation_id)
  const annotations = await core({ action: 'annotations', id: paper.id }, { library, python })
  const feedback = annotations.annotations.filter(note => note.source_kind === 'dsh-conversation')
  assert.equal(feedback.length, 1)
  assert.equal(feedback[0].source_session_id, ensured.sessionId)
  assert.equal(feedback[0].source_message_id, answer.id)
  assert.ok(feedback[0].comment.includes(reply))
  assert.equal(feedback[0].comment.includes('browser-supplied'), false)
  checks.push('committed-assistant-reply-saves-to-native-pdf-with-provenance')
  checks.push('repeated-feedback-save-is-idempotent-and-browser-text-is-ignored')

  const current = (await api({ action: 'chat_catalog', id: paper.id })).annotations.find(note => note.id === annotationId)
  const mainReference = await api({ action: 'chat_context', id: paper.id, annotation_refs: [{ id: annotationId, version: current.version }], question: 'Discuss the updated note from the main conversation.' })
  // Native RPC models the main composer after reload: only durable plain text
  // tokens remain, and no plugin chat_send callback can advance the usage state.
  await rpc('session/prompt', { sessionId: ensured.sessionId, requestId: 'native-main-reference-2', mode: 'queue', content: [{ type: 'text', text: mainReference.draft_text }] })
  const mainDeadline = Date.now() + 20000
  do {
    history = await api({ action: 'chat_history', id: paper.id })
    if (history.annotation_usage[annotationId] === current.version && !history.running) break
    await new Promise(resolveDelay => setTimeout(resolveDelay, 150))
  } while (Date.now() < mainDeadline)
  assert.equal(history.annotation_usage[annotationId], current.version)
  assert.equal((await api({ action: 'chat_catalog', id: paper.id })).annotations.find(note => note.id === annotationId).status, 'sent')
  const mainObservation = await observe([ensured.sessionId])
  assert.equal(mainObservation.generations, 2)
  assert.ok(mainObservation.references.some(reference => reference.snapshotId === mainReference.snapshot_id && reference.text.includes('UPDATED')))
  checks.push('native-main-composer-plain-token-resolves-and-updates-sent-baseline-without-plugin-send')

  const report = { verified_at: new Date().toISOString(), ok: true, checks, deterministicModelGenerations: mainObservation.generations, externalModelRequestsMade: 0, sourceData: 'Fresh synthetic three-page PDFs generated per run', limitations: ['No paid model-quality evaluation', 'No real-library migration or memory benchmark', 'Browser interaction is validated separately'] }
  await mkdir(dirname(reportPath), { recursive: true })
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report))
} catch (error) {
  await mkdir(dirname(reportPath), { recursive: true })
  await writeFile(reportPath, JSON.stringify({ verified_at: new Date().toISOString(), ok: false, checks, error: 'Native paper-chat verification failed; inspect the private run log.', externalModelRequestsMade: 0 }, null, 2) + '\n')
  await mkdir(run, { recursive: true })
  const redacted = `${hostLogs}\n${errorLogs}`.replace(/token=[^\s&]+/g, 'token=<redacted>')
  await writeFile(join(run, 'host.log'), redacted)
  throw error
} finally {
  clearTimeout(startupTimer)
  await stopHost()
}
