/** Synthetic-only capacity check for annotation selection and cold conversations.
 * Reproduce: node scripts/benchmark-annotation-references.mjs
 * Requires scripts/benchmark.py's capacity-2000-1000 fixture and the isolated
 * paper-chat-test Harness profile. Never points at or mutates a user library.
 */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { access, chmod, cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const project = dirname(dirname(fileURLToPath(import.meta.url)))
const fixture = join(project, 'artifacts/capacity-2000-1000')
const sourceLibrary = join(fixture, 'library')
const harness = resolve(process.env.DSH_CHECKOUT ?? join(project, '../../deepseek-ai/deepseek-harness'))
const home = join(project, '.local/paper-chat-test-home')
const profile = 'paper-chat-test'
const python = join(project, '.venv/bin/python')
const run = join(home, 'runs', `reference-memory-${randomUUID()}`)
const library = join(run, 'library')
const workerLog = join(run, 'workers.jsonl')
const workerExecutable = join(run, 'observed-worker')
const output = join(project, 'docs/validation/annotation-reference-memory.json')
const environment = Object.fromEntries(['PATH', 'HOME', 'SHELL', 'LANG', 'LC_ALL', 'TMPDIR'].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]))
const measurements = []
const hostSamples = []
let child, timer, sampleTimer, hostLogs = '', errorLogs = '', sampleError

const preparation = String.raw`
import hashlib, json, pathlib, sqlite3, sys
from dsh_paper_library.core import Library
mode, root = sys.argv[1], pathlib.Path(sys.argv[2]).resolve()
if mode == 'verify':
    connection = sqlite3.connect((root / 'catalog.sqlite3').as_uri() + '?mode=ro', uri=True)
    rows = connection.execute('SELECT id,citekey,title,metadata,pdf_path FROM papers ORDER BY citekey').fetchall()
    assert len(rows) == 2000, 'Expected exactly 2000 synthetic records'
    assert sum(row[4] is not None for row in rows) == 1000, 'Expected exactly 1000 attached PDFs'
    for index, row in enumerate(rows):
        assert row[1] == f'Capacity{index:04d}' and row[2] == f'Urban evidence and spatial comparison {index:04d}', 'Unexpected non-fixture metadata'
        assert 'synthetic' in json.loads(row[3]).get('tags', []), 'Missing synthetic marker'
        if row[4]:
            path = root / row[4]
            assert not path.is_symlink() and path.resolve().is_relative_to(root / 'pdfs') and path.is_file(), 'Invalid fixture PDF path'
    connection.close()
    fingerprint = hashlib.sha256()
    for path in [root / 'catalog.sqlite3', *sorted(root / row[4] for row in rows if row[4])]:
        fingerprint.update(str(path.relative_to(root)).encode('utf-8') + b'\0')
        with path.open('rb') as file:
            for chunk in iter(lambda:file.read(1024 * 1024), b''): fingerprint.update(chunk)
    print(json.dumps({'records':len(rows),'pdfs':sum(row[4] is not None for row in rows),'synthetic_marker_rows':len(rows),'catalog_pdf_sha256':fingerprint.hexdigest(),'paper_ids':[row[0] for row in rows if row[4]][:21]}))
else:
    library = Library(root)
    paper_id = sys.argv[3]
    assert not library.annotations(paper_id)['annotations'], 'The copied capacity PDF should initially contain no annotations'
    def seed(document):
        for index in range(45):
            library._add_annotation(document, 1 + index % 4, type='note', comment=f'Synthetic reference note {index:02d}: What observation supports this claim, and what should be checked against the original source?', author='Synthetic benchmark reader')
        return {}
    with library.lock():
        library._write_pdf(paper_id, seed)
    catalog = library.annotation_catalog(paper_id)
    assert catalog['total'] == 45 and not catalog['truncated']
    library.close()
    print(json.dumps({'annotations':catalog['total'],'source_characters':catalog['source_characters']}))
`

function pythonStep(mode, directory, paperId) {
  const result = spawnSync(python, ['-c', preparation, mode, directory, ...(paperId ? [paperId] : [])], {
    cwd: project, env: { ...environment, PYTHONPATH: join(project, 'src'), PYTHONDONTWRITEBYTECODE: '1' }, encoding: 'utf8', maxBuffer: 1024 * 1024,
  })
  assert.equal(result.status, 0, result.stderr || 'Synthetic fixture verification failed')
  return JSON.parse(result.stdout)
}

function rss() {
  const result = spawnSync('ps', ['-o', 'rss=', '-p', String(child.pid)], { encoding: 'utf8' })
  if (result.status !== 0 || !/^\s*\d+\s*$/.test(result.stdout)) throw new Error('Unable to sample isolated Harness RSS with ps; rerun with process inspection permission')
  return Math.round(Number(result.stdout.trim()) / 1024 * 100) / 100
}

function sample(stage) {
  const value = { stage, rss_mib: rss() }
  measurements.push(value)
  hostSamples.push(value.rss_mib)
}

async function stopHost() {
  if (!child || child.exitCode !== null) return
  await new Promise(resolveStop => {
    const kill = setTimeout(() => child.kill('SIGKILL'), 3000)
    child.once('exit', () => { clearTimeout(kill); resolveStop() })
    child.kill('SIGINT')
  })
}

const sleep = milliseconds => new Promise(accept => setTimeout(accept, milliseconds))
const readWorkers = async () => (await readFile(workerLog, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error })).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))

try {
  await access(join(home, 'profiles', profile, 'package.json'))
  const fixtureReceipt = JSON.parse(await readFile(join(fixture, 'report.json'), 'utf8'))
  assert.equal(fixtureReceipt.records, 2000)
  assert.equal(fixtureReceipt.pdfs, 1000)
  assert.ok(fixtureReceipt.limits.some(line => line.includes('Synthetic')))
  const verified = pythonStep('verify', sourceLibrary)
  await mkdir(run, { recursive: true, mode: 0o700 })
  await cp(sourceLibrary, library, { recursive: true, dereference: false, errorOnExist: true, force: false })
  assert.deepEqual(pythonStep('verify', library), verified)
  const seeded = pythonStep('seed', library, verified.paper_ids[0])

  // The observer adds only standard-library diagnostics around the identical
  // dispatch entry. Each process exits normally and reports its own real RSS
  // high-water, including response serialization. It records no source text.
  const observer = `#!${python}\n` + String.raw`
import json, os, resource, sys, time
from dsh_paper_library.core import Library, dispatch
opened = 0
original_open = Library._open_pdf
def observed_open(*args, **kwargs):
    global opened
    opened += 1
    return original_open(*args, **kwargs)
Library._open_pdf = staticmethod(observed_open)
started = time.perf_counter()
request = {}
try:
    raw = sys.stdin.buffer.read(40 * 1024 * 1024 + 1)
    if len(raw) > 40 * 1024 * 1024: raise ValueError('Request exceeds 40 MB')
    request = json.loads(raw)
    response = {'ok':True,'result':dispatch(request)}
except Exception as error:
    response = {'ok':False,'error':str(error),'error_type':type(error).__name__}
encoded = json.dumps(response, ensure_ascii=False, allow_nan=False)
sys.stdout.write(encoded + '\n')
sys.stdout.flush()
raw_rss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
record = {'action':request.get('action'),'pdf_opens':opened,'ok':response['ok'],'peak_rss_mib':round(raw_rss / (1024 * 1024 if sys.platform == 'darwin' else 1024),2),'elapsed_ms':round((time.perf_counter()-started)*1000,2)}
descriptor = os.open(os.environ['PAPER_LIBRARY_WORKER_OBSERVATIONS'], os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
try: os.write(descriptor, (json.dumps(record) + '\n').encode('utf-8'))
finally: os.close(descriptor)
`
  await writeFile(workerExecutable, observer, { mode: 0o700 })
  await chmod(workerExecutable, 0o700)
  Object.assign(environment, { DSH_HOME: home, DSH_PAPER_LIBRARY_DIR: library, DSH_PAPER_LIBRARY_PYTHON: workerExecutable, PAPER_LIBRARY_WORKER_OBSERVATIONS: workerLog })
  child = spawn(process.execPath, [join(harness, 'apps/cli/lib/bin.js'), '--profile', profile, '--patch', join(project, 'tests-js/fixtures/harness-chat/cordis.patch.yml'), '--port', '0', '--no-open'], { cwd: run, env: environment, stdio: ['ignore', 'pipe', 'pipe'] })
  const authenticatedUrl = await new Promise((accept, reject) => {
    timer = setTimeout(() => reject(new Error('Isolated Harness did not start within 40 seconds')), 40000)
    child.stdout.on('data', bytes => {
      hostLogs = (hostLogs + bytes.toString()).slice(-24000)
      const match = hostLogs.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+)/)
      if (match) accept(match[1])
    })
    child.stderr.on('data', bytes => { errorLogs = (errorLogs + bytes.toString()).slice(-24000) })
    child.on('error', reject)
    child.on('exit', code => reject(new Error(`Isolated Harness exited with status ${code}`)))
  })
  clearTimeout(timer)
  const origin = new URL(authenticatedUrl).origin
  const exchange = await fetch(authenticatedUrl, { redirect: 'manual' })
  assert.equal(exchange.status, 303)
  const cookie = exchange.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
  const headers = { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' }
  const api = async input => {
    const response = await fetch(`${origin}/api/paper-library/api`, { method: 'POST', headers, body: JSON.stringify(input), signal: AbortSignal.timeout(20000) })
    const body = await response.json()
    assert.equal(response.status, 200, JSON.stringify(body))
    assert.equal(body.ok, true, JSON.stringify(body))
    return body.result
  }
  await sleep(1500)
  sample('ready_after_authentication')
  sampleTimer = setInterval(() => { try { hostSamples.push(rss()) } catch (error) { sampleError ??= error } }, 200)
  await sleep(5000)
  sample('settled_before_paper_access_after_5_seconds')
  const currentId = verified.paper_ids[0]
  const catalog = await api({ action: 'chat_catalog', id: currentId })
  assert.equal(catalog.annotations.length, 45)
  assert.equal(catalog.total, 45)
  assert.equal(catalog.truncated, false)
  sample('after_45_note_catalog')
  const context = await api({ action: 'chat_context', id: currentId, annotation_refs: catalog.annotations.map(({ id, version }) => ({ id, version })), question: 'Synthetic benchmark question: compare the selected notes.' })
  assert.equal(context.coverage.included, 45)
  assert.equal(context.coverage.all, true)
  sample('after_exact_45_note_snapshot')
  const sessions = [catalog.sessionId]
  for (const id of verified.paper_ids.slice(1)) sessions.push((await api({ action: 'chat_ensure', id })).sessionId)
  sample('after_20_other_cold_paper_opens')
  const beforeHistory = (await readWorkers()).length
  for (let index = 0; index < 30; index++) {
    const history = await api({ action: 'chat_history', id: currentId })
    assert.equal(history.messages.length, 0)
    assert.equal(history.running, false)
  }
  const historyWorkers = (await readWorkers()).slice(beforeHistory)
  assert.equal(historyWorkers.length, 30)
  assert.equal(historyWorkers.reduce((sum, value) => sum + value.pdf_opens, 0), 0)
  sample('after_30_history_polls')
  const observations = []
  let generations = 0
  for (let index = 0; index < sessions.length; index += 12) {
    const url = new URL('/api/paper-chat-fixture', origin)
    for (const id of sessions.slice(index, index + 12)) url.searchParams.append('session', id)
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(5000) })
    assert.equal(response.status, 200)
    const body = await response.json()
    observations.push(...body.observations)
    generations = body.generations
  }
  assert.equal(generations, 0)
  assert.equal(observations.length, 21)
  assert.ok(observations.every(value => !value.agentLoaded && !value.sessionLoaded))
  await sleep(5000)
  sample('settled_idle_after_5_seconds')
  clearInterval(sampleTimer)
  if (sampleError) throw sampleError
  const descendants = spawnSync('pgrep', ['-P', String(child.pid)], { encoding: 'utf8' })
  assert.ok(descendants.status === 0 || descendants.status === 1, 'Unable to inspect isolated host children')
  const residentChildren = descendants.stdout.trim().split('\n').filter(Boolean)
  assert.deepEqual(residentChildren, [], 'No worker should remain resident after settling')
  const workers = await readWorkers()
  assert.ok(workers.every(value => value.ok))
  const workerCases = Object.fromEntries([...new Set(workers.map(value => value.action))].map(action => {
    const selected = workers.filter(value => value.action === action)
    return [action, { processes: selected.length, pdf_opens: selected.reduce((sum, value) => sum + value.pdf_opens, 0), peak_rss_mib: Math.max(...selected.map(value => value.peak_rss_mib)), elapsed_ms_total: Math.round(selected.reduce((sum, value) => sum + value.elapsed_ms, 0) * 100) / 100 }]
  }))
  const report = {
    verified_at: new Date().toISOString(), ok: true, node: process.version, platform: process.platform,
    source_fixture: 'artifacts/capacity-2000-1000/library', fixture_generator: 'scripts/benchmark.py',
    fixture_verified: { records: verified.records, pdfs: verified.pdfs, synthetic_marker_rows: verified.synthetic_marker_rows, catalog_pdf_sha256: verified.catalog_pdf_sha256, original_unchanged: true, pages_per_pdf: fixtureReceipt.pages_per_pdf, fixture_pdf_bytes: fixtureReceipt.fixture_pdf_bytes },
    private_run: relative(project, run), annotation_count: seeded.annotations, annotation_source_characters: seeded.source_characters,
    host: { measurement: 'ps RSS samples; each sample is current RSS, maximum is a sampled maximum, not a true high-water mark', sample_interval_ms: 200, sample_count: hostSamples.length, sampled_peak_rss_mib: Math.max(...hostSamples), measurements, settled_delta_from_ready_mib: Math.round((measurements.at(-1).rss_mib - measurements[0].rss_mib) * 100) / 100, settled_delta_from_prework_mib: Math.round((measurements.at(-1).rss_mib - measurements[1].rss_mib) * 100) / 100, explicit_gc: false },
    workers: { measurement: 'resource.getrusage(RUSAGE_SELF).ru_maxrss in one-request Python processes, including response JSON serialization; true per-process high-water', cases: workerCases, diagnostic_wrapper: 'Standard-library observation around the same core dispatch; logs action, elapsed time, PDF-open count and RSS, never source text' },
    workflow: { cold_paper_sessions: sessions.length, other_paper_opens: 20, history_polls: 30, history_worker_processes: historyWorkers.length, history_pdf_opens: 0, prework_settle_ms: 5000, idle_settle_ms: 5000, resident_worker_processes: 0, active_agents: 0, published_live_sessions: 0, deterministic_model_generations: generations, external_model_requests: 0, isolated_host_stopped: true },
    limitations: ['Browser and benchmark-driver RSS are excluded; this is the isolated Harness host plus separately reported workers.', 'Synthetic small four-page text PDFs do not represent scanned/image-heavy PDFs or a real user library.', 'Only one 45-note paper and 20 other cold paper opens were measured; long-lived activated agents and large sent histories were not exercised.', 'A sampled host maximum can miss sub-200-ms peaks; worker ru_maxrss is a real high-water but includes the small diagnostic wrapper.', 'Host startup and automatic garbage collection can dominate RSS deltas. Negative deltas are not feature memory savings; no host-without-plugin baseline was measured.', 'History polls still launch metadata-only short workers; zero PDF opens does not mean zero CPU or zero worker starts.', 'No model was invoked, and no formal usability or provider-quality validation is implied.'],
  }
  assert.deepEqual(pythonStep('verify', sourceLibrary), verified)
  await stopHost()
  await mkdir(dirname(output), { recursive: true })
  await writeFile(output, JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report, null, 2))
} catch (error) {
  await mkdir(run, { recursive: true, mode: 0o700 })
  await writeFile(join(run, 'host.log'), `${hostLogs}\n${errorLogs}`.replace(/token=[^\s&]+/g, 'token=<redacted>'), { mode: 0o600 })
  throw error
} finally {
  clearTimeout(timer)
  clearInterval(sampleTimer)
  await stopHost()
}
