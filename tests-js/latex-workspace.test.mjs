/**
 * The LaTeX workspace folder and its place in the sync service's config.
 *
 * Everything runs against real temporary folders and a real worker: the plugin's own
 * folder is created (or rejected), the project is registered through the normal
 * action, and the sync config is only ever extended — never rewritten.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dispatch } from '../src/bridge.mjs'
import { resolveConfig } from '../src/harness/config.mjs'
import { createLatexWorkspace, projectSlug, syncSourceEntry, coveringSource } from '../src/harness/latex-workspace.mjs'

const project = dirname(dirname(fileURLToPath(import.meta.url)))
const python = existsSync(join(project, '.venv', 'bin', 'python')) ? join(project, '.venv', 'bin', 'python') : undefined

const memorySettings = value => ({ get: async () => ({ value, revision: 1 }) })

async function fixture({ settings = {}, sync = true } = {}) {
  const base = await mkdtemp(join(tmpdir(), 'latex-ws-'))
  const library = join(base, 'library')
  const root = join(base, 'manuscripts')
  const syncPath = join(base, 'vault-sync', 'config.json')
  const preferences = { latex_starter: true, latex_auto_compile: true, latex_split: 50, latex_sync_folder: true, sync_config: syncPath, ...settings }
  if (sync) {
    await mkdir(dirname(syncPath), { recursive: true })
    await writeFile(syncPath, `${JSON.stringify({
      version: 1,
      stateDir: join(base, 'vault-sync'),
      remote: { type: 'filesystem', engine: 'auto', root: join(base, 'mirror') },
      sources: [
        { id: 'paper-library', kind: 'paper-library', root: library, remote: 'paper-library', include: [], exclude: [] },
        { id: 'obsidian-vault', kind: 'directory', root: join(base, 'vault'), remote: 'obsidian-vault', include: [], exclude: [] },
      ],
    }, null, 2)}\n`, 'utf8')
  }
  const config = resolveConfig({ library, latexRoot: root })
  const workspace = createLatexWorkspace({ config, dispatch, settings: memorySettings(preferences), library, python })
  return { base, library, root, syncPath, preferences, config, call: (input, options) => workspace(input, options) }
}

test('the status action reports the folder, the sync coverage and the live settings', async () => {
  const f = await fixture()
  const status = await f.call({ action: 'latex_ws_status' })
  assert.equal(status.root, f.root)
  assert.equal(status.root_exists, false)
  assert.equal(status.sync.config_path, f.syncPath)
  assert.equal(status.sync.configured, true)
  assert.equal(status.sync.covered, false)
  assert.equal(status.sync.coverable, true)
  assert.deepEqual(status.settings, { starter: true, auto_compile: true, split: 50, sync_folder: true })

  const configured = { ...f.preferences, latex_starter: false, latex_auto_compile: false, latex_split: 35, latex_sync_folder: false }
  const folded = createLatexWorkspace({ config: f.config, dispatch, settings: memorySettings(configured), library: f.library, python })
  assert.deepEqual((await folded({ action: 'latex_ws_status' })).settings, { starter: false, auto_compile: false, split: 35, sync_folder: false })

  const missing = await fixture({ sync: false })
  const bare = await missing.call({ action: 'latex_ws_status' })
  assert.equal(bare.sync.configured, false)
  assert.match(bare.sync.reason, /尚未初始化/)
})

test('creating a project makes the folder, writes the starter and registers it', async () => {
  const f = await fixture()
  const created = await f.call({ action: 'latex_ws_create', name: '邻域效应 论文' })
  assert.equal(created.dir, join(f.root, '邻域效应-论文'))
  assert.equal(created.starter_written, true)
  assert.equal(created.project.title, '邻域效应-论文')
  assert.equal(created.project.main_path, 'main.tex')
  const body = await readFile(join(created.dir, 'main.tex'), 'utf8')
  assert.match(body, /\\documentclass/)
  assert.equal((await readFile(join(created.dir, 'main.tex'), 'utf8')).length > 100, true)
  // The folder is registered in the catalog through the normal worker action.
  const listed = await dispatch({ action: 'latex_project_list', limit: 10 }, { library: f.library, python })
  assert.deepEqual(listed.projects.map(item => item.id), [created.project.id])

  // …and the sync config gained exactly one source, with a backup.
  const config = JSON.parse(await readFile(f.syncPath, 'utf8'))
  assert.deepEqual(config.sources.at(-1), syncSourceEntry(f.root))
  const backups = (await readdir(dirname(f.syncPath))).filter(name => name.startsWith('config.json.bak-'))
  assert.equal(backups.length, 1)

  const again = await f.call({ action: 'latex_ws_create', name: '邻域效应 论文' })
  assert.equal(again.project.id, created.project.id)
  assert.equal(again.sync.changed, false, 'an already covered folder must not be added twice')
  assert.equal(JSON.parse(await readFile(f.syncPath, 'utf8')).sources.length, config.sources.length)
})

test('a second project reuses the folder and the existing sync source', async () => {
  const f = await fixture()
  const first = await f.call({ action: 'latex_ws_create', name: 'first' })
  const second = await f.call({ action: 'latex_ws_create', name: 'second' })
  assert.notEqual(second.project.id, first.project.id)
  assert.equal(second.sync.changed, false)
  assert.equal(second.sync.covered, true)
  assert.equal(JSON.parse(await readFile(f.syncPath, 'utf8')).sources.filter(source => source.id.startsWith('paper-library-latex')).length, 1)
  assert.equal((await f.call({ action: 'latex_ws_status' })).sync.covering_source, 'paper-library-latex')
})

test('an empty folder without the starter is explained instead of half-registered', async () => {
  const f = await fixture({ settings: { latex_starter: false, latex_sync_folder: false } })
  const failure = await f.call({ action: 'latex_ws_create', name: 'empty-one' }).then(() => null, error => error)
  assert.equal(failure.code, 'LATEX_WORKSPACE_NO_SOURCE')
  assert.match(failure.message, /还没有 \.tex 文件/)
  assert.equal((await stat(join(f.root, 'empty-one'))).isDirectory(), true, 'the folder stays so sources can be dropped in')
  assert.deepEqual((await dispatch({ action: 'latex_project_list', limit: 5 }, { library: f.library, python })).projects, [])
  assert.equal(JSON.parse(await readFile(f.syncPath, 'utf8')).sources.length, 2, 'nothing is added for a folder that is not a project')

  // Once the reader drops a source in, the same name registers.
  await writeFile(join(f.root, 'empty-one', 'paper.tex'), '\\documentclass{article}\\begin{document}x\\end{document}\n', 'utf8')
  const created = await f.call({ action: 'latex_ws_create', name: 'empty-one' })
  assert.equal(created.project.main_path, 'paper.tex')
  assert.equal(created.starter_written, false)
})

test('the sync action only ever adds, and never duplicates a covered folder', async () => {
  const f = await fixture()
  await mkdir(f.root, { recursive: true })
  const attached = await f.call({ action: 'latex_ws_sync_attach' })
  assert.equal(attached.changed, true)
  assert.equal(attached.source_count, 3)
  assert.ok(attached.backup.startsWith(f.syncPath))
  const before = await readFile(f.syncPath, 'utf8')
  const second = await f.call({ action: 'latex_ws_sync_attach' })
  assert.equal(second.changed, false)
  assert.equal(second.covered, true)
  assert.equal(await readFile(f.syncPath, 'utf8'), before, 'a covered folder must leave the file byte-identical')

  // A source nested under the root (a subfolder of the vault) counts as covered too.
  const nested = join(f.root, 'inside')
  const covering = await f.call({ action: 'latex_ws_sync_attach', root: nested })
  assert.equal(covering.changed, false)
  assert.equal(covering.covering_source, 'paper-library-latex')
})

test('an unusable sync config is reported and left untouched', async () => {
  const broken = await fixture()
  await writeFile(broken.syncPath, '{ not json', 'utf8')
  const before = await readFile(broken.syncPath, 'utf8')
  const status = await broken.call({ action: 'latex_ws_status' })
  assert.equal(status.sync.configured, false)
  assert.match(status.sync.reason, /JSON|解析|Unexpected/)
  const failure = await broken.call({ action: 'latex_ws_sync_attach' }).then(() => null, error => error)
  assert.match(failure.message, /JSON|解析|Unexpected/)
  assert.equal(await readFile(broken.syncPath, 'utf8'), before)

  const missing = await fixture({ sync: false })
  const absent = await missing.call({ action: 'latex_ws_sync_attach' })
  assert.equal(absent.changed, false)
  assert.match(absent.reason, /尚未初始化/)

  const colliding = await fixture()
  const config = JSON.parse(await readFile(colliding.syncPath, 'utf8'))
  config.sources.push({ id: 'paper-library-latex', kind: 'directory', root: join(colliding.base, 'other'), remote: 'paper-library-latex', include: [], exclude: [] })
  await writeFile(colliding.syncPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
  const renamed = await colliding.call({ action: 'latex_ws_sync_attach' })
  assert.equal(renamed.changed, true)
  assert.equal(renamed.entry.id, 'paper-library-latex-2')
  assert.equal(renamed.entry.remote, 'paper-library-latex-2')
  const written = JSON.parse(await readFile(colliding.syncPath, 'utf8'))
  assert.equal(written.sources.find(source => source.id === 'paper-library-latex').root, join(colliding.base, 'other'), 'the existing source is untouched')
})

test('names are cleaned, and unusable ones are refused', async () => {
  assert.equal(projectSlug('  My Paper: v2 / final  '), 'My-Paper-v2-final')
  assert.equal(projectSlug('城市 感知'), '城市-感知')
  assert.equal(projectSlug('../../etc/passwd'), 'etc-passwd')
  for (const name of ['', '   ', '..', '///', 42, null]) assert.throws(() => projectSlug(name), /项目名称/)
  const f = await fixture({ settings: { latex_sync_folder: false } })
  const failure = await f.call({ action: 'latex_ws_create', name: '..' }).then(() => null, error => error)
  assert.match(failure.message, /项目名称/)
  assert.equal(existsSync(join(f.root, '..', '..')), true, 'a refused name must not escape the root')
  assert.deepEqual(existsSync(f.root) ? (await readdir(f.root)) : [], [], 'a refused name creates no folder')
})

test('the sync entry matches what the sync service validates', async () => {
  const entry = syncSourceEntry('/Users/example/manuscripts/')
  assert.deepEqual(entry, {
    id: 'paper-library-latex',
    kind: 'directory',
    root: '/Users/example/manuscripts',
    remote: 'paper-library-latex',
    include: [],
    exclude: ['**/*.aux', '**/*.fls', '**/*.fdb_latexmk', '**/*.synctex.gz', '**/*.out', '**/*.blg', '**/.DS_Store', '**/.latex-build/**'],
    required: false,
  })
  assert.deepEqual(coveringSource([{ id: 'vault', root: '/Users/example' }], '/Users/example/manuscripts'), { id: 'vault', root: '/Users/example' })
  assert.equal(coveringSource([{ id: 'other', root: '/Users/other' }], '/Users/example/manuscripts'), null)
  assert.equal(coveringSource([{ id: 'same', root: '/Users/example/manuscripts' }], '/Users/example/manuscripts/').id, 'same')
  assert.equal(coveringSource([{ id: 'tilde', root: '~/manuscripts' }], join(process.env.HOME || '/Users/example', 'manuscripts')).id, 'tilde')
})
