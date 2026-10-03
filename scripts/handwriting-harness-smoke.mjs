/** Real, isolated Harness attachment admission + prepared vision stream.
 * A keyless deterministic adapter inspects the native attachment bytes; it
 * never contacts a provider or reads private user configuration/documents. */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { copyFile, mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { core } from '../src/bridge.mjs'

const project = dirname(dirname(fileURLToPath(import.meta.url)))
const harness = resolve(process.env.DSH_CHECKOUT ?? join(project, '../../deepseek-ai/deepseek-harness'))
const templateHome = resolve(process.env.DSH_TEST_HOME ?? join(project, '.local/paper-chat-test-home'))
const profile = process.env.DSH_TEST_PROFILE ?? 'paper-chat-test'
assert.ok(relative(join(project, '.local'), templateHome) && !relative(join(project, '.local'), templateHome).startsWith('..'), 'Use only an ignored synthetic profile')
assert.match(profile, /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/)
const run = join(templateHome, 'runs', `handwriting-${randomUUID()}`), home = join(run, 'home'), library = join(run, 'library')
const source = join(run, 'synthetic.pdf'), png = join(run, 'synthetic.png'), python = join(project, '.venv/bin/python')
const provider = 'paper-library-native-vision-fixture', model = 'deterministic-vision'
const checks = [], record = name => { checks.push(name); console.log(`PASS ${name}`) }
let child, logs = '', startupTimer, report
async function stopHost() {
  if (!child || child.exitCode !== null) return
  await new Promise(done => { const timer = setTimeout(() => child.kill('SIGKILL'), 3000); child.once('exit', () => { clearTimeout(timer); done() }); child.kill('SIGINT') })
}
try {
  const templateProfile = join(templateHome, 'profiles', profile), fixtureProfile = join(home, 'profiles', profile)
  await mkdir(fixtureProfile, { recursive: true })
  for (const file of ['package.json', 'cordis.yml', 'cordis.patch.yml']) await copyFile(join(templateProfile, file), join(fixtureProfile, file))
  await symlink(join(templateProfile, 'node_modules'), join(fixtureProfile, 'node_modules'), 'dir')
  await writeFile(join(run, 'cordis.patch.yml'), `- id: agent-default-model\n  config:\n    provider: ${provider}\n    model: ${model}\n- insert:\n    - id: ${provider}\n      name: ./fixture.mjs\n`)
  await writeFile(join(run, 'fixture.mjs'), `
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
export const name = '${provider}'
export const inject = ['llm', 'attachments', 'webServer', 'connection']
export function apply(ctx) {
  const observation = { generations: 0, attachments: [], prepared: 0 }
  class Adapter extends LlmAdapter {
    providerInfo() { return { id: '${provider}', name: 'Synthetic vision only' } }
    async listModels() { return [{ provider: '${provider}', id: '${model}', name: 'Synthetic vision only' }] }
    async resolveModel(provider, model) {
      assert.equal(provider, '${provider}'); assert.equal(model, '${model}'); observation.prepared++
      return { provider, id: model, name: 'Synthetic vision only', context: { contextWindow: 32768 }, inputModalities: ['text', 'image'] }
    }
    async *stream(options) {
      options.signal?.throwIfAborted(); observation.generations++
      const blocks = options.messages.flatMap(message => message.content), images = blocks.filter(block => block.type === 'image')
      assert.equal(images.length, 1); assert.equal(images[0].data, undefined)
      const ref = images[0].attachment; assert.equal(ref.mediaType, 'image/png'); assert.equal(ref.width, 640); assert.equal(ref.height, 360)
      const stored = await ctx.attachments.readImage(ref, options.signal)
      observation.attachments.push({ width: ref.width, height: ref.height, bytes: ref.bytes, sha256: createHash('sha256').update(stored.data).digest('hex'), durable: typeof ref.attachmentId === 'string', inlineBytes: false })
      observation.maxTokens = options.maxTokens
      const text = '需要核对这个假设'
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.effect(() => ctx.llm.registerAdapter(['${provider}'], new Adapter()), 'synthetic vision adapter')
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/api/handwriting-fixture', handler(req, res) {
    const rejection = ctx.connection.requestRejection(req)
    if (rejection !== undefined) { res.writeHead(rejection); res.end(); return }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(observation))
  } }), 'synthetic vision observations')
}
`)
  const generated = spawnSync(python, ['-c', `import pymupdf,sys
doc=pymupdf.open(); page=doc.new_page(width=640,height=360)
page.insert_text((48,80),'Synthetic handwritten note board',fontsize=18)
page.draw_line((60,120),(160,150),color=(0,0,0),width=3)
page.get_pixmap().save(sys.argv[2]); doc.save(sys.argv[1]); doc.close()`, source, png], { encoding: 'utf8' })
  assert.equal(generated.status, 0, generated.stderr)
  const hash = async path => createHash('sha256').update(await readFile(path)).digest('hex'), originalHash = await hash(source)
  const paper = (await core({ action: 'import', items: [{ id: 'SyntheticNativeHandwriting', title: 'Synthetic native handwriting', attachments: [{ path: source }] }] }, { library, python })).items[0]
  const parent = (await core({ action: 'annotate', id: paper.id, page: 1, type: 'highlight', rects: [[48,60,300,84]], text: 'Synthetic handwritten note board', comment: 'Keep this source note' }, { library, python })).annotation
  const originalNotes = await core({ action: 'annotations', id: paper.id }, { library, python })
  const env = Object.fromEntries(['PATH','HOME','SHELL','LANG','LC_ALL','TMPDIR'].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]))
  Object.assign(env, { DSH_HOME: home, DSH_PAPER_LIBRARY_DIR: library })
  child = spawn(process.execPath, [join(harness, 'apps/cli/lib/bin.js'), '--profile', profile, '--patch', join(run, 'cordis.patch.yml'), '--port', '0', '--no-open'], { cwd: run, env, stdio: ['ignore','pipe','pipe'] })
  const authenticatedUrl = await new Promise((accept, reject) => {
    startupTimer = setTimeout(() => reject(new Error('Isolated Harness startup exceeded 40 seconds')), 40000)
    child.stdout.on('data', bytes => { logs += bytes; const match = logs.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+)/); if (match) accept(match[1]) })
    child.stderr.on('data', bytes => { logs += bytes })
    child.on('error', reject); child.on('exit', code => reject(new Error(`Isolated Harness exited ${code}`)))
  })
  clearTimeout(startupTimer)
  const origin = new URL(authenticatedUrl).origin, exchange = await fetch(authenticatedUrl, { redirect: 'manual' })
  assert.equal(exchange.status, 303)
  const headers = { Cookie: exchange.headers.getSetCookie().map(value => value.split(';')[0]).join('; '), Origin: origin, 'Content-Type': 'application/json' }
  async function api(input) {
    const response = await fetch(`${origin}/api/paper-library/api`, { method: 'POST', headers, body: JSON.stringify(input), signal: AbortSignal.timeout(20000) })
    const value = await response.json(); assert.equal(response.status, 200, JSON.stringify(value)); assert.equal(value.ok, true, JSON.stringify(value)); return value.result
  }
  const observe = async () => { const result = await fetch(`${origin}/api/handwriting-fixture`, { headers }); assert.equal(result.status, 200); return result.json() }
  assert.equal((await fetch(`${origin}/api/handwriting-fixture`)).status, 401)
  const route = await api({ action: 'chat_ensure', id: paper.id }); assert.deepEqual(route.model, { provider, model })
  assert.equal((await observe()).generations, 0)
  record('native-authenticated-host-uses-keyless-paper-vision-route-with-no-startup-generation')
  const request = { action: 'handwriting_recognize', id: paper.id, annotation_id: parent.id, request_id: randomUUID(), image: (await readFile(png)).toString('base64'), provider: 'forged-route', model: 'forged-model' }
  const recognized = await api(request)
  assert.equal(recognized.status, 'complete'); assert.equal(recognized.text, '需要核对这个假设'); assert.equal(recognized.provider, provider); assert.equal(recognized.model, model); assert.equal(recognized.generated, true)
  const observation = await observe()
  assert.equal(observation.generations, 1); assert.ok(observation.prepared >= 1); assert.equal(observation.maxTokens, 8192)
  assert.deepEqual(observation.attachments, [{ width: 640, height: 360, bytes: (await readFile(png)).length, sha256: await hash(png), durable: true, inlineBytes: false }])
  record('real-attachment-admission-stores-validated-image-and-prepared-vision-stream-reads-identical-bytes')
  assert.equal((await api(request)).replayed, true); assert.equal((await observe()).generations, 1)
  record('same-request-replay-does-not-repeat-native-vision-generation')
  assert.deepEqual(await core({ action: 'annotations', id: paper.id }, { library, python }), originalNotes)
  assert.equal(await hash(source), originalHash)
  record('generated-recognition-does-not-change-native-source-annotation-or-original-pdf')
  report = { verified_at: new Date().toISOString(), ok: true, checks, deterministicModelGenerations: 1, externalModelRequestsMade: 0, imageDimensions: [640,360], privateDocumentsRead: false, limitations: ['Deterministic adapter validates native image delivery, not recognition quality', 'Physical Apple Pencil and Sidecar remain manual validation'] }
} catch (error) {
  report = { verified_at: new Date().toISOString(), ok: false, checks, error: error.message, externalModelRequestsMade: 0 }
  process.exitCode = 1; console.error(error)
} finally {
  clearTimeout(startupTimer); await stopHost()
  await mkdir(run, { recursive: true }); await writeFile(join(run, 'host.log'), logs.replace(/token=[^\s&]+/g, 'token=<redacted>'))
}
await writeFile(join(project, 'docs/validation/handwriting-harness.json'), JSON.stringify({ ...report, isolated_hosts_stopped: true }, null, 2) + '\n')
console.log(JSON.stringify({ ...report, run: relative(project, run) }))
