import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const project = dirname(dirname(fileURLToPath(import.meta.url)))
const harness = resolve(process.env.DSH_CHECKOUT ?? join(project, '../../deepseek-ai/deepseek-harness'))
const home = process.env.DSH_TEST_HOME ?? '/private/tmp/dsh-paper-library-harness-test'
const profile = process.env.DSH_TEST_PROFILE ?? 'paper-library-test'
const child = spawn(process.execPath, [join(harness, 'apps/cli/lib/bin.js'), '--profile', profile, '--port', '0', '--no-open'], {
  cwd: project,
  env: { ...process.env, DSH_HOME: home, DSH_PAPER_LIBRARY_DIR: join(home, 'library') },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let logs = ''
let errorLogs = ''
let timer
const started = new Promise((accept, reject) => {
  timer = setTimeout(() => reject(new Error('Harness did not announce readiness within 40 seconds')), 40000)
  child.stdout.on('data', bytes => {
    logs += bytes.toString()
    const match = logs.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+)/)
    if (match) accept(match[1])
  })
  child.stderr.on('data', bytes => { errorLogs = (errorLogs + bytes.toString()).slice(-8000) })
  child.on('error', reject)
  child.on('exit', code => reject(new Error(`Harness exited ${code}: ${errorLogs.replace(/token=[^\s&]+/g, 'token=<redacted>')}`)))
})

try {
  const authenticatedUrl = await started
  clearTimeout(timer)
  const origin = new URL(authenticatedUrl).origin
  const exchange = await fetch(authenticatedUrl, { redirect: 'manual' })
  assert.equal(exchange.status, 303)
  const cookie = exchange.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
  assert.ok(cookie)
  const authorized = { Cookie: cookie }
  const index = await fetch(`${origin}/`, { headers: authorized })
  assert.equal(index.status, 200)
  const html = await index.text()
  assert.ok(html.includes('@mappedinfo/dsh-paper-library'), 'Plugin must appear in the host-generated browser module graph')
  const ui = await fetch(`${origin}/api/paper-library/`, { headers: authorized })
  assert.equal(ui.status, 200)
  assert.ok((await ui.text()).includes('app.js'))
  const unauthenticated = await fetch(`${origin}/api/paper-library/`)
  assert.equal(unauthenticated.status, 401)
  const crossOrigin = await fetch(`${origin}/api/paper-library/api`, { method: 'POST', headers: { ...authorized, Origin: 'https://example.invalid', 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'status' }) })
  assert.equal(crossOrigin.status, 403)
  const models = await fetch(`${origin}/api/paper-library/api`, { method: 'POST', headers: { ...authorized, Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'models' }) })
  assert.equal(models.status, 200)
  const modelResult = await models.json()
  assert.equal(modelResult.ok, true)
  assert.ok(Array.isArray(modelResult.result.models))
  const status = await fetch(`${origin}/api/paper-library/api`, { method: 'POST', headers: { ...authorized, Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'status', library: '/do-not-use-browser-path' }) })
  assert.equal(status.status, 200)
  const statusResult = await status.json()
  assert.equal(statusResult.ok, true)
  assert.equal(statusResult.result.library, join(home, 'library'))
  console.log(JSON.stringify({ ok: true, checks: ['profile-plugin-load', 'browser-module-graph', 'authenticated-library-page', 'unauthenticated-refused', 'cross-origin-refused', 'model-directory', 'catalog-worker', 'browser-library-override-refused'], providerRequestsMade: 0 }))
} finally {
  clearTimeout(timer)
  child.kill('SIGINT')
  await new Promise(resolve => {
    const kill = setTimeout(() => { child.kill('SIGKILL'); resolve() }, 3000)
    child.once('exit', () => { clearTimeout(kill); resolve() })
  })
}
