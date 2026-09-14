/** Actual built Harness route/durability smoke with a keyless synthetic adapter. */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { access, copyFile, mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { core } from '../src/bridge.mjs'

const project = dirname(dirname(fileURLToPath(import.meta.url)))
const harness = resolve(process.env.DSH_CHECKOUT ?? join(project, '../../deepseek-ai/deepseek-harness'))
const templateHome = resolve(process.env.DSH_TEST_HOME ?? join(project, '.local/paper-chat-test-home'))
const profile = process.env.DSH_TEST_PROFILE ?? 'paper-chat-test'
assert.ok(relative(join(project, '.local'), templateHome) && !relative(join(project, '.local'), templateHome).startsWith('..'), 'Only an ignored synthetic profile may be used')
assert.match(profile, /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/)
const run = join(templateHome, 'runs', `language-${randomUUID()}`), home = join(run, 'home'), source = join(run, 'source'), library = join(run, 'library')
const python = join(project, '.venv/bin/python'), reportPath = join(project, 'docs/validation/language-harness.json')
const checks = [], provider = 'paper-library-native-chat-fixture', model = 'deterministic-reader'
let child, logs = '', startupTimer, phase = 0, report
const record = value => { checks.push(value); console.log(`PASS ${value}`) }
async function stopHost() {
  if (!child || child.exitCode !== null) return
  await new Promise(resolveStop => { const timer = setTimeout(() => child.kill('SIGKILL'), 3000); child.once('exit', () => { clearTimeout(timer); resolveStop() }); child.kill('SIGINT') })
}
async function startHost() {
  phase++; let output = ''
  const env = Object.fromEntries(['PATH', 'HOME', 'SHELL', 'LANG', 'LC_ALL', 'TMPDIR'].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]))
  Object.assign(env, { DSH_HOME: home, DSH_PAPER_LIBRARY_DIR: library })
  child = spawn(process.execPath, [join(harness, 'apps/cli/lib/bin.js'), '--profile', profile, '--patch', join(project, 'tests-js/fixtures/harness-chat/cordis.patch.yml'), '--port', '0', '--no-open'], { cwd: run, env, stdio: ['ignore', 'pipe', 'pipe'] })
  const authenticatedUrl = await new Promise((accept, reject) => {
    startupTimer = setTimeout(() => reject(new Error('Synthetic Harness did not start within 40 seconds')), 40000)
    child.stdout.on('data', bytes => { output = (output + bytes.toString()).slice(-24000); logs += bytes.toString(); const match = output.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+)/); if (match) accept(match[1]) })
    child.stderr.on('data', bytes => { logs += bytes.toString() })
    child.on('error', reject); child.on('exit', code => reject(new Error(`Synthetic Harness phase ${phase} exited ${code}`)))
  })
  clearTimeout(startupTimer)
  const origin = new URL(authenticatedUrl).origin, exchange = await fetch(authenticatedUrl, { redirect: 'manual' })
  assert.equal(exchange.status, 303)
  const cookie = exchange.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
  const headers = { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' }
  return {
    origin,
    async api(input) {
      const response = await fetch(`${origin}/api/paper-library/api`, { method: 'POST', headers, body: JSON.stringify(input), signal: AbortSignal.timeout(20000) })
      const value = await response.json(); assert.equal(response.status, 200, JSON.stringify(value)); assert.equal(value.ok, true, JSON.stringify(value)); return value.result
    },
    async observe(sessionId) {
      const url = new URL('/api/paper-chat-fixture', origin); url.searchParams.set('session', sessionId)
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(5000) }); assert.equal(response.status, 200); return response.json()
    },
  }
}
try {
  const templateProfile = join(templateHome, 'profiles', profile), fixtureProfile = join(home, 'profiles', profile)
  await access(join(templateProfile, 'package.json')); await mkdir(fixtureProfile, { recursive: true })
  for (const filename of ['package.json', 'cordis.yml', 'cordis.patch.yml']) await copyFile(join(templateProfile, filename), join(fixtureProfile, filename))
  await symlink(join(templateProfile, 'node_modules'), join(fixtureProfile, 'node_modules'), 'dir')
  const generated = spawnSync(python, ['scripts/create-demo.py', '--output', source], { cwd: project, encoding: 'utf8' }); assert.equal(generated.status, 0, generated.stderr)
  const manifest = JSON.parse(await readFile(join(source, 'zotero-export.json'), 'utf8'))
  const originalPaths = (manifest.items ?? manifest).flatMap(item => (item.attachments ?? []).map(attachment => attachment.path).filter(Boolean))
  const hash = async path => createHash('sha256').update(await readFile(path)).digest('hex')
  const hashes = await Promise.all(originalPaths.map(hash))
  const [paper] = (await core({ action: 'import', path: join(source, 'zotero-export.json') }, { library, python })).items
  let host = await startHost()
  assert.equal((await fetch(`${host.origin}/api/paper-library/api`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'language_history', id: paper.id }) })).status, 401)
  assert.equal((await host.api({ action: 'status' })).language_learning, true)
  const ensured = await host.api({ action: 'chat_ensure', id: paper.id })
  assert.deepEqual(ensured.model, { provider, model })
  assert.equal((await host.observe(ensured.sessionId)).generations, 0)
  record('authenticated-language-service-uses-configured-cold-paper-session')
  const request = { action: 'language_generate', id: paper.id, mode: 'translate', text: 'Epistemic uncertainty remains in this estimate.', page: 2, request_id: 'native-language-translate-1', provider: 'forged-browser-route', model: 'forged-browser-model' }
  const translated = await host.api(request)
  assert.equal(translated.status, 'complete'); assert.deepEqual(translated.model, ensured.model)
  assert.equal(translated.result, '合成翻译：该估计仍存在认识不确定性。')
  const polished = await host.api({ ...request, mode: 'polish', request_id: 'native-language-polish-2' })
  assert.equal(polished.status, 'complete'); assert.equal(polished.result, request.text); assert.equal(polished.target_language, 'source')
  const after = await host.observe(ensured.sessionId)
  assert.equal(after.generations, 2); assert.deepEqual(after.observations, [{ sessionLoaded: false, agentLoaded: false }])
  assert.deepEqual(after.language.map(entry => entry.maxTokens), [8192, 8192]); assert.deepEqual(after.language.map(entry => entry.mode), ['translate', 'polish'])
  record('two-language-operations-use-authoritative-model-and-8192-token-budget-without-starting-agents')
  assert.equal((await host.api(request)).replayed, true)
  assert.equal((await host.api({ action: 'language_history', id: paper.id })).items.length, 2)
  const words = await host.api({ action: 'vocabulary_list', query: 'epistemic' })
  assert.equal(words.total, 1); assert.equal(words.items[0].encounters_retained, 2)
  assert.equal((await host.observe(ensured.sessionId)).generations, 2)
  record('history-vocabulary-and-same-request-replay-make-no-additional-model-calls')
  const word = words.items[0]
  await host.api({ action: 'vocabulary_update', id: word.id, expected_revision: word.revision, status: 'mastered', meaning: 'Synthetic user-reviewed meaning' })
  const exported = await host.api({ action: 'vocabulary_export', format: 'json', status: 'mastered' })
  assert.equal(JSON.parse(exported.content).vocabulary[0].meaning_source, 'user')
  record('word-encounters-retain-paper-page-model-provenance-and-user-review-state')
  await stopHost(); host = await startHost()
  const restored = await host.api({ action: 'language_history', id: paper.id })
  assert.equal(restored.items.length, 2); assert.ok(restored.items.some(item => item.id === translated.id && item.request_id === request.request_id))
  const replay = await host.api(request); assert.equal(replay.id, translated.id); assert.equal(replay.replayed, true)
  const mastered = await host.api({ action: 'vocabulary_list', status: 'mastered' })
  assert.equal(mastered.items[0].meaning, 'Synthetic user-reviewed meaning'); assert.equal(mastered.items[0].encounters_retained, 2)
  const restarted = await host.observe(ensured.sessionId)
  assert.equal(restarted.generations, 0); assert.deepEqual(restarted.observations, [{ sessionLoaded: false, agentLoaded: false }])
  record('fresh-host-restart-recovers-results-vocabulary-and-request-identity-with-zero-replay-generations')
  assert.deepEqual(await Promise.all(originalPaths.map(hash)), hashes)
  record('synthetic-original-pdfs-remain-byte-identical')
  report = { verified_at: new Date().toISOString(), ok: true, checks, deterministicModelGenerations: 2, replayGenerationsAfterHostRestart: 0, languageOutputTokenBudget: 8192, externalModelRequestsMade: 0, agentsStarted: 0, sourceData: 'Fresh synthetic PDFs and test-only selected sentence', limitations: ['Model routing and durability only; no real provider quality evaluation', 'Browser language interaction is validated separately'] }
} catch (error) {
  report = { verified_at: new Date().toISOString(), ok: false, checks, error: error.message, externalModelRequestsMade: 0 }
  process.exitCode = 1; console.error(error)
} finally {
  clearTimeout(startupTimer); await stopHost()
  await mkdir(run, { recursive: true }); await writeFile(join(run, 'host.log'), logs.replace(/token=[^\s&]+/g, 'token=<redacted>'))
}
await writeFile(reportPath, JSON.stringify({ ...report, isolated_hosts_stopped: true }, null, 2) + '\n')
console.log(JSON.stringify({ ...report, run: relative(project, run) }))
