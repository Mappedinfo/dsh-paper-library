import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile, mkdir, copyFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAnnotationSnapshotStore, annotationSnapshotToken, parseAnnotationSnapshotToken, annotationSnapshotSourceCharacters, ANNOTATION_SNAPSHOT_MAX_BYTES } from '../src/harness/annotation-snapshots.mjs'

const version = 'a'.repeat(64)
function snapshot(overrides = {}) {
  return {
    paperId: 'paper-1', sessionId: 'paper-session-1',
    text: '**第 1 页 · 批注 note-1**\n\n> Source quote\n> Reader question', question: 'Explain this',
    annotation_refs: [{ id: 'note-1', version }],
    annotations: [{ id: 'note-1', version, page: 1, text: 'Source quote', comment: 'Reader question' }],
    coverage: { requested: 1, included: 1, total: 3, total_exact: true, all: false },
    ...overrides,
  }
}
const expected = { paperId: 'paper-1', sessionId: 'paper-session-1' }
async function fixture(t) {
  const library = await mkdtemp(join(tmpdir(), 'annotation-snapshots-'))
  t.after(() => rm(library, { recursive: true, force: true }))
  return { library, store: createAnnotationSnapshotStore({ library }) }
}

test('source snapshots survive restart, preserve exact text and deduplicate canonical content', async t => {
  const { library, store } = await fixture(t)
  const original = snapshot({ selection: { page: 1, text: 'Unsaved text selection' } })
  const saved = await store.save(original)
  assert.match(saved.id, /^[a-f0-9]{64}$/)
  assert.equal(saved.token, annotationSnapshotToken(original.paperId, saved.id))
  assert.deepEqual(parseAnnotationSnapshotToken(saved.token), { paperId: original.paperId, id: saved.id })
  const restarted = createAnnotationSnapshotStore({ library })
  assert.deepEqual(await restarted.load(saved.id, expected), original)
  const reordered = Object.fromEntries(Object.entries(original).reverse())
  assert.equal((await restarted.save(reordered)).id, saved.id)
  original.annotations[0].comment = 'Caller changed its mutable object'
  assert.equal((await restarted.load(saved.id, expected)).annotations[0].comment, 'Reader question')
  const directory = join(library, '.paper-library', 'snapshots')
  assert.deepEqual(await readdir(directory), [`${saved.id}.json`])
  assert.equal((await stat(directory)).mode & 0o777, 0o700)
  assert.equal((await stat(join(directory, `${saved.id}.json`))).mode & 0o777, 0o600)
})

test('snapshot identity binds paper, session and configured library and checks tampering', async t => {
  const { library, store } = await fixture(t)
  const saved = await store.save(snapshot())
  await assert.rejects(store.load(saved.id, { ...expected, paperId: 'another-paper' }), /不属于当前论文对话/)
  await assert.rejects(store.load(saved.id, { ...expected, sessionId: 'another-session' }), /不属于当前论文对话/)
  const path = join(library, '.paper-library', 'snapshots', `${saved.id}.json`)
  const other = await mkdtemp(join(tmpdir(), 'annotation-other-library-'))
  t.after(() => rm(other, { recursive: true, force: true }))
  const otherStore = createAnnotationSnapshotStore({ library: other })
  await otherStore.save(snapshot())
  await copyFile(path, join(other, '.paper-library', 'snapshots', `${saved.id}.json`))
  await assert.rejects(otherStore.load(saved.id, expected), /不属于当前文献库/)
  const record = JSON.parse(await readFile(path, 'utf8'))
  record.snapshot.text += ' changed'
  await writeFile(path, JSON.stringify(record))
  await assert.rejects(store.load(saved.id, expected), /校验失败/)
  await assert.rejects(store.save(snapshot()), /校验失败/)
})

test('request retries keep their immutable snapshot across restarts and reject conflicting reuse', async t => {
  const { library, store } = await fixture(t)
  assert.equal(await store.findRequest('request-1', expected), null)
  const first = await store.save(snapshot())
  const second = await store.save(snapshot({ question: 'A changed question' }))
  assert.equal(await store.bindRequest('request-1', first.id, expected), first.id)
  assert.equal(await createAnnotationSnapshotStore({ library }).findRequest('request-1', expected), first.id)
  assert.equal(await store.bindRequest('request-1', first.id, expected), first.id)
  await assert.rejects(store.bindRequest('request-1', second.id, expected), /另一份引用快照/)
  assert.equal(await store.findRequest('request-1', expected), first.id)
  assert.equal(await store.findRequest('request-1', { ...expected, sessionId: 'other-session' }), null)
  const directory = join(library, '.paper-library', 'requests')
  const files = await readdir(directory)
  assert.equal(files.length, 1)
  assert.equal((await stat(join(directory, files[0]))).mode & 0o777, 0o600)
  await writeFile(join(directory, files[0]), 'null')
  await assert.rejects(store.findRequest('request-1', expected), /请求记录校验失败/)
})

test('declared source counts must match complete Unicode source text', async t => {
  const { store } = await fixture(t)
  const value = snapshot({ annotations: [{ ...snapshot().annotations[0], text: '🌍中文', comment: '📄' }], selection: { page: 1, text: '🙂x' } })
  assert.equal(annotationSnapshotSourceCharacters(value), 6)
  value.coverage.characters = 6
  await store.save(value)
  value.coverage.characters = 1
  await assert.rejects(store.save(value), /字符数与完整来源不一致/)
})

test('concurrent saves and request bindings atomically converge', async t => {
  const { store } = await fixture(t)
  const results = await Promise.all(Array.from({ length: 5 }, () => store.save(snapshot())))
  assert.equal(new Set(results.map(value => value.id)).size, 1)
  const bindings = await Promise.all(Array.from({ length: 5 }, () => store.bindRequest('same-request', results[0].id, expected)))
  assert.equal(new Set(bindings).size, 1)
})

test('corrupt, oversized, missing and symlinked snapshot files fail explicitly', async t => {
  const { library, store } = await fixture(t)
  const saved = await store.save(snapshot())
  const path = join(library, '.paper-library', 'snapshots', `${saved.id}.json`)
  await writeFile(path, '{broken json}')
  await assert.rejects(store.load(saved.id, expected), /JSON 损坏/)
  await writeFile(path, ' '.repeat(ANNOTATION_SNAPSHOT_MAX_BYTES + 1))
  await assert.rejects(store.load(saved.id, expected), /大小预算/)
  await rm(path)
  await assert.rejects(store.load(saved.id, expected), /已丢失/)
  const external = join(library, 'external.json')
  await writeFile(external, '{}')
  await symlink(external, path)
  await assert.rejects(store.load(saved.id, expected), { code: 'ELOOP' })
})

test('tokens and snapshot inputs cannot select arbitrary paths or malformed references', async t => {
  const { store } = await fixture(t)
  assert.equal(parseAnnotationSnapshotToken('[[paper-library-ref:v1:../../secret:' + 'a'.repeat(64) + ']]'), undefined)
  await assert.rejects(store.load('../secret', expected), /标识无效/)
  await assert.rejects(store.save(snapshot({ paperId: '../secret' })), /标识.*无效/)
  await assert.rejects(store.save(snapshot({ annotation_refs: [{ id: 'note-1', version: 'bad' }] })), /无效或重复/)
  await assert.rejects(store.save(snapshot({ annotations: [] })), /完整批注/)
  await assert.rejects(store.save(snapshot({ annotations: [{ ...snapshot().annotations[0], version: 'b'.repeat(64) }] })), /身份不一致/)
  await assert.rejects(store.save(snapshot({ coverage: { ...snapshot().coverage, all: true } })), /覆盖范围/)
  await assert.rejects(store.save(snapshot({ text: 'x'.repeat(201 * 1024) })), /200 KiB/)
  await assert.rejects(store.save(snapshot({ selection: { page: 1, text: 'x'.repeat(8001) } })), /选文无效/)
})

test('an existing symlink cannot redirect the private snapshot directory', async t => {
  const { library, store } = await fixture(t)
  const external = join(library, 'outside')
  await mkdir(external)
  await symlink(external, join(library, '.paper-library'))
  await assert.rejects(store.save(snapshot()), /真实目录/)
  assert.deepEqual(await readdir(external), [])
})
