/** 原生平台最小回归：真实 CLI/worker 和本地状态；资料全部在临时目录。 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createLocalStateStore } from '../src/local-state.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const python = process.env.PAPER_LIBRARY_TEST_PYTHON || join(root, '.venv', process.platform === 'win32' ? 'Scripts' : 'bin', process.platform === 'win32' ? 'python.exe' : 'python')
assert.ok(existsSync(python), 'Run uv sync before this fixture, or set PAPER_LIBRARY_TEST_PYTHON.')
const base = await mkdtemp(join(tmpdir(), 'paper-platform-'))
const library = join(base, 'synthetic 文献 库'), home = join(base, 'synthetic state')
const checks = []
const record = text => { checks.push(text); console.log(`PASS ${text}`) }

function run(args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: root, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    const collect = target => chunk => { if (target === 'stdout') stdout += chunk; else stderr += chunk; if (stdout.length + stderr.length > 1024 * 1024) child.kill() }
    child.stdout.on('data', collect('stdout')); child.stderr.on('data', collect('stderr'))
    const timer = setTimeout(() => { child.kill(); reject(new Error('Synthetic process exceeded 30 seconds.')) }, 30000)
    child.on('error', error => { clearTimeout(timer); reject(error) })
    child.on('close', code => {
      clearTimeout(timer)
      if (code !== 0) return reject(new Error(`Synthetic process failed (${code}): ${stderr.slice(-1000)} ${stdout.slice(-1000)}`))
      try { resolve(JSON.parse(stdout)) } catch { reject(new Error(`Invalid synthetic JSON protocol: ${stdout.slice(-1000)}`)) }
    })
    child.stdin.end(input === undefined ? undefined : JSON.stringify(input))
  })
}

const cli = async input => {
  const response = await run(['src/cli.mjs', '--library', library, '--python', python], input)
  assert.equal(response.ok, true, response.error)
  return response.result
}

try {
  await mkdir(library)
  assert.equal((await cli({ action: 'list' })).total, 0)
  record('fresh CLI imports the Python worker and opens an empty native library')
  const title = '原生平台合成记录 🧪'
  const created = await cli({ action: 'create', metadata: { title, citekey: 'SyntheticPlatform2026' } })
  assert.equal(created.title, title)
  assert.equal((await cli({ action: 'get', id: created.id })).title, title)
  const revised = '合成更新 🧪'
  await cli({ action: 'update', id: created.id, metadata: { title: revised } })
  assert.equal((await cli({ action: 'get', id: created.id })).title, revised)
  assert.equal((await cli({ action: 'list', query: '合成更新' })).items[0].id, created.id)
  record('cold CLI processes preserve Unicode paths, metadata and updates')

  const options = { library, home }, store = createLocalStateStore(options)
  const missing = await store.get('reader:synthetic')
  assert.equal(missing.revision, 0)
  const first = await store.put(missing.key, { page: 2, draft: '保留草稿 🧪' }, 0)
  const second = await createLocalStateStore(options).put(first.key, { ...first.value, page: 3 }, first.revision)
  assert.notEqual(first.revision, second.revision)
  assert.deepEqual(await store.get(first.key), second)
  await assert.rejects(store.put(first.key, { draft: 'stale' }, first.revision), error => error.code === 'STATE_CONFLICT')
  assert.deepEqual((await store.get(first.key)).value, second.value)
  record('native state create, replace and stale CAS preserve the newer draft')

  const moduleURL = new URL('../src/local-state.mjs', import.meta.url).href
  const readCode = `import {createLocalStateStore} from ${JSON.stringify(moduleURL)}; console.log(JSON.stringify(await createLocalStateStore(JSON.parse(process.argv[1])).get('reader:synthetic')))`
  assert.deepEqual(await run(['--input-type=module', '-e', readCode, JSON.stringify(options)]), second)
  record('a new Node process recovers the exact saved state')

  const shared = await store.put('chat:shared', { draft: 'start' }, 0)
  const writeCode = `import {createLocalStateStore} from ${JSON.stringify(moduleURL)}; const [options,revision,draft]=JSON.parse(process.argv[1]); try { const saved=await createLocalStateStore(options).put('chat:shared',{draft},revision);console.log(JSON.stringify({ok:true,saved})); } catch(error) {console.log(JSON.stringify({ok:false,code:error.code}));}`
  const races = await Promise.all(['left', 'right'].map(draft => run(['--input-type=module', '-e', writeCode, JSON.stringify([options, shared.revision, draft])])))
  assert.equal(races.filter(result => result.ok).length, 1)
  assert.equal(races.filter(result => result.code === 'STATE_CONFLICT').length, 1)
  assert.deepEqual(await store.get(shared.key), races.find(result => result.ok).saved)
  await store.put('chat:second', { draft: 'another' }, 0)
  const page = await store.list({ prefix: 'chat:', limit: 1 })
  assert.equal(page.total, 2); assert.equal(page.records.length, 1); assert.equal(page.hasMore, true)
  record('independent native writers serialize CAS and state pagination remains usable')
  console.log(JSON.stringify({ ok: true, platform: process.platform, node: process.version, checks, model_calls: 0 }, null, 2))
} finally {
  await rm(base, { recursive: true, force: true })
}
