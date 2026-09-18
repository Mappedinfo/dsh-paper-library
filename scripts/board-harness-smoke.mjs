/** Native whiteboard check: an isolated, real DSH host, a synthetic library and a
 * deterministic keyless model. It proves the parts a browser cannot:
 *  - the authenticated board surface works inside a real host,
 *  - the `library_board` tool is actually offered to the model,
 *  - a board token typed into the main composer expands at `agent/pre-step` into the
 *    frozen snapshot as a separate, verifiable plugin-source message,
 *  - a malformed token fails the turn instead of silently sending something else.
 * No model key, no network, no real profile: the child environment is whitelisted and
 * the run lives under the ignored project `.local` directory. */
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
const provider = 'paper-library-native-chat-fixture'
const model = 'deterministic-reader'
const reportPath = join(project, 'docs/validation/board-harness.json')
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
    const response = await fetch(`${origin}/api/${method}`, { method: 'POST', headers, body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload: { args: method === 'session/list' ? { _request: request } : { request } } }), signal: AbortSignal.timeout(10000) })
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.result?.ok, true, JSON.stringify(body))
    return body.result.value
  }

  assert.equal((await fetch(`${origin}/api/paper-library/api`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'board_list' }) })).status, 401)
  checks.push('unauthenticated-whiteboard-access-refused')

  // 1. The authenticated board surface works inside a real host.
  const created = await api({
    action: 'board_create',
    board: {
      title: '原生画板',
      nodes: [
        { id: 'n-1', kind: 'concept', x: 0, y: 0, w: 200, h: 100, text: '城市感知的技术路线' },
        { id: 'n-2', kind: 'paper', x: 300, y: 0, w: 260, h: 120, text: paper.title, paper: { id: paper.id, title: paper.title } },
      ],
      edges: [{ id: 'e-1', from: 'n-1', to: 'n-2', relation: 'explains' }],
    },
  })
  const boardId = created.board.id
  assert.equal(created.board.origin, 'user')
  const read = await api({ action: 'board_get', id: boardId })
  assert.equal(read.board.nodes.length, 2)
  assert.match(read.outline, /城市感知的技术路线/)
  assert.match(read.outline, new RegExp(paper.id))
  assert.equal((await api({ action: 'board_list' })).boards.length, 1)
  const frozen = await api({ action: 'board_snapshot', id: boardId })
  assert.equal(frozen.board_title, '原生画板')
  assert.match(frozen.text, /城市感知的技术路线/)
  const reopened = await api({ action: 'board_snapshot_get', snapshot_id: frozen.snapshot_id })
  assert.equal(reopened.text, frozen.text, 'the frozen outline survives a fresh read')
  checks.push('native-board-records-and-immutable-snapshot-round-trip')

  // A save from a real host run is revision-checked like every other plugin record.
  const saved = await api({ action: 'board_save', id: boardId, board: { ...read.board, title: '原生画板 v2' }, expected_revision: read.revision })
  assert.equal(saved.board.title, '原生画板 v2')
  assert.equal((await api({ action: 'board_get', id: boardId })).revision, saved.revision)
  const stale = await fetch(`${origin}/api/paper-library/api`, { method: 'POST', headers, body: JSON.stringify({ action: 'board_save', id: boardId, board: read.board, expected_revision: read.revision }) })
  assert.equal(stale.status, 409)
  checks.push('native-board-writes-are-revision-checked')

  // 2. A board reference typed into the main composer reaches the model as frozen material.
  const ensured = await api({ action: 'chat_ensure', id: second.id })
  assert.equal(ensured.model.provider, provider)
  assert.equal(ensured.model.model, model)
  const token = `[[paper-library-board:v1:${boardId}:${frozen.snapshot_id}]]`
  await rpc('session/prompt', { sessionId: ensured.sessionId, requestId: 'native-board-reference-1', mode: 'queue', content: [{ type: 'text', text: `请比较这张画板上的方向：\n${token}` }] })
  const deadline = Date.now() + 25000
  let observation, history
  do {
    history = await api({ action: 'chat_history', id: second.id })
    observation = await observe([ensured.sessionId])
    if (observation.boardReferences.length && !history.running) break
    await new Promise(resolveDelay => setTimeout(resolveDelay, 150))
  } while (Date.now() < deadline)
  assert.equal(history.running, false)
  assert.equal(history.outcome, 'completed')
  const reference = observation.boardReferences[0]
  assert.equal(reference.boardId, boardId)
  assert.equal(reference.snapshotId, frozen.snapshot_id)
  assert.equal(reference.text, frozen.text, 'the model receives the frozen outline, not the draft text')
  assert.match(reference.bodyHash, /^[a-f0-9]{64}$/)
  const userTurn = history.messages.find(message => message.role === 'user')
  assert.match(userTurn.text, /〔引用画板 原生画板〕/, 'the draft keeps a readable marker for the reference')
  assert.equal(userTurn.text.includes('[[paper-library-board:'), false, 'no raw token reaches the model')
  assert.ok(history.messages.some(message => message.role === 'assistant'))
  checks.push('native-composer-board-token-expands-to-frozen-material-for-the-model')

  // The compact model context is what the plugin promised: label plus material, once.
  assert.equal(observation.boardReferences.length, 1)
  assert.equal(observation.generations, 1)
  assert.ok(observation.tools.includes('library_board'), 'a real host offers the whiteboard tool to the model')
  assert.ok(observation.tools.includes('library_annotations'))
  checks.push('native-host-offers-the-library_board-tool-alongside-the-other-library-tools')

  // 3. A malformed token fails the turn instead of silently sending something else.
  await rpc('session/prompt', { sessionId: ensured.sessionId, requestId: 'native-board-reference-2', mode: 'queue', content: [{ type: 'text', text: `引用画板：损坏 [[paper-library-board:v1:${boardId}:${'a'.repeat(64)}]]` }] })
  const failureDeadline = Date.now() + 25000
  let failed = false
  do {
    history = await api({ action: 'chat_history', id: second.id })
    // The host rejects the turn at pre-step: no user message is committed for it.
    if (['error', 'failed'].includes(history.outcome)) { failed = true; break }
    if (!history.running && history.messages.filter(message => message.role === 'user').length > 1) break
    await new Promise(resolveDelay => setTimeout(resolveDelay, 150))
  } while (Date.now() < failureDeadline)
  const missing = await observe([ensured.sessionId])
  assert.equal(missing.boardReferences.length, 1, 'the missing snapshot never reaches the model as material')
  assert.equal(history.messages.filter(message => message.role === 'user').length, 1, 'the rejected turn commits no user message')
  assert.equal(failed, true, `a board reference that cannot be resolved must fail the turn (outcome=${history?.outcome})`)
  checks.push('unresolvable-board-reference-fails-the-turn-instead-of-sending-anything')

  // 4. Deleting the board tombstones the record but leaves the frozen material readable.
  const removed = await api({ action: 'board_delete', id: boardId, expected_revision: (await api({ action: 'board_get', id: boardId })).revision })
  assert.equal(removed.deleted, true)
  assert.equal((await api({ action: 'board_list' })).boards.length, 0)
  assert.equal((await api({ action: 'board_snapshot_get', snapshot_id: frozen.snapshot_id })).text, frozen.text)
  checks.push('deleting-a-board-keeps-an-already-frozen-reference-readable')
} finally {
  await stopHost()
}
await writeFile(reportPath, JSON.stringify({
  verified_at: new Date().toISOString(),
  scope: 'Isolated native DSH profile with a deterministic keyless model and a synthetic library; authenticated whiteboard records, immutable snapshot, revision-checked writes, tool exposure, composer-token expansion at agent/pre-step, an unresolvable reference failing the turn, and deletion preserving frozen material. No real profile, external model request or private document is involved.',
  checks, checks_count: checks.length, model_requests: 0, external_requests: 0,
}, null, 2) + '\n')
console.log(JSON.stringify({ run: relative(project, run), checks: checks.length }))
