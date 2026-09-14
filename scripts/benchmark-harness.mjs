import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'

const project = dirname(dirname(fileURLToPath(import.meta.url)))
const harness = resolve(process.env.DSH_CHECKOUT ?? join(project, '../../deepseek-ai/deepseek-harness'))
const library = resolve(process.argv[2] ?? join(project, 'artifacts/capacity-2000-1000/library'))
const output = resolve(process.argv[3] ?? join(project, 'artifacts/harness-memory.json'))
const home = await mkdtemp(join(tmpdir(), 'paper-library-harness-memory-'))
const cli = join(harness, 'apps/cli/lib/bin.js')
const environment = { ...process.env, DSH_HOME: home, DSH_PAPER_LIBRARY_DIR: library }
const redact = text => text.replace(/token=[^\s&"']+/g, 'token=<redacted>')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const active = []
const measurements = []
const startedAt = performance.now()

function initialize(args) {
  const result = spawnSync(process.execPath, [cli, ...args], { cwd: project, env: environment, encoding: 'utf8', timeout: 40000 })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`Profile initialization failed: ${redact(result.stderr || result.stdout)}`)
}

async function launch(profile) {
  const child = spawn(process.execPath, [cli, '--profile', profile, '--port', '0', '--no-open'], { cwd: project, env: environment, stdio: ['ignore', 'pipe', 'pipe'] })
  active.push(child)
  let text = '', errors = '', deadline
  const ready = await new Promise((accept, reject) => {
    deadline = setTimeout(() => reject(new Error(`Profile ${profile} did not become ready within 40 seconds`)), 40000)
    child.stdout.on('data', chunk => {
      text = (text + chunk.toString()).slice(-4000)
      const match = text.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+)/)
      if (match) accept(match[1])
    })
    child.stderr.on('data', chunk => { errors = (errors + chunk.toString()).slice(-5000) })
    child.on('error', reject)
    child.once('exit', code => reject(new Error(`${profile} exited ${code}: ${redact(errors)}`)))
  }).finally(() => clearTimeout(deadline))
  const origin = new URL(ready).origin
  const exchange = await fetch(ready, { redirect: 'manual' })
  assert.equal(exchange.status, 303)
  const cookie = exchange.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
  assert.ok(cookie, 'Temporary host must return an authenticated browser cookie')
  const index = await fetch(`${origin}/`, { headers: { Cookie: cookie } })
  assert.equal(index.status, 200)
  await index.arrayBuffer()
  return {
    child, profile, origin,
    async call(request) {
      const response = await fetch(`${origin}/api/paper-library/api`, {
        method: 'POST',
        headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(95000),
      })
      assert.equal(response.status, 200, `HTTP request failed for ${request.action}`)
      const envelope = await response.json()
      if (!envelope.ok) throw new Error(`${request.action}: ${envelope.error}`)
      return envelope.result
    },
  }
}

function resident(pid) {
  const value = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'rss='], { encoding: 'utf8' }).trim()
  const kib = Number(value)
  if (!Number.isFinite(kib) || kib <= 0) throw new Error(`Cannot sample RSS for owned process ${pid}`)
  return Number((kib / 1024).toFixed(2))
}

function children(pid) {
  const found = spawnSync('/usr/bin/pgrep', ['-P', String(pid)], { encoding: 'utf8' })
  if (found.status === 1) return []
  if (found.error || found.status !== 0) throw found.error ?? new Error(`Cannot inspect children of owned process ${pid}: ${found.stderr}`)
  const result = []
  for (const childPid of found.stdout.trim().split(/\s+/).filter(Boolean).map(Number)) {
    let command
    try { command = execFileSync('/bin/ps', ['-p', String(childPid), '-o', 'comm='], { encoding: 'utf8' }).trim() }
    catch { continue } // A short-lived worker may exit between pgrep and ps.
    result.push({ pid: childPid, executable: command, descendants: children(childPid) })
  }
  return result
}

function sample(stage, baseline, plugin, details = {}) {
  const baselineRss = resident(baseline.child.pid)
  const pluginRss = resident(plugin.child.pid)
  const observation = {
    stage,
    elapsed_ms: Math.round(performance.now() - startedAt),
    baseline_host_rss_mib: baselineRss,
    plugin_host_rss_mib: pluginRss,
    observed_difference_mib: Number((pluginRss - baselineRss).toFixed(2)),
    baseline_children: children(baseline.child.pid),
    plugin_children: children(plugin.child.pid),
    ...details,
  }
  measurements.push(observation)
  console.log(JSON.stringify({ stage, baseline_host_rss_mib: baselineRss, plugin_host_rss_mib: pluginRss }))
}

async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return
  await new Promise(resolve => {
    const deadline = setTimeout(() => { child.kill('SIGKILL'); resolve() }, 4000)
    child.once('exit', () => { clearTimeout(deadline); resolve() })
    child.kill('SIGINT')
  })
}

try {
  initialize(['--profile', 'memory-baseline', '--from-default-profile', 'web', '--dump-config'])
  initialize(['--profile', 'memory-plugin', '--from-default-profile', 'web', '--dump-config'])
  initialize(['plugin', '--profile', 'memory-plugin', 'add', `link:${project}`, '--ignore-scripts', '--config.autoInstallPeers=false'])
  const baseline = await launch('memory-baseline')
  const plugin = await launch('memory-plugin')
  await sleep(1000)
  sample('ready_idle', baseline, plugin)
  const status = await plugin.call({ action: 'status' })
  assert.equal(status.library, library)
  assert.equal(status.count, 2000, 'Use the intended synthetic capacity fixture')
  const searchesStart = performance.now()
  for (let index = 0; index < 100; index++) await plugin.call({ action: 'list', query: 'urban', limit: 40, offset: (index * 40) % 2000 })
  sample('after_100_metadata_queries', baseline, plugin, { operations: 100, operation_elapsed_ms: Math.round(performance.now() - searchesStart) })
  const list = await plugin.call({ action: 'list', limit: 200 })
  const ids = list.items.filter(item => item.pdf).slice(0, 20).map(item => item.id)
  assert.equal(ids.length, 20)
  const rendersStart = performance.now()
  for (const id of ids) {
    const page = await plugin.call({ action: 'page', id, page: 1, scale: 1.25 })
    assert.ok(page.image && page.page === 1)
  }
  sample('after_20_document_renders', baseline, plugin, { operations: 20, scale: 1.25, operation_elapsed_ms: Math.round(performance.now() - rendersStart) })
  const citationStart = performance.now()
  const citation = await plugin.call({ action: 'cite', ids: ids.slice(0, 20), format: 'apa' })
  assert.ok(citation.text)
  sample('after_apa_20_records', baseline, plugin, { operations: 1, citation_records: 20, operation_elapsed_ms: Math.round(performance.now() - citationStart) })
  await sleep(5000)
  sample('settled_idle_5_seconds', baseline, plugin)
  const final = measurements.at(-1)
  assert.equal(final.plugin_children.length, 0, 'No PDF, Python or CSL worker should remain after work completes')
  const report = {
    generated_at: new Date().toISOString(),
    node: process.version,
    platform: process.platform,
    source: relative(project, library),
    synthetic_records: status.count,
    synthetic_pdfs: 1000,
    pages_per_pdf: 4,
    baseline: 'Isolated default web profile',
    plugin: 'Same default web profile plus Paper Library bundle; deployment library points to synthetic fixture',
    method: 'Concurrent separate Node hosts; ps RSS snapshots at matching milestones; no explicit GC, no browser, no model calls',
    measurements,
    resident_workers_after_idle: final.plugin_children,
    model_requests_made: 0,
    limits: [
      'RSS snapshots are not process peak RSS and do not measure short-lived worker peaks.',
      'Observed differences between separate processes are descriptive, not an exact causal plugin allocation; startup, V8 GC and OS memory scheduling vary.',
      'Baseline remains idle while the plugin host receives literature requests; the resulting difference includes workload allocations.',
      'Excludes browser, PDF/CSL worker peak RSS and unrelated existing Harness instances.',
      'Synthetic small text PDFs do not establish memory use for large scanned PDFs or the user actual library.',
    ],
  }
  await mkdir(dirname(output), { recursive: true })
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
  console.log(JSON.stringify({ ok: true, report: relative(project, output), resident_workers_after_idle: 0 }))
} finally {
  await Promise.allSettled(active.map(stop))
}
