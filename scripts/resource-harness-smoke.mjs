/** Real DSH authentication, cold dataset model routing and disk recovery; synthetic data only. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { access, copyFile, mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const project = dirname(dirname(fileURLToPath(import.meta.url)))
const harness = resolve(process.env.DSH_CHECKOUT ?? join(project, '../../deepseek-ai/deepseek-harness'))
const templateHome = resolve(process.env.DSH_TEST_HOME ?? join(project, '.local/paper-chat-test-home'))
const profile = process.env.DSH_TEST_PROFILE ?? 'paper-chat-test'
assert.ok(relative(join(project, '.local'), templateHome) && !relative(join(project, '.local'), templateHome).startsWith('..'), 'Use an ignored synthetic profile')
assert.match(profile, /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/)
const run = join(templateHome, 'runs', `resources-${randomUUID()}`), home = join(run, 'home'), library = join(run, 'library')
const checks = [], provider = 'paper-library-native-chat-fixture', model = 'deterministic-reader'
let child, startupTimer, logs = '', report
const record = value => { checks.push(value); console.log(`PASS ${value}`) }
async function stopHost() {
  if (!child || child.exitCode !== null) return
  await new Promise(done => { const timer = setTimeout(() => child.kill('SIGKILL'), 3000); child.once('exit', () => { clearTimeout(timer); done() }); child.kill('SIGINT') })
}
async function startHost() {
  let output = ''
  const env = Object.fromEntries(['PATH', 'HOME', 'SHELL', 'LANG', 'LC_ALL', 'TMPDIR'].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]))
  Object.assign(env, { DSH_HOME: home, DSH_PAPER_LIBRARY_DIR: library })
  child = spawn(process.execPath, [join(harness, 'apps/cli/lib/bin.js'), '--profile', profile, '--patch', join(project, 'tests-js/fixtures/harness-chat/cordis.patch.yml'), '--port', '0', '--no-open'], { cwd: run, env, stdio: ['ignore', 'pipe', 'pipe'] })
  const authenticatedUrl = await new Promise((accept, reject) => {
    startupTimer = setTimeout(() => reject(new Error('Synthetic Harness did not start within 40 seconds')), 40000)
    child.stdout.on('data', bytes => { output = (output + bytes.toString()).slice(-24000); logs += bytes.toString(); const match = output.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+)/); if (match) accept(match[1]) })
    child.stderr.on('data', bytes => { logs += bytes.toString() })
    child.on('error', reject); child.on('exit', code => reject(new Error(`Synthetic Harness exited ${code}`)))
  })
  clearTimeout(startupTimer)
  const origin = new URL(authenticatedUrl).origin, exchange = await fetch(authenticatedUrl, { redirect: 'manual' })
  assert.equal(exchange.status, 303)
  const cookie = exchange.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
  const headers = { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' }
  return {
    origin,
    async api(input) {
      const response = await fetch(`${origin}/api/paper-library/api`, { method: 'POST', headers, body: JSON.stringify(input), signal: AbortSignal.timeout(25000) })
      const value = await response.json(); assert.equal(response.status, 200, JSON.stringify(value)); assert.equal(value.ok, true, JSON.stringify(value)); return value.result
    },
    async observe(id) { const url = new URL('/api/paper-chat-fixture', origin); url.searchParams.set('session', id); const response = await fetch(url, { headers }); assert.equal(response.status, 200); return response.json() },
  }
}
try {
  const templateProfile = join(templateHome, 'profiles', profile), fixtureProfile = join(home, 'profiles', profile)
  await access(join(templateProfile, 'package.json')); await mkdir(fixtureProfile, { recursive: true })
  for (const filename of ['package.json', 'cordis.yml', 'cordis.patch.yml']) await copyFile(join(templateProfile, filename), join(fixtureProfile, filename))
  await symlink(join(templateProfile, 'node_modules'), join(fixtureProfile, 'node_modules'), 'dir')
  let host = await startHost()
  const unauthorized = await fetch(`${host.origin}/api/paper-library/api`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'resource_list' }) })
  assert.equal(unauthorized.status, 401)
  const status = await host.api({ action: 'status' }); assert.equal(status.knowledge_generation, true); assert.equal(status.dataset_preview, true)
  record('dataset-and-knowledge-routes-use-actual-harness-authentication')
  const dataset = await host.api({ action: 'dataset_put', expected_revision: 0, metadata: { title: 'Synthetic mobility dataset', publisher: 'Synthetic Lab', citekey: 'syntheticMobility' } })
  const entity = { kind: 'dataset', id: dataset.id }
  const release = await host.api({ action: 'dataset_release_put', id: dataset.id, expected_revision: 0, metadata: { version: '1.0', citekey: 'syntheticMobilityV1' } })
  const source = await host.api({ action: 'knowledge_source_put', entity, kind: 'official-excerpt', text: 'This synthetic dataset contains twelve example trips.', url: 'https://example.org/synthetic-docs', title: 'Synthetic documentation', locator: { page: null } })
  const omitted = await host.api({ action: 'knowledge_source_put', entity, kind: 'user-text', text: 'Unselected synthetic sentinel NEVER SEND.', title: 'Unselected material' })
  const session = await host.api({ action: 'chat_ensure', id: dataset.id }); assert.deepEqual(session.model, { provider, model })
  const before = await host.observe(session.sessionId); assert.equal(before.generations, 0); assert.deepEqual(before.observations, [{ sessionLoaded: false, agentLoaded: false }])
  record('independent-dataset-prepares-native-cold-session-without-pdf-or-agent')
  const request = { action: 'knowledge_generate', entity, source_ids: [source.id], mode: 'note', request_id: 'synthetic-dataset-note-1', provider: 'forged-browser', model: 'forged-model' }
  const draft = await host.api(request); assert.equal(draft.status, 'needs-review'); assert.deepEqual(draft.model, { provider, model }); assert.match(draft.body, /twelve example trips/)
  const after = await host.observe(session.sessionId); assert.equal(after.generations, 1); assert.deepEqual(after.knowledge[0].sourceIds, [source.id]); assert.equal(after.knowledge[0].sourceTexts.includes(omitted.text), false)
  assert.equal(after.knowledge[0].maxTokens, 8192); assert.deepEqual(after.observations, [{ sessionLoaded: false, agentLoaded: false }])
  assert.equal((await host.api({ action: 'knowledge_note_list', entity })).total, 0)
  record('native-model-receives-only-explicit-snapshot-and-leaves-result-needing-user-review')
  const reviewed = await host.api({ action: 'knowledge_draft_review', id: draft.id, expected_revision: draft.revision, decision: 'accepted', reviewed_by: 'user' })
  assert.equal(reviewed.status, 'accepted')
  const note = await host.api({ action: 'knowledge_note_put', entity, title: reviewed.title, body: reviewed.body, source_ids: reviewed.source_ids, expected_revision: 0 })
  assert.equal((await host.api({ action: 'knowledge_note_get', id: note.id })).body, reviewed.body)
  const replay = await host.api(request); assert.equal(replay.id, draft.id); assert.equal(replay.replayed, true); assert.equal((await host.observe(session.sessionId)).generations, 1)
  record('explicit-review-and-markdown-save-are-separate-durable-steps-and-generation-replays-once')
  const releaseEntity = { kind: 'release', id: release.id }
  const releaseSource = await host.api({ action: 'knowledge_source_put', entity: releaseEntity, kind: 'official-excerpt', text: 'Synthetic version 1.0 covers a fixed twelve-trip sample.', url: 'https://example.org/synthetic-v1', title: 'Version documentation' })
  const releaseDraft = await host.api({ ...request, entity: releaseEntity, source_ids: [releaseSource.id], request_id: 'synthetic-release-note-2' })
  assert.equal(releaseDraft.entity.kind, 'release'); assert.equal(releaseDraft.status, 'needs-review'); assert.deepEqual(releaseDraft.model, session.model)
  record('release-native-sources-inherit-dataset-session-model-without-fabricating-a-paper')
  const graph = await host.api({...request,mode:'graph',request_id:'synthetic-dataset-graph-3'})
  assert.equal(graph.nodes.length,3); assert.equal(graph.edges[0].object,`dataset:${dataset.id}`); assert.equal(graph.assertions[0].status,'needs-review')
  await host.api({action:'knowledge_draft_review',id:graph.id,expected_revision:graph.revision,decision:'accepted',reviewed_by:'user'})
  const exported = await host.api({action:'knowledge_export',entity,format:'rkos-v3'})
  assert.ok(exported.losses.some(loss=>loss.code==='RKOS_DATASET_SOURCE_UNSUPPORTED'))
  assert.ok(exported.drafts.some(value=>value.id===graph.id))
  record('native-typed-graph-keeps-dataset-evidence-and-reports-RKOS-source-mapping-losses')
  await stopHost(); host = await startHost()
  assert.equal((await host.api({ action: 'dataset_get', id: dataset.id })).title, dataset.title)
  assert.equal((await host.api({ action: 'knowledge_note_get', id: note.id })).body, reviewed.body)
  assert.equal((await host.api({ action: 'knowledge_source_get', id: source.id })).content_hash, source.content_hash)
  const restored = await host.api(request); assert.equal(restored.id, draft.id); assert.equal(restored.replayed, true)
  assert.equal((await host.observe(session.sessionId)).generations, 0)
  record('fresh-harness-restart-recovers-entities-sources-notes-and-request-identity-with-zero-model-replay')
  report = { verified_at: new Date().toISOString(), ok: true, checks, deterministicModelGenerations: 3, replayGenerationsAfterHostRestart: 0, agentsStarted: 0, externalModelRequestsMade: 0, sourceData: 'Fresh synthetic metadata and two explicitly selected source snapshots; no private files', limitations: ['Model routing and persistence only; no provider-quality or real-library capacity claim'] }
} catch (error) { report = { verified_at: new Date().toISOString(), ok: false, checks, error: error.message, externalModelRequestsMade: 0 }; process.exitCode = 1; console.error(error) }
finally { clearTimeout(startupTimer); await stopHost(); await mkdir(run, { recursive: true }); await writeFile(join(run, 'host.log'), logs.replace(/token=[^\s&]+/g, 'token=<redacted>')) }
await writeFile(join(project, 'docs/validation/resource-harness.json'), JSON.stringify({ ...report, isolated_hosts_stopped: true }, null, 2) + '\n')
console.log(JSON.stringify({ ...report, run: relative(project, run) }))
